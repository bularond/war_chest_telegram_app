//! How far apart the difficulty levels actually are.
//!
//!   cargo run --release --bin ladder -- --budgets 60,250,1000 --games 60
//!
//! A level is a thinking budget. This plays the rungs against each other and
//! against the bots that need no budget at all, and prints what separates them.
//!
//! **Why it has to be re-run rather than remembered.** A budget in milliseconds
//! is not a difficulty, it is a difficulty *given how fast the code is* — so
//! every time the engine gets faster, every level gets stronger, and the ladder
//! has to be measured again. It just got about fifteen times faster.
//!
//! **What it cannot tell you.** Nothing here says whether a level is fun. The
//! only thing measured is one bot against another; where a human sits on this
//! ladder is a question for people playing the game. What this gives is the
//! spacing: rungs within a few Elo of each other are not three levels, whatever
//! the menu says.
//!
//! Options:
//!   --weights FILE    the evaluation the search uses  (default: the shipping one)
//!   --budgets LIST    milliseconds per move, comma separated  (default 60,250,1000)
//!   --games N         games per pairing, rounded to pairs     (default 60)
//!   --against LIST    named bots to measure the rungs against (default heuristic,greedy)
//!   --sets LIST       expansions, comma separated
//!   --jobs N          games in flight at once

use wc_bot::ismcts::Budget;
use wc_tooling::arena::{default_jobs, run_match, ArenaOptions};
use wc_tooling::args::*;
use wc_tooling::spec::{parse_spec, BotSpec};
use wc_tooling::stats::{elo_diff, percent};

fn main() {
    let weights = arg("weights", "");
    let rung = |ms: u64| -> BotSpec {
        let mut spec = if weights.is_empty() {
            BotSpec::named("ismcts").unwrap_or_else(|e| die(e))
        } else {
            parse_spec(&weights).unwrap_or_else(|e| die(e))
        };
        spec.name = format!("{ms}ms");
        spec
    };

    let budgets: Vec<u64> = arg("budgets", "60,250,1000")
        .split(',')
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.trim().parse().unwrap_or_else(|e| die(format!("--budgets {s}: {e}"))))
        .collect();
    let against: Vec<String> =
        arg("against", "heuristic,greedy").split(',').map(str::to_string).collect();

    let base = ArenaOptions {
        games: num("games", 60),
        seed: num("seed", 1),
        sets: sets("sets"),
        draft_mode: draft_mode("draft", "random"),
        max_plies: num("max-plies", 4000),
        budget: Budget::default(),
        budget_b: None,
        jobs: num("jobs", default_jobs()),
    };

    println!("each rung against the bots that need no clock at all");
    for ms in &budgets {
        for name in &against {
            let b = BotSpec::named(name).unwrap_or_else(|e| die(e));
            let opts = ArenaOptions {
                budget: Budget { ms: Some(*ms), iterations: None },
                // The other side has no search and no clock to give it.
                budget_b: Some(Budget::default()),
                ..base.clone()
            };
            report(&run_match(&rung(*ms), &b, &opts));
        }
    }

    println!();
    println!("and against the rung below it — the gap that makes a level a level");
    for pair in budgets.windows(2) {
        let (low, high) = (pair[0], pair[1]);
        let opts = ArenaOptions {
            budget: Budget { ms: Some(high), iterations: None },
            budget_b: Some(Budget { ms: Some(low), iterations: None }),
            ..base.clone()
        };
        report(&run_match(&rung(high), &rung(low), &opts));
    }
}

fn report(result: &wc_tooling::arena::MatchResult) {
    let s = result.per_pair;
    println!(
        "  {:>8} vs {:<12} {:>6} [{} … {}]  {:+5.0} elo   {:.0}/{:.0} ms per move",
        result.a,
        result.b,
        percent(s.mean, 1),
        percent(s.ci95.lo, 1),
        percent(s.ci95.hi, 1),
        elo_diff(s.mean),
        result.ms_per_move_a,
        result.ms_per_move_b,
    );
}
