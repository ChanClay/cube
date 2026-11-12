/**
 * 影视语言规范：景别 / 运镜 / 提示词 / 台词的长度与格式约束。
 *
 * 这些规则以前散落在 continuity、storyboard、/api/shot/refine 三处，
 * 只要有一处忘了改，模型就会收到互相矛盾的指令。统一收在这里，
 * 同时提供确定性的规范化与检查函数，供三个 agent 共用。
 */

import type { CharacterSubject, ShotBeat, ShotTransition } from '@/lib/types';

/** 从远到近；也是提示词里推荐的情绪推进顺序 */
export const SHOT_SIZES = ['大远景', '远景', '全景', '中景', '近景', '特写'] as const;
export const CAMERA_MOVES = [
  '固定机位',
  '缓慢推近',
  '缓慢拉远',
  '横向移动',
  '环绕',
  '跟随',
  '手持晃动',
  '升格慢动作',
] as const;

export const DEFAULT_SHOT_SIZE = '中景';
export const DEFAULT_CAMERA_MOVE = '固定机位';

/**
 * 景别 → 提示词里的标准英文写法。
 * 翻译与校验共用同一张表，避免「中文写特写、英文写 wide shot」这种对不上的情况。
 */
export const SHOT_SIZE_EN: Record<string, string> = {
  大远景: 'extreme wide shot',
  远景: 'wide shot',
  全景: 'full shot',
  中景: 'medium shot',
  近景: 'medium close-up',
  特写: 'close-up',
};

/**
 * 运镜 → 英文表述。第一个是首选写法，其余是同义写法：
 * 校验时按整组比对（模型写 locked-off camera 不算错），翻译时只给第一个。
 */
export const CAMERA_MOVE_EN: Record<string, string[]> = {
  固定机位: ['static shot', 'static camera', 'locked-off camera', 'fixed camera'],
  缓慢推近: ['slow push-in', 'slow dolly in', 'slowly pushes in', 'push-in'],
  缓慢拉远: ['slow pull-out', 'slow dolly out', 'slowly pulls back', 'pull-out'],
  横向移动: ['lateral tracking shot', 'trucking shot', 'lateral move'],
  环绕: ['orbit shot', 'orbiting camera', 'arc shot'],
  跟随: ['tracking shot', 'follow shot', 'camera follows'],
  手持晃动: ['handheld camera', 'handheld shot'],
  升格慢动作: ['slow motion', 'slow-motion'],
};

export function shotSizeEn(size: string): string {
  return SHOT_SIZE_EN[size] ?? SHOT_SIZE_EN[DEFAULT_SHOT_SIZE];
}

export function cameraMoveEn(move: string): string {
  return (CAMERA_MOVE_EN[move] ?? CAMERA_MOVE_EN[DEFAULT_CAMERA_MOVE])[0];
}

/**
 * 提示词建议的英文单词数区间。
 * 上限留得比较宽：角色的固定英文外貌短语本身就 20~35 词（科幻 / 细节型角色尤其长），
 * 再叠场景短语与动作描述，90 词会逼模型删掉交代一致性的细节。
 */
export const PROMPT_MIN_WORDS = 40;
export const PROMPT_MAX_WORDS = 110;
/** 低于这个单词数视为不合格，会触发一次修复（比建议下限略宽，避免频繁返工） */
export const PROMPT_REPAIR_WORDS = 30;
/** 超过这个单词数视为啰嗦，会触发一次修复 */
export const PROMPT_REPAIR_MAX_WORDS = 150;

/** 台词里会破坏结构的角色前缀，例如「旁白：」 */
const NARRATION_PREFIX = /^(旁白|画外音|字幕|台词|独白|对白)\s*[:：]\s*/;

/** 字幕 / 水印 / 分屏等不该出现在画面提示词里的东西 */
const FORBIDDEN_PROMPT =
  /(\bsubtitles?\b|\bcaptions?\b|\bwatermarks?\b|\blogos?\b|\bon-screen text\b|\btext overlay\b|\bsplit[- ]screen\b|\bstoryboard\b|\bshot\s*\d+\b|\bscene\s*\d+\b)/i;

export const str = (v: unknown, fallback = ''): string =>
  typeof v === 'string' && v.trim() ? v.trim() : fallback;

export const clamp = (n: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, n));

export function normalizeShotSize(value: unknown): string {
  const size = str(value);
  return (SHOT_SIZES as readonly string[]).includes(size) ? size : DEFAULT_SHOT_SIZE;
}

export function normalizeCameraMove(value: unknown): string {
  const move = str(value);
  return (CAMERA_MOVES as readonly string[]).includes(move) ? move : DEFAULT_CAMERA_MOVE;
}

/** 景别在 SHOT_SIZES 里的档位；未知值按中景算，避免一个错值把跨度算成 5 */
export function shotSizeRank(size: string): number {
  const index = (SHOT_SIZES as readonly string[]).indexOf(size);
  return index >= 0 ? index : 3;
}

/** 两镜的景别跨度（档数）。0 = 同景别，1 = 相邻，≥2 = 跳变 */
export function shotSizeGap(
  a: { shotSize: string },
  b: { shotSize: string },
): number {
  return Math.abs(shotSizeRank(a.shotSize) - shotSizeRank(b.shotSize));
}

/** 按 name 去重，保留第一次出现的顺序（模型经常把同一角色 / 场景写两遍） */
export function dedupeByName<T extends { name: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const key = item.name.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

/**
 * 英文字符与中文汉字占比，用来判断提示词是不是「真英文」。
 * 允许少量汉字（角色名可能是「老陈」），但不接受中文长句。
 */
export function isEnglishPrompt(text: string): boolean {
  const letters = (text.match(/[A-Za-z]/g) ?? []).length;
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  if (letters < 20) return false;
  return cjk / (letters + cjk) <= 0.12;
}

/** 粗略统计英文单词数（按字母/数字开头的切分，标点不计） */
export function countWords(text: string): number {
  return (text.match(/[A-Za-z0-9][A-Za-z0-9'’\-]*/g) ?? []).length;
}

export function hasForbiddenPromptPhrase(prompt: string): boolean {
  return FORBIDDEN_PROMPT.test(prompt);
}

/**
 * 逐段删掉包含禁用词的描述（按逗号切分）。
 * 例如 "a rainy street, no subtitles, cold blue grade" → "a rainy street, cold blue grade"。
 */
export function stripForbiddenPromptPhrases(prompt: string): string {
  if (!hasForbiddenPromptPhrase(prompt)) return prompt;
  return prompt
    .split(/\s*,\s*/)
    .filter((segment) => segment.trim() && !FORBIDDEN_PROMPT.test(segment))
    .join(', ')
    .trim();
}

/**
 * 一镜能说多少字，跟着时长走：5 秒约 20 字，30 秒最多 60 字。
 * 超长的台词会被截到最近的句读处——视频模型不会因为台词长就放慢语速，
 * 只会让后半句被硬生生吞掉。
 */
export function narrationLimit(duration: number): number {
  const safe = Number.isFinite(duration) && duration > 0 ? duration : 5;
  return Math.min(60, Math.max(16, Math.round(safe * 4)));
}

export function trimNarration(text: unknown, duration = 5): string {
  let clean = str(text).replace(NARRATION_PREFIX, '').trim();
  clean = clean.replace(/^["“](.*)["”]$/, '$1').trim();
  if (!clean) return '';

  const limit = narrationLimit(duration);
  if (clean.length <= limit) return clean;

  const head = clean.slice(0, limit);
  const cut = Math.max(
    head.lastIndexOf('。'),
    head.lastIndexOf('！'),
    head.lastIndexOf('？'),
    head.lastIndexOf('；'),
    head.lastIndexOf('，'),
    head.lastIndexOf('…'),
  );
  return cut >= 8 ? head.slice(0, cut + 1) : head;
}

/** 景别 / 运镜的合法取值说明，拼进提示词用 */
export const SHOT_LANGUAGE_RULES =
  `shotSize 只能用：${SHOT_SIZES.join(' / ')}；` +
  `cameraMove 只能用：${CAMERA_MOVES.join(' / ')}。`;

/**
 * 主体卡：不只人物需要一致性。
 * 追逐戏只给追车写卡、忘了主角座驾，是「主角车每一镜都不一样」的唯一成因。
 */
export const SUBJECT_CARD_RULES = `主体卡不是「人物卡」：凡是需要在两个以上镜头里被认出来的视觉主体，都必须单独占一张卡，并给一段全片一字不改的英文短语（promptEn）：
- 人物：主角、对手、帮手；
- 每一辆载具：主角的座驾、追车、警车、摩托车、飞行器——追逐戏里被追的人和追的人各一张卡，两辆车必须是两张卡，不许合成一张「追逐车组」，也不许只给其中一辆写卡；
- 机甲 / 机器人 / 巨兽 / 坐骑；
- 贯穿全片的关键道具：武器、箱子、信物。
漏一张卡就是漏一份一致性：没写卡的那辆车，每一镜都会被模型重新设计一遍（车型、颜色、改装件全变）。`;


/**
 * 「只在某一镜成立」的信息：姿势、动作、所在场景。
 * 主体卡是全片复用的长相锚点，一旦写进这些，卡片就会被画成那一镜的剧照
 * （追逐戏里最常见的一例：主角卡写成「坐在驾驶座上，手握方向盘」）。
 */
export const SITUATION_HINT =
  /(坐在|坐进|坐回|靠在车|靠在门|躺在|蹲在|跪在|趴在|车里|车内|车厢|驾驶座|副驾驶|副驾|后排|方向盘|挡位|中控台|车窗外|窗外|门口|床边|桌边)/;

/** 主体卡 desc 的写法约束：只写恒定外观，不写这一镜的剧照 */
export const APPEARANCE_ONLY_RULES = `desc 只写「全片恒定不变的外观」，它不是这一镜的剧照：
- 禁止写任何只在一镜成立的信息：姿势（坐在 / 站在 / 靠在 / 蹲在）、动作（正在 / 握着 / 回头 / 望向）、所在场景（车内 / 驾驶座 / 副驾驶 / 车窗外 / 门口）、乘坐或驾驶的载具、与其它主体的相对位置、台词与情绪；
- 角色卡是全片每个镜头复用的长相锚点：desc 里写进「坐在车里」，卡片就会被画成一张车内剧照，之后每一镜也会跟着往那个场景漂；
- 体态只写默认的站立 / 行走基线（例：「肩背微驼，说话前习惯低头」），不写此刻正在做的动作；
- 道具写「随身携带、可独立辨认」的物件（腕部全息终端、挂在腰侧的钥匙），不写「手里拿着某物」这种瞬时状态；
- 载具卡的动态特征写物理特性（过弯侧倾小、加速时车头微抬），不写「正在漂移 / 停在路边」。`;

/** 配图提示词开头的「名称：」前缀：名称不是外观，清洗时要先摘出来 */
const NAME_PREFIX = /^([^：①②③④⑤⑥⑦⑧⑨⑩]{1,24})：/;

/**
 * 从主体描述里剥掉「这一镜才成立」的分句，兜底防止剧照信息进到配图提示词。
 * 按句号 / 分号切段：整段都在写场景与动作时直接丢弃。
 * 全被剥掉时只留名称——交给 promptEn 与构图层（全身站姿 / 单人居中）主导，
 * 总好过把一张「车内剧照」当成全片的长相锚点。
 */
export function sanitizeAppearance(text: string, subjectType?: CharacterSubject): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  // 载具本来就该写车身、座舱、车窗，不能按「场景 / 动作」剥
  if (subjectType === 'vehicle') return trimmed;
  const prefixed = NAME_PREFIX.exec(trimmed);
  const head = prefixed ? prefixed[0] : '';
  const body = head ? trimmed.slice(head.length) : trimmed;
  const kept = body
    .split(/(?<=[；;。\n])/)
    .filter((part) => !SITUATION_HINT.test(part))
    .join('')
    .trim();
  return kept ? `${head}${kept}` : head;
}

/**
 * 动势基线。
 *
 * 文生视频模型只会把「写到的」拍出来：镜头描述里没有任何持续运动源时，
 * 它会交出一张近似静止的图（人物坐着不动，只是镜头在推）。
 * 景别越小越容易踩：特写如果只写「瞳孔收缩」「神情凝重」，
 * 成片就是主角静态坐在那里、镜头给个特写。
 * 所以每一镜都必须显式写出一个贯穿全镜的运动源。
 */
export const MOTION_BASELINE_RULES = `动势基线（决定这一镜在成片里是「活的」还是「一张会呼吸的照片」）：
- 每一镜至少要有一个贯穿全镜的持续运动源，不许出现完全静止的画面。三选一或叠加：主体动（呼吸起伏、眨眼、发丝与衣料被气流带动、肌肉或机械关节的细微运动）／介质动（雨丝斜落、尘粒翻卷、烟雾、水花、玻璃上的水痕、蒸汽）／相对动（背景横向掠过的车流与灯光、地面飞速后退、光斑在脸上移动、车身振动）；
- 特写不是「把动作删掉」，而是「用局部写更大的动作」：手指因车身颠簸在方向盘上发抖、瞳孔随窗外掠过的灯光收缩、发丝被风压压向一侧、后视镜里逼近的车灯越来越大。禁止只写形容词与状态（「他神情凝重」「车里很安静」）而没有任何运动源；
- 环境动势必须跟着戏走：这场戏在追车，特写里也要能看出车还在动——车厢振动、窗外景物横掠、风压与雨刷；这场戏在暴雨里，近景也必须看见雨丝斜穿画面；
- 整镜用 "constant subtle motion, no frozen frame" 守住这条基线，不要用 "steady framing" 这类词暗示画面可以停住。`;

/**
 * 视频提示词的写法约束。storyboard 与单镜重算共用同一份，
 * 避免两处对「多少词、写什么顺序」给出不同要求。
 */
export const VIDEO_PROMPT_RULES = `videoPrompt 是同一镜中文 description 的忠实英译，不是重新创作：中文里写到的每个主体、动作、道具、环境、光线都必须在英文里有对应；中文里没有的元素一律不许增加，也不许删掉任何一个。
- 必须是英文，一段话，${PROMPT_MIN_WORDS}~${PROMPT_MAX_WORDS} 个单词，按这个顺序写：景别 + 主体（固定英文外貌短语）+ 具体动作 + 环境细节 + 光线 / 时间 / 色调 + 运镜 + 画面质感 +（可选）一句声音；
- 景别只用标准英文写法：${SHOT_SIZES.map((s) => `${SHOT_SIZE_EN[s]}（${s}）`).join(' / ')}，必须与 shotSize 一致；
- 只写一个运镜，用标准英文运镜词，且必须与 cameraMove 的中文含义一致（${CAMERA_MOVES.map((m) => `${m}=${CAMERA_MOVE_EN[m][0]}`).join('，')}）；
- 运动必须是一条连续、匀速、符合真实时间的动作链，用 "constant subtle motion, no frozen frame" 收尾。一镜可以有多个连续动作，但必须是同一个主体在同一空间里顺着做下来的：beatSheet 的每一段都要在英文里有对应，按时间顺序用并列的现在分词短语串起来。不要写 first / then / after that / finally 这类时间副词，也不要让多个人物同时各做各的——模型会把画面切成两段，接缝处就是抽帧般的抖动；
- 不要写 "slow motion"（除非 cameraMove=升格慢动作）、"time-lapse"、"speed ramp"、"jump cut"、"flicker"、"morphing" 这类会让速度忽快忽慢或画面跳变的词；
- 禁止字幕、文字、水印、logo、分屏、转场词、镜头编号（如 "shot 1" / "scene 2"）；
- 只写可拍摄的名词与动词，不要用 "beautiful" / "sad" 单独代替画面；
- 同一角色在全片复用同一段英文外貌短语，不要逐镜改写年龄、发型、服装、装甲与涂装、道具。
${MOTION_BASELINE_RULES}`;

/**
 * 跨镜连贯性的写法约束。分镜写作与审片共用：
 * 连贯性不能靠「记得上一镜」，必须是一条写在纸上的状态链。
 */
export const CONTINUITY_RULES = `每个镜头都要显式写出 entryState 与 exitState，它们是状态链上唯一可靠的锚点：
- entryState：本镜第一帧能拍到的画面事实——谁、在哪、什么姿势、朝向哪里、手里拿着什么、画面里还有什么道具；非第一镜必须与上一镜的 exitState 是同一个状态（可以换措辞，但人物、位置、姿势、道具不能变）；
- exitState：本镜最后一帧的画面事实，必须能被下一镜直接接住；不许写情绪、心理或抽象判断；
- 只要这场戏本身在运动（追车、奔跑、飞行、坠落、打斗），首尾状态就必须写清三件事——特写与近景也不例外（那时画面里只有一张脸、一只手，最容易把整场戏的运动丢掉）：主体在画面里的位置与大小（画面左 / 中 / 右、占画多少）、运动方向与速度（朝画右加速、迎面逼近）、一个贯穿场景的背景锚点（同一条路、同一盏灯、同一个弯道）。特写里没有完整运动主体时，改写成背景与介质的速度——窗外景物横掠、地面飞速后退、雨丝斜向划痕；
- 换机位不换世界：hard-cut / time-jump 可以换构图，但下一镜的 entryState 仍要重复上一镜的运动方向与背景锚点——方向翻转、锚点消失，观众看到的就是另一场戏；
- 出口必须是可切帧：最后一拍结束时主体仍在画面内，动作到达一个可辨认的相位（车头咬住前车、车身摆正、轮子落回地面）。禁止用「冲出画外 / 消失在黑暗或雨幕 / 完全虚化」收尾——这类结尾没有落点，下一镜怎么切都接不上；确实要以遮挡 / 甩镜交出去时，本镜写 hiddenCut: true；
- 上一镜没做完的动作，本镜接着做完；人物位置、道具、服装、光线不许在两镜之间凭空改变；
- 确实要跳时间或换场地时，本镜 entryState 里必须写清跳转（例：「片刻后，老陈已经站在塔顶，手里仍握着那盏油灯」）。`;

/**
 * 剪辑点设计。
 *
 * 「上一镜意犹未尽，下一镜接不上」不是提示词问题，是剪辑点没设计：
 * 出口停在没有落点的动态里，下一镜无论换不换机位都只能重新建立画面。
 * 分镜写作、审片修复共用这一份。
 */
export const CUT_POINT_RULES = `剪辑点设计（决定下一镜能不能接上，比任何单镜画面都重要）：
- 每镜的最后一段 beatSheet 必须是落点：动作到达一个可辨认的相位（咬住、落定、转头到位、灯灭），不是写到一半被时长截断；exitState 只描述这一拍结束时的画面；
- 出口只有三种收法：动作顶点收（本镜做完一个完整动作）／动作交接收（same-take，下一镜接着做完剩下的部分）／遮挡甩镜收（hiddenCut）。不要停在半空、运动中消失，或速度感堆满却没有落点；
- 出口必须给出可接三要素：主体在画面内的位置与大小、运动方向与速度、一个贯穿场景的背景锚点。下一镜即使换了机位，也要重述这三要素——方向不翻转、锚点不消失、速度感同一档；
- 硬切的接缝靠视觉匹配：切点两侧主体落在相近的画面位置（都偏画右），或共享同一瞬间的动作相位（上一镜轮胎压过水洼，下一镜水花从车头炸开）；
- 需要反向镜头时必须过桥：先垫一个中性机位（迎面 / 背面 / 空镜）或让主体在画面内完成转向，不许直接左右对切（越轴）。`;


/**
 * 秒级节奏的写法约束。
 * 没有这一层时，一镜 20 秒只会得到一句「他在灯室里点灯」，
 * 生成出来就是一段半死不活的慢镜头——几秒该发生什么，必须写在纸上。
 */
export const TIMELINE_RULES = `每一镜都要写 beatSheet：把这一镜的 duration 切成若干秒级节拍，逐段交代「第几秒到第几秒、画面发生什么变化」。它是这一镜的动作骨架，英文提示词要照着它写，所以每一段都必须具体到能拍。
- from / to 是相对本镜起点的秒数（整数或 .5），第一段 from 必须是 0，最后一段 to 必须等于 duration，中间既不能断档也不能重叠；
- 段数跟时长走：2~4 秒 2 段，5~10 秒 2~3 段，10~20 秒 3~5 段，20 秒以上每 5 秒左右一段（最多 8 段）。长镜头要拆细，不能用一个「他在奔跑」糊过去；
- 每段写清三件事：谁做了什么可见动作、画面里什么随之变化、镜头这时在做什么（固定 / 推近 / 跟随 / 甩过前景）；
- 每段只写一个连贯动作：抬眼、转头、伸手、握住、松手、后退、门开、灯灭、雨突然变大、车尾甩出弯道；不要在一段里塞两个不相干的事；
- 节拍之间必须连着：后一段的起点就是前一段的终点状态（人物位置、朝向、手里拿的东西），不许在节拍之间瞬移或凭空换姿势；
- 不许写「情绪渐强」「气氛变得紧张」「内心开始动摇」这类拍不出来的描述；
- 所有段落连起来读，必须正好是这个镜头完整的动作过程，不多不少；
- 动作要能对上这一镜的景别与运镜：特写的动作是「更大动作的局部」——手在抖是因为车在颠、瞳孔在缩是因为后视镜里的车灯逼近、发丝被风压压向一侧，不许写成一张静止的肖像；大远景里的"动作"是空间与光线的变化；
- 每段除了中文 action，还要给 actionEn：8~14 个英文单词的同一个动作，与 action 一一对应（运行时会按 from / to 把它拼成英文时间轴交给视频模型，没有它这一段动作就进不了成片）。`;

/** 表示时间 / 空间发生跳转的词；出现时允许 entryState 与上一镜 exitState 不一致 */
const TRANSITION_HINT =
  /(片刻后|稍后|随后|过了一会儿|次日|第二天|翌日|当天夜里|与此同时|镜头一转|转场|几年后|多年后|已在|已经站在|切换到)/;
const TRANSITION_HINT_EN =
  /\b(later|meanwhile|afterwards|the next (day|morning|night)|years later|cut to|transition)\b/i;

export function hasTransitionHint(text: string): boolean {
  return TRANSITION_HINT.test(text) || TRANSITION_HINT_EN.test(text);
}

/**
 * 画面运动方向。同一段追逐 / 穿行里方向翻转，观众看到的就是「倒着跑」，
 * 这也是「上一镜很带感、下一镜接不上」最常见的成因之一。
 */
export type ScreenDirection = 'left' | 'right' | 'toward' | 'away';

const DIRECTION_PATTERNS: { direction: ScreenDirection; pattern: RegExp }[] = [
  { direction: 'left', pattern: /(向左|朝左|左侧|画面左|由右向左|从右往左|左前方|左边)/ },
  { direction: 'right', pattern: /(向右|朝右|右侧|画面右|由左向右|从左往右|右前方|右边)/ },
  { direction: 'toward', pattern: /(迎面|冲向镜头|朝镜头|驶向镜头|扑向镜头|逼近镜头)/ },
  { direction: 'away', pattern: /(背向|远离镜头|驶离镜头|退向远处|朝着远处|向远处)/ },
];

const DIRECTION_LABEL: Record<ScreenDirection, string> = {
  left: '向左',
  right: '向右',
  toward: '迎面',
  away: '远离',
};

export function screenDirection(text: string): ScreenDirection | null {
  const value = str(text);
  if (!value) return null;
  return DIRECTION_PATTERNS.find((item) => item.pattern.test(value))?.direction ?? null;
}

export function directionLabel(direction: ScreenDirection): string {
  return DIRECTION_LABEL[direction];
}

/** 两个方向是否互为正反（越轴 / 倒着跑） */
export function directionsConflict(a: ScreenDirection, b: ScreenDirection): boolean {
  return (
    (a === 'left' && b === 'right') ||
    (a === 'right' && b === 'left') ||
    (a === 'toward' && b === 'away') ||
    (a === 'away' && b === 'toward')
  );
}

/** 主体已经出画的收尾：没有落点，下一镜接不住 */
const OFFSCREEN_EXIT =
  /(冲出画外|驶出画外|飞出画外|冲出画面|驶出画面|飞出画面|出画|掠过画外|离开画面|跑出画面|消失在(黑暗|夜色|雨幕|雨里|雾中|雾里|拐角|尽头|远处)|没入(黑暗|夜色|雨幕|雾中|雾里))/;

export function endsOffscreen(text: string): boolean {
  return OFFSCREEN_EXIT.test(str(text));
}

/** 衔接方式的三态取值，与 lib/types 的 ShotTransition 一致 */
export const SHOT_TRANSITIONS = ['same-take', 'hard-cut', 'time-jump'] as const;

/** 模型可能写的英文外来词，先归一再判断 */
const SAME_TAKE_HINT =
  /(same[-_ ]?take|continuous|match ?cut|无缝|连续|同一镜|同一拍摄|紧接|接住|延续|承接)/i;
const TIME_JUMP_HINT = /(time[-_ ]?jump|jump ?cut|时间|跳转|转场|次日|片刻后|闪回)/i;

/**
 * 把模型给的衔接方式归一成三态。
 *
 * 没写就判 hard-cut：宁可不接帧，也别把两个本来不是同一个动作的镜头硬接起来——
 * 接错了是一眼可见的画面跳变，硬切反而正常。历史剧本的「连续动作链」写法
 * 会在这里被整体降级成硬切，正是想要的结果。
 */
export function normalizeTransition(value: unknown): ShotTransition {
  const raw = str(value);
  if (!raw) return 'hard-cut';
  if (SAME_TAKE_HINT.test(raw)) return 'same-take';
  if (TIME_JUMP_HINT.test(raw)) return 'time-jump';
  return 'hard-cut';
}

/** 模型根本没写衔接方式时返回 undefined，交给调用方按状态链推断 */
export function parseTransition(value: unknown): ShotTransition | undefined {
  const raw = str(value);
  return raw ? normalizeTransition(raw) : undefined;
}

/** 英文功能词：提取「关键内容词」时剔除，避免 a / the / with 干扰比对 */
const STOPWORDS_EN = new Set([
  'a', 'an', 'the', 'and', 'or', 'with', 'in', 'on', 'at', 'of', 'to', 'from', 'by', 'for',
  'his', 'her', 'their', 'its', 'he', 'she', 'they', 'it', 'is', 'are', 'was', 'were', 'be',
  'wearing', 'holds', 'holding', 'has', 'have', 'very', 'into', 'over', 'under', 'near',
  'who', 'that', 'this', 'as', 'while', 'warm', 'cold', 'soft', 'dim',
]);

/**
 * 从固定英文短语里提取关键内容词（≥3 字母、非功能词）。
 * 用于检查「这一镜的英文提示词有没有真的用上角色 / 场景的固定短语」。
 */
export function contentWords(phrase: string): string[] {
  const words = phrase.toLowerCase().match(/[a-z][a-z'-]{2,}/g) ?? [];
  const uniq = new Set(words.filter((word) => !STOPWORDS_EN.has(word)));
  return [...uniq];
}

/** 英文关键词在提示词里命中了几个 */
export function matchedWords(phrase: string, prompt: string): { hit: number; total: number } {
  const words = contentWords(phrase);
  if (words.length === 0) return { hit: 0, total: 0 };
  const text = prompt.toLowerCase();
  const hit = words.filter((word) => text.includes(word)).length;
  return { hit, total: words.length };
}

/** 提示词里用的运镜 / 景别是否与中文字段对得上 */
export function promptCameraMatches(prompt: string, cameraMove: string): boolean {
  const group = CAMERA_MOVE_EN[cameraMove];
  if (!group) return true;
  const text = prompt.toLowerCase();
  return group.some((word) => text.includes(word.toLowerCase()));
}

export function promptShotSizeMatches(prompt: string, shotSize: string): boolean {
  const expected = SHOT_SIZE_EN[shotSize];
  if (!expected) return true;
  const text = prompt.toLowerCase();
  if (text.includes(expected)) return true;
  // 近景 / 特写的英文边界很模糊（close-up 与 medium close-up 互相包含），算合格
  if ((shotSize === '近景' || shotSize === '特写') && text.includes('close-up')) return true;
  return false;
}

/**
 * 中文状态描述的字符 bigram 重合度（0~1）。
 * 用来粗略判断「本镜的入口状态」和「上一镜的出口状态」说的是不是同一件事：
 * 完全不重合通常意味着动作链断了（或模型换了措辞但丢了关键人物 / 道具）。
 */
export function stateOverlap(previous: string, current: string): number {
  const grams = (text: string): Set<string> => {
    const clean = text.replace(/[\s，。、；：！？,.;:!?（）()「」《》"']/g, '');
    const set = new Set<string>();
    for (let i = 0; i < clean.length - 1; i += 1) set.add(clean.slice(i, i + 2));
    return set;
  };
  const a = grams(previous);
  const b = grams(current);
  if (a.size === 0 || b.size === 0) return 1;
  let shared = 0;
  for (const gram of b) if (a.has(gram)) shared += 1;
  return shared / b.size;
}

/** 一镜最多保留几段节拍（30 秒长镜按每 5 秒一段约 6 段，留一点余量） */
const MAX_BEAT_SEGMENTS = 8;

const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * 秒级节拍的确定性收口：
 * 排序、夹到 [0, duration]、补掉空隙、掐掉越界段，并强制首段从 0 开始、末段到 duration 结束。
 * 模型给的时间轴经常差一点（不从 0 开始、最后一段少一秒），与其让它重写，
 * 不如在这里直接算准——时间轴必须能对上视频的真实时长。
 */
export function normalizeBeatSheet(raw: unknown, duration: number): ShotBeat[] | undefined {
  if (!Array.isArray(raw)) return undefined;

  const total = Number.isFinite(duration) && duration > 0 ? duration : 5;
  const items: ShotBeat[] = [];

  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const action = str(record.action ?? record.desc ?? record.content);
    if (!action) continue;
    // 秒级节拍的英文短语：运行时靠它把时间轴拼进视频提示词
    const actionEn = str(record.actionEn ?? record.action_en ?? record.en);

    const from = Number(record.from ?? record.start ?? record.at);
    const to = Number(record.to ?? record.end);
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue;

    items.push({ from: round1(from), to: round1(to), action, ...(actionEn ? { actionEn } : {}) });
  }
  if (items.length === 0) return undefined;

  items.sort((a, b) => a.from - b.from);

  const result: ShotBeat[] = [];
  let cursor = 0;
  for (const item of items) {
    if (cursor >= total) break;
    // 整段都落在已覆盖区间里：模型写了重叠或超前的段，丢掉
    if (item.to <= cursor) continue;

    // 每段都从上一段的结束处开始：时间轴不允许留白，有空洞就由这一段吞掉
    const from = cursor;
    const to = clamp(Math.max(item.to, from + 0.5), from, total);
    result.push({
      from: round1(from),
      to: round1(to),
      action: item.action,
      ...(item.actionEn ? { actionEn: item.actionEn } : {}),
    });
    cursor = to;
    if (result.length >= MAX_BEAT_SEGMENTS) break;
  }

  if (result.length === 0) return undefined;

  result[0].from = 0;
  result[result.length - 1].to = round1(total);

  const cleaned = result.filter((beat) => beat.to > beat.from);
  return cleaned.length > 0 ? cleaned : undefined;
}

/** 秒 → 时间码（成片里的绝对位置，如 01:23） */
export function formatTimecode(seconds: number): string {
  const safe = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(safe / 60);
  return `${String(minutes).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
}
