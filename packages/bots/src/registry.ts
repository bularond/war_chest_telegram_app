/**
 * Every bot the arena and the server can ask for by name.
 *
 * The `heuristic-*` entries are the same bot with the two undecided knobs
 * flipped. They exist to be played off against each other; once the arena has
 * an answer, the winner becomes `heuristic` and the losers can go.
 */

import { GreedyBot, RandomBot } from './baseline.js';
import { createHeuristicBot, DEFAULT_WEIGHTS, HeuristicBot } from './heuristic.js';
import { createSearchBot, SearchBot } from './ismcts.js';
import type { Bot } from './types.js';

const QUICK_POLICY = createHeuristicBot(
  { ...DEFAULT_WEIGHTS, quick: true },
  'heuristic-quick',
);

export const BOTS: Readonly<Record<string, Bot>> = {
  random: RandomBot,
  greedy: GreedyBot,
  heuristic: HeuristicBot,
  'heuristic-control': createHeuristicBot(
    { ...DEFAULT_WEIGHTS, attackBeforeControl: false },
    'heuristic-control',
  ),
  'heuristic-kills': createHeuristicBot(
    { ...DEFAULT_WEIGHTS, preferKills: true },
    'heuristic-kills',
  ),
  'heuristic-control-kills': createHeuristicBot(
    { ...DEFAULT_WEIGHTS, attackBeforeControl: false, preferKills: true },
    'heuristic-control-kills',
  ),
  /** The heuristic without its priority lists — a rollout policy, not a level. */
  'heuristic-quick': QUICK_POLICY,
  ismcts: SearchBot,
  'ismcts-quick': createSearchBot({ rolloutBot: QUICK_POLICY }, 'ismcts-quick'),
  // Fixed iteration counts, for measuring how strength grows with thinking.
  'ismcts-200': createSearchBot({ iterations: 200 }, 'ismcts-200'),
  'ismcts-2000': createSearchBot({ iterations: 2000 }, 'ismcts-2000'),
};

/**
 * Which build of the bots this is. Written into the log of every game against
 * the computer, so a win rate can be traced back to what was actually playing.
 * Bump it whenever a bot's behaviour changes; stage 8 replaces it with the
 * version of the evaluation weights file.
 *
 * `@6` drafts by a table that covers all 28 units rather than the 16 of the base
 * box: +53 Elo in games with the expansions out, where twelve units used to be
 * treated as merely average.
 *
 * `@5` drafts by measured unit strength instead of by how many coins of a unit
 * the box contains. +140 Elo, and the biggest single step here by a factor of
 * three — because it is the one part of the game the tuning had never touched:
 * every match before it was played on units dealt by seed, where there is no
 * draft at all.
 *
 * `@4` adds the one evaluation feature that has ever earned its place: coins in
 * hand for units that are not on the board. It is worth +43 Elo, and it was
 * closed as worthless the night before on a stricter definition that fired in
 * one position out of a hundred.
 *
 * `@3` is `@2` with the two numbers the lab of 12 August accepted: the UCB
 * exploration constant and the weight on coins in reserve. Together they scored
 * 60,7% over 428 games against what came before — +76 Elo — and 58,1% over 590
 * games with all three expansions on the table.
 *
 * `@2` plays exactly what `@1` played given the same number of iterations — the
 * change was the distance sweep and the action key, both rewritten to run on
 * numbers instead of hex-id strings, and both held to byte-identical output by a
 * test. But the levels are budgeted in milliseconds, so a search 2,5–3× faster
 * is a different opponent across the table, and the log has to say which one.
 */
export const BOT_BUILD = 'search@6';

export function botNamed(name: string): Bot | undefined {
  return BOTS[name];
}
