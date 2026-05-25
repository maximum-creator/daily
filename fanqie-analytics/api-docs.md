# 番茄小说数据 API 文档

为 AI 写作平台提供作者在番茄小说的数据查询接口。

**Base URL:** `https://your-domain.com/api/v1`

---

## 认证

所有接口（除 health）需要在 HTTP 头中携带 API Key：

```
Authorization: Bearer <apiKey>
```

API Key 由服务提供方分配，每个客户一个独立 Key。未认证返回 401，无效 Key 返回 403。

---

## 接口概览

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 健康检查 |
| GET | `/summary` | 最新数据摘要 |
| GET | `/books` | 作品列表 |
| POST | `/collect` | 触发采集 |
| GET | `/report` | 趋势报告 |
| GET | `/predict` | 收益预测 |
| GET | `/chapters` | 章节分析 + 异常检测 |
| GET | `/traffic` | 流量来源 |
| GET | `/metrics` | 核心指标 |

---

## 详细接口

### 1. GET /health

健康检查，无需认证。

```bash
curl https://your-domain.com/api/v1/health
```

**响应:**
```json
{
  "code": 0,
  "message": "ok",
  "uptime": 86400.5,
  "memory": "54MB"
}
```

---

### 2. GET /summary

获取最新一次采集的数据摘要。

**参数:** `?book=<书名>` (可选，筛选指定作品)

```bash
curl -H "Authorization: Bearer fa_sk_xxx" \
  https://your-domain.com/api/v1/summary

# 指定作品
curl -H "Authorization: Bearer fa_sk_xxx" \
  "https://your-domain.com/api/v1/summary?book=示例作品"
```

**响应:**
```json
{
  "code": 0,
  "data": {
    "date": "2026-05-25",
    "book": "示例作品",
    "collectedAt": "2026-05-25T06:00:00.000Z",
    "revenue": {
      "yesterday": 12.5,
      "total": 358.2
    },
    "traffic": {
      "搜索": 108,
      "书架": 42,
      "书城": 15
    },
    "quality": {
      "chaptersWithData": 45,
      "totalChapters": 50,
      "avgWordCount": 3200,
      "cumulativeWords": 160000
    }
  }
}
```

**字段说明:**

| 字段 | 类型 | 说明 |
|------|------|------|
| revenue.yesterday | float | 昨日番茄收益 (元) |
| revenue.total | float | 累计番茄收益 (元) |
| traffic | object | 各来源阅读人数分布 |
| quality.chaptersWithData | int | 有指标数据的章节数 |
| quality.totalChapters | int | 总章节数 |
| quality.avgWordCount | int | 平均每章字数 |
| quality.cumulativeWords | int | 累计字数 |

---

### 3. GET /books

当前客户有数据的所有作品列表。

```bash
curl -H "Authorization: Bearer fa_sk_xxx" \
  https://your-domain.com/api/v1/books
```

**响应:**
```json
{
  "code": 0,
  "data": [
    {
      "name": "示例作品",
      "latestDate": "2026-05-25",
      "latestRevenue": 12.5,
      "totalChapters": 50,
      "cumulativeWords": 160000
    }
  ]
}
```

---

### 4. POST /collect

触发数据采集。每日首次采真实数据，同日再次请求返回缓存（秒级响应）。

**参数:** `?force=true` (可选，强制重新采集)

```bash
curl -X POST -H "Authorization: Bearer fa_sk_xxx" \
  https://your-domain.com/api/v1/collect

# 强制重采
curl -X POST -H "Authorization: Bearer fa_sk_xxx" \
  "https://your-domain.com/api/v1/collect?force=true"
```

**响应（缓存）:**
```json
{
  "code": 0,
  "data": [
    { "date": "2026-05-25", "book": "示例作品", "collectedAt": "2026-05-25T06:00:00.000Z" }
  ],
  "cached": true,
  "message": "今日已采集 1 本书，返回缓存"
}
```

**响应（新采集）:**
```json
{
  "code": 0,
  "data": {
    "date": "2026-05-25",
    "books": [
      { "book": "示例作品", "revenue": 12.5, "chapters": 45, "collectedAt": "..." }
    ],
    "total": 1
  },
  "message": "采集完成，共 1 本书"
}
```

**注意:** 采集是异步操作，约需 15-30 秒完成（取决于作品数和番茄服务器响应速度）。
限流: 每个客户每分钟最多 2 次采集请求。

---

### 5. GET /report

收益趋势报告，返回时间序列数据，方便前端绘制折线图。

**参数:**
- `?period=7d|30d` — 时间段 (默认 7d)
- `?book=<书名>` — 筛选作品 (可选)

```bash
curl -H "Authorization: Bearer fa_sk_xxx" \
  "https://your-domain.com/api/v1/report?period=14d&book=示例作品"
```

**响应:**
```json
{
  "code": 0,
  "data": {
    "period": "14d",
    "days": 14,
    "book": "示例作品",
    "revenue": [10.2, 11.5, 12.0, ...],
    "readers": [1200, 1350, 1400, ...],
    "bookmarks": [45, 48, 50, ...],
    "cumulativeWords": [130000, 133200, 136400, ...],
    "dates": ["2026-05-12", "2026-05-13", ...]
  }
}
```

---

### 6. GET /predict

基于近期收益数据预测未来收益。

**参数:** `?book=<书名>` (可选)

```bash
curl -H "Authorization: Bearer fa_sk_xxx" \
  "https://your-domain.com/api/v1/predict"
```

**响应:**
```json
{
  "code": 0,
  "data": {
    "recentAvg": 12.3,
    "prediction7d": 86.1,
    "prediction30d": 369.0,
    "full7d": [12.5, 12.8, ...],
    "full30d": [12.5, 12.8, ...]
  }
}
```

---

### 7. GET /chapters

章节分析数据 + 异常检测（自动标记低读完率、跟读率暴跌的章节）。

**参数:** `?book=<书名>` (可选)

```bash
curl -H "Authorization: Bearer fa_sk_xxx" \
  "https://your-domain.com/api/v1/chapters"
```

**响应:**
```json
{
  "code": 0,
  "data": {
    "date": "2026-05-25",
    "book": "示例作品",
    "totalChapters": 50,
    "chaptersWithData": 45,
    "avgCompletionRate": 35.2,
    "avgFollowRate": 34.1,
    "anomalies": [
      {
        "chapter": 23,
        "title": "第二十三章：转折",
        "type": "low_completion",
        "value": 12.5,
        "avg": 35.2,
        "message": "读完率 12.5% 远低于平均 35.2%"
      }
    ],
    "recent10": [
      {
        "chapter": 41,
        "title": "第四十一章",
        "completionRate": 38.5,
        "followReadRate": 36.2,
        "lossRate": 42.1,
        "wordCount": 3200
      }
    ]
  }
}
```

**anomalies 类型:**
- `low_completion` — 读完率低于平均 30%
- `follow_drop` — 跟读率低于平均 30%

---

### 8. GET /traffic

流量来源分布（搜索、书架、书城等）。

**参数:** `?book=<书名>` (可选)

```bash
curl -H "Authorization: Bearer fa_sk_xxx" \
  "https://your-domain.com/api/v1/traffic"
```

**响应:**
```json
{
  "code": 0,
  "data": {
    "book": "示例作品",
    "date": "2026-05-25",
    "sources": {
      "搜索": 108,
      "书架": 42,
      "书城": 15,
      "分类": 8,
      "推荐": 6
    }
  }
}
```

---

### 9. GET /metrics

核心写作指标（总收益、千字收益、日均章节、里程碑等）。

**参数:** `?book=<书名>` (可选)

```bash
curl -H "Authorization: Bearer fa_sk_xxx" \
  "https://your-domain.com/api/v1/metrics"
```

**响应:**
```json
{
  "code": 0,
  "data": {
    "book": "示例作品",
    "totalRevenue": 358.2,
    "recent7dRevenue": 87.5,
    "totalWords": 160000,
    "revenuePerKWords": 2.239,
    "avgDailyChapters": 1.8,
    "dataDays": 14,
    "milestone": {
      "current": "🌿 月入 ¥500",
      "next": "🌳 月入 ¥1000",
      "progress": 36
    }
  }
}
```

**milestone 说明:**
- `current` — 已达成里程碑
- `next` — 下一个里程碑
- `progress` — 到下一个里程碑的进度 (0-100)

---

## 错误码

| code | 说明 |
|------|------|
| 0 | 成功 |
| 400 | 请求参数错误 或 未配置登录态 |
| 401 | 缺少 API Key 或 番茄登录态过期 |
| 403 | 无效的 API Key |
| 404 | 数据不存在 |
| 409 | 冲突（同客户正在采集中） |
| 429 | 请求过于频繁 |
| 500 | 服务器内部错误 |

---

## 集成建议

1. **定时采集:** 每天固定时间（如早 8:00）调用一次 `POST /collect`，后续查询走缓存
2. **数据展示:** 用 `/report` 的时间序列数据画折线图，用 `/chapters` 的 anomalies 做高亮标记
3. **首次接入:** 客户需要先运行登录脚本完成番茄小说认证（联系服务提供方）

---

## 定价

| 套餐 | 月费 | 作品数 | 适用 |
|------|------|--------|------|
| Basic | ¥199 | ≤20本 | 个人作者 |
| Pro | ¥499 | ≤100本 | 小团队 |
| Enterprise | ¥1499 | ≤500本 | AI写作平台 |

发票/对公转账请联系服务提供方。
