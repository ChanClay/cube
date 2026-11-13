import { NextResponse } from 'next/server';
import { videoModelConnection } from '@/lib/config';
import { isVideoModelId, VIDEO_MODELS } from '@/lib/video-models';
import {
  defaultVideoModel,
  orderVideoModels,
  setDefaultVideoModel,
  setVideoModelOrder,
  videoModelOrder,
} from '@/lib/services/settings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 模型管理页的数据源：
 * - GET：只返回已在 env 配好 API Key 的视频模型（按用户自定义顺序排列），附默认模型
 * - POST：把某个已配置的模型设为新建剧本的默认模型
 * - PATCH：保存下拉框里的模型显示顺序
 */
async function configuredModels() {
  const configured = VIDEO_MODELS.filter((spec) => videoModelConnection(spec.provider).configured);
  return orderVideoModels(configured, await videoModelOrder());
}

export async function GET() {
  return NextResponse.json({ models: await configuredModels(), defaultModel: await defaultVideoModel() });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { modelId?: unknown } | null;

  if (!isVideoModelId(body?.modelId)) {
    return NextResponse.json({ error: 'modelId 不是合法的视频模型 ID' }, { status: 400 });
  }

  const spec = VIDEO_MODELS.find((model) => model.id === body.modelId);
  if (!spec || !videoModelConnection(spec.provider).configured) {
    return NextResponse.json(
      { error: '该模型还没在 .env.local 配置 API Key，不能设为默认' },
      { status: 400 },
    );
  }

  const defaultModel = await setDefaultVideoModel(spec.id);
  return NextResponse.json({ ok: true, defaultModel });
}

export async function PATCH(request: Request) {
  const body = (await request.json().catch(() => null)) as { modelIds?: unknown } | null;

  if (
    !Array.isArray(body?.modelIds) ||
    body.modelIds.length === 0 ||
    new Set(body.modelIds).size !== body.modelIds.length ||
    !body.modelIds.every(isVideoModelId)
  ) {
    return NextResponse.json(
      { error: 'modelIds 必须是不含重复的视频模型 ID 数组' },
      { status: 400 },
    );
  }

  await setVideoModelOrder(body.modelIds);
  return NextResponse.json({ ok: true, models: await configuredModels() });
}
