/**
 * A player's face at the table.
 *
 * Telegram gives us a profile photo for most users, so that is what we show. The
 * fallback is the seat's Royal Coin — the same thing the printed game uses to
 * say which side of the table you are: black raven or gold lion. Initials are
 * the last resort, for a user with neither photo nor seat.
 */

import {
  coinArt,
} from '@wc/shared';
import { useState } from 'react';
import { factionForSeat, initials } from './Crest.js';

export function Avatar({
  name,
  photoUrl,
  seat,
  size = 40,
  ring,
}: {
  name: string;
  photoUrl?: string | null;
  /** Which side of the table; picks the Royal Coin used as the fallback. */
  seat?: number;
  size?: number;
  ring?: string;
}) {
  const [broken, setBroken] = useState(false);
  const style = {
    width: size,
    height: size,
    borderRadius: '50%',
    flex: 'none' as const,
    display: 'grid' as const,
    placeItems: 'center' as const,
    overflow: 'hidden' as const,
    ...(ring ? { boxShadow: `0 0 0 2px ${ring}` } : {}),
  };

  if (photoUrl && !broken) {
    return (
      <img
        src={photoUrl}
        alt={name}
        width={size}
        height={size}
        style={{ ...style, objectFit: 'cover' }}
        onError={() => setBroken(true)}
        draggable={false}
      />
    );
  }

  if (seat !== undefined) {
    return (
      <img
        src={coinArt('royal', factionForSeat(seat))}
        alt={name}
        width={size}
        height={size}
        style={style}
        draggable={false}
      />
    );
  }

  return (
    <span
      style={{
        ...style,
        background: 'var(--color-accent-2-500)',
        color: 'var(--color-bg)',
        fontFamily: 'var(--font-heading)',
        fontSize: Math.round(size * 0.36),
      }}
    >
      {initials(name)}
    </span>
  );
}
