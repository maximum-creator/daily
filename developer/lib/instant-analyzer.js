// 即时竞争分析引擎 — 无需历史数据，首次采集即可产出洞察
// 核心思想：从快照静态数据中提取价格分层/店铺结构/跨平台价差等信号
// 弥补传统对比分析"第一天啥都干不了"的缺陷

// ── 价格分层 ────────────────────────────────────────────────────

function priceTiers(products) {
  if (!products || products.length === 0) return null;
  const prices = products.map(p => p.price).filter(v => v > 0).sort((a, b) => a - b);
  if (prices.length < 3) return null;

  const p25 = prices[Math.floor(prices.length * 0.25)];
  const p50 = prices[Math.floor(prices.length * 0.50)];
  const p75 = prices[Math.floor(prices.length * 0.75)];

  const tiers = { entry: 0, mid: 0, premium: 0, luxury: 0 };
  for (const p of prices) {
    if (p <= p25) tiers.entry++;
    else if (p <= p50) tiers.mid++;
    else if (p <= p75) tiers.premium++;
    else tiers.luxury++;
  }
  return {
    min: prices[0],
    max: prices[prices.length - 1],
    median: p50,
    p25, p75,
    tiers,
    tierPct: {
      entry: Math.round(tiers.entry / prices.length * 100),
      mid: Math.round(tiers.mid / prices.length * 100),
      premium: Math.round(tiers.premium / prices.length * 100),
      luxury: Math.round(tiers.luxury / prices.length * 100),
    },
    top3Price: prices.slice(-3),
    count: prices.length,
  };
}

// ── 店铺结构分析 ──────────────────────────────────────────────────

function storeStructure(products) {
  if (!products || products.length === 0) return null;
  const counts = { flagship: 0, authorized: 0, direct: 0, thirdParty: 0, unknown: 0 };
  for (const p of products) {
    const type = p.storeType || "unknown";
    counts[type] = (counts[type] || 0) + 1;
  }
  const total = products.length;
  return {
    counts,
    flagshipPct: Math.round(counts.flagship / total * 100),
    thirdPartyPct: Math.round((counts.thirdParty + counts.unknown) / total * 100),
    flagshipAvgPrice: avgPrice(products.filter(p => p.storeType === "flagship")),
    thirdPartyAvgPrice: avgPrice(products.filter(p => p.storeType === "thirdParty" || p.storeType === "unknown")),
  };
}

// ── 头部集中度 ─────────────────────────────────────────────────────

function concentration(products, topN = 3) {
  const sorted = [...(products || [])].sort((a, b) => (b.sales || 0) - (a.sales || 0));
  if (sorted.length === 0) return null;
  const totalSales = sorted.reduce((sum, p) => sum + (p.sales || 0), 0);
  if (totalSales === 0) return null;
  const topSales = sorted.slice(0, topN).reduce((sum, p) => sum + (p.sales || 0), 0);
  return {
    topN,
    topSales,
    totalSales,
    cr: Math.round(topSales / totalSales * 100),
    topProducts: sorted.slice(0, topN).map(p => ({ name: p.name?.slice(0, 40), sales: p.salesDisplay || p.sales })),
  };
}

// ── 跨平台价差 ────────────────────────────────────────────────────

function crossPlatformGap(tmProducts, pddProducts) {
  if (!tmProducts || !pddProducts || tmProducts.length === 0 || pddProducts.length === 0) return null;
  const tmAvg = avgPrice(tmProducts);
  const pddAvg = avgPrice(pddProducts);
  if (tmAvg === 0 || pddAvg === 0) return null;
  const ratio = Math.round(pddAvg / tmAvg * 100);
  const gap = Math.round(tmAvg - pddAvg);
  return {
    tmAvg,
    pddAvg,
    gap,
    ratio,
    interpretation: ratio < 70 ? "价格悬殊 — PDD存在大量低价仿品/非授权渠道"
      : ratio < 85 ? "价差明显 — 品牌渠道分层但存在窜货风险"
      : ratio < 95 ? "价格接近 — 品牌控价有效"
      : "价格倒挂或接近 — PDD可能以正品价格销售",
  };
}

// ── 品牌渠道策略判定 ──────────────────────────────────────────────

function channelStrategy(tmProducts, pddProducts) {
  const tmTiers = priceTiers(tmProducts);
  const pddTiers = priceTiers(pddProducts);
  if (!tmTiers && !pddTiers) return "data_insufficient";

  const gap = crossPlatformGap(tmProducts, pddProducts);

  // Flagship ratio
  const allProducts = [...(tmProducts || []), ...(pddProducts || [])];
  const struct = storeStructure(allProducts);

  if (struct && struct.flagshipPct >= 80) return "strong_control";
  if (gap && gap.ratio < 75) return "price_war";
  if (struct && struct.flagshipPct >= 40) return "moderate_control";
  return "lax_control";
}

const CHANNEL_LABELS = {
  strong_control: "强控价 — 品牌旗舰店主导，渠道价格统一",
  moderate_control: "适度控价 — 旗舰店与授权店并存，价差可接受",
  price_war: "价格战 — 跨平台价差大，存在渠道冲突风险",
  lax_control: "控价松散 — 大量第三方店铺，价格体系混乱",
  data_insufficient: "数据不足",
};

// ── 即时风险评分 ──────────────────────────────────────────────────

function instantRiskScore(tmProducts, pddProducts) {
  let score = 70;
  const issues = [];

  const strategy = channelStrategy(tmProducts, pddProducts);
  if (strategy === "price_war") { score -= 20; issues.push("跨平台价差过大"); }
  if (strategy === "lax_control") { score -= 12; issues.push("渠道价格体系混乱"); }

  const gap = crossPlatformGap(tmProducts, pddProducts);
  if (gap && gap.ratio < 60) { score -= 15; issues.push("PDD均价不足天猫60%，假货风险高"); }

  const struct = storeStructure([...(tmProducts || []), ...(pddProducts || [])]);
  if (struct && struct.flagshipPct < 20) { score -= 8; issues.push("官方旗舰店占比过低"); }

  const conc = concentration(tmProducts);
  if (conc && conc.cr > 60) { score -= 5; issues.push("头部集中度过高，新品风险大"); }

  return {
    score: Math.max(0, Math.min(100, score)),
    level: score >= 70 ? "健康" : score >= 45 ? "关注" : "预警",
    issues,
  };
}

// ── 综合即时报告 ───────────────────────────────────────────────────

function instantAnalyze(brand, tmProducts, pddProducts, dyProducts, snProducts) {
  const sections = [];

  // Price structure
  const tmTiers = priceTiers(tmProducts);
  if (tmTiers) {
    sections.push({
      title: "天猫价格结构",
      body: `最低 ¥${tmTiers.min} / 中位 ¥${tmTiers.median} / 最高 ¥${tmTiers.max}\n`
          + `价格分层: 入门档 ${tmTiers.tierPct.entry}% | 中端 ${tmTiers.tierPct.mid}% | 高端 ${tmTiers.tierPct.premium}% | 奢侈 ${tmTiers.tierPct.luxury}%\n`
          + `样本量: ${tmTiers.count} 件`,
    });
  }

  const pddTiers = priceTiers(pddProducts);
  if (pddTiers) {
    sections.push({
      title: "拼多多价格结构",
      body: `最低 ¥${pddTiers.min} / 中位 ¥${pddTiers.median} / 最高 ¥${pddTiers.max}\n`
          + `价格分层: 入门档 ${pddTiers.tierPct.entry}% | 中端 ${pddTiers.tierPct.mid}% | 高端 ${pddTiers.tierPct.premium}% | 奢侈 ${pddTiers.tierPct.luxury}%\n`
          + `样本量: ${pddTiers.count} 件`,
    });
  }

  const dyTiers = priceTiers(dyProducts);
  if (dyTiers) {
    sections.push({
      title: "抖音电商价格结构",
      body: `最低 ¥${dyTiers.min} / 中位 ¥${dyTiers.median} / 最高 ¥${dyTiers.max}\n`
          + `价格分层: 入门档 ${dyTiers.tierPct.entry}% | 中端 ${dyTiers.tierPct.mid}% | 高端 ${dyTiers.tierPct.premium}% | 奢侈 ${dyTiers.tierPct.luxury}%\n`
          + `样本量: ${dyTiers.count} 件`,
    });
  }

  const snTiers = priceTiers(snProducts);
  if (snTiers) {
    sections.push({
      title: "苏宁易购价格结构",
      body: `最低 ¥${snTiers.min} / 中位 ¥${snTiers.median} / 最高 ¥${snTiers.max}\n`
          + `价格分层: 入门档 ${snTiers.tierPct.entry}% | 中端 ${snTiers.tierPct.mid}% | 高端 ${snTiers.tierPct.premium}% | 奢侈 ${snTiers.tierPct.luxury}%\n`
          + `样本量: ${snTiers.count} 件`,
    });
  }

  // Cross-platform gap
  const gap = crossPlatformGap(tmProducts, pddProducts);
  if (gap) {
    sections.push({
      title: "跨平台价差",
      body: `天猫均价 ¥${gap.tmAvg} / 拼多多均价 ¥${gap.pddAvg}\n`
          + `价差 ¥${gap.gap} (PDD为天猫的${gap.ratio}%)\n`
          + gap.interpretation,
    });
  }

  // Store structure
  const allProducts = [...(tmProducts || []), ...(pddProducts || []), ...(dyProducts || []), ...(snProducts || [])];
  const struct = storeStructure(allProducts);
  if (struct) {
    sections.push({
      title: "店铺结构",
      body: `旗舰店 ${struct.flagshipPct}% | 授权店 ${Math.round(struct.counts.authorized / (allProducts.length || 1) * 100)}%`
          + ` | 第三方 ${struct.thirdPartyPct}%\n`
          + `旗舰店均价 ¥${struct.flagshipAvgPrice} / 第三方均价 ¥${struct.thirdPartyAvgPrice}`,
    });
  }

  // Concentration (use primary source: TMall > PDD > Douyin)
  const conc = concentration(tmProducts) || concentration(pddProducts) || concentration(dyProducts) || concentration(snProducts);
  if (conc) {
    sections.push({
      title: "头部集中度",
      body: `Top ${conc.topN} 商品占总销量 ${conc.cr}%\n`
          + conc.topProducts.map(p => `  • ${p.name}: ${p.sales}`).join("\n"),
    });
  }

  // Risk score (use TMall + PDD where available, fallback to single platform)
  const risk = instantRiskScore(tmProducts, pddProducts);
  sections.push({
    title: `即时健康评分: ${risk.score}/100 (${risk.level})`,
    body: risk.issues.length > 0
      ? "风险点:\n" + risk.issues.map(i => `  ⚠ ${i}`).join("\n")
      : "首日采集未发现明显风险信号，持续监测以建立趋势基线。",
  });

  const strategy = channelStrategy(tmProducts, pddProducts);
  return {
    brand,
    collectedAt: new Date().toISOString(),
    isInstant: true,
    strategy: { type: strategy, label: CHANNEL_LABELS[strategy] || strategy },
    risk,
    priceTiers: { tm: tmTiers, pdd: pddTiers, dy: dyTiers, sn: snTiers },
    crossPlatformGap: gap,
    storeStructure: struct,
    concentration: conc,
    sections,
  };
}

// ── Helpers ──────────────────────────────────────────────────────

function avgPrice(products) {
  const prices = (products || []).map(p => p.price).filter(v => v > 0);
  if (prices.length === 0) return 0;
  return Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);
}

module.exports = {
  priceTiers,
  storeStructure,
  concentration,
  crossPlatformGap,
  channelStrategy,
  instantRiskScore,
  instantAnalyze,
  CHANNEL_LABELS,
};
