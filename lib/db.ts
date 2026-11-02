import mysql, { type Pool } from 'mysql2/promise';

/**
 * 本地 MySQL 存储
 * 连接串通过 DATABASE_URL 配置，例如：
 *   mysql://root:password@127.0.0.1:3306/ai_video
 * 首次连接会自动创建数据库与数据表。
 */

const DEFAULT_URL = 'mysql://root@127.0.0.1:3306/ai_video';

export function databaseUrl(): string {
  return (process.env.DATABASE_URL ?? '').trim() || DEFAULT_URL;
}

function parseDatabaseUrl(raw: string) {
  const url = new URL(raw);
  const database = url.pathname.replace(/^\//, '');
  if (!database) throw new Error('DATABASE_URL 缺少数据库名，例如 mysql://root:密码@127.0.0.1:3306/ai_video');
  if (!/^[A-Za-z0-9_]+$/.test(database)) {
    throw new Error(`数据库名不合法：${database}（只允许字母、数字、下划线）`);
  }

  return {
    host: url.hostname || '127.0.0.1',
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username || 'root'),
    password: decodeURIComponent(url.password || ''),
    database,
  };
}

export function databaseInfo(): { driver: string; host: string; database: string } {
  try {
    const { host, port, database } = parseDatabaseUrl(databaseUrl());
    return { driver: 'mysql', host: `${host}:${port}`, database };
  } catch {
    return { driver: 'mysql', host: 'unknown', database: 'unknown' };
  }
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id            VARCHAR(64)  NOT NULL PRIMARY KEY,
    username      VARCHAR(64)  NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    created_at    BIGINT       NOT NULL,
    updated_at    BIGINT       NOT NULL,
    UNIQUE KEY uniq_users_username (username)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token      VARCHAR(64)  NOT NULL PRIMARY KEY,
    user_id    VARCHAR(64)  NOT NULL,
    created_at BIGINT       NOT NULL,
    expires_at BIGINT       NOT NULL,
    INDEX idx_sessions_user (user_id),
    INDEX idx_sessions_expires (expires_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS video_jobs (
    id              VARCHAR(64)  NOT NULL PRIMARY KEY,
    user_id         VARCHAR(64)  NULL,
    shot_id         VARCHAR(64)  NOT NULL,
    provider        VARCHAR(32)  NOT NULL,
    provider_job_id VARCHAR(191) NULL,
    status          VARCHAR(16)  NOT NULL,
    progress        INT          NULL,
    video_url       TEXT         NULL,
    error           TEXT         NULL,
    prompt          TEXT         NOT NULL,
    duration        DOUBLE       NOT NULL,
    resolution      VARCHAR(32)  NOT NULL,
    media_json      TEXT         NULL,
    created_at      BIGINT       NOT NULL,
    updated_at      BIGINT       NOT NULL,
    INDEX idx_jobs_shot_id (shot_id),
    INDEX idx_jobs_created_at (created_at),
    INDEX idx_jobs_status (status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS projects (
    id          VARCHAR(64)  NOT NULL PRIMARY KEY,
    user_id     VARCHAR(64)  NULL,
    name        VARCHAR(255) NOT NULL DEFAULT '',
    description TEXT         NULL,
    media_json  LONGTEXT     NULL,
    groups_json LONGTEXT     NULL,
    created_at  BIGINT       NOT NULL,
    updated_at  BIGINT       NOT NULL,
    INDEX idx_projects_updated_at (updated_at),
    INDEX idx_projects_user (user_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS scripts (
    id         VARCHAR(64)  NOT NULL PRIMARY KEY,
    user_id    VARCHAR(64)  NULL,
    project_id VARCHAR(64)  NULL,
    idea       TEXT         NULL,
    title      VARCHAR(255) NOT NULL DEFAULT '',
    style      VARCHAR(255) NOT NULL DEFAULT '',
    content    LONGTEXT     NOT NULL,
    created_at BIGINT       NOT NULL,
    updated_at BIGINT       NOT NULL,
    INDEX idx_scripts_updated_at (updated_at),
    INDEX idx_scripts_project_id (project_id),
    INDEX idx_scripts_user (user_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];

/** 历史剧本自动归入的默认项目 */
export const DEFAULT_PROJECT_ID = 'default';
const DEFAULT_PROJECT_NAME = '默认项目';

/** 旧的扁平素材库 → 「未分组素材」文件夹 */
async function migrateProjectGroups(pool: Pool): Promise<void> {
  const [rows] = await pool.query(
    `SELECT id, media_json FROM projects
     WHERE groups_json IS NULL AND media_json IS NOT NULL AND media_json NOT IN ('', '[]')`,
  );

  for (const row of rows as { id: string; media_json: string | null }[]) {
    let media: unknown = null;
    try {
      media = JSON.parse(row.media_json ?? '[]');
    } catch {
      media = null;
    }

    if (!Array.isArray(media) || media.length === 0) {
      await pool.query('UPDATE projects SET groups_json = ? WHERE id = ?', ['[]', row.id]);
      continue;
    }

    const group = {
      id: crypto.randomUUID(),
      name: '未分组素材',
      kind: 'other',
      aliases: [],
      media,
      createdAt: Date.now(),
    };
    await pool.query('UPDATE projects SET groups_json = ? WHERE id = ?', [
      JSON.stringify([group]),
      row.id,
    ]);
  }

  // 其余没有素材的项目直接补空数组，避免每次启动重复扫描
  await pool.query('UPDATE projects SET groups_json = ? WHERE groups_json IS NULL', ['[]']);
}

/** 旧库升级：补列、补索引、把没有归属的剧本收进默认项目 */
async function migrate(pool: Pool): Promise<void> {
  const ensureColumn = async (sql: string) => {
    try {
      await pool.query(sql);
    } catch (err) {
      if ((err as { code?: string }).code !== 'ER_DUP_FIELDNAME') throw err;
    }
  };

  // 模型返回的「整体视觉风格」是一句描述，旧库 style 只有 VARCHAR(64)，超长会保存失败
  const [styleCols] = await pool.query(
    `SELECT CHARACTER_MAXIMUM_LENGTH AS len
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'scripts' AND COLUMN_NAME = 'style'`,
  );
  const styleLen = Number(
    (styleCols as { len: number | string | null }[])[0]?.len ?? 0,
  );
  if (styleLen > 0 && styleLen < 255) {
    await pool.query("ALTER TABLE scripts MODIFY COLUMN style VARCHAR(255) NOT NULL DEFAULT ''");
  }

  await ensureColumn('ALTER TABLE scripts ADD COLUMN project_id VARCHAR(64) NULL AFTER id');
  await ensureColumn(
    'ALTER TABLE video_jobs ADD COLUMN media_json TEXT NULL AFTER resolution',
  );
  await ensureColumn('ALTER TABLE projects ADD COLUMN groups_json LONGTEXT NULL AFTER media_json');

  // 账号系统：三张业务表都挂上归属，旧数据先留 NULL，由第一个注册账号接管
  await ensureColumn('ALTER TABLE projects ADD COLUMN user_id VARCHAR(64) NULL AFTER id');
  await ensureColumn('ALTER TABLE scripts ADD COLUMN user_id VARCHAR(64) NULL AFTER id');
  await ensureColumn('ALTER TABLE video_jobs ADD COLUMN user_id VARCHAR(64) NULL AFTER id');

  await migrateProjectGroups(pool);

  const ensureIndex = async (sql: string) => {
    try {
      await pool.query(sql);
    } catch (err) {
      if ((err as { code?: string }).code !== 'ER_DUP_KEYNAME') throw err;
    }
  };

  await ensureIndex('CREATE INDEX idx_scripts_project_id ON scripts (project_id)');
  await ensureIndex('CREATE INDEX idx_projects_user ON projects (user_id)');
  await ensureIndex('CREATE INDEX idx_scripts_user ON scripts (user_id)');
  await ensureIndex('CREATE INDEX idx_jobs_user ON video_jobs (user_id)');

  const [rows] = await pool.query('SELECT COUNT(*) AS total FROM scripts WHERE project_id IS NULL');
  const orphan = Number((rows as { total: number }[])[0]?.total ?? 0);
  if (orphan === 0) return;

  const now = Date.now();
  await pool.query(
    `INSERT INTO projects (id, name, description, media_json, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, ?)
     ON DUPLICATE KEY UPDATE updated_at = VALUES(updated_at)`,
    [DEFAULT_PROJECT_ID, DEFAULT_PROJECT_NAME, '历史剧本自动归入', now, now],
  );
  await pool.query('UPDATE scripts SET project_id = ? WHERE project_id IS NULL', [DEFAULT_PROJECT_ID]);
}

async function init(): Promise<Pool> {
  const target = parseDatabaseUrl(databaseUrl());

  // 1. 先确保数据库存在（用不指定 database 的连接）
  const admin = await mysql.createConnection({
    host: target.host,
    port: target.port,
    user: target.user,
    password: target.password,
  });
  try {
    await admin.query(
      `CREATE DATABASE IF NOT EXISTS \`${target.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
  } finally {
    await admin.end();
  }

  // 2. 连接池 + 建表
  const pool = mysql.createPool({
    ...target,
    waitForConnections: true,
    connectionLimit: 10,
    charset: 'utf8mb4',
    supportBigNumbers: true,
    timezone: 'Z',
  });

  for (const statement of SCHEMA) {
    await pool.query(statement);
  }

  await migrate(pool);

  return pool;
}

type DbGlobal = { __avMysqlPool?: Promise<Pool> };

const g = globalThis as unknown as DbGlobal;

/** 连接池单例（dev 热更新时复用，避免重复建连接） */
export function getDb(): Promise<Pool> {
  if (!g.__avMysqlPool) {
    g.__avMysqlPool = init().catch((err) => {
      g.__avMysqlPool = undefined;
      throw err;
    });
  }
  return g.__avMysqlPool;
}
