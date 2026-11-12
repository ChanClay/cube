import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { cookies } from 'next/headers';
import type { ResultSetHeader } from 'mysql2';
import { getDb } from './db';

/**
 * 账号与会话。
 *
 * - 密码用 Node 内置 scrypt 加盐哈希，不引入 bcrypt
 * - 会话是服务端 sessions 表中的随机 token，写进 httpOnly cookie，可随时吊销
 * - 只允许注册第一个账号（本项目的单用户定位），之后的注册请求直接拒绝
 */

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: string,
  keylen: number,
) => Promise<Buffer>;

export const SESSION_COOKIE = 'cube_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SCRYPT_KEYLEN = 64;

const USERNAME_MIN = 2;
const USERNAME_MAX = 32;
const PASSWORD_MIN = 6;
const PASSWORD_MAX = 128;

export interface User {
  id: string;
  username: string;
  createdAt: number;
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status = 401,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

/* ---------- 密码 ---------- */

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const key = await scrypt(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt}$${key.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, salt, hex] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hex) return false;

  const key = await scrypt(password, salt, SCRYPT_KEYLEN);
  const expected = Buffer.from(hex, 'hex');
  // 长度不同时 timingSafeEqual 会抛错，先比长度
  if (key.length !== expected.length) return false;
  return timingSafeEqual(key, expected);
}

/* ---------- 用户 ---------- */

interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  created_at: number | string;
}

const toUser = (row: UserRow): User => ({
  id: row.id,
  username: row.username,
  createdAt: Number(row.created_at),
});

export function validateCredentials(username: string, password: string): string | null {
  const name = username.trim();
  if (name.length < USERNAME_MIN || name.length > USERNAME_MAX) {
    return `用户名需要 ${USERNAME_MIN}~${USERNAME_MAX} 个字符`;
  }
  if (/\s/.test(name)) return '用户名不能包含空格';
  if (password.length < PASSWORD_MIN) return `密码至少 ${PASSWORD_MIN} 位`;
  if (password.length > PASSWORD_MAX) return `密码最多 ${PASSWORD_MAX} 位`;
  return null;
}

export async function countUsers(): Promise<number> {
  const pool = await getDb();
  const [rows] = await pool.query('SELECT COUNT(*) AS total FROM users');
  return Number((rows as { total: number | string }[])[0]?.total ?? 0);
}

/** 注册入口只在库里还没有用户时开放 */
export async function registrationOpen(): Promise<boolean> {
  return (await countUsers()) === 0;
}

export async function findUserByUsername(
  username: string,
): Promise<(User & { passwordHash: string }) | null> {
  const pool = await getDb();
  const [rows] = await pool.query('SELECT * FROM users WHERE username = ? LIMIT 1', [
    username.trim(),
  ]);
  const row = (rows as UserRow[])[0];
  return row ? { ...toUser(row), passwordHash: row.password_hash } : null;
}

export async function findUserById(id: string): Promise<User | null> {
  const pool = await getDb();
  const [rows] = await pool.query('SELECT * FROM users WHERE id = ? LIMIT 1', [id]);
  const row = (rows as UserRow[])[0];
  return row ? toUser(row) : null;
}

/**
 * 首个账号注册：把登录前遗留的无主数据全部划到它名下。
 * 返回认领的项目数，方便前端提示。
 */
export async function claimOrphanData(userId: string): Promise<number> {
  const pool = await getDb();
  const [projects] = await pool.query(
    'UPDATE projects SET user_id = ? WHERE user_id IS NULL',
    [userId],
  );
  await pool.query('UPDATE scripts SET user_id = ? WHERE user_id IS NULL', [userId]);
  await pool.query('UPDATE video_jobs SET user_id = ? WHERE user_id IS NULL', [userId]);
  return (projects as ResultSetHeader).affectedRows ?? 0;
}

export async function createUser(username: string, password: string): Promise<User> {
  const pool = await getDb();
  const now = Date.now();
  const id = crypto.randomUUID();
  const passwordHash = await hashPassword(password);

  await pool.query(
    `INSERT INTO users (id, username, password_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
    [id, username.trim(), passwordHash, now, now],
  );

  return { id, username: username.trim(), createdAt: now };
}

/* ---------- 会话 ---------- */

export interface SessionInfo {
  token: string;
  expiresAt: number;
}

export async function createSession(userId: string): Promise<SessionInfo> {
  const pool = await getDb();
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  const token = randomBytes(32).toString('hex');

  // 顺手清掉过期的，避免表无限增长
  await pool.query('DELETE FROM sessions WHERE expires_at < ?', [now]);
  await pool.query(
    'INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
    [token, userId, now, expiresAt],
  );

  return { token, expiresAt };
}

export async function destroySession(token: string): Promise<void> {
  const pool = await getDb();
  await pool.query('DELETE FROM sessions WHERE token = ?', [token]);
}

/** token → userId，过期或不存在返回 null */
export async function userIdFromToken(token: string): Promise<string | null> {
  if (!token) return null;
  const pool = await getDb();
  const [rows] = await pool.query(
    'SELECT user_id, expires_at FROM sessions WHERE token = ? LIMIT 1',
    [token],
  );
  const row = (rows as { user_id: string; expires_at: number | string }[])[0];
  if (!row) return null;

  if (Number(row.expires_at) < Date.now()) {
    await destroySession(token);
    return null;
  }
  return row.user_id;
}

/* ---------- cookie ---------- */

export async function setSessionCookie(token: string, expiresAt: number): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    expires: new Date(expiresAt),
    // 本地 / 局域网是 http，强制 secure 会导致 cookie 根本存不下来
    secure: false,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 });
}

export async function readSessionCookie(): Promise<string | null> {
  const store = await cookies();
  return store.get(SESSION_COOKIE)?.value ?? null;
}

/* ---------- 当前用户 ---------- */

export async function getCurrentUser(): Promise<User | null> {
  const token = await readSessionCookie();
  if (!token) return null;

  const userId = await userIdFromToken(token);
  if (!userId) return null;

  return findUserById(userId);
}

/** 接口入口调用：没登录直接抛 401 */
export async function requireUser(): Promise<User> {
  const user = await getCurrentUser();
  if (!user) throw new AuthError('请先登录');
  return user;
}

/**
 * 数据层用：把「当前请求的用户」作为租户隔离依据。
 * 没登录就抛错，避免任何一个查询意外退化成查全表。
 */
export async function currentUserId(): Promise<string> {
  const token = await readSessionCookie();
  const userId = token ? await userIdFromToken(token) : null;
  if (!userId) throw new AuthError('请先登录');
  return userId;
}

/** 把 AuthError 翻成 HTTP 响应；不是 AuthError 返回 null */
export function authErrorResponse(err: unknown): Response | null {
  if (err instanceof AuthError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  return null;
}
