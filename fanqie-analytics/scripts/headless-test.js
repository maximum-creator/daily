#!/usr/bin/env node
/**
 * Headless Playwright 可行性验证
 *
 * 测试目标：
 * 1. 纯 headless Chromium 能否访问番茄小说（不被反爬拦截）
 * 2. 从 Edge CDP 导出 cookie 后，headless 能否继承登录态
 * 3. storageState 持久化 + 恢复是否正常
 *
 * Usage: node scripts/headless-test.js
 */

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const http = require("http");

const CDP_URL = "http://localhost:9222";
const STORAGE_DIR = path.join(__dirname, "..", "storage");
const TEST_TENANT = "headless_test";

// ── Test 1: Fresh headless browser ──
async function testFreshHeadless() {
  console.log("━━━ 测试 1: 纯 Headless Chromium ━━━");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto("https://fanqienovel.com/main/writer/home", {
      waitUntil: "networkidle",
      timeout: 30000,
    });
    await page.waitForTimeout(3000);

    const url = page.url();
    const title = await page.title();
    const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 500) || "");

    console.log(`   URL: ${url}`);
    console.log(`   Title: ${title}`);
    console.log(`   Body (前100字): ${bodyText.slice(0, 100).replace(/\n/g, " ")}`);

    // Check anti-bot signals
    const redirected = url.includes("login") || url.includes("passport");
    const hasLoginText = bodyText.includes("请登录") || bodyText.includes("验证码");
    const tooShort = bodyText.length < 50;

    if (redirected || hasLoginText) {
      console.log("   → 结果: 重定向到登录页（正常，headless 无 cookie）");
    } else if (tooShort) {
      console.log("   → 结果: ⚠ 页面内容过短，可能被反爬拦截");
    } else {
      console.log("   → 结果: ✅ Headless 可以正常加载番茄页面");
    }

    // Take screenshot for visual check
    await page.screenshot({ path: path.join(STORAGE_DIR, "headless-fresh.png") });
    console.log("   → 截图: storage/headless-fresh.png");
  } catch (e) {
    console.log(`   → 结果: ❌ 加载失败: ${e.message}`);
  } finally {
    await browser.close();
  }
}

// ── Test 2: Extract cookies from Edge CDP, inject into headless ──
async function testCdpToHeadless() {
  console.log("\n━━━ 测试 2: Edge CDP Cookie → Headless ━━━");

  // Step 1: Check if Edge CDP is available
  let cdpAvailable = false;
  try {
    await new Promise((resolve, reject) => {
      const req = http.get(`${CDP_URL}/json/version`, (res) => {
        res.resume();
        res.statusCode === 200 ? resolve() : reject();
      });
      req.on("error", reject);
      req.setTimeout(3000, () => { req.destroy(); reject(new Error("timeout")); });
    });
    cdpAvailable = true;
    console.log("   ✅ Edge CDP 可用");
  } catch {
    console.log("   ⚠ Edge CDP 不可用，跳过此测试 (需要先运行 node fanqie-analytics.js collect)");
    console.log("   → 后续测试会使用 storage/ 中已有的 cookie 文件");
    return null;
  }

  if (!cdpAvailable) return null;

  // Step 2: Connect via CDP and export cookies
  let cookies = [];
  try {
    const cdpBrowser = await chromium.connectOverCDP(CDP_URL);
    const contexts = cdpBrowser.contexts();
    if (contexts.length > 0) {
      cookies = await contexts[0].cookies();
      console.log(`   ✅ 从 Edge 导出 ${cookies.length} 个 cookie`);
    }
    await cdpBrowser.close();
  } catch (e) {
    console.log(`   ❌ CDP cookie 导出失败: ${e.message}`);
    return null;
  }

  if (cookies.length === 0) {
    console.log("   ⚠ 没有 cookie，跳过");
    return null;
  }

  // Step 3: Launch headless with those cookies
  console.log("   → 启动 headless 并注入 cookie...");
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.addCookies(cookies);
  const page = await context.newPage();

  try {
    await page.goto("https://fanqienovel.com/main/writer/home", {
      waitUntil: "networkidle",
      timeout: 30000,
    });
    await page.waitForTimeout(2000);
    const url = page.url();
    const redirected = url.includes("login") || url.includes("passport");
    const title = await page.title();

    if (redirected) {
      console.log("   → 结果: ❌ 登录态丢失，被重定向到登录页");
      console.log("   → 原因: 可能 cookie 中有 HttpOnly/Secure 标记 headless 不支持");
    } else {
      console.log("   → 结果: ✅ Headless 成功继承 Edge 登录态！");
      console.log(`   → Title: ${title}`);
    }

    // Step 4: Save storageState for Test 3
    const statePath = path.join(STORAGE_DIR, `${TEST_TENANT}.json`);
    await context.storageState({ path: statePath });
    console.log(`   → storageState 已保存: ${statePath}`);

    await page.screenshot({ path: path.join(STORAGE_DIR, "headless-cdp-cookies.png") });
  } catch (e) {
    console.log(`   → 结果: ❌ 页面加载失败: ${e.message}`);
  } finally {
    await browser.close();
  }

  return cookies.length > 0;
}

// ── Test 3: Restore from storageState ──
async function testStorageStateRestore() {
  console.log("\n━━━ 测试 3: storageState 持久化恢复 ━━━");

  const statePath = path.join(STORAGE_DIR, `${TEST_TENANT}.json`);
  if (!fs.existsSync(statePath)) {
    console.log("   ⚠ 没有 storageState 文件，跳过 (需要先完成测试 2 或手动登录)");
    return;
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: statePath });

  // Verify cookies loaded
  const cookies = await context.cookies();
  const fanqieCookies = cookies.filter(c => c.domain.includes("fanqie"));
  console.log(`   ✅ 从 storageState 恢复 ${fanqieCookies.length} 个番茄域名 cookie`);

  const page = await context.newPage();
  try {
    await page.goto("https://fanqienovel.com/main/writer/home", {
      waitUntil: "networkidle",
      timeout: 30000,
    });
    await page.waitForTimeout(2000);

    const url = page.url();
    const redirected = url.includes("login") || url.includes("passport");

    if (redirected) {
      console.log("   → 结果: ❌ storageState 恢复后登录态丢失");
    } else {
      console.log("   → 结果: ✅ storageState 持久化 + 恢复完全正常");
      console.log("   → 这意味着服务器可以持久化客户登录态，无需每次重新登录");
    }

    await page.screenshot({ path: path.join(STORAGE_DIR, "headless-restored.png") });
  } catch (e) {
    console.log(`   → 结果: ❌ 页面加载失败: ${e.message}`);
  } finally {
    await browser.close();
  }
}

// ── Main ──
(async () => {
  console.log("🔬 番茄小说 Headless Playwright 可行性验证\n");
  console.log("========================================\n");

  if (!fs.existsSync(STORAGE_DIR)) fs.mkdirSync(STORAGE_DIR, { recursive: true });

  await testFreshHeadless();
  await testCdpToHeadless();
  await testStorageStateRestore();

  console.log("\n========================================");
  console.log("验证完成。检查 storage/ 目录下的截图判断实际情况。");
  console.log("若测试 2 或 3 成功 → Headless + storageState 方案可行");
  console.log("若全部失败 → 需考虑：1) 非headless + VNC  2) Playwright stealth 插件");
})();
