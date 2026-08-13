//! A state that goes out as JSON and comes back must be the same state.
//!
//! This is the one thing `json.rs` can get wrong quietly. Everything above the
//! core — the server, the client, every test in `@wc/shared` — reaches the rules
//! through that shape, and a field it forgets to read back does not fail: the
//! game simply continues without it. That is exactly how the journal was lost
//! for one commit, and the symptom was a bot that moved with nothing appearing
//! in the log.
//!
//! Run over whole games rather than fixed positions, because the fields that go
//! missing are the ones a hand-written position does not happen to have: a
//! poison counter, a lifted stack held on a pending step, a decoy in a discard
//! pile, a Warrior Priest's drawn coin.

use wc_core::board::BoardSize;
use wc_core::json::{state_from_json, state_to_json, view_from_json, view_to_json};
use wc_core::playout::{play_random_game, random_policy, PlayoutOptions};
use wc_core::rng::Rng;
use wc_core::types::DraftMode;
use wc_core::units::{SetMask, UnitSet};
use wc_core::view::view_for;

fn every_box() -> SetMask {
    SetMask::base().with(UnitSet::Nobility).with(UnitSet::Siege).with(UnitSet::Nightfall)
}

fn check(state: &wc_core::GameState, ply: usize, seed: u32) {
    let text = state_to_json(state);
    let back = state_from_json(&text).unwrap_or_else(|e| panic!("seed {seed} ply {ply}: {e}"));
    let again = state_to_json(&back);
    assert_eq!(
        text, again,
        "seed {seed} ply {ply}: a state changed by being written down and read back"
    );

    // And the same for a view, which is what actually crosses to the client.
    for seat in 0..state.players.len() as u8 {
        let legal = wc_core::engine::legal(state, seat);
        let view = view_for(state, seat, legal);
        let text = view_to_json(&view);
        let back = view_from_json(&text).unwrap_or_else(|e| panic!("seed {seed} ply {ply}: {e}"));
        assert_eq!(
            text,
            view_to_json(&back),
            "seed {seed} ply {ply} seat {seat}: a view changed on the way round"
        );
    }
}

fn run(games: u32, size: BoardSize, sets: SetMask, mode: DraftMode) {
    for seed in 0..games {
        let mut opts = PlayoutOptions::new(seed * 5701 + 3);
        opts.size = size;
        opts.sets = sets;
        opts.draft_mode = mode;
        opts.max_plies = 400;
        let mut rng = Rng::new(seed + 1);
        let seed = opts.seed;
        check(
            &wc_core::setup::create_game(&{
                let mut c = wc_core::setup::CreateGameOptions::new("roundtrip", size, seed);
                c.sets = sets;
                c.draft_mode = mode;
                c
            })
            .unwrap(),
            0,
            seed,
        );
        play_random_game(&opts, &mut rng, random_policy, |state, _action, ply| {
            check(state, ply, seed);
            Ok(())
        })
        .unwrap_or_else(|e| panic!("{e}"));
    }
}

#[test]
fn a_base_game_survives_the_wire() {
    run(6, BoardSize::Duel, SetMask::base(), DraftMode::Draft);
}

#[test]
fn every_box_survives_the_wire() {
    run(6, BoardSize::Duel, every_box(), DraftMode::Draft);
}

#[test]
fn the_four_player_board_survives_the_wire() {
    run(4, BoardSize::Team, every_box(), DraftMode::Random);
}

#[test]
fn the_elimination_draft_survives_the_wire() {
    run(4, BoardSize::Duel, every_box(), DraftMode::Ban);
}
