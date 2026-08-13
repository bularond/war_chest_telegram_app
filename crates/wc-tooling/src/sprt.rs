//! The sequential test that decides whether a change is kept.
//!
//! The problem it solves: a change worth +10 Elo shifts the score by about one
//! percent, and a 100-game match measures the score to about ±5. Fixed-length
//! matches therefore either waste thousands of games on changes that are
//! obviously bad, or decide on noise. A sequential test watches the
//! log-likelihood ratio after every pair and stops the moment the evidence is
//! one-sided — bad changes die in a couple of hundred games, close ones are
//! played until they are not.
//!
//! The thresholds live here, in code, and the verdict is a function of the data.
//! That is the point: nobody gets to look at a promising-looking win rate and
//! call it an improvement.

#[derive(Copy, Clone, Debug)]
pub struct SprtSettings {
    /// Null hypothesis, in Elo. The usual choice is 0: "no better than before".
    pub elo0: f64,
    /// Alternative, in Elo. The smallest gain worth keeping.
    pub elo1: f64,
    /// False accept rate for H1.
    pub alpha: f64,
    /// False accept rate for H0.
    pub beta: f64,
}

/// The house defaults: reject anything not clearly better than the current
/// version, accept a gain of ten Elo, and be wrong five times in a hundred at
/// worst in either direction.
impl Default for SprtSettings {
    fn default() -> SprtSettings {
        SprtSettings { elo0: 0.0, elo1: 10.0, alpha: 0.05, beta: 0.05 }
    }
}

#[derive(Copy, Clone, PartialEq, Eq, Debug)]
pub enum Verdict {
    Accept,
    Reject,
    Continue,
}

impl Verdict {
    pub fn key(self) -> &'static str {
        match self {
            Verdict::Accept => "accept",
            Verdict::Reject => "reject",
            Verdict::Continue => "continue",
        }
    }
}

#[derive(Copy, Clone, Debug)]
pub struct SprtState {
    pub llr: f64,
    pub lower: f64,
    pub upper: f64,
    pub verdict: Verdict,
    /// Observations so far — pairs, not games.
    pub n: usize,
    pub mean: f64,
}

/// Expected score of a player `elo` points stronger.
pub fn elo_to_score(elo: f64) -> f64 {
    1.0 / (1.0 + 10f64.powf(-elo / 400.0))
}

/// Log-likelihood ratio under a normal model, computed over *pair* scores.
///
/// Pairs rather than games because the two halves of a pair share a deal, and
/// their sum is what carries the information about play. This is the same
/// variance reduction chess testing calls the pentanomial model.
pub fn sprt(pair_scores: &[f64], settings: SprtSettings) -> SprtState {
    let n = pair_scores.len();
    let upper = ((1.0 - settings.beta) / settings.alpha).ln();
    let lower = (settings.beta / (1.0 - settings.alpha)).ln();
    let idle = SprtState { llr: 0.0, lower, upper, verdict: Verdict::Continue, n, mean: 0.0 };

    // A handful of pairs cannot estimate a variance, and dividing by a lucky
    // zero would hand out a verdict on nothing at all.
    if n < 8 {
        return idle;
    }
    let mean = pair_scores.iter().sum::<f64>() / n as f64;
    let variance =
        pair_scores.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / (n - 1) as f64;
    if !(variance > 0.0) {
        return SprtState { mean, ..idle };
    }

    let mu0 = elo_to_score(settings.elo0);
    let mu1 = elo_to_score(settings.elo1);
    let llr = n as f64 * (mu1 - mu0) * (mean - (mu0 + mu1) / 2.0) / variance;
    let verdict = if llr >= upper {
        Verdict::Accept
    } else if llr <= lower {
        Verdict::Reject
    } else {
        Verdict::Continue
    };
    SprtState { llr, lower, upper, verdict, n, mean }
}
