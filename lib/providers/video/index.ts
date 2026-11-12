import type { VideoProviderName } from '@/lib/video-models';
import { HappyHorseProvider } from './happyhorse';
import { WanProvider } from './wan';
import type { VideoProvider } from './types';

/**
 * 每个 provider 一个单例。
 *
 * 剧本上记录了用哪个视频模型（Script.videoModel），生成时由
 * lib/video-models 的 providerForVideoModel 换算出 provider 名字，再来这里取实现。
 */
const instances: Partial<Record<VideoProviderName, VideoProvider>> = {};

const FACTORIES: Record<VideoProviderName, () => VideoProvider> = {
  happyhorse: () => new HappyHorseProvider(),
  wan: () => new WanProvider(),
};

export function isVideoProviderName(value: unknown): value is VideoProviderName {
  return value === 'happyhorse' || value === 'wan';
}

/**
 * 取 provider 实现。
 * @param name provider 名（'happyhorse' / 'wan'）
 */
export function getProvider(name: VideoProviderName): VideoProvider {
  instances[name] ??= FACTORIES[name]();
  return instances[name] as VideoProvider;
}

export type { CreateVideoInput, VideoProvider, VideoTaskState } from './types';
