#!/usr/bin/env node
/**
 * Can the bot play every card in the box?
 *
 *   node scripts/tactic-audit.mjs [games]
 *
 * Written after a player reported the bot walking into the same Marshal punish
 * round after round. The bot's guess at the opponent's hand turned out to be
 * exact — it knew how many Marshal coins were unaccounted for and dealt them at
 * the right rate. What it could not do was *play* the card: the Marshal picks
 * its target on a follow-up step, so the action that starts the tactic carries
 * neither a `target` nor a `to`, and the heuristic ranks by exactly those two
 * fields. Six cards fell into housekeeping and were offered 1401 times over 120
 * games without being played once.
 *
 * That was never about Marshals. It was a class of card the rollout policy could
 * not reach, and nothing in the test suite would have noticed, because every
 * test asks whether a move is *legal* and none asks whether the policy would
 * ever choose it. So this asks it of all 28, and keeps asking.
 *
 * Two failures look different here and mean different things:
 *
 *  - **never offered** — the engine does not generate the tactic in play. Either
 *    the card's condition is genuinely rare, or the rules for it are wrong.
 *  - **offered, never played** — the engine is fine and the policy is blind. The
 *    search rolls out against an opponent who cannot do what a real one can.
 */

import {
  actingSeat,
  applyAction,
  createGame,
  createRng,
  publicStateFor,
  UNITS,
} from '../packages/shared/dist/index.js';
import { BOTS } from '../packages/bots/dist/index.js';

const games = Number(process.argv[2] ?? 200);
/**
 * Who plays. It matters more than it looks: a Siege Tactic may only be started
 * from a bolstered stack, and the heuristic bolsters as a last resort (ninth
 * drawer of eleven) while the search bolsters constantly — 51.7% of its stacks
 * carry a second coin. Audited under the heuristic alone, every Siege Tactic
 * reads as dead, and that is a fact about the auditor.
 */
const bot = BOTS[process.argv[3] ?? 'heuristic'] ?? BOTS.heuristic;

/** Per unit: how often its coin was in a hand, its tactic legal, and played. */
const stats = new Map();
const row = (unit) => {
  if (!stats.has(unit)) stats.set(unit, { held: 0, offered: 0, played: 0, onBoard: 0 });
  return stats.get(unit);
};

for (let g = 0; g < games; g++) {
  const state = createGame({
    id: `audit-${g}`,
    size: 2,
    seed: 12000 + g,
    sets: ['nobility', 'siege', 'nightfall'],
    draftMode: 'random',
    seats: [
      { userId: 'a', displayName: 'A' },
      { userId: 'b', displayName: 'B' },
    ],
  });
  const rng = createRng(g * 29 + 11);
  let plies = 0;

  while (state.phase !== 'finished' && plies < 500) {
    const seat = actingSeat(state);
    const view = publicStateFor(state, seat);
    const action = bot.chooseMove(view, { rng, budget: {} });

    if (state.phase === 'playing') {
      const hand = state.players[seat].hand;
      for (const coin of new Set(hand)) if (UNITS[coin]) row(coin).held++;
      for (const stack of Object.values(state.units)) {
        if (stack.seat === seat) row(stack.unit).onBoard++;
      }
      // Which tactics were on offer this ply, by the unit that would play them.
      const offered = new Set();
      for (const a of view.legal) {
        if (a.type !== 'tactic') continue;
        const unit = state.units[a.from]?.unit;
        if (unit) offered.add(unit);
      }
      for (const unit of offered) row(unit).offered++;
      if (action.type === 'tactic') {
        const unit = state.units[action.from]?.unit;
        if (unit) row(unit).played++;
      }
    }

    applyAction(state, seat, action);
    plies++;
  }
}

const all = Object.values(UNITS).map((spec) => {
  const r = stats.get(spec.id) ?? { held: 0, offered: 0, played: 0, onBoard: 0 };
  return {
    id: spec.id,
    name: spec.name.ru,
    kind: spec.tactic?.kind ?? '—',
    ...r,
    rate: r.offered === 0 ? null : r.played / r.offered,
  };
});

console.log(`\n  ${games} games, every box on the table, played by ${bot.name}\n`);
console.log(
  `  ${'unit'.padEnd(20)}${'tactic'.padEnd(22)}${'on board'.padEnd(10)}${'offered'.padEnd(9)}${'played'.padEnd(8)}rate`,
);
console.log(`  ${'-'.repeat(78)}`);
for (const u of all.sort((a, b) => (a.rate ?? -1) - (b.rate ?? -1))) {
  const rate = u.rate === null ? '   —' : `${(u.rate * 100).toFixed(1)}%`;
  const flag = u.kind === '—' ? '' : u.offered === 0 ? '  ← never offered' : u.played === 0 ? '  ← never played' : '';
  console.log(
    `  ${u.name.padEnd(20)}${u.kind.padEnd(22)}${String(u.onBoard).padEnd(10)}${String(u.offered).padEnd(9)}${String(u.played).padEnd(8)}${rate}${flag}`,
  );
}

const withTactic = all.filter((u) => u.kind !== '—');
const mute = withTactic.filter((u) => u.offered > 0 && u.played === 0);
const absent = withTactic.filter((u) => u.offered === 0 && u.onBoard > 0);
console.log(
  `\n  ${withTactic.length} cards carry a tactic.` +
    `\n  offered and never played: ${mute.length}${mute.length ? ` — ${mute.map((u) => u.name).join(', ')}` : ''}` +
    `\n  on the board and never offered: ${absent.length}${absent.length ? ` — ${absent.map((u) => u.name).join(', ')}` : ''}\n`,
);
