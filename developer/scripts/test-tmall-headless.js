// Diagnostic: Find exactly what TMall detects in headless mode
const { chromium } = require("playwright");

async function testConfig(label, browserOpts, contextOpts = {}) {
  console.log(`\n=== ${label} ===`);
  const browser = await chromium.launch(browserOpts);
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    ...contextOpts,
  });

  // Add init script for stealth
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, "languages", { get: () => ["zh-CN", "zh", "en"] });
    Object.defineProperty(navigator, "hardwareConcurrency", { get: () => 8 });
    Object.defineProperty(navigator, "deviceMemory", { get: () => 8 });
    window.chrome = { runtime: {} };
  });

  const page = await ctx.newPage();

  // Navigate to TMall search
  try {
    await page.goto("https://s.taobao.com/search?q=Nike&tab=mall", {
      waitUntil: "domcontentloaded", timeout: 20000
    });
  } catch(e) {
    console.log("  Nav error:", e.message);
  }

  await page.waitForTimeout(5000);

  const currentUrl = page.url();
  const title = await page.title().catch(() => "");

  // Check fingerprint diagnostics
  const diag = await page.evaluate(() => {
    const results = {};

    // Basic navigator properties
    results.webdriver = navigator.webdriver;
    results.pluginsLength = navigator.plugins?.length;
    results.languages = navigator.languages;
    results.hardwareConcurrency = navigator.hardwareConcurrency;
    results.deviceMemory = navigator.deviceMemory;
    results.platform = navigator.platform;
    results.vendor = navigator.vendor;
    results.maxTouchPoints = navigator.maxTouchPoints;

    // WebGL fingerprint
    try {
      const canvas = document.createElement("canvas");
      const gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
      if (gl) {
        const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
        results.webglVendor = debugInfo ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) : "extension not available";
        results.webglRenderer = debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : "extension not available";
      } else {
        results.webgl = "not supported";
      }
    } catch(e) {
      results.webglError = e.message;
    }

    // Check for AutomationControlled
    results.automationControlled = navigator.userAgent.includes("HeadlessChrome");

    // Check permissions
    results.permissions = {};
    try {
      navigator.permissions?.query({ name: "notifications" }).then(r => {
        results.permissions.notifications = r.state;
      }).catch(() => {});
    } catch(e) {}

    // Check if chrome object exists properly
    results.hasChrome = typeof window.chrome !== "undefined";
    results.chromeRuntime = typeof window.chrome?.runtime !== "undefined";

    // Screen/display properties
    results.screenWidth = screen.width;
    results.screenHeight = screen.height;
    results.screenColorDepth = screen.colorDepth;
    results.devicePixelRatio = window.devicePixelRatio;

    // Check for common anti-bot signals in DOM
    const body = document.body?.innerHTML || "";
    results.hasCaptcha = body.includes("captcha") || body.includes("验证");
    results.hasBlock = body.includes("block") || body.includes("拦截");

    // Product detection
    const productLinks = document.querySelectorAll("a[href*='detail.tmall.com'], a[href*='item.taobao.com']");
    results.tmallLinks = productLinks.length;
    results.linkSample = [];
    for (let i = 0; i < Math.min(3, productLinks.length); i++) {
      results.linkSample.push(productLinks[i].href.slice(0, 80));
    }

    // Check for price data
    const priceEls = document.querySelectorAll("[class*=price]");
    results.priceElements = priceEls.length;
    const priceMatches = (document.body?.innerText || "").match(/¥\s*\d+\.?\d*/g) || [];
    results.priceMatchCount = priceMatches.length;

    // Key: does page return search results or is it empty/blocked?
    results.bodyTextLen = (document.body?.innerText || "").length;
    results.bodyTextPreview = (document.body?.innerText || "").slice(0, 300);

    return results;
  });

  console.log("  URL:", currentUrl.slice(0, 100));
  console.log("  Title:", title.slice(0, 80));
  console.log("  Body text length:", diag.bodyTextLen);
  console.log("  TMall links:", diag.tmallLinks);
  console.log("  Price matches:", diag.priceMatchCount);
  console.log("  Price elements:", diag.priceElements);
  console.log("  WebGL:", diag.webglVendor, "|", diag.webglRenderer?.slice(0, 60));
  console.log("  AutomationControlled:", diag.automationControlled);
  console.log("  webdriver:", diag.webdriver);
  console.log("  plugins:", diag.pluginsLength);
  console.log("  screen:", diag.screenWidth, "x", diag.screenHeight, "@", diag.devicePixelRatio);

  if (diag.linkSample.length > 0) {
    console.log("  Link sample:", diag.linkSample[0]);
  }
  if (diag.bodyTextLen > 0) {
    console.log("  Text preview:", diag.bodyTextPreview.replace(/\n/g, " "));
  }

  await browser.close();
  return {
    label,
    tmallLinks: diag.tmallLinks,
    priceMatchCount: diag.priceMatchCount,
    bodyTextLen: diag.bodyTextLen,
    webglVendor: diag.webglVendor,
    webglRenderer: diag.webglRenderer,
  };
}

(async () => {
  // Test 1: Default headless (current behavior)
  const r1 = await testConfig("Default headless", { headless: true });

  // Test 2: Headless with extra args to hide headless
  const r2 = await testConfig("Headless + extra args", {
    headless: true,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-automation",
      "--no-sandbox",
    ],
  });

  // Test 3: Headless with headless=new (updated headless mode)
  const r3 = await testConfig("Headless=new mode", {
    headless: true,
    channel: undefined,
  }, {});

  // Test 4: Headless with deviceScaleFactor
  const r4 = await testConfig("Headless + deviceScaleFactor 2", {
    headless: true,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-automation",
    ],
  }, {
    deviceScaleFactor: 2,
  });

  console.log("\n\n=== SUMMARY ===");
  [r1, r2, r3, r4].forEach(r => {
    const status = r.tmallLinks > 0 ? "✅ HAS DATA" : "❌ NO DATA";
    console.log(`${r.label.padEnd(35)} | ${String(r.tmallLinks).padStart(3)} links | ${String(r.priceMatchCount).padStart(3)} prices | ${r.webglVendor?.slice(0,20) || "N/A"} | ${status}`);
  });

  if ([r1,r2,r3,r4].every(r => r.tmallLinks === 0)) {
    console.log("\n⚠ ALL HEADLESS CONFIGS FAIL. TMall's detection is deeper than just AutomationControlled flag.");
    console.log("May need to try:");
    console.log("  1. playwright stealth plugin (playwright-extra + stealth)");
    console.log("  2. Different Chromium channel (Edge instead of Chrome)");
    console.log("  3. Persistent context with real user profile");
  }
})();
