import { config } from '@/lib/config';
import { endpointKind, type EndpointKind } from '@/lib/providers/endpoint';
import { GatewayVideoProvider } from './compat';
import { WanProvider } from './wan';
import type { VideoProvider } from './types';

export type VideoProviderKind = EndpointKind;

/**
 * 按 VIDEO_BASE_URL 的形态判断走哪套协议：
 * - 百炼原生异步地址都以 `/api/v1` 结尾（如 https://dashscope.aliyuncs.com/api/v1、
 *   https://cn-beijing.maas.qianwenaiapi.com/api/v1）→ DashScope 原生协议
 * - 其余（viprouter 这类 OpenAI 兼容中转站，形如 https://xxx/v1）→ `/v1/videos` 协议
 *
 * 留空时退回 wan.ts 里的百炼默认地址，同样按原生协议处理。
 */
export function providerKind(baseUrl: string = config.video.baseUrl): VideoProviderKind {
  return endpointKind(baseUrl);
}

const instances = new Map<VideoProviderKind, VideoProvider>();

function build(kind: VideoProviderKind): VideoProvider {
  const cached = instances.get(kind);
  if (cached) return cached;

  const provider: VideoProvider = kind === 'gateway' ? new GatewayVideoProvider() : new WanProvider();
  instances.set(kind, provider);
  return provider;
}

/**
 * 取视频 provider。
 * 不传 name 时按当前配置判断；轮询历史任务时传任务里记录的 provider 名，
 * 避免中途改了 VIDEO_BASE_URL 后用错协议去查旧任务。
 */
export function getProvider(name?: string): VideoProvider {
  if (name === 'wan-gateway') return build('gateway');
  if (name === 'wan') return build('native');
  return build(providerKind());
}

export type { CreateVideoInput, VideoProvider, VideoTaskState } from './types';
