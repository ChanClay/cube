import { hasPrevFrameReference } from './media';
import type { MediaInput, Shot } from './types';

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
 * 带上一镜末帧当参考图时追加的限定句。
 *
 * 必须把作用范围写死：wan3.0 的 reference_image 是「角色 / 物品 / 风格参考」，
 * 不给边界它会连构图和机位一起抄，硬切就白切了。这里只借光线与材质，
 * 景别、机位、构图回到本镜自己的描述。
 */
const FRAME_REFERENCE_CLAUSE =
  'Match the lighting, color temperature and scene materials of the reference image, ' +
  'but keep the framing, shot size and camera angle described above exactly.';

export function buildVideoPrompt(
  prompt: string,
  shot: Pick<Shot, 'narration' | 'narrationType' | 'speaker'>,
  media: MediaInput[] = [],
): string {
  const base = (prompt ?? '').trim();
  const line = (shot.narration ?? '').trim();
  const reference = hasPrevFrameReference(media) ? ` ${FRAME_REFERENCE_CLAUSE}` : '';

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
