// 天猫竞品采集器 — 品牌店铺商品监控
// 必要条件：用户已通过 POST /api/v1/login 在可见浏览器中登录淘宝
// 采集策略：API 拦截 → 多策略 DOM 提取 → 滚动触发懒加载

const fs = require("fs");
const path = require("path");

// ── 搜索天猫商品（五层回退策略）────────────────────────────────

async function searchTmallProducts(page, brandName, maxPages = 3) {
  const allProducts = [];

  // Strategy 1: API response interception — capture before DOM
  const apiProducts = [];
  const onResponse = (response) => {
    const url = response.url();
    if (url.includes("h5api.m.taobao.com") || url.includes("suggest") || url.includes("search")) {
      response.json().then(data => {
        const extracted = extractProductsFromJson(data);
        if (extracted.length > 0) apiProducts.push(...extracted);
      }).catch(() => {});
    }
  };
  page.on("response", onResponse);

  for (let pg = 1; pg <= maxPages; pg++) {
    const searchUrl = `https://s.taobao.com/search?q=${encodeURIComponent(brandName)}&tab=mall&page=${pg}`;

    const currentUrl = page.url();
    const alreadyOnSearch = currentUrl.includes("s.taobao.com/search") && currentUrl.includes(`q=${encodeURIComponent(brandName)}`);

    if (!alreadyOnSearch || pg > 1) {
      try {
        await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      } catch (e) { /* timeout ok */ }
    }
    // Wait for dynamic content (XHR-based search results) and product links
    await page.waitForTimeout(5000);
    try {
      await page.waitForSelector("a[href*='detail.tmall.com']", { timeout: 10000 });
    } catch (e) {
      const dumpUrl = page.url();
      const dumpTitle = await page.title().catch(() => "N/A");
      const dumpBody = await page.evaluate(() => (document.body?.innerText || "").slice(0, 500)).catch(() => "N/A");
      console.log(`[tmall] NO LINKS — url: ${dumpUrl.slice(0, 100)} | title: ${dumpTitle.slice(0, 60)} | body: ${dumpBody.slice(0, 200)}`);
    }

    // Tmall redirects to s.taobao.com — check what we got
    const redirectedUrl = page.url();
    const pageTitle = await page.title().catch(() => "");
    console.log(`[tmall] pg${pg} ${redirectedUrl.slice(0, 100)} | ${pageTitle.slice(0, 60)}`);

    // Detection: login wall
    const pageState = await detectPageState(page);
    if (pageState.blocked) {
      console.log(`[tmall] 检测到${pageState.reason} — 停止采集`);
      break;
    }

    // Scroll to trigger lazy-loaded product cards
    await page.evaluate(async () => {
      const height = document.body.scrollHeight;
      for (let y = 100; y < height; y += 300) {
        window.scrollTo(0, y);
        await new Promise(r => setTimeout(r, 100));
      }
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(2000);

    // Strategy 2: Broad DOM extraction with multiple selector approaches
    const domProducts = await page.evaluate(() => {
      const results = [];
      // Inline parse helper — must be defined inside evaluate (browser context)
      function parseProduct(text) {
        const priceMatch = text.match(/¥\s*([\d.]+)/);
        let name = text;
        const priceIdx = text.indexOf("¥");
        if (priceIdx > 0) name = text.substring(0, priceIdx).trim();
        if (name.length > 120) name = name.slice(0, 120);
        const salesMatch = text.match(/([\d.万+]+)\s*[人笔件]付款/);
        return {
          name,
          price: priceMatch ? priceMatch[1] : "",
          sales: salesMatch ? salesMatch[1] : "",
          shop: "",
        };
      }

      // Strategy A: Direct link extraction (most reliable, matches debug endpoint approach)
      const links = document.querySelectorAll("a[href*='detail.tmall.com']");
      for (const link of links) {
        const text = (link.textContent || "").trim();
        if (text.length > 8) {
          const parsed = parseProduct(text);
          if (parsed.name) {
            results.push(parsed);
            if (results.length >= 60) break;
          }
        }
      }

      // Strategy B: taobao item links as fallback
      if (results.length < 5) {
        const tbLinks = document.querySelectorAll("a[href*='item.taobao.com']");
        for (const link of tbLinks) {
          const text = (link.textContent || "").trim();
          if (text.length > 8) {
            const parsed = parseProduct(text);
            if (parsed.name && !results.find(r => r.name === parsed.name)) {
              results.push(parsed);
              if (results.length >= 60) break;
            }
          }
        }
      }

      // Strategy C: Image alt text fallback
      if (results.length < 5) {
        const imgs = document.querySelectorAll("img[alt]");
        for (const img of imgs) {
          const alt = img.alt.trim();
          if (alt.length > 5 && alt.length < 200 && !results.find(r => r.name === alt)) {
            const container = img.closest("div, li, a, section");
            const text = container ? container.textContent.trim() : "";
            const priceMatch = text.match(/¥\s*([\d.]+)/);
            const salesMatch = text.match(/([\d.万+]+)\s*[人笔件]付款/);
            results.push({
              name: alt,
              price: priceMatch ? priceMatch[1] : "",
              sales: salesMatch ? salesMatch[1] : "",
              shop: "",
            });
          }
        }
      }

      // Deduplicate
      const seen = new Set();
      return results.filter(r => {
        const key = (r.name || "").replace(/\s+/g, "").slice(0, 30);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    });

    allProducts.push(...domProducts);

    // Stop if fewer than 20 results (likely end of pagination)
    if (domProducts.length < 20) break;

    // Wait between pages
    await page.waitForTimeout(1500 + Math.random() * 1000);
  }

  page.removeListener("response", onResponse);

  // Merge API products if richer
  if (apiProducts.length > 0) {
    const existingNames = new Set(allProducts.map(p => normalizeName(p.name)));
    for (const ap of apiProducts) {
      if (!existingNames.has(normalizeName(ap.name))) {
        allProducts.push(ap);
      }
    }
  }

  return allProducts;
}

// ── Page state detection ──────────────────────────────────────

async function detectPageState(page) {
  return page.evaluate(() => {
    const text = document.body?.innerText || "";
    const url = location.href || "";

    // Login wall patterns
    if (url.includes("login.taobao.com") || url.includes("passport")) {
      return { blocked: true, reason: "login_wall", detail: "需要登录淘宝账号" };
    }
    if (text.includes("请登录") && text.length < 600) {
      return { blocked: true, reason: "login_wall", detail: "需要登录淘宝账号" };
    }

    // Anti-bot / captcha
    if (text.includes("验证码") || text.includes("滑块验证") || text.includes("异常流量")) {
      return { blocked: true, reason: "captcha", detail: "触发反爬验证" };
    }

    // "挤爆了" — Taobao's rate limiting
    if (text.includes("被挤爆啦") || text.includes("请稍后重试")) {
      return { blocked: true, reason: "rate_limit", detail: "淘宝限流" };
    }

    return { blocked: false };
  });
}

// ── Parse product text into structured fields ─────────────────

function parseProductText(text, element) {
  const priceMatch = text.match(/¥\s*([\d.]+)/);
  const salesMatch = text.match(/([\d.+万]+)\s*[人笔件]付款/);
  // Shop name: try to find in parent hierarchy
  let shop = "";
  let el = element;
  for (let i = 0; i < 5 && el; i++) {
    const shopEl = el.querySelector?.("[class*='shop'], [class*='store'], [class*='seller']");
    if (shopEl) { shop = shopEl.textContent.trim(); break; }
    el = el.parentElement;
  }

  // Extract name: text before the first ¥ price pattern
  let name = text;
  const priceIdx = text.indexOf("¥");
  if (priceIdx > 0) {
    name = text.substring(0, priceIdx).trim();
  }
  // Limit name length
  if (name.length > 120) name = name.slice(0, 120);

  return {
    name,
    price: priceMatch ? priceMatch[1] : "",
    sales: salesMatch ? salesMatch[1] : "",
    shop,
  };
}

// ── Recursively search JSON for product arrays ─────────────────

function extractProductsFromJson(obj, depth = 0) {
  if (!obj || depth > 5) return [];
  const results = [];

  if (Array.isArray(obj)) {
    for (const item of obj) {
      if (item && typeof item === "object") {
        const name = item.title || item.name || item.productName || item.itemName || item.rawTitle || "";
        const price = item.price || item.salePrice || item.originPrice || item.priceStr || "";
        if (name && price) {
          results.push({
            name: String(name),
            price: String(price),
            sales: String(item.sales || item.monthlySales || item.sold || item.soldStr || ""),
            shop: String(item.shopName || item.storeName || item.sellerNick || item.nick || ""),
          });
        } else {
          results.push(...extractProductsFromJson(item, depth + 1));
        }
      }
    }
  } else if (typeof obj === "object") {
    const dataPaths = [
      obj.data, obj.result, obj.contents, obj.items,
      obj.listItems, obj.products, obj.itemList,
      obj.data?.list, obj.data?.items, obj.result?.data,
      obj.data?.result, obj.data?.contents,
      obj.data?.itemList, obj.data?.auctions,
      obj.result?.auctions, obj.result?.itemsArray,
    ];
    for (const dp of dataPaths) {
      if (dp) results.push(...extractProductsFromJson(dp, depth + 1));
    }
  }

  return results;
}

// ── 价格/销量解析 ──────────────────────────────────────────────

function parsePrice(priceStr) {
  const m = String(priceStr).match(/([\d.]+)/);
  return m ? parseFloat(m[1]) : 0;
}

function parseSales(salesStr) {
  const s = String(salesStr);
  const m = s.match(/([\d.]+)/);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  if (s.includes("万")) return Math.round(n * 10000);
  return n;
}

// ── 采集品牌商品快照 ──────────────────────────────────────────

async function collectBrandSnapshot(page, brandName) {
  const products = (await searchTmallProducts(page, brandName)) || [];

  const cleaned = products.map(p => ({
    name: String(p.name || ""),
    price: parsePrice(p.price),
    priceDisplay: String(p.price || ""),
    sales: parseSales(p.sales),
    salesDisplay: String(p.sales || ""),
    shop: String(p.shop || ""),
  }));

  const validPrices = cleaned.map(p => p.price).filter(v => v > 0);

  return {
    collectedAt: localISO(),
    brand: brandName,
    source: "tmall",
    productCount: cleaned.length,
    products: cleaned,
    priceRange: {
      min: validPrices.length > 0 ? Math.min(...validPrices) : 0,
      max: validPrices.length > 0 ? Math.max(...validPrices) : 0,
      avg: validPrices.length > 0 ? Math.round(validPrices.reduce((a, b) => a + b, 0) / validPrices.length) : 0,
    },
  };
}

// ── 对比昨日快照 → 信号 ──────────────────────────────────────

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
        title: `新品上架: ${tp.name}`,
        detail: `价格 ¥${tp.price}，${tp.salesDisplay || "暂无销量数据"}`,
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
        title: `${pct > 0 ? "涨价" : "降价"}: ${tp.name}`,
        detail: `¥${yp.price} → ¥${tp.price} (${pct > 0 ? "+" : ""}${pct}%)`,
        product: tp,
        oldPrice: yp.price, newPrice: tp.price, changePct: pct,
      });
    }
    if (tp.sales > 0 && yp.sales > 0) {
      const growth = yp.sales > 0 ? Math.round((tp.sales - yp.sales) / yp.sales * 100) : 0;
      if (growth > 50) {
        signals.push({
          type: "sales_surge",
          severity: "medium",
          title: `销量暴增: ${tp.name}`,
          detail: `月销 ${yp.salesDisplay} → ${tp.salesDisplay} (↑${growth}%)`,
          product: tp,
          growth,
        });
      }
    }
  }

  for (const [name, yp] of yesterdayMap) {
    if (!todayMap.has(name)) {
      signals.push({
        type: "delisted",
        severity: "medium",
        title: `商品下架: ${yp.name}`,
        detail: `原价 ¥${yp.price}`,
        product: yp,
      });
    }
  }

  if (today.priceRange && yesterday.priceRange) {
    const minChange = today.priceRange.min - yesterday.priceRange.min;
    const maxChange = today.priceRange.max - yesterday.priceRange.max;
    if (Math.abs(minChange) > 10 || Math.abs(maxChange) > 20) {
      signals.push({
        type: "price_range_shift",
        severity: "low",
        title: "价格带变动",
        detail: `最低价 ¥${yesterday.priceRange.min}→¥${today.priceRange.min}，最高价 ¥${yesterday.priceRange.max}→¥${today.priceRange.max}`,
      });
    }
  }

  return { signals, isNew: false };
}

// ── Helpers ────────────────────────────────────────────────────

function normalizeName(name) {
  return (name || "").replace(/\s+/g, "").replace(/[（(].*?[)）]/g, "").replace(/【.*?】/g, "").slice(0, 40);
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

// ── Persistence ─────────────────────────────────────────────────

function saveSnapshot(dataDir, tenantId, brandName, snapshot) {
  const brandDir = path.join(dataDir, tenantId, sanitize(brandName));
  if (!fs.existsSync(brandDir)) fs.mkdirSync(brandDir, { recursive: true });
  const fp = path.join(brandDir, `snapshot-${today()}.json`);
  fs.writeFileSync(fp, JSON.stringify(snapshot, null, 2));
  return fp;
}

function loadSnapshot(dataDir, tenantId, brandName, date) {
  const fp = path.join(dataDir, tenantId, sanitize(brandName), `snapshot-${date}.json`);
  if (!fs.existsSync(fp)) return null;
  try { return JSON.parse(fs.readFileSync(fp, "utf-8")); } catch (e) { return null; }
}

function sanitize(name) {
  return (name || "").replace(/[<>:"/\\|?*]/g, "_").trim();
}

module.exports = {
  searchTmallProducts,
  collectBrandSnapshot,
  compareSnapshots,
  detectPageState,
  saveSnapshot,
  loadSnapshot,
  today,
  localISO,
};
