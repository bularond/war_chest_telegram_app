/**
 * What each unit is worth, measured.
 *
 * These two tables started as a draft rule and are data, not policy — which is
 * why they live here rather than inside the bot that first read them. The draft
 * asks "which of these should I take"; the evaluation asks "was that trade good"
 * — the same number answers both, and only one of them had it.
 */

import { UNITS, type UnitId } from '@wc/shared';

/**
 * How often each unit was on the winning side, measured rather than judged.
 *
 * 2220 games of the search playing itself at 200 iterations a move, units dealt
 * at random, four a side — two runs pooled, the second played by a bot that had
 * changed since the first. They agree within their intervals (±2.9) everywhere
 * but the Mercenary, which moved nine points, so the loop that worried me —
 * the bot measures the units, the table changes the draft, the changed bot
 * measures again — settles in one turn. The pooled number is the better
 * estimate simply for resting on more games. A unit's number is confounded by the three it was
 * dealt alongside and the four it faced, so this ranks units under random
 * partners — the right first question, and not the last one.
 *
 * **It has to be measured under the player it is for.** The same count under the
 * heuristic gives a different order and twice the spread: the Knight leads at
 * 62.9% there and sits tenth at 47.5% here, the Royal Guard is last at 24.7%
 * there and fifth at 52.2% here. The heuristic cannot use the Royal Coin, so it
 * calls the Royal Guard weak; that is a fact about the heuristic. Strength is a
 * property of the player holding the unit.
 *
 * And it explains why the draft never mattered before: by coin count the average
 * is 49.8% for the four-coin units against 50.0% for the five-coin ones. The
 * rule the bot was using — take what the box prints most of — reads a number
 * that carries no information about strength.
 */
const MEASURED_VALUE: Readonly<Partial<Record<UnitId, number>>> = {
  lightCavalry: 0.598,
  scout: 0.593,
  cavalry: 0.573,
  mercenary: 0.553,
  royalGuard: 0.528,
  pikeman: 0.516,
  warriorPriest: 0.508,
  crossbowman: 0.492,
  knight: 0.483,
  archer: 0.483,
  marshal: 0.468,
  lancer: 0.462,
  ensign: 0.445,
  berserker: 0.44,
  swordsman: 0.435,
  footman: 0.413,
};

/**
 * The same count over all 28 units, played with the three expansions out: 660
 * games, about 190 appearances each, so ±7 points on any one of them — noisier
 * than the base table and covering four times the units.
 *
 * It is a different game, not an extension of the same one. A pool of eight
 * drawn from 28 asks a unit to beat different company than a pool drawn from 16,
 * and the numbers say so: the Crossbowman is 49.2% in the base game and 44.5%
 * here, the Cavalry 57.3% and 51.8%. What holds across both is the Light Cavalry
 * on top and the Footman at the bottom.
 */
const MEASURED_VALUE_ALL: Readonly<Partial<Record<UnitId, number>>> = {
  lightCavalry: 0.7,
  skirmisher: 0.606,
  bannerman: 0.594,
  mercenary: 0.586,
  pikeman: 0.582,
  herald: 0.544,
  scout: 0.542,
  earl: 0.538,
  cavalry: 0.518,
  warriorPriest: 0.513,
  infiltrator: 0.51,
  royalGuard: 0.5,
  knight: 0.5,
  siegeTower: 0.494,
  warWagon: 0.492,
  bishop: 0.484,
  marshal: 0.469,
  archer: 0.465,
  ensign: 0.462,
  lancer: 0.459,
  trebuchet: 0.456,
  berserker: 0.449,
  crossbowman: 0.445,
  assassin: 0.44,
  sapper: 0.436,
  saboteur: 0.424,
  swordsman: 0.423,
  footman: 0.39,
};

/**
 * A unit's strength on the scale the evaluation speaks: zero for an average
 * unit, about ±1 at the ends of the table.
 *
 * The raw numbers are win rates around 0.5 with a spread of nine points either
 * way, so used directly they would need a weight ten times any other to say
 * anything, and every fitted vector would come back with a suspiciously large
 * coordinate that means nothing. Dividing by the table's own half-spread puts
 * the strongest unit near +1 and the weakest near −1 — the same [−1, 1] every
 * other feature lives on. The divisor is computed from the table rather than
 * written down, so re-measuring the table cannot silently rescale the weight.
 *
 * A unit the table does not cover counts as average, not as worthless: a
 * missing measurement is not a measurement of zero.
 */
function scaleOf(table: Readonly<Partial<Record<UnitId, number>>>): number {
  const values = Object.values(table).filter((v): v is number => typeof v === 'number');
  if (values.length === 0) return 1;
  const half = (Math.max(...values) - Math.min(...values)) / 2;
  return half < 1e-6 ? 1 : half;
}

/**
 * One table for the evaluation: the base-game number where there is one, the
 * 28-unit number otherwise.
 *
 * The two disagree, and the reason they disagree is real — a unit drawn from a
 * pool of 28 faces different company than one drawn from a pool of 16, which is
 * why the draft keeps both and picks by the pool it is actually looking at. The
 * evaluation cannot do that: it would mean a Knight being worth one thing on
 * Monday and another on Tuesday because a Siege box was opened, and every
 * weight fitted against it would be fitted against a moving number.
 *
 * So it takes the better-measured value. The base table rests on 2220 games and
 * carries ±2.9; the 28-unit table on 660, about 190 appearances each, ±7. And
 * the choice costs less than it looks: the largest disagreement between them on
 * any shared unit — the Cavalry, 57.3% against 51.8% — is inside the wider
 * table's own error bar. Preferring the tighter measurement is not a claim that
 * the pool does not matter; it is a refusal to prefer a noisier number.
 */
const MERGED: Readonly<Partial<Record<UnitId, number>>> = Object.fromEntries(
  Object.values(UNITS).map((spec) => [
    spec.id,
    MEASURED_VALUE[spec.id] ?? MEASURED_VALUE_ALL[spec.id] ?? 0.5,
  ]),
);

// One scale over the merged table, never one per source: two tables scaled
// separately would put a base unit and an expansion unit on different rulers
// and the difference between them would be an artefact of which table they came
// from.
const SCALE = scaleOf(MERGED);

export const UNIT_WORTH: Readonly<Record<string, number>> = Object.fromEntries(
  Object.values(UNITS).map((spec) => [spec.id, ((MERGED[spec.id] ?? 0.5) - 0.5) / SCALE]),
);

export function unitWorth(unit: UnitId): number {
  return UNIT_WORTH[unit] ?? 0;
}

export { MEASURED_VALUE, MEASURED_VALUE_ALL };
