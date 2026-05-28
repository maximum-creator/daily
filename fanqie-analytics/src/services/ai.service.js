const { loadAppConfig } = require("../config");
const logger = require("../utils/logger");

async function generateAIAnalysis(analysisData, collectionData) {
  const config = loadAppConfig();
  const apiKey = config.qwenApiKey || process.env.AI_API_KEY;
  const endpoint = process.env.AI_ENDPOINT || "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";

  if (!apiKey) {
    return { available: false, message: "未配置 AI API Key" };
  }

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
      logger.error({ status: response.status }, "AI API 请求失败");
      return { available: false, message: `AI API 返回错误: ${response.status}` };
    }

    const json = await response.json();
    const text = json.choices?.[0]?.message?.content || "";
    const usage = json.usage || {};

    return {
      available: true,
      analysis: text,
      tokens: { input: usage.prompt_tokens || 0, output: usage.completion_tokens || 0 },
    };
  } catch (e) {
    logger.error({ err: e }, "AI 分析生成失败");
    return { available: false, message: `AI 调用失败: ${e.message}` };
  }
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

module.exports = { generateAIAnalysis };
