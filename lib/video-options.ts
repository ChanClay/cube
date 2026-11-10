/**
 * 画幅与画质：由每个项目在创建时选定（存在 projects 表），
 * 生成视频时按项目设置提交，不再写死在 .env 里。
 *
 * wan3.0 的 resolution 只认 480P / 720P / 1080P，ratio 是画幅比例。
 * 带首帧 / 尾帧的镜头由素材决定画面比例，服务端会强制用 adaptive。
 */

export const VIDEO_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'] as const;
export type VideoRatio = (typeof VIDEO_RATIOS)[number];

export const VIDEO_RESOLUTIONS = ['480p', '720p', '1080p'] as const;
export type VideoResolution = (typeof VIDEO_RESOLUTIONS)[number];

export const DEFAULT_VIDEO_RATIO: VideoRatio = '16:9';
export const DEFAULT_VIDEO_RESOLUTION: VideoResolution = '480p';

export const RATIO_LABEL: Record<VideoRatio, string> = {
  '16:9': '16:9 横屏',
  '9:16': '9:16 竖屏',
  '1:1': '1:1 方形',
  '4:3': '4:3 传统横屏',
  '3:4': '3:4 竖版',
  '21:9': '21:9 宽银幕',
};

export const RESOLUTION_LABEL: Record<VideoResolution, string> = {
  '480p': '480p 标清（更快更省）',
  '720p': '720p 高清',
  '1080p': '1080p 超清（更慢更贵）',
};

const isRatio = (value: unknown): value is VideoRatio =>
  typeof value === 'string' && (VIDEO_RATIOS as readonly string[]).includes(value);

const isResolution = (value: unknown): value is VideoResolution =>
  typeof value === 'string' && (VIDEO_RESOLUTIONS as readonly string[]).includes(value);

/** 外部输入（接口 / 旧数据）落库前统一校验 */
export function normalizeRatio(value: unknown, fallback: VideoRatio = DEFAULT_VIDEO_RATIO): VideoRatio {
  return isRatio(value) ? value : fallback;
}

export function normalizeResolution(
  value: unknown,
  fallback: VideoResolution = DEFAULT_VIDEO_RESOLUTION,
): VideoResolution {
  return isResolution(value) ? value : fallback;
}

/** 各画质档在 16:9 下的基准尺寸，其他比例按高度换算 */
const BASE_SIZE: Record<VideoResolution, { w: number; h: number }> = {
  '480p': { w: 832, h: 480 },
  '720p': { w: 1280, h: 720 },
  '1080p': { w: 1920, h: 1080 },
};

/** ffmpeg 的 H.264 要求宽高为偶数 */
const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);

/** 合成导出尺寸：宽高会跟随项目选的画幅 / 画质 */
export function exportSize(resolution: string, ratio: string): string {
  const res = normalizeResolution(resolution);
  const rat = normalizeRatio(ratio);
  const base = BASE_SIZE[res];

  switch (rat) {
    case '9:16':
      return `${base.h}x${base.w}`;
    case '1:1':
      return `${even(base.h)}x${even(base.h)}`;
    case '4:3':
      return `${even((base.h * 4) / 3)}x${base.h}`;
    case '3:4':
      return `${even((base.h * 3) / 4)}x${base.h}`;
    case '21:9':
      return `${even((base.h * 21) / 9)}x${base.h}`;
    default:
      return `${base.w}x${base.h}`;
  }
}
