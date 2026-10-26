/* Ввод: клавиатура + экранный геймпад. Маска кнопок: бит = индекс кнопки jsnes. */
(function () {
  const B = { a: 1, b: 2, select: 4, start: 8, up: 16, down: 32, left: 64, right: 128 };

  // Клавиатура игрока 1 и (только для локальной игры вдвоём на одном устройстве) игрока 2
  const KEYS1 = { KeyX: 'a', KeyZ: 'b', Enter: 'start', ShiftRight: 'select', ShiftLeft: 'select', Backspace: 'select',
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', KeyK: 'a', KeyJ: 'b' };
  const KEYS2 = { KeyH: 'a', KeyG: 'b', KeyY: 'start', KeyT: 'select', KeyW: 'up', KeyS: 'down', KeyA: 'left', KeyD: 'right' };

  const kb1 = new Set(), kb2 = new Set();
  const touch = new Set();
  let active = false;

  window.addEventListener('keydown', e => {
    if (!active) return;
    const k1 = KEYS1[e.code], k2 = KEYS2[e.code];
    if (k1 || k2) { e.preventDefault(); if (k1) kb1.add(k1); if (k2) kb2.add(k2); }
  });
  window.addEventListener('keyup', e => {
    const k1 = KEYS1[e.code], k2 = KEYS2[e.code];
    if (k1) kb1.delete(k1); if (k2) kb2.delete(k2);
  });
  window.addEventListener('blur', () => { kb1.clear(); kb2.clear(); touch.clear(); refresh(); });

  const maskOf = (set) => { let m = 0; set.forEach(k => m |= B[k]); return m; };

  function refresh() {
    document.querySelectorAll('.pbtn').forEach(el => el.classList.toggle('on', touch.has(el.dataset.btn)));
    const kn = document.getElementById('dknob');
    if (kn) {
      const dx = (touch.has('right') ? 1 : 0) - (touch.has('left') ? 1 : 0);
      const dy = (touch.has('down') ? 1 : 0) - (touch.has('up') ? 1 : 0);
      kn.style.transform = `translate(${dx * 38}%, ${dy * 38}%)`;
    }
  }

  function bindButtons() {
    document.querySelectorAll('.pbtn').forEach(el => {
      const name = el.dataset.btn;
      const down = e => { e.preventDefault(); touch.add(name); TG.haptic('light'); refresh(); try { el.setPointerCapture(e.pointerId); } catch (_) {} };
      const up = e => { e.preventDefault(); touch.delete(name); refresh(); };
      el.addEventListener('pointerdown', down);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
      el.addEventListener('lostpointercapture', up);
      el.addEventListener('contextmenu', e => e.preventDefault());
    });
    const dp = document.getElementById('dpad');
    const DIRS = ['up', 'down', 'left', 'right'];
    const upd = e => {
      const r = dp.getBoundingClientRect();
      const dx = (e.clientX - (r.left + r.width / 2)) / (r.width / 2);
      const dy = (e.clientY - (r.top + r.height / 2)) / (r.height / 2);
      const prev = DIRS.filter(d => touch.has(d)).join();
      DIRS.forEach(d => touch.delete(d));
      if (Math.hypot(dx, dy) > 0.22) {
        if (dx > 0.38) touch.add('right'); else if (dx < -0.38) touch.add('left');
        if (dy > 0.38) touch.add('down'); else if (dy < -0.38) touch.add('up');
      }
      if (DIRS.filter(d => touch.has(d)).join() !== prev) TG.haptic('select');
      refresh();
    };
    const end = e => { DIRS.forEach(d => touch.delete(d)); refresh(); };
    dp.addEventListener('pointerdown', e => { e.preventDefault(); dp.setPointerCapture(e.pointerId); upd(e); });
    dp.addEventListener('pointermove', e => { if (dp.hasPointerCapture(e.pointerId)) { e.preventDefault(); upd(e); } });
    dp.addEventListener('pointerup', end);
    dp.addEventListener('pointercancel', end);
    dp.addEventListener('lostpointercapture', end);
    dp.addEventListener('contextmenu', e => e.preventDefault());
  }
  bindButtons();

  window.Pad = {
    B,
    setActive(v) { active = v; if (!v) { kb1.clear(); kb2.clear(); touch.clear(); refresh(); } },
    /** маска игрока 1: клавиатура + тач */
    p1() { return maskOf(kb1) | maskOf(touch); },
    /** маска игрока 2 с клавиатуры (локальная игра вдвоём на одном устройстве) */
    p2local() { return maskOf(kb2); },
    // для автотестов
    _press(name, on) { on ? touch.add(name) : touch.delete(name); refresh(); },
  };
})();
