# 文档总览

面向开发者与 AI 的酷监控项目文档索引。按“先上手，后深入”的路径组织，帮助快速理解与修改功能。

## 快速入口

- 入门与运行: 见《getting-started.md》
- 架构与目录: 见《architecture.md》
- 监控系统详解: 见《monitoring-system.md》
- 自定义脚本动作: 见《script-action-guide.md》
- 导入监控项说明: 见《monitor-import.md》
- API 参考: 见《api-reference.md》
- 数据模型(Prisma): 见《data-models.md》
- 系统配置与环境: 见《configuration.md》
- 设计系统与主题: 见《design-system.md》
- 本地开发与调试: 见《development.md》
- 部署与运维: 见《deployment.md》
- 故障排查: 见《troubleshooting.md》
- 贡献指南: 见《contributing.md》

## 现有文档（已整合进索引，保留原文件）

- 数据库升级安全性: `database-upgrade-safety.md`
- 通知方式开发指南: `notification-development-guide.md`
- 状态页功能指南: `status-page-guide.md`
- 自定义脚本动作指南: `script-action-guide.md`

## 项目要点（高频问题速览）

- 技术栈: Next.js 15 + React 19，API Routes，Prisma(SQLite)，TailwindCSS，ECharts，NextAuth，Croner
- 默认端口: 3333（`next.config.js` 中 `env.PORT` 指定）
- 数据库: `prisma/schema.prisma` 指向 `data/coolmonitor.db`
- 监控核心: `src/lib/monitors/`（调度、检查器、通知、清理）
- API 路由: `src/app/api/`（详见《api-reference.md》）
- 主题与设计: Tailwind + CSS 变量（详见《design-system.md》）
- 批量监控导入: 支持 `GET /api/monitors/template` 下载 Excel 模板并通过 `/api/monitors/import` 上传

## 变更时建议阅读顺序

1) 《architecture.md》 → 2) 《monitoring-system.md》 → 3) 《api-reference.md》/《data-models.md》 → 4) 《configuration.md》 → 5) 《development.md》


