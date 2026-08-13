//! Structural checks a legal position must satisfy, whatever was played to
//! reach it. Written for the fuzzer and the arena: a search treats the engine as
//! its definition of the game, so a rule that leaks coins or markers becomes a
//! strategy rather than a bug report.
//!
//! `check_invariants` returns a list of violations — empty means the position is
//! sound. It never panics and never touches the state.

use crate::board::{board_for, FORTIFICATIONS_TOTAL};
use crate::decrees::SEALS_PER_SIDE;
use crate::setup::HAND_SIZE;
use crate::types::*;
use crate::units::*;

/// A Warrior Priest draw sits on top of a full hand until it is spent.
const MAX_HAND_HELD: usize = HAND_SIZE + 1;

pub fn check_invariants(state: &GameState) -> Vec<String> {
    let mut bad = Vec::new();
    let board = board_for(state.size);

    coins_are_conserved(state, &mut bad);
    decoys_are_unique(state, &mut bad);

    // --- the board ---
    let mut deployed = [[0u8; UNIT_COUNT]; MAX_SEATS];
    for (hex, stack) in state.units.iter() {
        let id = crate::board::id_of(hex);
        if !board.on_board[hex as usize] {
            bad.push(format!("stack on {id}, which is not on the board"));
        }
        if stack.coins < 1 {
            bad.push(format!("stack on {id} holds {} coins", stack.coins));
        }
        match state.players.get(stack.seat as usize) {
            None => bad.push(format!(
                "stack on {id} belongs to seat {}, which is empty",
                stack.seat
            )),
            Some(owner) => {
                if owner.team != stack.team {
                    bad.push(format!(
                        "stack on {id}: seat {} is not on team {}",
                        stack.seat, stack.team
                    ));
                }
                if !owner.drafted(stack.unit) {
                    bad.push(format!(
                        "seat {} fields {}, which it never drafted",
                        stack.seat,
                        stack.unit.key()
                    ));
                }
            }
        }
        if (stack.seat as usize) < MAX_SEATS {
            deployed[stack.seat as usize][stack.unit as usize] += 1;
        }
    }
    for (seat, row) in deployed.iter().enumerate() {
        for (unit, n) in row.iter().enumerate() {
            let max = max_deployed(UNIT_IDS[unit]);
            if *n > max {
                bad.push(format!(
                    "{seat}:{} is deployed {n} times, limit {max}",
                    UNIT_KEYS[unit]
                ));
            }
        }
    }

    // --- control markers ---
    for (hex, team) in state.control.iter().enumerate() {
        if *team == NO_SEAT {
            continue;
        }
        let id = crate::board::id_of(hex as u8);
        if !board.is_location[hex] {
            bad.push(format!("control marker on {id}, which is not a location"));
        }
        if !state.players.iter().any(|p| p.team == *team) {
            bad.push(format!("control marker on {id} for team {team}, which nobody plays"));
        }
    }
    let mut teams: Vec<Team> = state.players.iter().map(|p| p.team).collect();
    teams.sort_unstable();
    teams.dedup();
    for team in &teams {
        let left = state.markers_remaining(*team);
        if left < 0 {
            bad.push(format!("team {team} placed more markers than it owns"));
        }
        if left == 0 && state.phase != Phase::Finished {
            bad.push(format!("team {team} placed its last marker but the game runs on"));
        }
    }

    // --- fortifications ---
    let forts = state.forts.iter().filter(|f| **f).count();
    for (hex, f) in state.forts.iter().enumerate() {
        if *f && !board.is_location[hex] {
            bad.push(format!(
                "fortification on {}, which is not a location",
                crate::board::id_of(hex as u8)
            ));
        }
    }
    if state.sets.has(UnitSet::Siege) {
        if forts as u8 + state.fort_supply != FORTIFICATIONS_TOTAL {
            bad.push(format!(
                "{forts} fortifications on the board and {} beside it, expected {FORTIFICATIONS_TOTAL} in total",
                state.fort_supply
            ));
        }
    } else if forts > 0 || state.fort_supply != 0 {
        bad.push("fortifications without the Siege set".into());
    }

    // --- poison counters: one of each, on one unit ---
    for poisoner in [Poison::Assassin, Poison::Saboteur] {
        let n = state.units.iter().filter(|(_, s)| s.poisoned_by == poisoner).count();
        if n > 1 {
            bad.push(format!(
                "{n} units carry the {}'s poison counter",
                poisoner.key().unwrap()
            ));
        }
    }

    // --- hands, seals, initiative ---
    for p in &state.players {
        if p.hand.len() > MAX_HAND_HELD {
            bad.push(format!("seat {} holds {} coins", p.seat, p.hand.len()));
        }
    }
    if state.sets.has(UnitSet::Nobility) {
        seals_are_conserved(state, &mut bad);
    } else if !state.decrees.is_empty() {
        bad.push("royal decrees without the Nobility set".into());
    }

    if matches!(state.phase, Phase::Playing | Phase::Finished) {
        let holders: Vec<Seat> =
            state.players.iter().filter(|p| p.has_initiative).map(|p| p.seat).collect();
        if holders.len() != 1 {
            bad.push(format!("{} players hold the initiative marker", holders.len()));
        } else if holders[0] != state.initiative {
            bad.push(format!(
                "initiative marker sits with seat {}, state says {}",
                holders[0], state.initiative
            ));
        }
    }

    if state.winner.is_some() && state.phase != Phase::Finished {
        bad.push("a winner in an unfinished game".into());
    }
    if state.turn as usize >= state.players.len() {
        bad.push(format!("turn points at seat {}", state.turn));
    }

    bad
}

/// Every coin printed on a player's cards is somewhere: bag, hand, discard, on
/// the board, still in the supply, or out of the game. The Royal Coin is one per
/// player and never reaches the board.
fn coins_are_conserved(state: &GameState, bad: &mut Vec<String>) {
    // Bags are filled at the end of the draft: before that a player has cards
    // but no coins, and there is nothing to conserve yet.
    if matches!(state.phase, Phase::Draft | Phase::Ban) {
        return;
    }

    for p in &state.players {
        let mut seen = [0i32; COIN_KINDS];
        for coin in &p.bag {
            seen[coin.0 as usize] += 1;
        }
        for coin in &p.hand {
            seen[coin.0 as usize] += 1;
        }
        for d in &p.discard {
            seen[d.coin.0 as usize] += 1;
        }
        for (_, stack) in state.units.iter() {
            if stack.seat == p.seat {
                seen[stack.unit as usize] += stack.coins as i32;
            }
        }
        for unit in UNIT_IDS {
            seen[unit as usize] += p.supply[unit as usize] as i32;
            seen[unit as usize] += p.removed[unit as usize] as i32;
        }

        // Redeploy holds a lifted stack on the pending step until it comes back
        // down, so mid-decree those coins are on no pile at all.
        if p.seat == state.turn {
            for step in &state.pending {
                if let PendingStep::DecreePlace { unit, coins, .. } = step {
                    seen[*unit as usize] += *coins as i32;
                }
            }
        }

        for unit in &p.units {
            let have = seen[*unit as usize];
            let printed = unit.spec().coins as i32;
            if have != printed {
                bad.push(format!(
                    "seat {}: {have} {} coins, the card prints {printed}",
                    p.seat,
                    unit.key()
                ));
            }
            seen[*unit as usize] = 0;
        }

        let royal = seen[ROYAL_COIN.0 as usize];
        if royal != 1 {
            bad.push(format!("seat {} holds {royal} royal coins", p.seat));
        }
        seen[ROYAL_COIN.0 as usize] = 0;

        for (i, n) in seen.iter().enumerate() {
            let coin = CoinId(i as u8);
            if *n != 0 && !coin.is_decoy() {
                bad.push(format!(
                    "seat {} holds {n} {} coins from a unit it never drafted",
                    p.seat,
                    coin.key()
                ));
            }
        }
    }
}

/// One coin per Decoy card, wherever it currently sits.
fn decoys_are_unique(state: &GameState, bad: &mut Vec<String>) {
    for decoy in DECOYS {
        let mut n = 0;
        for p in &state.players {
            n += p.bag.iter().filter(|c| **c == decoy).count();
            n += p.hand.iter().filter(|c| **c == decoy).count();
            n += p.discard.iter().filter(|d| d.coin == decoy).count();
        }
        if n > 1 {
            bad.push(format!("{n} copies of the {} coin are in play", decoy.key()));
        }
    }
}

/// Seals are placed on decrees or still in front of their owner, never lost.
fn seals_are_conserved(state: &GameState, bad: &mut Vec<String>) {
    let mut placed = [0u8; MAX_SEATS];
    for decree in &state.decrees {
        let mut seen = [false; MAX_SEATS];
        for team in &decree.seals {
            let t = *team as usize;
            if t >= MAX_SEATS {
                continue;
            }
            if seen[t] {
                bad.push(format!("team {team} has two seals on {}", decree.id.key()));
            }
            seen[t] = true;
            placed[t] += 1;
        }
    }
    // Three per side, shared by the seats on it — so the tally is summed over
    // the team and compared against three, not against three per seat.
    let mut teams: Vec<Team> = state.players.iter().map(|p| p.team).collect();
    teams.sort_unstable();
    teams.dedup();
    for team in teams {
        let in_hand: u32 =
            state.players.iter().filter(|p| p.team == team).map(|p| p.seals as u32).sum();
        let total = in_hand + placed[team as usize] as u32;
        if total != SEALS_PER_SIDE as u32 {
            bad.push(format!("team {team} accounts for {total} seals, expected {SEALS_PER_SIDE}"));
        }
    }
}
