// Shared DOM helpers for all collectors
const logger = require("../utils/logger");

async function jsClick(page, text, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await page.waitForTimeout(600);
    const result = await page.evaluate((t) => {
      const allNodes = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
      let node;
      while (node = walker.nextNode()) {
        if (node.textContent?.trim() === t && node.children.length === 0) allNodes.push(node);
      }
      if (allNodes.length === 0) return { success: false };
      for (const sel of ['[class*="nav-item"]', '[class*="tabs-header"]', '[class*="tab-title"]']) {
        for (const n of allNodes) {
          const parent = n.closest(sel);
          if (parent) {
            parent.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
            return { success: true };
          }
        }
      }
      allNodes[0].parentElement?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      return { success: true };
    }, text);
    if (result.success) return true;
  }
  return false;
}

async function isDrawerOpen(page) {
  return page.evaluate(() => {
    const wrapper = document.querySelector(".byte-drawer-wrapper");
    if (!wrapper) return false;
    return !wrapper.classList.contains("byte-drawer-wrapper-hide");
  });
}

async function waitForDrawerOpen(page) {
  try { await page.waitForSelector(".book-drawer-item", { timeout: 3000 }); } catch { /* ok */ }
  await page.waitForTimeout(300);
}

async function closeDrawer(page) {
  if (!(await isDrawerOpen(page))) return;
  await page.evaluate(() => {
    const mask = document.querySelector(".byte-drawer-mask");
    if (mask) mask.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  for (let i = 0; i < 10; i++) {
    if (!(await isDrawerOpen(page))) return;
    await page.waitForTimeout(500);
  }
}

function extractUpdateTime(pageText) {
  const patterns = [
    /数据更新(?:时间|时刻)[：:\s]+(\d{4}[-\/]\d{2}[-\/]\d{2}\s+\d{2}:\d{2}(?::\d{2})?)/,
    /更新(?:时间|时刻)[：:\s]+(\d{4}[-\/]\d{2}[-\/]\d{2}\s+\d{2}:\d{2}(?::\d{2})?)/,
    /统计截止[：:\s]+(\d{4}[-\/]\d{2}[-\/]\d{2}\s+\d{2}:\d{2}(?::\d{2})?)/,
    /(\d{4}[-\/]\d{2}[-\/]\d{2}\s+\d{2}:\d{2}(?::\d{2})?)\s*更新/,
  ];
  for (const p of patterns) {
    const m = pageText.match(p);
    if (m) return m[1];
  }
  return null;
}

module.exports = { jsClick, isDrawerOpen, waitForDrawerOpen, closeDrawer, extractUpdateTime };
