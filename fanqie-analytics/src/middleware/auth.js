const { getTenantByApiKey, syncTenantsFromJson } = require("../repos/tenant.repo");
const { logAudit } = require("../repos/usage.repo");
const fs = require("fs");
const path = require("path");

const TENANTS_PATH = path.join(__dirname, "..", "..", "config", "tenants.json");

function loadTenantsJson() {
  try {
    return JSON.parse(fs.readFileSync(TENANTS_PATH, "utf-8")).tenants || {};
  } catch {
    return {};
  }
}

async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;

  if (!token) {
    return res.status(401).json({ code: 401, message: "缺少 API Key，请在 Authorization 头中提供 Bearer token" });
  }

  const tenant = await getTenantByApiKey(token);
  if (!tenant) {
    return res.status(403).json({ code: 403, message: "无效的 API Key" });
  }

  req.tenant = tenant;
  next();
}

module.exports = { authMiddleware, loadTenantsJson };
