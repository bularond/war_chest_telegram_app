import { existsSync } from 'node:fs';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { botBuild } from '@wc/shared/rules';
import {
  BOT_LEVELS,
  BOT_READY,
  isBotUserId,
  SET_READY,
  type BotLevel,
  type ClientMessage,
  type ServerMessage,
  type UnitSet,
} from '@wc/shared';
import Fastify from 'fastify';
import type { WebSocket } from 'ws';
import { actingBotSeat, BotRunner, DEFAULT_BOT_RUNNER, newBotRng } from './bot-runner.js';
import { loadConfig } from './config.js';
import { Store } from './db.js';
import { RoomError, Rooms, type Lobby, type Member } from './rooms.js';
import { startChat } from './telegram-chat.js';
import { botIdOf, displayName, parseUser, verifyInitData } from './telegram.js';

const config = loadConfig();
const store = new Store(config.dbPath);
const rooms = new Rooms();
const READY_SETS = (Object.keys(SET_READY) as UnitSet[]).filter((s) => SET_READY[s]);
const READY_BOTS = BOT_LEVELS.filter((level) => BOT_READY[level]);

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
await app.register(websocket);

/** Live sockets per user; a player may have the app open in two places. */
const socketsByUser = new Map<string, Set<WebSocket>>();
const userBySocket = new Map<WebSocket, Member>();
/** Games whose result has already been written, so restarts do not double-count. */
const recorded = new Set<string>();

/**
 * The computer's turns. `schedule` is called after every action and after a
 * table is created, and does nothing unless a bot actually owes a move.
 */
const botRunner = new BotRunner(
  {
    ...DEFAULT_BOT_RUNNER,
    ...(process.env.BOT_THINK_MS ? { thinkMs: Number(process.env.BOT_THINK_MS) } : {}),
    // The cap that keeps player-versus-player games responsive while somebody
    // else's Hard bot is thinking. Raise it only with cores to spare.
    ...(process.env.BOT_WORKERS ? { limit: Number(process.env.BOT_WORKERS) } : {}),
    ...(process.env.BOT_DEADLINE_MS ? { deadlineMs: Number(process.env.BOT_DEADLINE_MS) } : {}),
    // How many workers one move may spread across. Opportunistic: it takes what
    // is idle and never fewer than one, so this is a ceiling and not a demand.
    ...(process.env.BOT_THREADS ? { threads: Number(process.env.BOT_THREADS) } : {}),
  },
  (code) => pushLobby(rooms.get(code)),
  (code, err) => app.log.warn({ err, code }, 'bot turn fell back to the heuristic'),
);
app.addHook('onClose', async () => botRunner.stop());

function scheduleBot(lobby: Lobby | undefined | null): void {
  if (!lobby?.game || !lobby.vsBot) return;
  botRunner.schedule(lobby.code, () => {
    const live = rooms.get(lobby.code);
    if (!live?.game || !live.botRng) return null;
    if (actingBotSeat(live.game) === null) return null;
    return { key: live.code, state: live.game, rng: live.botRng };
  });
}

function send(socket: WebSocket, msg: ServerMessage): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
}

function sendToUser(userId: string, msg: ServerMessage): void {
  for (const s of socketsByUser.get(userId) ?? []) send(s, msg);
}

function pushLobby(lobby: Lobby | undefined | null): void {
  if (!lobby) return;
  const state = rooms.state(lobby);
  for (const member of rooms.seatedMembers(lobby)) {
    sendToUser(member.userId, { t: 'lobby.state', lobby: state });
    const view = rooms.viewFor(lobby, member.userId);
    if (view) sendToUser(member.userId, { t: 'game.view', view });
  }
  recordIfFinished(lobby);
  // The bot may owe the next move — or several, when a card gives it a
  // follow-up step or the player has run out of coins.
  scheduleBot(lobby);
}

function recordIfFinished(lobby: Lobby): void {
  const game = lobby.game;
  if (!game || game.phase !== 'finished' || recorded.has(game.id)) return;
  recorded.add(game.id);
  const finishedAt = Date.now();

  if (lobby.vsBot) {
    // Logged apart from the player-vs-player history: the level and the build
    // are the only way to tell later whether Easy was too hard.
    const human = game.players.find((p) => !p.bot);
    if (human) {
      store.recordBotGame({
        gameId: game.id,
        userId: human.userId,
        level: lobby.vsBot,
        botBuild: botBuild(),
        won: game.winner === human.team,
        draw: game.winner === null,
        plies: game.log.length,
        rounds: game.round,
        sets: game.sets.join(','),
        finishedAt,
      });
    }
  }

  for (const p of game.players) {
    if (isBotUserId(p.userId)) continue;
    const opponents = game.players
      .filter((o) => o.team !== p.team)
      .map((o) => o.displayName)
      .join(', ');
    store.recordResult({
      gameId: game.id,
      userId: p.userId,
      opponents,
      tableName: lobby.name,
      size: game.size,
      won: game.winner === p.team,
      finishedAt,
    });
  }
}

function profileFor(user: Member) {
  const row = store.getUser(user.userId) ?? store.upsertUser({
    id: user.userId,
    displayName: user.displayName,
  });
  return {
    userId: row.id,
    displayName: row.display_name,
    username: row.username,
    photoUrl: row.photo_url,
    wins: row.wins,
    losses: row.losses,
    history: store.history(row.id).map((h) => ({
      opponents: h.opponents,
      tableName: h.table_name,
      size: h.size,
      won: h.won === 1,
      finishedAt: h.finished_at,
    })),
  };
}

function authenticate(msg: Extract<ClientMessage, { t: 'auth' }>): Member {
  if (config.botToken) {
    const result = verifyInitData(msg.initData, config.botToken);
    if (!result.ok) {
      // The client shows this to the player, and the player reads it out to
      // whoever runs the server: it is the whole diagnosis in one word.
      app.log.warn({ reason: result.reason }, 'Telegram launch rejected');
      throw new RoomError('auth', `Не удалось проверить подпись Telegram: ${result.reason}`);
    }
    const { user } = result;
    // Which of the two check strings the client's Telegram signs, available
    // with LOG_LEVEL=debug. Worth having when the next protocol change lands.
    app.log.debug({ signedOver: result.signedOver }, 'Telegram launch accepted');
    store.upsertUser({
      id: user.id,
      displayName: displayName(user),
      ...(user.username ? { username: user.username } : {}),
      ...(user.photoUrl ? { photoUrl: user.photoUrl } : {}),
    });
    return {
      userId: user.id,
      displayName: displayName(user),
      photoUrl: user.photoUrl ?? null,
    };
  }

  // Development: trust whatever the client claims, but still parse real initData
  // when it is present so the flow matches production as closely as possible.
  const parsed = parseUser(new URLSearchParams(msg.initData ?? '').get('user'));
  const member: Member = parsed
    ? { userId: parsed.id, displayName: displayName(parsed) }
    : (msg.devUser ?? { userId: `dev-${Math.random().toString(36).slice(2, 8)}`, displayName: 'Гость' });
  store.upsertUser({ id: member.userId, displayName: member.displayName });
  return { ...member, photoUrl: member.photoUrl ?? null };
}

app.get('/health', async () => ({ ok: true }));

app.get('/ws', { websocket: true }, (socket) => {
  socket.on('message', (raw: Buffer) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString()) as ClientMessage;
    } catch {
      send(socket, { t: 'error', code: 'bad_json', message: 'Некорректное сообщение' });
      return;
    }

    try {
      handle(socket, msg);
    } catch (err) {
      if (err instanceof RoomError) {
        send(socket, { t: 'error', code: err.code, message: err.message });
      } else {
        app.log.error({ err }, 'message failed');
        const message = err instanceof Error ? err.message : 'Внутренняя ошибка';
        send(socket, { t: 'error', code: 'internal', message });
      }
    }
  });

  socket.on('close', () => {
    const user = userBySocket.get(socket);
    userBySocket.delete(socket);
    if (!user) return;
    const set = socketsByUser.get(user.userId);
    set?.delete(socket);
    if (set && set.size === 0) {
      socketsByUser.delete(user.userId);
      pushLobby(rooms.markDisconnected(user.userId));
    }
  });
});

function requireUser(socket: WebSocket): Member {
  const user = userBySocket.get(socket);
  if (!user) throw new RoomError('unauthenticated', 'Сначала авторизуйтесь');
  return user;
}

function handle(socket: WebSocket, msg: ClientMessage): void {
  if (msg.t === 'auth') {
    const user = authenticate(msg);
    userBySocket.set(socket, user);
    let set = socketsByUser.get(user.userId);
    if (!set) socketsByUser.set(user.userId, (set = new Set()));
    set.add(socket);

    const lobby = rooms.lobbyOf(user.userId);
    if (lobby) lobby.emptySince = null;
    send(socket, {
      t: 'auth.ok',
      user,
      lobby: lobby ? rooms.state(lobby) : null,
      sets: READY_SETS,
      bots: READY_BOTS,
    });
    if (lobby) {
      const view = rooms.viewFor(lobby, user.userId);
      if (view) send(socket, { t: 'game.view', view });
      // Coming back to a table where the computer owes a move: nothing else
      // will ask for it, since nobody acted while the player was away.
      scheduleBot(lobby);
    }
    return;
  }

  const user = requireUser(socket);

  switch (msg.t) {
    case 'lobby.list':
      send(socket, { t: 'lobby.list', lobbies: rooms.list() });
      return;
    case 'lobby.create': {
      if (msg.vsBot && !READY_BOTS.includes(msg.vsBot)) {
        throw new RoomError('bot_level', 'Такой соперник пока не готов');
      }
      const lobby = rooms.create(user, {
        ...(msg.name !== undefined ? { name: msg.name } : {}),
        size: msg.size,
        ...(msg.draftMode ? { draftMode: msg.draftMode } : {}),
        ...(msg.sets ? { sets: msg.sets } : {}),
        ...(msg.password ? { password: msg.password } : {}),
        ...(msg.vsBot ? { vsBot: msg.vsBot as BotLevel, botRng: newBotRng() } : {}),
      });
      pushLobby(lobby);
      return;
    }
    case 'lobby.join': {
      const lobby = rooms.join(msg.code, user, msg.password);
      pushLobby(lobby);
      return;
    }
    case 'lobby.leave': {
      const previous = rooms.lobbyOf(user.userId);
      rooms.leave(user.userId);
      send(socket, { t: 'lobby.state', lobby: null });
      if (previous) pushLobby(rooms.get(previous.code));
      return;
    }
    case 'lobby.start': {
      const lobby = rooms.lobbyOf(user.userId);
      if (!lobby) throw new RoomError('no_lobby', 'Вы не за столом');
      pushLobby(rooms.start(lobby.code, user.userId));
      return;
    }
    case 'game.action': {
      pushLobby(rooms.act(user.userId, msg.action));
      return;
    }
    case 'profile':
      send(socket, { t: 'profile', profile: profileFor(user) });
      return;
  }
}

if (existsSync(config.clientDir)) {
  await app.register(fastifyStatic, { root: config.clientDir });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/ws') || req.url.startsWith('/health')) {
      return reply.code(404).send({ error: 'not found' });
    }
    return reply.sendFile('index.html');
  });
} else {
  app.log.warn({ dir: config.clientDir }, 'client bundle not found — serving API only');
}

/*
 * The chat side of the bot: one greeting with a button into the Mini App, to
 * whatever anyone says. It needs the address the app answers on from outside,
 * which the server cannot work out for itself.
 */
if (config.botToken && config.publicUrl) {
  const chat = startChat({
    token: config.botToken,
    appUrl: config.publicUrl,
    log: { info: (o, m) => app.log.info(o, m), warn: (o, m) => app.log.warn(o, m) },
  });
  app.addHook('onClose', async () => chat.stop());
  app.log.info({ appUrl: config.publicUrl }, 'Telegram chat is answering');
} else if (config.botToken) {
  app.log.warn('PUBLIC_URL is not set — the bot will not answer in chat');
}

await app.listen({ port: config.port, host: config.host });
if (config.devAuth) {
  app.log.warn('TELEGRAM_BOT_TOKEN is not set — running with unverified dev auth');
} else {
  // Which bot the token belongs to. Launches signed by any other bot will be
  // turned away, and this number next to the one in BotFather is the fastest
  // way to see that that is what is happening.
  app.log.info({ bot: botIdOf(config.botToken!) }, 'Telegram launches are verified');
}
