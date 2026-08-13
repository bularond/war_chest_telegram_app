/**
 * Fits the evaluation weights to the outcomes of self-play.
 *
 *   npm run regress -- --games 4000 --out weights/fitted.json
 *   npm run regress -- --games 4000 --bot heuristic --sets nobility,siege,nightfall
 *
 * Plays a pile of games with a bot that needs no thinking time, remembers a
 * handful of positions from each with the result that followed, and fits the
 * weights to that. Minutes on one core, against a night for a coordinate
 * descent — because nothing here searches.
 *
 * **Read the output as a candidate, not as an answer.** Two reasons, and both
 * matter more than the arithmetic:
 *
 * - The label is who won *under the collecting policy*. Fit on heuristic games,
 *   these are the weights that predict heuristic games. That is a proxy, and the
 *   only thing that tells you whether the proxy held is a match:
 *   `npm run sprt -- --a weights/base.json --b weights/fitted.json`.
 * - Positions from one game share a deal, an opening and a winner, so they are
 *   nothing like independent. Each game's positions are down-weighted to count
 *   as one game between them, which is the cheap version of the right fix.
 *
 * Options:
 *   --games N        games to collect from            (default 2000)
 *   --per-game N     positions sampled per game       (default 6)
 *   --bot NAME       who plays them                   (default heuristic)
 *   --sets LIST      expansions, comma separated
 *   --draft MODE     random | draft | ban             (default random)
 *   --skip N         plies to ignore at the start     (default 12)
 *   --seed N         first game's seed                (default 1)
 *   --steps N        gradient steps                   (default 400)
 *   --target WHAT    outcome | value                   (default outcome)
 *   --weights FILE   weights the collecting search plays with (default: the built-in ones)
 *   --iterations N   how deep that search looks              (default 200)
 *   --out FILE       where the fitted weights are written
 *
 * **`--target value` asks a different question.** Instead of "who won from
 * here", it fits the evaluation to what the search itself thought the position
 * was worth — the value backed up at its root, which is the same position seen
 * a few plies deeper. That is not circular: the search knows something the
 * evaluation does not, and this pulls it down into the function the search
 * starts from. Chess engines call the idea TD-leaf. It needs a searching bot to
 * collect with, so it is slower per game, and it is the answer to the failure
 * mode `--target outcome` walked into: markers predict the winner better than
 * anything else, so an outcome fit shrinks every other feature next to them and
 * leaves the middlegame flat.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import {
  BASE_WEIGHTS,
  BOTS,
  DEFAULT_SEARCH,
  featureVector,
  FEATURES,
  runSearch,
  weightsFromFit,
  type EvalWeights,
} from '@wc/bots';
import {
  actingSeat,
  applyAction,
  createGame,
  createRng,
  nextInt,
  publicStateFor,
  type DraftMode,
  type GameState,
  type UnitSet,
} from '@wc/shared';
import { DEFAULT_FIT, fit, fitToValues, logLoss, normalize, valueLoss, type Sample } from './regress.js';
import { BANK_FEATURES, BANK_UNITS, rosterVector, unitBank } from './unit-bank.js';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
}

const games = Number(arg('games', '2000'));
const perGame = Number(arg('per-game', '6'));
const botName = arg('bot', 'heuristic');
const setsArg = arg('sets', '');
const sets = setsArg === '' ? [] : (setsArg.split(',') as UnitSet[]);
const draftMode = arg('draft', 'random') as DraftMode;
const skip = Number(arg('skip', '12'));
const baseSeed = Number(arg('seed', '1'));
const steps = Number(arg('steps', String(DEFAULT_FIT.steps)));
const outPath = arg('out', 'weights/fitted.json');
const target = arg('target', 'outcome');
/**
 * Unlock a weight per unit on top of the ordinary features, and report whether
 * the extra 56 coordinates buy anything on games the fit never saw.
 */
const bank = process.argv.includes('--bank');
/** Games held back, one in this many. Split by *game*, never by position. */
const folds = Number(arg('folds', '5'));
if (target !== 'outcome' && target !== 'value') throw new Error('--target is outcome or value');
/**
 * The weights the collecting search plays and values positions with.
 *
 * Not necessarily the built-in ones. Fitting to search values is a loop —
 * collect, fit, test, adopt, collect again — and each round has to be played by
 * the weights the previous round produced. Without this the loop would need a
 * rebuild of the package between every step, which is how a loop stops being
 * run at all.
 */
const searchWeights = ((): EvalWeights => {
  const path = arg('weights', '');
  if (!path) return BASE_WEIGHTS;
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const weights = (raw.weights ?? raw) as EvalWeights;
  if (typeof weights.version !== 'string') throw new Error(`${path}: a weights file must carry a version`);
  return weights;
})();
const searchConfig = {
  ...DEFAULT_SEARCH,
  weights: searchWeights,
  iterations: Number(arg('iterations', '200')),
};

const bot = BOTS[botName];
if (!bot) throw new Error(`unknown bot "${botName}"`);

const MAX_PLIES = 4000;
const samples: Sample[] = [];
let finished = 0;
let capped = 0;
const started = Date.now();

for (let g = 0; g < games; g++) {
  const seed = baseSeed + g;
  const state: GameState = createGame({
    id: `fit-${seed}`,
    size: 2,
    seed,
    sets,
    draftMode,
    seats: [
      { userId: 'a', displayName: 'A' },
      { userId: 'b', displayName: 'B' },
    ],
  });
  const rng = createRng(seed * 7 + 1);

  // Positions are kept as they go past, then labelled at the end — the label is
  // the result, and the result is not known until the game is over.
  const kept: { features: number[]; team: number; value?: number }[] = [];
  let plies = 0;
  while (state.phase !== 'finished' && plies < MAX_PLIES) {
    const seat = actingSeat(state);
    const view = publicStateFor(state, seat);
    // Fitting to values means the search plays the whole game — the positions
    // have to be ones the search would actually reach — and the value comes for
    // free, because it is the number the search just backed up to choose with.
    // Only some plies are kept: consecutive positions in one game are nearly the
    // same position, and the fit gains little from all of them.
    if (target === 'value' && view.legal.length > 1) {
      const report = runSearch(view, { rng, budget: { iterations: searchConfig.iterations } }, searchConfig);
      if (plies > skip && nextInt(rng, 40) < perGame) {
        kept.push({
          features: bank
            ? [...featureVector(state, seat), ...rosterVector(state, seat), ...unitBank(state, seat)]
            : featureVector(state, seat),
          team: state.players[seat]?.team ?? 0,
          value: report.value,
        });
      }
      applyAction(state, seat, report.action);
    } else {
      applyAction(state, seat, bot.chooseMove(view, { rng, budget: {} }));
    }
    plies++;
    // Every position after the opening is a candidate; a coin flip per ply keeps
    // roughly `perGame` of them without needing to know the length in advance.
    if (target === 'outcome' && plies > skip && nextInt(rng, 40) < perGame) {
      const me = actingSeat(state);
      kept.push({
        features: bank
          ? [...featureVector(state, me), ...rosterVector(state, me), ...unitBank(state, me)]
          : featureVector(state, me),
        team: state.players[me]?.team ?? 0,
      });
    }
  }

  if (state.phase !== 'finished') {
    capped++;
    continue;
  }
  finished++;
  // Each game counts once however many positions it gave up, or a long game
  // would shout over a short one.
  const weight = kept.length === 0 ? 0 : 1 / kept.length;
  for (const k of kept) {
    const result =
      k.value !== undefined
        ? k.value
        : state.winner === null
          ? 0.5
          : state.winner === k.team
            ? 1
            : 0;
    samples.push({ features: k.features, result, weight, game: g } as Sample & { game: number });
  }

  if ((g + 1) % 250 === 0) {
    process.stdout.write(
      `\r  ${g + 1}/${games} games, ${samples.length} positions, ${((Date.now() - started) / 1000).toFixed(0)}s`,
    );
  }
}

console.log(`\n\n  ${finished} games finished, ${capped} hit the ply cap`);
console.log(`  ${samples.length} positions kept\n`);
if (samples.length === 0) throw new Error('nothing to fit');

/**
 * Loss on games the fit never saw.
 *
 * Until this existed the CLI printed the loss on the very positions it had just
 * fitted, which always improves and therefore never meant anything — five fitted
 * vectors in a row looked convincing here and lost their matches.
 *
 * The split has to be by game and not by position. Positions from one game share
 * its result, so a stride over the sample list would put near-duplicates of the
 * same label on both sides and report a held-out loss that is nothing of the
 * kind.
 */
const withGame = samples as (Sample & { game: number })[];
const train = withGame.filter((s) => s.game % folds !== 0);
const test = withGame.filter((s) => s.game % folds === 0);
const width = samples[0]?.features.length ?? 0;
if (target === 'outcome' && test.length > 0 && train.length > 0) {
  const fitOn = (rows: readonly Sample[], keep: number) =>
    fit(
      rows.map((r) => ({ ...r, features: r.features.slice(0, keep) })),
      { ...DEFAULT_FIT, steps },
    );
  const lossOf = (rows: readonly Sample[], w: readonly number[], keep: number) =>
    logLoss(rows.map((r) => ({ ...r, features: r.features.slice(0, keep) })), w);

  console.log(`  ${train.length} positions fitted, ${test.length} held back (${folds}-fold, by game)\n`);
  console.log(`  ${'model'.padEnd(24)}${'on its own games'.padEnd(20)}on games it never saw`);
  console.log(`  ${'-'.repeat(64)}`);
  const plain = fitOn(train, FEATURES.length);
  console.log(
    `  ${'the ordinary features'.padEnd(24)}${lossOf(train, plain, FEATURES.length).toFixed(5).padEnd(20)}` +
      `${lossOf(test, plain, FEATURES.length).toFixed(5)}`,
  );
  if (bank) {
    // Nested models, so each line adds exactly one thing to the one above it.
    const withRoster = FEATURES.length + BANK_UNITS.length;
    const rosterFit = fitOn(train, withRoster);
    const full = fitOn(train, width);
    const base = lossOf(test, plain, FEATURES.length);
    const afterRoster = lossOf(test, rosterFit, withRoster);
    const afterBank = lossOf(test, full, width);
    console.log(
      `  ${'and who drafted what'.padEnd(24)}${lossOf(train, rosterFit, withRoster).toFixed(5).padEnd(20)}` +
        `${afterRoster.toFixed(5)}`,
    );
    console.log(
      `  ${`and ${BANK_FEATURES.length} per-unit terms`.padEnd(24)}${lossOf(train, full, width).toFixed(5).padEnd(20)}` +
        `${afterBank.toFixed(5)}`,
    );
    console.log(
      `\n  the rosters alone are worth   ${(base - afterRoster).toFixed(5)}  — and a search cannot use it,` +
        `\n  ${''.padEnd(29)}since the drafted units never change inside a tree` +
        `\n  the bank beyond the rosters   ${(afterRoster - afterBank).toFixed(5)}  — this is the number that decides`,
    );
    const drop = afterRoster - afterBank;
    console.log(
      drop <= 0.0005
        ? '\n  Nothing survives holding the rosters fixed. The bank was reading the draft,\n' +
            '  which the bot already drafts by and which is worth +140 Elo in the one place\n' +
            '  it can be used. As an evaluation term it is a constant per game.'
        : `\n  ${drop.toFixed(5)} survives. That part is positional — it moves inside a game — and\n` +
            '  is evidence for building the bank properly and then putting it to a match.',
    );
  }
  console.log();
}

const zero = new Array(width).fill(0) as number[];
const raw = target === 'value' ? fitToValues(samples, { ...DEFAULT_FIT, steps }) : fit(samples, { ...DEFAULT_FIT, steps });
if (target === 'value') {
  console.log(`  squared error ${valueLoss(samples, zero).toFixed(4)} → ${valueLoss(samples, raw).toFixed(4)}`);
} else {
  console.log(`  log loss ${logLoss(samples, zero).toFixed(4)} → ${logLoss(samples, raw).toFixed(4)}`);
}

const anchored = normalize(raw, FEATURES.indexOf('markers'));
const weights = weightsFromFit(anchored, `fitted@${target}-${finished}`);
if (searchWeights !== BASE_WEIGHTS) console.log(`\n  collected by a search playing ${searchWeights.version}`);

console.log('\n  fitted, anchored on markers:');
for (const [i, name] of FEATURES.entries()) {
  console.log(`    ${name.padEnd(12)}${(anchored[i] as number).toFixed(4)}`);
}
console.log(`\n  as weights: ${JSON.stringify(weights)}`);

writeFileSync(outPath, `${JSON.stringify(weights, null, 2)}\n`);
console.log(`\n  written to ${outPath}`);
console.log('  It is a candidate. What makes it a baseline is a match:');
console.log(`    npm run sprt -- --a weights/base.json --b ${outPath}\n`);
