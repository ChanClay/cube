import { config } from '@/lib/config';
import type { JobStatus, MediaInput, MediaType } from '@/lib/types';
import { videoModelSpec } from '@/lib/video-models';
import type { CreateVideoInput, VideoProvider, VideoTaskState } from './types';

/**
 * 火山方舟（Volcengine Ark）· Doubao Seedance
 *
 * 创建任务：POST {base}/contents/generations/tasks   Header: Authorization: Bearer <key>
 * 查询任务：GET  {base}/contents/generations/tasks/{id}
 *
 * 和百炼的两个模型完全不同的一套协议：素材与提示词一起放在 `content` 数组里，
 * 用 `role` 标明用途；分辨率 / 画幅 / 时长是 body 顶层字段（不是 `parameters`）。
 *
 * 请求示例（首尾帧）：
 * {
 *   "model": "doubao-seedance-2-5-260628",
 *   "content": [
 *     { "type": "text", "text": "……" },
 *     { "type": "image_url", "image_url": { "url": "https://…" }, "role": "first_frame" },
 *     { "type": "image_url", "image_url": { "url": "https://…" }, "role": "last_frame" }
 *   ],
 *   "resolution": "720p",
 *   "duration": 5,
 *   "generate_audio": true,
 *   "watermark": false
 * }
 *
 * 三种场景**互斥**（首帧 / 首尾帧 / 全模态参考），混用会被接口整单拒掉，
 * 所以和 HappyHorse 一样按素材自动分流（见 `planMedia`）。
 *
 * 能力随模型版本变化，这里按 Seedance 2.5 的能力实现：
 * - 时长 [4, 30] 秒；resolution 480p / 720p / 1080p；
 * - ratio 支持 21:9 / 16:9 / 4:3 / 1:1 / 3:4 / 9:16 / adaptive；
 *   首帧 / 首尾帧任务的画幅只能 adaptive（跟随首帧），这类请求干脆不传 ratio；
 * - `generate_audio` 默认 true，可关；1.0 系列没有这个参数（见 supportsAudio）；
 * - 参考素材支持图片 / 视频 / 音频，但不支持文档、网页。
 *
 * 换成 1.0 pro（2~12 秒、无 generate_audio、参考素材只有图片）时，
 * 记得同步改 lib/video-models.ts 的时长区间。
 */

const DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';
/** 时长区间与剧本规划共用同一份能力表，避免两处漂移 */
const SPEC = videoModelSpec('seedance-2.5');
const MIN_DURATION = SPEC.minShotSeconds;
const MAX_DURATION = SPEC.maxShotSeconds;
const VALID_RATIOS = new Set(['21:9', '16:9', '4:3', '1:1', '3:4', '9:16', 'adaptive']);
/** 与 lib/skills/media.ts 的 reference_image 上限保持一致（2.5 接口本身允许 30 张） */
const MAX_REFERENCE_IMAGES = 9;

type ContentItem =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string }; role?: 'first_frame' | 'last_frame' | 'reference_image' }
  | { type: 'video_url'; video_url: { url: string }; role: 'reference_video' }
  | { type: 'audio_url'; audio_url: { url: string }; role: 'reference_audio' };

export interface MediaPlan {
  /**
   * - t2v：纯文本
   * - frames：首帧 / 首尾帧
   * - reference：全模态参考（图片 / 视频 / 音频）
   */
  mode: 't2v' | 'frames' | 'reference';
  items: ContentItem[];
  /** 被摘掉的素材（Seedance 不支持的，以及和当前场景互斥的） */
  dropped: MediaType[];
}

/** 统一成 480p / 720p / 1080p（这个接口用小写） */
function toResolution(resolution: string): string {
  const value = (resolution || '').trim().toLowerCase();

  if (/^(480p|720p|1080p)$/.test(value)) return value;

  // 兼容 1280*720 / 720x1280 这类像素尺寸，按短边判断档位
  const match = value.match(/[*x×](\d+)/);
  if (match) {
    const side = Number(match[1]);
    if (side >= 1000) return '1080p';
    if (side >= 700) return '720p';
    return '480p';
  }

  return '720p';
}

function toRatio(ratio: string): string {
  const value = (ratio || '').trim();
  return VALID_RATIOS.has(value) ? value : '16:9';
}

/** 2.5 / 2.0 系列支持 4~30 秒；1.0 pro 是 2~12 秒 */
function toDuration(duration: number): number {
  const value = Math.round(Number(duration));
  if (!Number.isFinite(value) || value <= 0) return 5;
  return Math.min(MAX_DURATION, Math.max(MIN_DURATION, value));
}

/**
 * 只有 2.0 / 2.5 系列有 `generate_audio`。
 * 1.0 pro 系列是无声模型，传了这个字段会被当非法参数。
 */
function supportsAudio(model: string): boolean {
  return !/seedance-1-0/i.test(model);
}

function mapStatus(raw: string | undefined): JobStatus {
  switch ((raw ?? '').toLowerCase()) {
    case 'queued':
      return 'queued';
    case 'running':
      return 'running';
    case 'succeeded':
      return 'succeeded';
    case 'cancelled':
    case 'canceled':
      return 'canceled';
    default:
      // failed / expired（超过 execution_expires_after）
      return 'failed';
  }
}

/**
 * 把方舟的英文报错翻成人话。
 *
 * 最常见的是内容审核：错误码以 `…SensitiveContentDetected` 结尾，
 * 输出侧（OutputVideoSensitiveContentDetected）说明画面已经生成但被拦下。
 */
function explainProviderError(message: string, code?: string): string {
  const raw = message || code || '视频生成失败';
  const haystack = `${message} ${code ?? ''}`;
  if (!/sensitive|risk|moderation/i.test(haystack)) return raw;

  const target = /input/i.test(code ?? '') ? '输入素材' : '生成的画面';
  return `内容安全审核未通过：${target}被火山方舟拦截（原文 ${raw}）。请改写提示词或更换素材，避开真人面部、血腥、恐怖、暴露等敏感内容后重试`;
}

/** 同一张图 / 同一段素材不重复提交 */
function uniqueByUrl(items: MediaInput[]): MediaInput[] {
  const seen = new Set<string>();
  const result: MediaInput[] = [];
  for (const item of items) {
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    result.push(item);
  }
  return result;
}

/**
 * 素材 → 生成场景。
 *
 * - 有任一 `reference_*`：走全模态参考。首帧 / 尾帧此时必须摘掉
 *   （接口规定三种场景互斥，混着传会整单 400）；
 * - 只有帧图：走首尾帧。只有尾帧时当首帧用（接口没有「只给尾帧」的场景）；
 * - 什么都没有：走文生视频。
 */
export function planMedia(media: MediaInput[]): MediaPlan {
  const firstFrame = media.find((item) => item.type === 'first_frame');
  const lastFrame = media.find((item) => item.type === 'last_frame');
  const references = uniqueByUrl(
    media.filter(
      (item) =>
        item.type === 'reference_image' ||
        item.type === 'reference_video' ||
        item.type === 'reference_audio',
    ),
  );
  const unsupported = media
    .filter((item) => item.type === 'file' || item.type === 'link')
    .map((item) => item.type);

  if (references.length > 0) {
    const dropped: MediaType[] = [...unsupported];
    if (firstFrame) dropped.push('first_frame');
    if (lastFrame) dropped.push('last_frame');

    const items: ContentItem[] = [];
    for (const item of references) {
      if (item.type === 'reference_image') {
        items.push({ type: 'image_url', image_url: { url: item.url }, role: 'reference_image' });
      } else if (item.type === 'reference_video') {
        items.push({ type: 'video_url', video_url: { url: item.url }, role: 'reference_video' });
      } else {
        items.push({ type: 'audio_url', audio_url: { url: item.url }, role: 'reference_audio' });
      }
    }
    return { mode: 'reference', items, dropped };
  }

  if (firstFrame || lastFrame) {
    const items: ContentItem[] = [
      {
        type: 'image_url',
        image_url: { url: (firstFrame ?? lastFrame)!.url },
        role: 'first_frame',
      },
    ];
    const dropped: MediaType[] = [...unsupported];
    if (firstFrame && lastFrame) {
      items.push({ type: 'image_url', image_url: { url: lastFrame.url }, role: 'last_frame' });
    } else if (!firstFrame) {
      dropped.push('last_frame');
    }
    return { mode: 'frames', items, dropped };
  }

  return { mode: 't2v', items: [], dropped: unsupported };
}

export class SeedanceProvider implements VideoProvider {
  readonly name = 'seedance';

  get model(): string {
    return config.video.seedance.model;
  }

  private get baseUrl(): string {
    return config.video.seedance.baseUrl || DEFAULT_BASE_URL;
  }

  private headers(): Record<string, string> {
    if (!config.video.seedance.apiKey) {
      throw new Error(
        '未配置 VIDEO_SEEDANCE_API_KEY（火山方舟 API Key），请填入 .env.local 后重启服务',
      );
    }
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.video.seedance.apiKey}`,
    };
  }

  private buildBody(input: CreateVideoInput, plan: MediaPlan) {
    if (Number(input.duration) > MAX_DURATION) {
      console.warn(
        `[video:seedance] 单镜时长 ${input.duration}s 超过上限 ${MAX_DURATION}s，已按 ${MAX_DURATION}s 提交`,
      );
    }

    const model = this.model;
    const frames = plan.mode === 'frames';

    return {
      model,
      content: [{ type: 'text' as const, text: input.prompt }, ...plan.items],
      resolution: toResolution(input.resolution),
      // 首帧 / 首尾帧的画幅由首帧决定：显式传 ratio 会被拒单
      ...(frames ? {} : { ratio: toRatio(input.ratio || config.video.ratio) }),
      duration: toDuration(input.duration),
      ...(supportsAudio(model) ? { generate_audio: input.audio ?? config.video.audio } : {}),
      watermark: config.video.watermark,
    };
  }

  async createTask(input: CreateVideoInput): Promise<{ providerJobId: string }> {
    const url = `${this.baseUrl}/contents/generations/tasks`;
    const plan = planMedia(input.media ?? []);
    const body = this.buildBody(input, plan);

    if (plan.dropped.length > 0) {
      console.warn(
        `[video:seedance] 以下素材类型 Seedance 不支持或与当前场景互斥，已忽略：${plan.dropped.join(', ')}（镜头 ${input.prompt.slice(0, 40)}）`,
      );
    }
    const referenceImages = plan.items.filter(
      (item) => item.type === 'image_url' && item.role === 'reference_image',
    ).length;
    if (referenceImages > MAX_REFERENCE_IMAGES) {
      console.warn(
        `[video:seedance] 参考图 ${referenceImages} 张，超过本地约定的 ${MAX_REFERENCE_IMAGES} 张上限`,
      );
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });

    const raw = await res.text();
    if (!res.ok) {
      throw new Error(
        `Seedance 创建视频任务失败（${plan.mode} / ${body.model} / ${res.status}）：${raw.slice(0, 400) || '接口返回空内容'}`,
      );
    }

    let data: { id?: string; error?: { code?: string; message?: string } };
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error(`Seedance 返回内容无法解析：${raw.slice(0, 200)}`);
    }

    if (!data.id) {
      throw new Error(
        `Seedance 未返回任务 ID：${data.error?.message ?? raw.slice(0, 200)}`,
      );
    }
    return { providerJobId: data.id };
  }

  async getTask(providerJobId: string): Promise<VideoTaskState> {
    const res = await fetch(
      `${this.baseUrl}/contents/generations/tasks/${encodeURIComponent(providerJobId)}`,
      {
        headers: this.headers(),
        signal: AbortSignal.timeout(30000),
        cache: 'no-store',
      },
    );

    const raw = await res.text();
    if (!res.ok) {
      throw new Error(`Seedance 查询任务失败（${res.status}）：${raw.slice(0, 300)}`);
    }

    const data = JSON.parse(raw) as {
      status?: string;
      content?: { video_url?: string };
      error?: { code?: string; message?: string };
    };

    const status = mapStatus(data.status);
    const error =
      status === 'failed'
        ? (data.status ?? '').toLowerCase() === 'expired'
          ? '任务超时未完成（超过执行有效期），请重新提交'
          : explainProviderError(data.error?.message ?? '', data.error?.code)
        : null;

    return {
      id: providerJobId,
      status,
      videoUrl: data.content?.video_url ?? null,
      progress: null,
      error,
    };
  }
}
