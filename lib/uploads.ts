import path from 'node:path';
import sharp from 'sharp';

/** 项目素材文件存放目录（已 gitignore） */
export const UPLOAD_DIR = path.join(process.cwd(), '.data', 'uploads');

/** 单个素材大小上限 */
export const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;

/** 是否为本站上传的素材地址 */
export function isUploadUrl(url: string): boolean {
  return url.startsWith('/api/uploads/');
}

/** 图片压缩后的长边上限：云端视频模型只需要这个精度的参考图 */
const MAX_IMAGE_EDGE = 1280;
/** JPEG 质量 */
const IMAGE_QUALITY = 80;
/** 低于此体积不重编码，避免无谓的画质损失 */
const COMPRESS_MIN_BYTES = 400 * 1024;
/** 动图 / 矢量图不压缩：重编码会丢帧或失真 */
const SKIP_COMPRESS_MIME = new Set(['image/gif', 'image/svg+xml']);

export type CompressedImage = { data: Buffer; mime: string; ext: string };

/**
 * 上传图片瘦身。
 *
 * 为什么必须做：素材经公网隧道交给云端模型下载，隧道带宽很窄，
 * 原图动辄 2~3MB，模型侧会直接下载超时并判定任务失败。
 * 这里缩到长边 1280 的 JPEG（带透明通道的 PNG 铺白底），通常只剩几百 KB。
 *
 * 返回 null 表示无需 / 无法压缩，调用方直接用原始数据。
 */
export async function compressImage(buffer: Buffer, mime: string): Promise<CompressedImage | null> {
  if (!mime.startsWith('image/') || SKIP_COMPRESS_MIME.has(mime)) return null;
  if (buffer.byteLength <= COMPRESS_MIN_BYTES) return null;

  try {
    const pipeline = sharp(buffer, { failOn: 'none' })
      // EXIF 方向必须先摆正，否则手机竖拍的图会被拉横
      .rotate()
      .resize({
        width: MAX_IMAGE_EDGE,
        height: MAX_IMAGE_EDGE,
        fit: 'inside',
        withoutEnlargement: true,
      })
      // JPEG 不支持透明，透明区域铺白底，避免变成黑块
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: IMAGE_QUALITY, mozjpeg: true });

    const compressed = await pipeline.toBuffer();
    if (compressed.byteLength >= buffer.byteLength) return null;

    return { data: compressed, mime: 'image/jpeg', ext: '.jpg' };
  } catch {
    // 解码失败的图（异常 PNG、CMYK 等）按原样保存，不阻断上传
    return null;
  }
}
