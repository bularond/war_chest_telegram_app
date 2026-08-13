/**
 * The heuristic bot: no search, one pass over the legal actions.
 *
 * Three jobs, as the roadmap sets out: a playable opponent that needs no server
 * budget, the rollout policy for the search that comes later, and a baseline
 * the arena can measure against.
 *
 * **Where the rules of thumb come from.** The decision order and the four
 * priority lists are lifted from the fan-made solo flowchart (Seth McBride,
 * BGG user Dreadpirate404, «War Chest Solo Flowchart v2.5»). Only those parts
 * are used: the rest of that document describes a different game — a solo
 * variant whose AI holds no hand, has no initiative, mass-recruits on a Royal
 * Coin and draws from a fixed list of seven base units. Nothing here is tied to
 * a unit list: what a unit can do is read from `UNITS` and from the actions the
 * engine offers, so all 28 units and every expansion are covered.
 *
 * **What is measured rather than asserted.** Two of the chart's choices are
 * left as knobs — whether attacking outranks claiming a location, and whether a
 * killing blow outranks the chart's target order — because the arena can settle
 * them and an opinion cannot.
 */

import {
  distance,
  fromId,
  nextInt,
  UNITS,
  hasAttribute,
  type GameAction,
  type GameView,
  type HexId,
  type RngState,
  type UnitId,
} from '@wc/shared';
import {
  byPriority,
  largest,
  senseFor,
  smallest,
  stepsFromAny,
  type BoardSense,
  type Steps,
} from './board-sense.js';
import { pickLegal, type Bot, type BotContext } from './types.js';
import { MEASURED_VALUE, MEASURED_VALUE_ALL, MEASURED_VALUE_ALL_660 } from './unit-worth.js';

export interface HeuristicWeights {
  /** The chart's order: hit something first, take a location only if it wins. */
  readonly attackBeforeControl: boolean;
  /** Prefer an attack that destroys a stack over the chart's target order. */
  readonly preferKills: boolean;
  /**
   * Decide the kind of move and then pick at random among moves of that kind,
   * skipping the priority lists. Several times cheaper, because the lists are
   * what the distance sweeps are for. Meant for rollouts inside a search, where
   * thousands of cheap games beat hundreds of careful ones — whether that trade
   * is worth taking is a question for the arena, not for taste.
   */
  readonly quick: boolean;
  /**
   * How to draft. `coins` takes the unit the box prints most of, `scarcity` the
   * one it prints fewest of, `random` neither.
   *
   * Both arguments are respectable and they point opposite ways: more coins is a
   * bigger share of the bag and more staying power, fewer coins is the short
   * print run the designers gave the units that do more. Which is right is a
   * question for the arena — and it matters more than it looks, because the app
   * deals a draft by default while every experiment so far has been played on
   * dealt units.
   */
  readonly draftBy: 'coins' | 'scarcity' | 'random' | 'measured' | 'measured-all' | 'measured-all-660';
  /**
   * Rank a tactic that chooses its target on a follow-up step by what it will
   * do, rather than letting it fall to `cleanup` for want of a `target` or a
   * `to` field. Off is the old behaviour, kept so the change can be measured.
   */
  readonly rankTactics: boolean;
}

export const DEFAULT_WEIGHTS: HeuristicWeights = {
  attackBeforeControl: true,
  preferKills: false,
  quick: false,
  // The largest single gain this project has measured: 110 games, 69.1%,
  // +140 Elo for drafting by measured strength at all, and +53 more for the
  // table that covers the expansions (304 games, 57.6%; going back to the
  // base-game table costs 37 Elo over 244 games). Confirmed from the other side on fresh seeds — going back to the
  // coin count costs 198 Elo (62 games, 24.2%), and drafting at random costs
  // 191 (64 games, 25.0%). Those two being equal is the point: the coin count
  // says nothing about strength, so the old rule was choosing at random with
  // extra steps.
  draftBy: 'measured-all',
  rankTactics: true,
};

/**
 * What kind of thing an action is; lower goes first. The middle of the list is
 * the chart's maneuver tree. The ends are actions a solo AI never sees at all —
 * initiative, decrees, poison counters — placed by the same reasoning: things
 * that win or damage first, things that build second, things that pass last.
 */
const RANK = {
  winningControl: 0,
  attack: 1,
  bolsterForKnight: 1.5,
  control: 2,
  deploy: 3,
  move: 4,
  proclaim: 5,
  cleanup: 6,
  recruit: 7,
  initiative: 8,
  bolster: 9,
  draft: 10,
  pass: 11,
} as const;

/** Everything one decision needs, including a cache for the walk distances. */
interface Sight {
  readonly view: GameView;
  readonly sense: BoardSense;
  readonly weights: HeuristicWeights;
  /** Distance fields by name — one sweep out from a set of hexes, reused. */
  readonly fields: Map<string, Steps>;
}

function sightFor(view: GameView, weights: HeuristicWeights): Sight {
  return { view, sense: senseFor(view), weights, fields: new Map() };
}

/**
 * Steps to the nearest hex of a named set, for every hex on the board. Computed
 * once per decision and per set: a priority list asks it of every candidate.
 */
function field(sight: Sight, name: string, sources: () => Iterable<HexId>): Steps {
  let cached = sight.fields.get(name);
  if (!cached) {
    cached = stepsFromAny(sight.view, sources());
    sight.fields.set(name, cached);
  }
  return cached;
}

const NOWHERE = Infinity;

function distanceTo(sight: Sight, name: string, sources: () => Iterable<HexId>, hex: HexId): number {
  return field(sight, name, sources).get(hex) ?? NOWHERE;
}

export function createHeuristicBot(
  weights: HeuristicWeights = DEFAULT_WEIGHTS,
  name = 'heuristic',
): Bot {
  return {
    name,
    chooseMove(view: GameView, ctx: BotContext): GameAction {
      const legal = pickLegal(view);
      if (legal.length === 1) return legal[0] as GameAction;
      if (view.phase === 'draft' || view.phase === 'ban') {
        return draftPick(legal, ctx.rng, weights.draftBy ?? 'coins');
      }

      const sight = sightFor(view, weights);
      let best = Infinity;
      const ranks = legal.map((action) => {
        const rank = rankOf(sight, action);
        if (rank < best) best = rank;
        return rank;
      });
      const pool = legal.filter((_, i) => ranks[i] === best);

      const refined = refine(sight, best, pool);
      return refined[nextInt(ctx.rng, refined.length)] as GameAction;
    },
  };
}

export const HeuristicBot: Bot = createHeuristicBot();

/**
 * Which drawer the heuristic would put each action in, lowest first.
 *
 * The heuristic's own choice throws this away — it keeps the best drawer and
 * forgets the rest. The search wants the whole ordering: a move nobody has
 * looked at is not worth the same as any other move nobody has looked at, and
 * this is the only opinion available before the first rollout.
 *
 * Exposed so it can be measured before it is believed. A prior that ranks 30 of
 * 40 moves equally cannot concentrate anything.
 */
export function rankActions(
  view: GameView,
  actions: readonly GameAction[],
  weights: HeuristicWeights = DEFAULT_WEIGHTS,
): number[] {
  const sight = sightFor(view, weights);
  return actions.map((action) => rankOf(sight, action));
}

// ---------------------------------------------------------------------------
// Which drawer an action goes in
// ---------------------------------------------------------------------------

function attackTargetOf(action: GameAction): HexId | undefined {
  if (action.type === 'attack' || action.type === 'followAttack') return action.to;
  if (action.type === 'tactic') return action.target;
  return undefined;
}

function destinationOf(action: GameAction): HexId | undefined {
  switch (action.type) {
    case 'move':
    case 'followMove':
    case 'deploy':
    case 'followPlace':
      return action.to;
    case 'tactic':
      return action.target === undefined ? action.to : undefined;
    default:
      return undefined;
  }
}

function originOf(action: GameAction): HexId | undefined {
  return 'from' in action ? (action.from as HexId) : undefined;
}

/** Placing the last control marker ends the game there and then. */
function controlWins(view: GameView): boolean {
  return (view.players[view.you]?.markersRemaining ?? 99) <= 1;
}

/**
 * The chart's Knight note: an unbolstered unit that wants to attack a Knight
 * bolsters instead. In the printed rules it has no choice — a Knight may only
 * be attacked by a bolstered unit — so this is the one time the bot bolsters.
 */
function bolsterOpensAKnight(sight: Sight, hex: HexId): boolean {
  const stack = sight.view.units[hex];
  if (!stack || stack.coins > 1 || stack.team !== sight.sense.me) return false;
  for (const other of sight.sense.enemyUnits) {
    if (distance(fromId(hex), fromId(other)) !== 1) continue;
    const foe = sight.view.units[other];
    if (foe && hasAttribute(foe.unit, 'onlyAttackedByBolstered')) return true;
  }
  return false;
}

/**
 * A tactic that chooses its target on the *next* step, ranked by what it will do
 * rather than by the fields it happens to carry.
 *
 * `rankOf` reads an action's shape: a `target` makes it an attack, a `to` makes
 * it a maneuver, and anything else drops to `cleanup` — two drawers below a
 * plain move, which the chart reaches only when nothing else exists. Six cards
 * pick their target on a follow-up step and so carry neither field: the Marshal,
 * the Ensign, the Earl, the Bishop, the Herald and the Footman.
 *
 * Measured before the fix: over 120 games with every box on the table those six
 * were offered 1401 times and played **none** of them. Not seldom — never. The
 * Marshal's tactic grants a friendly unit an attack from two spaces away, which
 * is how a War Wagon punishes anything that comes near it, and no rollout has
 * ever seen it happen. The Earl's claims a location, which is how the game is
 * won.
 *
 * The fractional ranks keep each of these in a drawer of its own, so `refine`
 * falls through to the pool untouched: its priority lists read `attackTargetOf`
 * and `destinationOf`, and those are exactly the fields these actions lack.
 */
function bareTacticRank(sight: Sight, action: GameAction): number | undefined {
  if (!sight.weights.rankTactics) return undefined;
  if (action.type !== 'tactic') return undefined;
  if (attackTargetOf(action) !== undefined || destinationOf(action) !== undefined) return undefined;
  const stack = sight.view.units[action.from];
  const spec = stack ? UNITS[stack.unit].tactic : undefined;
  switch (spec?.kind) {
    // Granting an attack sits just *below* swinging directly: it costs the
    // Marshal's coin to make somebody else swing, and if a plain attack is on
    // offer the chart should take it. Measured at 38.7% of the chances it gets.
    case 'grantManeuver':
      return spec.maneuver === 'attack' ? RANK.attack + 0.25 : RANK.move - 0.25;
    // The rest sit just *above* their plain equivalent, because each does what
    // the plain action does and something more: the Earl claims the location and
    // proclaims, the Herald bolsters out of the supply rather than out of hand,
    // the Bishop recruits and then still moves. Placed below at first, and
    // measured: all four stayed at exactly zero, because their plain equivalent
    // is available almost always and wins the drawer every time. A fix that
    // leaves the thing unreachable is not a fix.
    case 'controlThenProclaim':
      return controlWins(sight.view) ? RANK.winningControl : RANK.control - 0.25;
    case 'maneuverEachUnit':
      return RANK.move - 0.25;
    case 'recruitThenManeuver':
      return RANK.recruit - 0.25;
    case 'bolsterAllyFromSupply':
      return RANK.bolster - 0.25;
    default:
      return undefined;
  }
}

function rankOf(sight: Sight, action: GameAction): number {
  const { view, weights } = sight;

  switch (action.type) {
    case 'control':
    case 'followControl':
      return controlWins(view) ? RANK.winningControl : RANK.control;
    case 'deploy':
      return RANK.deploy;
    case 'bolster':
    case 'followBolster': {
      // "The AI will never bolster its own unit", with the Knight exception.
      const hex = action.type === 'bolster' ? action.at : action.hex;
      return bolsterOpensAKnight(sight, hex) ? RANK.bolsterForKnight : RANK.bolster;
    }
    case 'recruit':
    case 'followRecruit':
      return RANK.recruit;
    case 'claimInitiative':
      return RANK.initiative;
    case 'pass':
      return RANK.pass;
    case 'skip':
      return skipRank(sight);
    case 'proclaim':
    case 'followProclaim':
      return RANK.proclaim;
    // Housekeeping the solo chart has no equivalent for: lifting a poison
    // counter, handing a Decoy back, raising a fortification, spying.
    case 'unpoison':
    case 'returnDecoy':
    case 'followBuildFort':
    case 'followBurn':
    case 'followDeceive':
    case 'followReinforce':
    case 'followSpy':
    case 'followLift':
    case 'followShove':
    case 'followRepeat':
      return RANK.cleanup;
    case 'draft':
    case 'ban':
      return RANK.draft;
    default:
      break;
  }

  if (attackTargetOf(action) !== undefined) {
    return weights.attackBeforeControl ? RANK.attack : RANK.control + 0.5;
  }
  if (destinationOf(action) !== undefined) return RANK.move;
  const bare = bareTacticRank(sight, action);
  if (bare !== undefined) return bare;
  return RANK.cleanup;
}

/**
 * Skipping is normally the last resort. The exception is the chart's Swordsman
 * note: having attacked, it moves on *unless it already stands on a neutral or
 * enemy location* — a hex worth holding is not worth walking off.
 */
function skipRank(sight: Sight): number {
  const step = sight.view.pending[sight.view.pending.length - 1];
  if (step?.kind !== 'optionalMove') return RANK.pass;
  const owner = sight.view.units[step.hex];
  if (!owner || owner.team !== sight.sense.me) return RANK.pass;
  const worthHolding =
    sight.sense.neutral.includes(step.hex) || sight.sense.enemy.includes(step.hex);
  return worthHolding ? RANK.winningControl : RANK.pass;
}

// ---------------------------------------------------------------------------
// Choosing within a drawer: the chart's priority lists
// ---------------------------------------------------------------------------

function refine(sight: Sight, rank: number, pool: readonly GameAction[]): readonly GameAction[] {
  if (pool.length <= 1 || sight.weights.quick) return pool;
  if (rank === RANK.attack || rank === RANK.control + 0.5) return chooseAttack(sight, pool);
  if (rank === RANK.deploy) return chooseDeploy(sight, pool);
  if (rank === RANK.move) return chooseMove(sight, pool);
  if (rank === RANK.recruit) return chooseRecruit(sight, pool);
  return pool;
}

/**
 * AI Attack, priorities as printed:
 *   1. Adjacent unit  2. Unit on a friendly location  3. on an enemy location
 *   4. on a neutral location  5. closest to the centre hex
 */
function chooseAttack(sight: Sight, pool: readonly GameAction[]): readonly GameAction[] {
  const { sense, weights } = sight;
  const target = (a: GameAction) => attackTargetOf(a) as HexId;
  const toCentre = (hex: HexId) => distanceTo(sight, 'centre', () => [sense.centre], hex);

  const criteria = [
    (cs: readonly GameAction[]) =>
      cs.filter((a) => {
        const from = originOf(a);
        return from !== undefined && distance(fromId(from), fromId(target(a))) === 1;
      }),
    (cs: readonly GameAction[]) => cs.filter((a) => sense.friendly.includes(target(a))),
    (cs: readonly GameAction[]) => cs.filter((a) => sense.enemy.includes(target(a))),
    (cs: readonly GameAction[]) => cs.filter((a) => sense.neutral.includes(target(a))),
    (cs: readonly GameAction[]) => smallest(cs, (a) => toCentre(target(a))),
  ];

  // A knob, not the chart: finishing a stack off takes a unit out of the game,
  // and the printed list is blind to how much is left standing on the hex.
  if (weights.preferKills) {
    criteria.unshift((cs: readonly GameAction[]) =>
      cs.filter((a) => (sight.view.units[target(a)]?.coins ?? 99) === 1),
    );
  }
  return byPriority(pool, criteria);
}

/**
 * AI Deployment, priorities as printed:
 *   1. Closest to a neutral/enemy location  2. Closest to an enemy location
 *   3. Closest to an enemy-occupied location  4. Closest to the centre hex
 */
function chooseDeploy(sight: Sight, pool: readonly GameAction[]): readonly GameAction[] {
  const { sense } = sight;
  const to = (a: GameAction) => destinationOf(a) as HexId;

  return byPriority(pool, [
    (cs) => smallest(cs, (a) => distanceTo(sight, 'contested', () => [...sense.neutral, ...sense.enemy], to(a))),
    (cs) => smallest(cs, (a) => distanceTo(sight, 'enemyLocations', () => sense.enemy, to(a))),
    (cs) => smallest(cs, (a) => distanceTo(sight, 'enemyOccupied', () => sense.enemyOccupied, to(a))),
    (cs) => smallest(cs, (a) => distanceTo(sight, 'centre', () => [sense.centre], to(a))),
  ]);
}

/**
 * AI Movement. The chart picks a target location per unit, then steps toward it:
 *   Target:  1. Closest location  2. Enemy location  3. Enemy-occupied
 *            4. Location closest to the centre hex
 *   Step:    1. Hex closest to another enemy location  2. …to another neutral
 *            location  3. …to an enemy unit  4. …to the centre hex
 */
function chooseMove(sight: Sight, pool: readonly GameAction[]): readonly GameAction[] {
  const { sense } = sight;
  const to = (a: GameAction) => destinationOf(a) as HexId;

  const targets = new Map<HexId | 'none', HexId | undefined>();
  const targetFor = (a: GameAction): HexId | undefined => {
    const origin = originOf(a) ?? 'none';
    if (!targets.has(origin)) {
      targets.set(origin, origin === 'none' ? undefined : chooseTarget(sight, origin));
    }
    return targets.get(origin);
  };

  return byPriority(pool, [
    (cs) =>
      smallest(cs, (a) => {
        const target = targetFor(a);
        return target === undefined ? 0 : distanceTo(sight, `to:${target}`, () => [target], to(a));
      }),
    (cs) => smallest(cs, (a) => distanceTo(sight, 'enemyLocations', () => sense.enemy, to(a))),
    (cs) => smallest(cs, (a) => distanceTo(sight, 'neutralLocations', () => sense.neutral, to(a))),
    (cs) => smallest(cs, (a) => distanceTo(sight, 'enemyUnits', () => sense.enemyUnits, to(a))),
    (cs) => smallest(cs, (a) => distanceTo(sight, 'centre', () => [sense.centre], to(a))),
  ]);
}

function chooseTarget(sight: Sight, origin: HexId): HexId | undefined {
  const { sense } = sight;
  const candidates = [...sense.enemy, ...sense.neutral];
  if (candidates.length === 0) return undefined;
  const reach = field(sight, `from:${origin}`, () => [origin]);

  return byPriority(candidates, [
    (cs) => smallest(cs, (hex) => reach.get(hex) ?? NOWHERE),
    (cs) => cs.filter((hex) => sense.enemy.includes(hex)),
    (cs) => cs.filter((hex) => sense.enemyOccupied.includes(hex)),
    (cs) => smallest(cs, (hex) => distanceTo(sight, 'centre', () => [sense.centre], hex)),
  ])[0];
}

/**
 * AI Recruitment, priorities as printed:
 *   1. The unit with the most coins left in the supply
 *   2. The unit with the most coins removed from play
 *   3. The unit that was most recently maneuvered
 */
function chooseRecruit(sight: Sight, pool: readonly GameAction[]): readonly GameAction[] {
  const me = sight.view.players[sight.view.you];
  if (!me) return pool;
  const unitOf = (a: GameAction) => ('unit' in a ? (a.unit as UnitId) : undefined);
  const recency = maneuverRecency(sight.view);

  return byPriority(pool, [
    (cs) => largest(cs, (a) => me.supply[unitOf(a) as UnitId] ?? 0),
    (cs) => largest(cs, (a) => me.removed[unitOf(a) as UnitId] ?? 0),
    (cs) => largest(cs, (a) => recency.get(unitOf(a) as UnitId) ?? -1),
  ]);
}

/** How recently each of my unit types acted, read off the shared log. */
function maneuverRecency(view: GameView): Map<UnitId, number> {
  const out = new Map<UnitId, number>();
  view.log.forEach((entry, i) => {
    if (entry.seat !== view.you) return;
    const unit = entry.params.unit;
    if (typeof unit === 'string' && unit in UNITS) out.set(unit as UnitId, i);
  });
  return out;
}

/**
 * Drafting is not in the chart — its AI is dealt a fixed list of seven — and it
 * has never been measured here either, which is a gap the size of the opening:
 * a lobby deals a draft unless it is told otherwise.
 *
 * `coins` is what this always did: take the unit the box prints most of, on the
 * grounds that more coins is more staying power and a bigger share of the bag.
 * `scarcity` is the opposite bet — four-coin units are the short print run, and
 * the box gives the short print run to the units that do more.
 */
function draftPick(
  legal: readonly GameAction[],
  rng: RngState,
  by: 'coins' | 'scarcity' | 'random' | 'measured' | 'measured-all' | 'measured-all-660',
): GameAction {
  // The table the 3600-game count replaced. Here only so that replacing it can
  // be checked by playing the old one against the new, which is the only way a
  // re-measurement gets to claim it changed anything.
  if (by === 'measured-all-660') {
    const pool = largest(legal, (a) => ('unit' in a ? (MEASURED_VALUE_ALL_660[a.unit as UnitId] ?? 0.5) : 0));
    return pool[nextInt(rng, pool.length)] as GameAction;
  }
  if (by === 'random') return legal[nextInt(rng, legal.length)] as GameAction;
  if (by === 'measured-all') {
    const pool = largest(legal, (a) => ('unit' in a ? (MEASURED_VALUE_ALL[a.unit as UnitId] ?? 0.5) : 0));
    return pool[nextInt(rng, pool.length)] as GameAction;
  }
  if (by === 'measured') {
    // A unit nobody measured — an expansion this table does not cover — counts
    // as average rather than as worthless.
    const pool = largest(legal, (a) => ('unit' in a ? (MEASURED_VALUE[a.unit as UnitId] ?? 0.5) : 0));
    return pool[nextInt(rng, pool.length)] as GameAction;
  }
  const coins = (a: GameAction) => ('unit' in a ? UNITS[a.unit as UnitId].coins : 0);
  const pool = by === 'coins' ? largest(legal, coins) : smallest(legal, (a) => coins(a) || 99);
  return pool[nextInt(rng, pool.length)] as GameAction;
}
