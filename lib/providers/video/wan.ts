import { config } from '@/lib/config';
import type { JobStatus } from '@/lib/types';
import type { CreateVideoInput, VideoProvider, VideoTaskState } from './types';

/**
 * 阿里云百炼 · 通义万相 Wan3.0（All-in-One 多模态视频模型）
 *
 * 创建任务：POST {base}/services/aigc/video-generation/video-synthesis
 *           Header: X-DashScope-Async: enable + Authorization: Bearer <key>
 * 查询任务：GET  {base}/tasks/{task_id}
 *
 * 请求示例：
 * {
 *   "model": "wan3.0-video",
 *   "input": {
 *     "prompt": "……",
 *     "media": [
 *       { "type": "first_frame",     "url": "https://…" },
 *       { "type": "reference_image", "url": "https://…" },
 *       { "type": "reference_video", "url": "https://…" },
 *       { "type": "reference_audio", "url": "https://…" }
 *     ]
 *   },
 *   "parameters": { "resolution": "720P", "ratio": "adaptive", "duration": 5,
 *                   "prompt_extend": true, "audio": true }
 * }
 *
 * 素材规则：首帧/尾帧与 reference_* 互斥；file 与 link 互斥；单次最多 20 个素材。
 */

const DEFAULT_BASE_URL = 'https://cn-beijing.maas.qianwenaiapi.com/api/v1';
const DEFAULT_MODEL = 'wan3.0-video';
const DEFAULT_RATIO = 'adaptive';
const VALID_RATIOS = new Set(['21:9', '16:9', '4:3', '1:1', '3:4', '9:16', 'adaptive']);

/** 统一成 480P / 720P / 1080P */
function toResolution(resolution: string): string {
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

function toRatio(ratio: string): string {
  const value = (ratio || '').trim();
  return VALID_RATIOS.has(value) ? value : DEFAULT_RATIO;
}

/** wan3.0 支持 2~30 秒 */
function toDuration(duration: number): number {
  const value = Math.round(Number(duration));
  if (!Number.isFinite(value) || value <= 0) return 5;
  return Math.min(30, Math.max(2, value));
}

function mapStatus(raw: string | undefined): JobStatus {
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

export class WanProvider implements VideoProvider {
  readonly name = 'wan';

  get model(): string {
    return config.video.model || DEFAULT_MODEL;
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

  async createTask(input: CreateVideoInput): Promise<{ providerJobId: string }> {
    const url = `${this.baseUrl}/services/aigc/video-generation/video-synthesis`;
    const media = input.media ?? [];

    /**
     * 带首帧 / 尾帧时画面比例由素材决定，显式传比例会和素材冲突（裁切或直接拒单），
     * 所以这类镜头固定用 adaptive；其余镜头跟随项目选的画幅。
     */
    const hasFrame = media.some(
      (item) => item.type === 'first_frame' || item.type === 'last_frame',
    );
    const ratio = hasFrame ? DEFAULT_RATIO : toRatio(input.ratio || config.video.ratio);

    const body = {
      model: this.model,
      input: {
        prompt: input.prompt,
        ...(media.length > 0 ? { media } : {}),
      },
      parameters: {
        resolution: toResolution(input.resolution),
        ratio,
        duration: toDuration(input.duration),
        prompt_extend: config.video.promptExtend,
        // 单个任务可以覆盖全局开关：承接上一镜末帧的镜头不出声，避免音频断档
        audio: input.audio ?? config.video.audio,
      },
    };

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
        `接口返回空内容，请检查 VIDEO_BASE_URL（当前 ${this.baseUrl}）是否为原生异步接口地址，而非 compatible-mode 地址`;
      throw new Error(`通义万相创建视频任务失败（${res.status}）：${detail}`);
    }

    let data: { output?: { task_id?: string }; message?: string; code?: string };
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error(`通义万相返回内容无法解析：${raw.slice(0, 200)}`);
    }

    const taskId = data.output?.task_id;
    if (!taskId) {
      throw new Error(`通义万相未返回 task_id：${data.message ?? data.code ?? raw.slice(0, 200)}`);
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
      throw new Error(`通义万相查询任务失败（${res.status}）：${raw.slice(0, 300)}`);
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
    return {
      id: providerJobId,
      status,
      videoUrl: data.output?.video_url ?? null,
      progress: null,
      error:
        status === 'failed'
          ? explainProviderError(data.output?.message ?? '', data.output?.code)
          : null,
    };
  }
}
