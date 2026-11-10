import { NextResponse } from 'next/server';
import { config } from '@/lib/config';
import { absolutizeMediaUrl, isPublicOrigin, sanitizeMedia, validateMedia } from '@/lib/media';
import { listJobs } from '@/lib/store';
import { syncAllJobs, startVideoJob } from '@/lib/video-service';
import { normalizeRatio, normalizeResolution } from '@/lib/video-options';
import type { MediaInput } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * 文本命中与角色绑定可能拿到同一个素材（组名常等于角色名），
 * 合并后按「类型 + 地址」去重，避免同一个参考图被传两次。
 */
function dedupeMedia(items: MediaInput[]): MediaInput[] {
  const seen = new Set<string>();
  const result: MediaInput[] = [];
  for (const item of items) {
    const key = `${item.type}|${item.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

/** 列出全部视频任务（非终态任务会顺带向 provider 同步一次） */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const shotId = url.searchParams.get('shotId');
  const skipSync = url.searchParams.get('sync') === '0';

  const jobs = skipSync ? await listJobs() : await syncAllJobs();
  return NextResponse.json({
    jobs: shotId ? jobs.filter((job) => job.shotId === shotId) : jobs,
  });
}

/** 为某个镜头创建视频生成任务 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: '请求体必须是合法 JSON' }, { status: 400 });
  }

  const payload = (body ?? {}) as Record<string, unknown>;
  const shotId = typeof payload.shotId === 'string' ? payload.shotId.trim() : '';
  const prompt = typeof payload.prompt === 'string' ? payload.prompt.trim() : '';
  const duration = Number(payload.duration);

  // 画幅 / 画质来自项目设置；没传（老客户端）时回落到全局 VIDEO_* 配置
  const rawResolution = typeof payload.resolution === 'string' ? payload.resolution.trim() : '';
  const rawRatio = typeof payload.ratio === 'string' ? payload.ratio.trim() : '';
  const resolution = rawResolution ? normalizeResolution(rawResolution) : undefined;
  const ratio = rawRatio ? normalizeRatio(rawRatio) : undefined;

  if (!shotId) return NextResponse.json({ error: '缺少 shotId' }, { status: 400 });
  if (prompt.length < 5) {
    return NextResponse.json({ error: '视频提示词太短，至少 5 个字符' }, { status: 400 });
  }

  // 多模态素材：支持首帧/尾帧、参考图/视频/音频、文档、网页。
  // 站内地址（角色卡 / 场景卡配图）先按 PUBLIC_BASE_URL 绝对化，再校验。
  const origin = config.publicBaseUrl || new URL(request.url).origin;
  const manual = sanitizeMedia(payload.media);

  // 站内素材要变成公网地址才能交给云端模型；origin 是 localhost 时注定下载失败，
  // 提前报错，别等任务跑完才在 provider 侧失败（之前就是这么白烧额度的）。
  if (manual.some((item) => item.url.startsWith('/api/')) && !isPublicOrigin(origin)) {
    return NextResponse.json(
      {
        error: `素材地址是 ${origin}，云端视频模型访问不到本机。请通过公网隧道打开页面，或在 .env.local 把 PUBLIC_BASE_URL 配成公网地址后重启服务`,
      },
      { status: 400 },
    );
  }

  const media: MediaInput[] = manual.map((item) => ({
    ...item,
    url: absolutizeMediaUrl(item.url, origin),
  }));

  const mediaError = validateMedia(media);
  if (mediaError) {
    return NextResponse.json({ error: mediaError }, { status: 400 });
  }

  const job = await startVideoJob({
    shotId,
    prompt,
    duration: Number.isFinite(duration) ? duration : undefined,
    resolution,
    ratio,
    media: dedupeMedia(media),
  });

  return NextResponse.json({ job }, { status: job.status === 'failed' ? 200 : 201 });
}
