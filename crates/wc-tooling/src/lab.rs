//! What the lab decides, apart from the games that inform it.
//!
//! The binary is the loop: read the plan, play the match, write the journal.
//! This is the part that turns a proposal into a configuration and refuses a
//! plan that cannot mean what it says — the two places where a mistake is silent
//! rather than loud. A wrong verdict announces itself; a proposal that quietly
//! changes nothing plays several hundred games between two identical bots and
//! reports an honest-looking REJECT.
//!
//! It lives here for the same reason the sequential test and the SPSA step do:
//! anything that decides something in this project has to be checkable without
//! playing a match.

use serde_json::Value;
use wc_bot::eval::{EvalWeights, FEATURES, FEATURE_COUNT};
use wc_bot::heuristic::{DraftBy, HeuristicWeights};
use wc_bot::ismcts::SearchSettings;
use wc_core::types::DraftMode;
use wc_core::units::{SetMask, UnitSet};

/// Weights and the knobs they were measured under: one thing, tuned together.
#[derive(Clone, Debug)]
pub struct Config {
    pub weights: EvalWeights,
    pub knobs: Knobs,
}

/// The search settings a proposal may move. Everything is optional, and absent
/// means "whatever the baseline holds" — which is what lets a plan be appended
/// to while the lab is running.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Knobs {
    pub exploration: Option<f64>,
    pub rollout_depth: Option<u32>,
    pub first_play: Option<f64>,
    pub level_leaves: Option<bool>,
    pub rollout_noise: Option<f64>,
    pub unit_keys: Option<bool>,
    pub quick: Option<bool>,
    pub draft_by: Option<DraftBy>,
    pub attack_before_control: Option<bool>,
    pub prefer_kills: Option<bool>,
    pub rank_tactics: Option<bool>,
    pub uniform_moves: Option<bool>,
}

impl Knobs {
    /// What the search uses when a file names no knob at all.
    ///
    /// Filling these in is what makes «nothing to change» work: a proposal that
    /// names the value the search already defaults to has to resolve to nothing,
    /// and against an empty baseline every such proposal would look like a
    /// change and play several hundred games to prove it was not.
    ///
    /// It also means a change to `SearchSettings::default` moves the baseline
    /// under a plan. If defaults are edited, write the starting configuration
    /// out explicitly — otherwise `against: "root"` measures the run against
    /// something the run did not start from.
    pub fn defaults() -> Knobs {
        let s = SearchSettings::default();
        Knobs {
            exploration: Some(s.exploration),
            rollout_depth: Some(s.rollout_depth),
            first_play: Some(s.first_play),
            level_leaves: Some(s.level_leaves),
            rollout_noise: Some(s.rollout_noise),
            unit_keys: Some(s.unit_keys),
            quick: Some(s.rollout.quick),
            draft_by: Some(s.rollout.draft_by),
            attack_before_control: Some(s.rollout.attack_before_control),
            prefer_kills: Some(s.rollout.prefer_kills),
            rank_tactics: Some(s.rollout.rank_tactics),
            uniform_moves: Some(s.rollout.uniform_moves),
        }
    }

    /// The knobs laid over a set of search settings.
    pub fn apply(&self, settings: &mut SearchSettings) {
        if let Some(x) = self.exploration {
            settings.exploration = x;
        }
        if let Some(x) = self.rollout_depth {
            settings.rollout_depth = x;
        }
        if let Some(x) = self.first_play {
            settings.first_play = x;
        }
        if let Some(x) = self.level_leaves {
            settings.level_leaves = x;
        }
        if let Some(x) = self.rollout_noise {
            settings.rollout_noise = x;
        }
        if let Some(x) = self.unit_keys {
            settings.unit_keys = x;
        }
        let policy = |w: &mut HeuristicWeights, k: &Knobs| {
            if let Some(x) = k.quick {
                w.quick = x;
            }
            if let Some(x) = k.draft_by {
                w.draft_by = x;
            }
            if let Some(x) = k.attack_before_control {
                w.attack_before_control = x;
            }
            if let Some(x) = k.prefer_kills {
                w.prefer_kills = x;
            }
            if let Some(x) = k.rank_tactics {
                w.rank_tactics = x;
            }
            if let Some(x) = k.uniform_moves {
                w.uniform_moves = x;
            }
        };
        policy(&mut settings.rollout, self);
        // The draft is played by the same policy under different knobs, and
        // `draftBy` is the one that matters there.
        policy(&mut settings.draft, self);
    }

    /// The knobs that are set here and differ from `other`, as text.
    fn differences(&self, other: &Knobs) -> Vec<String> {
        let mut out = Vec::new();
        macro_rules! diff {
            ($field:ident, $name:literal) => {
                if let Some(x) = self.$field {
                    if other.$field != Some(x) {
                        out.push(format!("{}={:?}", $name, x));
                    }
                }
            };
        }
        diff!(exploration, "exploration");
        diff!(rollout_depth, "rolloutDepth");
        diff!(first_play, "firstPlay");
        diff!(level_leaves, "levelLeaves");
        diff!(rollout_noise, "rolloutNoise");
        diff!(unit_keys, "unitKeys");
        diff!(quick, "quick");
        diff!(draft_by, "draftBy");
        diff!(attack_before_control, "attackBeforeControl");
        diff!(prefer_kills, "preferKills");
        diff!(rank_tactics, "rankTactics");
        diff!(uniform_moves, "uniformMoves");
        out
    }

    /// The baseline with these laid over it.
    pub fn over(&self, base: &Knobs) -> Knobs {
        Knobs {
            exploration: self.exploration.or(base.exploration),
            rollout_depth: self.rollout_depth.or(base.rollout_depth),
            first_play: self.first_play.or(base.first_play),
            level_leaves: self.level_leaves.or(base.level_leaves),
            rollout_noise: self.rollout_noise.or(base.rollout_noise),
            unit_keys: self.unit_keys.or(base.unit_keys),
            quick: self.quick.or(base.quick),
            draft_by: self.draft_by.or(base.draft_by),
            attack_before_control: self.attack_before_control.or(base.attack_before_control),
            prefer_kills: self.prefer_kills.or(base.prefer_kills),
            rank_tactics: self.rank_tactics.or(base.rank_tactics),
            uniform_moves: self.uniform_moves.or(base.uniform_moves),
        }
    }
}

/// One thing to try.
///
/// `set` and `knobs` are absolute; `scale` is relative to whatever the baseline
/// holds when the experiment comes up, which is what a descent step means.
#[derive(Clone, Debug, Default)]
pub struct Proposal {
    pub id: String,
    pub note: Option<String>,
    /// Weights, by name, set outright.
    pub set: Vec<(usize, f64)>,
    pub knobs: Knobs,
    /// A weight multiplied rather than set.
    pub scale: Option<(usize, f64)>,
    pub elo1: Option<f64>,
    /// Overrides the run's `--max-games` for this one experiment.
    pub max_games: Option<usize>,
    /// `Random` deals the units and keeps the draft out of the measurement,
    /// which is what a question about the middlegame wants. A question about the
    /// *draft* needs `Draft`, and so does anything claiming to be about how the
    /// bot plays a real game: a lobby deals a draft unless told otherwise.
    pub draft_mode: Option<DraftMode>,
    /// Which boxes are on the table. A weight accepted on the base game alone is
    /// a weight accepted for one of the games the app offers, not for all.
    pub sets: Option<SetMask>,
    /// Play the current baseline against what the night started from, and change
    /// nothing whatever the answer.
    ///
    /// A chain of accepted steps does not add up to a known gain — each step was
    /// measured against the one before it, on its own deals, and the sequential
    /// test says "better than that" rather than "better by this much". The only
    /// honest number for the night as a whole comes from playing the two ends
    /// against each other on deals neither of them was chosen on.
    pub against_root: bool,
}

/// What a proposal came to, or nothing at all.
pub struct Resolved {
    pub config: Config,
    /// What actually changed, for the journal.
    pub change: String,
}

/// Applies a proposal to the current baseline.
///
/// `None` when it cannot mean anything: every weight and knob it names already
/// holds that value. Refusing here is the whole point — the alternative is
/// several hundred games between two identical bots and a REJECT that reads like
/// a verdict.
pub fn resolve(base: &Config, p: &Proposal) -> Option<Resolved> {
    let mut weights = base.weights.clone();
    let mut change: Vec<String> = Vec::new();

    for (index, value) in &p.set {
        if weights.w[*index] != *value {
            change.push(format!("{}={value}", FEATURES[*index]));
            weights.w[*index] = *value;
        }
    }
    if let Some((index, factor)) = p.scale {
        let from = base.weights.w[index];
        let to = round(from * factor);
        // Scaling a weight that is zero is not a small step, it is switching a
        // feature on — and zero is a verdict, not a starting guess.
        if from != 0.0 && to != from {
            change.push(format!("{} {from} → {to}", FEATURES[index]));
            weights.w[index] = to;
        }
    }

    let knobs = p.knobs.over(&base.knobs);
    for text in p.knobs.differences(&base.knobs) {
        change.push(text);
    }

    if change.is_empty() {
        return None;
    }
    Some(Resolved { config: Config { weights, knobs }, change: change.join(", ") })
}

fn round(x: f64) -> f64 {
    (x * 1e6).round() / 1e6
}

// ---------------------------------------------------------------------------
// Reading a plan
// ---------------------------------------------------------------------------

/// A plan is read again before every experiment, so proposals can be appended
/// while the lab is running.
pub fn read_plan(v: &Value) -> Result<Vec<Proposal>, String> {
    let list = v
        .get("proposals")
        .and_then(Value::as_array)
        .ok_or("a plan is an object with a `proposals` list")?;
    list.iter().map(read_proposal).collect()
}

fn read_proposal(v: &Value) -> Result<Proposal, String> {
    let id = v
        .get("id")
        .and_then(Value::as_str)
        .ok_or("every proposal needs an id")?
        .to_string();
    let feature = |name: &str| -> Result<usize, String> {
        FEATURES
            .iter()
            .position(|f| *f == name)
            .ok_or_else(|| format!("{id}: there is no weight called {name}"))
    };

    let mut set = Vec::new();
    if let Some(map) = v.get("set").and_then(Value::as_object) {
        for (name, value) in map {
            let n = value
                .as_f64()
                .ok_or_else(|| format!("{id}: {name} must be a number"))?;
            set.push((feature(name)?, n));
        }
    }
    let scale = match v.get("scale") {
        Some(s) => {
            let key = s.get("key").and_then(Value::as_str).ok_or("scale needs a key")?;
            let factor = s.get("factor").and_then(Value::as_f64).ok_or("scale needs a factor")?;
            Some((feature(key)?, factor))
        }
        None => None,
    };

    let mut sets = None;
    if let Some(list) = v.get("sets").and_then(Value::as_array) {
        let mut mask = SetMask::base();
        for s in list {
            let key = s.as_str().unwrap_or_default();
            mask = mask.with(
                UnitSet::from_key(key).ok_or_else(|| format!("{id}: no set called {key}"))?,
            );
        }
        sets = Some(mask);
    }

    Ok(Proposal {
        note: v.get("note").and_then(Value::as_str).map(str::to_owned),
        knobs: read_knobs(v.get("knobs"), &id)?,
        set,
        scale,
        elo1: v.get("elo1").and_then(Value::as_f64),
        max_games: v.get("maxGames").and_then(Value::as_u64).map(|n| n as usize),
        draft_mode: match v.get("draftMode").and_then(Value::as_str) {
            Some(key) => {
                Some(DraftMode::from_key(key).ok_or_else(|| format!("{id}: no mode {key}"))?)
            }
            None => None,
        },
        sets,
        against_root: v.get("against").and_then(Value::as_str) == Some("root"),
        id,
    })
}

pub fn read_knobs(v: Option<&Value>, id: &str) -> Result<Knobs, String> {
    let mut knobs = Knobs::default();
    let v = match v {
        Some(v) => v,
        None => return Ok(knobs),
    };
    let map = v.as_object().ok_or_else(|| format!("{id}: knobs must be an object"))?;
    for (key, value) in map {
        match key.as_str() {
            "exploration" => knobs.exploration = value.as_f64(),
            "rolloutDepth" => knobs.rollout_depth = value.as_u64().map(|n| n as u32),
            "firstPlay" => knobs.first_play = value.as_f64(),
            "levelLeaves" => knobs.level_leaves = value.as_bool(),
            "rolloutNoise" => knobs.rollout_noise = value.as_f64(),
            "unitKeys" => knobs.unit_keys = value.as_bool(),
            "quick" => knobs.quick = value.as_bool(),
            "attackBeforeControl" => knobs.attack_before_control = value.as_bool(),
            "preferKills" => knobs.prefer_kills = value.as_bool(),
            "rankTactics" => knobs.rank_tactics = value.as_bool(),
            "uniformMoves" => knobs.uniform_moves = value.as_bool(),
            "draftBy" => {
                knobs.draft_by = Some(match value.as_str().unwrap_or_default() {
                    "coins" => DraftBy::Coins,
                    "scarcity" => DraftBy::Scarcity,
                    "random" => DraftBy::Random,
                    "measured" => DraftBy::Measured,
                    "measured-all" => DraftBy::MeasuredAll,
                    "measured-all-660" => DraftBy::MeasuredAll660,
                    other => return Err(format!("{id}: no draft rule called {other}")),
                })
            }
            other => return Err(format!("{id}: no knob called {other}")),
        }
    }
    Ok(knobs)
}

/// The weights as a `SearchSettings`, ready to hand to a bot.
pub fn settings_for(config: &Config) -> SearchSettings {
    let mut settings = SearchSettings { weights: config.weights.clone(), ..Default::default() };
    config.knobs.apply(&mut settings);
    settings
}

/// A weight vector as JSON, with the knobs beside it — the file the arena and
/// the sequential test read.
pub fn config_to_json(config: &Config) -> Value {
    let mut out = config.weights.to_json();
    if let Some(map) = out.as_object_mut() {
        macro_rules! put {
            ($field:ident, $name:literal) => {
                if let Some(x) = config.knobs.$field {
                    map.insert($name.into(), serde_json::json!(x));
                }
            };
        }
        put!(exploration, "exploration");
        put!(rollout_depth, "rolloutDepth");
        put!(first_play, "firstPlay");
        put!(level_leaves, "levelLeaves");
        put!(rollout_noise, "rolloutNoise");
        put!(unit_keys, "unitKeys");
    }
    out
}

pub const FEATURE_NAMES: [&str; FEATURE_COUNT] = FEATURES;

#[cfg(test)]
mod tests {
    use super::*;
    use wc_bot::eval::{base_weights, f};

    fn base() -> Config {
        Config { weights: base_weights(), knobs: Knobs::default() }
    }

    #[test]
    fn a_proposal_that_changes_nothing_is_refused() {
        let base = base();
        let same = Proposal {
            id: "same".into(),
            set: vec![(f::MATERIAL, base.weights.w[f::MATERIAL])],
            ..Default::default()
        };
        assert!(resolve(&base, &same).is_none());
    }

    #[test]
    fn a_proposal_naming_a_default_is_refused() {
        // The trap this is here for: an empty baseline makes every knob look
        // like a change, so the lab plays a match to discover it changed nothing.
        let base = Config { weights: base_weights(), knobs: Knobs::defaults() };
        let same = Proposal {
            id: "same".into(),
            knobs: Knobs { rollout_noise: Some(0.15), ..Knobs::default() },
            ..Default::default()
        };
        assert!(resolve(&base, &same).is_none());
    }

    #[test]
    fn a_repeat_of_an_accepted_knob_is_refused_too() {
        let mut base = base();
        base.knobs.rollout_noise = Some(0.15);
        let repeat = Proposal {
            id: "again".into(),
            knobs: Knobs { rollout_noise: Some(0.15), ..Knobs::default() },
            ..Default::default()
        };
        assert!(resolve(&base, &repeat).is_none());
        // The reversal is a real experiment and does resolve.
        let back = Proposal {
            id: "back".into(),
            knobs: Knobs { rollout_noise: Some(0.0), ..Knobs::default() },
            ..Default::default()
        };
        assert!(resolve(&base, &back).is_some());
    }

    #[test]
    fn scaling_a_zero_does_not_switch_a_feature_on() {
        let base = base();
        assert_eq!(base.weights.w[f::THREAT], 0.0);
        let step = Proposal {
            id: "descend".into(),
            scale: Some((f::THREAT, 2.0)),
            ..Default::default()
        };
        assert!(resolve(&base, &step).is_none());
    }

    #[test]
    fn a_descent_step_is_relative_to_the_baseline_it_meets() {
        let mut base = base();
        base.weights.w[f::MATERIAL] = 0.5;
        let step =
            Proposal { id: "descend".into(), scale: Some((f::MATERIAL, 2.0)), ..Default::default() };
        let resolved = resolve(&base, &step).expect("a real change");
        assert_eq!(resolved.config.weights.w[f::MATERIAL], 1.0);
        assert!(resolved.change.contains("material"));
    }

    #[test]
    fn a_plan_that_names_something_that_does_not_exist_is_an_error() {
        let plan = serde_json::json!({
            "proposals": [{ "id": "typo", "set": { "materail": 0.5 } }]
        });
        assert!(read_plan(&plan).is_err());
        let plan = serde_json::json!({
            "proposals": [{ "id": "typo", "knobs": { "explorationn": 0.5 } }]
        });
        assert!(read_plan(&plan).is_err());
    }

    #[test]
    fn a_plan_reads_the_shapes_the_journal_reports() {
        let plan = serde_json::json!({
            "proposals": [{
                "id": "noise-off",
                "note": "the reversal",
                "knobs": { "rolloutNoise": 0.0, "draftBy": "coins" },
                "draftMode": "draft",
                "sets": ["nobility", "siege"],
                "elo1": 20,
                "maxGames": 400,
            }],
        });
        let read = read_plan(&plan).expect("a readable plan");
        let p = &read[0];
        assert_eq!(p.id, "noise-off");
        assert_eq!(p.knobs.rollout_noise, Some(0.0));
        assert_eq!(p.knobs.draft_by, Some(DraftBy::Coins));
        assert_eq!(p.draft_mode, Some(DraftMode::Draft));
        assert_eq!(p.elo1, Some(20.0));
        assert_eq!(p.max_games, Some(400));
        assert!(p.sets.unwrap().has(UnitSet::Siege));
    }
}
