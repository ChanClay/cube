import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, promises as fs } from 'node:fs';
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
let ffprobeCache: string | null | undefined;

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

/**
 * 解析 ffprobe：优先 FFPROBE_PATH，其次 FFMPEG_PATH 同目录（brew 装 ffmpeg 会一起带上），
 * 最后试 PATH。拿不到时合成退化为只读 ffmpeg 文件头（时长精度差一帧）。
 */
function resolveFfprobe(): string | null {
  if (ffprobeCache !== undefined) return ffprobeCache;

  const explicit = process.env.FFPROBE_PATH?.trim();
  if (explicit) {
    ffprobeCache = explicit;
    return ffprobeCache;
  }

  const ffmpeg = resolveFfmpeg();
  if (ffmpeg && ffmpeg !== 'ffmpeg') {
    const sibling = path.join(
      path.dirname(ffmpeg),
      process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe',
    );
    if (existsSync(sibling)) {
      ffprobeCache = sibling;
      return ffprobeCache;
    }
  }

  const probe = spawnSync('ffprobe', ['-version'], { stdio: 'ignore' });
  ffprobeCache = probe.status === 0 ? 'ffprobe' : null;
  return ffprobeCache;
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
  /** 视频流帧率，解析失败时为 0 */
  fps: number;
}

/**
 * 优先用 ffprobe 读**视频流**自己的时长。
 *
 * 容器时长取的是音视频里较长的那条：模型经常输出 8.00 秒画面 + 8.03 秒音轨，
 * 按容器时长 trim / apad，音频每镜就多出 30ms，拼到第 10 镜就是对不上的口型。
 */
function probeWithFfprobe(ffprobe: string, file: string): ClipProbe | null {
  const res = spawnSync(
    ffprobe,
    [
      '-v',
      'error',
      '-show_entries',
      'stream=codec_type,duration,r_frame_rate',
      '-show_entries',
      'format=duration',
      '-of',
      'json',
      file,
    ],
    { encoding: 'utf8' },
  );
  if (res.status !== 0) return null;

  try {
    const data = JSON.parse(res.stdout ?? '{}') as {
      streams?: { codec_type?: string; duration?: string; r_frame_rate?: string }[];
      format?: { duration?: string };
    };
    const streams = data.streams ?? [];
    const video = streams.find((stream) => stream.codec_type === 'video');
    if (!video) return null;

    const videoDuration = Number(video.duration);
    const formatDuration = Number(data.format?.duration);
    const duration =
      Number.isFinite(videoDuration) && videoDuration > 0
        ? videoDuration
        : Number.isFinite(formatDuration)
          ? formatDuration
          : 0;

    // r_frame_rate 形如 "30/1"，少数容器给 "N/A"
    const [num, den] = (video.r_frame_rate ?? '').split('/').map(Number);
    const fps = Number.isFinite(num) && Number.isFinite(den) && den > 0 ? num / den : 0;

    return {
      duration,
      hasAudio: streams.some((stream) => stream.codec_type === 'audio'),
      fps,
    };
  } catch {
    return null;
  }
}

/** ffprobe 不可用时的兜底：只读文件头（无输出时 ffmpeg 必然非 0 退出，忽略退出码） */
function probeClip(bin: string, file: string): ClipProbe {
  const res = spawnSync(bin, ['-hide_banner', '-i', file], { encoding: 'utf8' });
  const text = `${res.stderr ?? ''}${res.stdout ?? ''}`;
  const match = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const duration = match
    ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
    : 0;
  // 形如 "Video: h264 ..., 854x480, 30 fps, 30 tbr"，只在本行内匹配，别串到音频流
  const fpsMatch = text.match(/Video:[^\n]*?(\d+(?:\.\d+)?)\s*fps/);
  const fps = fpsMatch ? Number(fpsMatch[1]) : 0;
  return { duration, hasAudio: /Stream #\d+:\d+.*: Audio:/.test(text), fps };
}

/**
 * 成片帧率取素材里的最高值。
 * 原来写死 fps=30：24fps 的素材会被整段补重复帧，运动看着就是「一顿一顿」的抖，
 * 30fps 素材则完全不受影响。取最高值只会给低帧率素材补帧，不会给高帧率素材丢帧。
 */
function targetFps(probes: ClipProbe[]): number {
  const values = probes
    .map((probe) => probe.fps)
    .filter((fps) => Number.isFinite(fps) && fps >= 1 && fps <= 120);
  if (values.length === 0) return 30;
  // 29.97 / 23.976 这类保留两位小数，整数帧率仍按整数走
  return Math.round(Math.max(...values) * 100) / 100;
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
    const ffprobe = resolveFfprobe();
    const probes = files.map(
      (file) => (ffprobe ? probeWithFfprobe(ffprobe, file) : null) ?? probeClip(ffmpeg, file),
    );
    const keepAudio =
      probes.every((probe) => probe.duration > 0) && probes.some((probe) => probe.hasAudio);
    const fps = targetFps(probes);

    // 3. 统一尺寸与音频参数后 concat
    const chains: string[] = [];
    const links: string[] = [];
    const silenceArgs: string[] = [];
    let silenceCount = 0;

    // lanczos 缩放保留更多高频细节，避免 480p → 1080p 时糊成一片
    const scale = `scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos,` +
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps}`;

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
      // 素材本身已经是压缩过的，再叠一层 veryfast / crf20 会在运动画面里出块状拖影；
      // 这里用 medium / crf18，60 秒 1080p 也只是多几秒
      '-preset',
      'medium',
      '-crf',
      '18',
      // 锁定恒定帧率，避免拼接处出现时间戳抖动
      '-r',
      String(fps),
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
