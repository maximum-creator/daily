const { Router } = require("express");
const { getCollections, getRecentCollections, getHistoricalMetrics } = require("../repos/collection.repo");
const { analyzeTenantData } = require("../services/analysis.service");
const { generateAIAnalysis } = require("../services/ai.service");

const router = Router();

function findCollection(collections, targetBook) {
  if (!targetBook) return collections[0];
  return collections.find((c) =>
    c.book === targetBook || (c.book || "").includes(targetBook) || targetBook.includes(c.book || "")
  ) || collections[0];
}

router.get("/analysis", async (req, res) => {
  const tenantId = req.tenant.id;
  const targetBook = req.query.book || "";
  const includeAI = req.query.ai !== "false";

  const collections = await getRecentCollections(tenantId);
  if (collections.length === 0) {
    return res.json({ code: 404, message: "暂无数据，请先采集" });
  }

  const targetData = findCollection(collections, targetBook);
  const historicalMetrics = await getHistoricalMetrics(tenantId, targetData.book, 30);
  const analysis = analyzeTenantData(targetData, historicalMetrics);

  let aiAnalysis = null;
  if (includeAI) {
    aiAnalysis = await generateAIAnalysis(analysis, targetData);
  }

  res.json({
    code: 0,
    data: {
      book: targetData.book,
      date: targetData.date,
      collectedAt: targetData.collectedAt,
      analysis,
      aiAnalysis,
      raw: {
        revenue: targetData.revenue,
        traffic: targetData.traffic,
        engagement: targetData.worksData,
      },
    },
  });
});

router.get("/summary", async (req, res) => {
  const tenantId = req.tenant.id;
  const targetBook = req.query.book || "";

  const collections = await getRecentCollections(tenantId);
  if (collections.length === 0) return res.json({ code: 404, message: "暂无数据" });

  const summary = findCollection(collections, targetBook);
  const revenue = summary.revenue?.overview || {};
  const traffic = summary.traffic?.sources || {};

  res.json({
    code: 0,
    data: {
      date: summary.date,
      book: summary.book,
      collectedAt: summary.collectedAt,
      revenue: { yesterday: revenue.yesterdayRevenue || 0, total: revenue.totalRevenue || 0 },
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

router.get("/books", async (req, res) => {
  const tenantId = req.tenant.id;
  const collections = await getRecentCollections(tenantId);

  // Deduplicate by book name, keep latest
  const seen = new Map();
  for (const c of collections) {
    if (!seen.has(c.book)) seen.set(c.book, c);
  }

  const books = Array.from(seen.values()).map((c) => ({
    name: c.book,
    latestDate: c.date,
    latestRevenue: c.revenue?.overview?.yesterdayRevenue || 0,
    totalChapters: c.quality?.totalChapters || 0,
    cumulativeWords: c.quality?.cumulativeWords || 0,
  }));

  res.json({ code: 0, data: books });
});

router.get("/force-index", async (req, res) => {
  const tenantId = req.tenant.id;

  const collections = await getRecentCollections(tenantId);
  if (collections.length === 0) return res.json({ code: 404, message: "暂无数据" });

  const targetData = collections[0];
  const analysis = analyzeTenantData(targetData, []);

  res.json({
    code: 0,
    data: {
      score: analysis.forceIndex.score,
      breakdown: analysis.forceIndex.breakdown,
      prediction: analysis.forceIndex.prediction,
      stage: analysis.stage,
      benchmarks: analysis.stageBenchmarks,
    },
  });
});

module.exports = router;
