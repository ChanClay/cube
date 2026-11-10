/**
 * 影视语言规范：景别 / 运镜 / 提示词 / 台词的长度与格式约束。
 *
 * 这些规则以前散落在 continuity、storyboard、/api/shot/refine 三处，
 * 只要有一处忘了改，模型就会收到互相矛盾的指令。统一收在这里，
 * 同时提供确定性的规范化与检查函数，供三个 agent 共用。
 */

/** 从远到近；也是提示词里推荐的情绪推进顺序 */
export const SHOT_SIZES = ['大远景', '远景', '全景', '中景', '近景', '特写'] as const;
export const CAMERA_MOVES = [
  '固定机位',
  '缓慢推近',
  '缓慢拉远',
  '横向移动',
  '环绕',
  '跟随',
  '手持晃动',
  '升格慢动作',
] as const;

export const DEFAULT_SHOT_SIZE = '中景';
export const DEFAULT_CAMERA_MOVE = '固定机位';

/** 提示词建议的英文单词数区间 */
export const PROMPT_MIN_WORDS = 40;
export const PROMPT_MAX_WORDS = 90;
/** 低于这个单词数视为不合格，会触发一次修复（比建议下限略宽，避免频繁返工） */
export const PROMPT_REPAIR_WORDS = 30;
/** 超过这个单词数视为啰嗦，会触发一次修复 */
export const PROMPT_REPAIR_MAX_WORDS = 130;

/** 台词里会破坏结构的角色前缀，例如「旁白：」 */
const NARRATION_PREFIX = /^(旁白|画外音|字幕|台词|独白|对白)\s*[:：]\s*/;

/** 字幕 / 水印 / 分屏等不该出现在画面提示词里的东西 */
const FORBIDDEN_PROMPT =
  /(\bsubtitles?\b|\bcaptions?\b|\bwatermarks?\b|\blogos?\b|\bon-screen text\b|\btext overlay\b|\bsplit[- ]screen\b|\bstoryboard\b|\bshot\s*\d+\b|\bscene\s*\d+\b)/i;

export const str = (v: unknown, fallback = ''): string =>
  typeof v === 'string' && v.trim() ? v.trim() : fallback;

export const clamp = (n: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, n));

export function normalizeShotSize(value: unknown): string {
  const size = str(value);
  return (SHOT_SIZES as readonly string[]).includes(size) ? size : DEFAULT_SHOT_SIZE;
}

export function normalizeCameraMove(value: unknown): string {
  const move = str(value);
  return (CAMERA_MOVES as readonly string[]).includes(move) ? move : DEFAULT_CAMERA_MOVE;
}

/** 按 name 去重，保留第一次出现的顺序（模型经常把同一角色 / 场景写两遍） */
export function dedupeByName<T extends { name: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const key = item.name.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

/**
 * 英文字符与中文汉字占比，用来判断提示词是不是「真英文」。
 * 允许少量汉字（角色名可能是「老陈」），但不接受中文长句。
 */
export function isEnglishPrompt(text: string): boolean {
  const letters = (text.match(/[A-Za-z]/g) ?? []).length;
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  if (letters < 20) return false;
  return cjk / (letters + cjk) <= 0.12;
}

/** 粗略统计英文单词数（按字母/数字开头的切分，标点不计） */
export function countWords(text: string): number {
  return (text.match(/[A-Za-z0-9][A-Za-z0-9'’\-]*/g) ?? []).length;
}

export function hasForbiddenPromptPhrase(prompt: string): boolean {
  return FORBIDDEN_PROMPT.test(prompt);
}

/**
 * 逐段删掉包含禁用词的描述（按逗号切分）。
 * 例如 "a rainy street, no subtitles, cold blue grade" → "a rainy street, cold blue grade"。
 */
export function stripForbiddenPromptPhrases(prompt: string): string {
  if (!hasForbiddenPromptPhrase(prompt)) return prompt;
  return prompt
    .split(/\s*,\s*/)
    .filter((segment) => segment.trim() && !FORBIDDEN_PROMPT.test(segment))
    .join(', ')
    .trim();
}

/**
 * 一镜能说多少字，跟着时长走：5 秒约 20 字，30 秒最多 60 字。
 * 超长的台词会被截到最近的句读处——视频模型不会因为台词长就放慢语速，
 * 只会让后半句被硬生生吞掉。
 */
export function narrationLimit(duration: number): number {
  const safe = Number.isFinite(duration) && duration > 0 ? duration : 5;
  return Math.min(60, Math.max(16, Math.round(safe * 4)));
}

export function trimNarration(text: unknown, duration = 5): string {
  let clean = str(text).replace(NARRATION_PREFIX, '').trim();
  clean = clean.replace(/^["“](.*)["”]$/, '$1').trim();
  if (!clean) return '';

  const limit = narrationLimit(duration);
  if (clean.length <= limit) return clean;

  const head = clean.slice(0, limit);
  const cut = Math.max(
    head.lastIndexOf('。'),
    head.lastIndexOf('！'),
    head.lastIndexOf('？'),
    head.lastIndexOf('；'),
    head.lastIndexOf('，'),
    head.lastIndexOf('…'),
  );
  return cut >= 8 ? head.slice(0, cut + 1) : head;
}

/** 景别 / 运镜的合法取值说明，拼进提示词用 */
export const SHOT_LANGUAGE_RULES =
  `shotSize 只能用：${SHOT_SIZES.join(' / ')}；` +
  `cameraMove 只能用：${CAMERA_MOVES.join(' / ')}。`;

/**
 * 视频提示词的写法约束。storyboard 与单镜重算共用同一份，
 * 避免两处对「多少词、写什么顺序」给出不同要求。
 */
export const VIDEO_PROMPT_RULES = `videoPrompt 必须是英文，一段话，${PROMPT_MIN_WORDS}~${PROMPT_MAX_WORDS} 个单词，按顺序描述：景别 + 主体（固定英文外貌短语）+ 具体动作 + 环境细节 + 光线 / 时间 / 色调 + 运镜 + 画面质感 +（可选）一句声音。
- 只写一个运镜，且必须与 cameraMove 的中文含义一致；
- 禁止字幕、文字、水印、logo、分屏、转场词、镜头编号（如 "shot 1" / "scene 2"）；
- 只写可拍摄的名词与动词，不要用 "beautiful" / "sad" 单独代替画面；
- 同一角色在全片复用同一段英文外貌短语，不要逐镜改写年龄、发型、服装与道具。`;
