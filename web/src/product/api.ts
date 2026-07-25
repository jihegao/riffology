import type {
  AgentTurnResult,
  ConversationAttachment,
  ConversationBundle,
  ConversationMessage,
  ConversationSummary,
  HomeDto,
  ModelCreationDto,
  OwnerKind,
  ProductLifecycleReceipt,
  PermanentDeletePreview,
  PermanentDeleteReceipt,
  ProjectCreationDto,
  ProviderDiscovery,
  TemporaryDocumentCard,
  ActionRecord,
  SkillUse,
  WorkspaceDto,
} from "./types";

type BrowserSession = Readonly<{
  schemaVersion: 1;
  generation: number;
  csrfToken: string;
  expiresAt: string;
}>;

export interface ProductClient {
  home(): Promise<HomeDto>;
  providers(): Promise<ProviderDiscovery>;
  createModel(input: Readonly<{
    commandId: string;
    name: string;
    providerId: string;
    modelId: string;
  }>): Promise<ModelCreationDto>;
  createProject(input: Readonly<{
    commandId: string;
    name: string;
    modelId: string;
  }>): Promise<ProjectCreationDto>;
  workspace(kind: OwnerKind, id: string): Promise<WorkspaceDto>;
  conversations(
    kind: OwnerKind,
    id: string,
    lifecycle?: "active" | "archived" | "trashed",
  ): Promise<readonly ConversationSummary[]>;
  createConversation(input: Readonly<{
    commandId: string;
    kind: OwnerKind;
    ownerId: string;
    name: string;
    providerId: string;
    modelId: string;
  }>): Promise<ConversationSummary>;
  conversationBundle(conversationId: string): Promise<ConversationBundle>;
  changeConversationProvider(input: Readonly<{
    commandId: string;
    conversationId: string;
    expectedRecordDigest: string;
    providerId: string;
    modelId: string;
  }>): Promise<unknown>;
  uploadConversationAttachment(input: Readonly<{
    commandId: string;
    conversationId: string;
    originalName: string;
    mediaType: string;
    base64: string;
    purpose?: string;
  }>): Promise<ConversationAttachment>;
  sendTurn(input: Readonly<{
    requestKey: string;
    conversationId: string;
    text: string;
    attachmentIds: readonly string[];
  }>): Promise<AgentTurnResult>;
  renameConversation(input: Readonly<{
    commandId: string;
    conversationId: string;
    expectedRecordDigest: string;
    name: string;
  }>): Promise<ProductLifecycleReceipt>;
  transitionConversation(input: Readonly<{
    commandId: string;
    conversationId: string;
    expectedRecordDigest: string;
    action: "archive" | "restore" | "trash";
  }>): Promise<ProductLifecycleReceipt>;
  previewConversationPermanentDelete(
    conversationId: string,
  ): Promise<PermanentDeletePreview>;
  permanentlyDeleteConversation(input: Readonly<{
    commandId: string;
    preview: PermanentDeletePreview;
  }>): Promise<PermanentDeleteReceipt>;
}

export class ProductApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ProductApiError";
    this.status = status;
    this.code = code;
  }
}

export class HttpProductClient implements ProductClient {
  #session?: Promise<BrowserSession>;

  home(): Promise<HomeDto> {
    return this.#request<HomeDto>("/api/home");
  }

  providers(): Promise<ProviderDiscovery> {
    return this.#request<ProviderDiscovery>("/api/providers");
  }

  createModel(input: Readonly<{
    commandId: string;
    name: string;
    providerId: string;
    modelId: string;
  }>): Promise<ModelCreationDto> {
    return this.#request<ModelCreationDto>("/api/models", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  createProject(input: Readonly<{
    commandId: string;
    name: string;
    modelId: string;
  }>): Promise<ProjectCreationDto> {
    return this.#request<ProjectCreationDto>("/api/projects", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async workspace(kind: OwnerKind, id: string): Promise<WorkspaceDto> {
    const collection = kind === "model" ? "models" : "projects";
    const workspace = await this.#request<unknown>(
      `/api/${collection}/${encodeURIComponent(id)}/workspace`,
    );
    if (kind === "project") return normalizeWorkspace(kind, workspace);
    const conversationResult = await this.#request<{
      conversations: WorkspaceDto["conversations"];
    }>(`/api/objects/model/${encodeURIComponent(id)}/conversations`);
    return normalizeWorkspace(kind, workspace, conversationResult.conversations);
  }

  async conversations(
    kind: OwnerKind,
    id: string,
    lifecycle: "active" | "archived" | "trashed" = "active",
  ): Promise<readonly ConversationSummary[]> {
    const result = await this.#request<{ conversations: ConversationSummary[] }>(
      `/api/objects/${kind}/${encodeURIComponent(id)}/conversations?lifecycle=${lifecycle}`,
    );
    return Object.freeze(result.conversations);
  }

  createConversation(input: Readonly<{
    commandId: string;
    kind: OwnerKind;
    ownerId: string;
    name: string;
    providerId: string;
    modelId: string;
  }>): Promise<ConversationSummary> {
    return this.#request<ConversationSummary>(
      `/api/objects/${input.kind}/${encodeURIComponent(input.ownerId)}/conversations`,
      {
        method: "POST",
        body: JSON.stringify({
          commandId: input.commandId,
          name: input.name,
          providerId: input.providerId,
          modelId: input.modelId,
        }),
      },
    );
  }

  async conversationBundle(conversationId: string): Promise<ConversationBundle> {
    const root = `/api/conversations/${encodeURIComponent(conversationId)}`;
    const [
      conversation,
      messageResult,
      attachmentResult,
      documentResult,
      activity,
    ] = await Promise.all([
      this.#request<ConversationSummary>(root),
      this.#request<{ messages: ConversationMessage[] }>(`${root}/messages`),
      this.#request<{ attachments: ConversationAttachment[] }>(`${root}/attachments`),
      this.#request<{ documents: TemporaryDocumentCard[] }>(`${root}/documents`),
      this.#request<{ skillUses: SkillUse[]; actions: ActionRecord[] }>(`${root}/actions`),
    ]);
    return Object.freeze({
      conversation,
      messages: Object.freeze(messageResult.messages),
      attachments: Object.freeze(attachmentResult.attachments),
      documents: Object.freeze(documentResult.documents),
      skillUses: Object.freeze(activity.skillUses),
      actions: Object.freeze(activity.actions),
    });
  }

  changeConversationProvider(input: Readonly<{
    commandId: string;
    conversationId: string;
    expectedRecordDigest: string;
    providerId: string;
    modelId: string;
  }>): Promise<unknown> {
    return this.#request(
      `/api/conversations/${encodeURIComponent(input.conversationId)}/provider-binding`,
      {
        method: "PATCH",
        body: JSON.stringify({
          commandId: input.commandId,
          expectedRecordDigest: input.expectedRecordDigest,
          providerId: input.providerId,
          modelId: input.modelId,
        }),
      },
    );
  }

  uploadConversationAttachment(input: Readonly<{
    commandId: string;
    conversationId: string;
    originalName: string;
    mediaType: string;
    base64: string;
    purpose?: string;
  }>): Promise<ConversationAttachment> {
    return this.#request(
      `/api/conversations/${encodeURIComponent(input.conversationId)}/attachments`,
      {
        method: "POST",
        body: JSON.stringify({
          commandId: input.commandId,
          originalName: input.originalName,
          mediaType: input.mediaType,
          base64: input.base64,
          ...(input.purpose ? { purpose: input.purpose } : {}),
        }),
      },
    );
  }

  sendTurn(input: Readonly<{
    requestKey: string;
    conversationId: string;
    text: string;
    attachmentIds: readonly string[];
  }>): Promise<AgentTurnResult> {
    return this.#request(
      `/api/conversations/${encodeURIComponent(input.conversationId)}/turns`,
      {
        method: "POST",
        body: JSON.stringify({
          requestKey: input.requestKey,
          text: input.text,
          attachmentIds: input.attachmentIds,
        }),
      },
    );
  }

  renameConversation(input: Readonly<{
    commandId: string;
    conversationId: string;
    expectedRecordDigest: string;
    name: string;
  }>): Promise<ProductLifecycleReceipt> {
    return this.#request(
      `/api/resources/conversation/${encodeURIComponent(input.conversationId)}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          commandId: input.commandId,
          expectedRecordDigest: input.expectedRecordDigest,
          name: input.name,
        }),
      },
    );
  }

  transitionConversation(input: Readonly<{
    commandId: string;
    conversationId: string;
    expectedRecordDigest: string;
    action: "archive" | "restore" | "trash";
  }>): Promise<ProductLifecycleReceipt> {
    return this.#request(
      `/api/resources/conversation/${encodeURIComponent(input.conversationId)}/${input.action}`,
      {
        method: "POST",
        body: JSON.stringify({
          commandId: input.commandId,
          expectedRecordDigest: input.expectedRecordDigest,
        }),
      },
    );
  }

  previewConversationPermanentDelete(
    conversationId: string,
  ): Promise<PermanentDeletePreview> {
    return this.#request(
      `/api/resources/conversation/${encodeURIComponent(conversationId)}/permanent-delete-preview`,
      { method: "POST", body: "{}" },
    );
  }

  permanentlyDeleteConversation(input: Readonly<{
    commandId: string;
    preview: PermanentDeletePreview;
  }>): Promise<PermanentDeleteReceipt> {
    const { preview } = input;
    return this.#request(
      `/api/resources/conversation/${encodeURIComponent(preview.target.id)}/permanent-delete`,
      {
        method: "POST",
        body: JSON.stringify({
          commandId: input.commandId,
          previewToken: preview.previewToken,
          stateToken: preview.stateToken,
          confirmationToken: preview.confirmationToken,
          confirmation: {
            action: "permanently_delete",
            kind: "conversation",
            id: preview.target.id,
            recordCount: preview.recordCount,
            fileCount: preview.fileCount,
            totalBytes: preview.totalBytes,
          },
        }),
      },
    );
  }

  async #request<T>(
    path: string,
    init: Readonly<{
      method?: "POST" | "PATCH";
      body?: string;
    }> = {},
  ): Promise<T> {
    const session = await this.#browserSession();
    const response = await fetch(path, {
      method: init.method ?? "GET",
      credentials: "same-origin",
      headers: init.method
        ? {
          "content-type": "application/json",
          "x-riff-csrf": session.csrfToken,
        }
        : undefined,
      body: init.body,
    });
    return responseJson<T>(response);
  }

  #browserSession(): Promise<BrowserSession> {
    this.#session ??= fetch("/api/browser-session/bootstrap", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: "{}",
    }).then((response) => responseJson<BrowserSession>(response))
      .catch((error) => {
        this.#session = undefined;
        throw error;
      });
    return this.#session;
  }
}

const responseJson = async <T>(
  response: Response,
): Promise<T> => {
  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    throw new ProductApiError(response.status, "invalid_response", "The server returned an invalid response.");
  }
  if (!response.ok) {
    const publicError = body && typeof body === "object"
      ? (body as { error?: unknown }).error
      : undefined;
    const record = publicError && typeof publicError === "object"
      ? publicError as { code?: unknown; message?: unknown }
      : body as { code?: unknown; message?: unknown } | undefined;
    throw new ProductApiError(
      response.status,
      typeof record?.code === "string" ? record.code : "request_failed",
      typeof record?.message === "string" ? record.message : "The request could not be completed.",
    );
  }
  return body as T;
};

const normalizeWorkspace = (
  kind: OwnerKind,
  value: unknown,
  modelConversations?: WorkspaceDto["conversations"],
): WorkspaceDto => {
  if (!value || typeof value !== "object") {
    throw new ProductApiError(500, "invalid_response", "The workspace response is invalid.");
  }
  const record = value as Record<string, unknown>;
  const rawOwner = record[kind];
  const conversations = kind === "model" ? modelConversations : record.conversations;
  if (!rawOwner || typeof rawOwner !== "object" || !Array.isArray(conversations)) {
    throw new ProductApiError(500, "invalid_response", "The workspace response is invalid.");
  }
  const owner = rawOwner as Record<string, unknown>;
  if (typeof owner.id !== "string" || typeof owner.name !== "string"
    || kind === "project"
      && !["active", "archived", "trashed"].includes(String(owner.lifecycleState))) {
    throw new ProductApiError(500, "invalid_response", "The workspace owner is invalid.");
  }
  return Object.freeze({
    owner: Object.freeze({
      id: owner.id,
      name: owner.name,
      kind,
      lifecycleState: kind === "model"
        ? "active"
        : owner.lifecycleState as WorkspaceDto["owner"]["lifecycleState"],
      ...(kind === "model" && typeof owner.technicalStatus === "string"
        ? { technicalStatus: owner.technicalStatus as WorkspaceDto["owner"]["technicalStatus"] }
        : {}),
    }),
    conversations: Object.freeze(conversations as WorkspaceDto["conversations"]),
  });
};

export const defaultProductClient = new HttpProductClient();
