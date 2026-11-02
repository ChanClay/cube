import mysql from 'mysql2/promise';
import { databaseUrl, parseDatabaseUrl } from './env.mjs';

const target = parseDatabaseUrl(databaseUrl());

try {
  const conn = await mysql.createConnection({ ...target, charset: 'utf8mb4' });
  const [rows] = await conn.query(
    `SELECT 'video_jobs' AS t, COUNT(*) AS c FROM video_jobs
     UNION ALL SELECT 'scripts', COUNT(*) FROM scripts`,
  );

  console.log('表             条数');
  for (const row of rows) {
    console.log(String(row.t).padEnd(15), row.c);
  }
  console.log(`连接：${target.host}:${target.port} / ${target.database}`);
  await conn.end();
} catch (err) {
  console.error(`连接 MySQL 失败：${err.message}`);
  console.error('请检查 .env.local 中的 DATABASE_URL，例如：');
  console.error('  DATABASE_URL=mysql://root:你的密码@127.0.0.1:3306/ai_video');
  process.exit(1);
}
