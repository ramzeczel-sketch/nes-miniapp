/* WebSocket-клиент лобби + ретрансляция ввода */
(function () {
  class Net {
    constructor() {
      this.ws = null; this.handlers = {}; this.ready = false; this.queue = []; this.rtt = null;
      this.reconnectDelay = 500; this.wantOpen = true; this._pingT = null;
    }
    on(type, fn) { this.handlers[type] = fn; return this; }
    emit(type, data) { const f = this.handlers[type]; if (f) f(data); }

    connect() {
      this.wantOpen = true;
      if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${proto}//${location.host}/ws`);
      this.ws = ws; this.ready = false;
      ws.onopen = () => {
        this.reconnectDelay = 500;
        ws.send(JSON.stringify({ t: 'hello', name: TG.userName(), initData: TG.initData }));
        clearInterval(this._pingT);
        setTimeout(() => this.send({ t: 'ping', ts: Date.now(), rtt: this.rtt }), 600);
        this._pingT = setInterval(() => this.send({ t: 'ping', ts: Date.now(), rtt: this.rtt }), 2000);
      };
      ws.onmessage = (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
        if (m.t === 'welcome') { this.ready = true; this.queue.splice(0).forEach(q => this.send(q)); }
        if (m.t === 'pong') this.rtt = Date.now() - m.ts;
        this.emit(m.t, m);
        this.emit('*', m);
      };
      ws.onclose = () => {
        clearInterval(this._pingT); this.ready = false;
        this.emit('close', {});
        if (this.wantOpen) { setTimeout(() => this.connect(), this.reconnectDelay); this.reconnectDelay = Math.min(this.reconnectDelay * 2, 5000); }
      };
      ws.onerror = () => {};
    }

    send(obj) {
      if (this.ws && this.ws.readyState === 1 && (this.ready || obj.t === 'hello')) this.ws.send(JSON.stringify(obj));
      else if (obj.t !== 'in' && obj.t !== 'sum' && obj.t !== 'ping') this.queue.push(obj);
    }
  }
  window.Net = Net;
})();
