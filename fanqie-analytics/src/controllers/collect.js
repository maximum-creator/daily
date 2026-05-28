const { Router } = require("express");
const { startCollection, getProgress, collecting, collectProgress } = require("../services/collector.service");
const { getTodayCollectionCount } = require("../repos/usage.repo");
const { hasProfile, getPage, releasePage } = require("../collectors/browser-manager");
const { collectDashboard } = require("../collectors/dashboard");
const { getPlanLimits, getPlan } = require("../../lib/plans");
const { today } = require("../utils/helpers");
const { broadcast } = require("../websocket/ws-manager");
const logger = require("../utils/logger");

const router = Router();

router.post("/books/scan", async (req, res) => {
  const tenantId = req.tenant.id;

  if (!hasProfile(tenantId)) {
    return res.json({ code: 0, data: { novels: [], message: "未配置浏览器登录态" } });
  }

  let page;
  try {
    page = await getPage(tenantId);
    await page.goto("https://fanqienovel.com/main/writer/home", {
      waitUntil: "domcontentloaded", timeout: 15000,
    }).catch(() => {});
    await page.waitForTimeout(800);

    const url = page.url();
    if (url.includes("login") || url.includes("passport")) {
      releasePage(tenantId, page);
      return res.json({ code: 0, data: { novels: [], message: "登录态已过期" } });
    }

    const dashboard = await collectDashboard(page);
    releasePage(tenantId, page);
    return res.json({ code: 0, data: { novels: dashboard.novels || [] } });
  } catch (e) {
    try { if (page) releasePage(tenantId, page); } catch (e2) { /* ok */ }
    logger.error({ err: e, tenantId }, "扫描作品列表失败");
    return res.json({ code: 0, data: { novels: [], message: e.message } });
  }
});

router.post("/collect", async (req, res) => {
  const tenantId = req.tenant.id;
  const force = req.query.force === "true" || req.query.force === "1";
  const booksParam = req.query.books || "";

  // Plan quota check
  const plan = req.tenant.plan || "trial";
  const limits = getPlanLimits(plan);
  const todayCount = await getTodayCollectionCount(tenantId, today());
  if (todayCount >= limits.maxCollectionsPerDay) {
    return res.status(429).json({
      code: 429,
      message: `今日采集次数已达上限（${limits.maxCollectionsPerDay}次/天），当前套餐: ${getPlan(plan).name}`,
      limit: limits.maxCollectionsPerDay, used: todayCount,
    });
  }

  if (!hasProfile(tenantId)) {
    return res.json({ code: 400, message: "未配置浏览器登录态，请先登录番茄小说" });
  }

  const result = await startCollection(tenantId, {
    force, booksParam,
    tenant: req.tenant,
    wsBroadcast: broadcast,
  });

  const progress = getProgress(tenantId);
  res.json({ code: result.code, data: { async: true, taskId: tenantId, ...progress }, message: result.message });
});

router.get("/collect/progress", (req, res) => {
  const tenantId = req.tenant.id;
  const progress = getProgress(tenantId);

  // Stale or done progress → return idle
  if (!progress || progress.done) {
    if (progress?.done) {
      // Clean up stale done progress after 5 min
      if (Date.now() - progress.startTime > 300000) {
        collecting.delete(tenantId);
        collectProgress.delete(tenantId);
      }
    }
    return res.json({ code: 0, data: { phase: "idle" } });
  }

  const elapsed = progress.startTime ? Math.round((Date.now() - progress.startTime) / 1000) : 0;
  res.json({ code: 0, data: { ...progress, elapsed } });
});

module.exports = router;
