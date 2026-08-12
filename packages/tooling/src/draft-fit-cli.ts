/**
 * Is there anything in the draft beyond the per-unit table?
 *
 *   npm run draft-fit -- --games 3000
 *   npm run draft-fit -- --games 3000 --bot ismcts-200 --out weights/draft.json
 *
 * Plays games with the units dealt at random, then asks whether the outcomes
 * are better explained by "each unit is worth what it is worth" or by "and some
 * pairs are worth more together". The reasoning behind the question is in
 * `draft-fit.ts`: the two-player draft hands out the entire pool, so with
 * additive values the current greedy rule is already optimal and there is
 * nothing to win. Synergy is the only door left.
 *
 * **The number that decides is the held-out loss.** A hundred and twenty pair
 * terms will fit the games they were fitted on better no matter what — that is
 * arithmetic, not evidence. Only an improvement on games the fit never saw
 * means the pairs are in the game rather than in the noise.
 *
 * **Who plays matters more here than anywhere.** The per-unit table measured
 * under the heuristic put the Knight first and the Royal Guard last; measured
 * under the search the Knight is tenth and the Guard fifth. The heuristic
 * cannot play a royal coin, so it reports the Guard as weak — a fact about the
 * heuristic. Default here is the search on a fixed iteration budget: slower
 * than the heuristic by a wide margin, reproducible, and answering about the
 * player the table is for.
 *
 * Options:
 *   --games N      games to play                 (default 2000)
 *   --bot NAME     who plays them                (default ismcts-200)
 *   --sets LIST    expansions, comma separated
 *   --seed N       first seed                    (default 1)
 *   --jobs N       games in flight               (default cores − 2)
 *   --max-plies N  a game called a draw here     (default 1200)
 *   --out FILE     write the fitted model here
 */

import { createGame, UNITS, type UnitId, type UnitSet } from '@wc/shared';
import { writeFileSync } from 'node:fs';
import { fitDraft, notableSynergies, worthTo, type DraftGame } from './draft-fit.js';
import { defaultJobs, MatchPool } from './match-pool.js';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
}

const games = Number(arg('games', '2000'));
const botName = arg('bot', 'ismcts-200');
const setsArg = arg('sets', '');
const sets = setsArg === '' ? [] : (setsArg.split(',') as UnitSet[]);
const baseSeed = Number(arg('seed', '1'));
const jobs = Number(arg('jobs', String(defaultJobs())));
const maxPlies = Number(arg('max-plies', '1200'));
const outPath = arg('out', '');

/**
 * Who held what, worked out from the seed rather than reported by the worker.
 *
 * A dealt game's allocation depends on the seed, the board size and the boxes
 * in play — nothing else, and not on which bot sat where. So the rosters can be
 * rebuilt here exactly, and the worker protocol does not have to grow a field.
 */
function rosterFor(seed: number): [UnitId[], UnitId[]] {
  const state = createGame({
    id: `roster-${seed}`,
    size: 2,
    seed,
    sets,
    draftMode: 'random',
    seats: [
      { userId: 's0', displayName: 'A' },
      { userId: 's1', displayName: 'B' },
    ],
  });
  return [[...(state.players[0]?.units ?? [])], [...(state.players[1]?.units ?? [])]];
}

const spec = { kind: 'named' as const, name: botName };
const pool = new MatchPool(spec, spec, { sets, draftMode: 'random', maxPlies, jobs });

const observed: DraftGame[] = [];
const started = Date.now();
let played = 0;
let next = 0;

console.log(`\n  ${games} games by ${botName}, ${jobs} at a time${sets.length ? `, sets: ${sets.join(', ')}` : ''}\n`);

await pool.playStream(
  () => (next * 2 >= games ? null : { pair: next, seed: baseSeed + next++ }),
  (halves, request) => {
    const [a, b] = rosterFor(request.seed);
    for (const half of halves) {
      // `scoreA` is the score of whoever the pool called A, and that side swaps
      // between the two halves. The model is written from seat 0's side.
      const seat0 = half.aSeat === 0 ? half.scoreA : 1 - half.scoreA;
      observed.push({ a, b, scoreA: seat0 });
      played++;
    }
    if (played % 100 === 0) {
      const rate = played / ((Date.now() - started) / 60000);
      process.stdout.write(`\r  ${played}/${games} games, ${rate.toFixed(0)}/min`);
    }
  },
  () => true,
);
await pool.close();

console.log(`\n\n  ${observed.length} games in ${((Date.now() - started) / 60000).toFixed(1)} min\n`);

const report = fitDraft(observed);
const drop = report.heldOut.additive - report.heldOut.withPairs;

console.log(`  units in play                 ${report.additive.units.length}`);
console.log(`  first move is worth           ${report.additive.firstMove.toFixed(3)} log-odds`);
console.log();
console.log(`  ${'model'.padEnd(22)}${'on its own games'.padEnd(20)}on games it never saw`);
console.log(`  ${'-'.repeat(62)}`);
console.log(
  `  ${'unit values only'.padEnd(22)}${report.onTrain.additive.toFixed(5).padEnd(20)}${report.heldOut.additive.toFixed(5)}`,
);
console.log(
  `  ${'and pair terms'.padEnd(22)}${report.onTrain.withPairs.toFixed(5).padEnd(20)}${report.heldOut.withPairs.toFixed(5)}`,
);

console.log();
if (drop <= 0.0005) {
  console.log(`  Held-out loss did not improve (${drop >= 0 ? '−' : '+'}${Math.abs(drop).toFixed(5)}).`);
  console.log('  The pairs are noise with names. The draft is additive as far as this many');
  console.log('  games can see, which means the greedy table is already the right policy and');
  console.log('  the remaining gain in the draft is zero — worth knowing, and worth not');
  console.log('  spending a night on a synergy table that measures nothing.');
} else {
  console.log(`  Held-out loss improved by ${drop.toFixed(5)}. The pairs carry something the`);
  console.log('  per-unit table cannot say, so a draft policy that reads what it already');
  console.log('  holds has room to beat one that does not. Next step is the policy and an');
  console.log('  SPRT against `measured-all` — this is evidence for building it, not a result.');

  console.log(`\n  ${'pair'.padEnd(34)}together`);
  console.log(`  ${'-'.repeat(50)}`);
  for (const s of notableSynergies(report.withPairs)) {
    const [one, two] = s.units;
    console.log(
      `  ${`${UNITS[one].name.ru} + ${UNITS[two].name.ru}`.padEnd(34)}${s.value >= 0 ? '+' : ''}${s.value.toFixed(3)}`,
    );
  }
}

if (outPath) {
  writeFileSync(
    outPath,
    `${JSON.stringify(
      {
        bot: botName,
        sets,
        games: observed.length,
        heldOut: report.heldOut,
        onTrain: report.onTrain,
        model: report.withPairs,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`\n  written to ${outPath}`);
}

// A last sanity line: what the model would draft first from a fresh pool, with
// nothing held. It must agree with the per-unit ordering — if it does not, the
// pair terms are being read where they do not apply.
const best = [...report.withPairs.units]
  .sort((x, y) => worthTo(report.withPairs, y, []) - worthTo(report.withPairs, x, []))
  .slice(0, 5);
console.log(`\n  first pick, holding nothing: ${best.map((u) => UNITS[u].name.ru).join(', ')}\n`);
