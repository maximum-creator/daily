// 抖音电商竞品采集器 — 品牌商品监控
// 策略：SPA inline JSON（window.__INITIAL_STATE__ / __NUXT__）优先 → DOM 回退
// 抖音商城 web 版（mall.douyin.com），通常无需登录即可搜索

const fs = require("fs");
const path = require("path");
const { normalizeName, localISO, today, sanitize, parsePrice, parseSales, classifyStore } = require("./utils");

// ── JSON 数据提取 ────────────────────────────────────────────────

function extractFromDyJson(data) {
  const results = [];
  if (!data || typeof data !== "object") return results;

  const items = findArrayWith(data, "price") ||
                findArrayWith(data, "productId") ||
                findArrayWith(data, "spuId") ||
                data?.data?.items ||
                data?.items ||
                data?.result?.items ||
                data?.data?.list ||
                data?.list ||
                [];
  if (!Array.isArray(items)) return results;

  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const name = (item.title || item.name || item.productName || item.goodsName || "").trim();
    if (!name || name.length < 3) continue;
    results.push({
      name,
      price: String(item.price || item.salePrice || item.displayPrice || item.minPrice || ""),
      sales: String(item.sales || item.soldCount || item.sellCount || item.salesVolume || ""),
      shop: (item.shopName || item.storeName || item.sellerName || item.shop || "").trim(),
      goodsId: String(item.productId || item.spuId || item.id || item.goodsId || ""),
      imgSrc: (item.image || item.cover || item.thumb || item.img || ""),
    });
  }
  return results;
}

function findArrayWith(obj, key) {
  if (!obj || typeof obj !== "object") return null;
  if (Array.isArray(obj) && obj.length > 0 && typeof obj[0] === "object") {
    if (obj[0][key] !== undefined) return obj;
  }
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (Array.isArray(v) && v.length > 0 && typeof v[0] === "object") {
      if (v[0][key] !== undefined) return v;
    }
    if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      const found = findArrayWith(v, key);
      if (found) return found;
    }
  }
  return null;
}

// ── 搜索抖音商品 ──────────────────────────────────────────────

async function searchDouyinProducts(page, brandName, maxPages = 1) {
  const allProducts = [];

  // Switch to mobile viewport for Douyin mall
  const origViewport = page.viewportSize();
  try {
    await page.setViewportSize({ width: 414, height: 896 });
  } catch (e) { /* may fail */ }

  // Intercept XHR responses to capture Douyin's internal search API data
  const apiProducts = [];
  const onResponse = async (response) => {
    const url = response.url();
    // Douyin search API patterns
    if (url.includes("douyin.com") && (url.includes("search") || url.includes("product") || url.includes("goods") || url.includes("item"))) {
      try {
        const ct = response.headers()["content-type"] || "";
        if (ct.includes("json")) {
          const data = await response.json();
          const extracted = extractFromDyJson(data);
          if (extracted.length > 0) apiProducts.push(...extracted);
        }
      } catch (e) { /* ignore parse errors */ }
    }
  };
  page.on("response", onResponse);

  for (let pg = 1; pg <= maxPages; pg++) {
    // Primary: mall.douyin.com (e-commerce specific)
    let searchUrl = `https://mall.douyin.com/search?keyword=${encodeURIComponent(brandName)}&page=${pg}`;
    let usedFallback = false;

    const tryNavigate = async (url, label) => {
      try {
        await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
        return true;
      } catch (e) {
        console.log(`[douyin] pg${pg} ${label} 导航失败: ${e.message}`);
        return false;
      }
    };

    if (!(await tryNavigate(searchUrl, "mall"))) {
      // Fallback URL per Qwen suggestion
      if (pg === 1) {
        // Fallback 1: douyin.com general search
        searchUrl = `https://www.douyin.com/search/${encodeURIComponent(brandName)}?aid=6383&type=general`;
        console.log(`[douyin] pg${pg} 尝试备选URL: douyin.com`);
        if (!(await tryNavigate(searchUrl, "douyin.com"))) {
          // Fallback 2: mobile goods search
          searchUrl = `https://www.douyin.com/search/${encodeURIComponent(brandName + " 商品")}?type=goods`;
          console.log(`[douyin] pg${pg} 尝试备选: douyin goods`);
          if (!(await tryNavigate(searchUrl, "goods"))) break;
        }
        usedFallback = true;
      } else {
        break;
      }
    }

    const currentUrl = page.url();
    const pageTitle = await page.title().catch(() => "");
    console.log(`[douyin] pg${pg} ${currentUrl.slice(0, 100)} | ${pageTitle.slice(0, 60)}`);

    // Anti-bot check
    const pageState = await detectDouyinPageState(page);
    if (pageState.blocked) {
      console.log(`[douyin] 检测到${pageState.reason} — 停止采集`);
      break;
    }

    // Wait for SPA to render — Douyin loads products via JS after initial shell
    // Try to detect when real product data is available in the DOM or JS state
    const dataReady = await page.waitForFunction(() => {
      // Check for inline JSON data first
      const state = window.__INITIAL_STATE__ || window.__NUXT__ || window.__DATA__ || window.__SSR_DATA__;
      if (state) {
        const items = state?.searchResult?.items
          || state?.search?.result?.items
          || state?.data?.searchResult
          || state?.result?.items
          || state?.products
          || state?.goodsList;
        if (items && items.length > 0) return true;
      }
      // Fallback: check if product cards have rendered in DOM
      const cards = document.querySelectorAll("[data-spu-id], .product-card, [class*='productCard'], [class*='goodsCard']");
      if (cards.length >= 3) return true;
      // Check body text has meaningful price data (not the empty shell)
      const body = document.body?.innerText || "";
      if (body.length > 1000 && body.includes("¥")) return true;
      return false;
    }, { timeout: 15000 }).catch(() => false);

    if (!dataReady) {
      console.log(`[douyin] pg${pg} SPA数据未就绪，额外等待...`);
      // Check for fake/placeholder shell data (common anti-bot response)
      const bodyLen = await page.evaluate(() => document.body?.innerText?.length || 0).catch(() => 0);
      console.log(`[douyin] pg${pg} 页面内容长度: ${bodyLen} 字符`);
      if (bodyLen < 500) {
        console.log(`[douyin] pg${pg} ⚠ 检测到疑似占位壳（${bodyLen}字符），数据可能未加载。建议使用headed模式或登录cookie。`);
      }
    }
    await page.waitForTimeout(2000);

    // Scroll for lazy loading
    await page.evaluate(async () => {
      for (let y = 200; y < 3000; y += 400) {
        window.scrollTo(0, y);
        await new Promise(r => setTimeout(r, 150));
      }
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(2000);

    // Strategy A: Inline JSON from SSR/SPA state
    const inlineProducts = await page.evaluate(() => {
      try {
        const state = window.__INITIAL_STATE__ || window.__NUXT__ || window.__DATA__ || window.__SSR_DATA__ || window.SSR_DATA;
        if (!state) return [];

        // Broad search for product arrays — Douyin nests data differently per page version
        let items = state?.searchResult?.items
          || state?.search?.result?.items
          || state?.data?.searchResult
          || state?.result?.items
          || state?.products
          || state?.goodsList
          || state?.state?.search?.result?.items
          || state?.state?.searchResult?.items;

        // Deep search: walk the state tree for arrays containing price/title fields
        if (!items || !Array.isArray(items) || items.length === 0) {
          const walk = (obj, depth) => {
            if (!obj || typeof obj !== "object" || depth > 6) return null;
            for (const k of Object.keys(obj)) {
              const v = obj[k];
              if (Array.isArray(v) && v.length >= 2 && v[0] && typeof v[0] === "object") {
                if (v[0].price !== undefined || v[0].title || v[0].productName) return v;
              }
              if (typeof v === "object" && v !== null) {
                const found = walk(v, depth + 1);
                if (found) return found;
              }
            }
            return null;
          };
          items = walk(state, 0) || [];
        }

        if (!Array.isArray(items) || items.length === 0) return [];
        return items.map(item => ({
          name: (item.title || item.name || item.productName || item.goodsName || "").trim(),
          price: String(item.price || item.salePrice || item.displayPrice || item.minPrice || ""),
          sales: String(item.sales || item.soldCount || item.sellCount || item.salesVolume || ""),
          shop: (item.shopName || item.storeName || item.sellerName || item.shop || "").trim(),
          goodsId: String(item.productId || item.spuId || item.id || item.goodsId || ""),
          imgSrc: (item.image || item.cover || item.thumb || item.img || ""),
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

    // Strategy B: DOM extraction (improved selectors)
    const domProducts = await page.evaluate(() => {
      const results = [];
      const seen = new Set();

      // Broader selector set for Douyin's dynamic class names
      const selectors = [
        "[data-spu-id]", "[data-product-id]", "[data-item-id]",
        ".product-card", ".search-result-item", ".goods-card",
        "[class*='product']", "[class*='goods']", "[class*='card']",
        "a[href*='product']", "a[href*='goods']",
        "[class*='search'] [class*='item']",
        "li[class*='result']",
      ];

      for (const sel of selectors) {
        const items = document.querySelectorAll(sel);
        if (items.length === 0) continue;
        items.forEach(item => {
          const text = (item.textContent || "").trim();
          if (text.length < 12 || text.length > 600) return;
          // Must contain price indicator
          if (!/¥|￥|\d+\.?\d*/.test(text)) return;

          const key = text.replace(/\s+/g, "").slice(0, 40);
          if (seen.has(key)) return;
          seen.add(key);

          const priceMatch = text.match(/[¥￥]\s*([\d.]+)/);
          const price = priceMatch ? priceMatch[1] : "";
          const priceIdx = text.indexOf("¥") >= 0 ? text.indexOf("¥") : text.indexOf("￥");
          const name = priceIdx > 0 ? text.substring(0, priceIdx).trim().slice(0, 120) : text.slice(0, 80);
          const salesMatch = text.match(/([\d.]+万?)\s*(已售|销售|卖出|件|人)/);
          const soldMatch = text.match(/已售\s*(\d+\.?\d*万?)/);

          const nameEl = item.querySelector(".title, .name, [class*='title'], [class*='name'], h3, h4");
          const priceEl = item.querySelector("[class*='price'], .price, .amount");
          const shopEl = item.querySelector("[class*='shop'], [class*='store'], [class*='seller']");

          results.push({
            name: (nameEl?.textContent || name).trim().slice(0, 120),
            price: (priceEl?.textContent || price || "").replace(/[¥￥]/g, "").trim(),
            sales: soldMatch ? soldMatch[1] : (salesMatch ? salesMatch[1] : ""),
            shop: (shopEl?.textContent || "").trim(),
            goodsId: item.getAttribute?.("data-spu-id") || item.getAttribute?.("data-id") || item.getAttribute?.("data-product-id") || "",
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

  // Clean up response listener
  page.off("response", onResponse);

  // Restore original viewport
  if (origViewport) {
    try {
      await page.setViewportSize(origViewport);
    } catch (e) { /* ignore */ }
  }

  // Merge API-captured products (may be richer than inline/DOM)
  if (apiProducts.length > allProducts.length) {
    console.log(`[douyin] API拦截获得 ${apiProducts.length} 个商品 (优于inline/DOM的 ${allProducts.length})`);
    const seen = new Set();
    return apiProducts.filter(r => {
      const key = (r.name || "").replace(/\s+/g, "").slice(0, 40);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
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
