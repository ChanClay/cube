/**
 * 视觉风格预设。
 *
 * 下拉里只显示短标签（存库也存标签，兼容旧剧本），
 * 真正送进文生图 / 剧本提示词的是 detail 里的明细描述——
 * 只给「日系动画」四个字，模型每次都会自由发挥，质感对不上很正常。
 */

export interface StylePreset {
  label: string;
  /** 展开后的画面描述：媒介、质感、光线、色调 */
  detail: string;
}

export const STYLE_PRESETS: StylePreset[] = [
  {
    label: '电影感写实',
    detail:
      '电影感写实风格，35mm 胶片质感，自然光与柔和体积光，低饱和冷暖对比，浅景深，真实材质与皮肤质感，细腻颗粒',
  },
  {
    label: '日系动画',
    detail:
      '日式二维动画风格，赛璐璐平涂上色，干净线稿，柔和天空渐变与镜头光晕，明亮通透的配色，边缘柔光',
  },
  {
    label: '3D 动画',
    detail:
      '三维动画电影风格，造型圆润，柔和全局光照与次表面散射皮肤，材质干净，浅景深，色彩明快',
  },
  {
    label: '水墨国风',
    detail:
      '中国水墨画风格，宣纸纹理与墨色晕染，留白构图，淡青绿与赭石点缀，柔和光雾，笔触可见',
  },
  {
    label: '赛博朋克',
    detail:
      '赛博朋克电影质感，霓虹冷色光源与湿润反光地面，高对比暗调，体积雾与镜头光晕，胶片颗粒',
  },
  {
    label: '复古胶片',
    detail:
      '1990 年代胶片电影质感，明显颗粒与轻微漏光，偏暖黄绿色调，柔和高光溢出，真实材质，浅景深',
  },
  {
    label: '二维插画',
    detail:
      '精致二维手绘插画风格，清晰线稿与平涂色块，柔和渐变阴影，干净构图，纸质纹理',
  },
];

/** 下拉选项用的短标签 */
export const STYLE_LABELS = STYLE_PRESETS.map((preset) => preset.label);

/**
 * 把短标签展开成完整风格描述；用户自定义的风格原样返回。
 * 空值与未命中预设都走「原样」分支，不会凭空改写用户的设定。
 */
export function expandStyle(style: string | undefined): string {
  const value = (style ?? '').trim();
  if (!value) return '';
  const preset = STYLE_PRESETS.find((item) => item.label === value);
  return preset ? preset.detail : value;
}
