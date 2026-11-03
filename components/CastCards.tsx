'use client';

import { useState } from 'react';
import { api } from '@/lib/client';
import type { Character, Scene } from '@/lib/types';

/**
 * 角色卡 / 场景卡：
 * 默认收成一行 chip（缩略图 + 名字），点哪张就在下方展开它的详细内容与操作按钮，
 * 一次只展开一张（手风琴），避免整页被一堆输入框撑长。
 */

type Kind = 'character' | 'scene';

type Card = Character | Scene;

const LABEL: Record<Kind, string> = { character: '角色卡', scene: '场景卡' };

const HINT: Record<Kind, string> = {
  character: '外貌用于全片一致性；点名字展开编辑',
  scene: '空间设定用于全片一致性；点名字展开编辑',
};

const PLACEHOLDER: Record<Kind, { name: string; desc: string }> = {
  character: {
    name: '角色名',
    desc: '外形与身份：年龄 / 发型 / 服装颜色材质 / 随身道具',
  },
  scene: {
    name: '场景名，如 灯塔内部',
    desc: '空间描述：地点 / 时间 / 光线 / 主要陈设',
  },
};

interface Props {
  characters: Character[];
  scenes: Scene[];
  /** 整体视觉风格，生成配图时拼进提示词 */
  style?: string;
  disabled?: boolean;
  onCharactersChange: (next: Character[]) => void;
  onScenesChange: (next: Scene[]) => void;
}

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
}: Props) {
  /** 正在生成 / 上传的卡片 key */
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 每种卡各自展开一张（手风琴） */
  const [openKey, setOpenKey] = useState<Record<Kind, string | null>>({
    character: null,
    scene: null,
  });

  const listOf = (kind: Kind): Card[] => (kind === 'character' ? characters : scenes);

  const commit = (kind: Kind, next: Card[]) => {
    if (kind === 'character') onCharactersChange(next as Character[]);
    else onScenesChange(next as Scene[]);
  };

  const patchAt = (kind: Kind, index: number, patch: Partial<Character & Scene>) => {
    commit(
      kind,
      listOf(kind).map((item, i) => (i === index ? { ...item, ...patch } : item)),
    );
  };

  const toggle = (kind: Kind, key: string) => {
    setOpenKey((prev) => ({ ...prev, [kind]: prev[kind] === key ? null : key }));
  };

  const addScene = () => {
    const next: Scene = { id: crypto.randomUUID(), name: '', desc: '' };
    onScenesChange([...scenes, next]);
    // 新建的场景卡直接展开，省得再点一下
    setOpenKey((prev) => ({ ...prev, scene: next.id ?? null }));
  };

  const removeAt = (kind: Kind, index: number) => {
    const removed = listOf(kind)[index];
    commit(
      kind,
      listOf(kind).filter((_, i) => i !== index),
    );
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
    const key = keyOf(kind, listOf(kind)[index], index);
    setBusy(key);
    setError(null);
    try {
      const { media } = await api.uploadMedia(file);
      patchAt(kind, index, { imageUrl: media.url });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const generate = async (kind: Kind, index: number) => {
    const item = listOf(kind)[index];
    const prompt = [item?.name, item?.desc].filter(Boolean).join('：').trim();
    if (!prompt) {
      setError(`先填${LABEL[kind]}的名称或描述，再生成配图`);
      return;
    }

    const key = keyOf(kind, item, index);
    setBusy(key);
    setError(null);
    try {
      const { media } = await api.generateImage({ prompt, kind, style });
      patchAt(kind, index, { imageUrl: media.url });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
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
                <button
                  key={key}
                  type="button"
                  className={`cast-chip${isOpen ? ' is-open' : ''}`}
                  aria-expanded={isOpen}
                  onClick={() => toggle(kind, key)}
                  title={item.desc || `点开编辑${LABEL[kind]}`}
                >
                  <span className="cast-chip-thumb">
                    {item.imageUrl ? <img src={item.imageUrl} alt="" /> : initial}
                  </span>
                  <span className="cast-chip-name">{nameOf(item)}</span>
                </button>
              );
            })}
          </div>
        )}

        {list.map((item, index) => {
          const key = keyOf(kind, item, index);
          // 手风琴：只渲染当前展开的那一张
          if (current !== key) return null;

          const working = busy === key;
          const hasImage = !!item.imageUrl;
          return (
            <div className="cast-panel" key={`panel-${key}`}>
              <div className="cast-card">
                <div className="cast-thumb">
                  {hasImage ? (
                    <>
                      <img src={item.imageUrl} alt={item.name || '配图'} />
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
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <>
      {error && <div className="cast-error">{error}</div>}
      {renderSection('character')}
      {renderSection('scene')}
    </>
  );
}
