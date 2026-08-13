//! The War Chest rules, in Rust.
//!
//! `wc-core` is what `@wc/shared` was: the whole game and nothing else. It has no
//! dependency on a server, a browser or a bot, and it never allocates on a path
//! the search runs millions of times.

pub mod board;
pub mod catalog;
pub mod invariants;
pub mod json;
pub mod observe;
pub mod playout;
pub mod state;
pub mod view;
pub mod decrees;
pub mod engine;
pub mod hex;
pub mod rng;
pub mod setup;
pub mod types;
pub mod units;

pub use board::{BoardSize, HexIdx};
pub use decrees::{DecreeId, DecreeInPlay};
pub use engine::{apply_action, legal, legal_actions, legal_moves, Validate};
pub use rng::Rng;
pub use setup::{create_game, CreateGameOptions};
pub use types::*;
pub use units::{CoinId, SetMask, UnitId, UnitSet};
