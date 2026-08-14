import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from "react";
import type { ProductClient } from "./api";
import { RendererRegistry, type RendererResource } from "./RendererRegistry";
import { MODELING_REQUIREMENTS_PATH } from "./modeling-requirements";
import { WorkspacePane } from "./WorkspacePane";
import type {
  BrowserSessionDto,
  ConversationRuntimeProjection,
  ProjectRun,
  ProjectWorkspaceDto,
} from "./types";

type WorkspaceWorkbenchFile = Readonly<{
  key: string;
  source: "workspace";
  relativePath: string;
  mediaType: string;
  sizeBytes: number;
}>;
type RunOutputWorkbenchFile = Readonly<{
  key: string;
  source: "run_output";
  relativePath: string;
  mediaType: string;
  sizeBytes: number;
  runId?: string;
  outputId?: string;
}>;
type WorkbenchFile = WorkspaceWorkbenchFile | (RunOutputWorkbenchFile & Required<Pick<RunOutputWorkbenchFile, "runId" | "outputId">>);

type FileTreeEntry =
  | Readonly<{ kind: "folder"; name: string; path: string; children: readonly FileTreeEntry[] }>
  | Readonly<{ kind: "file"; name: string; file: WorkbenchFile }>;

type MutableFileTreeNode = {
  folders: Map<string, MutableFileTreeNode>;
  files: WorkbenchFile[];
};

type WorkbenchService = Readonly<{
  key: string;
  kind: "visual_run" | "visual_preview" | "mcp";
  label: string;
  status: string;
  enabled: boolean;
  run?: ProjectRun;
}>;

const RAIL_MIN = 224;
const RAIL_MAX = 520;
export function RiffologyWorkbenchViewer({
  client,
  workspace,
  filesOpen,
  onFilesOpenChange,
  fileToggleRef,
  browser,
  browserScreenshot,
  browserError,
  browserBusy,
  onBrowserReconnect,
  conversationId,
  runtime,
  refresh,
}: Readonly<{
  client: ProductClient;
  workspace: ProjectWorkspaceDto;
  filesOpen: boolean;
  onFilesOpenChange: (open: boolean) => void;
  fileToggleRef: RefObject<HTMLButtonElement | null>;
  browser?: BrowserSessionDto;
  browserScreenshot?: string;
  browserError?: string;
  browserBusy: boolean;
  onBrowserReconnect: () => void;
  conversationId?: string;
  runtime?: ConversationRuntimeProjection;
  refresh: () => Promise<void>;
}>) {
  const runOutputFiles = workspace.runs.flatMap((run) =>
      run.status === "succeeded" ? run.outputs.flatMap((output): WorkbenchFile[] => {
        const name = (safeRelativePath(output.logicalName) ?? "").split("/").at(-1) ?? "";
        return name ? [{ key: `output:${run.id}:${output.id}`, source: "run_output",
          runId: run.id, outputId: output.id,
          relativePath: `outputs/${run.id}/${name}${output.sampleIndex === null ? "" : `-${output.sampleIndex}`}`,
          mediaType: output.mediaType, sizeBytes: output.sizeBytes }] : [];
      }) : []);
  const files = workspace.files.flatMap((file): WorkbenchFile[] => {
    const relativePath = safeRelativePath(file.relativePath ?? "");
    return relativePath ? [{
      key: `workspace:${file.fileRef}`,
      source: "workspace",
      relativePath,
      mediaType: file.mediaType,
      sizeBytes: file.sizeBytes,
    }] : [];
  }).concat(runOutputFiles);
  const compact = useCompactLayout();
  const [selectedKey, setSelectedKey] = useState("");
  const [resource, setResource] = useState<RendererResource>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [selectedServiceKey, setSelectedServiceKey] = useState("");
  const [experimentsOpen, setExperimentsOpen] = useState(false);
  const [serviceFrame, setServiceFrame] = useState<Readonly<{
    key: string;
    sourceRevision?: string;
    url?: string;
    loading: boolean;
    error?: string;
  }>>({ key: "", loading: false });
  const request = useRef(0);
  const viewerRef = useRef<HTMLElement>(null);

  useEffect(() => {
    request.current += 1;
    setSelectedKey("");
    setResource(undefined);
    setError(undefined);
    setSelectedServiceKey("");
    setServiceFrame({ key: "", loading: false });
  }, [workspace.owner.id, workspace.workspaceDigest]);

  useEffect(() => setExperimentsOpen(false), [workspace.owner.id]);

  const services: readonly WorkbenchService[] = [
    ...(browser?.projectedUrl === "riff-visual://solara/"
      ? [{
        key: "visual-preview:solara",
        kind: "visual_preview" as const,
        label: "Solara 可视化仿真",
        status: browser.recoveryState === "ready" ? "运行中" : "不可用",
        enabled: browser.recoveryState === "ready" && Boolean(conversationId && client.browserServiceFrame),
      }]
      : []),
    ...(workspace.owner.kind === "project"
      ? (workspace as ProjectWorkspaceDto).runs
        .filter((run) => run.contractVersion === 4 && run.runKind === "visual"
          && ["queued", "running", "cancelling"].includes(run.status))
        .map((run): WorkbenchService => ({
          key: `visual-run:${run.id}`,
          kind: "visual_run",
          label: `可视化 Run ${run.id.slice(-8)}`,
          status: run.status === "running" ? "运行中"
            : run.status === "queued" ? "启动中" : "正在停止",
          enabled: run.status === "running",
          run,
        }))
      : []),
    {
      key: "mcp:scoped",
      kind: "mcp",
      label: runtime?.mcp.label ?? "Riff scoped MCP",
      status: runtime?.mcp.state === "connected" ? "已连接"
        : runtime?.mcp.state === "unavailable" ? "不可用" : "按轮次启用",
      enabled: false,
    },
  ];

  const selectService = async (service: WorkbenchService) => {
    if (!service.enabled || service.kind === "mcp") return;
    const operation = request.current + 1;
    request.current = operation;
    setSelectedKey("");
    setResource(undefined);
    setError(undefined);
    setLoading(false);
    setSelectedServiceKey(service.key);
    const sourceRevision = service.kind === "visual_preview" && browser
      ? `${browser.conversationGeneration}:${browser.pageGeneration}`
      : service.run?.lifecycleDigest ?? service.run?.updatedAt;
    setServiceFrame({ key: service.key, sourceRevision, loading: true });
    if (compact) {
      onFilesOpenChange(false);
      queueMicrotask(() => viewerRef.current?.focus());
    }
    try {
      const issued = service.kind === "visual_run" && service.run
        ? await client.issueVisualFrame(workspace.owner.id, service.run.id)
        : browser && conversationId && client.browserServiceFrame
          ? await client.browserServiceFrame(conversationId, browser)
          : undefined;
      if (!issued) throw new Error("可视化服务没有可用的受限页面。");
      if (operation === request.current) {
        setServiceFrame({ key: service.key, sourceRevision, url: issued.frameUrl, loading: false });
      }
    } catch (cause) {
      if (operation === request.current) {
        setServiceFrame({
          key: service.key,
          sourceRevision,
          loading: false,
          error: cause instanceof Error ? cause.message : "可视化服务页面不可用。",
        });
      }
    }
  };

  const runningVisualService = services.find((service) =>
    service.kind === "visual_run" && service.enabled);
  const runningVisualRevision = runningVisualService?.run?.lifecycleDigest
    ?? runningVisualService?.run?.updatedAt;
  useEffect(() => {
    if (!runningVisualService
      || (selectedServiceKey === runningVisualService.key
        && serviceFrame.sourceRevision === runningVisualRevision)) return;
    void selectService(runningVisualService);
  }, [runningVisualService?.key, runningVisualRevision, selectedServiceKey,
    serviceFrame.sourceRevision]);

  const previewService = services.find((service) => service.kind === "visual_preview");
  const previewRevision = browser
    ? `${browser.conversationGeneration}:${browser.pageGeneration}`
    : undefined;
  useEffect(() => {
    if (runningVisualService || !previewService?.enabled
      || (selectedServiceKey === previewService.key
        && serviceFrame.sourceRevision === previewRevision)) return;
    void selectService(previewService);
  }, [browser?.conversationGeneration, browser?.pageGeneration, browser?.projectedUrl,
    browser?.recoveryState, conversationId, previewService?.enabled, previewService?.key,
    runningVisualService?.key, selectedServiceKey, serviceFrame.sourceRevision]);

  const selected = files.find((file) => file.key === selectedKey);
  const modelingRequirements = files.find((file) =>
    file.source === "workspace" && file.relativePath === MODELING_REQUIREMENTS_PATH);
  const selectFile = async (file: WorkbenchFile) => {
    const operation = request.current + 1;
    request.current = operation;
    setSelectedKey(file.key);
    setResource(undefined);
    setError(undefined);
    setLoading(true);
    setSelectedServiceKey("");
    setServiceFrame({ key: "", loading: false });
    if (compact) {
      onFilesOpenChange(false);
      queueMicrotask(() => viewerRef.current?.focus());
    }
    try {
      const next = file.source === "run_output"
        ? await client.outputRenderable(workspace.owner.id, file.runId, file.outputId)
        : await (() => {
          if (!client.projectFileWorkbenchRenderable) {
            throw new Error("文件投影当前不可用；没有安全读取接口。");
          }
          return client.projectFileWorkbenchRenderable(workspace.owner.id, file.key.slice("workspace:".length));
        })();
      if (operation === request.current) setResource(next);
    } catch (cause) {
      if (operation === request.current) {
        setError(cause instanceof Error ? cause.message : "文件投影不可用。");
      }
    } finally {
      if (operation === request.current) setLoading(false);
    }
  };

  const openExperiments = () => {
    setExperimentsOpen(true);
    if (compact) {
      onFilesOpenChange(false);
      queueMicrotask(() => viewerRef.current?.focus());
    }
  };

  const returnToConversation = () => {
    request.current += 1;
    setSelectedKey("");
    setResource(undefined);
    setError(undefined);
    setLoading(false);
    setSelectedServiceKey("");
    setServiceFrame({ key: "", loading: false });
    fileToggleRef.current?.focus();
  };

  return <>
    <section ref={viewerRef}
      className={`riffology-stage3-viewer ${selected || selectedServiceKey || experimentsOpen ? "has-selection" : ""}`}
      aria-label="项目文件与页面查看器"
      tabIndex={-1}>
      {experimentsOpen ? <>
        <header className="riffology-viewer-header">
          <button type="button" className="riffology-viewer-return"
            onClick={() => setExperimentsOpen(false)}>← 返回文件与可视化</button>
          <strong>实验与运行</strong>
          <span>Project 操作</span>
        </header>
        <div className="riffology-experiment-workspace" role="region" aria-label="实验与运行">
          <WorkspacePane
            client={client}
            workspace={workspace}
            selectedConversationId={conversationId}
            refresh={refresh}
          />
        </div>
      </> : <>
      {(selected || selectedServiceKey) && <header className="riffology-viewer-header">
        <button type="button" className="riffology-viewer-back" onClick={returnToConversation}>← 返回对话</button>
        <strong>{selected?.relativePath ?? services.find((service) => service.key === selectedServiceKey)?.label}</strong>
        <span>{selected ? fileKind(selected.mediaType) : "实时服务"}</span>
      </header>}
      {!selected && <BrowserViewer
        ownerName={workspace.owner.name}
        ownerKind={workspace.owner.kind}
        fileCount={files.length}
        browser={browser}
        screenshot={browserScreenshot}
        error={browserError}
        busy={browserBusy}
        onReconnect={onBrowserReconnect}
        liveFrame={selectedServiceKey ? serviceFrame : undefined}
        modelingRequirements={modelingRequirements}
        onOpenModelingRequirements={(file) => void selectFile(file)}
      />}
      {selected && loading && <ViewerState title="正在读取受限文件投影…" />}
      {selected && !loading && error && <ViewerState title="文件不可用" detail={error} />}
      {selected && !loading && !error && resource && <div className="riffology-renderer-wrap">
        <RendererRegistry resource={resource} />
      </div>}
      </>}
    </section>
    <ProjectFileRail
      ownerKind={workspace.owner.kind}
      files={files}
      selectedKey={selectedKey}
      open={filesOpen}
      compact={compact}
      onOpenChange={onFilesOpenChange}
      onSelect={(file) => {
        setExperimentsOpen(false);
        void selectFile(file);
      }}
      services={services}
      selectedServiceKey={selectedServiceKey}
      onSelectService={(service) => {
        setExperimentsOpen(false);
        void selectService(service);
      }}
      experimentsOpen={experimentsOpen}
      experimentCount={workspace.experimentConfigurations.length}
      runCount={workspace.runs.length}
      onOpenExperiments={openExperiments}
      fileToggleRef={fileToggleRef}
    />
  </>;
}

function BrowserViewer({
  ownerName,
  ownerKind,
  fileCount,
  browser,
  screenshot,
  error,
  busy,
  onReconnect,
  liveFrame,
  modelingRequirements,
  onOpenModelingRequirements,
}: Readonly<{
  ownerName: string;
  ownerKind: "project";
  fileCount: number;
  browser?: BrowserSessionDto;
  screenshot?: string;
  error?: string;
  busy: boolean;
  onReconnect: () => void;
  liveFrame?: Readonly<{ key: string; url?: string; loading: boolean; error?: string }>;
  modelingRequirements?: WorkbenchFile;
  onOpenModelingRequirements: (file: WorkbenchFile) => void;
}>) {
  if (liveFrame?.url && !liveFrame.loading) {
    return <div className="riffology-live-service">
      <iframe
        title="可视化仿真服务"
        src={liveFrame.url}
        sandbox="allow-scripts allow-same-origin"
        referrerPolicy="no-referrer"
      />
    </div>;
  }
  if (liveFrame?.loading) return <ViewerState title="正在连接可视化仿真服务…" />;
  if (liveFrame?.error) {
    return <div className="riffology-viewer-state" role="status">
      <h2>可视化仿真服务不可用</h2>
      <p>{liveFrame.error}</p>
    </div>;
  }
  if (screenshot && browser?.recoveryState === "ready") {
    return <div className="riffology-browser-observation" role="status">
      <img src={screenshot} alt={`${ownerName} 的受信浏览器页面观察`} />
      <small>只读 Chromium 观察 · 页面 generation {browser.pageGeneration}</small>
    </div>;
  }
  if (busy) return <ViewerState title="正在连接本地浏览器…" />;
  if (browser?.recoveryState === "disconnected" || browser?.recoveryState === "unavailable") {
    return <div className="riffology-viewer-state" role="status">
      <h2>浏览器连接已中断</h2>
      <p>{error ?? "可以恢复同一 Conversation generation 的受信页面。"}</p>
      <button type="button" onClick={onReconnect}>重新连接</button>
    </div>;
  }
  if (browser?.recoveryState === "expired") {
    return <ViewerState title="浏览器会话已过期" detail="刷新工作台以创建新的只读观察会话。" />;
  }
  return <ViewerEmpty ownerName={ownerName} ownerKind={ownerKind} fileCount={fileCount}
    detail={error} modelingRequirements={modelingRequirements}
    onOpenModelingRequirements={onOpenModelingRequirements} />;
}

function ViewerEmpty({ ownerName, ownerKind, fileCount, detail, modelingRequirements,
  onOpenModelingRequirements }: Readonly<{
  ownerName: string;
  ownerKind: "project";
  fileCount: number;
  detail?: string;
  modelingRequirements?: WorkbenchFile;
  onOpenModelingRequirements: (file: WorkbenchFile) => void;
}>) {
  return <div className="riffology-viewer-empty" role="status">
    <p className="product-eyebrow">RIFF {ownerKind.toUpperCase()} · READ ONLY</p>
    <h1>{ownerName}</h1>
    <p>{detail ?? "从最右侧文件栏选择一个 Project 工作区文件。"}</p>
    {modelingRequirements ? <button type="button"
      onClick={() => onOpenModelingRequirements(modelingRequirements)}>查看建模需求</button>
      : <p>尚无 <code>{MODELING_REQUIREMENTS_PATH}</code>；可通过 <code>/domain-brief</code> 显式创建。</p>}
    <small>{fileCount} 个可用文件 · 内容由 Riff 的只读 renderable 投影提供。</small>
  </div>;
}

function ViewerState({ title, detail }: Readonly<{ title: string; detail?: string }>) {
  return <div className="riffology-viewer-state" role="status"><h2>{title}</h2>{detail && <p>{detail}</p>}</div>;
}

function ProjectFileRail({
  ownerKind,
  files,
  selectedKey,
  open,
  compact,
  onOpenChange,
  onSelect,
  services,
  selectedServiceKey,
  onSelectService,
  experimentsOpen,
  experimentCount,
  runCount,
  onOpenExperiments,
  fileToggleRef,
}: Readonly<{
  ownerKind: "project";
  files: readonly WorkbenchFile[];
  selectedKey: string;
  open: boolean;
  compact: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (file: WorkbenchFile) => void;
  services: readonly WorkbenchService[];
  selectedServiceKey: string;
  onSelectService: (service: WorkbenchService) => void;
  experimentsOpen: boolean;
  experimentCount: number;
  runCount: number;
  onOpenExperiments: () => void;
  fileToggleRef: RefObject<HTMLButtonElement | null>;
}>) {
  const [width, setWidth] = useState(RAIL_MIN);
  const drag = useRef<Readonly<{ x: number; width: number }> | null>(null);
  const railRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const tree = buildFileTree(files);
  const projectFileCount = files.filter((file) => file.source === "workspace").length;
  const runOutputCount = files.length - projectFileCount;
  const close = () => {
    onOpenChange(false);
    queueMicrotask(() => fileToggleRef.current?.focus());
  };
  const resize = (delta: number) => setWidth((current) => clamp(current + delta));
  const onResizeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft") { event.preventDefault(); resize(16); }
    if (event.key === "ArrowRight") { event.preventDefault(); resize(-16); }
    if (event.key === "Home") { event.preventDefault(); setWidth(RAIL_MIN); }
    if (event.key === "End") { event.preventDefault(); setWidth(RAIL_MAX); }
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    drag.current = { x: event.clientX, width };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    setWidth(clamp(drag.current.width + drag.current.x - event.clientX));
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };
  const onRailKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (!compact || event.key !== "Tab") return;
    const focusable = Array.from(railRef.current?.querySelectorAll<HTMLElement>(
      "button:not([disabled]), summary, [tabindex='0']",
    ) ?? []).filter((element) => element.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  useEffect(() => {
    if (open && compact) queueMicrotask(() => closeRef.current?.focus());
  }, [compact, open]);

  return <>
    {compact && open && <button type="button" className="riffology-file-backdrop"
      aria-label={`关闭${ownerKind === "project" ? "项目" : "模型"}文件`} onClick={close} />}
    <aside
      id="riffology-owner-files"
      ref={railRef}
      className={`riffology-file-rail ${open ? "is-open" : "is-closed"}`}
      aria-label={ownerKind === "project" ? "项目文件" : "模型文件"}
      aria-hidden={!open}
      inert={!open ? true : undefined}
      role={compact ? "dialog" : undefined}
      aria-modal={compact && open ? true : undefined}
      onKeyDown={onRailKeyDown}
      style={{ "--riffology-file-rail-width": `${width}px` } as CSSProperties}
    >
      <div className="riffology-file-resizer" role="separator" aria-orientation="vertical"
        aria-label="调整文件栏宽度" aria-valuemin={RAIL_MIN} aria-valuemax={RAIL_MAX}
        aria-valuenow={width} tabIndex={open && !compact ? 0 : -1} onKeyDown={onResizeKeyDown}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} />
      <header><div><strong>文件</strong><span>{projectFileCount} 个 Project 文件
        {runOutputCount > 0 ? ` · ${runOutputCount} 个冻结 Run 输出` : ""}</span></div>
        <button ref={closeRef} type="button" onClick={close} aria-label="收起文件栏">收起</button>
      </header>
      <button type="button" className="riffology-experiments-entry"
        aria-pressed={experimentsOpen} onClick={onOpenExperiments}>
        <i aria-hidden="true" />
        <span><strong>实验与运行</strong>
          <small>{experimentCount} 个配置 · {runCount} 次 Run</small></span>
      </button>
      {tree.length > 0 && <ul className="riffology-file-tree" aria-label="只读项目文件">
        <FileTree entries={tree} selectedKey={selectedKey} onSelect={onSelect} />
      </ul>}
      {tree.length === 0 && <p className="riffology-file-empty">没有可展示的 Project 文件。</p>}
      <section className="riffology-service-section" aria-labelledby="riffology-service-heading">
        <div className="riffology-service-heading">
          <strong id="riffology-service-heading">运行服务</strong>
          <span>{services.filter((service) => service.status === "运行中" || service.status === "已连接").length} 个在线</span>
        </div>
        <ul aria-label="运行服务">
          {services.map((service) => <li key={service.key}>
            <button
              type="button"
              disabled={!service.enabled}
              aria-current={selectedServiceKey === service.key ? "page" : undefined}
              onClick={() => onSelectService(service)}
            >
              <i className={`is-${service.kind} ${service.status === "运行中" || service.status === "已连接" ? "is-online" : ""}`} aria-hidden="true" />
              <span><strong>{service.label}</strong><small>{service.status}</small></span>
            </button>
          </li>)}
        </ul>
      </section>
      <footer><i aria-hidden="true" />项目结构 · 只读投影</footer>
    </aside>
  </>;
}

function FileTree({ entries, selectedKey, onSelect }: Readonly<{
  entries: readonly FileTreeEntry[];
  selectedKey: string;
  onSelect: (file: WorkbenchFile) => void;
}>) {
  return <>{entries.map((entry) => entry.kind === "folder"
    ? <li key={`folder:${entry.path}`} className="riffology-file-folder">
      <details open><summary>{entry.name}</summary>
        <ul><FileTree entries={entry.children} selectedKey={selectedKey} onSelect={onSelect} /></ul>
      </details>
    </li>
    : <li key={entry.file.key} className="riffology-file-entry">
      <button type="button" aria-current={entry.file.key === selectedKey ? "page" : undefined}
        onClick={() => onSelect(entry.file)}>
        <span>{entry.name}</span><small>{fileLabel(entry.file)}</small>
      </button>
    </li>)}</>;
}

const buildFileTree = (files: readonly WorkbenchFile[]): readonly FileTreeEntry[] => {
  const root: MutableFileTreeNode = { folders: new Map(), files: [] };
  for (const file of files) {
    const parts = file.relativePath.split("/");
    let node = root;
    for (const folder of parts.slice(0, -1)) {
      let child = node.folders.get(folder);
      if (!child) {
        child = { folders: new Map(), files: [] };
        node.folders.set(folder, child);
      }
      node = child;
    }
    node.files.push(file);
  }
  const entries = (node: MutableFileTreeNode, parentPath: string): FileTreeEntry[] => [
    ...Array.from(node.folders.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, child]) => {
        const path = parentPath ? `${parentPath}/${name}` : name;
        return { kind: "folder" as const, name, path, children: entries(child, path) };
      }),
    ...node.files
      .slice()
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
      .map((file) => ({ kind: "file" as const, name: file.relativePath.split("/").at(-1)!, file })),
  ];
  return entries(root, "");
};

const safeRelativePath = (path: string): string | null => {
  if (!path || path.length > 300 || path.startsWith("/") || path.includes("\\")
    || /^[a-z]:/iu.test(path) || /[\u0000-\u001f\u007f]/u.test(path)) return null;
  const parts = path.split("/");
  if (parts.length > 64 || parts.some((part) => !part || part === "." || part === ".." || part.length > 100)) {
    return null;
  }
  return path;
};

const useCompactLayout = (): boolean => {
  const [compact, setCompact] = useState(() =>
    typeof globalThis.matchMedia === "function" && globalThis.matchMedia("(max-width: 760px)").matches);
  useEffect(() => {
    const query = globalThis.matchMedia?.("(max-width: 760px)");
    if (!query) return;
    const update = () => setCompact(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return compact;
};

const clamp = (value: number) => Math.min(RAIL_MAX, Math.max(RAIL_MIN, value));
const fileKind = (mediaType: string) => mediaType === "text/html" ? "HTML"
  : mediaType === "text/markdown" ? "MD"
    : mediaType === "application/json" ? "JSON"
      : mediaType === "text/csv" ? "CSV" : mediaType;
const fileLabel = (file: WorkbenchFile) => `${file.source === "run_output" ? "冻结 Run 输出 · " : ""}${fileKind(file.mediaType)} · ${formatBytes(file.sizeBytes)}`;
const formatBytes = (bytes: number) => bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
