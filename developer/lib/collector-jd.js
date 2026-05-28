// 京东竞品采集器 — UNMAINTAINED
// 京东服务端 IP 级风控 (cfe.m.jd.com/risk_handler) 拦截所有搜索请求，
// 与 cookie/浏览器指纹/请求方式无关。保留模块以维持 API 兼容，所有采集函数直接返回空结果。
// 如需恢复：需要住宅代理池轮换 IP。

const fs = require("fs");
const path = require("path");
const { localISO, today, sanitize, parsePrice, parseReviews } = require("./utils");

// ── 搜索（直接返回空，京东不可用）────────────────────────────────

async function searchJdProducts(page, brandName, maxPages = 1) {
  console.log(`[jd] 京东已标记为不可用 (IP级风控)，跳过采集: ${brandName}`);
  return [];
}

// ── 页面状态检测 ─────────────────────────────────────────────────

async function detectJdPageState(page) {
  return page.evaluate(() => {
    const text = document.body?.innerText || "";
    const url = location.href || "";
    if (url.includes("passport.jd.com") || url.includes("plogin.m.jd.com"))
      return { blocked: true, reason: "login_wall", detail: "需要登录京东账号" };
    if (url.includes("risk_handler") || url.includes("京东验证"))
      return { blocked: true, reason: "rate_limit", detail: "京东IP级风控拦截" };
    if (text.includes("访问频繁") || text.includes("请稍后再试"))
      return { blocked: true, reason: "rate_limit", detail: "京东搜索限流" };
    return { blocked: false };
  });
}

// ── 采集品牌快照（直接返回空）────────────────────────────────────

async function collectBrandSnapshot(page, brandName, tenantId) {
  return {
    collectedAt: localISO(),
    brand: brandName,
    source: "jd",
    productCount: 0,
    products: [],
    selfOperatedCount: 0,
    thirdPartyCount: 0,
    priceRange: { min: 0, max: 0, avg: 0 },
    unavailable: true,
    reason: "京东IP级风控拦截，暂不可用",
  };
}

// ── 对比（始终返回空信号）─────────────────────────────────────────

function compareSnapshots(today, yesterday) {
  return { signals: [], isNew: !yesterday };
}

// ── Persistence ─────────────────────────────────────────────────

function saveSnapshot(dataDir, tenantId, brandName, snapshot) {
  const brandDir = path.join(dataDir, tenantId, sanitize(brandName));
  if (!fs.existsSync(brandDir)) fs.mkdirSync(brandDir, { recursive: true });
  const fp = path.join(brandDir, `snapshot-jd-${today()}.json`);
  fs.writeFileSync(fp, JSON.stringify(snapshot, null, 2));
  return fp;
}

function loadSnapshot(dataDir, tenantId, brandName, date) {
  const fp = path.join(dataDir, tenantId, sanitize(brandName), `snapshot-jd-${date}.json`);
  if (!fs.existsSync(fp)) return null;
  try { return JSON.parse(fs.readFileSync(fp, "utf-8")); } catch (e) { return null; }
}

module.exports = {
  searchJdProducts,
  collectBrandSnapshot,
  compareSnapshots,
  detectJdPageState,
  saveSnapshot,
  loadSnapshot,
  today,
  localISO,
};
