import { config } from '@/lib/config';
import { generateImage as generateWithSeedream } from './seedream';
import { generateImage as generateWithWan } from './wan-image';

export type { GenerateImageInput } from './wan-image';

/**
 * 文生图统一入口：按 `IMAGE_PROVIDER` 路由到具体 provider。
 *
 * - `wan`（默认）：百炼万相，原行为不变；
 * - `seedream`：火山方舟 Seedream，与 Seedance 同平台。
 *
 * 上层（/api/image）只认这个函数，不关心协议差异。
 */
export async function generateImage(
  input: Parameters<typeof generateWithWan>[0],
): Promise<string> {
  return config.image.provider === 'seedream'
    ? generateWithSeedream(input)
    : generateWithWan(input);
}
