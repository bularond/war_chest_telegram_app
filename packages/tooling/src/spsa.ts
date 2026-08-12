/**
 * The SPSA update rule, apart from the games that feed it.
 *
 * Simultaneous Perturbation Stochastic Approximation (Spall, 1992) tunes a whole
 * vector with two measurements per step, however long the vector is: kick every
 * weight at once in a random direction, see which of the two kicked versions
 * plays better, and step the whole vector that way. Coordinate descent, by
 * contrast, spends a full experiment per weight.
 *
 * It lives here rather than in the CLI for the same reason `sprt.ts` does: this
 * is the part that decides where the weights go, and a rule that decides
 * anything in this project has to be checkable without playing a match.
 *
 * **What it will not do.** It will not switch a feature on — a weight at zero
 * stays at zero, because zero is a verdict from an experiment and not a starting
 * guess. It will not flip a sign — a weight that changed sign is a different
 * feature, not a smaller one. And it will not touch the anchor, because only the
 * ratios between weights mean anything: the sum goes through `tanh`, so scaling
 * all of them together is not a change of opinion, only of confidence.
 */

export interface SpsaSettings {
  /** Step size, as a fraction of each weight. */
  readonly a: number;
  /** Perturbation, as a fraction of each weight. */
  readonly c: number;
  /** Total steps planned — sets how fast the gains decay. */
  readonly steps: number;
  /** Weights held still. The anchor belongs here. */
  readonly fixed: readonly string[];
}

export const DEFAULT_SPSA: SpsaSettings = {
  a: 0.08,
  c: 0.12,
  steps: 150,
  fixed: ['markers'],
};

export type Weights = Record<string, number | string>;

/** Which weights a run may move: non-zero, numeric, not anchored. */
export function tunableKeys(weights: Weights, settings: SpsaSettings = DEFAULT_SPSA): string[] {
  return Object.keys(weights).filter(
    (key) =>
      key !== 'version' &&
      !settings.fixed.includes(key) &&
      typeof weights[key] === 'number' &&
      weights[key] !== 0,
  );
}

/**
 * The textbook schedule: `a/(A+k+1)^0.602` and `c/(k+1)^0.101`. `A` is a tenth
 * of the planned run, which keeps the first few steps from bolting.
 */
export function gains(k: number, settings: SpsaSettings = DEFAULT_SPSA): { a: number; c: number } {
  const A = Math.max(1, settings.steps / 10);
  return {
    a: settings.a / (A + k + 1) ** 0.602,
    c: settings.c / (k + 1) ** 0.101,
  };
}

/** One weight vector kicked along `delta`; `sign` picks which of the two. */
export function perturb(
  weights: Weights,
  delta: Readonly<Record<string, number>>,
  c: number,
  sign: 1 | -1,
): Weights {
  const out: Weights = { ...weights };
  for (const [key, d] of Object.entries(delta)) {
    const value = weights[key];
    if (typeof value !== 'number') continue;
    out[key] = round(value * (1 + sign * c * d));
  }
  return out;
}

/**
 * The step itself. `score` is what the kicked-up version scored against the
 * kicked-down one, in [0, 1]; a dead level 0.5 means the kick told us nothing
 * and nothing moves.
 */
export function step(
  weights: Weights,
  delta: Readonly<Record<string, number>>,
  score: number,
  a: number,
): Weights {
  const gradient = 2 * score - 1;
  const out: Weights = { ...weights };
  for (const [key, d] of Object.entries(delta)) {
    const value = weights[key];
    if (typeof value !== 'number' || value === 0) continue;
    const moved = value * (1 + a * gradient * d);
    // Towards zero it may creep, through zero it may not.
    out[key] = round(value > 0 ? Math.max(moved, value * 0.05) : Math.min(moved, value * 0.05));
  }
  return out;
}

function round(x: number): number {
  return Number(x.toFixed(6));
}
