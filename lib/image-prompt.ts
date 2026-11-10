/**
 * 角色卡 / 场景卡的配图提示词。
 *
 * 文生图模型在没有明确约束时会给「干净但塑料」的默认渲染感，
 * 而且常常无视剧本的整体风格，所以这里把提示词拆成四层，顺序不能乱：
 *
 *   1. 画面风格（剧本 style）：前置 + 强约束，决定画风；
 *   2. 主体描述：角色外形 / 场景空间；
 *   3. 构图：卡片用途对应的机位与画面构成；
 *   4. 画面质感：材质、光影、景深、颗粒、调色，保证卡片和成片质感一致。
 *
 * 质感层不写「实拍」「不要卡通」这类字样——用户的风格可能就是动画，
 * 冲突的否定词会把风格压回模型默认值。
 */

import { expandStyle } from './style-presets';

export type CardKind = 'character' | 'scene';

/** 万相文生图的推荐档位：角色竖图、场景横图 */
export const CARD_IMAGE_SIZE: Record<CardKind, string> = {
  character: '1104*1472',
  scene: '1696*960',
};

/** 构图约束：避免出成海报、多人合影或带字的设定板 */
const FRAMING: Record<CardKind, string> = {
  character: '角色设定图，单人主体居中，全身正面站姿，姿态自然放松，画面里只出现这一个角色',
  scene: '场景空镜，画面中没有人物，广角电影感构图，透视与景深真实，光源方向明确',
};

/**
 * 画面质感：材质、光线、景深、镜头、颗粒。
 * 这些词对写实和动画风格都成立，不会被风格描述否定。
 */
const TEXTURE: Record<CardKind, string> = {
  character:
    '画面质感：高细节，主体材质可信（皮肤、头发、布料、金属、皮革各有质感与磨损），' +
    '轮廓光与补光分明，浅景深背景轻微虚化，35mm 电影镜头，细腻颗粒，电影级调色，色彩层次丰富',
  scene:
    '画面质感：高细节，环境材质可信（墙面、木纹、金属、织物、地面各有质感），' +
    '空气中有尘埃或薄雾，体积光，主光与补光分明，浅景深与真实透视，35mm 电影镜头，' +
    '细腻颗粒，电影级调色，色调统一',
};

const NEGATIVE = '文字, 水印, logo, 分屏, 多人合影, 畸形肢体, 多余手指, 低清晰度, 画面撕裂';

/** 万相单条提示词上限 2000 字符，留一点余量 */
const MAX_PROMPT_LENGTH = 1800;

const truncate = (text: string, limit: number): string =>
  text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;

export interface CardPromptInput {
  kind: CardKind;
  /** 角色外形 / 场景空间描述（名称 + desc） */
  prompt: string;
  /** 剧本的整体视觉风格，缺省时退回电影感写实 */
  style?: string;
}

/** 拼一条完整的文生图提示词 */
export function buildCardPrompt({ kind, prompt, style }: CardPromptInput): string {
  // 预设风格展开成明细描述，自定义风格原样使用
  const styleText = expandStyle(style);
  const head = styleText
    ? `画面风格（严格遵循，不要自行更换画风）：${styleText}`
    : '画面风格：电影感写实风格，35mm 胶片质感，自然光，浅景深';
  const tail = [FRAMING[kind], TEXTURE[kind], `不要画面文字 / 水印 / logo / 分屏 / 畸形肢体`].join(
    '。',
  );

  // 主体描述超长时先截主体，风格与质感必须完整保留
  const budget = MAX_PROMPT_LENGTH - head.length - tail.length - 2;
  const subject = truncate(prompt.trim(), Math.max(120, budget));

  return [head, subject, tail].filter(Boolean).join('。');
}

/** 负向提示词（wan2.5 及以下的旧协议才支持单独传） */
export const CARD_NEGATIVE_PROMPT = NEGATIVE;
