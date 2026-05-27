// 竞品信号聚合引擎
// 多源信号归一化 → 异常检测 → 趋势分析 → 策略建议

// ── Signal normalization ──────────────────────────────────────

function normalizeSignals(sourceSignals, source) {
  return sourceSignals.map(s => ({
    ...s,
    source,
    timestamp: new Date().toISOString(),
    severityScore: { high: 3, medium: 2, low: 1 }[s.severity] || 1,
  }));
}

// ── Aggregate signals from multiple sources ───────────────────

function aggregateAll(sources) {
  const all = [];
  for (const [sourceName, signals] of Object.entries(sources)) {
    if (!signals || signals.length === 0) continue;
    all.push(...normalizeSignals(signals, sourceName));
  }
  // Sort by severity (high first), then by source
  all.sort((a, b) => b.severityScore - a.severityScore || a.source.localeCompare(b.source));
  return all;
}

// ── Anomaly scoring (z-score method, adapted from fanqie analysis) ──

function detectAnomalies(historicalData, currentValue, metricName) {
  const values = historicalData
    .map(d => d[metricName])
    .filter(v => v != null && v > 0);

  if (values.length < 3) return { anomaly: false, reason: "insufficient_data" };

  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  const std = Math.sqrt(variance);

  if (std === 0) return { anomaly: false };

  const zScore = (currentValue - mean) / std;

  return {
    anomaly: Math.abs(zScore) > 2,
    zScore: Math.round(zScore * 10) / 10,
    mean: Math.round(mean * 10) / 10,
    std: Math.round(std * 10) / 10,
    severity: Math.abs(zScore) > 2.5 ? "high" : Math.abs(zScore) > 2 ? "medium" : "low",
    direction: zScore > 0 ? "surge" : "drop",
  };
}

// ── Trend analysis (linear regression) ────────────────────────

function analyzeTrend(historicalData, valueExtractor) {
  const points = historicalData.map(valueExtractor).filter(v => v != null && v > 0);
  if (points.length < 3) return { trend: "stable", confidence: 0 };

  const n = points.length;
  const xMean = (n - 1) / 2;
  const yMean = points.reduce((a, b) => a + b, 0) / n;

  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (points[i] - yMean);
    den += (i - xMean) ** 2;
  }

  const slope = den !== 0 ? num / den : 0;
  const normSlope = yMean > 0 ? slope / yMean : 0;

  let trend;
  if (normSlope > 0.05) trend = "rising";
  else if (normSlope < -0.05) trend = "falling";
  else trend = "stable";

  return {
    trend,
    slope: Math.round(slope * 100) / 100,
    normSlope: Math.round(normSlope * 1000) / 1000,
    confidence: Math.min(1, points.length / 10),
    values: points,
  };
}

// ── Brand health score (0-100) ─────────────────────────────────

function brandHealthScore(signals, trends) {
  let score = 70; // baseline

  // Penalize negative signals
  const highSeverity = signals.filter(s => s.severity === "high").length;
  const mediumSeverity = signals.filter(s => s.severity === "medium").length;
  score -= highSeverity * 10;
  score -= mediumSeverity * 3;

  // Adjust for trends
  if (trends.productCount?.trend === "rising") score += 5;
  if (trends.productCount?.trend === "falling") score -= 5;
  if (trends.avgPrice?.trend === "falling") score -= 3; // price erosion

  return Math.max(0, Math.min(100, Math.round(score)));
}

// ── Strategy suggestions ──────────────────────────────────────

function generateSuggestions(signals, trends, brandName) {
  const suggestions = [];
  const safe = signals || [];
  const highSignals = safe.filter(s => s.severity === "high");

  // Price drops → competitive response
  const priceDrops = highSignals.filter(s => s.type === "price_change" && s.changePct < 0);
  if (priceDrops.length > 0) {
    suggestions.push({
      priority: "high",
      category: "pricing",
      title: `${priceDrops.length} 个竞品降价 — 评估是否需要跟进`,
      detail: priceDrops.map(s => s.title).join("；"),
    });
  }

  // New products → potential threat
  const newProducts = safe.filter(s => s.type === "new_product");
  if (newProducts.length > 0) {
    suggestions.push({
      priority: "medium",
      category: "product",
      title: `${newProducts.length} 个新品上架 — 关注竞品产品策略`,
      detail: newProducts.slice(0, 3).map(s => s.title).join("；"),
    });
  }

  // Sales surges → competitor gaining traction
  const surges = safe.filter(s => s.type === "sales_surge");
  if (surges.length > 0) {
    suggestions.push({
      priority: "high",
      category: "competitive",
      title: `${surges.length} 个商品销量暴增 — 竞品正在起量`,
      detail: surges.map(s => s.title).join("；"),
    });
  }

  // Trend warnings
  if (trends.avgPrice?.trend === "falling") {
    suggestions.push({
      priority: "medium",
      category: "pricing",
      title: "竞品价格持续下行 — 行业可能在打价格战",
      detail: `近${trends.avgPrice.values?.length || 0}天均价呈下降趋势，关注是否需要调整定价策略`,
    });
  }

  if (safe.length === 0) {
    suggestions.push({
      priority: "info",
      category: "status",
      title: `${brandName} 今日无重大变动`,
      detail: "竞品产品线和价格保持稳定，无新增监测信号",
    });
  }

  return suggestions.sort((a, b) => ({ high: 0, medium: 1, info: 2 }[a.priority]) - ({ high: 0, medium: 1, info: 2 }[b.priority]));
}

module.exports = {
  normalizeSignals,
  aggregateAll,
  detectAnomalies,
  analyzeTrend,
  brandHealthScore,
  generateSuggestions,
};
