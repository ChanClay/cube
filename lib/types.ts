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
}

export interface Character {
  /** 列表渲染用的稳定 id（旧剧本可能没有） */
  id?: string;
  name: string;
  desc: string;
  /** 形象参考图（/api/uploads/xxx 或公网 URL）；上一镜末帧不可用时作为 reference_image 提交 */
  imageUrl?: string;
}

/** 场景卡：全片复用的空间设定，与角色卡同级 */
export interface Scene {
  /** 列表渲染用的稳定 id（旧剧本可能没有） */
  id?: string;
  name: string;
  desc: string;
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
  /** 英文文生视频提示词（给模型看） */
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
   * 是否承接上一镜：打开后用上一镜视频的末帧当本镜首帧。
   * 缺省（undefined）即关闭；第一镜没有上一镜，始终视为关闭。
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
