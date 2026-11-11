import { config } from '@/lib/config';
import { logAgentWarn } from '@/lib/logger';
import {
  fitDurations,
  splitByDuration,
  MAX_SHOT_COUNT,
  MAX_SHOT_SECONDS,
  MIN_SHOT_SECONDS,
  type DurationSplit,
  type ScriptMode,
} from '@/lib/shot-plan';
import { expandStyle } from '@/lib/style-presets';
import type { Character, NarrationType, Scene, Script, Shot } from '@/lib/types';
import { adaptStory } from './adaptation';
import { planStory, type Beat, type StoryPlan } from './continuity';
import { callChatJson } from './llm';
import { localizePrompts } from './localize';
import { auditScript, needsRepair, requestRepair, type ScriptIssue } from './review';
import {
  clamp,
  CONTINUITY_RULES,
  dedupeByName,
  normalizeBeatSheet,
  normalizeCameraMove,
  normalizeShotSize,
  PROMPT_MAX_WORDS,
  PROMPT_MIN_WORDS,
  SHOT_LANGUAGE_RULES,
  str,
  stripForbiddenPromptPhrases,
  TIMELINE_RULES,
  trimNarration,
  VIDEO_PROMPT_RULES,
} from './spec';

export interface ScriptRequest {
  /** 故事创意；source=novel 时这里是小说 / 章节原文 */
  idea: string;
  /**
   * 输入类型：idea=短创意（默认），novel=小说 / 章节原文。
   * novel 会先走改编 agent 压缩成可拍蓝图，再进行分镜写作。
   */
  source?: 'idea' | 'novel';
  style?: string;
  /**
   * 分镜方式：shots=按镜头数（默认），duration=按总时长反推镜头数。
   * source=novel 时忽略：镜头数、每镜时长与总时长全部由改编蓝图决定。
   */
  mode?: ScriptMode;
  /** source=novel 时忽略 */
  shotCount?: number;
  /** shots 模式下是总时长，duration 模式下是用户设定的视频总时长；source=novel 时忽略 */
  duration?: number;
  /**
   * 仅 duration 模式生效，默认 true：
   * true=镜头数取最少、每镜尽量凑满 10 秒（一次生成越长越不流畅）；false=镜数由 AI 按剧情决定（只约束区间）。
   */
  ensureCompleteness?: boolean;
}

export interface ScriptResult {
  script: Script;
  /** 小说改编后压出来的梗概；调用方用它回填「故事创意」 */
  adaptedIdea?: string;
}

function buildSystemPrompt(): string {
  return `你是一位「分镜编剧 + 文生视频提示词工程师」。上游给出故事创意，可能还附带一份故事蓝图；你要把它变成可以直接逐镜生成的镜头剧本。
你的输出要同时满足三件事：故事讲得通、镜头接得上、每个提示词都能被文生视频模型拍出来。

【一、故事与蓝图】
1. 有蓝图时严格使用蓝图的人物、场景与节拍，不得新增会改变空间或人物关系的内容；蓝图节拍数与目标镜数不一致时，多了就合并相邻节拍（不丢高潮与结尾），少了就拆解（不新增剧情）。
2. 合并或拆分节拍时 entry / exit 必须整体继承：合并后第一镜用前一节的 entry、最后一镜用后一节的 exit；拆分后新增镜头的 entry 等于上一镜的 exit。
3. 每个镜头从该节拍的 entry 状态开始，在 exit 状态结束；entry 写「开场」的镜次负责交代空间关系。
4. 第一镜要在开头就让观众看懂「谁、在哪、发生了什么异常」，最后一镜留下情绪余韵，不要用总结性旁白收尾。
5. 禁止用台词 / 旁白解释画面已经说清楚的信息；不要写「他心想」这类拍不出来的内容。

【二、跨镜连贯性（整份剧本最重要的部分）】
6. ${CONTINUITY_RULES}

【三、镜头语言】
7. 景别按「建立 → 逼近 → 细节 → 释放」推进；相邻镜头不要同景别 + 同运镜；每个镜头只承担一个视觉动作，画面必须有可见变化（位置 / 姿态 / 光线 / 物件）。
8. ${SHOT_LANGUAGE_RULES}
9. 角色一致性：同一角色全片复用蓝图给出的英文外貌短语（promptEn），服装、发型、装甲涂装、机械部件与道具不得变化。没有蓝图时自拟角色卡：先判断主体类型——人类写年龄感、发色、服装；机甲 / 机器人 / 巨兽等非人主体只写机型与体量、装甲材质与涂装、头部传感器、关节液压、武器与配色，不要给它写年龄、发型、上衣与鞋。
10. 场景一致性：同一空间只使用蓝图场景卡的英文空间短语（promptEn），不要逐镜改写地点与光线。
11. 有蓝图时，shotSize / cameraMove 优先采用蓝图指定的值。

【四、videoPrompt】
12. ${VIDEO_PROMPT_RULES}
13. 写作顺序固定：先用中文把这一镜的 description 写清楚（景别 + 谁 + 在做什么 + 环境 + 光线），再把这段中文逐项翻成 videoPrompt。禁止脱离 description 另写画面。
14. videoPrompt 写完后逐项核对：主体、动作、道具、环境、光线是否每个都在英文里出现？英文里有没有中文没写的元素？多出来的删掉，漏掉的补上。一段话写完，不要分点、不要重复同一信息。

【五、分镜时间轴】
15. ${TIMELINE_RULES}

【六、台词】
16. narration 是这一镜要说出来的唯一一句话，10~20 字；不要写进 description 或 videoPrompt，也不要写「旁白：」前缀。
17. narrationType：dialogue = 画面里的人物开口说话（会驱动口型）；voiceover = 画外旁白（画面里的人物闭嘴）；none = 这一镜完全无口播（此时 narration 必须为空字符串）。
18. dialogue 必须同时给 speaker（说话的角色名），speaker 必须逐字来自本镜 characters；不要把人物台词写成 voiceover，也不要把旁白写成 dialogue。
19. 有人物出镜、且这一镜承载情绪或冲突时，优先写一句人物台词；全片至少 1 句 dialogue（创意明确要求无对白时除外）。
20. 台词长度不能超过这一镜能说完的量：5 秒镜最多约 20 字，长镜头最多 60 字；一句台词只表达一个意思，要口语、有潜台词，不要念设定。

【七、数据完整性】
21. 每个镜头的 characters 是这一镜真正出镜的角色名数组，必须逐字使用角色表名字（无人物出镜时给空数组）；每个镜头里的 scenes 必须逐字使用场景表名字。
22. JSON 顶层的 scenes 是全片复用的场景卡（1~4 个），有蓝图时直接沿用蓝图；不要按镜头重复写场景卡。
23. 所有镜头 duration 之和必须等于用户要求的总时长；给了「镜头时长分配」就逐条照抄，不要改动。
24. shots 数组长度必须精确等于目标镜数。
25. 只输出一个 JSON 对象，不要解释文字、不要 markdown 代码块。

JSON 结构：
{
  "title": "片名",
  "logline": "一句话故事梗概",
  "style": "整体视觉风格",
  "characters": [{ "name": "角色名", "desc": "外形与身份描述：人类写年龄 / 头部 / 服装 / 道具，机甲 / 非人主体写机型体量 / 装甲材质与涂装 / 传感器 / 关节 / 武器 / 编号", "promptEn": "fixed English appearance phrase" }],
  "scenes": [{ "name": "场景名", "desc": "空间描述：地点 / 时间 / 光线 / 主要陈设", "promptEn": "fixed English location phrase" }],
  "shots": [
    {
      "title": "镜头小标题",
      "duration": 5,
      "shotSize": "中景",
      "cameraMove": "缓慢推近",
      "entryState": "本镜第一帧的画面事实，与上一镜 exitState 一致",
      "exitState": "本镜最后一帧的画面事实，供下一镜接住",
      "beatSheet": [
        { "from": 0, "to": 2, "action": "抬眼看向塔顶" },
        { "from": 2, "to": 5, "action": "伸手拧开灯罩" }
      ],
      "description": "中文画面描述",
      "videoPrompt": "这一镜 description 的忠实英文翻译",
      "narration": "这一镜要说的话，可为空",
      "narrationType": "dialogue | voiceover | none",
      "speaker": "说这句台词的角色名（仅 dialogue 时填写，其余留空）",
      "characters": ["出镜角色名"],
      "scenes": ["所在场景名"]
    }
  ]
}`;
}

function buildUserPrompt(
  req: ScriptRequest,
  expectedShots: number,
  totalDuration: number,
  plan: StoryPlan | null,
  durations: number[] | null,
): string {
  /**
   * 总时长模式下时长是要对齐的：
   * - 时长已经算好（保证完整性 / 蓝图给了 duration）→ 逐条写进提示词，模型只负责照抄；
   * - 镜数由 AI 决定时算不出来 → 只给区间和总和约束，让它自己分配。
   */
  const isDurationMode = req.mode === 'duration';
  const timing =
    durations && durations.length === expectedShots
      ? `\n镜头时长分配（必须逐条对应，单位秒）：${durations.join(' / ')}`
      : isDurationMode
        ? `\n每镜时长：在 ${MIN_SHOT_SECONDS}~${MAX_SHOT_SECONDS} 秒之间自行分配，各镜 duration 之和必须等于 ${totalDuration} 秒`
        : `\n各镜时长之和必须等于 ${totalDuration} 秒`;

  const head = `故事创意：
${req.idea}

整体视觉风格：${expandStyle(req.style) || '电影感写实风格，35mm 胶片质感，自然光，浅景深'}
目标镜头数：${expectedShots} 个
总时长：约 ${totalDuration} 秒
旁白语言：中文${timing}`;

  const selfCheck = `输出前自检（不通过就改，不要把自检写进 JSON）：
1) shots 是否正好 ${expectedShots} 个？
2) 第 2 镜起，每镜的 entryState 是否与上一镜的 exitState 是同一个画面事实（谁 / 在哪 / 什么姿势 / 手里拿着什么），只是换了措辞？
3) 第 1 镜到最后一镜连起来读，是否是一条没有跳跃、没有凭空换场地、没有道具凭空出现的连续动作链？
4) 每镜的 beatSheet 是否从 0 秒切到 duration 秒、段与段之间不断档不重叠、每段都是一个（且只有一个）可见动作？
5) 角色名 / 场景名是否逐字来自上方清单？
6) 每个 videoPrompt 是否是 ${PROMPT_MIN_WORDS}~${PROMPT_MAX_WORDS} 个词的英文，只含一个运镜，景别与运镜是否与 shotSize / cameraMove 对得上？
7) 每个 videoPrompt 是否逐项对应本镜 description：主体、动作、道具、环境、光线都在英文里，且没有中文没写过的元素？
8) 台词是否在该镜时长能说完的范围内，dialogue 是否都填了 speaker 且 speaker 在本镜 characters 里？
9) 所有 duration 之和是否等于 ${totalDuration} 秒？`;

  if (!plan) {
    return `${head}

没有故事蓝图。请先在脑子里排出一条完整的动作链（谁从哪开始、每个镜头推进到什么状态），再逐镜写；写完回读一遍，确认相邻镜头之间没有跳跃。

请输出 ${expectedShots} 个镜头的分镜脚本 JSON。

${selfCheck}`;
  }

  const characters = plan.characters
    .map((c) => {
      const role = c.role ? `（${c.role}）` : '';
      const promptEn = c.promptEn ? `｜英文外貌：${c.promptEn}` : '';
      return `- ${c.name}${role}：${c.desc}${promptEn}`;
    })
    .join('\n');

  const scenes = plan.scenes
    .map((s) => `- ${s.name}：${s.desc}${s.promptEn ? `｜英文空间：${s.promptEn}` : ''}`)
    .join('\n');

  const beats = plan.beats
    .map((b) => {
      const emotion = b.emotion ? `｜情绪：${b.emotion}/5` : '';
      return (
        `${b.index}. [${b.beat}] 任务：${b.purpose}\n` +
        `   主体：${b.subject}｜动作：${b.action}\n` +
        `   entryState（与上一镜 exitState 是同一个状态）：${b.entry}\n` +
        `   exitState（下一镜要能直接接住）：${b.exit}\n` +
        `   景别：${b.shotSize}｜运镜：${b.cameraMove}｜到下一镜：${b.transition}${emotion}`
      );
    })
    .join('\n');

  const mergeHint =
    plan.beats.length === expectedShots
      ? ''
      : `\n注意：蓝图为 ${plan.beats.length} 个节拍，最终必须是 ${expectedShots} 镜——` +
        `节拍多了就合并相邻镜头（高潮与结尾不能丢），少了就拆分信息量最大的镜头（不能新增剧情）。`;

  return `${head}

故事蓝图（必须严格照此执行）：
片名：${plan.title}
梗概：${plan.logline}
主题：${plan.theme || '（未给出）'}
基调与节奏：${plan.tone || '（未给出）'}

角色（外形必须全片一致）：
${characters || '（无）'}

场景（空间与光线必须全片一致）：
${scenes || '（无）'}

镜头状态链（共 ${plan.beats.length} 个节拍）：
${beats}${mergeHint}

请输出 ${expectedShots} 个镜头的分镜脚本 JSON。每一镜的 entryState 都必须是上一镜 exitState 的延续，出口的 exitState 必须能被下一镜直接接住——这条状态链比任何单镜画面都重要。

${selfCheck}`;
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

/**
 * 说话人：只有 dialogue 才有意义。
 * 模型没填时，本镜只有一个出镜角色就用它；多人镜头留空，交给审片修复补。
 */
function normalizeSpeaker(
  raw: Record<string, unknown>,
  narrationType: NarrationType,
  characterNames: string[],
): string | undefined {
  if (narrationType !== 'dialogue') return undefined;

  const speaker = str(raw.speaker ?? raw.speakerName);
  if (!speaker) return characterNames.length === 1 ? characterNames[0] : undefined;

  // 模型可能写「老陈」而角色卡是「守塔人老陈」，先尽量对齐
  const exact = characterNames.find((name) => name === speaker);
  if (exact) return exact;
  const loose = characterNames.find(
    (name) => name.includes(speaker) || speaker.includes(name),
  );
  return loose ?? speaker;
}

function normalizeShot(raw: Record<string, unknown>, index: number): Shot {
  const durationRaw = Number(raw.duration);
  /** wan3.0 支持 2~30 秒，模型给出区间外的值就夹回来 */
  const duration =
    Number.isFinite(durationRaw) && durationRaw >= MIN_SHOT_SECONDS
      ? Math.round(clamp(durationRaw, MIN_SHOT_SECONDS, MAX_SHOT_SECONDS))
      : 5;
  const narration = trimNarration(raw.narration, duration);
  const prompt = stripForbiddenPromptPhrases(
    str(raw.videoPrompt, str(raw.description)),
  );
  const characterNames = normalizeCharacterNames(raw);
  // 模型没给类型时按画外旁白处理：旧剧本的 narration 基本都是旁白，
  // 默认成 dialogue 会让人物莫名其妙开口。
  // 给了 none 却仍然写了台词时按旁白处理，避免内容白白丢掉。
  const narrationType = normalizeNarrationType(raw.narrationType, narration);

  return {
    id: crypto.randomUUID(),
    index,
    title: str(raw.title, `镜头 ${index}`),
    duration,
    shotSize: normalizeShotSize(raw.shotSize),
    cameraMove: normalizeCameraMove(raw.cameraMove),
    entryState: str(raw.entryState ?? raw.entry ?? raw.stateIn) || undefined,
    exitState: str(raw.exitState ?? raw.exit ?? raw.stateOut) || undefined,
    beatSheet: normalizeBeatSheet(raw.beatSheet ?? raw.beats ?? raw.timeline, duration),
    description: str(raw.description),
    videoPrompt: prompt,
    narration,
    narrationType,
    speaker: normalizeSpeaker(raw, narrationType, characterNames),
    characterNames,
    sceneNames: normalizeNameList(raw.scenes ?? raw.scene),
    media: [],
  };
}

/**
 * @param fallbackStyle 模型没写 style 时的兜底（用户填的风格或默认值）
 * @param userStyle 用户显式填写的风格；填了就优先用它
 */
function normalizeScript(raw: unknown, fallbackStyle: string, userStyle?: string): Script {
  if (!raw || typeof raw !== 'object') throw new Error('模型返回内容不是对象');
  const obj = raw as Record<string, unknown>;
  const shotsRaw = Array.isArray(obj.shots) ? obj.shots : [];
  if (shotsRaw.length === 0) throw new Error('模型没有生成任何分镜镜头');

  const shots = shotsRaw
    .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
    .map((s, i) => normalizeShot(s, i + 1));

  shots.forEach((s, i) => (s.index = i + 1));

  const charactersRaw = Array.isArray(obj.characters) ? obj.characters : [];
  const characters: Character[] = dedupeByName(
    charactersRaw
      .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
      .slice(0, 8)
      .map((c) => ({
        id: crypto.randomUUID(),
        name: str(c.name, '角色'),
        desc: str(c.desc),
        promptEn: str(c.promptEn) || undefined,
      })),
  );

  const scenesRaw = Array.isArray(obj.scenes) ? obj.scenes : [];
  const scenes: Scene[] = dedupeByName(
    scenesRaw
      .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
      .slice(0, 8)
      .map((s) => ({
        id: crypto.randomUUID(),
        name: str(s.name, '场景'),
        desc: str(s.desc),
        promptEn: str(s.promptEn) || undefined,
      }))
      .filter((s) => s.name.trim() || s.desc.trim()),
  );

  return {
    title: str(obj.title, '无题短片'),
    logline: str(obj.logline),
    /**
     * 用户写了风格就以用户的为准：模型经常把它改写成一句泛泛的「电影感」，
     * 结果角色卡 / 场景卡的画风和用户要的对不上。
     */
    style: userStyle?.trim() || str(obj.style, fallbackStyle),
    characters,
    scenes,
    shots,
  };
}

/**
 * 蓝图是角色卡与场景卡的唯一事实来源：
 * 分镜提示词里用的就是它，不能再让模型二次生成一份，否则 UI 上看到的
 * 和逐镜提示词里用的会不一致。
 */
function applyPlanFoundation(script: Script, plan: StoryPlan | null): void {
  if (!plan) return;
  if (!script.title || script.title === '无题短片') script.title = plan.title;
  if (plan.characters.length > 0) {
    script.characters = plan.characters.map((c) => ({
      id: crypto.randomUUID(),
      name: c.name,
      desc: c.desc,
      promptEn: c.promptEn,
    }));
  }
  if (plan.scenes.length > 0) {
    script.scenes = plan.scenes.map((s) => ({
      id: crypto.randomUUID(),
      name: s.name,
      desc: s.desc,
      promptEn: s.promptEn,
    }));
  }
  if (!script.logline) script.logline = plan.logline;

  // 蓝图的状态链是确定性锚点：分镜稿缺首尾状态时以蓝图补上
  const first = script.shots[0];
  const last = script.shots[script.shots.length - 1];
  if (first && !first.entryState && plan.beats[0]?.entry) {
    first.entryState = str(plan.beats[0].entry) || undefined;
  }
  if (last && !last.exitState && plan.beats.length > 0) {
    last.exitState = str(plan.beats[plan.beats.length - 1].exit) || undefined;
  }
}

/**
 * 状态链兜底：缺 entryState 的镜头直接沿用上一镜的 exitState。
 * 不花模型调用，但能保证每一镜都有可承接的入口，审片与修复也有据可依。
 */
function stabilizeStateChain(script: Script): void {
  script.shots.forEach((shot, i) => {
    if (i === 0 || shot.entryState) return;
    const prevExit = script.shots[i - 1]?.exitState;
    if (prevExit) shot.entryState = prevExit;
  });
}

/** 名字对齐：精确 → 忽略大小写 → 包含关系（模型常写「老陈」/「守塔人老陈」） */
function matchName(raw: string, candidates: string[]): string | null {
  const value = raw.trim();
  if (!value) return null;
  const exact = candidates.find((name) => name === value);
  if (exact) return exact;
  const lower = value.toLowerCase();
  return (
    candidates.find((name) => name.toLowerCase() === lower) ??
    candidates.find((name) => name.includes(value) || value.includes(name)) ??
    null
  );
}

/**
 * 校准镜头与角色卡 / 场景卡的引用：
 * - 模型写错的名字尽量映射回卡上的名字，映射不了就丢掉；
 * - 中文画面描述里点名出现的角色自动补进 characters；
 * - 全片只有一个场景时，没标场景的镜头直接归到该场景。
 */
function reconcileReferences(script: Script, plan: StoryPlan | null): void {
  const castNames = dedupeByName(script.characters.map((c) => ({ name: c.name })))
    .map((c) => c.name)
    .filter(Boolean);
  const sceneNames = dedupeByName((script.scenes ?? []).map((s) => ({ name: s.name })))
    .map((s) => s.name)
    .filter(Boolean);

  for (const shot of script.shots) {
    const characters = new Set<string>();
    for (const raw of shot.characterNames ?? []) {
      const hit = matchName(raw, castNames);
      if (hit) characters.add(hit);
    }
    if (characters.size === 0) {
      // 描述里点了名（「老陈抬头看向塔顶」）却没标角色，补回来
      for (const name of castNames) {
        if (name && shot.description.includes(name)) characters.add(name);
      }
    }
    shot.characterNames = [...characters];

    const scenes = new Set<string>();
    for (const raw of shot.sceneNames ?? []) {
      const hit = matchName(raw, sceneNames);
      if (hit) scenes.add(hit);
    }
    if (scenes.size === 0 && sceneNames.length === 1) scenes.add(sceneNames[0]);
    shot.sceneNames = [...scenes];

    /**
     * 角色台词必须有具体的说话人，而且这个人得在本镜出镜：
     * 名字对不上就映射回角色卡；本镜只有一个角色 / 全片只有一个角色时直接兜底。
     */
    if (shot.narrationType === 'dialogue') {
      const rawSpeaker = str(shot.speaker);
      const speaker =
        (rawSpeaker ? matchName(rawSpeaker, castNames) : null) ??
        (rawSpeaker ? matchName(rawSpeaker, shot.characterNames) : null) ??
        (shot.characterNames.length === 1 ? shot.characterNames[0] : null) ??
        (castNames.length === 1 ? castNames[0] : null);

      if (speaker) {
        shot.speaker = speaker;
        if (!shot.characterNames.includes(speaker)) {
          shot.characterNames = [...shot.characterNames, speaker];
        }
      } else {
        shot.speaker = undefined;
      }
    } else {
      shot.speaker = undefined;
    }
  }

  // 蓝图给了场景卡时，把没有归类的片段挂回第一个场景，避免场景卡悬空
  if (plan && plan.scenes.length > 0 && sceneNames.length > 0) {
    for (const shot of script.shots) {
      if ((shot.sceneNames ?? []).length === 0) shot.sceneNames = [sceneNames[0]];
    }
  }
}

/** 蓝图里各镜的时长。模型给的秒数都合法、且总和与总时长相差不多时才算可用 */
function beatDurations(beats: Beat[], totalDuration: number): number[] | null {
  if (beats.length === 0) return null;

  const list = beats.map((b) => b.duration);
  if (
    list.some(
      (d) =>
        typeof d !== 'number' ||
        !Number.isFinite(d) ||
        d < MIN_SHOT_SECONDS ||
        d > MAX_SHOT_SECONDS,
    )
  ) {
    return null;
  }

  const durations = list as number[];
  const sum = durations.reduce((a, b) => a + b, 0);
  // 允许小偏差：把差额补到最后一镜上，越界就整体摊平
  if (Math.abs(sum - totalDuration) > Math.max(2, beats.length)) return null;

  const last = durations[durations.length - 1] + (totalDuration - sum);
  if (last < MIN_SHOT_SECONDS || last > MAX_SHOT_SECONDS) return null;

  durations[durations.length - 1] = last;
  return durations;
}

/** 总时长模式下的拆解结果：镜数、每镜秒数（可能未知）、总时长 */
interface DurationBudget {
  split: DurationSplit;
  /** 动态模式下镜数未知，只有区间 */
  dynamic: boolean;
  /** 固定镜数（dynamic=false 时有效） */
  shotCount: number | null;
  /** 每镜目标秒数；动态模式且蓝图没给时长时为 null（由 AI 分配） */
  durations: number[] | null;
  total: number;
}

/**
 * 动态模式下模型自己给的秒数：总和接近总时长就微调最后一镜，
 * 否则整体摊平。这样 AI 排的节奏（长镜头 / 快切）不会被打乱。
 */
function reconcileDurations(shots: Shot[], total: number): number[] {
  const list = shots.map((s) =>
    Math.round(clamp(s.duration, MIN_SHOT_SECONDS, MAX_SHOT_SECONDS)),
  );
  const sum = list.reduce((a, b) => a + b, 0);
  const tolerance = Math.max(2, Math.ceil(total * 0.1));

  if (Math.abs(sum - total) <= tolerance) {
    const last = list[list.length - 1] + (total - sum);
    if (last >= MIN_SHOT_SECONDS && last <= MAX_SHOT_SECONDS) {
      list[list.length - 1] = last;
      return list;
    }
  }
  return fitDurations(total, shots.length);
}

/**
 * 把模型返回的镜头数与总时长对齐：
 * - 固定镜数（保证完整性）：多出来的镜头直接截掉，秒数照计划落地；
 * - 动态镜数：只夹上限，秒数尽量保留模型自己的分配。
 */
function applyDurationBudget(script: Script, budget: DurationBudget): void {
  const { durations, dynamic, total } = budget;
  // 单镜最少 2 秒，决定了这条总时长最多能分几镜
  const ceiling = clamp(Math.floor(total / MIN_SHOT_SECONDS), 1, MAX_SHOT_COUNT);
  const limit = durations && !dynamic ? Math.min(durations.length, ceiling) : ceiling;

  if (script.shots.length > limit) {
    script.shots = script.shots.slice(0, limit);
  }

  const targets =
    durations && script.shots.length === durations.length
      ? durations
      : dynamic
        ? reconcileDurations(script.shots, total)
        : fitDurations(total, script.shots.length);

  // fitDurations 在镜头过多时会把数组压短，多出来的镜头只能丢掉，总时长优先
  script.shots = script.shots.slice(0, targets.length);
  script.shots.forEach((shot, i) => {
    shot.index = i + 1;
    shot.duration = targets[i];
  });
}

/**
 * 按镜头数模式：用户期望的总时长 = 镜头数 × 单镜时长，
 * 把模型给出的偏差吸收到末尾镜头，前面的节奏尽量不动。
 */
function alignTotalDuration(script: Script, total: number): void {
  if (script.shots.length === 0) return;

  const target = clamp(
    Math.round(total),
    script.shots.length * MIN_SHOT_SECONDS,
    script.shots.length * MAX_SHOT_SECONDS,
  );
  let diff = target - script.shots.reduce((sum, shot) => sum + shot.duration, 0);
  if (diff === 0) return;

  for (let i = script.shots.length - 1; i >= 0 && diff !== 0; i -= 1) {
    const shot = script.shots[i];
    const next = Math.round(clamp(shot.duration + diff, MIN_SHOT_SECONDS, MAX_SHOT_SECONDS));
    diff -= next - shot.duration;
    shot.duration = next;
  }

  // 靠末尾镜头吸收不完（相差过大）时整体摊平
  if (diff !== 0) {
    const fitted = fitDurations(target, script.shots.length);
    script.shots = script.shots.slice(0, fitted.length);
    script.shots.forEach((shot, i) => (shot.duration = fitted[i]));
  }
}

/** 成稿后的统一收口：角色 / 场景卡、镜数、时长、引用全部对齐 */
function finalizeScript(
  script: Script,
  plan: StoryPlan | null,
  expectedShots: number,
  budget: DurationBudget | null,
  totalDuration: number,
): void {
  applyPlanFoundation(script, plan);

  if (script.shots.length > expectedShots) {
    script.shots = script.shots.slice(0, expectedShots);
  }
  script.shots.forEach((shot, i) => (shot.index = i + 1));

  if (budget) applyDurationBudget(script, budget);
  else alignTotalDuration(script, totalDuration);

  // 镜头时长被预算改过之后时间轴要跟着重算，否则「0~5 秒」对不上一个 3 秒的镜头
  script.shots.forEach((shot) => {
    if (shot.beatSheet) shot.beatSheet = normalizeBeatSheet(shot.beatSheet, shot.duration);
  });

  reconcileReferences(script, plan);
  stabilizeStateChain(script);
}

/**
 * 中 → 英提示词本地化：把每一镜已定稿的中文 description 单独翻成英文，
 * 带上角色 / 场景的固定英文短语与标准景别、运镜词。
 *
 * 分镜阶段也会写英文（作为回退稿），但「一边构思画面一边写英文」很容易写漂；
 * 让模型只做翻译，中英对不上的概率会低一个量级。
 */
async function localizeScriptPrompts(script: Script, plan: StoryPlan | null): Promise<Script> {
  if (!config.llm.localize || script.shots.length === 0) return script;

  const characters = (plan && plan.characters.length > 0 ? plan.characters : script.characters).map(
    (c) => ({ name: c.name, promptEn: c.promptEn || undefined }),
  );
  const scenes = (plan && plan.scenes.length > 0 ? plan.scenes : (script.scenes ?? [])).map((s) => ({
    name: s.name,
    promptEn: s.promptEn || undefined,
  }));

  const translated = await localizePrompts({
    shots: script.shots.map((shot) => ({
      index: shot.index,
      description: shot.description,
      shotSize: shot.shotSize,
      cameraMove: shot.cameraMove,
      characters: shot.characterNames ?? [],
      scenes: shot.sceneNames ?? [],
    })),
    characters,
    scenes,
    style: script.style,
  });

  if (!translated) return script;

  for (const shot of script.shots) {
    const next = translated.get(shot.index);
    if (next) shot.videoPrompt = next;
  }
  return script;
}

/** 把修复稿合并回原剧本：同镜数时保留原 id / 时长 / 素材，避免打断已有生成结果 */
function mergeRepairedShots(
  script: Script,
  rawShots: Record<string, unknown>[],
): Script | null {
  const shots = rawShots.map((raw, i) => normalizeShot(raw, i + 1));
  if (shots.length === 0) return null;

  if (shots.length === script.shots.length) {
    shots.forEach((shot, i) => {
      const prev = script.shots[i];
      shot.id = prev.id;
      shot.duration = prev.duration;
      shot.media = prev.media ?? [];
      if (prev.continueFromPrev !== undefined) {
        shot.continueFromPrev = prev.continueFromPrev;
      }
      // 修复稿漏写状态链 / 时间轴时继承原稿，别让一次修复把整条链清空
      if (!shot.entryState && prev.entryState) shot.entryState = prev.entryState;
      if (!shot.exitState && prev.exitState) shot.exitState = prev.exitState;
      if (!shot.beatSheet && prev.beatSheet) shot.beatSheet = prev.beatSheet;
    });
  }

  return { ...script, shots };
}

async function reviewAndRepair(
  script: Script,
  plan: StoryPlan | null,
  expectedShots: number,
  style: string,
): Promise<Script> {
  const issues = auditScript(script, { expectedShots });
  if (issues.length === 0) return script;

  if (!config.llm.review || !needsRepair(issues)) {
    // 剩下的都是可以确定性修掉的问题，没必要再花一次模型调用
    return script;
  }

  const repaired = await requestRepair({ script, plan, issues, expectedShots, style });
  if (!repaired) {
    void logAgentWarn('review', {
      reason: '审片修复失败，保留原稿',
      issues: summarizeIssues(issues),
    });
    return script;
  }

  // 修复稿镜数变了但不是因为「镜数不对」，说明模型只回了补丁而非完整剧本，不能整份替换
  const countIssue = issues.some((issue) => issue.code === 'shot-count');
  if (!countIssue && repaired.length !== script.shots.length) {
    void logAgentWarn('review', {
      reason: '修复稿镜数与要求不一致，保留原稿',
      expected: script.shots.length,
      received: repaired.length,
    });
    return script;
  }

  const merged = mergeRepairedShots(script, repaired);
  if (!merged) return script;

  return merged;
}

const summarizeIssues = (issues: ScriptIssue[]): string[] =>
  issues.slice(0, 8).map((issue) => `${issue.code}: ${issue.message}`);

/**
 * 请求分镜稿。模型偶尔只回一个空对象或片段，这时带着提示重试一次；
 * 网络 / 额度错误不在这里重试，避免超时时间翻倍。
 */
async function requestStoryboard(
  req: ScriptRequest,
  expectedShots: number,
  totalDuration: number,
  plan: StoryPlan | null,
  durations: number[] | null,
  style: string,
  userStyle?: string,
): Promise<Script> {
  const system = buildSystemPrompt();
  const user = buildUserPrompt(req, expectedShots, totalDuration, plan, durations);
  // 每镜多了秒级节奏，输出比以前长；预算跟随 LLM_MAX_TOKENS，被截断时 callChatJson 还会放大重试
  const budget = Math.max(config.llm.maxTokens, 6000);
  const first = await callChatJson({ system, user, temperature: 0.8, maxTokens: budget });

  try {
    return normalizeScript(first, style, userStyle);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/没有生成任何分镜|不是对象/.test(message)) throw err;

    void logAgentWarn('script', {
      reason: '分镜稿缺少 shots 数组，重试一次',
      expectedShots,
    });

    const retry = await callChatJson({
      system,
      user: `${user}\n\n注意：上一次输出没有 shots 数组，请重新输出完整的 JSON，不要只给片段。`,
      temperature: 0.7,
      maxTokens: budget,
    });
    return normalizeScript(retry, style, userStyle);
  }
}

export async function generateScript(req: ScriptRequest): Promise<ScriptResult> {
  if (!config.llm.apiKey) {
    throw new Error('未配置 LLM_API_KEY，请在 .env.local 中填写剧本生成模型的 Key');
  }

  const isNovel = req.source === 'novel';
  const mode: ScriptMode = req.mode === 'duration' ? 'duration' : 'shots';
  const style = req.style || '电影感写实';

  /** 总时长模式的拆解结果；null 表示「按镜头数量」或「小说自动决定」 */
  let budget: DurationBudget | null = null;
  let totalDuration = 0;
  let plannedShotCount: number | null = null;

  /**
   * 小说模式不预设镜头数、单镜时长和总时长：
   * 全部由改编蓝图按剧情决定，用户不需要也不会在表单里看到这些旋钮。
   */
  if (!isNovel) {
    if (mode === 'duration') {
      const split = splitByDuration(
        req.duration ?? MAX_SHOT_SECONDS,
        req.ensureCompleteness !== false,
      );
      totalDuration = split.total;
      plannedShotCount = split.dynamic ? null : split.shotCount;
      budget = {
        split,
        dynamic: split.dynamic,
        shotCount: plannedShotCount,
        durations: split.dynamic ? null : split.durations,
        total: split.total,
      };
    } else {
      plannedShotCount = clamp(Math.round(req.shotCount ?? 6), 1, MAX_SHOT_COUNT);
      // 上限对齐 wan3.0 单镜 30 秒 × 最多 12 镜
      totalDuration = clamp(
        Math.round(req.duration ?? plannedShotCount * 5),
        5,
        MAX_SHOT_SECONDS * MAX_SHOT_COUNT,
      );
    }
  }

  /** 动态模式不给固定镜数，只给合法区间 */
  const shotRange =
    budget?.dynamic && budget.split
      ? { min: budget.split.minShotCount, max: budget.split.maxShotCount }
      : undefined;

  // 第一步：小说先压缩成蓝图；短创意直接由故事架构师规划
  let plan: StoryPlan | null = null;
  let adaptedIdea: string | undefined;
  let writingReq = req;
  /** 每一镜的目标时长：小说由蓝图给，其余模式由预算给 */
  let timingDurations: number[] | null = null;

  if (isNovel) {
    const adapted = await adaptStory({
      text: req.idea,
      idea: req.idea.slice(0, 200),
      style,
      // 不传 shotCount / shotRange / totalDuration：让剧本模型自己决定
    });

    // 长文改编失败时不能悄悄退回「把整章当创意」，否则只会生成一份更差的稿
    if (!adapted) {
      throw new Error('小说改编失败：模型没有返回可用的故事蓝图，请缩短原文或稍后重试');
    }

    plan = adapted.plan;
    adaptedIdea = adapted.treatment;
    writingReq = { ...req, idea: adapted.treatment, mode: 'duration' };

    timingDurations = plan.beats.map((beat) => beat.duration ?? 5);
    totalDuration = timingDurations.reduce((sum, duration) => sum + duration, 0);
  } else {
    plan = await planStory({
      idea: req.idea,
      style,
      shotCount: plannedShotCount ?? undefined,
      shotRange,
      totalDuration,
    });

    if (!plan) {
      // 规划环节失败不会中断生成，但连贯性会回退到「一次性生成」，需要留痕
      void logAgentWarn('plan', {
        reason: '蓝图规划失败，已降级为直接生成分镜',
        idea: req.idea.slice(0, 80),
        shotCount:
          plannedShotCount ?? `${budget?.split.minShotCount}~${budget?.split.maxShotCount}`,
        totalDuration,
      });
    }
  }

  /** 动态模式下降级时没有蓝图，用最少镜数兜底（每镜尽量 10 秒，总时长不会缩水） */
  const fallbackShots = plannedShotCount ?? budget?.split.minShotCount ?? 6;
  /** 用户要求的镜数优先；动态模式 / 小说模式由蓝图的节拍数决定 */
  const expectedShots = isNovel
    ? (plan?.beats.length ?? fallbackShots)
    : (plannedShotCount ?? (plan ? plan.beats.length : fallbackShots));

  // 非小说模式：动态时长由蓝图分配；固定模式直接沿用算好的分配
  if (budget && budget.dynamic && plan) {
    budget.durations = beatDurations(plan.beats, budget.total);
  }
  if (!isNovel) timingDurations = budget?.durations ?? null;

  // 第二步：分镜 agent 照着蓝图写画面与提示词（小说模式下用压缩后的梗概，而不是原文）
  let script = await requestStoryboard(
    writingReq,
    expectedShots,
    totalDuration,
    plan,
    timingDurations,
    style,
    req.style,
  );
  finalizeScript(script, plan, expectedShots, budget, totalDuration);

  // 第三步：中文定稿后单独翻英文提示词，保证英文严格对应中文
  script = await localizeScriptPrompts(script, plan);

  // 第四步：审片。有硬伤时让模型修一次，仍然失败就保留原稿，不让生成失败
  script = await reviewAndRepair(script, plan, expectedShots, style);

  // 修复稿可能改了镜数 / 引用，重新收口一次
  finalizeScript(script, plan, expectedShots, budget, totalDuration);

  const remaining = auditScript(script, { expectedShots });
  if (remaining.length > 0) {
    void logAgentWarn('review', {
      reason: '成稿仍存在可接受的问题',
      issues: summarizeIssues(remaining),
    });
  }

  return { script, adaptedIdea };
}
