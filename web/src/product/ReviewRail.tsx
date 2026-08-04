import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { RendererRegistry, type RendererResource } from "./RendererRegistry";
import type {
  ProjectChangeSet,
  ProjectMutationReceipt,
} from "./types";

export type ReviewFile = Readonly<{
  key: string;
  relativePath: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
}>;

type RailMode = "files" | "changes";

export function ReviewRail({
  ownerKey,
  files,
  changeSets = [],
  sourceTarget,
  loadFile,
  onApply,
  onReject,
}: Readonly<{
  ownerKey: string;
  files: readonly ReviewFile[];
  changeSets?: readonly ProjectChangeSet[];
  sourceTarget?: Readonly<{ relativePath: string; requestId: number }>;
  loadFile: (file: ReviewFile) => Promise<RendererResource>;
  onApply?: (changeSet: ProjectChangeSet) => Promise<ProjectMutationReceipt>;
  onReject?: (changeSet: ProjectChangeSet) => Promise<ProjectMutationReceipt>;
}>) {
  const narrow = useNarrowRail();
  const hasFiles = files.length > 0;
  const hasChanges = changeSets.length > 0;
  const [open, setOpen] = useState(() => !narrow);
  const [mode, setMode] = useState<RailMode>(() => hasFiles ? "files" : "changes");
  const [width, setWidth] = useState(360);
  const [selectedFileKey, setSelectedFileKey] = useState(files[0]?.key ?? "");
  const [selectedChangeSetId, setSelectedChangeSetId] = useState(
    changeSets.find((item) => item.state === "pending")?.id ?? changeSets[0]?.id ?? "",
  );
  const [selectedChangeItemId, setSelectedChangeItemId] = useState("");
  const [fileRenderable, setFileRenderable] = useState<RendererResource>();
  const [currentRenderable, setCurrentRenderable] = useState<RendererResource>();
  const [error, setError] = useState<string>();
  const [resolving, setResolving] = useState(false);
  const [receipt, setReceipt] = useState<ProjectMutationReceipt>();
  const [reviewed, setReviewed] = useState<Record<string, readonly string[]>>({});
  const railRef = useRef<HTMLElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const fileRequest = useRef(0);
  const changeFileRequest = useRef(0);
  const loadFileRef = useRef(loadFile);
  loadFileRef.current = loadFile;
  const drag = useRef<Readonly<{ x: number; width: number }> | null>(null);
  const responsiveState = useRef({ narrow, open });
  responsiveState.current = { narrow, open };

  const selectedFile = files.find((file) => file.key === selectedFileKey);
  const selectedChangeSet = changeSets.find((item) => item.id === selectedChangeSetId);
  const selectedChangeItem = selectedChangeSet?.files.find(
    (item) => item.itemId === selectedChangeItemId,
  ) ?? selectedChangeSet?.files[0];
  const reviewedItems = new Set(
    selectedChangeSet ? reviewed[selectedChangeSet.id] ?? [] : [],
  );

  useEffect(() => {
    fileRequest.current += 1;
    changeFileRequest.current += 1;
    setError(undefined);
    setReceipt(undefined);
  }, [ownerKey]);

  useLayoutEffect(() => {
    if (narrow) setOpen(false);
  }, [narrow, ownerKey]);

  useEffect(() => {
    if (!hasFiles && !hasChanges) return;
    if (!hasFiles && mode === "files") setMode("changes");
    if (!hasChanges && mode === "changes") setMode("files");
  }, [hasChanges, hasFiles, mode]);

  useEffect(() => {
    if (!files.some((file) => file.key === selectedFileKey)) {
      setSelectedFileKey(files[0]?.key ?? "");
    }
  }, [files, selectedFileKey]);

  useEffect(() => {
    if (!changeSets.some((item) => item.id === selectedChangeSetId)) {
      setSelectedChangeSetId(
        changeSets.find((item) => item.state === "pending")?.id
          ?? changeSets[0]?.id
          ?? "",
      );
    }
  }, [changeSets, selectedChangeSetId]);

  useEffect(() => {
    setSelectedChangeItemId(selectedChangeSet?.files[0]?.itemId ?? "");
  }, [selectedChangeSet?.id]);

  useEffect(() => {
    if (!sourceTarget) return;
    const target = files.find((file) => file.relativePath === sourceTarget.relativePath);
    if (!target) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && !railRef.current?.contains(active)) {
      openerRef.current = active;
    }
    setSelectedFileKey(target.key);
    setMode("files");
    setOpen(true);
    requestAnimationFrame(() => closeRef.current?.focus());
  }, [files, sourceTarget]);

  useEffect(() => {
    const request = ++fileRequest.current;
    setFileRenderable(undefined);
    if (!selectedFile) return;
    void loadFileRef.current(selectedFile).then((resource) => {
      if (fileRequest.current === request) setFileRenderable(resource);
    }).catch((cause) => {
      if (fileRequest.current === request) {
        setError(messageOf(cause, "The file could not be previewed."));
      }
    });
  }, [ownerKey, selectedFile?.key]);

  useEffect(() => {
    const request = ++changeFileRequest.current;
    setCurrentRenderable(undefined);
    if (!selectedChangeItem) return;
    const current = files.find(
      (file) => file.relativePath === selectedChangeItem.relativePath,
    );
    if (!current) return;
    void loadFileRef.current(current).then((resource) => {
      if (changeFileRequest.current === request) setCurrentRenderable(resource);
    }).catch((cause) => {
      if (changeFileRequest.current === request) {
        setError(messageOf(cause, "Current file content could not be previewed."));
      }
    });
  }, [files, ownerKey, selectedChangeItem?.itemId]);

  useEffect(() => {
    if (!open) return;
    if (!responsiveState.current.open
      || responsiveState.current.narrow !== narrow) return;
    const rail = railRef.current;
    const inerted = narrow && rail ? inertOutsideDialog(rail) : [];
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        return;
      }
      if (!narrow || event.key !== "Tab" || !rail) return;
      const focusable = focusableElements(rail);
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    const focusFrame = openerRef.current === null
      ? undefined
      : requestAnimationFrame(() => closeRef.current?.focus());
    return () => {
      const shouldRestoreFocus = rail?.contains(document.activeElement) ?? false;
      if (focusFrame !== undefined) cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", onKeyDown);
      restoreInert(inerted);
      if (!shouldRestoreFocus) return;
      requestAnimationFrame(() => {
        const opener = openerRef.current;
        if (opener?.isConnected) opener.focus();
        else triggerRef.current?.focus();
        openerRef.current = null;
      });
    };
  }, [narrow, open]);

  if (!hasFiles && !hasChanges) return null;

  const resizeByKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const maximum = railMaximumWidth();
    if (event.key === "ArrowLeft") setWidth((value) => clamp(value + 16, 280, maximum));
    else if (event.key === "ArrowRight") setWidth((value) => clamp(value - 16, 280, maximum));
    else if (event.key === "Home") setWidth(280);
    else if (event.key === "End") setWidth(maximum);
    else return;
    event.preventDefault();
  };

  const beginResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = { x: event.clientX, width };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const resize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    setWidth(clamp(
      drag.current.width - (event.clientX - drag.current.x),
      280,
      railMaximumWidth(),
    ));
  };
  const endResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const resolve = async (
    operation: "apply" | "reject",
    changeSet: ProjectChangeSet,
  ) => {
    const action = operation === "apply" ? onApply : onReject;
    if (!action) return;
    setResolving(true);
    setError(undefined);
    setReceipt(undefined);
    try {
      const nextReceipt = await action(changeSet);
      setReceipt(nextReceipt);
    } catch (cause) {
      setError(messageOf(cause, operation === "apply"
        ? "The change set could not be applied."
        : "The change set could not be rejected."));
    } finally {
      setResolving(false);
    }
  };

  return (
    <>
      {!open && (
        <button
          ref={triggerRef}
          type="button"
          className="product-review-rail-trigger product-secondary"
          onClick={(event) => {
            openerRef.current = event.currentTarget;
            setOpen(true);
          }}
          aria-label="Open file and change review"
        >
          Review{hasChanges ? ` · ${changeSets.filter((item) => item.state === "pending").length}` : ""}
        </button>
      )}
      {narrow && open && (
        <button
          type="button"
          className="product-review-rail-backdrop"
          aria-hidden="true"
          tabIndex={-1}
          onClick={() => setOpen(false)}
        />
      )}
      <aside
        ref={railRef}
        className="product-review-rail"
        aria-label="File and change review"
        aria-modal={narrow && open ? "true" : undefined}
        role={narrow && open ? "dialog" : undefined}
        data-open={open}
        data-narrow={narrow}
        style={{ "--product-review-rail-width": `${width}px` } as CSSProperties}
      >
        {open && !narrow && (
          <div
            className="product-review-rail-resizer"
            role="separator"
            aria-label="Resize review rail"
            aria-orientation="vertical"
            aria-valuemin={280}
            aria-valuemax={railMaximumWidth()}
            aria-valuenow={width}
            tabIndex={0}
            onKeyDown={resizeByKeyboard}
            onPointerDown={beginResize}
            onPointerMove={resize}
            onPointerUp={endResize}
            onPointerCancel={endResize}
          />
        )}
        <header>
          <strong>Review</strong>
          <button
            ref={closeRef}
            type="button"
            className="product-link-button"
            onClick={() => setOpen(false)}
          >
            Close
          </button>
        </header>
        <div className="product-review-rail-modes" role="group" aria-label="Review mode">
          {hasFiles && (
            <button
              type="button"
              aria-pressed={mode === "files"}
              onClick={() => setMode("files")}
            >
              Files
            </button>
          )}
          {hasChanges && (
            <button
              type="button"
              aria-pressed={mode === "changes"}
              onClick={() => setMode("changes")}
            >
              Changes · {changeSets.filter((item) => item.state === "pending").length}
            </button>
          )}
        </div>
        {error && <p className="product-form-error" role="alert">{error}</p>}
        {receipt?.operation === "apply" && (
          <p className="product-review-receipt" role="status">
            <strong>Applied</strong>
            <span>Committed receipt <code>{receipt.receiptDigest}</code></span>
          </p>
        )}
        {receipt?.operation === "reject" && (
          <p className="product-review-receipt" role="status">
            <strong>Rejected</strong>
            <span>Decision receipt <code>{receipt.receiptDigest}</code></span>
          </p>
        )}
        <div className="product-review-rail-body">
          {mode === "files" && (
            <FileReview
              files={files}
              selectedFileKey={selectedFileKey}
              setSelectedFileKey={setSelectedFileKey}
              renderable={fileRenderable}
            />
          )}
          {mode === "changes" && selectedChangeSet && (
            <ChangeReview
              changeSets={changeSets}
              selectedChangeSet={selectedChangeSet}
              setSelectedChangeSetId={setSelectedChangeSetId}
              selectedItem={selectedChangeItem}
              setSelectedItemId={setSelectedChangeItemId}
              currentRenderable={currentRenderable}
              reviewedItems={reviewedItems}
              markReviewed={(itemId) => setReviewed((current) => ({
                ...current,
                [selectedChangeSet.id]: [
                  ...new Set([...(current[selectedChangeSet.id] ?? []), itemId]),
                ],
              }))}
              resolving={resolving}
              onApply={onApply ? () => void resolve("apply", selectedChangeSet) : undefined}
              onReject={onReject ? () => void resolve("reject", selectedChangeSet) : undefined}
            />
          )}
        </div>
      </aside>
    </>
  );
}

function FileReview({
  files,
  selectedFileKey,
  setSelectedFileKey,
  renderable,
}: Readonly<{
  files: readonly ReviewFile[];
  selectedFileKey: string;
  setSelectedFileKey: (key: string) => void;
  renderable?: RendererResource;
}>) {
  return (
    <>
      <ul className="product-file-tree" aria-label="Workspace files">
        {[...files].sort((left, right) =>
          left.relativePath.localeCompare(right.relativePath)).map((file) => (
          <li key={file.key}>
            <button
              type="button"
              aria-pressed={file.key === selectedFileKey}
              onClick={() => setSelectedFileKey(file.key)}
              style={{ paddingInlineStart: `${.7 + pathDepth(file.relativePath) * .7}rem` }}
            >
              <span>{file.relativePath}</span>
              <small>{file.sizeBytes} bytes</small>
            </button>
          </li>
          ))}
      </ul>
      {renderable
        ? <RendererRegistry resource={renderable} />
        : <p className="product-empty" role="status">Select a file to preview it safely.</p>}
    </>
  );
}

function ChangeReview({
  changeSets,
  selectedChangeSet,
  setSelectedChangeSetId,
  selectedItem,
  setSelectedItemId,
  currentRenderable,
  reviewedItems,
  markReviewed,
  resolving,
  onApply,
  onReject,
}: Readonly<{
  changeSets: readonly ProjectChangeSet[];
  selectedChangeSet: ProjectChangeSet;
  setSelectedChangeSetId: (id: string) => void;
  selectedItem?: ProjectChangeSet["files"][number];
  setSelectedItemId: (id: string) => void;
  currentRenderable?: RendererResource;
  reviewedItems: ReadonlySet<string>;
  markReviewed: (itemId: string) => void;
  resolving: boolean;
  onApply?: () => void;
  onReject?: () => void;
}>) {
  const reviewedCount = selectedChangeSet.files.filter(
    (file) => reviewedItems.has(file.itemId),
  ).length;
  return (
    <>
      <label className="product-review-select">
        Change set
        <select
          value={selectedChangeSet.id}
          onChange={(event) => setSelectedChangeSetId(event.target.value)}
        >
          {changeSets.map((changeSet) => (
            <option key={changeSet.id} value={changeSet.id}>
              {changeSet.state} · {changeSet.files.length} files · {changeSet.id}
            </option>
          ))}
        </select>
      </label>
      <div className="product-review-state">
        <span className={`product-badge product-badge-${selectedChangeSet.freshness}`}>
          {selectedChangeSet.freshness}
        </span>
        <span>{reviewedCount} / {selectedChangeSet.files.length} files reviewed</span>
      </div>
      <ul className="product-change-files" aria-label="Changed files">
        {selectedChangeSet.files.map((file) => (
          <li key={file.itemId}>
          <button
            type="button"
            aria-pressed={file.itemId === selectedItem?.itemId}
            onClick={() => setSelectedItemId(file.itemId)}
          >
            <span>{file.kind} · {file.relativePath}</span>
            <small>{reviewedItems.has(file.itemId) ? "reviewed" : "unreviewed"}</small>
          </button>
          </li>
        ))}
      </ul>
      {selectedItem && (
        <section className="product-diff-review" aria-label={`Diff for ${selectedItem.relativePath}`}>
          <h4>{selectedItem.relativePath}</h4>
          <div className="product-diff-columns">
            <div>
              <strong>Current content</strong>
              <small>{selectedItem.priorSha256 ?? "new file"}</small>
              <pre>{renderableText(currentRenderable) ?? (
                selectedItem.priorSha256 === null
                  ? "This file does not exist in the current Project."
                  : "Current text preview is unavailable."
              )}</pre>
            </div>
            <div>
              <strong>Proposed content</strong>
              <small>{selectedItem.proposedSha256}</small>
              <pre>{selectedItem.proposedText || "This proposal removes the file content."}</pre>
            </div>
          </div>
          <button
            type="button"
            className="product-secondary"
            onClick={() => markReviewed(selectedItem.itemId)}
          >
            Mark file reviewed
          </button>
        </section>
      )}
      {selectedChangeSet.state === "pending" && (
        <div className="product-review-actions">
          <button
            type="button"
            className="product-danger"
            disabled={resolving}
            onClick={onReject}
          >
            Reject change set
          </button>
          <button
            type="button"
            className="product-primary"
            disabled={resolving || selectedChangeSet.freshness === "stale"}
            onClick={onApply}
          >
            Apply whole change set
          </button>
        </div>
      )}
      {selectedChangeSet.freshness === "stale" && selectedChangeSet.state === "pending" && (
        <p className="product-form-error" role="status">
          This proposal is stale and cannot be applied. Generate a new change set or reject it.
        </p>
      )}
    </>
  );
}

const useNarrowRail = (): boolean => {
  const query = "(max-width: 959px)";
  const [narrow, setNarrow] = useState(() =>
    typeof window.matchMedia === "function" && window.matchMedia(query).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(query);
    const update = () => setNarrow(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return narrow;
};

const focusableElements = (root: HTMLElement): HTMLElement[] =>
  Array.from(root.querySelectorAll<HTMLElement>(
    "button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
  )).filter((element) => !element.hidden);

type InertSnapshot = Readonly<{ element: HTMLElement; value: string | null }>;

const inertOutsideDialog = (dialog: HTMLElement): InertSnapshot[] => {
  const snapshots: InertSnapshot[] = [];
  let branch: HTMLElement = dialog;
  while (branch.parentElement) {
    const parent = branch.parentElement;
    for (const sibling of Array.from(parent.children)) {
      if (!(sibling instanceof HTMLElement)
        || sibling === branch
        || sibling.classList.contains("product-review-rail-backdrop")) continue;
      snapshots.push({ element: sibling, value: sibling.getAttribute("inert") });
      sibling.setAttribute("inert", "");
    }
    branch = parent;
    if (branch.classList.contains("product-app")) break;
  }
  return snapshots;
};

const restoreInert = (snapshots: readonly InertSnapshot[]): void => {
  for (const { element, value } of snapshots) {
    if (value === null) element.removeAttribute("inert");
    else element.setAttribute("inert", value);
  }
};

const renderableText = (resource?: RendererResource): string | undefined => {
  if (!resource) return undefined;
  if (resource.kind === "code" || resource.kind === "markdown") return resource.text;
  if (resource.kind === "json") return JSON.stringify(resource.value, null, 2);
  return undefined;
};

const pathDepth = (relativePath: string): number =>
  Math.max(0, relativePath.split("/").length - 1);

const railMaximumWidth = (): number =>
  typeof window === "undefined" ? 600 : Math.max(280, Math.min(600, window.innerWidth - 360));

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

const messageOf = (cause: unknown, fallback: string): string =>
  cause instanceof Error && cause.message ? cause.message : fallback;
