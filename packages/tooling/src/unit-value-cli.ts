/**
 * What each unit is worth, measured rather than argued.
 *
 *   npm run unit-value -- --games 4000
 *   npm run unit-value -- --games 4000 --bot ismcts-200 --sets nobility
 *
 * Deals units at random, plays the game out, and counts how often each unit was
 * on the winning side. No search is needed for the question, so this is minutes
 * rather than hours.
 *
 * **Why this exists.** The bot's draft rule — take the unit the box prints most
 * of — was measured against its opposite and against drafting at random, and all
 * three came out within ten Elo of each other. That is either "the draft does not
 * matter" or "none of these three rules knows anything". The two are told apart
 * here: if unit win rates are all flat, no draft rule can help; if some units
 * are plainly better, the bot has been leaving that on the table.
 *
 * **What the number is not.** A unit's win rate here is confounded by the three
 * it was dealt alongside and by the four it faced. It ranks units under random
 * play with random partners, which is the right first question and not the last
 * one. Synergy — which pairs work together — needs a different measurement.
 *
 * Options:
 *   --games N      games to play              (default 3000)
 *   --bot NAME     who plays them             (default heuristic)
 *   --sets LIST    expansions, comma separated
 *   --seed N       first game's seed          (default 1)
 *   --json FILE    write the raw counts here as well
 *
 * **On `--json`.** The measurement is one game after another on one core, and a
 * search plays them slowly. Splitting the seeds across several processes and
 * adding the counts up afterwards is exact — games are independent — so the raw
 * tallies are written out for that.
 */

import { BOTS } from '@wc/bots';
import {
  actingSeat,
  applyAction,
  createGame,
  createRng,
  publicStateFor,
  UNITS,
  type GameState,
  type UnitId,
  type UnitSet,
} from '@wc/shared';
import { writeFileSync } from 'node:fs';
import { wilson } from './stats.js';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
}

const games = Number(arg('games', '3000'));
const botName = arg('bot', 'heuristic');
const setsArg = arg('sets', '');
const sets = setsArg === '' ? [] : (setsArg.split(',') as UnitSet[]);
const baseSeed = Number(arg('seed', '1'));

const bot = BOTS[botName];
if (!bot) throw new Error(`unknown bot "${botName}"`);

const played = new Map<UnitId, number>();
const won = new Map<UnitId, number>();
const started = Date.now();
let finished = 0;

for (let g = 0; g < games; g++) {
  const seed = baseSeed + g;
  const state: GameState = createGame({
    id: `value-${seed}`,
    size: 2,
    seed,
    sets,
    draftMode: 'random',
    seats: [
      { userId: 'a', displayName: 'A' },
      { userId: 'b', displayName: 'B' },
    ],
  });
  const rng = createRng(seed * 3 + 1);

  let plies = 0;
  while (state.phase !== 'finished' && plies < 1200) {
    const seat = actingSeat(state);
    applyAction(state, seat, bot.chooseMove(publicStateFor(state, seat), { rng, budget: {} }));
    plies++;
  }
  if (state.phase !== 'finished') continue;
  finished++;

  for (const p of state.players) {
    // A draw counts as half for everyone who was there, which is what a draw is.
    const score = state.winner === null ? 0.5 : state.winner === p.team ? 1 : 0;
    for (const unit of p.units) {
      played.set(unit, (played.get(unit) ?? 0) + 1);
      won.set(unit, (won.get(unit) ?? 0) + score);
    }
  }

  if ((g + 1) % 500 === 0) {
    process.stdout.write(`\r  ${g + 1}/${games} games, ${((Date.now() - started) / 1000).toFixed(0)}s`);
  }
}

console.log(`\n\n  ${finished} games finished, played by ${botName}\n`);

const jsonPath = arg('json', '');
if (jsonPath) {
  writeFileSync(
    jsonPath,
    `${JSON.stringify(
      {
        bot: botName,
        sets,
        games: finished,
        played: Object.fromEntries(played),
        won: Object.fromEntries(won),
      },
      null,
      2,
    )}\n`,
  );
}

const rows = [...played.entries()]
  .map(([unit, n]) => {
    const rate = (won.get(unit) ?? 0) / n;
    return { unit, n, rate, ci: wilson(won.get(unit) ?? 0, n) };
  })
  .sort((a, b) => b.rate - a.rate);

console.log(`  ${'unit'.padEnd(16)}${'games'.padEnd(8)}${'win rate'.padEnd(12)}95%`);
console.log(`  ${'-'.repeat(52)}`);
for (const r of rows) {
  console.log(
    `  ${r.unit.padEnd(16)}${String(r.n).padEnd(8)}${(r.rate * 100).toFixed(1).padEnd(12)}` +
      `[${(r.ci.lo * 100).toFixed(1)} … ${(r.ci.hi * 100).toFixed(1)}]  ${UNITS[r.unit].coins} coins`,
  );
}

const best = rows[0];
const worst = rows.at(-1);
if (best && worst) {
  const spread = (best.rate - worst.rate) * 100;
  console.log(`\n  spread ${spread.toFixed(1)} points, ${best.unit} to ${worst.unit}`);
  console.log(
    spread < 4
      ? '  Flat. No draft rule can help if the units are this close, which would\n' +
          '  explain why three different rules measured the same.'
      : '  Not flat. There is something for a draft rule to know, and the current\n' +
          '  one — take the unit the box prints most of — evidently does not know it.',
  );
}
console.log();
