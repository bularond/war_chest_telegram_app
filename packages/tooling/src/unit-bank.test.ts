/**
 * The bank has one property worth pinning, and it is the one that makes it
 * meaningful: it is not a new feature but `material` and `reserve` with their
 * degrees of freedom unlocked. Its board coordinates must sum to exactly the
 * material term and its reserve coordinates to exactly the reserve term.
 *
 * If that ever stops holding, a fit that prefers the bank is no longer telling
 * us "the units differ" — it is telling us the bank measures something else
 * entirely, and the comparison it exists for is void.
 */

import { FEATURES, featureVector } from '@wc/bots';
import {
  actingSeat,
  applyAction,
  createGame,
  createRng,
  publicStateFor,
  type GameState,
} from '@wc/shared';
import { HeuristicBot } from '@wc/bots';
import { describe, expect, it } from 'vitest';
import { BANK_UNITS, unitBank } from './unit-bank.js';

function midGame(seed: number): GameState {
  const state = createGame({
    id: `bank-${seed}`,
    size: 2,
    seed,
    draftMode: 'random',
    seats: [
      { userId: 'a', displayName: 'A' },
      { userId: 'b', displayName: 'B' },
    ],
  });
  const rng = createRng(seed);
  for (let i = 0; i < 30 && state.phase !== 'finished'; i++) {
    const seat = actingSeat(state);
    applyAction(state, seat, HeuristicBot.chooseMove(publicStateFor(state, seat), { rng, budget: {} }));
  }
  return state;
}

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

describe('one coordinate per unit', () => {
  it('splits material and reserve without changing them', () => {
    for (const seed of [3, 7, 11, 17]) {
      const state = midGame(seed);
      if (state.phase === 'finished') continue;
      for (const seat of [0, 1] as const) {
        const f = featureVector(state, seat);
        const bank = unitBank(state, seat);
        const half = BANK_UNITS.length;
        expect(sum(bank.slice(0, half))).toBeCloseTo(f[FEATURES.indexOf('material')] as number, 10);
        // Everything from `half` on: the units, plus the coordinate for the coins
        // that belong to no unit.
        expect(sum(bank.slice(half))).toBeCloseTo(f[FEATURES.indexOf('reserve')] as number, 10);
      }
    }
  });

  it('is a mirror from the other chair', () => {
    const state = midGame(5);
    const mine = unitBank(state, 0);
    const theirs = unitBank(state, 1);
    mine.forEach((x, i) => expect(x).toBeCloseTo(-(theirs[i] as number), 10));
  });

  it('carries a coordinate for every unit in the box, present or not', () => {
    // A vector whose length depends on which units were dealt cannot be fitted
    // across games at all.
    const a = unitBank(midGame(3), 0);
    const b = unitBank(midGame(9), 0);
    expect(a.length).toBe(b.length);
    expect(a.length).toBe(BANK_UNITS.length * 2 + 1);
  });
});
