/** Game creation, the unit draft, and the Draw Coins phase. */

import {
  boardFor,
  FORTIFICATIONS_ON_BOARD,
  FORTIFICATIONS_TOTAL,
  FORTIFICATION_LAYOUTS,
  type BoardSize,
} from './board.js';
import { DECREES_IN_PLAY, DECREE_IDS, SEALS_PER_SIDE } from './decrees.js';
import { createRng, nextInt, type RngState, shuffle } from './rng.js';
import type { BotLevel } from './opponents.js';
import type { DraftMode, GameState, PlayerState, Seat } from './types.js';
import {
  COINS_IN_BAG_PER_UNIT,
  ROYAL_COIN,
  UNITS,
  UNITS_PER_PLAYER,
  unitsForSets,
  type CoinId,
  type UnitId,
  type UnitSet,
} from './units.js';

export const HAND_SIZE = 3;

export interface SeatConfig {
  readonly userId: string;
  readonly displayName: string;
  readonly avatarUrl?: string | null;
  /** Present when this seat is played by the computer. */
  readonly bot?: BotLevel;
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

function teamOf(seat: Seat, size: BoardSize): number {
  // Duel: seat 0 vs seat 1. Four-player: teammates sit opposite each other.
  return size === 2 ? seat : seat % 2;
}

function emptyPlayer(seat: Seat, size: BoardSize, cfg: SeatConfig): PlayerState {
  return {
    seat,
    team: teamOf(seat, size),
    userId: cfg.userId,
    displayName: cfg.displayName,
    avatarUrl: cfg.avatarUrl ?? null,
    ...(cfg.bot ? { bot: cfg.bot } : {}),
    units: [],
    bag: [],
    hand: [],
    discard: [],
    supply: {},
    removed: {},
    seals: 0,
    hasInitiative: false,
  };
}

/** Fills a player's bag and supply once their units are known. */
export function equipPlayer(player: PlayerState, rng: RngState): void {
  const bag: CoinId[] = [ROYAL_COIN];
  for (const unit of player.units) {
    for (let i = 0; i < COINS_IN_BAG_PER_UNIT; i++) bag.push(unit);
    player.supply[unit] = UNITS[unit].coins - COINS_IN_BAG_PER_UNIT;
  }
  player.bag = shuffle(rng, bag);
}

export function createGame(opts: CreateGameOptions): GameState {
  const board = boardFor(opts.size);
  const expectedSeats = opts.size;
  if (opts.seats.length !== expectedSeats) {
    throw new Error(`expected ${expectedSeats} seats, got ${opts.seats.length}`);
  }

  const rng = createRng(opts.seed);
  const players = opts.seats.map((cfg, seat) => emptyPlayer(seat, opts.size, cfg));

  const mode: DraftMode = opts.draftMode ?? 'draft';
  const sets: UnitSet[] = ['base', ...(opts.sets ?? []).filter((s) => s !== 'base')];
  const state: GameState = {
    id: opts.id,
    size: opts.size,
    draftMode: mode,
    sets,
    phase: 'draft',
    round: 0,
    turn: 0,
    players,
    units: {},
    control: {},
    initiative: 0,
    initiativeMovedThisRound: false,
    pending: [],
    decrees: [],
    forts: {},
    fortSupply: 0,
    draftPool: [],
    banned: [],
    log: [],
    winner: null,
    rng,
  };

  // Nobility deals three of the seven Royal Decrees face up, and hands each
  // side its Seals. This happens before the draft, as the expansion instructs.
  if (sets.includes('nobility')) {
    state.decrees = shuffle(rng, [...DECREE_IDS])
      .slice(0, DECREES_IN_PLAY)
      .map((id) => ({ id, seals: [] }));
    for (const p of players) p.seals = SEALS_PER_SIDE;
  }

  // Siege picks one Fortification Map Card at random: four Fortifications go
  // on the board, the remaining three form the supply.
  if (sets.includes('siege')) {
    const layout = FORTIFICATION_LAYOUTS[nextInt(rng, FORTIFICATION_LAYOUTS.length)] ?? [];
    for (const hex of layout) state.forts[hex] = true;
    state.fortSupply = FORTIFICATIONS_TOTAL - FORTIFICATIONS_ON_BOARD;
  }

  // Each side starts controlling its crested locations.
  board.startingLocations.forEach((locations, teamIndex) => {
    for (const loc of locations) state.control[loc] = teamIndex;
  });

  if (opts.fixedUnits) {
    opts.fixedUnits.forEach((units, seat) => {
      const p = players[seat];
      if (p) p.units = [...units];
    });
    beginPlay(state);
    return state;
  }

  const perPlayer = UNITS_PER_PLAYER[opts.size];
  const poolSize = perPlayer * opts.size + (mode === 'ban' ? BANS : 0);
  const pool = shuffle(rng, unitsForSets(sets)).slice(0, poolSize);

  if (mode === 'random') {
    players.forEach((p, i) => {
      p.units = pool.slice(i * perPlayer, (i + 1) * perPlayer);
    });
    beginPlay(state);
    return state;
  }

  state.draftPool = pool;
  state.phase = mode === 'ban' ? 'ban' : 'draft';
  // The rulebook flips the Initiative Marker to pick who bans and drafts first.
  state.turn = 0;
  return state;
}

/**
 * Cards struck out before an elimination draft — one per side, whatever the
 * table size, matching the two extra cards dealt into the pool.
 */
export const BANS = 2;

/** Whose turn it is to strike a card out. */
export function banSeat(state: GameState): Seat {
  return state.banned.length % 2;
}

export function applyBan(state: GameState, seat: Seat, unit: UnitId): void {
  if (state.phase !== 'ban') throw new Error('not banning');
  if (banSeat(state) !== seat) throw new Error('not your ban');
  const idx = state.draftPool.indexOf(unit);
  if (idx === -1) throw new Error('unit not in pool');
  state.draftPool.splice(idx, 1);
  state.banned.push(unit);
  state.log.push({ round: 0, seat, kind: 'ban', params: { unit } });

  if (state.banned.length >= BANS) {
    state.phase = 'draft';
    state.turn = draftSeat(state);
  } else {
    state.turn = banSeat(state);
  }
}

/**
 * Whose turn it is to pick, and how many picks are left in the current burst.
 * Two-player order is 1-2-2-2-1, and the player who picked second starts the game.
 */
export function draftOrder(size: BoardSize): Seat[] {
  if (size === 2) {
    // A B B A A B B A
    return [0, 1, 1, 0, 0, 1, 1, 0];
  }
  // Four players: clockwise to the fourth player, who picks twice, then back.
  return [0, 1, 2, 3, 3, 2, 1, 0, 1, 2, 3, 0];
}

export function draftSeat(state: GameState): Seat {
  const order = draftOrder(state.size);
  const picked = state.players.reduce((n, p) => n + p.units.length, 0);
  return order[picked] ?? 0;
}

export function applyDraftPick(state: GameState, seat: Seat, unit: UnitId): void {
  if (state.phase !== 'draft') throw new Error('not drafting');
  if (draftSeat(state) !== seat) throw new Error('not your pick');
  const idx = state.draftPool.indexOf(unit);
  if (idx === -1) throw new Error('unit not in pool');
  state.draftPool.splice(idx, 1);
  const player = state.players[seat];
  if (!player) throw new Error('no such seat');
  player.units.push(unit);
  state.log.push({ round: 0, seat, kind: 'draft', params: { unit } });

  if (state.draftPool.length === 0) beginPlay(state);
  else state.turn = draftSeat(state);
}

/** Equips every player, hands out initiative and deals the first hands. */
export function beginPlay(state: GameState): void {
  for (const p of state.players) equipPlayer(p, state.rng);

  // After a draft the player who picked second goes first; a random deal has
  // nobody to reward, so it falls to seat 0.
  const first = state.draftMode === 'random' ? 0 : 1;
  state.initiative = first % state.players.length;
  for (const p of state.players) p.hasInitiative = p.seat === state.initiative;

  state.phase = 'playing';
  state.round = 0;
  startRound(state);
}

/** Draws `n` coins, refilling the bag from the discard pile when it runs dry. */
export function drawCoins(state: GameState, player: PlayerState, n: number): CoinId[] {
  const drawn: CoinId[] = [];
  for (let i = 0; i < n; i++) {
    if (player.bag.length === 0) {
      if (player.discard.length === 0) break; // "Not enough coins?" — play short.
      player.bag = shuffle(
        state.rng,
        player.discard.map((d) => d.coin),
      );
      player.discard = [];
    }
    const coin = player.bag.pop();
    if (coin === undefined) break;
    drawn.push(coin);
  }
  player.hand.push(...drawn);
  return drawn;
}

export function startRound(state: GameState): void {
  state.round += 1;
  state.initiativeMovedThisRound = false;
  for (const p of state.players) drawCoins(state, p, HAND_SIZE - p.hand.length);
  state.turn = state.initiative;
  state.log.push({ round: state.round, seat: state.initiative, kind: 'roundStart', params: {} });
}
