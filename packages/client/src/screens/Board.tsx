/** The hex board, drawn from the real War Chest layout. */

import { boardFor, fromId, pixelCenter, type GameView, type HexId } from '@wc/shared';
import { useMemo } from 'react';
import { CrestImage, factionForSeat } from '../ui/Crest.js';

const R = 34; // hex radius in SVG units
const PAD = 8;
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
  onPick(hex: HexId): void;
}

export function Board({ view, highlight, chosen, focus, onPick }: BoardProps) {
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

      {/* Fortifications sit on the location, under whatever is standing there. */}
      {geometry.cells.map(({ id, x, y }) =>
        view.forts[id] ? <Fortification key={`f-${id}`} x={x} y={y} r={R} /> : null,
      )}

      {geometry.cells.map(({ id, x, y }) => {
        const stack = view.units[id];
        if (!stack) return null;
        const rim = teamColor(stack.team);
        const size = R * 1.32;
        return (
          // `hex-decor` makes taps fall through to the hex underneath —
          // otherwise you could never tap an enemy unit to attack it.
          <g key={`u-${id}`} className="hex-decor" style={{ animation: 'wc-pop 200ms ease both' }}>
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
            {stack.poisonedBy ? (
              <image
                href="/tokens/poison_icon.svg"
                x={x - R * 0.5 - 9}
                y={y - R * 0.5 - 9}
                width={18}
                height={18}
              >
                <title>
                  Отравлен: своими монетами не ходит, не бьёт и не усиливается. Сбросьте его монету
                  лицом вверх, чтобы снять яд
                </title>
              </image>
            ) : null}
            {stack.coins > 1 ? (
              <>
                <circle cx={x + R * 0.5} cy={y + R * 0.5} r={9} fill="var(--color-bg)" stroke="var(--color-divider)" />
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
 * A Fortification. The expansion's token art was not among the assets, so this
 * is a drawn stand-in: a battlemented wall ring around the hex.
 */
function Fortification({ x, y, r }: { x: number; y: number; r: number }) {
  const ring = r - 9;
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
        transform={`rotate(${60 * i + 30} ${mx} ${my})`}
      />,
    );
  }
  return (
    <g className="hex-decor" opacity={0.92}>
      <circle cx={x} cy={y} r={ring} fill="none" stroke="var(--color-neutral-800)" strokeWidth={4} />
      {merlons}
    </g>
  );
}
