import {
  MAX_SHOT_COUNT,
  MAX_SHOT_SECONDS,
  MIN_SHOT_COUNT,
  MIN_SHOT_SECONDS,
} from '@/lib/shot-plan';
import { logAgentWarn } from '@/lib/logger';
import { expandStyle } from '@/lib/style-presets';
import { clamp, dedupeByName, normalizeCameraMove, normalizeShotSize, str } from './spec';
import { callChatJson } from './llm';

/**
 * 故事架构师 / 串联导演 agent
 *
 * 分镜 agent 一次性写全部镜头时，很容易「每个镜头各自成立、但接不起来」，
 * 也容易让人物外形、场景光线在镜头之间漂移。所以先做一次独立规划：
 *
 * 1. 故事层：主题、基调、人物、场景——全片唯一事实来源。
 * 2. 串联层：一条 entry / exit 状态链——每一镜必须承接上一镜的结束状态。
 *
 * 分镜 agent 只负责照着蓝图写画面，连贯性由结构保证，而不是靠运气。
 * 蓝图不合格（缺动作、缺交接、镜数离谱）时会带着问题清单重试一次。
 */

export interface PlanCharacter {
  name: string;
  /** 叙事功能：主角 / 对手 / 帮手 / 象征物 */
  role?: string;
  /** 可拍摄的中文外形描述 */
  desc: string;
  /** 全片固定的英文外貌短语，分镜提示词直接复用 */
  promptEn?: string;
}

export interface PlanScene {
  name: string;
  /** 地点 / 时间 / 光线 / 主要陈设 */
  desc: string;
  /** 全片固定的英文空间短语 */
  promptEn?: string;
}

export interface Beat {
  index: number;
  /** 经典结构里的节拍名，如「开场钩子」「激励事件」「高潮」「余韵」 */
  beat: string;
  /** 这一镜的叙事任务 */
  purpose: string;
  /** 画面主体 */
  subject: string;
  /** 主体在做什么 */
  action: string;
  /** 承接上一镜的什么状态；第一镜写「开场」 */
  entry: string;
  /** 结束时留下的状态，必须能被下一镜直接接住 */
  exit: string;
  shotSize: string;
  cameraMove: string;
  /** 到下一镜的衔接方式 */
  transition: string;
  /** 情绪强度 1~5，整条链要形成曲线 */
  emotion?: number;
  /** 这一镜的时长（秒）；模型没给时为空，由调用方摊平 */
  duration?: number;
}

export interface StoryPlan {
  title: string;
  logline: string;
  /** 一句可以被画面证明的判断 */
  theme: string;
  /** 情绪基调与节奏 */
  tone: string;
  characters: PlanCharacter[];
  scenes: PlanScene[];
  beats: Beat[];
}

export interface PlanRequest {
  idea: string;
  style?: string;
  /** 固定镜头数（按镜头数量 / 保证完整性的总时长模式） */
  shotCount?: number;
  /**
   * 动态模式：不给固定镜数，只给合法区间，由模型按剧情自己决定切几刀。
   * 此时模型还要为每一镜分配时长，总和等于 totalDuration。
   */
  shotRange?: { min: number; max: number };
  /**
   * 总时长。小说改编不给这个值时，镜头数、每镜时长与总时长全部由模型决定
   * （2~12 镜、每镜 2~30 秒、总时长 30~360 秒）。
   */
  totalDuration?: number;
}

/** 蓝图问题：非阻塞问题（镜数偏差）交给分镜阶段合并 / 拆分，阻塞问题触发重试 */
export interface PlanProblem {
  code: 'shot-count' | 'incomplete-beat' | 'no-character' | 'no-scene';
  message: string;
  blocking: boolean;
}

/**
 * 蓝图提示词。默认是「故事架构师」，小说改编 agent 会换一个 role 并追加改编规则，
 * 两者共用同一套输出结构与校验，避免两份 schema 逐渐漂移。
 */
export function buildBlueprintSystemPrompt(
  role = '故事架构师 + 分镜串联导演',
  extraRules = '',
): string {
  return `你是「${role}」。上游只给一个故事创意，你要产出一份可拍摄蓝图：先确立故事内核与人物，再把故事拆成一条首尾相接的镜头状态链。
你不写画面文案，也不写台词，只做结构与状态设计。

【故事层】
1. logline：一句话，必须包含「谁 + 想要什么 + 被什么阻碍 + 可能付出什么代价」，40 字以内。
2. theme：一句可以被画面证明的判断（例：「承认失去，才是活下去的开始」），不要写「关于爱」这类名词短语。
3. tone：情绪基调与节奏（例：「压抑克制，前半慢，后半急促」），用来约束后面所有镜头。
4. 结构：用经典节拍组织，每个 beat 标注 beat 字段，只能取：开场钩子 / 铺垫 / 激励事件 / 升级 / 中点转折 / 低谷 / 高潮 / 余韵。镜数少时可以省略部分节拍，但开场钩子、高潮、余韵不能缺。
5. 人物 2~4 个：role 写叙事功能；desc 写可拍摄的中文外形（年龄、发型、服装颜色材质、随身道具、气质）；promptEn 写 8~16 个单词的固定英文外貌短语，必须包含年龄 / 发型 / 服装 / 关键道具，全片一字不改地复用。
6. 场景 1~4 个：desc 写地点、时间、光线、主要陈设；promptEn 写 8~16 个单词的固定英文空间短语。同一个空间只写一次，不要按镜头重复。

【串联层】
7. entry 必须是上一镜 exit 的直接延续（第一镜的 entry 写「开场」）。不许出现「之后」「过了一会儿」这类含糊表述，除非 entry 里写明时间跳转。
8. exit 必须是一个可以直接拍出来的画面状态：谁、在哪里、什么姿势、朝向哪里、手里拿着什么。不要写情绪或抽象概念。
9. 相邻两镜的 action 首尾相接：上一镜没做完的动作，下一镜接着做完；不许出现动作凭空完成、人物凭空换位、道具凭空出现。
10. 空间连续：全片尽量在同一个空间内完成。开场用大远景 / 全景把空间关系交代清楚，之后的镜头不得凭空换场地；确实需要转场时，用 transition 明确写出过渡方式。
11. 镜头语言成组：相邻镜头避免同样的景别 + 运镜，景别按「建立 → 逼近 → 细节 → 释放」的节奏推进。
12. 情绪曲线：给每一镜 emotion（1~5）。不要一开场就 5，也不要全程 3；最高点落在全片后 1/3 的高潮镜。
13. 镜头数量：给了明确的「镜头数量」就必须精确等于这个数量；如果给的是一段区间，则按故事节奏自己决定用几个镜头，必须落在区间内——不要为了凑数硬切，也不要把几个本该分开的节拍硬塞进一个镜头。
14. duration 是这一镜的时长（秒，${MIN_SHOT_SECONDS}~${MAX_SHOT_SECONDS} 的整数）。用户给了总时长时，所有镜头 duration 之和必须等于它；没给总时长时，由你按剧情节奏决定总时长（30~360 秒），不要套用固定值。
${extraRules ? `\n${extraRules}\n` : ''}
只输出一个 JSON 对象，不要解释文字、不要 markdown 代码块。

JSON 结构：
{
  "title": "片名",
  "logline": "一句话故事梗概",
  "theme": "一句可被画面证明的判断",
  "tone": "情绪基调与节奏",${extraRules ? '\n  "treatment": "300~500 字连贯梗概，按成片顺序写",' : ''}
  "characters": [
    { "name": "角色名", "role": "叙事功能", "desc": "可拍摄的中文外形", "promptEn": "fixed English appearance phrase" }
  ],
  "scenes": [
    { "name": "场景名", "desc": "地点 / 时间 / 光线 / 陈设", "promptEn": "fixed English location phrase" }
  ],
  "beats": [
    {
      "index": 1,
      "beat": "开场钩子",
      "emotion": 2,
      "duration": 5,
      "purpose": "这一镜的叙事任务",
      "subject": "画面主体",
      "action": "具体动作",
      "entry": "承接的上一镜状态；第一镜写「开场」",
      "exit": "结束时留下的可拍摄状态",
      "shotSize": "特写/近景/中景/全景/远景/大远景",
      "cameraMove": "固定机位/缓慢推近/缓慢拉远/横向移动/环绕/跟随/手持晃动/升格慢动作",
      "transition": "到下一镜的衔接方式"
    }
  ]
}`;
}

function buildUserPrompt(req: PlanRequest, correction?: string): string {
  const countLine = req.shotRange
    ? `镜头数量：由你根据故事节奏自行决定，${req.shotRange.min}~${req.shotRange.max} 个之间`
    : req.shotCount
      ? `镜头数量：${req.shotCount} 个`
      : `镜头数量：由你根据剧情节奏决定，${MIN_SHOT_COUNT}~${MAX_SHOT_COUNT} 个之间`;

  const totalLine = req.totalDuration
    ? `总时长：${req.totalDuration} 秒`
    : '总时长：由你根据剧情节奏决定（30~360 秒），不要套用固定时长';

  const durationRule = req.totalDuration
    ? `每一镜给出 ${MIN_SHOT_SECONDS}~${MAX_SHOT_SECONDS} 秒的 duration，总和必须等于 ${req.totalDuration} 秒`
    : `每一镜给出 ${MIN_SHOT_SECONDS}~${MAX_SHOT_SECONDS} 秒的 duration；镜头数量、每镜时长与总时长都由你按剧情决定（${MIN_SHOT_COUNT}~${MAX_SHOT_COUNT} 镜）`;

  const tail = req.shotRange
    ? `请先定人物与场景，再设计一条连贯的状态链（镜头数量由你决定），${durationRule}，输出 JSON。`
    : req.shotCount
      ? `请先定人物与场景，再设计 ${req.shotCount} 个镜头组成的连贯状态链，${durationRule}，输出 JSON。`
      : `请先定人物与场景，再设计一条连贯的状态链，${durationRule}，输出 JSON。`;

  const correctionBlock = correction
    ? `

上一次输出存在以下问题，请逐条修正后重新输出完整 JSON（不要只给改动部分）：
${correction}`
    : '';

  return `故事创意：
${req.idea}

整体视觉风格：${expandStyle(req.style) || '电影感写实风格，35mm 胶片质感，自然光，浅景深'}
${countLine}
${totalLine}

${tail}${correctionBlock}`;
}

function normalizeCharacter(raw: Record<string, unknown>): PlanCharacter | null {
  const name = str(raw.name);
  if (!name) return null;
  return {
    name,
    role: str(raw.role) || undefined,
    desc: str(raw.desc),
    promptEn: str(raw.promptEn) || undefined,
  };
}

function normalizeScene(raw: Record<string, unknown>): PlanScene | null {
  const name = str(raw.name);
  if (!name) return null;
  return {
    name,
    desc: str(raw.desc),
    promptEn: str(raw.promptEn) || undefined,
  };
}

function normalizeBeat(raw: Record<string, unknown>, index: number): Beat {
  const durationRaw = Number(raw.duration);
  const duration =
    Number.isFinite(durationRaw) && durationRaw > 0
      ? Math.round(clamp(durationRaw, MIN_SHOT_SECONDS, MAX_SHOT_SECONDS))
      : undefined;
  const emotionRaw = Number(raw.emotion);
  const emotion = Number.isFinite(emotionRaw)
    ? Math.round(clamp(emotionRaw, 1, 5))
    : undefined;

  return {
    index,
    beat: str(raw.beat, index === 1 ? '开场钩子' : '升级'),
    purpose: str(raw.purpose, `推进第 ${index} 段`),
    subject: str(raw.subject, '主体'),
    action: str(raw.action),
    entry: str(raw.entry, index === 1 ? '开场' : ''),
    exit: str(raw.exit),
    shotSize: normalizeShotSize(raw.shotSize),
    cameraMove: normalizeCameraMove(raw.cameraMove),
    transition: str(raw.transition),
    emotion,
    duration,
  };
}

export interface NormalizedPlan {
  plan: StoryPlan;
  problems: PlanProblem[];
}

export function normalizeStoryPlan(raw: unknown, req: PlanRequest): NormalizedPlan | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;

  const beatsRaw = Array.isArray(obj.beats) ? obj.beats : [];
  const beats = beatsRaw
    .filter((b): b is Record<string, unknown> => !!b && typeof b === 'object')
    .map((b, i) => normalizeBeat(b, i + 1));

  if (beats.length === 0) return null;

  const problems: PlanProblem[] = [];
  const fixedCount = req.shotRange ? null : (req.shotCount ?? null);

  if (req.shotRange) {
    // 动态模式：镜数由模型决定，只夹在合法区间里
    if (beats.length < req.shotRange.min) {
      problems.push({
        code: 'shot-count',
        message:
          `只规划了 ${beats.length} 镜，少于下限 ${req.shotRange.min} 镜` +
          (req.totalDuration ? `，${req.totalDuration} 秒无法排满` : ''),
        blocking: true,
      });
    } else if (beats.length > req.shotRange.max) {
      beats.splice(req.shotRange.max);
      problems.push({
        code: 'shot-count',
        message: `规划了超过上限 ${req.shotRange.max} 镜，已截断`,
        blocking: false,
      });
    }
  } else if (fixedCount !== null && beats.length !== fixedCount) {
    // 镜数偏差不阻塞：分镜阶段会按用户要求的镜数合并 / 拆分节拍
    problems.push({
      code: 'shot-count',
      message: `要求 ${fixedCount} 镜，实际规划了 ${beats.length} 镜`,
      blocking: false,
    });
  } else if (fixedCount === null && beats.length > MAX_SHOT_COUNT) {
    // 小说改编没给镜数：只夹上限，保留模型的节奏
    beats.splice(MAX_SHOT_COUNT);
    problems.push({
      code: 'shot-count',
      message: `规划了超过上限 ${MAX_SHOT_COUNT} 镜，已截断`,
      blocking: false,
    });
  }

  // 自动时长模式：模型偶尔漏给 duration，先补 5 秒，调用方再按总时长上下限收口
  if (!req.totalDuration) {
    for (const beat of beats) {
      if (!beat.duration) beat.duration = 5;
    }
  }

  const incomplete = beats.filter((beat, i) => {
    const last = i === beats.length - 1;
    const first = i === 0;
    return (
      beat.action.length < 2 ||
      beat.subject.length < 1 ||
      (!last && beat.exit.length < 2) ||
      (!first && beat.entry.length < 2)
    );
  });
  if (incomplete.length > 0) {
    problems.push({
      code: 'incomplete-beat',
      message: `第 ${incomplete.map((b) => b.index).join('、')} 镜缺动作 / entry / exit，状态链接不上`,
      // 少量缺漏交给分镜阶段补，大面积缺失才重试
      blocking: incomplete.length > Math.max(1, Math.floor(beats.length / 3)),
    });
  }

  const charactersRaw = Array.isArray(obj.characters) ? obj.characters : [];
  const characters = dedupeByName(
    charactersRaw
      .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
      .slice(0, 8)
      .map(normalizeCharacter)
      .filter((c): c is PlanCharacter => c !== null),
  );
  if (characters.length === 0) {
    problems.push({ code: 'no-character', message: '没有给出任何角色', blocking: true });
  }

  const scenesRaw = Array.isArray(obj.scenes) ? obj.scenes : [];
  const scenes = dedupeByName(
    scenesRaw
      .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
      .slice(0, 6)
      .map(normalizeScene)
      .filter((s): s is PlanScene => s !== null),
  );
  if (scenes.length === 0) {
    // 场景缺失不致命：分镜阶段仍能从镜头描述里归纳
    problems.push({ code: 'no-scene', message: '没有给出场景卡', blocking: false });
  }

  return {
    plan: {
      title: str(obj.title, '无题短片'),
      logline: str(obj.logline),
      theme: str(obj.theme),
      tone: str(obj.tone),
      characters,
      scenes,
      beats,
    },
    problems,
  };
}

const describeProblems = (problems: PlanProblem[]): string =>
  problems.map((problem) => `- ${problem.message}`).join('\n');

async function requestPlan(
  req: PlanRequest,
  correction?: string,
): Promise<NormalizedPlan | null> {
  try {
    const raw = await callChatJson({
      system: buildBlueprintSystemPrompt(),
      user: buildUserPrompt(req, correction),
      temperature: 0.7,
      maxTokens: 4000,
    });
    return normalizeStoryPlan(raw, req);
  } catch {
    return null;
  }
}

/**
 * 规划故事蓝图。失败时返回 null —— 调用方应降级为「直接生成分镜」，
 * 不能因为规划环节失败就让整个剧本生成挂掉。
 */
export async function planStory(req: PlanRequest): Promise<StoryPlan | null> {
  const first = await requestPlan(req);
  if (!first) return null;

  const blocking = first.problems.filter((problem) => problem.blocking);
  if (blocking.length === 0) {
    // 非阻塞问题（镜数偏差、缺场景卡）也让调用方知道，便于排查生成质量
    if (first.problems.length > 0) {
      void logAgentWarn('plan', {
        reason: '蓝图存在非阻塞问题，继续生成',
        problems: first.problems.map((problem) => problem.message),
      });
    }
    return first.plan;
  }

  void logAgentWarn('plan', {
    reason: '蓝图不合格，带问题重试一次',
    problems: blocking.map((problem) => problem.message),
    idea: req.idea.slice(0, 80),
  });

  const second = await requestPlan(req, describeProblems(first.problems));
  if (second && !second.problems.some((problem) => problem.blocking)) {
    return second.plan;
  }

  // 重试仍不完美时保留第一版：有状态链总比完全退化强，分镜阶段还能补
  return first.plan;
}
