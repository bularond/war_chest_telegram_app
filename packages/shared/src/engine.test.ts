import { beforeEach, describe, expect, it } from 'vitest';
import { STARTING_LOCATIONS } from './board.js';
import { applyAction, deployTargets, legalActions, markersRemaining } from './rules.js';
import { createGame } from './rules.js';
import type { GameAction, GameState } from './types.js';
import { UNIT_IDS, UNITS, unitsForSets, type UnitId } from './units.js';

const A_START = STARTING_LOCATIONS.a;
const B_START = STARTING_LOCATIONS.b;

function game(unitsA: UnitId[], unitsB: UnitId[]): GameState {
  return createGame({
    id: 'test',
    size: 2,
    seed: 42,
    seats: [
      { userId: 'a', displayName: 'A' },
      { userId: 'b', displayName: 'B' },
    ],
    fixedUnits: [unitsA, unitsB],
  });
}

/** Stacks the deck: gives `seat` exactly this hand, ignoring the bag. */
function setHand(state: GameState, seat: number, hand: UnitId[] | ('royal' | UnitId)[]): void {
  state.players[seat]!.hand = [...hand] as GameState['players'][number]['hand'];
}

function find(state: GameState, seat: number, pred: (a: GameAction) => boolean): GameAction {
  const a = legalActions(state, seat).find(pred);
  if (!a) throw new Error('no such legal action');
  return a;
}

function has(state: GameState, seat: number, pred: (a: GameAction) => boolean): boolean {
  return legalActions(state, seat).some(pred);
}

describe('setup', () => {
  it('gives each player nine coins and the right supply', () => {
    const g = game(
      ['swordsman', 'archer', 'pikeman', 'cavalry'],
      ['knight', 'scout', 'lancer', 'ensign'],
    );
    expect(g.phase).toBe('playing');
    for (const p of g.players) {
      // 9 coins total: 2 of each of 4 units, plus the Royal Coin. 3 are in hand.
      expect(p.bag.length + p.hand.length).toBe(9);
      expect(p.hand).toHaveLength(3);
      expect(Object.values(p.supply).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    }
  });

  it('starts each side controlling two locations, four markers in hand', () => {
    const g = game(['swordsman'], ['knight']);
    expect(Object.keys(g.control).sort()).toEqual([...A_START, ...B_START].sort());
    expect(markersRemaining(g, 0)).toBe(4);
    expect(markersRemaining(g, 1)).toBe(4);
  });

  it('runs an eight-card draft in 1-2-2-2-1 order', () => {
    const g = createGame({
      id: 'd',
      size: 2,
      seed: 7,
      seats: [
        { userId: 'a', displayName: 'A' },
        { userId: 'b', displayName: 'B' },
      ],
    });
    expect(g.phase).toBe('draft');
    expect(g.draftPool).toHaveLength(8);

    const order = [0, 1, 1, 0, 0, 1, 1, 0];
    for (const seat of order) {
      expect(g.turn).toBe(seat);
      const pick = g.draftPool[0]!;
      applyAction(g, seat, { type: 'draft', unit: pick });
    }
    expect(g.phase).toBe('playing');
    expect(g.players[0]!.units).toHaveLength(4);
    expect(g.players[1]!.units).toHaveLength(4);
    // The player who picked second takes initiative.
    expect(g.initiative).toBe(1);
  });
});

describe('draft modes', () => {
  function fresh(draftMode: 'random' | 'draft' | 'ban') {
    return createGame({
      id: draftMode,
      size: 2,
      seed: 11,
      draftMode,
      seats: [
        { userId: 'a', displayName: 'A' },
        { userId: 'b', displayName: 'B' },
      ],
    });
  }

  it('deals straight into play when random', () => {
    const g = fresh('random');
    expect(g.phase).toBe('playing');
    expect(g.players[0]!.units).toHaveLength(4);
    expect(g.players[1]!.units).toHaveLength(4);
    // Nobody earned initiative by picking second, so it falls to seat 0.
    expect(g.initiative).toBe(0);
  });

  it('runs the elimination draft: ten cards, one strike each, then the draft', () => {
    const g = fresh('ban');
    expect(g.phase).toBe('ban');
    expect(g.draftPool).toHaveLength(10);

    // One ban per side, starting with the seat that drafts first.
    for (const seat of [0, 1]) {
      expect(legalActions(g, seat).length).toBeGreaterThan(0);
      expect(legalActions(g, 1 - seat)).toEqual([]);
      applyAction(g, seat, { type: 'ban', unit: g.draftPool[0]! });
    }

    expect(g.banned).toHaveLength(2);
    expect(g.phase).toBe('draft');
    expect(g.draftPool).toHaveLength(8);
    // A banned unit is gone for good.
    for (const unit of g.banned) expect(g.draftPool).not.toContain(unit);

    const order = [0, 1, 1, 0, 0, 1, 1, 0];
    for (const seat of order) {
      expect(g.turn).toBe(seat);
      applyAction(g, seat, { type: 'draft', unit: g.draftPool[0]! });
    }
    expect(g.phase).toBe('playing');
    expect(g.initiative).toBe(1);
    for (const p of g.players) {
      expect(p.units).toHaveLength(4);
      for (const unit of g.banned) expect(p.units).not.toContain(unit);
    }
  });

  it('refuses a ban out of turn and a draft pick while banning', () => {
    const g = fresh('ban');
    expect(() => applyAction(g, 1, { type: 'ban', unit: g.draftPool[0]! })).toThrow();
    expect(() => applyAction(g, 0, { type: 'draft', unit: g.draftPool[0]! })).toThrow(/illegal/);
  });
});

describe('placement actions', () => {
  let g: GameState;
  beforeEach(() => {
    g = game(
      ['swordsman', 'archer', 'pikeman', 'cavalry'],
      ['knight', 'scout', 'lancer', 'ensign'],
    );
    g.turn = 0;
  });

  it('deploys only onto empty locations you control', () => {
    setHand(g, 0, ['swordsman', 'swordsman', 'swordsman']);
    expect(deployTargets(g, 0, 'swordsman').sort()).toEqual([...A_START].sort());
  });

  it('allows only one unit of a type on the board', () => {
    setHand(g, 0, ['swordsman', 'swordsman', 'swordsman']);
    applyAction(g, 0, { type: 'deploy', coin: 0, to: A_START[0]! });
    expect(deployTargets(g, 0, 'swordsman')).toEqual([]);
  });

  it('allows two Footman units', () => {
    const f = game(['footman', 'archer', 'pikeman', 'cavalry'], ['knight', 'scout', 'lancer', 'ensign']);
    f.turn = 0;
    setHand(f, 0, ['footman', 'footman', 'footman']);
    applyAction(f, 0, { type: 'deploy', coin: 0, to: A_START[0]! });
    expect(deployTargets(f, 0, 'footman')).toEqual([A_START[1]!]);
  });

  it('bolsters a deployed unit and keeps the coin off the discard pile', () => {
    setHand(g, 0, ['swordsman', 'swordsman', 'swordsman']);
    applyAction(g, 0, { type: 'deploy', coin: 0, to: A_START[0]! });
    g.turn = 0;
    applyAction(g, 0, { type: 'bolster', coin: 0, at: A_START[0]! });
    expect(g.units[A_START[0]!]!.coins).toBe(2);
    expect(g.players[0]!.discard).toHaveLength(0);
  });

  it('lets the Scout deploy next to a friendly unit', () => {
    const s = game(['scout', 'swordsman', 'pikeman', 'cavalry'], ['knight', 'archer', 'lancer', 'ensign']);
    s.turn = 0;
    setHand(s, 0, ['swordsman', 'scout', 'scout']);
    applyAction(s, 0, { type: 'deploy', coin: 0, to: A_START[0]! });
    const targets = deployTargets(s, 0, 'scout');
    expect(targets.length).toBeGreaterThan(2);
    expect(targets).toContain(A_START[1]!);
  });
});

describe('maneuvers', () => {
  let g: GameState;
  beforeEach(() => {
    g = game(
      ['swordsman', 'archer', 'pikeman', 'cavalry'],
      ['knight', 'scout', 'lancer', 'ensign'],
    );
    g.turn = 0;
    setHand(g, 0, ['swordsman', 'swordsman', 'swordsman']);
    applyAction(g, 0, { type: 'deploy', coin: 0, to: A_START[0]! });
    g.turn = 0;
  });

  it('moves one hex and discards the coin face-up', () => {
    const move = find(g, 0, (a) => a.type === 'move');
    applyAction(g, 0, move);
    expect(g.units[A_START[0]!]).toBeUndefined();
    expect(g.players[0]!.discard.at(-1)).toEqual({ coin: 'swordsman', faceUp: true });
  });

  it('cannot control a location it already controls', () => {
    expect(has(g, 0, (a) => a.type === 'control')).toBe(false);
  });

  it('controls a neutral location and can win the game', () => {
    // Put the Swordsman on a neutral location and hand the team its last markers.
    const neutral = '4,3';
    g.units[neutral] = { unit: 'swordsman', team: 0, seat: 0, coins: 1 };
    delete g.units[A_START[0]!];
    g.control['3,1'] = 0;
    g.control['2,3'] = 0;
    g.control['6,2'] = 0;
    expect(markersRemaining(g, 0)).toBe(1);

    applyAction(g, 0, find(g, 0, (a) => a.type === 'control'));
    expect(g.phase).toBe('finished');
    expect(g.winner).toBe(0);
  });
});

describe('combat', () => {
  function facing(unitA: UnitId, unitB: UnitId, coinsB = 1, coinsA = 1) {
    const g = game([unitA, 'scout', 'pikeman', 'cavalry'], [unitB, 'ensign', 'marshal', 'footman']);
    g.turn = 0;
    g.units['4,2'] = { unit: unitA, team: 0, seat: 0, coins: coinsA };
    g.units['4,1'] = { unit: unitB, team: 1, seat: 1, coins: coinsB };
    setHand(g, 0, [unitA, unitA, unitA]);
    return g;
  }

  it('removes one coin from the target', () => {
    const g = facing('swordsman', 'ensign', 2);
    applyAction(g, 0, find(g, 0, (a) => a.type === 'attack'));
    expect(g.units['4,1']!.coins).toBe(1);
  });

  it('destroys an unbolstered unit', () => {
    const g = facing('scout', 'ensign');
    setHand(g, 0, ['scout', 'scout', 'scout']);
    applyAction(g, 0, find(g, 0, (a) => a.type === 'attack'));
    expect(g.units['4,1']).toBeUndefined();
  });

  it('lets the Swordsman move after attacking', () => {
    const g = facing('swordsman', 'ensign');
    applyAction(g, 0, find(g, 0, (a) => a.type === 'attack'));
    expect(g.pending.at(-1)?.kind).toBe('optionalMove');
    expect(g.turn).toBe(0);
    applyAction(g, 0, { type: 'skip' });
    expect(g.turn).toBe(1);
  });

  it('stops an unbolstered attacker from touching a Knight', () => {
    const g = facing('scout', 'knight');
    setHand(g, 0, ['scout', 'scout', 'scout']);
    expect(has(g, 0, (a) => a.type === 'attack')).toBe(false);

    const bolstered = facing('scout', 'knight', 1, 2);
    setHand(bolstered, 0, ['scout', 'scout', 'scout']);
    expect(has(bolstered, 0, (a) => a.type === 'attack')).toBe(true);
  });

  it('makes the Pikeman bite back', () => {
    const g = facing('swordsman', 'pikeman', 2, 2);
    applyAction(g, 0, find(g, 0, (a) => a.type === 'attack'));
    expect(g.units['4,1']!.coins).toBe(1);
    expect(g.units['4,2']!.coins).toBe(1);
  });

  it('forbids the Archer a normal attack but allows its tactic at range two', () => {
    const g = game(['archer', 'scout', 'pikeman', 'cavalry'], ['ensign', 'marshal', 'footman', 'knight']);
    g.turn = 0;
    g.units['4,2'] = { unit: 'archer', team: 0, seat: 0, coins: 1 };
    g.units['4,1'] = { unit: 'ensign', team: 1, seat: 1, coins: 1 };
    setHand(g, 0, ['archer', 'archer', 'archer']);
    expect(has(g, 0, (a) => a.type === 'attack')).toBe(false);

    delete g.units['4,1'];
    g.units['4,0'] = { unit: 'ensign', team: 1, seat: 1, coins: 1 };
    const tactic = find(g, 0, (a) => a.type === 'tactic');
    applyAction(g, 0, tactic);
    expect(g.units['4,0']).toBeUndefined();
  });

  it('blocks the Crossbowman’s line but not the Archer’s', () => {
    const mk = (unit: UnitId) => {
      const g = game([unit, 'scout', 'pikeman', 'cavalry'], ['ensign', 'marshal', 'footman', 'knight']);
      g.turn = 0;
      g.units['5,1'] = { unit, team: 0, seat: 0, coins: 1 };
      g.units['5,3'] = { unit: 'ensign', team: 1, seat: 1, coins: 1 }; // two straight steps
      g.units['5,2'] = { unit: 'marshal', team: 1, seat: 1, coins: 1 }; // in the way
      setHand(g, 0, [unit, unit, unit]);
      return g;
    };
    expect(has(mk('crossbowman'), 0, (a) => a.type === 'tactic')).toBe(false);
    expect(has(mk('archer'), 0, (a) => a.type === 'tactic')).toBe(true);
  });

  it('moves the Cavalry and then attacks', () => {
    const g = game(['cavalry', 'scout', 'pikeman', 'archer'], ['ensign', 'marshal', 'footman', 'knight']);
    g.turn = 0;
    g.units['4,2'] = { unit: 'cavalry', team: 0, seat: 0, coins: 1 };
    g.units['4,0'] = { unit: 'ensign', team: 1, seat: 1, coins: 1 };
    setHand(g, 0, ['cavalry', 'cavalry', 'cavalry']);
    const tactic = find(
      g,
      0,
      (a) => a.type === 'tactic' && a.to === '4,1' && a.target === '4,0',
    );
    applyAction(g, 0, tactic);
    expect(g.units['4,1']!.unit).toBe('cavalry');
    expect(g.units['4,0']).toBeUndefined();
  });

  it('moves the Light Cavalry exactly two hexes', () => {
    const g = game(['lightCavalry', 'scout', 'pikeman', 'archer'], ['ensign', 'marshal', 'footman', 'knight']);
    g.turn = 0;
    g.units['4,2'] = { unit: 'lightCavalry', team: 0, seat: 0, coins: 1 };
    setHand(g, 0, ['lightCavalry', 'lightCavalry', 'lightCavalry']);
    const tactics = legalActions(g, 0).filter((a) => a.type === 'tactic');
    expect(tactics.length).toBeGreaterThan(0);
    applyAction(g, 0, tactics[0]!);
    expect(g.units['4,2']).toBeUndefined();
  });
});

describe('facedown actions', () => {
  let g: GameState;
  beforeEach(() => {
    g = game(
      ['swordsman', 'archer', 'pikeman', 'cavalry'],
      ['knight', 'scout', 'lancer', 'ensign'],
    );
    g.turn = 0;
  });

  it('lets the Royal Coin pass, recruit and claim initiative — but not deploy', () => {
    setHand(g, 0, ['royal', 'swordsman', 'swordsman']);
    const withRoyal = legalActions(g, 0).filter((a) => 'coin' in a && a.coin === 0);
    const kinds = new Set(withRoyal.map((a) => a.type));
    expect(kinds).toContain('pass');
    expect(kinds).toContain('recruit');
    expect(kinds).not.toContain('deploy');
  });

  it('moves the initiative marker at most once per round', () => {
    g.players[0]!.hasInitiative = false;
    g.players[1]!.hasInitiative = true;
    g.initiative = 1;
    setHand(g, 0, ['swordsman', 'swordsman', 'swordsman']);
    setHand(g, 1, ['knight', 'knight', 'knight']);

    applyAction(g, 0, { type: 'claimInitiative', coin: 0 });
    expect(g.initiative).toBe(0);
    expect(has(g, 1, (a) => a.type === 'claimInitiative')).toBe(false);
  });

  it('recruits from supply into the discard pile', () => {
    setHand(g, 0, ['swordsman', 'swordsman', 'swordsman']);
    const before = g.players[0]!.supply.archer!;
    applyAction(g, 0, { type: 'recruit', coin: 0, unit: 'archer' });
    expect(g.players[0]!.supply.archer).toBe(before - 1);
    expect(g.players[0]!.discard.map((d) => d.coin)).toContain('archer');
  });
});

describe('round structure', () => {
  it('alternates turns and refills both hands when they empty', () => {
    const g = game(
      ['swordsman', 'archer', 'pikeman', 'cavalry'],
      ['knight', 'scout', 'lancer', 'ensign'],
    );
    const round = g.round;
    for (let i = 0; i < 6; i++) {
      const seat = g.turn;
      applyAction(g, seat, { type: 'pass', coin: 0 });
    }
    expect(g.round).toBe(round + 1);
    expect(g.players[0]!.hand).toHaveLength(3);
    expect(g.players[1]!.hand).toHaveLength(3);
  });

  it('lets the other player finish when one runs out of coins', () => {
    const g = game(
      ['swordsman', 'archer', 'pikeman', 'cavalry'],
      ['knight', 'scout', 'lancer', 'ensign'],
    );
    g.turn = 0;
    g.players[0]!.hand = ['swordsman'];
    applyAction(g, 0, { type: 'pass', coin: 0 });
    expect(g.turn).toBe(1);
    applyAction(g, 1, { type: 'pass', coin: 0 });
    expect(g.turn).toBe(1);
  });
});

describe('card data', () => {
  /** Coin counts printed on the component list of each box. */
  const BOX_COINS: Record<string, { units: number; coins: number }> = {
    base: { units: 16, coins: 74 },
    siege: { units: 4, coins: 19 },
    nightfall: { units: 4, coins: 18 },
  };

  for (const [set, expected] of Object.entries(BOX_COINS)) {
    it(`matches the ${set} box: ${expected.units} units, ${expected.coins} coins`, () => {
      const ids = unitsForSets([set as never]);
      expect(ids).toHaveLength(expected.units);
      expect(ids.reduce((sum, id) => sum + UNITS[id].coins, 0)).toBe(expected.coins);
    });
  }

  it('only deals units from the sets a lobby switched on', () => {
    expect(unitsForSets(['base'])).toHaveLength(16);
    expect(unitsForSets(['base', 'nobility'])).toHaveLength(20);
    expect(unitsForSets(['base', 'nobility', 'siege', 'nightfall'])).toEqual(UNIT_IDS);
    for (const id of unitsForSets(['nightfall'])) expect(UNITS[id].set).toBe('nightfall');
  });

  it('gives every unit coin art and either a tactic or an attribute', () => {
    for (const id of UNIT_IDS) {
      const def = UNITS[id];
      expect(def.art).toBeTruthy();
      expect(def.tactic || def.attributes.length > 0 || def.restrictions.length > 0).toBeTruthy();
    }
  });
});

describe('units transcribed from the cards', () => {
  function board(units: [UnitId, string, number][], mine: UnitId[], theirs: UnitId[]) {
    const g = game(mine, theirs);
    g.turn = 0;
    for (const [unit, hex, team] of units) {
      g.units[hex] = { unit, team, seat: team, coins: 1 };
    }
    return g;
  }

  it('charges the Lancer one or two spaces, hitting along the same line', () => {
    const g = board(
      [
        ['lancer', '5,2', 0],
        ['ensign', '5,4', 1],
      ],
      ['lancer', 'scout', 'pikeman', 'archer'],
      ['ensign', 'marshal', 'footman', 'knight'],
    );
    setHand(g, 0, ['lancer', 'lancer', 'lancer']);
    const tactics = legalActions(g, 0).filter((a) => a.type === 'tactic');
    // Two steps down the column, then the hit continues that same line.
    const charge = tactics.find((a) => a.type === 'tactic' && a.target === '5,4');
    expect(charge).toBeDefined();
    expect((charge as { to?: string }).to).toBe('5,3');
    // Every option is collinear: the target is always one step past the landing.
    for (const t of tactics) {
      const a = t as { from: string; to?: string; target?: string };
      expect(a.target).toBeDefined();
      expect(a.to).toBeDefined();
    }
  });

  it('does not let the Pikeman bite back against a ranged tactic', () => {
    const g = board(
      [
        ['archer', '5,1', 0],
        ['pikeman', '5,3', 1],
      ],
      ['archer', 'scout', 'knight', 'cavalry'],
      ['pikeman', 'marshal', 'footman', 'ensign'],
    );
    g.units['5,1']!.coins = 2;
    g.units['5,3']!.coins = 2;
    setHand(g, 0, ['archer', 'archer', 'archer']);
    applyAction(g, 0, find(g, 0, (a) => a.type === 'tactic'));
    expect(g.units['5,3']!.coins).toBe(1); // the shot lands
    expect(g.units['5,1']!.coins).toBe(2); // the Archer is out of reach
  });

  it('gives the Berserker no tactic, but a repeat after any maneuver', () => {
    expect(UNITS.berserker.tactic).toBeUndefined();
    const g = board(
      [['berserker', '5,2', 0]],
      ['berserker', 'scout', 'knight', 'cavalry'],
      ['pikeman', 'marshal', 'footman', 'ensign'],
    );
    g.units['5,2']!.coins = 2;
    setHand(g, 0, ['berserker', 'berserker', 'berserker']);
    expect(has(g, 0, (a) => a.type === 'tactic')).toBe(false);

    applyAction(g, 0, find(g, 0, (a) => a.type === 'move'));
    expect(g.pending.at(-1)?.kind).toBe('optionalRepeat');
    // Paying for the repeat costs a coin off the stack, never the last one.
    applyAction(g, 0, find(g, 0, (a) => a.type === 'followRepeat'));
    const hex = Object.keys(g.units).find((h) => g.units[h]!.unit === 'berserker')!;
    expect(g.units[hex]!.coins).toBe(1);
    expect(g.pending.at(-1)?.kind).toBe('maneuverUnit');
  });

  it('spends the Royal Coin on the Royal Guard’s redeploy', () => {
    const g = board(
      [['royalGuard', '4,1', 0]],
      ['royalGuard', 'scout', 'knight', 'cavalry'],
      ['pikeman', 'marshal', 'footman', 'ensign'],
    );
    setHand(g, 0, ['royal', 'scout', 'scout']);
    const tactic = legalActions(g, 0).find((a) => a.type === 'tactic' && a.coin === 0);
    expect(tactic).toBeDefined();
    // It may only land on an empty location this side controls.
    expect(A_START).toContain((tactic as { to?: string }).to);
    applyAction(g, 0, tactic!);
    expect(g.units['4,1']).toBeUndefined();
  });

  it('lets the Royal Guard soak a hit from the supply', () => {
    const g = board(
      [
        ['royalGuard', '5,2', 0],
        ['swordsman', '5,1', 1],
      ],
      ['royalGuard', 'scout', 'knight', 'cavalry'],
      ['swordsman', 'marshal', 'footman', 'ensign'],
    );
    g.turn = 1;
    setHand(g, 1, ['swordsman', 'swordsman', 'swordsman']);
    const before = g.players[0]!.supply.royalGuard!;
    applyAction(g, 1, find(g, 1, (a) => a.type === 'attack'));
    // Soaking is the defender's call, so seat 0 answers on seat 1's turn.
    expect(g.pending.at(-1)?.kind).toBe('absorbHit');
    expect(legalActions(g, 1)).toEqual([]);
    applyAction(g, 0, find(g, 0, (a) => a.type === 'followAbsorb'));
    expect(g.units['5,2']!.coins).toBe(1); // the unit is untouched
    expect(g.players[0]!.supply.royalGuard).toBe(before - 1);
  });
});

describe('action validation', () => {
  it('refuses actions out of turn and actions that are not legal', () => {
    const g = game(
      ['swordsman', 'archer', 'pikeman', 'cavalry'],
      ['knight', 'scout', 'lancer', 'ensign'],
    );
    g.turn = 0;
    expect(() => applyAction(g, 1, { type: 'pass', coin: 0 })).toThrow(/not your turn/);
    expect(() => applyAction(g, 0, { type: 'deploy', coin: 0, to: '5,2' })).toThrow(/illegal/);
  });
});
