import {
  useEffect,
  useId,
  useRef,
  useState,
  useCallback,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  defaultProductClient,
  type ProductClient,
  type ProductRecoveryStatus,
} from "./api";
import { ConversationPane } from "./ConversationPane";
import { WorkspacePane } from "./WorkspacePane";
import { navigateProduct, readProductRoute, workspaceHref } from "./router";
import type {
  HomeDto,
  OwnerKind,
  ProductRoute,
  ProjectSummary,
  ProviderDiscovery,
  WorkspaceDto,
} from "./types";

type Pane = "conversation" | "workspace";

export function ProductApp({
  client = defaultProductClient,
}: Readonly<{ client?: ProductClient }>) {
  const [route, setRoute] = useState<ProductRoute>(() => readProductRoute());
  const [recovery, setRecovery] = useState<ProductRecoveryStatus | "checking">("checking");

  const checkRecovery = useCallback(async () => {
    setRecovery("checking");
    try {
      setRecovery(await client.recoveryStatus());
    } catch {
      setRecovery({
        state: "recovery_required",
        code: "recovery_status_unavailable",
        observedAt: new Date().toISOString(),
        retryable: true,
      });
    }
  }, [client]);

  useEffect(() => {
    const update = () => setRoute(readProductRoute());
    window.addEventListener("popstate", update);
    window.addEventListener("riff:product-navigation", update);
    return () => {
      window.removeEventListener("popstate", update);
      window.removeEventListener("riff:product-navigation", update);
    };
  }, []);

  useEffect(() => {
    void checkRecovery();
  }, [checkRecovery]);

  const workspaceReady = recovery !== "checking"
    && recovery.state === "ready"
    && route.page === "workspace";

  return (
    <div className={`product-app${workspaceReady ? " product-app-workspace" : ""}`}>
      <a className="product-skip-link" href="#product-main">Skip to main content</a>
      <header className="product-header">
        <a
          className="product-brand"
          href="/"
          onClick={(event) => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
            event.preventDefault();
            navigateProduct("/");
          }}
        >
          <span aria-hidden="true">R</span>
          <strong>Riffology</strong>
        </a>
        <nav aria-label="Primary navigation">
          <a
            href="/"
            aria-current={route.page === "home" ? "page" : undefined}
            onClick={(event) => {
              if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
              event.preventDefault();
              navigateProduct("/");
            }}
          >
            Home
          </a>
        </nav>
      </header>
      {recovery === "checking" && (
        <main id="product-main" className="product-state-page" tabIndex={-1}>
          <p className="product-eyebrow">STARTING</p>
          <h1>Checking workspace recovery.</h1>
        </main>
      )}
      {recovery !== "checking" && recovery.state === "recovery_required" && (
        <RecoveryRequiredPage recovery={recovery} retry={checkRecovery} />
      )}
      {recovery !== "checking" && recovery.state === "ready"
        && route.page === "home" && <HomePage client={client} />}
      {recovery !== "checking" && recovery.state === "ready"
        && route.page === "workspace" && (
        <SharedShell
          key={`${route.kind}:${route.id}`}
          client={client}
          route={route}
        />
      )}
      {recovery !== "checking" && recovery.state === "ready"
        && route.page === "not_found" && (
        <main id="product-main" className="product-state-page" tabIndex={-1}>
          <p className="product-eyebrow">NOT FOUND</p>
          <h1>That workspace route is not available.</h1>
          <a href="/" onClick={(event) => {
            event.preventDefault();
            navigateProduct("/");
          }}>Return home</a>
        </main>
      )}
    </div>
  );
}

function RecoveryRequiredPage({
  recovery,
  retry,
}: Readonly<{
  recovery: Extract<ProductRecoveryStatus, { state: "recovery_required" }>;
  retry: () => Promise<void>;
}>) {
  return (
    <main id="product-main" className="product-state-page" tabIndex={-1}>
      <p className="product-eyebrow">RECOVERY REQUIRED</p>
      <h1>Riffology is not accepting workspace changes yet.</h1>
      <p role="alert">
        Startup recovery could not establish a safe writable state. Projects,
        Conversations, Runs, and visual access remain unavailable.
      </p>
      <p>
        Observed at <time dateTime={recovery.observedAt}>{recovery.observedAt}</time>.
        {" "}{recovery.retryable
          ? "You can retry after the recovery condition is resolved."
          : "An operator must resolve the recovery condition before retrying."}
      </p>
      <button type="button" onClick={() => void retry()}>Check recovery again</button>
    </main>
  );
}

function HomePage({ client }: Readonly<{ client: ProductClient }>) {
  const [home, setHome] = useState<HomeDto>();
  const [providers, setProviders] = useState<ProviderDiscovery>();
  const [error, setError] = useState<string>();

  const load = async () => {
    setError(undefined);
    try {
      const nextHome = await client.home();
      setHome(nextHome);
      if (nextHome.providerAvailability.mode === "live") {
        setProviders(await client.providers());
      } else {
        setProviders({
          mode: "read_only",
          reason: nextHome.providerAvailability.reason,
          providerModels: [],
        });
      }
    } catch (cause) {
      setError(messageOf(cause, "Home could not be loaded."));
    }
  };

  useEffect(() => {
    void load();
  }, [client]);

  return (
    <main id="product-main" className="product-home" tabIndex={-1}>
      <section className="product-hero" aria-labelledby="home-heading">
        <div>
          <p className="product-eyebrow">PROJECTS AND EXPERIMENTS</p>
          <h1 id="home-heading">Build from a conversation.</h1>
          <p>Create a Project, edit its workspace, and run experiments from one durable authority.</p>
        </div>
        <span className="product-status" role="status">
          {!home
            ? "Loading resources…"
            : resourceCount(home.projects.length, "Project")}
        </span>
      </section>
      {error && (
        <div className="product-alert" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => void load()}>Try again</button>
        </div>
      )}
      <div className="product-home-grid">
        <ResourceSection
          id="home-projects"
          eyebrow="WORKSPACE"
          title="Projects"
          description="Editable code, execution contract, experiments, Runs, and Conversations."
          action={<NewProjectForm client={client} home={home} providers={providers} />}
          empty="No Projects yet. Create a blank Project, use a template, or import one."
        >
          {home?.projects.map((project) => <ProjectCard key={project.id} project={project} />)}
        </ResourceSection>
      </div>
    </main>
  );
}

function ResourceSection({
  id,
  eyebrow,
  title,
  description,
  action,
  empty,
  children,
}: Readonly<{
  id: string;
  eyebrow: string;
  title: string;
  description: string;
  action: ReactNode;
  empty: string;
  children: ReactNode;
}>) {
  const count = Array.isArray(children) ? children.length : children ? 1 : 0;
  return (
    <section className="product-collection" aria-labelledby={`${id}-heading`} data-testid={id}>
      <div className="product-section-heading">
        <div>
          <p className="product-eyebrow">{eyebrow}</p>
          <h2 id={`${id}-heading`}>{title}</h2>
          <p>{description}</p>
        </div>
        {action}
      </div>
      <div className="product-resource-list">
        {count > 0 ? children : <p className="product-empty">{empty}</p>}
      </div>
    </section>
  );
}

function ProjectCard({ project }: Readonly<{ project: ProjectSummary }>) {
  return (
    <article className="product-resource-card" data-testid={`resource-project-${project.id}`}>
      <div>
        <span className={`product-badge product-badge-${project.technicalStatus}`}>{project.technicalStatus}</span>
        <h3>{project.name}</h3>
        <p>{project.executionLock.state !== "unlocked"
          ? `Execution locked: ${project.executionLock.state}`
          : project.lastRun ? `Last run: ${project.lastRun.status}` : "No runs yet"}</p>
      </div>
      <ResourceLink kind="project" id={project.id}>Open Project</ResourceLink>
    </article>
  );
}

function ResourceLink({
  kind,
  id,
  conversationId,
  children,
}: Readonly<{
  kind: OwnerKind;
  id: string;
  conversationId?: string;
  children: ReactNode;
}>) {
  const href = workspaceHref(kind, id, conversationId);
  return (
    <a className="product-action-link" href={href} onClick={(event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
      event.preventDefault();
      navigateProduct(href);
    }}>
      {children}
    </a>
  );
}

function NewProjectForm({
  client,
  home,
  providers,
}: Readonly<{ client: ProductClient; home?: HomeDto; providers?: ProviderDiscovery }>) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [sourceKind, setSourceKind] = useState<"blank" | "template" | "import">("blank");
  const [templateKey, setTemplateKey] = useState("");
  const [importFile, setImportFile] = useState<File>();
  const [qualifiedId, setQualifiedId] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const titleId = useId();
  const providerOptions = providers?.mode === "live" ? providers.providerModels : [];
  const selectedProvider = providerOptions.find((item) => item.qualifiedId === qualifiedId) ?? providerOptions[0];
  const templates = home?.templates ?? [];
  const selectedTemplate = templates.find((item) => `${item.id}@${item.version}` === templateKey) ?? templates[0];

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedProvider || !name.trim() || sourceKind === "template" && !selectedTemplate
      || sourceKind === "import" && !importFile) return;
    setPending(true);
    setError(undefined);
    try {
      const source = sourceKind === "blank" ? { kind: "blank" as const }
        : sourceKind === "template" ? {
          kind: "template" as const,
          templateId: selectedTemplate!.id,
          templateVersion: selectedTemplate!.version,
        } : {
          kind: "import" as const,
          filename: importFile!.name,
          mediaType: importFile!.type || "application/octet-stream",
          base64: await fileBase64(importFile!),
        };
      const created = await client.createProject({
        commandId: crypto.randomUUID(),
        name: name.trim(),
        provider: { providerId: selectedProvider.providerId, modelId: selectedProvider.modelId },
        source,
      });
      navigateProduct(workspaceHref("project", created.project.id, created.conversation.id));
    } catch (cause) {
      setError(messageOf(cause, "The Project could not be created."));
      setPending(false);
    }
  };

  if (!open) {
    return <button type="button" className="product-primary" onClick={() => setOpen(true)}>New Project</button>;
  }
  return (
    <form className="product-create-form" aria-labelledby={titleId} onSubmit={(event) => void submit(event)}>
      <strong id={titleId}>New Project</strong>
      <label>
        Name
        <input required maxLength={120} value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <label>
        Source
        <select value={sourceKind} onChange={(event) => setSourceKind(event.target.value as typeof sourceKind)}>
          <option value="blank">Blank Project</option>
          <option value="template">Project template</option>
          <option value="import">Import archive</option>
        </select>
      </label>
      {sourceKind === "template" && <label>Template<select required value={templateKey || (selectedTemplate ? `${selectedTemplate.id}@${selectedTemplate.version}` : "")}
        onChange={(event) => setTemplateKey(event.target.value)} disabled={templates.length === 0}>
        {templates.map((item) => <option key={`${item.id}@${item.version}`} value={`${item.id}@${item.version}`}>{item.name} · {item.version}</option>)}
      </select></label>}
      {sourceKind === "import" && <label>Project archive<input required type="file" accept=".zip,application/zip,application/octet-stream"
        onChange={(event) => setImportFile(event.target.files?.[0])} /></label>}
      <label>Provider / model<select required value={qualifiedId || selectedProvider?.qualifiedId || ""}
        disabled={providerOptions.length === 0} onChange={(event) => setQualifiedId(event.target.value)}>
        {providerOptions.map((item) => <option key={item.qualifiedId} value={item.qualifiedId}>{item.qualifiedId}</option>)}
      </select></label>
      {error && <p className="product-form-error" role="alert">{error}</p>}
      <div>
        <button type="submit" className="product-primary" disabled={pending || !selectedProvider || !name.trim()
          || sourceKind === "template" && !selectedTemplate || sourceKind === "import" && !importFile}>
          {pending ? "Creating…" : "Create Project"}
        </button>
        <button type="button" className="product-secondary" onClick={() => setOpen(false)} disabled={pending}>Cancel</button>
      </div>
    </form>
  );
}

function SharedShell({
  client,
  route,
}: Readonly<{
  client: ProductClient;
  route: Extract<ProductRoute, { page: "workspace" }>;
}>) {
  const [workspace, setWorkspace] = useState<WorkspaceDto>();
  const [error, setError] = useState<string>();
  const [pane, setPane] = useState<Pane>("conversation");
  const ownerHeadingRef = useRef<HTMLHeadingElement>(null);
  const conversationButtonRef = useRef<HTMLButtonElement>(null);
  const workspaceButtonRef = useRef<HTMLButtonElement>(null);
  const conversationPaneRef = useRef<HTMLElement>(null);
  const workspacePaneRef = useRef<HTMLElement>(null);
  const lastFocusedElementRef = useRef<Element | null>(null);
  const workspaceRequestSequence = useRef(0);

  const loadWorkspace = useCallback(async () => {
    const sequence = ++workspaceRequestSequence.current;
    setError(undefined);
    try {
      const next = await client.workspace(route.id);
      if (workspaceRequestSequence.current === sequence) setWorkspace(next);
    } catch (cause) {
      if (workspaceRequestSequence.current === sequence) {
        setError(messageOf(cause, "The workspace could not be loaded."));
      }
    }
  }, [client, route.kind, route.id]);

  useEffect(() => {
    setWorkspace(undefined);
    void loadWorkspace();
    ownerHeadingRef.current?.focus();
    return () => { workspaceRequestSequence.current += 1; };
  }, [loadWorkspace]);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(max-width: 959px)");
    const rememberFocus = (event: FocusEvent) => {
      lastFocusedElementRef.current = event.target instanceof Element
        ? event.target
        : null;
    };
    const preserveVisibleFocus = () => {
      if (!media.matches) return;
      const hiddenPane = pane === "conversation"
        ? workspacePaneRef.current
        : conversationPaneRef.current;
      if (
        hiddenPane?.contains(document.activeElement)
        || hiddenPane?.contains(lastFocusedElementRef.current)
      ) {
        (pane === "conversation"
          ? conversationButtonRef.current
          : workspaceButtonRef.current)?.focus();
      }
    };
    document.addEventListener("focusin", rememberFocus);
    preserveVisibleFocus();
    media.addEventListener("change", preserveVisibleFocus);
    window.addEventListener("resize", preserveVisibleFocus);
    return () => {
      document.removeEventListener("focusin", rememberFocus);
      media.removeEventListener("change", preserveVisibleFocus);
      window.removeEventListener("resize", preserveVisibleFocus);
    };
  }, [pane]);

  const selectPane = (next: Pane, control: HTMLButtonElement) => {
    setPane(next);
    control.focus();
  };
  return (
    <main id="product-main" className="product-shell" tabIndex={-1}>
      <header className="product-owner-header">
        <div className="product-owner-identity">
          <span className="product-owner-kind">{route.kind}</span>
          <h1 ref={ownerHeadingRef} tabIndex={-1} data-testid="shell-owner-heading">
            {workspace?.owner.name ?? "Loading workspace…"}
          </h1>
        </div>
        <span className="product-status" role="status">
          {error ? "Unavailable" : workspace?.owner.lifecycleState ?? "Loading"}
        </span>
      </header>
      {error && <div className="product-alert" role="alert">{error}</div>}
      <div
        className="product-pane-selector"
        role="group"
        aria-label="Workspace pane"
        data-testid="pane-selector"
      >
        <button
          ref={conversationButtonRef}
          type="button"
          aria-pressed={pane === "conversation"}
          onClick={(event) => selectPane("conversation", event.currentTarget)}
        >
          Conversation
        </button>
        <button
          ref={workspaceButtonRef}
          type="button"
          aria-pressed={pane === "workspace"}
          onClick={(event) => selectPane("workspace", event.currentTarget)}
        >
          Workspace
        </button>
      </div>
      <div className="product-workspace" data-testid="shell-workspace-root">
        <aside
          ref={conversationPaneRef}
          className="product-conversation-pane"
          aria-label="Conversation"
          tabIndex={-1}
          data-testid="pane-conversation"
          data-active={pane === "conversation"}
        >
          <ConversationPane
            client={client}
            ownerKind={route.kind}
            ownerId={route.id}
            selectedConversationId={route.conversationId}
            onOwnerChanged={loadWorkspace}
          />
        </aside>
        <section
          ref={workspacePaneRef}
          className="product-workbench-pane"
          aria-label="Workspace"
          tabIndex={-1}
          data-testid="pane-workspace"
          data-active={pane === "workspace"}
        >
          {!workspace && !error && <p className="product-empty" role="status">Loading dynamic workspace…</p>}
          {workspace && (
            <WorkspacePane
              client={client}
              workspace={workspace}
              selectedConversationId={route.conversationId}
              refresh={loadWorkspace}
            />
          )}
        </section>
      </div>
    </main>
  );
}

const messageOf = (cause: unknown, fallback: string): string =>
  cause instanceof Error && cause.message ? cause.message : fallback;

const resourceCount = (count: number, singular: string): string =>
  `${count} ${singular}${count === 1 ? "" : "s"}`;

const fileBase64 = async (file: File): Promise<string> => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};
