import { createHash } from "node:crypto";
import { ApiError } from "./errors.ts";
import type { AgentContextInput } from "./agent-context.ts";
import { AgentConversationSessionManager, type AgentReadOnlyReason } from "./agent-session-manager.ts";
import type { AgentTurnDto, ConversationDto, ConversationMessageDto, ConversationOwner } from "./agent-domain.ts";
import { createGenericModelScaffold } from "./model-workspace.ts";
import type { OpenCodeConversationPort, OpenCodeProviderModel } from "./opencode-adapter.ts";
import {
  experimentConfigurationRecordDigest,
  ProductStoreV2,
  ProductStoreV2Error,
} from "./product-store-v2.ts";
import { planExperiment } from "./experiment-planner.ts";
import type {
  ExperimentConfigurationRecord,
  ModelRecord,
  OutputIndexRecord,
  ProjectRecord,
  RunRecord,
  StoredObjectMetadata,
} from "./product-domain.ts";
import { ModelTechnicalCheckService, type ModelTechnicalCheckerPort, type ModelWorkspaceProjectionDto, type TechnicalCheckDto } from "./model-technical-check-service.ts";
import { AgentTurnRuntime, type PreparedAgentTurnRuntime } from "./agent-turn-runtime.ts";

export type ProviderDiscoveryDto =
  | { mode: "live"; providerModels: OpenCodeProviderModel[] }
  | { mode: "read_only"; reason: "opencode_unavailable" | "opencode_auth_failed"; providerModels: [] };

export type ModelCreationDto = {
  model: Pick<ModelRecord, "id" | "name" | "lifecycleState" | "technicalStatus" | "runMode" | "createdAt" | "updatedAt">;
  conversation: ConversationDto;
};

export type ProjectCreationDto = {
  project: Pick<ProjectRecord, "id" | "name" | "lifecycleState" | "sourceModelId" | "modelSnapshotDigest" | "createdAt" | "updatedAt">;
};

export type ProjectWorkspaceProjectionDto = {
  project: ProjectCreationDto["project"];
  files: Array<Pick<StoredObjectMetadata, "id" | "mediaType" | "sizeBytes" | "sha256" | "createdAt">>;
  conversations: ConversationDto[];
  experimentConfigurations: ExperimentConfigurationDto[];
  runs: ProjectRunDto[];
};

export type ExperimentConfigurationDto =
  | (Extract<ExperimentConfigurationRecord, { contractVersion: 3 }> & { recordDigest: null })
  | (Extract<ExperimentConfigurationRecord, { contractVersion: 4 }> & { recordDigest: string });

export type ProjectOutputDto = {
  id: string;
  runId: string;
  logicalName: string;
  outputType: string;
  contractVersion: 3 | 4;
  readOnly: boolean;
  legacyDigest: string | null;
  sampleIndex: number | null;
  sampleId: string | null;
  declaredRole: string | null;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
};

export type ProjectRunDto = {
  id: string;
  projectId: string;
  experimentConfigurationId: string;
  status: string;
  requestedSampleCount: number;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  contractVersion: 3 | 4;
  readOnly: boolean;
  legacyDigest: string | null;
  runKind: "batch" | "visual" | null;
  cancelRequestedAt: string | null;
  terminalCode: string | null;
  completionCardDisposition: string | null;
  outputs: ProjectOutputDto[];
};

export type AgentTurnResult =
  | { mode: "live"; turn: AgentTurnDto; messages: ConversationMessageDto[] }
  | { mode: "read_only"; reason: AgentReadOnlyReason | "agent_failed"; turn: AgentTurnDto; messages: ConversationMessageDto[] };

export class AgentWorkspaceService {
  readonly #sessions: AgentConversationSessionManager;
  readonly #now: () => string;
  readonly #pendingTurns = new Map<string, Promise<AgentTurnResult>>();
  readonly #conversationTurnTails = new Map<string, Promise<void>>();
  #scopedMcpTail: Promise<void> = Promise.resolve();
  readonly #scopedMcpUrl?: (capability: string) => string;
  readonly store: ProductStoreV2;
  readonly openCode: OpenCodeConversationPort;
  readonly technicalChecks: ModelTechnicalCheckService;
  readonly turnRuntime?: AgentTurnRuntime;

  constructor(
    store: ProductStoreV2,
    openCode: OpenCodeConversationPort,
    now: () => string = () => new Date().toISOString(),
    technicalChecker?: ModelTechnicalCheckerPort,
    turnRuntime?: AgentTurnRuntime,
    scopedMcpUrl?: (capability: string) => string,
  ) {
    this.store = store;
    this.openCode = openCode;
    this.#sessions = new AgentConversationSessionManager(store, openCode);
    this.#now = now;
    this.technicalChecks = new ModelTechnicalCheckService(store, technicalChecker, now);
    this.turnRuntime = turnRuntime;
    this.#scopedMcpUrl = scopedMcpUrl;
  }

  handleAgentMcp(capability: string | undefined, request: unknown) {
    if (!this.turnRuntime) throw new ApiError(503, "agent_tools_unavailable", "Scoped Agent tools are not configured.");
    return this.turnRuntime.handle(capability, request);
  }

  modelWorkspace(modelId: string): ModelWorkspaceProjectionDto { return this.technicalChecks.workspace(modelId); }
  startTechnicalCheck(modelId: string, commandId: string): Promise<TechnicalCheckDto> { return this.technicalChecks.start(modelId, commandId); }
  getTechnicalCheck(modelId: string, checkId: string): TechnicalCheckDto { return this.technicalChecks.read(modelId, checkId); }

  async discoverProviders(): Promise<ProviderDiscoveryDto> {
    try { return { mode: "live", providerModels: await this.openCode.discoverProviderModels() }; }
    catch (error) {
      const auth = error instanceof ApiError && (error.status === 401 || error.code === "opencode_auth_failed");
      return { mode: "read_only", reason: auth ? "opencode_auth_failed" : "opencode_unavailable", providerModels: [] };
    }
  }

  async createModel(input: { commandId: string; name: string; providerId: string; modelId: string }): Promise<ModelCreationDto> {
    const commandId = boundedKey(input.commandId, "commandId");
    const name = boundedName(input.name, "Model name");
    const providerId = boundedProviderPart(input.providerId, "providerId");
    const providerModelId = boundedProviderPart(input.modelId, "modelId");
    const modelId = stableId("model", commandId);
    const conversationId = stableId("conversation", `model:${commandId}`);
    const existingModel = this.store.listModels({ includeArchived: true, includeTrashed: true }).find((model) => model.id === modelId);
    if (existingModel) {
      const existingConversation = this.store.listConversations({ kind: "model", id: modelId }, { includeArchived: true, includeTrashed: true })
        .find((conversation) => conversation.id === conversationId);
      if (!existingConversation || existingModel.name !== name || existingConversation.provider.providerId !== providerId
        || existingConversation.provider.modelId !== providerModelId) throw new ApiError(409, "idempotency_conflict", "That commandId was already used with different Model intent.");
      return { model: publicModel(existingModel), conversation: existingConversation };
    }
    await this.#requireProviderModel(providerId, providerModelId);
    const scaffold = createGenericModelScaffold(modelId);
    const at = this.#now();
    try {
      const created = this.store.createModelWithFirstConversation({
        model: {
          id: modelId,
          name,
          technicalStatus: "draft",
          runMode: scaffold.runMode,
          executionDescription: scaffold.executionDescription,
          createdAt: at,
          files: [...scaffold.files],
        },
        conversation: {
          id: conversationId,
          name: "Main",
          providerId,
          providerModelId,
          createdAt: at,
        },
      });
      return { model: publicModel(created.model), conversation: created.conversation };
    } catch (error) { throw storeApiError(error); }
  }

  createProject(input: { commandId: string; name: string; modelId: string }): ProjectCreationDto {
    const commandId = boundedKey(input.commandId, "commandId");
    const name = boundedName(input.name, "Project name");
    const sourceModelId = boundedId(input.modelId);
    const projectId = stableId("project", commandId);
    const existing = this.store.listProjects({ includeArchived: true, includeTrashed: true }).find((project) => project.id === projectId);
    if (existing) {
      if (existing.name !== name || existing.sourceModelId !== sourceModelId) {
        throw new ApiError(409, "idempotency_conflict", "That commandId was already used with different Project intent.");
      }
      return { project: publicProject(existing) };
    }
    try {
      return { project: publicProject(this.store.createProjectFromModel({ projectId, projectName: name, sourceModelId, createdAt: this.#now() })) };
    } catch (error) { throw storeApiError(error); }
  }

  projectWorkspace(projectId: string): ProjectWorkspaceProjectionDto {
    const id = boundedId(projectId);
    try {
      const project = this.store.getProject(id);
      return {
        project: publicProject(project),
        files: this.store.listObjectFiles({ kind: "project", id }).filter((file) => file.kind === "project_model_snapshot").map(publicFile),
        conversations: this.store.listConversations({ kind: "project", id }),
        experimentConfigurations: this.store.listExperimentConfigurations(id).map(publicExperimentConfiguration),
        runs: this.store.listRuns(id).map((run) => publicRun(run, this.store.listRunOutputs(run.id))),
      };
    } catch (error) { throw storeApiError(error); }
  }

  createExperimentConfiguration(input: { projectId: string; commandId: string; name: string; configuration: Record<string, unknown> }): ExperimentConfigurationDto {
    const projectId = boundedId(input.projectId);
    const commandId = boundedKey(input.commandId, "commandId");
    const name = boundedName(input.name, "Experiment configuration name");
    const configuration = boundedConfiguration(input.configuration);
    const plan = planExperiment({
      configuration,
      inputSchema: this.#projectInputSchema(projectId),
      maxSamples: MAX_EXPERIMENT_SAMPLES,
    });
    const id = stableId("experiment", `${projectId}:${commandId}`);
    try {
      return publicExperimentConfiguration(this.store.createExperimentV4({
        commandId,
        id,
        projectId,
        name,
        plan,
        createdAt: this.#now(),
      }));
    } catch (error) { throw storeApiError(error); }
  }

  updateExperimentConfiguration(input: {
    projectId: string;
    configId: string;
    commandId: string;
    expectedConfigurationDigest: string;
    expectedRecordDigest: string;
    name?: string;
    configuration?: Record<string, unknown>;
  }): ExperimentConfigurationDto {
    const projectId = boundedId(input.projectId);
    const configId = boundedId(input.configId);
    const commandId = boundedKey(input.commandId, "commandId");
    const expectedConfigurationDigest = boundedDigest(input.expectedConfigurationDigest);
    const expectedRecordDigest = boundedDigest(input.expectedRecordDigest, "expectedRecordDigest");
    if (input.name === undefined && input.configuration === undefined) throw new ApiError(422, "invalid_request", "Experiment update must change name or configuration.");
    const name = input.name === undefined ? undefined : boundedName(input.name, "Experiment configuration name");
    const configuration = input.configuration === undefined ? undefined : boundedConfiguration(input.configuration);
    try {
      const replayed = this.store.getExperimentUpdateReceipt({
        commandId,
        id: configId,
        projectId,
        expectedConfigurationDigest,
        expectedRecordDigest,
        ...(name === undefined ? {} : { name }),
        ...(configuration === undefined ? {} : { configuration }),
      });
      if (replayed) return publicExperimentConfiguration(replayed);
    } catch (error) { throw storeApiError(error); }
    const plan = configuration === undefined ? undefined : planExperiment({
      configuration,
      inputSchema: this.#projectInputSchema(projectId),
      maxSamples: MAX_EXPERIMENT_SAMPLES,
    });
    try {
      return publicExperimentConfiguration(this.store.updateExperimentV4({
        commandId,
        id: configId,
        projectId,
        expectedConfigurationDigest,
        expectedRecordDigest,
        ...(name === undefined ? {} : { name }),
        ...(configuration === undefined ? {} : { configuration, plan: plan! }),
        updatedAt: this.#now(),
      }));
    } catch (error) { throw storeApiError(error); }
  }

  #projectInputSchema(projectId: string): unknown {
    let project: ProjectRecord;
    try { project = this.store.getProject(projectId); }
    catch (error) { throw storeApiError(error); }
    const inputs = project.executionDescription.inputs;
    if (!inputs || typeof inputs !== "object" || Array.isArray(inputs) || !Object.hasOwn(inputs, "schema")) {
      throw new ApiError(500, "project_snapshot_corrupt", "The copied Project input schema is missing.");
    }
    return (inputs as Record<string, unknown>).schema;
  }

  async createConversation(input: {
    commandId: string;
    owner: ConversationOwner;
    name: string;
    providerId: string;
    modelId: string;
  }): Promise<ConversationDto> {
    const commandId = boundedKey(input.commandId, "commandId");
    const name = boundedName(input.name, "Conversation name");
    const providerId = boundedProviderPart(input.providerId, "providerId");
    const providerModelId = boundedProviderPart(input.modelId, "modelId");
    assertOwner(input.owner);
    const id = stableId("conversation", `${input.owner.kind}:${input.owner.id}:${commandId}`);
    const existing = this.store.listConversations(input.owner, { includeArchived: true, includeTrashed: true }).find((item) => item.id === id);
    if (existing) {
      if (existing.name !== name || existing.provider.providerId !== providerId || existing.provider.modelId !== providerModelId) {
        throw new ApiError(409, "idempotency_conflict", "That commandId was already used with different Conversation intent.");
      }
      return existing;
    }
    this.#assertOwnerExists(input.owner);
    await this.#requireProviderModel(providerId, providerModelId);
    try {
      return this.store.createConversation({ id, owner: input.owner, name, providerId, providerModelId, createdAt: this.#now() });
    } catch (error) { throw storeApiError(error); }
  }

  listConversations(owner: ConversationOwner): ConversationDto[] {
    assertOwner(owner);
    this.#assertOwnerExists(owner);
    try { return this.store.listConversations(owner); }
    catch (error) { throw storeApiError(error); }
  }

  getConversation(conversationId: string): ConversationDto {
    try { return this.store.getConversation(boundedId(conversationId)); }
    catch (error) { throw storeApiError(error); }
  }

  listMessages(conversationId: string): ConversationMessageDto[] {
    try { return this.store.listConversationMessages(boundedId(conversationId)); }
    catch (error) { throw storeApiError(error); }
  }

  createAttachment(input: { commandId: string; conversationId: string; originalName: string; mediaType: string; bytes: Uint8Array; purpose?: string | null }) {
    const commandId = boundedKey(input.commandId, "commandId"); const conversationId = boundedId(input.conversationId);
    this.store.getConversation(conversationId);
    if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength < 1 || input.bytes.byteLength > 1_048_576) throw new ApiError(422, "invalid_attachment", "Attachment bytes are empty or too large.");
    const originalName = boundedName(input.originalName, "Attachment name");
    const mediaType = boundedProviderPart(input.mediaType, "mediaType");
    const purpose = input.purpose == null ? null : boundedPurpose(input.purpose);
    const attachmentId = stableId("attachment", `${conversationId}:${commandId}`);
    const objectFileId = stableId("file", `attachment:${conversationId}:${commandId}`);
    try {
      const existing = this.store.getConversationAttachment(attachmentId);
      const digest = createHash("sha256").update(input.bytes).digest("hex");
      if (existing.conversationId !== conversationId || existing.originalName !== originalName || existing.mediaType !== mediaType
        || existing.purpose !== purpose || existing.sha256 !== digest) throw new ApiError(409, "idempotency_conflict", "That commandId was already used with different attachment intent.");
      return existing;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof ProductStoreV2Error && !/does not exist/u.test(error.message)) throw storeApiError(error);
    }
    try {
      this.store.createAttachment({ id: attachmentId, objectFileId, conversationId, relativePath: stableId("upload", commandId), originalName,
        mediaType, purpose, bytes: input.bytes, createdAt: this.#now() });
      return this.store.getConversationAttachment(attachmentId);
    } catch (error) { throw storeApiError(error); }
  }

  listTemporaryDocuments(conversationId: string) {
    const id = boundedId(conversationId);
    this.store.getConversation(id);
    try { return this.store.listTemporaryDocuments(id); }
    catch (error) { throw storeApiError(error); }
  }

  runTurn(input: { conversationId: string; requestKey: string; text: string; attachmentIds?: string[] }): Promise<AgentTurnResult> {
    const key = `${input.conversationId}\u0000${input.requestKey}`;
    const pending = this.#pendingTurns.get(key);
    if (pending) return pending;
    const previous = this.#conversationTurnTails.get(input.conversationId) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(() => this.#runTurn(input));
    let tail: Promise<void>;
    const tracked = operation.then(
      (result) => { this.#releaseTurn(key, input.conversationId, tracked, tail); return result; },
      (error: unknown) => { this.#releaseTurn(key, input.conversationId, tracked, tail); throw error; },
    );
    tail = tracked.then(() => undefined, () => undefined);
    this.#pendingTurns.set(key, tracked);
    this.#conversationTurnTails.set(input.conversationId, tail);
    return tracked;
  }

  #releaseTurn(key: string, conversationId: string, operation: Promise<AgentTurnResult>, tail: Promise<void>): void {
    if (this.#pendingTurns.get(key) === operation) this.#pendingTurns.delete(key);
    if (this.#conversationTurnTails.get(conversationId) === tail) this.#conversationTurnTails.delete(conversationId);
  }

  async #runTurn(input: { conversationId: string; requestKey: string; text: string; attachmentIds?: string[] }): Promise<AgentTurnResult> {
    const conversationId = boundedId(input.conversationId);
    const requestKey = boundedKey(input.requestKey, "requestKey");
    const text = boundedText(input.text);
    const attachmentIds = input.attachmentIds ?? [];
    if (!Array.isArray(attachmentIds) || attachmentIds.length > 16 || attachmentIds.some((id) => typeof id !== "string")) {
      throw new ApiError(422, "invalid_turn", "attachmentIds must be a bounded array of IDs.");
    }
    const turnId = stableId("turn", `${conversationId}:${requestKey}`);
    let turn: AgentTurnDto;
    try {
      turn = this.store.startAgentTurn({
        turnId,
        userMessageId: stableId("message", `${conversationId}:${requestKey}:user`),
        conversationId,
        requestKey,
        text,
        attachmentIds: attachmentIds.map(boundedId),
        createdAt: this.#now(),
      });
    } catch (error) { throw storeApiError(error); }
    if (turn.state === "complete") return { mode: "live", turn, messages: this.store.listConversationMessages(conversationId) };
    if (turn.state === "failed" || turn.state === "read_only") {
      return { mode: "read_only", reason: asReadOnlyReason(turn.failure?.code), turn, messages: this.store.listConversationMessages(conversationId) };
    }

    let prepared: PreparedAgentTurnRuntime | undefined;
    let scopedRelease: (() => void) | undefined;
    let mcpBound = false;
    try {
      prepared = await this.turnRuntime?.prepare({ conversationId, turnId, text, attachmentIds: attachmentIds.map(boundedId) });
      if (prepared?.requiresMcp) {
        if (!this.#scopedMcpUrl || !this.openCode.bindScopedMcp || !this.openCode.unbindScopedMcp) {
          throw new ApiError(503, "opencode_mcp_unavailable", "OpenCode cannot bind a scoped MCP server for this Agent turn.");
        }
        scopedRelease = await this.#acquireScopedMcpTurn();
        // Keep the OpenCode MCP server name stable for the durable conversation.
        // Only its short-lived capability URL rotates per turn. Some OpenCode
        // runtimes stop advancing a reused session when every turn introduces
        // an entirely new tool namespace.
        await this.openCode.bindScopedMcp(conversationId, this.#scopedMcpUrl(prepared.capability));
        mcpBound = true;
      }
      const context = this.#contextFor(conversationId, turn.userMessageId, prepared);
      const result = await this.#sessions.prompt(conversationId, context, text, prepared?.promptAttachments ?? [], mcpBound ? conversationId : undefined);
      if (result.mode === "read_only") {
        turn = this.store.failAgentTurn(conversationId, requestKey, result.reason, result.retryable, this.#now());
        return { mode: "read_only", reason: result.reason, turn, messages: this.store.listConversationMessages(conversationId) };
      }
      turn = this.store.completeAgentTurn({
        conversationId,
        requestKey,
        assistantMessageId: stableId("message", `${conversationId}:${requestKey}:assistant`),
        assistantText: result.assistant.text,
        assistantContent: result.assistant.content,
        contextDigest: result.context.sha256,
        completedAt: this.#now(),
      });
      return { mode: "live", turn, messages: this.store.listConversationMessages(conversationId) };
    } catch (error) {
      const code = error instanceof ApiError ? safeFailureCode(error.code) : "agent_failed";
      try { turn = this.store.failAgentTurn(conversationId, requestKey, code, true, this.#now()); }
      catch { throw storeApiError(error); }
      return { mode: "read_only", reason: asReadOnlyReason(code), turn, messages: this.store.listConversationMessages(conversationId) };
    } finally {
      prepared?.release();
      if (mcpBound && prepared) await this.openCode.unbindScopedMcp?.(conversationId).catch(() => undefined);
      scopedRelease?.();
    }
  }

  async #acquireScopedMcpTurn(): Promise<() => void> {
    // OpenCode's dynamic MCP registry is process-global rather than session-local.
    // Keep only one live Riff capability registered at a time; per-prompt tool
    // filtering is defense in depth, not the authority boundary.
    const previous = this.#scopedMcpTail;
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.#scopedMcpTail = previous.catch(() => undefined).then(() => current);
    await previous.catch(() => undefined);
    return release;
  }

  #contextFor(conversationId: string, currentUserMessageId: string | null, prepared?: PreparedAgentTurnRuntime): AgentContextInput {
    const snapshot = this.store.readConversationContext(conversationId, { maxMessages: 32, maxBytes: 48_000 });
    const ownerSummary = this.#ownerSummary(snapshot.owner);
    return {
      conversationId,
      owner: snapshot.owner,
      ownerSummary,
      rollingSummary: snapshot.summary ? { text: snapshot.summary.content, throughOrdinal: snapshot.summary.coveredThroughOrdinal } : null,
      messages: snapshot.messages.filter((message) => message.id !== currentUserMessageId).map((message) => ({
        id: message.id,
        conversationId,
        ordinal: message.ordinal,
        role: message.role,
        status: message.status,
        text: message.text,
      })),
      ...(prepared?.context.attachments ? { attachments: prepared.context.attachments } : {}),
      ...(prepared?.context.documents ? { documents: prepared.context.documents } : {}),
      ...(prepared?.context.selectedSkills ? { selectedSkills: prepared.context.selectedSkills } : {}),
    };
  }

  #ownerSummary(owner: ConversationOwner): AgentContextInput["ownerSummary"] {
    const record = owner.kind === "model"
      ? this.store.listModels({ includeArchived: true }).find((item) => item.id === owner.id)
      : this.store.listProjects({ includeArchived: true }).find((item) => item.id === owner.id);
    if (!record) throw new ApiError(404, "resource_not_found", "The conversation owner does not exist.");
    const files = this.store.listObjectFiles(owner).map((file) => ({ id: file.id, sha256: file.sha256, sizeBytes: file.sizeBytes }));
    const workspaceDigest = createHash("sha256").update(JSON.stringify(files)).digest("hex");
    const text = owner.kind === "model"
      ? JSON.stringify({ name: record.name, technicalStatus: (record as ModelRecord).technicalStatus, runMode: (record as ModelRecord).runMode })
      : JSON.stringify({ name: record.name, fixedModelSnapshot: true });
    return { owner, text, workspaceDigest };
  }

  #assertOwnerExists(owner: ConversationOwner): void {
    const exists = owner.kind === "model"
      ? this.store.listModels({ includeArchived: true, includeTrashed: true }).some((item) => item.id === owner.id)
      : this.store.listProjects({ includeArchived: true, includeTrashed: true }).some((item) => item.id === owner.id);
    if (!exists) throw new ApiError(404, "resource_not_found", "The conversation owner does not exist.");
  }

  async #requireProviderModel(providerId: string, modelId: string): Promise<void> {
    let models: OpenCodeProviderModel[];
    try { models = await this.openCode.discoverProviderModels(); }
    catch (error) {
      if (error instanceof ApiError && (error.status === 401 || error.code === "opencode_auth_failed")) throw new ApiError(503, "opencode_auth_failed", "OpenCode provider authentication is unavailable.");
      throw new ApiError(503, "opencode_unavailable", "OpenCode provider discovery is unavailable.");
    }
    const providerExists = models.some((item) => item.providerId === providerId);
    if (!providerExists) throw new ApiError(409, "provider_unavailable", "The selected provider is unavailable.");
    if (!models.some((item) => item.providerId === providerId && item.modelId === modelId)) throw new ApiError(409, "model_unavailable", "The selected provider/model is unavailable.");
  }
}

const publicModel = (record: ModelRecord): ModelCreationDto["model"] => ({
  id: record.id,
  name: record.name,
  lifecycleState: record.lifecycleState,
  technicalStatus: record.technicalStatus,
  runMode: record.runMode,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
});

const publicProject = (record: ProjectRecord): ProjectCreationDto["project"] => ({
  id: record.id,
  name: record.name,
  lifecycleState: record.lifecycleState,
  sourceModelId: record.sourceModelId,
  modelSnapshotDigest: record.modelSnapshotDigest,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
});

const publicFile = (file: StoredObjectMetadata): ProjectWorkspaceProjectionDto["files"][number] => ({
  id: file.id,
  mediaType: file.mediaType,
  sizeBytes: file.sizeBytes,
  sha256: file.sha256,
  createdAt: file.createdAt,
});

const publicExperimentConfiguration = (record: ExperimentConfigurationRecord): ExperimentConfigurationDto => record.contractVersion === 4
  ? {
      id: record.id,
      projectId: record.projectId,
      name: record.name,
      configuration: record.configuration,
      estimatedSampleCount: record.sampleCount,
      lifecycleState: record.lifecycleState,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      contractVersion: 4,
      readOnly: false,
      legacyDigest: null,
      configurationDigest: record.configurationDigest,
      sampleCount: record.sampleCount,
      recordDigest: experimentConfigurationRecordDigest(record),
    }
  : {
      id: record.id,
      projectId: record.projectId,
      name: record.name,
      configuration: record.configuration,
      estimatedSampleCount: record.estimatedSampleCount,
      lifecycleState: record.lifecycleState,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      contractVersion: 3,
      readOnly: true,
      legacyDigest: record.legacyDigest,
      recordDigest: null,
    };

const publicOutput = (record: OutputIndexRecord): ProjectOutputDto => ({
  id: record.id,
  runId: record.runId,
  logicalName: record.logicalName,
  outputType: record.outputType,
  contractVersion: record.contractVersion,
  readOnly: record.readOnly,
  legacyDigest: record.legacyDigest,
  sampleIndex: record.contractVersion === 4 ? record.sampleIndex : null,
  sampleId: record.contractVersion === 4 ? record.sampleId : null,
  declaredRole: record.contractVersion === 4 ? record.declaredRole : null,
  mediaType: record.file.mediaType,
  sizeBytes: record.file.sizeBytes,
  sha256: record.file.sha256,
  createdAt: record.createdAt,
});

const publicRun = (record: RunRecord, outputs: OutputIndexRecord[]): ProjectRunDto => ({
  id: record.id,
  projectId: record.projectId,
  experimentConfigurationId: record.experimentConfigurationId,
  status: record.status,
  requestedSampleCount: record.requestedSampleCount,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
  startedAt: record.startedAt,
  finishedAt: record.finishedAt,
  contractVersion: record.contractVersion,
  readOnly: record.readOnly,
  legacyDigest: record.legacyDigest,
  runKind: record.contractVersion === 4 ? record.runKind : null,
  cancelRequestedAt: record.contractVersion === 4 ? record.cancelRequestedAt : null,
  terminalCode: record.contractVersion === 4 ? record.terminalCode : null,
  completionCardDisposition: record.contractVersion === 4 ? record.completionCardDisposition : null,
  outputs: outputs.map(publicOutput),
});

const stableId = (prefix: string, value: string): string => `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
const MAX_EXPERIMENT_SAMPLES = 10_000;
const boundedKey = (value: string, name: string): string => {
  if (typeof value !== "string" || !value.trim() || value.length > 300 || /[\u0000-\u001f\u007f]/u.test(value)) throw new ApiError(422, "invalid_request", `${name} is invalid.`);
  return value;
};
const boundedId = (value: string): string => {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/u.test(value)) throw new ApiError(422, "invalid_id", "A resource ID is invalid.");
  return value;
};
const boundedName = (value: string, label: string): string => {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 200 || /[\u0000-\u001f\u007f]/u.test(value)) throw new ApiError(422, "invalid_request", `${label} is invalid.`);
  return value.trim();
};
const boundedDigest = (value: string, name = "expectedConfigurationDigest"): string => {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) throw new ApiError(422, "invalid_request", `${name} must be a lowercase SHA-256 digest.`);
  return value;
};
const boundedProviderPart = (value: string, label: string): string => {
  if (typeof value !== "string" || !value.trim() || value.length > 300 || /[\s\u0000-\u001f\u007f]/u.test(value)) throw new ApiError(422, "invalid_request", `${label} is invalid.`);
  return value;
};
const boundedText = (value: string): string => {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > 64_000) throw new ApiError(422, "invalid_turn", "Turn text is empty or too large.");
  return value.trim();
};
const boundedPurpose = (value: string): string => {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > 2_000 || value.includes("\0")) {
    throw new ApiError(422, "invalid_attachment", "Attachment purpose is invalid.");
  }
  return value.trim();
};
const boundedConfiguration = (value: Record<string, unknown>): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(422, "invalid_request", "Experiment configuration must be an object.");
  const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  if (bytes < 2 || bytes > 64_000) throw new ApiError(422, "invalid_request", "Experiment configuration is too large.");
  if (!finiteJson(value)) throw new ApiError(422, "invalid_request", "Experiment configuration must contain only finite JSON values.");
  return structuredClone(value);
};
const finiteJson = (value: unknown): boolean => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(finiteJson);
  if (typeof value === "object") return Object.entries(value as Record<string, unknown>).every(([key, item]) => key.length > 0 && !/[\u0000-\u001f\u007f]/u.test(key) && finiteJson(item));
  return false;
};
const assertOwner = (owner: ConversationOwner): void => {
  if (!owner || !["model", "project"].includes(owner.kind)) throw new ApiError(422, "invalid_owner", "Conversation owner kind is invalid.");
  boundedId(owner.id);
};
const safeFailureCode = (code: string): string => /^[a-z0-9_]{1,200}$/u.test(code) ? code : "agent_failed";
const asReadOnlyReason = (code: string | null | undefined): AgentReadOnlyReason | "agent_failed" => {
  const allowed = new Set<AgentReadOnlyReason>([
    "opencode_unavailable", "opencode_auth_failed", "provider_unavailable", "model_unavailable",
    "session_validation_failed", "session_rebuild_failed", "empty_assistant_response",
  ]);
  return code && allowed.has(code as AgentReadOnlyReason) ? code as AgentReadOnlyReason : "agent_failed";
};

const storeApiError = (error: unknown): ApiError => {
  if (error instanceof ApiError) return error;
  if (!(error instanceof ProductStoreV2Error)) return new ApiError(500, "internal_error", "The Agent workspace could not complete the request.");
  if (/does not exist/u.test(error.message)) return new ApiError(404, "resource_not_found", "The requested resource does not exist.");
  if (/^stale_configuration:/u.test(error.message)) return new ApiError(409, "stale_configuration", "The experiment configuration changed after it was observed.");
  if (/^stale_record:/u.test(error.message)) return new ApiError(409, "stale_record", "The experiment record changed after it was observed.");
  if (/command already exists with a different intent/u.test(error.message)) return new ApiError(409, "idempotency_conflict", "That commandId was already used with different experiment intent.");
  if (/reused|already|different|changed|locked|unexpected number|not active and technically executable/u.test(error.message)) return new ApiError(409, "state_conflict", "The request conflicts with current durable state.");
  if (/invalid|required|must|cannot|outside/u.test(error.message)) return new ApiError(422, "invalid_request", "The request violates the Agent workspace contract.");
  return new ApiError(500, "storage_error", "The Agent workspace store rejected the request.");
};
