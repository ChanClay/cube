import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { EXPORT_DIR } from '@/lib/compose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const FILE_PATTERN = /^compose-\d+\.mp4$/;

export async function GET(request: Request, context: { params: Promise<{ file: string }> }) {
  const { file } = await context.params;

  // 只允许合成产物，避免路径穿越
  if (!FILE_PATTERN.test(file)) {
    return new Response('Not Found', { status: 404 });
  }

  const filePath = path.join(EXPORT_DIR, file);
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat) {
    return new Response('Not Found', { status: 404 });
  }

  const headers: Record<string, string> = {
    'Content-Type': 'video/mp4',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  };

  const range = request.headers.get('range');
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (match) {
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;

      if (Number.isNaN(start) || start >= stat.size || start > end) {
        return new Response(null, {
          status: 416,
          headers: { 'Content-Range': `bytes */${stat.size}` },
        });
      }

      const stream = Readable.toWeb(createReadStream(filePath, { start, end })) as unknown as ReadableStream;
      return new Response(stream, {
        status: 206,
        headers: {
          ...headers,
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Content-Length': String(end - start + 1),
        },
      });
    }
  }

  const stream = Readable.toWeb(createReadStream(filePath)) as unknown as ReadableStream;
  return new Response(stream, {
    headers: { ...headers, 'Content-Length': String(stat.size) },
  });
}
