#!/usr/bin/env node
/**
 * One line per finished experiment, as they finish.
 *
 *   node scripts/lab-verdicts.mjs [prefix]      # default weights/lab
 *
 * `lab-watch.mjs` answers "is it alive"; this answers "what did it decide". It
 * polls the journal and prints only what is new, so it can be left running as a
 * watcher without turning into a firehose.
 */

import { existsSync, readFileSync } from 'node:fs';

const prefix = process.argv[2] ?? 'weights/lab';
const journalPath = `${prefix}.journal.json`;
const every = Number(process.argv[3] ?? 120) * 1000;

const pct = (x) => `${(x * 100).toFixed(1)}%`;

function read() {
  try {
    return JSON.parse(readFileSync(journalPath, 'utf8'));
  } catch {
    // A half-written journal is normal: the lab rewrites it after every
    // experiment. Try again on the next tick.
    return null;
  }
}

function line(d, journal) {
  if (d.verdict === 'error') return `${d.id}: FAILED — ${(d.error ?? '').split('\n')[0]}`;
  if (!d.games) return `${d.id}: ${d.verdict.toUpperCase()} — nothing to measure`;
  const elo = `${d.elo >= 0 ? '+' : ''}${d.elo}`;
  // What moved, not what the baseline happens to hold: an accept is interesting
  // for the change it made, and the change is what the journal recorded.
  // A confirmation accepts without changing anything — it is a measurement of
  // the chain so far, not a step in it. Saying "taken" there would be a lie.
  const where =
    d.verdict !== 'accept' ? '' : d.id.startsWith('confirm') ? ' — this is the chain, measured' : ` → taken: ${d.change}`;
  const how = [d.draftMode && d.draftMode !== 'random' ? d.draftMode : null, d.sets?.length ? d.sets.join('+') : null]
    .filter(Boolean)
    .join(', ');
  return (
    `${d.id}: ${d.verdict.toUpperCase()} — ${d.games} games, ${pct(d.score)}, ${elo} Elo` +
    (how ? ` [${how}]` : '') +
    where
  );
}

let seen = read()?.done?.length ?? 0;
if (!existsSync(journalPath)) console.log('waiting for the lab to write its first journal');

for (;;) {
  const journal = read();
  if (journal?.done && journal.done.length > seen) {
    for (const d of journal.done.slice(seen)) console.log(line(d, journal));
    seen = journal.done.length;
  }
  await new Promise((r) => setTimeout(r, every));
}
