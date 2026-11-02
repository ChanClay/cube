'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, type AuthUser, type HealthInfo } from '@/lib/client';

const PROVIDER_LABEL: Record<string, string> = {
  wan: '通义万相 Wan3.0',
};

export const Logo = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9.5 8.6v6.8l5.8-3.4z" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="9" />
  </svg>
);

interface Props {
  health: HealthInfo | null;
  /** 品牌右侧的额外内容，例如项目名 */
  children?: ReactNode;
  /** 品牌是否链回项目列表 */
  homeLink?: boolean;
}

export default function TopBar({ health, children, homeLink = false }: Props) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    let alive = true;
    api.auth
      .me()
      .then((state) => {
        if (alive) setUser(state.user);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const signOut = useCallback(async () => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await api.auth.logout();
    } catch {
      // 会话可能已在服务端失效，照样回登录页
    }
    // 整页跳转，顺手清掉内存里的项目 / 剧本状态
    window.location.href = '/login';
  }, [signingOut]);

  const llmPillClass = !health ? '' : health.llm.configured ? 'pill--ok' : 'pill--off';
  const videoPillClass = !health ? '' : health.video.configured ? 'pill--ok' : 'pill--off';

  const brand = (
    <span className="brand">
      <span className="brand-mark">
        <Logo />
      </span>
      <span className="brand-text">
        <strong>Cube</strong>
        <span>Mirror of Dreams</span>
      </span>
    </span>
  );

  return (
    <header className="topbar">
      <div className="topbar-left">
        {homeLink ? (
          <Link href="/" className="brand-link" title="返回项目列表">
            {brand}
          </Link>
        ) : (
          brand
        )}
        {children}
      </div>

      <div className="topbar-meta">
        <span className={`pill ${llmPillClass}`} title={health?.llm.baseUrl}>
          <span className="dot" />
          剧本 <b>{health ? (health.llm.configured ? health.llm.model : '未配置 Key') : '检测中'}</b>
        </span>
        <span className={`pill ${videoPillClass}`}>
          <span className="dot" />
          视频{' '}
          <b>
            {health
              ? (PROVIDER_LABEL[health.video.provider] ?? health.video.provider)
              : '检测中'}
          </b>
        </span>

        {user && (
          <span className="user-chip" title={`已登录：${user.username}`}>
            <span className="user-avatar">{user.username.slice(0, 1).toUpperCase()}</span>
            <span className="user-name">{user.username}</span>
          </span>
        )}

        <button
          className="btn btn--ghost btn--sm"
          onClick={signOut}
          disabled={signingOut}
          title="退出登录"
        >
          {signingOut ? <span className="spinner" /> : null}
          退出
        </button>
      </div>
    </header>
  );
}
