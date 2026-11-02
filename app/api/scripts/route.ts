import { NextResponse } from 'next/server';
import { logAgentWarn } from '@/lib/logger';
import { touchProject } from '@/lib/project-store';
import { listScripts, saveScript } from '@/lib/script-store';
import type { Script } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 把 MySQL / 网络错误翻成用户能看懂的话 */
function friendlyError(err: unknown): string {
  const code = (err as { code?: string }).code ?? '';
  const raw = err instanceof Error ? err.message : String(err);
  switch (code) {
    case 'ER_DATA_TOO_LONG':
      return '剧本内容超出数据库字段长度限制（style/title 过长）';
    case 'ER_ACCESS_DENIED_ERROR':
      return 'MySQL 拒绝访问，请检查 DATABASE_URL 里的账号密码';
    case 'ER_BAD_DB_ERROR':
    case 'ER_NO_SUCH_TABLE':
      return '数据库或数据表不存在，请确认 MySQL 可用后重试';
    case 'ECONNREFUSED':
    case 'ETIMEDOUT':
    case 'EHOSTUNREACH':
      return '连不上 MySQL，请确认本地数据库已启动';
    default:
      return raw;
  }
}

/** 列出剧本，可用 ?projectId= 只看某个项目下的 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const limitRaw = Number(params.get('limit'));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 20;
  const projectId = params.get('projectId')?.trim() || undefined;

  const scripts = await listScripts(limit, projectId);
  return NextResponse.json({ scripts });
}

/** 保存（新建或更新）一份剧本 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: '请求体必须是合法 JSON' }, { status: 400 });
  }

  const payload = (body ?? {}) as Record<string, unknown>;
  const script = payload.script as Script | undefined;

  if (!script || typeof script !== 'object' || !Array.isArray(script.shots)) {
    return NextResponse.json({ error: 'script 字段不合法（缺少 shots 数组）' }, { status: 400 });
  }

  try {
    const saved = await saveScript({
      id: typeof payload.id === 'string' ? payload.id : undefined,
      projectId: typeof payload.projectId === 'string' ? payload.projectId : undefined,
      idea: typeof payload.idea === 'string' ? payload.idea : '',
      script,
    });

    await touchProject(saved.projectId);

    return NextResponse.json({ script: saved });
  } catch (err) {
    const message = friendlyError(err);
    void logAgentWarn('script', { reason: '剧本保存失败', projectId: payload.projectId, error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
