# 数据模型（Prisma）

基于 `prisma/schema.prisma`。

## User
- id (String, cuid, 主键)
- username (String, 唯一)
- name/email (可选)
- password (String, 哈希)
- isAdmin (Boolean, 默认 false)
- createdAt/updatedAt
- 关系: loginRecords, monitors, sessions, statusPages, monitorGroups

## Session
- id (String, cuid)
- sessionToken (唯一)
- userId (外键 → User)
- expires (DateTime)

## SystemConfig
- id (String, cuid)
- key (String, 唯一)
- value (String)
- createdAt/updatedAt

## NotificationChannel
- id (String, cuid)
- name (String)
- type (String)
- enabled (Boolean, 默认 true)
- config (Json)
- defaultForNewMonitors (Boolean, 默认 false)
- createdAt/updatedAt

## MonitorGroup
- id (String, cuid)
- name (String)
- description (String?)
- color (String?)
- displayOrder (Int?)
- createdById (String?) → User
- createdAt/updatedAt
- 关系: monitors

## Monitor
- id (String, cuid)
- name (String)
- type (String)
- config (Json)
- active (Boolean, 默认 true)
- interval (Int, 秒)
- retries/retryInterval/resendInterval (Int)
- upsideDown (Boolean)
- description (String?)
- lastCheckAt/nextCheckAt/lastStatus (可选)
- displayOrder (Int?)
- groupId (String?) → MonitorGroup
- createdById (String?) → User
- 关系: notificationBindings, statusHistory, statusPages

## MonitorNotification（多对多关联）
- id (String, cuid)
- monitorId → Monitor
- notificationChannelId → NotificationChannel
- enabled (Boolean)
- createdAt/updatedAt
- 复合唯一: (monitorId, notificationChannelId)

## MonitorStatus（历史记录）
- id (String, cuid)
- monitorId → Monitor
- status (Int: 0/1/2)
- message (String?)
- ping (Int?)
- timestamp (DateTime, 默认 now)
- 索引: (monitorId, timestamp)

## LoginRecord
- id (String, cuid)
- userId → User
- ipAddress/userAgent
- success (Boolean)
- createdAt (DateTime)
- 索引: (userId, createdAt)

## StatusPage
- id (String, cuid)
- name (String)
- slug (String, 唯一)
- title (String)
- isPublic (Boolean, 默认 true)
- createdById (String?) → User
- createdAt/updatedAt
- 关系: monitors（StatusPageMonitor）

## StatusPageMonitor（复合主键）
- statusPageId + monitorId（主键）
- displayName (String?)
- order (Int, 默认 0)
- createdAt
- 关系: monitor, statusPage
- 索引: (statusPageId, order)

## ScriptAction（自定义脚本动作配置）
- id (String, cuid)
- monitorId (String, 唯一) → Monitor
- enabled (Boolean, 默认 false) — 是否启用
- script (String, 默认 '') — 用户脚本源码
- triggerCondition (String, 默认 'both') — 触发条件：down | up | both
- timeout (Int, 默认 30) — 执行超时（秒）
- createdAt/updatedAt
- 关系: monitor, executions
- 索引: (monitorId)

## ScriptExecution（脚本执行记录）
- id (String, cuid)
- scriptActionId (String) → ScriptAction
- exitCode (Int?) — 退出码：0=成功 1=异常 2=未导出函数 3=语法错误
- output (String, 默认 '') — 脚本输出
- durationMs (Int, 默认 0) — 执行耗时（毫秒）
- success (Boolean, 默认 false)
- timedOut (Boolean, 默认 false) — 是否超时
- triggerSource (String, 默认 'real') — 触发来源：real（真实触发）| simulate（模拟运行）
- currentStatus (Int) — 触发时的当前状态
- prevStatus (Int?) — 触发时的上一次状态
- errorMessage (String?)
- createdAt (DateTime)
- 索引: (scriptActionId, createdAt)、(createdAt)
