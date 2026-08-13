//! Bot versus bot, in pairs.
//!
//! Half the variance in War Chest comes from the deal and the draw, not from
//! play. So games are run in pairs: the same seed twice, sides swapped, so both
//! bots get the same units, the same bag order and the same opening. What is
//! left between the two halves of a pair is the play.

use crate::spec::BotSpec;
use crate::stats::{score_stats, ScoreStats};
use rayon::prelude::*;
use std::time::Instant;
use wc_bot::ismcts::Budget;
use wc_core::board::BoardSize;
use wc_core::engine::{apply_action, legal, Validate};
use wc_core::rng::Rng;
use wc_core::setup::{create_game, CreateGameOptions};
use wc_core::types::*;
use wc_core::units::SetMask;
use wc_core::view::view_for;

const DEFAULT_MAX_PLIES: usize = 4000;

#[derive(Clone, Debug)]
pub struct ArenaOptions {
    /// Total games. Rounded up to an even number: pairs are the unit here.
    pub games: usize,
    pub seed: u32,
    pub sets: SetMask,
    /// `Random` deals the units from the seed, which keeps the draft out of the
    /// measurement. Use `Draft` when the drafting itself is what is tested.
    pub draft_mode: DraftMode,
    pub max_plies: usize,
    pub budget: Budget,
    /// What bot B is allowed to think, when it is not the same as A.
    ///
    /// Two bots on the same budget is what an experiment wants: the only
    /// difference on the table should be the change under test. A *ladder* wants
    /// the opposite — the difficulty levels of this game differ in nothing but
    /// how long they think.
    pub budget_b: Option<Budget>,
    /// Threads. Matches are measured in wall-clock time, so leaving a couple of
    /// cores free is not politeness: a core the pool takes is a core the bot on
    /// it does not get.
    pub jobs: usize,
}

impl Default for ArenaOptions {
    fn default() -> ArenaOptions {
        ArenaOptions {
            games: 100,
            seed: 1,
            sets: SetMask::base(),
            draft_mode: DraftMode::Random,
            max_plies: DEFAULT_MAX_PLIES,
            budget: Budget::default(),
            budget_b: None,
            jobs: default_jobs(),
        }
    }
}

pub fn default_jobs() -> usize {
    std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).saturating_sub(2).max(1)
}

#[derive(Copy, Clone, PartialEq, Eq, Debug)]
pub enum GameEnding {
    Win,
    Stalemate,
    PlyCap,
}

#[derive(Copy, Clone, Debug)]
pub struct GameOutcome {
    pub pair: usize,
    pub seed: u32,
    /// Which seat A played in this half of the pair.
    pub a_seat: Seat,
    pub score_a: f64,
    pub ending: GameEnding,
    pub plies: usize,
    pub micros_a: u128,
    pub micros_b: u128,
    pub decisions_a: usize,
    pub decisions_b: usize,
}

#[derive(Clone, Debug)]
pub struct MatchResult {
    pub a: String,
    pub b: String,
    pub games: Vec<GameOutcome>,
    /// Per game, a win for A counting 1 and a draw 0.5.
    pub per_game: ScoreStats,
    /// Per pair — the honest interval, since the two halves share a deal.
    pub per_pair: ScoreStats,
    pub pair_scores: Vec<f64>,
    pub wins_a: usize,
    pub wins_b: usize,
    pub draws: usize,
    pub ply_capped: usize,
    pub plies: usize,
    pub seconds: f64,
    pub ms_per_move_a: f64,
    pub ms_per_move_b: f64,
}

/// One game. `a_seat` decides which side bot A sits on; everything else about
/// the game is fixed by the seed, so the two halves of a pair start identically.
pub fn play_game(
    a: &mut wc_bot::Player,
    b: &mut wc_bot::Player,
    a_seat: Seat,
    seed: u32,
    opts: &ArenaOptions,
) -> GameOutcome {
    let mut create = CreateGameOptions::new(format!("arena-{seed}-{a_seat}"), BoardSize::Duel, seed);
    create.sets = opts.sets;
    create.draft_mode = opts.draft_mode;
    // The log is what the client reads; a match never looks at it, and the one
    // thing the heuristic wants out of it is tracked without it.
    create.recording = false;
    let mut state = create_game(&create).expect("arena game");

    // Each side gets its own stream, derived from the game seed, so a rerun of
    // the same match makes the same moves.
    let mut rng_a = Rng::new(seed.wrapping_mul(2).wrapping_add(1));
    let mut rng_b = Rng::new(seed.wrapping_mul(2).wrapping_add(2));
    let budget_b = opts.budget_b.unwrap_or(opts.budget);

    let mut plies = 0;
    let mut micros_a = 0u128;
    let mut micros_b = 0u128;
    let mut decisions_a = 0;
    let mut decisions_b = 0;

    while state.phase != Phase::Finished && plies < opts.max_plies {
        let seat = state.acting_seat();
        let is_a = seat == a_seat;
        let view = view_for(&state, seat, legal(&state, seat));
        if view.legal.is_empty() {
            break;
        }

        let started = Instant::now();
        let action = if is_a {
            a.choose(&view, opts.budget, &mut rng_a)
        } else {
            b.choose(&view, budget_b, &mut rng_b)
        };
        let spent = started.elapsed().as_micros();
        if is_a {
            micros_a += spent;
            decisions_a += 1;
        } else {
            micros_b += spent;
            decisions_b += 1;
        }

        // The arena owns this state, so it advances in place — no copy per ply.
        apply_action(&mut state, seat, action, Validate::Yes).expect("arena move");
        plies += 1;
    }

    let ending = if state.phase != Phase::Finished {
        GameEnding::PlyCap
    } else if state.winner.is_none() {
        GameEnding::Stalemate
    } else {
        GameEnding::Win
    };
    // A duel has one player per team, so team and seat coincide.
    let score_a = match state.winner {
        None => 0.5,
        Some(team) if team == a_seat => 1.0,
        Some(_) => 0.0,
    };

    GameOutcome {
        pair: 0,
        seed,
        a_seat,
        score_a,
        ending,
        plies,
        micros_a,
        micros_b,
        decisions_a,
        decisions_b,
    }
}

/// A whole match, over `jobs` threads.
///
/// The result is identical whatever the thread count when both budgets are in
/// iterations: a pair is independent of every other pair, and each side's rng is
/// derived from the seed. With a budget in milliseconds it is not, and cannot
/// be — that is what a wall-clock budget means.
pub fn run_match(a: &BotSpec, b: &BotSpec, opts: &ArenaOptions) -> MatchResult {
    let pairs = opts.games.div_ceil(2);
    let started = Instant::now();

    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(opts.jobs)
        .build()
        .expect("thread pool");

    let halves: Vec<(usize, GameOutcome, GameOutcome)> = pool.install(|| {
        (0..pairs)
            .into_par_iter()
            .map_init(
                || (a.build(), b.build()),
                |(bot_a, bot_b), pair| {
                    let seed = opts.seed + pair as u32;
                    let first = GameOutcome { pair, ..play_game(bot_a, bot_b, 0, seed, opts) };
                    let second = GameOutcome { pair, ..play_game(bot_a, bot_b, 1, seed, opts) };
                    (pair, first, second)
                },
            )
            .collect()
    });

    let mut games = Vec::with_capacity(pairs * 2);
    let mut pair_scores = Vec::with_capacity(pairs);
    let mut sorted = halves;
    sorted.sort_by_key(|(pair, _, _)| *pair);
    for (_, first, second) in sorted {
        pair_scores.push((first.score_a + second.score_a) / 2.0);
        games.push(first);
        games.push(second);
    }

    summarize(&a.name, &b.name, games, pair_scores, started.elapsed().as_secs_f64())
}

/// The same summary, over games played wherever — one core or twelve.
pub fn summarize(
    a_name: &str,
    b_name: &str,
    games: Vec<GameOutcome>,
    pair_scores: Vec<f64>,
    seconds: f64,
) -> MatchResult {
    let micros_a: u128 = games.iter().map(|g| g.micros_a).sum();
    let micros_b: u128 = games.iter().map(|g| g.micros_b).sum();
    let decisions_a: usize = games.iter().map(|g| g.decisions_a).sum();
    let decisions_b: usize = games.iter().map(|g| g.decisions_b).sum();
    let scores: Vec<f64> = games.iter().map(|g| g.score_a).collect();

    MatchResult {
        a: a_name.to_string(),
        b: b_name.to_string(),
        per_game: score_stats(&scores),
        per_pair: score_stats(&pair_scores),
        wins_a: games.iter().filter(|g| g.score_a == 1.0).count(),
        wins_b: games.iter().filter(|g| g.score_a == 0.0).count(),
        draws: games.iter().filter(|g| g.score_a == 0.5).count(),
        ply_capped: games.iter().filter(|g| g.ending == GameEnding::PlyCap).count(),
        plies: games.iter().map(|g| g.plies).sum(),
        seconds,
        ms_per_move_a: if decisions_a == 0 {
            0.0
        } else {
            micros_a as f64 / decisions_a as f64 / 1000.0
        },
        ms_per_move_b: if decisions_b == 0 {
            0.0
        } else {
            micros_b as f64 / decisions_b as f64 / 1000.0
        },
        pair_scores,
        games,
    }
}
