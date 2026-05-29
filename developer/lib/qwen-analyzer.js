// Qwen AI 竞品分析层
// 调用 Qwen API 对采集数据进行深度解读：策略建议、异常分析、竞品动向
// 配置: config/qwen.json 或环境变量 QWEN_API_KEY

const https = require("https");
const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.join(__dirname, "..", "config", "qwen.json");

function loadConfig() {
  if (fs.existsSync(CONFIG_PATH)) {
    try { return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")); } catch (e) { /* fall through */ }
  }
  return {
    apiKey: process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY || "",
    model: process.env.QWEN_MODEL || "qwen-plus",
    endpoint: process.env.QWEN_ENDPOINT || "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
  };
}

function isConfigured() {
  const cfg = loadConfig();
  return !!cfg.apiKey;
}

// ── API 调用 ─────────────────────────────────────────────────────

async function qwenChat(messages, opts = {}) {
  const cfg = loadConfig();
  if (!cfg.apiKey) throw new Error("Qwen API 未配置：设置 QWEN_API_KEY 环境变量或 config/qwen.json");

  const model = opts.model || cfg.model;
  const body = JSON.stringify({
    model,
    messages,
    temperature: opts.temperature ?? 0.7,
    max_tokens: opts.maxTokens || 2000,
    top_p: 0.9,
  });

  return new Promise((resolve, reject) => {
    const url = new URL(cfg.endpoint);
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${cfg.apiKey}`,
        "Content-Length": Buffer.byteLength(body),
      },
      timeout: 60000,
    }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (json.error) {
            reject(new Error(`Qwen API ${json.error.code}: ${json.error.message}`));
          } else {
            resolve(json.choices?.[0]?.message?.content || "");
          }
        } catch (e) {
          reject(new Error(`Qwen API 响应解析失败: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Qwen API 超时")); });
    req.write(body);
    req.end();
  });
}

// ── 竞品策略分析 ────────────────────────────────────────────────

async function competitiveStrategyAnalysis(brand, snapshots, instantAnalysis, skuMatrix) {
  if (!isConfigured()) return null;

  const platformData = [];
  for (const [platform, snap] of Object.entries(snapshots)) {
    if (!snap || !snap.productCount) continue;
    platformData.push({
      platform,
      productCount: snap.productCount,
      priceRange: snap.priceRange,
      topProducts: (snap.products || []).slice(0, 5).map(p => ({
        name: p.name?.slice(0, 60),
        price: p.price,
        sales: p.salesDisplay || "",
      })),
    });
  }

  const skuSummary = skuMatrix ? {
    totalMatches: skuMatrix.totalMatches,
    multiPlatform: skuMatrix.multiPlatformMatches,
    topSpreads: (skuMatrix.topDeals || []).slice(0, 5),
  } : null;

  const prompt = `你是电商竞品分析专家。请基于以下数据对品牌"${brand}"进行竞品策略分析。

## 各平台数据
${JSON.stringify(platformData, null, 2)}

## 即时分析结果
${JSON.stringify(instantAnalysis?.sections?.map(s => s.body) || [], null, 2)}

## 跨平台SKU匹配
${JSON.stringify(skuSummary, null, 2)}

请生成一个简洁的竞品策略报告（300字以内），包含：
1. 渠道策略评估：该品牌在各平台的定价策略和渠道管控情况
2. 竞争威胁：主要风险点
3. 策略建议：2-3条具体可操作的建议

请用中文回答，每段以"## "开头。`;

  try {
    const result = await qwenChat([
      { role: "system", content: "你是专业的电商竞品分析顾问，回复简洁、具体、有数据支撑。使用中文。" },
      { role: "user", content: prompt },
    ], { maxTokens: 800, temperature: 0.5 });

    return {
      model: loadConfig().model,
      generatedAt: new Date().toISOString(),
      analysis: result,
    };
  } catch (e) {
    console.error(`[qwen] 策略分析失败: ${e.message}`);
    return { error: e.message };
  }
}

// ── 异常信号解读 ────────────────────────────────────────────────

async function anomalyInterpretation(brand, signals) {
  if (!isConfigured()) return null;
  if (!signals || signals.length === 0) return null;

  const highSignals = signals.filter(s => s.severity === "high");
  const mediumSignals = signals.filter(s => s.severity === "medium");

  if (highSignals.length === 0 && mediumSignals.length === 0) return null;

  const signalSummary = [
    ...highSignals.map(s => `[高优先级] ${s.title}: ${s.detail}`),
    ...mediumSignals.slice(0, 5).map(s => `[中优先级] ${s.title}: ${s.detail}`),
  ].join("\n");

  const prompt = `品牌"${brand}"在今日竞品监测中发现以下异常信号：

${signalSummary}

请用中文简要解读这些信号（150字以内）：
1. 这些信号反映了什么趋势？
2. 是否需要立即关注？

请简洁回答，每段以"## "开头。`;

  try {
    const result = await qwenChat([
      { role: "system", content: "你是电商竞品监控分析师，擅长从数据信号中发现趋势和风险。使用中文。" },
      { role: "user", content: prompt },
    ], { maxTokens: 500, temperature: 0.3 });

    return {
      model: loadConfig().model,
      generatedAt: new Date().toISOString(),
      interpretation: result,
    };
  } catch (e) {
    console.error(`[qwen] 异常解读失败: ${e.message}`);
    return { error: e.message };
  }
}

// ── 日报摘要生成 ────────────────────────────────────────────────

async function dailyExecutiveSummary(brand, brief, signals, trends) {
  if (!isConfigured()) return null;

  const prompt = `为品牌"${brand}"生成今日竞品监测执行摘要。

## 今日概况
- 数据源: ${(brief.sources || []).join(", ")}
- 信号总数: ${brief.signalCount || 0}
- 高优信号: ${brief.highCount || 0}
- 健康评分: ${brief.healthScore || "N/A"}

## 关键信号
${(signals || []).slice(0, 8).map(s => `- ${s.title}: ${s.detail}`).join("\n")}

## 趋势
${JSON.stringify(trends || {}, null, 2)}

请生成一段面向品牌经理的执行摘要（100字以内），用中文。`;

  try {
    const result = await qwenChat([
      { role: "system", content: "你是品牌竞品监测助手，生成简洁的执行摘要。使用中文。" },
      { role: "user", content: prompt },
    ], { maxTokens: 300, temperature: 0.4 });

    return result.trim();
  } catch (e) {
    console.error(`[qwen] 日报摘要失败: ${e.message}`);
    return null;
  }
}

module.exports = {
  loadConfig,
  isConfigured,
  qwenChat,
  competitiveStrategyAnalysis,
  anomalyInterpretation,
  dailyExecutiveSummary,
};
