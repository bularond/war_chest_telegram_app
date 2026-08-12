#!/usr/bin/env node
/**
 * Would a weight per unit have anything to weigh?
 *
 *   node scripts/per-unit-power.mjs [rollouts per move] [positions]
 *
 * The proposal is to replace the single `material` term — every coin counts one
 * — with one term per unit type, and let the tuner learn what a Knight coin is
 * worth as against a Footman coin. It is a lot of work, so it is worth ten
 * minutes to find out whether there is anything there to learn.
 *
 * The question is not "do units differ" — they plainly do, the draft table
 * spreads nineteen points from top to bottom. It is whether a per-unit term can
 * *separate the moves at the root*, which is the only way an evaluation term can
 * change anything. Splitting one feature into twenty-eight divides its signal
 * between them and leaves the noise where it was: the noise comes from the
 * rollout, and a rollout does not get quieter because the feature got narrower.
 *
 * So this measures, for each unit, the same two numbers `feature-power.mjs`
 * measures for the whole evaluation — the spread of the term's mean across root
 * moves, and the error on one of those means — and prints them beside the
 * aggregates they would be replacing.
 *
 * Two banks are measured, because they are different bets:
 *
 *  - **on the board**, the direct split of `material`;
 *  - **still to come**, the split of `reserve`. That one is the more interesting
 *    of the two: coins in the bag are exactly what a twelve-ply rollout cannot
 *    play out, so a static opinion about them is not competing with simulation.
 */

import {
  actingSeat,
  actionKey,
  applyAction,
  createGame,
  createRng,
  isTerminal,
  isUnitId,
  legalMoves,
  publicStateFor,
  sampleDeterminization,
  simulate,
} from '../packages/shared/dist/index.js';
import { HeuristicBot, DEFAULT_SEARCH } from '../packages/bots/dist/index.js';

const perMove = Number(process.argv[2] ?? 80);
const wanted = Number(process.argv[3] ?? 6);
const MAX_MOVES = 14;

function position(seed) {
  const g = createGame({
    id: `perunit-${seed}`,
    size: 2,
    seed,
    draftMode: 'draft',
    seats: [
      { userId: 'a', displayName: 'A' },
      { userId: 'b', displayName: 'B' },
    ],
  });
  const walk = createRng(seed);
  const plies = 20 + (seed % 25);
  for (let i = 0; i < plies && g.phase !== 'finished'; i++) {
    const seat = actingSeat(g);
    applyAction(g, seat, HeuristicBot.chooseMove(publicStateFor(g, seat), { rng: walk, budget: {} }));
  }
  return g;
}

const sd = (xs) => {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
};
const mean = (xs) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

/**
 * The readings a per-unit bank would produce, plus the two aggregates they would
 * be splitting, so the comparison is like with like.
 */
function readings(state, me) {
  const team = state.players[me].team;
  const board = new Map();
  const held = new Map();
  let boardCoins = 0;
  let pool = 0;

  for (const stack of Object.values(state.units)) {
    boardCoins += stack.coins;
    const sign = stack.team === team ? 1 : -1;
    board.set(stack.unit, (board.get(stack.unit) ?? 0) + sign * stack.coins);
  }
  for (const p of state.players) {
    const sign = p.team === team ? 1 : -1;
    const add = (coin) => {
      if (!isUnitId(coin)) return;
      pool++;
      held.set(coin, (held.get(coin) ?? 0) + sign);
    };
    for (const c of p.bag) add(c);
    for (const c of p.hand) add(c);
    for (const e of p.discard) add(e.coin);
    for (const [u, n] of Object.entries(p.supply)) {
      for (let i = 0; i < (n ?? 0); i++) add(u);
    }
  }

  const out = new Map();
  for (const [u, v] of board) out.set(`board:${u}`, boardCoins === 0 ? 0 : v / boardCoins);
  for (const [u, v] of held) out.set(`reserve:${u}`, pool === 0 ? 0 : v / pool);
  // The aggregates, computed the way `eval.ts` computes them.
  let m = 0;
  for (const v of board.values()) m += v;
  let r = 0;
  for (const v of held.values()) r += v;
  out.set('AGGREGATE material', boardCoins === 0 ? 0 : m / boardCoins);
  out.set('AGGREGATE reserve', pool === 0 ? 0 : r / pool);
  return out;
}

const signal = new Map();
const noise = new Map();
let positions = 0;

for (let seed = 3; positions < wanted && seed < 200; seed += 2) {
  const g = position(seed);
  if (g.phase === 'finished') continue;
  const view = publicStateFor(g, actingSeat(g));
  if (view.legal.length < 4) continue;
  positions++;

  const rng = createRng(seed * 977 + 11);
  const perMoveMean = new Map();
  const perMoveError = new Map();

  for (const move of view.legal.slice(0, MAX_MOVES)) {
    const leaves = new Map();
    for (let n = 0; n < perMove; n++) {
      let s = sampleDeterminization(view, rng);
      const acting = actingSeat(s);
      if (!legalMoves(s).some((a) => actionKey(a) === actionKey(move))) continue;
      s = simulate(s, move, acting);
      for (let d = 0; d < DEFAULT_SEARCH.rolloutDepth; d++) {
        if (isTerminal(s)) break;
        const legal = legalMoves(s);
        if (legal.length === 0) break;
        const seat = actingSeat(s);
        s = simulate(s, HeuristicBot.chooseMove({ ...publicStateFor(s, seat), legal }, { rng, budget: {} }), seat);
      }
      for (const [k, v] of readings(s, view.you)) {
        if (!leaves.has(k)) leaves.set(k, []);
        leaves.get(k).push(v);
      }
    }
    for (const [k, xs] of leaves) {
      if (xs.length < 4) continue;
      if (!perMoveMean.has(k)) perMoveMean.set(k, []);
      if (!perMoveError.has(k)) perMoveError.set(k, []);
      perMoveMean.get(k).push(mean(xs));
      perMoveError.get(k).push(sd(xs) / Math.sqrt(xs.length));
    }
  }

  for (const [k, xs] of perMoveMean) {
    if (xs.length < 3) continue;
    if (!signal.has(k)) signal.set(k, []);
    if (!noise.has(k)) noise.set(k, []);
    signal.get(k).push(sd(xs));
    noise.get(k).push(mean(perMoveError.get(k)));
  }
}

const rows = [...signal.keys()]
  .map((k) => {
    const s = mean(signal.get(k));
    const n = mean(noise.get(k));
    return { k, s, n, ratio: n === 0 ? 0 : s / n, seen: signal.get(k).length };
  })
  // A unit that turned up in one position out of six says nothing about
  // anything; the bank would carry a weight for it either way.
  .filter((r) => r.seen >= 3);

const show = (title, filter) => {
  const group = rows.filter((r) => filter(r.k)).sort((a, b) => b.ratio - a.ratio);
  if (group.length === 0) return;
  console.log(`\n  ${title}`);
  console.log(`  ${'term'.padEnd(26)}${'signal'.padEnd(10)}${'noise'.padEnd(10)}ratio`);
  console.log(`  ${'-'.repeat(56)}`);
  for (const r of group) {
    console.log(
      `  ${r.k.replace(/^(board|reserve):/, '').padEnd(26)}${r.s.toFixed(4).padEnd(10)}${r.n.toFixed(4).padEnd(10)}${r.ratio.toFixed(2)}`,
    );
  }
  const resolvable = group.filter((r) => r.ratio >= 1).length;
  console.log(`  ${resolvable} of ${group.length} separate the root moves by more than their own error`);
};

console.log(`\n  ${positions} positions, ${perMove} rollouts per root move\n`);
console.log(`  ${'the aggregates these would replace'.padEnd(26)}`);
console.log(`  ${'-'.repeat(56)}`);
for (const r of rows.filter((r) => r.k.startsWith('AGGREGATE'))) {
  console.log(
    `  ${r.k.replace('AGGREGATE ', '').padEnd(26)}${r.s.toFixed(4).padEnd(10)}${r.n.toFixed(4).padEnd(10)}${r.ratio.toFixed(2)}`,
  );
}
show('split by unit, coins on the board', (k) => k.startsWith('board:'));
show('split by unit, coins still to come', (k) => k.startsWith('reserve:'));
console.log();
