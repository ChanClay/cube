import { config } from '@/lib/config';
import { logEvent, logVideoError } from '@/lib/logger';
import type { CreateVideoInput, VideoProvider, VideoTaskState } from './types';
import { DEFAULT_MODEL, mapGatewayStatus, toDuration, toSize } from './params';

/**
 * OpenAI 风格视频网关（Sora 兼容协议）
 *
 * 创建任务：POST {base}/videos   { model, prompt, seconds, size } → { id, status }
 * 查询任务：GET  {base}/videos/{id}
 *           → { id, status: queued|in_progress|completed|failed,
 *               videos: [{ type: "url", url: "https://…" }] }
 *
 * 这类网关（viprouter / one-api 等中转站）只暴露 OpenAI 风格的顶层字段，
 * 不认 DashScope 原生的 `input.media` / `parameters.resolution`：
 * 把原生请求打到 `/services/aigc/...` 会直接 405 Method Not Allowed。
 *
 * 能力差异（实测）：`/v1/videos` 不接受任何图片输入 —— URL 字段（image_url /
 * image / input_reference）会被静默忽略，multipart 也会被当成 JSON 解析失败，
 * 所以首帧 / 参考素材在这条链路上不可用，只能纯文本生成。需要「承接上一镜末帧」
 * 请把 VIDEO_BASE_URL 换回百炼原生异步地址。
 */

/** 网关返回的视频地址在 videos[].url 里，个别实现放在顶层，全部兜一遍 */
function pickVideoUrl(data: Record<string, unknown>): string | null {
  const videos = data.videos;
  if (Array.isArray(videos)) {
    for (const item of videos) {
      const url = (item as { url?: unknown } | null)?.url;
      if (typeof url === 'string' && url) return url;
    }
  }

  for (const key of ['video_url', 'url', 'output_url']) {
    const value = data[key];
    if (typeof value === 'string' && value) return value;
  }

  const output = data.output as Record<string, unknown> | undefined;
  const nested = output?.video_url ?? output?.url;
  return typeof nested === 'string' && nested ? nested : null;
}

function pickError(data: Record<string, unknown>): string | null {
  const error = data.error;
  if (typeof error === 'string' && error) return error;
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  for (const key of ['message', 'error_message']) {
    const value = data[key];
    if (typeof value === 'string' && value) return value;
  }
  return null;
}

export class GatewayVideoProvider implements VideoProvider {
  readonly name = 'wan-gateway';

  get model(): string {
    return config.video.model || DEFAULT_MODEL;
  }

  private get apiBase(): string {
    const raw = (config.video.baseUrl || '').replace(/\/+$/, '');
    if (!raw) {
      throw new Error(
        '当前走 OpenAI 风格视频网关，但没有配置 VIDEO_BASE_URL（例如 https://viprouter.com/v1）',
      );
    }
    if (raw.includes('compatible-mode')) {
      throw new Error(
        `VIDEO_BASE_URL 不能是 compatible-mode 地址（当前 ${raw}）：该地址只代理对话模型，视频生成要么用原生 https://dashscope.aliyuncs.com/api/v1，要么用支持 /v1/videos 的网关`,
      );
    }
    // 允许只填到域名（https://viprouter.com），自动补 /v1
    return /\/v\d+$/.test(raw) ? raw : `${raw}/v1`;
  }

  private headers(): Record<string, string> {
    if (!config.video.apiKey) {
      throw new Error(
        '未配置 VIDEO_API_KEY（阿里云百炼或视频网关的 API Key），请填入 .env.local 后重启服务',
      );
    }
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.video.apiKey}`,
    };
  }

  async createTask(input: CreateVideoInput): Promise<{ providerJobId: string }> {
    const media = input.media ?? [];
    if (media.length > 0) {
      // 网关会静默丢掉这些素材，先留一条告警，避免「首帧没生效」被当成模型问题排查
      void logEvent(
        'video',
        'media',
        {
          provider: this.name,
          baseUrl: this.apiBase,
          note: '网关 /v1/videos 不接受首帧 / 参考素材，本次已忽略，按纯文本生成',
          media: media.map((item) => item.type),
        },
        'warn',
      );
    }

    const body = {
      model: this.model,
      prompt: input.prompt,
      // OpenAI 视频协议里 seconds 是字符串
      seconds: String(toDuration(input.duration)),
      size: toSize(input.resolution, config.video.ratio),
    };

    const res = await fetch(`${this.apiBase}/videos`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });

    const raw = await res.text();
    if (!res.ok) {
      if (res.status === 404 || res.status === 405) {
        throw new Error(
          `当前 VIDEO_BASE_URL（${this.apiBase}）不提供视频接口（${res.status}）。` +
            '请换成支持 /v1/videos 的网关，或改用百炼原生异步地址 https://dashscope.aliyuncs.com/api/v1',
        );
      }
      throw new Error(`视频网关创建任务失败（${res.status}）：${raw.slice(0, 400)}`);
    }

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new Error(`视频网关返回内容无法解析：${raw.slice(0, 200)}`);
    }

    const id = data.id;
    if (typeof id !== 'string' || !id) {
      throw new Error(
        `视频网关未返回任务 id：${pickError(data) ?? raw.slice(0, 200)}`,
      );
    }
    return { providerJobId: id };
  }

  async getTask(providerJobId: string): Promise<VideoTaskState> {
    const res = await fetch(
      `${this.apiBase}/videos/${encodeURIComponent(providerJobId)}`,
      {
        headers: this.headers(),
        cache: 'no-store',
        signal: AbortSignal.timeout(30000),
      },
    );

    const raw = await res.text();
    if (!res.ok) {
      throw new Error(`视频网关查询任务失败（${res.status}）：${raw.slice(0, 300)}`);
    }

    const data = JSON.parse(raw) as Record<string, unknown>;
    let status = mapGatewayStatus(typeof data.status === 'string' ? data.status : undefined);
    const videoUrl = pickVideoUrl(data);

    // 状态已完成但还没给地址：可能是网关先把状态翻过去、地址稍后才回填，
    // 这里继续按运行中轮询，别让任务提前终结成「成功但没有视频」
    if (status === 'succeeded' && !videoUrl) {
      void logVideoError('sync', {
        providerJobId,
        status: 'succeeded-without-url',
        note: '网关返回已完成但没有视频地址，继续轮询',
        raw: raw.slice(0, 200),
      });
      status = 'running';
    }

    return {
      id: providerJobId,
      status,
      videoUrl,
      progress: null,
      error: status === 'failed' ? (pickError(data) ?? '视频生成失败') : null,
    };
  }
}
