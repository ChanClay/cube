import { NextResponse } from 'next/server';
import { getCurrentUser, registrationOpen } from '@/lib/services/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 当前登录态 + 注册入口是否开放（登录页靠它决定显示注册还是登录） */
export async function GET() {
  try {
    const [user, open] = await Promise.all([getCurrentUser(), registrationOpen()]);
    return NextResponse.json({
      user: user ? { id: user.id, username: user.username, createdAt: user.createdAt } : null,
      registrationOpen: open,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
