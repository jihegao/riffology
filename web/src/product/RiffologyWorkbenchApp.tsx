import { useCallback, useEffect, useState, type FormEvent } from "react";
import { defaultProductClient, type ProductClient, type ProductRecoveryStatus } from "./api";
import { ConversationPane } from "./ConversationPane";
import type { HomeDto, ProjectSummary, WorkspaceDto } from "./types";

type WorkbenchRoute =
  | Readonly<{ page: "new"; workspaceKey: string }>
  | Readonly<{ page: "project"; projectId: string; conversationId?: string }>
  | Readonly<{ page: "not_found" }>;

const UNBOUND_DRAFT_PREFIX = "riffology:stage2:unbound-project";

const createUnboundWorkspaceHref = () =>
  `/workbench/new/${crypto.randomUUID()}`;

const readWorkbenchRoute = (): WorkbenchRoute => {
  if (window.location.pathname === "/workbench"
    || window.location.pathname === "/workbench/"
    || window.location.pathname === "/workbench/new") {
    const href = createUnboundWorkspaceHref();
    history.replaceState({}, "", href);
    return { page: "new", workspaceKey: href.slice("/workbench/new/".length) };
  }
  const newMatch = /^\/workbench\/new\/([a-zA-Z0-9_-]{1,80})\/?$/u
    .exec(window.location.pathname);
  if (newMatch) return { page: "new", workspaceKey: newMatch[1]! };
  const match = /^\/workbench\/projects\/([^/]+)\/?$/u.exec(window.location.pathname);
  if (!match) return { page: "not_found" };
  try {
    const projectId = decodeURIComponent(match[1]!);
    if (!projectId || projectId.length > 160
      || projectId.includes("/") || projectId.includes("\\")) {
      return { page: "not_found" };
    }
    const values = new URLSearchParams(window.location.search).getAll("conversation");
    if (values.length > 1) return { page: "not_found" };
    const conversationId = values[0];
    if (conversationId && (conversationId.length > 160
      || conversationId.includes("/") || conversationId.includes("\\"))) {
      return { page: "not_found" };
    }
    return { page: "project", projectId, ...(conversationId ? { conversationId } : {}) };
  } catch {
    return { page: "not_found" };
  }
};

const workbenchProjectHref = (projectId: string, conversationId?: string) => {
  const path = `/workbench/projects/${encodeURIComponent(projectId)}`;
  return conversationId ? `${path}?conversation=${encodeURIComponent(conversationId)}` : path;
};

const navigateWorkbench = (href: string) => {
  history.pushState({}, "", href);
  window.dispatchEvent(new Event("riff:workbench-navigation"));
};

export function RiffologyWorkbenchApp({
  client = defaultProductClient,
}: Readonly<{ client?: ProductClient }>) {
  const [route, setRoute] = useState<WorkbenchRoute>(() => readWorkbenchRoute());
  const [recovery, setRecovery] = useState<ProductRecoveryStatus | "checking">("checking");
  const [home, setHome] = useState<HomeDto>();
  const [workspace, setWorkspace] = useState<WorkspaceDto>();
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    setError(undefined);
    try {
      const nextRecovery = await client.recoveryStatus();
      setRecovery(nextRecovery);
      if (nextRecovery.state !== "ready") return;
      const nextHome = await client.home();
      setHome(nextHome);
      if (route.page === "project") {
        setWorkspace(await client.workspace("project", route.projectId));
      } else {
        setWorkspace(undefined);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The workbench could not be loaded.");
    }
  }, [client, route]);

  useEffect(() => {
    const update = () => setRoute(readWorkbenchRoute());
    window.addEventListener("popstate", update);
    window.addEventListener("riff:workbench-navigation", update);
    return () => {
      window.removeEventListener("popstate", update);
      window.removeEventListener("riff:workbench-navigation", update);
    };
  }, []);

  useEffect(() => {
    setRecovery("checking");
    setWorkspace(undefined);
    void load();
  }, [load]);

  const currentProject = route.page === "project"
    ? home?.projects.find((project) => project.id === route.projectId)
    : undefined;

  return (
    <div className="riffology-workbench-app">
      <a className="product-skip-link" href="#riffology-workbench-main">跳到主要内容</a>
      <header className="riffology-workbench-header">
        <a href="/" className="riffology-workbench-brand" aria-label="Riffology 首页">
          <span aria-hidden="true" className="riffology-workbench-mark">R</span>
          <strong>Riffology</strong>
        </a>
      </header>
      <main id="riffology-workbench-main" className="riffology-workbench-main" tabIndex={-1}>
        <ProjectRail
          projects={home?.projects ?? []}
          currentProjectId={route.page === "project" ? route.projectId : undefined}
          unbound={route.page === "new"}
        />
        {recovery === "checking" && <WorkbenchState title="正在恢复工作台…" />}
        {recovery !== "checking" && recovery.state === "recovery_required" && (
          <WorkbenchState title="工作台需要恢复" detail="Riffology 当前不会接受工作区写入。" />
        )}
        {recovery !== "checking" && recovery.state === "ready" && error && (
          <WorkbenchState title="工作台不可用" detail={error} retry={() => void load()} />
        )}
        {recovery !== "checking" && recovery.state === "ready" && !error
          && route.page === "not_found" && <WorkbenchState title="没有这个工作台" />}
        {recovery !== "checking" && recovery.state === "ready" && !error
          && route.page === "new" && (
          <UnboundProjectWorkspace workspaceKey={route.workspaceKey} />
        )}
        {recovery !== "checking" && recovery.state === "ready" && !error
          && route.page === "project" && workspace && currentProject && (
          <>
            <aside className="riffology-chat-pane" aria-label="项目对话">
              <ConversationPane
                client={client}
                ownerKind="project"
                ownerId={route.projectId}
                selectedConversationId={route.conversationId}
                onOwnerChanged={load}
                presentation="riffology"
                ownerName={workspace.owner.name}
                navigateConversation={(conversationId) => {
                  navigateWorkbench(workbenchProjectHref(route.projectId, conversationId));
                }}
                conversationHref={(conversationId) =>
                  workbenchProjectHref(route.projectId, conversationId)}
              />
            </aside>
            <section className="riffology-stage2-viewer riffology-bound-viewer"
              aria-label="当前项目工作区">
              <p className="product-eyebrow">RIFF PROJECT · BOUND</p>
              <h1>{workspace.owner.name}</h1>
              <p>{workspace.owner.lifecycleState} · {currentProject.modelSnapshotDigest}</p>
              <div className="riffology-stage2-placeholder" role="status">
                中央浏览器与文件查看将在阶段 3–4 接入；这里不提前暴露旧 Models、Projects、文件编辑或 Run 按钮。
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  );
}

function ProjectRail({ projects, currentProjectId, unbound }: Readonly<{
  projects: readonly ProjectSummary[];
  currentProjectId?: string;
  unbound: boolean;
}>) {
  return (
    <nav className="riffology-project-rail" aria-label="项目工作区">
      <button type="button" className="riffology-new-project"
        aria-current={unbound ? "page" : undefined}
        onClick={() => navigateWorkbench(createUnboundWorkspaceHref())}>
        <span aria-hidden="true">＋</span><small>新项目</small>
      </button>
      <ul>
        {projects.map((project) => (
          <li key={project.id}>
            <a href={workbenchProjectHref(project.id)}
              aria-current={project.id === currentProjectId ? "page" : undefined}
              aria-label={project.name} title={project.name}
              onClick={(event) => {
                if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
                event.preventDefault();
                navigateWorkbench(workbenchProjectHref(project.id));
              }}>{projectInitials(project.name)}</a>
          </li>
        ))}
      </ul>
      <span className="riffology-user-avatar" aria-label="当前用户 JG">JG</span>
    </nav>
  );
}

function UnboundProjectWorkspace({ workspaceKey }: Readonly<{ workspaceKey: string }>) {
  const draftKey = `${UNBOUND_DRAFT_PREFIX}:${workspaceKey}:draft`;
  const [draft, setDraft] = useState(() => sessionStorage.getItem(draftKey) ?? "");
  const [saved, setSaved] = useState(Boolean(draft));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    sessionStorage.setItem(draftKey, draft.trim());
    setSaved(true);
  };
  return (
    <>
      <aside className="riffology-chat-pane riffology-unbound-chat" aria-label="新项目引导">
        <header className="riffology-conversation-heading"><div>
          <strong>新项目</strong><span>未绑定 · 本地引导草稿</span>
        </div></header>
        <div className="riffology-unbound-timeline" role="log" aria-label="Agent 项目引导">
          <article><strong>Assistant</strong>
            <p>先描述要研究的问题。我会整理项目目标；绑定 Riff Project 后才能执行持久写入。</p>
          </article>
          {saved && draft.trim() && <article className="riffology-local-draft">
            <strong>本地草稿</strong><p>{draft.trim()}</p>
          </article>}
        </div>
        <form className="riffology-unbound-composer" onSubmit={submit}>
          <label htmlFor="unbound-project-draft">项目目标</label>
          <textarea id="unbound-project-draft" rows={4} value={draft}
            placeholder="描述要建立的仿真项目…"
            onChange={(event) => {
              setDraft(event.target.value);
              sessionStorage.setItem(draftKey, event.target.value);
              setSaved(false);
            }} />
          <button type="submit" disabled={!draft.trim()}>保存引导草稿</button>
          <small>此状态只保存在当前浏览器，不是 Riff Model / Project 权威数据。</small>
        </form>
      </aside>
      <section className="riffology-stage2-viewer riffology-unbound-viewer" aria-label="未绑定项目状态">
        <p className="product-eyebrow">UNBOUND WORKSPACE</p>
        <h1>等待 Agent 建立并绑定 Riff Project</h1>
        <p>服务端 WorkspaceBinding 与 Agent 化创建流程将在阶段 6 接入。</p>
      </section>
    </>
  );
}

function WorkbenchState({ title, detail, retry }: Readonly<{
  title: string; detail?: string; retry?: () => void;
}>) {
  return <section className="riffology-workbench-state" role={detail ? "alert" : "status"}>
    <h1>{title}</h1>{detail && <p>{detail}</p>}
    {retry && <button type="button" onClick={retry}>重试</button>}
  </section>;
}

const projectInitials = (name: string) => name.split(/\s+/u).filter(Boolean).slice(0, 2)
  .map((part) => part[0]?.toUpperCase()).join("") || "P";
