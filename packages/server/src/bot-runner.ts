/**
 * The computer's turns, taken off the request path.
 *
 * A bot move is a queued task, never a synchronous call inside a message
 * handler. Easy decides in tens of microseconds and Hard thinks for a second;
 * both go the same way, because the difference between them must not be a
 * difference in how the server behaves.
 *
 * The search itself runs in a worker (`bot-pool.ts`) with a hard deadline. If
 * the worker misses it — or dies — the turn falls back to the heuristic in this
 * process. A game must never be left waiting on a bot that will not answer.
 */

import { randomBytes } from 'node:crypto';
import { BOTS } from '@wc/bots';
import {
  applyAction,
  createRng,
  publicStateFor,
  type GameState,
  type RngState,
  type Seat,
} from '@wc/shared';
import { BotPool, type BotPoolOptions } from './bot-pool.js';

export interface BotRunnerOptions extends BotPoolOptions {
  /**
   * How long a turn takes at the least. Not a delay for its own sake: a move
   * that lands the instant you release yours reads as a glitch, and the board
   * needs a beat to be looked at. A search that thinks for longer than this
   * costs nothing extra — the wait is the same wait.
   */
  readonly thinkMs: number;
}

export const DEFAULT_BOT_RUNNER: BotRunnerOptions = {
  limit: 2,
  thinkMs: 600,
  deadlineMs: 5000,
};

/** One game the runner can drive: everything it needs, nothing about lobbies. */
export interface BotSeat {
  readonly key: string;
  readonly state: GameState;
  readonly rng: RngState;
}

/** Looks the table up again at the moment it is needed, never a stale copy. */
export type BotTable = () => BotSeat | null;

export class BotRunner {
  private readonly pending = new Map<string, BotTable>();
  private readonly pool: BotPool;

  constructor(
    private readonly opts: BotRunnerOptions,
    /** Called after the bot has moved, so the new position can be pushed out. */
    private readonly onMoved: (key: string) => void,
    private readonly onError: (key: string, err: unknown) => void,
  ) {
    this.pool = new BotPool(opts, (err) => this.onError('pool', err));
  }

  /**
   * Asks for a bot turn on this table. Safe to call after every action: it does
   * nothing unless a bot actually owes a move, and never queues a table twice.
   */
  schedule(key: string, table: BotTable): void {
    if (this.pending.has(key)) return;
    if (!table()) return;
    this.pending.set(key, table);
    void this.take(key, table);
  }

  async stop(): Promise<void> {
    this.pending.clear();
    await this.pool.stop();
  }

  get busy(): number {
    return this.pool.busy;
  }

  get waiting(): number {
    return this.pool.waiting;
  }

  private async take(key: string, table: BotTable): Promise<void> {
    const started = Date.now();
    let moved = false;
    try {
      const seat = table();
      if (!seat) return;
      const acting = actingBotSeat(seat.state);
      if (acting === null) return;
      const level = seat.state.players[acting]?.bot ?? 'easy';

      const view = publicStateFor(seat.state, acting);
      const seed = nextSeed(seat.rng);
      let action;
      try {
        action = await this.pool.choose(level, view, seed);
      } catch (err) {
        // Timed out, crashed, or shutting down. A game left waiting on a bot is
        // worse than a game where the bot played a simpler move, so it plays one.
        this.onError(key, err);
        action = BOTS.heuristic?.chooseMove(view, { rng: createRng(seed), budget: {} });
        if (!action) return;
      }

      // Let the position be looked at before the answer lands.
      const rest = this.opts.thinkMs - (Date.now() - started);
      if (rest > 0) await sleep(rest);

      // The table is read again here: a minute may have passed, the game may be
      // over, and the action has to be checked against the game as it is now.
      const live = table();
      if (!live || actingBotSeat(live.state) !== acting) return;
      applyAction(live.state, acting, action);
      moved = true;
    } catch (err) {
      this.onError(key, err);
    } finally {
      this.pending.delete(key);
    }

    // Announced only after the table is out of `pending`. Whoever is told about
    // the move will ask for the next one straight away — a card can leave the
    // bot owing a follow-up, and a player out of coins leaves it playing alone —
    // and that request must not bounce off this same turn still being marked
    // in flight.
    if (moved) this.onMoved(key);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The seat that owes a move, if a bot is sitting in it. */
export function actingBotSeat(state: GameState): Seat | null {
  if (state.phase === 'finished') return null;
  const step = state.pending[state.pending.length - 1];
  const seat = step && 'seat' in step ? step.seat : state.turn;
  return state.players[seat]?.bot ? seat : null;
}

/**
 * The bot's own stream: one seed per move, drawn from the table's generator, so
 * a worker gets randomness without the main thread handing over its state.
 */
function nextSeed(rng: RngState): number {
  rng.seed = (rng.seed + 0x6d2b79f5) >>> 0;
  return rng.seed;
}

export function newBotRng(): RngState {
  return createRng(randomBytes(4).readUInt32BE(0));
}
