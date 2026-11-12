import { config } from '@/lib/config';
import { logAgentWarn } from '@/lib/services/logger';
import type { ShotBeat } from '@/lib/types';
import { callChatJson } from './llm';
import {
  cameraMoveEn,
  countWords,
  isEnglishPrompt,
  PROMPT_MAX_WORDS,
  PROMPT_MIN_WORDS,
  shotSizeEn,
  stripForbiddenPromptPhrases,
  str,
  VIDEO_PROMPT_RULES,
} from '@/lib/skills/spec';

/**
 * 提示词本地化 agent（中文 description → 英文 videoPrompt）
 *
 * 之前英文提示词和中文画面描述是同一次生成里「各写各的」：模型一边构思画面一边
 * 写英文，很容易在英文里补上中文没写的元素、或者漏掉中文的关键动作，成片就和
 * 剧本对不上。把这件事拆成独立的一次调用后，模型只需要做一件事——照着定稿的
 * 中文逐句翻译，并且必须使用给定的固定英文短语与标准景别 / 运镜词。
 *
 * 失败（网络 / 空返回）时返回 null，调用方保留分镜阶段写好的英文，不阻断生成。
 */

export interface LocalizeCharacter {
  name: string;
  /** 全片固定的英文外貌短语 */
  promptEn?: string;
}

export interface LocalizeScene {
  name: string;
  /** 全片固定的英文空间短语 */
  promptEn?: string;
}

export interface LocalizeShot {
  index: number;
  /** 已定稿的中文画面描述，翻译的唯一依据 */
  description: string;
  shotSize: string;
  cameraMove: string;
  /** 本镜出镜角色名 */
  characters: string[];
  /** 本镜所在场景名 */
  scenes: string[];
  /**
   * 这一镜的秒级节拍。它是 description 之内的时间切片，
   * 英文动作链必须按同样的顺序把它们串起来，不能丢段、不能改序。
   */
  beatSheet?: ShotBeat[];
}

export interface LocalizeInput {
  shots: LocalizeShot[];
  characters: LocalizeCharacter[];
  scenes: LocalizeScene[];
  style?: string;
}

function buildSystemPrompt(): string {
  return `你是「影视提示词译者」。上游给出一份已经定稿的中文分镜，你只负责把每一镜的中文画面描述翻成英文文生视频提示词。

翻译铁律（违反任何一条都算失败）：
1. 只翻译，不创作：中文里的主体、动作、道具、环境、光线、景别、运镜逐项对应到英文；中文没有的元素一律不写，中文有的元素一个都不许漏。
2. 不解释、不评价、不补充剧情、不写镜头编号与转场词。
3. 角色、场景一律使用下方术语表给出的固定英文短语，逐字复用，不得改写年龄、发型、服装、装甲与涂装、道具与空间结构。
4. 景别与运镜使用下方给定的标准英文写法，必须与本镜的 shotSize / cameraMove 一致。
5. 有秒级节拍（beatSheet）时，它是这一镜的动作骨架：每一段都必须出现在英文里，按时间顺序用并列的现在分词短语串成一条动作链（例：eyes lifting to the tower top, hand rising to twist the lamp shade open, a small flame flaring inside the glass）。不要用 first / then / after that / finally / next 这类时间副词——模型看到它们会把画面切成两段，接缝处就是抽帧般的抖动。节拍有 3 段以上时，英文里对应的动作短语也不能少于 3 个。
6. ${VIDEO_PROMPT_RULES}

只输出一个 JSON 对象，不要解释文字、不要 markdown 代码块。`;
}

function buildUserPrompt(input: LocalizeInput): string {
  const cast = input.characters
    .map((c) => `- ${c.name} → ${c.promptEn || '（未给出固定短语，用中性英文外貌描述）'}`)
    .join('\n');
  const scenes = input.scenes
    .map((s) => `- ${s.name} → ${s.promptEn || '（未给出固定短语，用中性英文空间描述）'}`)
    .join('\n');

  const shots = input.shots
    .map((shot) => {
      const who = shot.characters.length > 0 ? shot.characters.join('、') : '（无人物出镜）';
      const where = shot.scenes.length > 0 ? shot.scenes.join('、') : '（未标注）';
      const beats = shot.beatSheet ?? [];
      const timeline = beats.length
        ? `\n秒级节拍（按时间顺序，每一段都要译进英文动作链）：\n` +
          beats.map((beat) => `  ${beat.from}~${beat.to}s：${beat.action}`).join('\n')
        : '';
      return (
        `镜头 ${shot.index}\n` +
        `中文描述：${shot.description}${timeline}\n` +
        `景别：${shot.shotSize}（英文 ${shotSizeEn(shot.shotSize)}）｜` +
        `运镜：${shot.cameraMove}（英文 ${cameraMoveEn(shot.cameraMove)}）｜` +
        `出镜：${who}｜场景：${where}`
      );
    })
    .join('\n\n');

  return `整体视觉风格：${input.style || '电影感写实风格，35mm 胶片质感，自然光，浅景深'}

术语表（英文短语必须逐字复用）：
角色：
${cast || '（无）'}

场景：
${scenes || '（无）'}

待翻译分镜（共 ${input.shots.length} 镜）：
${shots}

请按镜头顺序输出：
{
  "shots": [
    { "index": 1, "videoPrompt": "faithful English translation of shot 1" }
  ]
}

要求：shots 数量必须等于 ${input.shots.length}，index 必须与输入一致，videoPrompt 为 ${PROMPT_MIN_WORDS}~${PROMPT_MAX_WORDS} 个单词的英文单段话。`;
}

/**
 * 批量翻译。返回 index → 英文提示词；整体失败返回 null。
 * 单镜不合格（空 / 非英文 / 太短）的会被丢弃，由调用方保留分镜阶段的原文。
 */
export async function localizePrompts(
  input: LocalizeInput,
): Promise<Map<number, string> | null> {
  if (input.shots.length === 0) return null;

  let raw: unknown;
  try {
    raw = await callChatJson({
      system: buildSystemPrompt(),
      user: buildUserPrompt(input),
      temperature: 0.3,
      // 每镜约 120 个英文 token，留出余量
      maxTokens: Math.min(config.llm.maxTokens, 1200 + input.shots.length * 260),
      timeoutMs: Math.min(config.llm.timeoutMs, 90_000),
    });
  } catch (err) {
    void logAgentWarn('localize', {
      reason: '提示词翻译失败，保留分镜阶段写的英文',
      shots: input.shots.length,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  const obj = (raw ?? {}) as Record<string, unknown>;
  const list = Array.isArray(obj.shots) ? obj.shots : [];
  const result = new Map<number, string>();

  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const index = Number(record.index);
    const prompt = stripForbiddenPromptPhrases(str(record.videoPrompt));
    if (!Number.isFinite(index) || !prompt) continue;
    // 翻译稿自己也要过一遍基本体检，不合格就退回原文
    if (!isEnglishPrompt(prompt) || countWords(prompt) < 12) continue;
    result.set(Math.round(index), prompt);
  }

  if (result.size === 0) {
    void logAgentWarn('localize', { reason: '翻译稿全部不合格，保留原英文提示词' });
    return null;
  }

  const missing = input.shots.filter((shot) => !result.has(shot.index)).length;
  if (missing > 0) {
    void logAgentWarn('localize', { reason: '部分镜头没有拿到翻译稿', missing });
  }

  return result;
}
