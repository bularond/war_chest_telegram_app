//! Weights fitted to games, rather than to one experiment at a time.
//!
//! The sequential test asks "is this change worth keeping" and pays hundreds of
//! games for one answer. This asks a different question — "given these features,
//! what fraction of games were won from here" — and answers it for every weight
//! at once, from games that cost almost nothing to play because nobody is
//! searching in them.
//!
//! **What it cannot do.** The label is the outcome of a game played by whatever
//! policy collected it. Fit on heuristic self-play, the weights predict who wins
//! *under heuristic play*, which is a proxy for the real thing and not the real
//! thing. So the output is a candidate, exactly like SPSA's: it becomes a
//! baseline when a sequential test says so, and not before.

use wc_bot::eval::FEATURE_COUNT;

#[derive(Clone, Debug)]
pub struct Sample {
    /// One position.
    pub features: [f64; FEATURE_COUNT],
    /// 1 if the side these features are written for went on to win, 0 if not,
    /// 0.5 for a draw. For the value target it is the search's own valuation.
    pub target: f64,
    /// Down-weights positions from the same game, which are anything but
    /// independent.
    pub weight: f64,
}

#[derive(Copy, Clone, Debug)]
pub struct FitSettings {
    pub steps: usize,
    pub rate: f64,
    /// L2, to keep a feature that barely appears from bolting.
    pub l2: f64,
}

impl Default for FitSettings {
    fn default() -> FitSettings {
        FitSettings { steps: 400, rate: 1.5, l2: 1e-4 }
    }
}

fn sigmoid(x: f64) -> f64 {
    1.0 / (1.0 + (-x).exp())
}

fn dot(w: &[f64; FEATURE_COUNT], f: &[f64; FEATURE_COUNT]) -> f64 {
    (0..FEATURE_COUNT).map(|i| w[i] * f[i]).sum()
}

/// Mean log loss, the thing [`fit`] minimises. Reported so a run can be judged.
pub fn log_loss(samples: &[Sample], w: &[f64; FEATURE_COUNT]) -> f64 {
    let mut total = 0.0;
    let mut mass = 0.0;
    for s in samples {
        let p = sigmoid(dot(w, &s.features)).clamp(1e-9, 1.0 - 1e-9);
        total += s.weight * -(s.target * p.ln() + (1.0 - s.target) * (1.0 - p).ln());
        mass += s.weight;
    }
    if mass == 0.0 {
        0.0
    } else {
        total / mass
    }
}

/// Fits `P(win) = σ(w · f)` by plain gradient descent.
///
/// That the evaluation is `tanh(w · f)` rather than a probability does not
/// matter to the fit: `tanh(x) = 2σ(2x) − 1`, so the same vector orders
/// positions the same way either side of the transform, and the scale is
/// swallowed by `tanh` anyway.
///
/// Deterministic: same samples in, same weights out, because a tuner nobody can
/// re-run is a tuner nobody can check.
pub fn fit(samples: &[Sample], settings: FitSettings) -> [f64; FEATURE_COUNT] {
    let mut w = [0.0; FEATURE_COUNT];
    if samples.is_empty() {
        return w;
    }
    for _ in 0..settings.steps {
        let mut grad = [0.0; FEATURE_COUNT];
        let mut mass = 0.0;
        for s in samples {
            let error = sigmoid(dot(&w, &s.features)) - s.target;
            for i in 0..FEATURE_COUNT {
                grad[i] += s.weight * error * s.features[i];
            }
            mass += s.weight;
        }
        if mass == 0.0 {
            break;
        }
        for i in 0..FEATURE_COUNT {
            w[i] -= settings.rate * (grad[i] / mass + settings.l2 * w[i]);
        }
    }
    w
}

/// Fits the evaluation to what the *search* thought a position was worth, rather
/// than to who eventually won it.
///
/// Why bother, given [`fit`]. A regression on outcomes maximises how well the
/// vector predicts the winner — and the win condition itself predicts the winner
/// better than anything, so the fit shrinks every other feature next to markers.
/// That reads well and steers badly: an evaluation that says little except "who
/// is closer to winning" gives the search nothing to work with in the
/// middlegame, which is exactly where it needs help. Measured, that vector lost
/// heavily.
///
/// The target here is the search's own backed-up value at the position. That is
/// not circular, because the search saw further than the evaluation did: fitting
/// to it pulls what the search knows down into the function it starts from. It
/// is the same idea as TD-leaf in chess engines.
///
/// Least squares against `tanh(w · f)`, since that is the shape the evaluation
/// actually has.
pub fn fit_to_values(samples: &[Sample], settings: FitSettings) -> [f64; FEATURE_COUNT] {
    let mut w = [0.0; FEATURE_COUNT];
    if samples.is_empty() {
        return w;
    }
    for _ in 0..settings.steps {
        let mut grad = [0.0; FEATURE_COUNT];
        let mut mass = 0.0;
        for s in samples {
            let predicted = dot(&w, &s.features).tanh();
            // d/dw of ½(tanh(w·f) − y)² is (tanh − y)(1 − tanh²)f.
            let error = (predicted - s.target) * (1.0 - predicted * predicted);
            for i in 0..FEATURE_COUNT {
                grad[i] += s.weight * error * s.features[i];
            }
            mass += s.weight;
        }
        if mass == 0.0 {
            break;
        }
        for i in 0..FEATURE_COUNT {
            w[i] -= settings.rate * (grad[i] / mass + settings.l2 * w[i]);
        }
    }
    w
}

/// Scales a fitted vector so one coordinate is 1.
///
/// The evaluation's scale means nothing — `tanh` swallows it, and only the
/// ratios between weights decide anything — but a person reading the numbers
/// needs an anchor, and the rest of this project anchors on `markers`.
pub fn normalize(w: &[f64; FEATURE_COUNT], anchor: usize) -> [f64; FEATURE_COUNT] {
    let scale = w[anchor];
    if scale.abs() < 1e-9 {
        return *w;
    }
    let mut out = [0.0; FEATURE_COUNT];
    for i in 0..FEATURE_COUNT {
        out[i] = ((w[i] / scale) * 1e4).round() / 1e4;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(x: f64, target: f64) -> Sample {
        let mut features = [0.0; FEATURE_COUNT];
        features[0] = x;
        Sample { features, target, weight: 1.0 }
    }

    #[test]
    fn it_learns_the_sign_of_a_feature_that_predicts_the_winner() {
        let samples: Vec<Sample> =
            (0..200).map(|i| sample(if i % 2 == 0 { 1.0 } else { -1.0 }, if i % 2 == 0 { 1.0 } else { 0.0 })).collect();
        let w = fit(&samples, FitSettings::default());
        assert!(w[0] > 0.5, "fitted {}", w[0]);
        assert!(log_loss(&samples, &w) < 0.4);
    }

    #[test]
    fn the_value_fit_lands_on_the_value() {
        let samples: Vec<Sample> = (0..200)
            .map(|i| {
                let x = if i % 2 == 0 { 1.0 } else { -1.0 };
                sample(x, (0.8 * x).tanh())
            })
            .collect();
        let w = fit_to_values(&samples, FitSettings { steps: 4000, ..FitSettings::default() });
        assert!((w[0] - 0.8).abs() < 0.05, "fitted {}", w[0]);
    }

    #[test]
    fn normalising_puts_the_anchor_at_one() {
        let mut w = [0.0; FEATURE_COUNT];
        w[0] = 2.0;
        w[1] = 1.0;
        let out = normalize(&w, 0);
        assert_eq!(out[0], 1.0);
        assert_eq!(out[1], 0.5);
    }
}
