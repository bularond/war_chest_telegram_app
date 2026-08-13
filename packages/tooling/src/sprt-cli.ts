/**
 * Runs one experiment on the evaluation weights and reports its verdict.
 *
 *   npm run sprt -- --a weights/base.json --b weights/bolster.json
 *   npm run sprt -- --a weights/base.json --b weights/bolster.json --budget-ms 250 --max-games 2000
 *
 * Both sides get the same thinking time, the same seeds and the same deals; the
 * only difference on the table is the weights file. The match stops itself as
 * soon as the evidence is one-sided, and prints ACCEPT or REJECT — that verdict
 * is the decision. Nothing here is for a human to weigh up afterwards.
 *
 * Options:
 *   --a FILE --b FILE   weight files; B is the change being tested
 *   --budget-ms N       thinking time per move for both sides   (default 100)
 *   --max-games N       stop undecided after this many          (default 1000)
 *   --elo0 / --elo1     hypotheses, in Elo                      (default 0 / 10)
 *   --alpha / --beta    error rates                             (default 0.05)
 *   --sets LIST         expansions, comma separated
 *   --draft MODE        random | draft | ban                    (default random)
 *   --seed N            first pair's seed                       (default 1)
 *   --jobs N            games in flight at once   (default: cores minus two)
 */

import { readFileSync } from 'node:fs';
import type { EvalWeights } from '@wc/bots';
import type { DraftMode, UnitSet } from '@wc/shared';
import type { BotSpec } from './bot-spec.js';
import { defaultJobs, MatchPool } from './match-pool.js';
import { eloDiff, percent, scoreStats } from './stats.js';
import { DEFAULT_SPRT, sprt, type SprtSettings } from './sprt.js';
import { fromInvocation } from './paths.js';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
}

function loadWeights(path: string): EvalWeights {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as EvalWeights;
  if (typeof parsed.version !== 'string') {
    throw new Error(`${path}: a weights file must carry a version`);
  }
  return parsed;
}

const aPath = fromInvocation(arg('a', 'weights/base.json'));
const bPathRaw = arg('b', '');
const bPath = bPathRaw === '' ? '' : fromInvocation(bPathRaw);
if (!bPath) {
  console.error('nothing to test: pass --b <weights file>');
  process.exit(1);
}

const weightsA = loadWeights(aPath);
const weightsB = loadWeights(bPath);
const budgetMs = Number(arg('budget-ms', '100'));
const maxGames = Number(arg('max-games', '1000'));
const setsArg = arg('sets', '');
const sets = setsArg === '' ? [] : (setsArg.split(',') as UnitSet[]);
const settings: SprtSettings = {
  elo0: Number(arg('elo0', String(DEFAULT_SPRT.elo0))),
  elo1: Number(arg('elo1', String(DEFAULT_SPRT.elo1))),
  alpha: Number(arg('alpha', String(DEFAULT_SPRT.alpha))),
  beta: Number(arg('beta', String(DEFAULT_SPRT.beta))),
};

// B is the change under test and plays both sides of every deal.
const specB: BotSpec = { kind: 'search', label: `B ${weightsB.version}`, weights: weightsB };
const specA: BotSpec = { kind: 'search', label: `A ${weightsA.version}`, weights: weightsA };
const jobs = Number(arg('jobs', String(defaultJobs())));
const pool = new MatchPool(specB, specA, {
  sets,
  draftMode: arg('draft', 'random') as DraftMode,
  budgetMs,
  maxPlies: 4000,
  jobs,
});

console.log(`\nSPRT  ${weightsB.version} (B) against ${weightsA.version} (A)`);
console.log(`  H0: +${settings.elo0} Elo   H1: +${settings.elo1} Elo   α=${settings.alpha} β=${settings.beta}`);
console.log(`  ${budgetMs} ms per move on both sides, up to ${maxGames} games, ${jobs} at a time\n`);

const baseSeed = Number(arg('seed', '1'));
const pairScores: number[] = [];
const gameScores: number[] = [];
let state = sprt(pairScores, settings);
const started = Date.now();

// A batch per round of the test: the pairs inside it are independent, and the
// verdict is checked once they are all in. Checking after every single pair
// would mean playing them one at a time, which is what made this slow.
const batch = Math.max(1, Math.ceil(jobs / 2));
for (let pair = 0; pair * 2 < maxGames && state.verdict === 'continue'; pair += batch) {
  const requests = Array.from({ length: batch }, (_, i) => ({
    pair: pair + i,
    seed: baseSeed + pair + i,
  })).filter((p) => (p.pair + 1) * 2 <= maxGames);
  if (requests.length === 0) break;

  for (const halves of await pool.playPairs(requests)) {
    const [first, second] = halves;
    if (!first || !second) continue;
    gameScores.push(first.scoreA, second.scoreA);
    pairScores.push((first.scoreA + second.scoreA) / 2);
  }
  state = sprt(pairScores, settings);

  const elapsed = (Date.now() - started) / 1000;
  process.stdout.write(
    `\r  ${gameScores.length} games  score ${percent(state.mean)}  ` +
      `LLR ${state.llr.toFixed(2)} in [${state.lower.toFixed(2)}, ${state.upper.toFixed(2)}]  ` +
      `${elapsed.toFixed(0)}s`,
  );
}
await pool.close();

const games = scoreStats(gameScores);
console.log(`\n\n  games            ${gameScores.length}`);
console.log(`  score for B      ${percent(games.mean)}  [${percent(games.ci95.lo)} … ${percent(games.ci95.hi)}]`);
console.log(`  elo              ${eloDiff(games.mean).toFixed(0)}`);
console.log(`  LLR              ${state.llr.toFixed(2)}  bounds [${state.lower.toFixed(2)}, ${state.upper.toFixed(2)}]`);

if (state.verdict === 'accept') {
  console.log(`\n  ACCEPT — ${weightsB.version} replaces ${weightsA.version} as the baseline.\n`);
} else if (state.verdict === 'reject') {
  console.log(`\n  REJECT — ${weightsB.version} is not an improvement. The feature goes.\n`);
} else {
  console.log(
    `\n  UNDECIDED after ${gameScores.length} games. Not a result: either run it longer` +
      ` or drop the change. An undecided test is not a licence to keep it.\n`,
  );
}
process.exit(state.verdict === 'accept' ? 0 : 1);
