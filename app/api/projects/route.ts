import { NextResponse } from 'next/server';
import { createProject, listProjects } from '@/lib/project-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 项目列表（按最近更新排序） */
export async function GET() {
  const projects = await listProjects();
  return NextResponse.json({ projects });
}

/** 新建项目 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const payload = (body ?? {}) as Record<string, unknown>;
  const project = await createProject({
    name: typeof payload.name === 'string' ? payload.name : undefined,
    description: typeof payload.description === 'string' ? payload.description : undefined,
  });

  // 不再预建空剧本：新建项目会先进故事创意页，生成后才写入第一份剧本，
  // 否则用户会看到一份没创意的空剧本。

  return NextResponse.json({ project });
}
