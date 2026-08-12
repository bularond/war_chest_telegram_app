/**
 * The arena is a measuring instrument, so what is tested here is the instrument:
 * pairs really do start from the same position, sides really do swap, a match
 * really does repeat, and a mirror match really does land on 50%.
 */

import { GreedyBot, RandomBot } from '@wc/bots';
import { createGame, type GameState } from '@wc/shared';
import { describe, expect, it } from 'vitest';
import { playGame, runMatch } from './arena.js';
import { eloDiff, scoreStats, wilson } from './stats.js';

function opening(seed: number): GameState {
  return createGame({
    id: `arena-${seed}`,
    size: 2,
    seed,
    draftMode: 'random',
    seats: [
      { userId: 's0', displayName: 'x' },
      { userId: 's1', displayName: 'y' },
    ],
  });
}

describe('paired games', () => {
  it('start both halves from the same deal', () => {
    // The game is fixed by the seed alone: same units, same bag, same board.
    for (const seed of [1, 2, 3]) {
      const one = opening(seed);
      const two = opening(seed);
      expect(one.players.map((p) => p.units)).toEqual(two.players.map((p) => p.units));
      expect(one.players.map((p) => p.bag)).toEqual(two.players.map((p) => p.bag));
      expect(one.players.map((p) => p.hand)).toEqual(two.players.map((p) => p.hand));
      expect(one.initiative).toBe(two.initiative);
    }
  });

  it('swap which bot sits where', () => {
    const first = playGame(GreedyBot, RandomBot, 0, 1, { games: 2 });
    const second = playGame(GreedyBot, RandomBot, 1, 1, { games: 2 });
    expect(first.aSeat).toBe(0);
    expect(second.aSeat).toBe(1);
    // Same seed, different sides: the greedy bot should win from either.
    expect(first.scoreA).toBe(1);
    expect(second.scoreA).toBe(1);
  });
});

describe('runMatch', () => {
  it('repeats exactly on the same seed', () => {
    const opts = { games: 8, seed: 5 };
    const one = runMatch(GreedyBot, RandomBot, opts);
    const two = runMatch(GreedyBot, RandomBot, opts);
    expect(one.games.map((g) => g.scoreA)).toEqual(two.games.map((g) => g.scoreA));
    expect(one.games.map((g) => g.plies)).toEqual(two.games.map((g) => g.plies));
  });

  it('counts a whole number of pairs', () => {
    const r = runMatch(RandomBot, RandomBot, { games: 7, seed: 2, maxPlies: 400 });
    expect(r.games.length).toBe(8);
    expect(r.perPair.n).toBe(4);
    expect(r.winsA + r.winsB + r.draws).toBe(8);
  });

  it('puts a mirror match at even odds', () => {
    const r = runMatch(RandomBot, RandomBot, { games: 40, seed: 3, maxPlies: 600 });
    expect(r.perPair.ci95.lo).toBeLessThanOrEqual(0.5);
    expect(r.perPair.ci95.hi).toBeGreaterThanOrEqual(0.5);
  });

  it('separates greedy from random', () => {
    const r = runMatch(GreedyBot, RandomBot, { games: 30, seed: 4 });
    expect(r.perPair.mean).toBeGreaterThan(0.9);
    expect(r.perPair.ci95.lo).toBeGreaterThan(0.5);
  });

  it('reports what it measured the engine at', () => {
    const r = runMatch(GreedyBot, RandomBot, { games: 4, seed: 6 });
    expect(r.plies).toBeGreaterThan(0);
    expect(r.seconds).toBeGreaterThan(0);
    expect(r.msPerMoveA).toBeGreaterThanOrEqual(0);
  });
});

describe('statistics', () => {
  it('gives a wider interval to a shorter match', () => {
    const short = scoreStats(Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 1 : 0)));
    const long = scoreStats(Array.from({ length: 2000 }, (_, i) => (i % 2 === 0 ? 1 : 0)));
    expect(short.mean).toBeCloseTo(0.5);
    expect(long.mean).toBeCloseTo(0.5);
    expect(short.ci95.hi - short.ci95.lo).toBeGreaterThan(long.ci95.hi - long.ci95.lo);
  });

  it('treats draws as half a point', () => {
    expect(scoreStats([0.5, 0.5, 0.5, 0.5]).mean).toBe(0.5);
    expect(scoreStats([1, 0, 1, 0]).mean).toBe(0.5);
  });

  it('maps an even score to zero elo', () => {
    expect(eloDiff(0.5)).toBeCloseTo(0);
    expect(eloDiff(0.76)).toBeGreaterThan(190);
    expect(eloDiff(0.24)).toBeLessThan(-190);
  });

  it('keeps the wilson interval inside [0, 1]', () => {
    expect(wilson(0, 10).lo).toBe(0);
    expect(wilson(10, 10).hi).toBe(1);
    expect(wilson(5, 10).lo).toBeLessThan(0.5);
  });
});
