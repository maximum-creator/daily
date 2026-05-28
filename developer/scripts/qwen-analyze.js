// Qwen analysis helper — ask Qwen for suggestions on project improvements
const https = require("https");
const fs = require("fs");
const path = require("path");
const os = require("os");

const config = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude", "qwen-config.json"), "utf-8"));

const prompt = process.argv[2] || `你是一个资深全栈工程师和反爬专家。我在做一个多平台电商竞品采集系统（天猫+拼多多+抖音）。目前遇到3个核心问题，请逐个分析给出简洁实用的解决方案（每个2-3句话）：

**问题1: 登录态不持久**
- Playwright launchPersistentContext 保存浏览器 profile
- 登录后 cookies 导出到 JSON 文件
- 但每次采集时 getPage() 会删除 Default/ 目录（包含 SQLite cookie 数据库）
- 然后尝试从 JSON 注入 cookies，但 cookie 可能不完整
- 服务器重启后 pool 丢失，必须重新创建 context

**问题2: 采集时反复打开可见浏览器**
- getPage() 总是用 headless:false 模式
- 用户看到浏览器反复打开很困扰
- 实际上天猫登录后 cookies 就能正常采集

**问题3: 抖音采集质量极差**
- 搜索 mall.douyin.com 后页面 body 只有 463 字符
- 内容显示的是无关的"广州酒家"占位文本
- 真实的商品数据是 SPA 通过 JS 动态加载的
- window.__INITIAL_STATE__ / window.__NUXT__ 找不到数据
- DOM 选择器匹配不到商品卡片

请为每个问题给出简洁实用的解决方案，重点是可行性和最小改动量。`;

const body = JSON.stringify({
  model: "qwen-plus",
  messages: [{ role: "user", content: prompt }],
  max_tokens: 1500
});

const url = new URL(config.endpoint);
const req = https.request({
  hostname: url.hostname,
  path: url.pathname + url.search,
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${config.apiKey}`,
    "Content-Length": Buffer.byteLength(body)
  },
  timeout: 30000
}, (res) => {
  let d = "";
  res.on("data", c => d += c);
  res.on("end", () => {
    try {
      const j = JSON.parse(d);
      const content = j.choices?.[0]?.message?.content || d;
      console.log(content);
    } catch(e) { console.log(d); }
  });
});
req.on("error", e => console.error("Error:", e.message));
req.write(body);
req.end();
