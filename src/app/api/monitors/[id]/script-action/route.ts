import { NextResponse } from 'next/server';
import { validateMonitorOwnership } from '@/lib/auth-helpers';
import {
  getScriptAction,
  saveScriptAction,
  TriggerCondition,
} from '@/lib/monitors/script-action-service';

// GET /api/monitors/[id]/script-action - 获取脚本动作配置
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const authError = await validateMonitorOwnership(id);
    if (authError) return authError;

    const action = await getScriptAction(id);
    return NextResponse.json(action);
  } catch (error) {
    console.error('获取脚本动作配置失败:', error);
    return NextResponse.json(
      { error: '获取脚本动作配置失败' },
      { status: 500 }
    );
  }
}

// PUT /api/monitors/[id]/script-action - 保存脚本动作配置
export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const authError = await validateMonitorOwnership(id);
    if (authError) return authError;

    const data = await request.json();

    // 校验触发条件
    const validConditions: TriggerCondition[] = ['down', 'up', 'both'];
    if (
      data.triggerCondition !== undefined &&
      !validConditions.includes(data.triggerCondition)
    ) {
      return NextResponse.json(
        { error: '触发条件无效，可选值：down、up、both' },
        { status: 400 }
      );
    }

    // 校验超时时间
    if (
      data.timeout !== undefined &&
      (typeof data.timeout !== 'number' || data.timeout < 1 || data.timeout > 600)
    ) {
      return NextResponse.json(
        { error: '超时时间必须在 1-600 秒之间' },
        { status: 400 }
      );
    }

    const action = await saveScriptAction(id, {
      enabled: data.enabled,
      script: data.script,
      triggerCondition: data.triggerCondition as TriggerCondition | undefined,
      timeout: data.timeout,
    });

    return NextResponse.json({
      message: '脚本动作配置保存成功',
      action,
    });
  } catch (error) {
    console.error('保存脚本动作配置失败:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '保存脚本动作配置失败' },
      { status: 500 }
    );
  }
}
