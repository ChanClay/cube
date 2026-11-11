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
import {
  TRANSITION_HINT,
  TRANSITION_LABEL,
  isSameTakeShot,
} from '@/lib/shot-media';
import type {
  Character,
  MediaInput,
  MediaType,
  NarrationType,
  Shot,
  ShotTransition,
  VideoJob,
} from '@/lib/types';

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
  /** 这一镜在成片里的起始秒数（前面所有镜头时长之和），用于显示绝对时间码 */
  startAt?: number;
  /** 承接上一镜末帧的镜头不生成音频（服务端默认行为，用于提示） */
  carryMuted?: boolean;
  /** 上一镜的场景名：判断能不能把上一镜末帧当同场景的风格参考 */
  prevSceneName?: string;
  /** 上一镜末帧里实际在场的人物：重算提示词时按这份名单点名，避免凭空多出人 */
  prevCast?: string[];
  /** 上一镜的结尾状态，用于对齐动作与位置 */
  prevExitState?: string;
  /** 全局开关（VIDEO_REFERENCE_PREV_FRAME）：关掉时这个选项不可用 */
  prevFrameRefEnabled?: boolean;
  /** 放弃这一镜：停止跟踪进度（云端任务仍会跑完） */
  onAbandon?: () => void;
}

/** 与上一镜的衔接方式，顺序即下拉顺序 */
const TRANSITION_OPTIONS: ShotTransition[] = ['same-take', 'hard-cut', 'time-jump'];

/** 图片类素材画缩略图，视频用首帧，其余类型用符号占位 */
const isImageMedia = (type: MediaType): boolean =>
  type === 'first_frame' || type === 'last_frame' || type === 'reference_image';

/** 不能直接预览的素材给个符号，免得缩略图区空着 */
const MEDIA_GLYPH: Record<MediaType, string> = {
  first_frame: '▣',
  last_frame: '▣',
  reference_image: '▣',
  reference_video: '▶',
  reference_audio: '♪',
  file: '▤',
  link: '↗',
};

const STATUS_TEXT = {
  queued: '排队中',
  running: '生成中',
  succeeded: '已完成',
  failed: '生成失败',
  canceled: '已放弃',
} as const;

/** 秒 → 成片时间码（01:23） */
const timecode = (seconds: number): string => {
  const safe = Math.max(0, Math.round(seconds));
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
};

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
  startAt,
  carryMuted = true,
  prevSceneName = '',
  prevCast = [],
  prevExitState = '',
  prevFrameRefEnabled = true,
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
  /** 正在预览的素材：点缩略图打开，点遮罩 / 按 ESC 关闭 */
  const [previewing, setPreviewing] = useState<MediaInput | null>(null);
  /** 加载失败的缩略图地址：显示占位，不留破图 */
  const [brokenThumbs, setBrokenThumbs] = useState<string[]>([]);
  /** 「复制提示词」的短暂反馈 */
  const [copiedPrompt, setCopiedPrompt] = useState(false);

  useEffect(() => {
    if (!previewing) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPreviewing(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [previewing]);

  const media = shot.media ?? [];
  /** 说话人下拉：优先本镜出镜角色，其次全片角色卡 */
  const speakerOptions = [
    ...new Set([...(shot.characterNames ?? []), ...characters.map((c) => c.name)]),
  ].filter(Boolean);

  /**
   * 这一镜会不会静音：首帧来自上一镜末帧时，服务端不生成音轨
   * （画面接着上一镜，声音重新生成必然断档）。首帧还没抽出来时也提前提示。
   */
  const hasManualFirstFrame = media.some(
    (item) => item.type === 'first_frame' && !isCarryFrameUrl(item.url),
  );
  /** 衔接方式：新剧本读 transition，旧剧本回落到「承接上一镜」开关 */
  const transition: ShotTransition =
    shot.transition ?? (shot.continueFromPrev ? 'same-take' : 'hard-cut');
  /**
   * 上一镜末帧当参考图，只在「同一场戏、换了机位」时成立：
   * 承接动作的镜头已经在用首帧（互斥），跨场景参考过去会把新场景拉回旧色调。
   */
  const sameSceneAsPrev =
    !!prevSceneName && (shot.sceneNames ?? []).includes(prevSceneName);
  const canReferencePrevFrame =
    !isFirst &&
    prevFrameRefEnabled &&
    transition === 'hard-cut' &&
    sameSceneAsPrev;
  const referencePrevFrame =
    canReferencePrevFrame && (shot.referencePrevFrame ?? true);
  const silentForCarry =
    carryMuted &&
    (hasCarryFrame(media) || (!isFirst && isSameTakeShot(shot) && !hasManualFirstFrame));

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
        prevCast,
        prevExitState,
        characters: characters.map(({ name, desc }) => ({ name, desc })),
      });

      const patch: Partial<Shot> = {
        shotSize: next.shotSize,
        cameraMove: next.cameraMove,
        videoPrompt: next.videoPrompt,
        narration: next.narration,
      };
      if (next.title) patch.title = next.title;
      // 模型给了说话人就更新；没给时保留原值，避免重算把已选的人清掉
      if (next.speaker) patch.speaker = next.speaker;
      // 时间轴按新描述重算过才覆盖，没拿到就保留原来的
      if (next.beatSheet?.length) patch.beatSheet = next.beatSheet;
      onChange(patch);
    } catch (err) {
      setRefineError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefining(false);
    }
  };

  const busy = job?.status === 'queued' || job?.status === 'running';
  /** 这次任务实际提交的素材（旧任务记录可能没有这个字段） */
  const submittedMedia = job?.media ?? [];
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
          {startAt !== undefined && (
            <span className="chip chip--tc" title="这一镜在成片里的绝对时间码">
              {timecode(startAt)}–{timecode(startAt + shot.duration)}
            </span>
          )}
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

      {shot.beatSheet && shot.beatSheet.length > 0 && (
        <>
          <label className="shot-label">秒级节奏（相对本镜，覆盖 {shot.duration} 秒）</label>
          <ol className="shot-timeline">
            {shot.beatSheet.map((beat, i) => (
              <li className="shot-timeline-row" key={`${beat.from}-${beat.to}-${i}`}>
                <span className="shot-timeline-time">
                  {beat.from}–{beat.to}s
                </span>
                <span className="shot-timeline-action">{beat.action}</span>
              </li>
            ))}
          </ol>
        </>
      )}

      <label className="shot-label">视频提示词（直接提交给视频模型）</label>
      <textarea
        className="shot-textarea shot-textarea--prompt"
        rows={3}
        value={shot.videoPrompt}
        onChange={(e) => onChange({ videoPrompt: e.target.value })}
      />

      <div className={`narration${shot.narrationType === 'none' ? ' narration--off' : ''}`}>
        <div className="narration-head">
          <select
            className="select narration-type"
            value={shot.narrationType ?? 'voiceover'}
            onChange={(e) => {
              const type = e.target.value as NarrationType;
              const onScreen = shot.characterNames ?? [];
              const patch: Partial<Shot> = { narrationType: type };

              // 切成角色台词时尽量把说话人补上：本镜只有一个人就用他，
              // 全片只有一个角色就直接采用，避免出现「有人在说但不知道是谁」。
              if (type === 'dialogue' && !shot.speaker) {
                if (onScreen.length === 1) {
                  patch.speaker = onScreen[0];
                } else if (characters.length === 1) {
                  patch.speaker = characters[0].name;
                  patch.characterNames = [...onScreen, characters[0].name];
                }
              }
              if (type !== 'dialogue') patch.speaker = undefined;
              onChange(patch);
            }}
            aria-label="台词类型"
            title="角色台词：画面里的人物开口说话；画外旁白：人物不开口；都不要：这句不提交给模型"
          >
            <option value="voiceover">画外旁白</option>
            <option value="dialogue">角色台词</option>
            <option value="none">都不要</option>
          </select>

          {shot.narrationType === 'dialogue' && (
            <select
              className="select narration-speaker"
              value={shot.speaker ?? ''}
              onChange={(e) => {
                const name = e.target.value;
                const patch: Partial<Shot> = { speaker: name || undefined };
                // 说话人必须在本镜出镜，否则模型不知道该让谁开口
                if (name && !(shot.characterNames ?? []).includes(name)) {
                  patch.characterNames = [...(shot.characterNames ?? []), name];
                }
                onChange(patch);
              }}
              aria-label="说话人"
              title="这句台词由谁来说：会写进视频提示词，避免多人物镜头里挑错人"
            >
              <option value="">谁在说…</option>
              {speakerOptions.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          )}
        </div>

        <textarea
          className="shot-textarea narration-input"
          rows={2}
          value={shot.narration}
          onChange={(e) => {
            const narration = e.target.value;
            const onScreen = shot.characterNames ?? [];
            const patch: Partial<Shot> = { narration };

            /**
             * 往空镜里第一次填台词时自动选对类型：
             * 画面里有人 → 角色台词（驱动口型）；纯空镜 → 画外旁白。
             * 之后用户手动改成的类型不会被覆盖。
             */
            if (narration.trim()) {
              const wasEmpty = !shot.narration;
              if (shot.narrationType === 'none') {
                patch.narrationType = onScreen.length > 0 ? 'dialogue' : 'voiceover';
              } else if (
                wasEmpty &&
                (shot.narrationType ?? 'voiceover') === 'voiceover' &&
                onScreen.length > 0
              ) {
                patch.narrationType = 'dialogue';
              }

              if (patch.narrationType === 'dialogue' && !shot.speaker) {
                if (onScreen.length === 1) {
                  patch.speaker = onScreen[0];
                } else if (characters.length === 1) {
                  patch.speaker = characters[0].name;
                  patch.characterNames = [...onScreen, characters[0].name];
                }
              }
            }
            onChange(patch);
          }}
          placeholder="这一镜的台词或旁白，留空则无口播"
          aria-label="台词或旁白"
        />
      </div>

      <details className="media-panel" open={media.length > 0}>
        <summary>
          <span>多模态素材</span>
          <span className={`media-count ${media.length > 0 ? 'media-count--on' : ''}`}>
            {mediaSummary(media)}
          </span>
        </summary>

        {media.length > 0 && (
          <div className="media-list">
            {media.map((item, index) => {
              const broken = brokenThumbs.includes(item.url);
              return (
                <div className="media-item" key={`${item.type}-${index}`}>
                  <button
                    className={`media-thumb${broken ? ' media-thumb--broken' : ''}`}
                    type="button"
                    onClick={() => setPreviewing(item)}
                    title="点击预览"
                    aria-label={`预览${MEDIA_LABEL[item.type]}`}
                  >
                    {isImageMedia(item.type) ? (
                      broken ? (
                        <span>无图</span>
                      ) : (
                        <img
                          src={item.url}
                          alt={MEDIA_LABEL[item.type]}
                          loading="lazy"
                          onError={() =>
                            setBrokenThumbs((prev) =>
                              prev.includes(item.url) ? prev : [...prev, item.url],
                            )
                          }
                        />
                      )
                    ) : item.type === 'reference_video' ? (
                      <video src={item.url} preload="metadata" muted playsInline />
                    ) : (
                      <span>{MEDIA_GLYPH[item.type]}</span>
                    )}
                  </button>
                  <span className="media-type">
                    {MEDIA_LABEL[item.type]}
                    {item.auto ? ' · 自动' : ''}
                  </span>
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
              );
            })}
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

          {/**
           * 提交时真正发出去的东西，用来核对「衔接方式 / 末帧参考」有没有生效：
           * 提示词里应该能看到 "The reference image is the last frame…"，
           * 素材里应该能看到那张 frame-xxx.png。看不到就是分流没走到。
           */}
          {job && (
            <details className="prompt-panel">
              <summary>
                <span>实际提交的提示词</span>
                <span className="prompt-panel-hint">{submittedMedia.length} 个素材</span>
              </summary>
              <div className="prompt-panel-body">
                <pre className="prompt-text">{job.prompt}</pre>

                {submittedMedia.length > 0 && (
                  <ul className="prompt-media">
                    {submittedMedia.map((item, index) => (
                      <li key={`${item.type}-${index}`}>
                        <span className="prompt-media-type">{MEDIA_LABEL[item.type]}</span>
                        <span className="prompt-media-url" title={item.url}>
                          {item.url}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}

                <button
                  className="btn btn--sm"
                  type="button"
                  onClick={() => {
                    void navigator.clipboard.writeText(job.prompt);
                    setCopiedPrompt(true);
                    window.setTimeout(() => setCopiedPrompt(false), 1500);
                  }}
                >
                  {copiedPrompt ? '已复制' : '复制提示词'}
                </button>
              </div>
            </details>
          )}
        </aside>
      </div>

      <div className="shot-actions">
        <div
          className={`shot-transition${isFirst ? ' is-disabled' : ''}`}
          title={
            isFirst
              ? '第一镜没有上一镜，无法承接'
              : `${TRANSITION_LABEL[transition]}：${TRANSITION_HINT[transition]}${
                  shot.transitionReason ? `\n分镜判定：${shot.transitionReason}` : ''
                }`
          }
        >
          <span className="shot-transition-label">衔接</span>
          <select
            className="select shot-transition-select"
            value={transition}
            disabled={isFirst}
            aria-label="与上一镜的衔接方式"
            onChange={(e) => {
              const next = e.target.value as ShotTransition;
              onChange({
                transition: next,
                // 旧字段一并写，避免两个来源打架（历史数据仍在读 continueFromPrev）
                continueFromPrev: next === 'same-take',
                // 承接动作改用首帧，参考图开关就没意义了，顺手关掉避免脏数据
                ...(next === 'same-take' ? { referencePrevFrame: false } : {}),
              });
            }}
          >
            {TRANSITION_OPTIONS.map((value) => (
              <option key={value} value={value}>
                {TRANSITION_LABEL[value]}
              </option>
            ))}
          </select>

          {!isFirst && transition !== 'same-take' && (
            <label
              className={`shot-ref-frame${canReferencePrevFrame ? '' : ' is-disabled'}`}
              title={
                !prevFrameRefEnabled
                  ? '已由 VIDEO_REFERENCE_PREV_FRAME=0 全局关闭'
                  : !sameSceneAsPrev
                    ? '换场景的镜头不带上上一镜画面：旧场景的光线会把新场景带歪'
                    : '把上一镜末帧作为参考图：只借光线 / 色调 / 场景材质，构图与景别仍按本镜描述走'
              }
            >
              <input
                type="checkbox"
                checked={referencePrevFrame}
                disabled={!canReferencePrevFrame}
                onChange={(e) => onChange({ referencePrevFrame: e.target.checked })}
              />
              <span>末帧参考</span>
            </label>
          )}
        </div>

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

      {previewing && (
        <div
          className="image-viewer"
          role="dialog"
          aria-modal="true"
          aria-label={`预览${MEDIA_LABEL[previewing.type]}`}
          onClick={() => setPreviewing(null)}
        >
          <button
            className="image-viewer-close"
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setPreviewing(null);
            }}
            aria-label="关闭预览"
            autoFocus
          >
            ×
          </button>

          {isImageMedia(previewing.type) ? (
            <img
              src={previewing.url}
              alt={MEDIA_LABEL[previewing.type]}
              onClick={(e) => e.stopPropagation()}
            />
          ) : previewing.type === 'reference_video' ? (
            <video
              className="media-viewer-video"
              src={previewing.url}
              controls
              autoPlay
              playsInline
              onClick={(e) => e.stopPropagation()}
            />
          ) : previewing.type === 'reference_audio' ? (
            <audio
              className="media-viewer-audio"
              src={previewing.url}
              controls
              autoPlay
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <a
              className="media-viewer-link"
              href={previewing.url}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
            >
              {previewing.url}
            </a>
          )}

          <div className="media-viewer-caption" onClick={(e) => e.stopPropagation()}>
            {MEDIA_LABEL[previewing.type]}
            {previewing.auto ? ' · 自动关联' : ''} · {previewing.url}
          </div>
        </div>
      )}
    </article>
  );
}
