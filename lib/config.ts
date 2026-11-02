const trim = (v: string | undefined) => (v ?? '').trim();
const stripSlash = (v: string) => v.replace(/\/+$/, '');

const bool = (v: string | undefined, fallback: boolean) => {
  const value = trim(v).toLowerCase();
  if (!value) return fallback;
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
};

export const config = {
  port: Number(trim(process.env.PORT) || 4500),
  llm: {
    baseUrl: stripSlash(trim(process.env.LLM_BASE_URL) || 'https://api.deepseek.com/v1'),
    apiKey: trim(process.env.LLM_API_KEY),
    model: trim(process.env.LLM_MODEL) || 'deepseek-chat',
    timeoutMs: Number(trim(process.env.LLM_TIMEOUT_MS) || 180000),
    /** 单次调用的输出预算；思考型模型的 reasoning tokens 也算在里面 */
    maxTokens: Number(trim(process.env.LLM_MAX_TOKENS) || 6000),
    /**
     * 是否开启思考模式。默认关：本项目的调用都是「只输出 JSON」的结构化任务，
     * 思考过程会把 max_tokens 吃光，导致正文为空（finish_reason=length）。
     */
    thinking: bool(process.env.LLM_THINKING, false),
  },
  video: {
    /** 通义万相 wan3.0（唯一支持的视频模型） */
    apiKey: trim(process.env.VIDEO_API_KEY),
    baseUrl: stripSlash(trim(process.env.VIDEO_BASE_URL)),
    model: trim(process.env.VIDEO_MODEL),
    resolution: trim(process.env.VIDEO_RESOLUTION) || '720p',
    ratio: trim(process.env.VIDEO_RATIO) || 'adaptive',
    defaultDuration: Number(trim(process.env.VIDEO_DURATION) || 5),
    /** 是否输出有声视频（wan3.0 原生支持台词 / BGM / 音效） */
    audio: bool(process.env.VIDEO_AUDIO, true),
    /**
     * 承接上一镜末帧（首帧来自 /api/frames/）的镜头是否也生成音频。
     * 画面接着上一镜，音频却由这一镜独立生成，音色 / 语气 / 环境声都会突然断档，
     * 合成后听起来「音频衔接不上」，所以默认关掉这类镜头的音频。
     */
    audioOnCarry: bool(process.env.VIDEO_AUDIO_ON_CARRY, false),
    /** 提示词智能扩写 */
    promptExtend: bool(process.env.VIDEO_PROMPT_EXTEND, true),
  },
  image: {
    /** 角色卡 / 场景卡配图用的文生图模型；默认复用视频的百炼 Key 与地址 */
    apiKey: trim(process.env.IMAGE_API_KEY) || trim(process.env.VIDEO_API_KEY),
    baseUrl:
      stripSlash(trim(process.env.IMAGE_BASE_URL)) || stripSlash(trim(process.env.VIDEO_BASE_URL)),
    model: trim(process.env.IMAGE_MODEL) || 'wan2.6-t2i',
  },
  /** 站点对外地址；配置后本地素材会被拼成绝对地址交给视频模型 */
  publicBaseUrl: stripSlash(trim(process.env.PUBLIC_BASE_URL)),
  pollIntervalMs: Number(trim(process.env.NEXT_PUBLIC_POLL_INTERVAL_MS) || 5000),
} as const;

export function llmConfigured(): boolean {
  return config.llm.apiKey.length > 0;
}

export function videoConfigured(): boolean {
  return config.video.apiKey.length > 0;
}

export function imageConfigured(): boolean {
  return config.image.apiKey.length > 0;
}
