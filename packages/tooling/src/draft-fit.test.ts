/**
 * The instrument, checked against games whose answer is known.
 *
 * This one is worth more care than most. Its whole job is to say whether pair
 * effects in the draft are real, and it has 120 parameters with which to say
 * "yes" about noise — the classic way to spend a week building a policy on
 * nothing. So it is tested both ways round: it must find a synergy that was put
 * there, and it must *fail* to find one that was not.
 */

import { createRng, nextFloat, type UnitId } from '@wc/shared';
import { describe, expect, it } from 'vitest';
import { fitDraft, pairKey, worthTo, type DraftGame } from './draft-fit.js';

const POOL: UnitId[] = [
  'archer',
  'berserker',
  'cavalry',
  'crossbowman',
  'ensign',
  'footman',
  'knight',
  'lightCavalry',
  'marshal',
  'mercenary',
  'pikeman',
  'royalGuard',
  'scout',
  'swordsman',
  'warriorPriest',
  'lancer',
];

/**
 * Games from a world we specify: every unit has a strength, an optional pair
 * gets a bonus on top, and the winner is drawn against the resulting odds.
 */
function world(
  count: number,
  seed: number,
  strength: (u: UnitId) => number,
  bonus: (a: UnitId, b: UnitId) => number,
): DraftGame[] {
  const rng = createRng(seed);
  const games: DraftGame[] = [];
  for (let n = 0; n < count; n++) {
    const bag = [...POOL];
    const drawn: UnitId[] = [];
    for (let i = 0; i < 8; i++) {
      drawn.push(...bag.splice(Math.floor(nextFloat(rng) * bag.length), 1));
    }
    const a = drawn.slice(0, 4);
    const b = drawn.slice(4);
    const side = (units: UnitId[]) => {
      let sum = 0;
      for (let i = 0; i < units.length; i++) {
        sum += strength(units[i] as UnitId);
        for (let j = i + 1; j < units.length; j++) sum += bonus(units[i] as UnitId, units[j] as UnitId);
      }
      return sum;
    };
    const odds = side(a) - side(b);
    const p = 1 / (1 + Math.exp(-odds));
    games.push({ a, b, scoreA: nextFloat(rng) < p ? 1 : 0 });
  }
  return games;
}

/** A tidy per-unit strength: first unit strongest, last weakest. */
const byIndex = (u: UnitId) => 0.5 - POOL.indexOf(u) * 0.08;

function correlation(xs: readonly number[], ys: readonly number[]): number {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < n; i++) {
    const dx = (xs[i] as number) - mx;
    const dy = (ys[i] as number) - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }
  return cov / Math.sqrt(vx * vy);
}

describe('when the draft really is additive', () => {
  const games = world(4000, 11, byIndex, () => 0);
  const report = fitDraft(games);

  it('recovers the ordering of the units', () => {
    // Correlation rather than an exact order: neighbours in this world are
    // 0.08 of a log-odd apart, which four thousand games cannot separate and a
    // real measurement never will either. What the drafter needs is the shape.
    const fitted = POOL.map((u) => report.additive.value[u] ?? 0);
    const truth = POOL.map(byIndex);
    expect(correlation(fitted, truth)).toBeGreaterThan(0.97);
  });

  it('does not pay for the pair terms on games it has not seen', () => {
    // 120 extra parameters always fit the training games better. The held-out
    // loss is the one that knows the difference, and here it must not improve —
    // if it does, the instrument would greenlight a policy built on noise.
    expect(report.onTrain.withPairs).toBeLessThanOrEqual(report.onTrain.additive + 1e-9);
    expect(report.heldOut.withPairs).toBeGreaterThan(report.heldOut.additive - 0.002);
  });

  it('leaves the synergies near zero, so a policy reading them changes nothing', () => {
    const biggest = Math.max(...Object.values(report.withPairs.synergy).map(Math.abs));
    expect(biggest).toBeLessThan(0.15);
  });
});

describe('when one side is simply favoured', () => {
  // Seat 0 moves first in a dealt game. That is worth something, it belongs to
  // no unit, and the difference of two sides cannot express it — so without a
  // term of its own it would be smeared across sixteen unit weights, tilting
  // every one of them and the draft table with them.
  const games = world(4000, 31, () => 0, () => 0).map((g) => ({
    ...g,
    scoreA: g.scoreA,
  }));
  const tilted = games.map((g, i) => ({ ...g, scoreA: i % 10 < 6 ? 1 : 0 }));
  const report = fitDraft(tilted);

  it('charges it to the intercept and not to the units', () => {
    expect(report.additive.firstMove).toBeGreaterThan(0.2);
    const biggest = Math.max(...POOL.map((u) => Math.abs(report.additive.value[u] ?? 0)));
    expect(biggest).toBeLessThan(0.1);
  });
});

describe('when two units really do work together', () => {
  const [one, two] = [POOL[3] as UnitId, POOL[9] as UnitId];
  const games = world(4000, 23, byIndex, (a, b) => (pairKey(a, b) === pairKey(one, two) ? 1.2 : 0));
  const report = fitDraft(games);

  it('finds that pair and not another', () => {
    const found = report.withPairs.synergy[pairKey(one, two)] ?? 0;
    expect(found).toBeGreaterThan(0.3);
    const others = Object.entries(report.withPairs.synergy)
      .filter(([k]) => k !== pairKey(one, two))
      .map(([, v]) => Math.abs(v));
    expect(found).toBeGreaterThan(Math.max(...others));
  });

  it('pays for the pair terms on games it has not seen', () => {
    expect(report.heldOut.withPairs).toBeLessThan(report.heldOut.additive);
  });

  it('tells a drafter that the second unit is worth more once it holds the first', () => {
    const alone = worthTo(report.withPairs, two, []);
    const together = worthTo(report.withPairs, two, [one]);
    expect(together).toBeGreaterThan(alone);
  });
});
