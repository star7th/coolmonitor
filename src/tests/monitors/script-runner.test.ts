import { describe, it, expect } from 'vitest';
import { executeScript } from '../../lib/monitors/script-runner';
import { shouldTriggerScript } from '../../lib/monitors/script-action-service';
import { ScriptContext } from '../../lib/monitors/script-runner';

const baseContext: ScriptContext = {
  monitorId: 'test-monitor-id',
  monitorName: '测试监控',
  monitorType: 'http',
  url: 'https://example.com',
  status: 'DOWN',
  statusCode: 0,
  prevStatus: 'UP',
  prevStatusCode: 1,
  message: '连接超时',
  timestamp: new Date().toISOString(),
};

describe('executeScript 子进程执行', () => {
  it('应成功执行返回退出码 0 的脚本', async () => {
    const code = `
      module.exports = async (ctx) => {
        console.log('hello from script');
        console.log(ctx.monitorName + ' ' + ctx.status);
      };
    `;
    const result = await executeScript(code, baseContext, 10);
    expect(result.exitCode).toBe(0);
    expect(result.success).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.output).toContain('hello from script');
    expect(result.output).toContain('测试监控 DOWN');
  });

  it('当脚本抛出异常时返回退出码 1', async () => {
    const code = `
      module.exports = async (ctx) => {
        throw new Error('故意失败');
      };
    `;
    const result = await executeScript(code, baseContext, 10);
    expect(result.exitCode).toBe(1);
    expect(result.success).toBe(false);
    expect(result.output).toContain('故意失败');
    expect(result.errorMessage).toContain('退出码 1');
  });

  it('当脚本未导出 async 函数时返回退出码 2', async () => {
    const code = `
      module.exports = { foo: 'bar' };
    `;
    const result = await executeScript(code, baseContext, 10);
    expect(result.exitCode).toBe(2);
    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('async 函数');
  });

  it('当脚本存在语法错误时返回退出码 3', async () => {
    const code = `
      this is not valid javascript {{{;
    `;
    const result = await executeScript(code, baseContext, 10);
    expect(result.exitCode).toBe(3);
    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('语法错误');
  });

  it('应在超时后终止脚本', async () => {
    const code = `
      module.exports = async (ctx) => {
        await new Promise(resolve => setTimeout(resolve, 10000));
        console.log('不应到达这里');
      };
    `;
    const result = await executeScript(code, baseContext, 2);
    expect(result.timedOut).toBe(true);
    expect(result.success).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(1900);
    expect(result.errorMessage).toContain('超时');
  });

  it('应正确读取通过环境变量传入的上下文', async () => {
    const code = `
      module.exports = async (ctx) => {
        console.log(JSON.stringify(ctx));
      };
    `;
    const result = await executeScript(code, baseContext, 10);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.output);
    expect(parsed.monitorId).toBe(baseContext.monitorId);
    expect(parsed.url).toBe(baseContext.url);
    expect(parsed.statusCode).toBe(0);
  });

  it('应支持 default 导出方式', async () => {
    const code = `
      module.exports.default = async (ctx) => {
        console.log('default export');
      };
    `;
    const result = await executeScript(code, baseContext, 10);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('default export');
  });
});

describe('executeScript 安全限制', () => {
  it('禁止加载 child_process 模块', async () => {
    const code = `
      const { execSync } = require('child_process');
      module.exports = async (ctx) => {
        execSync('echo hacked');
      };
    `;
    const result = await executeScript(code, baseContext, 10);
    expect(result.exitCode).toBe(4);
    expect(result.success).toBe(false);
    expect(result.output).toContain('child_process');
    expect(result.errorMessage).toContain('禁止的模块');
  });

  it('禁止加载 fs 模块', async () => {
    const code = `
      const fs = require('fs');
      module.exports = async (ctx) => {
        const data = fs.readFileSync('/etc/passwd', 'utf8');
        console.log(data);
      };
    `;
    const result = await executeScript(code, baseContext, 10);
    expect(result.exitCode).toBe(4);
    expect(result.output).toContain('fs');
  });

  it('允许加载 https 模块（调用 API 的核心能力）', async () => {
    const code = `
      const https = require('https');
      module.exports = async (ctx) => {
        // 不实际请求，只验证模块可以加载
        if (typeof https.request !== 'function') {
          throw new Error('https.request 不可用');
        }
        console.log('https 模块可用');
      };
    `;
    const result = await executeScript(code, baseContext, 10);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('https 模块可用');
  });

  it('禁止访问 process.env 中的密钥', async () => {
    const code = `
      module.exports = async (ctx) => {
        // 尝试读取环境变量中的密钥
        const secret = process.env.NEXTAUTH_SECRET;
        console.log('SECRET_CHECK:' + (secret ? 'LEAKED' : 'CLEAN'));
      };
    `;
    const result = await executeScript(code, baseContext, 10);
    expect(result.exitCode).toBe(0);
    // 环境变量已被清理，脚本不应能拿到 NEXTAUTH_SECRET
    expect(result.output).toContain('SECRET_CHECK:CLEAN');
    expect(result.output).not.toContain('SECRET_CHECK:LEAKED');
  });

  it('允许使用 crypto 模块进行签名', async () => {
    const code = `
      const crypto = require('crypto');
      module.exports = async (ctx) => {
        const hmac = crypto.createHmac('sha256', 'test-key').update('test').digest('hex');
        console.log('签名结果: ' + hmac.substring(0, 8));
      };
    `;
    const result = await executeScript(code, baseContext, 10);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('签名结果:');
  });
});

describe('shouldTriggerScript 触发条件判断', () => {
  it('首次检查（prevStatus 为 null）不应触发', () => {
    expect(shouldTriggerScript('both', 0, null)).toBe(false);
    expect(shouldTriggerScript('both', 1, null)).toBe(false);
  });

  it('状态未变化时不应触发', () => {
    expect(shouldTriggerScript('both', 0, 0)).toBe(false);
    expect(shouldTriggerScript('both', 1, 1)).toBe(false);
  });

  it('both 条件下任何状态变化都应触发', () => {
    expect(shouldTriggerScript('both', 0, 1)).toBe(true);
    expect(shouldTriggerScript('both', 1, 0)).toBe(true);
  });

  it('down 条件仅在转为 DOWN 时触发', () => {
    expect(shouldTriggerScript('down', 0, 1)).toBe(true);
    expect(shouldTriggerScript('down', 1, 0)).toBe(false);
  });

  it('up 条件仅在转为 UP 时触发', () => {
    expect(shouldTriggerScript('up', 1, 0)).toBe(true);
    expect(shouldTriggerScript('up', 0, 1)).toBe(false);
  });
});
