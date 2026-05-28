const http = require("http");
const { createApp } = require("./app");
const { migrate } = require("./database/migrate");
const { initWebSocket } = require("./websocket/ws-manager");
const { startScheduler } = require("./services/scheduler.service");
const { runCollection } = require("./services/collector.service");
const { broadcast } = require("./websocket/ws-manager");
const { getTenants } = require("./repos/tenant.repo");
const { env } = require("./config");
const logger = require("./utils/logger");

async function main() {
  logger.info("🚀 番茄小说智能分析平台 v2.0 启动中…");

  // 1. Database
  await migrate();

  // 2. Express app
  const app = await createApp();
  const server = http.createServer(app);

  // 3. WebSocket
  initWebSocket(server);

  // 4. Scheduler
  startScheduler(
    async (tenantId, opts) => {
      const tenants = await getTenants();
      const tenant = tenants[tenantId];
      return runCollection(tenantId, { ...opts, tenant, wsBroadcast: broadcast });
    },
    broadcast
  );

  // 5. Listen
  server.listen(env.PORT, () => {
    logger.info({ port: env.PORT }, `✅ 服务已启动 http://localhost:${env.PORT}`);
    logger.info("   📊 仪表盘: http://localhost:" + env.PORT);
    logger.info("   💚 健康检查: http://localhost:" + env.PORT + "/api/v1/health");
    logger.info("   🔌 WebSocket: ws://localhost:" + env.PORT + "/ws");
  });
}

main().catch((e) => {
  logger.error({ err: e }, "启动失败");
  process.exit(1);
});
