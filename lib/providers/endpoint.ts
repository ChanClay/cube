/**
 * 判断一个 base URL 属于哪套协议。
 *
 * - `native`：百炼 DashScope 原生地址，以 `/api/v1` 结尾
 *   （https://dashscope.aliyuncs.com/api/v1、https://cn-beijing.maas.qianwenaiapi.com/api/v1）
 *   视频走 `/services/aigc/...` + `/tasks/{id}`，图片走原生异步/同步协议。
 * - `gateway`：OpenAI 兼容中转网关（形如 https://viprouter.com/v1）
 *   视频走 `/videos`，图片走 `/images/generations`。
 *
 * 只填域名（没有版本段）时也按 gateway 处理，由具体 provider 补 `/v1`。
 */
export type EndpointKind = 'native' | 'gateway';

export function endpointKind(baseUrl: string): EndpointKind {
  const url = (baseUrl || '').trim().replace(/\/+$/, '');
  if (!url) return 'native';
  if (url.includes('compatible-mode')) return 'gateway';
  return /\/api\/v\d+$/i.test(url) ? 'native' : 'gateway';
}

/** 网关地址统一成以 `/v1` 结尾，允许用户只填域名 */
export function gatewayBase(baseUrl: string): string {
  const url = (baseUrl || '').trim().replace(/\/+$/, '');
  return /\/v\d+$/.test(url) ? url : `${url}/v1`;
}
