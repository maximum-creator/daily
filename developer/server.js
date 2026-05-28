#!/usr/bin/env node
/**
 * 竞品情报 SaaS — 品牌竞品数据采集与AI日报生成
 *
 * 启动: node server.js  |  端口: 默认 3001
 */

const express = require("express");
const fs = require("fs");
const path = require("path");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const { authMiddleware, loadTenants } = require("./lib/auth");
const { chromium, getPage, releasePage, closeTenant, hasProfile, markProfileReady, getPlatformStatus, saveCookies, addToPool, cleanupPages, getBrowserOptions, initScript, injectCookies, PROFILES_DIR } = require("./lib/browser-manager");
const { collectBrandSnapshot, compareSnapshots, saveSnapshot, loadSnapshot, detectPageState, today } = require("./lib/collector-tmall");
const { collectBrandSnapshot: collectJdSnapshot, compareSnapshots: compareJdSnapshots, saveSnapshot: saveJdSnapshot, loadSnapshot: loadJdSnapshot, detectJdPageState } = require("./lib/collector-jd");
const { collectBrandSnapshot: collectPddSnapshot, compareSnapshots: comparePddSnapshots, saveSnapshot: savePddSnapshot, loadSnapshot: loadPddSnapshot, detectPddPageState } = require("./lib/collector-pdd");
const { aggregateAll, analyzeTrend, detectAnomalies, brandHealthScore, generateSuggestions } = require("./lib/signal-aggregator");
const { generateDailyBrief, briefToHtml } = require("./lib/report-generator");
const { usageTracker, getTodayUsage, getMonthlyUsage, getAllTenantsUsage, getTodaySearchCount, flush } = require("./lib/usage-tracker");
const { getPlan, getPlanLimits } = require("./lib/plans");
const scheduler = require("./lib/scheduler");
const mailer = require("./lib/mailer");

const app = express();
const PORT = process.env.PORT || 3001;
const DATA_DIR = path.join(__dirname, "data");

// Login sessions tracker
const loginSessions = new Map();

// ── Global middleware ──────────────────────────────────────────
app.use(express.json({ limit: "1mb" }));
app.use(morgan("dev"));

const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { code: 429, message: "请求过于频繁" },
});
app.use(globalLimiter);

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.use(express.static(path.join(__dirname, "public")));

// ── Health (no auth) ───────────────────────────────────────────
app.get("/api/v1/health", async (req, res) => {
  const tenants = loadTenants();
  const statuses = {};
  for (const [id, t] of Object.entries(tenants)) {
    const platforms = getPlatformStatus(id);
    statuses[id] = {
      name: t.name,
      plan: t.plan,
      planLabel: getPlan(t.plan).name,
      todayApiCalls: getTodayUsage(id).total,
      tmallReady: platforms.tmall,
      jdReady: platforms.jd,
      pddReady: platforms.pdd,
    };
  }
  const smtpStatus = await mailer.verifyConnection();
  const schStatus = scheduler.getStatus();
  res.json({ code: 0, message: "ok", uptime: process.uptime(), tenants: statuses, smtp: smtpStatus, scheduler: schStatus });
});

// ── Auth + Usage tracking ──────────────────────────────────────
app.use("/api/v1", authMiddleware);
app.use("/api/v1", usageTracker);

// ── POST /api/v1/login — 打开可见浏览器登录电商平台 ──────────
app.post("/api/v1/login", async (req, res) => {
  const tenantId = req.tenant.id;
  const platform = req.body?.platform || "tmall"; // "tmall" | "jd" | "pdd" | "both"

  if (platform === "jd" && hasProfile(tenantId, "jd")) {
    return res.json({ code: 0, message: "京东登录态已就绪", profileReady: true, platform: "jd" });
  }
  if (platform === "pdd" && hasProfile(tenantId, "pdd")) {
    return res.json({ code: 0, message: "拼多多登录态已就绪", profileReady: true, platform: "pdd" });
  }
  if (platform === "tmall" && (hasProfile(tenantId, "tmall") || hasProfile(tenantId))) {
    return res.json({ code: 0, message: "天猫登录态已就绪", profileReady: true, platform: "tmall" });
  }

  const sessionKey = `${tenantId}:${platform}`;
  if (loginSessions.has(sessionKey)) {
    const sess = loginSessions.get(sessionKey);
    return res.json({
      code: 0,
      message: sess.ready ? `${platformLabel(platform)}登录已检测到，浏览器即将关闭` : `浏览器已打开，请在浏览器中扫码或验证码登录${platformLabel(platform)}`,
      profileReady: sess.ready,
      platform,
    });
  }

  loginSessions.set(sessionKey, { ready: false });

  (async () => {
    let browser;
    try {
      // Close any existing context using this profile BEFORE opening a new one.
      // Two contexts at the same userDataDir = file-lock conflict = page explosion.
      await closeTenant(tenantId);

      const userDataDir = path.join(PROFILES_DIR, tenantId);
      browser = await chromium.launchPersistentContext(userDataDir, getBrowserOptions(false));
      await initScript(browser);

      // Close all restored tabs from previous sessions — prevents tab accumulation
      await cleanupPages(browser);
      let pages = browser.pages();
      const page = pages.length > 0 ? pages[0] : await browser.newPage();

      const loginUrl = platform === "jd"
        ? "https://passport.jd.com/new/login.aspx"
        : platform === "pdd"
        ? "https://mobile.yangkeduo.com/login"
        : "https://login.taobao.com/member/login.jhtml?style=mini&from=tmall";

      // Use "commit" for faster initial render — login pages are heavy
      await page.goto(loginUrl, {
        waitUntil: "commit", timeout: 60000,
      }).catch(() => {});
      await page.waitForTimeout(3000);

      let done = false;
      const start = Date.now();
      const TIMEOUT_MS = 300000; // 5 minutes — login pages can be slow

      const cookieDomains = platform === "jd"
        ? [".jd.com"]
        : platform === "pdd"
        ? [".yangkeduo.com"]
        : [".taobao.com", ".tmall.com"];

      // Strategy 1: Watch for URL to leave login page
      const urlWatcher = (async () => {
        while (Date.now() - start < TIMEOUT_MS && !done) {
          try {
            const url = page.url();
            if (!url.includes("login") && !url.includes("passport")) {
              const cookies = await browser.cookies().catch(() => []);
              const authCookies = cookies.filter(c =>
                cookieDomains.some(d => c.domain.includes(d))
              );
              if (authCookies.length >= 3) {
                done = true;
                return true;
              }
            }
          } catch (e) {}
          await page.waitForTimeout(3000);
        }
        return false;
      })();

      // Strategy 2: Poll for auth cookies
      const cookieWatcher = (async () => {
        const cookieNames = platform === "jd"
          ? ["pin", "thor", "unick"]
          : platform === "pdd"
          ? ["PDDAccessToken"]
          : ["unb", "_tb_token_", "cookie2"];
        while (Date.now() - start < TIMEOUT_MS && !done) {
          try {
            const cookies = await browser.cookies().catch(() => []);
            const hasAuth = cookies.some(c =>
              cookieDomains.some(d => c.domain.includes(d)) &&
              cookieNames.includes(c.name)
            );
            if (hasAuth) {
              done = true;
              return true;
            }
          } catch (e) {}
          await page.waitForTimeout(5000);
        }
        return false;
      })();

      const success = await Promise.race([urlWatcher, cookieWatcher]);
      const platformId = platform === "jd" ? "jd" : platform === "pdd" ? "pdd" : "tmall";

      if (success || done) {
        const platformId = platform === "jd" ? "jd" : platform === "pdd" ? "pdd" : "tmall";

        if (platform === "jd") {
          // JD login requires extra care: thor is set AFTER successful auth,
          // but it may take a few seconds. Wait and poll for it specifically.
          console.log("[login] JD登录检测成功，等待 thor session token...");
          let thorFound = false;
          for (let attempt = 0; attempt < 10; attempt++) {
            await page.waitForTimeout(3000);
            const cookies = await browser.cookies().catch(() => []);
            const hasThor = cookies.some(c =>
              c.name === "thor" && (c.domain || "").includes("jd.com")
            );
            if (hasThor) {
              thorFound = true;
              console.log(`[login] thor token 已获取 (第${attempt + 1}次检查)`);
              break;
            }
            // Navigate to JD homepage to trigger session finalization
            if (attempt === 2 || attempt === 5) {
              try {
                await page.goto("https://www.jd.com/", { waitUntil: "domcontentloaded", timeout: 15000 });
              } catch (e) { /* continue */ }
            }
            console.log(`[login] 等待 thor... (${attempt + 1}/10)`);
          }
          if (!thorFound) {
            console.log("[login] ⚠ 未检测到 thor cookie，保存当前cookies作为备选");
          }
        }

        // Save auth cookies from current page
        let cookies = await browser.cookies().catch(() => []);
        let platformCookies = cookies.filter(c =>
          cookieDomains.some(d => (c.domain || "").includes(d))
        );

        // Navigate to homepage to collect device fingerprint cookies (__jda etc.)
        const homeUrl = platform === "jd" ? "https://www.jd.com/" : platform === "pdd" ? "https://mobile.yangkeduo.com/" : "https://www.tmall.com/";
        try {
          await page.goto(homeUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
          await page.waitForTimeout(3000);
        } catch (e) { /* continue */ }

        // Get all cookies again and merge with original batch
        cookies = await browser.cookies().catch(() => []);
        const allPlatformCookies = cookies.filter(c =>
          cookieDomains.some(d => (c.domain || "").includes(d))
        );
        // Merge: dedup by name+domain, keep all unique cookies from both stages
        const merged = new Map();
        for (const c of [...platformCookies, ...allPlatformCookies]) {
          merged.set(`${c.name}@${c.domain}`, c);
        }
        const finalCookies = [...merged.values()];
        if (finalCookies.length > 0) {
          saveCookies(tenantId, finalCookies, platformId);
        }

        // Verify thor was saved
        if (platform === "jd") {
          const hasThor = finalCookies.some(c => c.name === "thor");
          console.log(`[login] 保存${finalCookies.length}个cookies, thor=${hasThor ? "已保存" : "缺失!"}`);
        }

        markProfileReady(tenantId, platformId);
        // Inject all saved cookies (both platforms) into this context
        await injectCookies(tenantId, browser);
        // Keep headed context alive in pool for anti-bot bypass
        addToPool(tenantId, browser);
        loginSessions.set(sessionKey, { browser, ready: true });
        await page.waitForTimeout(2000);
        loginSessions.delete(sessionKey);
      } else {
        const cookies = await browser.cookies().catch(() => []);
        const authCookies = cookies.filter(c =>
          cookieDomains.some(d => (c.domain || "").includes(d))
        );
        if (authCookies.length >= 3) {
          saveCookies(tenantId, authCookies, platformId);
          markProfileReady(tenantId, platformId);
          addToPool(tenantId, browser);
        }
        loginSessions.set(sessionKey, { browser, ready: authCookies.length >= 3 });
      }
    } catch (e) {
      loginSessions.delete(sessionKey);
    }
  })();

  const label = platformLabel(platform);
  res.json({
    code: 0,
    message: `浏览器已打开，请在浏览器中登录${label}账号（扫码或验证码），登录成功后浏览器将自动关闭`,
    launching: true,
    platform,
  });
});

function platformLabel(p) {
  return { tmall: "淘宝/天猫", jd: "京东", pdd: "拼多多", both: "淘宝+京东" }[p] || p;
}

// ── POST /api/v1/search — 搜索竞品品牌（天猫+京东双源采集） ────
app.post("/api/v1/search", async (req, res) => {
  const tenantId = req.tenant.id;
  const { brand } = req.body || {};
  if (!brand) return res.json({ code: 400, message: "缺少 brand 参数" });

  const platforms = getPlatformStatus(tenantId);
  if (!platforms.tmall && !platforms.jd && !platforms.pdd) {
    return res.json({
      code: 401,
      message: "请先登录至少一个数据源（天猫/京东/拼多多）",
      tmallReady: false,
      jdReady: false,
      pddReady: false,
    });
  }

  const plan = req.tenant.plan || "trial";
  const limits = getPlanLimits(plan);
  const todayCount = getTodaySearchCount(tenantId);
  if (todayCount >= limits.maxSearchesPerDay) {
    return res.status(429).json({
      code: 429,
      message: `今日采集次数已达上限（${limits.maxSearchesPerDay}次/天）`,
      limit: limits.maxSearchesPerDay,
      used: todayCount,
    });
  }

  const todayStr = today();
  const existing = loadSnapshot(DATA_DIR, tenantId, brand, todayStr);
  if (existing && existing.productCount > 0) {
    return res.json({ code: 0, data: existing, cached: true, message: "今日已采集，返回缓存" });
  }

  try {
    const result = await runCollection(tenantId, brand);
    res.json({ code: 0, data: result, tmallReady: platforms.tmall, jdReady: platforms.jd, pddReady: platforms.pdd });
  } catch (e) {
    res.status(500).json({ code: 500, message: `采集异常: ${e.message}` });
  }
});

// ── GET /api/v1/report — 获取最新日报 ─────────────────────────
app.get("/api/v1/report", (req, res) => {
  const tenantId = req.tenant.id;
  const brand = req.query.brand || "";
  const date = req.query.date || today();

  const rp = reportPath(DATA_DIR, tenantId, brand, date);
  if (!fs.existsSync(rp)) {
    return res.json({ code: 404, message: "暂无该日报告，请先调用 POST /api/v1/search 采集数据" });
  }

  const brief = JSON.parse(fs.readFileSync(rp, "utf-8"));
  res.json({ code: 0, data: brief });
});

// ── GET /api/v1/brands — 已监测的品牌列表 ──────────────────────
app.get("/api/v1/brands", (req, res) => {
  const tenantId = req.tenant.id;
  const tenantDir = path.join(DATA_DIR, tenantId);
  if (!fs.existsSync(tenantDir)) return res.json({ code: 0, data: [] });

  const brands = fs.readdirSync(tenantDir)
    .filter(f => fs.statSync(path.join(tenantDir, f)).isDirectory())
    .filter(f => !f.startsWith(".") && !f.startsWith("_"))
    .map(name => {
      const latest = findLatestReport(DATA_DIR, tenantId, name);
      return {
        name,
        lastReportDate: latest?.date || "",
        lastSignalCount: latest?.signalCount || 0,
        lastHighCount: latest?.highCount || 0,
      };
    });

  res.json({ code: 0, data: brands });
});

// ── Admin routes ───────────────────────────────────────────────
function adminAuth(req, res, next) {
  if (!req.tenant || req.tenant.role !== "admin") {
    return res.status(403).json({ code: 403, message: "需要管理员权限" });
  }
  next();
}

app.get("/api/v1/admin/overview", adminAuth, (req, res) => {
  const tenants = loadTenants();
  const rows = [];
  for (const [id, t] of Object.entries(tenants)) {
    const plan = getPlan(t.plan || "trial");
    const platforms = getPlatformStatus(id);
    rows.push({
      id, name: t.name, plan: t.plan, planLabel: plan.name,
      monthlyFee: plan.monthlyFee, tmallReady: platforms.tmall, jdReady: platforms.jd, pddReady: platforms.pdd,
    });
  }
  res.json({ code: 0, data: { tenants: rows } });
});

// ── GET /api/v1/scheduler/status ──────────────────────────────
app.get("/api/v1/scheduler/status", (req, res) => {
  res.json({ code: 0, data: scheduler.getStatus() });
});

// ── GET /api/v1/export — CSV 导出产品数据 ──────────────────────
app.get("/api/v1/export", (req, res) => {
  const tenantId = req.tenant.id;
  const brand = req.query.brand || "";
  const date = req.query.date || today();

  const rows = [["数据源", "商品名称", "价格", "销量/评价", "店铺", "自营"]];

  const tmSnap = loadSnapshot(DATA_DIR, tenantId, brand, date);
  if (tmSnap && tmSnap.products) {
    for (const p of tmSnap.products) {
      rows.push(["天猫", p.name, String(p.price || ""), String(p.salesDisplay || ""), String(p.shop || ""), "N/A"]);
    }
  }

  const jdSnap = loadJdSnapshot(DATA_DIR, tenantId, brand, date);
  if (jdSnap && jdSnap.products) {
    for (const p of jdSnap.products) {
      rows.push(["京东", p.name, String(p.price || ""), String(p.reviewsDisplay || ""), String(p.shop || ""), p.isSelfOperated ? "是" : "否"]);
    }
  }

  const pddSnap = loadPddSnapshot(DATA_DIR, tenantId, brand, date);
  if (pddSnap && pddSnap.products) {
    for (const p of pddSnap.products) {
      rows.push(["拼多多", p.name, String(p.price || ""), String(p.salesDisplay || ""), String(p.shop || ""), "N/A"]);
    }
  }

  const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(brand)}-${date}.csv"`);
  res.send("﻿" + csv);
});

// ── GET /api/v1/compare — 品牌横向对比 ─────────────────────────
app.get("/api/v1/compare", (req, res) => {
  const tenantId = req.tenant.id;
  const brands = (req.query.brands || "").split(",").map(s => s.trim()).filter(Boolean);
  if (brands.length < 2) return res.json({ code: 400, message: "至少需要2个品牌，用逗号分隔" });

  const results = brands.map(name => {
    const report = findLatestReport(DATA_DIR, tenantId, name);
    const snap = loadSnapshot(DATA_DIR, tenantId, name, today()) ||
                 loadSnapshot(DATA_DIR, tenantId, name, yesterdayStr());
    if (!report && !snap) return { name, error: "暂无数据" };

    return {
      name,
      date: report?.date || snap?.collectedAt?.slice(0, 10) || "",
      productCount: snap?.productCount || 0,
      signalCount: report?.signalCount || 0,
      highCount: report?.highCount || 0,
      healthScore: report?.healthScore || 0,
      sources: report?.sources || [],
      priceRange: snap?.priceRange || null,
    };
  });

  res.json({ code: 0, data: results });
});

// ── POST /api/v1/brands/remove — 删除已监测品牌 ────────────────
app.post("/api/v1/brands/remove", (req, res) => {
  const tenantId = req.tenant.id;
  const { brand } = req.body || {};
  if (!brand) return res.json({ code: 400, message: "缺少 brand 参数" });

  const brandDir = path.join(DATA_DIR, tenantId, sanitize(brand));
  if (!fs.existsSync(brandDir)) {
    return res.json({ code: 404, message: "品牌不存在" });
  }

  try {
    fs.rmSync(brandDir, { recursive: true, force: true });
    res.json({ code: 0, message: `已删除 ${brand} 的所有数据` });
  } catch (e) {
    res.status(500).json({ code: 500, message: `删除失败: ${e.message}` });
  }
});

// ── GET /api/v1/debug — 诊断采集状态（开发调试用） ────────────
app.get("/api/v1/debug", async (req, res) => {
  const tenantId = req.tenant.id;
  const brand = req.query.brand || "测试";
  const platform = req.query.platform || "tmall";

  const result = {
    tenantId,
    platform,
    hasProfile: getPlatformStatus(tenantId),
    cookies: {},
    pool: { exists: false, pages: 0 },
    pageState: null,
    productsFound: 0,
    errors: [],
  };

  // Check cookie files
  for (const p of ["tmall", "jd", "pdd"]) {
    const fp = path.join(PROFILES_DIR, tenantId, `cookies-${p}.json`);
    if (fs.existsSync(fp)) {
      try {
        const data = JSON.parse(fs.readFileSync(fp, "utf-8"));
        result.cookies[p] = { count: data.length, file: fp };
      } catch (e) {
        result.cookies[p] = { error: e.message };
      }
    } else {
      result.cookies[p] = { count: 0 };
    }
  }

  // Check pool
  const { getPage, releasePage } = require("./lib/browser-manager");
  let page;
  try {
    page = await getPage(tenantId);
    result.pool.exists = true;

    const searchUrl = platform === "jd"
      ? `https://search.jd.com/Search?keyword=${encodeURIComponent(brand)}&enc=utf-8`
      : platform === "pdd"
      ? `https://mobile.yangkeduo.com/search_result.html?search_key=${encodeURIComponent(brand)}`
      : `https://s.taobao.com/search?q=${encodeURIComponent(brand)}&tab=mall`;

    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(e => {
      result.errors.push(`导航失败: ${e.message}`);
    });
    await page.waitForTimeout(3000);

    result.pageUrl = page.url();
    result.pageTitle = await page.title().catch(() => "");

    // Check page state
    const state = platform === "jd"
      ? await detectJdPageState(page).catch(() => ({ blocked: false }))
      : platform === "pdd"
      ? await detectPddPageState(page).catch(() => ({ blocked: false }))
      : await detectPageState(page).catch(() => ({ blocked: false }));
    result.pageState = state;

    // Raw page diagnostics
    result.pageDiag = await page.evaluate(() => {
      const body = document.body?.innerText || "";
      const priceMatches = body.match(/¥\s*\d+\.?\d*/g) || [];
      const linkCounts = {
        taobaoItems: document.querySelectorAll('a[href*="item.taobao.com"]').length,
        tmallItems: document.querySelectorAll('a[href*="detail.tmall.com"]').length,
      };
      const cardStats = {};
      for (const s of ["[class*='Card']","[class*='card']","[class*='item']",".product","[class*='grid']"]) {
        try { cardStats[s] = document.querySelectorAll(s).length; } catch(e) { cardStats[s] = -1; }
      }
      return {
        bodyLen: body.length,
        priceMatches: priceMatches.length,
        priceSample: priceMatches.slice(0, 5),
        linkCounts,
        cardStats,
        bodyPreview: body.slice(0, 1200),
      };
    });

    // DOM structure probe — what do the tmall links actually look like?
    result.domProbe = await page.evaluate(() => {
      const links = document.querySelectorAll("a[href*='detail.tmall.com']");
      if (links.length === 0) return { error: "no tmall links found" };
      const first = links[0];
      return {
        linkCount: links.length,
        firstLink: {
          tagName: first.tagName,
          className: first.className,
          innerHTML: first.innerHTML.slice(0, 500),
          textContent: (first.textContent || "").trim().slice(0, 300),
          textContentLen: (first.textContent || "").trim().length,
          parentTag: first.parentElement?.tagName,
          parentClass: first.parentElement?.className?.slice(0, 100),
        },
      };
    });

    // JD API test — runs independently of browser page state
    if (platform === "jd") {
      try {
        const { searchJdViaApi } = require("./lib/collector-jd");
        const apiProducts = await searchJdViaApi(tenantId, brand);
        result.apiTest = {
          method: "searchJdViaApi",
          productCount: apiProducts.length,
          sample: apiProducts.slice(0, 5).map(p => ({ name: p.name?.slice(0, 60), price: p.price, shop: p.shop?.slice(0, 30) })),
        };
      } catch (e) {
        result.apiTest = { error: e.message };
      }
    }

    // Try extraction — use direct approach first, then fall back to collector
    if (!state.blocked) {

      // Direct extraction inline
      result.directExtract = await page.evaluate(() => {
        const results = [];
        const links = document.querySelectorAll("a[href*='detail.tmall.com']");
        for (const link of links) {
          const text = (link.textContent || "").trim();
          if (text.length > 8) {
            const priceMatch = text.match(/¥\s*([\d.]+)/);
            const name = text.slice(0, text.indexOf("¥")).trim().slice(0, 120);
            const salesMatch = text.match(/([\d.万+]+)\s*[人笔件]付款/);
            results.push({
              name: name || text.slice(0, 60),
              price: priceMatch ? priceMatch[1] : "",
              sales: salesMatch ? salesMatch[1] : "",
            });
            if (results.length >= 5) break;
          }
        }
        return results;
      });

      const collector = platform === "jd"
        ? require("./lib/collector-jd")
        : platform === "pdd"
        ? require("./lib/collector-pdd")
        : require("./lib/collector-tmall");
      const snapshot = await collector.collectBrandSnapshot(page, brand);
      result.productsFound = snapshot.productCount;
      result.sampleProducts = (snapshot.products || []).slice(0, 5).map(p => ({
        name: p.name?.slice(0, 60),
        price: p.priceDisplay,
        shop: p.shop?.slice(0, 30),
      }));
    }

    releasePage(tenantId, page);
  } catch (e) {
    result.errors.push(`页面操作失败: ${e.message}`);
    if (page) releasePage(tenantId, page);
  }

  res.json({ code: 0, data: result });
});

// ── 404 ────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ code: 404, message: "接口不存在" });
});

// ── Core collection pipeline ──────────────────────────────────

async function runCollection(tenantId, brand) {
  const todayStr = today();
  console.log(`[collect] 开始采集: ${tenantId}/${brand}`);

  // Check cache — only use if it has actual data
  const existing = loadSnapshot(DATA_DIR, tenantId, brand, todayStr);
  if (existing && existing.productCount > 0) {
    console.log(`[collect] 缓存命中: ${existing.productCount} 个商品`);
    return existing;
  }

  let page;
  const allSignals = [];
  let tmSnapshot = null;
  let jdSnapshot = null;
  let pddSnapshot = null;
  const errors = [];

  try {
    page = await getPage(tenantId);
    console.log(`[collect] 页面已获取`);

    const yStr = yesterdayStr();
    const platforms = getPlatformStatus(tenantId);
    console.log(`[collect] 平台状态: tmall=${platforms.tmall}, jd=${platforms.jd}, pdd=${platforms.pdd}`);

    // ── Tmall collection ──
    if (platforms.tmall) {
      try {
        console.log(`[collect] 天猫采集开始: ${brand}`);
        tmSnapshot = await collectBrandSnapshot(page, brand);
        console.log(`[collect] 天猫完成: ${tmSnapshot.productCount} 个商品`);

        if (tmSnapshot.productCount > 0) {
          saveSnapshot(DATA_DIR, tenantId, brand, tmSnapshot);
          const prevTm = loadSnapshot(DATA_DIR, tenantId, brand, yStr);
          const tmComp = compareSnapshots(tmSnapshot, prevTm || null);
          allSignals.push(...tmComp.signals.map(s => ({ ...s, source: "tmall" })));
        } else {
          errors.push("天猫: 未采集到商品数据（可能触发反爬或登录过期）");
        }
      } catch (e) {
        errors.push(`天猫采集失败: ${e.message}`);
        console.error(`[tmall] ${brand}: ${e.message}`);
      }
    }

    // ── JD collection ──
    if (platforms.jd) {
      try {
        console.log(`[collect] 京东采集开始: ${brand}`);
        jdSnapshot = await collectJdSnapshot(page, brand, tenantId);
        console.log(`[collect] 京东完成: ${jdSnapshot.productCount} 个商品`);

        if (jdSnapshot.productCount > 0) {
          saveJdSnapshot(DATA_DIR, tenantId, brand, jdSnapshot);
          const prevJd = loadJdSnapshot(DATA_DIR, tenantId, brand, yStr);
          const jdComp = compareJdSnapshots(jdSnapshot, prevJd || null);
          allSignals.push(...jdComp.signals.map(s => ({ ...s, source: "jd" })));
        } else {
          errors.push("京东: 未采集到商品数据（可能触发反爬或登录过期）");
        }
      } catch (e) {
        errors.push(`京东采集失败: ${e.message}`);
        console.error(`[jd] ${brand}: ${e.message}`);
      }
    }

    // ── PDD collection ──
    if (platforms.pdd) {
      try {
        console.log(`[collect] 拼多多采集开始: ${brand}`);
        pddSnapshot = await collectPddSnapshot(page, brand);
        console.log(`[collect] 拼多多完成: ${pddSnapshot.productCount} 个商品`);

        if (pddSnapshot.productCount > 0) {
          savePddSnapshot(DATA_DIR, tenantId, brand, pddSnapshot);
          const prevPdd = loadPddSnapshot(DATA_DIR, tenantId, brand, yStr);
          const pddComp = comparePddSnapshots(pddSnapshot, prevPdd || null);
          allSignals.push(...pddComp.signals.map(s => ({ ...s, source: "pdd" })));
        } else {
          errors.push("拼多多: 未采集到商品数据（可能触发反爬或登录过期）");
        }
      } catch (e) {
        errors.push(`拼多多采集失败: ${e.message}`);
        console.error(`[pdd] ${brand}: ${e.message}`);
      }
    }

    // No data at all
    if (!tmSnapshot && !jdSnapshot && !pddSnapshot) {
      throw new Error("所有数据源采集失败");
    }

    const totalProducts = (tmSnapshot?.productCount || 0) + (jdSnapshot?.productCount || 0) + (pddSnapshot?.productCount || 0);
    if (totalProducts === 0) {
      throw new Error(errors.join("; ") || "所有数据源均未返回商品数据");
    }

    // Historical trends (from Tmall data as primary source)
    const history = loadRecentHistory(DATA_DIR, tenantId, brand, 14);
    const trends = {
      productCount: analyzeTrend(history, d => d.productCount),
      avgPrice: analyzeTrend(history, d => d.priceRange?.avg),
    };

    const combinedComparison = { signals: allSignals, isNew: allSignals.length === 0 };

    const suggestions = generateSuggestions(allSignals, trends, brand);
    const healthScore = brandHealthScore(allSignals, trends);
    const brief = generateDailyBrief(brand, todayStr, combinedComparison, trends, suggestions);
    brief.healthScore = healthScore;
    brief.sources = [];
    if (tmSnapshot && tmSnapshot.productCount > 0) brief.sources.push("tmall");
    if (jdSnapshot && jdSnapshot.productCount > 0) brief.sources.push("jd");
    if (pddSnapshot && pddSnapshot.productCount > 0) brief.sources.push("pdd");
    if (errors.length > 0) brief.warnings = errors;
    saveReport(DATA_DIR, tenantId, brand, brief);

    releasePage(tenantId, page);
    return { tmSnapshot, jdSnapshot, pddSnapshot, signals: allSignals, brief, warnings: errors.length > 0 ? errors : undefined };
  } catch (e) {
    if (page) releasePage(tenantId, page);
    throw e;
  }
}

// ── Helpers ────────────────────────────────────────────────────

function loadRecentHistory(dataDir, tenantId, brand, days) {
  const results = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const ds = dateStr(d);
    const snap = loadSnapshot(dataDir, tenantId, brand, ds);
    if (snap && snap.productCount > 0) results.push({ date: ds, ...snap });
  }
  return results;
}

function reportPath(dataDir, tenantId, brand, date) {
  return path.join(dataDir, tenantId, sanitize(brand), `report-${date}.json`);
}

function saveReport(dataDir, tenantId, brand, brief) {
  const dir = path.join(dataDir, tenantId, sanitize(brand));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(reportPath(dataDir, tenantId, brand, brief.date), JSON.stringify(brief, null, 2));
}

function findLatestReport(dataDir, tenantId, brand) {
  const dir = path.join(dataDir, tenantId, sanitize(brand));
  if (!fs.existsSync(dir)) return null;
  const reports = fs.readdirSync(dir)
    .filter(f => f.startsWith("report-"))
    .sort()
    .reverse();
  if (reports.length === 0) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, reports[0]), "utf-8"));
  } catch (e) { return null; }
}

function yesterdayStr() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return dateStr(d);
}

function dateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function sanitize(name) {
  return (name || "").replace(/[<>:"/\\|?*]/g, "_").trim();
}

// ── Start ──────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🔍 竞品情报 SaaS 已启动`);
  console.log(`   地址: http://localhost:${PORT}`);
  console.log(`   健康检查: http://localhost:${PORT}/api/v1/health`);

  const tenants = loadTenants();
  console.log(`   已加载 ${Object.keys(tenants).length} 个客户`);

  scheduler.start(DATA_DIR, async (tenantId, brandName) => {
    const plan = (tenants[tenantId] || {}).plan || "trial";
    const limits = getPlanLimits(plan);
    const todayCount = getTodaySearchCount(tenantId);
    if (todayCount >= limits.maxSearchesPerDay) {
      console.log(`[scheduler] 跳过 ${tenantId}/${brandName} — 已达每日上限`);
      return;
    }
    const result = await runCollection(tenantId, brandName);
    const email = (tenants[tenantId] || {}).email;
    if (email && result.brief) {
      try {
        await mailer.sendDailyBrief(email, result.brief);
        console.log(`[scheduler] 日报已发送至 ${email}`);
      } catch (e) {
        console.error(`[scheduler] 邮件发送失败: ${e.message}`);
      }
    }
  });
  console.log(`   调度器已启动 — 每日 08:00 自动采集 + 邮件推送`);
});
