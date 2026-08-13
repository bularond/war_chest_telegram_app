//! Offline instruments: matches, sequential tests, weight fitting.
//!
//! Nothing here touches a network or a database. Everything is a command-line
//! program that plays games and prints a number with an interval on it.

pub mod arena;
pub mod args;
pub mod paths;
pub mod spec;
pub mod regress;
pub mod spsa;
pub mod sprt;
pub mod stats;
