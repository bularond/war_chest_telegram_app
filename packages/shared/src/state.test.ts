/**
 * The guarantees a search leans on: `apply` never touches the state it is given,
 * a clone shares nothing the engine writes to, and a state survives a round trip
 * through text unchanged.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { actingSeat, applyAction, legalActions } from './engine.js';
import { createRng, nextInt } from './rng.js';
import { createGame } from './setup.js';
import {
  actionKey,
  apply,
  cloneState,
  simulate,
  deserializeState,
  hashState,
  isTerminal,
  legalMoves,
  moveKey,
  serializeState,
} from './state.js';
import { isCoinAction, type GameAction, type GameState, type PendingStep } from './types.js';
import type { CoinId, UnitSet } from './units.js';

function newGame(seed: number, sets: readonly UnitSet[] = []): GameState {
  return createGame({
    id: `pure-${seed}`,
    size: 2,
    seed,
    sets,
    seats: [
      { userId: 'a', displayName: 'A' },
      { userId: 'b', displayName: 'B' },
    ],
  });
}

/**
 * The fuzz test's policy: grab a location when one is on offer, refill the bag
 * when it runs dry, otherwise prefer acting on the board. Random play alone
 * bolsters everything into a stall and never reaches a late game.
 */
function pick(state: GameState, legal: GameAction[], rng: { seed: number }): GameAction {
  const me = state.players[actingSeat(state)];
  const coins = me ? me.hand.length + me.bag.length + me.discard.length : 0;
  const grabs = legal.filter((a) => a.type === 'control' || a.type === 'followControl');
  const recruits = legal.filter((a) => a.type === 'recruit');
  const board = legal.filter((a) => a.type !== 'pass' && a.type !== 'recruit');

  let pool = legal;
  if (grabs.length > 0) pool = grabs;
  else if (coins <= 4 && recruits.length > 0) pool = recruits;
  else if (board.length > 0 && nextInt(rng, 10) < 8) pool = board;
  return pool[nextInt(rng, pool.length)] as GameAction;
}

/** Plays a game out with `apply`, never mutating a state it has already seen. */
function playPure(seed: number, sets: readonly UnitSet[] = [], maxActions = 4000) {
  const rng = createRng(seed);
  const states: GameState[] = [newGame(seed, sets)];
  let state = states[0] as GameState;
  let actions = 0;

  while (!isTerminal(state) && actions < maxActions) {
    const legal = legalMoves(state);
    expect(legal.length).toBeGreaterThan(0);
    const before = hashState(state);
    const next = apply(state, pick(state, legal, rng));
    // The source state is the one a live game would be holding.
    expect(hashState(state)).toBe(before);
    state = next;
    states.push(state);
    actions++;
  }
  return { state, states, actions };
}

describe('canonical text', () => {
  it('is byte for byte what the plain implementation produced', () => {
    // Rewritten for speed: `actionKey` runs on every legal move of every search
    // iteration, and the old version allocated four arrays and a closure each
    // time. The text it produces is an identity — the search tells one edge of
    // its tree from another by it, and a state hash is that text — so the only
    // acceptable difference is how long it takes to make.
    const reference = (value: unknown): string => {
      if (value === null) return 'null';
      switch (typeof value) {
        case 'number':
        case 'boolean':
        case 'string':
          return JSON.stringify(value);
        case 'object':
          break;
        default:
          throw new Error(`cannot serialize ${typeof value}`);
      }
      if (Array.isArray(value)) return `[${value.map(reference).join(',')}]`;
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${reference(v)}`).join(',')}}`;
    };

    for (const seed of [1, 5, 9]) {
      const { states } = playPure(seed, ['nobility', 'siege', 'nightfall'], 400);
      for (const state of states) {
        expect(serializeState(state)).toBe(reference(state));
        for (const action of legalMoves(state)) {
          expect(actionKey(action)).toBe(reference(action));
        }
      }
    }
  });

  it('still writes what JSON writes for the awkward values', () => {
    // Not positions the engine can reach — the point is that the fast paths
    // fall back rather than inventing their own JSON.
    for (const value of ['a"b', 'c\\d', 'ключ', '\n', 1e21, -0, 0.1]) {
      expect(actionKey({ type: 'skip', note: value } as never)).toBe(
        JSON.stringify({ note: value, type: 'skip' }),
      );
    }
  });
});

describe('pure state handling', () => {
  it('plays whole games without touching an earlier state', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const { states } = playPure(seed);
      expect(states.length).toBeGreaterThan(20);
      // Nothing written along the way leaked backwards into the opening.
      const opening = states[0] as GameState;
      expect(opening.round).toBeLessThanOrEqual(1);
      expect(Object.keys(opening.units).length).toBe(0);
    }
  });

  it('holds up with the expansions in play', () => {
    const { state, actions } = playPure(7, ['nobility', 'siege', 'nightfall'], 1500);
    expect(actions).toBeGreaterThan(20);
    expect(state.decrees.length).toBeGreaterThan(0);
  });

  it('clones share nothing the engine writes to', () => {
    const { states } = playPure(11, ['nobility', 'siege']);
    const mid = states[Math.floor(states.length / 2)] as GameState;
    const copy = cloneState(mid);
    expect(hashState(copy)).toBe(hashState(mid));

    expect(copy.players).not.toBe(mid.players);
    expect(copy.units).not.toBe(mid.units);
    expect(copy.control).not.toBe(mid.control);
    expect(copy.rng).not.toBe(mid.rng);
    for (let i = 0; i < mid.players.length; i++) {
      const a = mid.players[i] as GameState['players'][number];
      const b = copy.players[i] as GameState['players'][number];
      expect(b).not.toBe(a);
      expect(b.bag).not.toBe(a.bag);
      expect(b.hand).not.toBe(a.hand);
      expect(b.discard).not.toBe(a.discard);
      expect(b.supply).not.toBe(a.supply);
      expect(b.removed).not.toBe(a.removed);
    }
    for (const hex of Object.keys(mid.units)) {
      expect(copy.units[hex]).not.toBe(mid.units[hex]);
    }
    for (let i = 0; i < mid.decrees.length; i++) {
      expect(copy.decrees[i]?.seals).not.toBe(mid.decrees[i]?.seals);
    }

    // Play the copy out; the original must not move.
    const before = hashState(mid);
    const rng = createRng(1234);
    let running = copy;
    for (let i = 0; i < 40 && !isTerminal(running); i++) {
      const legal = legalMoves(running);
      running = apply(running, pick(running, legal, rng));
    }
    expect(hashState(mid)).toBe(before);
  });

  it('survives a round trip through text', () => {
    const { states } = playPure(13, ['nobility', 'siege']);
    for (const state of [states[3], states[Math.floor(states.length / 2)], states.at(-1)]) {
      const text = serializeState(state as GameState);
      const back = deserializeState(text);
      expect(serializeState(back)).toBe(text);
      expect(hashState(back)).toBe(hashState(state as GameState));
    }

    // A restored state is a working state, not just matching bytes.
    const mid = deserializeState(serializeState(states[Math.floor(states.length / 2)] as GameState));
    const legal = legalMoves(mid);
    expect(legal.length).toBeGreaterThan(0);
    expect(() => apply(mid, legal[0] as GameAction)).not.toThrow();
  });

  it('hashes by content, not by key order', () => {
    const { states } = playPure(17);
    const mid = states[Math.floor(states.length / 2)] as GameState;
    const shuffled = cloneState(mid);
    // Rebuild the hex-keyed records back to front: same content, other order.
    shuffled.units = Object.fromEntries(Object.entries(mid.units).reverse());
    shuffled.control = Object.fromEntries(Object.entries(mid.control).reverse());
    expect(Object.keys(shuffled.units)).not.toEqual(Object.keys(mid.units));
    expect(hashState(shuffled)).toBe(hashState(mid));

    // And it does notice a real difference.
    const moved = cloneState(mid);
    moved.round += 1;
    expect(hashState(moved)).not.toBe(hashState(mid));
  });

  it('is reproducible from the seed', () => {
    expect(hashState(playPure(23).state)).toBe(hashState(playPure(23).state));
    expect(hashState(playPure(23).state)).not.toBe(hashState(playPure(24).state));
  });

  it('offers no moves once the game is over', () => {
    const { state } = playPure(29);
    if (isTerminal(state)) {
      expect(legalMoves(state)).toEqual([]);
    } else {
      expect(legalActions(state, actingSeat(state)).length).toBeGreaterThan(0);
    }
  });

  it('validates in apply and trusts in simulate', () => {
    const state = newGame(31);
    const illegal = { type: 'control', coin: 0, at: '5,2' } as GameAction;
    // The server path checks the action against the legal list…
    expect(() => apply(state, illegal, 0)).toThrow(/illegal action/);
    // …the search path does not, because the search generated it itself.
    const legal = legalMoves(state);
    const before = hashState(state);
    const viaApply = apply(state, legal[0] as GameAction);
    const viaSimulate = simulate(state, legal[0] as GameAction);
    expect(hashState(viaSimulate)).toBe(hashState(viaApply));
    expect(hashState(state)).toBe(before);

    // Whoever holds a real game must not be handed the trusting one by default.
    expect(() => applyAction(cloneState(state), 0, illegal)).toThrow(/illegal action/);
  });

  it('keeps the rules package free of wall-clock time and private randomness', () => {
    const dir = new URL('.', import.meta.url);
    const offenders: string[] = [];
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.ts') || file.includes('.test.')) continue;
      const text = readFileSync(new URL(file, dir), 'utf8');
      if (/Math\.random|Date\.now|new Date\(/.test(text)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * The move key is an integer now, and the only thing that makes that safe is
 * that it partitions a legal list exactly as the string it replaced did.
 *
 * A collision would not fail anywhere. It would quietly merge two different
 * moves into one edge of the search tree and average their statistics together
 * — which is the precise bug the key exists to remove, arriving through the
 * door marked "optimisation". So the old implementation lives on here as the
 * reference, and the two are held to the same partition over real positions.
 */
describe('the move key as a number', () => {
  /** What `moveKey` was before it was packed: canonical JSON of the move. */
  function reference(
    action: GameAction,
    hand?: readonly CoinId[],
    pending?: readonly PendingStep[],
  ): string {
    if (action.type === 'skip') {
      const step = pending?.[pending.length - 1];
      return step ? `skip:${step.kind}` : 'skip';
    }
    if (!isCoinAction(action) || !hand) return actionKey(action);
    const coin = hand[action.coin];
    if (coin === undefined) return actionKey(action);
    return actionKey({ ...action, coin } as unknown as GameAction);
  }

  it('splits and merges the same moves the string did, over real games', () => {
    let positions = 0;
    let merged = 0;
    for (let seed = 0; seed < 40; seed++) {
      const state = createGame({
        id: `key-${seed}`,
        size: 2,
        seed,
        sets: ['nobility', 'siege', 'nightfall'],
        draftMode: 'random',
        seats: [
          { userId: 'a', displayName: 'A' },
          { userId: 'b', displayName: 'B' },
        ],
      });
      const rng = createRng(seed + 1);
      for (let ply = 0; ply < 120 && !isTerminal(state); ply++) {
        const seat = actingSeat(state);
        const legal = legalMoves(state);
        if (legal.length === 0) break;
        const hand = state.players[seat]!.hand;

        // Both keys, as a partition: which entries of the list share a name.
        const group = (name: (a: GameAction) => string | number) => {
          const cells = new Map<string | number, number[]>();
          legal.forEach((a, i) => {
            const k = name(a);
            cells.set(k, [...(cells.get(k) ?? []), i]);
          });
          return [...cells.values()].map((v) => v.join(',')).sort().join('|');
        };
        expect(group((a) => moveKey(a, hand, state.pending))).toBe(
          group((a) => reference(a, hand, state.pending)),
        );
        positions++;
        if (new Set(legal.map((a) => moveKey(a, hand, state.pending))).size < legal.length) merged++;

        applyAction(state, seat, legal[nextInt(rng, legal.length)] as GameAction);
      }
    }
    // The check is worthless if nothing ever merged: it would be comparing two
    // ways of saying "every entry is its own move".
    expect(positions).toBeGreaterThan(1000);
    expect(merged / positions).toBeGreaterThan(0.1);
  });

  it('is a safe integer, so no key can lose its top bits', () => {
    const state = createGame({
      id: 'key-range',
      size: 4,
      seed: 2,
      sets: ['nobility', 'siege', 'nightfall'],
      draftMode: 'random',
      seats: [
        { userId: 'a', displayName: 'A' },
        { userId: 'b', displayName: 'B' },
        { userId: 'c', displayName: 'C' },
        { userId: 'd', displayName: 'D' },
      ],
    });
    for (const action of legalMoves(state)) {
      const k = moveKey(action, state.players[0]!.hand, state.pending);
      expect(Number.isSafeInteger(k)).toBe(true);
      expect(k).toBeGreaterThanOrEqual(0);
    }
  });
});
