/**
 * Does the draft have anything left in it beyond the per-unit table?
 *
 * The draft is the one place the tuning found empty rather than optimal: three
 * policies measured the same because none of them knew anything, and replacing
 * them with a measured per-unit table was worth +140 Elo — three times any other
 * change. So it is worth being precise about what is left there.
 *
 * **Why the answer is "only synergy".** The two-player draft deals eight units
 * and hands out all eight, four each, in the order A B B A A B B A. Nothing is
 * left in the pool at the end. If a side's strength were the sum of its units'
 * strengths, taking the best unit remaining would already be optimal — that is
 * the standard result for a snake draft over known additive values, and it is
 * exactly what the bot does now. Denial is not a separate consideration either:
 * with the whole pool consumed, the unit you take is precisely the unit the
 * other side does not get.
 *
 * So any gain has to come from the values *not* being additive: from a pair of
 * units being worth more, or less, together than apart. That is a claim about
 * the game and it can be measured before any policy is written for it.
 *
 * The model, on the difference between the two sides:
 *
 *     log-odds(side A wins) = Σ v[u] − Σ v[u]  +  Σ s[u,w] − Σ s[u,w]
 *                             u∈A      u∈B      u,w∈A      u,w∈B
 *
 * Fitted with the same regularised logistic regression the weights use. Adding
 * 120 pair terms to 16 unit terms will *always* fit the games it was fitted on
 * better, so the number that decides anything is the loss on games it has never
 * seen. If held-out loss does not improve, the synergies are noise with names,
 * and a draft policy built on them would be an elaborate way of playing worse.
 */

import { UNITS, type UnitId } from '@wc/shared';
import { fit, logLoss, type Sample } from './regress.js';

/** One game as this model sees it: who held what, and who won. */
export interface DraftGame {
  readonly a: readonly UnitId[];
  readonly b: readonly UnitId[];
  /** 1 if side A won, 0 if side B did, 0.5 for a draw. */
  readonly scoreA: number;
}

export interface DraftModel {
  /** Units in the order the feature vector uses them. */
  readonly units: readonly UnitId[];
  /**
   * What side A gets for being side A, in log-odds.
   *
   * In a dealt game seat 0 always moves first, and that advantage belongs to
   * nobody's units. Without a term of its own it cannot be expressed at all —
   * the vector is a difference of two sides, so a constant added to every unit
   * cancels — and it would come out as noise smeared over sixteen weights.
   */
  readonly firstMove: number;
  /** What a unit is worth on its own, in log-odds. */
  readonly value: Readonly<Record<string, number>>;
  /** What a pair is worth beyond the sum of its two, keyed `"one|two"` sorted. */
  readonly synergy: Readonly<Record<string, number>>;
}

export interface DraftFitReport {
  readonly additive: DraftModel;
  readonly withPairs: DraftModel;
  /** Mean log-loss on games the fit never saw. The only number that decides. */
  readonly heldOut: { readonly additive: number; readonly withPairs: number };
  readonly onTrain: { readonly additive: number; readonly withPairs: number };
  readonly games: number;
}

export const pairKey = (one: UnitId, two: UnitId): string =>
  one < two ? `${one}|${two}` : `${two}|${one}`;

/** Every pair a four-unit side contains. */
function pairsOf(side: readonly UnitId[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < side.length; i++) {
    for (let j = i + 1; j < side.length; j++) {
      out.push(pairKey(side[i] as UnitId, side[j] as UnitId));
    }
  }
  return out;
}

/**
 * The unit list the model runs over, and the pairs it will carry.
 *
 * Taken from the games rather than from the catalogue: a set of games played
 * without the expansions must not be fitted with 28 units, 12 of which never
 * appear and whose weights would be whatever the regulariser left behind.
 */
function vocabulary(games: readonly DraftGame[]): { units: UnitId[]; pairs: string[] } {
  const units = new Set<UnitId>();
  const pairs = new Set<string>();
  for (const g of games) {
    for (const u of [...g.a, ...g.b]) units.add(u);
    for (const p of [...pairsOf(g.a), ...pairsOf(g.b)]) pairs.add(p);
  }
  // Sorted, so the same games always produce the same vector in the same order
  // — a fit that depends on iteration order is not a measurement.
  return { units: [...units].sort(), pairs: [...pairs].sort() };
}

function rowFor(
  game: DraftGame,
  units: readonly UnitId[],
  pairs: readonly string[],
  withPairs: boolean,
): Sample {
  // Slot 0 is the intercept: side A's standing advantage, whatever it holds.
  const features = new Array<number>(1 + units.length + (withPairs ? pairs.length : 0)).fill(0);
  features[0] = 1;
  const at = new Map(units.map((u, i) => [u, i + 1]));
  for (const u of game.a) {
    const i = at.get(u);
    if (i !== undefined) features[i] = (features[i] as number) + 1;
  }
  for (const u of game.b) {
    const i = at.get(u);
    if (i !== undefined) features[i] = (features[i] as number) - 1;
  }
  if (withPairs) {
    const base = 1 + units.length;
    const pairAt = new Map(pairs.map((p, i) => [p, base + i]));
    for (const p of pairsOf(game.a)) {
      const i = pairAt.get(p);
      if (i !== undefined) features[i] = (features[i] as number) + 1;
    }
    for (const p of pairsOf(game.b)) {
      const i = pairAt.get(p);
      if (i !== undefined) features[i] = (features[i] as number) - 1;
    }
  }
  return { features, result: game.scoreA };
}

export interface DraftFitSettings {
  readonly steps: number;
  readonly rate: number;
  /** Ridge on the unit terms. */
  readonly l2: number;
  /**
   * Ridge on the pair terms, which deserve a heavier hand: there are eight
   * times as many of them, each is seen a fraction as often, and the prior that
   * two units do nothing special together is a good one.
   */
  readonly l2Pairs: number;
  /** Held-out fold count. Every k-th game is kept back, so the split is fixed. */
  readonly folds: number;
}

export const DEFAULT_DRAFT_FIT: DraftFitSettings = {
  steps: 600,
  rate: 4,
  l2: 0.002,
  l2Pairs: 0.02,
  folds: 5,
};

/**
 * A ridge that differs by feature group. `fit` applies one constant to all of
 * them, so the pair terms are shrunk by fitting in the scaled space: a feature
 * divided by √(λ_pair/λ_unit) carries a proportionally heavier penalty, and its
 * weight is divided back out at the end. Same optimum, one knob.
 */
function scaleFor(settings: DraftFitSettings): number {
  return Math.sqrt(settings.l2Pairs / settings.l2);
}

export function fitDraft(
  games: readonly DraftGame[],
  settings: DraftFitSettings = DEFAULT_DRAFT_FIT,
): DraftFitReport {
  const { units, pairs } = vocabulary(games);
  const scale = scaleFor(settings);

  const build = (subset: readonly DraftGame[], withPairs: boolean): Sample[] =>
    subset.map((g) => {
      const row = rowFor(g, units, pairs, withPairs);
      if (!withPairs) return row;
      const features = row.features.map((x, i) => (i <= units.length ? x : x / scale));
      return { ...row, features };
    });

  const model = (weights: readonly number[], withPairs: boolean): DraftModel => ({
    units,
    firstMove: weights[0] ?? 0,
    value: Object.fromEntries(units.map((u, i) => [u, weights[i + 1] ?? 0])),
    synergy: withPairs
      ? Object.fromEntries(pairs.map((p, i) => [p, (weights[1 + units.length + i] ?? 0) / scale]))
      : {},
  });

  // Every k-th game held back. Games are independent and generated in seed
  // order, so a fixed stride is as good as a shuffle and repeats exactly.
  const train = games.filter((_, i) => i % settings.folds !== 0);
  const test = games.filter((_, i) => i % settings.folds === 0);

  const run = (withPairs: boolean) => {
    const w = fit(build(train, withPairs), { steps: settings.steps, rate: settings.rate, l2: settings.l2 });
    return {
      w,
      onTrain: logLoss(build(train, withPairs), w),
      heldOut: logLoss(build(test, withPairs), w),
    };
  };

  const flat = run(false);
  const paired = run(true);

  // The models handed back are fitted on everything: the split exists to judge
  // whether the pair terms are real, not to produce the numbers themselves.
  const allFlat = fit(build(games, false), { steps: settings.steps, rate: settings.rate, l2: settings.l2 });
  const allPaired = fit(build(games, true), { steps: settings.steps, rate: settings.rate, l2: settings.l2 });

  return {
    additive: model(allFlat, false),
    withPairs: model(allPaired, true),
    heldOut: { additive: flat.heldOut, withPairs: paired.heldOut },
    onTrain: { additive: flat.onTrain, withPairs: paired.onTrain },
    games: games.length,
  };
}

/**
 * What the model says a unit is worth to a side that already holds these.
 *
 * This is the whole point of the exercise: a draft policy that reads it picks
 * by what fits what it has, not by a fixed table. With no synergies it reduces
 * to the table exactly, which is the right behaviour when the measurement says
 * there is nothing there.
 */
export function worthTo(model: DraftModel, unit: UnitId, held: readonly UnitId[]): number {
  let sum = model.value[unit] ?? 0;
  for (const other of held) sum += model.synergy[pairKey(unit, other)] ?? 0;
  return sum;
}

/** The strongest pairs either way, for reading rather than for the bot. */
export function notableSynergies(
  model: DraftModel,
  count = 12,
): { pair: string; value: number; units: [UnitId, UnitId] }[] {
  return Object.entries(model.synergy)
    .map(([pair, value]) => {
      const [one, two] = pair.split('|') as [UnitId, UnitId];
      return { pair, value, units: [one, two] as [UnitId, UnitId] };
    })
    .filter((r) => UNITS[r.units[0]] && UNITS[r.units[1]])
    .sort((x, y) => Math.abs(y.value) - Math.abs(x.value))
    .slice(0, count);
}
