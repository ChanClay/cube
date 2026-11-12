import { NextResponse } from 'next/server';
import {
  AuthError,
  claimOrphanData,
  createSession,
  createUser,
  findUserByUsername,
  registrationOpen,
  setSessionCookie,
  validateCredentials,
} from '@/lib/services/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 注册。只允许第一个账号：注册成功后入口自动关闭。
 * 首个账号会接手登录前遗留的无主项目 / 剧本 / 任务。
 */
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

  if (!(await registrationOpen())) {
    return NextResponse.json(
      { error: '账号已存在，注册入口已关闭，请直接登录' },
      { status: 403 },
    );
  }

  const invalid = validateCredentials(username, password);
  if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });

  try {
    if (await findUserByUsername(username)) {
      return NextResponse.json({ error: '用户名已被占用' }, { status: 409 });
    }

    const user = await createUser(username, password);
    const claimed = await claimOrphanData(user.id);

    const session = await createSession(user.id);
    await setSessionCookie(session.token, session.expiresAt);

    return NextResponse.json({ user, claimedProjects: claimed });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `注册失败：${message}` }, { status: 500 });
  }
}
