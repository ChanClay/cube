import { hasPrevFrameReference } from './media';
import type { MediaInput, Shot } from './types';

type PromptShot = Pick<Shot, 'narration' | 'narrationType' | 'speaker'> &
  Partial<Pick<Shot, 'characterNames'>>;

/**
 * 把台词拼进视频提示词。
 *
 * wan3.0 原生支持人声台词、BGM 与音效，但台词必须写在 prompt 里（官方示例是
 * `说道：“今天的阳光真好。”` 这种「动词 + 引号」写法）。画面描述继续用英文，
 * 台词保持原文——官方支持中英混写。
 *
 * 注意：首帧/首尾帧模式不能同时传 `reference_audio`，所以音色不可指定，
 * 只能靠 prompt 描述（需要固定音色就得放弃首帧衔接，改走全模态参考模式）。
 */

/** 台词内部的引号会破坏外层结构，统一换成单引号 */
function safeQuote(line: string): string {
  return `"${line.replace(/["“”]/g, "'")}"`;
}

/** 已经有句末标点就不重复加 */
function withEnd(text: string): string {
  return /[.!?。！？…"”]$/.test(text) ? text : `${text}.`;
}

/**
 * 带上一镜末帧当参考图时追加的稳定句。
 *
 * 必须把作用范围写死：wan3.0 的 reference_image 是「角色 / 物品 / 风格参考」，
 * 不给边界它会连构图和机位一起抄。这里只借光线与材质，
 * 景别、机位、构图回到本镜自己的描述。
 */
const FRAME_REFERENCE_STYLE =
  'Match the lighting, color temperature and scene materials of the reference image, ' +
  'but keep the framing, shot size and camera angle described above exactly.';

/** 英文并列：A / A and B / A, B and C */
function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * 限定句 + 点名参考图里的人物。
 *
 * 两个坑必须同时堵住：
 * 1. 不点名 —— 模型只会把末帧当调色板，人物身份信息全浪费；
 * 2. 说「保持位置」—— 换机位时位置必然变，模型会把参考图里的人留在原位，
 *    再按文字描述画一个，于是同一个人出现两次。所以只锁脸和服装，并显式禁止重复。
 */
function frameReferenceClause(cast: string[], characterCount = 0): string {
  const names = cast
    .map((name) => name.trim())
    .filter(Boolean)
    .slice(0, 4);

  const identity =
    names.length === 0
      ? 'The reference image is the last frame of the previous shot; ' +
        'do not duplicate or add any character from it.'
      : `The reference image is the last frame of the previous shot and shows ${joinNames(names)} ` +
        `— the same ${names.length > 1 ? 'characters' : 'person'} described above, not ` +
        `${names.length > 1 ? 'additional characters' : 'an additional character'}. ` +
        'Keep only their faces and wardrobe consistent; do not duplicate them.';

  // 单人镜头多出一个人是最常见的错误，直接给个人数上限
  const count = characterCount === 1 ? ' Only one person appears in frame.' : '';

  return `${identity}${count} ${FRAME_REFERENCE_STYLE}`;
}

export function buildVideoPrompt(
  prompt: string,
  shot: PromptShot,
  media: MediaInput[] = [],
  /** 参考图里实际在场的人物名（见 lib/shot-media 的 prevFrameCast） */
  refCast: string[] = [],
): string {
  const base = (prompt ?? '').trim();
  const line = (shot.narration ?? '').trim();
  const reference = hasPrevFrameReference(media)
    ? ` ${frameReferenceClause(refCast, (shot.characterNames ?? []).length)}`
    : '';

  // 没写台词，或明确选了「都不要」：画面描述原样提交，模型只出环境音/BGM
  if (!line || shot.narrationType === 'none') {
    return reference ? `${withEnd(base)}${reference}` : base;
  }

  if (shot.narrationType === 'dialogue') {
    /**
     * 多人物镜头里只写 "The character" 会让模型挑错人开口，
     * 所以把说话人名字写进提示词；没有 speaker 的旧剧本保持原行为。
     */
    const speaker = (shot.speaker ?? '').trim();
    const who = speaker ? `The character named ${speaker}` : 'The on-screen character';
    return `${withEnd(
      `${base} ${who} speaks with natural lip movement and matching facial expression: ${safeQuote(line)}`,
    )}${reference}`;
  }

  // 缺省按画外旁白处理：人物闭嘴，避免旧剧本全变成人物在说话
  return `${withEnd(
    `${base} Voiceover by an off-screen narrator (no lip movement, the character's mouth stays closed): ${safeQuote(line)}`,
  )}${reference}`;
}
