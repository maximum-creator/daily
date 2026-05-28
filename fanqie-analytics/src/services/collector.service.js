const { getPage, releasePage, hasProfile } = require("../collectors/browser-manager");
const { collectDashboard, switchToBook, switchBookOnProfitPage } = require("../collectors/dashboard");
const { collectQuality } = require("../collectors/quality");
const { collectTrafficFromPage, collectTrafficFromApi } = require("../collectors/traffic");
const { collectRevenue } = require("../collectors/revenue");
const { jsClick, extractUpdateTime } = require("../collectors/helpers");
const { saveCollection } = require("../repos/collection.repo");
const { getTodayCollectionCount } = require("../repos/usage.repo");
const { getPlanLimits, getPlan } = require("../../lib/plans");
const { today, localISO } = require("../utils/helpers");
const logger = require("../utils/logger");
const path = require("path");
const fs = require("fs");

const DATA_DIR = path.join(__dirname, "..", "..", "data");

const collecting = new Set();
const collectProgress = new Map();

function getProgress(tenantId) {
  return collectProgress.get(tenantId);
}

async function collectWorksData(page) {
  const txt = await page.evaluate(() => document.body?.innerText || "");
  const metrics = {};
  const patterns = {
    "阅读人数": /阅读人数\s+([\d,]+)/,
    "在读人数": /在读人数\s+([\d,]+)/,
    "作品评分": /作品评分\s+([\d.]+)/,
    "评论次数": /评论次数\s+([\d,]+)/,
    "加书架人数": /加书架人数\s+([\d,]+)/,
    "催更人数": /催更人数\s+([\d,]+)/,
    "追更人数": /追更人数\s+([\d,]+)/,
  };
  for (const [key, regex] of Object.entries(patterns)) {
    const match = txt.match(regex);
    metrics[key] = match ? parseFloat(match[1].replace(/,/g, "")) : 0;
  }
  return metrics;
}

function updateProgress(tenantId, update) {
  const p = collectProgress.get(tenantId);
  if (p) Object.assign(p, update);
}

async function runCollection(tenantId, opts = {}) {
  const { force = false, booksParam = "", tenant, wsBroadcast } = opts;
  const todayStr = today();
  let page;

  try {
    // Phase 1: Browser
    updateProgress(tenantId, { phase: "browser", message: "正在启动无头浏览器…" });
    if (wsBroadcast) wsBroadcast(tenantId, { step: "browser", message: "启动无头浏览器" });
    page = await getPage(tenantId);

    // Phase 2: Navigate
    updateProgress(tenantId, { phase: "navigate", message: "正在导航到番茄小说作者后台…" });
    if (wsBroadcast) wsBroadcast(tenantId, { step: "login", message: "导航到作者后台" });
    await page.goto("https://fanqienovel.com/main/writer/home", {
      waitUntil: "domcontentloaded", timeout: 20000,
    }).catch(() => {});
    try {
      await page.waitForSelector('[class*="nav-item"], [class*="sidebar"], [class*="menu-item"]', { timeout: 8000 });
    } catch (e) { /* continue */ }
    await page.waitForTimeout(800);

    // Phase 3: Login check
    updateProgress(tenantId, { phase: "login_check", message: "验证登录态…" });
    if (wsBroadcast) wsBroadcast(tenantId, { step: "login_check", message: "验证登录状态" });
    const url = page.url();
    if (url.includes("login") || url.includes("passport")) {
      releasePage(tenantId, page);
      collecting.delete(tenantId);
      updateProgress(tenantId, { phase: "error", done: true, error: true, message: "登录态已过期，请重新登录" });
      if (wsBroadcast) wsBroadcast(tenantId, { step: "error", message: "登录态已过期" });
      return;
    }
    await page.waitForTimeout(300);
    const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 500) || "");
    if (bodyText.includes("请登录") || bodyText.includes("验证码") || bodyText.length < 50) {
      releasePage(tenantId, page);
      collecting.delete(tenantId);
      updateProgress(tenantId, { phase: "error", done: true, error: true, message: "登录态失效或页面加载异常" });
      if (wsBroadcast) wsBroadcast(tenantId, { step: "error", message: "登录态失效" });
      return;
    }

    // Phase 4: Navigate to data center
    updateProgress(tenantId, { phase: "data_page", message: "进入小说数据中心…" });
    if (wsBroadcast) wsBroadcast(tenantId, { step: "data_page", message: "进入数据中心" });
    await jsClick(page, "小说数据");
    await page.waitForTimeout(800);
    const dataPageUrl = page.url();

    // Phase 5: Get book list
    updateProgress(tenantId, { phase: "dashboard", message: "读取作品列表…" });
    if (wsBroadcast) wsBroadcast(tenantId, { step: "dashboard", message: "读取作品列表" });
    const dashboard = await collectDashboard(page);
    let targetBooks = dashboard.novels || [];

    if (targetBooks.length === 0) {
      releasePage(tenantId, page);
      collecting.delete(tenantId);
      updateProgress(tenantId, { phase: "error", done: true, error: true, message: "未找到任何作品" });
      return;
    }

    if (booksParam) {
      const requested = booksParam.split(",").map((s) => s.trim()).filter(Boolean);
      const filtered = [];
      for (const r of requested) {
        let found = targetBooks.find((b) => b.name === r);
        if (!found) found = targetBooks.find((b) => b.name.includes(r) || r.includes(b.name));
        if (found && !filtered.includes(found)) filtered.push(found);
      }
      targetBooks = filtered.length > 0 ? filtered : targetBooks.slice(0, 1);
    }

    // Phase 6: Collect each book
    updateProgress(tenantId, {
      phase: "collecting", totalBooks: targetBooks.length, currentBook: 0,
      books: targetBooks.map((b) => ({ name: b.name, status: "pending" })),
    });

    const collected = [];
    for (let i = 0; i < targetBooks.length; i++) {
      const book = targetBooks[i];
      updateProgress(tenantId, { currentBook: i + 1, message: `正在采集《${book.name}》(${i + 1}/${targetBooks.length})` });
      if (wsBroadcast) wsBroadcast(tenantId, {
        step: "collecting", book: book.name, progress: i + 1, total: targetBooks.length,
        message: `采集《${book.name}》(${i + 1}/${targetBooks.length})`,
      });

      collectProgress.get(tenantId).books[i].status = "collecting";

      // Switch to book
      await jsClick(page, "小说数据");
      await page.waitForTimeout(400);

      const switched = await switchToBook(page, book.name, dataPageUrl);
      if (!switched) {
        collected.push({ book: book.name, error: "切换失败" });
        collectProgress.get(tenantId).books[i].status = "error";
        continue;
      }

      try {
        const summary = await collectForBook(page, book.name, book.status || "");
        await saveCollection(DATA_DIR, tenantId, summary);
        collectProgress.get(tenantId).books[i].status = "done";
        collected.push({
          book: book.name,
          revenue: summary.revenue?.overview?.yesterdayRevenue || 0,
          chapters: summary.quality?.chaptersWithCompletionRate || 0,
          collectedAt: summary.collectedAt,
        });
      } catch (bookErr) {
        collected.push({ book: book.name, error: bookErr.message });
        collectProgress.get(tenantId).books[i].status = "error";
        collectProgress.get(tenantId).books[i].error = bookErr.message;
      }
    }

    releasePage(tenantId, page);
    collecting.delete(tenantId);
    updateProgress(tenantId, {
      phase: "done", done: true, result: { date: todayStr, books: collected, total: collected.length },
      message: `采集完成，共 ${collected.length} 本书`,
    });
    if (wsBroadcast) wsBroadcast(tenantId, { step: "done", result: { date: todayStr, books: collected } });

  } catch (e) {
    try { if (page) releasePage(tenantId, page); } catch (e2) { /* ok */ }
    collecting.delete(tenantId);
    updateProgress(tenantId, { phase: "error", done: true, error: true, message: `采集异常: ${e.message}` });
    if (wsBroadcast) wsBroadcast(tenantId, { step: "error", message: e.message });
    logger.error({ err: e, tenantId }, "采集失败");
  }
}

async function collectForBook(page, bookName, bookStatus) {
  const date = today();
  const results = {};
  const freshness = {};

  // 1. Works data
  try { results.worksData = await collectWorksData(page); } catch (e) { results.worksData = {}; }
  try {
    const t = await page.evaluate(() => document.body?.innerText?.slice(0, 5000) || "");
    freshness.worksData = extractUpdateTime(t);
  } catch (e) { /* skip */ }

  // 2. Quality — intercept API responses
  try {
    const qualityApiCalls = [];
    const onResponse = async (response) => {
      const url = response.url();
      if (url.includes("fanqienovel.com") && /api|data|quality|chapter/i.test(url)) {
        try {
          const ct = response.headers()["content-type"] || "";
          if (ct.includes("json")) {
            const body = await response.text();
            qualityApiCalls.push({ url, body, status: response.status() });
          }
        } catch (e) { /* skip */ }
      }
    };
    page.on("response", onResponse);
    try {
      await jsClick(page, "质量分析");
      await page.waitForFunction(
        () => document.body.innerText.includes("章节名") || document.body.innerText.includes("读完率"),
        { timeout: 8000 }
      ).catch(() => {});
      await page.waitForTimeout(800);
    } finally { page.removeListener("response", onResponse); }

    // Fetch additional stats_types
    if (qualityApiCalls.length > 0) {
      let bookId = null;
      try { bookId = new URL(qualityApiCalls[0].url).searchParams.get("book_id"); } catch (e) { /* skip */ }
      if (bookId) {
        const firstUrl = new URL(qualityApiCalls[0].url);
        for (const st of ["3", "4"]) {
          try {
            const u = new URL(firstUrl.origin + firstUrl.pathname);
            for (const [k, v] of firstUrl.searchParams) u.searchParams.set(k, k === "stats_type" ? st : v);
            if (!u.searchParams.has("stats_type")) u.searchParams.set("stats_type", st);
            u.searchParams.set("page_count", "500");
            u.searchParams.set("count", "500");
            const body = await page.evaluate(async (apiUrl) => {
              const res = await fetch(apiUrl, { credentials: "include" });
              return await res.text();
            }, u.toString());
            qualityApiCalls.push({ url: u.toString(), body, status: 200 });
          } catch (e) { /* skip */ }
        }
      }
    }
    results.quality = await collectQuality(page, qualityApiCalls);
    try {
      const t = await page.evaluate(() => document.body?.innerText?.slice(0, 5000) || "");
      freshness.quality = extractUpdateTime(t);
    } catch (e) { /* skip */ }
  } catch (e) { results.quality = { chapters: [], chapterList: [] }; }

  // 3. Traffic
  try {
    const trafficApiCalls = [];
    const onTrafficResponse = async (response) => {
      if (response.url().includes("fanqienovel.com")) {
        try {
          const ct = response.headers()["content-type"] || "";
          if (ct.includes("json")) {
            const body = await response.text();
            trafficApiCalls.push({ url: response.url(), body, status: response.status() });
          }
        } catch (e) { /* skip */ }
      }
    };
    page.on("response", onTrafficResponse);
    try {
      await jsClick(page, "流量构成");
      await page.waitForFunction(
        () => document.body.innerText.includes("流量来源") || document.body.innerText.includes("来源"),
        { timeout: 8000 }
      ).catch(() => {});
      await page.waitForTimeout(800);
    } finally { page.removeListener("response", onTrafficResponse); }

    let legendNames = null;
    const fromPage = await collectTrafficFromPage(page);
    if (fromPage?.legendNames) legendNames = fromPage.legendNames;

    results.traffic = trafficApiCalls.length > 0
      ? collectTrafficFromApi(trafficApiCalls, legendNames)
      : { sources: {}, isEmpty: true };
  } catch (e) { results.traffic = { sources: {}, isEmpty: true }; }

  // 4. Revenue
  let revenue30 = null;
  try {
    await jsClick(page, "小说收益");
    await page.waitForTimeout(400);
    const profitSwitched = await switchBookOnProfitPage(page, bookName);
    if (profitSwitched) {
      await jsClick(page, "每日收益");
      await page.waitForTimeout(300);
      results.revenue = await collectRevenue(page);
      if (await jsClick(page, "30天")) {
        await page.waitForTimeout(600);
        revenue30 = await collectRevenue(page);
      }
    }
  } catch (e) { results.revenue = { overview: { yesterdayRevenue: 0, totalRevenue: 0 }, dailyRevenue: [] }; }

  const revenue = (revenue30?.dailyRevenue?.length > (results.revenue?.dailyRevenue?.length || 0))
    ? revenue30 : (results.revenue || { overview: { yesterdayRevenue: 0, totalRevenue: 0 }, dailyRevenue: [] });

  return {
    date,
    book: bookName,
    status: bookStatus,
    collectedAt: localISO(),
    worksData: results.worksData || {},
    quality: {
      book: bookName,
      chapters: results.quality?.chapters || [],
      chapterList: results.quality?.chapterList || [],
      chaptersWithCompletionRate: results.quality?.chapters?.length || 0,
      totalChapters: results.quality?.totalCount || results.quality?.chapterList?.length || 0,
      avgWordCount: results.quality?.chapterList?.length > 0
        ? Math.round(results.quality.chapterList.reduce((s, c) => s + c.wordCount, 0) / results.quality.chapterList.length)
        : 0,
      cumulativeWords: results.quality?.cumulativeWords || 0,
      milestones: results.quality?.milestones || {},
      milestoneChapters: results.quality?.milestoneChapters || {},
      dailyWords: results.quality?.dailyWords || {},
    },
    traffic: results.traffic || { sources: {} },
    revenue,
  };
}

async function startCollection(tenantId, opts = {}) {
  if (collecting.has(tenantId)) {
    return { code: 409, message: "该客户正在采集中" };
  }
  if (!hasProfile(tenantId)) {
    return { code: 400, message: "未配置浏览器登录态" };
  }

  const now = new Date();
  const progress = {
    phase: "starting", message: "正在启动无头浏览器…",
    totalBooks: 0, currentBook: 0, done: false,
    startTime: Date.now(), elapsed: 0,
    books: [],
  };
  collectProgress.set(tenantId, progress);
  collecting.add(tenantId);

  // Fire async
  runCollection(tenantId, opts).catch((e) => {
    logger.error({ err: e, tenantId }, "runCollection 异常");
  });

  return { code: 0, message: "采集已启动", progress };
}

module.exports = { startCollection, runCollection, getProgress, collecting, collectProgress, collectForBook };
