import { NextResponse } from 'next/server';
import { getJob, updateJob } from '@/lib/services/store';
import { syncVideoJob } from '@/lib/services/video-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const job = await getJob(id);
  if (!job) {
    return NextResponse.json({ error: '任务不存在' }, { status: 404 });
  }

  const synced = await syncVideoJob(job);
  return NextResponse.json({ job: synced });
}

/**
 * 放弃本镜：把任务标记成 canceled，此后不再回查 provider。
 * 视频模型的异步任务没有取消接口，云端那条任务仍会跑完（费用照常），
 * 只是结果不再回收——所以这里只做本地状态收敛，不去动 provider。
 */
export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const job = await getJob(id);
  if (!job) {
    return NextResponse.json({ error: '任务不存在' }, { status: 404 });
  }

  if (job.status !== 'queued' && job.status !== 'running') {
    return NextResponse.json({ error: '这个任务已经结束，不需要放弃' }, { status: 409 });
  }

  const updated = await updateJob(id, {
    status: 'canceled',
    error: '已放弃本镜（云端任务仍会跑完，结果不再回收）',
    progress: null,
  });

  return NextResponse.json({ job: updated });
}
