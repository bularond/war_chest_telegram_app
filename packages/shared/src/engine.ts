/**
 * The War Chest rules engine: legal action generation and action application.
 *
 * Everything here is a pure-ish function over `GameState` (it mutates the state
 * it is given, so callers clone first if they want history). The server runs it
 * authoritatively; the client runs the same code to highlight legal hexes.
 */

import { boardFor } from './board.js';
import { DECREES, type DecreeId } from './decrees.js';
import {
  DIRECTIONS,
  distance,
  fromId,
  neighbors,
  step,
  straightLineBetween,
  toId,
  type HexId,
} from './hex.js';
import { applyBan, applyDraftPick, banSeat, drawCoins, HAND_SIZE, startRound } from './setup.js';
import type {
  CoinAction,
  FollowUpAction,
  GameAction,
  GameState,
  LogEntry,
  PendingStep,
  PlayerState,
  Seat,
  Team,
  UnitStack,
} from './types.js';
import {
  hasAttribute,
  hasRestriction,
  isUnitId,
  maxDeployed,
  DECOY_OF,
  isDecoy,
  ROYAL_COIN,
  UNITS,
  type CoinId,
  type DecoyId,
  type UnitId,
} from './units.js';

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function player(state: GameState, seat: Seat): PlayerState {
  const p = state.players[seat];
  if (!p) throw new Error(`no seat ${seat}`);
  return p;
}

export function boardHexes(state: GameState): ReadonlySet<HexId> {
  return new Set(boardFor(state.size).hexes);
}

export function isOnBoard(state: GameState, hex: HexId): boolean {
  return boardFor(state.size).hexSet.has(hex);
}

export function isLocation(state: GameState, hex: HexId): boolean {
  return boardFor(state.size).locationSet.has(hex);
}

export function unitAt(state: GameState, hex: HexId): UnitStack | undefined {
  return state.units[hex];
}

/** Control markers the team has not placed yet. */
/**
 * Who has to act right now. Usually the player whose turn it is, but a pending
 * step may name someone else — the defender choosing whether to soak a hit.
 */
export function actingSeat(state: GameState): Seat {
  const step = state.pending[state.pending.length - 1];
  return step && 'seat' in step ? step.seat : state.turn;
}

export function markersRemaining(state: GameState, team: Team): number {
  const placed = Object.values(state.control).filter((t) => t === team).length;
  return boardFor(state.size).controlMarkers - placed;
}

/**
 * A hex's neighbours, read off the board rather than computed.
 *
 * This used to parse the id, allocate six coordinate objects, concatenate six
 * new ids and then scan the board's hex list six times to drop the ones that
 * fell off the edge — 116 ns, against 7 ns for the lookup. The board does not
 * change during a game, so every one of those calls was the same answer worked
 * out again. It is called from twenty-one places in this file, most of them
 * inside the loop that generates legal moves.
 *
 * The array is shared and must not be modified. Every caller filters, iterates
 * or asks `some` of it, and all three make their own copy or none at all.
 */
const NO_NEIGHBOURS: readonly HexId[] = [];

function adjacent(state: GameState, hex: HexId): readonly HexId[] {
  return boardFor(state.size).neighbors.get(hex) ?? NO_NEIGHBOURS;
}

/**
 * A Fortification on a location the enemy controls bars the way; a neutral or
 * friendly one may be entered but never moved *through* by a multi-space move.
 */
export function canEnter(state: GameState, team: Team, hex: HexId): boolean {
  if (!isOnBoard(state, hex) || state.units[hex]) return false;
  if (state.forts[hex] && state.control[hex] !== undefined && state.control[hex] !== team) {
    return false;
  }
  return true;
}

function canPassThrough(state: GameState, team: Team, hex: HexId): boolean {
  return canEnter(state, team, hex) && !state.forts[hex];
}

function emptyNeighbors(state: GameState, hex: HexId): readonly HexId[] {
  const team = state.units[hex]?.team;
  return adjacent(state, hex).filter((h) =>
    team === undefined ? !state.units[h] : canEnter(state, team, h),
  );
}

/** Where a poisoner's counter currently sits, if it is on the board at all. */
export function poisonedHex(state: GameState, poisoner: 'assassin' | 'saboteur'): HexId | null {
  for (const [hex, stack] of Object.entries(state.units)) {
    if (stack.poisonedBy === poisoner) return hex;
  }
  return null;
}

/**
 * A poisoned unit may not be moved, bolstered or activated with its *own*
 * coins. Anything granted by another unit or a decree still works.
 */
function isPoisoned(state: GameState, hex: HexId): boolean {
  return state.units[hex]?.poisonedBy !== undefined;
}

/** Whether a Decoy Coin is still beside its card and ready to be planted. */
export function decoyAvailable(state: GameState, decoy: DecoyId): boolean {
  for (const p of state.players) {
    if (p.hand.includes(decoy) || p.bag.includes(decoy)) return false;
    if (p.discard.some((d) => d.coin === decoy)) return false;
  }
  return true;
}

/** A Fortification is attackable while it is neutral or the enemy's. */
export function canAttackFort(state: GameState, team: Team, hex: HexId): boolean {
  if (!state.forts[hex]) return false;
  return state.control[hex] !== team;
}

/**
 * `for … in` rather than `Object.entries().filter().map()`, here and in the two
 * below: these run several times per legal move and the entries array was three
 * allocations a call for a dozen units. Hex ids are not array indices, so the
 * order is insertion order either way — which matters, because one caller reads
 * the result backwards.
 */
function deployedUnits(state: GameState, seat: Seat, unit: UnitId): HexId[] {
  const out: HexId[] = [];
  for (const hex in state.units) {
    const s = state.units[hex as HexId];
    if (s && s.seat === seat && s.unit === unit) out.push(hex as HexId);
  }
  return out;
}

/** Hexes holding a unit this seat owns (not a teammate's). */
function ownUnits(state: GameState, seat: Seat): HexId[] {
  const out: HexId[] = [];
  for (const hex in state.units) {
    if (state.units[hex as HexId]?.seat === seat) out.push(hex as HexId);
  }
  return out;
}

function friendlyUnits(state: GameState, team: Team): HexId[] {
  return Object.entries(state.units)
    .filter(([, s]) => s.team === team)
    .map(([h]) => h);
}

/**
 * Whether `attacker` may make an attack against `target` at all.
 * Range and line of sight are checked by the caller; this covers the Knight.
 */
export function canAttackTarget(state: GameState, attackerHex: HexId, targetHex: HexId): boolean {
  const attacker = state.units[attackerHex];
  if (!attacker) return false;
  // A Fortification takes the blow first, whoever is standing behind it.
  if (state.forts[targetHex]) return canAttackFort(state, attacker.team, targetHex);
  const target = state.units[targetHex];
  if (!target) return false;
  if (target.team === attacker.team) return false;
  if (hasAttribute(target.unit, 'onlyAttackedByBolstered') && attacker.coins < 2) return false;
  // The Bishop is the Knight inverted: heavy stacks cannot touch it.
  if (hasRestriction(target.unit, 'onlyAttackedByUnbolstered') && attacker.coins >= 2) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Royal Decrees (Nobility)
// ---------------------------------------------------------------------------

/** Units of this team that could attack something right now. */
function attackersFor(state: GameState, team: Team, onOwnLocation: boolean): HexId[] {
  return friendlyUnits(state, team).filter((hex) => {
    if (onOwnLocation && state.control[hex] !== team) return false;
    if (hasRestriction(state.units[hex]!.unit, 'noNormalAttack')) return false;
    return adjacent(state, hex).some((t) => canAttackTarget(state, hex, t));
  });
}

function supplyTotal(p: PlayerState): number {
  return Object.values(p.supply).reduce((a, b) => a + (b ?? 0), 0);
}

function removedTotal(p: PlayerState): number {
  return Object.values(p.removed).reduce((a, b) => a + (b ?? 0), 0);
}

/** Empty locations a team controls, optionally ignoring one hex being vacated. */
function openControlledLocations(state: GameState, team: Team, vacating?: HexId): HexId[] {
  return boardFor(state.size).locations.filter(
    (loc) => state.control[loc] === team && (!state.units[loc] || loc === vacating),
  );
}

/**
 * A Decree may only be chosen if its ability can be carried out in full, so
 * every one of them gets a feasibility check before it is offered.
 */
export function canExecuteDecree(state: GameState, seat: Seat, decree: DecreeId): boolean {
  const me = player(state, seat);
  switch (decree) {
    case 'sacrifice':
      return attackersFor(state, me.team, false).length > 0;
    case 'guard':
      return attackersFor(state, me.team, true).length > 0;
    case 'march':
      return friendlyUnits(state, me.team).some(
        (hex) => state.units[hex]!.coins >= 2 && emptyNeighbors(state, hex).length > 0,
      );
    case 'enlist':
      return supplyTotal(me) >= 2;
    case 'redeploy':
      return ownUnits(state, seat).some(
        (hex) => openControlledLocations(state, me.team, hex).length > 0,
      );
    case 'spy':
      return state.players.some((p) => p.team !== me.team && p.hand.length > 0);
    case 'reinforce':
      return removedTotal(me) > 0;
  }
}

/**
 * Seals belong to the side, not to the seat.
 *
 * «Give each side the 3 Proclamation Seals that match their faction… In the
 * four-player game, each team shares the three Seals they are given» — Nobility
 * rulebook, set-up and Proclaim. In a duel a side is one player and the
 * distinction never shows; with four at the table it is the difference between
 * three Seals and six. `PlayerState.seals` stays the storage — a team's pool is
 * the sum over its seats, and setup hands the three to one of them.
 */
export function sealsLeft(state: GameState, team: Team): number {
  let n = 0;
  for (const p of state.players) if (p.team === team) n += p.seals;
  return n;
}

/** Takes one Seal out of the side's shared pool. */
function spendSeal(state: GameState, team: Team): void {
  const holder = state.players.find((p) => p.team === team && p.seals > 0);
  if (!holder) throw new Error('no seals left');
  holder.seals -= 1;
}

/** Whether this seat may still put a Seal on that Decree. */
export function canProclaim(state: GameState, seat: Seat, decree: DecreeId): boolean {
  const me = player(state, seat);
  const card = state.decrees.find((d) => d.id === decree);
  if (!card) return false;
  if (sealsLeft(state, me.team) <= 0) return false;
  if (card.seals.includes(me.team)) return false;
  return canExecuteDecree(state, seat, decree);
}

/** Queues the steps a Decree needs the player to resolve. */
function startDecree(state: GameState, seat: Seat, decree: DecreeId): void {
  const me = player(state, seat);
  log(state, seat, 'proclaim', { decree });
  switch (decree) {
    case 'sacrifice':
      state.pending.push({ kind: 'decreeAttack', costsCoin: true, fromOwnLocation: false });
      break;
    case 'guard':
      state.pending.push({ kind: 'decreeAttack', costsCoin: false, fromOwnLocation: true });
      break;
    case 'march':
      state.pending.push({ kind: 'decreeMove', requireBolstered: true });
      break;
    case 'enlist':
      state.pending.push({ kind: 'decreeRecruit', source: 'enlist' });
      state.pending.push({ kind: 'decreeRecruit', source: 'enlist' });
      break;
    case 'redeploy':
      state.pending.push({ kind: 'decreeLift' });
      break;
    case 'spy': {
      const target = state.players.find((p) => p.team !== me.team && p.hand.length > 0);
      if (target) state.pending.push({ kind: 'decreeSpy', target: target.seat });
      break;
    }
    case 'reinforce':
      state.pending.push({ kind: 'decreeReinforce' });
      break;
  }
  // The Herald follows a proclamation with a maneuver of its own.
  for (const hex of deployedUnits(state, seat, 'herald')) {
    if (maneuverFollowUps(state, hex).length > 0) {
      state.pending.push({ kind: 'maneuverUnit', hex, source: 'herald', optional: true });
    }
  }
}

/** Where a unit of this type could be deployed by this seat right now. */
export function deployTargets(state: GameState, seat: Seat, unit: UnitId): HexId[] {
  const me = player(state, seat);
  if (deployedUnits(state, seat, unit).length >= maxDeployed(unit)) return [];

  const board = boardFor(state.size);
  const controlled = board.locations.filter(
    (loc) => state.control[loc] === me.team && !state.units[loc],
  );

  if (!hasAttribute(unit, 'deployNextToFriendly')) return controlled;

  const nextToFriendly = new Set<HexId>();
  for (const hex of friendlyUnits(state, me.team)) {
    for (const n of emptyNeighbors(state, hex)) nextToFriendly.add(n);
  }
  return [...new Set([...controlled, ...nextToFriendly])];
}

// ---------------------------------------------------------------------------
// Legal actions
// ---------------------------------------------------------------------------

/** Free maneuvers a unit can make: move, attack or control. Never a tactic. */
function maneuverFollowUps(state: GameState, hex: HexId): FollowUpAction[] {
  const stack = state.units[hex];
  if (!stack) return [];
  const out: FollowUpAction[] = [];
  for (const to of emptyNeighbors(state, hex)) out.push({ type: 'followMove', from: hex, to });
  if (!hasRestriction(stack.unit, 'noNormalAttack')) {
    for (const to of adjacent(state, hex)) {
      if (canAttackTarget(state, hex, to)) out.push({ type: 'followAttack', from: hex, to });
    }
  }
  if (canControlHere(state, hex)) out.push({ type: 'followControl', at: hex });
  return out;
}

function canControlHere(state: GameState, hex: HexId): boolean {
  const stack = state.units[hex];
  if (!stack) return false;
  if (!isLocation(state, hex)) return false;
  if (state.control[hex] === stack.team) return false;
  return markersRemaining(state, stack.team) > 0;
}

function tacticActions(
  state: GameState,
  seat: Seat,
  coinIndex: number,
  unit: UnitId,
  /** Where that unit stands, when the caller has already worked it out. */
  deployed?: readonly HexId[],
): CoinAction[] {
  const spec = UNITS[unit].tactic;
  if (!spec) return [];
  const out: CoinAction[] = [];
  const sources = deployed ?? deployedUnits(state, seat, unit);

  for (const from of sources) {
    if (isPoisoned(state, from)) continue;
    // A Siege Tactic may only be started while the unit is bolstered.
    if (UNITS[unit].siegeTactic && (state.units[from]?.coins ?? 0) < 2) continue;
    switch (spec.kind) {
      case 'rangedAttack': {
        for (const [target, stack] of Object.entries(state.units)) {
          if (stack.team === state.units[from]!.team) continue;
          const d = distance(fromId(from), fromId(target));
          if (d < spec.min || d > spec.max) continue;
          if (spec.straightLine) {
            const between = straightLineBetween(fromId(from), fromId(target), d);
            if (!between) continue;
            // A Trebuchet lobs over anything; a Crossbowman needs a clear lane.
            if (spec.blocked && between.some((h) => state.units[toId(h)])) continue;
          }
          if (!canAttackTarget(state, from, target)) continue;
          out.push({ type: 'tactic', coin: coinIndex, from, target });
        }
        break;
      }
      case 'chargeAttack': {
        for (const { to, target } of chargeOptions(state, from, spec)) {
          out.push({ type: 'tactic', coin: coinIndex, from, to, target });
        }
        break;
      }
      case 'multiMove': {
        for (const to of reachable(state, from, spec.distance)) {
          out.push({ type: 'tactic', coin: coinIndex, from, to });
        }
        break;
      }
      case 'royalRedeploy': {
        // Played with the Royal Coin only; handled in the Royal Coin branch.
        break;
      }
      case 'bolsterAllyFromSupply': {
        const team = state.units[from]!.team;
        const canHelp = adjacent(state, from).some((hex) => {
          const ally = state.units[hex];
          if (!ally || ally.team !== team || ally.coins !== 1) return false;
          return (state.players[ally.seat]?.supply[ally.unit] ?? 0) > 0;
        });
        if (canHelp) out.push({ type: 'tactic', coin: coinIndex, from });
        break;
      }
      case 'controlThenProclaim': {
        if (canControlHere(state, from)) out.push({ type: 'tactic', coin: coinIndex, from });
        break;
      }
      case 'recruitThenManeuver': {
        const me = player(state, seat);
        if (me.units.some((u) => (me.supply[u] ?? 0) > 0)) {
          out.push({ type: 'tactic', coin: coinIndex, from });
        }
        break;
      }
      case 'attackTwice': {
        for (const target of adjacent(state, from)) {
          if (canAttackTarget(state, from, target)) {
            out.push({ type: 'tactic', coin: coinIndex, from, target });
          }
        }
        break;
      }
      case 'pushAlly': {
        const team = state.units[from]!.team;
        for (const subject of adjacent(state, from)) {
          const ally = state.units[subject];
          if (!ally || ally.team !== team) continue;
          for (const to of emptyNeighbors(state, subject)) {
            if (to === from) continue; // the wagon is about to move into `subject`
            out.push({ type: 'tactic', coin: coinIndex, from, subject, to });
          }
        }
        break;
      }
      case 'moveThenPoison': {
        const team = state.units[from]!.team;
        for (const to of emptyNeighbors(state, from)) {
          for (const target of adjacent(state, to)) {
            const foe = state.units[target];
            if (foe && foe.team !== team) out.push({ type: 'tactic', coin: coinIndex, from, to, target });
          }
        }
        break;
      }
      case 'poisonAtRange': {
        const team = state.units[from]!.team;
        for (const [target, foe] of Object.entries(state.units)) {
          if (foe.team === team) continue;
          const d = distance(fromId(from), fromId(target));
          // "one or two spaces away" — the space between may be occupied.
          if (d < spec.min || d > spec.max) continue;
          out.push({ type: 'tactic', coin: coinIndex, from, target });
        }
        break;
      }
      case 'infiltrate': {
        const team = state.units[from]!.team;
        for (const to of reachable(state, from, spec.distance)) {
          const held = state.control[to];
          if (held === undefined || held === team) continue;
          if (markersRemaining(state, team) <= 0) continue;
          out.push({ type: 'tactic', coin: coinIndex, from, to });
        }
        break;
      }
      case 'skirmish': {
        const team = state.units[from]!.team;
        for (const to of reachable(state, from, spec.distance)) {
          const nextToFoe = adjacent(state, to).some((h) => {
            const foe = state.units[h];
            return foe !== undefined && foe.team !== team;
          });
          if (nextToFoe) out.push({ type: 'tactic', coin: coinIndex, from, to });
        }
        break;
      }
    case 'moveThenAttackFort': {
        const team = state.units[from]!.team;
        for (const to of emptyNeighbors(state, from)) {
          for (const target of adjacent(state, to)) {
            if (canAttackFort(state, team, target)) {
              out.push({ type: 'tactic', coin: coinIndex, from, to, target });
            }
          }
        }
        break;
      }
      case 'grantManeuver': {
        const team = state.units[from]!.team;
        for (const subject of friendlyUnits(state, team)) {
          if (subject === from) continue;
          if (distance(fromId(from), fromId(subject)) > spec.range) continue;
          if (spec.maneuver === 'attack') {
            if (hasRestriction(state.units[subject]!.unit, 'noNormalAttack')) continue;
            if (!adjacent(state, subject).some((t) => canAttackTarget(state, subject, t))) continue;
          } else {
            const moves = emptyNeighbors(state, subject).filter(
              (to) => distance(fromId(from), fromId(to)) <= spec.range,
            );
            if (moves.length === 0) continue;
          }
          out.push({ type: 'tactic', coin: coinIndex, from, subject });
        }
        break;
      }
      case 'maneuverEachUnit': {
        if (maneuverFollowUps(state, from).length > 0) {
          out.push({ type: 'tactic', coin: coinIndex, from });
        }
        break;
      }
    }
  }

  // `maneuverEachUnit` acts with every unit at once, so one action is enough.
  if (spec.kind === 'maneuverEachUnit') return out.slice(0, 1);
  return out;
}

/** Hexes a unit can end on after moving `n` steps through empty hexes. */
function reachable(state: GameState, from: HexId, steps: number): HexId[] {
  const team = state.units[from]?.team ?? 0;
  let frontier: HexId[] = [from];
  const seen = new Set<HexId>([from]);
  for (let i = 0; i < steps; i++) {
    const last = i === steps - 1;
    const next: HexId[] = [];
    for (const hex of frontier) {
      for (const n of adjacent(state, hex)) {
        if (seen.has(n)) continue;
        // Only the final step may land on a Fortification.
        if (!(last ? canEnter(state, team, n) : canPassThrough(state, team, n))) continue;
        seen.add(n);
        next.push(n);
      }
    }
    frontier = next;
  }
  return frontier; // exactly `steps` away
}

/**
 * Destination/target pairs for a charge.
 *
 * The Cavalry moves one space and may then hit anything adjacent. The Lancer's
 * card says "move one or two spaces and then attack, all in a straight line",
 * so its target is the next hex along the very direction it charged down.
 */
function chargeOptions(
  state: GameState,
  from: HexId,
  spec: { min: number; max: number; straightLine: boolean },
): { to: HexId; target: HexId }[] {
  const out: { to: HexId; target: HexId }[] = [];
  const mover = state.units[from];
  if (!mover) return out;

  if (spec.straightLine) {
    for (const dir of DIRECTIONS) {
      for (let d = spec.min; d <= spec.max; d++) {
        let blocked = false;
        for (let i = 1; i <= d; i++) {
          const hex = toId(step(fromId(from), dir, i));
          if (!isOnBoard(state, hex) || state.units[hex]) blocked = true;
        }
        if (blocked) continue;
        const to = toId(step(fromId(from), dir, d));
        const target = toId(step(fromId(from), dir, d + 1));
        if (!isOnBoard(state, target)) continue;
        if (!canCharge(state, from, target)) continue;
        out.push({ to, target });
      }
    }
    return out;
  }

  for (let d = spec.min; d <= spec.max; d++) {
    for (const to of reachable(state, from, d)) {
      for (const target of adjacent(state, to)) {
        if (canCharge(state, from, target)) out.push({ to, target });
      }
    }
  }
  return out;
}

/** Empty locations this seat controls, within `distance` steps through empty hexes. */
function royalRedeployTargets(
  state: GameState,
  seat: Seat,
  from: HexId,
  distance: number,
): HexId[] {
  const team = player(state, seat).team;
  const out = new Set<HexId>();
  for (let d = 1; d <= distance; d++) {
    for (const hex of reachable(state, from, d)) {
      if (isLocation(state, hex) && state.control[hex] === team) out.add(hex);
    }
  }
  return [...out];
}

/** The charging stack is the attacker, so the Knight check uses its own size. */
function canCharge(state: GameState, from: HexId, target: HexId): boolean {
  const mover = state.units[from];
  const victim = state.units[target];
  if (!mover || !victim || victim.team === mover.team) return false;
  return !(hasAttribute(victim.unit, 'onlyAttackedByBolstered') && mover.coins < 2);
}

export function legalActions(state: GameState, seat: Seat): GameAction[] {
  if (state.phase === 'ban') {
    if (seat !== banSeat(state)) return [];
    return state.draftPool.map((unit) => ({ type: 'ban', unit }) as GameAction);
  }
  if (state.phase === 'draft') {
    if (seat !== state.turn) return [];
    return state.draftPool.map((unit) => ({ type: 'draft', unit }) as GameAction);
  }
  if (state.phase !== 'playing') return [];

  // Most steps belong to the player whose turn it is, but a defender's choice
  // (soaking a hit) is answered by the defender, mid-attack.
  const step = state.pending[state.pending.length - 1];
  if (step) {
    const owner = 'seat' in step ? step.seat : state.turn;
    return seat === owner ? pendingActions(state, seat, step) : [];
  }
  if (seat !== state.turn) return [];

  const me = player(state, seat);
  const out: GameAction[] = [];

  // The work is done once per *distinct* coin; the list still has an entry per
  // slot.
  //
  // Two coins of one unit differ only in a number, so the second slot was
  // scanning the board, walking the neighbours and testing every deploy target
  // all over again to produce a set of actions identical to the first. Measured
  // over 4230 decisions, 11.2% of the generation was that duplicate.
  //
  // The list itself keeps every slot, and that is not a compromise — it is the
  // interface. The client marks a coin in your hand playable when some legal
  // action names *its* index, so dropping the duplicate entries greys out the
  // second Knight you are holding. Copying the answer across is cheap: a shallow
  // object per action, against a board scan per coin.
  const done = new Map<CoinId, readonly GameAction[]>();
  me.hand.forEach((coin, coinIndex) => {
    const already = done.get(coin);
    if (already) {
      for (const action of already) out.push({ ...action, coin: coinIndex } as GameAction);
      return;
    }
    const fresh = coinActions(state, seat, coinIndex, coin);
    done.set(coin, fresh);
    out.push(...fresh);
  });
  return out;
}

function coinActions(
  state: GameState,
  seat: Seat,
  coinIndex: number,
  coin: CoinId,
): GameAction[] {
  const me = player(state, seat);
  const out: GameAction[] = [];

  // Facedown actions are available with any coin, including the Royal Coin.
  out.push({ type: 'pass', coin: coinIndex });
  if (!me.hasInitiative && !state.initiativeMovedThisRound) {
    out.push({ type: 'claimInitiative', coin: coinIndex });
  }
  for (const unit of me.units) {
    if ((me.supply[unit] ?? 0) > 0) out.push({ type: 'recruit', coin: coinIndex, unit });
  }

  if (isDecoy(coin)) {
    // A Decoy is good for the facedown actions and for being handed back —
    // never for placement, a maneuver, unpoisoning or a proclamation.
    out.push({ type: 'returnDecoy', coin: coinIndex });
    return out;
  }

  if (!isUnitId(coin)) {
    for (const card of state.decrees) {
      if (canProclaim(state, seat, card.id)) {
        out.push({ type: 'proclaim', coin: coinIndex, decree: card.id });
      }
    }
    // The Royal Guard's tactic is the one board action the Royal Coin can buy.
    const spec = UNITS.royalGuard.tactic;
    if (spec?.kind === 'royalRedeploy') {
      for (const from of deployedUnits(state, seat, 'royalGuard')) {
        for (const to of royalRedeployTargets(state, seat, from, spec.distance)) {
          out.push({ type: 'tactic', coin: coinIndex, from, to });
        }
      }
    }
    return out;
  }

  if (!me.units.includes(coin)) return out; // shouldn't happen, but stay safe

  // Where this unit already stands, worked out once. It was asked for four
  // times over — twice here, once below and once inside `tacticActions` — and
  // each answer is a walk over every stack on the board.
  const mine = deployedUnits(state, seat, coin);

  // Placement actions.
  for (const to of deployTargets(state, seat, coin)) {
    out.push({ type: 'deploy', coin: coinIndex, to });
  }
  for (const at of mine) {
    if (isPoisoned(state, at)) continue;
    out.push({ type: 'bolster', coin: coinIndex, at });
  }

  // Poison stops a unit being driven by its own coins — but not by a Marshall,
  // an Ensign or a decree. Spending a matching coin lifts every counter off
  // your units of that type, and that is not a maneuver.
  const poisonedOwn = mine.filter((hex) => isPoisoned(state, hex));
  if (poisonedOwn.length > 0) out.push({ type: 'unpoison', coin: coinIndex });

  // Maneuvers.
  for (const from of mine) {
    if (isPoisoned(state, from)) continue;
    for (const to of emptyNeighbors(state, from)) {
      out.push({ type: 'move', coin: coinIndex, from, to });
    }
    if (!hasRestriction(coin, 'noNormalAttack')) {
      for (const to of adjacent(state, from)) {
        if (canAttackTarget(state, from, to)) out.push({ type: 'attack', coin: coinIndex, from, to });
      }
    }
    if (canControlHere(state, from)) out.push({ type: 'control', coin: coinIndex, at: from });
  }
  out.push(...tacticActions(state, seat, coinIndex, coin, mine));

  return out;
}

function pendingActions(state: GameState, seat: Seat, step: PendingStep): GameAction[] {
  const out: GameAction[] = [];
  switch (step.kind) {
    case 'optionalMove': {
      // The unit may be gone by now — a Sacrifice takes the attacker's last
      // coin right after the attack, and the Swordsman's free move is offered
      // from the hex it used to stand on.
      if (state.units[step.hex]) {
        for (const to of emptyNeighbors(state, step.hex)) {
          out.push({ type: 'followMove', from: step.hex, to });
        }
      }
      out.push({ type: 'skip' });
      break;
    }
    case 'optionalRepeat': {
      const stack = state.units[step.hex];
      if (stack && stack.coins >= 2 && maneuverFollowUps(state, step.hex).length > 0) {
        out.push({ type: 'followRepeat', hex: step.hex });
      }
      out.push({ type: 'skip' });
      break;
    }
    case 'maneuverUnit': {
      out.push(...maneuverFollowUps(state, step.hex));
      if (step.optional || out.length === 0) out.push({ type: 'skip' });
      break;
    }
    case 'grantManeuver': {
      const origin = state.units[step.origin];
      if (origin) {
        for (const subject of friendlyUnits(state, origin.team)) {
          if (subject === step.origin) continue;
          if (distance(fromId(step.origin), fromId(subject)) > step.range) continue;
          if (step.maneuver === 'move') {
            for (const to of emptyNeighbors(state, subject)) {
              if (distance(fromId(step.origin), fromId(to)) > step.range) continue;
              out.push({ type: 'followMove', from: subject, to });
            }
          } else {
            if (hasRestriction(state.units[subject]!.unit, 'noNormalAttack')) continue;
            for (const to of adjacent(state, subject)) {
              if (canAttackTarget(state, subject, to)) {
                out.push({ type: 'followAttack', from: subject, to });
              }
            }
          }
        }
      }
      out.push({ type: 'skip' });
      break;
    }
    case 'decreeAttack': {
      const me = player(state, seat);
      for (const from of attackersFor(state, me.team, step.fromOwnLocation)) {
        for (const to of adjacent(state, from)) {
          if (canAttackTarget(state, from, to)) out.push({ type: 'followAttack', from, to });
        }
      }
      break;
    }
    case 'decreeMove': {
      const me = player(state, seat);
      for (const from of friendlyUnits(state, me.team)) {
        if (step.requireBolstered && state.units[from]!.coins < 2) continue;
        for (const to of emptyNeighbors(state, from)) out.push({ type: 'followMove', from, to });
      }
      break;
    }
    case 'decreeRecruit': {
      const me = player(state, seat);
      for (const unit of me.units) {
        if ((me.supply[unit] ?? 0) > 0) out.push({ type: 'followRecruit', unit });
      }
      if (out.length === 0) out.push({ type: 'skip' });
      break;
    }
    case 'freeTactic': {
      // The same generator a paid tactic uses, with the coin taken back out:
      // whatever the card can do costs nothing here, and nothing else changes.
      for (const action of tacticActions(state, seat, -1, step.unit)) {
        if (action.type !== 'tactic') continue;
        out.push({
          type: 'followTactic',
          from: action.from,
          ...(action.to === undefined ? {} : { to: action.to }),
          ...(action.target === undefined ? {} : { target: action.target }),
          ...(action.subject === undefined ? {} : { subject: action.subject }),
        });
      }
      // "You may" — and the card is silent about the case where the unit is
      // nowhere on the board, which is the usual one right after recruiting it.
      out.push({ type: 'skip' });
      break;
    }
    case 'decreeLift': {
      const me = player(state, seat);
      for (const hex of ownUnits(state, seat)) {
        if (openControlledLocations(state, me.team, hex).length > 0) {
          out.push({ type: 'followLift', hex });
        }
      }
      break;
    }
    case 'decreePlace': {
      const me = player(state, seat);
      for (const to of openControlledLocations(state, me.team)) {
        out.push({ type: 'followPlace', to });
      }
      break;
    }
    case 'decreeSpy': {
      const target = state.players[step.target];
      target?.hand.forEach((_, index) => out.push({ type: 'followSpy', index }));
      out.push({ type: 'skip' });
      break;
    }
    case 'decreeReinforce': {
      const me = player(state, seat);
      for (const [unit, n] of Object.entries(me.removed)) {
        if ((n ?? 0) > 0) out.push({ type: 'followReinforce', unit: unit as UnitId });
      }
      break;
    }
    case 'heraldBolster': {
      for (const hex of adjacent(state, step.origin)) {
        const stack = state.units[hex];
        if (!stack || stack.team !== state.units[step.origin]?.team) continue;
        if (stack.coins !== 1) continue; // "one adjacent unbolstered friendly unit"
        if ((state.players[stack.seat]?.supply[stack.unit] ?? 0) <= 0) continue;
        out.push({ type: 'followBolster', hex });
      }
      out.push({ type: 'skip' });
      break;
    }
    case 'shoveEnemy': {
      const mine = state.units[step.origin];
      for (const from of adjacent(state, step.origin)) {
        const foe = state.units[from];
        if (!foe || !mine || foe.team === mine.team) continue;
        for (const to of emptyNeighbors(state, from)) out.push({ type: 'followShove', from, to });
      }
      out.push({ type: 'skip' });
      break;
    }
    case 'maneuverUnitLimited': {
      const hex = step.hex;
      if (state.units[hex]) {
        if (step.allow.includes('move')) {
          for (const to of emptyNeighbors(state, hex)) out.push({ type: 'followMove', from: hex, to });
        }
        if (step.allow.includes('attack') && !hasRestriction(state.units[hex]!.unit, 'noNormalAttack')) {
          for (const to of adjacent(state, hex)) {
            if (canAttackTarget(state, hex, to)) out.push({ type: 'followAttack', from: hex, to });
          }
        }
      }
      if (out.length === 0) out.push({ type: 'skip' });
      break;
    }
    case 'proclaim': {
      for (const card of state.decrees) {
        const usable = step.free
          ? canExecuteDecree(state, seat, card.id)
          : canProclaim(state, seat, card.id);
        if (usable) out.push({ type: 'followProclaim', decree: card.id });
      }
      out.push({ type: 'skip' });
      break;
    }
    case 'buildFort': {
      out.push({ type: 'followBuildFort', hex: step.hex });
      out.push({ type: 'skip' });
      break;
    }
    case 'burnSupply': {
      out.push({ type: 'followBurn', unit: step.unit });
      out.push({ type: 'skip' });
      break;
    }
    case 'deceive': {
      for (const p of state.players) {
        if (p.team !== player(state, seat).team) out.push({ type: 'followDeceive', seat: p.seat });
      }
      out.push({ type: 'skip' });
      break;
    }
    case 'bolsterSelf': {
      if (state.units[step.hex]) out.push({ type: 'followBolster', hex: step.hex });
      out.push({ type: 'skip' });
      break;
    }
    case 'absorbHit': {
      for (const option of step.options) {
        if (option.from === 'wagon') out.push({ type: 'followAbsorb', source: 'wagon', hex: option.hex });
        else out.push({ type: 'followAbsorb', source: option.from });
      }
      out.push({ type: 'skip' });
      break;
    }
    case 'mustUseCoin': {
      // Never null on a real state: only `viewFor` blanks it, and only for a
      // seat that is not the one being asked to spend it.
      if (step.coin === null) throw new Error('mustUseCoin reached the engine redacted');
      const me = player(state, seat);
      const idx = me.hand.lastIndexOf(step.coin);
      if (idx >= 0) out.push(...coinActions(state, seat, idx, step.coin));
      else out.push({ type: 'skip' });
      break;
    }
  }

  // A step that owes an effect nobody can carry out is dropped, not enforced.
  // Sacrifice is the case that showed up: it is proclaimed while an attack is
  // available, a Herald maneuver underneath it moves the only attacker out of
  // range, and by the time the decree resolves there is nothing to hit. Without
  // this the position has no legal action at all and the game locks.
  if (out.length === 0) out.push({ type: 'skip' });
  return out;
}

// ---------------------------------------------------------------------------
// Applying actions
// ---------------------------------------------------------------------------

function log(state: GameState, seat: Seat, kind: string, params: LogEntry['params'] = {}): void {
  state.log.push({ round: state.round, seat, kind, params });
}

function discardCoin(state: GameState, seat: Seat, coinIndex: number, faceUp: boolean): CoinId {
  const me = player(state, seat);
  const coin = me.hand[coinIndex];
  if (coin === undefined) throw new Error('no such coin in hand');
  me.hand.splice(coinIndex, 1);
  me.discard.push({ coin, faceUp });
  return coin;
}

/**
 * Applies one hit. The Royal Guard can soak it out of its supply and a War
 * Wagon can take it for an adjacent friend — both are the defender's choice, so
 * the hit waits on a step that the defender, not the attacker, answers.
 */
function takeHit(state: GameState, hex: HexId, by: { hex: HexId; unit: UnitId; seat: Seat }): void {
  const stack = state.units[hex];
  if (!stack) return;

  const options: ({ from: 'supply' } | { from: 'wagon'; hex: HexId } | { from: 'decoy' })[] = [];
  if (
    hasAttribute(stack.unit, 'absorbHitFromSupply') &&
    (state.players[stack.seat]?.supply[stack.unit] ?? 0) > 0
  ) {
    options.push({ from: 'supply' });
  }
  for (const near of adjacent(state, hex)) {
    const ally = state.units[near];
    if (ally && ally.team === stack.team && hasAttribute(ally.unit, 'absorbHitForAlly')) {
      options.push({ from: 'wagon', hex: near });
    }
  }
  if (hasAttribute(stack.unit, 'deceiveWhenAttacked')) {
    const decoy = DECOY_OF[stack.unit];
    if (decoy && decoyAvailable(state, decoy)) options.push({ from: 'decoy' });
  }

  if (options.length > 0) {
    state.pending.push({ kind: 'absorbHit', seat: stack.seat, target: hex, by, options });
    return;
  }
  removeCoins(state, hex, 1);
}

/**
 * Takes coins off a stack and out of the game — the rulebook puts them "back in
 * the box", not the discard pile. They are tallied per player so the Nobility
 * Reinforce decree can call one back.
 */
function removeCoins(state: GameState, hex: HexId, n: number): void {
  const stack = state.units[hex];
  if (!stack) return;
  const gone = Math.min(n, stack.coins);
  stack.coins -= n;
  const owner = state.players[stack.seat];
  if (owner) owner.removed[stack.unit] = (owner.removed[stack.unit] ?? 0) + gone;
  if (stack.coins <= 0) delete state.units[hex]; // the Poison Counter goes home with it
}

/**
 * The Berserker pays for its extra maneuver by *discarding* a bolstered coin,
 * so that one goes to the discard pile and will come back round in the bag.
 */
function discardFromStack(state: GameState, hex: HexId): void {
  const stack = state.units[hex];
  if (!stack || stack.coins < 2) throw new Error('nothing bolstered to discard');
  stack.coins -= 1;
  state.players[stack.seat]?.discard.push({ coin: stack.unit, faceUp: true });
}

function moveStack(state: GameState, from: HexId, to: HexId): void {
  const stack = state.units[from];
  if (!stack) throw new Error('nothing to move');
  if (state.units[to]) throw new Error('destination occupied');
  delete state.units[from];
  state.units[to] = stack;
}

function placeControl(state: GameState, hex: HexId, team: Team, seat: Seat): void {
  state.control[hex] = team;
  // `unit` as well as `hex`: control is one of the three maneuvers, and a rule
  // like the chart's "the unit that was most recently maneuvered" has to be able
  // to tell which unit did it. A `move` entry carries it for the same reason.
  const actor = state.units[hex]?.unit;
  log(state, seat, 'control', actor ? { hex, unit: actor } : { hex });
  if (markersRemaining(state, team) === 0) {
    state.phase = 'finished';
    state.winner = team;
    log(state, seat, 'victory', { team });
  }
}

/** Resolves one attack, including retaliation and post-attack attributes. */
function resolveAttack(state: GameState, attackerHex: HexId, targetHex: HexId, seat: Seat): void {
  const attacker = state.units[attackerHex];
  if (!attacker) throw new Error('illegal attack');

  // A Fortification soaks the whole attack and goes back to the supply.
  if (state.forts[targetHex]) {
    delete state.forts[targetHex];
    state.fortSupply += 1;
    log(state, seat, 'razeFort', { hex: targetHex });
    afterManeuver(state, attackerHex, seat, 'attack');
    return;
  }

  const target = state.units[targetHex];
  if (!target) throw new Error('illegal attack');

  // `from` as well as `hex`: a screen showing the last move has to be able to
  // say who swung, and a ranged tactic's attacker is nowhere near its victim.
  log(state, seat, 'attack', {
    unit: attacker.unit,
    target: target.unit,
    from: attackerHex,
    hex: targetHex,
  });
  const wasAdjacent = distance(fromId(attackerHex), fromId(targetHex)) === 1;
  // The Pikeman's card says "attacked by an adjacent unit", so ranged tactics
  // like the Archer's and the Crossbowman's do not set it off.
  if (wasAdjacent && hasAttribute(target.unit, 'retaliate')) removeCoins(state, attackerHex, 1);

  // Steps resolve newest first, so queue the attacker's follow-ups before the
  // hit: the defender's choice to soak it belongs to this attack, and has to be
  // answered before the attacker carries on.
  afterManeuver(state, attackerHex, seat, 'attack');
  if (
    target.poisonedBy !== undefined &&
    hasAttribute(attacker.unit, 'burnSupplyAfterKillingPoisoned') &&
    (state.players[target.seat]?.supply[target.unit] ?? 0) > 0
  ) {
    state.pending.push({ kind: 'burnSupply', unit: target.unit, owner: target.seat });
  }
  takeHit(state, targetHex, { hex: attackerHex, unit: attacker.unit, seat: attacker.seat });
}

/**
 * Moves a poisoner's counter onto a new victim. Each poisoner owns one counter,
 * so poisoning again lifts it off whoever had it before.
 */
function applyPoison(
  state: GameState,
  seat: Seat,
  poisoner: UnitId,
  targetHex: HexId,
): void {
  if (poisoner !== 'assassin' && poisoner !== 'saboteur') return;
  const previous = poisonedHex(state, poisoner);
  if (previous) delete state.units[previous]?.poisonedBy;
  const target = state.units[targetHex];
  if (!target) return;
  target.poisonedBy = poisoner;
  log(state, seat, 'poison', { unit: target.unit });
}

/**
 * Pushes the steps a unit's attributes create the moment a coin of it is
 * recruited. Only the Saboteur has one: "After you recruit a Saboteur, you may
 * use the Saboteur's tactic."
 *
 * The step is pushed whether or not a Saboteur is standing anywhere, and
 * `pendingActions` answers with a bare skip when none is — the same shape every
 * other optional step has, and one place fewer for the two halves to disagree.
 */
function afterRecruit(state: GameState, seat: Seat, unit: UnitId): void {
  if (!hasAttribute(unit, 'tacticOnRecruit')) return;
  state.pending.push({ kind: 'freeTactic', unit, source: 'saboteur' });
}

/** Pushes the pending steps a unit's attributes create after it acts. */
function afterManeuver(
  state: GameState,
  hex: HexId,
  seat: Seat,
  maneuver: 'move' | 'attack' | 'control',
): void {
  const stack = state.units[hex];
  if (!stack || stack.seat !== seat) return;

  if (hasAttribute(stack.unit, 'maneuverAgainForCoin') && stack.coins >= 2) {
    state.pending.push({ kind: 'optionalRepeat', hex, source: 'berserker' });
  }
  if (maneuver === 'attack' && hasAttribute(stack.unit, 'moveAfterAttack')) {
    state.pending.push({ kind: 'optionalMove', hex, source: 'swordsman' });
  }
  if (
    maneuver === 'move' &&
    hasAttribute(stack.unit, 'buildFortOnMove') &&
    isLocation(state, hex) &&
    !state.forts[hex] &&
    state.fortSupply > 0
  ) {
    state.pending.push({ kind: 'buildFort', hex, seat });
  }
  if (maneuver === 'control' && hasAttribute(stack.unit, 'deceiveAfterControl')) {
    const decoy = DECOY_OF[stack.unit];
    if (decoy && decoyAvailable(state, decoy)) state.pending.push({ kind: 'deceive', decoy });
  }
  if (hasAttribute(stack.unit, 'shoveEnemyAfterManeuver')) {
    const foes = adjacent(state, hex).filter((h) => {
      const foe = state.units[h];
      return foe && foe.team !== stack.team && emptyNeighbors(state, h).length > 0;
    });
    if (foes.length > 0) state.pending.push({ kind: 'shoveEnemy', origin: hex });
  }
  if (
    (maneuver === 'attack' || maneuver === 'control') &&
    hasAttribute(stack.unit, 'drawAndUseAfterControlOrAttack')
  ) {
    const drawn = drawCoins(state, player(state, seat), 1);
    const coin = drawn[0];
    if (coin !== undefined) {
      state.pending.push({ kind: 'mustUseCoin', coin, source: 'warriorPriest' });
    }
  }
}

function applyTactic(state: GameState, seat: Seat, action: Extract<CoinAction, { type: 'tactic' }>) {
  const stack = state.units[action.from];
  if (!stack) throw new Error('unit not deployed');
  const spec = UNITS[stack.unit].tactic;
  if (!spec) throw new Error('unit has no tactic');
  log(state, seat, 'tactic', { unit: stack.unit });

  switch (spec.kind) {
    case 'rangedAttack': {
      if (!action.target) throw new Error('tactic needs a target');
      resolveAttack(state, action.from, action.target, seat);
      break;
    }
    case 'chargeAttack': {
      if (!action.to || !action.target) throw new Error('tactic needs a destination and a target');
      moveStack(state, action.from, action.to);
      resolveAttack(state, action.to, action.target, seat);
      break;
    }
    case 'multiMove': {
      if (!action.to) throw new Error('tactic needs a destination');
      moveStack(state, action.from, action.to);
      afterManeuver(state, action.to, seat, 'move');
      break;
    }
    case 'grantManeuver': {
      state.pending.push({
        kind: 'grantManeuver',
        maneuver: spec.maneuver,
        origin: action.from,
        range: spec.range,
        source: stack.unit === 'marshal' ? 'marshal' : 'ensign',
      });
      break;
    }
    case 'maneuverEachUnit': {
      // Push in reverse so the first unit resolves first (steps pop from the end).
      const hexes = deployedUnits(state, seat, stack.unit).reverse();
      for (const hex of hexes) {
        state.pending.push({ kind: 'maneuverUnit', hex, source: 'footman', optional: true });
      }
      break;
    }
    case 'bolsterAllyFromSupply': {
      state.pending.push({ kind: 'heraldBolster', origin: action.from });
      break;
    }
    case 'controlThenProclaim': {
      placeControl(state, action.from, stack.team, seat);
      if (state.phase === 'finished') return;
      afterManeuver(state, action.from, seat, 'control');
      // The Earl's proclamation costs neither a Seal nor the once-per-game limit.
      state.pending.push({ kind: 'proclaim', free: true });
      break;
    }
    case 'recruitThenManeuver': {
      state.pending.push({ kind: 'decreeRecruit', source: 'bishop' });
      break;
    }
    case 'attackTwice': {
      if (!action.target) throw new Error('tactic needs a target');
      // The bolstered condition is checked when the tactic starts, not again
      // halfway through, so the second blow lands even if the tower shrank.
      state.pending.push({ kind: 'maneuverUnitLimited', hex: action.from, allow: ['attack'] });
      resolveAttack(state, action.from, action.target, seat);
      break;
    }
    case 'pushAlly': {
      if (!action.subject || !action.to) throw new Error('tactic needs an ally and a space');
      moveStack(state, action.subject, action.to);
      log(state, seat, 'push', { from: action.subject, to: action.to });
      moveStack(state, action.from, action.subject);
      afterManeuver(state, action.subject, seat, 'move');
      break;
    }
    case 'moveThenPoison': {
      if (!action.to || !action.target) throw new Error('tactic needs a space and a target');
      moveStack(state, action.from, action.to);
      applyPoison(state, seat, stack.unit, action.target);
      afterManeuver(state, action.to, seat, 'move');
      break;
    }
    case 'poisonAtRange': {
      if (!action.target) throw new Error('tactic needs a target');
      applyPoison(state, seat, stack.unit, action.target);
      break;
    }
    case 'infiltrate': {
      if (!action.to) throw new Error('tactic needs a destination');
      moveStack(state, action.from, action.to);
      placeControl(state, action.to, stack.team, seat);
      if (state.phase === 'finished') return;
      afterManeuver(state, action.to, seat, 'control');
      break;
    }
    case 'skirmish': {
      if (!action.to) throw new Error('tactic needs a destination');
      moveStack(state, action.from, action.to);
      afterManeuver(state, action.to, seat, 'move');
      break;
    }
    case 'moveThenAttackFort': {
      if (!action.to || !action.target) throw new Error('tactic needs a space and a fort');
      moveStack(state, action.from, action.to);
      resolveAttack(state, action.to, action.target, seat);
      break;
    }
    case 'royalRedeploy': {
      if (!action.to) throw new Error('tactic needs a destination');
      moveStack(state, action.from, action.to);
      afterManeuver(state, action.to, seat, 'move');
      break;
    }
  }
}

function applyCoinAction(state: GameState, seat: Seat, action: CoinAction): void {
  const me = player(state, seat);

  switch (action.type) {
    case 'pass': {
      discardCoin(state, seat, action.coin, false);
      log(state, seat, 'pass');
      break;
    }
    case 'unpoison': {
      const coin = discardCoin(state, seat, action.coin, true);
      if (!isUnitId(coin)) throw new Error('that coin cures nothing');
      for (const hex of deployedUnits(state, seat, coin)) delete state.units[hex]?.poisonedBy;
      log(state, seat, 'unpoison', { unit: coin });
      break;
    }
    case 'returnDecoy': {
      const coin = me.hand[action.coin];
      if (coin === undefined || !isDecoy(coin)) throw new Error('not a decoy');
      me.hand.splice(action.coin, 1); // straight back to its card, not the discard
      log(state, seat, 'returnDecoy', {});
      break;
    }
    case 'claimInitiative': {
      discardCoin(state, seat, action.coin, false);
      for (const p of state.players) p.hasInitiative = p.seat === seat;
      state.initiative = seat;
      state.initiativeMovedThisRound = true;
      log(state, seat, 'claimInitiative');
      break;
    }
    case 'recruit': {
      discardCoin(state, seat, action.coin, false);
      const left = me.supply[action.unit] ?? 0;
      if (left <= 0) throw new Error('nothing left in supply');
      me.supply[action.unit] = left - 1;
      me.discard.push({ coin: action.unit, faceUp: true });
      log(state, seat, 'recruit', { unit: action.unit });
      // The Mercenary's coin gives the deployed Mercenary a free maneuver.
      if (hasAttribute(action.unit, 'freeManeuverOnRecruit')) {
        const hex = deployedUnits(state, seat, action.unit)[0];
        if (hex) {
          state.pending.push({ kind: 'maneuverUnit', hex, source: 'mercenary', optional: true });
        }
      }
      afterRecruit(state, seat, action.unit);
      break;
    }
    case 'deploy': {
      const coin = me.hand[action.coin];
      if (coin === undefined || !isUnitId(coin)) throw new Error('cannot deploy this coin');
      if (!deployTargets(state, seat, coin).includes(action.to)) throw new Error('illegal deploy');
      me.hand.splice(action.coin, 1);
      state.units[action.to] = { unit: coin, team: me.team, seat, coins: 1 };
      log(state, seat, 'deploy', { unit: coin, hex: action.to });
      if (hasAttribute(coin, 'moveAfterDeploy')) {
        state.pending.push({ kind: 'optionalMove', hex: action.to, source: 'earl' });
      }
      if (hasAttribute(coin, 'bolsterOnDeploy') && (me.supply[coin] ?? 0) > 0) {
        state.pending.push({ kind: 'bolsterSelf', hex: action.to });
      }
      break;
    }
    case 'bolster': {
      const coin = me.hand[action.coin];
      const stack = state.units[action.at];
      if (coin === undefined || !isUnitId(coin)) throw new Error('cannot bolster with this coin');
      if (!stack || stack.unit !== coin || stack.seat !== seat) throw new Error('illegal bolster');
      me.hand.splice(action.coin, 1);
      stack.coins += 1;
      log(state, seat, 'bolster', { unit: coin, hex: action.at });
      break;
    }
    case 'move': {
      discardCoin(state, seat, action.coin, true);
      moveStack(state, action.from, action.to);
      log(state, seat, 'move', { from: action.from, to: action.to, unit: state.units[action.to]!.unit });
      afterManeuver(state, action.to, seat, 'move');
      break;
    }
    case 'attack': {
      discardCoin(state, seat, action.coin, true);
      resolveAttack(state, action.from, action.to, seat);
      break;
    }
    case 'control': {
      discardCoin(state, seat, action.coin, true);
      const stack = state.units[action.at];
      if (!stack || stack.seat !== seat) throw new Error('no unit of yours there');
      placeControl(state, action.at, stack.team, seat);
      if (state.phase === 'finished') return;
      afterManeuver(state, action.at, seat, 'control');
      break;
    }
    case 'proclaim': {
      discardCoin(state, seat, action.coin, true);
      const card = state.decrees.find((d) => d.id === action.decree);
      if (!card) throw new Error('no such decree');
      spendSeal(state, me.team);
      card.seals.push(me.team);
      startDecree(state, seat, action.decree);
      break;
    }
    case 'tactic': {
      discardCoin(state, seat, action.coin, true);
      applyTactic(state, seat, action);
      break;
    }
  }
}

function applyFollowUp(state: GameState, seat: Seat, action: FollowUpAction): void {
  const step = state.pending.pop();
  if (!step) throw new Error('nothing pending');

  if (action.type === 'skip') {
    if (step.kind === 'absorbHit') {
      removeCoins(state, step.target, 1);
      return;
    }
    if (step.kind === 'maneuverUnit' && !step.optional) {
      // A mandatory maneuver may still be skipped if nothing is legal.
      if (maneuverFollowUps(state, step.hex).length > 0) throw new Error('maneuver is mandatory');
    }
    if (step.kind === 'decreePlace') {
      // Redeploy with nowhere to land: the stack goes back where it was lifted
      // from, rather than off the table.
      if (!state.units[step.from]) {
        state.units[step.from] = {
          unit: step.unit,
          team: player(state, seat).team,
          seat,
          coins: step.coins,
        };
      }
      return;
    }
    if (step.kind === 'mustUseCoin') {
      // Only reachable if the coin vanished; treat as passing it.
      if (step.coin === null) throw new Error('mustUseCoin reached the engine redacted');
      const me = player(state, seat);
      const idx = me.hand.lastIndexOf(step.coin);
      if (idx >= 0) {
        me.hand.splice(idx, 1);
        me.discard.push({ coin: step.coin, faceUp: false });
      }
    }
    return;
  }

  switch (action.type) {
    case 'followMove': {
      moveStack(state, action.from, action.to);
      log(state, seat, 'move', { from: action.from, to: action.to, unit: state.units[action.to]!.unit });
      afterManeuver(state, action.to, seat, 'move');
      break;
    }
    case 'followAttack': {
      resolveAttack(state, action.from, action.to, seat);
      if (step.kind === 'decreeAttack' && step.costsCoin) {
        log(state, seat, 'sacrifice', {});
        removeCoins(state, action.from, 1);
      }
      break;
    }
    case 'followControl': {
      const stack = state.units[action.at];
      if (!stack) throw new Error('no unit there');
      placeControl(state, action.at, stack.team, seat);
      if (state.phase === 'finished') return;
      afterManeuver(state, action.at, seat, 'control');
      break;
    }
    case 'followRecruit': {
      const me = player(state, seat);
      const left = me.supply[action.unit] ?? 0;
      if (left <= 0) throw new Error('nothing left in supply');
      me.supply[action.unit] = left - 1;
      me.discard.push({ coin: action.unit, faceUp: true });
      log(state, seat, 'recruit', { unit: action.unit });
      if (step.kind === 'decreeRecruit' && step.source === 'bishop') {
        const hex = deployedUnits(state, seat, 'bishop')[0];
        if (hex) {
          state.pending.push({ kind: 'maneuverUnitLimited', hex, allow: ['move', 'attack'] });
        }
      }
      afterRecruit(state, seat, action.unit);
      break;
    }
    case 'followLift': {
      const stack = state.units[action.hex];
      if (!stack) throw new Error('nothing to lift');
      delete state.units[action.hex];
      log(state, seat, 'lift', { unit: stack.unit });
      state.pending.push({
        kind: 'decreePlace',
        unit: stack.unit,
        coins: stack.coins,
        from: action.hex,
      });
      break;
    }
    case 'followPlace': {
      if (step.kind !== 'decreePlace') throw new Error('nothing to place');
      const me = player(state, seat);
      // The stack goes back down as it was: Redeploy moves the unit, not a coin.
      state.units[action.to] = { unit: step.unit, team: me.team, seat, coins: step.coins };
      log(state, seat, 'deploy', { unit: step.unit, hex: action.to });
      break;
    }
    case 'followSpy': {
      if (step.kind !== 'decreeSpy') throw new Error('nobody to spy on');
      const target = player(state, step.target);
      const coin = target.hand[action.index];
      if (coin === undefined) throw new Error('no such coin');
      target.hand.splice(action.index, 1);
      target.discard.push({ coin, faceUp: true });
      drawCoins(state, target, 1);
      log(state, seat, 'spy', { coin });
      break;
    }
    case 'followReinforce': {
      const me = player(state, seat);
      const left = me.removed[action.unit] ?? 0;
      if (left <= 0) throw new Error('nothing removed from play');
      me.removed[action.unit] = left - 1;
      me.supply[action.unit] = (me.supply[action.unit] ?? 0) + 1;
      log(state, seat, 'reinforce', { unit: action.unit });
      break;
    }
    case 'followBolster': {
      const stack = state.units[action.hex];
      if (!stack) throw new Error('nothing to bolster');
      const owner = player(state, stack.seat);
      const left = owner.supply[stack.unit] ?? 0;
      if (left <= 0) throw new Error('nothing left in supply');
      owner.supply[stack.unit] = left - 1;
      stack.coins += 1;
      log(state, seat, 'bolster', { unit: stack.unit, hex: action.hex });
      break;
    }
    case 'followShove': {
      moveStack(state, action.from, action.to);
      log(state, seat, 'shove', { from: action.from, to: action.to });
      break;
    }
    case 'followProclaim': {
      const card = state.decrees.find((d) => d.id === action.decree);
      if (!card) throw new Error('no such decree');
      const me = player(state, seat);
      // The Earl proclaims for free: no Seal, and a used Decree still works.
      if (step.kind === 'proclaim' && !step.free) {
        spendSeal(state, me.team);
        card.seals.push(me.team);
      }
      startDecree(state, seat, action.decree);
      break;
    }
    case 'followBurn': {
      if (step.kind !== 'burnSupply') throw new Error('nothing to burn');
      const owner = player(state, step.owner);
      const left = owner.supply[action.unit] ?? 0;
      if (left <= 0) break;
      owner.supply[action.unit] = left - 1;
      owner.removed[action.unit] = (owner.removed[action.unit] ?? 0) + 1;
      log(state, seat, 'burn', { unit: action.unit });
      break;
    }
    case 'followTactic': {
      if (step.kind !== 'freeTactic') throw new Error('no tactic is on offer');
      // The coin index is the one thing this action does not carry, and
      // `applyTactic` never reads it — paying is the caller's business, and here
      // there is nothing to pay.
      const { type: _free, ...fields } = action;
      applyTactic(state, seat, { type: 'tactic', coin: -1, ...fields });
      break;
    }
    case 'followDeceive': {
      if (step.kind !== 'deceive') throw new Error('nothing to plant');
      player(state, action.seat).discard.push({ coin: step.decoy, faceUp: true });
      log(state, seat, 'deceive', {});
      break;
    }
    case 'followBuildFort': {
      if (state.fortSupply <= 0) throw new Error('no fortifications left');
      state.fortSupply -= 1;
      state.forts[action.hex] = true;
      log(state, seat, 'buildFort', { hex: action.hex });
      break;
    }
    case 'followAbsorb': {
      if (step.kind !== 'absorbHit') throw new Error('nothing to absorb');
      const stack = state.units[step.target];
      if (!stack) break;
      if (action.source === 'supply') {
        const owner = player(state, stack.seat);
        const left = owner.supply[stack.unit] ?? 0;
        if (left <= 0) throw new Error('nothing left in supply');
        owner.supply[stack.unit] = left - 1;
        owner.removed[stack.unit] = (owner.removed[stack.unit] ?? 0) + 1;
        log(state, stack.seat, 'absorb', { unit: stack.unit });
      } else if (action.source === 'wagon') {
        if (!action.hex) throw new Error('which wagon?');
        removeCoins(state, action.hex, 1);
        log(state, stack.seat, 'absorbWagon', {});
      } else {
        // The Skirmisher slips a Decoy Coin into an opponent's discards, and
        // the blow lands on that instead of the unit.
        const decoy = DECOY_OF[stack.unit];
        const foe = state.players.find((p) => p.team !== stack.team);
        if (decoy && foe) foe.discard.push({ coin: decoy, faceUp: true });
        log(state, stack.seat, 'deceive', {});
      }
      break;
    }
    case 'followRepeat': {
      discardFromStack(state, action.hex);
      log(state, seat, 'berserkerRepeat', { hex: action.hex });
      if (state.units[action.hex]) {
        state.pending.push({
          kind: 'maneuverUnit',
          hex: action.hex,
          source: 'berserker',
          optional: false,
        });
      }
      break;
    }
  }
}

/** Key-order-independent equality, so clients can rebuild actions freely. */
function sameAction(a: GameAction, b: GameAction): boolean {
  const stable = (v: GameAction) =>
    JSON.stringify(
      Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .filter(([, val]) => val !== undefined)
          .sort(([x], [y]) => (x < y ? -1 : 1)),
      ),
    );
  return stable(a) === stable(b);
}

export interface ApplyOptions {
  /**
   * Check the action against the legal list first. On by default, and the
   * server must never turn it off: it is what stands between a crafted
   * WebSocket message and the game state.
   *
   * A search turns it off, because it just generated the action from
   * `legalActions` itself and re-deriving that list doubles the cost of a ply.
   */
  readonly validate?: boolean;
}

/** Applies `action` for `seat`, validating it against the legal action list. */
export function applyAction(
  state: GameState,
  seat: Seat,
  action: GameAction,
  opts: ApplyOptions = {},
): void {
  if (state.phase === 'finished') throw new Error('game is over');
  const top = state.pending[state.pending.length - 1];
  const owner = top && 'seat' in top ? top.seat : state.turn;
  if (owner !== seat) throw new Error('not your turn');

  if (opts.validate !== false) {
    const legal = legalActions(state, seat);
    if (!legal.some((a) => sameAction(a, action))) throw new Error('illegal action');
  }

  if (action.type === 'ban') {
    applyBan(state, seat, action.unit);
    return;
  }
  if (action.type === 'draft') {
    applyDraftPick(state, seat, action.unit);
    return;
  }

  if ('coin' in action) {
    // A coin played to satisfy `mustUseCoin` clears that step first, so any new
    // steps the action creates land on top of the stack in the right order.
    if (top?.kind === 'mustUseCoin') state.pending.pop();
    applyCoinAction(state, seat, action);
  } else {
    applyFollowUp(state, seat, action);
  }

  endTurnIfDone(state);
}

function endTurnIfDone(state: GameState): void {
  if (state.phase !== 'playing') return;
  if (state.pending.length > 0) return;

  const n = state.players.length;
  if (state.players.every((p) => p.hand.length === 0)) {
    startRound(state);
    // If nobody could draw anything, no one can ever act again — call it a draw.
    if (state.players.every((p) => p.hand.length === 0)) {
      state.phase = 'finished';
      state.winner = null;
      log(state, state.turn, 'stalemate');
    }
    return;
  }
  for (let i = 1; i <= n; i++) {
    const cand = (state.turn + i) % n;
    if ((state.players[cand]?.hand.length ?? 0) > 0) {
      state.turn = cand;
      return;
    }
  }
}

export { HAND_SIZE };
