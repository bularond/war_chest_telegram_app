//! One command that compares two bots.
//!
//!   cargo run --release --bin arena -- --a heuristic --b greedy --games 200
//!   cargo run --release --bin arena -- --a heuristic --b greedy --sets nobility,siege
//!
//! Options:
//!   --a NAME --b NAME   which bots, by registry name or weights file
//!   --games N           total games, rounded up to whole pairs   (default 100)
//!   --seed N            first pair's seed                        (default 1)
//!   --sets LIST         comma separated expansions
//!   --draft MODE        random | draft | ban                     (default random)
//!   --budget-ms N       time allowance per move
//!   --iterations N      search iterations per move, instead of a clock
//!   --max-plies N       give a game up after this many plies     (default 4000)
//!   --jobs N            games in flight at once   (default: cores minus two)

use wc_bot::ismcts::Budget;
use wc_tooling::arena::{default_jobs, run_match, ArenaOptions};
use wc_tooling::args::*;
use wc_tooling::spec::parse_spec;
use wc_tooling::stats::{elo_diff, elo_interval, percent};

fn main() {
    let a = parse_spec(&arg("a", "heuristic")).unwrap_or_else(|e| die(e));
    let b = parse_spec(&arg("b", "greedy")).unwrap_or_else(|e| die(e));

    let budget_ms: u64 = num("budget-ms", 0);
    let iterations: u32 = num("iterations", 0);
    let opts = ArenaOptions {
        games: num("games", 100),
        seed: num("seed", 1),
        sets: sets("sets"),
        draft_mode: draft_mode("draft", "random"),
        max_plies: num("max-plies", 4000),
        budget: Budget {
            ms: if budget_ms > 0 { Some(budget_ms) } else { None },
            iterations: if iterations > 0 { Some(iterations) } else { None },
        },
        budget_b: None,
        jobs: num("jobs", default_jobs()),
    };

    let result = run_match(&a, &b, &opts);
    let per_pair = result.per_pair;
    let elo = elo_interval(per_pair.ci95);

    println!("{} vs {}", result.a, result.b);
    println!(
        "  {} games in {} pairs, {:.1}s on {} threads",
        result.games.len(),
        per_pair.n,
        result.seconds,
        opts.jobs
    );
    println!(
        "  {}-{}-{}  (A wins, B wins, draws){}",
        result.wins_a,
        result.wins_b,
        result.draws,
        if result.ply_capped > 0 {
            format!(", {} hit the ply cap", result.ply_capped)
        } else {
            String::new()
        }
    );
    println!(
        "  score {} [{} … {}] per pair",
        percent(per_pair.mean, 1),
        percent(per_pair.ci95.lo, 1),
        percent(per_pair.ci95.hi, 1)
    );
    println!(
        "  elo   {:+.0} [{:+.0} … {:+.0}]",
        elo_diff(per_pair.mean),
        elo.lo,
        elo.hi
    );
    println!(
        "  {:.1} ms/move A, {:.1} ms/move B, {} plies",
        result.ms_per_move_a, result.ms_per_move_b, result.plies
    );
}
