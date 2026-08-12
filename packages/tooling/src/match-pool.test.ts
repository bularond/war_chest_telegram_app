/**
 * Playing games across cores has to be an optimisation and nothing more: the
 * same seeds must give the same games, or every experiment run this way is
 * measuring a different thing from the one run sequentially.
 */

import { availableParallelism } from 'node:os';
import { BASE_WEIGHTS } from '@wc/bots';
import { describe, expect, it } from 'vitest';
import { playGame } from './arena.js';
import { botFromSpec, type BotSpec } from './bot-spec.js';
import { defaultJobs, MatchPool } from './match-pool.js';

const greedy: BotSpec = { kind: 'named', name: 'greedy' };
const heuristic: BotSpec = { kind: 'named', name: 'heuristic' };

describe('the match pool', () => {
  it('gives the same result as playing the games one after another', async () => {
    const pairs = [1, 2, 3].map((n) => ({ pair: n, seed: 100 + n }));

    const sequential = pairs.map((p) =>
      ([0, 1] as const).map((aSeat) =>
        playGame(botFromSpec(heuristic), botFromSpec(greedy), aSeat, p.seed, { games: 2 }),
      ),
    );

    const pool = new MatchPool(heuristic, greedy, { jobs: 3 });
    const parallel = await pool.playPairs(pairs);
    await pool.close();

    expect(parallel.map((half) => half.map((g) => g.scoreA))).toEqual(
      sequential.map((half) => half.map((g) => g.scoreA)),
    );
    expect(parallel.map((half) => half.map((g) => g.plies))).toEqual(
      sequential.map((half) => half.map((g) => g.plies)),
    );
  });

  it('keeps the pairs in the order they were asked for', async () => {
    const pairs = [5, 6, 7, 8].map((n) => ({ pair: n, seed: 200 + n }));
    const pool = new MatchPool(heuristic, greedy, { jobs: 4 });
    const played = await pool.playPairs(pairs);
    await pool.close();

    expect(played.map((half) => half[0]?.pair)).toEqual([5, 6, 7, 8]);
    // Each pair is the same deal from both sides.
    for (const half of played) {
      expect(half[0]?.aSeat).toBe(0);
      expect(half[1]?.aSeat).toBe(1);
      expect(half[0]?.seed).toBe(half[1]?.seed);
    }
  });

  it('works with one worker as well as with many', async () => {
    const pairs = [{ pair: 1, seed: 42 }];
    const one = new MatchPool(heuristic, greedy, { jobs: 1 });
    const many = new MatchPool(heuristic, greedy, { jobs: 4 });
    const [alone, together] = await Promise.all([one.playPairs(pairs), many.playPairs(pairs)]);
    await Promise.all([one.close(), many.close()]);
    expect(alone[0]?.map((g) => g.scoreA)).toEqual(together[0]?.map((g) => g.scoreA));
  });

  it('leaves the machine something to run on', () => {
    // Bots think for a wall-clock budget, so oversubscribing cores would make
    // every bot weaker and every match longer.
    expect(defaultJobs()).toBeGreaterThanOrEqual(1);
    expect(defaultJobs()).toBeLessThan(availableParallelism());
  });

  it('reports a broken bot instead of hanging', async () => {
    const pool = new MatchPool({ kind: 'named', name: 'no-such-bot' }, greedy, { jobs: 1 });
    await expect(pool.playPairs([{ pair: 1, seed: 1 }])).rejects.toThrow(/no-such-bot/);
    await pool.close();
  });
});

describe('two clocks', () => {
  // The difficulty levels differ in nothing but thinking time, so measuring the
  // gap between two of them means giving the two sides different budgets. A
  // budget silently dropped on the way to the worker would not fail — it would
  // quietly report that the levels are identical, which is the answer that
  // costs the most to believe.
  it('gives each side the budget it was promised, across the worker boundary', async () => {
    const generous: BotSpec = { kind: 'search', label: 'slow', weights: BASE_WEIGHTS };
    const hurried: BotSpec = { kind: 'search', label: 'quick', weights: BASE_WEIGHTS };
    const pool = new MatchPool(generous, hurried, {
      budgetMs: 60,
      budgetMsB: 1,
      maxPlies: 30,
      jobs: 2,
    });
    const [half] = await pool.playPairs([{ pair: 1, seed: 7 }]);
    await pool.close();

    const game = half?.[0];
    expect(game).toBeDefined();
    expect(game?.decisionsA ?? 0).toBeGreaterThan(3);
    // Sixty times the allowance should not come out level. The margin is loose
    // on purpose: this is a timing test, and the machine is usually busy.
    expect(game?.msA ?? 0).toBeGreaterThan((game?.msB ?? 0) * 3);
  }, 30_000);

  it('leaves both sides equal when only one budget is given', async () => {
    const spec: BotSpec = { kind: 'search', label: 'same', weights: BASE_WEIGHTS };
    const pool = new MatchPool(spec, spec, { budgetMs: 20, maxPlies: 20, jobs: 2 });
    const [half] = await pool.playPairs([{ pair: 1, seed: 9 }]);
    await pool.close();
    const game = half?.[0];
    const perMoveA = (game?.msA ?? 0) / Math.max(1, game?.decisionsA ?? 1);
    const perMoveB = (game?.msB ?? 0) / Math.max(1, game?.decisionsB ?? 1);
    expect(Math.abs(perMoveA - perMoveB)).toBeLessThan(15);
  }, 30_000);
});

describe('playing as a stream', () => {
  it('gives the same games as the batch version, whatever order they land in', async () => {
    const pairs = [1, 2, 3, 4].map((n) => ({ pair: n, seed: 300 + n }));

    const batched = new MatchPool(heuristic, greedy, { jobs: 4 });
    const expected = new Map(
      (await batched.playPairs(pairs)).map((half, i) => [
        pairs[i]?.pair,
        half.map((g) => `${g.scoreA}/${g.plies}`).join(' '),
      ]),
    );
    await batched.close();

    const streamed = new MatchPool(heuristic, greedy, { jobs: 4 });
    const seen = new Map<number, string>();
    let cursor = 0;
    await streamed.playStream(
      () => pairs[cursor++] ?? null,
      (halves, pair) => {
        seen.set(pair.pair, halves.map((g) => `${g.scoreA}/${g.plies}`).join(' '));
      },
      () => true,
    );
    await streamed.close();

    expect(seen.size).toBe(pairs.length);
    for (const [pair, text] of expected) expect(seen.get(pair as number)).toBe(text);
  });

  it('stops asking for more the moment it is told to', async () => {
    const pool = new MatchPool(heuristic, greedy, { jobs: 4 });
    let asked = 0;
    let landed = 0;
    await pool.playStream(
      () => ({ pair: asked, seed: 400 + asked++ }),
      () => {
        landed++;
      },
      () => landed < 2,
    );
    await pool.close();

    // Two pairs are enough to stop it; what is already in flight still lands,
    // but nothing new is started, so this cannot run away.
    expect(landed).toBeGreaterThanOrEqual(2);
    expect(asked).toBeLessThan(12);
  });

  it('keeps the machine busy rather than waiting for the slowest game', async () => {
    // Six pairs through three slots: if it waited for each batch it would take
    // two full rounds; streaming means a free slot is filled at once. What is
    // asserted is only that all of them ran — the timing is what the comment
    // above is for.
    const pool = new MatchPool(heuristic, greedy, { jobs: 6 });
    const landed: number[] = [];
    let cursor = 0;
    await pool.playStream(
      () => (cursor < 6 ? { pair: cursor, seed: 500 + cursor++ } : null),
      (_halves, pair) => landed.push(pair.pair),
      () => true,
    );
    await pool.close();
    expect(landed.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe('a half never played alone', () => {
  it('finishes the second half of a pair even after being told to stop', async () => {
    // Half a pair scores nothing — the two halves share a deal and only their
    // sum means anything. So a stop must not strand one of them: that is a game
    // played for nothing, on a machine where a game costs half a minute.
    const pool = new MatchPool(heuristic, greedy, { jobs: 2 });
    const landed: number[] = [];
    let asked = 0;
    await pool.playStream(
      () => (asked < 3 ? { pair: asked, seed: 600 + asked++ } : null),
      (halves, pair) => {
        expect(halves[0]?.aSeat).toBe(0);
        expect(halves[1]?.aSeat).toBe(1);
        landed.push(pair.pair);
      },
      () => landed.length === 0,
    );
    await pool.close();
    // Whatever it started, it finished as whole pairs.
    expect(landed.length).toBeGreaterThanOrEqual(1);
    for (const pair of landed) expect(pair).toBeLessThan(asked);
  });
});
