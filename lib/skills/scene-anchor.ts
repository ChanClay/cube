import { directionProblem, SPATIAL_FRAME_SENTENCE } from './spatial';
import { matchedWords } from './spec';
import type { Scene, Script, Shot } from '@/lib/types';

/**
 * 场景锚定：把「空间一致性」从模型的自觉变成运行时的硬约束。
 *
 * 之前的链路里，场景卡的 promptEn 只出现在给 LLM 的规则里（storyboard / refine 的
 * 系统提示词），逐镜拼提示词时一次都没有被读取。于是「必须复用场景短语」是一条
 * 建议而不是契约：模型漏抄、改写、换一种说法，成片里同一个空间就换了一套光线与陈设，
 * 而运行时没有任何兜底。
 *
 * 这里补上兜底：出片前把场景短语与分镜提到的陈设硬拼进提示词。
 * 判定用词命中率而不是字符串相等——模型正常复用时会逐字抄，抄过就不再重复注入。
 */

/** 场景短语已被逐字复用：不再重复追加，避免同一段空间描述出现两遍 */
const COVERED_RATIO = 0.8;

/**
 * 这一镜引用的场景卡。
 *
 * 优先按 id 解析：改名不会让这一镜失去场景卡，两张卡同名也不会挂错图。
 * 旧剧本没有 sceneIds 时按名字回退。
 *
 * 只返回真正命中的那几张——分镜指着已删除的场景时宁可为空（审片会报），
 * 也不要在别的场景卡里随便挑一张顶上：那等于让这一镜换了个地方拍。
 */
export function resolveShotScenes(script: Script | null, shot: Shot): Scene[] {
  if (!script) return [];
  const scenes = script.scenes ?? [];

  const ids = (shot.sceneIds ?? []).filter(Boolean);
  if (ids.length > 0) {
    const byId = new Map(scenes.filter((scene) => scene.id).map((scene) => [scene.id as string, scene]));
    const hits = ids.map((id) => byId.get(id)).filter((scene): scene is Scene => !!scene);
    if (hits.length > 0) return hits;
  }

  const names = (shot.sceneNames ?? []).map((name) => name.trim()).filter(Boolean);
  if (names.length === 0) return [];
  return names
    .map((name) => scenes.find((scene) => scene.name.trim() === name))
    .filter((scene): scene is Scene => !!scene);
}

/**
 * 本镜的主场景。
 *
 * 只取第一个能对上的场景：跨场景镜头（从门口走到院内）用两句空间描述会互相打架，
 * 主场景决定这一镜的光线与陈设基调，剩下的变化交给 videoPrompt 自己写。
 */
export function primaryScene(script: Script | null, shot: Shot): Scene | null {
  return resolveShotScenes(script, shot)[0] ?? null;
}

/** 只读分镜里可能提到陈设的中文字段，调用方不必持有完整的 Shot */
export type SceneAnchorShot = Partial<Pick<Shot, 'description' | 'entryState' | 'exitState' | 'shotSize' | 'cameraMove'>>;

/** 分镜侧可能提到陈设的中文字段 */
function shotSceneText(shot: SceneAnchorShot): string {
  return [shot.description, shot.entryState, shot.exitState].filter(Boolean).join('\n');
}

/** 英文提示词里是否已经出现了这件物件的英文名 */
function promptMentions(prompt: string, en: string): boolean {
  const text = prompt.toLowerCase();
  const needle = en.toLowerCase().trim();
  if (!needle) return true;
  // 多词短语（wine glass）整体匹配；单词用词边界，避免 glass 命中 sunglasses
  if (needle.includes(' ')) return text.includes(needle);
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}(?:s|es)?\\b`, 'i').test(text);
}

/**
 * 这一镜要追加的空间锚定句。
 *
 * 两件事，都只在「缺」的时候补：
 * 1. 场景的固定英文短语没被复用 → 补一句地点锚定；
 * 2. 分镜提到、但英文提示词没写到的陈设 → 补物件名与位置。
 *
 * 第 2 条是「场景卡没有杯子但分镜有杯子」的正解：
 * 不是逼模型把陈设猜对，而是把陈设清单里登记过的英文名与位置直接给它。
 * 清单里没有的物件由审片报 prop-undeclared，让人去补清单或升级成道具卡。
 */
export function sceneAnchorClause(
  shot: SceneAnchorShot,
  scene: Scene | null | undefined,
  prompt: string,
): string {
  if (!scene) return '';
  const parts: string[] = [];

  const phrase = scene.promptEn?.trim();
  if (phrase) {
    const { hit, total } = matchedWords(phrase, prompt);
    const covered = total >= 3 && hit / total >= COVERED_RATIO;
    if (!covered) {
      parts.push(`The location is exactly the established space: ${phrase}`);
    }
  }

  const shotText = shotSceneText(shot);
  // 只补「分镜提了、英文提示词漏了」的那几件：全量注入会把无关陈设塞进每一镜
  const missing = (scene.inventory ?? []).filter((item) => {
    const en = item.en?.trim();
    if (!en || !item.name) return false;
    return shotText.includes(item.name) && !promptMentions(prompt, en);
  });
  /** 是否真的给出了位置：只有给了位置才需要附坐标系声明 */
  let withPosition = false;
  if (missing.length > 0) {
    const listed = missing
      .map((item) => {
        const en = item.en!.trim();
        const whereEn = item.whereEn?.trim();
        /**
         * 位置只用英文那一份，而且必须带参照系：
         * - 中文 where 绝不进提示词（汉字占比会触发 prompt-not-english，模型也读不懂中文方位）；
         * - 裸方位（on the left）不注入——错的坐标比没有坐标更糟，交给审片报出来让人改。
         */
        if (!whereEn || directionProblem(whereEn)) return en;
        withPosition = true;
        return `${en} (${whereEn})`;
      })
      .join('; ');
    parts.push(`The same set pieces are present and stay in place: ${listed}`);
  }

  if (parts.length === 0) return '';
  // 给了位置就必须同时给坐标系：否则「桌头正对门」会被读成「桌头正对镜头」
  const frame = withPosition ? ` ${SPATIAL_FRAME_SENTENCE}` : '';
  return ` ${parts.join('. ')}.${frame} Do not redesign the space, move the furniture or change the light direction.`;
}

/**
 * 目标机位标签，按景别与运镜推导。
 * 场景图集按这些标签选图：广角空镜当特写镜的背景参考，模型会把构图一起拉远。
 */
export function wantedAngles(shot: Shot): string[] {
  const size = shot.shotSize ?? '';
  const move = shot.cameraMove ?? '';
  const want: string[] = [];
  if (/全景|远景|大远景/.test(size)) want.push('wide');
  else if (/特写|近景/.test(size)) want.push('close');
  else if (/中景/.test(size)) want.push('mid');
  if (/环绕|横移|跟随|升|降/.test(move)) want.push('reverse');
  want.push('front');
  return want;
}

/** 机位标签的同义词：图集里的 angle 是自由文本，按关键词归拢到上面的标签 */
const ANGLE_ALIASES: Record<string, string[]> = {
  wide: ['wide', 'establishing', 'full', '全景', '远景', '大全', '空镜'],
  close: ['close', 'detail', '特写', '近景', '细节'],
  mid: ['mid', 'medium', '中景'],
  reverse: ['reverse', 'back', 'over', 'shoulder', '反打', '背面', '反向', '过肩'],
  top: ['top', 'overhead', 'bird', '俯视', '顶视', '平面'],
  front: ['front', 'main', 'master', '正面', '主视角'],
};

function angleLabel(angle: string): string | null {
  const text = angle.toLowerCase();
  for (const [label, aliases] of Object.entries(ANGLE_ALIASES)) {
    if (aliases.some((alias) => text.includes(alias))) return label;
  }
  return null;
}

/**
 * 这一镜该用哪张场景图。
 *
 * 只挑一张：参考图上限 9 张，角色卡优先级更高，把整个图集塞进去会挤掉人物一致性。
 * 没有图集时退回主图，行为与旧剧本一致。
 */
export function pickSceneImage(scene: Scene | null | undefined, shot: Shot): string | undefined {
  if (!scene) return undefined;
  const refs = (scene.angleRefs ?? []).filter((ref) => !!ref.imageUrl);
  if (refs.length === 0) return scene.imageUrl;

  /**
   * 俯视图是「布局卡」：画的是人物与陈设的空间关系，只给人对照走位、
   * 以及作为 entryState / blocking 的书写依据，绝不能当视频参考图——
   * 视频模型会把平面图当成画面内容照抄，整镜变成贴地俯拍。
   */
  const usable = refs.filter((ref) => angleLabel(ref.angle) !== 'top');
  if (usable.length === 0) return scene.imageUrl;

  for (const want of wantedAngles(shot)) {
    const hit = usable.find((ref) => angleLabel(ref.angle) === want);
    if (hit) return hit.imageUrl;
  }
  const front = usable.find((ref) => angleLabel(ref.angle) === 'front');
  return scene.imageUrl ?? front?.imageUrl ?? usable[0].imageUrl;
}

/**
 * 走位锚定句 —— 「占位布局卡」的运行时形态。
 *
 * 布局信息不直接进模型：俯视平面图当参考图会被当成画面内容照抄（画面里浮着一张地图，
 * 或者整镜变成贴地俯拍），而首帧与参考图又互斥，塞进去只会抢掉角色卡的位置。
 * 所以布局降维成 blockingEn 这一句可复用的空间事实，像场景短语一样逐字复用：
 * 换机位时人物的左右关系跟着它走，而不是靠模型每次重新猜。
 */
export function blockingClause(prompt: string, blockingEn?: string): string {
  const en = blockingEn?.trim();
  if (!en) return '';
  /**
   * 裸方位（on the left）不注入。
   *
   * 走位的全部价值就在参考系：一句没有参照的左右，模型每次挑一个理解，换机位必然翻面，
   * 拼进每一镜只会把错误稳定下来。宁可不注入，由审片的 bare-blocking 报出来让人改。
   */
  if (directionProblem(en)) return '';
  const { hit, total } = matchedWords(en, prompt);
  if (total >= 4 && hit / total >= COVERED_RATIO) return '';
  return (
    ` Blocking: ${en}. Anchor each character to the named landmark ` +
    '(the door, the window, the table end), not to the frame, ' +
    'and do not swap or mirror their positions.'
  );
}
