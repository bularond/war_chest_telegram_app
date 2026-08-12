/**
 * The heuristic, checked two ways: the priority lists it claims to follow, and
 * the one number that matters — it must beat the greedy baseline convincingly.
 */

import {
  actingSeat,
  applyAction,
  createGame,
  createRng,
  publicStateFor,
  UNITS,
  type GameState,
  type HexId,
  type UnitId,
} from '@wc/shared';
import { describe, expect, it } from 'vitest';
import { GreedyBot } from './baseline.js';
import { createHeuristicBot, DEFAULT_WEIGHTS, HeuristicBot } from './heuristic.js';
import type { Bot } from './types.js';

function game(units: [UnitId[], UnitId[]], seed = 1): GameState {
  const g = createGame({
    id: 'heur',
    size: 2,
    seed,
    sets: ['nobility'],
    seats: [
      { userId: 'a', displayName: 'A' },
      { userId: 'b', displayName: 'B' },
    ],
    fixedUnits: units,
  });
  g.turn = 0;
  return g;
}

const ctx = () => ({ rng: createRng(7), budget: {} });

function choose(state: GameState, seat = 0) {
  return HeuristicBot.chooseMove(publicStateFor(state, seat), ctx());
}

function hand(state: GameState, seat: number, coins: UnitId[]): void {
  state.players[seat]!.hand = [...coins];
}

describe('the maneuver order', () => {
  it('takes the location when taking it wins the game', () => {
    const g = game([['swordsman', 'archer', 'knight', 'scout'], ['footman', 'cavalry', 'archer', 'scout']]);
    // One marker left: placing it ends the game.
    for (const loc of ['4,0', '7,0', '8,2', '3,1', '4,3'] as HexId[]) g.control[loc] = 0;
    g.units['6,5'] = { unit: 'swordsman', team: 0, seat: 0, coins: 1 };
    g.units['5,5'] = { unit: 'footman', team: 1, seat: 1, coins: 1 };
    delete g.control['6,5'];
    hand(g, 0, ['swordsman', 'swordsman', 'swordsman']);

    expect(choose(g).type).toBe('control');
  });

  it('otherwise hits something before taking a location', () => {
    const g = game([['swordsman', 'archer', 'knight', 'scout'], ['footman', 'cavalry', 'archer', 'scout']]);
    g.units['6,5'] = { unit: 'swordsman', team: 0, seat: 0, coins: 1 };
    g.units['5,5'] = { unit: 'footman', team: 1, seat: 1, coins: 1 };
    delete g.control['6,5'];
    hand(g, 0, ['swordsman', 'swordsman', 'swordsman']);

    const action = choose(g);
    expect(action.type).toBe('attack');
  });

  it('moves when it can neither hit nor take', () => {
    const g = game([['swordsman', 'archer', 'knight', 'scout'], ['footman', 'cavalry', 'archer', 'scout']]);
    g.units['5,2'] = { unit: 'swordsman', team: 0, seat: 0, coins: 1 };
    hand(g, 0, ['swordsman', 'swordsman', 'swordsman']);

    expect(choose(g).type).toBe('move');
  });

  it('never bolsters — except to get at a Knight', () => {
    const plain = game([['swordsman', 'archer', 'knight', 'scout'], ['footman', 'cavalry', 'archer', 'scout']]);
    plain.units['5,2'] = { unit: 'swordsman', team: 0, seat: 0, coins: 1 };
    hand(plain, 0, ['swordsman', 'swordsman', 'swordsman']);
    expect(choose(plain).type).not.toBe('bolster');

    // A Knight may only be attacked by a bolstered unit, so bolstering is the
    // only way through — the chart's one exception.
    const knight = game([['swordsman', 'archer', 'scout', 'footman'], ['knight', 'cavalry', 'archer', 'scout']]);
    knight.units['5,2'] = { unit: 'swordsman', team: 0, seat: 0, coins: 1 };
    knight.units['5,1'] = { unit: 'knight', team: 1, seat: 1, coins: 1 };
    hand(knight, 0, ['swordsman', 'swordsman', 'swordsman']);

    const action = choose(knight);
    expect(action.type).toBe('bolster');
    expect((action as { at: HexId }).at).toBe('5,2');
  });
});

describe('the priority lists', () => {
  it('deploys to the location nearer an enemy one', () => {
    const g = game([['swordsman', 'archer', 'knight', 'scout'], ['footman', 'cavalry', 'archer', 'scout']]);
    // Our two starting locations, 4,0 and 7,0, are symmetric until something
    // breaks the tie: an enemy marker on 3,1 puts 4,0 nearer an enemy location.
    g.control['3,1'] = 1;
    hand(g, 0, ['swordsman', 'swordsman', 'swordsman']);

    const action = choose(g);
    expect(action.type).toBe('deploy');
    expect((action as { to: HexId }).to).toBe('4,0');
  });

  it('recruits the unit with the most coins left in the supply', () => {
    const g = game([['swordsman', 'archer', 'knight', 'scout'], ['footman', 'cavalry', 'archer', 'scout']]);
    const me = g.players[0]!;
    me.supply = { swordsman: 3, archer: 0, knight: 1, scout: 0 };
    // Nothing on the board and nowhere to deploy, so recruiting is the move.
    hand(g, 0, ['swordsman']);
    g.units = {};
    g.control = {};

    const recruits = publicStateFor(g, 0).legal.filter((a) => a.type === 'recruit');
    expect(recruits.length).toBeGreaterThan(1);
    const action = HeuristicBot.chooseMove(publicStateFor(g, 0), ctx());
    expect(action).toEqual({ type: 'recruit', coin: 0, unit: 'swordsman' });
  });

  it('leaves a Swordsman standing on a location it has just taken', () => {
    const g = game([['swordsman', 'archer', 'knight', 'scout'], ['footman', 'cavalry', 'archer', 'scout']]);
    g.units['4,3'] = { unit: 'swordsman', team: 0, seat: 0, coins: 1 };
    g.units['4,2'] = { unit: 'footman', team: 1, seat: 1, coins: 1 };
    g.control['4,3'] = 1; // an enemy location, worth holding
    hand(g, 0, ['swordsman', 'swordsman', 'swordsman']);

    applyAction(g, 0, { type: 'attack', coin: 0, from: '4,3', to: '4,2' });
    expect(g.pending.at(-1)?.kind).toBe('optionalMove');
    expect(choose(g)).toEqual({ type: 'skip' });
  });
});

describe('as an opponent', () => {
  function playOut(bot: Bot, seed: number, plies: number): GameState {
    const state = createGame({
      id: 'play',
      size: 2,
      seed,
      draftMode: 'random',
      seats: [
        { userId: 'a', displayName: 'A' },
        { userId: 'b', displayName: 'B' },
      ],
    });
    const c = { rng: createRng(seed), budget: {} };
    for (let i = 0; i < plies && state.phase !== 'finished'; i++) {
      const seat = actingSeat(state);
      applyAction(state, seat, bot.chooseMove(publicStateFor(state, seat), c));
    }
    return state;
  }

  it('only ever plays a legal action, with every expansion in play', () => {
    for (const seed of [1, 2, 3]) {
      const state = createGame({
        id: 'legal',
        size: 2,
        seed,
        sets: ['nobility', 'siege', 'nightfall'],
        draftMode: 'draft',
        seats: [
          { userId: 'a', displayName: 'A' },
          { userId: 'b', displayName: 'B' },
        ],
      });
      const c = { rng: createRng(seed), budget: {} };
      expect(() => {
        for (let i = 0; i < 400 && state.phase !== 'finished'; i++) {
          const seat = actingSeat(state);
          applyAction(state, seat, HeuristicBot.chooseMove(publicStateFor(state, seat), c));
        }
      }).not.toThrow();
    }
  });

  it('repeats itself given the same seed', () => {
    expect(playOut(HeuristicBot, 21, 150).log).toEqual(playOut(HeuristicBot, 21, 150).log);
  });

  it('beats the greedy baseline convincingly', () => {
    // The roadmap's readiness bar for this stage. Paired games, sides swapped.
    let score = 0;
    const games = 24;
    for (let pair = 0; pair < games / 2; pair++) {
      for (const heuristicSeat of [0, 1]) {
        const state = createGame({
          id: `m-${pair}`,
          size: 2,
          seed: 100 + pair,
          draftMode: 'random',
          seats: [
            { userId: 'a', displayName: 'A' },
            { userId: 'b', displayName: 'B' },
          ],
        });
        const rngs = [createRng(pair * 2 + 1), createRng(pair * 2 + 2)];
        let plies = 0;
        while (state.phase !== 'finished' && plies < 1500) {
          const seat = actingSeat(state);
          const bot = seat === heuristicSeat ? HeuristicBot : GreedyBot;
          applyAction(state, seat, bot.chooseMove(publicStateFor(state, seat), {
            rng: rngs[seat] as ReturnType<typeof createRng>,
            budget: {},
          }));
          plies++;
        }
        score += state.winner === null ? 0.5 : state.winner === heuristicSeat ? 1 : 0;
      }
    }
    expect(score / games).toBeGreaterThan(0.75);
  });
});

describe('the knobs', () => {
  it('are wired through to behaviour', () => {
    const g = game([['swordsman', 'archer', 'knight', 'scout'], ['footman', 'cavalry', 'archer', 'scout']]);
    g.units['6,5'] = { unit: 'swordsman', team: 0, seat: 0, coins: 1 };
    g.units['5,5'] = { unit: 'footman', team: 1, seat: 1, coins: 1 };
    delete g.control['6,5'];
    hand(g, 0, ['swordsman', 'swordsman', 'swordsman']);

    const chartOrder = HeuristicBot.chooseMove(publicStateFor(g, 0), ctx());
    const controlFirst = createHeuristicBot(
      { attackBeforeControl: false, preferKills: false },
      'control-first',
    ).chooseMove(publicStateFor(g, 0), ctx());

    expect(chartOrder.type).toBe('attack');
    expect(controlFirst.type).toBe('control');
  });
});

describe('drafting', () => {
  // The draft has never been measured, and until it is, the only thing worth
  // asserting is that the setting does what it says — a knob that silently does
  // nothing turns an experiment into a draw and wastes a night.
  const draftView = (by: 'coins' | 'scarcity' | 'random') => {
    const g = createGame({
      id: `draft-${by}`,
      size: 2,
      seed: 2,
      draftMode: 'draft',
      seats: [
        { userId: 'a', displayName: 'A' },
        { userId: 'b', displayName: 'B' },
      ],
    });
    expect(g.phase).toBe('draft');
    return { g, view: publicStateFor(g, actingSeat(g)) };
  };

  it('takes the unit the box prints most of, by default', () => {
    const { view } = draftView('coins');
    const action = createHeuristicBot().chooseMove(view, { rng: createRng(1), budget: {} });
    const picked = UNITS[(action as { unit: UnitId }).unit];
    const offered = view.legal.map((a) => UNITS[(a as { unit: UnitId }).unit].coins);
    expect(picked.coins).toBe(Math.max(...offered));
  });

  it('takes the short print run when asked to', () => {
    const { view } = draftView('scarcity');
    const bot = createHeuristicBot({ ...DEFAULT_WEIGHTS, draftBy: 'scarcity' }, 'scarce');
    const action = bot.chooseMove(view, { rng: createRng(1), budget: {} });
    const picked = UNITS[(action as { unit: UnitId }).unit];
    const offered = view.legal.map((a) => UNITS[(a as { unit: UnitId }).unit].coins);
    expect(picked.coins).toBe(Math.min(...offered));
  });

  it('drafts by what was measured, when asked to', () => {
    const { view } = draftView('coins');
    const bot = createHeuristicBot({ ...DEFAULT_WEIGHTS, draftBy: 'measured' }, 'measured');
    const action = bot.chooseMove(view, { rng: createRng(1), budget: {} });
    // Light Cavalry, Scout and Mercenary top the table; whichever of them is in
    // the pool must be the pick, and the coin count must not decide it.
    const offered = view.legal.map((a) => (a as { unit: UnitId }).unit);
    const best = offered.reduce((a, b) => (VALUE_ORDER.indexOf(a) < VALUE_ORDER.indexOf(b) ? a : b));
    expect((action as { unit: UnitId }).unit).toBe(best);
  });
});


/** The measured order, highest win rate first. Kept beside the table it checks. */
const VALUE_ORDER: UnitId[] = [
  'lightCavalry',
  'scout',
  'mercenary',
  'cavalry',
  'royalGuard',
  'warriorPriest',
  'pikeman',
  'crossbowman',
  'archer',
  'knight',
  'marshal',
  'ensign',
  'lancer',
  'swordsman',
  'berserker',
  'footman',
];

