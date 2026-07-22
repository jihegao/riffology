import { createHash } from "node:crypto";
import { ApiError } from "./errors.ts";
import type { AgentContextInput } from "./agent-context.ts";
import { AgentConversationSessionManager, type AgentReadOnlyReason } from "./agent-session-manager.ts";
import type { AgentTurnDto, ConversationDto, ConversationMessageDto, ConversationOwner } from "./agent-domain.ts";
import { createGenericModelScaffold } from "./model-workspace.ts";
import type { OpenCodeConversationPort, OpenCodeProviderModel } from "./opencode-adapter.ts";
import { ProductStoreV2, ProductStoreV2Error } from "./product-store-v2.ts";
import type { ModelRecord } from "./product-domain.ts";

export type ProviderDiscoveryDto =
  | { mode: "live"; providerModels: OpenCodeProviderModel[] }
  | { mode: "read_only"; reason: "opencode_unavailable" | "opencode_auth_failed"; providerModels: [] };

export type ModelCreationDto = {
  model: Pick<ModelRecord, "id" | "name" | "lifecycleState" | "technicalStatus" | "runMode" | "createdAt" | "updatedAt">;
  conversation: ConversationDto;
};

export type AgentTurnResult =
  | { mode: "live"; turn: AgentTurnDto; messages: ConversationMessageDto[] }
  | { mode: "read_only"; reason: AgentReadOnlyReason | "agent_failed"; turn: AgentTurnDto; messages: ConversationMessageDto[] };

export class AgentWorkspaceService {
  readonly #sessions: AgentConversationSessionManager;
  readonly #now: () => string;
  readonly #pendingTurns = new Map<string, Promise<AgentTurnResult>>();
  readonly store: ProductStoreV2;
  readonly openCode: OpenCodeConversationPort;

  constructor(
    store: ProductStoreV2,
    openCode: OpenCodeConversationPort,
    now: () => string = () => new Date().toISOString(),
  ) {
    this.store = store;
    this.openCode = openCode;
    this.#sessions = new AgentConversationSessionManager(store, openCode);
    this.#now = now;
  }

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

  runTurn(input: { conversationId: string; requestKey: string; text: string; attachmentIds?: string[] }): Promise<AgentTurnResult> {
    const key = `${input.conversationId}\u0000${input.requestKey}`;
    const pending = this.#pendingTurns.get(key);
    if (pending) return pending;
    const operation = this.#runTurn(input).finally(() => {
      if (this.#pendingTurns.get(key) === operation) this.#pendingTurns.delete(key);
    });
    this.#pendingTurns.set(key, operation);
    return operation;
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

    try {
      const context = this.#contextFor(conversationId, turn.userMessageId);
      const result = await this.#sessions.prompt(conversationId, context, text);
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
    }
  }

  #contextFor(conversationId: string, currentUserMessageId: string | null): AgentContextInput {
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

const stableId = (prefix: string, value: string): string => `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
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
const boundedProviderPart = (value: string, label: string): string => {
  if (typeof value !== "string" || !value.trim() || value.length > 300 || /[\s\u0000-\u001f\u007f]/u.test(value)) throw new ApiError(422, "invalid_request", `${label} is invalid.`);
  return value;
};
const boundedText = (value: string): string => {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > 64_000) throw new ApiError(422, "invalid_turn", "Turn text is empty or too large.");
  return value.trim();
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
  if (/reused|already|changed|locked|unexpected number/u.test(error.message)) return new ApiError(409, "state_conflict", "The request conflicts with current durable state.");
  if (/invalid|required|must|cannot|outside/u.test(error.message)) return new ApiError(422, "invalid_request", "The request violates the Agent workspace contract.");
  return new ApiError(500, "storage_error", "The Agent workspace store rejected the request.");
};
