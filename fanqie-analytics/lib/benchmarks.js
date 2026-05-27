// ═══════════════════════════════════════════════════════════════════
// 番茄小说品类对标基准数据
// 来源：平台公开数据 + 行业经验 + 创作者社区反馈
// 更新：随平台生态变化定期校准
// ═══════════════════════════════════════════════════════════════════

// 字数段划分: <10万字 / 10-50万字 / >50万字
const RANGES = {
  early:   { max: 100000, label: "10万字以下" },
  mid:     { max: 500000, label: "10-50万字" },
  mature:  { max: Infinity, label: "50万字以上" },
};

// 品类对标基准 — [early, mid, mature]
// 每项: { completion, follow, searchRatio, bookmarkRate, revenuePerKWord }
const CATEGORIES = {
  urban: {
    label: "都市",
    early:   { completion: 38, follow: 42, searchRatioMax: 50, bookmarkRate: 10, revenuePerKWord: 0.8 },
    mid:     { completion: 45, follow: 48, searchRatioMax: 30, bookmarkRate: 12, revenuePerKWord: 1.5 },
    mature:  { completion: 40, follow: 44, searchRatioMax: 25, bookmarkRate: 11, revenuePerKWord: 2.0 },
  },
  fantasy: {
    label: "玄幻",
    early:   { completion: 32, follow: 36, searchRatioMax: 55, bookmarkRate: 9, revenuePerKWord: 0.6 },
    mid:     { completion: 38, follow: 42, searchRatioMax: 35, bookmarkRate: 11, revenuePerKWord: 1.2 },
    mature:  { completion: 35, follow: 40, searchRatioMax: 30, bookmarkRate: 10, revenuePerKWord: 1.8 },
  },
  romance: {
    label: "言情",
    early:   { completion: 42, follow: 46, searchRatioMax: 40, bookmarkRate: 13, revenuePerKWord: 1.0 },
    mid:     { completion: 48, follow: 52, searchRatioMax: 25, bookmarkRate: 15, revenuePerKWord: 1.8 },
    mature:  { completion: 44, follow: 48, searchRatioMax: 20, bookmarkRate: 14, revenuePerKWord: 2.5 },
  },
  suspense: {
    label: "悬疑",
    early:   { completion: 45, follow: 48, searchRatioMax: 35, bookmarkRate: 11, revenuePerKWord: 0.9 },
    mid:     { completion: 50, follow: 52, searchRatioMax: 22, bookmarkRate: 13, revenuePerKWord: 1.6 },
    mature:  { completion: 46, follow: 48, searchRatioMax: 18, bookmarkRate: 12, revenuePerKWord: 2.2 },
  },
  scifi: {
    label: "科幻",
    early:   { completion: 34, follow: 38, searchRatioMax: 50, bookmarkRate: 8, revenuePerKWord: 0.7 },
    mid:     { completion: 40, follow: 44, searchRatioMax: 32, bookmarkRate: 10, revenuePerKWord: 1.3 },
    mature:  { completion: 37, follow: 42, searchRatioMax: 28, bookmarkRate: 9, revenuePerKWord: 1.9 },
  },
  history: {
    label: "历史",
    early:   { completion: 35, follow: 38, searchRatioMax: 48, bookmarkRate: 9, revenuePerKWord: 0.7 },
    mid:     { completion: 42, follow: 45, searchRatioMax: 30, bookmarkRate: 11, revenuePerKWord: 1.4 },
    mature:  { completion: 38, follow: 42, searchRatioMax: 25, bookmarkRate: 10, revenuePerKWord: 2.0 },
  },
  gaming: {
    label: "游戏",
    early:   { completion: 36, follow: 40, searchRatioMax: 45, bookmarkRate: 10, revenuePerKWord: 0.8 },
    mid:     { completion: 42, follow: 46, searchRatioMax: 28, bookmarkRate: 12, revenuePerKWord: 1.5 },
    mature:  { completion: 38, follow: 42, searchRatioMax: 22, bookmarkRate: 11, revenuePerKWord: 2.1 },
  },
  lightnovel: {
    label: "轻小说",
    early:   { completion: 40, follow: 44, searchRatioMax: 42, bookmarkRate: 11, revenuePerKWord: 0.9 },
    mid:     { completion: 46, follow: 50, searchRatioMax: 26, bookmarkRate: 14, revenuePerKWord: 1.6 },
    mature:  { completion: 42, follow: 46, searchRatioMax: 22, bookmarkRate: 13, revenuePerKWord: 2.3 },
  },
};

function getWordRange(totalWords) {
  if (totalWords < 100000) return "early";
  if (totalWords < 500000) return "mid";
  return "mature";
}

/**
 * Get category benchmarks for a book.
 * @param {string} category - Category key (urban/fantasy/romance/etc.)
 * @param {number} totalWords - Total word count
 * @returns {{ label: string, range: string, rangeLabel: string, benchmarks: object }}
 */
function getCategoryBenchmarks(category, totalWords) {
  const cat = CATEGORIES[category];
  if (!cat) return null;
  const range = getWordRange(totalWords);
  const bm = cat[range];
  return {
    label: cat.label,
    range,
    rangeLabel: RANGES[range].label,
    benchmarks: bm,
  };
}

/**
 * Calculate percentile estimate based on current vs benchmark.
 * This is a simplified model — true percentiles require platform data.
 * @returns {number} 0-100 estimated percentile
 */
function estimatePercentile(current, benchmark, metric) {
  if (!benchmark || benchmark <= 0) return 50;
  // For metrics where lower is better (search ratio)
  if (metric === "searchRatio") {
    const ratio = current / benchmark;
    if (ratio <= 0.5) return 75 + Math.round((1 - ratio) * 25);
    if (ratio <= 1.0) return 50 + Math.round((1 - ratio) * 25);
    if (ratio <= 1.5) return 25 + Math.round((1.5 - ratio) * 25);
    return Math.max(5, Math.round((1 - ratio / 2) * 20));
  }
  // For metrics where higher is better
  const ratio = current / benchmark;
  if (ratio >= 1.5) return 90 + Math.round(Math.min(10, (ratio - 1.5) * 20));
  if (ratio >= 1.0) return 50 + Math.round((ratio - 1) * 40);
  if (ratio >= 0.5) return 20 + Math.round((ratio - 0.5) * 30);
  return Math.max(1, Math.round(ratio * 20));
}

/**
 * Generate cross-category ranking summary.
 * @param {object} current - { completion, follow, searchRatio, bookmarkRate, revenuePerKWord, totalWords }
 * @param {string} primaryCategory - Primary category key
 * @returns {object}
 */
function generateCategoryReport(current, primaryCategory) {
  if (!primaryCategory || !CATEGORIES[primaryCategory]) {
    return { available: false, message: "未设置品类或品类无效" };
  }

  const catBm = getCategoryBenchmarks(primaryCategory, current.totalWords || 0);
  if (!catBm) return { available: false, message: "品类数据不可用" };

  const bm = catBm.benchmarks;
  const percentiles = {
    completion: estimatePercentile(current.completion || 0, bm.completion, "completion"),
    follow: estimatePercentile(current.follow || 0, bm.follow, "follow"),
    searchRatio: estimatePercentile(current.searchRatio || 100, bm.searchRatioMax, "searchRatio"),
    bookmarkRate: estimatePercentile(current.bookmarkRate || 0, bm.bookmarkRate, "bookmarkRate"),
  };
  const avgPct = Math.round(
    (percentiles.completion + percentiles.follow + percentiles.searchRatio + percentiles.bookmarkRate) / 4
  );

  // Find the comparison (next-higher) benchmarks
  const allRanges = ["early", "mid", "mature"];
  const currentRangeIdx = allRanges.indexOf(catBm.range);
  const nextRange = currentRangeIdx < 2 ? allRanges[currentRangeIdx + 1] : null;
  const nextBm = nextRange ? { range: RANGES[nextRange].label, benchmarks: CATEGORIES[primaryCategory][nextRange] } : null;

  // Strengths & weaknesses
  const items = [
    { key: "completion", label: "读完率", pct: percentiles.completion, current: current.completion || 0, target: bm.completion },
    { key: "follow", label: "追读率", pct: percentiles.follow, current: current.follow || 0, target: bm.follow },
    { key: "searchRatio", label: "搜索占比", pct: percentiles.searchRatio, current: current.searchRatio || 0, target: bm.searchRatioMax, lowerBetter: true },
    { key: "bookmarkRate", label: "加书架率", pct: percentiles.bookmarkRate, current: current.bookmarkRate || 0, target: bm.bookmarkRate },
  ];
  items.sort((a, b) => b.pct - a.pct);
  const strengths = items.slice(0, 2).map(i => i.label);
  const weaknesses = items.slice(-2).map(i => i.label);

  return {
    available: true,
    category: primaryCategory,
    categoryLabel: catBm.label,
    range: catBm.range,
    rangeLabel: catBm.rangeLabel,
    benchmarks: bm,
    percentiles,
    overallPercentile: avgPct,
    strengths,
    weaknesses,
    nextRange: nextBm,
    allCategories: Object.entries(CATEGORIES).map(([key, cat]) => ({
      key,
      label: cat.label,
      current: key === primaryCategory,
    })),
  };
}

module.exports = {
  CATEGORIES,
  RANGES,
  getCategoryBenchmarks,
  estimatePercentile,
  generateCategoryReport,
};
