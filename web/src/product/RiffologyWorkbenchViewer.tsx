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
import type { ProjectWorkspaceDto } from "./types";

type WorkbenchFile = Readonly<{
  key: string;
  relativePath: string;
  mediaType: string;
  sizeBytes: number;
}>;

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
}: Readonly<{
  client: ProductClient;
  workspace: ProjectWorkspaceDto;
  filesOpen: boolean;
  onFilesOpenChange: (open: boolean) => void;
  fileToggleRef: RefObject<HTMLButtonElement | null>;
}>) {
  const files = workspace.files.flatMap((file): WorkbenchFile[] => {
    const relativePath = safeRelativePath(file.relativePath);
    return relativePath ? [{
      key: file.fileRef,
      relativePath,
      mediaType: file.mediaType,
      sizeBytes: file.sizeBytes,
    }] : [];
  });
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
  }, [workspace.owner.id, workspace.modelSnapshotDigest]);

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
      if (!client.projectFileWorkbenchRenderable) {
        throw new Error("文件投影当前不可用；没有安全读取接口。");
      }
      const next = await client.projectFileWorkbenchRenderable(workspace.owner.id, file.key);
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
      aria-label="项目文件与页面查看器" tabIndex={-1}>
      {selected && <header className="riffology-viewer-header">
        <button type="button" className="riffology-viewer-back" onClick={returnToConversation}>← 返回对话</button>
        <strong>{selected.relativePath}</strong>
        <span>{fileKind(selected.mediaType)}</span>
      </header>}
      {!selected && <ViewerEmpty projectName={workspace.owner.name} fileCount={files.length} />}
      {selected && loading && <ViewerState title="正在读取受限文件投影…" />}
      {selected && !loading && error && <ViewerState title="文件不可用" detail={error} />}
      {selected && !loading && !error && resource && <div className="riffology-renderer-wrap">
        <RendererRegistry resource={resource} />
      </div>}
    </section>
    <ProjectFileRail
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

function ViewerEmpty({ projectName, fileCount }: Readonly<{ projectName: string; fileCount: number }>) {
  return <div className="riffology-viewer-empty" role="status">
    <p className="product-eyebrow">RIFF PROJECT · READ ONLY</p>
    <h1>{projectName}</h1>
    <p>从最右侧文件栏选择一个已声明的 Project 快照文件。</p>
    <small>{fileCount} 个可用文件 · 内容由 Riff 的只读 renderable 投影提供。</small>
  </div>;
}

function ViewerState({ title, detail }: Readonly<{ title: string; detail?: string }>) {
  return <div className="riffology-viewer-state" role="status"><h2>{title}</h2>{detail && <p>{detail}</p>}</div>;
}

function ProjectFileRail({
  files,
  selectedKey,
  open,
  compact,
  onOpenChange,
  onSelect,
  fileToggleRef,
}: Readonly<{
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
      aria-label="关闭项目文件" onClick={close} />}
    <aside
      id="riffology-project-files"
      ref={railRef}
      className={`riffology-file-rail ${open ? "is-open" : "is-closed"}`}
      aria-label="项目文件"
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
      <header><div><strong>文件</strong><span>{files.length} 个 Project 快照</span></div>
        <button ref={closeRef} type="button" onClick={close} aria-label="收起文件栏">收起</button>
      </header>
      {tree.length > 0 && <ul className="riffology-file-tree" aria-label="只读项目文件">
        <FileTree entries={tree} selectedKey={selectedKey} onSelect={onSelect} />
      </ul>}
      {tree.length === 0 && <p className="riffology-file-empty">没有可展示的 Project 快照文件。</p>}
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
const fileLabel = (file: WorkbenchFile) => `${fileKind(file.mediaType)} · ${formatBytes(file.sizeBytes)}`;
const formatBytes = (bytes: number) => bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
