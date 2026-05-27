// 京东竞品采集器 — 品牌店铺商品监控
// 必要条件：用户需登录京东（调用 POST /api/v1/login 后可见浏览器完成扫码）
// 采集策略：SSR DOM 解析 + 滚动触发懒加载 + 多选择器回退

const fs = require("fs");
const path = require("path");

// ── JD 商品搜索 ─────────────────────────────────────────────────

async function searchJdProducts(page, brandName, maxPages = 3) {
  const allProducts = [];

  for (let pg = 1; pg <= maxPages; pg++) {
    // JD pagination uses odd numbers: page 1 → param 1, page 2 → param 3, etc.
    const searchUrl = `https://search.jd.com/Search?keyword=${encodeURIComponent(brandName)}&enc=utf-8&page=${2 * pg - 1}`;

    try {
      await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    } catch (e) { /* timeout ok */ }

    await page.waitForTimeout(5000);

    const currentUrl = page.url();
    const pageTitle = await page.title().catch(() => "");
    console.log(`[jd] pg${pg} ${currentUrl.slice(0, 100)} | ${pageTitle.slice(0, 60)}`);

    // Check for login wall or anti-bot
    const pageState = await detectJdPageState(page);
    if (pageState.blocked) {
      console.log(`[jd] 检测到${pageState.reason} — 停止采集`);
      break;
    }

    // Scroll to trigger lazy-loaded content
    await page.evaluate(async () => {
      const height = document.body.scrollHeight;
      for (let y = 100; y < height; y += 300) {
        window.scrollTo(0, y);
        await new Promise(r => setTimeout(r, 100));
      }
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(2000);

    // Multi-strategy DOM extraction
    const products = await page.evaluate(() => {
      const results = [];

      // Strategy A: Classic JD gl-item (server-side rendered list items)
      const items = document.querySelectorAll("li.gl-item");
      if (items.length > 0) {
        items.forEach(item => {
          const r = parseJdItem(item);
          if (r && r.name) results.push(r);
        });
      }

      // Strategy B: Alternative JD selectors (they change over time)
      if (results.length === 0) {
        const altSelectors = [
          "#J_goodsList li", ".gl-warp li", ".goods-list li",
          "[class*='goods'] li", "[class*='product'] li",
          "li[data-sku]", "div[data-sku]",
          ".m-list li", ".jList li", ".search-item",
          "[class*='SearchItem']", "[class*='GoodsItem']",
        ];
        for (const sel of altSelectors) {
          const els = document.querySelectorAll(sel);
          if (els.length > 0) {
            els.forEach(el => {
              const r = parseJdItem(el);
              if (r && r.name) results.push(r);
            });
            if (results.length >= 5) break;
          }
        }
      }

      // Strategy C: Broad scan — find elements with price + name patterns
      if (results.length < 5) {
        const allDivs = document.querySelectorAll("div, li");
        const seen = new Set();
        allDivs.forEach(el => {
          if (el.children.length > 10) return; // skip containers
          const text = el.textContent.trim();
          if (text.length < 20 || text.length > 500) return;
          if (!text.includes("￥") && !text.includes("¥")) return;
          const key = text.slice(0, 40);
          if (seen.has(key)) return;
          seen.add(key);

          const r = parseProductText(text, el);
          if (r && r.name && r.price) {
            results.push(r);
          }
        });
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

    allProducts.push(...products);

    // Stop if fewer than 20 results
    if (products.length < 20) break;

    // Human-like delay between pages
    await page.waitForTimeout(2000 + Math.random() * 1500);
  }

  return allProducts;
}

// ── Parse a JD search result item ─────────────────────────────

function parseJdItem(item) {
  // Name
  const nameEl = item.querySelector(".p-name em") ||
                 item.querySelector(".p-name a em") ||
                 item.querySelector(".p-name a") ||
                 item.querySelector(".p-name-type-2 a") ||
                 item.querySelector("[data-title]");
  const name = (nameEl?.textContent || nameEl?.getAttribute?.("data-title") || "").trim();

  if (!name || name.length < 3) return null;

  // Price
  const priceEl = item.querySelector(".p-price i") ||
                  item.querySelector(".p-price strong") ||
                  item.querySelector(".p-price span") ||
                  item.querySelector(".p-price");
  const priceText = (priceEl?.textContent || "").trim();

  // Shop
  const shopEl = item.querySelector(".p-shop a") ||
                 item.querySelector(".p-shop span") ||
                 item.querySelector(".curr-shop") ||
                 item.querySelector("[class*='shop'] a") ||
                 item.querySelector("[class*='shop'] span");
  const shop = (shopEl?.textContent || "").trim();

  // Is JD self-operated?
  const isSelf = !!item.querySelector(".p-icons i-self") ||
                 !!item.querySelector(".p-icon-self") ||
                 !!item.querySelector("[class*='self']") ||
                 (shop && (shop.includes("自营") || shop.includes("京东自营")));

  // Reviews
  const commitEl = item.querySelector(".p-commit strong a") ||
                   item.querySelector(".p-commit a") ||
                   item.querySelector("[class*='commit'] a");
  const reviewsText = (commitEl?.textContent || "").trim();

  // SKU
  const sku = item.getAttribute("data-sku") || "";

  // Image
  const imgEl = item.querySelector(".p-img img");
  const imgSrc = imgEl?.getAttribute?.("src") ||
                 imgEl?.getAttribute?.("data-lazy-img") || "";

  return { name, price: priceText, shop, isSelfOperated: isSelf, reviews: reviewsText, sku, imgSrc };
}

// ── Parse from generic text (fallback strategy) ───────────────

function parseProductText(text, element) {
  const priceMatch = text.match(/[¥￥]\s*([\d.]+)/);
  if (!priceMatch) return null;

  const priceStr = priceMatch[1];
  const priceIdx = text.indexOf("¥") >= 0 ? text.indexOf("¥") : text.indexOf("￥");

  // Name: text before the price
  let name = priceIdx > 0 ? text.substring(0, priceIdx).trim() : text;
  if (name.length > 120) name = name.slice(0, 120);

  // Reviews/sales
  const reviewMatch = text.match(/([\d.]+万?)\+?\s*(条评价|评价|评论)/);
  const reviews = reviewMatch ? reviewMatch[1] : "";

  // Shop
  let shop = "";
  let el = element;
  for (let i = 0; i < 5 && el; i++) {
    const shopEl = el.querySelector?.("[class*='shop'], [class*='store'], [class*='seller']");
    if (shopEl) { shop = shopEl.textContent.trim(); break; }
    el = el.parentElement;
  }
  const isSelf = shop.includes("自营") || shop.includes("京东自营");

  return { name, price: priceStr, shop, isSelfOperated: isSelf, reviews, sku: "", imgSrc: "" };
}

// ── Page state detection ──────────────────────────────────────

async function detectJdPageState(page) {
  return page.evaluate(() => {
    const text = document.body?.innerText || "";
    const url = location.href || "";

    // Login wall
    if (url.includes("passport.jd.com") || url.includes("plogin.m.jd.com")) {
      return { blocked: true, reason: "login_wall", detail: "需要登录京东账号" };
    }
    if ((text.includes("请登录") || text.includes("登录页面")) && text.length < 2000) {
      return { blocked: true, reason: "login_wall", detail: "需要登录京东账号" };
    }

    // Anti-bot / captcha
    if (text.includes("验证码") || text.includes("请输入验证码") || text.includes("滑块验证")) {
      return { blocked: true, reason: "captcha", detail: "触发京东反爬验证" };
    }
    if (text.includes("异常流量") || text.includes("检测到异常")) {
      return { blocked: true, reason: "rate_limit", detail: "京东检测到异常流量" };
    }

    return { blocked: false };
  });
}

// ── 价格/评价解析 ──────────────────────────────────────────────

function parsePrice(priceStr) {
  const s = String(priceStr).replace(/[¥￥]/g, "");
  const m = s.match(/([\d.]+)/);
  return m ? parseFloat(m[1]) : 0;
}

function parseReviews(reviewsStr) {
  const s = String(reviewsStr);
  const wanMatch = s.match(/([\d.]+)\s*万/);
  if (wanMatch) return Math.round(parseFloat(wanMatch[1]) * 10000);
  const plusMatch = s.match(/([\d.]+)\s*\+/);
  if (plusMatch) return parseInt(plusMatch[1]);
  const m = s.match(/([\d,]+)/);
  if (m) return parseInt(m[1].replace(/,/g, ""));
  return 0;
}

// ── 采集品牌商品快照 ──────────────────────────────────────────

async function collectBrandSnapshot(page, brandName) {
  const products = (await searchJdProducts(page, brandName)) || [];

  const cleaned = products.map(p => ({
    name: String(p.name || ""),
    price: parsePrice(p.price),
    priceDisplay: String(p.price || ""),
    reviews: parseReviews(p.reviews),
    reviewsDisplay: String(p.reviews || ""),
    shop: String(p.shop || ""),
    isSelfOperated: !!p.isSelfOperated,
    sku: String(p.sku || ""),
  }));

  const validPrices = cleaned.map(p => p.price).filter(v => v > 0);
  const selfCount = cleaned.filter(p => p.isSelfOperated).length;

  return {
    collectedAt: localISO(),
    brand: brandName,
    source: "jd",
    productCount: cleaned.length,
    products: cleaned,
    selfOperatedCount: selfCount,
    thirdPartyCount: cleaned.length - selfCount,
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
        title: `[京东] 新品上架: ${tp.name}`,
        detail: `价格 ¥${tp.price}，${tp.reviewsDisplay || "暂无评价"}${tp.isSelfOperated ? "，京东自营" : ""}`,
        source: "jd",
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
        title: `[京东] ${pct > 0 ? "涨价" : "降价"}: ${tp.name}`,
        detail: `¥${yp.price} → ¥${tp.price} (${pct > 0 ? "+" : ""}${pct}%)`,
        source: "jd",
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
        title: `[京东] 商品下架: ${yp.name}`,
        detail: `原价 ¥${yp.price}`,
        source: "jd",
        product: yp,
      });
    }
  }

  if (today.selfOperatedCount != null && yesterday.selfOperatedCount != null) {
    if (today.selfOperatedCount !== yesterday.selfOperatedCount) {
      signals.push({
        type: "self_ratio_change",
        severity: "low",
        title: "[京东] 自营商品数变化",
        detail: `自营: ${yesterday.selfOperatedCount} → ${today.selfOperatedCount}`,
        source: "jd",
      });
    }
  }

  return { signals, isNew: false };
}

// ── Helpers ────────────────────────────────────────────────────

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

// ── Persistence ─────────────────────────────────────────────────

function saveSnapshot(dataDir, tenantId, brandName, snapshot) {
  const brandDir = path.join(dataDir, tenantId, sanitize(brandName));
  if (!fs.existsSync(brandDir)) fs.mkdirSync(brandDir, { recursive: true });
  const fp = path.join(brandDir, `snapshot-jd-${today()}.json`);
  fs.writeFileSync(fp, JSON.stringify(snapshot, null, 2));
  return fp;
}

function loadSnapshot(dataDir, tenantId, brandName, date) {
  const fp = path.join(dataDir, tenantId, sanitize(brandName), `snapshot-jd-${date}.json`);
  if (!fs.existsSync(fp)) return null;
  try { return JSON.parse(fs.readFileSync(fp, "utf-8")); } catch (e) { return null; }
}

function sanitize(name) {
  return (name || "").replace(/[<>:"/\\|?*]/g, "_").trim();
}

module.exports = {
  searchJdProducts,
  collectBrandSnapshot,
  compareSnapshots,
  detectJdPageState,
  saveSnapshot,
  loadSnapshot,
  today,
  localISO,
};
