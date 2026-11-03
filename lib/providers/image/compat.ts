import { config } from '@/lib/config';
import { gatewayBase } from '@/lib/providers/endpoint';
import type { GenerateImageInput, GeneratedImage } from './types';

/**
 * OpenAI 风格网关 · 文生图
 *
 *   POST {base}/images/generations  { model, prompt, n, size }
 *   → { data: [{ url }] } 或 { data: [{ b64_json }] }
 *
 * 与 DashScope 原生接口的差异：
 * - 尺寸只有固定档位（1024x1024 / 1024x1536 / 1536x1024），这里按宽高比折算
 * - 没有 negative_prompt，负面词并入正向提示词
 * - azure / openai 系列模型只回 b64_json，不回 URL
 */

const DEFAULT_MODEL = 'wan2.6-t2i';

/** 项目里用的是 1104*1472 这类像素尺寸，OpenAI 图片协议只认三档 */
function toGatewaySize(size?: string): string {
  const match = (size ?? '').match(/^(\d+)\s*[*x×]\s*(\d+)$/i);
  if (!match) return '1024x1024';

  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!width || !height || width === height) return '1024x1024';
  return height > width ? '1024x1536' : '1536x1024';
}

function apiBase(): string {
  const raw = config.image.baseUrl;
  if (!raw) {
    throw new Error(
      '当前走 OpenAI 风格网关，但没有配置 IMAGE_BASE_URL（例如 https://viprouter.com/v1）',
    );
  }
  return gatewayBase(raw);
}

export async function generateGatewayImage(input: GenerateImageInput): Promise<GeneratedImage> {
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error('提示词不能为空');
  if (!config.image.apiKey) {
    throw new Error(
      '未配置 IMAGE_API_KEY（或 VIDEO_API_KEY），请填入 .env.local 后重启服务才能生成配图',
    );
  }

  const model = config.image.model || DEFAULT_MODEL;
  const fullPrompt = input.negativePrompt?.trim()
    ? `${prompt}。避免出现：${input.negativePrompt.trim()}`
    : prompt;

  const res = await fetch(`${apiBase()}/images/generations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.image.apiKey}`,
    },
    body: JSON.stringify({
      model,
      prompt: fullPrompt,
      n: 1,
      size: toGatewaySize(input.size),
    }),
    // 网关出大图（1536x1024）实测要 3 分钟上下，留足余量；route 的 maxDuration 是 300s
    signal: AbortSignal.timeout(280_000),
  });

  const raw = await res.text();
  if (!res.ok) {
    const hint = /dashscope/.test(raw)
      ? '\n提示：该网关把 dashscope 系图片模型转发到百炼时可能报 url error，可改用 azure/gpt-image-2 等通用图片模型'
      : '';
    throw new Error(`网关文生图失败（${res.status}）：${raw.slice(0, 300)}${hint}`);
  }

  let data: { data?: { url?: unknown; b64_json?: unknown }[]; error?: { message?: string } };
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`网关文生图返回内容无法解析：${raw.slice(0, 200)}`);
  }

  const first = data.data?.[0];
  const url = typeof first?.url === 'string' ? first.url : '';
  if (url) return { url };

  const base64 = typeof first?.b64_json === 'string' ? first.b64_json : '';
  if (base64) return { base64, mime: 'image/png' };

  throw new Error(
    `网关文生图没有返回图片：${data.error?.message ?? raw.slice(0, 200)}`,
  );
}
