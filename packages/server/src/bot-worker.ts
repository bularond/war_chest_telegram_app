/**
 * A worker thread that does nothing but choose moves.
 *
 * It is deliberately narrow: in comes a redacted view, out comes an action.
 * It holds no game, writes nothing, and knows no player — so a search that
 * overruns, throws or wedges can be killed without taking a game with it.
 *
 * The pool that talks to it is in `bot-pool.ts`.
 */

import { BOTS, DEFAULT_SEARCH, runSearch, type RootStat } from '@wc/bots';
import { createRng, type BotLevel, type GameAction, type GameView } from '@wc/shared';
import { parentPort } from 'node:worker_threads';

export interface BotRequest {
  readonly id: number;
  readonly level: BotLevel;
  readonly view: GameView;
  readonly seed: number;
  /** Thinking time. Zero means "as long as the level's own default takes". */
  readonly budgetMs: number;
}

export type BotResponse =
  | {
      readonly id: number;
      readonly action: GameAction;
      /**
       * The root statistics, when the level searched at all. The pool adds them
       * up across workers; a level that does not search sends none, and the pool
       * takes its single answer as it stands.
       */
      readonly roots?: readonly RootStat[];
    }
  | { readonly id: number; readonly error: string };

/**
 * What each level plays with, and how long it may think.
 *
 * The budgets are a starting point, not a calibration: roadmap stage 9 sets
 * them against real players. What matters here is only that Medium and Hard
 * differ by thinking time rather than by a different bot, which is what makes
 * a level a level and not a separate personality.
 */
export const LEVEL_PLAN: Readonly<Record<BotLevel, { bot: string; budgetMs: number }>> = {
  easy: { bot: 'heuristic', budgetMs: 0 },
  medium: { bot: 'ismcts', budgetMs: 250 },
  hard: { bot: 'ismcts', budgetMs: 1000 },
};

/**
 * One move, and — when the level searches — what it thought of every root move.
 *
 * The statistics are what makes root parallelism possible: several workers
 * search the same position from different seeds and the pool adds their visit
 * counts up. Nothing is shared between them, which is why this crosses a thread
 * boundary at all.
 *
 * The search is only reached directly for a searching level. A level that has
 * no search — Easy is the heuristic — answers with a move and no statistics,
 * and asking twelve workers for it would be twelve times the same answer.
 */
export function chooseFor(request: BotRequest): { action: GameAction; roots?: readonly RootStat[] } {
  const plan = LEVEL_PLAN[request.level];
  const bot = BOTS[plan.bot] ?? BOTS.heuristic;
  if (!bot) throw new Error(`no bot for level ${request.level}`);
  const budgetMs = request.budgetMs || plan.budgetMs;
  const ctx = {
    rng: createRng(request.seed),
    budget: budgetMs > 0 ? { ms: budgetMs } : {},
    now: () => performance.now(),
  };
  if (plan.bot !== 'ismcts') return { action: bot.chooseMove(request.view, ctx) };

  // The draft is somebody else's problem and has no tree to report.
  const legal = request.view.legal;
  if (legal.length <= 1 || request.view.phase === 'draft' || request.view.phase === 'ban') {
    return { action: bot.chooseMove(request.view, ctx) };
  }
  const report = runSearch(request.view, ctx, DEFAULT_SEARCH);
  return { action: report.action, roots: report.roots };
}

// Kept out of the way of importers: the module is also imported by the pool for
// its types and its level table, and must not start listening there.
if (parentPort) {
  const port = parentPort;
  port.on('message', (request: BotRequest) => {
    try {
      port.postMessage({ id: request.id, ...chooseFor(request) } satisfies BotResponse);
    } catch (err) {
      port.postMessage({
        id: request.id,
        error: err instanceof Error ? err.message : String(err),
      } satisfies BotResponse);
    }
  });
}
