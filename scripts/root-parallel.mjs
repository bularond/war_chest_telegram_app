#!/usr/bin/env node
/**
 * What root parallelism is actually worth, in units of search.
 *
 *   node scripts/root-parallel.mjs [positions] [threads]
 *
 * Twelve workers give 8.7× the iterations a second. They do not give 8.7× the
 * search: each tree rediscovers what the others already know and none of them
 * can steer by what the others found. The literature says half to two thirds
 * for this many threads, and the literature is about other games.
 *
 * So it is measured here instead, and measured in a way that does not depend on
 * how loaded the machine is: everything runs on *iteration* budgets, which are
 * reproducible, and the answer comes out as "N searches of I iterations are
 * worth one search of how many".
 *
 * The method needs a yardstick and a curve.
 *
 *  - **The yardstick** is a very large search of the same position, whose visit
 *    counts stand in for the truth about which move is best.
 *  - **The curve** is how well a single search of `n` iterations agrees with the
 *    yardstick, for a range of `n`. It is the exchange rate between iterations
 *    and quality.
 *  - Then the merged search is scored the same way and read off the curve.
 *
 * Quality is the share of the yardstick's visits that went to the move chosen —
 * smoother than "did it pick the same move", which is a coin flip whenever two
 * moves are close and says nothing about how wrong a miss was.
 */

import {
  actingSeat,
  applyAction,
  createGame,
  createRng,
  publicStateFor,
} from '../packages/shared/dist/index.js';
import { bestOf, createSearchBot, mergeReports, runSearch, DEFAULT_SEARCH } from '../packages/bots/dist/index.js';

const positions = Number(process.argv[2] ?? 80);
const threads = Number(process.argv[3] ?? 8);
/**
 * Iterations each worker gets, and the number that matters most.
 *
 * The efficiency of root parallelism is not a constant — it depends on how big
 * each tree is before it is merged. Eight trees of 250 iterations against a
 * branching factor of 19 are eight trees with no depth at all, and merging them
 * can only pool root statistics. A real worker at 250 ms gets about 1900. So
 * this is a parameter and the answer must be quoted with it.
 */
const PER_THREAD = Number(process.argv[4] ?? 1000);
/** The yardstick has to be far larger than anything being scored against it. */
const TRUTH = Math.max(40000, threads * PER_THREAD * 5);
/** Single searches to draw the exchange rate with, straddling the merged total. */
const LADDER = [1, 2, 4, 8, 16, 32].map((k) => PER_THREAD * k);

/** A midgame position: walked in with a small search so the board is real. */
function walkedIn(seed) {
  const state = createGame({
    id: `rp-${seed}`,
    size: 2,
    seed,
    sets: ['base'],
    draftMode: 'draft',
    seats: [
      { userId: 'a', displayName: 'A' },
      { userId: 'b', displayName: 'B' },
    ],
  });
  const rng = createRng(seed * 31 + 5);
  const plies = 20 + (seed % 30);
  // Through the bot rather than through `runSearch`: the draft has no bags yet,
  // so there is nothing to determinize and the search declines to run at all.
  // Calling the search directly walks straight past that and fails deep inside
  // `hiddenCoins`, which is how this line came to be written twice.
  const walker = createSearchBot({ iterations: 40 }, 'walker');
  for (let i = 0; i < plies && state.phase !== 'finished'; i++) {
    const seat = actingSeat(state);
    applyAction(state, seat, walker.chooseMove(publicStateFor(state, seat), { rng, budget: {} }));
  }
  return state;
}

/** Ways to read several trees as one, beyond adding up the visits. */
const RULES = {
  'голосование': (parts) => {
    const votes = new Map();
    for (const roots of parts) {
      const k = bestOf(roots).key;
      votes.set(k, (votes.get(k) ?? 0) + 1);
    }
    return [...votes.entries()].sort((a, b) => b[1] - a[1])[0][0];
  },
  'средняя оценка': (parts) => {
    const merged = mergeReports(parts);
    // A visit floor, because every move is tried once in every tree and a mean
    // over one visit is not a mean.
    const floor = Math.max(...merged.map((r) => r.visits)) / 8;
    const worth = merged.filter((r) => r.visits >= floor);
    return (worth.length ? worth : merged).sort((a, b) => b.value / b.visits - a.value / a.visits)[0].key;
  },
};
const rules = new Map(Object.keys(RULES).map((n) => [n, []]));
const agreeRules = new Map(Object.keys(RULES).map((n) => [n, 0]));

const single = new Map(LADDER.map((n) => [n, []]));
const merged = [];
const agreeSingle = new Map(LADDER.map((n) => [n, 0]));
let agreeMerged = 0;
let used = 0;

for (let seed = 1; used < positions && seed < positions * 4; seed++) {
  const state = walkedIn(seed);
  if (state.phase !== 'playing') continue;
  const view = publicStateFor(state, actingSeat(state));
  if (view.legal.length < 4) continue;

  const truth = runSearch(view, { rng: createRng(seed * 7 + 1), budget: { iterations: TRUTH } }, DEFAULT_SEARCH);
  const total = truth.roots.reduce((n, r) => n + r.visits, 0);
  if (total === 0) continue;
  const best = bestOf(truth.roots);
  const score = (roots, action) => {
    const k = roots.find((r) => r.action === action)?.key;
    const hit = truth.roots.find((r) => r.key === k);
    return hit ? hit.visits / total : 0;
  };

  for (const n of LADDER) {
    const r = runSearch(view, { rng: createRng(seed * 101 + n), budget: { iterations: n } }, DEFAULT_SEARCH);
    single.get(n).push(score(r.roots, r.action));
    if (r.roots.find((x) => x.action === r.action)?.key === best.key) agreeSingle.set(n, agreeSingle.get(n) + 1);
  }

  const parts = [];
  for (let t = 0; t < threads; t++) {
    parts.push(
      runSearch(view, { rng: createRng(seed * 977 + t * 7919), budget: { iterations: PER_THREAD } }, DEFAULT_SEARCH)
        .roots,
    );
  }
  const pooled = mergeReports(parts);
  const pick = bestOf(pooled);
  const hit = truth.roots.find((r) => r.key === pick.key);
  merged.push(hit ? hit.visits / total : 0);
  if (pick.key === best.key) agreeMerged++;

  // Summing visits is the textbook rule, and the textbook is about deeper trees
  // than these. Two others, in case the rule is what is failing rather than the
  // idea: a majority vote over each tree's own pick, and the mean score each
  // move earned across every tree that looked at it.
  for (const [name, choose] of Object.entries(RULES)) {
    const k = choose(parts);
    const h = truth.roots.find((r) => r.key === k);
    rules.get(name).push(h ? h.visits / total : 0);
    if (k === best.key) agreeRules.set(name, agreeRules.get(name) + 1);
  }

  used++;
  if (used % 10 === 0) process.stderr.write(`  ${used}/${positions}\r`);
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
/** Standard error of the mean: the width below which a difference says nothing. */
function se(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1) / xs.length);
}

console.log(`\n  ${used} позиций, эталон — поиск на ${TRUTH} итераций\n`);
console.log(`  ${'один поиск'.padEnd(22)}${'качество ± ош.'.padEnd(20)}совпал с эталоном`);
console.log(`  ${'-'.repeat(62)}`);
for (const n of LADDER) {
  const xs = single.get(n);
  console.log(
    `  ${`${n} итераций`.padEnd(22)}${`${mean(xs).toFixed(4)} ± ${se(xs).toFixed(4)}`.padEnd(20)}` +
      `${((agreeSingle.get(n) / used) * 100).toFixed(1)}%`,
  );
}
const totalIters = threads * PER_THREAD;
console.log(
  `\n  ${`${threads}×${PER_THREAD} слитых`.padEnd(22)}` +
    `${`${mean(merged).toFixed(4)} ± ${se(merged).toFixed(4)}`.padEnd(20)}${((agreeMerged / used) * 100).toFixed(1)}%`,
);

for (const name of Object.keys(RULES)) {
  const xs = rules.get(name);
  console.log(
    `  ${`${threads}×${PER_THREAD}, ${name}`.padEnd(22)}` +
      `${`${mean(xs).toFixed(4)} ± ${se(xs).toFixed(4)}`.padEnd(20)}${((agreeRules.get(name) / used) * 100).toFixed(1)}%`,
  );
}

// Read the merged score off the curve: what size of single search matches it.
const q = mean(merged);
const pts = LADDER.map((n) => [n, mean(single.get(n))]);
let equivalent = null;
for (let i = 0; i < pts.length - 1; i++) {
  const [n0, q0] = pts[i];
  const [n1, q1] = pts[i + 1];
  if ((q >= q0 && q <= q1) || (q <= q0 && q >= q1)) {
    // Linear in log(iterations), which is the shape a search curve has.
    const t = q1 === q0 ? 0 : (q - q0) / (q1 - q0);
    equivalent = Math.exp(Math.log(n0) + t * (Math.log(n1) - Math.log(n0)));
    break;
  }
}
if (equivalent === null) {
  console.log(`\n  качество слитого поиска вне измеренной шкалы — расширьте LADDER`);
} else {
  // The same reading taken at the edges of the merged score's own error bar, so
  // the answer is quoted as wide as the measurement actually is. A single number
  // here would be a number read off differences smaller than the noise, which is
  // how the first run of this said «24%» from a gap of 0.002.
  const readOff = (target) => {
    for (let i = 0; i < pts.length - 1; i++) {
      const [n0, q0] = pts[i];
      const [n1, q1] = pts[i + 1];
      if ((target >= q0 && target <= q1) || (target <= q0 && target >= q1)) {
        const t = q1 === q0 ? 0 : (target - q0) / (q1 - q0);
        return Math.exp(Math.log(n0) + t * (Math.log(n1) - Math.log(n0)));
      }
    }
    return null;
  };
  const lo = readOff(q - se(merged));
  const hi = readOff(q + se(merged));
  const pct = (n) => (n === null ? '?' : `${((n / totalIters) * 100).toFixed(0)}%`);
  console.log(
    `\n  ${totalIters} итераций в ${threads} деревьях стоят ${equivalent.toFixed(0)} итераций в одном` +
      `\n  КПД корневого параллелизма: ${pct(equivalent)}  [${pct(lo)} … ${pct(hi)}]`,
  );
}
