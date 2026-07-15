import { Cron } from 'croner';
import { prisma } from '../prisma';
import { checkers } from './index';
import { MONITOR_STATUS, MonitorHttpConfig, MonitorKeywordConfig, MonitorPortConfig, MonitorDatabaseConfig, MonitorPushConfig, MonitorIcmpConfig } from './types';
import { sendStatusChangeNotifications } from './notification-service';

import { generateCompactMessage } from '../utils/compact-message';

// 并发控制配置
const MAX_CONCURRENT_CHECKS = 10; // 最大并发检查数
const CHECK_QUEUE_DELAY = 100; // 队列检查间隔(ms)

// 执行队列和计数器
const activeChecks = new Set<string>();
const pendingChecks = new Map<string, boolean>();

// 限制并发执行检查
async function executeWithConcurrencyLimit(monitorId: string, checkFn: () => Promise<void>) {
  // 如果已经在执行或等待中，跳过
  if (activeChecks.has(monitorId) || pendingChecks.has(monitorId)) {
    console.log(`监控项 ${monitorId} 正在执行或等待中，跳过本次检查`);
    return;
  }

  // 加入等待队列
  pendingChecks.set(monitorId, true);

  // 等待直到可以执行
  while (activeChecks.size >= MAX_CONCURRENT_CHECKS) {
    await new Promise(resolve => setTimeout(resolve, CHECK_QUEUE_DELAY));
  }

  // 从等待队列移除
  pendingChecks.delete(monitorId);

  // 标记为执行中
  activeChecks.add(monitorId);

  try {
    await checkFn();
  } finally {
    // 无论成功或失败，都从执行中集合移除
    activeChecks.delete(monitorId);
  }
}

// 定义监控项数据类型
interface MonitorData {
  id: string;
  type: string;
  active: boolean;
  interval: number;
  config: unknown;
  upsideDown: boolean;
  lastStatus?: number | null;
  name: string;
  retries: number;
  retryInterval: number;
}

// 存储所有监控计划的映射
const monitorJobs = new Map<string, Cron>();

// 用于防止 scheduleMonitor 同一监控项并发执行
const activeScheduleCalls = new Map<string, Promise<boolean>>();

// 添加或更新监控计划
export async function scheduleMonitor(monitorId: string) {
  // 防止同一监控项的 scheduleMonitor 并发执行
  if (activeScheduleCalls.has(monitorId)) {
    console.log(`监控项 ${monitorId} 正在调度中，跳过本次调度请求`);
    return activeScheduleCalls.get(monitorId);
  }

  try {
    // 先取消之前的计划（如果存在）
    if (monitorJobs.has(monitorId)) {
      monitorJobs.get(monitorId)?.stop();
      monitorJobs.delete(monitorId);
    }

    // 获取监控项信息
    const monitor = await prisma.$queryRaw`
      SELECT * FROM "Monitor" WHERE id = ${monitorId}
    `;

    // 由于原始查询返回数组，获取第一个结果
    const monitorData = Array.isArray(monitor) ? monitor[0] as MonitorData : null;

    if (!monitorData) {
      console.error(`监控项 ${monitorId} 不存在`);
      return false;
    }

    // 如果监控项被禁用，则不执行调度
    if (!monitorData.active) {
      return false;
    }

    // 计算下次检查时间
    const nextCheckAt = new Date(Date.now() + monitorData.interval * 1000);

    // 将数据库更新操作也通过队列控制，避免与正在执行的检查产生锁竞争
    await executeWithConcurrencyLimit(`${monitorId}-schedule`, async () => {
      await prisma.$executeRaw`
        UPDATE "Monitor"
        SET "nextCheckAt" = ${nextCheckAt}
        WHERE id = ${monitorId}
      `;
    });

    // 使用Croner创建新的计划任务
    let job;
    if (monitorData.interval <= 60) {
      // 如果间隔小于等于60秒，使用秒级cron表达式
      job = new Cron(`*/${monitorData.interval} * * * * *`, {
        name: `monitor-${monitorId}`,
        protect: true // 防止任务重叠执行
      }, async () => {
        await executeWithConcurrencyLimit(monitorId, async () => {
          try {
            await executeMonitorCheck(monitorId);
          } catch (error) {
            console.error(`监控检查异常 ${monitorId}:`, error);
            // 记录监控失败状态
            await recordMonitorStatus(monitorId, MONITOR_STATUS.DOWN, '监控任务执行异常', null, monitorData.lastStatus || null);
          }
        });
      });
    } else if (monitorData.interval <= 3600) {
      // 如果间隔大于60秒但小于等于3600秒(1小时)，使用分钟级cron表达式
      const intervalMinutes = Math.ceil(monitorData.interval / 60);
      job = new Cron(`0 */${intervalMinutes} * * * *`, {
        name: `monitor-${monitorId}`,
        protect: true // 防止任务重叠执行
      }, async () => {
        await executeWithConcurrencyLimit(monitorId, async () => {
          try {
            await executeMonitorCheck(monitorId);
          } catch (error) {
            console.error(`监控检查异常 ${monitorId}:`, error);
            // 记录监控失败状态
            await recordMonitorStatus(monitorId, MONITOR_STATUS.DOWN, '监控任务执行异常', null, monitorData.lastStatus || null);
          }
        });
      });
    } else {
      // 如果间隔大于3600秒(1小时)
      const HOURS_IN_DAY = 24;
      const totalHours = Math.ceil(monitorData.interval / 3600);
      // 对小时数取模，确保不超过24小时
      const intervalHours = totalHours % HOURS_IN_DAY || HOURS_IN_DAY; // 如果能被24整除，则使用24
      // 生成一个0-59之间的随机数作为分钟数，避免整点负载集中
      const randomMinute = Math.floor(Math.random() * 60);

      job = new Cron(`0 ${randomMinute} */${intervalHours} * * *`, {
        name: `monitor-${monitorId}`,
        protect: true // 防止任务重叠执行
      }, async () => {
        await executeWithConcurrencyLimit(monitorId, async () => {
          try {
            await executeMonitorCheck(monitorId);
          } catch (error) {
            console.error(`监控检查异常 ${monitorId}:`, error);
            // 记录监控失败状态
            await recordMonitorStatus(monitorId, MONITOR_STATUS.DOWN, '监控任务执行异常', null, monitorData.lastStatus || null);
          }
        });
      });
    }

    // 存储计划任务实例
    monitorJobs.set(monitorId, job);

    // 首次检查也通过队列执行，避免阻塞调用方
    setImmediate(() => {
      executeWithConcurrencyLimit(monitorId, async () => {
        try {
          await executeMonitorCheck(monitorId);
        } catch (error) {
          console.error(`初始监控检查异常 ${monitorId}:`, error);
        }
      });
    });

    return true;
  } catch (error) {
    console.error(`调度监控失败 ${monitorId}:`, error);
    return false;
  }
}

// 停止监控计划
export function stopMonitor(monitorId: string): boolean {
  if (monitorJobs.has(monitorId)) {
    monitorJobs.get(monitorId)?.stop();
    monitorJobs.delete(monitorId);
    return true;
  }
  return false;
}

// 重置并重新调度所有激活的监控项
export async function resetAllMonitors() {
  try {
    console.log('开始重置所有监控计划...');

    // 停止所有现有的监控计划
    for (const job of monitorJobs.values()) {
      job.stop();
    }
    monitorJobs.clear();
    console.log('已停止所有现有监控计划');

    // 获取所有激活的监控项
    const activeMonitors = await prisma.$queryRaw`
      SELECT * FROM "Monitor" WHERE active = true
    `;
    const monitors = Array.isArray(activeMonitors) ? activeMonitors as MonitorData[] : [];
    console.log(`找到 ${monitors.length} 个激活的监控项`);

    // 分批次重新调度监控项，避免一次性启动大量任务导致数据库锁竞争
    const BATCH_SIZE = 5; // 每批调度5个
    const BATCH_DELAY = 1000; // 每批之间延迟1秒

    for (let i = 0; i < monitors.length; i += BATCH_SIZE) {
      const batch = monitors.slice(i, i + BATCH_SIZE);
      console.log(`调度第 ${Math.floor(i / BATCH_SIZE) + 1} 批监控项（${batch.length}个）...`);

      // 并行调度当前批次
      await Promise.allSettled(
        batch.map(monitor => scheduleMonitor(monitor.id))
      );

      // 如果不是最后一批，等待一段时间再继续
      if (i + BATCH_SIZE < monitors.length) {
        await new Promise(resolve => setTimeout(resolve, BATCH_DELAY));
      }
    }

    console.log('所有监控项已重新调度');
    return monitors.length;
  } catch (error) {
    console.error('重置监控计划失败:', error);
    return 0;
  }
}

// 执行监控检查
async function executeMonitorCheck(monitorId: string) {
  // 获取监控项信息
  const monitor = await prisma.$queryRaw`
    SELECT * FROM "Monitor" WHERE id = ${monitorId}
  `;

  // 由于原始查询返回数组，获取第一个结果
  const monitorData = Array.isArray(monitor) ? monitor[0] as MonitorData : null;

  if (!monitorData || !monitorData.active) {
    return;
  }

  let status = MONITOR_STATUS.DOWN;
  let message = '';
  let ping: number | null = null;

  try {
    // 对于 Push 类型监控，特殊处理
    if (monitorData.type === 'push') {
      // 获取最新状态
      const latestStatuses = await prisma.$queryRaw`
        SELECT * FROM "MonitorStatus" 
        WHERE "monitorId" = ${monitorId} 
        ORDER BY "timestamp" DESC 
        LIMIT 2
      `;
      
      // 获取 Push 配置
      const config = monitorData.config as unknown as MonitorPushConfig;
      
      // 检查最后推送时间是否在有效期内
      const lastPushTime = config.lastPushTime ? new Date(config.lastPushTime).getTime() : 0;
      const currentTime = Date.now();
      const interval = (config.pushInterval || 60) * 1000; // 秒转毫秒
      
      // 如果最后推送时间在允许的时间间隔内，则认为服务正常（状态为UP）
      const isPushValid = lastPushTime && (currentTime - lastPushTime) <= interval;
      const newStatus = isPushValid ? MONITOR_STATUS.UP : MONITOR_STATUS.DOWN;
      
      // 获取前两次状态
      const lastStatus = Array.isArray(latestStatuses) && latestStatuses.length > 0 ? 
                          latestStatuses[0].status : null;
      const secondLastStatus = Array.isArray(latestStatuses) && latestStatuses.length > 1 ? 
                          latestStatuses[1].status : null;
      
      // 对于 Push 类型，只有以下情况才记录状态和发送通知：
      // 1. 当前状态为失败（DOWN）
      // 2. 当前状态为成功（UP），且上一次状态为失败（DOWN）- 即从失败恢复为成功
      // 3. 当前状态为成功（UP），上一次状态也是成功（UP），但上上次是失败（DOWN）- 初次恢复后状态检查
      if (newStatus === MONITOR_STATUS.DOWN) {
        // 失败状态，记录并发送通知
        message = `推送超时: 最后推送时间 ${lastPushTime ? new Date(lastPushTime).toLocaleString() : '未知'}`;
        await recordMonitorStatus(monitorId, newStatus, message, null, lastStatus);
      } else if (newStatus === MONITOR_STATUS.UP && lastStatus === MONITOR_STATUS.DOWN) {
        // 从失败恢复为成功，发送恢复通知
        message = `推送恢复正常: 最后推送时间 ${new Date(lastPushTime).toLocaleString()}`;
        
        // 手动发送恢复通知，不记录新状态
        await sendStatusChangeNotifications(monitorId, newStatus, message, MONITOR_STATUS.DOWN);
        // 触发自定义脚本动作（Push 恢复路径不走 recordMonitorStatus，需单独触发）
        await triggerScriptActionAsync(monitorId, newStatus, message, MONITOR_STATUS.DOWN);
      } else if (newStatus === MONITOR_STATUS.UP && lastStatus === MONITOR_STATUS.UP && secondLastStatus === MONITOR_STATUS.DOWN) {
        // 特殊情况：当前和上次都是成功，但上上次是失败 - 说明之前从失败恢复为成功但没发通知
        message = `推送恢复正常: 最后推送时间 ${new Date(lastPushTime).toLocaleString()}`;
        
        // 手动发送恢复通知，不记录新状态
        await sendStatusChangeNotifications(monitorId, newStatus, message, MONITOR_STATUS.DOWN);
        // 触发自定义脚本动作（Push 恢复路径不走 recordMonitorStatus，需单独触发）
        await triggerScriptActionAsync(monitorId, newStatus, message, MONITOR_STATUS.DOWN);
      }
      
      // 更新监控项状态
      const lastCheckAt = new Date();
      const nextCheckAt = new Date(lastCheckAt.getTime() + monitorData.interval * 1000);
      
      await prisma.$executeRaw`
        UPDATE "Monitor" 
        SET "lastCheckAt" = ${lastCheckAt}, 
            "nextCheckAt" = ${nextCheckAt}, 
            "lastStatus" = ${newStatus}
        WHERE id = ${monitorId}
      `;
      
      return; // 返回，不执行下面的常规检查逻辑
    }
    
    // 对于非 Push 类型，执行常规检查
    let checkResult: { status: number; message: string; ping: number | null } | null = null;

    // 执行检查（包含重试逻辑）
    const maxAttempts = (monitorData.retries || 0) + 1; // 重试次数 + 1次原始检查
    let lastError: string = '';

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        // 如果不是第一次尝试，等待重试间隔
        if (attempt > 0) {
          await new Promise(resolve => setTimeout(resolve, (monitorData.retryInterval || 60) * 1000));
        }

        switch (monitorData.type) {
          case 'http':
            // 为HTTP检查添加监控ID和名称，支持证书通知功能
            const httpConfig = {
              ...(monitorData.config as unknown as MonitorHttpConfig),
              monitorId: monitorData.id,
              monitorName: monitorData.name,
              retries: 0, // 在调度器层面处理重试，检查器不需要重试
              retryInterval: 60
            };
            const httpResult = await checkers.http(httpConfig);
            checkResult = { status: httpResult.status, message: httpResult.message, ping: httpResult.ping };
            break;
          case 'keyword':
            const keywordConfig = {
              ...(monitorData.config as unknown as MonitorKeywordConfig),
              retries: 0, // 在调度器层面处理重试，检查器不需要重试
              retryInterval: 60
            };
            const keywordResult = await checkers.keyword(keywordConfig);
            checkResult = { status: keywordResult.status, message: keywordResult.message, ping: keywordResult.ping };
            break;
          case 'https-cert':
            // 为证书检查添加监控ID和名称，用于定时通知
            const certConfig = {
              ...(monitorData.config as unknown as MonitorHttpConfig),
              monitorId: monitorData.id,
              monitorName: monitorData.name,
              retries: 0, // 在调度器层面处理重试，检查器不需要重试
              retryInterval: 60
            };
            const certResult = await checkers["https-cert"](certConfig);
            checkResult = { status: certResult.status, message: certResult.message, ping: certResult.ping };
            break;
          case 'port':
            const portConfig = {
              ...(monitorData.config as unknown as MonitorPortConfig),
              retries: 0, // 在调度器层面处理重试，检查器不需要重试
              retryInterval: 60
            };
            const portResult = await checkers.port(portConfig);
            checkResult = { status: portResult.status, message: portResult.message, ping: portResult.ping };
            break;
          case 'mysql':
          case 'redis':
            const dbConfig = {
              ...(monitorData.config as unknown as MonitorDatabaseConfig),
              retries: 0, // 在调度器层面处理重试，检查器不需要重试
              retryInterval: 60
            };
            const dbResult = await checkers.database(monitorData.type, dbConfig);
            checkResult = { status: dbResult.status, message: dbResult.message, ping: dbResult.ping };
            break;
          case 'icmp':
            const icmpConfig = {
              ...(monitorData.config as unknown as MonitorIcmpConfig),
              retries: 0, // 在调度器层面处理重试，检查器不需要重试
              retryInterval: 60
            };
            const icmpResult = await checkers.icmp(icmpConfig);
            checkResult = { status: icmpResult.status, message: icmpResult.message, ping: icmpResult.ping };
            break;
          default:
            checkResult = { status: MONITOR_STATUS.DOWN, message: `不支持的监控类型: ${monitorData.type}`, ping: null };
        }

        // 如果检查成功，跳出重试循环
        if (checkResult && checkResult.status === MONITOR_STATUS.UP) {
          // 如果是重试成功，更新消息
          if (attempt > 0) {
            checkResult.message = `重试成功 (${attempt}/${monitorData.retries || 0}): ${checkResult.message}`;
          }
          break;
        }

        // 记录失败信息，但不跳出循环（继续重试）
        if (checkResult) {
          lastError = checkResult.message;
        }
      } catch (error) {
        console.error(`监控检查失败 ${monitorId} (尝试 ${attempt + 1}/${maxAttempts}):`, error);
        lastError = `监控检查异常: ${(error instanceof Error) ? error.message : '未知错误'}`;
        checkResult = { status: MONITOR_STATUS.DOWN, message: lastError, ping: null };
      }
    }

    // 设置最终结果
    if (checkResult) {
      status = checkResult.status;
      message = checkResult.message;
      ping = checkResult.ping;
      
      // 如果所有重试都失败了，更新消息
      if (status === MONITOR_STATUS.DOWN && maxAttempts > 1) {
        message = `重试${monitorData.retries || 0}次后仍然失败: ${lastError}`;
      }
    } else {
      // 如果没有检查结果，设置为失败状态
      status = MONITOR_STATUS.DOWN;
      message = lastError || '监控检查失败';
      ping = null;
    }
  } catch (error) {
    console.error(`监控检查失败 ${monitorId}:`, error);
    message = `监控检查异常: ${(error instanceof Error) ? error.message : '未知错误'}`;
  }

  // 考虑反转状态选项
  if (monitorData.upsideDown) {
    status = status === MONITOR_STATUS.UP ? MONITOR_STATUS.DOWN : MONITOR_STATUS.UP;
  }

  // 记录监控状态
  // 注意：必须用 ?? 而非 ||，否则 DOWN(0) 的 lastStatus 会被错误地吞成 null，
  // 导致传给通知服务的 prevStatus 失真。
  const effectivePrevStatus = monitorData.lastStatus ?? null;
  await recordMonitorStatus(monitorId, status, message, ping, effectivePrevStatus);

  // 更新最后检查时间和下次检查时间
  const lastCheckAt = new Date();
  const nextCheckAt = new Date(lastCheckAt.getTime() + monitorData.interval * 1000);
  
  await prisma.$executeRaw`
    UPDATE "Monitor" 
    SET "lastCheckAt" = ${lastCheckAt}, 
        "nextCheckAt" = ${nextCheckAt}, 
        "lastStatus" = ${status}
    WHERE id = ${monitorId}
  `;
}

// 记录监控状态历史
async function recordMonitorStatus(
  monitorId: string, 
  status: number, 
  message: string, 
  ping: number | null,
  prevStatus: number | null
) {
  // 使用紧凑消息策略：正常状态存储null，错误状态保留详细信息
  const compactMessage = generateCompactMessage(status, message, ping || undefined);
  
  // 使用Prisma的create方法，让数据库自动生成UUID
  await prisma.monitorStatus.create({
    data: {
      monitorId,
      status,
      message: compactMessage,
      ping,
      timestamp: new Date()
    }
  });

  // 触发状态变更通知时使用原始消息
  try {
    await sendStatusChangeNotifications(monitorId, status, message, prevStatus);
  } catch (error) {
    console.error(`发送监控 ${monitorId} 状态变更通知失败:`, error);
    // 通知发送失败不影响监控状态记录
  }

  // 触发自定义脚本动作（异步执行，不阻塞监控检查的并发槽位）
  triggerScriptActionAsync(monitorId, status, message, prevStatus);
} 

/**
 * 异步触发自定义脚本动作。
 * 使用 setImmediate 将脚本执行脱离监控检查的并发槽位，
 * 避免慢脚本阻塞调度器导致其他监控检查被饿死。
 */
function triggerScriptActionAsync(
  monitorId: string,
  status: number,
  message: string,
  prevStatus: number | null
) {
  setImmediate(async () => {
    try {
      const { triggerScriptAction } = await import('./script-action-service');
      await triggerScriptAction(monitorId, status, message, prevStatus);
    } catch (error) {
      console.error(`触发监控 ${monitorId} 的自定义脚本动作失败:`, error);
    }
  });
} 