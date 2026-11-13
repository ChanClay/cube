import { promises as fs } from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';
import {
  CARD_NEGATIVE_PROMPT,
  buildCardPrompt,
  cardImageSize,
} from '@/lib/skills/image-prompt';
import { generateImage } from '@/lib/providers/image/wan-image';
import { currentUserId } from '@/lib/services/auth';
import { acquireSubmitLock, releaseSubmitLock, submitLockKey } from '@/lib/services/submit-lock';
import { UPLOAD_DIR } from '@/lib/services/uploads';
import type { CharacterSubject, ProjectMedia } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

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
  /** 蓝图锁定的固定英文短语：带上它，卡片和逐镜视频才长得一样 */
  const promptEn = typeof payload.promptEn === 'string' ? payload.promptEn.trim() : '';
  const style = typeof payload.style === 'string' ? payload.style.trim() : '';
  const kind = payload.kind === 'scene' ? 'scene' : 'character';
  /** 主体类型（来自蓝图）：人类卡的 desc 里出现「车内」也不会被当成载具卡 */
  const subjectTypeRaw = typeof payload.subjectType === 'string' ? payload.subjectType.trim() : '';
  const subjectType: CharacterSubject | undefined =
    subjectTypeRaw === 'human' || subjectTypeRaw === 'vehicle' || subjectTypeRaw === 'mech'
      ? subjectTypeRaw
      : undefined;

  if (prompt.length < 2) {
    return NextResponse.json({ error: '请先填写名称或描述，再生成配图' }, { status: 400 });
  }

  /**
   * 提交锁：同一张卡、同一份提示词同时只允许一个文生图请求。
   * 双击「生成配图」或是两个标签页同时点，都会各自生成一张图、各算一次钱。
   * 上一次结束后再点仍然放行（用户主动换图不受影响）。
   */
  const userId = await currentUserId();
  const lockKey = submitLockKey('image', [userId, kind, prompt, promptEn, style, subjectType]);
  if (!acquireSubmitLock(lockKey)) {
    return NextResponse.json(
      { error: '这张卡的配图正在生成中，请稍候（重复点击不会重复计费）' },
      { status: 409 },
    );
  }

  try {
    const remoteUrl = await generateImage({
      // 画风（script.style）+ 主体 + 构图 + 画面质感，顺序见 lib/skills/image-prompt
      prompt: buildCardPrompt({ kind, prompt, subjectType, promptEn, style }),
      // 载具卡是横图、人物卡是竖图，见 lib/skills/image-prompt 的 cardImageSize
      size: cardImageSize(kind, `${prompt} ${promptEn}`, subjectType),
      negativePrompt: CARD_NEGATIVE_PROMPT,
    });

    const res = await fetch(remoteUrl, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok || !res.body) {
      return NextResponse.json(
        { error: `下载生成的图片失败（HTTP ${res.status}）` },
        { status: 502 },
      );
    }
    const bytes = Buffer.from(await res.arrayBuffer());

    const ext = extensionOf(remoteUrl);
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
  } finally {
    // 成功、失败、下载早退都要放锁，否则这张卡会一直被判成「生成中」
    releaseSubmitLock(lockKey);
  }
}
