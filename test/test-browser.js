// Headless Chrome test: emulator boots every bundled ROM, UI creates/joins a lobby, lockstep netplay stays in sync.
const { chromium } = require('playwright-core');
const BASE = process.env.BASE_URL || 'http://localhost:8795';
const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  const mkPage = async (name) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true });
    const page = await ctx.newPage();
    page.on('pageerror', e => { console.log(`[${name}] pageerror:`, e.message); fails++; });
    page.on('console', m => { if (m.type() === 'error' && !/telegram|ERR_|Failed to load resource/.test(m.text())) console.log(`[${name}] console.error:`, m.text()); });
    return page;
  };

  // ---------- 1. library + emulator boots every bundled ROM ----------
  const p1 = await mkPage('solo');
  await p1.goto(BASE); await p1.waitForSelector('.gcard');
  const n = await p1.locator('#grid .gcard').count();
  ok(n === 4, `library shows ${n} bundled games`);
  await p1.screenshot({ path: '/tmp/shot-library.png' });

  const roms = await p1.evaluate(async () => {
    const out = [];
    for (const g of __app.state.games) {
      const buf = await (await fetch(g.url)).arrayBuffer();
      const hash = await Store.sha256hex(buf);
      const info = __app.emu.load(buf);
      let lit = false;
      for (let f = 0; f < 240; f++) { __app.emu.frame(f > 60 && f < 70 ? Pad.B.start : 0, 0); if (f > 100 && __app.emu.nonBlank()) lit = true; }
      out.push({ id: g.id, mapper: info.mapper, supported: info.supported, hashOk: hash === g.sha256, lit });
    }
    return out;
  });
  for (const r of roms) ok(r.hashOk && r.supported && r.lit, `ROM boots & renders: ${r.id} (mapper ${r.mapper}, sha256 matches, picture non-blank)`);

  // ---------- 2. solo via UI ----------
  await p1.click('.gcard[data-id="table-tennis"]');
  await p1.click('#sheetActions .btn:first-child');
  await p1.waitForSelector('#screen-play.active');
  await sleep(1500);
  const solo = await p1.evaluate(() => ({ frames: __app.emu.frames, lit: __app.emu.nonBlank() }));
  ok(solo.frames > 60 && solo.lit, `solo play runs (${solo.frames} frames in 1.5s)`);
  await p1.screenshot({ path: '/tmp/shot-solo.png' });
  await p1.click('#playExit');
  await p1.waitForSelector('#screen-library.active');

  // ---------- 3. two players: lobby via UI + lockstep ----------
  const A = await mkPage('host'), B = await mkPage('guest');
  await A.goto(BASE); await A.waitForSelector('.gcard');
  await A.click('.gcard[data-id="table-tennis"]');
  await A.click('#sheetActions .btn:nth-child(2)');
  await A.waitForSelector('#screen-lobby.active');
  await A.waitForFunction(() => /^[A-Z2-9]{5}$/.test(document.querySelector('#lobbyCode').textContent));
  const code = await A.textContent('#lobbyCode');
  ok(true, 'host lobby created, code ' + code);
  await A.screenshot({ path: '/tmp/shot-lobby-host.png' });

  await B.goto(`${BASE}/?lobby=${code}`);
  await B.waitForSelector('#screen-lobby.active');
  await B.waitForSelector('#readyBtn:not(.hidden)');
  ok((await A.locator('#players li').count()) === 2 || await A.waitForFunction(() => document.querySelectorAll('#players li:not(.empty)').length === 2).then(() => true), 'host sees 2 players');
  ok(await A.locator('#startBtn').isDisabled(), 'start disabled until guest is ready');
  await B.click('#readyBtn');
  await A.waitForFunction(() => !document.querySelector('#startBtn').disabled);
  ok(true, 'ready state: start enabled for host');
  await B.screenshot({ path: '/tmp/shot-lobby-guest.png' });

  // record checksums sent by each side
  for (const P of [A, B]) await P.evaluate(() => {
    window.__sums = {}; const orig = __app.net.send.bind(__app.net);
    __app.net.send = (o) => { if (o.t === 'sum') window.__sums[o.f] = o.h; return orig(o); };
  });
  await A.click('#startBtn');
  await A.waitForSelector('#screen-play.active'); await B.waitForSelector('#screen-play.active');
  // drive inputs: both press Start (title screen), then wiggle
  await sleep(800);
  await A.evaluate(() => Pad._press('start', true)); await sleep(150); await A.evaluate(() => Pad._press('start', false));
  await B.evaluate(() => Pad._press('start', true)); await sleep(150); await B.evaluate(() => Pad._press('start', false));
  for (let i = 0; i < 12; i++) {
    await A.evaluate(i => { Pad._press('up', i % 2 === 0); Pad._press('down', i % 2 === 1); Pad._press('a', i % 3 === 0); }, i);
    await B.evaluate(i => { Pad._press('down', i % 2 === 0); Pad._press('up', i % 2 === 1); Pad._press('a', i % 4 === 0); }, i);
    await sleep(500);
  }
  const sA = await A.evaluate(() => ({ f: __app.state.play.net.f, desync: __app.state.play.desync, lit: __app.emu.nonBlank(), sums: window.__sums }));
  const sB = await B.evaluate(() => ({ f: __app.state.play.net.f, desync: __app.state.play.desync, lit: __app.emu.nonBlank(), sums: window.__sums }));
  ok(sA.f > 200 && sB.f > 200, `both emulators advanced in lockstep (host frame ${sA.f}, guest frame ${sB.f})`);
  ok(Math.abs(sA.f - sB.f) <= 12, `frame counters within input-delay window (diff ${Math.abs(sA.f - sB.f)})`);
  const common = Object.keys(sA.sums).filter(k => k in sB.sums);
  const mism = common.filter(k => sA.sums[k] !== sB.sums[k]);
  ok(common.length >= 3 && mism.length === 0, `emulator state checksums identical on ${common.length} common frames (mismatches: ${mism.length})`);
  const distinct = new Set(Object.values(sA.sums)).size;
  ok(distinct > 1, `checksums change over time (${distinct} distinct values => state evolves with inputs)`);
  ok(!sA.desync && !sB.desync && sA.lit && sB.lit, 'no desync flag, picture rendered on both');
  await A.screenshot({ path: '/tmp/shot-play-host.png' }); await B.screenshot({ path: '/tmp/shot-play-guest.png' });

  // ---------- 4. disconnect handling ----------
  await B.context().close();
  await A.waitForSelector('#screen-lobby.active', { timeout: 8000 });
  const txt = await A.locator('#players li').allTextContents();
  ok(txt.some(t => /Ждём друга/.test(t)), 'host returned to lobby after guest disconnected');

  await browser.close();
  console.log(fails ? `\n${fails} FAILED` : '\nALL BROWSER TESTS PASSED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('ERROR', e); process.exit(1); });
