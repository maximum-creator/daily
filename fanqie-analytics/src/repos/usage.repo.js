const { getDb, saveDb } = require("../database/connection");

async function logUsage(tenantId, date, endpoint) {
  const db = await getDb();
  db.run(
    `INSERT INTO usage_log (tenant_id, date, endpoint, count)
     VALUES (?, ?, ?, 1)
     ON CONFLICT(tenant_id, date, endpoint)
     DO UPDATE SET count = count + 1`,
    [tenantId, date, endpoint]
  );
  saveDb();
}

async function getTodayUsage(tenantId, date) {
  const db = await getDb();
  const result = db.exec(
    "SELECT endpoint, count FROM usage_log WHERE tenant_id = ? AND date = ?",
    [tenantId, date]
  );
  const usage = { total: 0, endpoints: {} };
  if (!result.length || !result[0].values.length) return usage;
  for (const row of result[0].values) {
    usage.endpoints[row[0]] = row[1];
    usage.total += row[1];
  }
  return usage;
}

async function getTodayCollectionCount(tenantId, date) {
  const usage = await getTodayUsage(tenantId, date);
  return usage.endpoints["POST /api/v1/collect"] || 0;
}

async function getMonthlyUsage(tenantId, yearMonth) {
  const db = await getDb();
  const result = db.exec(
    "SELECT endpoint, SUM(count) FROM usage_log WHERE tenant_id = ? AND date LIKE ? GROUP BY endpoint",
    [tenantId, `${yearMonth}%`]
  );
  const usage = { total: 0, endpoints: {} };
  if (!result.length || !result[0].values.length) return usage;
  for (const row of result[0].values) {
    usage.endpoints[row[0]] = row[1];
    usage.total += row[1];
  }
  return usage;
}

async function logAudit(tenantId, action, detail = "", ip = "") {
  const db = await getDb();
  db.run("INSERT INTO audit_log (tenant_id, action, detail, ip) VALUES (?, ?, ?, ?)", [tenantId, action, detail, ip]);
  saveDb();
}

async function getAuditLogs(tenantId, limit = 100) {
  const db = await getDb();
  const result = db.exec(
    "SELECT action, detail, ip, created_at FROM audit_log WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?",
    [tenantId, limit]
  );
  if (!result.length || !result[0].values.length) return [];
  return result[0].values.map((row) => ({
    action: row[0], detail: row[1], ip: row[2], timestamp: row[3],
  }));
}

module.exports = { logUsage, getTodayUsage, getTodayCollectionCount, getMonthlyUsage, logAudit, getAuditLogs };
