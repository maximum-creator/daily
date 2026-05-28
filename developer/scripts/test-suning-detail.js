// Deep test: Suning product extraction
const { chromium } = require("playwright");
const fs = require("fs");

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    locale: "zh-CN",
  });
  const page = await ctx.newPage();

  await page.goto("https://search.suning.com/Nike/", { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.waitForTimeout(3000);

  // Extract products from the page
  const products = await page.evaluate(() => {
    const results = [];
    // Suning uses li.product elements
    const items = document.querySelectorAll("li.product, li[class*=product], .product-item, .item-wrap, [class*=result] li");

    items.forEach((item, i) => {
      const text = (item.textContent || "").trim().replace(/\s+/g, " ");
      if (text.length < 20) return;

      // Extract structured data
      const nameEl = item.querySelector(".title-selling-point, .title, [class*=title], [class*=name], a[title]");
      const priceEl = item.querySelector(".price, [class*=price] span, .def-price, .sales-price");
      const storeEl = item.querySelector(".store-name, [class*=store], [class*=shop], [class*=seller]");
      const salesEl = item.querySelector("[class*=comment], [class*=sales], [class*=count]");
      const imgEl = item.querySelector("img");

      const name = (nameEl?.textContent || nameEl?.getAttribute("title") || "").trim();
      const price = (priceEl?.textContent || "").replace(/[¥￥]/g, "").trim();
      const store = (storeEl?.textContent || "").trim();
      const img = imgEl?.getAttribute("src") || imgEl?.getAttribute("data-src") || "";

      if (name && price) {
        results.push({ name: name.slice(0, 80), price, store: store.slice(0, 30), img: img.slice(0, 60) });
      }
    });

    return results.slice(0, 10);
  });

  console.log(`Found ${products.length} products:\n`);
  products.forEach((p, i) => console.log(`[${i+1}] ${p.name}\n    Price: ${p.price} | Store: ${p.store}`));

  // Also grab the raw HTML of one product item for reference
  const sampleHTML = await page.evaluate(() => {
    const el = document.querySelector("li.product, li[class*=product]");
    return el ? el.outerHTML.slice(0, 1500) : "not found";
  });
  console.log("\n=== Sample product HTML ===");
  console.log(sampleHTML);

  // Check if there are "no results" patterns
  const noResults = await page.evaluate(() => {
    const text = document.body.innerText;
    return {
      hasNoResult: text.includes("没有找到") || text.includes("无结果"),
      totalItems: document.querySelectorAll("li.product, li[class*=product]").length,
    };
  });
  console.log("\nNo results:", noResults.hasNoResult, "| Product LIs:", noResults.totalItems);

  await browser.close();
})();
