//! Runs one experiment on the evaluation weights and reports its verdict.
//!
//!   cargo run --release --bin sprt -- --a weights/base.json --b weights/idle.json
//!
//! Both sides get the same thinking time, the same seeds and the same deals; the
//! only difference on the table is the weights file. The match stops itself as
//! soon as the evidence is one-sided, and prints ACCEPT or REJECT — that verdict
//! is the decision. Nothing here is for a human to weigh up afterwards.
//!
//! Options:
//!   --a FILE --b FILE   weight files; B is the change being tested
//!   --budget-ms N       thinking time per move for both sides   (default 100)
//!   --iterations N      iterations per move instead of a clock, for a run that
//!                       reproduces bit for bit
//!   --max-games N       stop undecided after this many          (default 1000)
//!   --elo0 / --elo1     hypotheses, in Elo                      (default 0 / 10)
//!   --alpha / --beta    error rates                             (default 0.05)
//!   --sets LIST         expansions, comma separated
//!   --draft MODE        random | draft | ban                    (default random)
//!   --seed N            first pair's seed                       (default 1)
//!   --jobs N            games in flight at once  (default: cores minus two)
//!   --json              one line of JSON instead of a report

use rayon::prelude::*;
use serde_json::json;
use std::time::Instant;
use wc_bot::ismcts::Budget;
use wc_tooling::arena::{default_jobs, play_game, ArenaOptions};
use wc_tooling::args::*;
use wc_tooling::spec::parse_spec;
use wc_tooling::sprt::{sprt, SprtSettings, Verdict};
use wc_tooling::stats::{elo_diff, percent, score_stats};

fn main() {
    let a = parse_spec(&arg("a", "weights/base.json")).unwrap_or_else(|e| die(e));
    let b_arg = arg("b", "");
    if b_arg.is_empty() {
        die("nothing to test: pass --b <weights file>");
    }
    let b = parse_spec(&b_arg).unwrap_or_else(|e| die(e));

    let budget_ms: u64 = num("budget-ms", 100);
    let iterations: u32 = num("iterations", 0);
    let max_games: usize = num("max-games", 1000);
    let jobs: usize = num("jobs", default_jobs());
    let as_json = flag("json");

    let opts = ArenaOptions {
        games: max_games,
        seed: num("seed", 1),
        sets: sets("sets"),
        draft_mode: draft_mode("draft", "random"),
        max_plies: num("max-plies", 4000),
        budget: if iterations > 0 {
            Budget { ms: None, iterations: Some(iterations) }
        } else {
            Budget { ms: Some(budget_ms), iterations: None }
        },
        budget_b: None,
        jobs,
    };
    let settings = SprtSettings {
        elo0: num("elo0", 0.0),
        elo1: num("elo1", 10.0),
        alpha: num("alpha", 0.05),
        beta: num("beta", 0.05),
    };

    let pool =
        rayon::ThreadPoolBuilder::new().num_threads(jobs).build().unwrap_or_else(|e| die(e));
    let started = Instant::now();
    let max_pairs = max_games.div_ceil(2);
    // A batch is a jobful of pairs: the verdict is only worth checking when
    // enough new evidence has arrived to move it, and every core should be busy
    // until then.
    let batch = jobs.max(1);

    let mut pair_scores: Vec<f64> = Vec::with_capacity(max_pairs);
    let mut scores: Vec<f64> = Vec::with_capacity(max_pairs * 2);
    let mut state = sprt(&pair_scores, settings);

    let mut done = 0usize;
    while done < max_pairs {
        let take = batch.min(max_pairs - done);
        let results: Vec<(f64, f64, f64)> = pool.install(|| {
            (done..done + take)
                .into_par_iter()
                // B is the change under test and plays both sides of every
                // deal, so it is the side the score is written for.
                .map_init(
                    || (b.build(), a.build()),
                    |(bot_b, bot_a), pair| {
                        let seed = opts.seed + pair as u32;
                        let first = play_game(bot_b, bot_a, 0, seed, &opts);
                        let second = play_game(bot_b, bot_a, 1, seed, &opts);
                        (
                            (first.score_a + second.score_a) / 2.0,
                            first.score_a,
                            second.score_a,
                        )
                    },
                )
                .collect()
        });
        for (pair, first, second) in results {
            pair_scores.push(pair);
            scores.push(first);
            scores.push(second);
        }
        done += take;

        state = sprt(&pair_scores, settings);
        if state.verdict != Verdict::Continue {
            break;
        }
        if !as_json {
            eprint!(
                "\r{} games, score {}, llr {:+.2} of [{:.2} … {:.2}]   ",
                scores.len(),
                percent(state.mean, 1),
                state.llr,
                state.lower,
                state.upper
            );
        }
    }

    let per_game = score_stats(&scores);
    let seconds = started.elapsed().as_secs_f64();

    if as_json {
        println!(
            "{}",
            json!({
                "a": a.name,
                "b": b.name,
                "verdict": state.verdict.key(),
                "games": scores.len(),
                "pairs": state.n,
                "score": per_game.mean,
                "elo": elo_diff(per_game.mean),
                "llr": state.llr,
                "lower": state.lower,
                "upper": state.upper,
                "seconds": seconds,
            })
        );
        return;
    }

    eprintln!();
    println!("{} vs {}", a.name, b.name);
    println!(
        "  {} games in {} pairs, {:.1}s on {jobs} threads",
        scores.len(),
        state.n,
        seconds
    );
    println!(
        "  score for {}: {} [{} … {}]",
        b.name,
        percent(per_game.mean, 1),
        percent(per_game.ci95.lo, 1),
        percent(per_game.ci95.hi, 1)
    );
    println!("  elo {:+.0}", elo_diff(per_game.mean));
    println!(
        "  llr {:+.2} against [{:.2} … {:.2}]",
        state.llr, state.lower, state.upper
    );
    println!(
        "  {}",
        match state.verdict {
            Verdict::Accept => "ACCEPT — keep the change",
            Verdict::Reject => "REJECT — put it back",
            Verdict::Continue =>
                "UNDECIDED — the games ran out before the evidence did. Not a result: \
                 either run it longer or drop the change.",
        }
    );
    // An undecided test is not a licence to keep the change.
    std::process::exit(if state.verdict == Verdict::Accept { 0 } else { 1 });
}
