import { MAX_MEDIA_TOTAL, isCarryFrameUrl } from './media';
import type { MediaInput, Script, Shot, ShotTransition } from './types';

/**
 * 镜头级的自动素材关联。
 *
 * 四条硬规则：
 * 1. 角色卡 / 场景卡是「设计参考」，一律作为 reference_image，
 *    不再当首帧——单人设定图当首帧会把整段视频压成同样的背景。
 * 2. 万相 wan3.0 不允许首尾帧与 reference_* 混用，
 *    所以每一镜只能在「接帧」和「参考图」之间二选一。
 * 3. 选哪一边由分镜给出的 transition 决定，不由「上一镜恰好有成品」临时决定：
 *    same-take 才接帧，hard-cut / time-jump 一律走参考图。
 * 4. 硬切镜头也不是完全不带上一镜的画面：同场景时把末帧当 reference_image
 *    一起传，只借光线 / 色调 / 场景材质，让接缝看起来还在同一个片场。
 *    参考图不会变成底图，所以不会把上一镜的构图或人数带进来。
 */

export const TRANSITION_LABEL: Record<ShotTransition, string> = {
  'same-take': '承接上一镜',
  'hard-cut': '硬切换机位',
  'time-jump': '时间/空间跳转',
};

export const TRANSITION_HINT: Record<ShotTransition, string> = {
  'same-take':
    '同一动作被切成两镜：抽上一镜末帧当首帧，本镜不能再传参考图（wan3.0 首帧与参考图互斥）',
  'hard-cut': '换景别 / 换角度：用角色卡、场景卡当参考图，画面不接帧',
  'time-jump': '时间或地点跳转：同硬切，走参考图',
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
 * - first_frame：承接同一动作，画面直接接住（此时不能传任何参考图）
 * - reference_image：同一场戏但换了机位，只借光线 / 色调 / 场景材质，不改构图
 * - null：不用（时间跳转、换场景、第一镜）
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
  if (isSameTakeShot(shot)) return 'first_frame';
  // 分镜 / 用户关掉了就完全不抽
  if (shot.referencePrevFrame === false) return null;
  if (shot.transition === 'time-jump') return null;

  // 显式打开：照做（跨场景也允许，属于用户覆盖）
  if (shot.referencePrevFrame === true) return 'reference_image';

  /**
   * 没写（旧剧本）时退回同场景判定：换场景 / 换时间时，上一镜的光线本来
   * 就该不一样，参考过去反而会把新场景拉回旧色调。
   * 场景名缺失时不敢猜，直接不用。
   */
  const prevScene = (prev.sceneNames ?? []).join('|');
  const scene = (shot.sceneNames ?? []).join('|');
  if (!prevScene || !scene || prevScene !== scene) return null;

  return 'reference_image';
}

/** 单次最多 10 张参考图（与 lib/media.ts 的 reference_image 上限一致） */
const MAX_REFERENCE_IMAGES = 10;

/** 全片角色卡 + 场景卡的配图地址，用来识别上一轮自动注入的素材 */
export function autoCardUrls(script: Script | null): Set<string> {
  if (!script) return new Set();
  const urls = [
    ...script.characters.map((character) => character.imageUrl),
    ...(script.scenes ?? []).map((scene) => scene.imageUrl),
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

  const push = (url: string) => {
    if (!url || seen.has(url) || result.length >= MAX_REFERENCE_IMAGES) return;
    seen.add(url);
    result.push({ type: 'reference_image', url, auto: true });
  };

  // 角色在前：人物的长相一致性比背景更关键
  for (const character of script.characters) {
    if (!character.imageUrl) continue;
    const mentioned = character.name && text.includes(character.name);
    if (characterNames.has(character.name) || mentioned) push(character.imageUrl);
  }

  for (const scene of script.scenes ?? []) {
    if (!scene.imageUrl) continue;
    const mentioned = scene.name && text.includes(scene.name);
    if (sceneNames.has(scene.name) || mentioned) push(scene.imageUrl);
  }

  // 全片只有一个场景、镜头又没标场景：默认就是它
  const scenes = script.scenes ?? [];
  if (result.length === 0 && sceneNames.size === 0 && scenes.length === 1) {
    const only = scenes[0];
    if (only.imageUrl) push(only.imageUrl);
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
  /** carry=用了上一镜末帧当首帧；cards=补了卡片参考图；null=没动 */
  source: 'carry' | 'cards' | null;
  /** 本次新挂上的素材 */
  injected: MediaInput[];
  /** 因为首帧 / 参考图互斥而没挂上的卡片数量 */
  skippedCards: number;
  /** 是否把上一镜末帧作为参考图带了进去（硬切镜头的风格锚点） */
  withPrevFrameRef: boolean;
  /** 参考图里实际在场的人物，用于在提示词里点名（没带参考图时为空） */
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
 * - same-take 镜头用衔接帧当首帧，硬切 / 跳转镜头即便抽到了也不当首帧；
 * - 同场硬切镜头把末帧追加成 reference_image（风格锚点），排在卡片之后；
 * - 衔接帧拿不到时降级为参考图，不让这一镜裸奔。
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
   * 接动作就当首帧，换机位但同一场戏就当参考图，其余情况不用。
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

  // 用户手选首帧：完全不动。尾帧可以和承接帧共存（wan3.0 允许多帧），后面单独判断
  if (rest.some((item) => item.type === 'first_frame')) {
    return finish(rest, null, [], cards.length);
  }

  const hasReferences = rest.some((item) => !isFrame(item.type));

  // 首帧优先：承接上一镜时不能再塞参考图，否则 wan3.0 直接拒单
  if (carryFrame && !hasReferences) {
    const injected: MediaInput = { ...carryFrame, auto: true };
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
   * 末帧排在最末位：槽位不够时先丢它，人物一致性优先。
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

  const slots = Math.max(
    0,
    Math.min(
      MAX_REFERENCE_IMAGES - currentImages - reserve,
      MAX_MEDIA_TOTAL - rest.length - reserve,
    ),
  );
  const additions = cards.filter((item) => !existingUrls.has(item.url)).slice(0, slots);

  usedRef = !!refFrame;
  // 参考图里是谁：写提示词时要点名，否则视频模型只把它当调色板
  usedCast = refFrame ? prevFrameCast(prev) : [];

  return finish(
    [...additions, ...rest, ...(refFrame ? [refFrame] : [])],
    additions.length > 0 ? 'cards' : null,
    [...additions, ...(refFrame ? [refFrame] : [])],
    cards.length - additions.length,
  );
}
