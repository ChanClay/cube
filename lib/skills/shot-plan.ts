/**
 * 分镜时长规划（纯计算，前后端共用）
 *
 * 单镜时长区间由剧本选定的视频模型决定（见 lib/video-models）：
 * wan3.0 是 2~30 秒，HappyHorse 1.1 是 3~15 秒。所以「按总时长生成」时只能给出
 * 该模型下的合法区间，镜数由 AI 按剧情自己判断：串联性强的段落（同一空间、
 * 同一主体连续推进）放一个镜头里，需要断开的地方才切。由时长反推固定镜数会把
 * 连续动作硬切成等长的几段。
 */

import { videoModelSpec } from '@/lib/video-models';

/** 生成分镜的两种入口：直接给镜头数 / 只给视频总时长 */
export type ScriptMode = 'shots' | 'duration';

/** 一份剧本最多几镜（各模型目前一致，差异在单镜时长） */
export const MIN_SHOT_COUNT = 1;
export const MAX_SHOT_COUNT = 12;

/**
 * 某个视频模型的时长规划边界。
 *
 * 不传模型时按旧剧本处理（wan3.0），这样老数据的行为完全不变。
 */
export interface ShotLimits {
  minShot: number;
  maxShot: number;
  /** 单镜质量线：只写进提示词，不参与硬校验 */
  preferredShot: number;
  minShotCount: number;
  maxShotCount: number;
  minTotal: number;
  maxTotal: number;
}

export function shotLimits(videoModel?: string | null): ShotLimits {
  const spec = videoModelSpec(videoModel);
  return {
    minShot: spec.minShotSeconds,
    maxShot: spec.maxShotSeconds,
    preferredShot: spec.preferredShotSeconds,
    minShotCount: MIN_SHOT_COUNT,
    maxShotCount: spec.maxShotCount,
    minTotal: spec.minShotSeconds,
    maxTotal: spec.maxShotSeconds * spec.maxShotCount,
  };
}

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

/** 把总时长夹到该模型的合法范围，精度 1 秒 */
export function clampTotalDuration(
  totalDuration: number,
  limits: ShotLimits = shotLimits(),
): number {
  return clamp(
    Math.round(totalDuration || limits.minTotal),
    limits.minTotal,
    limits.maxTotal,
  );
}

export interface DurationSplit {
  /** 镜数下限：总时长不变时，单镜不超上限所必需的最少镜头数 */
  minShotCount: number;
  /** 单镜不低于下限所允许的最多镜头数（且不超过模型的镜数上限） */
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
 * 下限只按接口物理上限（单镜 maxShot）算，不再按质量线算：一镜到底的段落
 * 本来就该长，把它逼成 10 秒一刀只会把连续动作切碎。质量提示放在提示词里
 * （见 continuity.ts 的镜头数量规则），由 AI 自己权衡。
 */
export function splitByDuration(
  totalDuration: number,
  limits: ShotLimits = shotLimits(),
): DurationSplit {
  const total = clampTotalDuration(totalDuration, limits);
  /** 物理下限：单镜不超过上限所必需的镜头数 */
  const minShotCount = clamp(Math.ceil(total / limits.maxShot), 1, limits.maxShotCount);
  /** 单镜不低于下限所允许的镜头数上限 */
  const maxShotCount = clamp(
    Math.floor(total / limits.minShot),
    minShotCount,
    limits.maxShotCount,
  );

  return { minShotCount, maxShotCount, total };
}

/**
 * 已经知道实际镜头数时，把总时长重新摊平。
 * 模型多给/少给镜头时用它兜底，保证每镜仍在该模型的区间内：
 * - 镜头太多、单镜撑不到下限 → 返回值会比 count 短（调用方据此丢掉多余镜头）；
 * - 镜头太少、单镜超过上限 → 总时长会被压缩，只能保证每镜合法。
 */
export function fitDurations(
  total: number,
  count: number,
  limits: ShotLimits = shotLimits(),
): number[] {
  const safeTotal = clampTotalDuration(total, limits);
  const maxCount = clamp(
    Math.floor(safeTotal / limits.minShot),
    1,
    Math.max(1, Math.min(limits.maxShotCount, Math.round(count) || 1)),
  );
  const fitted = clamp(safeTotal, maxCount * limits.minShot, maxCount * limits.maxShot);
  return spreadDuration(fitted, maxCount);
}
