// migrate-data.js — 将旧版 JSON 文件数据迁移到 SQLite
// Usage: node scripts/migrate-data.js [--dry-run]

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const { migrate } = require("../src/database/migrate");
const { saveCollection } = require("../src/repos/collection.repo");
const { syncTenantsFromJson } = require("../src/repos/tenant.repo");
const { loadTenantsJson } = require("../src/middleware/auth");

const dryRun = process.argv.includes("--dry-run");

function readJSON(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf-8")); } catch (e) { return null; }
}

function findBookDirs(dataDir) {
  const bookDirs = [];
  if (!fs.existsSync(dataDir)) return bookDirs;

  const entries = fs.readdirSync(dataDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dateDir = path.join(dataDir, entry.name);
    // Check if this is a date dir (YYYY-MM-DD format)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue;

    const subEntries = fs.readdirSync(dateDir, { withFileTypes: true });
    for (const sub of subEntries) {
      if (!sub.isDirectory()) continue;
      const bookDir = path.join(dateDir, sub.name);
      const summaryPath = path.join(bookDir, "summary.json");
      if (fs.existsSync(summaryPath)) {
        bookDirs.push({ date: entry.name, book: sub.name, dir: bookDir });
      }
    }
  }
  return bookDirs;
}

function buildSummary(bookDir, date, bookName) {
  const summary = readJSON(path.join(bookDir, "summary.json")) || {};
  const quality = readJSON(path.join(bookDir, "quality.json")) || {};
  const traffic = readJSON(path.join(bookDir, "traffic.json")) || {};
  const worksData = readJSON(path.join(bookDir, "works-data.json")) || {};
  const revenue = readJSON(path.join(bookDir, "revenue.json")) || {};

  // Merge
  return {
    date,
    book: bookName,
    collectedAt: summary.collectedAt || `${date}T12:00:00.000Z`,
    status: summary.status || "",
    worksData,
    quality,
    traffic,
    revenue,
  };
}

async function main() {
  console.log("数据库迁移中…");
  await migrate();

  // Sync tenants
  const tenantsJson = loadTenantsJson();
  await syncTenantsFromJson(tenantsJson);
  console.log("租户已同步");

  // Find all book directories
  const bookDirs = findBookDirs(DATA_DIR);
  console.log(`找到 ${bookDirs.length} 条历史数据`);

  if (dryRun) {
    console.log("[DRY RUN] 将导入以下数据:");
    for (const bd of bookDirs) {
      console.log(`  ${bd.date} | ${bd.book}`);
    }
    console.log(`共 ${bookDirs.length} 条，未实际写入`);
    return;
  }

  // Import into SQLite (use "demo" as default tenant)
  let imported = 0;
  let errors = 0;
  for (const bd of bookDirs) {
    try {
      const summary = buildSummary(bd.dir, bd.date, bd.book);
      await saveCollection("demo", summary);
      imported++;
    } catch (e) {
      errors++;
      console.error(`  ✗ ${bd.date}/${bd.book}: ${e.message}`);
    }
    if ((imported + errors) % 10 === 0) {
      console.log(`  进度: ${imported + errors}/${bookDirs.length}`);
    }
  }

  console.log(`\n迁移完成: ${imported} 条导入, ${errors} 条失败`);
}

main().catch((e) => {
  console.error("迁移失败:", e);
  process.exit(1);
});
