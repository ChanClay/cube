'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  MAX_NOVEL_CHARS,
  MAX_SHOT_COUNT,
  MIN_NOVEL_CHARS,
  MIN_SHOT_COUNT,
  shotLimits,
  splitByDuration,
  type ScriptMode,
} from '@/lib/skills/shot-plan';
import { STYLE_LABELS } from '@/lib/skills/style-presets';
import {
  DEFAULT_VIDEO_MODEL_ID,
  VIDEO_MODELS,
  normalizeVideoModel,
  videoModelSpec,
  type VideoModelId,
} from '@/lib/video-models';

/** 预设风格标签（明细描述见 lib/skills/style-presets，生成时自动展开） */
const STYLES = STYLE_LABELS;

export interface ScriptParams {
  idea: string;
  /** idea=短创意；novel=小说 / 章节原文，由服务端先压缩改编 */
  source: 'idea' | 'novel';
  style: string;
  /** 分镜方式：按镜头数 / 按总时长 */
  mode: ScriptMode;
  shotCount: number;
  shotDuration: number;
  /** 按总时长模式下的视频总时长（秒） */
  totalDuration: number;
  /** 这份剧本选定的视频模型，决定单镜时长区间与生成时的 provider */
  videoModel: VideoModelId;
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
  /** 编辑既有剧本时回填的视频模型 */
  initialVideoModel?: string;
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
  initialVideoModel,
  projectName,
  onProjectNameChange,
  onProjectNameCommit,
  submitText = '生成剧本',
  onGenerate,
  onLoadDemo,
}: Props) {
  const [idea, setIdea] = useState(initialIdea);
  const [source, setSource] = useState<'idea' | 'novel'>('idea');
  const [style, setStyle] = useState(initialStyle || STYLES[0]);
  const [mode, setMode] = useState<ScriptMode>('shots');
  const [shotCount, setShotCount] = useState(initialShotCount ?? 6);
  const [shotDuration, setShotDuration] = useState(initialShotDuration ?? 5);
  const [totalDuration, setTotalDuration] = useState(60);
  const [videoModel, setVideoModel] = useState<VideoModelId>(
    normalizeVideoModel(initialVideoModel, DEFAULT_VIDEO_MODEL_ID),
  );
  const fileInputRef = useRef<HTMLInputElement>(null);

  /** 导入 txt / md：直接切到小说模式，超长由下方提示拦下 */
  const importTextFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const text = await file.text();
      setSource('novel');
      setIdea(text.trim());
    } catch {
      window.alert('读取文件失败，请重试或直接粘贴原文');
    }
  };

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

  useEffect(() => {
    if (initialVideoModel) setVideoModel(normalizeVideoModel(initialVideoModel));
  }, [initialVideoModel]);

  /** 模型决定单镜 / 总时长区间，切模型时把已经越界的值收回来 */
  const limits = shotLimits(videoModel);
  useEffect(() => {
    setShotDuration((value) =>
      Math.min(limits.maxShot, Math.max(limits.minShot, value)),
    );
    setTotalDuration((value) =>
      Math.min(limits.maxTotal, Math.max(limits.minTotal, value)),
    );
  }, [limits.minShot, limits.maxShot, limits.minTotal, limits.maxTotal]);

  const ideaLength = idea.trim().length;
  const minChars = source === 'novel' ? MIN_NOVEL_CHARS : 4;
  const tooLong = source === 'novel' && ideaLength > MAX_NOVEL_CHARS;
  const ready = ideaLength >= minChars && !tooLong && !loading;

  const submit = () => {
    if (!ready) return;
    onGenerate({
      idea: idea.trim(),
      source,
      style,
      // 小说模式下镜头数 / 时长交给剧本模型，下面这些字段只用于兼容旧接口
      mode: source === 'novel' ? 'duration' : mode,
      shotCount,
      shotDuration,
      totalDuration,
      videoModel,
    });
  };

  const fillPercent =
    ((shotCount - MIN_SHOT_COUNT) / Math.max(1, MAX_SHOT_COUNT - MIN_SHOT_COUNT)) * 100;
  const durationFillPercent =
    ((shotDuration - limits.minShot) / Math.max(1, limits.maxShot - limits.minShot)) * 100;

  /** 总时长模式下的分镜预览：只给 AI 可选的镜数区间，由它按剧情决定切几刀 */
  const split = splitByDuration(totalDuration, limits);
  // 总时长按 1 秒粒度调整：下限 = 单镜下限，上限 = 单镜上限 × 最多镜数（随模型变化）
  const totalFillPercent =
    ((totalDuration - limits.minTotal) / Math.max(1, limits.maxTotal - limits.minTotal)) * 100;
  const overallSeconds = mode === 'duration' ? split.total : shotCount * shotDuration;
  const currentModel = videoModelSpec(videoModel);

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

          <div className="field">
            <div className="field-label">
              素材类型
              <span className="field-hint">
                {source === 'novel' ? '先压缩成一条主线，再分镜' : '一段创意 / 梗概'}
              </span>
            </div>
            <div className="seg" role="tablist" aria-label="素材类型">
              <button
                type="button"
                role="tab"
                aria-selected={source === 'idea'}
                className={`seg-btn${source === 'idea' ? ' is-active' : ''}`}
                onClick={() => setSource('idea')}
                disabled={loading}
              >
                故事创意
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={source === 'novel'}
                className={`seg-btn${source === 'novel' ? ' is-active' : ''}`}
                onClick={() => setSource('novel')}
                disabled={loading}
              >
                小说 / 章节
              </button>
            </div>
          </div>

          <div className="field idea-idea-field">
            <label className="field-label" htmlFor="idea">
              {source === 'novel' ? '小说 / 章节原文' : '故事创意'}
              <span className={`field-hint${tooLong ? ' field-hint--error' : ''}`}>
                {ideaLength} 字
              </span>
            </label>
            <textarea
              id="idea"
              className="textarea"
              rows={source === 'novel' ? 14 : 10}
              value={idea}
              onChange={(e) => setIdea(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit();
              }}
              placeholder={
                source === 'novel'
                  ? `粘贴一章或一段完整故事，建议 ${MIN_NOVEL_CHARS}~${MAX_NOVEL_CHARS} 字。\n\n系统会先保留一条主线、2~4 个人物、关键转折与结局，再拆成 6 分钟内的分镜。副线、次要人物和过场会被删掉。`
                  : `写一个故事想法，越具体越好。例如：\n\n暴雨夜的灯塔里，一位老守塔人发现海面上有一艘本该十年前就沉没的渔船正在靠近，他点亮了最后一束灯光……`
              }
            />
            {source === 'novel' && (
              <div className={`field-hint${tooLong ? ' field-hint--error' : ''}`} style={{ marginTop: 7 }}>
                {tooLong
                  ? `超出单次改编上限（${MAX_NOVEL_CHARS} 字），请先选一章或分段生成`
                  : `支持粘贴或导入 txt / md。会压缩成一条主线：删副线、次要人物与过场，保留主角、核心冲突、关键道具和结局。不足 ${MIN_NOVEL_CHARS} 字请改用「故事创意」。`}
              </div>
            )}
          </div>
        </div>

        <aside className="idea-col-side">
          <div className="field">
            <label className="field-label" htmlFor="video-model">
              视频模型
              <span className="field-hint">
                单镜 {currentModel.minShotSeconds}~{currentModel.maxShotSeconds} 秒
              </span>
            </label>
            <select
              id="video-model"
              className="select"
              value={videoModel}
              onChange={(e) => setVideoModel(normalizeVideoModel(e.target.value))}
              disabled={loading}
            >
              {VIDEO_MODELS.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label} · {model.summary}
                </option>
              ))}
            </select>
            <div className="field-hint" style={{ marginTop: 7 }}>
              生成分镜时按这个模型的时长区间规划；剧本创建后固定，生成视频时按它选接口
            </div>
          </div>

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

          {source === 'novel' ? (
            <div className="field">
              <div className="field-label">分镜与时长</div>
              <div className="field-hint">
                由剧本 LLM 根据剧情决定镜头数量、每镜时长和总时长（
                {MIN_SHOT_COUNT}~{MAX_SHOT_COUNT} 镜、每镜 {limits.minShot}~{limits.maxShot} 秒、
                总时长 {limits.minTotal}~{limits.maxTotal} 秒），用户不再手动指定。
              </div>
            </div>
          ) : (
            <>
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
                        min={MIN_SHOT_COUNT}
                        max={MAX_SHOT_COUNT}
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
                      <span className="field-hint">
                        {limits.minShot}~{limits.maxShot} 秒
                      </span>
                    </div>
                    <div className="range-row">
                      <input
                        className="range"
                        type="range"
                        min={limits.minShot}
                        max={limits.maxShot}
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
                        AI 决定 {split.minShotCount}~{split.maxShotCount} 镜
                      </span>
                    </div>
                    <div className="range-row">
                      <input
                        className="range"
                        type="range"
                        min={limits.minTotal}
                        max={limits.maxTotal}
                        step={1}
                        value={totalDuration}
                        style={{ '--fill': `${totalFillPercent}%` } as CSSProperties}
                        onChange={(e) => setTotalDuration(Number(e.target.value))}
                        aria-label="视频总时长（秒）"
                      />
                      <span className="range-value">{totalDuration} 秒</span>
                    </div>
                    <div className="field-hint" style={{ marginTop: 7 }}>
                      单镜 {limits.minShot}~{limits.maxShot} 秒（{currentModel.label}
                      ），由 AI 按剧情分配；串联性强的段落会合并成一个镜头
                    </div>
                  </div>
                </>
              )}
            </>
          )}

          <div className="idea-actions">
            <button className="btn btn--primary" onClick={submit} disabled={!ready}>
              {loading ? (
                <>
                  <span className="spinner" />
                  {source === 'novel' ? '改编分镜中…' : '串联分镜中…'}
                </>
              ) : source === 'novel' ? (
                '改编成分镜'
              ) : (
                submitText
              )}
            </button>
            {loading && source === 'novel' && (
              <div className="field-hint" style={{ marginTop: 7 }}>
                正在分段摘要并压缩成蓝图，长文通常需要 1~2 分钟，请勿关闭页面。
              </div>
            )}
            <div className="idea-actions-sub">
              {source === 'novel' && (
                <>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".txt,.md,text/plain,text/markdown"
                    hidden
                    onChange={(e) => {
                      void importTextFile(e.target.files?.[0]);
                      e.target.value = '';
                    }}
                  />
                  <button
                    className="btn btn--ghost btn--sm"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={loading}
                  >
                    导入 txt / md
                  </button>
                </>
              )}
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
