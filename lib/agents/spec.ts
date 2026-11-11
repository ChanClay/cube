/**
 * 影视语言规范：景别 / 运镜 / 提示词 / 台词的长度与格式约束。
 *
 * 这些规则以前散落在 continuity、storyboard、/api/shot/refine 三处，
 * 只要有一处忘了改，模型就会收到互相矛盾的指令。统一收在这里，
 * 同时提供确定性的规范化与检查函数，供三个 agent 共用。
 */

import type { ShotBeat } from '@/lib/types';

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

/**
 * 景别 → 提示词里的标准英文写法。
 * 翻译与校验共用同一张表，避免「中文写特写、英文写 wide shot」这种对不上的情况。
 */
export const SHOT_SIZE_EN: Record<string, string> = {
  大远景: 'extreme wide shot',
  远景: 'wide shot',
  全景: 'full shot',
  中景: 'medium shot',
  近景: 'medium close-up',
  特写: 'close-up',
};

/**
 * 运镜 → 英文表述。第一个是首选写法，其余是同义写法：
 * 校验时按整组比对（模型写 locked-off camera 不算错），翻译时只给第一个。
 */
export const CAMERA_MOVE_EN: Record<string, string[]> = {
  固定机位: ['static shot', 'static camera', 'locked-off camera', 'fixed camera'],
  缓慢推近: ['slow push-in', 'slow dolly in', 'slowly pushes in', 'push-in'],
  缓慢拉远: ['slow pull-out', 'slow dolly out', 'slowly pulls back', 'pull-out'],
  横向移动: ['lateral tracking shot', 'trucking shot', 'lateral move'],
  环绕: ['orbit shot', 'orbiting camera', 'arc shot'],
  跟随: ['tracking shot', 'follow shot', 'camera follows'],
  手持晃动: ['handheld camera', 'handheld shot'],
  升格慢动作: ['slow motion', 'slow-motion'],
};

export function shotSizeEn(size: string): string {
  return SHOT_SIZE_EN[size] ?? SHOT_SIZE_EN[DEFAULT_SHOT_SIZE];
}

export function cameraMoveEn(move: string): string {
  return (CAMERA_MOVE_EN[move] ?? CAMERA_MOVE_EN[DEFAULT_CAMERA_MOVE])[0];
}

/**
 * 提示词建议的英文单词数区间。
 * 上限留得比较宽：角色的固定英文外貌短语本身就 20~35 词（科幻 / 细节型角色尤其长），
 * 再叠场景短语与动作描述，90 词会逼模型删掉交代一致性的细节。
 */
export const PROMPT_MIN_WORDS = 40;
export const PROMPT_MAX_WORDS = 110;
/** 低于这个单词数视为不合格，会触发一次修复（比建议下限略宽，避免频繁返工） */
export const PROMPT_REPAIR_WORDS = 30;
/** 超过这个单词数视为啰嗦，会触发一次修复 */
export const PROMPT_REPAIR_MAX_WORDS = 150;

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
export const VIDEO_PROMPT_RULES = `videoPrompt 是同一镜中文 description 的忠实英译，不是重新创作：中文里写到的每个主体、动作、道具、环境、光线都必须在英文里有对应；中文里没有的元素一律不许增加，也不许删掉任何一个。
- 必须是英文，一段话，${PROMPT_MIN_WORDS}~${PROMPT_MAX_WORDS} 个单词，按这个顺序写：景别 + 主体（固定英文外貌短语）+ 具体动作 + 环境细节 + 光线 / 时间 / 色调 + 运镜 + 画面质感 +（可选）一句声音；
- 景别只用标准英文写法：${SHOT_SIZES.map((s) => `${SHOT_SIZE_EN[s]}（${s}）`).join(' / ')}，必须与 shotSize 一致；
- 只写一个运镜，用标准英文运镜词，且必须与 cameraMove 的中文含义一致（${CAMERA_MOVES.map((m) => `${m}=${CAMERA_MOVE_EN[m][0]}`).join('，')}）；
- 禁止字幕、文字、水印、logo、分屏、转场词、镜头编号（如 "shot 1" / "scene 2"）；
- 只写可拍摄的名词与动词，不要用 "beautiful" / "sad" 单独代替画面；
- 同一角色在全片复用同一段英文外貌短语，不要逐镜改写年龄、发型、服装与道具。`;

/**
 * 跨镜连贯性的写法约束。分镜写作与审片共用：
 * 连贯性不能靠「记得上一镜」，必须是一条写在纸上的状态链。
 */
export const CONTINUITY_RULES = `每个镜头都要显式写出 entryState 与 exitState，它们是状态链上唯一可靠的锚点：
- entryState：本镜第一帧能拍到的画面事实——谁、在哪、什么姿势、朝向哪里、手里拿着什么、画面里还有什么道具；非第一镜必须与上一镜的 exitState 是同一个状态（可以换措辞，但人物、位置、姿势、道具不能变）；
- exitState：本镜最后一帧的画面事实，必须能被下一镜直接接住；不许写情绪、心理或抽象判断；
- 上一镜没做完的动作，本镜接着做完；人物位置、道具、服装、光线不许在两镜之间凭空改变；
- 确实要跳时间或换场地时，本镜 entryState 里必须写清跳转（例：「片刻后，老陈已经站在塔顶，手里仍握着那盏油灯」）。`;

/**
 * 秒级节奏的写法约束。
 * 没有这一层时，一镜 20 秒只会得到一句「他在灯室里点灯」，
 * 生成出来就是一段半死不活的慢镜头——几秒该发生什么，必须写在纸上。
 */
export const TIMELINE_RULES = `每一镜都要写 beatSheet：把这一镜的 duration 切成 2~4 个秒级节拍，逐段交代「第几秒到第几秒、画面发生什么变化」。
- from / to 是相对本镜起点的秒数（整数或 .5），第一段 from 必须是 0，最后一段 to 必须等于 duration，中间既不能断档也不能重叠；
- 每段只写一个可见动作：抬眼、转头、伸手、握住、松手、后退、门开、灯灭、雨突然变大、镜头推到手部；
- 不许写「情绪渐强」「气氛变得紧张」「内心开始动摇」这类拍不出来的描述；
- 节奏按「大约每 3~5 秒一段」切：2~4 秒切 2 段，5~10 秒切 2~3 段，10~20 秒切 3~5 段，20 秒以上每 5 秒左右一段；
- 所有段落连起来读，必须正好是这个镜头完整的动作过程，不多不少；
- 动作要能对上这一镜的景别与运镜：特写只写手、眼、道具的细微变化；大远景里的"动作"是空间与光线的变化。`;

/** 表示时间 / 空间发生跳转的词；出现时允许 entryState 与上一镜 exitState 不一致 */
const TRANSITION_HINT =
  /(片刻后|稍后|随后|过了一会儿|次日|第二天|翌日|当天夜里|与此同时|镜头一转|转场|几年后|多年后|已在|已经站在|切换到)/;
const TRANSITION_HINT_EN =
  /\b(later|meanwhile|afterwards|the next (day|morning|night)|years later|cut to|transition)\b/i;

export function hasTransitionHint(text: string): boolean {
  return TRANSITION_HINT.test(text) || TRANSITION_HINT_EN.test(text);
}

/** 英文功能词：提取「关键内容词」时剔除，避免 a / the / with 干扰比对 */
const STOPWORDS_EN = new Set([
  'a', 'an', 'the', 'and', 'or', 'with', 'in', 'on', 'at', 'of', 'to', 'from', 'by', 'for',
  'his', 'her', 'their', 'its', 'he', 'she', 'they', 'it', 'is', 'are', 'was', 'were', 'be',
  'wearing', 'holds', 'holding', 'has', 'have', 'very', 'into', 'over', 'under', 'near',
  'who', 'that', 'this', 'as', 'while', 'warm', 'cold', 'soft', 'dim',
]);

/**
 * 从固定英文短语里提取关键内容词（≥3 字母、非功能词）。
 * 用于检查「这一镜的英文提示词有没有真的用上角色 / 场景的固定短语」。
 */
export function contentWords(phrase: string): string[] {
  const words = phrase.toLowerCase().match(/[a-z][a-z'-]{2,}/g) ?? [];
  const uniq = new Set(words.filter((word) => !STOPWORDS_EN.has(word)));
  return [...uniq];
}

/** 英文关键词在提示词里命中了几个 */
export function matchedWords(phrase: string, prompt: string): { hit: number; total: number } {
  const words = contentWords(phrase);
  if (words.length === 0) return { hit: 0, total: 0 };
  const text = prompt.toLowerCase();
  const hit = words.filter((word) => text.includes(word)).length;
  return { hit, total: words.length };
}

/** 提示词里用的运镜 / 景别是否与中文字段对得上 */
export function promptCameraMatches(prompt: string, cameraMove: string): boolean {
  const group = CAMERA_MOVE_EN[cameraMove];
  if (!group) return true;
  const text = prompt.toLowerCase();
  return group.some((word) => text.includes(word.toLowerCase()));
}

export function promptShotSizeMatches(prompt: string, shotSize: string): boolean {
  const expected = SHOT_SIZE_EN[shotSize];
  if (!expected) return true;
  const text = prompt.toLowerCase();
  if (text.includes(expected)) return true;
  // 近景 / 特写的英文边界很模糊（close-up 与 medium close-up 互相包含），算合格
  if ((shotSize === '近景' || shotSize === '特写') && text.includes('close-up')) return true;
  return false;
}

/**
 * 中文状态描述的字符 bigram 重合度（0~1）。
 * 用来粗略判断「本镜的入口状态」和「上一镜的出口状态」说的是不是同一件事：
 * 完全不重合通常意味着动作链断了（或模型换了措辞但丢了关键人物 / 道具）。
 */
export function stateOverlap(previous: string, current: string): number {
  const grams = (text: string): Set<string> => {
    const clean = text.replace(/[\s，。、；：！？,.;:!?（）()「」《》"']/g, '');
    const set = new Set<string>();
    for (let i = 0; i < clean.length - 1; i += 1) set.add(clean.slice(i, i + 2));
    return set;
  };
  const a = grams(previous);
  const b = grams(current);
  if (a.size === 0 || b.size === 0) return 1;
  let shared = 0;
  for (const gram of b) if (a.has(gram)) shared += 1;
  return shared / b.size;
}

/** 一镜最多保留几段节拍（30 秒长镜按每 5 秒一段约 6 段，留一点余量） */
const MAX_BEAT_SEGMENTS = 8;

const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * 秒级节拍的确定性收口：
 * 排序、夹到 [0, duration]、补掉空隙、掐掉越界段，并强制首段从 0 开始、末段到 duration 结束。
 * 模型给的时间轴经常差一点（不从 0 开始、最后一段少一秒），与其让它重写，
 * 不如在这里直接算准——时间轴必须能对上视频的真实时长。
 */
export function normalizeBeatSheet(raw: unknown, duration: number): ShotBeat[] | undefined {
  if (!Array.isArray(raw)) return undefined;

  const total = Number.isFinite(duration) && duration > 0 ? duration : 5;
  const items: ShotBeat[] = [];

  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const action = str(record.action ?? record.desc ?? record.content);
    if (!action) continue;

    const from = Number(record.from ?? record.start ?? record.at);
    const to = Number(record.to ?? record.end);
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue;

    items.push({ from: round1(from), to: round1(to), action });
  }
  if (items.length === 0) return undefined;

  items.sort((a, b) => a.from - b.from);

  const result: ShotBeat[] = [];
  let cursor = 0;
  for (const item of items) {
    if (cursor >= total) break;
    // 整段都落在已覆盖区间里：模型写了重叠或超前的段，丢掉
    if (item.to <= cursor) continue;

    // 每段都从上一段的结束处开始：时间轴不允许留白，有空洞就由这一段吞掉
    const from = cursor;
    const to = clamp(Math.max(item.to, from + 0.5), from, total);
    result.push({ from: round1(from), to: round1(to), action: item.action });
    cursor = to;
    if (result.length >= MAX_BEAT_SEGMENTS) break;
  }

  if (result.length === 0) return undefined;

  result[0].from = 0;
  result[result.length - 1].to = round1(total);

  const cleaned = result.filter((beat) => beat.to > beat.from);
  return cleaned.length > 0 ? cleaned : undefined;
}

/** 秒 → 时间码（成片里的绝对位置，如 01:23） */
export function formatTimecode(seconds: number): string {
  const safe = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(safe / 60);
  return `${String(minutes).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
}
