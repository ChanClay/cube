import { hasCarryFrame, hasPrevFrameReference } from './media';
import { blockingClause, sceneAnchorClause } from './scene-anchor';
import { stripScopedMotion } from './spec';
import type { MediaInput, Scene, Shot, ShotBeat } from '@/lib/types';

type PromptShot = Pick<Shot, 'narration' | 'narrationType' | 'speaker'> &
  Partial<
    Pick<
      Shot,
      | 'characterNames'
      | 'beatSheet'
      | 'description'
      | 'entryState'
      | 'exitState'
      | 'blockingEn'
      | 'backgroundCast'
    >
  >;

/**
 * 把台词拼进视频提示词。
 *
 * 两个模型都是「台词必须写进 prompt 才会被说出来」（写法是
 * `说道：“今天的阳光真好。”` 这种「动词 + 引号」）：
 * - HappyHorse 1.1 原生音视频联合生成，台词会被真的念出来并做到音素级口型同步；
 * - wan3.0 在 audio 打开时同样原生出声。
 * 画面描述继续用英文，台词保持原文——两者都支持中英混写。
 *
 * 注意：HappyHorse 没有 audio 开关（音轨关不掉），也不接受 `reference_audio`，
 * 所以音色只能靠文字描述，无法用参考音频锁定。
 */

/** 台词内部的引号会破坏外层结构，统一换成单引号 */
function safeQuote(line: string): string {
  return `"${line.replace(/["“”]/g, "'")}"`;
}

/** 已经有句末标点就不重复加 */
function withEnd(text: string): string {
  return /[.!?。！？…"”]$/.test(text) ? text : `${text}.`;
}

/**
 * 带上一镜末帧当参考图时追加的稳定句。
 *
 * 必须把作用范围写死：模型的 reference_image 是「角色 / 物品 / 风格参考」，
 * 不给边界它会连构图和机位一起抄。这里只借光线与材质，
 * 景别、机位、构图回到本镜自己的描述。
 *
 * 唯一要延续的是「串联」本身：同一轴线侧、同一运动方向。
 * 这是换景别时两镜仍像同一次拍摄的依据——末帧可以不给构图，但不能连方向也一起丢掉。
 */
const FRAME_REFERENCE_STYLE =
  'Match the lighting, color temperature and scene materials of the reference image, ' +
  'but keep the framing, shot size and camera angle described above exactly. ' +
  'Stay on the same side of the action axis and keep the same screen direction of travel as the reference; only the framing changes.';

/** 英文并列：A / A and B / A, B and C */
function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * 限定句 + 点名参考图里的人物。
 *
 * 两个坑必须同时堵住：
 * 1. 不点名 —— 模型只会把末帧当调色板，人物身份信息全浪费；
 * 2. 说「保持位置」—— 换机位时位置必然变，模型会把参考图里的人留在原位，
 *    再按文字描述画一个，于是同一个人出现两次。所以只锁脸和服装，并显式禁止重复。
 */
function frameReferenceClause(cast: string[], characterCount = 0, crowd: string[] = []): string {
  const names = cast
    .map((name) => name.trim())
    .filter(Boolean)
    .slice(0, 4);

  const identity =
    names.length === 0
      ? crowd.length === 0
        ? 'The reference image is the last frame of the previous shot; ' +
          'do not duplicate or add any character from it.'
        : 'The reference image is the last frame of the previous shot; ' +
          'keep the same people and the same crowd as in it.'
      : `The reference image is the last frame of the previous shot and shows ${joinNames(names)} ` +
        `— the same ${names.length > 1 ? 'characters' : 'person'} described above, not ` +
        `${names.length > 1 ? 'additional characters' : 'an additional character'}. ` +
        'Keep only their faces and wardrobe consistent; do not duplicate them.';

  /**
   * 背景人群必须点名并锁人数。
   *
   * 没有卡的人不在名单里，模型会把「一群人」当成背景噪声重画：
   * 上一镜结尾站着一群人，本镜就只剩角色卡上的那一个主角。
   * 人群短语已经在正文里出现过（crowdClause），这里只做指代，避免同一段提示词把人写两遍。
   */
  const crowdLine =
    crowd.length > 0
      ? ' The reference image also contains the same background crowd described above; keep its headcount and wardrobe unchanged.'
      : '';

  // 单人镜头多出一个人是最常见的错误，直接给个人数上限；本镜有人群时这条会把人删光
  const count = characterCount === 1 && crowd.length === 0 ? ' Only one person appears in frame.' : '';

  return `${identity}${crowdLine}${count} ${FRAME_REFERENCE_STYLE}`;
}

/**
 * 接帧镜（上一镜末帧当首帧）的限定句。
 *
 * 首帧就是上一镜最后一帧，人物本来就在画面里；但模型会连「一个人」和
 * 「一群人」一起重画：不点名、不锁人数，末帧里的一群人就缩成主角一个。
 */
function carryFrameClause(cast: string[], characterCount = 0, crowd: string[] = []): string {
  const names = cast
    .map((name) => name.trim())
    .filter(Boolean)
    .slice(0, 4);

  const people = names.length > 0 ? ` and shows ${joinNames(names)}` : '';
  // 人群短语已在正文 crowdClause 里写过一次，这里只指代，避免重复描述导致人数被画两倍
  const crowdLine =
    crowd.length > 0
      ? ' The frame also contains the same background crowd described above; keep its headcount and wardrobe unchanged.'
      : '';
  const count = characterCount === 1 && crowd.length === 0 ? ' Only one person appears in frame.' : '';

  return (
    `This shot begins on the exact last frame of the previous shot${people}. ` +
    'Keep every person visible in that frame — including any background crowd — with the same faces, wardrobe and headcount; ' +
    `do not replace them with a single character or add new people.${crowdLine}${count}`
  );
}

/**
 * 背景人群（没有主体卡的人）的英文短语。
 *
 * 逐字复用 backgroundCast.promptEn：人群不登记，每一镜的人数、装扮、队形
 * 都会被模型重新发明，跨镜接缝上就出现「一群人变一个人」。
 */
function crowdNames(shot: PromptShot): string[] {
  return (shot.backgroundCast ?? [])
    .map((item) => (item.promptEn ?? '').trim())
    .filter(Boolean)
    .slice(0, 3);
}

/** 本镜画面里的背景人群：始终拼进提示词，与有没有末帧参考无关 */
function crowdClause(crowd: string[]): string {
  if (crowd.length === 0) return '';
  return ` Background crowd (keep the same headcount and wardrobe throughout the shot): ${joinNames(crowd)}.`;
}

/**
 * 秒级时间轴。
 *
 * videoPrompt 是一条连续动作链，模型不知道哪一拍落在第几秒；beatSheet 有英文
 * actionEn 时，把它按秒拼成时间轴一起提交，特写 / 长镜才不会被演成一整段静止画面。
 * 措辞必须写清「与上文是同一组动作」，否则模型会把两套动作各演一遍。
 */
function timelineClause(beats?: ShotBeat[]): string {
  const parts = (beats ?? []).flatMap((beat) => {
    const en = beat.actionEn?.trim();
    return en ? [`${beat.from}-${beat.to}s: ${en}`] : [];
  });
  if (parts.length === 0) return '';
  return ` Timeline (the same actions described above, timed exactly): ${parts.join('; ')}.`;
}

export function buildVideoPrompt(
  prompt: string,
  shot: PromptShot,
  media: MediaInput[] = [],
  /** 参考图里实际在场的人物名（见 lib/skills/shot-media 的 prevFrameCast） */
  refCast: string[] = [],
  /**
   * 全片运动基调的英文短句（Script.motionEn）。
   * 逐镜追加：没有它，模型会在某个特写镜头上把整场戏的速度忘掉，
   * 把「高速追车中的一帧」拍成「一个人坐在车里」。
   */
  motionEn?: string,
  /**
   * 本镜的主场景卡（见 lib/skills/scene-anchor 的 primaryScene）。
   *
   * 场景短语以前只写在给 LLM 的规则里，运行时从不读取，模型漏抄就没有兜底；
   * 现在在这里硬拼：场景短语没被复用就补一句地点锚定，
   * 分镜提到而英文提示词漏写的陈设补上英文名与位置。
   */
  scene?: Scene | null,
): string {
  const base = (prompt ?? '').trim();
  const line = (shot.narration ?? '').trim();
  const timeline = timelineClause(shot.beatSheet);
  /**
   * 运动基调是逐镜追加的，必须只当「动感」用：
   * 一是剔掉剧情动作与具体主体（战马冲入 / 提头掷地），否则每一镜都会长出它们，
   * 帐内特写也会跑出一匹马——库里已有的旧剧本也在这里被兜住；
   * 二是显式禁止它引入本镜没写的主体，模型对否定句式的服从度比默默忽略高。
   */
  const safeMotion = motionEn?.trim() ? stripScopedMotion(motionEn) : '';
  const motion = safeMotion
    ? ` Overall motion (motion quality only, never add a person, animal or object not described above): ${safeMotion}.`
    : '';
  // 场景锚定、走位与人群放在最后：它们只补漏掉的空间事实，不参与动作链
  const anchor = sceneAnchorClause(shot, scene, base);
  const blocking = blockingClause(base, shot.blockingEn);
  const crowd = crowdNames(shot);
  /** 画面描述 + 秒级时间轴 + 运动基调 + 场景锚定 + 走位 + 背景人群：旧剧本没有这些字段时不会多出任何内容 */
  const extras = `${timeline}${motion}${anchor}${blocking}${crowdClause(crowd)}`;
  const body = extras ? `${withEnd(base)}${extras}` : base;
  const characterCount = (shot.characterNames ?? []).length;
  /**
   * 末帧参考（借光线 / 重构构图）与接帧（首帧就是上一镜末帧）都要点名图里的人。
   * 不点名时模型只会把末帧当调色板，末帧里的一群人在本镜被重新数一遍。
   */
  const reference = hasPrevFrameReference(media)
    ? ` ${frameReferenceClause(refCast, characterCount, crowd)}`
    : hasCarryFrame(media)
      ? ` ${carryFrameClause(refCast, characterCount, crowd)}`
      : '';

  // 没写台词，或明确选了「都不要」：画面描述原样提交，模型只出环境音/BGM
  if (!line || shot.narrationType === 'none') {
    return reference ? `${withEnd(body)}${reference}` : body;
  }

  if (shot.narrationType === 'dialogue') {
    /**
     * 多人物镜头里只写 "The character" 会让模型挑错人开口，
     * 所以把说话人名字写进提示词；没有 speaker 的旧剧本保持原行为。
     */
    const speaker = (shot.speaker ?? '').trim();
    const who = speaker ? `The character named ${speaker}` : 'The on-screen character';
    return `${withEnd(
      `${body} ${who} speaks with natural lip movement and matching facial expression: ${safeQuote(line)}`,
    )}${reference}`;
  }

  // 缺省按画外旁白处理：人物闭嘴，避免旧剧本全变成人物在说话
  return `${withEnd(
    `${body} Voiceover by an off-screen narrator (no lip movement, the character's mouth stays closed): ${safeQuote(line)}`,
  )}${reference}`;
}
