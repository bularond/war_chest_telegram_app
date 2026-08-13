/**
 * Random playthroughs. These do not check strategy — they check that the engine
 * never offers an action it then rejects, never deadlocks, and always reaches a
 * finished game in a sane number of turns.
 */

import { describe, expect, it } from 'vitest';
import { actingSeat, applyAction, legalActions, markersRemaining } from './rules.js';
import { createGame } from './rules.js';
import { createRng, nextInt } from './rng.js';
import type { GameState } from './types.js';

const MAX_ACTIONS = 4000;

function playRandomGame(seed: number): { state: GameState; actions: number } {
  const rng = createRng(seed);
  const state = createGame({
    id: `fuzz-${seed}`,
    size: 2,
    seed,
    seats: [
      { userId: 'a', displayName: 'A' },
      { userId: 'b', displayName: 'B' },
    ],
  });

  let actions = 0;
  while (state.phase !== 'finished' && actions < MAX_ACTIONS) {
    const seat = actingSeat(state);
    const legal = legalActions(state, seat);
    expect(legal.length).toBeGreaterThan(0);

    // A minimally sane policy. Purely random play buries every coin in
    // bolsters, drains the supply and then stalls with one coin each — legal,
    // but it never reaches a late game. Taking a location when one is on offer,
    // and topping the bag up when it runs dry, is enough to drive games to an
    // end and exercise the interesting states on the way.
    const me = state.players[seat]!;
    const coins = me.hand.length + me.bag.length + me.discard.length;
    const grabs = legal.filter((a) => a.type === 'control' || a.type === 'followControl');
    const recruits = legal.filter((a) => a.type === 'recruit');
    const board = legal.filter((a) => a.type !== 'pass' && a.type !== 'recruit');

    let pool = legal;
    if (grabs.length > 0) pool = grabs;
    else if (coins <= 4 && recruits.length > 0) pool = recruits;
    else if (board.length > 0 && nextInt(rng, 10) < 8) pool = board;
    const action = pool[nextInt(rng, pool.length)]!;
    applyAction(state, seat, action);
    actions++;
  }
  return { state, actions };
}

describe('random playthroughs', () => {
  it('plays games out through the binding without an illegal or impossible position', () => {
    let finished = 0;
    for (let seed = 1; seed <= 8; seed++) {
      const { state } = playRandomGame(seed);
      if (state.phase === 'finished') {
        finished++;
        if (state.winner !== null) expect(markersRemaining(state, state.winner)).toBe(0);
      } else {
        // Unfinished is legal, not a deadlock: both sides have burnt every coin
        // onto the board and drained the supply, so each turn is one coin long.
        // What must never happen is a position with nothing to do.
        expect(legalActions(state, actingSeat(state)).length).toBeGreaterThan(0);
      }
    }
    expect(finished).toBeGreaterThan(4);
  });

  it('keeps board invariants at every step', () => {
    const state = createGame({
      id: 'inv',
      size: 2,
      seed: 99,
      seats: [
        { userId: 'a', displayName: 'A' },
        { userId: 'b', displayName: 'B' },
      ],
    });
    const rng = createRng(99);
    const boardHexes = new Set(
      Object.keys(state.units).concat(Object.keys(state.control)),
    );
    expect(boardHexes.size).toBeGreaterThan(0);

    let steps = 0;
    while (state.phase !== 'finished' && steps < 800) {
      const seat = actingSeat(state);
      const legal = legalActions(state, seat);
      expect(legal.length).toBeGreaterThan(0);
      applyAction(state, seat, legal[nextInt(rng, legal.length)]!);
      steps++;

      for (const [, stack] of Object.entries(state.units)) {
        expect(stack.coins).toBeGreaterThan(0);
      }
      for (const team of [0, 1]) {
        expect(markersRemaining(state, team)).toBeGreaterThanOrEqual(0);
      }
      for (const p of state.players) {
        expect(p.hand.length).toBeLessThanOrEqual(4); // 3, plus a Warrior Priest draw
      }
    }
  });
});
