const { logUsage, logAudit } = require("../repos/usage.repo");
const { today } = require("../utils/helpers");

function usageTrackerMiddleware(req, res, next) {
  res.on("finish", () => {
    const tenant = req.tenant;
    if (!tenant) return;

    const date = today();
    const normalized = (req.method + " " + (req.route?.path || req.path)).replace(/\/+$/, "").slice(0, 120);

    logUsage(tenant.id, date, normalized).catch(() => {});
    logAudit(tenant.id, normalized, JSON.stringify({ query: req.query, ip: req.ip }), req.ip).catch(() => {});
  });

  next();
}

module.exports = { usageTrackerMiddleware };
