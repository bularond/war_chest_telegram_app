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
 * The same count over all 28 units, played with the three expansions out: 3600
 * games under `search@7`, about 1030 appearances each, ±3.0 points.
 *
 * It is a different game, not an extension of the same one. A pool of eight
 * drawn from 28 asks a unit to beat different company than a pool drawn from 16.
 * What holds across both is the Light Cavalry on top and the Footman at the
 * bottom.
 *
 * **This replaced a 660-game table, and the middle of it moved.** Rank
 * correlation between the two is 0.870 — the ends held, as they did when the
 * base table was re-counted at twice the size — but the Siege Tower rose 7.9
 * points from thirteenth to fifth, the Pikeman fell 6.7 from fifth to eleventh,
 * and the Swordsman rose 6.5 from twenty-sixth to fifteenth. None of that
 * contradicts the old numbers: at ±7 a unit's place in the middle of the table
 * was never measured at all, and a rule that drafts by it was reading noise for
 * eleven of the twenty-eight.
 *
 * The Pikeman is the one that got noticed from outside. A player watching the
 * bot said it kept drafting Pikemen, stacking them and then not playing them —
 * and the drafting half of that was the old table putting a middling unit fifth.
 */
const MEASURED_VALUE_ALL: Readonly<Partial<Record<UnitId, number>>> = {
  lightCavalry: 0.651,
  skirmisher: 0.622,
  scout: 0.588,
  mercenary: 0.575,
  siegeTower: 0.573,
  warriorPriest: 0.542,
  bannerman: 0.534,
  herald: 0.53,
  earl: 0.525,
  cavalry: 0.52,
  pikeman: 0.515,
  infiltrator: 0.512,
  royalGuard: 0.505,
  knight: 0.489,
  swordsman: 0.488,
  archer: 0.486,
  warWagon: 0.486,
  lancer: 0.484,
  assassin: 0.462,
  bishop: 0.46,
  berserker: 0.457,
  ensign: 0.446,
  sapper: 0.436,
  marshal: 0.434,
  crossbowman: 0.43,
  saboteur: 0.425,
  trebuchet: 0.423,
  footman: 0.416,
};

/**
 * The 660-game table this replaced, kept so the replacement can be checked by
 * reversal rather than believed.
 */
const MEASURED_VALUE_ALL_660: Readonly<Partial<Record<UnitId, number>>> = {
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
 * So it takes the base-game value where there is one. Both tables are now
 * measured to about the same precision — 2220 games at ±2.9 against 3600 at
 * ±3.0 — so this is no longer a choice between a tight number and a loose one;
 * it is a choice of which game the evaluation should believe, and the base game
 * is the one whose sixteen units appear in every match the arena plays.
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

export { MEASURED_VALUE, MEASURED_VALUE_ALL, MEASURED_VALUE_ALL_660 };
