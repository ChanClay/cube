import type { JobStatus, MediaInput } from '@/lib/types';

export interface CreateVideoInput {
  prompt: string;
  duration: number;
  resolution: string;
  /** 画幅比例，来自项目设置；不传时用全局 VIDEO_RATIO 兜底 */
  ratio?: string;
  media: MediaInput[];
  /**
   * 是否要模型生成音轨；wan3.0（`audio`）与 Seedance（`generate_audio`）认这个开关
   * （不传时用全局 VIDEO_AUDIO）。
   * HappyHorse 1.1 始终生成音轨、没有对应参数，会忽略该字段。
   */
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
  /** provider 标识，落在 VideoJob.provider 上，回查状态时按它找到同一个实现 */
  readonly name: string;
  /** 实际生效的模型名（健康检查展示用） */
  readonly model: string;
  createTask(input: CreateVideoInput): Promise<{ providerJobId: string }>;
  getTask(providerJobId: string): Promise<VideoTaskState>;
}
