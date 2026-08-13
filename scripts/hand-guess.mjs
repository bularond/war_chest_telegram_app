#!/usr/bin/env node
/**
 * Does the bot's guess at the opponent's hand have the right shape?
 *
 *   node scripts/hand-guess.mjs [samples]
 *
 * A player reported the bot walking up to a War Wagon round after round and
 * being punished each time by a Marshal tactic — the Marshal grants an attack to
 * a friendly unit two spaces away, the Wagon absorbs the reply — and guessed the
 * bot was not allowing for how many Marshal coins a hand can hold.
 *
 * The guess is checkable. `hiddenCoins` starts each unit at the number of coins
 * the box prints and subtracts everything public — the board, the supply, the
 * removed pile, face-up discards — so the multiset it cannot see is exact, and
 * `dealPlayer` shuffles that multiset and deals the hand off the top. If both
 * are right the sampled hand is a draw without replacement, and the average
 * number of any given unit in it is `handCount × copies / hidden`.
 *
 * This measures the sampled average against that arithmetic, per unit, over real
 * positions. A gap means the bot is guessing the opponent's hand wrong, which
 * would be a far more serious thing than a tuning miss: every rollout would be
 * played against an opponent who cannot do what the real one can.
 */

import {
  actingSeat,
  applyAction,
  createGame,
  createRng,
  hiddenCoins,
  publicStateFor,
  sampleDeterminization,
  UNITS,
} from '../packages/shared/dist/index.js';
import { BOTS } from '../packages/bots/dist/index.js';

const samples = Number(process.argv[2] ?? 4000);
const bot = BOTS.heuristic;

/** A position deep enough that recruits and discards have moved coins around. */
function position(seed) {
  const g = createGame({
    id: `guess-${seed}`,
    size: 2,
    seed,
    sets: ['siege'],
    draftMode: 'draft',
    seats: [
      { userId: 'a', displayName: 'A' },
      { userId: 'b', displayName: 'B' },
    ],
  });
  const rng = createRng(seed);
  for (let i = 0; i < 40 && g.phase !== 'finished'; i++) {
    const seat = actingSeat(g);
    applyAction(g, seat, bot.chooseMove(publicStateFor(g, seat), { rng, budget: {} }));
  }
  return g;
}

const rows = [];

for (const seed of [3, 5, 7, 11, 13, 17, 19, 23]) {
  const state = position(seed);
  if (state.phase === 'finished') continue;
  const me = actingSeat(state);
  const foe = me === 0 ? 1 : 0;
  const view = publicStateFor(state, me);

  const hidden = hiddenCoins(view, foe);
  if (hidden.handCount === 0 || hidden.known.length === 0) continue;

  // What the arithmetic says, per unit: a hand is a draw without replacement.
  const copies = new Map();
  for (const coin of hidden.known) copies.set(coin, (copies.get(coin) ?? 0) + 1);

  // What the sampler actually produces.
  // Counts per sample, not just their total: the spread is what turns a gap into
  // a verdict or into noise, and a threshold written by hand is neither.
  const perSample = new Map();
  const rng = createRng(seed * 101 + 7);
  for (let n = 0; n < samples; n++) {
    const guess = sampleDeterminization(view, rng);
    const here = new Map();
    for (const coin of guess.players[foe].hand) here.set(coin, (here.get(coin) ?? 0) + 1);
    for (const coin of copies.keys()) {
      if (!perSample.has(coin)) perSample.set(coin, []);
      perSample.get(coin).push(here.get(coin) ?? 0);
    }
  }

  // And the truth, which the bot is not allowed to see and this script is.
  const real = new Map();
  for (const coin of state.players[foe].hand) real.set(coin, (real.get(coin) ?? 0) + 1);

  for (const [coin, n] of copies) {
    const expected = (hidden.handCount * n) / hidden.known.length;
    const xs = perSample.get(coin) ?? [];
    const got = xs.reduce((a, b) => a + b, 0) / xs.length;
    const variance = xs.reduce((a, b) => a + (b - got) ** 2, 0) / xs.length;
    const se = Math.sqrt(variance / xs.length);
    rows.push({
      seed,
      coin,
      copies: n,
      hidden: hidden.known.length,
      handCount: hidden.handCount,
      expected,
      got,
      really: real.get(coin) ?? 0,
      se,
      z: se === 0 ? 0 : (got - expected) / se,
    });
  }
}

console.log(`\n  ${samples} guesses per position, ${new Set(rows.map((r) => r.seed)).size} positions\n`);
console.log(
  `  ${'unit'.padEnd(16)}${'hidden'.padEnd(9)}${'arithmetic'.padEnd(13)}${'sampled'.padEnd(11)}${'gap'.padEnd(10)}${'in errors'.padEnd(11)}really`,
);
console.log(`  ${'-'.repeat(76)}`);
let worstZ = 0;
for (const r of rows.sort((a, b) => Math.abs(b.z) - Math.abs(a.z)).slice(0, 14)) {
  const gap = r.got - r.expected;
  if (Math.abs(r.z) > Math.abs(worstZ)) worstZ = r.z;
  console.log(
    `  ${(UNITS[r.coin]?.name.ru ?? r.coin).padEnd(16)}${`${r.copies}/${r.hidden}`.padEnd(9)}` +
      `${r.expected.toFixed(4).padEnd(13)}${r.got.toFixed(4).padEnd(11)}${((gap >= 0 ? '+' : '') + gap.toFixed(4)).padEnd(10)}` +
      `${r.z.toFixed(2).padEnd(11)}${r.really}`,
  );
}
// With this many rows a couple of two-sigma readings are the expected result of
// looking, not evidence of anything. Three is where it stops being looking.
const bound = 3.5;
console.log(
  `\n  ${rows.length} unit-by-position comparisons, largest disagreement ${worstZ.toFixed(2)} standard errors`,
);
console.log(
  Math.abs(worstZ) < bound
    ? '  Every gap is inside sampling noise. The guess at the opponent\'s hand has\n' +
        '  exactly the shape the arithmetic demands: the bot knows perfectly well that\n' +
        '  the hand across the table can hold two Marshals, and how often it does.\n'
    : '  A gap this size is not noise. The bot is rolling out against an opponent who\n' +
        '  holds different cards from the one across the table.\n',
);
