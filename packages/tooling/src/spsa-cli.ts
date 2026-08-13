/**
 * SPSA: tuning every weight at once instead of one at a time.
 *
 *   npm run spsa -- --from weights/base.json --out weights/spsa.json --iterations 200
 *   npm run spsa -- --from weights/base.json --out weights/spsa.json --resume
 *
 * **Why, when there is already a coordinate descent.** Descent spends a whole
 * experiment — hundreds of games — to learn one thing about one weight, and a
 * pass over ten weights costs twenty of them. Simultaneous Perturbation
 * Stochastic Approximation (Spall, 1992) spends every game on all ten: it kicks
 * the whole vector in a random direction, plays the kicked-up version against
 * the kicked-down one, and steps the whole vector towards whichever won. Two
 * measurements per iteration regardless of how many weights there are.
 *
 * The trade is that it never says "accepted". A step is not a verdict, it is a
 * nudge, and a run of nudges can wander. So this writes a candidate and nothing
 * more: what makes it the new baseline is an SPRT against the version it started
 * from, on deals it never saw.
 *
 *   npm run sprt -- --a weights/base.json --b weights/spsa.json
 *
 * **The details that matter, and why they are these.**
 *
 * - *Multiplicative perturbation.* The weights differ in scale by an order of
 *   magnitude, and one additive step size cannot suit both `material` at 0.7 and
 *   `reserve` at 0.15. Each is kicked by a fraction of itself.
 * - *Zero stays zero.* A weight at zero is a feature that lost its experiment.
 *   Nothing here is allowed to switch a feature back on by drift; that is what
 *   the ladder in stage 8.3 is for.
 * - *`markers` is not tuned.* Only the ratios between weights mean anything —
 *   the sum goes through `tanh` — so one of them has to hold still, and it is
 *   the one that measures the win condition.
 * - *Paired games.* Same seed, sides swapped, as everywhere else in this
 *   project: half the variance in War Chest is the deal.
 * - *Decaying gains.* `a/(A+k)^0.602` and `c/k^0.101`, the textbook exponents.
 *   Early iterations move far and late ones polish.
 *
 * Options:
 *   --from FILE        starting weights            (default weights/base.json)
 *   --out FILE         where the candidate is written
 *   --journal FILE     progress                    (default <out>.journal.json)
 *   --resume           continue from the journal
 *   --iterations N     SPSA steps                  (default 150)
 *   --pairs N          game pairs per step         (default 4)
 *   --a N              step size, as a fraction    (default 0.08)
 *   --c N              perturbation, as a fraction (default 0.12)
 *   --budget-ms N      thinking time per move      (default 250)
 *   --jobs N           games in flight at once     (default: cores minus two)
 *   --seed N           the perturbation stream     (default 1)
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { EvalWeights } from '@wc/bots';
import { createRng, nextInt } from '@wc/shared';
import type { BotSpec } from './bot-spec.js';
import { defaultJobs, MatchPool } from './match-pool.js';
import { DEFAULT_SPSA, gains, perturb, step, tunableKeys, type Weights } from './spsa.js';
import { percent } from './stats.js';
import { fromInvocation } from './paths.js';

/**
 * A weights file, checked before a single game is played.
 *
 * A file of the wrong shape — the lab writes `{weights, knobs}`, this wants the
 * weights alone — used to reach the search as a pile of `undefined`, come back
 * as `NaN`, and surface a hundred games later as a null in the tree.
 */
function loadWeights(path: string): EvalWeights {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  if (typeof parsed.version !== 'string') {
    throw new Error(`${path}: a weights file must carry a version (a lab config has one inside "weights")`);
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (key !== 'version' && typeof value !== 'number') {
      throw new Error(`${path}: weight "${key}" is ${typeof value}, not a number`);
    }
  }
  return parsed as unknown as EvalWeights;
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
}
const flag = (name: string) => process.argv.includes(`--${name}`);

interface Step {
  readonly k: number;
  readonly delta: Record<string, number>;
  readonly score: number;
  readonly games: number;
  readonly weights: EvalWeights;
}

interface Journal {
  start: EvalWeights;
  weights: EvalWeights;
  k: number;
  steps: Step[];
}

const fromPath = fromInvocation(arg('from', 'weights/base.json'));
const outPath = fromInvocation(arg('out', 'weights/spsa.json'));
const journalPath = fromInvocation(arg('journal', `${outPath}.journal.json`));
const heartbeatPath = `${outPath}.heartbeat.json`;
const iterations = Number(arg('iterations', '150'));
const pairsPerStep = Number(arg('pairs', '4'));
const gainA = Number(arg('a', '0.08'));
const gainC = Number(arg('c', '0.12'));
const budgetMs = Number(arg('budget-ms', '250'));
const jobs = Number(arg('jobs', String(defaultJobs())));
const rng = createRng(Number(arg('seed', '1')));

const journal: Journal =
  flag('resume') && existsSync(journalPath)
    ? (JSON.parse(readFileSync(journalPath, 'utf8')) as Journal)
    : (() => {
        const start = loadWeights(fromPath);
        return { start, weights: start, k: 0, steps: [] };
      })();

const settings = { ...DEFAULT_SPSA, a: gainA, c: gainC, steps: iterations };
/** Which weights this run may move: everything non-zero that is not the anchor. */
const keys = tunableKeys(journal.weights as unknown as Weights, settings);

/** A kicked vector, named so the game log says which side it was. */
function kicked(delta: Record<string, number>, c: number, sign: 1 | -1): EvalWeights {
  const out = perturb(journal.weights as unknown as Weights, delta, c, sign);
  out.version = `${journal.weights.version}${sign > 0 ? '+' : '-'}`;
  return out as unknown as EvalWeights;
}

function save(): void {
  writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
  writeFileSync(outPath, `${JSON.stringify(journal.weights, null, 2)}\n`);
}

function beat(fields: Record<string, unknown>): void {
  writeFileSync(
    heartbeatPath,
    `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...fields }, null, 2)}\n`,
  );
}

console.log(`\nSPSA from ${journal.start.version}`);
console.log(`  tuning ${keys.length} weights: ${keys.join(', ')}`);
console.log(`  ${iterations} steps × ${pairsPerStep} pairs, ${budgetMs} ms per move, ${jobs} games at a time`);
console.log(`  a=${gainA} c=${gainC}\n`);
if (keys.length === 0) {
  console.error('nothing to tune: every weight is zero or anchored');
  process.exit(1);
}

for (; journal.k < iterations; journal.k++) {
  const { a, c } = gains(journal.k, settings);

  // One Bernoulli ±1 per weight. All of them move, every step; that is the whole
  // idea — the direction is random, the *response* to it is not.
  const delta: Record<string, number> = {};
  for (const key of keys) delta[key] = nextInt(rng, 2) === 0 ? -1 : 1;

  const plus = kicked(delta, c, 1);
  const minus = kicked(delta, c, -1);
  const b: BotSpec = { kind: 'search', label: 'plus', weights: plus };
  const aSpec: BotSpec = { kind: 'search', label: 'minus', weights: minus };
  const pool = new MatchPool(b, aSpec, { budgetMs, maxPlies: 4000, jobs });

  // Its own block of seeds, like every other experiment here: a step taken on
  // the deals that suggested it is a step taken twice.
  const seedBase = 1 + journal.k * 1000;
  let score = 0;
  let games = 0;
  try {
    const halves = await pool.playPairs(
      Array.from({ length: pairsPerStep }, (_, i) => ({ pair: i, seed: seedBase + i })),
    );
    for (const pair of halves) {
      const [one, two] = pair;
      if (!one || !two) continue;
      score += one.scoreA + two.scoreA;
      games += 2;
    }
  } finally {
    await pool.close();
  }
  if (games === 0) throw new Error('no games came back; the pool is broken');

  // `2·mean − 1` is +1 when the kicked-up side won everything and −1 when it lost
  // everything. The step is along the same random direction, scaled by how
  // one-sided the answer was.
  const mean = score / games;
  const next = step(journal.weights as unknown as Weights, delta, mean, a);
  next.version = `${journal.start.version}-spsa${journal.k + 1}`;
  journal.weights = next as unknown as EvalWeights;
  journal.steps.push({ k: journal.k, delta, score: mean, games, weights: journal.weights });

  beat({
    step: journal.k + 1,
    of: iterations,
    score: mean,
    games,
    weights: journal.weights,
  });
  console.log(
    `  step ${String(journal.k + 1).padStart(4)}/${iterations}  ` +
      `plus scored ${percent(mean)} over ${games}  ` +
      `${keys.map((key) => `${key}=${(journal.weights as unknown as Weights)[key]}`).join(' ')}`,
  );
  save();
}

save();
beat({ finished: true, steps: journal.steps.length, weights: journal.weights });
console.log(`\nwritten to ${outPath}: ${JSON.stringify(journal.weights)}`);
console.log('This is a candidate, not a baseline. Confirm it before adopting it:');
console.log(`  npm run sprt -- --a ${fromPath} --b ${outPath} --budget-ms ${budgetMs}\n`);
