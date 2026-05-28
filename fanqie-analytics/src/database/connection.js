const initSqlJs = require("sql.js");
const fs = require("fs");
const path = require("path");
const logger = require("../utils/logger");

const DB_PATH = path.join(__dirname, "..", "..", "data", "fanqie.db");

let db = null;

async function getDb() {
  if (db) return db;

  const SQL = await initSqlJs();
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  let buffer;
  try {
    buffer = fs.readFileSync(DB_PATH);
  } catch {
    buffer = null;
  }

  db = new SQL.Database(buffer);
  db.run("PRAGMA journal_mode=WAL");
  db.run("PRAGMA foreign_keys=ON");
  logger.info("SQLite 数据库已连接");
  return db;
}

function saveDb() {
  if (!db) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}

// Auto-save every 60s
setInterval(() => {
  if (db) {
    saveDb();
  }
}, 60000).unref();

// Save on exit
process.on("exit", saveDb);
process.on("SIGINT", () => { saveDb(); process.exit(); });
process.on("SIGTERM", () => { saveDb(); process.exit(); });

module.exports = { getDb, saveDb };
