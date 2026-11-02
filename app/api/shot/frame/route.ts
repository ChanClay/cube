import { NextResponse } from 'next/server';
import { config } from '@/lib/config';
import { FrameError, extractFrame, type FramePosition } from '@/lib/frame';
import { logVideoError } from '@/lib/logger';
import { getJob } from '@/lib/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/** 回环 / 局域网地址：云端视频模型都下载不到 */
const PRIVATE_HOST =
  /^(localhost|0\.0\.0\.0|\[::1\]|::1|127\.|10\.|192\.168\.|169\.254\.)|^172\.(1[6-9]|2\d|3[01])\./i;

/** 站外可访问的站点地址：优先 PUBLIC_BASE_URL，其次请求自身的 origin */
function resolveOrigin(request: Request): string {
  if (config.publicBaseUrl) return config.publicBaseUrl;
  try {
    return new URL(request.url).origin;
  } catch {
    return '';
  }
}

/** 云端视频模型能否下载到这张图（回环 / 局域网地址都不行） */
function isPubliclyReachable(origin: string): boolean {
  if (config.publicBaseUrl) return true;
  try {
    return !PRIVATE_HOST.test(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/**
 * 从已生成的镜头视频里抽一帧，给下一镜当首帧素材。
 * body: { videoUrl } 或 { jobId }
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: '请求体必须是合法 JSON' }, { status: 400 });
  }

  const payload = (body ?? {}) as Record<string, unknown>;
  const jobId = typeof payload.jobId === 'string' ? payload.jobId.trim() : '';
  let videoUrl = typeof payload.videoUrl === 'string' ? payload.videoUrl.trim() : '';

  if (!videoUrl && jobId) {
    const job = await getJob(jobId);
    if (!job) return NextResponse.json({ error: '视频任务不存在' }, { status: 404 });
    if (job.status !== 'succeeded' || !job.videoUrl) {
      return NextResponse.json({ error: '这个镜头的视频还没有生成完成' }, { status: 400 });
    }
    videoUrl = job.videoUrl;
  }

  if (!videoUrl) {
    return NextResponse.json({ error: '缺少 videoUrl 或 jobId' }, { status: 400 });
  }

  const position: FramePosition = payload.position === 'first' ? 'first' : 'last';

  try {
    const frame = await extractFrame(videoUrl, position);
    const origin = resolveOrigin(request);
    const absoluteUrl = origin ? `${origin.replace(/\/+$/, '')}${frame.url}` : frame.url;

    return NextResponse.json({
      frame: {
        ...frame,
        absoluteUrl,
        publiclyReachable: isPubliclyReachable(origin),
      },
    });
  } catch (err) {
    if (err instanceof FrameError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    const message = err instanceof Error ? err.message : String(err);
    void logVideoError('compose', { scope: 'extract-frame', videoUrl, error: message });
    return NextResponse.json({ error: `抽帧失败：${message}` }, { status: 500 });
  }
}
