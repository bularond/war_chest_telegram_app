/**
 * The two measuring sticks.
 *
 * Neither is a difficulty level and neither should ever be offered to a player.
 * They exist so that a change to a real bot can be stated as a number: a bot
 * that cannot beat `greedy` by a wide margin has a bug, not a tuning problem.
 */

import { nextInt, type GameAction, type GameView, type HexId } from '@wc/shared';
import { pickLegal, type Bot, type BotContext } from './types.js';

/** Uniform over the legal actions. The floor. */
export const RandomBot: Bot = {
  name: 'random',
  chooseMove(view: GameView, ctx: BotContext): GameAction {
    const legal = pickLegal(view);
    return legal[nextInt(ctx.rng, legal.length)] as GameAction;
  },
};

/**
 * Take a location if one is on offer, otherwise hit something, preferring a hit
 * that destroys. No lookahead, no board sense — it plays the action in front of
 * it. Ties are broken with the context rng so a match is still reproducible.
 */
export const GreedyBot: Bot = {
  name: 'greedy',
  chooseMove(view: GameView, ctx: BotContext): GameAction {
    const legal = pickLegal(view);
    let best: GameAction[] = [];
    let bestScore = -Infinity;
    for (const action of legal) {
      const score = rank(view, action);
      if (score > bestScore) {
        bestScore = score;
        best = [action];
      } else if (score === bestScore) {
        best.push(action);
      }
    }
    return best[nextInt(ctx.rng, best.length)] as GameAction;
  },
};

function target(action: GameAction): HexId | undefined {
  if (action.type === 'attack' || action.type === 'followAttack') return action.to;
  if (action.type === 'tactic') return action.target;
  return undefined;
}

function rank(view: GameView, action: GameAction): number {
  // Claiming a location is the only thing that wins the game.
  if (action.type === 'control' || action.type === 'followControl') return 100;

  const hit = target(action);
  if (hit !== undefined) {
    const stack = view.units[hit];
    // A single-coin stack dies to this hit; a bolstered one only shrinks.
    if (stack && stack.team !== view.players[view.you]?.team) return stack.coins === 1 ? 90 : 70;
    return 60; // a fortification, or a tactic that hits an empty hex
  }

  switch (action.type) {
    case 'deploy':
      return 50;
    case 'move':
    case 'followMove':
    case 'tactic':
      return 40;
    case 'bolster':
      return 30;
    case 'recruit':
    case 'followRecruit':
      return 20;
    case 'draft':
    case 'ban':
      return 10;
    // Discarding a coin facedown does nothing but end the turn.
    case 'pass':
      return 0;
    default:
      return 15;
  }
}

export const BASELINE_BOTS: Readonly<Record<string, Bot>> = {
  random: RandomBot,
  greedy: GreedyBot,
};
