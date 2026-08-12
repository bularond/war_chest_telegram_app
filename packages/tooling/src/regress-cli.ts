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
          features: featureVector(state, seat),
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
      kept.push({ features: featureVector(state, me), team: state.players[me]?.team ?? 0 });
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
    samples.push({ features: k.features, result, weight });
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

const zero = new Array(FEATURES.length).fill(0) as number[];
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
