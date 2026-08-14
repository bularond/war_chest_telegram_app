//! The War Chest rules engine: legal action generation and action application.
//!
//! A line-by-line port of `engine.ts`, with the string hexes replaced by indices
//! and the object literals by the packed shapes in `types.rs`. The structure is
//! deliberately the same, including the two big matches on the tactic kind, so
//! that a rule can be compared against its original by eye.

use crate::board::{board_for, ray_clear, HexIdx, DIR_BETWEEN, DIST, HEX_COUNT, NONE, STEPS};
use crate::decrees::DecreeId;
use crate::rng::Rng;
use crate::setup::{apply_ban, apply_draft_pick, ban_seat, draw_coins, start_round, HAND_SIZE};
use crate::types::*;
use crate::units::*;
use arrayvec::ArrayVec;

pub type EngineResult = Result<(), &'static str>;

/// Hexes a legal-move generator may collect at once — every board hex, which is
/// more than any of them can reach.
type HexList = ArrayVec<HexIdx, HEX_COUNT>;
/// Stacks one side can have on the board.
type StackList = ArrayVec<HexIdx, MAX_STACKS>;

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

#[inline]
pub fn is_on_board(state: &GameState, hex: HexIdx) -> bool {
    hex != NONE && board_for(state.size).on_board[hex as usize]
}

#[inline]
pub fn is_location(state: &GameState, hex: HexIdx) -> bool {
    hex != NONE && board_for(state.size).is_location[hex as usize]
}

#[inline]
pub fn adjacent(state: &GameState, hex: HexIdx) -> &'static [HexIdx] {
    let board = board_for(state.size);
    &board.adjacent[hex as usize][..board.adjacent_len[hex as usize] as usize]
}

/// A Fortification on a location the enemy controls bars the way; a neutral or
/// friendly one may be entered but never moved *through* by a multi-space move.
pub fn can_enter(state: &GameState, team: Team, hex: HexIdx) -> bool {
    if !is_on_board(state, hex) || state.units.occupied(hex) {
        return false;
    }
    if state.forts[hex as usize] {
        if let Some(owner) = state.control_of(hex) {
            if owner != team {
                return false;
            }
        }
    }
    true
}

#[inline]
fn can_pass_through(state: &GameState, team: Team, hex: HexIdx) -> bool {
    can_enter(state, team, hex) && !state.forts[hex as usize]
}

fn empty_neighbors(state: &GameState, hex: HexIdx, out: &mut HexList) {
    out.clear();
    match state.units.get(hex) {
        Some(stack) => {
            let team = stack.team;
            for n in adjacent(state, hex) {
                if can_enter(state, team, *n) {
                    out.push(*n);
                }
            }
        }
        None => {
            for n in adjacent(state, hex) {
                if !state.units.occupied(*n) {
                    out.push(*n);
                }
            }
        }
    }
}

fn has_empty_neighbor(state: &GameState, hex: HexIdx) -> bool {
    match state.units.get(hex) {
        Some(stack) => adjacent(state, hex).iter().any(|n| can_enter(state, stack.team, *n)),
        None => adjacent(state, hex).iter().any(|n| !state.units.occupied(*n)),
    }
}

/// Where a poisoner's counter currently sits, if it is on the board at all.
pub fn poisoned_hex(state: &GameState, poisoner: Poison) -> Option<HexIdx> {
    state.units.iter().find(|(_, s)| s.poisoned_by == poisoner).map(|(h, _)| h)
}

/// A poisoned unit may not be moved, bolstered or activated with its *own*
/// coins. Anything granted by another unit or a decree still works.
#[inline]
fn is_poisoned(state: &GameState, hex: HexIdx) -> bool {
    state.units.get(hex).map(|s| s.poisoned_by.is_some()).unwrap_or(false)
}

/// Whether a Decoy Coin is still beside its card and ready to be planted.
pub fn decoy_available(state: &GameState, decoy: CoinId) -> bool {
    for p in &state.players {
        if p.hand.contains(&decoy) || p.bag.contains(&decoy) {
            return false;
        }
        if p.discard.iter().any(|d| d.coin == decoy) {
            return false;
        }
    }
    true
}

/// A Fortification is attackable while it is neutral or the enemy's.
pub fn can_attack_fort(state: &GameState, team: Team, hex: HexIdx) -> bool {
    state.forts[hex as usize] && state.control_of(hex) != Some(team)
}

fn deployed_units(state: &GameState, seat: Seat, unit: UnitId) -> StackList {
    let mut out = StackList::new();
    for (hex, s) in state.units.iter() {
        if s.seat == seat && s.unit == unit {
            out.push(hex);
        }
    }
    out
}

fn deployed_count(state: &GameState, seat: Seat, unit: UnitId) -> usize {
    state.units.iter().filter(|(_, s)| s.seat == seat && s.unit == unit).count()
}

/// Hexes holding a unit this seat owns (not a teammate's).
fn own_units(state: &GameState, seat: Seat) -> StackList {
    let mut out = StackList::new();
    for (hex, s) in state.units.iter() {
        if s.seat == seat {
            out.push(hex);
        }
    }
    out
}

fn friendly_units(state: &GameState, team: Team) -> StackList {
    let mut out = StackList::new();
    for (hex, s) in state.units.iter() {
        if s.team == team {
            out.push(hex);
        }
    }
    out
}

/// Whether `attacker` may make an attack against `target` at all. Range and line
/// of sight are the caller's business; this covers the Knight and the Bishop.
pub fn can_attack_target(state: &GameState, attacker_hex: HexIdx, target_hex: HexIdx) -> bool {
    let attacker = match state.units.get(attacker_hex) {
        Some(a) => a,
        None => return false,
    };
    // A Fortification takes the blow first, whoever is standing behind it.
    if state.forts[target_hex as usize] {
        return can_attack_fort(state, attacker.team, target_hex);
    }
    let target = match state.units.get(target_hex) {
        Some(t) => t,
        None => return false,
    };
    if target.team == attacker.team {
        return false;
    }
    if has_attribute(target.unit, attr::ONLY_ATTACKED_BY_BOLSTERED) && attacker.coins < 2 {
        return false;
    }
    // The Bishop is the Knight inverted: heavy stacks cannot touch it.
    if has_restriction(target.unit, restrict::ONLY_ATTACKED_BY_UNBOLSTERED) && attacker.coins >= 2 {
        return false;
    }
    true
}

fn can_attack_anything_adjacent(state: &GameState, hex: HexIdx) -> bool {
    adjacent(state, hex).iter().any(|t| can_attack_target(state, hex, *t))
}

// ---------------------------------------------------------------------------
// Royal Decrees (Nobility)
// ---------------------------------------------------------------------------

/// Units of this team that could attack something right now.
fn attackers_for(state: &GameState, team: Team, on_own_location: bool) -> StackList {
    let mut out = StackList::new();
    for hex in friendly_units(state, team) {
        if on_own_location && state.control_of(hex) != Some(team) {
            continue;
        }
        let unit = state.units.get(hex).unwrap().unit;
        if has_restriction(unit, restrict::NO_NORMAL_ATTACK) {
            continue;
        }
        if can_attack_anything_adjacent(state, hex) {
            out.push(hex);
        }
    }
    out
}

/// Empty locations a team controls, optionally ignoring one hex being vacated.
fn open_controlled_locations(
    state: &GameState,
    team: Team,
    vacating: Option<HexIdx>,
) -> ArrayVec<HexIdx, 14> {
    let mut out = ArrayVec::new();
    for loc in &board_for(state.size).locations {
        if state.control_of(*loc) == Some(team)
            && (!state.units.occupied(*loc) || Some(*loc) == vacating)
        {
            out.push(*loc);
        }
    }
    out
}

/// A Decree may only be chosen if its ability can be carried out in full, so
/// every one of them gets a feasibility check before it is offered.
pub fn can_execute_decree(state: &GameState, seat: Seat, decree: DecreeId) -> bool {
    let me = state.player(seat);
    match decree {
        DecreeId::Sacrifice => !attackers_for(state, me.team, false).is_empty(),
        DecreeId::Guard => !attackers_for(state, me.team, true).is_empty(),
        DecreeId::March => friendly_units(state, me.team)
            .into_iter()
            .any(|hex| state.units.get(hex).unwrap().coins >= 2 && has_empty_neighbor(state, hex)),
        DecreeId::Enlist => me.supply_total() >= 2,
        DecreeId::Redeploy => own_units(state, seat)
            .into_iter()
            .any(|hex| !open_controlled_locations(state, me.team, Some(hex)).is_empty()),
        DecreeId::Spy => state.players.iter().any(|p| p.team != me.team && !p.hand.is_empty()),
        DecreeId::Reinforce => me.removed_total() > 0,
    }
}

/// Seals belong to the side, not to the seat: a team's pool is the sum over its
/// seats, and setup hands the three to one of them.
pub fn seals_left(state: &GameState, team: Team) -> u32 {
    state.players.iter().filter(|p| p.team == team).map(|p| p.seals as u32).sum()
}

fn spend_seal(state: &mut GameState, team: Team) -> EngineResult {
    match state.players.iter_mut().find(|p| p.team == team && p.seals > 0) {
        Some(holder) => {
            holder.seals -= 1;
            Ok(())
        }
        None => Err("no seals left"),
    }
}

/// Whether this seat may still put a Seal on that Decree.
pub fn can_proclaim(state: &GameState, seat: Seat, decree: DecreeId) -> bool {
    let me = state.player(seat);
    let card = match state.decrees.iter().find(|d| d.id == decree) {
        Some(c) => c,
        None => return false,
    };
    if seals_left(state, me.team) == 0 {
        return false;
    }
    if card.has_seal(me.team) {
        return false;
    }
    can_execute_decree(state, seat, decree)
}

/// Queues the steps a Decree needs the player to resolve.
fn start_decree(state: &mut GameState, seat: Seat, decree: DecreeId) {
    let team = state.player(seat).team;
    log_decree(state, seat, LogKind::Proclaim, decree);
    match decree {
        DecreeId::Sacrifice => state
            .pending
            .push(PendingStep::DecreeAttack { costs_coin: true, from_own_location: false }),
        DecreeId::Guard => state
            .pending
            .push(PendingStep::DecreeAttack { costs_coin: false, from_own_location: true }),
        DecreeId::March => {
            state.pending.push(PendingStep::DecreeMove { require_bolstered: true })
        }
        DecreeId::Enlist => {
            state.pending.push(PendingStep::DecreeRecruit { source: StepSource::Enlist });
            state.pending.push(PendingStep::DecreeRecruit { source: StepSource::Enlist });
        }
        DecreeId::Redeploy => state.pending.push(PendingStep::DecreeLift),
        DecreeId::Spy => {
            if let Some(target) =
                state.players.iter().find(|p| p.team != team && !p.hand.is_empty()).map(|p| p.seat)
            {
                state.pending.push(PendingStep::DecreeSpy { target });
            }
        }
        DecreeId::Reinforce => state.pending.push(PendingStep::DecreeReinforce),
    }
    // The Herald follows a proclamation with a maneuver of its own.
    for hex in deployed_units(state, seat, UnitId::Herald) {
        if has_maneuver_follow_ups(state, hex) {
            state.pending.push(PendingStep::ManeuverUnit {
                hex,
                source: StepSource::Herald,
                optional: true,
            });
        }
    }
}

/// Where a unit of this type could be deployed by this seat right now.
pub fn deploy_targets(state: &GameState, seat: Seat, unit: UnitId) -> HexList {
    let mut out = HexList::new();
    if deployed_count(state, seat, unit) >= max_deployed(unit) as usize {
        return out;
    }
    let me = state.player(seat);
    let board = board_for(state.size);
    let mut seen = [false; HEX_COUNT];
    for loc in &board.locations {
        if state.control_of(*loc) == Some(me.team) && !state.units.occupied(*loc) {
            out.push(*loc);
            seen[*loc as usize] = true;
        }
    }

    if !has_attribute(unit, attr::DEPLOY_NEXT_TO_FRIENDLY) {
        return out;
    }

    let mut empties = HexList::new();
    for hex in friendly_units(state, me.team) {
        empty_neighbors(state, hex, &mut empties);
        for n in &empties {
            if !seen[*n as usize] {
                seen[*n as usize] = true;
                out.push(*n);
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Legal actions
// ---------------------------------------------------------------------------

/// Free maneuvers a unit can make: move, attack or control. Never a tactic.
fn maneuver_follow_ups(state: &GameState, hex: HexIdx, out: &mut Vec<Action>) {
    let stack = match state.units.get(hex) {
        Some(s) => *s,
        None => return,
    };
    let mut empties = HexList::new();
    empty_neighbors(state, hex, &mut empties);
    for to in &empties {
        out.push(Action::bare(ActionKind::FollowMove).with_from(hex).with_to(*to));
    }
    if !has_restriction(stack.unit, restrict::NO_NORMAL_ATTACK) {
        for to in adjacent(state, hex) {
            if can_attack_target(state, hex, *to) {
                out.push(Action::bare(ActionKind::FollowAttack).with_from(hex).with_to(*to));
            }
        }
    }
    if can_control_here(state, hex) {
        out.push(Action::bare(ActionKind::FollowControl).with_from(hex));
    }
}

fn has_maneuver_follow_ups(state: &GameState, hex: HexIdx) -> bool {
    let stack = match state.units.get(hex) {
        Some(s) => *s,
        None => return false,
    };
    if has_empty_neighbor(state, hex) {
        return true;
    }
    if !has_restriction(stack.unit, restrict::NO_NORMAL_ATTACK)
        && can_attack_anything_adjacent(state, hex)
    {
        return true;
    }
    can_control_here(state, hex)
}

fn can_control_here(state: &GameState, hex: HexIdx) -> bool {
    let stack = match state.units.get(hex) {
        Some(s) => s,
        None => return false,
    };
    if !is_location(state, hex) {
        return false;
    }
    if state.control_of(hex) == Some(stack.team) {
        return false;
    }
    state.markers_remaining(stack.team) > 0
}

/// Hexes a unit can end on after moving exactly `steps` through empty hexes.
fn reachable(state: &GameState, from: HexIdx, steps: u8, out: &mut HexList) {
    out.clear();
    let team = state.units.get(from).map(|s| s.team).unwrap_or(0);
    let mut seen = [false; HEX_COUNT];
    seen[from as usize] = true;
    let mut frontier = HexList::new();
    frontier.push(from);
    let mut next = HexList::new();
    for i in 0..steps {
        let last = i == steps - 1;
        next.clear();
        for hex in &frontier {
            for n in adjacent(state, *hex) {
                if seen[*n as usize] {
                    continue;
                }
                // Only the final step may land on a Fortification.
                let ok = if last {
                    can_enter(state, team, *n)
                } else {
                    can_pass_through(state, team, *n)
                };
                if !ok {
                    continue;
                }
                seen[*n as usize] = true;
                next.push(*n);
            }
        }
        std::mem::swap(&mut frontier, &mut next);
    }
    out.extend(frontier.into_iter()); // exactly `steps` away
}

/// Whether a charge may finish on `target`.
///
/// This used to be a function of its own, and being a second copy of
/// `can_attack_target` is exactly what was wrong with it: it knew about the
/// Knight and not about the Bishop, and it required a unit — so a bolstered
/// Cavalry could charge a Bishop it may not touch, and nobody could charge an
/// empty Fortification. The charging stack is the attacker either way, and the
/// checks are the same checks.
#[inline]
fn can_charge(state: &GameState, from: HexIdx, target: HexIdx) -> bool {
    can_attack_target(state, from, target)
}

/// Destination/target pairs for a charge.
///
/// The Cavalry moves one space and may then hit anything adjacent. The Lancer's
/// card says "move one or two spaces and then attack, all in a straight line",
/// so its target is the next hex along the very direction it charged down.
fn charge_options(
    state: &GameState,
    from: HexIdx,
    min: u8,
    max: u8,
    straight_line: bool,
    mut emit: impl FnMut(HexIdx, HexIdx),
) {
    if state.units.get(from).is_none() {
        return;
    }

    if straight_line {
        let team = state.units.get(from).map(|s| s.team).unwrap_or(0);
        for dir in 0..6usize {
            for d in min..=max {
                let mut hex = from;
                let mut blocked = false;
                for step in 1..=d {
                    let n = STEPS[hex as usize][dir];
                    if n == NONE {
                        blocked = true;
                        break;
                    }
                    hex = n;
                    // The lane obeys the rules every other move obeys: a
                    // Fortification may be landed on but never passed through,
                    // and an enemy-held one may not be entered at all.
                    let ok = if step == d {
                        can_enter(state, team, n)
                    } else {
                        can_pass_through(state, team, n)
                    };
                    if !ok {
                        blocked = true;
                    }
                }
                if blocked {
                    continue;
                }
                let target = STEPS[hex as usize][dir];
                if !is_on_board(state, target) {
                    continue;
                }
                if !can_charge(state, from, target) {
                    continue;
                }
                emit(hex, target);
            }
        }
        return;
    }

    let mut landings = HexList::new();
    for d in min..=max {
        reachable(state, from, d, &mut landings);
        for to in &landings {
            for target in adjacent(state, *to) {
                if can_charge(state, from, *target) {
                    emit(*to, *target);
                }
            }
        }
    }
}

/// Empty locations this seat controls, within `distance` steps through empties.
fn royal_redeploy_targets(
    state: &GameState,
    seat: Seat,
    from: HexIdx,
    distance: u8,
    out: &mut HexList,
) {
    let team = state.player(seat).team;
    out.clear();
    let mut seen = [false; HEX_COUNT];
    let mut hexes = HexList::new();
    for d in 1..=distance {
        reachable(state, from, d, &mut hexes);
        for hex in &hexes {
            if is_location(state, *hex)
                && state.control_of(*hex) == Some(team)
                && !seen[*hex as usize]
            {
                seen[*hex as usize] = true;
                out.push(*hex);
            }
        }
    }
}

fn tactic_actions(
    state: &GameState,
    seat: Seat,
    coin_index: u8,
    unit: UnitId,
    out: &mut Vec<Action>,
) {
    let spec = match unit.spec().tactic {
        Some(s) => s,
        None => return,
    };
    let siege = unit.spec().siege_tactic;
    let start = out.len();
    let sources = deployed_units(state, seat, unit);

    let mut empties = HexList::new();
    let mut landings = HexList::new();

    for from in sources {
        if is_poisoned(state, from) {
            continue;
        }
        // A Siege Tactic may only be started while the unit is bolstered.
        if siege && state.units.get(from).map(|s| s.coins).unwrap_or(0) < 2 {
            continue;
        }
        let team = state.units.get(from).unwrap().team;
        let base = Action::coin(ActionKind::Tactic, coin_index).with_from(from);

        match spec {
            Tactic::RangedAttack { min, max, straight_line, blocked } => {
                // Stacks first, then the Fortifications nobody is standing on:
                // a lone fort is a legal target for any attack that could reach
                // a unit there, and walking `state.units` never finds one.
                let mut targets: HexList = HexList::new();
                for (hex, stack) in state.units.iter() {
                    if stack.team != team {
                        targets.push(hex);
                    }
                }
                for hex in &board_for(state.size).hexes {
                    if state.forts[*hex as usize] && !state.units.occupied(*hex) {
                        targets.push(*hex);
                    }
                }
                for target in targets {
                    let d = DIST[from as usize][target as usize];
                    if d < min || d > max {
                        continue;
                    }
                    if straight_line {
                        let dir = DIR_BETWEEN[from as usize][target as usize];
                        if dir == NONE {
                            continue;
                        }
                        // A Trebuchet lobs over anything; a Crossbowman needs a lane.
                        if blocked && !ray_clear(from, dir, d, &|h| state.units.occupied(h)) {
                            continue;
                        }
                    }
                    if !can_attack_target(state, from, target) {
                        continue;
                    }
                    out.push(base.with_target(target));
                }
            }
            Tactic::ChargeAttack { min, max, straight_line } => {
                charge_options(state, from, min, max, straight_line, |to, target| {
                    out.push(base.with_to(to).with_target(target));
                });
            }
            Tactic::MultiMove { distance } => {
                reachable(state, from, distance, &mut landings);
                for to in &landings {
                    out.push(base.with_to(*to));
                }
            }
            // Played with the Royal Coin only; handled in the Royal Coin branch.
            Tactic::RoyalRedeploy { .. } => {}
            Tactic::BolsterAllyFromSupply => {
                let can_help = adjacent(state, from).iter().any(|hex| match state.units.get(*hex) {
                    Some(ally) if ally.team == team && ally.coins == 1 => {
                        state.players[ally.seat as usize].supply_of(ally.unit) > 0
                    }
                    _ => false,
                });
                if can_help {
                    out.push(base);
                }
            }
            Tactic::ControlThenProclaim => {
                if can_control_here(state, from) {
                    out.push(base);
                }
            }
            Tactic::RecruitThenManeuver => {
                let me = state.player(seat);
                if me.units.iter().any(|u| me.supply_of(*u) > 0) {
                    out.push(base);
                }
            }
            Tactic::AttackTwice => {
                for target in adjacent(state, from) {
                    if can_attack_target(state, from, *target) {
                        out.push(base.with_target(*target));
                    }
                }
            }
            Tactic::PushAlly => {
                for subject in adjacent(state, from) {
                    match state.units.get(*subject) {
                        Some(ally) if ally.team == team => {}
                        _ => continue,
                    }
                    empty_neighbors(state, *subject, &mut empties);
                    for to in &empties {
                        if *to == from {
                            continue; // the wagon is about to move into `subject`
                        }
                        out.push(base.with_subject(*subject).with_to(*to));
                    }
                }
            }
            Tactic::MoveThenPoison => {
                empty_neighbors(state, from, &mut empties);
                for to in empties.clone() {
                    for target in adjacent(state, to) {
                        if let Some(foe) = state.units.get(*target) {
                            if foe.team != team {
                                out.push(base.with_to(to).with_target(*target));
                            }
                        }
                    }
                }
            }
            Tactic::PoisonAtRange { min, max } => {
                for (target, foe) in state.units.iter() {
                    if foe.team == team {
                        continue;
                    }
                    // "one or two spaces away" — the space between may be occupied.
                    let d = DIST[from as usize][target as usize];
                    if d < min || d > max {
                        continue;
                    }
                    out.push(base.with_target(target));
                }
            }
            Tactic::Infiltrate { distance } => {
                reachable(state, from, distance, &mut landings);
                for to in &landings {
                    match state.control_of(*to) {
                        Some(held) if held != team => {}
                        _ => continue,
                    }
                    if state.markers_remaining(team) <= 0 {
                        continue;
                    }
                    out.push(base.with_to(*to));
                }
            }
            Tactic::Skirmish { distance } => {
                reachable(state, from, distance, &mut landings);
                for to in &landings {
                    let next_to_foe = adjacent(state, *to).iter().any(|h| {
                        state.units.get(*h).map(|foe| foe.team != team).unwrap_or(false)
                    });
                    if next_to_foe {
                        out.push(base.with_to(*to));
                    }
                }
            }
            Tactic::MoveThenAttackFort => {
                empty_neighbors(state, from, &mut empties);
                for to in empties.clone() {
                    for target in adjacent(state, to) {
                        if can_attack_fort(state, team, *target) {
                            out.push(base.with_to(to).with_target(*target));
                        }
                    }
                }
            }
            Tactic::GrantManeuver { attack, range } => {
                for subject in friendly_units(state, team) {
                    if subject == from {
                        continue;
                    }
                    if DIST[from as usize][subject as usize] > range {
                        continue;
                    }
                    if attack {
                        if has_restriction(
                            state.units.get(subject).unwrap().unit,
                            restrict::NO_NORMAL_ATTACK,
                        ) {
                            continue;
                        }
                        if !can_attack_anything_adjacent(state, subject) {
                            continue;
                        }
                    } else {
                        empty_neighbors(state, subject, &mut empties);
                        if !empties.iter().any(|to| DIST[from as usize][*to as usize] <= range) {
                            continue;
                        }
                    }
                    out.push(base.with_subject(subject));
                }
            }
            Tactic::ManeuverEachUnit => {
                if has_maneuver_follow_ups(state, from) {
                    out.push(base);
                }
            }
        }
    }

    // `maneuverEachUnit` acts with every unit at once, so one action is enough.
    if matches!(spec, Tactic::ManeuverEachUnit) {
        out.truncate(start + 1);
    }
}

pub fn legal_actions(state: &GameState, seat: Seat, out: &mut Vec<Action>) {
    out.clear();
    match state.phase {
        Phase::Ban => {
            if seat != ban_seat(state) {
                return;
            }
            for unit in &state.draft_pool {
                out.push(Action::bare(ActionKind::Ban).with_unit(*unit));
            }
            return;
        }
        Phase::Draft => {
            if seat != state.turn {
                return;
            }
            for unit in &state.draft_pool {
                out.push(Action::bare(ActionKind::Draft).with_unit(*unit));
            }
            return;
        }
        Phase::Finished => return,
        Phase::Playing => {}
    }

    // Most steps belong to the player whose turn it is, but a defender's choice
    // (soaking a hit) is answered by the defender, mid-attack.
    if let Some(step) = state.pending.last() {
        let owner = step.answering_seat().unwrap_or(state.turn);
        if seat == owner {
            pending_actions(state, seat, &step.clone(), out);
        }
        return;
    }
    if seat != state.turn {
        return;
    }

    let hand = state.player(seat).hand.clone();
    for (i, coin) in hand.iter().enumerate() {
        coin_actions(state, seat, i as u8, *coin, out);
    }
}

pub fn legal(state: &GameState, seat: Seat) -> Vec<Action> {
    let mut out = Vec::with_capacity(64);
    legal_actions(state, seat, &mut out);
    out
}

fn coin_actions(state: &GameState, seat: Seat, coin_index: u8, coin: CoinId, out: &mut Vec<Action>) {
    let me = state.player(seat);

    // Facedown actions are available with any coin, including the Royal Coin.
    out.push(Action::coin(ActionKind::Pass, coin_index));
    // Whether *the side* already holds it, not whether this seat does: in a
    // four-player game a player could otherwise take the marker off their own
    // partner, which is a move the box does not contain. In a duel a side is
    // one player and the two readings coincide.
    let ours = state.players.iter().any(|p| p.has_initiative && p.team == me.team);
    if !ours && !state.initiative_moved_this_round {
        out.push(Action::coin(ActionKind::ClaimInitiative, coin_index));
    }
    for unit in &me.units {
        if me.supply_of(*unit) > 0 {
            out.push(Action::coin(ActionKind::Recruit, coin_index).with_unit(*unit));
        }
    }

    if coin.is_decoy() {
        // A Decoy is good for the facedown actions and for being handed back —
        // never for placement, a maneuver, unpoisoning or a proclamation.
        out.push(Action::coin(ActionKind::ReturnDecoy, coin_index));
        return;
    }

    let unit = match coin.as_unit() {
        Some(u) => u,
        None => {
            for card in state.decrees.clone() {
                if can_proclaim(state, seat, card.id) {
                    out.push(Action::coin(ActionKind::Proclaim, coin_index).with_decree(card.id));
                }
            }
            // The Royal Guard's tactic is the one board action the Royal Coin buys.
            if let Some(Tactic::RoyalRedeploy { distance }) = UnitId::RoyalGuard.spec().tactic {
                let mut targets = HexList::new();
                for from in deployed_units(state, seat, UnitId::RoyalGuard) {
                    royal_redeploy_targets(state, seat, from, distance, &mut targets);
                    for to in &targets {
                        out.push(
                            Action::coin(ActionKind::Tactic, coin_index)
                                .with_from(from)
                                .with_to(*to),
                        );
                    }
                }
            }
            return;
        }
    };

    if !me.drafted(unit) {
        return; // shouldn't happen, but stay safe
    }

    // Placement actions.
    for to in deploy_targets(state, seat, unit) {
        out.push(Action::coin(ActionKind::Deploy, coin_index).with_to(to));
    }
    let mine = deployed_units(state, seat, unit);
    for at in &mine {
        if is_poisoned(state, *at) {
            continue;
        }
        out.push(Action::coin(ActionKind::Bolster, coin_index).with_from(*at));
    }

    // Poison stops a unit being driven by its own coins — but not by a Marshal,
    // an Ensign or a decree. Spending a matching coin lifts every counter off
    // your units of that type, and that is not a maneuver.
    if mine.iter().any(|hex| is_poisoned(state, *hex)) {
        out.push(Action::coin(ActionKind::Unpoison, coin_index));
    }

    // Maneuvers.
    let mut empties = HexList::new();
    for from in &mine {
        if is_poisoned(state, *from) {
            continue;
        }
        empty_neighbors(state, *from, &mut empties);
        for to in &empties {
            out.push(Action::coin(ActionKind::Move, coin_index).with_from(*from).with_to(*to));
        }
        if !has_restriction(unit, restrict::NO_NORMAL_ATTACK) {
            for to in adjacent(state, *from) {
                if can_attack_target(state, *from, *to) {
                    out.push(
                        Action::coin(ActionKind::Attack, coin_index)
                            .with_from(*from)
                            .with_to(*to),
                    );
                }
            }
        }
        if can_control_here(state, *from) {
            out.push(Action::coin(ActionKind::Control, coin_index).with_from(*from));
        }
    }
    tactic_actions(state, seat, coin_index, unit, out);
}

fn pending_actions(state: &GameState, seat: Seat, step: &PendingStep, out: &mut Vec<Action>) {
    let mut empties = HexList::new();
    match step {
        // The unit may be gone by now — a Sacrifice takes the attacker's last
        // coin right after the attack, and the Swordsman's free move is offered
        // from the hex it used to stand on.
        PendingStep::OptionalMove { hex, .. } => {
            if state.units.occupied(*hex) {
                empty_neighbors(state, *hex, &mut empties);
                for to in &empties {
                    out.push(Action::bare(ActionKind::FollowMove).with_from(*hex).with_to(*to));
                }
            }
            out.push(Action::bare(ActionKind::Skip));
        }
        PendingStep::OptionalRepeat { hex } => {
            if let Some(stack) = state.units.get(*hex) {
                if stack.coins >= 2 && has_maneuver_follow_ups(state, *hex) {
                    out.push(Action::bare(ActionKind::FollowRepeat).with_from(*hex));
                }
            }
            out.push(Action::bare(ActionKind::Skip));
        }
        PendingStep::ManeuverUnit { hex, optional, .. } => {
            maneuver_follow_ups(state, *hex, out);
            if *optional || out.is_empty() {
                out.push(Action::bare(ActionKind::Skip));
            }
        }
        PendingStep::GrantManeuver { attack, origin, range, .. } => {
            if let Some(o) = state.units.get(*origin) {
                for subject in friendly_units(state, o.team) {
                    if subject == *origin {
                        continue;
                    }
                    if DIST[*origin as usize][subject as usize] > *range {
                        continue;
                    }
                    if !*attack {
                        empty_neighbors(state, subject, &mut empties);
                        for to in &empties {
                            if DIST[*origin as usize][*to as usize] > *range {
                                continue;
                            }
                            out.push(
                                Action::bare(ActionKind::FollowMove)
                                    .with_from(subject)
                                    .with_to(*to),
                            );
                        }
                    } else {
                        if has_restriction(
                            state.units.get(subject).unwrap().unit,
                            restrict::NO_NORMAL_ATTACK,
                        ) {
                            continue;
                        }
                        for to in adjacent(state, subject) {
                            if can_attack_target(state, subject, *to) {
                                out.push(
                                    Action::bare(ActionKind::FollowAttack)
                                        .with_from(subject)
                                        .with_to(*to),
                                );
                            }
                        }
                    }
                }
            }
            out.push(Action::bare(ActionKind::Skip));
        }
        PendingStep::DecreeAttack { from_own_location, .. } => {
            let team = state.player(seat).team;
            for from in attackers_for(state, team, *from_own_location) {
                for to in adjacent(state, from) {
                    if can_attack_target(state, from, *to) {
                        out.push(
                            Action::bare(ActionKind::FollowAttack).with_from(from).with_to(*to),
                        );
                    }
                }
            }
        }
        PendingStep::DecreeMove { require_bolstered } => {
            let team = state.player(seat).team;
            for from in friendly_units(state, team) {
                if *require_bolstered && state.units.get(from).unwrap().coins < 2 {
                    continue;
                }
                empty_neighbors(state, from, &mut empties);
                for to in &empties {
                    out.push(Action::bare(ActionKind::FollowMove).with_from(from).with_to(*to));
                }
            }
        }
        PendingStep::DecreeRecruit { .. } => {
            let me = state.player(seat);
            for unit in &me.units {
                if me.supply_of(*unit) > 0 {
                    out.push(Action::bare(ActionKind::FollowRecruit).with_unit(*unit));
                }
            }
            if out.is_empty() {
                out.push(Action::bare(ActionKind::Skip));
            }
        }
        PendingStep::FreeTactic { unit } => {
            // The same generator a paid tactic uses, with the coin taken back
            // out: whatever the card can do costs nothing here.
            let mut paid = Vec::new();
            tactic_actions(state, seat, NONE, *unit, &mut paid);
            for action in paid {
                out.push(action.as_kind(ActionKind::FollowTactic).without_coin());
            }
            // "You may" — and the card is silent about the case where the unit
            // is nowhere on the board, the usual one right after recruiting it.
            out.push(Action::bare(ActionKind::Skip));
        }
        PendingStep::DecreeLift => {
            let team = state.player(seat).team;
            for hex in own_units(state, seat) {
                if !open_controlled_locations(state, team, Some(hex)).is_empty() {
                    out.push(Action::bare(ActionKind::FollowLift).with_from(hex));
                }
            }
        }
        PendingStep::DecreePlace { .. } => {
            let team = state.player(seat).team;
            for to in open_controlled_locations(state, team, None) {
                out.push(Action::bare(ActionKind::FollowPlace).with_to(to));
            }
        }
        PendingStep::DecreeSpy { target } => {
            if let Some(p) = state.players.get(*target as usize) {
                for index in 0..p.hand.len() {
                    out.push(Action::bare(ActionKind::FollowSpy).with_arg(index as u8));
                }
            }
            out.push(Action::bare(ActionKind::Skip));
        }
        PendingStep::DecreeReinforce => {
            let me = state.player(seat);
            for unit in UNIT_IDS {
                if me.removed_of(unit) > 0 {
                    out.push(Action::bare(ActionKind::FollowReinforce).with_unit(unit));
                }
            }
        }
        PendingStep::HeraldBolster { origin } => {
            let team = state.units.get(*origin).map(|s| s.team);
            for hex in adjacent(state, *origin) {
                let stack = match state.units.get(*hex) {
                    Some(s) => s,
                    None => continue,
                };
                if Some(stack.team) != team {
                    continue;
                }
                if stack.coins != 1 {
                    continue; // "one adjacent unbolstered friendly unit"
                }
                if state.players[stack.seat as usize].supply_of(stack.unit) == 0 {
                    continue;
                }
                out.push(Action::bare(ActionKind::FollowBolster).with_from(*hex));
            }
            out.push(Action::bare(ActionKind::Skip));
        }
        PendingStep::ShoveEnemy { origin } => {
            let mine = state.units.get(*origin).copied();
            for from in adjacent(state, *origin) {
                let foe = match (state.units.get(*from), mine) {
                    (Some(f), Some(m)) if f.team != m.team => f,
                    _ => continue,
                };
                let _ = foe;
                empty_neighbors(state, *from, &mut empties);
                for to in &empties {
                    out.push(Action::bare(ActionKind::FollowShove).with_from(*from).with_to(*to));
                }
            }
            out.push(Action::bare(ActionKind::Skip));
        }
        PendingStep::ManeuverUnitLimited { hex, allow_move, allow_attack } => {
            if let Some(stack) = state.units.get(*hex) {
                if *allow_move {
                    empty_neighbors(state, *hex, &mut empties);
                    for to in &empties {
                        out.push(
                            Action::bare(ActionKind::FollowMove).with_from(*hex).with_to(*to),
                        );
                    }
                }
                if *allow_attack && !has_restriction(stack.unit, restrict::NO_NORMAL_ATTACK) {
                    for to in adjacent(state, *hex) {
                        if can_attack_target(state, *hex, *to) {
                            out.push(
                                Action::bare(ActionKind::FollowAttack)
                                    .with_from(*hex)
                                    .with_to(*to),
                            );
                        }
                    }
                }
            }
            if out.is_empty() {
                out.push(Action::bare(ActionKind::Skip));
            }
        }
        PendingStep::Proclaim { free } => {
            for card in state.decrees.clone() {
                let usable = if *free {
                    can_execute_decree(state, seat, card.id)
                } else {
                    can_proclaim(state, seat, card.id)
                };
                if usable {
                    out.push(Action::bare(ActionKind::FollowProclaim).with_decree(card.id));
                }
            }
            out.push(Action::bare(ActionKind::Skip));
        }
        PendingStep::BuildFort { hex, .. } => {
            out.push(Action::bare(ActionKind::FollowBuildFort).with_from(*hex));
            out.push(Action::bare(ActionKind::Skip));
        }
        PendingStep::BurnSupply { unit, .. } => {
            out.push(Action::bare(ActionKind::FollowBurn).with_unit(*unit));
            out.push(Action::bare(ActionKind::Skip));
        }
        PendingStep::Deceive { .. } => {
            let team = state.player(seat).team;
            for p in &state.players {
                if p.team != team {
                    out.push(Action::bare(ActionKind::FollowDeceive).with_arg(p.seat));
                }
            }
            out.push(Action::bare(ActionKind::Skip));
        }
        PendingStep::BolsterSelf { hex } => {
            if state.units.occupied(*hex) {
                out.push(Action::bare(ActionKind::FollowBolster).with_from(*hex));
            }
            out.push(Action::bare(ActionKind::Skip));
        }
        PendingStep::AbsorbHit { options, .. } => {
            if options.supply {
                out.push(
                    Action::bare(ActionKind::FollowAbsorb).with_arg(AbsorbSource::Supply as u8),
                );
            }
            for hex in &options.wagons {
                out.push(
                    Action::bare(ActionKind::FollowAbsorb)
                        .with_arg(AbsorbSource::Wagon as u8)
                        .with_from(*hex),
                );
            }
            if options.decoy {
                out.push(
                    Action::bare(ActionKind::FollowAbsorb).with_arg(AbsorbSource::Decoy as u8),
                );
            }
            out.push(Action::bare(ActionKind::Skip));
        }
        PendingStep::MustUseCoin { coin } => {
            // Never `None` on a real state: only `view_for` blanks it, and only
            // for a seat that is not the one being asked to spend it.
            let coin = coin.expect("mustUseCoin reached the engine redacted");
            let me = state.player(seat);
            match me.hand.iter().rposition(|c| *c == coin) {
                Some(idx) => coin_actions(state, seat, idx as u8, coin, out),
                None => out.push(Action::bare(ActionKind::Skip)),
            }
        }
    }

    // A step that owes an effect nobody can carry out is dropped, not enforced.
    // Sacrifice is the case that showed up: it is proclaimed while an attack is
    // available, a Herald maneuver underneath it moves the only attacker out of
    // range, and by the time the decree resolves there is nothing to hit.
    if out.is_empty() {
        out.push(Action::bare(ActionKind::Skip));
    }
}

// ---------------------------------------------------------------------------
// Applying actions
// ---------------------------------------------------------------------------

fn log_plain(state: &mut GameState, seat: Seat, kind: LogKind) {
    let entry = LogEntry::new(state.round, seat, kind);
    state.log.push(entry);
}

fn log_unit(state: &mut GameState, seat: Seat, kind: LogKind, unit: UnitId) {
    let mut entry = LogEntry::new(state.round, seat, kind);
    entry.unit = unit as u8;
    state.log.push(entry);
}

fn log_unit_hex(state: &mut GameState, seat: Seat, kind: LogKind, unit: UnitId, hex: HexIdx) {
    let mut entry = LogEntry::new(state.round, seat, kind);
    entry.unit = unit as u8;
    entry.hex = hex;
    state.log.push(entry);
}

fn log_decree(state: &mut GameState, seat: Seat, kind: LogKind, decree: DecreeId) {
    let mut entry = LogEntry::new(state.round, seat, kind);
    entry.decree = decree as u8;
    state.log.push(entry);
}

fn discard_coin(
    state: &mut GameState,
    seat: Seat,
    coin_index: u8,
    face_up: bool,
) -> Result<CoinId, &'static str> {
    let me = state.player_mut(seat);
    if coin_index as usize >= me.hand.len() {
        return Err("no such coin in hand");
    }
    let coin = me.hand.remove(coin_index as usize);
    me.discard.push(DiscardEntry { coin, face_up });
    Ok(coin)
}

/// Applies one hit. The Royal Guard can soak it out of its supply and a War
/// Wagon can take it for an adjacent friend — both are the defender's choice, so
/// the hit waits on a step that the defender, not the attacker, answers.
fn take_hit(state: &mut GameState, hex: HexIdx, by_hex: HexIdx, by_unit: UnitId, by_seat: Seat) {
    let stack = match state.units.get(hex) {
        Some(s) => *s,
        None => return,
    };

    let mut options = AbsorbOptions::default();
    if has_attribute(stack.unit, attr::ABSORB_HIT_FROM_SUPPLY)
        && state.players[stack.seat as usize].supply_of(stack.unit) > 0
    {
        options.supply = true;
    }
    for near in adjacent(state, hex) {
        if let Some(ally) = state.units.get(*near) {
            if ally.team == stack.team && has_attribute(ally.unit, attr::ABSORB_HIT_FOR_ALLY) {
                options.wagons.push(*near);
            }
        }
    }
    if has_attribute(stack.unit, attr::DECEIVE_WHEN_ATTACKED) {
        if let Some(decoy) = decoy_of(stack.unit) {
            if decoy_available(state, decoy) {
                options.decoy = true;
            }
        }
    }

    if !options.is_empty() {
        state.pending.push(PendingStep::AbsorbHit {
            seat: stack.seat,
            target: hex,
            by_hex,
            by_unit,
            by_seat,
            options,
        });
        return;
    }
    remove_coins(state, hex, 1);
}

/// Takes coins off a stack and out of the game — the rulebook puts them "back in
/// the box", not the discard pile. They are tallied per player so the Nobility
/// Reinforce decree can call one back.
fn remove_coins(state: &mut GameState, hex: HexIdx, n: u8) {
    let stack = match state.units.get_mut(hex) {
        Some(s) => s,
        None => return,
    };
    let gone = n.min(stack.coins);
    let left = stack.coins as i16 - n as i16;
    stack.coins = left.max(0) as u8;
    let (unit, seat) = (stack.unit, stack.seat);
    if let Some(owner) = state.players.get_mut(seat as usize) {
        owner.removed[unit as usize] += gone;
    }
    if left <= 0 {
        state.units.remove(hex); // the Poison Counter goes home with it
    }
}

/// The Berserker pays for its extra maneuver by *discarding* a bolstered coin,
/// so that one goes to the discard pile and comes back round in the bag.
fn discard_from_stack(state: &mut GameState, hex: HexIdx) -> EngineResult {
    let (unit, seat) = match state.units.get_mut(hex) {
        Some(s) if s.coins >= 2 => {
            s.coins -= 1;
            (s.unit, s.seat)
        }
        _ => return Err("nothing bolstered to discard"),
    };
    if let Some(owner) = state.players.get_mut(seat as usize) {
        owner.discard.push(DiscardEntry { coin: CoinId::unit(unit), face_up: true });
    }
    Ok(())
}

fn move_stack(state: &mut GameState, from: HexIdx, to: HexIdx) -> EngineResult {
    if !state.units.occupied(from) {
        return Err("nothing to move");
    }
    if state.units.occupied(to) {
        return Err("destination occupied");
    }
    state.units.relocate(from, to);
    Ok(())
}

fn place_control(state: &mut GameState, hex: HexIdx, team: Team, seat: Seat) {
    state.control[hex as usize] = team;
    // `unit` as well as `hex`: control is one of the three maneuvers, and a rule
    // like "the unit that was most recently maneuvered" has to know which unit.
    match state.units.get(hex).map(|s| s.unit) {
        Some(unit) => log_unit_hex(state, seat, LogKind::Control, unit, hex),
        None => {
            let mut entry = LogEntry::new(state.round, seat, LogKind::Control);
            entry.hex = hex;
            state.log.push(entry);
        }
    }
    if state.markers_remaining(team) == 0 {
        state.phase = Phase::Finished;
        state.winner = Some(team);
        let mut entry = LogEntry::new(state.round, seat, LogKind::Victory);
        entry.team = team;
        state.log.push(entry);
    }
}

/// Resolves one attack, including retaliation and post-attack attributes.
fn resolve_attack(
    state: &mut GameState,
    attacker_hex: HexIdx,
    target_hex: HexIdx,
    seat: Seat,
) -> EngineResult {
    let attacker = match state.units.get(attacker_hex) {
        Some(a) => *a,
        None => return Err("illegal attack"),
    };

    // A Fortification soaks the whole attack and goes back to the supply.
    if state.forts[target_hex as usize] {
        state.forts[target_hex as usize] = false;
        state.fort_supply += 1;
        let mut entry = LogEntry::new(state.round, seat, LogKind::RazeFort);
        entry.hex = target_hex;
        state.log.push(entry);
        after_maneuver(state, attacker_hex, seat, Maneuver::Attack);
        return Ok(());
    }

    let target = match state.units.get(target_hex) {
        Some(t) => *t,
        None => return Err("illegal attack"),
    };

    // `from` as well as `hex`: a screen showing the last move has to say who
    // swung, and a ranged tactic's attacker is nowhere near its victim.
    {
        let mut entry = LogEntry::new(state.round, seat, LogKind::Attack);
        entry.unit = attacker.unit as u8;
        entry.target_unit = target.unit as u8;
        entry.from = attacker_hex;
        entry.hex = target_hex;
        state.log.push(entry);
    }
    let was_adjacent = DIST[attacker_hex as usize][target_hex as usize] == 1;
    // The Pikeman's card says "attacked by an adjacent unit", so ranged tactics
    // like the Archer's and the Crossbowman's do not set it off.
    if was_adjacent && has_attribute(target.unit, attr::RETALIATE) {
        remove_coins(state, attacker_hex, 1);
    }

    // Steps resolve newest first, so queue the attacker's follow-ups before the
    // hit: the defender's choice to soak it belongs to this attack, and has to
    // be answered before the attacker carries on.
    after_maneuver(state, attacker_hex, seat, Maneuver::Attack);
    if target.poisoned_by.is_some()
        && has_attribute(attacker.unit, attr::BURN_SUPPLY_AFTER_KILLING_POISONED)
        && state.players[target.seat as usize].supply_of(target.unit) > 0
    {
        state.pending.push(PendingStep::BurnSupply { unit: target.unit, owner: target.seat });
    }
    take_hit(state, target_hex, attacker_hex, attacker.unit, attacker.seat);
    Ok(())
}

/// Moves a poisoner's counter onto a new victim. Each poisoner owns one counter,
/// so poisoning again lifts it off whoever had it before.
fn apply_poison(state: &mut GameState, seat: Seat, poisoner: UnitId, target_hex: HexIdx) {
    let poison = Poison::of(poisoner);
    if !poison.is_some() {
        return;
    }
    if let Some(previous) = poisoned_hex(state, poison) {
        if let Some(stack) = state.units.get_mut(previous) {
            stack.poisoned_by = Poison::None;
        }
    }
    let unit = match state.units.get_mut(target_hex) {
        Some(target) => {
            target.poisoned_by = poison;
            target.unit
        }
        None => return,
    };
    log_unit(state, seat, LogKind::Poison, unit);
}

/// Pushes the steps a unit's attributes create the moment a coin of it is
/// recruited.
///
/// **Whichever action did the recruiting.** The Mercenary's free maneuver used
/// to be written inline in the paid `recruit` branch, so a Mercenary recruited
/// by the Enlist decree — or by the Bishop's tactic — got nothing, though the
/// Nobility rulesheet names that exact combination as working. A recruit is a
/// recruit.
///
/// The Saboteur's step is pushed whether or not a Saboteur is standing anywhere;
/// `pending_actions` answers with a bare skip when none is, which is the shape
/// every other optional step has.
fn after_recruit(state: &mut GameState, seat: Seat, unit: UnitId) {
    if has_attribute(unit, attr::FREE_MANEUVER_ON_RECRUIT) {
        if let Some(hex) = deployed_units(state, seat, unit).first() {
            state.pending.push(PendingStep::ManeuverUnit {
                hex: *hex,
                source: StepSource::Mercenary,
                optional: true,
            });
        }
    }
    if has_attribute(unit, attr::TACTIC_ON_RECRUIT) {
        state.pending.push(PendingStep::FreeTactic { unit });
    }
}

/// Pushes the steps a unit's attributes create the moment it lands on the board.
///
/// Same reason as [`after_recruit`]: a deploy is a deploy, and the Redeploy
/// decree put a stack down by writing it into the board directly — so an Earl
/// redeployed never got its move and a Siege Tower never got its bolster.
fn after_deploy(state: &mut GameState, seat: Seat, unit: UnitId, hex: HexIdx) {
    if has_attribute(unit, attr::MOVE_AFTER_DEPLOY) {
        state.pending.push(PendingStep::OptionalMove { hex, source: StepSource::Earl });
    }
    if has_attribute(unit, attr::BOLSTER_ON_DEPLOY) && state.player(seat).supply_of(unit) > 0 {
        state.pending.push(PendingStep::BolsterSelf { hex });
    }
}

#[derive(Copy, Clone, PartialEq, Eq)]
enum Maneuver {
    Move,
    Attack,
    Control,
}

/// Pushes the pending steps a unit's attributes create after it acts.
fn after_maneuver(state: &mut GameState, hex: HexIdx, seat: Seat, maneuver: Maneuver) {
    let stack = match state.units.get(hex) {
        Some(s) if s.seat == seat => *s,
        _ => return,
    };

    if has_attribute(stack.unit, attr::MANEUVER_AGAIN_FOR_COIN) && stack.coins >= 2 {
        state.pending.push(PendingStep::OptionalRepeat { hex });
    }
    if maneuver == Maneuver::Attack && has_attribute(stack.unit, attr::MOVE_AFTER_ATTACK) {
        state.pending.push(PendingStep::OptionalMove { hex, source: StepSource::Swordsman });
    }
    if maneuver == Maneuver::Move
        && has_attribute(stack.unit, attr::BUILD_FORT_ON_MOVE)
        && is_location(state, hex)
        && !state.forts[hex as usize]
        && state.fort_supply > 0
    {
        state.pending.push(PendingStep::BuildFort { hex, seat });
    }
    if maneuver == Maneuver::Control && has_attribute(stack.unit, attr::DECEIVE_AFTER_CONTROL) {
        if let Some(decoy) = decoy_of(stack.unit) {
            if decoy_available(state, decoy) {
                state.pending.push(PendingStep::Deceive { decoy });
            }
        }
    }
    if has_attribute(stack.unit, attr::SHOVE_ENEMY_AFTER_MANEUVER) {
        let has_foe = adjacent(state, hex).iter().any(|h| {
            state.units.get(*h).map(|foe| foe.team != stack.team).unwrap_or(false)
                && has_empty_neighbor(state, *h)
        });
        if has_foe {
            state.pending.push(PendingStep::ShoveEnemy { origin: hex });
        }
    }
    if (maneuver == Maneuver::Attack || maneuver == Maneuver::Control)
        && has_attribute(stack.unit, attr::DRAW_AND_USE)
    {
        let drawn = draw_coins(state, seat, 1);
        if let Some(coin) = drawn.first() {
            state.pending.push(PendingStep::MustUseCoin { coin: Some(*coin) });
        }
    }
}

fn apply_tactic(state: &mut GameState, seat: Seat, action: Action) -> EngineResult {
    let stack = match state.units.get(action.from) {
        Some(s) => *s,
        None => return Err("unit not deployed"),
    };
    let spec = match stack.unit.spec().tactic {
        Some(s) => s,
        None => return Err("unit has no tactic"),
    };
    log_unit(state, seat, LogKind::Tactic, stack.unit);

    match spec {
        Tactic::RangedAttack { .. } => {
            if action.target == NONE {
                return Err("tactic needs a target");
            }
            resolve_attack(state, action.from, action.target, seat)?;
        }
        Tactic::ChargeAttack { .. } => {
            if action.to == NONE || action.target == NONE {
                return Err("tactic needs a destination and a target");
            }
            move_stack(state, action.from, action.to)?;
            resolve_attack(state, action.to, action.target, seat)?;
        }
        Tactic::MultiMove { .. } => {
            if action.to == NONE {
                return Err("tactic needs a destination");
            }
            move_stack(state, action.from, action.to)?;
            after_maneuver(state, action.to, seat, Maneuver::Move);
        }
        Tactic::GrantManeuver { attack, range } => {
            state.pending.push(PendingStep::GrantManeuver {
                attack,
                origin: action.from,
                range,
                source: if stack.unit == UnitId::Marshal {
                    StepSource::Marshal
                } else {
                    StepSource::Ensign
                },
            });
        }
        Tactic::ManeuverEachUnit => {
            // Push in reverse so the first unit resolves first (steps pop off the end).
            let mut hexes = deployed_units(state, seat, stack.unit);
            hexes.reverse();
            for hex in hexes {
                // Not optional: the card says «perform one maneuver with each
                // Footman unit», and an optional step let a player skip the one
                // that would have hurt.
                state.pending.push(PendingStep::ManeuverUnit {
                    hex,
                    source: StepSource::Footman,
                    optional: false,
                });
            }
        }
        Tactic::BolsterAllyFromSupply => {
            state.pending.push(PendingStep::HeraldBolster { origin: action.from });
        }
        Tactic::ControlThenProclaim => {
            place_control(state, action.from, stack.team, seat);
            if state.phase == Phase::Finished {
                return Ok(());
            }
            after_maneuver(state, action.from, seat, Maneuver::Control);
            // The Earl's proclamation costs neither a Seal nor the once-per-game limit.
            state.pending.push(PendingStep::Proclaim { free: true });
        }
        Tactic::RecruitThenManeuver => {
            state.pending.push(PendingStep::DecreeRecruit { source: StepSource::Bishop });
        }
        Tactic::AttackTwice => {
            if action.target == NONE {
                return Err("tactic needs a target");
            }
            // The bolstered condition is checked when the tactic starts, not
            // again halfway through, so the second blow lands even if the tower
            // shrank.
            state.pending.push(PendingStep::ManeuverUnitLimited {
                hex: action.from,
                allow_move: false,
                allow_attack: true,
            });
            resolve_attack(state, action.from, action.target, seat)?;
        }
        Tactic::PushAlly => {
            if action.subject == NONE || action.to == NONE {
                return Err("tactic needs an ally and a space");
            }
            move_stack(state, action.subject, action.to)?;
            let mut entry = LogEntry::new(state.round, seat, LogKind::Push);
            entry.from = action.subject;
            entry.to = action.to;
            state.log.push(entry);
            move_stack(state, action.from, action.subject)?;
            after_maneuver(state, action.subject, seat, Maneuver::Move);
        }
        Tactic::MoveThenPoison => {
            if action.to == NONE || action.target == NONE {
                return Err("tactic needs a space and a target");
            }
            move_stack(state, action.from, action.to)?;
            apply_poison(state, seat, stack.unit, action.target);
            after_maneuver(state, action.to, seat, Maneuver::Move);
        }
        Tactic::PoisonAtRange { .. } => {
            if action.target == NONE {
                return Err("tactic needs a target");
            }
            apply_poison(state, seat, stack.unit, action.target);
        }
        Tactic::Infiltrate { .. } => {
            if action.to == NONE {
                return Err("tactic needs a destination");
            }
            move_stack(state, action.from, action.to)?;
            place_control(state, action.to, stack.team, seat);
            if state.phase == Phase::Finished {
                return Ok(());
            }
            after_maneuver(state, action.to, seat, Maneuver::Control);
        }
        Tactic::Skirmish { .. } => {
            if action.to == NONE {
                return Err("tactic needs a destination");
            }
            move_stack(state, action.from, action.to)?;
            after_maneuver(state, action.to, seat, Maneuver::Move);
        }
        Tactic::MoveThenAttackFort => {
            if action.to == NONE || action.target == NONE {
                return Err("tactic needs a space and a fort");
            }
            move_stack(state, action.from, action.to)?;
            // The move half is a move. On the printed board this can raise
            // nothing — a wall stands on a location, the tactic hits something
            // adjacent to the landing hex, and no two locations touch — so the
            // attribute is unreachable *by accident of the geometry*, and the
            // accident belongs to the board rather than to this line. A test in
            // `review.rs` pins it.
            after_maneuver(state, action.to, seat, Maneuver::Move);
            resolve_attack(state, action.to, action.target, seat)?;
        }
        Tactic::RoyalRedeploy { .. } => {
            if action.to == NONE {
                return Err("tactic needs a destination");
            }
            move_stack(state, action.from, action.to)?;
            after_maneuver(state, action.to, seat, Maneuver::Move);
        }
    }
    Ok(())
}

fn apply_coin_action(state: &mut GameState, seat: Seat, action: Action) -> EngineResult {
    match action.kind {
        ActionKind::Pass => {
            discard_coin(state, seat, action.coin, false)?;
            log_plain(state, seat, LogKind::Pass);
        }
        ActionKind::Unpoison => {
            let coin = discard_coin(state, seat, action.coin, true)?;
            let unit = coin.as_unit().ok_or("that coin cures nothing")?;
            for hex in deployed_units(state, seat, unit) {
                if let Some(stack) = state.units.get_mut(hex) {
                    stack.poisoned_by = Poison::None;
                }
            }
            log_unit(state, seat, LogKind::Unpoison, unit);
        }
        ActionKind::ReturnDecoy => {
            let me = state.player_mut(seat);
            let coin = me.hand.get(action.coin as usize).copied().ok_or("not a decoy")?;
            if !coin.is_decoy() {
                return Err("not a decoy");
            }
            me.hand.remove(action.coin as usize); // back to its card, not the discard
            log_plain(state, seat, LogKind::ReturnDecoy);
        }
        ActionKind::ClaimInitiative => {
            discard_coin(state, seat, action.coin, false)?;
            for p in state.players.iter_mut() {
                p.has_initiative = p.seat == seat;
            }
            state.initiative = seat;
            state.initiative_moved_this_round = true;
            log_plain(state, seat, LogKind::ClaimInitiative);
        }
        ActionKind::Recruit => {
            let unit = action.unit().ok_or("no such unit")?;
            discard_coin(state, seat, action.coin, false)?;
            let me = state.player_mut(seat);
            if me.supply_of(unit) == 0 {
                return Err("nothing left in supply");
            }
            me.supply[unit as usize] -= 1;
            me.discard.push(DiscardEntry { coin: CoinId::unit(unit), face_up: true });
            log_unit(state, seat, LogKind::Recruit, unit);
            after_recruit(state, seat, unit);
        }
        ActionKind::Deploy => {
            let me = state.player(seat);
            let coin = me.hand.get(action.coin as usize).copied().ok_or("cannot deploy this coin")?;
            let unit = coin.as_unit().ok_or("cannot deploy this coin")?;
            if !deploy_targets(state, seat, unit).contains(&action.to) {
                return Err("illegal deploy");
            }
            let team = me.team;
            state.player_mut(seat).hand.remove(action.coin as usize);
            state.units.insert(
                action.to,
                UnitStack { unit, team, seat, coins: 1, poisoned_by: Poison::None },
            );
            log_unit_hex(state, seat, LogKind::Deploy, unit, action.to);
            after_deploy(state, seat, unit, action.to);
        }
        ActionKind::Bolster => {
            let me = state.player(seat);
            let coin =
                me.hand.get(action.coin as usize).copied().ok_or("cannot bolster with this coin")?;
            let unit = coin.as_unit().ok_or("cannot bolster with this coin")?;
            match state.units.get(action.from) {
                Some(stack) if stack.unit == unit && stack.seat == seat => {}
                _ => return Err("illegal bolster"),
            }
            state.player_mut(seat).hand.remove(action.coin as usize);
            state.units.get_mut(action.from).unwrap().coins += 1;
            log_unit_hex(state, seat, LogKind::Bolster, unit, action.from);
        }
        ActionKind::Move => {
            discard_coin(state, seat, action.coin, true)?;
            move_stack(state, action.from, action.to)?;
            let unit = state.units.get(action.to).ok_or("nothing moved")?.unit;
            let mut entry = LogEntry::new(state.round, seat, LogKind::Move);
            entry.from = action.from;
            entry.to = action.to;
            entry.unit = unit as u8;
            state.log.push(entry);
            after_maneuver(state, action.to, seat, Maneuver::Move);
        }
        ActionKind::Attack => {
            discard_coin(state, seat, action.coin, true)?;
            resolve_attack(state, action.from, action.to, seat)?;
        }
        ActionKind::Control => {
            discard_coin(state, seat, action.coin, true)?;
            let team = match state.units.get(action.from) {
                Some(stack) if stack.seat == seat => stack.team,
                _ => return Err("no unit of yours there"),
            };
            place_control(state, action.from, team, seat);
            if state.phase == Phase::Finished {
                return Ok(());
            }
            after_maneuver(state, action.from, seat, Maneuver::Control);
        }
        ActionKind::Proclaim => {
            let decree = action.decree().ok_or("no such decree")?;
            discard_coin(state, seat, action.coin, true)?;
            let idx = state
                .decrees
                .iter()
                .position(|d| d.id == decree)
                .ok_or("no such decree")?;
            let team = state.player(seat).team;
            spend_seal(state, team)?;
            state.decrees[idx].add_seal(team);
            start_decree(state, seat, decree);
        }
        ActionKind::Tactic => {
            discard_coin(state, seat, action.coin, true)?;
            apply_tactic(state, seat, action)?;
        }
        _ => return Err("not a coin action"),
    }
    Ok(())
}

fn apply_follow_up(state: &mut GameState, seat: Seat, action: Action) -> EngineResult {
    let step = state.pending.pop().ok_or("nothing pending")?;

    if action.kind == ActionKind::Skip {
        match &step {
            PendingStep::AbsorbHit { target, .. } => {
                remove_coins(state, *target, 1);
                return Ok(());
            }
            PendingStep::ManeuverUnit { hex, optional, .. } if !*optional => {
                // A mandatory maneuver may still be skipped if nothing is legal.
                if has_maneuver_follow_ups(state, *hex) {
                    return Err("maneuver is mandatory");
                }
            }
            PendingStep::DecreePlace { unit, coins, from, poisoned_by } => {
                // Redeploy with nowhere to land: the stack goes back where it
                // was lifted from, rather than off the table — and back as it
                // was, counter included.
                if !state.units.occupied(*from) {
                    let team = state.player(seat).team;
                    state.units.insert(
                        *from,
                        UnitStack {
                            unit: *unit,
                            team,
                            seat,
                            coins: *coins,
                            poisoned_by: *poisoned_by,
                        },
                    );
                }
                return Ok(());
            }
            PendingStep::MustUseCoin { coin } => {
                // Only reachable if the coin vanished; treat as passing it.
                let coin = coin.ok_or("mustUseCoin reached the engine redacted")?;
                let me = state.player_mut(seat);
                if let Some(idx) = me.hand.iter().rposition(|c| *c == coin) {
                    me.hand.remove(idx);
                    me.discard.push(DiscardEntry { coin, face_up: false });
                }
            }
            _ => {}
        }
        return Ok(());
    }

    match action.kind {
        ActionKind::FollowMove => {
            move_stack(state, action.from, action.to)?;
            let unit = state.units.get(action.to).ok_or("nothing moved")?.unit;
            let mut entry = LogEntry::new(state.round, seat, LogKind::Move);
            entry.from = action.from;
            entry.to = action.to;
            entry.unit = unit as u8;
            state.log.push(entry);
            after_maneuver(state, action.to, seat, Maneuver::Move);
        }
        ActionKind::FollowAttack => {
            resolve_attack(state, action.from, action.to, seat)?;
            if let PendingStep::DecreeAttack { costs_coin: true, .. } = step {
                log_plain(state, seat, LogKind::Sacrifice);
                remove_coins(state, action.from, 1);
            }
        }
        ActionKind::FollowControl => {
            let team = state.units.get(action.from).ok_or("no unit there")?.team;
            place_control(state, action.from, team, seat);
            if state.phase == Phase::Finished {
                return Ok(());
            }
            after_maneuver(state, action.from, seat, Maneuver::Control);
        }
        ActionKind::FollowRecruit => {
            let unit = action.unit().ok_or("no such unit")?;
            let me = state.player_mut(seat);
            if me.supply_of(unit) == 0 {
                return Err("nothing left in supply");
            }
            me.supply[unit as usize] -= 1;
            me.discard.push(DiscardEntry { coin: CoinId::unit(unit), face_up: true });
            log_unit(state, seat, LogKind::Recruit, unit);
            if let PendingStep::DecreeRecruit { source: StepSource::Bishop } = step {
                if let Some(hex) = deployed_units(state, seat, UnitId::Bishop).first() {
                    state.pending.push(PendingStep::ManeuverUnitLimited {
                        hex: *hex,
                        allow_move: true,
                        allow_attack: true,
                    });
                }
            }
            after_recruit(state, seat, unit);
        }
        ActionKind::FollowLift => {
            let stack = state.units.remove(action.from).ok_or("nothing to lift")?;
            log_unit(state, seat, LogKind::Lift, stack.unit);
            state.pending.push(PendingStep::DecreePlace {
                unit: stack.unit,
                coins: stack.coins,
                from: action.from,
                poisoned_by: stack.poisoned_by,
            });
        }
        ActionKind::FollowPlace => {
            let (unit, coins, poisoned_by) = match step {
                PendingStep::DecreePlace { unit, coins, poisoned_by, .. } => {
                    (unit, coins, poisoned_by)
                }
                _ => return Err("nothing to place"),
            };
            let team = state.player(seat).team;
            // The stack goes back down as it was: Redeploy moves the unit, not a
            // coin, and the Poison Counter goes with it.
            state.units.insert(action.to, UnitStack { unit, team, seat, coins, poisoned_by });
            log_unit_hex(state, seat, LogKind::Deploy, unit, action.to);
            after_deploy(state, seat, unit, action.to);
        }
        ActionKind::FollowSpy => {
            let target_seat = match step {
                PendingStep::DecreeSpy { target } => target,
                _ => return Err("nobody to spy on"),
            };
            let index = action.arg as usize;
            let target = state.player_mut(target_seat);
            if index >= target.hand.len() {
                return Err("no such coin");
            }
            let coin = target.hand.remove(index);
            target.discard.push(DiscardEntry { coin, face_up: true });
            draw_coins(state, target_seat, 1);
            let mut entry = LogEntry::new(state.round, seat, LogKind::Spy);
            entry.coin = coin.0;
            state.log.push(entry);
        }
        ActionKind::FollowReinforce => {
            let unit = action.unit().ok_or("no such unit")?;
            let me = state.player_mut(seat);
            if me.removed_of(unit) == 0 {
                return Err("nothing removed from play");
            }
            me.removed[unit as usize] -= 1;
            me.supply[unit as usize] += 1;
            log_unit(state, seat, LogKind::Reinforce, unit);
        }
        ActionKind::FollowBolster => {
            let (unit, owner_seat) = match state.units.get(action.from) {
                Some(s) => (s.unit, s.seat),
                None => return Err("nothing to bolster"),
            };
            let owner = state.player_mut(owner_seat);
            if owner.supply_of(unit) == 0 {
                return Err("nothing left in supply");
            }
            owner.supply[unit as usize] -= 1;
            state.units.get_mut(action.from).unwrap().coins += 1;
            log_unit_hex(state, seat, LogKind::Bolster, unit, action.from);
        }
        ActionKind::FollowShove => {
            move_stack(state, action.from, action.to)?;
            let mut entry = LogEntry::new(state.round, seat, LogKind::Shove);
            entry.from = action.from;
            entry.to = action.to;
            state.log.push(entry);
        }
        ActionKind::FollowProclaim => {
            let decree = action.decree().ok_or("no such decree")?;
            let idx =
                state.decrees.iter().position(|d| d.id == decree).ok_or("no such decree")?;
            let team = state.player(seat).team;
            // The Earl proclaims for free: no Seal, and a used Decree still works.
            if let PendingStep::Proclaim { free: false } = step {
                spend_seal(state, team)?;
                state.decrees[idx].add_seal(team);
            }
            start_decree(state, seat, decree);
        }
        ActionKind::FollowBurn => {
            let owner_seat = match step {
                PendingStep::BurnSupply { owner, .. } => owner,
                _ => return Err("nothing to burn"),
            };
            let unit = action.unit().ok_or("no such unit")?;
            let owner = state.player_mut(owner_seat);
            if owner.supply_of(unit) == 0 {
                return Ok(());
            }
            owner.supply[unit as usize] -= 1;
            owner.removed[unit as usize] += 1;
            log_unit(state, seat, LogKind::Burn, unit);
        }
        ActionKind::FollowTactic => {
            if !matches!(step, PendingStep::FreeTactic { .. }) {
                return Err("no tactic is on offer");
            }
            // Paying is the caller's business, and here there is nothing to pay.
            apply_tactic(state, seat, action.as_kind(ActionKind::Tactic).without_coin())?;
        }
        ActionKind::FollowDeceive => {
            let decoy = match step {
                PendingStep::Deceive { decoy } => decoy,
                _ => return Err("nothing to plant"),
            };
            state
                .player_mut(action.arg)
                .discard
                .push(DiscardEntry { coin: decoy, face_up: true });
            log_plain(state, seat, LogKind::Deceive);
        }
        ActionKind::FollowBuildFort => {
            if state.fort_supply == 0 {
                return Err("no fortifications left");
            }
            state.fort_supply -= 1;
            state.forts[action.from as usize] = true;
            let mut entry = LogEntry::new(state.round, seat, LogKind::BuildFort);
            entry.hex = action.from;
            state.log.push(entry);
        }
        ActionKind::FollowAbsorb => {
            let target = match step {
                PendingStep::AbsorbHit { target, .. } => target,
                _ => return Err("nothing to absorb"),
            };
            let stack = match state.units.get(target) {
                Some(s) => *s,
                None => return Ok(()),
            };
            match action.arg {
                x if x == AbsorbSource::Supply as u8 => {
                    let owner = state.player_mut(stack.seat);
                    if owner.supply_of(stack.unit) == 0 {
                        return Err("nothing left in supply");
                    }
                    owner.supply[stack.unit as usize] -= 1;
                    owner.removed[stack.unit as usize] += 1;
                    log_unit(state, stack.seat, LogKind::Absorb, stack.unit);
                }
                x if x == AbsorbSource::Wagon as u8 => {
                    if action.from == NONE {
                        return Err("which wagon?");
                    }
                    remove_coins(state, action.from, 1);
                    log_plain(state, stack.seat, LogKind::AbsorbWagon);
                }
                _ => {
                    // The Skirmisher slips a Decoy Coin into an opponent's
                    // discards, and the blow lands on that instead of the unit.
                    let decoy = decoy_of(stack.unit);
                    let foe = state.players.iter().position(|p| p.team != stack.team);
                    if let (Some(decoy), Some(foe)) = (decoy, foe) {
                        state.players[foe].discard.push(DiscardEntry { coin: decoy, face_up: true });
                    }
                    log_plain(state, stack.seat, LogKind::Deceive);
                }
            }
        }
        ActionKind::FollowRepeat => {
            discard_from_stack(state, action.from)?;
            let mut entry = LogEntry::new(state.round, seat, LogKind::BerserkerRepeat);
            entry.hex = action.from;
            state.log.push(entry);
            if state.units.occupied(action.from) {
                state.pending.push(PendingStep::ManeuverUnit {
                    hex: action.from,
                    source: StepSource::Berserker,
                    optional: false,
                });
            }
        }
        _ => return Err("not a follow-up action"),
    }
    Ok(())
}

/// Whether the action is checked against the legal list first.
///
/// The server must never turn this off: it is what stands between a crafted
/// WebSocket message and the game state. A search turns it off, because it just
/// generated the action from `legal_actions` itself.
#[derive(Copy, Clone, PartialEq, Eq)]
pub enum Validate {
    Yes,
    No,
}

pub fn apply_action(
    state: &mut GameState,
    seat: Seat,
    action: Action,
    validate: Validate,
) -> EngineResult {
    if state.phase == Phase::Finished {
        return Err("game is over");
    }
    let owner = state
        .pending
        .last()
        .and_then(PendingStep::answering_seat)
        .unwrap_or(state.turn);
    if owner != seat {
        return Err("not your turn");
    }

    if validate == Validate::Yes {
        let mut legal_list = Vec::with_capacity(64);
        legal_actions(state, seat, &mut legal_list);
        if !legal_list.contains(&action) {
            return Err("illegal action");
        }
    }

    match action.kind {
        ActionKind::Ban => return apply_ban(state, seat, action.unit().ok_or("no such unit")?),
        ActionKind::Draft => {
            return apply_draft_pick(state, seat, action.unit().ok_or("no such unit")?)
        }
        _ => {}
    }

    if action.is_coin_action() {
        // A coin played to satisfy `mustUseCoin` clears that step first, so any
        // new steps the action creates land on the stack in the right order.
        if matches!(state.pending.last(), Some(PendingStep::MustUseCoin { .. })) {
            state.pending.pop();
        }
        apply_coin_action(state, seat, action)?;
    } else {
        apply_follow_up(state, seat, action)?;
    }

    end_turn_if_done(state);
    Ok(())
}

fn end_turn_if_done(state: &mut GameState) {
    if state.phase != Phase::Playing {
        return;
    }
    if !state.pending.is_empty() {
        return;
    }

    let n = state.players.len();
    if state.players.iter().all(|p| p.hand.is_empty()) {
        start_round(state);
        // If nobody could draw anything, no one can ever act again — a draw.
        if state.players.iter().all(|p| p.hand.is_empty()) {
            state.phase = Phase::Finished;
            state.winner = None;
            log_plain(state, state.turn, LogKind::Stalemate);
        }
        return;
    }
    for i in 1..=n {
        let cand = (state.turn as usize + i) % n;
        if !state.players[cand].hand.is_empty() {
            state.turn = cand as Seat;
            return;
        }
    }
}

/// The hand size the engine deals to, re-exported as `engine.ts` does.
pub const HAND: usize = HAND_SIZE;

/// A convenience for tests and the playout harness.
pub fn legal_moves(state: &GameState) -> Vec<Action> {
    if state.is_terminal() {
        return Vec::new();
    }
    legal(state, state.acting_seat())
}

/// The rng, exposed so the playout harness can thread its own.
pub fn rng_of(state: &GameState) -> Rng {
    state.rng
}
