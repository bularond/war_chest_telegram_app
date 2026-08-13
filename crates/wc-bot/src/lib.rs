//! The computer opponents.
//!
//! A bot sees what a player sees and returns one of the actions the engine
//! offered. Nothing here is allowed to read a bag or an opponent's hand: to look
//! ahead it samples a determinization, exactly as a player guesses.

pub mod baseline;
pub mod board_sense;
pub mod eval;
pub mod heuristic;
pub mod ismcts;
pub mod player;
pub mod position;
pub mod unit_worth;

pub use eval::{base_weights, evaluate, feature_vector, EvalWeights, FEATURES};
pub use heuristic::{DraftBy, Heuristic, HeuristicWeights};
pub use ismcts::{best_of, merge_reports, Budget, RootStat, SearchReport, SearchSettings, Searcher};
pub use player::{player_named, Player, BOT_BUILD};
pub use position::Position;
