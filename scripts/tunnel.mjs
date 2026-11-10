#!/usr/bin/env node
/**
 * 起 cloudflared 快速隧道，并把分配到的公网地址自动写回 .env.local 的 PUBLIC_BASE_URL。
 *
 * 云端视频模型要靠这个地址回下载站内素材（/api/uploads/…），
 * 而 quick tunnel 每次启动都会换域名，手抄一次忘一次，所以交给脚本。
 *
 * 用法：
 *   node scripts/tunnel.mjs                      # 隧道指向 4500
 *   node scripts/tunnel.mjs 3000                 # 指定端口
 *   node scripts/tunnel.mjs --set https://x.trycloudflare.com   # 只改 env，不起隧道
 */
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ENV_FILE = path.join(process.cwd(), '.env.local');
const KEY = 'PUBLIC_BASE_URL';
/** quick tunnel 分配的域名形如 https://random-words-here.trycloudflare.com */
const URL_PATTERN = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i;

/** 写入 / 替换 .env.local 里的 PUBLIC_BASE_URL */
async function writePublicBaseUrl(rawUrl) {
  const url = rawUrl.replace(/\/+$/, '');
  let content = '';
  try {
    content = await readFile(ENV_FILE, 'utf8');
  } catch {
    content = '';
  }

  const pattern = new RegExp(`^${KEY}=.*$`, 'm');
  const next = pattern.test(content)
    ? content.replace(pattern, `${KEY}=${url}`)
    : `${content.replace(/\s*$/, '')}\n${KEY}=${url}\n`;

  await writeFile(ENV_FILE, next, 'utf8');
  return url;
}

function report(url) {
  console.log('');
  console.log(`✔ 隧道路径已生效：${url}`);
  console.log(`✔ 已写入 ${path.basename(ENV_FILE)}：${KEY}=${url}`);
  console.log('!  Next 只在启动时读取 env，请执行 make restart 让新地址生效');
  console.log('');
}

const args = process.argv.slice(2);

// 只改 env：方便手动设置（比如换成固定域名 / ngrok）
const setIndex = args.indexOf('--set');
if (setIndex !== -1) {
  const value = args[setIndex + 1];
  if (!value || !/^https?:\/\/\S+$/i.test(value)) {
    console.error('用法：node scripts/tunnel.mjs --set https://xxx.trycloudflare.com');
    process.exit(1);
  }
  const url = await writePublicBaseUrl(value);
  console.log(`已写入 ${path.basename(ENV_FILE)}：${KEY}=${url}`);
  console.log('Next 只在启动时读取 env，记得 make restart');
  process.exit(0);
}

const port = args.find((item) => /^\d+$/.test(item)) || process.env.PORT || '4500';

console.log(`→ 启动 cloudflared，隧道指向 http://localhost:${port}`);

const child = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${port}`], {
  stdio: ['ignore', 'pipe', 'pipe'],
});

child.on('error', (error) => {
  if (error.code === 'ENOENT') {
    console.error('找不到 cloudflared，先执行：brew install cloudflared');
  } else {
    console.error(`cloudflared 启动失败：${error.message}`);
  }
  process.exit(1);
});

let resolved = false;

/** cloudflared 的日志都走 stderr，stdout 也一并监听，避免版本差异导致漏抓 */
function handle(chunk, stream) {
  stream.write(chunk);
  if (resolved) return;

  const match = URL_PATTERN.exec(chunk.toString());
  if (!match) return;

  resolved = true;
  void writePublicBaseUrl(match[0])
    .then(report)
    .catch((error) => {
      console.error(`公网地址已分配（${match[0]}），但写入 .env.local 失败：${error.message}`);
      console.error(`请手动填入 PUBLIC_BASE_URL=${match[0]}`);
    });
}

child.stdout.on('data', (chunk) => handle(chunk, process.stdout));
child.stderr.on('data', (chunk) => handle(chunk, process.stderr));

// 隧道退出时把信号传下去，避免留下孤儿进程
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}

child.on('exit', (code) => process.exit(code ?? 0));
