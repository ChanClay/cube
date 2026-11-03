import { config } from '@/lib/config';
import { endpointKind, type EndpointKind } from '@/lib/providers/endpoint';
import { generateGatewayImage } from './compat';
import { generateNativeImage } from './wan-image';
import type { GenerateImageInput, GeneratedImage } from './types';

/**
 * 图片接口同样按 base URL 切协议：
 * 原生百炼（`/api/v1`）走万相同步 / 异步协议，其余走 OpenAI 风格 `/images/generations`。
 */
export function imageProviderKind(): EndpointKind {
  return endpointKind(config.image.baseUrl || config.video.baseUrl);
}

export async function generateImage(input: GenerateImageInput): Promise<GeneratedImage> {
  return imageProviderKind() === 'gateway'
    ? generateGatewayImage(input)
    : generateNativeImage(input);
}

export type { GenerateImageInput, GeneratedImage } from './types';
