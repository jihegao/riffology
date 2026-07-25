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
  ProjectRun,
  ProviderDiscovery,
  DiagnosticEventPage,
  ExperimentConfiguration,
  TechnicalCheck,
  TemporaryDocumentCard,
  ActionRecord,
  SkillUse,
  WorkspaceDto,
} from "./types";
import type { RendererResource } from "./RendererRegistry";

type BrowserSession = Readonly<{
  schemaVersion: 1;
  generation: number;
  csrfToken: string;
  platformOrigin: string;
  brokerOrigin: string;
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
  startTechnicalCheck(modelId: string, commandId: string): Promise<TechnicalCheck>;
  modelRenderable(modelId: string, fileId: string): Promise<RendererResource>;
  downloadModelFile(modelId: string, fileId: string): Promise<void>;
  createExperiment(input: Readonly<{
    projectId: string;
    commandId: string;
    name: string;
    configuration: Record<string, unknown>;
  }>): Promise<ExperimentConfiguration>;
  updateExperiment(input: Readonly<{
    projectId: string;
    configId: string;
    commandId: string;
    expectedConfigurationDigest: string;
    expectedRecordDigest: string;
    name?: string;
    configuration?: Record<string, unknown>;
  }>): Promise<ExperimentConfiguration>;
  startRun(input: Readonly<{
    projectId: string;
    commandId: string;
    experimentConfigId: string;
    completionConversationId?: string;
  }>): Promise<Readonly<{ runId: string; status: "queued"; runKind: "batch" | "visual"; sampleCount: number }>>;
  run(projectId: string, runId: string): Promise<ProjectRun>;
  cancelRun(projectId: string, runId: string, commandId: string): Promise<unknown>;
  trashRun(input: Readonly<{
    projectId: string;
    run: ProjectRun;
    commandId: string;
  }>): Promise<unknown>;
  restoreRun(input: Readonly<{
    projectId: string;
    run: ProjectRun;
    commandId: string;
  }>): Promise<unknown>;
  diagnosticEvents(
    projectId: string,
    runId: string,
    options?: Readonly<{
      cursor?: string;
      type?: string;
      sampleIndex?: number;
    }>,
  ): Promise<DiagnosticEventPage>;
  outputRenderable(
    projectId: string,
    runId: string,
    outputId: string,
  ): Promise<RendererResource>;
  outputDownloadHref(projectId: string, runId: string, outputId: string): string;
  downloadOutput(projectId: string, runId: string, outputId: string): Promise<void>;
  issueVisualFrame(projectId: string, runId: string): Promise<Readonly<{
    schemaVersion: 1;
    frameUrl: string;
    expiresAt: string;
  }>>;
  visualHostUrl(projectId: string, runId: string): Promise<string>;
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

  startTechnicalCheck(modelId: string, commandId: string): Promise<TechnicalCheck> {
    return this.#request(`/api/models/${encodeURIComponent(modelId)}/technical-checks`, {
      method: "POST",
      body: JSON.stringify({ commandId }),
    });
  }

  modelRenderable(modelId: string, fileId: string): Promise<RendererResource> {
    return this.#request(
      `/api/models/${encodeURIComponent(modelId)}/renderables/${encodeURIComponent(fileId)}`,
    );
  }

  downloadModelFile(modelId: string, fileId: string): Promise<void> {
    return this.#download(
      `/api/models/${encodeURIComponent(modelId)}/files/${encodeURIComponent(fileId)}/download`,
      "riff-model-resource.bin",
    );
  }

  createExperiment(input: Readonly<{
    projectId: string;
    commandId: string;
    name: string;
    configuration: Record<string, unknown>;
  }>): Promise<ExperimentConfiguration> {
    return this.#request(`/api/projects/${encodeURIComponent(input.projectId)}/experiment-configs`, {
      method: "POST",
      body: JSON.stringify({
        commandId: input.commandId,
        name: input.name,
        configuration: input.configuration,
      }),
    });
  }

  updateExperiment(input: Readonly<{
    projectId: string;
    configId: string;
    commandId: string;
    expectedConfigurationDigest: string;
    expectedRecordDigest: string;
    name?: string;
    configuration?: Record<string, unknown>;
  }>): Promise<ExperimentConfiguration> {
    return this.#request(
      `/api/projects/${encodeURIComponent(input.projectId)}/experiment-configs/${encodeURIComponent(input.configId)}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          commandId: input.commandId,
          expectedConfigurationDigest: input.expectedConfigurationDigest,
          expectedRecordDigest: input.expectedRecordDigest,
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.configuration === undefined ? {} : { configuration: input.configuration }),
        }),
      },
    );
  }

  startRun(input: Readonly<{
    projectId: string;
    commandId: string;
    experimentConfigId: string;
    completionConversationId?: string;
  }>): Promise<Readonly<{ runId: string; status: "queued"; runKind: "batch" | "visual"; sampleCount: number }>> {
    return this.#request(`/api/projects/${encodeURIComponent(input.projectId)}/runs`, {
      method: "POST",
      body: JSON.stringify({
        commandId: input.commandId,
        experimentConfigId: input.experimentConfigId,
        ...(input.completionConversationId
          ? { completionConversationId: input.completionConversationId }
          : {}),
      }),
    });
  }

  run(projectId: string, runId: string): Promise<ProjectRun> {
    return this.#request(
      `/api/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}`,
    );
  }

  cancelRun(projectId: string, runId: string, commandId: string): Promise<unknown> {
    return this.#request(
      `/api/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/cancel`,
      { method: "POST", body: JSON.stringify({ commandId }) },
    );
  }

  trashRun(input: Readonly<{
    projectId: string;
    run: ProjectRun;
    commandId: string;
  }>): Promise<unknown> {
    if (!input.run.lifecycleDigest || !input.run.terminalStatus || !input.run.terminalClosureDigest) {
      return Promise.reject(new ProductApiError(409, "run_not_terminal", "Only a terminal Run can be trashed."));
    }
    return this.#request(
      `/api/projects/${encodeURIComponent(input.projectId)}/runs/${encodeURIComponent(input.run.id)}/trash`,
      {
        method: "POST",
        body: JSON.stringify({
          commandId: input.commandId,
          expectedLifecycleDigest: input.run.lifecycleDigest,
          confirmation: {
            action: "trash_run",
            projectId: input.projectId,
            runId: input.run.id,
            terminalStatus: input.run.terminalStatus,
            terminalClosureDigest: input.run.terminalClosureDigest,
          },
        }),
      },
    );
  }

  restoreRun(input: Readonly<{
    projectId: string;
    run: ProjectRun;
    commandId: string;
  }>): Promise<unknown> {
    if (!input.run.lifecycleDigest) {
      return Promise.reject(new ProductApiError(409, "run_not_trashed", "The Run has no restorable lifecycle identity."));
    }
    return this.#request(
      `/api/projects/${encodeURIComponent(input.projectId)}/runs/${encodeURIComponent(input.run.id)}/restore`,
      {
        method: "POST",
        body: JSON.stringify({
          commandId: input.commandId,
          expectedLifecycleDigest: input.run.lifecycleDigest,
        }),
      },
    );
  }

  diagnosticEvents(
    projectId: string,
    runId: string,
    options: Readonly<{
      cursor?: string;
      type?: string;
      sampleIndex?: number;
    }> = {},
  ): Promise<DiagnosticEventPage> {
    const query = new URLSearchParams({ limit: "100" });
    if (options.cursor) query.set("cursor", options.cursor);
    if (options.type) query.set("type", options.type);
    if (options.sampleIndex !== undefined) query.set("sampleIndex", String(options.sampleIndex));
    return this.#request(
      `/api/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/diagnostic-events?${query}`,
    );
  }

  outputRenderable(
    projectId: string,
    runId: string,
    outputId: string,
  ): Promise<RendererResource> {
    return this.#request(
      `/api/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/outputs/${encodeURIComponent(outputId)}/renderable`,
    );
  }

  outputDownloadHref(projectId: string, runId: string, outputId: string): string {
    return `/api/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/outputs/${encodeURIComponent(outputId)}/download`;
  }

  async downloadOutput(projectId: string, runId: string, outputId: string): Promise<void> {
    return this.#download(
      this.outputDownloadHref(projectId, runId, outputId),
      "riff-output.bin",
    );
  }

  async #download(path: string, fallbackFilename: string): Promise<void> {
    await this.#browserSession();
    const response = await fetch(path, {
      credentials: "same-origin",
    });
    if (!response.ok) {
      await responseJson(response);
      return;
    }
    const disposition = response.headers.get("content-disposition") ?? "";
    const filename = /^attachment; filename="([A-Za-z0-9_.-]{1,200})"$/u.exec(disposition)?.[1]
      ?? fallbackFilename;
    const blobUrl = URL.createObjectURL(await response.blob());
    try {
      const anchor = document.createElement("a");
      anchor.href = blobUrl;
      anchor.download = filename;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
    } finally {
      window.setTimeout(() => URL.revokeObjectURL(blobUrl), 0);
    }
  }

  async issueVisualFrame(projectId: string, runId: string): Promise<Readonly<{
    schemaVersion: 1;
    frameUrl: string;
    expiresAt: string;
  }>> {
    const session = await this.#browserSession();
    const result = await this.#request<Readonly<{
      schemaVersion: 1;
      frameUrl: string;
      expiresAt: string;
    }>>(
      `/api/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/visual-frame-session`,
      { method: "POST", empty: true },
    );
    let frame: URL;
    let broker: URL;
    try {
      frame = new URL(result.frameUrl);
      broker = new URL(session.brokerOrigin);
    } catch {
      throw new ProductApiError(502, "visual_frame_unavailable", "The visual frame authority is invalid.");
    }
    if (frame.origin !== broker.origin
      || !/^\/frame\/redeem\/[A-Za-z0-9_-]{43}$/u.test(frame.pathname)
      || frame.search !== "" || frame.hash !== "") {
      throw new ProductApiError(502, "visual_frame_unavailable", "The visual frame authority is invalid.");
    }
    return result;
  }

  async visualHostUrl(projectId: string, runId: string): Promise<string> {
    const session = await this.#browserSession();
    let platform: URL;
    try {
      platform = new URL(session.platformOrigin);
    } catch {
      throw new ProductApiError(502, "browser_session_denied", "The platform browser authority is invalid.");
    }
    if (platform.protocol !== "http:" || platform.hostname !== "localhost"
      || platform.username !== "" || platform.password !== ""
      || platform.pathname !== "/" || platform.search !== "" || platform.hash !== "") {
      throw new ProductApiError(502, "browser_session_denied", "The platform browser authority is invalid.");
    }
    return new URL(
      `/browser/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/visual`,
      platform,
    ).href;
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
      empty?: boolean;
    }> = {},
  ): Promise<T> {
    const session = await this.#browserSession();
    const response = await fetch(path, {
      method: init.method ?? "GET",
      credentials: "same-origin",
      headers: init.method
        ? {
          ...(init.empty ? {} : { "content-type": "application/json" }),
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
  const base = {
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
  };
  if (kind === "model") {
    if (typeof record.digest !== "string" || !Array.isArray(record.files)
      || !record.execution || typeof record.execution !== "object") {
      throw new ProductApiError(500, "invalid_response", "The Model workspace projection is invalid.");
    }
    return Object.freeze({
      ...base,
      owner: Object.freeze({ ...base.owner, kind: "model" as const }),
      digest: record.digest,
      execution: record.execution,
      files: Object.freeze(record.files),
    }) as WorkspaceDto;
  }
  if (!Array.isArray(record.files) || !Array.isArray(record.experimentConfigurations)
    || !Array.isArray(record.runs) || !record.execution
    || typeof record.execution !== "object"
    || typeof record.executionDescriptionDigest !== "string"
    || typeof owner.sourceModelId !== "string"
    || typeof owner.modelSnapshotDigest !== "string") {
    throw new ProductApiError(500, "invalid_response", "The Project workspace projection is invalid.");
  }
  return Object.freeze({
    ...base,
    owner: Object.freeze({ ...base.owner, kind: "project" as const }),
    sourceModelId: owner.sourceModelId,
    modelSnapshotDigest: owner.modelSnapshotDigest,
    execution: record.execution,
    executionDescriptionDigest: record.executionDescriptionDigest,
    files: Object.freeze(record.files),
    experimentConfigurations: Object.freeze(record.experimentConfigurations),
    runs: Object.freeze(record.runs),
  }) as WorkspaceDto;
};

export const defaultProductClient = new HttpProductClient();
