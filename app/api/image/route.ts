import { promises as fs } from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { generateImage } from '@/lib/providers/image';
import { UPLOAD_DIR } from '@/lib/uploads';
import type { ProjectMedia } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** 角色用竖构图，场景用横构图（万相 2.6 推荐的 3:4 / 16:9 档位） */
const SIZE_BY_KIND = {
  character: '1104*1472',
  scene: '1696*960',
} as const;

/** 卡片类型决定的构图补充词，避免出图跑偏成海报或多人合影 */
const FRAMING = {
  character: '角色设定图，单人主体居中，全身正面，纯色简洁背景，无文字无水印',
  scene: '场景空镜，无人物，广角电影感构图，光线自然，无文字无水印',
} as const;

const NEGATIVE = '文字, 水印, logo, 分屏, 畸形肢体, 多余手指, 低清晰度';

function buildPrompt(prompt: string, kind: 'character' | 'scene', style: string): string {
  const parts = [prompt.trim()];
  if (style.trim()) parts.push(`整体视觉风格：${style.trim()}`);
  parts.push(FRAMING[kind]);
  return parts.join('。').slice(0, 2000);
}

/** 从临时 URL 的扩展名推断图片格式，拿不到就按 PNG 处理 */
function extensionOf(url: string): string {
  const pathname = url.split('?')[0];
  const ext = path.extname(pathname).toLowerCase();
  return ['.png', '.jpg', '.jpeg', '.webp'].includes(ext) ? ext : '.png';
}

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

/** 网关直接回 base64 时，靠它反推落盘扩展名 */
const EXT_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
};

/**
 * 给角色卡 / 场景卡生成一张配图。
 * body: { prompt, kind: 'character' | 'scene', style? }
 *
 * 万相返回的地址只保留 24 小时，所以这里立刻下载并落到 .data/uploads，
 * 前端拿到的是站内永久地址。
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: '请求体必须是合法 JSON' }, { status: 400 });
  }

  const payload = (body ?? {}) as Record<string, unknown>;
  const prompt = typeof payload.prompt === 'string' ? payload.prompt.trim() : '';
  const style = typeof payload.style === 'string' ? payload.style.trim() : '';
  const kind = payload.kind === 'scene' ? 'scene' : 'character';

  if (prompt.length < 2) {
    return NextResponse.json({ error: '请先填写名称或描述，再生成配图' }, { status: 400 });
  }

  try {
    const generated = await generateImage({
      prompt: buildPrompt(prompt, kind, style),
      size: SIZE_BY_KIND[kind],
      negativePrompt: NEGATIVE,
    });

    let bytes: Buffer;
    let ext: string;

    if ('base64' in generated) {
      // OpenAI 风格网关（gpt-image 等）只回 base64，没有可下载的地址
      bytes = Buffer.from(generated.base64, 'base64');
      ext = EXT_BY_MIME[generated.mime] ?? '.png';
    } else {
      const res = await fetch(generated.url, { signal: AbortSignal.timeout(120_000) });
      if (!res.ok || !res.body) {
        return NextResponse.json(
          { error: `下载生成的图片失败（HTTP ${res.status}）` },
          { status: 502 },
        );
      }
      bytes = Buffer.from(await res.arrayBuffer());
      ext = extensionOf(generated.url);
    }
    const stored = `${crypto.randomUUID()}${ext}`;
    await fs.mkdir(UPLOAD_DIR, { recursive: true });
    await fs.writeFile(path.join(UPLOAD_DIR, stored), bytes);

    const media: ProjectMedia = {
      id: crypto.randomUUID(),
      type: 'reference_image',
      url: `/api/uploads/${stored}`,
      name: `${kind === 'scene' ? '场景' : '角色'}-${prompt.slice(0, 20)}${ext}`,
      mime: MIME_BY_EXT[ext],
      size: bytes.byteLength,
      local: true,
      createdAt: Date.now(),
    };

    return NextResponse.json({ media });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
