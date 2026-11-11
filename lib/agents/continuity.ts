import {
  MAX_SHOT_COUNT,
  MAX_SHOT_SECONDS,
  MIN_SHOT_COUNT,
  MIN_SHOT_SECONDS,
} from '@/lib/shot-plan';
import { logAgentWarn } from '@/lib/logger';
import { expandStyle } from '@/lib/style-presets';
import type { ShotTransition } from '@/lib/types';
import {
  clamp,
  dedupeByName,
  normalizeCameraMove,
  normalizeShotSize,
  normalizeTransition,
  str,
} from './spec';
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
  /**
   * 这一镜怎么交到下一镜，决定下一镜能不能抽这一镜的末帧当首帧。
   * 见 ShotTransition：same-take / hard-cut / time-jump。
   */
  transition: ShotTransition;
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
  code:
    | 'shot-count'
    | 'incomplete-beat'
    | 'no-character'
    | 'no-scene'
    | 'off-model-character';
  message: string;
  blocking: boolean;
}

/** 题材里出现这些词，说明主角是机械 / 非人主体，角色卡不能套人类模板 */
const MACHINE_SUBJECT =
  /(机甲|机器人|机械体|机械巨|装甲巨|巨型装甲|机兵|战甲|飞船|战舰|坦克|巨兽|怪兽|恐龙|无人机)/;
/** 机体特征词：desc 里写了这些，说明这一张确实是按机体写的 */
const MACHINE_DESC =
  /(机甲|机体|机型|装甲|涂装|传感器|目镜|液压|伺服|关节|推进器|喷口|炮管|炮口|履带|线缆|编号|合金|碳纤维|陶瓷|金属)/;
/**
 * 人类专属特征：出现在机体卡里说明把机体写成了人。
 * 只收「年龄 + 发型 + 服装」，避免误伤「驾驶员 32 岁」这类正常人类卡。
 */
const HUMAN_ONLY_DESC =
  /(\d{1,3}\s*岁|[一二三四五六七八九十百]{1,3}十?\s*岁|发色|短发|长发|马尾|辫子|衬衫|T恤|夹克|外套|牛仔裤|工装裤|短靴|皮鞋|连衣裙)/;
/** 人类角色 / 乘员的标识：这样的卡本来就该按人类写，不参与上面的检查 */
const HUMAN_CREW = /(驾驶员|机师|操作员|乘员|飞行员|舰长|船长|驾驶舱|地面引导|人类)/;

/**
 * 机甲 / 机械题材里把机体写成「三十岁男性」是最常见的跑偏：
 * desc 既没有任何机体特征，又带着年龄 / 发型 / 服装，命中就带着问题清单重试一次。
 */
function humanizedMachine(idea: string, character: PlanCharacter): boolean {
  if (!MACHINE_SUBJECT.test(idea)) return false;
  if (!character.desc.trim()) return false;
  if (HUMAN_CREW.test(`${character.role ?? ''} ${character.name} ${character.desc}`)) return false;
  if (MACHINE_DESC.test(character.desc)) return false;
  return HUMAN_ONLY_DESC.test(character.desc);
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
5. 角色 2~4 个：role 写叙事功能。
   写 desc 之前先判断这个角色的主体类型；不判断类型就直接套人类模板，会把机甲、机器人、巨兽、载具写成「三十岁男人」。每项都要具体到「能照着画出来」，不许用「高科技感」「未来感的衣服」这类空话。
   【A 人类 / 类人】按 8 项顺序写全：
   ① 廓形：性别、年龄感、身高体型、体态；
   ② 头部：脸型 + 肤色（或材质）、眉眼神态、发型（长度 / 走向 / 质地）+ 发色；
   ③ 上装：版型 + 颜色 + 面料或材质 + 磨损与细节；
   ④ 下装与鞋：版型 + 颜色 + 材质；
   ⑤ 装备 / 义体 / 机械部件：位置 + 形态 + 材质 + 运行状态（例：「左前臂是拉丝钛义体，接缝有冷蓝色发光细线，指关节可见液压结构」）；
   ⑥ 配色：主色 / 辅色 / 发光色 + 色温；
   ⑦ 随身道具；
   ⑧ 气质与体态特征（站姿、视线习惯、手部小动作）。
   【B 机械体 / 机甲 / 机器人 / 载具 / 巨型生物】禁止出现年龄、性别、发型发色、上装下装、鞋——这些字段对它没有意义，写进去就是把它写成了人。按 8 项顺序写：
   ① 机型与体量：型号或代号、高度（按米计）、头身比例、整体轮廓（人形重装 / 四足 / 流线型 / 兽形 / 履带式）；
   ② 头部：头部件形态、面罩或目镜 / 传感器阵列（数量与排列）、天线或角；
   ③ 装甲：主装甲板形状 + 材质（轧制钢板 / 陶瓷复合装甲 / 拉丝钛 / 碳纤维板）+ 分件接缝 + 涂装 + 战损与污渍；
   ④ 关节与肢体：液压缸 / 伺服电机 / 线缆走线、手掌与足部形态；
   ⑤ 武器 / 装备：位置 + 形态 + 材质 + 运行状态（炮管、能量导管、推进器喷口、发光部位）；
   ⑥ 配色：主色 / 辅色 + 发光色与发光部位 + 色温；
   ⑦ 标识与编号（喷印在哪个部位）；
   ⑧ 动作特征（站姿、行走时的机械节奏、攻击前的预备动作）。
   题材里出现机甲 / 机器人 / 机械巨兽 / 飞船 / 装甲载具等非人主体时，这些主角必须按 B 写；驾驶员、乘客等人类角色按 A 写，并与机体分成两张卡，不许把人类特征混进机体描述。
   科幻 / 未来科技题材的装备必须写到具体技术名词与材质（拉丝钛、哑光碳纤维、半透明聚合物、液态金属、陶瓷装甲、全息喷绘、能量导管等），并写清分件与光源位置。
   promptEn 写 20~35 个单词的固定英文外貌短语，与 desc 同序覆盖同样的可见项：人类写「主体 + 年龄感 + 头面部 + 服装 + 装备 + 配色 + 道具」；机械体写「主体 + 机型体量 + 头部传感器 + 装甲材质与涂装 + 关节结构 + 武器 + 配色」，不要给机械体写年龄词与服装词。desc 里每个可见项都要在英文里有对应词。全片一字不改地复用。
6. 场景 1~4 个：desc 写地点、空间尺度、时间、光源方向与色温、主要陈设与其材质；promptEn 写 15~25 个单词的固定英文空间短语，覆盖空间类型 + 关键陈设 + 光源与色调。同一个空间只写一次，不要按镜头重复。

【串联层】
7. entry 写这一镜开始时「谁 / 在哪 / 什么姿势 / 手里拿着什么」（第一镜写「开场」）。上一镜 transition=same-take 时必须与它的 exit 是同一个画面事实；hard-cut / time-jump 允许换机位，但人物、场景、光线必须与上一镜一致——换机位不换世界。
8. exit 必须是一个可以直接拍出来的画面状态：谁、在哪里、什么姿势、朝向哪里、手里拿着什么。不要写情绪或抽象概念。
9. transition=same-take 的两镜，action 必须首尾相接：上一镜没做完的动作，下一镜接着做完；hard-cut / time-jump 允许动作跳，但不许人物凭空换位、道具凭空出现。
10. 空间连续：全片尽量在同一个空间内完成，开场用大远景 / 全景把空间关系交代清楚。每一镜都必须写 transition，说明这一镜怎么交到下一镜，只能取三个值：
    - same-take：同一个连续动作被切成两镜，下一镜从这一镜的最后一帧原样继续，景别与机位都不许变。全片连续出现不得超过 2 次——每接一次画面都会掉一点细节，接多了人物就漂了。
    - hard-cut：换景别 / 换角度 / 正反打。下一镜是新的机位，观众本来就不期待画面接住。绝大多数镜头都应该是这个。
    - time-jump：时间或地点跳转（次日、片刻后、换场地）。
    判断标准只有一句：摄影机有没有停机。还在同一次拍摄里就是 same-take，停机换了机位就是 hard-cut。
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
    {
      "name": "人类角色名",
      "role": "叙事功能",
      "desc": "【A 人类】① 廓形：三十岁男性，高瘦，肩背微驼；② 头部：窄长脸，苍白偏青的肤色，短发剃到耳上，发根有接驳插口；③ 上装：哑光碳纤维高领外套，胸口有陶瓷装甲分件，肘部织物磨白；④ 下装与鞋：灰黑工装裤，磁吸扣短靴；⑤ 装备 / 义体：左前臂拉丝钛义体，接缝处冷蓝发光细线，指关节可见液压结构；⑥ 配色：主色石墨灰，辅色氧化橙，发光色冷蓝，色温偏冷；⑦ 道具：腕部全息终端；⑧ 气质：站姿笔直，说话前习惯用拇指摩挲义体接缝",
      "promptEn": "30-words fixed English appearance phrase in the same order as desc"
    },
    {
      "name": "机体代号",
      "role": "对手",
      "desc": "【B 机械体】① 机型与体量：代号「熔核」，人形重装机体，全高 42 米，肩宽接近身高一半；② 头部：楔形面罩后一枚广角单眼传感器，头顶两根短天线；③ 装甲：轧制钢板外套陶瓷复合装甲，板缝露出黄黑警示条，胸甲有熔穿战损；④ 关节与肢体：外露的液压缸与粗线缆，三指机械手，足部为爪式支撑；⑤ 武器 / 装备：右臂 30 毫米转管炮，背部双推进器喷口有余温红光；⑥ 配色：主色锈红，辅色黑铁，发光色熔橙，色温偏暖；⑦ 标识：左肩喷白色编号 K-09；⑧ 动作：站姿前倾，开炮前右肩先下沉",
      "promptEn": "35-words fixed English appearance phrase in the same order as desc, no age or clothing words"
    }
  ],
  "scenes": [
    {
      "name": "场景名",
      "desc": "地点 / 空间尺度 / 时间 / 光源方向与色温 / 主要陈设与材质",
      "promptEn": "15~25 words fixed English location phrase"
    }
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
      "transition": "same-take | hard-cut | time-jump"
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
    transition: normalizeTransition(raw.transition),
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

  // 机甲 / 巨兽题材被写成人类：带着具体清单重试，别让错的主体直接进角色卡
  const humanized = characters.filter((c) => humanizedMachine(req.idea, c));
  if (humanized.length > 0) {
    problems.push({
      code: 'off-model-character',
      message:
        `角色 ${humanized.map((c) => `「${c.name}」`).join('、')} 在本片的机械 / 非人题材里被写成了人类` +
        '（出现年龄、发型或服装，且没有任何机体特征）；必须按机械体重写：机型与体量、头部传感器、装甲材质与涂装、关节液压、武器、配色与编号，不要写年龄、发型、上衣与鞋',
      blocking: true,
    });
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
