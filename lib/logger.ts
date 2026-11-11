import { promises as fs } from 'node:fs';
import path from 'node:path';

const LOG_DIR = path.join(process.cwd(), '.data', 'logs');
const MAX_BYTES = 2 * 1024 * 1024;

export type LogChannel = 'video' | 'agent';
export type LogLevel = 'info' | 'warn' | 'error';

/** 超过 2MB 滚一次，只保留 xxx.log / xxx.log.1 */
async function rotate(file: string): Promise<void> {
  try {
    const stat = await fs.stat(file);
    if (stat.size < MAX_BYTES) return;
    await fs.rename(file, `${file}.1`);
  } catch {
    // 文件不存在时忽略
  }
}

/**
 * 记录错误/告警：
 * - 打到服务端控制台（npm run dev 的终端里能看到）
 * - 追加到 .data/logs/{channel}.log（重启后仍可追溯）
 */
export async function logEvent(
  channel: LogChannel,
  scope: string,
  detail: Record<string, unknown>,
  level: LogLevel = 'error',
): Promise<void> {
  const now = new Date();
  const entry = {
    time: now.toLocaleString('zh-CN', { hour12: false }),
    ts: now.getTime(),
    level,
    scope,
    ...detail,
  };

  const line = `[${channel}:${scope}]`;
  if (level === 'error') console.error(line, detail);
  else if (level === 'warn') console.warn(line, detail);
  else console.log(line, detail);

  try {
    await fs.mkdir(LOG_DIR, { recursive: true });
    const file = path.join(LOG_DIR, `${channel}.log`);
    await rotate(file);
    await fs.appendFile(file, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    // 写日志失败不影响主流程
  }
}

/** 视频模型调用错误 */
export async function logVideoError(
  scope: 'create' | 'sync' | 'compose' | 'persist',
  detail: Record<string, unknown>,
): Promise<void> {
  return logEvent('video', scope, detail, 'error');
}

/** 剧本 agent 链路异常（改编 / 蓝图 / 翻译 / 审片失败会降级，属于告警） */
export async function logAgentWarn(
  scope: 'adapt' | 'plan' | 'script' | 'localize' | 'review',
  detail: Record<string, unknown>,
): Promise<void> {
  return logEvent('agent', scope, detail, 'warn');
}
