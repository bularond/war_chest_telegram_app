/**
 * The runner and the pool, which are the parts that can hurt a game they are
 * not even playing in: a bot that never answers, or one that eats the whole
 * server while somebody else is waiting for their own move.
 */

import {
  type GameState,
} from '@wc/shared';
import {
  actingSeat,
  applyAction,
  createGame,
  publicStateFor,
} from '@wc/shared/rules';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BotPool } from './bot-pool.js';
import { actingBotSeat, BotRunner, newBotRng, type BotSeat } from './bot-runner.js';

function botGame(seed = 4): GameState {
  return createGame({
    id: `runner-${seed}`,
    size: 2,
    seed,
    draftMode: 'random',
    seats: [
      { userId: 'human', displayName: 'Игрок' },
      { userId: 'bot:easy', displayName: 'Бот', bot: 'easy' },
    ],
  });
}

/** Hands the turn to the bot by playing the human's coin for them. */
function passTurnToBot(state: GameState): void {
  while (actingBotSeat(state) === null && state.phase === 'playing') {
    const seat = actingSeat(state);
    const legal = publicStateFor(state, seat).legal;
    applyAction(state, seat, legal[0]!);
  }
}

const pools: BotPool[] = [];
const runners: BotRunner[] = [];

afterEach(async () => {
  await Promise.all(runners.splice(0).map((r) => r.stop()));
  await Promise.all(pools.splice(0).map((p) => p.stop()));
});

describe('one move across several workers', () => {
  it('spreads a search over the idle workers and still plays legally', async () => {
    const pool = new BotPool({ limit: 4, deadlineMs: 30_000, threads: 4 });
    pools.push(pool);
    const state = botGame(6);
    passTurnToBot(state);
    const seat = actingBotSeat(state) as number;
    const view = publicStateFor(state, seat);

    const action = await pool.choose('medium', view, 5, 150);
    expect(view.legal.some((a) => JSON.stringify(a) === JSON.stringify(action))).toBe(true);
    expect(() => applyAction(state, seat, action)).not.toThrow();
  });

  it('leaves a level that does not search on one worker', async () => {
    // Easy is the heuristic: it has no tree, so twelve workers would return the
    // same move twelve times and occupy the machine to do it.
    const pool = new BotPool({ limit: 4, deadlineMs: 10_000, threads: 4 });
    pools.push(pool);
    const state = botGame();
    passTurnToBot(state);
    const seat = actingBotSeat(state) as number;

    await pool.choose('easy', publicStateFor(state, seat), 7);
    expect(pool.spawned).toBe(1);
  });

  it('takes what is idle rather than what it was promised', async () => {
    // Opportunistic on purpose: a busy server must degrade to the old behaviour
    // instead of queueing a move's halves behind each other, which would be
    // twice the wait and none of the benefit.
    const pool = new BotPool({ limit: 2, deadlineMs: 30_000, threads: 8 });
    pools.push(pool);
    const state = botGame(6);
    passTurnToBot(state);
    const seat = actingBotSeat(state) as number;
    const view = publicStateFor(state, seat);

    await pool.choose('medium', view, 5, 150);
    expect(pool.spawned).toBeLessThanOrEqual(2);
  });
});

describe('the worker pool', () => {
  it('answers with a legal move', async () => {
    const pool = new BotPool({ limit: 1, deadlineMs: 10_000 });
    pools.push(pool);
    const state = botGame();
    passTurnToBot(state);
    const seat = actingBotSeat(state) as number;
    const view = publicStateFor(state, seat);

    const action = await pool.choose('easy', view, 123);
    expect(view.legal.some((a) => JSON.stringify(a) === JSON.stringify(action))).toBe(true);
    // And it is playable on the real game, which is the only thing that counts.
    expect(() => applyAction(state, seat, action)).not.toThrow();
  });

  it('runs a search level too, and it is still legal', async () => {
    const pool = new BotPool({ limit: 1, deadlineMs: 20_000 });
    pools.push(pool);
    const state = botGame(6);
    passTurnToBot(state);
    const seat = actingBotSeat(state) as number;
    const view = publicStateFor(state, seat);

    const action = await pool.choose('medium', view, 7, 60);
    expect(view.legal.some((a) => JSON.stringify(a) === JSON.stringify(action))).toBe(true);
  });

  it('never runs more searches at once than it was allowed', async () => {
    const pool = new BotPool({ limit: 2, deadlineMs: 20_000 });
    pools.push(pool);
    const state = botGame(8);
    passTurnToBot(state);
    const seat = actingBotSeat(state) as number;
    const view = publicStateFor(state, seat);

    let peak = 0;
    const watching = setInterval(() => {
      peak = Math.max(peak, pool.busy);
    }, 1);
    const answers = await Promise.all(
      Array.from({ length: 6 }, (_, i) => pool.choose('medium', view, i + 1, 40)),
    );
    clearInterval(watching);

    expect(answers).toHaveLength(6);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('gives up on a bot that blows its deadline', async () => {
    // One millisecond is not enough to start a thread, let alone search in it.
    const pool = new BotPool({ limit: 1, deadlineMs: 1 });
    pools.push(pool);
    const state = botGame(10);
    passTurnToBot(state);
    const seat = actingBotSeat(state) as number;

    await expect(pool.choose('hard', publicStateFor(state, seat), 5)).rejects.toThrow(/timed out/);
  });
});

describe('the runner', () => {
  function table(state: GameState): { seat: () => BotSeat | null } {
    const rng = newBotRng();
    return { seat: () => ({ key: 'k', state, rng }) };
  }

  it('plays the bot’s turn and says so', async () => {
    const state = botGame(12);
    passTurnToBot(state);
    const before = state.log.length;

    const moved: string[] = [];
    const runner = new BotRunner(
      { limit: 1, thinkMs: 0, deadlineMs: 10_000 },
      (key) => moved.push(key),
      () => {},
    );
    runners.push(runner);
    runner.schedule('k', table(state).seat);

    await vi.waitFor(() => expect(moved).toEqual(['k']), { timeout: 10_000 });
    expect(state.log.length).toBeGreaterThan(before);
  });

  it('does nothing when no bot owes a move', async () => {
    const state = botGame(14);
    // It is the human's turn: nothing to do, and nothing scheduled.
    const moved: string[] = [];
    const runner = new BotRunner({ limit: 1, thinkMs: 0, deadlineMs: 5000 }, (k) => moved.push(k), () => {});
    runners.push(runner);
    while (actingBotSeat(state) !== null) {
      const seat = actingSeat(state);
      applyAction(state, seat, publicStateFor(state, seat).legal[0]!);
    }
    runner.schedule('k', table(state).seat);
    await new Promise((r) => setTimeout(r, 50));
    expect(moved).toEqual([]);
  });

  it('falls back to a simple move rather than leaving the game stuck', async () => {
    const state = botGame(16);
    passTurnToBot(state);
    const before = state.log.length;

    const errors: unknown[] = [];
    const moved: string[] = [];
    // A deadline no worker can meet: every turn must come from the fallback.
    const runner = new BotRunner(
      { limit: 1, thinkMs: 0, deadlineMs: 1 },
      (key) => moved.push(key),
      (_key, err) => errors.push(err),
    );
    runners.push(runner);
    runner.schedule('k', table(state).seat);

    await vi.waitFor(() => expect(moved).toEqual(['k']), { timeout: 10_000 });
    expect(errors.length).toBeGreaterThan(0);
    expect(state.log.length).toBeGreaterThan(before);
  });

  // The bug this catches: the runner announced the move while the table was
  // still marked as in flight, so the very next request — the one the server
  // makes from that announcement — was dropped, and a bot that owed two moves
  // in a row stopped after the first. The game sat there forever.
  it('accepts the next request straight from its own notification', async () => {
    const state = botGame(20);
    passTurnToBot(state);
    const moved: string[] = [];
    let runner: BotRunner;
    const seatOf = table(state).seat;
    runner = new BotRunner(
      { limit: 1, thinkMs: 0, deadlineMs: 10_000 },
      (key) => {
        moved.push(key);
        // Exactly what the server does: on hearing about a move, play the
        // human's answer and ask for the next bot turn in the same breath.
        if (moved.length < 3) {
          passTurnToBot(state);
          runner.schedule(key, seatOf);
        }
      },
      () => {},
    );
    runners.push(runner);
    runner.schedule('k', seatOf);

    await vi.waitFor(() => expect(moved.length).toBe(3), { timeout: 10_000 });
  });

  it('keeps one table out of the queue twice over', async () => {
    const state = botGame(18);
    passTurnToBot(state);
    const moved: string[] = [];
    const runner = new BotRunner({ limit: 2, thinkMs: 20, deadlineMs: 10_000 }, (k) => moved.push(k), () => {});
    runners.push(runner);

    const seat = table(state).seat;
    runner.schedule('k', seat);
    runner.schedule('k', seat);
    runner.schedule('k', seat);

    await vi.waitFor(() => expect(moved.length).toBeGreaterThan(0), { timeout: 10_000 });
    await new Promise((r) => setTimeout(r, 100));
    expect(moved).toEqual(['k']);
  });
});
