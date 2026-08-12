#!/usr/bin/env node
/**
 * Can a feature tell the moves at the root apart?
 *
 *   node scripts/feature-power.mjs [rollouts per move] [positions]
 *
 * This is the only question an evaluation term has to answer. A search picks a
 * move by comparing what it is worth to play each one; a feature that reads the
 * same after every move at the root cannot change that choice, whatever its
 * weight, however wide its spread over a corpus and however sound the reasoning
 * behind it.
 *
 * So for each position it plays every root move, rolls out from each many times,
 * and asks two things per feature:
 *
 *  - **signal** — the spread of the feature's mean across the root moves. This
 *    is what the search can order by.
 *  - **noise** — the standard error of one of those means. Signal below noise is
 *    not signal; it is the same number measured a few dozen times.
 *
 * **This is a sieve, not a ranking, and the difference matters.** A low ratio is
 * a real verdict: the term cannot change any choice the search makes, so a match
 * on it would measure nothing. A high ratio says almost nothing. The printout
 * carries `THE CONTROL` to make that impossible to forget — a hash of the root
 * move, constant down every rollout beneath it, knowing nothing whatever about
 * the position. It scores infinitely, because its noise is zero.
 *
 * The reason is that separating power sums two things that could not be more
 * different: a term that reflects a real difference between the positions the
 * moves lead to, and a term that merely restates *which move was played*. The
 * search already knows which move it played. `initiative` tops the real features
 * at 29 and was rejected in matches at 0.1 and at 0.02; `tempo` scores 13 and
 * cost 51 Elo. Whether a term knows anything about winning is a question for a
 * fit against outcomes with a held-out set, and after that for a match.
 *
 * Written after `feature-drift.mjs` was found to descend by taking `legal[0]` at
 * every step — the same move every time, so its "within a position" column
 * measured the variation left by the determinization and the rollout and not the
 * variation between branches at all. That understated exactly the features that
 * answer to which move was played, and `initiative` came out at a flat zero on
 * it while the bot spends a tenth of its turns claiming the marker. This script
 * then repeated the same mistake in a smaller way — it took the first fourteen
 * legal moves, and `legalActions` emits them grouped by coin and by kind, so it
 * was looking at two coins out of three and at no attack or claim at all. Both
 * are fixed here; the lesson that is not fixable is that an instrument wants a
 * control in it from the first line.
 */

import {
  actingSeat,
  actionKey,
  applyAction,
  createGame,
  createRng,
  isTerminal,
  legalMoves,
  nextFloat,
  publicStateFor,
  sampleDeterminization,
  simulate,
} from '../packages/shared/dist/index.js';
import { featureVector, FEATURES, HeuristicBot, DEFAULT_SEARCH, BASE_WEIGHTS } from '../packages/bots/dist/index.js';

const perMove = Number(process.argv[2] ?? 80);
const wanted = Number(process.argv[3] ?? 6);
const MAX_MOVES = 14;

/** A mid-game position, reached the way a real game reaches one. */
function position(seed) {
  const g = createGame({
    id: `power-${seed}`,
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

/** A fixed-size sample without replacement, drawn reproducibly. */
function pick(items, n, rng) {
  const pool = [...items];
  const out = [];
  while (out.length < n && pool.length > 0) {
    out.push(...pool.splice(Math.floor(nextFloat(rng) * pool.length), 1));
  }
  return out;
}

const sd = (xs) => {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
};

/** Per feature: the spread across root moves, and the error on one move's mean. */
const NAMES = [...FEATURES, 'THE CONTROL'];
const signal = new Map(NAMES.map((f) => [f, []]));
const noise = new Map(NAMES.map((f) => [f, []]));
let positions = 0;
let movesSeen = 0;

for (let seed = 3; positions < wanted && seed < 200; seed += 2) {
  const g = position(seed);
  if (g.phase === 'finished') continue;
  const view = publicStateFor(g, actingSeat(g));
  if (view.legal.length < 4) continue;
  positions++;

  // Sampled, not sliced. `legalActions` emits moves grouped by coin and then by
  // kind, so the first fourteen of thirty-one came from two coins out of three
  // and contained no attack and no claim — the same defect as descending by
  // `legal[0]`, one step further along.
  const moves = pick(view.legal, MAX_MOVES, createRng(seed * 31 + 5));
  movesSeen += moves.length;
  const rng = createRng(seed * 977 + 11);

  // One list of leaf readings per root move, per feature.
  const perMoveMeans = FEATURES.map(() => []).concat([[]]);
  const perMoveErrors = FEATURES.map(() => []).concat([[]]);

  for (const move of moves) {
    const leaves = FEATURES.map(() => []);
    leaves.push([]);
    let moveId = 0;
    for (const ch of actionKey(move)) moveId = (moveId * 31 + ch.charCodeAt(0)) % 1000;
    moveId /= 1000;
    for (let n = 0; n < perMove; n++) {
      let s = sampleDeterminization(view, rng);
      // The move has to be legal in *this* guess at the hidden cards; when it is
      // not, the sample simply does not speak about that move.
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
      const f = featureVector(s, view.you);
      FEATURES.forEach((_, fi) => leaves[fi].push(f[fi]));
      // The control. It reads nothing about the position at all — it is a hash
      // of the move that was played at the root, constant down every rollout
      // under that move. If the metric cannot tell this apart from a real
      // feature, then a high score on the metric means nothing on its own.
      leaves[FEATURES.length].push(moveId);
    }
    leaves.forEach((xs, fi) => {
      if (xs.length < 4) return;
      perMoveMeans[fi].push(xs.reduce((a, b) => a + b, 0) / xs.length);
      perMoveErrors[fi].push(sd(xs) / Math.sqrt(xs.length));
    });
  }

  NAMES.forEach((name, fi) => {
    if (perMoveMeans[fi].length < 3) return;
    signal.get(name).push(sd(perMoveMeans[fi]));
    noise.get(name).push(perMoveErrors[fi].reduce((a, b) => a + b, 0) / perMoveErrors[fi].length);
  });
}

const mean = (xs) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

console.log(
  `\n  ${positions} positions, ${(movesSeen / positions).toFixed(1)} root moves each, ` +
    `${perMove} rollouts per move\n`,
);
console.log(`  ${'feature'.padEnd(14)}${'signal'.padEnd(10)}${'noise'.padEnd(10)}${'ratio'.padEnd(9)}verdict`);
console.log(`  ${'-'.repeat(66)}`);

const rows = NAMES.map((name) => {
  const s = mean(signal.get(name));
  const n = mean(noise.get(name));
  return { name, s, n, ratio: n === 0 ? 0 : s / n };
}).sort((a, b) => b.ratio - a.ratio);

for (const r of rows) {
  const verdict =
    r.ratio < 1 ? 'cannot separate the moves at all' : r.ratio < 2 ? 'barely separates them' : '';
  console.log(
    `  ${r.name.padEnd(14)}${r.s.toFixed(4).padEnd(10)}${r.n.toFixed(4).padEnd(10)}${r.ratio.toFixed(1).padEnd(9)}${verdict}`,
  );
}

/**
 * What each weight is actually worth at the root.
 *
 * A weight on its own says nothing, because the features are not on one scale:
 * `initiative` swings by 0.45 between root moves and `reserve` by 0.01, so the
 * same number in front of them buys forty times more influence in one case than
 * the other. Multiplying weight by signal puts them all in the same currency —
 * how far this term moves the gap between one root move and another — and that
 * is the number a tuner should be reasoning about.
 *
 * The point of printing it: a feature tested at an influence five times any
 * accepted term was not tested in a band where it could have been accepted.
 */
console.log(`\n  ${'feature'.padEnd(14)}${'weight'.padEnd(10)}${'signal'.padEnd(10)}${'influence'.padEnd(12)}`);
console.log(`  ${'-'.repeat(52)}`);
const live = rows
  .map((r) => ({ ...r, w: BASE_WEIGHTS[r.name] ?? 0 }))
  .filter((r) => r.w !== 0)
  .sort((a, b) => Math.abs(b.w * b.s) - Math.abs(a.w * a.s));
for (const r of live) {
  console.log(
    `  ${r.name.padEnd(14)}${String(r.w).padEnd(10)}${r.s.toFixed(4).padEnd(10)}${(r.w * r.s).toFixed(4)}`,
  );
}
const band = live.map((r) => Math.abs(r.w * r.s));
const lo = Math.min(...band);
const hi = Math.max(...band);
console.log(`\n  the band the accepted terms live in: ${lo.toFixed(4)} … ${hi.toFixed(4)}`);
console.log(`\n  ${'feature'.padEnd(14)}${'weight for'.padEnd(14)}${'weight for'}`);
console.log(`  ${''.padEnd(14)}${lo.toFixed(4).padEnd(14)}${hi.toFixed(4)}`);
console.log(`  ${'-'.repeat(44)}`);
for (const r of rows) {
  if (r.s < 1e-6 || (BASE_WEIGHTS[r.name] ?? 0) !== 0) continue;
  console.log(`  ${r.name.padEnd(14)}${(lo / r.s).toFixed(3).padEnd(14)}${(hi / r.s).toFixed(3)}`);
}

const dead = rows.filter((r) => r.ratio < 1).map((r) => r.name);
console.log(
  dead.length === 0
    ? '\n  Every feature separates the root moves by more than the error on the\n  measurement. A match on any of them is a match on the feature.\n'
    : `\n  Reads the same after every root move: ${dead.join(', ')}.\n` +
        '  These cannot change a choice the search makes, whatever weight they carry,\n' +
        '  so a null verdict on them in a match is a verdict on nothing.\n',
);
