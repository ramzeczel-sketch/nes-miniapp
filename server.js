'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');
const { validateInitData } = require('./lib/telegram');
const { Lobbies } = require('./lib/lobbies');

// --- tiny .env loader (no extra dependency) ---
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
} catch (_) {}

const PORT = Number(process.env.PORT || 8795);
const BOT_TOKEN = process.env.BOT_TOKEN && !/^(|your_|<)/i.test(process.env.BOT_TOKEN) ? process.env.BOT_TOKEN : '';
const BOT_USERNAME = (process.env.BOT_USERNAME || '').replace(/^@/, '');
const APP_SHORT_NAME = process.env.APP_SHORT_NAME || '';
// When BOT_TOKEN is set, connections without valid initData are rejected, unless ALLOW_GUESTS=1
const ALLOW_GUESTS = process.env.ALLOW_GUESTS === '1' || !BOT_TOKEN;

// --- bundled (legally redistributable) game library ---
const ROM_DIR = path.join(__dirname, 'roms');
function loadGames() {
  let list = [];
  try { list = JSON.parse(fs.readFileSync(path.join(ROM_DIR, 'games.json'), 'utf8')); } catch (_) {}
  const out = [];
  for (const g of list) {
    const file = path.basename(String(g.file || ''));
    const p = path.join(ROM_DIR, file);
    if (!file.toLowerCase().endsWith('.nes') || !fs.existsSync(p)) continue;
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    out.push({ ...g, file, sha256, size: fs.statSync(p).size, players: g.players === 2 ? 2 : 1 });
  }
  return out;
}
const GAMES = loadGames();

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Telegram embeds the app in a webview, so we do not set X-Frame-Options.
  next();
});
app.get('/api/config', (req, res) => res.json({
  botUsername: BOT_USERNAME, appShortName: APP_SHORT_NAME, validate: !!BOT_TOKEN,
}));
app.get('/api/games', (req, res) => res.json(GAMES.map(g => ({ ...g, url: `/roms/${encodeURIComponent(g.file)}` }))));
app.get('/api/health', (req, res) => res.json({ ok: true, lobbies: lobbies.size, games: GAMES.length }));
app.use('/roms', express.static(ROM_DIR, { index: false, dotfiles: 'deny', setHeaders: r => r.setHeader('Cache-Control', 'public, max-age=3600') }));
app.use('/credits', express.static(path.join(__dirname, 'LICENSES'), { index: false }));
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html', maxAge: 0, etag: true }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });
const lobbies = new Lobbies();
const perIp = new Map();

function clientIp(req) {
  return (req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
}

wss.on('connection', (ws, req) => {
  const ip = clientIp(req);
  const n = (perIp.get(ip) || 0) + 1;
  if (n > 20) { ws.close(1013, 'too many connections'); return; }
  perIp.set(ip, n);
  ws.on('close', () => { const k = (perIp.get(ip) || 1) - 1; k ? perIp.set(ip, k) : perIp.delete(ip); });

  ws.isAlive = true;
  ws.authed = false;
  ws.name = 'Игрок';
  ws.tokens = 600; ws.tokenAt = Date.now();
  ws.on('pong', () => { ws.isAlive = true; });

  const send = o => lobbies.send(ws, o);
  const fail = (err) => send({ t: 'error', err });

  ws.on('message', (raw, isBinary) => {
    if (isBinary) return;
    // token-bucket rate limit: ~300 msg/s sustained, burst 600 (normal play: ~60 in-msgs/s)
    const now = Date.now();
    ws.tokens = Math.min(600, ws.tokens + (now - ws.tokenAt) * 0.3); ws.tokenAt = now;
    if (--ws.tokens < 0) return;

    let m;
    try { m = JSON.parse(raw.toString()); } catch (_) { return; }
    if (!m || typeof m.t !== 'string') return;

    if (m.t === 'hello') {
      let name = String(m.name || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 24);
      if (BOT_TOKEN) {
        const v = validateInitData(m.initData, BOT_TOKEN);
        if (v.ok) {
          ws.verified = true;
          ws.tgId = v.user && v.user.id;
          name = [v.user && v.user.first_name, v.user && v.user.last_name].filter(Boolean).join(' ').slice(0, 24) || name;
        } else if (!ALLOW_GUESTS) {
          send({ t: 'error', err: 'auth', reason: v.reason });
          ws.close(4401, 'auth');
          return;
        }
      }
      ws.name = name || 'Игрок';
      ws.authed = true;
      send({ t: 'welcome', name: ws.name, verified: !!ws.verified });
      return;
    }
    if (!ws.authed) return;

    switch (m.t) {
      case 'in':   // lockstep input: { f: frame, b: bitmask }
        if (Number.isInteger(m.f) && Number.isInteger(m.b)) lobbies.relay(ws, { t: 'in', f: m.f, b: m.b & 0xff });
        break;
      case 'sum':  // desync detection checksum
        if (Number.isInteger(m.f) && typeof m.h === 'number') lobbies.relay(ws, { t: 'sum', f: m.f, h: m.h });
        break;
      case 'create': { const r = lobbies.create(ws, m.game); if (r.err) fail(r.err); break; }
      case 'join':   { const r = lobbies.join(ws, m.code); if (r.err) fail('join_' + r.err); break; }
      case 'game':   { const r = lobbies.setGame(ws, m.game); if (r.err) fail(r.err); break; }
      case 'ready':  { const r = lobbies.setReady(ws, m.ready); if (r.err) fail(r.err); break; }
      case 'start':  { const r = lobbies.start(ws); if (r.err) fail('start_' + r.err); break; }
      case 'stop':   { const r = lobbies.stop(ws); if (r.err) fail(r.err); break; }
      case 'leave':  lobbies.leave(ws); send({ t: 'left' }); break;
      case 'ping':   if (Number.isFinite(m.rtt) && m.rtt >= 0 && m.rtt < 5000) ws.rtt = m.rtt; send({ t: 'pong', ts: m.ts }); break;
    }
  });

  ws.on('close', () => lobbies.leave(ws));
  ws.on('error', () => {});
});

// heartbeat: drop dead sockets so lobbies are released
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (_) {}
  }
  lobbies.gc();
}, 15000).unref();

server.listen(PORT, () => {
  console.log(`NES Mini App listening on :${PORT} | games: ${GAMES.length} | initData validation: ${BOT_TOKEN ? 'ON' : 'off (no BOT_TOKEN)'}`);
});
