#!/usr/bin/env node
/**
 * 番茄小说数据 API 服务
 *
 * 为 AI 写作平台提供 REST API，获取作者在番茄小说的数据。
 *
 * 启动: node server.js
 * 端口: 默认 3000（环境变量 PORT 覆盖）
 */

const express = require("express");
const fs = require("fs");
const path = require("path");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const { chromium } = require("playwright");
const { authMiddleware, loadTenants } = require("./lib/auth");
const { getPage, releasePage, hasProfile, markProfileReady, PROFILES_DIR } = require("./lib/browser-manager");
const { collectDashboard, collectForBook, saveCollection, switchToBook, jsClick, today } = require("./lib/collector");
const { usageTracker, getTodayUsage, getMonthlyUsage, getAllTenantsUsage, getTodayCollectionCount } = require("./lib/usage-tracker");
const { getPlan, getPlanLimits } = require("./lib/plans");
const { startScheduler } = require("./lib/scheduler");

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, "data");

// ── Global middleware ─────────────────────────────────────────────
app.use(express.json());
app.use(morgan("combined")); // Standard Apache combined log format

// Global rate limit: 100 req/min per IP
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { code: 429, message: "请求过于频繁，请稍后再试" },
});
app.use(globalLimiter);

// CORS — allow cross-origin for dashboard and external platforms
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// Static dashboard & assets
app.use(express.static(path.join(__dirname, "public")));

// Stricter rate limit for collect endpoint: 2 req/min per tenant
// Enterprise 租户免限流（管理员/付费客户不受此限制）
// Applied AFTER authMiddleware so req.tenant is guaranteed to exist
const collectLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 2,
  skip: (req) => {
    const plan = req.tenant?.plan || "trial";
    return plan === "enterprise";
  },
  keyGenerator: (req) => req.tenant?.id || "anonymous",
  standardHeaders: true,
  legacyHeaders: false,
  message: { code: 429, message: "采集请求过于频繁（每客户每分钟最多2次）" },
});

// Collection lock: prevent concurrent collection for the same tenant
const collecting = new Set();

// Progress tracking: tenantId → { phase, step, message, totalBooks, currentBook, done, error, result }
const collectProgress = new Map();

// Login sessions: track web-initiated login browsers
// tenantId → { browser, ready: bool }
const loginSessions = new Map();

// ── Health Check (no auth required) ──
app.get("/api/v1/health", (req, res) => {
  const tenants = loadTenants();
  const statuses = {};
  for (const [id, t] of Object.entries(tenants)) {
    const tenantDir = path.join(DATA_DIR, id);
    const hasData = fs.existsSync(tenantDir);
    const profileExists = hasProfile(id);
    let daysCount = 0;
    if (hasData) {
      try {
        daysCount = fs.readdirSync(tenantDir).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).length;
      } catch (e) { /* skip */ }
    }
    const planDef = getPlan(t.plan || "trial");
    const todayUsage = getTodayUsage(id);
    statuses[id] = {
      name: t.name,
      plan: t.plan,
      planLabel: planDef.name,
      planFee: planDef.monthlyFee,
      profileReady: profileExists,
      dataDays: daysCount,
      collecting: collecting.has(id),
      loginPending: loginSessions.has(id) && !loginSessions.get(id).ready,
      loginReady: loginSessions.has(id) && loginSessions.get(id).ready,
      todayApiCalls: todayUsage.total,
      todayCollections: todayUsage.endpoints["POST /api/v1/collect"] || 0,
      collectionLimit: planDef.maxCollectionsPerDay,
    };
  }
  res.json({
    code: 0,
    message: "ok",
    uptime: process.uptime(),
    tenants: statuses,
    memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + "MB",
  });
});

// ── All /api/v1 routes require API Key ──
app.use("/api/v1", authMiddleware);

// Usage tracking (after auth so req.tenant is available)
app.use("/api/v1", usageTracker);

// ── POST /api/v1/login — 网页端登录设置（打开可见浏览器，用户手动登录） ──
app.post("/api/v1/login", async (req, res) => {
  const tenantId = req.tenant.id;

  // Already logged in?
  if (hasProfile(tenantId)) {
    return res.json({ code: 0, message: "登录态已就绪", profileReady: true });
  }

  // Already launching browser
  if (loginSessions.has(tenantId)) {
    const sess = loginSessions.get(tenantId);
    return res.json({
      code: 0,
      message: sess.ready ? "登录已检测到，浏览器即将关闭" : "浏览器已打开，请在浏览器中扫码或验证码登录",
      profileReady: sess.ready,
    });
  }

  // Launch visible browser for manual login
  const userDataDir = path.join(PROFILES_DIR, tenantId);
  loginSessions.set(tenantId, { ready: false });

  // Async — don't block the response
  (async () => {
    let browser;
    try {
      browser = await chromium.launchPersistentContext(userDataDir, {
        headless: false,
        args: ["--disable-features=TranslateUI", "--no-first-run"],
      });

      const pages = browser.pages();
      const page = pages.length > 0 ? pages[0] : await browser.newPage();

      await page.goto("https://fanqienovel.com/main/writer/home", {
        waitUntil: "networkidle", timeout: 30000,
      }).catch(() => {});
      await page.waitForTimeout(2000);

      // Wait for login (URL leaves login/passport page)
      try {
        await page.waitForURL(
          (url) => !url.toString().includes("login") && !url.toString().includes("passport"),
          { timeout: 180000 } // 3 minutes for user to login
        );
        markProfileReady(tenantId);
        loginSessions.set(tenantId, { browser, ready: true });
        // Auto-close browser after successful login (give user 3s to see)
        await page.waitForTimeout(3000);
        await browser.close().catch(() => {});
        loginSessions.delete(tenantId);
      } catch (e) {
        // Timeout or navigation error — check if we have cookies anyway
        const cookies = await browser.cookies().catch(() => []);
        const hasFanqie = cookies.some((c) => c.domain.includes("fanqie"));
        if (hasFanqie) markProfileReady(tenantId);
        loginSessions.set(tenantId, { browser, ready: hasFanqie });
      }
    } catch (e) {
      loginSessions.delete(tenantId);
    }
  })();

  res.json({
    code: 0,
    message: "浏览器已打开，请在浏览器中登录番茄小说（扫码或验证码）",
    launching: true,
  });
});

// ── GET /api/v1/summary — 最新数据摘要 ──
// Query params: ?book=<书名>  筛选指定作品（可选）
app.get("/api/v1/summary", (req, res) => {
  const tenantId = req.tenant.id;
  const tenantDir = path.join(DATA_DIR, tenantId);
  const targetBook = req.query.book || "";

  if (!fs.existsSync(tenantDir)) {
    return res.json({ code: 404, message: "暂无数据，请先调用 POST /api/v1/collect" });
  }

  // Find latest date directory
  const dates = fs.readdirSync(tenantDir).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse();
  if (dates.length === 0) {
    return res.json({ code: 404, message: "暂无采集数据" });
  }

  // Walk latest dates to find matching book
  let summaryPath = null;
  let summary = null;
  for (const date of dates.slice(0, 3)) {
    const dateDir = path.join(tenantDir, date);
    const bookDirs = fs.readdirSync(dateDir).filter(f =>
      fs.statSync(path.join(dateDir, f)).isDirectory());
    for (const bd of bookDirs) {
      const sp = path.join(dateDir, bd, "summary.json");
      if (!fs.existsSync(sp)) continue;
      try {
        const s = JSON.parse(fs.readFileSync(sp, "utf-8"));
        if (!targetBook || s.book === targetBook || s.book.includes(targetBook) || targetBook.includes(s.book)) {
          summary = s;
          summaryPath = sp;
          break;
        }
        if (!summary) { summary = s; summaryPath = sp; } // fallback: first found
      } catch (e) { /* skip */ }
    }
    if (summary && (targetBook ? summary.book.includes(targetBook) || targetBook.includes(summary.book) : true)) break;
  }

  if (!summary) {
    return res.json({ code: 404, message: targetBook ? `未找到作品 "${targetBook}" 的数据` : "最近数据未完成采集" });
  }

  // Flatten to a clean API response
  const revenue = summary.revenue?.overview || {};
  const traffic = summary.traffic?.sources || {};

  res.json({
    code: 0,
    data: {
      date: summary.date,
      book: summary.book,
      collectedAt: summary.collectedAt,
      revenue: {
        yesterday: revenue.yesterdayRevenue || 0,
        total: revenue.totalRevenue || 0,
      },
      traffic,
      quality: {
        chaptersWithData: summary.quality?.chaptersWithCompletionRate || 0,
        totalChapters: summary.quality?.totalChapters || 0,
        avgWordCount: summary.quality?.avgWordCount || 0,
        cumulativeWords: summary.quality?.cumulativeWords || 0,
      },
    },
  });
});

// ── GET /api/v1/books — 作品列表 ──
app.get("/api/v1/books", (req, res) => {
  const tenantId = req.tenant.id;
  const tenantDir = path.join(DATA_DIR, tenantId);

  if (!fs.existsSync(tenantDir)) {
    return res.json({ code: 0, data: [] });
  }

  const dates = fs.readdirSync(tenantDir)
    .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort().reverse();

  const booksMap = new Map();
  for (const date of dates) {
    const dateDir = path.join(tenantDir, date);
    const bookDirs = fs.readdirSync(dateDir).filter(f =>
      fs.statSync(path.join(dateDir, f)).isDirectory());
    for (const bd of bookDirs) {
      if (booksMap.has(bd)) continue; // only latest
      const sp = path.join(dateDir, bd, "summary.json");
      if (fs.existsSync(sp)) {
        try {
          const s = JSON.parse(fs.readFileSync(sp, "utf-8"));
          booksMap.set(bd, {
            name: s.book,
            latestDate: s.date,
            latestRevenue: s.revenue?.overview?.yesterdayRevenue || 0,
            totalChapters: s.quality?.totalChapters || 0,
            cumulativeWords: s.quality?.cumulativeWords || 0,
          });
        } catch (e) { /* skip */ }
      }
    }
  }

  res.json({ code: 0, data: Array.from(booksMap.values()) });
});

// ── POST /api/v1/books/scan — 快速扫描作品列表（不采集数据）──
app.post("/api/v1/books/scan", collectLimiter, async (req, res) => {
  const tenantId = req.tenant.id;

  if (collecting.has(tenantId)) {
    return res.json({ code: 409, message: "该客户正在操作中，请稍后再试" });
  }

  if (!hasProfile(tenantId)) {
    return res.json({ code: 400, message: "未配置浏览器登录态，请先登录番茄小说" });
  }

  collecting.add(tenantId);
  let page;
  try {
    page = await getPage(tenantId);

    await page.goto("https://fanqienovel.com/main/writer/home", {
      waitUntil: "domcontentloaded", timeout: 20000,
    }).catch(() => {});
    try {
      await page.waitForSelector('[class*="nav-item"], [class*="sidebar"], [class*="menu-item"]', { timeout: 8000 });
    } catch (e) { /* continue */ }
    await page.waitForTimeout(800);

    const url = page.url();
    if (url.includes("login") || url.includes("passport")) {
      releasePage(tenantId, page);
      collecting.delete(tenantId);
      return res.json({ code: 401, message: "番茄小说登录态已过期，请重新登录" });
    }

    await page.waitForTimeout(300);

    const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 500) || "");
    if (bodyText.includes("请登录") || bodyText.includes("验证码") || bodyText.length < 50) {
      releasePage(tenantId, page);
      collecting.delete(tenantId);
      return res.json({ code: 401, message: "登录态失效或页面加载异常" });
    }

    await jsClick(page, "小说数据");
    await page.waitForTimeout(800);

    const dashboard = await collectDashboard(page);
    const novels = dashboard.novels || [];

    releasePage(tenantId, page);
    collecting.delete(tenantId);

    res.json({ code: 0, data: { novels }, message: `扫描完成，共 ${novels.length} 部作品` });
  } catch (e) {
    if (page) releasePage(tenantId, page);
    collecting.delete(tenantId);
    res.status(500).json({ code: 500, message: `扫描异常: ${e.message}` });
  }
});

// ── POST /api/v1/collect — 触发采集（异步，通过 /progress 获取进度）──
app.post("/api/v1/collect", collectLimiter, async (req, res) => {
  const tenantId = req.tenant.id;
  const todayStr = today();
  const todayDir = path.join(DATA_DIR, tenantId, todayStr);
  const force = req.query.force === "true" || req.query.force === "1";
  const booksParam = req.query.books || ""; // comma-separated book names to filter
  const fastMode = req.query.fast === "true" || req.query.fast === "1";

  // 时间策略：中午12点前数据平台通常未更新，保留缓存；
  // 12点后平台已更新，始终强制重采（数据可能延后到13点）
  const currentHour = new Date().getHours();
  const isAfterNoon = currentHour >= 12;

  // ── Plan quota check ──
  const plan = req.tenant.plan || "trial";
  const limits = getPlanLimits(plan);
  const todayCollectCount = getTodayCollectionCount(tenantId);
  if (todayCollectCount >= limits.maxCollectionsPerDay) {
    return res.status(429).json({
      code: 429,
      message: `今日采集次数已达上限（${limits.maxCollectionsPerDay}次/天），当前套餐: ${getPlan(plan).name}`,
      plan,
      limit: limits.maxCollectionsPerDay,
      used: todayCollectCount,
    });
  }
  // Check book count limit
  if (booksParam) {
    const requestedCount = booksParam.split(",").filter(Boolean).length;
    const maxBooks = req.tenant.maxBooks || limits.maxBooks;
    if (requestedCount > maxBooks) {
      return res.status(429).json({
        code: 429,
        message: `单次采集书数量超过套餐限制（${maxBooks}本），当前套餐: ${getPlan(plan).name}`,
        plan,
        limit: maxBooks,
        requested: requestedCount,
      });
    }
  }

  // Prevent concurrent collection for same tenant
  if (collecting.has(tenantId)) {
    return res.json({ code: 409, message: "该客户正在采集中，请稍后再试" });
  }

  // Check same-day cache — only valid before noon (platform data updates ~12-13)
  // After noon, always re-collect for fresh data even if today's dir exists
  // With ?books= specified, always proceed to do incremental refresh of those books
  if (!force && !booksParam && !isAfterNoon && fs.existsSync(todayDir)) {
    const books = fs.readdirSync(todayDir).filter(f =>
      fs.statSync(path.join(todayDir, f)).isDirectory());
    const summaries = [];
    for (const b of books) {
      const sp = path.join(todayDir, b, "summary.json");
      if (fs.existsSync(sp)) {
        summaries.push(JSON.parse(fs.readFileSync(sp, "utf-8")));
      }
    }
    if (summaries.length > 0) {
      return res.json({
        code: 0,
        data: summaries.map(s => ({ date: s.date, book: s.book, collectedAt: s.collectedAt })),
        cached: true,
        message: `今日已采集 ${summaries.length} 本书，返回缓存。数据平台每日12:00后更新，届时采集将自动刷新。`,
      });
    }
  }

  // Check profile exists (tenant has logged in at least once)
  if (!hasProfile(tenantId)) {
    return res.json({
      code: 400,
      message: "未配置浏览器登录态，请先运行 scripts/quick-login.js 登录番茄小说",
    });
  }

  // Start async collection — store progress, return immediately
  const startTime = Date.now();
  const progress = {
    phase: "starting",
    message: "正在启动无头浏览器…",
    totalBooks: 0,
    currentBook: 0,
    done: false,
    startTime,
    elapsed: 0,
    books: [], // [{ name, status: "pending"|"collecting"|"done"|"error"|"cached", error }]
  };
  collectProgress.set(tenantId, progress);
  collecting.add(tenantId);

  // Return immediately — frontend polls GET /api/v1/collect/progress for updates
  res.json({ code: 0, data: { async: true, taskId: tenantId }, message: "采集已启动" });

  // Run collection in background
  runCollection(tenantId, force, todayStr, todayDir, progress, booksParam, fastMode);
});

// Background collection runner — updates progress map at each step
async function runCollection(tenantId, force, todayStr, todayDir, progress, booksParam, fastMode) {
  let page;
  try {
    // ── Step 1: Launch browser ──
    progress.phase = "browser";
    progress.message = "正在启动无头浏览器…";
    page = await getPage(tenantId);

    // ── Step 2: Navigate to Fanqie backend ──
    progress.phase = "navigate";
    progress.message = "正在导航到番茄小说作者后台…";
    // domcontentloaded is much faster than "load" — the SPA renders before
    // all third-party scripts (analytics, tracking) finish loading
    await page.goto("https://fanqienovel.com/main/writer/home", {
      waitUntil: "domcontentloaded", timeout: 20000,
    }).catch(() => {});
    // Wait for SPA to render nav items
    try {
      await page.waitForSelector('[class*="nav-item"], [class*="sidebar"], [class*="menu-item"]', { timeout: 8000 });
    } catch (e) { /* continue even without nav — page might have loaded differently */ }
    await page.waitForTimeout(800);

    // ── Step 3: Check login state ──
    progress.phase = "login_check";
    progress.message = "验证登录态…";
    const url = page.url();
    if (url.includes("login") || url.includes("passport")) {
      releasePage(tenantId, page);
      collecting.delete(tenantId);
      progress.phase = "error";
      progress.message = "番茄小说登录态已过期，请重新登录";
      progress.done = true;
      progress.error = true;
      return;
    }

    // Nav selector already waited after page load — skip redundant wait
    await page.waitForTimeout(300);

    const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 500) || "");
    if (bodyText.includes("请登录") || bodyText.includes("验证码") || bodyText.length < 50) {
      releasePage(tenantId, page);
      collecting.delete(tenantId);
      progress.phase = "error";
      progress.message = "登录态失效或页面加载异常";
      progress.done = true;
      progress.error = true;
      return;
    }

    // ── Step 4: Navigate to data center ──
    progress.phase = "data_page";
    progress.message = "进入小说数据中心…";
    await jsClick(page, "小说数据");
    await page.waitForTimeout(800);
    const dataPageUrl = page.url();

    // ── Step 5: Collect book list ──
    progress.phase = "dashboard";
    progress.message = "读取作品列表…";
    const dashboard = await collectDashboard(page);
    let targetBooks = dashboard.novels || [];

    if (targetBooks.length === 0) {
      releasePage(tenantId, page);
      collecting.delete(tenantId);
      progress.phase = "error";
      progress.message = "未找到任何作品";
      progress.done = true;
      progress.error = true;
      return;
    }

    // Filter by requested books (if provided) — exact match first, then fuzzy
    if (booksParam) {
      const requested = booksParam.split(",").map(s => s.trim()).filter(Boolean);
      const filtered = [];
      for (const r of requested) {
        let found = targetBooks.find(b => b.name === r);
        if (!found) found = targetBooks.find(b => b.name.includes(r) || r.includes(b.name));
        if (found && !filtered.includes(found)) filtered.push(found);
      }
      if (filtered.length === 0) {
        releasePage(tenantId, page);
        collecting.delete(tenantId);
        progress.phase = "error";
        progress.message = "指定作品未找到，请检查书名是否正确";
        progress.done = true;
        progress.error = true;
        return;
      }
      targetBooks = filtered;
    }

    // ── Step 6: Collect each book ──
    progress.totalBooks = targetBooks.length;
    progress.phase = "collecting";
    progress.books = targetBooks.map(b => ({ name: b.name, status: "pending" }));
    const collected = [];

    for (let i = 0; i < targetBooks.length; i++) {
      const book = targetBooks[i];
      progress.currentBook = i + 1;
      progress.message = `正在采集《${book.name}》数据 (${i + 1}/${targetBooks.length})`;
      progress.books[i].status = "collecting";

      const bookSafeName = book.name.replace(/[<>:"/\\|?*]/g, "_").trim();
      const summaryPath = path.join(todayDir, bookSafeName, "summary.json");
      if (!force && fs.existsSync(summaryPath)) {
        let existing;
        try { existing = JSON.parse(fs.readFileSync(summaryPath, "utf-8")); } catch (e) { existing = null; }
        if (existing && existing.date === todayStr) {
          // Incremental update: re-collect fast fields (revenue, worksData)
          // and merge existing quality + traffic from disk
          const switched = await switchToBook(page, book.name, dataPageUrl);
          if (!switched) {
            collected.push({ book: book.name, cached: true });
            progress.books[i].status = "cached";
            continue;
          }
          const fastSummary = await collectForBook(page, book.name, book.status || "", true);
          // Merge preserved data from disk
          const qPath = path.join(todayDir, bookSafeName, "quality.json");
          const tPath = path.join(todayDir, bookSafeName, "traffic.json");
          if (fs.existsSync(qPath)) {
            try { fastSummary.quality = JSON.parse(fs.readFileSync(qPath, "utf-8")); } catch (e) { /* keep fastSummary.quality */ }
          }
          if (fs.existsSync(tPath)) {
            try { fastSummary.traffic = JSON.parse(fs.readFileSync(tPath, "utf-8")); } catch (e) { /* keep fastSummary.traffic */ }
          }
          // Merge dataFreshness: fast mode only refreshed worksData+revenue;
          // preserve quality/traffic freshness from existing data
          if (existing.dataFreshness) {
            fastSummary.dataFreshness = fastSummary.dataFreshness || {};
            for (const section of ["quality", "traffic"]) {
              if (!fastSummary.dataFreshness[section] && existing.dataFreshness[section]) {
                fastSummary.dataFreshness[section] = existing.dataFreshness[section];
              }
            }
          }
          saveCollection(DATA_DIR, tenantId, fastSummary);
          progress.books[i].status = "updated";
          collected.push({
            book: book.name,
            status: book.status || "",
            revenue: fastSummary.revenue?.overview?.yesterdayRevenue || 0,
            chapters: fastSummary.quality?.chaptersWithCompletionRate || 0,
            collectedAt: fastSummary.collectedAt,
            updated: true,
          });
          continue;
        }
      }

      const switched = await switchToBook(page, book.name, dataPageUrl);
      if (!switched) {
        collected.push({ book: book.name, error: "切换失败" });
        progress.books[i].status = "error";
        progress.books[i].error = "切换失败";
        continue;
      }

      try {
        const summary = await collectForBook(page, book.name, book.status || "", fastMode);
        saveCollection(DATA_DIR, tenantId, summary);
        progress.books[i].status = "done";
        collected.push({
          book: book.name,
          status: book.status || "",
          revenue: summary.revenue?.overview?.yesterdayRevenue || 0,
          chapters: summary.quality?.chaptersWithCompletionRate || 0,
          collectedAt: summary.collectedAt,
        });
      } catch (bookErr) {
        collected.push({ book: book.name, error: bookErr.message });
        progress.books[i].status = "error";
        progress.books[i].error = bookErr.message;
      }
    }

    try { releasePage(tenantId, page); } catch (e) { /* page already closed */ }
    collecting.delete(tenantId);

    progress.phase = "done";
    progress.done = true;
    progress.result = {
      date: todayStr,
      books: collected,
      total: collected.length,
    };
    progress.message = `采集完成，共 ${collected.length} 本书`;

  } catch (e) {
    try { if (page) releasePage(tenantId, page); } catch (e2) { /* ignore */ }
    collecting.delete(tenantId);
    progress.phase = "error";
    progress.done = true;
    progress.error = true;
    progress.message = `采集异常: ${e.message || e}`;
  }
}

// ── GET /api/v1/collect/progress — 采集进度查询 ──
app.get("/api/v1/collect/progress", (req, res) => {
  const tenantId = req.tenant.id;
  const progress = collectProgress.get(tenantId);
  if (!progress) {
    return res.json({ code: 0, data: { phase: "idle" } });
  }
  // Compute elapsed dynamically
  const elapsed = progress.startTime ? Math.round((Date.now() - progress.startTime) / 1000) : 0;
  res.json({ code: 0, data: { ...progress, elapsed } });
});

// ── GET /api/v1/report — 趋势报告 ──
// Query params: ?period=7d|30d & ?book=<书名>
app.get("/api/v1/report", (req, res) => {
  const tenantId = req.tenant.id;
  const period = req.query.period || "7d";
  const days = period === "30d" ? 30 : 7;
  const targetBook = req.query.book || "";

  const logPath = path.join(DATA_DIR, tenantId, "daily-log.json");
  if (!fs.existsSync(logPath)) {
    return res.json({ code: 404, message: "暂无数据" });
  }

  let log = JSON.parse(fs.readFileSync(logPath, "utf-8"));

  // Filter by book if specified
  if (targetBook) {
    log = log.filter(d => d.book === targetBook || (d.book || "").includes(targetBook) || targetBook.includes(d.book || ""));
  }
  log = log.slice(-days);

  // Compute trend from daily log
  const revenue = log.map(d => d.revenue?.overview?.yesterdayRevenue || 0);
  const readers = [], bookmarks = [], words = [];

  for (const d of log) {
    readers.push(d.worksData?.["阅读人数"] || 0);
    bookmarks.push(d.worksData?.["加书架人数"] || 0);
    words.push(d.quality?.cumulativeWords || (d.quality?.avgWordCount * d.quality?.totalChapters) || 0);
  }

  res.json({
    code: 0,
    data: {
      period,
      days: log.length,
      book: log[0]?.book || "",
      revenue,
      readers,
      bookmarks,
      cumulativeWords: words,
      dates: log.map(d => d.date),
    },
  });
});

// ── GET /api/v1/predict — 收益预测 ──
// Query params: ?book=<书名>
app.get("/api/v1/predict", (req, res) => {
  const tenantId = req.tenant.id;
  const tenantDir = path.join(DATA_DIR, tenantId);
  const targetBook = req.query.book || "";

  let revenueValues = [];

  if (targetBook) {
    // Use rich dailyRevenue from revenue.json (30-day history per collection)
    const dates = fs.existsSync(tenantDir)
      ? fs.readdirSync(tenantDir).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse()
      : [];
    for (const d of dates) {
      const dateDir = path.join(tenantDir, d);
      const books = fs.readdirSync(dateDir).filter(f =>
        fs.statSync(path.join(dateDir, f)).isDirectory()
      );
      // Match book name: exact first, then fuzzy
      const match = books.find(b => b === targetBook)
        || books.find(b => b.includes(targetBook) || targetBook.includes(b));
      if (match) {
        const rp = path.join(dateDir, match, "revenue.json");
        if (fs.existsSync(rp)) {
          try {
            const rev = JSON.parse(fs.readFileSync(rp, "utf-8"));
            if (rev.dailyRevenue && rev.dailyRevenue.length > 0) {
              revenueValues = rev.dailyRevenue
                .map(r => r.total || 0)
                .filter(v => v > 0);
              break; // Use most recent date with revenue data
            }
          } catch (e) { /* skip corrupted file */ }
        }
      }
    }
  }

  if (revenueValues.length === 0) {
    // Fallback: use daily-log summary entries
    const logPath = path.join(DATA_DIR, tenantId, "daily-log.json");
    if (fs.existsSync(logPath)) {
      let log = JSON.parse(fs.readFileSync(logPath, "utf-8"));
      if (targetBook) {
        log = log.filter(d => d.book === targetBook || (d.book || "").includes(targetBook) || targetBook.includes(d.book || ""));
      }
      revenueValues = log.map(d => d.revenue?.overview?.yesterdayRevenue || 0).filter(v => v > 0);
    }
  }

  if (revenueValues.length < 3) {
    return res.json({ code: 400, message: "至少需要 3 天有收益数据" });
  }

  const pred7 = predictFuture(revenueValues, 7);
  const pred30 = predictFuture(revenueValues, 30);

  res.json({
    code: 0,
    data: {
      recentAvg: Math.round(revenueValues.slice(-3).reduce((a, b) => a + b, 0) / 3 * 100) / 100,
      prediction7d: pred7[pred7.length - 1],
      prediction30d: pred30[pred30.length - 1],
      full7d: pred7,
      full30d: pred30,
    },
  });
});

// ── GET /api/v1/chapters — 章节分析 + 异常检测 ──
// Query params: ?book=<书名>  筛选指定作品（可选）
app.get("/api/v1/chapters", (req, res) => {
  const tenantId = req.tenant.id;
  const tenantDir = path.join(DATA_DIR, tenantId);
  const targetBook = req.query.book || "";

  if (!fs.existsSync(tenantDir)) {
    return res.json({ code: 404, message: "暂无数据" });
  }

  // Find latest date directory with quality.json
  const dates = fs.readdirSync(tenantDir).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse();
  if (dates.length === 0) return res.json({ code: 404, message: "暂无数据" });

  // Walk back through dates to find matching quality data
  let quality = null;
  let foundDate = "";
  for (const date of dates.slice(0, 5)) {
    const dateDir = path.join(tenantDir, date);
    const bookDirs = fs.readdirSync(dateDir).filter(f =>
      fs.statSync(path.join(dateDir, f)).isDirectory());
    for (const bd of bookDirs) {
      const qp = path.join(dateDir, bd, "quality.json");
      if (!fs.existsSync(qp)) continue;
      try {
        const q = JSON.parse(fs.readFileSync(qp, "utf-8"));
        const bookName = q.book || bd;
        if (!targetBook || bookName === targetBook || bookName.includes(targetBook) || targetBook.includes(bookName)) {
          quality = q;
          foundDate = date;
          break;
        }
        if (!quality) { quality = q; foundDate = date; }
      } catch (e) { /* skip */ }
    }
    if (quality && targetBook && (quality.book || "").includes(targetBook)) break;
  }

  if (!quality) return res.json({ code: 404, message: "暂无质量数据" });
  const chapters = quality.chapters || [];

  // Compute averages
  const rates = chapters.map(c => c.completionRate).filter(r => r > 0);
  const avgRate = rates.length > 0 ? rates.reduce((a, b) => a + b, 0) / rates.length : 0;
  const followRates = chapters.map(c => c.followReadRate).filter(r => r > 0);
  const avgFollow = followRates.length > 0 ? followRates.reduce((a, b) => a + b, 0) / followRates.length : 0;

  // Anomalies
  const anomalies = [];
  for (const ch of chapters) {
    if (ch.completionRate > 0 && ch.completionRate < avgRate * 0.3) {
      anomalies.push({
        chapter: ch.chapter,
        title: ch.title,
        type: "low_completion",
        value: ch.completionRate,
        avg: Math.round(avgRate * 10) / 10,
        message: `读完率 ${ch.completionRate}% 远低于平均 ${avgRate.toFixed(1)}%`,
      });
    }
    if (ch.followReadRate > 0 && ch.followReadRate < avgFollow * 0.3) {
      anomalies.push({
        chapter: ch.chapter,
        title: ch.title,
        type: "follow_drop",
        value: ch.followReadRate,
        avg: Math.round(avgFollow * 10) / 10,
        message: `跟读率暴跌至 ${ch.followReadRate}%`,
      });
    }
  }

  res.json({
    code: 0,
    data: {
      date: foundDate,
      book: quality.book || "",
      totalChapters: quality.chapterList?.length || chapters.length,
      chaptersWithData: chapters.length,
      avgCompletionRate: Math.round(avgRate * 10) / 10,
      avgFollowRate: Math.round(avgFollow * 10) / 10,
      anomalies,
      recent10: chapters.slice(-10).map(ch => ({
        chapter: ch.chapter,
        title: ch.title,
        completionRate: ch.completionRate,
        followReadRate: ch.followReadRate,
        lossRate: ch.lossRate,
        wordCount: ch.wordCount,
      })),
    },
  });
});

// ── GET /api/v1/traffic — 流量来源 ──
// Query params: ?book=<书名>  筛选指定作品（可选）
app.get("/api/v1/traffic", (req, res) => {
  const tenantId = req.tenant.id;
  const tenantDir = path.join(DATA_DIR, tenantId);
  const targetBook = req.query.book || "";

  if (!fs.existsSync(tenantDir)) return res.json({ code: 404, message: "暂无数据" });

  const dates = fs.readdirSync(tenantDir).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse();
  if (dates.length === 0) return res.json({ code: 404, message: "暂无数据" });

  // Walk back through dates to find matching traffic data
  for (const date of dates.slice(0, 5)) {
    const dateDir = path.join(tenantDir, date);
    const bookDirs = fs.readdirSync(dateDir).filter(f =>
      fs.statSync(path.join(dateDir, f)).isDirectory());
    for (const bd of bookDirs) {
      const tp = path.join(dateDir, bd, "traffic.json");
      if (!fs.existsSync(tp)) continue;
      try {
        const traffic = JSON.parse(fs.readFileSync(tp, "utf-8"));
        // Infer book name from parent directory or summary
        const sp = path.join(dateDir, bd, "summary.json");
        let bookName = bd;
        if (fs.existsSync(sp)) {
          try { bookName = JSON.parse(fs.readFileSync(sp, "utf-8")).book || bd; } catch (e) { /* skip */ }
        }
        if (!targetBook || bookName === targetBook || bookName.includes(targetBook) || targetBook.includes(bookName)) {
          return res.json({ code: 0, data: { book: bookName, date, ...traffic } });
        }
      } catch (e) { /* skip */ }
    }
  }
  res.json({ code: 404, message: "暂无流量数据" });
});

// ── GET /api/v1/metrics — 核心指标（全勤、千字收益等） ──
// Query params: ?book=<书名>
app.get("/api/v1/metrics", (req, res) => {
  const tenantId = req.tenant.id;
  const logPath = path.join(DATA_DIR, tenantId, "daily-log.json");

  if (!fs.existsSync(logPath)) return res.json({ code: 404, message: "暂无数据" });

  let log = JSON.parse(fs.readFileSync(logPath, "utf-8"));
  const targetBook = req.query.book || "";

  // Filter by book if specified
  if (targetBook) {
    log = log.filter(d => d.book === targetBook || (d.book || "").includes(targetBook) || targetBook.includes(d.book || ""));
    if (log.length === 0) return res.json({ code: 404, message: `未找到作品 "${targetBook}" 的数据` });
  }

  const latest = log[log.length - 1];

  // Compute key metrics
  const revenue = log.map(d => d.revenue?.overview?.yesterdayRevenue || 0);
  const words = log.map(d => d.quality?.cumulativeWords || 0);
  const chaptersPerDay = log.map(d => d.quality?.chaptersWithCompletionRate || 0);

  const totalRevenue = revenue.reduce((a, b) => a + b, 0);
  const totalWords = words[words.length - 1] || 0;
  const recentRevenue = revenue.slice(-7).reduce((a, b) => a + b, 0);
  const revenuePerKWords = totalWords > 0 ? (totalRevenue / (totalWords / 1000)) : 0;

  res.json({
    code: 0,
    data: {
      book: latest?.book || "",
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      recent7dRevenue: Math.round(recentRevenue * 100) / 100,
      totalWords,
      revenuePerKWords: Math.round(revenuePerKWords * 1000) / 1000,
      avgDailyChapters: Math.round(chaptersPerDay.reduce((a, b) => a + b, 0) / chaptersPerDay.length * 10) / 10,
      dataDays: log.length,
      milestone: getMilestone(totalRevenue),
    },
  });
});

// ── GET /api/v1/analysis — 平台感知的智能分析 ──
app.get("/api/v1/analysis", (req, res) => {
  const tenantId = req.tenant.id;
  const tenantDir = path.join(DATA_DIR, tenantId);
  const targetBook = req.query.book || "";

  if (!fs.existsSync(tenantDir)) {
    return res.json({ code: 404, message: "暂无数据" });
  }

  // Read daily-log for trend data
  const logPath = path.join(tenantDir, "daily-log.json");
  let log = [];
  if (fs.existsSync(logPath)) {
    try { log = JSON.parse(fs.readFileSync(logPath, "utf-8")); } catch (e) { /* skip */ }
  }
  if (targetBook) {
    log = log.filter(d => d.book === targetBook || (d.book || "").includes(targetBook) || targetBook.includes(d.book || ""));
  }
  if (log.length === 0) return res.json({ code: 404, message: "暂无数据" });

  const latest = log[log.length - 1];
  const bookName = latest.book || "";
  const status = latest.status || "";

  // ── Stage Detection ──
  const dailyWords = latest.quality?.dailyWords || {};
  const wordValues = Object.values(dailyWords);
  const dataDays = Object.keys(dailyWords).length; // 实际有更新的天数，而非采集次数
  // 日更字数用中位数——首日批量上传会导致均值严重虚高
  const sortedDailyWords = wordValues.length > 0 ? [...wordValues].sort((a, b) => a - b) : [];
  const avgDailyWords = sortedDailyWords.length > 0
    ? sortedDailyWords[Math.floor(sortedDailyWords.length / 2)]
    : 0;

  // 收益：从 dailyRevenue 数组计算（跨采集周期的完整数据）
  let totalRevenue = 0, recent7Revenue = 0;
  const allDailyRevenue = latest.revenue?.dailyRevenue;
  if (allDailyRevenue && allDailyRevenue.length > 0) {
    const sorted = [...allDailyRevenue].sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    totalRevenue = sorted.reduce((a, b) => a + (b.total || 0), 0);
    const last7 = sorted.slice(-7);
    recent7Revenue = last7.reduce((a, b) => a + (b.total || 0), 0);
  } else {
    // Fallback: 从 daily-log 的 overview 聚合
    const revenue = log.map(d => d.revenue?.overview?.yesterdayRevenue || 0);
    totalRevenue = revenue.reduce((a, b) => a + b, 0);
    recent7Revenue = revenue.slice(-7).reduce((a, b) => a + b, 0);
  }

  const words = log.map(d => d.quality?.cumulativeWords || 0);
  const latestWords = words[words.length - 1] || 0;

  // ── Traffic Composition (needed for lifecycle detection) ──
  const trafficSources = latest.traffic?.sources || {};
  const totalTraffic = Object.values(trafficSources).reduce((a, b) => a + b, 0);
  const searchTraffic = trafficSources["搜索"] || 0;
  const searchRatio = totalTraffic > 0 ? searchTraffic / totalTraffic : 0;

  // ── Lifecycle Detection (multi-signal) ──
  // Signal 1: explicit status text from page
  const explicitVerification = status.includes("验证中") || status.includes("审核中");
  const isSigned = status.includes("已签约");
  const isFinished = status.includes("已完结");

  // Signal 2: recency heuristic — books published ≤14 days ago are likely in 验证期
  const chapterList = latest.quality?.chapterList || [];
  let daysSinceFirstPublish = 999;
  if (chapterList.length > 0) {
    const publishDates = chapterList
      .map(c => c.publishTime)
      .filter(Boolean)
      .sort();
    if (publishDates.length > 0) {
      const firstDate = new Date(publishDates[0]);
      daysSinceFirstPublish = Math.round((Date.now() - firstDate) / 86400000);
    }
  }
  // Also check dailyWords keys for earliest date
  const dwKeys = Object.keys(dailyWords).sort();
  if (dwKeys.length > 0) {
    const dwFirst = new Date(dwKeys[0]);
    const dwDays = Math.round((Date.now() - dwFirst) / 86400000);
    daysSinceFirstPublish = Math.min(daysSinceFirstPublish, dwDays);
  }

  // Signal 3: traffic pattern — search-dominated is typical of 验证期
  const looksLikeVerification = (
    !isSigned &&
    !isFinished &&
    daysSinceFirstPublish <= 14 &&
    (explicitVerification || searchRatio > 0.5 || daysSinceFirstPublish <= 10)
  );

  const stage = isFinished ? "finished"
    : isSigned ? "signed"
    : (explicitVerification || looksLikeVerification) ? "verification"
    : "unsigned";

  // ── Quality Analysis ──
  const milestoneChapters = latest.quality?.milestoneChapters || {};
  const milestones = latest.quality?.milestones || {};
  const chapters = latest.quality?.chapters || [];
  const rates = chapters.map(c => c.completionRate).filter(r => r > 0);
  const avgCompletion = rates.length > 0
    ? Math.round(rates.reduce((a, b) => a + b, 0) / rates.length * 10) / 10
    : 0;
  const followRates = chapters.map(c => c.followReadRate).filter(r => r > 0);
  const avgFollow = followRates.length > 0
    ? Math.round(followRates.reduce((a, b) => a + b, 0) / followRates.length * 10) / 10
    : 0;

  // Chapter-level completion rate decay
  let earlyRate = 0, midRate = 0, lateRate = 0;
  if (chapters.length > 0) {
    const third = Math.ceil(chapters.length / 3);
    const earlyRates = chapters.slice(0, third).map(c => c.completionRate).filter(r => r > 0);
    const midRates = chapters.slice(third, third * 2).map(c => c.completionRate).filter(r => r > 0);
    const lateRates = chapters.slice(third * 2).map(c => c.completionRate).filter(r => r > 0);
    earlyRate = earlyRates.length > 0 ? Math.round(earlyRates.reduce((a, b) => a + b, 0) / earlyRates.length * 10) / 10 : 0;
    midRate = midRates.length > 0 ? Math.round(midRates.reduce((a, b) => a + b, 0) / midRates.length * 10) / 10 : 0;
    lateRate = lateRates.length > 0 ? Math.round(lateRates.reduce((a, b) => a + b, 0) / lateRates.length * 10) / 10 : 0;
  }

  // Completion rate at word milestones
  const milestone100k = milestoneChapters["100000"];
  const milestone50k = milestoneChapters["50000"];

  // ── Anomaly Detection (z-score method) ──
  // 使用统计学标准：偏离均值超过2个标准差视为异常，避免固定阈值的误判
  const calcStats = (arr) => {
    if (arr.length === 0) return { mean: 0, std: 0 };
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    const variance = arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length;
    return { mean, std: Math.sqrt(variance) };
  };
  const completionStats = calcStats(rates);
  const followStats = calcStats(followRates);

  const anomalies = [];
  for (const ch of chapters) {
    if (ch.completionRate > 0 && completionStats.std > 0) {
      const zScore = (ch.completionRate - completionStats.mean) / completionStats.std;
      if (zScore < -2) {
        anomalies.push({
          chapter: ch.chapter, title: ch.title,
          type: "completion_drop",
          value: ch.completionRate, avg: Math.round(completionStats.mean * 10) / 10,
          zScore: Math.round(zScore * 10) / 10,
          severity: zScore < -2.5 ? "high" : "medium",
        });
      }
    }
    if (ch.followReadRate > 0 && followStats.std > 0) {
      const zScore = (ch.followReadRate - followStats.mean) / followStats.std;
      if (zScore < -2) {
        anomalies.push({
          chapter: ch.chapter, title: ch.title,
          type: "follow_drop",
          value: ch.followReadRate, avg: Math.round(followStats.mean * 10) / 10,
          zScore: Math.round(zScore * 10) / 10,
          severity: zScore < -2.5 ? "high" : "medium",
        });
      }
    }
  }
  // 按严重程度排序
  anomalies.sort((a, b) => (a.zScore || 0) - (b.zScore || 0));

  // ── Update Consistency ──
  const updateScore = wordValues.length > 0
    ? (() => {
        const sortedDays = Object.keys(dailyWords).sort();
        if (sortedDays.length < 2) return 50;
        let gaps = 0;
        for (let i = 1; i < sortedDays.length; i++) {
          const prev = new Date(sortedDays[i - 1]);
          const curr = new Date(sortedDays[i]);
          const diffDays = Math.round((curr - prev) / 86400000);
          if (diffDays > 2) gaps++;
        }
        return Math.max(0, 100 - gaps * 25);
      })()
    : 0;

  // ── Merge chapterList word data with chapters quality data ──
  const chWordMap = {};
  for (const c of chapterList) {
    if (c.wordCount > 0) chWordMap[c.chapter] = c.wordCount;
  }
  const mergedChapters = chapters.map(c => ({
    ...c,
    wordCount: chWordMap[c.chapter] || 0,
  })).filter(c => c.wordCount > 0);

  // ── Completion Curve (per-chapter data for visualization) ──
  const completionCurve = mergedChapters.map(c => ({
    chapter: c.chapter,
    title: c.title || "",
    completionRate: c.completionRate || 0,
    followReadRate: c.followReadRate || 0,
    wordCount: c.wordCount || 0,
  }));

  // ── Find biggest drop point (for targeted suggestions) ──
  let biggestDrop = null;
  for (let i = 1; i < completionCurve.length; i++) {
    const prev = completionCurve[i - 1];
    const curr = completionCurve[i];
    if (prev.completionRate > 0 && curr.completionRate > 0) {
      const drop = prev.completionRate - curr.completionRate;
      if (drop > 0 && (!biggestDrop || drop > biggestDrop.drop)) {
        biggestDrop = { from: prev, to: curr, drop: Math.round(drop * 10) / 10 };
      }
    }
  }

  // ── Engagement Metrics ──
  const wd = latest.worksData || {};
  const bookmarkCount = wd["加书架人数"] || 0;
  const urgeCount = wd["催更人数"] || 0;
  const followCount = wd["追更人数"] || 0;
  const commentCount = wd["评论次数"] || 0;
  const readerCount = wd["阅读人数"] || totalTraffic;
  const hasInteraction = bookmarkCount > 0 || urgeCount > 0 || commentCount > 0;

  // ── Trend Analysis (linear regression on historical data) ──
  const trendFromLog = (extractFn) => {
    const points = [];
    for (const entry of log) {
      const val = extractFn(entry);
      if (val != null && val > 0) points.push(val);
    }
    if (points.length < 2) return "stable";
    // Linear regression slope
    const n = points.length;
    const xMean = (n - 1) / 2;
    const yMean = points.reduce((a, b) => a + b, 0) / n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) {
      num += (i - xMean) * (points[i] - yMean);
      den += (i - xMean) ** 2;
    }
    const slope = den !== 0 ? num / den : 0;
    // Normalize by mean for comparability
    const normSlope = yMean > 0 ? slope / yMean : 0;
    if (normSlope > 0.05) return "rising";
    if (normSlope < -0.05) return "falling";
    return "stable";
  };

  const trends = {
    completion: trendFromLog(e => {
      const chs = e.quality?.chapters || [];
      const rts = chs.map(c => c.completionRate).filter(r => r > 0);
      return rts.length > 0 ? rts.reduce((a, b) => a + b, 0) / rts.length : null;
    }),
    follow: trendFromLog(e => {
      const chs = e.quality?.chapters || [];
      const rts = chs.map(c => c.followReadRate).filter(r => r > 0);
      return rts.length > 0 ? rts.reduce((a, b) => a + b, 0) / rts.length : null;
    }),
    revenue: trendFromLog(e => e.revenue?.overview?.yesterdayRevenue || 0),
  };

  // ── Engagement Funnel ──
  const totalAudience = readerCount || totalTraffic;
  const funnel = {
    readers: totalAudience,
    followers: followCount || 0,
    bookmarkers: bookmarkCount || 0,
    commenters: commentCount || 0,
    followRate: totalAudience > 0 ? Math.round(followCount / totalAudience * 1000) / 10 : 0,
    bookmarkRate: totalAudience > 0 ? Math.round(bookmarkCount / totalAudience * 1000) / 10 : 0,
    commentRate: totalAudience > 0 ? Math.round(commentCount / totalAudience * 1000) / 10 : 0,
  };

  // ── Chapter Pacing Analysis ──
  const chapterWords = mergedChapters.map(c => c.wordCount);
  const wordAvg = chapterWords.length > 0 ? Math.round(chapterWords.reduce((a, b) => a + b, 0) / chapterWords.length) : 0;
  const wordStd = chapterWords.length > 1
    ? Math.round(Math.sqrt(chapterWords.reduce((a, b) => a + (b - wordAvg) ** 2, 0) / chapterWords.length))
    : 0;
  const wordOutliers = [];
  if (wordStd > 0) {
    for (const ch of mergedChapters) {
      if (Math.abs(ch.wordCount - wordAvg) > 2 * wordStd) {
        wordOutliers.push({ chapter: ch.chapter, words: ch.wordCount, deviation: Math.round((ch.wordCount - wordAvg) / wordStd * 10) / 10 });
      }
    }
  }
  // Correlation between word count and completion rate
  let wordCompCorr = null;
  const mergedRates = mergedChapters.map(c => c.completionRate).filter(r => r > 0);
  const mergedWords = mergedChapters.map(c => c.wordCount);
  if (mergedWords.length > 5 && mergedRates.length === mergedWords.length) {
    const wMean = mergedWords.reduce((a, b) => a + b, 0) / mergedWords.length;
    const cMean = mergedRates.reduce((a, b) => a + b, 0) / mergedRates.length;
    let num = 0, wDen = 0, cDen = 0;
    for (let i = 0; i < mergedWords.length; i++) {
      const wDiff = mergedWords[i] - wMean;
      const cDiff = mergedRates[i] - cMean;
      num += wDiff * cDiff;
      wDen += wDiff ** 2;
      cDen += cDiff ** 2;
    }
    wordCompCorr = (wDen > 0 && cDen > 0) ? Math.round(num / Math.sqrt(wDen * cDen) * 100) / 100 : null;
  }
  const pacing = {
    chapterWordAvg: wordAvg,
    wordStdDev: wordStd,
    consistency: wordAvg > 0 ? Math.max(0, Math.round((1 - wordStd / wordAvg) * 100)) : 0,
    outliers: wordOutliers.slice(0, 5),
    wordCompletionCorrelation: wordCompCorr,
  };

  // ── Platform Benchmarks ──
  // ── Platform Benchmarks (基于番茄实际标准，偏向严格) ──
  // 番茄验证期逻辑：读完率是最重要的信号，低于25%基本不会过验证
  // 签约后追读率是关键——直接影响推荐位质量
  const benchmarkSets = {
    unsigned:    { completion: 20, follow: 25, searchRatioMax: 85, bookmarkRate: 5 },
    verification:{ completion: 30, follow: 35, searchRatioMax: 55, bookmarkRate: 8 },
    signed:      { completion: 35, follow: 40, searchRatioMax: 30, bookmarkRate: 10 },
    ongoing:     { completion: 25, follow: 30, searchRatioMax: 25, bookmarkRate: 8 },
    finished:    { completion: 15, follow: 20, searchRatioMax: 50, bookmarkRate: 5 },
  };
  const bm = benchmarkSets[stage] || benchmarkSets.ongoing;
  const benchmarks = {
    completionRate: { current: avgCompletion, target: bm.completion, met: avgCompletion >= bm.completion },
    followRate: { current: avgFollow, target: bm.follow, met: avgFollow >= bm.follow },
    searchRatio: { current: Math.round(searchRatio * 100), target: bm.searchRatioMax, met: searchRatio * 100 <= bm.searchRatioMax },
    bookmarkRate: { current: funnel.bookmarkRate, target: bm.bookmarkRate, met: funnel.bookmarkRate >= bm.bookmarkRate },
  };

  // ── Suggestions (Stage-Aware, 基于番茄平台规则) ──
  // 番茄平台的底层逻辑：
  //   验证期 = 平台用小流量测试你的书 → 如果核心指标达标 → 开放推荐/书城/分类
  //   → 搜索占比会自然下降。反之，搜索占比高 = 平台没给你推流 = 核心指标不达标。
  //   算法权重推测：读完率 > 追读率 > 加书架率 > 催更 > 评论
  //   断更2天以上降权，单章3000-5000字为甜区
  const suggestions = [];

  // ═══ 未签约 ═══
  if (stage === "unsigned") {
    const wordCountHint = latestWords < 20000
      ? `当前仅 ${latestWords.toLocaleString()} 字，距番茄触发验证的最低门槛（通常2-3万字）还有距离。`
      : `已累积 ${latestWords.toLocaleString()} 字（超过2万字），如果尚未进入验证期，可能原因：①更新频率不稳定（断更>2天会重置进度）②书名/简介/内容涉及敏感题材被系统暂缓③平台当前审核队列较长。`;
    suggestions.push({
      priority: "info",
      category: "platform",
      title: "尚未签约 — 番茄平台阶段说明",
      detail: `你的书当前处于「未签约」状态。番茄对新书的流程是：稳定更新→达到字数门槛（约2-3万字）→触发验证期（平台小范围推流测试7-10天）→核心指标达标→签约。${wordCountHint}未签约阶段数据量少是非常正常的，无需焦虑——现在最重要的不是数据，而是稳定日更。`,
    });

    if (latestWords >= 20000 && daysSinceFirstPublish > 14) {
      suggestions.push({
        priority: "medium",
        category: "platform",
        title: "字数达标但未进入验证期 — 自查清单",
        detail: "已满足2万字门槛但超过14天未触发验证，建议检查：①最近7天是否每天都有更新？（断更2天会降低优先级）②书名和简介是否踩了敏感词？（含「系统」「金手指」「穿越」等是正常的，但要避免涉政涉黄）③如果都没有问题，可以给编辑投稿自荐，主动申请验证。④考虑调整书名/简介：在番茄，书名的「卖点清晰度」比「文艺感」重要得多——读者3秒扫过书名，必须一眼知道「这本书讲什么」。",
      });
    }

    if (updateScore < 60 && latestWords > 5000) {
      suggestions.push({
        priority: "medium",
        category: "update",
        title: `更新不稳定（${updateScore}/100）— 可能是迟迟不触发验证的原因`,
        detail: "番茄对更新频率非常敏感。建议保持每天固定时间更新1-2章，连续7天以上不中断，系统才会认为你是「稳定创作」的作者。断更超过2天可能会重置或延长平台观察期。",
      });
    }

    // Don't flag low traffic or zero interaction for unsigned books — it's completely normal
    if (latestWords > 30000 && explicitVerification === false && isSigned === false && daysSinceFirstPublish > 30) {
      suggestions.push({
        priority: "medium",
        category: "platform",
        title: "长时间未签约（>30天）— 考虑复盘或换方向",
        detail: "已超过30天且字数达标但仍未签约，建议认真复盘：①对比同题材Top100作品的前20章，对比节奏、冲突密度、开篇钩子②你的书名和简介是否能吸引目标读者点击？③是否考虑开新书？番茄平台上，有时候换一本新书重新出发比坚持一本「起不来」的老书更明智。",
      });
    }

  // ═══ 验证期 ═══
  } else if (stage === "verification") {
    // ── 平台阶段说明 ──
    const daysLeft = Math.max(0, 10 - daysSinceFirstPublish);
    suggestions.push({
      priority: "info",
      category: "platform",
      title: "当前处于验证期",
      detail: `验证期是番茄对新书的评估阶段（通常7-10天）。平台用小流量测试你的书能否留住读者——如果核心指标达标，会逐步开放推荐位、书城、分类等渠道。你已发布 ${daysSinceFirstPublish} 天，预估还剩 ${daysLeft} 天。`,
    });

    // ── 搜索占比：验证期的核心警报 ──
    if (searchRatio > 0.6) {
      const searchPct = Math.round(searchRatio * 100);
      if (searchRatio > 0.75) {
        suggestions.push({
          priority: "high",
          category: "traffic",
          title: `搜索占比 ${searchPct}% — 平台几乎未给推荐流量`,
          detail: `验证期搜索占比超过75%是非常危险的信号。番茄的流量分配逻辑是：平台先用搜索+小范围测试→如果读完率/追读率达标→逐步开放推荐、书城、分类。搜索占比越高，说明平台越不敢给你推流。根本原因通常是：①读完率太低（平台不敢推）②追读/互动数据弱（算法判断读者不感兴趣）③内容质量问题触发了平台的"观望"策略。`,
        });
      } else {
        suggestions.push({
          priority: "high",
          category: "traffic",
          title: `搜索占比 ${searchPct}% — 推荐流量不足`,
          detail: "验证期搜索占比偏高，平台尚未大量开放推荐渠道。需要尽快提升核心指标（读完率、追读率）以触发平台的流量倾斜。",
        });
      }
    }

    // ── 读完率崩溃：验证期的致命伤 ──
    if (avgCompletion > 0 && earlyRate > 0) {
      const decay = Math.round((earlyRate - (lateRate || earlyRate)) / earlyRate * 100);
      if (decay > 50) {
        suggestions.push({
          priority: "high",
          category: "retention",
          title: `读完率暴跌 ${decay}%（${earlyRate}% → ${lateRate}%）`,
          detail: `前1/3平均读完率 ${earlyRate}%，后1/3暴跌至 ${lateRate}%。在验证期，读完率是番茄算法最重要的信号——读完率持续走低意味着"平台推了人也留不住"，算法会降低推荐优先级。建议：①检查前3-5章是否有"劝退"情节（节奏过慢、信息量过大、主角行为不合理）②每章结尾设置悬念钩子③单章控制在3000-5000字（低于2000字会被认为"水文"，高于8000字读者容易放弃）。`,
        });
      } else if (decay > 30) {
        suggestions.push({
          priority: "medium",
          category: "retention",
          title: `读完率下滑 ${decay}%，需关注`,
          detail: `读完率从 ${earlyRate}% 降至 ${lateRate}%，呈下降趋势。验证期读完率应该保持稳定甚至上升。建议检查中期章节是否出现"节奏疲劳"——连续多章无高潮、无新冲突，读者会自然流失。`,
        });
      }
    }

    // ── 零互动：验证期的另一个危险信号 ──
    if (!hasInteraction) {
      suggestions.push({
        priority: "high",
        category: "engagement",
        title: "零互动 — 读者完全沉默",
        detail: "加书架0、评论0、催更0——这说明读者连「收藏一下以后看」的意愿都没有。在验证期，互动数据（尤其加书架率）是平台判断「这本书有没有潜力」的关键信号。建议：①在前3章结尾明确引导读者加书架（如作者的话）②设置一个让读者忍不住评论的剧情钩子（悬念/争议/共鸣）③检查书名和简介是否准确传达了题材和卖点，避免读者「点进来发现不是想看的」。",
      });
    } else if (bookmarkCount < 3 && totalTraffic > 20) {
      suggestions.push({
        priority: "medium",
        category: "engagement",
        title: `加书架率仅 ${Math.round(bookmarkCount / totalTraffic * 100)}%，互动偏弱`,
        detail: `${totalTraffic} 个读者中只有 ${bookmarkCount} 人加书架。加书架=读者还想回来看，是验证期第二重要的指标（仅次于读完率）。建议在更新章节的"作者的话"中主动引导读者收藏。`,
      });
    }

    // ── 更新节奏分析 ──
    if (avgDailyWords > 10000) {
      suggestions.push({
        priority: "medium",
        category: "update",
        title: `日更 ${Math.round(avgDailyWords / 1000)}k 字（中位数），节奏可能偏快`,
        detail: "验证期的高频更新是一把双刃剑：好处是快速积累字数冲节点，风险是质量可能稀释——而验证期质量>数量。番茄算法会检测「内容堆砌」行为（大量低质量更新），反而可能降权。建议控制到6000-8000字/天，把精力放在提升每章质量上。",
      });
    } else if (avgDailyWords < 3000) {
      suggestions.push({
        priority: "medium",
        category: "update",
        title: `日更仅 ${avgDailyWords} 字，更新量不足`,
        detail: "验证期建议保持4000-6000字/天的稳定输出。更新太少会让平台难以评估「持续创作能力」，可能延长验证期。",
      });
    }

    if (updateScore < 70) {
      suggestions.push({
        priority: "medium",
        category: "update",
        title: `更新稳定性得分 ${updateScore}/100`,
        detail: "番茄算法对有断更记录的作品会降低推荐优先级，断更2天以上影响明显。验证期建议每天固定时间更新，建立读者预期。",
      });
    }

    // ── 正向反馈：追读率不错 ──
    if (avgFollow > 60 && !hasInteraction) {
      suggestions.push({
        priority: "info",
        category: "engagement",
        title: `追读率 ${avgFollow}% 表现不错`,
        detail: "虽然互动数据为零，但在追的读者黏性较好（追读率说明读者愿意跟着更新走）。这是一个积极信号——说明内容本身有吸引力，问题可能在于缺乏引导读者互动的「钩子」。",
      });
    }

  // ═══ 签约期 ═══
  } else if (stage === "signed") {
    suggestions.push({
      priority: "info",
      category: "platform",
      title: "已签约 — 进入流量爬坡期",
      detail: "签约后平台会逐步开放推荐位和流量倾斜。这个阶段的核心是保持更新节奏 + 提升追读率和互动率——这两个数据直接影响推荐位的质量和频次。",
    });
    if (searchRatio > 0.6) {
      suggestions.push({
        priority: "high",
        category: "traffic",
        title: `搜索占比 ${Math.round(searchRatio * 100)}%，推荐流量未起量`,
        detail: "签约后搜索占比仍高说明平台的推荐流量还没起来。可能原因：①签约时间短，推荐位排期中②追读率不足触发更多推荐③分类/标签设置不准确导致推荐匹配差。",
      });
    }
    if (totalRevenue < 10) {
      suggestions.push({
        priority: "medium",
        category: "monetization",
        title: "收益偏低，关注付费转化",
        detail: `累计收益 ¥${totalRevenue}，签约后应关注广告分成和付费章节转化。检查是否存在「读完率高但收益低」的矛盾——意味着读者留存好但没付费意愿，可能需要调整付费点设置。`,
      });
    }

  // ═══ 连载中（过验证期但未签约/已签约老书）═══
  } else if (stage === "ongoing") {
    if (searchRatio > 0.7) {
      suggestions.push({
        priority: "high",
        category: "traffic",
        title: `搜索占比 ${Math.round(searchRatio * 100)}% — 推荐流量严重不足`,
        detail: "成熟期作品搜索占比不应超过50%。高搜索占比说明平台的推荐、分类、书城渠道几乎没有给你量。可能原因：①追读率/读完率长期低迷②曾断更导致权重下降③分类标签不匹配。建议：重新检查分类和标签设置，参与平台活动争取推荐位曝光。",
      });
    }
    if (milestone100k && milestone100k.completionRate && milestone100k.completionRate < 5) {
      suggestions.push({
        priority: "high",
        category: "retention",
        title: `10万字读完率仅 ${milestone100k.completionRate}% — 长篇留存堪忧`,
        detail: "10万字是番茄评估长篇作品的关键节点。低于5%的读完率说明绝大部分读者在前期就流失了。建议回头检查前20章——节奏过慢、信息量过大、主角行为不合理是最常见的「劝退」原因。",
      });
    }
    if (updateScore < 60) {
      suggestions.push({
        priority: "medium",
        category: "update",
        title: `更新不稳定（${updateScore}/100），影响推荐权重`,
        detail: "长期稳定更新是番茄推荐算法的基础条件。断更2天以上会触发降权，恢复需要持续更新7天以上。",
      });
    }

  // ═══ 已完结 ═══
  } else if (stage === "finished") {
    suggestions.push({
      priority: "info",
      category: "platform",
      title: "已完结 — 关注长尾收入",
      detail: "完本后平台会给予「完本推荐」流量窗口（通常1-2周）。建议确保全本无屏蔽章节、标签分类准确——这两个因素直接影响完本推荐的覆盖范围。完本后收益主要来自新读者的全本阅读广告分成，属于被动收入。",
    });
    if (searchRatio > 0.8) {
      suggestions.push({
        priority: "medium",
        category: "traffic",
        title: "完本后搜索占比仍高，长尾推荐不足",
        detail: "完本推荐期已过后，搜索成为主要流量来源属于正常。但如果希望继续获得推荐，可以考虑开新书并在老书末尾引导读者。",
      });
    }
  }

  // ═══ 全阶段通用建议 ═══
  // ── Chapter-Specific: pinpoint exact problem chapters ──
  if (biggestDrop && biggestDrop.drop > 5) {
    const fromCh = biggestDrop.from;
    const toCh = biggestDrop.to;
    const wordNote = toCh.wordCount > pacing.chapterWordAvg * 1.3
      ? `第${toCh.chapter}章字数 ${toCh.wordCount}，超过均值 ${Math.round(toCh.wordCount / pacing.chapterWordAvg * 100) - 100}%。`
      : "";
    suggestions.push({
      priority: "high",
      category: "chapter_specific",
      title: `最大流失点：第${fromCh.chapter}章→第${toCh.chapter}章，读完率暴跌 ${biggestDrop.drop}%`,
      detail: `读者在第${fromCh.chapter}章（读完率 ${fromCh.completionRate}%）到第${toCh.chapter}章（读完率 ${toCh.completionRate}%）之间大量流失。${wordNote}建议重点检查第${toCh.chapter}章的内容：①是否出现长时间无冲突/无推进的平淡段落 ②是否存在大段背景设定或信息倾泻 ③剧情逻辑是否出现跳跃。这很可能是整本书读者流失的"断崖点"。`,
    });
  }
  // Specific anomaly suggestions
  const severeAnomalies = anomalies.filter(a => a.severity === "high");
  for (const an of severeAnomalies.slice(0, 2)) {
    const merged = mergedChapters.find(c => c.chapter === an.chapter);
    const wordInfo = merged && merged.wordCount > 0 ? `该章 ${merged.wordCount} 字` : "";
    const wordWarn = merged && pacing.chapterWordAvg > 0 && merged.wordCount > pacing.chapterWordAvg * 1.3
      ? `（超出均值 ${Math.round(merged.wordCount / pacing.chapterWordAvg * 100) - 100}%，字数偏长可能是读完率低的原因之一）` : "";
    suggestions.push({
      priority: "high",
      category: "chapter_specific",
      title: `第${an.chapter}章「${an.title || ''}」${an.type === "completion_drop" ? "读完率" : "跟读率"}异常（z-score: ${an.zScore}）`,
      detail: `第${an.chapter}章${an.type === "completion_drop" ? "读完率" : "跟读率"}仅 ${an.value}%，远低于全书均值 ${an.avg}%（偏离 ${Math.abs(an.zScore)} 个标准差）。${wordInfo}${wordWarn} 建议将此章作为优先修改目标：拆分过长段落、检查剧情节奏、确保章末有悬念钩子。`,
    });
  }

  // ── Pacing (章节节奏) ──
  if (pacing.consistency < 50 && wordAvg > 0) {
    suggestions.push({
      priority: "medium",
      category: "pacing",
      title: `章节字数波动大（一致性 ${pacing.consistency}%）`,
      detail: `平均单章 ${wordAvg} 字，标准差 ${wordStd} 字，说明章节长短不一。读者对章节长度有心理预期，忽长忽短会打乱阅读节奏——短章让人感觉"水"，长章增加阅读负担。建议将单章控制在 3000-5000 字范围内。`,
    });
  }
  if (pacing.wordCompletionCorrelation !== null && pacing.wordCompletionCorrelation < -0.3) {
    suggestions.push({
      priority: "medium",
      category: "pacing",
      title: "字数越多读完率越低 — 单章可能过长",
      detail: `字数和读完率的相关系数为 ${pacing.wordCompletionCorrelation}（负相关），说明字数多的章节读完率明显更低。建议检查字数最多的几章，考虑拆分或精简。番茄甜区：单章 3000-5000 字。`,
    });
  }
  if (wordOutliers.length > 3) {
    const outlierChs = wordOutliers.slice(0, 3).map(o => `第${o.chapter}章`).join("、");
    suggestions.push({
      priority: "info",
      category: "pacing",
      title: `${wordOutliers.length} 个章节字数异常`,
      detail: `${outlierChs} 等章节的字数明显偏离均值。建议检查这些章节是否存在内容冗余或节奏问题。`,
    });
  }

  // ── Funnel (转化漏斗) ──
  if (totalAudience > 20 && funnel.followRate < 3) {
    suggestions.push({
      priority: "high",
      category: "funnel",
      title: `追更转化率仅 ${funnel.followRate}% — 读者来了但留不住`,
      detail: `${totalAudience} 个读者中只有 ${followCount} 人在追更。追更是读者"愿意持续看"的信号，追更率低说明开头没有建立足够的期待。建议：①前3章结尾设置明确悬念②主角目标要在第一章就讲清楚③避免大段设定/背景介绍。`,
    });
  }
  if (totalAudience > 10 && funnel.bookmarkRate < 2 && stage !== "verification") {
    suggestions.push({
      priority: "medium",
      category: "funnel",
      title: `加书架率仅 ${funnel.bookmarkRate}%，读者不愿收藏`,
      detail: "加书架=读者还想回来看。加书架率低通常意味着书名/简介和正文内容的期待不一致，或者开篇没有让读者产生「追下去」的动力。",
    });
  }

  // ── Positive Trends (正向反馈) ──
  if (trends.completion === "rising" && avgCompletion < 20) {
    suggestions.push({
      priority: "info",
      category: "positive",
      title: "读完率正在上升，趋势向好",
      detail: `虽然当前读完率 ${avgCompletion}% 还未达标，但趋势是上升的——说明近期的内容改动或更新策略在起效。保持当前的写作方向和更新节奏，继续观察。`,
    });
  }
  if (trends.revenue === "rising" && totalRevenue > 0) {
    suggestions.push({
      priority: "info",
      category: "positive",
      title: "收益趋势上升，增长态势良好",
      detail: "近期日收益呈现上升趋势，说明之前的优化策略开始见效。维持稳定更新节奏，收益大概率会继续增长。",
    });
  }
  if (trends.follow === "rising") {
    suggestions.push({
      priority: "info",
      category: "positive",
      title: "跟读率持续提升，读者黏性增强",
      detail: "跟读率上升意味着读者愿意跟着更新走——这是番茄算法最重要的正向信号之一。好的跟读率会带来更多推荐流量。",
    });
  }

  // ── 收益分析（签约后或有一定数据时） ──
  if (totalRevenue > 0 && latestWords > 0) {
    const revPerK = Math.round(totalRevenue / (latestWords / 1000) * 1000) / 1000;
    if (revPerK > 1) {
      suggestions.push({
        priority: "info",
        category: "monetization",
        title: `千字收益 ¥${revPerK}，表现良好`,
        detail: "当前千字收益处于番茄中上水平。维持现有策略，关注追读率变化即可。",
      });
    } else if (stage !== "verification") {
      // 非验证期才提示低收益（验证期低收益是正常的）
      suggestions.push({
        priority: "medium",
        category: "monetization",
        title: `千字收益 ¥${revPerK}，变现效率偏低`,
        detail: "番茄的收益=广告分成+付费分成。提升方法：①提高读完率→更多广告曝光②设置付费章节→增加付费分成③提升追更率→提高推荐权重→更多流量→更多收益。",
      });
    }
  }

  // ── Genre Detection & Platform Fit ──
  const genrePatterns = [
    { genre: "玄幻/奇幻", channel: "男频", keywords: ["修炼", "穿越", "系统", "异能", "武道", "修仙", "仙侠", "神", "魔", "妖", "魂", "灵", "斗罗", "斗破", "气", "丹", "阵", "剑", "龙", "太古", "万古", "洪荒"] },
    { genre: "都市", channel: "男频", keywords: ["都市", "重生", "都市重生", "校花", "兵王", "神医", "保镖"] },
    { genre: "言情/甜宠", channel: "女频", keywords: ["甜宠", "虐恋", "追妻", "腹黑", "王爷", "总裁夫人", "替嫁", "闪婚", "萌宝", "团宠", "甜妻", "王妃", "总裁", "豪门", "职场", "校园"] },
    { genre: "悬疑/惊悚", channel: "男频", keywords: ["悬疑", "惊悚", "推理", "侦探", "凶案", "诡", "恐怖", "灵异", "鬼", "阴", "墓", "棺材"] },
    { genre: "历史/权谋", channel: "男频", keywords: ["历史", "权谋", "流民", "江山", "帝王", "皇", "妃", "宫", "朝", "将军", "种田", "天下", "乱世"] },
    { genre: "科幻/末世", channel: "男频", keywords: ["科幻", "末世", "末日", "丧尸", "星际", "宇宙", "外星", "机甲", "虫族", "文明"] },
    { genre: "游戏/电竞", channel: "男频", keywords: ["游戏", "电竞", "网游", "副本", "公会", "装备", "BOSS", "刷怪", "打金"] },
  ];
  let detectedGenre = null;
  let detectedChannel = null;
  const bookText = (bookName + " " + (status || "")).toLowerCase();
  // 显式频道关键词优先
  if (bookText.includes("女频")) {
    detectedChannel = "女频";
  } else if (bookText.includes("男频")) {
    detectedChannel = "男频";
  }
  for (const p of genrePatterns) {
    if (p.keywords.some(kw => bookText.includes(kw.toLowerCase()))) {
      detectedGenre = p.genre;
      if (!detectedChannel) detectedChannel = p.channel;
      break;
    }
  }

  // 频道适配分析
  if (detectedChannel) {
    const channelTips = {
      "男频": "男频是番茄的基本盘，占平台流量约65%+，读者基数大但头部效应极强。男频读者核心诉求：① 前3章必须有明确「爽点」（金手指/打脸/逆袭），铺垫型开头基本被弃；② 更新速度直接影响推荐权重，建议日更4000+字维持算法偏好；③ 书名要突出「题材+卖点标签」（如「重生都市之XX」），别用文艺写法。男频的竞争本质是「留存率竞争」——谁的读者中途不跳章，谁就能吃到更多推荐。",
      "女频": "女频在番茄增长迅猛，付费意愿显著高于男频（ARPU约为男频1.5-2倍）。女频读者核心诉求：① CP感是第一位——前几章必须让读者「磕到」，人设要立得快且鲜明；② 书名和封面决定点击率，女频读者对标题敏感度远高于男频，建议用「身份+关系+冲突」公式命名；③ 番茄女频推荐算法更重视书架收藏率和互动数据，鼓励读者加书架比求追读更有效。女频的竞争本质是「情感共鸣竞争」——谁能快速建立读者与角色的情感连接，谁就赢了。",
    };
    const channelTip = channelTips[detectedChannel];
    if (channelTip) {
      suggestions.push({
        priority: "info",
        category: "genre",
        title: `频道定位：${detectedChannel} — 番茄平台策略建议`,
        detail: channelTip,
      });
    }
  }

  if (detectedGenre) {
    const genreTips = {
      "玄幻/奇幻": "玄幻是番茄第一大品类，读者基数最大但竞争也最激烈。番茄的玄幻读者偏好「开局就爽」的快节奏——如果前10章还在铺垫世界观，大概率被弃。建议：前3章建立主角目标和金手指，每章结尾留悬念钩子。同时注意，玄幻读者对「更新量」极其敏感，签约后日更6000+字才能稳住推荐位。",
      "都市": "都市在番茄的表现非常稳定，尤其「重生」「校花」等子类有固定读者群。建议在书名中突出「卖点标签」（如「重生」「系统」「神医」），方便算法匹配目标读者。都市文开篇要快——第一章就要让读者看到「金手指激活」的瞬间。",
      "言情/甜宠": "言情是番茄女频第一品类，付费意愿强。核心是「人设+CP感」——前几章必须让读者磕到CP。番茄女频读者对书名非常敏感，建议直接用「XX总裁的XX小娇妻」之类高识别度命名。甜宠类注意：前三章至少安排一次「亲密互动」（牵手/拥抱/壁咚），这是读者留存的关键节点。",
      "悬疑/惊悚": "悬疑在番茄属于中等偏小品类，读者偏小众但黏性强。番茄的推荐算法对悬疑类前期数据容忍度较高，但读完率是硬指标——悬疑一旦节奏拖沓读者流失很快。建议每章结尾埋一个新疑点，保持追读惯性。悬疑的「第一案」质量决定生死——不要用平淡案件开局。",
      "历史/权谋": "历史权谋在番茄偏小众，但精品容易成为「口碑书」。建议：开篇尽量用强冲突开场（如追杀/叛变/政变），不要从日常细节切入。番茄的历史读者有耐心，但第一印象决定追不追。热门方向：三国、大明、架空权谋。",
      "科幻/末世": "科幻末世在番茄基数不大但增长快。核心是「世界观的奇观感」——第一页就要展示一个让读者惊叹的设定。注意：番茄读者偏年轻，不要堆砌硬科幻术语。末世文前3章建议完成「末日降临→获得能力→第一次危机」的节奏链。",
      "游戏/电竞": "游戏电竞在番茄有稳定的年轻读者群。建议突出「游戏设定」的独特性和「主角逆袭」的爽感。章节末尾的悬念可以参考游戏副本的BOSS战节奏。电竞类注意：游戏机制描写不要超过内容的20%，读者要的是「赢」的爽感，不是攻略说明书。",
    };
    const genreTip = genreTips[detectedGenre] || `${detectedGenre}题材在番茄有一定读者基础，建议研究同题材排行榜前50的书名和简介风格。`;
    const channelLabel = detectedChannel ? ` · ${detectedChannel}` : "";
    suggestions.push({
      priority: "info",
      category: "genre",
      title: `题材识别：${detectedGenre}${channelLabel} — 平台适配建议`,
      detail: genreTip,
    });
  }

  // ── Data Freshness: check if revenue/reading data is stale ──
  const freshness = latest.dataFreshness || {};
  const staleSections = [];
  for (const [section, info] of Object.entries(freshness)) {
    if (info && info.stale) {
      const label = section === "worksData" ? "阅读数据"
        : section === "revenue" ? "收益数据"
        : section === "traffic" ? "流量数据"
        : section === "quality" ? "质量数据" : section;
      staleSections.push({ section, label, updateTime: info.updateTime, message: info.message });
    }
  }
  if (staleSections.length > 0) {
    const staleList = staleSections.map(s => s.message).join("；");
    const now = new Date();
    const hour = now.getHours();
    let timeHint = "";
    if (hour < 13) timeHint = "番茄平台通常在12:00-14:00陆续刷新数据，收益数据往往最晚更新。建议下午2点后重新采集获取完整数据。";
    else if (hour < 15) timeHint = "收益数据可能还在更新中，请稍后再试。";
    else timeHint = "数据延迟超过预期，可能是平台异常或昨日无收益，请核对番茄后台确认。";
    suggestions.unshift({
      priority: "high",
      category: "data_freshness",
      title: `⚠️ 数据未完全更新 — ${staleSections.map(s => s.label).join("、")}`,
      detail: `${staleList}。${timeHint}`,
    });
  }

  // 排序（high → medium → info）
  const priorityOrder = { high: 0, medium: 1, info: 2 };
  suggestions.sort((a, b) => (priorityOrder[a.priority] || 0) - (priorityOrder[b.priority] || 0));

  // 如果所有建议都是info级，且问题确实存在，升级最关键的
  if (suggestions.length > 0 && !suggestions.some(s => s.priority === "high")) {
    if (avgCompletion > 0 && earlyRate > 0) {
      const decay = Math.round((earlyRate - (lateRate || earlyRate)) / earlyRate * 100);
      if (decay > 40) {
        suggestions.unshift({
          priority: "high",
          category: "retention",
          title: `读完率下滑 ${decay}%，不可忽视`,
          detail: `虽然整体数据尚可，但读完率从 ${earlyRate}% 跌至 ${lateRate}%，呈现明显的下降趋势。如果不改善，会逐渐影响推荐权重。`,
        });
      }
    }
  }

  res.json({
    code: 0,
    data: {
      book: bookName,
      status,
      stage,
      stageLabel: {
        unsigned: "未签约",
        verification: "验证期",
        signed: "签约期",
        ongoing: "连载中",
        finished: "已完结",
      }[stage] || "连载中",
      daysSinceFirstPublish,
      totalWords: latestWords,
      analysis: {
        updateScore,
        avgDailyWords,
        dataDays,
        traffic: { totalTraffic, searchRatio: Math.round(searchRatio * 100) / 100 },
        quality: {
          avgCompletionRate: avgCompletion,
          avgFollowRate: avgFollow,
          earlyRetention: earlyRate,
          midRetention: midRate,
          lateRetention: lateRate,
          milestone100k: milestone100k?.completionRate || null,
          milestone50k: milestone50k?.completionRate || null,
        },
        revenue: {
          total: Math.round(totalRevenue * 100) / 100,
          recent7d: Math.round(recent7Revenue * 100) / 100,
          perKWords: latestWords > 0 ? Math.round(totalRevenue / (latestWords / 1000) * 1000) / 1000 : 0,
        },
        anomalies: anomalies.slice(0, 5),
        completionCurve,
        biggestDrop,
        trends,
        funnel,
        pacing,
        benchmarks,
      },
      suggestions,
      dataFreshness: freshness,
    },
  });
});

// ── Helper: Revenue milestone ──
function getMilestone(totalRevenue) {
  const milestones = [
    { label: "月入 ¥100", target: 100, emoji: "🌱" },
    { label: "月入 ¥500", target: 500, emoji: "🌿" },
    { label: "月入 ¥1000", target: 1000, emoji: "🌳" },
    { label: "月入 ¥5000", target: 5000, emoji: "🏆" },
  ];
  if (totalRevenue <= 0) return null;
  const current = milestones.filter(m => totalRevenue >= m.target).pop();
  const next = milestones.find(m => totalRevenue < m.target);
  return {
    current: current ? `${current.emoji} ${current.label}` : "起步",
    next: next ? `${next.emoji} ${next.label}` : "已登顶",
    progress: next ? Math.round((totalRevenue / next.target) * 100) : 100,
  };
}

// ── GET /api/v1/daily — 昨日数据快照 ──
app.get("/api/v1/daily", (req, res) => {
  const tenantId = req.tenant.id;
  const targetBook = req.query.book || "";

  const logData = readDailyLog(tenantId, targetBook);
  if (!logData || logData.length === 0) {
    return res.json({ code: 404, message: "暂无数据，请先采集" });
  }

  // Latest entry
  const latest = logData[logData.length - 1];
  const prev = logData.length > 1 ? logData[logData.length - 2] : null;

  const revenue = latest.revenue?.overview?.yesterdayRevenue || 0;
  const prevRevenue = prev?.revenue?.overview?.yesterdayRevenue || 0;
  const readers = latest.worksData?.stats?.readers || 0;
  const prevReaders = prev?.worksData?.stats?.readers || 0;

  // Changes
  const revChange = prevRevenue > 0 ? Math.round((revenue - prevRevenue) / prevRevenue * 100) : (revenue > 0 ? 100 : 0);
  const readerChange = prevReaders > 0 ? Math.round((readers - prevReaders) / prevReaders * 100) : (readers > 0 ? 100 : 0);

  // Top traffic sources
  const traffic = latest.traffic?.sources || {};
  const topSources = Object.entries(traffic)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k, v]) => ({ name: k, pct: Math.round(v * 100) / 100 }));

  // Completion rate trend
  const completionRates = (latest.quality?.chapters || []).map(c => c.completionRate).filter(Boolean);
  const avgCompletion = completionRates.length > 0
    ? Math.round(completionRates.reduce((a, b) => a + b, 0) / completionRates.length)
    : 0;

  res.json({
    code: 0,
    data: {
      book: latest.book,
      date: latest.date,
      collectedAt: latest.collectedAt,
      status: latest.status || "",
      revenue: { yesterday: revenue, change: revChange, changeLabel: revChange >= 0 ? `↑${revChange}%` : `↓${Math.abs(revChange)}%` },
      readers: { yesterday: readers, change: readerChange, changeLabel: readerChange >= 0 ? `↑${readerChange}%` : `↓${Math.abs(readerChange)}%` },
      topTrafficSources: topSources,
      avgCompletionRate: avgCompletion,
      summary: revenue > 0
        ? `昨日收益 ¥${revenue}（${revChange >= 0 ? "+" : ""}${revChange}%），${readers} 人阅读`
        : `昨日无收益，${readers} 人阅读`,
    },
  });
});

// ── GET /api/v1/weekly — 近七日数据评估 ──
app.get("/api/v1/weekly", (req, res) => {
  const tenantId = req.tenant.id;
  const targetBook = req.query.book || "";

  const logData = readDailyLog(tenantId, targetBook);
  if (!logData || logData.length < 2) {
    return res.json({ code: 404, message: "数据不足，至少需要2天数据" });
  }

  const recent7 = logData.slice(-7);
  const dates = recent7.map(e => e.date);
  const revenues = recent7.map(e => e.revenue?.overview?.yesterdayRevenue || 0);
  const readersList = recent7.map(e => e.worksData?.stats?.readers || 0);
  const completionRates = recent7.map(e => {
    const ch = (e.quality?.chapters || []).map(c => c.completionRate).filter(Boolean);
    return ch.length > 0 ? Math.round(ch.reduce((a, b) => a + b, 0) / ch.length) : 0;
  });

  // Trend detection
  const trend = (arr) => {
    if (arr.length < 2) return "stable";
    const firstHalf = arr.slice(0, Math.floor(arr.length / 2)).reduce((a, b) => a + b, 0) / Math.floor(arr.length / 2);
    const secondHalf = arr.slice(Math.ceil(arr.length / 2)).reduce((a, b) => a + b, 0) / (arr.length - Math.ceil(arr.length / 2));
    if (firstHalf === 0 && secondHalf === 0) return "stable";
    const change = firstHalf > 0 ? (secondHalf - firstHalf) / firstHalf : (secondHalf > 0 ? 1 : 0);
    if (change > 0.1) return "rising";
    if (change < -0.1) return "falling";
    return "stable";
  };

  const revTrend = trend(revenues);
  const readerTrend = trend(readersList);
  const compTrend = trend(completionRates);

  const trendLabel = { rising: "📈 上升", falling: "📉 下降", stable: "➡️ 持平" };

  // Key findings
  const findings = [];
  const totalRev = revenues.reduce((a, b) => a + b, 0);
  const maxRev = Math.max(...revenues, 0);
  const maxRevDay = maxRev > 0 ? dates[revenues.indexOf(maxRev)] : "";

  if (revTrend === "rising") findings.push(`7天收益呈上升趋势，最高日 ¥${maxRev}`);
  else if (revTrend === "falling") findings.push(`7天收益呈下降趋势，需关注`);
  else findings.push(`7天收益基本持平`);

  if (readerTrend === "rising") findings.push("读者数量稳步增长");
  if (compTrend === "falling" && completionRates.filter(Boolean).length > 0) {
    findings.push("读完率呈下降趋势，建议检查近期章节质量");
  }

  res.json({
    code: 0,
    data: {
      book: targetBook,
      dateRange: { start: dates[0], end: dates[dates.length - 1] },
      trends: {
        revenue: { trend: revTrend, label: trendLabel[revTrend], data: dates.map((d, i) => ({ date: d, value: revenues[i] })) },
        readers: { trend: readerTrend, label: trendLabel[readerTrend], data: dates.map((d, i) => ({ date: d, value: readersList[i] })) },
        completion: { trend: compTrend, label: trendLabel[compTrend], data: dates.map((d, i) => ({ date: d, value: completionRates[i] })) },
      },
      totals: { revenue: totalRev, bestDay: maxRevDay, bestRevenue: maxRev },
      findings,
    },
  });
});

// ── Helper: read daily-log.json filtered by book ──
function readDailyLog(tenantId, targetBook) {
  const logPath = path.join(DATA_DIR, tenantId, "daily-log.json");
  if (!fs.existsSync(logPath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(logPath, "utf-8"));
    const entries = Array.isArray(raw) ? raw : (raw.entries || raw.logs || []);
    return targetBook ? entries.filter(e => e.book === targetBook) : entries;
  } catch (e) { return null; }
}

// ── Admin Middleware (checks tenant role) ──────────────────────────
function adminAuth(req, res, next) {
  if (!req.tenant || req.tenant.role !== "admin") {
    return res.status(403).json({ code: 403, message: "需要管理员权限" });
  }
  next();
}

// ── Admin Routes ───────────────────────────────────────────────────

// GET /api/v1/admin/overview — all tenants with plan + usage summary
app.get("/api/v1/admin/overview", adminAuth, (req, res) => {
  const tenants = loadTenants();
  const todayUsage = getAllTenantsUsage();

  const rows = [];
  for (const [id, t] of Object.entries(tenants)) {
    const plan = getPlan(t.plan || "trial");
    const today = todayUsage[id] || { total: 0, endpoints: {} };
    const monthly = getMonthlyUsage(id);
    const limits = getPlanLimits(t.plan || "trial");

    rows.push({
      id,
      name: t.name,
      plan: t.plan || "trial",
      planLabel: plan.name,
      monthlyFee: plan.monthlyFee,
      maxBooks: t.maxBooks || limits.maxBooks,
      limits,
      today: {
        total: today.total,
        collection: today.endpoints["POST /api/v1/collect"] || 0,
        byEndpoint: today.endpoints,
      },
      month: {
        total: monthly.total,
        collection: monthly.endpoints["POST /api/v1/collect"] || 0,
      },
      collectionLimitReached: (today.endpoints["POST /api/v1/collect"] || 0) >= limits.maxCollectionsPerDay,
    });
  }

  res.json({
    code: 0,
    data: {
      tenants: rows,
      totalMonthlyRevenue: rows.reduce((s, r) => s + r.monthlyFee, 0),
      totalTodayCalls: rows.reduce((s, r) => s + r.today.total, 0),
    },
  });
});

// GET /api/v1/admin/usage?tenant=demo&days=7 — detailed usage for a tenant
app.get("/api/v1/admin/usage", adminAuth, (req, res) => {
  const tenantId = req.query.tenant;
  const days = parseInt(req.query.days) || 7;

  if (!tenantId) {
    return res.status(400).json({ code: 400, message: "缺少 tenant 参数" });
  }

  const usageDir = path.join(DATA_DIR, ".usage");
  const dailyBreakdown = [];

  if (fs.existsSync(usageDir)) {
    const files = fs.readdirSync(usageDir)
      .filter(f => f.startsWith("usage-"))
      .sort()
      .reverse()
      .slice(0, days);

    for (const f of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(usageDir, f), "utf-8"));
        const date = f.replace("usage-", "").replace(".json", "");
        const t = data[tenantId];
        dailyBreakdown.push({
          date,
          total: t?.total || 0,
          endpoints: t?.endpoints || {},
        });
      } catch (e) { /* skip */ }
    }
  }

  const tenant = loadTenants()[tenantId];
  const monthly = getMonthlyUsage(tenantId);
  const limits = getPlanLimits(tenant?.plan || "trial");

  res.json({
    code: 0,
    data: {
      tenant: tenantId,
      plan: tenant?.plan || "trial",
      limits,
      monthly,
      quotaUsed: {
        apiCalls: Math.round(monthly.total / limits.maxApiCallsPerDay / 30 * 100) || 0,
        collections: Math.round((monthly.endpoints["POST /api/v1/collect"] || 0) / limits.maxCollectionsPerDay / 30 * 100) || 0,
      },
      dailyBreakdown,
    },
  });
});

// ── 404 handler ──
app.use((req, res) => {
  res.status(404).json({ code: 404, message: "接口不存在" });
});

// ── Prediction helpers (pure math, extracted from fanqie-analytics.js) ──
function linearRegression(points) {
  const n = points.length;
  if (n < 2) return null;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += points[i];
    sumXY += i * points[i];
    sumX2 += i * i;
  }
  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  const intercept = (sumY - slope * sumX) / n;
  const meanY = sumY / n;
  let ssRes = 0, ssTot = 0;
  for (let i = 0; i < n; i++) {
    ssRes += (points[i] - (slope * i + intercept)) ** 2;
    ssTot += (points[i] - meanY) ** 2;
  }
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;
  return { slope, intercept, r2 };
}

function predictFuture(values, days) {
  const reg = linearRegression(values);
  if (!reg) return [];
  const recentAvg = values.slice(-3).reduce((a, b) => a + b, 0) / Math.min(3, values.length);
  const allAvg = values.reduce((a, b) => a + b, 0) / values.length;
  const trendWeight = Math.min(0.7, Math.max(0.3, reg.r2));
  const predictions = [];
  for (let i = 1; i <= days; i++) {
    const trendVal = reg.slope * (values.length + i - 1) + reg.intercept;
    const blended = trendVal * trendWeight + recentAvg * (1 - trendWeight);
    const optimistic = trendVal * (1 + 0.15 * (i / days));
    const conservative = trendVal * 0.8 + recentAvg * 0.2;
    predictions.push({
      day: i,
      conservative: Math.max(0, conservative),
      expected: Math.max(0, blended),
      optimistic: Math.max(0, optimistic),
    });
  }
  return predictions;
}

// ── Start ──
app.listen(PORT, () => {
  console.log(`🚀 番茄数据 API 服务已启动`);
  console.log(`   地址: http://localhost:${PORT}`);
  console.log(`   健康检查: http://localhost:${PORT}/api/v1/health`);
  console.log(`   认证方式: Authorization: Bearer <apiKey>`);

  const tenants = loadTenants();
  const count = Object.keys(tenants).length;
  console.log(`   已加载 ${count} 个客户`);
  for (const [id, t] of Object.entries(tenants)) {
    console.log(`     - ${t.name} (${t.plan}: ${t.maxBooks}本)`);
  }

  // ── Start auto-collection scheduler ──
  // Wraps runCollection for scheduled background execution (no req/res context)
  const scheduledCollect = (tenantId) => {
    const force = true;
    const todayStr = today();
    const todayDir = path.join(DATA_DIR, tenantId, todayStr);
    const progress = {
      phase: "starting",
      message: "定时采集启动…",
      totalBooks: 0,
      currentBook: 0,
      done: false,
      startTime: Date.now(),
      elapsed: 0,
      books: [],
    };
    collectProgress.set(tenantId, progress);
    collecting.add(tenantId);
    return runCollection(tenantId, force, todayStr, todayDir, progress, "", false);
  };
  startScheduler(tenants, scheduledCollect);

  console.log("\n   示例请求:");
  console.log(`   curl -H "Authorization: Bearer fa_sk_demo_001" http://localhost:${PORT}/api/v1/summary`);
});
