// 竞品情报 SaaS — 共享工具函数
// 消除跨 collector 的重复定义

function normalizeName(name) {
  return (name || "").replace(/\s+/g, "").replace(/[（(].*?[)）]/g, "").replace(/【.*?】/g, "").slice(0, 40);
}

function localISO() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function yesterdayStr() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function sanitize(name) {
  return (name || "").replace(/[<>:"/\\|?*]/g, "_").trim();
}

function parsePrice(priceStr) {
  const s = String(priceStr).replace(/[¥￥]/g, "").trim();
  const m = s.match(/([\d.]+)/);
  return m ? parseFloat(m[1]) : 0;
}

function parseSales(salesStr) {
  const s = String(salesStr);
  const wanMatch = s.match(/([\d.]+)\s*万/);
  if (wanMatch) return Math.round(parseFloat(wanMatch[1]) * 10000);
  const plusMatch = s.match(/([\d.]+)\s*\+/);
  if (plusMatch) return parseInt(plusMatch[1]);
  const m = s.match(/([\d,]+)/);
  if (m) return parseInt(m[1].replace(/,/g, ""));
  return 0;
}

function parseReviews(reviewsStr) {
  return parseSales(reviewsStr); // same parsing logic
}

// Classify store from shop name
function classifyStore(shopName) {
  const s = (shopName || "").trim();
  if (!s) return "unknown";
  if (/旗舰店|官方旗舰|official\s*store/i.test(s)) return "flagship";
  if (/专卖店|专营店|授权|authorized/i.test(s)) return "authorized";
  if (/自营|直营/i.test(s)) return "direct";
  return "thirdParty";
}

module.exports = {
  normalizeName,
  localISO,
  today,
  yesterdayStr,
  sanitize,
  parsePrice,
  parseSales,
  parseReviews,
  classifyStore,
};
