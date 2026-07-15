import { prisma } from '@/lib/prisma';
import { executeScript, ScriptContext, ScriptRunResult } from './script-runner';
import { formatDateTime } from './utils';

/**
 * 自定义脚本动作服务
 * 负责脚本动作配置的增删改查、状态变更触发、模拟运行以及执行历史记录。
 */

export type TriggerCondition = 'down' | 'up' | 'both';
export type TriggerSource = 'real' | 'simulate';

export interface ScriptActionData {
  id: string;
  monitorId: string;
  enabled: boolean;
  script: string;
  triggerCondition: TriggerCondition;
  timeout: number;
  createdAt: string;
  updatedAt: string;
}

export interface ScriptExecutionData {
  id: string;
  exitCode: number | null;
  output: string;
  durationMs: number;
  success: boolean;
  timedOut: boolean;
  triggerSource: TriggerSource;
  currentStatus: number;
  prevStatus: number | null;
  errorMessage: string | null;
  createdAt: string;
}

// 默认脚本模板
export const DEFAULT_SCRIPT_TEMPLATE = `// 状态变化时执行的脚本
// coolmonitor 会调用你导出的 async 函数，并传入上下文 ctx
//
// ctx 包含字段：
//   monitorId      监控项 ID
//   monitorName    监控项名称
//   monitorType    监控项类型
//   url            监控地址（如有）
//   status         当前状态："UP" 或 "DOWN"
//   statusCode     当前状态码：1=正常 0=异常
//   prevStatus     上一次状态："UP" / "DOWN" / null
//   message        状态描述信息
//   timestamp      触发时间（ISO 字符串）

module.exports = async (ctx) => {
  console.log(\`[\${ctx.monitorName}] 状态变更为 \${ctx.status}\`);
  console.log(\`描述: \${ctx.message}\`);

  // 在这里编写你的自动化逻辑，例如：
  // - 切换 DNS 记录
  // - 重启服务
  // - 调用外部 API
};
`;

/**
 * 将状态码转换为可读字符串
 */
function statusToText(status: number | null | undefined): string | null {
  if (status === null || status === undefined) return null;
  return status === 1 ? 'UP' : 'DOWN';
}

/**
 * 根据触发条件与状态变化判断是否应该执行脚本
 */
export function shouldTriggerScript(
  triggerCondition: TriggerCondition,
  status: number,
  prevStatus: number | null
): boolean {
  // 没有上一次状态（首次检查），不视为状态变化
  if (prevStatus === null || prevStatus === undefined) return false;
  // 状态未变化，不触发
  if (status === prevStatus) return false;

  switch (triggerCondition) {
    case 'down':
      return status === 0; // 转为异常
    case 'up':
      return status === 1; // 转为正常
    case 'both':
    default:
      return true;
  }
}

/**
 * 根据监控项配置构建脚本上下文
 */
function buildContext(
  monitor: {
    id: string;
    name: string;
    type: string;
    config: unknown;
  },
  status: number,
  message: string,
  prevStatus: number | null
): ScriptContext {
  const context: ScriptContext = {
    monitorId: monitor.id,
    monitorName: monitor.name,
    monitorType: monitor.type,
    status: statusToText(status) || 'UNKNOWN',
    statusCode: status,
    prevStatus: statusToText(prevStatus),
    prevStatusCode: prevStatus,
    message: message || '',
    timestamp: new Date().toISOString(),
  };

  // 从监控配置中提取地址信息
  try {
    const config = (monitor.config || {}) as Record<string, unknown>;
    if (config.url) {
      context.url = String(config.url);
    } else if (config.hostname) {
      context.hostname = String(config.hostname);
      if (config.port !== undefined && config.port !== null) {
        context.port = config.port as string | number;
      }
    }
  } catch {
    // 忽略配置解析异常
  }

  return context;
}

/**
 * 获取监控项的脚本动作配置（不存在时自动创建默认配置）
 * 注意：会先校验监控项是否存在，避免产生孤立记录
 */
export async function getScriptAction(monitorId: string): Promise<ScriptActionData> {
  // 校验监控项存在，避免在已删除/错误的 monitorId 上创建孤立记录
  const monitor = await prisma.monitor.findUnique({ where: { id: monitorId } });
  if (!monitor) {
    throw new Error('监控项不存在');
  }

  let action = await prisma.scriptAction.findUnique({
    where: { monitorId },
  });

  if (!action) {
    // 自动创建默认配置
    action = await prisma.scriptAction.create({
      data: {
        monitorId,
        enabled: false,
        script: DEFAULT_SCRIPT_TEMPLATE,
        triggerCondition: 'both',
        timeout: 30,
      },
    });
  }

  return {
    id: action.id,
    monitorId: action.monitorId,
    enabled: action.enabled,
    script: action.script,
    triggerCondition: action.triggerCondition as TriggerCondition,
    timeout: action.timeout,
    createdAt: action.createdAt.toISOString(),
    updatedAt: action.updatedAt.toISOString(),
  };
}

/**
 * 保存（更新或创建）脚本动作配置
 */
export async function saveScriptAction(
  monitorId: string,
  data: {
    enabled?: boolean;
    script?: string;
    triggerCondition?: TriggerCondition;
    timeout?: number;
  }
): Promise<ScriptActionData> {
  // 确保监控项存在
  const monitor = await prisma.monitor.findUnique({ where: { id: monitorId } });
  if (!monitor) {
    throw new Error('监控项不存在');
  }

  const existing = await prisma.scriptAction.findUnique({ where: { monitorId } });

  const payload = {
    enabled: data.enabled,
    script: data.script,
    triggerCondition: data.triggerCondition,
    timeout:
      data.timeout !== undefined
        ? Math.max(1, Math.min(Number(data.timeout) || 30, 600))
        : undefined,
  };

  if (existing) {
    const updated = await prisma.scriptAction.update({
      where: { monitorId },
      data: payload as Record<string, unknown>,
    });
    return {
      id: updated.id,
      monitorId: updated.monitorId,
      enabled: updated.enabled,
      script: updated.script,
      triggerCondition: updated.triggerCondition as TriggerCondition,
      timeout: updated.timeout,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    };
  }

  const created = await prisma.scriptAction.create({
    data: {
      monitorId,
      enabled: data.enabled ?? false,
      script: data.script ?? DEFAULT_SCRIPT_TEMPLATE,
      triggerCondition: data.triggerCondition ?? 'both',
      timeout: payload.timeout ?? 30,
    },
  });

  return {
    id: created.id,
    monitorId: created.monitorId,
    enabled: created.enabled,
    script: created.script,
    triggerCondition: created.triggerCondition as TriggerCondition,
    timeout: created.timeout,
    createdAt: created.createdAt.toISOString(),
    updatedAt: created.updatedAt.toISOString(),
  };
}

/**
 * 记录一次脚本执行结果
 */
async function recordExecution(
  scriptActionId: string,
  currentStatus: number,
  prevStatus: number | null,
  triggerSource: TriggerSource,
  result: ScriptRunResult
): Promise<ScriptExecutionData> {
  const execution = await prisma.scriptExecution.create({
    data: {
      scriptActionId,
      exitCode: result.exitCode,
      output: result.output,
      durationMs: result.durationMs,
      success: result.success,
      timedOut: result.timedOut,
      triggerSource,
      currentStatus,
      prevStatus,
      errorMessage: result.errorMessage ?? null,
    },
  });

  return {
    id: execution.id,
    exitCode: execution.exitCode,
    output: execution.output,
    durationMs: execution.durationMs,
    success: execution.success,
    timedOut: execution.timedOut,
    triggerSource: execution.triggerSource as TriggerSource,
    currentStatus: execution.currentStatus,
    prevStatus: execution.prevStatus,
    errorMessage: execution.errorMessage,
    createdAt: execution.createdAt.toISOString(),
  };
}

/**
 * 执行脚本并记录结果（真实触发与模拟运行的共用核心）
 * @param action 已查询到的脚本动作记录，避免重复查询导致 TOCTOU 漂移
 */
async function runAndRecord(
  action: { id: string; script: string; timeout: number },
  monitorId: string,
  status: number,
  message: string,
  prevStatus: number | null,
  triggerSource: TriggerSource,
  scriptOverride?: string
): Promise<ScriptExecutionData | null> {
  const monitor = await prisma.monitor.findUnique({ where: { id: monitorId } });
  if (!monitor) {
    return null;
  }

  const context = buildContext(monitor, status, message, prevStatus);
  const code = scriptOverride !== undefined ? scriptOverride : action.script;

  let result: ScriptRunResult;
  try {
    result = await executeScript(code, context, action.timeout);
  } catch (error) {
    result = {
      exitCode: null,
      output: '',
      durationMs: 0,
      timedOut: false,
      success: false,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }

  return recordExecution(action.id, status, prevStatus, triggerSource, result);
}

/**
 * 在监控状态变化时触发脚本动作（由调度器调用）
 */
export async function triggerScriptAction(
  monitorId: string,
  status: number,
  message: string,
  prevStatus: number | null
): Promise<void> {
  try {
    const action = await prisma.scriptAction.findUnique({
      where: { monitorId },
    });

    // 未配置或未启用则跳过
    if (!action || !action.enabled) {
      return;
    }

    // 校验触发条件
    const triggerCondition = action.triggerCondition as TriggerCondition;
    if (!shouldTriggerScript(triggerCondition, status, prevStatus)) {
      return;
    }

    console.log(`[脚本动作] 监控 ${monitorId} 状态变化触发脚本（${statusToText(prevStatus)} -> ${statusToText(status)}）`);

    // 传入已查询的 action，避免重复查询导致的快照漂移
    await runAndRecord(action, monitorId, status, message, prevStatus, 'real');
  } catch (error) {
    console.error(`[脚本动作] 触发监控 ${monitorId} 的脚本失败:`, error);
  }
}

/**
 * 模拟运行脚本（用于调试），可选传入临时脚本覆盖已保存的脚本
 */
export async function simulateScriptAction(
  monitorId: string,
  simulatedStatus: number,
  scriptOverride?: string
): Promise<ScriptExecutionData> {
  // 获取或创建脚本动作，以便记录执行历史
  const actionData = await getScriptAction(monitorId);

  // 模拟时，上一次状态取反，构造一次真实的状态变化
  const prevStatus = simulatedStatus === 1 ? 0 : 1;

  const result = await runAndRecord(
    actionData,
    monitorId,
    simulatedStatus,
    `模拟运行：${simulatedStatus === 1 ? '服务正常' : '服务故障'}（${formatDateTime()}）`,
    prevStatus,
    'simulate',
    scriptOverride
  );

  if (!result) {
    throw new Error('无法执行模拟运行');
  }

  return result;
}

/**
 * 获取脚本执行历史
 */
export async function getScriptExecutions(
  monitorId: string,
  limit: number = 50
): Promise<ScriptExecutionData[]> {
  const action = await prisma.scriptAction.findUnique({
    where: { monitorId },
  });

  if (!action) {
    return [];
  }

  const executions = await prisma.scriptExecution.findMany({
    where: { scriptActionId: action.id },
    orderBy: { createdAt: 'desc' },
    take: Math.max(1, Math.min(limit, 200)),
  });

  return executions.map((e) => ({
    id: e.id,
    exitCode: e.exitCode,
    output: e.output,
    durationMs: e.durationMs,
    success: e.success,
    timedOut: e.timedOut,
    triggerSource: e.triggerSource as TriggerSource,
    currentStatus: e.currentStatus,
    prevStatus: e.prevStatus,
    errorMessage: e.errorMessage,
    createdAt: e.createdAt.toISOString(),
  }));
}
