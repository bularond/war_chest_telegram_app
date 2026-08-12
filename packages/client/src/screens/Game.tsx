/**
 * The game screen.
 *
 * Everything playable comes from `view.legal` — the server's own legal action
 * list. Picking an action is a matter of narrowing that list: tap a coin, tap an
 * action, then tap hexes until only one action is left, and send it.
 */

import {
  BOT_LEVEL_NAMES,
  DECREES,
  UNITS,
  boardFor,
  coinName,
  isUnitId,
  type CoinId,
  type DecreeId,
  type GameAction,
  type GameView,
  type HexId,
  type UnitId,
} from '@wc/shared';
import { useEffect, useMemo, useState } from 'react';
import { store, useApp } from '../net.js';
import { haptic, lockPortrait, notify } from '../telegram.js';
import { Marker, factionForSeat } from '../ui/Crest.js';
import { Avatar } from '../ui/Avatar.js';
import { Coin, Modal, Sheet } from '../ui/bits.js';
import { Board } from './Board.js';
import { UnitCardModal } from './Info.js';
import { coins, formatLog, logColor } from './log.js';

/**
 * The hexes an action names, in the order a player taps them: the unit that
 * acts first, then wherever it goes and whatever it hits. Actions of different
 * types are compared through these lists, so a plain move and a tactic that
 * moves further can be offered side by side.
 */
const HEX_FIELDS: Record<string, readonly string[]> = {
  deploy: ['to'],
  bolster: ['at'],
  move: ['from', 'to'],
  attack: ['from', 'to'],
  control: ['at'],
  tactic: ['from', 'subject', 'to', 'target'],
  followMove: ['from', 'to'],
  followAttack: ['from', 'to'],
  followControl: ['at'],
  followRepeat: ['hex'],
  followBolster: ['hex'],
  followShove: ['from', 'to'],
  followLift: ['hex'],
  followPlace: ['to'],
  followBuildFort: ['hex'],
};

/** The hexes this action actually names, in tap order. */
function hexPath(a: GameAction): HexId[] {
  const record = a as unknown as Record<string, string | undefined>;
  return (HEX_FIELDS[a.type] ?? []).map((f) => record[f]).filter((v): v is HexId => Boolean(v));
}

function startsWith(path: readonly HexId[], prefix: readonly HexId[]): boolean {
  return prefix.every((hex, i) => path[i] === hex);
}

const ACTION_LABEL: Record<string, { title: string; hint: string }> = {
  proclaim: { title: 'Огласить указ', hint: 'королевской монетой' },
  deploy: { title: 'Развернуть', hint: 'на свою локацию' },
  bolster: { title: 'Усилить', hint: 'добавить монету в стопку' },
  move: { title: 'Двинуть', hint: 'на соседнюю клетку' },
  attack: { title: 'Атаковать', hint: 'смежный отряд' },
  control: { title: 'Захватить', hint: 'поставить маркер' },
  tactic: { title: 'Тактика', hint: 'способность отряда' },
  claimInitiative: { title: 'Инициатива', hint: 'ходить первым в раунде' },
  unpoison: { title: 'Снять яд', hint: 'с отрядов этого типа' },
  returnDecoy: { title: 'Вернуть обманку', hint: 'уходит владельцу' },
  recruit: { title: 'Нанять', hint: 'монету из запаса' },
  pass: { title: 'Пас', hint: 'сбросить рубашкой вниз' },
};

/**
 * Tactics that are a longer version of the move action, and the hint that
 * replaces "на соседнюю клетку" when they are folded into it. `infiltrate` is
 * deliberately absent: walking onto a location and seizing it are both legal
 * with the same coin and the same destination, so that one stays a choice.
 */
const MERGED_TACTIC_HINT: Record<string, string> = {
  multiMove: 'одна или две клетки',
  chargeAttack: 'с ходу можно ударить',
  skirmish: 'две клетки, к врагу',
  moveThenPoison: 'после хода можно отравить',
  moveThenAttackFort: 'с ходу можно бить укрепление',
};

/** What a tactic does, in three words, for the button that starts it. */
const TACTIC_HINT: Record<string, string> = {
  rangedAttack: 'удар на расстоянии',
  grantManeuver: 'приказ соседнему отряду',
  maneuverEachUnit: 'манёвр каждым таким отрядом',
  royalRedeploy: 'перестановка королевской монетой',
  bolsterAllyFromSupply: 'усилить соседа из его запаса',
  controlThenProclaim: 'захват локации и указ',
  recruitThenManeuver: 'наём, затем манёвр',
  attackTwice: 'две атаки подряд',
  pushAlly: 'сдвинуть соседа и занять его клетку',
  poisonAtRange: 'отравить на расстоянии',
  infiltrate: 'войти на локацию и захватить её',
};

/**
 * Actions that happen where the unit already stands: nothing is aimed, so the
 * only question they can ask is *which* of your units does it — and with one
 * unit of that type on the board there is no question at all. Deploying is not
 * one of these: where the coin lands is a decision even when the board leaves
 * a single space for it.
 */
const IN_PLACE = new Set(['control', 'bolster']);

const ORDER = [
  'deploy',
  'bolster',
  'move',
  'attack',
  'control',
  'tactic',
  'proclaim',
  'unpoison',
  'returnDecoy',
  'recruit',
  'claimInitiative',
  'pass',
];

type Narrowed =
  | { kind: 'send'; action: GameAction }
  /**
   * Tap one of `hexes` to go a step further. `confirm`, when set, is an action
   * that needs no more taps — either because it is already complete (a Cavalry
   * that has moved and may now decline the charge) or because the one hex left
   * to tap would complete it (the Berserker paying for another maneuver).
   * `forced` tells those two apart: the first is a way to stop short, the
   * second is the only thing on offer, and the button has to say so.
   */
  | { kind: 'pick'; path: HexId[]; hexes: Set<HexId>; confirm: GameAction | null; forced: boolean };

/**
 * Works out what the player still has to choose.
 *
 * The move is never made on the player's behalf, however forced it is: the
 * last step is always a tap of the hex or of the button beside the hand. A
 * board that deploys by itself because one location was legal leaves the
 * player unsure of what just happened — and worse for the questions the game
 * asks unprompted, where a Berserker would silently pay a coin off its stack.
 * `send` is only ever reached through a tap the player has already made.
 */
function narrow(options: readonly GameAction[], path: readonly HexId[]): Narrowed {
  const viable = options.filter((a) => startsWith(hexPath(a), path));
  const ready = viable.filter((a) => hexPath(a).length === path.length);
  const rest = viable.filter((a) => hexPath(a).length > path.length);

  if (rest.length === 0) return { kind: 'send', action: ready[0] ?? viable[0]! };

  const hexes = new Set(rest.map((a) => hexPath(a)[path.length]!));
  if (hexes.size === 1 && ready.length === 0) {
    // Nothing to decide at this step; look past it — but only as far as the
    // step that finishes the action, which stays the player's to make.
    const next = narrow(options, [...path, [...hexes][0]!]);
    if (next.kind !== 'send') return next;
  }

  const only =
    hexes.size === 1 && rest.length === 1 && hexPath(rest[0]!).length === path.length + 1
      ? rest[0]!
      : null;
  const confirm = ready[0] ?? only;
  // `path` travels back out: steps skipped above were never tapped, and the
  // next tap has to continue from where this left off.
  return { kind: 'pick', path: [...path], hexes, confirm, forced: ready.length === 0 };
}

/**
 * What the button for an action that needs no more taps should say. A choice
 * the player is stopping short of is worded as such ("просто пойти"); the only
 * move on offer just names itself.
 */
function confirmLabel(a: GameAction, forced: boolean): string {
  switch (a.type) {
    case 'control':
    case 'followControl':
      return 'Захватить локацию';
    case 'deploy':
      return 'Развернуть сюда';
    case 'move':
    case 'followMove':
      return forced ? 'Пойти сюда' : 'Просто пойти';
    case 'followPlace':
      return 'Поставить сюда';
    case 'followShove':
      return 'Сдвинуть';
    case 'attack':
    case 'followAttack':
      return 'Атаковать';
    case 'bolster':
    case 'followBolster':
      return 'Усилить';
    case 'followRepeat':
      return 'Ещё манёвр';
    case 'followLift':
      return 'Снять с поля';
    case 'followBuildFort':
      return 'Возвести укрепление';
    case 'tactic':
      return forced ? 'Применить тактику' : 'Тактика';
    default:
      return 'Подтвердить';
  }
}

/** Pending steps answered by picking from a list rather than tapping a hex. */
const CHOICE_STEPS = new Set([
  'absorbHit',
  'burnSupply',
  'deceive',
  'buildFort',
  'bolsterSelf',
  'decreeRecruit',
  'decreeSpy',
  'decreeReinforce',
  'proclaim',
  'mustUseCoin',
]);

interface Targeting {
  options: GameAction[];
  /** Hexes tapped so far, in order. */
  chosen: HexId[];
  label: string;
  /**
   * The game is waiting on this — it came from a pending step, not from a coin
   * you picked up. Backing out of one of these rewinds the choice; it must not
   * throw the question away, or the turn strands with nothing on screen.
   */
  owed?: boolean;
}

export function GameScreen() {
  const { view } = useApp();
  useEffect(() => {
    lockPortrait(true);
    return () => lockPortrait(false);
  }, []);

  if (!view) return null;
  if (view.phase === 'ban' || view.phase === 'draft') return <Draft view={view} />;
  return <Table view={view} />;
}

// ── draft ──────────────────────────────────────────────────────────────────

function Draft({ view }: { view: GameView }) {
  const banning = view.phase === 'ban';
  // During the ban phase the seat to act is whoever still owes a strike, which
  // the server already encodes by only giving that seat legal actions.
  const yourTurn = view.legal.length > 0;
  const [preview, setPreview] = useState<UnitId | null>(null);
  const picked = view.players.map((p) => p.units);

  const waitingFor = view.players.find((p) => p.seat !== view.you)?.displayName ?? 'соперник';

  return (
    <div className="screen">
      <h2 style={{ fontSize: 24, margin: '4px 0 2px' }}>
        {banning ? 'Баны' : 'Драфт отрядов'}
      </h2>
      <div className="muted" style={{ marginBottom: 12 }}>
        {yourTurn
          ? banning
            ? 'Нажмите на отряд, чтобы прочитать карту, затем вычеркните его'
            : 'Нажмите на отряд, чтобы прочитать карту, затем возьмите его'
          : `${banning ? 'Вычёркивает' : 'Выбирает'} ${waitingFor}`}
      </div>

      <div className="scroll">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
          {view.draftPool.map((unit) => {
            const action = view.legal.find(
              (a) => (a.type === 'draft' || a.type === 'ban') && a.unit === unit,
            );
            return (
              <div
                key={unit}
                style={{
                  background: 'var(--color-surface)',
                  border: `1px solid ${
                    action
                      ? banning
                        ? 'var(--color-accent-700)'
                        : 'var(--color-accent-400)'
                      : 'var(--color-divider)'
                  }`,
                  borderRadius: 20,
                  padding: '12px 6px 8px',
                  display: 'grid',
                  placeItems: 'center',
                  gap: 6,
                }}
              >
                {/* Reading the card and choosing it are separate taps: on your
                    own turn the card is exactly what you need to see first. */}
                <button
                  onClick={() => setPreview(unit)}
                  style={{
                    background: 'none',
                    border: 'none',
                    padding: 0,
                    display: 'grid',
                    placeItems: 'center',
                    gap: 6,
                  }}
                >
                  <Coin unit={unit} size={48} />
                  <span style={{ fontSize: 11, lineHeight: 1.15, textAlign: 'center' }}>
                    {UNITS[unit].name.ru}
                  </span>
                  <span className="muted" style={{ fontSize: 10 }}>
                    {UNITS[unit].coins} монет
                  </span>
                </button>
                {action ? (
                  <button
                    className="btn btn--primary btn--block"
                    style={{ padding: '6px 10px', fontSize: 12, marginTop: 2 }}
                    onClick={() => {
                      haptic();
                      store.act(action);
                    }}
                  >
                    {banning ? 'Вычеркнуть' : 'Взять'}
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>

        {view.banned.length > 0 ? (
          <div style={{ marginTop: 18 }}>
            <div className="kicker">Вычеркнуто</div>
            <div className="row" style={{ gap: 8, marginTop: 6 }}>
              {view.banned.map((u) => (
                <button
                  key={u}
                  style={{ background: 'none', border: 'none', padding: 0, position: 'relative' }}
                  onClick={() => setPreview(u)}
                >
                  <Coin unit={u} size={40} dimmed />
                  <span
                    aria-hidden
                    style={{
                      position: 'absolute',
                      inset: 0,
                      display: 'grid',
                      placeItems: 'center',
                      color: 'var(--color-accent-700)',
                      fontSize: 30,
                      lineHeight: 1,
                    }}
                  >
                    ×
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <div className="stack" style={{ marginTop: 20, gap: 12 }}>
          {view.players.map((p) => (
            <div key={p.seat}>
              <div className="kicker">
                {p.seat === view.you ? 'Ваш набор' : p.displayName}
              </div>
              <div className="row" style={{ gap: 8, marginTop: 6, minHeight: 44 }}>
                {picked[p.seat]?.map((u) => (
                  <button key={u} style={{ background: 'none', border: 'none', padding: 0 }} onClick={() => setPreview(u)}>
                    <Coin
                      unit={u}
                      size={40}
                      faction={factionForSeat(p.seat)}
                      ring={p.seat === view.you ? 'var(--side-you)' : 'var(--side-foe)'}
                    />
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
        {banning
          ? 'Каждая сторона вычёркивает один отряд, затем разбор 1–2–2–2–1.'
          : 'Порядок выбора 1–2–2–2–1. Тот, кто выбирал вторым, ходит первым.'}
      </div>

      {preview ? <UnitCardModal unit={preview} onClose={() => setPreview(null)} /> : null}
    </div>
  );
}

// ── table ──────────────────────────────────────────────────────────────────

/** Total coins in a supply/removed tally. */
function countCoins(pile: Readonly<Partial<Record<UnitId, number>>>): number {
  return Object.values(pile).reduce((sum: number, n) => sum + (n ?? 0), 0);
}

function Table({ view }: { view: GameView }) {
  const [sheetCoin, setSheetCoin] = useState<number | null>(null);
  const [targeting, setTargeting] = useState<Targeting | null>(null);
  const [modal, setModal] = useState<'log' | 'discard' | 'removed' | 'decrees' | null>(null);
  const [pileSeat, setPileSeat] = useState(0);
  const [card, setCard] = useState<UnitId | null>(null);
  const markerCount = boardFor(view.size).controlMarkers;

  // `acting` and `turn` differ while a defender is deciding whether to soak a hit.
  const yourTurn = view.acting === view.you;
  // Nobody is typing on the other side: if the seat that owes a move is played
  // by the computer, it is thinking, and the wait needs saying out loud.
  const botThinking = view.winner === null && Boolean(view.players[view.acting]?.bot);
  const step = view.pending[view.pending.length - 1];
  const awaitingFollowUp = Boolean(step) && step?.kind !== 'mustUseCoin' && yourTurn;

  const canSkip = view.legal.some((a) => a.type === 'skip');

  /** The whole of the answer the pending step is waiting for. */
  function followUpTargeting(): Targeting | null {
    if (!step) return null;
    const followUps = view.legal.filter((a) => a.type !== 'skip');
    if (followUps.length === 0) return null;
    return {
      options: followUps,
      chosen: [],
      label: describeStep(step, view),
      owed: true,
    };
  }

  // A follow-up owes an answer right now: target straight away, no coin to pick.
  useEffect(() => {
    if (!awaitingFollowUp || (step && CHOICE_STEPS.has(step.kind))) return;
    setSheetCoin(null);
    setTargeting(followUpTargeting());
  }, [awaitingFollowUp, view.log.length, view.pending.length]);

  // Any new server state invalidates a half-built action.
  useEffect(() => {
    if (!awaitingFollowUp) setTargeting(null);
    setSheetCoin(null);
  }, [view.log.length, view.turn]);

  useEffect(() => {
    if (view.winner !== null) notify(view.winner === view.players[view.you]?.team ? 'success' : 'error');
  }, [view.winner]);

  const narrowed = targeting ? narrow(targeting.options, targeting.chosen) : null;
  const highlight = useMemo(
    () => (narrowed?.kind === 'pick' ? narrowed.hexes : new Set<HexId>()),
    [narrowed],
  );

  // While a question is about particular hexes, ring them: without this the
  // "take the hit?" sheet never says where on the board it is happening.
  const focus = useMemo(() => {
    const out = new Set<HexId>();
    if (!step || !yourTurn) return out;
    if (step.kind === 'absorbHit') {
      out.add(step.target);
      out.add(step.by.hex);
    }
    if (step.kind === 'maneuverUnit' || step.kind === 'maneuverUnitLimited') out.add(step.hex);
    if (step.kind === 'buildFort' || step.kind === 'bolsterSelf') out.add(step.hex);
    if (step.kind === 'heraldBolster' || step.kind === 'shoveEnemy') out.add(step.origin);
    return out;
  }, [step, yourTurn]);

  /**
   * An action that needs no more taps: offered as a button, not a hex. A
   * pending step whose only answer names no hex at all lands on `send` with
   * nothing to tap — that too is a button, or the question has no answer.
   */
  const confirm =
    narrowed === null ? null : narrowed.kind === 'pick' ? narrowed.confirm : narrowed.action;
  const confirmForced = narrowed?.kind === 'pick' ? narrowed.forced : true;

  function send(action: GameAction): void {
    haptic();
    store.act(action);
    setTargeting(null);
    setSheetCoin(null);
  }

  function pickHex(hex: HexId): void {
    if (!targeting || narrowed?.kind !== 'pick' || !narrowed.hexes.has(hex)) return;
    const chosen = [...narrowed.path, hex];
    const next = narrow(targeting.options, chosen);
    if (next.kind === 'send') {
      send(next.action);
      return;
    }
    haptic();
    setTargeting({ ...targeting, chosen });
  }

  function chooseAction(actions: GameAction[], label: string): void {
    // An action that names no hex at all goes straight through — the tap on
    // the sheet was the whole of it — and so does the only way to do an
    // in-place one. Anything aimed is shown on the board first, even when the
    // board leaves a single square to tap.
    if (actions.length === 1 && IN_PLACE.has(actions[0]!.type)) {
      send(actions[0]!);
      return;
    }
    const next = narrow(actions, []);
    if (next.kind === 'send') {
      send(next.action);
      return;
    }
    haptic();
    setSheetCoin(null);
    setTargeting({ options: actions, chosen: [], label });
  }

  const me = view.players[view.you]!;

  return (
    <div className="screen screen--game">
      <div className="game">
        <header className="row" style={{ gap: 8, padding: '2px 4px' }}>
          <button className="icon-btn" style={{ width: 28, height: 28 }} onClick={() => store.leaveLobby()} aria-label="Выйти">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.75" strokeLinecap="round">
              <path d="m15 5-7 7 7 7" />
            </svg>
          </button>
          <div style={{ fontFamily: 'var(--font-heading)', fontSize: 15 }}>Раунд {view.round}</div>
          <div className="grow" />
          {view.decrees.length > 0 ? (
            <button
              className="btn btn--secondary"
              style={{ padding: '5px 13px', fontSize: 12 }}
              onClick={() => setModal('decrees')}
            >
              Указы
            </button>
          ) : null}
          <button className="btn btn--secondary" style={{ padding: '5px 13px', fontSize: 12 }} onClick={() => setModal('log')}>
            Журнал
          </button>
          <div className={`turn-pill ${yourTurn ? 'turn-pill--you' : 'turn-pill--foe'}`}>
            <span
              className={botThinking ? 'thinking-dot' : undefined}
              style={{ width: 7, height: 7, borderRadius: '50%', background: 'currentColor' }}
            />
            {view.winner !== null
              ? view.winner === me.team
                ? 'Победа'
                : 'Поражение'
              : yourTurn
                ? view.turn === view.you
                  ? 'Ваш ход'
                  : 'Ваш ответ'
                : botThinking
                  ? 'Бот думает'
                  : 'Ход соперника'}
          </div>
        </header>

        <div className="game__body">
          <div className="rail">
            {view.players.map((p) => (
              <div key={p.seat} className={`player-card${view.turn === p.seat ? ' player-card--active' : ''}`}>
                <div className="row" style={{ gap: 8 }}>
                  <Avatar
                    name={p.displayName}
                    photoUrl={p.avatarUrl}
                    seat={p.seat}
                    size={28}
                    ring={p.seat === view.you ? 'var(--side-you)' : 'var(--side-foe)'}
                  />
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      <span>{p.displayName}</span>
                      {p.bot ? (
                        <span
                          title={`Компьютер, уровень: ${BOT_LEVEL_NAMES[p.bot].ru.toLowerCase()}`}
                          style={{
                            marginLeft: 6,
                            fontSize: 10,
                            letterSpacing: '0.08em',
                            textTransform: 'uppercase',
                            color: 'var(--color-accent-700)',
                          }}
                        >
                          бот
                        </span>
                      ) : null}
                      {p.hasInitiative ? (
                        <span title="Инициатива" aria-label="Инициатива">
                          {' ⚑'}
                        </span>
                      ) : null}
                    </div>
                    <div
                      className="markers"
                      title={`Победа — когда все ${markerCount} контрольных маркеров стоят на локациях. Осталось поставить ${p.markersRemaining}`}
                    >
                      <span className="markers__row">
                        {Array.from({ length: markerCount }).map((_, i) => (
                          <Marker key={i} team={p.team} placed={i >= p.markersRemaining} />
                        ))}
                      </span>
                      <span>ставить ещё {p.markersRemaining}</span>
                    </div>
                  </div>
                </div>

                <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                  {p.units.map((u) => (
                    <button
                      key={u}
                      onClick={() => setCard(u)}
                      title={UNITS[u].name.ru}
                      style={{ background: 'none', border: 'none', padding: 0 }}
                    >
                      <Coin
                        unit={u}
                        size={30}
                        faction={factionForSeat(p.seat)}
                        ring={p.seat === view.you ? 'var(--side-you)' : 'var(--side-foe)'}
                        badge={p.supply[u] ?? 0}
                      />
                    </button>
                  ))}
                </div>

                <div className="row" style={{ gap: 6, fontSize: 11, flexWrap: 'wrap' }}>
                  <span className="tag tag--green">мешок {p.bagCount}</span>
                  <button
                    className="tag tag--accent"
                    style={{ border: 'none' }}
                    onClick={() => {
                      setPileSeat(p.seat);
                      setModal('discard');
                    }}
                  >
                    сброс {p.discard.length}
                  </button>
                  <button
                    className="tag tag--muted"
                    style={{ border: 'none' }}
                    title="Монеты, выбитые с поля — они вышли из игры"
                    onClick={() => {
                      setPileSeat(p.seat);
                      setModal('removed');
                    }}
                  >
                    потери {countCoins(p.removed)}
                  </button>
                  {p.seat !== view.you ? <span className="tag tag--accent">рука {p.handCount}</span> : null}
                  {p.seat === view.you && view.fortSupply > 0 ? (
                    <span className="tag tag--green">укреплений {view.fortSupply}</span>
                  ) : null}
                </div>
              </div>
            ))}
          </div>

          <div className="game__board">
            <Board
              view={view}
              highlight={highlight}
              chosen={new Set(narrowed?.kind === 'pick' ? narrowed.path : [])}
              focus={focus}
              onPick={pickHex}
            />
          </div>

          <div className="hand">
            <div className="kicker">Рука</div>
            {(me.hand ?? []).length === 0 ? (
              <div className="hand__empty">монет нет</div>
            ) : null}
            {(me.hand ?? []).map((coin, index) => {
              const usable = yourTurn && !awaitingFollowUp && view.legal.some((a) => 'coin' in a && a.coin === index);
              return (
                <Coin
                  key={`${coin}-${index}`}
                  unit={coin}
                  size={58}
                  faction={factionForSeat(view.you)}
                  ring="var(--side-you)"
                  dimmed={!usable}
                  selected={sheetCoin === index}
                  onClick={usable ? () => setSheetCoin(index) : undefined}
                  title={coinName(coin).ru}
                />
              );
            })}

            {/*
              Some answers name no further hex — taking the location you are
              already standing on, declining a charge after the move, paying a
              coin for another maneuver. Those get a button, and so does the
              lone move left on the board, which is offered but never played
              on the player's behalf.
            */}
            {confirm ? (
              <button className="btn btn--primary hand__note" onClick={() => send(confirm)}>
                {confirmLabel(confirm, confirmForced)}
              </button>
            ) : null}

            {targeting ? (
              <button
                className="btn btn--secondary hand__note"
                onClick={() => setTargeting(targeting.owed ? followUpTargeting() : null)}
                disabled={targeting.owed && targeting.chosen.length === 0}
              >
                <span>
                  {targeting.label}
                  {!targeting.owed || targeting.chosen.length > 0 ? (
                    <span className="hand__note-cancel">
                      {targeting.owed ? 'начать заново' : 'отмена'}
                    </span>
                  ) : null}
                </span>
              </button>
            ) : null}

            {awaitingFollowUp && canSkip ? (
              <button
                className="btn btn--primary hand__note"
                onClick={() => {
                  haptic();
                  store.act({ type: 'skip' });
                  setTargeting(null);
                }}
              >
                Пропустить
              </button>
            ) : null}
          </div>
        </div>
      </div>

      {awaitingFollowUp && step && CHOICE_STEPS.has(step.kind) ? (
        <ChoiceSheet view={view} step={step} />
      ) : null}

      {sheetCoin !== null ? (
        <ActionSheet
          view={view}
          coinIndex={sheetCoin}
          onClose={() => setSheetCoin(null)}
          onChoose={chooseAction}
          onCard={setCard}
        />
      ) : null}

      {modal === 'log' ? (
        <Modal onClose={() => setModal(null)}>
          <h3 style={{ fontSize: 19, margin: '0 0 12px' }}>Журнал ходов</h3>
          <div>
            {[...view.log].reverse().slice(0, 40).map((entry, i) => (
              <div className="log-line" key={i}>
                <span className="log-dot" style={{ background: logColor(entry, view) }} />
                {formatLog(entry, view)}
              </div>
            ))}
          </div>
        </Modal>
      ) : null}

      {modal === 'decrees' ? (
        <Modal onClose={() => setModal(null)}>
          <h3 style={{ fontSize: 19, margin: '0 0 3px' }}>Королевские указы</h3>
          <div className="muted" style={{ fontSize: 11, marginBottom: 12 }}>
            Каждый указ доступен стороне один раз. Печатей осталось:{' '}
            {view.players[view.you]?.seals ?? 0}
          </div>
          <div className="stack" style={{ gap: 8 }}>
            {view.decrees.map((d) => {
              const mine = view.players[view.you]?.team;
              const usedByMe = mine !== undefined && d.seals.includes(mine);
              return (
                <div
                  key={d.id}
                  style={{
                    padding: '10px 13px',
                    borderRadius: 18,
                    background: usedByMe ? 'var(--color-neutral-200)' : 'var(--color-accent-2-100)',
                    opacity: usedByMe ? 0.6 : 1,
                  }}
                >
                  <div className="row" style={{ gap: 8 }}>
                    <span style={{ fontFamily: 'var(--font-heading)', fontSize: 15 }} className="grow">
                      {DECREES[d.id].name.ru}
                    </span>
                    {d.seals.map((team) => (
                      <Marker
                        key={team}
                        team={team}
                        size={16}
                        title={team === mine ? 'Ваша печать' : 'Печать соперника'}
                      />
                    ))}
                  </div>
                  <div className="muted" style={{ fontSize: 12 }}>{DECREES[d.id].text.ru}</div>
                </div>
              );
            })}
          </div>
        </Modal>
      ) : null}

      {modal === 'discard' ? (
        <DiscardModal view={view} seat={pileSeat} onClose={() => setModal(null)} />
      ) : null}

      {modal === 'removed' ? (
        <RemovedModal view={view} seat={pileSeat} onClose={() => setModal(null)} />
      ) : null}

      {card ? <UnitCardModal unit={card} onClose={() => setCard(null)} /> : null}

      {view.winner !== null ? (
        <Modal onClose={() => store.leaveLobby()} width={340}>
          <h3 style={{ fontSize: 24, margin: '0 0 6px' }}>
            {view.winner === me.team ? 'Победа' : 'Поражение'}
          </h3>
          <p className="muted">
            {view.winner === me.team
              ? 'Все шесть контрольных маркеров на поле.'
              : 'Соперник выставил все свои маркеры.'}
          </p>
          <button className="btn btn--primary btn--block" onClick={() => store.leaveLobby()}>
            К столам
          </button>
        </Modal>
      ) : null}
    </div>
  );
}

/** Whose unit is this, said the way you would say it out loud. */
function whose(view: GameView, seat: number): string {
  return seat === view.you ? 'ваш' : 'вражеский';
}

function describeStep(step: GameView['pending'][number], view: GameView): string {
  switch (step.kind) {
    case 'absorbHit': {
      const hit = view.units[step.target];
      const target = hit ? UNITS[hit.unit].name.ru : 'отряд';
      return `${UNITS[step.by.unit].name.ru} (${whose(view, step.by.seat)}) бьёт: ${target}`;
    }
    case 'maneuverUnit': {
      const stack = view.units[step.hex];
      const name = stack ? UNITS[stack.unit].name.ru : 'Отряд';
      // With a Footman tactic two of these queue up, so say which one is asked.
      return `${name}: манёвр`;
    }
    case 'optionalMove':
      return 'Мечник может пойти';
    case 'optionalRepeat':
      return 'Ещё манёвр за монету';
    case 'grantManeuver':
      return step.maneuver === 'move' ? 'Знаменосец: чужой ход' : 'Маршал: чужая атака';
    case 'mustUseCoin':
      return 'Сыграйте добранную монету';
    case 'decreeAttack':
      return step.costsCoin ? 'Жертва: чем атакуем' : 'Стража: чем атакуем';
    case 'decreeMove':
      return 'Марш: кого двигаем';
    case 'decreeRecruit':
      return 'Кого нанимаем';
    case 'decreeLift':
      return 'Кого снимаем с поля';
    case 'decreePlace':
      return 'Куда ставим';
    case 'decreeSpy':
      return 'Рука соперника';
    case 'decreeReinforce':
      return 'Какую монету вернуть';
    case 'heraldBolster':
      return 'Герольд: кого усилить';
    case 'shoveEnemy':
      return 'Знаменосец: кого оттеснить';
    case 'maneuverUnitLimited':
      return 'Ход или атака';
    case 'proclaim':
      return 'Огласите указ';
    case 'buildFort':
      return 'Возвести укрепление?';
    case 'bolsterSelf':
      return 'Усилить из запаса?';
    case 'burnSupply':
      return 'Изъять монету из запаса?';
    case 'deceive':
      return 'Кому подбросить обманку?';
  }
}

function ChoiceSheet({ view, step }: { view: GameView; step: GameView['pending'][number] }) {
  const options = view.legal.filter((a) => a.type !== 'skip');
  const canSkip = view.legal.some((a) => a.type === 'skip');
  const foe = step.kind === 'decreeSpy' ? view.players[step.target] : undefined;

  /** The coin each answer is about, drawn so the list reads at a glance. */
  function icon(a: GameAction): CoinId | null {
    switch (a.type) {
      case 'followRecruit':
      case 'followReinforce':
      case 'followBurn':
        return a.unit;
      case 'followSpy':
        return foe?.hand?.[a.index] ?? null;
      case 'followAbsorb': {
        if (a.source === 'wagon') return a.hex ? (view.units[a.hex]?.unit ?? null) : null;
        if (a.source === 'supply') {
          return step.kind === 'absorbHit' ? (view.units[step.target]?.unit ?? null) : null;
        }
        return null;
      }
      default:
        return null;
    }
  }

  /** Whose colours that coin is in. */
  function iconSeat(a: GameAction): number {
    if (a.type === 'followBurn') return step.kind === 'burnSupply' ? step.owner : view.you;
    if (a.type === 'followSpy') return foe?.seat ?? view.you;
    return view.you;
  }

  function label(a: GameAction): { title: string; hint?: string } {
    switch (a.type) {
      case 'followRecruit':
        return { title: UNITS[a.unit].name.ru, hint: `в запасе ${view.players[view.you]?.supply[a.unit] ?? 0}` };
      case 'followReinforce':
        return { title: UNITS[a.unit].name.ru, hint: 'вернуть в запас' };
      case 'followProclaim':
        return { title: DECREES[a.decree].name.ru, hint: DECREES[a.decree].text.ru };
      case 'followAbsorb':
        if (a.source === 'supply') return { title: 'Монетой из запаса', hint: 'отряд не теряет монету' };
        if (a.source === 'wagon') return { title: 'Боевым фургоном', hint: 'монету теряет фургон' };
        return { title: 'Обманной монетой', hint: 'атака не снимает монету' };
      case 'followBurn':
        return { title: UNITS[a.unit].name.ru, hint: 'монета выбывает из игры' };
      case 'followDeceive':
        return { title: view.players[a.seat]?.displayName ?? 'Соперник', hint: 'обманка в его сброс' };
      case 'followBuildFort':
        return { title: 'Возвести укрепление', hint: 'из запаса' };
      case 'followBolster':
        return { title: 'Усилить', hint: 'монетой из запаса' };
      case 'followSpy': {
        const coin = foe?.hand?.[a.index];
        return { title: coin ? coinName(coin).ru : '—', hint: 'сбросить' };
      }
      default:
        return { title: a.type };
    }
  }

  return (
    <Sheet onClose={() => canSkip && store.act({ type: 'skip' })}>
      <h3 style={{ fontSize: 19, margin: '0 0 4px' }}>{describeStep(step, view)}</h3>
      {step.kind === 'absorbHit' ? <AttackLine view={view} step={step} /> : null}
      {step.kind === 'decreeSpy' ? (
        <div className="row" style={{ gap: 8, margin: '8px 0 4px' }}>
          {(foe?.hand ?? []).map((coin, i) => (
            <Coin key={`${coin}-${i}`} unit={coin} size={44} faction={factionForSeat(foe!.seat)} />
          ))}
        </div>
      ) : null}
      <div className="action-list">
        {options.map((a, i) => {
          const l = label(a);
          const art = icon(a);
          return (
            <button
              key={i}
              className="action-btn"
              onClick={() => {
                haptic();
                store.act(a);
              }}
            >
              {art ? <Coin unit={art} size={34} faction={factionForSeat(iconSeat(a))} /> : null}
              <span className="action-btn__text">
                {l.title}
                {l.hint ? <span className="action-btn__hint">{l.hint}</span> : null}
              </span>
            </button>
          );
        })}
      </div>
      {canSkip ? (
        <button
          className="btn btn--secondary btn--block"
          style={{ marginTop: 10 }}
          onClick={() => store.act({ type: 'skip' })}
        >
          {/* Declining a soak is not "skipping" — it costs the stack a coin. */}
          {step.kind === 'absorbHit' ? 'Принять потерю' : 'Пропустить'}
        </button>
      ) : null}
    </Sheet>
  );
}

/** Who is hitting whom, spelled out with both coins. */
function AttackLine({
  view,
  step,
}: {
  view: GameView;
  step: Extract<GameView['pending'][number], { kind: 'absorbHit' }>;
}) {
  const hit = view.units[step.target];
  return (
    <div className="row" style={{ gap: 10, margin: '10px 0 2px' }}>
      <Coin unit={step.by.unit} size={40} faction={factionForSeat(step.by.seat)} ring="var(--side-foe)" />
      <span style={{ fontSize: 18, color: 'var(--color-accent-700)' }} aria-hidden>
        →
      </span>
      {hit ? (
        <Coin
          unit={hit.unit}
          size={40}
          faction={factionForSeat(hit.seat)}
          ring="var(--side-you)"
          badge={hit.coins}
        />
      ) : null}
      <span className="muted" style={{ fontSize: 12 }}>
        {hit && hit.coins > 1
          ? `Без защиты стопка потеряет монету: останется ${hit.coins - 1}`
          : 'Без защиты отряд уходит с поля'}
      </span>
    </div>
  );
}

function ActionSheet({
  view,
  coinIndex,
  onClose,
  onChoose,
  onCard,
}: {
  view: GameView;
  coinIndex: number;
  onClose(): void;
  onChoose(actions: GameAction[], label: string): void;
  onCard(unit: UnitId): void;
}) {
  const coin = view.players[view.you]?.hand?.[coinIndex] as CoinId | undefined;
  const [sub, setSub] = useState<null | 'recruit' | 'proclaim'>(null);
  if (!coin) return null;

  const mine = view.legal.filter((a) => 'coin' in a && a.coin === coinIndex);
  const groups = new Map<string, GameAction[]>();
  for (const a of mine) {
    const list = groups.get(a.type) ?? [];
    list.push(a);
    groups.set(a.type, list);
  }
  const def = isUnitId(coin) ? UNITS[coin] : null;

  /*
   * Several tactics are nothing but a longer move — go two spaces, or go one
   * and strike. Splitting them off into a separate "Tactic" entry made the
   * player commit to the short version before seeing the long one. Offered
   * together, tapping the far hex simply picks the tactic.
   */
  const merged = def?.tactic ? MERGED_TACTIC_HINT[def.tactic.kind] : undefined;
  if (merged && groups.has('tactic')) {
    groups.set('move', [...(groups.get('move') ?? []), ...groups.get('tactic')!]);
    groups.delete('tactic');
  }

  return (
    <Sheet onClose={onClose}>
      <div className="row" style={{ alignItems: 'flex-start', gap: 14 }}>
        <Coin unit={coin} size={60} faction={factionForSeat(view.you)} />
        <div className="grow">
          <h3 style={{ fontSize: 20, margin: 0 }}>{coinName(coin).ru}</h3>
          <div className="muted" style={{ fontSize: 12 }}>
            {def
              ? `${coins(view.players[view.you]?.supply[coin as UnitId] ?? 0)} в запасе · ${def.coins} в игре`
              : coin === 'royal'
                ? view.decrees.length > 0
                  ? 'Действия рубашкой вниз и оглашение указа'
                  : 'Только действия рубашкой вниз'
                : 'Подброшена соперником — только рубашкой вниз или вернуть'}
          </div>
          {def?.text.tactic ? (
            <div style={{ fontSize: 12, marginTop: 4 }}>{def.text.tactic.ru}</div>
          ) : null}
        </div>
        {def ? (
          <button className="btn btn--secondary" style={{ padding: '6px 12px', fontSize: 12 }} onClick={() => onCard(coin as UnitId)}>
            Карта
          </button>
        ) : null}
      </div>

      {sub === 'recruit' ? (
        <div className="action-list">
          {(groups.get('recruit') ?? []).map((a) => {
            const unit = (a as Extract<GameAction, { type: 'recruit' }>).unit;
            return (
              <button key={unit} className="action-btn" onClick={() => onChoose([a], 'Наём')}>
                <Coin unit={unit} size={34} faction={factionForSeat(view.you)} />
                <span className="action-btn__text">
                  {UNITS[unit].name.ru}
                  <span className="action-btn__hint">
                    осталось {view.players[view.you]?.supply[unit] ?? 0}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      ) : sub === 'proclaim' ? (
        <div className="action-list">
          {(groups.get('proclaim') ?? []).map((a) => {
            const decree = (a as Extract<GameAction, { type: 'proclaim' }>).decree;
            return (
              <button key={decree} className="action-btn" onClick={() => onChoose([a], 'Указ')}>
                <span className="action-btn__text">
                  {DECREES[decree].name.ru}
                  <span className="action-btn__hint">{DECREES[decree].text.ru}</span>
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="action-list">
          {ORDER.filter((type) => groups.has(type)).map((type) => {
            const label = ACTION_LABEL[type]!;
            const kind = def?.tactic?.kind;
            const hint =
              type === 'move' && merged
                ? merged
                : type === 'tactic' && kind
                  ? (TACTIC_HINT[kind] ?? label.hint)
                  : label.hint;
            return (
              <button
                key={type}
                className="action-btn"
                onClick={() => {
                  if (type === 'recruit' || type === 'proclaim') setSub(type);
                  else onChoose(groups.get(type)!, label.title);
                }}
              >
                <span className="action-btn__text">
                  {label.title}
                  <span className="action-btn__hint">{hint}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </Sheet>
  );
}

/**
 * Coins knocked off the board. The rulebook puts them back in the box rather
 * than in the discard pile, so they are gone for good — unless Nobility is in
 * play, where the Reinforce decree calls one back.
 */
function RemovedModal({ view, seat, onClose }: { view: GameView; seat: number; onClose(): void }) {
  const p = view.players[seat]!;
  const gone = Object.entries(p.removed).filter(([, n]) => (n ?? 0) > 0) as [UnitId, number][];
  const reinforce = view.decrees.some((d) => d.id === 'reinforce');
  return (
    <Modal onClose={onClose}>
      <h3 style={{ fontSize: 19, margin: '0 0 3px' }}>
        {seat === view.you ? 'Ваши потери' : `Потери: ${p.displayName}`}
      </h3>
      <div className="muted" style={{ fontSize: 11, marginBottom: 12 }}>
        {reinforce
          ? 'Эти монеты выбыли из игры. Указ «Подкрепление» возвращает одну из них в запас.'
          : 'Эти монеты выбиты с поля и в игру не вернутся.'}
      </div>
      <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>
        {gone.map(([unit, n]) => (
          <div key={unit} style={{ width: 74, display: 'grid', placeItems: 'center', gap: 4 }}>
            <Coin
              unit={unit}
              size={48}
              faction={factionForSeat(seat)}
              ring={seat === view.you ? 'var(--side-you)' : 'var(--side-foe)'}
              badge={n}
              dimmed
            />
            <span className="muted" style={{ fontSize: 11, textAlign: 'center' }}>
              {UNITS[unit].name.ru}
            </span>
          </div>
        ))}
        {gone.length === 0 ? <div className="muted">Пока никого</div> : null}
      </div>
    </Modal>
  );
}

function DiscardModal({ view, seat, onClose }: { view: GameView; seat: number; onClose(): void }) {
  const p = view.players[seat]!;
  const counts = new Map<string, number>();
  let hidden = 0;
  for (const d of p.discard) {
    if (d.coin === null) hidden++;
    else counts.set(d.coin, (counts.get(d.coin) ?? 0) + 1);
  }
  return (
    <Modal onClose={onClose}>
      <h3 style={{ fontSize: 19, margin: '0 0 3px' }}>
        {seat === view.you ? 'Ваш сброс' : `Сброс: ${p.displayName}`}
      </h3>
      <div className="muted" style={{ fontSize: 11, marginBottom: 12 }}>
        Монеты вернутся в мешок, когда он опустеет.
      </div>
      <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>
        {[...counts].map(([unit, n]) => (
          <div key={unit} style={{ width: 74, display: 'grid', placeItems: 'center', gap: 4 }}>
            <Coin
              unit={unit as CoinId}
              size={48}
              faction={factionForSeat(seat)}
              ring={seat === view.you ? 'var(--side-you)' : 'var(--side-foe)'}
              badge={n}
            />
            <span className="muted" style={{ fontSize: 11, textAlign: 'center' }}>
              {coinName(unit as CoinId).ru}
            </span>
          </div>
        ))}
        {hidden > 0 ? (
          <div style={{ width: 74, display: 'grid', placeItems: 'center', gap: 4 }}>
            <div
              style={{
                width: 48,
                height: 48,
                borderRadius: '50%',
                background: 'var(--color-neutral-400)',
                display: 'grid',
                placeItems: 'center',
                color: 'var(--color-bg)',
                fontFamily: 'var(--font-heading)',
              }}
            >
              {hidden}
            </div>
            <span className="muted" style={{ fontSize: 11, textAlign: 'center' }}>рубашкой вниз</span>
          </div>
        ) : null}
        {p.discard.length === 0 ? <div className="muted">Пусто</div> : null}
      </div>
    </Modal>
  );
}
