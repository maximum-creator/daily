// 京东竞品采集器 — 品牌店铺商品监控
// 必要条件：用户需登录京东（调用 POST /api/v1/login 后可见浏览器完成扫码）
// 采集策略：AJAX API 直连（绕过SSR反爬） + DOM 解析 + 多选择器回退

const fs = require("fs");
const path = require("path");
const https = require("https");
const zlib = require("zlib");

const PROFILES_DIR = path.join(__dirname, "..", "browser-profiles");

// ── 浏览器内 fetch 搜索（绕过 TLS 指纹检测） ──────────────────

async function searchJdViaBrowserApi(page, brandName, maxPages = 1) {
  const allProducts = [];

  // Navigate to search.jd.com first (sets origin for same-origin fetch)
  // Even if page shows "rate limited", same-origin fetch to API may still work
  const searchUrl = `https://search.jd.com/Search?keyword=${encodeURIComponent(brandName)}&enc=utf-8`;
  try {
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForTimeout(3000);
  } catch (e) {
    console.log(`[jd-browser-api] 导航失败: ${e.message}`);
    return [];
  }

  // Check if we landed on risk handler or login
  const currentUrl = page.url();
  if (currentUrl.includes("risk_handler") || currentUrl.includes("passport.jd.com")) {
    console.log(`[jd-browser-api] 被拦截: ${currentUrl.slice(0, 80)}`);
    return [];
  }

  for (let pg = 1; pg <= maxPages; pg++) {
    console.log(`[jd-browser-api] pg${pg} fetch中 (同源)...`);
    const result = await page.evaluate(async ({ brandName, page: pgNum }) => {
      const keyword = encodeURIComponent(brandName);
      const pageParam = 2 * pgNum - 1;
      const offset = (pgNum - 1) * 30;
      const logId = Date.now() + "." + Math.floor(Math.random() * 10000);
      const url = `https://search.jd.com/s_new.php?keyword=${keyword}&enc=utf-8&qrst=1&rt=1&stop=1&vt=2&wq=${keyword}&page=${pageParam}&s=${offset}&scrolling=y&log_id=${logId}`;

      try {
        const res = await fetch(url, {
          method: "GET",
          credentials: "include",
          headers: {
            "Accept": "text/html, */*; q=0.01",
            "Referer": `https://search.jd.com/Search?keyword=${keyword}&enc=utf-8`,
            "X-Requested-With": "XMLHttpRequest",
          },
        });
        const html = await res.text();

        // Check for anti-bot
        if (html.includes("访问频繁") || html.includes("请稍后再试")) return { error: "rate_limit" };
        if (html.includes("京东验证")) return { error: "captcha" };
        if (html.length < 500) return { error: "short_response", detail: html.slice(0, 200) };

        // Parse with DOM — we're in browser context
        const div = document.createElement("div");
        div.innerHTML = html;
        const items = div.querySelectorAll("li.gl-item");
        if (items.length === 0) {
          // Try alternative selectors
          const altItems = div.querySelectorAll("[data-sku], .goods-item, .product-item");
          if (altItems.length === 0) {
            return { error: "no_items", htmlLen: html.length, snippet: html.slice(0, 300) };
          }
        }

        const results = [];
        items.forEach(item => {
          const nameEl = item.querySelector(".p-name em, .p-name a em, .p-name a, [data-title]");
          const name = (nameEl?.textContent || nameEl?.getAttribute?.("data-title") || "").trim();
          if (!name || name.length < 3) return;

          const priceEl = item.querySelector(".p-price i, .p-price strong, .p-price");
          const price = (priceEl?.textContent || "").trim();
          const sku = item.getAttribute("data-sku") || "";
          const imgEl = item.querySelector(".p-img img");
          const imgSrc = imgEl?.getAttribute?.("src") || imgEl?.getAttribute?.("data-lazy-img") || "";
          const shopEl = item.querySelector(".p-shop a, .curr-shop, [class*='shop'] a");
          const shop = (shopEl?.textContent || "").trim();
          const isSelf = !!(shop.includes("自营") || item.querySelector(".p-icons i-self, [class*='self']"));
          const commitEl = item.querySelector(".p-commit a, [class*='commit'] a");
          const reviews = (commitEl?.textContent || "").trim();

          results.push({ name, price, shop, isSelfOperated: isSelf, reviews, sku, imgSrc });
        });

        // Dedup
        const seen = new Set();
        return results.filter(r => {
          const key = (r.name || "").replace(/\s+/g, "").slice(0, 40);
          if (!key || seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      } catch (e) {
        return { error: e.message };
      }
    }, { brandName, page: pg });

    if (result.error) {
      console.log(`[jd-browser-api] pg${pg} 失败: ${result.error}${result.detail ? " — " + result.detail : ""}${result.snippet ? " — " + result.snippet.slice(0, 100) : ""}`);
      break;
    }
    if (!Array.isArray(result) || result.length === 0) {
      console.log(`[jd-browser-api] pg${pg} 无商品`);
      break;
    }

    console.log(`[jd-browser-api] pg${pg} 提取: ${result.length} 个商品`);
    allProducts.push(...result);
    if (result.length < 20) break;

    // Human-like delay between pages
    await page.waitForTimeout(1500 + Math.random() * 2000);
  }

  return allProducts;
}

// ── Cookie 文件加载 ───────────────────────────────────────────────

function loadCookiesForRequest(tenantId) {
  const fp = path.join(PROFILES_DIR, tenantId, "cookies-jd.json");
  if (!fs.existsSync(fp)) return "";
  try {
    const cookies = JSON.parse(fs.readFileSync(fp, "utf-8"));
    const now = Date.now();
    const valid = cookies.filter(c => {
      if (!c.expires || c.expires === -1) return true;
      return c.expires * 1000 > now;
    });
    return valid.map(c => `${c.name}=${c.value}`).join("; ");
  } catch (e) {
    return "";
  }
}

// ── Node.js HTTPS API 搜索（备选） ─────────────────────────────────

function jdApiRequest(url, cookieHeader, referer = "https://search.jd.com/") {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      port: 443,
      path: parsed.pathname + parsed.search,
      method: "GET",
      headers: {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Accept-Encoding": "gzip, deflate, br",
        "Referer": referer,
        "Cookie": cookieHeader,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
      },
      timeout: 15000,
    };

    const req = https.request(options, (res) => {
      // Handle redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = res.headers.location.startsWith("http")
          ? res.headers.location
          : `https://${parsed.hostname}${res.headers.location}`;
        const setCookie = res.headers["set-cookie"];
        let extraCookies = "";
        if (setCookie) {
          extraCookies = setCookie.map(c => c.split(";")[0]).join("; ");
        }
        const mergedCookie = extraCookies ? `${cookieHeader}; ${extraCookies}` : cookieHeader;
        jdApiRequest(redirectUrl, mergedCookie, url).then(resolve).catch(reject);
        return;
      }

      const chunks = [];
      res.on("data", chunk => { chunks.push(chunk); });
      res.on("end", () => {
        let data = Buffer.concat(chunks);
        const encoding = res.headers["content-encoding"] || "";

        // Decompress if needed
        if (encoding.includes("gzip") || data[0] === 0x1f && data[1] === 0x8b) {
          try {
            data = zlib.gunzipSync(data);
          } catch (e) { /* keep raw */ }
        } else if (encoding.includes("deflate")) {
          try {
            data = zlib.inflateSync(data);
          } catch (e) { /* keep raw */ }
        } else if (encoding.includes("br")) {
          try {
            data = zlib.brotliDecompressSync(data);
          } catch (e) { /* keep raw */ }
        }

        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: data.toString("utf-8"),
          finalUrl: url,
        });
      });
    });

    req.on("timeout", () => {
      req.destroy();
      reject(new Error("请求超时"));
    });
    req.on("error", reject);
    req.end();
  });
}

async function searchJdViaApi(tenantId, brandName, maxPages = 1) {
  const cookieHeader = loadCookiesForRequest(tenantId);
  if (!cookieHeader) {
    console.log("[jd-api] 无可用cookies，跳过API搜索");
    return [];
  }

  let allProducts = [];

  // Strategy A: Mobile search API (so.m.jd.com) — different gateway, lighter anti-bot
  allProducts = await searchJdMobileApi(cookieHeader, brandName, maxPages);
  if (allProducts.length > 0) return allProducts;

  // Strategy B: Desktop AJAX API (s_new.php) — may need specific parameters
  for (let pg = 1; pg <= maxPages; pg++) {
    const pageParam = 2 * pg - 1;
    const offset = (pg - 1) * 30;
    const searchUrl = `https://search.jd.com/s_new.php?keyword=${encodeURIComponent(brandName)}&enc=utf-8&qrst=1&rt=1&stop=1&vt=2&wq=${encodeURIComponent(brandName)}&page=${pageParam}&s=${offset}&scrolling=y&log_id=${Date.now()}.${Math.floor(Math.random() * 10000)}`;

    console.log(`[jd-api] pg${pg} s_new.php 请求中...`);
    let response;
    try {
      response = await jdApiRequest(searchUrl, cookieHeader);
    } catch (e) {
      console.log(`[jd-api] 请求失败: ${e.message}`);
      break;
    }

    if (response.status !== 200) {
      console.log(`[jd-api] HTTP ${response.status} — 停止`);
      break;
    }

    const body = response.body || "";

    // Check for JSON error response (JD API gateway error)
    if (body.startsWith("{") && body.includes("errorCode")) {
      console.log(`[jd-api] JSON错误响应: ${body.slice(0, 150)}`);
      break;
    }

    // Check for anti-bot signals in the response
    if (body.includes("访问频繁") || body.includes("请稍后再试")) {
      console.log(`[jd-api] 检测到rate_limit — 停止`);
      break;
    }
    if (body.includes("passport.jd.com") && body.includes("login")) {
      console.log(`[jd-api] 检测到login_wall — 停止`);
      break;
    }
    if (body.length < 300 && (body.includes("login") || body.includes("redirect"))) {
      console.log(`[jd-api] 疑似重定向/登录跳转 — 停止`);
      break;
    }

    const productCount = (body.match(/class="gl-item"/g) || []).length;
    console.log(`[jd-api] pg${pg} 响应: ${body.length} 字节, 约${productCount}个商品`);
    // Log body preview when response is substantial but no gl-item found
    if (body.length > 1000 && productCount === 0) {
      const preview = body.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/\s+/g, " ").slice(0, 500);
      console.log(`[jd-api] pg${pg} 内容预览: ${preview}`);
    }

    const products = extractProductsFromHtml(body);
    if (products.length === 0) break;

    allProducts.push(...products);
    console.log(`[jd-api] pg${pg} 提取: ${products.length} 个商品`);

    if (products.length < 20) break;
    await new Promise(r => setTimeout(r, 1000 + Math.random() * 1500));
  }

  return allProducts;
}

// Mobile search API (so.m.jd.com) — different gateway, may bypass desktop rate limits
async function searchJdMobileApi(cookieHeader, brandName, maxPages = 1) {
  const allProducts = [];

  for (let pg = 1; pg <= maxPages; pg++) {
    const url = `https://so.m.jd.com/ware/search.action?keyword=${encodeURIComponent(brandName)}&page=${pg}&s=${(pg - 1) * 30}`;

    console.log(`[jd-mobile] pg${pg} 请求中...`);
    let response;
    try {
      response = await jdApiRequest(url, cookieHeader, "https://so.m.jd.com/");
    } catch (e) {
      console.log(`[jd-mobile] 请求失败: ${e.message}`);
      break;
    }

    if (response.status !== 200) {
      console.log(`[jd-mobile] HTTP ${response.status} — 停止`);
      break;
    }

    const body = response.body || "";

    // Check for errors
    if (body.startsWith("{") && body.includes("errorCode")) {
      console.log(`[jd-mobile] JSON错误: ${body.slice(0, 150)}`);
      break;
    }
    if (body.includes("访问频繁") || body.includes("请稍后再试")) {
      console.log(`[jd-mobile] 检测到rate_limit — 停止`);
      break;
    }

    console.log(`[jd-mobile] pg${pg} 响应: ${body.length} 字节`);
    // Log body preview for debugging
    const bodyPreview = body.slice(0, 600).replace(/\s+/g, " ");
    console.log(`[jd-mobile] pg${pg} 内容: ${bodyPreview}`);

    // Mobile API returns JSON
    if (body.startsWith("{") || body.startsWith("[")) {
      try {
        const json = JSON.parse(body);
        // Try various JSON paths
        const wareList = json.wareList || json.data?.wareList || json.data?.products || json.products || [];
        if (Array.isArray(wareList) && wareList.length > 0) {
          const products = wareList.map(w => ({
            name: (w.wareName || w.name || w.title || "").trim(),
            price: String(w.jdPrice || w.price || w.displayPrice || ""),
            shop: (w.shopName || w.shop || "").trim(),
            isSelfOperated: !!(w.selfOperated || w.isSelf || (w.shopName && w.shopName.includes("自营"))),
            reviews: String(w.goodComments || w.comments || w.commentCount || ""),
            sku: String(w.wareId || w.skuId || w.sku || ""),
            imgSrc: (w.imageurl || w.imgUrl || w.image || ""),
          }));
          allProducts.push(...products);
          console.log(`[jd-mobile] pg${pg} 提取: ${products.length} 个商品 (JSON)`);
          if (products.length < 20) break;
          await new Promise(r => setTimeout(r, 1000 + Math.random() * 1500));
          continue;
        }
      } catch (e) {
        // Not valid JSON, try HTML parsing
      }
    }

    // Fallback: mobile API returned HTML
    const products = extractProductsFromHtml(body);
    if (products.length === 0) break;
    allProducts.push(...products);
    console.log(`[jd-mobile] pg${pg} 提取: ${products.length} 个商品 (HTML)`);
    if (products.length < 20) break;
    await new Promise(r => setTimeout(r, 1000 + Math.random() * 1500));
  }

  return allProducts;
}

function extractProductsFromHtml(html) {
  const results = [];
  // Match each gl-item block
  const itemRegex = /<li\s[^>]*class="gl-item"[^>]*data-sku="(\d*)"[^>]*>([\s\S]*?)<\/li>/gi;
  let match;

  while ((match = itemRegex.exec(html)) !== null) {
    const sku = match[1];
    const block = match[2];

    // Name: from p-name or data-title
    let name = "";
    const nameMatch = block.match(/<em>([\s\S]*?)<\/em>/);
    if (nameMatch) {
      name = nameMatch[1].replace(/<[^>]+>/g, "").trim();
    }
    if (!name) {
      const dtMatch = block.match(/data-title="([^"]*)"/);
      if (dtMatch) name = dtMatch[1].trim();
    }
    if (!name || name.length < 3) continue;

    // Price
    let price = "";
    const priceMatch = block.match(/<i>([\d.]+)<\/i>/);
    if (priceMatch) {
      price = priceMatch[1];
    } else {
      const p2 = block.match(/<strong>([\d.]+)<\/strong>/);
      if (p2) price = p2[1];
    }
    if (!price) {
      // Try broader price extraction
      const p3 = block.match(/¥\s*([\d.]+)/);
      if (p3) price = p3[1];
    }

    // Shop
    let shop = "";
    const shopMatch = block.match(/class="[^"]*shop[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
    if (shopMatch) {
      shop = shopMatch[1].replace(/<[^>]+>/g, "").trim();
    }
    const isSelf = !!(block.includes("自营") || block.includes("i-self") || shop.includes("京东自营"));

    // Reviews
    let reviews = "";
    const commitMatch = block.match(/class="[^"]*commit[^"]*"[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i);
    if (commitMatch) {
      reviews = commitMatch[1].replace(/<[^>]+>/g, "").trim();
    }

    // Image
    let imgSrc = "";
    const imgMatch = block.match(/src="([^"]*\.(?:jpg|png|webp)[^"]*)"/i) || block.match(/data-lazy-img="([^"]*)"/i);
    if (imgMatch) imgSrc = imgMatch[1];

    results.push({ name, price, shop, isSelfOperated: isSelf, reviews, sku, imgSrc });
  }

  // Deduplicate by name
  const seen = new Set();
  return results.filter(r => {
    const key = (r.name || "").replace(/\s+/g, "").slice(0, 40);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── JD 商品搜索（浏览器 → 人类行为模拟） ────────────────────────

async function searchJdProducts(page, brandName, maxPages = 1) {
  const allProducts = [];

  for (let pg = 1; pg <= maxPages; pg++) {
    const searchUrl = `https://search.jd.com/Search?keyword=${encodeURIComponent(brandName)}&enc=utf-8&page=${2 * pg - 1}`;

    // First page: navigate like a human — go to JD home, type into search box
    if (pg === 1) {
      try {
        await page.goto("https://www.jd.com/", { waitUntil: "domcontentloaded", timeout: 20000 });
        await page.waitForTimeout(3000 + Math.random() * 2000);

        // Check if we're actually logged in on the homepage
        const homeUrl = page.url();
        if (homeUrl.includes("passport.jd.com")) {
          console.log(`[jd] 首页重定向到登录页 — 停止采集`);
          return allProducts;
        }

        // Use search form naturally — try multiple selectors
        const searchInput = await page.$("#key") || await page.$("#keyword") ||
                            await page.$("input[name='keyword']") || await page.$("input[type='text'][aria-label*='搜索']") ||
                            await page.$("#search-query") || await page.$(".search-input input") || await page.$(".text-input");
        if (searchInput) {
          console.log(`[jd] 找到搜索框, 输入中...`);
          // Force click and evaluate to bypass hidden element issues
          await searchInput.click({ force: true });
          await page.waitForTimeout(300 + Math.random() * 500);
          // Clear any default text via evaluate (bypasses visibility check)
          await searchInput.evaluate(el => { el.value = ""; el.dispatchEvent(new Event("input", { bubbles: true })); });
          await page.waitForTimeout(200 + Math.random() * 300);
          // Type character by character
          for (const char of brandName) {
            await page.keyboard.type(char);
            await page.waitForTimeout(50 + Math.random() * 150);
          }
          await page.waitForTimeout(500 + Math.random() * 800);

          // Press Enter and capture network traffic (both requests AND responses)
          const capturedResponses = [];
          const responseHandler = async (res) => {
            const url = res.url();
            if (url.includes("api.m.jd.com") || url.includes("search.jd.com/s_new") || url.includes("Search?keyword")) {
              try {
                const body = await res.text().catch(() => "");
                capturedResponses.push({ url: url.slice(0, 120), status: res.status(), len: body.length, preview: body.slice(0, 200) });
              } catch (_) {}
            }
          };
          page.on("response", responseHandler);
          await page.keyboard.press("Enter");

          // Wait for network activity to settle
          await page.waitForTimeout(2000);
          // Check if page navigated
          let pageNavigated = false;
          try {
            await page.waitForLoadState("domcontentloaded", { timeout: 8000 });
            pageNavigated = true;
          } catch (_) {}
          await page.waitForTimeout(2000);

          // Try to extract results if still on same page
          let resultsFound = false;
          if (!pageNavigated || page.url().includes("jd.com")) {
            for (let wait = 0; wait < 5; wait++) {
              try {
                const hasResults = await page.evaluate(() => {
                  const items = document.querySelectorAll("li.gl-item, [data-sku], .goods-item, .search-item");
                  return items.length >= 5 ? items.length : 0;
                }).catch(() => 0);
                if (hasResults > 0) { resultsFound = true; break; }
              } catch (_) { break; }
              await page.waitForTimeout(1000);
            }
          }
          page.off("response", responseHandler);
          console.log(`[jd] 捕获${capturedResponses.length}个API响应: [${capturedResponses.map(r => `${r.url.slice(0,80)} S=${r.status} L=${r.len}`).join(" | ")}]`);
          // Log any response with non-trivial content
          for (const r of capturedResponses) {
            if (r.len > 500 && !r.preview.includes("验证") && !r.preview.includes("captcha")) {
              console.log(`[jd] API预览[${r.url.slice(0,60)}]: ${r.preview.slice(0, 250)}`);
            }
          }
        }

        // Try extracting from current page (AJAX results may have loaded inline)
        if (!page.url().includes("search.jd.com")) {
          // First, try extracting products from the current homepage
          const inlineProducts = await page.evaluate(() => {
            const results = [];
            const allItems = document.querySelectorAll("li.gl-item, [data-sku], .goods-item, .search-item");
            allItems.forEach(item => {
              const nameEl = item.querySelector(".p-name em, .p-name a, [data-title], .title");
              const name = (nameEl?.textContent || "").trim();
              if (!name || name.length < 3) return;
              const priceEl = item.querySelector(".p-price i, .p-price, [class*='price']");
              const price = (priceEl?.textContent || "").trim();
              results.push({ name, price });
            });
            return results;
          });
          console.log(`[jd] 当前页提取商品: ${inlineProducts.length} 个`);

          if (inlineProducts.length >= 5) {
            // Found results on homepage — extract and continue
            console.log(`[jd] AJAX搜索结果已渲染，无需跳转`);
          } else {
            // No results found — try direct navigation as last resort
            console.log(`[jd] 搜索框未跳转，改用直接导航`);
            await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30000, referer: "https://www.jd.com/" });
            await page.waitForTimeout(5000);
          }
        }
      } catch (e) {
        // Navigation after Enter destroys execution context — this is expected!
        if (e.message && e.message.includes("Execution context was destroyed")) {
          console.log(`[jd] 搜索已触发页面跳转 (正常导航)`);
          // Page navigated — wait for it to settle
          try { await page.waitForLoadState("domcontentloaded", { timeout: 15000 }); } catch (_) {}
          await page.waitForTimeout(3000);
        } else {
          // Real error — log and continue
          console.log(`[jd] 搜索交互异常: ${e.message}`);
          // Check if page navigated anyway
          try { await page.waitForLoadState("domcontentloaded", { timeout: 5000 }); } catch (_) {}
          await page.waitForTimeout(2000);
        }
      }
    } else {
      try {
        await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30000, referer: "https://www.jd.com/" });
      } catch (e) { /* timeout ok */ }
      await page.waitForTimeout(4000 + Math.random() * 2000);
    }

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

      // Inline helpers — must be defined inside evaluate (browser context)
      function parseJdItem(item) {
        const nameEl = item.querySelector(".p-name em") ||
                       item.querySelector(".p-name a em") ||
                       item.querySelector(".p-name a") ||
                       item.querySelector(".p-name-type-2 a") ||
                       item.querySelector("[data-title]");
        const name = (nameEl?.textContent || nameEl?.getAttribute?.("data-title") || "").trim();
        if (!name || name.length < 3) return null;
        const priceEl = item.querySelector(".p-price i") ||
                        item.querySelector(".p-price strong") ||
                        item.querySelector(".p-price span") ||
                        item.querySelector(".p-price");
        const priceText = (priceEl?.textContent || "").trim();
        const shopEl = item.querySelector(".p-shop a") ||
                       item.querySelector(".p-shop span") ||
                       item.querySelector(".curr-shop") ||
                       item.querySelector("[class*='shop'] a") ||
                       item.querySelector("[class*='shop'] span");
        const shop = (shopEl?.textContent || "").trim();
        const isSelf = !!item.querySelector(".p-icons i-self") ||
                       !!item.querySelector(".p-icon-self") ||
                       !!item.querySelector("[class*='self']") ||
                       (shop && (shop.includes("自营") || shop.includes("京东自营")));
        const commitEl = item.querySelector(".p-commit strong a") ||
                         item.querySelector(".p-commit a") ||
                         item.querySelector("[class*='commit'] a");
        const reviewsText = (commitEl?.textContent || "").trim();
        const sku = item.getAttribute("data-sku") || "";
        const imgEl = item.querySelector(".p-img img");
        const imgSrc = imgEl?.getAttribute?.("src") ||
                       imgEl?.getAttribute?.("data-lazy-img") || "";
        return { name, price: priceText, shop, isSelfOperated: isSelf, reviews: reviewsText, sku, imgSrc };
      }

      function parseProductText(text) {
        const priceMatch = text.match(/[¥￥]\s*([\d.]+)/);
        if (!priceMatch) return null;
        const priceStr = priceMatch[1];
        const priceIdx = text.indexOf("¥") >= 0 ? text.indexOf("¥") : text.indexOf("￥");
        let name = priceIdx > 0 ? text.substring(0, priceIdx).trim() : text;
        if (name.length > 120) name = name.slice(0, 120);
        const reviewMatch = text.match(/([\d.]+万?)\+?\s*(条评价|评价|评论)/);
        const reviews = reviewMatch ? reviewMatch[1] : "";
        return { name, price: priceStr, shop: "", isSelfOperated: false, reviews, sku: "", imgSrc: "" };
      }

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

    // Login wall — only flag if on passport/login page, not JD homepage
    if (url.includes("passport.jd.com") || url.includes("plogin.m.jd.com")) {
      return { blocked: true, reason: "login_wall", detail: "需要登录京东账号" };
    }
    // JD homepage redirect with rate limiting (from=pc_search_sd)
    if (url.includes("www.jd.com/?from=pc_search")) {
      return { blocked: true, reason: "rate_limit", detail: "京东搜索限流，请稍后重试" };
    }

    // Rate limit — inline message on search page
    if (text.includes("访问频繁") || text.includes("无法搜索") || text.includes("请稍后再试")) {
      return { blocked: true, reason: "rate_limit", detail: "京东搜索限流，请稍后重试" };
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

async function collectBrandSnapshot(page, brandName, tenantId) {
  let products = [];

  // Primary: Browser-based human-like search with network interception
  products = (await searchJdProducts(page, brandName)) || [];

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
  searchJdViaApi,
  searchJdViaBrowserApi,
  searchJdMobileApi,
  extractProductsFromHtml,
  collectBrandSnapshot,
  compareSnapshots,
  detectJdPageState,
  saveSnapshot,
  loadSnapshot,
  today,
  localISO,
};
