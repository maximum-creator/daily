// 当当网竞品采集器 — 品牌商品监控
// 策略：DOM 提取（当当搜索页是 SSR，无头模式可用）
// 数据质量：产品名 + 价格 + 评论数 + 店铺（自营/第三方）
// 搜索 URL: https://search.dangdang.com/?key={keyword}

const fs = require("fs");
const path = require("path");
const { normalizeName, localISO, today, sanitize, parsePrice, parseSales, classifyStore } = require("./utils");

// ── 搜索当当商品 ──────────────────────────────────────────────

async function searchDangdangProducts(page, brandName, maxPages = 2) {
  const allProducts = [];

  for (let pg = 1; pg <= maxPages; pg++) {
    const searchUrl = pg === 1
      ? `https://search.dangdang.com/?key=${encodeURIComponent(brandName)}`
      : `https://search.dangdang.com/?key=${encodeURIComponent(brandName)}&page_index=${pg}`;

    try {
      await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 25000 });
    } catch (e) {
      console.log(`[dangdang] pg${pg} 导航失败: ${e.message}`);
      break;
    }

    await page.waitForTimeout(2000 + Math.random() * 1500);

    const currentUrl = page.url();
    const pageTitle = await page.title().catch(() => "");
    console.log(`[dangdang] pg${pg} ${currentUrl.slice(0, 100)} | ${pageTitle.slice(0, 60)}`);

    // Anti-bot check
    const pageState = await detectDangdangPageState(page);
    if (pageState.blocked) {
      console.log(`[dangdang] 检测到${pageState.reason} — 停止采集`);
      break;
    }
    if (pageState.noResults) {
      console.log("[dangdang] 无搜索结果");
      break;
    }

    // Extract products from li.line1 cards
    const products = await page.evaluate(() => {
      const results = [];
      const seen = new Set();

      const items = document.querySelectorAll("li[sku]");
      if (items.length === 0) return [];

      items.forEach(item => {
        // Name — from p.name a element with title attribute
        const nameEl = item.querySelector("p.name a[title]") || item.querySelector("a[name='itemlist-title']");
        const name = (nameEl?.getAttribute("title") || nameEl?.textContent || "").trim();
        if (!name || name.length < 5) return;

        // Dedup by name prefix
        const key = name.replace(/\s+/g, "").slice(0, 60);
        if (seen.has(key)) return;
        seen.add(key);

        // Price — span.price_n
        const priceEl = item.querySelector("span.price_n");
        const priceText = (priceEl?.textContent || "").trim();
        const priceMatch = priceText.match(/([\d.]+)/);
        const price = priceMatch ? priceMatch[1] : "";

        // Also try full text price
        let finalPrice = price;
        if (!finalPrice) {
          const text = (item.textContent || "").replace(/\s+/g, " ");
          const pm = text.match(/¥\s*([\d.]+)/);
          if (pm) finalPrice = pm[1];
        }

        // Original price (定价)
        const origPriceEl = item.querySelector("span.price_r");
        const origPrice = (origPriceEl?.textContent || "").replace(/[¥￥]/g, "").trim();

        // Discount
        const discountEl = item.querySelector("span.price_s");
        const discount = (discountEl?.textContent || "").trim();

        // Reviews — p.star > a
        const reviewEl = item.querySelector("p.star a, [class*=comment] a, a[name='itemlist-review']");
        const reviewText = (reviewEl?.textContent || "").trim();
        const reviewMatch = reviewText.match(/(\d+)\s*条/);
        const reviews = reviewMatch ? reviewMatch[1] : "";

        // Shop — "自营" label or detect from store info
        const text = (item.textContent || "").replace(/\s+/g, " ");
        let shop = "第三方";
        const shopEl = item.querySelector("[class*=shop], [class*=store], [class*=seller], .seller");
        if (shopEl) {
          shop = (shopEl.textContent || "").trim();
        } else if (text.includes("自营") || text.includes("当当自营")) {
          shop = "当当自营";
        }

        // Check for specific store labels
        const storeLabel = item.querySelector(".shop_name, .store_name, .seller_name");
        if (storeLabel) {
          const s = (storeLabel.textContent || "").trim();
          if (s.length > 1 && s.length < 20) shop = s;
        }

        // Filter out button text mistaken as shop
        if (shop.includes("加入购物车") || shop.includes("收藏") || shop.includes("购买") || shop.length > 15) {
          shop = text.includes("自营") ? "当当自营" : "第三方";
        }

        // Product URL
        const linkEl = item.querySelector("a.pic[href*='product.dangdang.com']")
                    || item.querySelector("a[href*='product.dangdang.com']");
        const linkUrl = linkEl?.getAttribute("href") || "";

        // SKU ID
        const sku = item.getAttribute("sku") || "";

        // Image
        const imgEl = item.querySelector("a.pic img, img");
        const imgSrc = imgEl?.getAttribute("src") || imgEl?.getAttribute("data-original") || "";

        results.push({
          name: name.slice(0, 150),
          price: finalPrice,
          origPrice,
          discount,
          sales: 0,
          reviews: parseInt(reviews, 10) || 0,
          reviewsDisplay: reviews ? `${reviews}条评论` : "",
          shop,
          goodsId: sku,
          imgSrc,
          linkUrl: linkUrl.startsWith("//") ? "https:" + linkUrl : linkUrl,
        });
      });

      return results;
    });

    console.log(`[dangdang] pg${pg} 提取: ${products.length} 个商品`);
    allProducts.push(...products);
    if (products.length < 20) break;
    await page.waitForTimeout(1000 + Math.random() * 1000);
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

async function detectDangdangPageState(page) {
  return page.evaluate(() => {
    const text = document.body?.innerText || "";
    const url = location.href || "";

    if (url.includes("login") || url.includes("passport"))
      return { blocked: true, reason: "login_wall", detail: "需要登录当当" };

    if (text.includes("验证") && (text.includes("滑块") || text.includes("拼图") || text.includes("验证码")))
      return { blocked: true, reason: "captcha", detail: "触发当当反爬验证" };

    if (text.includes("访问太频繁") || text.includes("稍后再试") || text.includes("异常流量"))
      return { blocked: true, reason: "rate_limit", detail: "当当限流" };

    if (text.includes("没有找到") && text.includes("商品"))
      return { blocked: false, noResults: true };

    return { blocked: false };
  });
}

// ── 采集品牌快照 ───────────────────────────────────────────────────

async function collectBrandSnapshot(page, brandName) {
  const products = (await searchDangdangProducts(page, brandName)) || [];

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
    source: "dangdang",
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

function compareSnapshots(todaySnap, yesterdaySnap) {
  if (!yesterdaySnap) return { signals: [], isNew: true };

  const signals = [];
  const todayProducts = todaySnap.products || [];
  const yesterdayProducts = yesterdaySnap.products || [];

  const todayMap = new Map(todayProducts.map(p => [normalizeName(p.name), p]));
  const yesterdayMap = new Map(yesterdayProducts.map(p => [normalizeName(p.name), p]));

  for (const [name, tp] of todayMap) {
    const yp = yesterdayMap.get(name);
    if (!yp) {
      signals.push({
        type: "new_product",
        severity: "medium",
        title: `[当当] 新品上架: ${tp.name}`,
        detail: `价格 ¥${tp.price}，${tp.salesDisplay || "暂无评价"}`,
        source: "dangdang",
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
        title: `[当当] ${pct > 0 ? "涨价" : "降价"}: ${tp.name}`,
        detail: `¥${yp.price} → ¥${tp.price} (${pct > 0 ? "+" : ""}${pct}%)`,
        source: "dangdang",
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
        title: `[当当] 商品下架: ${yp.name}`,
        detail: `原价 ¥${yp.price}`,
        source: "dangdang",
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
  const fp = path.join(brandDir, `snapshot-dangdang-${today()}.json`);
  fs.writeFileSync(fp, JSON.stringify(snapshot, null, 2));
  return fp;
}

function loadSnapshot(dataDir, tenantId, brandName, date) {
  const fp = path.join(dataDir, tenantId, sanitize(brandName), `snapshot-dangdang-${date}.json`);
  if (!fs.existsSync(fp)) return null;
  try { return JSON.parse(fs.readFileSync(fp, "utf-8")); } catch (e) { return null; }
}

module.exports = {
  searchDangdangProducts,
  collectBrandSnapshot,
  compareSnapshots,
  detectDangdangPageState,
  saveSnapshot,
  loadSnapshot,
  today,
  localISO,
};
