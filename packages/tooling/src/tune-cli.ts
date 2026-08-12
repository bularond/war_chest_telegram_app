/**
 * Coordinate descent over the evaluation weights.
 *
 *   npm run tune -- --from weights/base.json --out weights/tuned.json
 *   npm run tune -- --from weights/base.json --out weights/tuned.json --resume
 *
 * One weight at a time: try it doubled, try it halved, and keep whichever wins
 * its SPRT against the current baseline. A round that changes nothing halves the
 * step and goes again. Every experiment is an SPRT, so a step is taken only when
 * the statistics say to take it — this script has no opinions of its own.
 *
 * It is slow by nature: each experiment is a match of hundreds of games at the
 * budget the bot will actually use in production. So it keeps a journal and can
 * be stopped and resumed; `--resume` picks up where it left off, and finished
 * experiments are never replayed.
 *
 * Options:
 *   --from FILE       starting weights                    (default weights/base.json)
 *   --out FILE        where the accepted baseline is written
 *   --journal FILE    progress file                       (default <out>.journal.json)
 *   --resume          continue from the journal
 *   --budget-ms N     thinking time per move              (default 250, the Medium level)
 *   --max-games N     cap per experiment                  (default 600)
 *   --rounds N        passes over the weights             (default 2)
 *   --keys LIST       which weights to tune, comma separated
 *   --jobs N          games in flight at once     (default: cores minus two)
 *   --elo1 N          the gain a step must show    (default 30)
 *
 * **On that default.** The hypothesis has to match the size of the step. A
 * weight doubled is a large change, and asking "is it worth at least +10 Elo"
 * of a change that is in truth worth nothing leaves the likelihood ratio
 * sitting near zero: the test never reaches either bound and the run stalls at
 * the game cap having decided nothing. Asking "is it worth +30" makes a
 * neutral result land below the midpoint, which is a fast, cheap REJECT — and a
 * descent moves forward on rejections.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { EvalWeights } from '@wc/bots';
import type { BotSpec } from './bot-spec.js';
import { defaultJobs, MatchPool } from './match-pool.js';
import { DEFAULT_SPRT, sprt } from './sprt.js';
import { percent } from './stats.js';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
}
const flag = (name: string) => process.argv.includes(`--${name}`);

type WeightKey = Exclude<keyof EvalWeights, 'version'>;

interface Experiment {
  readonly key: WeightKey;
  readonly factor: number;
  readonly from: number;
  readonly to: number;
  readonly verdict: 'accept' | 'reject' | 'continue';
  readonly games: number;
  readonly score: number;
  readonly llr: number;
}

interface Journal {
  baseline: EvalWeights;
  round: number;
  step: number;
  done: Experiment[];
}

const fromPath = arg('from', 'weights/base.json');
const outPath = arg('out', 'weights/tuned.json');
const journalPath = arg('journal', `${outPath}.journal.json`);
const budgetMs = Number(arg('budget-ms', '250'));
const maxGames = Number(arg('max-games', '600'));
const rounds = Number(arg('rounds', '2'));
const keys = arg('keys', 'markers,material,reserve,bolster,proximity,initiative')
  .split(',')
  .filter(Boolean) as WeightKey[];

const journal: Journal =
  flag('resume') && existsSync(journalPath)
    ? (JSON.parse(readFileSync(journalPath, 'utf8')) as Journal)
    : {
        baseline: JSON.parse(readFileSync(fromPath, 'utf8')) as EvalWeights,
        round: 0,
        step: 2,
        done: [],
      };

function save(): void {
  writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
  writeFileSync(outPath, `${JSON.stringify(journal.baseline, null, 2)}\n`);
}

function alreadyDone(key: WeightKey, factor: number, from: number): Experiment | undefined {
  return journal.done.find((e) => e.key === key && e.factor === factor && e.from === from);
}

const jobs = Number(arg('jobs', String(defaultJobs())));
const batch = Math.max(1, Math.ceil(jobs / 2));
const settings = { ...DEFAULT_SPRT, elo1: Number(arg('elo1', '30')) };

/** Runs one experiment to a verdict, or to the game cap. */
async function trial(
  candidate: EvalWeights,
  label: string,
): Promise<Omit<Experiment, 'key' | 'factor' | 'from' | 'to'>> {
  const b: BotSpec = { kind: 'search', label, weights: candidate };
  const a: BotSpec = { kind: 'search', label: 'baseline', weights: journal.baseline };
  const pool = new MatchPool(b, a, { budgetMs, maxPlies: 4000, jobs });

  const pairScores: number[] = [];
  let state = sprt(pairScores, settings);
  try {
    for (let pair = 0; pair * 2 < maxGames && state.verdict === 'continue'; pair += batch) {
      const requests = Array.from({ length: batch }, (_, i) => ({
        pair: pair + i,
        seed: 1 + pair + i,
      })).filter((p) => (p.pair + 1) * 2 <= maxGames);
      if (requests.length === 0) break;

      for (const halves of await pool.playPairs(requests)) {
        const [one, two] = halves;
        if (one && two) pairScores.push((one.scoreA + two.scoreA) / 2);
      }
      state = sprt(pairScores, settings);
      process.stdout.write(
        `\r    ${label}: ${pairScores.length * 2} games, score ${percent(state.mean)}, LLR ${state.llr.toFixed(2)}   `,
      );
    }
  } finally {
    await pool.close();
  }
  return {
    verdict: state.verdict,
    games: pairScores.length * 2,
    score: state.mean,
    llr: state.llr,
  };
}

console.log(`\ncoordinate descent from ${journal.baseline.version}`);
console.log(`  ${budgetMs} ms per move, up to ${maxGames} games per experiment`);
console.log(`  a step must show +${settings.elo1} Elo to be taken\n`);

for (; journal.round < rounds; journal.round++) {
  console.log(`round ${journal.round + 1}, step ×${journal.step}`);
  let moved = false;

  for (const key of keys) {
    const from = journal.baseline[key];
    for (const factor of [journal.step, 1 / journal.step]) {
      // A weight pinned at zero cannot be scaled into existence; the ladder in
      // stage 8.3 is what turns a feature on, not this.
      if (from === 0) continue;
      const seen = alreadyDone(key, factor, from);
      if (seen) {
        console.log(`  ${key} ×${factor}: ${seen.verdict} (from the journal)`);
        if (seen.verdict === 'accept') {
          journal.baseline = { ...journal.baseline, [key]: seen.to };
          moved = true;
        }
        continue;
      }

      const to = Number((from * factor).toFixed(4));
      const candidate: EvalWeights = {
        ...journal.baseline,
        [key]: to,
        version: `${journal.baseline.version}+${key}×${factor}`,
      };
      const result = await trial(candidate, `${key} ×${factor}`);
      const experiment: Experiment = { key, factor, from, to, ...result };
      journal.done.push(experiment);

      console.log(
        `\r  ${key} ×${factor}: ${result.verdict.toUpperCase()} ` +
          `after ${result.games} games, score ${percent(result.score)}          `,
      );
      if (result.verdict === 'accept') {
        journal.baseline = { ...candidate, version: `${journal.baseline.version}` };
        moved = true;
        save();
        break; // this weight has moved; the other direction is moot
      }
      save();
    }
  }

  if (!moved) {
    journal.step = 1 + (journal.step - 1) / 2;
    console.log(`  nothing moved — step down to ×${journal.step.toFixed(3)}`);
    if (journal.step < 1.05) {
      console.log('  step is too small to be worth measuring; stopping');
      break;
    }
  }
  save();
}

journal.baseline = { ...journal.baseline, version: `${journal.baseline.version}-tuned` };
save();
console.log(`\nwritten to ${outPath}: ${JSON.stringify(journal.baseline)}\n`);
