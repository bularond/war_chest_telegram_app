/**
 * How good a position is, as one number in [-1, 1].
 *
 * A rollout that stops after a dozen plies has to be told what it is looking
 * at, and this is that. Search quality is bounded by this function: an
 * evaluation that misreads a position will have the search work hard to reach
 * it.
 *
 * **The weights are data, not code.** They are a plain object, versioned, and
 * written into the log of every game the bot plays, so a win rate can be traced
 * back to the numbers that produced it. Roadmap stage 8 grows this file one
 * feature at a time, each admitted only by a measured match; nothing is added
 * here on the strength of an argument.
 */

import { stepsFromAny, type Steps } from './board-sense.js';
import {
  actingSeat,
  boardFor,
  deployTargets,
  distance,
  fromId,
  hasRestriction,
  isUnitId,
  markersRemaining,
  neighbors,
  toId,
  UNITS,
  type GameState,
  type HexId,
  type Seat,
  type TacticSpec,
  type Team,
  type UnitId,
} from '@wc/shared';

export interface EvalWeights {
  /** Bumped whenever a number below changes. Written into the game log. */
  readonly version: string;
  /** Control markers placed — the win condition, and so the anchor. */
  readonly markers: number;
  /** Coins standing on the board. */
  readonly material: number;
  /**
   * How much a unit's *type* counts as material, on top of the coins under it.
   * Both are read off the printed card — see `typeValue` — and both are zero
   * until an experiment says otherwise, so a zero here means "material is coins
   * and nothing else", which is what every version up to `eval@3` measured.
   */
  readonly scarcity: number;
  readonly reach: number;
  /** Coins still to come: bag, hand, discard and supply. */
  readonly reserve: number;
  /** Coins stacked on top of units: staying power against concentrated risk. */
  readonly bolster: number;
  /** How far our units are from locations we do not hold, as the crow flies. */
  readonly proximity: number;
  /**
   * The same thing, but counting steps around whatever is in the way.
   *
   * The straight-line version was a deliberate compromise: it runs at the end of
   * every rollout, and a sweep per evaluation used to cost more than the
   * accuracy was worth. Since the sweep was rewritten to run on numbers it costs
   * about a fortieth of an iteration, so the compromise is worth revisiting — a
   * unit two hexes from a location with a wall between them is not two hexes
   * from it in any sense the game recognises.
   *
   * Meant to be used *instead of* `proximity`, not alongside it: they measure
   * the same thing.
   */
  readonly proximityWalk: number;
  /** Holding the Initiative Marker. */
  readonly initiative: number;
  /** Being the one to move. */
  readonly tempo: number;
  /** Coins in hand, as against coins anywhere else: only these can be spent now. */
  readonly hand: number;
  /** Stacks standing where the other side can hit them. */
  readonly threat: number;
  /** Coins in hand for units that are neither on the board nor left to recruit. */
  readonly deadWeight: number;
  /**
   * Coins in hand whose unit is not on the board at all.
   *
   * The strict version above — nowhere to deploy, nothing to recruit, nothing to
   * bolster — turned out to fire in one position out of a hundred, so its null
   * verdict was about the definition and not about the idea. This is the same
   * thought, loosened to something that happens: a coin whose unit is absent can
   * only be spent on deploying it, and a hand full of those is a hand that
   * cannot answer what is on the board.
   */
  readonly idleHand: number;
}

/**
 * The starting point, not a tuned set. Marker difference dominates because it
 * is the only thing that ends the game; material and reserve are there to give
 * the search something to steer by while no marker is in reach.
 */
export const BASE_WEIGHTS: EvalWeights = {
  version: 'eval@5',
  // The anchor. Coordinate descent scales the others against it, because the
  // overall scale of the sum is swallowed by `tanh` and only ratios mean
  // anything.
  markers: 1,
  // Doubled by coordinate descent and confirmed on fresh seeds: 1120 games,
  // 55.2% [52.3 … 58.1], +36 Elo.
  material: 0.7,
  // 0.15 for months, and undervalued the whole time. Four independent fits put
  // it between 0.21 and 0.55; the match settled it at 0.48 — 638 games, 55.2%,
  // +36 Elo. A probe further out (0.7) came back level, so this is a plateau
  // rather than a peak, and 0.48 sits inside it. The coordinate descent had
  // stalled here twice: its ×2 step from 0.15 reaches 0.3, which is not far
  // enough to show anything.
  reserve: 0.48,
  // Untried as of eval@3: material has always been coin counting.
  scarcity: 0,
  reach: 0,
  // Zero is not a placeholder, it is a verdict. `bolster` was tried and did not
  // pay for itself; `initiative` has not yet been shown to. A feature that has
  // not won an experiment weighs nothing, whatever it looks like it should do.
  bolster: 0,
  // Accepted as a feature at 0.2 (912 games, 56.0%, LLR 2.96), then doubled by
  // the same descent that doubled `material`.
  proximity: 0.4,
  proximityWalk: 0,
  initiative: 0,
  tempo: 0,
  hand: 0,
  threat: 0,
  // Zero because it fires in one position out of a hundred, which is why its
  // match said nothing. `idleHand` below is the same thought, loosened until it
  // says something.
  deadWeight: 0,
  // 468 games, 56.2%, +43 Elo. Switching it back off on fresh seeds cost 38 Elo
  // (182 games, 44.5%), and twice the weight was worse than none of it
  // (304 games, 46.4%) — so this is a point, not a plateau. The value came from
  // a fit to the search's own valuations, not from taste.
  idleHand: 0.06,
};

/** Positive is good for `seat`. Clipped into [-1, 1] by `tanh`. */
export function evaluate(state: GameState, seat: Seat, weights: EvalWeights = BASE_WEIGHTS): number {
  const me = state.players[seat];
  if (!me) return 0;
  if (state.phase === 'finished') {
    if (state.winner === null) return 0;
    return state.winner === me.team ? 1 : -1;
  }

  const board = boardFor(state.size);
  const foeTeam = otherTeam(state, me.team);

  // Markers: how many each side has *placed*, since that is what wins.
  const placed = (team: Team) => board.controlMarkers - markersRemaining(state, team);
  const markers = (placed(me.team) - placed(foeTeam)) / board.controlMarkers;

  // Weights arrive from JSON files written by earlier versions, which have no
  // key for a feature that did not exist yet. A missing weight is a zero.
  const byType = (weights.scarcity ?? 0) !== 0 || (weights.reach ?? 0) !== 0;
  let mine = 0;
  let theirs = 0;
  for (const stack of Object.values(state.units)) {
    // Coins are the bulk of it: a bolstered stack takes two hits, not one. The
    // type rides on top as a multiplier, so a scarce unit is worth more per coin
    // rather than worth something regardless of how much is under it.
    const worth = byType ? stack.coins * multiplier(stack.unit, weights) : stack.coins;
    if (stack.team === me.team) mine += worth;
    else theirs += worth;
  }
  // Divided by the plain coin count, never by the weighted one: the size of the
  // pile on the table is a fact about the position, and it should not move
  // because we changed our mind about what a Knight is worth. It also keeps the
  // whole sum linear in the weights, which is what lets `featureVector` exist.
  const onBoard = coinsOnBoard(state);
  const material = onBoard === 0 ? 0 : (mine - theirs) / onBoard;

  let myReserve = 0;
  let theirReserve = 0;
  for (const p of state.players) {
    const coins = p.bag.length + p.hand.length + p.discard.length + total(p.supply);
    if (p.team === me.team) myReserve += coins;
    else theirReserve += coins;
  }
  const pool = myReserve + theirReserve;
  const reserve = pool === 0 ? 0 : (myReserve - theirReserve) / pool;

  let score =
    weights.markers * markers + weights.material * material + weights.reserve * reserve;

  if (weights.bolster !== 0) {
    // Coins above the first on each stack. Bolstering trades width for depth:
    // fewer places at once, but harder to remove from any of them.
    let deep = 0;
    let theirDeep = 0;
    for (const stack of Object.values(state.units)) {
      const extra = stack.coins - 1;
      if (stack.team === me.team) deep += extra;
      else theirDeep += extra;
    }
    const stacked = deep + theirDeep;
    score += weights.bolster * (stacked === 0 ? 0 : (deep - theirDeep) / stacked);
  }

  if (weights.proximity !== 0) {
    // Closeness to the locations we do not hold: a unit two hexes from a free
    // location is worth more than the same unit idling behind the line.
    const open = board.locations.filter((loc) => state.control[loc] !== me.team);
    score += weights.proximity * (closeness(state, me.team, open) - closeness(state, foeTeam, open));
  }

  if ((weights.proximityWalk ?? 0) !== 0) {
    const open = board.locations.filter((loc) => state.control[loc] !== me.team);
    // One sweep, both sides. It measures distance *from* the open locations, so
    // every unit on the board reads its own number out of the same walk.
    const steps = stepsFromAny(state, open);
    score +=
      weights.proximityWalk *
      (walkCloseness(state, me.team, steps, open.length) - walkCloseness(state, foeTeam, steps, open.length));
  }

  if ((weights.initiative ?? 0) !== 0) {
    const mine = state.players.find((p) => p.hasInitiative);
    score += weights.initiative * (mine ? (mine.team === me.team ? 1 : -1) : 0);
  }

  if ((weights.tempo ?? 0) !== 0) {
    // Half a move is worth something in most games; whether it is worth
    // anything here is what the experiment is for. `actingSeat` is the seat that
    // owes the next decision, which in this game is not always the seat whose
    // turn it is — a defender choosing where to take a hit is the one to move.
    const acting = state.players[actingSeat(state)];
    score += weights.tempo * (acting ? (acting.team === me.team ? 1 : -1) : 0);
  }

  if ((weights.hand ?? 0) !== 0) {
    // `reserve` counts the bag, the hand, the discard and the supply as one pile
    // of coins to come. Only the hand can be spent this turn, and a hand of one
    // coin is a turn with one option in it.
    let held = 0;
    let theirs = 0;
    for (const p of state.players) {
      if (p.team === me.team) held += p.hand.length;
      else theirs += p.hand.length;
    }
    const inHand = held + theirs;
    score += weights.hand * (inHand === 0 ? 0 : (held - theirs) / inHand);
  }

  if ((weights.threat ?? 0) !== 0) {
    score += weights.threat * threatBalance(state, me.team, foeTeam);
  }

  if ((weights.idleHand ?? 0) !== 0) {
    score -= weights.idleHand * (idleFraction(state, me.team) - idleFraction(state, foeTeam));
  }

  if ((weights.deadWeight ?? 0) !== 0) {
    // Negative: dead weight is a liability, and the weight itself is expected
    // to come out positive if the feature is worth anything at all.
    score -= weights.deadWeight * (deadFraction(state, me.team) - deadFraction(state, foeTeam));
  }

  return Math.tanh(score);
}

/**
 * Which side has more of its stacks standing where they can be hit.
 *
 * Contact is mutual, so a naive count would cancel to zero and mean nothing.
 * What does not cancel is *who can actually swing*: three units in the box —
 * the Archer, the Lancer and the Trebuchet — are printed "can only attack by
 * using its tactic", so standing next to one is safe in a way that standing next
 * to a Swordsman is not.
 *
 * Only plain adjacent attacks are counted. A tactic needs the matching coin in
 * hand, and the hand the search is looking at is a guess — a threat that depends
 * on a card we invented is a threat we invented.
 */
function threatBalance(state: GameState, mine: Team, theirs: Team): number {
  let exposed = 0;
  let myStacks = 0;
  let theirExposed = 0;
  let theirStacks = 0;

  for (const [id, stack] of Object.entries(state.units)) {
    const friendly = stack.team === mine;
    if (friendly) myStacks++;
    else if (stack.team === theirs) theirStacks++;
    else continue;

    for (const n of neighbors(fromId(id))) {
      const other = state.units[toId(n)];
      if (!other || other.team === stack.team) continue;
      if (hasRestriction(other.unit, 'noNormalAttack')) continue;
      if (friendly) exposed++;
      else theirExposed++;
      break;
    }
  }

  const here = myStacks === 0 ? 0 : exposed / myStacks;
  const there = theirStacks === 0 ? 0 : theirExposed / theirStacks;
  return there - here;
}

/**
 * The share of a hand that can do nothing but claim the Initiative or be
 * discarded.
 *
 * A coin in hand has four uses and each has a condition: *deploy* needs
 * somewhere to deploy to, *recruit* needs a coin of that unit still in the
 * supply, and *bolster* and *maneuver* both need one of that unit already on the
 * board. A coin that fails all four is a coin that costs a turn.
 *
 * Where the conditions come from matters. The first draft of this asked only
 * "is the unit on the board or in the supply", which is not the rule and is not
 * even close: a unit absent from the board is the normal case for a coin you are
 * about to deploy. So the deploy condition is asked of the engine —
 * `deployTargets` knows about the per-unit deploy cap and about the Footman's
 * two, and a second copy of that rule living here would be a second copy to get
 * wrong.
 */
function deadFraction(state: GameState, team: Team): number {
  const present = new Set<UnitId>();
  for (const stack of Object.values(state.units)) {
    if (stack.team === team) present.add(stack.unit);
  }

  let dead = 0;
  let held = 0;
  for (const p of state.players) {
    if (p.team !== team) continue;
    for (const coin of p.hand) {
      held++;
      // The Royal Coin and a Nightfall decoy are not units and are never stuck:
      // the first is the most flexible coin in the game and the second is spent
      // by being spent.
      if (!isUnitId(coin)) continue;
      if (present.has(coin)) continue;
      if ((p.supply[coin] ?? 0) > 0) continue;
      if (deployTargets(state, p.seat, coin).length > 0) continue;
      dead++;
    }
  }
  return held === 0 ? 0 : dead / held;
}

/** The share of a hand whose units are not on the board. */
function idleFraction(state: GameState, team: Team): number {
  const present = new Set<UnitId>();
  for (const stack of Object.values(state.units)) {
    if (stack.team === team) present.add(stack.unit);
  }
  let idle = 0;
  let held = 0;
  for (const p of state.players) {
    if (p.team !== team) continue;
    for (const coin of p.hand) {
      held++;
      if (isUnitId(coin) && !present.has(coin)) idle++;
    }
  }
  return held === 0 ? 0 : idle / held;
}

/**
 * The same position as a plain vector, one number per weight.
 *
 * `evaluate` computes only the features whose weight is non-zero, because it
 * runs at the end of every rollout and most weights are zero. This computes all
 * of them, for the one caller that needs them all: fitting weights to the
 * outcomes of thousands of games (`npm run regress`). Nothing in the search
 * calls it.
 *
 * The two must agree — `evaluate` has to equal `tanh(w · featureVector)` — and
 * they are held to it by a test rather than by care, because they are two
 * implementations of one formula and that always drifts.
 *
 * `scarcity` and `reach` are the awkward pair: in `evaluate` they multiply the
 * material term rather than adding to it. Here they are their own coordinates,
 * so what comes back from a regression is the *product* `material × scarcity`.
 * `weightsFromFit` untangles that; see it before reading a fitted number as a
 * weight.
 */
export function featureVector(state: GameState, seat: Seat): number[] {
  const me = state.players[seat];
  if (!me) return FEATURES.map(() => 0);
  const board = boardFor(state.size);
  const foeTeam = otherTeam(state, me.team);
  const sign = (team: Team) => (team === me.team ? 1 : -1);

  const placed = (team: Team) => board.controlMarkers - markersRemaining(state, team);
  const markers = (placed(me.team) - placed(foeTeam)) / board.controlMarkers;

  let coins = 0;
  let material = 0;
  let scarcity = 0;
  let reach = 0;
  let bolster = 0;
  for (const stack of Object.values(state.units)) {
    const value = typeValue(stack.unit);
    coins += stack.coins;
    material += sign(stack.team) * stack.coins;
    scarcity += sign(stack.team) * stack.coins * value.scarcity;
    reach += sign(stack.team) * stack.coins * value.reach;
    bolster += sign(stack.team) * (stack.coins - 1);
  }
  const stacked = Object.values(state.units).reduce((n, s) => n + s.coins - 1, 0);

  let reserve = 0;
  let pool = 0;
  let hand = 0;
  let inHand = 0;
  for (const p of state.players) {
    const held = p.bag.length + p.hand.length + p.discard.length + total(p.supply);
    pool += held;
    reserve += sign(p.team) * held;
    inHand += p.hand.length;
    hand += sign(p.team) * p.hand.length;
  }

  const open = board.locations.filter((loc) => state.control[loc] !== me.team);
  const proximity = closeness(state, me.team, open) - closeness(state, foeTeam, open);
  const holder = state.players.find((p) => p.hasInitiative);
  const acting = state.players[actingSeat(state)];

  return [
    markers,
    coins === 0 ? 0 : material / coins,
    coins === 0 ? 0 : scarcity / coins,
    coins === 0 ? 0 : reach / coins,
    pool === 0 ? 0 : reserve / pool,
    stacked === 0 ? 0 : bolster / stacked,
    proximity,
    holder ? sign(holder.team) : 0,
    acting ? sign(acting.team) : 0,
    inHand === 0 ? 0 : hand / inHand,
    threatBalance(state, me.team, foeTeam),
    -(deadFraction(state, me.team) - deadFraction(state, foeTeam)),
    -(idleFraction(state, me.team) - idleFraction(state, foeTeam)),
  ];
}

/** The order of `featureVector`, and the weight each coordinate belongs to. */
export const FEATURES: readonly (keyof EvalWeights)[] = [
  'markers',
  'material',
  'scarcity',
  'reach',
  'reserve',
  'bolster',
  'proximity',
  'initiative',
  'tempo',
  'hand',
  'threat',
  'deadWeight',
  'idleHand',
];

/**
 * A fitted vector read back as weights.
 *
 * Everything is a coefficient except the material trio: `evaluate` multiplies
 * coins by `1 + scarcity·s + reach·r` and then by `material`, so a fit returns
 * `material`, `material·scarcity` and `material·reach`. Dividing gives the
 * weights back. A material coefficient at or near zero says the fit has no
 * opinion about unit types either, and the two ride along at zero.
 */
export function weightsFromFit(fit: readonly number[], version: string): EvalWeights {
  const at = (key: keyof EvalWeights) => fit[FEATURES.indexOf(key)] ?? 0;
  const material = at('material');
  const scale = Math.abs(material) < 1e-6 ? 0 : 1 / material;
  return {
    version,
    markers: at('markers'),
    material,
    scarcity: at('scarcity') * scale,
    reach: at('reach') * scale,
    reserve: at('reserve'),
    bolster: at('bolster'),
    proximity: at('proximity'),
    // Not fitted: it measures the same thing as `proximity` and would only
    // split that feature's weight in half between two coordinates.
    proximityWalk: 0,
    initiative: at('initiative'),
    tempo: at('tempo'),
    hand: at('hand'),
    threat: at('threat'),
    deadWeight: at('deadWeight'),
    idleHand: at('idleHand'),
  };
}

/**
 * What a unit is worth per coin, as against the flat 1 that every version up to
 * `eval@3` used.
 *
 * **Both features are read off the card, not invented.** There is no printed
 * power rating in War Chest, and inventing a table of 28 numbers would be
 * exactly the kind of plausible fiction this project forbids — so the two things
 * the box does say are used instead:
 *
 * - *scarcity*: the designers print four coins of some units and five of others,
 *   and the short print run is the strong one. This is the only ranking the
 *   components themselves carry.
 * - *reach*: whether the tactic can strike something that is not adjacent. A
 *   unit that hits from two hexes away trades differently from one that has to
 *   walk into contact, whatever else it does.
 *
 * Whether either is worth anything is a question for the arena. Both weigh zero
 * until an experiment moves them.
 */
function coinsOnBoard(state: GameState): number {
  let n = 0;
  for (const stack of Object.values(state.units)) n += stack.coins;
  return n;
}

function multiplier(unit: UnitId, weights: EvalWeights): number {
  const value = typeValue(unit);
  const m = 1 + (weights.scarcity ?? 0) * value.scarcity + (weights.reach ?? 0) * value.reach;
  // A weight pushed far enough negative would make a unit worth less than
  // nothing, and a side's total could then cross zero and take the normalising
  // denominator with it.
  return m < 0 ? 0 : m;
}

interface TypeValue {
  /** 1 for a four-coin unit, 0 for a five-coin one. */
  readonly scarcity: number;
  /** 1 if the tactic reaches past the neighbouring hexes. */
  readonly reach: number;
}

const TYPE_VALUES: ReadonlyMap<UnitId, TypeValue> = new Map(
  Object.values(UNITS).map((spec) => [
    spec.id,
    {
      scarcity: Math.max(0, 5 - spec.coins),
      reach: reaches(spec.tactic) ? 1 : 0,
    },
  ]),
);

const NO_VALUE: TypeValue = { scarcity: 0, reach: 0 };

function typeValue(unit: UnitId): TypeValue {
  return TYPE_VALUES.get(unit) ?? NO_VALUE;
}

/** Does the printed tactic hit something further off than an adjacent hex? */
function reaches(tactic: TacticSpec | undefined): boolean {
  if (!tactic) return false;
  switch (tactic.kind) {
    case 'rangedAttack':
    case 'poisonAtRange':
      return tactic.max > 1;
    case 'chargeAttack':
    case 'moveThenPoison':
    case 'moveThenAttackFort':
    case 'skirmish':
      // Move first, strike second: the target starts out of contact.
      return true;
    default:
      return false;
  }
}

/**
 * How near a side's units are to the given locations, as a number that grows
 * with nearness. Plain hex distance, not a walk around occupied hexes: this
 * runs at the end of every rollout, and a sweep per evaluation would cost more
 * than the extra accuracy is worth.
 */
function closeness(state: GameState, team: Team, locations: readonly HexId[]): number {
  if (locations.length === 0) return 0;
  let sum = 0;
  let units = 0;
  for (const [hex, stack] of Object.entries(state.units)) {
    if (stack.team !== team) continue;
    units++;
    let best = Infinity;
    for (const loc of locations) {
      const d = distance(fromId(hex), fromId(loc));
      if (d < best) best = d;
    }
    // A location under our feet scores 1, one across the board scores near 0.
    sum += 1 / (1 + best);
  }
  return units === 0 ? 0 : sum / units;
}

/**
 * The same shape as `closeness`, but on steps rather than hex distance. The
 * sweep is passed in because one of them answers for both sides.
 *
 * It is passed in rather than cached for a reason worth remembering: the search
 * now advances one state object in place, so "the same object" no longer means
 * "the same position", and any cache keyed on identity would hand back a walk
 * from several plies ago.
 */
function walkCloseness(state: GameState, team: Team, steps: Steps, locations: number): number {
  if (locations === 0) return 0;
  let sum = 0;
  let units = 0;
  for (const [hex, stack] of Object.entries(state.units)) {
    if (stack.team !== team) continue;
    units++;
    const d = steps.get(hex as HexId);
    // Unreachable is not "infinitely far": it is a unit that contributes
    // nothing, which is what a zero says here.
    if (d !== undefined) sum += 1 / (1 + d);
  }
  return units === 0 ? 0 : sum / units;
}

function total(counts: Partial<Record<string, number>>): number {
  let sum = 0;
  for (const n of Object.values(counts)) sum += n ?? 0;
  return sum;
}

function otherTeam(state: GameState, team: Team): Team {
  return state.players.find((p) => p.team !== team)?.team ?? (team === 0 ? 1 : 0);
}
