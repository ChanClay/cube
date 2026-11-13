'use client';

import { useCallback, useEffect, useState } from 'react';
import TopBar from '@/components/TopBar';
import { api, type HealthInfo, type VideoModelSettings } from '@/lib/client';
import type { VideoModelId, VideoModelSpec } from '@/lib/video-models';

/** 输入格式的短标签（tag 上的字），完整说明放在 title 里悬停可见 */
const INPUT_KIND_TAG: Record<string, string> = {
  text: '文本',
  image: '图片',
  reference: '参考素材',
};

const AUDIO_LABEL: Record<VideoModelSpec['audio'], string> = {
  always: '原生音轨（不可关）',
  toggle: '音轨可开关',
};

interface ModelCardProps {
  model: VideoModelSpec;
  isDefault: boolean;
  setting: boolean;
  /** 是否可以上移 / 下移（第一个不能上移，最后一个不能下移） */
  canMoveUp: boolean;
  canMoveDown: boolean;
  onSetDefault: (modelId: VideoModelSpec['id']) => void;
  onMove: (modelId: VideoModelSpec['id'], direction: 'up' | 'down') => void;
}

function ModelCard({
  model,
  isDefault,
  setting,
  canMoveUp,
  canMoveDown,
  onSetDefault,
  onMove,
}: ModelCardProps) {
  return (
    <section className={`model-card${isDefault ? ' model-card--default' : ''}`}>
      <header className="model-card-head">
        <div>
          <h3>{model.label}</h3>
          <p>{model.summary}</p>
        </div>
        <div className="model-card-actions">
          <span className="model-sort" title="顺序即新建剧本下拉框里的模型顺序">
            <button
              className="model-sort-btn"
              onClick={() => onMove(model.id, 'up')}
              disabled={!canMoveUp || setting}
              aria-label={`上移 ${model.label}`}
            >
              ↑
            </button>
            <button
              className="model-sort-btn"
              onClick={() => onMove(model.id, 'down')}
              disabled={!canMoveDown || setting}
              aria-label={`下移 ${model.label}`}
            >
              ↓
            </button>
          </span>
          {isDefault ? (
            <span className="pill pill--ok" title="新建剧本时默认选中这个模型">
              <span className="dot" />
              默认模型
            </span>
          ) : (
            <button
              className="btn btn--ghost btn--sm"
              onClick={() => onSetDefault(model.id)}
              disabled={setting}
              title="新建剧本时默认选中这个模型"
            >
              {setting ? <span className="spinner" /> : null}
              设为默认
            </button>
          )}
        </div>
      </header>

      <div className="model-specs">
        <span title="单个镜头的时长区间（秒）">
          单镜时长 {model.minShotSeconds}~{model.maxShotSeconds}s
        </span>
        <span title="单镜「一次生成」的质量线，只写进提示词供 AI 权衡">
          质量线 {model.preferredShotSeconds}s
        </span>
        <span title="一份剧本最多几镜">≤{model.maxShotCount} 镜</span>
        <span title={AUDIO_LABEL[model.audio]}>{AUDIO_LABEL[model.audio]}</span>
      </div>

      <div className="model-section">
        <h4>支持的输入格式</h4>
        <ul className="model-inputs">
          {model.inputs.map((input) => (
            <li key={input.kind} className="model-input">
              <span className="tag">{INPUT_KIND_TAG[input.kind] ?? input.kind}</span>
              <b>{input.label}</b>
              <span className="model-input-detail">{input.detail}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

export default function ModelsPage() {
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [settings, setSettings] = useState<VideoModelSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [settingId, setSettingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.videoModels();
      setSettings(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    api.health().then(setHealth).catch(() => setHealth(null));
    void load();
  }, [load]);

  const setDefault = useCallback(
    async (modelId: VideoModelSpec['id']) => {
      if (settingId) return;
      setSettingId(modelId);
      try {
        const { defaultModel } = await api.setDefaultModel(modelId);
        setSettings((prev) => (prev ? { ...prev, defaultModel } : prev));
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSettingId(null);
      }
    },
    [settingId],
  );

  /** 上移 / 下移并保存顺序；顺序即新建剧本下拉框里的模型顺序 */
  const move = useCallback(
    async (modelId: VideoModelSpec['id'], direction: 'up' | 'down') => {
      if (settingId || !settings) return;
      const ids = settings.models.map((model) => model.id);
      const index = ids.indexOf(modelId);
      const target = direction === 'up' ? index - 1 : index + 1;
      if (index === -1 || target < 0 || target >= ids.length) return;

      const next = [...ids];
      [next[index], next[target]] = [next[target], next[index]];

      // 乐观更新，保存失败时重新拉取
      setSettings({
        ...settings,
        models: next.map(
          (id) => settings.models.find((model) => model.id === id) as VideoModelSpec,
        ),
      });
      setSettingId(modelId);
      try {
        const { models } = await api.setModelOrder(next as VideoModelId[]);
        setSettings((prev) => (prev ? { ...prev, models } : prev));
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        void load();
      } finally {
        setSettingId(null);
      }
    },
    [settingId, settings, load],
  );

  return (
    <div className="app">
      <TopBar health={health} homeLink />

      <main className="models-page">
        <div className="models-head">
          <div>
            <h1>模型管理</h1>
            <p>
              只展示已在 .env.local 配置好 API Key 的视频模型。箭头调整顺序（即新建剧本下拉框里的顺序），「设为默认」决定新建剧本时默认选中谁。
            </p>
          </div>
          <button className="btn btn--ghost btn--sm" onClick={() => void load()} disabled={loading}>
            {loading ? <span className="spinner" /> : null}
            刷新
          </button>
        </div>

        {error && <div className="models-error">{error}</div>}

        {loading && !settings ? (
          <div className="models-empty">正在读取模型配置…</div>
        ) : settings && settings.models.length === 0 ? (
          <div className="models-empty">
            还没有任何已配置的视频模型。请在 .env.local 里填好
            <code>VIDEO_API_KEY</code>（百炼：HappyHorse / Wan 3.0）或
            <code>VIDEO_SEEDANCE_API_KEY</code>（火山方舟），然后重启服务。
          </div>
        ) : (
          <div className="model-list">
            {settings?.models.map((model, index) => (
              <ModelCard
                key={model.id}
                model={model}
                isDefault={model.id === settings.defaultModel}
                setting={settingId === model.id}
                canMoveUp={index > 0}
                canMoveDown={index < settings.models.length - 1}
                onSetDefault={(id) => void setDefault(id)}
                onMove={(id, direction) => void move(id, direction)}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
