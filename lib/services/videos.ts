import { createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** 生成好的视频落盘目录（已 gitignore），避免通义万相 24 小时的临时链接失效 */
export const VIDEO_DIR = path.join(process.cwd(), '.data', 'videos');

const LOCAL_PREFIX = '/api/videos/';

/** 单个视频转存上限，防止异常大文件把磁盘写满 */
const MAX_VIDEO_BYTES = 800 * 1024 * 1024;

const DOWNLOAD_TIMEOUT_MS = 300_000;

/** 是否已经是本站转存的视频地址 */
export function isLocalVideoUrl(url: string): boolean {
  return url.startsWith(LOCAL_PREFIX);
}

/** 站内地址 → 本机文件路径 */
export function localVideoPath(url: string): string {
  return path.join(VIDEO_DIR, path.basename(url));
}

/**
 * 把 provider 返回的临时地址下载到本地，返回站内永久地址。
 * 通义万相的 video_url 只保留 24 小时，不转存的话第二天链接就全失效了。
 *
 * 下载失败直接抛错，由调用方决定是否降级（保留临时地址）。
 */
export async function persistRemoteVideo(remoteUrl: string): Promise<string> {
  if (!/^https?:\/\//i.test(remoteUrl)) return remoteUrl;

  const res = await fetch(remoteUrl, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok || !res.body) {
    throw new Error(`下载视频失败（HTTP ${res.status}）`);
  }

  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_VIDEO_BYTES) {
    throw new Error(`视频超过 ${Math.round(MAX_VIDEO_BYTES / 1024 / 1024)}MB，已跳过转存`);
  }

  await fs.mkdir(VIDEO_DIR, { recursive: true });

  // 统一存成 .mp4：provider 给的扩展名不可靠，浏览器与 ffmpeg 都能直接吃
  const fileName = `${crypto.randomUUID()}.mp4`;
  const filePath = path.join(VIDEO_DIR, fileName);

  const tmpPath = `${filePath}.part`;
  try {
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(tmpPath));

    const written = await fs.stat(tmpPath);
    if (written.size === 0) throw new Error('下载的视频是空文件');
    if (written.size > MAX_VIDEO_BYTES) throw new Error('视频超过转存上限');

    await fs.rename(tmpPath, filePath);
  } catch (err) {
    await fs.rm(tmpPath, { force: true }).catch(() => undefined);
    throw err;
  }

  return `${LOCAL_PREFIX}${fileName}`;
}
