import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

/**
 * 自定义脚本动作执行器
 * 在独立的 Node.js 子进程中执行用户脚本，带超时保护，不会影响主进程稳定性。
 */

// 子进程包装器路径（构建后位于 <cwd>/scripts/script-runner-wrapper.cjs）
const RUNNER_PATH = path.join(process.cwd(), 'scripts', 'script-runner-wrapper.cjs');

// 单次输出最大保留字符数，防止日志无限增长
const MAX_OUTPUT_LENGTH = 50000;

// 默认超时时间（秒）
const DEFAULT_TIMEOUT_SECONDS = 30;

export interface ScriptContext {
  monitorId: string;
  monitorName: string;
  monitorType: string;
  url?: string | null;
  hostname?: string | null;
  port?: string | number | null;
  status: string; // UP | DOWN
  statusCode: number; // 1 | 0
  prevStatus: string | null; // UP | DOWN | null
  prevStatusCode: number | null;
  message: string;
  timestamp: string; // ISO 字符串
}

export interface ScriptRunResult {
  exitCode: number | null;
  output: string;
  durationMs: number;
  timedOut: boolean;
  success: boolean;
  errorMessage?: string;
}

/**
 * 在子进程中执行用户脚本
 * @param code 用户脚本源码（CommonJS，导出 async 函数）
 * @param context 传入脚本的上下文
 * @param timeoutSeconds 超时时间（秒）
 */
export async function executeScript(
  code: string,
  context: ScriptContext,
  timeoutSeconds: number = DEFAULT_TIMEOUT_SECONDS
): Promise<ScriptRunResult> {
  const timeout = Math.max(1, Math.min(timeoutSeconds || DEFAULT_TIMEOUT_SECONDS, 600));

  // 写入临时脚本文件
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-script-'));
  const scriptPath = path.join(tmpDir, `user-${crypto.randomUUID()}.cjs`);
  fs.writeFileSync(scriptPath, code || '', { encoding: 'utf8' });

  const startTime = Date.now();
  let output = '';
  let timedOut = false;
  let exitCode: number | null = null;

  const appendOutput = (chunk: Buffer | string) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString();
    if (output.length < MAX_OUTPUT_LENGTH) {
      output += text;
      if (output.length > MAX_OUTPUT_LENGTH) {
        output = output.slice(0, MAX_OUTPUT_LENGTH) + '\n...[输出已截断]';
      }
    }
  };

  try {
    await new Promise<void>((resolve) => {
      const child: ChildProcess = spawn(process.execPath, [RUNNER_PATH, scriptPath], {
        // 安全：只传入最小必要环境变量，不泄露 NEXTAUTH_SECRET 等密钥
        env: {
          CM_SCRIPT_CONTEXT: JSON.stringify(context),
          PATH: process.env.PATH,
          LANG: process.env.LANG,
          TZ: process.env.TZ,
          NODE_ENV: 'production',
        },
        cwd: tmpDir,
        windowsHide: true,
        // 安全：启用独立进程组，超时时可 kill 整个进程树
        detached: true,
      });

      const timer = setTimeout(() => {
        timedOut = true;
        try {
          // 杀掉整个进程组（脚本自身 spawn 的子进程也会一起终止）
          process.kill(-child.pid!, 'SIGKILL');
        } catch {
          // 进程可能已退出，或 Windows 下不支持负 pid，降级为直接 kill
          try { child.kill('SIGKILL'); } catch { /* 忽略 */ }
        }
      }, timeout * 1000);

      child.stdout?.on('data', appendOutput);
      child.stderr?.on('data', appendOutput);

      child.on('error', (err) => {
        appendOutput(`启动子进程失败: ${err.message}`);
        clearTimeout(timer);
        resolve();
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        exitCode = code;
        if (timedOut) {
          output += `\n[脚本执行超时，已被强制终止（${timeout} 秒）]`;
        }
        resolve();
      });
    });

    const durationMs = Date.now() - startTime;
    const success = !timedOut && exitCode === 0;

    let errorMessage: string | undefined;
    if (timedOut) {
      errorMessage = `执行超时（${timeout} 秒）`;
    } else if (exitCode === null) {
      errorMessage = '子进程异常终止';
    } else if (exitCode === 2) {
      errorMessage = '脚本未导出可调用的 async 函数';
    } else if (exitCode === 3) {
      errorMessage = '脚本加载失败（语法错误）';
    } else if (exitCode === 4) {
      errorMessage = '脚本尝试加载被禁止的模块';
    } else if (exitCode !== 0) {
      errorMessage = `脚本执行失败（退出码 ${exitCode}）`;
    }

    return {
      exitCode,
      output: output.trim(),
      durationMs,
      timedOut,
      success,
      errorMessage,
    };
  } finally {
    // 清理临时文件
    try {
      fs.unlinkSync(scriptPath);
      fs.rmdirSync(tmpDir);
    } catch {
      // 忽略清理异常
    }
  }
}
