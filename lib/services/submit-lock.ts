import { createHash } from 'node:crypto';

/**
 * 进程内提交锁：同一个 key 在释放之前，只允许一个请求真正打到模型 / provider。
 *
 * 为什么需要：按钮双击、两个标签页同时点、浏览器自动重试，都会在服务端排成两个
 * 独立请求。视频按秒计费、剧本按 token 计费，重复提交就是白花钱。
 *
 * 语义上只拦「同一件事同时发生」：上一次结束后再提交仍然放行，
 * 用户主动重试不该被挡。
 *
 * 局限：只在单进程内有效（next start 默认单进程）。多实例部署时，
 * 视频这一路还有数据库里的活动任务兜底（见 `findActiveJob`）。
 */
const locks = new Map<string, number>();

/** 进程崩在锁里时不能永久卡死：超过这个时间视为陈旧锁自动失效 */
const LOCK_TTL_MS = 10 * 60 * 1000;

function prune(now: number): void {
  for (const [key, at] of locks) {
    if (now - at > LOCK_TTL_MS) locks.delete(key);
  }
}

/** 拿锁；false 表示同一件事正在处理中 */
export function acquireSubmitLock(key: string): boolean {
  const now = Date.now();
  prune(now);
  if (locks.has(key)) return false;
  locks.set(key, now);
  return true;
}

export function releaseSubmitLock(key: string): void {
  locks.delete(key);
}

/**
 * 拿锁执行；没拿到直接返回 null（调用方回 409，不要排队等待）。
 * finally 一定释放，异常也不会把 key 永久占住。
 */
export async function withSubmitLock<T>(
  key: string,
  task: () => Promise<T>,
): Promise<T | null> {
  if (!acquireSubmitLock(key)) return null;
  try {
    return await task();
  } finally {
    releaseSubmitLock(key);
  }
}

/**
 * 把请求参数折成稳定短 key。
 *
 * 用哈希而不是原文：锁 key 可能进日志，没有理由把剧本原文写进去。
 */
export function submitLockKey(namespace: string, parts: Array<string | number | undefined>): string {
  const raw = parts.map((part) => String(part ?? '')).join('\u0000');
  const digest = createHash('sha1').update(raw).digest('hex').slice(0, 16);
  return `${namespace}:${digest}`;
}
