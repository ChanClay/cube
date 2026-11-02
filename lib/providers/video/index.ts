import { WanProvider } from './wan';
import type { VideoProvider } from './types';

let instance: VideoProvider | null = null;

/** 目前只接入通义万相 wan3.0（All-in-One 多模态视频模型） */
export function getProvider(): VideoProvider {
  instance ??= new WanProvider();
  return instance;
}

export type { CreateVideoInput, VideoProvider, VideoTaskState } from './types';
