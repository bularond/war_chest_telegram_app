/**
 * Information Set Monte Carlo Tree Search.
 *
 * The problem MCTS alone cannot handle here: the bot does not know the order of
 * either bag, so it cannot build a tree over states. ISMCTS builds the tree over
 * *information sets* instead — the nodes are "what the player to move knows" —
 * and draws a fresh guess at the hidden cards on every iteration. Over many
 * iterations the guesses average out, and the tree ends up scoring moves rather
 * than luck.
 *
 * One iteration:
 *   1. sample a determinization consistent with everything we can see
 *   2. walk the tree, choosing by UCB among the moves legal in *this* sample
 *   3. add one new node
 *   4. play on with the heuristic for a dozen plies
 *   5. score the position with `evaluate`
 *   6. carry the score back up the path
 *
 * Two details that are easy to get wrong and are what make it ISMCTS rather
 * than MCTS with extra steps:
 *
 * - **Availability, not parent visits.** A move that is only legal in some
 *   determinizations must not be punished for the iterations it sat out, so a
 *   child's exploration term counts how often it was *available*, not how often
 *   its parent was visited (Cowling, Powley & Whitehouse, 2012).
 * - **The tree survives, the sample does not.** The tree is shared across
 *   iterations; the determinization is thrown away at the end of each.
 */

import {
  actingSeat,
  actionKey,
  applyAction,
  isTerminal,
  distinctMoves,
  legalMoves,
  markersRemaining,
  moveKey,
  nextFloat,
  nextInt,
  sampleDeterminization,
  type GameAction,
  type GameState,
  type GameView,
  type RngState,
  type Seat,
} from '@wc/shared';
import { BASE_WEIGHTS, evaluate, type EvalWeights } from './eval.js';
import { HeuristicBot } from './heuristic.js';
import { pickLegal, type Bot, type BotContext } from './types.js';

export interface SearchSettings {
  /** Iterations when no time budget is given. Keeps tests reproducible. */
  readonly iterations: number;
  /** Plies of policy play before the position is scored. */
  readonly rolloutDepth: number;
  /** UCB exploration constant, against values in [-1, 1]. */
  readonly exploration: number;
  /**
   * What an available move nobody has tried yet is worth, before anyone tries
   * it. `Infinity` means "try every move once before revisiting any", which is
   * what this always did.
   *
   * That default was assumed expensive here, on a branching factor of 30 to 80
   * taken from nothing in particular. Measured, it is **19** at the root, and a
   * medium budget buys 1500 iterations — 78 per legal move. There is no width
   * crisis to solve, which is the answer to why five attempts at first play
   * urgency ranged from "no effect" to −517 Elo and none ever helped: the
   * technique is for a search that is starving for depth, and this one is not.
   * Kept at infinity, and kept in the file with its number, so it is not
   * rediscovered a sixth time. See `scripts/search-shape.mjs`.
   *
   * It is compared against the best *observed value* among the moves already in
   * the tree, on the same [-1, 1] scale: 1 is close to the old behaviour, 0 is
   * neutral, below 0 is outright sceptical of a move nobody has looked at.
   *
   * **An untried move is scored, not compared.** It gets this value plus the
   * exploration bonus a once-visited child would get, and then competes in the
   * same UCB it always did. Two earlier formulations failed by comparing the
   * bare threshold against something that already carried a bonus — first
   * against the children's UCB, then against their best mean — and both turned
   * into step functions: no pruning at all above the threshold, total collapse
   * below it. Measured: 25% and 4,8%. The technique was never the problem.
   */
  readonly firstPlay: number;
  /**
   * Roll out until the side to move is the side that moved at the root, up to a
   * few plies past the depth.
   *
   * Without it, a leaf is whatever the fixed depth landed on, and *whose turn it
   * is there* depends on how long the tree descent was. Measured on one
   * position: with no descent the leaf had the opponent to move 76% of the time,
   * with four plies of descent 49%. Every feature that reads differently for the
   * two sides then carries a bias by branch depth rather than by position — the
   * `tempo` term is pure bias, and it lost 51 Elo saying so.
   */
  readonly levelLeaves: boolean;
  readonly weights: EvalWeights;
  /** The policy that plays the rollout out. Cheap beats clever, up to a point. */
  readonly rolloutBot: Bot;
  /**
   * How often the rollout ignores its policy and plays at random instead.
   *
   * The rollout is nearly deterministic: the heuristic keeps its best drawer —
   * a quarter of the legal moves — and draws inside it. So two rollouts from
   * the same leaf tend to play the same game, and their average converges to
   * something that is not the value of the position but the value of *that one
   * line*. More iterations do not fix a bias; they only measure it more
   * precisely.
   *
   * Noise trades away move quality to break that correlation. Which side of the
   * trade wins is not guessable — the depth sweep found a sharp peak at twelve
   * plies, so leaf values are clearly sensitive to how the rollout plays, and
   * that cuts both ways.
   */
  readonly rolloutNoise: number;
  /**
   * Who drafts. The search has no rollout worth running before the bags exist,
   * so the opening is somebody else's problem — but *whose* is a setting, not a
   * constant, because the draft has never been measured and the app deals one
   * in every game.
   */
  readonly draftBot: Bot;
  /**
   * Name an edge by the coin's *unit* rather than by the slot it sits in, and
   * tell the two meanings of `skip` apart. See `moveKey`.
   *
   * **Measured, and it showed nothing.** The reversal — this off, against the
   * shipping bot at 250 ms a move on dealt drafts — scored 48.5% over 454 games,
   * an interval of [43.9 … 53.1] or −42 to +22 Elo. The point estimate leans the
   * right way and the interval swallows it whole.
   *
   * That is an answer and not a failed experiment: the test was written with a
   * 30-Elo threshold, which four hundred games can settle, and separating a
   * 12-Elo effect from zero needs about 3200. So what is known is that this is
   * not worth 30 Elo. What it is worth is not known.
   *
   * On by default anyway, because a search that cannot tell a move from itself
   * is wrong whatever the scoreboard says — 2.1 edges per distinct move means
   * UCB computing its exploration term on a third of the evidence. The knob
   * stays so a longer match can ask again.
   */
  readonly unitKeys: boolean;
  /**
   * Iterations between clock checks. Reading the clock is not free and the
   * answer cannot change much in a handful of iterations.
   */
  readonly checkEvery: number;
}

export const DEFAULT_SEARCH: SearchSettings = {
  iterations: 1500,
  rolloutDepth: 12,
  // 0.9 was chosen by eye when the search was written and never measured. 0.45
  // beat it 55.9% over 490 games (+41 Elo), and the reverse check after the
  // search got three times faster confirmed it the other way round: 0.9 scored
  // 39.1% over 138 games. Less exploring suits a search that gets more
  // iterations, which is the opposite of what one might guess.
  exploration: 0.45,
  firstPlay: Infinity,
  levelLeaves: false,
  weights: BASE_WEIGHTS,
  rolloutBot: HeuristicBot,
  // 642 games, 55.6%, +39 Elo — and confirmed from the other side on fresh
  // seeds, where turning it back off scored 35.2% over 128 games.
  //
  // The size of it is the point. Fifteen percent of plies played at random pays;
  // replacing the priority lists wholesale — the `quick` heuristic, which picks
  // the kind of move and then draws inside it — costs 202 Elo over 42 games. So
  // the rollout cannot be traded for iterations at all, and yet a little
  // decorrelation is worth having. The optimum is narrow and sits near zero.
  rolloutNoise: 0.15,
  draftBot: HeuristicBot,
  unitKeys: true,
  checkEvery: 32,
};

interface Edge {
  readonly action: GameAction;
  visits: number;
  /** Summed score from the point of view of the seat that chose this edge. */
  value: number;
  /** Iterations in which this move was legal at all. */
  availability: number;
  child: Node | null;
}

/**
 * A point in the tree. It carries no seat: who owes the decision here depends on
 * the determinization, not on the node — an attack leads to a step the defender
 * answers only when the defender holds something to answer with, and what they
 * hold is exactly what the search is guessing at. The field existed, was written
 * on the first sample to arrive, and was read by nothing; the seat that matters
 * is read from the state in `iterate`.
 */
interface Node {
  /**
   * Keyed by `moveKey`, which is a number — or by `actionKey`, a string, on the
   * fallback path. One map holds either; what mattered was not building the
   * string, which was 14.8% of a real search.
   */
  readonly edges: Map<string | number, Edge>;
  visits: number;
}

function newNode(): Node {
  return { edges: new Map(), visits: 0 };
}

export function createSearchBot(
  settings: Partial<SearchSettings> = {},
  name = 'ismcts',
): Bot {
  const config: SearchSettings = { ...DEFAULT_SEARCH, ...settings };
  return {
    name,
    chooseMove(view: GameView, ctx: BotContext): GameAction {
      const legal = pickLegal(view);
      if (legal.length === 1) return legal[0] as GameAction;
      // Drafting is a different problem with its own literature; the search has
      // no rollout worth running before the bags exist.
      if (view.phase === 'draft' || view.phase === 'ban') return config.draftBot.chooseMove(view, ctx);
      return search(view, ctx, config);
    },
  };
}

export const SearchBot: Bot = createSearchBot();

/** What one root move was worth, and how much of the budget went into it. */
export interface RootStat {
  readonly action: GameAction;
  /** `moveKey`, so two searches of the same position agree on what to add up. */
  readonly key: string | number;
  readonly visits: number;
  /** Summed score, not averaged: sums are what merge across searches. */
  readonly value: number;
}

export interface SearchReport {
  readonly action: GameAction;
  readonly iterations: number;
  readonly visits: number;
  /** Score of the chosen move, in [-1, 1], from the searching seat's side. */
  readonly value: number;
  /**
   * Every root move the search looked at.
   *
   * Reported because a search that used one core is a search that used one
   * twelfth of the machine. Root parallelism — several independent searches of
   * the same position, their visit counts added up — needs exactly this and
   * nothing else: no shared tree, no locks, no shared memory. It is the weakest
   * of the parallel schemes and the only one that crosses a worker boundary
   * without a rewrite.
   */
  readonly roots: readonly RootStat[];
}

/**
 * Several searches of one position, read as one.
 *
 * Visits and summed values add. The move chosen is the most visited overall,
 * which is the same rule one search uses and for the same reason: a high average
 * over two visits is noise.
 *
 * **Independent searches are worth far less than one search of the same total
 * size, and here the discount is brutal.** Measured over 80 positions against a
 * 40 000-iteration yardstick: eight trees of 1000 iterations are worth about
 * 1167 iterations in one tree. Fifteen per cent, where the literature reports
 * half to two thirds — and the literature is about other games. Three ways of
 * reading the trees were tried, adding up the visits, a majority vote and the
 * mean score per move, and all three agreed with the yardstick on exactly the
 * same 66.3% of positions. The rule is not what fails.
 *
 * The reason is worth more than the number. Averaging eight independent
 * estimates should cut the spread by √8; it cut almost nothing. So what the
 * trees carry is not noise but *bias* — they share an evaluation and a rollout
 * policy, they make the same mistake, and adding up the same mistake eight times
 * changes nothing. It is the same finding as «the rollout cannot be removed»
 * arriving from the other side: what binds this search is the value at the leaf.
 *
 * So this is worth about 1.2× the search, or some 13 Elo at 50 Elo a doubling.
 * It is kept because it is free — the workers were idle — and not because it is
 * much. `scripts/root-parallel.mjs` re-measures it.
 *
 * A caller may hand in fewer searches than it asked for: one that missed its
 * deadline is dropped and the rest still answer, which is better than the move
 * failing. It takes the root lists and nothing else, because that is all it
 * reads — a wrapper carrying an `action` and a `visits` beside them would be two
 * fields that mean nothing here and look as though they did.
 */
export function mergeReports(searches: readonly (readonly RootStat[])[]): RootStat[] {
  const total = new Map<string | number, { action: GameAction; visits: number; value: number }>();
  for (const roots of searches) {
    for (const root of roots) {
      const seen = total.get(root.key);
      if (seen) {
        seen.visits += root.visits;
        seen.value += root.value;
      } else {
        total.set(root.key, { action: root.action, visits: root.visits, value: root.value });
      }
    }
  }
  if (total.size === 0) throw new Error('nothing to merge: no search returned a root move');
  return [...total.entries()].map(([key, r]) => ({ key, ...r }));
}

/** The move a merged search settles on: the most visited, as one search does. */
export function bestOf(roots: readonly RootStat[]): RootStat {
  let best = roots[0];
  if (!best) throw new Error('no root move to choose from');
  for (const root of roots) if (root.visits > best.visits) best = root;
  return best;
}

/** The search proper. Exposed for the arena and for tests that want the counts. */
export function runSearch(
  view: GameView,
  ctx: BotContext,
  config: SearchSettings = DEFAULT_SEARCH,
): SearchReport {
  const root = newNode();
  const now = ctx.now ?? (() => performance.now());
  const deadline = ctx.budget.ms === undefined ? Infinity : now() + ctx.budget.ms;
  const cap = ctx.budget.ms === undefined ? (ctx.budget.iterations ?? config.iterations) : Infinity;

  let iterations = 0;
  while (iterations < cap) {
    if (iterations % config.checkEvery === 0 && now() >= deadline) break;
    iterate(root, view, ctx.rng, config);
    iterations++;
  }

  // The most visited move, not the highest scoring one: a high average over two
  // visits is noise, and the visit count is what the search actually trusted.
  let best: Edge | null = null;
  const roots: RootStat[] = [];
  for (const [key, edge] of root.edges) {
    roots.push({ action: edge.action, key, visits: edge.visits, value: edge.value });
    if (!best || edge.visits > best.visits) best = edge;
  }
  if (!best) throw new Error('search found no move');
  return {
    action: best.action,
    iterations,
    visits: best.visits,
    value: best.visits === 0 ? 0 : best.value / best.visits,
    roots,
  };
}

function search(view: GameView, ctx: BotContext, config: SearchSettings): GameAction {
  return runSearch(view, ctx, config).action;
}

/**
 * The search never copies a state.
 *
 * `simulate` exists to keep a caller's state untouched, and every caller outside
 * this file needs that. An iteration does not: the determinization it starts
 * from is built fresh from the view, nothing else holds a reference to it, and
 * the tree stores actions rather than positions. So the whole descent and the
 * rollout run on that one object, and the ~15 full copies an iteration used to
 * make — a dozen of them in the rollout alone — are simply not made.
 *
 * What is copied is checked by `sampleDeterminization`: it rebuilds every
 * container the engine writes to. If that ever stops being true, this becomes a
 * way to corrupt the caller's view, so the two belong together.
 */
const NO_CHECK = { validate: false } as const;

/**
 * How this node will name its edges, bound once per descent step.
 *
 * The hand and the pending stack are read here rather than inside the loop over
 * the legal moves: both are the same for every move offered at this point, and
 * the loop runs on every iteration of the search.
 */
function keyer(
  state: GameState,
  acting: Seat,
  config: SearchSettings,
): (action: GameAction) => string | number {
  if (!config.unitKeys) return actionKey;
  const hand = state.players[acting]?.hand;
  const pending = state.pending;
  return (action) => moveKey(action, hand, pending);
}

function iterate(root: Node, view: GameView, rng: RngState, config: SearchSettings): void {
  const state = sampleDeterminization(view, rng);
  /** Edges taken, each with the seat that actually took it in *this* sample. */
  const path: { edge: Edge; seat: Seat }[] = [];
  let node = root;

  // ── walk down, adding at most one node ───────────────────────────────────
  for (;;) {
    if (isTerminal(state)) break;
    const legal = legalMoves(state);
    if (legal.length === 0) break;

    /**
     * Who owes the decision *here, in this determinization*.
     *
     * Not `node.seat`, which is a label written when the node was first created,
     * from whatever sample happened to reach it first. The two can differ: an
     * attack leads to a step the defender answers only when the defender has
     * something to answer with, and what they hold is exactly what the search is
     * guessing at. Using the label threw «not your turn» out of `applyAction` —
     * rarely, and only for whichever branches a given exploration constant
     * happened to walk, which is why it surfaced as two dead experiments rather
     * than as a broken bot.
     */
    const acting = actingSeat(state);
    const key = keyer(state, acting, config);

    /**
     * The edges already in the tree, each paired with the action *as this
     * sample offers it*.
     *
     * The pairing is what makes a merged key safe. An edge stores the action it
     * was created with, and that action names a coin by the slot it sat in
     * several determinizations ago — a slot that now holds something else. Once
     * two slots share one edge, replaying the stored action would be replaying
     * a move nobody offered. So the edge carries the statistics and this
     * sample's list carries the move.
     */
    const known: Edge[] = [];
    const asOffered: GameAction[] = [];
    const fresh: GameAction[] = [];
    // Two coins of one unit make one move offered twice; the second copy has
    // nothing to add to either list.
    const seen = new Set<string | number>();
    for (const action of legal) {
      const name = key(action);
      if (seen.has(name)) continue;
      seen.add(name);
      const edge = node.edges.get(name);
      if (edge) {
        edge.availability++;
        known.push(edge);
        asOffered.push(action);
      } else {
        fresh.push(action);
      }
    }

    // Widen or read on? An untried move is worth `firstPlay`; the tried ones are
    // worth what they have shown. With `firstPlay` at infinity every move gets
    // its first look before any gets a second, which is where this started.
    //
    // The threshold is read without touching `rng`. `selectByUcb` breaks ties by
    // drawing, so asking it here — before it is known whether a move is even
    // being chosen — would pull a number out of the stream and change every game
    // that follows. That is not a bug the tests would have shown as a crash;
    // it showed up as the golden master moving by one visit.
    // An untried move is worth `firstPlay`, plus what any once-looked-at move
    // gets for being barely looked at. That is the same currency the known moves
    // are priced in, which is the whole point.
    const urgency =
      config.firstPlay === Infinity
        ? Infinity
        : config.firstPlay + config.exploration * Math.sqrt(Math.log(Math.max(2, node.visits)));
    if (fresh.length > 0 && urgency >= bestUcb(known, config.exploration)) {
      const action = fresh[nextInt(rng, fresh.length)] as GameAction;
      const edge: Edge = { action, visits: 0, value: 0, availability: 1, child: null };
      node.edges.set(key(action), edge);
      path.push({ edge, seat: acting });
      applyAction(state, acting, action, NO_CHECK);
      break;
    }
    if (known.length === 0) break;

    const chosen = selectByUcb(known, config.exploration, rng);
    const edge = known[chosen] as Edge;
    path.push({ edge, seat: acting });
    applyAction(state, acting, asOffered[chosen] as GameAction, NO_CHECK);
    if (!edge.child) edge.child = newNode();
    node = edge.child;
    node.visits++;
  }

  // ── play on, then score what we ended up with ────────────────────────────
  rollout(state, rng, config.rolloutDepth, config.rolloutBot, config.rolloutNoise, config.unitKeys);
  if (config.levelLeaves) levelOff(state, rng, view, config.rolloutBot);
  const score = evaluate(state, view.you, config.weights);

  // ── carry it back ────────────────────────────────────────────────────────
  root.visits++;
  const myTeam = view.players[view.you]?.team;
  for (const { edge, seat } of path) {
    edge.visits++;
    // The score is written from our side of the table, so an edge chosen by the
    // other side takes the negative of it. Teams, not seats: in a four-player
    // game a partner's good move is our good move too. And the seat is the one
    // that took the edge in this sample, not the one written on the node.
    edge.value += view.players[seat]?.team === myTeam ? score : -score;
  }
}

/** A move's UCB score: what it has been worth, plus what is still unknown about it. */
function ucb(edge: Edge, exploration: number): number {
  if (edge.visits === 0) return Infinity;
  return edge.value / edge.visits + exploration * Math.sqrt(Math.log(edge.availability) / edge.visits);
}

/** The best UCB on offer, without choosing anything and without drawing. */
function bestUcb(edges: readonly Edge[], exploration: number): number {
  let best = -Infinity;
  for (const edge of edges) {
    const score = ucb(edge, exploration);
    if (score > best) best = score;
  }
  return best;
}

/** The index of the chosen edge, so the caller can reach its parallel action. */
function selectByUcb(edges: readonly Edge[], exploration: number, rng: RngState): number {
  let best = -1;
  let bestScore = -Infinity;
  let ties = 0;
  for (let i = 0; i < edges.length; i++) {
    const score = ucb(edges[i] as Edge, exploration);
    if (score > bestScore) {
      bestScore = score;
      best = i;
      ties = 1;
    } else if (score === bestScore) {
      // Reservoir sampling, so equal moves are not decided by iteration order.
      ties++;
      if (nextInt(rng, ties) === 0) best = i;
    }
  }
  if (best < 0) {
    // Every comparison against `NaN` is false, so a single non-finite score
    // leaves nothing chosen. It means the evaluation returned `NaN`, which in
    // practice means a weights file with a missing or non-numeric field — worth
    // saying out loud rather than failing on a null a few lines later.
    throw new Error('no move could be chosen: the evaluation is not a number — check the weights');
  }
  return best;
}

/**
 * Play on with the heuristic, but not to the end: a War Chest game runs for
 * hundreds of plies, and a full rollout would be both slow and mostly noise.
 */
function rollout(
  state: GameState,
  rng: RngState,
  depth: number,
  policy: Bot,
  noise: number,
  unitKeys: boolean,
): void {
  for (let i = 0; i < depth && !isTerminal(state); i++) {
    const seat = actingSeat(state);
    const legal = legalMoves(state);
    if (legal.length === 0) break;
    // No noise means no draw. A search with the knob at zero has to play the
    // game it played before it existed, down to the visit — otherwise every
    // reproducible match becomes incomparable with every one already recorded.
    const action =
      noise > 0 && nextFloat(rng) < noise
        ? drawUniformly(state, seat, legal, rng, unitKeys)
        : policy.chooseMove(searchView(state, seat, legal), { rng, budget: {} });
    applyAction(state, seat, action, NO_CHECK);
  }
}

/**
 * A move drawn at random — over the *moves*, not over the entries in the legal
 * list. The list holds one entry per hand slot, so a move a player can pay for
 * with either of two identical coins sits in it twice and a draw over the list
 * picks it twice as often. That is not noise, it is a preference for moves the
 * player happens to hold spare change for.
 */
function drawUniformly(
  state: GameState,
  seat: Seat,
  legal: readonly GameAction[],
  rng: RngState,
  unitKeys: boolean,
): GameAction {
  if (!unitKeys) return legal[nextInt(rng, legal.length)] as GameAction;
  const moves = distinctMoves(legal, state.players[seat]?.hand, state.pending);
  return moves[nextInt(rng, moves.length)] as GameAction;
}

/**
 * Plays on until the root's side is to move again, so that leaves are
 * comparable with each other. Four plies at most: a position where the turn does
 * not come back round that soon is one where something else is wrong, and an
 * uneven leaf is better than an unbounded rollout.
 */
function levelOff(state: GameState, rng: RngState, view: GameView, policy: Bot): void {
  const want = view.players[view.acting]?.team;
  for (let i = 0; i < 4; i++) {
    if (isTerminal(state)) return;
    const seat = actingSeat(state);
    if (state.players[seat]?.team === want) return;
    const legal = legalMoves(state);
    if (legal.length === 0) return;
    applyAction(state, seat, policy.chooseMove(searchView(state, seat, legal), { rng, budget: {} }), NO_CHECK);
  }
}

/**
 * A `GameView` over a state the search made up, built by sharing rather than
 * copying — `viewFor` deep-copies the board, both discard piles and the log,
 * which costs about as much as the ply it is preparing for.
 *
 * Nothing is hidden here, and nothing needs to be: this is a determinization
 * the search invented, not the real game. Never hand a real `GameState` to it.
 */
function searchView(state: GameState, seat: Seat, legal: readonly GameAction[]): GameView {
  return {
    id: state.id,
    size: state.size,
    phase: state.phase,
    round: state.round,
    turn: state.turn,
    acting: seat,
    you: seat,
    players: state.players.map((p) => ({
      seat: p.seat,
      team: p.team,
      userId: p.userId,
      displayName: p.displayName,
      units: p.units,
      bagCount: p.bag.length,
      handCount: p.hand.length,
      hand: p.hand,
      discard: p.discard,
      supply: p.supply,
      removed: p.removed,
      seals: p.seals,
      markersRemaining: markersRemaining(state, p.team),
      hasInitiative: p.hasInitiative,
    })),
    units: state.units,
    control: state.control,
    pending: state.pending,
    initiativeMovedThisRound: state.initiativeMovedThisRound,
    decrees: state.decrees,
    forts: state.forts,
    fortSupply: state.fortSupply,
    draftMode: state.draftMode,
    sets: state.sets,
    draftPool: state.draftPool,
    banned: state.banned,
    log: state.log,
    winner: state.winner,
    legal,
  };
}
