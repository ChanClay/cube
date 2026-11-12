import {
  MAX_SHOT_COUNT,
  MIN_SHOT_COUNT,
  shotLimits,
  type ShotLimits,
} from '@/lib/skills/shot-plan';
import { logAgentWarn } from '@/lib/services/logger';
import { expandStyle } from '@/lib/skills/style-presets';
import type { CharacterSubject, ShotTransition } from '@/lib/types';
import {
  APPEARANCE_ONLY_RULES,
  clamp,
  CUT_POINT_RULES,
  dedupeByName,
  MOTION_SCOPE_RULES,
  normalizeCameraMove,
  normalizeShotSize,
  normalizeTransition,
  SITUATION_HINT,
  str,
  stripScopedMotion,
  SUBJECT_CARD_RULES,
} from '@/lib/skills/spec';
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
  /** 可拍摄的中文外形描述：只写恒定外观，不写这一镜的姿势 / 场景 */
  desc: string;
  /** 主体类型：决定角色卡的构图画幅，不能靠 desc 里的关键词猜 */
  subjectType?: CharacterSubject;
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

/**
 * 这一镜的对白设计（不是台词原文）。
 *
 * 台词必须在蓝图阶段就被设计：谁开口、想达成什么、为什么不明说、说完之后局面怎么变。
 * 缺这一层，分镜阶段只能就着剧情「编一句话」，出来的就是念设定、复述画面的说明书。
 * 一镜只有一个 speaker——两个人开口就是两个节拍、两个镜头。
 */
export interface BeatDialogue {
  /** 这一镜唯一开口的人，必须逐字来自主体卡 */
  speaker: string;
  /** 这句话要达成什么：说服 / 试探 / 拒绝 / 威胁 / 拖延 / 摊牌 */
  intent: string;
  /** 潜台词：嘴上说的与心里要的不是同一件事 */
  subtext?: string;
  /** 对方听到之后的变化（让步 / 反击 / 沉默 / 动作停下），必须有可见结果 */
  effect?: string;
  /** 听者是谁（决定反打镜头里该出现谁） */
  listener?: string;
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
  /** 这一镜的对白设计；没有人开口时为空（让观众看画面，而不是听解释） */
  dialogue?: BeatDialogue;
  /** 承接上一镜的什么状态；第一镜写「开场」 */
  entry: string;
  /** 结束时留下的状态，必须能被下一镜直接接住 */
  exit: string;
  shotSize: string;
  cameraMove: string;
  /**
   * 这一镜怎么交到下一镜，决定下一镜能不能抽这一镜的末帧当首帧。
   * 见 ShotTransition：same-take / hard-cut / time-jump。
   * 首帧要求本镜第 0 帧等于上一镜最后一帧，只有摄影机没停机的 same-take 成立，
   * 所以它的景别不许变；换了景别的 hard-cut 只能走卡片重新构图。
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
  /** 全片运动基调：整片是持续运动还是静止，运动来自哪里 */
  motion: string;
  /** 运动基调的英文短句（≤18 词），运行时逐镜提交 */
  motionEn?: string;
  characters: PlanCharacter[];
  scenes: PlanScene[];
  beats: Beat[];
}

export interface PlanRequest {
  idea: string;
  style?: string;
  /** 固定镜头数（按镜头数量模式） */
  shotCount?: number;
  /**
   * 动态模式：不给固定镜数，只给合法区间，由模型按剧情自己决定切几刀。
   * 此时模型还要为每一镜分配时长，总和等于 totalDuration。
   */
  shotRange?: { min: number; max: number };
  /**
   * 总时长。小说改编不给这个值时，镜头数、每镜时长与总时长全部由模型决定
   * （镜数 1~12，单镜与总时长的区间由 videoModel 决定）。
   */
  totalDuration?: number;
  /** 剧本选定的视频模型 id（见 lib/video-models），决定单镜时长区间 */
  videoModel?: string;
}

/** 蓝图问题：非阻塞问题（镜数偏差）交给分镜阶段合并 / 拆分，阻塞问题触发重试 */
export interface PlanProblem {
  code:
    | 'shot-count'
    | 'incomplete-beat'
    | 'no-character'
    | 'no-scene'
    | 'off-model-character'
    | 'missing-subject-card'
    | 'missing-prompt-en'
    | 'scene-in-character-desc'
    | 'missing-motion'
    | 'motion-scoped'
    | 'missing-dialogue'
    | 'dialogue-without-card'
    | 'dialogue-repeat';
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
 * 载具题材里最常见的漏卡：给追车写了卡，忘了主角的座驾。
 * 没写卡的那辆车每一镜都会被模型重新设计（车型、车漆、改装件全变），
 * 而追逐戏天然至少有两辆车，所以这里按「创意里出现了几辆 + 是不是追逐」反推需要几张卡。
 */
const CHASE_SUBJECT =
  /(追逐|追车|飙车|竞速|赛车|追击|围追|围堵|拦截|截停|堵截|超车|并驾|夹击|甩尾|漂移|追尾|逃亡|飞车)/;
/**
 * 载具名词。不收单独的「车」与地铁 / 火车 / 巴士这类多半是地点的词，
 * 避免「躲进地铁站」被当成一辆要走卡的车。
 */
const VEHICLE_TERM =
  /(跑车|轿跑|轿车|超跑|赛车|越野车|皮卡|卡车|货车|面包车|商务车|出租车|警车|救护车|消防车|摩托|机车|重机|飞船|战机|直升机|无人机|快艇|游艇|坦克|装甲车|房车|载具|座驾|车辆|汽车)/;
/** 载具卡的特征词：命中两个以上才算这张卡确实在写一辆车 */
const VEHICLE_DESC =
  /(车型|车系|车身|车漆|涂装|拉花|贴花|贴纸|轮毂|轮胎|胎|车灯|前灯|尾灯|大灯|尾翼|扰流|进气|排气|引擎盖|挡风|车窗|车顶|轴距|底盘|悬挂|车架|座舱|驾驶舱|后视镜|车牌|车头|车尾|舰体|机身|机翼|螺旋桨|履带|推进器)/g;

function countVehicleCards(characters: PlanCharacter[]): number {
  return characters.filter((character) => {
    if (VEHICLE_TERM.test(character.name)) return true;
    const hits = character.desc.match(VEHICLE_DESC) ?? [];
    return hits.length >= 2;
  }).length;
}

/**
 * 追车戏的标识：主角确实在开车。
 * 步行被警车追逐（只有一辆车出场）不该硬要求两张载具卡，否则只会逼模型编一辆车出来。
 */
const DRIVING_SUBJECT =
  /(驾驶|驾车|开车|开着|骑着|坐在.{0,6}(车|座|摩托|机车上)|车内|副驾|后座|方向盘|油门|挡位|漂移|甩尾|超车|并线|赛道|赛段|追尾)/;

/** 本片至少需要几张载具卡：追车 / 竞速且有驾驶主体时至少两辆，其余按创意里点到的载具种类算 */
function requiredVehicleCards(idea: string): number {
  const terms = new Set(idea.match(new RegExp(VEHICLE_TERM.source, 'g')) ?? []);
  if (terms.size === 0) return 0;
  if (CHASE_SUBJECT.test(idea) && (DRIVING_SUBJECT.test(idea) || terms.size >= 2)) {
    return clamp(Math.max(2, terms.size), 2, 4);
  }
  return Math.min(4, terms.size);
}

/**
 * 蓝图提示词。默认是「故事架构师」，小说改编 agent 会换一个 role 并追加改编规则，
 * 两者共用同一套输出结构与校验，避免两份 schema 逐渐漂移。
 */
export function buildBlueprintSystemPrompt(
  role = '故事架构师 + 分镜串联导演',
  extraRules = '',
  limits: ShotLimits = shotLimits(),
): string {
  return `你是「${role}」。上游只给一个故事创意，你要产出一份可拍摄蓝图：先确立故事内核与人物，再把故事拆成一条首尾相接的镜头状态链。
你不写画面文案，也不写台词原文，但要设计每一镜的对白意图（谁开口、想达成什么、潜台词是什么、说完对方怎么变），以及这条状态链怎么接。

【故事层】
1. logline：一句话，必须包含「谁 + 想要什么 + 被什么阻碍 + 可能付出什么代价」，40 字以内。
2. theme：一句可以被画面证明的判断（例：「承认失去，才是活下去的开始」），不要写「关于爱」这类名词短语。
3. tone：情绪基调与节奏（例：「压抑克制，前半慢，后半急促」），用来约束后面所有镜头。
   motion / motionEn：全片运动基调。motion 一句话说清「观众在任何一镜里都该感到画面在动，还是可以静止」，以及动感来自哪里；motionEn 是它的英文短句（≤18 词），运行时会被逐镜追加到每一条视频提示词的末尾。这两条是全片属性，不是某一镜的动作清单——规则见下。
   ${MOTION_SCOPE_RULES}
4. 结构：用经典节拍组织，每个 beat 标注 beat 字段，只能取：开场钩子 / 铺垫 / 激励事件 / 升级 / 中点转折 / 低谷 / 高潮 / 余韵。镜数少时可以省略部分节拍，但开场钩子、高潮、余韵不能缺。
5. 主体卡 2~5 张（最多 8 张，放在 characters 数组里）：role 写叙事功能。
   写卡之前先列一遍「本片有哪些需要在两个以上镜头里被认出来的视觉主体」，再逐个判断主体类型。不判断类型就套人类模板，会把机甲、巨兽、载具写成「三十岁男人」；漏掉一个主体，就会在成片里每镜重新设计一遍。
   ${SUBJECT_CARD_RULES}
   每张卡都必须带 subjectType，只能取 human / vehicle / mech（人类与类人写 human，载具写 vehicle，机甲 / 机器人 / 机械巨兽写 mech）。
   ${APPEARANCE_ONLY_RULES}
   每项都要具体到「能照着画出来」，不许用「高科技感」「未来感的衣服」这类空话。
   【A 人类 / 类人】按 8 项顺序写全：
   ① 廓形：性别、年龄感、身高体型、体态；
   ② 头部：脸型 + 肤色（或材质）、眉眼神态、发型（长度 / 走向 / 质地）+ 发色；
   ③ 上装：版型 + 颜色 + 面料或材质 + 磨损与细节；
   ④ 下装与鞋：版型 + 颜色 + 材质；
   ⑤ 装备 / 义体 / 机械部件：位置 + 形态 + 材质 + 运行状态（例：「左前臂是拉丝钛义体，接缝有冷蓝色发光细线，指关节可见液压结构」）；
   ⑥ 配色：主色 / 辅色 / 发光色 + 色温；
   ⑦ 随身道具；
   ⑧ 气质与体态特征（站姿、视线习惯、手部小动作）。
   【B 机械体 / 机甲 / 机器人 / 巨型生物】禁止出现年龄、性别、发型发色、上装下装、鞋——这些字段对它没有意义，写进去就是把它写成了人。按 8 项顺序写：
   ① 机型与体量：型号或代号、高度（按米计）、头身比例、整体轮廓（人形重装 / 四足 / 流线型 / 兽形 / 履带式）；
   ② 头部：头部件形态、面罩或目镜 / 传感器阵列（数量与排列）、天线或角；
   ③ 装甲：主装甲板形状 + 材质（轧制钢板 / 陶瓷复合装甲 / 拉丝钛 / 碳纤维板）+ 分件接缝 + 涂装 + 战损与污渍；
   ④ 关节与肢体：液压缸 / 伺服电机 / 线缆走线、手掌与足部形态；
   ⑤ 武器 / 装备：位置 + 形态 + 材质 + 运行状态（炮管、能量导管、推进器喷口、发光部位）；
   ⑥ 配色：主色 / 辅色 + 发光色与发光部位 + 色温；
   ⑦ 标识与编号（喷印在哪个部位）；
   ⑧ 动作特征（站姿、行走时的机械节奏、攻击前的预备动作）。
   【C 载具 / 车辆 / 飞行器】车辆不是道具，是主角之一。禁止写年龄、性别、发型、上装下装、鞋。按 8 项顺序写：
   ① 车型与体量：类型（双门跑车 / 重型机车 / 装甲运兵车 / 直升机）、年代感、长宽高比例与整车轮廓；
   ② 车身与车漆：主色 + 漆面状态（哑光 / 金属漆 / 清漆反光）+ 做旧、划痕、泥点、战损；
   ③ 玻璃与车窗：贴膜深浅、反光度、能看见的内饰或驾驶员剪影；
   ④ 车轮：轮毂样式与颜色、轮胎规格与磨损、胎烟与溅水；
   ⑤ 灯具：前灯形态与光色、尾灯形态与光色、是否改装（灯带 / 爆闪 / 隐藏式）；
   ⑥ 改装与识别特征：尾翼、宽体、进气口、防滚架、排气位置、行李架；
   ⑦ 标识：编号、贴纸、涂装拉花、车牌（写在车身哪个部位）；
   ⑧ 动态特征：过弯姿态、加速时的车身俯仰、排气与溅水的形态。
   题材里出现机甲 / 机器人 / 机械巨兽 / 飞船等非人主体时，这些主角必须按 B 写；载具按 C 写；驾驶员、乘客等人类角色按 A 写，并与机体 / 载具分成两张卡，不许把人类特征混进机体或载具描述。追逐戏里被追的车与追的车必须各占一张卡。
   科幻 / 未来科技题材的装备必须写到具体技术名词与材质（拉丝钛、哑光碳纤维、半透明聚合物、液态金属、陶瓷装甲、全息喷绘、能量导管等），并写清分件与光源位置。
   promptEn 写 20~35 个单词的固定英文外貌短语，与 desc 同序覆盖同样的可见项：人类写「主体 + 年龄感 + 头面部 + 服装 + 装备 + 配色 + 道具」；机械体写「主体 + 机型体量 + 头部传感器 + 装甲材质与涂装 + 关节结构 + 武器 + 配色」；载具写「主体 + 车型体量 + 车漆与涂装 + 玻璃 + 轮毂轮胎 + 灯具 + 改装件 + 标识」。不要给人以外的卡写年龄词与服装词。desc 里每个可见项都要在英文里有对应词。全片一字不改地复用。
6. 场景 1~4 个：desc 写地点、空间尺度、时间、光源方向与色温、主要陈设与其材质；promptEn 写 15~25 个单词的固定英文空间短语，覆盖空间类型 + 关键陈设 + 光源与色调。同一个空间只写一次，不要按镜头重复。

【对白层】
7. 对白要在这一层设计好，不要留给分镜阶段现编。凡是这一镜里有人开口，就给该节拍写 dialogue 对象：
   - speaker：这一镜唯一开口的人，必须逐字来自主体卡；一个节拍只能有一个 speaker；
   - intent：这句台词要达成什么（说服 / 试探 / 拒绝 / 威胁 / 拖延 / 摊牌），写成动作性的一句话，不要写成台词原文；
   - subtext：潜台词，嘴上说的与心里要的不是同一件事；
   - effect：对方听到之后的可见变化（让步 / 反击 / 沉默 / 手停下来），没有变化就说明这句台词不该存在；
   - listener：听者是谁，决定反打镜头里该出现谁。
   一人一镜：两个人开口就是两个节拍、两个镜头。A 说完 B 接话，必须拆成两个相邻节拍（A 的镜头 → B 的反打镜头，transition 一律 hard-cut），不许把一问一答压进一个节拍；同一人物连续说几句可以留在同一节拍里，用 action 写清「说第一句 / 停顿 / 说第二句」。
   不要为了「有台词」而加台词：画面能交代的信息不写台词，情绪最高点常常是一个不开口的反应镜头。全片至少有一个 dialogue 节拍（用户明确要求无对白除外），也不要把整条状态链写成对话。
   旁白同样在这一层决定用不用：开场交代前情、跨时空转场、收尾点题这三处，把该节拍写成「空镜铺景 + 旁白要交代什么」（旁白原文由分镜写，这里只写清要交代的事实：谁、在哪、为什么打、过了多久），action 只写画面事实，不要写人物心理；这类节拍不需要 dialogue。
   开场尤其要算清楚：创意或原文里已经给了前情（谁与谁为何开战、几方势力、时隔多久）时，第 1 个节拍就是建立镜头——空镜或大远景，action 写「空镜铺景 + 旁白交代（具体事实）」，这一镜不安排 dialogue，第二镜才进人物台词。一句话旁白顶掉一整场交代戏，短片（6 镜以内）没有时间让人物在台词里自我解释背景。
   只有创意从动作中段切入（in medias res，第一句就是冲突）时，才不用开场旁白。典型：第 1 镜帐外空镜 +「董卓乱政，十八路诸侯会于酸枣」，第 2 镜直接是袁术的台词。

【串联层】
8. entry 写这一镜开始时「谁 / 在哪 / 什么姿势 / 手里拿着什么 / 朝画面哪一侧运动」（第一镜写「开场」）。景别在近景 / 特写及以内的镜头，entry 还必须写清容器几何、两个以上固定件（车厢：方向盘 / 仪表台 / 后视镜 / 车窗框 / 雨刷；走廊：门框 / 踢脚线 / 顶灯），以及镜头相对主体的方位与高度——特写里没有这些，内饰与机位就会被模型凭空发明。上一镜 transition=same-take 时必须与它的 exit 是同一个画面事实；hard-cut / time-jump 允许换机位，但人物、场景、光线、运动方向与背景锚点必须与上一镜一致——换机位不换世界。对白戏的 entry 还要写清听者在画面里的位置（肩 / 后脑 / 侧脸在画框哪一侧）。
9. exit 必须是一个可以直接拍出来的画面状态：谁、在哪里、什么姿势、朝向哪里、手里拿着什么、主体在画面哪个位置、朝哪个方向运动、背景里有什么锚点，以及光源方向与色温、画面里最显眼的一两个固定件（仪表台 / 门框 / 路灯）——这些是下一镜唯一能继承的空间情报。不要写情绪或抽象概念。
10. transition=same-take 的两镜，action 必须首尾相接：上一镜没做完的动作，下一镜接着做完；hard-cut / time-jump 允许动作跳，但不许人物凭空换位、道具凭空出现。
${CUT_POINT_RULES}
11. 空间连续：全片尽量在同一个空间内完成，开场用大远景 / 全景把空间关系交代清楚。每一镜都必须写 transition，说明这一镜怎么交到下一镜，只能取三个值：
    - same-take：同一个连续动作被切成两镜，下一镜从这一镜的最后一帧原样继续，景别与机位都不许变（景别一变就不是同一次拍摄）。全片连续出现不得超过 2 次——每接一次画面都会掉一点细节，接多了人物就漂了。
    - hard-cut：停机换了机位——换景别 / 换角度 / 正反打。下一镜是新的机位，画面必须重新构图。绝大多数镜头都应该是这个。
    - time-jump：时间或地点跳转（次日、片刻后、换场地）。
    判断标准只有一句：摄影机有没有停机。还在同一次拍摄里就是 same-take，停机换了机位就是 hard-cut。
    一镜到底优先在一个镜头内完成：景别变化靠运镜（推近 / 拉远 / 跟随）表达，不要拆成多个镜头再靠 same-take 粘起来。必须在长镜头里换景别时，用遮挡 / 甩镜 / 暗部换机位（人物走过柱子、门框、走廊，镜头甩进暗处），并在镜头上标 hiddenCut: true。
12. 镜头语言成组：相邻镜头避免同样的景别 + 运镜，景别按「建立 → 逼近 → 细节 → 释放」的节奏推进。
13. 情绪曲线：给每一镜 emotion（1~5）。不要一开场就 5，也不要全程 3；最高点落在全片后 1/3 的高潮镜。
14. 镜头数量：给了明确的「镜头数量」就必须精确等于这个数量；给的是一段区间时，按「叙事断点」自己决定用几个镜头，必须落在区间内。串联性强的段落——同一空间、同一主体连续推进的追逐、穿行、对峙——合成一个镜头，不要拆；但对话段落按「话轮」拆：换一个人开口就是一个新镜头（一人一镜，见第 7 条）。只有换空间、跳时间、要藏起一个信息、情绪需要停顿时才切。不要为了凑数硬切，也不要把几个本该分开的节拍硬塞进一个镜头。
15. duration 是这一镜的时长（秒，${limits.minShot}~${limits.maxShot} 的整数，当前视频模型只吃这个区间）。${limits.preferredShot} 秒以内质量最稳，普通镜头尽量排在这个范围内；只有串联性强的连续段落才用 ${limits.preferredShot}~${limits.maxShot} 秒的长镜，并且要确认这一段确实是一条不断开的动作链。用户给了总时长时，所有镜头 duration 之和必须等于它；没给总时长时，由你按剧情节奏决定总时长（${limits.minTotal}~${limits.maxTotal} 秒），不要套用固定值。
${extraRules ? `\n${extraRules}\n` : ''}
只输出一个 JSON 对象，不要解释文字、不要 markdown 代码块。

JSON 结构：
{
  "title": "片名",
  "logline": "一句话故事梗概",
  "theme": "一句可被画面证明的判断",
  "tone": "情绪基调与节奏",
  "motion": "全片运动基调：整片是持续运动还是静止，动感来自哪里（只写任何一镜都成立的运动介质，不写剧情动作）",
  "motionEn": "≤18 words English motion baseline appended to every shot: only ambient medium (dust, firelight, fabric, breath), never story actions or specific subjects",${extraRules ? '\n  "treatment": "300~500 字连贯梗概，按成片顺序写",' : ''}
  "characters": [
    {
      "name": "人类角色名",
      "role": "叙事功能",
      "subjectType": "human | vehicle | mech",
      "desc": "【A 人类】① 廓形：三十岁男性，高瘦，肩背微驼；② 头部：窄长脸，苍白偏青的肤色，短发剃到耳上，发根有接驳插口；③ 上装：哑光碳纤维高领外套，胸口有陶瓷装甲分件，肘部织物磨白；④ 下装与鞋：灰黑工装裤，磁吸扣短靴；⑤ 装备 / 义体：左前臂拉丝钛义体，接缝处冷蓝发光细线，指关节可见液压结构；⑥ 配色：主色石墨灰，辅色氧化橙，发光色冷蓝，色温偏冷；⑦ 道具：腕部全息终端；⑧ 气质：站姿笔直，说话前习惯用拇指摩挲义体接缝",
      "promptEn": "30-words fixed English appearance phrase in the same order as desc"
    },
    {
      "name": "机体代号",
      "role": "对手",
      "subjectType": "mech",
      "desc": "【B 机械体】① 机型与体量：代号「熔核」，人形重装机体，全高 42 米，肩宽接近身高一半；② 头部：楔形面罩后一枚广角单眼传感器，头顶两根短天线；③ 装甲：轧制钢板外套陶瓷复合装甲，板缝露出黄黑警示条，胸甲有熔穿战损；④ 关节与肢体：外露的液压缸与粗线缆，三指机械手，足部为爪式支撑；⑤ 武器 / 装备：右臂 30 毫米转管炮，背部双推进器喷口有余温红光；⑥ 配色：主色锈红，辅色黑铁，发光色熔橙，色温偏暖；⑦ 标识：左肩喷白色编号 K-09；⑧ 动作：站姿前倾，开炮前右肩先下沉",
      "promptEn": "35-words fixed English appearance phrase in the same order as desc, no age or clothing words"
    },
    {
      "name": "主角座驾（载具代号）",
      "role": "主角的延伸",
      "subjectType": "vehicle",
      "desc": "【C 载具】① 车型与体量：双门宽体跑车，低趴长头短尾，长 4.5 米；② 车身与车漆：哑光枪灰金属漆，轮拱与保险杠有碎石划痕和泥点；③ 玻璃与车窗：深色贴膜，隐约可见防滚架与驾驶者剪影；④ 车轮：深灰六辐锻造轮毂，半热熔胎，胎肩有明显磨损；⑤ 灯具：细长 LED 前灯冷白光，贯穿式尾灯暗红；⑥ 改装件：固定式碳纤维尾翼、前铲、侧出排气；⑦ 标识：车门喷白色编号 07，后窗贴一道褪色拉力条纹；⑧ 动态：过弯时车身侧倾很小，压水洼溅起扇形水花",
      "promptEn": "30-words fixed English vehicle phrase: body type and proportions, paint and weathering, glass, wheels and tires, lights, aero parts, markings — no age or clothing words"
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
      "dialogue": {
        "speaker": "这一镜唯一开口的人（必须来自主体卡）；本镜没人开口时省略整个 dialogue 字段",
        "intent": "这句台词要达成什么（说服 / 试探 / 拒绝 / 威胁 / 摊牌），不要写台词原文",
        "subtext": "潜台词：嘴上说的与心里要的不是同一件事",
        "effect": "对方听到之后的可见变化（让步 / 反击 / 沉默 / 手停下）",
        "listener": "听者是谁"
      },
      "entry": "承接的上一镜状态（谁 / 在哪 / 姿势 / 朝向 / 运动方向）；第一镜写「开场」",
      "exit": "结束时留下的可拍摄状态（谁 / 在哪 / 画面位置 / 运动方向 / 背景锚点），必须是可切帧",
      "shotSize": "特写/近景/中景/全景/远景/大远景",
      "cameraMove": "固定机位/缓慢推近/缓慢拉远/横向移动/环绕/跟随/手持晃动/升格慢动作",
      "transition": "same-take | hard-cut | time-jump"
    }
  ]
}`;
}

function buildUserPrompt(req: PlanRequest, correction?: string): string {
  const limits = shotLimits(req.videoModel);
  const countLine = req.shotRange
    ? `镜头数量：由你根据故事节奏自行决定，${req.shotRange.min}~${req.shotRange.max} 个之间`
    : req.shotCount
      ? `镜头数量：${req.shotCount} 个`
      : `镜头数量：由你根据剧情节奏决定，${MIN_SHOT_COUNT}~${MAX_SHOT_COUNT} 个之间`;

  const totalLine = req.totalDuration
    ? `总时长：${req.totalDuration} 秒`
    : `总时长：由你根据剧情节奏决定（${limits.minTotal}~${limits.maxTotal} 秒），不要套用固定时长`;

  const durationRule = req.totalDuration
    ? `每一镜给出 ${limits.minShot}~${limits.maxShot} 秒的 duration，总和必须等于 ${req.totalDuration} 秒`
    : `每一镜给出 ${limits.minShot}~${limits.maxShot} 秒的 duration；镜头数量、每镜时长与总时长都由你按剧情决定（${MIN_SHOT_COUNT}~${MAX_SHOT_COUNT} 镜）`;

  const tail = req.shotRange
    ? `请先定主体卡（人物 + 每一辆载具 + 关键道具）与场景，再设计一条连贯的状态链（镜头数量由你决定）与对白节拍（谁开口 / 意图 / 潜台词 / 说完的变化，一人一镜），${durationRule}，输出 JSON。`
    : req.shotCount
      ? `请先定主体卡（人物 + 每一辆载具 + 关键道具）与场景，再设计 ${req.shotCount} 个镜头组成的连贯状态链与对白节拍（谁开口 / 意图 / 潜台词 / 说完的变化，一人一镜），${durationRule}，输出 JSON。`
      : `请先定主体卡（人物 + 每一辆载具 + 关键道具）与场景，再设计一条连贯的状态链与对白节拍（谁开口 / 意图 / 潜台词 / 说完的变化，一人一镜），${durationRule}，输出 JSON。`;

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

/** 主体类型的各种写法：模型可能给英文枚举，也可能直接写「人类 / 载具 / 机甲」 */
const SUBJECT_TYPE_ALIASES: Record<string, CharacterSubject> = {
  human: 'human',
  person: 'human',
  character: 'human',
  a: 'human',
  人: 'human',
  人类: 'human',
  人物: 'human',
  角色: 'human',
  vehicle: 'vehicle',
  car: 'vehicle',
  c: 'vehicle',
  车: 'vehicle',
  载具: 'vehicle',
  车辆: 'vehicle',
  mech: 'mech',
  machine: 'mech',
  robot: 'mech',
  b: 'mech',
  机甲: 'mech',
  机械: 'mech',
  机械体: 'mech',
  机器人: 'mech',
};

function parseSubjectType(raw: unknown): CharacterSubject | undefined {
  if (typeof raw !== 'string') return undefined;
  const key = raw.trim().toLowerCase().replace(/[【】[\]]/g, '').replace(/\s+/g, '');
  return SUBJECT_TYPE_ALIASES[key];
}

/**
 * 模型没给 subjectType 时的兜底推断，只在高置信度时下结论：
 * 名字就是载具名，或 desc 里有两个以上载具特征词且没有任何人类专属特征。
 * 拿不准就返回 undefined，交给配图层继续按关键词判断——那里有全身站姿的构图层兜底。
 */
function inferSubjectType(name: string, desc: string): CharacterSubject | undefined {
  if (VEHICLE_TERM.test(name)) return 'vehicle';
  const vehicleHits = desc.match(VEHICLE_DESC) ?? [];
  if (vehicleHits.length >= 2 && !HUMAN_ONLY_DESC.test(desc)) return 'vehicle';
  return undefined;
}

/** 主体类型的统一入口：模型给了就用模型的，没给才按名字 / 描述兜底推断 */
export function normalizeSubjectType(
  rawType: unknown,
  name: string,
  desc: string,
): CharacterSubject | undefined {
  return parseSubjectType(rawType) ?? inferSubjectType(name, desc);
}

function normalizeCharacter(raw: Record<string, unknown>): PlanCharacter | null {
  const name = str(raw.name);
  if (!name) return null;
  const desc = str(raw.desc);
  return {
    name,
    role: str(raw.role) || undefined,
    desc,
    subjectType: normalizeSubjectType(raw.subjectType, name, desc),
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

/**
 * 对白设计：模型可能给对象，也可能只给一句「说话人：意图」的字符串。
 * 只收结构化结果——一镜一个 speaker 是硬约束，靠字符串解析保不住。
 */
function normalizeDialogue(raw: unknown): BeatDialogue | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;
  const speaker = str(record.speaker ?? record.who ?? record.name);
  if (!speaker) return undefined;
  const intent = str(record.intent ?? record.purpose ?? record.goal);
  const subtext = str(record.subtext ?? record.inner);
  const effect = str(record.effect ?? record.change ?? record.reaction);
  const listener = str(record.listener ?? record.to ?? record.target);
  return {
    speaker,
    intent,
    ...(subtext ? { subtext } : {}),
    ...(effect ? { effect } : {}),
    ...(listener ? { listener } : {}),
  };
}

function normalizeBeat(
  raw: Record<string, unknown>,
  index: number,
  limits: ShotLimits,
): Beat {
  const durationRaw = Number(raw.duration);
  const duration =
    Number.isFinite(durationRaw) && durationRaw > 0
      ? Math.round(clamp(durationRaw, limits.minShot, limits.maxShot))
      : undefined;
  const emotionRaw = Number(raw.emotion);
  const emotion = Number.isFinite(emotionRaw)
    ? Math.round(clamp(emotionRaw, 1, 5))
    : undefined;
  const dialogue = normalizeDialogue(raw.dialogue ?? raw.line ?? raw.speech);

  return {
    index,
    beat: str(raw.beat, index === 1 ? '开场钩子' : '升级'),
    purpose: str(raw.purpose, `推进第 ${index} 段`),
    subject: str(raw.subject, '主体'),
    action: str(raw.action),
    ...(dialogue ? { dialogue } : {}),
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
  const limits = shotLimits(req.videoModel);

  const beatsRaw = Array.isArray(obj.beats) ? obj.beats : [];
  const beats = beatsRaw
    .filter((b): b is Record<string, unknown> => !!b && typeof b === 'object')
    .map((b, i) => normalizeBeat(b, i + 1, limits));

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

  // 载具题材漏卡：主角车没有卡，成片里每一镜都是另一辆车
  const requiredVehicles = requiredVehicleCards(req.idea);
  const vehicleCards = countVehicleCards(characters);
  if (requiredVehicles > vehicleCards) {
    problems.push({
      code: 'missing-subject-card',
      message:
        `本片需要至少 ${requiredVehicles} 张载具卡，但主体卡里只有 ${vehicleCards} 张能认作载具。` +
        '载具不是道具：主角座驾与对手载具（追车 / 警车 / 摩托 / 飞行器）必须各自单独成卡，' +
        '每张卡按【C 载具】写车型与体量、车身轮廓、车漆与涂装、玻璃、轮毂与轮胎、灯具、改装件、标识与动态特征，' +
        '并给出 20~35 个单词的固定英文 promptEn；不许把两辆车合成一张「追逐车组」，也不许只给其中一辆写卡',
      blocking: true,
    });
  }

  const lackPromptEn = characters.filter((c) => !c.promptEn?.trim()).map((c) => c.name);
  if (lackPromptEn.length > 0) {
    problems.push({
      code: 'missing-prompt-en',
      message:
        `主体卡 ${lackPromptEn.map((name) => `「${name}」`).join('、')} 没有给出固定英文 promptEn；` +
        '没有这段短语，分镜阶段会逐镜重新描述长相，成片里每个主体都会漂',
      blocking: false,
    });
  }

  // 主体卡写进了「这一镜才成立」的姿势 / 场景：卡片会被画成一张剧照，
  // 之后每一镜都跟着往那个场景漂。载具卡的 ⑧ 动态特征本来就写运行姿态，豁免。
  const situationCards = characters.filter(
    (c) => c.subjectType !== 'vehicle' && SITUATION_HINT.test(c.desc),
  );
  if (situationCards.length > 0) {
    problems.push({
      code: 'scene-in-character-desc',
      message:
        `主体卡 ${situationCards.map((c) => `「${c.name}」`).join('、')} 的 desc 写进了只在一镜成立的姿势 / 场景 / 动作。` +
        'desc 只写全片恒定的可见外观：不许写「坐在车里 / 站在门口 / 握着方向盘 / 正在做什么」这类剧照信息，' +
        '否则角色卡会被画成那一镜的截图，成片里每一镜都会往那个场景漂；' +
        '体态只写默认的站立或行走基线，道具写随身携带、可独立辨认的物件，不写手里正拿着什么',
      // 配图层还会再剥一次，少量命中不阻塞；大面积命中说明模型没理解「外观 ≠ 剧照」
      blocking: situationCards.length * 2 > characters.length,
    });
  }

  /**
   * 对白设计的三项确定性检查。
   * 这些都不阻塞重试：台词是分镜阶段还能补的东西，但必须留痕——
   * 蓝图没设计对白时，分镜只能现编，出来的就是念设定。
   */
  const speakers = beats
    .map((beat) => beat.dialogue)
    .filter((dialogue): dialogue is BeatDialogue => !!dialogue);
  const castNames = new Set(characters.map((c) => c.name.trim()));
  const unknownSpeakers = speakers
    .map((dialogue) => dialogue.speaker)
    .filter((name) => !castNames.has(name.trim()));
  if (unknownSpeakers.length > 0) {
    problems.push({
      code: 'dialogue-without-card',
      message:
        `对白设计里的说话人 ${[...new Set(unknownSpeakers)].map((name) => `「${name}」`).join('、')} 不在主体卡里；` +
        '不能给没有卡的人安排台词——分镜阶段映射不上 speaker，这一镜的台词会变成没人开口，' +
        '成片里音色与长相都对不上。两条修法选一条：给这个人补一张主体卡（按人类 8 项写全），' +
        '或者把台词改给已有卡的人说（一人一镜，不要两个人共用一镜）',
      // 结构性问题，必须重试：否则分镜只能写出一句没人认领的台词，还要再花一次整稿修复
      blocking: true,
    });
  }

  // 相邻两镜同一个人连续开口：这两个节拍应该合成一镜，或中间插一个反应镜头
  const repeated = beats.filter(
    (beat, i) =>
      i > 0 &&
      beat.dialogue?.speaker &&
      beat.dialogue.speaker === beats[i - 1].dialogue?.speaker &&
      beat.transition === 'hard-cut',
  );
  if (repeated.length > 0) {
    problems.push({
      code: 'dialogue-repeat',
      message:
        `第 ${repeated.map((beat) => beat.index).join('、')} 镜与上一镜是同一个人开口（硬切）；` +
        '同一人物连续说几句应合成一镜，或在中间插一个不开口的反打 / 反应镜头，' +
        '否则成片里就是同一张脸连着两个同构图',
      blocking: false,
    });
  }

  const humanCards = characters.filter((c) => c.subjectType !== 'vehicle' && c.subjectType !== 'mech');
  if (speakers.length === 0 && humanCards.length >= 2 && !/无对白|没有台词|无需台词|默片/.test(req.idea)) {
    problems.push({
      code: 'missing-dialogue',
      message:
        '蓝图没有设计任何对白节拍，但片中有两个以上人物；' +
        '请在关键冲突处设计 dialogue（speaker / intent / subtext / effect），' +
        '让人物开口推进关系，而不是全靠旁白解释',
      blocking: false,
    });
  }

  // 运动基调是全片级的兜底：没有它，某一镜的特写就只能靠自己那句描述撑住速度感
  if (!str(obj.motion)) {
    problems.push({
      code: 'missing-motion',
      message:
        '蓝图没有给出全片运动基调（motion）；一句「持续的风、火光晃动与飘浮的尘粒，任何特写都不静止」就能让' +
        '后面每一镜都保持动感，缺失时只能逐镜祈祷模型别把画面拍成静止',
      blocking: false,
    });
  }

  /**
   * 运动基调被写成了剧情动作（战马冲入 / 提头掷地 / 斟酒）：
   * 它会被追加到每一镜，于是每一镜都会长出这些主体。这里先确定性剔掉这些分句，
   * 再提醒模型重写成「任何一镜都成立的运动介质」。
   */
  const rawMotionEn = str(obj.motionEn);
  const motionEn = rawMotionEn ? stripScopedMotion(rawMotionEn) : '';
  if (rawMotionEn && motionEn !== rawMotionEn) {
    problems.push({
      code: 'motion-scoped',
      message:
        `motionEn 里写了只属于个别镜头的剧情动作（原文「${rawMotionEn}」，已剔除为「${motionEn}」）。` +
        'motionEn 会被逐镜追加，写成战马 / 刀剑 / 斟酒 / 掷头这类主体，帐内对话特写里也会凭空出现它们；' +
        '改成任何一镜都成立的运动介质：飘浮的尘粒、晃动的火光、起伏的呼吸、被风掀动的衣料',
      // 已经确定性剔过，不阻塞重试
      blocking: false,
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
      motion: str(obj.motion),
      motionEn: motionEn || undefined,
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
      system: buildBlueprintSystemPrompt(undefined, '', shotLimits(req.videoModel)),
      user: buildUserPrompt(req, correction),
      temperature: 0.7,
      // 每个节拍多了 dialogue（speaker / intent / subtext / effect / listener），
      // 4000 会在 10 镜以上被截断，蓝图直接失败降级
      maxTokens: 6000,
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
