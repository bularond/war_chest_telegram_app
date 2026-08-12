/**
 * The update rule, checked without playing anything.
 *
 * SPSA has no verdict to hide behind — it just moves the weights, every step,
 * whatever the games said. So the properties that keep a long run from
 * wandering somewhere silly are worth stating as tests rather than as comments.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_SPSA, gains, perturb, step, tunableKeys, type Weights } from './spsa.js';

const base: Weights = {
  version: 'eval@3',
  markers: 1,
  material: 0.7,
  reserve: 0.15,
  bolster: 0,
  proximity: 0.4,
};

describe('what SPSA is allowed to move', () => {
  it('leaves the anchor, the version and every switched-off feature alone', () => {
    expect(tunableKeys(base)).toEqual(['material', 'reserve', 'proximity']);
  });

  it('cannot switch a feature back on', () => {
    // `bolster` is zero because an experiment said so. Multiplying zero is the
    // reason this holds, but the reason it *must* hold is the ladder in 8.3.
    const delta = { material: 1, bolster: 1 };
    expect(step(base, delta, 1, 0.5).bolster).toBe(0);
    expect(perturb(base, delta, 0.5, 1).bolster).toBe(0);
  });
});

describe('the step', () => {
  it('does nothing at all when the two kicked versions drew', () => {
    const delta = { material: 1, reserve: -1, proximity: 1 };
    expect(step(base, delta, 0.5, 0.1)).toEqual(base);
  });

  it('moves each weight the way its own kick pointed, when the kick won', () => {
    const delta = { material: 1, reserve: -1, proximity: 1 };
    const after = step(base, delta, 1, 0.1);
    expect(after.material as number).toBeGreaterThan(base.material as number);
    expect(after.reserve as number).toBeLessThan(base.reserve as number);
    expect(after.proximity as number).toBeGreaterThan(base.proximity as number);
  });

  it('moves the other way when the kick lost', () => {
    const delta = { material: 1, reserve: -1 };
    const after = step(base, delta, 0, 0.1);
    expect(after.material as number).toBeLessThan(base.material as number);
    expect(after.reserve as number).toBeGreaterThan(base.reserve as number);
  });

  it('never takes a weight through zero, however hard it is pushed', () => {
    const delta = { material: -1 };
    // A step size no schedule would ever produce, applied to a total loss.
    const after = step(base, delta, 1, 50);
    expect(after.material as number).toBeGreaterThan(0);
    expect(after.material as number).toBeLessThan(base.material as number);
  });

  it('is symmetric: winning by as much as it lost puts it back', () => {
    const delta = { material: 1, proximity: -1 };
    const up = step(base, delta, 1, 0.05);
    const down = step(up, delta, 0, 0.05 / (1 + 0.05));
    expect(down.material as number).toBeCloseTo(base.material as number, 6);
  });
});

describe('the schedule', () => {
  it('shrinks both gains as the run goes on', () => {
    const first = gains(0);
    const last = gains(DEFAULT_SPSA.steps - 1);
    expect(last.a).toBeLessThan(first.a);
    expect(last.c).toBeLessThan(first.c);
    // The step size decays a good deal faster than the perturbation: late steps
    // polish, but they still have to be able to see which way is up.
    expect(last.a / first.a).toBeLessThan(last.c / first.c);
  });

  it('kicks up and down by the same fraction', () => {
    const delta = { material: 1 };
    const up = perturb(base, delta, 0.1, 1).material as number;
    const down = perturb(base, delta, 0.1, -1).material as number;
    expect(up + down).toBeCloseTo(2 * (base.material as number), 6);
  });
});
