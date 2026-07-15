# API 参考

说明：所有受保护接口均需登录态（NextAuth）。部分路由在生产会限制调试端点。

## 监控 Monitors

- POST `/api/monitors`
  - 入参: `name` `type` `config` `interval` `retries` `retryInterval` `resendInterval` `upsideDown` `description` `active` `groupId` `notificationBindings`
  - 说明: 创建监控并立即调度
- GET `/api/monitors`
  - 出参: 监控列表，含 `notificationBindings` 简化结构
- PATCH `/api/monitors`（批量状态开关）
  - 入参: `id` `active`
- GET `/api/monitors/[id]`
- PUT `/api/monitors/[id]`
- DELETE `/api/monitors/[id]`
- PATCH `/api/monitors/[id]`（单个状态开关）
- GET `/api/monitors/[id]/history?range=2h|24h|7d|30d|90d`
- POST `/api/monitors/start` 入参: `id`
- POST `/api/monitors/stop` 入参: `id`
- POST `/api/monitors/reset` 重置并重调度所有激活监控
- POST `/api/monitors/batch` 入参: `{ ids: string[], action: 'start'|'stop'|'delete' }`
- PUT `/api/monitors/reorder` 入参: `{ updates: { id: string, displayOrder: number }[] }`

### 自定义脚本动作 Script Action

所有脚本动作接口均校验当前用户对该监控项的所有权（管理员可访问所有）。详见《script-action-guide.md》。

- GET `/api/monitors/[id]/script-action` — 获取脚本动作配置（不存在时自动创建默认配置）
- PUT `/api/monitors/[id]/script-action` — 保存脚本动作配置
  - 入参: `enabled?` `script?` `triggerCondition?('down'|'up'|'both')` `timeout?(1-600秒)`
- POST `/api/monitors/[id]/script-action/test` — 模拟运行脚本
  - 入参: `simulatedStatus(1=UP|0=DOWN)` `script?（临时脚本，不保存）`
  - 出参: `{ result: { exitCode, output, durationMs, success, timedOut, errorMessage, ... } }`
  - exitCode: 0=成功 1=异常 2=未导出函数 3=语法错误 4=尝试加载禁止模块
- GET `/api/monitors/[id]/script-action/history?limit=50` — 获取执行历史

## 分组 Monitor Groups

- GET `/api/monitor-groups`
- POST `/api/monitor-groups` 入参: `name` `description?` `color?`
- GET `/api/monitor-groups/[id]`
- PUT `/api/monitor-groups/[id]`
- DELETE `/api/monitor-groups/[id]`

## 状态页 Status Pages

- GET `/api/status-pages`
- POST `/api/status-pages` 入参: `name` `slug` `title` `isPublic?`
- GET `/api/status-pages/[id]`
- PUT `/api/status-pages/[id]`
- DELETE `/api/status-pages/[id]`
- GET `/api/status-pages/[id]/monitors`
- POST `/api/status-pages/[id]/monitors` 入参（单个或批量）: `{ monitorIds?: string[], displayNames?: Record<string,string>, monitorId?: string, displayName?: string }`
- DELETE `/api/status-pages/[id]/monitors/[monitorId]`
- 公开获取: GET `/api/status/[slug]`

## 设置 Settings

- GET `/api/settings?section=general|proxy|all`
- POST `/api/settings` 入参: 任意键值对（最终转为字符串）
- DELETE `/api/settings` 重置为默认
- POST `/api/settings/proxy-test` 入参: `{ url?: string, forceUpdateSettings?: boolean }`
- GET `/api/settings/debug` 开发环境返回原始配置，生产禁用

### 通知渠道 Notifications

- GET `/api/settings/notifications`
- POST `/api/settings/notifications` 入参: `name` `type` `enabled?` `defaultForNewMonitors?` `config`
- GET `/api/settings/notifications/[id]`
- PUT `/api/settings/notifications/[id]`
- DELETE `/api/settings/notifications/[id]`
- PATCH `/api/settings/notifications/[id]` 切换启用状态
- PATCH `/api/settings/notifications/[id]/default` 切换“新增监控默认选中”

## Push 被动监控

- GET `/api/push/[token]?status=up|down|1|0&msg=...&ping=123`
  - 说明: 客户端上报心跳并更新 `lastPushTime`

## 认证与用户

- POST `/api/auth/register` 首次初始化前允许注册管理员
- NextAuth: `/api/auth/[...nextauth]`（登录、会话）
- GET `/api/user/login-records?limit=20&page=1`

备注：各端点的鉴权、参数校验与错误返回，详见对应源码。
