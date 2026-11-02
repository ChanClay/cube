import { NextResponse } from 'next/server';
import { getLatestScript } from '@/lib/script-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 最近一次编辑/生成的剧本（无则 script 为 null）；?projectId= 限定项目 */
export async function GET(request: Request) {
  const projectId = new URL(request.url).searchParams.get('projectId')?.trim() || undefined;
  const script = await getLatestScript(projectId);
  return NextResponse.json({ script });
}
