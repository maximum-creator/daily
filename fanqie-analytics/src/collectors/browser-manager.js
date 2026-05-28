const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const logger = require("../utils/logger");

const PROFILES_DIR = path.join(__dirname, "..", "..", "browser-profiles");

const pool = new Map();

function profileDir(tenantId) {
  return path.join(PROFILES_DIR, tenantId);
}

async function launchContext(tenantId) {
  const dir = profileDir(tenantId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const context = await chromium.launchPersistentContext(dir, {
    headless: true,
    args: [
      "--disable-features=TranslateUI",
      "--no-first-run",
      "--disable-blink-features=AutomationControlled",
    ],
  });

  return context;
}

async function getPage(tenantId) {
  let entry = pool.get(tenantId);

  if (entry) {
    try {
      const page = await entry.context.newPage();
      entry.busy = true;
      entry.pageCount++;
      return page;
    } catch (e) {
      await entry.context.close().catch(() => {});
      pool.delete(tenantId);
    }
  }

  const context = await launchContext(tenantId);
  entry = { context, pageCount: 0, busy: false };
  pool.set(tenantId, entry);
  entry.busy = true;
  entry.pageCount++;
  return await entry.context.newPage();
}

function releasePage(tenantId, page) {
  const entry = pool.get(tenantId);
  if (!entry) return;
  page.close().catch(() => {});
  if (entry.pageCount > 0) entry.pageCount--;
  entry.busy = false;
}

async function closeTenant(tenantId) {
  const entry = pool.get(tenantId);
  if (!entry) return;
  await entry.context.close().catch(() => {});
  pool.delete(tenantId);
}

async function closeAll() {
  for (const [id, entry] of pool) {
    await entry.context.close().catch(() => {});
  }
  pool.clear();
}

function hasProfile(tenantId) {
  const dir = profileDir(tenantId);
  if (!fs.existsSync(dir)) return false;
  return fs.existsSync(path.join(dir, ".profile-ready"));
}

function markProfileReady(tenantId) {
  const dir = profileDir(tenantId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".profile-ready"), new Date().toISOString());
}

process.on("SIGTERM", () => { closeAll(); process.exit(); });
process.on("SIGINT", () => { closeAll(); process.exit(); });

module.exports = { getPage, releasePage, closeTenant, closeAll, hasProfile, markProfileReady, PROFILES_DIR, pool };
