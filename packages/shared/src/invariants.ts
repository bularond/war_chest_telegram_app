/**
 * Structural checks a legal position must satisfy, whatever was played to reach
 * it. Written for the fuzzer and the arena: a search treats the engine as its
 * definition of the game, so a rule that leaks coins or markers becomes a
 * strategy rather than a bug report.
 *
 * `checkInvariants` returns a list of violations — empty means the position is
 * sound. It never throws and never touches the state.
 */

import { boardFor, FORTIFICATIONS_TOTAL } from './board.js';
import { SEALS_PER_SIDE } from './decrees.js';
import { markersRemaining } from './engine.js';
import { HAND_SIZE } from './setup.js';
import type { GameState, Seat } from './types.js';
import {
  DECOYS,
  isDecoy,
  maxDeployed,
  ROYAL_COIN,
  UNITS,
  type CoinId,
  type UnitId,
} from './units.js';

/** A Warrior Priest draw sits on top of a full hand until it is spent. */
const MAX_HAND = HAND_SIZE + 1;

export function checkInvariants(state: GameState): string[] {
  const bad: string[] = [];
  const board = boardFor(state.size);
  const hexes = new Set(board.hexes);
  const locations = new Set(board.locations);

  coinsAreConserved(state, bad);
  decoysAreUnique(state, bad);

  // --- the board ---
  const deployed = new Map<string, number>();
  for (const [hex, stack] of Object.entries(state.units)) {
    if (!hexes.has(hex)) bad.push(`stack on ${hex}, which is not on the board`);
    if (stack.coins < 1) bad.push(`stack on ${hex} holds ${stack.coins} coins`);
    const owner = state.players[stack.seat];
    if (!owner) bad.push(`stack on ${hex} belongs to seat ${stack.seat}, which is empty`);
    else {
      if (owner.team !== stack.team) bad.push(`stack on ${hex}: seat ${stack.seat} is not on team ${stack.team}`);
      if (!owner.units.includes(stack.unit)) bad.push(`seat ${stack.seat} fields ${stack.unit}, which it never drafted`);
    }
    const key = `${stack.seat}:${stack.unit}`;
    deployed.set(key, (deployed.get(key) ?? 0) + 1);
  }
  for (const [key, n] of deployed) {
    const unit = key.slice(key.indexOf(':') + 1) as UnitId;
    const max = maxDeployed(unit);
    if (n > max) bad.push(`${key} is deployed ${n} times, limit ${max}`);
  }

  // --- control markers ---
  for (const [hex, team] of Object.entries(state.control)) {
    if (!locations.has(hex)) bad.push(`control marker on ${hex}, which is not a location`);
    if (!state.players.some((p) => p.team === team)) bad.push(`control marker on ${hex} for team ${team}, which nobody plays`);
  }
  for (const team of new Set(state.players.map((p) => p.team))) {
    const left = markersRemaining(state, team);
    if (left < 0) bad.push(`team ${team} placed more markers than it owns`);
    if (left === 0 && state.phase !== 'finished') bad.push(`team ${team} placed its last marker but the game runs on`);
  }

  // --- fortifications ---
  const forts = Object.keys(state.forts);
  for (const hex of forts) {
    if (!locations.has(hex)) bad.push(`fortification on ${hex}, which is not a location`);
  }
  if (state.sets.includes('siege')) {
    if (forts.length + state.fortSupply !== FORTIFICATIONS_TOTAL) {
      bad.push(`${forts.length} fortifications on the board and ${state.fortSupply} beside it, expected ${FORTIFICATIONS_TOTAL} in total`);
    }
  } else if (forts.length > 0 || state.fortSupply !== 0) {
    bad.push('fortifications without the Siege set');
  }

  // --- poison counters: one of each, on one unit ---
  for (const poisoner of ['assassin', 'saboteur'] as const) {
    const n = Object.values(state.units).filter((s) => s.poisonedBy === poisoner).length;
    if (n > 1) bad.push(`${n} units carry the ${poisoner}'s poison counter`);
  }

  // --- hands, seals, initiative ---
  for (const p of state.players) {
    if (p.hand.length > MAX_HAND) bad.push(`seat ${p.seat} holds ${p.hand.length} coins`);
    if (p.seals < 0) bad.push(`seat ${p.seat} has ${p.seals} seals`);
  }
  if (state.sets.includes('nobility')) sealsAreConserved(state, bad);
  else if (state.decrees.length > 0) bad.push('royal decrees without the Nobility set');

  if (state.phase === 'playing' || state.phase === 'finished') {
    const holders = state.players.filter((p) => p.hasInitiative).map((p) => p.seat);
    if (holders.length !== 1) bad.push(`${holders.length} players hold the initiative marker`);
    else if (holders[0] !== state.initiative) bad.push(`initiative marker sits with seat ${holders[0]}, state says ${state.initiative}`);
  }

  if (state.winner !== null && state.phase !== 'finished') bad.push('a winner in an unfinished game');
  if (state.turn < 0 || state.turn >= state.players.length) bad.push(`turn points at seat ${state.turn}`);

  return bad;
}

/**
 * Every coin printed on a player's cards is somewhere: bag, hand, discard, on
 * the board, still in the supply, or out of the game. The Royal Coin is one per
 * player and never reaches the board.
 */
function coinsAreConserved(state: GameState, bad: string[]): void {
  // Bags are filled at the end of the draft: before that a player has cards but
  // no coins, and there is nothing to conserve yet.
  if (state.phase === 'draft' || state.phase === 'ban') return;

  for (const p of state.players) {
    const seen = new Map<CoinId, number>();
    const add = (coin: CoinId, n = 1) => seen.set(coin, (seen.get(coin) ?? 0) + n);

    for (const coin of p.bag) add(coin);
    for (const coin of p.hand) add(coin);
    for (const d of p.discard) add(d.coin);
    for (const stack of Object.values(state.units)) {
      if (stack.seat === p.seat) add(stack.unit, stack.coins);
    }
    for (const [unit, n] of Object.entries(p.supply)) add(unit as CoinId, n ?? 0);
    for (const [unit, n] of Object.entries(p.removed)) add(unit as CoinId, n ?? 0);

    // Redeploy holds a lifted stack on the pending step until it comes back
    // down, so mid-decree those coins are on no pile at all.
    if (p.seat === state.turn) {
      for (const step of state.pending) {
        if (step.kind === 'decreePlace') add(step.unit, step.coins);
      }
    }

    for (const unit of p.units) {
      const have = seen.get(unit) ?? 0;
      const printed = UNITS[unit].coins;
      if (have !== printed) bad.push(`seat ${p.seat}: ${have} ${unit} coins, the card prints ${printed}`);
      seen.delete(unit);
    }

    const royal = seen.get(ROYAL_COIN) ?? 0;
    if (royal !== 1) bad.push(`seat ${p.seat} holds ${royal} royal coins`);
    seen.delete(ROYAL_COIN);

    for (const [coin, n] of seen) {
      if (!isDecoy(coin)) bad.push(`seat ${p.seat} holds ${n} ${coin} coins from a unit it never drafted`);
    }
  }
}

/** One coin per Decoy card, wherever it currently sits. */
function decoysAreUnique(state: GameState, bad: string[]): void {
  for (const decoy of DECOYS) {
    let n = 0;
    for (const p of state.players) {
      n += p.bag.filter((c) => c === decoy).length;
      n += p.hand.filter((c) => c === decoy).length;
      n += p.discard.filter((d) => d.coin === decoy).length;
    }
    if (n > 1) bad.push(`${n} copies of the ${decoy} coin are in play`);
  }
}

/** Seals are placed on decrees or still in front of their owner, never lost. */
function sealsAreConserved(state: GameState, bad: string[]): void {
  const placed = new Map<number, number>();
  for (const decree of state.decrees) {
    const teams = new Set<number>();
    for (const team of decree.seals) {
      if (teams.has(team)) bad.push(`team ${team} has two seals on ${decree.id}`);
      teams.add(team);
      placed.set(team, (placed.get(team) ?? 0) + 1);
    }
  }
  // Three per side, shared by the seats on it — so the tally is summed over the
  // team and compared against three, not against three per seat. This asserted
  // the doubled sum for as long as `setup.ts` handed every player its own
  // three: two wrongs that agreed, which is the only kind an invariant cannot
  // catch by itself.
  const seats = new Map<number, Seat[]>();
  for (const p of state.players) seats.set(p.team, [...(seats.get(p.team) ?? []), p.seat]);
  for (const [team, members] of seats) {
    const inHand = members.reduce((n, seat) => n + (state.players[seat]?.seals ?? 0), 0);
    const total = inHand + (placed.get(team) ?? 0);
    if (total !== SEALS_PER_SIDE) {
      bad.push(`team ${team} accounts for ${total} seals, expected ${SEALS_PER_SIDE}`);
    }
  }
}
