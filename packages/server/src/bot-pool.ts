/**
 * A small pool of worker threads that choose moves.
 *
 * The reason it exists is capacity, not speed. Hard thinks for a second, and a
 * second spent thinking on the main thread is a second in which every other
 * game — including every human-versus-human game — is served nothing. So the
 * search runs off the event loop, no more than `limit` of them at a time, and
 * a search that overruns its deadline is killed rather than waited for.
 *
 * Workers are started once and reused: spawning one costs far more than the
 * move it would compute.
 */

import { Worker } from 'node:worker_threads';
import { bestOf, mergeReports, type RootStat } from '@wc/bots';
import type { BotLevel, GameAction, GameView } from '@wc/shared';
import { LEVEL_PLAN, type BotRequest, type BotResponse } from './bot-worker.js';

export interface BotPoolOptions {
  /** Searches running at once. The rest queue. */
  readonly limit: number;
  /** A move that takes longer than this is abandoned and the worker replaced. */
  readonly deadlineMs: number;
  /**
   * How many workers one move may use at once.
   *
   * A search used one core and left the other eleven idle. Root parallelism
   * fixes that without a shared tree: several workers search the same position
   * from different seeds and their visit counts are added up. It buys about
   * 1.2× the search and some 13 Elo — measured, and a fifth of what the
   * literature promised. See `mergeReports`.
   *
   * It is deliberately *opportunistic* — a move takes as many workers as happen
   * to be free and never fewer than one. A quiet server puts the whole machine
   * behind one move; a busy one degrades to what it did before, which is the
   * right way round. Fanning out to a fixed number would put sub-jobs in the
   * queue behind each other, and a move whose halves run in sequence takes twice
   * as long rather than thinking twice as hard.
   */
  readonly threads?: number;
}

interface Job {
  readonly request: BotRequest;
  readonly resolve: (response: { action: GameAction; roots?: readonly RootStat[] }) => void;
  readonly reject: (err: Error) => void;
}

interface Slot {
  worker: Worker;
  job: Job | null;
  timer: ReturnType<typeof setTimeout> | null;
  /** Set when we are the ones killing it, so its exit is not read as a crash. */
  retiring: boolean;
}

/**
 * In production the server runs its compiled `dist`; in development it runs the
 * TypeScript sources directly under `--experimental-strip-types`. The worker
 * has to be whichever this file is.
 */
function workerUrl(): URL {
  const here = import.meta.url;
  return new URL(here.endsWith('.ts') ? './bot-worker.ts' : './bot-worker.js', here);
}

export class BotPool {
  private readonly slots: Slot[] = [];
  private readonly queue: Job[] = [];
  private nextId = 1;
  private stopped = false;

  constructor(
    private readonly opts: BotPoolOptions,
    private readonly onError: (err: unknown) => void = () => {},
  ) {}

  /**
   * Asks for a move. Rejects on timeout, on a worker crash, or after `stop`.
   *
   * One call may become several searches of the same position — see `threads`.
   * They are merged by visit count, and a search that missed its deadline is
   * simply left out: losing one of six is a slightly smaller search, where
   * losing the only one is a lost move.
   */
  async choose(level: BotLevel, view: GameView, seed: number, budgetMs = 0): Promise<GameAction> {
    if (this.stopped) return Promise.reject(new Error('bot pool is stopped'));
    // Whether to fan out is decided by the level, not by what comes back. Asking
    // and *then* deciding would mean awaiting the first search before starting
    // the others — two searches in sequence, which is twice the wait and none of
    // the benefit. Only a searching level has statistics to add up.
    const want =
      LEVEL_PLAN[level]?.bot === 'ismcts'
        ? Math.max(1, Math.min(this.opts.threads ?? 1, this.free()))
        : 1;
    if (want <= 1) return (await this.one(level, view, seed, budgetMs)).action;

    // Seeds a prime apart, so no two workers walk the same determinizations.
    const answers = await Promise.allSettled(
      Array.from({ length: want }, (_, i) => this.one(level, view, seed + i * 7919, budgetMs)),
    );
    const searched: RootStat[][] = [];
    for (const a of answers) if (a.status === 'fulfilled' && a.value.roots) searched.push([...a.value.roots]);
    if (searched.length > 0) return bestOf(mergeReports(searched)).action;

    // Nothing came back with a tree. A move without statistics is still a move;
    // failing outright is the last resort, and it carries the real reason.
    const plain = answers.find((a) => a.status === 'fulfilled');
    if (plain?.status === 'fulfilled') return plain.value.action;
    const failed = answers.find((a) => a.status === 'rejected');
    throw failed?.status === 'rejected' ? failed.reason : new Error('no bot answered');
  }

  /** Workers that could start a search this instant, spawned or not yet. */
  private free(): number {
    const idle = this.slots.filter((s) => s.job === null).length;
    return idle + Math.max(0, this.opts.limit - this.slots.length);
  }

  private one(
    level: BotLevel,
    view: GameView,
    seed: number,
    budgetMs: number,
  ): Promise<{ action: GameAction; roots?: readonly RootStat[] }> {
    return new Promise((resolve, reject) => {
      this.queue.push({
        request: { id: this.nextId++, level, view, seed, budgetMs },
        resolve,
        reject,
      });
      this.pump();
    });
  }

  /** Workers started so far. Only a test has any business reading it. */
  get spawned(): number {
    return this.slots.length;
  }

  get busy(): number {
    return this.slots.filter((s) => s.job !== null).length;
  }

  get waiting(): number {
    return this.queue.length;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const job of this.queue.splice(0)) job.reject(new Error('bot pool is stopping'));
    await Promise.all(
      this.slots.map(async (slot) => {
        if (slot.timer) clearTimeout(slot.timer);
        slot.retiring = true;
        slot.job?.reject(new Error('bot pool is stopping'));
        await slot.worker.terminate();
      }),
    );
    this.slots.length = 0;
  }

  private pump(): void {
    while (this.queue.length > 0) {
      const slot = this.freeSlot();
      if (!slot) return;
      const job = this.queue.shift() as Job;
      slot.job = job;
      slot.timer = setTimeout(() => this.timeout(slot), this.opts.deadlineMs);
      slot.worker.postMessage(job.request);
    }
  }

  private freeSlot(): Slot | null {
    const idle = this.slots.find((s) => s.job === null);
    if (idle) return idle;
    if (this.slots.length >= this.opts.limit) return null;
    const slot: Slot = { worker: this.spawn(), job: null, timer: null, retiring: false };
    this.slots.push(slot);
    return slot;
  }

  private spawn(): Worker {
    const worker = new Worker(workerUrl(), {
      // Development runs from `.ts`, which the worker needs the same permission
      // to read as the main thread had.
      ...(workerUrl().pathname.endsWith('.ts')
        ? { execArgv: ['--experimental-strip-types', '--disable-warning=ExperimentalWarning'] }
        : {}),
    });
    worker.on('message', (response: BotResponse) => this.answer(worker, response));
    worker.on('error', (err) => this.crash(worker, err));
    worker.on('exit', (code) => {
      const slot = this.slots.find((s) => s.worker === worker);
      if (code !== 0 && slot && !slot.retiring) {
        this.crash(worker, new Error(`bot worker exited with ${code}`));
      }
    });
    worker.unref(); // a thinking bot must not keep the process alive on shutdown
    return worker;
  }

  private answer(worker: Worker, response: BotResponse): void {
    const slot = this.slots.find((s) => s.worker === worker);
    const job = slot?.job;
    if (!slot || !job || job.request.id !== response.id) return; // a late reply
    this.release(slot);
    if ('error' in response) job.reject(new Error(response.error));
    else job.resolve({ action: response.action, ...(response.roots ? { roots: response.roots } : {}) });
    this.pump();
  }

  private timeout(slot: Slot): void {
    const job = slot.job;
    this.release(slot);
    // A worker that blew its deadline is stuck inside a search; there is no way
    // to interrupt it from here, so it goes and a fresh one takes its place.
    slot.retiring = true;
    void slot.worker.terminate().catch(this.onError);
    this.slots.splice(this.slots.indexOf(slot), 1);
    job?.reject(new Error('bot timed out'));
    this.pump();
  }

  private crash(worker: Worker, err: Error): void {
    const slot = this.slots.find((s) => s.worker === worker);
    if (!slot) return;
    const job = slot.job;
    this.release(slot);
    this.slots.splice(this.slots.indexOf(slot), 1);
    job?.reject(err);
    this.onError(err);
    this.pump();
  }

  private release(slot: Slot): void {
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = null;
    slot.job = null;
  }
}
