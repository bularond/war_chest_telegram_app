/**
 * One coordinate per unit, for asking whether the evaluation should have them.
 *
 * The proposal this exists to test: replace the single `material` term — every
 * coin counts one — with a weight per unit type, and let a fit learn what a
 * Knight coin on the board is worth against a Footman coin.
 *
 * Note what the bank is, exactly. The board coordinates sum to `material` by
 * construction, and the reserve coordinates sum to `reserve`. So this is not a
 * new feature; it is those two features with their degrees of freedom unlocked —
 * 27 extra directions in which the fit may find something, on top of the one it
 * already has. `worth` tried exactly one of those directions, the one given by
 * measured draft strength, and lost at two weights.
 *
 * **And it must not be judged by separating power.** A per-unit reserve
 * coordinate falls by one whenever a coin of that unit is spent, which is to say
 * it partly *is* the identity of the move just played — the thing the search
 * already knows and the thing `feature-power.mjs` carries a control to expose.
 * The only question worth asking of this bank is whether it predicts the outcome
 * of games it was not fitted on.
 */

import { isUnitId, UNITS, type GameState, type Seat, type UnitId } from '@wc/shared';

/** Every unit in the box, in a fixed order, so a vector means the same thing twice. */
export const BANK_UNITS: readonly UnitId[] = Object.values(UNITS)
  .map((spec) => spec.id)
  .sort();

export const BANK_FEATURES: readonly string[] = [
  ...BANK_UNITS.map((u) => `board:${u}`),
  ...BANK_UNITS.map((u) => `reserve:${u}`),
  // Royal Coins and Nightfall decoys are coins a side holds and no unit's own.
  // `reserve` counts them, so without a coordinate of their own the bank would
  // not be a split of `reserve` but a different feature wearing its name — and
  // the whole comparison rests on the bank being that split exactly.
  'reserve:other',
];

/**
 * The bank for one position, from `seat`'s side, normalised exactly as the two
 * aggregates it splits are normalised — the board by the coins on the board, the
 * reserve by every coin either side still holds anywhere.
 */
export function unitBank(state: GameState, seat: Seat): number[] {
  const me = state.players[seat];
  const out = new Array<number>(BANK_FEATURES.length).fill(0);
  if (!me) return out;

  const at = new Map(BANK_UNITS.map((u, i) => [u, i]));
  const half = BANK_UNITS.length;
  const other = 2 * half;

  let boardCoins = 0;
  for (const stack of Object.values(state.units)) {
    boardCoins += stack.coins;
    const i = at.get(stack.unit);
    if (i === undefined) continue;
    out[i] = (out[i] as number) + (stack.team === me.team ? 1 : -1) * stack.coins;
  }

  let pool = 0;
  for (const p of state.players) {
    const sign = p.team === me.team ? 1 : -1;
    const add = (coin: unknown) => {
      pool++;
      if (!isUnitId(coin as never)) {
        out[other] = (out[other] as number) + sign;
        return;
      }
      const i = at.get(coin as UnitId);
      if (i === undefined) return;
      out[half + i] = (out[half + i] as number) + sign;
    };
    for (const coin of p.bag) add(coin);
    for (const coin of p.hand) add(coin);
    for (const entry of p.discard) add(entry.coin);
    for (const [unit, n] of Object.entries(p.supply)) {
      for (let k = 0; k < (n ?? 0); k++) add(unit);
    }
  }

  for (let i = 0; i < half; i++) {
    out[i] = boardCoins === 0 ? 0 : (out[i] as number) / boardCoins;
    out[half + i] = pool === 0 ? 0 : (out[half + i] as number) / pool;
  }
  out[other] = pool === 0 ? 0 : (out[other] as number) / pool;
  return out;
}

/**
 * Who drafted what — the one thing in the bank that never changes during a game.
 *
 * The bank looks positional and is not entirely. Coins on the board and coins in
 * reserve both carry the composition each side drafted, and that composition is
 * fixed before the first move. A fit given the bank can therefore learn "this
 * side drafted the better units and will probably win", which is true, useful to
 * a *predictor*, and worth exactly nothing to a search: a term constant across
 * the whole tree shifts every leaf together and orders none of them.
 *
 * So the bank has to be judged against this, not against nothing. If holding the
 * rosters fixed leaves the bank with no improvement, the bank is the draft table
 * wearing a different hat — and the draft table is already in the bot, in the
 * one place it demonstrably pays.
 */
export function rosterVector(state: GameState, seat: Seat): number[] {
  const me = state.players[seat];
  const out = new Array<number>(BANK_UNITS.length).fill(0);
  if (!me) return out;
  const at = new Map(BANK_UNITS.map((u, i) => [u, i]));
  for (const p of state.players) {
    const sign = p.team === me.team ? 1 : -1;
    for (const unit of p.units) {
      const i = at.get(unit);
      if (i !== undefined) out[i] = (out[i] as number) + sign;
    }
  }
  return out;
}
