import { NextResponse } from 'next/server';
import { ffmpegMissingMessage, resolveFfmpeg } from '@/lib/services/compose';
import { config, llmConfigured, videoConfigured } from '@/lib/config';
import { databaseInfo, getDb } from '@/lib/services/db';
import { VIDEO_MODELS } from '@/lib/video-models';
import { orderVideoModels, videoModelOrder } from '@/lib/services/settings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function checkStorage(): Promise<{ ok: boolean; error: string | null }> {
  try {
    const pool = await getDb();
    await pool.query('SELECT 1');
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function GET() {
  const storage = await checkStorage();
  const ffmpeg = resolveFfmpeg();

  return NextResponse.json({
    ok: true,
    compose: {
      ffmpeg: ffmpeg !== null,
      hint: ffmpeg ? null : ffmpegMissingMessage(),
    },
    storage: {
      ...databaseInfo(),
      ok: storage.ok,
      error: storage.error,
    },
    llm: {
      configured: llmConfigured(),
      model: config.llm.model,
      baseUrl: config.llm.baseUrl,
    },
    video: {
      configured: videoConfigured(),
      /** 创建剧本时可选的视频模型（含单镜时长区间），按模型管理页保存的顺序排列 */
      models: orderVideoModels(VIDEO_MODELS, await videoModelOrder()),
      resolution: config.video.resolution,
      ratio: config.video.ratio,
      /** 硬切镜头是否会带上一镜末帧作为风格参考图 */
      referencePrevFrame: config.video.referencePrevFrame,
    },
    pollIntervalMs: config.pollIntervalMs,
  });
}
