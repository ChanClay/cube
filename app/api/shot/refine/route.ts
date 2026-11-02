import { NextResponse } from 'next/server';
import { config } from '@/lib/config';
import { logAgentWarn } from '@/lib/logger';
import { callChatJson } from '@/lib/agents/llm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const SHOT_SIZES = ['特写', '近景', '中景', '全景', '远景', '大远景'];
const CAMERA_MOVES = [
  '固定机位',
  '缓慢推近',
  '缓慢拉远',
  '横向移动',
  '环绕',
  '跟随',
  '手持晃动',
  '升格慢动作',
];

const str = (v: unknown, fallback = ''): string =>
  typeof v === 'string' && v.trim() ? v.trim() : fallback;

function buildSystemPrompt(): string {
  return `你是一位资深 AI 分镜师。用户已经手动改写了某个镜头的「画面描述」，你需要据此重新产出这一镜的结构化分镜信息。

要求：
1. videoPrompt 必须是英文提示词，40~90 个单词，按顺序描述：镜头主体 + 具体动作 + 环境与背景 + 光线与色调 + 景别与运镜 + 画面风格。画面要具体、可拍摄、有电影感。
   - 禁止出现字幕、文字、水印、logo、分屏；
   - 禁止出现 "shot 1"、"scene 2" 这类结构性词语；
   - 角色外貌用简短且固定的英文短语，避免和上下镜冲突。
2. description 不需要你重写（用户已经改好），不要返回它。
3. shotSize 用中文景别（特写/近景/中景/全景/远景/大远景）；cameraMove 用中文运镜（固定机位/缓慢推近/缓慢拉远/横向移动/环绕/跟随/手持晃动/升格慢动作）。
4. 若提供了角色表，本镜出镜角色的外貌必须与角色表一致；视频提示词里沿用角色表已有的英文外貌短语，不要自行改写年龄、发型、服装与道具。
5. 若提供了相邻镜头，本镜的动作要能接住上一镜、并给下一镜留出衔接空间；避免与相邻镜头重复同一构图。
6. narration 是这一镜的旁白或台词，可为空字符串（不要写"旁白："前缀）。
7. title 是这一镜的小标题，4~8 个字。
8. 只输出一个 JSON 对象，不要解释文字、不要 markdown 代码块。

JSON 结构：
{
  "title": "镜头小标题",
  "shotSize": "中景",
  "cameraMove": "缓慢推近",
  "videoPrompt": "English prompt for the text-to-video model",
  "narration": "旁白或台词"
}`;
}

function buildUserPrompt(input: {
  description: string;
  title: string;
  style: string;
  duration: number;
  before: string;
  after: string;
  characters: { name: string; desc: string }[];
}): string {
  const lines = [
    `整体视觉风格：${input.style || '电影感写实'}`,
    `镜头时长：${input.duration} 秒`,
    `当前小标题：${input.title || '（未命名）'}`,
  ];

  if (input.characters.length > 0) {
    lines.push('', '角色表（出镜角色外形必须与此一致）：');
    for (const character of input.characters) {
      lines.push(`- ${character.name}：${character.desc}`);
    }
  }

  lines.push('', '修改后的画面描述（必须严格照此生成）：', input.description);

  if (input.before) lines.push('', `上一镜的画面描述（用于承接）：${input.before}`);
  if (input.after) lines.push('', `下一镜的画面描述（用于衔接）：${input.after}`);

  lines.push('', '请输出这一镜的分镜信息 JSON。');
  return lines.join('\n');
}

/** 角色表：只取名字与外形，空名字丢弃 */
function parseCharacters(raw: unknown): { name: string; desc: string }[] {
  if (!Array.isArray(raw)) return [];
  const result: { name: string; desc: string }[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const name = str(record.name);
    if (!name) continue;
    result.push({ name, desc: str(record.desc) });
    if (result.length >= 8) break;
  }
  return result;
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: '请求体必须是合法 JSON' }, { status: 400 });
  }

  const payload = (body ?? {}) as Record<string, unknown>;
  const description = str(payload.description);
  if (description.length < 2) {
    return NextResponse.json({ error: '请先填写画面描述' }, { status: 400 });
  }

  const durationRaw = Number(payload.duration);
  const input = {
    description,
    title: str(payload.title),
    style: str(payload.style, '电影感写实'),
    duration: Number.isFinite(durationRaw) && durationRaw > 0 ? durationRaw : 5,
    before: str(payload.before),
    after: str(payload.after),
    characters: parseCharacters(payload.characters),
  };

  try {
    const raw = await callChatJson({
      system: buildSystemPrompt(),
      user: buildUserPrompt(input),
      temperature: 0.7,
      // 思考型模型的 reasoning 也占 max_tokens，这里不要卡小预算
      maxTokens: config.llm.maxTokens,
      timeoutMs: Math.min(config.llm.timeoutMs, 90_000),
    });

    const obj = (raw ?? {}) as Record<string, unknown>;
    const shotSize = str(obj.shotSize, '中景');
    const cameraMove = str(obj.cameraMove, '固定机位');
    const videoPrompt = str(obj.videoPrompt);

    if (!videoPrompt) {
      return NextResponse.json({ error: '模型没有返回视频提示词，请重试' }, { status: 502 });
    }

    return NextResponse.json({
      shot: {
        title: str(obj.title),
        shotSize: SHOT_SIZES.includes(shotSize) ? shotSize : '中景',
        cameraMove: CAMERA_MOVES.includes(cameraMove) ? cameraMove : '固定机位',
        videoPrompt,
        narration: str(obj.narration),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    void logAgentWarn('script', {
      reason: '重新生成分镜信息失败',
      description: description.slice(0, 80),
      error: message,
    });
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
