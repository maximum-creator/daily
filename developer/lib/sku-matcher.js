// 跨平台 SKU 匹配引擎
// 核心能力：同一商品在天猫/京东/拼多多/抖音/苏宁/当当之间识别匹配
// 算法：品牌提取 → 型号识别 → 名称Jaccard相似度 → 价格区间交叉验证
// 输出：跨平台比价矩阵 + 匹配置信度

// ── 名称规范化 ──────────────────────────────────────────────────

const BRAND_PATTERNS = [
  /(Nike|耐克|NIKE)/i, /(Adidas|阿迪达斯)/i, /(Puma|彪马)/i,
  /(Converse|匡威)/i, /(New\s*Balance|新百伦|NB)/i,
  /(李宁|Li[-\s]?Ning)/i, /(安踏|ANTA)/i, /(特步|XTEP)/i,
  /(鸿星尔克|ERKE)/i, /(匹克|PEAK)/i, /(回力|Warrior)/i,
  /(华为|HUAWEI|Huawei)/i, /(小米|XIAOMI|Xiaomi)/i,
  /(苹果|Apple)/i, /(三星|SAMSUNG|Samsung)/i,
  /(索尼|SONY|Sony)/i, /(戴森|Dyson)/i, /(飞利浦|Philips)/i,
  /(美的|Midea)/i, /(格力|GREE)/i, /(海尔|Haier)/i,
  /(欧莱雅|L'OREAL|Loreal)/i, /(雅诗兰黛|Estee\s*Lauder)/i,
  /(兰蔻|LANCOME|Lancome)/i, /(SK[-\s]?II|SKII)/i,
  /(花西子|Florasis)/i, /(完美日记|Perfect\s*Diary)/i,
  /(三只松鼠)/i, /(良品铺子)/i, /(百草味)/i,
  /(茅台|MOUTAI|Moutai)/i, /(五粮液|Wuliangye)/i,
  /(蒙牛|Mengniu)/i, /(伊利|Yili)/i,
  /(乐高|LEGO|Lego)/i, /(泡泡玛特|POP\s*MART)/i,
];

function normalizeName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[【】\[\]\(\)（）\{\}""'']/g, " ")
    .replace(/[,，、。．.·:：;；!！?？\-—–\/\\|&@#$%^*+=~`]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ── 型号/货号提取 ───────────────────────────────────────────────

const MODEL_PATTERNS = [
  /([A-Z]{2,6}[\s-]?\d{3,6}[\s-]?\d{0,3})/g,   // CT1264-001, AJ1-001
  /([A-Z]\d{4,6}[A-Z]?)/g,                       // A1466, D8023
  /(\d{4,6}[\s-]\d{3,4})/g,                       // 1264-001
  /(货号|型号|款号|编号)[:：\s]*([A-Za-z0-9\-]+)/g,
  /([A-Z]{1,3}\d{3,5}[A-Z]{0,2})/g,              // X100V, GR3X
];

function extractModelNumbers(name) {
  const models = new Set();
  const cleaned = name.replace(/\s+/g, "");
  for (const pattern of MODEL_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(name)) !== null) {
      const m = (match[2] || match[1] || match[0]).replace(/\s+/g, "").toUpperCase();
      if (m.length >= 4 && m.length <= 20 && !/^\d+$/.test(m)) {
        models.add(m);
      }
    }
  }
  return [...models];
}

// ── 品牌/产品线提取 ─────────────────────────────────────────────

function extractBrand(name) {
  for (const p of BRAND_PATTERNS) {
    if (p.test(name)) {
      return p.source.replace(/\\s\*|\\i|\(|\)|\?/g, "").split("|")[0].replace(/[\\]/g, "");
    }
  }
  return null;
}

// ── 核心词提取 ──────────────────────────────────────────────────

const STOP_WORDS = new Set([
  "男", "女", "童", "儿童", "成人", "新款", "正品", "专柜", "官方", "旗舰",
  "店", "包邮", "现货", "促销", "特价", "清仓", "限时", "折扣", "优惠",
  "2024", "2025", "2026", "春夏", "秋冬", "夏季", "冬季", "春季", "秋季",
  "款", "式", "颜色", "尺码", "大小", "图片", "实拍", "视频",
  "the", "a", "an", "is", "are", "for", "with", "and", "or", "in", "on", "of", "to",
  "新", "品", "热卖", "爆款", "推荐", "品质", "高端", "奢侈", "轻奢",
]);

function extractCoreWords(name) {
  return normalizeName(name)
    .split(" ")
    .filter(w => w.length >= 2 && !STOP_WORDS.has(w))
    .map(w => w.replace(/[0-9]+/g, "").trim())
    .filter(w => w.length >= 2);
}

// ── Jaccard 相似度 ──────────────────────────────────────────────

function jaccardSimilarity(wordsA, wordsB) {
  const setA = new Set(wordsA);
  const setB = new Set(wordsB);
  if (setA.size === 0 && setB.size === 0) return 0;
  let intersection = 0;
  for (const w of setA) {
    if (setB.has(w)) intersection++;
  }
  return Math.round(intersection / (setA.size + setB.size - intersection) * 100) / 100;
}

// ── 价格接近度 ──────────────────────────────────────────────────

function priceProximity(priceA, priceB) {
  if (!priceA || !priceB || priceA <= 0 || priceB <= 0) return 0;
  const ratio = Math.min(priceA, priceB) / Math.max(priceA, priceB);
  return Math.round(ratio * 100) / 100;
}

// ── 单对匹配 ────────────────────────────────────────────────────

function matchPair(productA, productB) {
  const normA = normalizeName(productA.name);
  const normB = normalizeName(productB.name);

  // Model number match — highest signal
  const modelsA = extractModelNumbers(productA.name);
  const modelsB = extractModelNumbers(productB.name);
  let modelMatch = false;
  let modelConfidence = 0;
  if (modelsA.length > 0 && modelsB.length > 0) {
    const common = modelsA.filter(m => modelsB.includes(m));
    if (common.length > 0) {
      modelMatch = true;
      modelConfidence = Math.min(1, common.length / Math.min(modelsA.length, modelsB.length));
    }
  }

  // Core word Jaccard
  const wordsA = extractCoreWords(productA.name);
  const wordsB = extractCoreWords(productB.name);
  const jaccard = jaccardSimilarity(wordsA, wordsB);

  // Price proximity
  const priceProx = priceProximity(productA.price, productB.price);

  // Composite score
  let score = 0;
  if (modelMatch) {
    score = 0.5 + modelConfidence * 0.3 + jaccard * 0.15 + priceProx * 0.05;
  } else {
    score = jaccard * 0.6 + priceProx * 0.3 + 0.1;
  }
  score = Math.round(Math.min(1, score) * 100) / 100;

  return {
    score,
    match: score >= 0.45,
    confidence: score >= 0.75 ? "high" : score >= 0.55 ? "medium" : "low",
    modelMatch,
    jaccard: Math.round(jaccard * 100) / 100,
    priceProx: Math.round(priceProx * 100) / 100,
    details: {
      modelsA, modelsB,
      commonWords: wordsA.filter(w => wordsB.includes(w)).slice(0, 8),
    },
  };
}

// ── 跨平台产品匹配矩阵 ──────────────────────────────────────────

function crossPlatformMatrix(snapshots) {
  const platforms = Object.entries(snapshots).filter(([, s]) => s && s.products?.length > 0);
  if (platforms.length < 2) return { matches: [], summary: "需要至少2个有数据的平台" };

  const allProducts = [];
  for (const [platform, snap] of platforms) {
    for (const p of snap.products || []) {
      allProducts.push({ ...p, _platform: platform });
    }
  }

  // Build match groups using greedy clustering
  const matchGroups = [];
  const used = new Set();

  for (let i = 0; i < allProducts.length; i++) {
    if (used.has(i)) continue;
    const group = [allProducts[i]];
    used.add(i);

    for (let j = i + 1; j < allProducts.length; j++) {
      if (used.has(j)) continue;
      if (allProducts[j]._platform === allProducts[i]._platform) continue;

      // Check if product j matches any product already in group
      let bestMatch = 0;
      for (const g of group) {
        const m = matchPair(g, allProducts[j]);
        if (m.score > bestMatch) bestMatch = m.score;
      }

      if (bestMatch >= 0.45) {
        group.push(allProducts[j]);
        used.add(j);
      }
    }

    if (group.length >= 2) {
      // Calculate group price stats
      const prices = group.filter(p => p.price > 0).map(p => ({ platform: p._platform, price: p.price, name: p.name?.slice(0, 60) }));
      const validPrices = prices.map(p => p.price);
      const minPrice = Math.min(...validPrices);
      const maxPrice = Math.max(...validPrices);
      const spread = maxPrice > 0 ? Math.round((maxPrice - minPrice) / minPrice * 100) : 0;

      matchGroups.push({
        products: group.map(p => ({
          platform: p._platform,
          name: p.name?.slice(0, 80),
          price: p.price,
          priceDisplay: p.priceDisplay || String(p.price),
          shop: p.shop?.slice(0, 30),
          storeType: p.storeType,
          goodsId: p.goodsId,
        })),
        platformCount: [...new Set(group.map(p => p._platform))].length,
        platforms: [...new Set(group.map(p => p._platform))],
        priceRange: { min: minPrice, max: maxPrice, spread: spread + "%" },
        bestDeal: { platform: prices.sort((a, b) => a.price - b.price)[0]?.platform, price: minPrice },
      });
    }
  }

  // Summary stats
  const productsPerPlatform = {};
  for (const [platform, snap] of platforms) {
    productsPerPlatform[platform] = snap.productCount;
  }

  return {
    matches: matchGroups.sort((a, b) => b.platformCount - a.platformCount),
    totalMatches: matchGroups.length,
    multiPlatformMatches: matchGroups.filter(g => g.platformCount >= 3).length,
    productsPerPlatform,
    topDeals: matchGroups.slice(0, 10).map(g => ({
      name: g.products[0]?.name?.slice(0, 50),
      bestDeal: g.bestDeal,
      spread: g.priceRange.spread,
      platforms: g.platforms,
    })),
  };
}

// ── 比价简报 ────────────────────────────────────────────────────

function priceComparisonBrief(matrix) {
  if (!matrix || matrix.matches?.length === 0) {
    return { headline: "未发现跨平台匹配商品", sections: [] };
  }

  const sections = [];
  const byPlatformCount = {};
  for (const m of matrix.matches) {
    const k = m.platformCount;
    byPlatformCount[k] = (byPlatformCount[k] || 0) + 1;
  }

  let headline = `发现 ${matrix.totalMatches} 组跨平台匹配商品`;
  if (matrix.multiPlatformMatches > 0) {
    headline += `，其中 ${matrix.multiPlatformMatches} 组在3个以上平台同时出现`;
  }

  sections.push({
    title: "跨平台覆盖度",
    body: Object.entries(byPlatformCount)
      .sort(([a], [b]) => Number(b) - Number(a))
      .map(([cnt, n]) => `${cnt}平台匹配: ${n} 组`)
      .join("\n"),
  });

  // Top price arbitrage opportunities
  const arbitrage = matrix.matches
    .filter(m => m.platformCount >= 2)
    .sort((a, b) => {
      const spreadA = parseInt(a.priceRange.spread) || 0;
      const spreadB = parseInt(b.priceRange.spread) || 0;
      return spreadB - spreadA;
    })
    .slice(0, 5);

  if (arbitrage.length > 0) {
    sections.push({
      title: "价差最大的跨平台商品",
      body: arbitrage.map(m =>
        `"${m.products[0]?.name?.slice(0, 40)}..."\n` +
        `  平台: ${m.platforms.join(" + ")} | 价差: ${m.priceRange.spread}\n` +
        `  最低: ¥${m.priceRange.min} (${m.bestDeal.platform}) | 最高: ¥${m.priceRange.max}`
      ).join("\n\n"),
    });
  }

  return { headline, sections };
}

module.exports = {
  normalizeName,
  extractModelNumbers,
  extractBrand,
  extractCoreWords,
  jaccardSimilarity,
  priceProximity,
  matchPair,
  crossPlatformMatrix,
  priceComparisonBrief,
};
