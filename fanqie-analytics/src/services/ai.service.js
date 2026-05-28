const { loadAppConfig } = require("../config");
const logger = require("../utils/logger");

// ── Cost control ──
const cache = new Map();        // key: `${tenantId}:${book}:${date}` → { analysis, tokens, cachedAt }
const cooldowns = new Map();    // key: tenantId → lastCallTimestamp
const CACHE_TTL = 6 * 60 * 60 * 1000;  // 6 hours
const COOLDOWN_MS = 5 * 60 * 1000;     // 5 minutes between calls
let totalCostEstimate = 0;             // running cost estimate (¥)

// Qwen-Plus pricing (¥ per 1K tokens)
const INPUT_PRICE = 0.0008;   // ¥0.0008/1K input
const OUTPUT_PRICE = 0.002;   // ¥0.002/1K output

function costEstimate(inputTokens, outputTokens) {
  return (inputTokens / 1000) * INPUT_PRICE + (outputTokens / 1000) * OUTPUT_PRICE;
}

function getCacheKey(tenantId, book, date) {
  return `${tenantId}:${book || "latest"}:${date || "any"}`;
}

async function generateAIAnalysis(analysisData, collectionData, opts = {}) {
  const { tenantId = "default", force = false } = opts;
  const config = loadAppConfig();
  const apiKey = config.qwenApiKey || process.env.AI_API_KEY;
  const endpoint = process.env.AI_ENDPOINT || "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";

  if (!apiKey) {
    return { available: false, message: "未配置 AI API Key" };
  }

  // ── Cache check ──
  const cacheKey = getCacheKey(tenantId, analysisData.book, collectionData?.date);
  const cached = cache.get(cacheKey);
  if (!force && cached && (Date.now() - cached.cachedAt) < CACHE_TTL) {
    return {
      available: true,
      analysis: cached.analysis,
      tokens: cached.tokens,
      cached: true,
      costEstimate: cached.cost,
      totalCost: Math.round(totalCostEstimate * 10000) / 10000,
    };
  }

  // ── Cooldown check ──
  if (!force) {
    const lastCall = cooldowns.get(tenantId);
    if (lastCall && (Date.now() - lastCall) < COOLDOWN_MS) {
      const waitSeconds = Math.ceil((COOLDOWN_MS - (Date.now() - lastCall)) / 1000);
      return {
        available: false,
        message: `AI 分析冷却中，请 ${waitSeconds} 秒后再试（每 5 分钟限 1 次，控制成本）`,
        cooldown: waitSeconds,
      };
    }
  }

  cooldowns.set(tenantId, Date.now());
  const prompt = buildPrompt(analysisData, collectionData);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "qwen-plus",
        messages: [
          { role: "system", content: "你是番茄小说平台的数据分析师。你给作者的反馈必须具体、可操作、有数据支撑。不要泛泛而谈。每次只指出最多3个最关键的问题。" },
          { role: "user", content: prompt },
        ],
        temperature: 0.7,
        max_tokens: 1500,
      }),
    });

    if (!response.ok) {
      cooldowns.delete(tenantId);
      logger.error({ status: response.status }, "AI API 请求失败");
      return { available: false, message: `AI API 返回错误: ${response.status}` };
    }

    const json = await response.json();
    const text = json.choices?.[0]?.message?.content || "";
    const usage = json.usage || {};
    const inputTokens = usage.prompt_tokens || 0;
    const outputTokens = usage.completion_tokens || 0;
    const cost = costEstimate(inputTokens, outputTokens);
    totalCostEstimate += cost;

    // Cache result
    cache.set(cacheKey, {
      analysis: text,
      tokens: { input: inputTokens, output: outputTokens },
      cachedAt: Date.now(),
      cost,
    });

    logger.info({ inputTokens, outputTokens, cost, totalCost: totalCostEstimate }, "AI 分析完成");

    return {
      available: true,
      analysis: text,
      tokens: { input: inputTokens, output: outputTokens },
      costEstimate: Math.round(cost * 10000) / 10000,
      totalCost: Math.round(totalCostEstimate * 10000) / 10000,
      cached: false,
    };
  } catch (e) {
    cooldowns.delete(tenantId);
    logger.error({ err: e }, "AI 分析生成失败");
    return { available: false, message: `AI 调用失败: ${e.message}` };
  }
}

// Admin: get cache stats
function getCacheStats() {
  return {
    cachedEntries: cache.size,
    totalCost: Math.round(totalCostEstimate * 10000) / 10000,
    cooldowns: cooldowns.size,
  };
}

function buildPrompt(data, collection) {
  const q = data.quality || {};
  const e = data.engagement || {};
  const t = data.traffic || {};
  const r = data.revenue || {};
  const fi = data.forceIndex || {};

  const anomalies = (data.anomalies || []).slice(0, 5);
  const biggestDrop = data.biggestDrop;
  const stage = data.stage || "unknown";
  const suggestions = (data.suggestions || []).slice(0, 3);

  return `以下是《${data.book || "未知"}》的数据分析结果：

## 基本信息
- 当前阶段: ${stage}
- 发布天数: ${data.daysSinceFirstPublish || "未知"}
- 算法综合评分: ${fi.score || "N/A"}/100

## 质量数据
- 平均读完率: ${q.avgCompletion || 0}%
- 前1/3读完率: ${q.earlyRate || 0}%
- 后1/3读完率: ${q.lateRate || 0}%
- 读完率衰减: ${q.decay || 0}%
- 平均追读率: ${q.avgFollow || 0}%
- 总章节数: ${q.totalChapters || 0}
- 累积字数: ${(q.cumulativeWords || 0).toLocaleString()}

## 流量与互动
- 总流量: ${t.total || 0}
- 搜索占比: ${t.searchRatio || 0}%
- 阅读人数: ${e.readers || 0}
- 追更人数: ${e.followers || 0}
- 加书架人数: ${e.bookmarks || 0}
- 评论数: ${e.comments || 0}
${biggestDrop ? `\n## 最大流失点\n- 第${biggestDrop.from.chapter}章→第${biggestDrop.to.chapter}章, 读完率暴跌 ${biggestDrop.drop}%` : ""}
${anomalies.length > 0 ? `\n## 异常章节\n${anomalies.map((a) => `- 第${a.chapter}章「${a.title || ""}」${a.type === "completion_drop" ? "读完率" : "跟读率"}异常 (z=${a.zScore})`).join("\n")}` : ""}

## 算法模拟
- 预测: ${fi.prediction || "N/A"}
${suggestions.length > 0 ? `\n## 规则引擎已检测的问题\n${suggestions.map((s) => `- [${s.priority}] ${s.title}`).join("\n")}` : ""}

请基于以上数据，从以下角度分析：
1. 核心问题诊断（不超过3个，按严重程度排序）
2. 每个问题的具体原因（引用数据）
3. 可操作的改进建议（具体到章级别）
4. 如果当前趋势持续，7天后的预期变化

用中文回答，语气专业但友好。直接给结论，不要铺垫。`;
}

module.exports = { generateAIAnalysis, getCacheStats };
