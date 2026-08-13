/**
 * The bots, kept warm.
 *
 * This used to be a pool of Node worker threads, and the reason it existed was
 * capacity rather than speed: Hard thinks for a second, and a second spent
 * thinking on the main thread is a second in which every other game is served
 * nothing. The search now lives in the native addon, which answers on libuv's
 * threadpool and spreads one move across its own workers, so all of that
 * machinery — spawning, message passing, killing a wedged worker — is gone.
 *
 * What is left is the part that was never about threads:
 *
 * - **A limit.** Several searches at once, each already using the whole machine,
 *   would take longer than the same searches in sequence. Beyond `limit` a move
 *   waits its turn.
 * - **A deadline.** The search checks the clock every thirty-two iterations and
 *   cannot meaningfully overrun, but a call that never comes back at all must
 *   not hold a game open forever.
 *
 * One `Bot` per level, built once. It owns a tree arena per thread, which is the
 * whole reason it is long-lived: rebuilding that per move was most of what the
 * old worker did before it could start thinking.
 */

import { createRequire } from 'node:module';
import type {
  BotLevel,
  GameAction,
  GameView,
} from '@wc/shared';

const require = createRequire(import.meta.url);
const native = require('@wc/core-native') as {
  Bot: new (level: string, threads?: number) => NativeBot;
};

interface NativeBot {
  choose(view: string, seed: number, budgetMs?: number): Promise<string>;
  readonly level: string;
  readonly threads: number;
}

/** What the addon answers with: the move, and what the search thought of each. */
interface BotAnswer {
  readonly action: GameAction;
  readonly roots: readonly { readonly visits: number; readonly value: number }[];
}

export interface BotPoolOptions {
  /** Searches running at once. The rest queue. */
  readonly limit: number;
  /** A move that takes longer than this is abandoned. */
  readonly deadlineMs: number;
  /**
   * How many threads one move may use at once.
   *
   * Root parallelism: several searches of the same position from different
   * seeds, their visit counts added up. It buys about 1.2× the search and some
   * 13 Elo — a fifth of what the literature promised, because the trees share an
   * evaluation and a rollout policy and so make the same mistake. Kept because
   * the cores were idle.
   */
  readonly threads?: number;
}

export class BotPool {
  private readonly bots = new Map<BotLevel, NativeBot>();
  private readonly queue: (() => void)[] = [];
  private running = 0;
  private stopped = false;

  constructor(
    private readonly opts: BotPoolOptions,
    private readonly onError: (err: unknown) => void = () => {},
  ) {}

  /** Asks for a move. Rejects on timeout or after `stop`. */
  async choose(level: BotLevel, view: GameView, seed: number, budgetMs = 0): Promise<GameAction> {
    if (this.stopped) throw new Error('bot pool is stopped');
    await this.acquire();
    try {
      const bot = this.botFor(level);
      // `>>> 0`: the addon takes an unsigned word, and the server derives its
      // seeds by arithmetic that can go negative.
      const answer = bot.choose(JSON.stringify(view), seed >>> 0, budgetMs);
      const parsed = await this.withDeadline(answer);
      return (JSON.parse(parsed) as BotAnswer).action;
    } catch (err) {
      this.onError(err);
      throw err;
    } finally {
      this.release();
    }
  }

  private botFor(level: BotLevel): NativeBot {
    let bot = this.bots.get(level);
    if (!bot) {
      bot = new native.Bot(level, this.opts.threads);
      this.bots.set(level, bot);
    }
    return bot;
  }

  /**
   * The search honours its own budget, so this fires only when something has
   * gone wrong. The promise underneath is left to settle on its own — there is
   * no way to interrupt a native call, and abandoning it is the point.
   */
  private withDeadline<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const guard = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('bot timed out')), this.opts.deadlineMs);
      // A thinking bot must not keep the process alive on shutdown.
      timer.unref?.();
    });
    return Promise.race([promise, guard]).finally(() => {
      if (timer) clearTimeout(timer);
    }) as Promise<T>;
  }

  private acquire(): Promise<void> {
    if (this.running < this.opts.limit) {
      this.running += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.running += 1;
        resolve();
      });
    });
  }

  private release(): void {
    this.running -= 1;
    const next = this.queue.shift();
    if (next) next();
  }

  /** Bots built so far. Only a test has any business reading it. */
  get spawned(): number {
    return this.bots.size;
  }

  get busy(): number {
    return this.running;
  }

  get waiting(): number {
    return this.queue.length;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    // Nothing to terminate: the addon's threads go with the process, and a
    // search in flight settles into a result nobody reads.
    this.queue.length = 0;
    this.bots.clear();
  }
}
