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
const HANDOVER_MS = Number(process.env.HANDOVER_MS) || 45000; // بعد قديش من غياب الريس بيقدر حدا تاني ياخد الريسة
const MAX_SNAP = 2.5 * 1024 * 1024;

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
    r = { code, key: null, host: null, players: new Map(), touched: Date.now(), seen: new Set(), started: false, rounds: 0, finished: false, opened: false,
      snap: null, hostGoneAt: 0, offerTo: null, banned: new Set(), claimTimer: null };
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

  // الريس بيفتح القعدة أو بيرجع لها
  if (m.t === 'host') {
    if (ws.role) return;
    if (typeof m.code !== 'string' || !CODE_RE.test(m.code) || typeof m.key !== 'string' || !ID_RE.test(m.key)) return ws.close(4400, 'bad');
    const room = getRoom(m.code, true);
    if (!room) return out(ws, { t: 'busy' });
    if (room.key && room.key !== m.key) return out(ws, { t: 'taken' });
    room.key = m.key;
    if (room.host && room.host !== ws) { const old = room.host; room.host = null; try { old.close(4000, 'replaced'); } catch (e) {} }
    room.host = ws; ws.role = 'host'; ws.room = room; room.touched = Date.now();
    room.offerTo = null; clearTimeout(room.claimTimer);
    if (!room.opened) { room.opened = true; stats.event('room'); }
    out(ws, { t: 'host-ok' });
    
    toPlayers(room, { t: 'host-up' });
    return;
  }

  // لاعب بيفوت عالقعدة
  if (m.t === 'join') {
    if (ws.role) return;
    if (typeof m.code !== 'string' || !CODE_RE.test(m.code) || typeof m.cid !== 'string' || !ID_RE.test(m.cid)) return ws.close(4400, 'bad');
    const room = getRoom(m.code, true);
    if (!room) return out(ws, { t: 'busy' });
    if (room.banned.has(m.cid)) { out(ws, { t: 'kicked' }); return; }
    const old = room.players.get(m.cid);
    if (!old && room.players.size >= MAX_PLAYERS) return out(ws, { t: 'full' });
    if (old && old !== ws) { room.players.delete(m.cid); try { old.close(4001, 'replaced'); } catch (e) {} }
    room.players.set(m.cid, ws); ws.role = 'player'; ws.cid = m.cid; ws.room = room; room.touched = Date.now();
    if (!room.seen.has(m.cid)) { room.seen.add(m.cid); if (room.seen.size <= 200) stats.event('player'); }
    out(ws, { t: 'joined', host: !!room.host });
    if (canClaim(room, m.cid)) out(ws, { t: 'can-claim', direct: room.offerTo === m.cid });
    return;
  }

  if (!r) return;

  if (ws.role === 'host') {
    if (m.t === 'to' && typeof m.cid === 'string') { out(r.players.get(m.cid), { t: 'msg', msg: m.msg }); return; }
    if (m.t === 'all') { toPlayers(r, { t: 'msg', msg: m.msg }); return; }
    if (m.t === 'stat') { onStat(r, m); return; }
    // نسخة من حالة اللعبة، حتى إذا طلع الريس حدا تاني يكمّل
    if (m.t === 'snap') { const d = JSON.stringify(m.data || null); if (d.length < MAX_SNAP) r.snap = m.data; return; }
    // الريس طلّع لاعب: بينقطع وما بيقدر يرجع لهالقعدة
    if (m.t === 'kick' && typeof m.cid === 'string' && ID_RE.test(m.cid)) {
      r.banned.add(m.cid); r.seen.delete(m.cid);
      const p = r.players.get(m.cid);
      if (p) { out(p, { t: 'kicked' }); r.players.delete(m.cid); setTimeout(() => { try { p.close(4002, 'kicked'); } catch (e) {} }, 200); }
      return;
    }
    // الريس بيسلّم الريسة للاعب معيّن
    if (m.t === 'handover' && typeof m.cid === 'string' && r.players.has(m.cid)) {
      r.offerTo = m.cid; r.host = null; ws.role = null; ws.room = null;
      hostGone(r);
      out(r.players.get(m.cid), { t: 'can-claim', direct: true });
      return;
    }
    return;
  }

  // لاعب بدو ياخد الريسة
  if (ws.role === 'player' && m.t === 'claim') {
    if (typeof m.key !== 'string' || !ID_RE.test(m.key)) return;
    if (!canClaim(r, ws.cid)) return out(ws, { t: 'claim-fail' });
    r.key = m.key; r.offerTo = null; clearTimeout(r.claimTimer);
    out(ws, { t: 'claimed', snap: r.snap });
    r.players.forEach((p, cid) => { if (cid !== ws.cid) out(p, { t: 'claim-taken' }); });
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

function canClaim(r, cid) {
  if (r.host || !r.snap) return false;
  if (r.offerTo) return r.offerTo === cid;
  return Date.now() - r.hostGoneAt >= HANDOVER_MS;
}
function hostGone(r) {
  r.hostGoneAt = Date.now();
  toPlayers(r, { t: 'host-down', wait: r.offerTo ? 0 : HANDOVER_MS });
  clearTimeout(r.claimTimer);
  if (!r.offerTo) r.claimTimer = setTimeout(() => { if (!r.host && r.snap) toPlayers(r, { t: 'can-claim' }); }, HANDOVER_MS + 200);
}

function leave(ws) {
  const r = ws.room; if (!r) return;
  r.touched = Date.now();
  if (ws.role === 'host' && r.host === ws) { r.host = null; hostGone(r); }
  if (ws.role === 'player' && r.players.get(ws.cid) === ws) { r.players.delete(ws.cid); out(r.host, { t: 'drop', cid: ws.cid }); }
  if (ws.role === 'player' && r.offerTo === ws.cid && !r.host) { r.offerTo = null; hostGone(r); }
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
