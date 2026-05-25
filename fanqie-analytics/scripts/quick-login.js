#!/usr/bin/env node
/**
 * 快速登录脚本 — 打开可见浏览器，用户手动登录番茄小说
 * 登录成功后 cookie 保存在 persistent user data directory，
 * 后续 headless 模式（Browser Manager）直接复用。
 *
 * Usage:
 *   node scripts/quick-login.js                        # 默认 tenant = "demo"
 *   node scripts/quick-login.js --tenant-id=biling_ai   # 指定客户
 */

const { chromium } = require("playwright");
const path = require("path");

const PROFILES_DIR = path.join(__dirname, "..", "browser-profiles");

// Parse --tenant-id from CLI
const args = process.argv.slice(2);
let tenantId = "demo";
for (const arg of args) {
  if (arg.startsWith("--tenant-id=")) {
    tenantId = arg.split("=")[1];
  } else if (arg === "--tenant-id" || arg === "-t") {
    const idx = args.indexOf(arg);
    if (idx + 1 < args.length) tenantId = args[idx + 1];
  }
}

const userDataDir = path.join(PROFILES_DIR, tenantId);

(async () => {
  console.log(`🔐 客户: ${tenantId}`);
  console.log(`   Profile 目录: ${userDataDir}`);
  console.log("   打开浏览器，请手动登录番茄小说...\n");

  // launchPersistentContext preserves ALL cookies (including HttpOnly session tokens)
  // in the userDataDir — no need for separate storageState export.
  const browser = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: ["--disable-features=TranslateUI", "--no-first-run"],
  });

  const pages = browser.pages();
  const page = pages.length > 0 ? pages[0] : await browser.newPage();

  await page.goto("https://fanqienovel.com/main/writer/home", {
    waitUntil: "networkidle",
    timeout: 30000,
  });
  await page.waitForTimeout(2000);

  const currentUrl = page.url();
  if (currentUrl.includes("login") || currentUrl.includes("passport")) {
    console.log("📱 检测到登录页面，请在浏览器中扫码或验证码登录");
    console.log("⏳ 等待登录完成（检测到进入作家后台后自动保存）...\n");
  } else {
    console.log("✅ 已登录（复用之前的登录态）\n");
  }

  // Wait for successful login (URL changes away from login page)
  try {
    await page.waitForURL(
      (url) => !url.toString().includes("login") && !url.toString().includes("passport"),
      { timeout: 120000 }
    );
    console.log("✅ 登录成功！\n");

    // Verify cookies are saved in the persistent profile
    const cookies = await browser.cookies();
    const fanqieCookies = cookies.filter((c) => c.domain.includes("fanqie"));
    console.log(`   Cookie 总数: ${cookies.length} | 番茄域名: ${fanqieCookies.length}`);
    console.log(`   Profile 已保存: ${userDataDir}`);
    console.log(`   该客户现在可以通过 API 采集数据了`);
  } catch (e) {
    console.log(`⚠ 登录超时: ${e.message}`);
    console.log("   浏览器保持打开，请手动登录后按 Ctrl+C");

    const cookies = await browser.cookies();
    const fanqieCookies = cookies.filter((c) => c.domain.includes("fanqie"));
    if (fanqieCookies.length > 0) {
      console.log(`   ℹ 当前已有 ${fanqieCookies.length} 个番茄域名 cookie（部分登录态可能有效）`);
    }
  }

  await browser.close();
  console.log(`\n✨ 完成。API 服务可用: POST /api/v1/collect (tenant: ${tenantId})`);
})();
