import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { VIDEO_DIR } from '@/lib/services/videos';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const FILE_PATTERN = /^[0-9a-f-]{36}\.mp4$/;

/**
 * 提供本地转存的视频。
 * 支持 Range：Safari 不认不带 Range 的视频，拖动进度条也会失效。
 */
export async function GET(request: Request, context: { params: Promise<{ file: string }> }) {
  const { file } = await context.params;

  if (!FILE_PATTERN.test(file)) {
    return new Response('Not Found', { status: 404 });
  }

  const filePath = path.join(VIDEO_DIR, file);
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat) {
    return new Response('Not Found', { status: 404 });
  }

  const baseHeaders = {
    'Content-Type': 'video/mp4',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=31536000, immutable',
  };

  const range = request.headers.get('range');
  const match = range?.match(/^bytes=(\d*)-(\d*)$/);
  if (match) {
    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;

    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= stat.size) {
      return new Response('Range Not Satisfiable', {
        status: 416,
        headers: { 'Content-Range': `bytes */${stat.size}` },
      });
    }

    const stream = Readable.toWeb(
      createReadStream(filePath, { start, end }),
    ) as unknown as ReadableStream;

    return new Response(stream, {
      status: 206,
      headers: {
        ...baseHeaders,
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Content-Length': String(end - start + 1),
      },
    });
  }

  const stream = Readable.toWeb(createReadStream(filePath)) as unknown as ReadableStream;
  return new Response(stream, {
    headers: { ...baseHeaders, 'Content-Length': String(stat.size) },
  });
}
