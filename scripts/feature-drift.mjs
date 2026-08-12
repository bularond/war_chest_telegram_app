#!/usr/bin/env node
/**
 * Does a feature read the position, or the shape of the search?
 *
 *   node scripts/feature-drift.mjs [samples]
 *
 * The evaluation is called at the end of a rollout, and the rollout starts
 * wherever the tree descent stopped — which is a different depth on every
 * branch. Anything that reads differently for the two sides therefore risks
 * measuring *how deep this branch went* rather than *how good this position is*,
 * and a search comparing branches of different depths is then comparing an
 * artefact.
 *
 * This walks the same path the search does at several descent depths and prints
 * each feature's mean at the leaf. A feature whose mean moves with depth is
 * suspect: its verdict in a match says nothing about the feature.
 *
 * Written after `tempo` was measured at −51 Elo and turned out to be exactly
 * this: −0.52 at zero descent, +0.02 at four. The number was real; what it
 * measured was not tempo.
 */

import {
  actingSeat,
  applyAction,
  createGame,
  createRng,
  legalMoves,
  publicStateFor,
  sampleDeterminization,
  simulate,
} from '../packages/shared/dist/index.js';
import { featureVector, FEATURES, HeuristicBot, DEFAULT_SEARCH } from '../packages/bots/dist/index.js';

const samples = Number(process.argv[2] ?? 400);
const depths = [0, 2, 4, 6];

/** A mid-game position, reached the way the bot would reach it. */
function position(seed) {
  const g = createGame({
    id: `drift-${seed}`,
    size: 2,
    seed,
    draftMode: 'random',
    seats: [
      { userId: 'a', displayName: 'A' },
      { userId: 'b', displayName: 'B' },
    ],
  });
  const walk = createRng(seed);
  for (let i = 0; i < 24 && g.phase !== 'finished'; i++) {
    const seat = actingSeat(g);
    applyAction(g, seat, HeuristicBot.chooseMove(publicStateFor(g, seat), { rng: walk, budget: {} }));
  }
  return g;
}

const means = new Map(FEATURES.map((f) => [f, depths.map(() => 0)]));
const counts = depths.map(() => 0);
/** Everything a feature said, so its spread and its silence can be read too. */
const all = new Map(FEATURES.map((f) => [f, []]));

for (const seed of [3, 5, 7, 11, 13]) {
  const view = publicStateFor(position(seed), actingSeat(position(seed)));
  const rng = createRng(seed * 31 + 7);

  depths.forEach((descent, di) => {
    for (let n = 0; n < samples; n++) {
      let s = sampleDeterminization(view, rng);
      for (let d = 0; d < descent; d++) {
        const legal = legalMoves(s);
        if (legal.length === 0 || s.phase === 'finished') break;
        s = simulate(s, legal[0], actingSeat(s));
      }
      for (let d = 0; d < DEFAULT_SEARCH.rolloutDepth; d++) {
        const legal = legalMoves(s);
        if (legal.length === 0 || s.phase === 'finished') break;
        const seat = actingSeat(s);
        s = simulate(s, HeuristicBot.chooseMove({ ...publicStateFor(s, seat), legal }, { rng, budget: {} }), seat);
      }
      const f = featureVector(s, view.you);
      FEATURES.forEach((name, fi) => {
        means.get(name)[di] += f[fi];
        all.get(name).push(f[fi]);
      });
      counts[di]++;
    }
  });
}

console.log(`\n  ${samples * 5} leaves per depth, five positions\n`);
console.log(`  ${'feature'.padEnd(14)}${depths.map((d) => `descent ${d}`.padEnd(12)).join('')}drift`);
console.log(`  ${'-'.repeat(14 + depths.length * 12 + 8)}`);

const suspects = [];
for (const name of FEATURES) {
  const row = means.get(name).map((sum, i) => sum / counts[i]);
  const drift = Math.max(...row) - Math.min(...row);
  if (drift > 0.15) suspects.push(name);
  console.log(
    `  ${name.padEnd(14)}${row.map((x) => x.toFixed(3).padEnd(12)).join('')}${drift.toFixed(3)}` +
      (drift > 0.15 ? '  ←' : ''),
  );
}

console.log(`\n  ${'feature'.padEnd(14)}${'spread'.padEnd(10)}${'silent'.padEnd(10)}what that means`);
console.log(`  ${'-'.repeat(60)}`);
for (const name of FEATURES) {
  const xs = all.get(name);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
  const silent = xs.filter((x) => Math.abs(x) < 0.02).length / xs.length;
  // A feature that is nearly always zero cannot move a search whatever its
  // weight, so a null verdict on it says nothing about the idea behind it.
  const note = sd < 0.05 ? 'says almost nothing, anywhere' : silent > 0.7 ? 'silent in most positions' : '';
  console.log(`  ${name.padEnd(14)}${sd.toFixed(3).padEnd(10)}${(silent * 100).toFixed(0).padEnd(9)}% ${note}`);
}

console.log(
  suspects.length === 0
    ? '\n  Nothing drifts with depth. A verdict on any of these is a verdict on the\n  feature.\n'
    : `\n  Drifting with depth: ${suspects.join(', ')}.\n` +
        '  These read the shape of the search as much as the position, so a match\n' +
        '  on them measures the search, not the feature. Level the leaves first.\n',
);
