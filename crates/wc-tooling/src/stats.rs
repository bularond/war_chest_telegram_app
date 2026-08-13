//! Turning match results into a number with an error bar.
//!
//! A weight change in an evaluation moves strength by a couple of percent. Over
//! a hundred games that is invisible: the standard error of a 100-game match is
//! about five percent, so two thirds of "improvements" measured that way are
//! noise. Every result printed anywhere in this crate carries its interval for
//! that reason.

#[derive(Copy, Clone, Debug, Default)]
pub struct Interval {
    pub lo: f64,
    pub hi: f64,
}

#[derive(Copy, Clone, Debug, Default)]
pub struct ScoreStats {
    /// Sample size — games, or pairs, depending on what was passed in.
    pub n: usize,
    /// Mean score, a win counting 1, a draw 0.5.
    pub mean: f64,
    pub stderr: f64,
    pub ci95: Interval,
}

/// Mean and normal-approximation interval over per-game scores. Draws are
/// ordinary observations at 0.5 — which is why this is not a binomial interval.
pub fn score_stats(scores: &[f64]) -> ScoreStats {
    let n = scores.len();
    if n == 0 {
        return ScoreStats::default();
    }
    let mean = scores.iter().sum::<f64>() / n as f64;
    if n == 1 {
        return ScoreStats { n, mean, stderr: 0.0, ci95: Interval { lo: mean, hi: mean } };
    }
    let variance = scores.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / (n - 1) as f64;
    let stderr = (variance / n as f64).sqrt();
    ScoreStats {
        n,
        mean,
        stderr,
        ci95: Interval {
            lo: (mean - 1.96 * stderr).max(0.0),
            hi: (mean + 1.96 * stderr).min(1.0),
        },
    }
}

/// Elo difference implied by a score. Meaningless on its own — it is a rescaled
/// win rate, not a rating — but it is the unit everyone quotes when comparing
/// two engine versions.
pub fn elo_diff(score: f64) -> f64 {
    let clamped = score.clamp(1e-6, 1.0 - 1e-6);
    -400.0 * (1.0 / clamped - 1.0).log10()
}

pub fn elo_interval(ci: Interval) -> Interval {
    Interval { lo: elo_diff(ci.lo), hi: elo_diff(ci.hi) }
}

/// Wilson score interval, for a plain win count with no draws.
pub fn wilson(wins: f64, n: f64, z: f64) -> Interval {
    if n == 0.0 {
        return Interval { lo: 0.0, hi: 1.0 };
    }
    let p = wins / n;
    let denom = 1.0 + z * z / n;
    let centre = p + z * z / (2.0 * n);
    let spread = z * (p * (1.0 - p) / n + z * z / (4.0 * n * n)).sqrt();
    Interval { lo: ((centre - spread) / denom).max(0.0), hi: ((centre + spread) / denom).min(1.0) }
}

pub fn percent(x: f64, digits: usize) -> String {
    format!("{:.*}%", digits, x * 100.0)
}
