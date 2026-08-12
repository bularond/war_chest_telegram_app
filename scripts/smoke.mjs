import WebSocket from 'ws';

// Point it at a server that is already up — a container, say — with
// SMOKE_URL=ws://localhost:8788/ws.
const URL = process.env.SMOKE_URL ?? 'ws://localhost:8791/ws';

function client(name) {
  const ws = new WebSocket(URL);
  const inbox = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.t === 'game.view') api.views++;
    inbox.push(msg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(msg)) waiters.splice(i, 1)[0].resolve(msg);
    }
  });
  const api = {
    ws,
    inbox,
    views: 0,
    name,
    send: (m) => ws.send(JSON.stringify(m)),
    wait: (pred, label = '') =>
      new Promise((resolve, reject) => {
        const hit = inbox.find(pred);
        if (hit) return resolve(hit);
        const t = setTimeout(() => reject(new Error(`${name}: timeout waiting ${label}`)), 4000);
        waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m); } });
      }),
    open: new Promise((r) => ws.on('open', r)),
  };
  return api;
}

const a = client('A');
const b = client('B');
await Promise.all([a.open, b.open]);

a.send({ t: 'auth', initData: '', devUser: { userId: 'u-a', displayName: 'Артём' } });
b.send({ t: 'auth', initData: '', devUser: { userId: 'u-b', displayName: 'Марина' } });
await a.wait((m) => m.t === 'auth.ok', 'auth A');
await b.wait((m) => m.t === 'auth.ok', 'auth B');
console.log('auth ok');

a.send({ t: 'lobby.create', name: 'Вороний брод', size: 2, password: 'ворон' });
const created = await a.wait((m) => m.t === 'lobby.state' && m.lobby, 'lobby create');
const code = created.lobby.code;
console.log('lobby', code, 'locked', created.lobby.locked);

b.send({ t: 'lobby.join', code, password: 'wrong' });
const err = await b.wait((m) => m.t === 'error', 'wrong password');
console.log('wrong password ->', err.message);

b.send({ t: 'lobby.join', code, password: 'ворон' });
await b.wait((m) => m.t === 'lobby.state' && m.lobby?.members.length === 2, 'join');
console.log('joined, members = 2');

a.send({ t: 'lobby.start' });
const first = await a.wait((m) => m.t === 'game.view', 'game start');
console.log('game phase', first.view.phase, 'pool', first.view.draftPool.length);

// Play the whole draft.
const clients = { 0: a, 1: b };
function currentView(c) {
  const views = c.inbox.filter((m) => m.t === 'game.view');
  return views.length ? views[views.length - 1].view : null;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Waits until this client's newest view says it is their turn with options. */
async function myTurn(c, seat) {
  for (let i = 0; i < 200; i++) {
    const v = currentView(c);
    if (v && (v.phase !== 'playing' && v.phase !== 'draft')) return v;
    if (v && v.turn === seat && v.legal.length > 0) return v;
    await sleep(10);
  }
  throw new Error(`${c.name}: never got the turn for seat ${seat}`);
}
async function whoseTurn() {
  for (let i = 0; i < 200; i++) {
    const v = currentView(a);
    if (v) return v;
    await sleep(10);
  }
  throw new Error('no view');
}
let guard = 0;
while (currentView(a).phase === 'draft' && guard++ < 20) {
  const before = currentView(a).draftPool.length;
  const seat = currentView(a).turn;
  const v = await myTurn(clients[seat], seat);
  if (v.phase !== 'draft') break;
  const pick = v.legal.find((x) => x.type === 'draft');
  if (!pick) throw new Error(`no draft action for seat ${seat}`);
  clients[seat].send({ t: 'game.action', action: pick });
  for (let j = 0; j < 300 && currentView(a).draftPool.length >= before && currentView(a).phase === 'draft'; j++) await sleep(10);
}
const afterDraft = currentView(a);
console.log('after draft:', afterDraft.phase, 'units A', afterDraft.players[0].units.length, 'hand', afterDraft.players[0].hand?.length);
console.log('hidden check — opponent hand visible?', afterDraft.players[1].hand === undefined ? 'no (good)' : 'YES (BUG)');
console.log('opponent bag count', afterDraft.players[1].bagCount);

// Play 40 random legal actions.
let moves = 0;
for (let i = 0; i < 900; i++) {
  const v0 = await whoseTurn();
  if (v0.phase !== 'playing') break;
  const seat = v0.turn;
  const c = clients[seat];
  const v = await myTurn(c, seat);
  if (v.phase !== 'playing') break;
  const me = v.players[seat];
  const coinsLeft = (me.hand?.length ?? 0) + me.bagCount + me.discard.length;
  const recruits = v.legal.filter((x) => x.type === 'recruit');
  const board = v.legal.filter((x) => x.type !== 'pass' && x.type !== 'recruit');
  // Greedy enough to actually finish: grab a location whenever one is on offer.
  const grabs = v.legal.filter((x) => x.type === 'control' || x.type === 'followControl');
  let pool = v.legal;
  if (grabs.length) pool = grabs;
  else if (coinsLeft <= 4 && recruits.length) pool = recruits;
  else if (board.length && Math.random() < 0.85) pool = board;
  const action = pool[Math.floor(Math.random() * pool.length)];
  // Wait for BOTH clients to see the result, so nobody acts on a stale view.
  const seen = [a.views, b.views];
  c.send({ t: 'game.action', action });
  for (let j = 0; j < 400 && (a.views <= seen[0] || b.views <= seen[1]); j++) await sleep(5);
  if (a.views <= seen[0]) throw new Error(`stuck on ${JSON.stringify(action)}`);
  moves++;
}
const end = currentView(a);
console.log(`played ${moves} actions; round ${end.round}; units on board ${Object.keys(end.units).length}; phase ${end.phase}; winner ${end.winner}`);
console.log('last log:', end.log.slice(-4).map((e) => e.kind).join(', '));

a.send({ t: 'profile' });
const prof = await a.wait((m) => m.t === 'profile', 'profile');
console.log('profile', prof.profile.displayName, 'wins', prof.profile.wins, 'losses', prof.profile.losses, 'history', prof.profile.history.length);

// ── a game against the computer, on the same socket ────────────────────────
console.log('\n-- vs bot --');
const auth = a.inbox.find((m) => m.t === 'auth.ok');
console.log('server offers bot levels:', auth.bots.join(', ') || '(none)');
if (!auth.bots.includes('easy')) throw new Error('server offers no bot to play');

const seenBefore = a.views;
a.send({ t: 'lobby.create', size: 2, vsBot: 'easy', draftMode: 'random' });
await a.wait((m) => m.t === 'game.view' && m.view.players.some((p) => p.bot), 'bot game');
function botView() {
  const views = a.inbox.filter((m) => m.t === 'game.view');
  return views[views.length - 1].view;
}
const opening = botView();
const botSeat = opening.players.findIndex((p) => p.bot);
console.log('bot seat', botSeat, 'level', opening.players[botSeat].bot, 'phase', opening.phase);
console.log('hidden check — bot hand visible?', opening.players[botSeat].hand === undefined ? 'no (good)' : 'YES (BUG)');
if (opening.players[botSeat].hand !== undefined) throw new Error('the bot hand leaked to the client');

let botMoves = 0;
let mine = 0;
for (let i = 0; i < 900; i++) {
  const v = botView();
  if (v.phase !== 'playing') break;
  if (v.acting !== v.you) {
    // The computer owes the move: it must arrive on its own, with no nudge.
    const before = a.views;
    let waited = 0;
    while (a.views <= before && waited < 400) {
      await sleep(10);
      waited++;
    }
    if (a.views <= before) throw new Error('the bot never moved');
    botMoves++;
    continue;
  }
  const grabs = v.legal.filter((x) => x.type === 'control' || x.type === 'followControl');
  const board = v.legal.filter((x) => x.type !== 'pass' && x.type !== 'recruit');
  const pool = grabs.length ? grabs : board.length ? board : v.legal;
  const action = pool[Math.floor(Math.random() * pool.length)];
  const before = a.views;
  a.send({ t: 'game.action', action });
  for (let j = 0; j < 400 && a.views <= before; j++) await sleep(5);
  mine++;
}
const done = botView();
console.log(`vs bot: ${mine} player actions, ${botMoves} bot turns; round ${done.round}; phase ${done.phase}; winner ${done.winner}`);
if (botMoves === 0) throw new Error('the bot never took a turn');
console.log('views delivered while playing the bot:', a.views - seenBefore);

// ── and one against a level that actually searches, in a worker ────────────
console.log('\n-- vs bot, medium (search in a worker) --');
if (!auth.bots.includes('medium')) throw new Error('server offers no searching bot');
a.send({ t: 'lobby.create', size: 2, vsBot: 'medium', draftMode: 'random' });
await a.wait(
  (m) => m.t === 'game.view' && m.view.players.some((p) => p.bot === 'medium'),
  'medium game',
);
function mediumView() {
  const views = a.inbox.filter((m) => m.t === 'game.view');
  return views[views.length - 1].view;
}
let searchTurns = 0;
const slowest = { ms: 0 };
for (let i = 0; i < 200 && searchTurns < 5; i++) {
  const v = mediumView();
  if (v.phase !== 'playing') break;
  if (v.acting !== v.you) {
    const before = a.views;
    const t0 = Date.now();
    let waited = 0;
    while (a.views <= before && waited < 800) {
      await sleep(10);
      waited++;
    }
    if (a.views <= before) throw new Error('the searching bot never moved');
    slowest.ms = Math.max(slowest.ms, Date.now() - t0);
    searchTurns++;
    continue;
  }
  const pool = v.legal.filter((x) => x.type !== 'pass');
  const action = (pool.length ? pool : v.legal)[0];
  const before = a.views;
  a.send({ t: 'game.action', action });
  for (let j = 0; j < 400 && a.views <= before; j++) await sleep(5);
}
if (searchTurns < 5) throw new Error(`medium bot took only ${searchTurns} turns`);
console.log(`medium bot took ${searchTurns} turns; slowest ${slowest.ms} ms (search runs off the main thread)`);

// The server must still answer other clients while a bot is thinking.
const pingStart = Date.now();
b.send({ t: 'lobby.list' });
await b.wait((m) => m.t === 'lobby.list', 'lobby list while the bot thinks');
console.log('other client served in', Date.now() - pingStart, 'ms while a bot game runs');

a.ws.close();
b.ws.close();
console.log('SMOKE OK');
