import {
  MAX_NOVEL_CHARS,
  MAX_SHOT_COUNT,
  MIN_SHOT_COUNT,
  MAX_SHOT_SECONDS,
  MIN_SHOT_SECONDS,
} from '@/lib/shot-plan';
import { logAgentWarn, logEvent } from '@/lib/logger';
import {
  buildBlueprintSystemPrompt,
  normalizeStoryPlan,
  type PlanProblem,
  type PlanRequest,
  type StoryPlan,
} from './continuity';
import { callChatJson } from './llm';
import { clamp, str } from './spec';

/**
 * 小说 / 章节改编 agent
 *
 * 现有链路假设输入是「一段创意」。直接把整章原文丢进规划 agent，
 * 模型会试图把整章塞进 12 镜，结果主线模糊、人物过多、场景跳跃。
 *
 * 这一层先做压缩：保留一条主线、2~4 个人物、1~4 个场景、关键转折与结局，
 * 输出与「故事蓝图」完全同构的 StoryPlan，后续分镜写作无需改动。
 *
 * 长文分两步处理：
 *   原文 ──▶ 分段摘要（map，每段一次调用）──▶ 改编蓝图（reduce，一次调用）
 * 单章（≤ 8000 字）直接一次调用，不额外消耗。
 */

/** 原文超过这个长度就先分段摘要 */
const DIRECT_LIMIT = 8000;
const CHUNK_SIZE = 7000;
/** 最多摘要几段；配合 MAX_NOVEL_CHARS 保证调用次数可控 */
const MAX_CHUNKS = 5;
/** 每段摘要塞回最终提示词时的长度上限，避免 reduce 阶段又变成一部长篇 */
const SUMMARY_CLIP = 900;

const ADAPT_RULES = `【小说改编要求】
A. 只保留一条主线：一个主角、一个核心欲望、一个关键阻碍、一次转折、一个结局。删掉副线、次要人物、过场戏与重复场景。
B. 必须保留原作的主角落点、核心冲突、关键道具与结局方向；可以合并场景、压缩时间、删减对白，不得新增原作没有的重大事件。
C. 原文信息不足以撑满目标镜数时，用氛围、反应、细节、空镜补足，不要编造新剧情。
D. 人物 2~4 个、场景 1~4 个，只保留最终成片里真正出镜的角色与空间。
E. 额外输出 treatment：300~500 字的连贯中文梗概，按成片顺序写，供下一步分镜写作直接使用；不要写成分析、要点或列表。`;

export interface AdaptRequest extends PlanRequest {
  /** 小说 / 章节原文 */
  text: string;
}

export interface AdaptedStory {
  plan: StoryPlan;
  /** 压缩后的梗概，之后作为「故事创意」传给分镜 agent，也用于回填表单 */
  treatment: string;
}

function buildAdaptUserPrompt(
  req: AdaptRequest,
  sourceBlock: string,
  correction?: string,
): string {
  const countLine = req.shotRange
    ? `镜头数量：由你根据故事节奏自行决定，${req.shotRange.min}~${req.shotRange.max} 个之间`
    : req.shotCount
      ? `镜头数量：${req.shotCount} 个`
      : `镜头数量：由你根据剧情节奏决定，${MIN_SHOT_COUNT}~${MAX_SHOT_COUNT} 个之间`;

  const totalLine = req.totalDuration
    ? `总时长：${req.totalDuration} 秒`
    : '总时长：由你根据剧情节奏决定（30~360 秒），不要套用固定时长';

  const durationRule = req.totalDuration
    ? `每一镜给出 ${MIN_SHOT_SECONDS}~${MAX_SHOT_SECONDS} 秒的 duration，总和必须等于 ${req.totalDuration} 秒；镜头数量按上面的要求执行。`
    : `每一镜给出 ${MIN_SHOT_SECONDS}~${MAX_SHOT_SECONDS} 秒的 duration；镜头数量、每镜时长与总时长都由你按剧情决定（${MIN_SHOT_COUNT}~${MAX_SHOT_COUNT} 镜，总时长 30~360 秒）。`;

  const correctionBlock = correction
    ? `

上一次输出存在以下问题，请逐条修正后重新输出完整 JSON（不要只给改动部分）：
${correction}`
    : '';

  return `小说原文 / 素材摘要：
${sourceBlock}

整体视觉风格：${req.style || '电影感写实'}
${countLine}
${totalLine}

请把它改编成一部短片蓝图：先定主线与人物，再排出首尾相接的镜头状态链。
${durationRule}${correctionBlock}`;
}

/**
 * 在段落 / 句末处切分，尽量不把一句话劈成两半。
 * 最后一块允许略长，但总长度由 MAX_NOVEL_CHARS 限制。
 */
function splitIntoChunks(text: string): string[] {
  const chunks: string[] = [];
  let rest = text.trim();

  while (rest.length > CHUNK_SIZE && chunks.length < MAX_CHUNKS - 1) {
    const window = rest.slice(0, CHUNK_SIZE + 300);
    const candidates = [
      window.lastIndexOf('\n\n'),
      window.lastIndexOf('。'),
      window.lastIndexOf('！'),
      window.lastIndexOf('？'),
      window.lastIndexOf('\n'),
    ].filter((index) => index >= CHUNK_SIZE * 0.5);
    const cut = candidates.length > 0 ? Math.max(...candidates) : CHUNK_SIZE;

    chunks.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }

  if (rest) chunks.push(rest);
  return chunks.filter(Boolean);
}

async function summarizeChunk(chunk: string, index: number, total: number): Promise<string> {
  try {
    const raw = await callChatJson({
      system: `你是小说编辑。请从这段原文中提取后续改编要用的素材，不要评价文笔。
只输出一个 JSON 对象：{ "summary": "按事件顺序压缩到 300~500 字，保留人物、地点、关键动作、转折与结局" }`,
      user: `原文第 ${index + 1}/${total} 段：\n${chunk}`,
      temperature: 0.3,
      maxTokens: 1600,
    });
    const summary = str((raw as Record<string, unknown> | null)?.summary);
    return (summary || chunk).slice(0, SUMMARY_CLIP);
  } catch {
    // 单段摘要失败时保底用原文开头，不能让整章信息直接丢掉
    return chunk.slice(0, SUMMARY_CLIP);
  }
}

const describeProblems = (problems: PlanProblem[]): string =>
  problems.map((problem) => `- ${problem.message}`).join('\n');

/**
 * 自动时长模式下不让模型跑偏：
 * 每镜收在 2~30 秒，总时长收在 30~360 秒；超出时按比例缩放，尽量保留原有节奏。
 */
function normalizeAutoDurations(plan: StoryPlan): void {
  const beats = plan.beats;
  if (beats.length === 0) return;

  beats.forEach((beat) => {
    beat.duration = Math.round(clamp(beat.duration ?? 5, MIN_SHOT_SECONDS, MAX_SHOT_SECONDS));
  });

  const sum = beats.reduce((total, beat) => total + (beat.duration ?? 5), 0);
  if (sum >= 30 && sum <= 360) return;

  const target = Math.min(360, Math.max(30, sum));
  const scale = target / sum;
  let allocated = 0;

  beats.forEach((beat, index) => {
    if (index === beats.length - 1) {
      beat.duration = Math.round(
        clamp(target - allocated, MIN_SHOT_SECONDS, MAX_SHOT_SECONDS),
      );
    } else {
      beat.duration = Math.round(
        clamp((beat.duration ?? 5) * scale, MIN_SHOT_SECONDS, MAX_SHOT_SECONDS),
      );
    }
    allocated += beat.duration;
  });
}

function extractTreatment(raw: unknown, plan: StoryPlan): string {
  const treatment = str((raw as Record<string, unknown> | null)?.treatment);
  // 目标 300~500 字，但模型偶尔写得更短；低于 60 字说明没写成段落，用蓝图拼一份更稳
  if (treatment.length >= 60) return treatment;

  // 模型漏写 treatment 时用蓝图拼一份，至少保证「编辑创意」页有可用文本
  return [
    plan.logline,
    ...plan.beats.map((beat) => `${beat.beat}：${beat.action}`),
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * 把小说 / 章节压缩成可拍蓝图。
 * 失败返回 null，由调用方给出明确错误——长文改编失败时不宜悄悄退回一次性生成。
 */
export async function adaptStory(req: AdaptRequest): Promise<AdaptedStory | null> {
  const text = req.text.trim().slice(0, MAX_NOVEL_CHARS);
  if (!text) return null;

  let sourceBlock = text;

  if (text.length > DIRECT_LIMIT) {
    const chunks = splitIntoChunks(text);
    const summaries: string[] = [];
    for (let i = 0; i < chunks.length; i += 1) {
      summaries.push(await summarizeChunk(chunks[i], i, chunks.length));
    }
    sourceBlock = summaries
      .map((summary, i) => `【第 ${i + 1} 段摘要】\n${summary}`)
      .join('\n\n');

    void logEvent(
      'agent',
      'adapt',
      { reason: '长文分段摘要完成', chars: text.length, chunks: chunks.length },
      'info',
    );
  }

  const system = buildBlueprintSystemPrompt('小说改编编剧 + 分镜串联导演', ADAPT_RULES);
  // idea 在改编链路里只用于题材判断（机甲 / 巨兽等主体词可能出现在原文任意位置），不截断
  const baseReq: PlanRequest = {
    idea: text,
    style: req.style,
    shotCount: req.shotCount,
    shotRange: req.shotRange,
    totalDuration: req.totalDuration,
  };

  const request = async (correction?: string) => {
    try {
      const raw = await callChatJson({
        system,
        user: buildAdaptUserPrompt(req, sourceBlock, correction),
        temperature: 0.55,
        maxTokens: 4000,
      });
      const normalized = normalizeStoryPlan(raw, baseReq);
      return normalized ? { raw, normalized } : null;
    } catch {
      return null;
    }
  };

  let first = await request();
  if (!first) {
    // 原文摘要已经花掉若干次调用，蓝图这一步失败时值得再试一次
    void logAgentWarn('adapt', { reason: '改编蓝图生成失败，重试一次', chars: text.length });
    first = await request();
  }
  if (!first) {
    void logAgentWarn('adapt', { reason: '改编蓝图生成失败', chars: text.length });
    return null;
  }

  let chosen = first;
  const blocking = first.normalized.problems.filter((problem) => problem.blocking);
  if (blocking.length > 0) {
    void logAgentWarn('adapt', {
      reason: '改编蓝图不合格，带问题重试一次',
      problems: blocking.map((problem) => problem.message),
    });
    const second = await request(describeProblems(first.normalized.problems));
    if (second && !second.normalized.problems.some((problem) => problem.blocking)) {
      chosen = second;
    }
  }

  // 没给总时长时，镜头数、每镜时长、总时长都由模型决定，这里只做上下限收口
  if (!req.totalDuration) normalizeAutoDurations(chosen.normalized.plan);

  const treatment = extractTreatment(chosen.raw, chosen.normalized.plan);
  if (!treatment) return null;

  return { plan: chosen.normalized.plan, treatment };
}
