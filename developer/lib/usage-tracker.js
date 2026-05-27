// Per-tenant API usage tracking with daily aggregation.
const fs = require("fs");
const path = require("path");

const USAGE_DIR = path.join(__dirname, "..", "data", ".usage");
const buffer = {};

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function usagePath(date) {
  return path.join(USAGE_DIR, `usage-${date}.json`);
}

function flush() {
  const dates = Object.keys(buffer);
  if (dates.length === 0) return;
  if (!fs.existsSync(USAGE_DIR)) fs.mkdirSync(USAGE_DIR, { recursive: true });

  for (const date of dates) {
    const tenants = buffer[date];
    if (!tenants) continue;
    const fp = usagePath(date);
    let existing = {};
    if (fs.existsSync(fp)) {
      try { existing = JSON.parse(fs.readFileSync(fp, "utf-8")); } catch (e) { /* reset */ }
    }
    for (const [tid, stats] of Object.entries(tenants)) {
      if (!existing[tid]) existing[tid] = { total: 0, endpoints: {} };
      existing[tid].total += stats.total;
      for (const [ep, n] of Object.entries(stats.endpoints)) {
        existing[tid].endpoints[ep] = (existing[tid].endpoints[ep] || 0) + n;
      }
    }
    fs.writeFileSync(fp, JSON.stringify(existing, null, 2));
  }
  for (const date of dates) delete buffer[date];
}

setInterval(flush, 30000).unref();
process.on("exit", flush);
process.on("SIGINT", () => { flush(); process.exit(); });
process.on("SIGTERM", () => { flush(); process.exit(); });

function usageTracker(req, res, next) {
  res.on("finish", () => {
    const tenant = req.tenant;
    if (!tenant) return;
    const date = todayStr();
    const normalized = (req.method + " " + (req.route ? req.route.path : req.path)).replace(/\/+$/, "").slice(0, 120);
    if (!buffer[date]) buffer[date] = {};
    if (!buffer[date][tenant.id]) buffer[date][tenant.id] = { total: 0, endpoints: {} };
    buffer[date][tenant.id].total++;
    buffer[date][tenant.id].endpoints[normalized] = (buffer[date][tenant.id].endpoints[normalized] || 0) + 1;
  });
  next();
}

function getUsage(tenantId, date) {
  const d = date || todayStr();
  const fp = usagePath(d);
  if (!fs.existsSync(fp)) return { total: 0, endpoints: {} };
  const data = JSON.parse(fs.readFileSync(fp, "utf-8"));
  const stored = data[tenantId] || { total: 0, endpoints: {} };
  const buf = (buffer[d] && buffer[d][tenantId]) ? buffer[d][tenantId] : null;
  if (buf) {
    stored.total += buf.total;
    for (const [ep, n] of Object.entries(buf.endpoints)) {
      stored.endpoints[ep] = (stored.endpoints[ep] || 0) + n;
    }
  }
  return stored;
}

function getTodayUsage(tenantId) {
  return getUsage(tenantId, todayStr());
}

function getMonthlyUsage(tenantId) {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const prefix = `${year}-${month}`;
  if (!fs.existsSync(USAGE_DIR)) return { total: 0, endpoints: {} };
  const result = { total: 0, endpoints: {} };
  const files = fs.readdirSync(USAGE_DIR).filter(f => f.startsWith(`usage-${prefix}`));
  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(USAGE_DIR, f), "utf-8"));
      const t = data[tenantId];
      if (t) {
        result.total += t.total || 0;
        for (const [ep, n] of Object.entries(t.endpoints || {})) {
          result.endpoints[ep] = (result.endpoints[ep] || 0) + n;
        }
      }
    } catch (e) { /* skip */ }
  }
  for (const [date, tenants] of Object.entries(buffer)) {
    if (date.startsWith(prefix) && tenants[tenantId]) {
      result.total += tenants[tenantId].total;
      for (const [ep, n] of Object.entries(tenants[tenantId].endpoints)) {
        result.endpoints[ep] = (result.endpoints[ep] || 0) + n;
      }
    }
  }
  return result;
}

function getAllTenantsUsage(date) {
  const d = date || todayStr();
  const fp = usagePath(d);
  if (!fs.existsSync(fp)) {
    const buf = buffer[d] || {};
    return Object.fromEntries(Object.entries(buf).map(([tid, s]) => [tid, s]));
  }
  const data = JSON.parse(fs.readFileSync(fp, "utf-8"));
  const merged = { ...data };
  const buf = buffer[d] || {};
  for (const [tid, stats] of Object.entries(buf)) {
    if (!merged[tid]) merged[tid] = { total: 0, endpoints: {} };
    merged[tid].total += stats.total;
    for (const [ep, n] of Object.entries(stats.endpoints)) {
      merged[tid].endpoints[ep] = (merged[tid].endpoints[ep] || 0) + n;
    }
  }
  return merged;
}

function getTodaySearchCount(tenantId) {
  const usage = getTodayUsage(tenantId);
  return usage.endpoints["POST /api/v1/search"] || 0;
}

module.exports = { usageTracker, getUsage, getTodayUsage, getMonthlyUsage, getAllTenantsUsage, getTodaySearchCount, flush };
