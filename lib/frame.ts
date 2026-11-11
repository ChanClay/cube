import { spawn } from 'node:child_process';
import { createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ffmpegMissingMessage, resolveFfmpeg } from './compose';
import { isLocalVideoUrl, localVideoPath } from './videos';

/**
 * 关键帧抽取：把一个已生成的镜头视频抽一帧成 jpg，
 * 作为下一镜的 first_frame 素材，保证画面能接住上一镜。
 */

/** 抽出的关键帧存放目录（已 gitignore） */
export const FRAME_DIR = path.join(process.cwd(), '.data', 'frames');
const TMP_DIR = path.join(process.cwd(), '.data', 'tmp');
const MAX_FRAMES = 200;

export type FramePosition = 'last' | 'first';

export class FrameError extends Error {
  constructor(
    message: string,
    readonly status = 500,
  ) {
    super(message);
    this.name = 'FrameError';
  }
}

function runFfmpeg(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 20000) stderr = stderr.slice(-20000);
    });
    child.on('error', (err) => reject(new FrameError(`启动 ffmpeg 失败：${err.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new FrameError(`ffmpeg 抽帧失败（exit ${code}）：${stderr.slice(-400)}`));
    });
  });
}

async function downloadVideo(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!res.ok || !res.body) {
    throw new FrameError(`下载镜头视频失败（HTTP ${res.status}）：${url.slice(0, 120)}`, 502);
  }
  await pipeline(
    Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
    createWriteStream(dest),
  );
}

/**
 * 抽一帧，交给调用方判断是否产出非空文件。
 *
 * 用 PNG 而不是 JPEG：这张图会被视频模型当成首帧再编码一次，
 * JPEG 的块状压缩痕迹会被模型放大成整段画面的噪点与涂抹感。
 */
async function grabFrame(
  bin: string,
  input: string,
  output: string,
  position: FramePosition,
): Promise<boolean> {
  /**
   * 末帧取结尾前 0.1s。原来是 -0.4s：成片里上一镜的最后 0.4 秒会被下一镜从
   * 「0.4 秒之前」重新演一遍，接缝处看起来就是动作往回跳了一小段。
   * 留 0.1s 只是为了避免落在编码器的最后一帧上。
   */
  const args =
    position === 'last'
      ? ['-y', '-sseof', '-0.1', '-i', input, '-frames:v', '1', '-an', output]
      : ['-y', '-ss', '0', '-i', input, '-frames:v', '1', '-an', output];

  try {
    await runFfmpeg(bin, args);
  } catch {
    return false;
  }

  const stat = await fs.stat(output).catch(() => null);
  return !!stat && stat.size > 0;
}

async function pruneFrames(): Promise<void> {
  try {
    const files = (await fs.readdir(FRAME_DIR)).filter((file) => /\.(png|jpg)$/i.test(file));
    if (files.length <= MAX_FRAMES) return;

    const withTime = await Promise.all(
      files.map(async (file) => {
        const stat = await fs.stat(path.join(FRAME_DIR, file));
        return { file, mtime: stat.mtimeMs };
      }),
    );
    withTime.sort((a, b) => b.mtime - a.mtime);
    for (const item of withTime.slice(MAX_FRAMES)) {
      await fs.rm(path.join(FRAME_DIR, item.file), { force: true });
    }
  } catch {
    // 清理失败不影响主流程
  }
}

export interface ExtractedFrame {
  fileName: string;
  /** 站内相对地址：/api/frames/xxx.jpg */
  url: string;
}

/** 从远端视频抽一帧；默认取末帧（最能承接下一镜），失败时退回首帧 */
export async function extractFrame(
  videoUrl: string,
  position: FramePosition = 'last',
): Promise<ExtractedFrame> {
  const trimmed = (videoUrl ?? '').trim();
  // 本地转存的视频（/api/videos/xxx.mp4）直接读文件，不用再下载一遍
  if (!/^https?:\/\/\S+$/i.test(trimmed) && !isLocalVideoUrl(trimmed)) {
    throw new FrameError('视频地址不合法，需要一个可访问的 http(s) 链接', 400);
  }

  const ffmpeg = resolveFfmpeg();
  if (!ffmpeg) throw new FrameError(ffmpegMissingMessage(), 501);

  await fs.mkdir(FRAME_DIR, { recursive: true });
  await fs.mkdir(TMP_DIR, { recursive: true });

  const workDir = path.join(TMP_DIR, `frame-${Date.now()}`);
  try {
    await fs.mkdir(workDir, { recursive: true });
    const input = path.join(workDir, 'clip.mp4');
    if (isLocalVideoUrl(trimmed)) {
      await fs.copyFile(localVideoPath(trimmed), input);
    } else {
      await downloadVideo(trimmed, input);
    }

    const fileName = `frame-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
    const output = path.join(FRAME_DIR, fileName);

    let ok = await grabFrame(ffmpeg, input, output, position);
    if (!ok && position !== 'first') {
      ok = await grabFrame(ffmpeg, input, output, 'first');
    }
    if (!ok) throw new FrameError('抽帧失败：视频可能无法解码或内容为空', 502);

    await pruneFrames();
    return { fileName, url: `/api/frames/${fileName}` };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
