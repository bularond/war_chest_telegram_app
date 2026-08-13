//! The redacted state a single player is allowed to see.
//!
//! War Chest has three kinds of hidden information: the contents of a bag, the
//! coins in an opponent's hand, and coins discarded facedown. Everything else —
//! the board, both discard piles' face-up coins, supply counts — is open.

use crate::board::{BoardSize, HEX_COUNT};
use crate::decrees::DecreeInPlay;
use crate::types::*;
use crate::units::{CoinId, SetMask, UnitId, UNIT_COUNT};
use arrayvec::ArrayVec;
use std::sync::Arc;

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct PlayerView {
    pub seat: Seat,
    pub team: Team,
    pub units: ArrayVec<UnitId, MAX_UNITS>,
    pub bag_count: u16,
    pub hand_count: u16,
    /// Present only for the viewing player, or for a hand the Spy is reading.
    pub hand: Option<ArrayVec<CoinId, MAX_HAND>>,
    /// The viewing player's own bag, sorted — the real order is their next draws.
    pub bag: Option<Vec<CoinId>>,
    /// Facedown coins show as `None` to everyone except their owner.
    pub discard: Vec<(Option<CoinId>, bool)>,
    pub supply: [u8; UNIT_COUNT],
    pub removed: [u8; UNIT_COUNT],
    pub seals: u8,
    pub markers_remaining: i32,
    pub has_initiative: bool,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct GameView {
    pub id: Arc<str>,
    pub size: BoardSize,
    pub phase: Phase,
    pub round: u16,
    pub turn: Seat,
    /// Who owes the next action; differs from `turn` for a defender's choice.
    pub acting: Seat,
    pub you: Seat,
    pub players: ArrayVec<PlayerView, MAX_SEATS>,
    pub seats: Arc<Vec<SeatInfo>>,
    pub units: Board,
    pub control: ControlMap,
    pub pending: Vec<PendingStep>,
    /// Public: the Initiative Marker changes hands at most once a round.
    pub initiative_moved_this_round: bool,
    pub decrees: ArrayVec<DecreeInPlay, 4>,
    pub forts: [bool; HEX_COUNT],
    pub fort_supply: u8,
    pub draft_mode: DraftMode,
    pub sets: SetMask,
    pub draft_pool: Vec<UnitId>,
    pub banned: Vec<UnitId>,
    /// What the log says about recency, without the log. See [`Log`].
    pub last_maneuver: [[u32; UNIT_COUNT]; MAX_SEATS],
    pub log_length: u32,
    pub winner: Option<Team>,
    /// Legal actions for `you`, empty when it is not your turn.
    pub legal: Vec<Action>,
}

pub fn view_for(state: &GameState, seat: Seat, legal: Vec<Action>) -> GameView {
    // The Spy decree lets the proclaimer look at a hand that is otherwise
    // hidden, so reveal exactly that hand for exactly as long as the step is
    // unresolved.
    let revealed = if state.turn == seat {
        match state.pending.last() {
            Some(PendingStep::DecreeSpy { target }) => Some(*target),
            _ => None,
        }
    } else {
        None
    };

    let acting = state.acting_seat();
    let players = state
        .players
        .iter()
        .map(|p| {
            let mut bag = None;
            if p.seat == seat {
                let mut sorted = p.bag.clone();
                sorted.sort();
                bag = Some(sorted);
            }
            PlayerView {
                seat: p.seat,
                team: p.team,
                units: p.units.clone(),
                bag_count: p.bag.len() as u16,
                hand_count: p.hand.len() as u16,
                hand: if p.seat == seat || Some(p.seat) == revealed {
                    Some(p.hand.clone())
                } else {
                    None
                },
                bag,
                discard: p
                    .discard
                    .iter()
                    .map(|d| {
                        (if d.face_up || p.seat == seat { Some(d.coin) } else { None }, d.face_up)
                    })
                    .collect(),
                supply: p.supply,
                removed: p.removed,
                seals: p.seals,
                markers_remaining: state.markers_remaining(p.team),
                has_initiative: p.has_initiative,
            }
        })
        .collect();

    GameView {
        id: state.id.clone(),
        size: state.size,
        phase: state.phase,
        round: state.round,
        turn: state.turn,
        acting,
        you: seat,
        players,
        seats: state.seats.clone(),
        units: state.units.clone(),
        control: state.control,
        // Redacted, not copied. The Warrior Priest's drawn coin is the one piece
        // of hidden information that travels in a pending step, and `pending`
        // goes to every seat at the table.
        pending: state
            .pending
            .iter()
            .map(|step| match step {
                PendingStep::MustUseCoin { .. } if state.turn != seat => {
                    PendingStep::MustUseCoin { coin: None }
                }
                other => other.clone(),
            })
            .collect(),
        initiative_moved_this_round: state.initiative_moved_this_round,
        decrees: state.decrees.clone(),
        forts: state.forts,
        fort_supply: state.fort_supply,
        draft_mode: state.draft_mode,
        sets: state.sets,
        draft_pool: state.draft_pool.clone(),
        banned: state.banned.clone(),
        last_maneuver: state.log.last_maneuver,
        log_length: state.log.length,
        winner: state.winner,
        legal: if seat == acting { legal } else { Vec::new() },
    }
}

/// A `GameView` over a state the search made up, built by sharing rather than
/// copying. Nothing is hidden here, and nothing needs to be: this is a
/// determinization the search invented, not the real game. Never hand a real
/// `GameState` to it.
pub fn search_view(state: &GameState, seat: Seat, legal: Vec<Action>) -> GameView {
    let mut view = view_for(state, seat, legal);
    // Every hand open, and `acting` is the seat being asked rather than the one
    // the state names — the rollout drives one seat at a time.
    for (i, p) in state.players.iter().enumerate() {
        view.players[i].hand = Some(p.hand.clone());
    }
    view.pending = state.pending.clone();
    view.acting = seat;
    view
}
