import { describe, expect, it } from 'vitest';
import { UNIT_WORTH, unitWorth } from './unit-worth.js';
import { UNITS } from '@wc/shared';

describe('what a unit is worth to the evaluation', () => {
  it('spans two, so it lands on the same scale as every other feature', () => {
    // Not "+1 at the top and −1 at the bottom": zero is an even game at 50%,
    // and the table's own midpoint is not 50% — the best unit is further above
    // average than the worst is below it. What the scaling fixes is the width.
    const values = Object.values(UNIT_WORTH);
    expect(Math.max(...values) - Math.min(...values)).toBeCloseTo(2, 10);
    expect(Math.max(...values.map(Math.abs))).toBeLessThan(1.5);
  });

  it('ranks the units the measurement ranked', () => {
    expect(unitWorth('lightCavalry')).toBeGreaterThan(unitWorth('knight'));
    expect(unitWorth('knight')).toBeGreaterThan(unitWorth('footman'));
    expect(unitWorth('footman')).toBeLessThan(0);
  });

  it('covers every unit in the box, so nothing silently reads as average', () => {
    for (const spec of Object.values(UNITS)) {
      expect(typeof UNIT_WORTH[spec.id]).toBe('number');
    }
  });

  it('gives an unknown coin nothing rather than something', () => {
    expect(unitWorth('notAUnit' as never)).toBe(0);
  });
});
