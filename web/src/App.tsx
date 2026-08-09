import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { ProductApp } from "./product/ProductApp";
import { RiffologyWorkbenchApp } from "./product/RiffologyWorkbenchApp";
import { TestUserAdminApp } from "./product/TestUserAdminApp";
import { defaultProductClient, ProductApiError, type ProductClient, type TestUserAuthSession } from "./product/api";

/**
 * The old Product surface is retained only for an explicit local rollback.
 * It is deliberately not linked from the Riffology UI and is disabled by
 * default. Only an explicit local build configuration enables it.
 */
const localLegacyProductEnabled = (): boolean =>
  (import.meta.env.VITE_RIFFOLOGY_LEGACY_PRODUCT_UI === "true"
    && document.querySelector<HTMLMetaElement>(
      'meta[name="riffology-server-legacy-product-ui"]',
    )?.content === "true")
  || (import.meta.env.MODE === "test"
    && (globalThis as { __RIFFOLOGY_TEST_LEGACY_FALLBACK__?: boolean })
      .__RIFFOLOGY_TEST_LEGACY_FALLBACK__ === true);

export function App({ client }: Readonly<{ client?: ProductClient }>) {
  if (window.location.pathname === "/admin" || window.location.pathname === "/admin/") {
    return <TestUserAdminApp />;
  }
  const effectiveClient = client ?? defaultProductClient;
  return <TestUserGate client={effectiveClient}><AppBody client={effectiveClient} /></TestUserGate>;
}

function AppBody({ client }: Readonly<{ client: ProductClient }>) {
  const isWorkbenchRoute = window.location.pathname === "/workbench"
    || window.location.pathname.startsWith("/workbench/");
  if (isWorkbenchRoute || !localLegacyProductEnabled()) {
    return <RiffologyWorkbenchApp client={client} />;
  }
  return <ProductApp client={client} />;
}

function TestUserGate({
  client,
  children,
}: Readonly<{ client: ProductClient; children: ReactNode }>) {
  const [session, setSession] = useState<TestUserAuthSession>();
  const [username, setUsername] = useState("");
  const [loginKey, setLoginKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!client.authSession) {
      setSession({ schemaVersion: 1, authenticated: true });
      return;
    }
    let active = true;
    void client.authSession().then((value) => { if (active) setSession(value); })
      .catch((cause) => {
        if (!active) return;
        if (cause instanceof ProductApiError && cause.status === 404) {
          setSession({ schemaVersion: 1, authenticated: true });
          return;
        }
        setError(cause instanceof Error ? cause.message : "无法检查登录状态。");
      });
    const requireLogin = () => {
      setSession({ schemaVersion: 1, authenticated: false });
      setLoginKey("");
    };
    const refreshQuota = () => {
      void client.authSession?.().then((value) => {
        if (value.authenticated) setSession(value);
      }).catch(() => undefined);
    };
    window.addEventListener("riff:authentication-required", requireLogin);
    window.addEventListener("riff:quota-updated", refreshQuota);
    return () => {
      active = false;
      window.removeEventListener("riff:authentication-required", requireLogin);
      window.removeEventListener("riff:quota-updated", refreshQuota);
    };
  }, [client]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!client.login || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const next = await client.login(username, loginKey);
      setLoginKey("");
      setSession(next);
    } catch (cause) {
      setLoginKey("");
      setError(cause instanceof Error ? cause.message : "登录失败。");
    } finally {
      setBusy(false);
    }
  };

  if (!session) return <main className="riff-auth-shell"><p>正在检查登录状态…</p></main>;
  if (!session.authenticated) {
    return <main className="riff-auth-shell">
      <form className="riff-auth-card" onSubmit={(event) => { void submit(event); }}>
        <p className="riff-auth-kicker">RIFFOLOGY TEST ACCESS</p>
        <h1>登录在线 Demo</h1>
        <label>测试用户名<input autoComplete="username" required maxLength={64}
          value={username} onChange={(event) => setUsername(event.target.value)} /></label>
        <label>登录 key<input type="password" autoComplete="off" required maxLength={1024}
          value={loginKey} onChange={(event) => setLoginKey(event.target.value)} /></label>
        {error ? <p className="riff-auth-error" role="alert">{error}</p> : null}
        <button type="submit" disabled={busy}>{busy ? "登录中…" : "登录"}</button>
      </form>
    </main>;
  }

  const quota = session.quota;
  return <>
    {session.username ? <aside className="riff-auth-status" aria-label="测试账户状态">
      <span>{session.username}</span>
      {quota ? <span title="当前接口未提供供应商精确 usage，显示服务端估算值">
        可用 {quota.availableTokens.toLocaleString()} / {quota.limitTokens.toLocaleString()} tokens（估算）
      </span> : null}
      {client.logout ? <button type="button" onClick={() => {
        if (busy) return;
        setBusy(true);
        void client.logout!().then(setSession).catch((cause) => {
          setError(cause instanceof Error ? cause.message : "退出失败。");
        }).finally(() => setBusy(false));
      }}>退出</button> : null}
    </aside> : null}
    {children}
  </>;
}
