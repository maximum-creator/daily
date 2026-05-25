#!/usr/bin/env node
/**
 * 番茄小说作家后台数据自动采集分析工具
 *
 * Usage:
 *   node fanqie-analytics.js setup     - 首次配置引导
 *   node fanqie-analytics.js collect   - 采集今日数据
 *   node fanqie-analytics.js report    - 生成趋势报告
 */

const fs = require("fs");
const path = require("path");

// ── Config ────────────────────────────────────────────────────────
const CONFIG_PATH = path.join(__dirname, "config.json");
const DATA_DIR = path.join(__dirname, "data");

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error("❌ 未找到 config.json，请先运行: node fanqie-analytics.js setup");
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  const browser = raw.browser || "edge";
  if (!BROWSER_REGISTRY[browser]) {
    console.warn(`   ⚠ 未知浏览器类型 "${browser}"，回退为 Edge`);
  }
  return {
    browser: BROWSER_REGISTRY[browser] ? browser : "edge",
    browserPath: raw.browserPath || "",    // 自定义 exe 路径（可选）
    edgeProfile: raw.edgeProfile || "",    // 已废弃，保留兼容
    headless: raw.headless !== undefined ? raw.headless : false,
    playwrightPath: raw.playwrightPath || "playwright",
    books: raw.books || [],
  };
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Shared revenue milestones — used by doPredict and doMetrics
const REVENUE_MILESTONES = [
  { label: "月入 ¥100", target: 100, icon: "🌱" },
  { label: "月入 ¥500", target: 500, icon: "🌿" },
  { label: "月入 ¥1000", target: 1000, icon: "🌳" },
  { label: "月入 ¥5000", target: 5000, icon: "🏆" },
];

// ── Browser ────────────────────────────────────────────────────────
// 通过 CDP (Chrome DevTools Protocol) 连接到用户浏览器
// 支持 Edge / Chrome / Brave 等所有 Chromium 内核浏览器
// 无需复制 Cookies、无需重新登录
//
// 流程：
//   1. 尝试连接 localhost:9222（已有调试服务）
//   2. 没有 → 优雅关闭浏览器 → 用 --remote-debugging-port=9222 重新启动
//   3. CDP 连接 → 在默认 Context 新建页面 → 所有登录态天然存在
//   4. 采集完成只关闭页面，浏览器保持运行，下次秒级重连
// ────────────────────────────────────────────────────────────────────

const CDP_PORT = 9222;
const CDP_URL = `http://localhost:${CDP_PORT}`;

// 浏览器注册表 — 添加新浏览器只需在此处增加条目
const BROWSER_REGISTRY = {
  edge: {
    name: "Microsoft Edge",
    processName: "msedge.exe",
    exePaths: [
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    ],
    envPaths: [
      { env: "PROGRAMFILES", sub: "Microsoft\\Edge\\Application\\msedge.exe" },
      { env: "ProgramFiles(x86)", sub: "Microsoft\\Edge\\Application\\msedge.exe" },
      { env: "LOCALAPPDATA", sub: "Microsoft\\Edge\\Application\\msedge.exe" },
    ],
  },
  chrome: {
    name: "Google Chrome",
    processName: "chrome.exe",
    exePaths: [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ],
    envPaths: [
      { env: "PROGRAMFILES", sub: "Google\\Chrome\\Application\\chrome.exe" },
      { env: "ProgramFiles(x86)", sub: "Google\\Chrome\\Application\\chrome.exe" },
      { env: "LOCALAPPDATA", sub: "Google\\Chrome\\Application\\chrome.exe" },
    ],
  },
  brave: {
    name: "Brave Browser",
    processName: "brave.exe",
    exePaths: [
      "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
      "C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
    ],
    envPaths: [
      { env: "PROGRAMFILES", sub: "BraveSoftware\\Brave-Browser\\Application\\brave.exe" },
      { env: "ProgramFiles(x86)", sub: "BraveSoftware\\Brave-Browser\\Application\\brave.exe" },
      { env: "LOCALAPPDATA", sub: "BraveSoftware\\Brave-Browser\\Application\\brave.exe" },
    ],
  },
};

function findBrowserExe(browserType, customPath) {
  // Custom path override (portable installs, etc.)
  if (customPath) {
    if (fs.existsSync(customPath)) return customPath;
    console.warn(`   ⚠ 自定义浏览器路径不存在: ${customPath}`);
  }

  const info = BROWSER_REGISTRY[browserType];
  if (!info) throw new Error(`不支持的浏览器类型: ${browserType}，可选: ${Object.keys(BROWSER_REGISTRY).join(", ")}`);

  // Collect all candidate paths (deduplicated)
  const seen = new Set();
  const candidates = [...info.exePaths];
  for (const { env, sub } of info.envPaths) {
    const base = process.env[env];
    if (base) candidates.push(path.join(base, sub));
  }
  const unique = [];
  for (const c of candidates) {
    const norm = c.replace(/\\/g, "/").toLowerCase();
    if (!seen.has(norm)) { seen.add(norm); unique.push(c); }
  }
  for (const p of unique) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function cdpEndpointReady(timeoutMs = 15000) {
  const http = require("http");
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await new Promise((resolve, reject) => {
        const req = http.get(`${CDP_URL}/json/version`, (res) => {
          res.resume();
          res.statusCode === 200 ? resolve() : reject();
        });
        req.on("error", reject);
        req.setTimeout(2000, () => { req.destroy(); reject(new Error("timeout")); });
      });
      return true;
    } catch (e) { console.warn("CDP端点就绪检测失败", e.message); }
    await new Promise(r => setTimeout(r, 600));
  }
  return false;
}

async function launchBrowserWithDebugPort(browserType, customPath) {
  const info = BROWSER_REGISTRY[browserType];
  if (!info) throw new Error(`不支持的浏览器类型: ${browserType}`);

  const exePath = findBrowserExe(browserType, customPath);
  if (!exePath) throw new Error(`找不到 ${info.name}，请确认已安装或设置 browserPath`);

  console.log(`   🔄 重启 ${info.name} (CDP 调试模式)...`);

  // 策略：先优雅关闭（WM_CLOSE，让浏览器有时间把 session/cookie 写入磁盘），
  //       超时后再强制终止残留进程。这样最大化保留登录态。
  const { execSync } = require("child_process");
  const procName = info.processName;
  try {
    // Step 1: 优雅关闭（无 /F），让浏览器正常保存 session
    execSync(`taskkill /IM ${procName} >nul 2>&1`, { stdio: "ignore" });
    console.log(`   ⏳ 等待 ${info.name} 保存会话数据...`);
    await new Promise(r => setTimeout(r, 3000));
  } catch { /* 浏览器可能本来就没在运行 */ }
  // Step 2: 强制清理残留进程（优雅关闭失败的标签页或后台进程）
  try { execSync(`taskkill /F /IM ${procName} >nul 2>&1`, { stdio: "ignore" }); } catch { /* 无残留 */ }
  await new Promise(r => setTimeout(r, 1500));

  // 启动浏览器，使用默认用户数据目录（保持登录态）+ 开启调试端口
  const { spawn } = require("child_process");
  const proc = spawn(exePath, [
    `--remote-debugging-port=${CDP_PORT}`,
    "about:blank",
    "--disable-background-mode",
    "--disable-features=TranslateUI",
    "--no-first-run",
    "--no-default-browser-check",
  ], {
    detached: true,
    stdio: "ignore",
  });
  proc.unref();

  console.log(`   ⏳ 等待 ${info.name} 就绪...`);
  if (!(await cdpEndpointReady())) {
    throw new Error(`${info.name} 启动超时，请手动打开后重试`);
  }
  console.log(`   ✅ ${info.name} 已启动`);
  return info;
}

async function launchBrowser(config) {
  const { chromium } = require(config.playwrightPath || "playwright");
  const browserType = config.browser || "edge";
  const info = BROWSER_REGISTRY[browserType] || BROWSER_REGISTRY.edge;

  // CDP 模式不支持 headless
  if (config.headless) {
    console.warn("   ⚠ CDP 模式不支持 headless，将使用可见窗口");
  }

  // 1. 尝试连接已运行的浏览器（可能已有调试端口）
  let cdpBrowser = null;
  try { cdpBrowser = await chromium.connectOverCDP(CDP_URL); } catch (e) { console.warn("CDP连接失败", e.message); }

  // 2. 连接不上 → 重启浏览器开启调试端口
  if (!cdpBrowser) {
    console.warn(`   ⚠ ${info.name} 未开启调试端口，正在重启...`);
    await launchBrowserWithDebugPort(browserType, config.browserPath);
    cdpBrowser = await chromium.connectOverCDP(CDP_URL);
  }

  console.log(`   ✅ 已连接 ${info.name} (CDP) — 登录态完整\n`);

  // 3. 在默认 Context 中创建/复用页面（携带所有 Cookies）
  const contexts = cdpBrowser.contexts();
  if (!contexts || contexts.length === 0) throw new Error("CDP 连接异常：无法获取浏览器上下文");
  const context = contexts[0];
  const allPages = context.pages();
  const blankPages = allPages.filter(p => {
    const u = p.url();
    return u === "about:blank" || u === "about:blank/" || u === "" || u.startsWith("edge://") || u.startsWith("chrome://");
  });
  let page;

  // 优先复用已有的空白页（启动时我们传了 about:blank）
  if (blankPages.length > 0) {
    page = blankPages[0];
    for (let i = 1; i < blankPages.length; i++) {
      await blankPages[i].close().catch(() => {});
    }
  } else {
    page = await context.newPage();
  }

  // 4. 返回包装对象
  return {
    _cdp: cdpBrowser,
    _context: context,
    _page: page,
    _browserInfo: info,

    pages: () => [page],
    newPage: () => context.newPage(),
    close: async () => {
      await page.close().catch(() => {});
      const remaining = context.pages();
      for (const p of remaining) {
        const u = p.url();
        if (u === "about:blank" || u === "" || u.startsWith("edge://") || u.startsWith("chrome://")) {
          await p.close().catch(() => {});
        }
      }
    },
  };
}

// ── JS Click (bypasses SPA interception) ──────────────────────────
async function jsClick(page, text, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      console.warn(`   🔄 重试点击 "${text}" (${attempt}/${retries})...`);
      await page.waitForTimeout(1500);
    }
    const result = await page.evaluate((t) => {
      const allNodes = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
      let node;
      while (node = walker.nextNode()) {
        if (node.textContent?.trim() === t && node.children.length === 0) {
          allNodes.push(node);
        }
      }
      if (allNodes.length === 0) return { success: false, reason: "not found", count: 0 };

      // Priority: nav items first, then tabs, then any parent
      for (const sel of ['[class*="nav-item"]', '[class*="tabs-header"]', '[class*="tab-title"]']) {
        for (const n of allNodes) {
          const parent = n.closest(sel);
          if (parent) {
            parent.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
            return { success: true, via: sel, count: allNodes.length };
          }
        }
      }
      // Fallback: click the leaf node's parent
      allNodes[0].parentElement?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      return { success: true, via: "fallback", count: allNodes.length };
    }, text);

    if (result.success) {
      if (result.count > 3) {
        console.warn(`   ⚠ jsClick("${text}"): 找到 ${result.count} 个匹配，已点击第一个 (via ${result.via})`);
      }
      return true;
    }
  }
  console.warn(`   ⚠ jsClick("${text}"): 未找到目标元素`);
  return false;
}

// ── Book Switching ────────────────────────────────────────────────
// Actual DOM (Arco Design SPA):
//   Sidebar: button.book-select-switch → opens byte-drawer-wrapper (right drawer)
//   Drawer:  div.book-drawer-item → div.book-drawer-book-name (click to switch)
//   Active:  .book-select-info-title (sidebar current book display)

async function switchToBook(page, targetName, dataPageUrl) {
  const checkBook = () => page.evaluate(() => {
    const el = document.querySelector(".book-select-info-title");
    return el?.textContent?.trim() || "";
  });

  if ((await checkBook()) === targetName) {
    // Already on correct book, but re-verify after a moment (SPA might still be settling)
    await page.waitForTimeout(500);
    if ((await checkBook()) === targetName) return true;
  }

  console.log(`   🔄 切换作品: ${targetName}`);

  for (let attempt = 0; attempt < 2; attempt++) {
    // Retry: reload data page to reset broken SPA state
    if (attempt > 0 && dataPageUrl) {
      console.log("   🔄 重新加载数据页...");
      await page.goto(dataPageUrl, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(2500);
      if ((await checkBook()) === targetName) return true;
    }

    const drawerAlreadyOpen = await isDrawerOpen(page);

    if (!drawerAlreadyOpen) {
      // Open drawer via dispatchEvent (avoids byte-drawer-mask pointer interception)
      const btnFound = await page.evaluate(() => {
        const btn = document.querySelector("button.book-select-switch");
        if (!btn) return false;
        btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        return true;
      });
      if (!btnFound && attempt === 0) continue;
      if (!btnFound) {
        console.warn("   ⚠ 找不到切换按钮");
        return false;
      }
    }

    await waitForDrawerOpen(page);

    // Find and click target book
    const clicked = await page.evaluate((name) => {
      const items = document.querySelectorAll(".book-drawer-item");
      // Exact match first
      for (const item of items) {
        const nameEl = item.querySelector(".book-drawer-book-name");
        const text = nameEl?.textContent?.trim() || "";
        if (text === name) {
          nameEl.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          return "exact:" + text;
        }
      }
      // Fuzzy match
      for (const item of items) {
        const nameEl = item.querySelector(".book-drawer-book-name");
        const text = nameEl?.textContent?.trim() || "";
        if (text.includes(name) || name.includes(text)) {
          nameEl.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          return "fuzzy:" + text;
        }
      }
      return "not_found";
    }, targetName);

    if (clicked === "not_found") {
      if (attempt === 0) continue; // retry with page reload
      // Debug on final attempt
      const debugInfo = await page.evaluate(() => {
        const items = document.querySelectorAll(".book-drawer-item");
        return {
          count: items.length,
          names: Array.from(items).map(item =>
            item.querySelector(".book-drawer-book-name")?.textContent?.trim() || "(empty)"
          ),
        };
      });
      console.warn(`   ⚠ 未找到 "${targetName}" (抽屉中有 ${debugInfo.count} 本书: ${debugInfo.names.join(", ") || "无"})`);
      await closeDrawer(page);
      await page.waitForTimeout(300);
      return false;
    }

    console.log(`   ✅ 选中: ${clicked}`);

    // Wait for drawer to close (reliable signal that SPA accepted the click)
    const closeStart = Date.now();
    while (Date.now() - closeStart < 8000) {
      if (!(await isDrawerOpen(page))) break;
      await page.waitForTimeout(300);
    }
    if (await isDrawerOpen(page)) {
      console.warn("   ⚠ 抽屉未关闭，尝试继续...");
    }

    // Now wait for sidebar book name to update + content area to re-render
    // SPA needs time to fetch and render new book's data
    const startWait = Date.now();
    let bookMatch = false;
    while (Date.now() - startWait < 10000) {
      const current = await checkBook();
      if (current === targetName || current.includes(targetName) || targetName.includes(current)) {
        bookMatch = true;
        break;
      }
      await page.waitForTimeout(500);
    }

    if (bookMatch) {
      // EXTRA: wait for content to actually re-render. The sidebar updates fast,
      // but charts/tables lag behind. Without this, we collect old book's data.
      await page.waitForTimeout(2000);
      // Double-check sidebar is still correct
      const final = await checkBook();
      if (final === targetName || final.includes(targetName) || targetName.includes(final)) {
        console.log(`   ✅ 已切换到: ${final}`);
        return true;
      }
    }

    console.warn(`   ⚠ 书名未更新到目标，重试...`);
  }

  // Exhausted
  const final = await checkBook();
  console.error(`   ❌ 切换失败 (当前: "${final}")`);
  return false;
}

// Switch book on the PROFIT page (收益分析), which uses a MODAL dialog, not a drawer
async function switchBookOnProfitPage(page, targetName) {
  const checkBook = () => page.evaluate(() => {
    const el = document.querySelector(".book-select-info-title");
    return el?.textContent?.trim() || "";
  });

  // ALWAYS close any existing modal first (profit page may auto-open it)
  const modalOpen = await page.evaluate(() => {
    const w = document.querySelector(".byte-modal-wrapper");
    return w ? w.getBoundingClientRect().width > 0 : false;
  });
  if (modalOpen) {
    await page.evaluate(() => {
      const btns = document.querySelectorAll(".byte-modal-footer button");
      for (const btn of btns) {
        if (btn.textContent?.trim().includes("取消")) {
          btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        }
      }
    });
    await page.waitForTimeout(1000);
  }

  // Now check if already on the correct book
  if ((await checkBook()) === targetName) return true;

  console.log(`   🔄 切换收益作品: ${targetName}`);

  // Open the modal
  await page.evaluate(() => {
    const btn = document.querySelector("button.book-select-switch");
    if (btn) btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await page.waitForTimeout(2000);

  // Find and click target book in modal (.book-item, NOT .book-drawer-item)
  const clicked = await page.evaluate((name) => {
    const items = document.querySelectorAll(".book-item");
    for (const item of items) {
      const nameEl = item.querySelector(".book-item-details-name");
      const text = nameEl?.textContent?.trim() || "";
      if (text === name) {
        item.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        return "exact:" + text;
      }
    }
    for (const item of items) {
      const nameEl = item.querySelector(".book-item-details-name");
      const text = nameEl?.textContent?.trim() || "";
      if (text.includes(name) || name.includes(text)) {
        item.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        return "fuzzy:" + text;
      }
    }
    return "not_found";
  }, targetName);

  if (clicked === "not_found") {
    console.warn(`   ⚠ 未找到 "${targetName}"，取消选择`);
    await page.evaluate(() => {
      const btns = document.querySelectorAll(".byte-modal-footer button");
      for (const btn of btns) if (btn.textContent?.trim().includes("取消")) btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await page.waitForTimeout(1000);
    return false;
  }

  console.log(`   ✅ 选中: ${clicked}`);
  await page.waitForTimeout(500);

  // Click confirm button
  await page.evaluate(() => {
    const btns = document.querySelectorAll(".byte-modal-footer button");
    for (const btn of btns) {
      if (btn.textContent?.trim().includes("确定")) {
        btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        return;
      }
    }
  });

  // Wait for page refresh after modal confirm
  await page.waitForTimeout(5000);

  // Verify
  const final = await checkBook();
  if (final === targetName || final.includes(targetName) || targetName.includes(final)) {
    console.log(`   ✅ 已切换到: ${final}`);
    return true;
  }

  console.error(`   ❌ 收益切换失败 (当前: "${final}")`);
  return false;
}

// ── Drawer Helpers ──────────────────────────────────────────────────
// The data-center page uses a byte-drawer for book selection.
// These helpers are shared by switchToBook and collectDashboard.

async function isDrawerOpen(page) {
  return page.evaluate(() => {
    const wrapper = document.querySelector(".byte-drawer-wrapper");
    if (!wrapper) return false;
    return !wrapper.classList.contains("byte-drawer-wrapper-hide");
  });
}

async function waitForDrawerOpen(page) {
  try {
    await page.waitForSelector(".book-drawer-item", { timeout: 5000 });
  } catch { console.warn("   ⚠ 抽屉列表加载超时"); }
  await page.waitForTimeout(400);
}

async function closeDrawer(page) {
  if (!(await isDrawerOpen(page))) return;
  // Click the mask overlay to dismiss
  await page.evaluate(() => {
    const mask = document.querySelector(".byte-drawer-mask");
    if (mask) mask.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  // Wait up to 5s for drawer to actually close
  for (let i = 0; i < 10; i++) {
    if (!(await isDrawerOpen(page))) return;
    await page.waitForTimeout(500);
  }
}

// ── Data Collectors ────────────────────────────────────────────────

async function collectDashboard(page) {
  const txt = await page.evaluate(() => document.body?.innerText || "");

  // Get current book name from sidebar (reliable CSS selector)
  let currentBook = await page.evaluate(() => {
    const el = document.querySelector(".book-select-info-title");
    return el?.textContent?.trim() || "";
  });

  const lines = txt.split("\n");
  const novelNames = [];

  // Strategy 1: Use CSS selector result
  if (currentBook && currentBook.length >= 2) {
    // Find status near the book name in text
    let status = "";
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === currentBook) {
        for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
          const l = lines[j].trim();
          if (l.includes("连载中") || l.includes("已完结") || l.includes("已签约") || l.includes("审核中") || l.includes("验证中")) {
            status = l;
            break;
          }
        }
        break;
      }
    }
    novelNames.push({ name: currentBook, status });
  }

  // Strategy 2: Fallback to text parsing (find "当前作品" marker)
  if (novelNames.length === 0) {
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === "当前作品") {
        for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
          const candidate = lines[j].trim();
          if (candidate.length >= 4 &&
              !candidate.includes("切换") &&
              !candidate.includes("推荐") &&
              !candidate.includes("验证中") &&
              !candidate.match(/^\d/)) {
            const statusLine = lines[j + 1]?.trim() || "";
            novelNames.push({ name: candidate, status: statusLine });
            break;
          }
        }
        break;
      }
    }
  }

  // Open the book-switch drawer to enumerate ALL books
  const allBooks = [];
  const switchBtn = await page.evaluate(() => !!document.querySelector("button.book-select-switch"));
  if (switchBtn) {
    try {
      // Use dispatchEvent (same as switchToBook), not page.click()
      await page.evaluate(() => {
        const btn = document.querySelector("button.book-select-switch");
        if (btn) btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await waitForDrawerOpen(page);
      const drawerBooks = await page.evaluate(() => {
        const items = document.querySelectorAll(".book-drawer-item");
        return Array.from(items).map(item => {
          const nameEl = item.querySelector(".book-drawer-book-name");
          const name = nameEl?.textContent?.trim() || "";
          // Status/ranking in spans next to the name element, or deduce from item text
          const full = item.textContent?.trim() || "";
          const afterName = full.slice(full.indexOf(name) + name.length).trim();
          // Status: 连载中 / 已完结 / 已下架
          const status = afterName.match(/连载中|已完结|已下架/)?.[0] || "";
          // Ranking: 未上榜 / 第X名 / 上榜
          const ranking = afterName.match(/第\d+名|未上榜|上榜/)?.[0] || "";
          return { name, selected: item.classList.contains("selected"), status, ranking };
        });
      });
      for (const b of drawerBooks) {
        allBooks.push({ name: b.name, status: b.status, ranking: b.ranking });
      }
      await closeDrawer(page);
    } catch (e) {
      console.warn("抽屉枚举失败，回退到文本解析", e.message);
    }
  }

  // Use drawer results if available, otherwise fall back to text-based
  const novels = allBooks.length > 0 ? allBooks : (() => {
    const seen = new Set();
    return novelNames.filter(n => {
      if (seen.has(n.name)) return false;
      seen.add(n.name);
      return true;
    });
  })();

  return { novels };
}

async function collectWorksData(page) {
  const txt = await page.evaluate(() => document.body?.innerText || "");
  if (process.env.DEBUG_WORKS) {
    console.log(`   │  DEBUG 作品数据页面文本:\n${txt.slice(0, 1500)}`);
  }

  const metrics = {};
  const patterns = {
    "阅读人数": /阅读人数\s+([\d,]+)/,
    "在读人数": /在读人数\s+([\d,]+)/,
    "作品评分": /作品评分\s+([\d.]+)/,
    "评论次数": /评论次数\s+([\d,]+)/,
    "加书架人数": /加书架人数\s+([\d,]+)/,
    "催更人数": /催更人数\s+([\d,]+)/,
    "追更人数": /追更人数\s+([\d,]+)/,
  };

  for (const [key, regex] of Object.entries(patterns)) {
    const match = txt.match(regex);
    metrics[key] = match ? parseFloat(match[1].replace(/,/g, "")) : 0;
  }

  // Parse rate changes per metric (比前日) - handles 持平 / -- as 0
  for (const key of ["阅读人数", "在读人数", "作品评分", "评论次数", "加书架人数", "催更人数", "追更人数"]) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rateRegex = new RegExp(`${escaped}\\s+[\\d,.]+\\s+比前日\\s+([\\d.\\-]+)%?`);
    const rateMatch = txt.match(rateRegex);
    if (rateMatch) {
      metrics[`${key}变化%`] = parseFloat(rateMatch[1]) || 0;
    } else if (new RegExp(`${escaped}\\s+[\\d,.]+\\s+比前日\\s+(持平|--)`).test(txt)) {
      metrics[`${key}变化%`] = 0;
    }
  }

  return metrics;
}

async function collectQuality(page, apiCalls = []) {
  let chapters = [];
  let chapterList = [];
  let milestones = {};
  let milestoneChapters = {};
  let cumulativeWords = 0;
  let dailyWords = {};

  // Phase 1: Try to extract chapter data from captured API responses
  if (apiCalls.length > 0) {
    console.log(`   │  捕获到 ${apiCalls.length} 个 API 响应`);
    // Log captured APIs (compact)
    for (const call of apiCalls.slice(0, 3)) {
      const urlShort = call.url.replace(/msToken=[^&]+/, "msToken=...").replace(/a_bogus=[^&]+/, "a_bogus=...");
      console.log(`   │  API: ${urlShort.slice(0, 140)} (${call.body.length}B)`);
    }

    // Merge data from ALL matching API responses (different stats_type params give different fields)
    const chapterMap = new Map(); // key: chapter number, value: merged chapter data
    let apiChapterCount = 0;

    for (const call of apiCalls) {
      try {
        const json = JSON.parse(call.body);
        const data = json.data || json.result || json;
        const chData = data.chapter_stats_list || data.chapters || data.chapter_list || data.list || data.records || data.items;
        if (!chData || !Array.isArray(chData) || chData.length === 0) continue;

        // Debug: dump 1st chapter from each API response to verify field names
        if (process.env.DEBUG_QUALITY && chData.length > 0) {
          console.log(`   │  DEBUG 首章字段: ${JSON.stringify(chData[0]).slice(0, 300)}`);
        }

        for (const ch of chData) {
          const chNum = (ch.indice || ch.chapter || 0) + 1;
          const existing = chapterMap.get(chNum) || {};

          // Merge: only overwrite with non-empty/non-zero values
          const pubTs = ch.publish_time ? parseInt(ch.publish_time) : 0;
          const pubDate = pubTs > 100000 ? new Date(pubTs * 1000).toISOString().slice(0, 10) : "";
          const cRate = parseFloat(ch.read_completion_rate);
          const fRate = parseFloat(ch.follow_read_rate);
          const lRate = parseFloat(ch.loss_rate);

          chapterMap.set(chNum, {
            chapter: chNum,
            title: ch.title || existing.title || "",
            comments: ch.comment_chapter_cnt || existing.comments || 0,
            paragraphComments: ch.comment_paragraph_cnt || existing.paragraphComments || 0,
            urges: ch.reminder_cnt || existing.urges || 0,
            wordCount: ch.word_number || existing.wordCount || 0,
            publishTime: pubDate || existing.publishTime || "",
            completionRate: (!isNaN(cRate) && cRate > 0) ? cRate : (existing.completionRate || null),
            followReadRate: (!isNaN(fRate) && fRate > 0) ? fRate : (existing.followReadRate || null),
            lossRate: (!isNaN(lRate) && lRate > 0) ? lRate : (existing.lossRate || null),
          });
        }
        apiChapterCount = Math.max(apiChapterCount, chData.length);
      } catch (e) {
        console.warn("章节列表API响应解析失败", e.message);
      }
    }

    if (chapterMap.size > 0) {
      for (const [, ch] of chapterMap) {
        chapterList.push({
          chapter: ch.chapter,
          title: ch.title,
          comments: ch.comments,
          paragraphComments: ch.paragraphComments,
          urges: ch.urges,
          wordCount: ch.wordCount,
          publishTime: ch.publishTime,
          completionRate: ch.completionRate,
          followReadRate: ch.followReadRate,
          lossRate: ch.lossRate,
        });
        if (ch.completionRate != null) {
          chapters.push({
            chapter: ch.chapter,
            title: ch.title,
            completionRate: ch.completionRate,
            followReadRate: ch.followReadRate,
            lossRate: ch.lossRate,
          });
        }
      }
      const withFollow = [...chapterMap.values()].filter(c => c.followReadRate != null).length;
      const withLoss = [...chapterMap.values()].filter(c => c.lossRate != null).length;
      console.log(`   │  API 章节: ${chapterList.length} 章, 读完率=${chapters.length} 跟读率=${withFollow} 流失率=${withLoss}`);
    }

    // If we got chapter data from API, try replaying with bigger range to get ALL
    if (chapterList.length > 0) {
      for (const call of apiCalls) {
        try {
          const url = new URL(call.url);
          const totalCount = (() => {
            try { return JSON.parse(call.body).data?.total_count; } catch { return 0; }
          })();
          if (totalCount > chapterList.length) {
            // Expand pagination to get ALL chapters (for books with 500+ chapters)
            const expandedUrl = new URL(call.url);
            expandedUrl.searchParams.set("size", String(totalCount));
            expandedUrl.searchParams.set("page_size", String(totalCount));
            expandedUrl.searchParams.set("limit", String(totalCount));
            expandedUrl.searchParams.set("count", String(totalCount));
            expandedUrl.searchParams.set("page", "1");
            expandedUrl.searchParams.set("offset", "0");
            const newBody = await page.evaluate(async (u) => {
              const res = await fetch(u, { credentials: "include" });
              return await res.text();
            }, expandedUrl.toString());
            const newJson = JSON.parse(newBody);
            const newData = newJson.data || newJson.result || newJson;
            const newCh = newData.chapter_stats_list || newData.chapters || newData.chapter_list || newData.list;
            if (newCh && Array.isArray(newCh) && newCh.length > chapterList.length) {
              console.log(`   │  扩展成功: ${newCh.length} 章`);
              chapterList = [];
              chapters = [];
              for (const ch of newCh) {
                const pubTs = ch.publish_time ? parseInt(ch.publish_time) : 0;
                const pubDate = pubTs > 100000 ? new Date(pubTs * 1000).toISOString().slice(0, 10) : "";
                const cRate = parseFloat(ch.read_completion_rate);
                const fRate = parseFloat(ch.follow_read_rate);
                const lRate = parseFloat(ch.loss_rate);
                chapterList.push({
                  chapter: (ch.indice || ch.chapter || 0) + 1,
                  title: ch.title || ch.name || "",
                  comments: ch.comment_chapter_cnt || ch.comments || 0,
                  paragraphComments: ch.comment_paragraph_cnt || ch.paragraph_comments || 0,
                  urges: ch.reminder_cnt || ch.urges || 0,
                  wordCount: ch.word_number || ch.word_count || ch.words || 0,
                  publishTime: pubDate,
                  completionRate: (!isNaN(cRate) && cRate > 0) ? cRate : null,
                  followReadRate: (!isNaN(fRate) && fRate > 0) ? fRate : null,
                  lossRate: (!isNaN(lRate) && lRate > 0) ? lRate : null,
                });
                if (!isNaN(cRate) && cRate > 0) {
                  chapters.push({
                    chapter: (ch.indice || ch.chapter || 0) + 1,
                    title: ch.title || "",
                    completionRate: cRate,
                    followReadRate: (!isNaN(fRate) && fRate > 0) ? fRate : null,
                    lossRate: (!isNaN(lRate) && lRate > 0) ? lRate : null,
                  });
                }
              }
              break;
            }
          }
        } catch (e) {
          console.warn("日更字数API请求失败", e.message);
        }
      }
    }
  }

  // Phase 2: Fallback to page text parsing (innerText)
  const txt = await page.evaluate(() => document.body?.innerText || "");

  // Parse chapter completion rates from page text
  const chapterPattern = /第(\d+)章\s+(.+?)\s+读完率\s+([\d.]+)%/g;
  let match;
  while ((match = chapterPattern.exec(txt)) !== null) {
    const chNum = parseInt(match[1]);
    if (!chapters.find(c => c.chapter === chNum)) {
      chapters.push({
        chapter: chNum,
        title: match[2].trim(),
        completionRate: parseFloat(match[3]),
      });
    }
  }

  // Parse chapter list with stats — dynamically detect column count
  // Only if API didn't already provide chapter data
  if (chapterList.length === 0) {
  const lines = txt.split("\n");
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes("章节名")) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx >= 0) {
    // Count non-empty header lines to determine column count
    let colCount = 0;
    for (let j = headerIdx; j < Math.min(headerIdx + 30, lines.length); j++) {
      const t = lines[j].trim();
      if (t && !t.match(/^\d+$/) && !t.startsWith("第")) colCount++;
      if (t && (t.startsWith("第") || t.match(/^\d{4}-\d{2}-\d{2}/))) break;
    }
    colCount = Math.max(colCount, 5); // at minimum: 章节名,评论,段评,催更,字数,时间 → 6 cols

    // Row stride: 2 lines per column (data + separator) = colCount * 2
    const stride = colCount * 2;
    // Map: find which offsets contain which data types
    let i = headerIdx + 1;
    while (i < lines.length) {
      const l = lines[i].trim();
      if (l.startsWith("第") && l.includes("章")) {
        // Validate: at least 3 of the next (stride-1) lines should have parseable numbers
        const nearbyLines = lines.slice(i + 1, i + stride);
        const numericCount = nearbyLines.filter(s => {
          const n = parseFloat(s.trim().replace(/,/g, ""));
          return !isNaN(n) && s.trim().length > 0;
        }).length;
        if (numericCount >= 3) {
          const chNum = parseInt(l.match(/第(\d+)章/)?.[1] || "0");
          // Extract values by scanning the stride range
          const vals = [];
          for (let k = 1; k < stride; k++) {
            const raw = (lines[i + k] || "").trim();
            if (raw && raw !== "-" && raw !== "--") {
              const n = parseFloat(raw.replace(/,/g, ""));
              if (!isNaN(n)) vals.push(n);
              else if (raw.match(/^\d{4}-\d{2}-\d{2}/)) vals.push(raw); // datetime string
            }
          }
          // Expected order: 评论, 段评, 催更, 字数, 时间 (last two are wordCount and publishTime)
          const comments = vals[0] || 0;
          const paragraphComments = vals[1] || 0;
          const urges = vals[2] || 0;
          const wordCount = typeof vals[3] === "number" ? vals[3] : 0;
          const pubTime = typeof vals[vals.length - 1] === "string" ? vals[vals.length - 1] : "";
          chapterList.push({
            chapter: chNum,
            title: l,
            comments,
            paragraphComments,
            urges,
            wordCount,
            publishTime: pubTime,
          });
          i += stride;
          continue;
        }
      }
      if (l.match(/^\d+$/) && lines[i + 1]?.trim().match(/^\d+$/)) break;
      if (l.includes("暂无数据") || l.includes("加载失败") || l.includes("帮助中心") || l.includes("©")) break;
      i++;
    }
  }
  } // end if chapterList.length === 0

  // Parse milestone completion rates from page text
  const milestonePatterns = [
    { key: "100k", pattern: /十万字完读率\s*[:：]?\s*([\d.]+)%/ },
    { key: "100k", pattern: /10万字完读率\s*[:：]?\s*([\d.]+)%/ },
    { key: "300k", pattern: /三十万字完读率\s*[:：]?\s*([\d.]+)%/ },
    { key: "300k", pattern: /30万字完读率\s*[:：]?\s*([\d.]+)%/ },
    { key: "500k", pattern: /五十万字完读率\s*[:：]?\s*([\d.]+)%/ },
  ];
  for (const { key, pattern } of milestonePatterns) {
    const m = txt.match(pattern);
    if (m && !milestones[key]) {
      milestones[key] = parseFloat(m[1]);
    }
  }

  // Compute cumulative word counts and find milestone chapters
  cumulativeWords = 0;
  const thresholds = [10000, 30000, 50000, 100000, 200000, 300000];
  for (const ch of chapterList.sort((a, b) => a.chapter - b.chapter)) {
    cumulativeWords += ch.wordCount || 0;
    for (const t of thresholds) {
      if (!milestoneChapters[t] && cumulativeWords >= t) {
        const chCompletion = chapters.find(c => c.chapter === ch.chapter);
        milestoneChapters[t] = {
          chapter: ch.chapter,
          completionRate: chCompletion?.completionRate || null,
        };
      }
    }
  }

  // Daily word count: group chapters by publish date
  dailyWords = {};
  for (const ch of chapterList) {
    if (ch.publishTime) {
      const day = ch.publishTime.slice(0, 10);
      dailyWords[day] = (dailyWords[day] || 0) + (ch.wordCount || 0);
    }
  }

  return {
    chapters,
    chapterList,
    milestones,
    milestoneChapters,
    cumulativeWords,
    dailyWords,
  };
}

// stats_type → label mapping for book_increase_v2 API
// These are daily growth deltas over a 7-day window (not cumulative totals)
// Exact metric names are inferred from API behavior — labeled generically when uncertain
const TRAFFIC_METRIC_LABELS = {
  "24": "新增阅读",
  "25": "新增书架",
  "26": "新增追更",
  "27": "新增评论",
  "28": "新增催更",
  "29": "新增互动",
};

/**
 * Parse collected traffic API responses into source distribution.
 *
 * Key insight: The stats_types in the book_increase_v2 URL are ordered
 * the SAME as the ECharts legend items on the page. So we can map:
 *   URL stats_types order → DOM legend order → source names
 *
 * When legendNames is provided (from collectTrafficFromPage), each
 * stats_type row gets the corresponding legend name. Otherwise falls
 * back to TRAFFIC_METRIC_LABELS (growth metric labels).
 */
function collectTrafficFromApi(apiCalls, legendNames = null) {
  const sources = {};

  for (const call of apiCalls) {
    try {
      const j = JSON.parse(call.body);
      const data = j.data || j;

      if (data.data_list && Array.isArray(data.data_list) && data.data_list.length > 0) {
        const url = new URL(call.url);
        const typesStr = url.searchParams.get("stats_types") || "";
        const types = typesStr ? typesStr.split(",").map(t => t.trim()) : [];

        for (let ri = 0; ri < data.data_list.length && ri < types.length; ri++) {
          const row = data.data_list[ri];
          if (!Array.isArray(row)) continue;

          // Map stats_type to source name via legend order correspondence
          const label = legendNames && ri < legendNames.length
            ? legendNames[ri]
            : (TRAFFIC_METRIC_LABELS[types[ri]] || `指标${types[ri]}`);

          // Use latest non-zero daily value (most recent day with data)
          const nums = row.map(v => parseInt(v) || 0);
          const latest = nums.reduce((last, v) => v > 0 ? v : last, 0);
          if (latest > 0) sources[label] = latest;
        }
        continue;
      }

      // Generic fallback patterns for other API response shapes
      if (Array.isArray(data)) {
        for (const item of data) {
          if (typeof item !== "object") continue;
          const name = item.source_name || item.source || item.name || item.channel || item.origin || item.label;
          const pct = parseFloat(item.ratio) || parseFloat(item.percentage) || parseFloat(item.percent)
            || parseFloat(item.rate) || parseFloat(item.pct) || parseFloat(item.value) || parseFloat(item.share);
          if (typeof name === "string" && !isNaN(pct)) sources[name] = parseFloat(pct.toFixed(2));
        }
        continue;
      }

      const keys = Object.keys(data);
      const allNumeric = keys.length > 1 && keys.every(k => {
        const v = data[k];
        return typeof v === "number" || (typeof v === "string" && !isNaN(parseFloat(v)));
      });
      if (allNumeric && keys.some(k => /书城|搜索|分类|书架|推荐|继续阅读/.test(k))) {
        for (const k of keys) {
          const v = typeof data[k] === "string" ? parseFloat(data[k]) : data[k];
          if (!isNaN(v)) sources[k] = parseFloat(v.toFixed(2));
        }
        continue;
      }

      for (const k of keys) {
        const arr = data[k];
        if (!Array.isArray(arr)) continue;
        for (const item of arr) {
          if (typeof item !== "object") continue;
          const name = item.source_name || item.source || item.name || item.channel || item.origin || item.label;
          let pct;
          const pctRaw = item.ratio ?? item.percentage ?? item.percent ?? item.rate ?? item.pct ?? item.share ?? item.value;
          if (typeof pctRaw === "string") pct = parseFloat(pctRaw.replace("%", ""));
          else if (typeof pctRaw === "number") pct = pctRaw;
          if (typeof name === "string" && !isNaN(pct) && pct > 0) sources[name] = parseFloat(pct.toFixed(2));
        }
      }
    } catch (e) { console.warn("流量API响应解析失败", e.message); }
  }

  const isEmpty = Object.keys(sources).length === 0;
  return { sources, isEmpty };
}

/**
 * Extract ECharts legend names from the traffic page DOM.
 * These names correspond 1:1 (in order) to the stats_types in the
 * book_increase_v2 API URL. ECharts renders legend items as HTML
 * elements with class "control-legend-item-name".
 */
async function collectTrafficFromPage(page) {
  try {
    const legendNames = await page.evaluate(() => {
      const items = document.querySelectorAll(".control-legend-item-name");
      return Array.from(items).map(el => el.textContent.trim());
    });
    if (legendNames.length > 0) {
      return { legendNames, isEmpty: false };
    }
  } catch (e) {
    console.warn(`   │  图例提取异常: ${e.message}`);
  }
  return null;
}

async function collectRevenue(page) {
  const txt = await page.evaluate(() => document.body?.innerText || "");

  // Parse revenue overview
  const yesterdayMatch = txt.match(/昨日番茄收益\s+([\d.]+)/);
  const totalMatch = txt.match(/累计番茄收益\s+([\d.]+)/);

  const overview = {
    yesterdayRevenue: yesterdayMatch ? parseFloat(yesterdayMatch[1]) : 0,
    totalRevenue: totalMatch ? parseFloat(totalMatch[1]) : 0,
  };

  // Parse daily revenue table
  const dailyRevenue = [];
  const datePattern = /(\d{4}-\d{2}-\d{2})\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/g;
  let match;
  while ((match = datePattern.exec(txt)) !== null) {
    dailyRevenue.push({
      date: match[1],
      total: parseFloat(match[2]),
      readRevenue: parseFloat(match[3]),
      audioRevenue: parseFloat(match[4]),
      interactRevenue: parseFloat(match[5]),
    });
  }

  return { overview, dailyRevenue };
}

async function collectBenefits(page) {
  const txt = await page.evaluate(() => document.body?.innerText || "");

  const benefits = {};

  // Author level
  const levelMatch = txt.match(/作家等级\s*Lv\.?\s*(\d+)/i) || txt.match(/当前等级\s*.*?(\d+)/);
  benefits.authorLevel = levelMatch ? parseInt(levelMatch[1]) : null;

  // Level progress
  const progressMatch = txt.match(/(\d+)\s*\/\s*(\d+)/);
  if (progressMatch) {
    benefits.levelProgress = { current: parseInt(progressMatch[1]), total: parseInt(progressMatch[2]) };
  }

  // Attendance info
  const attendanceSection = txt.indexOf("全勤") >= 0 || txt.indexOf("每日更新") >= 0;
  if (attendanceSection) {
    const attMatch = txt.match(/已连续更新\s*(\d+)\s*天/) || txt.match(/连续更新\s*(\d+)\s*天/);
    benefits.attendanceDays = attMatch ? parseInt(attMatch[1]) : null;
  }

  // Fetch any visible revenue numbers
  const extraRev = {};
  const monthlyMatch = txt.match(/本月稿费\s*¥?\s*([\d,.]+)/);
  if (monthlyMatch) extraRev.monthlyPayment = parseFloat(monthlyMatch[1].replace(/,/g, ""));
  const subsMatch = txt.match(/书架订阅\s*¥?\s*([\d,.]+)/);
  if (subsMatch) extraRev.subscription = parseFloat(subsMatch[1].replace(/,/g, ""));

  if (Object.keys(extraRev).length > 0) benefits.extraRevenue = extraRev;

  return benefits;
}

// ── Main Collect ────────────────────────────────────────────────────

async function doCollect(opts = {}) {
  const config = loadConfig();
  if (opts.headless) config.headless = true;
  const date = today();

  console.log(`📊 番茄数据分析 - 采集日期: ${date}`);
  console.log("========================================");
  if (opts.book) console.log(`🎯 目标: ${opts.book}`);
  if (opts.allBooks) console.log("📚 全部作品模式");

  console.log("🌐 启动浏览器...");
  const browser = await launchBrowser(config);
  const page = browser.pages()[0] || await browser.newPage();

  const baseDayDir = path.join(DATA_DIR, date);

  try {
    // 1. 导航到作家后台
    console.log("🔐 导航到作家后台...");
    await page.goto("https://fanqienovel.com/main/writer/home", {
      waitUntil: "networkidle", timeout: 20000,
    }).catch(() => {});
    await page.waitForTimeout(1500);

    // 检查登录态
    if (page.url().includes("login") || page.url().includes("passport")) {
      const loginBrowserName = BROWSER_REGISTRY[config.browser]?.name || "浏览器";
      console.error(`❌ ${loginBrowserName} 登录态已过期，请在 ${loginBrowserName} 中重新登录番茄小说后重试`);
      await browser.close();
      process.exit(1);
    }

    // 等待 SPA 渲染
    try {
      await page.waitForSelector('[class*="nav-item"], [class*="sidebar"], [class*="menu-item"]', { timeout: 15000 });
    } catch (e) { console.warn("SPA渲染等待超时", e.message); }
    await page.waitForTimeout(1000);
    const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 500) || "");
    if (bodyText.includes("请登录") || bodyText.includes("验证码") || bodyText.length < 50) {
      console.error("❌ 登录态失效或页面加载异常");
      await browser.close();
      process.exit(1);
    }
    console.log("✅ 已登录\n");

    // 导航到数据页 — 记住 URL，多书切换时用 page.goto 回去重置 SPA 状态
    console.log("📋 导航到数据中心...");
    await jsClick(page, "小说数据");
    await page.waitForTimeout(2500);
    const dataPageUrl = page.url();

    // 3. Collect Dashboard — only open drawer when necessary
    // Read current book from sidebar (fast, no DOM mutation)
    const currentBook = await page.evaluate(() => {
      const el = document.querySelector(".book-select-info-title");
      return el?.textContent?.trim() || "";
    });

    let dashboard;
    if (opts.allBooks) {
      // --all mode: need full book list from drawer
      console.log("📋 采集: 作品列表...");
      dashboard = await collectDashboard(page);
    } else if (opts.book) {
      // --book mode: check if target matches current book (skip drawer if so)
      const targetNames = opts.book.split(",").map(s => s.trim());
      if (targetNames.length === 1 && currentBook &&
          (currentBook.includes(targetNames[0]) || targetNames[0].includes(currentBook))) {
        console.log(`   当前作品: ${currentBook}（目标匹配，跳过抽屉枚举）`);
        dashboard = { novels: [{ name: currentBook, status: "" }] };
      } else {
        console.log("📋 采集: 作品列表...");
        dashboard = await collectDashboard(page);
      }
    } else {
      // Default mode: current book only, skip drawer entirely
      if (currentBook) {
        console.log(`   当前作品: ${currentBook}（跳过抽屉枚举）`);
        dashboard = { novels: [{ name: currentBook, status: "" }] };
      } else {
        console.log("📋 采集: 作品列表...");
        dashboard = await collectDashboard(page);
      }
    }

    // Determine target books
    let targetBooks = dashboard.novels || [];
    if (opts.book) {
      // Fuzzy match — can be comma-separated for multiple books
      const names = opts.book.split(",").map(s => s.trim());
      const matched = [];
      for (const n of names) {
        const m = targetBooks.find(b => b.name.includes(n) || n.includes(b.name));
        if (m) matched.push(m);
      }
      targetBooks = matched.length > 0 ? matched : targetBooks.slice(0, 1);
      if (matched.length < names.length) console.warn(`   ⚠ 部分书名未匹配: 找到 ${matched.length}/${names.length}`);
    } else if (!opts.allBooks) {
      targetBooks = targetBooks.slice(0, 1); // Default: current book only
    }
    console.log(`   小说数: ${dashboard.novels.length} | 采集目标: ${targetBooks.map(b => b.name).join(", ") || "无"}`);

    if (!fs.existsSync(baseDayDir)) fs.mkdirSync(baseDayDir, { recursive: true });

    // Save dashboard (global book list)
    fs.writeFileSync(path.join(baseDayDir, "dashboard.json"), JSON.stringify(dashboard, null, 2));

    // 3. Collect data for each target book
    for (let bi = 0; bi < targetBooks.length; bi++) {
      const book = targetBooks[bi];
      const bookSafeName = book.name.replace(/[<>:"/\\|?*]/g, "_").trim();

      // Check if already collected today (skip re-collection unless --force)
      const summaryPath = path.join(baseDayDir, bookSafeName, "summary.json");
      if (!opts.force && fs.existsSync(summaryPath)) {
        const existing = JSON.parse(fs.readFileSync(summaryPath, "utf-8"));
        if (existing.date === date && existing.collectedAt) {
          console.log(`\n📖 [${bi + 1}/${targetBooks.length}] ${book.name} (今日已采集，跳过)`);
          continue;
        }
      }

      // Verify and switch to target book (switchToBook is a no-op if already there)
      console.log(`\n📖 [${bi + 1}/${targetBooks.length}] ${book.name}`);
      const switched = await switchToBook(page, book.name, dataPageUrl);
      if (!switched) {
        console.warn(`   ⚠ 跳过 "${book.name}"（切换失败）`);
        continue;
      }

      const bookDir = path.join(baseDayDir, bookSafeName);
      if (!fs.existsSync(bookDir)) fs.mkdirSync(bookDir, { recursive: true });

      // Collect sections independently - one failure won't stop others
      const results = { worksData: null, quality: null, traffic: null, revenue: null };

      // 3a. 作品数据 (already on this tab from initial nav)
      console.log("   ├─ 作品数据...");
      try { results.worksData = await collectWorksData(page); }
      catch (e) { console.error(`   │  ✗ 作品数据采集失败: ${e.message}`); }

      // 3b. 质量分析 — intercept API responses + explicit API call
      console.log("   ├─ 质量分析...");
      try {
        // Set up response capture BEFORE clicking the tab
        const qualityApiCalls = [];
        const onResponse = async (response) => {
          const url = response.url();
          if (url.includes("fanqienovel.com") && /api|data|quality|chapter/i.test(url)) {
            try {
              const ct = response.headers()["content-type"] || "";
              if (ct.includes("json")) {
                const body = await response.text();
                qualityApiCalls.push({ url, body, status: response.status() });
              }
            } catch (e) {
              console.warn("质量API响应读取失败", e.message);
            }
          }
        };
        page.on("response", onResponse);
        try {
          await jsClick(page, "质量分析");
          await page.waitForTimeout(3000);
        } finally {
          page.removeListener("response", onResponse);
        }

        // Extract book_id from captured API calls (page URL may not have it)
        let bookId = null;
        if (qualityApiCalls.length > 0) {
          try { bookId = new URL(qualityApiCalls[0].url).searchParams.get("book_id"); } catch (e) { console.warn("bookId提取失败", e.message); }
        }

        // Fetch additional stats_types for complete chart data:
        //   stats_type=3 → loss_rate (流失率, only if page didn't auto-fetch it)
        //   stats_type=4 → follow_read_rate with real values (章节跟读率 chart)
        // stats_type mapping verified by runtime probe:
        //   1,8,9,10 → follow_read_rate all 0 (useless)
        //   3 → +loss_rate   4 → real follow_read_rate   5→reminder   6→paragraph   7→chapter
        if (bookId && qualityApiCalls.length > 0) {
          try {
            const firstUrl = new URL(qualityApiCalls[0].url);
            const fetches = [];

            const hasLossRate = qualityApiCalls.some(call => {
              try { const j = JSON.parse(call.body); return j.data?.chapter_stats_list?.some?.(ch => ch.loss_rate !== undefined); }
              catch { return false; }
            });
            if (!hasLossRate) fetches.push("3");

            // Always fetch stats_type=4 for real follow_read_rate
            fetches.push("4");

            for (const st of fetches) {
              const u = new URL(firstUrl.origin + firstUrl.pathname);
              for (const [k, v] of firstUrl.searchParams) {
                u.searchParams.set(k, k === "stats_type" ? st : v);
              }
              if (!u.searchParams.has("stats_type")) u.searchParams.set("stats_type", st);
              u.searchParams.set("page_count", "500");
              u.searchParams.set("count", "500");
              const body = await page.evaluate(async (url) => {
                const res = await fetch(url, { credentials: "include" });
                return await res.text();
              }, u.toString());
              qualityApiCalls.push({ url: u.toString(), body, status: 200 });
            }
          } catch (e) {
            console.warn(`   │  补充 stats_type 请求失败: ${e.message}`);
          }
        }

        results.quality = await collectQuality(page, qualityApiCalls);
      } catch (e) { console.error(`   │  ✗ 质量分析采集失败: ${e.message}`); }

      // 3c. 流量构成 — intercept API calls (data is on ECharts canvas, not in DOM text)
      console.log("   ├─ 流量构成...");
      try {
        const trafficApiCalls = [];
        const onTrafficResponse = async (response) => {
          const url = response.url();
          // Capture ALL fanqienovel.com JSON API responses — we don't know the exact
          // traffic endpoint, so cast a wide net and let collectTrafficFromApi filter
          if (url.includes("fanqienovel.com")) {
            try {
              const ct = response.headers()["content-type"] || "";
              if (ct.includes("json")) {
                const body = await response.text();
                trafficApiCalls.push({ url, body, status: response.status() });
                console.log(`   │  流量API: ${url.replace(/https?:\/\/[^/]+/, "").replace(/msToken=[^&]+/, "msToken=...").replace(/a_bogus=[^&]+/, "a_bogus=...")}`);
              }
            } catch (e) { console.warn("流量响应读取失败", e.message); }
          }
        };
        page.on("response", onTrafficResponse);
        try {
          await jsClick(page, "流量构成");
          await page.waitForTimeout(3000);
        } finally {
          page.removeListener("response", onTrafficResponse);
        }

        // Phase 1: Extract legend names from DOM (书城/分类/书架/...)
        // These names correspond 1:1 in order to stats_types in the API URL
        let legendNames = null;
        const fromPage = await collectTrafficFromPage(page);
        if (fromPage && fromPage.legendNames) {
          legendNames = fromPage.legendNames;
        }

        // Phase 2: Parse API response with legend name mapping
        // Each stats_type row maps to the legend name at the same index
        if (trafficApiCalls.length > 0) {
          results.traffic = collectTrafficFromApi(trafficApiCalls, legendNames);
        } else {
          results.traffic = { sources: {}, isEmpty: true };
        }
      } catch (e) { console.error(`   │  ✗ 流量构成采集失败: ${e.message}`); }

      // 4. Revenue — profit page uses MODAL book selector, NOT drawer
      console.log("   ├─ 收益数据...");
      let revenue30 = null;
      try {
        // "小说收益" sidebar link navigates to /main/writer/profit
        await jsClick(page, "小说收益");
        await page.waitForTimeout(2500);
        // Switch to correct book on profit page (uses modal, not drawer)
        const profitSwitched = await switchBookOnProfitPage(page, book.name);
        if (profitSwitched) {
          // Re-select "每日收益" tab (modal refresh may reset to default)
          await jsClick(page, "每日收益");
          await page.waitForTimeout(1000);
          results.revenue = await collectRevenue(page);
          if (await jsClick(page, "30天")) {
            await page.waitForTimeout(2000);
            revenue30 = await collectRevenue(page);
          }
        } else {
          console.warn(`   │  ⚠ 收益页切换 "${book.name}" 失败，跳过`);
        }
      } catch (e) { console.error(`   │  ✗ 收益数据采集失败: ${e.message}`); }

      const worksData = results.worksData || {};
      const quality = results.quality || { chapters: [], chapterList: [] };
      const traffic = results.traffic || { sources: {} };
      const revenue = (revenue30?.dailyRevenue?.length > (results.revenue?.dailyRevenue?.length || 0))
        ? revenue30 : (results.revenue || { overview: { yesterdayRevenue: 0, totalRevenue: 0 }, dailyRevenue: [] });

      // Save individual JSONs
      if (results.worksData) fs.writeFileSync(path.join(bookDir, "works-data.json"), JSON.stringify(results.worksData, null, 2));
      if (results.quality) { fs.writeFileSync(path.join(bookDir, "quality.json"), JSON.stringify(results.quality, null, 2)); console.log(`   │  读完率: ${quality.chapters.length} 章 | 章节列表: ${quality.chapterList.length} 章`); }
      if (results.traffic) fs.writeFileSync(path.join(bookDir, "traffic.json"), JSON.stringify(results.traffic, null, 2));
      if (results.revenue) { fs.writeFileSync(path.join(bookDir, "revenue.json"), JSON.stringify(results.revenue, null, 2)); console.log(`   │  昨日收益: ¥${revenue.overview.yesterdayRevenue} | 累计: ¥${revenue.overview.totalRevenue}`); }

      // 5. Save per-book summary
      const summary = {
        date,
        book: book.name,
        collectedAt: new Date().toISOString(),
        worksData,
        quality: {
          chaptersWithCompletionRate: quality.chapters.length,
          totalChapters: quality.chapterList.length,
          avgWordCount: quality.chapterList.length > 0
            ? Math.round(quality.chapterList.reduce((s, c) => s + c.wordCount, 0) / quality.chapterList.length)
            : 0,
          cumulativeWords: quality.cumulativeWords || 0,
          milestones: quality.milestones || {},
          milestoneChapters: quality.milestoneChapters || {},
          dailyWords: quality.dailyWords || {},
        },
        traffic,
        revenue,
      };
      fs.writeFileSync(path.join(bookDir, "summary.json"), JSON.stringify(summary, null, 2));

      // Append to daily log (deduplicate same date + book)
      const logPath = path.join(DATA_DIR, "daily-log.json");
      let log = [];
      if (fs.existsSync(logPath)) {
        try { log = JSON.parse(fs.readFileSync(logPath, "utf-8")); } catch (e) { console.warn("daily-log解析失败", e.message); }
      }
      const existingIdx = log.findIndex(d => d.date === date && d.book === book.name);
      if (existingIdx >= 0) {
        log[existingIdx] = summary;
      } else {
        log.push(summary);
      }
      log.sort((a, b) => a.date.localeCompare(b.date));
      fs.writeFileSync(logPath, JSON.stringify(log, null, 2));

      // 6. Generate CSV
      generateCSV(summary, bookDir);

      console.log(`   ✅ ${book.name} 采集完成`);
    }

    // 7. Benefits (author-level, doesn't change daily — skip if already collected)
    const benefitsPath = path.join(baseDayDir, "benefits.json");
    if (fs.existsSync(benefitsPath)) {
      console.log("\n🎁 福利管理: 今日已采集，跳过");
    } else {
      console.log("\n🎁 采集: 福利管理...");
      try {
        await jsClick(page, "福利管理");
        await page.waitForTimeout(1000);
        await jsClick(page, "作家等级");
        await page.waitForTimeout(2000);
        const benefits = await collectBenefits(page);
        if (benefits.authorLevel) console.log(`   作家等级: Lv.${benefits.authorLevel}`);
        fs.writeFileSync(benefitsPath, JSON.stringify(benefits, null, 2));
      } catch (e) { console.error(`   ✗ 福利数据采集失败: ${e.message}`); }
    }

    console.log("\n========================================");
    console.log(`✅ 采集完成！共处理 ${targetBooks.length} 本书`);
    console.log(`📂 数据目录: ${baseDayDir}`);
    console.log("========================================");

    // 关闭采集页面（但不关闭浏览器），浏览器保持运行
    // 下次 collect 直接 CDP 重连，无需重新登录
    await page.close().catch(() => {});
    const browserName = BROWSER_REGISTRY[config.browser]?.name || "浏览器";
    console.log(`\n📄 采集完成（${browserName} 保持运行，下次免登重连）`);

  } catch (e) {
    console.error("\n❌ 采集出错:", e.message);
    const errPath = path.join(baseDayDir, "error.png");
    await page.screenshot({ path: errPath, fullPage: true }).catch(() => {});
    console.error(`   错误截图: ${errPath}`);
    await browser.close();
    console.error("\n📄 浏览器已关闭（出错保护）");
  }
}

// ── CSV Generator ───────────────────────────────────────────────────

function generateCSV(summary, dayDir) {
  const ws = summary.worksData || {};
  const rv = (summary.revenue?.overview) || {};
  // Daily metrics CSV
  const metricsPath = path.join(dayDir, "metrics.csv");
  const metricsRows = [
    "指标,数值",
    `阅读人数,${ws["阅读人数"] || 0}`,
    `在读人数,${ws["在读人数"] || 0}`,
    `加书架人数,${ws["加书架人数"] || 0}`,
    `评论次数,${ws["评论次数"] || 0}`,
    `催更人数,${ws["催更人数"] || 0}`,
    `追更人数,${ws["追更人数"] || 0}`,
    `作品评分,${ws["作品评分"] || 0}`,
    `昨日收益,${rv.yesterdayRevenue || 0}`,
    `累计收益,${rv.totalRevenue || 0}`,
  ].join("\n");
  fs.writeFileSync(metricsPath, "﻿" + metricsRows, "utf-8");

  // Revenue CSV
  if (summary.revenue.dailyRevenue.length > 0) {
    const revPath = path.join(dayDir, "revenue.csv");
    const revRows = ["日期,总计,阅读收益,听书收益,互动收益"];
    for (const r of summary.revenue.dailyRevenue) {
      revRows.push(`${r.date},${r.total},${r.readRevenue},${r.audioRevenue},${r.interactRevenue}`);
    }
    fs.writeFileSync(revPath, "﻿" + revRows.join("\n"), "utf-8");
  }
}

// ── Multi-book support ───────────────────────────────────────────────
// daily-log.json 每条记录现在有 book 字段。
// 报告函数需要先按书名过滤，再分析，避免多书数据混在一起。
// 向后兼容旧数据（books 数组格式，无 book 字段）。

function filterLogByBook(log, targetBook) {
  return log.filter(d => {
    if (d.book) return d.book === targetBook;
    // Old format: use d.books[0].name
    return d.books?.[0]?.name === targetBook;
  });
}

function getBookName(log) {
  // Try new format first (d.book field)
  const newNames = [...new Set(log.map(d => d.book).filter(Boolean))];
  if (newNames.length > 0) return newNames;
  // Fallback to old format (d.books[0].name)
  return [...new Set(log.map(d => d.books?.[0]?.name).filter(Boolean))];
}

function resolveBook(log, requested) {
  const bookList = getBookName(log);
  if (!bookList) return { entries: [], book: null };
  if (requested) {
    // Fuzzy match
    const match = bookList.find(b => b.includes(requested) || requested.includes(b));
    if (match) return { entries: filterLogByBook(log, match), book: match };
    console.warn(`   ⚠ 未找到 "${requested}"，使用最近作品`);
  }
  // Default: most recent entry's book
  const latestBook = log[log.length - 1]?.book || bookList[0];
  return { entries: filterLogByBook(log, latestBook), book: latestBook };
}

// Find quality.json — tries multi-book path first, then flat path
function findQualityPath(entry) {
  if (!entry) return null;
  const bookSafe = (entry.book || "").replace(/[<>:"/\\|?*]/g, "_").trim();
  // Multi-book path: data/<date>/<book_name>/quality.json
  const multiPath = path.join(DATA_DIR, entry.date, bookSafe, "quality.json");
  if (fs.existsSync(multiPath)) return multiPath;
  // Legacy flat path: data/<date>/quality.json
  const flatPath = path.join(DATA_DIR, entry.date, "quality.json");
  if (fs.existsSync(flatPath)) return flatPath;
  return null;
}

// ── Report Generator ────────────────────────────────────────────────

function doReport() {
  const logPath = path.join(DATA_DIR, "daily-log.json");
  if (!fs.existsSync(logPath)) {
    console.error("❌ 暂无数据，请先运行 collect");
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(logPath, "utf-8"));
  if (raw.length === 0) {
    console.error("❌ 数据为空");
    process.exit(1);
  }

  const { entries: log, book } = resolveBook(raw, opts.book);
  if (!log.length) { console.error("❌ 未找到该书数据"); process.exit(1); }
  const bookList = getBookName(raw);

  console.log("📊 番茄小说数据趋势报告");
  console.log("========================================\n");
  if (book) console.log(`📖 作品: ${book}`);
  if (bookList.length > 1) console.log(`📚 已采集 ${bookList.length} 本书 (用 --book 切换)`);
  console.log(`数据范围: ${log[0].date} ~ ${log[log.length - 1].date} (${log.length} 天)\n`);

  // Trend analysis
  if (log.length >= 2) {
    console.log("── 阅读数据趋势 ──");
    printTrend("阅读人数", log, "worksData", "阅读人数");
    printTrend("在读人数", log, "worksData", "在读人数");
    printTrend("加书架", log, "worksData", "加书架人数");
    console.log("");

    console.log("── 收益趋势 ──");
    printTrend("昨日收益", log, "revenue.overview", "yesterdayRevenue");
    printTrend("累计收益", log, "revenue.overview", "totalRevenue");
    console.log("");

    // Revenue chart (ASCII)
    console.log("── 每日收益曲线 ──");
    const maxRev = Math.max(...log.map(d => getNested(d, "revenue.overview.yesterdayRevenue") || 0), 0.01);
    for (const d of log) {
      const rev = getNested(d, "revenue.overview.yesterdayRevenue") || 0;
      const barLen = Math.round((rev / maxRev) * 40);
      console.log(`  ${d.date}  ¥${rev.toFixed(2).padStart(5)}  ${"█".repeat(barLen)}`);
    }
    console.log("");

    // Reader chart
    console.log("── 每日阅读人数曲线 ──");
    const maxReaders = Math.max(...log.map(d => getNested(d, "worksData.阅读人数") || 0), 1);
    for (const d of log) {
      const readers = getNested(d, "worksData.阅读人数") || 0;
      const barLen = Math.round((readers / maxReaders) * 40);
      console.log(`  ${d.date}  ${String(readers).padStart(4)}人  ${"▓".repeat(barLen)}`);
    }
  }

  // Insights
  console.log("\n── 趋势洞察 ──");
  if (log.length >= 2) {
    const readers = log.map(d => getNested(d, "worksData.阅读人数") || 0);
    const revenue = log.map(d => getNested(d, "revenue.overview.yesterdayRevenue") || 0);
    const bookmarks = log.map(d => getNested(d, "worksData.加书架人数") || 0);

    const readerTrend = readers[readers.length - 1] - readers[0];
    const revTrend = revenue[revenue.length - 1] - revenue[0];

    if (readerTrend > 0) console.log(`  📈 阅读人数上升趋势 (+${readerTrend}，近${log.length}天)`);
    else if (readerTrend < 0) console.log(`  📉 阅读人数下降趋势 (${readerTrend})`);
    else console.log("  ➡ 阅读人数平稳");

    if (revTrend > 0) console.log(`  💰 日收益增长 (+¥${revTrend.toFixed(2)})`);
    else if (revTrend < 0) console.log(`  💸 日收益下降 (¥${revTrend.toFixed(2)})`);

    const peakDay = log.reduce((a, b) =>
      (getNested(b, "worksData.阅读人数") || 0) > (getNested(a, "worksData.阅读人数") || 0) ? b : a
    );
    console.log(`  🔥 最佳日: ${peakDay.date} (阅读${getNested(peakDay, "worksData.阅读人数") || 0}人, 收益¥${getNested(peakDay, "revenue.overview.yesterdayRevenue") || 0})`);

    if (readers[readers.length - 1] > readers[0] * 3 && log.length >= 3)
      console.log("  ⚡ 近期增长显著，关注推荐位变化");
  }

  // Quality milestones
  const latestQ = log[log.length - 1]?.quality || {};
  const mcs = latestQ.milestoneChapters || {};
  if (Object.keys(mcs).length > 0) {
    console.log("\n── 完读率里程碑 ──");
    console.log(`  累计字数: ${(latestQ.cumulativeWords || 0).toLocaleString()}`);
    const labels = { 10000: "1万字", 30000: "3万字", 50000: "5万字", 100000: "10万字", 200000: "20万字", 300000: "30万字" };
    for (const [k, v] of Object.entries(mcs).sort((a, b) => parseInt(a[0]) - parseInt(b[0]))) {
      const w = parseInt(k);
      const label = labels[w] || `${Math.round(w / 10000)}万字`;
      const rate = v.completionRate != null ? `${v.completionRate.toFixed(1)}%` : "暂无";
      console.log(`  ${label}: 第${v.chapter}章 | 读完率 ${rate}`);
    }
  }

  console.log("\n========================================");
  console.log(`📂 完整数据: ${DATA_DIR}`);
}

function getNested(obj, path) {
  return path.split(".").reduce((o, k) => o?.[k], obj);
}

function printTrend(label, log, objKey, field) {
  const values = log.map(d => getNested(d, `${objKey}.${field}`) || 0);
  const first = values[0];
  const last = values[values.length - 1];
  const change = first > 0 ? ((last - first) / first * 100).toFixed(1) : "N/A";
  const arrow = last > first ? "↑" : last < first ? "↓" : "→";
  console.log(`  ${label}: ${first} → ${last} (${arrow}${change}%)`);
  console.log(`    最高: ${Math.max(...values)} | 最低: ${Math.min(...values)} | 平均: ${(values.reduce((a, b) => a + b, 0) / values.length).toFixed(1)}`);
}

// ══════════════════════════════════════════════════════════════════════
// 收益预测模型
// ══════════════════════════════════════════════════════════════════════

function linearRegression(points) {
  const n = points.length;
  if (n < 2) return null;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += points[i];
    sumXY += i * points[i];
    sumX2 += i * i;
  }
  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  const intercept = (sumY - slope * sumX) / n;
  // R-squared
  const meanY = sumY / n;
  let ssRes = 0, ssTot = 0;
  for (let i = 0; i < n; i++) {
    ssRes += (points[i] - (slope * i + intercept)) ** 2;
    ssTot += (points[i] - meanY) ** 2;
  }
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;
  return { slope, intercept, r2 };
}

function predictFuture(values, days) {
  const reg = linearRegression(values);
  if (!reg) return [];

  // Weight recent data more heavily (exponential decay)
  const recentAvg = values.slice(-3).reduce((a, b) => a + b, 0) / Math.min(3, values.length);
  const allAvg = values.reduce((a, b) => a + b, 0) / values.length;
  const trendWeight = Math.min(0.7, Math.max(0.3, reg.r2)); // weight trend by R² confidence

  const predictions = [];
  for (let i = 1; i <= days; i++) {
    const trendVal = reg.slope * (values.length + i - 1) + reg.intercept;
    // Blend: trend line × confidence + recent average × (1 - confidence)
    const blended = trendVal * trendWeight + recentAvg * (1 - trendWeight);
    // Three scenarios
    const optimistic = trendVal * (1 + 0.15 * (i / days));
    const conservative = trendVal * 0.8 + recentAvg * 0.2;
    predictions.push({
      day: i,
      conservative: Math.max(0, conservative),
      expected: Math.max(0, blended),
      optimistic: Math.max(0, optimistic),
    });
  }
  return predictions;
}

function doPredict() {
  const logPath = path.join(DATA_DIR, "daily-log.json");
  if (!fs.existsSync(logPath)) { console.error("❌ 暂无数据"); process.exit(1); }

  const raw = JSON.parse(fs.readFileSync(logPath, "utf-8"));
  const { entries: log, book } = resolveBook(raw, opts.book);
  if (!log.length) { console.error("❌ 未找到该书数据"); process.exit(1); }
  const latest = log[log.length - 1];

  // Use detailed daily revenue table if available (from 30-day tab)
  let revenue = log.map(d => getNested(d, "revenue.overview.yesterdayRevenue") || 0);
  const dailyTable = latest.revenue?.dailyRevenue || [];
  if (dailyTable.length > revenue.length) {
    revenue = dailyTable.map(d => d.total || 0).reverse(); // oldest→newest
  }
  // Trim leading zeros for better trend fitting (old zero days drag down the slope)
  let trimmedRevenue = revenue;
  while (trimmedRevenue.length > 3 && trimmedRevenue[0] === 0) {
    trimmedRevenue = trimmedRevenue.slice(1);
  }
  const trimmedDays = revenue.length - trimmedRevenue.length;
  if (trimmedDays > 0) {
    console.log(`   (跳过前 ${trimmedDays} 天空数据，用后 ${trimmedRevenue.length} 天拟合)`);
  }

  const readers = log.map(d => getNested(d, "worksData.阅读人数") || 0);

  console.log("🔮 番茄小说收益预测");
  console.log("========================================\n");
  if (book) console.log(`📖 作品: ${book}`);
  console.log(`历史数据: ${log.length} 天`);
  console.log(`当前日收益: ¥${revenue[revenue.length - 1].toFixed(2)}`);
  console.log(`当前阅读人数: ${readers[readers.length - 1]}人\n`);

  const predData = trimmedRevenue.length >= 3 ? trimmedRevenue : revenue;
  if (predData.length < 3) {
    console.warn("⚠️ 至少需要 3 天有收益数据才能预测\n");
    return;
  }

  const reg = linearRegression(predData);
  console.log(`回归模型: y = ${reg.slope.toFixed(4)}x + ${reg.intercept.toFixed(4)} (R²=${reg.r2.toFixed(3)})`);
  console.log(`趋势: ${reg.slope > 0.01 ? "📈 上升" : reg.slope < -0.01 ? "📉 下降" : "➡ 平稳"}\n`);

  // 7-day prediction table
  console.log("── 未来 7 天收益预测 ──");
  const pred7 = predictFuture(predData, 7);
  console.log("  天数  保守      预期      乐观");
  console.log("  ───────────────────────────────");
  let total7 = 0;
  for (const p of pred7) {
    console.log(`  第${String(p.day).padStart(2)}天  ¥${p.conservative.toFixed(2).padStart(6)}  ¥${p.expected.toFixed(2).padStart(6)}  ¥${p.optimistic.toFixed(2).padStart(6)}`);
    total7 += p.expected;
  }
  console.log(`\n  7天预期总收益: ¥${total7.toFixed(2)}`);

  // 30-day projection
  const pred30 = predictFuture(predData, 30);
  const total30 = pred30.reduce((s, p) => s + p.expected, 0);
  console.log(`\n── 30 天预期 ──`);
  console.log(`  月收益预估: ¥${total30.toFixed(2)}`);
  console.log(`  日均收益: ¥${(total30 / 30).toFixed(2)}`);

  // Milestone projections (only show reachable ones)
  console.log("\n── 收入里程碑预测 ──");
  const dailyAvg = predData.slice(-7).reduce((a, b) => a + b, 0) / Math.min(7, predData.length);
  let prevShown = true;
  for (const m of REVENUE_MILESTONES) {
    if (!prevShown) break;
    if (dailyAvg > 0) {
      const daysNeeded = Math.round(m.target / dailyAvg);
      const yearsNeeded = daysNeeded / 365;
      if (yearsNeeded <= 2) {
        console.log(`  ${m.label}: 约需 ${daysNeeded} 天 (${(yearsNeeded * 12).toFixed(1)} 个月)`);
      } else if (yearsNeeded <= 10) {
        console.log(`  ${m.label}: 约需 ${daysNeeded} 天 (${yearsNeeded.toFixed(1)} 年)`);
        console.log(`    → 需在现有基础上大幅提升追读率和日更字数`);
        prevShown = false;
      } else {
        console.log(`  ${m.label}: 当前差距较大，先专注提升内容质量和日更节奏`);
        prevShown = false;
      }
    } else {
      console.log(`  收益数据积累中，暂无预测`);
      prevShown = false;
    }
  }
  console.log("");
}

// ══════════════════════════════════════════════════════════════════════
// 章节趋势分析 + 异常预警
// ══════════════════════════════════════════════════════════════════════

function doChapters() {
  const logPath = path.join(DATA_DIR, "daily-log.json");
  if (!fs.existsSync(logPath)) { console.error("❌ 暂无数据，请先运行 collect"); process.exit(1); }

  const raw = JSON.parse(fs.readFileSync(logPath, "utf-8"));
  const { entries: log, book } = resolveBook(raw, opts.book);
  if (!log.length) { console.error("❌ 未找到该书数据"); process.exit(1); }
  const latest = log[log.length - 1];

  // Load chapter list from the latest day's quality.json (multi-book + legacy fallback)
  const qualityPath = findQualityPath(latest);
  let chapterList = [];
  if (qualityPath) {
    const quality = JSON.parse(fs.readFileSync(qualityPath, "utf-8"));
    chapterList = quality.chapterList || [];
  }

  console.log("📖 章节数据分析");
  console.log("========================================\n");
  if (book) console.log(`📖 作品: ${book}`);

  if (chapterList.length === 0) {
    console.warn("⚠️ 暂无章节数据，请先运行 collect 采集质量分析数据\n");
    return;
  }

  // Basic chapter stats
  const totalWords = chapterList.reduce((s, c) => s + (c.wordCount || 0), 0);
  const avgWords = Math.round(totalWords / chapterList.length);
  const totalComments = chapterList.reduce((s, c) => s + (c.comments || 0) + (c.paragraphComments || 0), 0);
  const totalUrges = chapterList.reduce((s, c) => s + (c.urges || 0), 0);
  const recentChapters = chapterList.slice(-10);

  console.log(`总章节数: ${chapterList.length} | 总字数: ${totalWords.toLocaleString()}`);
  console.log(`平均每章: ${avgWords.toLocaleString()} 字 | 总评论: ${totalComments} | 总催更: ${totalUrges}\n`);

  // Recent chapters table
  console.log("── 最近 10 章数据 ──");
  console.log("  章节        字数      评论  催更  发布时间");
  console.log("  " + "─".repeat(55));
  for (const ch of [...recentChapters].reverse()) {
    const w = String(ch.wordCount || 0).padStart(5);
    const c = String(ch.comments || 0).padStart(4);
    const u = String(ch.urges || 0).padStart(4);
    const title = (ch.title || "").substring(0, 18).padEnd(18);
    console.log(`  ${title} ${w}  ${c}  ${u}  ${ch.publishTime || ""}`);
  }

  // Anomaly detection: chapters with significantly lower completion rate
  console.log("\n── 异常预警 ──");

  // Load completion rates if available
  let chapters = [];
  if (qualityPath) {
    const quality = JSON.parse(fs.readFileSync(qualityPath, "utf-8"));
    chapters = quality.chapters || [];
  }

  // Check for chapters with low completion rates
  if (chapters.length > 0) {
    const rates = chapters.map(c => c.completionRate).filter(r => r > 0);
    const avgRate = rates.length > 0 ? rates.reduce((a, b) => a + b, 0) / rates.length : 0;

    for (const ch of chapters) {
      if (ch.completionRate > 0 && ch.completionRate < avgRate * 0.3) {
        console.log(`  🚨 第${ch.chapter}章 "${ch.title}" 读完率 ${ch.completionRate}% (远低于平均 ${avgRate.toFixed(1)}%)`);
        console.log(`     → 建议：检查该章内容是否存在节奏拖沓、信息密度低等问题`);
      }
    }

    // Follow-read rate analysis (跟读率) — tracks reader retention across chapters
    const followRates = chapters.map(c => c.followReadRate).filter(r => r > 0);
    if (followRates.length > 0) {
      const avgFollow = followRates.reduce((a, b) => a + b, 0) / followRates.length;
      console.log(`\n  📖 平均跟读率: ${avgFollow.toFixed(1)}% | 平均读完率: ${avgRate.toFixed(1)}%`);

      // Flag chapters where follow rate drops sharply (readers quit after this chapter)
      for (const ch of chapters) {
        if (ch.followReadRate > 0 && ch.followReadRate < avgFollow * 0.3) {
          console.log(`  🔴 第${ch.chapter}章 "${ch.title}" 跟读率暴跌至 ${ch.followReadRate}% (平均 ${avgFollow.toFixed(1)}%)`);
          console.log(`     → 建议：此章可能是读者流失关键节点，检查情节转折/节奏问题`);
        }
      }
    }

    // Loss rate analysis (流失率) — inverse of completion rate (from stats_type=3)
    const lossRates = chapters.map(c => c.lossRate).filter(r => r > 0);
    if (lossRates.length > 0) {
      const avgLoss = lossRates.reduce((a, b) => a + b, 0) / lossRates.length;
      const highLoss = chapters.filter(c => c.lossRate > avgLoss * 1.5);
      if (highLoss.length > 0) {
        const worst = highLoss.sort((a, b) => b.lossRate - a.lossRate)[0];
        console.warn(`  ⚠ 最高流失率: 第${worst.chapter}章 "${worst.title}" 流失率 ${worst.lossRate}% (平均 ${avgLoss.toFixed(1)}%)`);
      }
    }
  }

  // Check for sudden drop in chapter word count (possible rushed writing)
  if (chapterList.length >= 5) {
    const recentWordCounts = recentChapters.map(c => c.wordCount);
    const avgRecent = recentWordCounts.reduce((a, b) => a + b, 0) / recentWordCounts.length;
    for (const ch of recentChapters) {
      if (ch.wordCount < avgRecent * 0.6 && ch.wordCount > 0) {
        console.warn(`  ⚠ 第${ch.chapter}章 字数 ${ch.wordCount} (低于近期平均 ${Math.round(avgRecent)})`);
        console.log(`     → 建议：章节过短可能影响读者追读意愿`);
      }
    }
  }

  // Check for chapters with zero interaction (possible reader dropout point)
  const zeroInteraction = recentChapters.filter(c => c.comments === 0 && c.urges === 0 && c.paragraphComments === 0);
  if (zeroInteraction.length >= 3) {
    console.warn(`  ⚠ 连续 ${zeroInteraction.length} 章零互动，读者参与度下降`);
    console.log(`     → 建议：考虑在章节末尾增加互动引导（提问/投票/彩蛋）`);
  }

  if (chapters.length === 0 && chapterList.length === 0) {
    console.log("  ✅ 暂无异常数据");
  }

  // Reader trend per chapter (from daily log)
  console.log("\n── 追读趋势 ──");
  const readerTrend = log.map(d => ({
    date: d.date,
    readers: getNested(d, "worksData.阅读人数") || 0,
    activeReaders: getNested(d, "worksData.在读人数") || 0,
    bookmarks: getNested(d, "worksData.加书架人数") || 0,
    revenue: getNested(d, "revenue.overview.yesterdayRevenue") || 0,
  }));

  // Calculate follow-rate (追读率 = 追更人数 / 阅读人数)
  // 注意：分母用每日阅读人数，非 14 天累计在读人数
  for (const day of log) {
    const readers = getNested(day, "worksData.阅读人数") || 1;
    const follow = getNested(day, "worksData.追更人数") || 0;
    const rate = readers > 0 ? (follow / readers * 100) : 0;
    day._followRate = rate;
  }
  const followRates = log.map(d => d._followRate || 0);
  if (followRates.some(r => r > 0)) {
    const maxFr = Math.max(...followRates, 1);
    for (const d of log) {
      const bar = "█".repeat(Math.round((d._followRate || 0) / maxFr * 20));
      console.log(`  ${d.date}  追读率 ${(d._followRate || 0).toFixed(1)}%  ${bar}`);
    }

    // Alert on dropping follow rate
    const recentFr = followRates.slice(-3);
    const olderFr = followRates.slice(-6, -3);
    if (recentFr.length >= 3 && olderFr.length >= 3) {
      const recentAvg = recentFr.reduce((a, b) => a + b, 0) / recentFr.length;
      const olderAvg = olderFr.reduce((a, b) => a + b, 0) / olderFr.length;
      if (olderAvg > 0 && recentAvg < olderAvg * 0.7) {
        console.log(`\n  🔴 追读率暴跌预警: ${olderAvg.toFixed(1)}% → ${recentAvg.toFixed(1)}%`);
        console.log(`     → 建议：检查最近章节是否存在剧情断裂、人设崩塌等问题`);
      }
    }
  }

  console.log("");
}

// ══════════════════════════════════════════════════════════════════════
// 作者核心指标
// ══════════════════════════════════════════════════════════════════════

function doMetrics() {
  const logPath = path.join(DATA_DIR, "daily-log.json");
  if (!fs.existsSync(logPath)) { console.error("❌ 暂无数据"); process.exit(1); }

  const raw = JSON.parse(fs.readFileSync(logPath, "utf-8"));
  const { entries: log, book } = resolveBook(raw, opts.book);
  if (!log.length) { console.error("❌ 未找到该书数据"); process.exit(1); }
  const latest = log[log.length - 1];

  console.log("📐 作者核心指标分析");
  console.log("========================================\n");
  if (book) console.log(`📖 作品: ${book}`);

  // Load latest quality data for word counts (multi-book + legacy fallback)
  const qualityPath = findQualityPath(latest);
  let chapterList = [];
  let totalWords = 0;
  if (qualityPath) {
    try {
      const quality = JSON.parse(fs.readFileSync(qualityPath, "utf-8"));
      chapterList = quality.chapterList || [];
      totalWords = chapterList.reduce((s, c) => s + (c.wordCount || 0), 0);
    } catch { console.warn(`⚠ 质量数据文件读取异常: ${qualityPath}`); }
  }

  // ── 1. 每千字收益 ──
  console.log("── 💰 收益效率 ──");
  const totalRevenue = getNested(latest, "revenue.overview.totalRevenue") || 0;
  if (totalWords > 0) {
    const perKWords = (totalRevenue / (totalWords / 1000));
    console.log(`  总字数: ${totalWords.toLocaleString()}`);
    console.log(`  累计收益: ¥${totalRevenue.toFixed(2)}`);
    console.log(`  每千字收益: ¥${perKWords.toFixed(4)}`);
    if (perKWords < 0.01) {
      console.log(`  → 当前千字收益较低，验证期过后会逐步提升`);
    } else if (perKWords < 0.1) {
      console.log(`  → 千字收益正在积累，建议保持日更`);
    } else {
      console.log(`  → 千字收益不错，继续保持内容质量`);
    }
  } else {
    console.warn("  ⚠ 暂无字数数据");
  }

  // ── 2. 全勤奖达标进度 ──
  console.log("\n── 🎯 全勤奖达标进度 ──");
  if (chapterList.length > 0) {
    // Analyze update pattern from chapter publish dates
    const pubDates = chapterList.map(c => c.publishTime?.slice(0, 10)).filter(Boolean);
    const uniqueDates = [...new Set(pubDates)].sort();

    if (uniqueDates.length >= 2) {
      const lastDate = new Date(uniqueDates[uniqueDates.length - 1]);
      const today = new Date();

      // Count consecutive days updated (looking backward from last update)
      let consecutiveDays = 1;
      for (let i = uniqueDates.length - 2; i >= 0; i--) {
        const prev = new Date(uniqueDates[i]);
        const diff = (new Date(uniqueDates[i + 1]) - prev) / (1000 * 60 * 60 * 24);
        if (diff <= 1.5) { consecutiveDays++; }
        else { break; }
      }

      // Check if today has been updated
      const todayStr = today.toISOString().slice(0, 10);
      const updatedToday = uniqueDates[uniqueDates.length - 1] === todayStr;

      console.log(`  连续更新: ${consecutiveDays} 天`);
      console.log(`  今日已更新: ${updatedToday ? "✅ 是" : "⚠ 否"}`);
      console.log(`  全勤要求: 当月每日更新 ≥ 2000 字`);

      // Current month progress
      const now = new Date();
      const dayOfMonth = now.getDate();
      const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      const monthProgress = Math.round(dayOfMonth / daysInMonth * 100);

      console.log(`  本月进度: ${dayOfMonth}/${daysInMonth} 天 (${monthProgress}%)`);

      // Warning: 3 days before month end
      if (daysInMonth - dayOfMonth <= 3 && daysInMonth - dayOfMonth > 0) {
        console.log(`  🚨 距月底还有 ${daysInMonth - dayOfMonth} 天！务必保持每日更新以免断全勤！`);
      } else if (!updatedToday) {
        console.warn(`  ⚠ 今日尚未更新，请尽快发布章节`);
      }

      // Estimated monthly update count
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
      const monthUpdates = uniqueDates.filter(d => d >= monthStart).length;
      console.log(`  本月已更新: ${monthUpdates} 天`);
    } else {
      console.warn("  ⚠ 更新数据不足，需要更多章节数据");
    }
  }

  // ── 3. 收入目标倒推 ──
  console.log("\n── 🎯 收入目标分析 ──");
  const dailyRev = getNested(latest, "revenue.overview.yesterdayRevenue") || 0;
  const dailyRevAvg = log.slice(-7).reduce((s, d) => s + (getNested(d, "revenue.overview.yesterdayRevenue") || 0), 0) / Math.min(7, log.length);
  const readers = getNested(latest, "worksData.阅读人数") || 0;
  const avgChapterWords = chapterList.length > 0 ? Math.round(totalWords / chapterList.length) : 4000;

  console.log(`  当前日均收益: ¥${dailyRevAvg.toFixed(2)}`);
  console.log(`  当前日均阅读: ${Math.round(readers)} 人`);
  console.log(`  平均章节字数: ${avgChapterWords.toLocaleString()}`);

  // Revenue per reader
  const revPerReader = readers > 0 ? dailyRev / readers : 0;
  console.log(`  单读者日均价值: ¥${revPerReader.toFixed(4)}`);

  for (const g of REVENUE_MILESTONES) {
    const neededDaily = g.target / 30;
    if (dailyRevAvg > 0) {
      const multiplier = neededDaily / dailyRevAvg;
      // Only show actionable goals (within 100x current)
      if (multiplier <= 100) {
        const neededReaders = revPerReader > 0 ? Math.round(neededDaily / revPerReader) : null;
        console.log(`\n  ${g.icon} ${g.label}:`);
        console.log(`    需日均 ¥${neededDaily.toFixed(2)} (当前 ${multiplier.toFixed(1)}x)`);
        if (neededReaders && neededReaders < 1000000) {
          console.log(`    约需 ${neededReaders.toLocaleString()} 日阅读人数`);
        }
        // Sensible word count recommendation
        const recWords = avgChapterWords * Math.min(multiplier, 1.5);
        console.log(`    建议日更 ${Math.round(recWords)} 字以上`);
      } else {
        console.log(`\n  ${g.icon} ${g.label}: 当前差距较大 (${multiplier.toFixed(0)}x)，`);
        console.log(`    先专注提升追读率和章节质量，积累读者基础`);
        break; // Don't show harder goals
      }
    } else {
      console.log(`\n  ${g.icon} ${g.label}: 当前收益为 0，数据积累中...`);
      break;
    }
  }

  // ── 4. 收益构成估算 ──
  console.log("\n── 📊 收益构成分析 ──");
  const revData = latest.revenue?.dailyRevenue || [];
  if (revData.length > 0) {
    const totalReadRev = revData.reduce((s, d) => s + (d.readRevenue || 0), 0);
    const totalAudioRev = revData.reduce((s, d) => s + (d.audioRevenue || 0), 0);
    const totalInteractRev = revData.reduce((s, d) => s + (d.interactRevenue || 0), 0);
    const totalRev = totalReadRev + totalAudioRev + totalInteractRev;

    if (totalRev > 0) {
      console.log(`  阅读收益 (广告分成): ¥${totalReadRev.toFixed(2)} (${(totalReadRev / totalRev * 100).toFixed(1)}%)`);
      console.log(`  听书收益: ¥${totalAudioRev.toFixed(2)} (${(totalAudioRev / totalRev * 100).toFixed(1)}%)`);
      console.log(`  互动收益: ¥${totalInteractRev.toFixed(2)} (${(totalInteractRev / totalRev * 100).toFixed(1)}%)`);
      console.log(`  近7天合计: ¥${totalRev.toFixed(2)}`);

      // Note about what's NOT included (these can't be scraped automatically)
      console.log("\n  📝 说明:");
      console.log("  番茄收益 = 广告分成 + 完读奖励 + 全勤奖 + 书架订阅 + 活动奖励");
      console.log("  目前可自动采集: 阅读/听书/互动收益（含广告分成+完读奖励）");
      console.log("  全勤奖: 需满足当月每日更新 ≥2000字，奖励 ¥200-600/月");
      console.log("  书架订阅: 独立计算，需登录作家后台查看福利管理页面");
    } else {
      console.log("  暂无收益数据");
    }
  }

  console.log("");
}

// ══════════════════════════════════════════════════════════════════════
// 一键周报 / 月报
// ══════════════════════════════════════════════════════════════════════

function generateReport(log, period, label) {
  if (log.length === 0) return;

  const latest = log[log.length - 1];
  const revenue = log.map(d => getNested(d, "revenue.overview.yesterdayRevenue") || 0);
  const readers = log.map(d => getNested(d, "worksData.阅读人数") || 0);
  const activeReaders = log.map(d => getNested(d, "worksData.在读人数") || 0);
  const bookmarks = log.map(d => getNested(d, "worksData.加书架人数") || 0);
  const totalBookmarks = bookmarks.reduce((a, b) => a + b, 0);
  const totalRevenue = revenue.reduce((a, b) => a + b, 0);
  const totalReaders = readers.reduce((a, b) => a + b, 0);
  const avgReaders = Math.round(totalReaders / log.length);
  const peakReaders = Math.max(...readers);
  const peakDay = log[readers.indexOf(peakReaders)];

  console.log(`📊 ${label}`);
  console.log("=".repeat(60));
  console.log(`数据周期: ${log[0].date} ~ ${log[log.length - 1].date} (${log.length} 天)`);
  console.log(`当前作品: ${(latest.book || latest.books?.[0]?.name || "未知")}\n`);

  // Summary
  console.log("── 📋 核心数据 ──");
  console.log(`  累计阅读人数: ${totalReaders.toLocaleString()}`);
  console.log(`  日均阅读人数: ${avgReaders.toLocaleString()}`);
  console.log(`  峰值阅读: ${peakReaders.toLocaleString()} (${peakDay?.date || ""})`);
  console.log(`  累计收益: ¥${totalRevenue.toFixed(2)}`);
  console.log(`  日均收益: ¥${(totalRevenue / log.length).toFixed(2)}`);
  console.log(`  累计加书架: ${totalBookmarks.toLocaleString()}`);
  console.log(`  当前在读: ${activeReaders[activeReaders.length - 1] || 0}\n`);

  // Trend
  console.log("── 📈 趋势分析 ──");
  const firstReaders = readers[0];
  const lastReaders = readers[readers.length - 1];
  const readerChange = firstReaders > 0 ? ((lastReaders - firstReaders) / firstReaders * 100) : 0;
  const trendIcon = readerChange > 10 ? "📈 快速上升" : readerChange > 0 ? "📈 上升" : readerChange < -10 ? "📉 下降" : "➡ 平稳";
  console.log(`  阅读趋势: ${trendIcon} (${readerChange > 0 ? "+" : ""}${readerChange.toFixed(1)}%)`);
  console.log(`  起始: ${firstReaders}人 → 当前: ${lastReaders}人`);

  const firstRev = revenue[0];
  const lastRev = revenue[revenue.length - 1];
  const revChange = firstRev > 0 ? ((lastRev - firstRev) / firstRev * 100) : 0;
  console.log(`  收益趋势: ${revChange > 0 ? "📈 增长" : revChange < 0 ? "📉 下滑" : "➡ 平稳"}`);
  console.log(`  起始: ¥${firstRev.toFixed(2)} → 当前: ¥${lastRev.toFixed(2)}\n`);

  // Charts
  console.log("── 📊 阅读人数走势 ──");
  const maxR = Math.max(...readers, 1);
  for (const d of log) {
    const r = getNested(d, "worksData.阅读人数") || 0;
    const bar = "▓".repeat(Math.round((r / maxR) * 30));
    console.log(`  ${d.date}  ${String(r).padStart(4)}  ${bar}`);
  }

  console.log("\n── 💰 收益走势 ──");
  const maxRev = Math.max(...revenue, 0.01);
  for (const d of log) {
    const r = getNested(d, "revenue.overview.yesterdayRevenue") || 0;
    const bar = "█".repeat(Math.round((r / maxRev) * 30));
    console.log(`  ${d.date}  ¥${r.toFixed(2).padStart(5)}  ${bar}`);
  }

  // Insights
  console.log("\n── 💡 优化建议 ──");
  if (readerChange > 20) {
    console.log("  ✅ 阅读量快速增长，继续保持当前更新节奏");
    console.log("  ✅ 可适当增加每日字数以承接流量红利");
  } else if (readerChange > 0) {
    console.log("  ✅ 数据稳步增长，建议保持日更不低于 4000 字");
  } else if (readerChange < 0) {
    console.warn("  ⚠ 阅读量下滑，建议：");
    console.log("     1. 检查最近章节的读完率，定位流失节点");
    console.log("     2. 观察竞品同类型作品的数据变化");
    console.log("     3. 考虑优化简介、封面、前3章开头");
    console.log("     4. 增加章节末尾悬念，提升追读率");
  }

  if (bookmarks[bookmarks.length - 1] > readers[readers.length - 1] * 0.1) {
    console.log("  ✅ 加书架转化率较好，内容吸引力强");
  } else if (readers[readers.length - 1] > 0) {
    console.warn("  ⚠ 加书架率偏低，建议在章节首尾增加书架引导");
  }

  if (log.length >= 3 && revenue[revenue.length - 1] <= 0 && readers[readers.length - 1] > 50) {
    console.warn("  ⚠ 有流量无收益？可能原因：验证期/推荐验证中，收益次日更新");
  }

  // Prediction
  if (log.length >= 3) {
    const pred = predictFuture(revenue, 7);
    const next7Total = pred.reduce((s, p) => s + p.expected, 0);
    console.log(`\n  🔮 下周预测收益: ¥${next7Total.toFixed(2)} (日均 ¥${(next7Total / 7).toFixed(2)})`);

    // Word count recommendation
    console.log("\n── ✍️ 更新建议 ──");
    const _qualityPath = findQualityPath(latest);
    let avgWords = 4000;
    if (_qualityPath) {
      try {
        const quality = JSON.parse(fs.readFileSync(_qualityPath, "utf-8"));
        const cls = quality.chapterList || [];
        if (cls.length > 0) {
          avgWords = Math.round(cls.reduce((s, c) => s + (c.wordCount || 0), 0) / cls.length);
        }
      } catch (e) { console.warn("质量数据读取失败，使用默认值", e.message); }
    }
    console.log(`  当前平均章节: ${avgWords.toLocaleString()} 字`);
    if (avgWords < 2000) {
      console.warn("  ⚠ 章节字数偏低，建议提升至 3000-5000 字提升完读率");
    } else if (avgWords >= 4000) {
      console.log("  ✅ 章节字数合理，保持节奏");
    } else {
      console.log("  → 章节字数适中，可适当增加至 4000 字以提升收益");
    }
  }

  console.log("\n" + "=".repeat(60));
}

function doWeekly() {
  const logPath = path.join(DATA_DIR, "daily-log.json");
  if (!fs.existsSync(logPath)) { console.error("❌ 暂无数据"); process.exit(1); }
  const raw = JSON.parse(fs.readFileSync(logPath, "utf-8"));
  const { entries: log } = resolveBook(raw, opts.book);
  if (!log.length) { console.error("❌ 未找到该书数据"); process.exit(1); }
  const weekData = log.slice(-7);
  generateReport(weekData, "weekly", "📅 周报 (近7天)");
}

function doMonthly() {
  const logPath = path.join(DATA_DIR, "daily-log.json");
  if (!fs.existsSync(logPath)) { console.error("❌ 暂无数据"); process.exit(1); }
  const raw = JSON.parse(fs.readFileSync(logPath, "utf-8"));
  const { entries: log } = resolveBook(raw, opts.book);
  if (!log.length) { console.error("❌ 未找到该书数据"); process.exit(1); }
  const monthData = log.slice(-30);
  generateReport(monthData, "monthly", "📅 月报 (近30天)");
}

// ══════════════════════════════════════════════════════════════════════
// HTML 报告生成 (适合截图展示 / 导出分享)
// ══════════════════════════════════════════════════════════════════════

function htmlEscape(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function doHtml() {
  const logPath = path.join(DATA_DIR, "daily-log.json");
  if (!fs.existsSync(logPath)) { console.error("❌ 暂无数据"); process.exit(1); }
  const raw = JSON.parse(fs.readFileSync(logPath, "utf-8"));
  const { entries: log, book } = resolveBook(raw, opts.book);
  if (!log.length) { console.error("❌ 未找到该书数据"); process.exit(1); }
  const latest = log[log.length - 1];

  const revenue = log.map(d => getNested(d, "revenue.overview.yesterdayRevenue") || 0);
  const readers = log.map(d => getNested(d, "worksData.阅读人数") || 0);
  const activeReaders = log.map(d => getNested(d, "worksData.在读人数") || 0);
  const bookmarks = log.map(d => getNested(d, "worksData.加书架人数") || 0);

  // Build bar charts data
  const maxR = Math.max(...readers, 1);
  const maxRev = Math.max(...revenue, 0.01);
  const readerBars = log.map(d => {
    const r = getNested(d, "worksData.阅读人数") || 0;
    const pct = Math.round((r / maxR) * 100);
    return { date: d.date, value: r, pct };
  });
  const revBars = log.map(d => {
    const r = getNested(d, "revenue.overview.yesterdayRevenue") || 0;
    const pct = Math.round((r / maxRev) * 100);
    return { date: d.date, value: r, pct };
  });

  // Totals
  const totalReaders = readers.reduce((a, b) => a + b, 0);
  const totalRevenue = revenue.reduce((a, b) => a + b, 0);
  const totalBookmarks = bookmarks.reduce((a, b) => a + b, 0);
  const avgReaders = Math.round(totalReaders / log.length);
  const avgRevenue = totalRevenue / log.length;

  // Trends
  const readerChange = readers[0] > 0 ? ((readers[readers.length - 1] - readers[0]) / readers[0] * 100) : 0;
  const revChange = revenue[0] > 0 ? ((revenue[revenue.length - 1] - revenue[0]) / revenue[0] * 100) : 0;

  // Per-1000 words + raw quality data
  let perKWords = 0, totalWords = 0, avgChapWords = 0;
  let rawQuality = null; // full quality.json data (chapters, chapterList, etc.)
  const _htmlQualityPath = findQualityPath(latest);
  if (_htmlQualityPath) {
    try {
      rawQuality = JSON.parse(fs.readFileSync(_htmlQualityPath, "utf-8"));
      const cls = rawQuality.chapterList || [];
      totalWords = cls.reduce((s, c) => s + (c.wordCount || 0), 0);
      avgChapWords = cls.length > 0 ? Math.round(totalWords / cls.length) : 0;
      const totalRev = getNested(latest, "revenue.overview.totalRevenue") || 0;
      if (totalWords > 0) perKWords = totalRev / (totalWords / 1000);
    } catch { console.warn(`⚠ 质量数据读取异常: ${_htmlQualityPath}`); }
  }

  // Chapter anomalies
  let anomalies = [];
  if (rawQuality) {
    try {
      const cls = rawQuality.chapterList || [];
      const recentChapters = cls.slice(-10);
      const zeroInteraction = recentChapters.filter(c => c.comments === 0 && c.urges === 0 && c.paragraphComments === 0);
      if (zeroInteraction.length >= 3) {
        anomalies.push({ type: "warning", msg: `连续 ${zeroInteraction.length} 章零互动，建议增加章节末尾互动引导` });
      }
      const recentWordCounts = recentChapters.map(c => c.wordCount);
      const avgRecent = recentWordCounts.reduce((a, b) => a + b, 0) / recentWordCounts.length;
      for (const ch of recentChapters) {
        if (ch.wordCount < avgRecent * 0.6 && ch.wordCount > 0) {
          anomalies.push({ type: "warning", msg: `第${ch.chapter}章字数 ${ch.wordCount}，低于近期平均 ${Math.round(avgRecent)}` });
        }
      }
    } catch (e) { console.warn("异常检测失败", e.message); }
  }

  // Follow rate (追读率 = 追更人数 / 阅读人数)
  const followRates = log.map(d => {
    const readers = getNested(d, "worksData.阅读人数") || 1;
    const follow = getNested(d, "worksData.追更人数") || 0;
    return readers > 0 ? (follow / readers * 100) : 0;
  });

  // Prediction
  let pred7 = [];
  if (log.length >= 3) pred7 = predictFuture(revenue, 7);
  const next7Total = pred7.reduce((s, p) => s + p.expected, 0);

  const bookName = latest.book || "我的作品";
  const reportDate = new Date().toISOString().slice(0, 10);

  // ── Stage-aware analysis ──────────────────────────────────────────
  // 四个阶段：新书期 / 验证期 / 成长期 / 成熟期
  // 每个阶段的关注指标和优化方向不同

  const TOTAL_DAYS = log.length;
  const latestBm = bookmarks[bookmarks.length - 1] || 0;
  const latestReaders = readers[readers.length - 1] || 0;
  const dailyBmRate = latestReaders > 0 ? (latestBm / latestReaders * 100) : 0;

  // 阶段判定
  const stage =
    TOTAL_DAYS < 7              ? "new" :
    totalWords < 100000         ? "verification" :
    totalWords < 300000         ? "growth" :
                                  "mature";

  const stageLabels = {
    new: "新书期",
    verification: "验证期",
    growth: "成长期",
    mature: "成熟期",
  };

  // 完读率曲线分析：前30%章 vs 后30%章的读完率对比
  const qChs = rawQuality?.chapters || [];
  const qChList = rawQuality?.chapterList || [];
  const qDW = rawQuality?.dailyWords || {};
  const qMS = rawQuality?.milestones || {};
  const qMSChs = rawQuality?.milestoneChapters || {};
  let earlyCompletion = 0, lateCompletion = 0, completionTrend = 0;
  if (qChList.length >= 10) {
    const sorted = [...qChList].sort((a, b) => a.chapter - b.chapter);
    const first30 = sorted.slice(0, Math.max(3, Math.floor(sorted.length * 0.3)));
    const last30 = sorted.slice(-Math.max(3, Math.floor(sorted.length * 0.3)));
    // Match with completion rate data
    const rateByCh = {};
    for (const c of qChs) { rateByCh[c.chapter] = c.completionRate; }
    const earlyRates = first30.map(c => rateByCh[c.chapter] || 0).filter(r => r > 0);
    const lateRates = last30.map(c => rateByCh[c.chapter] || 0).filter(r => r > 0);
    earlyCompletion = earlyRates.length > 0 ? earlyRates.reduce((a, b) => a + b, 0) / earlyRates.length : 0;
    lateCompletion = lateRates.length > 0 ? lateRates.reduce((a, b) => a + b, 0) / lateRates.length : 0;
    completionTrend = earlyCompletion > 0 ? (lateCompletion - earlyCompletion) / earlyCompletion * 100 : 0;
  }

  // 收益稳定性（变异系数 CV = std/mean，越小越稳定）
  const revMean = revenue.reduce((a, b) => a + b, 0) / revenue.length;
  const revStd = Math.sqrt(revenue.reduce((s, r) => s + (r - revMean) ** 2, 0) / revenue.length);
  const revCV = revMean > 0 ? revStd / revMean : 0; // <0.3=稳定, 0.3-0.7=波动, >0.7=剧烈

  // 日更稳定性（最近14天）
  const dw = qDW;
  const recentDays = Object.entries(dw)
    .sort((a, b) => b[0].localeCompare(a[0]))
    .slice(0, 14);
  const recentWordVals = recentDays.map(d => d[1]);
  const avgDailyWords = recentWordVals.length > 0
    ? recentWordVals.reduce((a, b) => a + b, 0) / recentWordVals.length : 0;
  const missedDays = recentWordVals.filter(w => w === 0 || w < 500).length;

  const stageTips = (() => {
    const tips = [];

    // ── 阶段标签 ──
    tips.push(`<div class="alert info">当前阶段：<strong>${stageLabels[stage]}</strong> | 累计 ${totalWords.toLocaleString()} 字 | 共 ${qChList.length} 章 | 数据 ${TOTAL_DAYS} 天</div>`);

    // ── 新书期 (<7天) ──
    if (stage === "new") {
      tips.push('<div class="alert success">新书期数据样本偏少，推荐系统尚在探索目标读者。保持日更稳定性，等待模型匹配</div>');
      if (totalWords < 30000) {
        tips.push('<div class="alert info">建议快速积累到 3 万字以上，触发更多推荐场景</div>');
      }
    }

    // ── 验证期 (<10万字) ──
    if (stage === "verification") {
      tips.push(`<div class="alert info">距十万字验证节点还有 ${(100000 - totalWords).toLocaleString()} 字。十万字完读率是验证期最核心的考核指标，它决定了平台是否继续给量</div>`);
      const ms100k = (qMSChs || {})[100000];
      if (ms100k?.completionRate != null) {
        const rate = ms100k.completionRate;
        if (rate > 20) tips.push(`<div class="alert success">十万字完读率 ${rate.toFixed(1)}%，表现优秀，验证期通过概率高</div>`);
        else if (rate > 10) tips.push(`<div class="alert info">十万字完读率 ${rate.toFixed(1)}%，处于中等水平，保持内容质量以提升留存</div>`);
        else tips.push(`<div class="alert warning">十万字完读率 ${rate.toFixed(1)}% 偏低，建议检查前10万字剧情张力和人设吸引力</div>`);
      }
    }

    // ── 成长期 (10万-30万字) ──
    if (stage === "growth") {
      // 完读率曲线是关键
      if (completionTrend < -15) {
        tips.push(`<div class="alert warning">完读率曲线呈下降趋势（前段 ${earlyCompletion.toFixed(1)}% → 后段 ${lateCompletion.toFixed(1)}%），后期章节流失明显，建议检查中段剧情节奏</div>`);
      } else if (completionTrend > 5) {
        tips.push(`<div class="alert success">完读率曲线上升（前段 ${earlyCompletion.toFixed(1)}% → 后段 ${lateCompletion.toFixed(1)}%），后期内容吸引力强，读者越读越追</div>`);
      } else if (earlyCompletion > 0) {
        tips.push(`<div class="alert info">完读率曲线平稳（前段 ${earlyCompletion.toFixed(1)}% → 后段 ${lateCompletion.toFixed(1)}%），读者留存稳定</div>`);
      }

      // 收益趋势
      if (revCV < 0.3 && revMean > 0) {
        tips.push(`<div class="alert success">收益稳定（日均 ¥${revMean.toFixed(2)}，波动系数 ${revCV.toFixed(2)}），持续产出能力得到验证</div>`);
      } else if (revCV > 0.7) {
        tips.push(`<div class="alert info">收益波动较大（波动系数 ${revCV.toFixed(2)}），可能与推荐位周期有关，关注流量来源变化</div>`);
      }

      // 字数建议
      if (avgChapWords > 0 && avgChapWords < 2500) {
        tips.push(`<div class="alert warning">均章 ${avgChapWords} 字偏低，成长期建议提升至 3000-5000 字/章以增加广告展示</div>`);
      }
    }

    // ── 成熟期 (>30万字) ──
    if (stage === "mature") {
      // 长文本核心关注：后期留存、收益天花板、完读率长尾
      const ms300k = (qMSChs || {})[300000];
      if (completionTrend < -20) {
        tips.push(`<div class="alert warning">长文本后期完读率显著下降（前段 ${earlyCompletion.toFixed(1)}% → 后段 ${lateCompletion.toFixed(1)}%），超长篇幅可能导致读者疲劳。建议：<br>① 检查是否有冗余支线可精简<br>② 每50-100章设置剧情高潮点<br>③ 考虑是否接近自然完结节点</div>`);
      } else if (completionTrend < -5) {
        tips.push(`<div class="alert info">后期完读率轻度下滑（前段 ${earlyCompletion.toFixed(1)}% → 后段 ${lateCompletion.toFixed(1)}%），长文本正常衰减范围。保持质量，避免注水</div>`);
      } else {
        tips.push(`<div class="alert success">长文本完读率保持良好（后段 ${lateCompletion.toFixed(1)}%），读者忠诚度高。长线 IP 潜力值得关注</div>`);
      }

      if (ms300k?.completionRate != null) {
        tips.push(`<div class="alert info">三十万字完读率 ${ms300k.completionRate.toFixed(1)}%${ms300k.completionRate > 15 ? '，优秀。30万+字是番茄长文本分水岭，能维持此水平的作品有稳定长线收益' : ''}</div>`);
      }

      // 收益天花板
      if (revCV < 0.3 && revMean > 0) {
        tips.push(`<div class="alert success">收益进入稳定期（日均 ¥${revMean.toFixed(2)}），波动系数 ${revCV.toFixed(2)}，可作为基础盘评估月度预期收益</div>`);
      }

      // 更新建议
      if (missedDays > 2 && recentWordVals.length > 0) {
        tips.push(`<div class="alert warning">近14天有 ${missedDays} 天断更或低更（<500字），成熟期断更会直接影响推荐权重和读者信任</div>`);
      }
    }

    // ── 通用建议（所有阶段） ──

    // 日更稳定性
    if (missedDays === 0 && recentWordVals.length >= 7) {
      tips.push('<div class="alert success">日更稳定，近14天无断更记录，良好的更新习惯是长期收益的保障</div>');
    } else if (missedDays > 0 && recentWordVals.length > 0) {
      tips.push(`<div class="alert info">近14天有 ${missedDays} 天更新不足，建议保持日更习惯提升平台信任分</div>`);
    }

    if (perKWords > 0.01) {
      tips.push(`<div class="alert info">千字收益 ¥${perKWords.toFixed(4)}，作为平台竞争力的参考指标</div>`);
    }

    return tips.join("\n");
  })();

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${htmlEscape(bookName)} - 数据分析报告 (${reportDate})</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:"Microsoft YaHei","PingFang SC",sans-serif;background:#f5f7fa;color:#2c3e50;line-height:1.6}
.container{max-width:900px;margin:0 auto;padding:20px}
.header{background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:#fff;padding:30px;border-radius:12px;margin-bottom:20px;text-align:center}
.header h1{font-size:24px;margin-bottom:8px}
.header .meta{opacity:0.85;font-size:14px}
.card{background:#fff;border-radius:10px;padding:24px;margin-bottom:16px;box-shadow:0 2px 8px rgba(0,0,0,0.06)}
.card h2{font-size:18px;color:#667eea;margin-bottom:16px;border-bottom:2px solid #667eea;padding-bottom:8px}
.kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:16px}
.kpi{background:#f8f9fc;border-radius:8px;padding:14px;text-align:center}
.kpi .value{font-size:22px;font-weight:700;color:#667eea}
.kpi .unit{font-size:13px;color:#666;margin-top:2px}
.kpi.trend-up .value{color:#27ae60}
.kpi.trend-dn .value{color:#e74c3c}

.bar-row{display:flex;align-items:center;margin:4px 0;font-size:13px}
.bar-row .date{width:85px;flex-shrink:0;color:#666}
.bar-row .val{width:65px;flex-shrink:0;text-align:right;margin-right:8px;font-weight:600}
.bar-row .bar{height:18px;border-radius:3px;min-width:2px;transition:width .3s}
.bar-readers .bar{background:linear-gradient(90deg,#667eea,#764ba2)}
.bar-revenue .bar{background:linear-gradient(90deg,#f093fb,#f5576c)}

.pred-table{width:100%;border-collapse:collapse;font-size:14px}
.pred-table th{background:#667eea;color:#fff;padding:8px 12px;text-align:center}
.pred-table td{padding:8px 12px;text-align:center;border-bottom:1px solid #eee}
.pred-table tr:nth-child(even){background:#f8f9fc}

.alert{padding:12px 16px;border-radius:8px;margin:8px 0;font-size:14px}
.alert.warning{background:#fff3cd;border-left:4px solid #f39c12;color:#856404}
.alert.danger{background:#fce4e4;border-left:4px solid #e74c3c;color:#721c24}
.alert.success{background:#d4edda;border-left:4px solid #27ae60;color:#155724}
.alert.info{background:#d6eaf8;border-left:4px solid #2980b9;color:#1a5276}

.chapter-list{width:100%;border-collapse:collapse;font-size:13px}
.chapter-list th{background:#f0f0f0;padding:6px 10px;text-align:left;font-weight:600}
.chapter-list td{padding:6px 10px;border-bottom:1px solid #eee}

.footer{text-align:center;color:#999;font-size:12px;padding:20px;margin-top:10px}
.arrow-up{color:#27ae60}.arrow-dn{color:#e74c3c}
.tag{display:inline-block;padding:2px 8px;border-radius:10px;font-size:12px;font-weight:600}
.tag-up{background:#d4edda;color:#155724}
.tag-dn{background:#fce4e4;color:#721c24}
.tag-flat{background:#e8e8e8;color:#666}
</style>
</head>
<body>
<div class="container">

<div class="header">
  <h1>${htmlEscape(bookName)}</h1>
  <div class="meta">数据分析报告 · ${reportDate} 生成 · 数据跨度 ${log[0].date} ~ ${log[log.length - 1].date} (${log.length} 天)</div>
</div>

<!-- KPI Cards -->
<div class="card">
  <h2>核心指标</h2>
  <div class="kpi-grid">
    <div class="kpi${readerChange > 0 ? ' trend-up' : readerChange < 0 ? ' trend-dn' : ''}">
      <div class="value">${readers[readers.length - 1].toLocaleString()}</div>
      <div class="unit">阅读人数（日活读者） ${readerChange > 0 ? '↑' : readerChange < 0 ? '↓' : '→'}${Math.abs(readerChange).toFixed(0)}%</div>
    </div>
    <div class="kpi">
      <div class="value">${(activeReaders[activeReaders.length - 1] || 0).toLocaleString()}</div>
      <div class="unit">在读人数（14天累计）</div>
    </div>
    <div class="kpi${revChange > 0 ? ' trend-up' : revChange < 0 ? ' trend-dn' : ''}">
      <div class="value">¥${revenue[revenue.length - 1].toFixed(2)}</div>
      <div class="unit">昨日收益 ${revChange > 0 ? '↑' : revChange < 0 ? '↓' : '→'}${Math.abs(revChange).toFixed(0)}%</div>
    </div>
    <div class="kpi">
      <div class="value">¥${totalRevenue.toFixed(2)}</div>
      <div class="unit">累计收益</div>
    </div>
    <div class="kpi">
      <div class="value">${totalBookmarks.toLocaleString()}</div>
      <div class="unit">累计加书架（未扣除移除）</div>
    </div>
    <div class="kpi">
      <div class="value">¥${perKWords.toFixed(4)}</div>
      <div class="unit">每千字收益</div>
    </div>
  </div>
</div>

<!-- Milestone Completion Rates -->
	${(() => {
    const quality = latest.quality || {};
    const mcs = quality.milestoneChapters || {};
    const ms = quality.milestones || {};
    const entries = [];
    const labels = { 10000: "1万字", 30000: "3万字", 50000: "5万字", 100000: "10万字", 200000: "20万字", 300000: "30万字" };
    for (const [k, v] of Object.entries(mcs)) {
      const w = parseInt(k);
      const label = labels[w] || `${Math.round(w/10000)}万字`;
      const rate = v.completionRate != null ? `${v.completionRate.toFixed(1)}%` : "-";
      const platMs = ms["100k"] && w === 100000 ? ` (平台: ${ms["100k"].toFixed(1)}%)` : "";
      entries.push(`<tr><td>${label}</td><td>第${v.chapter}章</td><td>${rate}${platMs}</td></tr>`);
    }
    if (entries.length === 0) return "";
    return `<div class="card">
      <h2>完读率里程碑</h2>
      <table class="pred-table">
        <tr><th>累计字数</th><th>到达章节</th><th>读完率</th></tr>
        ${entries.join("")}
      </table>
      <div style="margin-top:8px;font-size:13px;color:#999;text-align:center">累计 ${(quality.cumulativeWords || 0).toLocaleString()} 字</div>
    </div>`;
  })()}

	<!-- Daily Word Count -->
	${(() => {
    const dw = (latest.quality || {}).dailyWords || {};
    const days = Object.entries(dw).sort((a, b) => a[0].localeCompare(b[0]));
    if (days.length === 0) return "";
    const maxW = Math.max(...days.map(d => d[1]), 1);
    return `<div class="card">
      <h2>每日更新字数</h2>
      <div class="bar-readers">
        ${days.map(([day, words]) => `
        <div class="bar-row">
          <span class="date">${day.slice(5)}</span>
          <span class="val">${words.toLocaleString()}字</span>
          <div class="bar" style="width:${Math.round(words/maxW*100)}%;background:linear-gradient(90deg,#43e97b,#38f9d7)"></div>
        </div>`).join("")}
      </div>
    </div>`;
  })()}

<!-- Reader Trend -->
<div class="card">
  <h2>阅读人数趋势</h2>
  <div class="bar-readers">
    ${readerBars.map(b => `
    <div class="bar-row">
      <span class="date">${b.date}</span>
      <span class="val">${b.value.toLocaleString()}人</span>
      <div class="bar" style="width:${b.pct}%"></div>
    </div>`).join("")}
  </div>
</div>

<!-- Revenue Trend -->
<div class="card">
  <h2>收益趋势</h2>
  <div class="bar-revenue">
    ${revBars.map(b => `
    <div class="bar-row">
      <span class="date">${b.date}</span>
      <span class="val">¥${b.value.toFixed(2)}</span>
      <div class="bar" style="width:${b.pct}%"></div>
    </div>`).join("")}
  </div>
</div>

<!-- Revenue Prediction -->
${pred7.length > 0 ? `
<div class="card">
  <h2>未来 7 天收益预测</h2>
  <table class="pred-table">
    <tr><th>天数</th><th>保守预估</th><th>预期收益</th><th>乐观预估</th></tr>
    ${pred7.map(p => `
    <tr>
      <td>第${p.day}天</td>
      <td>¥${p.conservative.toFixed(2)}</td>
      <td><strong>¥${p.expected.toFixed(2)}</strong></td>
      <td>¥${p.optimistic.toFixed(2)}</td>
    </tr>`).join("")}
  </table>
  <div style="margin-top:12px;text-align:center;color:#667eea;font-weight:700">
    7天预期总收益: ¥${next7Total.toFixed(2)} | 日均 ¥${(next7Total/7).toFixed(2)}
  </div>
</div>` : ""}

<!-- Anomalies & Suggestions -->
${anomalies.length > 0 ? `
<div class="card">
  <h2>异常预警 &amp; 优化建议</h2>
  ${anomalies.map(a => `<div class="alert ${a.type}">${htmlEscape(a.msg)}</div>`).join("")}
</div>` : ""}

<!-- Suggestions -->
<div class="card">
  <h2>优化建议</h2>
  ${readerChange > 50 ? '<div class="alert success">阅读量爆发增长，推荐位或自然流量起量，保持更新频率承接流量</div>' : readerChange > 10 ? '<div class="alert success">阅读量稳步增长，当前策略有效，继续坚持</div>' : ''}
  ${readerChange < 0 ? `<div class="alert info">阅读量小幅波动 (${readerChange.toFixed(0)}%)，短期正常，关注读完率确认内容质量</div>` : ''}
  ${bookmarks[bookmarks.length - 1] > readers[readers.length - 1] * 0.1
    ? '<div class="alert success">加书架转化率较好，内容吸引力强</div>'
    : '<div class="alert info">加书架率可提升：在章节首尾增加书架引导</div>'}
  ${avgChapWords > 0
    ? (avgChapWords < 2000
      ? '<div class="alert warning">章节字数偏低，建议提升至 3000-5000 字</div>'
      : '<div class="alert success">章节字数合理，保持节奏</div>')
	    : ''}
	  ${stageTips}
  <div class="alert info">日均阅读: ${avgReaders.toLocaleString()} 人 | 日均收益: ¥${avgRevenue.toFixed(2)} | 总字数: ${totalWords.toLocaleString()} | 均章: ${avgChapWords.toLocaleString()} 字</div>
</div>

<div class="footer">
  番茄数据分析工具 &copy; ${new Date().getFullYear()} · 数据来源: 番茄小说作家后台<br>
  报告仅供作者参考，不构成任何收益承诺
</div>

</div>
</body>
</html>`;

  const reportPath = path.join(DATA_DIR, `report-${reportDate}.html`);
  fs.writeFileSync(reportPath, html, "utf-8");
  console.log(`✅ HTML 报告已生成: ${reportPath}`);
  console.log(`   可直接用浏览器打开，截图用于展示`);
}

// ── Setup ──────────────────────────────────────────────────────────

async function doSetup() {
  console.log("🔧 番茄数据分析工具 - 首次配置\n");
  console.log("========================================\n");

  // Auto-detect installed browsers
  const available = [];
  for (const [key, info] of Object.entries(BROWSER_REGISTRY)) {
    if (findBrowserExe(key, null)) {
      available.push({ key, name: info.name });
    }
  }
  // Default to first available, fallback to edge (even if not found — user may install later)
  const defaultBrowser = available.length > 0 ? available[0].key : "edge";

  // Auto-detect playwright from common locations
  const playwrightCandidates = [];
  playwrightCandidates.push(path.join(__dirname, "node_modules", "playwright"));
  if (process.env.APPDATA) {
    playwrightCandidates.push(path.join(process.env.APPDATA, "npm", "node_modules", "playwright"));
    playwrightCandidates.push(path.join(process.env.APPDATA, "npm", "node_modules", "@playwright", "mcp", "node_modules", "playwright"));
  }
  if (process.env.NPM_CONFIG_PREFIX) {
    playwrightCandidates.push(path.join(process.env.NPM_CONFIG_PREFIX, "node_modules", "playwright"));
  }
  let playwrightPath = "playwright";
  for (const c of playwrightCandidates) {
    if (fs.existsSync(path.join(c, "index.js")) || fs.existsSync(path.join(c, "index.mjs"))) {
      playwrightPath = c;
      break;
    }
  }

  if (fs.existsSync(CONFIG_PATH)) {
    console.warn("⚠️  config.json 已存在");
    const existing = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    if (!existing.browser) {
      existing.browser = defaultBrowser;
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(existing, null, 2), "utf-8");
      console.log(`   已自动添加 browser 字段: "${defaultBrowser}" (${BROWSER_REGISTRY[defaultBrowser]?.name})`);
    }
    console.log("\n下一步: node fanqie-analytics.js collect");
    return;
  }

  // Interactive browser selection
  const readline = require("readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  function ask(question) {
    return new Promise(resolve => rl.question(question, resolve));
  }

  console.log("检测到以下已安装的浏览器:");
  for (let i = 0; i < available.length; i++) {
    const marker = available[i].key === defaultBrowser ? " ★ 默认" : "";
    console.log(`  ${i + 1}. ${available[i].name}${marker}`);
  }
  console.log(`  ${available.length + 1}. 自定义路径`);
  console.log("");

  let browser = defaultBrowser;
  let browserPath = "";

  const answer = await ask(`选择浏览器 [1-${available.length + 1}] (回车=默认): `);
  const idx = parseInt(answer) - 1;

  if (idx >= 0 && idx < available.length) {
    browser = available[idx].key;
  } else if (idx === available.length) {
    browserPath = await ask("请输入浏览器 exe 完整路径: ");
    browser = "edge"; // fallback registry entry for process name, etc.
  }

  const config = {
    browser,
    browserPath,
    edgeProfile: "",
    headless: false,
    playwrightPath,
    books: [],
  };

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
  console.log(`\n✅ 已创建 config.json (浏览器: ${BROWSER_REGISTRY[browser]?.name || browserPath})`);

  console.log("\n下一步:");
  console.log("  1. 运行: node fanqie-analytics.js collect");
  console.log("  2. 首次运行自动打开浏览器窗口，登录 fanqienovel.com（仅需一次）");
  console.log("  3. 采集完成后浏览器保持运行，下次 collect 秒级重连免登");
  console.log("  4. 即使重启电脑，浏览器的 User Data 目录也会保留登录态");

  rl.close();
}

// ── CLI ─────────────────────────────────────────────────────────────

const command = process.argv[2] || "collect";

function parseArg(name) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 && idx + 1 < process.argv.length ? process.argv[idx + 1] : null;
}

const opts = {
  headless: process.argv.includes("--headless"),
  book: parseArg("--book"),
  allBooks: process.argv.includes("--all"),
  force: process.argv.includes("--force"),
};

(async () => {
  switch (command) {
    case "setup":
      await doSetup();
      break;
    case "collect":
      await doCollect(opts);
      break;
    case "report":
      doReport();
      break;
    case "predict":
      doPredict();
      break;
    case "chapters":
      doChapters();
      break;
    case "metrics":
      doMetrics();
      break;
    case "weekly":
      doWeekly();
      break;
    case "monthly":
      doMonthly();
      break;
    case "html":
      doHtml();
      break;
    default:
      console.log("用法: node fanqie-analytics.js <命令> [--headless]");
      console.log("");
      console.log("数据采集:");
      console.log("  collect    采集今日全部数据（自动打开浏览器）");
      console.log("              --book <名称>  指定书名（逗号分隔多本）");
      console.log("              --all          采集全部作品");
      console.log("              --force        强制重新采集（跳过今日已采集检查）");
      console.log("              --headless     无头模式");
      console.log("  setup      首次配置引导");
      console.log("");
      console.log("数据分析:");
      console.log("  report     数据趋势报告（含洞察建议）");
      console.log("  predict    收益预测（7-30天）");
      console.log("  chapters   章节分析（异常预警、追读趋势）");
      console.log("  metrics    作者核心指标（千字收益、全勤达标、目标预测）");
      console.log("");
      console.log("报告生成:");
      console.log("  weekly     一键生成周报");
      console.log("  monthly    一键生成月报");
      console.log("  html       导出 HTML 可视化报告（可截图展示）");
      console.log("");
      console.log("选项:");
      console.log("  --headless   浏览器后台运行（不显示窗口）");
      console.log("  --book <名>  指定作品（采集/报告均可使用，支持模糊匹配）");
      console.log("  --all        采集全部作品（仅 collect）");
      process.exit(1);
  }
})().catch(err => {
  console.error("❌ 未捕获异常:", err.message || err);
  process.exit(1);
});
