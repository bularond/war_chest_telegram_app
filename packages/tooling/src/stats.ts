/**
 * Turning match results into a number with an error bar.
 *
 * A weight change in an evaluation moves strength by a couple of percent. Over
 * a hundred games that is invisible: the standard error of a 100-game match is
 * about five percent, so two thirds of "improvements" measured that way are
 * noise. Every result printed here carries its interval for that reason.
 */

export interface Interval {
  readonly lo: number;
  readonly hi: number;
}

export interface ScoreStats {
  /** Sample size — games, or pairs, depending on what was passed in. */
  readonly n: number;
  /** Mean score, a win counting 1, a draw 0.5. */
  readonly mean: number;
  readonly stderr: number;
  readonly ci95: Interval;
}

/**
 * Mean and normal-approximation interval over per-game scores. Draws are
 * ordinary observations at 0.5 — which is why this is not a binomial interval.
 */
export function scoreStats(scores: readonly number[]): ScoreStats {
  const n = scores.length;
  if (n === 0) return { n: 0, mean: 0, stderr: 0, ci95: { lo: 0, hi: 0 } };
  const mean = scores.reduce((s, x) => s + x, 0) / n;
  if (n === 1) return { n, mean, stderr: 0, ci95: { lo: mean, hi: mean } };

  const variance = scores.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1);
  const stderr = Math.sqrt(variance / n);
  return {
    n,
    mean,
    stderr,
    ci95: { lo: Math.max(0, mean - 1.96 * stderr), hi: Math.min(1, mean + 1.96 * stderr) },
  };
}

/**
 * Elo difference implied by a score. Meaningless on its own — it is a rescaled
 * win rate, not a rating — but it is the unit everyone quotes when comparing
 * two engine versions.
 */
export function eloDiff(score: number): number {
  const clamped = Math.min(1 - 1e-6, Math.max(1e-6, score));
  return -400 * Math.log10(1 / clamped - 1);
}

export function eloInterval(ci: Interval): Interval {
  return { lo: eloDiff(ci.lo), hi: eloDiff(ci.hi) };
}

/** Wilson score interval, for a plain win count with no draws. */
export function wilson(wins: number, n: number, z = 1.96): Interval {
  if (n === 0) return { lo: 0, hi: 1 };
  const p = wins / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { lo: Math.max(0, (centre - spread) / denom), hi: Math.min(1, (centre + spread) / denom) };
}

export function percent(x: number, digits = 1): string {
  return `${(x * 100).toFixed(digits)}%`;
}
