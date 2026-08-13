import { describe, expect, it } from 'vitest';

import {
  DUEL_BOARD,
  DUEL_BOARD_HEXES,
  DUEL_LOCATIONS,
  DUEL_LOCATIONS_BY_SIDE,
  FULL_BOARD_HEXES,
  FULL_BOARD_LOCATIONS,
  FORTIFICATION_LAYOUTS,
  STARTING_LOCATIONS,
  TEAM_BOARD,
  rotate180,
} from './board.js';
import { fromId, pixelCenter, toId } from './hex.js';

/**
 * The geometry itself is `wc-core`'s and is tested there: it is a rule, and this
 * package has not held a copy of it since the engine moved. What is tested here
 * is the table that reaches the browser — that it has the shape the client draws
 * from, and that it still describes the same printed board.
 */
describe('the generated board', () => {
  it('is the printed hexagon: 47 hexes, 37 of them in a duel', () => {
    expect(FULL_BOARD_HEXES).toHaveLength(47);
    expect(DUEL_BOARD_HEXES).toHaveLength(37);
    expect(new Set(FULL_BOARD_HEXES).size).toBe(47);
    // The duel board is the inner part of the same board, not another one.
    for (const hex of DUEL_BOARD_HEXES) expect(FULL_BOARD_HEXES).toContain(hex);
  });

  it('carries 14 locations, 10 of them reachable in a duel', () => {
    expect(FULL_BOARD_LOCATIONS).toHaveLength(14);
    expect(DUEL_LOCATIONS).toHaveLength(10);
    for (const loc of FULL_BOARD_LOCATIONS) expect(FULL_BOARD_HEXES).toContain(loc);
    expect(DUEL_BOARD.controlMarkers).toBe(6);
    expect(TEAM_BOARD.controlMarkers).toBe(8);
  });

  it('starts each side on two crested locations, facing across the short axis', () => {
    expect(STARTING_LOCATIONS.a).toHaveLength(2);
    expect(STARTING_LOCATIONS.b).toHaveLength(2);
    for (const loc of [...STARTING_LOCATIONS.a, ...STARTING_LOCATIONS.b]) {
      expect(DUEL_LOCATIONS).toContain(loc);
    }
    // Read off the set-up diagram on page 4 of the rulebook: the dark markers
    // sit on the top edge and the light ones on the bottom.
    for (const loc of STARTING_LOCATIONS.a) {
      expect(STARTING_LOCATIONS.b).toContain(rotate180(loc));
    }
  });

  it('is symmetric under a half turn', () => {
    for (const hex of FULL_BOARD_HEXES) {
      expect(FULL_BOARD_HEXES).toContain(rotate180(hex));
      expect(rotate180(rotate180(hex))).toBe(hex);
    }
    for (const loc of FULL_BOARD_LOCATIONS) {
      expect(FULL_BOARD_LOCATIONS).toContain(rotate180(loc));
    }
  });

  it('splits the duel locations five and five, each side mirroring the other', () => {
    const [near, far] = DUEL_LOCATIONS_BY_SIDE;
    expect(near).toHaveLength(5);
    expect(far).toHaveLength(5);
    for (const loc of near) expect(far).toContain(rotate180(loc));
  });

  it('has ten Fortification Map Cards, each two locations mirrored', () => {
    expect(FORTIFICATION_LAYOUTS).toHaveLength(10);
    for (const layout of FORTIFICATION_LAYOUTS) {
      expect(layout).toHaveLength(4);
      const [first, second, third, fourth] = layout as [string, string, string, string];
      expect(third).toBe(rotate180(first));
      expect(fourth).toBe(rotate180(second));
      for (const hex of layout) expect(DUEL_LOCATIONS).toContain(hex);
    }
  });
});

describe('screen positions', () => {
  it('gives every board hex a centre, and scales with the radius', () => {
    for (const id of FULL_BOARD_HEXES) {
      const one = pixelCenter(fromId(id), 1);
      const ten = pixelCenter(fromId(id), 10);
      expect(Number.isFinite(one.x)).toBe(true);
      expect(ten.x).toBeCloseTo(one.x * 10, 6);
      expect(ten.y).toBeCloseTo(one.y * 10, 6);
    }
  });

  it('lays odd columns half a hex lower, as the board is printed', () => {
    const even = pixelCenter({ col: 4, row: 0 }, 1);
    const odd = pixelCenter({ col: 5, row: 0 }, 1);
    expect(odd.y - even.y).toBeCloseTo(Math.sqrt(3) / 2, 6);
    expect(odd.x).toBeGreaterThan(even.x);
  });

  it('reads a hex id back as the hex it names', () => {
    for (const id of FULL_BOARD_HEXES) expect(toId(fromId(id))).toBe(id);
  });
});
