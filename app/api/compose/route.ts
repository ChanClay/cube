import { NextResponse } from 'next/server';
import { ComposeError, composeVideos } from '@/lib/compose';
import { config } from '@/lib/config';
import { listJobs } from '@/lib/store';
import type { VideoJob } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** 导出尺寸跟随 VIDEO_RESOLUTION / VIDEO_RATIO，竖屏或方形时自动调换 */
function resolveExportSize(): string {
  const res = config.video.resolution.toLowerCase();
  const base = res.startsWith('1080')
    ? { w: 1920, h: 1080 }
    : res.startsWith('480')
      ? { w: 832, h: 480 }
      : { w: 1280, h: 720 };

  if (config.video.ratio === '9:16') return `${base.h}x${base.w}`;
  if (config.video.ratio === '1:1') return `${base.h}x${base.h}`;
  return `${base.w}x${base.h}`;
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: '请求体必须是合法 JSON' }, { status: 400 });
  }

  const payload = (body ?? {}) as Record<string, unknown>;
  const shotIds = Array.isArray(payload.shotIds)
    ? payload.shotIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : [];

  if (shotIds.length < 2) {
    return NextResponse.json({ error: '至少需要 2 个镜头才能合成' }, { status: 400 });
  }
  if (shotIds.length > 20) {
    return NextResponse.json({ error: '单次最多合成 20 个镜头' }, { status: 400 });
  }

  // 取每个镜头最近一次成功生成的任务（jobs 已按创建时间倒序）
  const all = await listJobs();
  const latestSuccess = new Map<string, VideoJob>();
  for (const job of all) {
    if (job.status === 'succeeded' && job.videoUrl && !latestSuccess.has(job.shotId)) {
      latestSuccess.set(job.shotId, job);
    }
  }

  const clips: { url: string; shotId: string }[] = [];
  for (const shotId of shotIds) {
    const job = latestSuccess.get(shotId);
    if (!job?.videoUrl) {
      return NextResponse.json({ error: '有镜头尚未生成完成的视频，请先生成全部镜头' }, { status: 400 });
    }
    clips.push({ url: job.videoUrl, shotId });
  }

  try {
    const result = await composeVideos(clips, resolveExportSize());
    return NextResponse.json({ ...result, size: resolveExportSize() });
  } catch (err) {
    if (err instanceof ComposeError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
