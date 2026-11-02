'use client';

import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { blankShot } from '@/lib/blank-script';
import { buildVideoPrompt } from '@/lib/dialogue';
import ScriptView from '@/components/ScriptView';
import TopBar from '@/components/TopBar';
import { api, type HealthInfo } from '@/lib/client';
import { validateMedia } from '@/lib/media';
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

/** 自动注入的素材（抽帧或卡片配图），重新排队时会被新素材替换 */
const isAutoFrame = (url: string) =>
  url.includes('/api/frames/') || url.startsWith('/api/uploads/');

/**
 * 是否是一个「真的在服务端跑」的任务。
 * 本地乐观任务（local- 前缀 / 没有 providerJobId）永远等不到终态，
 * 用它去 waitForJob 只会白等到超时，进而卡死整个队列。
 */
const isServerJob = (job: VideoJob | undefined): job is VideoJob =>
  !!job && !!job.providerJobId && (job.status === 'queued' || job.status === 'running');

/**
 * 上一镜末帧拿不到时（第一镜 / 上一镜没成 / 抽帧失败 / 地址云端不可达），
 * 退回这一镜对应的场景卡 / 角色卡配图，但两者用途不同：
 *
 * - 场景图 → first_frame：场景空镜是一整帧真实构图，当首帧不易被带成棚拍；
 * - 角色图 → reference_image：设定图多半是纯色背景的单人像，只提供外貌参考，
 *   当首帧会把整段视频压成同样的背景。
 */
function fallbackMedia(shot: Shot, script: Script | null): MediaInput | null {
  if (!script) return null;
  const scenes = script.scenes ?? [];
  const withImage = (items: { name: string; imageUrl?: string }[]) =>
    items.find((item) => item.name && item.imageUrl);

  // 1. 分镜标注的场景，最准
  for (const name of shot.sceneNames ?? []) {
    const hit = scenes.find((scene) => scene.name === name && scene.imageUrl);
    if (hit?.imageUrl) return { type: 'first_frame', url: hit.imageUrl };
  }

  // 2. 画面描述里提到过某个场景名
  const text = [shot.title, shot.description, shot.videoPrompt, shot.narration]
    .filter(Boolean)
    .join('\n');
  const mentioned = scenes.find(
    (scene) => scene.name && scene.imageUrl && text.includes(scene.name),
  );
  if (mentioned?.imageUrl) return { type: 'first_frame', url: mentioned.imageUrl };

  // 3. 任意一张有图的场景卡
  const anyScene = withImage(scenes);
  if (anyScene?.imageUrl) return { type: 'first_frame', url: anyScene.imageUrl };

  // 4. 场景图都没有时，退到这一镜出镜角色的配图（只做外貌参考）
  for (const name of shot.characterNames ?? []) {
    const hit = script.characters.find(
      (character) => character.name === name && character.imageUrl,
    );
    if (hit?.imageUrl) return { type: 'reference_image', url: hit.imageUrl };
  }

  return null;
}

/**
 * 决定这一镜的衔接素材：上一镜末帧优先，没有则退回场景卡 / 角色卡配图。
 * - 用户手选的首帧优先，不覆盖；
 * - 首帧与参考素材 / 文档 / 网页互斥，有这些素材时不注入；
 * - 上一轮自动注入的素材先摘掉，否则旧的自动参考图会把后来才有的末帧挡在外面。
 */
function withCarryFrame(
  media: MediaInput[],
  carry: MediaInput | null,
  fallback: MediaInput | null,
): { next: MediaInput[]; source: 'carry' | 'fallback' | null; injected: MediaInput | null } {
  const manualFirst = media.some((item) => item.type === 'first_frame' && !isAutoFrame(item.url));
  if (manualFirst) return { next: media, source: null, injected: null };

  // 上一轮自动补的素材，这一轮重新决定：抽出的末帧一律重抽，
  // 卡片配图只认「这一轮算出来的那张」（用户手选的其他图保持不动）
  const rest = media.filter((item) => {
    if (item.type === 'first_frame' && item.url.includes('/api/frames/')) return false;
    if (fallback && item.url === fallback.url) return false;
    return true;
  });

  const hasReference = rest.some(
    (item) => item.type !== 'first_frame' && item.type !== 'last_frame',
  );
  if (hasReference) return { next: media, source: null, injected: null };

  const injected = carry ?? fallback;
  if (!injected) return { next: media, source: null, injected: null };

  // 尾帧和参考素材互斥：用户已经指定了尾帧，就不再塞参考图
  if (injected.type === 'reference_image' && rest.some((item) => item.type === 'last_frame')) {
    return { next: media, source: null, injected: null };
  }

  return {
    next: [injected, ...rest],
    source: carry ? 'carry' : 'fallback',
    injected,
  };
}

/** 自动注入的素材在提示里的叫法 */
const injectedLabel = (media: MediaInput | null) =>
  media?.type === 'reference_image' ? '参考图' : '首帧';

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

    const timer = setTimeout(async () => {
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
    }, pollMs);

    return () => {
      cancelled = true;
      clearTimeout(timer);
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
   */
  const handleCharactersChange = useCallback((next: Character[]) => {
    setScript((prev) => {
      if (!prev) return prev;

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
  }, []);

  /** 场景卡：只影响剧本数据，不参与视频生成 */
  const handleScenesChange = useCallback((next: Scene[]) => {
    setScript((prev) => (prev ? { ...prev, scenes: next } : prev));
  }, []);

  const generateShot = useCallback(
    async (
      shot: Shot,
      mediaOverride?: MediaInput[],
    ): Promise<{ job: VideoJob | null; retryable: boolean }> => {
      // 队列运行中镜头可能被编辑，按 id 取最新的一份
      const live = scriptRef.current?.shots.find((item) => item.id === shot.id) ?? shot;

      const basePrompt = live.videoPrompt.trim();
      if (basePrompt.length < 5) {
        showToast('这个镜头的视频提示词太短了', 'error');
        // 输入本身有问题，重试也没有意义
        return { job: null, retryable: false };
      }

      // 台词拼在画面描述后面：wan3.0 原生生成人声，但台词必须写进 prompt 才会说出来
      const prompt = buildVideoPrompt(basePrompt, live);

      const media = mediaOverride ?? live.media ?? [];
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
        resolution: health?.video.resolution ?? '720p',
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
    [health, projectId, showToast],
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

  /** 抽某个视频的末帧，作为下一镜的首帧；拿不到时返回 null，交给配图兜底 */
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
   * 单镜生成：这一镜打开了「承接上一镜」才抽上一镜末帧，
   * 没有可用的末帧时退回场景卡首帧 / 角色卡参考图。
   * 与串行队列走同一套衔接素材决策。
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
      const manualFirst = (live.media ?? []).some(
        (item) => item.type === 'first_frame' && !isAutoFrame(item.url),
      );

      /**
       * 承接开关默认关闭，只有显式打开才抽帧；
       * 上一镜还必须已经生成成功（跑着的等不了）。
       */
      let carry: MediaInput | null = null;
      if (
        !manualFirst &&
        index > 0 &&
        live.continueFromPrev &&
        prevJob?.status === 'succeeded' &&
        prevJob.videoUrl
      ) {
        // 要下载整段视频再跑 ffmpeg，给个提示免得以为卡住
        showToast('正在抽取上一镜末帧作为首帧…');
        carry = await extractCarryFrame(prevJob.videoUrl);
      }

      const injected = withCarryFrame(live.media ?? [], carry, fallbackMedia(live, current));

      if (injected.source === 'fallback') {
        showToast(
          live.continueFromPrev
            ? `这一镜没有可用的上一镜末帧，已用配图作为${injectedLabel(injected.injected)}`
            : `已用配图作为${injectedLabel(injected.injected)}`,
        );
      }
      if (injected.source) handleShotChange(shot.id, { media: injected.next });

      await generateShot(live, injected.next);
    },
    [extractCarryFrame, generateShot, handleShotChange, showToast],
  );

  /**
   * 串行队列（并发 = 1）：一次只生成一镜。
   * 是否用上一镜的末帧衔接，由下一镜自己的「承接上一镜末帧」开关决定，默认不用。
   */
  const handleGenerateAll = useCallback(async () => {
    if (!script || generatingAll) return;

    const shots = script.shots;
    // 用当前渲染出的任务状态作为队列起点，避免读到迟滞的 ref
    jobsRef.current = jobs;
    stopRequestedRef.current = false;
    setStopping(false);
    setGeneratingAll(true);
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
              // 上一镜末帧优先，没有则退回场景卡 / 角色卡配图；用户手选的首帧仍优先
              const live = scriptRef.current?.shots.find((item) => item.id === shot.id) ?? shot;

              // 承接开关默认关闭：只有这一镜显式打开，才为它抽上一镜的末帧
              const manualFirst = (live.media ?? []).some(
                (item) => item.type === 'first_frame' && !isAutoFrame(item.url),
              );
              let carry: MediaInput | null = null;
              if (!manualFirst && i > 0 && live.continueFromPrev && prevVideoUrl) {
                setQueueInfo(`第 ${i + 1}/${shots.length} 镜 · ${label}（抽取上一镜末帧）`);
                carry = await extractCarryFrame(prevVideoUrl);
              }

              // 抽帧期间点了停止：别再提交新的生成任务
              if (stopRequestedRef.current) {
                stoppedByUser = true;
                break;
              }

              const injected = withCarryFrame(
                live.media ?? [],
                carry,
                fallbackMedia(live, scriptRef.current),
              );
              if (injected.source === 'fallback') {
                setQueueInfo(
                  `第 ${i + 1}/${shots.length} 镜 · ${label}（用配图当${injectedLabel(injected.injected)}）`,
                );
              }
              if (injected.source) handleShotChange(shot.id, { media: injected.next });

              const created = await generateShot(live, injected.next);
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
    showToast,
  ]);

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
      const result = await api.compose(shotIds);
      setComposeResult(result);
      setComposeState('done');
      showToast(`已合成 ${result.clips} 个镜头`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setComposeError(message);
      setComposeState('error');
      showToast(message, 'error');
    }
  }, [script, jobs, composeState, showToast]);

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
            onEditIdea={handleEditIdea}
            onRecreateIdea={handleRecreateIdea}
            carryMuted={health ? health.video.audio && !health.video.audioOnCarry : true}
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
