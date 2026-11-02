import { NextResponse, type NextRequest } from 'next/server';

/**
 * 页面级登录门。
 *
 * 这里只判断「有没有会话 cookie」，真正的有效性校验在 API 层（查 sessions 表）。
 * middleware 跑在 edge runtime，连不了 MySQL；伪造的 cookie 只能看到页面骨架，
 * 所有数据请求都会 401 并被前端踢回 /login。
 */

const SESSION_COOKIE = 'cube_session';
const LOGIN_PATH = '/login';

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const hasSession = Boolean(request.cookies.get(SESSION_COOKIE)?.value);

  // API 不能重定向成 HTML，否则前端 JSON 解析会炸：统一回 401，让前端跳登录页。
  // 登录 / 注册 / 登出本身必须能在未登录状态下访问。
  if (pathname.startsWith('/api/')) {
    if (!hasSession && !pathname.startsWith('/api/auth/')) {
      return NextResponse.json({ error: '请先登录' }, { status: 401 });
    }
    return NextResponse.next();
  }

  if (!hasSession && pathname !== LOGIN_PATH) {
    const url = request.nextUrl.clone();
    url.pathname = LOGIN_PATH;
    // 带上原地址，登录成功后跳回去
    url.search = pathname === '/' ? '' : `?next=${encodeURIComponent(pathname)}`;
    return NextResponse.redirect(url);
  }

  // 「已登录还想进登录页」交给登录页自己判断：它查 /api/auth/me 才知道 cookie 是否还有效，
  // 这里只凭 cookie 存在就回跳会和失效会话的 401 兜底形成死循环。
  return NextResponse.next();
}

export const config = {
  // 排除 Next 的静态资源和图标，其余全部经过
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|ico|webp)$).*)'],
};
