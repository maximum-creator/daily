// Headless Chromium browser pool with per-tenant persistent contexts.
// Uses chromium.launchPersistentContext() so ALL cookies (including
// HttpOnly session tokens) survive across restarts — unlike storageState
// JSON export which drops session-only cookies.

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const PROFILES_DIR = path.join(__dirname, "..", "browser-profiles");

// ── Pool ──────────────────────────────────────────────────────────
// tenantId → { browser, context, pageCount, busy }
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

// ── Public API ────────────────────────────────────────────────────

async function getPage(tenantId) {
  let entry = pool.get(tenantId);

  if (!entry) {
    const context = await launchContext(tenantId);
    entry = { context, pageCount: 0, busy: false };
    pool.set(tenantId, entry);
  }

  entry.busy = true;
  entry.pageCount++;
  const page = await entry.context.newPage();
  return page;
}

function releasePage(tenantId, page) {
  const entry = pool.get(tenantId);
  if (!entry) return;

  page.close().catch(() => {});
  entry.pageCount--;
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
  // Check for sentinel file — only written after successful login
  return fs.existsSync(path.join(dir, ".profile-ready"));
}

function markProfileReady(tenantId) {
  const dir = profileDir(tenantId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".profile-ready"), new Date().toISOString());
}

module.exports = { getPage, releasePage, closeTenant, closeAll, hasProfile, markProfileReady, PROFILES_DIR };
