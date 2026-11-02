import { NextResponse } from 'next/server';
import { clearSessionCookie, destroySession, readSessionCookie } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  const token = await readSessionCookie();
  if (token) {
    // 服务端也删掉，避免 cookie 被复制后仍能用
    await destroySession(token).catch(() => undefined);
  }
  await clearSessionCookie();
  return NextResponse.json({ ok: true });
}
