const { Router } = require("express");
const { getTenants } = require("../repos/tenant.repo");
const { getTodayUsage, getTodayCollectionCount } = require("../repos/usage.repo");
const { getTenantDataDays } = require("../repos/collection.repo");
const { hasProfile } = require("../collectors/browser-manager");
const { getPlan } = require("../../lib/plans");
const { collecting, getProgress } = require("../services/collector.service");
const { today } = require("../utils/helpers");

const router = Router();

router.get("/health", async (req, res) => {
  const tenants = await getTenants();
  const statuses = {};

  for (const [id, t] of Object.entries(tenants)) {
    const todayStr = today();
    const dataDays = await getTenantDataDays(id);
    const planDef = getPlan(t.plan || "trial");
    const todayUsage = await getTodayUsage(id, todayStr);

    statuses[id] = {
      name: t.name,
      plan: t.plan,
      planLabel: planDef.name,
      profileReady: hasProfile(id),
      dataDays,
      collecting: collecting.has(id),
      todayApiCalls: todayUsage.total,
      todayCollections: todayUsage.endpoints["POST /api/v1/collect"] || 0,
      collectionLimit: planDef.maxCollectionsPerDay,
    };
  }

  res.json({
    code: 0, message: "ok",
    uptime: process.uptime(),
    tenants: statuses,
    memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + "MB",
  });
});

module.exports = router;
