import { MAX_SHOT_SECONDS, MIN_SHOT_SECONDS } from '@/lib/shot-plan';
import type { Character } from '@/lib/types';
import { callChatJson } from './llm';

/**
 * 串联导演 agent
 *
 * 分镜 agent 一次生成全部镜头时很容易「每个镜头各自成立、但接不起来」。
 * 这里先用一次独立调用规划出带 entry / exit 的状态链：
 * 每一镜必须承接上一镜的结束状态，并留下一个明确状态交给下一镜。
 * 分镜 agent 再照着这条链写画面，连贯性由结构保证，而不是靠运气。
 */

export interface Beat {
  index: number;
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
  /** 这一镜的时长（秒）；模型没给时为空，由调用方摊平 */
  duration?: number;
}

export interface StoryPlan {
  title: string;
  logline: string;
  characters: Character[];
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
  totalDuration: number;
}

const str = (v: unknown, fallback = ''): string =>
  typeof v === 'string' && v.trim() ? v.trim() : fallback;

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

const SHOT_SIZES = ['特写', '近景', '中景', '全景', '远景', '大远景'];
const CAMERA_MOVES = [
  '固定机位',
  '缓慢推近',
  '缓慢拉远',
  '横向移动',
  '环绕',
  '跟随',
  '手持晃动',
  '升格慢动作',
];

function buildSystemPrompt(): string {
  return `你是「分镜串联导演」。你不写分镜文案，你只负责设计一条严丝合缝的动作与情绪链条。

你要输出一条状态链：每一镜都必须明确回答三个问题——它接住了上一镜的什么（entry）、这一镜发生了什么（action）、它把什么状态交给下一镜（exit）。

硬性规则：
1. entry 必须是上一镜 exit 的直接延续（第一镜的 entry 写「开场」）。不许出现「之后」「过了一会儿」这类含糊表述，除非 entry 里写明时间跳转。
2. exit 必须是一个可以直接拍出来的画面状态：谁、在哪里、什么姿势、朝向哪里、手里拿着什么。不要写情绪或抽象概念。
3. 相邻两镜的 action 首尾相接：上一镜没做完的动作，下一镜接着做完；不许出现动作凭空完成、人物凭空换位。
4. 空间连续：全片尽量在同一个空间内完成。开场用大远景/全景把空间关系交代清楚，之后的镜头不得凭空换场地；确实需要转场时，用 transition 明确写出过渡方式。
5. 角色一致性：同一角色的外形、服装、随身道具在全片不能改变。characters 里的 desc 写清可拍摄的外形细节（年龄、发型、服装颜色材质、特征）。
6. 镜头语言要成组：相邻镜头避免同样的景别+运镜，景别按「建立 → 逼近 → 细节 → 释放」的节奏推进。
7. 镜头数量：给了明确的「镜头数量」就必须精确等于这个数量，不多不少；如果给的是一段区间，则按故事节奏自己决定用几个镜头，必须落在区间内——不要为了凑数硬切，也不要把几个本该分开的节拍硬塞进一个镜头。
8. duration 是这一镜的时长（秒，${MIN_SHOT_SECONDS}~${MAX_SHOT_SECONDS} 的整数）。同一条大纲里所有镜头的 duration 之和必须等于用户要求的总时长。

只输出一个 JSON 对象，不要解释文字、不要 markdown 代码块。

JSON 结构：
{
  "title": "片名",
  "logline": "一句话故事梗概",
  "characters": [{ "name": "角色名", "desc": "可拍摄的外形与身份描述" }],
  "beats": [
    {
      "index": 1,
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

function buildUserPrompt(req: PlanRequest): string {
  const countLine = req.shotRange
    ? `镜头数量：由你根据故事节奏自行决定，${req.shotRange.min}~${req.shotRange.max} 个之间`
    : `镜头数量：${req.shotCount ?? 1} 个`;

  const tail = req.shotRange
    ? `请设计一条连贯的状态链（镜头数量由你决定），每一镜给出 ${MIN_SHOT_SECONDS}~${MAX_SHOT_SECONDS} 秒的 duration，总和必须等于 ${req.totalDuration} 秒，输出 JSON。`
    : `请设计 ${req.shotCount ?? 1} 个镜头组成的连贯状态链，每一镜给出 ${MIN_SHOT_SECONDS}~${MAX_SHOT_SECONDS} 秒的 duration，总和必须等于 ${req.totalDuration} 秒，输出 JSON。`;

  return `故事创意：
${req.idea}

整体视觉风格：${req.style || '电影感写实'}
${countLine}
总时长：${req.totalDuration} 秒

${tail}`;
}

function normalizeBeat(raw: Record<string, unknown>, index: number): Beat {
  const shotSize = str(raw.shotSize, '中景');
  const cameraMove = str(raw.cameraMove, '固定机位');
  const durationRaw = Number(raw.duration);
  const duration =
    Number.isFinite(durationRaw) && durationRaw > 0
      ? Math.round(clamp(durationRaw, MIN_SHOT_SECONDS, MAX_SHOT_SECONDS))
      : undefined;

  return {
    index,
    purpose: str(raw.purpose, `推进第 ${index} 段`),
    subject: str(raw.subject, '主体'),
    action: str(raw.action),
    entry: str(raw.entry, index === 1 ? '开场' : '承接上一镜'),
    exit: str(raw.exit),
    shotSize: SHOT_SIZES.includes(shotSize) ? shotSize : '中景',
    cameraMove: CAMERA_MOVES.includes(cameraMove) ? cameraMove : '固定机位',
    transition: str(raw.transition),
    duration,
  };
}

function normalizePlan(raw: unknown, req: PlanRequest): StoryPlan | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;

  const beatsRaw = Array.isArray(obj.beats) ? obj.beats : [];
  const beats = beatsRaw
    .filter((b): b is Record<string, unknown> => !!b && typeof b === 'object')
    .map((b, i) => normalizeBeat(b, i + 1));

  if (beats.length === 0) return null;

  if (req.shotRange) {
    // 动态模式：镜数由模型决定，只夹在合法区间里；
    // 少于下限时总时长必然撑不满 30 秒/镜，直接判定规划不可用，交给调用方降级
    if (beats.length < req.shotRange.min) return null;
    beats.splice(req.shotRange.max);
  } else {
    // 数量对不上时以规划结果为准截断/保留，分镜阶段按实际条数生成
    beats.splice(req.shotCount ?? beats.length);
  }

  const charactersRaw = Array.isArray(obj.characters) ? obj.characters : [];
  const characters: Character[] = charactersRaw
    .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
    .slice(0, 8)
    .map((c) => ({ name: str(c.name, '角色'), desc: str(c.desc) }));

  return {
    title: str(obj.title, '无题短片'),
    logline: str(obj.logline),
    characters,
    beats,
  };
}

/**
 * 规划串联状态链。失败时返回 null —— 调用方应降级为「直接生成分镜」，
 * 不能因为串联环节失败就让整个剧本生成挂掉。
 */
export async function planStory(req: PlanRequest): Promise<StoryPlan | null> {
  try {
    const raw = await callChatJson({
      system: buildSystemPrompt(),
      user: buildUserPrompt(req),
      temperature: 0.7,
      maxTokens: 4000,
    });
    return normalizePlan(raw, req);
  } catch {
    return null;
  }
}
