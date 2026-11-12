import type { Scene, Shot } from '@/lib/types';

/**
 * 陈设覆盖检查：分镜里提到的物件，必须在场景卡的陈设清单 / 场景描述 / 道具卡里有出处。
 *
 * 这是「场景卡没有桌子酒杯，但分镜里出现了」的自动化拦截。之前的链路里没有任何机制
 * 能发现这件事：审片只检查固定英文短语的命中率，而一个场景卡根本没登记的物件，
 * 命中率这个概念根本不存在。结果就是同一张桌子在不同镜头里换位置、换材质，
 * 甚至有的镜头有、有的镜头没有。
 *
 * 判定是确定性的（不发请求、不花钱），用词表做保守匹配：
 * 同一条目的任意写法都算「已声明」，所以场景卡写「案几」、分镜写「桌」不会误报。
 */

export interface DressingTerm {
  /** 报错时用的人话名字 */
  label: string;
  /** 中文别名：场景 desc / 分镜 description 里可能出现的写法 */
  zh: string[];
  /** 英文别名：场景 promptEn / 陈设清单 en 里可能出现的写法 */
  en: string[];
}

/**
 * 只收「固定陈设」与「高频桌上物件」。
 *
 * 刻意排除三类，否则全是误报：
 * - 单字且高频出现在别的词里（门 / 画 / 镜 / 钟 / 灯 / 旗 都有「专门 / 画面 / 镜头 / 分钟 / 灯光」这类陷阱）；
 * - 人体与服装（手 / 肩 / 衣领），它们是角色卡的事；
 * - 可随身携带的小物件（手机 / 钥匙 / 刀），它们该升级成道具卡而不是陈设。
 */
export const DRESSING_TERMS: DressingTerm[] = [
  { label: '桌', zh: ['桌', '案几', '几案'], en: ['table', 'desk'] },
  { label: '椅凳', zh: ['椅子', '椅背', '座椅', '凳子', '马扎'], en: ['chair', 'stool', 'bench'] },
  { label: '沙发', zh: ['沙发'], en: ['sofa', 'couch'] },
  { label: '床', zh: ['床铺', '床上', '床边', '床沿', '木床', '铁床'], en: ['bed'] },
  { label: '柜架', zh: ['柜子', '橱柜', '书架', '博古架', '抽屉'], en: ['cabinet', 'shelf', 'bookshelf', 'cupboard', 'drawer'] },
  { label: '楼梯', zh: ['楼梯', '阶梯', '台阶'], en: ['stairs', 'staircase', 'steps'] },
  { label: '窗', zh: ['窗户', '窗台', '窗框', '窗外', '窗口'], en: ['window'] },
  { label: '门', zh: ['门框', '门口', '房门', '木门', '铁门', '大门', '门帘'], en: ['door', 'doorway', 'gate'] },
  { label: '杯瓶餐具', zh: ['酒杯', '高脚杯', '酒瓶', '瓶子', '茶壶', '茶杯', '杯子', '碗', '盘子', '餐具', '酒坛'], en: ['glass', 'goblet', 'bottle', 'teapot', 'cup', 'bowl', 'plate', 'tableware'] },
  { label: '灯具', zh: ['台灯', '吊灯', '油灯', '灯笼', '烛台', '蜡烛', '火把', '壁灯', '提灯'], en: ['lamp', 'chandelier', 'candle', 'candlestick', 'torch', 'lantern', 'sconce'] },
  { label: '炉火', zh: ['壁炉', '炉灶', '灶台', '火盆', '篝火', '炭火'], en: ['fireplace', 'hearth', 'stove', 'brazier', 'campfire'] },
  { label: '镜子', zh: ['镜子', '明镜', '镜面'], en: ['mirror'] },
  { label: '地毯', zh: ['地毯', '地垫'], en: ['rug', 'carpet'] },
  { label: '挂画', zh: ['挂画', '油画', '壁画', '海报', '字画'], en: ['painting', 'poster', 'mural'] },
  { label: '钟表', zh: ['挂钟', '座钟', '铜钟', '沙漏'], en: ['clock', 'hourglass'] },
  { label: '屏风隔断', zh: ['屏风', '隔断'], en: ['screen', 'partition'] },
  { label: '栏杆扶手', zh: ['栏杆', '扶手', '铁栏'], en: ['railing', 'banister'] },
  { label: '柜台', zh: ['柜台', '吧台', '操作台', '控制台', '讲台', '梳妆台'], en: ['counter', 'console', 'lectern', 'vanity'] },
  { label: '旗帜', zh: ['旗帜', '旗子', '军旗', '战旗'], en: ['banner', 'flag'] },
  { label: '地图沙盘', zh: ['地图', '沙盘', '棋盘', '图册'], en: ['map', 'chessboard'] },
  { label: '乐器', zh: ['钢琴', '风琴', '吉他', '二胡', '古琴'], en: ['piano', 'organ', 'guitar'] },
];

/** 一件物件在场景卡 / 道具卡里的声明文本 */
function declaredText(scene: Scene, cards: { name: string; desc: string }[]): { zh: string; en: string } {
  const items = scene.inventory ?? [];
  return {
    zh: [
      scene.desc,
      scene.state ?? '',
      ...items.map((item) => item.name),
      ...cards.flatMap((card) => [card.name, card.desc]),
    ].join('\n'),
    en: [scene.promptEn ?? '', ...items.flatMap((item) => [item.en ?? '', item.where ?? ''])].join('\n'),
  };
}

function enMentions(text: string, term: string): boolean {
  const needle = term.toLowerCase().trim();
  if (!needle) return false;
  const lower = text.toLowerCase();
  if (needle.includes(' ')) return lower.includes(needle);
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}(?:s|es)?\\b`, 'i').test(lower);
}

/** 分镜里提到、但这个场景（及道具卡）里没有任何出处的固定陈设 */
export function undeclaredDressing(
  shot: Shot,
  scene: Scene,
  cards: { name: string; desc: string }[] = [],
): DressingTerm[] {
  const shotText = [shot.description, shot.entryState, shot.exitState].filter(Boolean).join('\n');
  if (!shotText.trim()) return [];
  const declared = declaredText(scene, cards);
  const missing: DressingTerm[] = [];
  const seen = new Set<string>();

  for (const term of DRESSING_TERMS) {
    if (seen.has(term.label)) continue;
    const inShot = term.zh.some((word) => shotText.includes(word));
    if (!inShot) continue;
    const isDeclared =
      term.zh.some((word) => declared.zh.includes(word)) ||
      term.en.some((word) => enMentions(declared.en, word));
    if (isDeclared) continue;
    seen.add(term.label);
    missing.push(term);
  }
  return missing;
}
