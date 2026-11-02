import { NextResponse } from 'next/server';
import {
  AuthError,
  createSession,
  findUserByUsername,
  setSessionCookie,
  verifyPassword,
} from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: '请求体必须是合法 JSON' }, { status: 400 });
  }

  const payload = (body ?? {}) as Record<string, unknown>;
  const username = typeof payload.username === 'string' ? payload.username.trim() : '';
  const password = typeof payload.password === 'string' ? payload.password : '';

  if (!username || !password) {
    return NextResponse.json({ error: '请输入用户名和密码' }, { status: 400 });
  }

  try {
    const found = await findUserByUsername(username);
    // 用户不存在和密码错误返回同一句话，避免探测用户名是否存在
    if (!found || !(await verifyPassword(password, found.passwordHash))) {
      return NextResponse.json({ error: '用户名或密码不正确' }, { status: 401 });
    }

    const session = await createSession(found.id);
    await setSessionCookie(session.token, session.expiresAt);

    return NextResponse.json({
      user: { id: found.id, username: found.username, createdAt: found.createdAt },
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `登录失败：${message}` }, { status: 500 });
  }
}
