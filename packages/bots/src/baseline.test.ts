/** The baselines: legal, reproducible, and greedy in the way it claims to be. */

import {
  actingSeat,
  applyAction,
  createGame,
  createRng,
  publicStateFor,
  type GameState,
} from '@wc/shared';
import { describe, expect, it } from 'vitest';
import { GreedyBot, RandomBot } from './baseline.js';
import type { Bot } from './types.js';

function game(seed = 1): GameState {
  return createGame({
    id: 'bot-test',
    size: 2,
    seed,
    draftMode: 'random',
    seats: [
      { userId: 'a', displayName: 'A' },
      { userId: 'b', displayName: 'B' },
    ],
  });
}

function playOut(bot: Bot, seed: number, plies: number): GameState {
  const state = game(seed);
  const ctx = { rng: createRng(seed), budget: {} };
  for (let i = 0; i < plies && state.phase !== 'finished'; i++) {
    const seat = actingSeat(state);
    applyAction(state, seat, bot.chooseMove(publicStateFor(state, seat), ctx));
  }
  return state;
}

describe.each([
  ['random', RandomBot],
  ['greedy', GreedyBot],
])('%s bot', (_name, bot) => {
  it('only ever plays a legal action', () => {
    // `applyAction` rejects anything illegal, so surviving the game is the test.
    expect(() => playOut(bot, 7, 300)).not.toThrow();
  });

  it('repeats itself given the same seed', () => {
    const one = playOut(bot, 11, 120);
    const two = playOut(bot, 11, 120);
    expect(one.log).toEqual(two.log);
  });

  it('plays differently from a different seed', () => {
    const one = playOut(bot, 12, 120);
    const two = playOut(bot, 13, 120);
    expect(one.log).not.toEqual(two.log);
  });
});

describe('greedy', () => {
  const ctx = { rng: createRng(1), budget: {} };

  it('claims a location when one is on offer', () => {
    const state = game(4);
    const me = state.players[0]!;
    // A unit standing on a location it does not control yet.
    state.units['4,3'] = { unit: me.units[0]!, team: 0, seat: 0, coins: 1 };
    delete state.control['4,3'];
    me.hand = [me.units[0]!, me.units[0]!, me.units[0]!];
    state.turn = 0;

    const action = GreedyBot.chooseMove(publicStateFor(state, 0), ctx);
    expect(action.type).toBe('control');
  });

  it('prefers a hit that destroys over one that only shrinks', () => {
    const state = game(4);
    const me = state.players[0]!;
    const foe = state.players[1]!;
    state.units['4,2'] = { unit: me.units[0]!, team: 0, seat: 0, coins: 1 };
    state.units['4,1'] = { unit: foe.units[0]!, team: 1, seat: 1, coins: 3 };
    state.units['3,2'] = { unit: foe.units[1]!, team: 1, seat: 1, coins: 1 };
    me.hand = [me.units[0]!, me.units[0]!, me.units[0]!];
    state.turn = 0;

    const action = GreedyBot.chooseMove(publicStateFor(state, 0), ctx);
    expect(action.type).toBe('attack');
    expect((action as { to: string }).to).toBe('3,2');
  });

  it('never discards a coin facedown while anything else is available', () => {
    const state = game(5);
    state.turn = 0;
    const action = GreedyBot.chooseMove(publicStateFor(state, 0), ctx);
    expect(action.type).not.toBe('pass');
  });
});
