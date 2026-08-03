import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { ProductApiError, type ProductClient } from "./api";
import { navigateProduct, workspaceHref } from "./router";
import type {
  ConversationBundle,
  ConversationSummary,
  ConversationRuntimeProjection,
  ConversationRuntimeStatus,
  AgentDiscovery,
  OwnerKind,
  PermanentDeletePreview,
  ProviderDiscovery,
  ComposerCapabilities,
  ComposerCommandId,
} from "./types";

type ConversationCollections = Readonly<{
  active: readonly ConversationSummary[];
  archived: readonly ConversationSummary[];
  trashed: readonly ConversationSummary[];
}>;

const emptyCollections: ConversationCollections = Object.freeze({
  active: [],
  archived: [],
  trashed: [],
});

export function ConversationPane({
  client,
  ownerKind,
  ownerId,
  selectedConversationId,
  onOwnerChanged,
  presentation = "product",
  ownerName,
  navigateConversation,
  conversationHref,
}: Readonly<{
  client: ProductClient;
  ownerKind: OwnerKind;
  ownerId: string;
  selectedConversationId?: string;
  onOwnerChanged?: () => Promise<void> | void;
  presentation?: "product" | "riffology";
  ownerName?: string;
  navigateConversation?: (conversationId?: string) => void;
  conversationHref?: (conversationId: string) => string;
}>) {
  const [collections, setCollections] =
    useState<ConversationCollections>(emptyCollections);
  const [providers, setProviders] = useState<ProviderDiscovery>();
  const [agents, setAgents] = useState<AgentDiscovery>();
  const [bundle, setBundle] = useState<ConversationBundle>();
  const [runtime, setRuntime] = useState<ConversationRuntimeProjection>();
  const [runtimeUnavailable, setRuntimeUnavailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [sendingConversationId, setSendingConversationId] = useState<string>();
  const [error, setError] = useState<string>();
  const [readOnlyReason, setReadOnlyReason] = useState<string>();
  const paneRef = useRef<HTMLDivElement>(null);
  const scrollRegionRef = useRef<HTMLDivElement>(null);
  const scrollTopRef = useRef(0);
  const selected = useMemo(
    () => [...collections.active, ...collections.archived, ...collections.trashed]
      .find((conversation) => conversation.id === selectedConversationId)
      ?? (!selectedConversationId ? collections.active[0] : undefined),
    [collections, selectedConversationId],
  );
  const selectedIdRef = useRef(selectedConversationId);
  useEffect(() => {
    selectedIdRef.current = selected?.id;
  }, [selected?.id]);

  const refreshCollections = async () => {
    const [active, archived, trashed] = await Promise.all([
      client.conversations(ownerKind, ownerId, "active"),
      client.conversations(ownerKind, ownerId, "archived"),
      client.conversations(ownerKind, ownerId, "trashed"),
    ]);
    setCollections(Object.freeze({ active, archived, trashed }));
  };

  useEffect(() => {
    let current = true;
    setLoading(true);
    setError(undefined);
    setBundle(undefined);
    void Promise.all([
      refreshCollections(),
      client.providers().then((value) => {
        if (current) setProviders(value);
      }),
      client.agents
        ? client.agents(ownerKind, ownerId).then((value) => {
          if (current) setAgents(value);
        }).catch((cause) => {
          if (!optionalRuntimeUnavailable(cause)) throw cause;
        })
        : Promise.resolve(),
    ]).catch((cause) => {
      if (current) setError(messageOf(cause, "Conversations could not be loaded."));
    }).finally(() => {
      if (current) setLoading(false);
    });
    return () => { current = false; };
  }, [client, ownerKind, ownerId]);

  useEffect(() => {
    let current = true;
    scrollTopRef.current = 0;
    if (scrollRegionRef.current) scrollRegionRef.current.scrollTop = 0;
    setBundle(undefined);
    setReadOnlyReason(undefined);
    if (!selected) return () => { current = false; };
    setLoading(true);
    void client.conversationBundle(selected.id).then((value) => {
      if (current) {
        setBundle(value);
        if (value.conversation.sessionState === "read_only") {
          setReadOnlyReason("The provider is unavailable for this Conversation.");
        }
      }
    }).catch((cause) => {
      if (current) setError(messageOf(cause, "The Conversation could not be loaded."));
    }).finally(() => {
      if (current) setLoading(false);
    });
    return () => { current = false; };
  }, [client, selected?.id]);

  useLayoutEffect(() => {
    const scrollRegion = scrollRegionRef.current;
    if (scrollRegion) scrollRegion.scrollTop = scrollTopRef.current;
  }, [runtime?.revision]);

  useEffect(() => {
    let current = true;
    let close: (() => void) | undefined;
    setRuntime(undefined);
    setRuntimeUnavailable(false);
    if (!selected || !client.conversationRuntime) return () => { current = false; };
    void client.conversationRuntime(selected.id).then(async (projection) => {
      if (!current) return;
      setRuntime(projection);
      if (!client.subscribeConversationRuntime) return;
      const unsubscribe = await client.subscribeConversationRuntime(
        selected.id,
        (next) => {
          if (current) setRuntime(next);
        },
        () => {
          // The durable bundle and next snapshot remain usable if SSE drops.
        },
      );
      if (current) close = unsubscribe;
      else unsubscribe();
    }).catch((cause) => {
      if (!current) return;
      if (optionalRuntimeUnavailable(cause)) {
        setRuntimeUnavailable(true);
        return;
      }
      setError(messageOf(cause, "Live Agent activity could not be loaded."));
    });
    return () => {
      current = false;
      close?.();
    };
  }, [client, selected?.id]);

  const refreshConversation = async (conversationId: string) => {
    await refreshCollections();
    const nextBundle = await client.conversationBundle(conversationId);
    if (selectedIdRef.current === conversationId) {
      setBundle(nextBundle);
      setReadOnlyReason(nextBundle.conversation.sessionState === "read_only"
        ? "The provider is unavailable for this Conversation."
        : undefined);
    }
    if (client.conversationRuntime && !runtimeUnavailable) {
      try {
        const nextRuntime = await client.conversationRuntime(conversationId);
        if (selectedIdRef.current === conversationId) setRuntime(nextRuntime);
      } catch (cause) {
        if (!optionalRuntimeUnavailable(cause)) throw cause;
      }
    }
  };

  const selectConversation = (conversationId: string) => {
    selectedIdRef.current = conversationId;
    setBundle(undefined);
    setReadOnlyReason(undefined);
    if (navigateConversation) navigateConversation(conversationId);
    else navigateProduct(workspaceHref(ownerKind, ownerId, conversationId));
  };
  const focusConversationNavigation = (conversationId?: string) => {
    requestAnimationFrame(() => {
      const conversationLinks = Array.from(
        paneRef.current?.querySelectorAll<HTMLAnchorElement>(
          ".product-conversation-list a",
        ) ?? [],
      );
      const requested = conversationId
        ? conversationLinks.find((link) =>
          new URL(link.href).searchParams.get("conversation") === conversationId)
        : undefined;
      (requested
        ?? conversationLinks[0]
        ?? paneRef.current?.querySelector<HTMLElement>(".product-new-conversation"))
        ?.focus();
    });
  };

  const sending = selected !== undefined
    && sendingConversationId === selected.id;
  const status = conversationStatus(
    bundle?.conversation,
    providers,
    readOnlyReason,
    runtime,
    sending,
  );
  const activeBundle = bundle?.conversation.lifecycleState === "active"
    ? bundle
    : undefined;
  const handleConversationChanged = async (removed: boolean) => {
    if (!activeBundle) return;
    await refreshCollections();
    if (selectedIdRef.current !== activeBundle.conversation.id) return;
    if (removed) {
      selectedIdRef.current = undefined;
      setBundle(undefined);
      setReadOnlyReason(undefined);
      if (navigateConversation) navigateConversation();
      else navigateProduct(workspaceHref(ownerKind, ownerId));
      focusConversationNavigation();
      return;
    }
    await refreshConversation(activeBundle.conversation.id);
  };

  return (
    <div className="product-conversation-content" ref={paneRef}>
      <div className="product-conversation-toolbar" data-testid="conversation-toolbar">
        {presentation === "riffology" && (
          <div className="riffology-conversation-heading">
            <div>
              <strong>{selected?.name ?? ownerName ?? "项目对话"}</strong>
              <span>{selected
                ? `${selected.provider.providerId} · ${selected.provider.modelId}`
                : "选择或创建会话"}</span>
            </div>
            <NewConversationForm
              client={client}
              ownerKind={ownerKind}
              ownerId={ownerId}
              providers={providers}
              compact
              disabled={providers?.mode === "read_only"}
              onCreated={(conversation) => {
                void refreshCollections().then(() => {
                  selectConversation(conversation.id);
                  focusConversationNavigation(conversation.id);
                });
              }}
            />
          </div>
        )}
        {presentation === "riffology" && activeBundle && (
          <ConversationControls
            client={client}
            conversation={activeBundle.conversation}
            providers={providers}
            compact
            onChanged={handleConversationChanged}
            onError={(message) => {
              if (selectedIdRef.current === activeBundle.conversation.id) setError(message);
            }}
          />
        )}
        <div className={`product-agent-status product-agent-status-${status}`} role="status">
          <strong>Agent: {status.replaceAll("_", " ")}</strong>
          <span>{statusDescription(status)}</span>
        </div>
        {error && <p className="product-form-error" role="alert">{error}</p>}
        {selectedConversationId && !loading && !selected && (
          <p className="product-form-error" role="alert">
            That Conversation does not belong to this workspace.
          </p>
        )}
        <ConversationList
          conversations={collections.active}
          selectedId={selected?.id}
          onSelect={selectConversation}
          hrefFor={conversationHref}
        />
        {presentation === "product" && <NewConversationForm
          client={client}
          ownerKind={ownerKind}
          ownerId={ownerId}
          providers={providers}
          onCreated={(conversation) => {
            void refreshCollections().then(() => {
              selectConversation(conversation.id);
              focusConversationNavigation(conversation.id);
            });
          }}
        />}
      </div>
      <div
        className="product-conversation-scroll-region"
        ref={scrollRegionRef}
        data-testid="conversation-scroll-region"
        role="region"
        aria-label="Conversation activity"
        tabIndex={0}
        onScroll={(event) => {
          scrollTopRef.current = event.currentTarget.scrollTop;
        }}
      >
        {activeBundle && (
          <>
          {presentation === "product" && <ConversationControls
            client={client}
            conversation={activeBundle.conversation}
            providers={providers}
            onChanged={handleConversationChanged}
            onError={(message) => {
              if (selectedIdRef.current === activeBundle.conversation.id) setError(message);
            }}
          />}
          <RuntimeControls
            client={client}
            conversationId={activeBundle.conversation.id}
            runtime={runtime}
            unavailable={runtimeUnavailable}
            onChanged={() => refreshConversation(activeBundle.conversation.id)}
            onError={setError}
          />
          <Transcript bundle={activeBundle} runtime={runtime} />
          {presentation === "product" && <AttachmentForm
            client={client}
            conversationId={activeBundle.conversation.id}
            onUploaded={() => {
              const conversationId = activeBundle.conversation.id;
              void refreshConversation(conversationId).catch((cause) => {
                if (selectedIdRef.current === conversationId) {
                  setError(messageOf(cause, "Attachments could not be refreshed."));
                }
              });
            }}
          />}
          </>
        )}
        <RecoveryLists
          client={client}
          collections={collections}
          onRestore={() => {
            void refreshCollections().then(() => focusConversationNavigation()).catch((cause) =>
              setError(messageOf(cause, "Conversations could not be refreshed.")));
          }}
          onError={setError}
        />
        {loading && <p className="product-empty" role="status">Loading Conversation…</p>}
      </div>
      {activeBundle && (
        <div className="product-composer-dock" data-testid="conversation-composer-dock">
          <QuestionInteractionDock
            client={client}
            conversationId={activeBundle.conversation.id}
            runtime={runtime}
            onChanged={() => refreshConversation(activeBundle.conversation.id)}
            onError={setError}
          />
          <Composer
            client={client}
            disabled={status === "read_only"
              || status === "busy"
              || status === "waiting_for_tool"
              || status === "waiting_for_user"
                && (runtime?.activeTurn?.canStop === true
                  || Boolean(runtime?.pendingInteractions.length))}
            disabledMessage={status === "read_only"
              ? undefined
              : "Respond to, stop, or finish the active turn before starting another message."}
            sending={sending}
            bundle={activeBundle}
            providers={providers}
            agents={agents}
            runtime={runtime}
            onProviderChange={async (providerId, modelId) => {
              const conversation = activeBundle.conversation;
              setError(undefined);
              try {
                await client.changeConversationProvider({
                  commandId: crypto.randomUUID(),
                  conversationId: conversation.id,
                  expectedRecordDigest: conversation.recordDigest,
                  providerId,
                  modelId,
                });
                await refreshConversation(conversation.id);
              } catch (cause) {
                if (selectedIdRef.current === conversation.id) {
                  setError(messageOf(cause, "The model selection could not be updated."));
                }
              }
            }}
            onSend={async (text, attachmentIds, agentName) => {
              const conversationId = activeBundle.conversation.id;
              setSendingConversationId(conversationId);
              setError(undefined);
              try {
                const result = await client.sendTurn({
                  requestKey: crypto.randomUUID(),
                  conversationId,
                  text,
                  attachmentIds,
                  ...(agentName ? { agentName } : {}),
                });
                await refreshConversation(conversationId);
                if (result.turn.actions.some((action) =>
                  action.state === "committed"
                  && OWNER_MUTATION_ACTIONS.has(action.actionKind))) {
                  await onOwnerChanged?.();
                }
              } catch (cause) {
                if (selectedIdRef.current === conversationId) {
                  setError(messageOf(cause, "The message could not be sent."));
                }
              } finally {
                setSendingConversationId((current) =>
                  current === conversationId ? undefined : current);
              }
            }}
            onCommand={async (commandId, commandKey, expectedRevision) => {
              const conversationId = activeBundle.conversation.id;
              setError(undefined);
              try {
                if (!client.executeComposerCommand) throw new Error("Conversation commands are unavailable.");
                await client.executeComposerCommand({
                  conversationId,
                  commandId,
                  commandKey,
                  expectedRevision,
                });
                await refreshConversation(conversationId);
                if (commandId === "check-model") await onOwnerChanged?.();
              } catch (cause) {
                if (selectedIdRef.current === conversationId) {
                  setError(messageOf(cause, "The Conversation command could not be completed."));
                }
              }
            }}
          />
        </div>
      )}
    </div>
  );
}

const OWNER_MUTATION_ACTIONS = new Set([
  "attachment_adopt",
  "experiment_configuration_update",
  "model_files_mutate",
  "run_start",
  "run_cancel",
  "run_trash",
  "run_restore",
]);

function ConversationList({
  conversations,
  selectedId,
  onSelect,
  hrefFor,
}: Readonly<{
  conversations: readonly ConversationSummary[];
  selectedId?: string;
  onSelect: (id: string) => void;
  hrefFor?: (id: string) => string;
}>) {
  if (conversations.length === 0) {
    return <p className="product-empty">No active Conversations yet.</p>;
  }
  return (
    <nav aria-label="Conversations" className="product-conversation-list">
      <ul>
        {conversations.map((conversation) => (
          <li key={conversation.id}>
            <a
              href={hrefFor?.(conversation.id) ?? workspaceHref(
                conversation.owner.kind, conversation.owner.id, conversation.id)}
              aria-current={conversation.id === selectedId ? "page" : undefined}
              onClick={(event) => {
                if (event.button !== 0 || event.metaKey || event.ctrlKey
                  || event.shiftKey) return;
                event.preventDefault();
                onSelect(conversation.id);
              }}
            >
              <span>{conversation.name}</span>
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function NewConversationForm({
  client,
  ownerKind,
  ownerId,
  providers,
  onCreated,
  compact = false,
  disabled = false,
}: Readonly<{
  client: ProductClient;
  ownerKind: OwnerKind;
  ownerId: string;
  providers?: ProviderDiscovery;
  onCreated: (conversation: ConversationSummary) => void;
  compact?: boolean;
  disabled?: boolean;
}>) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [qualifiedId, setQualifiedId] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const titleId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const options = providers?.mode === "live" ? providers.providerModels : [];
  const selected = options.find((provider) => provider.qualifiedId === qualifiedId)
    ?? options[0];

  const close = () => {
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!selected || !name.trim()) return;
    setPending(true);
    setError(undefined);
    try {
      const conversation = await client.createConversation({
        commandId: crypto.randomUUID(),
        kind: ownerKind,
        ownerId,
        name: name.trim(),
        providerId: selected.providerId,
        modelId: selected.modelId,
      });
      setName("");
      setQualifiedId("");
      setOpen(false);
      setPending(false);
      onCreated(conversation);
    } catch (cause) {
      setError(messageOf(cause, "The Conversation could not be created."));
      setPending(false);
    }
  };
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="product-secondary product-new-conversation"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        {compact ? "＋ 新会话" : "New Conversation"}
      </button>
      {open && (
        <div
          className="product-dialog-backdrop"
          onKeyDown={(event) => {
            if (event.key === "Escape" && !pending) close();
            if (event.key !== "Tab") return;
            const focusable = Array.from(
              dialogRef.current?.querySelectorAll<HTMLElement>(
                "button:not(:disabled), input:not(:disabled), select:not(:disabled), "
                + "textarea:not(:disabled), a[href], [tabindex]:not([tabindex='-1'])",
              ) ?? [],
            );
            if (focusable.length === 0) {
              event.preventDefault();
              return;
            }
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first.focus();
            }
          }}
        >
          <section
            ref={dialogRef}
            className="product-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
          >
            <form
              className="product-conversation-form"
              onSubmit={(event) => void submit(event)}
            >
              <strong id={titleId}>{compact ? "新会话" : "New Conversation"}</strong>
              <label>
                Name
                <input
                  autoFocus
                  required
                  maxLength={120}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <label>
                Provider / model
                <select
                  required
                  disabled={options.length === 0}
                  value={qualifiedId || selected?.qualifiedId || ""}
                  onChange={(event) => setQualifiedId(event.target.value)}
                >
                  {options.map((provider) => (
                    <option key={provider.qualifiedId} value={provider.qualifiedId}>
                      {provider.qualifiedId}
                    </option>
                  ))}
                </select>
              </label>
              {providers?.mode === "read_only" && (
                <p className="product-form-note" role="status">
                  OpenCode is unavailable. Existing resources and lifecycle controls remain available.
                </p>
              )}
              {!providers && (
                <p className="product-form-note" role="status">
                  Loading provider options…
                </p>
              )}
              {error && <p className="product-form-error" role="alert">{error}</p>}
              <div>
                <button
                  type="submit"
                  className="product-primary"
                  disabled={pending || !selected || !name.trim()}
                >
                  {pending ? "Creating…" : "Create"}
                </button>
                <button
                  type="button"
                  className="product-secondary"
                  onClick={close}
                  disabled={pending}
                >
                  Cancel
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </>
  );
}

function ConversationControls({
  client,
  conversation,
  providers,
  compact = false,
  onChanged,
  onError,
}: Readonly<{
  client: ProductClient;
  conversation: ConversationSummary;
  providers?: ProviderDiscovery;
  compact?: boolean;
  onChanged: (removed: boolean) => Promise<void>;
  onError: (message: string) => void;
}>) {
  const [rename, setRename] = useState(conversation.name);
  const [qualifiedId, setQualifiedId] = useState(
    `${conversation.provider.providerId}/${conversation.provider.modelId}`,
  );
  const [pending, setPending] = useState(false);
  const options = providers?.mode === "live" ? providers.providerModels : [];
  const selected = options.find((provider) => provider.qualifiedId === qualifiedId);
  const act = async (operation: () => Promise<unknown>, removed = false) => {
    setPending(true);
    try {
      await operation();
      await onChanged(removed);
    } catch (cause) {
      onError(messageOf(cause, "The Conversation action could not be completed."));
    } finally {
      setPending(false);
    }
  };
  return (
    <section className={`product-conversation-controls${compact ? " product-conversation-controls-compact" : ""}`} aria-label="Conversation controls">
      <details>
        <summary>Manage Conversation</summary>
        <form onSubmit={(event) => {
          event.preventDefault();
          void act(() => client.renameConversation({
            commandId: crypto.randomUUID(),
            conversationId: conversation.id,
            expectedRecordDigest: conversation.recordDigest,
            name: rename.trim(),
          }));
        }}>
          <label>Conversation name<input required maxLength={120} value={rename} onChange={(event) => setRename(event.target.value)} /></label>
          <button type="submit" className="product-secondary" disabled={pending || !rename.trim()}>Rename</button>
        </form>
        <div className="product-lifecycle-actions">
          <button type="button" className="product-secondary" disabled={pending} onClick={() => void act(
            () => client.transitionConversation({
              commandId: crypto.randomUUID(),
              conversationId: conversation.id,
              expectedRecordDigest: conversation.recordDigest,
              action: "archive",
            }),
            true,
          )}>Archive</button>
          <button type="button" className="product-danger" disabled={pending} onClick={() => void act(
            () => client.transitionConversation({
              commandId: crypto.randomUUID(),
              conversationId: conversation.id,
              expectedRecordDigest: conversation.recordDigest,
              action: "trash",
            }),
            true,
          )}>Move to trash</button>
        </div>
      </details>
      {!compact && <div className="product-provider-binding">
        <strong>Provider / model</strong>
        {conversation.provider.locked ? (
          <p>
            {conversation.provider.providerId}/{conversation.provider.modelId} · locked after the first accepted message
          </p>
        ) : (
          <form onSubmit={(event) => {
            event.preventDefault();
            if (!selected) return;
            void act(() => client.changeConversationProvider({
              commandId: crypto.randomUUID(),
              conversationId: conversation.id,
              expectedRecordDigest: conversation.recordDigest,
              providerId: selected.providerId,
              modelId: selected.modelId,
            }));
          }}>
            <label>
              Change provider / model before the first message
              <select
                disabled={pending || options.length === 0}
                value={qualifiedId}
                onChange={(event) => setQualifiedId(event.target.value)}
              >
                {options.map((provider) => (
                  <option key={provider.qualifiedId} value={provider.qualifiedId}>
                    {provider.qualifiedId}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" className="product-secondary" disabled={pending || !selected}>Update provider</button>
            {!providers && (
              <p className="product-form-note" role="status">
                Loading provider options…
              </p>
            )}
            {providers?.mode === "read_only" && (
              <p className="product-form-note" role="status">
                Provider options are unavailable. Lifecycle controls remain available.
              </p>
            )}
          </form>
        )}
      </div>}
    </section>
  );
}

function RuntimeControls({
  client,
  conversationId,
  runtime,
  unavailable,
  onChanged,
  onError,
}: Readonly<{
  client: ProductClient;
  conversationId: string;
  runtime?: ConversationRuntimeProjection;
  unavailable: boolean;
  onChanged: () => Promise<void>;
  onError: (message: string) => void;
}>) {
  const [pending, setPending] = useState<string>();
  if (!runtime) {
    return unavailable ? null : (
      <section className="product-runtime-controls" aria-label="Agent runtime controls">
        <p className="product-form-note" role="status">Restoring live Agent state…</p>
      </section>
    );
  }
  const invoke = async (label: string, operation: (() => Promise<unknown>) | undefined) => {
    if (!operation) return;
    setPending(label);
    try {
      await operation();
      await onChanged();
    } catch (cause) {
      onError(messageOf(cause, `The Agent could not ${label}.`));
    } finally {
      setPending((current) => current === label ? undefined : current);
    }
  };
  const active = runtime.activeTurn;
  return (
    <section className="product-runtime-controls" aria-label="Agent runtime controls">
      <div className="product-runtime-actions">
        <div>
          <strong>Turn controls</strong>
          <p>{statusDescription(runtime.status)}</p>
        </div>
        <div>
          {active?.canStop && (
            <button
              type="button"
              className="product-danger"
              disabled={Boolean(pending) || !client.stopConversation}
              onClick={() => void invoke("stop", client.stopConversation
                ? () => client.stopConversation!({
                  conversationId,
                  requestKey: active.requestKey,
                })
                : undefined)}
            >
              {pending === "stop" ? "Stopping…" : "Stop"}
            </button>
          )}
          {active?.canRetry && (
            <button
              type="button"
              className="product-secondary"
              disabled={Boolean(pending) || !client.retryConversation}
              onClick={() => void invoke("retry", client.retryConversation
                ? () => client.retryConversation!({
                  conversationId,
                  oldRequestKey: active.requestKey,
                  newRequestKey: crypto.randomUUID(),
                })
                : undefined)}
            >
              {pending === "retry" ? "Retrying…" : "Retry"}
            </button>
          )}
        </div>
      </div>
      {runtime.goalVerification && (
        <GoalVerificationCard verification={runtime.goalVerification} />
      )}
      {runtime.pendingInteractions
        .filter((interaction) => interaction.kind === "permission")
        .map((interaction) => (
        <InteractionResponse
          key={interaction.id}
          interaction={interaction}
          pending={pending === interaction.id}
          disabled={Boolean(pending && pending !== "retry")}
          onPermission={(decision) => invoke(interaction.id,
            client.respondConversationInteraction && interaction.kind === "permission"
              ? () => client.respondConversationInteraction!({
                conversationId,
                requestKey: active?.requestKey ?? "",
                interactionId: interaction.id,
                kind: "permission",
                decision,
              })
              : undefined)}
          onQuestion={() => Promise.resolve()}
        />
      ))}
    </section>
  );
}

function QuestionInteractionDock({
  client,
  conversationId,
  runtime,
  onChanged,
  onError,
}: Readonly<{
  client: ProductClient;
  conversationId: string;
  runtime?: ConversationRuntimeProjection;
  onChanged: () => Promise<void>;
  onError: (message: string) => void;
}>) {
  const [pending, setPending] = useState<string>();
  const dockRef = useRef<HTMLDivElement>(null);
  const questionInteractions = runtime?.pendingInteractions.filter(
    (interaction) => interaction.kind === "question",
  ) ?? [];
  const questionKey = questionInteractions.map((interaction) => interaction.id).join("\u0000");
  const seenQuestionKeyRef = useRef("");

  useEffect(() => {
    if (questionKey === seenQuestionKeyRef.current) return;
    seenQuestionKeyRef.current = questionKey;
    if (!questionKey) return;
    requestAnimationFrame(() => {
      const firstAnswerable = dockRef.current?.querySelector<HTMLElement>(
        "input:not(:disabled), textarea:not(:disabled), button:not(:disabled)",
      );
      firstAnswerable?.focus({ preventScroll: true });
    });
  }, [questionKey]);

  const invoke = async (interactionId: string, operation: (() => Promise<unknown>) | undefined) => {
    if (!operation || pending) return;
    setPending(interactionId);
    try {
      await operation();
      await onChanged();
    } catch (cause) {
      onError(messageOf(cause, "The question response could not be submitted."));
    } finally {
      setPending((current) => current === interactionId ? undefined : current);
    }
  };

  if (questionInteractions.length === 0) return null;
  return (
    <section
      ref={dockRef}
      className="product-question-interaction-dock"
      data-testid="conversation-question-dock"
      aria-label="Pending questions"
    >
      {questionInteractions.map((interaction) => (
        <InteractionResponse
          key={interaction.id}
          interaction={interaction}
          pending={pending === interaction.id}
          disabled={Boolean(pending)}
          onPermission={() => Promise.resolve()}
          onQuestion={(response) => invoke(
            interaction.id,
            client.respondConversationInteraction
              ? () => client.respondConversationInteraction!({
                conversationId,
                requestKey: runtime?.activeTurn?.requestKey ?? "",
                interactionId: interaction.id,
                kind: "question",
                response,
              })
              : undefined,
          )}
        />
      ))}
    </section>
  );
}

function GoalVerificationCard({
  verification,
}: Readonly<{
  verification: NonNullable<ConversationRuntimeProjection["goalVerification"]>;
}>) {
  const copy = goalVerificationCopy(verification);
  const actionSummary = verification.evidence.actionCount > 0
    ? `${verification.evidence.committedActionCount} committed of `
      + `${verification.evidence.actionCount} recorded actions.`
    : verification.evidence.intentKind === "response_delivery"
      ? "The assistant response was durably delivered."
      : "No workspace mutation was verified.";
  const ownerStateSummary =
    verification.evidence.intentKind === "response_delivery"
      ? "No workspace outcome is claimed."
      : verification.evidence.ownerStateVerified
        ? "The durable owner state captured at verification was verified."
        : "The owner state captured at verification was not sufficient to prove the goal.";
  return (
    <section
      className={`product-goal-verification product-goal-verification-${verification.disposition}`}
      aria-label="Goal verification"
      role="status"
    >
      <div>
        <strong>{copy.title}</strong>
        <span>{copy.description}</span>
      </div>
      <small>
        {actionSummary}
        {" "}
        {ownerStateSummary}
      </small>
    </section>
  );
}

function InteractionResponse({
  interaction,
  pending,
  disabled,
  onPermission,
  onQuestion,
}: Readonly<{
  interaction: ConversationRuntimeProjection["pendingInteractions"][number];
  pending: boolean;
  disabled: boolean;
  onPermission: (decision: "allow_once" | "reject") => Promise<void>;
  onQuestion: (response: Readonly<{ answers: readonly (readonly string[])[] } | { reject: true }>) => Promise<void>;
}>) {
  const [decision, setDecision] = useState<"allow_once" | "reject">(
    interaction.kind === "permission" ? interaction.decisions[0] ?? "reject" : "allow_once",
  );
  const [answers, setAnswers] = useState<string[][]>(() =>
    interaction.kind === "question"
      ? interaction.questions.map((question) =>
        !question.multiple && question.choices[0]
          ? [question.choices[0].value]
          : [])
      : []);
  const [customAnswers, setCustomAnswers] = useState<string[]>(() =>
    interaction.kind === "question"
      ? interaction.questions.map(() => "")
      : []);
  const submittedAnswers = interaction.kind === "question"
    ? answers.map((answer, index) => [
      ...answer,
      ...(customAnswers[index]?.trim() ? [customAnswers[index].trim()] : []),
    ])
    : [];
  const validAnswers = interaction.kind === "question"
    && submittedAnswers.length === interaction.questions.length
    && submittedAnswers.every((answer) => answer.some((value) => value.trim()));
  return (
    <form
      className={`product-interaction-card product-interaction-card-${interaction.kind}`}
      onSubmit={(event) => {
        event.preventDefault();
        if (interaction.kind === "permission") void onPermission(decision);
        else if (validAnswers) void onQuestion({ answers: submittedAnswers });
      }}
    >
      <span className="product-interaction-kind">
        {interaction.kind === "permission" ? "Permission required" : "Question"}
      </span>
      <strong>{interaction.title}</strong>
      {interaction.kind === "permission" ? (
        <fieldset disabled={disabled}>
          <legend>{interaction.prompt}</legend>
          {interaction.decisions.map((value) => (
            <label key={value}>
              <input
                type="radio"
                name={`interaction-${interaction.id}`}
                value={value}
                checked={decision === value}
                onChange={() => setDecision(value)}
              />
              {value === "allow_once" ? "Allow once" : "Reject"}
            </label>
          ))}
        </fieldset>
      ) : (
        <>
          {interaction.questions.map((question, index) => (
            <fieldset key={`${interaction.id}-question-${index}`} disabled={disabled}>
              <legend>{question.prompt}</legend>
              {question.choices.map((choice) => {
                const checked = answers[index]?.includes(choice.value) ?? false;
                return (
                  <label key={`${index}-${choice.value}`}>
                    <input
                      type={question.multiple ? "checkbox" : "radio"}
                      name={`interaction-${interaction.id}-question-${index}`}
                      value={choice.value}
                      checked={checked}
                      onChange={(event) => setAnswers((current) =>
                        current.map((answer, answerIndex) => {
                          if (answerIndex !== index) return answer;
                          if (!question.multiple) return [choice.value];
                          return event.target.checked
                            ? [...answer, choice.value]
                            : answer.filter((value) => value !== choice.value);
                        }))}
                    />
                    {choice.label}
                  </label>
                );
              })}
              {question.custom && (
                <textarea
                  aria-label={question.choices.length
                    ? `Answer ${index + 1} custom`
                    : `Answer ${index + 1}`}
                  rows={3}
                  maxLength={1_000}
                  value={customAnswers[index] ?? ""}
                  onChange={(event) => setCustomAnswers((current) =>
                    current.map((answer, answerIndex) =>
                      answerIndex === index ? event.target.value : answer))}
                />
              )}
            </fieldset>
          ))}
          <button
            type="button"
            className="product-secondary"
            disabled={disabled}
            onClick={() => void onQuestion({ reject: true })}
          >
            Decline to answer
          </button>
        </>
      )}
      <button
        type="submit"
        className="product-primary"
        disabled={disabled || (interaction.kind === "question" && !validAnswers)}
      >
        {pending
          ? "Sending…"
          : interaction.kind === "permission"
            ? decision === "allow_once" ? "Allow once & Resume" : "Reject request"
            : "Send answers & Resume"}
      </button>
    </form>
  );
}

function Transcript({
  bundle,
  runtime,
}: Readonly<{
  bundle: ConversationBundle;
  runtime?: ConversationRuntimeProjection;
}>) {
  const runtimeParts = runtime?.parts.filter((part) =>
    !(runtime.activeTurn?.canStop !== true
      && part.kind === "text"
      && part.state === "complete"
      && bundle.messages.some((message) =>
        message.role === "assistant"
        && message.status === "complete"
        && message.text === part.summary)));
  return (
    <>
      <ol className="product-message-list" aria-label="Conversation messages">
        {bundle.messages.map((message) => (
          <li key={message.id} className={`product-message product-message-${message.role}`}>
            <strong>{message.role === "assistant" ? "Assistant" : message.role === "user" ? "You" : "Platform"}</strong>
            <p>{message.text}</p>
            <small>{message.status}</small>
          </li>
        ))}
      </ol>
      {runtime && runtimeParts && runtimeParts.length > 0 && (
        <section className="product-runtime-parts" aria-labelledby="runtime-parts-heading">
          <div className="product-runtime-heading">
            <h3 id="runtime-parts-heading">Live Agent activity</h3>
            <span className={`product-runtime-mcp product-runtime-mcp-${runtime.mcp.state}`}>
              MCP: {runtime.mcp.label}
            </span>
          </div>
          <ol>
            {runtimeParts.map((part) => (
              <li key={part.id} className={`product-runtime-part product-runtime-part-${part.kind}`}>
                <span className="product-runtime-part-icon" aria-hidden="true">
                  {partIcon(part.kind)}
                </span>
                <div>
                  <strong>{part.title}</strong>
                  {part.summary && <p>{part.summary}</p>}
                  <small>{partStateLabel(part.state)}</small>
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}
      {bundle.attachments.length > 0 && (
        <section className="product-conversation-records" aria-labelledby="attachment-heading">
          <h3 id="attachment-heading">Attachments</h3>
          <ul>
            {bundle.attachments.map((attachment) => (
              <li key={attachment.id}>
                <strong>{attachment.originalName}</strong>
                <span>{attachment.mediaType} · {formatBytes(attachment.sizeBytes)}</span>
                {attachment.purpose && <span>{attachment.purpose}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
      {bundle.documents.length > 0 && (
        <section className="product-conversation-records" aria-labelledby="document-heading">
          <h3 id="document-heading">Temporary documents</h3>
          <ul>
            {bundle.documents.map((document) => (
              <li key={document.id}>
                <strong>{document.name}</strong>
                <span>{document.mediaType} · {document.documentState}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {(bundle.skillUses.length > 0 || bundle.actions.length > 0) && (
        <section className="product-conversation-records" aria-labelledby="action-heading">
          <h3 id="action-heading">Agent activity</h3>
          <ul>
            {bundle.skillUses.map((skill) => (
              <li key={skill.id}>
                <strong>Skill: {skill.skillId}</strong>
                <span>{skill.routingMode} · {skill.loadState}</span>
              </li>
            ))}
            {bundle.actions.map((action) => (
              <li key={action.id}>
                <strong>{action.actionKind}</strong>
                <span>{action.permissionDecision} · {action.state}</span>
                {action.state === "committed"
                  && action.mutationReceipt?.operation === "direct_apply" && (
                  <div className="product-action-receipt" role="status">
                    <strong>Applied</strong>
                    <span>
                      Receipt <code>{action.mutationReceipt.receiptDigest}</code>
                    </span>
                    <span>
                      {action.mutationReceipt.files.length} file
                      {action.mutationReceipt.files.length === 1 ? "" : "s"} committed
                    </span>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function AttachmentForm({
  client,
  conversationId,
  onUploaded,
}: Readonly<{
  client: ProductClient;
  conversationId: string;
  onUploaded: () => void;
}>) {
  const [file, setFile] = useState<File>();
  const [purpose, setPurpose] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!file) return;
    if (file.size < 1 || file.size > 1_048_576) {
      setError("Attachments must be between 1 byte and 1 MiB.");
      return;
    }
    setPending(true);
    setError(undefined);
    try {
      await client.uploadConversationAttachment({
        commandId: crypto.randomUUID(),
        conversationId,
        originalName: file.name,
        mediaType: file.type || "application/octet-stream",
        base64: await fileBase64(file),
        ...(purpose.trim() ? { purpose: purpose.trim() } : {}),
      });
      setFile(undefined);
      setPurpose("");
      onUploaded();
    } catch (cause) {
      setError(messageOf(cause, "The attachment could not be uploaded."));
    } finally {
      setPending(false);
    }
  };
  return (
    <form className="product-attachment-form" onSubmit={(event) => void submit(event)}>
      <strong>Add attachment</strong>
      <label>
        File
        <input
          type="file"
          accept=".txt,.md,.csv,.json,.png,.jpg,.jpeg,.pdf"
          onChange={(event) => setFile(event.target.files?.[0])}
        />
      </label>
      <label>Purpose<input maxLength={200} value={purpose} onChange={(event) => setPurpose(event.target.value)} /></label>
      {error && <p className="product-form-error" role="alert">{error}</p>}
      <button type="submit" className="product-secondary" disabled={pending || !file}>
        {pending ? "Uploading…" : "Upload"}
      </button>
    </form>
  );
}

function Composer({
  client,
  disabled,
  disabledMessage,
  sending,
  bundle,
  providers,
  agents,
  runtime,
  onProviderChange,
  onSend,
  onCommand,
}: Readonly<{
  client: ProductClient;
  disabled: boolean;
  disabledMessage?: string;
  sending: boolean;
  bundle: ConversationBundle;
  providers?: ProviderDiscovery;
  agents?: AgentDiscovery;
  runtime?: ConversationRuntimeProjection;
  onProviderChange: (providerId: string, modelId: string) => Promise<void>;
  onSend: (text: string, attachmentIds: readonly string[], agentName?: string) => Promise<void>;
  onCommand: (commandId: ComposerCommandId, commandKey: string, expectedRevision: string) => Promise<void>;
}>) {
  const [text, setText] = useState("");
  const [attachmentIds, setAttachmentIds] = useState<string[]>([]);
  const [agentName, setAgentName] = useState("");
  const [providerPending, setProviderPending] = useState(false);
  const [capabilities, setCapabilities] = useState<ComposerCapabilities>();
  const [menu, setMenu] = useState<"commands" | "skills">();
  const [menuQuery, setMenuQuery] = useState("");
  const [menuIndex, setMenuIndex] = useState(0);
  const [selectedCommand, setSelectedCommand] = useState<Readonly<{
    id: ComposerCommandId;
    label: string;
    expectedRevision: string;
  }>>();
  const providerOptions = providers?.mode === "live" ? providers.providerModels : [];
  const selectedProvider = `${bundle.conversation.provider.providerId}/${bundle.conversation.provider.modelId}`;
  const providerLocked = bundle.conversation.provider.locked;
  useEffect(() => {
    if (runtime?.agent.selectedName) setAgentName(runtime.agent.selectedName);
  }, [runtime?.agent.selectedName]);
  useEffect(() => {
    let cancelled = false;
    if (!client.composerCapabilities) {
      setCapabilities(undefined);
      return;
    }
    void client.composerCapabilities(bundle.conversation.id).then((next) => {
      if (!cancelled) setCapabilities(next);
    }).catch(() => {
      if (!cancelled) setCapabilities(undefined);
    });
    return () => { cancelled = true; };
  }, [bundle.conversation.id, client, runtime?.revision]);
  const commandOptions = capabilities?.commands.filter((command) =>
    command.slash.includes(menuQuery.trim().toLowerCase())
      || command.label.toLowerCase().includes(menuQuery.trim().toLowerCase())) ?? [];
  const skillOptions = capabilities?.skills.filter((skill) =>
    skill.id.includes(menuQuery.trim().toLowerCase())
      || skill.description.toLowerCase().includes(menuQuery.trim().toLowerCase())) ?? [];
  const closeMenu = () => { setMenu(undefined); setMenuQuery(""); setMenuIndex(0); };
  const submitCommand = () => {
    if (!selectedCommand || disabled || sending) return;
    const command = selectedCommand;
    setSelectedCommand(undefined);
    void onCommand(command.id, crypto.randomUUID(), command.expectedRevision);
  };
  return (
    <form className="product-composer" onSubmit={(event) => {
      event.preventDefault();
      if (selectedCommand) { submitCommand(); return; }
      if (!text.trim() || text.trim().startsWith("/")) return;
      const accepted = text.trim();
      setText("");
      void onSend(accepted, attachmentIds, agentName || undefined);
    }}>
      <label className="product-composer-model">
        Model for this conversation
        <select
          aria-label="Model for this conversation"
          value={selectedProvider}
          disabled={disabled || sending || providerPending || providerLocked || providerOptions.length === 0}
          title={providerLocked ? "Model selection is locked after the first accepted message." : undefined}
          onChange={(event) => {
            const selection = providerOptions.find((provider) => provider.qualifiedId === event.target.value);
            if (!selection) return;
            setProviderPending(true);
            void onProviderChange(selection.providerId, selection.modelId)
              .finally(() => setProviderPending(false));
          }}
        >
          {!providerOptions.some((provider) => provider.qualifiedId === selectedProvider) && (
            <option value={selectedProvider}>{selectedProvider}</option>
          )}
          {providerOptions.map((provider) => (
            <option key={provider.qualifiedId} value={provider.qualifiedId}>{provider.qualifiedId}</option>
          ))}
        </select>
      </label>
      <label className="product-composer-agent">
        Agent for this turn
        <select
          value={agentName}
          disabled={disabled || sending || runtime?.agent.locked}
          onChange={(event) => setAgentName(event.target.value)}
        >
          <option value="">Default Agent</option>
          {agents?.agents.map((agent) => (
            <option key={agent.name} value={agent.name}>{agent.label}</option>
          ))}
        </select>
      </label>
      {runtime?.agent.locked && (
        <p className="product-form-note" role="status">
          Agent selection is locked for the active turn.
        </p>
      )}
      <label className="product-composer-message">
        Message
        {selectedCommand && (
          <span className="product-composer-command-chip" role="status">
            /{selectedCommand.id} · {selectedCommand.label}
            <button type="button" aria-label="Remove command" onClick={() => setSelectedCommand(undefined)}>×</button>
          </span>
        )}
        <textarea
          required
          placeholder="Ask anything, / for commands, @ for context…"
          rows={4}
          maxLength={64_000}
          value={text}
          disabled={disabled || sending}
          onChange={(event) => {
            const next = event.target.value;
            setText(next);
            if (selectedCommand) return;
            if (/^\/[^\s]*$/u.test(next)) {
              setMenu("commands");
              setMenuQuery(next.slice(1));
              setMenuIndex(0);
            } else if (/^\$[^\s]*$/u.test(next)) {
              setMenu("skills");
              setMenuQuery(next.slice(1));
              setMenuIndex(0);
            } else if (menu) closeMenu();
          }}
          onKeyDown={(event) => {
            const options = menu === "commands" ? commandOptions : skillOptions;
            if (menu && event.key === "Escape") { event.preventDefault(); closeMenu(); return; }
            if (menu && event.key === "ArrowDown") { event.preventDefault(); setMenuIndex((current) => Math.min(current + 1, Math.max(0, options.length - 1))); return; }
            if (menu && event.key === "ArrowUp") { event.preventDefault(); setMenuIndex((current) => Math.max(0, current - 1)); return; }
            if (menu && event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              const option = options[menuIndex];
              if (!option) return;
              if (menu === "commands") {
                const command = option as ComposerCapabilities["commands"][number];
                if (command.availability === "enabled") {
                  setSelectedCommand({ id: command.id, label: command.label, expectedRevision: capabilities!.revision });
                  setText("");
                  closeMenu();
                }
              } else {
                const skill = option as ComposerCapabilities["skills"][number];
                setText(`$${skill.id} `);
                closeMenu();
              }
            }
          }}
        />
        {menu && (
          <div className="product-composer-menu" role="listbox" aria-label={menu === "commands" ? "Conversation commands" : "Allowed Skills"}>
            {(menu === "commands" ? commandOptions : skillOptions).length === 0 && (
              <span className="product-composer-menu-empty">{menu === "skills" ? "No allowed Skills" : "No matching commands"}</span>
            )}
            {(menu === "commands" ? commandOptions : skillOptions).map((option, index) => {
              const command = menu === "commands" ? option as ComposerCapabilities["commands"][number] : undefined;
              const skill = menu === "skills" ? option as ComposerCapabilities["skills"][number] : undefined;
              const disabledOption = command?.availability === "disabled";
              return (
                <button
                  type="button"
                  key={command?.id ?? skill?.id}
                  role="option"
                  aria-selected={index === menuIndex}
                  disabled={disabledOption}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    if (command) {
                      setSelectedCommand({ id: command.id, label: command.label, expectedRevision: capabilities!.revision });
                      setText("");
                    } else if (skill) setText(`$${skill.id} `);
                    closeMenu();
                  }}
                >
                  <strong>{command?.slash ?? `$${skill?.id}`}</strong>
                  <span>{command?.description ?? skill?.description}</span>
                  {disabledOption && <small>{command?.reason}</small>}
                </button>
              );
            })}
          </div>
        )}
      </label>
      {bundle.attachments.length > 0 && (
        <fieldset>
          <legend>Attach to this message</legend>
          {bundle.attachments.map((attachment) => (
            <label key={attachment.id}>
              <input
                type="checkbox"
                checked={attachmentIds.includes(attachment.id)}
                onChange={(event) => setAttachmentIds((current) =>
                  event.target.checked
                    ? [...current, attachment.id]
                    : current.filter((id) => id !== attachment.id))}
              />
              {attachment.originalName}
            </label>
          ))}
        </fieldset>
      )}
      {disabled && (
        <p className="product-form-note" role="status">
          {disabledMessage
            ?? "Agent replies are read-only while the configured provider is unavailable. Lifecycle controls remain available."}
        </p>
      )}
      {text.trim().startsWith("/") && !selectedCommand && (
        <p className="product-form-note" role="status">Select a supported command from the menu before sending.</p>
      )}
      <button type="submit" className="product-primary" disabled={disabled || sending || (!selectedCommand && !text.trim())}>
        {sending ? "Connecting…" : selectedCommand ? "Run command" : "Send"}
      </button>
    </form>
  );
}

function RecoveryLists({
  client,
  collections,
  onRestore,
  onError,
}: Readonly<{
  client: ProductClient;
  collections: ConversationCollections;
  onRestore: () => void;
  onError: (message: string) => void;
}>) {
  const recover = async (conversation: ConversationSummary) => {
    try {
      await client.transitionConversation({
        commandId: crypto.randomUUID(),
        conversationId: conversation.id,
        expectedRecordDigest: conversation.recordDigest,
        action: "restore",
      });
      onRestore();
    } catch (cause) {
      onError(messageOf(cause, "The Conversation could not be restored."));
    }
  };
  return (
    <div className="product-recovery-lists">
      {([
        ["Archived", collections.archived],
        ["Trash", collections.trashed],
      ] as const).map(([label, conversations]) => conversations.length > 0 && (
        <details key={label}>
          <summary>{label} ({conversations.length})</summary>
          <ul>
            {conversations.map((conversation) => (
              <li key={conversation.id}>
                <span>{conversation.name}</span>
                <button type="button" className="product-secondary" onClick={() => void recover(conversation)}>
                  Restore
                </button>
                {label === "Trash" && (
                  <PermanentDeleteControls
                    client={client}
                    conversation={conversation}
                    onDeleted={onRestore}
                    onError={onError}
                  />
                )}
              </li>
            ))}
          </ul>
        </details>
      ))}
    </div>
  );
}

function PermanentDeleteControls({
  client,
  conversation,
  onDeleted,
  onError,
}: Readonly<{
  client: ProductClient;
  conversation: ConversationSummary;
  onDeleted: () => void;
  onError: (message: string) => void;
}>) {
  const [preview, setPreview] = useState<PermanentDeletePreview>();
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const previewId = useId();
  const confirmationRef = useRef<HTMLInputElement>(null);
  const previewDelete = async () => {
    setPending(true);
    setPreview(undefined);
    setConfirmation("");
    try {
      const nextPreview = await client.previewConversationPermanentDelete(
        conversation.id,
      );
      setPreview(nextPreview);
      if (nextPreview.blockingReferences.length === 0) {
        requestAnimationFrame(() => confirmationRef.current?.focus());
      }
    } catch (cause) {
      onError(messageOf(cause, "The permanent-delete preview could not be created."));
    } finally {
      setPending(false);
    }
  };
  const commitDelete = async () => {
    if (!preview || confirmation !== conversation.name
      || preview.blockingReferences.length > 0) return;
    setPending(true);
    try {
      await client.permanentlyDeleteConversation({
        commandId: crypto.randomUUID(),
        preview,
      });
      onDeleted();
    } catch (cause) {
      setPreview(undefined);
      setConfirmation("");
      onError(messageOf(cause, "The Conversation was not permanently deleted. Create a new preview."));
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="product-permanent-delete">
      <button
        type="button"
        className="product-danger"
        disabled={pending}
        onClick={() => void previewDelete()}
      >
        {pending ? "Checking…" : "Preview permanent delete"}
      </button>
      {preview && (
        <section aria-labelledby={previewId}>
          <strong id={previewId}>Permanent-delete preview</strong>
          <p>
            This preview is not a deletion. It covers {preview.recordCount} records,{" "}
            {preview.fileCount} files, and {formatBytes(preview.totalBytes)}.
          </p>
          {preview.exclusions.length > 0 && (
            <p>{preview.exclusions.length} related resources are explicitly excluded.</p>
          )}
          {preview.blockingReferences.length > 0 ? (
            <p role="alert">
              Permanent delete is blocked by {preview.blockingReferences.length} active references.
            </p>
          ) : (
            <>
              <label>
                Type “{conversation.name}” to confirm
                <input
                  ref={confirmationRef}
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                  autoComplete="off"
                />
              </label>
              <button
                type="button"
                className="product-danger"
                disabled={pending || confirmation !== conversation.name}
                onClick={() => void commitDelete()}
              >
                Permanently delete Conversation
              </button>
            </>
          )}
        </section>
      )}
    </div>
  );
}

const conversationStatus = (
  conversation: ConversationSummary | undefined,
  providers: ProviderDiscovery | undefined,
  readOnlyReason: string | undefined,
  runtime: ConversationRuntimeProjection | undefined,
  sending: boolean,
): ConversationRuntimeStatus | "connecting" | "read_only" => {
  if (runtime?.status === "waiting_for_user"
    || runtime?.status === "waiting_for_tool") {
    return runtime.status;
  }
  if (sending) return "busy";
  if (!conversation || !providers) return "connecting";
  if (readOnlyReason || providers.mode === "read_only"
    || conversation.sessionState === "read_only") return "read_only";
  if (runtime) return runtime.status;
  if (conversation.sessionState === "lost") return "failed";
  if (conversation.sessionState === "connecting") return "connecting";
  return "idle";
};

const statusDescription = (
  status: ConversationRuntimeStatus | "connecting" | "read_only",
): string => ({
  busy: "The Agent is reasoning or streaming a response.",
  waiting_for_tool: "A scoped tool is running. You can stop this turn.",
  waiting_for_user: "The Agent needs your permission or an answer before it can continue.",
  idle: "The Conversation is ready for your next message.",
  failed: "This turn stopped with an error. Review the activity before retrying.",
  connecting: "Restoring the Conversation session.",
  read_only: "The configured provider is unavailable; existing records remain readable.",
})[status];

const goalVerificationCopy = (
  verification: NonNullable<ConversationRuntimeProjection["goalVerification"]>,
): Readonly<{ title: string; description: string }> => {
  if (verification.disposition === "completed"
    && verification.evidence.intentKind === "response_delivery") {
    return {
      title: "Response delivered",
      description: "OpenCode reached idle and the assistant response was durably recorded.",
    };
  }
  return ({
  completed: {
    title: "Goal verified",
    description: "OpenCode reached idle and the current durable workspace satisfies this goal.",
  },
  needs_user_input: {
    title: "Needs your input",
    description: "The turn is terminal, but durable evidence cannot prove the requested outcome. Send a clarifying or corrective message.",
  },
  outcome_unknown: {
    title: "Outcome unknown",
    description: "An action may have taken effect before the turn stopped. Review the current Model or Project before sending another instruction.",
  },
  budget_exhausted: {
    title: "Budget exhausted",
    description: "The turn reached its wall-clock budget before a durable effect was verified. Send a new message to continue.",
  },
  read_only: {
    title: "Provider unavailable",
    description: "The Agent could not start, so existing durable workspace state remains readable.",
  },
  failed: {
    title: "Goal not completed",
    description: "The turn stopped before a durable effect was verified. Review the activity before continuing.",
  },
  })[verification.disposition];
};

const partIcon = (kind: ConversationRuntimeProjection["parts"][number]["kind"]): string => ({
  text: "A",
  tool_call: "↗",
  tool_result: "✓",
  error: "!",
  command: ">",
  skill: "S",
  mcp: "M",
})[kind];

const partStateLabel = (
  state: ConversationRuntimeProjection["parts"][number]["state"],
): string => ({
  streaming: "Streaming",
  pending: "In progress",
  complete: "Complete",
  failed: "Failed",
})[state];

const fileBase64 = async (file: File): Promise<string> => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
};

const formatBytes = (bytes: number): string =>
  bytes < 1_024 ? `${bytes} B` : `${(bytes / 1_024).toFixed(1)} KiB`;

const messageOf = (cause: unknown, fallback: string): string =>
  cause instanceof Error && cause.message ? cause.message : fallback;

const optionalRuntimeUnavailable = (cause: unknown): boolean =>
  cause instanceof ProductApiError && [404, 405].includes(cause.status);
