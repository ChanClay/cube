import { currentUserId } from './auth';
import { getDb } from './db';
import type { JobStatus, MediaInput, VideoJob } from './types';

const MAX_JOBS = 300;

interface JobRow {
  id: string;
  shot_id: string;
  provider: string;
  provider_job_id: string | null;
  status: string;
  progress: number | null;
  video_url: string | null;
  error: string | null;
  prompt: string;
  duration: number;
  resolution: string;
  media_json: string | null;
  created_at: number | string;
  updated_at: number | string;
}

function parseMedia(raw: string | null): MediaInput[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is MediaInput => {
        const record = item as Record<string, unknown> | null;
        return !!record && typeof record.type === 'string' && typeof record.url === 'string';
      })
      .map((item) => ({ type: item.type, url: item.url }));
  } catch {
    return [];
  }
}

function toJob(row: JobRow): VideoJob {
  return {
    id: row.id,
    shotId: row.shot_id,
    provider: row.provider,
    providerJobId: row.provider_job_id ?? null,
    status: row.status as JobStatus,
    progress: row.progress === null ? null : Number(row.progress),
    videoUrl: row.video_url ?? null,
    error: row.error ?? null,
    prompt: row.prompt,
    duration: Number(row.duration),
    resolution: row.resolution,
    media: parseMedia(row.media_json),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export async function listJobs(): Promise<VideoJob[]> {
  const pool = await getDb();
  const userId = await currentUserId();
  const [rows] = await pool.query(
    'SELECT * FROM video_jobs WHERE user_id = ? ORDER BY created_at DESC',
    [userId],
  );
  return (rows as JobRow[]).map(toJob);
}

export async function getJob(id: string): Promise<VideoJob | null> {
  const pool = await getDb();
  const userId = await currentUserId();
  const [rows] = await pool.query(
    'SELECT * FROM video_jobs WHERE id = ? AND user_id = ? LIMIT 1',
    [id, userId],
  );
  const row = (rows as JobRow[])[0];
  return row ? toJob(row) : null;
}

export async function saveJob(job: VideoJob): Promise<VideoJob> {
  const pool = await getDb();
  const userId = await currentUserId();
  const updatedAt = Date.now();
  const mediaJson = job.media && job.media.length > 0 ? JSON.stringify(job.media) : null;

  await pool.query(
    `INSERT INTO video_jobs
       (id, user_id, shot_id, provider, provider_job_id, status, progress, video_url, error,
        prompt, duration, resolution, media_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       shot_id         = VALUES(shot_id),
       provider        = VALUES(provider),
       provider_job_id = VALUES(provider_job_id),
       status          = VALUES(status),
       progress        = VALUES(progress),
       video_url       = VALUES(video_url),
       error           = VALUES(error),
       prompt          = VALUES(prompt),
       duration        = VALUES(duration),
       resolution      = VALUES(resolution),
       media_json      = VALUES(media_json),
       updated_at      = VALUES(updated_at)`,
    [
      job.id,
      userId,
      job.shotId,
      job.provider,
      job.providerJobId ?? null,
      job.status,
      job.progress ?? null,
      job.videoUrl ?? null,
      job.error ?? null,
      job.prompt,
      job.duration,
      job.resolution,
      mediaJson,
      job.createdAt,
      updatedAt,
    ],
  );

  // 只裁剪当前用户自己的历史，避免把别人的任务删掉
  await pool.query(
    `DELETE FROM video_jobs
     WHERE user_id = ?
       AND id NOT IN (
         SELECT id FROM (
           SELECT id FROM video_jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT ${MAX_JOBS}
         ) AS keep
       )`,
    [userId, userId],
  );

  return { ...job, updatedAt };
}

export async function updateJob(
  id: string,
  patch: Partial<Omit<VideoJob, 'id'>>,
): Promise<VideoJob | null> {
  const current = await getJob(id);
  if (!current) return null;
  return saveJob({ ...current, ...patch, id });
}

export async function countJobs(): Promise<number> {
  const pool = await getDb();
  const userId = await currentUserId();
  const [rows] = await pool.query(
    'SELECT COUNT(*) AS total FROM video_jobs WHERE user_id = ?',
    [userId],
  );
  return Number((rows as { total: number | string }[])[0]?.total ?? 0);
}
