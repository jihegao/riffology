import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { defaultProductClient, type ProductClient } from "./api";
import { navigateProduct, readProductRoute, workspaceHref } from "./router";
import type {
  HomeDto,
  ModelSummary,
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

  useEffect(() => {
    const update = () => setRoute(readProductRoute());
    window.addEventListener("popstate", update);
    window.addEventListener("riff:product-navigation", update);
    return () => {
      window.removeEventListener("popstate", update);
      window.removeEventListener("riff:product-navigation", update);
    };
  }, []);

  return (
    <div className="product-app">
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
      {route.page === "home" && <HomePage client={client} />}
      {route.page === "workspace" && (
        <SharedShell
          key={`${route.kind}:${route.id}`}
          client={client}
          route={route}
        />
      )}
      {route.page === "not_found" && (
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
          <p className="product-eyebrow">MODELS AND EXPERIMENTS</p>
          <h1 id="home-heading">Build from a conversation.</h1>
          <p>Choose a Model to shape reusable behavior, or a Project to configure and run a fixed copy.</p>
        </div>
        <span className="product-status" role="status">
          {!home
            ? "Loading resources…"
            : `${resourceCount(home.models.length, "Model")} · ${resourceCount(home.projects.length, "Project")}`}
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
          id="home-models"
          eyebrow="REUSABLE"
          title="Models"
          description="Provider-backed modelling workspaces that Projects can copy."
          action={<NewModelForm client={client} providers={providers} />}
          empty="No Models yet. Create one to begin."
        >
          {home?.models.map((model) => <ModelCard key={model.id} model={model} />)}
        </ResourceSection>
        <ResourceSection
          id="home-projects"
          eyebrow="FIXED COPY"
          title="Projects"
          description="Experiment workspaces bound to an executable Model snapshot."
          action={<NewProjectForm client={client} home={home} />}
          empty="No Projects yet. Create one from an executable Model."
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

function ModelCard({ model }: Readonly<{ model: ModelSummary }>) {
  return (
    <article className="product-resource-card" data-testid={`resource-model-${model.id}`}>
      <div>
        <span className={`product-badge product-badge-${model.technicalStatus}`}>
          {model.technicalStatus}
        </span>
        <h3>{model.name}</h3>
        <p>{model.runMode ? `${model.runMode} execution` : "Execution mode not set"}</p>
      </div>
      <ResourceLink kind="model" id={model.id}>Open Model</ResourceLink>
    </article>
  );
}

function ProjectCard({ project }: Readonly<{ project: ProjectSummary }>) {
  return (
    <article className="product-resource-card" data-testid={`resource-project-${project.id}`}>
      <div>
        <span className="product-badge">Project</span>
        <h3>{project.name}</h3>
        <p>{project.lastRun ? `Last run: ${project.lastRun.status}` : "No runs yet"}</p>
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

function NewModelForm({
  client,
  providers,
}: Readonly<{ client: ProductClient; providers?: ProviderDiscovery }>) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [qualifiedId, setQualifiedId] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const titleId = useId();
  const liveProviders = providers?.mode === "live" ? providers.providerModels : [];
  const selected = liveProviders.find((model) => model.qualifiedId === qualifiedId)
    ?? liveProviders[0];

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!selected || !name.trim()) return;
    setPending(true);
    setError(undefined);
    try {
      const created = await client.createModel({
        commandId: crypto.randomUUID(),
        name: name.trim(),
        providerId: selected.providerId,
        modelId: selected.modelId,
      });
      navigateProduct(workspaceHref("model", created.model.id, created.conversation.id));
    } catch (cause) {
      setError(messageOf(cause, "The Model could not be created."));
      setPending(false);
    }
  };

  if (!open) {
    return <button type="button" className="product-primary" onClick={() => setOpen(true)}>New Model</button>;
  }
  return (
    <form className="product-create-form" aria-labelledby={titleId} onSubmit={(event) => void submit(event)}>
      <strong id={titleId}>New Model</strong>
      <label>
        Name
        <input required maxLength={120} value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <label>
        Provider / model
        <select
          required
          disabled={liveProviders.length === 0}
          value={qualifiedId || selected?.qualifiedId || ""}
          onChange={(event) => setQualifiedId(event.target.value)}
        >
          {liveProviders.map((model) => (
            <option key={model.qualifiedId} value={model.qualifiedId}>{model.qualifiedId}</option>
          ))}
        </select>
      </label>
      {providers?.mode === "read_only" && (
        <p className="product-form-note" role="status">
          OpenCode is unavailable. Existing resources remain readable, but a new Model cannot be created.
        </p>
      )}
      {providers === undefined && (
        <p className="product-form-note" role="status">Loading provider options…</p>
      )}
      {error && <p className="product-form-error" role="alert">{error}</p>}
      <div>
        <button type="submit" className="product-primary" disabled={pending || !selected || !name.trim()}>
          {pending ? "Creating…" : "Create Model"}
        </button>
        <button type="button" className="product-secondary" onClick={() => setOpen(false)} disabled={pending}>Cancel</button>
      </div>
    </form>
  );
}

function NewProjectForm({
  client,
  home,
}: Readonly<{ client: ProductClient; home?: HomeDto }>) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [modelId, setModelId] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const titleId = useId();
  const options = home?.newProjectModels ?? [];
  const selectedId = modelId || options[0]?.id || "";

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedId || !name.trim()) return;
    setPending(true);
    setError(undefined);
    try {
      const created = await client.createProject({
        commandId: crypto.randomUUID(),
        name: name.trim(),
        modelId: selectedId,
      });
      navigateProduct(workspaceHref("project", created.project.id));
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
        Executable Model
        <select required disabled={options.length === 0} value={selectedId} onChange={(event) => setModelId(event.target.value)}>
          {options.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
        </select>
      </label>
      {home && options.length === 0 && (
        <p className="product-form-note" role="status">Create or prepare an executable Model before creating a Project.</p>
      )}
      {error && <p className="product-form-error" role="alert">{error}</p>}
      <div>
        <button type="submit" className="product-primary" disabled={pending || !selectedId || !name.trim()}>
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
  const conversationHeadingRef = useRef<HTMLHeadingElement>(null);
  const workspaceHeadingRef = useRef<HTMLHeadingElement>(null);
  const conversationButtonRef = useRef<HTMLButtonElement>(null);
  const workspaceButtonRef = useRef<HTMLButtonElement>(null);
  const conversationPaneRef = useRef<HTMLElement>(null);
  const workspacePaneRef = useRef<HTMLElement>(null);
  const lastFocusedElementRef = useRef<Element | null>(null);

  useEffect(() => {
    let active = true;
    setWorkspace(undefined);
    setError(undefined);
    void client.workspace(route.kind, route.id).then((value) => {
      if (active) setWorkspace(value);
    }).catch((cause) => {
      if (active) setError(messageOf(cause, "The workspace could not be loaded."));
    });
    ownerHeadingRef.current?.focus();
    return () => { active = false; };
  }, [client, route.kind, route.id]);

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

  const selectPane = (next: Pane) => {
    setPane(next);
    requestAnimationFrame(() => {
      (next === "conversation" ? conversationHeadingRef : workspaceHeadingRef).current?.focus();
    });
  };
  const selectedConversation = workspace?.conversations.find(
    (conversation) => conversation.id === route.conversationId,
  ) ?? workspace?.conversations[0];
  const invalidConversation = Boolean(
    workspace
      && route.conversationId
      && !workspace.conversations.some(
        (conversation) => conversation.id === route.conversationId,
      ),
  );

  return (
    <main id="product-main" className="product-shell" tabIndex={-1}>
      <header className="product-owner-header">
        <div>
          <p className="product-eyebrow">{route.kind.toUpperCase()} WORKSPACE</p>
          <h1 ref={ownerHeadingRef} tabIndex={-1} data-testid="shell-owner-heading">
            {workspace?.owner.name ?? "Loading workspace…"}
          </h1>
        </div>
        <span className="product-status" role="status">
          {error ? "Unavailable" : workspace?.owner.lifecycleState ?? "Loading"}
        </span>
      </header>
      {error && <div className="product-alert" role="alert">{error}</div>}
      {invalidConversation && (
        <div className="product-alert" role="alert">
          That Conversation does not belong to this workspace. The current owner was not changed.
        </div>
      )}
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
          onClick={() => selectPane("conversation")}
        >
          Conversation
        </button>
        <button
          ref={workspaceButtonRef}
          type="button"
          aria-pressed={pane === "workspace"}
          onClick={() => selectPane("workspace")}
        >
          Workspace
        </button>
      </div>
      <div className="product-workspace" data-testid="shell-workspace-root">
        <aside
          ref={conversationPaneRef}
          className="product-conversation-pane"
          aria-labelledby="conversation-heading"
          data-testid="pane-conversation"
          data-active={pane === "conversation"}
        >
          <div>
            <p className="product-eyebrow">PERSISTENT CONTEXT</p>
            <h2 id="conversation-heading" ref={conversationHeadingRef} tabIndex={-1}>Conversation</h2>
          </div>
          {workspace && workspace.conversations.length > 0 ? (
            <nav aria-label="Conversations" className="product-conversation-list">
              {workspace.conversations.map((conversation) => (
                <ResourceLink
                  key={conversation.id}
                  kind={route.kind}
                  id={route.id}
                  conversationId={conversation.id}
                >
                  <span aria-current={conversation.id === selectedConversation?.id ? "page" : undefined}>
                    {conversation.name}
                  </span>
                </ResourceLink>
              ))}
            </nav>
          ) : (
            <p className="product-empty">
              {workspace ? "No Conversations yet." : "Loading Conversations…"}
            </p>
          )}
          <div className="product-boundary-note">
            <strong>{selectedConversation?.name ?? "Conversation"}</strong>
            <p>Messages and Conversation actions arrive in A4-3. No assistant reply is fabricated here.</p>
          </div>
        </aside>
        <section
          ref={workspacePaneRef}
          className="product-workbench-pane"
          aria-labelledby="workspace-heading"
          data-testid="pane-workspace"
          data-active={pane === "workspace"}
        >
          <div>
            <p className="product-eyebrow">CURRENT OBJECT</p>
            <h2 id="workspace-heading" ref={workspaceHeadingRef} tabIndex={-1}>Workspace</h2>
          </div>
          <article className="product-workspace-card" data-testid="workspace-owner-card">
            <span className="product-badge">{route.kind}</span>
            <h3>{workspace?.owner.name ?? route.id}</h3>
            {workspace?.owner.technicalStatus && <p>Technical status: {workspace.owner.technicalStatus}</p>}
            <p>
              This object remains mounted while Conversations change. Dynamic Model and Project renderers arrive in A4-4.
            </p>
          </article>
        </section>
      </div>
    </main>
  );
}

const messageOf = (cause: unknown, fallback: string): string =>
  cause instanceof Error && cause.message ? cause.message : fallback;

const resourceCount = (count: number, singular: string): string =>
  `${count} ${singular}${count === 1 ? "" : "s"}`;
