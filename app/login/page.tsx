'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Logo } from '@/components/TopBar';
import { api } from '@/lib/client';

/** 登录成功后回到 middleware 记下的原地址；只接受站内路径，避免开放跳转 */
function nextPath(): string {
  if (typeof window === 'undefined') return '/';
  const next = new URLSearchParams(window.location.search).get('next');
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

export default function LoginPage() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  const [registrationOpen, setRegistrationOpen] = useState(false);
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 已经登录（cookie 有效）就没必要看登录页
  useEffect(() => {
    let alive = true;

    api.auth
      .me()
      .then((state) => {
        if (!alive) return;
        if (state.user) {
          router.replace(nextPath());
          return;
        }
        setRegistrationOpen(state.registrationOpen);
        // 库里还没有账号时，默认就是注册
        setMode(state.registrationOpen ? 'register' : 'login');
        setChecking(false);
      })
      .catch((err) => {
        if (!alive) return;
        setError(err instanceof Error ? err.message : String(err));
        setChecking(false);
      });

    return () => {
      alive = false;
    };
  }, [router]);

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (busy) return;

      const name = username.trim();
      if (!name || !password) {
        setError('请输入用户名和密码');
        return;
      }

      setBusy(true);
      setError(null);

      try {
        if (mode === 'register') {
          await api.auth.register({ username: name, password });
        } else {
          await api.auth.login({ username: name, password });
        }
        // replace + refresh：让 middleware 和首屏数据都拿到新 cookie
        router.replace(nextPath());
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setBusy(false);
      }
    },
    [busy, mode, password, router, username],
  );

  if (checking) {
    return (
      <div className="login">
        <div className="login-card login-card--loading">
          <span className="spinner" />
        </div>
      </div>
    );
  }

  const isRegister = mode === 'register';

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand">
          <span className="brand-mark">
            <Logo />
          </span>
          <span className="brand-text">
            <strong>Cube</strong>
            <span>Mirror of Dreams</span>
          </span>
        </div>

        <h1 className="login-title">{isRegister ? '创建账号' : '登录'}</h1>
        <p className="login-hint">
          {isRegister
            ? '这是本机上的第一个账号，注册后会自动接手已有的项目、剧本与任务。'
            : '登录后继续你的剧本与视频任务。'}
        </p>

        {error && <div className="alert alert--error">{error}</div>}

        <label className="field">
          <span className="field-label">用户名</span>
          <input
            className="input"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            spellCheck={false}
            placeholder="2~32 个字符，不含空格"
          />
        </label>

        <label className="field">
          <span className="field-label">密码</span>
          <input
            className="input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={isRegister ? 'new-password' : 'current-password'}
            placeholder={isRegister ? '至少 6 位' : '请输入密码'}
          />
        </label>

        <button className="btn btn--primary btn--block" type="submit" disabled={busy}>
          {busy ? <span className="spinner" /> : null}
          {isRegister ? '创建并进入' : '登录'}
        </button>

        {registrationOpen && (
          <button
            type="button"
            className="login-switch"
            onClick={() => {
              setMode(isRegister ? 'login' : 'register');
              setError(null);
            }}
          >
            {isRegister ? '已有账号？直接登录' : '首次使用？创建第一个账号'}
          </button>
        )}
      </form>
    </div>
  );
}
