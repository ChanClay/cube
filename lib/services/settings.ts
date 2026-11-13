import { getDb } from './db';
import {
  DEFAULT_VIDEO_MODEL_ID,
  isVideoModelId,
  normalizeVideoModel,
  type VideoModelId,
  type VideoModelSpec,
} from '@/lib/video-models';

/**
 * 全站键值设置（app_settings 表）。
 * 目前有「新建剧本的默认视频模型」与「下拉框里的模型显示顺序」，
 * 后续别的全局开关也走这里。
 */

const DEFAULT_MODEL_KEY = 'defaultVideoModel';
const MODEL_ORDER_KEY = 'videoModelOrder';

async function getSetting(key: string): Promise<string | null> {
  const pool = await getDb();
  const [rows] = await pool.query('SELECT value FROM app_settings WHERE key_name = ? LIMIT 1', [
    key,
  ]);
  return (rows as { value: string }[])[0]?.value ?? null;
}

async function setSetting(key: string, value: string): Promise<void> {
  const pool = await getDb();
  await pool.query(
    `INSERT INTO app_settings (key_name, value, updated_at) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at)`,
    [key, value, Date.now()],
  );
}

/** 新建剧本的默认视频模型；没设置过 / 值非法 / 库不可用时回落 DEFAULT_VIDEO_MODEL_ID */
export async function defaultVideoModel(): Promise<VideoModelId> {
  try {
    return normalizeVideoModel(await getSetting(DEFAULT_MODEL_KEY), DEFAULT_VIDEO_MODEL_ID);
  } catch {
    return DEFAULT_VIDEO_MODEL_ID;
  }
}

/** 保存默认视频模型（值在接口层先校验过，这里再兜一次非法值） */
export async function setDefaultVideoModel(value: unknown): Promise<VideoModelId> {
  const model = normalizeVideoModel(value, DEFAULT_VIDEO_MODEL_ID);
  await setSetting(DEFAULT_MODEL_KEY, model);
  return model;
}

/** 用户自定义的模型显示顺序；没设置过 / 值非法时返回空数组（用 VIDEO_MODELS 内置顺序） */
export async function videoModelOrder(): Promise<VideoModelId[]> {
  try {
    const raw = await getSetting(MODEL_ORDER_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter(isVideoModelId))];
  } catch {
    return [];
  }
}

/** 保存模型显示顺序（非法 ID 会被丢掉，重复 ID 去重） */
export async function setVideoModelOrder(value: unknown): Promise<VideoModelId[]> {
  const ids = Array.isArray(value) ? [...new Set(value.filter(isVideoModelId))] : [];
  await setSetting(MODEL_ORDER_KEY, JSON.stringify(ids));
  return ids;
}

/** 按用户自定义顺序排列模型；不在顺序里的模型（如新配置的）稳定地排在末尾 */
export function orderVideoModels(
  models: VideoModelSpec[],
  order: VideoModelId[],
): VideoModelSpec[] {
  const rank = (id: string) => {
    const index = order.indexOf(id as VideoModelId);
    return index === -1 ? order.length : index;
  };
  return [...models].sort((a, b) => rank(a.id) - rank(b.id));
}
