import { config } from '@/lib/config';
import type { GenerateImageInput, GeneratedImage } from './types';

/**
 * 阿里云百炼 · 万相文生图（角色卡 / 场景卡配图）
 *
 * wan2.6 走新的多模态协议，支持 HTTP 同步：
 *   POST {base}/services/aigc/multimodal-generation/generation
 *   → output.choices[].message.content[].image
 *
 * wan2.5 及以下只支持异步，走旧协议：
 *   POST {base}/services/aigc/text2image/image-synthesis（X-DashScope-Async: enable）
 *   → GET {base}/tasks/{task_id} → output.results[].url
 *
 * 注意：返回的图片 URL 只保留 24 小时，调用方必须立刻转存。
 */

const DEFAULT_BASE_URL = 'https://cn-beijing.maas.qianwenaiapi.com/api/v1';
const DEFAULT_MODEL = 'wan2.6-t2i';

/** wan2.6 及以后（wan2.7 / wan3.x）支持同步调用，wan2.5 及以下必须异步轮询 */
const SYNC_MODEL = /^wan(2\.[6-9]|[3-9]\.)/i;

const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 180_000;

function baseUrl(): string {
  return config.image.baseUrl || DEFAULT_BASE_URL;
}

function model(): string {
  return config.image.model || DEFAULT_MODEL;
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  if (!config.image.apiKey) {
    throw new Error(
      '未配置 IMAGE_API_KEY（或 VIDEO_API_KEY），请填入 .env.local 后重启服务才能生成配图',
    );
  }
  if (baseUrl().includes('compatible-mode')) {
    throw new Error(
      `IMAGE_BASE_URL 不能是 compatible-mode 地址（当前 ${baseUrl()}），文生图需要原生接口地址`,
    );
  }
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.image.apiKey}`,
    ...extra,
  };
}

function parseJson(raw: string, action: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(`万相文生图${action}返回内容无法解析：${raw.slice(0, 200)}`);
  }
}

/** 从 wan2.6 的 choices[].message.content[].image 里取第一张图 */
function pickWan26Image(data: Record<string, unknown>): string | null {
  const output = data.output as Record<string, unknown> | undefined;
  const choices = output?.choices;
  if (!Array.isArray(choices)) return null;

  for (const choice of choices) {
    const message = (choice as Record<string, unknown>)?.message as
      | Record<string, unknown>
      | undefined;
    const content = message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const image = (part as Record<string, unknown>)?.image;
      if (typeof image === 'string' && image) return image;
    }
  }
  return null;
}

/** wan2.6 同步调用 */
async function generateSync(input: GenerateImageInput): Promise<string> {
  const res = await fetch(`${baseUrl()}/services/aigc/multimodal-generation/generation`, {
    method: 'POST',
    headers: headers(),
    signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
    body: JSON.stringify({
      model: model(),
      input: {
        messages: [{ role: 'user', content: [{ text: input.prompt }] }],
      },
      parameters: {
        size: input.size,
        n: 1,
        prompt_extend: true,
        watermark: false,
        ...(input.negativePrompt ? { negative_prompt: input.negativePrompt } : {}),
      },
    }),
  });

  const raw = await res.text();
  if (!res.ok) {
    const hint =
      res.status === 401 || res.status === 404
        ? `\n请检查 IMAGE_BASE_URL（当前 ${baseUrl()}）与 API Key 是否属于同一地域；` +
          '万相专属入口不支持该接口时，可改用 https://你的WorkspaceId.cn-beijing.maas.aliyuncs.com/api/v1'
        : '';
    throw new Error(`万相文生图失败（${res.status}）：${raw.slice(0, 300)}${hint}`);
  }

  const data = parseJson(raw, '生成');
  const url = pickWan26Image(data);
  if (!url) {
    const message = typeof data.message === 'string' ? data.message : raw.slice(0, 200);
    throw new Error(`万相文生图没有返回图片：${message}`);
  }
  return url;
}

/** wan2.5 及以下：先建任务再轮询 */
async function generateAsync(input: GenerateImageInput): Promise<string> {
  const createRes = await fetch(`${baseUrl()}/services/aigc/text2image/image-synthesis`, {
    method: 'POST',
    headers: headers({ 'X-DashScope-Async': 'enable' }),
    signal: AbortSignal.timeout(60_000),
    body: JSON.stringify({
      model: model(),
      input: {
        prompt: input.prompt.slice(0, 2000),
        ...(input.negativePrompt ? { negative_prompt: input.negativePrompt } : {}),
      },
      parameters: { size: input.size, n: 1 },
    }),
  });

  const createRaw = await createRes.text();
  if (!createRes.ok) {
    throw new Error(`万相文生图创建任务失败（${createRes.status}）：${createRaw.slice(0, 400)}`);
  }

  const created = parseJson(createRaw, '创建任务');
  const output = created.output as Record<string, unknown> | undefined;
  const taskId = typeof output?.task_id === 'string' ? output.task_id : '';
  if (!taskId) {
    const message = typeof created.message === 'string' ? created.message : createRaw.slice(0, 200);
    throw new Error(`万相文生图未返回 task_id：${message}`);
  }

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

    const res = await fetch(`${baseUrl()}/tasks/${encodeURIComponent(taskId)}`, {
      headers: headers(),
      cache: 'no-store',
      signal: AbortSignal.timeout(30_000),
    });
    const raw = await res.text();
    if (!res.ok) throw new Error(`查询文生图任务失败（${res.status}）：${raw.slice(0, 300)}`);

    const data = parseJson(raw, '查询');
    const result = data.output as Record<string, unknown> | undefined;
    const status = String(result?.task_status ?? '').toUpperCase();

    if (status === 'SUCCEEDED') {
      const results = result?.results;
      const first = Array.isArray(results) ? (results[0] as Record<string, unknown>) : null;
      const url = typeof first?.url === 'string' ? first.url : '';
      if (!url) throw new Error('万相文生图任务成功但没有返回图片地址');
      return url;
    }
    if (status === 'FAILED' || status === 'CANCELED' || status === 'UNKNOWN') {
      const message =
        (typeof result?.message === 'string' && result.message) ||
        (typeof result?.code === 'string' && result.code) ||
        status;
      throw new Error(`万相文生图失败：${message}`);
    }
  }

  throw new Error('万相文生图超时（3 分钟），请稍后重试');
}

/** 生成一张图，返回临时地址（有效期 24 小时，调用方需转存） */
export async function generateNativeImage(input: GenerateImageInput): Promise<GeneratedImage> {
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error('提示词不能为空');
  const url = SYNC_MODEL.test(model()) ? await generateSync(input) : await generateAsync(input);
  return { url };
}
