/**
 * The lab: a queue of experiments that runs unattended for as long as there is
 * something in it.
 *
 *   npm run lab -- --plan weights/night.plan.json --out weights/lab
 *   npm run lab -- --plan weights/night.plan.json --out weights/lab --resume
 *
 * `sprt` runs one experiment and `tune` runs one coordinate descent; this runs
 * everything, in order, overnight, and survives being stopped. It exists because
 * an experiment takes half an hour and a night holds twenty of them — deciding
 * what to try next should not require a person to be awake.
 *
 * **What it does.** It holds a *baseline*: a set of evaluation weights together
 * with the search knobs those weights were measured under. Each proposal in the
 * plan describes a change to that baseline. The change plays a match against the
 * baseline under SPRT, and on ACCEPT it becomes the new baseline — so later
 * proposals are measured against the best thing found so far, not against where
 * the night started.
 *
 * **Three properties it needs in order to be left alone:**
 *
 * - *It writes down everything as it goes.* The journal is saved after every
 *   experiment and a heartbeat after every batch of games, so a watcher can tell
 *   a slow experiment from a wedged one, and `--resume` never replays a finished
 *   match.
 * - *One bad experiment does not end the night.* A crash is recorded as a
 *   verdict and the queue moves on; an experiment that will not decide is cut
 *   off by `--max-games` or `--max-minutes`, whichever comes first.
 * - *The plan is re-read before every experiment.* Proposals can be appended to
 *   the file while it runs, and they will be picked up. Nothing already finished
 *   is affected.
 *
 * **Fresh deals per experiment.** Each experiment gets its own block of seeds.
 * Reusing one block would let a change be accepted for suiting those particular
 * deals, and the accepted changes would then be measured on the deals that
 * chose them.
 *
 * Options:
 *   --plan FILE       the queue                        (default weights/night.plan.json)
 *   --out PREFIX      baseline, journal and heartbeat  (default weights/lab)
 *   --resume          keep the journal and carry on
 *   --budget-ms N     thinking time per move           (default 250, the Medium level)
 *   --max-games N     cap per experiment               (default 800)
 *   --max-minutes N   wall clock cap per experiment    (default 45)
 *   --elo1 N          the gain an experiment must show (default 30)
 *   --jobs N          games in flight at once          (default: cores minus two)
 *   --descent         when the plan runs dry, generate coordinate descent rounds
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { BASE_WEIGHTS, type EvalWeights } from '@wc/bots';
import type { DraftMode, UnitSet } from '@wc/shared';
import type { BotSpec } from './bot-spec.js';
import { checkPlan, DEFAULT_KNOBS, resolve, type Config, type Proposal, type WeightKey } from './lab.js';
import { defaultJobs, MatchPool } from './match-pool.js';
import { DEFAULT_SPRT, sprt } from './sprt.js';
import { eloDiff, percent } from './stats.js';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
}
const flag = (name: string) => process.argv.includes(`--${name}`);

interface Done {
  readonly id: string;
  readonly note: string;
  readonly verdict: 'accept' | 'reject' | 'continue' | 'error';
  readonly games: number;
  readonly score: number;
  readonly elo: number;
  readonly llr: number;
  readonly seconds: number;
  readonly change: string;
  /** Recorded because they change what the number means, not just how it was got. */
  readonly draftMode?: DraftMode;
  readonly sets?: readonly UnitSet[];
  readonly error?: string;
}

interface Journal {
  baseline: Config;
  /**
   * What the night started from. The baseline's version is this plus the number
   * of steps taken, because a set of weights that is no longer `eval@3` must not
   * go on calling itself `eval@3` — the version is written into the log of every
   * game the bot plays, and that is the only thread back from a win rate to the
   * numbers that produced it.
   */
  rootVersion: string;
  /** The configuration the night started from, kept for `against: 'root'`. */
  root?: Config;
  accepts: number;
  done: Done[];
  /** Step for the generated descent rounds, once the plan is empty. */
  step: number;
  round: number;
}

const planPath = arg('plan', 'weights/night.plan.json');
const outPrefix = arg('out', 'weights/lab');
const baselinePath = `${outPrefix}.json`;
const journalPath = `${outPrefix}.journal.json`;
const heartbeatPath = `${outPrefix}.heartbeat.json`;
const budgetMs = Number(arg('budget-ms', '250'));
const maxGames = Number(arg('max-games', '800'));
const maxMinutes = Number(arg('max-minutes', '45'));
/**
 * Where a game is called a draw and stopped.
 *
 * This is a throughput setting, not a safety net. A batch waits for its slowest
 * game, so one long game holds all thirteen workers: at 250 ms a move, a game
 * allowed to run to 4000 plies can idle the machine for a quarter of an hour,
 * and that was watched happening. Games decide in about two hundred plies; a
 * game still going at twelve hundred is a position neither side can win, which
 * is what a draw is.
 */
const maxPlies = Number(arg('max-plies', '1200'));
const jobs = Number(arg('jobs', String(defaultJobs())));
const defaultElo1 = Number(arg('elo1', '30'));
const descent = flag('descent');

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/**
 * The starting point, from either shape of file: a lab baseline is
 * `{weights, knobs}` and a plain weights file is the weights. Telling the user
 * which one they handed over beats a `TypeError` about `undefined.version`.
 */
function readConfig(path: string): Config {
  const raw = readJson<Record<string, unknown>>(path);
  if (raw.weights) return raw as unknown as Config;
  if (typeof raw.version === 'string') return { weights: raw as unknown as EvalWeights, knobs: {} };
  throw new Error(`${path}: neither a lab baseline ({weights, knobs}) nor a weights file (no version)`);
}

const plan = () => (existsSync(planPath) ? readJson<{ proposals: Proposal[] }>(planPath).proposals : []);

const journal: Journal =
  flag('resume') && existsSync(journalPath)
    ? readJson<Journal>(journalPath)
    : {
        baseline: readConfig(arg('from', 'weights/lab.start.json')),
        rootVersion: readConfig(arg('from', 'weights/lab.start.json')).weights.version,
        root: readConfig(arg('from', 'weights/lab.start.json')),
        accepts: 0,
        done: [],
        step: 2,
        round: 0,
      };

// Features added since the baseline file was written are missing from it, and a
// missing weight reads as zero everywhere — but only the file says so, and the
// file is what a person reads in the morning. Spell them out.
journal.baseline = {
  ...journal.baseline,
  weights: { ...BASE_WEIGHTS, ...journal.baseline.weights },
};

// A journal written by an older build has no root version; the baseline's own
// is the right answer then, since nothing has been accepted on top of it.
journal.rootVersion ??= journal.baseline.weights.version;
journal.root ??= journal.baseline;
journal.accepts ??= 0;

function save(): void {
  writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
  writeFileSync(baselinePath, `${JSON.stringify(journal.baseline, null, 2)}\n`);
}

function beat(fields: Record<string, unknown>): void {
  writeFileSync(
    heartbeatPath,
    `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...fields }, null, 2)}\n`,
  );
}

function stamp(): string {
  return new Date().toTimeString().slice(0, 8);
}

/** Plays one experiment to a verdict, to the game cap, or to the clock. */
async function trial(
  candidate: Config,
  against: Config,
  id: string,
  index: number,
  note: string,
  elo1: number,
  cap: number,
  draftMode: DraftMode,
  sets: readonly UnitSet[],
): Promise<Omit<Done, 'id' | 'note' | 'change'>> {
  const settings = { ...DEFAULT_SPRT, elo1 };
  const b: BotSpec = { kind: 'search', label: id, weights: candidate.weights, knobs: candidate.knobs };
  const a: BotSpec = {
    kind: 'search',
    label: against.weights.version,
    weights: against.weights,
    knobs: against.knobs,
  };
  const pool = new MatchPool(b, a, { budgetMs, maxPlies, jobs, draftMode, sets });

  // Its own block of seeds, so no two experiments are decided on the same deals.
  const seedBase = 1 + index * 10_000;
  const started = Date.now();
  const deadline = started + maxMinutes * 60_000;
  const pairScores: number[] = [];
  let state = sprt(pairScores, settings);
  let cursor = 0;
  let lastBeat = 0;

  try {
    await pool.playStream(
      () => {
        // One pair at a time, on demand: the stream asks for the next only when
        // a worker is free, so nothing is queued that the verdict might make
        // pointless.
        if (cursor * 2 >= cap || Date.now() > deadline || state.verdict !== 'continue') return null;
        const pair = { pair: cursor, seed: seedBase + cursor };
        cursor++;
        return pair;
      },
      (halves) => {
        const [one, two] = halves;
        if (one && two) pairScores.push((one.scoreA + two.scoreA) / 2);
        state = sprt(pairScores, settings);

        // The heartbeat is for a watcher, not for the statistics: once a second
        // is plenty, and writing a file per pair is not.
        const now = Date.now();
        if (now - lastBeat < 1000) return;
        lastBeat = now;
        const seconds = (now - started) / 1000;
        beat({
          experiment: id,
          note,
          games: pairScores.length * 2,
          score: state.mean,
          llr: state.llr,
          bounds: [state.lower, state.upper],
          seconds: Math.round(seconds),
          gamesPerMinute: Number(((pairScores.length * 2 * 60) / seconds).toFixed(1)),
          done: journal.done.length,
        });
        process.stdout.write(
          `\r    ${stamp()} ${pairScores.length * 2} games, ${percent(state.mean)}, LLR ${state.llr.toFixed(2)}   `,
        );
      },
      () => state.verdict === 'continue' && Date.now() <= deadline,
    );
  } finally {
    await pool.close();
  }
  if (Date.now() > deadline) console.log(`\n    ${stamp()} out of time after ${maxMinutes} min`);

  return {
    verdict: state.verdict,
    games: pairScores.length * 2,
    score: state.mean,
    elo: Math.round(eloDiff(state.mean)),
    llr: state.llr,
    seconds: Math.round((Date.now() - started) / 1000),
  };
}

/**
 * The next descent round, once the plan is empty: every non-zero weight, up and
 * down by the current step. Proposals already in the journal are skipped by id,
 * and the id carries the value it started from — so a weight that has moved
 * since is tried again from where it now is.
 */
function descentRound(): Proposal[] {
  const w = journal.baseline.weights;
  const keys = Object.keys(w).filter((k) => k !== 'version' && k !== 'markers') as WeightKey[];
  const out: Proposal[] = [];
  // The knobs of the search get the same treatment as the weights: they are
  // numbers nobody has measured either, and the plan only covers a few values.
  for (const key of ['exploration', 'rolloutDepth'] as const) {
    const from = (journal.baseline.knobs[key] ?? DEFAULT_KNOBS[key]) as number;
    for (const factor of [journal.step, Number((1 / journal.step).toFixed(4))]) {
      out.push({
        id: `descent-${key}-x${factor}-from${from}`,
        note: `descent round ${journal.round + 1}: ${key} ×${factor}`,
        scaleKnob: { key, factor },
      });
    }
  }
  for (const key of keys) {
    if ((w[key] ?? 0) === 0) continue;
    for (const factor of [journal.step, Number((1 / journal.step).toFixed(4))]) {
      out.push({
        id: `descent-${key}-x${factor}-from${w[key]}`,
        note: `descent round ${journal.round + 1}: ${key} ×${factor}`,
        scale: { key, factor },
      });
    }
  }
  return out;
}

/**
 * One experiment, with one retry if it crashes.
 *
 * A crash is usually the experiment's own fault and will happen again, in which
 * case the second attempt costs seconds. But it can also be something passing —
 * a worker that loaded a `dist` file while it was being rewritten, which is what
 * happens when the code is being worked on while the night runs. Losing a
 * half-hour experiment to that is worse than paying for a retry.
 */
async function attempt(
  candidate: Config,
  against: Config,
  proposal: Proposal,
  index: number,
  confirming: boolean,
): Promise<Omit<Done, 'id' | 'note' | 'change'>> {
  for (let tries = 0; ; tries++) {
    try {
      return await trial(
        candidate,
        against,
        proposal.id,
        index,
        proposal.note ?? proposal.id,
        // A confirmation asks how much the night was worth, not whether to take
        // another step, so it uses the house hypothesis rather than the step one.
        proposal.elo1 ?? (confirming ? DEFAULT_SPRT.elo1 : defaultElo1),
        proposal.maxGames ?? maxGames,
        proposal.draftMode ?? 'random',
        proposal.sets ?? [],
      );
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.log(`\n    ${stamp()} FAILED: ${error.split('\n')[0]}`);
      if (tries === 0) {
        console.log(`    ${stamp()} trying once more`);
        continue;
      }
      return { verdict: 'error', games: 0, score: 0, elo: 0, llr: 0, seconds: 0, error };
    }
  }
}

const complaints = checkPlan(plan());
if (complaints.length > 0) {
  console.error(`\n${planPath} does not make sense:`);
  for (const c of complaints) console.error(`  ${c}`);
  console.error('\nNothing was played. Fix the plan and start again.\n');
  process.exit(1);
}

console.log(`\nlab starting ${new Date().toISOString()}`);
console.log(`  baseline ${journal.baseline.weights.version} ${JSON.stringify(journal.baseline.knobs)}`);
console.log(`  ${budgetMs} ms per move, ${jobs} games at a time, a game called a draw at ${maxPlies} plies`);
console.log(`  each experiment runs to ${maxGames} games or ${maxMinutes} minutes, whichever comes first\n`);

let index = journal.done.length;
for (;;) {
  const finished = new Set(journal.done.map((d) => d.id));
  let queue = plan().filter((p) => !finished.has(p.id));

  if (queue.length === 0) {
    if (!descent) break;
    queue = descentRound().filter((p) => !finished.has(p.id));
    if (queue.length === 0) {
      // A whole round with nothing left to try means every step at this size has
      // been taken or refused. Halve the step and go round again.
      journal.step = 1 + (journal.step - 1) / 2;
      journal.round++;
      console.log(`\n  ${stamp()} round over — step down to ×${journal.step.toFixed(3)}`);
      if (journal.step < 1.05) {
        console.log('  steps this small cost more to measure than they are worth; the lab is done');
        break;
      }
      save();
      continue;
    }
  }

  const proposal = queue[0] as Proposal;
  const confirming = proposal.against === 'root';
  const resolved = confirming
    ? {
        config: journal.baseline,
        change: `${journal.baseline.weights.version} against ${journal.rootVersion} on fresh deals`,
      }
    : resolve(journal.baseline, proposal);
  if (!resolved) {
    journal.done.push({
      id: proposal.id,
      note: proposal.note ?? '',
      verdict: 'reject',
      games: 0,
      score: 0,
      elo: 0,
      llr: 0,
      seconds: 0,
      change: 'nothing to change',
    });
    save();
    continue;
  }

  console.log(
    `\n  ${stamp()} ${proposal.id}: ${resolved.change}` +
      (proposal.draftMode && proposal.draftMode !== 'random' ? ` (${proposal.draftMode})` : '') +
      (proposal.sets?.length ? ` (+${proposal.sets.join('+')})` : ''),
  );
  beat({ experiment: proposal.id, note: proposal.note ?? '', games: 0, starting: true });

  const result = await attempt(
    resolved.config,
    confirming ? (journal.root as Config) : journal.baseline,
    proposal,
    index,
    confirming,
  );
  index++;

  journal.done.push({
    id: proposal.id,
    note: proposal.note ?? '',
    change: resolved.change,
    ...(proposal.draftMode ? { draftMode: proposal.draftMode } : {}),
    ...(proposal.sets?.length ? { sets: proposal.sets } : {}),
    ...result,
  });
  console.log(
    `\r    ${stamp()} ${result.verdict.toUpperCase()} after ${result.games} games, ` +
      `${percent(result.score)} (${result.elo >= 0 ? '+' : ''}${result.elo} Elo), ${result.seconds}s        `,
  );

  if (result.verdict === 'accept' && !confirming) {
    journal.accepts++;
    journal.baseline = {
      weights: { ...resolved.config.weights, version: `${journal.rootVersion}+${journal.accepts}` },
      knobs: resolved.config.knobs,
    };
    console.log(`    new baseline: ${JSON.stringify(journal.baseline)}`);
  }
  save();
}

save();
beat({ experiment: null, finished: true, done: journal.done.length });
console.log(`\nlab finished, ${journal.done.length} experiments`);
console.log(`  baseline written to ${baselinePath}: ${JSON.stringify(journal.baseline)}\n`);
