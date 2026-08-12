/**
 * Plays games across the machine's cores instead of one at a time.
 *
 * Stage 8 of the roadmap is a long run of matches, and a match of several
 * hundred games at a realistic thinking budget is an hour on one core and a few
 * minutes on twelve. Running them one after another was leaving thirteen
 * fourteenths of the machine idle.
 *
 * **A note on time budgets.** Bots think for a wall-clock allowance, so a core
 * they have to share is a core that thinks less. The default leaves two cores
 * free for the operating system and this process, and both sides of a match
 * always run under the same conditions — so a comparison stays fair even when
 * the absolute strength is a little lower than a bot on an idle machine.
 */

import { existsSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import type { DraftMode, UnitSet } from '@wc/shared';
import type { GameOutcome } from './arena.js';
import type { BotSpec } from './bot-spec.js';
import type { GameReply, GameRequest } from './game-worker.js';

export interface MatchOptions {
  readonly sets?: readonly UnitSet[];
  readonly draftMode?: DraftMode;
  readonly maxPlies?: number;
  readonly budgetMs?: number;
  /** B's clock, when a ladder wants the two sides to think for different times. */
  readonly budgetMsB?: number;
  /** Games in flight at once. Defaults to the cores that are going spare. */
  readonly jobs?: number;
}

export interface PairRequest {
  readonly pair: number;
  readonly seed: number;
}

export function defaultJobs(): number {
  return Math.max(1, availableParallelism() - 2);
}

/**
 * The worker always runs from the build, never from the sources.
 *
 * Node strips types but does not rewrite import specifiers, so a worker started
 * from `src/game-worker.ts` would look for `./arena.js` next to it and find
 * nothing. The CLIs run from `dist` anyway; this only matters under the test
 * runner, which is why the package builds before it tests.
 */
function workerUrl(): URL {
  const here = import.meta.url;
  if (!here.endsWith('.ts')) return new URL('./game-worker.js', here);
  const built = new URL('../dist/game-worker.js', here);
  if (!existsSync(built)) {
    throw new Error('the match pool needs @wc/tooling built: run `npm run build -w @wc/tooling`');
  }
  return built;
}

export class MatchPool {
  private readonly workers: Worker[] = [];
  private readonly idle: Worker[] = [];
  private readonly waiting: ((worker: Worker) => void)[] = [];
  private readonly jobs: number;
  private nextId = 1;

  constructor(
    private readonly a: BotSpec,
    private readonly b: BotSpec,
    private readonly opts: MatchOptions = {},
  ) {
    this.jobs = opts.jobs ?? defaultJobs();
  }

  /**
   * Plays a batch of pairs — both halves of each, sides swapped — and returns
   * the outcomes in the order the pairs were given, however they finished.
   */
  async playPairs(pairs: readonly PairRequest[]): Promise<GameOutcome[][]> {
    const results = await Promise.all(
      pairs.flatMap((pair) =>
        ([0, 1] as const).map(async (aSeat) => ({
          pair: pair.pair,
          aSeat,
          outcome: await this.play(pair, aSeat),
        })),
      ),
    );

    const byPair = new Map<number, GameOutcome[]>();
    for (const { pair, aSeat, outcome } of results) {
      const list = byPair.get(pair) ?? [];
      list[aSeat] = outcome;
      byPair.set(pair, list);
    }
    return pairs.map((p) => byPair.get(p.pair) as GameOutcome[]);
  }

  /**
   * Plays pairs continuously, handing each one back the moment it lands.
   *
   * `playPairs` is a barrier: it returns when the last game of the batch is
   * done, so a single long game leaves every other worker idle until it
   * finishes. That was measured costing eleven idle cores for minutes at a
   * time. Here every finished game frees its slot at once and the next one
   * starts — utilisation went from 101% of a core during a long game, and 831%
   * with whole pairs in flight, to a steady 1210%.
   *
   * It also stops sooner. `keepGoing` is asked before every new pair, so a
   * sequential test ends on the pair that decided it rather than at the end of
   * whatever batch that pair happened to be in.
   *
   * Pairs arrive in whatever order they finish. That is fine for everything
   * here: a pair is self-contained, and the statistics are over a set.
   */
  async playStream(
    nextPair: () => PairRequest | null,
    onPair: (halves: GameOutcome[], pair: PairRequest) => void,
    keepGoing: () => boolean,
  ): Promise<void> {
    // Games, not pairs. A pair is two games and they rarely take the same time,
    // so keeping *pairs* in flight leaves a worker idle whenever one half
    // outlives the other — measured at about a third of the machine. Halves are
    // dispatched independently and matched up as they land.
    const running = new Set<Promise<void>>();
    const halves = new Map<number, GameOutcome[]>();
    let queued: { pair: PairRequest; aSeat: 0 | 1 } | null = null;

    const nextGame = (): { pair: PairRequest; aSeat: 0 | 1 } | null => {
      if (queued) {
        const game = queued;
        queued = null;
        return game;
      }
      const pair = nextPair();
      if (!pair) return null;
      queued = { pair, aSeat: 1 };
      return { pair, aSeat: 0 };
    };

    const start = (game: { pair: PairRequest; aSeat: 0 | 1 }): void => {
      const task = (async () => {
        const outcome = await this.play(game.pair, game.aSeat);
        const both = halves.get(game.pair.pair) ?? [];
        both[game.aSeat] = outcome;
        halves.set(game.pair.pair, both);
        if (both[0] && both[1]) {
          halves.delete(game.pair.pair);
          onPair([both[0], both[1]], game.pair);
        }
      })().finally(() => running.delete(task));
      running.add(task);
    };

    const fill = (): void => {
      while (running.size < this.jobs) {
        // A half already dealt out is always finished, verdict or no verdict:
        // half a pair scores nothing, so stopping there would be a game played
        // for nothing. A *new* pair, on the other hand, is not started once the
        // caller has said stop.
        if (!queued && !keepGoing()) break;
        const game = nextGame();
        if (!game) break;
        start(game);
      }
    };

    fill();
    while (running.size > 0) {
      await Promise.race(running);
      fill();
    }
  }

  async close(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.terminate()));
    this.workers.length = 0;
    this.idle.length = 0;
  }

  private async play(pair: PairRequest, aSeat: 0 | 1): Promise<GameOutcome> {
    const worker = await this.claim();
    const request: GameRequest = {
      id: this.nextId++,
      a: this.a,
      b: this.b,
      aSeat,
      seed: pair.seed,
      pair: pair.pair,
      sets: this.opts.sets ?? [],
      draftMode: this.opts.draftMode ?? 'random',
      maxPlies: this.opts.maxPlies ?? 4000,
      budgetMs: this.opts.budgetMs ?? 0,
      ...(this.opts.budgetMsB !== undefined ? { budgetMsB: this.opts.budgetMsB } : {}),
    };

    try {
      return await new Promise<GameOutcome>((resolve, reject) => {
        const onMessage = (reply: GameReply) => {
          if (reply.id !== request.id) return;
          cleanup();
          if ('error' in reply) reject(new Error(reply.error));
          else resolve(reply.outcome);
        };
        const onError = (err: Error) => {
          cleanup();
          reject(err);
        };
        const cleanup = () => {
          worker.off('message', onMessage);
          worker.off('error', onError);
        };
        worker.on('message', onMessage);
        worker.on('error', onError);
        worker.postMessage(request);
      });
    } finally {
      this.release(worker);
    }
  }

  private claim(): Promise<Worker> {
    const free = this.idle.pop();
    if (free) return Promise.resolve(free);
    if (this.workers.length < this.jobs) {
      const worker = new Worker(workerUrl());
      this.workers.push(worker);
      return Promise.resolve(worker);
    }
    return new Promise<Worker>((resolve) => this.waiting.push(resolve));
  }

  private release(worker: Worker): void {
    const next = this.waiting.shift();
    if (next) next(worker);
    else this.idle.push(worker);
  }
}
