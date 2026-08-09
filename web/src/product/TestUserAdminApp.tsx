import { useCallback, useEffect, useState, type FormEvent } from "react";

type AdminSession = Readonly<{ schemaVersion: 1; authenticated: boolean; username?: string }>;
type ManagedUser = Readonly<{
  username: string;
  state: "active" | "revoked";
  quota: Readonly<{
    limitTokens: number;
    usedTokens: number;
    reservedTokens: number;
    availableTokens: number;
    measurement: "estimated";
  }>;
  createdAt: string;
  updatedAt: string;
}>;

export function TestUserAdminApp() {
  const [session, setSession] = useState<AdminSession>();
  const [adminName, setAdminName] = useState("");
  const [password, setPassword] = useState("");
  const [users, setUsers] = useState<readonly ManagedUser[]>([]);
  const [username, setUsername] = useState("");
  const [quota, setQuota] = useState("1000000");
  const [additional, setAdditional] = useState<Record<string, string>>({});
  const [oneTimeKey, setOneTimeKey] = useState<Readonly<{ username: string; key: string }>>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    const next = await adminRequest<AdminSession>("/api/admin/session");
    setSession(next);
    if (next.authenticated) {
      const collection = await adminRequest<{ users: readonly ManagedUser[] }>("/api/admin/users");
      setUsers(collection.users);
    } else {
      setUsers([]);
    }
  }, []);

  useEffect(() => { void refresh().catch(showError(setError)); }, [refresh]);

  const perform = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try { await action(); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  };

  const login = (event: FormEvent) => {
    event.preventDefault();
    void perform(async () => {
      const next = await adminRequest<AdminSession>("/api/admin/login", {
        method: "POST",
        body: JSON.stringify({ username: adminName, password }),
      });
      setPassword("");
      setSession(next);
      const collection = await adminRequest<{ users: readonly ManagedUser[] }>("/api/admin/users");
      setUsers(collection.users);
    });
  };

  if (!session) return <main className="riff-auth-shell"><p>正在检查管理员会话…</p></main>;
  if (!session.authenticated) return <main className="riff-auth-shell">
    <form className="riff-auth-card" onSubmit={login}>
      <p className="riff-auth-kicker">RIFFOLOGY ADMIN</p>
      <h1>测试 key 管理</h1>
      <label>管理员账号<input required autoComplete="username" maxLength={64}
        value={adminName} onChange={(event) => setAdminName(event.target.value)} /></label>
      <label>管理员密码<input required type="password" autoComplete="current-password" maxLength={1024}
        value={password} onChange={(event) => setPassword(event.target.value)} /></label>
      {error ? <p className="riff-auth-error" role="alert">{error}</p> : null}
      <button disabled={busy} type="submit">{busy ? "登录中…" : "管理员登录"}</button>
    </form>
  </main>;

  return <main className="riff-admin-shell">
    <header className="riff-admin-header">
      <div><p className="riff-auth-kicker">RIFFOLOGY ADMIN</p><h1>测试用户与 token 额度</h1></div>
      <button type="button" onClick={() => void perform(async () => {
        await adminRequest("/api/admin/logout", { method: "POST", body: "{}" });
        setSession({ schemaVersion: 1, authenticated: false });
        setUsers([]);
      })}>退出</button>
    </header>

    <form className="riff-admin-create" onSubmit={(event) => {
      event.preventDefault();
      void perform(async () => {
        const created = await adminRequest<{ user: ManagedUser; loginKey: string }>("/api/admin/users", {
          method: "POST",
          body: JSON.stringify({ username, tokenQuota: Number(quota) }),
        });
        setOneTimeKey({ username: created.user.username, key: created.loginKey });
        setUsername("");
        await refresh();
      });
    }}>
      <label>测试用户名<input required pattern="[A-Za-z0-9][A-Za-z0-9_.-]{2,63}" value={username}
        onChange={(event) => setUsername(event.target.value)} /></label>
      <label>初始 token 额度<input required type="number" min="1" max="1000000000" value={quota}
        onChange={(event) => setQuota(event.target.value)} /></label>
      <button disabled={busy} type="submit">生成登录 key</button>
    </form>

    {oneTimeKey ? <section className="riff-admin-key" role="status">
      <strong>{oneTimeKey.username} 的登录 key（仅显示一次）</strong>
      <code>{oneTimeKey.key}</code>
      <button type="button" onClick={() => void navigator.clipboard.writeText(oneTimeKey.key)}>复制</button>
      <button type="button" onClick={() => setOneTimeKey(undefined)}>我已保存</button>
    </section> : null}
    {error ? <p className="riff-auth-error" role="alert">{error}</p> : null}

    <section className="riff-admin-users">
      {users.map((user) => <article key={user.username}>
        <div><h2>{user.username}</h2><span>{user.state === "active" ? "可用" : "已撤销"}</span></div>
        <p>可用 {user.quota.availableTokens.toLocaleString()} / 总额 {user.quota.limitTokens.toLocaleString()} tokens（估算）</p>
        <p>已用 {user.quota.usedTokens.toLocaleString()} · 预留 {user.quota.reservedTokens.toLocaleString()}</p>
        {user.state === "active" ? <div className="riff-admin-actions">
          <input aria-label={`${user.username} 增加额度`} type="number" min="1" max="1000000000"
            value={additional[user.username] ?? "100000"}
            onChange={(event) => setAdditional((value) => ({ ...value, [user.username]: event.target.value }))} />
          <button type="button" disabled={busy} onClick={() => void perform(async () => {
            await adminRequest(`/api/admin/users/${encodeURIComponent(user.username)}/quota`, {
              method: "POST", body: JSON.stringify({ additionalTokens: Number(additional[user.username] ?? "100000") }),
            });
            await refresh();
          })}>增加额度</button>
          <button type="button" disabled={busy} onClick={() => void perform(async () => {
            const rotated = await adminRequest<{ loginKey: string }>(
              `/api/admin/users/${encodeURIComponent(user.username)}/rotate-key`,
              { method: "POST", body: "{}" },
            );
            setOneTimeKey({ username: user.username, key: rotated.loginKey });
          })}>重新生成 key</button>
          <button type="button" className="danger" disabled={busy} onClick={() => void perform(async () => {
            await adminRequest(`/api/admin/users/${encodeURIComponent(user.username)}/revoke`, {
              method: "POST", body: "{}",
            });
            await refresh();
          })}>撤销</button>
        </div> : null}
      </article>)}
    </section>
  </main>;
}

const adminRequest = async <T = unknown>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: init?.method ? { "content-type": "application/json", ...(init.headers ?? {}) } : init?.headers,
  });
  const text = await response.text();
  let value: any;
  try { value = text ? JSON.parse(text) : undefined; }
  catch { throw new Error("服务器返回了无效响应。"); }
  if (!response.ok) throw new Error(value?.error?.message ?? "管理员操作失败。");
  return value as T;
};

const errorMessage = (cause: unknown): string => cause instanceof Error ? cause.message : "管理员操作失败。";
const showError = (setError: (value: string) => void) => (cause: unknown) => setError(errorMessage(cause));
