/**
 * What the engine costs, in the units a search cares about.
 *
 *   npm run bench
 *   npm run bench -- --seconds 2 --sets nobility,siege,nightfall
 *
 * The headline number is rollouts per second: a determinization, then a dozen
 * plies of policy play, which is exactly one MCTS iteration minus the tree.
 * Everything above it in the table is there to say where the time went.
 */

import { BOTS, DEFAULT_SEARCH, HeuristicBot, RandomBot, runSearch } from '@wc/bots';
import {
  actingSeat,
  apply,
  applyAction,
  cloneState,
  createGame,
  createRng,
  hashState,
  isTerminal,
  legalMoves,
  publicStateFor,
  randomPolicy,
  sampleDeterminization,
  simulate,
  type GameState,
  type UnitSet,
} from '@wc/shared';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
}

const seconds = Number(arg('seconds', '1'));
const setsArg = arg('sets', '');
const sets = setsArg === '' ? [] : (setsArg.split(',') as UnitSet[]);
const ROLLOUT_DEPTH = Number(arg('depth', '12'));

function newGame(seed: number): GameState {
  return createGame({
    id: `bench-${seed}`,
    size: 2,
    seed,
    sets,
    draftMode: 'random',
    seats: [
      { userId: 'a', displayName: 'A' },
      { userId: 'b', displayName: 'B' },
    ],
  });
}

/** A position with pieces on the board, which is where search actually runs. */
function midGame(seed: number, plies: number): GameState {
  const state = newGame(seed);
  const rng = createRng(seed);
  for (let i = 0; i < plies && !isTerminal(state); i++) {
    applyAction(state, actingSeat(state), randomPolicy(state, rng));
  }
  return state;
}

interface Row {
  readonly name: string;
  readonly perOp: number;
  readonly rate: number;
  readonly note?: string;
}

const rows: Row[] = [];

function bench(name: string, fn: () => void, note?: string): void {
  // Warm up, so the first measured pass is not the compiler's first look.
  for (let i = 0; i < 200; i++) fn();
  const until = performance.now() + seconds * 1000;
  let ops = 0;
  const started = performance.now();
  while (performance.now() < until) {
    for (let i = 0; i < 100; i++) fn();
    ops += 100;
  }
  const elapsed = performance.now() - started;
  rows.push({ name, perOp: (elapsed * 1000) / ops, rate: ops / (elapsed / 1000), ...(note ? { note } : {}) });
}

const state = midGame(42, 60);
const view = publicStateFor(state, actingSeat(state));
const rng = createRng(1);
const ctx = { rng, budget: {} };
const legal = legalMoves(state);

bench('cloneState', () => void cloneState(state));
bench('legalMoves', () => void legalMoves(state));
bench('apply (validating)', () => void apply(state, legal[0]!), 'server path');
bench('simulate (trusted)', () => void simulate(state, legal[0]!), 'search path');
bench('hashState', () => void hashState(state));
bench('publicStateFor', () => void publicStateFor(state, actingSeat(state)), 'per shown position');
bench('sampleDeterminization', () => void sampleDeterminization(view, rng), 'per MCTS iteration');
bench('randomPolicy move', () => void randomPolicy(state, rng));
bench('greedy-free heuristic move', () => void HeuristicBot.chooseMove(view, ctx), 'rollout policy');
bench('random bot move', () => void RandomBot.chooseMove(view, ctx));

/** One MCTS iteration without the tree: determinize, then play out `depth` plies. */
function rollout(policy: 'random' | 'heuristic'): void {
  let s = sampleDeterminization(view, rng);
  for (let i = 0; i < ROLLOUT_DEPTH && !isTerminal(s); i++) {
    if (policy === 'random') {
      s = simulate(s, randomPolicy(s, rng));
    } else {
      const seat = actingSeat(s);
      s = simulate(s, HeuristicBot.chooseMove(publicStateFor(s, seat), ctx), seat);
    }
  }
}

bench(`rollout, random, ${ROLLOUT_DEPTH} plies`, () => rollout('random'), 'the headline number');
bench(`rollout, heuristic, ${ROLLOUT_DEPTH} plies`, () => rollout('heuristic'), 'the headline number');
bench('quick policy move', () => void BOTS['heuristic-quick']!.chooseMove(view, ctx), 'rollout policy');

// What the search actually gets through in a second, which is the number that
// decides how strong the bot on the server can be.
for (const [label, policy] of [
  ['heuristic rollouts', HeuristicBot],
  ['quick rollouts', BOTS['heuristic-quick'] as typeof HeuristicBot],
] as const) {
  const t0 = performance.now();
  const report = runSearch(view, { rng, budget: { ms: 1000 } }, { ...DEFAULT_SEARCH, rolloutBot: policy });
  const elapsed = (performance.now() - t0) / 1000;
  rows.push({
    name: `search, ${label}`,
    perOp: (elapsed * 1e6) / Math.max(1, report.iterations),
    rate: report.iterations / elapsed,
    note: 'iterations/s at a 1s budget',
  });
}

const width = Math.max(...rows.map((r) => r.name.length)) + 2;
console.log(`\nengine cost — ${sets.length ? sets.join('+') : 'base game'}, ${seconds}s per measurement\n`);
for (const row of rows) {
  const per = row.perOp < 1000 ? `${row.perOp.toFixed(2)} µs` : `${(row.perOp / 1000).toFixed(2)} ms`;
  const rate = row.rate >= 1000 ? `${(row.rate / 1000).toFixed(1)}k/s` : `${row.rate.toFixed(0)}/s`;
  console.log(`  ${row.name.padEnd(width)}${per.padStart(10)}  ${rate.padStart(9)}${row.note ? `   ${row.note}` : ''}`);
}
console.log('');
