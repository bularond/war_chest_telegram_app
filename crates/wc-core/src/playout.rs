//! A random-play harness for the fuzzer and the invariant tests. This is not a
//! bot and not a difficulty level: it exists to drive the engine through as many
//! different positions as possible.

use crate::board::BoardSize;
use crate::engine::{apply_action, Validate};
use crate::rng::Rng;
use crate::setup::{create_game, CreateGameOptions};
use crate::state::legal_moves_into;
use crate::types::*;
use crate::units::SetMask;

/// Uniformly random play stalls: it buries every coin in bolsters, drains the
/// supply and then shuffles one coin a turn without ever reaching a late game.
/// Taking a location when one is on offer and recruiting when the bag runs dry
/// is the least steering that still gets games finished.
pub fn random_policy(state: &GameState, rng: &mut Rng, legal: &[Action]) -> Option<Action> {
    if legal.is_empty() {
        return None;
    }
    let me = &state.players[state.acting_seat() as usize];
    let coins = me.hand.len() + me.bag.len() + me.discard.len();

    let grabs: Vec<Action> = legal
        .iter()
        .copied()
        .filter(|a| matches!(a.kind, ActionKind::Control | ActionKind::FollowControl))
        .collect();
    let recruits: Vec<Action> =
        legal.iter().copied().filter(|a| a.kind == ActionKind::Recruit).collect();
    let board: Vec<Action> = legal
        .iter()
        .copied()
        .filter(|a| !matches!(a.kind, ActionKind::Pass | ActionKind::Recruit))
        .collect();

    let pool: &[Action] = if !grabs.is_empty() {
        &grabs
    } else if coins <= 4 && !recruits.is_empty() {
        &recruits
    } else if !board.is_empty() && rng.next_int(10) < 8 {
        &board
    } else {
        legal
    };
    Some(pool[rng.next_int(pool.len())])
}

/// Uniform choice — noisier, and the yardstick the arena measures against.
pub fn uniform_policy(_state: &GameState, rng: &mut Rng, legal: &[Action]) -> Option<Action> {
    if legal.is_empty() {
        return None;
    }
    Some(legal[rng.next_int(legal.len())])
}

pub struct PlayoutOptions {
    pub seed: u32,
    pub size: BoardSize,
    pub sets: SetMask,
    pub draft_mode: DraftMode,
    pub max_plies: usize,
}

impl PlayoutOptions {
    pub fn new(seed: u32) -> PlayoutOptions {
        PlayoutOptions {
            seed,
            size: BoardSize::Duel,
            sets: SetMask::base(),
            draft_mode: DraftMode::Draft,
            max_plies: 4000,
        }
    }
}

pub struct PlayoutResult {
    pub state: GameState,
    pub plies: usize,
}

/// Plays one game out, calling `on_step` after every action.
pub fn play_random_game(
    opts: &PlayoutOptions,
    rng: &mut Rng,
    policy: impl Fn(&GameState, &mut Rng, &[Action]) -> Option<Action>,
    mut on_step: impl FnMut(&GameState, Action, usize) -> Result<(), String>,
) -> Result<PlayoutResult, String> {
    let mut create = CreateGameOptions::new(format!("playout-{}", opts.seed), opts.size, opts.seed);
    create.sets = opts.sets;
    create.draft_mode = opts.draft_mode;
    let mut state = create_game(&create)?;

    let mut legal = Vec::with_capacity(96);
    let mut plies = 0;
    while !state.is_terminal() && plies < opts.max_plies {
        legal_moves_into(&state, &mut legal);
        let action = match policy(&state, rng, &legal) {
            Some(a) => a,
            None => return Err("no legal actions".into()),
        };
        let seat = state.acting_seat();
        apply_action(&mut state, seat, action, Validate::Yes)?;
        plies += 1;
        on_step(&state, action, plies)?;
    }
    Ok(PlayoutResult { state, plies })
}
