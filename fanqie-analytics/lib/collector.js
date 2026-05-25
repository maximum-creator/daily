// Headless data collector for 番茄小说 writer backend.
// Ported from fanqie-analytics.js — uses pure Playwright API (no CDP dependency).

const fs = require("fs");
const path = require("path");

// ── Exported helper: reuse from elsewhere ─────────────────────────
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ═══════════════════════════════════════════════════════════════════
// DOM Click Helpers (pure Playwright, headless-safe)
// ═══════════════════════════════════════════════════════════════════

async function jsClick(page, text, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await page.waitForTimeout(1500);
    const result = await page.evaluate((t) => {
      const allNodes = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
      let node;
      while (node = walker.nextNode()) {
        if (node.textContent?.trim() === t && node.children.length === 0) {
          allNodes.push(node);
        }
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

// ═══════════════════════════════════════════════════════════════════
// Drawer Helpers
// ═══════════════════════════════════════════════════════════════════

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
  } catch { /* may already be open */ }
  await page.waitForTimeout(400);
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

// ═══════════════════════════════════════════════════════════════════
// Book Switching
// ═══════════════════════════════════════════════════════════════════

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
      await page.waitForTimeout(2500);
      if ((await checkBook()) === targetName) return true;
    }

    const drawerAlreadyOpen = await isDrawerOpen(page);

    if (!drawerAlreadyOpen) {
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
        const text = nameEl?.textContent?.trim() || "";
        if (text === name) { nameEl.dispatchEvent(new MouseEvent("click", { bubbles: true })); return "exact:" + text; }
      }
      for (const item of items) {
        const nameEl = item.querySelector(".book-drawer-book-name");
        const text = nameEl?.textContent?.trim() || "";
        if (text.includes(name) || name.includes(text)) { nameEl.dispatchEvent(new MouseEvent("click", { bubbles: true })); return "fuzzy:" + text; }
      }
      return "not_found";
    }, targetName);

    if (clicked === "not_found") continue;

    // Wait for drawer to close
    const closeStart = Date.now();
    while (Date.now() - closeStart < 8000) {
      if (!(await isDrawerOpen(page))) break;
      await page.waitForTimeout(300);
    }

    // Wait for sidebar to update
    const startWait = Date.now();
    while (Date.now() - startWait < 10000) {
      const current = await checkBook();
      if (current === targetName || current.includes(targetName) || targetName.includes(current)) {
        await page.waitForTimeout(2000); // let charts render
        return true;
      }
      await page.waitForTimeout(500);
    }
  }
  return false;
}

async function switchBookOnProfitPage(page, targetName) {
  const checkBook = () => page.evaluate(() => {
    const el = document.querySelector(".book-select-info-title");
    return el?.textContent?.trim() || "";
  });

  // Close any existing modal
  const modalOpen = await page.evaluate(() => {
    const w = document.querySelector(".byte-modal-wrapper");
    return w ? w.getBoundingClientRect().width > 0 : false;
  });
  if (modalOpen) {
    await page.evaluate(() => {
      const btns = document.querySelectorAll(".byte-modal-footer button");
      for (const btn of btns) if (btn.textContent?.trim().includes("取消")) btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await page.waitForTimeout(1000);
  }

  if ((await checkBook()) === targetName) return true;

  // Open book selector modal
  await page.evaluate(() => {
    const btn = document.querySelector("button.book-select-switch");
    if (btn) btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await page.waitForTimeout(2000);

  const clicked = await page.evaluate((name) => {
    const items = document.querySelectorAll(".book-item");
    for (const item of items) {
      const nameEl = item.querySelector(".book-item-details-name");
      const text = nameEl?.textContent?.trim() || "";
      if (text === name) { item.dispatchEvent(new MouseEvent("click", { bubbles: true })); return "exact:" + text; }
    }
    for (const item of items) {
      const nameEl = item.querySelector(".book-item-details-name");
      const text = nameEl?.textContent?.trim() || "";
      if (text.includes(name) || name.includes(text)) { item.dispatchEvent(new MouseEvent("click", { bubbles: true })); return "fuzzy:" + text; }
    }
    return "not_found";
  }, targetName);

  if (clicked === "not_found") {
    await page.evaluate(() => {
      const btns = document.querySelectorAll(".byte-modal-footer button");
      for (const btn of btns) if (btn.textContent?.trim().includes("取消")) btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    return false;
  }

  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const btns = document.querySelectorAll(".byte-modal-footer button");
    for (const btn of btns) if (btn.textContent?.trim().includes("确定")) { btn.dispatchEvent(new MouseEvent("click", { bubbles: true })); return; }
  });

  await page.waitForTimeout(5000);
  const final = await checkBook();
  return final === targetName || final.includes(targetName) || targetName.includes(final);
}

// ═══════════════════════════════════════════════════════════════════
// Data Collectors
// ═══════════════════════════════════════════════════════════════════

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
          if (l.includes("连载中") || l.includes("已完结") || l.includes("已签约") || l.includes("审核中") || l.includes("验证中")) {
            status = l; break;
          }
        }
        break;
      }
    }
    novelNames.push({ name: currentBook, status });
  }

  // Fallback: text parsing
  if (novelNames.length === 0) {
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === "当前作品") {
        for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
          const candidate = lines[j].trim();
          if (candidate.length >= 4 && !candidate.includes("切换") && !candidate.includes("推荐") && !candidate.match(/^\d/)) {
            novelNames.push({ name: candidate, status: lines[j + 1]?.trim() || "" });
            break;
          }
        }
        break;
      }
    }
  }

  // Enumerate all books from drawer
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
        return Array.from(items).map(item => {
          const nameEl = item.querySelector(".book-drawer-book-name");
          const name = nameEl?.textContent?.trim() || "";
          const full = item.textContent?.trim() || "";
          const afterName = full.slice(full.indexOf(name) + name.length).trim();
          const status = afterName.match(/验证中|审核中|连载中|已签约|已完结|已下架/)?.[0] || "";
          const ranking = afterName.match(/第\d+名|未上榜|上榜/)?.[0] || "";
          return { name, selected: item.classList.contains("selected"), status, ranking };
        });
      });
      for (const b of drawerBooks) allBooks.push({ name: b.name, status: b.status, ranking: b.ranking });
      await closeDrawer(page);
    } catch (e) { /* fallback to text parse below */ }
  }

  const novels = allBooks.length > 0 ? allBooks : novelNames.filter((n, i, a) => a.findIndex(x => x.name === n.name) === i);
  return { novels };
}

async function collectWorksData(page) {
  const txt = await page.evaluate(() => document.body?.innerText || "");

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

  for (const key of ["阅读人数", "在读人数", "作品评分", "评论次数", "加书架人数", "催更人数", "追更人数"]) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

  // Phase 1: Parse captured API responses (exact field names from fanqie API)
  if (apiCalls.length > 0) {
    const chapterMap = new Map();

    for (const call of apiCalls) {
      try {
        const json = JSON.parse(call.body);
        const data = json.data || json.result || json;
        const chData = data.chapter_stats_list || data.chapters || data.chapter_list || data.list || data.records || data.items;
        if (!chData || !Array.isArray(chData) || chData.length === 0) continue;

        for (const ch of chData) {
          // API uses 0-indexed "indice" → chapter number = indice + 1
          const chNum = (ch.indice || ch.chapter || 0) + 1;
          const existing = chapterMap.get(chNum) || {};

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
      } catch (e) { /* skip malformed */ }
    }

    if (chapterMap.size > 0) {
      for (const [, ch] of chapterMap) {
        chapterList.push({
          chapter: ch.chapter, title: ch.title,
          comments: ch.comments, paragraphComments: ch.paragraphComments,
          urges: ch.urges, wordCount: ch.wordCount, publishTime: ch.publishTime,
          completionRate: ch.completionRate, followReadRate: ch.followReadRate, lossRate: ch.lossRate,
        });
        if (ch.completionRate != null) {
          chapters.push({
            chapter: ch.chapter, title: ch.title,
            completionRate: ch.completionRate,
            followReadRate: ch.followReadRate,
            lossRate: ch.lossRate,
          });
        }
      }
    }

    // Extended pagination: if total_count > fetched, re-fetch ALL chapters
    if (chapterList.length > 0) {
      for (const call of apiCalls) {
        try {
          const url = new URL(call.url);
          let totalCount = 0;
          try { totalCount = JSON.parse(call.body).data?.total_count || 0; } catch (e) { /* skip */ }
          if (totalCount > chapterList.length) {
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
        } catch (e) { /* best-effort expansion */ }
      }
    }
  }

  // Phase 2: Fallback text parsing from page body
  const txt = await page.evaluate(() => document.body?.innerText || "");

  // Parse completion rates from text: "第N章 标题 读完率 XX%"
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

  // Parse chapter table from text (only if API didn't provide chapterList)
  if (chapterList.length === 0) {
    const lines = txt.split("\n");
    let headerIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes("章节名")) { headerIdx = i; break; }
    }
    if (headerIdx >= 0) {
      let colCount = 0;
      for (let j = headerIdx; j < Math.min(headerIdx + 30, lines.length); j++) {
        const t = lines[j].trim();
        if (t && !t.match(/^\d+$/) && !t.startsWith("第")) colCount++;
        if (t && (t.startsWith("第") || t.match(/^\d{4}-\d{2}-\d{2}/))) break;
      }
      colCount = Math.max(colCount, 5);
      const stride = colCount * 2;
      let i = headerIdx + 1;
      while (i < lines.length) {
        const l = lines[i].trim();
        if (l.startsWith("第") && l.includes("章")) {
          const nearbyLines = lines.slice(i + 1, i + stride);
          const numericCount = nearbyLines.filter(s => {
            const n = parseFloat(s.trim().replace(/,/g, ""));
            return !isNaN(n) && s.trim().length > 0;
          }).length;
          if (numericCount >= 3) {
            const chNum = parseInt(l.match(/第(\d+)章/)?.[1] || "0");
            const vals = [];
            for (let k = 1; k < stride; k++) {
              const raw = (lines[i + k] || "").trim();
              if (raw && raw !== "-" && raw !== "--") {
                const n = parseFloat(raw.replace(/,/g, ""));
                if (!isNaN(n)) vals.push(n);
                else if (raw.match(/^\d{4}-\d{2}-\d{2}/)) vals.push(raw);
              }
            }
            chapterList.push({
              chapter: chNum, title: l,
              comments: vals[0] || 0,
              paragraphComments: vals[1] || 0,
              urges: vals[2] || 0,
              wordCount: typeof vals[3] === "number" ? vals[3] : 0,
              publishTime: typeof vals[vals.length - 1] === "string" ? vals[vals.length - 1] : "",
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
  }

  // Parse milestone completion rates from page text
  const milestonePatterns = [
    { key: "10万字", pattern: /十万字完读率\s*[:：]?\s*([\d.]+)%/ },
    { key: "10万字", pattern: /10万字完读率\s*[:：]?\s*([\d.]+)%/ },
    { key: "30万字", pattern: /三十万字完读率\s*[:：]?\s*([\d.]+)%/ },
    { key: "30万字", pattern: /30万字完读率\s*[:：]?\s*([\d.]+)%/ },
    { key: "50万字", pattern: /五十万字完读率\s*[:：]?\s*([\d.]+)%/ },
  ];
  for (const { key, pattern } of milestonePatterns) {
    const m = txt.match(pattern);
    if (m && !milestones[key]) milestones[key] = parseFloat(m[1]);
  }

  // Compute cumulative words and milestone chapters
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

  // Daily word count by publish date
  dailyWords = {};
  for (const ch of chapterList) {
    if (ch.publishTime) {
      const day = ch.publishTime.slice(0, 10);
      dailyWords[day] = (dailyWords[day] || 0) + (ch.wordCount || 0);
    }
  }

  return { chapters, chapterList, milestones, milestoneChapters, cumulativeWords, dailyWords };
}

async function collectRevenue(page) {
  const txt = await page.evaluate(() => document.body?.innerText || "");

  const yesterdayMatch = txt.match(/昨日番茄收益\s+([\d.]+)/);
  const totalMatch = txt.match(/累计番茄收益\s+([\d.]+)/);

  const overview = {
    yesterdayRevenue: yesterdayMatch ? parseFloat(yesterdayMatch[1]) : 0,
    totalRevenue: totalMatch ? parseFloat(totalMatch[1]) : 0,
  };

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

async function collectTrafficFromPage(page) {
  try {
    const legendNames = await page.evaluate(() => {
      const items = document.querySelectorAll(".control-legend-item-name");
      return Array.from(items).map(el => el.textContent.trim());
    });
    if (legendNames.length > 0) return { legendNames, isEmpty: false };
  } catch (e) { /* best-effort */ }
  return null;
}

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
          const label = legendNames && ri < legendNames.length ? legendNames[ri] : `指标${types[ri]}`;
          const nums = row.map(v => parseInt(v) || 0);
          const latest = nums.reduce((last, v) => v > 0 ? v : last, 0);
          if (latest > 0) sources[label] = latest;
        }
        continue;
      }

      // Fallback: generic object parsing
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
      }
    } catch (e) { /* skip */ }
  }

  return { sources, isEmpty: Object.keys(sources).length === 0 };
}

// ═══════════════════════════════════════════════════════════════════
// Main Collection Orchestrator
// ═══════════════════════════════════════════════════════════════════

async function collectForBook(page, bookName, bookStatus = "") {
  const date = today();
  const results = { worksData: null, quality: null, traffic: null, revenue: null };

  // 1. Works data
  try { results.worksData = await collectWorksData(page); } catch (e) { /* continue */ }

  // 2. Quality — intercept API responses
  try {
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
        } catch (e) { /* skip */ }
      }
    };
    page.on("response", onResponse);
    try {
      await jsClick(page, "质量分析");
      await page.waitForTimeout(3000);
    } finally {
      page.removeListener("response", onResponse);
    }

    // Fetch additional stats_types for complete chart data
    if (qualityApiCalls.length > 0) {
      let bookId = null;
      try { bookId = new URL(qualityApiCalls[0].url).searchParams.get("book_id"); } catch (e) { /* skip */ }

      if (bookId) {
        const firstUrl = new URL(qualityApiCalls[0].url);
        for (const st of ["3", "4"]) {
          try {
            const u = new URL(firstUrl.origin + firstUrl.pathname);
            for (const [k, v] of firstUrl.searchParams) u.searchParams.set(k, k === "stats_type" ? st : v);
            if (!u.searchParams.has("stats_type")) u.searchParams.set("stats_type", st);
            u.searchParams.set("page_count", "500");
            u.searchParams.set("count", "500");
            const body = await page.evaluate(async (apiUrl) => {
              const res = await fetch(apiUrl, { credentials: "include" });
              return await res.text();
            }, u.toString());
            qualityApiCalls.push({ url: u.toString(), body, status: 200 });
          } catch (e) { /* skip */ }
        }
      }
    }

    results.quality = await collectQuality(page, qualityApiCalls);
  } catch (e) { /* continue */ }

  // 3. Traffic — intercept API calls
  try {
    const trafficApiCalls = [];
    const onTrafficResponse = async (response) => {
      const url = response.url();
      if (url.includes("fanqienovel.com")) {
        try {
          const ct = response.headers()["content-type"] || "";
          if (ct.includes("json")) {
            const body = await response.text();
            trafficApiCalls.push({ url, body, status: response.status() });
          }
        } catch (e) { /* skip */ }
      }
    };
    page.on("response", onTrafficResponse);
    try {
      await jsClick(page, "流量构成");
      await page.waitForTimeout(3000);
    } finally {
      page.removeListener("response", onTrafficResponse);
    }

    let legendNames = null;
    const fromPage = await collectTrafficFromPage(page);
    if (fromPage && fromPage.legendNames) legendNames = fromPage.legendNames;

    if (trafficApiCalls.length > 0) {
      results.traffic = collectTrafficFromApi(trafficApiCalls, legendNames);
    } else {
      results.traffic = { sources: {}, isEmpty: true };
    }
  } catch (e) { /* continue */ }

  // 4. Revenue
  let revenue30 = null;
  try {
    await jsClick(page, "小说收益");
    await page.waitForTimeout(2500);
    const profitSwitched = await switchBookOnProfitPage(page, bookName);
    if (profitSwitched) {
      await jsClick(page, "每日收益");
      await page.waitForTimeout(1000);
      results.revenue = await collectRevenue(page);
      if (await jsClick(page, "30天")) {
        await page.waitForTimeout(2000);
        revenue30 = await collectRevenue(page);
      }
    }
  } catch (e) { /* continue */ }

  const revenue = (revenue30?.dailyRevenue?.length > (results.revenue?.dailyRevenue?.length || 0))
    ? revenue30 : (results.revenue || { overview: { yesterdayRevenue: 0, totalRevenue: 0 }, dailyRevenue: [] });

  return {
    date,
    book: bookName,
    status: bookStatus,
    collectedAt: new Date().toISOString(),
    worksData: results.worksData || {},
    quality: {
      book: bookName,
      chapters: results.quality?.chapters || [],
      chapterList: results.quality?.chapterList || [],
      chaptersWithCompletionRate: results.quality?.chapters?.length || 0,
      totalChapters: results.quality?.chapterList?.length || 0,
      avgWordCount: results.quality?.chapterList?.length > 0
        ? Math.round(results.quality.chapterList.reduce((s, c) => s + c.wordCount, 0) / results.quality.chapterList.length)
        : 0,
      cumulativeWords: results.quality?.cumulativeWords || 0,
      milestones: results.quality?.milestones || {},
      milestoneChapters: results.quality?.milestoneChapters || {},
      dailyWords: results.quality?.dailyWords || {},
    },
    traffic: results.traffic || { sources: {} },
    revenue,
  };
}

// ═══════════════════════════════════════════════════════════════════
// Save Helpers
// ═══════════════════════════════════════════════════════════════════

function saveCollection(dataDir, tenantId, summary) {
  const tenantDir = path.join(dataDir, tenantId);
  const dateDir = path.join(tenantDir, summary.date);
  const bookSafeName = summary.book.replace(/[<>:"/\\|?*]/g, "_").trim();
  const bookDir = path.join(dateDir, bookSafeName);

  if (!fs.existsSync(bookDir)) fs.mkdirSync(bookDir, { recursive: true });

  // Save individual JSONs
  if (summary.worksData && Object.keys(summary.worksData).length > 0) {
    fs.writeFileSync(path.join(bookDir, "works-data.json"), JSON.stringify(summary.worksData, null, 2));
  }
  if (summary.quality) {
    fs.writeFileSync(path.join(bookDir, "quality.json"), JSON.stringify(summary.quality, null, 2));
  }
  if (summary.traffic && !summary.traffic.isEmpty) {
    fs.writeFileSync(path.join(bookDir, "traffic.json"), JSON.stringify(summary.traffic, null, 2));
  }
  if (summary.revenue) {
    fs.writeFileSync(path.join(bookDir, "revenue.json"), JSON.stringify(summary.revenue, null, 2));
  }
  fs.writeFileSync(path.join(bookDir, "summary.json"), JSON.stringify(summary, null, 2));

  // Append to daily log
  const logPath = path.join(tenantDir, "daily-log.json");
  let log = [];
  if (fs.existsSync(logPath)) {
    try { log = JSON.parse(fs.readFileSync(logPath, "utf-8")); } catch (e) { /* reset */ }
  }
  const existingIdx = log.findIndex(d => d.date === summary.date && d.book === summary.book);
  if (existingIdx >= 0) {
    log[existingIdx] = summary;
  } else {
    log.push(summary);
  }
  log.sort((a, b) => a.date.localeCompare(b.date));
  fs.writeFileSync(logPath, JSON.stringify(log, null, 2));

  return { bookDir, logPath };
}

module.exports = {
  today,
  // DOM helpers
  jsClick,
  // Book switching
  switchToBook,
  switchBookOnProfitPage,
  // Drawer
  isDrawerOpen, waitForDrawerOpen, closeDrawer,
  // Collectors
  collectDashboard,
  collectWorksData,
  collectQuality,
  collectRevenue,
  collectTrafficFromPage,
  collectTrafficFromApi,
  // Orchestrator
  collectForBook,
  // Persistence
  saveCollection,
};
