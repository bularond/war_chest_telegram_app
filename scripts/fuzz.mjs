/**
 * Heavy fuzzer: random games until something breaks.
 *
 * The vitest suite runs a handful of games on every commit; this one is meant
 * to be left running for tens of thousands. A failure prints the seed, the ply
 * and the action, and the game replays exactly from that seed.
 *
 *   npm run build && npm run fuzz -- --games 20000
 *   npm run fuzz -- --games 500 --check every-ply --sets nobility,siege,nightfall
 *
 * Options:
 *   --games N       how many games to play          (default 2000)
 *   --from N        first seed                      (default 1)
 *   --check MODE    every-ply | end                 (default every-ply)
 *   --sets LIST     comma separated, or "mix" to cycle over all combinations
 *   --policy NAME   sane | uniform                  (default sane)
 *   --max-plies N   give up on a game after N plies (default 4000)
 */

import {
  checkInvariants,
  createRng,
  isTerminal,
  legalMoves,
  markersRemaining,
  playRandomGame,
  randomPolicy,
  uniformPolicy,
} from '@wc/shared';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const games = Number(arg('games', 2000));
const from = Number(arg('from', 1));
const check = arg('check', 'every-ply');
const maxPlies = Number(arg('max-plies', 4000));
const policy = arg('policy', 'sane') === 'uniform' ? uniformPolicy : randomPolicy;

const SET_MIXES = [
  [],
  ['nobility'],
  ['siege'],
  ['nightfall'],
  ['nobility', 'siege'],
  ['siege', 'nightfall'],
  ['nobility', 'nightfall'],
  ['nobility', 'siege', 'nightfall'],
];
const setsArg = arg('sets', 'mix');
const mixes = setsArg === 'mix' ? SET_MIXES : [setsArg === '' ? [] : setsArg.split(',')];

function fail(seed, sets, ply, action, problems) {
  console.error(
    `\nFAIL seed=${seed} sets=[${sets.join(',')}] ply=${ply}\n` +
      `  action: ${JSON.stringify(action)}\n` +
      problems.map((p) => `  - ${p}`).join('\n'),
  );
  process.exit(1);
}

const started = Date.now();
let plies = 0;
let finished = 0;
let stalemates = 0;
let unfinished = 0;
const lengths = [];

for (let i = 0; i < games; i++) {
  const seed = from + i;
  const sets = mixes[i % mixes.length];
  const rng = createRng(seed);
  let result;
  try {
    result = playRandomGame(
      {
        seed,
        sets,
        maxPlies,
        policy,
        onStep:
          check === 'every-ply'
            ? (state, action, ply) => {
                const bad = checkInvariants(state);
                if (bad.length > 0) fail(seed, sets, ply, action, bad);
              }
            : undefined,
      },
      rng,
    );
  } catch (err) {
    fail(seed, sets, '?', null, [String(err && err.stack ? err.stack : err)]);
  }

  const { state } = result;
  const bad = checkInvariants(state);
  if (bad.length > 0) fail(seed, sets, result.plies, null, bad);

  plies += result.plies;
  lengths.push(result.plies);
  if (isTerminal(state)) {
    finished++;
    if (state.winner === null) {
      stalemates++;
      if (state.log.at(-1)?.kind !== 'stalemate') {
        fail(seed, sets, result.plies, null, ['finished with no winner and no stalemate in the log']);
      }
    } else if (markersRemaining(state, state.winner) !== 0) {
      fail(seed, sets, result.plies, null, ['declared a winner that has markers left']);
    }
  } else {
    unfinished++;
    // Not a deadlock as long as somebody can still act.
    if (legalMoves(state).length === 0) {
      fail(seed, sets, result.plies, null, ['ran out of legal actions before the game ended']);
    }
  }

  if ((i + 1) % 200 === 0 || i + 1 === games) {
    const secs = (Date.now() - started) / 1000;
    process.stdout.write(
      `\r${i + 1}/${games} games, ${plies} plies, ${(plies / secs).toFixed(0)} plies/s`,
    );
  }
}

lengths.sort((a, b) => a - b);
const secs = (Date.now() - started) / 1000;
console.log(
  `\nOK: ${games} games in ${secs.toFixed(1)}s — ` +
    `${finished} finished (${stalemates} stalemates), ${unfinished} hit the ply cap; ` +
    `median ${lengths[Math.floor(lengths.length / 2)]} plies, longest ${lengths.at(-1)}`,
);
