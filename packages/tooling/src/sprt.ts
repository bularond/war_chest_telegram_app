/**
 * The sequential test that decides whether a change is kept.
 *
 * The problem it solves: a change worth +10 Elo shifts the score by about one
 * percent, and a 100-game match measures the score to about ±5. Fixed-length
 * matches therefore either waste thousands of games on changes that are obviously
 * bad, or decide on noise. A sequential test watches the log-likelihood ratio
 * after every pair and stops the moment the evidence is one-sided — bad changes
 * die in a couple of hundred games, close ones are played until they are not.
 *
 * The thresholds live here, in code, and the verdict is a function of the data.
 * That is the point: nobody — no human, and no model writing this file — gets to
 * look at a promising-looking win rate and call it an improvement.
 */

export interface SprtSettings {
  /** Null hypothesis, in Elo. The usual choice is 0: "no better than before". */
  readonly elo0: number;
  /** Alternative, in Elo. The smallest gain worth keeping. */
  readonly elo1: number;
  /** False accept rate for H1. */
  readonly alpha: number;
  /** False accept rate for H0. */
  readonly beta: number;
}

/**
 * The house defaults: reject anything not clearly better than the current
 * version, accept a gain of ten Elo, and be wrong five times in a hundred at
 * worst in either direction.
 */
export const DEFAULT_SPRT: SprtSettings = {
  elo0: 0,
  elo1: 10,
  alpha: 0.05,
  beta: 0.05,
};

export type SprtVerdict = 'accept' | 'reject' | 'continue';

export interface SprtState {
  readonly llr: number;
  readonly lower: number;
  readonly upper: number;
  readonly verdict: SprtVerdict;
  /** Observations so far — pairs, not games. */
  readonly n: number;
  readonly mean: number;
}

/** Expected score of a player `elo` points stronger. */
export function eloToScore(elo: number): number {
  return 1 / (1 + 10 ** (-elo / 400));
}

/**
 * Log-likelihood ratio under a normal model, computed over *pair* scores.
 *
 * Pairs rather than games because the two halves of a pair share a deal, and
 * their sum is what carries the information about play. This is the same
 * variance reduction chess testing calls the pentanomial model.
 */
export function sprt(pairScores: readonly number[], settings: SprtSettings = DEFAULT_SPRT): SprtState {
  const n = pairScores.length;
  const upper = Math.log((1 - settings.beta) / settings.alpha);
  const lower = Math.log(settings.beta / (1 - settings.alpha));
  const idle: SprtState = { llr: 0, lower, upper, verdict: 'continue', n, mean: 0 };

  // A handful of pairs cannot estimate a variance, and dividing by a lucky zero
  // would hand out a verdict on nothing at all.
  if (n < 8) return idle;

  const mean = pairScores.reduce((s, x) => s + x, 0) / n;
  const variance = pairScores.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1);
  if (!(variance > 0)) return { ...idle, mean };

  const mu0 = eloToScore(settings.elo0);
  const mu1 = eloToScore(settings.elo1);
  const llr = (n * (mu1 - mu0) * (mean - (mu0 + mu1) / 2)) / variance;

  const verdict: SprtVerdict = llr >= upper ? 'accept' : llr <= lower ? 'reject' : 'continue';
  return { llr, lower, upper, verdict, n, mean };
}
