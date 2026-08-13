//! The two measuring sticks.
//!
//! Neither is a difficulty level and neither should ever be offered to a player.
//! They exist so that a change to a real bot can be stated as a number: a bot
//! that cannot beat `greedy` by a wide margin has a bug, not a tuning problem.

use crate::position::Position;
use wc_core::board::{HexIdx, NONE};
use wc_core::rng::Rng;
use wc_core::types::{Action, ActionKind, Seat};

/// Uniform over the legal actions. The floor.
pub fn random_choice(legal: &[Action], rng: &mut Rng) -> Action {
    legal[rng.next_int(legal.len())]
}

/// Take a location if one is on offer, otherwise hit something, preferring a hit
/// that destroys. No lookahead, no board sense — it plays the action in front of
/// it. Ties are broken with the caller's rng, so a match is still reproducible.
pub fn greedy_choice<P: Position>(
    pos: &P,
    you: Seat,
    legal: &[Action],
    rng: &mut Rng,
    scratch: &mut Vec<u32>,
) -> Action {
    scratch.clear();
    let mut best_score = i32::MIN;
    for (i, action) in legal.iter().enumerate() {
        let score = rank(pos, you, *action);
        if score > best_score {
            best_score = score;
            scratch.clear();
            scratch.push(i as u32);
        } else if score == best_score {
            scratch.push(i as u32);
        }
    }
    legal[scratch[rng.next_int(scratch.len())] as usize]
}

fn target(action: Action) -> Option<HexIdx> {
    match action.kind {
        ActionKind::Attack | ActionKind::FollowAttack => Some(action.to),
        ActionKind::Tactic if action.target != NONE => Some(action.target),
        _ => None,
    }
}

fn rank<P: Position>(pos: &P, you: Seat, action: Action) -> i32 {
    use ActionKind::*;
    // Claiming a location is the only thing that wins the game.
    if matches!(action.kind, Control | FollowControl) {
        return 100;
    }

    if let Some(hit) = target(action) {
        let mine = pos.team_of(you);
        return match pos.units().get(hit) {
            // A single-coin stack dies to this hit; a bolstered one only shrinks.
            Some(stack) if stack.team != mine => {
                if stack.coins == 1 {
                    90
                } else {
                    70
                }
            }
            // A fortification, or a tactic that hits an empty hex.
            _ => 60,
        };
    }

    match action.kind {
        Deploy => 50,
        Move | FollowMove | Tactic => 40,
        Bolster => 30,
        Recruit | FollowRecruit => 20,
        Draft | Ban => 10,
        // Discarding a coin facedown does nothing but end the turn.
        Pass => 0,
        _ => 15,
    }
}
