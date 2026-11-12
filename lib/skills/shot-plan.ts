/**
 * 分镜时长规划（纯计算，前后端共用）
 *
 * 视频模型单镜 2~30 秒（wan3.0），所以「按总时长生成」时只能给出一个合法区间，
 * 镜数由 AI 按剧情自己判断：串联性强的段落（同一空间、同一主体连续推进）放一个镜头里，
 * 需要断开的地方才切。由时长反推固定镜数会把连续动作硬切成等长的几段。
 */

/** 生成分镜的两种入口：直接给镜头数 / 只给视频总时长 */
export type ScriptMode = 'shots' | 'duration';

/** 单镜最长 30 秒（wan3.0 上限） */
export const MAX_SHOT_SECONDS = 30;
/** 单镜最短 2 秒（wan3.0 下限） */
export const MIN_SHOT_SECONDS = 2;

/**
 * 单镜「一次生成」的质量线（秒）。
 *
 * 30 秒是接口上限，不是质量上限：一次生成的时间越长，后半段的动作越容易变慢、
 * 变形、人物肢体开始糊在一起，看起来就是「不流畅」；10 秒以内基本能保持匀速运动
 * 和稳定构图。这条只写进提示词供 AI 权衡，不再用来反推镜头数——一镜到底的连续
 * 段落本来就该长，硬按 10 秒切只会把动作切碎。
 */
export const PREFERRED_SHOT_SECONDS = 10;
/** 一份剧本最多 12 镜：对齐 30 秒 × 12 = 360 秒的长度上限 */
export const MIN_SHOT_COUNT = 1;
export const MAX_SHOT_COUNT = 12;
/** 视频总时长上限：12 镜 × 30 秒 */
export const MAX_TOTAL_SECONDS = MAX_SHOT_SECONDS * MAX_SHOT_COUNT;
/** 视频总时长下限：不能再短于一个合法镜头（2 秒） */
export const MIN_TOTAL_SECONDS = MIN_SHOT_SECONDS;

/**
 * 小说 / 章节改编的输入长度（前后端共用）：
 * - 太短算不上「小说片段」，直接当创意写更合适；
 * - 太长会超出单次改编的处理能力，建议先选一章。
 */
export const MIN_NOVEL_CHARS = 200;
export const MAX_NOVEL_CHARS = 30000;

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/** 把总时长平均摊到 count 个镜头上，余数从前往后各加 1 秒 */
export function spreadDuration(total: number, count: number): number[] {
  const safeCount = Math.max(1, Math.round(count));
  const safeTotal = Math.max(0, Math.round(total));
  const base = Math.floor(safeTotal / safeCount);
  const rest = safeTotal - base * safeCount;
  return Array.from({ length: safeCount }, (_, i) => base + (i < rest ? 1 : 0));
}

/** 把总时长夹到合法范围（2~360 秒），精度 1 秒 */
export function clampTotalDuration(totalDuration: number): number {
  return clamp(
    Math.round(totalDuration || MIN_TOTAL_SECONDS),
    MIN_TOTAL_SECONDS,
    MAX_TOTAL_SECONDS,
  );
}

export interface DurationSplit {
  /** 镜数下限：总时长不变时，单镜不超 MAX_SHOT_SECONDS 所必需的最少镜头数 */
  minShotCount: number;
  /** 单镜不低于 2 秒所允许的最多镜头数（且不超过 12） */
  maxShotCount: number;
  /** 规划后的总时长（已夹到合法范围） */
  total: number;
}

/**
 * 按总时长规划镜头区间：不预设镜数，只给出 AI 可以决定的 minShotCount ~ maxShotCount
 * 与总时长，由它按剧情判断切几刀。
 *
 * 以前有个「保证完整性」开关，会强制 ceil(总时长 / 10) 镜并把秒数摊平；等长的镜头
 * 装不下连续动作，串联性强的段落只能被硬切成几段，这是越切越碎的直接原因。
 *
 * 下限只按接口物理上限（单镜 30 秒）算，不再按 10 秒的质量线算：一镜到底的段落
 * 本来就该长，把它逼成 10 秒一刀只会把连续动作切碎。质量提示放在提示词里
 * （见 continuity.ts 的镜头数量规则），由 AI 自己权衡。
 */
export function splitByDuration(totalDuration: number): DurationSplit {
  const total = clampTotalDuration(totalDuration);
  /** 物理下限：单镜不超过 MAX_SHOT_SECONDS 所必需的镜头数 */
  const minShotCount = clamp(Math.ceil(total / MAX_SHOT_SECONDS), 1, MAX_SHOT_COUNT);
  /** 单镜不低于 2 秒所允许的镜头数上限 */
  const maxShotCount = clamp(
    Math.floor(total / MIN_SHOT_SECONDS),
    minShotCount,
    MAX_SHOT_COUNT,
  );

  return { minShotCount, maxShotCount, total };
}

/**
 * 已经知道实际镜头数时，把总时长重新摊平。
 * 模型多给/少给镜头时用它兜底，保证每镜仍在 2~30 秒：
 * - 镜头太多、单镜撑不到 2 秒 → 返回值会比 count 短（调用方据此丢掉多余镜头）；
 * - 镜头太少、单镜超过 30 秒 → 总时长会被压缩，只能保证每镜合法。
 */
export function fitDurations(total: number, count: number): number[] {
  const safeTotal = clampTotalDuration(total);
  const maxCount = clamp(
    Math.floor(safeTotal / MIN_SHOT_SECONDS),
    1,
    Math.max(1, Math.min(MAX_SHOT_COUNT, Math.round(count) || 1)),
  );
  const fitted = clamp(safeTotal, maxCount * MIN_SHOT_SECONDS, maxCount * MAX_SHOT_SECONDS);
  return spreadDuration(fitted, maxCount);
}
