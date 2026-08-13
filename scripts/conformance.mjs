/**
 * Plays the TypeScript engine against the Rust one, move for move.
 *
 * The port is only worth anything if it is the same game, and «the tests pass»
 * is not that claim: the tests were written against positions somebody thought
 * of. This drives both engines through random games from the same seeds and
 * compares, after every single ply,
 *
 *   - the whole position, field by field, and
 *   - the set of legal actions for whoever has to answer,
 *
 * and every `--successors N` plies also the *successor of every legal action* —
 * so a rule reachable only by a move the policy never picked is compared too.
 * That last check is what makes this different from playing a few games and
 * hoping.
 *
 * The Rust side runs as a child process speaking one line of JSON per message,
 * which keeps this honest: nothing is shared between the two engines but the
 * seed and the moves.
 *
 *   npm run build -w @wc/shared
 *   cargo build --release -p wc-conformance
 *   node scripts/conformance.mjs --games 200
 *   node scripts/conformance.mjs --games 40 --sets mix --successors 1
 *
  * The engine it compared against no longer exists: the TypeScript rules were
 * deleted once this had run clean, and both sides of the comparison now come
 * out of the same crate. To re-run it as it was meant, check the pre-port
 * commit out beside this one:
 *
 *   git worktree add ../war_chest_ts 61be27f
 *
 * Options:
 *   --games N        how many games                        (default 100)
 *   --from N         first seed                            (default 1)
 *   --sets LIST      comma separated, or "mix" to cycle    (default mix)
 *   --sizes LIST     2, 4 or both                          (default 2,4)
 *   --modes LIST     draft,random,ban                      (default mix)
 *   --successors N   compare every successor every N plies (default 8)
 *   --max-plies N    give up on a game after N plies       (default 1200)
 *   --bin PATH       the Rust binary
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  actingSeat,
  applyAction,
  createGame,
  createRng,
  isTerminal,
  legalActions,
  randomPolicy,
} from '@wc/shared';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const GAMES = Number(arg('games', 100));
const FROM = Number(arg('from', 1));
const SUCCESSOR_EVERY = Number(arg('successors', 8));
const MAX_PLIES = Number(arg('max-plies', 1200));
const BIN = arg('bin', path.join(ROOT, 'target/release/wc-conformance'));

const SET_COMBOS = [
  [],
  ['nobility'],
  ['siege'],
  ['nightfall'],
  ['nobility', 'siege'],
  ['nobility', 'nightfall'],
  ['siege', 'nightfall'],
  ['nobility', 'siege', 'nightfall'],
];
const setsArg = arg('sets', 'mix');
const SETS = setsArg === 'mix' ? SET_COMBOS : [setsArg.split(',').filter(Boolean)];
const SIZES = arg('sizes', '2,4').split(',').map(Number);
const MODES = arg('modes', 'draft,random,ban').split(',');

// ---------------------------------------------------------------------------
// The Rust engine, behind a pipe
// ---------------------------------------------------------------------------

class Peer {
  constructor(bin) {
    this.child = spawn(bin, [], { stdio: ['pipe', 'pipe', 'inherit'] });
    this.child.on('error', (e) => {
      console.error(`cannot start ${bin}: ${e.message}`);
      console.error('build it first: cargo build --release -p wc-conformance');
      process.exit(2);
    });
    this.lines = createInterface({ input: this.child.stdout });
    this.waiting = [];
    this.lines.on('line', (line) => {
      const resolve = this.waiting.shift();
      if (resolve) resolve(JSON.parse(line));
    });
  }

  send(request) {
    return new Promise((resolve) => {
      this.waiting.push(resolve);
      this.child.stdin.write(`${JSON.stringify(request)}\n`);
    });
  }

  async ask(request) {
    const reply = await this.send(request);
    if (!reply.ok) throw new Error(`rust: ${reply.error}`);
    return reply;
  }

  close() {
    this.child.stdin.end();
  }
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

/**
 * JSON with the keys sorted, so two equal values always give the same text.
 * `JSON.stringify` does not: `units` and `control` are keyed by hex, and their
 * key order follows the order pieces happened to arrive.
 */
function canonical(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value !== 'object') return JSON.stringify(value);
  const keys = Object.keys(value).sort();
  const parts = [];
  for (const key of keys) {
    if (value[key] === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${canonical(value[key])}`);
  }
  return `{${parts.join(',')}}`;
}

/**
 * The two shapes that are the same game written differently.
 *
 * A count of zero and a missing count are the same thing to every reader in
 * either engine — they are all `?? 0` — but one engine keeps the key after the
 * last coin is spent and the other does not. And `sets` is a set: `createGame`
 * puts the base game first and then whatever order the caller listed.
 */
function normalise(state) {
  const clean = (counts) =>
    Object.fromEntries(Object.entries(counts ?? {}).filter(([, n]) => (n ?? 0) !== 0));
  return {
    ...state,
    sets: [...state.sets].sort(),
    players: state.players.map((p) => ({
      ...p,
      supply: clean(p.supply),
      removed: clean(p.removed),
    })),
  };
}

function compareStates(mine, theirs, where) {
  const a = canonical(normalise(mine));
  const b = canonical(normalise(theirs));
  if (a === b) return null;
  return `${where}: positions differ\n  ts:   ${firstDifference(a, b)[0]}\n  rust: ${firstDifference(a, b)[1]}`;
}

/** The two texts from a little before where they part, so the diff is readable. */
function firstDifference(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const from = Math.max(0, i - 60);
  return [a.slice(from, i + 120), b.slice(from, i + 120)];
}

function compareActions(mine, theirs, where) {
  const a = mine.map(canonical).sort();
  const b = theirs.map(canonical).sort();
  if (a.length === b.length && a.every((x, i) => x === b[i])) return null;
  const onlyTs = a.filter((x) => !b.includes(x));
  const onlyRust = b.filter((x) => !a.includes(x));
  return [
    `${where}: legal actions differ (ts ${a.length}, rust ${b.length})`,
    onlyTs.length ? `  only ts:   ${onlyTs.slice(0, 6).join(' ')}` : '',
    onlyRust.length ? `  only rust: ${onlyRust.slice(0, 6).join(' ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

// ---------------------------------------------------------------------------
// One game
// ---------------------------------------------------------------------------

async function playOne(peer, opts) {
  const seats = Array.from({ length: opts.size }, (_, i) => ({
    userId: `p${i}`,
    displayName: `P${i}`,
  }));
  let state = createGame({ ...opts, seats });
  await peer.ask({ cmd: 'create', opts: { ...opts, seats } });

  const problems = [];
  const at = (ply) => `seed ${opts.seed} size ${opts.size} sets [${opts.sets}] ${opts.draftMode} ply ${ply}`;

  const rng = createRng(opts.seed ^ 0x5bf03635);
  let ply = 0;

  const check = async (label) => {
    const { state: theirs } = await peer.ask({ cmd: 'state' });
    const bad = compareStates(state, theirs, label);
    if (bad) problems.push(bad);
    return bad === null;
  };

  if (!(await check(at(0)))) return problems;

  while (!isTerminal(state) && ply < MAX_PLIES) {
    const seat = actingSeat(state);
    const mine = legalActions(state, seat);
    const { legal: theirs } = await peer.ask({ cmd: 'legal', seat });
    const bad = compareActions(mine, theirs, at(ply));
    if (bad) {
      problems.push(bad);
      return problems;
    }
    if (mine.length === 0) break;

    // Every so often, play every legal action on a copy in both engines and
    // compare the positions. This is where rules nobody picked get covered.
    if (SUCCESSOR_EVERY > 0 && ply % SUCCESSOR_EVERY === 0) {
      const { successors } = await peer.ask({ cmd: 'successors', seat });
      for (const entry of successors) {
        const key = canonical(entry.action);
        const action = mine.find((a) => canonical(a) === key);
        if (!action) continue;
        let next;
        try {
          next = structuredClone(state);
          applyAction(next, seat, action, { validate: false });
        } catch (e) {
          if (!entry.error) problems.push(`${at(ply)}: ts threw on ${key}: ${e.message}`);
          continue;
        }
        if (entry.error) {
          problems.push(`${at(ply)}: rust threw on ${key}: ${entry.error}`);
          continue;
        }
        const diff = compareStates(next, entry.state, `${at(ply)} after ${key}`);
        if (diff) {
          problems.push(diff);
          return problems;
        }
      }
    }

    const action = randomPolicy(state, rng);
    applyAction(state, seat, action);
    await peer.ask({ cmd: 'apply', seat, action });
    ply += 1;

    if (!(await check(`${at(ply)} after ${canonical(action)}`))) return problems;
  }

  return problems;
}

// ---------------------------------------------------------------------------

async function main() {
  const peer = new Peer(BIN);
  let played = 0;
  let failed = 0;
  const started = Date.now();

  for (let i = 0; i < GAMES; i++) {
    const seed = FROM + i;
    const opts = {
      id: `conformance-${seed}`,
      seed,
      size: SIZES[i % SIZES.length],
      sets: SETS[i % SETS.length],
      draftMode: MODES[i % MODES.length],
    };
    const problems = await playOne(peer, opts);
    played += 1;
    if (problems.length > 0) {
      failed += 1;
      console.error(`\n✗ ${problems.join('\n')}`);
      if (failed >= 3) break;
    } else if (played % 10 === 0) {
      process.stdout.write(`\r${played}/${GAMES} games agree`);
    }
  }

  peer.close();
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (failed === 0) {
    console.log(`\n${played} games, every ply identical in both engines (${seconds}s)`);
  } else {
    console.error(`\n${failed} of ${played} games disagree`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
