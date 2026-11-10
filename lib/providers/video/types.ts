import type { JobStatus, MediaInput } from '@/lib/types';

export interface CreateVideoInput {
  prompt: string;
  duration: number;
  resolution: string;
  /** 画幅比例，来自项目设置；不传时用全局 VIDEO_RATIO 兜底 */
  ratio?: string;
  media: MediaInput[];
  /** 是否要模型生成音轨；不传时用全局 VIDEO_AUDIO 配置 */
  audio?: boolean;
}

export interface VideoTaskState {
  id: string;
  status: JobStatus;
  videoUrl: string | null;
  progress: number | null;
  error: string | null;
}

export interface VideoProvider {
  readonly name: string;
  /** 实际生效的模型名 */
  readonly model: string;
  createTask(input: CreateVideoInput): Promise<{ providerJobId: string }>;
  getTask(providerJobId: string): Promise<VideoTaskState>;
}
