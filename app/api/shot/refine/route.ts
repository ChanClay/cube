import { NextResponse } from 'next/server';
import { config } from '@/lib/config';
import { logAgentWarn } from '@/lib/services/logger';
import { callChatJson } from '@/lib/agents/llm';
import type { BackgroundCast, NarrationType } from '@/lib/types';
import {
  BACKGROUND_CAST_RULES,
  DIALOGUE_RULES,
  normalizeBeatSheet,
  normalizeCameraMove,
  normalizeNarrationType,
  normalizeShotSize,
  SHOT_LANGUAGE_RULES,
  SPEAKER_SHOT_RULES,
  str,
  TIMELINE_RULES,
  trimNarration,
  VIDEO_PROMPT_RULES,
} from '@/lib/skills/spec';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

function buildSystemPrompt(): string {
  return `你是一位资深 AI 分镜师。用户已经手动改写了某个镜头的「画面描述」，你需要据此重新产出这一镜的结构化分镜信息。

要求：
1. ${VIDEO_PROMPT_RULES}
2. videoPrompt 的唯一依据是用户改好的「画面描述」：描述里写到的主体、动作、道具、环境、光线逐项翻进英文；描述里没有的元素一个都不许加。
2.1 台词不是画面描述的派生物，是用户已经定稿的事实：若提供了「当前台词」，narration / narrationType / speaker 必须原样返回，一个字都不许改；只有用户明确要求删掉或换掉台词时才能改。绝不许因为「画面描述里没写台词」就清空它——台词本来就不该出现在画面描述里。
2.2 背景人群同理：若提供了「当前背景人群」，backgroundCast 必须原样返回，人数、装扮与 promptEn 都不许改；只有画面描述明确写了人群变化（涌入 / 散去 / 倒下）时才跟着改。人群全部退场时返回 crowdCleared: true（空数组不算退场，会被上一镜的人群覆盖）。绝不许把一群人缩成主角一个人。
3. description 不需要你重写（用户已经改好），不要返回它。
4. ${SHOT_LANGUAGE_RULES}
5. 若提供了主体卡（人物 / 载具 / 关键道具），本镜出镜主体的外貌必须与卡片一致；视频提示词里沿用卡片已有的英文固定短语，不要自行改写年龄、发型、服装、装甲与涂装、车型与车漆、道具。
6. 若提供了相邻镜头，本镜的动作要能接住上一镜、并给下一镜留出衔接空间；运动方向要与相邻镜头一致（上一镜朝画右，本镜不要朝画左），并让本镜最后一拍停在可辨认的动作相位上（主体仍在画面内）。避免与相邻镜头重复同一构图。若给出了「上一镜末帧里实际在场的人物」，本镜开头的人物必须与这份名单完全一致，不许增删；需要新角色出场时，写成在这一镜的过程里走进画面，而不是一开始就站在那里。
6.1 本镜出现的每一辆车（主角座驾、追车、警车…）都要按卡片写进提示词，并复用它的固定英文短语；漏一辆，这辆车在这一镜里就会变成另一辆。
6.2 本镜的地点由「本镜所在场景」决定：英文提示词里的空间短语必须来自该场景卡，不许改写成别的场景的地点，也不许把画面带回片头场景。本镜没标场景时，按上一镜的场景承接；两者都没有时，只写画面描述里出现的地点。
6.3 本镜用到的家具与桌上物件必须来自该场景卡的「固定陈设」清单，名字与位置照着清单写；清单里没有的物件不要凭空加，也不要自行改动物件的左右关系。
6.4 两人以上同框、或人物在画面里会位移时，写 blocking（中文走位）与 blockingEn（8~18 词英文）：谁站在空间的哪一侧、面朝哪里、彼此距离。参考系只能用场景卡的固定件（相对门窗 / 桌子哪一端），不许写「画面左侧 / 右侧」——换机位就翻面。走位要与相邻镜头一致；单人镜头可以留空。
7. narration 是这一镜唯一的说话人所说的一句台词，或一句画外旁白（不要写"旁白："前缀）。只有在没有提供「当前台词」、并且这一镜确实没有人开口时才留空。一镜只能有一个说话人，严禁把两个人的对白写进同一镜——要换人开口就换镜。
8. 若是画面里的角色开口说话，speaker 必须是角色表里的名字且只有一个；旁白或没有台词时 speaker 留空。给了「当前台词」时 speaker 沿用原值。
8.0 ${BACKGROUND_CAST_RULES}
8.1 ${DIALOGUE_RULES}
8.2 ${SPEAKER_SHOT_RULES}
9. title 是这一镜的小标题，4~8 个字。
10. ${TIMELINE_RULES}
11. 只输出一个 JSON 对象，不要解释文字、不要 markdown 代码块。

JSON 结构：
{
  "title": "镜头小标题",
  "shotSize": "中景",
  "cameraMove": "缓慢推近",
  "videoPrompt": "English prompt for the text-to-video model",
  "narration": "旁白或台词（有当前台词时必须原样照抄）",
  "narrationType": "dialogue（画面里的人物开口）| voiceover（画外旁白，人不开口）| none（无口播）",
  "speaker": "说话的角色名，旁白留空",
  "backgroundCast": [{ "desc": "没有主体卡的背景人群构成与数量；有当前人群时原样照抄", "promptEn": "eight armored soldiers in dark lamellar armor" }],
  "crowdCleared": "true / false：本镜人群是否明确退场（清空继承来的人群）；空数组不算退场",
  "blocking": "本镜人物走位：谁在空间的哪一侧、面朝哪里（参考门窗 / 固定件，不写「画面左侧」）；单人镜头可留空",
  "blockingEn": "8-18 words English blocking phrase appended to the video prompt; may be empty for a single character",
  "beatSheet": [{ "from": 0, "to": 2, "action": "这一段里发生的可见动作", "actionEn": "8-14 words of the same action in English" }]
}`;
}

function buildUserPrompt(input: {
  description: string;
  title: string;
  style: string;
  motionProfile: string;
  duration: number;
  before: string;
  after: string;
  prevCast: string[];
  prevBackgroundCast: BackgroundCast[];
  prevExitState: string;
  /** 本镜已定稿的台词 / 类型 / 说话人：默认原样保留，不参与重算 */
  narration: string;
  narrationType?: NarrationType;
  speaker: string;
  /** 本镜当前的背景人群：默认原样保留 */
  backgroundCast: BackgroundCast[];
  /** 本镜人群是否已经明确退场（退场后不再拿上一镜的人群兜底） */
  crowdCleared: boolean;
  characters: { name: string; desc: string }[];
  scenes: {
    name: string;
    desc: string;
    promptEn?: string;
    inventory?: { name: string; en?: string; where?: string; whereEn?: string; fixed?: boolean }[];
    state?: string;
  }[];
  sceneNames: string[];
  prevSceneName: string;
}): string {
  const lines = [
    `整体视觉风格：${input.style || '电影感写实'}`,
    `镜头时长：${input.duration} 秒`,
    `当前小标题：${input.title || '（未命名）'}`,
  ];

  // 全片运动基调：这一镜只是其中一帧，特写也必须保留整场戏的速度感
  if (input.motionProfile) {
    lines.push(`全片运动基调（本镜的 videoPrompt 必须体现，特写也不例外）：${input.motionProfile}`);
  }

  if (input.characters.length > 0) {
    lines.push('', '主体卡（出镜人物 / 载具外形必须与此一致）：');
    for (const character of input.characters) {
      lines.push(`- ${character.name}：${character.desc}`);
    }
  }

  if (input.scenes.length > 0) {
    lines.push('', '场景卡（空间设定必须与此一致，英文空间短语逐字复用）：');
    for (const scene of input.scenes) {
      const en = scene.promptEn ? `｜英文空间：${scene.promptEn}` : '';
      const state = scene.state ? `｜状态：${scene.state}` : '';
      lines.push(`- ${scene.name}：${scene.desc}${state}${en}`);
      if (scene.inventory?.length) {
        const items = scene.inventory
          .map((item) => {
            const parts = [item.name];
            if (item.en) parts.push(item.en);
            // 位置优先给英文版：重算出的提示词要能直接用，中文位置只当读者的注释
            const where = item.whereEn ?? item.where;
            if (where) parts.push(where);
            if (item.fixed === false) parts.push('可移动');
            return parts.join(' / ');
          })
          .join('；');
        lines.push(`  固定陈设（只能用这些物件，位置不许改）：${items}`);
      }
    }
  }

  /**
   * 本镜地点由「场景归属」决定，不是由模型自由发挥：
   * 没标注时才拿上一镜的场景承接，绝不允许退回片头场景。
   */
  const sceneLine =
    input.sceneNames.length > 0
      ? input.sceneNames.join('、')
      : input.prevSceneName
        ? `${input.prevSceneName}（本镜未标注，按上一镜的场景承接）`
        : '（未标注，也没有上一镜可承接：只写画面描述里出现的地点，不要回到片头场景）';
  lines.push('', `本镜所在场景：${sceneLine}`);

  /**
   * 台词与人群是「已定稿的事实」，不是这次要重算的东西。
   *
   * 以前这里只给画面描述：模型看不到旧台词，又收到「描述里没有的元素不许加」，
   * 最省事且合规的输出就是清空 narration——用户只改画面，人物却突然不说话了。
   */
  if (input.narration.trim()) {
    lines.push(
      '',
      `当前台词（用户未要求改动，必须原样返回）：${input.narration}`,
      `台词类型：${input.narrationType ?? 'voiceover'}${input.speaker ? `｜说话人：${input.speaker}` : ''}`,
      '台词本来就不写在画面描述里：描述里没有这句台词，不代表要删掉它。除非用户明确要求删改，否则 narration / narrationType / speaker 逐字照抄。',
    );
  }

  if (input.backgroundCast.length > 0) {
    lines.push(
      '',
      '当前背景人群（没有主体卡的人，必须原样保留）：',
      ...input.backgroundCast.map((item) => `- ${item.desc}｜英文固定短语：${item.promptEn}`),
      '人群是画面事实：不许把一群人缩成主角一个人，也不许换装扮与人数；只有画面描述明确写了人群变化时才改，人群全部退场时返回 crowdCleared: true。',
    );
  } else if (!input.crowdCleared && input.prevBackgroundCast.length > 0) {
    lines.push(
      '',
      `上一镜结尾的背景人群（本镜没有写人群退场，开头必须还是这一群人）：` +
        input.prevBackgroundCast.map((item) => `${item.desc}（${item.promptEn}）`).join('；'),
    );
  }

  lines.push('', '修改后的画面描述（必须严格照此生成）：', input.description);

  if (input.before) lines.push('', `上一镜的画面描述（用于承接）：${input.before}`);

  /**
   * 末帧是像素，只给「画面描述」模型并不知道图里站的是谁，于是会凭空多出
   * 名单以外的人。这里把名单当成硬事实喂进去，并说明它会作为参考图一起提交。
   */
  if (input.prevCast.length > 0) {
    lines.push(
      '',
      `上一镜末帧里实际在场的人物：${input.prevCast.join('、')}`,
      '本镜会带上这张末帧作为参考图。提示词里指代这些人时必须使用上面的名字；' +
        '这份名单就是本镜开头画面里允许出现的人物，不许增删——需要新角色时写成在这一镜过程中进入画面。',
    );
  }
  if (input.prevExitState) {
    lines.push(`上一镜的结尾状态（本镜从这里接着演）：${input.prevExitState}`);
  }

  if (input.after) lines.push('', `下一镜的画面描述（用于衔接）：${input.after}`);

  lines.push('', '请输出这一镜的分镜信息 JSON。');
  return lines.join('\n');
}

/** 角色表：只取名字与外形，空名字丢弃 */
function parseCharacters(raw: unknown): { name: string; desc: string }[] {
  if (!Array.isArray(raw)) return [];
  const result: { name: string; desc: string }[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const name = str(record.name);
    if (!name) continue;
    result.push({ name, desc: str(record.desc) });
    if (result.length >= 8) break;
  }
  return result;
}

/** 陈设清单：重算分镜时只能用清单里的物件，否则每一镜都会重新摆一次家具 */
function parseInventory(raw: unknown): { name: string; en?: string; where?: string; whereEn?: string; fixed?: boolean }[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const items: { name: string; en?: string; where?: string; whereEn?: string; fixed?: boolean }[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const name = str(record.name);
    if (!name) continue;
    items.push({
      name,
      en: str(record.en) || undefined,
      where: str(record.where) || undefined,
      whereEn: str(record.whereEn) || undefined,
      fixed: typeof record.fixed === 'boolean' ? record.fixed : undefined,
    });
    if (items.length >= 12) break;
  }
  return items.length > 0 ? items : undefined;
}

/** 场景表：名字 + 中文空间描述 + 固定英文短语 + 陈设清单（重算时逐字复用，不重新措辞） */
function parseScenes(raw: unknown): {
  name: string;
  desc: string;
  promptEn?: string;
  inventory?: { name: string; en?: string; where?: string; whereEn?: string; fixed?: boolean }[];
  state?: string;
}[] {
  if (!Array.isArray(raw)) return [];
  const result: ReturnType<typeof parseScenes> = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const name = str(record.name);
    if (!name) continue;
    result.push({
      name,
      desc: str(record.desc),
      promptEn: str(record.promptEn) || undefined,
      inventory: parseInventory(record.inventory),
      state: str(record.state) || undefined,
    });
    if (result.length >= 8) break;
  }
  return result;
}

/** 末帧在场人物：只取非空名字 */
function parseCast(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => str(item)).filter(Boolean).slice(0, 8);
}

/** 背景人群：只认有内容的两项，最多 4 组；退场由 crowdCleared 表达，空数组不算 */
function parseBackgroundCast(raw: unknown): BackgroundCast[] {
  if (!Array.isArray(raw)) return [];
  const result: BackgroundCast[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const desc = str(record.desc ?? record.name);
    const promptEn = str(record.promptEn ?? record.en);
    if (!desc && !promptEn) continue;
    result.push({ desc: desc || promptEn, promptEn: promptEn || desc });
    if (result.length >= 4) break;
  }
  return result;
}

function parseNarrationType(raw: unknown): NarrationType | undefined {
  return raw === 'dialogue' || raw === 'voiceover' || raw === 'none' ? raw : undefined;
}

/**
 * 台词类型：用户已有的 none 必须守住。
 *
 * `none` 的语义是「台词保留但不提交」，如果按「有台词就归成 voiceover」处理，
 * 一次重算就会让本该静音的镜头突然念出来。
 */
function resolveNarrationType(requested: NarrationType | undefined, narration: string): NarrationType {
  if (requested === 'none') return 'none';
  return normalizeNarrationType(requested, narration);
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: '请求体必须是合法 JSON' }, { status: 400 });
  }

  const payload = (body ?? {}) as Record<string, unknown>;
  const description = str(payload.description);
  if (description.length < 2) {
    return NextResponse.json({ error: '请先填写画面描述' }, { status: 400 });
  }

  const durationRaw = Number(payload.duration);
  const input = {
    description,
    title: str(payload.title),
    style: str(payload.style, '电影感写实'),
    motionProfile: str(payload.motionProfile),
    duration: Number.isFinite(durationRaw) && durationRaw > 0 ? durationRaw : 5,
    before: str(payload.before),
    after: str(payload.after),
    prevCast: parseCast(payload.prevCast),
    prevBackgroundCast: parseBackgroundCast(payload.prevBackgroundCast),
    prevExitState: str(payload.prevExitState),
    narration: str(payload.narration),
    narrationType: parseNarrationType(payload.narrationType),
    speaker: str(payload.speaker),
    backgroundCast: parseBackgroundCast(payload.backgroundCast),
    crowdCleared: payload.crowdCleared === true,
    characters: parseCharacters(payload.characters),
    scenes: parseScenes(payload.scenes),
    sceneNames: parseCast(payload.sceneNames),
    prevSceneName: str(payload.prevSceneName),
  };

  try {
    const raw = await callChatJson({
      system: buildSystemPrompt(),
      user: buildUserPrompt(input),
      temperature: 0.7,
      // 思考型模型的 reasoning 也占 max_tokens，这里不要卡小预算
      maxTokens: config.llm.maxTokens,
      timeoutMs: Math.min(config.llm.timeoutMs, 90_000),
    });

    const obj = (raw ?? {}) as Record<string, unknown>;
    const videoPrompt = str(obj.videoPrompt);

    if (!videoPrompt) {
      return NextResponse.json({ error: '模型没有返回视频提示词，请重试' }, { status: 502 });
    }

    /**
     * 台词兜底：模型没写台词、而用户原本有台词时，保留原文。
     *
     * 这是「改画面描述导致人物突然不说话」的最后一道闸：提示词已经要求原样返回，
     * 但模型仍可能因为「描述里没写」而吐出空串，空串绝不能覆盖已定稿的台词。
     */
    const modelNarration = trimNarration(obj.narration, input.duration);
    const keepExisting = !modelNarration.trim() && !!input.narration.trim();
    const narration = keepExisting
      ? trimNarration(input.narration, input.duration)
      : modelNarration;
    const narrationType = resolveNarrationType(
      keepExisting ? input.narrationType : (parseNarrationType(obj.narrationType) ?? input.narrationType),
      narration,
    );
    /**
     * 人群同理：模型没给出人群时沿用原值，绝不允许「没写」把一群人清掉。
     * 退场只能由 crowdCleared 明确表达——空数组是模型的默认值，不能当成「人散了」。
     */
    const modelCrowd = parseBackgroundCast(obj.backgroundCast);
    const crowdCleared =
      obj.crowdCleared === true || (input.crowdCleared && modelCrowd.length === 0);
    const backgroundCast = crowdCleared
      ? []
      : modelCrowd.length > 0
        ? modelCrowd
        : input.backgroundCast.length > 0
          ? input.backgroundCast
          : input.prevBackgroundCast;

    return NextResponse.json({
      shot: {
        title: str(obj.title),
        shotSize: normalizeShotSize(obj.shotSize),
        cameraMove: normalizeCameraMove(obj.cameraMove),
        videoPrompt,
        narration,
        narrationType,
        speaker: narrationType === 'dialogue' ? str(obj.speaker) || input.speaker || undefined : undefined,
        backgroundCast,
        crowdCleared: crowdCleared || undefined,
        blocking: str(obj.blocking ?? obj.staging) || undefined,
        blockingEn: str(obj.blockingEn ?? obj.stagingEn) || undefined,
        beatSheet: normalizeBeatSheet(obj.beatSheet, input.duration),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    void logAgentWarn('script', {
      reason: '重新生成分镜信息失败',
      description: description.slice(0, 80),
      error: message,
    });
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
