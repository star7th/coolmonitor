import { NextResponse } from 'next/server';
import { validateMonitorOwnership } from '@/lib/auth-helpers';
import { simulateScriptAction } from '@/lib/monitors/script-action-service';

// POST /api/monitors/[id]/script-action/test - 模拟运行脚本
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const authError = await validateMonitorOwnership(id);
    if (authError) return authError;

    const data = await request.json();

    // 模拟状态：1=UP, 0=DOWN
    const simulatedStatus = data.simulatedStatus === 1 ? 1 : 0;
    // 可选传入临时脚本进行测试（未保存的草稿）
    const scriptOverride =
      typeof data.script === 'string' ? data.script : undefined;

    const result = await simulateScriptAction(id, simulatedStatus, scriptOverride);

    return NextResponse.json({
      message: '模拟运行完成',
      result,
    });
  } catch (error) {
    console.error('模拟运行脚本失败:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '模拟运行脚本失败' },
      { status: 500 }
    );
  }
}
