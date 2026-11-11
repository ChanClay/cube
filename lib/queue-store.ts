/**
 * 「全部生成」串行队列的落盘标记。
 *
 * 队列本身跑在浏览器里（`app/projects/[id]/page.tsx` 的 handleGenerateAll），
 * 刷新页面就等于把队列掐断——已提交到云端的那一镜会继续跑，后面的镜头却再也不会提交。
 * 所以开始排队时在 localStorage 留一个标记，页面重新加载后据此把队列接上：
 * 已经成功的镜头会被跳过，正在云端跑的那一镜会等它跑完。
 */

const PREFIX = 'aivideo:queue:';

/** 标记的有效期：太久以前的标记不再自动续跑，免得几天后打开页面又偷偷开始花钱 */
const MARK_TTL_MS = 12 * 60 * 60 * 1000;

const storage = (): Storage | null => {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage;
  } catch {
    // 隐私模式 / 禁用存储时不要影响生成本身
    return null;
  }
};

const keyOf = (scriptId: string) => `${PREFIX}${scriptId}`;

/** 记下「这份剧本的串行队列正在跑」 */
export function markQueueRunning(scriptId: string): void {
  try {
    storage()?.setItem(keyOf(scriptId), String(Date.now()));
  } catch {
    // 存不下就算了，刷新后不续跑，但不影响本次生成
  }
}

/** 队列结束 / 用户点了停止 / 剧本被删：清掉标记，刷新后不再续跑 */
export function clearQueueMark(scriptId: string): void {
  try {
    storage()?.removeItem(keyOf(scriptId));
  } catch {
    // 忽略
  }
}

/** 读出上次没跑完的队列标记，返回开始时间；没有或已过期返回 null */
export function readQueueMark(scriptId: string): number | null {
  let raw: string | null = null;
  try {
    raw = storage()?.getItem(keyOf(scriptId)) ?? null;
  } catch {
    return null;
  }
  if (!raw) return null;

  const startedAt = Number(raw);
  if (!Number.isFinite(startedAt)) {
    clearQueueMark(scriptId);
    return null;
  }
  if (Date.now() - startedAt > MARK_TTL_MS) {
    clearQueueMark(scriptId);
    return null;
  }
  return startedAt;
}
