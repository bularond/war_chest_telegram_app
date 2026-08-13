/** Small shared pieces: back bar, coin, modal, bottom sheet. */

import type {
  CoinId,
} from '@wc/shared';
import type { ReactNode } from 'react';
import { Crest, type Faction } from './Crest.js';

export function BackBar({ onBack, title }: { onBack: () => void; title?: ReactNode }) {
  return (
    <div className="row" style={{ marginBottom: 10 }}>
      <button className="icon-btn" onClick={onBack} aria-label="Назад">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.75" strokeLinecap="round" strokeLinejoin="round">
          <path d="m15 5-7 7 7 7" />
        </svg>
      </button>
      {title ? <h2 style={{ fontSize: 26, margin: 0 }}>{title}</h2> : null}
    </div>
  );
}

export function Coin({
  unit,
  size = 56,
  /** Rim colour — shows whose coin it is on the board and in the rail. */
  ring,
  faction = 'black',
  badge,
  selected,
  onClick,
  title,
  dimmed,
}: {
  unit: CoinId;
  size?: number;
  ring?: string;
  faction?: Faction;
  badge?: ReactNode;
  selected?: boolean;
  onClick?: () => void;
  title?: string;
  dimmed?: boolean;
}) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      className={`coin${selected ? ' coin--selected' : ''}`}
      style={{
        width: size,
        height: size,
        ...(ring && !selected ? { boxShadow: `0 0 0 2.5px ${ring}, var(--shadow-sm)` } : {}),
        ...(dimmed ? { filter: 'saturate(0.3) brightness(0.92)' } : {}),
      }}
      onClick={onClick}
      title={title}
      type={onClick ? 'button' : undefined}
    >
      <Crest unit={unit} size={size} faction={faction} />
      {badge !== undefined ? <span className="coin__badge">{badge}</span> : null}
    </Tag>
  );
}

export function Modal({ onClose, children, width }: { onClose: () => void; children: ReactNode; width?: number }) {
  return (
    <div className="backdrop" onClick={onClose}>
      <div className="modal" style={width ? { width } : undefined} onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

export function Sheet({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  return (
    <div className="backdrop" style={{ placeItems: 'end center', padding: 0 }} onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet__grip" />
        {children}
      </div>
    </div>
  );
}
