import { promises as fs } from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { UPLOAD_DIR } from '@/lib/services/uploads';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/** 读取本地素材文件 */
export async function GET(_request: Request, context: { params: Promise<{ file: string }> }) {
  const { file } = await context.params;
  if (!/^[A-Za-z0-9._-]+$/.test(file)) {
    return NextResponse.json({ error: '文件名不合法' }, { status: 400 });
  }

  const target = path.join(UPLOAD_DIR, path.basename(file));

  try {
    const data = await fs.readFile(target);
    return new NextResponse(new Uint8Array(data), {
      headers: {
        'Content-Type': MIME_BY_EXT[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': String(data.byteLength),
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  } catch {
    return NextResponse.json({ error: '素材不存在' }, { status: 404 });
  }
}

/** 删除本地素材文件（素材库里移除时调用） */
export async function DELETE(_request: Request, context: { params: Promise<{ file: string }> }) {
  const { file } = await context.params;
  if (!/^[A-Za-z0-9._-]+$/.test(file)) {
    return NextResponse.json({ error: '文件名不合法' }, { status: 400 });
  }

  await fs.rm(path.join(UPLOAD_DIR, path.basename(file)), { force: true });
  return NextResponse.json({ ok: true });
}
