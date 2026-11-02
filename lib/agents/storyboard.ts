import { config } from '@/lib/config';
import { logAgentWarn } from '@/lib/logger';
import type { Character, NarrationType, Scene, Script, Shot } from '@/lib/types';
import { planStory, type StoryPlan } from './continuity';
import { callChatJson } from './llm';

export interface ScriptRequest {
  idea: string;
  style?: string;
  shotCount?: number;
  duration?: number;
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

const str = (v: unknown, fallback = ''): string =>
  typeof v === 'string' && v.trim() ? v.trim() : fallback;

function buildSystemPrompt(): string {
  return `你是一位资深影视编剧兼 AI 分镜师。用户会给你一个故事创意（可能附带一份「串联大纲」），你要产出一份可以直接交给「文生视频模型」逐镜头生成的完整分镜脚本。

如果提供了「串联大纲」，必须严格按它执行：
1. 第 N 镜的画面必须从大纲中该镜的 entry 状态开始，在大纲的 exit 状态结束。entry 写「开场」的镜次负责把空间关系交代清楚。
2. 不允许跳过大纲里的 action，也不允许新增任何会改变人物位置或空间的动作。
3. shotSize 与 cameraMove 采用大纲指定的值；大纲的 transition 只是剪辑衔接策略，不要写进画面内容里。
4. 同一角色在所有镜头中使用完全一致的外貌短语（照抄 characters 里的外形描述要点），服装、发型、道具不得变化。

其它创作要求：
1. 镜头必须构成完整叙事：开场建立环境 → 冲突推进 → 高潮 → 收尾，每个镜头画面都要有变化，禁止重复同一构图。
2. 每个镜头 duration 字段是 2~30 之间的整数（秒），常用 5 或 10；镜头之间的时长可以不同。所有镜头时长之和接近用户要求的总时长。
3. videoPrompt 字段必须是英文提示词，40~90 个单词，按以下顺序描述：镜头主体 + 具体动作 + 环境与背景 + 光线与色调 + 景别与运镜 + 画面风格。要求画面具体、可拍摄、有电影感。
   - 禁止出现字幕、文字、水印、logo、分屏等描述；
   - 禁止出现 "shot 1"、"scene 2" 这类结构性词语；
   - 若同一角色在多个镜头出现，用同样简短的外貌描述保持一致性（例如 "a young woman with short silver hair"）。
4. description 字段是中文，一句话说明这一镜发生了什么，给导演看。有串联大纲时，description 里要能看出它如何接住上一镜。
5. narration 字段是这一镜要说出来的话，可为空字符串（不要写"旁白："前缀）。
   narrationType 只能是 dialogue（角色开口说这句，会驱动口型）、voiceover（画外旁白，人物不开口）或 none（这一镜不需要任何口播，此时 narration 留空）。
   台词必须短：一句 10~20 字，5 秒左右的镜头最多一句，不要写成整段独白。
6. shotSize 用中文景别（特写/近景/中景/全景/远景/大远景），cameraMove 用中文运镜（固定机位/缓慢推近/缓慢拉远/横向移动/环绕/跟随/手持晃动/升格慢动作）。
7. characters 字段是这一镜真正出镜的角色名数组，必须逐字使用顶部「角色」里的名字（无人物出镜时给空数组）。画外音、回忆中的人物不要写进来。
   scenes 字段是这一镜所在场景名数组，必须逐字使用 scenes 里的 name（一个镜头通常只有一个场景）。
8. scenes 字段是全片复用的场景设定（2~5 个），写清地点、时间、光线与主要陈设；同一个空间只写一次，不要按镜头重复。
9. 只输出一个 JSON 对象，不要任何解释文字、不要 markdown 代码块。

JSON 结构：
{
  "title": "片名",
  "logline": "一句话故事梗概",
  "style": "整体视觉风格",
  "characters": [{ "name": "角色名", "desc": "角色外形与身份描述" }],
  "scenes": [{ "name": "场景名", "desc": "空间描述：地点 / 时间 / 光线 / 主要陈设" }],
  "shots": [
    {
      "title": "镜头小标题",
      "duration": 5,
      "shotSize": "中景",
      "cameraMove": "缓慢推近",
      "description": "中文画面描述",
      "videoPrompt": "English prompt for text-to-video model",
      "narration": "这一镜要说的话，可为空",
      "narrationType": "dialogue | voiceover",
      "characters": ["出镜角色名"],
      "scenes": ["所在场景名"]
    }
  ]
}`;
}

function buildUserPrompt(
  req: ScriptRequest,
  shotCount: number,
  totalDuration: number,
  plan: StoryPlan | null,
): string {
  const head = `故事创意：
${req.idea}

整体视觉风格：${req.style || '电影感写实'}
镜头数量：${shotCount} 个
总时长：约 ${totalDuration} 秒
旁白语言：中文`;

  if (!plan) {
    return `${head}

请输出 ${shotCount} 个镜头的分镜脚本 JSON。`;
  }

  const characters = plan.characters
    .map((c) => `- ${c.name}：${c.desc}`)
    .join('\n');

  const beats = plan.beats
    .map(
      (b) =>
        `${b.index}. 任务：${b.purpose}｜主体：${b.subject}｜动作：${b.action}｜` +
        `entry（承接）：${b.entry}｜exit（交棒）：${b.exit}｜` +
        `景别：${b.shotSize}｜运镜：${b.cameraMove}｜到下一镜：${b.transition}`,
    )
    .join('\n');

  return `${head}

串联大纲（必须严格照此执行）：
片名：${plan.title}
梗概：${plan.logline}

角色（外形必须全片一致）：
${characters || '（无）'}

镜头状态链：
${beats}

请输出 ${shotCount} 个镜头的分镜脚本 JSON。每一镜都要接住上一镜的 exit，并以自己的 exit 结束。`;
}

/** 名字列表：模型可能给数组，也可能只给一个字符串 */
function normalizeNameList(source: unknown): string[] {
  const list = Array.isArray(source) ? source : typeof source === 'string' ? [source] : [];
  const names = list
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((name): name is string => name.length > 0);
  return [...new Set(names)].slice(0, 8);
}

/** 每镜出镜角色名：模型可能写成 characters / characterNames / character 三种 */
function normalizeCharacterNames(raw: Record<string, unknown>): string[] {
  return normalizeNameList(raw.characters ?? raw.characterNames ?? raw.character);
}

function normalizeNarrationType(raw: unknown, narration: string): NarrationType {
  if (raw === 'dialogue') return 'dialogue';
  // 没有台词才是真正的「都不要」；写了台词却标 none 属于自相矛盾，按旁白兜住
  if (raw === 'none' && !narration.trim()) return 'none';
  return 'voiceover';
}

function normalizeShot(raw: Record<string, unknown>, index: number): Shot {
  const durationRaw = Number(raw.duration);
  /** wan3.0 支持 2~30 秒，模型给出区间外的值就夹回来 */
  const duration =
    Number.isFinite(durationRaw) && durationRaw >= 2 ? Math.round(clamp(durationRaw, 2, 30)) : 5;
  return {
    id: crypto.randomUUID(),
    index,
    title: str(raw.title, `镜头 ${index}`),
    duration,
    shotSize: str(raw.shotSize, '中景'),
    cameraMove: str(raw.cameraMove, '固定机位'),
    description: str(raw.description),
    videoPrompt: str(raw.videoPrompt, str(raw.description)),
    narration: str(raw.narration),
    // 模型没给类型时按画外旁白处理：旧剧本的 narration 基本都是旁白，
    // 默认成 dialogue 会让人物莫名其妙开口。
    // 给了 none 却仍然写了台词时按旁白处理，避免内容白白丢掉。
    narrationType: normalizeNarrationType(raw.narrationType, str(raw.narration)),
    characterNames: normalizeCharacterNames(raw),
    sceneNames: normalizeNameList(raw.scenes ?? raw.scene),
    media: [],
  };
}

function normalizeScript(raw: unknown, fallbackStyle: string): Script {
  if (!raw || typeof raw !== 'object') throw new Error('模型返回内容不是对象');
  const obj = raw as Record<string, unknown>;
  const shotsRaw = Array.isArray(obj.shots) ? obj.shots : [];
  if (shotsRaw.length === 0) throw new Error('模型没有生成任何分镜镜头');

  const shots = shotsRaw
    .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
    .map((s, i) => normalizeShot(s, i + 1));

  shots.forEach((s, i) => (s.index = i + 1));

  const charactersRaw = Array.isArray(obj.characters) ? obj.characters : [];
  const characters: Character[] = charactersRaw
    .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
    .slice(0, 8)
    .map((c) => ({ id: crypto.randomUUID(), name: str(c.name, '角色'), desc: str(c.desc) }));

  const scenesRaw = Array.isArray(obj.scenes) ? obj.scenes : [];
  const scenes: Scene[] = scenesRaw
    .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
    .slice(0, 8)
    .map((s) => ({ id: crypto.randomUUID(), name: str(s.name, '场景'), desc: str(s.desc) }))
    .filter((s) => s.name.trim() || s.desc.trim());

  return {
    title: str(obj.title, '无题短片'),
    logline: str(obj.logline),
    style: str(obj.style, fallbackStyle),
    characters,
    scenes,
    shots,
  };
}

export async function generateScript(req: ScriptRequest): Promise<Script> {
  if (!config.llm.apiKey) {
    throw new Error('未配置 LLM_API_KEY，请在 .env.local 中填写剧本生成模型的 Key');
  }

  const shotCount = clamp(Math.round(req.shotCount ?? 6), 1, 12);
  // 上限对齐 wan3.0 单镜 30 秒 × 最多 12 镜
  const totalDuration = clamp(Math.round(req.duration ?? shotCount * 5), 5, 360);
  const style = req.style || '电影感写实';

  // 第一步：串联 agent 规划带 entry / exit 的状态链；失败则退化为直接生成
  const plan = await planStory({
    idea: req.idea,
    style,
    shotCount,
    totalDuration,
  });

  if (!plan) {
    // 串联环节失败不会中断生成，但连贯性会回退到「一次性生成」，需要留痕
    void logAgentWarn('plan', {
      reason: '串联规划失败，已降级为直接生成分镜',
      idea: req.idea.slice(0, 80),
      shotCount,
      totalDuration,
    });
  }

  const targetShots = plan ? plan.beats.length : shotCount;

  // 第二步：分镜 agent 照着状态链写画面
  const raw = await callChatJson({
    system: buildSystemPrompt(),
    user: buildUserPrompt(req, targetShots, totalDuration, plan),
    temperature: 0.8,
    maxTokens: 6000,
  });

  const script = normalizeScript(raw, style);

  // 角色卡以串联大纲为唯一事实来源：分镜 prompt 用的就是它，
  // 不能再让模型二次生成一份，否则 UI 上看到的和提示词里用的会不一致。
  if (plan) {
    if (!script.logline) script.logline = plan.logline;
    if (plan.characters.length > 0) script.characters = plan.characters;
  }

  return script;
}
