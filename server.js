'use strict';
/*
 * سيرفر لعبة «مين أكتر حدا؟» — قعدة رواق
 * - بيقدّم ملفات اللعبة من مجلد public
 * - بيوصّل موبايلات القعدة ببعض عبر WebSocket (المدير هو صاحب الحالة، والسيرفر بس بيمرّر الرسائل)
 * - بيجمع إحصائيات بسيطة (بدون أسماء ولا صور) وبيعرضها على /stats
 */
const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const { createStats } = require('./stats');

const PORT = Number(process.env.PORT) || 3000;
const STATS_KEY = process.env.STATS_KEY || '';
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS) || 40;
const MAX_ROOMS = 5000;
const ROOM_IDLE_MS = 6 * 60 * 60 * 1000; // بتنمسح القعدة بعد 6 ساعات بلا حدا
const CODE_RE = /^[A-Z0-9]{5}$/;
const ID_RE = /^[a-z0-9]{6,24}$/;

const PUBLIC = path.join(__dirname, 'public');
const fs = require('fs');
const INDEX = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

const stats = createStats();
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

function originOf(req) {
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  return proto + '://' + req.get('host');
}
function sendIndex(req, res) {
  stats.visit();
  res.set('Cache-Control', 'no-cache');
  res.type('html').send(INDEX.split('__ORIGIN__').join(originOf(req)));
}

app.get('/', sendIndex);
app.get('/index.html', sendIndex);
app.get('/healthz', (req, res) => res.json({ ok: true, rooms: rooms.size, uptime: Math.round(process.uptime()) }));

function statsAllowed(req) { return STATS_KEY && req.query.key === STATS_KEY; }
app.get('/stats.json', (req, res) => {
  if (!statsAllowed(req)) return res.status(404).end();
  res.set('Cache-Control', 'no-store').json({ ...stats.snapshot(), live: liveCounts() });
});
app.get('/stats', (req, res) => {
  if (!statsAllowed(req)) return res.status(404).type('text').send('غير متاح');
  res.set('Cache-Control', 'no-store').type('html').send(require('./stats-page')(stats.snapshot(), liveCounts()));
});

app.use(express.static(PUBLIC, {
  index: false,
  maxAge: '7d',
  setHeaders(res, p) {
    if (p.endsWith('.webmanifest')) res.type('application/manifest+json');
    if (p.endsWith('sw.js')) { res.set('Cache-Control', 'no-cache'); res.set('Service-Worker-Allowed', '/'); }
  }
}));
app.use((req, res) => res.redirect(302, '/'));

/* ===================== القعدات ===================== */
const rooms = new Map(); // code -> { code, key, host, players: Map<cid, ws>, touched, seen:Set, started }

function getRoom(code, create) {
  let r = rooms.get(code);
  if (!r && create) {
    if (rooms.size >= MAX_ROOMS) return null;
    r = { code, key: null, host: null, players: new Map(), touched: Date.now(), seen: new Set(), started: false, rounds: 0, finished: false, opened: false };
    rooms.set(code, r);
  }
  return r;
}
function out(ws, obj) { if (ws && ws.readyState === 1) ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); }
function toPlayers(r, obj) { const d = JSON.stringify(obj); r.players.forEach(p => out(p, d)); }
function liveCounts() {
  let players = 0, hosts = 0;
  rooms.forEach(r => { players += r.players.size; if (r.host) hosts++; });
  return { rooms: hosts, players };
}

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 3 * 1024 * 1024 });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.bucket = { t: Date.now(), n: 0 };
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (buf, isBinary) => {
    if (isBinary) return;
    // حد بسيط لعدد الرسائل
    const now = Date.now();
    if (now - ws.bucket.t > 1000) { ws.bucket.t = now; ws.bucket.n = 0; }
    if (++ws.bucket.n > 80) return;
    let m; try { m = JSON.parse(buf); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    try { handle(ws, m); } catch (e) { console.error('handle error', e); }
  });

  ws.on('close', () => leave(ws));
  ws.on('error', () => {});
});

function handle(ws, m) {
  const r = ws.room;
  if (r) r.touched = Date.now();

  // المدير بيفتح القعدة أو بيرجع لها
  if (m.t === 'host') {
    if (ws.role) return;
    if (typeof m.code !== 'string' || !CODE_RE.test(m.code) || typeof m.key !== 'string' || !ID_RE.test(m.key)) return ws.close(4400, 'bad');
    const room = getRoom(m.code, true);
    if (!room) return out(ws, { t: 'busy' });
    if (room.key && room.key !== m.key) return out(ws, { t: 'taken' });
    room.key = m.key;
    if (room.host && room.host !== ws) { const old = room.host; room.host = null; try { old.close(4000, 'replaced'); } catch (e) {} }
    room.host = ws; ws.role = 'host'; ws.room = room; room.touched = Date.now();
    if (!room.opened) { room.opened = true; stats.event('room'); }
    out(ws, { t: 'host-ok' });
    // المدير بيعرف مين متصل هلأ
    toPlayers(room, { t: 'host-up' });
    return;
  }

  // لاعب بيفوت عالقعدة
  if (m.t === 'join') {
    if (ws.role) return;
    if (typeof m.code !== 'string' || !CODE_RE.test(m.code) || typeof m.cid !== 'string' || !ID_RE.test(m.cid)) return ws.close(4400, 'bad');
    const room = getRoom(m.code, true);
    if (!room) return out(ws, { t: 'busy' });
    const old = room.players.get(m.cid);
    if (!old && room.players.size >= MAX_PLAYERS) return out(ws, { t: 'full' });
    if (old && old !== ws) { room.players.delete(m.cid); try { old.close(4001, 'replaced'); } catch (e) {} }
    room.players.set(m.cid, ws); ws.role = 'player'; ws.cid = m.cid; ws.room = room; room.touched = Date.now();
    if (!room.seen.has(m.cid)) { room.seen.add(m.cid); if (room.seen.size <= 200) stats.event('player'); }
    out(ws, { t: 'joined', host: !!room.host });
    return;
  }

  if (!r) return;

  if (ws.role === 'host') {
    if (m.t === 'to' && typeof m.cid === 'string') { out(r.players.get(m.cid), { t: 'msg', msg: m.msg }); return; }
    if (m.t === 'all') { toPlayers(r, { t: 'msg', msg: m.msg }); return; }
    if (m.t === 'stat') { onStat(r, m); return; }
    return;
  }

  if (ws.role === 'player' && m.t === 'up') {
    if (!r.host) return out(ws, { t: 'nohost' });
    out(r.host, { t: 'from', cid: ws.cid, msg: m.msg });
  }
}

function onStat(r, m) {
  if (m.ev === 'start' && !r.started) { r.started = true; stats.event('game', { n: clampInt(m.n, 0, MAX_PLAYERS) }); }
  else if (m.ev === 'round' && r.rounds < 200) { r.rounds++; stats.event('round', { q: typeof m.q === 'string' ? m.q.slice(0, 60) : '', custom: !!m.custom }); }
  else if (m.ev === 'final' && !r.finished) { r.finished = true; stats.event('final', { type: typeof m.type === 'string' ? m.type.slice(0, 20) : '', rounds: clampInt(m.rounds, 0, 500) }); }
}
function clampInt(v, a, b) { v = Math.round(Number(v) || 0); return Math.max(a, Math.min(b, v)); }

function leave(ws) {
  const r = ws.room; if (!r) return;
  r.touched = Date.now();
  if (ws.role === 'host' && r.host === ws) { r.host = null; toPlayers(r, { t: 'host-down' }); }
  if (ws.role === 'player' && r.players.get(ws.cid) === ws) { r.players.delete(ws.cid); out(r.host, { t: 'drop', cid: ws.cid }); }
}

// نبضة كل 30 ثانية: بتسكّر الاتصالات الميتة وبتحافظ على الحية
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) { try { ws.terminate(); } catch (e) {} return; }
    ws.isAlive = false; try { ws.ping(); } catch (e) {}
  });
}, 30000).unref();

// تنظيف القعدات المتروكة
setInterval(() => {
  const now = Date.now();
  rooms.forEach((r, code) => { if (!r.host && r.players.size === 0 && now - r.touched > ROOM_IDLE_MS) rooms.delete(code); });
}, 10 * 60 * 1000).unref();

stats.ready().then(() => {
  server.listen(PORT, () => console.log(`قعدة رواق شغّالة على المنفذ ${PORT} · الإحصائيات: ${STATS_KEY ? 'مفعّلة على /stats' : 'غير مفعّلة (حط STATS_KEY)'} · التخزين: ${stats.backend}`));
});

function shutdown() { stats.flush().finally(() => process.exit(0)); setTimeout(() => process.exit(0), 4000).unref(); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
