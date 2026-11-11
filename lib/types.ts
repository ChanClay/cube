import type { VideoRatio, VideoResolution } from './video-options';

/**
 * canceled：用户主动「放弃本镜」。只停本地跟踪，provider 上的任务仍会跑完，
 * 结果不再回收（接口没有取消能力）。
 */
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';

/**
 * 万相 wan3.0 支持的多模态素材类型
 * - first_frame / last_frame：首帧、尾帧（与 reference_* 互斥）
 * - reference_image / reference_video / reference_audio：参考素材
 * - file / link：文档与网页链接（二者互斥）
 */
export type MediaType =
  | 'first_frame'
  | 'last_frame'
  | 'reference_image'
  | 'reference_video'
  | 'reference_audio'
  | 'file'
  | 'link';

export interface MediaInput {
  type: MediaType;
  url: string;
  /**
   * 由镜头素材关联自动挂上的素材（抽帧承接、角色卡 / 场景卡参考图）。
   * 每次生成前会先摘掉重算，用户手选的素材不会有这个标记。
   */
  auto?: boolean;
  /**
   * 素材归属的对象名（角色 / 场景）。只用于本地识别「这张卡是谁的」，
   * 提交给 provider 前会被剥掉。
   *
   * 注意：不要用它做「末帧里有的人就删掉他的卡」这类身份去重——
   * 整帧末帧在 wan3.0 眼里是环境 / 光线参考，不是某个具体人物，
   * 删卡会让这一镜彻底失去身份参考。
   */
  name?: string;
}

export interface Character {
  /** 列表渲染用的稳定 id（旧剧本可能没有） */
  id?: string;
  name: string;
  desc: string;
  /** 全片固定的英文外貌短语（来自蓝图，逐镜提示词逐字复用） */
  promptEn?: string;
  /** 形象参考图（/api/uploads/xxx 或公网 URL）；上一镜末帧不可用时作为 reference_image 提交 */
  imageUrl?: string;
}

/** 场景卡：全片复用的空间设定，与角色卡同级 */
export interface Scene {
  /** 列表渲染用的稳定 id（旧剧本可能没有） */
  id?: string;
  name: string;
  desc: string;
  /** 全片固定的英文空间短语（来自蓝图） */
  promptEn?: string;
  /** 场景参考图；上一镜末帧不可用时作为首帧兜底（场景空镜更接近真实构图） */
  imageUrl?: string;
}

/**
 * 镜头台词的处理方式：
 * - `dialogue`：角色开口说这句，会驱动口型
 * - `voiceover`：画外旁白，人物不开口（缺省值，兼容旧剧本）
 * - `none`：这一镜不要任何口播，narration 保留但不提交
 */
export type NarrationType = 'dialogue' | 'voiceover' | 'none';

/**
 * 镜头内部的秒级节拍：这一段秒数里画面发生了什么变化。
 * 秒数是相对本镜起点的偏移，第一段从 0 开始，最后一段到 duration 结束。
 */
export interface ShotBeat {
  /** 起始秒（含） */
  from: number;
  /** 结束秒（不含） */
  to: number;
  /** 这一段里唯一一个可见动作，如「抬眼看向塔顶」 */
  action: string;
}

/**
 * 这一镜与上一镜的衔接方式。由分镜阶段产出，素材决策据此分流。
 *
 * wan3.0 的首帧 / 尾帧与 reference_* 互斥，所以「要不要接帧」必须是一个
 * 明确的叙事判断，不能靠「上一镜恰好有成品」临时决定：
 * - same-take：同一个动作被切成两镜（景别 / 机位连续）→ 抽上一镜末帧当首帧，本镜不能再传参考图
 * - hard-cut：换景别 / 换角度 / 正反打 → 用角色卡 / 场景卡当参考图，画面不接帧
 * - time-jump：时间或地点跳转，处理方式同 hard-cut
 */
export type ShotTransition = 'same-take' | 'hard-cut' | 'time-jump';

export interface Shot {
  /** 本地唯一 id */
  id: string;
  /** 从 1 开始 */
  index: number;
  /** 镜头小标题 */
  title: string;
  /** 时长（秒） */
  duration: number;
  /** 景别：特写 / 近景 / 中景 / 全景 / 远景 ... */
  shotSize: string;
  /** 运镜：固定 / 缓慢推近 / 横移 / 环绕 ... */
  cameraMove: string;
  /** 中文画面描述（给人看） */
  description: string;
  /**
   * 本镜第一帧的画面事实（谁 / 在哪 / 姿势 / 手持物），必须与上一镜 exitState 一致。
   * 无蓝图、模型也没写时为空。
   */
  entryState?: string;
  /** 本镜最后一帧的画面事实，下一镜的 entryState 要接住它 */
  exitState?: string;
  /** 这一镜内部的秒级节奏：几秒到几秒在发生什么（旧剧本没有这个字段） */
  beatSheet?: ShotBeat[];
  /** 英文文生视频提示词（给模型看），是 description 的忠实英译 */
  videoPrompt: string;
  /** 旁白 / 台词 */
  narration: string;
  /** 这一镜台词的处理方式，见 NarrationType */
  narrationType?: NarrationType;
  /**
   * 说这句台词的角色名（仅 narrationType=dialogue 时有效）。
   * 对应 Script.characters，必须同时出现在本镜的 characterNames 里，
   * 否则视频模型不知道画面里该由谁开口。
   */
  speaker?: string;
  /** 这一镜出场的角色名（对应 Script.characters） */
  characterNames?: string[];
  /**
   * 与上一镜的衔接方式；第一镜恒为 undefined。
   * 旧剧本没有这个字段时回落到 continueFromPrev（见 lib/shot-media 的 isSameTakeShot）。
   */
  transition?: ShotTransition;
  /** 衔接方式的判断依据 / 否决原因，UI 上展示，便于人工复核 */
  transitionReason?: string;
  /**
   * 是否把上一镜末帧作为 reference_image 一起传（只对「同一场戏、硬切换机位」有意义）。
   * 由分镜阶段给出默认值：同场硬切为 true，承接动作 / 时间跳转 / 换场景为 false。
   * 打开后只借上一镜的光线与场景材质，构图仍按本镜描述走。
   */
  referencePrevFrame?: boolean;
  /**
   * 这一镜最后一帧里**实际**在场的人物名。
   *
   * 只有「视觉识别」或「人工确认」才写入；为空时调用方回落到 characterNames。
   * 和 characterNames 的区别是「事实」与「意图」：分镜写的是这一镜该有谁，
   * 视频模型自己加的人、中途入场的人都会让两者不一致，而写下一镜提示词时
   * 必须以画面事实为准，否则会凭空多出末帧里没有的人。
   */
  lastFrameCast?: string[];
  /**
   * @deprecated 旧字段，等价于 transition='same-take'。
   * 新剧本由 transition 决定，这里只用于读取历史数据。
   */
  continueFromPrev?: boolean;
  /** 这一镜所在的场景名（对应 Script.scenes），用于取场景卡配图当首帧 */
  sceneNames?: string[];
  /** 多模态参考素材（首帧/尾帧/参考图/参考视频/参考音频/文档/网页） */
  media?: MediaInput[];
}

export interface Script {
  title: string;
  logline: string;
  style: string;
  characters: Character[];
  /** 场景卡（旧剧本没有这个字段） */
  scenes?: Scene[];
  shots: Shot[];
}

export interface VideoJob {
  id: string;
  shotId: string;
  provider: string;
  providerJobId: string | null;
  status: JobStatus;
  progress: number | null;
  videoUrl: string | null;
  error: string | null;
  prompt: string;
  duration: number;
  resolution: string;
  /** 本次任务使用的多模态素材 */
  media: MediaInput[];
  createdAt: number;
  updatedAt: number;
}

export interface ProviderHealth {
  name: string;
  ready: boolean;
  hint: string;
}

/** 素材文件夹的类型 */
export type MediaKind = 'character' | 'scene' | 'prop' | 'style' | 'audio' | 'other';

/** 项目素材库中的一项：本地上传的文件或公网 URL */
export interface ProjectMedia {
  id: string;
  /** 素材语义类型，挂到镜头时直接复用 */
  type: MediaType;
  /** 相对路径（/api/uploads/xxx）或公网 URL */
  url: string;
  /** 文件名或备注 */
  name: string;
  mime?: string;
  size?: number;
  /** true 表示存在本机 .data/uploads，视频模型需要公网地址才能读取 */
  local?: boolean;
  createdAt: number;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  /** 画幅比例：创建项目时选定，生成视频时按它提交 */
  ratio: VideoRatio;
  /** 画质档位：创建项目时选定，默认 480p */
  resolution: VideoResolution;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectSummary {
  id: string;
  name: string;
  description: string;
  scriptCount: number;
  ratio: VideoRatio;
  resolution: VideoResolution;
  createdAt: number;
  updatedAt: number;
}

/** 存进 MySQL 的剧本记录 */
export interface StoredScript {
  id: string;
  /** 所属项目 */
  projectId: string;
  /** 用户输入的原始创意 */
  idea: string;
  title: string;
  style: string;
  script: Script;
  createdAt: number;
  updatedAt: number;
}

export interface ComposeResult {
  fileName: string;
  url: string;
  bytes: number;
  clips: number;
  size: string;
}

export interface StoredScriptSummary {
  id: string;
  idea: string;
  title: string;
  style: string;
  shotCount: number;
  createdAt: number;
  updatedAt: number;
}
