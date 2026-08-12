/**
 * One command that compares two bots.
 *
 *   npm run arena -- --a greedy --b random --games 200
 *   npm run arena -- --a greedy --b random --games 400 --sets nobility,siege
 *
 * Options:
 *   --a NAME --b NAME   which bots (see the list printed on an unknown name)
 *   --games N           total games, rounded up to whole pairs   (default 100)
 *   --seed N            first pair's seed                        (default 1)
 *   --sets LIST         comma separated expansions, or "" for base only
 *   --draft MODE        random | draft | ban                     (default random)
 *   --budget-ms N       time allowance per move
 *   --max-plies N       give a game up after this many plies     (default 4000)
 *   --progress          print each pair as it finishes
 *   --jobs N            games in flight at once   (default: cores minus two)
 */

import { BOTS, type Bot } from '@wc/bots';
import type { DraftMode, UnitSet } from '@wc/shared';
import { summarize, type GameOutcome, type MatchResult } from './arena.js';
import { defaultJobs, MatchPool } from './match-pool.js';
import { eloInterval, eloDiff, percent } from './stats.js';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function resolve(name: string): Bot {
  const bot = BOTS[name];
  if (!bot) {
    console.error(`unknown bot "${name}". Available: ${Object.keys(BOTS).join(', ')}`);
    process.exit(1);
  }
  return bot;
}

const a = resolve(arg('a', 'greedy'));
const b = resolve(arg('b', 'random'));
const games = Number(arg('games', '100'));
const setsArg = arg('sets', '');
const sets = setsArg === '' ? [] : (setsArg.split(',') as UnitSet[]);
const budgetMs = Number(arg('budget-ms', '0'));

const jobs = Number(arg('jobs', String(defaultJobs())));
const baseSeed = Number(arg('seed', '1'));
const pool = new MatchPool(
  { kind: 'named', name: arg('a', 'greedy') },
  { kind: 'named', name: arg('b', 'random') },
  {
    sets,
    draftMode: arg('draft', 'random') as DraftMode,
    maxPlies: Number(arg('max-plies', '4000')),
    budgetMs,
    jobs,
  },
);

const started = Date.now();
const outcomes: GameOutcome[] = [];
const pairScores: number[] = [];
const pairCount = Math.ceil(games / 2);
const batch = Math.max(1, Math.ceil(jobs / 2));

for (let pair = 0; pair < pairCount; pair += batch) {
  const requests = Array.from({ length: Math.min(batch, pairCount - pair) }, (_, i) => ({
    pair: pair + i,
    seed: baseSeed + pair + i,
  }));
  for (const halves of await pool.playPairs(requests)) {
    const [first, second] = halves;
    if (!first || !second) continue;
    outcomes.push(first, second);
    pairScores.push((first.scoreA + second.scoreA) / 2);
  }
  if (flag('progress')) process.stdout.write(`\r  ${outcomes.length} of ${games} games played`);
}
await pool.close();

report(summarize(a.name, b.name, outcomes, pairScores, (Date.now() - started) / 1000));

/** Heuristic bots think in microseconds, a search thinks in seconds. */
function duration(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(1)} µs`;
  if (ms < 1000) return `${ms.toFixed(1)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function report(r: MatchResult): void {
  const pair = r.perPair;
  const elo = eloInterval(pair.ci95);
  const line = (label: string, value: string) => console.log(`  ${label.padEnd(22)}${value}`);

  console.log(`\n${r.a} vs ${r.b} — ${r.games.length} games (${pair.n} pairs)`);
  line('score for ' + r.a, `${percent(pair.mean)}  ±${percent(1.96 * pair.stderr)}`);
  line('95% interval', `${percent(pair.ci95.lo)} … ${percent(pair.ci95.hi)}`);
  line('elo', `${eloDiff(pair.mean).toFixed(0)}  [${elo.lo.toFixed(0)} … ${elo.hi.toFixed(0)}]`);
  line('w / l / d', `${r.winsA} / ${r.winsB} / ${r.draws}${r.plyCapped ? ` (${r.plyCapped} hit the ply cap)` : ''}`);
  line('per-game interval', `${percent(r.perGame.ci95.lo)} … ${percent(r.perGame.ci95.hi)}`);

  console.log('\n  engine and bots');
  line('total plies', `${r.plies}`);
  line('speed', `${(r.plies / r.seconds).toFixed(0)} plies/s over ${r.seconds.toFixed(1)}s on ${jobs} cores`);
  line(`per move, ${r.a}`, duration(r.msPerMoveA));
  line(`per move, ${r.b}`, duration(r.msPerMoveB));

  // A result whose interval spans 50% says nothing, and saying so is the point
  // of printing an interval at all.
  if (pair.ci95.lo <= 0.5 && pair.ci95.hi >= 0.5) {
    console.log('\n  the interval covers 50%: this match does not separate the two bots.');
  }
  console.log('');
}
