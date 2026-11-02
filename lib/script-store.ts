import type { ResultSetHeader } from 'mysql2';
import { currentUserId } from './auth';
import { DEFAULT_PROJECT_ID, getDb } from './db';
import type { Script, StoredScript, StoredScriptSummary } from './types';

const MAX_SCRIPTS = 200;
/** 与表结构对齐的长度上限，避免模型输出超长导致 ER_DATA_TOO_LONG */
const MAX_TITLE = 255;
const MAX_STYLE = 255;
const MAX_IDEA = 12000;

const clip = (value: string | undefined, max: number): string =>
  (value ?? '').slice(0, max);

interface ScriptRow {
  id: string;
  project_id: string | null;
  idea: string | null;
  title: string;
  style: string;
  content: string;
  created_at: number | string;
  updated_at: number | string;
}

export interface SaveScriptInput {
  id?: string;
  /** 不传时落到默认项目 */
  projectId?: string;
  idea?: string;
  script: Script;
}

function parseContent(row: ScriptRow): Script {
  try {
    return JSON.parse(row.content) as Script;
  } catch {
    return { title: row.title, logline: '', style: row.style, characters: [], shots: [] };
  }
}

function toStored(row: ScriptRow): StoredScript {
  return {
    id: row.id,
    projectId: row.project_id || DEFAULT_PROJECT_ID,
    idea: row.idea ?? '',
    title: row.title,
    style: row.style,
    script: parseContent(row),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export async function saveScript(input: SaveScriptInput): Promise<StoredScript> {
  const pool = await getDb();
  const now = Date.now();
  const id = input.id?.trim() || crypto.randomUUID();
  const idea = clip(input.idea?.trim(), MAX_IDEA);
  const title = clip(input.script.title, MAX_TITLE);
  const style = clip(input.script.style, MAX_STYLE);
  /** 入库与返回值共用同一份剧本，保证两边一致 */
  const script: Script = { ...input.script, title, style };

  const userId = await currentUserId();

  const [existingRows] = await pool.query(
    'SELECT created_at, project_id FROM scripts WHERE id = ? AND user_id = ? LIMIT 1',
    [id, userId],
  );
  const existing = (existingRows as { created_at: number | string; project_id: string | null }[])[0];
  const createdAt = existing ? Number(existing.created_at) : now;
  const projectId = input.projectId?.trim() || existing?.project_id || DEFAULT_PROJECT_ID;

  await pool.query(
    `INSERT INTO scripts (id, user_id, project_id, idea, title, style, content, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       project_id = VALUES(project_id),
       idea       = VALUES(idea),
       title      = VALUES(title),
       style      = VALUES(style),
       content    = VALUES(content),
       updated_at = VALUES(updated_at)`,
    [
      id,
      userId,
      projectId,
      idea,
      title,
      style,
      JSON.stringify(script),
      createdAt,
      now,
    ],
  );

  // 只裁剪当前用户自己的剧本
  await pool.query(
    `DELETE FROM scripts
     WHERE user_id = ?
       AND id NOT IN (
         SELECT id FROM (
           SELECT id FROM scripts WHERE user_id = ? ORDER BY updated_at DESC LIMIT ${MAX_SCRIPTS}
         ) AS keep
       )`,
    [userId, userId],
  );

  return {
    id,
    projectId,
    idea,
    title,
    style,
    script,
    createdAt,
    updatedAt: now,
  };
}

export async function getScript(id: string): Promise<StoredScript | null> {
  const pool = await getDb();
  const userId = await currentUserId();
  const [rows] = await pool.query(
    'SELECT * FROM scripts WHERE id = ? AND user_id = ? LIMIT 1',
    [id, userId],
  );
  const row = (rows as ScriptRow[])[0];
  return row ? toStored(row) : null;
}

export async function getLatestScript(projectId?: string): Promise<StoredScript | null> {
  const pool = await getDb();
  const userId = await currentUserId();
  const [rows] = projectId
    ? await pool.query(
        'SELECT * FROM scripts WHERE user_id = ? AND project_id = ? ORDER BY updated_at DESC LIMIT 1',
        [userId, projectId],
      )
    : await pool.query(
        'SELECT * FROM scripts WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1',
        [userId],
      );
  const row = (rows as ScriptRow[])[0];
  return row ? toStored(row) : null;
}

export async function listScripts(limit = 20, projectId?: string): Promise<StoredScriptSummary[]> {
  const pool = await getDb();
  const userId = await currentUserId();
  const safeLimit = Math.min(Math.max(Math.trunc(limit) || 20, 1), 100);
  const [rows] = projectId
    ? await pool.query(
        `SELECT * FROM scripts WHERE user_id = ? AND project_id = ?
         ORDER BY updated_at DESC LIMIT ${safeLimit}`,
        [userId, projectId],
      )
    : await pool.query(
        `SELECT * FROM scripts WHERE user_id = ? ORDER BY updated_at DESC LIMIT ${safeLimit}`,
        [userId],
      );

  return (rows as ScriptRow[]).map((row) => ({
    id: row.id,
    idea: row.idea ?? '',
    title: row.title,
    style: row.style,
    shotCount: parseContent(row).shots?.length ?? 0,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }));
}

export async function deleteScript(id: string): Promise<boolean> {
  const pool = await getDb();
  const userId = await currentUserId();
  const [result] = await pool.query('DELETE FROM scripts WHERE id = ? AND user_id = ?', [
    id,
    userId,
  ]);
  return (result as ResultSetHeader).affectedRows > 0;
}

/** 某个项目下的剧本数量，用于「至少保留一份」的约束 */
export async function countScripts(projectId: string): Promise<number> {
  const pool = await getDb();
  const userId = await currentUserId();
  const [rows] = await pool.query(
    'SELECT COUNT(*) AS total FROM scripts WHERE project_id = ? AND user_id = ?',
    [projectId, userId],
  );
  return Number((rows as { total: number | string }[])[0]?.total ?? 0);
}
