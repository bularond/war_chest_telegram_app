#!/usr/bin/env node
/**
 * Does the bot really play two units out of four, and does it help?
 *
 *   node scripts/unit-usage.mjs [games]
 *
 * A player watching it said the bot puts everything on the board and then drives
 * only two or three of its four units, leaving the rest standing. That is either
 * a strategy — concentration is a real one in a game where you spend a unit's own
 * coin to move it — or the evaluation paying for coins on the board and the bot
 * discovering it has nothing left to move them with.
 *
 * The two are told apart by the result, not by argument. So this counts, per side
 * per game, how the driving actions were spread across the four drafted units and
 * how many units were deployed and then never driven at all — and then reports
 * those numbers separately for the games that side won and lost.
 *
 * If the concentrated games are the won games, it is a strategy and the bot found
 * it. If they are the lost games, the bot is doing it anyway and something is
 * paying it to.
 */

import {
  actingSeat,
  applyAction,
  createGame,
  createRng,
  publicStateFor,
} from '../packages/shared/dist/index.js';
import { boardFor } from '../packages/shared/dist/index.js';
import { BOTS } from '../packages/bots/dist/index.js';

const board = boardFor(2);

const games = Number(process.argv[2] ?? 60);
const bot = BOTS['ismcts-200'];

/** Which unit an action drives, where the action drives one at all. */
function subject(state, seat, action) {
  const at = (hex) => state.units[hex]?.unit;
  switch (action.type) {
    case 'move':
    case 'attack':
      return at(action.from);
    case 'control':
    case 'bolster':
      return at(action.at);
    case 'tactic':
      return at(action.from ?? action.at);
    case 'deploy': {
      const hand = state.players[seat]?.hand ?? [];
      return hand[action.coin];
    }
    case 'recruit':
      return action.unit;
    default:
      return undefined;
  }
}

const rows = [];

for (let g = 0; g < games; g++) {
  const state = createGame({
    id: `usage-${g}`,
    size: 2,
    seed: 4000 + g,
    draftMode: 'draft',
    seats: [
      { userId: 'a', displayName: 'A' },
      { userId: 'b', displayName: 'B' },
    ],
  });
  const rng = createRng(g * 13 + 5);

  // Per seat: driving actions per unit, and which units ever reached the board.
  const drives = [new Map(), new Map()];
  const deployed = [new Set(), new Set()];
  let plies = 0;

  while (state.phase !== 'finished' && plies < 600) {
    const seat = actingSeat(state);
    const action = bot.chooseMove(publicStateFor(state, seat), { rng, budget: {} });
    if (state.phase === 'playing') {
      const unit = subject(state, seat, action);
      if (unit) {
        if (action.type === 'deploy') deployed[seat].add(unit);
        // Driving means making the unit do something on the board. Deploying it
        // and recruiting more of it are not that — they are what fills the board
        // in the first place, which is exactly what is under suspicion.
        if (action.type === 'move' || action.type === 'attack' || action.type === 'control' || action.type === 'tactic') {
          drives[seat].set(unit, (drives[seat].get(unit) ?? 0) + 1);
        }
      }
    }
    applyAction(state, seat, action);
    plies++;
  }
  if (state.phase !== 'finished') continue;

  // Where the ones nobody moved ended up. A unit standing on a location its own
  // side controls is not idle — it is the thing holding the marker down, and the
  // marker is the win condition. That is the difference between a garrison and a
  // wasted coin, and it is the whole question.
  const standing = [new Map(), new Map()];
  for (const [hex, stack] of Object.entries(state.units)) {
    const held = state.control[hex] === stack.team;
    const isLoc = state.control[hex] !== undefined || board.locations.includes(hex);
    const key = stack.unit;
    const m = standing[stack.seat];
    const prev = m.get(key) ?? { onHeld: 0, onLoc: 0, anywhere: 0 };
    prev.anywhere++;
    if (isLoc) prev.onLoc++;
    if (isLoc && held) prev.onHeld++;
    m.set(key, prev);
  }

  for (const seat of [0, 1]) {
    const units = state.players[seat].units;
    const counts = units.map((u) => drives[seat].get(u) ?? 0);
    const total = counts.reduce((a, b) => a + b, 0);
    if (total === 0) continue;
    const sorted = [...counts].sort((a, b) => b - a);
    rows.push({
      won: state.winner === null ? 0.5 : state.winner === state.players[seat].team ? 1 : 0,
      top2: (sorted[0] + sorted[1]) / total,
      used: counts.filter((c) => c > 0).length,
      // Deployed and then never driven: the shape the complaint describes.
      stranded: units.filter((u) => deployed[seat].has(u) && (drives[seat].get(u) ?? 0) === 0).length,
      strandedOnHeld: units.filter(
        (u) =>
          deployed[seat].has(u) &&
          (drives[seat].get(u) ?? 0) === 0 &&
          (standing[seat].get(u)?.onHeld ?? 0) > 0,
      ).length,
      strandedStillThere: units.filter(
        (u) =>
          deployed[seat].has(u) &&
          (drives[seat].get(u) ?? 0) === 0 &&
          (standing[seat].get(u)?.anywhere ?? 0) > 0,
      ).length,
      drives: total,
      plies,
    });
  }
}

const mean = (xs) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
const won = rows.filter((r) => r.won === 1);
const lost = rows.filter((r) => r.won === 0);

console.log(`\n  ${rows.length} sides over ${games} games, played by ismcts-200\n`);
console.log(`  ${'measure'.padEnd(38)}${'won'.padEnd(10)}${'lost'.padEnd(10)}all`);
console.log(`  ${'-'.repeat(66)}`);
const line = (name, f, digits = 2) =>
  console.log(
    `  ${name.padEnd(38)}${mean(won.map(f)).toFixed(digits).padEnd(10)}${mean(lost.map(f)).toFixed(digits).padEnd(10)}${mean(rows.map(f)).toFixed(digits)}`,
  );
line('units driven at all, of four', (r) => r.used);
line('share of driving by the top two', (r) => r.top2);
line('deployed and never driven', (r) => r.stranded);
line('...of those, still on the board at the end', (r) => r.strandedStillThere);
line('...of those, holding a location of ours', (r) => r.strandedOnHeld);
line('driving actions in the game', (r) => r.drives, 1);

// The distribution, since an average of 3.1 can hide a great many 2s.
const spread = new Map();
for (const r of rows) spread.set(r.used, (spread.get(r.used) ?? 0) + 1);
console.log(`\n  how many of the four were driven at all`);
for (const k of [...spread.keys()].sort()) {
  const share = (spread.get(k) / rows.length) * 100;
  console.log(`  ${k}: ${share.toFixed(1).padStart(5)}%  ${'█'.repeat(Math.round(share / 2))}`);
}

const gap = mean(won.map((r) => r.top2)) - mean(lost.map((r) => r.top2));
console.log(
  `\n  concentration in won games minus lost games: ${gap >= 0 ? '+' : ''}${gap.toFixed(3)}`,
);
console.log(
  Math.abs(gap) < 0.02
    ? '  Concentration says nothing about the result either way.\n'
    : gap > 0
      ? '  The concentrated games are the won games: it is a strategy, not a fault.\n'
      : '  The concentrated games are the lost games: the bot is doing this and paying\n  for it, which means something in the evaluation is buying it.\n',
);
