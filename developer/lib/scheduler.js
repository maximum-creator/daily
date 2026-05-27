// 每日定时调度器 — 自动采集所有监测品牌 + 生成日报
const fs = require("fs");
const path = require("path");

const CHECK_INTERVAL_MS = 60 * 1000; // 每分钟检查一次

let config = {
  hour: 8,
  minute: 0,
  timezone: "Asia/Shanghai",
};

let activeTimers = [];
let dataDir = null;
let collectionCallback = null;

// ── Persisted run tracker ──────────────────────────────────────

function trackerPath() {
  return path.join(dataDir || ".", ".usage", "scheduler-runs.json");
}

function loadTracker() {
  const fp = trackerPath();
  if (!fs.existsSync(fp)) return {};
  try { return JSON.parse(fs.readFileSync(fp, "utf-8")); } catch (e) { return {}; }
}

function saveTracker(tracker) {
  const dir = path.dirname(trackerPath());
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(trackerPath(), JSON.stringify(tracker, null, 2));
}

// ── Public API ──────────────────────────────────────────────────

function start(d, callback, opts = {}) {
  dataDir = d;
  collectionCallback = callback;
  if (opts.hour != null) config.hour = opts.hour;
  if (opts.minute != null) config.minute = opts.minute;

  const timer = setInterval(() => tick(), CHECK_INTERVAL_MS);
  activeTimers.push(timer);

  // Run shortly after start to catch up on any missed runs
  setTimeout(() => tick(), 10000);

  console.log(`[scheduler] 已启动 — 每日 ${String(config.hour).padStart(2, "0")}:${String(config.minute).padStart(2, "0")} 自动采集`);
  return timer;
}

function stop() {
  activeTimers.forEach(t => clearInterval(t));
  activeTimers = [];
}

function shouldRunNow() {
  const now = new Date();
  return now.getHours() === config.hour && now.getMinutes() === config.minute;
}

function markRun(tenantId, brandName) {
  const today = dateKey();
  const tracker = loadTracker();
  const key = `${tenantId}:${brandName}:${today}`;
  tracker[key] = { time: new Date().toISOString(), success: true };
  saveTracker(tracker);
}

function hasRunToday(tenantId, brandName) {
  const today = dateKey();
  const tracker = loadTracker();
  return !!tracker[`${tenantId}:${brandName}:${today}`];
}

function getStatus() {
  const today = dateKey();
  const tracker = loadTracker();
  const todayRuns = Object.keys(tracker).filter(k => k.endsWith(today)).length;
  return {
    config: { ...config },
    todayRuns,
    active: activeTimers.length > 0,
  };
}

// ── Internal ────────────────────────────────────────────────────

async function tick() {
  if (!shouldRunNow()) return;
  if (!collectionCallback) return;

  console.log(`[scheduler] 触发每日采集 — ${new Date().toLocaleString("zh-CN")}`);

  const tasks = discoverTasks();
  if (tasks.length === 0) {
    console.log("[scheduler] 无待采集品牌");
    return;
  }

  console.log(`[scheduler] 待采集: ${tasks.length} 个品牌`);
  for (const task of tasks) {
    if (hasRunToday(task.tenantId, task.brandName)) continue;
    try {
      console.log(`[scheduler] 采集中: ${task.tenantId}/${task.brandName}`);
      await collectionCallback(task.tenantId, task.brandName);
      markRun(task.tenantId, task.brandName);
    } catch (e) {
      console.error(`[scheduler] 采集失败: ${task.tenantId}/${task.brandName} — ${e.message}`);
    }
    // Delay between brands to avoid rate limiting
    await new Promise(r => setTimeout(r, 5000 + Math.random() * 5000));
  }
  console.log("[scheduler] 本轮采集完成");
}

function discoverTasks() {
  const tasks = [];
  if (!dataDir || !fs.existsSync(dataDir)) return tasks;

  const tenants = fs.readdirSync(dataDir).filter(f => {
    const fp = path.join(dataDir, f);
    return fs.statSync(fp).isDirectory() && !f.startsWith(".") && !f.startsWith("_");
  });

  for (const tenantId of tenants) {
    const tenantDir = path.join(dataDir, tenantId);
    const brands = fs.readdirSync(tenantDir).filter(f => {
      const fp = path.join(tenantDir, f);
      return fs.statSync(fp).isDirectory() && !f.startsWith(".");
    });
    for (const brand of brands) {
      tasks.push({ tenantId, brandName: brand });
    }
  }
  return tasks;
}

function dateKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

module.exports = { start, stop, shouldRunNow, markRun, hasRunToday, getStatus };
