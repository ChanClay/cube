import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { FRAME_DIR } from '@/lib/frame';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const FILE_PATTERN = /^frame-\d+-[a-z0-9]+\.jpg$/;

/** 提供抽出的关键帧图片（云端视频模型需要能下载到这张图） */
export async function GET(_request: Request, context: { params: Promise<{ file: string }> }) {
  const { file } = await context.params;

  if (!FILE_PATTERN.test(file)) {
    return new Response('Not Found', { status: 404 });
  }

  const filePath = path.join(FRAME_DIR, file);
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat) {
    return new Response('Not Found', { status: 404 });
  }

  const stream = Readable.toWeb(createReadStream(filePath)) as unknown as ReadableStream;
  return new Response(stream, {
    headers: {
      'Content-Type': 'image/jpeg',
      'Content-Length': String(stat.size),
      // 文件名唯一，可长缓存
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}
