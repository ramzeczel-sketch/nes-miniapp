/* Обёртка над Telegram.WebApp с безопасными заглушками для обычного браузера */
(function () {
  const wa = window.Telegram && window.Telegram.WebApp;
  const noop = () => {};
  const TG = {
    available: !!(wa && wa.initData !== undefined),
    wa,
    initData: wa ? wa.initData || '' : '',
    user: (wa && wa.initDataUnsafe && wa.initDataUnsafe.user) || null,
    startParam: (wa && wa.initDataUnsafe && wa.initDataUnsafe.start_param) || null,
    userName() {
      const u = this.user;
      if (u) return [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || 'Игрок';
      return localStorage.getItem('nes_name') || ('Игрок ' + Math.floor(100 + Math.random() * 900));
    },
    haptic(kind) {
      try { wa && wa.HapticFeedback && (kind === 'select' ? wa.HapticFeedback.selectionChanged() : wa.HapticFeedback.impactOccurred(kind || 'light')); } catch (_) {}
    },
    share(link, text) {
      const url = 'https://t.me/share/url?url=' + encodeURIComponent(link) + '&text=' + encodeURIComponent(text);
      if (wa && wa.openTelegramLink) wa.openTelegramLink(url);
      else window.open(url, '_blank', 'noopener');
    },
    confirmClose(on) { try { on ? wa.enableClosingConfirmation() : wa.disableClosingConfirmation(); } catch (_) {} },
    setBack(handler) {
      const bb = wa && wa.BackButton;
      if (!bb) return;
      try {
        if (TG._back) bb.offClick(TG._back);
        TG._back = handler;
        if (handler) { bb.onClick(handler); bb.show(); } else bb.hide();
      } catch (_) {}
    },
  };

  function applyViewport() {
    const root = document.documentElement.style;
    const h = wa && (wa.viewportStableHeight || wa.viewportHeight);
    root.setProperty('--tg-vh', h ? h + 'px' : '100vh');
    // safe areas (Bot API 8.0+)
    try {
      const s = wa.safeAreaInset || {}, c = wa.contentSafeAreaInset || {};
      root.setProperty('--safe-top', ((s.top || 0) + (c.top || 0)) + 'px');
      root.setProperty('--safe-bottom', ((s.bottom || 0) + (c.bottom || 0)) + 'px');
    } catch (_) {}
  }

  if (wa) {
    try { wa.ready(); } catch (_) {}
    try { wa.expand(); } catch (_) {}
    try { wa.disableVerticalSwipes && wa.disableVerticalSwipes(); } catch (_) {}
    try {
      const bg = (wa.themeParams && wa.themeParams.bg_color) || '#14121f';
      wa.setHeaderColor && wa.setHeaderColor(bg);
      wa.setBackgroundColor && wa.setBackgroundColor(bg);
    } catch (_) {}
    wa.onEvent && wa.onEvent('viewportChanged', applyViewport);
    wa.onEvent && wa.onEvent('safeAreaChanged', applyViewport);
    wa.onEvent && wa.onEvent('contentSafeAreaChanged', applyViewport);
  }
  window.addEventListener('resize', applyViewport);
  applyViewport();
  window.TG = TG;
})();
