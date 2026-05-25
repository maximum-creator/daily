// API Key authentication middleware
const fs = require("fs");
const path = require("path");

const TENANTS_PATH = path.join(__dirname, "..", "config", "tenants.json");

function loadTenants() {
  return JSON.parse(fs.readFileSync(TENANTS_PATH, "utf-8")).tenants || {};
}

function findTenant(apiKey) {
  const tenants = loadTenants();
  for (const [id, t] of Object.entries(tenants)) {
    if (t.apiKey === apiKey) return { id, ...t };
  }
  return null;
}

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;

  if (!token) {
    return res.status(401).json({ code: 401, message: "缺少 API Key，请在 Authorization 头中提供 Bearer token" });
  }

  const tenant = findTenant(token);
  if (!tenant) {
    return res.status(403).json({ code: 403, message: "无效的 API Key" });
  }

  req.tenant = tenant;
  next();
}

module.exports = { authMiddleware, loadTenants, findTenant };
