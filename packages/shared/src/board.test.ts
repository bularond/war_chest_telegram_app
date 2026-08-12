import { describe, expect, it } from 'vitest';
import {
  DUEL_BOARD,
  DUEL_BOARD_HEXES,
  DUEL_LOCATIONS,
  DUEL_LOCATIONS_BY_SIDE,
  FULL_BOARD_HEXES,
  FULL_BOARD_LOCATIONS,
  STARTING_LOCATIONS,
} from './board.js';
import {
  DIRECTIONS,
  distance,
  fromId,
  neighbors,
  step,
  straightLineBetween,
  toAxial,
  toId,
} from './hex.js';

/** 180° rotation of the printed board, about the centre hex `5,2`. */
function rotate(id: string): string {
  const a = toAxial(fromId(id));
  const q = 10 - a.q;
  const s = -a.s;
  return toId({ col: q, row: s + (q - (q & 1)) / 2 });
}

describe('board geometry', () => {
  it('has the 47 hexes of the printed board', () => {
    expect(FULL_BOARD_HEXES).toHaveLength(47);
  });

  it('uses a regular radius-3 hexagon for two players', () => {
    expect(DUEL_BOARD_HEXES).toHaveLength(37);
    expect(DUEL_BOARD_HEXES.every((h) => FULL_BOARD_HEXES.includes(h))).toBe(true);
  });

  it('has 14 locations, 10 of them reachable in a duel', () => {
    expect(FULL_BOARD_LOCATIONS).toHaveLength(14);
    expect(DUEL_LOCATIONS).toHaveLength(10);
  });

  it('is symmetric under a half turn', () => {
    const hexes = new Set(FULL_BOARD_HEXES);
    for (const h of hexes) expect(hexes.has(rotate(h))).toBe(true);
    const locs = new Set(FULL_BOARD_LOCATIONS);
    for (const l of locs) expect(locs.has(rotate(l))).toBe(true);
  });

  it('maps one side’s starting locations onto the other’s', () => {
    expect(STARTING_LOCATIONS.a.map(rotate).sort()).toEqual([...STARTING_LOCATIONS.b].sort());
  });

  it('starts the sides facing each other across the short axis', () => {
    // Straight off the set-up diagram on page 4: the dark markers sit on the
    // two locations along the top edge, the light ones along the bottom.
    expect(STARTING_LOCATIONS.a).toEqual(['4,0', '7,0']);
    expect(STARTING_LOCATIONS.b).toEqual(['3,4', '6,5']);

    // Which means each side's five nearest locations are its own half of the
    // board — what the Fortification map cards are laid out over.
    const rows = (side: readonly string[]) =>
      side.map((id) => fromId(id).row + (fromId(id).col & 1 ? 0.5 : 0));
    expect(Math.max(...rows(DUEL_LOCATIONS_BY_SIDE[0]))).toBeLessThan(
      Math.min(...rows(DUEL_LOCATIONS_BY_SIDE[1])),
    );
    for (const side of DUEL_LOCATIONS_BY_SIDE) expect(side).toHaveLength(5);
    for (const loc of STARTING_LOCATIONS.a) expect(DUEL_LOCATIONS_BY_SIDE[0]).toContain(loc);
    for (const loc of STARTING_LOCATIONS.b) expect(DUEL_LOCATIONS_BY_SIDE[1]).toContain(loc);
  });

  it('starts each side controlling two locations', () => {
    expect(DUEL_BOARD.startingLocations).toEqual([STARTING_LOCATIONS.a, STARTING_LOCATIONS.b]);
    for (const side of DUEL_BOARD.startingLocations) {
      expect(side).toHaveLength(2);
      for (const loc of side) expect(DUEL_LOCATIONS).toContain(loc);
    }
  });

  it('keeps the board connected — every hex touches another', () => {
    const hexes = new Set(FULL_BOARD_HEXES);
    for (const h of hexes) {
      const touching = neighbors(fromId(h))
        .map(toId)
        .filter((n) => hexes.has(n));
      expect(touching.length).toBeGreaterThan(0);
    }
  });
});

describe('hex maths', () => {
  it('gives every neighbour distance 1', () => {
    for (const n of neighbors({ col: 5, row: 2 })) {
      expect(distance({ col: 5, row: 2 }, n)).toBe(1);
    }
  });

  it('finds straight lines and rejects bent ones', () => {
    const from = { col: 5, row: 2 };
    for (const dir of DIRECTIONS) {
      const two = step(from, dir, 2);
      expect(distance(from, two)).toBe(2);
      expect(straightLineBetween(from, two, 2)).toEqual([step(from, dir)]);
    }

    // "Due east" is two steps in a flat-top grid, but not along one direction.
    const bent = neighbors(neighbors(from)[0]!).find(
      (h) => distance(from, h) === 2 && straightLineBetween(from, h, 2) === null,
    );
    expect(bent).toBeDefined();
  });

  it('round-trips offset and axial coordinates', () => {
    for (const id of FULL_BOARD_HEXES) {
      const h = fromId(id);
      expect(toId(h)).toBe(id);
    }
  });
});
