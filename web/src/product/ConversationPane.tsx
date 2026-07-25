import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import type { ProductClient } from "./api";
import { navigateProduct, workspaceHref } from "./router";
import type {
  ConversationBundle,
  ConversationSummary,
  OwnerKind,
  PermanentDeletePreview,
  ProviderDiscovery,
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
}: Readonly<{
  client: ProductClient;
  ownerKind: OwnerKind;
  ownerId: string;
  selectedConversationId?: string;
  onOwnerChanged?: () => Promise<void> | void;
}>) {
  const [collections, setCollections] =
    useState<ConversationCollections>(emptyCollections);
  const [providers, setProviders] = useState<ProviderDiscovery>();
  const [bundle, setBundle] = useState<ConversationBundle>();
  const [loading, setLoading] = useState(true);
  const [sendingConversationId, setSendingConversationId] = useState<string>();
  const [error, setError] = useState<string>();
  const [readOnlyReason, setReadOnlyReason] = useState<string>();
  const paneRef = useRef<HTMLDivElement>(null);
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
    ]).catch((cause) => {
      if (current) setError(messageOf(cause, "Conversations could not be loaded."));
    }).finally(() => {
      if (current) setLoading(false);
    });
    return () => { current = false; };
  }, [client, ownerKind, ownerId]);

  useEffect(() => {
    let current = true;
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

  const refreshConversation = async (conversationId: string) => {
    await refreshCollections();
    const nextBundle = await client.conversationBundle(conversationId);
    if (selectedIdRef.current === conversationId) setBundle(nextBundle);
  };

  const selectConversation = (conversationId: string) => {
    selectedIdRef.current = conversationId;
    setBundle(undefined);
    setReadOnlyReason(undefined);
    navigateProduct(workspaceHref(ownerKind, ownerId, conversationId));
  };
  const focusConversationNavigation = () => {
    requestAnimationFrame(() => {
      paneRef.current?.querySelector<HTMLElement>(
        ".product-conversation-list a, .product-new-conversation",
      )?.focus();
    });
  };

  const sending = sendingConversationId === selected?.id;
  const status = sending
    ? "connecting"
    : conversationStatus(bundle?.conversation, providers, readOnlyReason);

  return (
    <div className="product-conversation-content" ref={paneRef}>
      <p className={`product-agent-status product-agent-status-${status}`} role="status">
        Agent: {status.replace("_", " ")}
      </p>
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
      />
      <NewConversationForm
        client={client}
        ownerKind={ownerKind}
        ownerId={ownerId}
        providers={providers}
        onCreated={(conversation) => {
          void refreshCollections().then(() => selectConversation(conversation.id));
        }}
      />
      {bundle && bundle.conversation.lifecycleState === "active" && (
        <>
          <ConversationControls
            client={client}
            conversation={bundle.conversation}
            providers={providers}
            onChanged={async (removed) => {
              await refreshCollections();
              if (selectedIdRef.current !== bundle.conversation.id) return;
              if (removed) {
                selectedIdRef.current = undefined;
                setBundle(undefined);
                setReadOnlyReason(undefined);
                navigateProduct(workspaceHref(ownerKind, ownerId));
                focusConversationNavigation();
              } else {
                await refreshConversation(bundle.conversation.id);
              }
            }}
            onError={(message) => {
              if (selectedIdRef.current === bundle.conversation.id) setError(message);
            }}
          />
          <Transcript bundle={bundle} />
          <AttachmentForm
            client={client}
            conversationId={bundle.conversation.id}
            onUploaded={() => {
              const conversationId = bundle.conversation.id;
              void refreshConversation(conversationId).catch((cause) => {
                if (selectedIdRef.current === conversationId) {
                  setError(messageOf(cause, "Attachments could not be refreshed."));
                }
              });
            }}
          />
          <Composer
            disabled={status === "read_only"}
            sending={sending}
            bundle={bundle}
            onSend={async (text, attachmentIds) => {
              const conversationId = bundle.conversation.id;
              setSendingConversationId(conversationId);
              setError(undefined);
              try {
                const result = await client.sendTurn({
                  requestKey: crypto.randomUUID(),
                  conversationId,
                  text,
                  attachmentIds,
                });
                if (selectedIdRef.current === conversationId
                  && result.mode === "read_only") {
                  setReadOnlyReason(readOnlyMessage(result.reason));
                }
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
          />
        </>
      )}
      <RecoveryLists
        client={client}
        collections={collections}
        onRestore={() => {
          void refreshCollections().then(focusConversationNavigation).catch((cause) =>
            setError(messageOf(cause, "Conversations could not be refreshed.")));
        }}
        onError={setError}
      />
      {loading && <p className="product-empty" role="status">Loading Conversation…</p>}
    </div>
  );
}

const OWNER_MUTATION_ACTIONS = new Set([
  "attachment_adopt",
  "experiment_configuration_update",
  "model_files_mutate",
]);

function ConversationList({
  conversations,
  selectedId,
  onSelect,
}: Readonly<{
  conversations: readonly ConversationSummary[];
  selectedId?: string;
  onSelect: (id: string) => void;
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
              href={workspaceHref(
                conversation.owner.kind,
                conversation.owner.id,
                conversation.id,
              )}
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
}: Readonly<{
  client: ProductClient;
  ownerKind: OwnerKind;
  ownerId: string;
  providers?: ProviderDiscovery;
  onCreated: (conversation: ConversationSummary) => void;
}>) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [qualifiedId, setQualifiedId] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const titleId = useId();
  const options = providers?.mode === "live" ? providers.providerModels : [];
  const selected = options.find((provider) => provider.qualifiedId === qualifiedId)
    ?? options[0];

  if (!open) {
    return (
      <button
        type="button"
        className="product-secondary product-new-conversation"
        onClick={() => setOpen(true)}
      >
        New Conversation
      </button>
    );
  }
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
    <form className="product-conversation-form" aria-labelledby={titleId} onSubmit={(event) => void submit(event)}>
      <strong id={titleId}>New Conversation</strong>
      <label>Name<input required maxLength={120} value={name} onChange={(event) => setName(event.target.value)} /></label>
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
        <button type="submit" className="product-primary" disabled={pending || !selected || !name.trim()}>
          {pending ? "Creating…" : "Create"}
        </button>
        <button type="button" className="product-secondary" onClick={() => setOpen(false)} disabled={pending}>Cancel</button>
      </div>
    </form>
  );
}

function ConversationControls({
  client,
  conversation,
  providers,
  onChanged,
  onError,
}: Readonly<{
  client: ProductClient;
  conversation: ConversationSummary;
  providers?: ProviderDiscovery;
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
    <section className="product-conversation-controls" aria-label="Conversation controls">
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
      <div className="product-provider-binding">
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
      </div>
    </section>
  );
}

function Transcript({ bundle }: Readonly<{ bundle: ConversationBundle }>) {
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
  disabled,
  sending,
  bundle,
  onSend,
}: Readonly<{
  disabled: boolean;
  sending: boolean;
  bundle: ConversationBundle;
  onSend: (text: string, attachmentIds: readonly string[]) => Promise<void>;
}>) {
  const [text, setText] = useState("");
  const [attachmentIds, setAttachmentIds] = useState<string[]>([]);
  return (
    <form className="product-composer" onSubmit={(event) => {
      event.preventDefault();
      if (!text.trim()) return;
      const accepted = text.trim();
      setText("");
      void onSend(accepted, attachmentIds);
    }}>
      <label>
        Message
        <textarea
          required
          rows={4}
          maxLength={64_000}
          value={text}
          disabled={disabled || sending}
          onChange={(event) => setText(event.target.value)}
        />
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
          Agent replies are read-only while the configured provider is unavailable. Lifecycle controls remain available.
        </p>
      )}
      <button type="submit" className="product-primary" disabled={disabled || sending || !text.trim()}>
        {sending ? "Connecting…" : "Send"}
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
): "live" | "connecting" | "lost" | "read_only" => {
  if (!conversation || !providers) return "connecting";
  if (readOnlyReason || providers.mode === "read_only"
    || conversation.sessionState === "read_only") return "read_only";
  if (conversation.sessionState === "lost") return "lost";
  if (conversation.sessionState === "connecting") return "connecting";
  return "live";
};

const readOnlyMessage = (reason: string | undefined): string => {
  const labels: Record<string, string> = {
    opencode_unavailable: "OpenCode is unavailable.",
    opencode_auth_failed: "OpenCode authentication is unavailable.",
    provider_unavailable: "The configured provider is unavailable.",
    model_unavailable: "The configured provider model is unavailable.",
    session_validation_failed: "The provider session could not be validated.",
    session_rebuild_failed: "The provider session could not be rebuilt.",
    empty_assistant_response: "The provider returned no assistant response.",
  };
  return reason && labels[reason] ? labels[reason] : "The Agent turn is read-only.";
};

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
