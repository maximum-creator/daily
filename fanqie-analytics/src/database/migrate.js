const { getDb } = require("./connection");
const logger = require("../utils/logger");

async function migrate() {
  const db = await getDb();

  db.run(`
    CREATE TABLE IF NOT EXISTS tenants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      api_key TEXT UNIQUE NOT NULL,
      plan TEXT DEFAULT 'trial',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS collections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL,
      date TEXT NOT NULL,
      book TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (tenant_id) REFERENCES tenants(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL,
      date TEXT NOT NULL,
      book TEXT NOT NULL,
      revenue REAL DEFAULT 0,
      readers INTEGER DEFAULT 0,
      bookmarks INTEGER DEFAULT 0,
      comments INTEGER DEFAULT 0,
      urges INTEGER DEFAULT 0,
      follow_readers INTEGER DEFAULT 0,
      total_words INTEGER DEFAULT 0,
      chapters_count INTEGER DEFAULT 0,
      avg_completion REAL DEFAULT 0,
      avg_follow REAL DEFAULT 0,
      search_ratio REAL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (tenant_id) REFERENCES tenants(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS usage_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL,
      date TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      count INTEGER DEFAULT 1,
      UNIQUE(tenant_id, date, endpoint)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL,
      action TEXT NOT NULL,
      detail TEXT DEFAULT '',
      ip TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);

  // Indexes for common queries
  db.run("CREATE INDEX IF NOT EXISTS idx_collections_tenant_date ON collections(tenant_id, date)");
  db.run("CREATE INDEX IF NOT EXISTS idx_collections_book ON collections(tenant_id, book, date)");
  db.run("CREATE INDEX IF NOT EXISTS idx_daily_metrics_tenant ON daily_metrics(tenant_id, date, book)");
  db.run("CREATE INDEX IF NOT EXISTS idx_usage_log_tenant ON usage_log(tenant_id, date)");
  db.run("CREATE INDEX IF NOT EXISTS idx_audit_log_tenant ON audit_log(tenant_id, created_at)");

  logger.info("数据库迁移完成");
}

module.exports = { migrate };
