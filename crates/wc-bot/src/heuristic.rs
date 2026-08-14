//! The heuristic bot: no search, one pass over the legal actions.
//!
//! Three jobs: a playable opponent that needs no server budget, the rollout
//! policy for the search, and a baseline the arena can measure against.
//!
//! **Where the rules of thumb come from.** The decision order and the four
//! priority lists are lifted from the fan-made solo flowchart (Seth McBride, BGG
//! user Dreadpirate404, «War Chest Solo Flowchart v2.5»). Only those parts are
//! used: the rest of that document describes a different game. Nothing here is
//! tied to a unit list — what a unit can do is read from the catalog and from
//! the actions the engine offers, so all 28 units are covered.
//!
//! **It allocates nothing per call.** Every buffer, including the distance
//! sweeps the priority lists are made of, lives on the bot and is reused. A
//! rollout calls this a dozen times per search iteration.

use crate::board_sense::{
    centre_of, keep_if, keep_largest, keep_smallest, Sense, Steps, Sweeper,
};
use crate::position::Position;
use crate::unit_worth::{measured, MEASURED_VALUE, MEASURED_VALUE_ALL, MEASURED_VALUE_ALL_660};
use wc_core::board::{HexIdx, DIST, NONE};
use wc_core::state::move_key;
use wc_core::types::*;
use wc_core::units::*;

// ---------------------------------------------------------------------------
// Knobs
// ---------------------------------------------------------------------------

#[derive(Copy, Clone, PartialEq, Eq, Debug)]
pub enum DraftBy {
    /// Take the unit the box prints most of.
    Coins,
    /// Take the unit the box prints fewest of.
    Scarcity,
    Random,
    /// By measured win rate in the base game.
    Measured,
    /// By measured win rate with every box on the table.
    MeasuredAll,
    /// The 660-game table the one above replaced, for checking by reversal.
    MeasuredAll660,
}

#[derive(Copy, Clone, Debug)]
pub struct HeuristicWeights {
    /// The chart's order: hit something first, take a location only if it wins.
    pub attack_before_control: bool,
    /// Prefer an attack that destroys a stack over the chart's target order.
    pub prefer_kills: bool,
    /// Decide the kind of move and then pick at random among moves of that kind,
    /// skipping the priority lists. Several times cheaper, because the lists are
    /// what the distance sweeps are for.
    pub quick: bool,
    pub draft_by: DraftBy,
    /// Rank a tactic by what it will do, rather than by the fields the action
    /// happens to carry.
    pub rank_tactics: bool,
    /// Draw at random over the *moves* rather than over the legal list.
    pub uniform_moves: bool,
}

impl Default for HeuristicWeights {
    fn default() -> HeuristicWeights {
        HeuristicWeights {
            attack_before_control: true,
            prefer_kills: false,
            quick: false,
            // The largest single gain this project has measured: 110 games,
            // 69.1%, +140 Elo for drafting by measured strength at all, and +53
            // more for the table that covers the expansions. Going back to the
            // coin count costs 198 Elo, and drafting at random costs 191 — those
            // two being equal is the point: the coin count says nothing about
            // strength, so the old rule was choosing at random with extra steps.
            draft_by: DraftBy::MeasuredAll,
            rank_tactics: true,
            uniform_moves: true,
        }
    }
}

/// What kind of thing an action is; lower goes first. The middle of the list is
/// the chart's maneuver tree. The ends are actions a solo AI never sees at all —
/// initiative, decrees, poison counters — placed by the same reasoning: things
/// that win or damage first, things that build second, things that pass last.
mod rank {
    pub const WINNING_CONTROL: f32 = 0.0;
    pub const ATTACK: f32 = 1.0;
    pub const BOLSTER_FOR_KNIGHT: f32 = 1.5;
    pub const CONTROL: f32 = 2.0;
    pub const DEPLOY: f32 = 3.0;
    pub const MOVE: f32 = 4.0;
    pub const PROCLAIM: f32 = 5.0;
    pub const CLEANUP: f32 = 6.0;
    pub const RECRUIT: f32 = 7.0;
    pub const INITIATIVE: f32 = 8.0;
    pub const BOLSTER: f32 = 9.0;
    pub const DRAFT: f32 = 10.0;
    pub const PASS: f32 = 11.0;
}

// ---------------------------------------------------------------------------
// Distance fields
// ---------------------------------------------------------------------------

/// Steps to the nearest hex of a named set, for every hex on the board.
/// Computed once per decision and per set: a priority list asks it of every
/// candidate.
#[derive(Copy, Clone, PartialEq, Eq)]
enum FieldKey {
    Centre,
    Contested,
    EnemyLocations,
    EnemyOccupied,
    NeutralLocations,
    EnemyUnits,
    /// Towards one chosen hex.
    To(HexIdx),
    /// Out from one unit's own hex.
    From(HexIdx),
}

#[derive(Default)]
struct FieldCache {
    keys: Vec<FieldKey>,
    fields: Vec<Steps>,
}

impl FieldCache {
    fn clear(&mut self) {
        self.keys.clear();
        // The `Steps` arrays are kept: a decision needs a handful of them and
        // they are 94 bytes each.
    }

    /// The slot holding this field, computing the sweep if it is not there yet.
    fn ensure(
        &mut self,
        key: FieldKey,
        sweeper: &mut Sweeper,
        size: wc_core::board::BoardSize,
        units: &Board,
        sources: &[HexIdx],
    ) -> usize {
        if let Some(i) = self.keys.iter().position(|k| *k == key) {
            return i;
        }
        let i = self.keys.len();
        self.keys.push(key);
        if self.fields.len() <= i {
            self.fields.push(Steps::empty());
        }
        let mut steps = std::mem::replace(&mut self.fields[i], Steps::empty());
        sweeper.sweep(size, units, sources, &mut steps);
        self.fields[i] = steps;
        i
    }
}

// ---------------------------------------------------------------------------
// The bot
// ---------------------------------------------------------------------------

pub struct Heuristic {
    pub weights: HeuristicWeights,
    sense: Sense,
    sweeper: Sweeper,
    fields: FieldCache,
    ranks: Vec<f32>,
    left: Vec<u32>,
    kept: Vec<u32>,
    values: Vec<f32>,
    sources: Vec<HexIdx>,
    /// `chooseTarget` memoised per origin, as the TypeScript `targets` map is.
    targets: Vec<(HexIdx, HexIdx)>,
    seen_keys: Vec<u64>,
}

impl Default for Heuristic {
    fn default() -> Heuristic {
        Heuristic::new(HeuristicWeights::default())
    }
}

impl Heuristic {
    pub fn new(weights: HeuristicWeights) -> Heuristic {
        Heuristic {
            weights,
            sense: Sense::default(),
            sweeper: Sweeper::new(),
            fields: FieldCache::default(),
            ranks: Vec::with_capacity(128),
            left: Vec::with_capacity(128),
            kept: Vec::with_capacity(128),
            values: Vec::with_capacity(128),
            sources: Vec::with_capacity(16),
            targets: Vec::with_capacity(8),
            seen_keys: Vec::with_capacity(128),
        }
    }

    /// One of `legal`, chosen. `hand` is the acting player's, used only to tell
    /// two coins of the same unit apart; pass `None` when it is hidden.
    pub fn choose<P: Position>(
        &mut self,
        pos: &P,
        you: Seat,
        phase: Phase,
        legal: &[Action],
        hand: Option<&[CoinId]>,
        rng: &mut wc_core::Rng,
    ) -> Action {
        debug_assert!(!legal.is_empty(), "the heuristic was asked to choose from nothing");
        if legal.len() == 1 {
            return legal[0];
        }
        if matches!(phase, Phase::Draft | Phase::Ban) {
            return self.draft_pick(legal, rng);
        }

        let me = pos.team_of(you);
        self.sense.fill(pos.size(), pos.units(), pos.control(), me);
        self.fields.clear();
        self.targets.clear();

        // Which drawer each action goes in, and then the best drawer only.
        self.ranks.clear();
        let mut best = f32::INFINITY;
        for action in legal {
            let r = self.rank_of(pos, you, *action);
            if r < best {
                best = r;
            }
            self.ranks.push(r);
        }
        self.left.clear();
        for (i, r) in self.ranks.iter().enumerate() {
            if *r == best {
                self.left.push(i as u32);
            }
        }

        self.refine(pos, you, legal, best);

        // The pool with duplicate moves taken out, so the draw that follows is
        // uniform over what the player can do rather than over what the engine
        // listed.
        if self.weights.uniform_moves && self.left.len() > 1 {
            self.seen_keys.clear();
            self.kept.clear();
            for i in &self.left {
                let key = move_key(legal[*i as usize], hand, Some(pos.pending()));
                if self.seen_keys.contains(&key) {
                    continue;
                }
                self.seen_keys.push(key);
                self.kept.push(*i);
            }
            std::mem::swap(&mut self.left, &mut self.kept);
        }

        legal[self.left[rng.next_int(self.left.len())] as usize]
    }

    /// Which drawer the heuristic would put each action in, lowest first.
    ///
    /// The heuristic's own choice throws this away — it keeps the best drawer
    /// and forgets the rest. Exposed because a prior that ranks 30 of 40 moves
    /// equally cannot concentrate anything, and that is worth measuring before
    /// it is believed.
    pub fn rank_actions<P: Position>(
        &mut self,
        pos: &P,
        you: Seat,
        legal: &[Action],
        out: &mut Vec<f32>,
    ) {
        let me = pos.team_of(you);
        self.sense.fill(pos.size(), pos.units(), pos.control(), me);
        self.fields.clear();
        out.clear();
        for action in legal {
            out.push(self.rank_of(pos, you, *action));
        }
    }

    // -- which drawer -------------------------------------------------------

    fn rank_of<P: Position>(&mut self, pos: &P, you: Seat, action: Action) -> f32 {
        use ActionKind::*;
        match action.kind {
            Control | FollowControl => {
                if control_wins(pos, you) {
                    rank::WINNING_CONTROL
                } else {
                    rank::CONTROL
                }
            }
            Deploy => rank::DEPLOY,
            // "The AI will never bolster its own unit", with the Knight exception.
            Bolster | FollowBolster => {
                if self.bolster_opens_a_knight(pos, action.from) {
                    rank::BOLSTER_FOR_KNIGHT
                } else {
                    rank::BOLSTER
                }
            }
            Recruit | FollowRecruit => rank::RECRUIT,
            ClaimInitiative => rank::INITIATIVE,
            Pass => rank::PASS,
            Skip => self.skip_rank(pos),
            Proclaim | FollowProclaim => rank::PROCLAIM,
            // Housekeeping the solo chart has no equivalent for: lifting a
            // poison counter, handing a Decoy back, raising a fortification.
            Unpoison | ReturnDecoy | FollowBuildFort | FollowBurn | FollowDeceive
            | FollowReinforce | FollowSpy | FollowLift | FollowShove | FollowRepeat => {
                rank::CLEANUP
            }
            Draft | Ban => rank::DRAFT,
            _ => {
                // What the card does comes first; its shape is the fallback.
                if let Some(named) = self.tactic_rank(pos, you, action) {
                    return named;
                }
                if attack_target_of(action).is_some() {
                    return if self.weights.attack_before_control {
                        rank::ATTACK
                    } else {
                        rank::CONTROL + 0.5
                    };
                }
                if destination_of(action).is_some() {
                    return rank::MOVE;
                }
                rank::CLEANUP
            }
        }
    }

    /// A tactic ranked by what it will do, rather than by the fields it happens
    /// to carry.
    ///
    /// `rank_of` otherwise reads an action's shape: a `target` makes it an
    /// attack, a `to` makes it a maneuver, and anything else drops to `cleanup`
    /// — two drawers below a plain move. Six cards pick their target on a
    /// follow-up step and so carry neither field, and the Infiltrator fails the
    /// other way: its action carries a `to`, so it read as a plain move when
    /// what it does is walk onto a location the other side holds **and take it**.
    ///
    /// Measured before the fix: over 120 games with every box on the table those
    /// six were offered 1401 times and played **none** of them. Not seldom —
    /// never.
    ///
    /// The fractional ranks keep each of these in a drawer of its own, so
    /// `refine` falls through to the pool untouched: its priority lists read the
    /// target and destination fields, and those are exactly what these lack.
    fn tactic_rank<P: Position>(&self, pos: &P, you: Seat, action: Action) -> Option<f32> {
        if !self.weights.rank_tactics || action.kind != ActionKind::Tactic {
            return None;
        }
        let stack = pos.units().get(action.from)?;
        match stack.unit.spec().tactic? {
            // Move onto a location the other side holds and place a marker on
            // it. The marker is the win condition, so this belongs beside a
            // plain control and above it when it is the last one.
            Tactic::Infiltrate { .. } | Tactic::ControlThenProclaim => Some(if control_wins(pos, you) {
                rank::WINNING_CONTROL
            } else {
                rank::CONTROL - 0.25
            }),
            // Granting an attack sits just *below* swinging directly: it costs
            // the Marshal's coin to make somebody else swing, and if a plain
            // attack is on offer the chart should take it.
            Tactic::GrantManeuver { attack, .. } => Some(if attack {
                rank::ATTACK + 0.25
            } else {
                rank::MOVE - 0.25
            }),
            // The rest sit just *above* their plain equivalent, because each
            // does what the plain action does and something more. Placed below
            // at first, and measured: all four stayed at exactly zero, because
            // their plain equivalent is available almost always and wins the
            // drawer every time. A fix that leaves the thing unreachable is not
            // a fix.
            Tactic::ManeuverEachUnit => Some(rank::MOVE - 0.25),
            Tactic::RecruitThenManeuver => Some(rank::RECRUIT - 0.25),
            Tactic::BolsterAllyFromSupply => Some(rank::BOLSTER - 0.25),
            _ => None,
        }
    }

    /// Skipping is normally the last resort. The exception is the chart's
    /// Swordsman note: having attacked, it moves on *unless it already stands on
    /// a neutral or enemy location* — a hex worth holding is not worth walking
    /// off.
    fn skip_rank<P: Position>(&self, pos: &P) -> f32 {
        let hex = match pos.pending().last() {
            Some(PendingStep::OptionalMove { hex, .. }) => *hex,
            _ => return rank::PASS,
        };
        match pos.units().get(hex) {
            Some(owner) if owner.team == self.sense.me => {}
            _ => return rank::PASS,
        }
        let worth_holding =
            self.sense.neutral.contains(&hex) || self.sense.enemy.contains(&hex);
        if worth_holding {
            rank::WINNING_CONTROL
        } else {
            rank::PASS
        }
    }

    /// The chart's Knight note: an unbolstered unit that wants to attack a
    /// Knight bolsters instead. In the printed rules it has no choice — a Knight
    /// may only be attacked by a bolstered unit — so this is the one time the
    /// bot bolsters.
    fn bolster_opens_a_knight<P: Position>(&self, pos: &P, hex: HexIdx) -> bool {
        let stack = match pos.units().get(hex) {
            Some(s) if s.coins <= 1 && s.team == self.sense.me => s,
            _ => return false,
        };
        // It has to be a unit that can swing at all. An Archer beside a Knight
        // opens nothing by growing — it is printed «can only attack by using its
        // tactic», and that tactic reaches two hexes, not one. The same false
        // positive covered the Lancer and the Trebuchet, and rank 1.5 beat
        // claiming a location and deploying, which are things worth doing.
        if has_restriction(stack.unit, restrict::NO_NORMAL_ATTACK) {
            return false;
        }
        for other in &self.sense.enemy_units {
            if DIST[hex as usize][*other as usize] != 1 {
                continue;
            }
            if let Some(foe) = pos.units().get(*other) {
                if has_attribute(foe.unit, attr::ONLY_ATTACKED_BY_BOLSTERED) {
                    return true;
                }
            }
        }
        false
    }

    // -- choosing within a drawer -------------------------------------------

    fn refine<P: Position>(&mut self, pos: &P, you: Seat, legal: &[Action], rank: f32) {
        if self.left.len() <= 1 || self.weights.quick {
            return;
        }
        if rank == rank::ATTACK || rank == rank::CONTROL + 0.5 {
            self.choose_attack(pos, legal);
        } else if rank == rank::DEPLOY {
            self.choose_deploy(pos, legal);
        } else if rank == rank::MOVE {
            self.choose_move(pos, legal);
        } else if rank == rank::RECRUIT {
            self.choose_recruit(pos, you, legal);
        }
    }

    /// AI Attack, priorities as printed:
    ///   1. Adjacent unit  2. Unit on a friendly location  3. on an enemy location
    ///   4. on a neutral location  5. closest to the centre hex
    fn choose_attack<P: Position>(&mut self, pos: &P, legal: &[Action]) {
        let target = |i: u32| attack_target_of(legal[i as usize]).unwrap_or(NONE);

        // A knob, not the chart: finishing a stack off takes a unit out of the
        // game, and the printed list is blind to how much is left on the hex.
        if self.weights.prefer_kills {
            let units = pos.units();
            keep_if(
                &self.left,
                |i| units.get(target(i)).map(|s| s.coins == 1).unwrap_or(false),
                &mut self.kept,
            );
            if self.narrow() {
                return;
            }
        }

        keep_if(
            &self.left,
            |i| {
                let from = origin_of(legal[i as usize]);
                match from {
                    Some(f) => DIST[f as usize][target(i) as usize] == 1,
                    None => false,
                }
            },
            &mut self.kept,
        );
        if self.narrow() {
            return;
        }

        for group in [0usize, 1, 2] {
            let list: &[HexIdx] = match group {
                0 => &self.sense.friendly,
                1 => &self.sense.enemy,
                _ => &self.sense.neutral,
            };
            keep_if(&self.left, |i| list.contains(&target(i)), &mut self.kept);
            if self.narrow() {
                return;
            }
        }

        self.by_centre(pos, |i| attack_target_of(legal[i as usize]).unwrap_or(NONE));
    }

    /// AI Deployment, priorities as printed:
    ///   1. Closest to a neutral/enemy location  2. Closest to an enemy location
    ///   3. Closest to an enemy-occupied location  4. Closest to the centre hex
    fn choose_deploy<P: Position>(&mut self, pos: &P, legal: &[Action]) {
        let to = |i: u32| destination_of(legal[i as usize]).unwrap_or(NONE);

        self.sources.clear();
        self.sources.extend_from_slice(&self.sense.neutral);
        self.sources.extend_from_slice(&self.sense.enemy);
        if self.by_field(pos, FieldKey::Contested, to) {
            return;
        }
        self.sources.clear();
        self.sources.extend_from_slice(&self.sense.enemy);
        if self.by_field(pos, FieldKey::EnemyLocations, to) {
            return;
        }
        self.sources.clear();
        self.sources.extend_from_slice(&self.sense.enemy_occupied);
        if self.by_field(pos, FieldKey::EnemyOccupied, to) {
            return;
        }
        self.by_centre(pos, to);
    }

    /// AI Movement. The chart picks a target location per unit, then steps
    /// toward it:
    ///   Target:  1. Closest location  2. Enemy location  3. Enemy-occupied
    ///            4. Location closest to the centre hex
    ///   Step:    1. Hex closest to another enemy location  2. …to another
    ///            neutral location  3. …to an enemy unit  4. …to the centre hex
    fn choose_move<P: Position>(&mut self, pos: &P, legal: &[Action]) {
        let to = |i: u32| destination_of(legal[i as usize]).unwrap_or(NONE);

        // Each candidate against the location its own unit is heading for, so
        // the field differs per candidate and the values are gathered first.
        self.values.clear();
        for k in 0..self.left.len() {
            let i = self.left[k];
            let origin = origin_of(legal[i as usize]);
            let value = match origin {
                None => 0.0,
                Some(o) => match self.choose_target(pos, o) {
                    None => 0.0,
                    Some(target) => {
                        self.sources.clear();
                        self.sources.push(target);
                        let slot = self.fields.ensure(
                            FieldKey::To(target),
                            &mut self.sweeper,
                            pos.size(),
                            pos.units(),
                            &self.sources,
                        );
                        self.fields.fields[slot].to(to(i))
                    }
                },
            };
            self.values.push(value);
        }
        crate::board_sense::keep_smallest_values(&self.left, &self.values, &mut self.kept);
        if self.narrow() {
            return;
        }

        self.sources.clear();
        self.sources.extend_from_slice(&self.sense.enemy);
        if self.by_field(pos, FieldKey::EnemyLocations, to) {
            return;
        }
        self.sources.clear();
        self.sources.extend_from_slice(&self.sense.neutral);
        if self.by_field(pos, FieldKey::NeutralLocations, to) {
            return;
        }
        self.sources.clear();
        self.sources.extend_from_slice(&self.sense.enemy_units);
        if self.by_field(pos, FieldKey::EnemyUnits, to) {
            return;
        }
        self.by_centre(pos, to);
    }

    /// Which location one unit is heading for.
    fn choose_target<P: Position>(&mut self, pos: &P, origin: HexIdx) -> Option<HexIdx> {
        if let Some((_, target)) = self.targets.iter().find(|(o, _)| *o == origin) {
            return if *target == NONE { None } else { Some(*target) };
        }

        let mut candidates: Vec<HexIdx> = Vec::with_capacity(14);
        candidates.extend_from_slice(&self.sense.enemy);
        candidates.extend_from_slice(&self.sense.neutral);
        let answer = if candidates.is_empty() {
            None
        } else if candidates.len() == 1 {
            Some(candidates[0])
        } else {
            self.sources.clear();
            self.sources.push(origin);
            let slot = self.fields.ensure(
                FieldKey::From(origin),
                &mut self.sweeper,
                pos.size(),
                pos.units(),
                &self.sources,
            );
            let mut left: Vec<HexIdx> = candidates.clone();
            let mut kept: Vec<HexIdx> = Vec::with_capacity(14);

            {
                let reach = &self.fields.fields[slot];
                let mut best = f32::INFINITY;
                for hex in &left {
                    let d = reach.to(*hex);
                    if d < best {
                        best = d;
                    }
                }
                if best.is_finite() {
                    kept.clear();
                    for hex in &left {
                        if reach.to(*hex) == best {
                            kept.push(*hex);
                        }
                    }
                    if !kept.is_empty() {
                        std::mem::swap(&mut left, &mut kept);
                    }
                }
            }
            if left.len() > 1 {
                kept.clear();
                for hex in &left {
                    if self.sense.enemy.contains(hex) {
                        kept.push(*hex);
                    }
                }
                if !kept.is_empty() {
                    std::mem::swap(&mut left, &mut kept);
                }
            }
            if left.len() > 1 {
                kept.clear();
                for hex in &left {
                    if self.sense.enemy_occupied.contains(hex) {
                        kept.push(*hex);
                    }
                }
                if !kept.is_empty() {
                    std::mem::swap(&mut left, &mut kept);
                }
            }
            if left.len() > 1 {
                self.sources.clear();
                self.sources.push(self.sense.centre);
                let centre = self.fields.ensure(
                    FieldKey::Centre,
                    &mut self.sweeper,
                    pos.size(),
                    pos.units(),
                    &self.sources,
                );
                let field = &self.fields.fields[centre];
                let mut best = f32::INFINITY;
                for hex in &left {
                    let d = field.to(*hex);
                    if d < best {
                        best = d;
                    }
                }
                if best.is_finite() {
                    kept.clear();
                    for hex in &left {
                        if field.to(*hex) == best {
                            kept.push(*hex);
                        }
                    }
                    if !kept.is_empty() {
                        std::mem::swap(&mut left, &mut kept);
                    }
                }
            }
            left.first().copied()
        };

        self.targets.push((origin, answer.unwrap_or(NONE)));
        answer
    }

    /// AI Recruitment, priorities as printed:
    ///   1. The unit with the most coins left in the supply
    ///   2. The unit with the most coins removed from play
    ///   3. The unit that was most recently maneuvered
    fn choose_recruit<P: Position>(&mut self, pos: &P, you: Seat, legal: &[Action]) {
        let unit_of = |i: u32| legal[i as usize].unit();
        let supply = pos.supply(you);
        keep_largest(
            &self.left,
            |i| unit_of(i).map(|u| supply[u as usize] as f32).unwrap_or(0.0),
            &mut self.kept,
        );
        if self.narrow() {
            return;
        }
        let removed = pos.removed(you);
        keep_largest(
            &self.left,
            |i| unit_of(i).map(|u| removed[u as usize] as f32).unwrap_or(0.0),
            &mut self.kept,
        );
        if self.narrow() {
            return;
        }
        // A maneuver is one of three things: move, control, attack. A deploy, a
        // bolster or a recruit is not one, and `poison` logs the name of the
        // *victim* under the poisoner's seat — reading any entry with a unit in
        // it gave a different answer in 21% of the decisions it settled.
        keep_largest(
            &self.left,
            |i| unit_of(i).map(|u| pos.recency(you, u) as f32 - 1.0).unwrap_or(-1.0),
            &mut self.kept,
        );
        self.narrow();
    }

    // -- cascade plumbing ---------------------------------------------------

    /// One line of a priority list: keep what it kept, and say whether the list
    /// is settled. A criterion nothing satisfies is skipped, since the chart
    /// says to carry on "using only those that applied" and none did.
    fn narrow(&mut self) -> bool {
        if self.kept.is_empty() {
            return false;
        }
        std::mem::swap(&mut self.left, &mut self.kept);
        self.left.len() == 1
    }

    /// "Closest to …", for a field over a set of hexes already in `self.sources`.
    fn by_field<P: Position>(
        &mut self,
        pos: &P,
        key: FieldKey,
        hex_of: impl Fn(u32) -> HexIdx,
    ) -> bool {
        let slot =
            self.fields.ensure(key, &mut self.sweeper, pos.size(), pos.units(), &self.sources);
        {
            let field = &self.fields.fields[slot];
            keep_smallest(&self.left, |i| field.to(hex_of(i)), &mut self.kept);
        }
        self.narrow()
    }

    /// The chart's last tie-breaker.
    fn by_centre<P: Position>(&mut self, pos: &P, hex_of: impl Fn(u32) -> HexIdx) -> bool {
        self.sources.clear();
        self.sources.push(centre_of(pos.size()));
        self.by_field(pos, FieldKey::Centre, hex_of)
    }

    // -- the draft ----------------------------------------------------------

    /// Drafting is not in the chart — its AI is dealt a fixed list of seven —
    /// and the app deals a draft unless it is told otherwise, so this is the
    /// size of the opening.
    fn draft_pick(&mut self, legal: &[Action], rng: &mut wc_core::Rng) -> Action {
        if self.weights.draft_by == DraftBy::Random {
            return legal[rng.next_int(legal.len())];
        }
        self.left.clear();
        for i in 0..legal.len() {
            self.left.push(i as u32);
        }
        let value = |i: u32| -> f32 {
            let unit = match legal[i as usize].unit() {
                Some(u) => u,
                None => return match self.weights.draft_by {
                    DraftBy::Coins | DraftBy::Scarcity => 0.0,
                    _ => 0.0,
                },
            };
            match self.weights.draft_by {
                DraftBy::Coins => unit.spec().coins as f32,
                // The opposite bet: four-coin units are the short print run, and
                // the box gives the short print run to the units that do more.
                DraftBy::Scarcity => -(unit.spec().coins as f32),
                DraftBy::Measured => measured(&MEASURED_VALUE, unit) as f32,
                DraftBy::MeasuredAll => measured(&MEASURED_VALUE_ALL, unit) as f32,
                DraftBy::MeasuredAll660 => measured(&MEASURED_VALUE_ALL_660, unit) as f32,
                DraftBy::Random => 0.0,
            }
        };
        keep_largest(&self.left, value, &mut self.kept);
        if !self.kept.is_empty() {
            std::mem::swap(&mut self.left, &mut self.kept);
        }
        legal[self.left[rng.next_int(self.left.len())] as usize]
    }
}

/// Placing the last control marker ends the game there and then.
fn control_wins<P: Position>(pos: &P, you: Seat) -> bool {
    pos.markers_remaining(pos.team_of(you)) <= 1
}

fn attack_target_of(action: Action) -> Option<HexIdx> {
    match action.kind {
        ActionKind::Attack | ActionKind::FollowAttack => Some(action.to),
        ActionKind::Tactic if action.target != NONE => Some(action.target),
        _ => None,
    }
}

fn destination_of(action: Action) -> Option<HexIdx> {
    match action.kind {
        ActionKind::Move
        | ActionKind::FollowMove
        | ActionKind::Deploy
        | ActionKind::FollowPlace => {
            if action.to == NONE {
                None
            } else {
                Some(action.to)
            }
        }
        ActionKind::Tactic if action.target == NONE && action.to != NONE => Some(action.to),
        _ => None,
    }
}

/// The hex an action starts from, for the actions that carry one.
///
/// Not every action with a hex in that slot: a bolster names a hex with `at` and
/// a build names one with `hex`, and neither is an origin. A deploy has no
/// origin at all, which is what makes it fall to the front of the movement list.
fn origin_of(action: Action) -> Option<HexIdx> {
    match action.kind {
        ActionKind::Move
        | ActionKind::Attack
        | ActionKind::Tactic
        | ActionKind::FollowMove
        | ActionKind::FollowAttack
        | ActionKind::FollowShove
        | ActionKind::FollowTactic => {
            if action.from == NONE {
                None
            } else {
                Some(action.from)
            }
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wc_core::board::{index_of_id, BoardSize};
    use wc_core::setup::{create_game, CreateGameOptions};
    use wc_core::types::{GameState, Poison, UnitStack};

    fn beside_a_knight(mine: UnitId) -> (GameState, Heuristic) {
        let mut opts = CreateGameOptions::new("heuristic", BoardSize::Duel, 1);
        opts.fixed_units = Some(vec![vec![mine], vec![UnitId::Knight]]);
        let mut state = create_game(&opts).expect("a game");
        state.units.clear();
        let hex = index_of_id("5,2");
        let team = state.players[0].team;
        state.units.insert(
            hex,
            UnitStack { unit: mine, team, seat: 0, coins: 1, poisoned_by: Poison::None },
        );
        let beside = wc_core::engine::adjacent(&state, hex)[0];
        let theirs = state.players[1].team;
        state.units.insert(
            beside,
            UnitStack {
                unit: UnitId::Knight,
                team: theirs,
                seat: 1,
                coins: 1,
                poisoned_by: Poison::None,
            },
        );
        let mut bot = Heuristic::default();
        bot.sense.fill(state.size, &state.units, &state.control, team);
        (state, bot)
    }

    /// The review's B-3. The chart bolsters in one case only: an unbolstered
    /// unit that wants to hit a Knight and may not. An Archer beside a Knight
    /// wants nothing of the kind — it is printed «can only attack by using its
    /// tactic», and the tactic reaches two hexes.
    #[test]
    fn bolstering_opens_a_knight_only_for_a_unit_that_could_swing() {
        let (state, bot) = beside_a_knight(UnitId::Swordsman);
        assert!(bot.bolster_opens_a_knight(&state, index_of_id("5,2")));

        for tactic_only in [UnitId::Archer, UnitId::Lancer, UnitId::Trebuchet] {
            let (state, bot) = beside_a_knight(tactic_only);
            assert!(
                !bot.bolster_opens_a_knight(&state, index_of_id("5,2")),
                "{:?} cannot make a normal attack, so growing opens nothing",
                tactic_only
            );
        }
    }
}
