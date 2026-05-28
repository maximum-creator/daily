// Headless Chromium browser pool with per-tenant persistent contexts.
// Cookie strategy: persistent context for login → export cookies to JSON →
// import into headless context for collection.
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const PROFILES_DIR = path.join(__dirname, "..", "browser-profiles");

const pool = new Map();

function profileDir(tenantId) {
  return path.join(PROFILES_DIR, tenantId);
}

function getBrowserOptions(headless) {
  return {
    headless,
    viewport: { width: 1280, height: 720 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    args: [
      "--window-position=50,50",
      "--window-size=1280,720",
      "--disable-features=TranslateUI",
      "--no-first-run",
      "--disable-blink-features=AutomationControlled",
      "--disable-automation",
      "--no-sandbox",
      "--disable-setuid-sandbox",
    ],
  };
}

async function initScript(context) {
  await context.addInitScript(() => {
    // Core anti-detection overrides
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, "languages", { get: () => ["zh-CN", "zh", "en"] });
    // Spoof hardware to look like a real desktop
    Object.defineProperty(navigator, "hardwareConcurrency", { get: () => 8 });
    Object.defineProperty(navigator, "deviceMemory", { get: () => 8 });
    // Override permissions API
    const originalQuery = window.navigator.permissions?.query;
    if (originalQuery) {
      window.navigator.permissions.query = (params) =>
        params.name === "notifications"
          ? Promise.resolve({ state: Notification.permission, onchange: null })
          : originalQuery.call(window.navigator.permissions, params);
    }
    // Chrome runtime
    window.chrome = { runtime: {} };
    // Remove "HeadlessChrome" from userAgent
    Object.defineProperty(navigator, "userAgent", {
      get: () => "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });
  });
}

async function launchContext(tenantId) {
  const dir = profileDir(tenantId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const context = await chromium.launchPersistentContext(dir, getBrowserOptions(true));
  await initScript(context);

  // Inject saved cookies
  await injectCookies(tenantId, context);

  return context;
}

// Close ALL restored pages from a persistent context.
// launchPersistentContext restores EVERY previously-open tab from the
// profile's session storage — this causes visible "page explosion" where
// the user sees 5-10 tabs flash open. Close them all and let callers
// create exactly what they need.
async function cleanupPages(context) {
  const pages = context.pages();
  for (let i = pages.length - 1; i >= 0; i--) {
    await pages[i].close().catch(() => {});
  }
}

async function injectCookies(tenantId, context) {
  // Get existing cookie names to avoid duplicates
  const existing = await context.cookies();
  const existingNames = new Set(existing.map(c => `${c.name}@${c.domain}`));

  for (const platform of ["tmall", "jd"]) {
    const cookies = loadCookies(tenantId, platform);
    if (cookies.length > 0) {
      // Only inject cookies that don't already exist in context
      const newCookies = cookies.filter(c => !existingNames.has(`${c.name}@${c.domain}`));
      if (newCookies.length > 0) {
        try {
          await context.addCookies(newCookies);
          console.log(`[cookies] 已注入 ${newCookies.length}/${cookies.length} 个 ${platform} cookies (跳过${cookies.length - newCookies.length}个重复)`);
        } catch (e) {
          console.error(`[cookies] 注入${platform} cookies失败: ${e.message}`);
        }
      } else {
        console.log(`[cookies] ${platform}: ${cookies.length} 个cookies已存在，跳过注入`);
      }
    } else {
      console.log(`[cookies] ${platform}: 无可用cookies`);
    }
  }
  // Verify
  const all = await context.cookies();
  const jdAuth = all.filter(c => (c.domain||"").includes("jd") && ["pin","thor","unick"].includes(c.name));
  console.log(`[cookies] 验证: 共${all.length}个, JD认证cookies: ${jdAuth.length}个 (${jdAuth.map(c=>c.name).join(",")})`);
}

async function getPage(tenantId) {
  let entry = pool.get(tenantId);

  if (entry) {
    try {
      // Re-inject cookies before use — the other platform may have logged in since
      await injectCookies(tenantId, entry.context);
      const page = await entry.context.newPage();
      entry.busy = true;
      entry.pageCount++;
      return page;
    } catch (e) {
      await entry.context.close().catch(() => {});
      pool.delete(tenantId);
    }
  }

  // Create headed context — anti-bot bypass requires visible browser
  const dir = profileDir(tenantId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // Clean stale Default/ to prevent cookie bloat in SQLite
  // (launchPersistentContext loads SQLite cookies, injectCookies adds JSON ones → duplicates)
  const defaultDir = path.join(dir, "Default");
  if (fs.existsSync(defaultDir)) {
    fs.rmSync(defaultDir, { recursive: true });
  }

  // If another context is using this profile (e.g., login in progress),
  // retry with backoff to avoid file-lock conflict
  let context;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      context = await chromium.launchPersistentContext(dir, getBrowserOptions(false));
      break;
    } catch (e) {
      if (attempt < 4 && (e.message.includes("Target page") || e.message.includes("closed") || e.message.includes("session"))) {
        console.log(`[pool] profile被占用，等待重试 (${attempt + 1}/5)...`);
        await new Promise(r => setTimeout(r, 2000));
      } else {
        throw e;
      }
    }
  }
  if (!context) throw new Error("无法创建浏览器上下文：profile被占用");

  await initScript(context);
  await cleanupPages(context);
  await injectCookies(tenantId, context);

  entry = { context, pageCount: 0, busy: false };
  pool.set(tenantId, entry);
  entry.busy = true;
  entry.pageCount++;
  const page = await entry.context.newPage();
  return page;
}

// Pool management for external contexts (e.g., from login flow)
function addToPool(tenantId, context) {
  const existing = pool.get(tenantId);
  if (existing) {
    existing.context.close().catch(() => {});
  }
  pool.set(tenantId, { context, pageCount: 0, busy: false });
}

function releasePage(tenantId, page) {
  const entry = pool.get(tenantId);
  if (!entry) return;
  page.close().catch(() => {});
  if (entry.pageCount > 0) entry.pageCount--;
  entry.busy = false;
  // Clean up any extra pages that accumulated (keep at most 1 blank page)
  if (entry.pageCount <= 0) {
    cleanupPages(entry.context).catch(() => {});
  }
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

// ── Cookie persistence (explicit JSON export/import) ────────────

function saveCookies(tenantId, cookies, platform) {
  const dir = profileDir(tenantId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, `cookies-${platform}.json`);
  // Only save essential auth cookies (filter out analytics/tracking)
  const filtered = cookies.filter(c => {
    const name = c.name || "";
    // Skip analytics/tracking cookies, keep session/auth ones
    if (name.startsWith("__utm") || name.startsWith("cnzz")) return false;
    if (name === "xlly_s" || name === "x5secdata") return false;
    return true;
  });
  fs.writeFileSync(fp, JSON.stringify(filtered, null, 2));
  console.log(`[cookies] 已保存 ${filtered.length} 个 ${platform} cookies`);
  return filtered.length;
}

function loadCookies(tenantId, platform) {
  const fp = path.join(profileDir(tenantId), `cookies-${platform}.json`);
  if (!fs.existsSync(fp)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(fp, "utf-8"));
    // Validate cookie freshness — expire if older than 12 hours
    const now = Date.now();
    const valid = data.filter(c => {
      if (!c.expires || c.expires === -1) return true; // session cookie
      return c.expires * 1000 > now;
    });
    return valid;
  } catch (e) {
    console.error(`[cookies] 加载${platform} cookies失败: ${e.message}`);
    return [];
  }
}

function hasSavedCookies(tenantId, platform) {
  const fp = path.join(profileDir(tenantId), `cookies-${platform}.json`);
  if (!fs.existsSync(fp)) return false;
  const cookies = loadCookies(tenantId, platform);
  return cookies.length > 0;
}

// ── Platform login status ──────────────────────────────────────

function hasProfile(tenantId, platform) {
  const dir = profileDir(tenantId);
  if (!fs.existsSync(dir)) return false;
  // Check marker file with 24h freshness (JD sessions expire server-side)
  const marker = platform ? `.profile-ready-${platform}` : ".profile-ready";
  const markerPath = path.join(dir, marker);
  if (fs.existsSync(markerPath)) {
    try {
      const ts = new Date(fs.readFileSync(markerPath, "utf-8").trim()).getTime();
      if (Date.now() - ts < 24 * 60 * 60 * 1000) return true;
    } catch (e) { /* stale/invalid marker, fall through */ }
  }
  // Fallback: check for saved cookies with valid auth entries
  return hasSavedCookies(tenantId, platform || "tmall");
}

function markProfileReady(tenantId, platform) {
  const dir = profileDir(tenantId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const marker = platform ? `.profile-ready-${platform}` : ".profile-ready";
  fs.writeFileSync(path.join(dir, marker), new Date().toISOString());
}

function getPlatformStatus(tenantId) {
  return {
    tmall: hasProfile(tenantId, "tmall") || hasProfile(tenantId),
    jd: hasProfile(tenantId, "jd"),
  };
}

process.on("SIGTERM", () => { closeAll(); process.exit(); });
process.on("SIGINT", () => { closeAll(); process.exit(); });

module.exports = { chromium, getPage, releasePage, closeTenant, closeAll, hasProfile, markProfileReady, getPlatformStatus, addToPool, cleanupPages, getBrowserOptions, initScript, injectCookies, saveCookies, loadCookies, hasSavedCookies, PROFILES_DIR };
