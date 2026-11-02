'use client';

import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';
import IdeaForm, { type ScriptParams } from '@/components/IdeaForm';
import TopBar from '@/components/TopBar';
import { NEW_SCRIPT_TITLE } from '@/lib/blank-script';
import { api, type HealthInfo } from '@/lib/client';
import { demoScript } from '@/lib/demo-script';
import type { Project, Script, StoredScript } from '@/lib/types';

/**
 * 故事创意页的三种进入方式：
 * - new：新建项目 / 新建剧本，生成后新存一份剧本
 * - edit：编辑当前剧本的创意（?script=id），生成后覆盖这份剧本
 * - copy：已生成过视频时，基于当前创意重新新建（?copy=id）
 */
type Mode = 'new' | 'edit' | 'copy';

const HEAD_TEXT: Record<Mode, { title: string; desc: string; submit: string }> = {
  new: {
    title: '写下这个故事',
    desc: '填写创意并生成分镜，剧本会自动保存到这个项目下。',
    submit: '生成剧本',
  },
  edit: {
    title: '编辑故事创意',
    desc: '修改创意后重新生成，会用新分镜覆盖这份剧本的内容。',
    submit: '重新生成剧本',
  },
  copy: {
    title: '基于当前创意重新新建',
    desc: '当前剧本已经生成过视频，为避免覆盖成片，会带着这份创意另存为新剧本。',
    submit: '生成新剧本',
  },
};

function IdeaPageInner() {
  const params = useParams<{ id: string }>();
  const projectId = params?.id ?? '';
  const router = useRouter();
  const search = useSearchParams();

  const editId = search.get('script');
  const copyId = search.get('copy');
  const sourceId = editId ?? copyId;
  const mode: Mode = editId ? 'edit' : copyId ? 'copy' : 'new';
  /** 从首页「新建项目」直接进来：还没写创意，多给一个「返回首页」的出口 */
  const fresh = search.get('fresh') === '1' && mode === 'new';

  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [source, setSource] = useState<StoredScript | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'missing'>('loading');
  const [submitting, setSubmitting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [scriptCount, setScriptCount] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    api
      .health()
      .then((info) => {
        if (!cancelled) setHealth(info);
      })
      .catch(() => undefined);

    if (!projectId) return;

    (async () => {
      try {
        const { project: detail, scripts: list } = await api.getProject(projectId);
        if (cancelled) return;
        setProject(detail);
        setScriptCount(list.length);

        if (sourceId) {
          const { script: stored } = await api.getScript(sourceId);
          if (cancelled) return;
          // 只回填本项目下的剧本，避免跨项目误改
          if (stored.projectId !== projectId) {
            setLoadState('missing');
            return;
          }
          setSource(stored);
        }

        setLoadState('ready');
      } catch {
        if (!cancelled) setLoadState('missing');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [projectId, sourceId]);

  /** 生成 / 加载示例之后统一回项目页，并选中刚写入的那份剧本 */
  const backToProject = useCallback(
    (scriptIdToSelect: string) => {
      router.replace(`/projects/${projectId}?script=${scriptIdToSelect}`);
    },
    [projectId, router],
  );

  const handleGenerate = useCallback(
    async (formParams: ScriptParams) => {
      if (submitting) return;
      setSubmitting(true);
      setError(null);
      try {
        const { script: generated } = await api.createScript({
          idea: formParams.idea,
          style: formParams.style,
          shotCount: formParams.shotCount,
          duration: formParams.shotCount * formParams.shotDuration,
        });

        // 编辑时保留用户自己起的剧本名，不被模型标题冲掉
        const customTitle = source?.title?.trim() ?? '';
        const keepTitle = mode === 'edit' && customTitle.length > 0 && customTitle !== NEW_SCRIPT_TITLE;
        const next: Script = keepTitle ? { ...generated, title: customTitle } : generated;

        const { script: saved } = await api.saveScript({
          id: mode === 'edit' ? (editId ?? undefined) : undefined,
          projectId,
          idea: formParams.idea,
          script: next,
        });

        backToProject(saved.id);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setSubmitting(false);
      }
    },
    [backToProject, editId, mode, projectId, source, submitting],
  );

  const handleLoadDemo = useCallback(async () => {
    if (submitting) return;

    // 编辑模式下示例会覆盖现有分镜，先确认一次
    if (mode === 'edit' && (source?.script.shots.length ?? 0) > 0) {
      const ok = window.confirm('加载示例会覆盖这份剧本的分镜内容，继续？');
      if (!ok) return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const next = structuredClone(demoScript);
      if (mode === 'edit') {
        const customTitle = source?.title?.trim() ?? '';
        if (customTitle && customTitle !== NEW_SCRIPT_TITLE) next.title = customTitle;
      }

      const { script: saved } = await api.saveScript({
        id: mode === 'edit' ? (editId ?? undefined) : undefined,
        projectId,
        idea: '示例剧本（演示）',
        script: next,
      });

      backToProject(saved.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }, [backToProject, editId, mode, projectId, source, submitting]);

  /**
   * 回首页并放弃这次新建：只有在项目下还没有任何剧本时才撤掉刚建的空项目，
   * 删除失败也不挡着回首页（项目仍留在列表里可继续用）。
   */
  const handleBackHome = useCallback(async () => {
    if (cancelling || submitting) return;
    setCancelling(true);
    if (fresh && scriptCount === 0) {
      try {
        await api.deleteProject(projectId);
      } catch {
        // 忽略：回首页优先
      }
    }
    router.push('/');
  }, [cancelling, fresh, projectId, router, scriptCount, submitting]);

  if (loadState === 'missing') {
    return (
      <div className="app">
        <TopBar health={health} homeLink />
        <div className="empty">
          <h3>项目或剧本不存在</h3>
          <p>它可能已被删除。</p>
          <Link className="btn btn--primary" href="/">
            返回项目列表
          </Link>
        </div>
      </div>
    );
  }

  const head = HEAD_TEXT[mode];
  const shots = source?.script.shots ?? [];
  const projectHref = `/projects/${projectId}`;

  return (
    <div className="app">
      <TopBar health={health} homeLink>
        <span className="topbar-sep" />
        <span className="topbar-project">{project?.name ?? '加载中…'}</span>
      </TopBar>

      <main className="idea-page">
        <div className="idea-wrap">
          <div className="idea-head">
            <div className="panel-title">故事创意</div>
            <h1>{head.title}</h1>
            <p>{head.desc}</p>
          </div>

          <section className="panel">
            <IdeaForm
              loading={submitting || loadState === 'loading'}
              llmConfigured={health ? health.llm.configured : null}
              initialIdea={source?.idea ?? ''}
              initialStyle={source?.script.style ?? ''}
              initialShotCount={shots.length || undefined}
              initialShotDuration={shots[0]?.duration || undefined}
              submitText={head.submit}
              onGenerate={handleGenerate}
              onLoadDemo={handleLoadDemo}
            />
          </section>

          {error && <div className="alert alert--error">{error}</div>}

          <div className="idea-foot">
            <div className="idea-foot-actions">
              <Link className="btn btn--ghost btn--sm" href={projectHref}>
                {fresh ? '← 进入项目页' : '← 返回项目'}
              </Link>
              {fresh && (
                <button
                  className="btn btn--ghost btn--sm"
                  type="button"
                  onClick={() => void handleBackHome()}
                  disabled={cancelling}
                  title="回到项目列表，并撤掉这次刚创建的空项目"
                >
                  {cancelling ? <span className="spinner" /> : null}
                  返回首页
                </button>
              )}
            </div>
            {mode === 'edit' && (
              <span className="field-hint">
                重新生成会替换这份剧本的分镜，已手动修改的镜头内容不会保留
              </span>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

export default function IdeaPage() {
  return (
    <Suspense fallback={<div className="app" />}>
      <IdeaPageInner />
    </Suspense>
  );
}
