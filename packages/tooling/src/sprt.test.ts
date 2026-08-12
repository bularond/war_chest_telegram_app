/**
 * The test that decides what gets kept, tested itself.
 *
 * If this is wrong, every experiment after it is wrong in the same direction
 * and nobody notices — a bad SPRT does not look broken, it looks like progress.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_SPRT, eloToScore, sprt } from './sprt.js';

/** Pair scores from a side that wins a fraction `p` of its pairs outright. */
function pairs(n: number, p: number): number[] {
  return Array.from({ length: n }, (_, i) => (i / n < p ? 1 : 0));
}

describe('elo', () => {
  it('reads an even score as no difference', () => {
    expect(eloToScore(0)).toBeCloseTo(0.5, 10);
  });

  it('grows with the rating gap', () => {
    expect(eloToScore(100)).toBeGreaterThan(eloToScore(10));
    expect(eloToScore(-100)).toBeLessThan(0.5);
  });
});

describe('the sequential test', () => {
  it('says nothing at all on a handful of games', () => {
    // The roadmap's rule: no decisions on a hundred games, and certainly not on
    // six. Too few observations to estimate a variance is too few to decide.
    for (let n = 0; n < 8; n++) {
      expect(sprt(pairs(n, 1)).verdict).toBe('continue');
    }
  });

  it('holds its peace while the sides are even', () => {
    const even = Array.from({ length: 400 }, (_, i) => (i % 2 === 0 ? 1 : 0));
    const state = sprt(even);
    expect(state.mean).toBeCloseTo(0.5, 2);
    expect(state.verdict).toBe('continue');
  });

  it('accepts a change that is plainly better', () => {
    const state = sprt(pairs(200, 0.75));
    expect(state.verdict).toBe('accept');
    expect(state.llr).toBeGreaterThanOrEqual(state.upper);
  });

  it('rejects a change that is plainly worse', () => {
    const state = sprt(pairs(200, 0.25));
    expect(state.verdict).toBe('reject');
    expect(state.llr).toBeLessThanOrEqual(state.lower);
  });

  it('kills a bad change long before a fixed-length match would end', () => {
    // A change losing 40% of its pairs: the point of the whole exercise is that
    // this costs a couple of hundred games, not thousands.
    let decided = 0;
    const scores: number[] = [];
    for (let i = 0; i < 2000; i++) {
      scores.push(i % 5 === 0 ? 1 : 0); // 20% pair wins
      const state = sprt(scores);
      if (state.verdict !== 'continue') {
        decided = scores.length;
        expect(state.verdict).toBe('reject');
        break;
      }
    }
    expect(decided).toBeGreaterThan(0);
    expect(decided).toBeLessThan(300);
  });

  it('makes the bounds follow the error rates it was given', () => {
    const strict = sprt(pairs(50, 0.6), { ...DEFAULT_SPRT, alpha: 0.01, beta: 0.01 });
    const loose = sprt(pairs(50, 0.6), { ...DEFAULT_SPRT, alpha: 0.1, beta: 0.1 });
    // Demanding fewer mistakes means demanding more evidence.
    expect(strict.upper).toBeGreaterThan(loose.upper);
    expect(strict.lower).toBeLessThan(loose.lower);
  });

  it('turns a small edge into evidence against a big claim', () => {
    // Two percent above even. That supports "a shade better" and argues against
    // "much better" — which is what stops a barely-positive result from being
    // written up as a breakthrough.
    const scores = pairs(200, 0.52);
    const modest = sprt(scores, { ...DEFAULT_SPRT, elo1: 5 });
    const bold = sprt(scores, { ...DEFAULT_SPRT, elo1: 100 });
    expect(modest.llr).toBeGreaterThan(0);
    expect(bold.llr).toBeLessThan(0);
  });
});
