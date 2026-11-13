'use client';

import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/client';
import { STYLE_LABELS } from '@/lib/skills/style-presets';
import type { Character, Scene, SceneAngleRef, SceneItem } from '@/lib/types';

/**
 * 角色卡 / 场景卡：
 * 默认收成一行 chip（缩略图 + 名字），点哪张就在下方展开它的详细内容与操作按钮，
 * 一次只展开一张（手风琴），避免整页被一堆输入框撑长。
 */

type Kind = 'character' | 'scene';

type Card = Character | Scene;

const LABEL: Record<Kind, string> = { character: '角色卡', scene: '场景卡' };

const HINT: Record<Kind, string> = {
  character: '人物 / 载具 / 关键道具的外形都写在这里，用于全片一致性；点名字展开编辑',
  scene: '空间设定 + 固定陈设清单用于全片一致性；点名字展开编辑，可登记陈设与机位图',
};

const PLACEHOLDER: Record<Kind, { name: string; desc: string }> = {
  character: {
    name: '角色名 / 载具名',
    // 顺序与蓝图的主体卡规则一致：写得越分件越具体，配图与视频的细节才立得住
    desc:
      '人类：廓形（年龄 / 身高体型）｜头部（脸型 / 发型发色 / 神态）｜上装｜下装与鞋｜装备或义体｜' +
      '配色｜随身道具｜气质体态。机甲等非人主体：机型与体量｜头部传感器｜装甲材质与涂装｜' +
      '关节液压｜武器与喷口｜配色与发光部位｜编号｜动作特征。载具：车型与体量｜车身与车漆｜' +
      '玻璃｜轮毂与轮胎｜灯具｜改装件｜标识｜动态特征（追逐双方各建一张）',
  },
  scene: {
    name: '场景名，如 灯塔内部',
    desc: '地点 / 空间尺度 / 时间 / 光源方向与色温 / 主要陈设与材质',
  },
};

interface Props {
  characters: Character[];
  scenes: Scene[];
  /** 整体视觉风格，生成配图时拼进提示词 */
  style?: string;
  disabled?: boolean;
  /**
   * 用函数式更新而不是「传新数组」：多张卡同时生成配图时，各请求回来的时间不确定，
   * 如果都拿点击那一刻的数组 map 一遍再整体写回，后到的会把先到的结果抹掉。
   */
  onCharactersChange: (updater: (prev: Character[]) => Character[]) => void;
  onScenesChange: (updater: (prev: Scene[]) => Scene[]) => void;
  /** 传入后才显示「整体画风」编辑框 */
  onStyleChange?: (style: string) => void;
}

/** 画风下拉里的「自定义」哨兵值：不是合法画风，只用来把光标交给输入框 */
const CUSTOM_STYLE = '__custom__';

/** 旧剧本的角色 / 场景没有 id，退化成按位置生成 */
const keyOf = (kind: Kind, item: Card, index: number) => item.id ?? `${kind}-${index}`;

/** chip 上显示的名字：空名字给个占位，别留一个空胶囊 */
const nameOf = (item: Card) => (item.name ?? '').trim() || '未命名';

export default function CastCards({
  characters,
  scenes,
  style = '',
  disabled = false,
  onCharactersChange,
  onScenesChange,
  onStyleChange,
}: Props) {
  /** 「整体画风」输入框的草稿值，失焦或回车时提交 */
  const [styleDraft, setStyleDraft] = useState(style);
  /** 选「自定义」时把光标丢进输入框 */
  const styleInputRef = useRef<HTMLInputElement>(null);
  /**
   * 文本正好等于某个预设标签时，下拉选中它；否则下拉显示「自定义」。
   * 旧剧本 / 手改过的长描述都会落到「自定义」，文本原样保留。
   */
  const presetLabel = STYLE_LABELS.find((label) => label === styleDraft.trim()) ?? null;
  /**
   * 正在生成 / 上传的卡片 key 集合。
   * 用集合而不是单个值：两张卡可以同时生成，先完成的那张不该把另一张的 loading 清掉。
   */
  const [busy, setBusy] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  /** 每种卡各自展开一张（手风琴） */
  const [openKey, setOpenKey] = useState<Record<Kind, string | null>>({
    character: null,
    scene: null,
  });
  /** 大图查看器；null 表示关闭 */
  const [viewer, setViewer] = useState<{ src: string; alt: string } | null>(null);

  // 查看大图时锁滚动，Esc 关闭；关闭后恢复原来的滚动状态
  useEffect(() => {
    if (!viewer) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setViewer(null);
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [viewer]);

  // 切换剧本 / 重新生成剧本后同步草稿，避免输入框留着上一份剧本的风格
  useEffect(() => {
    setStyleDraft(style);
  }, [style]);

  const listOf = (kind: Kind): Card[] => (kind === 'character' ? characters : scenes);

  /**
   * 繁忙集合的同步副本。
   *
   * `busy` 是 state，要等下一次渲染才为 true；双击「生成配图」时第二次点击
   * 读到的仍是 false，会再发一次文生图请求（一次请求一张图，都是钱）。
   */
  const busyRef = useRef<Set<string>>(new Set());

  const markBusy = (key: string, on: boolean) => {
    if (on) busyRef.current.add(key);
    else busyRef.current.delete(key);
    setBusy((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  /** 原子占位：false 表示这张卡已经有请求在飞，调用方直接放弃这一次 */
  const claimBusy = (key: string): boolean => {
    if (busyRef.current.has(key)) return false;
    markBusy(key, true);
    return true;
  };

  /**
   * 更新单张卡：把「怎么改」交给父级的函数式更新，而不是在这里读 props 快照再整体覆盖。
   *
   * 优先按 id 定位，旧剧本没有 id 时才退回位置——生成配图期间如果加了场景卡，
   * 位置会整体后移，按位置回写就会把图写到别的卡上。
   */
  const patchById = (
    kind: Kind,
    id: string | undefined,
    index: number,
    patch: Partial<Character & Scene>,
  ) => {
    const update = <T extends Card>(prev: T[]): T[] =>
      prev.map((item, i) => {
        const hit = id ? item.id === id : i === index;
        return hit ? ({ ...item, ...patch } as T) : item;
      });
    if (kind === 'character') onCharactersChange(update);
    else onScenesChange(update);
  };

  const patchAt = (kind: Kind, index: number, patch: Partial<Character & Scene>) => {
    patchById(kind, listOf(kind)[index]?.id, index, patch);
  };

  const toggle = (kind: Kind, key: string) => {
    setOpenKey((prev) => ({ ...prev, [kind]: prev[kind] === key ? null : key }));
  };

  const addScene = () => {
    const next: Scene = { id: crypto.randomUUID(), name: '', desc: '' };
    onScenesChange((prev) => [...prev, next]);
    // 新建的场景卡直接展开，省得再点一下
    setOpenKey((prev) => ({ ...prev, scene: next.id ?? null }));
  };

  /**
   * 复制成状态变体：同一空间的陈设与光线沿用，只改名字与 state。
   *
   * 这是「多态场景卡」的唯一正确切分方式——按状态（白天 / 断电 / 火灾后）拆，
   * 而不是按机位拆。机位差用同一张卡的机位图集表达，否则 N 个视角会得到
   * N 份互不一致的陈设，问题只是从「跨镜漂移」变成「跨变体漂移」。
   */
  const addStateVariant = (index: number) => {
    const source = scenes[index];
    if (!source) return;
    const next: Scene = {
      ...source,
      id: crypto.randomUUID(),
      name: `${source.name}（新状态）`,
      state: source.state ? `${source.state} / 新状态` : '新状态',
      // 图与视角不能复制：状态不同，画面必须重新生成或上传
      imageUrl: undefined,
      angleRefs: undefined,
      inventory: (source.inventory ?? []).map((item) => ({ ...item })),
    };
    onScenesChange((prev) => [...prev, next]);
    setOpenKey((prev) => ({ ...prev, scene: next.id ?? null }));
  };

  const removeAt = (kind: Kind, index: number) => {
    const removed = listOf(kind)[index];
    const id = removed?.id;
    const drop = <T extends Card>(prev: T[]): T[] =>
      prev.filter((item, i) => (id ? item.id !== id : i !== index));
    if (kind === 'character') onCharactersChange(drop);
    else onScenesChange(drop);
    if (removed && openKey[kind] === keyOf(kind, removed, index)) {
      setOpenKey((prev) => ({ ...prev, [kind]: null }));
    }
  };

  /**
   * 换图时不删旧文件：旧图可能已经被某个镜头当成首帧 / 参考图引用着，
   * 删掉会让那条视频任务直接 404。.data/uploads 由用户自行清理。
   */
  const uploadImage = async (kind: Kind, index: number, file: File | null) => {
    if (!file) return;
    // await 之前先钉住 id：上传期间列表可能被增删，回来时位置就不一定还是这一张了
    const item = listOf(kind)[index];
    const id = item?.id;
    const key = keyOf(kind, item, index);
    markBusy(key, true);
    setError(null);
    try {
      const { media } = await api.uploadMedia(file);
      patchById(kind, id, index, { imageUrl: media.url });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      markBusy(key, false);
    }
  };

  /**
   * 场景卡的陈设清单 / 机位图集：整份数组写回，不做下标级 patch。
   *
   * 不用 patchAt 的原因：这两个字段都是数组，展开面板里可以同时增删多行，
   * 用快照拼出来的新数组会把 await 期间别人的改动覆盖掉。
   */
  const updateSceneArray = <K extends 'inventory' | 'angleRefs'>(
    index: number,
    field: K,
    updater: (prev: NonNullable<Scene[K]>) => NonNullable<Scene[K]>,
  ) => {
    const scene = scenes[index];
    onScenesChange((prev) =>
      prev.map((item, i) => {
        const hit = scene?.id ? item.id === scene.id : i === index;
        if (!hit) return item;
        const current = (item[field] ?? []) as NonNullable<Scene[K]>;
        return { ...item, [field]: updater(current) } as Scene;
      }),
    );
  };

  const addInventoryItem = (index: number) =>
    updateSceneArray(index, 'inventory', (prev) => [...prev, { name: '', fixed: true }]);

  const patchInventoryItem = (index: number, at: number, patch: Partial<SceneItem>) =>
    updateSceneArray(index, 'inventory', (prev) =>
      prev.map((item, i) => (i === at ? { ...item, ...patch } : item)),
    );

  const removeInventoryItem = (index: number, at: number) =>
    updateSceneArray(index, 'inventory', (prev) => prev.filter((_, i) => i !== at));

  const addAngleRef = (index: number) =>
    updateSceneArray(index, 'angleRefs', (prev) => [...prev, { angle: '', imageUrl: '' }]);

  const patchAngleRef = (index: number, at: number, patch: Partial<SceneAngleRef>) =>
    updateSceneArray(index, 'angleRefs', (prev) =>
      prev.map((item, i) => (i === at ? { ...item, ...patch } : item)),
    );

  const removeAngleRef = (index: number, at: number) =>
    updateSceneArray(index, 'angleRefs', (prev) => prev.filter((_, i) => i !== at));

  /** 机位图上传：await 回来时按 id 找回那张卡，不按下标 */
  const uploadAngleRef = async (index: number, at: number, file: File | null) => {
    if (!file) return;
    const scene = scenes[index];
    if (!scene) return;
    const key = keyOf('scene', scene, index);
    markBusy(key, true);
    setError(null);
    try {
      const { media } = await api.uploadMedia(file);
      onScenesChange((prev) =>
        prev.map((item, i) => {
          const hit = scene.id ? item.id === scene.id : i === index;
          if (!hit) return item;
          const refs = (item.angleRefs ?? []).map((ref, j) =>
            j === at ? { ...ref, imageUrl: media.url } : ref,
          );
          return { ...item, angleRefs: refs };
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      markBusy(key, false);
    }
  };

  const generate = async (kind: Kind, index: number) => {
    const item = listOf(kind)[index];
    const prompt = [item?.name, item?.desc].filter(Boolean).join('：').trim();
    if (!prompt) {
      setError(`先填${LABEL[kind]}的名称或描述，再生成配图`);
      return;
    }

    const id = item?.id;
    const key = keyOf(kind, item, index);
    // 同步占位：同一张卡同时只允许一个文生图请求
    if (!claimBusy(key)) return;
    setError(null);
    try {
      // 带上蓝图的固定英文短语与主体类型，卡片才会和逐镜视频里的长相 / 构图一致
      const { media } = await api.generateImage({
        prompt,
        promptEn: item?.promptEn,
        subjectType: kind === 'character' ? (item as Character | undefined)?.subjectType : undefined,
        kind,
        style,
      });
      patchById(kind, id, index, { imageUrl: media.url });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      markBusy(key, false);
    }
  };

  const renderSection = (kind: Kind) => {
    const list = listOf(kind);
    // 角色卡由剧本生成，没有就不显示区块；场景卡允许手动从空开始
    if (kind === 'character' && list.length === 0) return null;

    const current = openKey[kind];

    return (
      <div className="characters">
        <div className="characters-head">
          <span className="characters-title">{LABEL[kind]}</span>
          <span className="characters-hint">{HINT[kind]}</span>
          {kind === 'scene' && (
            <button
              className="btn btn--sm characters-new"
              type="button"
              onClick={addScene}
              disabled={disabled}
              title="在列表末尾新增一张空场景卡"
            >
              ＋ 新建场景
            </button>
          )}
        </div>

        {list.length === 0 && (
          <p className="cast-empty">还没有场景卡。生成剧本时会自动带出，也可以点「＋ 新建场景」。</p>
        )}

        {list.length > 0 && (
          <div className="cast-strip">
            {list.map((item, index) => {
              const key = keyOf(kind, item, index);
              const isOpen = current === key;
              const initial = nameOf(item).slice(0, 1);
              return (
                <div
                  key={key}
                  className={`cast-chip${isOpen ? ' is-open' : ''}`}
                  role="button"
                  tabIndex={0}
                  aria-expanded={isOpen}
                  onClick={() => toggle(kind, key)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      toggle(kind, key);
                    }
                  }}
                  title={item.desc || `点开编辑${LABEL[kind]}`}
                >
                  <span
                    className={`cast-chip-thumb${item.imageUrl ? ' is-viewable' : ''}`}
                    aria-hidden="true"
                    title={item.imageUrl ? '点击查看大图' : undefined}
                    onClick={(e) => {
                      // 点缩略图看大图，点名字仍然展开编辑
                      if (!item.imageUrl) return;
                      e.stopPropagation();
                      setViewer({ src: item.imageUrl, alt: nameOf(item) });
                    }}
                  >
                    {item.imageUrl ? <img src={item.imageUrl} alt="" /> : initial}
                  </span>
                  <span className="cast-chip-name">{nameOf(item)}</span>
                </div>
              );
            })}
          </div>
        )}

        {list.map((item, index) => {
          const key = keyOf(kind, item, index);
          // 手风琴：只渲染当前展开的那一张
          if (current !== key) return null;

          const working = busy.has(key);
          const hasImage = !!item.imageUrl;
          /** 场景卡独有字段（陈设清单 / 机位图集）；角色卡走 null 分支不渲染 */
          const sceneItem = kind === 'scene' ? (item as Scene) : null;
          return (
            <div className="cast-panel" key={`panel-${key}`}>
              <div className="cast-card">
                <div className="cast-thumb">
                  {hasImage ? (
                    <>
                      <button
                        className="cast-thumb-view"
                        type="button"
                        onClick={() => {
                          if (item.imageUrl) {
                            setViewer({ src: item.imageUrl, alt: nameOf(item) });
                          }
                        }}
                        title="点击查看大图"
                        aria-label="查看大图"
                      >
                        <img src={item.imageUrl} alt={item.name || '配图'} />
                      </button>
                      <button
                        className="cast-thumb-clear"
                        type="button"
                        onClick={() => void patchAt(kind, index, { imageUrl: undefined })}
                        title="移除这张配图"
                        aria-label="移除配图"
                        disabled={working || disabled}
                      >
                        ×
                      </button>
                    </>
                  ) : (
                    <span>无图</span>
                  )}
                </div>

                <div className="cast-fields">
                  <input
                    className="character-name"
                    value={item.name}
                    onChange={(e) => patchAt(kind, index, { name: e.target.value })}
                    placeholder={PLACEHOLDER[kind].name}
                    aria-label={`${LABEL[kind]}名称`}
                  />
                  <input
                    className="character-desc"
                    value={item.desc}
                    onChange={(e) => patchAt(kind, index, { desc: e.target.value })}
                    placeholder={PLACEHOLDER[kind].desc}
                    title={item.desc}
                    aria-label={`${LABEL[kind]}描述`}
                  />
                </div>

                <div className="cast-actions">
                  <button
                    className="btn btn--sm"
                    type="button"
                    onClick={() => void generate(kind, index)}
                    disabled={working || disabled}
                    title={
                      hasImage
                        ? `重新生成这张${LABEL[kind]}的配图，不会新增卡片`
                        : `给这张${LABEL[kind]}生成配图，不会新增卡片`
                    }
                  >
                    {working && <span className="spinner" />}
                    {working ? '生成中…' : hasImage ? '重新生成' : '生成配图'}
                  </button>

                  <label className={`btn btn--sm btn--ghost file-btn${working ? ' is-busy' : ''}`}>
                    <input
                      type="file"
                      accept="image/*"
                      hidden
                      disabled={working || disabled}
                      onChange={(e) => {
                        void uploadImage(kind, index, e.target.files?.[0] ?? null);
                        e.target.value = '';
                      }}
                    />
                    上传
                  </label>

                  {kind === 'scene' && (
                    <>
                      <button
                        className="btn btn--sm btn--ghost"
                        type="button"
                        onClick={() => addStateVariant(index)}
                        disabled={disabled}
                        title="复制这张场景卡的陈设与光线，作为同一空间的不同状态（白天 / 断电 / 火灾后）"
                      >
                        复制为状态
                      </button>
                      <button
                        className="cast-remove"
                        type="button"
                        onClick={() => removeAt(kind, index)}
                        title="从场景列表里删除这张卡"
                        aria-label="删除场景"
                        disabled={disabled}
                      >
                        删除
                      </button>
                    </>
                  )}
                </div>
              </div>

              {sceneItem && (
                <div className="cast-extra">
                  <div className="cast-extra-head">
                    <span className="cast-extra-title">固定陈设</span>
                    <span className="cast-extra-hint">
                      分镜里出现的家具与桌上物件都要登记在这里，否则每一镜都会重新摆一次
                    </span>
                    <button
                      className="btn btn--sm"
                      type="button"
                      onClick={() => addInventoryItem(index)}
                      disabled={disabled}
                    >
                      ＋ 添加
                    </button>
                  </div>

                  {(sceneItem.inventory ?? []).length === 0 && (
                    <p className="cast-extra-empty">
                      还没有陈设。点「＋ 添加」登记桌子、椅子、柜台、门窗、灯具、酒杯这类会被多个镜头看到的物件。
                    </p>
                  )}

                  {(sceneItem.inventory ?? []).map((entry, j) => (
                    <div className="cast-row" key={`inv-${key}-${j}`}>
                      <input
                        className="cast-row-name"
                        value={entry.name}
                        onChange={(e) => patchInventoryItem(index, j, { name: e.target.value })}
                        placeholder="中文名，如 长餐桌"
                        aria-label="陈设中文名"
                      />
                      <input
                        className="cast-row-en"
                        value={entry.en ?? ''}
                        onChange={(e) => patchInventoryItem(index, j, { en: e.target.value })}
                        placeholder="英文名 long oak table"
                        aria-label="陈设英文名"
                      />
                      <input
                        className="cast-row-where"
                        value={entry.where ?? ''}
                        onChange={(e) => patchInventoryItem(index, j, { where: e.target.value })}
                        placeholder="位置（中文）：桌头正对门"
                        aria-label="陈设位置（中文）"
                      />
                      <input
                        className="cast-row-where-en"
                        value={entry.whereEn ?? ''}
                        onChange={(e) => patchInventoryItem(index, j, { whereEn: e.target.value })}
                        placeholder="位置（英文，进提示词）：table head facing the door"
                        aria-label="陈设位置（英文）"
                        title="只有这一份会拼进视频提示词。缺省时只给英文名、不给位置——中文位置不会被提交"
                      />
                      <label
                        className="cast-row-fixed"
                        title="固定件：每个镜头都在同一位置；会被人拿起、推移的物件不要勾"
                      >
                        <input
                          type="checkbox"
                          checked={entry.fixed !== false}
                          onChange={(e) => patchInventoryItem(index, j, { fixed: e.target.checked })}
                          disabled={disabled}
                        />
                        固定
                      </label>
                      <button
                        className="cast-row-remove"
                        type="button"
                        onClick={() => removeInventoryItem(index, j)}
                        disabled={disabled}
                        aria-label="删除这条陈设"
                      >
                        ×
                      </button>
                    </div>
                  ))}

                  <div className="cast-extra-head">
                    <span className="cast-extra-title">机位图集</span>
                    <span className="cast-extra-hint">
                      同一空间不拆卡，按本镜景别自动挑一张；标签写 top 的那张是「布局卡」（俯视平面图），只给人对照走位，不会提交给视频模型
                    </span>
                    <button
                      className="btn btn--sm"
                      type="button"
                      onClick={() => addAngleRef(index)}
                      disabled={disabled}
                    >
                      ＋ 添加机位
                    </button>
                  </div>

                  {(sceneItem.angleRefs ?? []).map((ref, j) => (
                    <div className="cast-row" key={`ang-${key}-${j}`}>
                      <input
                        className="cast-row-angle"
                        value={ref.angle}
                        onChange={(e) => patchAngleRef(index, j, { angle: e.target.value })}
                        placeholder="机位 wide / close / reverse / top"
                        aria-label="机位标签"
                      />
                      <span className="cast-row-thumb">
                        {ref.imageUrl ? (
                          <button
                            className="cast-thumb-view"
                            type="button"
                            onClick={() => setViewer({ src: ref.imageUrl, alt: `${nameOf(item)} ${ref.angle}` })}
                            title="点击查看大图"
                          >
                            <img src={ref.imageUrl} alt="" />
                          </button>
                        ) : (
                          '无图'
                        )}
                      </span>
                      <label className="btn btn--sm btn--ghost file-btn">
                        <input
                          type="file"
                          accept="image/*"
                          hidden
                          disabled={working || disabled}
                          onChange={(e) => {
                            void uploadAngleRef(index, j, e.target.files?.[0] ?? null);
                            e.target.value = '';
                          }}
                        />
                        上传
                      </label>
                      <button
                        className="cast-row-remove"
                        type="button"
                        onClick={() => removeAngleRef(index, j)}
                        disabled={disabled}
                        aria-label="删除这个机位"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <>
      {onStyleChange && (
        <div className="cast-style">
          <span className="cast-style-label">整体画风</span>
          {/* 预设下拉：选完立刻生效；「自定义」只是把光标交给右边的输入框 */}
          <select
            className="select cast-style-select"
            value={presetLabel ?? CUSTOM_STYLE}
            onChange={(e) => {
              const value = e.target.value;
              if (value === CUSTOM_STYLE) {
                styleInputRef.current?.focus();
                styleInputRef.current?.select();
                return;
              }
              setStyleDraft(value);
              if (value !== style.trim()) onStyleChange(value);
            }}
            title="预设画风：生成配图与分镜提示词时会展开成完整的风格描述"
            aria-label="画风预设"
            disabled={disabled}
          >
            {STYLE_LABELS.map((label) => (
              <option key={label} value={label}>
                {label}
              </option>
            ))}
            <option value={CUSTOM_STYLE}>自定义…</option>
          </select>

          <input
            ref={styleInputRef}
            className="cast-style-input"
            value={styleDraft}
            onChange={(e) => setStyleDraft(e.target.value)}
            onBlur={() => {
              const next = styleDraft.trim();
              if (next !== style.trim()) onStyleChange(next);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
            placeholder="选预设，或自己写：1990 年代港片胶片质感，暖调霓虹，轻微颗粒"
            aria-label="整体画风"
            title="生成角色卡 / 场景卡配图与分镜提示词时作为画面风格（严格遵循）。选预设会展开成完整描述；手工改过的文本按原样使用"
            disabled={disabled}
          />
        </div>
      )}

      {error && <div className="cast-error">{error}</div>}
      {renderSection('character')}
      {renderSection('scene')}

      {viewer && (
        <div
          className="image-viewer"
          role="dialog"
          aria-modal="true"
          aria-label={viewer.alt || '查看大图'}
          onClick={() => setViewer(null)}
        >
          <button
            className="image-viewer-close"
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setViewer(null);
            }}
            aria-label="关闭大图"
            autoFocus
          >
            ×
          </button>
          <img
            src={viewer.src}
            alt={viewer.alt}
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </>
  );
}
