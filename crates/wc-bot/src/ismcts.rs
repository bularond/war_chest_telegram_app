//! Information Set Monte Carlo Tree Search.
//!
//! The problem MCTS alone cannot handle here: the bot does not know the order of
//! either bag, so it cannot build a tree over states. ISMCTS builds the tree over
//! *information sets* instead — the nodes are "what the player to move knows" —
//! and draws a fresh guess at the hidden coins on every iteration. Over many
//! iterations the guesses average out, and the tree ends up scoring moves rather
//! than luck.
//!
//! One iteration:
//!   1. sample a determinization consistent with everything we can see
//!   2. walk the tree, choosing by UCB among the moves legal in *this* sample
//!   3. add one new node
//!   4. play on with the heuristic for a dozen plies
//!   5. score the position with `evaluate`
//!   6. carry the score back up the path
//!
//! Two details that are what make it ISMCTS rather than MCTS with extra steps:
//!
//! - **Availability, not parent visits.** A move that is only legal in some
//!   determinizations must not be punished for the iterations it sat out, so a
//!   child's exploration term counts how often it was *available*, not how often
//!   its parent was visited (Cowling, Powley & Whitehouse, 2012).
//! - **The tree survives, the sample does not.** The tree is shared across
//!   iterations; the determinization is thrown away at the end of each.
//!
//! **What an iteration allocates: nothing.** The tree arena, the state the
//! determinization is dealt into, every legal-move buffer and every scratch
//! array the heuristic uses live on [`Searcher`] and are reused. That is the
//! whole reason this file looks the way it does — the TypeScript original made
//! roughly fifteen full copies of the state per iteration, a dozen of them in
//! the rollout alone.

use crate::eval::{base_weights, evaluate, EvalWeights};
use crate::heuristic::{Heuristic, HeuristicWeights};
use wc_core::engine::{apply_action, Validate};
use wc_core::observe::{empty_state, Determinizer};
use wc_core::rng::Rng;
use wc_core::state::{legal_moves_into, move_key};
use wc_core::types::*;
use wc_core::units::CoinId;
use wc_core::view::GameView;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub struct SearchSettings {
    /// Iterations when no time budget is given. Keeps tests reproducible.
    pub iterations: u32,
    /// Plies of policy play before the position is scored.
    pub rollout_depth: u32,
    /// UCB exploration constant, against values in [-1, 1].
    ///
    /// 0.9 was chosen by eye when the search was written and never measured;
    /// 0.45 beat it 55.9% over 490 games (+41 Elo), and the reverse check after
    /// the search got three times faster confirmed it the other way round. Less
    /// exploring suits a search that gets more iterations, which is the opposite
    /// of what one might guess.
    pub exploration: f64,
    /// What an available move nobody has tried yet is worth, before anyone tries
    /// it. Infinity means "try every move once before revisiting any".
    ///
    /// That default was assumed expensive here, on a branching factor taken from
    /// nothing in particular. Measured, it is **19** at the root, and a medium
    /// budget buys 1500 iterations — 78 per legal move. There is no width crisis
    /// to solve, which is the answer to why five attempts at first-play urgency
    /// ranged from "no effect" to −517 Elo and none ever helped: the technique
    /// is for a search starving for depth, and this one is not. Kept at infinity
    /// with its number beside it, so it is not rediscovered a sixth time.
    pub first_play: f64,
    /// Roll out until the side to move is the side that moved at the root.
    ///
    /// Without it, a leaf is whatever the fixed depth landed on, and whose turn
    /// it is there depends on how long the tree descent was — so every feature
    /// that reads differently for the two sides carries a bias by branch depth
    /// rather than by position.
    pub level_leaves: bool,
    pub weights: EvalWeights,
    /// How often the rollout ignores its policy and plays at random instead.
    ///
    /// The rollout is nearly deterministic: the heuristic keeps its best drawer
    /// and draws inside it, so two rollouts from the same leaf tend to play the
    /// same game and their average converges to the value of *that one line*.
    /// More iterations do not fix a bias; they only measure it more precisely.
    ///
    /// The size of it is the point. Fifteen per cent of plies played at random
    /// pays (642 games, 55.6%, +39 Elo, confirmed from the other side); replacing
    /// the priority lists wholesale costs 202 Elo. The optimum is narrow and
    /// sits near zero.
    pub rollout_noise: f64,
    /// Name an edge by the coin's *unit* rather than by the slot it sits in, and
    /// tell the two meanings of `skip` apart. See `move_key`.
    ///
    /// Measured, and it showed nothing: 48.5% over 454 games, an interval of
    /// −42 to +22 Elo. On by default anyway, because a search that cannot tell a
    /// move from itself is wrong whatever the scoreboard says — 2.1 edges per
    /// distinct move means UCB computing its exploration term on a third of the
    /// evidence.
    pub unit_keys: bool,
    /// Iterations between clock checks. Reading the clock is not free and the
    /// answer cannot change much in a handful of iterations.
    pub check_every: u32,
    /// The policy that plays the rollout out. Cheap beats clever, up to a point.
    pub rollout: HeuristicWeights,
    /// Who drafts. The search has no rollout worth running before the bags
    /// exist, so the opening is somebody else's problem — but *whose* is a
    /// setting, not a constant.
    pub draft: HeuristicWeights,
}

impl Default for SearchSettings {
    fn default() -> SearchSettings {
        SearchSettings {
            iterations: 1500,
            rollout_depth: 12,
            exploration: 0.45,
            first_play: f64::INFINITY,
            level_leaves: false,
            weights: base_weights(),
            rollout_noise: 0.15,
            unit_keys: true,
            check_every: 32,
            rollout: HeuristicWeights::default(),
            draft: HeuristicWeights::default(),
        }
    }
}

#[derive(Copy, Clone, Debug, Default)]
pub struct Budget {
    /// Wall-clock allowance in milliseconds.
    pub ms: Option<u64>,
    /// Search iterations, for reproducible runs where time would vary.
    pub iterations: Option<u32>,
}

// ---------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------

const NO_NODE: u32 = u32::MAX;

#[derive(Copy, Clone)]
struct EdgeStat {
    action: Action,
    visits: u32,
    /// Summed score from the point of view of the seat that chose this edge.
    value: f64,
    /// Iterations in which this move was legal at all.
    availability: u32,
    child: u32,
}

/// A point in the tree.
///
/// It carries no seat: who owes the decision here depends on the
/// determinization, not on the node — an attack leads to a step the defender
/// answers only when the defender holds something to answer with, and what they
/// hold is exactly what the search is guessing at.
///
/// Keys sit in an array of their own because the descent scans them and reads
/// nothing else: forty `u64`s are five cache lines, where forty edges would be
/// forty.
#[derive(Default)]
struct Node {
    keys: Vec<u64>,
    edges: Vec<EdgeStat>,
    visits: u32,
}

impl Node {
    fn reset(&mut self) {
        self.keys.clear();
        self.edges.clear();
        self.visits = 0;
    }

    #[inline]
    fn find(&self, key: u64) -> Option<usize> {
        self.keys.iter().position(|k| *k == key)
    }
}

/// What one root move was worth, and how much of the budget went into it.
#[derive(Copy, Clone, Debug)]
pub struct RootStat {
    pub action: Action,
    /// `move_key`, so two searches of the same position agree on what to add up.
    pub key: u64,
    pub visits: u32,
    /// Summed score, not averaged: sums are what merge across searches.
    pub value: f64,
}

#[derive(Clone, Debug)]
pub struct SearchReport {
    pub action: Action,
    pub iterations: u32,
    pub visits: u32,
    /// Score of the chosen move, in [-1, 1], from the searching seat's side.
    pub value: f64,
    /// Every root move the search looked at.
    pub roots: Vec<RootStat>,
}

/// Several searches of one position, read as one.
///
/// Visits and summed values add. The move chosen is the most visited overall,
/// which is the same rule one search uses and for the same reason: a high
/// average over two visits is noise.
///
/// **Independent searches are worth far less than one search of the same total
/// size, and here the discount is brutal.** Measured over 80 positions against a
/// 40 000-iteration yardstick: eight trees of 1000 iterations are worth about
/// 1167 iterations in one tree. Fifteen per cent, where the literature reports
/// half to two thirds. Three ways of reading the trees were tried — adding up
/// the visits, a majority vote, the mean score per move — and all three agreed
/// with the yardstick on exactly the same 66.3% of positions. The rule is not
/// what fails.
///
/// The reason is worth more than the number. Averaging eight independent
/// estimates should cut the spread by √8; it cut almost nothing. So what the
/// trees carry is not noise but *bias* — they share an evaluation and a rollout
/// policy, they make the same mistake, and adding up the same mistake eight
/// times changes nothing. It is the same finding as «the rollout cannot be
/// removed» arriving from the other side: what binds this search is the value at
/// the leaf.
///
/// A caller may hand in fewer searches than it asked for: one that missed its
/// deadline is dropped and the rest still answer.
pub fn merge_reports(searches: &[Vec<RootStat>]) -> Vec<RootStat> {
    let mut total: Vec<RootStat> = Vec::new();
    for roots in searches {
        for root in roots {
            match total.iter_mut().find(|r| r.key == root.key) {
                Some(seen) => {
                    seen.visits += root.visits;
                    seen.value += root.value;
                }
                None => total.push(*root),
            }
        }
    }
    total
}

/// The move a merged search settles on: the most visited, as one search does.
pub fn best_of(roots: &[RootStat]) -> Option<RootStat> {
    roots.iter().copied().reduce(|a, b| if b.visits > a.visits { b } else { a })
}

// ---------------------------------------------------------------------------
// The searcher
// ---------------------------------------------------------------------------

/// Everything one search thread owns. Built once and reused for every move it is
/// ever asked about, so the arena and the scratch keep their capacity.
pub struct Searcher {
    pub settings: SearchSettings,
    nodes: Vec<Node>,
    used: usize,
    heuristic: Heuristic,
    drafter: Heuristic,
    state: GameState,
    legal: Vec<Action>,
    seen: Vec<u64>,
    known: Vec<u32>,
    offered: Vec<Action>,
    fresh: Vec<Action>,
    path: Vec<(u32, usize, Seat)>,
    distinct: Vec<Action>,
    hand: Vec<CoinId>,
}

impl Searcher {
    pub fn new(settings: SearchSettings) -> Searcher {
        let rollout = settings.rollout;
        let draft = settings.draft;
        Searcher {
            settings,
            nodes: Vec::with_capacity(4096),
            used: 0,
            heuristic: Heuristic::new(rollout),
            drafter: Heuristic::new(draft),
            state: blank_state(),
            legal: Vec::with_capacity(128),
            seen: Vec::with_capacity(128),
            known: Vec::with_capacity(128),
            offered: Vec::with_capacity(128),
            fresh: Vec::with_capacity(128),
            path: Vec::with_capacity(64),
            distinct: Vec::with_capacity(128),
            hand: Vec::with_capacity(8),
        }
    }

    fn alloc_node(&mut self) -> u32 {
        if self.used == self.nodes.len() {
            self.nodes.push(Node::default());
        } else {
            self.nodes[self.used].reset();
        }
        let index = self.used;
        self.used += 1;
        index as u32
    }

    /// One of `view.legal`, chosen. The whole entry point.
    pub fn choose(&mut self, view: &GameView, budget: Budget, rng: &mut Rng) -> Action {
        if view.legal.len() == 1 {
            return view.legal[0];
        }
        // Drafting is a different problem with its own literature; the search
        // has no rollout worth running before the bags exist.
        if matches!(view.phase, Phase::Draft | Phase::Ban) {
            let legal = view.legal.clone();
            return self.drafter.choose(view, view.you, view.phase, &legal, None, rng);
        }
        match self.run(view, budget, rng) {
            Ok(report) => report.action,
            // A view a determinization cannot be built from is a bug, but a bot
            // that stops playing is a worse one: fall back on the policy.
            Err(_) => {
                let legal = view.legal.clone();
                let hand = view.players[view.you as usize].hand.clone().unwrap_or_default();
                self.heuristic.choose(view, view.you, view.phase, &legal, Some(&hand), rng)
            }
        }
    }

    /// The search proper. Exposed for the arena and for tests that want counts.
    pub fn run(
        &mut self,
        view: &GameView,
        budget: Budget,
        rng: &mut Rng,
    ) -> Result<SearchReport, String> {
        self.used = 0;
        let root = self.alloc_node();
        let mut determinizer = Determinizer::new(view)?;

        let cap = if budget.ms.is_some() {
            u32::MAX
        } else {
            budget.iterations.unwrap_or(self.settings.iterations)
        };
        let deadline = deadline_from(budget.ms);

        let mut iterations = 0u32;
        while iterations < cap {
            if iterations % self.settings.check_every == 0 && past(deadline) {
                break;
            }
            self.iterate(root, view, &mut determinizer, rng)?;
            iterations += 1;
        }

        // The most visited move, not the highest scoring one: a high average
        // over two visits is noise, and the visit count is what the search
        // actually trusted.
        let node = &self.nodes[root as usize];
        let mut roots = Vec::with_capacity(node.edges.len());
        let mut best: Option<&EdgeStat> = None;
        for (i, edge) in node.edges.iter().enumerate() {
            roots.push(RootStat {
                action: edge.action,
                key: node.keys[i],
                visits: edge.visits,
                value: edge.value,
            });
            if best.map_or(true, |b| edge.visits > b.visits) {
                best = Some(edge);
            }
        }
        let best = best.ok_or("search found no move")?;
        Ok(SearchReport {
            action: best.action,
            iterations,
            visits: best.visits,
            value: if best.visits == 0 { 0.0 } else { best.value / best.visits as f64 },
            roots,
        })
    }

    /// The search never copies a state.
    ///
    /// The determinization it starts from is dealt into one buffer, nothing else
    /// holds a reference to it, and the tree stores actions rather than
    /// positions. So the whole descent and the rollout run on that one object.
    fn iterate(
        &mut self,
        root: u32,
        view: &GameView,
        determinizer: &mut Determinizer,
        rng: &mut Rng,
    ) -> Result<(), String> {
        determinizer.sample_into(&mut self.state, rng)?;
        self.path.clear();
        let mut node = root;

        // ── walk down, adding at most one node ───────────────────────────────
        loop {
            if self.state.is_terminal() {
                break;
            }
            legal_moves_into(&self.state, &mut self.legal);
            if self.legal.is_empty() {
                break;
            }

            // Who owes the decision *here, in this determinization*. Not a label
            // written when the node was first created, from whatever sample
            // happened to reach it first: an attack leads to a step the defender
            // answers only when the defender has something to answer with, and
            // what they hold is exactly what the search is guessing at.
            let acting = self.state.acting_seat();
            self.hand.clear();
            if self.settings.unit_keys {
                self.hand.extend_from_slice(&self.state.players[acting as usize].hand);
            }

            // The edges already in the tree, each paired with the action *as
            // this sample offers it*. The pairing is what makes a merged key
            // safe: an edge stores the action it was created with, and that
            // action names a coin by a slot that now holds something else.
            self.known.clear();
            self.offered.clear();
            self.fresh.clear();
            self.seen.clear();
            {
                let tree = &self.nodes[node as usize];
                for action in &self.legal {
                    let key = self.name(*action, acting);
                    if self.seen.contains(&key) {
                        continue; // two coins of one unit make one move
                    }
                    self.seen.push(key);
                    match tree.find(key) {
                        Some(i) => {
                            self.known.push(i as u32);
                            self.offered.push(*action);
                        }
                        None => self.fresh.push(*action),
                    }
                }
            }
            for i in &self.known {
                self.nodes[node as usize].edges[*i as usize].availability += 1;
            }

            // Widen or read on? An untried move is worth `first_play` plus what
            // any once-looked-at move gets for being barely looked at — the same
            // currency the known moves are priced in, which is the whole point.
            // Two earlier formulations compared the bare threshold against
            // something that already carried a bonus, and both turned into step
            // functions: no pruning above the threshold, total collapse below.
            //
            // The threshold is read without touching `rng`: the selection breaks
            // ties by drawing, so asking it before it is known whether a move is
            // even being chosen would pull a number out of the stream and change
            // every game that follows.
            let exploration = self.settings.exploration;
            let urgency = if self.settings.first_play.is_infinite() {
                f64::INFINITY
            } else {
                let visits = self.nodes[node as usize].visits.max(2) as f64;
                self.settings.first_play + exploration * visits.ln().sqrt()
            };
            let best_known = {
                let tree = &self.nodes[node as usize];
                self.known
                    .iter()
                    .map(|i| ucb(&tree.edges[*i as usize], exploration))
                    .fold(f64::NEG_INFINITY, f64::max)
            };

            if !self.fresh.is_empty() && urgency >= best_known {
                let action = self.fresh[rng.next_int(self.fresh.len())];
                let key = self.name(action, acting);
                let tree = &mut self.nodes[node as usize];
                let slot = tree.edges.len();
                tree.keys.push(key);
                tree.edges.push(EdgeStat {
                    action,
                    visits: 0,
                    value: 0.0,
                    availability: 1,
                    child: NO_NODE,
                });
                self.path.push((node, slot, acting));
                apply_action(&mut self.state, acting, action, Validate::No)?;
                break;
            }
            if self.known.is_empty() {
                break;
            }

            let chosen = select_by_ucb(&self.nodes[node as usize], &self.known, exploration, rng)?;
            let slot = self.known[chosen] as usize;
            self.path.push((node, slot, acting));
            let action = self.offered[chosen];
            apply_action(&mut self.state, acting, action, Validate::No)?;

            let child = {
                let tree = &mut self.nodes[node as usize];
                tree.edges[slot].child
            };
            let child = if child == NO_NODE {
                let fresh = self.alloc_node();
                self.nodes[node as usize].edges[slot].child = fresh;
                fresh
            } else {
                child
            };
            node = child;
            self.nodes[node as usize].visits += 1;
        }

        // ── play on, then score what we ended up with ────────────────────────
        self.rollout(rng)?;
        if self.settings.level_leaves {
            self.level_off(view, rng)?;
        }
        let score = evaluate(&self.state, view.you, &self.settings.weights);

        // ── carry it back ────────────────────────────────────────────────────
        self.nodes[root as usize].visits += 1;
        let my_team = view.players[view.you as usize].team;
        for (node, slot, seat) in &self.path {
            let edge = &mut self.nodes[*node as usize].edges[*slot];
            edge.visits += 1;
            // The score is written from our side of the table, so an edge chosen
            // by the other side takes the negative of it. Teams, not seats: in a
            // four-player game a partner's good move is our good move too. And
            // the seat is the one that took the edge in *this* sample.
            let theirs = self.state.players.get(*seat as usize).map(|p| p.team);
            edge.value += if theirs == Some(my_team) { score } else { -score };
        }
        Ok(())
    }

    #[inline]
    fn name(&self, action: Action, _acting: Seat) -> u64 {
        if self.settings.unit_keys {
            move_key(action, Some(&self.hand), Some(&self.state.pending))
        } else {
            // Without unit keys the slot is the name, exactly as `actionKey` was.
            move_key(action, None, None)
        }
    }

    /// Play on with the heuristic, but not to the end: a War Chest game runs for
    /// hundreds of plies, and a full rollout would be both slow and mostly noise.
    fn rollout(&mut self, rng: &mut Rng) -> Result<(), String> {
        for _ in 0..self.settings.rollout_depth {
            if self.state.is_terminal() {
                break;
            }
            let seat = self.state.acting_seat();
            legal_moves_into(&self.state, &mut self.legal);
            if self.legal.is_empty() {
                break;
            }
            // No noise means no draw. A search with the knob at zero has to play
            // the game it played before the knob existed, down to the visit —
            // otherwise every reproducible match becomes incomparable with every
            // one already recorded.
            let action = if self.settings.rollout_noise > 0.0
                && rng.next_float() < self.settings.rollout_noise
            {
                self.draw_uniformly(seat, rng)
            } else {
                let phase = self.state.phase;
                self.hand.clear();
                self.hand.extend_from_slice(&self.state.players[seat as usize].hand);
                self.heuristic.choose(
                    &self.state,
                    seat,
                    phase,
                    &self.legal,
                    Some(&self.hand),
                    rng,
                )
            };
            apply_action(&mut self.state, seat, action, Validate::No)?;
        }
        Ok(())
    }

    /// A move drawn at random — over the *moves*, not over the entries in the
    /// legal list. The list holds one entry per hand slot, so a move a player
    /// can pay for with either of two identical coins sits in it twice and a
    /// draw over the list picks it twice as often. That is not noise, it is a
    /// preference for moves the player happens to hold spare change for.
    fn draw_uniformly(&mut self, seat: Seat, rng: &mut Rng) -> Action {
        if !self.settings.unit_keys {
            return self.legal[rng.next_int(self.legal.len())];
        }
        self.hand.clear();
        self.hand.extend_from_slice(&self.state.players[seat as usize].hand);
        self.distinct.clear();
        self.seen.clear();
        for action in &self.legal {
            let key = move_key(*action, Some(&self.hand), Some(&self.state.pending));
            if self.seen.contains(&key) {
                continue;
            }
            self.seen.push(key);
            self.distinct.push(*action);
        }
        self.distinct[rng.next_int(self.distinct.len())]
    }

    /// Plays on until the root's side is to move again, so that leaves are
    /// comparable with each other. Four plies at most: a position where the turn
    /// does not come back round that soon is one where something else is wrong,
    /// and an uneven leaf is better than an unbounded rollout.
    fn level_off(&mut self, view: &GameView, rng: &mut Rng) -> Result<(), String> {
        let want = view.players[view.acting as usize].team;
        for _ in 0..4 {
            if self.state.is_terminal() {
                return Ok(());
            }
            let seat = self.state.acting_seat();
            if self.state.players[seat as usize].team == want {
                return Ok(());
            }
            legal_moves_into(&self.state, &mut self.legal);
            if self.legal.is_empty() {
                return Ok(());
            }
            let phase = self.state.phase;
            self.hand.clear();
            self.hand.extend_from_slice(&self.state.players[seat as usize].hand);
            let action =
                self.heuristic.choose(&self.state, seat, phase, &self.legal, Some(&self.hand), rng);
            apply_action(&mut self.state, seat, action, Validate::No)?;
        }
        Ok(())
    }
}

/// A move's UCB score: what it has been worth, plus what is still unknown.
#[inline]
fn ucb(edge: &EdgeStat, exploration: f64) -> f64 {
    if edge.visits == 0 {
        return f64::INFINITY;
    }
    edge.value / edge.visits as f64
        + exploration * ((edge.availability as f64).ln() / edge.visits as f64).sqrt()
}

/// The index into `known` of the chosen edge, so the caller can reach its
/// parallel action.
fn select_by_ucb(
    node: &Node,
    known: &[u32],
    exploration: f64,
    rng: &mut Rng,
) -> Result<usize, String> {
    let mut best: isize = -1;
    let mut best_score = f64::NEG_INFINITY;
    let mut ties = 0usize;
    for (i, slot) in known.iter().enumerate() {
        let score = ucb(&node.edges[*slot as usize], exploration);
        if score > best_score {
            best_score = score;
            best = i as isize;
            ties = 1;
        } else if score == best_score {
            // Reservoir sampling, so equal moves are not decided by iteration order.
            ties += 1;
            if rng.next_int(ties) == 0 {
                best = i as isize;
            }
        }
    }
    if best < 0 {
        // Every comparison against NaN is false, so a single non-finite score
        // leaves nothing chosen. It means the evaluation returned NaN, which in
        // practice means a weights file with a missing or non-numeric field.
        return Err("no move could be chosen: the evaluation is not a number — check the weights"
            .into());
    }
    Ok(best as usize)
}

fn blank_state() -> GameState {
    use std::sync::Arc;
    let view = GameView {
        id: Arc::from(""),
        size: wc_core::board::BoardSize::Duel,
        phase: Phase::Playing,
        round: 0,
        turn: 0,
        acting: 0,
        you: 0,
        players: Default::default(),
        seats: Arc::new(Vec::new()),
        units: Board::new(),
        control: [NO_SEAT; wc_core::board::HEX_COUNT],
        pending: Vec::new(),
        initiative_moved_this_round: false,
        decrees: Default::default(),
        forts: [false; wc_core::board::HEX_COUNT],
        fort_supply: 0,
        draft_mode: DraftMode::Draft,
        sets: wc_core::units::SetMask::base(),
        draft_pool: Vec::new(),
        banned: Vec::new(),
        last_maneuver: [[0; wc_core::units::UNIT_COUNT]; MAX_SEATS],
        log_length: 0,
        log: Vec::new(),
        winner: None,
        legal: Vec::new(),
    };
    empty_state(&view)
}

// ---------------------------------------------------------------------------
// The clock
// ---------------------------------------------------------------------------

#[cfg(not(target_arch = "wasm32"))]
type Deadline = Option<std::time::Instant>;
#[cfg(target_arch = "wasm32")]
type Deadline = Option<()>;

#[cfg(not(target_arch = "wasm32"))]
fn deadline_from(ms: Option<u64>) -> Deadline {
    ms.map(|ms| std::time::Instant::now() + std::time::Duration::from_millis(ms))
}

/// A browser has no monotonic clock this side of the boundary, so a wasm build
/// takes its budget in iterations and nothing else.
#[cfg(target_arch = "wasm32")]
fn deadline_from(_ms: Option<u64>) -> Deadline {
    None
}

#[cfg(not(target_arch = "wasm32"))]
#[inline]
fn past(deadline: Deadline) -> bool {
    match deadline {
        Some(at) => std::time::Instant::now() >= at,
        None => false,
    }
}

#[cfg(target_arch = "wasm32")]
#[inline]
fn past(_deadline: Deadline) -> bool {
    false
}
