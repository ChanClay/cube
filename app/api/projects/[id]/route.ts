import { NextResponse } from 'next/server';
import { deleteProject, getProject, updateProject } from '@/lib/services/project-store';
import { listScripts } from '@/lib/services/script-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 项目详情 + 该项目下的剧本列表 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const project = await getProject(id);
  if (!project) {
    return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  }

  const scripts = await listScripts(50, id);
  return NextResponse.json({ project, scripts });
}

/** 更新项目名称 / 描述 / 画幅 / 画质 */
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: '请求体必须是合法 JSON' }, { status: 400 });
  }

  const payload = (body ?? {}) as Record<string, unknown>;
  const project = await updateProject(id, {
    name: typeof payload.name === 'string' ? payload.name : undefined,
    description: typeof payload.description === 'string' ? payload.description : undefined,
    ratio: typeof payload.ratio === 'string' ? payload.ratio : undefined,
    resolution: typeof payload.resolution === 'string' ? payload.resolution : undefined,
  });

  if (!project) {
    return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  }
  return NextResponse.json({ project });
}

/** 删除项目（连带其下剧本） */
export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const removed = await deleteProject(id);
  if (!removed) {
    return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
