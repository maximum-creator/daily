// Test: playwright-extra + stealth plugin against TMall
const playwrightExtra = require("playwright-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");

// The stealth plugin patches WebGL, permissions, plugins, etc.
playwrightExtra.chromium.use(StealthPlugin());

(async () => {
  console.log("=== Test: playwright-extra + stealth (ALL evasions) ===\n");

  // Test 1: Fresh stealth context
  const browser1 = await playwrightExtra.chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
    ],
  });
  const ctx1 = await browser1.newContext({
    viewport: { width: 1280, height: 720 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
  });
  const page1 = await ctx1.newPage();

  try {
    await page1.goto("https://s.taobao.com/search?q=Nike&tab=mall", {
      waitUntil: "domcontentloaded", timeout: 20000
    });
  } catch(e) {
    console.log("Nav error:", e.message);
  }
  await page1.waitForTimeout(5000);

  const r1 = await page1.evaluate(() => {
    const body = document.body?.innerText || "";
    const links = document.querySelectorAll("a[href*='detail.tmall.com'], a[href*='item.taobao.com']");
    const priceMatches = body.match(/¥\s*\d+\.?\d*/g) || [];
    // Check stealth patches
    let webglInfo = "N/A";
    try {
      const c = document.createElement("canvas");
      const gl = c.getContext("webgl");
      if (gl) {
        const ext = gl.getExtension("WEBGL_debug_renderer_info");
        if (ext) webglInfo = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
      }
    } catch(e) { webglInfo = "error"; }
    return {
      bodyLen: body.length,
      tmallLinks: links.length,
      priceCount: priceMatches.length,
      priceSample: priceMatches.slice(0, 5),
      webdriver: navigator.webdriver,
      webgl: webglInfo?.slice(0, 80),
      textPreview: body.slice(0, 250),
    };
  });

  console.log("Webdriver:", r1.webdriver);
  console.log("WebGL:", r1.webgl);
  console.log("TMall links:", r1.tmallLinks);
  console.log("Price matches:", r1.priceCount);
  console.log("Text:", r1.textPreview.replace(/\n/g, " "));

  await browser1.close();

  // Test 2: Stealth + persistent profile (combine both)
  console.log("\n=== Test 2: Stealth + persistent profile ===");
  const path = require("path");
  const userDataDir = path.join(__dirname, "..", "browser-profiles", "demo");

  const browser2 = await playwrightExtra.chromium.launchPersistentContext(userDataDir, {
    headless: true,
    viewport: { width: 1280, height: 720 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
    ],
  });

  const pages2 = browser2.pages();
  const page2 = pages2.length > 0 ? pages2[0] : await browser2.newPage();

  try {
    await page2.goto("https://s.taobao.com/search?q=Nike&tab=mall", {
      waitUntil: "domcontentloaded", timeout: 20000
    });
  } catch(e) {
    console.log("Nav error:", e.message);
  }
  await page2.waitForTimeout(5000);

  const r2 = await page2.evaluate(() => {
    const body = document.body?.innerText || "";
    const links = document.querySelectorAll("a[href*='detail.tmall.com'], a[href*='item.taobao.com']");
    const priceMatches = body.match(/¥\s*\d+\.?\d*/g) || [];
    return {
      bodyLen: body.length,
      tmallLinks: links.length,
      priceCount: priceMatches.length,
      priceSample: priceMatches.slice(0, 5),
      textPreview: body.slice(0, 250),
    };
  });

  console.log("TMall links:", r2.tmallLinks);
  console.log("Price matches:", r2.priceCount);
  if (r2.priceSample.length > 0) console.log("Prices:", r2.priceSample);

  await browser2.close();

  // Summary
  console.log("\n=== SUMMARY ===");
  if (r1.tmallLinks > 0 || r2.tmallLinks > 0) {
    console.log("✅ TMALL HEADLESS WORKS with stealth plugin!");
    console.log("   Test 1 (stealth):", r1.tmallLinks, "links");
    console.log("   Test 2 (stealth+profile):", r2.tmallLinks, "links");
  } else {
    console.log("❌ Still 0 products. TMall headless may be fundamentally blocked.");
    console.log("   Last resort options:");
    console.log("   1. Use headed mode and minimize window");
    console.log("   2. Use Edge browser channel instead of Chromium");
    console.log("   3. Accept that TMall requires headed mode");
  }
})();
