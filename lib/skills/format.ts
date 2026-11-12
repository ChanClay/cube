/** 时间戳 → 「刚刚 / 3 分钟前 / 2 小时前 / 5 天前 / 10 月 26 日」 */
export function timeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp;
  if (!Number.isFinite(diff) || diff < 0) return '';
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;

  const date = new Date(timestamp);
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}
