(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const STEP = 1000 / 60.0988;

  const state = {
    config: { botUsername: '', appShortName: '' },
    games: [],          // встроенные (легальные) игры
    mine: [],           // мои игры из IndexedDB
    lobby: null,        // последнее состояние лобби с сервера
    slot: 0,            // 1 — хост, 2 — гость
    pick: false,        // режим выбора игры для лобби
    romCache: new Map(),// hash -> ArrayBuffer
    hasRom: false,
    play: null,         // активная игра
    pendingJoin: null,
    myName: TG.userName(),
  };
  const net = new Net();
  const emu = new Emu($('#screen'));
  window.__app = { state, emu, net };   // для отладки/автотестов

  // ---------- утилиты UI ----------
  function toast(msg, ms = 2800) {
    const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), ms);
  }
  const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function show(name) {
    document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === 'screen-' + name));
    state.screen = name;
    updateBack();
  }
  function updateBack() {
    if (!$('#sheet').classList.contains('hidden')) return TG.setBack(closeSheet);
    if (state.screen === 'play') return TG.setBack(exitPlay);
    if (state.screen === 'lobby') return TG.setBack(leaveLobby);
    if (state.pick) return TG.setBack(cancelPick);
    TG.setBack(null);
  }
  const ERR = {
    join_not_found: 'Лобби с таким кодом не найдено',
    join_full: 'В лобби уже есть второй игрок',
    join_in_game: 'В этом лобби уже идёт игра',
    join_own: 'Это ваше лобби',
    busy: 'Сервер перегружен, попробуйте позже',
    bad_game: 'Не удалось выбрать эту игру',
    start_no_guest: 'Ещё никто не зашёл в лобби',
    start_not_ready: 'Друг ещё не готов',
    auth: 'Откройте приложение из Telegram',
  };

  // ---------- библиотека ----------
  const ICONS = ['🕹️', '👾', '🚀', '🏓', '🧱', '🐍', '⚔️', '🏎️', '🏀', '🎯'];
  function iconFor(g) { let h = 0; for (const c of g.id) h = (h * 31 + c.charCodeAt(0)) >>> 0; return ICONS[h % ICONS.length]; }

  function cardHtml(g, user) {
    return `<div class="gcard" data-id="${esc(g.id)}">
      <div class="ico">${iconFor(g)}</div>
      <div class="t">${esc(g.title)}</div>
      <div class="m"><span class="badge ${g.players === 2 ? 'p2' : ''}">${g.players === 2 ? '👥 1–2 игрока' : '👤 1 игрок'}</span>${user ? ' <span class="badge">мой файл</span>' : ''}</div>
    </div>`;
  }
  function renderLibrary() {
    const list = (arr) => (state.pick ? arr.filter(g => g.players === 2) : arr);
    $('#grid').innerHTML = list(state.games).map(g => cardHtml(g, false)).join('') || '<p class="hint">Встроенных игр нет — загрузите свой .nes файл.</p>';
    const mine = list(state.mine);
    $('#myTitle').classList.toggle('hidden', !mine.length);
    $('#myGrid').innerHTML = mine.map(g => cardHtml(g, true)).join('');
    $('#hello').textContent = 'Привет, ' + state.myName + '!';
    $('#pickBanner').classList.toggle('hidden', !state.pick);
    $('#joinBox').classList.toggle('hidden', state.pick);
    $('#uploadBtn').parentElement.classList.toggle('hidden', false);
  }
  const findGame = (id) => state.games.find(g => g.id === id) || state.mine.find(g => g.id === id);

  async function loadMine() {
    const recs = await Store.list();
    state.mine = recs.sort((a, b) => b.added - a.added).map(r => ({
      id: 'u:' + r.hash.slice(0, 12), title: r.title, players: r.players === 2 ? 2 : 1, hash: r.hash, bundled: false, user: true,
      size: r.data ? r.data.byteLength : 0,
    }));
    renderLibrary();
  }

  function onGridClick(e) {
    const c = e.target.closest('.gcard'); if (!c) return;
    const g = findGame(c.dataset.id); if (!g) return;
    TG.haptic('light');
    if (state.pick) return pickGame(g);
    openSheet(g);
  }
  $('#grid').addEventListener('click', onGridClick);
  $('#myGrid').addEventListener('click', onGridClick);

  function openSheet(g) {
    const body = $('#sheetBody');
    const meta = g.user
      ? `<p class="meta">Ваш собственный файл · ${(g.size / 1024).toFixed(0)} КБ · хранится только в этом браузере</p>`
      : `<p class="meta">Автор: ${esc(g.author || '—')} · Лицензия: ${esc(g.license || '—')} · <a href="${esc(g.source || '#')}" target="_blank" rel="noopener">источник</a></p>`;
    body.innerHTML = `<h3>${esc(g.title)}</h3>
      <p><span class="badge ${g.players === 2 ? 'p2' : ''}">${g.players === 2 ? '👥 можно вдвоём' : '👤 один игрок'}</span></p>
      <p>${esc(g.desc || '')}</p>${meta}
      <p class="meta">Управление: стрелки · X = A · Z = B · Enter = Start · Shift = Select</p>`;
    const act = $('#sheetActions'); act.innerHTML = '';
    const b1 = document.createElement('button'); b1.className = 'btn'; b1.textContent = '▶ Играть одному';
    b1.onclick = () => { closeSheet(); startSolo(g); }; act.appendChild(b1);
    if (g.players === 2) {
      const b2 = document.createElement('button'); b2.className = 'btn'; b2.textContent = '👥 Играть с другом';
      b2.onclick = () => { closeSheet(); createLobby(g); }; act.appendChild(b2);
    }
    if (g.user) {
      const b3 = document.createElement('button'); b3.className = 'btn ghost'; b3.textContent = '🗑 Удалить';
      b3.onclick = async () => { if (confirm('Удалить этот файл из браузера?')) { await Store.del(g.hash); state.romCache.delete(g.hash); closeSheet(); loadMine(); } };
      act.appendChild(b3);
    }
    $('#sheet').classList.remove('hidden'); updateBack();
  }
  function closeSheet() { $('#sheet').classList.add('hidden'); updateBack(); }
  $('#sheetClose').onclick = closeSheet;
  $('#sheet').addEventListener('click', e => { if (e.target.id === 'sheet') closeSheet(); });

  // ---------- загрузка ROM ----------
  async function getRom(g) {
    if (g.hash && state.romCache.has(g.hash)) return state.romCache.get(g.hash);
    let buf = null;
    if (g.bundled !== false && g.url) {
      const r = await fetch(g.url); if (!r.ok) throw new Error('Не удалось загрузить игру');
      buf = await r.arrayBuffer();
    } else if (g.user) {
      const rec = await Store.get(g.hash); if (!rec) throw new Error('Файл не найден в браузере');
      buf = rec.data;
    }
    if (!buf) throw new Error('Нет данных игры');
    if (g.hash) state.romCache.set(g.hash, buf);
    return buf;
  }
  const gameHash = (g) => g.hash || g.sha256;

  $('#uploadBtn').onclick = () => $('#fileInput').click();
  $('#fileInput').onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (f) handleUploadedFile(f, null);
  };

  /** forHash — если файл нужен для конкретного лобби: проверяем совпадение хэша */
  async function handleUploadedFile(file, forHash) {
    const buf = await file.arrayBuffer();
    const info = EmuUtil.inspect(buf);
    if (!info.ok) return toast(info.error);
    const hash = await Store.sha256hex(buf);
    if (forHash) {
      if (hash !== forHash) return toast('Это другой файл — не совпадает с игрой хоста');
      state.romCache.set(hash, buf);
      const exist = await Store.get(hash);
      if (!exist) await Store.put({ hash, title: (state.lobby && state.lobby.game.title) || file.name.replace(/\.nes$/i, ''), players: 2, data: buf, added: Date.now() });
      await loadMine(); await refreshHasRom(); renderLobby();
      return toast('Файл подошёл ✅');
    }
    if (!info.supported) toast(`Внимание: маппер ${info.mapper} может не поддерживаться эмулятором`, 4500);
    // Окно с названием и признаком «для двоих»
    const body = $('#sheetBody');
    body.innerHTML = `<h3>Новая игра</h3><p class="meta">${esc(file.name)} · ${(buf.byteLength / 1024).toFixed(0)} КБ · маппер ${info.mapper}</p>
      <input type="text" id="upTitle" maxlength="40" value="${esc(file.name.replace(/\.nes$/i, ''))}">
      <label><input type="checkbox" id="up2p"> Игра рассчитана на двоих (можно звать друга)</label>
      <p class="meta">Файл останется только в вашем браузере. Другу для игры вдвоём нужен такой же файл.</p>`;
    const act = $('#sheetActions'); act.innerHTML = '';
    const ok = document.createElement('button'); ok.className = 'btn'; ok.textContent = 'Сохранить';
    ok.onclick = async () => {
      const title = ($('#upTitle').value || 'Моя игра').slice(0, 40);
      const players = $('#up2p').checked ? 2 : 1;
      await Store.put({ hash, title, players, data: buf, added: Date.now() });
      state.romCache.set(hash, buf);
      closeSheet(); await loadMine(); toast('Игра добавлена');
    };
    act.appendChild(ok);
    $('#sheet').classList.remove('hidden'); updateBack();
  }

  // ---------- игра ----------
  function lobbyGameDesc(g) {
    return { id: g.id, title: g.title, hash: gameHash(g), bundled: !!g.bundled && !g.user };
  }

  async function startSolo(g) {
    try {
      emu.initAudio();
      const buf = await getRom(g);
      const info = emu.load(buf);
      if (!info.supported) toast(`Маппер ${info.mapper} не поддерживается — игра может не работать`, 4500);
      beginPlay({ mode: 'solo', title: g.title });
    } catch (err) { toast(err.message || 'Ошибка запуска'); }
  }

  function beginPlay(p) {
    state.play = Object.assign({ acc: 0, last: performance.now(), stalledSince: 0, running: true, desync: false }, p);
    $('#playInfo').textContent = p.mode === 'solo' ? p.title : '';
    $('#overlay').classList.add('hidden');
    show('play');
    Pad.setActive(true);
    TG.confirmClose(true);
    requestAnimationFrame(loop);
  }

  function endPlay() {
    if (!state.play) return;
    state.play.running = false; state.play = null;
    Pad.setActive(false);
    TG.confirmClose(false);
    emu.setMuted(false); $('#muteBtn').textContent = '🔊';
  }

  function exitPlay() {
    const p = state.play; if (!p) return;
    if (p.mode === 'net') { net.send({ t: 'stop' }); }   // вернёт обоих в лобби
    else { endPlay(); show('library'); renderLibrary(); }
  }
  $('#playExit').onclick = exitPlay;
  $('#muteBtn').onclick = () => {
    emu.audio.muted = !emu.audio.muted; $('#muteBtn').textContent = emu.audio.muted ? '🔇' : '🔊'; emu.initAudio();
  };

  function overlay(msg) {
    const o = $('#overlay');
    if (msg) { o.textContent = msg; o.classList.remove('hidden'); } else o.classList.add('hidden');
  }

  function loop(now) {
    const p = state.play; if (!p || !p.running) return;
    requestAnimationFrame(loop);
    let dt = now - p.last; p.last = now;
    if (dt > 250) dt = STEP;
    p.acc = Math.min(p.acc + dt, STEP * 5);

    if (p.mode === 'solo') {
      while (p.acc >= STEP) { emu.frame(Pad.p1(), Pad.p2local()); p.acc -= STEP; }
      return;
    }
    // ---- детерминированный lockstep ----
    const ns = p.net;
    let stalled = false;
    while (p.acc >= STEP) {
      if (!ns.remote.has(ns.f)) { stalled = true; break; }
      const mine = Pad.p1();
      const target = ns.f + ns.delay;
      ns.local.set(target, mine);
      net.send({ t: 'in', f: target, b: mine });
      const lc = ns.local.get(ns.f), rc = ns.remote.get(ns.f);
      ns.local.delete(ns.f); ns.remote.delete(ns.f);
      emu.frame(ns.slot === 1 ? lc : rc, ns.slot === 1 ? rc : lc);
      ns.f++; p.acc -= STEP;
      if (ns.f % 60 === 0) {
        const h = emu.checksum();
        ns.sums.set(ns.f, h);
        net.send({ t: 'sum', f: ns.f, h });
        if (ns.peerSums.has(ns.f)) checkSum(ns, ns.f);
      }
    }
    const t = performance.now();
    if (stalled) {
      if (!p.stalledSince) p.stalledSince = t;
      const d = t - p.stalledSince;
      if (d > 8000) overlay('Нет связи с другом…\nМожно выйти и вернуться в лобби');
      else if (d > 1200) overlay('⏳ Ждём ввод друга…');
    } else if (p.stalledSince) { p.stalledSince = 0; if (!p.desync) overlay(null); }
    p.info = p.info || 0;
    if (t - p.info > 1000) {
      p.info = t;
      $('#playInfo').textContent = `Вы — игрок ${ns.slot}${ns.slot === 1 ? ' (хост)' : ''} · ${p.title}` + (net.rtt != null ? ` · ${net.rtt} мс` : '');
    }
  }

  function checkSum(ns, f) {
    const mine = ns.sums.get(f), theirs = ns.peerSums.get(f);
    ns.sums.delete(f); ns.peerSums.delete(f);
    if (mine !== theirs && !state.play.desync) {
      state.play.desync = true;
      ns.desyncAt = f;
      overlay('⚠️ Рассинхронизация игры.\nВыйдите в лобби и начните заново.');
    }
  }

  net.on('in', (m) => {
    const p = state.play; if (!p || p.mode !== 'net') return;
    p.net.remote.set(m.f, m.b);
  });
  net.on('sum', (m) => {
    const p = state.play; if (!p || p.mode !== 'net') return;
    p.net.peerSums.set(m.f, m.h);
    if (p.net.sums.has(m.f)) checkSum(p.net, m.f);
  });

  net.on('start', async (m) => {
    const l = state.lobby; if (!l) return;
    try {
      emu.initAudio();
      const buf = state.romCache.get(l.game.hash);
      if (!buf) throw new Error('Нет файла игры');
      emu.load(buf);
      const delay = m.delay || 4;
      const ns = { slot: state.slot, delay, f: 0, local: new Map(), remote: new Map(), sums: new Map(), peerSums: new Map() };
      for (let i = 0; i < delay; i++) { ns.local.set(i, 0); ns.remote.set(i, 0); }
      beginPlay({ mode: 'net', title: l.game.title, net: ns });
    } catch (err) { toast(err.message); net.send({ t: 'stop' }); }
  });
  net.on('stopped', (m) => {
    if (state.play) { endPlay(); toast(m.by === state.slot ? 'Игра завершена' : 'Друг завершил игру'); }
    if (state.lobby) show('lobby');
  });

  // ---------- лобби ----------
  function createLobby(g) {
    state.pendingCreate = g;
    getRom(g).then(() => { net.send({ t: 'create', game: lobbyGameDesc(g) }); }).catch(e => toast(e.message));
  }
  function joinLobby(code) {
    code = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length < 4) return toast('Введите код лобби');
    net.send({ t: 'join', code });
  }
  $('#joinBtn').onclick = () => joinLobby($('#joinCode').value);
  $('#joinCode').addEventListener('keydown', e => { if (e.key === 'Enter') joinLobby(e.target.value); });
  function leaveLobby() {
    if (state.play) endPlay();
    net.send({ t: 'leave' });
    state.lobby = null; state.slot = 0;
    show('library'); renderLibrary();
  }
  $('#lobbyBack').onclick = leaveLobby;

  function inviteLink(code) {
    const bot = state.config.botUsername;
    if (bot) return state.config.appShortName ? `https://t.me/${bot}/${state.config.appShortName}?startapp=${code}` : `https://t.me/${bot}?startapp=${code}`;
    return `${location.origin}/?lobby=${code}`;
  }
  $('#shareBtn').onclick = () => {
    const l = state.lobby; if (!l) return;
    TG.share(inviteLink(l.code), `Го играть вдвоём в «${l.game.title}» на Денди! Код лобби: ${l.code}`);
  };
  $('#copyBtn').onclick = async () => {
    const l = state.lobby; if (!l) return;
    const link = inviteLink(l.code);
    try { await navigator.clipboard.writeText(link); toast('Ссылка скопирована'); }
    catch (_) { prompt('Скопируйте ссылку:', link); }
  };

  function pickGame(g) {
    state.pick = false; renderLibrary();
    getRom(g).then(() => { net.send({ t: 'game', game: lobbyGameDesc(g) }); show('lobby'); }).catch(e => toast(e.message));
  }
  function cancelPick() { state.pick = false; renderLibrary(); show('lobby'); }
  $('#pickCancel').onclick = cancelPick;
  $('#changeGame').onclick = () => { state.pick = true; renderLibrary(); show('library'); };

  /** есть ли у нас файл с хэшем игры лобби (встроенный / мой / из кэша) */
  async function refreshHasRom() {
    const l = state.lobby; if (!l) { state.hasRom = false; return; }
    const h = l.game.hash;
    if (state.romCache.has(h)) { state.hasRom = true; return; }
    const builtin = state.games.find(g => g.sha256 === h);
    try {
      if (builtin) { await getRom({ ...builtin, hash: builtin.sha256, bundled: true }); state.hasRom = true; return; }
      const rec = await Store.get(h);
      if (rec) { state.romCache.set(h, rec.data); state.hasRom = true; return; }
    } catch (_) {}
    state.hasRom = false;
  }

  function renderLobby() {
    const l = state.lobby; if (!l) return;
    const isHost = state.slot === 1;
    $('#lobbyCode').textContent = l.code;
    $('#lobbyGame').textContent = '🎮 ' + l.game.title;
    $('#changeGame').classList.toggle('hidden', !isHost);
    const me = l.players.find(p => p.slot === state.slot);
    const guest = l.players.find(p => p.slot === 2);
    $('#players').innerHTML = [
      ...l.players.map(p => `<li><span>${p.slot === 1 ? '🥇' : '🥈'}</span><span class="pn">${esc(p.name)}${p.slot === state.slot ? ' (вы)' : ''}</span><span class="role">${p.slot === 1 ? 'хост · игрок 1' : 'игрок 2'}</span><span class="st">${p.ready ? '✅' : '⏳'}</span></li>`),
      guest ? '' : '<li class="empty"><span>🥈</span><span class="pn">Ждём друга…</span></li>',
    ].join('');

    const notice = $('#lobbyNotice'); notice.classList.add('hidden');
    $('#getRomBtn').classList.add('hidden'); $('#readyBtn').classList.add('hidden'); $('#startBtn').classList.add('hidden');
    let hint = '';
    if (isHost) {
      $('#startBtn').classList.remove('hidden');
      $('#startBtn').disabled = !(guest && guest.ready);
      hint = !guest ? 'Отправьте другу ссылку или код. Когда он зайдёт и нажмёт «Готов», можно начинать.' : (guest.ready ? 'Друг готов — жмите «Начать игру».' : 'Ждём, пока друг нажмёт «Готов».');
    } else {
      if (state.hasRom) {
        $('#readyBtn').classList.remove('hidden');
        $('#readyBtn').textContent = me && me.ready ? '⏸ Не готов' : '✅ Готов';
        hint = me && me.ready ? 'Ждём, пока хост начнёт игру.' : 'Нажмите «Готов», когда будете готовы.';
      } else {
        $('#getRomBtn').classList.remove('hidden');
        notice.classList.remove('hidden');
        notice.textContent = 'Эта игра — ваш собственный файл хоста. Загрузите точно такой же .nes файл (проверяется по хэшу), чтобы играть вместе.';
        hint = '';
      }
    }
    $('#lobbyHint').textContent = hint;
  }

  $('#readyBtn').onclick = () => {
    const me = state.lobby.players.find(p => p.slot === state.slot);
    net.send({ t: 'ready', ready: !(me && me.ready) });
  };
  $('#startBtn').onclick = () => { net.send({ t: 'start' }); };
  $('#getRomBtn').onclick = () => {
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.nes';
    inp.onchange = () => inp.files[0] && handleUploadedFile(inp.files[0], state.lobby.game.hash);
    inp.click();
  };

  net.on('lobby', async (m) => {
    const prevHash = state.lobby && state.lobby.game.hash;
    state.lobby = m.lobby;
    state.slot = m.you;
    state.pendingCreate = null;
    if (state.play && m.lobby.state !== 'playing') { endPlay(); }
    await refreshHasRom();
    if (!state.pick && !state.play) show('lobby');
    renderLobby();
    if (prevHash && prevHash !== m.lobby.game.hash && state.slot === 2) toast('Хост выбрал другую игру');
  });
  net.on('peer_left', (m) => { toast(m.wasPlaying ? 'Друг отключился — игра остановлена' : 'Друг вышел из лобби'); if (state.play) endPlay(); });
  net.on('closed', (m) => {
    if (state.play) endPlay();
    state.lobby = null; state.slot = 0; state.pick = false;
    toast(m.reason === 'host_left' ? 'Хост закрыл лобби' : 'Лобби закрыто');
    show('library'); renderLibrary();
  });
  net.on('left', () => {});
  net.on('error', (m) => {
    if (m.err === 'auth') return toast(ERR.auth, 6000);
    toast(ERR[m.err] || 'Ошибка: ' + m.err);
    state.pendingCreate = null;
  });
  net.on('welcome', () => {
    if (state.pendingJoin) { const c = state.pendingJoin; state.pendingJoin = null; state.slot = 0; joinLobby(c); }
    else if (state.lobby && !state.play) { /* после переподключения лобби на сервере уже нет */ }
  });
  net.on('close', () => {
    if (state.lobby) {
      if (state.play) endPlay();
      state.lobby = null; state.slot = 0; state.pick = false;
      toast('Соединение потеряно — лобби закрыто');
      show('library'); renderLibrary();
    }
  });

  // после сворачивания: вернуть звук
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.play) { try { emu.initAudio(); } catch (_) {} }
  });

  // ---------- старт ----------
  async function init() {
    try { state.config = await (await fetch('/api/config')).json(); } catch (_) {}
    try {
      const gs = await (await fetch('/api/games')).json();
      state.games = gs.map(g => ({ ...g, hash: g.sha256, bundled: true }));
    } catch (_) {}
    renderLibrary();
    loadMine();
    net.connect();

    const url = new URL(location.href);
    const code = TG.startParam || url.searchParams.get('lobby') || url.searchParams.get('startapp') || url.searchParams.get('tgWebAppStartParam');
    if (code && /^[A-Za-z0-9_-]{4,10}$/.test(code)) state.pendingJoin = code;
    if (state.pendingJoin && net.ready) { joinLobby(state.pendingJoin); state.pendingJoin = null; }
    // «Привет» в тихом режиме браузера
    if (!TG.user) localStorage.setItem('nes_name', state.myName);
  }
  init();
})();
