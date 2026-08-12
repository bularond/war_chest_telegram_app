/**
 * What every bot in this project looks like from the outside.
 *
 * A bot is handed a `GameView` — the same redacted state the client gets — and
 * returns one of the actions in `view.legal`. It never sees a `GameState`, so
 * it cannot read a bag or an opponent's hand: to look ahead it has to sample a
 * determinization, exactly as a player guesses.
 */

import type { GameAction, GameView, RngState } from '@wc/shared';

/** How much work a bot may do on one move. A bot may honour either or both. */
export interface Budget {
  /** Wall-clock allowance in milliseconds. */
  readonly ms?: number;
  /** Search iterations, for reproducible runs where time would vary. */
  readonly iterations?: number;
}

export interface BotContext {
  /** All randomness a bot uses comes from here, so matches replay exactly. */
  readonly rng: RngState;
  readonly budget: Budget;
  /** Milliseconds since some fixed point; injected so bots stay pure. */
  readonly now?: () => number;
}

export interface Bot {
  /** Shown in arena output and written into the game log. */
  readonly name: string;
  chooseMove(view: GameView, ctx: BotContext): GameAction;
}

export function pickLegal(view: GameView): readonly GameAction[] {
  if (view.legal.length === 0) throw new Error(`${view.you} has no legal actions`);
  return view.legal;
}
