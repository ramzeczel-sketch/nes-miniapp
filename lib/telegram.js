'use strict';
const crypto = require('crypto');

/**
 * Validate Telegram WebApp initData.
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 * Returns { ok, user, startParam, reason }.
 */
function validateInitData(initData, botToken, maxAgeSec = 86400) {
  try {
    if (!initData || typeof initData !== 'string' || initData.length > 4096) return { ok: false, reason: 'empty' };
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return { ok: false, reason: 'no_hash' };
    params.delete('hash');
    const dcs = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const calc = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
    const a = Buffer.from(calc, 'hex');
    const b = Buffer.from(hash, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'bad_hash' };
    const authDate = Number(params.get('auth_date') || 0);
    if (!authDate || Date.now() / 1000 - authDate > maxAgeSec) return { ok: false, reason: 'expired' };
    let user = null;
    try { user = JSON.parse(params.get('user') || 'null'); } catch (_) {}
    return { ok: true, user, startParam: params.get('start_param') || null };
  } catch (e) {
    return { ok: false, reason: 'error' };
  }
}

module.exports = { validateInitData };
