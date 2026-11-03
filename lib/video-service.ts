import { config } from '@/lib/config';
import { logVideoError } from '@/lib/logger';
import { hasCarryFrame } from '@/lib/media';
import { getProvider } from '@/lib/providers/video';
import { getJob, listJobs, saveJob, updateJob } from '@/lib/store';
import { isLocalVideoUrl, persistRemoteVideo } from '@/lib/videos';
import type { MediaInput, VideoJob } from '@/lib/types';

export interface StartVideoJobInput {
  shotId: string;
  prompt: string;
  duration?: number;
  resolution?: string;
  media?: MediaInput[];
}

/** canceled 也算终态：放弃之后不再回查 provider，避免状态被覆盖回运行中 */
const isTerminal = (job: VideoJob) =>
  job.status === 'succeeded' || job.status === 'failed' || job.status === 'canceled';

/** provider 的临时链接只活 24 小时，超出这个窗口就没必要再尝试转存了 */
const PERSIST_WINDOW_MS = 24 * 60 * 60 * 1000;

/** 成功但还挂着 provider 临时地址的任务，需要补偿转存 */
const needsPersist = (job: VideoJob) =>
  job.status === 'succeeded' &&
  !!job.videoUrl &&
  !isLocalVideoUrl(job.videoUrl) &&
  Date.now() - job.updatedAt < PERSIST_WINDOW_MS;

export async function startVideoJob(input: StartVideoJobInput): Promise<VideoJob> {
  const provider = getProvider();
  const now = Date.now();
  const duration =
    Number(input.duration) > 0 ? Number(input.duration) : config.video.defaultDuration;
  const resolution = input.resolution || config.video.resolution;
  const media = input.media ?? [];

  /**
   * 首帧来自上一镜末帧时，画面是接着上一镜的，但音轨由这一镜从头生成：
   * 音色、语气、环境声都会突然断掉，合成后听着就是「音频衔接不上」。
   * 首帧模式又没法用 reference_audio 锁定音色，所以这类镜头默认不生成音频；
   * 需要声音可以设 VIDEO_AUDIO_ON_CARRY=1 恢复。
   */
  const audio = config.video.audio && (!hasCarryFrame(media) || config.video.audioOnCarry);

  const job: VideoJob = {
    id: crypto.randomUUID(),
    shotId: input.shotId,
    provider: provider.name,
    providerJobId: null,
    status: 'queued',
    progress: null,
    videoUrl: null,
    error: null,
    prompt: input.prompt,
    duration,
    resolution,
    media,
    createdAt: now,
    updatedAt: now,
  };

  // 先提交给 provider：没提交成功的任务不写库，避免库里堆无用记录
  let providerJobId: string;
  try {
    const created = await provider.createTask({
      prompt: input.prompt,
      duration,
      resolution,
      media,
      audio,
    });
    providerJobId = created.providerJobId;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // 这类失败不写库，只能靠日志追溯
    void logVideoError('create', {
      shotId: input.shotId,
      provider: provider.name,
      duration,
      resolution,
      mediaCount: media.length,
      prompt: input.prompt.slice(0, 120),
      error: message,
    });
    return { ...job, status: 'failed', error: message, updatedAt: Date.now() };
  }

  // 提交成功才落库；写库失败会抛错，说明任务已提交但本地没记录
  return saveJob({ ...job, providerJobId, status: 'running', updatedAt: Date.now() });
}

/**
 * 把 provider 的临时视频地址转存到本地。
 * 失败不把任务判死——保留临时地址，下次轮询再试，但 24 小时后会失效。
 */
async function localizeVideo(job: VideoJob, url: string): Promise<string> {
  if (isLocalVideoUrl(url)) return url;

  try {
    return await persistRemoteVideo(url);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    void logVideoError('persist', {
      jobId: job.id,
      shotId: job.shotId,
      remoteUrl: url.slice(0, 120),
      error: message,
      note: '视频转存失败，先保留临时地址（24 小时后失效），下次轮询会重试',
    });
    return url;
  }
}

export async function syncVideoJob(job: VideoJob): Promise<VideoJob> {
  // 已经跑完但还挂着临时地址：补偿转存，避免链接过期
  if (isTerminal(job)) {
    if (!needsPersist(job)) return job;
    const local = await localizeVideo(job, job.videoUrl as string);
    if (local === job.videoUrl) return job;
    return (await updateJob(job.id, { videoUrl: local })) ?? job;
  }

  if (!job.providerJobId) return job;

  const provider = getProvider();
  try {
    const state = await provider.getTask(job.providerJobId);

    // 一拿到成品就落盘，别等到用户第二天再看
    let videoUrl = state.videoUrl ?? job.videoUrl;
    if (state.status === 'succeeded' && videoUrl && !isLocalVideoUrl(videoUrl)) {
      videoUrl = await localizeVideo(job, videoUrl);
    }

    const changed =
      state.status !== job.status ||
      (videoUrl ?? null) !== (job.videoUrl ?? null) ||
      (state.progress ?? null) !== (job.progress ?? null) ||
      (state.error ?? null) !== (job.error ?? null);
    if (!changed) return job;

    // 只在状态第一次转成 failed 时记一条，避免每次轮询重复刷屏
    if (state.status === 'failed' && job.status !== 'failed') {
      void logVideoError('sync', {
        jobId: job.id,
        shotId: job.shotId,
        providerJobId: job.providerJobId,
        status: 'failed',
        error: state.error ?? '视频生成失败',
        prompt: job.prompt.slice(0, 120),
      });
    }

    return (
      (await updateJob(job.id, {
        status: state.status,
        videoUrl: videoUrl ?? job.videoUrl,
        progress: state.progress ?? job.progress,
        error: state.error ?? job.error,
      })) ?? job
    );
  } catch (err) {
    // 网络抖动等临时错误：只记录，不把任务判死
    const message = err instanceof Error ? err.message : String(err);
    void logVideoError('sync', {
      jobId: job.id,
      shotId: job.shotId,
      providerJobId: job.providerJobId,
      error: message,
      note: '查询任务失败（任务未判为失败，下次轮询会重试）',
    });
    return (await updateJob(job.id, { error: message })) ?? job;
  }
}

export async function syncAllJobs(): Promise<VideoJob[]> {
  const jobs = await listJobs();
  const pending = jobs
    .filter((job) => (!isTerminal(job) && !!job.providerJobId) || needsPersist(job))
    .slice(0, 12);
  if (pending.length === 0) return jobs;

  const synced = await Promise.all(pending.map((job) => syncVideoJob(job)));
  const updated = new Map(synced.map((job) => [job.id, job]));
  return jobs.map((job) => updated.get(job.id) ?? job);
}

export async function syncJobById(id: string): Promise<VideoJob | null> {
  const job = await getJob(id);
  if (!job) return null;
  return syncVideoJob(job);
}
