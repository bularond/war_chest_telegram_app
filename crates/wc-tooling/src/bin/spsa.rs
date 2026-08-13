//! Moves every weight at once, and hands the result to a sequential test.
//!
//!   cargo run --release --bin spsa -- --from weights/base.json --out weights/spsa.json
//!
//! Two matches per step, however long the vector is: kick every weight in a
//! random direction, see which of the two kicked versions plays better, step the
//! whole vector that way. What comes out is a **candidate**, not a baseline —
//! nothing here decides anything. Take it to `sprt`.
//!
//! Options:
//!   --from FILE       weights to start from        (default weights/base.json)
//!   --out FILE        where the candidate goes     (default weights/spsa.json)
//!   --steps N         SPSA steps                   (default 40)
//!   --games N         games per step, both halves  (default 40)
//!   --iterations N    search iterations per move   (default 200, reproducible)
//!   --budget-ms N     milliseconds per move instead of iterations
//!   --a / --c         step size and perturbation, as fractions
//!   --sets LIST       expansions, comma separated
//!   --jobs N          games in flight at once

use std::path::PathBuf;
use wc_bot::eval::{EvalWeights, FEATURES, FEATURE_COUNT};
use wc_bot::ismcts::{Budget, SearchSettings};
use wc_core::rng::Rng;
use wc_tooling::arena::{default_jobs, run_match, ArenaOptions};
use wc_tooling::args::*;
use wc_tooling::spec::BotSpec;
use wc_tooling::spsa::{gains, perturb, step, tunable, SpsaSettings};
use wc_tooling::stats::percent;

fn main() {
    let from = wc_tooling::paths::resolve(&arg("from", "weights/base.json"));
    let out: PathBuf = wc_tooling::paths::resolve(&arg("out", "weights/spsa.json"));
    let text = std::fs::read_to_string(&from)
        .unwrap_or_else(|e| die(format!("{}: {e}", from.display())));
    let start = EvalWeights::from_json(
        &serde_json::from_str(&text).unwrap_or_else(|e| die(format!("{}: {e}", from.display()))),
    );

    let settings = SpsaSettings {
        a: num("a", 0.08),
        c: num("c", 0.12),
        steps: num("steps", 40),
        fixed: vec!["markers".into()],
    };
    let movable = tunable(&start, &settings);
    if movable.is_empty() {
        die("nothing to tune: every weight is zero or anchored");
    }
    println!(
        "tuning {} weights: {}",
        movable.len(),
        movable.iter().map(|i| FEATURES[*i]).collect::<Vec<_>>().join(", ")
    );

    let iterations: u32 = num("iterations", 200);
    let budget_ms: u64 = num("budget-ms", 0);
    let base = ArenaOptions {
        games: num("games", 40),
        seed: num("seed", 1),
        sets: sets("sets"),
        draft_mode: draft_mode("draft", "random"),
        max_plies: num("max-plies", 4000),
        budget: if budget_ms > 0 {
            Budget { ms: Some(budget_ms), iterations: None }
        } else {
            Budget { ms: None, iterations: Some(iterations) }
        },
        budget_b: None,
        jobs: num("jobs", default_jobs()),
    };

    let mut weights = start.clone();
    // The direction is drawn from a stream of its own, so a run replays exactly.
    let mut rng = Rng::new(num("seed", 1u32).wrapping_mul(2_654_435_761));

    for k in 0..settings.steps {
        let (a, c) = gains(k, &settings);
        let mut delta = [0.0; FEATURE_COUNT];
        for i in &movable {
            delta[*i] = if rng.next_int(2) == 0 { -1.0 } else { 1.0 };
        }
        let up = spec(&weights, &delta, c, 1.0, "up", iterations);
        let down = spec(&weights, &delta, c, -1.0, "down", iterations);

        // Each step gets its own block of seeds. Sharing them would let a step
        // be judged on the deals that suited the last one.
        let opts = ArenaOptions { seed: base.seed + (k as u32) * 10_000, ..base.clone() };
        let result = run_match(&up, &down, &opts);
        let score = result.per_pair.mean;
        weights = step(&weights, &delta, score, a);

        println!(
            "  step {:>3}  up scored {}  a={:.4} c={:.4}  {}",
            k + 1,
            percent(score, 1),
            a,
            c,
            movable
                .iter()
                .map(|i| format!("{}={:.3}", FEATURES[*i], weights.w[*i]))
                .collect::<Vec<_>>()
                .join(" ")
        );
    }

    weights.version = format!("{}+spsa{}", start.version, settings.steps);
    let text = serde_json::to_string_pretty(&weights.to_json()).unwrap_or_else(|e| die(e));
    std::fs::write(&out, format!("{text}\n")).unwrap_or_else(|e| die(format!("{}: {e}", out.display())));
    println!();
    println!("{} — a candidate, not a baseline. Take it to sprt:", out.display());
    println!("  cargo run --release --bin sprt -- --a {} --b {}", from.display(), out.display());
}

fn spec(
    weights: &EvalWeights,
    delta: &[f64; FEATURE_COUNT],
    c: f64,
    sign: f64,
    name: &str,
    iterations: u32,
) -> BotSpec {
    let mut spec = BotSpec::named("ismcts").expect("ismcts");
    spec.name = name.to_string();
    spec.settings = SearchSettings {
        weights: perturb(weights, delta, c, sign),
        iterations,
        ..spec.settings
    };
    spec
}
