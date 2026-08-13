/**
 * Render smoke tests. These drive the real components with a real game state
 * built by the engine, so a crash in the board, the draft or the action sheet
 * shows up here rather than on a phone.
 */

// @vitest-environment jsdom

import {
  UNITS,
  boardFor,
  type GameAction,
  type GameState,
} from '@wc/shared';
import {
  actingSeat,
  applyAction,
  createGame,
  legalActions,
  viewFor,
} from '@wc/shared/rules';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { store } from './net.js';

class FakeSocket {
  static last: FakeSocket | null = null;
  static OPEN = 1;
  readyState = 1;
  sent: string[] = [];
  private listeners: Record<string, ((e: unknown) => void)[]> = {};
  constructor(public url: string) {
    FakeSocket.last = this;
  }
  addEventListener(type: string, cb: (e: unknown) => void) {
    (this.listeners[type] ??= []).push(cb);
  }
  close() {
    this.readyState = 3;
  }
  send(data: string) {
    this.sent.push(data);
  }
  emit(type: string, event: unknown) {
    for (const cb of this.listeners[type] ?? []) cb(event);
  }
  deliver(msg: unknown) {
    // Server pushes arrive outside React's event loop; act() flushes them.
    act(() => this.emit('message', { data: JSON.stringify(msg) }));
  }
}

function newGame(): GameState {
  return createGame({
    id: 'ui',
    size: 2,
    seed: 5,
    seats: [
      { userId: 'me', displayName: 'Артём К' },
      { userId: 'foe', displayName: 'Марина С' },
    ],
  });
}

function pushView(state: GameState, seat = 0): void {
  FakeSocket.last!.deliver({
    t: 'game.view',
    view: viewFor(state, seat, legalActions(state, seat)),
  });
}

beforeEach(() => {
  store.reset();
  vi.stubGlobal('WebSocket', FakeSocket);
  localStorage.clear();
  act(() => {
    store.connect();
    FakeSocket.last!.emit('open', {});
  });
  FakeSocket.last!.deliver({
    t: 'auth.ok',
    user: { userId: 'me', displayName: 'Артём К' },
    lobby: null,
    sets: ['base', 'nobility', 'siege', 'nightfall'],
    bots: ['easy'],
  });
});

afterEach(() => {
  cleanup();
  store.reset();
  vi.unstubAllGlobals();
});

describe('menu', () => {
  it('shows the hub and moves between screens', () => {
    render(<App />);
    expect(screen.getByText('Сундук войны')).toBeTruthy();

    fireEvent.click(screen.getByText('Создать стол'));
    expect(screen.getByText('Новый стол')).toBeTruthy();

    // The server said all four sets are runnable, so the toggles must be live.
    expect(screen.getByText('Ночная вылазка')).toBeTruthy();
    fireEvent.click(screen.getByText('Осада'));

    // Pick the elimination draft before creating, so the mode travels with it.
    fireEvent.click(screen.getByText('Драфт с банами'));
    fireEvent.click(screen.getByText('Собрать стол'));
    const sent = FakeSocket.last!.sent.map((s) => JSON.parse(s) as { t: string; draftMode?: string });
    const create = sent.find((m) => m.t === 'lobby.create') as
      | { draftMode?: string; sets?: string[] }
      | undefined;
    expect(create?.draftMode).toBe('ban');
    expect(create?.sets).toEqual(['siege']);
  });

  it('renders a lobby with its code and seats', () => {
    render(<App />);
    FakeSocket.last!.deliver({
      t: 'lobby.state',
      lobby: {
        code: 'ABC123',
        name: 'Вороний брод',
        host: 'Артём К',
        hostId: 'me',
        size: 2,
        draftMode: 'draft',
        sets: ['base'],
        locked: false,
        members: [{ userId: 'me', displayName: 'Артём К' }],
        started: false,
      },
    });
    expect(screen.getByText('ABC123')).toBeTruthy();
    expect(screen.getByText('Ждём 1')).toBeTruthy();
  });
});

describe('playing the computer', () => {
  it('offers a bot game and asks the server for one', () => {
    render(<App />);
    fireEvent.click(screen.getByText('Играть с ботом'));
    expect(screen.getByText('Игра с ботом')).toBeTruthy();

    // Only the levels the server said it can play are pickable: medium and
    // hard are shown, but greyed out and unusable.
    expect(screen.getAllByText('пока не готов')).toHaveLength(2);
    expect((screen.getByText('Средний').closest('button') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText('Осада'));
    fireEvent.click(screen.getByText('Начать партию'));

    const sent = FakeSocket.last!.sent.map((x) => JSON.parse(x) as { t: string });
    const create = sent.find((m) => m.t === 'lobby.create') as
      | { vsBot?: string; sets?: string[]; size?: number }
      | undefined;
    expect(create?.vsBot).toBe('easy');
    expect(create?.sets).toEqual(['siege']);
    expect(create?.size).toBe(2);
  });

  it('says the computer is thinking while it is the computer’s turn', () => {
    render(<App />);
    const game = createGame({
      id: 'bot-ui',
      size: 2,
      seed: 5,
      draftMode: 'random',
      seats: [
        { userId: 'me', displayName: 'Артём К' },
        { userId: 'bot:easy', displayName: 'Бот (простой)', bot: 'easy' },
      ],
    });
    // Hand the turn to the computer.
    game.turn = 1;
    pushView(game);

    expect(screen.getByText('бот')).toBeTruthy();
    expect(screen.getByText('Бот думает')).toBeTruthy();

    // On our own turn the pill goes back to naming the player's move.
    game.turn = 0;
    pushView(game);
    expect(screen.queryByText('Бот думает')).toBeNull();
    expect(screen.getByText('Ваш ход')).toBeTruthy();
  });
});

describe('draft', () => {
  it('keeps the strike button in place through the whole ban phase', () => {
    render(<App />);
    const game = createGame({
      id: 'ban-ui',
      size: 2,
      seed: 5,
      draftMode: 'ban',
      seats: [
        { userId: 'me', displayName: 'Артём К' },
        { userId: 'foe', displayName: 'Марина С' },
      ],
    });
    pushView(game, 0);

    const strikes = () => screen.queryAllByText('Убрать').map((el) => el.closest('button')!);
    const pool = () => document.querySelectorAll('.screen .scroll > div:first-child > div').length;

    // Your ban: every card in the pool offers the button.
    expect(strikes()).toHaveLength(game.draftPool.length);
    expect(strikes().some((b) => b.disabled)).toBe(false);

    // Theirs: the buttons stay, disabled, and the pool keeps its shape.
    const before = pool();
    applyAction(game, 0, legalActions(game, 0).find((a) => a.type === 'ban')!);
    pushView(game, 0);
    expect(strikes()).toHaveLength(game.draftPool.length);
    expect(strikes().every((b) => b.disabled)).toBe(true);
    expect(pool()).toBe(before - 1); // the struck card left the pool, as it must
  });

  it('keeps the take button in place while the other side is choosing', () => {
    render(<App />);
    const game = newGame();
    // Not your turn: the buttons stay, greyed, so nothing on screen moves when
    // the turn comes back.
    game.turn = 1;
    pushView(game, 0);

    const buttons = screen.getAllByText('Взять').map((el) => el.closest('button')!);
    expect(buttons).toHaveLength(game.draftPool.length);
    expect(buttons.every((b) => b.disabled)).toBe(true);

    game.turn = 0;
    pushView(game, 0);
    const live = screen.getAllByText('Взять').map((el) => el.closest('button')!);
    expect(live).toHaveLength(game.draftPool.length);
    expect(live.some((b) => b.disabled)).toBe(false);
  });

  it('opens the card on a tap and drafts only from the button', () => {
    render(<App />);
    const game = newGame();
    pushView(game);

    expect(screen.getByText('Драфт отрядов')).toBeTruthy();

    // Tapping the card itself reads it — during your own turn especially, that
    // is the whole point of the screen.
    const first = game.draftPool[0]!;
    const label = screen.getAllByText(/монет$/)[0]!;
    fireEvent.click(label.closest('button')!);
    expect(document.querySelector('.modal h3')?.textContent).toBe(UNITS[first].name.ru);
    expect(
      FakeSocket.last!.sent.some((s) => (JSON.parse(s) as { t: string }).t === 'game.action'),
    ).toBe(false);

    fireEvent.click(screen.getAllByText('Взять')[0]!);
    const sent = FakeSocket.last!.sent.map((s) => JSON.parse(s) as { t: string; action?: { unit: string } });
    const pick = sent.find((m) => m.t === 'game.action');
    expect(pick?.action?.unit).toBe(first);
  });
});

describe('table', () => {
  function playedGame(): GameState {
    const game = newGame();
    while (game.phase === 'draft') {
      const legal = legalActions(game, game.turn);
      const draft = legal.find((a) => a.type === 'draft')!;
      applyAction(game, game.turn, draft);
    }
    return game;
  }

  it('draws the board, both players and the hand', () => {
    const game = playedGame();
    game.turn = 0;
    render(<App />);
    pushView(game);

    expect(screen.getByLabelText('Поле')).toBeTruthy();
    expect(screen.getByText('Артём К')).toBeTruthy();
    expect(screen.getByText('Марина С')).toBeTruthy();
    expect(screen.getByText('Ваш ход')).toBeTruthy();
    expect(screen.getByText('Рука')).toBeTruthy();
  });

  it('opens the action sheet for a coin and offers real actions', () => {
    const game = playedGame();
    game.turn = 0;
    render(<App />);
    pushView(game);

    const hand = screen.getByText('Рука').parentElement!;
    const coin = within(hand).getAllByRole('button')[0]!;
    fireEvent.click(coin);

    // Facedown actions are always available, so the sheet is never empty.
    expect(screen.getByText('Пас')).toBeTruthy();
    fireEvent.click(screen.getByText('Пас'));
    const sent = FakeSocket.last!.sent.map((s) => JSON.parse(s) as { t: string; action?: { type: string } });
    expect(sent.some((m) => m.t === 'game.action' && m.action?.type === 'pass')).toBe(true);
  });

  it('highlights legal hexes when an action needs a target', () => {
    const game = playedGame();
    game.turn = 0;
    // Guarantee a deploy is on the table.
    game.players[0]!.hand = [game.players[0]!.units[0]!, 'royal', 'royal'];
    render(<App />);
    pushView(game);

    const hand = screen.getByText('Рука').parentElement!;
    fireEvent.click(within(hand).getAllByRole('button')[0]!);
    fireEvent.click(screen.getByText('Развернуть'));

    const board = screen.getByLabelText('Поле');
    expect(board.querySelectorAll('.hex--legal').length).toBe(2); // two starting locations
  });

  it('never deploys by itself, even with one location left to deploy to', () => {
    const game = playedGame();
    game.turn = 0;
    game.players[0]!.hand = [game.players[0]!.units[0]!, 'royal', 'royal'];
    // Block one of the two starting locations: a single legal destination is
    // left, and the game must still wait to be told to use it.
    const [, blocked] = Object.entries(game.control)
      .filter(([, team]) => team === 0)
      .map(([hex]) => hex);
    game.units[blocked!] = { unit: game.players[0]!.units[1]!, team: 0, seat: 0, coins: 1 };

    render(<App />);
    pushView(game);

    const hand = screen.getByText('Рука').parentElement!;
    fireEvent.click(within(hand).getAllByRole('button')[0]!);
    fireEvent.click(screen.getByText('Развернуть'));

    // Nothing was sent: the one place it could go is lit up and waiting.
    const board = screen.getByLabelText('Поле');
    expect(board.querySelectorAll('.hex--legal').length).toBe(1);
    expect(
      FakeSocket.last!.sent.some((s) => (JSON.parse(s) as { t: string }).t === 'game.action'),
    ).toBe(false);

    // Either the hex or the button beside the hand plays it.
    fireEvent.click(screen.getByText('Развернуть сюда'));
    const sent = FakeSocket.last!.sent.map((s) => JSON.parse(s) as { t: string; action?: GameAction });
    const deploy = sent.find((m) => m.t === 'game.action')?.action;
    expect(deploy?.type).toBe('deploy');
  });

  it('marks a held location so a unit standing on it cannot hide it', () => {
    const game = playedGame();
    game.turn = 0;
    const held = Object.keys(game.control)[0]!;
    game.units[held] = { unit: game.players[0]!.units[0]!, team: 0, seat: 0, coins: 1 };

    render(<App />);
    pushView(game);

    const board = screen.getByLabelText('Поле');
    // The rim in the holder's colour is drawn round every held location…
    expect(board.querySelectorAll('polygon.hex-control').length).toBe(
      Object.keys(game.control).length,
    );
    // …and on the occupied one it comes after the coin, so the coin cannot
    // bury it the way the printed marker underneath is buried.
    const rim = board.querySelector(`g[data-control="${held}"]`)!;
    const coin = board.querySelector(`g[data-unit="${held}"]`)!;
    expect(coin.compareDocumentPosition(rim) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('claims and bolsters in place, but asks which unit when there are two', () => {
    const game = duel(
      ['knight', 'footman', 'scout', 'cavalry'],
      ['swordsman', 'archer', 'ensign', 'pikeman'],
    );
    game.turn = 0;
    // One Knight, standing on a location nobody holds: claiming it and
    // bolstering it are each the only thing that coin can do there.
    const free = boardFor(2).locations.find((hex) => game.control[hex] === undefined)!;
    game.units[free] = { unit: 'knight', team: 0, seat: 0, coins: 1 };
    game.players[0]!.hand = ['knight', 'footman', 'footman'];

    render(<App />);
    pushView(game);

    const hand = screen.getByText('Рука').parentElement!;
    fireEvent.click(within(hand).getAllByRole('button')[0]!);
    fireEvent.click(screen.getByText('Захватить'));

    // Straight through: there was never a second location to mean.
    const sent = () =>
      FakeSocket.last!.sent.map((s) => JSON.parse(s) as { t: string; action?: GameAction });
    expect(sent().find((m) => m.t === 'game.action')?.action).toMatchObject({
      type: 'control',
      at: free,
    });

    // Two Footmen deployed, and the coin has to say which one it is feeding.
    settle(game);
    game.turn = 0;
    game.units['5,2'] = { unit: 'footman', team: 0, seat: 0, coins: 1 };
    game.units['4,2'] = { unit: 'footman', team: 0, seat: 0, coins: 1 };
    pushView(game);

    const before = sent().filter((m) => m.t === 'game.action').length;
    fireEvent.click(within(screen.getByText('Рука').parentElement!).getAllByRole('button')[1]!);
    fireEvent.click(screen.getByText('Усилить'));
    expect(sent().filter((m) => m.t === 'game.action').length).toBe(before);
    expect(screen.getByLabelText('Поле').querySelectorAll('.hex--legal').length).toBe(2);
  });

  it('draws the walls over both the garrison and the control rim', () => {
    const game = playedGame();
    game.turn = 0;
    const held = Object.keys(game.control)[0]!;
    game.units[held] = { unit: game.players[0]!.units[0]!, team: 0, seat: 0, coins: 1 };
    game.forts[held] = true;

    render(<App />);
    pushView(game);

    const board = screen.getByLabelText('Поле');
    const fort = board.querySelector('g.fort')!;
    for (const under of [`g[data-unit="${held}"]`, `g[data-control="${held}"]`]) {
      const el = board.querySelector(under)!;
      expect(el.compareDocumentPosition(fort) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it('marks a poisoned unit on the board', () => {
    const game = duel(
      ['saboteur', 'knight', 'scout', 'cavalry'],
      ['swordsman', 'archer', 'ensign', 'pikeman'],
    );
    game.turn = 0;
    game.units['5,2'] = { unit: 'swordsman', team: 1, seat: 1, coins: 1 };

    render(<App />);
    pushView(game);
    const board = screen.getByLabelText('Поле');
    expect(board.querySelector('g[data-badge="5,2"] .poisoned')).toBeNull();

    game.units['5,2']!.poisonedBy = 'saboteur';
    pushView(game);
    const mark = board.querySelector('g[data-badge="5,2"] .poisoned')!;
    expect(mark).not.toBeNull();
    expect(mark.querySelector('title')!.textContent).toContain('Отравлен');
  });

  it('keeps location knots and unit discs from swallowing taps', () => {
    const game = playedGame();
    game.turn = 0;
    // A unit sitting on a location: both decorations stack over the hex.
    const loc = Object.keys(game.control)[0]!;
    game.units[loc] = { unit: game.players[0]!.units[0]!, team: 0, seat: 0, coins: 2 };
    render(<App />);
    pushView(game);

    const board = screen.getByLabelText('Поле');
    // Every circle/path drawn over the grid must sit inside a `.hex-decor`
    // group, otherwise it steals the click meant for the hex below it.
    const decorated = [...board.querySelectorAll('circle, text')];
    expect(decorated.length).toBeGreaterThan(0);
    for (const el of decorated) expect(el.closest('.hex-decor')).not.toBeNull();
    expect(board.querySelectorAll('polygon.hex').length).toBe(37);
  });

  it('turns the board so your own bases are the near ones', () => {
    const game = playedGame();
    game.turn = 0;

    /** Mean height of the hexes a team starts on, as drawn. */
    function height(board: Element, team: number): number {
      const mine = Object.entries(game.control)
        .filter(([, t]) => t === team)
        .map(([hex]) => hex);
      const ys = mine.map((hex) => {
        const points = board.querySelector(`polygon[data-hex="${hex}"]`)!.getAttribute('points')!;
        return points.split(' ').map((p) => Number(p.split(',')[1]))[0]!;
      });
      return ys.reduce((a, b) => a + b, 0) / ys.length;
    }

    // Seat 0 starts along the board's top edge, so its own view is turned
    // around; seat 1 sees the board the way it is printed. Either way your own
    // markers end up nearer the bottom of the screen than your opponent's.
    for (const seat of [0, 1]) {
      cleanup();
      render(<App />);
      pushView(game, seat);
      const board = screen.getByLabelText('Поле');
      expect(height(board, seat)).toBeGreaterThan(height(board, 1 - seat));
    }
  });

  it('asks for a maneuver with every Footman, one after the other', () => {
    // The Footman's tactic moves each Footman on the board, so playing it with
    // two deployed owes two answers — the second must be asked for too.
    const game = createGame({
      id: 'ui',
      size: 2,
      seed: 5,
      seats: [
        { userId: 'me', displayName: 'Артём К' },
        { userId: 'foe', displayName: 'Марина С' },
      ],
      fixedUnits: [
        ['footman', 'knight', 'scout', 'cavalry'],
        ['swordsman', 'archer', 'ensign', 'pikeman'],
      ],
    });
    game.turn = 0;
    game.units['5,2'] = { unit: 'footman', team: 0, seat: 0, coins: 1 };
    game.units['4,2'] = { unit: 'footman', team: 0, seat: 0, coins: 1 };
    game.players[0]!.hand = ['footman', 'footman', 'footman'];

    render(<App />);
    pushView(game);

    /** Plays whatever the client just sent, and pushes the new state back. */
    function settle(): void {
      const sent = FakeSocket.last!.sent.map((s) => JSON.parse(s) as { t: string; action?: GameAction });
      const last = [...sent].reverse().find((m) => m.t === 'game.action')!;
      act(() => {
        applyAction(game, actingSeat(game), last.action!);
      });
      pushView(game);
    }

    const hand = screen.getByText('Рука').parentElement!;
    fireEvent.click(within(hand).getAllByRole('button')[0]!);
    fireEvent.click(screen.getByText('Тактика'));
    // The tactic names the Footman it is played through, so it is offered
    // rather than played: nothing goes to the server until it is confirmed.
    expect(
      FakeSocket.last!.sent.some((s) => (JSON.parse(s) as { t: string }).t === 'game.action'),
    ).toBe(false);
    fireEvent.click(screen.getByText('Применить тактику'));
    settle();

    // One maneuver per Footman, asked for one at a time.
    const board = screen.getByLabelText('Поле');
    for (const hex of ['5,2', '4,2']) {
      expect(game.pending.some((s) => s.kind === 'maneuverUnit' && s.hex === hex)).toBe(true);
      const legal = board.querySelectorAll('polygon.hex--legal');
      expect(legal.length).toBeGreaterThan(0);

      // The prompt names the unit being asked, and cannot be dismissed — a
      // question the game is waiting on has to stay on screen.
      const note = screen.getByText(/манёвр$/).closest('button') as HTMLButtonElement;
      expect(note.disabled).toBe(true);

      fireEvent.click(legal[0]!);
      settle();
    }

    // Both Footmen moved off the hexes they started on.
    expect(game.units['5,2']).toBeUndefined();
    expect(game.units['4,2']).toBeUndefined();
    expect(game.pending).toHaveLength(0);
  });

  it('names both sides of an attack when the defender must answer', () => {
    const game = createGame({
      id: 'ui',
      size: 2,
      seed: 5,
      seats: [
        { userId: 'me', displayName: 'Артём К' },
        { userId: 'foe', displayName: 'Марина С' },
      ],
      fixedUnits: [
        ['royalGuard', 'knight', 'scout', 'cavalry'],
        ['swordsman', 'archer', 'ensign', 'pikeman'],
      ],
    });
    game.turn = 1;
    game.units['5,2'] = { unit: 'royalGuard', team: 0, seat: 0, coins: 1 };
    game.units['5,1'] = { unit: 'swordsman', team: 1, seat: 1, coins: 1 };
    game.players[1]!.hand = ['swordsman', 'swordsman', 'swordsman'];

    const blow = legalActions(game, 1).find((a) => a.type === 'attack' && a.to === '5,2')!;
    applyAction(game, 1, blow);

    render(<App />);
    pushView(game, 0); // the defender's screen

    // The question is the defender's, and it says who is swinging at whom.
    const sheet = document.querySelector('.sheet')!;
    expect(sheet.querySelector('h3')!.textContent).toBe(
      `${UNITS.swordsman.name.ru} (вражеский) бьёт: ${UNITS.royalGuard.name.ru}`,
    );
    expect(within(sheet as HTMLElement).getByText('Принять потерю')).toBeTruthy();

    // …and the board rings both hexes so it can be found.
    const board = screen.getByLabelText('Поле');
    expect(board.querySelectorAll('polygon.hex-focus').length).toBe(2);
  });

  it('keeps its shape with an empty hand and can show the losses', () => {
    const game = playedGame();
    game.turn = 0;
    game.players[0]!.hand = [];
    game.players[0]!.removed.knight = 2;

    render(<App />);
    pushView(game);

    // The rail keeps its place instead of folding away with the last coin.
    expect(screen.getByText('Рука')).toBeTruthy();
    expect(screen.getByText('монет нет')).toBeTruthy();

    fireEvent.click(screen.getByText('потери 2'));
    expect(screen.getByText('Ваши монеты')).toBeTruthy();
    expect(screen.getByText(UNITS.knight.name.ru)).toBeTruthy();
  });

  it('shows where every coin is, and keeps the other side\u2019s hidden', () => {
    const game = playedGame();
    game.turn = 0;
    game.players[0]!.removed.knight = 1;
    // One coin discarded face up and one facedown, on each side.
    for (const seat of [0, 1]) {
      const p = game.players[seat]!;
      p.discard = [
        { coin: p.units[0]!, faceUp: true },
        { coin: p.units[1]!, faceUp: false },
      ];
    }

    render(<App />);
    pushView(game);

    // Your own side: the bag is listed by what is in it, the hand by name.
    const mine = screen.getAllByText(/^мешок /)[0]!;
    fireEvent.click(mine);
    let modal = document.querySelector('.modal') as HTMLElement;
    expect(within(modal).getByText(/^Мешок —/)).toBeTruthy();
    expect(within(modal).queryByText('в мешке')).toBeNull();
    expect(within(modal).queryByText('в руке')).toBeNull();
    // A coin you put down facedown is still yours to look at.
    expect(within(modal).queryByText('рубашкой вниз')).toBeNull();
    fireEvent.click(document.querySelector('.backdrop')!);

    // The other side: bag and hand are counts, and so is the facedown coin.
    fireEvent.click(screen.getAllByText(/^мешок /)[1]!);
    modal = document.querySelector('.modal') as HTMLElement;
    expect(within(modal).getByText(`Монеты: ${game.players[1]!.displayName}`)).toBeTruthy();
    expect(within(modal).getByText('в мешке')).toBeTruthy();
    expect(within(modal).getByText('в руке')).toBeTruthy();
    expect(within(modal).getByText('рубашкой вниз')).toBeTruthy();
    // …while the coin they discarded face up is named.
    expect(within(modal).getByText(UNITS[game.players[1]!.units[0]!].name.ru)).toBeTruthy();
  });

  /** Plays whatever the client last sent, and pushes the new state back. */
  function settle(game: GameState, seat = 0): void {
    const sent = FakeSocket.last!.sent.map((s) => JSON.parse(s) as { t: string; action?: GameAction });
    const last = [...sent].reverse().find((m) => m.t === 'game.action')!;
    act(() => {
      applyAction(game, actingSeat(game), last.action!);
    });
    pushView(game, seat);
  }

  function duel(mine: UnitId[], theirs: UnitId[]): GameState {
    return createGame({
      id: 'ui',
      size: 2,
      seed: 5,
      seats: [
        { userId: 'me', displayName: 'Артём К' },
        { userId: 'foe', displayName: 'Марина С' },
      ],
      fixedUnits: [mine, theirs],
    });
  }

  it('lets a Berserker buy the extra maneuver its attribute offers', () => {
    // A follow-up with exactly one legal answer still has to be answerable:
    // there is no second hex to tap, so it needs a button.
    const game = duel(
      ['berserker', 'knight', 'scout', 'cavalry'],
      ['swordsman', 'archer', 'ensign', 'pikeman'],
    );
    game.turn = 0;
    game.units['5,2'] = { unit: 'berserker', team: 0, seat: 0, coins: 3 };
    game.players[0]!.hand = ['berserker', 'berserker', 'berserker'];

    render(<App />);
    pushView(game);

    const hand = screen.getByText('Рука').parentElement!;
    fireEvent.click(within(hand).getAllByRole('button')[0]!);
    fireEvent.click(screen.getByText('Двинуть'));
    const board = screen.getByLabelText('Поле');
    fireEvent.click(board.querySelectorAll('polygon.hex--legal')[0]!);
    settle(game);

    expect(game.pending.some((s) => s.kind === 'optionalRepeat')).toBe(true);
    fireEvent.click(screen.getByText('Ещё манёвр'));
    settle(game);

    // A coin came off the stack and it owes a maneuver with it.
    const berserker = Object.values(game.units).find((u) => u.unit === 'berserker')!;
    expect(berserker.coins).toBe(2);
    expect(game.pending.some((s) => s.kind === 'maneuverUnit' && !s.optional)).toBe(true);
    expect(board.querySelectorAll('polygon.hex--legal').length).toBeGreaterThan(0);
  });

  it('offers the Cavalry its charge from the move it just chose', () => {
    // Move and "move then attack" are the same first step, so they are picked
    // together: choose the space, then either strike or stay your hand.
    const game = duel(
      ['cavalry', 'knight', 'scout', 'berserker'],
      ['swordsman', 'archer', 'ensign', 'pikeman'],
    );
    game.turn = 0;
    game.units['5,3'] = { unit: 'cavalry', team: 0, seat: 0, coins: 1 };
    game.units['5,1'] = { unit: 'swordsman', team: 1, seat: 1, coins: 1 };
    game.players[0]!.hand = ['cavalry', 'cavalry', 'cavalry'];

    render(<App />);
    pushView(game);

    const hand = screen.getByText('Рука').parentElement!;
    fireEvent.click(within(hand).getAllByRole('button')[0]!);

    // One entry, not "move" and "tactic" side by side.
    expect(screen.queryByText('Тактика')).toBeNull();
    fireEvent.click(screen.getByText('Двинуть'));

    // Step onto the space beside the enemy: the charge is now on the table.
    const board = screen.getByLabelText('Поле');
    fireEvent.click(board.querySelector('polygon.hex--legal[data-hex="5,2"]')!);
    expect(board.querySelector('polygon.hex--legal[data-hex="5,1"]')).not.toBeNull();

    // …and declining it is a plain move.
    fireEvent.click(screen.getByText('Просто пойти'));
    settle(game);
    expect(game.units['5,2']?.unit).toBe('cavalry');
    expect(game.units['5,1']?.coins).toBe(1);
  });

  it('explains poison on the card of the unit that inflicts it', () => {
    const game = duel(
      ['saboteur', 'knight', 'scout', 'cavalry'],
      ['swordsman', 'archer', 'ensign', 'pikeman'],
    );
    game.turn = 0;
    render(<App />);
    pushView(game);

    // The rail lists both sides' units; tapping one opens its card.
    fireEvent.click(screen.getAllByTitle(UNITS.saboteur.name.ru)[0]!);
    const modal = document.querySelector('.modal')!;
    expect(modal.textContent).toContain('Что делает яд');
    expect(modal.textContent).toContain('Снять яд');
  });

  it('marks where the opponent just played, and says the moves that show nothing', () => {
    const game = duel(
      ['knight', 'archer', 'scout', 'cavalry'],
      ['swordsman', 'footman', 'ensign', 'pikeman'],
    );
    game.turn = 1;
    game.units['5,1'] = { unit: 'swordsman', team: 1, seat: 1, coins: 1 };
    game.players[0]!.hand = ['knight', 'knight', 'knight'];
    game.players[1]!.hand = ['swordsman', 'swordsman', 'swordsman'];

    render(<App />);

    // A move on the board: the hexes it touched are ringed on your screen.
    applyAction(game, 1, legalActions(game, 1).find((a) => a.type === 'move')!);
    pushView(game, 0);

    const board = screen.getByLabelText('Поле');
    expect(board.querySelectorAll('polygon.hex-last')).toHaveLength(2); // from, to
    expect(document.querySelector('.toast')).toBeNull();

    // Your own move is not news: playing clears the mark.
    applyAction(game, 0, legalActions(game, 0).find((a) => a.type === 'pass')!);
    pushView(game, 0);
    expect(board.querySelectorAll('polygon.hex-last')).toHaveLength(0);

    // And a turn that leaves nothing to point at is said in words instead.
    applyAction(game, 1, legalActions(game, 1).find((a) => a.type === 'recruit')!);
    pushView(game, 0);
    expect(document.querySelector('.toast')!.textContent).toContain('Марина С');
    expect(board.querySelectorAll('polygon.hex-last')).toHaveLength(0);
  });

  it('rings both ends of an attack, not just where it landed', () => {
    // Who swung matters as much as what was hit — and a ranged tactic's
    // attacker stands nowhere near its victim.
    const game = duel(
      ['knight', 'archer', 'scout', 'cavalry'],
      ['swordsman', 'footman', 'ensign', 'pikeman'],
    );
    game.turn = 1;
    // Not the Knight: it can only be attacked by a bolstered unit.
    game.units['5,2'] = { unit: 'scout', team: 0, seat: 0, coins: 1 };
    game.units['5,1'] = { unit: 'swordsman', team: 1, seat: 1, coins: 1 };
    game.players[1]!.hand = ['swordsman', 'swordsman', 'swordsman'];

    render(<App />);
    applyAction(game, 1, legalActions(game, 1).find((a) => a.type === 'attack')!);
    pushView(game, 0);

    const board = screen.getByLabelText('Поле');
    // Where the blow landed and where it came from.
    expect(board.querySelectorAll('polygon.hex-last')).toHaveLength(2);
  });

  it('shows the log in Russian', () => {
    const game = playedGame();
    game.turn = 0;
    render(<App />);
    pushView(game);
    fireEvent.click(screen.getByText('Журнал'));
    expect(screen.getByText('Журнал ходов')).toBeTruthy();
    expect(screen.getAllByText(/Раунд 1/).length).toBeGreaterThan(0);
  });
});
