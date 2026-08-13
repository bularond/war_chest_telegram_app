/**
 * State handling for search: cheap copying, a non-mutating `apply`, canonical
 * serialization and a state hash.
 *
 * `engine.ts` mutates the state it is handed — that is what the server wants,
 * one authoritative game advanced in place. A search wants the opposite: it
 * runs millions of trial actions and must never touch the real game. Everything
 * a bot needs to do that lives here, so `engine.ts` stays as it is.
 */

import { actingSeat, applyAction, legalActions } from './engine.js';
import type { DecreeInPlay } from './decrees.js';
import type { HexId } from './hex.js';
import { HEX_INDEX, HEX_SLOTS } from './board.js';
import { DECREE_IDS, type DecreeId } from './decrees.js';
import { isCoinAction, type GameAction, type GameState, type PendingStep, type PlayerState, type Seat, type UnitStack } from './types.js';
import { DECOYS, ROYAL_COIN, UNIT_IDS, type CoinId, type UnitId } from './units.js';

// ---------------------------------------------------------------------------
// Copying
// ---------------------------------------------------------------------------

function clonePlayer(p: PlayerState): PlayerState {
  return {
    seat: p.seat,
    team: p.team,
    userId: p.userId,
    displayName: p.displayName,
    avatarUrl: p.avatarUrl,
    ...(p.bot ? { bot: p.bot } : {}),
    units: p.units.slice(),
    bag: p.bag.slice(),
    hand: p.hand.slice(),
    // Discard entries are readonly, so the array copy is enough.
    discard: p.discard.slice(),
    supply: { ...p.supply },
    removed: { ...p.removed },
    seals: p.seals,
    hasInitiative: p.hasInitiative,
  };
}

function cloneStacks(units: Record<HexId, UnitStack>): Record<HexId, UnitStack> {
  const out: Record<HexId, UnitStack> = {};
  for (const hex in units) {
    const stack = units[hex] as UnitStack;
    out[hex] = stack.poisonedBy
      ? { unit: stack.unit, team: stack.team, seat: stack.seat, coins: stack.coins, poisonedBy: stack.poisonedBy }
      : { unit: stack.unit, team: stack.team, seat: stack.seat, coins: stack.coins };
  }
  return out;
}

function cloneDecrees(decrees: DecreeInPlay[]): DecreeInPlay[] {
  return decrees.map((d) => ({ id: d.id, seals: d.seals.slice() }));
}

/**
 * A copy that shares nothing the engine writes to.
 *
 * Immutable parts are shared on purpose: `sets`, pending steps, discard entries
 * and log entries are all readonly, and copying them per simulation would cost
 * more than they are worth.
 */
export function cloneState(state: GameState): GameState {
  return {
    id: state.id,
    size: state.size,
    phase: state.phase,
    round: state.round,
    turn: state.turn,
    players: state.players.map(clonePlayer),
    units: cloneStacks(state.units),
    control: { ...state.control },
    initiative: state.initiative,
    initiativeMovedThisRound: state.initiativeMovedThisRound,
    pending: state.pending.slice(),
    draftMode: state.draftMode,
    sets: state.sets,
    decrees: cloneDecrees(state.decrees),
    forts: { ...state.forts },
    fortSupply: state.fortSupply,
    draftPool: state.draftPool.slice(),
    banned: state.banned.slice(),
    log: state.log.slice(),
    winner: state.winner,
    rng: { seed: state.rng.seed },
  };
}

// ---------------------------------------------------------------------------
// The search-facing rules API
// ---------------------------------------------------------------------------

/** Legal actions for whoever has to answer right now. */
export function legalMoves(state: GameState): GameAction[] {
  if (isTerminal(state)) return [];
  return legalActions(state, actingSeat(state));
}

/** Applies `action` to a copy and returns it; `state` is left untouched. */
export function apply(state: GameState, action: GameAction, seat: Seat = actingSeat(state)): GameState {
  const next = cloneState(state);
  applyAction(next, seat, action);
  return next;
}

/**
 * `apply` without the legality check, for an action that came out of
 * `legalMoves` a moment ago. Validating it again means generating the whole
 * legal list a second time, which is about half the cost of a simulated ply.
 *
 * Only for search. Anything holding a real game — the server above all — uses
 * `apply`, because there the action came from outside.
 */
export function simulate(state: GameState, action: GameAction, seat: Seat = actingSeat(state)): GameState {
  const next = cloneState(state);
  applyAction(next, seat, action, { validate: false });
  return next;
}

export function isTerminal(state: GameState): boolean {
  return state.phase === 'finished';
}

// ---------------------------------------------------------------------------
// Serialization and hashing
// ---------------------------------------------------------------------------

/**
 * JSON with object keys sorted, so two equal states always give the same text.
 * Plain `JSON.stringify` does not: `state.units` and `state.control` are keyed
 * by hex, and their key order follows the order pieces happened to arrive.
 */
function canonical(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return String(value);
    case 'number':
      // What JSON does with a number that is not finite, since the text has to
      // come back through `JSON.parse`.
      return Number.isFinite(value) ? String(value) : 'null';
    case 'string':
      // The strings here are hex ids, unit ids and action names — no quote, no
      // backslash, nothing outside ASCII. `JSON.stringify` is what handles the
      // rest, and it is several times the cost of a pair of quotes.
      return PLAIN.test(value) ? `"${value}"` : JSON.stringify(value);
    case 'object':
      break;
    default:
      throw new Error(`cannot serialize ${typeof value}`);
  }

  if (Array.isArray(value)) {
    let out = '[';
    for (let i = 0; i < value.length; i++) {
      if (i > 0) out += ',';
      out += canonical(value[i]);
    }
    return `${out}]`;
  }

  // Sorted keys with no intermediate arrays: `actionKey` runs on every legal
  // move of every search iteration, and this used to allocate four arrays and a
  // closure per call.
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  let out = '{';
  let first = true;
  for (const key of keys) {
    const v = record[key];
    if (v === undefined) continue;
    if (!first) out += ',';
    first = false;
    out += `${PLAIN.test(key) ? `"${key}"` : JSON.stringify(key)}:${canonical(v)}`;
  }
  return `${out}}`;
}

/** Strings a JSON writer would pass through untouched between quotes. */
const PLAIN = /^[ -!#-[\]-~]*$/;

/**
 * A stable name for an action, independent of key order. Search uses it to tell
 * one edge of the tree from another; two actions with the same key are the same
 * move, whatever object they arrived in.
 */
export function actionKey(action: GameAction): string {
  return canonical(action);
}

/**
 * A name for the *move*, where `actionKey` names the action — as a number.
 *
 * The two differ in exactly two places, and both cost the search real work.
 *
 * **The coin is a hand slot.** A player holding two Knight coins can pay for one
 * move with either, so the engine offers it twice and `actionKey` gives the two
 * copies different names. In the tree that splits one move's statistics across
 * two edges — worse in the opponent's part of it, where the hand is re-dealt
 * every iteration and the slot a Knight lands in is random, so the same reply
 * gets a fresh name each time. Measured: 2.1 duplicate edges per distinct move,
 * and merging them changes the move chosen in 41% of the root positions where
 * duplicates appear. In a uniform draw it is worse than fragmentation, it is
 * bias: the move payable two ways is drawn twice as often as the one payable
 * one way.
 *
 * **`skip` means two different things.** It is "let the blow land on me" as the
 * defender and "stay where I am" as the attacker, and one name gave them one
 * edge and one pool of statistics. The step being answered tells them apart.
 *
 * **And it is a number rather than a string, which is the whole cost of this
 * function.** Naming an edge by canonical JSON meant enumerating an object's
 * keys, sorting them, testing each string against a regex and concatenating —
 * per legal move, per iteration. A profile of a real search put 14.8% of the
 * time in exactly that, more than the evaluation and the tree put together. The
 * fields are all small enumerations, so they pack into one integer: nine slots,
 * fifty bits, built by multiply-and-add because JS bitwise operators stop at
 * thirty-two.
 *
 * `hand` is the acting player's, and it is optional because a redacted view may
 * not carry it: without it the slot number is the best name available, and it
 * goes in a range of its own so it can never be mistaken for a coin.
 */
export function moveKey(
  action: GameAction,
  hand?: readonly CoinId[],
  pending?: readonly PendingStep[],
): number {
  const a = action as Record<string, unknown>;
  let coin = 0;
  if (isCoinAction(action)) {
    const held = hand?.[action.coin];
    // A named coin, or — failing that — the slot, above every coin name so the
    // two can never collide.
    coin = held === undefined ? COIN_SLOTS + Math.min(action.coin, HAND_SLOTS - 1) : (COIN_INDEX.get(held) ?? 0) + 1;
  }

  let misc = 0;
  if (action.type === 'skip') misc = STEP_INDEX.get(pending?.[pending.length - 1]?.kind ?? '') ?? 0;
  else if (action.type === 'followSpy') misc = Math.min(action.index + 1, MISC_SLOTS - 1);
  else if (action.type === 'followDeceive') misc = action.seat + 1;
  else if (action.type === 'followAbsorb') misc = ABSORB_INDEX[action.source] ?? 0;

  let key = TYPE_INDEX.get(action.type) ?? 0;
  key = key * (COIN_SLOTS + HAND_SLOTS) + coin;
  // `at` and `hex` are the single-hex fields and never share an action with
  // `from`, so they share its slot.
  key = key * HEX_SLOTS + hexSlot((a.from ?? a.at ?? a.hex) as HexId | undefined);
  key = key * HEX_SLOTS + hexSlot(a.to as HexId | undefined);
  key = key * HEX_SLOTS + hexSlot(a.target as HexId | undefined);
  key = key * HEX_SLOTS + hexSlot(a.subject as HexId | undefined);
  key = key * (UNIT_IDS.length + 1) + (typeof a.unit === 'string' ? (UNIT_INDEX.get(a.unit as UnitId) ?? 0) + 1 : 0);
  key = key * (DECREE_IDS.length + 1) + (typeof a.decree === 'string' ? (DECREE_INDEX.get(a.decree as DecreeId) ?? 0) + 1 : 0);
  return key * MISC_SLOTS + misc;
}

function hexSlot(hex: HexId | undefined): number {
  return hex === undefined ? 0 : (HEX_INDEX.get(hex) ?? -1) + 1;
}

/**
 * The alphabets the key is written in. Every one of them is a fixed list the
 * rules define, so the widths are constants and the product is checked once,
 * below, rather than hoped for.
 */
const ACTION_TYPES = [
  'deploy', 'bolster', 'claimInitiative', 'recruit', 'pass', 'unpoison', 'returnDecoy',
  'move', 'control', 'attack', 'proclaim', 'tactic',
  'followMove', 'followAttack', 'followControl', 'followRepeat', 'followRecruit',
  'followLift', 'followPlace', 'followSpy', 'followReinforce', 'followBolster',
  'followShove', 'followProclaim', 'followBuildFort', 'followAbsorb', 'followBurn',
  'followDeceive', 'followTactic', 'skip', 'draft', 'ban',
] as const;

const STEP_KINDS = [
  'optionalMove', 'optionalRepeat', 'mustUseCoin', 'maneuverUnit', 'grantManeuver',
  'decreeAttack', 'decreeMove', 'decreeRecruit', 'decreeLift', 'decreePlace',
  'decreeSpy', 'decreeReinforce', 'heraldBolster', 'shoveEnemy', 'maneuverUnitLimited',
  'freeTactic', 'proclaim', 'burnSupply', 'deceive', 'bolsterSelf', 'buildFort', 'absorbHit',
] as const;

const TYPE_INDEX = new Map<string, number>(ACTION_TYPES.map((t, i) => [t, i]));
const STEP_INDEX = new Map<string, number>(STEP_KINDS.map((k, i) => [k, i + 1]));
const UNIT_INDEX = new Map<UnitId, number>(UNIT_IDS.map((u, i) => [u, i]));
const DECREE_INDEX = new Map<DecreeId, number>(DECREE_IDS.map((d, i) => [d, i]));
const ALL_COINS: readonly CoinId[] = [...UNIT_IDS, ROYAL_COIN, ...DECOYS];
const COIN_INDEX = new Map<CoinId, number>(ALL_COINS.map((c, i) => [c, i]));
/** Room for every coin name plus «none», then a block for bare slot numbers. */
const COIN_SLOTS = ALL_COINS.length + 1;
const HAND_SLOTS = 16;
/** Whichever small number an action type needs: a step kind, a seat, a source. */
const MISC_SLOTS = Math.max(STEP_KINDS.length + 1, 16);
const ABSORB_INDEX: Record<string, number> = { supply: 1, wagon: 2, decoy: 3 };

// Fifty bits, and the assertion is here rather than in a test because a key that
// silently loses its top bits would not fail — it would quietly merge two
// different moves into one edge, which is the exact bug this function exists to
// remove.
{
  const span =
    ACTION_TYPES.length *
    (COIN_SLOTS + HAND_SLOTS) *
    HEX_SLOTS ** 4 *
    (UNIT_IDS.length + 1) *
    (DECREE_IDS.length + 1) *
    MISC_SLOTS;
  if (span > Number.MAX_SAFE_INTEGER) throw new Error(`moveKey needs ${span} values, more than a double holds`);
}

/**
 * The same list with each move named once, keeping the first entry offering it.
 *
 * Whoever draws at random from a legal list wants this and not the list: the
 * list has one entry per hand slot, so a move a player can pay for two ways is
 * in it twice and comes up twice as often. 16.3% of the drawers the heuristic
 * keeps hold at least one such pair, and the legal lists a rollout draws from
 * carry 11% more entries than there are moves.
 */
export function distinctMoves(
  actions: readonly GameAction[],
  hand?: readonly CoinId[],
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

export function serializeState(state: GameState): string {
  return canonical(state);
}

export function deserializeState(text: string): GameState {
  return JSON.parse(text) as GameState;
}

/**
 * FNV-1a over the canonical text, twice with different offsets, giving 64 bits
 * as hex. Identity for tests and transposition keys — not a checksum against a
 * hostile client, which the server answers by never trusting a state it is sent.
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
