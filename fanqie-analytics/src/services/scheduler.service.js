const { hasProfile } = require("../collectors/browser-manager");
const { getTenants } = require("../repos/tenant.repo");
const logger = require("../utils/logger");

let cronJob = null;

function startScheduler(runCollectionCb, wsBroadcast) {
  const SCHEDULE_HOURS = [13, 18];
  const fired = new Set();

  function resetDaily() {
    fired.clear();
  }

  const now = new Date();
  const msToMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - now.getTime();
  setTimeout(() => {
    resetDaily();
    setInterval(resetDaily, 86400000).unref();
  }, msToMidnight + 1000).unref();

  setInterval(async () => {
    const now = new Date();
    const hour = now.getHours();
    const minute = now.getMinutes();

    if (!SCHEDULE_HOURS.includes(hour) || minute !== 0) return;

    try {
      const tenants = await getTenants();
      for (const [tenantId, tenant] of Object.entries(tenants)) {
        if (!hasProfile(tenantId)) continue;
        const key = `${tenantId}|${hour}`;
        if (fired.has(key)) continue;
        fired.add(key);

        logger.info({ tenantId, hour }, "定时采集触发");
        runCollectionCb(tenantId, { tenant, wsBroadcast }).catch((e) =>
          logger.error({ err: e, tenantId }, "定时采集失败")
        );
      }
    } catch (e) {
      logger.error({ err: e }, "调度器错误");
    }
  }, 60000).unref();

  logger.info(`定时采集已启用: ${SCHEDULE_HOURS.map((h) => `${h}:00`).join(", ")}`);
}

module.exports = { startScheduler };
