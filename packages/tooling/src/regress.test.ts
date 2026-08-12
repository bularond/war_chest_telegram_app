/**
 * The fit, checked on data whose answer is known in advance.
 *
 * A regression that returns plausible-looking numbers for any input is worse
 * than no regression, so these are the cases where the right answer can be
 * written down: a feature that decides everything, a feature that decides
 * nothing, and a feature that decides the opposite of what it looks like.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_FIT, fit, fitToValues, logLoss, normalize, valueLoss, type Sample } from './regress.js';

/** Positions where the first feature says who won and the second is noise. */
function honest(n: number): Sample[] {
  const out: Sample[] = [];
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < n; i++) {
    const signal = rand() * 2 - 1;
    out.push({ features: [signal, rand() * 2 - 1], result: signal > 0 ? 1 : 0 });
  }
  return out;
}

describe('fitting weights to outcomes', () => {
  it('finds the feature that decides the game and ignores the one that does not', () => {
    const w = fit(honest(2000));
    expect(w[0] as number).toBeGreaterThan(1);
    expect(Math.abs(w[1] as number)).toBeLessThan(Math.abs(w[0] as number) / 5);
  });

  it('gives a feature the sign it deserves, not the sign it looks like', () => {
    const samples: Sample[] = honest(2000).map((s) => ({
      ...s,
      // The second feature is the first, upside down: positions with more of it
      // lose. A fit that cannot produce a negative weight is no use for
      // something like dead weight in hand.
      features: [s.features[0] as number, -(s.features[0] as number)],
    }));
    const w = fit(samples);
    expect(w[0] as number).toBeGreaterThan(0);
    expect(w[1] as number).toBeLessThan(0);
  });

  it('leaves everything at zero when nothing predicts anything', () => {
    const samples: Sample[] = honest(500).map((s, i) => ({ ...s, result: i % 2 }));
    const w = fit(samples);
    for (const x of w) expect(Math.abs(x)).toBeLessThan(0.5);
  });

  it('reduces the loss it set out to reduce', () => {
    const samples = honest(1000);
    const before = logLoss(samples, [0, 0]);
    const after = logLoss(samples, fit(samples));
    expect(after).toBeLessThan(before);
  });

  it('is deterministic, because a tuner nobody can re-run is no tuner', () => {
    const samples = honest(300);
    expect(fit(samples)).toEqual(fit(samples));
  });

  it('counts a sample by its weight', () => {
    const one: Sample[] = [
      { features: [1], result: 1 },
      { features: [1], result: 0, weight: 9 },
    ];
    // Nine losses against one win from the same position: the weight has to
    // point down, or per-game weighting does nothing.
    expect(fit(one)[0] as number).toBeLessThan(0);
  });

  it('handles being given nothing', () => {
    expect(fit([])).toEqual([]);
    expect(logLoss([], [1, 2])).toBe(0);
  });
});

describe('normalising', () => {
  it('anchors on the coordinate it is told to', () => {
    expect(normalize([2, 1, -0.5], 0)).toEqual([1, 0.5, -0.25]);
  });

  it('leaves the vector alone when the anchor is zero', () => {
    expect(normalize([0, 1], 0)).toEqual([0, 1]);
  });
});

describe('fitting to what the search saw', () => {
  /** Positions whose value is a known function of the features, through `tanh`. */
  function valued(n: number, truth: readonly number[]): Sample[] {
    const out: Sample[] = [];
    let seed = 7;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let i = 0; i < n; i++) {
      const features = [rand() * 2 - 1, rand() * 2 - 1];
      const dot = features.reduce((s, x, k) => s + x * (truth[k] as number), 0);
      out.push({ features, result: Math.tanh(dot) });
    }
    return out;
  }

  it('recovers the weights that produced the values', () => {
    const truth = [1.2, -0.6];
    const w = fitToValues(valued(1500, truth), { ...DEFAULT_FIT, steps: 3000, rate: 3 });
    expect(w[0] as number).toBeCloseTo(truth[0] as number, 1);
    expect(w[1] as number).toBeCloseTo(truth[1] as number, 1);
  });

  it('reduces the error it set out to reduce', () => {
    const samples = valued(600, [0.9, 0.4]);
    expect(valueLoss(samples, fitToValues(samples))).toBeLessThan(valueLoss(samples, [0, 0]));
  });

  it('is a different question from who won, and gives a different answer', () => {
    // The same positions, labelled two ways: by a value that leans on the second
    // feature, and by an outcome that only ever follows the first. A fit that
    // could not tell them apart would be fitting neither.
    const base = valued(800, [0.2, 1.4]);
    const byOutcome = base.map((s) => ({ ...s, result: (s.features[0] as number) > 0 ? 1 : 0 }));
    const value = fitToValues(base, { ...DEFAULT_FIT, steps: 2000, rate: 3 });
    const outcome = fit(byOutcome);
    expect(Math.abs(value[1] as number)).toBeGreaterThan(Math.abs(value[0] as number));
    expect(Math.abs(outcome[0] as number)).toBeGreaterThan(Math.abs(outcome[1] as number));
  });
});
