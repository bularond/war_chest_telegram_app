/** War Chest: Siege — Fortifications, siege tactics and the four new units. */

import { describe, expect, it } from 'vitest';
import {
  DUEL_LOCATIONS,
  DUEL_LOCATIONS_BY_SIDE,
  FORTIFICATIONS_ON_BOARD,
  FORTIFICATION_LAYOUTS,
  rotate180,
} from './board.js';
import { actingSeat, applyAction, canEnter, legalActions } from './engine.js';
import { createGame } from './setup.js';
import type { GameAction, GameState } from './types.js';
import type { CoinId, UnitId } from './units.js';

function game(unitsA: UnitId[], unitsB: UnitId[]): GameState {
  const g = createGame({
    id: 'siege',
    size: 2,
    seed: 4,
    sets: ['siege'],
    seats: [
      { userId: 'a', displayName: 'A' },
      { userId: 'b', displayName: 'B' },
    ],
    fixedUnits: [unitsA, unitsB],
  });
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

describe('fortification layouts', () => {
  it('offers the ten cards: two of a side’s five nearest locations, mirrored', () => {
    expect(DUEL_LOCATIONS_BY_SIDE[0]).toHaveLength(5);
    expect(DUEL_LOCATIONS_BY_SIDE[1]).toHaveLength(5);
    // C(5,2) = 10 possible cards; the printed box ships six of them.
    expect(FORTIFICATION_LAYOUTS).toHaveLength(10);

    for (const layout of FORTIFICATION_LAYOUTS) {
      expect(layout).toHaveLength(FORTIFICATIONS_ON_BOARD);
      expect(new Set(layout).size).toBe(4);
      for (const hex of layout) expect(DUEL_LOCATIONS).toContain(hex);
      // Two on each side, and the second pair mirrors the first.
      const mine = layout.filter((h) => DUEL_LOCATIONS_BY_SIDE[0].includes(h));
      expect(mine).toHaveLength(2);
      for (const hex of mine) expect(layout).toContain(rotate180(hex));
    }
  });

  it('sets up four on the board and three in the supply', () => {
    const g = game(['sapper', 'trebuchet', 'siegeTower', 'warWagon'], ['swordsman', 'archer', 'knight', 'scout']);
    expect(Object.keys(g.forts)).toHaveLength(4);
    expect(g.fortSupply).toBe(3);
    expect(FORTIFICATION_LAYOUTS.some((l) => l.every((h) => g.forts[h]))).toBe(true);
  });

  it('leaves the board bare without the expansion', () => {
    const g = createGame({
      id: 'plain',
      size: 2,
      seed: 4,
      seats: [
        { userId: 'a', displayName: 'A' },
        { userId: 'b', displayName: 'B' },
      ],
    });
    expect(Object.keys(g.forts)).toHaveLength(0);
    expect(g.fortSupply).toBe(0);
  });
});

describe('fortifications on the board', () => {
  function bare(): GameState {
    const g = game(['swordsman', 'archer', 'knight', 'lightCavalry'], ['scout', 'ensign', 'footman', 'cavalry']);
    g.forts = {};
    g.fortSupply = 3;
    return g;
  }

  it('bars an enemy location but not a neutral or friendly one', () => {
    const g = bare();
    g.forts['4,3'] = true; // a neutral location
    expect(canEnter(g, 0, '4,3')).toBe(true);
    g.control['4,3'] = 0;
    expect(canEnter(g, 0, '4,3')).toBe(true); // friendly
    g.control['4,3'] = 1;
    expect(canEnter(g, 0, '4,3')).toBe(false); // enemy
  });

  it('stops a multi-space move passing through one', () => {
    const g = bare();
    g.units['4,2'] = { unit: 'lightCavalry', team: 0, seat: 0, coins: 1 };
    g.forts['4,3'] = true;
    setHand(g, 0, ['lightCavalry', 'lightCavalry', 'lightCavalry']);

    const ends = legalActions(g, 0)
      .filter((a) => a.type === 'tactic')
      .map((a) => (a as { to?: string }).to);
    // It may finish on the fortified location, but never travel past it.
    expect(ends).toContain('4,3');
    expect(ends).not.toContain('4,4');
  });

  it('takes the blow for the unit standing on it, and goes back to the supply', () => {
    const g = bare();
    g.units['5,2'] = { unit: 'swordsman', team: 0, seat: 0, coins: 1 };
    g.units['5,1'] = { unit: 'ensign', team: 1, seat: 1, coins: 2 };
    g.control['5,1'] = 1;
    g.forts['5,1'] = true;
    setHand(g, 0, ['swordsman', 'swordsman', 'swordsman']);

    const before = g.fortSupply;
    applyAction(g, 0, find(g, 0, (a) => a.type === 'attack' && a.to === '5,1'));
    expect(g.forts['5,1']).toBeUndefined();
    expect(g.fortSupply).toBe(before + 1);
    expect(g.units['5,1']!.coins).toBe(2); // the unit behind it is untouched
  });

  it('will not let a side raze its own fortification', () => {
    const g = bare();
    g.units['5,2'] = { unit: 'swordsman', team: 0, seat: 0, coins: 1 };
    g.forts['5,1'] = true;
    g.control['5,1'] = 0; // ours
    setHand(g, 0, ['swordsman', 'swordsman', 'swordsman']);
    expect(legalActions(g, 0).some((a) => a.type === 'attack' && a.to === '5,1')).toBe(false);
  });
});

describe('siege units', () => {
  it('only lets a bolstered unit start a siege tactic', () => {
    const g = game(['trebuchet', 'swordsman', 'knight', 'scout'], ['ensign', 'footman', 'cavalry', 'archer']);
    g.forts = {};
    g.units['5,1'] = { unit: 'trebuchet', team: 0, seat: 0, coins: 1 };
    g.units['5,3'] = { unit: 'ensign', team: 1, seat: 1, coins: 1 };
    setHand(g, 0, ['trebuchet', 'trebuchet', 'trebuchet']);
    expect(legalActions(g, 0).some((a) => a.type === 'tactic')).toBe(false);

    g.units['5,1']!.coins = 2;
    expect(legalActions(g, 0).some((a) => a.type === 'tactic')).toBe(true);
  });

  it('lobs the Trebuchet two or three hexes, over anything in the way', () => {
    const g = game(['trebuchet', 'swordsman', 'knight', 'scout'], ['ensign', 'footman', 'cavalry', 'archer']);
    g.forts = {};
    g.units['5,0'] = { unit: 'trebuchet', team: 0, seat: 0, coins: 2 };
    g.units['5,1'] = { unit: 'swordsman', team: 0, seat: 0, coins: 1 }; // in the way
    g.units['5,2'] = { unit: 'ensign', team: 1, seat: 1, coins: 1 };
    g.units['5,3'] = { unit: 'footman', team: 1, seat: 1, coins: 1 };
    setHand(g, 0, ['trebuchet', 'trebuchet', 'trebuchet']);

    const targets = legalActions(g, 0)
      .filter((a) => a.type === 'tactic')
      .map((a) => (a as { target?: string }).target);
    expect(targets).toContain('5,2'); // two away
    expect(targets).toContain('5,3'); // three away
    // And it cannot swing at an adjacent unit at all.
    expect(legalActions(g, 0).some((a) => a.type === 'attack')).toBe(false);
  });

  it('lets the Siege Tower attack twice and bolster itself on deploy', () => {
    const g = game(['siegeTower', 'swordsman', 'knight', 'scout'], ['ensign', 'footman', 'cavalry', 'archer']);
    g.forts = {};
    setHand(g, 0, ['siegeTower', 'siegeTower', 'siegeTower']);
    const supplyBefore = g.players[0]!.supply.siegeTower!;
    const loc = Object.keys(g.control).find((h) => g.control[h] === 0)!;
    applyAction(g, 0, { type: 'deploy', coin: 0, to: loc });
    expect(g.pending.at(-1)?.kind).toBe('bolsterSelf');
    applyAction(g, 0, find(g, 0, (a) => a.type === 'followBolster'));
    expect(g.units[loc]!.coins).toBe(2);
    expect(g.players[0]!.supply.siegeTower).toBe(supplyBefore - 1);

    // Two blows from one tactic.
    g.turn = 0;
    g.units['5,2'] = { unit: 'siegeTower', team: 0, seat: 0, coins: 2 };
    delete g.units[loc];
    g.units['5,1'] = { unit: 'ensign', team: 1, seat: 1, coins: 3 };
    setHand(g, 0, ['siegeTower', 'siegeTower', 'siegeTower']);
    applyAction(g, 0, find(g, 0, (a) => a.type === 'tactic'));
    expect(g.units['5,1']!.coins).toBe(2);
    applyAction(g, 0, find(g, 0, (a) => a.type === 'followAttack'));
    expect(g.units['5,1']!.coins).toBe(1);
  });

  it('pushes an ally with the War Wagon and follows into its space', () => {
    const g = game(['warWagon', 'swordsman', 'knight', 'scout'], ['ensign', 'footman', 'cavalry', 'archer']);
    g.forts = {};
    g.units['5,2'] = { unit: 'warWagon', team: 0, seat: 0, coins: 2 };
    g.units['5,1'] = { unit: 'swordsman', team: 0, seat: 0, coins: 1 };
    setHand(g, 0, ['warWagon', 'warWagon', 'warWagon']);

    const push = find(g, 0, (a) => a.type === 'tactic' && a.subject === '5,1' && a.to === '5,0');
    applyAction(g, 0, push);
    expect(g.units['5,0']!.unit).toBe('swordsman');
    expect(g.units['5,1']!.unit).toBe('warWagon'); // filled in behind
    expect(g.units['5,2']).toBeUndefined();
  });

  it('lets the War Wagon take a hit meant for a neighbour — the defender decides', () => {
    const g = game(['warWagon', 'swordsman', 'knight', 'scout'], ['ensign', 'footman', 'cavalry', 'archer']);
    g.forts = {};
    g.units['5,2'] = { unit: 'warWagon', team: 0, seat: 0, coins: 2 };
    g.units['5,1'] = { unit: 'swordsman', team: 0, seat: 0, coins: 1 };
    g.units['5,0'] = { unit: 'ensign', team: 1, seat: 1, coins: 1 };
    g.turn = 1;
    setHand(g, 1, ['ensign', 'ensign', 'ensign']);

    applyAction(g, 1, find(g, 1, (a) => a.type === 'attack' && a.to === '5,1'));
    expect(g.pending.at(-1)?.kind).toBe('absorbHit');
    expect(actingSeat(g)).toBe(0); // the defender answers, mid-attack
    applyAction(g, 0, find(g, 0, (a) => a.type === 'followAbsorb' && a.source === 'wagon'));
    expect(g.units['5,1']!.coins).toBe(1); // saved
    expect(g.units['5,2']!.coins).toBe(1); // the wagon paid
  });

  it('lets the Sapper move onto a bare location and raise a fortification', () => {
    const g = game(['sapper', 'swordsman', 'knight', 'scout'], ['ensign', 'footman', 'cavalry', 'archer']);
    g.forts = {};
    g.fortSupply = 3;
    g.units['5,2'] = { unit: 'sapper', team: 0, seat: 0, coins: 1 };
    setHand(g, 0, ['sapper', 'sapper', 'sapper']);

    applyAction(g, 0, find(g, 0, (a) => a.type === 'move' && a.to === '4,3'));
    expect(g.pending.at(-1)?.kind).toBe('buildFort');
    applyAction(g, 0, find(g, 0, (a) => a.type === 'followBuildFort'));
    expect(g.forts['4,3']).toBe(true);
    expect(g.fortSupply).toBe(2);
  });

  it('lets the Sapper move and then knock a fortification down', () => {
    const g = game(['sapper', 'swordsman', 'knight', 'scout'], ['ensign', 'footman', 'cavalry', 'archer']);
    g.forts = { '4,3': true };
    g.control['4,3'] = 1;
    g.fortSupply = 3;
    g.units['5,2'] = { unit: 'sapper', team: 0, seat: 0, coins: 1 };
    setHand(g, 0, ['sapper', 'sapper', 'sapper']);

    const raze = find(g, 0, (a) => a.type === 'tactic' && a.target === '4,3');
    applyAction(g, 0, raze);
    expect(g.forts['4,3']).toBeUndefined();
    expect(g.fortSupply).toBe(4);
  });
});
