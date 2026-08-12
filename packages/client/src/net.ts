/**
 * WebSocket connection and the app's whole client state.
 *
 * One socket, one immutable snapshot, `useSyncExternalStore` to read it. The
 * server is authoritative: the client never mutates game state, it only sends
 * actions and renders whatever comes back.
 */

import type {
  BotLevel,
  ClientMessage,
  DraftMode,
  GameAction,
  GameView,
  LobbyState,
  LobbySummary,
  Member,
  Profile,
  ServerMessage,
  UnitSet,
} from '@wc/shared';
import { useSyncExternalStore } from 'react';
import { devIdentity, initData, inTelegram, notify } from './telegram.js';

export type Screen =
  | 'hub'
  | 'list'
  | 'code'
  | 'create'
  | 'bot'
  | 'lobby'
  | 'profile'
  | 'rules'
  | 'game';

export interface AppState {
  readonly connected: boolean;
  readonly user: Member | null;
  /** Sets the server will accept; the client never offers more than these. */
  readonly sets: readonly UnitSet[];
  /** Bot levels this server can play. Same rule: never offer more than these. */
  readonly bots: readonly BotLevel[];
  readonly screen: Screen;
  readonly lobbies: readonly LobbySummary[];
  readonly lobby: LobbyState | null;
  readonly view: GameView | null;
  readonly profile: Profile | null;
  readonly error: { code: string; message: string } | null;
}

const initial: AppState = {
  connected: false,
  user: null,
  sets: ['base'],
  bots: [],
  screen: 'hub',
  lobbies: [],
  lobby: null,
  view: null,
  profile: null,
  error: null,
};

function socketUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

class Store {
  private state: AppState = initial;
  private listeners = new Set<() => void>();
  private socket: WebSocket | null = null;
  private retry = 0;
  private queue: ClientMessage[] = [];

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  snapshot = (): AppState => this.state;

  private set(patch: Partial<AppState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  /** Drops the socket and every bit of state. Used by tests between cases. */
  reset(): void {
    this.socket?.close?.();
    this.socket = null;
    this.queue = [];
    this.retry = 0;
    this.state = initial;
    for (const l of this.listeners) l();
  }

  connect(): void {
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) return;
    const socket = new WebSocket(socketUrl());
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.retry = 0;
      this.set({ connected: true });
      const msg: ClientMessage = inTelegram()
        ? { t: 'auth', initData: initData() }
        : { t: 'auth', initData: '', devUser: devIdentity() };
      socket.send(JSON.stringify(msg));
      for (const queued of this.queue.splice(0)) socket.send(JSON.stringify(queued));
    });

    socket.addEventListener('message', (event: MessageEvent<string>) => {
      this.receive(JSON.parse(event.data) as ServerMessage);
    });

    socket.addEventListener('close', () => {
      this.set({ connected: false });
      const delay = Math.min(1000 * 2 ** this.retry++, 10_000);
      setTimeout(() => this.connect(), delay);
    });
  }

  send(msg: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(msg));
    else this.queue.push(msg);
  }

  private receive(msg: ServerMessage): void {
    switch (msg.t) {
      case 'auth.ok':
        this.set({
          user: msg.user,
          sets: msg.sets,
          bots: msg.bots,
          lobby: msg.lobby,
          screen: msg.lobby ? (msg.lobby.started ? 'game' : 'lobby') : this.state.screen,
        });
        return;
      case 'lobby.list':
        this.set({ lobbies: msg.lobbies });
        return;
      case 'lobby.state':
        this.set({
          lobby: msg.lobby,
          error: null,
          view: msg.lobby ? this.state.view : null,
          screen: msg.lobby ? (msg.lobby.started ? 'game' : 'lobby') : 'hub',
        });
        return;
      case 'game.view':
        this.set({ view: msg.view, screen: 'game' });
        return;
      case 'profile':
        this.set({ profile: msg.profile });
        return;
      case 'error':
        notify('error');
        this.set({ error: { code: msg.code, message: msg.message } });
        return;
    }
  }

  // ── intents ────────────────────────────────────────────────────────────

  go(screen: Screen): void {
    this.set({ screen, error: null });
    if (screen === 'list') this.send({ t: 'lobby.list' });
    if (screen === 'profile') this.send({ t: 'profile' });
  }

  clearError(): void {
    if (this.state.error) this.set({ error: null });
  }

  refreshLobbies(): void {
    this.send({ t: 'lobby.list' });
  }

  createLobby(opts: {
    name?: string;
    size: 2 | 4;
    draftMode?: DraftMode;
    sets?: readonly UnitSet[];
    password?: string;
  }): void {
    this.send({ t: 'lobby.create', ...opts });
  }

  /** Sits down against the computer. The table fills and deals immediately. */
  playVsBot(level: BotLevel, opts: { sets?: readonly UnitSet[]; draftMode?: DraftMode } = {}): void {
    this.send({
      t: 'lobby.create',
      size: 2,
      vsBot: level,
      draftMode: opts.draftMode ?? 'draft',
      ...(opts.sets ? { sets: opts.sets } : {}),
    });
  }

  joinLobby(code: string, password?: string): void {
    this.send({ t: 'lobby.join', code: code.toUpperCase(), ...(password ? { password } : {}) });
  }

  leaveLobby(): void {
    this.send({ t: 'lobby.leave' });
  }

  startGame(): void {
    this.send({ t: 'lobby.start' });
  }

  act(action: GameAction): void {
    this.send({ t: 'game.action', action });
  }
}

export const store = new Store();

export function useApp(): AppState {
  return useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
}
