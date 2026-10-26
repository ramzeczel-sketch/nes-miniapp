'use strict';
const crypto = require('crypto');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const INPUT_DELAY = 4;           // frames of input delay for lockstep
const LOBBY_TTL_MS = 6 * 3600e3; // hard cap on lobby life
const MAX_LOBBIES = 2000;

function genCode(existing) {
  for (let tries = 0; tries < 50; tries++) {
    let s = '';
    const buf = crypto.randomBytes(5);
    for (let i = 0; i < 5; i++) s += CODE_ALPHABET[buf[i] % CODE_ALPHABET.length];
    if (!existing.has(s)) return s;
  }
  throw new Error('code space exhausted');
}

const cleanStr = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);

function cleanGame(g) {
  if (!g || typeof g !== 'object') return null;
  const hash = String(g.hash || '').toLowerCase();
  if (!/^[0-9a-f]{16,64}$/.test(hash)) return null;
  return {
    id: cleanStr(g.id, 64),
    title: cleanStr(g.title, 60) || 'Игра',
    hash,
    bundled: !!g.bundled,
    players: 2,
  };
}

class Lobbies {
  constructor() { this.map = new Map(); }

  get size() { return this.map.size; }

  send(ws, obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  publicState(l) {
    return {
      code: l.code,
      state: l.state,
      game: l.game,
      delay: INPUT_DELAY,
      players: [
        { slot: 1, name: l.host.name, ready: true, role: 'host' },
        l.guest ? { slot: 2, name: l.guest.name, ready: !!l.guest.ready, role: 'guest' } : null,
      ].filter(Boolean),
    };
  }

  broadcast(l) {
    const lobby = this.publicState(l);
    this.send(l.host, { t: 'lobby', lobby, you: 1 });
    this.send(l.guest, { t: 'lobby', lobby, you: 2 });
  }

  create(ws, game) {
    if (this.map.size >= MAX_LOBBIES) return { err: 'busy' };
    const g = cleanGame(game);
    if (!g) return { err: 'bad_game' };
    this.leave(ws);
    const code = genCode(this.map);
    const l = { code, host: ws, guest: null, game: g, state: 'lobby', created: Date.now() };
    ws.lobby = l; ws.slot = 1; ws.ready = true;
    this.map.set(code, l);
    this.broadcast(l);
    return { ok: true };
  }

  join(ws, code) {
    code = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const l = this.map.get(code);
    if (!l) return { err: 'not_found' };
    if (l.host === ws) return { err: 'own' };
    if (l.guest && l.guest !== ws) return { err: 'full' };
    if (l.state === 'playing' && l.guest !== ws) return { err: 'in_game' };
    this.leave(ws);
    l.guest = ws; ws.lobby = l; ws.slot = 2; ws.ready = false;
    this.broadcast(l);
    return { ok: true };
  }

  setGame(ws, game) {
    const l = ws.lobby;
    if (!l || l.host !== ws || l.state !== 'lobby') return { err: 'forbidden' };
    const g = cleanGame(game);
    if (!g) return { err: 'bad_game' };
    l.game = g;
    if (l.guest) l.guest.ready = false;
    this.broadcast(l);
    return { ok: true };
  }

  setReady(ws, ready) {
    const l = ws.lobby;
    if (!l || l.guest !== ws || l.state !== 'lobby') return { err: 'forbidden' };
    ws.ready = !!ready;
    this.broadcast(l);
    return { ok: true };
  }

  start(ws) {
    const l = ws.lobby;
    if (!l || l.host !== ws || l.state !== 'lobby') return { err: 'forbidden' };
    if (!l.guest) return { err: 'no_guest' };
    if (!l.guest.ready) return { err: 'not_ready' };
    l.state = 'playing';
    l.startedAt = Date.now();
    this.broadcast(l);
    // задержка ввода по реальному пингу игроков: односторонний путь друг–друг ≈ (rtt1 + rtt2) / 2
    const r1 = l.host.rtt, r2 = l.guest.rtt;
    let delay = 8;
    if (Number.isFinite(r1) && Number.isFinite(r2)) delay = Math.ceil(((r1 + r2) / 2) / 16.7) + 4;
    delay = Math.max(6, Math.min(16, delay));
    const msg = { t: 'start', delay, hash: l.game.hash };
    this.send(l.host, msg);
    this.send(l.guest, msg);
    return { ok: true };
  }

  stop(ws) {
    const l = ws.lobby;
    if (!l || l.state !== 'playing') return { err: 'forbidden' };
    l.state = 'lobby';
    if (l.guest) l.guest.ready = false;
    this.send(l.host, { t: 'stopped', by: ws.slot });
    this.send(l.guest, { t: 'stopped', by: ws.slot });
    this.broadcast(l);
    return { ok: true };
  }

  /** Relay time-critical messages (input / checksum) to the other player. */
  relay(ws, msg) {
    const l = ws.lobby;
    if (!l || l.state !== 'playing') return;
    const peer = l.host === ws ? l.guest : l.host;
    this.send(peer, msg);
  }

  /** Called on explicit leave and on socket close/disconnect. */
  leave(ws) {
    const l = ws.lobby;
    if (!l) return;
    ws.lobby = null; ws.slot = 0; ws.ready = false;
    if (l.host === ws) {
      this.send(l.guest, { t: 'closed', reason: 'host_left' });
      if (l.guest) { l.guest.lobby = null; l.guest.slot = 0; l.guest.ready = false; }
      this.map.delete(l.code);
    } else if (l.guest === ws) {
      l.guest = null;
      const wasPlaying = l.state === 'playing';
      l.state = 'lobby';
      this.send(l.host, { t: 'peer_left', wasPlaying });
      this.broadcast(l);
    }
  }

  gc() {
    const now = Date.now();
    for (const l of this.map.values()) {
      if (now - l.created > LOBBY_TTL_MS) {
        this.send(l.host, { t: 'closed', reason: 'expired' });
        this.send(l.guest, { t: 'closed', reason: 'expired' });
        if (l.host) { l.host.lobby = null; }
        if (l.guest) { l.guest.lobby = null; }
        this.map.delete(l.code);
      }
    }
  }
}

module.exports = { Lobbies, INPUT_DELAY };
