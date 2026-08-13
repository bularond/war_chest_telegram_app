//! A description of a bot that can be sent to a worker thread and built there.
//!
//! A `Player` owns a tree arena and a pile of scratch, so it cannot be shared
//! across threads and must not be: two threads searching through one arena would
//! be a different algorithm. What travels is this — a name, or a set of weights
//! — and each worker builds its own.

use std::path::Path;
use wc_bot::eval::EvalWeights;
use wc_bot::ismcts::SearchSettings;
use wc_bot::{player_named, Player};

#[derive(Clone, Debug)]
pub struct BotSpec {
    /// What the report calls it.
    pub name: String,
    /// The registry name to build from.
    pub bot: String,
    pub settings: SearchSettings,
}

impl BotSpec {
    /// A bot from the registry, playing the shipping weights.
    pub fn named(name: &str) -> Result<BotSpec, String> {
        let settings = SearchSettings::default();
        if player_named(name, &settings).is_none() {
            return Err(format!("no bot named {name}"));
        }
        Ok(BotSpec { name: name.to_string(), bot: name.to_string(), settings })
    }

    /// The search, playing a weights file. The file's own name is what the
    /// report calls it, so two sides of an experiment are told apart by the
    /// thing that differs between them.
    pub fn weights(path: &Path) -> Result<BotSpec, String> {
        let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
        let value: serde_json::Value =
            serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
        let mut spec = BotSpec::named("ismcts")?;
        spec.name = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        spec.settings.weights = EvalWeights::from_json(&value);
        // A weights file may also carry the search knobs, so an experiment can
        // move one of those without a second file format.
        apply_search_overrides(&mut spec.settings, &value);
        Ok(spec)
    }

    pub fn build(&self) -> Player {
        player_named(&self.bot, &self.settings).expect("bot spec names a bot that exists")
    }
}

/// The search knobs a weights file may override. Absent keys keep the default,
/// which is what lets an old file stay readable.
pub fn apply_search_overrides(settings: &mut SearchSettings, v: &serde_json::Value) {
    if let Some(x) = v.get("iterations").and_then(serde_json::Value::as_u64) {
        settings.iterations = x as u32;
    }
    if let Some(x) = v.get("rolloutDepth").and_then(serde_json::Value::as_u64) {
        settings.rollout_depth = x as u32;
    }
    if let Some(x) = v.get("exploration").and_then(serde_json::Value::as_f64) {
        settings.exploration = x;
    }
    if let Some(x) = v.get("firstPlay").and_then(serde_json::Value::as_f64) {
        settings.first_play = x;
    }
    if let Some(x) = v.get("levelLeaves").and_then(serde_json::Value::as_bool) {
        settings.level_leaves = x;
    }
    if let Some(x) = v.get("rolloutNoise").and_then(serde_json::Value::as_f64) {
        settings.rollout_noise = x;
    }
    if let Some(x) = v.get("unitKeys").and_then(serde_json::Value::as_bool) {
        settings.unit_keys = x;
    }
}

/// `--a heuristic` or `--a weights/base.json`: a name if the registry has one,
/// a file otherwise.
pub fn parse_spec(arg: &str) -> Result<BotSpec, String> {
    if let Ok(spec) = BotSpec::named(arg) {
        return Ok(spec);
    }
    BotSpec::weights(&crate::paths::resolve(arg))
}
