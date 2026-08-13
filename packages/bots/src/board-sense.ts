/**
 * How the heuristic reads a board: distances, what each location counts as, and
 * the shape of a priority list.
 *
 * The two primitives come from the fan-made solo flowchart (Seth McBride, BGG
 * user Dreadpirate404), which is the one written-down source of War Chest
 * heuristics. Its setup and turn structure are a different game and are not
 * used; these two definitions are game-agnostic and are:
 *
 * **Closest** — "the hex/location/enemy unit that is the least number of hexes
 * away, counting around any occupied spaces". So not hex distance: a path that
 * walks around whatever is in the way. A unit standing on a hex still counts as
 * a destination, it just cannot be walked through.
 *
 * **Order of priorities** — "a numerical list of criteria. If the first
 * criterion applies to one and only one candidate, use it. Otherwise move to
 * the second criterion, using only those candidates that applied to the first,
 * and so on." A filter cascade, not a score.
 */

import {
  boardFor,
  distance,
  fromId,
  neighbors,
  toId,
  type BoardSize,
  type GameView,
  type HexId,
  type Team,
} from '@wc/shared';

export const UNREACHABLE = Infinity;

/**
 * A distance field. A `Map` in everything the callers do with it, but backed by
 * a typed array, because this is where the search spends its time: half of it,
 * measured, in the sweeps below.
 */
export interface Steps {
  get(hex: HexId): number | undefined;
}

/**
 * The board as numbers, worked out once per size.
 *
 * The sweep used to walk on hex ids: parse the string, build six neighbour
 * objects, stringify each one back, look it up in a freshly built set of the 47
 * board hexes — per hex, per sweep, thousands of sweeps a second. None of that
 * depends on the position, so none of it belongs in the loop.
 */
interface Geometry {
  readonly ids: readonly HexId[];
  readonly index: ReadonlyMap<HexId, number>;
  /** Six slots per hex, `-1` where the neighbour is off the board. */
  readonly links: Int16Array;
}

const GEOMETRIES = new Map<BoardSize, Geometry>();

function geometryFor(size: BoardSize): Geometry {
  const cached = GEOMETRIES.get(size);
  if (cached) return cached;

  const ids = boardFor(size).hexes;
  const index = new Map<HexId, number>(ids.map((id, i) => [id, i]));
  const links = new Int16Array(ids.length * 6).fill(-1);
  ids.forEach((id, i) => {
    neighbors(fromId(id)).forEach((n, k) => {
      links[i * 6 + k] = index.get(toId(n)) ?? -1;
    });
  });

  const geometry: Geometry = { ids, index, links };
  GEOMETRIES.set(size, geometry);
  return geometry;
}

/**
 * Steps from any of `sources` to every hex on the board, walking around
 * occupied hexes. An occupied hex gets a distance — you can reach it, you just
 * cannot pass through it — but nothing is expanded beyond it.
 *
 * Several sources at once because the priority lists ask the question the other
 * way round: not "how far is this hex from that one" but "which of these
 * candidates is closest to any location of that kind". One sweep out from the
 * locations answers it for every candidate, instead of one sweep per candidate.
 *
 * That the two agree needs an argument, since a sweep from many sources may
 * leave one occupied source and cross to another. Both ends of a walk are
 * allowed to be occupied and only the hexes between must be clear, so the sweep
 * and a walk measured from the candidate use the same edges. And a route that
 * passes *through* one source on the way to a second cannot beat the answer:
 * it is at least as long as the route to the source it passed through, which is
 * already in the minimum.
 */
export function stepsFromAny(view: Occupancy, sources: Iterable<HexId>, board?: Occupied): Steps {
  const geo = geometryFor(view.size);
  const dist = new Int16Array(geo.ids.length).fill(-1);

  // Who stands where. The sweep marks its own sources as passable, so it needs
  // a copy it may write to — but building the map costs a walk over the board
  // and a hash lookup per stack, and one decision asks for five to ten sweeps
  // of the same position. Copying 37 bytes is the cheaper half of that by far,
  // so a caller that is about to sweep repeatedly builds it once.
  const occupied = board ? board.slice() : occupiedIn(view).slice();

  let frontier: number[] = [];
  for (const source of sources) {
    const i = geo.index.get(source);
    if (i === undefined || dist[i] !== -1) continue;
    dist[i] = 0;
    frontier.push(i);
    // A walk may start on an occupied hex — its own — and may end on one, but
    // may not pass through one. Seeds are the exception to the block below.
    occupied[i] = 0;
  }

  while (frontier.length > 0) {
    const next: number[] = [];
    for (const hex of frontier) {
      // Whatever stands here blocks the way through it.
      if (occupied[hex]) continue;
      const d = (dist[hex] as number) + 1;
      const base = hex * 6;
      for (let k = 0; k < 6; k++) {
        const n = geo.links[base + k] as number;
        if (n < 0 || dist[n] !== -1) continue;
        dist[n] = d;
        next.push(n);
      }
    }
    frontier = next;
  }

  return {
    get(hex: HexId): number | undefined {
      const i = geo.index.get(hex);
      if (i === undefined) return undefined;
      const d = dist[i] as number;
      return d === -1 ? undefined : d;
    },
  };
}

/**
 * The least a sweep needs to know: the board and who is standing on it.
 *
 * A `GameView` satisfies this, and so does a `GameState` — which is what lets
 * the evaluation ask for a walking distance without being handed a view it has
 * no other use for.
 */
export interface Occupancy {
  readonly size: BoardSize;
  readonly units: Readonly<Record<string, unknown>>;
}

/**
 * Who is standing on each hex, by index. Shared between the sweeps of one
 * decision; `stepsFromAny` copies it before writing.
 */
export type Occupied = Uint8Array;

export function occupiedIn(view: Occupancy): Occupied {
  const geo = geometryFor(view.size);
  const occupied = new Uint8Array(geo.ids.length);
  // `for…in` rather than `Object.keys`: the keys are wanted one at a time and
  // the array they would arrive in is thrown away.
  for (const hex in view.units) {
    const i = geo.index.get(hex as HexId);
    if (i !== undefined) occupied[i] = 1;
  }
  return occupied;
}

/** Steps from one hex — the walker's own — around whatever is in the way. */
export function stepsFrom(view: Occupancy, from: HexId): Steps {
  return stepsFromAny(view, [from]);
}

/** Least steps from `from` to any hex in `targets`; `Infinity` if none is reachable. */
export function stepsTo(view: Occupancy, from: HexId, targets: Iterable<HexId>): number {
  const dist = stepsFrom(view, from);
  let best = UNREACHABLE;
  for (const target of targets) {
    const d = dist.get(target);
    if (d !== undefined && d < best) best = d;
  }
  return best;
}

// ---------------------------------------------------------------------------
// How the chart classifies the board
// ---------------------------------------------------------------------------

export interface BoardSense {
  readonly me: Team;
  /** Locations under my control. */
  readonly friendly: readonly HexId[];
  /** Locations under the opponent's control. */
  readonly enemy: readonly HexId[];
  /** Locations nobody controls. */
  readonly neutral: readonly HexId[];
  /** Locations with an enemy unit standing on them. */
  readonly enemyOccupied: readonly HexId[];
  readonly enemyUnits: readonly HexId[];
  readonly myUnits: readonly HexId[];
  readonly centre: HexId;
}

export function senseFor(view: GameView): BoardSense {
  const board = boardFor(view.size);
  const me = view.players[view.you]?.team ?? 0;

  const friendly: HexId[] = [];
  const enemy: HexId[] = [];
  const neutral: HexId[] = [];
  for (const loc of board.locations) {
    const owner = view.control[loc];
    if (owner === undefined) neutral.push(loc);
    else if (owner === me) friendly.push(loc);
    else enemy.push(loc);
  }

  const enemyUnits: HexId[] = [];
  const myUnits: HexId[] = [];
  for (const hex in view.units) {
    const stack = view.units[hex as HexId];
    if (stack) (stack.team === me ? myUnits : enemyUnits).push(hex as HexId);
  }

  return {
    me,
    friendly,
    enemy,
    neutral,
    enemyOccupied: [...enemy, ...neutral, ...friendly].filter((loc) => {
      const stack = view.units[loc];
      return stack !== undefined && stack.team !== me;
    }),
    enemyUnits,
    myUnits,
    centre: centreOf(view),
  };
}

const CENTRES = new Map<number, HexId>();

/**
 * The chart's last tie-breaker is "closest to the center hex". The board has no
 * printed centre, so it is taken as the hex whose greatest distance to any
 * other board hex is smallest — the middle of the map by plain geometry.
 */
export function centreOf(view: GameView): HexId {
  const cached = CENTRES.get(view.size);
  if (cached !== undefined) return cached;

  const hexes = boardFor(view.size).hexes;
  let best = hexes[0] as HexId;
  let bestScore = Infinity;
  for (const hex of hexes) {
    const a = fromId(hex);
    let worst = 0;
    let total = 0;
    for (const other of hexes) {
      const d = distance(a, fromId(other));
      total += d;
      if (d > worst) worst = d;
    }
    const score = worst * 1000 + total;
    if (score < bestScore) {
      bestScore = score;
      best = hex;
    }
  }
  CENTRES.set(view.size, best);
  return best;
}

// ---------------------------------------------------------------------------
// The cascade
// ---------------------------------------------------------------------------

/**
 * One line of an "order of priorities" list: it either keeps the candidates
 * that satisfy it, or — for a "closest to …" line — the ones that tie for the
 * smallest distance.
 */
export type Criterion<T> = (candidates: readonly T[]) => readonly T[];

/**
 * Walks the list top to bottom. A criterion that narrows the field to exactly
 * one candidate ends it; a criterion nothing satisfies is skipped, since the
 * chart says to carry on "using only those that applied" and none did.
 */
export function byPriority<T>(candidates: readonly T[], criteria: readonly Criterion<T>[]): readonly T[] {
  let left = candidates;
  if (left.length <= 1) return left;
  for (const criterion of criteria) {
    const kept = criterion(left);
    if (kept.length === 0) continue;
    left = kept;
    if (left.length === 1) return left;
  }
  return left;
}

/** Keeps the candidates that tie for the smallest value. */
export function smallest<T>(candidates: readonly T[], value: (item: T) => number): readonly T[] {
  let best = Infinity;
  for (const item of candidates) {
    const v = value(item);
    if (v < best) best = v;
  }
  if (!Number.isFinite(best)) return [];
  return candidates.filter((item) => value(item) === best);
}

/** Keeps the candidates that tie for the largest value. */
export function largest<T>(candidates: readonly T[], value: (item: T) => number): readonly T[] {
  let best = -Infinity;
  for (const item of candidates) {
    const v = value(item);
    if (v > best) best = v;
  }
  if (!Number.isFinite(best)) return [];
  return candidates.filter((item) => value(item) === best);
}
