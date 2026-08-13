/** Profile and rules screens. */

import {
  UNITS,
  UNIT_IDS,
} from '@wc/shared';
import { useState } from 'react';
import { store, useApp } from '../net.js';
import { Avatar } from '../ui/Avatar.js';
import { BackBar, Coin, Modal } from '../ui/bits.js';

const dateFormat = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' });

export function ProfileScreen() {
  const { profile, user } = useApp();
  const played = (profile?.wins ?? 0) + (profile?.losses ?? 0);
  const rate = played ? Math.round(((profile?.wins ?? 0) / played) * 100) : 0;

  return (
    <div className="screen">
      <BackBar onBack={() => store.go('hub')} />
      <div className="row" style={{ gap: 16 }}>
        <Avatar
          name={profile?.displayName ?? user?.displayName ?? '?'}
          photoUrl={profile?.photoUrl ?? user?.photoUrl}
          size={76}
        />
        <div>
          <h2 style={{ fontSize: 26, margin: 0, lineHeight: 1.1 }}>{profile?.displayName ?? user?.displayName ?? '—'}</h2>
          <div className="muted">{profile?.username ? `@${profile.username}` : 'из Telegram'}</div>
        </div>
      </div>

      <div className="row" style={{ marginTop: 20, gap: 10 }}>
        <Stat value={profile?.wins ?? 0} label="победы" />
        <Stat value={profile?.losses ?? 0} label="поражения" />
        <Stat value={`${rate}%`} label="винрейт" accent />
      </div>

      <div className="kicker" style={{ marginTop: 26 }}>Последние партии</div>
      <div className="scroll stack" style={{ marginTop: 12, gap: 8 }}>
        {(profile?.history ?? []).map((h, i) => (
          <div key={i} className="row" style={{ padding: '12px 14px', borderRadius: 22, background: 'var(--color-surface)' }}>
            <span
              style={{
                width: 8,
                height: 8,
                flex: 'none',
                borderRadius: '50%',
                background: h.won ? 'var(--color-accent-2-600)' : 'var(--color-accent-600)',
              }}
            />
            <span className="grow">
              <span style={{ display: 'block', fontSize: 14 }}>против {h.opponents || '—'}</span>
              <span className="muted" style={{ fontSize: 11 }}>
                {h.tableName} · {h.size} игрока · {dateFormat.format(h.finishedAt)}
              </span>
            </span>
            <span
              style={{
                fontFamily: 'var(--font-heading)',
                fontSize: 13,
                color: h.won ? 'var(--color-accent-2-600)' : 'var(--color-accent-600)',
              }}
            >
              {h.won ? 'победа' : 'поражение'}
            </span>
          </div>
        ))}
        {(profile?.history.length ?? 0) === 0 ? (
          <div className="muted" style={{ textAlign: 'center', padding: 40 }}>
            Пока ни одной законченной партии.
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Stat({ value, label, accent }: { value: number | string; label: string; accent?: boolean }) {
  return (
    <div
      className="grow"
      style={{
        padding: 16,
        borderRadius: 26,
        background: accent ? 'var(--color-accent-100)' : 'var(--color-surface)',
      }}
    >
      <div
        style={{
          fontFamily: 'var(--font-heading)',
          fontSize: 28,
          lineHeight: 1,
          color: accent ? 'var(--color-accent-700)' : undefined,
        }}
      >
        {value}
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
        {label}
      </div>
    </div>
  );
}

const RULES = [
  {
    n: '1',
    title: 'Наберите отряды',
    body: 'Восемь карт из шестнадцати выкладываются в ряд. Игроки разбирают их по очереди 1–2–2–2–1, у каждого остаётся четыре типа отрядов. Тот, кто выбирал вторым, ходит первым.',
  },
  {
    n: '2',
    title: 'Тяните монеты',
    body: 'В мешке 9 монет: по две каждого своего отряда и королевская монета. В начале раунда берите три монеты. Когда мешок пустеет, в него замешивается сброс.',
  },
  {
    n: '3',
    title: 'Тратьте монету на действие',
    body: 'Каждый ход — ровно одна монета. Положить на поле: развернуть или усилить. Сбросить рубашкой вниз: инициатива, наём, пас. Сбросить лицом вверх — манёвр: ход, атака, захват или тактика отряда.',
  },
  {
    n: '4',
    title: 'Держите локации',
    body: 'Разворачивать отряды можно только на свои пустые локации. Отряд, стоящий на локации, может поставить туда ваш контрольный маркер — или заменить чужой.',
  },
  {
    n: '5',
    title: 'Атака снимает монету',
    body: 'Атака убирает из отряда одну монету — навсегда, в коробку. Отряд из одной монеты уничтожается. Усиление делает отряд живучее, но монеты в стопке уже не вернутся в мешок.',
  },
  {
    n: '6',
    title: 'Победа',
    body: 'Побеждает тот, кто выставит все шесть своих контрольных маркеров. Два уже стоят на стартовых локациях — значит, нужно захватить ещё четыре.',
  },
];

export function RulesScreen() {
  const [unit, setUnit] = useState<(typeof UNIT_IDS)[number] | null>(null);

  return (
    <div className="screen">
      <BackBar onBack={() => store.go('hub')} title="Правила" />
      <div className="scroll stack" style={{ gap: 10 }}>
        {RULES.map((r) => (
          <div key={r.n} className="row" style={{ alignItems: 'flex-start', gap: 14, padding: '16px 18px', borderRadius: 26, background: 'var(--color-surface)' }}>
            <div
              style={{
                width: 30,
                height: 30,
                flex: 'none',
                borderRadius: '50%',
                background: 'var(--color-accent)',
                color: 'var(--color-bg)',
                display: 'grid',
                placeItems: 'center',
                fontFamily: 'var(--font-heading)',
                fontSize: 14,
              }}
            >
              {r.n}
            </div>
            <div>
              <div style={{ fontFamily: 'var(--font-heading)', fontSize: 17, lineHeight: 1.2 }}>{r.title}</div>
              <div className="muted" style={{ marginTop: 4 }}>{r.body}</div>
            </div>
          </div>
        ))}

        <div className="kicker" style={{ marginTop: 12 }}>Шестнадцать отрядов</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
          {UNIT_IDS.map((id) => (
            <button
              key={id}
              onClick={() => setUnit(id)}
              style={{ background: 'none', border: 'none', padding: 0, display: 'grid', placeItems: 'center', gap: 4 }}
            >
              <Coin unit={id} size={52} />
              <span style={{ fontSize: 10, textAlign: 'center', color: 'var(--color-neutral-700)', lineHeight: 1.2 }}>
                {UNITS[id].name.ru}
              </span>
            </button>
          ))}
        </div>
      </div>

      {unit ? <UnitCardModal unit={unit} onClose={() => setUnit(null)} /> : null}
    </div>
  );
}

/**
 * The rules a card names but does not spell out. Text follows the expansion
 * rulebooks (`design/rules/*_expansion_rules.pdf`) — a card that mentions
 * poison never says what poison does, and there is nowhere else to look.
 */
const MECHANICS: Record<string, { title: string; text: string }> = {
  poison: {
    title: 'Что делает яд',
    text:
      'Пока на отряде жетон яда, его собственные монеты почти бесполезны: ими нельзя ни ходить, ' +
      'ни атаковать, ни захватывать, ни применять его тактику, ни усиливать его. Зато чужие приказы ' +
      'работают — атака от Маршала, ход от Знаменосца, указы Знати. Свойства и ограничения самого ' +
      'отряда тоже действуют как обычно. Снять яд: сбросить монету этого отряда лицом вверх — это не ' +
      'манёвр, и снимает яд со всех ваших отрядов этого типа. У каждого отравителя один жетон: ' +
      'отравив нового врага, он освобождает прежнего.',
  },
  decoy: {
    title: 'Что делает обманка',
    text:
      'Обманная монета кладётся лицом вверх в сброс соперника и засоряет его мешок. Если она уже ' +
      'у него в мешке, руке или сбросе — ничего не происходит; второй такой монеты не бывает. ' +
      'Соперник избавляется от неё, сыграв её из руки лицом вверх: монета возвращается к карте. ' +
      'Ещё ею можно сделать любое действие рубашкой вниз — пас или перехват инициативы.',
  },
  siegeTactic: {
    title: 'Что такое осадная тактика',
    text:
      'Осадная тактика работает как обычная, но начать её можно, только пока отряд усилен — то есть ' +
      'в его стопке хотя бы две монеты. Проверка одна, в момент начала: если по ходу тактики стопка ' +
      'уменьшится, тактика всё равно доводится до конца.',
  },
  fortification: {
    title: 'Как работают укрепления',
    text:
      'Укрепление — не отряд, но атакуют его как отряд, и любая атака сносит его в запас. На ' +
      'нейтральную или свою локацию с укреплением заходить можно, на вражескую — нет: сначала ' +
      'снесите укрепление. Отряды с ходом на несколько клеток сквозь укрепление не проходят. Пока ' +
      'укрепление стоит, отряд на этой же клетке атаковать нельзя — только само укрепление.',
  },
};

function mechanicsFor(def: (typeof UNITS)[(typeof UNIT_IDS)[number]]): string[] {
  const out = new Set<string>();
  const kind = def.tactic?.kind;
  if (kind === 'moveThenPoison' || kind === 'poisonAtRange') out.add('poison');
  if (def.attributes.includes('burnSupplyAfterKillingPoisoned')) out.add('poison');
  if (def.attributes.includes('deceiveAfterControl')) out.add('decoy');
  if (def.attributes.includes('deceiveWhenAttacked')) out.add('decoy');
  if (def.siegeTactic) out.add('siegeTactic');
  if (def.attributes.includes('buildFortOnMove')) out.add('fortification');
  if (kind === 'moveThenAttackFort') out.add('fortification');
  return [...out];
}

export function UnitCardModal({ unit, onClose }: { unit: (typeof UNIT_IDS)[number]; onClose: () => void }) {
  const def = UNITS[unit];
  const mechanics = mechanicsFor(def);
  return (
    <Modal onClose={onClose}>
      <div className="row" style={{ gap: 16, alignItems: 'flex-start' }}>
        <Coin unit={unit} size={78} />
        <div className="grow">
          <h3 style={{ fontSize: 22, margin: '0 0 2px' }}>{def.name.ru}</h3>
          <div className="muted" style={{ fontSize: 12 }}>
            {def.coins} монет в игре · 2 в мешке на старте
          </div>
        </div>
      </div>

      <div className="stack" style={{ marginTop: 14, gap: 8 }}>
        {def.text.tactic ? <Line kind="Тактика" text={def.text.tactic.ru} tone="green" /> : null}
        {def.text.attribute ? <Line kind="Свойство" text={def.text.attribute.ru} tone="accent" /> : null}
        {def.text.restriction ? <Line kind="Ограничение" text={def.text.restriction.ru} tone="red" /> : null}
        {!def.tactic && def.attributes.length === 0 ? (
          <div className="muted">Обычный отряд: ход, атака, захват.</div>
        ) : null}
        {mechanics.map((id) => (
          <Line key={id} kind={MECHANICS[id]!.title} text={MECHANICS[id]!.text} tone="plain" />
        ))}
      </div>
    </Modal>
  );
}

function Line({
  kind,
  text,
  tone,
}: {
  kind: string;
  text: string;
  tone: 'green' | 'accent' | 'red' | 'plain';
}) {
  const bg =
    tone === 'green'
      ? 'var(--color-accent-2-100)'
      : tone === 'red'
        ? 'var(--color-accent-100)'
        : tone === 'plain'
          ? 'transparent'
          : 'var(--color-neutral-100)';
  return (
    <div
      style={{
        padding: '10px 13px',
        borderRadius: 18,
        background: bg,
        border: tone === 'plain' ? '1px solid var(--color-divider)' : undefined,
      }}
    >
      <div className="kicker" style={{ marginBottom: 2 }}>{kind}</div>
      <div style={{ fontSize: 13, lineHeight: 1.4 }}>{text}</div>
    </div>
  );
}
