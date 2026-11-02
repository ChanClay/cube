import type {
  ComposeResult,
  MediaInput,
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
    provider: string;
    configured: boolean;
    model: string;
    resolution: string;
    ratio: string;
    audio: boolean;
    /** 承接上一镜末帧的镜头是否保留音轨 */
    audioOnCarry: boolean;
    promptExtend: boolean;
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
  idea: string;
  style: string;
  shotCount: number;
  duration: number;
}

export interface VideoBody {
  shotId: string;
  prompt: string;
  duration: number;
  media?: MediaInput[];
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
}

/** 角色卡 / 场景卡的一键配图 */
export interface ImageBody {
  prompt: string;
  /** 决定出图比例：角色用竖图，场景用横图 */
  kind: 'character' | 'scene';
  /** 沿用剧本的视觉风格 */
  style?: string;
}

/** 修改画面描述后，只重算这一镜的分镜信息（不改 description） */
export interface RefineShotBody {
  description: string;
  title?: string;
  style?: string;
  duration?: number;
  /** 上一镜 / 下一镜的画面描述，用于承接与衔接 */
  before?: string;
  after?: string;
  /** 全片角色卡，保证重算后角色外貌不漂移 */
  characters?: { name: string; desc: string }[];
}

/** 重算后可变的字段，description 由用户自己维护 */
export type RefinedShot = Pick<
  Shot,
  'title' | 'shotSize' | 'cameraMove' | 'videoPrompt' | 'narration'
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

  createScript: (body: ScriptBody) =>
    request<{ script: Script }>('/api/script', { method: 'POST', body: JSON.stringify(body) }),

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

  createProject: (body: { name?: string; description?: string } = {}) =>
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

  /** 把多个镜头视频合成为一个完整视频 */
  compose: (shotIds: string[]) =>
    request<ComposeResult>('/api/compose', {
      method: 'POST',
      body: JSON.stringify({ shotIds }),
    }),
};
