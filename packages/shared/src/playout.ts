/**
 * A random-play harness for the fuzzer, the invariant tests and (later) the
 * arena's baseline opponent. This is not a bot and not a difficulty level: it
 * exists to drive the engine through as many different positions as possible.
 */

import type { BoardSize } from './board.js';
import { actingSeat } from './engine.js';
import { nextInt, type RngState } from './rng.js';
import { createGame } from './setup.js';
import { apply, isTerminal, legalMoves } from './state.js';
import type { DraftMode, GameAction, GameState } from './types.js';
import type { UnitSet } from './units.js';

/**
 * Uniformly random play stalls: it buries every coin in bolsters, drains the
 * supply and then shuffles one coin a turn without ever reaching a late game.
 * Taking a location when one is on offer and recruiting when the bag runs dry
 * is the least steering that still gets games finished.
 */
export function randomPolicy(state: GameState, rng: RngState): GameAction {
  const legal = legalMoves(state);
  if (legal.length === 0) throw new Error('no legal actions');

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

/** Uniform choice — noisier, and the yardstick the arena measures against. */
export function uniformPolicy(state: GameState, rng: RngState): GameAction {
  const legal = legalMoves(state);
  if (legal.length === 0) throw new Error('no legal actions');
  return legal[nextInt(rng, legal.length)] as GameAction;
}

export interface PlayoutOptions {
  readonly seed: number;
  readonly size?: BoardSize;
  readonly sets?: readonly UnitSet[];
  readonly draftMode?: DraftMode;
  readonly maxPlies?: number;
  readonly policy?: (state: GameState, rng: RngState) => GameAction;
  /** Runs after every action. Throwing here aborts the game. */
  readonly onStep?: (state: GameState, action: GameAction, ply: number) => void;
}

export interface PlayoutResult {
  readonly state: GameState;
  readonly plies: number;
  /** Every state the game passed through, opening first. */
  readonly history: GameState[];
}

/** Plays one game out with `apply`, so no state handed to a hook is ever changed. */
export function playRandomGame(opts: PlayoutOptions, rng: RngState): PlayoutResult {
  const maxPlies = opts.maxPlies ?? 4000;
  const policy = opts.policy ?? randomPolicy;
  const size = opts.size ?? 2;

  let state = createGame({
    id: `playout-${opts.seed}`,
    size,
    seed: opts.seed,
    sets: opts.sets,
    draftMode: opts.draftMode,
    seats: Array.from({ length: size }, (_, i) => ({
      userId: `p${i}`,
      displayName: `P${i}`,
    })),
  });

  const history: GameState[] = [state];
  let plies = 0;
  while (!isTerminal(state) && plies < maxPlies) {
    const action = policy(state, rng);
    state = apply(state, action);
    plies++;
    history.push(state);
    opts.onStep?.(state, action, plies);
  }
  return { state, plies, history };
}
