/**
 * Agent 层：所有「让模型做判断」的逻辑集中在这里，和存储 / 路由 / 视频 provider 分开。
 *
 * - `./llm`        LLM 调用与 JSON 提取（最底层，其余 agent 共用）
 * - `./continuity` 串联导演 agent：只规划 entry / exit 状态链，不写分镜文案
 * - `./storyboard` 分镜 agent：照着状态链写每一镜的画面与英文提示词
 */

export { callChatJson, extractJson } from './llm';
export { planStory, type Beat, type PlanRequest, type StoryPlan } from './continuity';
export { generateScript, type ScriptRequest } from './storyboard';
