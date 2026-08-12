/**
 * Lobbies and live games, held in memory.
 *
 * A lobby becomes a game when the host starts it; the `GameState` stays on the
 * server and each player only ever receives their own redacted `GameView`.
 */

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import {
  applyAction,
  BOT_LEVEL_NAMES,
  botUserId,
  createGame,
  isBotUserId,
  legalActions,
  viewFor,
  type BoardSize,
  type BotLevel,
  type DraftMode,
  type GameAction,
  type GameState,
  type GameView,
  type LobbyState,
  type LobbySummary,
  type Member,
  SET_READY,
  type RngState,
  type Seat,
  type UnitSet,
} from '@wc/shared';

export type { Member };

export interface Lobby {
  readonly code: string;
  name: string;
  hostId: string;
  size: BoardSize;
  draftMode: DraftMode;
  sets: UnitSet[];
  password: { salt: string; hash: string } | null;
  members: Member[];
  game: GameState | null;
  /** Set on a table against the computer; the bot sits in the second seat. */
  vsBot: BotLevel | null;
  /** The bot's own randomness, so its tie-breaks do not depend on anything else. */
  botRng: RngState | null;
  createdAt: number;
  /** Set when the last member disconnects, so idle lobbies can be reaped. */
  emptySince: number | null;
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1
const IDLE_LOBBY_MS = 60 * 60 * 1000;

function makeCode(taken: (code: string) => boolean): string {
  for (let attempt = 0; attempt < 100; attempt++) {
    const bytes = randomBytes(6);
    let code = '';
    for (const b of bytes) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
    if (!taken(code)) return code;
  }
  throw new Error('could not allocate a lobby code');
}

function hashPassword(password: string, salt = randomBytes(16).toString('hex')) {
  return { salt, hash: scryptSync(password, salt, 32).toString('hex') };
}

function passwordMatches(lobby: Lobby, password: string | undefined): boolean {
  if (!lobby.password) return true;
  if (!password) return false;
  const candidate = hashPassword(password, lobby.password.salt).hash;
  const a = Buffer.from(candidate, 'hex');
  const b = Buffer.from(lobby.password.hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export class RoomError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export class Rooms {
  private readonly lobbies = new Map<string, Lobby>();
  /** userId -> lobby code, so a reconnecting player lands back in their game. */
  private readonly byUser = new Map<string, string>();

  list(): LobbySummary[] {
    this.reapIdle();
    return [...this.lobbies.values()]
      .filter((l) => !l.game && !l.vsBot)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((l) => this.summary(l));
  }

  summary(lobby: Lobby): LobbySummary {
    return {
      code: lobby.code,
      name: lobby.name,
      host: lobby.members.find((m) => m.userId === lobby.hostId)?.displayName ?? '—',
      size: lobby.size,
      draftMode: lobby.draftMode,
      sets: [...lobby.sets],
      players: lobby.members.length,
      locked: lobby.password !== null,
      started: lobby.game !== null,
    };
  }

  state(lobby: Lobby): LobbyState {
    return {
      code: lobby.code,
      name: lobby.name,
      host: lobby.members.find((m) => m.userId === lobby.hostId)?.displayName ?? '—',
      hostId: lobby.hostId,
      size: lobby.size,
      draftMode: lobby.draftMode,
      sets: [...lobby.sets],
      locked: lobby.password !== null,
      members: [...lobby.members],
      started: lobby.game !== null,
    };
  }

  get(code: string): Lobby | undefined {
    return this.lobbies.get(code.toUpperCase());
  }

  lobbyOf(userId: string): Lobby | undefined {
    const code = this.byUser.get(userId);
    return code ? this.lobbies.get(code) : undefined;
  }

  create(
    host: Member,
    opts: {
      name?: string;
      size: BoardSize;
      draftMode?: DraftMode;
      sets?: readonly UnitSet[];
      password?: string;
      /** Sit down against the computer: the table fills and starts at once. */
      vsBot?: BotLevel;
      botRng?: RngState;
    },
  ): Lobby {
    this.leave(host.userId);
    const code = makeCode((c) => this.lobbies.has(c));
    const lobby: Lobby = {
      code,
      name: opts.name?.trim() || `Стол ${host.displayName}`,
      hostId: host.userId,
      size: opts.size,
      draftMode: opts.draftMode ?? 'draft',
      sets: ['base', ...(opts.sets ?? []).filter((x) => x !== 'base' && SET_READY[x])],
      password: opts.password ? hashPassword(opts.password) : null,
      members: [host],
      game: null,
      vsBot: opts.vsBot ?? null,
      botRng: opts.botRng ?? null,
      createdAt: Date.now(),
      emptySince: null,
    };
    this.lobbies.set(code, lobby);
    this.byUser.set(host.userId, code);

    if (opts.vsBot) {
      // Nobody to wait for: seat the computer and deal.
      lobby.name = `Против ${BOT_LEVEL_NAMES[opts.vsBot].ru.toLowerCase()}`;
      for (let seat = lobby.members.length; seat < lobby.size; seat++) {
        lobby.members.push({
          userId: botUserId(opts.vsBot),
          displayName: `Бот (${BOT_LEVEL_NAMES[opts.vsBot].ru.toLowerCase()})`,
        });
      }
      this.start(code, host.userId);
    }
    return lobby;
  }

  /** Seats played by the computer, by their index in `members`. */
  botSeats(lobby: Lobby): Seat[] {
    return lobby.members.flatMap((m, seat) => (isBotUserId(m.userId) ? [seat] : []));
  }

  humanMembers(lobby: Lobby): Member[] {
    return lobby.members.filter((m) => !isBotUserId(m.userId));
  }

  join(code: string, member: Member, password?: string): Lobby {
    const lobby = this.get(code);
    if (!lobby) throw new RoomError('not_found', 'Стол с таким кодом не найден');

    const already = lobby.members.some((m) => m.userId === member.userId);
    if (!already) {
      if (lobby.game) throw new RoomError('started', 'Партия уже началась');
      if (lobby.members.length >= lobby.size) throw new RoomError('full', 'Стол уже собран');
      if (!passwordMatches(lobby, password)) throw new RoomError('password', 'Неверный пароль');
      this.leave(member.userId);
      lobby.members.push(member);
    }
    this.byUser.set(member.userId, lobby.code);
    lobby.emptySince = null;
    return lobby;
  }

  leave(userId: string): Lobby | undefined {
    const lobby = this.lobbyOf(userId);
    if (!lobby) return undefined;
    this.byUser.delete(userId);
    // A player who leaves a game in progress keeps their seat; they can return.
    if (lobby.game) return lobby;

    lobby.members = lobby.members.filter((m) => m.userId !== userId);
    if (lobby.members.length === 0) {
      this.lobbies.delete(lobby.code);
      return undefined;
    }
    if (lobby.hostId === userId) lobby.hostId = lobby.members[0]!.userId;
    return lobby;
  }

  start(code: string, userId: string): Lobby {
    const lobby = this.get(code);
    if (!lobby) throw new RoomError('not_found', 'Стол не найден');
    if (lobby.hostId !== userId) throw new RoomError('not_host', 'Начать партию может только хозяин');
    if (lobby.game) throw new RoomError('started', 'Партия уже идёт');
    if (lobby.members.length !== lobby.size) {
      throw new RoomError('not_full', 'Стол ещё не собран');
    }
    lobby.game = createGame({
      id: `${lobby.code}-${Date.now().toString(36)}`,
      size: lobby.size,
      seed: randomBytes(4).readUInt32BE(0),
      draftMode: lobby.draftMode,
      sets: lobby.sets,
      seats: lobby.members.map((m) => ({
        userId: m.userId,
        displayName: m.displayName,
        avatarUrl: m.photoUrl ?? null,
        ...(isBotUserId(m.userId) && lobby.vsBot ? { bot: lobby.vsBot } : {}),
      })),
    });
    return lobby;
  }

  seatOf(lobby: Lobby, userId: string): Seat {
    const seat = lobby.members.findIndex((m) => m.userId === userId);
    if (seat === -1) throw new RoomError('not_seated', 'Вы не за этим столом');
    return seat;
  }

  act(userId: string, action: GameAction): Lobby {
    const lobby = this.lobbyOf(userId);
    if (!lobby?.game) throw new RoomError('no_game', 'Партия не идёт');
    applyAction(lobby.game, this.seatOf(lobby, userId), action);
    return lobby;
  }

  viewFor(lobby: Lobby, userId: string): GameView | null {
    if (!lobby.game) return null;
    const seat = this.seatOf(lobby, userId);
    return viewFor(lobby.game, seat, legalActions(lobby.game, seat));
  }

  /** Marks a lobby idle when nobody is connected, and drops stale ones. */
  markDisconnected(userId: string): Lobby | undefined {
    const lobby = this.lobbyOf(userId);
    if (lobby && lobby.emptySince === null) lobby.emptySince = Date.now();
    return lobby;
  }

  private reapIdle(): void {
    const cutoff = Date.now() - IDLE_LOBBY_MS;
    for (const [code, lobby] of this.lobbies) {
      if (lobby.emptySince !== null && lobby.emptySince < cutoff) {
        for (const m of lobby.members) this.byUser.delete(m.userId);
        this.lobbies.delete(code);
      }
    }
  }
}
