//! What the heuristic reads, and nothing else.
//!
//! In a rollout the bot is handed a determinization — a full `GameState` — and
//! building a redacted `GameView` for it would copy the board, both discard
//! piles and the log once per ply, which is about as much work as the ply. At
//! the top of a real game it is handed a `GameView` and there is no state to be
//! had. The two have every field this file names, so the heuristic takes either.
//!
//! Nothing here is hidden information: a hand is the one thing the heuristic
//! never looks at.

use wc_core::board::BoardSize;
use wc_core::types::{Board, ControlMap, PendingStep, Seat, Team};
use wc_core::units::{UnitId, UNIT_COUNT};
use wc_core::view::GameView;
use wc_core::GameState;

pub trait Position {
    fn size(&self) -> BoardSize;
    fn units(&self) -> &Board;
    fn control(&self) -> &ControlMap;
    fn pending(&self) -> &[PendingStep];
    fn team_of(&self, seat: Seat) -> Team;
    fn markers_remaining(&self, team: Team) -> i32;
    fn supply(&self, seat: Seat) -> &[u8; UNIT_COUNT];
    fn removed(&self, seat: Seat) -> &[u8; UNIT_COUNT];
    /// Where in the log this seat last maneuvered with that unit; 0 for never.
    fn recency(&self, seat: Seat, unit: UnitId) -> u32;
}

impl Position for GameState {
    #[inline]
    fn size(&self) -> BoardSize {
        self.size
    }
    #[inline]
    fn units(&self) -> &Board {
        &self.units
    }
    #[inline]
    fn control(&self) -> &ControlMap {
        &self.control
    }
    #[inline]
    fn pending(&self) -> &[PendingStep] {
        &self.pending
    }
    #[inline]
    fn team_of(&self, seat: Seat) -> Team {
        self.players[seat as usize].team
    }
    #[inline]
    fn markers_remaining(&self, team: Team) -> i32 {
        GameState::markers_remaining(self, team)
    }
    #[inline]
    fn supply(&self, seat: Seat) -> &[u8; UNIT_COUNT] {
        &self.players[seat as usize].supply
    }
    #[inline]
    fn removed(&self, seat: Seat) -> &[u8; UNIT_COUNT] {
        &self.players[seat as usize].removed
    }
    #[inline]
    fn recency(&self, seat: Seat, unit: UnitId) -> u32 {
        self.log.recency(seat, unit)
    }
}

impl Position for GameView {
    #[inline]
    fn size(&self) -> BoardSize {
        self.size
    }
    #[inline]
    fn units(&self) -> &Board {
        &self.units
    }
    #[inline]
    fn control(&self) -> &ControlMap {
        &self.control
    }
    #[inline]
    fn pending(&self) -> &[PendingStep] {
        &self.pending
    }
    #[inline]
    fn team_of(&self, seat: Seat) -> Team {
        self.players[seat as usize].team
    }
    #[inline]
    fn markers_remaining(&self, team: Team) -> i32 {
        self.players
            .iter()
            .find(|p| p.team == team)
            .map(|p| p.markers_remaining)
            .unwrap_or(0)
    }
    #[inline]
    fn supply(&self, seat: Seat) -> &[u8; UNIT_COUNT] {
        &self.players[seat as usize].supply
    }
    #[inline]
    fn removed(&self, seat: Seat) -> &[u8; UNIT_COUNT] {
        &self.players[seat as usize].removed
    }
    #[inline]
    fn recency(&self, seat: Seat, unit: UnitId) -> u32 {
        self.last_maneuver[seat as usize][unit as usize]
    }
}
