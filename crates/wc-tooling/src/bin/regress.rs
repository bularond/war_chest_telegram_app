//! Fits every weight at once, from games nobody had to search in.
//!
//!   cargo run --release --bin regress -- --games 5000 --out weights/fitted.json
//!   cargo run --release --bin regress -- --target value --games 250 --out weights/fitted-value.json
//!
//! Two targets, and the difference between them matters more than the fit does.
//!
//! `outcome` fits who won. That maximises how well the vector predicts the
//! winner — and the win condition predicts the winner better than anything, so
//! the fit shrinks every other feature next to `markers`. It reads well and
//! steers badly: an evaluation that says little but "who is closer to winning"
//! gives the search nothing to work with in the middlegame, which is exactly
//! where it needs help.
//!
//! `value` fits the search's own backed-up valuation of the position. Not
//! circular: the search saw further than the evaluation did, so this pulls what
//! the search knows down into the function it starts from. It is TD-leaf.
//!
//! Either way the answer is a **candidate**. Take it to `sprt`.
//!
//! Options:
//!   --target NAME     outcome | value                (default outcome)
//!   --games N         games to collect from          (default 2000, or 250 for value)
//!   --weights FILE    the evaluation the search plays with, for `--target value`
//!   --iterations N    search iterations per position, for `--target value` (default 200)
//!   --out FILE        where the candidate goes       (default weights/fitted.json)
//!   --sets LIST       expansions, comma separated
//!   --jobs N          games in flight at once

use rayon::prelude::*;
use wc_bot::eval::{f, feature_vector, weights_from_fit, FEATURES, FEATURE_COUNT};
use wc_bot::ismcts::{Budget, SearchSettings, Searcher};
use wc_bot::{Heuristic, HeuristicWeights};
use wc_core::board::BoardSize;
use wc_core::engine::{apply_action, legal, Validate};
use wc_core::rng::Rng;
use wc_core::setup::{create_game, CreateGameOptions};
use wc_core::state::legal_moves_into;
use wc_core::types::{DraftMode, GameState, Phase};
use wc_core::units::SetMask;
use wc_core::view::view_for;
use wc_tooling::args::*;
use wc_tooling::regress::{fit, fit_to_values, log_loss, normalize, FitSettings, Sample};

fn main() {
    let target = arg("target", "outcome");
    let value_target = target == "value";
    if !value_target && target != "outcome" {
        die("--target is outcome or value");
    }
    let games: u32 = num("games", if value_target { 250 } else { 2000 });
    let jobs: usize = num("jobs", wc_tooling::arena::default_jobs());
    let sets = sets("sets");
    let iterations: u32 = num("iterations", 200);
    let out = wc_tooling::paths::resolve(&arg("out", "weights/fitted.json"));

    let mut settings = SearchSettings { iterations, ..SearchSettings::default() };
    let weights_arg = arg("weights", "");
    if !weights_arg.is_empty() {
        let path = wc_tooling::paths::resolve(&weights_arg);
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| die(format!("{}: {e}", path.display())));
        settings.weights = wc_bot::eval::EvalWeights::from_json(
            &serde_json::from_str(&text).unwrap_or_else(|e| die(e)),
        );
    }

    let pool = rayon::ThreadPoolBuilder::new().num_threads(jobs).build().unwrap_or_else(|e| die(e));
    let seed_base: u32 = num("seed", 1);
    let samples: Vec<Sample> = pool.install(|| {
        (0..games)
            .into_par_iter()
            .flat_map_iter(|g| collect(seed_base + g, sets, value_target, &settings).into_iter())
            .collect()
    });

    if samples.is_empty() {
        die("no positions collected");
    }
    let fit_settings = FitSettings::default();
    let raw = if value_target { fit_to_values(&samples, fit_settings) } else { fit(&samples, fit_settings) };
    let scaled = normalize(&raw, f::MARKERS);
    let weights = weights_from_fit(&scaled, &format!("fit@{target}-{games}"));

    println!("{} positions from {games} games", samples.len());
    if !value_target {
        println!("log loss {:.4}", log_loss(&samples, &raw));
    }
    for (i, name) in FEATURES.iter().enumerate() {
        if weights.w[i] != 0.0 {
            println!("  {name:<16} {:>9.4}", weights.w[i]);
        }
    }

    let text = serde_json::to_string_pretty(&weights.to_json()).unwrap_or_else(|e| die(e));
    std::fs::write(&out, format!("{text}\n"))
        .unwrap_or_else(|e| die(format!("{}: {e}", out.display())));
    println!();
    println!("{} — a candidate, not a baseline. Take it to sprt.", out.display());
}

/// One game's worth of positions.
///
/// The heuristic plays it: the point of this tuner is that the games are cheap,
/// and a searching game costs a thousand times what a policy game does. For the
/// value target the search is asked what it thinks of the position, which is the
/// expensive half and is why that mode wants a tenth of the games.
fn collect(seed: u32, sets: SetMask, value_target: bool, settings: &SearchSettings) -> Vec<Sample> {
    let mut create = CreateGameOptions::new(format!("regress-{seed}"), BoardSize::Duel, seed);
    create.sets = sets;
    create.draft_mode = DraftMode::Random;
    create.recording = false;
    let mut state = match create_game(&create) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };

    let mut rng = Rng::new(seed.wrapping_mul(2_246_822_519).wrapping_add(1));
    let mut policy = Heuristic::new(HeuristicWeights::default());
    let mut searcher = if value_target { Some(Searcher::new(settings.clone())) } else { None };
    let mut buf = Vec::with_capacity(96);
    let mut positions: Vec<([f64; FEATURE_COUNT], f64)> = Vec::new();

    let mut plies = 0;
    while state.phase != Phase::Finished && plies < 1200 {
        let seat = state.acting_seat();
        legal_moves_into(&state, &mut buf);
        if buf.is_empty() {
            break;
        }
        // Always written for seat 0, so the label means one thing throughout.
        let features = feature_vector(&state, 0);
        if let Some(search) = searcher.as_mut() {
            // The search's own valuation, from seat 0's side of the table.
            let view = view_for(&state, seat, legal(&state, seat));
            if view.legal.len() > 1 {
                if let Ok(report) = search.run(&view, Budget { ms: None, iterations: Some(settings.iterations) }, &mut rng) {
                    let mine = state.players[seat as usize].team == state.players[0].team;
                    positions.push((features, if mine { report.value } else { -report.value }));
                }
            }
        } else {
            positions.push((features, 0.0));
        }

        let hand = state.players[seat as usize].hand.clone();
        let action = policy.choose(&state, seat, state.phase, &buf, Some(&hand), &mut rng);
        if apply_action(&mut state, seat, action, Validate::No).is_err() {
            break;
        }
        plies += 1;
    }

    if positions.is_empty() {
        return Vec::new();
    }
    // A game contributes one unit however long it ran: positions inside one game
    // are anything but independent, and a long game is not more evidence.
    let weight = 1.0 / positions.len() as f64;
    let outcome = outcome_for(&state, 0);
    positions
        .into_iter()
        .map(|(features, value)| Sample {
            features,
            target: if value_target { value } else { outcome },
            weight,
        })
        .collect()
}

fn outcome_for(state: &GameState, seat: u8) -> f64 {
    match state.winner {
        None => 0.5,
        Some(team) => {
            if team == state.players[seat as usize].team {
                1.0
            } else {
                0.0
            }
        }
    }
}

