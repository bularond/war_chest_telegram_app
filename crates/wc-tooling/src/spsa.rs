//! The SPSA update rule, apart from the games that feed it.
//!
//! Simultaneous Perturbation Stochastic Approximation (Spall, 1992) tunes a
//! whole vector with two measurements per step, however long the vector is: kick
//! every weight at once in a random direction, see which of the two kicked
//! versions plays better, and step the whole vector that way. Coordinate descent,
//! by contrast, spends a full experiment per weight.
//!
//! It lives here rather than in the CLI for the same reason the sequential test
//! does: this is the part that decides where the weights go, and a rule that
//! decides anything in this project has to be checkable without playing a match.
//!
//! **What it will not do.** It will not switch a feature on — a weight at zero
//! stays at zero, because zero is a verdict from an experiment and not a
//! starting guess. It will not flip a sign — a weight that changed sign is a
//! different feature, not a smaller one. And it will not touch the anchor,
//! because only the ratios between weights mean anything: the sum goes through
//! `tanh`, so scaling all of them together is not a change of opinion, only of
//! confidence.

use wc_bot::eval::{EvalWeights, FEATURES, FEATURE_COUNT};

#[derive(Clone, Debug)]
pub struct SpsaSettings {
    /// Step size, as a fraction of each weight.
    pub a: f64,
    /// Perturbation, as a fraction of each weight.
    pub c: f64,
    /// Total steps planned — sets how fast the gains decay.
    pub steps: usize,
    /// Weights held still. The anchor belongs here.
    pub fixed: Vec<String>,
}

impl Default for SpsaSettings {
    fn default() -> SpsaSettings {
        SpsaSettings { a: 0.08, c: 0.12, steps: 150, fixed: vec!["markers".into()] }
    }
}

/// Which weights a run may move: non-zero, and not anchored.
pub fn tunable(weights: &EvalWeights, settings: &SpsaSettings) -> Vec<usize> {
    (0..FEATURE_COUNT)
        .filter(|i| {
            weights.w[*i] != 0.0 && !settings.fixed.iter().any(|f| f == FEATURES[*i])
        })
        .collect()
}

/// The textbook schedule: `a/(A+k+1)^0.602` and `c/(k+1)^0.101`. `A` is a tenth
/// of the planned run, which keeps the first few steps from bolting.
pub fn gains(k: usize, settings: &SpsaSettings) -> (f64, f64) {
    let big_a = (settings.steps as f64 / 10.0).max(1.0);
    (
        settings.a / (big_a + k as f64 + 1.0).powf(0.602),
        settings.c / (k as f64 + 1.0).powf(0.101),
    )
}

/// One weight vector kicked along `delta`; `sign` picks which of the two.
pub fn perturb(weights: &EvalWeights, delta: &[f64], c: f64, sign: f64) -> EvalWeights {
    let mut out = weights.clone();
    for i in 0..FEATURE_COUNT {
        if delta[i] != 0.0 {
            out.w[i] = round(weights.w[i] * (1.0 + sign * c * delta[i]));
        }
    }
    out
}

/// The step itself. `score` is what the kicked-up version scored against the
/// kicked-down one, in [0, 1]; a dead level 0.5 means the kick told us nothing
/// and nothing moves.
pub fn step(weights: &EvalWeights, delta: &[f64], score: f64, a: f64) -> EvalWeights {
    let gradient = 2.0 * score - 1.0;
    let mut out = weights.clone();
    for i in 0..FEATURE_COUNT {
        let value = weights.w[i];
        if delta[i] == 0.0 || value == 0.0 {
            continue;
        }
        let moved = value * (1.0 + a * gradient * delta[i]);
        // Towards zero it may creep, through zero it may not.
        out.w[i] = round(if value > 0.0 {
            moved.max(value * 0.05)
        } else {
            moved.min(value * 0.05)
        });
    }
    out
}

fn round(x: f64) -> f64 {
    (x * 1e6).round() / 1e6
}

#[cfg(test)]
mod tests {
    use super::*;
    use wc_bot::eval::{base_weights, f};

    #[test]
    fn a_weight_at_zero_stays_at_zero() {
        let base = base_weights();
        assert_eq!(base.w[f::THREAT], 0.0);
        let settings = SpsaSettings::default();
        assert!(!tunable(&base, &settings).contains(&f::THREAT));
        let mut delta = [1.0; FEATURE_COUNT];
        delta[f::MARKERS] = 0.0;
        let moved = step(&base, &delta, 1.0, 0.5);
        assert_eq!(moved.w[f::THREAT], 0.0);
    }

    #[test]
    fn the_anchor_is_not_tuned() {
        let settings = SpsaSettings::default();
        assert!(!tunable(&base_weights(), &settings).contains(&f::MARKERS));
    }

    #[test]
    fn a_weight_creeps_towards_zero_but_never_through_it() {
        let mut base = base_weights();
        base.w[f::MATERIAL] = 0.7;
        let mut delta = [0.0; FEATURE_COUNT];
        delta[f::MATERIAL] = -1.0;
        // A huge step in the shrinking direction still leaves it positive.
        let moved = step(&base, &delta, 1.0, 10.0);
        assert!(moved.w[f::MATERIAL] > 0.0);
        assert!(moved.w[f::MATERIAL] < 0.7);
    }

    #[test]
    fn a_level_result_moves_nothing() {
        let base = base_weights();
        let delta = [1.0; FEATURE_COUNT];
        assert_eq!(step(&base, &delta, 0.5, 0.5).w, base.w);
    }
}
