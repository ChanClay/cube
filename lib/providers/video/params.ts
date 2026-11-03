import type { JobStatus } from '@/lib/types';

/**
 * 原生 DashScope（wan.ts）与 OpenAI 风格网关（compat.ts）共用的参数换算。
 * 两家协议字段名不同，但「时长 / 分辨率 / 比例」的业务含义一致，统一在这里归一。
 */

export const DEFAULT_MODEL = 'wan3.0-video';
export const DEFAULT_RATIO = 'adaptive';

const VALID_RATIOS = new Set(['21:9', '16:9', '4:3', '1:1', '3:4', '9:16', 'adaptive']);

/** 统一成 480P / 720P / 1080P */
export function toResolution(resolution: string): string {
  const value = (resolution || '').trim().toUpperCase();

  if (/^\d+P$/.test(value)) return value;

  // 兼容 1280*720 / 720x1280 这类像素尺寸，按短边判断档位
  const match = value.match(/[*X×](\d+)/);
  if (match) {
    const side = Number(match[1]);
    if (side >= 1000) return '1080P';
    if (side >= 700) return '720P';
    return '480P';
  }

  return '720P';
}

export function toRatio(ratio: string): string {
  const value = (ratio || '').trim();
  return VALID_RATIOS.has(value) ? value : DEFAULT_RATIO;
}

/** wan3.0 支持 2~30 秒 */
export function toDuration(duration: number): number {
  const value = Math.round(Number(duration));
  if (!Number.isFinite(value) || value <= 0) return 5;
  return Math.min(30, Math.max(2, value));
}

/** DashScope 原生异步任务状态 */
export function mapDashScopeStatus(raw: string | undefined): JobStatus {
  switch ((raw ?? '').toUpperCase()) {
    case 'PENDING':
      return 'queued';
    case 'RUNNING':
      return 'running';
    case 'SUCCEEDED':
      return 'succeeded';
    default:
      return 'failed';
  }
}

/**
 * OpenAI 风格网关的任务状态（Sora 兼容：queued / in_progress / completed / failed）。
 * 交给网关的上游模型五花八门，这里放宽到常见同义词。
 */
export function mapGatewayStatus(raw: string | undefined): JobStatus {
  switch ((raw ?? '').toLowerCase()) {
    case 'queued':
    case 'pending':
    case 'created':
    case 'submitted':
      return 'queued';
    case 'in_progress':
    case 'processing':
    case 'running':
      return 'running';
    case 'completed':
    case 'complete':
    case 'succeeded':
    case 'success':
      return 'succeeded';
    default:
      return 'failed';
  }
}

/** 各档位的长边像素（与 wan2.x / wan3.0 的常用尺寸对齐） */
const LONG_SIDE: Record<string, number> = { '480P': 832, '720P': 1280, '1080P': 1920 };

const RATIO_VALUE: Record<string, number> = {
  '21:9': 21 / 9,
  '16:9': 16 / 9,
  '4:3': 4 / 3,
  '1:1': 1,
  '3:4': 3 / 4,
  '9:16': 9 / 16,
  adaptive: 16 / 9,
};

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/**
 * 网关的 `/v1/videos` 只接受 `size`（如 832x480），没有 resolution + ratio 两段式参数，
 * 所以按「档位决定长边、比例决定宽高」折算一次。
 */
export function toSize(resolution: string, ratio: string): string {
  const long = LONG_SIDE[toResolution(resolution)] ?? LONG_SIDE['720P'];
  const value = RATIO_VALUE[toRatio(ratio)] ?? RATIO_VALUE['16:9'];

  const width = value >= 1 ? long : long * value;
  const height = value >= 1 ? long / value : long;
  return `${even(width)}x${even(height)}`;
}
