import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** 极简 .env 读取（不依赖 dotenv），process.env 优先 */
export function readEnv() {
  const result = {};

  for (const file of ['.env.local', '.env']) {
    const full = path.join(process.cwd(), file);
    if (!existsSync(full)) continue;

    for (const line of readFileSync(full, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;

      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      result[key] = value;
    }
  }

  return { ...result, ...process.env };
}

export function databaseUrl(env = readEnv()) {
  return (env.DATABASE_URL || '').trim() || 'mysql://root@127.0.0.1:3306/ai_video';
}

export function parseDatabaseUrl(raw) {
  const url = new URL(raw);
  const database = url.pathname.replace(/^\//, '');
  return {
    host: url.hostname || '127.0.0.1',
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username || 'root'),
    password: decodeURIComponent(url.password || ''),
    database,
  };
}
