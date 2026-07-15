import { NextRequest, NextResponse } from 'next/server';
import { validateMonitorOwnership } from '@/lib/auth-helpers';
import { getScriptExecutions } from '@/lib/monitors/script-action-service';

// GET /api/monitors/[id]/script-action/history - 获取脚本执行历史
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const authError = await validateMonitorOwnership(id);
    if (authError) return authError;

    const { searchParams } = new URL(request.url);
    const limit = parseInt(searchParams.get('limit') || '50');

    const executions = await getScriptExecutions(id, limit);
    return NextResponse.json(executions);
  } catch (error) {
    console.error('获取脚本执行历史失败:', error);
    return NextResponse.json(
      { error: '获取脚本执行历史失败' },
      { status: 500 }
    );
  }
}
