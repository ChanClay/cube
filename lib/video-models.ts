/**
 * 视频模型的唯一事实来源（前后端共用）。
 *
 * - 前端：创建剧本时的模型下拉、单镜时长滑块 / 输入框、剧本头部的模型标签
 * - 服务端：创建剧本时的时长规划区间、生成视频时路由到哪个 provider
 *
 * 这里只放纯数据，不读环境变量，客户端可以安全 import。
 * 模型 ID 与密钥等运行期配置在 lib/config.ts。
 */

export type VideoModelId = 'happyhorse-1.1' | 'wan3.0-video' | 'seedance-2.5';

/** 实现该模型的 provider 名（对应 lib/providers/video 下的实现） */
export type VideoProviderName = 'happyhorse' | 'wan' | 'seedance';

export interface VideoModelSpec {
  /** 剧本上记录的模型标识 */
  id: VideoModelId;
  provider: VideoProviderName;
  /** 展示名 */
  label: string;
  /** 单镜时长下限（秒） */
  minShotSeconds: number;
  /** 单镜时长上限（秒） */
  maxShotSeconds: number;
  /**
   * 单镜「一次生成」的质量线（秒），只写进提示词供 AI 权衡。
   * 超过这条线不是不能用，只是后半段动作更容易变慢、肢体更容易糊。
   */
  preferredShotSeconds: number;
  /** 一份剧本最多几镜 */
  maxShotCount: number;
  /**
   * 音轨能力：
   * - `always`：原生音视频联合生成，始终带音轨，接口没有开关（HappyHorse 1.1）
   * - `toggle`：可用 audio 参数开关（wan3.0 的 `audio` / Seedance 的 `generate_audio`，
   *   受 VIDEO_AUDIO 控制）
   */
  audio: 'always' | 'toggle';
  /** 该模型支持的输入格式（模型管理页展示用，与 provider 实际分流一致） */
  inputs: VideoModelInput[];
  /** 下拉里的一行说明 */
  summary: string;
}

/** 单种输入格式 */
export interface VideoModelInput {
  kind: 'text' | 'image' | 'reference';
  /** 展示名，如「文本提示词」「首帧图片」 */
  label: string;
  /** 一行说明 */
  detail: string;
}

/** 顺序即创建剧本页下拉框里的顺序：wan3.0 → Seedance → HappyHorse */
export const VIDEO_MODELS: VideoModelSpec[] = [
  {
    id: 'wan3.0-video',
    provider: 'wan',
    label: '万相 Wan 3.0',
    minShotSeconds: 2,
    maxShotSeconds: 30,
    preferredShotSeconds: 10,
    maxShotCount: 12,
    audio: 'toggle',
    inputs: [
      { kind: 'text', label: '文本提示词', detail: '纯文字描述生视频' },
      {
        kind: 'image',
        label: '首帧 / 尾帧图片',
        detail: '首帧起画，配尾帧做首尾过渡；带首尾帧时画幅固定 adaptive',
      },
      { kind: 'reference', label: '参考视频 / 音频', detail: '参考素材延续风格，可带音频' },
    ],
    summary: '首尾帧 / 参考视频音频，2~30 秒，音轨可开关',
  },
  {
    id: 'seedance-2.5',
    provider: 'seedance',
    label: 'Seedance 2.5',
    minShotSeconds: 4,
    maxShotSeconds: 30,
    preferredShotSeconds: 10,
    maxShotCount: 12,
    // 2.5 / 2.0 系列有 generate_audio，受 VIDEO_AUDIO 控制（1.0 pro 无声，没有这个参数）
    audio: 'toggle',
    inputs: [
      { kind: 'text', label: '文本提示词', detail: '纯文字描述生视频' },
      { kind: 'image', label: '首帧 / 尾帧图片', detail: '首帧起画，配尾帧做首尾过渡' },
      { kind: 'reference', label: '参考图 / 视频 / 音频', detail: '多模态参考素材定主体与风格' },
    ],
    summary: '首尾帧 / 参考图·视频·音频，4~30 秒，音轨可开关（火山方舟）',
  },
  {
    id: 'happyhorse-1.1',
    provider: 'happyhorse',
    label: 'HappyHorse 1.1',
    minShotSeconds: 3,
    maxShotSeconds: 15,
    preferredShotSeconds: 10,
    maxShotCount: 12,
    // 原生联合生成音轨（对白 / 环境音 / 拟音），接口没有 audio 开关，不能关
    audio: 'always',
    inputs: [
      { kind: 'text', label: '文本提示词', detail: '纯文字描述生视频' },
      {
        kind: 'image',
        label: '首帧图片',
        detail: '首帧起画（i2v），画幅跟随首帧；同时给尾帧时尾帧会被丢弃',
      },
      { kind: 'reference', label: '参考图（≤9 张）', detail: '多图参考定主体与风格，支持 ratio' },
    ],
    summary: '首帧 / 参考图（≤9 张）生视频，3~15 秒，原生音轨（不可关）',
  },
];

/** 新建剧本时默认选中的模型（下拉第一项） */
export const DEFAULT_VIDEO_MODEL_ID: VideoModelId = 'wan3.0-video';

/**
 * 旧剧本没有 `videoModel` 字段时的归属。
 * 历史上只有 wan3.0 一个模型，按它处理才不会把老剧本的 30 秒镜头夹成 15 秒。
 */
export const LEGACY_VIDEO_MODEL_ID: VideoModelId = 'wan3.0-video';

export function isVideoModelId(value: unknown): value is VideoModelId {
  return typeof value === 'string' && VIDEO_MODELS.some((model) => model.id === value);
}

/** 外部输入（表单 / 接口 / 旧数据）落库前统一校验 */
export function normalizeVideoModel(
  value: unknown,
  fallback: VideoModelId = LEGACY_VIDEO_MODEL_ID,
): VideoModelId {
  return isVideoModelId(value) ? value : fallback;
}

/** 取模型能力；未知值按旧剧本处理（wan3.0） */
export function videoModelSpec(value?: string | null): VideoModelSpec {
  const id = normalizeVideoModel(value);
  return (
    VIDEO_MODELS.find((model) => model.id === id) ??
    VIDEO_MODELS.find((model) => model.id === LEGACY_VIDEO_MODEL_ID) ??
    VIDEO_MODELS[0]
  );
}

export function videoModelLabel(value?: string | null): string {
  return videoModelSpec(value).label;
}

/** 这个模型由哪个 provider 实现 */
export function providerForVideoModel(value?: string | null): VideoProviderName {
  return videoModelSpec(value).provider;
}
