/**
 * 分镜时长规划（纯计算，前后端共用）
 *
 * 视频模型单镜 2~30 秒（wan3.0），所以「按总时长生成」时镜头数量由总时长反推：
 * - 保证完整性：镜头数取最少，每镜尽量凑满 30 秒，节奏由时长决定；
 * - 不保证完整性：只给 AI 一个合法区间，镜数由它按剧情自己判断。
 */

/** 生成分镜的两种入口：直接给镜头数 / 只给视频总时长 */
export type ScriptMode = 'shots' | 'duration';

/** 单镜最长 30 秒（wan3.0 上限） */
export const MAX_SHOT_SECONDS = 30;
/** 单镜最短 2 秒（wan3.0 下限） */
export const MIN_SHOT_SECONDS = 2;
/** 一份剧本最多 12 镜：对齐 30 秒 × 12 = 360 秒的长度上限 */
export const MAX_SHOT_COUNT = 12;
/** 视频总时长上限：12 镜 × 30 秒 */
export const MAX_TOTAL_SECONDS = MAX_SHOT_SECONDS * MAX_SHOT_COUNT;
/** 视频总时长下限：不能再短于一个合法镜头（2 秒） */
export const MIN_TOTAL_SECONDS = MIN_SHOT_SECONDS;

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
  /**
   * true：镜头数量交给 AI 按剧情判断（关闭「保证完整性」），
   * 此时 shotCount / durations 不可用，只约束 minShotCount ~ maxShotCount 与总时长。
   */
  dynamic: boolean;
  /** 固定镜头数（dynamic=false 时有效） */
  shotCount: number;
  /** 总时长不变时，单镜不超 30 秒所必需的最少镜头数 */
  minShotCount: number;
  /** 单镜不低于 2 秒所允许的最多镜头数（且不超过 12） */
  maxShotCount: number;
  /** 每镜目标时长（dynamic=true 时为空，由 AI 分配） */
  durations: number[];
  /** 规划后的总时长（已夹到合法范围） */
  total: number;
}

/**
 * 按总时长拆分镜头：
 * - ensureCompleteness = true（默认）：镜头数取最少 ceil(总时长 / 30)，每镜尽量凑满 30 秒；
 * - ensureCompleteness = false：不预设镜头数，只给出 AI 可以决定的区间，由它按剧情判断切几刀。
 * 两种方式都保证单镜 2~30 秒、镜头数 1~12。
 */
export function splitByDuration(totalDuration: number, ensureCompleteness = true): DurationSplit {
  const total = clampTotalDuration(totalDuration);
  /** 单镜不超过 30 秒所必需的镜头数 */
  const minShotCount = clamp(Math.ceil(total / MAX_SHOT_SECONDS), 1, MAX_SHOT_COUNT);
  /** 单镜不低于 2 秒所允许的镜头数上限 */
  const maxShotCount = clamp(
    Math.floor(total / MIN_SHOT_SECONDS),
    minShotCount,
    MAX_SHOT_COUNT,
  );

  if (!ensureCompleteness) {
    return {
      dynamic: true,
      shotCount: 0,
      minShotCount,
      maxShotCount,
      durations: [],
      total,
    };
  }

  return {
    dynamic: false,
    shotCount: minShotCount,
    minShotCount,
    maxShotCount,
    durations: spreadDuration(total, minShotCount),
    total,
  };
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
