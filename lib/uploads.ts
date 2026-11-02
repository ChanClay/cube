import path from 'node:path';

/** 项目素材文件存放目录（已 gitignore） */
export const UPLOAD_DIR = path.join(process.cwd(), '.data', 'uploads');

/** 单个素材大小上限 */
export const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;

/** 是否为本站上传的素材地址 */
export function isUploadUrl(url: string): boolean {
  return url.startsWith('/api/uploads/');
}
