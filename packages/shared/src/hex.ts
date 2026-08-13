/**
 * Hexes, as far as a screen is concerned.
 *
 * The geometry itself — who is adjacent, how far is that, what counts as a
 * straight line — is a rule, and rules live in `wc-core`. What is left here is
 * the two things drawing a board needs and no rule reads: the printed name of a
 * hex, and where it sits on screen.
 *
 * The layout is flat-top hexes in columns with the odd columns pushed down half
 * a hex — "odd-q" — which is what the printed board looks like. The centres are
 * generated rather than derived, so this file cannot drift from the board the
 * engine is playing on.
 */

import { HEX_CENTRES } from './generated.js';

export interface Hex {
  readonly col: number;
  readonly row: number;
}

/** Stable string key for a hex, e.g. `"4,3"`. */
export type HexId = string;

export function hexId(col: number, row: number): HexId {
  return `${col},${row}`;
}

export function toId(h: Hex): HexId {
  return hexId(h.col, h.row);
}

export function fromId(id: HexId): Hex {
  const i = id.indexOf(',');
  return { col: Number(id.slice(0, i)), row: Number(id.slice(i + 1)) };
}

/** Screen position of a hex centre, for a flat-top hex of the given radius. */
export function pixelCenter(h: Hex, radius: number): { x: number; y: number } {
  const centre = HEX_CENTRES[toId(h)];
  if (centre) return { x: centre.x * radius, y: centre.y * radius };
  // Off the printed board — a highlight overhanging the edge, say. The same
  // formula the table was generated from, so the two agree by construction.
  const w = Math.sqrt(3) * radius;
  return { x: 1.5 * radius * h.col, y: w * h.row + (h.col & 1 ? w / 2 : 0) };
}
