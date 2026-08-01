import type {
  AgentTurnResult,
  AgentDiscovery,
  ConversationAttachment,
  ConversationBundle,
  ConversationRuntimeProjection,
  ConversationMessage,
  ConversationSummary,
  HomeDto,
  GeneratedViewSet,
  ModelChangeSet,
  ModelMutationReceipt,
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
  BrowserSessionDto,
  BrowserScreenshotDto,
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

export type ProductRecoveryStatus = Readonly<
  | {
    state: "ready";
    observedAt: string;
  }
  | {
    state: "recovery_required";
    code: string;
    observedAt: string;
    retryable: boolean;
  }
>;

export interface ProductClient {
  recoveryStatus(): Promise<ProductRecoveryStatus>;
  home(): Promise<HomeDto>;
  providers(): Promise<ProviderDiscovery>;
  agents?(ownerKind: OwnerKind, ownerId: string): Promise<AgentDiscovery>;
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
  generatedViews?(modelId: string): Promise<GeneratedViewSet | null>;
  generatedViewRenderable?(modelId: string, viewId: string): Promise<RendererResource>;
  modelChangeSets?(
    modelId: string,
    state?: ModelChangeSet["state"],
  ): Promise<readonly ModelChangeSet[]>;
  applyModelChangeSet?(input: Readonly<{
    modelId: string;
    changeSetId: string;
    commandId: string;
    expectedChangeSetDigest: string;
    expectedWorkspaceDigest: string;
  }>): Promise<ModelMutationReceipt>;
  rejectModelChangeSet?(input: Readonly<{
    modelId: string;
    changeSetId: string;
    commandId: string;
    expectedChangeSetDigest: string;
  }>): Promise<ModelMutationReceipt>;
  projectFileRenderable?(projectId: string, fileRef: string): Promise<RendererResource>;
  projectFileWorkbenchRenderable?(projectId: string, fileRef: string): Promise<RendererResource>;
  browserState?(conversationId: string): Promise<BrowserSessionDto>;
  browserOpen?(conversationId: string, alias: "riff-app" | "riff-visual" | "riff-artifact"): Promise<BrowserSessionDto>;
  browserReload?(conversationId: string, state: BrowserSessionDto): Promise<BrowserSessionDto>;
  browserBack?(conversationId: string, state: BrowserSessionDto): Promise<BrowserSessionDto>;
  browserScreenshot?(conversationId: string, state: BrowserSessionDto): Promise<BrowserScreenshotDto>;
  browserClose?(conversationId: string, state: BrowserSessionDto): Promise<BrowserSessionDto>;
  browserRestart?(conversationId: string, state: BrowserSessionDto): Promise<BrowserSessionDto>;
  browserReconnect?(conversationId: string, state: BrowserSessionDto): Promise<BrowserSessionDto>;
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
  conversationRuntime?(conversationId: string): Promise<ConversationRuntimeProjection>;
  subscribeConversationRuntime?(
    conversationId: string,
    onProjection: (projection: ConversationRuntimeProjection) => void,
    onError: () => void,
  ): Promise<() => void>;
  stopConversation?(input: Readonly<{
    conversationId: string;
    requestKey: string;
  }>): Promise<unknown>;
  retryConversation?(input: Readonly<{
    conversationId: string;
    oldRequestKey: string;
    newRequestKey: string;
  }>): Promise<unknown>;
  respondConversationInteraction?(input:
    | Readonly<{
      conversationId: string;
      requestKey: string;
      interactionId: string;
      kind: "permission";
      decision: "allow_once" | "reject";
    }>
    | Readonly<{
      conversationId: string;
      requestKey: string;
      interactionId: string;
      kind: "question";
      response: Readonly<{ answers: readonly (readonly string[])[] } | { reject: true }>;
    }>
  ): Promise<unknown>;
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
    agentName?: string;
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

  recoveryStatus(): Promise<ProductRecoveryStatus> {
    return this.#request<ProductRecoveryStatus>("/api/recovery-status");
  }

  home(): Promise<HomeDto> {
    return this.#request<HomeDto>("/api/home");
  }

  providers(): Promise<ProviderDiscovery> {
    return this.#request<ProviderDiscovery>("/api/providers");
  }

  async agents(ownerKind: OwnerKind, ownerId: string): Promise<AgentDiscovery> {
    const query = new URLSearchParams({ ownerKind, ownerId });
    const value = await this.#request<any>(`/api/agents?${query.toString()}`);
    if (value?.mode === "read_only") {
      return { mode: "read_only", reason: String(value.reason ?? "opencode_unavailable"), agents: [] };
    }
    const agents = Array.isArray(value?.agents) ? value.agents : [];
    return {
      mode: "live",
      agents: agents
        .filter((agent: any) => typeof agent?.name === "string")
        .map((agent: any) => ({
          name: agent.name,
          label: agent.name,
          description: typeof agent.description === "string" ? agent.description : null,
        })),
    };
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

  generatedViews(modelId: string): Promise<GeneratedViewSet | null> {
    return this.#request(
      `/api/models/${encodeURIComponent(modelId)}/generated-views`,
    );
  }

  generatedViewRenderable(modelId: string, viewId: string): Promise<RendererResource> {
    return this.#request(
      `/api/models/${encodeURIComponent(modelId)}/generated-views/${encodeURIComponent(viewId)}/renderable`,
    );
  }

  async modelChangeSets(
    modelId: string,
    state?: ModelChangeSet["state"],
  ): Promise<readonly ModelChangeSet[]> {
    const query = state ? `?state=${encodeURIComponent(state)}` : "";
    const result = await this.#request<{ changeSets: ModelChangeSet[] }>(
      `/api/models/${encodeURIComponent(modelId)}/change-sets${query}`,
    );
    return result.changeSets;
  }

  applyModelChangeSet(input: Readonly<{
    modelId: string;
    changeSetId: string;
    commandId: string;
    expectedChangeSetDigest: string;
    expectedWorkspaceDigest: string;
  }>): Promise<ModelMutationReceipt> {
    return this.#request(
      `/api/models/${encodeURIComponent(input.modelId)}/change-sets/${encodeURIComponent(input.changeSetId)}/apply`,
      {
        method: "POST",
        body: JSON.stringify({
          commandId: input.commandId,
          expectedChangeSetDigest: input.expectedChangeSetDigest,
          expectedWorkspaceDigest: input.expectedWorkspaceDigest,
        }),
      },
    );
  }

  rejectModelChangeSet(input: Readonly<{
    modelId: string;
    changeSetId: string;
    commandId: string;
    expectedChangeSetDigest: string;
  }>): Promise<ModelMutationReceipt> {
    return this.#request(
      `/api/models/${encodeURIComponent(input.modelId)}/change-sets/${encodeURIComponent(input.changeSetId)}/reject`,
      {
        method: "POST",
        body: JSON.stringify({
          commandId: input.commandId,
          expectedChangeSetDigest: input.expectedChangeSetDigest,
        }),
      },
    );
  }

  projectFileRenderable(projectId: string, fileRef: string): Promise<RendererResource> {
    return this.#request(
      `/api/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileRef)}/renderable`,
    );
  }

  projectFileWorkbenchRenderable(projectId: string, fileRef: string): Promise<RendererResource> {
    return this.#request(
      `/api/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileRef)}/workbench-renderable`,
    );
  }

  browserState(conversationId: string): Promise<BrowserSessionDto> {
    return this.#request(`/api/conversations/${encodeURIComponent(conversationId)}/browser`);
  }

  browserOpen(
    conversationId: string,
    alias: "riff-app" | "riff-visual" | "riff-artifact",
  ): Promise<BrowserSessionDto> {
    return this.#request(`/api/conversations/${encodeURIComponent(conversationId)}/browser/open`, {
      method: "POST",
      body: JSON.stringify({ alias }),
    });
  }

  browserReload(conversationId: string, state: BrowserSessionDto): Promise<BrowserSessionDto> {
    return this.#browserOperation(conversationId, "reload", state);
  }

  browserBack(conversationId: string, state: BrowserSessionDto): Promise<BrowserSessionDto> {
    return this.#browserOperation(conversationId, "back", state);
  }

  browserClose(conversationId: string, state: BrowserSessionDto): Promise<BrowserSessionDto> {
    return this.#browserOperation(conversationId, "close", state);
  }

  browserRestart(conversationId: string, state: BrowserSessionDto): Promise<BrowserSessionDto> {
    return this.#browserOperation(conversationId, "restart", state);
  }

  browserReconnect(conversationId: string, state: BrowserSessionDto): Promise<BrowserSessionDto> {
    return this.#browserOperation(conversationId, "reconnect", state);
  }

  browserScreenshot(
    conversationId: string,
    state: BrowserSessionDto,
  ): Promise<BrowserScreenshotDto> {
    const query = new URLSearchParams({
      conversationGeneration: String(state.conversationGeneration),
      pageGeneration: String(state.pageGeneration),
    });
    return this.#request(
      `/api/conversations/${encodeURIComponent(conversationId)}/browser/screenshot?${query}`,
    );
  }

  #browserOperation(
    conversationId: string,
    action: "reload" | "back" | "close" | "restart" | "reconnect",
    state: BrowserSessionDto,
  ): Promise<BrowserSessionDto> {
    return this.#request(
      `/api/conversations/${encodeURIComponent(conversationId)}/browser/${action}`,
      {
        method: "POST",
        body: JSON.stringify({
          conversationGeneration: state.conversationGeneration,
          pageGeneration: state.pageGeneration,
        }),
      },
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

  async conversationRuntime(conversationId: string): Promise<ConversationRuntimeProjection> {
    return normalizeConversationRuntimeProjection(await this.#request(
      `/api/conversations/${encodeURIComponent(conversationId)}/runtime`,
    ));
  }

  async subscribeConversationRuntime(
    conversationId: string,
    onProjection: (projection: ConversationRuntimeProjection) => void,
    onError: () => void,
  ): Promise<() => void> {
    await this.#browserSession();
    const source = new EventSource(
      `/api/conversations/${encodeURIComponent(conversationId)}/runtime/events`,
      { withCredentials: true },
    );
    const receive = (event: MessageEvent<string>) => {
      try {
        onProjection(normalizeConversationRuntimeProjection(JSON.parse(event.data)));
      } catch {
        onError();
      }
    };
    source.addEventListener("snapshot", receive as EventListener);
    source.onmessage = receive;
    source.onerror = onError;
    return () => source.close();
  }

  stopConversation(input: Readonly<{
    conversationId: string;
    requestKey: string;
  }>): Promise<unknown> {
    return this.#request(
      `/api/conversations/${encodeURIComponent(input.conversationId)}/turns/${encodeURIComponent(input.requestKey)}/stop`,
      { method: "POST", body: "{}" },
    );
  }

  retryConversation(input: Readonly<{
    conversationId: string;
    oldRequestKey: string;
    newRequestKey: string;
  }>): Promise<unknown> {
    return this.#request(
      `/api/conversations/${encodeURIComponent(input.conversationId)}/turns/${encodeURIComponent(input.oldRequestKey)}/retry`,
      {
        method: "POST",
        body: JSON.stringify({
          requestKey: input.newRequestKey,
        }),
      },
    );
  }

  respondConversationInteraction(input:
    | Readonly<{
      conversationId: string;
      requestKey: string;
      interactionId: string;
      kind: "permission";
      decision: "allow_once" | "reject";
    }>
    | Readonly<{
      conversationId: string;
      requestKey: string;
      interactionId: string;
      kind: "question";
      response: Readonly<{ answers: readonly (readonly string[])[] } | { reject: true }>;
    }>
  ): Promise<unknown> {
    return this.#request(
      `/api/conversations/${encodeURIComponent(input.conversationId)}/turns/${encodeURIComponent(input.requestKey)}/resume`,
      {
        method: "POST",
        body: JSON.stringify({
          interactionId: input.interactionId,
          kind: input.kind,
          ...(input.kind === "permission"
            ? { decision: input.decision === "allow_once" ? "once" : "reject" }
            : "reject" in input.response
              ? { reject: true }
              : { answers: input.response.answers }),
        }),
      },
    );
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
    agentName?: string;
  }>): Promise<AgentTurnResult> {
    return this.#request(
      `/api/conversations/${encodeURIComponent(input.conversationId)}/turns`,
      {
        method: "POST",
        body: JSON.stringify({
          requestKey: input.requestKey,
          text: input.text,
          attachmentIds: input.attachmentIds,
          ...(input.agentName ? { agentName: input.agentName } : {}),
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

const normalizeConversationRuntimeProjection = (
  value: unknown,
): ConversationRuntimeProjection => {
  const record = strictRuntimeRecord(value, [
    "schemaVersion",
    "revision",
    "status",
    "activeTurn",
    "parts",
    "pendingInteractions",
    "goalVerification",
    "agent",
    "mcp",
  ]);
  const status = normalizeRuntimeStatus(record.status);
  if (record.schemaVersion !== 1 || !boundedRuntimeString(record.revision, 256) || !status
    || !Array.isArray(record.parts) || !Array.isArray(record.pendingInteractions)) {
    throw invalidRuntimeProjection();
  }
  const activeTurn = record.activeTurn === null
    ? null
    : normalizeActiveTurn(record.activeTurn);
  const parts = record.parts.map(normalizeRuntimePart);
  const pendingInteractions = record.pendingInteractions.map(normalizeRuntimeInteraction);
  const goalVerification = normalizeGoalVerification(record.goalVerification);
  const agent = strictRuntimeRecord(record.agent, ["selectedName", "locked"]);
  const mcp = strictRuntimeRecord(record.mcp, ["state", "label"]);
  if (!(agent.selectedName === null || boundedRuntimeString(agent.selectedName, 500))
    || typeof agent.locked !== "boolean"
    || !["connected", "disconnected", "unavailable"].includes(String(mcp.state))
    || !boundedRuntimeString(mcp.label, 500)) {
    throw invalidRuntimeProjection();
  }
  return Object.freeze({
    schemaVersion: 1,
    revision: record.revision,
    status,
    activeTurn,
    parts: Object.freeze(parts),
    pendingInteractions: Object.freeze(pendingInteractions),
    goalVerification,
    agent: Object.freeze({
      selectedName: agent.selectedName as string | null,
      locked: agent.locked,
    }),
    mcp: Object.freeze({
      state: mcp.state as ConversationRuntimeProjection["mcp"]["state"],
      label: mcp.label,
    }),
  });
};

const normalizeActiveTurn = (
  value: unknown,
): NonNullable<ConversationRuntimeProjection["activeTurn"]> => {
  const record = strictRuntimeRecord(value, ["requestKey", "canStop", "canRetry"]);
  if (!boundedRuntimeString(record.requestKey, 500)
    || typeof record.canStop !== "boolean"
    || typeof record.canRetry !== "boolean") {
    throw invalidRuntimeProjection();
  }
  return Object.freeze({
    requestKey: record.requestKey,
    canStop: record.canStop,
    canRetry: record.canRetry,
  });
};

const normalizeRuntimePart = (
  value: unknown,
): ConversationRuntimeProjection["parts"][number] => {
  const record = strictRuntimeRecord(value, ["id", "kind", "state", "title", "summary"]);
  if (!boundedRuntimeString(record.id, 500)
    || !["text", "tool_call", "tool_result", "error", "command", "skill", "mcp"].includes(String(record.kind))
    || !["streaming", "pending", "complete", "failed"].includes(String(record.state))
    || !boundedRuntimeString(record.title, 1_000)
    || !(record.summary === null || boundedRuntimeText(record.summary, 64_000))) {
    throw invalidRuntimeProjection();
  }
  return Object.freeze({
    id: record.id,
    kind: record.kind as ConversationRuntimeProjection["parts"][number]["kind"],
    state: record.state as ConversationRuntimeProjection["parts"][number]["state"],
    title: record.title,
    summary: record.summary as string | null,
  });
};

const normalizeRuntimeInteraction = (
  value: unknown,
): ConversationRuntimeProjection["pendingInteractions"][number] => {
  const base = objectRecord(value);
  if (!base || !boundedRuntimeString(base.id, 500) || !boundedRuntimeString(base.title, 1_000)) {
    throw invalidRuntimeProjection();
  }
  if (base.kind === "permission") {
    const record = strictRuntimeRecord(value, ["id", "kind", "title", "prompt", "decisions"]);
    if (!boundedRuntimeString(record.prompt, 4_000)
      || !Array.isArray(record.decisions)
      || record.decisions.length !== 2
      || record.decisions[0] !== "allow_once"
      || record.decisions[1] !== "reject") {
      throw invalidRuntimeProjection();
    }
    return Object.freeze({
      id: record.id as string,
      kind: "permission",
      title: record.title as string,
      prompt: record.prompt,
      decisions: Object.freeze(["allow_once", "reject"] as const),
    });
  }
  if (base.kind !== "question") throw invalidRuntimeProjection();
  const record = strictRuntimeRecord(value, ["id", "kind", "title", "questions"]);
  if (!Array.isArray(record.questions) || record.questions.length < 1 || record.questions.length > 16) {
    throw invalidRuntimeProjection();
  }
  const questions = record.questions.map((rawQuestion) => {
    const question = strictRuntimeRecord(rawQuestion, [
      "prompt",
      "multiple",
      "custom",
      "choices",
    ]);
    if (!boundedRuntimeString(question.prompt, 4_000)
      || typeof question.multiple !== "boolean"
      || typeof question.custom !== "boolean"
      || !Array.isArray(question.choices)
      || question.choices.length > 32) {
      throw invalidRuntimeProjection();
    }
    const choices = question.choices.map((rawChoice) => {
      const choice = strictRuntimeRecord(rawChoice, ["value", "label"]);
      if (!boundedRuntimeString(choice.value, 500)
        || !/^choice_[0-9a-f]{32}$/u.test(choice.value)
        || !boundedRuntimeString(choice.label, 500)) {
        throw invalidRuntimeProjection();
      }
      return Object.freeze({ value: choice.value, label: choice.label });
    });
    if (new Set(choices.map((choice) => choice.value)).size !== choices.length) {
      throw invalidRuntimeProjection();
    }
    return Object.freeze({
      prompt: question.prompt,
      multiple: question.multiple,
      custom: question.custom,
      choices: Object.freeze(choices),
    });
  });
  return Object.freeze({
    id: record.id as string,
    kind: "question",
    title: record.title as string,
    questions: Object.freeze(questions),
  });
};

const strictRuntimeRecord = (
  value: unknown,
  keys: readonly string[],
): Record<string, any> => {
  const record = objectRecord(value);
  if (!record || Object.keys(record).length !== keys.length
    || Object.keys(record).some((key) => !keys.includes(key))) {
    throw invalidRuntimeProjection();
  }
  return record;
};

const boundedRuntimeString = (value: unknown, maximum: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= maximum
  && !/[\u0000-\u001f\u007f]/u.test(value);

const boundedRuntimeText = (value: unknown, maximum: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= maximum
  && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);

const invalidRuntimeProjection = (): ProductApiError =>
  new ProductApiError(502, "invalid_response", "The Agent runtime response is invalid.");

const normalizeGoalVerification = (
  value: unknown,
): ConversationRuntimeProjection["goalVerification"] => {
  if (value === null || value === undefined) return null;
  const receipt = objectRecord(value);
  const evidence = objectRecord(receipt?.evidence);
  const dispositions = new Set([
    "completed",
    "needs_user_input",
    "failed",
    "read_only",
    "outcome_unknown",
    "budget_exhausted",
  ]);
  const terminals = new Set(["idle", "not_reached", "unknown"]);
  const intentKinds = new Set([
    "response_delivery",
    "explicit_mutation",
    "model_visual",
  ]);
  const count = (item: unknown): item is number =>
    Number.isSafeInteger(item) && Number(item) >= 0 && Number(item) <= 1_000_000;
  if (!receipt
    || !evidence
    || typeof receipt.disposition !== "string"
    || !dispositions.has(receipt.disposition)
    || typeof receipt.reasonCode !== "string"
    || !/^[a-z0-9_]{1,200}$/u.test(receipt.reasonCode)
    || typeof receipt.receiptDigest !== "string"
    || !/^[0-9a-f]{64}$/u.test(receipt.receiptDigest)
    || typeof evidence.openCodeTerminal !== "string"
    || !terminals.has(evidence.openCodeTerminal)
    || typeof evidence.intentKind !== "string"
    || !intentKinds.has(evidence.intentKind)
    || !count(evidence.actionCount)
    || !count(evidence.terminalActionCount)
    || !count(evidence.committedActionCount)
    || !count(evidence.affectedResourceCount)
    || Number(evidence.terminalActionCount) > Number(evidence.actionCount)
    || Number(evidence.committedActionCount) > Number(evidence.terminalActionCount)
    || typeof evidence.ownerStateVerified !== "boolean"
    || typeof evidence.partialEffect !== "boolean") {
    throw new ProductApiError(
      502,
      "invalid_response",
      "The Agent goal verification response is invalid.",
    );
  }
  return Object.freeze({
    disposition: receipt.disposition as NonNullable<
      ConversationRuntimeProjection["goalVerification"]
    >["disposition"],
    reasonCode: receipt.reasonCode,
    receiptDigest: receipt.receiptDigest,
    evidence: Object.freeze({
      openCodeTerminal: evidence.openCodeTerminal as NonNullable<
        ConversationRuntimeProjection["goalVerification"]
      >["evidence"]["openCodeTerminal"],
      intentKind: evidence.intentKind as NonNullable<
        ConversationRuntimeProjection["goalVerification"]
      >["evidence"]["intentKind"],
      actionCount: evidence.actionCount,
      terminalActionCount: evidence.terminalActionCount,
      committedActionCount: evidence.committedActionCount,
      affectedResourceCount: evidence.affectedResourceCount,
      ownerStateVerified: evidence.ownerStateVerified,
      partialEffect: evidence.partialEffect,
    }),
  });
};

const objectRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" ? value as Record<string, unknown> : null;

const publicRuntimeText = (value: unknown): string | null =>
  typeof value === "string" ? value.slice(0, 4_000) : null;

const normalizeRuntimeStatus = (
  value: unknown,
): ConversationRuntimeProjection["status"] | null => {
  return value === "busy"
    || value === "waiting_for_tool"
    || value === "waiting_for_user"
    || value === "idle"
    || value === "failed"
    ? value
    : null;
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
