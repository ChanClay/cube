import { existsSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import mysql from 'mysql2/promise';
import { databaseUrl, parseDatabaseUrl } from './env.mjs';

/**
 * 把旧版 SQLite（.data/app.db）里的剧本与视频任务迁移到 MySQL。
 * 用法：node scripts/migrate-sqlite-to-mysql.mjs
 * 幂等：按主键 upsert，可重复执行。
 */

const SQLITE_PATH = path.join(process.cwd(), '.data', 'app.db');

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS video_jobs (
    id              VARCHAR(64)  NOT NULL PRIMARY KEY,
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
    created_at      BIGINT       NOT NULL,
    updated_at      BIGINT       NOT NULL,
    INDEX idx_jobs_shot_id (shot_id),
    INDEX idx_jobs_created_at (created_at),
    INDEX idx_jobs_status (status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS scripts (
    id         VARCHAR(64)  NOT NULL PRIMARY KEY,
    idea       TEXT         NULL,
    title      VARCHAR(255) NOT NULL DEFAULT '',
    style      VARCHAR(64)  NOT NULL DEFAULT '',
    content    LONGTEXT     NOT NULL,
    created_at BIGINT       NOT NULL,
    updated_at BIGINT       NOT NULL,
    INDEX idx_scripts_updated_at (updated_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];

if (!existsSync(SQLITE_PATH)) {
  console.log(`没有找到 ${SQLITE_PATH}，无需迁移`);
  process.exit(0);
}

const target = parseDatabaseUrl(databaseUrl());

// 1. 建库（不能指定 database，否则库不存在时会直接报错）
try {
  const { database: _db, ...adminTarget } = target;
  const admin = await mysql.createConnection(adminTarget);
  await admin.query(
    `CREATE DATABASE IF NOT EXISTS \`${target.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  );
  await admin.end();
} catch (err) {
  console.error(`连接 MySQL 失败：${err.message}`);
  console.error('请先在 .env.local 中配置：DATABASE_URL=mysql://用户:密码@127.0.0.1:3306/ai_video');
  process.exit(1);
}

// 2. 建表
const conn = await mysql.createConnection({ ...target, charset: 'utf8mb4' });
for (const statement of SCHEMA) {
  await conn.query(statement);
}

// 3. 读取 SQLite
const sqlite = new DatabaseSync(SQLITE_PATH, { readOnly: true });

function readTable(name) {
  try {
    return sqlite.prepare(`SELECT * FROM ${name}`).all();
  } catch {
    return [];
  }
}

const jobs = readTable('video_jobs');
const scripts = readTable('scripts');

// 4. 写入 MySQL
let jobsDone = 0;
for (const job of jobs) {
  await conn.query(
    `INSERT INTO video_jobs
       (id, shot_id, provider, provider_job_id, status, progress, video_url, error,
        prompt, duration, resolution, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       shot_id = VALUES(shot_id), provider = VALUES(provider),
       provider_job_id = VALUES(provider_job_id), status = VALUES(status),
       progress = VALUES(progress), video_url = VALUES(video_url), error = VALUES(error),
       prompt = VALUES(prompt), duration = VALUES(duration), resolution = VALUES(resolution),
       created_at = VALUES(created_at), updated_at = VALUES(updated_at)`,
    [
      job.id,
      job.shot_id,
      job.provider,
      job.provider_job_id ?? null,
      job.status,
      job.progress ?? null,
      job.video_url ?? null,
      job.error ?? null,
      job.prompt ?? '',
      Number(job.duration ?? 5),
      job.resolution ?? '720p',
      Number(job.created_at ?? Date.now()),
      Number(job.updated_at ?? Date.now()),
    ],
  );
  jobsDone += 1;
}

let scriptsDone = 0;
for (const script of scripts) {
  await conn.query(
    `INSERT INTO scripts (id, idea, title, style, content, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       idea = VALUES(idea), title = VALUES(title), style = VALUES(style),
       content = VALUES(content), created_at = VALUES(created_at), updated_at = VALUES(updated_at)`,
    [
      script.id,
      script.idea ?? '',
      script.title ?? '',
      script.style ?? '',
      script.content ?? '{}',
      Number(script.created_at ?? Date.now()),
      Number(script.updated_at ?? Date.now()),
    ],
  );
  scriptsDone += 1;
}

const [[counts]] = await conn.query(
  `SELECT (SELECT COUNT(*) FROM video_jobs) AS jobs, (SELECT COUNT(*) FROM scripts) AS scripts`,
);

sqlite.close();
await conn.end();

console.log(`迁移完成：video_jobs ${jobsDone} 条，scripts ${scriptsDone} 条`);
console.log(`MySQL 现有：video_jobs ${counts.jobs} 条，scripts ${counts.scripts} 条`);
console.log(`目标：${target.host}:${target.port} / ${target.database}`);
