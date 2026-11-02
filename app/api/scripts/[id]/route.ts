import { NextResponse } from 'next/server';
import { countScripts, deleteScript, getScript } from '@/lib/script-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const script = await getScript(id);
  if (!script) {
    return NextResponse.json({ error: '剧本不存在' }, { status: 404 });
  }
  return NextResponse.json({ script });
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;

  const script = await getScript(id);
  if (!script) {
    return NextResponse.json({ error: '剧本不存在' }, { status: 404 });
  }

  // 每个项目至少留一份剧本；删整个项目走 /api/projects/[id]，不受这条限制
  const total = await countScripts(script.projectId);
  if (total <= 1) {
    return NextResponse.json({ error: '至少要保留一份剧本，不能删掉最后一份' }, { status: 400 });
  }

  const removed = await deleteScript(id);
  if (!removed) {
    return NextResponse.json({ error: '剧本不存在' }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
