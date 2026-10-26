/* IndexedDB: пользовательские ROM-ы хранятся только в браузере. */
(function () {
  const DB = 'nes-miniapp', STORE = 'roms';
  let dbp;
  function db() {
    if (!dbp) dbp = new Promise((res, rej) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'hash' });
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  const tx = async (mode, fn) => {
    const d = await db();
    return new Promise((res, rej) => {
      const t = d.transaction(STORE, mode); const s = t.objectStore(STORE);
      const rq = fn(s);
      t.oncomplete = () => res(rq && rq.result);
      t.onerror = t.onabort = () => rej(t.error);
    });
  };

  async function sha256hex(buf) {
    if (window.crypto && crypto.subtle) {
      const d = await crypto.subtle.digest('SHA-256', buf);
      return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
    }
    // запасной вариант (небезопасный контекст): два прохода FNV-1a + cyrb53, 32 hex-символа
    const u = new Uint8Array(buf); let h1 = 0xdeadbeef, h2 = 0x41c6ce57, f = 0x811c9dc5;
    for (let i = 0; i < u.length; i++) {
      h1 = Math.imul(h1 ^ u[i], 2654435761); h2 = Math.imul(h2 ^ u[i], 1597334677);
      f = Math.imul(f ^ u[i], 16777619);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    const x = n => (n >>> 0).toString(16).padStart(8, '0');
    return x(h1) + x(h2) + x(f) + x(u.length);
  }

  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (_) {}

  window.Store = {
    sha256hex,
    list: async () => { try { return (await tx('readonly', s => s.getAll())) || []; } catch (_) { return []; } },
    get: async (hash) => { try { return await tx('readonly', s => s.get(hash)); } catch (_) { return null; } },
    put: (rec) => tx('readwrite', s => s.put(rec)),
    del: (hash) => tx('readwrite', s => s.delete(hash)),
  };
})();
