import type { VideoModelSpec } from './video-models';
import type {
  BackgroundCast,
  ComposeResult,
  MediaInput,
  NarrationType,
  Project,
  ProjectMedia,
  ProjectSummary,
  Script,
  Shot,
  StoredScript,
  StoredScriptSummary,
  VideoJob,
} from './types';

export interface HealthInfo {
  storage: {
    driver: string;
    host: string;
    database: string;
    ok: boolean;
    error: string | null;
  };
  compose: { ffmpeg: boolean; hint: string | null };
  llm: { configured: boolean; model: string; baseUrl: string };
  video: {
    configured: boolean;
    /** 创建剧本时可选的视频模型（含单镜时长区间），见 lib/video-models */
    models: VideoModelSpec[];
    resolution: string;
    ratio: string;
    /** 硬切镜头是否用上一镜末帧（同景别当首帧，跨景别当风格参考图） */
    referencePrevFrame: boolean;
  };
  pollIntervalMs: number;
}

/* ---------- 账号 ---------- */

export interface AuthUser {
  id: string;
  username: string;
  createdAt: number;
}

export interface AuthState {
  user: AuthUser | null;
  /** 库里还没有账号时为 true，登录页据此显示「创建账号」 */
  registrationOpen: boolean;
}

/** 401：会话失效或未登录，调用方可单独识别，不必当成普通错误展示 */
export class UnauthorizedError extends Error {
  constructor(message = '请先登录') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

/** 默认请求超时：避免某个请求挂死后拖住整个串行队列 */
const DEFAULT_TIMEOUT_MS = 120_000;

interface RequestInitWithTimeout extends RequestInit {
  timeoutMs?: number;
}

/**
 * 会话失效时把整页踢回登录页。
 * 登录页自己的 401 是「密码错误」，不能再跳，否则用户看不到提示。
 */
function redirectToLogin(): void {
  if (typeof window === 'undefined') return;
  const { pathname, search } = window.location;
  if (pathname === '/login') return;

  const next = `${pathname}${search}`;
  window.location.href =
    next && next !== '/' ? `/login?next=${encodeURIComponent(next)}` : '/login';
}

async function request<T>(url: string, init?: RequestInitWithTimeout): Promise<T> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...rest } = init ?? {};
  const isForm = typeof FormData !== 'undefined' && rest.body instanceof FormData;

  const res = await fetch(url, {
    ...rest,
    cache: 'no-store',
    headers: isForm
      ? { ...(rest.headers ?? {}) }
      : { 'Content-Type': 'application/json', ...(rest.headers ?? {}) },
    signal: rest.signal ?? AbortSignal.timeout(timeoutMs),
  });

  const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;

  if (res.status === 401) {
    redirectToLogin();
    throw new UnauthorizedError(data?.error || '登录状态已失效，请重新登录');
  }

  if (!res.ok) {
    throw new Error(data?.error || `请求失败（HTTP ${res.status}）`);
  }
  return data as T;
}

export interface ScriptBody {
  /** 故事创意；source=novel 时是小说 / 章节原文 */
  idea: string;
  /** idea=短创意（缺省），novel=小说 / 章节原文，服务端会先压缩改编 */
  source?: 'idea' | 'novel';
  style: string;
  /** shots=按镜头数（缺省），duration=按视频总时长反推镜头数 */
  mode?: 'shots' | 'duration';
  shotCount: number;
  /** shots 模式下为总时长，duration 模式下为用户设定的视频总时长 */
  duration: number;
  /** 这次要用的视频模型（见 lib/video-models），决定单镜时长区间 */
  videoModel?: string;
}

export interface VideoBody {
  shotId: string;
  prompt: string;
  duration: number;
  /** 画幅 / 画质：取项目设置，缺省由服务端回落全局配置 */
  ratio?: string;
  resolution?: string;
  media?: MediaInput[];
  /** 剧本选定的视频模型：服务端据此选 provider 并夹时长 */
  videoModel?: string;
}

export interface SaveScriptBody {
  id?: string;
  projectId?: string;
  idea: string;
  script: Script;
}

export interface UpdateProjectBody {
  name?: string;
  description?: string;
  /** 画幅比例，见 lib/video-options */
  ratio?: string;
  /** 画质档位，见 lib/video-options */
  resolution?: string;
}

/** 新建项目时的画幅 / 画质选择 */
export interface CreateProjectBody {
  name?: string;
  description?: string;
  ratio?: string;
  resolution?: string;
}

/** 角色卡 / 场景卡的一键配图 */
export interface ImageBody {
  prompt: string;
  /** 主体类型（来自蓝图）：载具卡走横图，人类卡不会被 desc 里的「车内」带偏 */
  subjectType?: 'human' | 'vehicle' | 'mech';
  /** 蓝图锁定的固定英文外貌 / 空间短语，保证卡片与逐镜视频一致 */
  promptEn?: string;
  /** 决定出图比例：角色用竖图，场景用横图 */
  kind: 'character' | 'scene';
  /** 沿用剧本的视觉风格 */
  style?: string;
}

/** 修改画面描述后，只重算这一镜的分镜信息（不改 description） */
export interface RefineShotBody {
  /** 镜头 id：服务端用它做重复提交锁（同一镜同时只允许一个重算请求） */
  shotId?: string;
  description: string;
  title?: string;
  style?: string;
  /** 全片运动基调：重算单镜时也要体现，特写不许把整场戏的速度丢掉 */
  motionProfile?: string;
  duration?: number;
  /** 上一镜 / 下一镜的画面描述，用于承接与衔接 */
  before?: string;
  after?: string;
  /** 上一镜末帧里实际在场的人物名：本镜会带上那张末帧当参考图，提示词要按这份名单点名 */
  prevCast?: string[];
  /** 上一镜结尾画面里的背景人群（无主体卡）：本镜开头必须还是这一群人 */
  prevBackgroundCast?: BackgroundCast[];
  /** 上一镜的结尾状态（分镜写的画面事实），用来对齐动作与位置 */
  prevExitState?: string;
  /**
   * 本镜当前的台词与类型。
   *
   * 台词是设计层事实，不是画面描述的派生物：用户只改画面描述时，
   * 重算必须原样保留这几项，否则台词会因为「描述里没写」被静默清空。
   */
  narration?: string;
  narrationType?: NarrationType;
  speaker?: string;
  /** 本镜当前的背景人群：重算时默认原样保留，不许把一群人改成一个主角 */
  backgroundCast?: BackgroundCast[];
  /** 本镜人群是否已明确退场 */
  crowdCleared?: boolean;
  /** 全片角色卡，保证重算后角色外貌不漂移 */
  characters?: { name: string; desc: string }[];
  /** 全片场景卡：重算后必须复用本镜所在场景的固定空间短语与陈设清单 */
  scenes?: {
    name: string;
    desc: string;
    promptEn?: string;
    /** 固定陈设清单：重算时只能用清单里的物件，不许即兴摆家具 */
    inventory?: { name: string; en?: string; where?: string; whereEn?: string; fixed?: boolean }[];
    state?: string;
  }[];
  /** 本镜当前的场景归属：重算以它为准，不许把地点改回别的场景 */
  sceneNames?: string[];
  /** 上一镜的场景名：本镜没标场景时按它承接 */
  prevSceneName?: string;
}

/** 重算后可变的字段，description 由用户自己维护 */
export type RefinedShot = Pick<
  Shot,
  | 'title'
  | 'shotSize'
  | 'cameraMove'
  | 'videoPrompt'
  | 'narration'
  | 'narrationType'
  | 'speaker'
  | 'beatSheet'
  | 'blocking'
  | 'blockingEn'
  | 'backgroundCast'
  | 'crowdCleared'
>;

/** 从已生成的视频里抽一帧，交给下一镜当首帧 */
export interface ExtractFrameBody {
  videoUrl?: string;
  jobId?: string;
  /** 默认取末帧 */
  position?: 'last' | 'first';
}

export interface ExtractedFrame {
  fileName: string;
  /** 站内相对地址 */
  url: string;
  /** 给视频模型用的绝对地址 */
  absoluteUrl: string;
  /** 是否是可被云端模型下载的公网地址 */
  publiclyReachable: boolean;
}

const query = (params: Record<string, string | number | undefined>) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
};

export const api = {
  health: () => request<HealthInfo>('/api/health'),

  /* ---------- 账号 ---------- */

  auth: {
    me: () => request<AuthState>('/api/auth/me'),

    login: (body: { username: string; password: string }) =>
      request<{ user: AuthUser }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify(body),
      }),

    register: (body: { username: string; password: string }) =>
      request<{ user: AuthUser; claimedProjects: number }>('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify(body),
      }),

    logout: () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
  },

  /**
   * 生成剧本是多次串行 LLM 调用（蓝图 → 分镜 → 翻译，审片命中问题时再修一次），
   * 12 镜的长稿实测要 120~180 秒。这里必须对齐服务端的 maxDuration（300 秒），
   * 用默认的 120 秒会在服务端还在跑的时候就被前端 abort 掉——用户看到「生成失败」，
   * 实际剧本已经生成完并写进日志。
   */
  createScript: (body: ScriptBody) =>
    request<{ script: Script; meta?: { model: string; adaptedIdea?: string } }>('/api/script', {
      method: 'POST',
      body: JSON.stringify(body),
      // 留 20 秒余量：服务端在 300 秒被平台掐断，前端要比它晚断，才能把服务端的错误信息显示出来
      timeoutMs: 280_000,
    }),

  saveScript: (body: SaveScriptBody) =>
    request<{ script: StoredScript }>('/api/scripts', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  latestScript: (projectId?: string) =>
    request<{ script: StoredScript | null }>(`/api/scripts/latest${query({ projectId })}`),

  getScript: (id: string) =>
    request<{ script: StoredScript }>(`/api/scripts/${encodeURIComponent(id)}`),

  listScripts: (limit = 20, projectId?: string) =>
    request<{ scripts: StoredScriptSummary[] }>(`/api/scripts${query({ limit, projectId })}`),

  /* ---------- 项目 ---------- */

  listProjects: () => request<{ projects: ProjectSummary[] }>('/api/projects'),

  createProject: (body: CreateProjectBody = {}) =>
    request<{ project: Project }>('/api/projects', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  getProject: (id: string) =>
    request<{ project: Project; scripts: StoredScriptSummary[] }>(
      `/api/projects/${encodeURIComponent(id)}`,
    ),

  updateProject: (id: string, body: UpdateProjectBody) =>
    request<{ project: Project }>(`/api/projects/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),

  deleteProject: (id: string) =>
    request<{ ok: boolean }>(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  /* ---------- 素材 ---------- */

  uploadMedia: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<{ media: ProjectMedia }>('/api/uploads', { method: 'POST', body: form });
  },

  /** 角色卡 / 场景卡一键配图：调万相文生图，落地到本地再返回站内地址 */
  generateImage: (body: ImageBody) =>
    request<{ media: ProjectMedia }>('/api/image', {
      method: 'POST',
      body: JSON.stringify(body),
      // 文生图同步调用通常 10~60 秒
      timeoutMs: 180_000,
    }),

  deleteUpload: (url: string) => {
    const name = url.split('/').pop() ?? '';
    return request<{ ok: boolean }>(`/api/uploads/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    });
  },

  deleteScript: (id: string) =>
    request<{ ok: boolean }>(`/api/scripts/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  listJobs: () => request<{ jobs: VideoJob[] }>('/api/video'),

  createJob: (body: VideoBody) =>
    request<{ job: VideoJob }>('/api/video', { method: 'POST', body: JSON.stringify(body) }),

  /** 轮询任务状态：给短超时，一次失败等下一轮即可 */
  getJob: (id: string) =>
    request<{ job: VideoJob }>(`/api/video/${encodeURIComponent(id)}`, { timeoutMs: 30_000 }),

  /** 放弃本镜：本地标记 canceled、停止跟踪进度（provider 侧任务没有取消接口） */
  abandonJob: (id: string) =>
    request<{ job: VideoJob }>(`/api/video/${encodeURIComponent(id)}`, { method: 'POST' }),

  /** 按修改后的画面描述重算单个镜头的分镜信息 */
  refineShot: (body: RefineShotBody) =>
    request<{ shot: RefinedShot }>('/api/shot/refine', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /** 从已生成的视频里抽一帧（默认末帧），给下一镜当首帧 */
  extractFrame: (body: ExtractFrameBody) =>
    request<{ frame: ExtractedFrame }>('/api/shot/frame', {
      method: 'POST',
      body: JSON.stringify(body),
      // 要先下载整段视频再跑 ffmpeg，给足时间
      timeoutMs: 180_000,
    }),

  /** 把多个镜头视频合成为一个完整视频，导出尺寸按项目画幅 / 画质 */
  compose: (shotIds: string[], size: { ratio?: string; resolution?: string } = {}) =>
    request<ComposeResult>('/api/compose', {
      method: 'POST',
      body: JSON.stringify({ shotIds, ...size }),
    }),
};
