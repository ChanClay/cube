'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import {
  MAX_SHOT_SECONDS,
  MAX_TOTAL_SECONDS,
  MIN_SHOT_SECONDS,
  MIN_TOTAL_SECONDS,
  splitByDuration,
  type ScriptMode,
} from '@/lib/shot-plan';

const STYLES = ['电影感写实', '日系动画', '3D 动画', '水墨国风', '赛博朋克', '复古胶片', '二维插画'];

export interface ScriptParams {
  idea: string;
  style: string;
  /** 分镜方式：按镜头数 / 按总时长 */
  mode: ScriptMode;
  shotCount: number;
  shotDuration: number;
  /** 按总时长模式下的视频总时长（秒） */
  totalDuration: number;
  /** 按总时长模式：是否保证故事完整性（镜头更少、每镜凑满 30 秒） */
  ensureCompleteness: boolean;
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
  /** 项目名（新建项目时就是在这里改）：传了才渲染这一行 */
  projectName?: string;
  onProjectNameChange?: (value: string) => void;
  /** 失焦 / 回车时落库 */
  onProjectNameCommit?: () => void;
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
  projectName,
  onProjectNameChange,
  onProjectNameCommit,
  submitText = '生成剧本',
  onGenerate,
  onLoadDemo,
}: Props) {
  const [idea, setIdea] = useState(initialIdea);
  const [style, setStyle] = useState(initialStyle || STYLES[0]);
  const [mode, setMode] = useState<ScriptMode>('shots');
  const [shotCount, setShotCount] = useState(initialShotCount ?? 6);
  const [shotDuration, setShotDuration] = useState(initialShotDuration ?? 5);
  const [totalDuration, setTotalDuration] = useState(60);
  /** 默认开启：宁可少切几刀，也别把故事切碎 */
  const [ensureCompleteness, setEnsureCompleteness] = useState(true);

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
    onGenerate({
      idea: idea.trim(),
      style,
      mode,
      shotCount,
      shotDuration,
      totalDuration,
      ensureCompleteness,
    });
  };

  const fillPercent = ((shotCount - 1) / 11) * 100;
  const durationFillPercent = ((shotDuration - 2) / 28) * 100;

  /** 总时长模式下的分镜预览：镜头数与每镜秒数都由总时长反推 */
  const split = splitByDuration(totalDuration, ensureCompleteness);
  // 总时长按 1 秒粒度调整：2 秒（单镜下限）~ 360 秒（12 镜 × 30 秒）
  const totalFillPercent =
    ((totalDuration - MIN_TOTAL_SECONDS) / (MAX_TOTAL_SECONDS - MIN_TOTAL_SECONDS)) * 100;
  const overallSeconds = mode === 'duration' ? split.total : shotCount * shotDuration;

  return (
    <div className="panel-body idea-form">
      {llmConfigured === false && (
        <div className="alert alert--warn">
          未检测到 <code>LLM_API_KEY</code>。请填写 <code>.env.local</code> 后重启服务，也可以先
          「加载示例剧本」预览整个流程。
        </div>
      )}

      {/* 左栏写内容，右栏调参数，一屏内左右分工 */}
      <div className="idea-split">
        <div className="idea-col-main">
          {projectName !== undefined && (
            <div className="field">
              <label className="field-label" htmlFor="project-name">
                项目名称
                <span className="field-hint">回车或点空白处保存</span>
              </label>
              <input
                id="project-name"
                className="input"
                value={projectName}
                onChange={(e) => onProjectNameChange?.(e.target.value)}
                onBlur={() => onProjectNameCommit?.()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                }}
                placeholder="给这个项目起个名字"
                aria-label="项目名称"
                disabled={loading}
              />
            </div>
          )}

          <div className="field idea-idea-field">
            <label className="field-label" htmlFor="idea">
              故事创意
              <span className="field-hint">{idea.trim().length} 字</span>
            </label>
            <textarea
              id="idea"
              className="textarea"
              rows={10}
              value={idea}
              onChange={(e) => setIdea(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit();
              }}
              placeholder={`写一个故事想法，越具体越好。例如：\n\n暴雨夜的灯塔里，一位老守塔人发现海面上有一艘本该十年前就沉没的渔船正在靠近，他点亮了最后一束灯光……`}
            />
          </div>
        </div>

        <aside className="idea-col-side">
          <div className="field">
            <label className="field-label" htmlFor="style">
              视觉风格
            </label>
            <select
              id="style"
              className="select"
              value={style}
              onChange={(e) => setStyle(e.target.value)}
            >
              {(STYLES.includes(style) ? STYLES : [style, ...STYLES]).map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <div className="field-label">
              分镜方式
              <span className="field-hint">全片约 {overallSeconds} 秒</span>
            </div>
            <div className="seg" role="tablist" aria-label="分镜方式">
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'shots'}
                className={`seg-btn${mode === 'shots' ? ' is-active' : ''}`}
                onClick={() => setMode('shots')}
                disabled={loading}
              >
                按镜头数量
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'duration'}
                className={`seg-btn${mode === 'duration' ? ' is-active' : ''}`}
                onClick={() => setMode('duration')}
                disabled={loading}
              >
                按总时长
              </button>
            </div>
          </div>

          {mode === 'shots' ? (
            <>
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
                  <span className="field-hint">2~30 秒</span>
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
            </>
          ) : (
            <>
              <div className="field">
                <div className="field-label">
                  视频总时长
                  <span className="field-hint">
                    {split.dynamic
                      ? `AI 决定 ${split.minShotCount}~${split.maxShotCount} 镜`
                      : `${split.shotCount} 个镜头`}
                  </span>
                </div>
                <div className="range-row">
                  <input
                    className="range"
                    type="range"
                    min={MIN_TOTAL_SECONDS}
                    max={MAX_TOTAL_SECONDS}
                    step={1}
                    value={totalDuration}
                    style={{ '--fill': `${totalFillPercent}%` } as CSSProperties}
                    onChange={(e) => setTotalDuration(Number(e.target.value))}
                    aria-label="视频总时长（秒）"
                  />
                  <span className="range-value">{totalDuration} 秒</span>
                </div>
                <div className="field-hint" style={{ marginTop: 7 }}>
                  {split.dynamic
                    ? `单镜 ${MIN_SHOT_SECONDS}~${MAX_SHOT_SECONDS} 秒，由 AI 按剧情分配`
                    : `镜头时长：${split.durations.join(' / ')} 秒`}
                </div>
              </div>

              <div className="field">
                <div className="field-label">
                  保证完整性
                  <span className="field-hint">默认开启</span>
                </div>
                <label
                  className="shot-switch"
                  title="开启后分镜数量减少，每个镜头尽量凑满 30 秒，故事被切碎的风险更低；关闭则由 AI 分析剧情自行判断切几刀，只保证单镜不超过 30 秒、总时长不变"
                >
                  <input
                    type="checkbox"
                    className="shot-switch-input"
                    checked={ensureCompleteness}
                    disabled={loading}
                    onChange={(e) => setEnsureCompleteness(e.target.checked)}
                  />
                  <span className="shot-switch-track" aria-hidden="true">
                    <span className="shot-switch-thumb" />
                  </span>
                  <span>减少分镜、每镜凑满 30 秒</span>
                </label>
                <div className="field-hint" style={{ marginTop: 7 }}>
                  {ensureCompleteness
                    ? `固定 ${split.shotCount} 镜，每镜尽量凑满 30 秒`
                    : `由 AI 判断切几刀（${split.minShotCount}~${split.maxShotCount} 镜）`}
                </div>
              </div>
            </>
          )}

          <div className="idea-actions">
            <button className="btn btn--primary" onClick={submit} disabled={!ready}>
              {loading ? (
                <>
                  <span className="spinner" />
                  串联分镜中…
                </>
              ) : (
                submitText
              )}
            </button>
            <div className="idea-actions-sub">
              <button className="btn btn--ghost btn--sm" onClick={onLoadDemo} disabled={loading}>
                加载示例剧本
              </button>
              <button
                className="btn btn--ghost btn--sm"
                onClick={() => {
                  setIdea('');
                }}
                disabled={loading || !idea}
              >
                清空
              </button>
            </div>
          </div>

          <div className="idea-tip">
            每个镜头的「视频提示词」都可手动修改后再提交。
            <code>⌘/Ctrl + Enter</code> 快速生成剧本。
          </div>
        </aside>
      </div>
    </div>
  );
}
