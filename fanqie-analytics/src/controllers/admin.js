const { Router } = require("express");
const { getTenants } = require("../repos/tenant.repo");
const { getMonthlyUsage, getAuditLogs } = require("../repos/usage.repo");
const { getTenantDataDays } = require("../repos/collection.repo");

const router = Router();

router.get("/admin/usage", async (req, res) => {
  const tenantId = req.tenant.id;
  const now = new Date();
  const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  const monthlyUsage = await getMonthlyUsage(tenantId, yearMonth);
  const dataDays = await getTenantDataDays(tenantId);

  res.json({
    code: 0,
    data: {
      monthlyApiCalls: monthlyUsage.total,
      monthlyEndpoints: monthlyUsage.endpoints,
      dataDays,
    },
  });
});

router.get("/admin/audit", async (req, res) => {
  const tenantId = req.tenant.id;
  const limit = parseInt(req.query.limit) || 50;
  const logs = await getAuditLogs(tenantId, limit);

  res.json({ code: 0, data: logs });
});

module.exports = router;
