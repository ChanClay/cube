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
 * 载具同框的镜头还要再吃 10~15 词：机位锚一句 + 每辆车在画面哪一侧 + 部位级接触点，
 * 按 110 词写就会出现「要么删掉机位锚、要么删掉车漆涂装」的二选一，两种都伤成片。
 */
export const PROMPT_MIN_WORDS = 40;
export const PROMPT_MAX_WORDS = 125;
/** 低于这个单词数视为不合格，会触发一次修复（比建议下限略宽，避免频繁返工） */
export const PROMPT_REPAIR_WORDS = 30;
/** 超过这个单词数视为啰嗦，会触发一次修复 */
export const PROMPT_REPAIR_MAX_WORDS = 170;

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
 * 卡片合并：当前剧本（用户在 UI 里看到、改过的那份）优先，蓝图只补它没有的名字，
 * 绝不覆盖用户改过的 desc / promptEn / imageUrl。
 *
 * 生成流水线内部两份内容本来就一致（蓝图刚被写进 script），所以这条规则不影响出稿；
 * 它只在「用户改过卡之后又触发本地化 / 审片修复」时起作用——
 * 这些步骤以前一律拿 plan 里的旧卡片，用户刚改好的空间短语会被悄悄顶回旧值。
 */
export function mergeCards<T extends { name: string }>(current: T[], planned: T[]): T[] {
  const kept = dedupeByName(current);
  const seen = new Set(kept.map((item) => item.name.trim()));
  const missing = dedupeByName(planned).filter((item) => !seen.has(item.name.trim()));
  return [...kept, ...missing];
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
  if (cut < 8) return head;
  /**
   * 在逗号 / 顿号 / 分号上截断时，标点要一起去掉：
   * 留着就成了「董卓乱政，十八路诸侯会于酸枣，」——念出来像话没说完，
   * 而句号、问号、叹号、省略号本身是收尾，保留。
   */
  const cutChar = head[cut];
  if ('，、；：'.includes(cutChar)) return head.slice(0, cut).trim();
  return head.slice(0, cut + 1);
}

/**
 * 台词设计。
 *
 * 模型最容易把台词写成「剧情说明书」：交代身份、复述上一场、把画面已经说清的
 * 信息再念一遍。台词一旦只是解释，观众就在听配图朗诵，而不是看戏。
 * 所以写台词前必须先做一次分析，四个问题答不上来就删掉这句。
 */
export const DIALOGUE_RULES = `台词是设计出来的，不是把剧情念出来。写每一句之前先回答四个问题，答不上来就删掉这句：
- 目的：这句要达成什么——说服 / 试探 / 拒绝 / 威胁 / 拖延 / 摊牌 / 求和？没有目的的台词只是在发音；
- 潜台词：为什么不能直说——隐瞒、身份、场合、怕失去对方？嘴上说的和心里要的必须不是同一件事；
- 变化：对方听到之后会怎么变——让步 / 反击 / 沉默 / 手停下来？说完什么都没变，这句就不该存在；
- 画面：这句说完，画面里出现什么可见变化（放下的手、移开的视线、熄灭的灯）？
其余硬约束：
- 一句台词只表达一个意思，10~20 字，口语、可念、带停顿；短句比长句有力，问句比陈述有戏；
- 不念设定：身份、世界观、上一场发生了什么，只要画面能拍到就不许由人物说出来；不许写「他心想」「他看着远方，思绪万千」这类既拍不出也念不出的内容；
- 画面已经说清的（谁受伤了、车翻了、灯灭了）台词不许复述；台词要说画面说不出来的部分——关系、意图、代价；
- 对白靠信息差推进：两个人知道的不是同一件事，台词才互相咬得住；双方都知情时，只能靠态度与潜台词区分；
- 台词与这一镜的动作互补，不重复：手上在拧灯罩，嘴上就别说「我在点灯」；
- 允许沉默：整镜没有台词（narrationType=none）比塞一句废话好；情绪最高点往往落在反应镜头而不是台词镜头；
- 旁白（voiceover）是有用的叙事工具，只在三处用最经济：开场交代前情、跨时空转场、收尾点题。标准写法是「空镜铺景 + 一句旁白讲清谁 / 在哪 / 为什么打」，背景交代完再切进人物开口——这样人物的第一句话不必自己解释设定。典型例子：十八路诸侯讨董的开场，一个帐外空镜 + 一句「董卓乱政，十八路诸侯会于酸枣」，下一镜直接进袁术的台词；
- 旁白只说画面给不出的信息：人物身份、时间跨度、因果、数量、结局。不许描述画面里正在发生的事（「他缓缓抬头」「她眼里含泪」——画面上有，耳朵里就不该再说一遍），也不许每镜都来一句：一镜最多一句，全片旁白句数不超过镜头数的一半，否则戏就变成配图朗诵。`;

/**
 * 一人一镜。
 *
 * 视频模型的音频是按「这一镜的台词」合成的：一镜里塞两个人的对白，
 * 它只会挑一句念出来（另一句凭空消失），或者让画面里两个人一起动嘴。
 * 所以「不同的人开口」必须对应「不同的镜头」——这不是风格选择，是结构性约束。
 */
export const SPEAKER_SHOT_RULES = `一人一镜：换人开口就必须换镜，这是硬规则，不是风格选择。
- 一个镜头只能有一个说话人：speaker 只有一个，narration 里也只能有这一个人说的话；
- 严禁把两个人的对白写进同一镜的 narration：「老陈：撤。」「小满：不撤。」、一问一答连写、两组以上带说话人标签的引号，都属于结构性错误——成片里模型只会挑一个人开口，另一个人的台词凭空消失，或者两个人都动嘴、口型全错；
- A 说完、B 接话 = 两个镜头：A 的镜头（近景 / 中景，带听者的肩或侧脸）→ hard-cut 反打 B 的镜头（带说话人的肩或后脑），transitionReason 写「反打承接 A 的话尾」；
- 同一说话人的连续几句可以留在同一镜里（用 beatSheet 分出「说第一句 / 停顿 / 说第二句」），但只要换人开口，必须切；
- 反应镜头独立成镜：听到关键台词的人单独占一镜（不开口，或只留一句短句），它承担情绪转折，不要塞进说话人的镜头里；
- 正反打守轴线：A 看画右，B 就看画左，机位停在两人连线的同一侧；要越轴必须先在中间垫一个中性机位（空镜、手部特写、背影跟拍）；
- 景别跟着权力关系走：占上风的一方给更紧的景别与更低的角度，让步的一方给更松的景别；不要双方同景别同构图；
- 说话人的镜头里必须有听者的一点存在（肩、后脑、耳、手），否则就成了独白；
- 全片至少 1 句 dialogue（用户明确要求无对白除外）；没有台词的镜头写 narrationType=none，不要用空字符串糊过去。`;

/** 说 / 问 / 答这类动词：名字后面跟着它们，说明这个人在这一镜里开口了 */
const SPEECH_VERB = '(?:说|道|问|答|喊|叫|开口|低语|嘟囔|回话|回应|接过话|自语|念道)';

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 这一镜的台词里还混进了谁在说话。
 *
 * 用于确定性检查「一人一镜」：模型把两个人的对白压进一镜时，
 * 会在 narration 里留下「小满答：」「老陈说」或者两行「名字：」的痕迹。
 * 只认这些硬证据，不做语义猜测——宁可漏报，也不要误报把单人台词判成多人。
 */
export function narrationSpeakerConflicts(
  shot: { narration?: string; speaker?: string; characterNames?: string[] },
  castNames: string[] = [],
): string[] {
  const narration = str(shot.narration);
  if (!narration) return [];

  const speaker = str(shot.speaker);
  const others = [...new Set([...castNames, ...(shot.characterNames ?? [])])]
    .map((name) => str(name))
    // 名字是说话人名的子串（「陈」vs「老陈」）时无法判定，跳过，避免误报
    .filter((name) => name && name !== speaker && !speaker.includes(name));

  const evidence = others.filter((name) => {
    const escaped = escapeRegExp(name);
    // 「小满答：」/ 换行后的「小满：」——剧本格式的对白标签
    const label = new RegExp(`(^|[\\n。！？；])\\s*${escaped}\\s*[：:]`);
    const withVerb = new RegExp(`${escaped}\\s*${SPEECH_VERB}`);
    return label.test(narration) || withVerb.test(narration);
  });

  // 同一镜里出现两个以上「名字：」标签：这是两人对白被塞进一镜的直接证据
  const labels = narration.match(/(^|[\n。！？；])\s*[^\s：:，。！？；「」“”"']{1,10}\s*[：:]/g) ?? [];
  const multiLabel = labels.length >= 2;

  if (!speaker) {
    // 没填 speaker 时，孤立的一个人名多半就是真正的说话人，交给「缺 speaker」那条规则
    return evidence.length >= 2 ? evidence : multiLabel ? ['多人对白'] : [];
  }
  if (evidence.length > 0) return evidence;
  return multiLabel ? ['多人对白'] : [];
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
 * 全片运动基调的作用域。
 *
 * motionEn 会被逐镜追加到**每一条**视频提示词的末尾，所以它只允许描述
 * 「任何一镜都成立的运动介质」。一旦写成剧情动作（战马冲入、提头掷地、斟酒），
 * 这些主体就会出现在每一镜里——帐内对话特写也会凭空冒出一匹马。
 * 这是「每个分镜结尾都有人策马」的唯一成因。
 */
export const MOTION_SCOPE_RULES = `全片运动基调的作用域（写错就会污染每一镜）：
- motion / motionEn 会被逐镜追加到每一条视频提示词的末尾，所以它只能写「任何一镜都成立的运动介质」：呼吸、衣料与发丝、尘土、火光、雨丝、蒸汽、风、车厢振动、地面掠过、光斑游走。它约束的是「动感从哪来」，不是「这一镜演什么」；
- 严禁把它写成剧情动作或具体主体：战马冲入 / 策马 / 提刀上马 / 斩 / 掷头 / 斟酒 / 跪拜 / 人群，都不许进 motionEn——它们只属于某几镜，被追加到每一镜就会让帐内特写里也出现一匹马、一具头、一壶酒；
- 反例（错）："Continuous motion: hand gestures, turning bodies, wine pouring, horse charge, ringing bells, head thrown to ground."——一条提示词同时塞了四个人物动作，每一镜都会被拍到这四个动作；
- 正例（对）："constant drifting dust, flickering firelight, swaying fabric, faint breath"——任何一镜都成立，它只负责让画面不死；
- 这一镜自己的动作写在 description 与 beatSheet 里，不要指望运动基调替你交代；全片确实全程都在骑马 / 追车时，把主体写进每一镜自己的 description，而不是塞进运动基调。`;

/**
 * 只属于某几镜的剧情动作与主体：出现在 motionEn 里就会被追加到每一镜。
 * 这里做一道确定性兜底，命中就把该分句剔掉（人物动作由每镜自己的描述负责）。
 */
const SCOPED_MOTION =
  /\b(horses?|hooves|hoofbeats?|gallop\w*|canter\w*|trot\w*|riders?|riding|mounted|swords?|blades?|spears?|halberds?|slay\w*|slain|behead\w*|decapitat\w*|severed|corpses?|blood\w*|wine|goblets?|kneel\w*|bowing|fists?|bows?)\b/i;

/** motionEn 被清空时的兜底：只写介质，不写任何主体 */
export const DEFAULT_MOTION_EN =
  'constant ambient motion, drifting dust, flickering light, fabric tremble';

export function stripScopedMotion(text: string): string {
  const value = str(text);
  if (!value) return '';
  const clauses = value.split(/\s*[,;，；]\s*/).filter(Boolean);
  const kept = clauses.filter((clause) => !SCOPED_MOTION.test(clause));
  if (kept.length === clauses.length) return value;
  const result = kept.join(', ').replace(/[.\s]+$/, '').trim();
  return result || DEFAULT_MOTION_EN;
}

/**
 * 空间坐标锚定。
 *
 * 「前 / 后 / 左 / 右」本身没有参照系：同一个 left 在模型那里可能指画面左侧、
 * 车辆自己的左侧、或者隔壁车道。文生视频模型不会追问「以谁为准」，
 * 它只会各自挑一个理解——这就是「写的是左后方超车、拍出来变成右前方对撞」的全部成因。
 * 解法不是把方向词写得更花，而是先把参照系写死。
 */
export const SPATIAL_ANCHOR_RULES = `空间坐标锚定（视频模型看不懂「前后左右」，是因为这些词没有参照系）：
- 一条提示词里只许用三套坐标系，且每次出现都必须点名参照系，不许裸写 left / right / front / behind：
  ① 画面坐标系（参照系＝画框）：frame left / frame right / frame center / the left third of frame / foreground / background——说主体落在哪里、朝哪一侧运动，跨镜方向一致性靠它；
  ② 机位坐标系（参照系＝镜头）：toward the camera / away from the camera / crossing frame from left to right——说迎面、远离、横穿；
  ③ 实体局部坐标系（参照系＝物体自己）：只用部位名词，不用方向词——front-left fender corner / rear-right quarter panel / B-pillar / driver door / front bumper / rear axle，说两车贴在哪里、撞在哪里、谁咬着谁；
- 画面里有两个以上主体（尤其载具）时，提示词第一句必须是机位锚：镜头装在哪、朝哪、多高、多近——"camera mounted low on the rear bumper of the blue sedan, looking forward over both roofs"（8~14 词）；
- 词序：机位锚 → 空间布局（谁在画面哪一侧、占画多少、谁挡住谁）→ 动作与接触点 → 环境与光线。先搭空间，再让主体动；空间没写清就写动作，模型只能各自摆放主体；
- 「前后」在一镜里只能有一个含义：前进方向写 ahead / behind along the road，画面纵深写 foreground / background，两者不许混用；
- 相对位置写成「实体 + 部位 + 相对 + 实体 + 部位」的三角关系，不要只给方向：用 "the red car's nose level with the black car's rear door" 代替 "the red car on the left"；
- 方位词首次出现必须带限定（frame left / the black car's left flank / the left-hand lane），同一段第二次出现才可以省；
- 同向追逐的两辆车只有一个合法相对位置：同一条车道中心线、一前一后（on the same lane centerline, directly behind / ahead along the road）。写 beside / alongside / next to / side by side 会让模型把后车摆到本车侧方——画面里两车的夹角从 180° 变成 90°，蛇形追逐立刻读成十字交叉；
- 中文 description / entryState 与英文用同一套参照系：不许中文写「车尾左后方」、英文写成 front right——方位错位比词不达意更致命，成片会直接撞错位置。`;

/**
 * 镜面镜头（后视镜 / 侧镜 / 监视器屏幕）的写法。
 *
 * 这是文生视频模型最稳定复现的一个误读：写 "close-up of the rear-view mirror"
 * 而不锁画框时，模型把镜子当成画面里的一个「物体」，为它补一扇侧窗和一个车内视角，
 * 于是后车出现在侧窗外、横着掠过——两车的 180° 同轴关系被拍成 90°。
 * 解法与空间锚定同源：先把「画框就是镜面」焊死，再写镜中的同轴关系与镜像方向。
 */
export const MIRROR_SHOT_RULES = `镜面镜头（后视镜 / 侧镜 / 监视器屏幕）：
- 画面里出现镜中反射时，第一句必须是镜面锚，把画框与镜面焊在一起："the entire frame is the reflective glass of the rear-view mirror, the mirror housing edges running just inside the frame borders"。只写 "close-up of the rear-view mirror" 而不锁画框，模型会把镜子当成画面里的物体，顺手补一扇侧窗，后车就从侧窗外横着过；
- 镜面镜是 POV：镜头位置就在镜面处，朝车尾方向看（camera positioned at the mirror, looking rearward）。不许写成从车内某个位置往后视镜方向拍——那一定连带 A 柱 / 车门 / 侧窗，一旦侧窗入画，模型的整幅画面基准就转向侧面；
- 镜中后车必须与镜面同轴：on the same lane centerline, directly behind, its headlights centered in the glass, growing larger——用「两车共享同一条消失线」（both vehicles on one vanishing line down the center of the glass）一句锁住追逐关系，接触点写车头咬后保险杠（its front bumper closing on our rear bumper），不写「不远处有一辆车」；
- 镜像左右是反的，必须显式声明，否则镜中的运动方向会被拍反或拍成横向："mirrored left-right, the car approaching from our rear-left grows from frame right toward frame center"；
- 镜面镜里禁止出现 side window / door window / A-pillar / door panel / door frame / dashboard，也禁止 beside / alongside / next to / perpendicular / crossing 这类横向词：它们会把同轴追逐读成并排或交叉；
- 确实要「人 + 镜中车灯」同框时，镜面只占画面上三分之一（the mirror glass occupies the upper third of frame），镜面以外的区域只允许顶棚与挡风玻璃上缘；做不到就拆成两镜：纯镜面特写 + 车内人物特写。`;

/**
 * 视频提示词的写法约束。storyboard 与单镜重算共用同一份，
 * 避免两处对「多少词、写什么顺序」给出不同要求。
 */

/**
 * 视频提示词的写法约束。storyboard 与单镜重算共用同一份，
 * 避免两处对「多少词、写什么顺序」给出不同要求。
 */
export const VIDEO_PROMPT_RULES = `videoPrompt 是同一镜中文 description 的忠实英译，不是重新创作：中文里写到的每个主体、动作、道具、环境、光线都必须在英文里有对应；中文里没有的元素一律不许增加，也不许删掉任何一个。
- 必须是英文，一段话，${PROMPT_MIN_WORDS}~${PROMPT_MAX_WORDS} 个单词，按这个顺序写：景别 + 主体（固定英文外貌短语）+ 机位锚（两个以上主体 / 载具镜必写）+ 空间布局 + 具体动作 + 环境细节 + 光线 / 时间 / 色调 + 运镜 + 画面质感 +（可选）一句声音；
- 景别只用标准英文写法：${SHOT_SIZES.map((s) => `${SHOT_SIZE_EN[s]}（${s}）`).join(' / ')}，必须与 shotSize 一致；
- 只写一个运镜，用标准英文运镜词，且必须与 cameraMove 的中文含义一致（${CAMERA_MOVES.map((m) => `${m}=${CAMERA_MOVE_EN[m][0]}`).join('，')}）；
- 运动必须是一条连续、匀速、符合真实时间的动作链，用 "constant subtle motion, no frozen frame" 收尾。一镜可以有多个连续动作，但必须是同一个主体在同一空间里顺着做下来的：beatSheet 的每一段都要在英文里有对应，按时间顺序用并列的现在分词短语串起来。不要写 first / then / after that / finally 这类时间副词，也不要让多个人物同时各做各的——模型会把画面切成两段，接缝处就是抽帧般的抖动；
- 不要写 "slow motion"（除非 cameraMove=升格慢动作）、"time-lapse"、"speed ramp"、"jump cut"、"flicker"、"morphing" 这类会让速度忽快忽慢或画面跳变的词；
- 禁止字幕、文字、水印、logo、分屏、转场词、镜头编号（如 "shot 1" / "scene 2"）；
- 只写可拍摄的名词与动词，不要用 "beautiful" / "sad" 单独代替画面；
- 同一角色在全片复用同一段英文外貌短语，不要逐镜改写年龄、发型、服装、装甲与涂装、道具。
${SPATIAL_ANCHOR_RULES}
${MIRROR_SHOT_RULES}
${MOTION_BASELINE_RULES}`;

/**
 * 跨镜连贯性的写法约束。分镜写作与审片共用：
 * 连贯性不能靠「记得上一镜」，必须是一条写在纸上的状态链。
 */
export const CONTINUITY_RULES = `每个镜头都要显式写出 entryState 与 exitState，它们是状态链上唯一可靠的锚点：
- entryState：本镜第一帧能拍到的画面事实——谁、在哪、什么姿势、朝向哪里、手里拿着什么、画面里还有什么道具；非第一镜必须与上一镜的 exitState 是同一个状态（可以换措辞，但人物、位置、姿势、道具不能变）；
- entryState 按四段写，少一段就是一个连续性的洞：① 承接——上一镜最后一帧真正可见的事实（主体位置 / 姿态 / 朝向 / 手持物），以画面为准、不以上一镜的 characters 名单为准（凭空多出的乘客、穿错的衣服都是这么来的）；② 空间——本镜所在的容器几何，并点名两个以上固定件（车厢：方向盘 / 仪表台 / 后视镜 / A 柱 / 车窗框 / 雨刷；走廊：门框 / 踢脚线 / 消防栓 / 顶灯）；③ 机位——镜头相对主体的方位、高度、距离感，且必须点名参照系：镜头在谁的哪一侧、朝哪个方向看、多高、多近（「两车车尾视角」「副驾侧 45°」「与方向盘同高」都属于这一项）；方位混着写（画面左 / 车身左 / 车道左不分）是左右翻转的源头；④ 环境——光源方向与色温、窗外或背景锚点、运动感。time-jump 时 ②③ 按新场地写；
- 特写 / 近景不是「把环境删掉只拍脸」：必须写明容器、至少两个容器固定件、主光方向与色温；机位保持在轴线一侧、用中长焦观感（约 85~135mm），禁止穿过挡风玻璃正面平视、90° 广角正侧切、大角度俯拍、镜头贴脸且画面里没有任何固定件；
- 室内 / 座舱内饰（仪表台、座椅、顶灯、舷窗、舱壁）必须落成全片逐字复用的英文短语（写进场景卡或载具卡的 promptEn），不许逐镜改写形容词——内饰描述越自由，内饰漂得越狠；
- exitState：本镜最后一帧的画面事实，必须能被下一镜直接接住；不许写情绪、心理或抽象判断；
- 只要这场戏本身在运动（追车、奔跑、飞行、坠落、打斗），首尾状态就必须写清三件事——特写与近景也不例外（那时画面里只有一张脸、一只手，最容易把整场戏的运动丢掉）：主体在画面里的位置与大小（以画框为参照：画面左 / 中 / 右、占画多少，不写物体自身的左右）、运动方向与速度（朝画右加速、迎面逼近）、一个贯穿场景的背景锚点（同一条路、同一盏灯、同一个弯道）。特写里没有完整运动主体时，改写成背景与介质的速度——窗外景物横掠、地面飞速后退、雨丝斜向划痕；
- 换机位不换世界：hard-cut / time-jump 可以换构图，但下一镜的 entryState 仍要重复上一镜的运动方向与背景锚点——方向翻转、锚点消失，观众看到的就是另一场戏；
- 出口必须是可切帧：最后一拍结束时主体仍在画面内，动作到达一个可辨认的相位（车头咬住前车、车身摆正、轮子落回地面）。禁止用「冲出画外 / 消失在黑暗或雨幕 / 完全虚化」收尾——这类结尾没有落点，下一镜怎么切都接不上；确实要以遮挡 / 甩镜交出去时，本镜写 hiddenCut: true；
- 上一镜没做完的动作，本镜接着做完；人物位置、道具、服装、光线不许在两镜之间凭空改变；
- 确实要跳时间或换场地时，本镜 entryState 里必须写清跳转（例：「片刻后，老陈已经站在塔顶，手里仍握着那盏油灯」）。`;

/**
 * 末帧参考的档位判定。
 *
 * 分镜写作与审片修复共用这一份；真正怎么用由景别跨度决定，
 * 运行时判定见 lib/skills/shot-media 的 prevFrameUsage。
 * 写「一律 false」会把特写唯一的空间情报丢掉，写「一律 true」会换来一次突兀的推拉。
 */
export const PREV_FRAME_RULES = `referencePrevFrame 是「这一镜要不要用上一镜的最后一帧」，按档位写，不许一律 false：
- same-take 不看这个字段：同景别且上一镜未出画时自动当首帧，景别变了或上一镜已出画则什么都不接；
- 同场景 hard-cut 且景别跨度 0：留空或写 true，末帧当首帧，接缝完全连续（代价是本镜传不了卡片）；
- 同场景 hard-cut 且景别跨度 1，或标了 hiddenCut：留空即自动降级成参考图——只借光线、材质与空间，构图按本镜重来；
- 同场景 hard-cut 且景别跨度 ≥2：末帧用不上，写 true 无效且校验会报错。先把序列改掉——中间垫一档（大远景 → 全景 / 中景 → 特写），或用 hiddenCut（俯冲贴车窗、穿过挡风玻璃、雨刷 / 甩镜 / 暗部盖过画面）做成一次隐蔽换机位——再写字段；
- time-jump、换场景：写 false；跨场景只有确实要借同一光线基调时才写 true。
大景别直切特写（航拍 → 车内人物特写）就是跨度 ≥2 的典型事故：上一镜只给了一张车顶俯视图，本镜却要重建整个座舱，内饰、机位、光源全能凭空发明。这种接缝靠改序列解决，不靠字段。`;

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
  /**
   * 分母取较小的一侧，而不是固定用「当前这一段」：
   * entryState 现在要求四段（承接 / 空间 / 机位 / 环境），字数天然多于上一镜的 exitState，
   * 按当前段覆盖率会把「接住了、只是补了机位与光源」误判成状态链断开。
   */
  return shared / Math.min(a.size, b.size);
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
