// Auto-collection scheduler — runs at configured times each day.
// Checks every 60s; when current time matches a schedule slot,
// triggers async collect for all tenants with valid profiles.
// Each time slot fires at most once per day per tenant.

const { hasProfile } = require("./browser-manager");

const SCHEDULE_HOURS = [13, 18]; // 13:00 and 18:00 — after platform data refreshes

function startScheduler(tenants, runCollection) {
  // Track which slots have fired today: "tenantId|hour" → true
  const fired = new Set();

  // Reset at midnight
  function resetDaily() {
    fired.clear();
  }

  // Schedule midnight reset
  const now = new Date();
  const msToMidnight =
    new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - now.getTime();
  setTimeout(() => {
    resetDaily();
    setInterval(resetDaily, 86400000).unref(); // every 24h
  }, msToMidnight + 1000).unref();

  // Main check loop — runs every 60 seconds
  setInterval(() => {
    const now = new Date();
    const hour = now.getHours();
    const minute = now.getMinutes();

    // Only fire in the first minute of each scheduled hour
    if (!SCHEDULE_HOURS.includes(hour) || minute !== 0) return;

    for (const [tenantId, tenant] of Object.entries(tenants)) {
      if (!hasProfile(tenantId)) continue;
      const key = `${tenantId}|${hour}`;
      if (fired.has(key)) continue;
      fired.add(key);

      console.log(`⏰ 定时采集: tenant=${tenantId} (${tenant.name}) at ${hour}:00`);
      // Fire async — never await, don't block the scheduler
      runCollection(tenantId).catch((e) =>
        console.error(`⏰ 定时采集失败 [${tenantId}]: ${e.message}`)
      );
    }
  }, 60000).unref();

  console.log(
    `⏰ 定时采集已启用: ${SCHEDULE_HOURS.map((h) => `${h}:00`).join(", ")}`
  );
}

module.exports = { startScheduler };
