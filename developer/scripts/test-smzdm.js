// Quick test: SMZDM search
const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    locale: "zh-CN",
  });
  const page = await ctx.newPage();

  // Try direct URL - SMZDM search uses this format
  const searchUrl = "https://search.smzdm.com/?c=home&s=Nike&v=a";
  console.log("Navigating to:", searchUrl);

  try {
    await page.goto(searchUrl, { waitUntil: "networkidle", timeout: 25000 });
  } catch(e) {
    console.log("Nav error:", e.message);
  }

  await page.waitForTimeout(5000);

  const curUrl = page.url();
  const curTitle = await page.title().catch(() => "");
  const text = await page.evaluate(() => (document.body?.innerText || "").slice(0, 1200));

  console.log("URL:", curUrl.slice(0, 120));
  console.log("Title:", curTitle);
  console.log("Body text length:", text.length);
  console.log("Preview:", text.slice(0, 600));
  console.log("");

  // Check for product data
  const cardInfo = await page.evaluate(() => {
    const results = [];
    // SMZDM specific selectors
    const selectors = [
      ".feed-card", ".feed-row-w", ".card-box",
      ".listItem", "[class*='feedCard']", "[class*='card']",
      "li[class*='item']", ".feed-block",
    ];
    for (const sel of selectors) {
      const count = document.querySelectorAll(sel).length;
      if (count > 0) results.push(`${sel}: ${count}`);
    }
    return results.join(", ") || "no cards found";
  });
  console.log("Cards:", cardInfo);

  // Try to find any price data in the page
  const hasPrice = await page.evaluate(() => {
    const body = document.body?.innerHTML || "";
    return {
      hasYuan: body.includes("元"),
      hasYen: body.includes("¥"),
      bodyLength: body.length,
    };
  });
  console.log("Page data:", JSON.stringify(hasPrice));

  await browser.close();
  console.log("Done");
})();
