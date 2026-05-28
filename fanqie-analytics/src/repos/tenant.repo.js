const { getDb, saveDb } = require("../database/connection");
const logger = require("../utils/logger");

async function getTenants() {
  const db = await getDb();
  const result = db.exec("SELECT * FROM tenants");
  if (!result.length || !result[0].values.length) return {};
  const tenants = {};
  for (const row of result[0].values) {
    tenants[row[0]] = {
      id: row[0], name: row[1], apiKey: row[2], plan: row[3],
      createdAt: row[4], updatedAt: row[5],
    };
  }
  return tenants;
}

async function getTenant(id) {
  const db = await getDb();
  const result = db.exec("SELECT * FROM tenants WHERE id = ?", [id]);
  if (!result.length || !result[0].values.length) return null;
  const row = result[0].values[0];
  return { id: row[0], name: row[1], apiKey: row[2], plan: row[3], createdAt: row[4], updatedAt: row[5] };
}

async function getTenantByApiKey(apiKey) {
  const db = await getDb();
  const result = db.exec("SELECT * FROM tenants WHERE api_key = ?", [apiKey]);
  if (!result.length || !result[0].values.length) return null;
  const row = result[0].values[0];
  return { id: row[0], name: row[1], apiKey: row[2], plan: row[3], createdAt: row[4], updatedAt: row[5] };
}

async function upsertTenant(id, name, apiKey, plan = "trial") {
  const db = await getDb();
  db.run(
    `INSERT INTO tenants (id, name, api_key, plan, updated_at)
     VALUES (?, ?, ?, ?, datetime('now','localtime'))
     ON CONFLICT(id) DO UPDATE SET name=excluded.name, api_key=excluded.api_key, plan=excluded.plan, updated_at=excluded.updated_at`,
    [id, name, apiKey, plan]
  );
  saveDb();
  logger.info({ tenantId: id, plan }, "租户已更新");
}

async function syncTenantsFromJson(tenantsJson) {
  const tenants = tenantsJson || {};
  for (const [id, t] of Object.entries(tenants)) {
    await upsertTenant(id, t.name, t.apiKey, t.plan || "trial");
  }
  logger.info({ count: Object.keys(tenants).length }, "租户同步完成");
}

module.exports = { getTenants, getTenant, getTenantByApiKey, upsertTenant, syncTenantsFromJson };
