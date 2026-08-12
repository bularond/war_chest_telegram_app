/**
 * The evaluation is tuned by matches, not by unit tests — what a weight *should*
 * be is a question no assertion can answer. What is checked here is the part
 * that is not a matter of taste: that a feature weighing zero changes nothing,
 * that a weights file written before a feature existed still means what it did,
 * and that the unit values are read off the cards rather than made up.
 */

import {
  boardFor,
  createGame,
  deployTargets,
  fromId,
  neighbors,
  toId,
  UNITS,
  type GameState,
  type HexId,
  type UnitId,
} from '@wc/shared';
import { describe, expect, it } from 'vitest';
import {
  BASE_WEIGHTS,
  evaluate,
  featureVector,
  FEATURES,
  weightsFromFit,
  type EvalWeights,
} from './eval.js';

function game(seed = 3): GameState {
  return createGame({
    id: 'eval',
    size: 2,
    seed,
    draftMode: 'random',
    seats: [
      { userId: 'a', displayName: 'A' },
      { userId: 'b', displayName: 'B' },
    ],
  });
}

/** Puts one coin on the board without conjuring it: it comes out of the bag. */
function place(state: GameState, seat: 0 | 1, unit: UnitId, hex: HexId): void {
  const p = state.players[seat]!;
  const inBag = p.bag.indexOf(unit);
  if (inBag !== -1) p.bag.splice(inBag, 1);
  state.units[hex] = { unit, team: p.team, seat, coins: 1 };
}

// Real hexes off the printed board: '4,1' and '5,1' touch, '2,1' is across the
// field from both. A made-up id would leave every unit with no neighbours and
// quietly turn the contact tests into assertions about nothing.
const HERE = '4,1' as HexId;
const NEXT_DOOR = '5,1' as HexId;
const FAR = '2,1' as HexId;

/** A position with one unit a side, out of contact. */
function duel(mine: UnitId, theirs: UnitId): GameState {
  const state = game();
  state.units = {};
  state.phase = 'play';
  place(state, 0, mine, HERE);
  place(state, 1, theirs, FAR);
  return state;
}

/** The same, but the two are standing next to each other. */
function contact(mine: UnitId, theirs: UnitId): GameState {
  const state = game();
  state.units = {};
  state.phase = 'play';
  place(state, 0, mine, HERE);
  place(state, 1, theirs, NEXT_DOOR);
  return state;
}

const only = (over: Partial<EvalWeights>): EvalWeights => ({
  ...BASE_WEIGHTS,
  markers: 0,
  material: 1,
  reserve: 0,
  proximity: 0,
  ...over,
});

describe('material by unit type', () => {
  it('counts coins and nothing else while both weights are zero', () => {
    // The Archer is a four-coin unit and the Swordsman a five-coin one, so any
    // reading by type would separate them. eval@3 scored this dead level and
    // must go on doing so.
    const state = duel('archer', 'swordsman');
    expect(evaluate(state, 0, only({}))).toBe(0);
  });

  it('leaves a weights file that predates the feature meaning what it meant', () => {
    const state = duel('archer', 'swordsman');
    // eval@3 on disk has no key for either feature; JSON gives back undefined,
    // and undefined must read as zero rather than poison the sum with NaN.
    const old = { ...only({}) } as Record<string, unknown>;
    for (const key of ['scarcity', 'reach', 'threat', 'deadWeight', 'tempo', 'hand']) delete old[key];
    expect(evaluate(state, 0, old as unknown as EvalWeights)).toBe(0);
  });

  it('prefers the scarcer unit once scarcity is switched on', () => {
    expect(UNITS.archer.coins).toBe(4);
    expect(UNITS.swordsman.coins).toBe(5);
    const state = duel('archer', 'swordsman');
    expect(evaluate(state, 0, only({ scarcity: 0.2 }))).toBeGreaterThan(0);
    // And the same position from the other side of the table is its mirror.
    expect(evaluate(state, 1, only({ scarcity: 0.2 }))).toBeLessThan(0);
  });

  it('prefers the unit that strikes from a distance once reach is switched on', () => {
    // The Archer shoots two hexes; the Footman's tactic moves other people.
    const state = duel('archer', 'footman');
    expect(evaluate(state, 0, only({ reach: 0.3, scarcity: 0 }))).toBeGreaterThan(0);
  });

  it('holds together when a weight is pushed negative', () => {
    // Nothing generates weights this hostile, but a descent step could, and a
    // unit worth less than nothing would take the normalising sum through zero.
    const state = duel('archer', 'swordsman');
    const score = evaluate(state, 0, only({ scarcity: -50 }));
    expect(Number.isFinite(score)).toBe(true);
    expect(score).toBeLessThanOrEqual(0);
  });

  it('reaches a real position, not just a hand-built one', () => {
    // A game played out far enough to have coins on the board: the feature has
    // to move the number there, or an experiment on it can only ever draw.
    const state = game(21);
    const bare = evaluate(state, 0, only({}));
    place(state, 0, 'archer', HERE);
    place(state, 1, 'swordsman', FAR);
    expect(evaluate(state, 0, only({ scarcity: 0.5 }))).not.toBe(bare);
  });
});

describe('threat', () => {
  it('is silent while nobody is in contact', () => {
    const state = duel('swordsman', 'swordsman');
    // Across the board from each other: neither can swing at the other.
    expect(evaluate(state, 0, only({ threat: 1, material: 0 }))).toBe(0);
  });

  it('cancels when both sides can swing', () => {
    const state = contact('pikeman', 'swordsman');
    // Contact is mutual; what the feature is for is the case where it is not.
    expect(evaluate(state, 0, only({ threat: 1, material: 0 }))).toBe(0);
  });

  it('does not count an archer as a threat, because the card says it is not', () => {
    expect(UNITS.archer.restrictions).toContain('noNormalAttack');
    const state = contact('swordsman', 'archer');
    // My swordsman threatens their archer; their archer cannot answer in kind.
    expect(evaluate(state, 0, only({ threat: 1, material: 0 }))).toBeGreaterThan(0);
    expect(evaluate(state, 1, only({ threat: 1, material: 0 }))).toBeLessThan(0);
  });
});

describe('tempo and the hand', () => {
  it('gives tempo to whoever owes the next decision', () => {
    const state = duel('swordsman', 'swordsman');
    const mine = evaluate(state, 0, only({ tempo: 1, material: 0 }));
    const theirs = evaluate(state, 1, only({ tempo: 1, material: 0 }));
    // Exactly one side is to move, and the two readings are mirror images.
    expect(mine).toBe(-theirs);
    expect(Math.abs(mine)).toBeGreaterThan(0);
  });

  it('counts the hand apart from the rest of the coins', () => {
    const state = duel('swordsman', 'swordsman');
    state.players[0]!.hand = ['swordsman', 'swordsman'];
    state.players[1]!.hand = ['swordsman'];
    expect(evaluate(state, 0, only({ hand: 1, material: 0 }))).toBeGreaterThan(0);
    // And `reserve` alone cannot see the difference, since it lumps the piles.
    const evened = evaluate(state, 0, only({ hand: 0, reserve: 1, material: 0 }));
    state.players[0]!.hand = ['swordsman'];
    state.players[0]!.bag.push('swordsman');
    expect(evaluate(state, 0, only({ hand: 0, reserve: 1, material: 0 }))).toBe(evened);
  });
});

describe('dead weight in hand', () => {
  it('is silent while every coin has somewhere to go', () => {
    const state = duel('swordsman', 'swordsman');
    for (const p of state.players) p.hand = [];
    expect(evaluate(state, 0, only({ deadWeight: 1, material: 0 }))).toBe(0);
  });

  it('leaves a coin alone while there is anywhere to deploy it', () => {
    // The case the first version of this feature got wrong: a unit absent from
    // the board is the *normal* state of a coin about to be deployed, and a
    // player who controls an empty location can always deploy it.
    const state = duel('swordsman', 'swordsman');
    for (const p of state.players) {
      p.hand = [];
      p.supply = {};
    }
    const ghost = state.players[0]!.units.find((u) => u !== 'swordsman') as UnitId;
    state.players[0]!.hand = [ghost];
    state.players[1]!.hand = ['swordsman'];
    expect(deployTargets(state, 0, ghost).length).toBeGreaterThan(0);
    expect(evaluate(state, 0, only({ deadWeight: 1, material: 0 }))).toBe(0);
  });

  it('counts a coin that can do nothing but claim the Initiative', () => {
    const state = duel('swordsman', 'swordsman');
    for (const p of state.players) {
      p.hand = [];
      p.supply = {};
    }
    const ghost = state.players[0]!.units.find((u) => u !== 'swordsman') as UnitId;
    // Nowhere to deploy: every location this side controls has something on it
    // already. Nothing to recruit: the supply is empty. Nothing to bolster or
    // move: no unit of that type on the board.
    for (const loc of boardFor(2).locations) {
      if (state.control[loc] === state.players[0]!.team) {
        state.units[loc] = { unit: 'swordsman', team: 0, seat: 0, coins: 1 };
      }
    }
    state.players[0]!.hand = [ghost];
    state.players[1]!.hand = ['swordsman'];
    expect(deployTargets(state, 0, ghost)).toEqual([]);
    expect(evaluate(state, 0, only({ deadWeight: 1, material: 0 }))).toBeLessThan(0);
  });

  it('leaves a coin alone while its unit is still in the supply', () => {
    const state = duel('swordsman', 'swordsman');
    for (const p of state.players) {
      p.hand = [];
      p.supply = {};
    }
    const spare = state.players[0]!.units.find((u) => u !== 'swordsman') as UnitId;
    state.players[0]!.hand = [spare];
    state.players[0]!.supply = { [spare]: 1 };
    state.players[1]!.hand = ['swordsman'];
    expect(evaluate(state, 0, only({ deadWeight: 1, material: 0 }))).toBe(0);
  });
});

describe('the base weights', () => {
  it('carries a version, since it is written into every game log', () => {
    expect(BASE_WEIGHTS.version).toMatch(/^eval@/);
  });

  it('play the same game as before every new feature was added', () => {
    // What makes it safe to add a feature while a night of matches is running:
    // at zero weight the code that computes it is never entered, so a rebuild
    // cannot change what the baseline plays. Checked on a real position rather
    // than argued from the source.
    const state = game(21);
    place(state, 0, 'archer', HERE);
    place(state, 1, 'swordsman', NEXT_DOOR);
    const untouched = { ...BASE_WEIGHTS } as Record<string, unknown>;
    for (const key of ['scarcity', 'reach', 'threat', 'deadWeight', 'tempo', 'hand']) delete untouched[key];
    expect(evaluate(state, 0, BASE_WEIGHTS)).toBe(
      evaluate(state, 0, untouched as unknown as EvalWeights),
    );
  });
});

describe('the feature vector', () => {
  // Two implementations of one formula: `evaluate` computes only what carries a
  // weight, `featureVector` computes everything. They will drift apart the first
  // time somebody edits one of them, unless something holds them together.
  it('is the same evaluation, written as a dot product', () => {
    const rand = (() => {
      let s = 987654321;
      return () => {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        return s / 0x7fffffff;
      };
    })();

    for (let round = 0; round < 60; round++) {
      const state = game(round + 1);
      // A position with coins on the board, hands dealt, and somebody in front.
      const hexes = ['4,1', '5,1', '2,1', '6,2', '3,3'] as HexId[];
      state.units = {};
      for (let i = 0; i < 5; i++) {
        const seat = (i % 2) as 0 | 1;
        const unit = state.players[seat]!.units[i % 4] as UnitId;
        place(state, seat, unit, hexes[i] as HexId);
        state.units[hexes[i] as HexId]!.coins = 1 + (i % 3);
      }
      state.phase = 'play';

      const weights: EvalWeights = {
        version: 'random',
        markers: rand() * 2 - 1,
        material: rand() * 2 - 1,
        // Kept modest on purpose: a unit whose multiplier would go negative is
        // clamped at zero in `evaluate`, and that clamp is the one place the
        // formula stops being linear. Nothing generates weights that hostile,
        // but the identity being checked here only holds on the linear side of
        // it.
        scarcity: rand() * 0.8 - 0.4,
        reach: rand() * 0.8 - 0.4,
        reserve: rand() * 2 - 1,
        bolster: rand() * 2 - 1,
        proximity: rand() * 2 - 1,
        initiative: rand() * 2 - 1,
        tempo: rand() * 2 - 1,
        hand: rand() * 2 - 1,
        threat: rand() * 2 - 1,
        deadWeight: rand() * 2 - 1,
        // Zero on purpose, and the identity below only holds that way: walking
        // proximity measures the same thing as straight-line proximity, so it
        // is deliberately absent from `FEATURES` — a fit that had both would
        // split one feature's weight between two coordinates.
        proximityWalk: 0,
      };

      for (const seat of [0, 1] as const) {
        const f = featureVector(state, seat);
        // The material trio multiplies rather than adds — `scarcity` is a weight
        // *inside* material — so the dot product uses the products, which is
        // exactly what `weightsFromFit` undoes.
        const products = FEATURES.map((key) => {
          if (key === 'scarcity' || key === 'reach') return weights.material * weights[key];
          return weights[key] as number;
        });
        const dot = f.reduce((sum, x, i) => sum + x * (products[i] as number), 0);
        expect(evaluate(state, seat, weights)).toBeCloseTo(Math.tanh(dot), 10);
      }
    }
  });

  it('reads a fitted vector back as weights', () => {
    const fit = FEATURES.map((_, i) => (i + 1) / 10);
    const w = weightsFromFit(fit, 'fitted');
    expect(w.version).toBe('fitted');
    expect(w.markers).toBeCloseTo(0.1, 10);
    expect(w.material).toBeCloseTo(0.2, 10);
    // The third and fourth coefficients are `material × scarcity` and
    // `material × reach`.
    expect(w.scarcity).toBeCloseTo(0.3 / 0.2, 10);
    expect(w.reach).toBeCloseTo(0.4 / 0.2, 10);
  });

  it('says nothing about unit types when it says nothing about material', () => {
    const fit = FEATURES.map(() => 0);
    const w = weightsFromFit(fit, 'flat');
    expect(w.scarcity).toBe(0);
    expect(w.reach).toBe(0);
  });
});

describe('proximity around what is in the way', () => {
  it('is silent while its weight is zero, like every other feature', () => {
    const state = duel('swordsman', 'swordsman');
    const both = { ...BASE_WEIGHTS } as Record<string, unknown>;
    delete both.proximityWalk;
    expect(evaluate(state, 0, BASE_WEIGHTS)).toBe(evaluate(state, 0, both as unknown as EvalWeights));
  });

  it('sees a wall that the straight-line version walks through', () => {
    const state = game(4);
    state.units = {};
    state.phase = 'play';

    // Exactly one location left to take — otherwise every unit is a step from
    // some other one and the measurement says nothing — with its whole ring of
    // neighbours filled by enemy units, and one of ours two hexes out. As the
    // crow flies it is two hexes away; on foot there is no way in at all.
    const board = boardFor(2);
    const target = board.locations.find((loc) => state.control[loc] === undefined) as HexId;
    for (const loc of board.locations) if (loc !== target) state.control[loc] = state.players[0]!.team;
    const ring = neighbors(fromId(target)).map(toId).filter((h) => board.hexes.includes(h));
    const outer = board.hexes.find(
      (h) => !ring.includes(h) && h !== target && ring.some((r) => neighbors(fromId(r)).map(toId).includes(h)),
    ) as HexId;

    place(state, 0, state.players[0]!.units[0] as UnitId, outer);
    for (const hex of ring) state.units[hex] = { unit: 'footman', team: 1, seat: 1, coins: 1 };

    const walk = { ...BASE_WEIGHTS, markers: 0, material: 0, reserve: 0, proximity: 0, proximityWalk: 1 };
    const straight = { ...walk, proximity: 1, proximityWalk: 0 };

    // Both readings are bad for us — the ring is made of enemies, and they are
    // as close to the location as anything can be. What is checked is that
    // walking notices the wall *as a wall* and marks the position down further.
    expect(evaluate(state, 0, walk)).toBeLessThan(evaluate(state, 0, straight));
  });
});
