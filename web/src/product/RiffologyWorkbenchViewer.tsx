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
import type { BrowserSessionDto, ProjectWorkspaceDto, WorkspaceDto } from "./types";

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
}: Readonly<{
  client: ProductClient;
  workspace: WorkspaceDto;
  filesOpen: boolean;
  onFilesOpenChange: (open: boolean) => void;
  fileToggleRef: RefObject<HTMLButtonElement | null>;
  browser?: BrowserSessionDto;
  browserScreenshot?: string;
  browserError?: string;
  browserBusy: boolean;
  onBrowserReconnect: () => void;
}>) {
  const runOutputFiles = workspace.owner.kind === "project"
    ? (workspace as ProjectWorkspaceDto).runs.flatMap((run) =>
      run.status === "succeeded" ? run.outputs.flatMap((output): WorkbenchFile[] => {
        const name = (safeRelativePath(output.logicalName) ?? "").split("/").at(-1) ?? "";
        return name ? [{ key: `output:${run.id}:${output.id}`, source: "run_output",
          runId: run.id, outputId: output.id,
          relativePath: `outputs/${run.id}/${name}${output.sampleIndex === null ? "" : `-${output.sampleIndex}`}`,
          mediaType: output.mediaType, sizeBytes: output.sizeBytes }] : [];
      }) : []) : [];
  const files = workspace.files.flatMap((file): WorkbenchFile[] => {
    const relativePath = safeRelativePath(file.relativePath ?? "");
    return relativePath ? [{
      key: `workspace:${"fileRef" in file ? file.fileRef : file.id}`,
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
  const request = useRef(0);
  const viewerRef = useRef<HTMLElement>(null);

  useEffect(() => {
    request.current += 1;
    setSelectedKey("");
    setResource(undefined);
    setError(undefined);
  }, [workspace.owner.id, "modelSnapshotDigest" in workspace
    ? workspace.modelSnapshotDigest : workspace.digest]);

  const selected = files.find((file) => file.key === selectedKey);
  const selectFile = async (file: WorkbenchFile) => {
    const operation = request.current + 1;
    request.current = operation;
    setSelectedKey(file.key);
    setResource(undefined);
    setError(undefined);
    setLoading(true);
    if (compact) {
      onFilesOpenChange(false);
      queueMicrotask(() => viewerRef.current?.focus());
    }
    try {
      const next = file.source === "run_output"
        ? await client.outputRenderable(workspace.owner.id, file.runId, file.outputId)
        : workspace.owner.kind === "project"
        ? await (() => {
          if (!client.projectFileWorkbenchRenderable) {
            throw new Error("文件投影当前不可用；没有安全读取接口。");
          }
          return client.projectFileWorkbenchRenderable(workspace.owner.id, file.key.slice("workspace:".length));
        })()
        : client.modelWorkbenchRenderable
          ? await client.modelWorkbenchRenderable(
            workspace.owner.id,
            file.key.slice("workspace:".length),
          )
          : await client.modelRenderable(workspace.owner.id, file.key.slice("workspace:".length));
      if (operation === request.current) setResource(next);
    } catch (cause) {
      if (operation === request.current) {
        setError(cause instanceof Error ? cause.message : "文件投影不可用。");
      }
    } finally {
      if (operation === request.current) setLoading(false);
    }
  };

  const returnToConversation = () => {
    request.current += 1;
    setSelectedKey("");
    setResource(undefined);
    setError(undefined);
    setLoading(false);
    fileToggleRef.current?.focus();
  };

  return <>
    <section ref={viewerRef}
      className={`riffology-stage3-viewer ${selected ? "has-selection" : ""}`}
      aria-label={workspace.owner.kind === "project" ? "项目文件与页面查看器" : "模型文件与页面查看器"}
      tabIndex={-1}>
      {selected && <header className="riffology-viewer-header">
        <button type="button" className="riffology-viewer-back" onClick={returnToConversation}>← 返回对话</button>
        <strong>{selected.relativePath}</strong>
        <span>{fileKind(selected.mediaType)}</span>
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
      />}
      {selected && loading && <ViewerState title="正在读取受限文件投影…" />}
      {selected && !loading && error && <ViewerState title="文件不可用" detail={error} />}
      {selected && !loading && !error && resource && <div className="riffology-renderer-wrap">
        <RendererRegistry resource={resource} />
      </div>}
    </section>
    <ProjectFileRail
      ownerKind={workspace.owner.kind}
      files={files}
      selectedKey={selectedKey}
      open={filesOpen}
      compact={compact}
      onOpenChange={onFilesOpenChange}
      onSelect={(file) => void selectFile(file)}
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
}: Readonly<{
  ownerName: string;
  ownerKind: "model" | "project";
  fileCount: number;
  browser?: BrowserSessionDto;
  screenshot?: string;
  error?: string;
  busy: boolean;
  onReconnect: () => void;
}>) {
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
  return <ViewerEmpty ownerName={ownerName} ownerKind={ownerKind} fileCount={fileCount} detail={error} />;
}

function ViewerEmpty({ ownerName, ownerKind, fileCount, detail }: Readonly<{
  ownerName: string;
  ownerKind: "model" | "project";
  fileCount: number;
  detail?: string;
}>) {
  return <div className="riffology-viewer-empty" role="status">
    <p className="product-eyebrow">RIFF {ownerKind.toUpperCase()} · READ ONLY</p>
    <h1>{ownerName}</h1>
    <p>{detail ?? `从最右侧文件栏选择一个已声明的 ${ownerKind === "project" ? "Project 快照" : "Model"} 文件。`}</p>
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
  fileToggleRef,
}: Readonly<{
  ownerKind: "model" | "project";
  files: readonly WorkbenchFile[];
  selectedKey: string;
  open: boolean;
  compact: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (file: WorkbenchFile) => void;
  fileToggleRef: RefObject<HTMLButtonElement | null>;
}>) {
  const [width, setWidth] = useState(RAIL_MIN);
  const drag = useRef<Readonly<{ x: number; width: number }> | null>(null);
  const railRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const tree = buildFileTree(files);
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
      <header><div><strong>文件</strong><span>{files.length} 个 {ownerKind === "project" ? "Project 快照" : "Model"}文件</span></div>
        <button ref={closeRef} type="button" onClick={close} aria-label="收起文件栏">收起</button>
      </header>
      {tree.length > 0 && <ul className="riffology-file-tree" aria-label="只读项目文件">
        <FileTree entries={tree} selectedKey={selectedKey} onSelect={onSelect} />
      </ul>}
      {tree.length === 0 && <p className="riffology-file-empty">没有可展示的 {ownerKind === "project" ? "Project 快照" : "Model"}文件。</p>}
      <footer><i aria-hidden="true" />{ownerKind === "project" ? "项目" : "模型"}结构 · 只读投影</footer>
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
const fileLabel = (file: WorkbenchFile) => `${fileKind(file.mediaType)} · ${formatBytes(file.sizeBytes)}`;
const formatBytes = (bytes: number) => bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
