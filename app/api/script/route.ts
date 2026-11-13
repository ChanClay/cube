import { NextResponse } from 'next/server';
import { config } from '@/lib/config';
import { generateScript } from '@/lib/agents/storyboard';
import { currentUserId } from '@/lib/services/auth';
import { submitLockKey, withSubmitLock } from '@/lib/services/submit-lock';
import { MAX_NOVEL_CHARS, MIN_NOVEL_CHARS } from '@/lib/skills/shot-plan';
import { normalizeVideoModel } from '@/lib/video-models';

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
  /** 创建剧本时选定的视频模型；老客户端没传时按旧剧本的 wan3.0 处理 */
  const videoModel = normalizeVideoModel(payload.videoModel);

  try {
    /**
     * 提交锁：同一份创意 + 同一套参数同时只允许一个生成请求。
     * 双击、两个标签页、浏览器重试都会打到这个接口，剧本生成是 token 计费，
     * 重复进入等于把整条链路（规划 / 分镜 / 翻译 / 审片）跑两遍。
     * 上一次结束之后再提交仍然放行，不挡主动重试。
     */
    const userId = await currentUserId();
    const lockKey = submitLockKey('script', [
      userId,
      source,
      idea,
      style,
      mode,
      Number.isFinite(shotCount) ? shotCount : '',
      Number.isFinite(duration) ? duration : '',
      videoModel,
    ]);
    const result = await withSubmitLock(lockKey, () =>
      generateScript({
        idea,
        source,
        style,
        mode,
        shotCount: Number.isFinite(shotCount) ? shotCount : undefined,
        duration: Number.isFinite(duration) ? duration : undefined,
        videoModel,
      }),
    );

    if (!result) {
      return NextResponse.json(
        { error: '同一份创意正在生成中，请稍候（重复提交不会重复扣费）' },
        { status: 409 },
      );
    }

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
