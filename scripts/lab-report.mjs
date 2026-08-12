#!/usr/bin/env node
/**
 * What a night of experiments came to.
 *
 *   node scripts/lab-report.mjs [prefix]        # default weights/lab
 *
 * The journal is a list of verdicts; this is the same list read the way a person
 * needs it — what was tried, what survived, what the baseline became, and what
 * the whole run is actually worth against the version it started from.
 *
 * It deliberately does not editorialise. A REJECT means "not worth the Elo we
 * asked about", never "harmful"; an undecided experiment means nothing at all
 * and is printed as such. The one number that means what it says is the
 * confirmation against the root, because that is the only match played between
 * the two ends on deals neither of them was selected on.
 */

import { readFileSync } from 'node:fs';

const prefix = process.argv[2] ?? 'weights/lab';
const journal = JSON.parse(readFileSync(`${prefix}.journal.json`, 'utf8'));
const done = journal.done ?? [];

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const pad = (s, n) => String(s).padEnd(n);

console.log(`\n  ${done.length} experiments, ${journal.accepts ?? 0} steps taken`);
console.log(`  from ${journal.rootVersion} to ${journal.baseline.weights.version}\n`);

console.log(`  ${pad('experiment', 26)}${pad('verdict', 10)}${pad('games', 7)}${pad('score', 8)}elo`);
console.log(`  ${'-'.repeat(58)}`);
for (const d of done) {
  const elo = d.games ? `${d.elo >= 0 ? '+' : ''}${d.elo}` : '';
  const mode =
    (d.draftMode && d.draftMode !== 'random' ? `  (${d.draftMode})` : '') +
    (d.sets?.length ? `  (+${d.sets.join('+')})` : '');
  console.log(
    `  ${pad(d.id, 26)}${pad(d.verdict, 10)}${pad(d.games || '', 7)}${pad(d.games ? pct(d.score) : '', 8)}${elo}${mode}`,
  );
}

const taken = done.filter((d) => d.verdict === 'accept');
if (taken.length > 0) {
  console.log('\n  steps taken, in order:');
  for (const d of taken) console.log(`    ${d.change}`);
}

const undecided = done.filter((d) => d.verdict === 'continue' && d.games > 0);
if (undecided.length > 0) {
  console.log(`\n  ${undecided.length} ran out of games or clock without deciding.`);
  console.log('  Not a result either way — worth re-running longer only if the score was near the bound.');
}

const failed = done.filter((d) => d.verdict === 'error');
if (failed.length > 0) {
  console.log(`\n  ${failed.length} failed outright:`);
  // The first line only: a stack trace in a summary is noise, and the journal
  // still has the whole thing.
  for (const d of failed) console.log(`    ${d.id}: ${(d.error ?? '').split('\n')[0]}`);
}

const confirmations = done.filter((d) => d.id.startsWith('confirm'));
if (confirmations.length > 0) {
  console.log('\n  against the version the night started from, on fresh deals:');
  for (const d of confirmations) {
    console.log(
      `    ${d.id}: ${d.verdict.toUpperCase()} — ${pct(d.score)} over ${d.games} games` +
        ` (${d.elo >= 0 ? '+' : ''}${d.elo} Elo, LLR ${d.llr.toFixed(2)})`,
    );
  }
} else {
  console.log('\n  no confirmation against the root has been played yet — the chain of');
  console.log('  accepted steps is not a measured gain until one has.');
}

const root = journal.root?.weights ?? {};
const now = journal.baseline.weights;
// A weight the starting file never mentioned was zero, not missing: features
// get added between runs, and `0 → 0` is not a change worth reporting.
const moved = Object.keys(now).filter((k) => k !== 'version' && (root[k] ?? 0) !== now[k]);
console.log('\n  weights that moved:');
if (moved.length === 0) console.log('    none');
for (const key of moved) console.log(`    ${pad(key, 14)}${root[key] ?? 0} → ${now[key]}`);

// The morning's job is to move these numbers into `BASE_WEIGHTS` and
// `DEFAULT_SEARCH` by hand, with a line each saying where they came from. That
// line is the whole reason the code holds the numbers rather than a JSON file,
// so the report writes it out rather than leaving it to memory.
const provenance = new Map();
for (const d of done) {
  if (d.verdict !== 'accept') continue;
  for (const part of d.change.split(', ')) {
    const key = part.split(' ')[0];
    provenance.set(key, `${d.games} games, ${pct(d.score)}, ${d.elo >= 0 ? '+' : ''}${d.elo} Elo`);
  }
}

const knobs = journal.baseline.knobs ?? {};
const rootKnobs = journal.root?.knobs ?? {};
const movedKnobs = Object.keys(knobs).filter((k) => rootKnobs[k] !== knobs[k]);
console.log('  search knobs that moved:');
if (movedKnobs.length === 0) console.log('    none');
for (const key of movedKnobs) console.log(`    ${pad(key, 14)}${rootKnobs[key] ?? 'default'} → ${knobs[key]}`);

// The journal does not know whether anybody acted on it, so it asks. If these
// numbers are already in `BASE_WEIGHTS` and `DEFAULT_SEARCH`, this section is a
// reminder of what was moved and why, not a to-do.
if (moved.length > 0 || movedKnobs.length > 0) {
  console.log('\n  to move into the code (or already moved — the journal cannot tell):\n');
  for (const key of moved) {
    const why = provenance.get(key);
    if (why) console.log(`    // ${why}.`);
    console.log(`    ${key}: ${now[key]},`);
  }
  for (const key of movedKnobs) {
    const why = provenance.get(key);
    if (why) console.log(`    // ${why}.`);
    console.log(`    ${key}: ${knobs[key]},`);
  }
  console.log('\n  A number without that line is, a month later, indistinguishable from one');
  console.log('  somebody made up. And none of it goes in until a confirmation says what');
  console.log('  the chain is worth against the version it started from.');
}
console.log();
