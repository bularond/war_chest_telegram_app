/**
 * The rules, as the rest of the TypeScript sees them.
 *
 * There is no rules engine in this package any more. Every function below hands
 * the question to `@wc/core-native`, which is `wc-core` compiled — the one
 * implementation of War Chest there is. What lives here is the shape the server
 * and the tests already expected: a `GameState` that is a plain object,
 * an `applyAction` that advances it in place, and the queries the client uses to
 * explain a highlighted hex.
 *
 * **Why the boundary is JSON.** A state is a few kilobytes and a turn is one
 * action, so a round trip costs tens of microseconds where a turn takes a
 * player seconds. The one caller that would have minded — the search — does not
 * cross this boundary at all: it holds the state on the Rust side for the whole
 * of a move. Paying a little here is what buys the search everything.
 *
 * **This module is Node only.** It is a separate entry point (`@wc/shared/rules`)
 * for exactly that reason: the client imports `@wc/shared`, which is data and
 * types and no native module at all, and a browser bundle can therefore never
 * pull a rules engine in by accident.
 */

import { createRequire } from 'node:module';
import type { BoardSize } from './board.js';
import type { DecoyId, UnitId, UnitSet } from './units.js';
import type { HexId } from './hex.js';
import type { DecreeId } from './decrees.js';
import type { RngState } from './rng.js';
import { nextInt } from './rng.js';
import type {
  DraftMode,
  GameAction,
  GameState,
  PendingStep,
  Seat,
  Team,
} from './types.js';
import type { GameView } from './view.js';
import { HAND_SIZE } from './generated.js';

const require = createRequire(import.meta.url);

interface Core {
  Game: {
    create(options: string): { toJson(): string };
  };
  legalActions(state: string, seat: number): string;
  applyTo(state: string, seat: number, action: string, validate?: boolean): string;
  viewOf(state: string, seat: number): string;
  invariantsOf(state: string): string[];
  actingSeatOf(state: string): number;
  deployTargetsOf(state: string, seat: number, unit: string): string[];
  markersRemainingOf(state: string, team: number): number;
  decoyAvailableIn(state: string, decoy: string): boolean;
  poisonedHexIn(state: string, poisoner: string): string | null;
  canProclaimIn(state: string, seat: number, decree: string): boolean;
  sealsLeftIn(state: string, team: number): number;
  canEnterIn(state: string, team: number, hex: string): boolean;
  hiddenCoinsIn(view: string, seat: number): string;
  determinize(view: string, seed: number): string;
  moveKeyOf(action: string, hand?: string, pending?: string): string;
  botBuild(): string;
}

const core = require('@wc/core-native') as Core;

const out = (v: unknown) => JSON.stringify(v);

// ---------------------------------------------------------------------------
// Setting a game up
// ---------------------------------------------------------------------------

export interface SeatConfig {
  readonly userId: string;
  readonly displayName: string;
  readonly avatarUrl?: string | null;
  /** Present when this seat is played by the computer. */
  readonly bot?: string;
}

export interface CreateGameOptions {
  readonly id: string;
  readonly size: BoardSize;
  readonly seats: readonly SeatConfig[];
  readonly seed: number;
  /**
   * `draft` is the rulebook's advanced setup (deal a pool, pick in turn);
   * `random` deals each player their units face up, as in a first game;
   * `ban` is the tournament kit's elimination draft.
   */
  readonly draftMode?: DraftMode;
  /** Which boxes are on the table. The base game is always included. */
  readonly sets?: readonly UnitSet[];
  /** Force a specific line-up, e.g. the rulebook's recommended first game. */
  readonly fixedUnits?: readonly (readonly UnitId[])[];
}

export function createGame(opts: CreateGameOptions): GameState {
  return JSON.parse(core.Game.create(out(opts)).toJson()) as GameState;
}

export { HAND_SIZE };

// ---------------------------------------------------------------------------
// Playing
// ---------------------------------------------------------------------------

export function legalActions(state: GameState, seat: Seat): GameAction[] {
  return JSON.parse(core.legalActions(out(state), seat)) as GameAction[];
}

export interface ApplyOptions {
  /**
   * Check the action against the legal list first. On by default, and the
   * server must never turn it off: it is what stands between a crafted
   * WebSocket message and the game state.
   */
  readonly validate?: boolean;
}

/**
 * Applies `action` for `seat`, in place.
 *
 * In place because that is what every caller here already does — a room holds
 * one state and advances it — and because keeping the object's identity means a
 * reference held elsewhere does not quietly go stale.
 */
export function applyAction(
  state: GameState,
  seat: Seat,
  action: GameAction,
  opts: ApplyOptions = {},
): void {
  const next = JSON.parse(
    core.applyTo(out(state), seat, out(action), opts.validate !== false),
  ) as GameState;
  replace(state, next);
}

/** Overwrites one state with another, keeping the object. */
function replace(state: GameState, next: GameState): void {
  const held = state as unknown as Record<string, unknown>;
  for (const key of Object.keys(held)) {
    if (!(key in next)) delete held[key];
  }
  Object.assign(state, next);
}

export function actingSeat(state: GameState): Seat {
  return core.actingSeatOf(out(state));
}

export function isTerminal(state: GameState): boolean {
  return state.phase === 'finished';
}

/** Legal actions for whoever has to answer right now. */
export function legalMoves(state: GameState): GameAction[] {
  if (isTerminal(state)) return [];
  return legalActions(state, actingSeat(state));
}

/** A copy that shares nothing. */
export function cloneState(state: GameState): GameState {
  return structuredClone(state);
}

/** Applies `action` to a copy and returns it; `state` is left untouched. */
export function apply(state: GameState, action: GameAction, seat: Seat = actingSeat(state)): GameState {
  const next = cloneState(state);
  applyAction(next, seat, action);
  return next;
}

/**
 * `apply` without the legality check, for an action that came out of
 * `legalMoves` a moment ago. Anything holding a real game — the server above
 * all — uses `apply`, because there the action came from outside.
 */
export function simulate(
  state: GameState,
  action: GameAction,
  seat: Seat = actingSeat(state),
): GameState {
  const next = cloneState(state);
  applyAction(next, seat, action, { validate: false });
  return next;
}

// ---------------------------------------------------------------------------
// Questions about a position
// ---------------------------------------------------------------------------

export function markersRemaining(state: GameState, team: Team): number {
  return core.markersRemainingOf(out(state), team);
}

/** Where a unit of this type could be deployed by this seat right now. */
export function deployTargets(state: GameState, seat: Seat, unit: UnitId): HexId[] {
  return core.deployTargetsOf(out(state), seat, unit);
}

/** Whether a Decoy Coin is still beside its card and ready to be planted. */
export function decoyAvailable(state: GameState, decoy: DecoyId): boolean {
  return core.decoyAvailableIn(out(state), decoy);
}

export function poisonedHex(state: GameState, poisoner: 'assassin' | 'saboteur'): HexId | null {
  return core.poisonedHexIn(out(state), poisoner);
}

/** Whether this seat may still put a Seal on that Decree. */
export function canProclaim(state: GameState, seat: Seat, decree: DecreeId): boolean {
  return core.canProclaimIn(out(state), seat, decree);
}

/** Seals belong to the side, not to the seat. */
export function sealsLeft(state: GameState, team: Team): number {
  return core.sealsLeftIn(out(state), team);
}

/**
 * A Fortification on a location the enemy controls bars the way; a neutral or
 * friendly one may be entered but never moved *through*.
 */
export function canEnter(state: GameState, team: Team, hex: HexId): boolean {
  return core.canEnterIn(out(state), team, hex);
}

/** Structural checks a legal position must satisfy. Empty means sound. */
export function checkInvariants(state: GameState): string[] {
  return core.invariantsOf(out(state));
}

// ---------------------------------------------------------------------------
// What a player is allowed to see
// ---------------------------------------------------------------------------

/**
 * The redacted state as seen from `seat`.
 *
 * `legal` is ignored: the core works the legal list out itself, and passing one
 * in was only ever a way for the server to avoid computing it twice. The
 * parameter stays so every caller keeps compiling.
 */
export function viewFor(state: GameState, seat: Seat, _legal?: readonly GameAction[]): GameView {
  return JSON.parse(core.viewOf(out(state), seat)) as GameView;
}

/** The redacted state as seen from `seat`, legal actions included. */
export function publicStateFor(state: GameState, seat: Seat): GameView {
  return viewFor(state, seat);
}

export interface HiddenCoins {
  readonly seat: Seat;
  /** Coins that must be among this player's hidden piles, worked out exactly. */
  readonly known: string[];
  /** Slots the subtraction cannot fill — only a Decoy Coin can do that. */
  readonly unknown: number;
  readonly bagCount: number;
  readonly handCount: number;
  readonly facedownCount: number;
}

/** The multiset of coins that must be somewhere in `seat`'s hidden piles. */
export function hiddenCoins(view: GameView, seat: Seat): HiddenCoins {
  return JSON.parse(core.hiddenCoinsIn(out(view), seat)) as HiddenCoins;
}

/**
 * Invents one full state consistent with everything `view` shows: the same
 * board, the same counts, the same visible coins, and a random order for what is
 * hidden.
 *
 * The rng is advanced, as every other drawer in this codebase advances it, so a
 * caller drawing twice gets two different guesses.
 */
export function sampleDeterminization(view: GameView, rng: RngState): GameState {
  const answer = JSON.parse(core.determinize(out(view), rng.seed >>> 0)) as {
    state: GameState;
    seed: number;
  };
  rng.seed = answer.seed;
  return answer.state;
}

// ---------------------------------------------------------------------------
// Naming a move
// ---------------------------------------------------------------------------

/**
 * A stable name for an action, independent of key order. Two actions with the
 * same key are the same action, whatever object they arrived in.
 */
export function actionKey(action: GameAction): string {
  return canonical(action);
}

/**
 * A name for the *move*, where `actionKey` names the action.
 *
 * The two differ in two places. A player holding two Knight coins can pay for
 * one move with either, so the engine offers it twice and `actionKey` gives the
 * copies different names. And `skip` means "let the blow land on me" as the
 * defender and "stay where I am" as the attacker; the step being answered tells
 * them apart.
 *
 * Fifty bits, which a double holds exactly — the widths are checked against
 * that in `wc-core`, because a key that silently lost its top bits would not
 * fail, it would merge two different moves into one edge of the tree.
 */
export function moveKey(
  action: GameAction,
  hand?: readonly string[],
  pending?: readonly PendingStep[],
): number {
  return Number(
    core.moveKeyOf(
      out(action),
      hand === undefined ? undefined : out(hand),
      pending === undefined ? undefined : out(pending),
    ),
  );
}

/** The same list with each move named once, keeping the first entry offering it. */
export function distinctMoves(
  actions: readonly GameAction[],
  hand?: readonly string[],
  pending?: readonly PendingStep[],
): GameAction[] {
  const seen = new Set<number>();
  const out: GameAction[] = [];
  for (const action of actions) {
    const key = moveKey(action, hand, pending);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(action);
  }
  return out;
}

/** JSON with object keys sorted, so two equal values always give one text. */
function canonical(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value !== 'object') return JSON.stringify(value);
  const record = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(record).sort()) {
    if (record[key] === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${canonical(record[key])}`);
  }
  return `{${parts.join(',')}}`;
}

export function serializeState(state: GameState): string {
  return canonical(state);
}

export function deserializeState(text: string): GameState {
  return JSON.parse(text) as GameState;
}

/**
 * FNV-1a over the canonical text, twice with different offsets. Identity for
 * tests and transposition keys — not a checksum against a hostile client, which
 * the server answers by never trusting a state it is sent.
 */
export function hashState(state: GameState): string {
  return hashString(serializeState(state));
}

export function hashString(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x85ebca6b);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------------------
// Random play
// ---------------------------------------------------------------------------
//
// A policy is not a rule and not a bot: it exists to drive the engine through as
// many different positions as possible, and it stays here because a test wants
// to watch every ply go by.

/**
 * Uniformly random play stalls: it buries every coin in bolsters, drains the
 * supply and then shuffles one coin a turn without ever reaching a late game.
 * Taking a location when one is on offer and recruiting when the bag runs dry is
 * the least steering that still gets games finished.
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

/** Plays one game out, so no state handed to a hook is ever changed later. */
export function playRandomGame(opts: PlayoutOptions, rng: RngState): PlayoutResult {
  const maxPlies = opts.maxPlies ?? 4000;
  const policy = opts.policy ?? randomPolicy;
  const size = opts.size ?? 2;

  let state = createGame({
    id: `playout-${opts.seed}`,
    size,
    seed: opts.seed,
    ...(opts.sets ? { sets: opts.sets } : {}),
    ...(opts.draftMode ? { draftMode: opts.draftMode } : {}),
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

/** Which build of the bots this is, for the game log. */
export function botBuild(): string {
  return core.botBuild();
}
