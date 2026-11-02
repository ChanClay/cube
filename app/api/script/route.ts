import { NextResponse } from 'next/server';
import { config } from '@/lib/config';
import { generateScript } from '@/lib/agents/storyboard';

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
  if (idea.length < 4) {
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
    const script = await generateScript({
      idea,
      style,
      mode,
      shotCount: Number.isFinite(shotCount) ? shotCount : undefined,
      duration: Number.isFinite(duration) ? duration : undefined,
      ensureCompleteness,
    });
    return NextResponse.json({ script, meta: { model: config.llm.model } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes('未配置 LLM_API_KEY') ? 400 : 502;
    return NextResponse.json({ error: message }, { status });
  }
}
