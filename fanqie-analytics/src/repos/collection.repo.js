const { getDb, saveDb } = require("../database/connection");

async function saveCollection(tenantId, summary) {
  const db = await getDb();
  const date = summary.date;
  const book = summary.book;

  // Remove existing entry for same tenant+date+book
  db.run("DELETE FROM collections WHERE tenant_id = ? AND date = ? AND book = ?", [tenantId, date, book]);

  db.run("INSERT INTO collections (tenant_id, date, book, data) VALUES (?, ?, ?, ?)", [
    tenantId, date, book, JSON.stringify(summary),
  ]);

  // Update daily_metrics
  const revenue = summary.revenue?.overview?.yesterdayRevenue || 0;
  const readers = summary.worksData?.["阅读人数"] || 0;
  const bookmarks = summary.worksData?.["加书架人数"] || 0;
  const comments = summary.worksData?.["评论次数"] || 0;
  const urges = summary.worksData?.["催更人数"] || 0;
  const follow = summary.worksData?.["追更人数"] || 0;
  const totalWords = summary.quality?.cumulativeWords || 0;
  const chaptersCount = summary.quality?.totalChapters || summary.quality?.chapterList?.length || 0;

  const qualityChs = summary.quality?.chapters || [];
  const rates = qualityChs.map((c) => c.completionRate).filter((r) => r > 0);
  const avgCompletion = rates.length > 0 ? rates.reduce((a, b) => a + b, 0) / rates.length : 0;
  const followRates = qualityChs.map((c) => c.followReadRate).filter((r) => r > 0);
  const avgFollow = followRates.length > 0 ? followRates.reduce((a, b) => a + b, 0) / followRates.length : 0;

  const trafficSources = summary.traffic?.sources || {};
  const totalTraffic = Object.values(trafficSources).reduce((a, b) => a + b, 0);
  const searchTraffic = trafficSources["搜索"] || 0;
  const searchRatio = totalTraffic > 0 ? Math.round((searchTraffic / totalTraffic) * 100) : 0;

  db.run(
    `INSERT OR REPLACE INTO daily_metrics
     (tenant_id, date, book, revenue, readers, bookmarks, comments, urges, follow_readers, total_words, chapters_count, avg_completion, avg_follow, search_ratio)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [tenantId, date, book, revenue, readers, bookmarks, comments, urges, follow, totalWords, chaptersCount, Math.round(avgCompletion * 10) / 10, Math.round(avgFollow * 10) / 10, searchRatio]
  );

  saveDb();
}

async function getRecentCollections(tenantId, daysBack = 30) {
  const db = await getDb();
  const result = db.exec(
    "SELECT data FROM collections WHERE tenant_id = ? ORDER BY date DESC LIMIT 100",
    [tenantId]
  );
  if (!result.length || !result[0].values.length) return [];
  return result[0].values.map((row) => JSON.parse(row[0]));
}

async function getCollections(tenantId, date) {
  const db = await getDb();
  const result = db.exec("SELECT data FROM collections WHERE tenant_id = ? AND date = ?", [tenantId, date]);
  if (!result.length || !result[0].values.length) return [];
  return result[0].values.map((row) => JSON.parse(row[0]));
}

async function getCollectionBooks(tenantId) {
  const db = await getDb();
  const result = db.exec(
    "SELECT DISTINCT book, date FROM collections WHERE tenant_id = ? ORDER BY date DESC",
    [tenantId]
  );
  if (!result.length) return [];
  const books = new Map();
  for (const row of result[0].values) {
    if (!books.has(row[0])) books.set(row[0], row[1]);
  }
  return Array.from(books.entries()).map(([book, latestDate]) => ({ book, latestDate }));
}

async function getHistoricalMetrics(tenantId, book, limit = 30) {
  const db = await getDb();
  const result = db.exec(
    `SELECT date, revenue, readers, bookmarks, comments, urges, follow_readers, total_words, chapters_count, avg_completion, avg_follow, search_ratio
     FROM daily_metrics
     WHERE tenant_id = ? AND book = ?
     ORDER BY date DESC
     LIMIT ?`,
    [tenantId, book, limit]
  );
  if (!result.length || !result[0].values.length) return [];
  return result[0].values.map((row) => ({
    date: row[0], revenue: row[1], readers: row[2], bookmarks: row[3],
    comments: row[4], urges: row[5], followReaders: row[6], totalWords: row[7],
    chaptersCount: row[8], avgCompletion: row[9], avgFollow: row[10], searchRatio: row[11],
  })).reverse();
}

async function getTenantDataDays(tenantId) {
  const db = await getDb();
  const result = db.exec(
    "SELECT COUNT(DISTINCT date) FROM collections WHERE tenant_id = ?",
    [tenantId]
  );
  if (!result.length || !result[0].values.length) return 0;
  return result[0].values[0][0];
}

module.exports = { saveCollection, getCollections, getRecentCollections, getCollectionBooks, getHistoricalMetrics, getTenantDataDays };
