'use client';

import { useEffect, useState, type CSSProperties } from 'react';

const STYLES = ['电影感写实', '日系动画', '3D 动画', '水墨国风', '赛博朋克', '复古胶片', '二维插画'];

export interface ScriptParams {
  idea: string;
  style: string;
  shotCount: number;
  shotDuration: number;
}

interface Props {
  loading: boolean;
  llmConfigured: boolean | null;
  /** 从数据库恢复的创意，用于回填输入框 */
  initialIdea?: string;
  /** 编辑既有剧本时回填的视觉风格 */
  initialStyle?: string;
  /** 编辑既有剧本时回填的镜头数量 */
  initialShotCount?: number;
  /** 编辑既有剧本时回填的单镜头时长 */
  initialShotDuration?: number;
  /** 提交按钮文案，默认「生成剧本」 */
  submitText?: string;
  onGenerate: (params: ScriptParams) => void;
  onLoadDemo: () => void;
}

export default function IdeaForm({
  loading,
  llmConfigured,
  initialIdea = '',
  initialStyle = '',
  initialShotCount,
  initialShotDuration,
  submitText = '生成剧本',
  onGenerate,
  onLoadDemo,
}: Props) {
  const [idea, setIdea] = useState(initialIdea);
  const [style, setStyle] = useState(initialStyle || STYLES[0]);
  const [shotCount, setShotCount] = useState(initialShotCount ?? 6);
  const [shotDuration, setShotDuration] = useState(initialShotDuration ?? 5);

  useEffect(() => {
    setIdea(initialIdea);
  }, [initialIdea]);

  useEffect(() => {
    if (initialStyle) setStyle(initialStyle);
  }, [initialStyle]);

  useEffect(() => {
    if (initialShotCount) setShotCount(initialShotCount);
  }, [initialShotCount]);

  useEffect(() => {
    if (initialShotDuration) setShotDuration(initialShotDuration);
  }, [initialShotDuration]);

  const ready = idea.trim().length >= 4 && !loading;

  const submit = () => {
    if (!ready) return;
    onGenerate({ idea: idea.trim(), style, shotCount, shotDuration });
  };

  const fillPercent = ((shotCount - 1) / 11) * 100;
  const durationFillPercent = ((shotDuration - 2) / 28) * 100;

  return (
    <div className="panel-body">
      {llmConfigured === false && (
        <div className="alert alert--warn">
          未检测到 <code>LLM_API_KEY</code>。请填写 <code>.env.local</code> 后重启服务；也可以先
          「加载示例剧本」预览整个流程。
        </div>
      )}

      <div className="field">
        <label className="field-label" htmlFor="idea">
          故事创意
          <span className="field-hint">{idea.trim().length} 字</span>
        </label>
        <textarea
          id="idea"
          className="textarea"
          rows={6}
          value={idea}
          onChange={(e) => setIdea(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit();
          }}
          placeholder={`写一个故事想法，越具体越好。例如：\n\n暴雨夜的灯塔里，一位老守塔人发现海面上有一艘本该十年前就沉没的渔船正在靠近，他点亮了最后一束灯光……`}
        />
      </div>

      <div className="field">
        <label className="field-label" htmlFor="style">
          视觉风格
        </label>
        <select id="style" className="select" value={style} onChange={(e) => setStyle(e.target.value)}>
          {(STYLES.includes(style) ? STYLES : [style, ...STYLES]).map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <div className="field-label">
          镜头数量
          <span className="field-hint">约 {shotCount * shotDuration} 秒</span>
        </div>
        <div className="range-row">
          <input
            className="range"
            type="range"
            min={1}
            max={12}
            step={1}
            value={shotCount}
            style={{ '--fill': `${fillPercent}%` } as CSSProperties}
            onChange={(e) => setShotCount(Number(e.target.value))}
            aria-label="镜头数量"
          />
          <span className="range-value">{shotCount}</span>
        </div>
      </div>

      <div className="field">
        <div className="field-label">
          单镜头时长
          <span className="field-hint">wan3.0 支持 2~30 秒</span>
        </div>
        <div className="range-row">
          <input
            className="range"
            type="range"
            min={2}
            max={30}
            step={1}
            value={shotDuration}
            style={{ '--fill': `${durationFillPercent}%` } as CSSProperties}
            onChange={(e) => setShotDuration(Number(e.target.value))}
            aria-label="单镜头时长（秒）"
          />
          <span className="range-value">{shotDuration} 秒</span>
        </div>
      </div>

      <button className="btn btn--primary btn--block" onClick={submit} disabled={!ready}>
        {loading ? (
          <>
            <span className="spinner" />
            串联分镜中…
          </>
        ) : (
          submitText
        )}
      </button>

      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <button className="btn btn--ghost btn--sm" style={{ flex: 1 }} onClick={onLoadDemo} disabled={loading}>
          加载示例剧本
        </button>
        <button
          className="btn btn--ghost btn--sm"
          style={{ flex: 1 }}
          onClick={() => {
            setIdea('');
          }}
          disabled={loading || !idea}
        >
          清空
        </button>
      </div>

      <div className="alert alert--info" style={{ marginTop: 16, marginBottom: 0 }}>
        每个镜头的「视频提示词」都可手动修改后再提交。<code>⌘/Ctrl + Enter</code> 快速生成剧本。
      </div>
    </div>
  );
}
