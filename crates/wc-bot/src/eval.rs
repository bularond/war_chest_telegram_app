//! How good a position is, as one number in [-1, 1].
//!
//! A rollout that stops after a dozen plies has to be told what it is looking
//! at, and this is that. Search quality is bounded by this function: an
//! evaluation that misreads a position will have the search work hard to reach
//! it.
//!
//! **The weights are data, not code.** They are a plain record, versioned, and
//! written into the log of every game the bot plays, so a win rate can be traced
//! back to the numbers that produced it. Nothing is added here on the strength
//! of an argument; each feature is admitted only by a measured match, and a
//! feature that has not won one weighs zero.

use crate::board_sense::{Steps, Sweeper};
use crate::unit_worth::unit_worth;
use arrayvec::ArrayVec;
use serde_json::{json, Value};
use wc_core::board::{board_for, HexIdx, DIST};
use wc_core::engine::deploy_targets;
use wc_core::types::*;
use wc_core::units::*;

/// The order of [`feature_vector`], and the weight each coordinate belongs to.
///
/// Appended to rather than reordered: this is the layout of every fitted vector
/// already on disk, and a new coordinate in the middle would silently
/// reinterpret all of them.
pub const FEATURES: [&str; 19] = [
    "markers",
    "material",
    "scarcity",
    "reach",
    "reserve",
    "bolster",
    "proximity",
    "initiative",
    "tempo",
    "hand",
    "threat",
    "deadWeight",
    "idleHand",
    "worth",
    "circulation",
    "traded",
    "approach",
    "proximityWalk",
    "attrition",
];

pub const FEATURE_COUNT: usize = FEATURES.len();

#[derive(Clone, Debug, PartialEq)]
pub struct EvalWeights {
    /// Bumped whenever a number below changes. Written into the game log.
    pub version: String,
    /// One coordinate per entry of [`FEATURES`], in that order.
    pub w: [f64; FEATURE_COUNT],
}

/// Indices into [`EvalWeights::w`], so a feature is named rather than counted.
pub mod f {
    pub const MARKERS: usize = 0;
    pub const MATERIAL: usize = 1;
    pub const SCARCITY: usize = 2;
    pub const REACH: usize = 3;
    pub const RESERVE: usize = 4;
    pub const BOLSTER: usize = 5;
    pub const PROXIMITY: usize = 6;
    pub const INITIATIVE: usize = 7;
    pub const TEMPO: usize = 8;
    pub const HAND: usize = 9;
    pub const THREAT: usize = 10;
    pub const DEAD_WEIGHT: usize = 11;
    pub const IDLE_HAND: usize = 12;
    pub const WORTH: usize = 13;
    pub const CIRCULATION: usize = 14;
    pub const TRADED: usize = 15;
    pub const APPROACH: usize = 16;
    pub const PROXIMITY_WALK: usize = 17;
    pub const ATTRITION: usize = 18;
}

impl EvalWeights {
    #[inline]
    pub fn get(&self, feature: usize) -> f64 {
        self.w[feature]
    }

    pub fn to_json(&self) -> Value {
        let mut map = serde_json::Map::new();
        map.insert("version".into(), json!(self.version));
        for (i, name) in FEATURES.iter().enumerate() {
            map.insert((*name).into(), json!(self.w[i]));
        }
        Value::Object(map)
    }

    /// Weights arrive from files written by earlier versions, which have no key
    /// for a feature that did not exist yet. A missing weight is a zero — and
    /// every reader has to say so, because `undefined` leaking into the sum was
    /// how a whole evaluation once came back as `NaN`, twenty iterations before
    /// anybody noticed.
    pub fn from_json(v: &Value) -> EvalWeights {
        let mut w = [0.0; FEATURE_COUNT];
        for (i, name) in FEATURES.iter().enumerate() {
            w[i] = v.get(*name).and_then(Value::as_f64).unwrap_or(0.0);
        }
        EvalWeights {
            version: v.get("version").and_then(Value::as_str).unwrap_or("eval@?").to_string(),
            w,
        }
    }
}

/// The shipping set. Every non-zero here won a match; every zero is either a
/// verdict or a feature nobody has tried.
pub fn base_weights() -> EvalWeights {
    let mut w = [0.0; FEATURE_COUNT];
    // The anchor: the only thing that ends the game. Coordinate descent scales
    // the others against it, because the overall scale of the sum is swallowed
    // by `tanh` and only ratios mean anything.
    w[f::MARKERS] = 1.0;
    // Doubled by coordinate descent and confirmed on fresh seeds: 1120 games,
    // 55.2% [52.3 … 58.1], +36 Elo.
    w[f::MATERIAL] = 0.7;
    // 0.15 for months, and undervalued the whole time. Four independent fits put
    // it between 0.21 and 0.55; the match settled it at 0.48 — 638 games, 55.2%.
    w[f::RESERVE] = 0.48;
    // 424 games, 56.4%, about +45 Elo, and the reversal on fresh seeds scored
    // 20.0% over 30 — the fastest verdict this project has produced.
    w[f::APPROACH] = 0.41;
    // 468 games, 56.2%, +43 Elo. Switching it back off on fresh seeds cost 38
    // Elo, and twice the weight was worse than none of it — a point, not a
    // plateau.
    w[f::IDLE_HAND] = 0.06;
    EvalWeights { version: "eval@5".into(), w }
}

/// Positive is good for `seat`. Clipped into [-1, 1] by `tanh`.
pub fn evaluate(state: &GameState, seat: Seat, weights: &EvalWeights) -> f64 {
    let me = match state.players.get(seat as usize) {
        Some(p) => p,
        None => return 0.0,
    };
    if state.phase == Phase::Finished {
        return match state.winner {
            None => 0.0,
            Some(team) => {
                if team == me.team {
                    1.0
                } else {
                    -1.0
                }
            }
        };
    }

    let board = board_for(state.size);
    let my_team = me.team;
    let foe_team = state.other_team(my_team);

    // Markers: how many each side has *placed*, since that is what wins.
    let placed = |team: Team| board.control_markers as f64 - state.markers_remaining(team) as f64;
    let markers = (placed(my_team) - placed(foe_team)) / board.control_markers as f64;

    let by_type = weights.get(f::SCARCITY) != 0.0 || weights.get(f::REACH) != 0.0;
    let mut mine = 0.0;
    let mut theirs = 0.0;
    let mut on_board = 0.0;
    for (_, stack) in state.units.iter() {
        // Coins are the bulk of it: a bolstered stack takes two hits, not one.
        // The type rides on top as a multiplier, so a scarce unit is worth more
        // per coin rather than worth something regardless of what is under it.
        let worth = if by_type {
            stack.coins as f64 * multiplier(stack.unit, weights)
        } else {
            stack.coins as f64
        };
        if stack.team == my_team {
            mine += worth;
        } else {
            theirs += worth;
        }
        on_board += stack.coins as f64;
    }
    // Divided by the plain coin count, never by the weighted one: the size of
    // the pile on the table is a fact about the position, and it should not move
    // because we changed our mind about what a Knight is worth. It also keeps
    // the sum linear in the weights, which is what lets `feature_vector` exist.
    let material = if on_board == 0.0 { 0.0 } else { (mine - theirs) / on_board };

    let mut my_reserve = 0.0;
    let mut their_reserve = 0.0;
    for p in &state.players {
        let coins = (p.bag.len() + p.hand.len() + p.discard.len()) as f64
            + p.supply_total() as f64;
        if p.team == my_team {
            my_reserve += coins;
        } else {
            their_reserve += coins;
        }
    }
    let pool = my_reserve + their_reserve;
    let reserve = if pool == 0.0 { 0.0 } else { (my_reserve - their_reserve) / pool };

    let mut score = weights.get(f::MARKERS) * markers
        + weights.get(f::MATERIAL) * material
        + weights.get(f::RESERVE) * reserve;

    if weights.get(f::BOLSTER) != 0.0 {
        // Coins above the first on each stack. Bolstering trades width for
        // depth: fewer places at once, but harder to remove from any of them.
        let mut deep = 0.0;
        let mut their_deep = 0.0;
        for (_, stack) in state.units.iter() {
            let extra = (stack.coins - 1) as f64;
            if stack.team == my_team {
                deep += extra;
            } else {
                their_deep += extra;
            }
        }
        let stacked = deep + their_deep;
        score += weights.get(f::BOLSTER)
            * if stacked == 0.0 { 0.0 } else { (deep - their_deep) / stacked };
    }

    if weights.get(f::PROXIMITY) != 0.0 {
        // Closeness to the locations we do not hold: a unit two hexes from a
        // free location is worth more than the same unit idling behind the line.
        let open = open_locations(state, my_team);
        score += weights.get(f::PROXIMITY)
            * (closeness(state, my_team, &open) - closeness(state, foe_team, &open));
    }

    if weights.get(f::APPROACH) != 0.0 {
        // Two target lists, one per side. `proximity` measures the enemy against
        // *our* list, which charges us for an enemy sitting still on a marker it
        // already holds and says nothing at all about one massing next to ours.
        let mine_open = open_locations(state, my_team);
        let theirs_open = open_locations(state, foe_team);
        score += weights.get(f::APPROACH)
            * (closeness(state, my_team, &mine_open) - closeness(state, foe_team, &theirs_open));
    }

    if weights.get(f::PROXIMITY_WALK) != 0.0 {
        let open = open_locations(state, my_team);
        // One sweep, both sides. It measures distance *from* the open locations,
        // so every unit on the board reads its own number out of the same walk.
        let mut steps = Steps::empty();
        Sweeper::new().sweep(state.size, &state.units, &open, &mut steps);
        score += weights.get(f::PROXIMITY_WALK)
            * (walk_closeness(state, my_team, &steps, open.len())
                - walk_closeness(state, foe_team, &steps, open.len()));
    }

    if weights.get(f::INITIATIVE) != 0.0 {
        let holder = state.players.iter().find(|p| p.has_initiative);
        score += weights.get(f::INITIATIVE) * holder.map_or(0.0, |p| sign(p.team, my_team));
    }

    if weights.get(f::TEMPO) != 0.0 {
        // `acting_seat` is the seat that owes the next decision, which in this
        // game is not always the seat whose turn it is.
        let acting = state.players.get(state.acting_seat() as usize);
        score += weights.get(f::TEMPO) * acting.map_or(0.0, |p| sign(p.team, my_team));
    }

    if weights.get(f::HAND) != 0.0 {
        // `reserve` counts the bag, the hand, the discard and the supply as one
        // pile of coins to come. Only the hand can be spent this turn.
        let mut held = 0.0;
        let mut theirs = 0.0;
        for p in &state.players {
            if p.team == my_team {
                held += p.hand.len() as f64;
            } else {
                theirs += p.hand.len() as f64;
            }
        }
        let in_hand = held + theirs;
        score +=
            weights.get(f::HAND) * if in_hand == 0.0 { 0.0 } else { (held - theirs) / in_hand };
    }

    if weights.get(f::THREAT) != 0.0 {
        score += weights.get(f::THREAT) * threat_balance(state, my_team, foe_team);
    }

    if weights.get(f::IDLE_HAND) != 0.0 {
        score -= weights.get(f::IDLE_HAND)
            * (idle_fraction(state, my_team) - idle_fraction(state, foe_team));
    }

    if weights.get(f::WORTH) != 0.0 {
        // Divided by the plain coin count, exactly as `material` is, so the two
        // sit on one scale and a fit can tell them apart.
        let mut balance = 0.0;
        for (_, stack) in state.units.iter() {
            balance += sign(stack.team, my_team) * stack.coins as f64 * unit_worth(stack.unit);
        }
        score += weights.get(f::WORTH) * if on_board == 0.0 { 0.0 } else { balance / on_board };
    }

    if weights.get(f::CIRCULATION) != 0.0 {
        // Negative, like every other liability here: a positive weight should
        // mean "a board I cannot drive is bad".
        score -= weights.get(f::CIRCULATION)
            * (frozen_fraction(state, my_team) - frozen_fraction(state, foe_team));
    }

    if weights.get(f::ATTRITION) != 0.0 {
        score += weights.get(f::ATTRITION) * attrition_balance(state, my_team);
    }

    if weights.get(f::TRADED) != 0.0 {
        score += weights.get(f::TRADED) * trade_balance(state, my_team);
    }

    if weights.get(f::DEAD_WEIGHT) != 0.0 {
        score -= weights.get(f::DEAD_WEIGHT)
            * (dead_fraction(state, my_team) - dead_fraction(state, foe_team));
    }

    score.tanh()
}

#[inline]
fn sign(team: Team, mine: Team) -> f64 {
    if team == mine {
        1.0
    } else {
        -1.0
    }
}

fn open_locations(state: &GameState, team: Team) -> ArrayVec<HexIdx, 14> {
    board_for(state.size)
        .locations
        .iter()
        .copied()
        .filter(|loc| state.control[*loc as usize] != team)
        .collect()
}

/// Which side has more of its stacks standing where they can be hit.
///
/// Contact is mutual, so a naive count would cancel to zero and mean nothing.
/// What does not cancel is *who can actually swing*: three units in the box —
/// the Archer, the Lancer and the Trebuchet — are printed "can only attack by
/// using its tactic", so standing next to one is safe in a way that standing
/// next to a Swordsman is not.
///
/// Only plain adjacent attacks are counted. A tactic needs the matching coin in
/// hand, and the hand the search is looking at is a guess — a threat that
/// depends on a card we invented is a threat we invented.
fn threat_balance(state: &GameState, mine: Team, theirs: Team) -> f64 {
    let mut exposed = 0.0;
    let mut my_stacks = 0.0;
    let mut their_exposed = 0.0;
    let mut their_stacks = 0.0;

    for (hex, stack) in state.units.iter() {
        let friendly = stack.team == mine;
        if friendly {
            my_stacks += 1.0;
        } else if stack.team == theirs {
            their_stacks += 1.0;
        } else {
            continue;
        }
        for n in wc_core::engine::adjacent(state, hex) {
            let other = match state.units.get(*n) {
                Some(o) if o.team != stack.team => o,
                _ => continue,
            };
            if has_restriction(other.unit, restrict::NO_NORMAL_ATTACK) {
                continue;
            }
            if friendly {
                exposed += 1.0;
            } else {
                their_exposed += 1.0;
            }
            break;
        }
    }

    let here = if my_stacks == 0.0 { 0.0 } else { exposed / my_stacks };
    let there = if their_stacks == 0.0 { 0.0 } else { their_exposed / their_stacks };
    there - here
}

/// The share of a hand that can do nothing but claim the Initiative or be
/// discarded.
///
/// A coin in hand has four uses and each has a condition: *deploy* needs
/// somewhere to deploy to, *recruit* needs a coin of that unit still in the
/// supply, and *bolster* and *maneuver* both need one of that unit already on
/// the board. A coin that fails all four costs a turn.
fn dead_fraction(state: &GameState, team: Team) -> f64 {
    let mut present = [false; UNIT_COUNT];
    for (_, stack) in state.units.iter() {
        if stack.team == team {
            present[stack.unit as usize] = true;
        }
    }

    let mut dead = 0.0;
    let mut held = 0.0;
    for p in &state.players {
        if p.team != team {
            continue;
        }
        for coin in &p.hand {
            held += 1.0;
            // The Royal Coin and a Nightfall decoy are not units and are never
            // stuck: the first is the most flexible coin in the game and the
            // second is spent by being spent.
            let unit = match coin.as_unit() {
                Some(u) => u,
                None => continue,
            };
            if present[unit as usize] {
                continue;
            }
            if p.supply_of(unit) > 0 {
                continue;
            }
            // Asked of the engine: `deploy_targets` knows about the per-unit cap
            // and about the Footman's two, and a second copy of that rule living
            // here would be a second copy to get wrong.
            if !deploy_targets(state, p.seat, unit).is_empty() {
                continue;
            }
            dead += 1.0;
        }
    }
    if held == 0.0 {
        0.0
    } else {
        dead / held
    }
}

/// Coins of each unit this player can still draw: bag, hand, discard, supply.
///
/// Counted once per player rather than once per stack. The bag and the discard
/// run to twenty coins apiece late in a game, and the evaluation is called once
/// per search iteration.
fn circulation_of(p: &PlayerState) -> [u16; UNIT_COUNT] {
    let mut out = [0u16; UNIT_COUNT];
    let add = |coin: CoinId, out: &mut [u16; UNIT_COUNT]| {
        // The Royal Coin and a Nightfall decoy drive nothing of their own.
        if let Some(unit) = coin.as_unit() {
            out[unit as usize] += 1;
        }
    };
    for coin in &p.bag {
        add(*coin, &mut out);
    }
    for coin in &p.hand {
        add(*coin, &mut out);
    }
    for entry in &p.discard {
        add(entry.coin, &mut out);
    }
    for unit in UNIT_IDS {
        out[unit as usize] += p.supply[unit as usize] as u16;
    }
    out
}

/// The share of a side's board coins that has nothing left to drive it.
///
/// A stack counts fully when no coin of its unit is left anywhere, half when one
/// is, and not at all from two upwards — a unit with two coins still going round
/// can be moved when it is wanted, and one is a coin that comes round rarely.
fn frozen_fraction(state: &GameState, team: Team) -> f64 {
    let mut cached: [Option<[u16; UNIT_COUNT]>; MAX_SEATS] = [None, None, None, None];
    let mut board_coins = 0.0;
    let mut frozen = 0.0;
    for (_, stack) in state.units.iter() {
        if stack.team != team {
            continue;
        }
        let owner = match state.players.get(stack.seat as usize) {
            Some(o) => o,
            None => continue,
        };
        let counts = cached[stack.seat as usize].get_or_insert_with(|| circulation_of(owner));
        board_coins += stack.coins as f64;
        let left = counts[stack.unit as usize] as f64;
        frozen += stack.coins as f64 * (1.0 - left / 2.0).max(0.0);
    }
    if board_coins == 0.0 {
        0.0
    } else {
        frozen / board_coins
    }
}

/// Every coin the game contains, wherever it happens to be.
///
/// Conserved, which is the whole reason it is the denominator for the two
/// attrition terms: a balance that only grows needs a scale that does not move
/// under it. The number lost so far is not one — dividing by it turns a running
/// total into an average, exactly the shape a permanent loss must not have.
fn coins_in_game(state: &GameState) -> f64 {
    let mut n = 0.0;
    for (_, stack) in state.units.iter() {
        n += stack.coins as f64;
    }
    for p in &state.players {
        n += (p.bag.len() + p.hand.len() + p.discard.len()) as f64;
        n += p.supply_total() as f64 + p.removed_total() as f64;
    }
    n
}

/// How many coins each side has lost, against half the coins in the game.
fn attrition_balance(state: &GameState, team: Team) -> f64 {
    let mut balance = 0.0;
    for p in &state.players {
        let s = if p.team == team { -1.0 } else { 1.0 };
        balance += s * p.removed_total() as f64;
    }
    let pool = coins_in_game(state);
    // Half the pool, so a side that had lost everything would read −1: each side
    // owns about half the coins, and the balance is one side against the other.
    if pool == 0.0 {
        0.0
    } else {
        2.0 * balance / pool
    }
}

/// The same balance, weighed by what each destroyed coin was worth.
///
/// Positive is good for `team`: it has lost the cheaper coins. Read on its own
/// this says losing a Footman is *good*, because `unit_worth` is centred — which
/// is why it belongs beside `attrition` and not instead of it.
fn trade_balance(state: &GameState, team: Team) -> f64 {
    let mut balance = 0.0;
    for p in &state.players {
        let s = if p.team == team { -1.0 } else { 1.0 };
        for unit in UNIT_IDS {
            let n = p.removed[unit as usize];
            if n > 0 {
                balance += s * n as f64 * unit_worth(unit);
            }
        }
    }
    let pool = coins_in_game(state);
    if pool == 0.0 {
        0.0
    } else {
        2.0 * balance / pool
    }
}

/// The share of a hand whose units are not on the board.
fn idle_fraction(state: &GameState, team: Team) -> f64 {
    let mut present = [false; UNIT_COUNT];
    for (_, stack) in state.units.iter() {
        if stack.team == team {
            present[stack.unit as usize] = true;
        }
    }
    let mut idle = 0.0;
    let mut held = 0.0;
    for p in &state.players {
        if p.team != team {
            continue;
        }
        for coin in &p.hand {
            held += 1.0;
            if let Some(unit) = coin.as_unit() {
                if !present[unit as usize] {
                    idle += 1.0;
                }
            }
        }
    }
    if held == 0.0 {
        0.0
    } else {
        idle / held
    }
}

/// The same position as a plain vector, one number per weight.
///
/// `evaluate` computes only the features whose weight is non-zero, because it
/// runs at the end of every rollout and most weights are zero. This computes all
/// of them, for the one caller that needs them all: fitting weights to the
/// outcomes of thousands of games. Nothing in the search calls it.
///
/// The two must agree — `evaluate` has to equal `tanh(w · feature_vector)` — and
/// they are held to it by a test rather than by care, because they are two
/// implementations of one formula and that always drifts.
pub fn feature_vector(state: &GameState, seat: Seat) -> [f64; FEATURE_COUNT] {
    let mut out = [0.0; FEATURE_COUNT];
    let me = match state.players.get(seat as usize) {
        Some(p) => p,
        None => return out,
    };
    let board = board_for(state.size);
    let my_team = me.team;
    let foe_team = state.other_team(my_team);

    let placed = |team: Team| board.control_markers as f64 - state.markers_remaining(team) as f64;
    out[f::MARKERS] = (placed(my_team) - placed(foe_team)) / board.control_markers as f64;

    let mut coins = 0.0;
    let mut material = 0.0;
    let mut scarcity = 0.0;
    let mut reach = 0.0;
    let mut bolster = 0.0;
    let mut worth = 0.0;
    let mut stacked = 0.0;
    for (_, stack) in state.units.iter() {
        let value = type_value(stack.unit);
        let s = sign(stack.team, my_team);
        coins += stack.coins as f64;
        material += s * stack.coins as f64;
        scarcity += s * stack.coins as f64 * value.0;
        reach += s * stack.coins as f64 * value.1;
        bolster += s * (stack.coins - 1) as f64;
        worth += s * stack.coins as f64 * unit_worth(stack.unit);
        stacked += (stack.coins - 1) as f64;
    }

    let mut reserve = 0.0;
    let mut pool = 0.0;
    let mut hand = 0.0;
    let mut in_hand = 0.0;
    for p in &state.players {
        let held = (p.bag.len() + p.hand.len() + p.discard.len()) as f64 + p.supply_total() as f64;
        pool += held;
        reserve += sign(p.team, my_team) * held;
        in_hand += p.hand.len() as f64;
        hand += sign(p.team, my_team) * p.hand.len() as f64;
    }

    let open = open_locations(state, my_team);
    let theirs_open = open_locations(state, foe_team);
    let mut steps = Steps::empty();
    Sweeper::new().sweep(state.size, &state.units, &open, &mut steps);

    let over = |x: f64, by: f64| if by == 0.0 { 0.0 } else { x / by };

    out[f::MATERIAL] = over(material, coins);
    out[f::SCARCITY] = over(scarcity, coins);
    out[f::REACH] = over(reach, coins);
    out[f::RESERVE] = over(reserve, pool);
    out[f::BOLSTER] = over(bolster, stacked);
    out[f::PROXIMITY] = closeness(state, my_team, &open) - closeness(state, foe_team, &open);
    out[f::INITIATIVE] = state
        .players
        .iter()
        .find(|p| p.has_initiative)
        .map_or(0.0, |p| sign(p.team, my_team));
    out[f::TEMPO] = state
        .players
        .get(state.acting_seat() as usize)
        .map_or(0.0, |p| sign(p.team, my_team));
    out[f::HAND] = over(hand, in_hand);
    out[f::THREAT] = threat_balance(state, my_team, foe_team);
    out[f::DEAD_WEIGHT] = -(dead_fraction(state, my_team) - dead_fraction(state, foe_team));
    out[f::IDLE_HAND] = -(idle_fraction(state, my_team) - idle_fraction(state, foe_team));
    out[f::WORTH] = over(worth, coins);
    out[f::CIRCULATION] = -(frozen_fraction(state, my_team) - frozen_fraction(state, foe_team));
    out[f::TRADED] = trade_balance(state, my_team);
    out[f::APPROACH] =
        closeness(state, my_team, &open) - closeness(state, foe_team, &theirs_open);
    out[f::PROXIMITY_WALK] = walk_closeness(state, my_team, &steps, open.len())
        - walk_closeness(state, foe_team, &steps, open.len());
    out[f::ATTRITION] = attrition_balance(state, my_team);
    out
}

/// A fitted vector read back as weights.
///
/// Everything is a coefficient except the material trio: `evaluate` multiplies
/// coins by `1 + scarcity·s + reach·r` and then by `material`, so a fit returns
/// `material`, `material·scarcity` and `material·reach`. Dividing gives the
/// weights back.
pub fn weights_from_fit(fit: &[f64], version: &str) -> EvalWeights {
    let mut w = [0.0; FEATURE_COUNT];
    for i in 0..FEATURE_COUNT {
        w[i] = fit.get(i).copied().unwrap_or(0.0);
    }
    let material = w[f::MATERIAL];
    let scale = if material.abs() < 1e-6 { 0.0 } else { 1.0 / material };
    w[f::SCARCITY] *= scale;
    w[f::REACH] *= scale;
    // Zeroed rather than read back, though the coordinate exists: this and
    // `proximity` and `approach` are three readings of one question, and a fit
    // handed all three splits the weight between them and reports each as
    // smaller than the idea is. Which of the three to believe is a match's
    // decision, not a fit's.
    w[f::PROXIMITY_WALK] = 0.0;
    EvalWeights { version: version.to_string(), w }
}

/// What a unit is worth per coin, as against the flat 1 every version up to
/// `eval@3` used.
///
/// **Both features are read off the card, not invented.** There is no printed
/// power rating in War Chest, so the two things the box does say are used
/// instead: *scarcity*, the short print run the designers gave some units, and
/// *reach*, whether the tactic can strike something that is not adjacent.
fn multiplier(unit: UnitId, weights: &EvalWeights) -> f64 {
    let (scarcity, reach) = type_value(unit);
    let m = 1.0 + weights.get(f::SCARCITY) * scarcity + weights.get(f::REACH) * reach;
    // A weight pushed far enough negative would make a unit worth less than
    // nothing, and a side's total could then cross zero and take the normalising
    // denominator with it.
    m.max(0.0)
}

/// `(scarcity, reach)`: 1 for a four-coin unit, and 1 if the tactic reaches past
/// the neighbouring hexes.
fn type_value(unit: UnitId) -> (f64, f64) {
    let spec = unit.spec();
    let scarcity = (5i32 - spec.coins as i32).max(0) as f64;
    let reach = match spec.tactic {
        Some(Tactic::RangedAttack { max, .. }) | Some(Tactic::PoisonAtRange { max, .. }) => {
            if max > 1 {
                1.0
            } else {
                0.0
            }
        }
        // Move first, strike second: the target starts out of contact.
        Some(Tactic::ChargeAttack { .. })
        | Some(Tactic::MoveThenPoison)
        | Some(Tactic::MoveThenAttackFort)
        | Some(Tactic::Skirmish { .. }) => 1.0,
        _ => 0.0,
    };
    (scarcity, reach)
}

/// How near a side's units are to the given locations, as a number that grows
/// with nearness. Plain hex distance, not a walk around occupied hexes: this
/// runs at the end of every rollout.
fn closeness(state: &GameState, team: Team, locations: &[HexIdx]) -> f64 {
    if locations.is_empty() {
        return 0.0;
    }
    let mut sum = 0.0;
    let mut units = 0.0;
    for (hex, stack) in state.units.iter() {
        if stack.team != team {
            continue;
        }
        units += 1.0;
        let mut best = u8::MAX;
        for loc in locations {
            let d = DIST[hex as usize][*loc as usize];
            if d < best {
                best = d;
            }
        }
        // A location under our feet scores 1, one across the board scores near 0.
        sum += 1.0 / (1.0 + best as f64);
    }
    if units == 0.0 {
        0.0
    } else {
        sum / units
    }
}

/// The same shape, on steps rather than hex distance. The sweep is passed in
/// because one of them answers for both sides.
fn walk_closeness(state: &GameState, team: Team, steps: &Steps, locations: usize) -> f64 {
    if locations == 0 {
        return 0.0;
    }
    let mut sum = 0.0;
    let mut units = 0.0;
    for (hex, stack) in state.units.iter() {
        if stack.team != team {
            continue;
        }
        units += 1.0;
        // Unreachable is not "infinitely far": it is a unit that contributes
        // nothing, which is what a zero says here.
        if let Some(d) = steps.get(hex) {
            sum += 1.0 / (1.0 + d as f64);
        }
    }
    if units == 0.0 {
        0.0
    } else {
        sum / units
    }
}
