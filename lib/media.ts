import type { MediaInput, MediaType } from './types';

export const MEDIA_LABEL: Record<MediaType, string> = {
  first_frame: '首帧图',
  last_frame: '尾帧图',
  reference_image: '参考图',
  reference_video: '参考视频',
  reference_audio: '参考音频',
  file: '文档',
  link: '网页',
};

export const MEDIA_HINT: Record<MediaType, string> = {
  first_frame: '严格作为视频第一帧，最多 1 张',
  last_frame: '严格作为视频最后一帧，最多 1 张',
  reference_image: '角色 / 物品 / 风格参考，最多 10 张',
  reference_video: '运镜 / 动作 / 编辑参考，最多 5 段，总时长 ≤ 15s',
  reference_audio: '音色 / 节拍参考，最多 5 段，总时长 ≤ 15s',
  file: 'docx / xlsx / pptx / pdf / txt / md，最多 1 个',
  link: '无需登录的公开网页，最多 1 个',
};

/** 顺序即 UI 下拉顺序 */
export const MEDIA_TYPES: MediaType[] = [
  'first_frame',
  'last_frame',
  'reference_image',
  'reference_video',
  'reference_audio',
  'file',
  'link',
];

const LIMITS: Record<MediaType, number> = {
  first_frame: 1,
  last_frame: 1,
  reference_image: 10,
  reference_video: 5,
  reference_audio: 5,
  file: 1,
  link: 1,
};

export const MAX_MEDIA_TOTAL = 20;

const FRAME_TYPES: MediaType[] = ['first_frame', 'last_frame'];
const REFERENCE_TYPES: MediaType[] = [
  'reference_image',
  'reference_video',
  'reference_audio',
  'file',
  'link',
];

export function isMediaType(value: unknown): value is MediaType {
  return typeof value === 'string' && value in LIMITS;
}

/** 清理前端/接口传入的素材数组 */
export function sanitizeMedia(input: unknown): MediaInput[] {
  if (!Array.isArray(input)) return [];

  const result: MediaInput[] = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    if (!isMediaType(record.type)) continue;
    const url = typeof record.url === 'string' ? record.url.trim() : '';
    if (!url) continue;
    result.push({ type: record.type, url });
  }
  return result.slice(0, MAX_MEDIA_TOTAL);
}

export function countMedia(media: MediaInput[], type: MediaType): number {
  return media.filter((item) => item.type === type).length;
}

/** 返回错误信息，null 表示通过 */
export function validateMedia(media: MediaInput[]): string | null {
  if (media.length > MAX_MEDIA_TOTAL) {
    return `参考素材最多 ${MAX_MEDIA_TOTAL} 个`;
  }

  for (const type of MEDIA_TYPES) {
    const count = countMedia(media, type);
    if (count > LIMITS[type]) {
      return `${MEDIA_LABEL[type]}最多 ${LIMITS[type]} 个`;
    }
  }

  for (const item of media) {
    // 站内地址（/api/uploads/… /api/frames/…）由服务端按 PUBLIC_BASE_URL 拼成绝对地址
    const ok = /^https?:\/\/\S+$/i.test(item.url) || item.url.startsWith('/api/');
    if (!ok) {
      return `${MEDIA_LABEL[item.type]}需要可公网访问的 http(s) 链接：${item.url.slice(0, 60)}`;
    }
  }

  const hasFrame = FRAME_TYPES.some((type) => countMedia(media, type) > 0);
  const hasReference = REFERENCE_TYPES.some((type) => countMedia(media, type) > 0);
  if (hasFrame && hasReference) {
    return '首帧 / 尾帧不能与参考素材、文档、网页混用，请分开生成';
  }

  if (countMedia(media, 'file') > 0 && countMedia(media, 'link') > 0) {
    return '文档与网页链接只能二选一';
  }

  return null;
}

/** 站内相对地址补成绝对地址，视频模型（云端）才能拉取 */
export function absolutizeMediaUrl(url: string, origin: string): string {
  if (!url.startsWith('/')) return url;
  const base = origin.replace(/\/+$/, '');
  return `${base}${url}`;
}

/** 回环 / 局域网地址：云端视频模型都下载不到 */
const PRIVATE_HOST =
  /^(localhost|0\.0\.0\.0|\[::1\]|::1|127\.|10\.|192\.168\.|169\.254\.)|^172\.(1[6-9]|2\d|3[01])\./i;

/** 这个地址云端模型能不能访问到（localhost / 内网 IP 都不行） */
export function isPublicOrigin(origin: string): boolean {
  try {
    return !PRIVATE_HOST.test(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/**
 * 从上一镜视频末帧抽出来的首帧（落在 /api/frames/），也就是「承接上一镜」的标志。
 * 服务端据此关掉这一镜的原生音频，避免画面接着上一镜、声音却从头开始。
 */
export const isCarryFrameUrl = (url: string): boolean => url.includes('/api/frames/');

/** 这一镜是否用上一镜末帧当首帧 */
export function hasCarryFrame(media: MediaInput[] = []): boolean {
  return media.some((item) => item.type === 'first_frame' && isCarryFrameUrl(item.url));
}

/**
 * 这一镜是否把上一镜末帧当**参考图**带进来了。
 *
 * 和 `hasCarryFrame` 的区别很关键：那个是「画面接住上一镜」（首帧，与参考图互斥），
 * 这个只借光线 / 色调、不改构图，只有跨场景手动打开才会出现。
 */
export function hasPrevFrameReference(media: MediaInput[] = []): boolean {
  return media.some((item) => item.type === 'reference_image' && isCarryFrameUrl(item.url));
}

/** 给任务记录用的一句话摘要 */
export function mediaSummary(media: MediaInput[]): string {
  if (media.length === 0) return '纯文本';
  const counts = new Map<MediaType, number>();
  for (const item of media) counts.set(item.type, (counts.get(item.type) ?? 0) + 1);
  return [...counts.entries()]
    .map(([type, count]) => `${MEDIA_LABEL[type]}×${count}`)
    .join(' · ');
}
