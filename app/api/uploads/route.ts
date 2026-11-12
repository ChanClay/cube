import { promises as fs } from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { MAX_UPLOAD_BYTES, UPLOAD_DIR, compressImage } from '@/lib/services/uploads';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BYTES = MAX_UPLOAD_BYTES;
const ALLOWED_PREFIX = ['image/', 'audio/', 'video/'];
const ALLOWED_MIME = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
  'text/markdown',
]);

function allowMime(mime: string): boolean {
  return ALLOWED_PREFIX.some((prefix) => mime.startsWith(prefix)) || ALLOWED_MIME.has(mime);
}

/** 只保留安全的扩展名 */
function extensionOf(fileName: string): string {
  const raw = path.extname(fileName).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(raw) ? raw : '';
}

/** 上传一个素材文件，返回可用于素材库的记录 */
export async function POST(request: Request) {
  const form = await request.formData().catch(() => null);
  if (!form) {
    return NextResponse.json({ error: '请求体必须是 multipart/form-data' }, { status: 400 });
  }

  const file = form.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: '缺少 file 字段' }, { status: 400 });
  }
  if (file.size === 0) {
    return NextResponse.json({ error: '文件内容为空' }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: '单个素材不能超过 32MB' }, { status: 413 });
  }

  const mime = file.type || 'application/octet-stream';
  if (!allowMime(mime)) {
    return NextResponse.json(
      { error: `不支持的文件类型：${mime}（图片 / 音频 / 视频 / PDF / Office 文档 / 文本）` },
      { status: 415 },
    );
  }

  const raw = Buffer.from(await file.arrayBuffer());
  // 图片先瘦身：云端模型要从隧道下载这张图，原图太大会下载超时
  const compressed = await compressImage(raw, mime);
  const data = compressed?.data ?? raw;
  const stored = `${crypto.randomUUID()}${compressed?.ext ?? extensionOf(file.name)}`;

  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  await fs.writeFile(path.join(UPLOAD_DIR, stored), data);

  return NextResponse.json({
    media: {
      id: crypto.randomUUID(),
      type: 'reference_image',
      url: `/api/uploads/${stored}`,
      name: file.name || stored,
      mime: compressed?.mime ?? mime,
      size: data.byteLength,
      local: true,
      createdAt: Date.now(),
    },
  });
}
