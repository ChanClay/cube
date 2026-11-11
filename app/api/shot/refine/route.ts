import { NextResponse } from 'next/server';
import { config } from '@/lib/config';
import { logAgentWarn } from '@/lib/logger';
import { callChatJson } from '@/lib/agents/llm';
import {
  normalizeBeatSheet,
  normalizeCameraMove,
  normalizeShotSize,
  SHOT_LANGUAGE_RULES,
  str,
  TIMELINE_RULES,
  trimNarration,
  VIDEO_PROMPT_RULES,
} from '@/lib/agents/spec';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

function buildSystemPrompt(): string {
  return `你是一位资深 AI 分镜师。用户已经手动改写了某个镜头的「画面描述」，你需要据此重新产出这一镜的结构化分镜信息。

要求：
1. ${VIDEO_PROMPT_RULES}
2. videoPrompt 的唯一依据是用户改好的「画面描述」：描述里写到的主体、动作、道具、环境、光线逐项翻进英文；描述里没有的元素一个都不许加。
3. description 不需要你重写（用户已经改好），不要返回它。
4. ${SHOT_LANGUAGE_RULES}
5. 若提供了角色表，本镜出镜角色的外貌必须与角色表一致；视频提示词里沿用角色表已有的英文外貌短语，不要自行改写年龄、发型、服装、装甲与涂装、道具。
6. 若提供了相邻镜头，本镜的动作要能接住上一镜、并给下一镜留出衔接空间；避免与相邻镜头重复同一构图。若给出了「上一镜末帧里实际在场的人物」，本镜开头的人物必须与这份名单完全一致，不许增删；需要新角色出场时，写成在这一镜的过程里走进画面，而不是一开始就站在那里。
7. narration 是这一镜的旁白或台词，可为空字符串（不要写"旁白："前缀）。
8. 若是画面里的角色开口说话，speaker 必须是角色表里的名字；旁白或没有台词时 speaker 留空。
9. title 是这一镜的小标题，4~8 个字。
10. ${TIMELINE_RULES}
11. 只输出一个 JSON 对象，不要解释文字、不要 markdown 代码块。

JSON 结构：
{
  "title": "镜头小标题",
  "shotSize": "中景",
  "cameraMove": "缓慢推近",
  "videoPrompt": "English prompt for the text-to-video model",
  "narration": "旁白或台词",
  "speaker": "说话的角色名，旁白留空",
  "beatSheet": [{ "from": 0, "to": 2, "action": "这一段里发生的可见动作" }]
}`;
}

function buildUserPrompt(input: {
  description: string;
  title: string;
  style: string;
  duration: number;
  before: string;
  after: string;
  prevCast: string[];
  prevExitState: string;
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

  /**
   * 末帧是像素，只给「画面描述」模型并不知道图里站的是谁，于是会凭空多出
   * 名单以外的人。这里把名单当成硬事实喂进去，并说明它会作为参考图一起提交。
   */
  if (input.prevCast.length > 0) {
    lines.push(
      '',
      `上一镜末帧里实际在场的人物：${input.prevCast.join('、')}`,
      '本镜会带上这张末帧作为参考图。提示词里指代这些人时必须使用上面的名字；' +
        '这份名单就是本镜开头画面里允许出现的人物，不许增删——需要新角色时写成在这一镜过程中进入画面。',
    );
  }
  if (input.prevExitState) {
    lines.push(`上一镜的结尾状态（本镜从这里接着演）：${input.prevExitState}`);
  }

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

/** 末帧在场人物：只取非空名字 */
function parseCast(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => str(item)).filter(Boolean).slice(0, 8);
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
    prevCast: parseCast(payload.prevCast),
    prevExitState: str(payload.prevExitState),
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
    const videoPrompt = str(obj.videoPrompt);

    if (!videoPrompt) {
      return NextResponse.json({ error: '模型没有返回视频提示词，请重试' }, { status: 502 });
    }

    return NextResponse.json({
      shot: {
        title: str(obj.title),
        shotSize: normalizeShotSize(obj.shotSize),
        cameraMove: normalizeCameraMove(obj.cameraMove),
        videoPrompt,
        narration: trimNarration(obj.narration, input.duration),
        speaker: str(obj.speaker) || undefined,
        beatSheet: normalizeBeatSheet(obj.beatSheet, input.duration),
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
