import { MAX_MEDIA_TOTAL, isCarryFrameUrl } from './media';
import type { MediaInput, Script, Shot } from './types';

/**
 * 镜头级的自动素材关联。
 *
 * 两条硬规则：
 * 1. 角色卡 / 场景卡是「设计参考」，一律作为 reference_image，
 *    不再当首帧——单人设定图当首帧会把整段视频压成同样的背景。
 * 2. 万相 wan3.0 不允许首尾帧与 reference_* 混用，
 *    所以有衔接帧时只能二选一：优先承接上一镜，卡片参考图本镜跳过。
 */

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
  /** carry=用了上一镜末帧；cards=补了卡片参考图；null=没动 */
  source: 'carry' | 'cards' | null;
  /** 本次新挂上的素材 */
  injected: MediaInput[];
  /** 因为首帧 / 参考图互斥而没挂上的卡片数量 */
  skippedCards: number;
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
 * - 有衔接帧且没有参考素材时用衔接帧；
 * - 否则把相关角色 / 场景卡作为参考图补进去。
 */
export function resolveShotMedia(
  media: MediaInput[],
  carry: MediaInput | null,
  cards: MediaInput[],
  script: Script | null,
): ResolvedShotMedia {
  const cardUrls = autoCardUrls(script);

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
  if (carry && !hasReferences) {
    const injected: MediaInput = { ...carry, auto: true };
    return finish([injected, ...rest], 'carry', [injected], cards.length);
  }

  // 用户手选的尾帧与参考素材互斥，尾帧优先
  if (rest.some((item) => item.type === 'last_frame')) {
    return finish(rest, null, [], cards.length);
  }

  // 参考模式：补卡片图，同时给用户手动加的参考素材留位置
  const currentImages = rest.filter((item) => item.type === 'reference_image').length;
  const slots = Math.max(
    0,
    Math.min(MAX_REFERENCE_IMAGES - currentImages, MAX_MEDIA_TOTAL - rest.length),
  );
  const existingUrls = new Set(rest.map((item) => item.url));
  const additions = cards
    .filter((item) => !existingUrls.has(item.url))
    .slice(0, slots);

  return finish(
    [...additions, ...rest],
    additions.length > 0 ? 'cards' : null,
    additions,
    cards.length - additions.length,
  );
}
