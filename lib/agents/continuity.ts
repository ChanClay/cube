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
  shotCount: number;
  totalDuration: number;
}

const str = (v: unknown, fallback = ''): string =>
  typeof v === 'string' && v.trim() ? v.trim() : fallback;

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
7. 镜头数量必须精确等于用户要求的数量，不多不少。

只输出一个 JSON 对象，不要解释文字、不要 markdown 代码块。

JSON 结构：
{
  "title": "片名",
  "logline": "一句话故事梗概",
  "characters": [{ "name": "角色名", "desc": "可拍摄的外形与身份描述" }],
  "beats": [
    {
      "index": 1,
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
  return `故事创意：
${req.idea}

整体视觉风格：${req.style || '电影感写实'}
镜头数量：${req.shotCount} 个
总时长：约 ${req.totalDuration} 秒

请设计 ${req.shotCount} 个镜头组成的连贯状态链，输出 JSON。`;
}

function normalizeBeat(raw: Record<string, unknown>, index: number): Beat {
  const shotSize = str(raw.shotSize, '中景');
  const cameraMove = str(raw.cameraMove, '固定机位');
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
  };
}

function normalizePlan(raw: unknown, shotCount: number): StoryPlan | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;

  const beatsRaw = Array.isArray(obj.beats) ? obj.beats : [];
  const beats = beatsRaw
    .filter((b): b is Record<string, unknown> => !!b && typeof b === 'object')
    .map((b, i) => normalizeBeat(b, i + 1));

  if (beats.length === 0) return null;

  // 数量对不上时以规划结果为准截断/保留，分镜阶段按实际条数生成
  const limited = beats.slice(0, shotCount);

  const charactersRaw = Array.isArray(obj.characters) ? obj.characters : [];
  const characters: Character[] = charactersRaw
    .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
    .slice(0, 8)
    .map((c) => ({ name: str(c.name, '角色'), desc: str(c.desc) }));

  return {
    title: str(obj.title, '无题短片'),
    logline: str(obj.logline),
    characters,
    beats: limited,
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
    return normalizePlan(raw, req.shotCount);
  } catch {
    return null;
  }
}
