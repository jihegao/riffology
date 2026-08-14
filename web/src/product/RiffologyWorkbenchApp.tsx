import { useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent, type PointerEvent, type RefObject } from "react";
import { defaultProductClient, type ProductClient, type ProductRecoveryStatus } from "./api";
import { ConversationPane } from "./ConversationPane";
import { RiffologyWorkbenchViewer } from "./RiffologyWorkbenchViewer";
import type {
  BrowserSessionDto,
  ConversationRuntimeProjection,
  HomeDto,
  ProjectSummary,
  ProviderDiscovery,
  WorkspaceDto,
} from "./types";

type WorkbenchRoute =
  | Readonly<{ page: "home" }>
  | Readonly<{ page: "new"; workspaceKey: string }>
  | Readonly<{ page: "project"; projectId: string; conversationId?: string }>
  | Readonly<{ page: "not_found" }>;

const createUnboundWorkspaceHref = () =>
  `/workbench/new/${crypto.randomUUID()}`;

const CHAT_PANE_STORAGE_KEY = "riffology.chat-pane-width.v1";
const CHAT_PANE_MIN = 320;
const CHAT_PANE_DEFAULT = 472;
const CHAT_PANE_MAX = 640;
const CHAT_PANE_STEP = 16;

const clampChatPaneWidth = (value: number, availableWidth = Number.POSITIVE_INFINITY) => {
  const dynamicMax = Math.min(CHAT_PANE_MAX, Math.max(CHAT_PANE_MIN, availableWidth - 320));
  return Math.round(Math.min(dynamicMax, Math.max(CHAT_PANE_MIN, value)));
};

const readChatPaneWidth = () => {
  if (typeof window === "undefined") return CHAT_PANE_DEFAULT;
  try {
    const parsed = Number(window.localStorage?.getItem?.(CHAT_PANE_STORAGE_KEY));
    return Number.isFinite(parsed) ? clampChatPaneWidth(parsed) : CHAT_PANE_DEFAULT;
  } catch { return CHAT_PANE_DEFAULT; }
};

const readWorkbenchRoute = (): WorkbenchRoute => {
  if (window.location.pathname === "/workbench/home" || window.location.pathname === "/workbench/home/") {
    return { page: "home" };
  }
  if (window.location.pathname === "/"
    || window.location.pathname === "/workbench"
    || window.location.pathname === "/workbench/"
    || window.location.pathname === "/workbench/new") {
    const href = createUnboundWorkspaceHref();
    history.replaceState({}, "", href);
    return { page: "new", workspaceKey: href.slice("/workbench/new/".length) };
  }
  const newMatch = /^\/workbench\/new\/([a-zA-Z0-9_-]{1,80})\/?$/u
    .exec(window.location.pathname);
  if (newMatch) return { page: "new", workspaceKey: newMatch[1]! };
  const projectMatch = /^\/workbench\/projects\/([^/]+)\/?$/u.exec(window.location.pathname);
  const match = projectMatch;
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

const workbenchOwnerHref = (
  _kind: "project",
  id: string,
  conversationId?: string,
) => workbenchProjectHref(id, conversationId);

const navigateWorkbench = (href: string) => {
  history.pushState({}, "", href);
  window.dispatchEvent(new Event("riff:workbench-navigation"));
};

export function RiffologyWorkbenchApp({
  client = defaultProductClient,
}: Readonly<{ client?: ProductClient }>) {
  const [route, setRoute] = useState<WorkbenchRoute>(() => readWorkbenchRoute());
  const [lastOwner, setLastOwner] = useState<Readonly<{ kind: "project"; id: string }>>();
  const [recovery, setRecovery] = useState<ProductRecoveryStatus | "checking">("checking");
  const [home, setHome] = useState<HomeDto>();
  const [workspace, setWorkspace] = useState<WorkspaceDto>();
  const [providers, setProviders] = useState<ProviderDiscovery>();
  const [error, setError] = useState<string>();
  const [filesOpen, setFilesOpen] = useState(() => !compactWorkbench());
  const [browser, setBrowser] = useState<BrowserSessionDto>();
  const [browserConversationId, setBrowserConversationId] = useState<string>();
  const [browserLoadRevision, setBrowserLoadRevision] = useState(0);
  const [browserScreenshot, setBrowserScreenshot] = useState<string>();
  const [browserError, setBrowserError] = useState<string>();
  const [browserBusy, setBrowserBusy] = useState(false);
  const [conversationRuntime, setConversationRuntime] = useState<ConversationRuntimeProjection>();
  const [agentActionBusy, setAgentActionBusy] = useState(false);
  const [agentMenuChecking, setAgentMenuChecking] = useState(false);
  const [chatPaneWidth, setChatPaneWidth] = useState(readChatPaneWidth);
  const [pausableRequestKey, setPausableRequestKey] = useState<string>();
  const browserRequestRef = useRef(0);
  const browserStateRef = useRef<BrowserSessionDto | undefined>(undefined);
  const browserBusyRef = useRef(false);
  const loadEpochRef = useRef(0);
  const fileToggleRef = useRef<HTMLButtonElement>(null);
  const workbenchMainRef = useRef<HTMLElement>(null);
  const chatWidthRef = useRef(chatPaneWidth);

  useEffect(() => {
    chatWidthRef.current = chatPaneWidth;
    try { window.localStorage?.setItem?.(CHAT_PANE_STORAGE_KEY, String(chatPaneWidth)); } catch { /* optional preference */ }
  }, [chatPaneWidth]);

  useEffect(() => {
    const main = workbenchMainRef.current;
    if (!main) return;
    const clamp = () => {
      const next = clampChatPaneWidth(chatWidthRef.current, main.clientWidth);
      setChatPaneWidth((current) => current === next ? current : next);
    };
    clamp();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", clamp);
      return () => window.removeEventListener("resize", clamp);
    }
    const observer = new ResizeObserver(clamp);
    observer.observe(main);
    return () => observer.disconnect();
  }, [route.page]);

  const load = useCallback(async () => {
    const epoch = ++loadEpochRef.current;
    const current = () => epoch === loadEpochRef.current;
    setError(undefined);
    try {
      const nextRecovery = await client.recoveryStatus();
      if (!current()) return;
      setRecovery(nextRecovery);
      if (nextRecovery.state !== "ready") {
        // Recovery is an authority boundary, not a visual overlay. Never leave
        // a prior ready owner's rail, browser image, or binding projected.
        setHome(undefined);
        setProviders(undefined);
        setWorkspace(undefined);
        setBrowser(undefined);
        setBrowserConversationId(undefined);
        browserStateRef.current = undefined;
        browserRequestRef.current += 1;
        setBrowserBusy(false);
        setBrowserScreenshot(undefined);
        setBrowserError(undefined);
        return;
      }
      const [nextHome, nextProviders] = await Promise.all([
        client.home(), client.providers(),
      ]);
      if (!current()) return;
      setHome(nextHome);
      setProviders(nextProviders);
      if (route.page === "project") {
        const nextWorkspace = await client.workspace(route.projectId);
        if (!current()) return;
        setWorkspace(nextWorkspace);
        setBrowserLoadRevision(epoch);
      } else if (route.page === "new") {
        setWorkspace(undefined);
      } else {
        setWorkspace(undefined);
      }
    } catch (cause) {
      if (current()) {
        setError(cause instanceof Error ? cause.message : "The workbench could not be loaded.");
      }
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
    if (route.page === "project") setLastOwner({ kind: "project", id: route.projectId });
  }, [route]);

  useEffect(() => {
    setRecovery("checking");
    setWorkspace(undefined);
    void load();
  }, [load]);

  useEffect(() => {
    if (route.page !== "project" || !workspace || !("runs" in workspace)
      || !workspace.runs.some((run) => ["queued", "running", "cancelling"].includes(run.status))) {
      return;
    }
    let cancelled = false;
    let polling = false;
    const authorityEpoch = loadEpochRef.current;
    const poll = () => {
      if (polling) return;
      polling = true;
      void client.workspace(route.projectId).then((next) => {
        if (!cancelled && authorityEpoch === loadEpochRef.current) setWorkspace(next);
      }).catch(() => {
        // The next authoritative recovery/load transition owns the visible
        // error. Never synthesize a terminal Run or output from a poll failure.
      }).finally(() => { polling = false; });
    };
    const timer = window.setInterval(poll, 750);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [client, route, workspace]);

  useEffect(() => {
    const query = globalThis.matchMedia?.("(max-width: 760px)");
    if (!query) return;
    const closeForCompactLayout = () => { if (query.matches) setFilesOpen(false); };
    closeForCompactLayout();
    query.addEventListener("change", closeForCompactLayout);
    return () => query.removeEventListener("change", closeForCompactLayout);
  }, []);

  const ownerRoute = route.page === "project" ? route : undefined;
  const currentOwner = route.page === "project"
    ? home?.projects.find((project) => project.id === route.projectId)
    : undefined;
  const ownerWorkspace = ownerRoute && workspace?.owner.kind === "project"
    && workspace.owner.id === ownerRoute.projectId
    ? workspace : undefined;
  const currentConversation = ownerRoute && ownerWorkspace
    ? ownerWorkspace.conversations.find((item) => item.id === ownerRoute.conversationId)
      ?? ownerWorkspace.conversations[0]
    : undefined;

  useEffect(() => {
    let active = true;
    let polling = false;
    setConversationRuntime(undefined);
    if (!currentConversation || !client.conversationRuntime) return () => { active = false; };
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const next = await client.conversationRuntime!(currentConversation.id);
        if (active) setConversationRuntime(next);
      } catch {
        if (active) setConversationRuntime(undefined);
      } finally {
        polling = false;
      }
    };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, 1_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [client, currentConversation?.id]);
  const browserMatchesConversation = Boolean(currentConversation
    && browserConversationId === currentConversation.id);
  const projectedBrowser = browserMatchesConversation ? browser : undefined;
  const projectedBrowserScreenshot = browserMatchesConversation
    ? browserScreenshot : undefined;

  const browserScreenshotData = useCallback(async (
    conversationId: string,
    state: BrowserSessionDto,
  ): Promise<string | undefined> => {
    if (!client.browserScreenshot || state.recoveryState !== "ready") {
      return undefined;
    }
    const screenshot = await client.browserScreenshot(conversationId, state);
    return `data:${screenshot.contentType};base64,${screenshot.pngBase64}`;
  }, [client]);

  useEffect(() => {
    let active = true;
    const authorityEpoch = loadEpochRef.current;
    const requestId = ++browserRequestRef.current;
    setBrowser(undefined);
    setBrowserConversationId(undefined);
    setBrowserScreenshot(undefined);
    setBrowserError(undefined);
    if (!currentConversation || !client.browserOpen) return () => { active = false; };
    setBrowserBusy(true);
    void (async () => {
      const existing = await client.browserState?.(currentConversation.id);
      const state = !existing || existing.recoveryState === "closed"
        || existing.recoveryState === "expired"
        ? await client.browserOpen!(currentConversation.id, "riff-app")
        : existing;
      const screenshot = await browserScreenshotData(currentConversation.id, state);
      if (!active || authorityEpoch !== loadEpochRef.current
        || requestId !== browserRequestRef.current) return;
      setBrowser(state);
      setBrowserConversationId(currentConversation.id);
      setBrowserScreenshot(screenshot);
    })()
      .catch((cause) => {
        if (active && authorityEpoch === loadEpochRef.current
          && requestId === browserRequestRef.current) {
          setBrowserError(cause instanceof Error ? cause.message : "浏览器观察不可用。");
        }
      })
      .finally(() => {
        if (active && authorityEpoch === loadEpochRef.current
          && requestId === browserRequestRef.current) setBrowserBusy(false);
      });
    return () => { active = false; };
  }, [client, currentConversation?.id, browserLoadRevision, browserScreenshotData]);

  useEffect(() => { browserStateRef.current = browser; }, [browser]);
  useEffect(() => { browserBusyRef.current = browserBusy; }, [browserBusy]);

  useEffect(() => {
    let active = true;
    let polling = false;
    const authorityEpoch = loadEpochRef.current;
    if (!currentConversation || !client.browserState) return () => { active = false; };
    const poll = async () => {
      if (polling || browserBusyRef.current) return;
      polling = true;
      const requestEpoch = browserRequestRef.current;
      try {
        const next = await client.browserState!(currentConversation.id);
        const previous = browserStateRef.current;
        if (!active || authorityEpoch !== loadEpochRef.current
          || requestEpoch !== browserRequestRef.current
          || browserFingerprint(previous) === browserFingerprint(next)) return;
        browserStateRef.current = next;
        setBrowser(next);
        setBrowserConversationId(currentConversation.id);
        if (next.recoveryState === "ready"
          && (!previous || next.pageGeneration !== previous.pageGeneration
            || next.recoveryState !== previous.recoveryState
            || next.projectedUrl !== previous.projectedUrl)) {
          const screenshot = await browserScreenshotData(currentConversation.id, next);
          if (active && authorityEpoch === loadEpochRef.current
            && requestEpoch === browserRequestRef.current) {
            setBrowserScreenshot(screenshot);
          }
        }
      } catch {
        // The initial loader and explicit controls own user-visible errors.
      } finally {
        polling = false;
      }
    };
    const timer = window.setInterval(() => { void poll(); }, 750);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [client, currentConversation?.id, browserLoadRevision, browserScreenshotData]);

  useEffect(() => {
    setPausableRequestKey(undefined);
    setAgentMenuChecking(false);
  }, [currentConversation?.id]);

  const browserAction = async (action: "back" | "reload" | "reconnect") => {
    if (!currentConversation || !browser) return;
    if (browser.controlMode === "agent") return;
    const operation = action === "back" ? client.browserBack
      : action === "reload" ? client.browserReload : client.browserReconnect;
    if (!operation) return;
    const requestId = ++browserRequestRef.current;
    const authorityEpoch = loadEpochRef.current;
    setBrowserBusy(true);
    setBrowserError(undefined);
    try {
      const next = await operation.call(client, currentConversation.id, browser);
      const screenshot = await browserScreenshotData(currentConversation.id, next);
      if (authorityEpoch !== loadEpochRef.current
        || requestId !== browserRequestRef.current) return;
      setBrowser(next);
      setBrowserConversationId(currentConversation.id);
      setBrowserScreenshot(screenshot);
    } catch (cause) {
      if (authorityEpoch === loadEpochRef.current
        && requestId === browserRequestRef.current) {
        setBrowserError(cause instanceof Error ? cause.message : "浏览器观察不可用。");
      }
    } finally {
      if (authorityEpoch === loadEpochRef.current
        && requestId === browserRequestRef.current) setBrowserBusy(false);
    }
  };

  const browserControl = async (action: "takeover" | "return") => {
    if (!currentConversation || !browser) return;
    const operation = action === "takeover" ? client.browserTakeover : client.browserReturn;
    if (!operation) return;
    const requestId = ++browserRequestRef.current;
    const authorityEpoch = loadEpochRef.current;
    setAgentActionBusy(true);
    setBrowserBusy(true);
    setBrowserError(undefined);
    try {
      const next = await operation.call(client, currentConversation.id, browser);
      const screenshot = await browserScreenshotData(currentConversation.id, next);
      if (authorityEpoch !== loadEpochRef.current
        || requestId !== browserRequestRef.current) return;
      setBrowser(next);
      setBrowserConversationId(currentConversation.id);
      setBrowserScreenshot(screenshot);
    } catch (cause) {
      if (authorityEpoch === loadEpochRef.current
        && requestId === browserRequestRef.current) {
        setBrowserError(cause instanceof Error ? cause.message : "浏览器控制不可用。");
      }
    } finally {
      if (authorityEpoch === loadEpochRef.current
        && requestId === browserRequestRef.current) setBrowserBusy(false);
      setAgentActionBusy(false);
    }
  };

  const pauseAgent = async () => {
    if (!currentConversation || !client.conversationRuntime || !client.stopConversation) return;
    setAgentActionBusy(true);
    setBrowserError(undefined);
    try {
      const runtime = await client.conversationRuntime(currentConversation.id);
      if (runtime.activeTurn?.canStop) {
        await client.stopConversation({
          conversationId: currentConversation.id,
          requestKey: runtime.activeTurn.requestKey,
        });
        setPausableRequestKey(undefined);
      }
    } catch (cause) {
      setBrowserError(cause instanceof Error ? cause.message : "Agent 暂停失败。");
    } finally {
      setAgentActionBusy(false);
    }
  };

  const inspectAgentMenu = async () => {
    setPausableRequestKey(undefined);
    if (!currentConversation || !client.conversationRuntime || !client.stopConversation) return;
    setAgentMenuChecking(true);
    try {
      const runtime = await client.conversationRuntime(currentConversation.id);
      setPausableRequestKey(runtime.activeTurn?.canStop
        ? runtime.activeTurn.requestKey : undefined);
    } catch {
      setPausableRequestKey(undefined);
    } finally {
      setAgentMenuChecking(false);
    }
  };

  return (
    <div className="riffology-workbench-app">
      <a className="product-skip-link" href="#riffology-workbench-main">跳到主要内容</a>
      <header className="riffology-workbench-header">
        <a href="/workbench/home" className="riffology-workbench-brand" aria-label="Riffology 首页"
          onClick={(event) => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
            event.preventDefault();
            navigateWorkbench("/workbench/home");
          }}>
          <span aria-hidden="true" className="riffology-workbench-mark">R</span>
          <strong>Riffology</strong>
        </a>
        <button type="button" className="riffology-home-trigger" aria-label="打开项目与会话"
          title="项目与会话" onClick={() => navigateWorkbench("/workbench/home")}>
          <span aria-hidden="true"><i /><i /><i /><i /></span>
        </button>
        <WorkbenchChrome
          route={route}
          authorityReady={recovery !== "checking" && recovery.state === "ready"}
          workspace={recovery !== "checking" && recovery.state === "ready"
            ? ownerWorkspace : undefined}
          filesOpen={filesOpen}
          onFilesOpenChange={setFilesOpen}
          fileToggleRef={fileToggleRef}
          browser={recovery !== "checking" && recovery.state === "ready"
            ? projectedBrowser : undefined}
          browserBusy={browserBusy}
          onBrowserBack={() => void browserAction("back")}
          onBrowserReload={() => void browserAction("reload")}
          agentActionBusy={agentActionBusy}
          canPauseAgent={Boolean(pausableRequestKey)}
          agentMenuChecking={agentMenuChecking}
          onAgentMenuOpen={() => void inspectAgentMenu()}
          onPauseAgent={() => void pauseAgent()}
          onBrowserTakeover={() => void browserControl("takeover")}
          onBrowserReturn={() => void browserControl("return")}
        />
      </header>
      <main
        id="riffology-workbench-main"
        className="riffology-workbench-main"
        ref={workbenchMainRef}
        style={{ "--riffology-chat-width": `${chatPaneWidth}px` } as CSSProperties}
        tabIndex={-1}
      >
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
          && route.page === "home" && home && <RiffologyHome home={home} currentOwner={lastOwner} />}
        {recovery !== "checking" && recovery.state === "ready" && !error
          && route.page === "new" && (
          <NewProjectWorkspace
            client={client}
            workspaceKey={route.workspaceKey}
            providers={providers}
            home={home}
          />
        )}
        {recovery !== "checking" && recovery.state === "ready" && !error
          && route.page === "project"
          && ownerWorkspace && currentOwner && (
          <>
            <aside className="riffology-chat-pane"
              aria-label="项目对话">
              <ConversationPane
                client={client}
                ownerKind="project"
                ownerId={route.projectId}
                selectedConversationId={route.conversationId}
                onOwnerChanged={load}
                presentation="riffology"
                ownerName={ownerWorkspace.owner.name}
                navigateConversation={(conversationId) => {
                  navigateWorkbench(workbenchOwnerHref(
                    "project",
                    route.projectId,
                    conversationId,
                  ));
                }}
                conversationHref={(conversationId) =>
                  workbenchOwnerHref(
                    "project",
                    route.projectId,
                    conversationId,
                  )}
              />
              <ChatPaneResizer
                width={chatPaneWidth}
                onWidthChange={setChatPaneWidth}
                availableWidth={workbenchMainRef.current?.clientWidth}
              />
            </aside>
            <RiffologyWorkbenchViewer client={client} workspace={ownerWorkspace}
              filesOpen={filesOpen} onFilesOpenChange={setFilesOpen}
              fileToggleRef={fileToggleRef}
              refresh={load}
              browser={projectedBrowser}
              browserScreenshot={projectedBrowserScreenshot}
              browserError={browserError}
              browserBusy={browserBusy}
              conversationId={currentConversation?.id}
              runtime={conversationRuntime}
              onBrowserReconnect={() => void browserAction("reconnect")} />
          </>
        )}
      </main>
    </div>
  );
}

function ChatPaneResizer({
  width,
  availableWidth,
  onWidthChange,
}: Readonly<{
  width: number;
  availableWidth?: number;
  onWidthChange: (width: number) => void;
}>) {
  const startRef = useRef<Readonly<{ x: number; width: number }> | undefined>(undefined);
  const maxWidth = clampChatPaneWidth(CHAT_PANE_MAX, availableWidth);
  const setWidth = (next: number) => onWidthChange(clampChatPaneWidth(next, availableWidth));
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    startRef.current = { x: event.clientX, width };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const start = startRef.current;
    if (!start) return;
    setWidth(start.width + event.clientX - start.x);
  };
  const stopPointer = (event: PointerEvent<HTMLDivElement>) => {
    if (startRef.current && event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    startRef.current = undefined;
  };
  return (
    <div
      className="riffology-chat-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="调整对话栏宽度"
      aria-valuemin={CHAT_PANE_MIN}
      aria-valuemax={maxWidth}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={stopPointer}
      onPointerCancel={stopPointer}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") { event.preventDefault(); setWidth(width - CHAT_PANE_STEP); }
        else if (event.key === "ArrowRight") { event.preventDefault(); setWidth(width + CHAT_PANE_STEP); }
        else if (event.key === "Home") { event.preventDefault(); setWidth(CHAT_PANE_MIN); }
        else if (event.key === "End") { event.preventDefault(); setWidth(maxWidth); }
      }}
    />
  );
}

function WorkbenchChrome({
  route,
  authorityReady,
  workspace,
  filesOpen,
  onFilesOpenChange,
  fileToggleRef,
  browser,
  browserBusy,
  onBrowserBack,
  onBrowserReload,
  agentActionBusy,
  canPauseAgent,
  agentMenuChecking,
  onAgentMenuOpen,
  onPauseAgent,
  onBrowserTakeover,
  onBrowserReturn,
}: Readonly<{
  route: WorkbenchRoute;
  authorityReady: boolean;
  workspace?: WorkspaceDto;
  filesOpen: boolean;
  onFilesOpenChange: (open: boolean) => void;
  fileToggleRef: RefObject<HTMLButtonElement | null>;
  browser?: BrowserSessionDto;
  browserBusy: boolean;
  onBrowserBack: () => void;
  onBrowserReload: () => void;
  agentActionBusy: boolean;
  canPauseAgent: boolean;
  agentMenuChecking: boolean;
  onAgentMenuOpen: () => void;
  onPauseAgent: () => void;
  onBrowserTakeover: () => void;
  onBrowserReturn: () => void;
}>) {
  const [agentMenuOpen, setAgentMenuOpen] = useState(false);
  const agentMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!agentMenuOpen) return;
    const dismiss = (event: MouseEvent) => {
      if (!agentMenuRef.current?.contains(event.target as Node)) setAgentMenuOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAgentMenuOpen(false);
    };
    document.addEventListener("mousedown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, [agentMenuOpen]);
  const projectedPath = !authorityReady ? "riff://unavailable"
    : route.page === "project"
    ? `riff://project/${encodeURIComponent(route.projectId)}`
      : "riff://unbound-workspace";
  const conversation = route.page === "project"
    && workspace?.owner.kind === "project"
    ? workspace.conversations.find((item) => item.id === route.conversationId) ?? workspace.conversations[0]
    : undefined;
  const agentState = conversation?.sessionState === "available" ? "可用"
    : conversation?.sessionState === "connecting" ? "连接中"
      : conversation?.sessionState === "read_only" ? "只读" : "未接管";
  const projectedAgentState = browser?.controlMode === "agent" ? "控制中"
    : browser?.controlMode === "human" ? "人工" : agentState;
  const navigationLocked = browser?.controlMode === "agent";
  const runMenuAction = (action: () => void) => {
    setAgentMenuOpen(false);
    action();
  };
  return <div className="riffology-workbench-chrome">
    <span className="riffology-context-projection">
      <i aria-hidden="true" />
      {!authorityReady ? "工作台恢复中"
        : workspace?.owner.kind === "project"
        ? `${workspace.owner.name} / Project Conversation`
        : "新项目 / Agent 引导"}
    </span>
    <nav aria-label="浏览器导航" className="riffology-browser-navigation">
      <button type="button" disabled={!browser?.canGoBack || browserBusy || navigationLocked}
        onClick={onBrowserBack} aria-label="后退">←</button>
      <button type="button" disabled title="前进将在后续浏览历史阶段提供" aria-label="前进">→</button>
      <button type="button" disabled={!browser?.canReload || browserBusy || navigationLocked}
        onClick={onBrowserReload} aria-label="刷新">↻</button>
    </nav>
    <output className="riffology-url-projection" aria-label="页面地址">
      {browser?.projectedUrl ?? projectedPath}
    </output>
    <span className="riffology-trust-state" aria-label="受信状态">
      {authorityReady && (!browser || browser.trustState === "trusted_riff")
        ? "受信 Riff" : "未连接"}
    </span>
    <div className="riffology-agent-menu" ref={agentMenuRef}>
      <button type="button" className="riffology-agent-state"
        aria-label={`Agent 状态：${projectedAgentState}`}
        aria-haspopup="menu" aria-expanded={agentMenuOpen}
        onClick={() => setAgentMenuOpen((open) => {
          if (!open) onAgentMenuOpen();
          return !open;
        })}>
        Agent · {projectedAgentState}
      </button>
      {agentMenuOpen && <div className="riffology-agent-menu-popover" role="menu" aria-label="Agent 控制">
        {browser?.controlMode === "agent" && browser.remainingBudget !== null
          && <span className="riffology-agent-budget">剩余动作 {browser.remainingBudget}</span>}
        <button type="button" role="menuitem"
          disabled={!canPauseAgent || agentActionBusy || agentMenuChecking}
          onClick={() => runMenuAction(onPauseAgent)}>暂停当前轮次</button>
        {!canPauseAgent && <span className="riffology-agent-menu-status" role="status">
          {agentMenuChecking ? "检查当前轮次…" : "当前没有可暂停轮次"}
        </span>}
        <button type="button" role="menuitem"
          disabled={!browser || browser.recoveryState !== "ready"
            || browser.controlMode === "human" || agentActionBusy}
          onClick={() => runMenuAction(onBrowserTakeover)}>人工接管浏览器</button>
        <button type="button" role="menuitem"
          disabled={browser?.controlMode !== "human" || agentActionBusy}
          onClick={() => runMenuAction(onBrowserReturn)}>交还为观察模式</button>
      </div>}
    </div>
    <span className="riffology-opencode-version" aria-label="OpenCode 基线版本">OpenCode 1.18.11</span>
    <button ref={fileToggleRef} type="button" className="riffology-file-toggle"
      disabled={!authorityReady || route.page !== "project"}
      aria-expanded={authorityReady && route.page === "project"
        ? filesOpen : undefined}
      aria-controls="riffology-owner-files" onClick={() => onFilesOpenChange(!filesOpen)}>文件 ↗</button>
  </div>;
}

const compactWorkbench = (): boolean =>
  typeof globalThis.matchMedia === "function" && globalThis.matchMedia("(max-width: 760px)").matches;

const browserFingerprint = (state?: BrowserSessionDto): string => state
  ? [
    state.conversationGeneration,
    state.pageGeneration,
    state.projectedUrl ?? "",
    state.trustState,
    state.controlMode,
    state.remainingBudget ?? "",
    state.recoveryState,
    state.canGoBack ? 1 : 0,
    state.canReload ? 1 : 0,
    state.expiresAt ?? "",
  ].join("\u0000")
  : "";

function RiffologyHome({ home, currentOwner }: Readonly<{
  home: HomeDto;
  currentOwner?: Readonly<{ kind: "project"; id: string }>;
}>) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLocaleLowerCase();
  const matches = (value: string) => !needle || value.toLocaleLowerCase().includes(needle);
  const projects = home.projects.filter((project) => matches(project.name));
  const recent = (home.recentConversations ?? []).filter((conversation) =>
    matches(conversation.name) || matches(conversation.owner.name));
  return (
    <section className="riffology-home" aria-label="项目与会话">
      <div className="riffology-home-search">
        <label>
          <span aria-hidden="true">⌕</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索项目或会话…" />
        </label>
      </div>
      <aside className="riffology-home-projects" aria-label="项目">
        <div className="riffology-home-section-heading">
          <strong>项目</strong>
          <button type="button" aria-label="新项目" title="新项目"
            onClick={() => navigateWorkbench(createUnboundWorkspaceHref())}>＋</button>
        </div>
        <ul>
          {projects.map((project) => (
            <li key={`project:${project.id}`}>
              <a href={workbenchProjectHref(project.id)} aria-label={`项目：${project.name}`}
                aria-current={currentOwner?.kind === "project" && currentOwner.id === project.id ? "page" : undefined}
              onClick={(event) => {
                if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
                event.preventDefault();
                navigateWorkbench(workbenchProjectHref(project.id));
              }}><span aria-hidden="true">{projectInitials(project.name)}</span>{project.name}</a>
            </li>
          ))}
          {projects.length === 0 && <li className="riffology-home-empty">没有匹配的项目。</li>}
        </ul>
        <footer><button type="button" disabled>设置</button><button type="button" disabled>帮助</button></footer>
      </aside>
      <section className="riffology-home-recent" aria-label="最近会话">
        <header><strong>最近会话</strong><button type="button"
          onClick={() => navigateWorkbench(createUnboundWorkspaceHref())}>新项目</button></header>
        <ul>
          {recent.map((conversation) => (
            <li key={conversation.id}>
              <a href={workbenchOwnerHref(conversation.owner.kind, conversation.owner.id, conversation.id)}
                aria-label={`会话：${conversation.name} · ${conversation.owner.name}`}
                onClick={(event) => {
                  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
                  event.preventDefault();
                  navigateWorkbench(workbenchOwnerHref(conversation.owner.kind, conversation.owner.id, conversation.id));
                }}>
                <span aria-hidden="true">{projectInitials(conversation.owner.name)}</span>
                <strong>{conversation.name}</strong><small>{conversation.owner.name}</small>
              </a>
            </li>
          ))}
          {recent.length === 0 && <li className="riffology-home-empty">暂无可继续的活跃会话。</li>}
        </ul>
      </section>
    </section>
  );
}

function NewProjectWorkspace({
  client,
  workspaceKey,
  providers,
  home,
}: Readonly<{
  client: ProductClient;
  workspaceKey: string;
  providers?: ProviderDiscovery;
  home?: HomeDto;
}>) {
  const [name, setName] = useState("新仿真项目");
  const [provider, setProvider] = useState("");
  const [sourceKind, setSourceKind] = useState<"blank" | "template" | "import">("blank");
  const [templateKey, setTemplateKey] = useState("");
  const [importFile, setImportFile] = useState<File>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!provider && providers?.mode === "live" && providers.providerModels[0]) {
      const first = providers.providerModels[0];
      setProvider(JSON.stringify([first.providerId, first.modelId]));
    }
  }, [provider, providers]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const [providerId, modelId] = provider ? JSON.parse(provider) as string[] : [];
    const templates = home?.templates ?? [];
    const selectedTemplate = templates.find(
      (item) => `${item.id}@${item.version}` === templateKey,
    ) ?? templates[0];
    if (!providerId || !modelId || !name.trim() || busy
      || sourceKind === "template" && !selectedTemplate
      || sourceKind === "import" && !importFile) return;
    setBusy(true); setError(undefined);
    try {
      const created = await client.createProject({
        commandId: `project_create_${workspaceKey}`,
        name: name.trim(),
        provider: { providerId, modelId },
        source: sourceKind === "template" ? {
          kind: "template",
          templateId: selectedTemplate!.id,
          templateVersion: selectedTemplate!.version,
        } : sourceKind === "import" ? {
          kind: "import",
          filename: importFile!.name,
          mediaType: importFile!.type || "application/octet-stream",
          base64: await fileBase64(importFile!),
        } : { kind: "blank" },
      });
      navigateWorkbench(workbenchOwnerHref("project", created.project.id, created.conversation.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "项目创建暂时不可用。");
    } finally { setBusy(false); }
  };
  const providerModels = providers?.mode === "live" ? providers.providerModels : [];
  const templates = home?.templates ?? [];
  const selectedTemplate = templates.find(
    (item) => `${item.id}@${item.version}` === templateKey,
  ) ?? templates[0];
  return (
    <>
      <aside className="riffology-chat-pane riffology-unbound-chat" aria-label="新项目引导">
        <header className="riffology-conversation-heading"><div>
          <strong>新项目</strong><span>创建 Project 与首个 Conversation</span>
        </div></header>
        <div className="riffology-unbound-timeline" role="log" aria-label="Agent 项目引导">
          <article><strong>Assistant</strong>
            <p>可以创建空白 Project，也可以复制一个不可变 Example Project Template。建模需求与模型文件都由新 Project 独立持有。</p>
          </article>
        </div>
        <form className="riffology-unbound-composer" onSubmit={submit}>
          <label htmlFor="new-project-name">项目名称</label>
          <input id="new-project-name" maxLength={200} value={name} disabled={busy}
            onChange={(event) => setName(event.target.value)} />
          <label htmlFor="new-project-source">创建方式</label>
          <select id="new-project-source" value={sourceKind} disabled={busy}
            onChange={(event) => setSourceKind(event.target.value as "blank" | "template" | "import")}>
            <option value="blank">空白 Project</option>
            <option value="template">Example Project Template</option>
            <option value="import">导入 Project 归档</option>
          </select>
          {sourceKind === "template" && <>
            <label htmlFor="new-project-template">示例模板</label>
            <select id="new-project-template"
              value={templateKey || (selectedTemplate ? `${selectedTemplate.id}@${selectedTemplate.version}` : "")}
              disabled={busy || templates.length === 0}
              onChange={(event) => setTemplateKey(event.target.value)}>
              {templates.map((item) => <option key={`${item.id}@${item.version}`}
                value={`${item.id}@${item.version}`}>{item.name} · {item.version}</option>)}
            </select>
            {selectedTemplate ? <small>{selectedTemplate.description}</small>
              : <small role="status">当前版本没有可用的官方 Example Project Template。</small>}
          </>}
          {sourceKind === "import" && <>
            <label htmlFor="new-project-import">Project 归档</label>
            <input id="new-project-import" type="file"
              accept=".zip,application/zip,application/octet-stream" disabled={busy}
              onChange={(event) => setImportFile(event.target.files?.[0])} />
          </>}
          <label htmlFor="unbound-project-provider">Provider</label>
          <select id="unbound-project-provider" value={provider}
            disabled={busy || providers?.mode !== "live"}
            onChange={(event) => setProvider(event.target.value)}>
            <option value="">选择 Provider / Model…</option>
            {providerModels.map((item) => <option key={item.qualifiedId}
              value={JSON.stringify([item.providerId, item.modelId])}>{item.qualifiedId}</option>)}
          </select>
          <button type="submit" disabled={!name.trim() || !provider || busy
            || providers?.mode !== "live" || sourceKind === "template" && !selectedTemplate
            || sourceKind === "import" && !importFile}>
            {busy ? "正在创建…" : "创建项目"}
          </button>
          {error && <small role="alert">{error}</small>}
          {providers?.mode === "read_only" && <small>
            OpenCode Provider 不可用；Project 创建保持关闭，不会启用隐藏 fallback。
          </small>}
          <small>Project 与首个 Conversation 会在同一持久事务内创建。</small>
        </form>
      </aside>
      <section className="riffology-stage2-viewer riffology-unbound-viewer" aria-label="未绑定项目状态">
        <p className="product-eyebrow">NEW PROJECT</p>
        <h1>创建后，在对话中描述模型需求</h1>
        <p>模型文件、实验配置与 Run 都由 Project 持久拥有。</p>
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

const fileBase64 = async (file: File): Promise<string> => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};
