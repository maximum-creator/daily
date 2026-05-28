// WebSocket client — real-time collection progress
const WSClient = {
  _ws: null,
  _reconnectTimer: null,
  _listeners: {},
  _connected: false,

  connect(tenantId = "demo") {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) return;

    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${location.host}/ws?tenant=${tenantId}`;

    try {
      this._ws = new WebSocket(url);
    } catch (e) {
      this._scheduleReconnect(tenantId);
      return;
    }

    this._ws.onopen = () => {
      this._connected = true;
      this._emit("connected");
      if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    };

    this._ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        this._emit("message", data);
        if (data.step) this._emit(data.step, data);
      } catch (e) { /* ignore */ }
    };

    this._ws.onclose = () => {
      this._connected = false;
      this._emit("disconnected");
      this._scheduleReconnect(tenantId);
    };

    this._ws.onerror = () => {
      this._ws?.close();
    };
  },

  _scheduleReconnect(tenantId) {
    if (this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.connect(tenantId);
    }, 3000);
  },

  on(event, callback) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(callback);
  },

  off(event, callback) {
    if (!this._listeners[event]) return;
    this._listeners[event] = this._listeners[event].filter((cb) => cb !== callback);
  },

  _emit(event, data) {
    (this._listeners[event] || []).forEach((cb) => {
      try { cb(data); } catch (e) { /* ignore */ }
    });
  },

  get connected() { return this._connected; },

  close() {
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    this._listeners = {};
    this._ws?.close();
    this._ws = null;
    this._connected = false;
  },
};
