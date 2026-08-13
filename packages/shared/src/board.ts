/**
 * The War Chest board, reconstructed from the official AEG rulebook art
 * (`design/rules/WarChest_Rulebook.pdf`, page 4) — see `docs/RULES.md`.
 *
 * The printed board is a hexagon of 47 hexes. In cube coordinates centred on the
 * middle hex it is exactly `|x| <= 5, |y| <= 3, |z| <= 3`: a regular radius-3
 * hexagon (37 hexes) stretched by two extra columns on each side. Those outer
 * columns — 10 hexes, drawn darker on the board — are used only in the
 * four-player game, so the two-player board is precisely the radius-3 hexagon.
 *
 * 14 hexes are *locations* (green knotwork). Six of them carry a faction crest
 * and are the starting locations; the other eight start neutral.
 */

import { fromId, toId, type Hex, type HexId, hexId, toAxial } from './hex.js';

export type BoardSize = 2 | 4;

/** Cube coordinates relative to the centre hex, which is offset `(5, 2)`. */
interface Cube {
  x: number;
  y: number;
  z: number;
}

const CENTER_COL = 5;

function toCube(h: Hex): Cube {
  const a = toAxial(h);
  const x = a.q - CENTER_COL;
  const z = a.s;
  return { x, y: -x - z, z };
}

function inHexagon(h: Hex, halfWidth: number): boolean {
  const c = toCube(h);
  return Math.abs(c.x) <= halfWidth && Math.abs(c.y) <= 3 && Math.abs(c.z) <= 3;
}

function buildHexes(halfWidth: number): HexId[] {
  const out: HexId[] = [];
  // Generous scan window; `inHexagon` does the real filtering.
  for (let col = CENTER_COL - halfWidth; col <= CENTER_COL + halfWidth; col++) {
    for (let row = -4; row <= 9; row++) {
      if (inHexagon({ col, row }, halfWidth)) out.push(hexId(col, row));
    }
  }
  return out;
}

/** All 47 hexes of the printed board. */
export const FULL_BOARD_HEXES: readonly HexId[] = buildHexes(5);

/** The 37 hexes used in a two-player game (the inner, lighter hexagon). */
export const DUEL_BOARD_HEXES: readonly HexId[] = buildHexes(3);

/** All 14 locations on the printed board. */
export const FULL_BOARD_LOCATIONS: readonly HexId[] = [
  '0,3',
  '1,1',
  '2,3',
  '3,1',
  '3,4',
  '4,0',
  '4,3',
  '6,2',
  '6,5',
  '7,0',
  '7,3',
  '8,2',
  '9,3',
  '10,2',
];

/** The 10 locations reachable in a two-player game. */
export const DUEL_LOCATIONS: readonly HexId[] = FULL_BOARD_LOCATIONS.filter((id) =>
  DUEL_BOARD_HEXES.includes(id),
);

/**
 * The six locations printed with a faction crest.
 *
 * In a two-player game each side starts controlling the two inner crests on its
 * half of the board; the outer pair (`1,1` / `9,3`) sits in the four-player-only
 * columns and is unused.
 *
 * Read off the set-up diagram on page 4 of the rulebook, where the two dark
 * markers sit on the board's top edge and the two light ones on its bottom
 * edge: the sides face each other across the short axis, not the long one.
 */
export const STARTING_LOCATIONS: { readonly a: readonly HexId[]; readonly b: readonly HexId[] } = {
  a: ['4,0', '7,0'],
  b: ['3,4', '6,5'],
};

/** The four-player-only crest each team adds to its starting locations. */
export const TEAM_OUTER_STARTING_LOCATION: { readonly a: HexId; readonly b: HexId } = {
  a: '1,1',
  b: '9,3',
};

/**
 * A number for every hex on the printed board, the big one included.
 *
 * One index over `FULL_BOARD_HEXES` rather than one per board size, so a number
 * means the same hex whichever game is being played. Search uses it to name a
 * move without building a string; `board-sense.ts` keeps its own index because
 * it wants the hexes of *this* board packed from zero, which is a different
 * question.
 */
export const HEX_INDEX: ReadonlyMap<HexId, number> = new Map(
  FULL_BOARD_HEXES.map((id, i) => [id, i]),
);

/** One past the last hex index: the value that means "no hex here". */
export const HEX_SLOTS = FULL_BOARD_HEXES.length + 1;

export interface BoardDefinition {
  readonly hexes: readonly HexId[];
  readonly locations: readonly HexId[];
  /** Locations each seat starts the game controlling. */
  readonly startingLocations: readonly (readonly HexId[])[];
  /** Control markers a side must place to win. */
  readonly controlMarkers: number;
}

export const DUEL_BOARD: BoardDefinition = {
  hexes: DUEL_BOARD_HEXES,
  locations: DUEL_LOCATIONS,
  startingLocations: [STARTING_LOCATIONS.a, STARTING_LOCATIONS.b],
  controlMarkers: 6,
};

export const TEAM_BOARD: BoardDefinition = {
  hexes: FULL_BOARD_HEXES,
  locations: FULL_BOARD_LOCATIONS,
  startingLocations: [
    [...STARTING_LOCATIONS.a, TEAM_OUTER_STARTING_LOCATION.a],
    [...STARTING_LOCATIONS.b, TEAM_OUTER_STARTING_LOCATION.b],
  ],
  controlMarkers: 8,
};

/** The half-turn that maps one side of the board onto the other. */
export function rotate180(id: HexId): HexId {
  const a = toAxial(fromId(id));
  const q = 2 * CENTER_COL - a.q;
  const s = -a.s;
  return toId({ col: q, row: s + (q - (q & 1)) / 2 });
}

/**
 * Where a hex sits along the axis the two players face each other across,
 * measured in rows. Odd columns hang half a row lower, exactly as they are
 * printed.
 */
function verticalPosition(h: Hex): number {
  return h.row + (h.col & 1 ? 0.5 : 0);
}

/** The middle of the board on that axis: the centre hex's own position. */
const CENTER_ROW = verticalPosition({ col: CENTER_COL, row: 2 });

/**
 * The five duel locations nearest each side — side `a` the top half of the
 * board, side `b` the bottom — which is the way the players face each other.
 * The two halves are exact mirrors of one another.
 */
export const DUEL_LOCATIONS_BY_SIDE: readonly [readonly HexId[], readonly HexId[]] = (() => {
  const a: HexId[] = [];
  const b: HexId[] = [];
  for (const loc of DUEL_LOCATIONS) (verticalPosition(fromId(loc)) < CENTER_ROW ? a : b).push(loc);
  return [a, b];
})();

/**
 * Every Fortification Map Card. Each places two Fortifications among a side's
 * five nearest locations and mirrors them for the opponent, so there are
 * C(5,2) = 10 possible cards; the printed expansion ships six of them.
 */
export const FORTIFICATION_LAYOUTS: readonly (readonly HexId[])[] = (() => {
  const mine = DUEL_LOCATIONS_BY_SIDE[0];
  const out: HexId[][] = [];
  for (let i = 0; i < mine.length; i++) {
    for (let j = i + 1; j < mine.length; j++) {
      const first = mine[i]!;
      const second = mine[j]!;
      out.push([first, second, rotate180(first), rotate180(second)]);
    }
  }
  return out;
})();

/** Fortification coins in the box: four go on the board, three to the supply. */
export const FORTIFICATIONS_TOTAL = 7;
export const FORTIFICATIONS_ON_BOARD = 4;

export function boardFor(size: BoardSize): BoardDefinition {
  return size === 2 ? DUEL_BOARD : TEAM_BOARD;
}
