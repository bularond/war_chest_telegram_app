/**
 * The search, checked where it can be checked cheaply: that it plays legally,
 * that it repeats itself, that it spends the budget it was given, and that it
 * finds the move a beginner would see. Whether it plays *well* is a question
 * for the arena, not for a unit test.
 */

import {
  actingSeat,
  actionKey,
  applyAction,
  createGame,
  createRng,
  publicStateFor,
  type GameState,
  type HexId,
  type UnitId,
} from '@wc/shared';
import { describe, expect, it } from 'vitest';
import { BASE_WEIGHTS, evaluate, type EvalWeights } from './eval.js';
import { createSearchBot, runSearch, DEFAULT_SEARCH, SearchBot } from './ismcts.js';
import { HeuristicBot } from './heuristic.js';
import { BOTS } from './registry.js';

function game(seed = 3, units?: [UnitId[], UnitId[]]): GameState {
  return createGame({
    id: 'search',
    size: 2,
    seed,
    draftMode: 'random',
    seats: [
      { userId: 'a', displayName: 'A' },
      { userId: 'b', displayName: 'B' },
    ],
    ...(units ? { fixedUnits: units } : {}),
  });
}

const small = createSearchBot({ iterations: 60 }, 'ismcts-tiny');

/**
 * Building a position by hand means moving coins, never conjuring them. A
 * player holding more coins than their cards print is a position no game can
 * reach, and `sampleDeterminization` refuses it — which is how these helpers
 * came to exist in the first place.
 */
function takeCoin(state: GameState, seat: number, unit: UnitId): void {
  const p = state.players[seat]!;
  const inHand = p.hand.indexOf(unit);
  if (inHand !== -1) {
    p.hand.splice(inHand, 1);
    return;
  }
  const inBag = p.bag.indexOf(unit);
  if (inBag === -1) throw new Error(`seat ${seat} has no ${unit} coin left to move`);
  p.bag.splice(inBag, 1);
}

/** Sets a hand, returning whatever was held to the bag first. */
function dealHand(state: GameState, seat: number, coins: UnitId[]): void {
  const p = state.players[seat]!;
  p.bag.push(...p.hand);
  p.hand = [];
  for (const coin of coins) takeCoin(state, seat, coin);
  p.hand = [...coins];
}

/** Puts one coin on the board, out of the hand or the bag. */
function deploy(state: GameState, seat: number, unit: UnitId, hex: HexId): void {
  takeCoin(state, seat, unit);
  state.units[hex] = { unit, team: state.players[seat]!.team, seat, coins: 1 };
}

describe('the search as a player', () => {
  it('plays a whole game without an illegal move', () => {
    const state = game(11);
    const ctx = { rng: createRng(11), budget: {} };
    expect(() => {
      for (let i = 0; i < 80 && state.phase !== 'finished'; i++) {
        const seat = actingSeat(state);
        applyAction(state, seat, small.chooseMove(publicStateFor(state, seat), ctx));
      }
    }).not.toThrow();
    expect(state.log.length).toBeGreaterThan(10);
  });

  it('holds up with every expansion on the table', () => {
    const state = createGame({
      id: 'search-sets',
      size: 2,
      seed: 5,
      sets: ['nobility', 'siege', 'nightfall'],
      draftMode: 'draft',
      seats: [
        { userId: 'a', displayName: 'A' },
        { userId: 'b', displayName: 'B' },
      ],
    });
    const ctx = { rng: createRng(5), budget: {} };
    expect(() => {
      for (let i = 0; i < 60 && state.phase !== 'finished'; i++) {
        const seat = actingSeat(state);
        applyAction(state, seat, small.chooseMove(publicStateFor(state, seat), ctx));
      }
    }).not.toThrow();
  });

  it('repeats itself given the same seed and the same budget', () => {
    const state = game(7);
    const view = publicStateFor(state, actingSeat(state));
    const one = runSearch(view, { rng: createRng(2), budget: { iterations: 120 } });
    const two = runSearch(view, { rng: createRng(2), budget: { iterations: 120 } });
    expect(one.action).toEqual(two.action);
    expect(one.visits).toBe(two.visits);
  });

  it('spends the budget it is given', () => {
    const state = game(9);
    const view = publicStateFor(state, actingSeat(state));
    const report = runSearch(view, { rng: createRng(1), budget: { iterations: 150 } });
    expect(report.iterations).toBe(150);
    // Every iteration ends in some root move being credited.
    expect(report.visits).toBeGreaterThan(0);
    expect(report.visits).toBeLessThanOrEqual(150);
  });

  it('stops when the clock says so, and still answers', () => {
    const state = game(13);
    const view = publicStateFor(state, actingSeat(state));
    // A clock that jumps 5 ms per reading: the deadline arrives after a few
    // checks, whatever the machine underneath is doing.
    let fake = 0;
    const report = runSearch(view, {
      rng: createRng(4),
      budget: { ms: 100 },
      now: () => (fake += 5),
    });
    expect(report.iterations).toBeGreaterThan(0);
    expect(report.iterations).toBeLessThan(DEFAULT_SEARCH.iterations);
    expect(view.legal.some((a) => JSON.stringify(a) === JSON.stringify(report.action))).toBe(true);
  });

  it('takes the win when the win is one move away', () => {
    const state = game(3, [
      ['swordsman', 'archer', 'knight', 'scout'],
      ['footman', 'cavalry', 'archer', 'scout'],
    ]);
    // Five markers down, a unit standing on a sixth, and a coin to claim it.
    for (const loc of ['4,0', '7,0', '8,2', '3,1', '4,3'] as HexId[]) state.control[loc] = 0;
    deploy(state, 0, 'swordsman', '6,2');
    delete state.control['6,2'];
    dealHand(state, 0, ['swordsman']);
    state.turn = 0;

    const chosen = SearchBot.chooseMove(publicStateFor(state, 0), {
      rng: createRng(6),
      budget: { iterations: 300 },
    });
    expect(chosen.type).toBe('control');
  });
});

describe('the evaluation', () => {
  it('is decided by the result once the game is over', () => {
    const state = game(21);
    state.phase = 'finished';
    state.winner = 0;
    expect(evaluate(state, 0)).toBe(1);
    expect(evaluate(state, 1)).toBe(-1);
    state.winner = null;
    expect(evaluate(state, 0)).toBe(0);
  });

  it('prefers the side with more markers placed', () => {
    const even = game(22);
    expect(evaluate(even, 0)).toBeCloseTo(-evaluate(even, 1), 6);

    const ahead = game(22);
    ahead.control['4,3'] = 0;
    ahead.control['6,2'] = 0;
    expect(evaluate(ahead, 0)).toBeGreaterThan(evaluate(even, 0));
    expect(evaluate(ahead, 1)).toBeLessThan(evaluate(even, 1));
  });

  it('stays inside [-1, 1] however lopsided the board', () => {
    const state = game(23);
    for (const loc of Object.keys(state.control)) state.control[loc] = 0;
    for (const hex of ['5,2', '4,2', '6,2'] as HexId[]) {
      state.units[hex] = { unit: 'swordsman', team: 0, seat: 0, coins: 9 };
    }
    const score = evaluate(state, 0, { ...BASE_WEIGHTS, markers: 40, material: 40 });
    expect(score).toBeLessThanOrEqual(1);
    expect(score).toBeGreaterThan(0.9);
  });
});

describe('the rollout policy', () => {
  // What "quick" gives up is the tie-break, not the ranking: it still attacks
  // when there is an attack, it just does not work out which target the
  // priority list would have chosen. Timing lives in `npm run bench`; a clock
  // reading is no basis for a pass or a fail.
  function twoTargets(): GameState {
    const state = game(3, [
      ['crossbowman', 'swordsman', 'knight', 'scout'],
      ['footman', 'cavalry', 'archer', 'scout'],
    ]);
    // A Crossbowman with two enemies in reach: one next to it, hit by a plain
    // attack, and one two hexes away in a straight line, hit by its tactic —
    // the hex between them has to stay empty for that. The priority list starts
    // with "adjacent unit", so the full policy always takes the near one.
    deploy(state, 0, 'crossbowman', '5,2');
    deploy(state, 1, 'footman', '4,2');
    deploy(state, 1, 'cavalry', '5,0');
    dealHand(state, 0, ['crossbowman']);
    state.turn = 0;
    return state;
  }

  it('offers both the plain attack and the tactic here', () => {
    const view = publicStateFor(twoTargets(), 0);
    const targets = view.legal
      .filter((a) => a.type === 'attack' || a.type === 'tactic')
      .map((a) => (a as { to?: string; target?: string }).to ?? (a as { target?: string }).target);
    expect(new Set(targets)).toEqual(new Set(['4,2', '5,0']));
  });

  it('still picks the same kind of move as the full policy', () => {
    const view = publicStateFor(twoTargets(), 0);
    for (const seed of [1, 2, 3, 4, 5]) {
      const quick = BOTS['heuristic-quick']!.chooseMove(view, { rng: createRng(seed), budget: {} });
      expect(['attack', 'tactic']).toContain(quick.type);
    }
  });

  it('leaves the choice of target to chance, where the full policy does not', () => {
    const view = publicStateFor(twoTargets(), 0);
    const targetsOf = (name: string) => {
      const seen = new Set<string>();
      for (let seed = 1; seed <= 40; seed++) {
        const action = BOTS[name]!.chooseMove(view, { rng: createRng(seed), budget: {} });
        seen.add((action as { to?: string; target?: string }).to ?? (action as { target?: string }).target ?? '?');
      }
      return seen;
    };
    expect(targetsOf('heuristic').size).toBe(1);
    expect(targetsOf('heuristic-quick').size).toBeGreaterThan(1);
  });
});

/**
 * A lock on what the search does, not on how it does it.
 *
 * The rollout and the descent were rewritten to run on one state instead of
 * copying it at every ply — about fifteen full copies an iteration, gone. That
 * kind of change is only allowed to be invisible: the same seed must still pick
 * the same move, with the same visit count and the same value, or the bot in the
 * next match is not the bot in the last one.
 *
 * The weights *and the search settings* are frozen here on purpose. Stage 8
 * moves both by experiment — the exploration constant changed the night this
 * comment was written — and this test is about the machinery, not the numbers.
 * Pinned to what they were when the master was recorded, so a tuned constant
 * never has to be confused with a broken descent.
 */
describe('the search, move for move', () => {
  const FROZEN: EvalWeights = {
    version: 'golden',
    markers: 1,
    material: 0.7,
    reserve: 0.15,
    scarcity: 0,
    reach: 0,
    bolster: 0,
    proximity: 0.4,
    initiative: 0,
    tempo: 0,
    hand: 0,
    threat: 0,
    deadWeight: 0,
  };

  const GOLDEN: Record<string, string> = {
    '3/120': '{"at":"5,-1","coin":0,"type":"bolster"} 10 -0.063963',
    '3/400': '{"at":"5,-1","coin":0,"type":"bolster"} 38 -0.079141',
    '7/120': '{"coin":1,"type":"recruit","unit":"warriorPriest"} 8 -0.132623',
    '7/400': '{"at":"6,5","coin":2,"type":"bolster"} 27 -0.174233',
    '11/120': '{"coin":1,"to":"3,4","type":"deploy"} 8 -0.076172',
    '11/400': '{"coin":2,"from":"4,4","to":"4,3","type":"move"} 33 -0.057959',
  };

  it('picks the same moves it picked before the copying went', () => {
    const config = {
      ...DEFAULT_SEARCH,
      weights: FROZEN,
      exploration: 0.9,
      rolloutDepth: 12,
      firstPlay: Infinity,
    };
    for (const seed of [3, 7, 11]) {
      const state = game(seed);
      // Walk in a couple of dozen plies, so the position has coins on the board
      // and a tree worth building.
      const walk = createRng(seed);
      for (let i = 0; i < 24 && state.phase !== 'finished'; i++) {
        const seat = actingSeat(state);
        const r = runSearch(publicStateFor(state, seat), { rng: walk, budget: { iterations: 30 } }, config);
        applyAction(state, seat, r.action);
      }

      const view = publicStateFor(state, actingSeat(state));
      for (const iterations of [120, 400]) {
        const r = runSearch(view, { rng: createRng(seed * 13), budget: { iterations } }, config);
        expect(`${actionKey(r.action)} ${r.visits} ${r.value.toFixed(6)}`).toBe(GOLDEN[`${seed}/${iterations}`]);
      }
    }
  });
});

/**
 * The bug this guards against cost two experiments of a night's tuning.
 *
 * A node remembers which seat chose there, written when the node was first
 * created. A later iteration draws a different hand for the opponent, and in
 * *that* game the same sequence of moves leaves a different seat to answer — a
 * defender only chooses where to take a hit when they have somewhere to take it.
 * Applying the move as the remembered seat then threw «not your turn» out of the
 * engine, killing the search mid-match.
 *
 * It never showed at the default exploration constant: which branches get walked
 * decides whether the search ever reaches such a node. So this plays at several
 * constants, with the expansions in, which is where the awkward steps live.
 */
describe('the search over many determinizations', () => {
  // Slow by design: what is being covered is a case a single position cannot
  // reach, so it plays a few dozen of them.
  it('applies each move as whoever actually owes it', { timeout: 60_000 }, () => {
    for (const exploration of [0.3, 0.9, 1.8]) {
      const bot = createSearchBot({ exploration, iterations: 40 }, `x${exploration}`);
      for (const seed of [1, 2, 3, 4, 5, 6]) {
        const state = createGame({
          id: `seats-${exploration}-${seed}`,
          size: 2,
          seed,
          sets: ['nobility', 'siege', 'nightfall'],
          draftMode: 'random',
          seats: [
            { userId: 'a', displayName: 'A' },
            { userId: 'b', displayName: 'B' },
          ],
        });
        const ctx = { rng: createRng(seed), budget: { iterations: 40 } };
        expect(() => {
          for (let i = 0; i < 40 && state.phase !== 'finished'; i++) {
            const seat = actingSeat(state);
            applyAction(state, seat, bot.chooseMove(publicStateFor(state, seat), ctx));
          }
        }).not.toThrow();
      }
    }
  });
});

describe('first play urgency', () => {
  // With `Infinity` the search must touch every available move before it looks
  // at any of them twice; with a low enough value it is allowed to stop
  // widening. That is the whole point of the setting, and it is visible in the
  // visit counts without playing a single match — which is where it should have
  // been checked the first two times, instead of in a match.
  //
  // The value has to be negative to do anything. An untried move is priced at
  // `firstPlay` plus the exploration bonus a once-visited child would get, and
  // that bonus is above one at a few hundred iterations; a threshold above it
  // never bites. Instrumented on a 28-move position at 600 iterations: -0.4
  // leaves the best move on 45 visits, -0.8 lifts it to 112-245, -1.2 gives it
  // all 600.
  it('stops the search from having to try every move once', () => {
    const state = game(5);
    // Walk in far enough for the branching to be wide.
    const walk = createRng(5);
    for (let i = 0; i < 20 && state.phase !== 'finished'; i++) {
      const seat = actingSeat(state);
      applyAction(state, seat, HeuristicBot.chooseMove(publicStateFor(state, seat), { rng: walk, budget: {} }));
    }
    const view = publicStateFor(state, actingSeat(state));
    expect(view.legal.length).toBeGreaterThan(8);

    const wide = runSearch(view, { rng: createRng(1), budget: { iterations: 200 } }, DEFAULT_SEARCH);
    const narrow = runSearch(
      view,
      { rng: createRng(1), budget: { iterations: 200 } },
      { ...DEFAULT_SEARCH, firstPlay: -0.8 },
    );
    // The same iterations, spent on fewer moves: the chosen move is looked at
    // more often.
    expect(narrow.visits).toBeGreaterThan(wide.visits);
    expect(view.legal.some((a) => JSON.stringify(a) === JSON.stringify(narrow.action))).toBe(true);
  });

  it('leaves the default alone', () => {
    expect(DEFAULT_SEARCH.firstPlay).toBe(Infinity);
  });
});
