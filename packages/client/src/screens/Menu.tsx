/** Hub, lobby list, join-by-code, create-lobby and lobby screens. */

import {
  BOT_LEVELS,
  BOT_LEVEL_NAMES,
  SET_NAMES,
  UNITS,
  UNIT_IDS,
  type BoardSize,
  type BotLevel,
  type DraftMode,
  type UnitSet,
} from '@wc/shared';
import { useEffect, useState } from 'react';
import { store, useApp } from '../net.js';
import { haptic } from '../telegram.js';
import { initials } from '../ui/Crest.js';
import { Avatar } from '../ui/Avatar.js';
import { BackBar, Coin, Sheet } from '../ui/bits.js';
import { plural } from './log.js';

const CREST_COLORS = [
  'var(--color-accent-500)',
  'var(--color-accent-2-600)',
  'var(--color-neutral-600)',
  'var(--color-accent-700)',
];

export const EXPANSIONS: UnitSet[] = ['nobility', 'siege', 'nightfall'];

export const DRAFT_MODES: { id: DraftMode; title: string; note: string }[] = [
  {
    id: 'draft',
    title: 'Обычный драфт',
    note: 'Восемь карт в ряд, разбор по очереди 1–2–2–2–1',
  },
  {
    id: 'ban',
    title: 'Драфт с банами',
    note: 'Десять карт, каждая сторона вычёркивает одну, дальше как обычно',
  },
  {
    id: 'random',
    title: 'Случайно',
    note: 'По четыре отряда каждому сразу, без выбора',
  },
];

export function draftModeTitle(mode: DraftMode): string {
  return DRAFT_MODES.find((m) => m.id === mode)?.title ?? mode;
}

function crestColor(key: string): string {
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return CREST_COLORS[h % CREST_COLORS.length]!;
}

export function Hub() {
  const { lobbies, user, bots } = useApp();
  useEffect(() => store.refreshLobbies(), []);
  const open = lobbies.filter((l) => l.players < l.size).length;

  return (
    <div className="screen">
      <div className="blob blob--a" />
      <div className="blob blob--b" />

      <div className="row" style={{ marginTop: 26 }}>
        <div
          style={{
            width: 62,
            height: 62,
            borderRadius: '50%',
            background: 'var(--color-accent)',
            display: 'grid',
            placeItems: 'center',
            boxShadow: 'var(--shadow-md)',
            flex: 'none',
          }}
        >
          <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#f5ead8" strokeWidth="2.75" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="7" width="20" height="13" rx="3" />
            <path d="M2 12h20" />
            <path d="M12 12v3" />
            <path d="M6 7V6a6 6 0 0 1 12 0v1" />
          </svg>
        </div>
        <div>
          <div style={{ fontSize: 11, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--color-accent-700)' }}>
            Настольная
          </div>
          <h1 style={{ fontSize: 33, margin: '2px 0 0', lineHeight: 1 }}>Сундук войны</h1>
        </div>
      </div>

      <p className="muted" style={{ marginTop: 18, maxWidth: 290 }}>
        Соберите отряд, тяните монеты из мешка и удержите локации. Дуэль на двоих
        по правилам War Chest.
      </p>

      <div className="stack" style={{ marginTop: 24 }}>
        <button className="menu-btn menu-btn--primary" onClick={() => store.go('list')}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.75" strokeLinecap="round">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <span className="grow">
            <span className="menu-btn__title">Найти игру</span>
            <span className="menu-btn__note">
              {open === 0 ? 'пока никто не ждёт' : `${plural(open, 'открытый стол', 'открытых стола', 'открытых столов')}`}
            </span>
          </span>
        </button>

        {bots.length > 0 ? (
          <button className="menu-btn" onClick={() => store.go('bot')}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--color-accent)" strokeWidth="2.75" strokeLinecap="round" strokeLinejoin="round">
              <rect x="4" y="8" width="16" height="12" rx="3" />
              <path d="M12 8V4" />
              <circle cx="9" cy="14" r="1" />
              <circle cx="15" cy="14" r="1" />
            </svg>
            <span className="grow">
              <span className="menu-btn__title">Играть с ботом</span>
              <span className="menu-btn__note">Партия начнётся сразу</span>
            </span>
          </button>
        ) : null}

        <button className="menu-btn" onClick={() => store.go('create')}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--color-accent)" strokeWidth="2.75" strokeLinecap="round">
            <path d="M12 5v14" />
            <path d="M5 12h14" />
          </svg>
          <span className="grow">
            <span className="menu-btn__title">Создать стол</span>
            <span className="menu-btn__note">Название, пароль, размер</span>
          </span>
        </button>

        <button className="menu-btn" style={{ background: 'transparent' }} onClick={() => store.go('code')}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--color-accent-2-700)" strokeWidth="2.75" strokeLinecap="round">
            <rect x="3" y="4" width="18" height="16" rx="4" />
            <path d="M8 10h.01M12 10h.01M16 10h.01M8 15h8" />
          </svg>
          <span className="grow">
            <span className="menu-btn__title">Войти по коду</span>
            <span className="menu-btn__note">Шесть символов от хозяина стола</span>
          </span>
        </button>
      </div>

      <div className="row" style={{ marginTop: 'auto', paddingTop: 20 }}>
        <button className="btn btn--secondary grow" onClick={() => store.go('profile')}>
          <Avatar name={user?.displayName ?? '?'} photoUrl={user?.photoUrl} size={26} />
          Профиль
        </button>
        <button className="btn btn--secondary grow" onClick={() => store.go('rules')}>
          Правила
        </button>
      </div>
    </div>
  );
}

export function LobbyList() {
  const { lobbies, error } = useApp();
  const [query, setQuery] = useState('');
  const [locked, setLocked] = useState<string | null>(null);

  useEffect(() => store.refreshLobbies(), []);

  const visible = lobbies.filter(
    (l) =>
      !query.trim() ||
      l.name.toLowerCase().includes(query.trim().toLowerCase()) ||
      l.code.includes(query.trim().toUpperCase()),
  );

  return (
    <div className="screen">
      <div className="row" style={{ marginBottom: 8 }}>
        <button className="icon-btn" onClick={() => store.go('hub')} aria-label="Назад">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.75" strokeLinecap="round">
            <path d="m15 5-7 7 7 7" />
          </svg>
        </button>
        <h2 style={{ fontSize: 26, margin: 0 }} className="grow">
          Открытые столы
        </h2>
        <button className="icon-btn" style={{ color: 'var(--color-accent)' }} onClick={() => store.refreshLobbies()} aria-label="Обновить">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.75" strokeLinecap="round">
            <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
            <path d="M21 3v5h-5" />
          </svg>
        </button>
      </div>

      <input className="input" placeholder="Название или код" value={query} onChange={(e) => setQuery(e.target.value)} />

      <div className="scroll stack" style={{ marginTop: 12 }}>
        {visible.map((l) => (
          <div className="card" key={l.code} style={{ animation: 'wc-rise 240ms ease both' }}>
            <div className="row" style={{ alignItems: 'flex-start', gap: 10 }}>
              <div
                style={{
                  width: 40,
                  height: 40,
                  flex: 'none',
                  borderRadius: '50%',
                  background: crestColor(l.code),
                  color: 'var(--color-bg)',
                  display: 'grid',
                  placeItems: 'center',
                  fontFamily: 'var(--font-heading)',
                }}
              >
                {initials(l.name)}
              </div>
              <div className="grow">
                <div style={{ fontFamily: 'var(--font-heading)', fontSize: 18, lineHeight: 1.15 }}>{l.name}</div>
                <div className="muted" style={{ fontSize: 12 }}>
                  хозяин {l.host} · код {l.code}
                </div>
              </div>
              {l.locked ? (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--color-neutral-600)" strokeWidth="2.75" strokeLinecap="round">
                  <rect x="3" y="11" width="18" height="10" rx="3" />
                  <path d="M8 11V7a4 4 0 0 1 8 0v4" />
                </svg>
              ) : null}
            </div>
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              <span className="tag tag--green">
                {l.players} из {l.size}
              </span>
              <span className="tag tag--accent">{l.size === 2 ? 'дуэль' : 'две пары'}</span>
              <span className="tag tag--accent">{draftModeTitle(l.draftMode).toLowerCase()}</span>
              {l.sets
                .filter((x) => x !== 'base')
                .map((x) => (
                  <span key={x} className="tag tag--green">
                    {SET_NAMES[x].ru}
                  </span>
                ))}
            </div>
            <div className="row">
              <span className="muted grow" style={{ fontSize: 12 }}>
                {l.players >= l.size ? 'Стол собран' : l.locked ? 'Нужен пароль' : 'Ждут игроков'}
              </span>
              <button
                className="btn btn--primary"
                style={{ padding: '9px 22px' }}
                disabled={l.players >= l.size}
                onClick={() => {
                  haptic();
                  if (l.locked) setLocked(l.code);
                  else store.joinLobby(l.code);
                }}
              >
                {l.players >= l.size ? 'Занято' : 'Войти'}
              </button>
            </div>
          </div>
        ))}
        {visible.length === 0 ? (
          <div className="muted" style={{ textAlign: 'center', padding: '50px 24px' }}>
            Ничего не нашлось. Проверьте код или создайте свой стол.
          </div>
        ) : null}
      </div>

      <button className="btn btn--primary btn--block" style={{ marginTop: 10 }} onClick={() => store.go('create')}>
        Создать стол
      </button>

      {locked ? (
        <PasswordSheet
          code={locked}
          error={error?.code === 'password' ? error.message : null}
          onClose={() => {
            setLocked(null);
            store.clearError();
          }}
        />
      ) : null}
    </div>
  );
}

function PasswordSheet({ code, error, onClose }: { code: string; error: string | null; onClose: () => void }) {
  const [password, setPassword] = useState('');
  return (
    <Sheet onClose={onClose}>
      <h3 style={{ fontSize: 22, margin: '0 0 4px' }}>Стол {code}</h3>
      <p className="muted" style={{ margin: '0 0 14px' }}>
        Стол под паролем. Спросите его у хозяина.
      </p>
      <input
        className="input"
        placeholder="Пароль"
        value={password}
        autoFocus
        onChange={(e) => setPassword(e.target.value)}
        style={{ background: 'var(--color-bg)' }}
      />
      {error ? <div className="error" style={{ marginTop: 8 }}>{error}</div> : null}
      <div className="row" style={{ marginTop: 16 }}>
        <button className="btn btn--secondary grow" onClick={onClose}>
          Отмена
        </button>
        <button className="btn btn--primary" style={{ flex: 2 }} onClick={() => store.joinLobby(code, password)}>
          Войти
        </button>
      </div>
    </Sheet>
  );
}

export function JoinByCode() {
  const { error } = useApp();
  const [code, setCode] = useState('');
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    if (error?.code === 'password') setAsking(true);
  }, [error]);

  return (
    <div className="screen">
      <BackBar onBack={() => store.go('hub')} />
      <h2 style={{ fontSize: 28, margin: '10px 0 6px' }}>Войти по коду</h2>
      <p className="muted" style={{ margin: '0 0 22px' }}>
        Шесть символов, которые хозяин стола прислал в чат.
      </p>
      <input
        className="input"
        placeholder="ABC123"
        value={code}
        onChange={(e) => {
          setCode(e.target.value.toUpperCase().slice(0, 6));
          store.clearError();
        }}
        style={{
          textAlign: 'center',
          fontFamily: 'var(--font-heading)',
          fontSize: 26,
          letterSpacing: '0.24em',
          minHeight: 62,
        }}
      />
      {error && error.code !== 'password' ? (
        <div className="error" style={{ marginTop: 10, textAlign: 'center' }}>
          {error.message}
        </div>
      ) : null}
      <button
        className="btn btn--primary btn--block"
        style={{ marginTop: 18 }}
        disabled={code.length < 4}
        onClick={() => store.joinLobby(code)}
      >
        Найти стол
      </button>

      {asking ? (
        <PasswordSheet
          code={code}
          error={error?.code === 'password' ? error.message : null}
          onClose={() => {
            setAsking(false);
            store.clearError();
          }}
        />
      ) : null}
    </div>
  );
}

export function CreateLobby() {
  const [name, setName] = useState('');
  const [size, setSize] = useState<BoardSize>(2);
  const [withPassword, setWithPassword] = useState(false);
  const [password, setPassword] = useState('');
  const [draftMode, setDraftMode] = useState<DraftMode>('draft');
  const [sets, setSets] = useState<UnitSet[]>([]);
  // What this server will run, not what this bundle knows about.
  const { sets: ready } = useApp();

  return (
    <div className="screen">
      <BackBar onBack={() => store.go('hub')} title="Новый стол" />

      <div className="scroll stack" style={{ gap: 22, marginTop: 10 }}>
        <div>
          <div className="kicker" style={{ marginBottom: 6 }}>Название стола</div>
          <input className="input" placeholder="Вороний брод" value={name} onChange={(e) => setName(e.target.value)} />
        </div>

        <div>
          <div className="kicker" style={{ marginBottom: 8 }}>Игроков за столом</div>
          <div className="row">
            {([2, 4] as BoardSize[]).map((n) => (
              <button
                key={n}
                className="grow"
                onClick={() => setSize(n)}
                disabled={n === 4}
                style={{
                  padding: '16px 12px',
                  borderRadius: 24,
                  border: `1px solid ${size === n ? 'var(--color-accent)' : 'var(--color-divider)'}`,
                  background: size === n ? 'var(--color-accent)' : 'var(--color-surface)',
                  color: size === n ? 'var(--color-bg)' : 'var(--color-text)',
                }}
              >
                <span style={{ display: 'block', fontFamily: 'var(--font-heading)', fontSize: 22, lineHeight: 1 }}>{n}</span>
                <span style={{ display: 'block', fontSize: 12, marginTop: 4, opacity: 0.8 }}>
                  {n === 2 ? 'дуэль' : 'две пары — позже'}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className="row">
            <div className="grow">
              <div style={{ fontFamily: 'var(--font-heading)', fontSize: 16 }}>Пароль</div>
              <div className="muted" style={{ fontSize: 12 }}>Стол виден в списке, но войти смогут только свои</div>
            </div>
            <button
              onClick={() => setWithPassword((v) => !v)}
              aria-label="Пароль"
              style={{
                width: 52,
                height: 30,
                flex: 'none',
                border: 'none',
                borderRadius: 999,
                padding: 3,
                background: withPassword ? 'var(--color-accent)' : 'var(--color-neutral-400)',
                transition: 'background 180ms ease',
              }}
            >
              <span
                style={{
                  display: 'block',
                  width: 24,
                  height: 24,
                  borderRadius: '50%',
                  background: 'var(--color-bg)',
                  boxShadow: 'var(--shadow-sm)',
                  transform: `translateX(${withPassword ? 22 : 0}px)`,
                  transition: 'transform 180ms ease',
                }}
              />
            </button>
          </div>
          {withPassword ? (
            <input
              className="input"
              style={{ marginTop: 12 }}
              placeholder="Пароль для своих"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          ) : null}
        </div>

        <div>
          <div className="kicker" style={{ marginBottom: 8 }}>Дополнения</div>
          <div className="stack" style={{ gap: 8 }}>
            {EXPANSIONS.map((set) => {
              const isReady = ready.includes(set);
              const on = sets.includes(set);
              const units = UNIT_IDS.filter((u) => UNITS[u].set === set);
              return (
                <button
                  key={set}
                  disabled={!isReady}
                  onClick={() =>
                    setSets((cur) => (cur.includes(set) ? cur.filter((s) => s !== set) : [...cur, set]))
                  }
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    textAlign: 'left',
                    padding: '11px 14px',
                    borderRadius: 22,
                    border: `1px solid ${on ? 'var(--color-accent-400)' : 'var(--color-divider)'}`,
                    background: on ? 'var(--color-accent-100)' : 'var(--color-surface)',
                  }}
                >
                  <span className="row" style={{ gap: 4 }}>
                    {units.slice(0, 4).map((u) => (
                      <Coin key={u} unit={u} size={26} />
                    ))}
                  </span>
                  <span className="grow">
                    <span style={{ display: 'block', fontFamily: 'var(--font-heading)', fontSize: 15 }}>
                      {SET_NAMES[set].ru}
                    </span>
                    <span className="muted" style={{ display: 'block', fontSize: 12 }}>
                      {isReady ? '4 отряда' : 'сервер этот набор не поддерживает'}
                    </span>
                  </span>
                  <span
                    style={{
                      width: 20,
                      height: 20,
                      flex: 'none',
                      borderRadius: 6,
                      border: `2px solid ${on ? 'var(--color-accent)' : 'var(--color-neutral-400)'}`,
                      background: on ? 'var(--color-accent)' : 'transparent',
                      color: 'var(--color-bg)',
                      display: 'grid',
                      placeItems: 'center',
                      fontSize: 13,
                      lineHeight: 1,
                    }}
                  >
                    {on ? '✓' : ''}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <div className="kicker" style={{ marginBottom: 8 }}>Как раздаются отряды</div>
          <div className="stack" style={{ gap: 8 }}>
            {DRAFT_MODES.map((mode) => (
              <button
                key={mode.id}
                onClick={() => setDraftMode(mode.id)}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 12,
                  textAlign: 'left',
                  padding: '12px 14px',
                  borderRadius: 22,
                  border: `1px solid ${draftMode === mode.id ? 'var(--color-accent-400)' : 'var(--color-divider)'}`,
                  background: draftMode === mode.id ? 'var(--color-accent-100)' : 'var(--color-surface)',
                }}
              >
                <span
                  style={{
                    width: 20,
                    height: 20,
                    flex: 'none',
                    marginTop: 2,
                    borderRadius: '50%',
                    border: `2px solid ${draftMode === mode.id ? 'var(--color-accent)' : 'var(--color-neutral-400)'}`,
                    background: draftMode === mode.id ? 'var(--color-accent)' : 'transparent',
                    boxShadow: draftMode === mode.id ? 'inset 0 0 0 3px var(--color-bg)' : 'none',
                  }}
                />
                <span className="grow">
                  <span style={{ display: 'block', fontFamily: 'var(--font-heading)', fontSize: 15 }}>
                    {mode.title}
                  </span>
                  <span className="muted" style={{ display: 'block', fontSize: 12 }}>{mode.note}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>

      <button
        className="btn btn--primary btn--block"
        style={{ marginTop: 12 }}
        onClick={() =>
          store.createLobby({
            sets,
            ...(name.trim() ? { name: name.trim() } : {}),
            size,
            draftMode,
            ...(withPassword && password ? { password } : {}),
          })
        }
      >
        Собрать стол
      </button>
    </div>
  );
}

/** Sitting down against the computer: a level, and the same table settings. */
export function PlayBot() {
  const { bots, sets: readySets } = useApp();
  const [level, setLevel] = useState<BotLevel>(bots[0] ?? 'easy');
  const [draftMode, setDraftMode] = useState<DraftMode>('draft');
  const [sets, setSets] = useState<UnitSet[]>([]);

  return (
    <div className="screen">
      <BackBar onBack={() => store.go('hub')} title="Игра с ботом" />

      <div className="scroll stack" style={{ gap: 22, marginTop: 10 }}>
        <div>
          <div className="kicker" style={{ marginBottom: 8 }}>Соперник</div>
          <div className="stack" style={{ gap: 8 }}>
            {BOT_LEVELS.map((id) => {
              const ready = bots.includes(id);
              const on = level === id;
              return (
                <button
                  key={id}
                  disabled={!ready}
                  onClick={() => setLevel(id)}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 12,
                    textAlign: 'left',
                    padding: '12px 14px',
                    borderRadius: 22,
                    border: `1px solid ${on ? 'var(--color-accent-400)' : 'var(--color-divider)'}`,
                    background: on ? 'var(--color-accent-100)' : 'var(--color-surface)',
                    opacity: ready ? 1 : 0.55,
                  }}
                >
                  <span
                    style={{
                      width: 20,
                      height: 20,
                      flex: 'none',
                      marginTop: 2,
                      borderRadius: '50%',
                      border: `2px solid ${on ? 'var(--color-accent)' : 'var(--color-neutral-400)'}`,
                      background: on ? 'var(--color-accent)' : 'transparent',
                      boxShadow: on ? 'inset 0 0 0 3px var(--color-bg)' : 'none',
                    }}
                  />
                  <span className="grow">
                    <span style={{ display: 'block', fontFamily: 'var(--font-heading)', fontSize: 15 }}>
                      {BOT_LEVEL_NAMES[id].ru}
                    </span>
                    <span className="muted" style={{ display: 'block', fontSize: 12 }}>
                      {ready ? BOT_LEVEL_NOTES[id] : 'пока не готов'}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <div className="kicker" style={{ marginBottom: 8 }}>Дополнения</div>
          <div className="stack" style={{ gap: 8 }}>
            {(['nobility', 'siege', 'nightfall'] as UnitSet[]).map((set) => {
              const isReady = readySets.includes(set);
              const on = sets.includes(set);
              return (
                <button
                  key={set}
                  disabled={!isReady}
                  onClick={() =>
                    setSets((cur) => (cur.includes(set) ? cur.filter((s) => s !== set) : [...cur, set]))
                  }
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    textAlign: 'left',
                    padding: '11px 14px',
                    borderRadius: 22,
                    border: `1px solid ${on ? 'var(--color-accent-400)' : 'var(--color-divider)'}`,
                    background: on ? 'var(--color-accent-100)' : 'var(--color-surface)',
                  }}
                >
                  <span className="grow" style={{ fontFamily: 'var(--font-heading)', fontSize: 15 }}>
                    {SET_NAMES[set].ru}
                  </span>
                  <span
                    style={{
                      width: 20,
                      height: 20,
                      flex: 'none',
                      borderRadius: 6,
                      border: `2px solid ${on ? 'var(--color-accent)' : 'var(--color-neutral-400)'}`,
                      background: on ? 'var(--color-accent)' : 'transparent',
                      color: 'var(--color-bg)',
                      display: 'grid',
                      placeItems: 'center',
                      fontSize: 13,
                      lineHeight: 1,
                    }}
                  >
                    {on ? '✓' : ''}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <div className="kicker" style={{ marginBottom: 8 }}>Как раздаются отряды</div>
          <div className="stack" style={{ gap: 8 }}>
            {DRAFT_MODES.map((mode) => (
              <button
                key={mode.id}
                onClick={() => setDraftMode(mode.id)}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 12,
                  textAlign: 'left',
                  padding: '12px 14px',
                  borderRadius: 22,
                  border: `1px solid ${draftMode === mode.id ? 'var(--color-accent-400)' : 'var(--color-divider)'}`,
                  background: draftMode === mode.id ? 'var(--color-accent-100)' : 'var(--color-surface)',
                }}
              >
                <span
                  style={{
                    width: 20,
                    height: 20,
                    flex: 'none',
                    marginTop: 2,
                    borderRadius: '50%',
                    border: `2px solid ${draftMode === mode.id ? 'var(--color-accent)' : 'var(--color-neutral-400)'}`,
                    background: draftMode === mode.id ? 'var(--color-accent)' : 'transparent',
                    boxShadow: draftMode === mode.id ? 'inset 0 0 0 3px var(--color-bg)' : 'none',
                  }}
                />
                <span className="grow">
                  <span style={{ display: 'block', fontFamily: 'var(--font-heading)', fontSize: 15 }}>
                    {mode.title}
                  </span>
                  <span className="muted" style={{ display: 'block', fontSize: 12 }}>{mode.note}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>

      <button
        className="btn btn--primary btn--block"
        style={{ marginTop: 12 }}
        disabled={bots.length === 0}
        onClick={() => store.playVsBot(level, { sets, draftMode })}
      >
        Начать партию
      </button>
    </div>
  );
}

const BOT_LEVEL_NOTES: Readonly<Record<BotLevel, string>> = {
  easy: 'играет без просчёта, по правилам большого пальца',
  medium: 'просчитывает ходы, думает недолго',
  hard: 'просчитывает ходы, думает до секунды',
};

export function LobbyRoom() {
  const { lobby, user } = useApp();
  const [copied, setCopied] = useState(false);
  if (!lobby) return null;

  const isHost = lobby.hostId === user?.userId;
  const free = lobby.size - lobby.members.length;

  return (
    <div className="screen">
      <div className="row" style={{ marginBottom: 6 }}>
        <button className="icon-btn" onClick={() => store.leaveLobby()} aria-label="Выйти">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.75" strokeLinecap="round">
            <path d="m15 5-7 7 7 7" />
          </svg>
        </button>
        <div className="grow">
          <h2 style={{ fontSize: 25, margin: 0, lineHeight: 1.1 }}>{lobby.name}</h2>
          <div className="muted" style={{ fontSize: 12 }}>
            {isHost ? 'вы хозяин стола' : `хозяин ${lobby.host}`} ·{' '}
            {draftModeTitle(lobby.draftMode).toLowerCase()}
            {lobby.sets
              .filter((x) => x !== 'base')
              .map((x) => ` · ${SET_NAMES[x].ru.toLowerCase()}`)
              .join('')}
          </div>
        </div>
      </div>

      <button
        onClick={() => {
          void navigator.clipboard?.writeText(lobby.code);
          setCopied(true);
          haptic();
          setTimeout(() => setCopied(false), 1600);
        }}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '14px 18px',
          borderRadius: 26,
          border: '1px dashed var(--color-accent-400)',
          background: 'var(--color-accent-100)',
          marginTop: 12,
        }}
      >
        <span className="grow" style={{ textAlign: 'left' }}>
          <span className="kicker" style={{ color: 'var(--color-accent-700)' }}>Код стола</span>
          <span style={{ display: 'block', fontFamily: 'var(--font-heading)', fontSize: 24, letterSpacing: '0.18em' }}>
            {lobby.code}
          </span>
        </span>
        <span style={{ fontSize: 12, color: 'var(--color-accent-700)' }}>{copied ? 'скопировано' : 'копировать'}</span>
      </button>

      <div className="scroll" style={{ marginTop: 20 }}>
        <div className="kicker">Гербы за столом</div>
        <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          {Array.from({ length: lobby.size }).map((_, i) => {
            const member = lobby.members[i];
            const you = member?.userId === user?.userId;
            return (
              <div key={i} className={`seat${member ? '' : ' seat--empty'}`} style={you ? { borderColor: 'var(--color-accent-2-400)', background: 'var(--color-accent-2-100)' } : undefined}>
                {member ? (
                  <Avatar
                    name={member.displayName}
                    photoUrl={member.photoUrl}
                    seat={i}
                    size={56}
                  />
                ) : (
                  <div
                    className="crest-badge"
                    style={{
                      background: 'transparent',
                      color: 'var(--color-neutral-500)',
                      boxShadow: 'inset 0 0 0 2px var(--color-neutral-300)',
                    }}
                  >
                    +
                  </div>
                )}
                <div style={{ fontSize: 13, textAlign: 'center' }}>
                  {member ? `${member.displayName}${you ? ' (вы)' : ''}` : 'Свободно'}
                </div>
                <div className="muted" style={{ fontSize: 11 }}>
                  {member ? (member.userId === lobby.hostId ? 'хозяин стола' : 'готов') : 'ждём игрока'}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn btn--secondary" onClick={() => store.leaveLobby()}>
          Выйти
        </button>
        <button className="btn btn--primary grow" disabled={free > 0 || !isHost} onClick={() => store.startGame()}>
          {free > 0 ? `Ждём ${free}` : isHost ? 'Начать партию' : 'Ждём хозяина'}
        </button>
      </div>
    </div>
  );
}
