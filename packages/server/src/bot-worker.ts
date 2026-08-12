/**
 * A worker thread that does nothing but choose moves.
 *
 * It is deliberately narrow: in comes a redacted view, out comes an action.
 * It holds no game, writes nothing, and knows no player — so a search that
 * overruns, throws or wedges can be killed without taking a game with it.
 *
 * The pool that talks to it is in `bot-pool.ts`.
 */

import { BOTS } from '@wc/bots';
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
  | { readonly id: number; readonly action: GameAction }
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

export function chooseFor(request: BotRequest): GameAction {
  const plan = LEVEL_PLAN[request.level];
  const bot = BOTS[plan.bot] ?? BOTS.heuristic;
  if (!bot) throw new Error(`no bot for level ${request.level}`);
  const budgetMs = request.budgetMs || plan.budgetMs;
  return bot.chooseMove(request.view, {
    rng: createRng(request.seed),
    budget: budgetMs > 0 ? { ms: budgetMs } : {},
    now: () => performance.now(),
  });
}

// Kept out of the way of importers: the module is also imported by the pool for
// its types and its level table, and must not start listening there.
if (parentPort) {
  const port = parentPort;
  port.on('message', (request: BotRequest) => {
    try {
      port.postMessage({ id: request.id, action: chooseFor(request) } satisfies BotResponse);
    } catch (err) {
      port.postMessage({
        id: request.id,
        error: err instanceof Error ? err.message : String(err),
      } satisfies BotResponse);
    }
  });
}
