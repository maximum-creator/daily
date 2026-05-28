// 拼多多竞品采集器 — 品牌商品监控
// 策略：移动站 inline JSON（window.rawData）优先 → DOM 回退
// 拼多多反爬较严，不做登录验证（大部分搜索无需登录）

const fs = require("fs");
const path = require("path");

// ── 搜索拼多多商品 ──────────────────────────────────────────────

async function searchPddProducts(page, brandName, maxPages = 1) {
  const allProducts = [];

  // Intercept API responses for product data
  const apiProducts = [];
  const onResponse = (response) => {
    const url = response.url();
    if (url.includes("yangkeduo.com") && (url.includes("search") || url.includes("api"))) {
      response.json().then(data => {
        const extracted = extractFromPddJson(data);
        if (extracted.length > 0) apiProducts.push(...extracted);
      }).catch(() => {});
    }
  };
  page.on("response", onResponse);

  for (let pg = 1; pg <= maxPages; pg++) {
    const searchUrl = `https://mobile.yangkeduo.com/search_result.html?search_key=${encodeURIComponent(brandName)}&page=${pg}`;

    try {
      if (pg === 1) {
        await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      } else {
        await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
      }
    } catch (e) {
      console.log(`[pdd] pg${pg} 导航失败: ${e.message}`);
      break;
    }

    await page.waitForTimeout(3000 + Math.random() * 2000);

    const currentUrl = page.url();
    const pageTitle = await page.title().catch(() => "");
    console.log(`[pdd] pg${pg} ${currentUrl.slice(0, 100)} | ${pageTitle.slice(0, 60)}`);

    // Check page state
    const pageState = await detectPddPageState(page);
    if (pageState.blocked) {
      console.log(`[pdd] 检测到${pageState.reason} — 停止采集`);
      break;
    }

    // Scroll to trigger lazy loading
    await page.evaluate(async () => {
      for (let y = 200; y < 2000; y += 400) {
        window.scrollTo(0, y);
        await new Promise(r => setTimeout(r, 150));
      }
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(2000);

    // Strategy A: Extract from window.rawData (PDD inline JSON)
    const rawDataProducts = await page.evaluate(() => {
      try {
        const rawData = window.rawData;
        if (!rawData) return [];
        // PDD nests product data in various paths
        const items = rawData?.serverRenderedData?.searchResult?.resultList
          || rawData?.searchResult?.resultList
          || rawData?.items
          || rawData?.goodsList
          || [];
        if (!Array.isArray(items) || items.length === 0) return [];
        return items.map(item => ({
          name: (item.goodsName || item.goods_name || item.name || "").trim(),
          price: String(item.minGroupPrice || item.groupPrice || item.price || item.min_price || "")
            .replace(/^(\d+)$/, "$1"),
          sales: String(item.salesTip || item.sales || item.soldQuantity || ""),
          shop: (item.mallName || item.shopName || item.mall_name || "").trim(),
          goodsId: String(item.goodsId || item.goods_id || item.goodsID || ""),
          imgSrc: (item.goodsImage || item.thumbUrl || item.image || ""),
          linkUrl: item.linkUrl || "",
        }));
      } catch (e) { return []; }
    });

    if (rawDataProducts.length > 0) {
      console.log(`[pdd] pg${pg} rawData提取: ${rawDataProducts.length} 个商品`);
      allProducts.push(...rawDataProducts);
      if (rawDataProducts.length < 20) break;
      await page.waitForTimeout(1500 + Math.random() * 1500);
      continue;
    }

    // Strategy B: DOM extraction
    const domProducts = await page.evaluate(() => {
      const results = [];
      const seen = new Set();

      // Primary: goods cards
      const items = document.querySelectorAll("[data-goods-id], .goods-item, .search-result-item, li[data-pid]");
      items.forEach(item => {
        const nameEl = item.querySelector(".goods-name, .name, .title, [class*='name'], p[class*='title']");
        const name = (nameEl?.textContent || "").trim();
        if (!name || name.length < 3) return;

        const priceEl = item.querySelector(".goods-price, .price, [class*='price'] span, .sale-price");
        const price = (priceEl?.textContent || "").replace(/[¥￥]/g, "").trim();

        const salesEl = item.querySelector(".goods-sales, .sales, [class*='sales'], .sold");
        const sales = (salesEl?.textContent || "").trim();

        const shopEl = item.querySelector(".mall-name, .shop-name, [class*='shop'], .store-name");
        const shop = (shopEl?.textContent || "").trim();

        const imgEl = item.querySelector("img");
        const imgSrc = imgEl?.getAttribute?.("src") || imgEl?.getAttribute?.("data-src") || "";

        const key = name.replace(/\s+/g, "").slice(0, 40);
        if (seen.has(key)) return;
        seen.add(key);
        results.push({ name, price, sales, shop, goodsId: "", imgSrc, linkUrl: "" });
      });

      // Strategy B2: Broader scan
      if (results.length < 5) {
        const allTextBlocks = document.querySelectorAll("div, li, a");
        allTextBlocks.forEach(el => {
          if (el.children.length > 8) return;
          const text = el.textContent.trim();
          if (text.length < 20 || text.length > 300) return;
          if (!text.includes("¥") && !text.includes("￥")) return;
          const key = text.replace(/\s+/g, "").slice(0, 40);
          if (seen.has(key)) return;
          seen.add(key);
          const priceMatch = text.match(/[¥￥]\s*([\d.]+)/);
          const price = priceMatch ? priceMatch[1] : "";
          const priceIdx = text.indexOf("¥") >= 0 ? text.indexOf("¥") : text.indexOf("￥");
          const name = priceIdx > 0 ? text.substring(0, priceIdx).trim().slice(0, 100) : text.slice(0, 60);
          const salesMatch = text.match(/([\d.]+万?)\s*(件|已拼|拼|售)/);
          results.push({
            name, price,
            sales: salesMatch ? salesMatch[1] : "",
            shop: "", goodsId: "", imgSrc: "", linkUrl: "",
          });
        });
      }

      return results;
    });

    console.log(`[pdd] pg${pg} DOM提取: ${domProducts.length} 个商品`);
    allProducts.push(...domProducts);

    if (domProducts.length < 20) break;
    await page.waitForTimeout(1500 + Math.random() * 1500);
  }

  page.off("response", onResponse);

  // Merge API products
  if (apiProducts.length > allProducts.length) {
    return apiProducts;
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

// ── JSON 数据提取 ────────────────────────────────────────────────

function extractFromPddJson(data) {
  const results = [];
  if (!data || typeof data !== "object") return results;

  // Recursively find product arrays
  const items = findArrayWith(data, "goodsName") ||
                findArrayWith(data, "goods_name") ||
                findArrayWith(data, "minGroupPrice") ||
                data.items || data.goodsList || data.resultList || [];

  if (!Array.isArray(items)) return results;

  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const name = (item.goodsName || item.goods_name || item.name || "").trim();
    if (!name || name.length < 3) continue;
    results.push({
      name,
      price: String(item.minGroupPrice || item.groupPrice || item.price || ""),
      sales: String(item.salesTip || item.sales || item.soldQuantity || ""),
      shop: (item.mallName || item.shopName || "").trim(),
      goodsId: String(item.goodsId || item.goods_id || ""),
      imgSrc: (item.goodsImage || item.thumbUrl || ""),
      linkUrl: "",
    });
  }
  return results;
}

function findArrayWith(obj, key) {
  if (!obj || typeof obj !== "object") return null;
  for (const k of Object.keys(obj)) {
    if (k === key) return obj[k];
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

// ── 页面状态检测 ─────────────────────────────────────────────────

async function detectPddPageState(page) {
  return page.evaluate(() => {
    const text = document.body?.innerText || "";
    const url = location.href || "";

    if (url.includes("login") || url.includes("passport")) {
      return { blocked: true, reason: "login_wall", detail: "需要登录拼多多" };
    }
    if (text.includes("验证") && (text.includes("滑块") || text.includes("拼图") || text.includes("点击"))) {
      return { blocked: true, reason: "captcha", detail: "触发拼多多反爬验证" };
    }
    if (text.includes("请求太频繁") || text.includes("稍后再试") || text.includes("网络异常")) {
      return { blocked: true, reason: "rate_limit", detail: "拼多多限流" };
    }
    if (text.length < 100 && text.includes("请")) {
      return { blocked: true, reason: "unknown", detail: text.slice(0, 100) };
    }
    return { blocked: false };
  });
}

// ── 价格/销量解析 ──────────────────────────────────────────────────

function parsePrice(priceStr) {
  const s = String(priceStr).replace(/[¥￥]/g, "").trim();
  const m = s.match(/([\d.]+)/);
  return m ? parseFloat(m[1]) : 0;
}

function parseSales(salesStr) {
  const s = String(salesStr);
  const wanMatch = s.match(/([\d.]+)\s*万/);
  if (wanMatch) return Math.round(parseFloat(wanMatch[1]) * 10000);
  const plusMatch = s.match(/([\d.]+)\s*\+/);
  if (plusMatch) return parseInt(plusMatch[1]);
  const m = s.match(/([\d,]+)/);
  if (m) return parseInt(m[1].replace(/,/g, ""));
  return 0;
}

// ── 采集品牌快照 ───────────────────────────────────────────────────

async function collectBrandSnapshot(page, brandName) {
  const products = (await searchPddProducts(page, brandName)) || [];

  const cleaned = products.map(p => ({
    name: String(p.name || ""),
    price: parsePrice(p.price),
    priceDisplay: String(p.price || ""),
    sales: parseSales(p.sales),
    salesDisplay: String(p.sales || ""),
    shop: String(p.shop || ""),
    goodsId: String(p.goodsId || ""),
  }));

  const validPrices = cleaned.map(p => p.price).filter(v => v > 0);

  return {
    collectedAt: localISO(),
    brand: brandName,
    source: "pdd",
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
        title: `[拼多多] 新品上架: ${tp.name}`,
        detail: `价格 ¥${tp.price}，${tp.salesDisplay || "暂无销量"}`,
        source: "pdd",
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
        title: `[拼多多] ${pct > 0 ? "涨价" : "降价"}: ${tp.name}`,
        detail: `¥${yp.price} → ¥${tp.price} (${pct > 0 ? "+" : ""}${pct}%)`,
        source: "pdd",
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
        title: `[拼多多] 商品下架: ${yp.name}`,
        detail: `原价 ¥${yp.price}`,
        source: "pdd",
        product: yp,
      });
    }
  }

  return { signals, isNew: false };
}

// ── Helpers ──────────────────────────────────────────────────────

function normalizeName(name) {
  return (name || "").replace(/\s+/g, "").replace(/[（(].*?[)）]/g, "").slice(0, 40);
}

function localISO() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function sanitize(name) {
  return (name || "").replace(/[<>:"/\\|?*]/g, "_").trim();
}

// ── Persistence ──────────────────────────────────────────────────

function saveSnapshot(dataDir, tenantId, brandName, snapshot) {
  const brandDir = path.join(dataDir, tenantId, sanitize(brandName));
  if (!fs.existsSync(brandDir)) fs.mkdirSync(brandDir, { recursive: true });
  const fp = path.join(brandDir, `snapshot-pdd-${today()}.json`);
  fs.writeFileSync(fp, JSON.stringify(snapshot, null, 2));
  return fp;
}

function loadSnapshot(dataDir, tenantId, brandName, date) {
  const fp = path.join(dataDir, tenantId, sanitize(brandName), `snapshot-pdd-${date}.json`);
  if (!fs.existsSync(fp)) return null;
  try { return JSON.parse(fs.readFileSync(fp, "utf-8")); } catch (e) { return null; }
}

module.exports = {
  searchPddProducts,
  collectBrandSnapshot,
  compareSnapshots,
  detectPddPageState,
  saveSnapshot,
  loadSnapshot,
  today,
  localISO,
};
