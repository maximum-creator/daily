const { WebSocketServer } = require("ws");
const logger = require("../utils/logger");

let wss = null;
const clients = new Map(); // tenantId → Set<WebSocket>

function initWebSocket(server) {
  wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url, "http://localhost");
    const tenantId = url.searchParams.get("tenant") || "default";

    if (!clients.has(tenantId)) clients.set(tenantId, new Set());
    clients.get(tenantId).add(ws);

    ws.on("close", () => {
      const set = clients.get(tenantId);
      if (set) {
        set.delete(ws);
        if (set.size === 0) clients.delete(tenantId);
      }
    });

    ws.on("error", () => {
      const set = clients.get(tenantId);
      if (set) {
        set.delete(ws);
        if (set.size === 0) clients.delete(tenantId);
      }
    });

    ws.send(JSON.stringify({ type: "connected", tenantId, message: "WebSocket 已连接" }));
  });

  logger.info("WebSocket 服务已启动 (/ws)");
}

function broadcast(tenantId, data) {
  const set = clients.get(tenantId);
  if (!set || set.size === 0) return;

  const msg = JSON.stringify({ ...data, timestamp: Date.now() });
  for (const ws of set) {
    try {
      if (ws.readyState === 1) ws.send(msg);
    } catch (e) { /* ignore */ }
  }
}

module.exports = { initWebSocket, broadcast };
