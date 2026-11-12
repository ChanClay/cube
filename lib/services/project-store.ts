import type { ResultSetHeader } from 'mysql2';
import { currentUserId } from './auth';
import { getDb } from './db';
import type { Project, ProjectSummary } from '@/lib/types';
import { normalizeRatio, normalizeResolution } from '@/lib/video-options';

const MAX_PROJECTS = 200;

interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  ratio: string | null;
  resolution: string | null;
  created_at: number | string;
  updated_at: number | string;
}

interface ProjectListRow extends ProjectRow {
  script_count: number | string | null;
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? '',
    ratio: normalizeRatio(row.ratio),
    resolution: normalizeResolution(row.resolution),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const pool = await getDb();
  const userId = await currentUserId();
  const [rows] = await pool.query(
    `SELECT p.*, (SELECT COUNT(*) FROM scripts s WHERE s.project_id = p.id AND s.user_id = p.user_id) AS script_count
     FROM projects p
     WHERE p.user_id = ?
     ORDER BY p.updated_at DESC
     LIMIT ${MAX_PROJECTS}`,
    [userId],
  );

  return (rows as ProjectListRow[]).map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description ?? '',
    scriptCount: Number(row.script_count ?? 0),
    ratio: normalizeRatio(row.ratio),
    resolution: normalizeResolution(row.resolution),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }));
}

export async function getProject(id: string): Promise<Project | null> {
  const pool = await getDb();
  const userId = await currentUserId();
  const [rows] = await pool.query(
    'SELECT * FROM projects WHERE id = ? AND user_id = ? LIMIT 1',
    [id, userId],
  );
  const row = (rows as ProjectRow[])[0];
  return row ? toProject(row) : null;
}

export async function createProject(input: {
  name?: string;
  description?: string;
  ratio?: string;
  resolution?: string;
}): Promise<Project> {
  const pool = await getDb();
  const userId = await currentUserId();
  const now = Date.now();
  const id = crypto.randomUUID();
  const name = input.name?.trim().slice(0, 200) || '未命名项目';
  const description = input.description?.trim() ?? '';
  const ratio = normalizeRatio(input.ratio);
  const resolution = normalizeResolution(input.resolution);

  await pool.query(
    `INSERT INTO projects (id, user_id, name, description, ratio, resolution, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, userId, name, description, ratio, resolution, now, now],
  );

  // 只裁剪当前用户自己的项目
  await pool.query(
    `DELETE FROM projects
     WHERE user_id = ?
       AND id NOT IN (
         SELECT id FROM (
           SELECT id FROM projects WHERE user_id = ? ORDER BY updated_at DESC LIMIT ${MAX_PROJECTS}
         ) AS keep
       )`,
    [userId, userId],
  );

  return { id, name, description, ratio, resolution, createdAt: now, updatedAt: now };
}

export interface UpdateProjectInput {
  name?: string;
  description?: string;
  ratio?: string;
  resolution?: string;
}

export async function updateProject(id: string, patch: UpdateProjectInput): Promise<Project | null> {
  const pool = await getDb();
  const existing = await getProject(id);
  if (!existing) return null;

  const now = Date.now();
  const name =
    typeof patch.name === 'string' && patch.name.trim()
      ? patch.name.trim().slice(0, 200)
      : existing.name;
  const description =
    typeof patch.description === 'string' ? patch.description : existing.description;
  const ratio = patch.ratio === undefined ? existing.ratio : normalizeRatio(patch.ratio, existing.ratio);
  const resolution =
    patch.resolution === undefined
      ? existing.resolution
      : normalizeResolution(patch.resolution, existing.resolution);

  const userId = await currentUserId();
  await pool.query(
    `UPDATE projects SET name = ?, description = ?, ratio = ?, resolution = ?, updated_at = ?
     WHERE id = ? AND user_id = ?`,
    [name, description, ratio, resolution, now, id, userId],
  );

  return { ...existing, name, description, ratio, resolution, updatedAt: now };
}

export async function deleteProject(id: string): Promise<boolean> {
  const pool = await getDb();
  const userId = await currentUserId();
  await pool.query('DELETE FROM scripts WHERE project_id = ? AND user_id = ?', [id, userId]);
  const [result] = await pool.query('DELETE FROM projects WHERE id = ? AND user_id = ?', [
    id,
    userId,
  ]);
  return (result as ResultSetHeader).affectedRows > 0;
}

/** 保存一份剧本后刷新项目时间戳，让最新有动作的项目排前面 */
export async function touchProject(id: string): Promise<void> {
  const pool = await getDb();
  const userId = await currentUserId();
  await pool.query('UPDATE projects SET updated_at = ? WHERE id = ? AND user_id = ?', [
    Date.now(),
    id,
    userId,
  ]);
}
