// Test new candidate platforms for competitive intelligence expansion
const { chromium } = require("playwright");

async function testPlatform(name, url, opts = {}) {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: opts.mobileUA
      ? "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1"
      : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    locale: "zh-CN",
  });
  const page = await ctx.newPage();

  console.log(`\n=== ${name} ===`);
  console.log("URL:", url);

  try {
    await page.goto(url, { waitUntil: opts.waitUntil || "domcontentloaded", timeout: 25000 });
  } catch(e) {
    console.log("  Nav error:", e.message);
  }

  await page.waitForTimeout(opts.wait || 4000);

  const curUrl = page.url();
  const title = await page.title().catch(() => "");
  const text = await page.evaluate(() => (document.body?.innerText || "").slice(0, 1000));
  const htmlLen = await page.evaluate(() => (document.body?.innerHTML || "").length);

  console.log("  Current URL:", curUrl.slice(0, 120));
  console.log("  Title:", title.slice(0, 80));
  console.log("  Body text:", text.length, "chars | HTML:", htmlLen, "chars");
  console.log("  Preview:", text.slice(0, 250).replace(/\n/g, " "));

  // Check for signs of blocking
  const blocked = text.includes("验证") || text.includes("滑块") || text.includes("拦截")
    || text.includes("访问太频繁") || text.includes("稍后再试")
    || curUrl.includes("login") || curUrl.includes("verify") || curUrl.includes("captcha");

  // Product card detection
  const cardStats = await page.evaluate(() => {
    const stats = {};
    const selectors = [
      "li[class*=product]", "li[class*=item]", "[class*=productCard]",
      "[class*=goods]", "[class*=card]", ".product-item", ".offer-item",
      "[class*=result] li", ".search-result li", ".goods-list li",
      "a[href*=item]", "a[href*=product]", "a[href*=detail]",
    ];
    for (const sel of selectors) {
      const n = document.querySelectorAll(sel).length;
      if (n > 0) stats[sel] = n;
    }
    return stats;
  });

  // Price detection
  const priceData = await page.evaluate(() => {
    const body = document.body?.innerHTML || "";
    const priceMatches = body.match(/¥\s*\d+\.?\d*/g) || [];
    const yenMatches = body.match(/￥\s*\d+\.?\d*/g) || [];
    const yuanMatches = body.match(/\d+\.?\d*\s*元/g) || [];
    return {
      priceCount: priceMatches.length + yenMatches.length,
      priceSample: [...new Set([...priceMatches, ...yenMatches].slice(0, 8))],
      hasYuan: yuanMatches.length > 0,
    };
  });

  console.log("  Cards:", JSON.stringify(cardStats));
  console.log("  Prices:", JSON.stringify(priceData));
  console.log("  Blocked:", blocked ? "YES ⚠" : "No");

  await browser.close();
  return { name, textLen: text.length, htmlLen, blocked, cardCount: Object.values(cardStats).reduce((a,b)=>a+b,0), priceCount: priceData.priceCount };
}

(async () => {
  console.log("Testing new candidate platforms for competitive intelligence...\n");

  const results = [];

  // 1. 1688 (Alibaba B2B) — wholesale pricing, massive value
  results.push(await testPlatform("1688批发",
    "https://s.1688.com/selloffer/offer_search.htm?keywords=Nike&n=y",
    { waitUntil: "networkidle", wait: 5000 }
  ));

  // 2. 得物 — sneaker/streetwear authenticator marketplace
  results.push(await testPlatform("得物 (Dewu)",
    "https://dewu.com/search?keyword=Nike",
    { waitUntil: "networkidle", wait: 5000 }
  ));

  // 3. 唯品会 — discount retail
  results.push(await testPlatform("唯品会 (VIP)",
    "https://www.vip.com/search?keyword=Nike",
    { waitUntil: "networkidle", wait: 5000 }
  ));

  // 4. 考拉海购 — cross-border
  results.push(await testPlatform("考拉海购",
    "https://www.kaola.com/search.html?key=Nike",
    { waitUntil: "networkidle", wait: 5000 }
  ));

  // 5. 当当 — books + general retail
  results.push(await testPlatform("当当",
    "https://search.dangdang.com/?key=Nike",
    { waitUntil: "networkidle", wait: 5000 }
  ));

  // 6. 国美 — electronics
  results.push(await testPlatform("国美",
    "https://search.gome.com.cn/search?question=Nike",
    { waitUntil: "networkidle", wait: 5000 }
  ));

  // 7. 小米有品 — Xiaomi ecosystem
  results.push(await testPlatform("小米有品",
    "https://www.xiaomiyoupin.com/search?key=Nike",
    { waitUntil: "networkidle", wait: 5000 }
  ));

  // 8. 什么值得买 — deal/coupon aggregator (retry with mobile UA)
  results.push(await testPlatform("什么值得买 (mobile)",
    "https://m.smzdm.com/search/?s=Nike",
    { mobileUA: true, waitUntil: "networkidle", wait: 5000 }
  ));

  console.log("\n\n=== SUMMARY ===");
  console.log("Platform".padEnd(20), "Text".padEnd(8), "HTML".padEnd(10), "Cards".padEnd(8), "Prices".padEnd(8), "Blocked");
  console.log("-".repeat(70));
  for (const r of results) {
    const name = r.name.slice(0, 18).padEnd(20);
    const text = String(r.textLen).padEnd(8);
    const html = (r.htmlLen > 1000 ? Math.round(r.htmlLen/1000)+"k" : String(r.htmlLen)).padEnd(10);
    const cards = String(r.cardCount).padEnd(8);
    const prices = String(r.priceCount).padEnd(8);
    const blocked = r.blocked ? "⚠ BLOCKED" : "OK";
    console.log(name + text + html + cards + prices + blocked);
  }

  const viable = results.filter(r => !r.blocked && r.cardCount > 5 && r.priceCount > 3);
  console.log(`\nViable new platforms: ${viable.length}`);
  viable.forEach(v => console.log(`  ✅ ${v.name}: ${v.cardCount} cards, ${v.priceCount} prices`));
})();
