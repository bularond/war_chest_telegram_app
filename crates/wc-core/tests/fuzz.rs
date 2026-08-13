//! Random games through the engine, with the position checked after every ply.
//!
//! The engine is the definition of the game for everything above it, so a rule
//! that leaks a coin or a marker becomes a strategy rather than a bug report.
//! This is the net that catches it.

use wc_core::board::BoardSize;
use wc_core::invariants::check_invariants;
use wc_core::playout::{play_random_game, random_policy, PlayoutOptions};
use wc_core::rng::Rng;
use wc_core::types::DraftMode;
use wc_core::units::{SetMask, UnitSet};

fn run(games: u32, size: BoardSize, sets: SetMask, mode: DraftMode) {
    let mut finished = 0;
    for seed in 0..games {
        let mut opts = PlayoutOptions::new(seed * 7919 + 1);
        opts.size = size;
        opts.sets = sets;
        opts.draft_mode = mode;
        opts.max_plies = 1500;
        let mut rng = Rng::new(seed + 1);
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
            Ok(())
        })
        .unwrap_or_else(|e| panic!("{e}"));
        if result.state.is_terminal() {
            finished += 1;
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
