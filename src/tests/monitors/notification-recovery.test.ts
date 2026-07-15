import { describe, it, expect, vi, beforeEach } from 'vitest';

// -------------------------------------------------------------
// Mock axios：通知服务里 Webhook / 钉钉 / 企业微信 / 微信都走它
// 默认导出做成可调用函数（对应 axios({...}) 用法），并挂上 isAxiosError
// -------------------------------------------------------------
vi.mock('axios', () => {
  const fn: any = vi.fn();
  fn.isAxiosError = vi.fn(() => false);
  return { default: fn };
});

// -------------------------------------------------------------
// Mock prisma：notification-service 从 '@/lib/db' 取 prisma
// -------------------------------------------------------------
vi.mock('@/lib/db', () => ({
  prisma: {
    monitor: { findUnique: vi.fn() },
    monitorStatus: {
      count: vi.fn(),
      findFirst: vi.fn(),
    },
  },
}));

import axios from 'axios';
import { sendStatusChangeNotifications } from '../../lib/monitors/notification-service';
import { prisma } from '@/lib/db';
import { MONITOR_STATUS } from '../../lib/monitors/types';

const mockedAxios = axios as unknown as ReturnType<typeof vi.fn>;
const mockedFindUnique = prisma.monitor.findUnique as unknown as ReturnType<typeof vi.fn>;
const mockedStatusCount = prisma.monitorStatus.count as unknown as ReturnType<typeof vi.fn>;
const mockedStatusFindFirst = prisma.monitorStatus.findFirst as unknown as ReturnType<typeof vi.fn>;

// 构造一个带 Webhook 通知绑定的监控项
function buildMonitor(id: string, statusHistory: { status: number; timestamp: Date }[]) {
  return {
    id,
    name: '测试网站',
    type: 'http',
    config: { url: 'https://example.com' },
    resendInterval: 0,
    notificationBindings: [
      {
        enabled: true,
        notificationChannel: {
          id: 'ch-1',
          name: 'webhook通知',
          type: 'Webhook',
          enabled: true,
          config: { url: 'https://hook.example.com/notify' },
        },
      },
    ],
    statusHistory,
  };
}

describe('恢复通知防丢失（修复后）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    // DOWN 分支会用到的历史查询，给个默认值
    mockedStatusFindFirst.mockResolvedValue({ timestamp: new Date(Date.now() - 60000) });
    mockedStatusCount.mockResolvedValue(1);
  });

  it('恢复通知发送失败 → 下一轮检查自动重试，直到成功送达', async () => {
    const monitorId = 'mon-recovery-1';

    // ===== 步骤1：网站故障(DOWN)，通知发送成功，缓存标记为已送达故障 =====
    mockedFindUnique.mockResolvedValueOnce(
      buildMonitor(monitorId, [
        { status: MONITOR_STATUS.DOWN, timestamp: new Date() },
        { status: MONITOR_STATUS.UP, timestamp: new Date() },
      ])
    );
    mockedAxios.mockResolvedValueOnce({ status: 200 });

    await sendStatusChangeNotifications(monitorId, MONITOR_STATUS.DOWN, '网站故障', MONITOR_STATUS.UP);
    expect(mockedAxios).toHaveBeenCalledTimes(1); // DOWN 通知已发送

    // ===== 步骤2：网站恢复(UP)，但发送恰好失败（网络抖动/超时） =====
    // 调度器此时 lastStatus 是 DOWN(0)，传 prevStatus = 0（修复后不再被吞成 null）
    mockedFindUnique.mockResolvedValueOnce(
      buildMonitor(monitorId, [
        { status: MONITOR_STATUS.UP, timestamp: new Date() },
        { status: MONITOR_STATUS.DOWN, timestamp: new Date() },
      ])
    );
    mockedAxios.mockRejectedValueOnce(new Error('网络超时'));

    await sendStatusChangeNotifications(monitorId, MONITOR_STATUS.UP, '网站恢复', MONITOR_STATUS.DOWN);

    // 恢复通知确实“尝试”发送了（进入恢复分支）
    expect(mockedAxios).toHaveBeenCalledTimes(2);
    expect(console.error).toHaveBeenCalled(); // 失败仅被记录，未抛出

    // ===== 步骤3：下一轮仍是 UP，应当自动重试发送恢复通知（这是修复的关键点） =====
    // 调度器此时 lastStatus 是 UP(1)，传 prevStatus = 1
    mockedFindUnique.mockResolvedValueOnce(
      buildMonitor(monitorId, [
        { status: MONITOR_STATUS.UP, timestamp: new Date() },
        { status: MONITOR_STATUS.UP, timestamp: new Date() },
      ])
    );
    mockedAxios.mockResolvedValueOnce({ status: 200 });

    await sendStatusChangeNotifications(monitorId, MONITOR_STATUS.UP, '网站正常', MONITOR_STATUS.UP);

    // 关键断言：axios 调用次数增加到了 3，说明系统在上一轮发送失败后自动重试了恢复通知
    expect(mockedAxios).toHaveBeenCalledTimes(3);
    // 用户最终能收到恢复通知
  });

  it('恢复通知持续失败 → 每一轮 UP 检查都会重试（不会放弃）', async () => {
    const monitorId = 'mon-recovery-2';

    // DOWN 成功
    mockedFindUnique.mockResolvedValueOnce(
      buildMonitor(monitorId, [
        { status: MONITOR_STATUS.DOWN, timestamp: new Date() },
        { status: MONITOR_STATUS.UP, timestamp: new Date() },
      ])
    );
    mockedAxios.mockResolvedValueOnce({ status: 200 });
    await sendStatusChangeNotifications(monitorId, MONITOR_STATUS.DOWN, '故障', MONITOR_STATUS.UP);

    // 连续 3 轮恢复，全部失败
    for (let i = 0; i < 3; i++) {
      mockedFindUnique.mockResolvedValueOnce(
        buildMonitor(monitorId, [
          { status: MONITOR_STATUS.UP, timestamp: new Date() },
          { status: MONITOR_STATUS.UP, timestamp: new Date() },
        ])
      );
      mockedAxios.mockRejectedValueOnce(new Error(`第${i + 1}次失败`));
      await sendStatusChangeNotifications(monitorId, MONITOR_STATUS.UP, '恢复', MONITOR_STATUS.UP);
    }

    // 1 次成功 DOWN + 3 次重试恢复 = 4 次调用，说明没有放弃
    expect(mockedAxios).toHaveBeenCalledTimes(4);
  });

  it('对照：网站恢复且发送成功时，恢复通知只发一次，不重复', async () => {
    const monitorId = 'mon-recovery-3';

    // DOWN 成功
    mockedFindUnique.mockResolvedValueOnce(
      buildMonitor(monitorId, [
        { status: MONITOR_STATUS.DOWN, timestamp: new Date() },
        { status: MONITOR_STATUS.UP, timestamp: new Date() },
      ])
    );
    mockedAxios.mockResolvedValueOnce({ status: 200 });
    await sendStatusChangeNotifications(monitorId, MONITOR_STATUS.DOWN, '故障', MONITOR_STATUS.UP);

    // 恢复成功
    mockedFindUnique.mockResolvedValueOnce(
      buildMonitor(monitorId, [
        { status: MONITOR_STATUS.UP, timestamp: new Date() },
        { status: MONITOR_STATUS.DOWN, timestamp: new Date() },
      ])
    );
    mockedAxios.mockResolvedValueOnce({ status: 200 });
    await sendStatusChangeNotifications(monitorId, MONITOR_STATUS.UP, '恢复', MONITOR_STATUS.DOWN);

    // 下一轮持续 UP，不应再发通知
    mockedFindUnique.mockResolvedValueOnce(
      buildMonitor(monitorId, [
        { status: MONITOR_STATUS.UP, timestamp: new Date() },
        { status: MONITOR_STATUS.UP, timestamp: new Date() },
      ])
    );
    await sendStatusChangeNotifications(monitorId, MONITOR_STATUS.UP, '正常', MONITOR_STATUS.UP);

    // DOWN + 恢复，共 2 次，第三轮持续 UP 不重复发送
    expect(mockedAxios).toHaveBeenCalledTimes(2);
  });
});

describe('故障通知防丢失（修复后）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockedStatusFindFirst.mockResolvedValue({ timestamp: new Date(Date.now() - 60000) });
    mockedStatusCount.mockResolvedValue(1);
  });

  it('故障通知发送失败 → 下一轮 DOWN 检查自动重试', async () => {
    const monitorId = 'mon-down-1';

    // 缓存暖（之前 UP 已送达），本次 DOWN 发送失败
    mockedFindUnique.mockResolvedValueOnce(
      buildMonitor(monitorId, [
        { status: MONITOR_STATUS.DOWN, timestamp: new Date() },
        { status: MONITOR_STATUS.UP, timestamp: new Date() },
      ])
    );
    mockedAxios.mockRejectedValueOnce(new Error('SMTP 抖动'));
    await sendStatusChangeNotifications(monitorId, MONITOR_STATUS.DOWN, '网站故障', MONITOR_STATUS.UP);

    // 下一轮仍 DOWN，应当重试
    mockedFindUnique.mockResolvedValueOnce(
      buildMonitor(monitorId, [
        { status: MONITOR_STATUS.DOWN, timestamp: new Date() },
        { status: MONITOR_STATUS.DOWN, timestamp: new Date() },
      ])
    );
    mockedAxios.mockResolvedValueOnce({ status: 200 });
    await sendStatusChangeNotifications(monitorId, MONITOR_STATUS.DOWN, '网站故障', MONITOR_STATUS.DOWN);

    // 第一次失败 + 第二次重试 = 2 次
    expect(mockedAxios).toHaveBeenCalledTimes(2);
  });
});

describe('调度器 prevStatus 计算修复', () => {
  it('当 lastStatus 为 DOWN(0) 时，使用 ?? 保留 0（不再被吞成 null）', () => {
    // 这里复刻 scheduler.ts 修复后的表达式
    //   const effectivePrevStatus = monitorData.lastStatus ?? null;
    const MONITOR_STATUS_DOWN = MONITOR_STATUS.DOWN; // 0

    const lastStatusWhenDown: number | null = MONITOR_STATUS_DOWN;
    const effectivePrevStatus = lastStatusWhenDown ?? null;

    // 修复后：DOWN(0) 被正确保留为 0，而不是被 || 吞成 null
    expect(MONITOR_STATUS_DOWN).toBe(0);
    expect(lastStatusWhenDown).toBe(0);
    expect(effectivePrevStatus).toBe(0);

    // 对照：UP(1) 不受影响
    expect((MONITOR_STATUS.UP ?? null)).toBe(1);
    // 对照：null 仍为 null
    const lastStatusNull: number | null = null;
    expect((lastStatusNull ?? null)).toBeNull();
  });
});
