import { config } from '@/lib/config';
import type { JobStatus, MediaInput, MediaType } from '@/lib/types';
import { videoModelSpec } from '@/lib/video-models';
import type { CreateVideoInput, VideoProvider, VideoTaskState } from './types';

/** 三种生成模式各对应一个模型 ID，由 config 按环境变量派生 */
type HappyHorseModels = { t2v: string; i2v: string; r2v: string };

/**
 * 阿里云百炼 · HappyHorse 1.1
 *
 * 创建任务：POST {base}/services/aigc/video-generation/video-synthesis
 *           Header: X-DashScope-Async: enable + Authorization: Bearer <key>
 * 查询任务：GET  {base}/tasks/{task_id}
 *
 * 三种生成模式是三个独立的模型 ID，端点相同、参数不同：
 * - t2v（文生视频）  happyhorse-1.1-t2v
 *   input: { prompt }，没有 media；parameters 支持 ratio
 * - i2v（首帧生视频）happyhorse-1.1-i2v
 *   input.media 有且仅有 1 个 first_frame；**没有 ratio**（画幅跟随首帧），prompt 可选
 * - r2v（参考生视频）happyhorse-1.1-r2v
 *   input.media 1~9 个 reference_image；prompt 必填，用 [Image N] 指代第 N 张参考图；支持 ratio
 *
 * 三个模式共同的限制（与 wan3.0 不同）：
 * - 只有图片素材：不支持 last_frame / reference_video / reference_audio / file / link
 * - 时长 3~15 秒整数；resolution 480P / 720P / 1080P；没有 prompt_extend
 *
 * 音频：HappyHorse 1.1 是单流 Transformer 原生音视频联合生成，对白 / 环境音 / 拟音
 * 与画面一起产出（音素级口型同步），所以 `parameters` 里**没有** audio 字段——
 * 不是没有音轨，而是音轨不可关闭。写进 prompt 的台词会被真的说出来。
 *
 * 请求示例（i2v）：
 * {
 *   "model": "happyhorse-1.1-i2v",
 *   "input": {
 *     "prompt": "……",
 *     "media": [{ "type": "first_frame", "url": "https://…" }]
 *   },
 *   "parameters": { "resolution": "720P", "duration": 5, "watermark": false }
 * }
 */

const DEFAULT_BASE_URL = 'https://cn-beijing.maas.qianwenaiapi.com/api/v1';
const DEFAULT_RATIO = '16:9';
/** HappyHorse 支持的比例（没有 adaptive） */
const VALID_RATIOS = new Set([
  '16:9',
  '9:16',
  '3:4',
  '4:3',
  '4:5',
  '5:4',
  '1:1',
  '9:21',
  '21:9',
]);
const MAX_REFERENCE_IMAGES = 9;
/** 时长区间与剧本规划共用同一份能力表，避免两处漂移 */
const SPEC = videoModelSpec('happyhorse-1.1');
const MIN_DURATION = SPEC.minShotSeconds;
const MAX_DURATION = SPEC.maxShotSeconds;

/** 唯一被 HappyHorse 接受的素材类型：首帧 / 尾帧（仅作首帧兜底）/ 参考图 */
const IMAGE_TYPES = new Set<MediaType>(['first_frame', 'last_frame', 'reference_image']);

/** 统一成 480P / 720P / 1080P */
function toResolution(resolution: string): string {
  const value = (resolution || '').trim().toUpperCase();

  if (/^(480P|720P|1080P)$/.test(value)) return value;

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

function toRatio(ratio: string): string {
  const value = (ratio || '').trim();
  return VALID_RATIOS.has(value) ? value : DEFAULT_RATIO;
}

/** HappyHorse 单镜 3~15 秒 */
function toDuration(duration: number): number {
  const value = Math.round(Number(duration));
  if (!Number.isFinite(value) || value <= 0) return 5;
  return Math.min(MAX_DURATION, Math.max(MIN_DURATION, value));
}

function mapStatus(raw: string | undefined): JobStatus {
  switch ((raw ?? '').toUpperCase()) {
    case 'PENDING':
      return 'queued';
    case 'RUNNING':
      return 'running';
    case 'SUCCEEDED':
      return 'succeeded';
    case 'CANCELED':
      return 'canceled';
    default:
      // FAILED / UNKNOWN（task_id 过期或不存在）
      return 'failed';
  }
}

/**
 * 把 provider 的英文报错翻成人话。
 *
 * 最常见的是阿里云绿网（内容安全）拒单：`Green net check rejected image (output)`
 * —— 模型已经生成，但输出画面被审核拦下，原因通常是提示词带殡葬 / 血腥 / 恐怖语义。
 */
function explainProviderError(message: string, code?: string): string {
  const raw = message || code || '视频生成失败';
  if (!/green[ _-]?net|data[_ -]?inspection/i.test(`${message} ${code ?? ''}`)) return raw;

  // (input) 指素材被判违规，(output) 指生成的画面被判违规
  const target = /\(input\)/i.test(message) ? '输入素材' : '生成的画面';
  return `内容安全审核未通过：阿里云绿网拦截了${target}（原文 ${raw}）。请改写提示词，避开殡葬、血腥、恐怖、暴露等敏感描述后重试`;
}

export interface MediaPlan {
  mode: 't2v' | 'i2v' | 'r2v';
  /** i2v 只用第 1 张；r2v 最多 9 张，顺序即 prompt 里的 [Image N] */
  images: string[];
  /** 被丢掉的素材类型（HappyHorse 不支持的素材，以及 i2v 下多余的帧） */
  dropped: MediaType[];
}

function uniqueMedia(items: MediaInput[]): MediaInput[] {
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
 * 素材 → 生成模式。
 *
 * - 有 reference_image：r2v。首帧 / 尾帧排在最前，继续当 [Image 1] 锁住画面起点；
 * - 只有一张帧图：i2v。首帧优先，没有首帧时用尾帧兜底（i2v 不认 last_frame）；
 * - 一张图都没有：t2v。
 *
 * HappyHorse 只吃图片，其余素材在提交前就被摘掉，避免接口按「未知字段」整单拒掉。
 */
export function planMedia(media: MediaInput[]): MediaPlan {
  const firstFrame = media.find((item) => item.type === 'first_frame');
  const lastFrame = media.find((item) => item.type === 'last_frame');
  const referenceImages = media.filter((item) => item.type === 'reference_image');
  const unsupported = media
    .filter((item) => !IMAGE_TYPES.has(item.type))
    .map((item) => item.type);

  if (referenceImages.length > 0) {
    const ordered = [firstFrame, lastFrame, ...referenceImages].filter(
      (item): item is MediaInput => !!item,
    );
    return {
      mode: 'r2v',
      images: uniqueMedia(ordered)
        .slice(0, MAX_REFERENCE_IMAGES)
        .map((item) => item.url),
      dropped: unsupported,
    };
  }

  const anchor = firstFrame ?? lastFrame;
  if (anchor) {
    return {
      mode: 'i2v',
      images: [anchor.url],
      // 首帧 + 尾帧同时给时，尾帧只能丢：i2v 只接受一张 first_frame
      dropped: firstFrame && lastFrame ? [...unsupported, 'last_frame'] : unsupported,
    };
  }

  return { mode: 't2v', images: [], dropped: unsupported };
}

export class HappyHorseProvider implements VideoProvider {
  readonly name = 'happyhorse';

  /** 健康检查展示用的基础模型名（实际调用按模式取 models.*） */
  get model(): string {
    return config.video.happyhorse.base;
  }

  private get models(): HappyHorseModels {
    return config.video.happyhorse;
  }

  private get baseUrl(): string {
    return config.video.baseUrl || DEFAULT_BASE_URL;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    if (!config.video.apiKey) {
      throw new Error(
        '未配置 VIDEO_API_KEY（阿里云百炼 DashScope API Key），请填入 .env.local 后重启服务',
      );
    }
    // /compatible-mode/v1 是 OpenAI 兼容层，不接受异步任务（会返回
    // "current user api does not support asynchronous calls"）
    if (this.baseUrl.includes('compatible-mode')) {
      throw new Error(
        `VIDEO_BASE_URL 不能是 compatible-mode 地址（当前 ${this.baseUrl}）。视频生成需要原生异步地址，例如 https://dashscope.aliyuncs.com/api/v1`,
      );
    }
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.video.apiKey}`,
      ...extra,
    };
  }

  /**
   * 三个模式的请求体分别组装，不要合并：
   * i2v 传了 ratio / audio 会被接口当非法参数拒单，r2v 缺 prompt 同样直接 400。
   */
  private buildBody(input: CreateVideoInput, plan: MediaPlan) {
    if (Number(input.duration) > MAX_DURATION) {
      console.warn(
        `[video:happyhorse] 单镜时长 ${input.duration}s 超过 HappyHorse 上限 ${MAX_DURATION}s，已按 ${MAX_DURATION}s 提交`,
      );
    }
    const duration = toDuration(input.duration);
    const resolution = toResolution(input.resolution);
    const watermark = config.video.watermark;

    if (plan.mode === 'i2v') {
      return {
        model: this.models.i2v,
        input: {
          // prompt 可选；空串会被接口当空文本，干脆不传
          ...(input.prompt ? { prompt: input.prompt } : {}),
          media: [{ type: 'first_frame', url: plan.images[0] }],
        },
        // i2v 没有 ratio：画幅自动跟随首帧
        parameters: { resolution, duration, watermark },
      };
    }

    if (plan.mode === 'r2v') {
      return {
        model: this.models.r2v,
        input: {
          prompt: input.prompt,
          media: plan.images.map((url) => ({ type: 'reference_image', url })),
        },
        parameters: {
          resolution,
          ratio: toRatio(input.ratio || config.video.ratio),
          duration,
          watermark,
        },
      };
    }

    return {
      model: this.models.t2v,
      input: { prompt: input.prompt },
      parameters: {
        resolution,
        ratio: toRatio(input.ratio || config.video.ratio),
        duration,
        watermark,
      },
    };
  }

  async createTask(input: CreateVideoInput): Promise<{ providerJobId: string }> {
    const url = `${this.baseUrl}/services/aigc/video-generation/video-synthesis`;
    const plan = planMedia(input.media ?? []);
    const body = this.buildBody(input, plan);

    if (plan.dropped.length > 0) {
      console.warn(
        `[video:happyhorse] 以下素材类型 HappyHorse 1.1 不支持，已忽略：${plan.dropped.join(', ')}（镜头 ${input.prompt.slice(0, 40)}）`,
      );
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: this.headers({ 'X-DashScope-Async': 'enable' }),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });

    const raw = await res.text();
    if (!res.ok) {
      if (raw.includes('does not support asynchronous')) {
        throw new Error(
          `当前 VIDEO_BASE_URL（${this.baseUrl}）不支持异步视频任务：请改为原生异步地址，例如 https://dashscope.aliyuncs.com/api/v1，并确认 API Key 与该地址属于同一平台`,
        );
      }
      const detail =
        raw.slice(0, 400) ||
        `接口返回空内容，请检查 VIDEO_BASE_URL（当前 ${this.baseUrl}）是否为原生异步接口地址`;
      throw new Error(
        `HappyHorse 创建视频任务失败（${plan.mode} / ${body.model} / ${res.status}）：${detail}`,
      );
    }

    let data: { output?: { task_id?: string }; message?: string; code?: string };
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error(`HappyHorse 返回内容无法解析：${raw.slice(0, 200)}`);
    }

    const taskId = data.output?.task_id;
    if (!taskId) {
      throw new Error(`HappyHorse 未返回 task_id：${data.message ?? data.code ?? raw.slice(0, 200)}`);
    }
    return { providerJobId: taskId };
  }

  async getTask(providerJobId: string): Promise<VideoTaskState> {
    const res = await fetch(`${this.baseUrl}/tasks/${encodeURIComponent(providerJobId)}`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(30000),
      cache: 'no-store',
    });

    const raw = await res.text();
    if (!res.ok) {
      throw new Error(`HappyHorse 查询任务失败（${res.status}）：${raw.slice(0, 300)}`);
    }

    const data = JSON.parse(raw) as {
      output?: {
        task_status?: string;
        video_url?: string;
        message?: string;
        code?: string;
      };
    };

    const status = mapStatus(data.output?.task_status);
    const error =
      status === 'failed'
        ? data.output?.task_status?.toUpperCase() === 'UNKNOWN'
          ? '任务不存在或已超过 24 小时有效期，请重新提交'
          : explainProviderError(data.output?.message ?? '', data.output?.code)
        : null;

    return {
      id: providerJobId,
      status,
      videoUrl: data.output?.video_url ?? null,
      progress: null,
      error,
    };
  }
}
