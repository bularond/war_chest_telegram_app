/** The two primitives every priority list is built on. */

import {
  boardFor,
  createGame,
  fromId,
  neighbors,
  publicStateFor,
  toId,
  type GameState,
  type HexId,
} from '@wc/shared';
import { describe, expect, it } from 'vitest';
import {
  byPriority,
  centreOf,
  largest,
  senseFor,
  smallest,
  stepsFrom,
  stepsFromAny,
  stepsTo,
} from './board-sense.js';

function board(): GameState {
  return createGame({
    id: 'sense',
    size: 2,
    seed: 1,
    seats: [
      { userId: 'a', displayName: 'A' },
      { userId: 'b', displayName: 'B' },
    ],
    fixedUnits: [
      ['swordsman', 'archer', 'knight', 'scout'],
      ['footman', 'cavalry', 'archer', 'scout'],
    ],
  });
}

describe('walking distance', () => {
  it('counts steps, not hex distance, and walks around what is in the way', () => {
    const g = board();
    const view = publicStateFor(g, 0);
    const open = stepsFrom(view, '5,2');
    expect(open.get('5,2')).toBe(0);
    for (const hex of ['5,1', '4,2'] as HexId[]) expect(open.get(hex)).toBe(1);

    // Wall the unit in on every side but one; the far side is now a detour.
    const walled = board();
    const ring: HexId[] = ['5,1', '5,3', '4,2', '6,2', '4,1', '6,3'];
    for (const hex of ring.slice(0, 5)) {
      walled.units[hex] = { unit: 'footman', team: 1, seat: 1, coins: 1 };
    }
    const around = stepsFrom(publicStateFor(walled, 0), '5,2');
    // An occupied hex is still a destination — you just cannot pass through it.
    expect(around.get('5,1')).toBe(1);
    // Anything beyond the wall has to come the long way round.
    const beyond = around.get('4,0') ?? Infinity;
    const openBeyond = open.get('4,0') ?? Infinity;
    expect(beyond).toBeGreaterThan(openBeyond);
  });

  it('measures the same from a set of targets as from each candidate', () => {
    // The heuristic sweeps out from the targets once instead of walking from
    // every candidate, which is only allowed while the two agree. Occupied
    // targets are the interesting case: a walk may end on one, so the sweep
    // has to be able to leave one.
    const g = board();
    g.units['4,3'] = { unit: 'footman', team: 1, seat: 1, coins: 1 };
    g.units['6,2'] = { unit: 'cavalry', team: 1, seat: 1, coins: 1 };
    g.units['5,2'] = { unit: 'archer', team: 1, seat: 1, coins: 1 };
    const view = publicStateFor(g, 0);

    const targets: HexId[] = ['4,3', '6,2', '7,3'];
    const sweep = stepsFromAny(view, targets);
    for (const hex of boardFor(2).hexes) {
      const perCandidate = stepsTo(view, hex, targets);
      expect(sweep.get(hex) ?? Infinity).toBe(perCandidate);
    }
  });

  it('gives what the plain walk on hex ids gave, on a thousand positions', () => {
    // The sweep was rewritten to run on numbers instead of hex ids: half the
    // search's time was going into parsing and rebuilding those strings. A
    // rewrite of the thing the rollout policy asks thousands of times a second
    // is only allowed to be faster — every distance must come out identical, or
    // the bot plays a different game and every match measured before it is
    // measuring something else.
    //
    // `reference` below is the implementation it replaced, kept here as the
    // definition of "identical".
    const reference = (view: ReturnType<typeof publicStateFor>, sources: HexId[]) => {
      const onBoard = new Set(boardFor(view.size).hexes);
      const dist = new Map<HexId, number>();
      let frontier: HexId[] = [];
      for (const source of sources) {
        if (!onBoard.has(source) || dist.has(source)) continue;
        dist.set(source, 0);
        frontier.push(source);
      }
      const seeds = new Set(frontier);
      while (frontier.length > 0) {
        const next: HexId[] = [];
        for (const hex of frontier) {
          if (!seeds.has(hex) && view.units[hex]) continue;
          const d = (dist.get(hex) as number) + 1;
          for (const n of neighbors(fromId(hex))) {
            const id = toId(n);
            if (!onBoard.has(id) || dist.has(id)) continue;
            dist.set(id, d);
            next.push(id);
          }
        }
        frontier = next;
      }
      return dist;
    };

    const hexes = boardFor(2).hexes;
    let rng = 12345;
    const next = (n: number) => {
      // Any old repeatable generator: what is being varied is the position, not
      // the statistics of the positions.
      rng = (rng * 1103515245 + 12345) & 0x7fffffff;
      return rng % n;
    };

    for (let round = 0; round < 1000; round++) {
      const g = board();
      g.units = {};
      for (let i = 0; i < next(14); i++) {
        const hex = hexes[next(hexes.length)] as HexId;
        g.units[hex] = { unit: 'footman', team: next(2) as 0 | 1, seat: 0, coins: 1 };
      }
      const view = publicStateFor(g, 0);
      const sources: HexId[] = [];
      for (let i = 0; i <= next(4); i++) sources.push(hexes[next(hexes.length)] as HexId);

      const mine = stepsFromAny(view, sources);
      const theirs = reference(view, sources);
      for (const hex of hexes) expect(mine.get(hex)).toBe(theirs.get(hex));
      // And a hex that is not on the board is not a distance of zero.
      expect(mine.get('99,99' as HexId)).toBeUndefined();
    }
  });

  it('finds the middle of the board', () => {
    expect(centreOf(publicStateFor(board(), 0))).toBe('5,2');
  });
});

describe('how the board reads', () => {
  it('splits the locations into ours, theirs and nobody’s', () => {
    const g = board();
    const sense = senseFor(publicStateFor(g, 0));
    expect(sense.friendly).toEqual(['4,0', '7,0']);
    expect(sense.enemy).toEqual(['3,4', '6,5']);
    expect(sense.neutral).toContain('4,3');
    expect(sense.neutral).not.toContain('4,0');
    expect([...sense.friendly, ...sense.enemy, ...sense.neutral].length).toBe(10);
  });

  it('counts a location as enemy-occupied only when a foe stands on it', () => {
    const g = board();
    g.units['4,3'] = { unit: 'footman', team: 1, seat: 1, coins: 1 };
    g.units['6,2'] = { unit: 'swordsman', team: 0, seat: 0, coins: 1 };
    const sense = senseFor(publicStateFor(g, 0));
    expect(sense.enemyOccupied).toContain('4,3');
    expect(sense.enemyOccupied).not.toContain('6,2');
  });
});

describe('a priority list', () => {
  const evens = (xs: readonly number[]) => xs.filter((x) => x % 2 === 0);
  const overTen = (xs: readonly number[]) => xs.filter((x) => x > 10);

  it('stops as soon as one candidate is left', () => {
    // Evens leaves 2 and 12, so the list goes on; "over ten" then decides.
    expect(byPriority([1, 2, 3, 12], [evens, overTen])).toEqual([12]);
    // Evens alone leaves one candidate, and the rest of the list never runs.
    expect(byPriority([1, 2, 3], [evens, overTen])).toEqual([2]);
  });

  it('skips a criterion nothing satisfies rather than emptying the field', () => {
    // Nothing is over ten, so the list carries on with what survived before.
    expect(byPriority([2, 4, 6], [overTen, evens])).toEqual([2, 4, 6]);
  });

  it('keeps every candidate that ties', () => {
    expect(smallest([3, 1, 1, 5], (x) => x)).toEqual([1, 1]);
    expect(largest([3, 1, 5, 5], (x) => x)).toEqual([5, 5]);
    expect(smallest([Infinity, Infinity], (x) => x)).toEqual([]);
  });
});
