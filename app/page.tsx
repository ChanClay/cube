'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import TopBar from '@/components/TopBar';
import { api, type HealthInfo } from '@/lib/client';
import { timeAgo } from '@/lib/format';
import type { ProjectSummary } from '@/lib/types';
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

export default function HomePage() {
  const router = useRouter();
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  /** 画幅 / 画质在创建时选定，之后在项目页还能改 */
  const [ratio, setRatio] = useState<VideoRatio>(DEFAULT_VIDEO_RATIO);
  const [resolution, setResolution] = useState<VideoResolution>(DEFAULT_VIDEO_RESOLUTION);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      const { projects: list } = await api.listProjects();
      setProjects(list);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    api.health().then(setHealth).catch(() => setHealth(null));
    void load();
  }, [load]);

  const createProject = useCallback(async () => {
    if (creating) return;
    setCreating(true);
    try {
      const { project } = await api.createProject({
        name: name.trim() || undefined,
        ratio,
        resolution,
      });
      // 新建项目先进故事创意页，写完创意生成第一份剧本
      router.push(`/projects/${project.id}/idea?fresh=1`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setCreating(false);
    }
  }, [creating, name, ratio, resolution, router]);

  const removeProject = useCallback(
    async (event: React.MouseEvent, project: ProjectSummary) => {
      event.preventDefault();
      event.stopPropagation();
      if (!window.confirm(`删除项目「${project.name}」？其下的 ${project.scriptCount} 份剧本会一起删除。`)) {
        return;
      }

      try {
        await api.deleteProject(project.id);
        setProjects((prev) => prev.filter((item) => item.id !== project.id));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [],
  );

  return (
    <div className="app">
      <TopBar health={health} />

      <main className="home">
        <div className="home-head">
          <div>
            <h1>项目</h1>
            <p>一个项目下可以有多份剧本、一套共享的关联素材。</p>
          </div>

          <div className="home-actions">
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void createProject();
              }}
              placeholder="新项目名称，可留空"
              aria-label="新项目名称"
            />
            <select
              className="select home-select"
              value={ratio}
              onChange={(e) => setRatio(e.target.value as VideoRatio)}
              aria-label="画幅比例"
              title="画幅比例：决定生成的视频是横屏还是竖屏"
            >
              {VIDEO_RATIOS.map((value) => (
                <option key={value} value={value}>
                  {RATIO_LABEL[value]}
                </option>
              ))}
            </select>
            <select
              className="select home-select"
              value={resolution}
              onChange={(e) => setResolution(e.target.value as VideoResolution)}
              aria-label="画质"
              title="画质：越高的档位越清晰，也越慢越贵"
            >
              {VIDEO_RESOLUTIONS.map((value) => (
                <option key={value} value={value}>
                  {RESOLUTION_LABEL[value]}
                </option>
              ))}
            </select>
            <button className="btn btn--primary" onClick={createProject} disabled={creating}>
              {creating ? <span className="spinner" /> : null}
              新建项目
            </button>
          </div>
        </div>

        {error && <div className="alert alert--error">{error}</div>}

        {loading ? (
          <div className="project-grid">
            {[0, 1, 2].map((i) => (
              <div className="skeleton-card" key={i}>
                <div className="sk-line" style={{ width: '55%' }} />
                <div className="sk-line" style={{ width: '85%' }} />
                <div className="sk-line" style={{ width: '40%' }} />
              </div>
            ))}
          </div>
        ) : projects.length === 0 ? (
          <div className="empty">
            <h3>还没有项目</h3>
            <p>在上面填写项目名称并点「新建项目」，然后在故事创意页写下第一个故事。</p>
          </div>
        ) : (
          <div className="project-grid">
            {projects.map((project) => (
              <Link key={project.id} href={`/projects/${project.id}`} className="project-card">
                <div className="project-card-head">
                  <h3>{project.name}</h3>
                  <button
                    className="project-card-del"
                    onClick={(event) => removeProject(event, project)}
                    aria-label={`删除项目 ${project.name}`}
                    title="删除项目"
                  >
                    ×
                  </button>
                </div>

                <p className="project-card-desc">{project.description || '暂无描述'}</p>

                <div className="project-card-meta">
                  <span className="tag">{project.scriptCount} 剧本</span>
                  <span className="tag">
                    {project.ratio} · {project.resolution}
                  </span>
                  <span className="project-card-time">{timeAgo(project.updatedAt)}</span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
