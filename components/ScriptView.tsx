'use client';

import { useEffect, useState } from 'react';
import CastCards from './CastCards';
import ShotCard from './ShotCard';
import { isSameTakeShot, prevFrameCast } from '@/lib/shot-media';
import type {
  Character,
  ComposeResult,
  Scene,
  Script,
  Shot,
  StoredScriptSummary,
  VideoJob,
} from '@/lib/types';

interface Props {
  script: Script | null;
  loading: boolean;
  error: string | null;
  jobs: Record<string, VideoJob>;
  /** 存库的原始故事创意，展示在剧本信息里 */
  idea?: string;
  onShotChange: (shotId: string, patch: Partial<Shot>) => void;
  onGenerate: (shot: Shot) => void;
  onGenerateAll: () => void;
  generatingAll: boolean;
  /** 串行队列进度提示（一次只生成一镜） */
  queueInfo?: string | null;
  saveState: 'idle' | 'saving' | 'saved' | 'error';
  onCompose: () => void;
  composeState: 'idle' | 'running' | 'done' | 'error';
  composeResult: ComposeResult | null;
  composeError: string | null;
  /** ffmpeg 是否可用 */
  composeReady: boolean;
  /** 本项目下的全部剧本，用于切换 */
  scripts?: StoredScriptSummary[];
  currentScriptId?: string | null;
  onSelectScript?: (id: string) => void;
  switching?: boolean;
  /** 角色卡编辑（改名 / 改外形 / 换配图） */
  onCharactersChange?: (next: Character[]) => void;
  /** 场景卡编辑（新增 / 删除 / 改描述 / 换配图） */
  onScenesChange?: (next: Scene[]) => void;
  /** 修改整体画风：角色卡 / 场景卡配图与分镜提示词都用它 */
  onStyleChange?: (style: string) => void;
  /** 新建一份空白剧本（只有这里会新增剧本记录） */
  onNewScript?: () => void;
  /** 删除当前剧本 */
  onDeleteScript?: () => void;
  /** 修改剧本名称 */
  onScriptTitleChange?: (title: string) => void;
  /** 编辑故事创意：把当前创意回填到创意页表单 */
  onEditIdea?: () => void;
  /** 已生成过视频时，带着当前创意重新新建一份剧本 */
  onRecreateIdea?: () => void;
  /** 承接上一镜末帧的镜头是否不出声（服务端配置，用来提示用户） */
  carryMuted?: boolean;
  /** 末帧参考图的总开关（服务端配置），关掉后镜头卡片上的选项不可用 */
  prevFrameRefEnabled?: boolean;
  /** 手动在当前剧本末尾添加一镜 */
  onAddShot?: () => void;
  /** 放弃某一镜的生成 */
  onAbandonShot?: (shot: Shot) => void;
  /** 停止串行生成 */
  onStopGenerate?: () => void;
  /** 已点停止，正在退出队列 */
  stopping?: boolean;
}

const SAVE_TEXT = {
  idle: '本地库',
  saving: '保存中…',
  saved: '已入库',
  error: '保存失败',
} as const;

const FilmIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
    <rect x="2.5" y="4.5" width="19" height="15" rx="2.5" />
    <path d="M7 4.5v15M17 4.5v15M2.5 12h19M2.5 8h4.5M17 8h4.5M2.5 16h4.5M17 16h4.5" />
  </svg>
);

export default function ScriptView({
  script,
  loading,
  error,
  jobs,
  onShotChange,
  onGenerate,
  onGenerateAll,
  generatingAll,
  queueInfo = null,
  saveState,
  onCompose,
  composeState,
  composeResult,
  composeError,
  composeReady,
  scripts = [],
  currentScriptId = null,
  onSelectScript,
  switching = false,
  onCharactersChange,
  onScenesChange,
  onStyleChange,
  onNewScript,
  onDeleteScript,
  onScriptTitleChange,
  idea = '',
  onEditIdea,
  onRecreateIdea,
  carryMuted = true,
  prevFrameRefEnabled = true,
  onAddShot,
  onAbandonShot,
  onStopGenerate,
  stopping = false,
}: Props) {
  const totalDuration = script?.shots.reduce((sum, shot) => sum + shot.duration, 0) ?? 0;
  /** 衔接结构：几处接帧、几处硬切。接帧的镜头拿不到卡片参考图，直接影响人物一致性 */
  const sameTakeCount = script?.shots.filter((shot) => isSameTakeShot(shot)).length ?? 0;
  const doneCount = script?.shots.filter((shot) => jobs[shot.id]?.status === 'succeeded').length ?? 0;
  const busyCount = Object.values(jobs).filter(
    (job) => job.status === 'queued' || job.status === 'running',
  ).length;

  /** 合成结果不再常驻页面，点按钮才弹窗看 */
  const [composeOpen, setComposeOpen] = useState(false);
  const composed = composeState === 'done' && !!composeResult;

  useEffect(() => {
    if (!composeOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setComposeOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [composeOpen]);

  return (
    <>
      <div className="panel-head">
        <div className="script-head-left">
          <div className="panel-title">分镜剧本</div>
          {onNewScript && (
            <button
              className="btn btn--sm"
              type="button"
              onClick={onNewScript}
              disabled={loading || switching}
              title="新建剧本：先进入故事创意页，写完创意生成后才会落库"
            >
              ＋ 新建剧本
            </button>
          )}
          {scripts.length > 1 && onSelectScript && (
            <select
              className="select script-switch"
              value={currentScriptId ?? ''}
              onChange={(e) => onSelectScript(e.target.value)}
              disabled={switching}
              aria-label="切换剧本"
            >
              {scripts.map((item) => (
                <option key={item.id} value={item.id}>
                  {(item.title || '未命名剧本').slice(0, 18)} · {item.shotCount} 镜
                </option>
              ))}
            </select>
          )}
          {script && onDeleteScript && (
            <button
              className="btn btn--sm btn--ghost script-delete"
              type="button"
              onClick={onDeleteScript}
              disabled={switching || scripts.length <= 1}
              title={
                scripts.length <= 1
                  ? '至少要保留一份剧本'
                  : '删除当前这份剧本'
              }
            >
              删除剧本
            </button>
          )}
        </div>
        {script && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="tag">
              {script.shots.length} 镜头 · {totalDuration}s
            </span>
            {doneCount > 0 && (
              <span className="tag tag--accent">
                {doneCount}/{script.shots.length} 已生成
              </span>
            )}
            {(queueInfo || generatingAll) && (
              <span className="tag" title="串行队列：一次只生成一个镜头，打开承接开关的镜头会用上一镜末帧衔接">
                {queueInfo ?? '队列中…'}
              </span>
            )}
            <button
              className="btn btn--sm btn--primary"
              onClick={onGenerateAll}
              disabled={generatingAll || busyCount > 0 || doneCount === script.shots.length}
              title="串行生成：按每个镜头的「承接上一镜末帧」开关决定是否用上一镜末帧当首帧"
            >
              {generatingAll || busyCount > 0 ? (
                <>
                  <span className="spinner" />
                  生成中…
                </>
              ) : (
                '全部生成'
              )}
            </button>
            {generatingAll && onStopGenerate && (
              <button
                className="btn btn--sm btn--danger"
                onClick={onStopGenerate}
                disabled={stopping}
                title="停止串行生成：不再继续后面的镜头；已经提交到云端的那一镜仍会生成完"
              >
                {stopping ? <span className="spinner" /> : null}
                {stopping ? '停止中…' : '停止'}
              </button>
            )}
          </div>
        )}
      </div>

      <div className="panel-body">
        {error && <div className="alert alert--error">{error}</div>}

        {loading && (
          <>
            <div className="skeleton-card">
              <div className="sk-line" style={{ width: '38%', height: 16 }} />
              <div className="sk-line" style={{ width: '72%' }} />
              <div className="sk-line" style={{ width: '52%' }} />
            </div>
            {[0, 1, 2].map((i) => (
              <div className="skeleton-card" key={i}>
                <div className="sk-line" style={{ width: '30%', height: 13 }} />
                <div className="sk-line" style={{ width: '92%' }} />
                <div className="sk-line" style={{ width: '80%' }} />
                <div className="sk-line" style={{ width: '64%', marginBottom: 0 }} />
              </div>
            ))}
          </>
        )}

        {!loading && !script && (
          <div className="empty">
            <div className="empty-icon">
              <FilmIcon />
            </div>
            <h3>还没有剧本</h3>
            <p>先新建剧本，在故事创意页写下想法并生成分镜。</p>
            {onNewScript && (
              <button
                className="btn btn--primary"
                type="button"
                onClick={onNewScript}
                disabled={loading}
              >
                ＋ 新建剧本
              </button>
            )}
            <ol>
              <li>
                <b>1</b>
                <span>新建剧本，在故事创意页输入创意，选择风格与镜头数</span>
              </li>
              <li>
                <b>2</b>
                <span>检查剧本，按需修改每个镜头的提示词</span>
              </li>
              <li>
                <b>3</b>
                <span>单镜头生成或一键全部生成，视频可直接播放</span>
              </li>
            </ol>
          </div>
        )}

        {!loading && script && (
          <>
            <header className="script-head">
              <input
                className="script-title script-title-input"
                value={script.title}
                onChange={(e) => onScriptTitleChange?.(e.target.value)}
                placeholder="剧本名称"
                aria-label="剧本名称"
                readOnly={!onScriptTitleChange}
              />
              {script.logline && <p className="script-logline">{script.logline}</p>}
              <div className="tag-row">
                <span className="tag tag--accent">{script.style}</span>
                <span className="tag">{script.shots.length} 个镜头</span>
                <span className="tag">总时长 {totalDuration}s</span>
                {script.shots.length > 1 && (
                  <span
                    className="tag"
                    title={
                      '承接上一镜的镜头会抽取上一镜末帧当首帧，这类镜头不能再传角色卡参考图' +
                      '（wan3.0 首帧与参考图互斥），人物一致性靠后续关键帧层保证；' +
                      '硬切的镜头走角色卡 / 场景卡参考图。'
                    }
                  >
                    {sameTakeCount} 处承接 · {script.shots.length - 1 - sameTakeCount} 处硬切
                  </span>
                )}
                {saveState !== 'idle' && (
                  <span
                    className={`tag ${saveState === 'error' ? 'tag--error' : 'tag--accent'}`}
                    title="剧本保存在本地 SQLite（.data/app.db）"
                  >
                    {SAVE_TEXT[saveState]}
                  </span>
                )}
              </div>

              {(onEditIdea || onRecreateIdea) && (
                <div className="script-idea">
                  <div className="script-idea-main">
                    <span className="characters-title">故事创意</span>
                    <p className="script-idea-text">
                      {idea || '还没有填写故事创意'}
                    </p>
                  </div>
                  {/* 已经生成过视频就改成另存新剧本，避免重新生成把成片对应的分镜覆盖掉 */}
                  {doneCount === 0 && onEditIdea ? (
                    <button
                      className="btn btn--sm btn--ghost"
                      type="button"
                      onClick={onEditIdea}
                      title="把这份剧本的故事创意回填到创意表单"
                    >
                      {idea ? '编辑' : '填写创意'}
                    </button>
                  ) : onRecreateIdea ? (
                    <button
                      className="btn btn--sm"
                      type="button"
                      onClick={onRecreateIdea}
                      title="已有镜头生成过视频，会带着当前创意另存为新剧本，不改动这份"
                    >
                      另存新剧本
                    </button>
                  ) : null}
                </div>
              )}

              {doneCount >= 2 && (
                <div className="compose-bar">
                  <button
                    className="btn btn--sm"
                    onClick={onCompose}
                    disabled={composeState === 'running' || !composeReady}
                    title={composeReady ? '按剧本顺序拼接为一个 MP4' : '未检测到 ffmpeg'}
                  >
                    {composeState === 'running' ? (
                      <>
                        <span className="spinner" />
                        合成中…
                      </>
                    ) : composed ? (
                      '重新合成'
                    ) : (
                      '合成成片'
                    )}
                  </button>
                  {/* 合成过才出现：点开弹窗看视频，不再把大播放器铺在页面里 */}
                  {composed && (
                    <button
                      className="btn btn--sm btn--primary"
                      onClick={() => setComposeOpen(true)}
                      title="弹窗查看已合成的成片"
                    >
                      ▶ 查看成片
                    </button>
                  )}
                  <span className="field-hint">
                    {composeState === 'running'
                      ? `正在下载并重新编码 ${doneCount} 个镜头，请勿关闭页面`
                      : `把 ${doneCount} 个已生成镜头按顺序拼接为一个 MP4`}
                  </span>
                </div>
              )}
              <CastCards
                characters={script.characters}
                scenes={script.scenes ?? []}
                style={script.style}
                onCharactersChange={onCharactersChange ?? (() => undefined)}
                onScenesChange={onScenesChange ?? (() => undefined)}
                onStyleChange={onStyleChange}
              />

            </header>

            {composeState === 'running' && (
              <div className="alert alert--info">
                正在下载并重新编码 {doneCount} 个镜头，通常需要 30 秒 ~ 2 分钟，请勿关闭页面。
              </div>
            )}

            {composeError && <div className="alert alert--error">{composeError}</div>}

            {!composeReady && doneCount >= 2 && (
              <div className="alert alert--warn">
                未检测到 ffmpeg，无法合成成片。macOS 可执行 <code>brew install ffmpeg</code>，或在{' '}
                <code>.env.local</code> 设置 <code>FFMPEG_PATH</code> 后重启服务。
              </div>
            )}

            <div className="shot-list">
              {script.shots.map((shot, index) => (
                <ShotCard
                  key={shot.id}
                  shot={shot}
                  job={jobs[shot.id]}
                  onChange={(patch) => onShotChange(shot.id, patch)}
                  onGenerate={() => onGenerate(shot)}
                  characters={script.characters}
                  style={script.style}
                  beforeDescription={script.shots[index - 1]?.description ?? ''}
                  afterDescription={script.shots[index + 1]?.description ?? ''}
                  isFirst={index === 0}
                  startAt={script.shots.slice(0, index).reduce((sum, prev) => sum + prev.duration, 0)}
                  carryMuted={carryMuted}
                  prevSceneName={script.shots[index - 1]?.sceneNames?.[0] ?? ''}
                  prevCast={prevFrameCast(script.shots[index - 1] ?? null)}
                  prevExitState={script.shots[index - 1]?.exitState ?? ''}
                  prevFrameRefEnabled={prevFrameRefEnabled}
                  onAbandon={onAbandonShot ? () => onAbandonShot(shot) : undefined}
                />
              ))}
            </div>

            {onAddShot && (
              <button
                className="shot-add"
                type="button"
                onClick={onAddShot}
                disabled={generatingAll}
                title="在剧本末尾手动新增一镜，画面描述和视频提示词自己写；也可以写完描述点「重新生成分镜信息」"
              >
                <b>＋ 添加镜头</b>
                <span className="shot-add-hint">手动加一镜，自己写画面描述与视频提示词</span>
              </button>
            )}
          </>
        )}
      </div>

      {composeOpen && composeResult && (
        <div
          className="modal-mask"
          role="dialog"
          aria-modal="true"
          aria-label="合成成片"
          onClick={() => setComposeOpen(false)}
        >
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <b>合成成片</b>
              <span>
                {composeResult.clips} 个镜头 · {composeResult.size} ·{' '}
                {(composeResult.bytes / 1024 / 1024).toFixed(1)} MB
              </span>
              <button
                className="modal-close"
                type="button"
                onClick={() => setComposeOpen(false)}
                aria-label="关闭"
                title="关闭（Esc）"
              >
                ×
              </button>
            </div>

            <video
              className="modal-video"
              src={composeResult.url}
              controls
              autoPlay
              playsInline
              preload="metadata"
            />

            <div className="modal-foot">
              <a
                className="btn btn--primary btn--sm"
                href={composeResult.url}
                download={composeResult.fileName}
              >
                下载 MP4
              </a>
              <button
                className="btn btn--sm"
                type="button"
                onClick={onCompose}
                disabled={composeState === 'running' || !composeReady}
                title="按剧本顺序重新拼接"
              >
                {composeState === 'running' ? '合成中…' : '重新合成'}
              </button>
              <span className="field-hint">共 {composeResult.clips} 段，点击遮罩或按 Esc 关闭</span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
