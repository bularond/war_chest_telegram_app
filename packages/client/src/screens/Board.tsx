/** The hex board, drawn from the real War Chest layout. */

import {
  boardFor,
  fromId,
  pixelCenter,
  type GameView,
  type HexId,
} from '@wc/shared';
import { useMemo } from 'react';
import { CrestImage, factionForSeat, factionForTeam, type Faction } from '../ui/Crest.js';

const R = 34; // hex radius in SVG units
const PAD = 8;
/** Poison reads as its own thing on a board of browns and greens. */
const POISON = '#63417f';

/**
 * Who holds a location is drawn in the printed marker's own colours — the dark
 * slate disc and the ivory one, sampled off the art. The "you/foe" green and
 * orange of the unit rims would have said the same thing, but a green ring
 * around the black player's board is a colour the game does not have.
 */
const CONTROL: Record<Faction, { main: string; edge: string }> = {
  black: { main: '#203941', edge: '#0d181c' },
  white: { main: '#f7eed8', edge: '#9c8047' },
};
/** A flat-top hex is 2R wide and √3·R tall — the tiles are drawn to that ratio. */
const TILE_W = R * 2;
const TILE_H = Math.sqrt(3) * R;

function hexPoints(cx: number, cy: number, r: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 180) * (60 * i);
    pts.push(`${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`);
  }
  return pts.join(' ');
}

/**
 * The printed tile for a hex. A claimed location already carries its side's
 * control marker, exactly like the board with a marker sitting on it.
 */
function tileFor(isLocation: boolean, controlledBy: number | undefined): string {
  if (controlledBy !== undefined) {
    return controlledBy === 0 ? '/board/hex_black.svg' : '/board/hex_white.svg';
  }
  return isLocation ? '/board/hex_neutral.svg' : '/board/hex_empty.svg';
}

export interface BoardProps {
  view: GameView;
  /** Hexes the player may tap right now. */
  highlight: ReadonlySet<HexId>;
  /** Hexes already chosen in a multi-step action. */
  chosen?: ReadonlySet<HexId>;
  /** Hexes to ring for attention, e.g. the two ends of an incoming attack. */
  focus?: ReadonlySet<HexId>;
  /** Where the opponent's last turn happened. */
  lastMove?: ReadonlySet<HexId>;
  onPick(hex: HexId): void;
}

export function Board({ view, highlight, chosen, focus, lastMove, onPick }: BoardProps) {
  const board = boardFor(view.size);
  const youTeam = view.players[view.you]?.team ?? 0;

  /*
   * The two sides face each other across the board's short axis, team 0 along
   * the top edge. Everyone should be looking at their own half from the same
   * side of the table, so the top player's view is turned half a circle — a
   * hex grid maps exactly onto itself under that turn, so only the pixel
   * coordinates change.
   */
  const geometry = useMemo(() => {
    const raw = board.hexes.map((id) => ({ id, ...pixelCenter(fromId(id), R) }));
    const midX = (Math.min(...raw.map((c) => c.x)) + Math.max(...raw.map((c) => c.x))) / 2;
    const midY = (Math.min(...raw.map((c) => c.y)) + Math.max(...raw.map((c) => c.y))) / 2;
    const flip = youTeam === 0;
    const cells = raw.map((c) => (flip ? { id: c.id, x: 2 * midX - c.x, y: 2 * midY - c.y } : c));

    const xs = cells.map((c) => c.x);
    const ys = cells.map((c) => c.y);
    const minX = Math.min(...xs) - R - PAD;
    const minY = Math.min(...ys) - R - PAD;
    const width = Math.max(...xs) + R + PAD - minX;
    const height = Math.max(...ys) + R + PAD - minY;
    return { cells, viewBox: `${minX} ${minY} ${width} ${height}` };
  }, [board, youTeam]);

  const teamColor = (team: number) => (team === youTeam ? 'var(--side-you)' : 'var(--side-foe)');

  return (
    <svg
      viewBox={geometry.viewBox}
      style={{ width: '100%', height: '100%', maxHeight: '100%', display: 'block' }}
      role="img"
      aria-label="Поле"
    >
      {/* The board itself: printed tiles, no pointer events. */}
      {geometry.cells.map(({ id, x, y }) => {
        const isLocation = board.locations.includes(id);
        return (
          <image
            key={`t-${id}`}
            className="hex-decor"
            href={tileFor(isLocation, view.control[id])}
            x={x - TILE_W / 2}
            y={y - TILE_H / 2}
            width={TILE_W}
            height={TILE_H}
          />
        );
      })}

      {/* A transparent hex over each tile: the tap target and the highlight. */}
      {geometry.cells.map(({ id, x, y }) => {
        const hot = highlight.has(id);
        const picked = chosen?.has(id);
        return (
          <polygon
            key={`h-${id}`}
            data-hex={id}
            className={hot ? 'hex hex--legal' : 'hex'}
            points={hexPoints(x, y, R - 1.5)}
            fill={picked ? 'var(--color-accent-500)' : hot ? 'var(--color-accent-400)' : 'transparent'}
            fillOpacity={picked ? 0.75 : hot ? 0.6 : 0}
            stroke={hot || picked ? 'var(--color-accent-800)' : 'transparent'}
            strokeWidth={hot || picked ? 2.5 : 0}
            style={{ pointerEvents: hot ? 'all' : 'none' }}
            onClick={hot ? () => onPick(id) : undefined}
          />
        );
      })}

      {/*
        Where the opponent just played. Drawn under the coins and breathing
        slowly: it is there to be found when you look up, not to compete with
        the hexes you can actually tap.
      */}
      {geometry.cells.map(({ id, x, y }) =>
        lastMove?.has(id) ? (
          <polygon
            key={`m-${id}`}
            className="hex-decor hex-last"
            points={hexPoints(x, y, R - 4)}
            fill="var(--side-foe)"
            fillOpacity={0.18}
            stroke="var(--side-foe)"
            strokeWidth={3}
          />
        ) : null,
      )}

      {/* Whatever the current question is about, ringed so it can be found. */}
      {geometry.cells.map(({ id, x, y }) =>
        focus?.has(id) ? (
          <polygon
            key={`z-${id}`}
            className="hex-decor hex-focus"
            points={hexPoints(x, y, R - 1.5)}
            fill="none"
            stroke="var(--color-accent-700)"
            strokeWidth={3}
            strokeDasharray="7 5"
          />
        ) : null,
      )}

      {geometry.cells.map(({ id, x, y }) => {
        const stack = view.units[id];
        if (!stack) return null;
        const rim = teamColor(stack.team);
        const size = R * 1.32;
        return (
          // `hex-decor` makes taps fall through to the hex underneath —
          // otherwise you could never tap an enemy unit to attack it.
          <g
            key={`u-${id}`}
            data-unit={id}
            className="hex-decor"
            style={{ animation: 'wc-pop 200ms ease both' }}
          >
            {/* A bolstered unit shows its extra coins as an offset stack. */}
            {Array.from({ length: Math.min(stack.coins, 4) - 1 }).map((_, i) => (
              <circle
                key={i}
                cx={x + (i + 1) * 2.5}
                cy={y - (i + 1) * 2.5}
                r={size / 2}
                fill={rim}
                opacity={0.5}
              />
            ))}
            {/* A ring in the side's colour: the printed coins are identical for
                both players, so only the board needs to say whose this is. */}
            <circle cx={x} cy={y} r={size / 2 + 1.5} fill={rim} />
            <CrestImage
              unit={stack.unit}
              size={size}
              x={x}
              y={y}
              faction={factionForSeat(stack.seat)}
            />
          </g>
        );
      })}

      {/*
        Who holds a location, drawn over the units so a coin standing on it
        cannot hide it: the printed marker under the coin is invisible exactly
        where it matters most. The rim is clear of the coin, so it always shows.
      */}
      {geometry.cells.map(({ id, x, y }) => {
        const team = view.control[id];
        if (team === undefined) return null;
        const ink = CONTROL[factionForTeam(team)];
        const mine = team === youTeam;
        return (
          <g key={`c-${id}`} data-control={id} className="hex-decor">
            <title>{mine ? 'Ваша локация' : 'Локация соперника'}</title>
            {/* Two strokes: the disc's own colour, kept legible on both the
                pale tiles and the dark ones by the rim it is printed with. */}
            <polygon
              points={hexPoints(x, y, R - 2)}
              fill="none"
              stroke={ink.edge}
              strokeWidth={6}
              strokeLinejoin="round"
              opacity={0.85}
            />
            <polygon
              className="hex-control"
              points={hexPoints(x, y, R - 2)}
              fill="none"
              stroke={ink.main}
              strokeWidth={3.5}
              strokeLinejoin="round"
            />
          </g>
        );
      })}

      {/* Walls over the garrison and over the control rim, not behind either. */}
      {geometry.cells.map(({ id, x, y }) =>
        view.forts[id] ? <Fortification key={`f-${id}`} x={x} y={y} r={R} /> : null,
      )}

      {/*
        What the stack is carrying — how many coins, and whether it is poisoned
        — goes on top of everything. These are numbers to be read, not scenery:
        a wall drawn across them costs the player something they need.
      */}
      {geometry.cells.map(({ id, x, y }) => {
        const stack = view.units[id];
        if (!stack) return null;
        const badge = R * 1.32 / 2 + 1.5;
        return (
          <g key={`b-${id}`} data-badge={id} className="hex-decor">
            {stack.poisonedBy ? <Poisoned x={x} y={y} r={badge} /> : null}
            {stack.coins > 1 ? (
              <>
                <circle
                  cx={x + R * 0.5}
                  cy={y + R * 0.5}
                  r={9}
                  fill="var(--color-bg)"
                  stroke="var(--color-divider)"
                />
                <text
                  x={x + R * 0.5}
                  y={y + R * 0.5 + 4}
                  textAnchor="middle"
                  fontSize="11"
                  fontFamily="var(--font-heading)"
                  fill="var(--color-neutral-800)"
                >
                  {stack.coins}
                </text>
              </>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

/**
 * A poisoned unit. The box marks it with a counter on the coin; the print-and-
 * play set has no such token among the assets, so this is a drawn stand-in — a
 * skull badge and a dashed ring, both in a colour the board uses nowhere else.
 */
function Poisoned({ x, y, r }: { x: number; y: number; r: number }) {
  const bx = x - r * 0.72;
  const by = y - r * 0.72;
  return (
    <g className="poisoned">
      <title>
        Отравлен: своими монетами не ходит, не бьёт и не усиливается. Сбросьте его монету лицом
        вверх, чтобы снять яд
      </title>
      <circle
        cx={x}
        cy={y}
        r={r}
        fill="none"
        stroke={POISON}
        strokeWidth={3}
        strokeDasharray="5 4"
      />
      <circle cx={bx} cy={by} r={9} fill={POISON} stroke="#fff" strokeWidth={1.5} />
      {/* Skull: cranium, two sockets, jaw. */}
      <circle cx={bx} cy={by - 1.2} r={4.2} fill="#fff" />
      <circle cx={bx - 1.6} cy={by - 1.4} r={1.3} fill={POISON} />
      <circle cx={bx + 1.6} cy={by - 1.4} r={1.3} fill={POISON} />
      <rect x={bx - 2.2} y={by + 2.1} width={4.4} height={2.8} rx={1.1} fill="#fff" />
    </g>
  );
}

/**
 * A Fortification. The expansion's token art was not among the assets, so this
 * is a drawn stand-in: a battlemented wall ring around the hex. It is drawn
 * over the unit rather than under it — a wall the garrison hides behind is a
 * wall nobody can see. The ring sits inside the control rim, so a fortified
 * location can say both things at once.
 */
function Fortification({ x, y, r }: { x: number; y: number; r: number }) {
  const ring = r - 11;
  const merlons = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 180) * (60 * i + 30);
    const mx = x + ring * Math.cos(a);
    const my = y + ring * Math.sin(a);
    merlons.push(
      <rect
        key={i}
        x={mx - 4}
        y={my - 4}
        width={8}
        height={8}
        rx={1.5}
        fill="var(--color-neutral-800)"
        stroke="#e8dcc2"
        strokeWidth={1}
        transform={`rotate(${60 * i + 30} ${mx} ${my})`}
      />,
    );
  }
  // Over a coin the stonework needs an edge of its own: the pale line first,
  // the wall drawn on top of it.
  return (
    <g className="hex-decor fort">
      <circle cx={x} cy={y} r={ring} fill="none" stroke="#e8dcc2" strokeWidth={6} opacity={0.75} />
      <circle cx={x} cy={y} r={ring} fill="none" stroke="var(--color-neutral-800)" strokeWidth={4} />
      {merlons}
    </g>
  );
}
