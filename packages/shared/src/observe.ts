/**
 * What a player can work out about the hidden coins, and how to turn that into
 * a concrete state a search can play on.
 *
 * War Chest hides very little. Recruits are taken from an open supply, coins
 * destroyed on the board are counted, and face-up discards are there for all to
 * see — so the *contents* of an opponent's bag and hand follow by subtraction.
 * Only the order is unknown, and that is what `sampleDeterminization` invents.
 *
 * The redacted state itself is `GameView` from `view.ts`, the same object the
 * client is sent: a bot that only reads a `GameView` cannot see more than the
 * player it plays for.
 */

import { legalActions } from './engine.js';
import { shuffle, type RngState } from './rng.js';
import type { GameState, PlayerState, Seat } from './types.js';
import {
  DECOYS,
  isDecoy,
  ROYAL_COIN,
  UNITS,
  type CoinId,
  type DecoyId,
} from './units.js';
import { viewFor, type GameView, type PlayerView } from './view.js';

/** The redacted state as seen from `seat`, legal actions included. */
export function publicStateFor(state: GameState, seat: Seat): GameView {
  return viewFor(state, seat, legalActions(state, seat));
}

export interface HiddenCoins {
  readonly seat: Seat;
  /** Coins that must be among this player's hidden piles, worked out exactly. */
  readonly known: CoinId[];
  /**
   * Slots the subtraction cannot fill. Only a Decoy Coin can do that: it is
   * planted face up in a discard pile and then vanishes into the bag on the
   * next refill.
   */
  readonly unknown: number;
  /** How many coins are hidden in each pile, from the public counts. */
  readonly bagCount: number;
  readonly handCount: number;
  readonly facedownCount: number;
}

/**
 * The multiset of coins that must be somewhere in `seat`'s hidden piles.
 *
 * Hidden means: the bag (always), the hand (unless it is our own or the Spy
 * decree is showing it) and facedown discards (unless they are our own).
 */
export function hiddenCoins(view: GameView, seat: Seat): HiddenCoins {
  const p = view.players[seat];
  if (!p) throw new Error(`no seat ${seat}`);

  const left = new Map<CoinId, number>();
  const take = (coin: CoinId, n = 1) => {
    const have = left.get(coin) ?? 0;
    if (have < n) throw new Error(`view is inconsistent: seat ${seat} shows too many ${coin} coins`);
    left.set(coin, have - n);
  };

  for (const unit of p.units) left.set(unit, UNITS[unit].coins);
  left.set(ROYAL_COIN, 1);

  for (const stack of Object.values(view.units)) {
    if (stack.seat === seat) take(stack.unit, stack.coins);
  }
  for (const [unit, n] of Object.entries(p.supply)) take(unit as CoinId, n ?? 0);
  for (const [unit, n] of Object.entries(p.removed)) take(unit as CoinId, n ?? 0);

  // A lifted stack is on no pile at all: the Redeploy decree holds it on the
  // pending step between coming off the board and going back down. Without this
  // the sum comes up short by exactly those coins and the view looks impossible
  // — which is how it was found, as a search that died mid-match whenever it was
  // asked to think during a Redeploy.
  if (seat === view.turn) {
    for (const step of view.pending) {
      if (step.kind === 'decreePlace') take(step.unit, step.coins);
    }
  }

  let facedownCount = 0;
  for (const d of p.discard) {
    if (d.coin === null) facedownCount++;
    else if (!isDecoy(d.coin)) take(d.coin);
  }
  const handKnown = p.hand !== undefined;
  if (p.hand) for (const coin of p.hand) if (!isDecoy(coin)) take(coin);

  const known: CoinId[] = [];
  for (const [coin, n] of left) for (let i = 0; i < n; i++) known.push(coin);

  const slots = p.bagCount + (handKnown ? 0 : p.handCount) + facedownCount;
  const unknown = slots - known.length;
  if (unknown < 0) {
    throw new Error(`view is inconsistent: seat ${seat} hides ${slots} coins but owns ${known.length}`);
  }

  return {
    seat,
    known,
    unknown,
    bagCount: p.bagCount,
    handCount: handKnown ? 0 : p.handCount,
    facedownCount,
  };
}

/** Decoy Coins that could be sitting in somebody's hidden piles. */
function hiddenDecoys(view: GameView): DecoyId[] {
  if (!view.sets.includes('nightfall')) return [];
  const seen = new Set<CoinId>();
  for (const p of view.players) {
    for (const d of p.discard) if (d.coin !== null) seen.add(d.coin);
    for (const coin of p.hand ?? []) seen.add(coin);
  }
  return DECOYS.filter((decoy) => !seen.has(decoy));
}

/**
 * Invents one full state consistent with everything `view` shows: the same
 * board, the same counts, the same visible coins, and a random order for what
 * is hidden. Search runs on these; each iteration draws a fresh one.
 */
export function sampleDeterminization(view: GameView, rng: RngState): GameState {
  const hidden = view.players.map((p) => hiddenCoins(view, p.seat));

  // A Decoy that vanished into somebody's bag has to be handed to exactly one
  // player, so the decoys are dealt across the table before the piles are.
  const decoys = shuffle(rng, hiddenDecoys(view));
  const extra: CoinId[][] = view.players.map(() => []);
  for (const h of hidden) {
    for (let i = 0; i < h.unknown; i++) {
      const decoy = decoys.pop();
      if (decoy === undefined) throw new Error('view is inconsistent: more hidden coins than coins exist');
      (extra[h.seat] as CoinId[]).push(decoy);
    }
  }

  const players = view.players.map((p) => dealPlayer(p, hidden[p.seat] as HiddenCoins, extra[p.seat] as CoinId[], rng));

  const initiative = view.players.find((p) => p.hasInitiative)?.seat ?? 0;
  return {
    id: view.id,
    size: view.size,
    phase: view.phase,
    round: view.round,
    turn: view.turn,
    players,
    units: Object.fromEntries(Object.entries(view.units).map(([hex, s]) => [hex, { ...s }])),
    control: { ...view.control },
    initiative,
    initiativeMovedThisRound: view.initiativeMovedThisRound,
    pending: [...view.pending],
    draftMode: view.draftMode,
    sets: [...view.sets],
    decrees: view.decrees.map((d) => ({ id: d.id, seals: [...d.seals] })),
    forts: { ...view.forts },
    fortSupply: view.fortSupply,
    draftPool: [...view.draftPool],
    banned: [...view.banned],
    log: [...view.log],
    winner: view.winner,
    // The search reshuffles bags itself; the seed only has to be reproducible.
    rng: { seed: (rng.seed ^ (view.round * 0x9e3779b1)) >>> 0 },
  };
}

function dealPlayer(
  p: PlayerView,
  hidden: HiddenCoins,
  extra: CoinId[],
  rng: RngState,
): PlayerState {
  const pool = shuffle(rng, [...hidden.known, ...extra]);

  const hand: CoinId[] = p.hand ? [...p.hand] : pool.splice(0, hidden.handCount);
  const discard: { coin: CoinId; faceUp: boolean }[] = [];
  for (const d of p.discard) {
    discard.push({ coin: d.coin ?? (pool.pop() as CoinId), faceUp: d.faceUp });
  }
  // Whatever is left is the bag, in an order the drawer cannot know.
  const bag = pool;

  return {
    seat: p.seat,
    team: p.team,
    userId: p.userId,
    displayName: p.displayName,
    avatarUrl: p.avatarUrl ?? null,
    ...(p.bot ? { bot: p.bot } : {}),
    units: [...p.units],
    bag,
    hand,
    discard,
    supply: { ...p.supply },
    removed: { ...p.removed },
    seals: p.seals,
    hasInitiative: p.hasInitiative,
  };
}
