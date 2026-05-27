# CLAUDE.md — maximum-creator

番茄小说数据中间件项目仓库。默认为 `fanqie-analytics` 工作区。

---

## 项目结构

```
maximum-creator/
├── fanqie-analytics/     ← 主力项目：番茄数据采集分析 SaaS
│   ├── server.js          Express API 服务 (端口 3000)
│   ├── fanqie-analytics.js  CLI 工具入口
│   ├── lib/               核心模块
│   │   ├── browser-manager.js  Playwright 浏览器池管理
│   │   ├── collector.js        数据采集引擎
│   │   ├── auth.js             多租户认证
│   │   ├── scheduler.js        定时采集调度
│   │   ├── usage-tracker.js    用量追踪（B2B套餐）
│   │   └── plans.js            套餐配额定义
│   ├── config/            租户配置 (tenants.json)
│   ├── data/demo/         采集数据 (按日期 + 按作品)
│   ├── public/            前端页面
│   │   ├── demo.html      主诊断页面（采集→分析→可视化）
│   │   ├── dashboard.html B2B 仪表盘
│   │   └── admin.html     管理后台
│   ├── browser-profiles/  浏览器持久化配置
│   └── scripts/           运维脚本
└── fanqie-data/           数据集导出目录
```

## 常用命令

| 命令 | 说明 |
|------|------|
| `cd fanqie-analytics && npm start` | 启动 API 服务 |
| `npm run dev` | 开发模式（watch 重启） |
| `npm run collect` | CLI 手动采集 |
| `npm run html` | 生成 HTML 报告 |
| `npm run login` | 快速登录番茄后台 |
| `node server.js` | 启动服务（默认 3000 端口） |

## API 端点

- `GET /api/v1/health` — 健康检查（含租户状态）
- `POST /api/v1/login` — 触发浏览器登录
- `POST /api/v1/books/scan` — 扫描作品列表
- `POST /api/v1/collect` — 启动数据采集
- `GET /api/v1/collect/progress` — 采集进度轮询
- `GET /api/v1/analysis` — 智能分析报告
- `GET /api/v1/daily` — 昨日快照
- `GET /api/v1/weekly` — 近七日评估

## 关键设计

- **租户隔离**: 每个租户独立浏览器 profile + 数据目录
- **非阻塞采集**: POST /collect 立即返回，前端轮询 /collect/progress
- **采集模式**: `standard`（含章节明细）和 `fast`（仅核心指标）
- **B2B 套餐**: 4级套餐 (Free/Pro/Business/Enterprise)，按采集次数和数据保留计费
