//! State handling for search: a non-mutating apply, and a name for a move.
//!
//! Cloning is `GameState::clone` and needs no help here — the state owns four
//! small `Vec`s and everything else is inline. What does need help is naming an
//! edge of a search tree, and that is `move_key`.

use crate::board::{HexIdx, HEX_SLOTS, NONE};
use crate::decrees::DECREE_COUNT;
use crate::engine::{apply_action, legal, legal_actions, Validate};
use crate::types::*;
use crate::units::{CoinId, COIN_KINDS, UNIT_COUNT};

/// Applies `action` to a copy and returns it; `state` is left untouched.
pub fn apply(state: &GameState, action: Action, seat: Seat) -> Result<GameState, &'static str> {
    let mut next = state.clone();
    apply_action(&mut next, seat, action, Validate::Yes)?;
    Ok(next)
}

/// `apply` without the legality check, for an action that came out of
/// `legal_actions` a moment ago. Only for search: anything holding a real game —
/// the server above all — uses [`apply`], because there the action came from
/// outside.
pub fn simulate(state: &GameState, action: Action, seat: Seat) -> Result<GameState, &'static str> {
    let mut next = state.clone();
    apply_action(&mut next, seat, action, Validate::No)?;
    Ok(next)
}

/// Legal actions for whoever has to answer right now.
pub fn legal_moves(state: &GameState) -> Vec<Action> {
    if state.is_terminal() {
        return Vec::new();
    }
    legal(state, state.acting_seat())
}

pub fn legal_moves_into(state: &GameState, out: &mut Vec<Action>) {
    out.clear();
    if state.is_terminal() {
        return;
    }
    legal_actions(state, state.acting_seat(), out);
}

// ---------------------------------------------------------------------------
// Naming a move
// ---------------------------------------------------------------------------

/// Room for every coin name plus «none», then a block for bare slot numbers.
const COIN_SLOTS: u64 = COIN_KINDS as u64 + 1;
const HAND_SLOTS: u64 = 16;
/// Whichever small number an action kind needs: a step kind, a seat, a source.
const MISC_SLOTS: u64 = 23;

/// A name for the *move*, as a number.
///
/// The two ways this differs from naming the action are the two that cost the
/// search real work.
///
/// **The coin is a hand slot.** A player holding two Knight coins can pay for one
/// move with either, so the engine offers it twice — and in the opponent's part
/// of the tree, where the hand is re-dealt every iteration, the slot a Knight
/// lands in is random and the same reply gets a fresh name each time. Naming the
/// coin by its unit merges them.
///
/// **`skip` means two different things.** It is "let the blow land on me" as the
/// defender and "stay where I am" as the attacker. The step being answered tells
/// them apart.
///
/// `hand` is the acting player's; without it the slot number is the best name
/// available, and it goes in a range of its own so it can never be mistaken for
/// a coin name.
pub fn move_key(action: Action, hand: Option<&[CoinId]>, pending: Option<&[PendingStep]>) -> u64 {
    let mut coin = 0u64;
    if action.is_coin_action() {
        let held = hand.and_then(|h| h.get(action.coin as usize));
        coin = match held {
            Some(c) => c.0 as u64 + 1,
            // A named coin, or — failing that — the slot, above every coin name
            // so the two can never collide.
            None => COIN_SLOTS + (action.coin as u64).min(HAND_SLOTS - 1),
        };
    }

    let misc = match action.kind {
        ActionKind::Skip => pending
            .and_then(|p| p.last())
            .map(PendingStep::key_index)
            .unwrap_or(0),
        ActionKind::FollowSpy => (action.arg as u64 + 1).min(MISC_SLOTS - 1),
        ActionKind::FollowDeceive => action.arg as u64 + 1,
        ActionKind::FollowAbsorb => action.arg as u64,
        _ => 0,
    };

    let (unit, decree) = match action.kind {
        ActionKind::Recruit
        | ActionKind::FollowRecruit
        | ActionKind::FollowReinforce
        | ActionKind::FollowBurn
        | ActionKind::Draft
        | ActionKind::Ban => (action.arg as u64 + 1, 0),
        ActionKind::Proclaim | ActionKind::FollowProclaim => (0, action.arg as u64 + 1),
        _ => (0, 0),
    };

    let mut key = action.kind as u64;
    key = key * (COIN_SLOTS + HAND_SLOTS) + coin;
    // `at` and `hex` are the single-hex fields and never share an action with
    // `from`, so they share its slot.
    key = key * HEX_SLOTS + hex_slot(action.from);
    key = key * HEX_SLOTS + hex_slot(action.to);
    key = key * HEX_SLOTS + hex_slot(action.target);
    key = key * HEX_SLOTS + hex_slot(action.subject);
    key = key * (UNIT_COUNT as u64 + 1) + unit;
    key = key * (DECREE_COUNT as u64 + 1) + decree;
    key * MISC_SLOTS + misc
}

#[inline]
fn hex_slot(hex: HexIdx) -> u64 {
    if hex == NONE {
        0
    } else {
        hex as u64 + 1
    }
}

/// The same list with each move named once, keeping the first entry offering it.
///
/// Whoever draws at random from a legal list wants this and not the list: a move
/// a player can pay for two ways is in the list twice and comes up twice as
/// often.
pub fn distinct_moves(
    actions: &[Action],
    hand: Option<&[CoinId]>,
    pending: Option<&[PendingStep]>,
    out: &mut Vec<Action>,
) {
    out.clear();
    let mut seen: Vec<u64> = Vec::with_capacity(actions.len());
    for action in actions {
        let key = move_key(*action, hand, pending);
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        out.push(*action);
    }
}

/// FNV-1a, twice with different offsets, giving 64 bits. Identity for tests and
/// transposition keys — not a checksum against a hostile client.
pub fn hash_bytes(bytes: &[u8]) -> String {
    let mut h1: u32 = 0x811c_9dc5;
    let mut h2: u32 = 0x0100_0193;
    for b in bytes {
        h1 = (h1 ^ *b as u32).wrapping_mul(0x0100_0193);
        h2 = (h2 ^ *b as u32).wrapping_mul(0x85eb_ca6b);
    }
    format!("{h1:08x}{h2:08x}")
}

// The whole key must fit in the 53 bits a double holds exactly, because the
// TypeScript side computes the same number in floating point and the two have to
// agree. A key that silently lost its top bits would not fail — it would merge
// two different moves into one edge.
const _: () = {
    let span = ACTION_KIND_COUNT
        * (COIN_SLOTS + HAND_SLOTS)
        * HEX_SLOTS
        * HEX_SLOTS
        * HEX_SLOTS
        * HEX_SLOTS
        * (UNIT_COUNT as u64 + 1)
        * (DECREE_COUNT as u64 + 1)
        * MISC_SLOTS;
    assert!(span < (1u64 << 53), "move_key needs more values than a double holds");
};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::units::UnitId;

    #[test]
    fn two_slots_holding_the_same_coin_name_one_move() {
        let hand = [CoinId::unit(UnitId::Knight), ROYAL, CoinId::unit(UnitId::Knight)];
        const ROYAL: CoinId = crate::units::ROYAL_COIN;
        let a = Action::coin(ActionKind::Move, 0).with_from(3).with_to(4);
        let b = Action::coin(ActionKind::Move, 2).with_from(3).with_to(4);
        assert_eq!(move_key(a, Some(&hand), None), move_key(b, Some(&hand), None));
        // Without the hand there is nothing to merge them by.
        assert_ne!(move_key(a, None, None), move_key(b, None, None));
    }

    #[test]
    fn skip_is_named_by_the_step_it_answers() {
        let skip = Action::bare(ActionKind::Skip);
        let defending =
            [PendingStep::AbsorbHit {
                seat: 1,
                target: 0,
                by_hex: 1,
                by_unit: UnitId::Swordsman,
                by_seat: 0,
                options: AbsorbOptions::default(),
            }];
        let staying = [PendingStep::OptionalMove { hex: 0, source: StepSource::Swordsman }];
        assert_ne!(
            move_key(skip, None, Some(&defending)),
            move_key(skip, None, Some(&staying))
        );
    }
}
