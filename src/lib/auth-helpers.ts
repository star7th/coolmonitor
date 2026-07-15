import { getServerSession } from 'next-auth';
import { buildAuthOptions } from '@/app/api/auth/[...nextauth]/route';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

/**
 * 检查用户是否已登录的辅助函数
 * @returns 如果用户已登录返回true，否则返回false
 */
export async function isAuthenticated() {
  const authOptions = await buildAuthOptions();
  const session = await getServerSession(authOptions);
  
  return !!(session && session.user);
}

/**
 * 处理未授权请求的通用函数
 * @returns NextResponse 包含401状态码和错误消息
 */
export function unauthorized() {
  return NextResponse.json(
    { error: '未授权的请求，请先登录' },
    { status: 401 }
  );
}

/**
 * 验证API路由的中间件函数
 * 检查用户是否已登录，如果未登录则返回401响应
 * @returns 如果用户已登录则返回null，否则返回401 Response
 */
export async function validateAuth() {
  const authenticated = await isAuthenticated();
  if (!authenticated) {
    return unauthorized();
  }
  return null;
}

/**
 * 验证当前用户是否有权访问指定的监控项。
 * 管理员可访问所有监控项；普通用户仅能访问自己创建的监控项。
 * @param monitorId 监控项ID
 * @returns 有权访问返回 null；无权或未登录返回对应的错误 NextResponse
 */
export async function validateMonitorOwnership(monitorId: string) {
  const authError = await validateAuth();
  if (authError) return authError;

  const authOptions = await buildAuthOptions();
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json(
      { error: '未授权的请求' },
      { status: 401 }
    );
  }

  const monitor = await prisma.monitor.findUnique({
    where: {
      id: monitorId,
      // 如果是管理员，可以访问所有监控项
      ...(session.user.isAdmin ? {} : { createdById: session.user.id })
    }
  });

  if (!monitor) {
    return NextResponse.json(
      { error: '无权访问此监控项' },
      { status: 403 }
    );
  }

  return null;
} 