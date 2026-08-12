#!/usr/bin/env node
/**
 * What the search spends its iterations on.
 *
 *   node scripts/search-shape.mjs [positions] [budgetMs]
 *
 * The coordinate descent has run out: every weight and every knob has been
 * stepped both ways and every step was rejected. So the next thing has to be
 * something the search does not currently know, and the first candidate is the
 * width of the root: branching runs 30 to 80, and at a level's budget each move
 * may be getting a handful of visits. A move with four visits has not been
 * read, it has been sampled.
 *
 * Two numbers decide whether a prior is worth building:
 *
 *  - **How thin the root is.** Share of the visits the top move gets, and how
 *    many moves finish with two visits or fewer. Thin means there is waste to
 *    recover.
 *  - **How sharp the heuristic's opinion is.** It sorts moves into drawers. If
 *    its best drawer holds three moves out of forty, a prior concentrates the
 *    search enormously; if it holds thirty, the prior says almost nothing and
 *    no amount of tuning will make it say more.
 *
 * And one number decides whether the prior would be *right*: how often the
 * search's own answer, given a long think, lands in that best drawer. A prior
 * that points away from the answer is worse than none.
 */

import {
  actingSeat,
  applyAction,
  createGame,
  createRng,
  publicStateFor,
  actionKey,
} from '../packages/shared/dist/index.js';
import { HeuristicBot, rankActions, runSearch, DEFAULT_SEARCH } from '../packages/bots/dist/index.js';

const positions = Number(process.argv[2] ?? 40);
const budgetMs = Number(process.argv[3] ?? 250);

/** A mid-game position, reached the way a real game reaches one. */
function position(seed) {
  const g = createGame({
    id: `shape-${seed}`,
    size: 2,
    seed,
    draftMode: 'random',
    seats: [
      { userId: 'a', displayName: 'A' },
      { userId: 'b', displayName: 'B' },
    ],
  });
  const walk = createRng(seed);
  const plies = 10 + (seed % 30);
  for (let i = 0; i < plies && g.phase !== 'finished'; i++) {
    const seat = actingSeat(g);
    applyAction(g, seat, HeuristicBot.chooseMove(publicStateFor(g, seat), { rng: walk, budget: {} }));
  }
  return g;
}

const rows = [];

for (let i = 0; i < positions; i++) {
  const seed = 1000 + i * 7;
  const g = position(seed);
  if (g.phase === 'finished') continue;
  const seat = actingSeat(g);
  const view = publicStateFor(g, seat);
  if (view.legal.length < 4) continue;

  const ranks = rankActions(view, view.legal);
  const best = Math.min(...ranks);
  const inBestDrawer = ranks.filter((r) => r === best).length;

  // The search, instrumented: `runSearch` returns only its answer, so the root
  // is rebuilt here by asking for the visit spread the same way it would.
  const report = runSearch(view, { rng: createRng(seed * 13 + 5), budget: { ms: budgetMs } }, DEFAULT_SEARCH);

  const chosen = view.legal.findIndex((a) => actionKey(a) === actionKey(report.action));
  rows.push({
    legal: view.legal.length,
    iterations: report.iterations,
    topVisits: report.visits,
    share: report.visits / Math.max(1, report.iterations),
    drawer: inBestDrawer,
    drawerShare: inBestDrawer / view.legal.length,
    agrees: chosen >= 0 && ranks[chosen] === best,
  });
}

const mean = (f) => rows.reduce((a, r) => a + f(r), 0) / rows.length;
const median = (f) => {
  const xs = rows.map(f).sort((a, b) => a - b);
  return xs[Math.floor(xs.length / 2)];
};

console.log(`\n  ${rows.length} positions, ${budgetMs} ms each\n`);
console.log(`  legal moves at the root       ${mean((r) => r.legal).toFixed(1)}  (median ${median((r) => r.legal)})`);
console.log(`  iterations in the budget      ${mean((r) => r.iterations).toFixed(0)}  (median ${median((r) => r.iterations)})`);
console.log(`  iterations per legal move     ${(mean((r) => r.iterations) / mean((r) => r.legal)).toFixed(1)}`);
console.log(`  visits on the chosen move     ${mean((r) => r.topVisits).toFixed(0)}`);
console.log(`  ...as a share of iterations   ${(mean((r) => r.share) * 100).toFixed(1)}%`);
console.log();
console.log(`  moves in the heuristic's best drawer   ${mean((r) => r.drawer).toFixed(1)} of ${mean((r) => r.legal).toFixed(1)}  (${(mean((r) => r.drawerShare) * 100).toFixed(0)}%)`);
console.log(`  search's answer is in that drawer      ${(rows.filter((r) => r.agrees).length / rows.length * 100).toFixed(0)}%`);

const share = mean((r) => r.share);
const drawer = mean((r) => r.drawerShare);
const agree = rows.filter((r) => r.agrees).length / rows.length;

console.log();
if (drawer > 0.5) {
  console.log('  The heuristic barely narrows anything — its best drawer holds most of');
  console.log('  the moves. A prior built on it cannot concentrate the search.');
} else if (agree < 0.6) {
  console.log('  The heuristic narrows sharply but points elsewhere: the search disagrees');
  console.log('  with it more often than not. A prior on it would push away from the answer.');
} else {
  console.log(`  Sharp and right: the heuristic keeps ${(drawer * 100).toFixed(0)}% of the moves and the search`);
  console.log(`  agrees ${(agree * 100).toFixed(0)}% of the time. There is room for a prior — and`);
  console.log(`  ${(100 - share * 100).toFixed(0)}% of the iterations currently go somewhere other than the answer.`);
}
console.log();
