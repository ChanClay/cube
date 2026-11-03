export interface GenerateImageInput {
  prompt: string;
  /** 输出尺寸，如 1104*1472 / 1696*960 */
  size?: string;
  negativePrompt?: string;
}

/**
 * 生图结果。
 * - 原生百炼返回 24 小时有效的临时 URL
 * - OpenAI 兼容网关通常只回 `data[0].b64_json`，必须以 base64 形式回传
 */
export type GeneratedImage =
  | { url: string }
  | { base64: string; mime: string };
