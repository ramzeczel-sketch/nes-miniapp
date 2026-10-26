// Headless protocol test: two WebSocket clients create/join a lobby and exchange lockstep inputs.
const WebSocket = require('ws');
const crypto = require('crypto');
const { validateInitData } = require('../lib/telegram');
const URL = process.env.WS_URL || 'ws://localhost:8795/ws';
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };

function client(name) {
  const ws = new WebSocket(URL);
  const c = { ws, name, msgs: [], waiters: [] };
  ws.on('message', d => {
    const m = JSON.parse(d); c.msgs.push(m);
    let used = false;
    c.waiters = c.waiters.filter(w => { if (!used && w.f(m)) { used = true; w.r(m); return false; } return true; });
    if (used) c.msgs.pop();
  });
  c.send = o => ws.send(JSON.stringify(o));
  c.wait = (f, ms = 3000) => new Promise((r, j) => {
    const hit = c.msgs.find(f); if (hit) { c.msgs.splice(c.msgs.indexOf(hit), 1); return r(hit); }
    const w = { f, r }; c.waiters.push(w); setTimeout(() => j(new Error('timeout waiting on ' + name + ' ' + f)), ms);
  });
  return new Promise(r => ws.on('open', () => { c.send({ t: 'hello', name }); c.wait(m => m.t === 'welcome').then(() => r(c)); }));
}

(async () => {
  const game = { id: 'table-tennis', title: '8-Bit Table Tennis', hash: 'a'.repeat(64), bundled: true };
  const a = await client('Alice'), b = await client('Bob');
  ok(true, 'two clients connected and welcomed');

  a.send({ t: 'create', game });
  const l1 = await a.wait(m => m.t === 'lobby');
  ok(/^[A-Z2-9]{5}$/.test(l1.lobby.code) && l1.you === 1, 'host created lobby ' + l1.lobby.code);

  b.send({ t: 'join', code: 'ZZZZZ' });
  ok((await b.wait(m => m.t === 'error')).err === 'join_not_found', 'join unknown code -> error');

  b.send({ t: 'join', code: l1.lobby.code.toLowerCase() });
  const l2 = await b.wait(m => m.t === 'lobby');
  ok(l2.you === 2 && l2.lobby.players.length === 2, 'guest joined (you=2, 2 players)');
  await a.wait(m => m.t === 'lobby' && m.lobby.players.length === 2);

  const c = await client('Carol');
  c.send({ t: 'join', code: l1.lobby.code });
  ok((await c.wait(m => m.t === 'error')).err === 'join_full', 'third player rejected (lobby full)');

  a.send({ t: 'start' });
  ok((await a.wait(m => m.t === 'error')).err === 'start_not_ready', 'start before guest ready -> error');

  b.send({ t: 'ready', ready: true });
  const rd = await a.wait(m => m.t === 'lobby' && m.lobby.players[1] && m.lobby.players[1].ready);
  ok(!!rd, 'ready state propagated to host');

  b.send({ t: 'start' });
  ok((await b.wait(m => m.t === 'error')).err === 'start_forbidden', 'guest cannot start');

  a.send({ t: 'start' });
  const sa = await a.wait(m => m.t === 'start'), sb = await b.wait(m => m.t === 'start');
  ok(sa.delay === 4 && sb.delay === 4, 'start broadcast to both, input delay = ' + sa.delay);

  // lockstep input exchange: 600 frames each way (~60 msg/s per side)
  let gotA = 0, gotB = 0, bad = 0;
  a.ws.on('message', d => { const m = JSON.parse(d); if (m.t === 'in') { gotA++; if (m.b !== ((m.f * 3) & 0xff)) bad++; } });
  b.ws.on('message', d => { const m = JSON.parse(d); if (m.t === 'in') { gotB++; if (m.b !== (m.f & 0xff)) bad++; } });
  for (let f = 0; f < 600; f++) { a.send({ t: 'in', f, b: f & 0xff }); b.send({ t: 'in', f, b: (f * 3) & 0xff }); if (f % 6 === 5) await new Promise(r => setTimeout(r, 100)); }
  await new Promise(r => setTimeout(r, 400));
  ok(gotA === 600 && gotB === 600 && bad === 0, `inputs relayed both ways (A got ${gotA}, B got ${gotB}, corrupted ${bad})`);

  a.send({ t: 'sum', f: 60, h: 123456 });
  ok((await b.wait(m => m.t === 'sum')).h === 123456, 'checksum relayed');

  // guest disconnect during game
  b.ws.close();
  const pl = await a.wait(m => m.t === 'peer_left');
  ok(pl.wasPlaying === true, 'host notified when guest disconnects mid-game');
  const back = await a.wait(m => m.t === 'lobby' && m.lobby.state === 'lobby' && m.lobby.players.length === 1);
  ok(!!back, 'lobby returns to waiting state');

  // rejoin and host disconnect
  const b2 = await client('Bob2');
  b2.send({ t: 'join', code: l1.lobby.code });
  await b2.wait(m => m.t === 'lobby');
  a.ws.close();
  ok((await b2.wait(m => m.t === 'closed')).reason === 'host_left', 'guest notified when host disconnects');
  const b3 = await client('Late'); b3.send({ t: 'join', code: l1.lobby.code });
  ok((await b3.wait(m => m.t === 'error')).err === 'join_not_found', 'lobby removed after host left');

  // bad payloads must not crash the server
  b3.ws.send('not json'); b3.send({ t: 'create', game: { hash: 'zz' } });
  ok((await b3.wait(m => m.t === 'error')).err === 'bad_game', 'invalid game rejected');

  // initData HMAC validation unit test (fake token, never a real one)
  const token = '123456:TEST_TOKEN_NOT_REAL';
  const mk = (tok, authDate) => {
    const p = new URLSearchParams({ auth_date: String(authDate), user: JSON.stringify({ id: 1, first_name: 'Test' }), query_id: 'AAA' });
    const dcs = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(tok).digest();
    p.set('hash', crypto.createHmac('sha256', secret).update(dcs).digest('hex'));
    return p.toString();
  };
  const now = Math.floor(Date.now() / 1000);
  ok(validateInitData(mk(token, now), token).ok, 'initData: valid signature accepted');
  ok(!validateInitData(mk('999:OTHER', now), token).ok, 'initData: wrong token rejected');
  ok(!validateInitData(mk(token, now - 999999), token).ok, 'initData: expired rejected');
  ok(!validateInitData(mk(token, now).replace('Test', 'Evil'), token).ok, 'initData: tampered rejected');

  console.log(fails ? `\n${fails} FAILED` : '\nALL NET TESTS PASSED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('ERROR', e); process.exit(1); });
