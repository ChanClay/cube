import { config } from '@/lib/config';
import { expandStyle } from '@/lib/style-presets';
import type { Script } from '@/lib/types';
import type { StoryPlan } from './continuity';
import {
  cameraMoveEn,
  CONTINUITY_RULES,
  countWords,
  hasForbiddenPromptPhrase,
  hasTransitionHint,
  isEnglishPrompt,
  matchedWords,
  narrationLimit,
  PROMPT_REPAIR_MAX_WORDS,
  PROMPT_REPAIR_WORDS,
  promptCameraMatches,
  promptShotSizeMatches,
  SHOT_LANGUAGE_RULES,
  shotSizeEn,
  stateOverlap,
  TIMELINE_RULES,
  VIDEO_PROMPT_RULES,
} from './spec';
import { callChatJson } from './llm';

/**
 * 审片 agent
 *
 * 分镜写作是一次性生成，模型偶尔会漏字段、把提示词写成中文、台词超长、
 * 镜头数对不上，或者两镜复制粘贴。与其祈祷模型一次做对，不如成稿后做一次
 * 确定性检查（不花钱、不发请求），只把真正需要重写的问题交给模型修一次。
 */

export interface ScriptIssue {
  level: 'fatal' | 'warn';
  code: string;
  shotIndex?: number;
  message: string;
}

export interface AuditOptions {
  /** 用户要求的镜头数（动态模式不传） */
  expectedShots?: number;
}

export function auditScript(script: Script, options: AuditOptions = {}): ScriptIssue[] {
  const issues: ScriptIssue[] = [];
  const cast = new Set(script.characters.map((c) => c.name.trim()).filter(Boolean));
  const scenes = new Set((script.scenes ?? []).map((s) => s.name.trim()).filter(Boolean));

  /** 蓝图给的固定英文短语：用来检查提示词有没有真的用上（人物 / 空间写漂） */
  const castPromptEn = new Map(
    script.characters
      .filter((c) => c.name.trim() && c.promptEn)
      .map((c) => [c.name.trim(), c.promptEn as string]),
  );
  const scenePromptEn = new Map(
    (script.scenes ?? [])
      .filter((s) => s.name.trim() && s.promptEn)
      .map((s) => [s.name.trim(), s.promptEn as string]),
  );

  if (script.shots.length === 0) {
    return [{ level: 'fatal', code: 'no-shot', message: '没有生成任何镜头' }];
  }

  if (options.expectedShots && script.shots.length !== options.expectedShots) {
    issues.push({
      level: 'fatal',
      code: 'shot-count',
      message: `要求 ${options.expectedShots} 镜，实际 ${script.shots.length} 镜`,
    });
  }

  /** 提示词去重用的归一化文本 */
  const seenPrompts = new Set<string>();

  for (const shot of script.shots) {
    const at = shot.index;
    const description = shot.description.trim();
    const prompt = shot.videoPrompt.trim();

    if (description.length < 2) {
      issues.push({ level: 'fatal', code: 'empty-description', shotIndex: at, message: `第 ${at} 镜没有画面描述` });
    }
    if (prompt.length < 5) {
      issues.push({ level: 'fatal', code: 'empty-prompt', shotIndex: at, message: `第 ${at} 镜没有视频提示词` });
    } else {
      const words = countWords(prompt);
      if (!isEnglishPrompt(prompt)) {
        issues.push({
          level: 'fatal',
          code: 'prompt-not-english',
          shotIndex: at,
          message: `第 ${at} 镜的 videoPrompt 不是英文（${words} 个词）`,
        });
      } else if (words < PROMPT_REPAIR_WORDS) {
        issues.push({
          level: 'warn',
          code: 'prompt-weak',
          shotIndex: at,
          message: `第 ${at} 镜的 videoPrompt 只有 ${words} 个词，信息量不足`,
        });
      } else if (words > PROMPT_REPAIR_MAX_WORDS) {
        issues.push({
          level: 'warn',
          code: 'prompt-long',
          shotIndex: at,
          message: `第 ${at} 镜的 videoPrompt 有 ${words} 个词，过于啰嗦`,
        });
      }
      if (hasForbiddenPromptPhrase(prompt)) {
        issues.push({
          level: 'fatal',
          code: 'prompt-forbidden',
          shotIndex: at,
          message: `第 ${at} 镜的 videoPrompt 含字幕 / 水印 / 分屏等禁用内容`,
        });
      }

      const key = prompt.toLowerCase().replace(/\s+/g, ' ');
      if (seenPrompts.has(key)) {
        issues.push({
          level: 'warn',
          code: 'duplicate-prompt',
          shotIndex: at,
          message: `第 ${at} 镜的 videoPrompt 与前面某一镜完全相同`,
        });
      }
      seenPrompts.add(key);

      // 中英是否说的是同一镜：运镜 / 景别必须对得上，否则成片和剧本不是一回事
      if (!promptCameraMatches(prompt, shot.cameraMove)) {
        issues.push({
          level: 'warn',
          code: 'prompt-camera-mismatch',
          shotIndex: at,
          message: `第 ${at} 镜的运镜是「${shot.cameraMove}」（${cameraMoveEn(shot.cameraMove)}），但英文提示词里没有对应的运镜描述`,
        });
      }
      if (!promptShotSizeMatches(prompt, shot.shotSize)) {
        issues.push({
          level: 'warn',
          code: 'prompt-shot-size-mismatch',
          shotIndex: at,
          message: `第 ${at} 镜的景别是「${shot.shotSize}」（${shotSizeEn(shot.shotSize)}），英文提示词里没有对应的景别`,
        });
      }

      // 蓝图锁定的固定英文短语没用上，说明这一镜的长相 / 空间写漂了
      for (const name of shot.characterNames ?? []) {
        const phrase = castPromptEn.get(name.trim());
        if (!phrase) continue;
        const { hit, total } = matchedWords(phrase, prompt);
        if (total >= 3 && hit / total < 0.5) {
          issues.push({
            level: 'warn',
            code: 'prompt-drift',
            shotIndex: at,
            message: `第 ${at} 镜的英文提示词没有用上「${name}」的固定外貌短语「${phrase}」（只命中 ${hit}/${total} 个关键描述词）`,
          });
        }
      }
      for (const name of shot.sceneNames ?? []) {
        const phrase = scenePromptEn.get(name.trim());
        if (!phrase) continue;
        const { hit, total } = matchedWords(phrase, prompt);
        if (total >= 3 && hit / total < 0.5) {
          issues.push({
            level: 'warn',
            code: 'prompt-drift',
            shotIndex: at,
            message: `第 ${at} 镜的英文提示词没有用上场景「${name}」的固定空间短语「${phrase}」（只命中 ${hit}/${total} 个关键描述词）`,
          });
        }
      }
    }

    // 秒级节奏：4 秒以上的镜头至少切成两段，否则一句「他在点灯」就得撑满整段视频
    const beatCount = shot.beatSheet?.length ?? 0;
    if (shot.duration >= 4 && beatCount < 2) {
      issues.push({
        level: 'warn',
        code: 'timeline-missing',
        shotIndex: at,
        message: `第 ${at} 镜 ${shot.duration} 秒只有 ${beatCount} 段节奏，需要切成 2~4 段秒级节拍（第几秒到第几秒各发生什么）`,
      });
    }

    const limit = narrationLimit(shot.duration);
    if (shot.narration.length > limit) {
      issues.push({
        level: 'warn',
        code: 'narration-long',
        shotIndex: at,
        message: `第 ${at} 镜台词 ${shot.narration.length} 字，${shot.duration} 秒最多 ${limit} 字`,
      });
    }

    if (shot.narrationType === 'dialogue') {
      if (!shot.narration.trim()) {
        issues.push({
          level: 'warn',
          code: 'dialogue-empty',
          shotIndex: at,
          message: `第 ${at} 镜标成了角色台词，却没有写台词内容`,
        });
      }
      if (!shot.speaker) {
        issues.push({
          level: 'warn',
          code: 'dialogue-no-speaker',
          shotIndex: at,
          message: `第 ${at} 镜是角色台词，但没有指定谁在说`,
        });
      } else if (!(shot.characterNames ?? []).includes(shot.speaker)) {
        issues.push({
          level: 'warn',
          code: 'speaker-not-on-screen',
          shotIndex: at,
          message: `第 ${at} 镜的说话人「${shot.speaker}」不在本镜出镜角色里`,
        });
      }
    }

    for (const name of shot.characterNames ?? []) {
      if (cast.size > 0 && !cast.has(name)) {
        issues.push({
          level: 'warn',
          code: 'unknown-character',
          shotIndex: at,
          message: `第 ${at} 镜引用了角色表里没有的「${name}」`,
        });
      }
    }

    for (const name of shot.sceneNames ?? []) {
      if (scenes.size > 0 && !scenes.has(name)) {
        issues.push({
          level: 'warn',
          code: 'unknown-scene',
          shotIndex: at,
          message: `第 ${at} 镜引用了场景表里没有的「${name}」`,
        });
      }
    }
  }

  /**
   * 跨镜状态链：本镜的入口必须与上一镜的出口是同一个画面事实。
   * 一条都没写时不做这项检查——那种稿子需要的是重写分镜，不是补字段。
   */
  const hasAnyState = script.shots.some((shot) => shot.entryState?.trim() || shot.exitState?.trim());
  if (hasAnyState) {
    script.shots.forEach((shot, i) => {
      if (i === 0) return;
      const prev = script.shots[i - 1];
      const entry = shot.entryState?.trim() ?? '';
      const exit = prev.exitState?.trim() ?? '';

      if (!entry) {
        issues.push({
          level: 'warn',
          code: 'state-missing',
          shotIndex: shot.index,
          message: `第 ${shot.index} 镜没有写 entryState，无法确认它接住了第 ${prev.index} 镜`,
        });
        return;
      }
      if (!exit) {
        issues.push({
          level: 'warn',
          code: 'state-missing',
          shotIndex: prev.index,
          message: `第 ${prev.index} 镜没有写 exitState，第 ${shot.index} 镜没有状态可接`,
        });
        return;
      }
      // 明确写了跳转（片刻后 / 次日 / 转场）时，允许状态不连续
      if (hasTransitionHint(entry)) return;

      if (stateOverlap(exit, entry) < 0.15) {
        issues.push({
          level: 'warn',
          code: 'continuity-gap',
          shotIndex: shot.index,
          message:
            `第 ${prev.index} 镜结束于「${exit}」，第 ${shot.index} 镜却从「${entry}」开始，` +
            '看不出是同一个人物的同一个状态；若不是刻意跳时间 / 换场地，请让本镜接住上一镜',
        });
      }
    });
  }

  return issues;
}

/**
 * 哪些问题值得再花一次模型调用？
 * 引用错位、台词超长已经在前置步骤确定性修掉了；这里只修需要重写文案的问题。
 */
const REPAIRABLE = new Set([
  'no-shot',
  'shot-count',
  'empty-description',
  'empty-prompt',
  'prompt-not-english',
  'prompt-forbidden',
  'prompt-weak',
  'prompt-long',
  'duplicate-prompt',
  'prompt-camera-mismatch',
  'prompt-shot-size-mismatch',
  'prompt-drift',
  'state-missing',
  'continuity-gap',
  'timeline-missing',
  'dialogue-empty',
  'dialogue-no-speaker',
  'speaker-not-on-screen',
]);

export function needsRepair(issues: ScriptIssue[]): boolean {
  return issues.some((issue) => REPAIRABLE.has(issue.code));
}

export interface RepairInput {
  script: Script;
  plan: StoryPlan | null;
  issues: ScriptIssue[];
  /** 目标镜头数 */
  expectedShots: number;
  style: string;
}

function buildSystemPrompt(): string {
  return `你是「分镜审片编辑」。上游已经写好一份镜头剧本，但存在若干明确问题。你的任务是逐条修复，而不是重写整个故事。

修复原则：
1. 只改有问题的镜头，其余镜头保持原文；人物、场景、动作顺序与结尾不得改变。
2. 修镜数时：多了就合并相邻镜头（保留两镜的进入 / 结束状态），少了就把信息量最大的镜头拆成两镜（新增镜头不得引入新剧情）。
3. 修连贯性时：按「上一镜 exitState → 本镜 entryState」对齐，只改断裂的那一镜，不要重排剧情、不要为了接上而新增动作。
4. 修提示词时，沿用角色表里的英文外貌短语与场景表里的英文空间短语，保持全片一致；英文必须逐项对应当镜的中文 description，不许补充中文里没写的元素，也不许漏掉中文写了的主体 / 动作 / 道具。
5. ${VIDEO_PROMPT_RULES}
6. ${SHOT_LANGUAGE_RULES}
7. narration 是这一镜要说的唯一一句话，10~20 字；narrationType 只能是 dialogue / voiceover / none，none 时 narration 必须为空字符串。
8. dialogue 必须同时给 speaker（说话人，必须是本镜 characters 里的名字），并把 speaker 加进 characters；voiceover / none 时 speaker 留空。不要把人物台词写成 voiceover，也不要把旁白写成 dialogue。
9. 每镜 duration 保持原值（除非镜数变化需要重新分配），所有 duration 之和等于原总时长。
10. characters / scenes 里的名字必须逐字来自角色表 / 场景表。
11. 每个镜头都要输出 entryState 与 exitState；原本没写的要补上，原本写了的不要改坏。
12. 每个镜头都要输出 beatSheet（秒级节奏）；改了动作或时长时同步改时间轴，时间轴必须覆盖 0~duration。
13. 输出完整的 shots 数组（不是补丁），只输出一个 JSON 对象，不要解释文字、不要 markdown 代码块。

连贯性约束：
${CONTINUITY_RULES}

分镜时间轴：
${TIMELINE_RULES}

JSON 结构：
{
  "shots": [
    {
      "title": "镜头小标题",
      "duration": 5,
      "shotSize": "中景",
      "cameraMove": "缓慢推近",
      "entryState": "本镜第一帧的画面事实，与上一镜 exitState 一致",
      "exitState": "本镜最后一帧的画面事实",
      "beatSheet": [{ "from": 0, "to": 2, "action": "这一段里发生的可见动作" }],
      "description": "中文画面描述",
      "videoPrompt": "English prompt",
      "narration": "台词或旁白，可为空",
      "narrationType": "dialogue | voiceover | none",
      "speaker": "说话的角色名（仅 dialogue，其余留空）",
      "characters": ["出镜角色名"],
      "scenes": ["所在场景名"]
    }
  ]
}`;
}

function buildUserPrompt(input: RepairInput): string {
  const { script, plan, issues, expectedShots } = input;
  const totalDuration = script.shots.reduce((sum, shot) => sum + shot.duration, 0);

  // 蓝图里有固定的英文外貌 / 空间短语时优先给模型，修复才不会把长相写漂
  const cast = (plan && plan.characters.length > 0 ? plan.characters : script.characters)
    .map((c) => {
      const promptEn = 'promptEn' in c && c.promptEn ? `｜英文外貌：${c.promptEn}` : '';
      return `- ${c.name}：${c.desc}${promptEn}`;
    })
    .join('\n');
  const scenes = (plan && plan.scenes.length > 0 ? plan.scenes : (script.scenes ?? []))
    .map((s) => {
      const promptEn = 'promptEn' in s && s.promptEn ? `｜英文空间：${s.promptEn}` : '';
      return `- ${s.name}：${s.desc}${promptEn}`;
    })
    .join('\n');

  const blueprint = plan
    ? `故事蓝图：
片名：${plan.title}
梗概：${plan.logline}
主题：${plan.theme || '（未给出）'}
基调：${plan.tone || '（未给出）'}

节拍（用于修复时对齐剧情与状态链，不要改动顺序）：
${plan.beats
  .map(
    (beat) =>
      `${beat.index}. [${beat.beat}] ${beat.subject}：${beat.action}｜` +
      `entryState：${beat.entry}｜exitState：${beat.exit}`,
  )
  .join('\n')}`
    : '（没有故事蓝图，按当前镜头内容修复）';

  const shotJson = JSON.stringify(
    script.shots.map((shot) => ({
      index: shot.index,
      title: shot.title,
      duration: shot.duration,
      shotSize: shot.shotSize,
      cameraMove: shot.cameraMove,
      entryState: shot.entryState ?? '',
      exitState: shot.exitState ?? '',
      beatSheet: shot.beatSheet ?? [],
      description: shot.description,
      videoPrompt: shot.videoPrompt,
      narration: shot.narration,
      narrationType: shot.narrationType ?? 'voiceover',
      speaker: shot.speaker ?? '',
      characters: shot.characterNames ?? [],
      scenes: shot.sceneNames ?? [],
    })),
    null,
    1,
  );

  return `整体视觉风格：${expandStyle(input.style) || '电影感写实风格，35mm 胶片质感，自然光，浅景深'}
目标镜头数：${expectedShots}
当前总时长：${totalDuration} 秒（修复后总和必须不变）

角色表：
${cast || '（无）'}

场景表：
${scenes || '（无）'}

${blueprint}

需要修复的问题：
${issues.map((issue) => `- ${issue.message}`).join('\n')}

当前分镜：
${shotJson}

请输出修复后的完整 shots 数组 JSON。`;
}

/** 请求一次修复；失败返回 null，调用方保留原稿 */
export async function requestRepair(input: RepairInput): Promise<Record<string, unknown>[] | null> {
  try {
    const raw = await callChatJson({
      system: buildSystemPrompt(),
      user: buildUserPrompt(input),
      temperature: 0.4,
      maxTokens: config.llm.maxTokens,
      timeoutMs: Math.min(config.llm.timeoutMs, 120_000),
    });

    const obj = (raw ?? {}) as Record<string, unknown>;
    const list = Array.isArray(obj.shots) ? obj.shots : [];
    const shots = list.filter(
      (item): item is Record<string, unknown> => !!item && typeof item === 'object',
    );
    return shots.length > 0 ? shots : null;
  } catch {
    return null;
  }
}
