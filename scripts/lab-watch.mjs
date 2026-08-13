#!/usr/bin/env node
/**
 * One line about the state of an unattended lab run.
 *
 *   node scripts/lab-watch.mjs [prefix]        # default weights/lab
 *
 * Meant to be called on a timer by a watcher that turns each line into a
 * notification. It never asks a question and never blocks: it looks at the
 * heartbeat the lab writes after every batch of games, at the journal it writes
 * after every experiment, and at whether the process is still there.
 *
 * The point is to tell three states apart that look identical from outside:
 * running slowly, wedged, and dead. A long experiment is normal — some take
 * three quarters of an hour — so only a heartbeat that has stopped moving means
 * anything is wrong.
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';

const prefix = process.argv[2] ?? 'weights/lab';
const STALE_SECONDS = 900;

const read = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
};

const running = () => {
  try {
    // The lab is one process; the workers it spawns are threads inside it, and
    // it is a Rust binary now rather than a Node script.
    return execSync('pgrep -f "release/lab" || true', { encoding: 'utf8' }).trim().length > 0;
  } catch {
    return false;
  }
};

const beat = read(`${prefix}.heartbeat.json`);
const journal = read(`${prefix}.journal.json`);
const clock = new Date().toTimeString().slice(0, 5);
const done = journal?.done ?? [];
const tail = done
  .slice(-3)
  .map((d) => `${d.id}=${d.verdict.toUpperCase()}${d.games ? ` ${(d.score * 100).toFixed(0)}%` : ''}`)
  .join(' ');

if (!beat) {
  console.log(`${clock}  NO HEARTBEAT at ${prefix}.heartbeat.json — the lab never started`);
  process.exit(0);
}

const age = Math.round((Date.now() - statSync(`${prefix}.heartbeat.json`).mtimeMs) / 1000);
const alive = running();
const summary =
  `exp ${beat.experiment ?? '—'} · ${beat.games ?? 0} games` +
  (beat.games ? ` · ${((beat.score ?? 0) * 100).toFixed(1)}% · LLR ${(beat.llr ?? 0).toFixed(2)}` : '') +
  ` · ${done.length} done` +
  (tail ? ` · last: ${tail}` : '');

if (beat.finished) {
  console.log(`${clock}  FINISHED — the queue is empty. ${done.length} experiments. ${tail}`);
} else if (!alive) {
  console.log(`${clock}  STOPPED — no lab process. ${summary}`);
} else if (age > STALE_SECONDS) {
  console.log(`${clock}  STALLED — heartbeat is ${Math.round(age / 60)} min old. ${summary}`);
} else {
  console.log(`${clock}  ok · ${summary} · beat ${age}s ago`);
}
