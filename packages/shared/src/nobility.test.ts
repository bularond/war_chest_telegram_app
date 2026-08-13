/** War Chest: Nobility — Royal Decrees, proclaiming, and the four new units. */

import { describe, expect, it } from 'vitest';
import { STARTING_LOCATIONS } from './board.js';
import { DECREE_IDS, type DecreeId } from './decrees.js';
import { applyAction, canProclaim, legalActions, sealsLeft } from './rules.js';
import { checkInvariants } from './rules.js';
import { createGame } from './rules.js';
import type { GameAction, GameState } from './types.js';
import type { CoinId, UnitId } from './units.js';

const A_START = STARTING_LOCATIONS.a;

function game(unitsA: UnitId[], unitsB: UnitId[], decrees: DecreeId[]): GameState {
  const g = createGame({
    id: 'nob',
    size: 2,
    seed: 3,
    sets: ['nobility'],
    seats: [
      { userId: 'a', displayName: 'A' },
      { userId: 'b', displayName: 'B' },
    ],
    fixedUnits: [unitsA, unitsB],
  });
  g.decrees = decrees.map((id) => ({ id, seals: [] }));
  g.players.forEach((p) => (p.seals = 3));
  g.turn = 0;
  return g;
}

function setHand(state: GameState, seat: number, hand: CoinId[]): void {
  state.players[seat]!.hand = [...hand];
}

function find(state: GameState, seat: number, pred: (a: GameAction) => boolean): GameAction {
  const a = legalActions(state, seat).find(pred);
  if (!a) throw new Error(`no legal action; got ${JSON.stringify(legalActions(state, seat))}`);
  return a;
}

describe('setup', () => {
  it('deals three of the seven decrees and three seals a side', () => {
    const g = createGame({
      id: 'd',
      size: 2,
      seed: 9,
      sets: ['nobility'],
      seats: [
        { userId: 'a', displayName: 'A' },
        { userId: 'b', displayName: 'B' },
      ],
    });
    expect(g.decrees).toHaveLength(3);
    expect(new Set(g.decrees.map((d) => d.id)).size).toBe(3);
    for (const d of g.decrees) expect(DECREE_IDS).toContain(d.id);
    for (const p of g.players) expect(p.seals).toBe(3);
    // The pool now includes the four Nobility units.
    expect(g.draftPool.length).toBe(8);
  });

  it('leaves the decrees off the table without the expansion', () => {
    const g = createGame({
      id: 'plain',
      size: 2,
      seed: 9,
      seats: [
        { userId: 'a', displayName: 'A' },
        { userId: 'b', displayName: 'B' },
      ],
    });
    expect(g.decrees).toHaveLength(0);
    expect(g.players[0]!.seals).toBe(0);
  });
});

describe('proclaiming', () => {
  it('spends a seal, marks the decree, and cannot be repeated by that side', () => {
    const g = game(['swordsman', 'archer', 'knight', 'scout'], ['pikeman', 'ensign', 'footman', 'cavalry'], [
      'enlist',
      'reinforce',
      'spy',
    ]);
    setHand(g, 0, ['royal', 'swordsman', 'swordsman']);

    const proclaim = find(g, 0, (a) => a.type === 'proclaim' && a.decree === 'enlist');
    applyAction(g, 0, proclaim);
    expect(g.players[0]!.seals).toBe(2);
    expect(g.decrees.find((d) => d.id === 'enlist')!.seals).toEqual([0]);

    // Enlist queues two recruits.
    expect(g.pending.filter((s) => s.kind === 'decreeRecruit')).toHaveLength(2);
    for (let i = 0; i < 2; i++) {
      applyAction(g, 0, find(g, 0, (a) => a.type === 'followRecruit'));
    }
    // The Royal Coin goes face up too — proclaiming is a face-up discard.
    expect(g.players[0]!.discard.filter((d) => d.coin === 'royal')).toHaveLength(1);
    expect(g.players[0]!.discard.filter((d) => d.coin !== 'royal')).toHaveLength(2);

    // The same side may not use that decree again; the opponent still may.
    expect(canProclaim(g, 0, 'enlist')).toBe(false);
    expect(canProclaim(g, 1, 'enlist')).toBe(true);
  });

  it('only offers a decree it could carry out in full', () => {
    const g = game(['swordsman', 'archer', 'knight', 'scout'], ['pikeman', 'ensign', 'footman', 'cavalry'], [
      'reinforce',
      'march',
      'guard',
    ]);
    // Nothing destroyed, nothing on the board: all three are impossible.
    expect(canProclaim(g, 0, 'reinforce')).toBe(false);
    expect(canProclaim(g, 0, 'march')).toBe(false);
    expect(canProclaim(g, 0, 'guard')).toBe(false);

    // A coin lost from the board unlocks Reinforce.
    g.players[0]!.removed.swordsman = 1;
    expect(canProclaim(g, 0, 'reinforce')).toBe(true);
  });

  it('sacrifices: the attack lands and the attacker pays a coin', () => {
    const g = game(['swordsman', 'archer', 'knight', 'scout'], ['ensign', 'footman', 'cavalry', 'scout'], [
      'sacrifice',
      'spy',
      'enlist',
    ]);
    g.units['5,2'] = { unit: 'swordsman', team: 0, seat: 0, coins: 2 };
    g.units['5,1'] = { unit: 'ensign', team: 1, seat: 1, coins: 2 };
    setHand(g, 0, ['royal', 'swordsman', 'swordsman']);

    applyAction(g, 0, find(g, 0, (a) => a.type === 'proclaim' && a.decree === 'sacrifice'));
    applyAction(g, 0, find(g, 0, (a) => a.type === 'followAttack'));
    expect(g.units['5,1']!.coins).toBe(1); // the hit landed
    expect(g.units['5,2']!.coins).toBe(1); // and cost a coin
  });

  it('marches only bolstered units', () => {
    const g = game(['swordsman', 'archer', 'knight', 'scout'], ['ensign', 'footman', 'cavalry', 'scout'], [
      'march',
      'spy',
      'enlist',
    ]);
    g.units['5,2'] = { unit: 'swordsman', team: 0, seat: 0, coins: 1 };
    expect(canProclaim(g, 0, 'march')).toBe(false);
    g.units['5,2']!.coins = 2;
    expect(canProclaim(g, 0, 'march')).toBe(true);

    setHand(g, 0, ['royal', 'swordsman', 'swordsman']);
    applyAction(g, 0, find(g, 0, (a) => a.type === 'proclaim' && a.decree === 'march'));
    const moves = legalActions(g, 0).filter((a) => a.type === 'followMove');
    expect(moves.length).toBeGreaterThan(0);
    for (const m of moves) expect((m as { from: string }).from).toBe('5,2');
  });

  it('redeploys a whole stack onto another location it controls', () => {
    const g = game(['swordsman', 'archer', 'knight', 'scout'], ['ensign', 'footman', 'cavalry', 'scout'], [
      'redeploy',
      'spy',
      'enlist',
    ]);
    g.units[A_START[0]!] = { unit: 'swordsman', team: 0, seat: 0, coins: 3 };
    setHand(g, 0, ['royal', 'swordsman', 'swordsman']);

    applyAction(g, 0, find(g, 0, (a) => a.type === 'proclaim' && a.decree === 'redeploy'));
    applyAction(g, 0, find(g, 0, (a) => a.type === 'followLift'));
    expect(g.units[A_START[0]!]).toBeUndefined();

    applyAction(g, 0, find(g, 0, (a) => a.type === 'followPlace' && a.to === A_START[1]!));
    expect(g.units[A_START[1]!]).toEqual({ unit: 'swordsman', team: 0, seat: 0, coins: 3 });
  });

  it('spies a coin out of the opponent’s hand and tops it back up', () => {
    const g = game(['swordsman', 'archer', 'knight', 'scout'], ['ensign', 'footman', 'cavalry', 'scout'], [
      'spy',
      'march',
      'guard',
    ]);
    setHand(g, 0, ['royal', 'swordsman', 'swordsman']);
    setHand(g, 1, ['ensign', 'footman', 'cavalry']);
    const bagBefore = g.players[1]!.bag.length;

    applyAction(g, 0, find(g, 0, (a) => a.type === 'proclaim' && a.decree === 'spy'));
    applyAction(g, 0, find(g, 0, (a) => a.type === 'followSpy'));
    expect(g.players[1]!.hand).toHaveLength(3); // discarded one, drew one
    expect(g.players[1]!.bag.length).toBe(bagBefore - 1);
    expect(g.players[1]!.discard).toHaveLength(1);
  });

  it('reinforces a destroyed coin back into the supply', () => {
    const g = game(['swordsman', 'archer', 'knight', 'scout'], ['ensign', 'footman', 'cavalry', 'scout'], [
      'reinforce',
      'march',
      'guard',
    ]);
    g.players[0]!.removed.archer = 1;
    const supplyBefore = g.players[0]!.supply.archer!;
    setHand(g, 0, ['royal', 'swordsman', 'swordsman']);

    applyAction(g, 0, find(g, 0, (a) => a.type === 'proclaim' && a.decree === 'reinforce'));
    applyAction(g, 0, find(g, 0, (a) => a.type === 'followReinforce' && a.unit === 'archer'));
    expect(g.players[0]!.supply.archer).toBe(supplyBefore + 1);
    expect(g.players[0]!.removed.archer ?? 0).toBe(0);
  });
});

describe('nobility units', () => {
  it('lets the Herald bolster an unbolstered neighbour from its supply', () => {
    const g = game(['herald', 'swordsman', 'knight', 'scout'], ['ensign', 'footman', 'cavalry', 'scout'], [
      'spy',
      'march',
      'guard',
    ]);
    g.units['5,2'] = { unit: 'herald', team: 0, seat: 0, coins: 1 };
    g.units['5,1'] = { unit: 'swordsman', team: 0, seat: 0, coins: 1 };
    setHand(g, 0, ['herald', 'herald', 'herald']);
    const before = g.players[0]!.supply.swordsman!;

    applyAction(g, 0, find(g, 0, (a) => a.type === 'tactic'));
    applyAction(g, 0, find(g, 0, (a) => a.type === 'followBolster' && a.hex === '5,1'));
    expect(g.units['5,1']!.coins).toBe(2);
    expect(g.players[0]!.supply.swordsman).toBe(before - 1);
  });

  it('lets the Earl take a location and then proclaim for free', () => {
    const g = game(['earl', 'swordsman', 'knight', 'scout'], ['ensign', 'footman', 'cavalry', 'scout'], [
      'enlist',
      'march',
      'guard',
    ]);
    g.units['4,3'] = { unit: 'earl', team: 0, seat: 0, coins: 1 }; // a neutral location
    setHand(g, 0, ['earl', 'earl', 'earl']);
    // Burn the side's seal on Enlist first: the Earl ignores both limits.
    g.decrees.find((d) => d.id === 'enlist')!.seals.push(0);
    g.players[0]!.seals = 0;

    applyAction(g, 0, find(g, 0, (a) => a.type === 'tactic'));
    expect(g.control['4,3']).toBe(0);
    applyAction(g, 0, find(g, 0, (a) => a.type === 'followProclaim' && a.decree === 'enlist'));
    expect(g.players[0]!.seals).toBe(0); // no seal was spent
    expect(g.pending.filter((s) => s.kind === 'decreeRecruit')).toHaveLength(2);
  });

  it('lets the Bishop recruit and then act, and keeps heavy units off it', () => {
    const g = game(['bishop', 'swordsman', 'knight', 'scout'], ['ensign', 'footman', 'cavalry', 'scout'], [
      'spy',
      'march',
      'guard',
    ]);
    g.units['5,2'] = { unit: 'bishop', team: 0, seat: 0, coins: 1 };
    g.units['5,1'] = { unit: 'ensign', team: 1, seat: 1, coins: 1 };
    setHand(g, 0, ['bishop', 'bishop', 'bishop']);

    applyAction(g, 0, find(g, 0, (a) => a.type === 'tactic'));
    applyAction(g, 0, find(g, 0, (a) => a.type === 'followRecruit'));
    // Now it may move or attack, but nothing else.
    const kinds = new Set(legalActions(g, 0).map((a) => a.type));
    expect(kinds).toEqual(new Set(['followMove', 'followAttack']));

    // A bolstered attacker cannot touch it.
    g.units['5,1']!.coins = 2;
    g.turn = 1;
    g.pending = [];
    setHand(g, 1, ['ensign', 'ensign', 'ensign']);
    expect(legalActions(g, 1).some((a) => a.type === 'attack')).toBe(false);
  });

  it('lets the Bannerman shove an enemy after it maneuvers', () => {
    const g = game(['bannerman', 'swordsman', 'knight', 'scout'], ['ensign', 'footman', 'cavalry', 'scout'], [
      'spy',
      'march',
      'guard',
    ]);
    g.units['5,2'] = { unit: 'bannerman', team: 0, seat: 0, coins: 1 };
    g.units['5,1'] = { unit: 'ensign', team: 1, seat: 1, coins: 1 };
    setHand(g, 0, ['bannerman', 'bannerman', 'bannerman']);

    applyAction(g, 0, find(g, 0, (a) => a.type === 'move' && a.from === '5,2' && a.to === '4,2'));
    expect(g.pending.at(-1)?.kind).toBe('shoveEnemy');
    const shove = find(g, 0, (a) => a.type === 'followShove');
    applyAction(g, 0, shove);
    expect(g.units['5,1']).toBeUndefined();
    expect(g.units[(shove as { to: string }).to]!.unit).toBe('ensign');
  });
});

describe('decrees that can no longer be carried out', () => {
  // Found by the fuzzer (seed 8, all three expansions): Sacrifice was proclaimed
  // while an attack was available, a Herald maneuver waiting underneath it moved
  // the only attacker out of range, and the decree then had no legal action at
  // all — a position the game could never leave.
  it('drops a Sacrifice with nothing left to attack', () => {
    const g = game(['knight', 'swordsman', 'archer', 'scout'], ['footman', 'cavalry', 'archer', 'scout'], [
      'sacrifice',
      'march',
      'guard',
    ]);
    g.units['5,2'] = { unit: 'knight', team: 0, seat: 0, coins: 2 };
    g.units['1,2'] = { unit: 'footman', team: 1, seat: 1, coins: 1 };
    g.pending.push({ kind: 'decreeAttack', costsCoin: true, fromOwnLocation: false });

    expect(legalActions(g, 0)).toEqual([{ type: 'skip' }]);
    applyAction(g, 0, { type: 'skip' });
    expect(g.pending).toHaveLength(0);
    // Skipping the decree costs nothing: the sacrifice never happened.
    expect(g.units['5,2']!.coins).toBe(2);
  });

  it('sets a redeployed unit back down where it was lifted from', () => {
    const g = game(['knight', 'swordsman', 'archer', 'scout'], ['footman', 'cavalry', 'archer', 'scout'], [
      'redeploy',
      'march',
      'guard',
    ]);
    g.units['5,2'] = { unit: 'knight', team: 0, seat: 0, coins: 2 };
    g.pending.push({ kind: 'decreeLift' });

    const lift = find(g, 0, (a) => a.type === 'followLift');
    applyAction(g, 0, lift);
    expect(g.units['5,2']).toBeUndefined();
    expect(g.pending.at(-1)?.kind).toBe('decreePlace');

    // A lift is only offered when somewhere is free to land, so this cannot
    // happen in a real game — the stack must still not fall off the table.
    g.control = {};

    expect(legalActions(g, 0)).toEqual([{ type: 'skip' }]);
    applyAction(g, 0, { type: 'skip' });
    expect(g.units['5,2']).toEqual({ unit: 'knight', team: 0, seat: 0, coins: 2 });
  });

  // Also from the fuzzer (seed 42, Nobility): the Swordsman attacked under
  // Sacrifice, the decree took its last coin, and the engine still offered the
  // free follow-up move from the hex where it had stood.
  it('does not offer a dead Swordsman its free move', () => {
    const g = game(['swordsman', 'knight', 'archer', 'scout'], ['footman', 'cavalry', 'archer', 'scout'], [
      'sacrifice',
      'march',
      'guard',
    ]);
    g.units['5,2'] = { unit: 'swordsman', team: 0, seat: 0, coins: 1 };
    g.units['5,1'] = { unit: 'footman', team: 1, seat: 1, coins: 1 };
    g.pending.push({ kind: 'decreeAttack', costsCoin: true, fromOwnLocation: false });

    applyAction(g, 0, find(g, 0, (a) => a.type === 'followAttack' && a.from === '5,2'));
    // Both are gone: the Footman to the attack, the Swordsman to the sacrifice.
    expect(g.units['5,2']).toBeUndefined();
    expect(g.units['5,1']).toBeUndefined();
    for (const action of legalActions(g, 0)) {
      expect(action).toEqual({ type: 'skip' });
    }
  });
});

/**
 * Seals belong to the side, not to the seat.
 *
 * «Give each side the 3 Proclamation Seals that match their faction… In the
 * four-player game, each team shares the three Seals they are given» — Nobility
 * rulebook, set-up and Proclaim; the box holds six in all. Setup used to hand
 * every player their own three, which is right in a duel and doubles a team's
 * pool with four at the table. `invariants.ts` asserted the doubled sum as
 * correct, so the two agreed with each other and neither agreed with the box.
 */
describe('seals with four at the table', () => {
  const four = () =>
    createGame({
      id: 'four',
      size: 4,
      seed: 11,
      sets: ['nobility'],
      seats: [
        { userId: 'a', displayName: 'A' },
        { userId: 'b', displayName: 'B' },
        { userId: 'c', displayName: 'C' },
        { userId: 'd', displayName: 'D' },
      ],
    });

  it('gives each team three, not three apiece', () => {
    const g = four();
    for (const team of [0, 1]) {
      expect(g.players.filter((p) => p.team === team).reduce((n, p) => n + p.seals, 0)).toBe(3);
    }
    expect(checkInvariants(g)).toEqual([]);
  });

  it('lets either teammate spend out of the shared pool', () => {
    const g = four();
    // The pool is stored on one seat; the other must still be able to proclaim,
    // or half a team is locked out of a rule the box says it shares.
    const [first, , partner] = g.players;
    expect(first!.team).toBe(partner!.team);
    expect(first!.seals).toBe(3);
    expect(partner!.seals).toBe(0);
    expect(sealsLeft(g, partner!.team)).toBe(3);
  });

  it('still gives a duellist three of their own', () => {
    const g = game(['knight', 'scout', 'archer', 'swordsman'], ['footman', 'cavalry', 'ensign', 'lancer'], [
      'enlist',
      'march',
      'guard',
    ]);
    expect(sealsLeft(g, 0)).toBe(3);
    expect(sealsLeft(g, 1)).toBe(3);
  });
});
