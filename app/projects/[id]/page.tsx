'use client';

import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { blankShot } from '@/lib/skills/blank-script';
import { buildVideoPrompt } from '@/lib/skills/dialogue';
import ScriptView from '@/components/ScriptView';
import TopBar from '@/components/TopBar';
import { api, type HealthInfo } from '@/lib/client';
import { validateMedia } from '@/lib/skills/media';
import { clearQueueMark, markQueueRunning, readQueueMark } from '@/lib/services/queue-store';
import {
  collectCardMedia,
  hasManualFirstFrame,
  prevFrameUsage,
  resolveShotMedia,
} from '@/lib/skills/shot-media';
import {
  DEFAULT_VIDEO_RATIO,
  DEFAULT_VIDEO_RESOLUTION,
  RATIO_LABEL,
  RESOLUTION_LABEL,
  VIDEO_RATIOS,
  VIDEO_RESOLUTIONS,
  type VideoRatio,
  type VideoResolution,
} from '@/lib/video-options';
import type {
  Character,
  ComposeResult,
  MediaInput,
  Project,
  Scene,
  Script,
  Shot,
  StoredScript,
  StoredScriptSummary,
  VideoJob,
} from '@/lib/types';

const POLL_FALLBACK_MS = 5000;
const SAVE_DEBOUNCE_MS = 1200;
/** 串行队列里单次等待的上限（视频一般 2~4 分钟，留足余量） */
const QUEUE_JOB_TIMEOUT_MS = 6 * 60 * 1000;
/** 单镜最大尝试次数（首次 + 重试） */
const QUEUE_MAX_ATTEMPTS = 3;
/** 重试间隔：第 n 次失败后等待 n 倍 */
const QUEUE_RETRY_DELAY_MS = 5000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 是否是一个「真的在服务端跑」的任务。
 * 本地乐观任务（local- 前缀 / 没有 providerJobId）永远等不到终态，
 * 用它去 waitForJob 只会白等到超时，进而卡死整个队列。
 */
const isServerJob = (job: VideoJob | undefined): job is VideoJob =>
  !!job && !!job.providerJobId && (job.status === 'queued' || job.status === 'running');

function ProjectPageInner() {
  const params = useParams<{ id: string }>();
  const projectId = params?.id ?? '';
  const router = useRouter();
  const searchParams = useSearchParams();
  /** 从创意页回来时带上 ?script=<id>，直接选中刚写入的那份剧本 */
  const requestedScriptId = searchParams.get('script');
  const requestedScriptRef = useRef<string | null>(requestedScriptId);

  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [scripts, setScripts] = useState<StoredScriptSummary[]>([]);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'missing'>('loading');

  const [script, setScript] = useState<Script | null>(null);
  const [scriptId, setScriptId] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [jobs, setJobs] = useState<Record<string, VideoJob>>({});
  /** 历史任务已经拉回来：刷新后要靠它判断哪些镜头生成过，再决定续不续队列 */
  const [jobsLoaded, setJobsLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generatingAll, setGeneratingAll] = useState(false);
  /** 已点过「停止」，排队退出中 */
  const [stopping, setStopping] = useState(false);
  /** 串行队列进度提示，例如「第 3/8 镜 · 雨中灯塔」 */
  const [queueInfo, setQueueInfo] = useState<string | null>(null);
  const [pollMs, setPollMs] = useState(POLL_FALLBACK_MS);
  const [toast, setToast] = useState<{ text: string; type: 'info' | 'error' } | null>(null);
  /** 当前剧本对应的故事创意，展示在剧本信息里，编辑时回填到创意页表单 */
  const [idea, setIdea] = useState('');
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [composeState, setComposeState] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [composeResult, setComposeResult] = useState<ComposeResult | null>(null);
  const [composeError, setComposeError] = useState<string | null>(null);
  const [projectName, setProjectName] = useState('');

  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scriptIdRef = useRef<string | null>(null);
  const ideaRef = useRef('');
  /** 串行队列里要读最新任务状态，闭包里的 jobs 会过期 */
  const jobsRef = useRef<Record<string, VideoJob>>({});
  /** 队列跨越多镜，角色卡 / 镜头可能中途被编辑，取最新的 */
  const scriptRef = useRef<Script | null>(null);
  /** 串行队列的停止信号：点「停止」置 true，队列在每个检查点自己退出 */
  const stopRequestedRef = useRef(false);

  useEffect(() => {
    jobsRef.current = jobs;
  }, [jobs]);

  useEffect(() => {
    scriptRef.current = script;
  }, [script]);

  const showToast = useCallback((text: string, type: 'info' | 'error' = 'info') => {
    setToast({ text, type });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3400);
  }, []);

  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );

  const resetCompose = useCallback(() => {
    setComposeState('idle');
    setComposeResult(null);
    setComposeError(null);
  }, []);

  /* 视频任务按镜头聚合，每个镜头只保留最新一条 */
  const refreshJobs = useCallback(async () => {
    try {
      const { jobs: list } = await api.listJobs();
      const latest: Record<string, VideoJob> = {};
      for (const job of list) {
        const prev = latest[job.shotId];
        if (!prev || job.createdAt > prev.createdAt) latest[job.shotId] = job;
      }
      setJobs(latest);
      // 历史任务到手才算「可以判断哪些镜头已经生成过」，续跑队列要等这一步
      setJobsLoaded(true);
    } catch {
      // 拉取失败时保留现有状态
    }
  }, []);

  /* 剧本写入本地库：带 id 时更新，否则新建；同时刷新剧本条目 */
  const persistScript = useCallback(
    async (target: Script, ideaText: string) => {
      setSaveState('saving');
      try {
        const { script: saved } = await api.saveScript({
          id: scriptIdRef.current ?? undefined,
          projectId,
          idea: ideaText,
          script: target,
        });
        if (scriptIdRef.current !== saved.id) {
          scriptIdRef.current = saved.id;
          setScriptId(saved.id);
        }
        setScripts((prev) => {
          const entry: StoredScriptSummary = {
            id: saved.id,
            idea: saved.idea,
            title: saved.title,
            style: saved.style,
            shotCount: saved.script.shots?.length ?? 0,
            createdAt: saved.createdAt,
            updatedAt: saved.updatedAt,
          };
          return [entry, ...prev.filter((item) => item.id !== saved.id)];
        });
        setSaveState('saved');
      } catch (err) {
        setSaveState('error');
        showToast(`剧本保存失败：${err instanceof Error ? err.message : String(err)}`, 'error');
      }
    },
    [projectId, showToast],
  );

  /** 把库里的一份剧本铺到工作台（id、创意、内容一起换） */
  const applyStored = useCallback((stored: StoredScript) => {
    scriptIdRef.current = stored.id;
    setScriptId(stored.id);
    ideaRef.current = stored.idea;
    setIdea(stored.idea);
    setScript(stored.script);
    setSaveState('saved');
  }, []);

  /* 初始化：环境状态、项目详情、指定 / 最近的剧本、历史任务 */
  useEffect(() => {
    let cancelled = false;

    api
      .health()
      .then((info) => {
        if (cancelled) return;
        setHealth(info);
        if (info.pollIntervalMs > 0) setPollMs(info.pollIntervalMs);
      })
      .catch(() => setHealth(null));

    void refreshJobs();

    if (!projectId) return;

    (async () => {
      try {
        const { project: detail, scripts: list } = await api.getProject(projectId);
        if (cancelled) return;
        setProject(detail);
        setProjectName(detail.name);
        setScripts(list);
        setLoadState('ready');

        // 从创意页回来时优先打开它写入的那份剧本
        const requested = requestedScriptRef.current
          ? list.find((item) => item.id === requestedScriptRef.current)
          : undefined;

        if (requested) {
          const { script: stored } = await api.getScript(requested.id);
          if (cancelled) return;
          applyStored(stored);
          return;
        }

        const { script: latest } = await api.latestScript(projectId);
        if (cancelled || !latest) return;
        applyStored(latest);
      } catch {
        if (!cancelled) setLoadState('missing');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [projectId, refreshJobs, applyStored]);

  /* 编辑后自动存库（防抖） */
  useEffect(() => {
    if (!script || !scriptId) return;
    const timer = setTimeout(() => {
      void persistScript(script, ideaRef.current);
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [script, scriptId, persistScript]);

  const pendingIds = useMemo(
    () =>
      Object.values(jobs)
        .filter((job) => !!job.providerJobId && (job.status === 'queued' || job.status === 'running'))
        .map((job) => job.id),
    [jobs],
  );

  /* 轮询进行中的视频任务 */
  useEffect(() => {
    if (pendingIds.length === 0) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    /**
     * 自驱轮询：每次拿到结果都排下一轮，不靠「状态有没有变化」续命。
     *
     * 早先是一发 setTimeout，指望 setJobs 换新对象触发 effect 重跑；但 wan 的 progress
     * 恒为 null，任务 running 期间前后字段完全一致，setJobs 会返回原引用 → effect 不重跑
     * → 单镜生成只轮询一次就断了（整片队列有自己的 waitForJob 循环，所以那边没事）。
     */
    const tick = async () => {
      const results = await Promise.all(
        pendingIds.map((id) =>
          api
            .getJob(id)
            .then((res) => res.job)
            .catch(() => null),
        ),
      );
      if (cancelled) return;

      setJobs((prev) => {
        const next = { ...prev };
        let changed = false;
        for (const job of results) {
          if (!job) continue;
          const old = next[job.shotId];
          if (
            old &&
            old.status === job.status &&
            old.progress === job.progress &&
            old.videoUrl === job.videoUrl &&
            old.error === job.error
          ) {
            continue;
          }
          next[job.shotId] = job;
          changed = true;
        }
        return changed ? next : prev;
      });

      // 状态真的变了会让 effect 重启（pendingIds 换新引用），旧 timer 在 cleanup 里被清掉
      timer = setTimeout(tick, pollMs);
    };

    timer = setTimeout(tick, pollMs);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [pendingIds, pollMs]);

  /** 新建剧本：先去创意页写创意，生成后才落一份新剧本 */
  const handleNewScript = useCallback(() => {
    router.push(`/projects/${projectId}/idea`);
  }, [projectId, router]);

  /** 编辑当前剧本的故事创意：把创意回填到创意页表单 */
  const handleEditIdea = useCallback(() => {
    const id = scriptIdRef.current;
    router.push(
      id ? `/projects/${projectId}/idea?script=${encodeURIComponent(id)}` : `/projects/${projectId}/idea`,
    );
  }, [projectId, router]);

  /** 已经生成过视频：不覆盖这份剧本，带着当前创意新建一份 */
  const handleRecreateIdea = useCallback(() => {
    const id = scriptIdRef.current;
    router.push(
      id ? `/projects/${projectId}/idea?copy=${encodeURIComponent(id)}` : `/projects/${projectId}/idea`,
    );
  }, [projectId, router]);

  /** 删除当前剧本；删完自动滚到剩下的最新一份，只有全删光了才回到空白页 */
  const handleDeleteScript = useCallback(async () => {
    const id = scriptIdRef.current;
    if (!id) return;

    // 每个项目至少留一份剧本，避免删空后又要手动重建
    if (scripts.length <= 1) {
      showToast('至少要保留一份剧本，不能删掉最后一份', 'error');
      return;
    }

    if (!window.confirm('删除这份剧本？删除后无法恢复，已生成的视频任务记录会保留。')) return;

    try {
      await api.deleteScript(id);
      // 剧本没了就别再留着队列标记，免得下次打开页面白跑一遍
      clearQueueMark(id);

      const remaining = scripts.filter((item) => item.id !== id);
      setScripts(remaining);
      setJobs({});
      setError(null);
      resetCompose();

      if (remaining.length === 0) {
        scriptIdRef.current = null;
        setScriptId(null);
        ideaRef.current = '';
        setIdea('');
        setScript(null);
        showToast('剧本已删除，这个项目下已经没有剧本了');
        return;
      }

      const target = remaining[0];
      const { script: stored } = await api.getScript(target.id);
      applyStored(stored);
      await refreshJobs();
      showToast(`已删除，切换到「${stored.title || '未命名剧本'}」`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showToast(`删除失败：${message}`, 'error');
    }
  }, [applyStored, scripts, refreshJobs, resetCompose, showToast]);

  /** 剧本改名，走既有的防抖自动保存 */
  const handleScriptTitleChange = useCallback((title: string) => {
    setScript((prev) => (prev ? { ...prev, title } : prev));
  }, []);

  /** 整体画风：角色卡 / 场景卡配图与分镜提示词都用它，改完重新生成配图即可对齐 */
  const handleStyleChange = useCallback((style: string) => {
    setScript((prev) => (prev ? { ...prev, style } : prev));
  }, []);

  /**
   * 手动在剧本末尾加一镜：只插入空白骨架，
   * 内容由用户自己写（改完走既有的防抖自动保存落库）。
   */
  const handleAddShot = useCallback(() => {
    setScript((prev) => {
      if (!prev) return prev;
      const nextIndex = prev.shots.reduce((max, shot) => Math.max(max, shot.index), 0) + 1;
      return { ...prev, shots: [...prev.shots, blankShot(nextIndex)] };
    });
  }, []);

  const handleShotChange = useCallback((shotId: string, patch: Partial<Shot>) => {
    setScript((prev) =>
      prev
        ? {
            ...prev,
            shots: prev.shots.map((shot) =>
              shot.id === shotId ? { ...shot, ...patch } : shot,
            ),
          }
        : prev,
    );
  }, []);

  /**
   * 角色卡编辑：改名时同步更新各镜头的 characterNames，
   * 否则角色与素材的绑定会断掉。
   *
   * 入参是「基于上一份数据的更新函数」而不是新数组：多张卡同时生成配图时，
   * 各自的请求返回顺序不确定，用旧快照整体覆盖会把先到的结果抹掉。
   */
  const handleCharactersChange = useCallback(
    (updater: (prev: Character[]) => Character[]) => {
      setScript((prev) => {
        if (!prev) return prev;

        const next = updater(prev.characters);

        // 角色卡只会改名、不会增删，数组顺序稳定，按位置对比足够
        const renames = new Map<string, string>();
        prev.characters.forEach((character, index) => {
          const updated = next[index];
          if (updated && updated.name && updated.name !== character.name) {
            renames.set(character.name, updated.name);
          }
        });

        const shots =
          renames.size === 0
            ? prev.shots
            : prev.shots.map((shot) => {
                if (!shot.characterNames?.length) return shot;
                return {
                  ...shot,
                  characterNames: [
                    ...new Set(shot.characterNames.map((name) => renames.get(name) ?? name)),
                  ],
                };
              });

        return { ...prev, characters: next, shots };
      });
    },
    [],
  );

  /** 场景卡：只影响剧本数据，不参与视频生成 */
  const handleScenesChange = useCallback(
    (updater: (prev: Scene[]) => Scene[]) => {
      setScript((prev) => (prev ? { ...prev, scenes: updater(prev.scenes ?? []) } : prev));
    },
    [],
  );

  const generateShot = useCallback(
    async (
      shot: Shot,
      mediaOverride?: MediaInput[],
      /** 带末帧参考图时，参考图里实际在场的人物名（提示词里要点名） */
      refCast: string[] = [],
    ): Promise<{ job: VideoJob | null; retryable: boolean }> => {
      // 队列运行中镜头可能被编辑，按 id 取最新的一份
      const live = scriptRef.current?.shots.find((item) => item.id === shot.id) ?? shot;

      const basePrompt = live.videoPrompt.trim();
      if (basePrompt.length < 5) {
        showToast('这个镜头的视频提示词太短了', 'error');
        // 输入本身有问题，重试也没有意义
        return { job: null, retryable: false };
      }

      const media = mediaOverride ?? live.media ?? [];

      /**
       * 台词拼在画面描述后面：wan3.0 原生生成人声，但台词必须写进 prompt 才会说出来。
       * 带上一镜末帧当参考图时再追一句限定：点名图里的人物 + 只借光线 / 色调，不改构图。
       */
      const prompt = buildVideoPrompt(basePrompt, live, media, refCast);

      const mediaError = validateMedia(media);
      if (mediaError) {
        showToast(mediaError, 'error');
        return { job: null, retryable: false };
      }

      const now = Date.now();
      const optimistic: VideoJob = {
        id: `local-${shot.id}-${now}`,
        shotId: shot.id,
        provider: health?.video.provider ?? 'unknown',
        providerJobId: null,
        status: 'queued',
        progress: null,
        videoUrl: null,
        error: null,
        prompt,
        duration: shot.duration,
        resolution: project?.resolution ?? DEFAULT_VIDEO_RESOLUTION,
        media,
        createdAt: now,
        updatedAt: now,
      };
      setJobs((prev) => ({ ...prev, [shot.id]: optimistic }));

      try {
        const { job } = await api.createJob({
          shotId: shot.id,
          prompt,
          duration: shot.duration,
          // 画幅 / 画质按项目设置提交，服务端再校验一次
          ratio: project?.ratio,
          resolution: project?.resolution,
          media,
        });
        setJobs((prev) => ({ ...prev, [shot.id]: job }));
        if (job.status === 'failed') {
          showToast(job.error ?? '视频任务创建失败', 'error');
        }
        return { job, retryable: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setJobs((prev) => ({
          ...prev,
          [shot.id]: { ...optimistic, status: 'failed', error: message },
        }));
        showToast(message, 'error');
        // 网络 / 服务端临时错误，值得重试
        return { job: null, retryable: true };
      }
    },
    [health, project, projectId, showToast],
  );

  /** 轮询单个任务直到终态（或超时 / 连续查不到） */
  const waitForJob = useCallback(
    async (job: VideoJob): Promise<VideoJob> => {
      let current = job;
      const deadline = Date.now() + QUEUE_JOB_TIMEOUT_MS;
      /** 连续查询失败次数：任务在服务端不存在时没必要等满超时 */
      let failures = 0;

      while (
        (current.status === 'queued' || current.status === 'running') &&
        Date.now() < deadline
      ) {
        // 用户点了停止：不再等这一镜，任务本身留在云端继续跑
        if (stopRequestedRef.current) break;
        await sleep(pollMs);
        if (stopRequestedRef.current) break;
        try {
          current = (await api.getJob(current.id)).job;
          failures = 0;
          setJobs((prev) => ({ ...prev, [current.shotId]: current }));
        } catch {
          failures += 1;
          if (failures >= 3) break;
        }
      }
      return current;
    },
    [pollMs],
  );

  /** 「衔接帧云端不可达」只提示一次，避免每个镜头都弹 */
  const warnedUnreachableRef = useRef(false);

  /**
   * 抽某个视频的末帧，交给下一镜用（具体用法见 prevFrameUsage）：
   * 承接动作时当首帧，同场硬切时当风格参考图。拿不到时返回 null，交给配图兜底。
   */
  const extractCarryFrame = useCallback(
    async (videoUrl: string): Promise<MediaInput | null> => {
      try {
        const { frame } = await api.extractFrame({ videoUrl });

        // 云端模型下载不到本地地址，硬传会让下一镜直接失败，所以只提示、不注入
        if (!frame.publiclyReachable) {
          if (!warnedUnreachableRef.current) {
            warnedUnreachableRef.current = true;
            showToast(
              '衔接帧是本地地址（未配置 PUBLIC_BASE_URL），云端模型下载不到，已改用场景卡/角色卡配图',
            );
          }
          return null;
        }

        return { type: 'first_frame', url: frame.absoluteUrl };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        showToast(`上一镜末帧抽取失败，改用配图兜底：${message}`, 'error');
        return null;
      }
    },
    [showToast],
  );

  /**
   * 单镜生成：按这一镜的 transition 决定上一镜末帧当首帧还是当参考图；
   * 没有可用末帧时挂上本镜的角色卡 / 场景卡参考图。
   * 与串行队列走同一套镜头素材决策（lib/skills/shot-media）。
   */
  const handleGenerateOne = useCallback(
    async (shot: Shot) => {
      const current = scriptRef.current;
      const list = current?.shots ?? [];
      const index = list.findIndex((item) => item.id === shot.id);
      const prev = index > 0 ? list[index - 1] : null;
      const prevJob = prev ? jobsRef.current[prev.id] : undefined;
      const live = list.find((item) => item.id === shot.id) ?? shot;

      /** 用户已经手选首帧时承接开关没有意义，省掉一次下载 + 抽帧 */
      const manualFrame = hasManualFirstFrame(live.media ?? [], current);

      /**
       * 上一镜末帧什么时候要抽：
       * - same-take：当首帧，必须抽（用户手选首帧时让位）；
       * - 同场硬切：当参考图，只有开关打开时才抽（见 VIDEO_REFERENCE_PREV_FRAME）。
       * 上一镜还必须已经生成成功（跑着的等不了）。
       */
      const usage = prevFrameUsage(live, prev);
      const canUsePrevFrame =
        !!usage &&
        (usage !== 'first_frame' || !manualFrame) &&
        (usage !== 'reference_image' || health?.video.referencePrevFrame !== false) &&
        prevJob?.status === 'succeeded' &&
        !!prevJob.videoUrl;

      let prevFrame: MediaInput | null = null;
      if (canUsePrevFrame && prevJob?.videoUrl) {
        // 要下载整段视频再跑 ffmpeg，给个提示免得以为卡住
        showToast(
          usage === 'first_frame'
            ? '正在抽取上一镜末帧作为首帧…'
            : '正在抽取上一镜末帧作为风格参考…',
        );
        prevFrame = await extractCarryFrame(prevJob.videoUrl);
      }

      const resolved = resolveShotMedia(
        live.media ?? [],
        prevFrame,
        collectCardMedia(live, current),
        current,
        live,
        prev,
      );

      if (usage === 'first_frame' && resolved.source === 'cards' && !prevFrame) {
        showToast('这一镜没有可用的上一镜末帧，已改用角色 / 场景卡作为参考图');
      }
      if (resolved.changed) handleShotChange(shot.id, { media: resolved.next });

      await generateShot(live, resolved.next, resolved.prevFrameCast);
    },
    [extractCarryFrame, generateShot, handleShotChange, health, showToast],
  );

  /**
   * 串行队列（并发 = 1）：一次只生成一镜。
   * 上一镜末帧怎么用由下一镜自己的 transition 决定（same-take 当首帧、同场硬切当参考图）。
   */
  const handleGenerateAll = useCallback(async () => {
    if (!script || generatingAll) return;

    const shots = script.shots;
    // 用当前渲染出的任务状态作为队列起点，避免读到迟滞的 ref
    jobsRef.current = jobs;
    stopRequestedRef.current = false;
    setStopping(false);
    setGeneratingAll(true);

    /**
     * 队列只活在浏览器里：留个标记，刷新页面后能接着把剩下的镜头跑完
     * （已成功的镜头会跳过，云端正在跑的那一镜会等它出结果）。
     */
    const queueScriptId = scriptIdRef.current;
    if (queueScriptId) markQueueRunning(queueScriptId);
    /** 上一镜成片地址：只在下一镜打开了「承接上一镜」时才抽帧 */
    let prevVideoUrl: string | null = null;
    let completed = 0;
    /** 手动添加但还没写提示词的镜头：跳过，别让整条队列卡在它上面 */
    let skipped = 0;
    /** 用户主动点了停止 */
    let stoppedByUser = false;

    console.info('[queue] 开始串行生成', {
      shots: shots.length,
      knownJobs: Object.keys(jobsRef.current).length,
    });

    /** 是否因为某一镜重试用尽而停下 */
    let stopped = false;

    try {
      for (let i = 0; i < shots.length; i += 1) {
        if (stopRequestedRef.current) {
          stoppedByUser = true;
          break;
        }

        const shot = shots[i];
        const label = shot.title || `第 ${i + 1} 镜`;

        if (shot.videoPrompt.trim().length < 5) {
          skipped += 1;
          console.info('[queue] 跳过未填写提示词的镜头', label);
          continue;
        }

        let done = false;
        /** 输入本身有问题（提示词/素材不合法），重试没有意义 */
        let fatal = false;
        /** 用户在这一镜上点了「放弃本镜」 */
        let abandoned = false;
        let reason = '';

        // 同一镜最多尝试 QUEUE_MAX_ATTEMPTS 次，失败就重试这一镜
        for (let attempt = 1; attempt <= QUEUE_MAX_ATTEMPTS; attempt += 1) {
          if (stopRequestedRef.current) {
            stoppedByUser = true;
            break;
          }

          setQueueInfo(
            attempt === 1
              ? `第 ${i + 1}/${shots.length} 镜 · ${label}`
              : `第 ${i + 1}/${shots.length} 镜 · ${label}（重试 ${attempt - 1}/${QUEUE_MAX_ATTEMPTS - 1}）`,
          );

          try {
            const existing = jobsRef.current[shot.id];

            // 已经有成片：记下地址，下一镜需要承接时再抽帧，不重复生成
            if (existing?.status === 'succeeded' && existing.videoUrl) {
              prevVideoUrl = existing.videoUrl;
              done = true;
              break;
            }

            // 服务端确实在跑：等它跑完（不重复提交任务）
            if (isServerJob(existing)) {
              setQueueInfo(`第 ${i + 1}/${shots.length} 镜 · ${label}（等待已有任务）`);
              const finished = await waitForJob(existing);
              if (stopRequestedRef.current) {
                stoppedByUser = true;
                break;
              }
              if (finished.status === 'canceled') {
                abandoned = true;
                reason = '用户放弃本镜';
                break;
              }
              if (finished.status === 'succeeded' && finished.videoUrl) {
                completed += 1;
                prevVideoUrl = finished.videoUrl;
                done = true;
                break;
              }
              reason =
                finished.error ??
                (finished.status === 'succeeded' ? '任务没有返回视频地址' : '等待生成超时');
              console.warn('[queue] 已有任务未完成', label, finished.status, reason);
            } else {
              // 上一镜末帧优先，没有则用角色卡 / 场景卡参考图；用户手选的首尾帧仍优先
              const currentScript = scriptRef.current;
              const live = currentScript?.shots.find((item) => item.id === shot.id) ?? shot;

              /**
               * 上一镜末帧的两种用法：same-take 当首帧；同场硬切当风格参考图
               * （后者受 VIDEO_REFERENCE_PREV_FRAME 控制，关掉就完全不带）。
               */
              const manualFrame = hasManualFirstFrame(live.media ?? [], currentScript);
              const prevShot = i > 0 ? shots[i - 1] : null;
              const usage = prevFrameUsage(live, prevShot);
              const canUsePrevFrame =
                !!usage &&
                (usage !== 'first_frame' || !manualFrame) &&
                (usage !== 'reference_image' || health?.video.referencePrevFrame !== false) &&
                !!prevVideoUrl;

              let prevFrame: MediaInput | null = null;
              if (canUsePrevFrame && prevVideoUrl) {
                setQueueInfo(`第 ${i + 1}/${shots.length} 镜 · ${label}（抽取上一镜末帧）`);
                prevFrame = await extractCarryFrame(prevVideoUrl);
              }

              // 抽帧期间点了停止：别再提交新的生成任务
              if (stopRequestedRef.current) {
                stoppedByUser = true;
                break;
              }

              const resolved = resolveShotMedia(
                live.media ?? [],
                prevFrame,
                collectCardMedia(live, currentScript),
                currentScript,
                live,
                prevShot,
              );
              if (resolved.source === 'carry' && resolved.skippedCards > 0) {
                setQueueInfo(
                  `第 ${i + 1}/${shots.length} 镜 · ${label}（承接上一镜末帧，跳过 ${resolved.skippedCards} 张卡片参考图）`,
                );
              } else if (resolved.withPrevFrameRef) {
                setQueueInfo(
                  `第 ${i + 1}/${shots.length} 镜 · ${label}（带上一镜末帧作风格参考）`,
                );
              } else if (usage === 'first_frame' && resolved.source === 'cards' && !prevFrame) {
                setQueueInfo(
                  `第 ${i + 1}/${shots.length} 镜 · ${label}（无可用末帧，改用卡片参考图）`,
                );
              }
              if (resolved.changed) handleShotChange(shot.id, { media: resolved.next });

              const created = await generateShot(live, resolved.next, resolved.prevFrameCast);
              if (!created.job) {
                // 具体原因 generateShot 里已经 toast 过；只有请求类错误才值得重试
                reason = created.retryable ? '创建任务请求失败' : '任务被本地校验拦下';
                fatal = !created.retryable;
                break;
              }

              setQueueInfo(`第 ${i + 1}/${shots.length} 镜 · ${label}（生成中）`);
              const finished = await waitForJob(created.job);
              if (stopRequestedRef.current) {
                stoppedByUser = true;
                break;
              }
              if (finished.status === 'canceled') {
                abandoned = true;
                reason = '用户放弃本镜';
                break;
              }
              if (finished.status === 'succeeded' && finished.videoUrl) {
                completed += 1;
                prevVideoUrl = finished.videoUrl;
                done = true;
                break;
              }
              reason =
                finished.error ??
                (finished.status === 'succeeded' ? '任务没有返回视频地址' : '等待生成超时');
              console.warn('[queue] 镜头未完成', label, finished.status, reason);
            }
          } catch (err) {
            reason = err instanceof Error ? err.message : String(err);
            console.warn('[queue] 单镜处理异常', label, err);
          }

          if (!fatal && !abandoned && !stopRequestedRef.current && attempt < QUEUE_MAX_ATTEMPTS) {
            const delay = QUEUE_RETRY_DELAY_MS * attempt;
            setQueueInfo(
              `第 ${i + 1}/${shots.length} 镜 · ${label}（${Math.round(delay / 1000)}s 后重试）`,
            );
            await sleep(delay);
          }
        }

        if (stoppedByUser) break;

        // 用户主动放弃这一镜：不重试，整条队列一起停
        if (abandoned) {
          showToast(`「${label}」已放弃，队列已停止`);
          console.warn('[queue] 用户放弃本镜', { index: i + 1, label });
          stopped = true;
          break;
        }

        if (!done) {
          // 串行链路依赖上一镜，这一镜没成就停下，不要带着断点继续往后接
          const suffix = fatal ? '' : `（已重试 ${QUEUE_MAX_ATTEMPTS - 1} 次）`;
          showToast(`第 ${i + 1} 镜「${label}」未完成${suffix}，队列已停止：${reason}`, 'error');
          console.warn('[queue] 停止', { index: i + 1, label, reason, fatal });
          stopped = true;
          break;
        }
      }

      console.info('[queue] 结束', { completed, stopped, stoppedByUser, skipped });

      if (stoppedByUser) {
        showToast(`已停止生成，本次完成 ${completed} 个镜头；已提交的任务仍会在云端继续生成`);
      } else if (!stopped) {
        const skippedHint = skipped > 0 ? `，跳过 ${skipped} 个还没写提示词的镜头` : '';
        if (completed > 0) {
          showToast(`串行生成完成：${completed} 个镜头，已用末帧衔接下一镜${skippedHint}`);
        } else if (skipped > 0) {
          showToast(`没有可生成的镜头${skippedHint}`);
        } else {
          showToast('所有镜头都已有成片，无需重复生成');
        }
      }
    } finally {
      // 队列已经结束（跑完 / 停下 / 用户点了停止）：撤掉标记，刷新后不再自动续跑
      if (queueScriptId) clearQueueMark(queueScriptId);
      setQueueInfo(null);
      setGeneratingAll(false);
      setStopping(false);
    }
  }, [
    script,
    jobs,
    generatingAll,
    generateShot,
    waitForJob,
    extractCarryFrame,
    handleShotChange,
    health,
    showToast,
  ]);

  /** 刷新后续跑只做一次：任务状态每几秒就更新，不能每次都重开队列 */
  const autoResumeRef = useRef(false);

  /**
   * 刷新页面后接上「全部生成」队列。
   * 队列跑在浏览器里，刷新等于掐断：已提交到云端的那一镜会自己跑完，
   * 后面的镜头却不会再提交。剧本和任务列表都到位后，如果库里还留着队列标记，
   * 就把队列重新跑一遍——已成功的镜头跳过，云端在跑的那一镜等它出结果。
   */
  useEffect(() => {
    if (autoResumeRef.current) return;
    if (!jobsLoaded || !script || !scriptId) return;

    autoResumeRef.current = true;

    const startedAt = readQueueMark(scriptId);
    if (startedAt === null) return;

    // 队列其实已经跑完了（最后一下正好是刷新）：撤掉标记，不必再排队一次
    const unfinished = script.shots.some(
      (shot) => jobs[shot.id]?.status !== 'succeeded' || !jobs[shot.id]?.videoUrl,
    );
    if (!unfinished) {
      clearQueueMark(scriptId);
      return;
    }

    console.info('[queue] 接上刷新前的队列', { scriptId, startedAt });
    showToast('已接上刷新前的「全部生成」队列，继续生成剩下的镜头');
    void handleGenerateAll();
  }, [jobsLoaded, script, scriptId, jobs, handleGenerateAll, showToast]);

  /**
   * 放弃本镜：把任务标成 canceled 并停止跟踪进度。
   * 视频模型没有取消接口，云端那条任务仍会跑完（费用照常），只是结果不再回收。
   */
  const handleAbandonShot = useCallback(
    async (shot: Shot) => {
      const job = jobsRef.current[shot.id];
      if (!job || (job.status !== 'queued' && job.status !== 'running')) return;

      // 本地乐观任务还没拿到 providerJobId，服务端没有可放弃的记录
      if (!job.providerJobId) {
        showToast('任务还在提交中，稍等一下再放弃', 'error');
        return;
      }

      if (!window.confirm('放弃这一镜的生成？云端任务仍会跑完（费用照常），结果不再回收。')) return;

      try {
        const { job: updated } = await api.abandonJob(job.id);
        if (updated) setJobs((prev) => ({ ...prev, [shot.id]: updated }));
        showToast('已放弃这一镜，可以重新生成');
      } catch (err) {
        showToast(`放弃失败：${err instanceof Error ? err.message : String(err)}`, 'error');
      }
    },
    [showToast],
  );

  /** 停止串行生成：只置一个标志，队列在自己下一个检查点退出（云端已提交的任务取消不了） */
  const handleStopGenerate = useCallback(() => {
    if (!generatingAll) return;
    stopRequestedRef.current = true;
    setStopping(true);
    setQueueInfo('正在停止…');
  }, [generatingAll]);

  /* 把已生成的镜头按剧本顺序拼接成一个成片 */
  const handleCompose = useCallback(async () => {
    if (!script || composeState === 'running') return;

    const shotIds = script.shots
      .filter((shot) => {
        const job = jobs[shot.id];
        return job?.status === 'succeeded' && !!job.videoUrl;
      })
      .map((shot) => shot.id);

    if (shotIds.length < 2) {
      showToast('至少要 2 个镜头生成完成才能合成', 'error');
      return;
    }

    setComposeState('running');
    setComposeError(null);
    try {
      // 导出尺寸按项目画幅 / 画质，避免竖屏项目导出成横屏
      const result = await api.compose(shotIds, {
        ratio: project?.ratio,
        resolution: project?.resolution,
      });
      setComposeResult(result);
      setComposeState('done');
      showToast(`已合成 ${result.clips} 个镜头`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setComposeError(message);
      setComposeState('error');
      showToast(message, 'error');
    }
  }, [script, jobs, composeState, project, showToast]);

  /* 切换到本项目下的另一份剧本 */
  const handleSelectScript = useCallback(
    async (id: string) => {
      if (id === scriptIdRef.current || switching) return;
      setSwitching(true);
      try {
        if (script && scriptIdRef.current) {
          await persistScript(script, ideaRef.current);
        }
        const { script: stored } = await api.getScript(id);
        applyStored(stored);
        // 地址栏跟着切，刷新后还停在这份剧本上（不触发重新渲染）
        window.history.replaceState(
          null,
          '',
          `/projects/${projectId}?script=${encodeURIComponent(stored.id)}`,
        );
        setError(null);
        resetCompose();
        await refreshJobs();
      } catch (err) {
        showToast(`切换剧本失败：${err instanceof Error ? err.message : String(err)}`, 'error');
      } finally {
        setSwitching(false);
      }
    },
    [applyStored, switching, script, persistScript, refreshJobs, resetCompose, showToast],
  );

  /* 项目重命名 */
  const saveProjectName = useCallback(async () => {
    if (!project) return;
    const name = projectName.trim();
    if (!name || name === project.name) {
      setProjectName(project.name);
      return;
    }

    try {
      const { project: saved } = await api.updateProject(projectId, { name });
      setProject(saved);
      setProjectName(saved.name);
      showToast('项目名已更新');
    } catch (err) {
      setProjectName(project.name);
      showToast(`改名失败：${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  }, [project, projectName, projectId, showToast]);

  /**
   * 画幅 / 画质：创建项目时选定，这里允许就地修改。
   * 只影响之后提交的镜头和合成导出，已经生成好的视频不会重跑。
   */
  const saveProjectVideoSettings = useCallback(
    async (patch: { ratio?: VideoRatio; resolution?: VideoResolution }) => {
      if (!project) return;
      const previous = project;
      setProject({ ...project, ...patch });
      try {
        const { project: saved } = await api.updateProject(projectId, patch);
        setProject(saved);
        showToast('画幅 / 画质已更新，后续生成的镜头按新设置执行');
      } catch (err) {
        setProject(previous);
        showToast(
          `保存设置失败：${err instanceof Error ? err.message : String(err)}`,
          'error',
        );
      }
    },
    [project, projectId, showToast],
  );

  if (loadState === 'missing') {
    return (
      <div className="app">
        <TopBar health={health} homeLink />
        <div className="empty">
          <h3>项目不存在</h3>
          <p>它可能已被删除。</p>
          <Link className="btn btn--primary" href="/">
            返回项目列表
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <TopBar health={health} homeLink>
        <span className="topbar-sep" />
        <input
          className="project-name-input"
          value={projectName}
          onChange={(e) => setProjectName(e.target.value)}
          onBlur={() => void saveProjectName()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
          }}
          placeholder="项目名称"
          aria-label="项目名称"
        />
        <span className="topbar-sep" />
        <select
          className="select topbar-select"
          value={project?.ratio ?? DEFAULT_VIDEO_RATIO}
          onChange={(e) => void saveProjectVideoSettings({ ratio: e.target.value as VideoRatio })}
          disabled={!project}
          title="画幅比例：之后提交的镜头按这个比例出片；带首帧 / 尾帧的镜头跟随素材比例"
          aria-label="画幅比例"
        >
          {VIDEO_RATIOS.map((value) => (
            <option key={value} value={value}>
              {RATIO_LABEL[value]}
            </option>
          ))}
        </select>
        <select
          className="select topbar-select"
          value={project?.resolution ?? DEFAULT_VIDEO_RESOLUTION}
          onChange={(e) =>
            void saveProjectVideoSettings({ resolution: e.target.value as VideoResolution })
          }
          disabled={!project}
          title="画质：之后提交的镜头按这个档位生成；合成导出尺寸也跟着它"
          aria-label="画质"
        >
          {VIDEO_RESOLUTIONS.map((value) => (
            <option key={value} value={value}>
              {RESOLUTION_LABEL[value]}
            </option>
          ))}
        </select>
      </TopBar>

      <main className="workspace workspace--single">
        <section className="panel">
          <ScriptView
            script={script}
            loading={loadState === 'loading'}
            error={error}
            jobs={jobs}
            idea={idea}
            onShotChange={handleShotChange}
            onGenerate={handleGenerateOne}
            onGenerateAll={handleGenerateAll}
            generatingAll={generatingAll}
            queueInfo={queueInfo}
            saveState={saveState}
            onCompose={handleCompose}
            composeState={composeState}
            composeResult={composeResult}
            composeError={composeError}
            composeReady={health?.compose.ffmpeg ?? false}
            scripts={scripts}
            currentScriptId={scriptId}
            onSelectScript={handleSelectScript}
            switching={switching}
            onCharactersChange={handleCharactersChange}
            onScenesChange={handleScenesChange}
            onNewScript={handleNewScript}
            onDeleteScript={handleDeleteScript}
            onScriptTitleChange={handleScriptTitleChange}
            onStyleChange={handleStyleChange}
            onEditIdea={handleEditIdea}
            onRecreateIdea={handleRecreateIdea}
            prevFrameRefEnabled={health ? health.video.referencePrevFrame : true}
            onAddShot={handleAddShot}
            onAbandonShot={handleAbandonShot}
            onStopGenerate={handleStopGenerate}
            stopping={stopping}
          />
        </section>
      </main>

      {toast && (
        <div className={`toast ${toast.type === 'error' ? 'toast--error' : ''}`}>{toast.text}</div>
      )}
    </div>
  );
}

export default function ProjectPage() {
  return (
    <Suspense fallback={<div className="app" />}>
      <ProjectPageInner />
    </Suspense>
  );
}
