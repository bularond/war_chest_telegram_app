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
  legalMoves,
  markersRemaining,
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

interface Node {
  /** Who chooses here. Not always the seat whose turn it is — see `actingSeat`. */
  readonly seat: Seat;
  readonly edges: Map<string, Edge>;
  visits: number;
}

function newNode(seat: Seat): Node {
  return { seat, edges: new Map(), visits: 0 };
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

export interface SearchReport {
  readonly action: GameAction;
  readonly iterations: number;
  readonly visits: number;
  /** Score of the chosen move, in [-1, 1], from the searching seat's side. */
  readonly value: number;
}

/** The search proper. Exposed for the arena and for tests that want the counts. */
export function runSearch(
  view: GameView,
  ctx: BotContext,
  config: SearchSettings = DEFAULT_SEARCH,
): SearchReport {
  const root = newNode(view.acting);
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
  for (const edge of root.edges.values()) {
    if (!best || edge.visits > best.visits) best = edge;
  }
  if (!best) throw new Error('search found no move');
  return {
    action: best.action,
    iterations,
    visits: best.visits,
    value: best.visits === 0 ? 0 : best.value / best.visits,
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

    const known: Edge[] = [];
    const fresh: GameAction[] = [];
    for (const action of legal) {
      const key = actionKey(action);
      const edge = node.edges.get(key);
      if (edge) {
        edge.availability++;
        known.push(edge);
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
      node.edges.set(actionKey(action), edge);
      path.push({ edge, seat: acting });
      applyAction(state, acting, action, NO_CHECK);
      break;
    }
    if (known.length === 0) break;

    const edge = selectByUcb(known, config.exploration, rng);
    path.push({ edge, seat: acting });
    applyAction(state, acting, edge.action, NO_CHECK);
    if (!edge.child) edge.child = newNode(isTerminal(state) ? acting : actingSeat(state));
    node = edge.child;
    node.visits++;
  }

  // ── play on, then score what we ended up with ────────────────────────────
  rollout(state, rng, config.rolloutDepth, config.rolloutBot, config.rolloutNoise);
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

function selectByUcb(edges: readonly Edge[], exploration: number, rng: RngState): Edge {
  let best: Edge | null = null;
  let bestScore = -Infinity;
  let ties = 0;
  for (const edge of edges) {
    const score = ucb(edge, exploration);
    if (score > bestScore) {
      bestScore = score;
      best = edge;
      ties = 1;
    } else if (score === bestScore) {
      // Reservoir sampling, so equal moves are not decided by iteration order.
      ties++;
      if (nextInt(rng, ties) === 0) best = edge;
    }
  }
  if (!best) {
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
function rollout(state: GameState, rng: RngState, depth: number, policy: Bot, noise: number): void {
  for (let i = 0; i < depth && !isTerminal(state); i++) {
    const seat = actingSeat(state);
    const legal = legalMoves(state);
    if (legal.length === 0) break;
    // No noise means no draw. A search with the knob at zero has to play the
    // game it played before it existed, down to the visit — otherwise every
    // reproducible match becomes incomparable with every one already recorded.
    const action =
      noise > 0 && nextFloat(rng) < noise
        ? (legal[nextInt(rng, legal.length)] as GameAction)
        : policy.chooseMove(searchView(state, seat, legal), { rng, budget: {} });
    applyAction(state, seat, action, NO_CHECK);
  }
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
