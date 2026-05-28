// Test: Use existing persistent profile (with real TMall cookies) in headless mode
const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

const PROFILES_DIR = path.join(__dirname, "..", "browser-profiles");

(async () => {
  // Test with demo tenant's real profile (has TMall login cookies)
  const userDataDir = path.join(PROFILES_DIR, "demo");

  if (!fs.existsSync(userDataDir)) {
    console.log("Profile not found:", userDataDir);
    console.log("Need to login via headed browser first!");
    return;
  }

  // Check for cookies
  const cookieFiles = fs.readdirSync(userDataDir).filter(f => f.startsWith("cookies-"));
  console.log("Cookie files:", cookieFiles.join(", ") || "none");

  console.log("\n=== Test 1: Persistent context (headless) with real profile ===");
  let context;
  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: true,
      viewport: { width: 1280, height: 720 },
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai",
      args: [
        "--disable-blink-features=AutomationControlled",
        "--disable-automation",
        "--no-sandbox",
      ],
    });

    // Add stealth init script
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
      Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, "languages", { get: () => ["zh-CN", "zh", "en"] });
      Object.defineProperty(navigator, "hardwareConcurrency", { get: () => 8 });
      Object.defineProperty(navigator, "deviceMemory", { get: () => 8 });
      window.chrome = { runtime: {} };
    });

    // Check cookie count
    const cookies = await context.cookies();
    const tmallCookies = cookies.filter(c => c.domain?.includes("taobao") || c.domain?.includes("tmall"));
    console.log("Total cookies:", cookies.length, "| TMall cookies:", tmallCookies.length);

    const page = await context.newPage();

    await page.goto("https://s.taobao.com/search?q=Nike&tab=mall", {
      waitUntil: "domcontentloaded", timeout: 20000
    });
    await page.waitForTimeout(5000);

    // Diagnostics
    const diag = await page.evaluate(() => {
      const body = document.body?.innerText || "";
      const links = document.querySelectorAll("a[href*='detail.tmall.com'], a[href*='item.taobao.com']");
      const priceMatches = body.match(/¥\s*\d+\.?\d*/g) || [];
      return {
        bodyLen: body.length,
        tmallLinks: links.length,
        priceCount: priceMatches.length,
        priceSample: priceMatches.slice(0, 5),
        hasLoading: body.includes("加载中"),
        textPreview: body.slice(0, 300),
      };
    });

    console.log("Body text:", diag.bodyLen);
    console.log("TMall links:", diag.tmallLinks);
    console.log("Price matches:", diag.priceCount);
    console.log("Still loading:", diag.hasLoading);
    console.log("Text:", diag.textPreview.replace(/\n/g, " "));

    await context.close();
  } catch(e) {
    console.log("Error:", e.message);
    if (context) await context.close().catch(() => {});
  }

  // Test 2: Try playwright-extra stealth if available
  console.log("\n=== Test 2: playwright-extra stealth (if installed) ===");
  try {
    require.resolve("playwright-extra");
    require.resolve("puppeteer-extra-plugin-stealth");
    console.log("playwright-extra stealth available!");
  } catch(e) {
    console.log("playwright-extra not installed. Install with:");
    console.log("  npm install playwright-extra puppeteer-extra-plugin-stealth");
  }

  // Test 3: Headless with --disable-gpu (might change WebGL fingerprint)
  console.log("\n=== Test 3: Headless + disable-gpu + window position spoof ===");
  try {
    const browser = await chromium.launch({
      headless: true,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--disable-automation",
        "--no-sandbox",
        "--disable-gpu",
        "--use-gl=angle",
        "--use-angle=swiftshader",
      ],
    });
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai",
    });
    await ctx.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
      Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, "languages", { get: () => ["zh-CN", "zh", "en"] });
      Object.defineProperty(navigator, "hardwareConcurrency", { get: () => 8 });
      Object.defineProperty(navigator, "deviceMemory", { get: () => 8 });
      window.chrome = { runtime: {} };
    });
    const page = await ctx.newPage();
    await page.goto("https://s.taobao.com/search?q=Nike&tab=mall", {
      waitUntil: "domcontentloaded", timeout: 20000
    });
    await page.waitForTimeout(5000);

    const diag = await page.evaluate(() => {
      const body = document.body?.innerText || "";
      const links = document.querySelectorAll("a[href*='detail.tmall.com'], a[href*='item.taobao.com']");
      const priceMatches = body.match(/¥\s*\d+\.?\d*/g) || [];
      return {
        bodyLen: body.length,
        tmallLinks: links.length,
        priceCount: priceMatches.length,
        textPreview: body.slice(0, 200),
      };
    });

    console.log("TMall links:", diag.tmallLinks);
    console.log("Price matches:", diag.priceCount);
    console.log("Text:", diag.textPreview.replace(/\n/g, " "));

    await browser.close();
  } catch(e) {
    console.log("Error:", e.message);
  }

  console.log("\n=== DONE ===");
})();
