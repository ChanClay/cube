/**
 * 空间参照系：一处判定，多处共用。
 *
 * 视频模型不认识「前 / 后 / 左 / 右」，它只认「以谁为准」。同一个 left 会被读成
 * 画面左、车辆自己的左、左侧车道——「左后方超车」拍成「右前方对撞」就是这么来的。
 *
 * 这里提供三样东西：
 * 1. `bareDirections`：英文裸方位检测（对齐 references/video-prompt.md 与
 *    scripts/validate_script.mjs 的判定，那边是离线脚本，app 侧此前没有实现）；
 * 2. `hasBareChineseDirection`：中文「画面左侧」这类绝对错误的写法（画面方位随镜头翻转，
 *    写进场景卡 / 走位就一定会在某个机位上反掉）；
 * 3. `SPATIAL_FRAME_SENTENCE`：运行时注入位置时必须一起给出的参考系声明。
 *
 * 判定一律保守：宁可漏报，也不要把「the window on the west wall」这种带参照的说法误判成裸方位。
 */

/** 位于 left / right 之前、能提供参照系的词 */
const ANCHOR_PREV = new Set(['frame', 'screen', 'shot', 'camera']);

/** 位于 left / right 之后、能提供参照系的词（left side / left wall / left hand …） */
const ANCHOR_NEXT = new Set([
  'lane',
  'side',
  'third',
  'half',
  'edge',
  'shoulder',
  'wall',
  'door',
  'window',
  'mirror',
  'seat',
  'hand',
  'corner',
  'panel',
  'pillar',
  'bumper',
  'fender',
  'flank',
  'rear',
  'front',
  'end',
  'arm',
  'bank',
  'aisle',
  'stair',
  'staircase',
]);

/**
 * 英文裸方位词。
 *
 * 只判 left / right 两个词：front / back / behind 在英文里往往自带参照（of the door），
 * 误报率太高。anchored 的判定与离线校验脚本保持一致：
 * - 前面是 frame / screen / shot / camera；
 * - 前面是所有格（the car's left）；
 * - 后面是 of（the left of the door）；
 * - 后面是参照物名词（left wall / left side / left end）；
 * - from left to right（跨画面运动，参照系天然是画框，两端的 left / right 都成立）。
 */
export function bareDirections(text: string): string[] {
  const tokens = text.toLowerCase().match(/[a-z][a-z'’-]*/g) ?? [];
  const bare: string[] = [];
  tokens.forEach((token, i) => {
    if (token !== 'left' && token !== 'right') return;
    const prev = tokens[i - 1] ?? '';
    const prev2 = tokens[i - 2] ?? '';
    const prev3 = tokens[i - 3] ?? '';
    const next = tokens[i + 1] ?? '';
    /**
     * from left to right 是一个完整的跨画面表达式：
     * 左端靠 from left 命中，右端只剩 to right，必须回看三个词才能认出来，
     * 否则右端会被当成裸方位误报（离线脚本里就有这个漏判）。
     */
    const fromTo =
      (prev === 'from' && next === 'to') ||
      (prev === 'to' && (prev2 === 'left' || prev2 === 'right') && prev3 === 'from');
    const anchored =
      ANCHOR_PREV.has(prev) ||
      prev.endsWith("'s") ||
      prev2.endsWith("'s") ||
      next === 'of' ||
      ANCHOR_NEXT.has(next) ||
      fromTo;
    if (!anchored) bare.push(token);
  });
  return bare;
}

/**
 * 中文里的「画面左侧 / 画面右边」。
 *
 * 只查这一种：它把「镜头看到的方位」写进了场景，而镜头一换边就翻面。
 * 「房间左侧」「靠窗那侧」这类有实体参照的说法不在此列（场景卡里允许，且难以误判）。
 */
const BARE_ZH_DIRECTION = /画面\s*(?:的)?\s*(?:左|右)(?:侧|边|方|手边)?/;

export function hasBareChineseDirection(text: string): boolean {
  return BARE_ZH_DIRECTION.test(text);
}

/**
 * 注入位置信息时必须一起提交的参考系声明。
 *
 * 只给「桌头正对门」而不说坐标系，模型仍会各挑一个理解：它可能把「正对门」当成
 * 「正对镜头」。把坐标系写死一句，后面的所有位置才有同一个基准。
 */
export const SPATIAL_FRAME_SENTENCE =
  'All positions are given from inside the space, relative to its fixed landmarks ' +
  '(the door, the windows, the walls, the furniture) — never relative to the camera or the frame.';

/** 一句话说清某个位置字段为什么不能用 */
export function directionProblem(text: string): string | null {
  if (hasBareChineseDirection(text)) {
    return '写了「画面左侧 / 右侧」：画面方位随镜头翻转，换机位就一定反掉，改用相对门窗 / 固定家具的位置';
  }
  const bare = bareDirections(text);
  if (bare.length > 0) {
    return `方位词「${[...new Set(bare)].join(' / ')}」没有参照系：改成相对门窗 / 固定家具的说法（the table end facing the door / against the west wall）`;
  }
  return null;
}
