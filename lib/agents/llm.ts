import { config } from '@/lib/config';

/** 去掉模型附带的 ``` 包裹，取出第一个完整 JSON 对象 */
export function extractJson(content: string): unknown {
  const cleaned = content
    .replace(/^\s*```(?:json)?/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end <= start) throw new Error('模型没有返回合法 JSON');
    return JSON.parse(cleaned.slice(start, end + 1));
  }
}

export interface ChatJsonOptions {
  system: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

/** 重试时的预算上限，避免配置异常把 max_tokens 放大到离谱 */
const MAX_TOKEN_CEILING = 32000;

/**
 * 有的 OpenAI 兼容网关不认 `thinking` / `response_format` 参数（整包 400），
 * 一旦确认不支持就在本进程内不再带它，JSON 改为从正文里提取。
 */
let thinkingParamRejected = false;
let jsonFormatRejected = false;

interface ChatAttempt {
  content: string;
  finishReason: string | null;
  reasoningTokens: number;
  /** 本次实际使用的输出预算 */
  budget: number;
}

/** 少数网关把 content 拆成 parts 数组，统一拼成字符串 */
function normalizeContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      const text = (part as { text?: unknown } | null)?.text;
      return typeof text === 'string' ? text : '';
    })
    .join('');
}

async function requestAttempt(
  options: ChatJsonOptions,
  budget: number,
): Promise<ChatAttempt> {
  const messages = [
    { role: 'system', content: options.system },
    { role: 'user', content: options.user },
  ];
  /**
   * 思考型模型（deepseek-flash / v3.2 等）默认会先输出 reasoning_content，
   * 而 reasoning tokens 也算在 max_tokens 里：长一点的任务整份额度被思考吃光，
   * 正文就是空字符串（finish_reason=length）。结构化 JSON 任务不需要思考，
   * 除非显式设了 LLM_THINKING=true。
   */
  let disableThinking = !config.llm.thinking && !thinkingParamRejected;
  let useJsonFormat = !jsonFormatRejected;

  const send = () => {
    const body: Record<string, unknown> = {
      model: config.llm.model,
      temperature: options.temperature ?? 0.8,
      max_tokens: budget,
      messages,
      ...(useJsonFormat ? { response_format: { type: 'json_object' } } : {}),
      ...(disableThinking ? { thinking: { type: 'disabled' } } : {}),
    };
    return fetch(`${config.llm.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.llm.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? config.llm.timeoutMs),
    });
  };

  let res = await send();
  let raw = await res.text().catch(() => '');

  // 服务端不认某个可选参数时整包 400：摘掉它重发，并记住别再带
  while (res.status === 400) {
    if (disableThinking && /thinking/i.test(raw)) {
      thinkingParamRejected = true;
      disableThinking = false;
    } else if (useJsonFormat && /response_format|json_object/i.test(raw)) {
      jsonFormatRejected = true;
      useJsonFormat = false;
    } else {
      break;
    }
    res = await send();
    raw = await res.text().catch(() => '');
  }

  if (!res.ok) {
    throw new Error(`LLM 接口 ${res.status}：${raw.slice(0, 400) || res.statusText}`);
  }

  let data: {
    choices?: { message?: { content?: unknown }; finish_reason?: string }[];
    usage?: { completion_tokens_details?: { reasoning_tokens?: number } };
    error?: { message?: string };
  };
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`LLM 返回内容无法解析：${raw.slice(0, 200)}`);
  }

  const choice = data.choices?.[0];
  return {
    content: normalizeContent(choice?.message?.content),
    finishReason: choice?.finish_reason ?? null,
    reasoningTokens: Number(data.usage?.completion_tokens_details?.reasoning_tokens ?? 0) || 0,
    budget,
  };
}

/** 空内容时给出能直接动手的原因，而不是一句「返回内容为空」 */
function describeEmptyContent(attempt: ChatAttempt): string {
  if (attempt.reasoningTokens > 0) {
    return (
      `模型把 ${attempt.budget} tokens 全用在思考上了，没有产出正文` +
      `（finish_reason=${attempt.finishReason ?? '未知'}，reasoning_tokens=${attempt.reasoningTokens}）。` +
      '请调大 LLM_MAX_TOKENS，或设 LLM_THINKING=false 关掉思考模式'
    );
  }
  return `LLM 返回内容为空（finish_reason=${attempt.finishReason ?? '未知'}）`;
}

/** 调用 OpenAI 兼容接口，返回解析后的 JSON */
export async function callChatJson(options: ChatJsonOptions): Promise<unknown> {
  if (!config.llm.apiKey) {
    throw new Error('未配置 LLM_API_KEY，请在 .env.local 中填写剧本生成模型的 Key');
  }

  let budget = Math.max(Math.trunc(options.maxTokens ?? config.llm.maxTokens), 512);
  /** 被截断 / 空正文时放大预算重试一次，思考型模型的输出长度不可控 */
  let last: ChatAttempt | null = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await requestAttempt(options, budget);
    last = result;

    const truncated = result.finishReason === 'length';
    if (!truncated && result.content.trim()) return extractJson(result.content);

    // 还有额度空间就加倍再试一次；预算已经到顶就直接报原因
    if (attempt === 0 && budget < MAX_TOKEN_CEILING) {
      budget = Math.min(MAX_TOKEN_CEILING, budget * 3);
      continue;
    }

    if (truncated) {
      throw new Error(
        `模型输出被 max_tokens（${budget}）截断，分镜信息不完整。请调大 LLM_MAX_TOKENS 后重试`,
      );
    }
    throw new Error(describeEmptyContent(result));
  }

  throw new Error(last ? describeEmptyContent(last) : 'LLM 返回内容为空');
}
