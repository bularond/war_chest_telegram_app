/**
 * Property tests: whatever random play does, the position stays sound and every
 * action the engine offers can actually be played. A search will happily exploit
 * any hole here, so these run over whole games rather than fixed positions.
 */

import { describe, expect, it } from 'vitest';
import { markersRemaining } from './engine.js';
import { checkInvariants } from './invariants.js';
import { playRandomGame, uniformPolicy } from './playout.js';
import { createRng } from './rng.js';
import { apply, cloneState, hashState, isTerminal, legalMoves } from './state.js';
import type { GameState } from './types.js';
import type { UnitSet } from './units.js';

const SET_MIXES: readonly (readonly UnitSet[])[] = [
  [],
  ['nobility'],
  ['siege'],
  ['nightfall'],
  ['nobility', 'siege', 'nightfall'],
];

function violations(state: GameState): string[] {
  return checkInvariants(state);
}

describe('position invariants', () => {
  it('holds at every step of random games, with every set mix', () => {
    for (const [i, sets] of SET_MIXES.entries()) {
      for (let seed = 1; seed <= 6; seed++) {
        const rng = createRng(seed * 100 + i);
        const { state } = playRandomGame(
          {
            seed: seed * 100 + i,
            sets,
            maxPlies: 1200,
            onStep: (s, action, ply) => {
              const bad = violations(s);
              if (bad.length > 0) {
                throw new Error(
                  `sets=[${sets.join(',')}] seed=${seed * 100 + i} ply=${ply} ` +
                    `action=${JSON.stringify(action)}: ${bad.join('; ')}`,
                );
              }
            },
          },
          rng,
        );
        expect(violations(state)).toEqual([]);
      }
    }
  });

  it('finishes games only on a real win or a declared stalemate', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const { state } = playRandomGame({ seed, maxPlies: 1500 }, createRng(seed));
      if (!isTerminal(state)) continue;
      if (state.winner !== null) {
        expect(markersRemaining(state, state.winner)).toBe(0);
      } else {
        expect(state.log.at(-1)?.kind).toBe('stalemate');
      }
    }
  });

  it('can play every action it offers', () => {
    for (let seed = 1; seed <= 3; seed++) {
      const rng = createRng(seed);
      playRandomGame(
        {
          seed,
          sets: ['nobility', 'siege', 'nightfall'],
          maxPlies: 400,
          onStep: (s) => {
            if (isTerminal(s)) return;
            const legal = legalMoves(s);
            expect(legal.length).toBeGreaterThan(0);
            const before = hashState(s);
            for (const action of legal) {
              const after = apply(s, action);
              expect(violations(after)).toEqual([]);
            }
            expect(hashState(s)).toBe(before);
          },
        },
        rng,
      );
    }
  });

  it('never dead-ends: an unfinished position always has something to do', () => {
    for (let seed = 40; seed < 46; seed++) {
      const { state } = playRandomGame(
        { seed, policy: uniformPolicy, maxPlies: 1500 },
        createRng(seed),
      );
      if (!isTerminal(state)) expect(legalMoves(state).length).toBeGreaterThan(0);
    }
  });

  it('notices a broken position', () => {
    const { history } = playRandomGame({ seed: 5, sets: ['nobility', 'siege'], maxPlies: 200 }, createRng(5));
    const mid = history.at(-1) as GameState;
    expect(violations(mid)).toEqual([]);

    const lostCoin = cloneState(mid);
    (lostCoin.players[0] as GameState['players'][number]).bag.pop();
    expect(violations(lostCoin).join(' ')).toMatch(/coins, the card prints|royal coins/);

    const extraMarker = cloneState(mid);
    for (const hex of Object.keys(extraMarker.control)) extraMarker.control[hex] = 0;
    expect(violations(extraMarker).length).toBeGreaterThan(0);

    const stolenSeal = cloneState(mid);
    (stolenSeal.players[0] as GameState['players'][number]).seals += 1;
    expect(violations(stolenSeal).join(' ')).toMatch(/seals/);

    const ghostFort = cloneState(mid);
    ghostFort.fortSupply += 1;
    expect(violations(ghostFort).join(' ')).toMatch(/fortification/i);
  });
});
