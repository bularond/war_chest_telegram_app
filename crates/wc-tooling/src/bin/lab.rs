//! A queue of experiments, run without anybody watching.
//!
//!   cargo run --release --bin lab -- --plan weights/night.plan.json --out weights/lab --resume
//!
//! One experiment at a time: read the plan, resolve the proposal against the
//! current baseline, play a sequential test, write the verdict. An accepted
//! change becomes the baseline for the next one; a rejected one is forgotten.
//! The plan is read again before every experiment, so proposals can be appended
//! while it runs.
//!
//! **Nothing here decides anything.** The verdict is the sequential test's, and
//! the test's thresholds are in the code. What the lab adds is only that nobody
//! has to sit with it.
//!
//! Three files, and `scripts/lab-watch.mjs` and `lab-report.mjs` read them:
//!
//!   <out>.json            the current baseline
//!   <out>.journal.json    every verdict, in order
//!   <out>.heartbeat.json  rewritten after every batch of games
//!
//! Options:
//!   --plan FILE       the queue                        (default weights/night.plan.json)
//!   --out PREFIX      where the three files go         (default weights/lab)
//!   --from FILE       what the first experiment starts from (default weights/base.json)
//!   --resume          keep the journal and the baseline that are already there
//!   --budget-ms N     thinking time per move           (default 250)
//!   --iterations N    iterations per move instead of a clock — reproducible
//!   --max-games N     give an experiment up after this many  (default 800)
//!   --max-minutes N   …or after this long                    (default 40)
//!   --jobs N          games in flight at once

use std::path::{Path, PathBuf};
use std::time::Instant;

use rayon::prelude::*;
use serde_json::{json, Value};
use wc_bot::eval::EvalWeights;
use wc_bot::ismcts::Budget;
use wc_tooling::arena::{default_jobs, play_game, ArenaOptions};
use wc_tooling::args::*;
use wc_tooling::lab::{config_to_json, read_knobs, read_plan, resolve, settings_for, Config, Knobs, Proposal};
use wc_tooling::spec::BotSpec;
use wc_tooling::sprt::{sprt, SprtSettings, Verdict};
use wc_tooling::stats::{elo_diff, percent, score_stats};

fn main() {
    let plan_path = wc_tooling::paths::resolve(&arg("plan", "weights/night.plan.json"));
    let prefix = wc_tooling::paths::resolve(&arg("out", "weights/lab"));
    let from = wc_tooling::paths::resolve(&arg("from", "weights/base.json"));
    let resume = flag("resume");

    let jobs: usize = num("jobs", default_jobs());
    let budget_ms: u64 = num("budget-ms", 250);
    let iterations: u32 = num("iterations", 0);
    let max_games: usize = num("max-games", 800);
    let max_minutes: f64 = num("max-minutes", 40.0);

    // The night's starting point, kept so `against: "root"` has something to
    // measure the whole run against.
    let root = load(&from).unwrap_or_else(|e| die(e));
    let mut journal = if resume { read_journal(&prefix) } else { Journal::new(&root) };
    let mut base = if resume {
        load(&baseline_path(&prefix)).unwrap_or_else(|_| root.clone())
    } else {
        root.clone()
    };
    if !resume {
        write_config(&baseline_path(&prefix), &base);
    }

    println!("lab: {} → {}", plan_path.display(), prefix.display());
    println!("  starting from {}", base.weights.version);
    println!("  {} done already", journal.done.len());

    loop {
        // Read again every time: the plan may have grown since the last one.
        let plan = match std::fs::read_to_string(&plan_path)
            .map_err(|e| e.to_string())
            .and_then(|t| serde_json::from_str::<Value>(&t).map_err(|e| e.to_string()))
            .and_then(|v| read_plan(&v))
        {
            Ok(p) => p,
            Err(e) => die(format!("{}: {e}", plan_path.display())),
        };

        let next = plan.into_iter().find(|p| !journal.seen(&p.id));
        let proposal = match next {
            Some(p) => p,
            None => break,
        };

        println!();
        println!("── {} ─────────────────────────────", proposal.id);
        if let Some(note) = &proposal.note {
            println!("   {note}");
        }

        let entry = if proposal.against_root {
            confirm(&proposal, &base, &root, budget_ms, iterations, max_games, max_minutes, jobs, &prefix)
        } else {
            match resolve(&base, &proposal) {
                None => {
                    // The trap this exists for: a proposal that names what the
                    // baseline already holds would play several hundred games
                    // between two identical bots and report a REJECT that reads
                    // like a verdict.
                    println!("   nothing to change — the baseline already holds this");
                    Entry::nothing(&proposal.id)
                }
                Some(resolved) => {
                    println!("   {}", resolved.change);
                    let entry = experiment(
                        &proposal,
                        &base,
                        &resolved.config,
                        &resolved.change,
                        budget_ms,
                        iterations,
                        max_games,
                        max_minutes,
                        jobs,
                        &prefix,
                    );
                    if entry.verdict == "accept" {
                        base = resolved.config;
                        write_config(&baseline_path(&prefix), &base);
                        journal.accepts += 1;
                    }
                    entry
                }
            }
        };

        println!(
            "   {} — {} games, {}",
            entry.verdict.to_uppercase(),
            entry.games,
            if entry.games > 0 { percent(entry.score, 1) } else { "—".into() }
        );
        journal.done.push(entry);
        journal.baseline_version = base.weights.version.clone();
        write_journal(&prefix, &journal);
    }

    heartbeat(&prefix, "", 0, 0.0, 0.0, true);
    println!();
    println!("the queue is empty: {} experiments, {} steps taken", journal.done.len(), journal.accepts);
    println!("  node scripts/lab-report.mjs {}", prefix.display());
}

// ---------------------------------------------------------------------------
// One experiment
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
fn experiment(
    proposal: &Proposal,
    base: &Config,
    candidate: &Config,
    change: &str,
    budget_ms: u64,
    iterations: u32,
    max_games: usize,
    max_minutes: f64,
    jobs: usize,
    prefix: &Path,
) -> Entry {
    let mut a = BotSpec::named("ismcts").expect("ismcts");
    a.name = "base".into();
    a.settings = settings_for(base);
    let mut b = BotSpec::named("ismcts").expect("ismcts");
    b.name = proposal.id.clone();
    b.settings = settings_for(candidate);

    let mut entry = run(
        proposal,
        &b,
        &a,
        budget_ms,
        iterations,
        proposal.max_games.unwrap_or(max_games),
        max_minutes,
        jobs,
        prefix,
    );
    entry.change = change.to_string();
    entry
}

/// The current baseline against what the night started from, changing nothing
/// whatever the answer.
#[allow(clippy::too_many_arguments)]
fn confirm(
    proposal: &Proposal,
    base: &Config,
    root: &Config,
    budget_ms: u64,
    iterations: u32,
    max_games: usize,
    max_minutes: f64,
    jobs: usize,
    prefix: &Path,
) -> Entry {
    println!("   the whole run against where it started — for the number, not for a decision");
    let mut a = BotSpec::named("ismcts").expect("ismcts");
    a.name = "root".into();
    a.settings = settings_for(root);
    let mut b = BotSpec::named("ismcts").expect("ismcts");
    b.name = "baseline".into();
    b.settings = settings_for(base);
    let mut entry = run(
        proposal,
        &b,
        &a,
        budget_ms,
        iterations,
        proposal.max_games.unwrap_or(max_games),
        max_minutes,
        jobs,
        prefix,
    );
    entry.change = "confirmation only — nothing changed".into();
    entry
}

/// The match itself: pairs in batches, the verdict checked after each.
#[allow(clippy::too_many_arguments)]
fn run(
    proposal: &Proposal,
    b: &BotSpec,
    a: &BotSpec,
    budget_ms: u64,
    iterations: u32,
    max_games: usize,
    max_minutes: f64,
    jobs: usize,
    prefix: &Path,
) -> Entry {
    let opts = ArenaOptions {
        games: max_games,
        // Its own block of seeds. Sharing them would let an experiment be judged
        // on the deals that suited the last one.
        seed: 1 + (hash(&proposal.id) % 1000) * 10_000,
        sets: proposal.sets.unwrap_or_else(wc_core::units::SetMask::base),
        draft_mode: proposal.draft_mode.unwrap_or(wc_core::types::DraftMode::Random),
        max_plies: 4000,
        budget: if iterations > 0 {
            Budget { ms: None, iterations: Some(iterations) }
        } else {
            Budget { ms: Some(budget_ms), iterations: None }
        },
        budget_b: None,
        jobs,
    };
    let settings = SprtSettings { elo1: proposal.elo1.unwrap_or(10.0), ..SprtSettings::default() };

    let pool = rayon::ThreadPoolBuilder::new().num_threads(jobs).build().expect("pool");
    let started = Instant::now();
    let mut pair_scores: Vec<f64> = Vec::new();
    let mut scores: Vec<f64> = Vec::new();
    let mut state = sprt(&pair_scores, settings);

    let mut done = 0usize;
    let max_pairs = max_games.div_ceil(2);
    while done < max_pairs {
        let take = jobs.max(1).min(max_pairs - done);
        let results: Vec<(f64, f64, f64)> = pool.install(|| {
            (done..done + take)
                .into_par_iter()
                .map_init(
                    || (b.build(), a.build()),
                    |(bot_b, bot_a), pair| {
                        let seed = opts.seed + pair as u32;
                        let first = play_game(bot_b, bot_a, 0, seed, &opts);
                        let second = play_game(bot_b, bot_a, 1, seed, &opts);
                        ((first.score_a + second.score_a) / 2.0, first.score_a, second.score_a)
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
        heartbeat(prefix, &proposal.id, scores.len(), state.mean, state.llr, false);
        eprint!(
            "\r   {} games  {}  llr {:+.2}  {:.0}m   ",
            scores.len(),
            percent(state.mean, 1),
            state.llr,
            started.elapsed().as_secs_f64() / 60.0
        );

        if state.verdict != Verdict::Continue {
            break;
        }
        // A clock as well as a game count: an experiment that will not decide
        // must not eat the night.
        if started.elapsed().as_secs_f64() / 60.0 >= max_minutes {
            break;
        }
    }
    eprintln!();

    let per_game = score_stats(&scores);
    Entry {
        id: proposal.id.clone(),
        verdict: state.verdict.key().to_string(),
        games: scores.len(),
        score: per_game.mean,
        elo: elo_diff(per_game.mean).round(),
        llr: state.llr,
        change: String::new(),
        draft_mode: opts.draft_mode.key().to_string(),
        sets: proposal
            .sets
            .map(|m| m.iter().map(|s| s.key().to_string()).filter(|s| s != "base").collect())
            .unwrap_or_default(),
        seconds: started.elapsed().as_secs_f64(),
    }
}

/// A stable number from an id, so an experiment gets the same seeds whenever it
/// is run — including after a resume.
fn hash(id: &str) -> u32 {
    let mut h: u32 = 0x811c_9dc5;
    for b in id.bytes() {
        h = (h ^ b as u32).wrapping_mul(0x0100_0193);
    }
    h
}

// ---------------------------------------------------------------------------
// The files
// ---------------------------------------------------------------------------

struct Entry {
    id: String,
    verdict: String,
    games: usize,
    score: f64,
    elo: f64,
    llr: f64,
    change: String,
    draft_mode: String,
    sets: Vec<String>,
    seconds: f64,
}

impl Entry {
    fn nothing(id: &str) -> Entry {
        Entry {
            id: id.to_string(),
            verdict: "nothing".into(),
            games: 0,
            score: 0.0,
            elo: 0.0,
            llr: 0.0,
            change: "nothing to change — the baseline already holds this".into(),
            draft_mode: "random".into(),
            sets: Vec::new(),
            seconds: 0.0,
        }
    }

    fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "verdict": self.verdict,
            "games": self.games,
            "score": self.score,
            "elo": self.elo,
            "llr": self.llr,
            "change": self.change,
            "draftMode": self.draft_mode,
            "sets": self.sets,
            "seconds": self.seconds,
        })
    }
}

struct Journal {
    root_version: String,
    baseline_version: String,
    accepts: usize,
    done: Vec<Entry>,
}

impl Journal {
    fn new(root: &Config) -> Journal {
        Journal {
            root_version: root.weights.version.clone(),
            baseline_version: root.weights.version.clone(),
            accepts: 0,
            done: Vec::new(),
        }
    }

    fn seen(&self, id: &str) -> bool {
        self.done.iter().any(|e| e.id == id)
    }
}

fn baseline_path(prefix: &Path) -> PathBuf {
    with_suffix(prefix, ".json")
}

fn with_suffix(prefix: &Path, suffix: &str) -> PathBuf {
    PathBuf::from(format!("{}{suffix}", prefix.display()))
}

fn load(path: &Path) -> Result<Config, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let value: Value =
        serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(Config {
        weights: EvalWeights::from_json(&value),
        // Absent knobs are the search's own defaults, not blanks — see
        // `Knobs::defaults`, and the trap it exists to close.
        knobs: read_knobs(Some(&value), &path.display().to_string())
            .unwrap_or_default()
            .over(&Knobs::defaults()),
    })
}

fn write_config(path: &Path, config: &Config) {
    let text = serde_json::to_string_pretty(&config_to_json(config)).expect("weights");
    if let Err(e) = std::fs::write(path, format!("{text}\n")) {
        die(format!("{}: {e}", path.display()));
    }
}

fn read_journal(prefix: &Path) -> Journal {
    let path = with_suffix(prefix, ".journal.json");
    let value: Value = match std::fs::read_to_string(&path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
    {
        Some(v) => v,
        None => return Journal { root_version: String::new(), baseline_version: String::new(), accepts: 0, done: Vec::new() },
    };
    let done = value
        .get("done")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .map(|e| Entry {
                    id: e.get("id").and_then(Value::as_str).unwrap_or("").to_string(),
                    verdict: e.get("verdict").and_then(Value::as_str).unwrap_or("").to_string(),
                    games: e.get("games").and_then(Value::as_u64).unwrap_or(0) as usize,
                    score: e.get("score").and_then(Value::as_f64).unwrap_or(0.0),
                    elo: e.get("elo").and_then(Value::as_f64).unwrap_or(0.0),
                    llr: e.get("llr").and_then(Value::as_f64).unwrap_or(0.0),
                    change: e.get("change").and_then(Value::as_str).unwrap_or("").to_string(),
                    draft_mode: e.get("draftMode").and_then(Value::as_str).unwrap_or("random").to_string(),
                    sets: Vec::new(),
                    seconds: e.get("seconds").and_then(Value::as_f64).unwrap_or(0.0),
                })
                .collect()
        })
        .unwrap_or_default();
    Journal {
        root_version: value.get("rootVersion").and_then(Value::as_str).unwrap_or("").to_string(),
        baseline_version: String::new(),
        accepts: value.get("accepts").and_then(Value::as_u64).unwrap_or(0) as usize,
        done,
    }
}

fn write_journal(prefix: &Path, journal: &Journal) {
    let value = json!({
        "rootVersion": journal.root_version,
        "baseline": { "weights": { "version": journal.baseline_version } },
        "accepts": journal.accepts,
        "done": journal.done.iter().map(Entry::to_json).collect::<Vec<_>>(),
    });
    let path = with_suffix(prefix, ".journal.json");
    let text = serde_json::to_string_pretty(&value).expect("journal");
    if let Err(e) = std::fs::write(&path, format!("{text}\n")) {
        die(format!("{}: {e}", path.display()));
    }
}

/// Rewritten after every batch of games, so a watcher can tell three states
/// apart that look identical from outside: running slowly, wedged, and dead.
fn heartbeat(prefix: &Path, experiment: &str, games: usize, score: f64, llr: f64, finished: bool) {
    let value = json!({
        "experiment": experiment,
        "games": games,
        "score": score,
        "llr": llr,
        "finished": finished,
    });
    let _ = std::fs::write(
        with_suffix(prefix, ".heartbeat.json"),
        format!("{}\n", serde_json::to_string_pretty(&value).expect("heartbeat")),
    );
}
