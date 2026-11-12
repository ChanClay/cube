const trim = (v: string | undefined) => (v ?? '').trim();
const stripSlash = (v: string) => v.replace(/\/+$/, '');

const bool = (v: string | undefined, fallback: boolean) => {
  const value = trim(v).toLowerCase();
  if (!value) return fallback;
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
};

/**
 * HappyHorse 1.1 把生成模式拆成了三个模型 ID：`…-t2v` / `…-i2v` / `…-r2v`。
 * 这里用基础名派生，想换版本（比如 1.0）只改 VIDEO_MODEL_HAPPYHORSE 即可
 * （旧的 VIDEO_MODEL 仍兼容，只作为 HappyHorse 的基础名）。
 */
const HAPPYHORSE_BASE =
  trim(process.env.VIDEO_MODEL_HAPPYHORSE) || trim(process.env.VIDEO_MODEL) || 'happyhorse-1.1';

const happyhorseModel = (mode: 't2v' | 'i2v' | 'r2v', envKey: string) =>
  trim(process.env[envKey]) || `${HAPPYHORSE_BASE}-${mode}`;

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
    /**
     * 成稿后是否允许审片 agent 修一次。
     * 只在检测到硬伤时才会额外发请求，正常输出不会变慢。
     */
    review: bool(process.env.SCRIPT_REVIEW, true),
    /**
     * 中文定稿后是否再调一次模型，把每镜的中文描述单独翻成英文提示词。
     * 关掉后退回「分镜阶段顺手写英文」，中英容易对不上；正常只在生成剧本时多一次调用。
     */
    localize: bool(process.env.SCRIPT_LOCALIZE, true),
  },
  video: {
    /** 阿里云百炼（两个模型共用同一套 Key 与异步接口地址） */
    apiKey: trim(process.env.VIDEO_API_KEY),
    baseUrl: stripSlash(trim(process.env.VIDEO_BASE_URL)),
    /** HappyHorse 1.1：三种生成模式各自一个模型 ID */
    happyhorse: {
      /** 基础名（健康检查 / 日志展示用） */
      base: HAPPYHORSE_BASE,
      t2v: happyhorseModel('t2v', 'VIDEO_MODEL_T2V'),
      i2v: happyhorseModel('i2v', 'VIDEO_MODEL_I2V'),
      r2v: happyhorseModel('r2v', 'VIDEO_MODEL_R2V'),
    },
    /** 万相 wan3.0：单模型，文生 / 首尾帧 / 参考素材都走它 */
    wan: {
      model: trim(process.env.VIDEO_MODEL_WAN) || 'wan3.0-video',
    },
    /** 兜底画质：实际按项目设置（创建项目时选择，默认 480p） */
    resolution: trim(process.env.VIDEO_RESOLUTION) || '480p',
    /** 兜底画幅：实际按项目设置（默认 16:9）；HappyHorse 首帧模式的画幅跟随首帧 */
    ratio: trim(process.env.VIDEO_RATIO) || '16:9',
    defaultDuration: Number(trim(process.env.VIDEO_DURATION) || 5),
    /** 是否给成片打「Happy Horse」右下角水印，默认关（wan3.0 没有这个开关） */
    watermark: bool(process.env.VIDEO_WATERMARK, false),
    /**
     * 是否让 wan3.0 生成音轨（对应它的 audio 参数）。
     * HappyHorse 1.1 是原生音视频联合生成，始终带音轨且没有开关，这里对它是无效的。
     */
    audio: bool(process.env.VIDEO_AUDIO, true),
    /** wan3.0 提示词智能扩写；HappyHorse 没有这个参数 */
    promptExtend: bool(process.env.VIDEO_PROMPT_EXTEND, false),
    /**
     * 硬切镜头是否用上一镜末帧（默认开）。
     *
     * 同景别时当首帧接住（接缝完全连续，但这一镜就传不了卡片）；景别变了则降级成
     * reference_image，只借光线 / 色调 / 场景材质，构图按本镜重新来。判定见
     * lib/skills/shot-media.ts 的 prevFrameUsage。
     * 拿去 A/B 的那次关掉即可（改 .env.local 后重启）。
     */
    referencePrevFrame: bool(process.env.VIDEO_REFERENCE_PREV_FRAME, true),
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
