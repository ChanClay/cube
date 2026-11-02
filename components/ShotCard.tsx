'use client';

import { useEffect, useState } from 'react';
import {
  MEDIA_HINT,
  MEDIA_LABEL,
  MEDIA_TYPES,
  hasCarryFrame,
  isCarryFrameUrl,
  mediaSummary,
  validateMedia,
} from '@/lib/media';
import { api } from '@/lib/client';
import type { Character, MediaType, NarrationType, Shot, VideoJob } from '@/lib/types';

interface Props {
  shot: Shot;
  job?: VideoJob;
  onChange: (patch: Partial<Shot>) => void;
  onGenerate: () => void;
  /** 全片角色卡，重算分镜信息时保证外貌一致 */
  characters?: Character[];
  /** 整体视觉风格，重新生成分镜信息时使用 */
  style?: string;
  /** 上一镜 / 下一镜的画面描述，用于动作承接 */
  beforeDescription?: string;
  afterDescription?: string;
  /** 第一镜没有上一镜可承接，开关固定关闭 */
  isFirst?: boolean;
  /** 承接上一镜末帧的镜头不生成音频（服务端默认行为，用于提示） */
  carryMuted?: boolean;
  /** 放弃这一镜：停止跟踪进度（云端任务仍会跑完） */
  onAbandon?: () => void;
}

const STATUS_TEXT = {
  queued: '排队中',
  running: '生成中',
  succeeded: '已完成',
  failed: '生成失败',
  canceled: '已放弃',
} as const;

export default function ShotCard({
  shot,
  job,
  onChange,
  onGenerate,
  characters = [],
  style = '',
  beforeDescription = '',
  afterDescription = '',
  isFirst = false,
  carryMuted = true,
  onAbandon,
}: Props) {
  const [newType, setNewType] = useState<MediaType>('first_frame');
  const [newUrl, setNewUrl] = useState('');
  const [mediaError, setMediaError] = useState<string | null>(null);
  /** 时长输入框的草稿值，失焦或回车时提交 */
  const [durationText, setDurationText] = useState(String(shot.duration));
  /** 按当前画面描述重算分镜信息的进行中状态 */
  const [refining, setRefining] = useState(false);
  const [refineError, setRefineError] = useState<string | null>(null);

  const media = shot.media ?? [];

  /**
   * 这一镜会不会静音：首帧来自上一镜末帧时，服务端不生成音轨
   * （画面接着上一镜，声音重新生成必然断档）。首帧还没抽出来时也提前提示。
   */
  const hasManualFirstFrame = media.some(
    (item) => item.type === 'first_frame' && !isCarryFrameUrl(item.url),
  );
  const silentForCarry =
    carryMuted &&
    (hasCarryFrame(media) || (!isFirst && shot.continueFromPrev === true && !hasManualFirstFrame));

  useEffect(() => {
    setDurationText(String(shot.duration));
  }, [shot.duration]);

  /** wan3.0 支持 2~30 秒 */
  const commitDuration = () => {
    const value = Math.round(Number(durationText));
    const next = Number.isFinite(value) && value > 0
      ? Math.min(30, Math.max(2, value))
      : shot.duration;
    setDurationText(String(next));
    if (next !== shot.duration) onChange({ duration: next });
  };

  /** 画面描述改完后，只重算这一镜的提示词 / 景别 / 运镜 / 标题 / 旁白，不覆盖描述本身 */
  const refineShot = async () => {
    const description = shot.description.trim();
    if (description.length < 2) {
      setRefineError('请先填写画面描述');
      return;
    }

    setRefining(true);
    setRefineError(null);
    try {
      const { shot: next } = await api.refineShot({
        description,
        title: shot.title,
        style,
        duration: shot.duration,
        before: beforeDescription,
        after: afterDescription,
        characters: characters.map(({ name, desc }) => ({ name, desc })),
      });

      const patch: Partial<Shot> = {
        shotSize: next.shotSize,
        cameraMove: next.cameraMove,
        videoPrompt: next.videoPrompt,
        narration: next.narration,
      };
      if (next.title) patch.title = next.title;
      onChange(patch);
    } catch (err) {
      setRefineError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefining(false);
    }
  };

  const busy = job?.status === 'queued' || job?.status === 'running';
  const disabled = busy || shot.videoPrompt.trim().length < 5 || !!mediaError;

  const buttonText = busy
    ? '生成中…'
    : job?.status === 'succeeded'
      ? '重新生成'
      : job?.status === 'failed'
        ? '重试'
        : job?.status === 'canceled'
          ? '重新生成'
          : '生成视频';

  const addMedia = () => {
    const url = newUrl.trim();
    if (!url) return;
    const next = [...media, { type: newType, url }];
    const error = validateMedia(next);
    setMediaError(error);
    if (error) return;
    onChange({ media: next });
    setNewUrl('');
  };

  const removeMedia = (index: number) => {
    const next = media.filter((_, i) => i !== index);
    setMediaError(validateMedia(next));
    onChange({ media: next });
  };

  return (
    <article className="shot-card">
      <div className="shot-head">
        <span className="shot-no">{String(shot.index).padStart(2, '0')}</span>
        <input
          className="shot-title-input"
          value={shot.title}
          onChange={(e) => onChange({ title: e.target.value })}
          aria-label="镜头标题"
        />
        <div className="shot-meta">
          <span className="chip">{shot.shotSize}</span>
          <span className="chip">{shot.cameraMove}</span>
          <label className="chip chip--time" title="镜头时长，2~30 秒，可单独调整">
            <input
              className="chip-input"
              type="number"
              min={2}
              max={30}
              step={1}
              value={durationText}
              onChange={(e) => setDurationText(e.target.value)}
              onBlur={commitDuration}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
              }}
              aria-label="镜头时长（秒）"
            />
            s
          </label>
        </div>
      </div>

      <div className="shot-body">
        <div className="shot-info">
      <div className="shot-label-row">
        <label className="shot-label">画面描述</label>
        <button
          className="btn btn--sm btn--ghost shot-refine"
          onClick={refineShot}
          disabled={refining}
          type="button"
          title="按当前画面描述重新生成提示词、景别、运镜、标题、旁白（不会改动描述本身）"
        >
          {refining && <span className="spinner" />}
          {refining ? '生成中…' : '重新生成分镜信息'}
        </button>
      </div>
      <textarea
        className="shot-textarea"
        rows={2}
        value={shot.description}
        onChange={(e) => onChange({ description: e.target.value })}
      />
      {refineError && <div className="shot-refine-error">{refineError}</div>}

      <label className="shot-label">视频提示词（直接提交给视频模型）</label>
      <textarea
        className="shot-textarea shot-textarea--prompt"
        rows={3}
        value={shot.videoPrompt}
        onChange={(e) => onChange({ videoPrompt: e.target.value })}
      />

      {shot.narration && (
        <div className={`narration${shot.narrationType === 'none' ? ' narration--off' : ''}`}>
          <select
            className="select narration-type"
            value={shot.narrationType ?? 'voiceover'}
            onChange={(e) =>
              onChange({ narrationType: e.target.value as NarrationType })
            }
            aria-label="台词类型"
            title="角色台词：画面里的人物开口说话；画外旁白：人物不开口；都不要：这句不提交给模型"
          >
            <option value="voiceover">画外旁白</option>
            <option value="dialogue">角色台词</option>
            <option value="none">都不要</option>
          </select>
          <span>{shot.narration}</span>
        </div>
      )}

      <details className="media-panel" open={media.length > 0}>
        <summary>
          <span>多模态素材</span>
          <span className={`media-count ${media.length > 0 ? 'media-count--on' : ''}`}>
            {mediaSummary(media)}
          </span>
        </summary>

        {media.length > 0 && (
          <div className="media-list">
            {media.map((item, index) => (
              <div className="media-item" key={`${item.type}-${index}`}>
                <span className="media-type">{MEDIA_LABEL[item.type]}</span>
                <span className="media-url" title={item.url}>
                  {item.url}
                </span>
                <button
                  className="media-remove"
                  onClick={() => removeMedia(index)}
                  aria-label="移除素材"
                  type="button"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="media-add">
          <select
            className="select media-select"
            value={newType}
            onChange={(e) => setNewType(e.target.value as MediaType)}
            aria-label="素材类型"
          >
            {MEDIA_TYPES.map((type) => (
              <option key={type} value={type}>
                {MEDIA_LABEL[type]}
              </option>
            ))}
          </select>
          <input
            className="input media-input"
            value={newUrl}
            onChange={(e) => setNewUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') addMedia();
            }}
            placeholder="素材 URL（需公网可访问）"
          />
          <button className="btn btn--sm" onClick={addMedia} disabled={!newUrl.trim()} type="button">
            添加
          </button>
        </div>

        <p className="media-hint">{MEDIA_HINT[newType]}</p>
        {mediaError && <div className="media-error">{mediaError}</div>}
      </details>
        </div>

        {/* 右侧：这一镜的成果视频 */}
        <aside className="shot-preview">
          <div className="preview-head">
            <span className="shot-label">成果视频</span>
            <div
              className={`status-badge ${job ? `status--${job.status}` : ''}`}
              title={job?.error ?? undefined}
            >
              {job && <span className="dot" />}
              <span>
                {job
                  ? `${STATUS_TEXT[job.status]}${job.status === 'running' && job.progress ? ` ${job.progress}%` : ''}`
                  : '尚未生成'}
              </span>
            </div>
          </div>

          {job?.status === 'succeeded' && job.videoUrl ? (
            <div className="video-wrap">
              <video src={job.videoUrl} controls playsInline preload="metadata" />
              <div className="video-bar">
                <span>
                  {job.provider} · {job.resolution} · {job.duration}s
                  {job.media?.length ? ` · ${job.media.length} 个素材` : ''}
                </span>
                <a href={job.videoUrl} target="_blank" rel="noreferrer">
                  打开原视频
                </a>
              </div>
            </div>
          ) : busy ? (
            <>
              <div className="shot-preview-empty">
                <span className="spinner" />
                <span>生成中{job?.progress ? ` ${job.progress}%` : '…'}</span>
              </div>
              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${job?.progress ?? 12}%` }} />
              </div>
            </>
          ) : job?.status === 'canceled' ? (
            <div className="shot-preview-empty" title={job.error ?? undefined}>
              <span>已放弃本镜</span>
              <span className="shot-preview-hint">再点「重新生成」会重新提交一镜</span>
            </div>
          ) : job?.status === 'failed' && job.error ? (
            <div className="shot-preview-empty shot-preview-empty--error" title={job.error}>
              <span>生成失败</span>
              <span className="shot-preview-error-text">{job.error}</span>
            </div>
          ) : (
            <div className="shot-preview-empty">
              <span>尚未生成视频</span>
              <span className="shot-preview-hint">点下方「生成视频」</span>
            </div>
          )}
        </aside>
      </div>

      <div className="shot-actions">
        <label
          className={`shot-switch${isFirst ? ' is-disabled' : ''}`}
          title={
            isFirst
              ? '第一镜没有上一镜，无法承接'
              : '打开后生成前会抽取上一镜视频的末帧，作为本镜首帧，保证画面接得住'
          }
        >
          <input
            type="checkbox"
            className="shot-switch-input"
            checked={!isFirst && shot.continueFromPrev === true}
            disabled={isFirst}
            onChange={(e) => onChange({ continueFromPrev: e.target.checked })}
          />
          <span className="shot-switch-track" aria-hidden="true">
            <span className="shot-switch-thumb" />
          </span>
          <span className="shot-switch-text">承接上一镜末帧</span>
        </label>

        {silentForCarry && (
          <span
            className="shot-silent"
            title="画面接着上一镜末帧，音轨若重新生成会和上一镜的声音断档，所以这类镜头不生成音频；需要保留可设 VIDEO_AUDIO_ON_CARRY=1"
          >
            无音轨
          </span>
        )}

        {busy && onAbandon && (
          <button
            className="btn btn--sm btn--danger"
            type="button"
            onClick={onAbandon}
            title="放弃这一镜：本地标记为已放弃、停止跟踪进度。云端任务仍会跑完（费用照常），结果不再回收"
          >
            放弃本镜
          </button>
        )}

        <button className="btn btn--sm btn--primary" onClick={onGenerate} disabled={disabled}>
          {busy && <span className="spinner" />}
          {buttonText}
        </button>
      </div>
    </article>
  );
}
