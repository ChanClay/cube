import { NextResponse } from 'next/server';
import { config } from '@/lib/config';
import { generateScript } from '@/lib/agents/storyboard';
import { MAX_NOVEL_CHARS, MIN_NOVEL_CHARS } from '@/lib/shot-plan';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: '请求体必须是合法 JSON' }, { status: 400 });
  }

  const payload = (body ?? {}) as Record<string, unknown>;
  const idea = typeof payload.idea === 'string' ? payload.idea.trim() : '';
  /** 缺省仍按短创意处理，保持老调用方行为 */
  const source = payload.source === 'novel' ? 'novel' : 'idea';

  if (source === 'novel') {
    if (idea.length < MIN_NOVEL_CHARS) {
      return NextResponse.json(
        { error: `小说片段至少 ${MIN_NOVEL_CHARS} 字，太短请直接当故事创意写` },
        { status: 400 },
      );
    }
    if (idea.length > MAX_NOVEL_CHARS) {
      return NextResponse.json(
        { error: `单次改编最多 ${MAX_NOVEL_CHARS} 字，请先选一章或分段生成` },
        { status: 400 },
      );
    }
  } else if (idea.length < 4) {
    return NextResponse.json({ error: '请至少输入 4 个字的创意描述' }, { status: 400 });
  }

  const style = typeof payload.style === 'string' ? payload.style.trim() : '';
  const shotCount = Number(payload.shotCount);
  const duration = Number(payload.duration);
  /** 缺省仍是「按镜头数」，保持老调用方的行为 */
  const mode = payload.mode === 'duration' ? 'duration' : 'shots';
  /** 默认开启：镜头少一点、每镜凑满 30 秒，故事更完整 */
  const ensureCompleteness = payload.ensureCompleteness !== false;

  try {
    const result = await generateScript({
      idea,
      source,
      style,
      mode,
      shotCount: Number.isFinite(shotCount) ? shotCount : undefined,
      duration: Number.isFinite(duration) ? duration : undefined,
      ensureCompleteness,
    });
    return NextResponse.json({
      script: result.script,
      meta: { model: config.llm.model, adaptedIdea: result.adaptedIdea },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes('未配置 LLM_API_KEY') ? 400 : 502;
    return NextResponse.json({ error: message }, { status });
  }
}
