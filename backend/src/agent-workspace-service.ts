import { createHash } from "node:crypto";
import { ApiError } from "./errors.ts";
import type { AgentContextInput } from "./agent-context.ts";
import { AgentConversationSessionManager, type AgentReadOnlyReason } from "./agent-session-manager.ts";
import type {
  AgentTurnDto,
  AgentGoalDisposition,
  ConversationAttachmentDto,
  ConversationDto,
  ConversationMessageDto,
  ConversationOwner,
  ConversationProviderBindingReceipt,
  PublicActionRecordDto,
  PublicSkillUseDto,
  TemporaryDocumentCardDto,
} from "./agent-domain.ts";
import { createGenericModelScaffold } from "./model-workspace.ts";
import {
  redactPublicRuntimeText,
  type OpenCodeAgent,
  type OpenCodeConversationPort,
  type OpenCodeConversationRuntimeSnapshot,
  type OpenCodeProviderModel,
  type OpenCodeWorkspaceBinding,
} from "./opencode-adapter.ts";
import { canonicalDigest } from "./canonical-json-v2.ts";
import {
  experimentConfigurationRecordDigest,
  ProductStoreV2,
  ProductStoreV2Error,
  type DiagnosticEventReadBinding,
  type FrozenRunCancelReceipt,
  type FrozenRunStartReceipt,
  type RunLifecycleBinding,
  type RunLifecycleCommandReceipt,
  type RunLimitsV1,
} from "./product-store-v2.ts";
import type { VerifiedObjectRead } from "./object-store.ts";
import { planExperiment, type ExperimentPlan } from "./experiment-planner.ts";
import {
  assertRunCapabilityV2,
  ExecutionProtocolV2Error,
  validateExecutionDescriptionV2,
  type ExecutionDescriptionV2,
} from "./execution-protocol-v2.ts";
import type {
  ExperimentConfigurationRecord,
  GeneratedViewSetRecord,
  ModelChangeSetRecord,
  ModelMutationReceipt,
  ModelRecord,
  OutputIndexRecord,
  ProjectRecord,
  ProductLifecycleAction,
  ProductLifecycleKind,
  ProductLifecycleReceipt,
  PermanentDeleteReceipt,
  RunRecord,
  StoredObjectMetadata,
} from "./product-domain.ts";
import {
  executableModelOptions,
  homeDto,
  orderedModels,
  orderedProjects,
  publicPermanentDeletePreview,
  type HomeDto,
  type ModelSummaryDto,
  type ProjectSummaryDto,
  type PublicPermanentDeletePreviewDto,
} from "./product-api-dto.ts";
import {
  PermanentDeleteAdmission,
  PermanentDeleteAdmissionError,
} from "./permanent-delete-admission.ts";
import { ModelTechnicalCheckService, type ModelTechnicalCheckerPort, type ModelWorkspaceProjectionDto, type TechnicalCheckDto } from "./model-technical-check-service.ts";
import {
  AgentTurnRuntime,
  explicitImperative,
  type PreparedAgentTurnRuntime,
} from "./agent-turn-runtime.ts";
import {
  goalVerificationIntentAuthority,
  verifyAgentGoal,
  type AgentGoalVerificationInput,
} from "./agent-goal-verifier.ts";
import { normalizeVisualAgentOperation, visualAgentOperationCommitment, type VisualAgentOperation } from "./agent-visual-authority.ts";
import { PRODUCT_DIAGNOSTIC_EVENT_LIMITS } from "./product-run-limits.ts";
import { MutationRecoveryError } from "./mutation-coordinator.ts";
import {
  rendererDto,
  workbenchRendererDto,
  RendererRegistryError,
  type RendererDto,
} from "./renderer-registry.ts";
import {
  publicExecutionDescription,
  type PublicExecutionDescriptionV2,
} from "./public-execution-description.ts";

export type ProviderDiscoveryDto =
  | { mode: "live"; providerModels: OpenCodeProviderModel[] }
  | { mode: "read_only"; reason: "opencode_unavailable" | "opencode_auth_failed"; providerModels: [] };

export type AgentDiscoveryDto =
  | { mode: "live"; agents: OpenCodeAgent[] }
  | { mode: "read_only"; reason: "opencode_unavailable" | "opencode_auth_failed"; agents: [] };

export type PublicAgentGoalVerification = Readonly<{
  disposition: AgentGoalDisposition;
  reasonCode: string;
  receiptDigest: string;
  evidence: Readonly<{
    openCodeTerminal: "idle" | "not_reached" | "unknown";
    intentKind: "response_delivery" | "explicit_mutation" | "model_visual";
    actionCount: number;
    terminalActionCount: number;
    committedActionCount: number;
    affectedResourceCount: number;
    ownerStateVerified: boolean;
    partialEffect: boolean;
  }>;
}>;

export type ConversationRuntimeDto = Readonly<{
  revision: string;
  status: "busy" | "waiting_for_tool" | "waiting_for_user" | "idle" | "failed";
  turnActive: boolean;
  activeRequestKey: string | null;
  assistant: OpenCodeConversationRuntimeSnapshot["assistant"];
  tools: OpenCodeConversationRuntimeSnapshot["tools"];
  interactions: OpenCodeConversationRuntimeSnapshot["interactions"];
  failure: { code: string; retryable: boolean } | null;
  goalVerification: PublicAgentGoalVerification | null;
  scopedMcp: OpenCodeConversationRuntimeSnapshot["scopedMcp"];
  agent: {
    selected: string | null;
  };
  provider: { providerId: string; modelId: string; locked: boolean };
  activity: {
    skillUses: PublicSkillUseDto[];
    actions: PublicActionRecordDto[];
  };
}>;

type ActiveConversationTurn = {
  requestKey: string;
  agentName: string | null;
  controller: AbortController;
  externalSessionRef: string | null;
  workspace: OpenCodeWorkspaceBinding | null;
  mcpBound: boolean;
  controlState: "open" | "stopping" | "terminal";
  controlTail: Promise<void>;
};

export type ModelCreationDto = {
  model: Pick<ModelRecord, "id" | "name" | "lifecycleState" | "technicalStatus" | "runMode" | "createdAt" | "updatedAt">;
  conversation: ConversationDto;
};

export type ProjectCreationDto = {
  project: Pick<ProjectRecord, "id" | "name" | "lifecycleState" | "sourceModelId" | "modelSnapshotDigest" | "createdAt" | "updatedAt">;
};

export type ProjectWorkspaceProjectionDto = {
  project: ProjectCreationDto["project"];
  execution: PublicExecutionDescriptionV2;
  executionDescriptionDigest: string;
  files: Array<{
    fileRef: string;
    relativePath: string;
    mediaType: string;
    sizeBytes: number;
    sha256: string;
    createdAt: string;
    readOnly: true;
  }>;
  conversations: ConversationDto[];
  experimentConfigurations: ExperimentConfigurationDto[];
  runs: ProjectRunDto[];
};

export type GeneratedViewSetDto = Readonly<{
  sourceWorkspaceDigest: string;
  currentWorkspaceDigest: string;
  setDigest: string;
  freshness: "fresh" | "stale";
  publishedAt: string;
  views: readonly Readonly<{
    id: string;
    title: string;
    position: number;
    rendererKind: RendererDto["kind"];
    mediaType: string;
    payloadDigest: string;
    sourceFileRefs: readonly string[];
  }>[];
}>;

export type ModelChangeSetDto = Readonly<{
  id: string;
  baseWorkspaceDigest: string;
  currentWorkspaceDigest: string;
  changeSetDigest: string;
  freshness: "fresh" | "stale";
  state: ModelChangeSetRecord["state"];
  createdAt: string;
  resolvedAt: string | null;
  files: readonly Readonly<{
    itemId: string;
    kind: string;
    relativePath: string;
    mediaType: string;
    priorSha256: string | null;
    proposedSha256: string;
    proposedText: string;
  }>[];
}>;

export type ExperimentConfigurationDto =
  | (Extract<ExperimentConfigurationRecord, { contractVersion: 3 }> & { recordDigest: null })
  | (Extract<ExperimentConfigurationRecord, { contractVersion: 4 }> & {
      recordDigest: string;
      samplePreview: readonly Record<string, unknown>[];
      samplePreviewTruncated: boolean;
    });

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

export type RunOutputAccessDto = Pick<ProjectOutputDto,
  "id" | "runId" | "sampleIndex" | "sampleId" | "logicalName"
  | "declaredRole" | "outputType" | "mediaType" | "sizeBytes" | "sha256"
  | "createdAt">;

export type RunOutputDownload = Readonly<{
  output: RunOutputAccessDto;
  read: VerifiedObjectRead;
}>;

export type ModelFileDownload = Readonly<{
  file: Pick<StoredObjectMetadata, "id" | "mediaType" | "sizeBytes" | "sha256">;
  read: VerifiedObjectRead;
}>;

export type RunDiagnosticEventDto = Readonly<{
  sequence: number;
  sampleIndex: number;
  type: string;
  occurredAt: string | null;
  payload: Record<string, unknown> | readonly unknown[];
}>;

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
  terminalStatus: "succeeded" | "failed" | "cancelled" | "timed_out" | null;
  terminalClosureDigest: string | null;
  lifecycleDigest: string | null;
  seedCount: number;
  stepOrHorizon: string | number | null;
  durationMs: number | null;
  resourceOverview: Readonly<Record<string, number | boolean>> | null;
  outputs: ProjectOutputDto[];
};

export type RunStartDto = {
  schemaVersion: 1;
  commandId: string;
  runId: string;
  projectId: string;
  experimentConfigId: string;
  completionConversationId: string | null;
  status: "queued";
  runKind: "batch" | "visual";
  sampleCount: number;
  createdAt: string;
};

export type RunCancelDto = FrozenRunCancelReceipt;

export type AgentTurnResult =
  | { mode: "live"; turn: AgentTurnDto; messages: ConversationMessageDto[] }
  | { mode: "read_only"; reason: AgentReadOnlyReason | "agent_failed" | "agent_outcome_unknown" | "agent_budget_exhausted"; turn: AgentTurnDto; messages: ConversationMessageDto[] };

export class AgentWorkspaceService {
  readonly #sessions: AgentConversationSessionManager;
  readonly #now: () => string;
  readonly #pendingTurns = new Map<string, Promise<AgentTurnResult>>();
  readonly #conversationTurnTails = new Map<string, Promise<void>>();
  readonly #activeTurns = new Map<string, ActiveConversationTurn>();
  readonly #runtimeCache = new Map<string, OpenCodeConversationRuntimeSnapshot>();
  #scopedMcpTail: Promise<void> = Promise.resolve();
  readonly #scopedMcpUrl?: (capability: string) => string;
  readonly #onRunQueued?: (runId: string, cancellationRequested: boolean) => void;
  readonly #visualDispatchAvailable: boolean;
  readonly #permanentDeleteAdmission = new PermanentDeleteAdmission();
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
    onRunQueued?: (runId: string, cancellationRequested: boolean) => void,
    visualDispatchAvailable = false,
  ) {
    this.store = store;
    this.openCode = openCode;
    this.#sessions = new AgentConversationSessionManager(
      store,
      openCode,
      (owner) => this.#workspaceBinding(owner),
      {},
    );
    this.#now = now;
    this.technicalChecks = new ModelTechnicalCheckService(store, technicalChecker, now);
    this.turnRuntime = turnRuntime;
    this.#scopedMcpUrl = scopedMcpUrl;
    this.#onRunQueued = onRunQueued;
    this.#visualDispatchAvailable = visualDispatchAvailable;
  }

  handleAgentMcp(capability: string | undefined, request: unknown) {
    if (!this.turnRuntime) throw new ApiError(503, "agent_tools_unavailable", "Scoped Agent tools are not configured.");
    return this.turnRuntime.handle(capability, request);
  }

  modelWorkspace(modelId: string): ModelWorkspaceProjectionDto { return this.technicalChecks.workspace(modelId); }
  startTechnicalCheck(modelId: string, commandId: string): Promise<TechnicalCheckDto> { return this.technicalChecks.start(modelId, commandId); }
  getTechnicalCheck(modelId: string, checkId: string): TechnicalCheckDto { return this.technicalChecks.read(modelId, checkId); }
  modelRenderable(modelIdInput: string, fileIdInput: string): RendererDto {
    const modelId = boundedId(modelIdInput);
    const fileId = boundedId(fileIdInput);
    try {
      const workspace = this.modelWorkspace(modelId);
      const file = workspace.files.find((candidate) => candidate.id === fileId);
      if (!file) throw new ApiError(404, "resource_not_found", "The declared Model resource does not exist.");
      return rendererDto({
        title: file.relativePath,
        mediaType: file.mediaType,
        sizeBytes: file.sizeBytes,
        sha256: file.sha256,
        bytes: this.store.readObjectFile(file.id),
      });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof RendererRegistryError) {
        throw new ApiError(422, error.code, error.message);
      }
      throw storeApiError(error);
    }
  }

  generatedViews(modelIdInput: string): GeneratedViewSetDto | null {
    const modelId = boundedId(modelIdInput);
    try {
      const set = this.store.getGeneratedViewSet(modelId);
      if (!set) return null;
      const workspace = this.modelWorkspace(modelId);
      const filesById = new Map(workspace.files.map((file) => [file.id, file]));
      return {
        sourceWorkspaceDigest: set.sourceWorkspaceDigest,
        currentWorkspaceDigest: workspace.digest,
        setDigest: set.setDigest,
        freshness: set.sourceWorkspaceDigest === workspace.digest ? "fresh" : "stale",
        publishedAt: set.publishedAt,
        views: set.views.map((view) => ({
          id: view.id,
          title: view.title,
          position: view.position,
          rendererKind: renderGeneratedView(view).kind,
          mediaType: view.mediaType,
          payloadDigest: view.payloadDigest,
          sourceFileRefs: view.sourceFileIds.flatMap((fileId) => {
            const file = filesById.get(fileId);
            return file ? [file.relativePath] : [];
          }),
        })),
      };
    } catch (error) {
      if (error instanceof RendererRegistryError) {
        throw new ApiError(422, error.code, error.message);
      }
      throw storeApiError(error);
    }
  }

  generatedViewRenderable(modelIdInput: string, viewIdInput: string): RendererDto {
    const modelId = boundedId(modelIdInput);
    const viewId = boundedId(viewIdInput);
    try {
      const set = this.store.getGeneratedViewSet(modelId);
      const view = set?.views.find((candidate) => candidate.id === viewId);
      if (!view) {
        throw new ApiError(404, "resource_not_found", "The generated Model view does not exist.");
      }
      return renderGeneratedView(view);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof RendererRegistryError) {
        throw new ApiError(422, error.code, error.message);
      }
      throw storeApiError(error);
    }
  }

  listModelChangeSets(
    modelIdInput: string,
    state?: "pending" | "applied" | "rejected",
  ): { changeSets: ModelChangeSetDto[] } {
    const modelId = boundedId(modelIdInput);
    try {
      return {
        changeSets: this.store.listModelChangeSets(modelId, state)
          .map((record) => publicModelChangeSet(
            record,
            this.store.modelWorkspaceDigest(modelId),
          )),
      };
    } catch (error) {
      throw storeApiError(error);
    }
  }

  getModelChangeSet(modelIdInput: string, changeSetIdInput: string): ModelChangeSetDto {
    const modelId = boundedId(modelIdInput);
    const changeSetId = boundedId(changeSetIdInput);
    try {
      return publicModelChangeSet(
        this.store.getModelChangeSet(modelId, changeSetId),
        this.store.modelWorkspaceDigest(modelId),
      );
    } catch (error) {
      throw storeApiError(error);
    }
  }

  applyModelChangeSet(input: {
    modelId: string;
    changeSetId: string;
    commandId: string;
    expectedChangeSetDigest: string;
    expectedWorkspaceDigest: string;
  }): ModelMutationReceipt {
    try {
      return this.store.applyModelChangeSet({
        modelId: boundedId(input.modelId),
        changeSetId: boundedId(input.changeSetId),
        commandId: boundedId(input.commandId),
        expectedChangeSetDigest: boundedDigest(input.expectedChangeSetDigest),
        expectedWorkspaceDigest: boundedDigest(input.expectedWorkspaceDigest),
        committedAt: this.#now(),
      });
    } catch (error) {
      throw storeApiError(error);
    }
  }

  rejectModelChangeSet(input: {
    modelId: string;
    changeSetId: string;
    commandId: string;
    expectedChangeSetDigest: string;
  }): ModelMutationReceipt {
    try {
      return this.store.rejectModelChangeSet({
        modelId: boundedId(input.modelId),
        changeSetId: boundedId(input.changeSetId),
        commandId: boundedId(input.commandId),
        expectedChangeSetDigest: boundedDigest(input.expectedChangeSetDigest),
        committedAt: this.#now(),
      });
    } catch (error) {
      throw storeApiError(error);
    }
  }

  openModelFileDownload(modelIdInput: string, fileIdInput: string): ModelFileDownload {
    const modelId = boundedId(modelIdInput);
    const fileId = boundedId(fileIdInput);
    try {
      const opened = this.store.openModelFileDownload({ modelId, fileId });
      return Object.freeze({
        file: Object.freeze({
          id: opened.file.id,
          mediaType: opened.file.mediaType,
          sizeBytes: opened.file.sizeBytes,
          sha256: opened.file.sha256,
        }),
        read: opened.read,
      });
    } catch (error) {
      throw storeApiError(error);
    }
  }

  async discoverProviders(): Promise<ProviderDiscoveryDto> {
    try {
      return {
        mode: "live",
        providerModels: (await this.openCode.discoverProviderModels()).map((model) =>
          Object.freeze({
            providerId: model.providerId,
            modelId: model.modelId,
            qualifiedId: model.qualifiedId,
          })),
      };
    }
    catch (error) {
      const auth = error instanceof ApiError && (error.status === 401 || error.code === "opencode_auth_failed");
      return { mode: "read_only", reason: auth ? "opencode_auth_failed" : "opencode_unavailable", providerModels: [] };
    }
  }

  async discoverAgents(owner: ConversationOwner): Promise<AgentDiscoveryDto> {
    this.#assertOwnerExists(owner);
    if (!this.openCode.discoverAgents) {
      return { mode: "read_only", reason: "opencode_unavailable", agents: [] };
    }
    try {
      return {
        mode: "live",
        agents: (await this.openCode.discoverAgents(this.#workspaceBinding(owner))).filter((agent) =>
          agent.mode === "primary" || agent.mode === "all"),
      };
    } catch (error) {
      const auth = error instanceof ApiError && (error.status === 401 || error.code === "opencode_auth_failed");
      return { mode: "read_only", reason: auth ? "opencode_auth_failed" : "opencode_unavailable", agents: [] };
    }
  }

  async home(): Promise<HomeDto> {
    const models = orderedModels(this.store, this.store.listModels());
    const projects = orderedProjects(this.store, this.store.listProjects());
    return homeDto(
      this.#now(),
      models,
      projects,
      executableModelOptions(models),
      await this.discoverProviders(),
    );
  }

  listModelsByLifecycle(
    lifecycle: "active" | "archived" | "trashed",
  ): ModelSummaryDto[] {
    return orderedModels(
      this.store,
      this.store.listModels({
        includeArchived: lifecycle === "archived",
        includeTrashed: lifecycle === "trashed",
      }).filter((record) => record.lifecycleState === lifecycle),
    );
  }

  listProjectsByLifecycle(
    lifecycle: "active" | "archived" | "trashed",
  ): ProjectSummaryDto[] {
    return orderedProjects(
      this.store,
      this.store.listProjects({
        includeArchived: lifecycle === "archived",
        includeTrashed: lifecycle === "trashed",
      }).filter((record) => record.lifecycleState === lifecycle),
    );
  }

  lifecycleCommand(input: {
    commandId: string;
    action: ProductLifecycleAction;
    kind: ProductLifecycleKind;
    id: string;
    expectedRecordDigest: string;
    name?: string;
  }): ProductLifecycleReceipt {
    try {
      return this.store.executeLifecycleCommand({
        commandId: boundedKey(input.commandId, "commandId"),
        action: input.action,
        kind: input.kind,
        id: boundedId(input.id),
        expectedRecordDigest: input.expectedRecordDigest,
        ...(input.name === undefined
          ? {}
          : { name: boundedName(input.name, "Resource name") }),
        committedAt: this.#now(),
      });
    } catch (error) {
      throw storeApiError(error);
    }
  }

  permanentDeletePreview(input: {
    kind: ProductLifecycleKind;
    id: string;
    browserGeneration: number;
    runtimeBlockers?: readonly { kind: string; id: string }[];
  }): PublicPermanentDeletePreviewDto {
    try {
      const preview = this.store.previewPermanentDelete(input.kind, boundedId(input.id));
      const activity = [
        ...this.store.permanentDeleteActivityBlockers(input.kind, input.id),
        ...this.#pendingTurnBlockers(preview),
        ...(input.runtimeBlockers ?? []),
      ];
      const combined = {
        ...preview,
        blockingReferences: [...preview.blockingReferences, ...activity]
          .sort((left, right) => left.kind < right.kind ? -1
            : left.kind > right.kind ? 1
              : left.id < right.id ? -1
                : left.id > right.id ? 1
                  : 0),
      };
      const issued = this.#permanentDeleteAdmission.issue({
        generation: input.browserGeneration,
        kind: input.kind,
        id: input.id,
        previewToken: preview.previewToken,
        stateToken: preview.stateToken,
        recordCount: preview.records.length,
        fileCount: preview.files.length,
        totalBytes: preview.totalBytes,
      });
      return publicPermanentDeletePreview(
        input.kind,
        combined,
        issued.confirmationToken,
        issued.expiresAt,
      );
    } catch (error) {
      throw storeApiError(error);
    }
  }

  permanentDelete(input: {
    commandId: string;
    kind: ProductLifecycleKind;
    id: string;
    browserGeneration: number;
    previewToken: string;
    stateToken: string;
    confirmationToken: string;
    confirmation: Readonly<{
      action: "permanently_delete";
      kind: ProductLifecycleKind;
      id: string;
      recordCount: number;
      fileCount: number;
      totalBytes: number;
    }>;
    commitWithFence?: (
      preview: ReturnType<ProductStoreV2["previewPermanentDelete"]>,
      commit: () => PermanentDeleteReceipt,
    ) => PermanentDeleteReceipt;
  }): PermanentDeleteReceipt {
    const commandId = boundedKey(input.commandId, "commandId");
    const id = boundedId(input.id);
    const canonicalIntentDigest = canonicalDigest({
      kind: input.kind,
      id,
      previewToken: input.previewToken,
      stateToken: input.stateToken,
      confirmation: input.confirmation,
    });
    try {
      const replay = this.store.permanentDeleteReceipt(
        commandId,
        input.kind,
        id,
        canonicalIntentDigest,
      );
      if (replay) return replay;
      this.#permanentDeleteAdmission.consume(input.confirmationToken, {
        generation: input.browserGeneration,
        kind: input.kind,
        id,
        previewToken: input.previewToken,
        stateToken: input.stateToken,
        recordCount: input.confirmation.recordCount,
        fileCount: input.confirmation.fileCount,
        totalBytes: input.confirmation.totalBytes,
      });
      if (input.confirmation.action !== "permanently_delete"
        || input.confirmation.kind !== input.kind
        || input.confirmation.id !== id) {
        throw new ApiError(
          422,
          "permanent_delete_confirmation_mismatch",
          "Permanent-delete confirmation does not match the route.",
        );
      }
      const preview = this.store.previewPermanentDelete(input.kind, id);
      if (preview.previewToken !== input.previewToken
        || preview.stateToken !== input.stateToken
        || preview.records.length !== input.confirmation.recordCount
        || preview.files.length !== input.confirmation.fileCount
        || preview.totalBytes !== input.confirmation.totalBytes) {
        throw new ApiError(
          409,
          "permanent_delete_state_changed",
          "The permanent-delete preview is stale.",
        );
      }
      const blockers = [
        ...preview.blockingReferences,
        ...this.store.permanentDeleteActivityBlockers(input.kind, id),
        ...this.#pendingTurnBlockers(preview),
      ];
      if (blockers.length > 0) {
        throw new ApiError(
          409,
          "permanent_delete_blocked",
          "The resource cannot be permanently deleted while references or work remain.",
        );
      }
      const commit = (): PermanentDeleteReceipt =>
        this.store.commitPermanentDelete({
          commandId,
          kind: input.kind,
          id,
          previewToken: input.previewToken,
          stateToken: input.stateToken,
          canonicalIntentDigest,
          committedAt: this.#now(),
        });
      return input.commitWithFence
        ? input.commitWithFence(preview, commit)
        : commit();
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof PermanentDeleteAdmissionError) {
        throw new ApiError(
          409,
          "permanent_delete_confirmation_invalid",
          "The permanent-delete confirmation is invalid or expired.",
        );
      }
      throw storeApiError(error);
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
      const execution = validateExecutionDescriptionV2(project.executionDescription);
      return {
        project: publicProject(project),
      execution: publicExecutionDescription(execution),
        executionDescriptionDigest: canonicalDigest(execution),
        files: this.store.listObjectFiles({ kind: "project", id })
          .filter((file) => file.kind === "project_model_snapshot")
          .map((file) => publicProjectFile(id, file)),
        conversations: this.store.listConversations({ kind: "project", id }),
        experimentConfigurations: this.store.listExperimentConfigurations(id).map((record) =>
          publicExperimentConfiguration(
            record,
            record.contractVersion === 4
              ? planExperiment({
                  configuration: record.configuration,
                  inputSchema: execution.inputs.schema,
                  maxSamples: MAX_EXPERIMENT_SAMPLES,
                })
              : null,
          )),
        runs: this.store.listRuns(id, { includeTrashed: true }).map((run) =>
          publicRun(
            run,
            run.status === "succeeded" ? this.store.listRunOutputs(run.id) : [],
            run.contractVersion === 4
              ? this.store.currentRunLifecycleBinding(id, run.id)
              : undefined,
            execution,
          )),
      };
    } catch (error) { throw storeApiError(error); }
  }

  projectFileRenderable(projectIdInput: string, fileRefInput: string): RendererDto {
    return this.#projectFileRenderable(projectIdInput, fileRefInput, false);
  }

  projectFileWorkbenchRenderable(projectIdInput: string, fileRefInput: string): RendererDto {
    return this.#projectFileRenderable(projectIdInput, fileRefInput, true);
  }

  #projectFileRenderable(projectIdInput: string, fileRefInput: string, allowSafeHtml: boolean): RendererDto {
    const projectId = boundedId(projectIdInput);
    const fileRef = boundedId(fileRefInput);
    try {
      const file = this.store.listObjectFiles({ kind: "project", id: projectId })
        .filter((candidate) => candidate.kind === "project_model_snapshot")
        .find((candidate) => projectFileRef(projectId, candidate) === fileRef);
      if (!file) {
        throw new ApiError(404, "resource_not_found", "The Project file does not exist.");
      }
      const renderable = (allowSafeHtml ? workbenchRendererDto : rendererDto)({
        title: projectLogicalPath(file.relativePath),
        mediaType: file.mediaType,
        sizeBytes: file.sizeBytes,
        sha256: file.sha256,
        bytes: this.store.readObjectFile(file.id),
      });
      return renderable;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof RendererRegistryError) {
        throw new ApiError(422, error.code, error.message);
      }
      throw storeApiError(error);
    }
  }

  getRun(projectIdInput: string, runIdInput: string): ProjectRunDto {
    const projectId = boundedId(projectIdInput);
    const runId = boundedId(runIdInput);
    try {
      const run = this.store.getRun(projectId, runId, { includeTrashed: true });
      const execution = validateExecutionDescriptionV2(
        this.store.getProject(projectId, { includeTrashed: true }).executionDescription,
      );
      return publicRun(
        run,
        run.status === "succeeded" ? this.store.listRunOutputs(run.id) : [],
        run.contractVersion === 4
          ? this.store.currentRunLifecycleBinding(projectId, runId)
          : undefined,
        execution,
      );
    } catch (error) { throw storeApiError(error); }
  }

  listRunOutputs(projectIdInput: string, runIdInput: string): {
    outputs: RunOutputAccessDto[];
  } {
    const projectId = boundedId(projectIdInput);
    const runId = boundedId(runIdInput);
    try {
      const project = this.store.getProject(projectId);
      if (project.lifecycleState === "trashed") {
        throw new ApiError(404, "output_not_found", "The requested output was not found.");
      }
      const run = this.store.getRun(projectId, runId);
      if (run.contractVersion !== 4 || run.status !== "succeeded") {
        throw new ApiError(409, "output_not_available",
          "Outputs are available only for a successful current-contract run.");
      }
      const records = this.store.listRunOutputs(runId);
      if (records.some((record) => record.contractVersion !== 4)) {
        throw new ApiError(409, "output_not_available",
          "Outputs are unavailable for this run contract.");
      }
      return {
        outputs: records.map((record) =>
          publicOutputAccess(record as Extract<OutputIndexRecord, { contractVersion: 4 }>)),
      };
    } catch (error) {
      throw outputApiError(error);
    }
  }

  runOutputRenderable(
    projectIdInput: string,
    runIdInput: string,
    outputIdInput: string,
  ): RendererDto {
    const projectId = boundedId(projectIdInput);
    const runId = boundedId(runIdInput);
    const outputId = boundedId(outputIdInput);
    try {
      this.listRunOutputs(projectId, runId);
      const output = this.store.listRunOutputs(runId).find((candidate) => candidate.id === outputId);
      if (!output || output.contractVersion !== 4) {
        throw new ApiError(404, "output_not_found", "The requested output was not found.");
      }
      return rendererDto({
        title: output.logicalName,
        mediaType: output.file.mediaType,
        sizeBytes: output.file.sizeBytes,
        sha256: output.file.sha256,
        bytes: this.store.readObjectFile(output.file.id),
      });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof RendererRegistryError) {
        throw new ApiError(422, error.code, error.message);
      }
      throw outputApiError(error);
    }
  }

  openRunOutputDownload(
    projectIdInput: string,
    runIdInput: string,
    outputIdInput: string,
  ): RunOutputDownload {
    const projectId = boundedId(projectIdInput);
    const runId = boundedId(runIdInput);
    const outputId = boundedId(outputIdInput);
    try {
      const opened = this.store.openRunOutputDownload({
        projectId,
        runId,
        outputId,
      });
      return Object.freeze({
        output: publicOutputAccess(opened.output),
        read: opened.read,
      });
    } catch (error) {
      throw outputApiError(error);
    }
  }

  diagnosticEventCursorBinding(
    projectIdInput: string,
    runIdInput: string,
  ): DiagnosticEventReadBinding {
    const projectId = boundedId(projectIdInput);
    const runId = boundedId(runIdInput);
    try {
      return this.store.diagnosticEventCursorBinding(projectId, runId);
    } catch (error) {
      throw diagnosticEventApiError(error);
    }
  }

  listRunDiagnosticEvents(input: Readonly<{
    projectId: string;
    runId: string;
    afterSequence: number;
    limit: number;
    types: readonly string[];
    sampleIndexes: readonly number[];
    occurredAtFrom: string | null;
    occurredAtTo: string | null;
  }>): Readonly<{
    items: readonly RunDiagnosticEventDto[];
    hasMore: boolean;
    binding: DiagnosticEventReadBinding;
  }> {
    const projectId = boundedId(input.projectId);
    const runId = boundedId(input.runId);
    try {
      const page = this.store.listRunDiagnosticEvents({
        ...input,
        projectId,
        runId,
      });
      return Object.freeze({
        items: Object.freeze(page.items.map((event) => Object.freeze({
          sequence: event.sequence,
          sampleIndex: event.sampleIndex,
          type: event.type,
          occurredAt: event.occurredAt,
          payload: publicDiagnosticEventPayload(event.payload),
        }))),
        hasMore: page.hasMore,
        binding: page.binding,
      });
    } catch (error) {
      throw diagnosticEventApiError(error);
    }
  }

  startRun(input: {
    projectId: string;
    commandId: string;
    experimentConfigId: string;
    completionConversationId?: string;
  }): RunStartDto {
    const projectId = boundedId(input.projectId);
    const commandId = boundedKey(input.commandId, "commandId");
    const experimentConfigId = boundedId(input.experimentConfigId);
    const completionConversationId = input.completionConversationId === undefined
      ? null
      : boundedId(input.completionConversationId);
    const intent = { commandId, projectId, experimentConfigId, completionConversationId };
    try {
      const replayed = this.store.getFrozenRunStartReceipt(intent);
      if (replayed) {
        this.#onRunQueued?.(replayed.runId, false);
        return publicRunStart(replayed);
      }
    } catch (error) { throw storeApiError(error); }

    let project: ProjectRecord;
    let experiment: ExperimentConfigurationRecord;
    try {
      project = this.store.getProject(projectId);
      const found = this.store.listExperimentConfigurations(projectId, {
        includeArchived: true,
        includeTrashed: true,
      }).find((candidate) => candidate.id === experimentConfigId);
      if (!found) throw new ProductStoreV2Error("Experiment configuration does not exist.");
      experiment = found;
    } catch (error) { throw storeApiError(error); }
    if (experiment.contractVersion !== 4) {
      throw new ApiError(409, "legacy_contract_read_only", "Legacy experiment configurations cannot start version-4 runs.");
    }
    if (experiment.lifecycleState !== "active") {
      throw new ApiError(409, "state_conflict", "Only an active experiment configuration can start a run.");
    }
    if (experiment.configuration.runKind === "visual") {
      if (completionConversationId !== null) {
        throw new ApiError(
          422,
          "visual_completion_not_supported",
          "Visual runs do not support conversation completion cards.",
        );
      }
      if (!this.#visualDispatchAvailable) {
        throw new ApiError(
          409,
          "capability_not_available",
          "Visual run dispatch is not available in this runtime.",
        );
      }
    }

    let description;
    try {
      description = validateExecutionDescriptionV2(project.executionDescription);
      assertRunCapabilityV2(description, experiment.configuration.runKind as "batch" | "visual");
    } catch (error) {
      if (error instanceof ExecutionProtocolV2Error) throw new ApiError(409, error.code, error.message);
      throw error;
    }
    const plan = planExperiment({
      configuration: experiment.configuration,
      inputSchema: description.inputs.schema,
      maxSamples: SERVER_RUN_LIMITS.maxSamples,
    });
    try {
      const receipt = this.store.createFrozenRun({
        ...intent,
        runId: stableId("run", `${projectId}:${commandId}`),
        expectedConfigurationDigest: experiment.configurationDigest,
        plan,
        projectSnapshotDigest: project.modelSnapshotDigest,
        executionDescriptionDigest: canonicalDigest(project.executionDescription),
        limits: SERVER_RUN_LIMITS,
        createdAt: this.#now(),
      });
      this.#onRunQueued?.(receipt.runId, false);
      return publicRunStart(receipt);
    } catch (error) { throw storeApiError(error); }
  }

  cancelRun(input: {
    projectId: string;
    runId: string;
    commandId: string;
  }): RunCancelDto {
    const projectId = boundedId(input.projectId);
    const runId = boundedId(input.runId);
    const commandId = boundedKey(input.commandId, "commandId");
    const intent = { projectId, runId, commandId };
    try {
      const replayed = this.store.getFrozenRunCancelReceipt(intent);
      if (replayed) {
        this.#onRunQueued?.(runId, true);
        return replayed;
      }
      const receipt = this.store.cancelRun({ ...intent, requestedAt: this.#now() });
      this.#onRunQueued?.(runId, true);
      return receipt;
    } catch (error) { throw storeApiError(error); }
  }

  trashRun(input: {
    projectId: string;
    runId: string;
    commandId: string;
    expectedLifecycleDigest: string;
    confirmation: {
      action: "trash_run";
      projectId: string;
      runId: string;
      terminalStatus: "succeeded" | "failed" | "cancelled" | "timed_out";
      terminalClosureDigest: string;
    };
    beforeCommit?: () => void;
  }): RunLifecycleCommandReceipt {
    const projectId = boundedId(input.projectId);
    const runId = boundedId(input.runId);
    const commandId = boundedKey(input.commandId, "commandId");
    const expectedLifecycleDigest = boundedDigest(
      input.expectedLifecycleDigest,
      "expectedLifecycleDigest",
    );
    const confirmation = {
      action: input.confirmation.action,
      projectId: boundedId(input.confirmation.projectId),
      runId: boundedId(input.confirmation.runId),
      terminalStatus: input.confirmation.terminalStatus,
      terminalClosureDigest: boundedDigest(
        input.confirmation.terminalClosureDigest,
        "terminalClosureDigest",
      ),
    } as const;
    try {
      return this.store.trashRun({
        projectId,
        runId,
        commandId,
        expectedLifecycleDigest,
        confirmation,
        committedAt: this.#now(),
        ...(input.beforeCommit ? { beforeCommit: input.beforeCommit } : {}),
      });
    } catch (error) {
      throw storeApiError(error);
    }
  }

  restoreRun(input: {
    projectId: string;
    runId: string;
    commandId: string;
    expectedLifecycleDigest: string;
    beforeCommit?: () => void;
  }): RunLifecycleCommandReceipt {
    const projectId = boundedId(input.projectId);
    const runId = boundedId(input.runId);
    const commandId = boundedKey(input.commandId, "commandId");
    const expectedLifecycleDigest = boundedDigest(
      input.expectedLifecycleDigest,
      "expectedLifecycleDigest",
    );
    try {
      return this.store.restoreRun({
        projectId,
        runId,
        commandId,
        expectedLifecycleDigest,
        committedAt: this.#now(),
        ...(input.beforeCommit ? { beforeCommit: input.beforeCommit } : {}),
      });
    } catch (error) {
      throw storeApiError(error);
    }
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
      }), plan);
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
      if (replayed) {
        return publicExperimentConfiguration(replayed, planExperiment({
          configuration: replayed.configuration,
          inputSchema: this.#projectInputSchema(projectId),
          maxSamples: MAX_EXPERIMENT_SAMPLES,
        }));
      }
    } catch (error) { throw storeApiError(error); }
    const plan = configuration === undefined ? undefined : planExperiment({
      configuration,
      inputSchema: this.#projectInputSchema(projectId),
      maxSamples: MAX_EXPERIMENT_SAMPLES,
    });
    try {
      const updated = this.store.updateExperimentV4({
        commandId,
        id: configId,
        projectId,
        expectedConfigurationDigest,
        expectedRecordDigest,
        ...(name === undefined ? {} : { name }),
        ...(configuration === undefined ? {} : { configuration, plan: plan! }),
        updatedAt: this.#now(),
      });
      return publicExperimentConfiguration(updated, planExperiment({
        configuration: updated.configuration,
        inputSchema: this.#projectInputSchema(projectId),
        maxSamples: MAX_EXPERIMENT_SAMPLES,
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
    await this.#requireProviderModel(
      providerId,
      providerModelId,
      this.#workspaceBinding(input.owner),
    );
    try {
      return this.store.createConversation({ id, owner: input.owner, name, providerId, providerModelId, createdAt: this.#now() });
    } catch (error) { throw storeApiError(error); }
  }

  listConversations(
    owner: ConversationOwner,
    lifecycle: "active" | "archived" | "trashed" = "active",
  ): ConversationDto[] {
    assertOwner(owner);
    this.#assertOwnerExists(owner);
    try {
      return this.store.listConversations(owner, {
        includeArchived: lifecycle === "archived",
        includeTrashed: lifecycle === "trashed",
      }).filter((conversation) => conversation.lifecycleState === lifecycle);
    }
    catch (error) { throw storeApiError(error); }
  }

  #pendingTurnBlockers(
    preview: ReturnType<ProductStoreV2["previewPermanentDelete"]>,
  ): Array<{ kind: "agent_turn_active"; id: string }> {
    const conversationIds = preview.records
      .filter((record) => record.table === "conversations")
      .map((record) => String(record.key.id));
    return conversationIds
      .filter((id) => this.#conversationTurnTails.has(id))
      .map((id) => ({ kind: "agent_turn_active" as const, id }));
  }

  getConversation(conversationId: string): ConversationDto {
    try { return this.store.getConversation(boundedId(conversationId)); }
    catch (error) { throw storeApiError(error); }
  }

  listMessages(conversationId: string): ConversationMessageDto[] {
    try { return this.store.listConversationMessages(boundedId(conversationId)); }
    catch (error) { throw storeApiError(error); }
  }

  async changeConversationProvider(input: {
    commandId: string;
    conversationId: string;
    expectedRecordDigest: string;
    providerId: string;
    modelId: string;
  }): Promise<ConversationProviderBindingReceipt> {
    const commandId = boundedKey(input.commandId, "commandId");
    const conversationId = boundedId(input.conversationId);
    const expectedRecordDigest = boundedDigest(
      input.expectedRecordDigest,
      "expectedRecordDigest",
    );
    const providerId = boundedProviderPart(input.providerId, "providerId");
    const providerModelId = boundedProviderPart(input.modelId, "modelId");
    try {
      const replay = this.store.conversationProviderBindingReceipt({
        commandId,
        conversationId,
        expectedRecordDigest,
        providerId,
        providerModelId,
      });
      if (replay) return replay;
    } catch (error) {
      throw storeApiError(error);
    }
    const conversation = this.getConversation(conversationId);
    await this.#requireProviderModel(
      providerId,
      providerModelId,
      this.#workspaceBinding(conversation.owner),
    );
    try {
      return this.store.changeConversationProviderCommand({
        commandId,
        conversationId,
        expectedRecordDigest,
        providerId,
        providerModelId,
        committedAt: this.#now(),
      });
    } catch (error) {
      throw storeApiError(error);
    }
  }

  listAttachments(conversationId: string): ConversationAttachmentDto[] {
    try {
      return this.store.listConversationAttachments(boundedId(conversationId));
    } catch (error) {
      throw storeApiError(error);
    }
  }

  listConversationActivity(conversationId: string): Readonly<{
    skillUses: PublicSkillUseDto[];
    actions: PublicActionRecordDto[];
  }> {
    try {
      const activity = this.store.listConversationActivity(
        boundedId(conversationId),
      );
      return Object.freeze({
        skillUses: activity.skillUses.map((skill) => Object.freeze({
          id: skill.id,
          skillId: skill.skillId,
          skillVersion: skill.skillVersion,
          routingMode: skill.routingMode,
          loadState: skill.loadState,
        })),
        actions: this.publicActionRecords(activity.actions),
      });
    } catch (error) {
      throw storeApiError(error);
    }
  }

  publicActionRecords(
    actions: ReadonlyArray<AgentTurnDto["actions"][number]>,
  ): PublicActionRecordDto[] {
    return actions.map((action) => {
      const mutationReceipt = this.store.publicDirectModelMutationReceipt(
        action.id,
      );
      return Object.freeze({
        id: action.id,
        actionKind: action.actionKind,
        permissionDecision: action.permissionDecision,
        state: action.state,
        errorCode: action.errorCode,
        ...(mutationReceipt ? { mutationReceipt } : {}),
      });
    });
  }

  async conversationRuntime(conversationIdInput: string): Promise<ConversationRuntimeDto> {
    const conversationId = boundedId(conversationIdInput);
    const conversation = this.getConversation(conversationId);
    const activeRecord = this.#activeTurns.get(conversationId);
    const active = activeRecord?.controlState === "terminal" ? undefined : activeRecord;
    const controlsOpen = active?.controlState === "open";
    const latestTurn = this.store.latestAgentTurn(conversationId);
    let upstream: OpenCodeConversationRuntimeSnapshot | null = null;
    if (controlsOpen && active?.externalSessionRef && active.workspace && this.openCode.runtimeSnapshot) {
      try {
        upstream = await this.openCode.runtimeSnapshot(
          active.externalSessionRef,
          active.mcpBound ? conversationId : undefined,
          active.workspace,
        );
        this.#runtimeCache.set(conversationId, upstream);
      } catch {
        // Durable turn state remains authoritative; an unavailable live
        // projection is represented without exposing the upstream error.
      }
    }
    if (!active) upstream = this.#runtimeCache.get(conversationId) ?? null;
    const interactions = controlsOpen ? upstream?.interactions ?? [] : [];
    const tools = upstream?.tools ?? [];
    const goalVerification = active
      ? null
      : publicGoalVerification(latestTurn?.goalVerification ?? null);
    const goalFailure = goalVerification?.disposition === "outcome_unknown"
      ? { code: "agent_outcome_unknown", retryable: false }
      : goalVerification?.disposition === "budget_exhausted"
        ? { code: "agent_budget_exhausted", retryable: false }
        : goalVerification?.disposition === "failed"
          ? { code: "agent_failed", retryable: false }
          : goalVerification?.disposition === "read_only"
            ? latestTurn?.failure ?? { code: "agent_read_only", retryable: true }
            : null;
    const failure = active
      ? upstream?.failureCode
        ? { code: upstream.failureCode, retryable: true }
        : null
      : latestTurn?.failure ?? goalFailure;
    const status: ConversationRuntimeDto["status"] = active
      ? active.controlState === "stopping"
        ? "busy"
        : failure
          ? "failed"
          : interactions.length
            ? "waiting_for_user"
            : tools.some((tool) => tool.status === "pending" || tool.status === "running")
              ? "waiting_for_tool"
              : "busy"
      : goalVerification?.disposition === "needs_user_input"
        ? "waiting_for_user"
        : latestTurn?.state === "failed" || latestTurn?.state === "read_only"
          || goalVerification?.disposition === "outcome_unknown"
          || goalVerification?.disposition === "budget_exhausted"
          || goalVerification?.disposition === "failed"
          || goalVerification?.disposition === "read_only"
          ? "failed"
          : "idle";
    const durableAssistant = !active && !upstream?.assistant
      ? [...this.listMessages(conversationId)].reverse().find((message) => message.role === "assistant")
      : undefined;
    const activity = this.listConversationActivity(conversationId);
    const body = {
      status,
      turnActive: Boolean(controlsOpen),
      activeRequestKey: active?.requestKey ?? latestTurn?.requestKey ?? null,
      assistant: upstream?.assistant ?? (durableAssistant ? {
        status: durableAssistant.status === "failed" ? "error" as const : "complete" as const,
        text: redactRuntimeText(durableAssistant.text),
      } : null),
      tools,
      interactions,
      failure,
      goalVerification,
      scopedMcp: active
        ? upstream?.scopedMcp ?? {
            label: "Riff tools" as const,
            status: active.mcpBound ? "unavailable" as const : "disconnected" as const,
          }
        : { label: "Riff tools" as const, status: "disconnected" as const },
      agent: {
        selected: active?.agentName ?? latestTurn?.agentName ?? null,
      },
      provider: conversation.provider,
      activity,
    };
    return Object.freeze({ revision: canonicalDigest(body), ...body });
  }

  async stopTurn(conversationIdInput: string, requestKeyInput: string): Promise<ConversationRuntimeDto> {
    const conversationId = boundedId(conversationIdInput);
    const requestKey = boundedKey(requestKeyInput, "requestKey");
    const active = this.#activeTurns.get(conversationId);
    if (!active || active.requestKey !== requestKey) {
      throw new ApiError(409, "turn_not_active", "The requested Agent turn is not active.");
    }
    const releaseControl = await this.#acquireTurnControl(active);
    let pending: Promise<AgentTurnResult> | undefined;
    try {
      if (this.#activeTurns.get(conversationId) !== active
        || active.requestKey !== requestKey
        || active.controlState !== "open") {
        throw new ApiError(409, "turn_not_active", "The requested Agent turn is not active.");
      }
      active.controlState = "stopping";
      pending = this.#pendingTurns.get(`${conversationId}\u0000${requestKey}`);
      active.controller.abort(new ApiError(409, "opencode_session_aborted", "The user stopped the target Agent turn."));
      if (active.externalSessionRef && active.workspace) {
        void this.openCode.abort(active.externalSessionRef, active.workspace).catch(() => undefined);
      }
    } finally {
      releaseControl();
    }
    await pending?.catch(() => undefined);
    return this.conversationRuntime(conversationId);
  }

  async retryTurn(input: {
    conversationId: string;
    sourceRequestKey: string;
    requestKey: string;
  }): Promise<AgentTurnResult> {
    const conversationId = boundedId(input.conversationId);
    const sourceRequestKey = boundedKey(input.sourceRequestKey, "sourceRequestKey");
    const requestKey = boundedKey(input.requestKey, "requestKey");
    if (sourceRequestKey === requestKey) {
      throw new ApiError(409, "retry_request_key_reused", "Retry requires a new requestKey.");
    }
    let durable;
    try {
      durable = this.store.retryableAgentTurnInput(conversationId, sourceRequestKey);
    } catch (error) {
      if (error instanceof ProductStoreV2Error && /does not exist/u.test(error.message)) {
        throw new ApiError(404, "turn_not_found", "The source Agent turn does not exist.");
      }
      if (error instanceof ProductStoreV2Error) {
        throw new ApiError(409, "turn_not_retryable", "The source Agent turn is not safely retryable.");
      }
      throw storeApiError(error);
    }
    return this.runTurn({
      conversationId,
      requestKey,
      text: durable.text,
      attachmentIds: durable.attachmentIds,
      ...(durable.agentName ? { agentName: durable.agentName } : {}),
    });
  }

  async resumeTurn(input: {
    conversationId: string;
    requestKey: string;
    interactionId: string;
    response:
      | { kind: "permission"; decision: "once" | "reject" }
      | { kind: "question"; answers: string[][] }
      | { kind: "question"; reject: true };
  }): Promise<ConversationRuntimeDto> {
    const conversationId = boundedId(input.conversationId);
    const requestKey = boundedKey(input.requestKey, "requestKey");
    const interactionId = boundedKey(input.interactionId, "interactionId");
    const active = this.#activeTurns.get(conversationId);
    if (!active || active.requestKey !== requestKey || !active.externalSessionRef || !active.workspace) {
      throw new ApiError(409, "turn_not_waiting", "The requested Agent turn is not waiting for this response.");
    }
    const releaseControl = await this.#acquireTurnControl(active);
    try {
      if (this.#activeTurns.get(conversationId) !== active
        || active.requestKey !== requestKey
        || active.controlState !== "open"
        || active.controller.signal.aborted
        || !active.externalSessionRef
        || !active.workspace) {
        throw new ApiError(409, "turn_not_waiting", "The requested Agent turn is not waiting for this response.");
      }
      if (!this.openCode.runtimeSnapshot) {
        throw new ApiError(503, "opencode_runtime_unavailable", "OpenCode interaction controls are unavailable.");
      }
      const snapshot = await this.openCode.runtimeSnapshot(
        active.externalSessionRef,
        active.mcpBound ? conversationId : undefined,
        active.workspace,
      );
      if (this.#activeTurns.get(conversationId) !== active
        || active.controlState !== "open"
        || active.controller.signal.aborted) {
        throw new ApiError(409, "turn_not_waiting", "The requested Agent turn is not waiting for this response.");
      }
      const pending = snapshot.interactions.find((interaction) => interaction.id === interactionId);
      if (!pending || pending.kind !== input.response.kind) {
        throw new ApiError(409, "interaction_not_pending", "The requested interaction is not pending for this turn.");
      }
      if (input.response.kind === "permission") {
        if (!this.openCode.respondPermission) throw new ApiError(503, "opencode_runtime_unavailable", "OpenCode permission controls are unavailable.");
        await this.openCode.respondPermission(
          active.externalSessionRef,
          interactionId,
          input.response.decision,
          active.workspace,
        );
      } else {
        if (!this.openCode.respondQuestion) throw new ApiError(503, "opencode_runtime_unavailable", "OpenCode question controls are unavailable.");
        await this.openCode.respondQuestion(
          active.externalSessionRef,
          interactionId,
          "reject" in input.response ? { reject: true } : { answers: input.response.answers },
          active.workspace,
        );
      }
    } finally {
      releaseControl();
    }
    return this.conversationRuntime(conversationId);
  }

  createAttachment(input: { commandId: string; conversationId: string; originalName: string; mediaType: string; bytes: Uint8Array; purpose?: string | null }): ConversationAttachmentDto {
    const commandId = boundedKey(input.commandId, "commandId"); const conversationId = boundedId(input.conversationId);
    this.store.getConversation(conversationId);
    if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength < 1 || input.bytes.byteLength > 1_048_576) throw new ApiError(422, "invalid_attachment", "Attachment bytes are empty or too large.");
    const originalName = boundedName(input.originalName, "Attachment name");
    if (/[\\/:]/u.test(originalName) || originalName === "." || originalName === "..") {
      throw new ApiError(
        422,
        "invalid_attachment",
        "Attachment name must be a single safe display name.",
      );
    }
    const mediaType = boundedProviderPart(input.mediaType, "mediaType");
    if (!PUBLIC_ATTACHMENT_MEDIA_TYPES.has(mediaType.toLowerCase())) {
      throw new ApiError(
        422,
        "invalid_attachment",
        "Attachment media type is not supported.",
      );
    }
    const purpose = input.purpose == null ? null : boundedPurpose(input.purpose);
    const attachmentId = stableId("attachment", `${conversationId}:${commandId}`);
    const objectFileId = stableId("file", `attachment:${conversationId}:${commandId}`);
    try {
      const existing = this.store.getConversationAttachment(attachmentId);
      const digest = createHash("sha256").update(input.bytes).digest("hex");
      if (existing.conversationId !== conversationId || existing.originalName !== originalName || existing.mediaType !== mediaType
        || existing.purpose !== purpose || existing.sha256 !== digest) throw new ApiError(409, "idempotency_conflict", "That commandId was already used with different attachment intent.");
      return this.store.listConversationAttachments(conversationId)
        .find((attachment) => attachment.id === attachmentId)!;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof ProductStoreV2Error && !/does not exist/u.test(error.message)) throw storeApiError(error);
    }
    try {
      this.store.createAttachment({ id: attachmentId, objectFileId, conversationId, relativePath: stableId("upload", commandId), originalName,
        mediaType, purpose, bytes: input.bytes, createdAt: this.#now() });
      return this.store.listConversationAttachments(conversationId)
        .find((attachment) => attachment.id === attachmentId)!;
    } catch (error) { throw storeApiError(error); }
  }

  listTemporaryDocuments(conversationId: string): TemporaryDocumentCardDto[] {
    const id = boundedId(conversationId);
    this.store.getConversation(id);
    try {
      return this.store.listTemporaryDocuments(id).map((document) => Object.freeze({
        id: document.id,
        sourceMessageId: document.sourceMessageId,
        name: document.name,
        documentState: document.documentState,
        mediaType: document.mediaType,
        lifecycleState: document.lifecycleState,
        createdAt: document.createdAt,
        updatedAt: document.updatedAt,
      }));
    }
    catch (error) { throw storeApiError(error); }
  }

  runTurn(input: { conversationId: string; requestKey: string; text: string; agentName?: string; attachmentIds?: string[]; visualInteractionConfirmation?: VisualAgentOperation }): Promise<AgentTurnResult> {
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

  async #runTurn(input: { conversationId: string; requestKey: string; text: string; agentName?: string; attachmentIds?: string[]; visualInteractionConfirmation?: VisualAgentOperation }): Promise<AgentTurnResult> {
    const conversationId = boundedId(input.conversationId);
    const requestKey = boundedKey(input.requestKey, "requestKey");
    const text = boundedText(input.text);
    const agentName = input.agentName === undefined ? null : boundedProviderPart(input.agentName, "agentName");
    const conversation = this.getConversation(conversationId);
    if (agentName) await this.#requireAgent(agentName, conversation.owner);
    const attachmentIds = input.attachmentIds ?? [];
    let confirmedOperation: VisualAgentOperation | undefined;
    let visualInteractionMarker: import("./agent-domain.ts").VisualInteractionMarker | undefined;
    if (input.visualInteractionConfirmation !== undefined) {
      if (this.store.getConversation(conversationId).owner.kind !== "project") {
        throw new ApiError(422, "invalid_visual_interaction_confirmation", "The visual interaction confirmation is invalid.");
      }
      try {
        confirmedOperation = normalizeVisualAgentOperation(input.visualInteractionConfirmation);
        if (!("locator" in confirmedOperation)) throw new Error("not interaction");
        const commitment = visualAgentOperationCommitment(confirmedOperation);
        visualInteractionMarker = Object.freeze({ schemaVersion: 1, actionKind: confirmedOperation.kind, locatorKind: confirmedOperation.locator.kind,
          actionCommitmentDigest: commitment.digest, valueDigest: commitment.valueDigest });
      } catch { throw new ApiError(422, "invalid_visual_interaction_confirmation", "The visual interaction confirmation is invalid."); }
    }
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
        ...(agentName ? { agentName } : {}),
        attachmentIds: attachmentIds.map(boundedId),
        ...(visualInteractionMarker ? { visualInteractionMarker } : {}),
        createdAt: this.#now(),
      });
    } catch (error) { throw storeApiError(error); }
    if (turn.state === "complete") return { mode: "live", turn, messages: this.store.listConversationMessages(conversationId) };
    if (turn.state === "failed" || turn.state === "read_only") {
      return { mode: "read_only", reason: asReadOnlyReason(turn.failure?.code), turn, messages: this.store.listConversationMessages(conversationId) };
    }

    const active = {
      requestKey,
      agentName,
      controller: new AbortController(),
      externalSessionRef: null as string | null,
      workspace: null as OpenCodeWorkspaceBinding | null,
      mcpBound: false,
      controlState: "open" as ActiveConversationTurn["controlState"],
      controlTail: Promise.resolve(),
    };
    this.#activeTurns.set(conversationId, active);
    this.#runtimeCache.delete(conversationId);
    let prepared: PreparedAgentTurnRuntime | undefined;
    let scopedRelease: (() => void) | undefined;
    let mcpBound = false;
    let workspace: OpenCodeWorkspaceBinding | undefined;
    try {
      // Resolve/rebuild the exact external session generation before minting a
      // capability. A missing prior session must never leave this turn's tool
      // grant fenced to the retired generation.
      const session = await this.#sessions.ensureSession(
        conversationId,
        this.#contextFor(conversationId, turn.userMessageId),
      );
      if (session.mode === "read_only") {
        const at = this.#now();
        const verification = this.#verifyGoal({
          conversationId,
          requestKey,
          text,
          phase: "read_only",
          intentAuthority: prepared?.intentAuthority ?? goalIntentAuthority(text),
          sessionGeneration: null,
          assistantDelivered: false,
          verifiedAt: at,
        });
        turn = this.store.failAgentTurn(
          conversationId,
          requestKey,
          goalFailureCode(session.reason, verification.disposition),
          goalFailureRetryable(session.retryable, verification.disposition),
          at,
          verification,
        );
        active.controlState = "terminal";
        return { mode: "read_only", reason: session.reason, turn, messages: this.store.listConversationMessages(conversationId) };
      }
      // Use the exact owner binding that admitted/rebuilt this session. Do not
      // independently re-derive a lookalike workspace before binding tools.
      workspace = session.workspace;
      active.externalSessionRef = session.externalSessionRef;
      active.workspace = session.workspace;
      this.#assertTurnControlOpen(conversationId, active);
      prepared = await this.turnRuntime?.prepare({ conversationId, turnId, text, attachmentIds: attachmentIds.map(boundedId), ...(confirmedOperation ? { confirmedVisualInteraction: confirmedOperation } : {}) });
      this.#assertTurnControlOpen(conversationId, active);
      if (prepared && prepared.externalSessionGeneration !== session.generation) {
        throw new ApiError(
          409,
          "opencode_session_generation_changed",
          "The OpenCode session generation changed before capability issuance.",
        );
      }
      if (prepared?.requiresMcp) {
        if (!this.#scopedMcpUrl || !this.openCode.bindScopedMcp || !this.openCode.unbindScopedMcp) {
          throw new ApiError(503, "opencode_mcp_unavailable", "OpenCode cannot bind a scoped MCP server for this Agent turn.");
        }
        scopedRelease = await this.#acquireScopedMcpTurn();
        this.#assertTurnControlOpen(conversationId, active);
        // Keep the OpenCode MCP server name stable for the durable conversation.
        // Only its short-lived capability URL rotates per turn. Some OpenCode
        // runtimes stop advancing a reused session when every turn introduces
        // an entirely new tool namespace.
        await this.openCode.bindScopedMcp(
          conversationId,
          this.#scopedMcpUrl(prepared.capability),
          prepared.allowedTools,
          workspace,
        );
        mcpBound = true;
        active.mcpBound = true;
      }
      const context = this.#contextFor(conversationId, turn.userMessageId, prepared);
      this.#assertTurnControlOpen(conversationId, active);
      const result = await this.#sessions.prompt(
        conversationId,
        context,
        text,
        prepared?.promptAttachments ?? [],
        mcpBound ? conversationId : undefined,
        active.controller.signal,
        prepared?.externalSessionGeneration ?? session.generation,
        agentName ?? undefined,
        mcpBound ? prepared?.allowedTools : undefined,
      );
      if (active.controlState !== "open" || active.controller.signal.aborted) {
        throw new ApiError(
          409,
          "opencode_session_aborted",
          "The user stopped the target Agent turn before durable completion.",
        );
      }
      if (result.mode === "read_only") {
        const at = this.#now();
        const verification = this.#verifyGoal({
          conversationId,
          requestKey,
          text,
          phase: goalFailurePhase(result.reason),
          intentAuthority: prepared?.intentAuthority ?? goalIntentAuthority(text),
          sessionGeneration: prepared?.externalSessionGeneration
            ?? session.generation,
          assistantDelivered: false,
          verifiedAt: at,
        });
        turn = this.store.failAgentTurn(
          conversationId,
          requestKey,
          goalFailureCode(result.reason, verification.disposition),
          goalFailureRetryable(result.retryable, verification.disposition),
          at,
          verification,
        );
        active.controlState = "terminal";
        return { mode: "read_only", reason: asReadOnlyReason(turn.failure?.code), turn, messages: this.store.listConversationMessages(conversationId) };
      }
      const completedAt = this.#now();
      const goalVerification = this.#verifyGoal({
        conversationId,
        requestKey,
        text,
        phase: "idle",
        intentAuthority: prepared?.intentAuthority ?? goalIntentAuthority(text),
        sessionGeneration: result.generation,
        assistantDelivered: true,
        verifiedAt: completedAt,
      });
      turn = this.store.completeAgentTurn({
        conversationId,
        requestKey,
        assistantMessageId: stableId("message", `${conversationId}:${requestKey}:assistant`),
        assistantText: result.assistant.text,
        assistantContent: result.assistant.content,
        contextDigest: result.context.sha256,
        goalVerification,
        completedAt,
      });
      active.controlState = "terminal";
      return { mode: "live", turn, messages: this.store.listConversationMessages(conversationId) };
    } catch (error) {
      const code = error instanceof ApiError ? safeFailureCode(error.code) : "agent_failed";
      try {
        const at = this.#now();
        const verification = this.#verifyGoal({
          conversationId,
          requestKey,
          text,
          phase: goalFailurePhase(code),
          intentAuthority: prepared?.intentAuthority ?? goalIntentAuthority(text),
          sessionGeneration: prepared?.externalSessionGeneration ?? null,
          assistantDelivered: false,
          verifiedAt: at,
        });
        turn = this.store.failAgentTurn(
          conversationId,
          requestKey,
          goalFailureCode(code, verification.disposition),
          goalFailureRetryable(true, verification.disposition),
          at,
          verification,
        );
        active.controlState = "terminal";
      }
      catch { throw storeApiError(error); }
      return { mode: "read_only", reason: asReadOnlyReason(turn.failure?.code), turn, messages: this.store.listConversationMessages(conversationId) };
    } finally {
      if (active.externalSessionRef && active.workspace && this.openCode.runtimeSnapshot) {
        try {
          this.#runtimeCache.set(
            conversationId,
            await this.openCode.runtimeSnapshot(
              active.externalSessionRef,
              active.mcpBound ? conversationId : undefined,
              active.workspace,
            ),
          );
        } catch { /* durable terminal state remains authoritative */ }
      }
      prepared?.release();
      if (mcpBound && prepared && workspace) {
        await this.openCode.unbindScopedMcp?.(conversationId, workspace)
          .catch(() => undefined);
      }
      scopedRelease?.();
      if (active.externalSessionRef && active.workspace) {
        this.openCode.releaseRuntimeBoundary?.(active.externalSessionRef, active.workspace);
      }
      if (this.#activeTurns.get(conversationId) === active) this.#activeTurns.delete(conversationId);
    }
  }

  #workspaceBinding(
    owner: { kind: "model" | "project"; id: string },
  ): OpenCodeWorkspaceBinding {
    return Object.freeze({
      owner: Object.freeze({ ...owner }),
      directory: this.store.ownerWorkspaceRoot(owner),
    });
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

  #verifyGoal(input: Readonly<{
    conversationId: string;
    requestKey: string;
    text: string;
    phase: AgentGoalVerificationInput["phase"];
    intentAuthority: "explicit" | "proposal_only";
    sessionGeneration: number | null;
    assistantDelivered: boolean;
    verifiedAt: string;
  }>) {
    const turn = this.store.latestAgentTurn(input.conversationId);
    if (!turn || turn.requestKey !== input.requestKey) {
      throw new ApiError(
        409,
        "agent_goal_verification_stale",
        "The durable Agent turn changed before goal verification.",
      );
    }
    const evidence = this.store.agentGoalEvidence(
      input.conversationId,
      input.requestKey,
    );
    return verifyAgentGoal({
      phase: input.phase,
      goalText: input.text,
      goalDigest: evidence.goalDigest,
      intentAuthority: goalVerificationIntentAuthority(
        input.text,
        input.intentAuthority,
      ),
      ownerKind: evidence.ownerKind,
      sessionGeneration: input.sessionGeneration,
      assistantDelivered: input.assistantDelivered,
      actions: turn.actions,
      ownerEvidence: {
        stateDigest: evidence.stateDigest,
        runMode: evidence.runMode,
        executionDescriptionValid: evidence.executionDescriptionValid,
        affectedResourcesVerified: evidence.affectedResourcesVerified,
      },
      verifiedAt: input.verifiedAt,
    });
  }

  async #acquireTurnControl(active: ActiveConversationTurn): Promise<() => void> {
    const previous = active.controlTail;
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    active.controlTail = previous.catch(() => undefined).then(() => current);
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
        messageKind: message.messageKind,
        text: message.text,
        content: message.content,
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

  async #requireProviderModel(
    providerId: string,
    modelId: string,
    workspace?: OpenCodeWorkspaceBinding,
  ): Promise<void> {
    let models: OpenCodeProviderModel[];
    try { models = await this.openCode.discoverProviderModels(workspace); }
    catch (error) {
      if (error instanceof ApiError && (error.status === 401 || error.code === "opencode_auth_failed")) throw new ApiError(503, "opencode_auth_failed", "OpenCode provider authentication is unavailable.");
      throw new ApiError(503, "opencode_unavailable", "OpenCode provider discovery is unavailable.");
    }
    const providerExists = models.some((item) => item.providerId === providerId);
    if (!providerExists) throw new ApiError(409, "provider_unavailable", "The selected provider is unavailable.");
    if (!models.some((item) => item.providerId === providerId && item.modelId === modelId)) throw new ApiError(409, "model_unavailable", "The selected provider/model is unavailable.");
  }

  #assertTurnControlOpen(
    conversationId: string,
    active: ActiveConversationTurn,
  ): void {
    if (this.#activeTurns.get(conversationId) !== active
      || active.controlState !== "open"
      || active.controller.signal.aborted) {
      throw new ApiError(
        409,
        "opencode_session_aborted",
        "The user stopped the target Agent turn before the next side effect.",
      );
    }
  }

  async #requireAgent(agentName: string, owner: ConversationOwner): Promise<void> {
    const discovery = await this.discoverAgents(owner);
    if (discovery.mode !== "live") {
      throw new ApiError(503, discovery.reason, "OpenCode Agent discovery is unavailable.");
    }
    if (!discovery.agents.some((agent) => agent.name === agentName)) {
      throw new ApiError(409, "agent_unavailable", "The selected OpenCode Agent is unavailable.");
    }
  }
}

export const publicDiagnosticEventPayload = (
  payload: Record<string, unknown> | readonly unknown[],
): Record<string, unknown> => {
  let nodes = 0;
  let truncated = false;
  const inspect = (value: unknown, depth: number): void => {
    if (truncated) return;
    nodes += 1;
    if (nodes > 2_000 || depth > 12) {
      truncated = true;
      return;
    }
    if (Array.isArray(value)) {
      if (value.length > 256) truncated = true;
      for (const child of value.slice(0, 256)) inspect(child, depth + 1);
    } else if (value && typeof value === "object") {
      const children = Object.values(value);
      if (children.length > 256) truncated = true;
      for (const child of children.slice(0, 256)) inspect(child, depth + 1);
    }
  };
  inspect(payload, 0);
  return Object.freeze({
    schemaVersion: 1,
    disposition: "redacted",
    shape: Array.isArray(payload) ? "array" : "object",
    observedNodeCount: Math.min(nodes, 2_000),
    truncated,
  });
};

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

const publicProjectFile = (
  projectId: string,
  file: StoredObjectMetadata,
): ProjectWorkspaceProjectionDto["files"][number] => ({
  fileRef: projectFileRef(projectId, file),
  relativePath: projectLogicalPath(file.relativePath),
  mediaType: file.mediaType,
  sizeBytes: file.sizeBytes,
  sha256: file.sha256,
  createdAt: file.createdAt,
  readOnly: true,
});

const projectFileRef = (projectId: string, file: StoredObjectMetadata): string =>
  stableId("project_file", canonicalDigest({
    projectId,
    relativePath: file.relativePath,
    sha256: file.sha256,
  }));

const projectLogicalPath = (relativePath: string): string =>
  relativePath.startsWith("model-snapshot/")
    ? relativePath.slice("model-snapshot/".length)
    : relativePath;

const renderGeneratedView = (
  view: GeneratedViewSetRecord["views"][number],
): RendererDto => rendererDto({
  title: view.title,
  mediaType: view.mediaType,
  sizeBytes: Buffer.byteLength(view.payload, "utf8"),
  sha256: view.payloadDigest,
  bytes: Buffer.from(view.payload, "utf8"),
});

const publicModelChangeSet = (
  record: ModelChangeSetRecord,
  currentWorkspaceDigest: string,
): ModelChangeSetDto => ({
  id: record.id,
  baseWorkspaceDigest: record.baseWorkspaceDigest,
  currentWorkspaceDigest,
  changeSetDigest: record.changeSetDigest,
  freshness: record.baseWorkspaceDigest === currentWorkspaceDigest
    ? "fresh"
    : "stale",
  state: record.state,
  createdAt: record.createdAt,
  resolvedAt: record.resolvedAt,
  files: record.files.map((file) => ({
    itemId: file.itemId,
    kind: file.kind,
    relativePath: file.relativePath,
    mediaType: file.mediaType,
    priorSha256: file.expectedPriorSha256,
    proposedSha256: file.proposedSha256,
    proposedText: file.proposedText,
  })),
});

const publicExperimentConfiguration = (
  record: ExperimentConfigurationRecord,
  plan: ExperimentPlan | null = null,
): ExperimentConfigurationDto => record.contractVersion === 4
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
      samplePreview: Object.freeze((plan?.samples ?? []).slice(0, 100)),
      samplePreviewTruncated: (plan?.samples.length ?? 0) > 100,
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

const publicOutputAccess = (
  record: Extract<OutputIndexRecord, { contractVersion: 4 }>,
): RunOutputAccessDto => ({
  id: record.id,
  runId: record.runId,
  sampleIndex: record.sampleIndex,
  sampleId: record.sampleId,
  logicalName: record.logicalName,
  declaredRole: record.declaredRole,
  outputType: record.outputType,
  mediaType: record.file.mediaType,
  sizeBytes: record.file.sizeBytes,
  sha256: record.file.sha256,
  createdAt: record.createdAt,
});

const publicRun = (
  record: RunRecord,
  outputs: OutputIndexRecord[],
  lifecycle?: RunLifecycleBinding,
  execution?: ExecutionDescriptionV2,
): ProjectRunDto => ({
  id: record.id,
  projectId: record.projectId,
  experimentConfigurationId: record.experimentConfigurationId,
  status: record.contractVersion === 4
    && ["queued", "running"].includes(record.status)
    && record.cancelRequestedAt !== null
    ? "cancelling"
    : record.status,
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
  terminalStatus: lifecycle?.terminalStatus ?? null,
  terminalClosureDigest: lifecycle?.terminalClosureDigest ?? null,
  lifecycleDigest: lifecycle?.lifecycleDigest ?? null,
  seedCount: record.contractVersion === 4
    ? new Set(record.samplePlan.map((sample) => sample.seed)
      .filter((seed) => seed !== null && seed !== undefined)).size
    : 0,
  stepOrHorizon: execution?.overview?.stepOrHorizonPointer
    ? publicConfigurationScalar(
        record.frozenConfiguration,
        execution.overview.stepOrHorizonPointer,
      )
    : null,
  durationMs: record.startedAt && record.finishedAt
    ? Math.max(0, Date.parse(record.finishedAt) - Date.parse(record.startedAt))
    : null,
  resourceOverview: record.contractVersion === 4
    ? publicResourceOverview(record.resourceOverview)
    : null,
  outputs: outputs.map(publicOutput),
});

const PUBLIC_RESOURCE_FIELDS = Object.freeze([
  "maxConcurrencyObserved",
  "stdoutBytes",
  "stderrBytes",
  "outputFiles",
  "outputBytes",
  "stdoutTruncated",
  "stderrTruncated",
  "healthVerified",
] as const);

const publicResourceOverview = (
  value: Record<string, unknown> | null,
): Readonly<Record<string, number | boolean>> | null => {
  if (value === null) return null;
  const result: Record<string, number | boolean> = {};
  for (const field of PUBLIC_RESOURCE_FIELDS) {
    const candidate = value[field];
    if (typeof candidate === "boolean") {
      result[field] = candidate;
    } else if (typeof candidate === "number"
      && Number.isSafeInteger(candidate) && candidate >= 0) {
      result[field] = candidate;
    }
  }
  return Object.freeze(result);
};

const publicConfigurationScalar = (
  configuration: Record<string, unknown>,
  pointer: string,
): string | number | null => {
  if (!pointer.startsWith("/") || pointer.length > 1_024) return null;
  let current: unknown = configuration;
  for (const encoded of pointer.slice(1).split("/")) {
    const segment = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!current || typeof current !== "object" || Array.isArray(current)
      || !Object.hasOwn(current, segment)) return null;
    current = (current as Record<string, unknown>)[segment];
  }
  return typeof current === "number" && Number.isFinite(current)
    ? current
    : typeof current === "string" && current.length <= 256
      ? current
      : null;
};

const publicRunStart = (receipt: FrozenRunStartReceipt): RunStartDto => ({
  schemaVersion: 1,
  commandId: receipt.commandId,
  runId: receipt.runId,
  projectId: receipt.projectId,
  experimentConfigId: receipt.experimentConfigId,
  completionConversationId: receipt.completionConversationId,
  status: receipt.status,
  runKind: receipt.runKind,
  sampleCount: receipt.sampleCount,
  createdAt: receipt.createdAt,
});

const stableId = (prefix: string, value: string): string => `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
const MAX_EXPERIMENT_SAMPLES = 10_000;
const SERVER_RUN_LIMITS: RunLimitsV1 = Object.freeze({
  schemaVersion: 1,
  wallTimeMs: 300_000,
  startupTimeMs: 30_000,
  terminationGraceMs: 5_000,
  maxStdoutBytes: 1_000_000,
  maxStderrBytes: 1_000_000,
  maxOutputFiles: 256,
  maxOutputBytes: 64_000_000,
  ...PRODUCT_DIAGNOSTIC_EVENT_LIMITS,
  maxSamples: 1_000,
  maxConcurrency: 4,
});
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
const redactRuntimeText = (value: string): string =>
  redactPublicRuntimeText(value).slice(0, 64_000);
const boundedPurpose = (value: string): string => {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > 2_000 || value.includes("\0")) {
    throw new ApiError(422, "invalid_attachment", "Attachment purpose is invalid.");
  }
  return value.trim();
};
const PUBLIC_ATTACHMENT_MEDIA_TYPES = new Set([
  "application/json",
  "application/octet-stream",
  "application/pdf",
  "image/jpeg",
  "image/png",
  "text/csv",
  "text/markdown",
  "text/plain",
]);
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
const publicGoalVerification = (
  receipt: AgentTurnDto["goalVerification"],
): PublicAgentGoalVerification | null => receipt
  ? Object.freeze({
      disposition: receipt.disposition,
      reasonCode: receipt.reasonCode,
      receiptDigest: receipt.receiptDigest,
      evidence: Object.freeze({
        openCodeTerminal: receipt.evidence.openCodeTerminal,
        intentKind: receipt.evidence.intentKind,
        actionCount: receipt.evidence.actionCount,
        terminalActionCount: receipt.evidence.terminalActionCount,
        committedActionCount: receipt.evidence.committedActionCount,
        affectedResourceCount: receipt.evidence.affectedResourceCount,
        ownerStateVerified: receipt.evidence.ownerStateVerified,
        partialEffect: receipt.evidence.partialEffect,
      }),
    })
  : null;

const goalIntentAuthority = (
  text: string,
): "explicit" | "proposal_only" =>
  explicitImperative(text) ? "explicit" : "proposal_only";

const goalFailurePhase = (
  code: string,
): AgentGoalVerificationInput["phase"] => {
  if (code === "opencode_prompt_timeout") return "timeout";
  if (new Set([
    "opencode_session_aborted",
    "opencode_session_generation_changed",
    "interrupted",
  ]).has(code)) return "interrupted";
  if (new Set([
    "opencode_unavailable",
    "opencode_auth_failed",
    "provider_unavailable",
    "model_unavailable",
    "session_validation_failed",
    "session_rebuild_failed",
  ]).has(code)) return "read_only";
  return "failed";
};

const goalFailureCode = (
  fallback: string,
  disposition: AgentGoalDisposition,
): string => disposition === "outcome_unknown"
  ? "agent_outcome_unknown"
  : disposition === "budget_exhausted"
    ? "agent_budget_exhausted"
    : disposition === "read_only"
      ? safeFailureCode(fallback)
      : disposition === "failed"
        ? safeFailureCode(fallback)
        : "agent_failed";

const goalFailureRetryable = (
  fallback: boolean,
  disposition: AgentGoalDisposition,
): boolean => disposition === "outcome_unknown"
  ? false
  : disposition === "budget_exhausted"
    ? false
    : disposition === "needs_user_input"
      ? false
      : fallback;

const asReadOnlyReason = (
  code: string | null | undefined,
): AgentReadOnlyReason | "agent_failed" | "agent_outcome_unknown" | "agent_budget_exhausted" => {
  if (code === "agent_outcome_unknown"
    || code === "agent_budget_exhausted") return code;
  const allowed = new Set<AgentReadOnlyReason>([
    "opencode_unavailable", "opencode_auth_failed", "provider_unavailable", "model_unavailable",
    "session_validation_failed", "session_rebuild_failed", "opencode_session_aborted", "opencode_session_error",
    "opencode_session_generation_changed", "opencode_prompt_timeout",
    "empty_assistant_response",
  ]);
  return code && allowed.has(code as AgentReadOnlyReason) ? code as AgentReadOnlyReason : "agent_failed";
};

const storeApiError = (error: unknown): ApiError => {
  if (error instanceof ApiError) return error;
  if (error instanceof MutationRecoveryError
    && /committed transaction ID cannot be reused/u.test(error.message)) {
    return new ApiError(
      409,
      "idempotency_conflict",
      "That creation command was already committed and permanently retired.",
    );
  }
  if (!(error instanceof ProductStoreV2Error)) return new ApiError(500, "internal_error", "The Agent workspace could not complete the request.");
  if (/does not exist/u.test(error.message)) return new ApiError(404, "resource_not_found", "The requested resource does not exist.");
  if (/^legacy_contract_read_only:/u.test(error.message)) return new ApiError(409, "legacy_contract_read_only", "The legacy execution contract is read-only.");
  if (/^execution_protocol_upgrade_required:/u.test(error.message)) return new ApiError(409, "execution_protocol_upgrade_required", "The copied Project does not have an accepted execution-description v2 contract.");
  if (/^capability_not_declared:/u.test(error.message)) return new ApiError(409, "capability_not_declared", "The copied Project does not declare the requested run capability.");
  if (/^capability_not_available:/u.test(error.message)) return new ApiError(409, "capability_not_available", "The requested run capability is not available in this milestone.");
  if (/^project_snapshot_corrupt:/u.test(error.message)) return new ApiError(409, "project_snapshot_corrupt", "The copied Project snapshot failed its integrity check.");
  if (/^stale_configuration:/u.test(error.message)) return new ApiError(409, "stale_configuration", "The experiment configuration changed after it was observed.");
  if (/^stale_record:/u.test(error.message)) return new ApiError(409, "stale_record", "The experiment record changed after it was observed.");
  if (/^run_not_terminal:/u.test(error.message)) return new ApiError(409, "run_not_terminal", "Only a terminal run can be moved to trash.");
  if (/^state_conflict:/u.test(error.message)) return new ApiError(409, "state_conflict", "The run lifecycle changed after it was observed.");
  if (/Model change set is stale/u.test(error.message)) return new ApiError(409, "change_set_stale", "The Model changed after this change set was proposed.");
  if (/Model mutation command ID was reused|change-set ID was reused/u.test(error.message)) return new ApiError(409, "idempotency_conflict", "That commandId was already used with different Model-change intent.");
  if (/command already exists with a different intent/u.test(error.message)) return new ApiError(409, "idempotency_conflict", "That commandId was already used with different experiment intent.");
  if (/lifecycle command.*different intent/u.test(error.message)) return new ApiError(409, "idempotency_conflict", "That commandId was already used with a different run-control intent.");
  if (/Agent turn request key was reused with different intent/u.test(error.message)) return new ApiError(409, "idempotency_conflict", "That requestKey was already used with different turn intent.");
  if (/reused|already|different|changed|locked|unexpected number|not active and technically executable/u.test(error.message)) return new ApiError(409, "state_conflict", "The request conflicts with current durable state.");
  if (/invalid|required|must|cannot|outside/u.test(error.message)) return new ApiError(422, "invalid_request", "The request violates the Agent workspace contract.");
  return new ApiError(500, "storage_error", "The Agent workspace store rejected the request.");
};

const outputApiError = (error: unknown): ApiError => {
  if (error instanceof ApiError) return error;
  if (error instanceof ProductStoreV2Error) {
    if (/does not exist/u.test(error.message)) {
      return new ApiError(404, "output_not_found", "The requested output was not found.");
    }
    if (/^output_not_available:/u.test(error.message)) {
      return new ApiError(409, "output_not_available",
        "Outputs are available only for a successful current-contract run.");
    }
  }
  return new ApiError(500, "output_integrity_failed",
    "The output failed its integrity check.");
};

const diagnosticEventApiError = (error: unknown): ApiError => {
  if (error instanceof ApiError) return error;
  if (!(error instanceof ProductStoreV2Error)) {
    return new ApiError(
      500,
      "event_integrity_failed",
      "Diagnostic event integrity verification failed.",
    );
  }
  if (/^events_not_available:/u.test(error.message)) {
    return new ApiError(
      409,
      "events_not_available",
      "Diagnostic events are unavailable for this run.",
    );
  }
  if (/^run_event_query_invalid:/u.test(error.message)) {
    return new ApiError(422, "invalid_request", "The diagnostic event query is invalid.");
  }
  if (/^run_event_integrity_failed:/u.test(error.message)) {
    return new ApiError(
      500,
      "event_integrity_failed",
      "Diagnostic event integrity verification failed.",
    );
  }
  return storeApiError(error);
};
