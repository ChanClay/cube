import { MAX_MEDIA_TOTAL, isCarryFrameUrl } from './media';
import { pickSceneImage, resolveShotScenes } from './scene-anchor';
import type { MediaInput, Scene, Script, Shot, ShotTransition } from '@/lib/types';

/**
 * 镜头级的自动素材关联。
 *
 * 几条硬规则：
 * 1. 角色卡 / 场景卡是「设计参考」，一律作为 reference_image，
 *    不再当首帧——单人设定图当首帧会把整段视频压成同样的背景。
 * 2. 上一镜末帧也一律作为 reference_image 注入，不再占用 first_frame 参数：
 *    首帧参数会把本镜第 0 帧钉死在上一镜的构图上（全景缓慢推进接中景固定机位时，
 *    生成退化成一次反向拉镜头，分镜写的剪辑节奏消失，而且首帧与卡片互斥，
 *    越是需要重新取景的镜头反而把角色卡全丢掉）。改成参考图后，提示词负责告诉
 *    模型「视频从这张图开始、围绕它重新取景发散」，卡片也能同时传入。
 * 3. first_frame 参数只留给用户手动指定的场景：用户手选首帧时完全尊重，
 *    自动注入不再产生它。
 * 4. 跨场景 / 时间跳转不自动带末帧：旧场景的光线会把新场景带歪；
 *    跨场景只有手动打开才带（只借光线与色调）。
 */

export const TRANSITION_LABEL: Record<ShotTransition, string> = {
  'same-take': '承接上一镜',
  'hard-cut': '硬切换机位',
  'time-jump': '时间/空间跳转',
};

export const TRANSITION_HINT: Record<ShotTransition, string> = {
  'same-take':
    '同一动作被切成两镜：抽上一镜末帧作起始参考图，本镜从这张图开始继续拍；角色卡 / 场景卡照常传',
  'hard-cut':
    '换角度 / 换景别：同场景时抽上一镜末帧作起始参考图，围绕它重新取景发散；换场景不自动带帧',
  'time-jump': '时间或地点跳转：不带末帧，走角色卡 / 场景卡参考图',
};

/**
 * 这一镜要不要抽上一镜末帧当首帧。
 * 新剧本看 transition；旧剧本没有这个字段时回落到 continueFromPrev。
 */
export function isSameTakeShot(shot: Shot): boolean {
  if (shot.transition) return shot.transition === 'same-take';
  return shot.continueFromPrev === true;
}

/**
 * 上一镜末帧在这一镜里的角色：
 * - reference_image：作为起始参考图带入，提示词会告诉模型「从这张图开始拓展」
 * - null：不用（时间跳转、换场景且未手动打开、第一镜）
 * （'first_frame' 仍在类型里：老调用方没有 shot 时回落为当首帧；用户手选首帧不受影响）
 */
export type PrevFrameUsage = 'first_frame' | 'reference_image' | null;

/**
 * 上一镜末帧里实际在场的人物。
 *
 * 优先用视觉识别 / 人工确认写入的 `lastFrameCast`；没有时退回本镜的出镜角色，
 * 那只是分镜时的「意图」，但总比让模型瞎猜强。
 */
export function prevFrameCast(prev: Shot | null): string[] {
  if (!prev) return [];
  if (prev.lastFrameCast && prev.lastFrameCast.length > 0) return prev.lastFrameCast;
  return (prev.characterNames ?? []).filter(Boolean);
}

export function prevFrameUsage(shot: Shot, prev: Shot | null): PrevFrameUsage {
  if (!prev) return null;

  /**
   * same-take 的物理前提是「摄影机没停机」：末帧就是事实上的起始画面，
   * 无论景别是否跳变都带上（作为起始参考图而非首帧参数，
   * 模型从它开始继续拍，而不是被钉死在第 0 帧的构图上）。
   */
  if (isSameTakeShot(shot)) return 'reference_image';

  // 分镜 / 用户关掉了就完全不抽
  if (shot.referencePrevFrame === false) return null;
  if (shot.transition === 'time-jump') return null;

  const prevScene = (prev.sceneNames ?? []).join('|');
  const scene = (shot.sceneNames ?? []).join('|');
  const sameScene = !!prevScene && !!scene && prevScene === scene;

  // 跨场景只有手动打开才带末帧，此时只借光线 / 色调，不让旧构图跟过来
  if (!sameScene) return shot.referencePrevFrame === true ? 'reference_image' : null;

  /**
   * 同场硬切：任何景别跨度都把末帧作为起始参考图带上。
   * 不再占用 first_frame 参数后，末帧不会把本镜钉死在上一镜的构图里，
   * 全景推进接中景固定机位这类「围绕末帧重新取景」的衔接成为可能；
   * 景别跨度越大，越依赖提示词里「按本镜景别重新取景」的约束，
   * 而角色卡 / 场景卡也不再因为互斥被丢掉。
   */
  return 'reference_image';
}

/** 单次最多 9 张参考图（HappyHorse r2v 上限，与 lib/skills/media.ts 的 reference_image 上限一致） */
const MAX_REFERENCE_IMAGES = 9;

/** 场景卡是否有任何可用配图（主图或机位图集里的任意一张） */
function sceneHasImage(scene: Scene | null | undefined): boolean {
  if (!scene) return false;
  return !!scene.imageUrl || (scene.angleRefs ?? []).some((ref) => !!ref.imageUrl);
}

/** 全片角色卡 + 场景卡的配图地址，用来识别上一轮自动注入的素材 */
export function autoCardUrls(script: Script | null): Set<string> {
  if (!script) return new Set();
  const urls = [
    ...script.characters.map((character) => character.imageUrl),
    ...(script.scenes ?? []).flatMap((scene) => [
      scene.imageUrl,
      ...(scene.angleRefs ?? []).map((ref) => ref.imageUrl),
    ]),
  ];
  return new Set(urls.filter((url): url is string => !!url));
}

/**
 * 这一镜应该关联哪些卡片：
 * - 角色：本镜出镜角色；分镜漏标时，描述 / 提示词 / 台词里点名的也补上
 * - 场景：本镜所在场景；没标时按描述里的场景名匹配；全片只有一个场景时直接用它
 */
export function collectCardMedia(shot: Shot, script: Script | null): MediaInput[] {
  if (!script) return [];

  const text = [shot.title, shot.description, shot.videoPrompt, shot.narration]
    .filter(Boolean)
    .join('\n');
  const characterNames = new Set(shot.characterNames ?? []);
  const sceneNames = new Set(shot.sceneNames ?? []);
  const result: MediaInput[] = [];
  const seen = new Set<string>();

  /** name 记下这张卡属于谁，用于和末帧里的人物去重（同一个身份只留一份参考） */
  const push = (url: string, name: string) => {
    if (!url || seen.has(url) || result.length >= MAX_REFERENCE_IMAGES) return;
    seen.add(url);
    result.push({ type: 'reference_image', url, name, auto: true });
  };

  // 角色在前：人物的长相一致性比背景更关键
  for (const character of script.characters) {
    if (!character.imageUrl) continue;
    const mentioned = character.name && text.includes(character.name);
    if (characterNames.has(character.name) || mentioned) push(character.imageUrl, character.name);
  }

  /**
   * 场景只挂本镜标注的那几个。
   *
   * 这里以前还有一条「描述里提到场景名就挂」的兜底：后段镜头的描述 / 旁白里只要出现
   * 「回到灯塔」这类旧地标，片头场景卡就会被当成参考图一起送进视频模型，
   * 画面被拉回开头的地点与色调。场景归属由分镜阶段负责，这一层不再做文本推断。
   */
  const scenes = script.scenes ?? [];
  /** 分镜有没有显式标注场景（sceneIds 或旧数据的 sceneNames） */
  const declared = (shot.sceneIds ?? []).length > 0 || sceneNames.size > 0;
  const resolved = resolveShotScenes(script, shot);

  /**
   * 一张场景卡可能挂多个机位图（angleRefs）：只按本镜景别挑一张。
   * 整个图集塞进去会挤掉角色卡的参考位（上限 9 张），人物一致性优先；
   * 而且广角空镜当特写镜的背景参考时，模型会把构图一起拉远。
   */
  for (const scene of resolved) {
    const url = pickSceneImage(scene, shot);
    if (url) push(url, scene.name);
  }

  // 本镜确实没标场景时才按文本推断，且只取名字最长（最具体）的一张，避免多张场景卡互相打架
  if (!declared) {
    const hits = scenes.filter((scene) => sceneHasImage(scene) && scene.name && text.includes(scene.name));
    const best = hits.length
      ? hits.reduce((longest, scene) => (scene.name.length > longest.name.length ? scene : longest))
      : null;
    const url = pickSceneImage(best, shot);
    if (best && url) push(url, best.name);
  }

  // 全片只有一个场景、镜头又没标场景：默认就是它（判断按「有没有挂过场景卡」，不是 result 是否为空）
  const hasSceneCard = resolved.some(sceneHasImage);
  if (!hasSceneCard && !declared && scenes.length === 1) {
    const only = scenes[0];
    const url = pickSceneImage(only, shot);
    if (url) push(url, only.name);
  }

  return result;
}

const isFrame = (type: MediaInput['type']): boolean =>
  type === 'first_frame' || type === 'last_frame';

/**
 * 用户自己指定的首帧。自动注入的抽帧、旧版注入的卡片首帧都不算，
 * 否则会被误判成「用户手选」，导致每轮都不再注入新的衔接素材。
 * （尾帧不影响抽帧，所以这里不看 last_frame。）
 */
export function hasManualFirstFrame(media: MediaInput[], script: Script | null): boolean {
  const cardUrls = autoCardUrls(script);
  return media.some(
    (item) =>
      item.type === 'first_frame' &&
      !item.auto &&
      !isCarryFrameUrl(item.url) &&
      !cardUrls.has(item.url),
  );
}

export interface ResolvedShotMedia {
  next: MediaInput[];
  /** carry=老调用方（无 shot）把末帧当首帧注入；cards=补了卡片参考图；null=没动 */
  source: 'carry' | 'cards' | null;
  /** 本次新挂上的素材 */
  injected: MediaInput[];
  /** 因为槽位不足而没挂上的卡片数量 */
  skippedCards: number;
  /** 是否把上一镜末帧作为起始参考图带了进去 */
  withPrevFrameRef: boolean;
  /** 末帧里实际在场的人物（用于在提示词里点名）；没带末帧时为空 */
  prevFrameCast: string[];
  /** next 与传入的 media 是否不同（不同才需要写回剧本） */
  changed: boolean;
}

const sameMedia = (a: MediaInput[], b: MediaInput[]): boolean =>
  a.length === b.length &&
  a.every((item, index) => item.type === b[index].type && item.url === b[index].url);

/**
 * 重新计算这一镜的自动素材：
 * - 先摘掉上一轮自动挂的抽帧 / 卡片图，避免旧素材挡住新决策；
 * - 用户手选首尾帧时完全尊重，不再自动注入；
 * - 上一镜末帧一律作为起始参考图注入（不再占用 first_frame 参数），
 *   与卡片参考图共存，提示词负责「从这张图开始拓展」；
 * - 换场景、时间跳转的镜头走卡片参考图（跨场景手动打开才带末帧）。
 */
export function resolveShotMedia(
  media: MediaInput[],
  prevFrame: MediaInput | null,
  cards: MediaInput[],
  script: Script | null,
  shot: Shot | null = null,
  prev: Shot | null = null,
): ResolvedShotMedia {
  const cardUrls = autoCardUrls(script);
  /**
   * 抽到的末帧怎么用，由上一镜与本镜的关系决定（见 prevFrameUsage）：
   * 同场衔接（same-take / 同场硬切）与跨场景手动打开时作为起始参考图；其余情况不用。
   * 没有 shot 的老调用方保持原行为：末帧当首帧。
   */
  const usage: PrevFrameUsage = shot ? prevFrameUsage(shot, prev) : 'first_frame';
  const carryFrame = usage === 'first_frame' ? prevFrame : null;
  const referenceFrame = usage === 'reference_image' ? prevFrame : null;
  let usedRef = false;
  let usedCast: string[] = [];

  const finish = (
    next: MediaInput[],
    source: ResolvedShotMedia['source'],
    injected: MediaInput[],
    skippedCards: number,
  ): ResolvedShotMedia => ({
    next,
    source,
    injected,
    skippedCards,
    withPrevFrameRef: usedRef,
    prevFrameCast: usedCast,
    changed: !sameMedia(next, media),
  });

  const rest = media.filter((item) => {
    if (item.auto) return false;
    // 上一轮抽出来的衔接帧，这一轮重新抽
    if (item.type === 'first_frame' && isCarryFrameUrl(item.url)) return false;
    // 旧版把角色卡 / 场景卡当首帧注入过，直接摘掉
    if (item.type === 'first_frame' && cardUrls.has(item.url)) return false;
    return true;
  });

  // 用户手选首帧：完全不动。尾帧可能同时存在，但 i2v 只接受一张 first_frame，提交时尾帧会被丢弃
  if (rest.some((item) => item.type === 'first_frame')) {
    return finish(rest, null, [], cards.length);
  }

  const hasReferences = rest.some((item) => !isFrame(item.type));

  // 首帧优先：仅剩老调用方（无 shot）会走到这里——末帧当首帧时不能塞参考图，否则会被路由到 r2v
  if (carryFrame && !hasReferences) {
    const injected: MediaInput = { ...carryFrame, auto: true };
    /**
     * 首帧就是上一镜末帧，人物名单同样要交给提示词：接帧镜没有卡片，
     * 不点名的话模型会把末帧里的一群人压成角色卡上的那一个主角。
     */
    usedCast = prevFrameCast(prev);
    return finish([injected, ...rest], 'carry', [injected], cards.length);
  }

  // 用户手选的尾帧与参考素材互斥，尾帧优先
  if (rest.some((item) => item.type === 'last_frame')) {
    return finish(rest, null, [], cards.length);
  }

  // 参考模式：补卡片图，同时给用户手动加的参考素材留位置
  const existingUrls = new Set(rest.map((item) => item.url));
  const currentImages = rest.filter((item) => item.type === 'reference_image').length;
  /**
   * 末帧排在参考图最末位：槽位不够时先丢它，人物一致性优先；
   * 提示词（buildVideoPrompt）按「最后一张参考图」指路，所以顺序不能乱。
   * 这里必须先判容量再决定收不收——收进来再被 validateMedia 拒单就白跑一镜。
   */
  const refFrame =
    referenceFrame &&
    !existingUrls.has(referenceFrame.url) &&
    rest.length + 1 <= MAX_MEDIA_TOTAL &&
    currentImages + 1 <= MAX_REFERENCE_IMAGES
      ? { ...referenceFrame, type: 'reference_image' as const, auto: true }
      : null;
  const reserve = refFrame ? 1 : 0;

  usedRef = !!refFrame;
  // 参考图里是谁：写提示词时要点名，否则视频模型只把它当调色板
  usedCast = refFrame ? prevFrameCast(prev) : [];

  /**
   * 卡片和末帧都要，不去重。
   *
   * 曾经试过「末帧里已经出现的人就不再传他的角色卡」，结果整段视频彻底失去参考：
   * 末帧是一张整帧场景图，模型对它更接近「环境 / 光线 / 风格参考」，
   * 不会把它当成某个具体人物；一旦删掉角色卡，身份参考就没了。
   * 重复人物改由提示词约束（只锁脸和服装、禁止 duplicate、单人镜头给人数上限）。
   */
  const slots = Math.max(
    0,
    Math.min(
      MAX_REFERENCE_IMAGES - currentImages - reserve,
      MAX_MEDIA_TOTAL - rest.length - reserve,
    ),
  );
  const additions = cards.filter((item) => !existingUrls.has(item.url)).slice(0, slots);

  return finish(
    [...additions, ...rest, ...(refFrame ? [refFrame] : [])],
    additions.length > 0 ? 'cards' : null,
    [...additions, ...(refFrame ? [refFrame] : [])],
    cards.length - additions.length,
  );
}
