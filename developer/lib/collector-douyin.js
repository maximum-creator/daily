// 抖音电商竞品采集器 — 品牌商品监控
// 策略：SPA inline JSON（window.__INITIAL_STATE__ / __NUXT__）优先 → DOM 回退
// 抖音商城 web 版（mall.douyin.com），通常无需登录即可搜索

const fs = require("fs");
const path = require("path");
const { normalizeName, localISO, today, sanitize, parsePrice, parseSales, classifyStore } = require("./utils");

// ── 搜索抖音商品 ──────────────────────────────────────────────

async function searchDouyinProducts(page, brandName, maxPages = 1) {
  const allProducts = [];

  for (let pg = 1; pg <= maxPages; pg++) {
    const searchUrl = `https://mall.douyin.com/search?keyword=${encodeURIComponent(brandName)}&page=${pg}`;

    try {
      await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    } catch (e) {
      console.log(`[douyin] pg${pg} 导航失败: ${e.message}`);
      break;
    }

    await page.waitForTimeout(4000 + Math.random() * 2000);

    const currentUrl = page.url();
    const pageTitle = await page.title().catch(() => "");
    console.log(`[douyin] pg${pg} ${currentUrl.slice(0, 100)} | ${pageTitle.slice(0, 60)}`);

    // Anti-bot check
    const pageState = await detectDouyinPageState(page);
    if (pageState.blocked) {
      console.log(`[douyin] 检测到${pageState.reason} — 停止采集`);
      break;
    }

    // Scroll for lazy loading
    await page.evaluate(async () => {
      for (let y = 200; y < 3000; y += 400) {
        window.scrollTo(0, y);
        await new Promise(r => setTimeout(r, 150));
      }
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(2000);

    // Strategy A: Inline JSON from SSR (Nuxt/initial state)
    const inlineProducts = await page.evaluate(() => {
      try {
        // Try various Douyin SSR data paths
        const state = window.__INITIAL_STATE__ || window.__NUXT__ || window.__DATA__;
        if (!state) return [];
        const items = state?.searchResult?.items
          || state?.search?.result?.items
          || state?.data?.searchResult
          || state?.result?.items
          || state?.products
          || state?.goodsList
          || [];
        if (!Array.isArray(items) || items.length === 0) return [];
        return items.map(item => ({
          name: (item.title || item.name || item.productName || "").trim(),
          price: String(item.price || item.salePrice || item.displayPrice || ""),
          sales: String(item.sales || item.soldCount || item.sellCount || ""),
          shop: (item.shopName || item.storeName || item.sellerName || "").trim(),
          goodsId: String(item.productId || item.spuId || item.id || ""),
          imgSrc: (item.image || item.cover || item.thumb || ""),
        }));
      } catch (e) { return []; }
    });

    if (inlineProducts.length > 0) {
      console.log(`[douyin] pg${pg} inline JSON: ${inlineProducts.length} 个商品`);
      allProducts.push(...inlineProducts);
      if (inlineProducts.length < 20) break;
      await page.waitForTimeout(1500 + Math.random() * 1500);
      continue;
    }

    // Strategy B: DOM extraction
    const domProducts = await page.evaluate(() => {
      const results = [];
      const seen = new Set();

      const selectors = [
        "[data-spu-id]", ".product-card", ".search-result-item",
        ".goods-card", "[class*='product']", "[class*='goods']",
        ".card-item", "a[href*='product']",
      ];

      for (const sel of selectors) {
        const items = document.querySelectorAll(sel);
        if (items.length === 0) continue;
        items.forEach(item => {
          const text = (item.textContent || "").trim();
          if (text.length < 15 || text.length > 500) return;
          if (!/¥|￥|\d+\.?\d*/.test(text)) return;

          const key = text.replace(/\s+/g, "").slice(0, 40);
          if (seen.has(key)) return;
          seen.add(key);

          const priceMatch = text.match(/[¥￥]\s*([\d.]+)/);
          const price = priceMatch ? priceMatch[1] : "";
          const priceIdx = text.indexOf("¥") >= 0 ? text.indexOf("¥") : text.indexOf("￥");
          const name = priceIdx > 0 ? text.substring(0, priceIdx).trim().slice(0, 120) : text.slice(0, 80);
          const salesMatch = text.match(/([\d.]+万?)\s*(已售|销售|卖出|件)/);

          const nameEl = item.querySelector(".title, .name, [class*='title'], [class*='name'], h3, h4");
          const priceEl = item.querySelector("[class*='price'], .price, .amount");
          const shopEl = item.querySelector("[class*='shop'], [class*='store'], [class*='seller']");

          results.push({
            name: (nameEl?.textContent || name).trim().slice(0, 120),
            price: (priceEl?.textContent || price || "").replace(/[¥￥]/g, "").trim(),
            sales: salesMatch ? salesMatch[1] : "",
            shop: (shopEl?.textContent || "").trim(),
            goodsId: item.getAttribute?.("data-spu-id") || item.getAttribute?.("data-id") || "",
            imgSrc: "",
          });
        });
        if (results.length >= 5) break;
      }

      return results;
    });

    console.log(`[douyin] pg${pg} DOM提取: ${domProducts.length} 个商品`);
    allProducts.push(...domProducts);
    if (domProducts.length < 20) break;
    await page.waitForTimeout(1500 + Math.random() * 1500);
  }

  // Deduplicate
  const seen = new Set();
  return allProducts.filter(r => {
    const key = (r.name || "").replace(/\s+/g, "").slice(0, 40);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── 页面状态检测 ─────────────────────────────────────────────────

async function detectDouyinPageState(page) {
  return page.evaluate(() => {
    const text = document.body?.innerText || "";
    const url = location.href || "";

    if (url.includes("login") || url.includes("passport") || url.includes("verify"))
      return { blocked: true, reason: "login_wall", detail: "需要登录抖音" };

    if (text.includes("验证") && (text.includes("滑块") || text.includes("拼图") || text.includes("点击")))
      return { blocked: true, reason: "captcha", detail: "触发抖音反爬验证" };

    if (text.includes("访问频繁") || text.includes("稍后再试") || text.includes("网络异常"))
      return { blocked: true, reason: "rate_limit", detail: "抖音限流" };

    return { blocked: false };
  });
}

// ── 采集品牌快照 ───────────────────────────────────────────────────

async function collectBrandSnapshot(page, brandName) {
  const products = (await searchDouyinProducts(page, brandName)) || [];

  const cleaned = products.map(p => ({
    name: String(p.name || ""),
    price: parsePrice(p.price),
    priceDisplay: String(p.price || ""),
    sales: parseSales(p.sales),
    salesDisplay: String(p.sales || ""),
    shop: String(p.shop || ""),
    goodsId: String(p.goodsId || ""),
    storeType: classifyStore(p.shop),
  }));

  const validPrices = cleaned.map(p => p.price).filter(v => v > 0);

  return {
    collectedAt: localISO(),
    brand: brandName,
    source: "douyin",
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
        title: `[抖音] 新品上架: ${tp.name}`,
        detail: `价格 ¥${tp.price}，${tp.salesDisplay || "暂无销量"}`,
        source: "douyin",
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
        title: `[抖音] ${pct > 0 ? "涨价" : "降价"}: ${tp.name}`,
        detail: `¥${yp.price} → ¥${tp.price} (${pct > 0 ? "+" : ""}${pct}%)`,
        source: "douyin",
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
        title: `[抖音] 商品下架: ${yp.name}`,
        detail: `原价 ¥${yp.price}`,
        source: "douyin",
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
  const fp = path.join(brandDir, `snapshot-douyin-${today()}.json`);
  fs.writeFileSync(fp, JSON.stringify(snapshot, null, 2));
  return fp;
}

function loadSnapshot(dataDir, tenantId, brandName, date) {
  const fp = path.join(dataDir, tenantId, sanitize(brandName), `snapshot-douyin-${date}.json`);
  if (!fs.existsSync(fp)) return null;
  try { return JSON.parse(fs.readFileSync(fp, "utf-8")); } catch (e) { return null; }
}

module.exports = {
  searchDouyinProducts,
  collectBrandSnapshot,
  compareSnapshots,
  detectDouyinPageState,
  saveSnapshot,
  loadSnapshot,
  today,
  localISO,
};
