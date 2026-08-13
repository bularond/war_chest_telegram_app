/**
 * The printed board.
 *
 * Everything here comes out of `generated.ts`, which comes out of `wc-core`.
 * The reconstruction — a hexagon of 47 hexes, the 14 locations, the six crested
 * starting locations, the Fortification Map Cards — is documented and tested
 * there; this file only gives it the names the rest of the TypeScript uses.
 */

import type { HexId } from './hex.js';
import {
  DUEL_BOARD as DUEL_FACTS,
  TEAM_BOARD as TEAM_FACTS,
  FORTIFICATIONS_ON_BOARD,
  FORTIFICATIONS_TOTAL,
  FORTIFICATION_LAYOUTS,
  DUEL_LOCATIONS_BY_SIDE,
  rotate180,
} from './generated.js';

export type BoardSize = 2 | 4;

/** All 47 hexes of the printed board. */
export const FULL_BOARD_HEXES: readonly HexId[] = TEAM_FACTS.hexes;
/** The 37 hexes used in a two-player game (the inner, lighter hexagon). */
export const DUEL_BOARD_HEXES: readonly HexId[] = DUEL_FACTS.hexes;

/** All 14 locations on the printed board. */
export const FULL_BOARD_LOCATIONS: readonly HexId[] = TEAM_FACTS.locations;
/** The 10 locations reachable in a two-player game. */
export const DUEL_LOCATIONS: readonly HexId[] = DUEL_FACTS.locations;

/**
 * The locations printed with a faction crest that a duel uses: each side starts
 * controlling the two inner crests on its half of the board.
 */
export const STARTING_LOCATIONS: { readonly a: readonly HexId[]; readonly b: readonly HexId[] } = {
  a: DUEL_FACTS.startingLocations[0] as readonly HexId[],
  b: DUEL_FACTS.startingLocations[1] as readonly HexId[],
};

/** The four-player-only crest each team adds to its starting locations. */
export const TEAM_OUTER_STARTING_LOCATION: { readonly a: HexId; readonly b: HexId } = {
  a: TEAM_FACTS.startingLocations[0]!.at(-1) as HexId,
  b: TEAM_FACTS.startingLocations[1]!.at(-1) as HexId,
};

export interface BoardDefinition {
  readonly hexes: readonly HexId[];
  readonly locations: readonly HexId[];
  readonly startingLocations: readonly (readonly HexId[])[];
  readonly controlMarkers: number;
}

export const DUEL_BOARD: BoardDefinition = DUEL_FACTS;
export const TEAM_BOARD: BoardDefinition = TEAM_FACTS;

export function boardFor(size: BoardSize): BoardDefinition {
  return size === 2 ? DUEL_BOARD : TEAM_BOARD;
}

/**
 * A number for every hex on the printed board, the big one included. One index
 * over `FULL_BOARD_HEXES` rather than one per board size, so a number means the
 * same hex whichever game is being played.
 */
export const HEX_INDEX: ReadonlyMap<HexId, number> = new Map(
  FULL_BOARD_HEXES.map((id, i) => [id, i]),
);

/** One past the last hex index: the value that means "no hex here". */
export const HEX_SLOTS = FULL_BOARD_HEXES.length + 1;

export {
  DUEL_LOCATIONS_BY_SIDE,
  FORTIFICATIONS_ON_BOARD,
  FORTIFICATIONS_TOTAL,
  FORTIFICATION_LAYOUTS,
  rotate180,
};
