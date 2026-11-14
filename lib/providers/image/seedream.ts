import { config } from '@/lib/config';
import type { GenerateImageInput } from './wan-image';

/**
 * 火山方舟（Volcengine Ark）· Seedream 文生图（角色卡 / 场景卡配图）
 *
 * 同步接口：
 *   POST {base}/images/generations
 *   Header: Authorization: Bearer <ARK_API_KEY>
 *   Body:   { model, prompt, size, response_format: 'url', watermark: false, n: 1 }
 *   → data[].url
 *
 * 和百炼万相完全是两套协议，差异点（改之前先看这里）：
 * - base 是 `https://ark.cn-beijing.volces.com/api/v3`，Key 与百炼不通用
 *   （与 Seedance 同一个平台，默认复用 VIDEO_SEEDANCE_API_KEY）；
 * - 尺寸写 `1024x1536`（小写 x），不是百炼的 `1104*1472`；
 * - **不支持 negative_prompt**：负向约束只能写进正向提示词，
 *   本项目 `buildCardPrompt` 的结尾已经带了「不要画面文字 / 水印 / 畸形肢体」。
 *
 * 返回的图片 URL 同样只保留一段时间（24 小时），调用方必须立刻转存。
 */

/** 与 config.ts 的 VIDEO_DEFAULT_BASE_URLS.seedance 保持一致，避免配置缺失时拼出空地址 */
const DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';

/** 单次同步生成可能较慢，给足超时 */
const TIMEOUT_MS = 180_000;

/** Seedream 4.x / 5.x：支持任意像素尺寸（卡片按 1.5 ~ 1.6 MP 出图，够做参考图） */
const SIZES_NEW = { portrait: '1024x1536', landscape: '1536x1024', square: '1024x1024' } as const;
/** Seedream 3.x：只认固定尺寸档位，用它的 3:4 / 16:9 / 1:1 档 */
const SIZES_3X = { portrait: '864x1152', landscape: '1280x720', square: '1024x1024' } as const;

function baseUrl(): string {
  return config.image.seedream.baseUrl || DEFAULT_BASE_URL;
}

function model(): string {
  return config.image.seedream.model;
}

/**
 * 3.x 只支持固定尺寸列表，4.x / 5.x 起支持自定义像素，按模型名分流。
 * 认不出来（方舟 Endpoint ID `ep-…` 或更新的版本）按 4.x / 5.x 处理：
 * 默认是 Seedream 5.5，自定义尺寸在 4.x 以上都合法。
 */
function usesFixedSizes(modelName: string): boolean {
  return /seedream-3[.-]/i.test(modelName);
}

/**
 * 百炼的卡片尺寸 → Seedream 尺寸。
 *
 * 卡片只有「人物 / 载具竖横图」和「场景横图」三种比例，
 * 这里按长宽比归到竖 / 横 / 方三档，不追求精确像素对齐。
 */
export function toSeedreamSize(size?: string, modelName = model()): string {
  const table = usesFixedSizes(modelName) ? SIZES_3X : SIZES_NEW;
  const parsed = /(\d+)\s*[*x×]\s*(\d+)/i.exec(size ?? '');
  if (!parsed) return table.square;

  const ratio = Number(parsed[1]) / Number(parsed[2]);
  if (ratio > 1.15) return table.landscape;
  if (ratio < 0.87) return table.portrait;
  return table.square;
}

/** 从错误响应里挖出可读信息：方舟一般是 { error: { code, message } } */
function explainError(raw: string, status: number): string {
  let detail = raw.slice(0, 300);
  try {
    const data = JSON.parse(raw) as { error?: { code?: string; message?: string } };
    const code = data.error?.code;
    const message = data.error?.message;
    if (code || message) detail = [code, message].filter(Boolean).join('：');
  } catch {
    // 非 JSON 就保留原文片段
  }

  if (status === 401 || status === 403) {
    return (
      `请在 .env.local 配置 IMAGE_SEEDREAM_API_KEY（或 VIDEO_SEEDANCE_API_KEY / ARK_API_KEY），` +
      `并确认该 Key 已开通 Seedream 模型。当前来源：${config.image.seedream.apiKeyEnv}。原始响应：${detail}`
    );
  }
  if (status === 404) {
    return (
      `模型 ID 不存在或未在当前账号开通：${model()}。` +
      `请检查 IMAGE_SEEDREAM_MODEL 与 IMAGE_SEEDREAM_BASE_URL（当前 ${baseUrl()}）。原始响应：${detail}`
    );
  }
  if (status === 400 && /size/i.test(detail)) {
    return `尺寸不被该模型接受（模型 ${model()}）：3.x 只支持固定档位，换 4.x / 5.x 或改用其支持的尺寸。原始响应：${detail}`;
  }
  return detail;
}

/** 从 data[0] 取图片地址；兼容 b64_json 兜底（本项目只请求 url） */
function pickImageUrl(data: Record<string, unknown>): string | null {
  const list = data.data;
  if (!Array.isArray(list)) return null;
  for (const item of list) {
    const url = (item as Record<string, unknown>)?.url;
    if (typeof url === 'string' && url) return url;
  }
  return null;
}

/** 生成一张图，返回上游临时地址（需调用方立刻转存） */
export async function generateImage(input: GenerateImageInput): Promise<string> {
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error('提示词不能为空');

  if (!config.image.seedream.apiKey) {
    throw new Error(
      '未配置 IMAGE_SEEDREAM_API_KEY（或 VIDEO_SEEDANCE_API_KEY / ARK_API_KEY），' +
        '请填入 .env.local 后重启服务才能用 Seedream 生成配图',
    );
  }

  const res = await fetch(`${baseUrl()}/images/generations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.image.seedream.apiKey}`,
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    body: JSON.stringify({
      model: model(),
      prompt,
      // negative_prompt 方舟不支持，负向约束已在 buildCardPrompt 的正向文本里
      size: toSeedreamSize(input.size),
      response_format: 'url',
      watermark: false,
      n: 1,
    }),
  });

  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`Seedream 文生图失败（${res.status}）：${explainError(raw, res.status)}`);
  }

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(`Seedream 文生图返回内容无法解析：${raw.slice(0, 200)}`);
  }

  const url = pickImageUrl(data);
  if (!url) {
    const message =
      typeof data.message === 'string' ? data.message : raw.slice(0, 200);
    throw new Error(`Seedream 文生图没有返回图片：${message}`);
  }
  return url;
}
