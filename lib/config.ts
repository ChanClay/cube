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

const bailianApiKey = trim(process.env.VIDEO_API_KEY);
const bailianBaseUrl = stripSlash(trim(process.env.VIDEO_BASE_URL));

/**
 * provider 未单独配置 baseurl 时的兜底地址（provider 实现与模型管理页共用）。
 * 百炼的两个模型共用 DashScope 原生异步地址；Seedance 走火山方舟。
 */
export const VIDEO_DEFAULT_BASE_URLS = {
  happyhorse: 'https://cn-beijing.maas.qianwenaiapi.com/api/v1',
  wan: 'https://cn-beijing.maas.qianwenaiapi.com/api/v1',
  seedance: 'https://ark.cn-beijing.volces.com/api/v3',
} as const;

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
    /**
     * 百炼共享兜底：happyhorse / wan 未单独配置 Key / 地址时回落到这里
     * （角色卡 / 场景卡的文生图也用它）。
     */
    apiKey: bailianApiKey,
    baseUrl: bailianBaseUrl,
    /**
     * 每个视频模型一套独立的连接配置（Key / baseurl / 模型 ID），
     * 未单独配置时回落到上面的百炼共享值。模型管理页按这套展示。
     */
    models: {
      /** HappyHorse 1.1：三种生成模式各自一个模型 ID */
      happyhorse: {
        apiKey: trim(process.env.VIDEO_HAPPYHORSE_API_KEY) || bailianApiKey,
        apiKeyEnv: trim(process.env.VIDEO_HAPPYHORSE_API_KEY)
          ? 'VIDEO_HAPPYHORSE_API_KEY'
          : 'VIDEO_API_KEY',
        baseUrl: stripSlash(trim(process.env.VIDEO_HAPPYHORSE_BASE_URL)) || bailianBaseUrl,
        /** 基础名（健康检查 / 日志展示用） */
        base: HAPPYHORSE_BASE,
        t2v: happyhorseModel('t2v', 'VIDEO_MODEL_T2V'),
        i2v: happyhorseModel('i2v', 'VIDEO_MODEL_I2V'),
        r2v: happyhorseModel('r2v', 'VIDEO_MODEL_R2V'),
      },
      /** 万相 wan3.0：单模型，文生 / 首尾帧 / 参考素材都走它 */
      wan: {
        apiKey: trim(process.env.VIDEO_WAN_API_KEY) || bailianApiKey,
        apiKeyEnv: trim(process.env.VIDEO_WAN_API_KEY) ? 'VIDEO_WAN_API_KEY' : 'VIDEO_API_KEY',
        baseUrl: stripSlash(trim(process.env.VIDEO_WAN_BASE_URL)) || bailianBaseUrl,
        model: trim(process.env.VIDEO_MODEL_WAN) || 'wan3.0-video',
      },
      /**
       * 火山方舟 Seedance：另一套平台，Key 与百炼不通用。
       * 时长区间 / 参考素材 / 音轨随版本不同，provider 按模型名自动判定
       * （1.0 pro 是 2~12 秒且没有 r2v，见 lib/providers/video/seedance.ts 的 profileFor）；
       * 剧本规划仍按 lib/video-models.ts 的 4~30 秒。
       */
      seedance: {
        apiKey: trim(process.env.VIDEO_SEEDANCE_API_KEY) || trim(process.env.ARK_API_KEY),
        apiKeyEnv: 'VIDEO_SEEDANCE_API_KEY',
        baseUrl:
          stripSlash(trim(process.env.VIDEO_SEEDANCE_BASE_URL)) || VIDEO_DEFAULT_BASE_URLS.seedance,
        model: trim(process.env.VIDEO_MODEL_SEEDANCE) || 'doubao-seedance-2-5-260628',
      },
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
  // 百炼（HappyHorse / wan3.0）与火山方舟（Seedance）各一套 Key，任一配好即可用
  return (
    config.video.models.happyhorse.apiKey.length > 0 ||
    config.video.models.wan.apiKey.length > 0 ||
    config.video.models.seedance.apiKey.length > 0
  );
}

/** 某个视频模型是否已在 env 配好 API Key（模型管理页只展示 true 的那些） */
export function videoModelConfigured(provider: keyof typeof config.video.models): boolean {
  return config.video.models[provider].apiKey.length > 0;
}

/**
 * 模型管理页展示的连接信息。只报配置来源与环境变量键名，不回传密钥。
 */
export interface VideoModelConnection {
  provider: 'happyhorse' | 'wan' | 'seedance';
  /** 是否已在 env 配好 API Key */
  configured: boolean;
  /** 实际生效的 baseurl（未配置时为 provider 的兜底地址） */
  baseUrl: string;
  /** 实际生效的 API Key 来自哪个环境变量 */
  apiKeyEnv: string;
  /** 实际调用的模型 ID（HappyHorse 为基础名） */
  model: string;
  /** HappyHorse 三种生成模式各自的模型 ID，其他模型为 null */
  modes: { mode: 't2v' | 'i2v' | 'r2v'; model: string }[] | null;
}

export function videoModelConnection(
  provider: 'happyhorse' | 'wan' | 'seedance',
): VideoModelConnection {
  if (provider === 'happyhorse') {
    const happyhorse = config.video.models.happyhorse;
    return {
      provider,
      configured: happyhorse.apiKey.length > 0,
      baseUrl: happyhorse.baseUrl || VIDEO_DEFAULT_BASE_URLS.happyhorse,
      apiKeyEnv: happyhorse.apiKeyEnv,
      model: happyhorse.base,
      modes: [
        { mode: 't2v', model: happyhorse.t2v },
        { mode: 'i2v', model: happyhorse.i2v },
        { mode: 'r2v', model: happyhorse.r2v },
      ],
    };
  }

  const model = config.video.models[provider];
  return {
    provider,
    configured: model.apiKey.length > 0,
    baseUrl: model.baseUrl || VIDEO_DEFAULT_BASE_URLS[provider],
    apiKeyEnv: model.apiKeyEnv,
    model: model.model,
    modes: null,
  };
}

export function imageConfigured(): boolean {
  return config.image.apiKey.length > 0;
}
