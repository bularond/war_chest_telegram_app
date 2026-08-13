//! What the engine costs, in the units a search cares about.
//!
//!   cargo run --release --bin bench
//!   cargo run --release --bin bench -- --seconds 2 --sets nobility,siege,nightfall
//!
//! The headline number is rollouts per second: a determinization, then a dozen
//! plies of policy play, which is exactly one MCTS iteration minus the tree.
//! Everything above it in the table is there to say where the time went.

use std::time::{Duration, Instant};
use wc_bot::eval::{base_weights, evaluate};
use wc_bot::heuristic::{Heuristic, HeuristicWeights};
use wc_bot::ismcts::{Budget, SearchSettings, Searcher};
use wc_core::board::BoardSize;
use wc_core::engine::{apply_action, legal, legal_actions, Validate};
use wc_core::json::state_to_json;
use wc_core::observe::Determinizer;
use wc_core::playout::{random_policy, PlayoutOptions};
use wc_core::rng::Rng;
use wc_core::setup::{create_game, CreateGameOptions};
use wc_core::state::{hash_bytes, legal_moves_into, simulate};
use wc_core::types::*;
use wc_core::view::view_for;
use wc_tooling::args::*;

fn main() {
    let seconds: f64 = num("seconds", 1.0);
    let sets = sets("sets");
    let depth: u32 = num("depth", 12);

    // A position a few dozen plies in, so the board has something on it.
    let mut opts = PlayoutOptions::new(7);
    opts.sets = sets;
    let mut rng = Rng::new(11);
    let mut state = fresh(sets, 7);
    let mut legal_buf = Vec::with_capacity(128);
    for _ in 0..80 {
        if state.is_terminal() {
            break;
        }
        legal_moves_into(&state, &mut legal_buf);
        let action = match random_policy(&state, &mut rng, &legal_buf) {
            Some(a) => a,
            None => break,
        };
        let seat = state.acting_seat();
        apply_action(&mut state, seat, action, Validate::No).expect("bench move");
    }
    let _ = opts;

    println!("a position {} plies in, {} stacks on the board", 80, state.units.len());
    println!();
    println!("{:<28} {:>14} {:>12}", "operation", "per second", "each");

    let seat = state.acting_seat();
    let mut buf = Vec::with_capacity(128);
    bench("legal_actions", seconds, || {
        legal_actions(&state, seat, &mut buf);
        buf.len()
    });

    let one = legal(&state, seat)[0];
    bench("clone", seconds, || state.clone().units.len());
    bench("simulate (clone + apply)", seconds, || {
        simulate(&state, one, seat).map(|s| s.units.len()).unwrap_or(0)
    });
    bench("apply in place", seconds, || {
        let mut next = state.clone();
        apply_action(&mut next, seat, one, Validate::No).ok();
        next.units.len()
    });
    bench("view_for", seconds, || view_for(&state, seat, Vec::new()).players.len());
    bench("serialize + hash", seconds, || {
        hash_bytes(state_to_json(&state).to_string().as_bytes()).len()
    });

    let weights = base_weights();
    bench("evaluate", seconds, || evaluate(&state, seat, &weights) as usize);

    let view = view_for(&state, seat, legal(&state, seat));
    let mut det = Determinizer::new(&view).expect("determinizer");
    let mut sample = state.clone();
    bench("determinization", seconds, || {
        det.sample_into(&mut sample, &mut rng).ok();
        sample.players.len()
    });

    let mut heuristic = Heuristic::new(HeuristicWeights::default());
    bench("heuristic move", seconds, || {
        legal_moves_into(&state, &mut buf);
        let hand = state.players[seat as usize].hand.clone();
        heuristic.choose(&state, seat, state.phase, &buf, Some(&hand), &mut rng);
        buf.len()
    });

    // The headline: a determinization plus a dozen plies of policy play.
    bench("rollout", seconds, || {
        det.sample_into(&mut sample, &mut rng).ok();
        for _ in 0..depth {
            if sample.is_terminal() {
                break;
            }
            let s = sample.acting_seat();
            legal_moves_into(&sample, &mut buf);
            if buf.is_empty() {
                break;
            }
            let hand = sample.players[s as usize].hand.clone();
            let action = heuristic.choose(&sample, s, sample.phase, &buf, Some(&hand), &mut rng);
            if apply_action(&mut sample, s, action, Validate::No).is_err() {
                break;
            }
        }
        sample.units.len()
    });

    let mut searcher = Searcher::new(SearchSettings::default());
    let started = Instant::now();
    let mut iterations = 0u64;
    let mut searches = 0u64;
    while started.elapsed().as_secs_f64() < seconds {
        let report = searcher
            .run(&view, Budget { iterations: Some(200), ms: None }, &mut rng)
            .expect("search");
        iterations += report.iterations as u64;
        searches += 1;
    }
    let elapsed = started.elapsed().as_secs_f64();
    println!(
        "{:<28} {:>14} {:>12}",
        "search iteration",
        thousands((iterations as f64 / elapsed) as u64),
        each(elapsed / iterations as f64)
    );
    println!(
        "{:<28} {:>14} {:>12}",
        "search, 200 iterations",
        thousands((searches as f64 / elapsed) as u64),
        each(elapsed / searches as f64)
    );
}

fn fresh(sets: wc_core::units::SetMask, seed: u32) -> GameState {
    let mut create = CreateGameOptions::new(format!("bench-{seed}"), BoardSize::Duel, seed);
    create.sets = sets;
    create.draft_mode = DraftMode::Random;
    create.recording = false;
    create_game(&create).expect("bench game")
}

/// Runs `body` for about `seconds` and prints the rate. The return value is
/// summed and dropped, which is the cheapest way to stop the optimiser deciding
/// the work was pointless.
fn bench(name: &str, seconds: f64, mut body: impl FnMut() -> usize) {
    let started = Instant::now();
    let budget = Duration::from_secs_f64(seconds);
    let mut runs = 0u64;
    let mut sink = 0usize;
    // Checked in batches: reading the clock is not free either.
    loop {
        for _ in 0..64 {
            sink = sink.wrapping_add(body());
            runs += 1;
        }
        if started.elapsed() >= budget {
            break;
        }
    }
    std::hint::black_box(sink);
    let elapsed = started.elapsed().as_secs_f64();
    println!(
        "{:<28} {:>14} {:>12}",
        name,
        thousands((runs as f64 / elapsed) as u64),
        each(elapsed / runs as f64)
    );
}

fn thousands(n: u64) -> String {
    let text = n.to_string();
    let mut out = String::new();
    for (i, c) in text.chars().enumerate() {
        if i > 0 && (text.len() - i) % 3 == 0 {
            out.push(' ');
        }
        out.push(c);
    }
    out
}

fn each(seconds: f64) -> String {
    if seconds < 1e-6 {
        format!("{:.0} ns", seconds * 1e9)
    } else if seconds < 1e-3 {
        format!("{:.1} µs", seconds * 1e6)
    } else {
        format!("{:.2} ms", seconds * 1e3)
    }
}
