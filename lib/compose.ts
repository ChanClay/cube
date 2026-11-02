import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isLocalVideoUrl, localVideoPath } from './videos';

/** 合成结果存放目录（已 gitignore） */
export const EXPORT_DIR = path.join(process.cwd(), '.data', 'exports');
const TMP_DIR = path.join(process.cwd(), '.data', 'tmp');
const MAX_EXPORTS = 10;

export class ComposeError extends Error {
  constructor(
    message: string,
    readonly status = 500,
  ) {
    super(message);
    this.name = 'ComposeError';
  }
}

let ffmpegCache: string | null | undefined;

/** 解析 ffmpeg 可执行文件：FFMPEG_PATH 优先，其次 PATH */
export function resolveFfmpeg(): string | null {
  if (ffmpegCache !== undefined) return ffmpegCache;

  const explicit = process.env.FFMPEG_PATH?.trim();
  if (explicit) {
    ffmpegCache = explicit;
    return ffmpegCache;
  }

  const probe = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  ffmpegCache = probe.status === 0 ? 'ffmpeg' : null;
  return ffmpegCache;
}

export function ffmpegMissingMessage(): string {
  return '未检测到 ffmpeg，无法合成视频。macOS 执行 `brew install ffmpeg`，或在 .env.local 中设置 FFMPEG_PATH 指向可执行文件，然后重启服务。';
}

function runFfmpeg(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 20000) stderr = stderr.slice(-20000);
    });

    child.on('error', (err) => reject(new ComposeError(`启动 ffmpeg 失败：${err.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new ComposeError(`ffmpeg 合成失败（exit ${code}）：${stderr.slice(-600)}`));
    });
  });
}

async function downloadVideo(url: string, dest: string): Promise<void> {
  // 本地转存的视频直接复制，省一次网络往返
  if (isLocalVideoUrl(url)) {
    await fs.copyFile(localVideoPath(url), dest);
    return;
  }

  const res = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!res.ok || !res.body) {
    throw new ComposeError(`下载镜头视频失败（HTTP ${res.status}）：${url.slice(0, 120)}`);
  }
  await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(dest));
}

interface ClipProbe {
  /** 容器时长（秒），解析失败时为 0 */
  duration: number;
  hasAudio: boolean;
}

/** 只读文件头，读出时长与是否自带音轨（无输出时 ffmpeg 必然非 0 退出，忽略退出码） */
function probeClip(bin: string, file: string): ClipProbe {
  const res = spawnSync(bin, ['-hide_banner', '-i', file], { encoding: 'utf8' });
  const text = `${res.stderr ?? ''}${res.stdout ?? ''}`;
  const match = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const duration = match
    ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
    : 0;
  return { duration, hasAudio: /Stream #\d+:\d+.*: Audio:/.test(text) };
}

async function pruneExports(): Promise<void> {
  try {
    const files = (await fs.readdir(EXPORT_DIR)).filter((f) => f.endsWith('.mp4'));
    if (files.length <= MAX_EXPORTS) return;

    const withTime = await Promise.all(
      files.map(async (file) => {
        const stat = await fs.stat(path.join(EXPORT_DIR, file));
        return { file, mtime: stat.mtimeMs };
      }),
    );
    withTime.sort((a, b) => b.mtime - a.mtime);
    for (const item of withTime.slice(MAX_EXPORTS)) {
      await fs.rm(path.join(EXPORT_DIR, item.file), { force: true });
    }
  } catch {
    // 清理失败不影响主流程
  }
}

export interface ComposeResult {
  fileName: string;
  url: string;
  bytes: number;
  clips: number;
}

/**
 * 把多个镜头视频按顺序拼接成一个 MP4：
 * 全部重新编码到统一分辨率（scale + pad），避免分辨率/编码不一致导致 concat 失败。
 * 任一镜头自带音轨时保留声音：统一 48kHz 立体声，无音轨的镜头补等长静音。
 */
export async function composeVideos(
  inputs: { url: string }[],
  size = '1280x720',
): Promise<ComposeResult> {
  if (inputs.length < 2) throw new ComposeError('至少需要 2 个镜头视频才能合成', 400);

  const ffmpeg = resolveFfmpeg();
  if (!ffmpeg) throw new ComposeError(ffmpegMissingMessage(), 501);

  await fs.mkdir(EXPORT_DIR, { recursive: true });
  await fs.mkdir(TMP_DIR, { recursive: true });

  const [width, height] = size.split('x');
  const workDir = path.join(TMP_DIR, `compose-${Date.now()}`);

  try {
    await fs.mkdir(workDir, { recursive: true });

    // 1. 下载所有片段
    const files: string[] = [];
    for (let i = 0; i < inputs.length; i += 1) {
      const dest = path.join(workDir, `clip-${i}.mp4`);
      await downloadVideo(inputs[i].url, dest);
      files.push(dest);
    }

    // 2. 探测音轨：只要有一个镜头自带声音，成片就保留声音
    const probes = files.map((file) => probeClip(ffmpeg, file));
    const keepAudio =
      probes.every((probe) => probe.duration > 0) && probes.some((probe) => probe.hasAudio);

    // 3. 统一尺寸与音频参数后 concat
    const chains: string[] = [];
    const links: string[] = [];
    const silenceArgs: string[] = [];
    let silenceCount = 0;

    const scale = `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30`;

    for (let i = 0; i < files.length; i += 1) {
      const { duration, hasAudio } = probes[i];

      chains.push(
        keepAudio
          ? `[${i}:v]${scale},format=yuv420p,trim=duration=${duration},setpts=PTS-STARTPTS[v${i}]`
          : `[${i}:v]${scale}[v${i}]`,
      );

      if (!keepAudio) continue;

      if (hasAudio) {
        chains.push(
          `[${i}:a]aresample=48000,` +
            `aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,` +
            `apad=whole_dur=${duration},atrim=duration=${duration},asetpts=N/SR/TB[a${i}]`,
        );
      } else {
        // 无声镜头补一段等长静音，保证每段音视频对齐、参数一致
        const source = files.length + silenceCount;
        silenceCount += 1;
        silenceArgs.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
        chains.push(
          `[${source}:a]atrim=duration=${duration},asetpts=N/SR/TB,` +
            `aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a${i}]`,
        );
      }

      links.push(`[v${i}][a${i}]`);
    }

    const filter = keepAudio
      ? `${chains.join(';')};${links.join('')}concat=n=${files.length}:v=1:a=1[outv][outa]`
      : `${chains.join(';')};${files.map((_, i) => `[v${i}]`).join('')}concat=n=${files.length}:v=1:a=0,format=yuv420p[out]`;

    const fileName = `compose-${Date.now()}.mp4`;
    const outPath = path.join(EXPORT_DIR, fileName);

    const args = [
      '-y',
      ...files.flatMap((file) => ['-i', file]),
      ...silenceArgs,
      '-filter_complex',
      filter,
      '-map',
      keepAudio ? '[outv]' : '[out]',
      ...(keepAudio ? ['-map', '[outa]', '-c:a', 'aac', '-b:a', '192k'] : ['-an']),
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '20',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      outPath,
    ];

    await runFfmpeg(ffmpeg, args);

    const stat = await fs.stat(outPath);
    await pruneExports();

    return {
      fileName,
      url: `/api/exports/${fileName}`,
      bytes: stat.size,
      clips: files.length,
    };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
