/**
 * How far apart the difficulty levels actually are.
 *
 *   npm run ladder -- --weights weights/lab.json --games 60
 *   npm run ladder -- --budgets 60,250,1000 --games 100
 *
 * Stage 9 is about picking levels, and a level is a thinking budget. This plays
 * the rungs against each other and against the bots that need no budget at all,
 * and prints what separates them.
 *
 * **Why it has to be re-run rather than remembered.** The numbers in
 * `LEVEL_PLAN` were chosen when the search ran two and a half to three times
 * slower. A budget in milliseconds is not a difficulty, it is a difficulty
 * *given how fast the code is* — so every time the engine gets faster, every
 * level gets stronger, and the ladder has to be measured again.
 *
 * **What it cannot tell you.** Nothing here says whether a level is fun. The
 * only thing being measured is one bot against another; where a human sits on
 * this ladder is a question for people playing the game, and stage 9 is where
 * that gets decided. What this gives is the spacing: rungs that are all within
 * a few Elo of each other are not three levels, whatever the menu says.
 *
 * Options:
 *   --weights FILE    the evaluation the search uses   (default weights/base.json)
 *   --knobs JSON      search knobs, as JSON            (default {})
 *   --budgets LIST    milliseconds per move, comma separated (default 60,250,1000)
 *   --games N         games per pairing, rounded to pairs    (default 60)
 *   --against LIST    named bots to measure the rungs against (default heuristic,greedy)
 *   --jobs N          games in flight at once
 */

import { readFileSync } from 'node:fs';
import { BASE_WEIGHTS, type EvalWeights } from '@wc/bots';
import type { BotSpec, SearchKnobs } from './bot-spec.js';
import { summarize } from './arena.js';
import { defaultJobs, MatchPool } from './match-pool.js';
import { eloDiff, percent } from './stats.js';
import { fromInvocation } from './paths.js';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
}

// No file means the ladder the server actually offers. It used to default to
// `weights/base.json`, which is a snapshot of eval@3 and has not been what the
// bot plays since 12 August — so the question "how far apart are the three
// levels" was being answered about a bot nobody meets.
const given = arg('weights', '');
const raw = given
  ? (JSON.parse(readFileSync(fromInvocation(given), 'utf8')) as Record<string, unknown>)
  : {};
// A lab baseline is `{weights, knobs}`; a plain weights file is the weights.
const weights = (raw.weights ?? (given ? raw : BASE_WEIGHTS)) as EvalWeights;
const knobs = (raw.knobs ?? JSON.parse(arg('knobs', '{}'))) as SearchKnobs;
const budgets = arg('budgets', '60,250,1000').split(',').map(Number);
const games = Number(arg('games', '60'));
const against = arg('against', 'heuristic,greedy').split(',').filter(Boolean);
const jobs = Number(arg('jobs', String(defaultJobs())));

const rung = (ms: number): BotSpec => ({ kind: 'search', label: `${ms}ms`, weights, knobs });

/** One pairing, played in pairs, reported as a score for A. */
async function match(a: BotSpec, b: BotSpec, budgetMs: number, seed: number, budgetMsB = budgetMs) {
  const pool = new MatchPool(a, b, { budgetMs, budgetMsB, maxPlies: 4000, jobs });
  const pairs = Math.max(1, Math.ceil(games / 2));
  const outcomes = [];
  const pairScores: number[] = [];
  try {
    const played = await pool.playPairs(
      Array.from({ length: pairs }, (_, i) => ({ pair: i, seed: seed + i })),
    );
    for (const half of played) {
      const [one, two] = half;
      if (!one || !two) continue;
      outcomes.push(one, two);
      pairScores.push((one.scoreA + two.scoreA) / 2);
    }
  } finally {
    await pool.close();
  }
  return summarize('a', 'b', outcomes, pairScores, 0);
}

console.log(`\nladder for ${weights.version} ${JSON.stringify(knobs)}`);
console.log(`  ${games} games a pairing, ${jobs} at a time\n`);

// Each rung against the budget-free bots: this is where a level sits in absolute
// terms, and it is the only part that stays comparable between runs of this
// script, since the named bots do not depend on the clock.
for (const ms of budgets) {
  for (const name of against) {
    const result = await match(rung(ms), { kind: 'named', name }, ms, 1);
    console.log(
      `  ${String(ms).padStart(5)} ms vs ${name.padEnd(10)} ` +
        `${percent(result.perGame.mean)} [${percent(result.perPair.ci95.lo)} … ${percent(result.perPair.ci95.hi)}]` +
        `  ${eloDiff(result.perGame.mean).toFixed(0)} Elo`,
    );
  }
}

// And each rung against the one below it. This is the number that decides
// whether three levels are three levels: the same bot on two clocks, which is
// exactly what the menu offers a player.
console.log();
for (let i = 1; i < budgets.length; i++) {
  const low = budgets[i - 1] as number;
  const high = budgets[i] as number;
  const result = await match(rung(high), rung(low), high, 5000, low);
  console.log(
    `  ${String(high).padStart(5)} ms vs ${String(low).padStart(5)} ms  ` +
      `${percent(result.perGame.mean)} [${percent(result.perPair.ci95.lo)} … ${percent(result.perPair.ci95.hi)}]` +
      `  ${eloDiff(result.perGame.mean).toFixed(0)} Elo apart`,
  );
}
console.log();
