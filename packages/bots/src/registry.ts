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
 * `@9` measures each side's closeness to the locations *that side* still needs.
 * `proximity` subtracted the enemy's closeness to **our** list of targets, and
 * that list was "locations we do not control" — so an enemy parked on a marker
 * of its own was charged against us at the maximum, and an enemy walking up to a
 * marker of ours was invisible, our own locations being excluded from the list
 * by construction. Markers flip, and a flip moves the score twice. 424 games,
 * 56.4%, about +45 Elo; the reversal scored 20.0% over 30 games.
 *
 * It came from reading `canControlHere` in the engine. No instrument could have
 * found it — separating power rates the two definitions 2.4 against 2.6, which
 * is to say identical.
 *
 * `@8` drafts by a table re-counted at 3600 games instead of 660. Not a new
 * idea and not an experiment — one estimate of the same quantity replacing a
 * worse one, ±3.0 points against ±7. The ends of the table held (rank
 * correlation 0.870) and the middle moved a long way: the Siege Tower from
 * thirteenth to fifth, the Pikeman from fifth to eleventh, the Swordsman from
 * twenty-sixth to fifteenth. Playing the old table against the new scored 47.4%
 * over 346 games [42.1 … 52.7] — nothing broke, and nothing is claimed beyond
 * that; two tables that agree about most of the pool draft the same much of the
 * time, so there was never much for a match to bite on.
 *
 * It was noticed from outside the instruments. A player watching the bot said it
 * kept drafting Pikemen and then not playing them, and the drafting half of that
 * turned out to be a middling unit sitting fifth on 190 appearances.
 *
 * `@7` puts noise in the rollout: fifteen percent of its plies are played at
 * random rather than by the heuristic. 642 games, 55.6%, +39 Elo, and turning it
 * back off on fresh seeds scored 35.2% over 128. The rollout was the last large
 * part of the search nobody had varied — only its depth had been tuned — and it
 * was reached by instrument rather than by guess: the root holds 19 moves and
 * gets 78 iterations each, so there was never a width problem to solve, while
 * the depth sweep's sharp peak said the leaf is very sensitive to how those
 * plies are played.
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
export const BOT_BUILD = 'search@9';

export function botNamed(name: string): Bot | undefined {
  return BOTS[name];
}
