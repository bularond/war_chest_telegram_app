/**
 * Coin art.
 *
 * These are the print-and-play coin images supplied with the project, one PNG
 * per unit type plus the two faction Royal Coins, served from `/coins`. The disc
 * colour and the white glyph are both part of the image, so nothing here tints
 * or draws anything — it only places the picture.
 */

import {
  coinArt,
  coinName,
  type CoinId,
} from '@wc/shared';

export type Faction = 'black' | 'white';

/** A coin as an HTML image, for menus, the hand and the rail. */
export function Crest({
  unit,
  size = 24,
  faction = 'black',
}: {
  unit: CoinId;
  size?: number;
  faction?: Faction;
}) {
  return (
    <img
      src={coinArt(unit, faction)}
      width={size}
      height={size}
      alt={coinName(unit).ru}
      draggable={false}
      style={{ display: 'block', width: size, height: size }}
    />
  );
}

/** The same coin, for drawing inside an `<svg>`; `size` is the diameter. */
export function CrestImage({
  unit,
  size,
  faction = 'black',
  x = 0,
  y = 0,
}: {
  unit: CoinId;
  size: number;
  faction?: Faction;
  x?: number;
  y?: number;
}) {
  return (
    <image
      href={coinArt(unit, faction)}
      x={x - size / 2}
      y={y - size / 2}
      width={size}
      height={size}
      preserveAspectRatio="xMidYMid meet"
    />
  );
}

/**
 * Seats are dealt the printed factions in order. The box has four, but only the
 * black and gold coins were available as assets, so the two four-player seats
 * reuse them — teammates sit opposite each other and share a colour anyway.
 */
export function factionForSeat(seat: number): Faction {
  return seat % 2 === 0 ? 'black' : 'white';
}

/** Teams wear the same two printed factions, in seat order. */
export function factionForTeam(team: number): Faction {
  return team === 0 ? 'black' : 'white';
}

/**
 * A control marker. The Nobility Proclamation Seals are the same discs in the
 * same two colours, so this draws both.
 */
export function Marker({
  team,
  size = 12,
  placed,
  title,
}: {
  team: number;
  size?: number;
  /** Already spent — drawn as the empty space it left behind. */
  placed?: boolean;
  title?: string;
}) {
  return (
    <img
      className={`markers__one${placed ? ' markers__one--placed' : ''}`}
      src={`/markers/control_marker_${factionForTeam(team)}.png`}
      width={size}
      height={size}
      style={{ width: size, height: size }}
      alt=""
      title={title}
      draggable={false}
    />
  );
}

/** Two-letter monogram used for player crests, as in the mockup. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() ?? '').join('') || '?';
}
