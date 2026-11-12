/**
 * Agent 层：所有「让模型做判断」的逻辑集中在这里，和存储 / 路由 / 视频 provider 分开。
 *
 * - `./spec`       影视语言规范（景别 / 运镜 / 提示词 / 台词的约束与清洗）
 * - `./llm`        LLM 调用与 JSON 提取（最底层，其余 agent 共用）
 * - `./adaptation` 小说 / 章节改编：把长文压缩成可拍蓝图
 * - `./continuity` 故事架构师：主题 / 人物 / 场景 + entry-exit 状态链
 * - `./storyboard` 分镜 agent：照着蓝图写画面与英文提示词，并做时长 / 引用收口
 * - `./localize`   提示词译者：把定稿的中文描述逐镜翻成英文（保证中英一致）
 * - `./review`     审片 agent：确定性体检 + 只修复有硬伤的镜头
 */

export { callChatJson, extractJson } from './llm';
export {
  localizePrompts,
  type LocalizeCharacter,
  type LocalizeInput,
  type LocalizeScene,
  type LocalizeShot,
} from './localize';
export { adaptStory, type AdaptRequest, type AdaptedStory } from './adaptation';
export {
  planStory,
  type Beat,
  type PlanCharacter,
  type PlanRequest,
  type PlanScene,
  type StoryPlan,
} from './continuity';
export { generateScript, type ScriptRequest, type ScriptResult } from './storyboard';
export { auditScript, type AuditOptions, type ScriptIssue } from './review';
export {
  CAMERA_MOVES,
  DEFAULT_CAMERA_MOVE,
  DEFAULT_SHOT_SIZE,
  SHOT_LANGUAGE_RULES,
  SHOT_SIZES,
  VIDEO_PROMPT_RULES,
  narrationLimit,
  trimNarration,
} from '@/lib/skills/spec';
