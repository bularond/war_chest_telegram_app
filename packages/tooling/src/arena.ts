/**
 * Bot versus bot, in pairs.
 *
 * Half the variance in War Chest comes from the deal and the draw, not from
 * play. So games are run in pairs: the same seed twice, sides swapped, so both
 * bots get the same units, the same bag order and the same opening. What is
 * left between the two halves of a pair is the play.
 */

import {
  actingSeat,
  applyAction,
  createGame,
  createRng,
  publicStateFor,
  type DraftMode,
  type GameState,
  type Seat,
  type UnitSet,
} from '@wc/shared';
import type { Bot, Budget } from '@wc/bots';
import { scoreStats, type ScoreStats } from './stats.js';

export interface ArenaOptions {
  /** Total games. Rounded up to an even number: pairs are the unit here. */
  readonly games: number;
  readonly seed?: number;
  readonly sets?: readonly UnitSet[];
  /**
   * `random` deals the units from the seed, which keeps the draft out of the
   * measurement. Use `draft` when the drafting itself is what is being tested.
   */
  readonly draftMode?: DraftMode;
  readonly maxPlies?: number;
  readonly budget?: Budget;
  /**
   * What bot B is allowed to think, when it is not the same as A.
   *
   * Two bots on the same budget is what an experiment wants: the only difference
   * on the table should be the change under test. A *ladder* wants the opposite
   * — the difficulty levels of this game differ in nothing but how long they
   * think, so measuring the gap between two levels means giving the two sides
   * different clocks. Defaults to A's, which is every other caller.
   */
  readonly budgetB?: Budget;
  readonly onGame?: (outcome: GameOutcome, index: number) => void;
}

export type GameEnding = 'win' | 'stalemate' | 'plyCap';

export interface GameOutcome {
  readonly pair: number;
  readonly seed: number;
  /** Which seat A played in this half of the pair. */
  readonly aSeat: Seat;
  readonly scoreA: number;
  readonly ending: GameEnding;
  readonly plies: number;
  readonly msA: number;
  readonly msB: number;
  readonly decisionsA: number;
  readonly decisionsB: number;
}

export interface MatchResult {
  readonly a: string;
  readonly b: string;
  readonly games: readonly GameOutcome[];
  /** Per game, a win for A counting 1 and a draw 0.5. */
  readonly perGame: ScoreStats;
  /** Per pair — the honest interval, since the two halves share a deal. */
  readonly perPair: ScoreStats;
  readonly winsA: number;
  readonly winsB: number;
  readonly draws: number;
  readonly plyCapped: number;
  readonly plies: number;
  readonly seconds: number;
  readonly msPerMoveA: number;
  readonly msPerMoveB: number;
}

const DEFAULT_MAX_PLIES = 4000;

/**
 * One game. `aSeat` decides which side bot A sits on; everything else about the
 * game is fixed by the seed, so the two halves of a pair start identically.
 */
export function playGame(a: Bot, b: Bot, aSeat: Seat, seed: number, opts: ArenaOptions): GameOutcome {
  const maxPlies = opts.maxPlies ?? DEFAULT_MAX_PLIES;
  const state: GameState = createGame({
    id: `arena-${seed}-${aSeat}`,
    size: 2,
    seed,
    sets: opts.sets,
    draftMode: opts.draftMode ?? 'random',
    seats: [
      { userId: 's0', displayName: aSeat === 0 ? a.name : b.name },
      { userId: 's1', displayName: aSeat === 0 ? b.name : a.name },
    ],
  });

  // Each side gets its own stream, derived from the game seed, so a rerun of
  // the same match makes the same moves.
  const ctxA = { rng: createRng(seed * 2 + 1), budget: opts.budget ?? {}, now: () => performance.now() };
  const ctxB = {
    rng: createRng(seed * 2 + 2),
    budget: opts.budgetB ?? opts.budget ?? {},
    now: () => performance.now(),
  };

  let plies = 0;
  let msA = 0;
  let msB = 0;
  let decisionsA = 0;
  let decisionsB = 0;

  while (state.phase !== 'finished' && plies < maxPlies) {
    const seat = actingSeat(state);
    const isA = seat === aSeat;
    const bot = isA ? a : b;
    const view = publicStateFor(state, seat);

    const t0 = performance.now();
    const action = bot.chooseMove(view, isA ? ctxA : ctxB);
    const spent = performance.now() - t0;
    if (isA) {
      msA += spent;
      decisionsA++;
    } else {
      msB += spent;
      decisionsB++;
    }

    // The arena owns this state, so it advances in place — no copy per ply.
    applyAction(state, seat, action);
    plies++;
  }

  const ending: GameEnding =
    state.phase !== 'finished' ? 'plyCap' : state.winner === null ? 'stalemate' : 'win';
  // A duel has one player per team, so team and seat coincide.
  const scoreA = state.winner === null ? 0.5 : state.winner === aSeat ? 1 : 0;

  return { pair: 0, seed, aSeat, scoreA, ending, plies, msA, msB, decisionsA, decisionsB };
}

export function runMatch(a: Bot, b: Bot, opts: ArenaOptions): MatchResult {
  const pairs = Math.ceil(opts.games / 2);
  const baseSeed = opts.seed ?? 1;
  const started = performance.now();

  const games: GameOutcome[] = [];
  const pairScores: number[] = [];

  for (let pair = 0; pair < pairs; pair++) {
    const seed = baseSeed + pair;
    const halves: GameOutcome[] = [];
    for (const aSeat of [0, 1] as Seat[]) {
      const outcome = { ...playGame(a, b, aSeat, seed, opts), pair };
      halves.push(outcome);
      games.push(outcome);
      opts.onGame?.(outcome, games.length - 1);
    }
    pairScores.push((halves[0]!.scoreA + halves[1]!.scoreA) / 2);
  }

  return summarize(a.name, b.name, games, pairScores, (performance.now() - started) / 1000);
}

/** The same summary, over games played wherever — one core or twelve. */
export function summarize(
  aName: string,
  bName: string,
  games: readonly GameOutcome[],
  pairScores: readonly number[],
  seconds: number,
): MatchResult {
  const totals = games.reduce(
    (acc, g) => ({
      msA: acc.msA + g.msA,
      msB: acc.msB + g.msB,
      decisionsA: acc.decisionsA + g.decisionsA,
      decisionsB: acc.decisionsB + g.decisionsB,
      plies: acc.plies + g.plies,
    }),
    { msA: 0, msB: 0, decisionsA: 0, decisionsB: 0, plies: 0 },
  );

  return {
    a: aName,
    b: bName,
    games: [...games],
    perGame: scoreStats(games.map((g) => g.scoreA)),
    perPair: scoreStats([...pairScores]),
    winsA: games.filter((g) => g.scoreA === 1).length,
    winsB: games.filter((g) => g.scoreA === 0).length,
    draws: games.filter((g) => g.scoreA === 0.5).length,
    plyCapped: games.filter((g) => g.ending === 'plyCap').length,
    plies: totals.plies,
    seconds,
    msPerMoveA: totals.decisionsA === 0 ? 0 : totals.msA / totals.decisionsA,
    msPerMoveB: totals.decisionsB === 0 ? 0 : totals.msB / totals.decisionsB,
  };
}
