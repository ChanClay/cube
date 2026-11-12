import { NextResponse } from 'next/server';
import { ffmpegMissingMessage, resolveFfmpeg } from '@/lib/services/compose';
import { config, llmConfigured, videoConfigured } from '@/lib/config';
import { databaseInfo, getDb } from '@/lib/services/db';
import { getProvider } from '@/lib/providers/video';

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
      provider: getProvider().name,
      configured: videoConfigured(),
      model: getProvider().model,
      resolution: config.video.resolution,
      ratio: config.video.ratio,
      audio: config.video.audio,
      /** 承接上一镜末帧的镜头是否会保留音轨（默认关，避免音频断档） */
      audioOnCarry: config.video.audioOnCarry,
      /** 硬切镜头是否会带上一镜末帧作为风格参考图 */
      referencePrevFrame: config.video.referencePrevFrame,
      promptExtend: config.video.promptExtend,
    },
    pollIntervalMs: config.pollIntervalMs,
  });
}
