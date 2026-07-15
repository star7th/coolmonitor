# 监控系统详解

## 监控类型

- http: 网站/接口可用性（状态码、请求头/体、自定义超时、可选证书到期提醒）
- https-cert: SSL 证书有效性与剩余天数（支持到期提醒）
- keyword: 页面包含关键词（支持多关键字，逗号分隔）
- port: TCP 端口开放性
- mysql / redis: 数据库连接与简单查询/命令
- push: 被动心跳（客户端上报）
- icmp: Ping 连通性（包数、超时阈值）

状态定义：UP=1、DOWN=0、PENDING=2

## 调度与执行

- 调度器: `src/lib/monitors/scheduler.ts`
  - 按 `Monitor.interval` 创建独立 Cron 任务
  - <60s 用秒级 Cron；<=1h 用分钟 Cron；>1h 用小时 Cron（随机分钟散列）
  - 首次调度会立即跑一次检查
- 重试机制：
  - 在调度层面处理 retries/retryInterval（HTTP/DB/端口/ICMP 等检查器内部也有单次版 + 带重试版以适配调用场景）
- UpsideDown: 最终状态可反转

## Push 特殊逻辑

- 最新一次推送时间与设定 `pushInterval` 比较
- 在调度器中对 Push 进行特殊处理，按状态变化发送通知（含“首次恢复补发”的边界）
- `/api/push/[token]` 支持 `status`、`msg`、`ping` 参数，且会更新 `config.lastPushTime`

## 检查器入口与实现

- 统一入口: `src/lib/monitors/index.ts` 的 `checkers`
- HTTP/关键词/证书: `checker-http.ts`
  - 支持代理（读取 `settings.ts` 的 PROXY_* 配置）
  - 证书检查使用 `ssl-checker` 并在中午定时提醒（过期/7日内到期，带日缓存）
- 端口: `checker-ports.ts`（TCP 连接，10s 超时，返回详细错误）
- 数据库: `checker-database.ts`（MySQL、Redis）
- ICMP: `checker-icmp.ts`（跨平台 ping 调用，包数与阈值）
- Push: `checker-push.ts`

## 状态记录与通知

- 记录: 调度器内部直接 `INSERT MonitorStatus` 并更新 `Monitor` 的 `lastCheckAt/nextCheckAt/lastStatus`
- 服务: `notification-service.ts`
  - 仅在状态变化时发送
  - 失败聚合（失败次数、起止时间、持续分钟）
  - 恢复通知包含故障持续时长
  - 支持: 邮件、Webhook、微信推送、钉钉、企业微信
- 清理: `data-cleaner.ts`（按系统设置定期清理历史，包括脚本执行记录）

## 自定义脚本动作

当监控状态变化时，可自动执行用户配置的 Node.js 脚本实现自动化响应。详见《script-action-guide.md》。

- 配置存储: `ScriptAction` 表（每监控项一条，1:1）
- 执行记录: `ScriptExecution` 表（含真实触发与模拟运行）
- 子进程执行: `script-runner.ts` 通过 `child_process.spawn` 运行，带超时强杀整个进程组
- 安全限制: `script-runner-wrapper.cjs` 通过 require 白名单只允许网络/数据模块（http/https/dns/crypto 等），禁止 child_process/fs；子进程只接收最小环境变量（不传密钥）
- 触发集成: `scheduler.ts` 在状态变化后通过 `setImmediate` 异步触发（不阻塞监控检查）
- 触发条件: 支持 `down`（仅故障）/ `up`（仅恢复）/ `both`（两者）
- 首次检查不触发（`prevStatus` 为 null 时跳过）
- 所有监控类型均支持（含 Push 类型的恢复路径）

## 类型与配置要点

- `MonitorHttpConfig`: url, httpMethod, statusCodes, headers/body, connectTimeout, notifyCertExpiry, retries, retryInterval
- `MonitorKeywordConfig`: 继承 HTTP + keyword
- `MonitorPortConfig`: hostname, port, retries, retryInterval
- `MonitorDatabaseConfig`: 继承端口 + username/password/database/query
- `MonitorPushConfig`: token, lastPushTime, pushInterval
- `MonitorIcmpConfig`: hostname, packetCount, maxResponseTime, retries, retryInterval

建议：新增检查器时在 `index.ts` 注册，并在 API 创建/更新时完善参数校验。
