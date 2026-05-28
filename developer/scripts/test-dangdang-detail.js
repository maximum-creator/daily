// Deep test: Dangdang product extraction
const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    locale: "zh-CN",
  });
  const page = await ctx.newPage();

  await page.goto("https://search.dangdang.com/?key=Nike", {
    waitUntil: "domcontentloaded", timeout: 20000
  });
  await page.waitForTimeout(3000);

  // Extract structured product data
  const products = await page.evaluate(() => {
    const results = [];
    const seen = new Set();

    // Find product containers - try multiple selectors
    const containers = document.querySelectorAll("li, .item, [class*=product], [class*=goods], [class*=result] li");

    for (const li of containers) {
      const text = (li.textContent || "").trim().replace(/\s+/g, " ");
      if (text.length < 30) continue;

      const key = text.slice(0, 60);
      if (seen.has(key)) continue;
      seen.add(key);

      // Name: from title or name elements
      let name = "";
      const nameEl = li.querySelector(".name, .title, [class*=name], [class*=title], a[title]");
      if (nameEl) {
        name = (nameEl.textContent || nameEl.getAttribute("title") || "").trim();
      }
      if (!name) {
        // Extract from link text
        const links = li.querySelectorAll("a");
        for (const a of links) {
          const t = (a.textContent || "").trim();
          if (t.length > 15 && t.length < 200) { name = t; break; }
        }
      }

      // Price
      const priceMatch = text.match(/¥\s*([\d.]+)/);
      const price = priceMatch ? priceMatch[1] : "";

      // Reviews/ratings
      const reviewMatch = text.match(/(\d+)\s*(?:条评价|评论|条评论)/);
      const reviews = reviewMatch ? reviewMatch[1] : "";

      // Shop info - dangdang is mostly self-operated
      let shop = "";
      const shopEl = li.querySelector("[class*=shop], [class*=store], [class*=seller]");
      if (shopEl) shop = (shopEl.textContent || "").trim();
      if (!shop) {
        const selfMatch = text.match(/(当当自营|自营)/);
        if (selfMatch) shop = "当当自营";
      }

      // Product URL
      const linkEl = li.querySelector("a[href*='product.dangdang.com']");
      const linkUrl = linkEl?.getAttribute("href") || "";

      // Image
      const imgEl = li.querySelector("img");
      const imgSrc = imgEl?.getAttribute("src") || imgEl?.getAttribute("data-src") || imgEl?.getAttribute("data-original") || "";

      if (name && price) {
        results.push({
          name: name.slice(0, 150),
          price,
          reviews: parseInt(reviews, 10) || 0,
          reviewsDisplay: reviews ? `${reviews}条评价` : "",
          shop: shop || "未识别",
          goodsId: "",
          imgSrc,
          linkUrl,
        });
      }

      if (results.length >= 60) break;
    }

    return results;
  });

  console.log(`Extracted ${products.length} products:\n`);
  products.slice(0, 10).forEach((p, i) => {
    console.log(`[${i + 1}] ${p.name.slice(0, 60)}`);
    console.log(`    Price: ¥${p.price} | Shop: ${p.shop} | Reviews: ${p.reviewsDisplay}`);
  });

  // Raw HTML sample of first product
  const sampleHTML = await page.evaluate(() => {
    const links = document.querySelectorAll("a[href*='product.dangdang.com']");
    if (links.length > 0) {
      const parent = links[0].closest("li") || links[0].parentElement?.parentElement;
      return parent ? parent.outerHTML.slice(0, 2000) : links[0].outerHTML.slice(0, 1000);
    }
    return "no product links found";
  });
  console.log("\n=== Sample product HTML ===");
  console.log(sampleHTML);

  // Check pagination
  const pageInfo = await page.evaluate(() => {
    const text = document.body?.innerText || "";
    const totalMatch = text.match(/共\s*(\d+)\s*件/);
    const pageMatch = text.match(/(\d+)\/(\d+)/);
    return {
      totalItems: totalMatch ? totalMatch[1] : "unknown",
      pageInfo: pageMatch ? `${pageMatch[1]}/${pageMatch[2]}` : "unknown",
      productLinks: document.querySelectorAll("a[href*='product.dangdang.com']").length,
    };
  });
  console.log("\nPagination:", JSON.stringify(pageInfo));

  await browser.close();
})();
