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
    /** 通义万相 wan3.0（唯一支持的视频模型） */
    apiKey: trim(process.env.VIDEO_API_KEY),
    baseUrl: stripSlash(trim(process.env.VIDEO_BASE_URL)),
    model: trim(process.env.VIDEO_MODEL),
    /** 兜底画质：实际按项目设置（创建项目时选择，默认 480p） */
    resolution: trim(process.env.VIDEO_RESOLUTION) || '480p',
    /** 兜底画幅：实际按项目设置（默认 16:9），带首帧 / 尾帧的镜头自动用 adaptive */
    ratio: trim(process.env.VIDEO_RATIO) || '16:9',
    defaultDuration: Number(trim(process.env.VIDEO_DURATION) || 5),
    /** 是否输出有声视频（wan3.0 原生支持台词 / BGM / 音效） */
    audio: bool(process.env.VIDEO_AUDIO, true),
    /**
     * 硬切镜头是否用上一镜末帧（默认开）。
     *
     * 同景别时当首帧接住（接缝完全连续，但这一镜就传不了卡片）；景别变了则降级成
     * reference_image，只借光线 / 色调 / 场景材质，构图按本镜重新来。判定见
     * lib/skills/shot-media.ts 的 prevFrameUsage。
     * 拿去 A/B 的那次关掉即可（改 .env.local 后重启）。
     */
    referencePrevFrame: bool(process.env.VIDEO_REFERENCE_PREV_FRAME, true),
    /**
     * 提示词智能扩写。默认关：本项目的提示词是逐镜对齐过的（固定英文外貌 / 空间短语 +
     * 标准景别运镜），交给服务端二次改写会被换成另一套景别与运镜，
     * 人物长相和镜头语言都会漂移，运动也更难控。提示词很短时再打开它。
     */
    promptExtend: bool(process.env.VIDEO_PROMPT_EXTEND, false),
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
