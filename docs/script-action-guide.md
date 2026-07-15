# 酷监控 - 自定义脚本动作功能指南

当监控项状态发生变化（UP↔DOWN）时，coolmonitor 可自动执行用户配置的 Node.js 脚本，实现自动化故障响应（如切换 DNS、重启服务、调用外部 API 等）。脚本在独立子进程中运行，带超时保护，不会影响主进程稳定性。

## 目录

- [功能概览](#功能概览)
- [使用方法](#使用方法)
- [脚本规范](#脚本规范)
- [上下文对象 ctx](#上下文对象-ctx)
- [触发条件](#触发条件)
- [模拟运行（调试）](#模拟运行调试)
- [执行历史](#执行历史)
- [让 AI 帮你写脚本](#让-ai-帮你写脚本)
- [架构设计](#架构设计)
- [安全说明](#安全说明)
- [常见问题](#常见问题)

## 功能概览

- **脚本动作**：每个监控项可独立配置一段 Node.js 脚本
- **触发时机**：监控状态变化时（UP→DOWN 或 DOWN→UP）自动执行
- **隔离执行**：脚本在独立子进程中运行，超时自动终止
- **调试支持**：可模拟 UP/DOWN 状态运行脚本，无需等待真实故障
- **执行记录**：每次执行结果（含模拟运行）都被记录，可查看退出码、输出、耗时等

## 使用方法

### 入口位置

脚本动作配置位于**监控项编辑表单**的「脚本动作」Tab 中：

1. 在仪表板左侧点击某个监控项进入详情
2. 点击右上角「编辑」按钮打开编辑表单
3. 切换到「脚本动作」Tab

> 注意：新建监控项时该 Tab 显示功能介绍，提示先保存监控项再回来配置脚本。

### 配置步骤

1. **打开启用开关**（右上角）：编写脚本内容后会自动开启，无需手动操作
2. **选择触发条件**：
   - `状态变化时触发（UP 和 DOWN）` — 任何状态变化都执行
   - `仅在 DOWN 时触发` — 只在服务故障时执行
   - `仅在 UP 时触发` — 只在服务恢复时执行
3. **设置执行超时**：脚本超过此时间未完成将被强制终止（1-600 秒，默认 30）
4. **编写脚本**：在编辑器中输入 Node.js 脚本
5. **模拟运行**：点击「UP」或「DOWN」按钮测试脚本效果
6. **保存配置**：点击「保存配置」按钮

### 自动启用

当用户在脚本编辑器中输入非空内容时，右上角的启用开关会自动打开，避免保存了脚本却忘记启用。

## 脚本规范

### 基本格式

脚本必须导出一个 `async` 函数，coolmonitor 调用时传入上下文对象 `ctx`：

```javascript
module.exports = async (ctx) => {
  // 你的自动化逻辑
  console.log(`监控项 ${ctx.monitorName} 状态变更为 ${ctx.status}`);
};
```

### 支持的导出方式

以下任一方式均可被识别：

```javascript
// 方式一：直接导出 async 函数（推荐）
module.exports = async (ctx) => { ... };

// 方式二：default 导出
module.exports.default = async (ctx) => { ... };

// 方式三：run 属性
module.exports.run = async (ctx) => { ... };

// 方式四：handler 属性
module.exports.handler = async (ctx) => { ... };
```

### 运行环境

- **运行时**：Node.js（与 coolmonitor 相同的版本）
- **执行方式**：通过 `child_process.spawn` 在独立子进程中执行
- **超时保护**：超过设定时间后杀掉整个进程组（含脚本内部派生的子进程），发送 `SIGKILL` 强制终止
- **可用模块**：仅限网络与数据处理相关的内置模块（见下方安全说明）
- **输出捕获**：`console.log` / `console.error` 的内容会被记录到执行历史
- **异常隔离**：脚本崩溃、抛错或超时都不会影响 coolmonitor 主进程

## 上下文对象 ctx

调用脚本时传入的 `ctx` 对象包含以下字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `monitorId` | string | 监控项 ID |
| `monitorName` | string | 监控项名称 |
| `monitorType` | string | 监控项类型（http/port/mysql/redis/icmp/push 等） |
| `url` | string \| undefined | 监控地址（HTTP/关键词/证书类型有值） |
| `hostname` | string \| undefined | 主机名（端口/数据库/ICMP 类型有值） |
| `port` | number \| string \| undefined | 端口号（端口/数据库类型有值） |
| `status` | string | 当前状态：`"UP"` 或 `"DOWN"` |
| `statusCode` | number | 当前状态码：`1`=正常，`0`=异常 |
| `prevStatus` | string \| null | 上一次状态：`"UP"` / `"DOWN"` / `null`（首次检查为 null） |
| `prevStatusCode` | number \| null | 上一次状态码 |
| `message` | string | 状态描述信息 |
| `timestamp` | string | 触发时间（ISO 8601 字符串） |

## 触发条件

| 触发条件 | 说明 | 执行时机 |
|----------|------|----------|
| `both` | 状态变化时触发 | DOWN→UP 和 UP→DOWN 都执行 |
| `down` | 仅在 DOWN 时触发 | UP→DOWN 时执行 |
| `up` | 仅在 UP 时触发 | DOWN→UP 时执行 |

触发规则：

- **首次检查不触发**：监控项刚创建后的第一次检查（`prevStatus` 为 null）不会触发脚本
- **状态未变化不触发**：连续两次检查状态相同不会重复执行脚本
- **所有监控类型均支持**：包括 HTTP、端口、数据库、Push、ICMP 等所有监控类型

## 模拟运行（调试）

无需等待真实故障即可测试脚本：

1. 在「脚本动作」Tab 点击「模拟运行」区域的「UP」或「DOWN」按钮
2. 系统会以模拟的状态执行当前编辑器中的脚本内容
3. 执行结果会显示在按钮下方（退出码、输出、耗时、错误信息）
4. 模拟运行的记录也会保存到执行历史中（标记为「模拟运行」）

> 模拟运行使用编辑器中的**当前内容**，即使还没保存也可以测试。

## 执行历史

每次脚本执行（包括模拟运行和真实触发）都会记录：

- **执行结果**：成功 / 失败 / 超时
- **退出码**：0=成功，1=脚本异常，2=未导出函数，3=语法错误
- **输出内容**：脚本的 `console.log` / `console.error` 输出
- **执行耗时**：毫秒级精度
- **触发来源**：真实触发（状态变化）或模拟运行
- **状态快照**：触发时的当前状态和上一次状态
- **错误信息**：失败或超时时的详细原因

点击历史记录可展开查看完整输出。执行历史会随数据保留策略定期清理。

## 让 AI 帮你写脚本

脚本编辑器旁有「如何让 AI 帮我写脚本」按钮，点击打开帮助弹窗：

1. 在弹窗中描述你的需求（如「DOWN 时调用 Cloudflare API 切换 DNS 到备用服务器」）
2. 系统自动生成包含 coolmonitor 背景信息和脚本规范的完整提示词
3. 点击「复制提示词」复制到剪贴板
4. 粘贴给任意 AI（ChatGPT、Claude、通义千问等）
5. 将 AI 生成的代码复制回脚本编辑器
6. 点击「模拟运行」测试效果

## 架构设计

### 核心文件

| 文件 | 作用 |
|------|------|
| `prisma/schema.prisma` | `ScriptAction` 和 `ScriptExecution` 数据模型 |
| `src/lib/database-upgrader.ts` | 版本 11 运行时数据库迁移 |
| `scripts/script-runner-wrapper.cjs` | 子进程包装器，加载并执行用户脚本 |
| `src/lib/monitors/script-runner.ts` | `executeScript` 函数，管理子进程生命周期 |
| `src/lib/monitors/script-action-service.ts` | 核心服务：触发逻辑、CRUD、模拟运行、历史记录 |
| `src/lib/monitors/scheduler.ts` | 调度器集成点，状态变化时异步触发脚本 |
| `src/lib/monitors/data-cleaner.ts` | 执行历史的定期清理 |
| `src/app/dashboard/monitors/components/ScriptActionSection.tsx` | 前端配置面板 |

### API 路由

| 路由 | 方法 | 说明 |
|------|------|------|
| `/api/monitors/[id]/script-action` | GET | 获取脚本动作配置 |
| `/api/monitors/[id]/script-action` | PUT | 保存脚本动作配置 |
| `/api/monitors/[id]/script-action/test` | POST | 模拟运行脚本 |
| `/api/monitors/[id]/script-action/history` | GET | 获取执行历史 |

所有路由均通过 `validateMonitorOwnership` 校验当前用户是否有权访问该监控项。

### 执行流程

```
监控状态变化（UP↔DOWN）
  ↓
scheduler.ts 异步触发（setImmediate，不阻塞监控检查）
  ↓
script-action-service.ts: triggerScriptAction()
  ↓ 检查 enabled 和触发条件
  ↓
script-runner.ts: executeScript()
  ↓ 写入临时文件 → spawn 子进程（最小环境变量 + 独立进程组） → 采集输出 → 超时杀进程组
  ↓
script-runner-wrapper.cjs require 白名单拦截 → 加载用户脚本 → 调用导出的 async 函数
  ↓
记录执行结果到 ScriptExecution 表
```

### 退出码约定

| 退出码 | 含义 |
|--------|------|
| 0 | 执行成功 |
| 1 | 脚本运行时抛出异常 |
| 2 | 脚本未导出可调用的 async 函数 |
| 3 | 脚本加载失败（语法错误） |
| 4 | 脚本尝试加载被禁止的模块 |

## 安全说明

脚本在独立子进程中执行，通过以下多层防护确保不会威胁服务器安全：

### 模块白名单（核心安全机制）

脚本**只能使用**以下内置模块，用于发请求和处理数据：

| 允许的模块 | 用途 |
|-----------|------|
| `http` / `https` | 发送 HTTP/HTTPS 请求（调用 API 的核心能力） |
| `dns` | DNS 解析 |
| `crypto` | 加密、哈希、签名（如 HMAC-SHA256） |
| `url` / `querystring` | URL 与查询字符串处理 |
| `zlib` | 压缩/解压 |
| `path` / `os` / `util` / `events` / `stream` / `buffer` / `timers` | 基础工具 |

**被禁止的模块**（加载时会报退出码 4 并终止）：

| 禁止的模块 | 原因 |
|-----------|------|
| `child_process` | 防止执行系统命令（`exec`、`spawn` 等） |
| `fs` | 防止读写服务器文件系统 |
| `net` | 防止原始 socket 操作 |
| 第三方 npm 包 | 仅允许上述内置模块 |

### 其他安全措施

- **环境变量隔离**：子进程只接收 `CM_SCRIPT_CONTEXT`（上下文）、`PATH`、`TZ` 等必要变量，**不传入** `NEXTAUTH_SECRET`、数据库路径等敏感信息
- **进程组终止**：超时时杀掉整个进程组（`detached` + `kill -pid`），连脚本内部派生的子进程也一并终止，防止残留后门
- **授权校验**：所有 API 路由均校验当前用户对该监控项的所有权（管理员可访问所有）
- **超时保护**：默认 30 秒，超时后强制终止
- **进程隔离**：脚本崩溃不影响 coolmonitor 主进程
- **临时文件**：脚本内容写入临时文件，执行完毕后自动清理

> 如果你的场景需要调用系统命令（如 `systemctl restart`），建议通过脚本调用服务器上的一个中间 HTTP API 来间接实现，而不是直接在脚本中执行命令。

## 常见问题

### 脚本没有执行？

检查以下几点：
1. 右上角开关是否已**开启**（输入脚本内容后会自动开启）
2. **触发条件**是否匹配当前的状态变化（如设为「仅 DOWN」则恢复时不会触发）
3. 是否是**首次检查**（首次检查 `prevStatus` 为 null，不触发）
4. 查看**执行历史**确认是否有错误记录

### 脚本执行超时？

1. 增大「执行超时」设置值
2. 检查脚本中是否有耗时的同步操作或无限循环
3. 网络请求建议设置合理的超时时间

### 如何在脚本中调用外部 API？

```javascript
module.exports = async (ctx) => {
  const https = require('https');

  const data = JSON.stringify({
    event: ctx.status,
    monitor: ctx.monitorName,
    message: ctx.message
  });

  const options = {
    hostname: 'api.example.com',
    port: 443,
    path: '/webhook',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': data.length,
      'Authorization': 'Bearer your-token-here'
    }
  };

  await new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      console.log(`API 响应状态码: ${res.statusCode}`);
      res.on('data', () => {});
      res.on('end', resolve);
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
};
```

### 脚本中如何获取完整的上下文？

```javascript
module.exports = async (ctx) => {
  console.log(JSON.stringify(ctx, null, 2));
};
```

执行后到「执行历史」中展开记录即可查看完整的 `ctx` 内容。
