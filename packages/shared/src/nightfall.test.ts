/** War Chest: Nightfall — Poison Counters, Decoy Coins and the four new units. */

import { describe, expect, it } from 'vitest';
import { actingSeat, applyAction, decoyAvailable, legalActions, poisonedHex } from './engine.js';
import { createGame } from './setup.js';
import type { GameAction, GameState } from './types.js';
import type { CoinId, UnitId } from './units.js';

function game(unitsA: UnitId[], unitsB: UnitId[]): GameState {
  const g = createGame({
    id: 'nf',
    size: 2,
    seed: 6,
    sets: ['nightfall'],
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

describe('poison', () => {
  function poisoned(): GameState {
    const g = game(['assassin', 'saboteur', 'knight', 'scout'], ['swordsman', 'footman', 'ensign', 'cavalry']);
    g.units['5,2'] = { unit: 'assassin', team: 0, seat: 0, coins: 1 };
    g.units['5,1'] = { unit: 'swordsman', team: 1, seat: 1, coins: 2 };
    return g;
  }

  it('lets the Assassin move and then poison a neighbour', () => {
    const g = poisoned();
    setHand(g, 0, ['assassin', 'assassin', 'assassin']);
    const tactic = find(g, 0, (a) => a.type === 'tactic' && a.target === '5,1');
    applyAction(g, 0, tactic);
    expect(g.units['5,1']!.poisonedBy).toBe('assassin');
    expect(poisonedHex(g, 'assassin')).toBe('5,1');
  });

  it('moves the counter rather than adding a second', () => {
    const g = poisoned();
    g.units['4,1'] = { unit: 'ensign', team: 1, seat: 1, coins: 1 };
    g.units['5,1']!.poisonedBy = 'assassin';
    setHand(g, 0, ['assassin', 'assassin', 'assassin']);

    const tactic = find(g, 0, (a) => a.type === 'tactic' && a.target === '4,1');
    applyAction(g, 0, tactic);
    expect(g.units['4,1']!.poisonedBy).toBe('assassin');
    expect(g.units['5,1']!.poisonedBy).toBeUndefined(); // the first victim is free
  });

  it('freezes a unit’s own coins but not what others grant it', () => {
    const g = game(['swordsman', 'marshal', 'knight', 'scout'], ['assassin', 'footman', 'ensign', 'cavalry']);
    g.units['5,2'] = { unit: 'swordsman', team: 0, seat: 0, coins: 1, poisonedBy: 'assassin' };
    g.units['5,3'] = { unit: 'marshal', team: 0, seat: 0, coins: 1 };
    g.units['5,1'] = { unit: 'ensign', team: 1, seat: 1, coins: 1 };
    setHand(g, 0, ['swordsman', 'marshal', 'marshal']);

    // Its own coin buys nothing on the board — except lifting the poison.
    const own = legalActions(g, 0).filter((a) => 'coin' in a && a.coin === 0);
    const kinds = new Set(own.map((a) => a.type));
    expect(kinds).not.toContain('move');
    expect(kinds).not.toContain('attack');
    expect(kinds).not.toContain('bolster');
    expect(kinds).toContain('unpoison');

    // The Marshall can still order it to attack.
    const marshalTactic = find(g, 0, (a) => a.type === 'tactic' && a.subject === '5,2');
    applyAction(g, 0, marshalTactic);
    expect(legalActions(g, 0).some((a) => a.type === 'followAttack' && a.from === '5,2')).toBe(true);
  });

  it('lifts every counter off that unit type for one coin, and is not a maneuver', () => {
    const g = game(['footman', 'berserker', 'knight', 'scout'], ['assassin', 'saboteur', 'ensign', 'cavalry']);
    g.units['5,2'] = { unit: 'footman', team: 0, seat: 0, coins: 1, poisonedBy: 'assassin' };
    g.units['4,2'] = { unit: 'footman', team: 0, seat: 0, coins: 1, poisonedBy: 'saboteur' };
    setHand(g, 0, ['footman', 'footman', 'footman']);

    applyAction(g, 0, find(g, 0, (a) => a.type === 'unpoison'));
    expect(g.units['5,2']!.poisonedBy).toBeUndefined();
    expect(g.units['4,2']!.poisonedBy).toBeUndefined();
    // Curing is not a maneuver, so nothing is queued and the turn simply passes.
    expect(g.pending).toHaveLength(0);
    expect(g.turn).toBe(1);
  });

  it('poisons at one or two spaces with the Saboteur, over a unit in between', () => {
    const g = game(['saboteur', 'assassin', 'knight', 'scout'], ['swordsman', 'footman', 'ensign', 'cavalry']);
    g.units['5,1'] = { unit: 'saboteur', team: 0, seat: 0, coins: 1 };
    g.units['5,2'] = { unit: 'ensign', team: 1, seat: 1, coins: 1 }; // adjacent
    g.units['5,3'] = { unit: 'footman', team: 1, seat: 1, coins: 1 }; // two away, screened
    setHand(g, 0, ['saboteur', 'saboteur', 'saboteur']);

    const targets = legalActions(g, 0)
      .filter((a) => a.type === 'tactic')
      .map((a) => (a as { target?: string }).target);
    expect(targets).toContain('5,2');
    expect(targets).toContain('5,3');
  });

  it('burns a coin off a poisoned victim the Assassin finishes', () => {
    const g = game(['assassin', 'saboteur', 'knight', 'scout'], ['swordsman', 'footman', 'ensign', 'cavalry']);
    g.units['5,2'] = { unit: 'assassin', team: 0, seat: 0, coins: 1 };
    g.units['5,1'] = { unit: 'swordsman', team: 1, seat: 1, coins: 2, poisonedBy: 'assassin' };
    setHand(g, 0, ['assassin', 'assassin', 'assassin']);
    const before = g.players[1]!.supply.swordsman!;

    applyAction(g, 0, find(g, 0, (a) => a.type === 'attack' && a.to === '5,1'));
    expect(g.pending.some((s) => s.kind === 'burnSupply')).toBe(true);
    applyAction(g, 0, find(g, 0, (a) => a.type === 'followBurn'));
    expect(g.players[1]!.supply.swordsman).toBe(before - 1);
  });
});

describe('decoy coins', () => {
  it('plants one on the opponent when the Infiltrator takes a location', () => {
    const g = game(['infiltrator', 'saboteur', 'knight', 'scout'], ['swordsman', 'footman', 'ensign', 'cavalry']);
    // Sitting next to a location the opponent holds.
    g.control['4,3'] = 1;
    g.units['5,2'] = { unit: 'infiltrator', team: 0, seat: 0, coins: 1 };
    setHand(g, 0, ['infiltrator', 'infiltrator', 'infiltrator']);
    expect(decoyAvailable(g, 'decoyInfiltrator')).toBe(true);

    applyAction(g, 0, find(g, 0, (a) => a.type === 'tactic' && a.to === '4,3'));
    expect(g.control['4,3']).toBe(0);
    applyAction(g, 0, find(g, 0, (a) => a.type === 'followDeceive'));
    expect(g.players[1]!.discard.map((d) => d.coin)).toContain('decoyInfiltrator');
    expect(decoyAvailable(g, 'decoyInfiltrator')).toBe(false);
  });

  it('is good for facedown actions and handing back, nothing else', () => {
    const g = game(['swordsman', 'knight', 'scout', 'cavalry'], ['infiltrator', 'footman', 'ensign', 'saboteur']);
    g.units['5,2'] = { unit: 'swordsman', team: 0, seat: 0, coins: 1 };
    setHand(g, 0, ['decoyInfiltrator', 'swordsman', 'swordsman']);

    const withDecoy = legalActions(g, 0).filter((a) => 'coin' in a && a.coin === 0);
    const kinds = new Set(withDecoy.map((a) => a.type));
    expect(kinds).toEqual(new Set(['returnDecoy', 'pass', 'claimInitiative', 'recruit']));

    applyAction(g, 0, find(g, 0, (a) => a.type === 'returnDecoy'));
    // It goes back beside its card rather than into the discard pile.
    expect(g.players[0]!.hand).toHaveLength(2);
    expect(g.players[0]!.discard.map((d) => d.coin)).not.toContain('decoyInfiltrator');
    expect(decoyAvailable(g, 'decoyInfiltrator')).toBe(true);
  });

  it('lets the Skirmisher shrug off a blow with its decoy — the defender decides', () => {
    const g = game(['skirmisher', 'knight', 'scout', 'cavalry'], ['swordsman', 'footman', 'ensign', 'saboteur']);
    g.units['5,2'] = { unit: 'skirmisher', team: 0, seat: 0, coins: 1 };
    g.units['5,1'] = { unit: 'swordsman', team: 1, seat: 1, coins: 1 };
    g.turn = 1;
    setHand(g, 1, ['swordsman', 'swordsman', 'swordsman']);

    applyAction(g, 1, find(g, 1, (a) => a.type === 'attack' && a.to === '5,2'));
    expect(actingSeat(g)).toBe(0);
    applyAction(g, 0, find(g, 0, (a) => a.type === 'followAbsorb' && a.source === 'decoy'));
    expect(g.units['5,2']).toBeDefined(); // the attack removed nothing
    expect(g.units['5,2']!.coins).toBe(1);
    expect(g.players[1]!.discard.map((d) => d.coin)).toContain('decoySkirmisher');
  });

  it('moves the Skirmisher two spaces, ending next to an enemy', () => {
    const g = game(['skirmisher', 'knight', 'scout', 'cavalry'], ['swordsman', 'footman', 'ensign', 'saboteur']);
    g.units['5,3'] = { unit: 'skirmisher', team: 0, seat: 0, coins: 1 };
    g.units['5,0'] = { unit: 'swordsman', team: 1, seat: 1, coins: 1 };
    setHand(g, 0, ['skirmisher', 'skirmisher', 'skirmisher']);

    const ends = legalActions(g, 0)
      .filter((a) => a.type === 'tactic')
      .map((a) => (a as { to?: string }).to);
    expect(ends.length).toBeGreaterThan(0);
    expect(ends).toContain('5,1'); // two hexes up, right beside the enemy
    expect(ends).not.toContain('5,5'); // nothing to skirmish with down there
  });
});

/**
 * «After you recruit a Saboteur, you may use the Saboteur's tactic.»
 *
 * The attribute was declared on the card and read by nothing at all — two
 * mentions in `units.ts` and none anywhere else — so the printed ability could
 * not be reached in any game. The tactic belongs to a Saboteur already standing
 * on the board: recruiting puts a coin in the discard pile, and nothing is
 * played from there.
 */
describe('the Saboteur, having been recruited', () => {
  function ready(): GameState {
    const g = game(['saboteur', 'knight', 'scout', 'archer'], ['swordsman', 'footman', 'ensign', 'cavalry']);
    g.units['5,2'] = { unit: 'saboteur', team: 0, seat: 0, coins: 1 };
    g.units['5,0'] = { unit: 'swordsman', team: 1, seat: 1, coins: 1 };
    setHand(g, 0, ['saboteur', 'knight', 'scout']);
    return g;
  }

  it('offers its tactic for free, and it costs no coin', () => {
    const g = ready();
    const held = g.players[0]!.hand.length;
    applyAction(g, 0, find(g, 0, (a) => a.type === 'recruit' && a.unit === 'saboteur'));
    expect(g.pending[g.pending.length - 1]?.kind).toBe('freeTactic');

    const poison = find(g, 0, (a) => a.type === 'followTactic' && a.target === '5,0');
    applyAction(g, 0, poison);
    expect(g.units['5,0']!.poisonedBy).toBe('saboteur');
    // One coin left the hand: the one that paid for the recruit. The tactic is
    // free, which is the whole of what the card says.
    expect(g.players[0]!.hand.length).toBe(held - 1);
  });

  it('may be declined', () => {
    const g = ready();
    applyAction(g, 0, find(g, 0, (a) => a.type === 'recruit' && a.unit === 'saboteur'));
    expect(legalActions(g, 0).some((a) => a.type === 'skip')).toBe(true);
    applyAction(g, 0, { type: 'skip' });
    expect(g.units['5,0']!.poisonedBy).toBeUndefined();
    expect(g.pending).toHaveLength(0);
  });

  it('asks nothing when no Saboteur is on the board', () => {
    const g = ready();
    delete g.units['5,2'];
    applyAction(g, 0, find(g, 0, (a) => a.type === 'recruit' && a.unit === 'saboteur'));
    // The step is still pushed — legality is one place, not two — and the only
    // answer to it is to pass.
    expect(legalActions(g, 0)).toEqual([{ type: 'skip' }]);
  });
});
