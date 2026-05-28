// Test alternative platforms for competitive intelligence
const { chromium } = require("playwright");

async function testPlatform(name, url) {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    locale: "zh-CN",
  });
  const page = await ctx.newPage();

  console.log(`\n=== ${name} ===`);
  console.log("URL:", url);

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForTimeout(5000);
  } catch(e) {
    console.log("  Nav error:", e.message);
  }

  const curUrl = page.url();
  const title = await page.title().catch(() => "");
  const text = await page.evaluate(() => (document.body?.innerText || "").slice(0, 600));
  const htmlLen = await page.evaluate(() => (document.body?.innerHTML || "").length);

  console.log("  Current URL:", curUrl.slice(0, 100));
  console.log("  Title:", title);
  console.log("  Body text:", text.length, "chars | HTML:", htmlLen, "chars");
  console.log("  Preview:", text.slice(0, 200));

  // Check for products
  const cards = await page.evaluate(() => {
    const counts = {};
    for (const sel of ["[class*=item]", "[class*=product]", "[class*=goods]", "[class*=card]", "li", ".result-item"]) {
      const n = document.querySelectorAll(sel).length;
      if (n > 0) counts[sel] = n;
    }
    return counts;
  });
  console.log("  Elements:", JSON.stringify(cards));

  await browser.close();
  return { name, textLen: text.length, htmlLen };
}

(async () => {
  // Test 苏宁
  await testPlatform("苏宁易购", "https://search.suning.com/Nike/");

  // Test 1688
  await testPlatform("1688", "https://s.1688.com/selloffer/offer_search.htm?keywords=Nike");

  // Test SMZDM with headed mode
  console.log("\n=== SMZDM (headed) ===");
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    locale: "zh-CN",
  });
  const page = await ctx.newPage();
  try {
    await page.goto("https://search.smzdm.com/?c=home&s=Nike", { waitUntil: "networkidle", timeout: 25000 });
    await page.waitForTimeout(5000);
    const text = await page.evaluate(() => (document.body?.innerText || "").slice(0, 600));
    console.log("  text length:", text.length);
    console.log("  preview:", text.slice(0, 300));
  } catch(e) { console.log("  error:", e.message); }
  await browser.close();
})();
