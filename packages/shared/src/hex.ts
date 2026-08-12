/**
 * Hex geometry for the War Chest board.
 *
 * The physical board uses flat-top hexes laid out in columns, where odd columns
 * are pushed DOWN by half a hex. That is the "odd-q" offset layout.
 *
 * Public coordinates are offset `(col, row)` because that is what the printed
 * board looks like; everything geometric (distance, straight lines) converts to
 * axial coordinates first, where the maths is trivial.
 */

export interface Hex {
  readonly col: number;
  readonly row: number;
}

/** Stable string key for a hex, e.g. `"4,3"`. Used as an object/Map key. */
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

/** Axial coordinates (q = column, s = "diagonal row"). */
export interface Axial {
  readonly q: number;
  readonly s: number;
}

export function toAxial(h: Hex): Axial {
  return { q: h.col, s: h.row - (h.col - (h.col & 1)) / 2 };
}

export function fromAxial(a: Axial): Hex {
  return { col: a.q, row: a.s + (a.q - (a.q & 1)) / 2 };
}

/**
 * The six axial directions, in clockwise order starting from "east".
 * Index is stable: `DIRECTIONS[i]` and `DIRECTIONS[(i + 3) % 6]` are opposites.
 */
export const DIRECTIONS: readonly Axial[] = [
  { q: 1, s: 0 },
  { q: 1, s: -1 },
  { q: 0, s: -1 },
  { q: -1, s: 0 },
  { q: -1, s: 1 },
  { q: 0, s: 1 },
];

export function step(h: Hex, dir: Axial, times = 1): Hex {
  const a = toAxial(h);
  return fromAxial({ q: a.q + dir.q * times, s: a.s + dir.s * times });
}

export function neighbors(h: Hex): Hex[] {
  return DIRECTIONS.map((d) => step(h, d));
}

export function distance(a: Hex, b: Hex): number {
  const x = toAxial(a);
  const y = toAxial(b);
  const dq = x.q - y.q;
  const ds = x.s - y.s;
  return (Math.abs(dq) + Math.abs(dq + ds) + Math.abs(ds)) / 2;
}

export function equals(a: Hex, b: Hex): boolean {
  return a.col === b.col && a.row === b.row;
}

/**
 * If `to` is exactly `n` steps from `from` along one of the six straight
 * directions, returns the hexes strictly between them; otherwise `null`.
 *
 * Used by the Crossbowman ("in a straight line, no intervening units") and the
 * Lancer ("move two spaces in a straight line, then attack").
 */
export function straightLineBetween(from: Hex, to: Hex, n: number): Hex[] | null {
  for (const dir of DIRECTIONS) {
    if (equals(step(from, dir, n), to)) {
      const between: Hex[] = [];
      for (let i = 1; i < n; i++) between.push(step(from, dir, i));
      return between;
    }
  }
  return null;
}

/** Screen position of a hex centre, for a flat-top hex of the given radius. */
export function pixelCenter(h: Hex, radius: number): { x: number; y: number } {
  const w = Math.sqrt(3) * radius;
  return {
    x: 1.5 * radius * h.col,
    y: w * h.row + (h.col & 1 ? w / 2 : 0),
  };
}
