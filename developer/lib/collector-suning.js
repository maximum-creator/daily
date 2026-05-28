// 苏宁易购竞品采集器 — 品牌商品监控
// 策略：DOM 提取（苏宁搜索页是 SSR，无头模式可用）
// 数据质量：产品名 + 到手价 + 评价数 + 店铺（自营/第三方）
// 搜索 URL: https://search.suning.com/{keyword}/

const fs = require("fs");
const path = require("path");
const { normalizeName, localISO, today, sanitize, parsePrice, parseSales, classifyStore } = require("./utils");

// ── 搜索苏宁商品 ──────────────────────────────────────────────

async function searchSuningProducts(page, brandName, maxPages = 2) {
  const allProducts = [];

  for (let pg = 0; pg < maxPages; pg++) {
    // Suning pagination: iy=0 is page 1, iy=60 is page 2, etc.
    const offset = pg * 60;
    const searchUrl = pg === 0
      ? `https://search.suning.com/${encodeURIComponent(brandName)}/`
      : `https://search.suning.com/${encodeURIComponent(brandName)}/&iy=${offset}`;

    try {
      await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 25000 });
    } catch (e) {
      console.log(`[suning] pg${pg + 1} 导航失败: ${e.message}`);
      break;
    }

    await page.waitForTimeout(3000 + Math.random() * 2000);

    const currentUrl = page.url();
    const pageTitle = await page.title().catch(() => "");
    console.log(`[suning] pg${pg + 1} ${currentUrl.slice(0, 100)} | ${pageTitle.slice(0, 60)}`);

    // Anti-bot check
    const pageState = await detectSuningPageState(page);
    if (pageState.blocked) {
      console.log(`[suning] 检测到${pageState.reason} — 停止采集`);
      break;
    }

    // Scroll for lazy loading
    await page.evaluate(async () => {
      for (let y = 300; y < 2500; y += 500) {
        window.scrollTo(0, y);
        await new Promise(r => setTimeout(r, 200));
      }
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(1000);

    // Extract products from li.item-wrap cards
    const products = await page.evaluate(() => {
      const results = [];
      const seen = new Set();

      const items = document.querySelectorAll("li.item-wrap");
      if (items.length === 0) return [];

      items.forEach(item => {
        const text = (item.textContent || "").trim().replace(/\s+/g, " ");
        if (text.length < 20) return;

        // Deduplicate by first 50 chars of text
        const key = text.slice(0, 50);
        if (seen.has(key)) return;
        seen.add(key);

        // Price: "¥460.00到手价"
        const priceMatch = text.match(/¥\s*([\d.]+)/);
        const price = priceMatch ? priceMatch[1] : "";

        // Name: text between price area and the description/features
        let name = "";
        const nameEl = item.querySelector(".title, [class*='title'], [class*='name'], .info-title");
        if (nameEl) {
          name = (nameEl.textContent || "").trim();
        }
        if (!name) {
          // Extract name from combined text: after "到手价" and before "评价"
          const afterPrice = text.indexOf("到手价");
          const beforeReview = text.indexOf("评价");
          if (afterPrice >= 0 && beforeReview > afterPrice) {
            name = text.slice(afterPrice + 3, beforeReview).trim();
          } else if (afterPrice >= 0) {
            name = text.slice(afterPrice + 3).trim().slice(0, 80);
          }
        }
        // Clean name — remove feature descriptors after the first clear break
        const cleanName = name.replace(/\s*新浪微博.*$/, "").trim();

        // Reviews
        const reviewMatch = text.match(/(\d+)\s*评价/);
        const reviews = reviewMatch ? reviewMatch[1] : "";

        // Store
        const storeMatch = text.match(/(苏宁自营|.{2,8}专营店|.{2,8}旗舰店|.{2,8}专卖店)/);
        const shop = storeMatch ? storeMatch[1] : "";

        // Product URL
        const linkEl = item.querySelector("a[href*='product.suning.com']");
        const linkUrl = linkEl?.getAttribute("href") || "";

        // Image
        const imgEl = item.querySelector("img");
        const imgSrc = imgEl?.getAttribute("src") || imgEl?.getAttribute("data-src") || "";

        results.push({
          name: cleanName.slice(0, 150),
          price,
          sales: 0,
          reviews: parseInt(reviews, 10) || 0,
          reviewsDisplay: reviews ? `${reviews}评价` : "",
          shop: shop || "未识别",
          goodsId: "",
          imgSrc,
          linkUrl,
        });
      });

      return results;
    });

    console.log(`[suning] pg${pg + 1} 提取: ${products.length} 个商品`);
    allProducts.push(...products);
    if (products.length < 20) break;
    await page.waitForTimeout(1500 + Math.random() * 1500);
  }

  // Deduplicate
  const seen = new Set();
  return allProducts.filter(r => {
    const key = (r.name || "").replace(/\s+/g, "").slice(0, 50);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── 页面状态检测 ─────────────────────────────────────────────────

async function detectSuningPageState(page) {
  return page.evaluate(() => {
    const text = document.body?.innerText || "";
    const url = location.href || "";

    if (url.includes("login") || url.includes("passport"))
      return { blocked: true, reason: "login_wall", detail: "需要登录苏宁" };

    if (text.includes("验证") && (text.includes("滑块") || text.includes("拼图")))
      return { blocked: true, reason: "captcha", detail: "触发苏宁反爬验证" };

    if (text.includes("访问太频繁") || text.includes("稍后再试"))
      return { blocked: true, reason: "rate_limit", detail: "苏宁限流" };

    // No results
    if (text.includes("没有找到") && text.includes("商品"))
      return { blocked: false, noResults: true };

    return { blocked: false };
  });
}

// ── 采集品牌快照 ───────────────────────────────────────────────────

async function collectBrandSnapshot(page, brandName) {
  const products = (await searchSuningProducts(page, brandName)) || [];

  const cleaned = products.map(p => ({
    name: String(p.name || ""),
    price: parsePrice(p.price),
    priceDisplay: String(p.price || ""),
    sales: parseSales(String(p.reviews || "")),
    salesDisplay: String(p.reviewsDisplay || ""),
    shop: String(p.shop || ""),
    goodsId: String(p.goodsId || ""),
    storeType: classifyStore(p.shop),
  }));

  const validPrices = cleaned.map(p => p.price).filter(v => v > 0);

  return {
    collectedAt: localISO(),
    brand: brandName,
    source: "suning",
    productCount: cleaned.length,
    products: cleaned,
    priceRange: {
      min: validPrices.length > 0 ? Math.min(...validPrices) : 0,
      max: validPrices.length > 0 ? Math.max(...validPrices) : 0,
      avg: validPrices.length > 0 ? Math.round(validPrices.reduce((a, b) => a + b, 0) / validPrices.length) : 0,
    },
  };
}

// ── 对比昨日快照 → 信号 ──────────────────────────────────────────

function compareSnapshots(today, yesterday) {
  if (!yesterday) return { signals: [], isNew: true };

  const signals = [];
  const todayProducts = today.products || [];
  const yesterdayProducts = yesterday.products || [];

  const todayMap = new Map(todayProducts.map(p => [normalizeName(p.name), p]));
  const yesterdayMap = new Map(yesterdayProducts.map(p => [normalizeName(p.name), p]));

  for (const [name, tp] of todayMap) {
    const yp = yesterdayMap.get(name);
    if (!yp) {
      signals.push({
        type: "new_product",
        severity: "medium",
        title: `[苏宁] 新品上架: ${tp.name}`,
        detail: `价格 ¥${tp.price}，${tp.salesDisplay || "暂无评价"}`,
        source: "suning",
        product: tp,
      });
      continue;
    }
    if (tp.price > 0 && yp.price > 0 && tp.price !== yp.price) {
      const change = tp.price - yp.price;
      const pct = yp.price > 0 ? Math.round(change / yp.price * 100) : 0;
      signals.push({
        type: "price_change",
        severity: Math.abs(pct) > 20 ? "high" : "medium",
        title: `[苏宁] ${pct > 0 ? "涨价" : "降价"}: ${tp.name}`,
        detail: `¥${yp.price} → ¥${tp.price} (${pct > 0 ? "+" : ""}${pct}%)`,
        source: "suning",
        product: tp,
        oldPrice: yp.price, newPrice: tp.price, changePct: pct,
      });
    }
  }

  for (const [name, yp] of yesterdayMap) {
    if (!todayMap.has(name)) {
      signals.push({
        type: "delisted",
        severity: "medium",
        title: `[苏宁] 商品下架: ${yp.name}`,
        detail: `原价 ¥${yp.price}`,
        source: "suning",
        product: yp,
      });
    }
  }

  return { signals, isNew: false };
}

// ── Persistence ──────────────────────────────────────────────────

function saveSnapshot(dataDir, tenantId, brandName, snapshot) {
  const brandDir = path.join(dataDir, tenantId, sanitize(brandName));
  if (!fs.existsSync(brandDir)) fs.mkdirSync(brandDir, { recursive: true });
  const fp = path.join(brandDir, `snapshot-suning-${today()}.json`);
  fs.writeFileSync(fp, JSON.stringify(snapshot, null, 2));
  return fp;
}

function loadSnapshot(dataDir, tenantId, brandName, date) {
  const fp = path.join(dataDir, tenantId, sanitize(brandName), `snapshot-suning-${date}.json`);
  if (!fs.existsSync(fp)) return null;
  try { return JSON.parse(fs.readFileSync(fp, "utf-8")); } catch (e) { return null; }
}

module.exports = {
  searchSuningProducts,
  collectBrandSnapshot,
  compareSnapshots,
  detectSuningPageState,
  saveSnapshot,
  loadSnapshot,
  today,
  localISO,
};
