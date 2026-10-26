/* Обёртка над JSNES: канвас, звук, детерминированный шаг кадра. */
(function () {
  const W = 256, H = 240;
  const BTN = ['A', 'B', 'SELECT', 'START', 'UP', 'DOWN', 'LEFT', 'RIGHT']; // индексы совпадают с битами маски
  const SUPPORTED_MAPPERS = [0, 1, 2, 3, 4, 5, 7, 9, 11, 34, 38, 66, 71, 79, 94, 118, 119, 140, 180, 240, 241];

  function toBinaryString(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return s;
  }

  /** Проверка iNES-заголовка. Возвращает { ok, error, mapper, prg, chr, battery } */
  function inspect(buf) {
    const u = new Uint8Array(buf);
    if (u.length < 16 + 8192) return { ok: false, error: 'Файл слишком маленький' };
    if (u.length > 4 * 1024 * 1024) return { ok: false, error: 'Файл слишком большой (макс. 4 МБ)' };
    if (!(u[0] === 0x4e && u[1] === 0x45 && u[2] === 0x53 && u[3] === 0x1a)) return { ok: false, error: 'Это не .nes файл (нет заголовка iNES)' };
    const mapper = (u[6] >> 4) | (u[7] & 0xf0);
    return { ok: true, mapper, supported: SUPPORTED_MAPPERS.includes(mapper), prg: u[4], chr: u[5] };
  }

  class Emu {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d', { alpha: false });
      this.img = this.ctx.createImageData(W, H);
      this.buf32 = new Uint32Array(this.img.data.buffer);
      this.nes = null;
      this.rom = null;
      this.audio = { ctx: null, node: null, ring: new Float32Array(16384), r: 0, w: 0, muted: false };
      this.frames = 0;
    }

    /** вызывать из обработчика жеста пользователя */
    initAudio() {
      const a = this.audio;
      if (!a.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        try {
          a.ctx = new AC({ latencyHint: 'interactive' });
          a.node = a.ctx.createScriptProcessor(1024, 0, 1);
          a.node.onaudioprocess = (ev) => {
            const out = ev.outputBuffer.getChannelData(0);
            const n = out.length, size = a.ring.length;
            let avail = (a.w - a.r + size) % size;
            for (let i = 0; i < n; i++) {
              if (avail > 0 && !a.muted) { out[i] = a.ring[a.r]; a.r = (a.r + 1) % size; avail--; }
              else { out[i] = 0; if (avail > 0) { a.r = (a.r + 1) % size; avail--; } }
            }
          };
          a.node.connect(a.ctx.destination);
        } catch (_) { a.ctx = null; }
      }
      if (a.ctx && a.ctx.state === 'suspended') a.ctx.resume().catch(() => {});
    }

    setMuted(m) { this.audio.muted = m; }

    pushSample(l, r) {
      const a = this.audio, size = a.ring.length;
      if (!a.ctx) return;
      const next = (a.w + 1) % size;
      if (next === a.r) { a.r = (a.r + 512) % size; } // переполнение: отбрасываем старое
      a.ring[a.w] = (l + r) * 0.5;
      a.w = next;
    }

    /** Загрузить (и сбросить) ROM из ArrayBuffer. Бросает исключение при неподдерживаемом файле. */
    load(arrayBuffer) {
      const info = inspect(arrayBuffer);
      if (!info.ok) throw new Error(info.error);
      this.rom = arrayBuffer;
      this.audio.r = this.audio.w = 0;
      this.nes = new jsnes.NES({
        onFrame: (fb) => {
          const b = this.buf32;
          for (let i = 0; i < W * H; i++) b[i] = 0xff000000 | fb[i];
        },
        onAudioSample: (l, r) => this.pushSample(l, r),
        sampleRate: (this.audio.ctx && this.audio.ctx.sampleRate) || 44100,
      });
      this.nes.loadROM(toBinaryString(new Uint8Array(arrayBuffer)));
      this.frames = 0;
      this.draw();
      return info;
    }

    /** Выполнить ровно один кадр с масками кнопок обоих игроков. Детерминированно. */
    frame(m1, m2) {
      const n = this.nes;
      for (let i = 0; i < 8; i++) {
        const bit = 1 << i;
        if ((m1 & bit) !== 0) n.buttonDown(1, i); else n.buttonUp(1, i);
        if ((m2 & bit) !== 0) n.buttonDown(2, i); else n.buttonUp(2, i);
      }
      n.frame();
      this.frames++;
      this.draw();
    }

    draw() { this.ctx.putImageData(this.img, 0, 0); }

    /** Контрольная сумма состояния ОЗУ ЦП (для детекта рассинхрона) */
    checksum() {
      const mem = this.nes.cpu.mem;
      let h = 0x811c9dc5;
      for (let i = 0; i < 0x800; i++) h = Math.imul(h ^ mem[i], 16777619);
      h = Math.imul(h ^ this.nes.cpu.REG_PC, 16777619);
      return h >>> 0;
    }

    /** есть ли на экране что-то кроме одного цвета (для автотестов) */
    nonBlank() {
      const b = this.buf32; const first = b[0];
      for (let i = 1; i < b.length; i += 7) if (b[i] !== first) return true;
      return false;
    }

    destroy() { this.nes = null; }
  }

  window.Emu = Emu;
  window.EmuUtil = { inspect, BTN };
})();
