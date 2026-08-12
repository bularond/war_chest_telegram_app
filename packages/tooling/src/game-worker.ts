/**
 * A worker that plays one game and reports how it went.
 *
 * A game is a pure function of the two bots, the seat assignment and the seed,
 * so games are independent and the machine's cores can have one each. The
 * results are identical to playing them one after another — that is what makes
 * this safe, and `match-pool.test.ts` checks it rather than assuming it.
 */

import { parentPort } from 'node:worker_threads';
import type { DraftMode, UnitSet } from '@wc/shared';
import { playGame, type GameOutcome } from './arena.js';
import { botFromSpec, type BotSpec } from './bot-spec.js';

export interface GameRequest {
  readonly id: number;
  readonly a: BotSpec;
  readonly b: BotSpec;
  readonly aSeat: 0 | 1;
  readonly seed: number;
  readonly pair: number;
  readonly sets: readonly UnitSet[];
  readonly draftMode: DraftMode;
  readonly maxPlies: number;
  readonly budgetMs: number;
  /** B's clock, when the two sides are meant to differ. Defaults to A's. */
  readonly budgetMsB?: number;
}

export type GameReply =
  | { readonly id: number; readonly outcome: GameOutcome }
  | { readonly id: number; readonly error: string };

export function playRequest(request: GameRequest): GameOutcome {
  const outcome = playGame(botFromSpec(request.a), botFromSpec(request.b), request.aSeat, request.seed, {
    games: 2,
    sets: request.sets,
    draftMode: request.draftMode,
    maxPlies: request.maxPlies,
    budget: request.budgetMs > 0 ? { ms: request.budgetMs } : {},
    ...(request.budgetMsB !== undefined && request.budgetMsB > 0
      ? { budgetB: { ms: request.budgetMsB } }
      : {}),
  });
  return { ...outcome, pair: request.pair };
}

if (parentPort) {
  const port = parentPort;
  port.on('message', (request: GameRequest) => {
    try {
      port.postMessage({ id: request.id, outcome: playRequest(request) } satisfies GameReply);
    } catch (err) {
      port.postMessage({
        id: request.id,
        error: err instanceof Error ? (err.stack ?? err.message) : String(err),
      } satisfies GameReply);
    }
  });
}
