//! Random games through the engine, with the position checked after every ply.
//!
//! The engine is the definition of the game for everything above it, so a rule
//! that leaks a coin or a marker becomes a strategy rather than a bug report.
//! This is the net that catches it.

use wc_core::board::BoardSize;
use wc_core::invariants::check_invariants;
use wc_core::playout::{play_random_game, random_policy, PlayoutOptions};
use wc_core::engine::{apply_action, Validate};
use wc_core::rng::Rng;
use wc_core::state::legal_moves_into;
use wc_core::types::DraftMode;
use wc_core::units::{SetMask, UnitSet};

/// Whether to try every legal action on a copy at every ply. Thorough and
/// several times slower, which is why it is a knob and not the default: a rule
/// reachable only by a move the policy never picks is still a rule.
#[derive(Copy, Clone, PartialEq, Eq)]
enum Branch {
    Played,
    Every,
}

fn run(games: u32, size: BoardSize, sets: SetMask, mode: DraftMode) {
    run_with(games, size, sets, mode, Branch::Played)
}

fn run_with(games: u32, size: BoardSize, sets: SetMask, mode: DraftMode, branch: Branch) {
    let mut finished = 0;
    for seed in 0..games {
        let mut opts = PlayoutOptions::new(seed * 7919 + 1);
        opts.size = size;
        opts.sets = sets;
        opts.draft_mode = mode;
        opts.max_plies = 1500;
        let mut rng = Rng::new(seed + 1);
        let mut legal = Vec::with_capacity(96);
        let result = play_random_game(&opts, &mut rng, random_policy, |state, action, ply| {
            let bad = check_invariants(state);
            if !bad.is_empty() {
                return Err(format!(
                    "seed {} ply {ply} after {:?}: {}",
                    opts.seed,
                    action.kind,
                    bad.join("; ")
                ));
            }
            if state.is_terminal() {
                return Ok(());
            }
            // An unfinished position always has something to do. A dead end is
            // not a draw — it is a game nobody can end, and a search would sit
            // in it forever.
            legal_moves_into(state, &mut legal);
            if legal.is_empty() {
                return Err(format!("seed {} ply {ply}: nothing legal to do", opts.seed));
            }
            if branch == Branch::Every {
                // Every action the engine offers can actually be played, and
                // leaves a position that is still sound.
                let seat = state.acting_seat();
                for action in &legal {
                    let mut next = state.clone();
                    apply_action(&mut next, seat, *action, Validate::No).map_err(|e| {
                        format!("seed {} ply {ply}: {:?} was offered but {e}", opts.seed, action.kind)
                    })?;
                    let bad = check_invariants(&next);
                    if !bad.is_empty() {
                        return Err(format!(
                            "seed {} ply {ply}: {:?} left {}",
                            opts.seed,
                            action.kind,
                            bad.join("; ")
                        ));
                    }
                }
            }
            Ok(())
        })
        .unwrap_or_else(|e| panic!("{e}"));

        if result.state.is_terminal() {
            finished += 1;
            // A game ends on a real win or a declared stalemate, never by
            // running out of anything quietly.
            match result.state.winner {
                Some(team) => assert_eq!(
                    result.state.markers_remaining(team),
                    0,
                    "seed {} ended without the winner placing its last marker",
                    opts.seed
                ),
                None => assert_eq!(
                    result.state.log.entries.last().map(|e| e.kind),
                    Some(wc_core::types::LogKind::Stalemate),
                    "seed {} ended a draw without saying so",
                    opts.seed
                ),
            }
        }
    }
    assert!(finished > games / 2, "only {finished} of {games} games reached an ending");
}

#[test]
fn the_base_game_holds_together() {
    run(60, BoardSize::Duel, SetMask::base(), DraftMode::Draft);
}

#[test]
fn every_box_at_once_holds_together() {
    let all = SetMask::base()
        .with(UnitSet::Nobility)
        .with(UnitSet::Siege)
        .with(UnitSet::Nightfall);
    run(60, BoardSize::Duel, all, DraftMode::Draft);
}

#[test]
fn each_expansion_on_its_own_holds_together() {
    for set in [UnitSet::Nobility, UnitSet::Siege, UnitSet::Nightfall] {
        run(30, BoardSize::Duel, SetMask::base().with(set), DraftMode::Random);
    }
}

#[test]
fn the_four_player_board_holds_together() {
    run(30, BoardSize::Team, SetMask::base(), DraftMode::Draft);
}

#[test]
fn the_elimination_draft_holds_together() {
    run(30, BoardSize::Duel, SetMask::base(), DraftMode::Ban);
}

/// The thorough pass: every legal action played on a copy, at every ply, with
/// every box on the table. This is the one that covers a rule no policy reaches.
#[test]
fn every_action_the_engine_offers_can_be_played() {
    let all = SetMask::base()
        .with(UnitSet::Nobility)
        .with(UnitSet::Siege)
        .with(UnitSet::Nightfall);
    run_with(12, BoardSize::Duel, all, DraftMode::Draft, Branch::Every);
}
