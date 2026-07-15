# 架构与目录

## 总览

- 前端/后端一体: Next.js 15 App Router（React 19）
- 后端接口: Next.js API Routes（`src/app/api`）
- 定时与调度: Croner
- 数据层: Prisma（SQLite）
- UI: TailwindCSS + 自定义设计系统
- 图表: ECharts
- 认证: NextAuth

## 目录结构（关键）

- `src/app` 应用及路由
  - `src/app/api` 所有 API 路由（监控、设置、状态页、Push 等）
  - `src/app/dashboard` 主控制台 UI
  - `src/app/status/[slug]` 公共状态页
- `src/lib` 服务与工具
  - `src/lib/monitors` 监控核心（调度、检查器、通知、清理、类型）
  - `src/lib/prisma.ts` Prisma 客户端
  - `src/lib/settings.ts` 系统设置与通知渠道 CRUD
  - `src/lib/system-config.ts` 系统级配置（注册开关、JWT）
  - `src/lib/database-upgrader.ts` 数据库升级器
- `src/components` 复用组件（如 `settings-dialog.tsx` 等）
- `prisma/schema.prisma` 数据模型
- `data/coolmonitor.db` SQLite 数据

## 运行时流程（监控）

1) 启动 → 初始化/升级数据库 → 加载/调度监控
2) 定时器触发 → 调用对应检查器（HTTP/端口/数据库/ICMP/Push…）
3) 记录 `MonitorStatus`，更新 `Monitor` 最近状态
4) 状态变化 → 通过 `notification-service.ts` 发送通知
5) 状态变化 → 通过 `script-action-service.ts` 异步触发自定义脚本（如有配置）

## 关键文件

- 调度器: `src/lib/monitors/scheduler.ts`
- 检查器聚合: `src/lib/monitors/index.ts`
- HTTP/关键词/证书: `src/lib/monitors/checker-http.ts`
- 端口: `src/lib/monitors/checker-ports.ts`
- 数据库(MySQL/Redis): `src/lib/monitors/checker-database.ts`
- ICMP: `src/lib/monitors/checker-icmp.ts`
- Push: `src/lib/monitors/checker-push.ts`
- 通知: `src/lib/monitors/notification-service.ts`
- 状态记录: `src/lib/monitors/status-recorder.ts`
- 自定义脚本动作: `src/lib/monitors/script-action-service.ts`（子进程执行 `script-runner.ts`，包装器 `scripts/script-runner-wrapper.cjs`）

## API 概要

详见《api-reference.md》。核心分组：
- 监控 CRUD 与控制: `/api/monitors/**`
- 分组管理: `/api/monitor-groups/**`
- 状态页管理: `/api/status-pages/**`
- 设置/通知: `/api/settings/**`
- Push 上报: `/api/push/[token]`

## 配置与常量

- 端口: `next.config.js` → `env.PORT = 3333`
- Tailwind: `tailwind.config.ts`
- 系统设置键: `src/lib/settings.ts` 中 `SETTINGS_KEYS`
