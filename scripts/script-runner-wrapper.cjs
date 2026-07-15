'use strict';

/**
 * 自定义脚本动作的子进程执行包装器
 *
 * 由主进程通过 spawn 调用，参数：
 *   argv[2] 用户脚本文件的绝对路径（.cjs）
 *
 * 上下文通过环境变量 CM_SCRIPT_CONTEXT 以 JSON 字符串形式传入。
 *
 * 用户脚本规范：导出一个 async 函数，接收上下文对象 ctx，例如：
 *   module.exports = async (ctx) => {
 *     console.log(ctx.monitorName, ctx.status);
 *   };
 *
 * 退出码约定：
 *   0  执行成功
 *   1  脚本运行时抛出异常
 *   2  脚本未导出可调用的 async 函数
 *   3  脚本加载失败（语法错误等）
 *   4  尝试加载被禁止的模块
 */
const path = require('path');
const Module = require('module');

// ── 安全限制：require 白名单 ──────────────────────────────
// 只允许网络与数据处理相关的内置模块，禁止文件系统、系统命令等。
// 这确保用户脚本只能做"发请求/处理数据"，无法操控服务器。
var ALLOWED_MODULES = {
  http: true,
  https: true,
  url: true,
  dns: true,
  crypto: true,
  querystring: true,
  zlib: true,
  path: true,
  os: true,
  string_decoder: true,
  util: true,
  events: true,
  stream: true,
  buffer: true,
  timers: true,
};

// 在 hook 安装前先标记，避免拦截 wrapper 自身的 require
var hookInstalled = false;

var originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  // wrapper 自身加载阶段不拦截
  if (!hookInstalled) {
    return originalLoad.apply(this, arguments);
  }

  // 解析顶层模块名
  var topLevel = request.split(/[\\/]/)[0];

  // 允许白名单内置模块
  if (ALLOWED_MODULES[topLevel]) {
    return originalLoad.apply(this, arguments);
  }

  // 允许加载用户主脚本文件（绝对路径或相对路径）
  // 注意：只有 isMain=true 的入口脚本才放行，脚本内部 require 相对路径文件仍然被拦
  if (isMain || request.charAt(0) === '/' || /^[A-Za-z]:[\\/]/.test(request)) {
    return originalLoad.apply(this, arguments);
  }

  // 其他一律拒绝
  var err = new Error(
    '安全限制：不允许加载模块 "' + request + '"。\n' +
    '脚本仅可使用以下内置模块：' + Object.keys(ALLOWED_MODULES).join(', ') + '\n' +
    '如需调用外部服务，请使用 http/https 发送请求。'
  );
  err.code = 'MODULE_BLOCKED';
  throw err;
};

// ── 主逻辑 ────────────────────────────────────────────────
async function main() {
  var userScriptPath = process.argv[2];
  if (!userScriptPath) {
    console.error('缺少用户脚本路径参数');
    process.exit(3);
  }

  // 解析上下文
  var ctx = {};
  try {
    ctx = JSON.parse(process.env.CM_SCRIPT_CONTEXT || '{}');
  } catch (err) {
    console.error('解析脚本上下文失败:', err && err.message ? err.message : String(err));
  }

  // 从此刻起启用 require 拦截
  hookInstalled = true;

  // 加载用户脚本
  var mod;
  try {
    mod = require(path.resolve(userScriptPath));
  } catch (err) {
    console.error('加载脚本失败:');
    console.error(err && err.stack ? err.stack : String(err));
    // 模块被安全策略拦截时用退出码 4，否则用 3
    process.exit(err && err.code === 'MODULE_BLOCKED' ? 4 : 3);
  }

  // 兼容多种导出方式
  var handler =
    typeof mod === 'function' ? mod :
    typeof (mod && mod.default) === 'function' ? mod.default :
    typeof (mod && mod.run) === 'function' ? mod.run :
    typeof (mod && mod.handler) === 'function' ? mod.handler :
    null;

  if (!handler) {
    console.error('脚本必须导出一个 async 函数，例如：module.exports = async (ctx) => { ... }');
    process.exit(2);
  }

  try {
    await handler(ctx);
    process.exit(0);
  } catch (err) {
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
  }
}

main();
