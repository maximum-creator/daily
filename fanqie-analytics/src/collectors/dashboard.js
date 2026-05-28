const { jsClick, isDrawerOpen, waitForDrawerOpen, closeDrawer } = require("./helpers");

async function collectDashboard(page) {
  const txt = await page.evaluate(() => document.body?.innerText || "");

  let currentBook = await page.evaluate(() => {
    const el = document.querySelector(".book-select-info-title");
    return el?.textContent?.trim() || "";
  });

  const lines = txt.split("\n");
  const novelNames = [];

  if (currentBook && currentBook.length >= 2) {
    let status = "";
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === currentBook) {
        for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
          const l = lines[j].trim();
          if (l.includes("连载中") || l.includes("已完结") || l.includes("已签约") || l.includes("审核中") || l.includes("验证中") || l.includes("推荐中")) {
            status = l; break;
          }
        }
        break;
      }
    }
    novelNames.push({ name: currentBook, status });
  }

  const allBooks = [];
  const switchBtn = await page.evaluate(() => !!document.querySelector("button.book-select-switch"));
  if (switchBtn) {
    try {
      await page.evaluate(() => {
        const btn = document.querySelector("button.book-select-switch");
        if (btn) btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await waitForDrawerOpen(page);
      const drawerBooks = await page.evaluate(() => {
        const items = document.querySelectorAll(".book-drawer-item");
        return Array.from(items).map((item) => {
          const nameEl = item.querySelector(".book-drawer-book-name");
          const name = nameEl?.textContent?.trim() || "";
          const full = item.textContent?.trim() || "";
          const afterName = full.slice(full.indexOf(name) + name.length).trim();
          // Capture ALL status keywords (global match), join with separator
          const statusMatches = afterName.match(/推荐中|验证中|审核中|连载中|已签约|已完结|已下架/g) || [];
          const status = [...new Set(statusMatches)].join(" · ");  // deduplicate, join
          const ranking = afterName.match(/第\d+名|未上榜|上榜/)?.[0] || "";
          return { name, selected: item.classList.contains("selected"), status, ranking };
        });
      });
      for (const b of drawerBooks) allBooks.push({ name: b.name, status: b.status, ranking: b.ranking });
      await closeDrawer(page);
    } catch (e) { /* fallback to text */ }
  }

  const novels = allBooks.length > 0 ? allBooks : (() => {
    const seen = new Set();
    return novelNames.filter((n) => {
      if (seen.has(n.name)) return false;
      seen.add(n.name);
      return true;
    });
  })();

  return { novels };
}

async function switchToBook(page, targetName, dataPageUrl) {
  const checkBook = () => page.evaluate(() => {
    const el = document.querySelector(".book-select-info-title");
    return el?.textContent?.trim() || "";
  });

  if ((await checkBook()) === targetName) {
    await page.waitForTimeout(500);
    if ((await checkBook()) === targetName) return true;
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0 && dataPageUrl) {
      await page.goto(dataPageUrl, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(800);
      if ((await checkBook()) === targetName) return true;
    }

    if (!(await isDrawerOpen(page))) {
      const btnFound = await page.evaluate(() => {
        const btn = document.querySelector("button.book-select-switch");
        if (!btn) return false;
        btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        return true;
      });
      if (!btnFound) continue;
    }

    await waitForDrawerOpen(page);

    const clicked = await page.evaluate((name) => {
      const items = document.querySelectorAll(".book-drawer-item");
      for (const item of items) {
        const nameEl = item.querySelector(".book-drawer-book-name");
        if (nameEl?.textContent?.trim() === name) {
          nameEl.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          return "exact:" + nameEl.textContent.trim();
        }
      }
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

    if (clicked === "not_found") continue;

    const closeStart = Date.now();
    while (Date.now() - closeStart < 3000) {
      if (!(await isDrawerOpen(page))) break;
      await page.waitForTimeout(200);
    }

    const startWait = Date.now();
    while (Date.now() - startWait < 5000) {
      const current = await checkBook();
      if (current === targetName || current.includes(targetName) || targetName.includes(current)) {
        await page.waitForTimeout(400);
        return true;
      }
      await page.waitForTimeout(300);
    }
  }
  return false;
}

async function switchBookOnProfitPage(page, targetName) {
  const checkBook = () => page.evaluate(() => {
    const el = document.querySelector(".book-select-info-title");
    return el?.textContent?.trim() || "";
  });

  const modalOpen = await page.evaluate(() => {
    const w = document.querySelector(".byte-modal-wrapper");
    return w ? w.getBoundingClientRect().width > 0 : false;
  });
  if (modalOpen) {
    await page.evaluate(() => {
      const btns = document.querySelectorAll(".byte-modal-footer button");
      for (const btn of btns) if (btn.textContent?.trim().includes("取消")) btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await page.waitForTimeout(500);
  }

  if ((await checkBook()) === targetName) return true;

  await page.evaluate(() => {
    const btn = document.querySelector("button.book-select-switch");
    if (btn) btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await page.waitForTimeout(500);

  const clicked = await page.evaluate((name) => {
    const items = document.querySelectorAll(".book-item");
    for (const item of items) {
      const nameEl = item.querySelector(".book-item-details-name");
      if (nameEl?.textContent?.trim() === name) { item.dispatchEvent(new MouseEvent("click", { bubbles: true })); return true; }
    }
    for (const item of items) {
      const nameEl = item.querySelector(".book-item-details-name");
      const text = nameEl?.textContent?.trim() || "";
      if (text.includes(name) || name.includes(text)) { item.dispatchEvent(new MouseEvent("click", { bubbles: true })); return true; }
    }
    return false;
  }, targetName);

  if (!clicked) {
    await page.evaluate(() => {
      const btns = document.querySelectorAll(".byte-modal-footer button");
      for (const btn of btns) if (btn.textContent?.trim().includes("取消")) btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    return false;
  }

  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const btns = document.querySelectorAll(".byte-modal-footer button");
    for (const btn of btns) if (btn.textContent?.trim().includes("确定")) btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await page.waitForTimeout(1000);
  const final = await checkBook();
  return final === targetName || final.includes(targetName) || targetName.includes(final);
}

module.exports = { collectDashboard, switchToBook, switchBookOnProfitPage };
