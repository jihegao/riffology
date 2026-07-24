import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { canonicalDigest, canonicalJsonV2 } from "./canonical-json-v2.ts";
import {
  assertExperimentPlan as assertPlannerPlan,
  planExperiment,
  type ExperimentPlan,
} from "./experiment-planner.ts";
import {
  assertRunCapabilityV2,
  ExecutionProtocolV2Error,
  validateExecutionDescriptionV2,
  type ExecutionDescriptionV2,
} from "./execution-protocol-v2.ts";
import {
  verifyProjectExecutionRootCapability,
  type BatchLaunchManifestBinding,
  type BatchLaunchReceipt,
  type BatchScratchDirectoryIdentity,
  type BatchScratchPlan,
  type DurableBatchScratchLease,
  type RecoveredProcessTerminationReceipt,
  type RecoveredScratchCleanupReceipt,
  type VerifiedProjectExecutionRootCapability,
} from "./generic-batch-supervisor.ts";
import type {
  ActionRecordDto,
  AgentTurnDto,
  ContextSnapshot,
  ConversationDto,
  ConversationMessageDto,
  DurableAgentSessionState,
  ModelFileMutation,
  SkillUseDto,
  StartAgentTurnIntent,
} from "./agent-domain.ts";
import type { DurableConversationRuntime } from "./agent-session-manager.ts";
import type {
  CreateProjectFromModelInput,
  ExperimentConfigurationRecord,
  IsoTimestamp,
  LifecycleState,
  ManagedResourceKind,
  ModelRecord,
  ModelRunMode,
  ModelTechnicalStatus,
  NamedManagedResourceKind,
  ObjectFileKind,
  OutputIndexRecord,
  PermanentDeletePreview,
  ProjectRecord,
  ProcessAttemptRecord,
  ResourceOwner,
  RunAttemptRecord,
  RunScratchLeaseRecord,
  RunRecord,
  RunStatus,
  StoredObjectMetadata,
  TemporaryDocumentState,
} from "./product-domain.ts";
import { MutationCoordinator, type DatabaseMutationStatement, type MutationCoordinatorOptions } from "./mutation-coordinator.ts";
import { ProductObjectStore, sha256, type OwnerPath } from "./object-store.ts";
import {
  openProductDatabase,
  withAtomicBatchSuccessRunContext,
  type ProductDatabase,
} from "./product-schema.ts";
import { createModelWorkspaceCapability } from "./restricted-process.ts";

const DATABASE_NAME = "product.sqlite3";
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/u;
const FILE_KINDS = new Set<ObjectFileKind>(["model_code", "model_environment", "model_visual_asset"]);

export type ProductStoreFaultPoint = "after_staging_root" | "after_schema" | "before_root_publish" | "after_root_publish";
export type ProductStoreV2Options = {
  initFaultInjector?: (point: ProductStoreFaultPoint) => void;
  coordinatorOptions?: MutationCoordinatorOptions;
};

export type InitialModelFile = {
  id: string;
  kind: "model_code" | "model_environment" | "model_visual_asset";
  relativePath: string;
  mediaType: string;
  bytes: Uint8Array;
};

export type CreateModelInput = {
  id: string;
  name: string;
  technicalStatus: ModelTechnicalStatus;
  runMode: ModelRunMode;
  executionDescription: Record<string, unknown>;
  createdAt: IsoTimestamp;
  files: InitialModelFile[];
};

export type CreateConversationInput = {
  id: string;
  owner: Extract<ResourceOwner, { kind: "model" | "project" }>;
  name: string;
  providerId: string;
  providerModelId: string;
  createdAt: IsoTimestamp;
};

export type ConversationListOptions = { includeArchived?: boolean; includeTrashed?: boolean };

export type CompleteAgentTurnInput = {
  conversationId: string;
  requestKey: string;
  assistantMessageId: string;
  assistantContent: unknown;
  assistantText: string;
  contextDigest?: string | null;
  completedAt: IsoTimestamp;
};

export type TechnicalCheckRecord = {
  id: string;
  modelId: string;
  workspaceDigest: string;
  executionDescriptionDigest: string;
  state: "running" | "passed" | "failed" | "cancelled";
  results: Record<string, unknown>;
  limits: Record<string, unknown>;
  startedAt: IsoTimestamp;
  finishedAt: IsoTimestamp | null;
};

export type BindAgentSessionInput = {
  id: string;
  conversationId: string;
  expectedGeneration: number;
  state: Extract<DurableAgentSessionState, "creating" | "available" | "rebuilding">;
  externalSessionRef: string;
  at: IsoTimestamp;
};

export type RecordSkillUseInput = {
  id: string; conversationId: string; turnId: string; skillId: string; skillVersion: string;
  routingMode: "explicit" | "automatic"; catalogDigest: string; instructionDigest: string;
  loadState: "selected" | "loaded" | "failed"; rationale?: string | null; createdAt: IsoTimestamp;
};

export type RecordActionInput = {
  id: string; conversationId: string; turnId: string; actionKind: string; intent: Record<string, unknown>;
  permissionDecision: "pending" | "allowed" | "denied";
  state: "proposed" | "authorized" | "denied" | "failed";
  affectedResources?: unknown[]; errorCode?: string | null; createdAt: IsoTimestamp;
};

export type CreateMessageInput = {
  id: string;
  conversationId: string;
  ordinal: number;
  role: "user" | "assistant" | "system" | "tool";
  status: "streaming" | "complete" | "failed";
  text: string;
  content?: unknown;
  action?: unknown | null;
  createdAt: IsoTimestamp;
};

export type CreateTemporaryDocumentInput = {
  id: string;
  conversationId: string;
  sourceMessageId?: string | null;
  name: string;
  documentState: TemporaryDocumentState;
  mediaType: string;
  content: string;
  transactionId?: string;
  createdAt: IsoTimestamp;
};

export type CreateAttachmentInput = {
  id: string;
  objectFileId: string;
  conversationId: string;
  relativePath: string;
  originalName: string;
  mediaType: string;
  purpose?: string | null;
  bytes: Uint8Array;
  createdAt: IsoTimestamp;
};

export type AdoptAttachmentInput = {
  objectFileId: string;
  owner: Extract<ResourceOwner, { kind: "model" | "project" }>;
  sourceAttachmentId: string;
  relativePath: string;
  purpose: string;
  transactionId?: string;
  createdAt: IsoTimestamp;
};

export type CreateExperimentInput = {
  id: string;
  projectId: string;
  name: string;
  configuration: Record<string, unknown>;
  estimatedSampleCount: number;
  transactionId?: string;
  createdAt: IsoTimestamp;
};

export type UpdateExperimentInput = {
  id: string;
  projectId: string;
  name: string;
  configuration: Record<string, unknown>;
  estimatedSampleCount: number;
  transactionId: string;
  intentDigest: string;
  updatedAt: IsoTimestamp;
};

export type CreateRunInput = {
  id: string;
  projectId: string;
  experimentId: string;
  status: Exclude<RunStatus, "trashed">;
  frozenConfiguration: Record<string, unknown>;
  requestedSampleCount: number;
  createdAt: IsoTimestamp;
};

export type ExperimentConfigurationRecordV4 = ExperimentConfigurationRecord & {
  contractVersion: 4;
  readOnly: false;
  configurationDigest: string;
  sampleCount: number;
};

export const experimentConfigurationRecordDigest = (record: ExperimentConfigurationRecordV4): string => canonicalDigest({
  contractVersion: 4,
  id: record.id,
  projectId: record.projectId,
  name: record.name,
  configurationDigest: record.configurationDigest,
  sampleCount: record.sampleCount,
  lifecycleState: record.lifecycleState,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
});

export type CreateExperimentV4Input = {
  commandId: string;
  id: string;
  projectId: string;
  name: string;
  plan: ExperimentPlan;
  createdAt: IsoTimestamp;
};

export type UpdateExperimentV4Input = {
  commandId: string;
  id: string;
  projectId: string;
  expectedConfigurationDigest: string;
  expectedRecordDigest: string;
  name?: string;
  configuration?: Record<string, unknown>;
  plan?: ExperimentPlan;
  updatedAt: IsoTimestamp;
};

export type ExperimentUpdateIntentV4 = Pick<
  UpdateExperimentV4Input,
  "commandId" | "id" | "projectId" | "expectedConfigurationDigest" | "expectedRecordDigest" | "name" | "configuration"
>;

export type RunLimitsV1 = Readonly<{
  schemaVersion: 1;
  wallTimeMs: number;
  startupTimeMs: number;
  terminationGraceMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  maxOutputFiles: number;
  maxOutputBytes: number;
  maxEventCount: number;
  maxEventBytes: number;
  maxSamples: number;
  maxConcurrency: number;
}>;

export type StartRunIntent = Readonly<{
  commandId: string;
  projectId: string;
  experimentConfigId: string;
  completionConversationId: string | null;
}>;

export type CancelRunIntent = Readonly<{
  commandId: string;
  projectId: string;
  runId: string;
}>;

export type FrozenRunCancelReceipt = Readonly<{
  schemaVersion: 1;
  commandId: string;
  projectId: string;
  runId: string;
  applied: boolean;
  code: "cancellation_requested" | "cancellation_already_requested" | "run_already_terminal";
  status: "cancelling" | "succeeded" | "failed" | "cancelled" | "timed_out" | "trashed";
  cancelRequestedAt: IsoTimestamp | null;
  createdAt: IsoTimestamp;
}>;

export type CancelRunInput = CancelRunIntent & Readonly<{
  requestedAt: IsoTimestamp;
}>;

export type CreateFrozenRunInput = StartRunIntent & Readonly<{
  runId: string;
  expectedConfigurationDigest: string;
  plan: ExperimentPlan;
  projectSnapshotDigest: string;
  executionDescriptionDigest: string;
  limits: RunLimitsV1;
  createdAt: IsoTimestamp;
}>;

export type FrozenRunStartReceipt = Readonly<{
  schemaVersion: 1;
  commandId: string;
  intentDigest: string;
  runId: string;
  projectId: string;
  experimentConfigId: string;
  completionConversationId: string | null;
  status: "queued";
  runKind: "batch" | "visual";
  frozenConfigurationDigest: string;
  samplePlanDigest: string;
  sampleCount: number;
  projectSnapshotDigest: string;
  executionDescriptionDigest: string;
  limitsDigest: string;
  createdAt: IsoTimestamp;
}>;

export type CreateOutputInput = {
  id: string;
  objectFileId: string;
  runId: string;
  relativePath: string;
  logicalName: string;
  outputType: string;
  sampleIndex?: number;
  sampleId?: string;
  declaredRole?: "metric" | "table" | "document" | "data" | "diagnostic";
  mediaType: string;
  bytes: Uint8Array;
  createdAt: IsoTimestamp;
};

export type ClaimedBatchRun = Readonly<{
  run: Extract<RunRecord, { contractVersion: 4 }>;
  attempt: RunAttemptRecord;
}>;

export type RunAttemptIdentity = Readonly<{
  runId: string;
  attemptId: string;
  attemptGeneration: number;
  dispatcherGeneration: string;
}>;

export type BatchProcessIdentity = RunAttemptIdentity & Readonly<{
  processAttemptId: string;
  sampleIndex: number;
  sampleId: string;
  pid: number;
  processStartToken: string;
  processGroupId: number;
  scratchId?: string;
}>;

export type BatchLaunchIdentity = RunAttemptIdentity & BatchScratchPlan;

export type RecoveryProcessRecord = BatchProcessIdentity & Readonly<{
  scratchId: string;
  scratchLease: DurableBatchScratchLease;
  launchManifest: BatchLaunchManifestBinding;
  state: "blocked" | "released" | "running" | "exited" | "cleanup_complete" | "cleanup_unverified";
  exitCode: number | null;
  exitSignal: string | null;
}>;

export type PendingLaunchRecoveryRecord = Readonly<{
  scratchLease: RunScratchLeaseRecord;
  launchManifest: BatchLaunchManifestBinding;
}>;

export type PriorDispatcherRecoveryUnit = Readonly<{
  run: Extract<RunRecord, { contractVersion: 4 }>;
  attempt: RunAttemptRecord;
  processes: readonly RecoveryProcessRecord[];
  scratchLeases: readonly RunScratchLeaseRecord[];
  pendingLaunches: readonly PendingLaunchRecoveryRecord[];
}>;

export type BatchOutputCommit = Readonly<{
  sampleIndex: number;
  sampleId: string;
  logicalName: string;
  outputType: string;
  bytes: Uint8Array;
}>;

export type BatchSuccessCommitReceipt = Readonly<{
  run: Extract<RunRecord, { contractVersion: 4 }>;
  outputs: readonly Extract<OutputIndexRecord, { contractVersion: 4 }>[];
}>;

export type ProjectExecutionCapability = Readonly<{
  workspace: VerifiedProjectExecutionRootCapability;
  executionDescription: ExecutionDescriptionV2;
}>;

type ObjectRow = {
  id: string;
  owner_model_id: string | null;
  owner_project_id: string | null;
  owner_conversation_id: string | null;
  owner_run_id: string | null;
  kind: ObjectFileKind;
  relative_path: string;
  media_type: string;
  size_bytes: number;
  sha256: string;
  source_attachment_id: string | null;
  adoption_purpose: string | null;
  created_at: string;
  run_project_id?: string | null;
};

type ProductDatabaseMutationStatement = DatabaseMutationStatement & {
  mismatchMessage?: string;
};

export class ProductStoreV2Error extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProductStoreV2Error";
  }
}

export class ProductStoreV2 {
  readonly root: string;
  readonly #database: ProductDatabase;
  readonly #objects: ProductObjectStore;
  readonly #coordinator: MutationCoordinator;
  #closed = false;

  static open(root: string): ProductStoreV2 { return this.#open(root, {}); }

  /** @internal Test-only fault surface; production callers must use open(root). */
  static openForTesting(root: string, options: ProductStoreV2Options): ProductStoreV2 { return this.#open(root, options); }

  static #open(root: string, options: ProductStoreV2Options): ProductStoreV2 {
    assertOptions(options);
    const requested = resolve(root);
    const target = existsSync(requested) ? realpathSync(requested) : join(realpathSync(dirname(requested)), basename(requested));
    if (!existsSync(target)) this.#initializeFresh(target, options);
    const objects = new ProductObjectStore(target);
    const database = openProductDatabase(join(target, DATABASE_NAME));
    try {
      const coordinator = new MutationCoordinator(database, objects, options.coordinatorOptions ?? {});
      return new ProductStoreV2(target, database, objects, coordinator);
    } catch (error) {
      database.close();
      throw error;
    }
  }

  static #initializeFresh(target: string, options: ProductStoreV2Options): void {
    const parent = dirname(target);
    assertSecureParent(parent);
    const stage = join(parent, `.${basename(target)}.product-init-${randomUUID().replaceAll("-", "")}`);
    let published = false;
    mkdirSync(stage, { mode: 0o700 });
    syncExternalDirectory(parent);
    try {
      options.initFaultInjector?.("after_staging_root");
      const objects = new ProductObjectStore(stage);
      const database = openProductDatabase(join(stage, DATABASE_NAME));
      try {
        const coordinator = new MutationCoordinator(database, objects);
        coordinator.close();
      } finally { database.close(); }
      options.initFaultInjector?.("after_schema");
      if (existsSync(target)) throw new ProductStoreV2Error("Product storage root appeared during initialization.");
      options.initFaultInjector?.("before_root_publish");
      renameSync(stage, target);
      published = true;
      syncExternalDirectory(parent);
      options.initFaultInjector?.("after_root_publish");
    } catch (error) {
      if (!published && existsSync(stage)) removeExactFreshStage(stage);
      syncExternalDirectory(parent);
      throw error;
    }
  }

  private constructor(root: string, database: ProductDatabase, objects: ProductObjectStore, coordinator: MutationCoordinator) {
    this.root = root;
    this.#database = database;
    this.#objects = objects;
    this.#coordinator = coordinator;
    try { this.#reconcileInterruptedAgentState(); }
    catch (error) { coordinator.close(); throw error; }
  }

  close(): void {
    if (this.#closed) return;
    this.#coordinator.close();
    this.#database.close();
    this.#closed = true;
  }

  createModel(input: CreateModelInput): ModelRecord {
    this.#assertOpen();
    assertId(input.id);
    if (!input.files.length) throw new ProductStoreV2Error("A Model requires at least one initial owned file.");
    const owner = { kind: "model" as const, id: input.id };
    const files = input.files.map((file) => {
      assertId(file.id);
      if (!FILE_KINDS.has(file.kind)) throw new ProductStoreV2Error("Initial Model file kind is invalid.");
      const relativePath = modelFilePath(file.kind, file.relativePath);
      const bytes = Buffer.from(file.bytes);
      return { file, bytes, relativePath, digest: sha256(bytes), target: { owner, relativePath } satisfies OwnerPath };
    });
    const existing = this.#database.prepare("SELECT * FROM models WHERE id = ?").get(input.id) as any;
    if (existing) {
      const initialRows = this.#objectRows("owner_model_id = ? AND kind IN ('model_code', 'model_environment', 'model_visual_asset')", [input.id]).sort(compareObjectRows);
      initialRows.forEach((row) => this.#verifiedMetadata(row));
      const matches = existing.name === input.name && existing.technical_status === input.technicalStatus && existing.run_mode === input.runMode
        && existing.execution_description_json === json(input.executionDescription) && existing.created_at === input.createdAt
        && initialRows.length === files.length && files.every(({ file, bytes, relativePath, digest }) => {
          const row = initialRows.find((candidate) => candidate.id === file.id);
          return row?.kind === file.kind && row.relative_path === relativePath && row.media_type === file.mediaType
            && row.size_bytes === bytes.byteLength && row.sha256 === digest;
        });
      if (!matches) throw new ProductStoreV2Error("Model ID already exists with a different creation intent.");
      return modelRecord(existing);
    }
    const statements: DatabaseMutationStatement[] = [{
      sql: `INSERT INTO models
        (id, name, technical_status, run_mode, execution_description_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
      params: [input.id, input.name, input.technicalStatus, input.runMode, json(input.executionDescription), input.createdAt, input.createdAt],
      expectedChanges: 1,
    }, ...files.map(({ file, bytes, relativePath, digest }) => objectInsert({
      id: file.id, owner, kind: file.kind, relativePath, mediaType: file.mediaType,
      sizeBytes: bytes.byteLength, digest, createdAt: input.createdAt,
    }))];
    this.#coordinator.execute({ transactionId: stableTransactionId("create_model", input.id), files: files.map(({ target, bytes }) => ({ operation: "write" as const, target, bytes, expectedPriorSha256: null })), statements });
    return this.#model(input.id);
  }

  createProjectFromModel(input: CreateProjectFromModelInput): ProjectRecord {
    this.#assertOpen();
    assertId(input.projectId);
    const existing = this.#database.prepare("SELECT * FROM projects WHERE id = ?").get(input.projectId) as any;
    if (existing) {
      if (existing.name !== input.projectName || existing.source_model_id !== input.sourceModelId || existing.created_at !== input.createdAt) {
        throw new ProductStoreV2Error("Project ID already exists with a different creation intent.");
      }
      this.#verifyFrozenProject(existing);
      return projectRecord(existing);
    }
    const source = this.#database.prepare(`SELECT id, lifecycle_state, technical_status, execution_description_json
      , updated_at FROM models WHERE id = ?`).get(input.sourceModelId) as { id: string; lifecycle_state: LifecycleState; technical_status: ModelTechnicalStatus; execution_description_json: string; updated_at: string } | undefined;
    if (!source) throw new ProductStoreV2Error("Source Model does not exist.");
    if (source.technical_status !== "executable" || source.lifecycle_state !== "active") throw new ProductStoreV2Error("Source Model is not active and technically executable.");
    const sourceRows = this.#objectRows("owner_model_id = ?", [input.sourceModelId])
      .filter((row) => ["model_code", "model_environment", "model_visual_asset", "adopted_attachment"].includes(row.kind))
      .sort(compareObjectRows);
    if (!sourceRows.length) throw new ProductStoreV2Error("Source Model has no eligible snapshot files.");
    const owner = { kind: "project" as const, id: input.projectId };
    const copies = sourceRows.map((row) => {
      const sourceTarget = ownerPath(row);
      const inspected = this.#objects.readWithInspection(sourceTarget);
      if (!inspected || inspected.sha256 !== row.sha256 || inspected.sizeBytes !== row.size_bytes) throw new ProductStoreV2Error("Source Model file metadata or bytes drifted.");
      const relativePath = `model-snapshot/${row.relative_path}`;
      return {
        id: `file_${canonicalDigest({ projectId: input.projectId, sourceFileId: row.id }).slice(0, 32)}`,
        sourceRow: row,
        bytes: inspected.bytes,
        relativePath,
        mediaType: row.media_type,
        digest: inspected.sha256,
        target: { owner, relativePath } satisfies OwnerPath,
      };
    });
    const snapshotDigest = canonicalDigest(copies.map(({ relativePath, mediaType, bytes, digest }) => ({
      relativePath, mediaType, sizeBytes: bytes.byteLength, sha256: digest,
    })).sort((left, right) => compareStrings(left.relativePath, right.relativePath)));
    const statements: DatabaseMutationStatement[] = [{
      sql: `UPDATE models SET updated_at = updated_at WHERE id = ? AND lifecycle_state = 'active'
        AND technical_status = 'executable' AND execution_description_json = ? AND updated_at = ?`,
      params: [source.id, source.execution_description_json, source.updated_at], expectedChanges: 1,
    }, {
      sql: `UPDATE object_files SET size_bytes = size_bytes WHERE owner_model_id = ?
        AND kind IN ('model_code', 'model_environment', 'model_visual_asset', 'adopted_attachment')`,
      params: [source.id], expectedChanges: sourceRows.length,
    }, ...copies.map(({ sourceRow }) => ({
      sql: `UPDATE object_files SET size_bytes = size_bytes WHERE id = ? AND owner_model_id = ? AND kind = ?
        AND relative_path = ? AND media_type = ? AND size_bytes = ? AND sha256 = ?`,
      params: [sourceRow.id, source.id, sourceRow.kind, sourceRow.relative_path, sourceRow.media_type, sourceRow.size_bytes, sourceRow.sha256], expectedChanges: 1,
    } satisfies DatabaseMutationStatement)), {
      sql: `INSERT INTO projects
        (id, name, source_model_id, model_snapshot_digest, execution_description_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
      params: [input.projectId, input.projectName, input.sourceModelId, snapshotDigest, source.execution_description_json, input.createdAt, input.createdAt],
      expectedChanges: 1,
    }, ...copies.map((copy) => objectInsert({
      id: copy.id, owner, kind: "project_model_snapshot", relativePath: copy.relativePath,
      mediaType: copy.mediaType, sizeBytes: copy.bytes.byteLength, digest: copy.digest, createdAt: input.createdAt,
    }))];
    this.#coordinator.execute({
      transactionId: stableTransactionId("create_project", input.projectId),
      files: copies.map(({ target, bytes }) => ({ operation: "write" as const, target, bytes, expectedPriorSha256: null })),
      statements,
    });
    return this.#project(input.projectId);
  }

  createConversation(input: CreateConversationInput): ConversationDto {
    assertId(input.id);
    this.#databaseMutation([activeOwnerGuard(input.owner), {
      sql: `INSERT INTO conversations
        (id, model_id, project_id, name, provider_id, provider_model_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [input.id, input.owner.kind === "model" ? input.owner.id : null, input.owner.kind === "project" ? input.owner.id : null,
        input.name, input.providerId, input.providerModelId, input.createdAt, input.createdAt], expectedChanges: 1,
    }]);
    return this.getConversation(input.id);
  }

  listConversations(owner: Extract<ResourceOwner, { kind: "model" | "project" }>, options: ConversationListOptions = {}): ConversationDto[] {
    this.#assertOpen();
    const column = owner.kind === "model" ? "model_id" : "project_id";
    return (this.#database.prepare(`SELECT c.* FROM conversations c WHERE c.${column} = ? ORDER BY c.updated_at DESC, c.id`).all(owner.id) as any[])
      .map((row) => conversationDto(row, this.#sessionProjection(row.id)))
      .filter((row) => visible(row.lifecycleState, options));
  }

  getConversation(id: string): ConversationDto {
    this.#assertOpen();
    const row = this.#database.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as any;
    if (!row) throw new ProductStoreV2Error("Conversation does not exist.");
    return conversationDto(row, this.#sessionProjection(id));
  }

  listConversationMessages(conversationId: string): ConversationMessageDto[] {
    this.#assertOpen();
    if (!this.#database.prepare("SELECT 1 FROM conversations WHERE id = ?").get(conversationId)) throw new ProductStoreV2Error("Conversation does not exist.");
    return (this.#database.prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY ordinal").all(conversationId) as any[]).map(messageDto);
  }

  changeConversationProvider(conversationId: string, providerId: string, providerModelId: string, updatedAt: IsoTimestamp): ConversationDto {
    this.#databaseMutation([{ sql: `UPDATE conversations SET provider_id = ?, provider_model_id = ?, updated_at = ?
      WHERE id = ? AND lifecycle_state = 'active' AND provider_locked_at IS NULL`, params: [providerId, providerModelId, updatedAt, conversationId], expectedChanges: 1 }]);
    return this.getConversation(conversationId);
  }

  startAgentTurn(input: StartAgentTurnIntent): AgentTurnDto {
    this.#assertOpen();
    assertId(input.turnId); assertId(input.userMessageId);
    if (!input.requestKey.trim() || input.requestKey.length > 300 || !input.text.trim()) throw new ProductStoreV2Error("Agent turn intent is invalid.");
    const attachmentIds = [...new Set(input.attachmentIds ?? [])];
    if (attachmentIds.length !== (input.attachmentIds ?? []).length) throw new ProductStoreV2Error("Agent turn attachment IDs must be unique.");
    const intentDigest = canonicalDigest({ text: input.text, attachmentIds });
    const existing = this.#database.prepare("SELECT * FROM agent_turns WHERE conversation_id = ? AND request_key = ?")
      .get(input.conversationId, input.requestKey) as any;
    if (existing) {
      if (existing.id !== input.turnId || existing.input_message_id !== input.userMessageId || existing.intent_sha256 !== intentDigest) {
        throw new ProductStoreV2Error("Agent turn request key was reused with different intent.");
      }
      return this.#agentTurn(input.conversationId, input.requestKey);
    }
    const conversation = this.#database.prepare("SELECT model_id, project_id FROM conversations WHERE id = ?").get(input.conversationId) as { model_id: string | null; project_id: string | null } | undefined;
    if (!conversation) throw new ProductStoreV2Error("Conversation does not exist.");
    const owner = conversation.model_id ? { kind: "model" as const, id: conversation.model_id } : { kind: "project" as const, id: conversation.project_id! };
    this.#databaseMutation([
      activeOwnerGuard(owner),
      { sql: `UPDATE conversations SET provider_locked_at = coalesce(provider_locked_at, ?), updated_at = ?
        WHERE id = ? AND lifecycle_state = 'active'`, params: [input.createdAt, input.createdAt, input.conversationId], expectedChanges: 1 },
      { sql: `INSERT INTO messages (id, conversation_id, ordinal, role, status, text, content_json, created_at, updated_at)
        SELECT ?, ?, count(*), 'user', 'complete', ?, '{}', ?, ? FROM messages WHERE conversation_id = ?`,
        params: [input.userMessageId, input.conversationId, input.text, input.createdAt, input.createdAt, input.conversationId], expectedChanges: 1 },
      ...attachmentIds.map((attachmentId) => ({ sql: `INSERT INTO message_attachments (message_id, attachment_id)
        SELECT ?, id FROM attachments WHERE id = ? AND conversation_id = ?`, params: [input.userMessageId, attachmentId, input.conversationId], expectedChanges: 1 } satisfies DatabaseMutationStatement)),
      { sql: `INSERT INTO agent_turns (id, conversation_id, request_key, intent_sha256, input_message_id, state, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'running', ?, ?)`, params: [input.turnId, input.conversationId, input.requestKey, intentDigest, input.userMessageId, input.createdAt, input.createdAt], expectedChanges: 1 },
    ]);
    return this.#agentTurn(input.conversationId, input.requestKey);
  }

  completeAgentTurn(input: CompleteAgentTurnInput): AgentTurnDto {
    this.#assertOpen(); assertId(input.assistantMessageId);
    const turn = this.#database.prepare("SELECT * FROM agent_turns WHERE conversation_id = ? AND request_key = ?").get(input.conversationId, input.requestKey) as any;
    if (!turn) throw new ProductStoreV2Error("Agent turn does not exist.");
    const contentJson = json(input.assistantContent);
    if (turn.state === "complete") {
      const message = this.#database.prepare("SELECT text, content_json FROM messages WHERE id = ? AND conversation_id = ?").get(turn.assistant_message_id, input.conversationId) as any;
      if (turn.assistant_message_id !== input.assistantMessageId || message?.text !== input.assistantText || message?.content_json !== contentJson) {
        throw new ProductStoreV2Error("Completed Agent turn retry differs from the durable result.");
      }
      return this.#agentTurn(input.conversationId, input.requestKey);
    }
    if (input.contextDigest != null && !/^[0-9a-f]{64}$/u.test(input.contextDigest)) throw new ProductStoreV2Error("Context digest is invalid.");
    this.#databaseMutation([
      activeLifecycleGuard("conversations", input.conversationId),
      { sql: `INSERT INTO messages (id, conversation_id, ordinal, role, status, text, content_json, created_at, updated_at)
        SELECT ?, ?, count(*), 'assistant', 'complete', ?, ?, ?, ? FROM messages WHERE conversation_id = ?`,
        params: [input.assistantMessageId, input.conversationId, input.assistantText, contentJson, input.completedAt, input.completedAt, input.conversationId], expectedChanges: 1 },
      { sql: `UPDATE agent_turns SET state = 'complete', assistant_message_id = ?, reconstructed_context_sha256 = ?, updated_at = ?
        WHERE conversation_id = ? AND request_key = ? AND state = 'running'`,
        params: [input.assistantMessageId, input.contextDigest ?? null, input.completedAt, input.conversationId, input.requestKey], expectedChanges: 1 },
    ]);
    return this.#agentTurn(input.conversationId, input.requestKey);
  }

  failAgentTurn(conversationId: string, requestKey: string, code: string, retryable: boolean, at: IsoTimestamp): AgentTurnDto {
    if (!code.trim() || code.length > 200) throw new ProductStoreV2Error("Agent turn failure code is invalid.");
    const existing = this.#database.prepare("SELECT state, failure_code, failure_retryable FROM agent_turns WHERE conversation_id = ? AND request_key = ?").get(conversationId, requestKey) as any;
    if (existing?.state === "failed") {
      if (existing.failure_code !== code || Boolean(existing.failure_retryable) !== retryable) throw new ProductStoreV2Error("Failed Agent turn retry differs from durable result.");
      return this.#agentTurn(conversationId, requestKey);
    }
    this.#databaseMutation([{ sql: `UPDATE agent_turns SET state = 'failed', failure_code = ?, failure_retryable = ?, updated_at = ?
      WHERE conversation_id = ? AND request_key = ? AND state IN ('queued', 'running')`, params: [code, retryable ? 1 : 0, at, conversationId, requestKey], expectedChanges: 1 }]);
    return this.#agentTurn(conversationId, requestKey);
  }

  createMessage(input: CreateMessageInput): void {
    this.#databaseMutation([activeLifecycleGuard("conversations", input.conversationId),
      ...(input.role === "user" ? [{ sql: `UPDATE conversations SET provider_locked_at = coalesce(provider_locked_at, ?)
        WHERE id = ? AND lifecycle_state = 'active'`, params: [input.createdAt, input.conversationId], expectedChanges: 1 } satisfies DatabaseMutationStatement] : []), {
      sql: `INSERT INTO messages
        (id, conversation_id, ordinal, role, status, text, content_json, action_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [input.id, input.conversationId, input.ordinal, input.role, input.status, input.text, json(input.content ?? {}), input.action === null || input.action === undefined ? null : json(input.action), input.createdAt, input.createdAt],
      expectedChanges: 1,
    }]);
  }

  createTemporaryDocument(input: CreateTemporaryDocumentInput): void {
    const statements = [activeLifecycleGuard("conversations", input.conversationId), {
      sql: `INSERT INTO temporary_documents
        (id, conversation_id, source_message_id, name, document_state, media_type, content, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [input.id, input.conversationId, input.sourceMessageId ?? null, input.name, input.documentState, input.mediaType, input.content, input.createdAt, input.createdAt],
      expectedChanges: 1,
    }];
    if (input.transactionId) this.#databaseMutation([...statements, {
      sql: "INSERT INTO committed_mutations (transaction_id, manifest_sha256, committed_at) VALUES (?, ?, ?)",
      params: [input.transactionId, sha256(Buffer.from(`database-only:${input.transactionId}`, "utf8")), input.createdAt],
      expectedChanges: 1,
    }]);
    else this.#databaseMutation(statements);
  }

  transitionTemporaryDocument(documentId: string, nextState: Exclude<TemporaryDocumentState, "draft">, actionRecordIds: string[], at: IsoTimestamp): void {
    this.#assertOpen();
    const row = this.#database.prepare("SELECT conversation_id FROM temporary_documents WHERE id = ?").get(documentId) as { conversation_id: string } | undefined;
    if (!row) throw new ProductStoreV2Error("Temporary document does not exist.");
    if (nextState === "adopted" && actionRecordIds.length === 0) throw new ProductStoreV2Error("Adopted document requires action evidence.");
    if (nextState !== "adopted" && actionRecordIds.length !== 0) throw new ProductStoreV2Error("Only adoption can bind action evidence.");
    if (new Set(actionRecordIds).size !== actionRecordIds.length) throw new ProductStoreV2Error("Document action evidence must be unique.");
    this.#databaseMutation([
      activeLifecycleGuard("conversations", row.conversation_id),
      { sql: `UPDATE temporary_documents SET document_state = ?, updated_at = ? WHERE id = ? AND document_state = 'draft' AND lifecycle_state = 'active'`,
        params: [nextState, at, documentId], expectedChanges: 1 },
      ...actionRecordIds.map((actionId) => ({ sql: `INSERT INTO temporary_document_adoptions (document_id, action_record_id, created_at)
        SELECT ?, a.id, ? FROM action_records a WHERE a.id = ? AND a.conversation_id = ? AND a.state = 'committed'`,
        params: [documentId, at, actionId, row.conversation_id], expectedChanges: 1 } satisfies DatabaseMutationStatement)),
    ]);
  }

  bindAgentSession(input: BindAgentSessionInput): { generation: number; state: DurableAgentSessionState } {
    this.#assertOpen(); assertId(input.id);
    if (!Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 0 || !input.externalSessionRef) throw new ProductStoreV2Error("Agent session binding is invalid.");
    const conversation = this.#database.prepare("SELECT provider_id, provider_model_id, provider_locked_at FROM conversations WHERE id = ? AND lifecycle_state = 'active'")
      .get(input.conversationId) as { provider_id: string; provider_model_id: string; provider_locked_at: string | null } | undefined;
    if (!conversation?.provider_locked_at) throw new ProductStoreV2Error("Agent session requires a provider-locked active conversation.");
    const prior = this.#database.prepare("SELECT id, generation, state FROM agent_sessions WHERE conversation_id = ? AND state != 'closed'").get(input.conversationId) as any;
    if ((prior?.generation ?? 0) !== input.expectedGeneration) throw new ProductStoreV2Error("Agent session generation changed.");
    const generation = input.expectedGeneration + 1;
    this.#databaseMutation([
      ...(prior ? [{ sql: "UPDATE agent_sessions SET state = 'closed', updated_at = ? WHERE id = ? AND generation = ? AND state != 'closed'", params: [input.at, prior.id, input.expectedGeneration], expectedChanges: 1 } satisfies DatabaseMutationStatement] : []),
      { sql: `INSERT INTO agent_sessions (id, conversation_id, generation, state, provider_id, provider_model_id, external_session_ref, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, params: [input.id, input.conversationId, generation, input.state, conversation.provider_id, conversation.provider_model_id, input.externalSessionRef, input.at, input.at], expectedChanges: 1 },
    ]);
    return { generation, state: input.state };
  }

  /** Backend-only runtime read. Never pass its session reference into an HTTP DTO. */
  async getConversationRuntime(conversationId: string): Promise<DurableConversationRuntime | null> {
    this.#assertOpen();
    const row = this.#database.prepare("SELECT * FROM conversations WHERE id = ? AND lifecycle_state = 'active' AND provider_locked_at IS NOT NULL").get(conversationId) as any;
    if (!row) return null;
    const session = this.#database.prepare("SELECT generation, state, external_session_ref FROM agent_sessions WHERE conversation_id = ? ORDER BY generation DESC LIMIT 1")
      .get(conversationId) as any;
    return {
      conversationId,
      owner: row.model_id ? { kind: "model", id: row.model_id } : { kind: "project", id: row.project_id },
      providerId: row.provider_id,
      providerModelId: row.provider_model_id,
      session: session ? { generation: session.generation, state: session.state, externalSessionRef: session.external_session_ref } : null,
    };
  }

  assertActiveAgentToolGrant(input: { conversationId: string; turnId: string; externalSessionGeneration: number }): void {
    this.#assertOpen();
    const turn = this.#database.prepare("SELECT state FROM agent_turns WHERE id = ? AND conversation_id = ?")
      .get(input.turnId, input.conversationId) as { state: string } | undefined;
    if (turn?.state !== "running") throw new ProductStoreV2Error("Agent tool grant turn is no longer active.");
    const session = this.#database.prepare("SELECT generation, state FROM agent_sessions WHERE conversation_id = ? ORDER BY generation DESC LIMIT 1")
      .get(input.conversationId) as { generation: number; state: DurableAgentSessionState } | undefined;
    if (session?.state !== "available" || session.generation !== input.externalSessionGeneration) {
      throw new ProductStoreV2Error("Agent tool grant session generation is no longer active.");
    }
  }

  async markSessionLost(input: { conversationId: string; generation: number; expectedExternalSessionRef: string; reason: string }): Promise<void> {
    if (!input.reason.trim() || input.reason.length > 200) throw new ProductStoreV2Error("Agent session failure reason is invalid.");
    this.#databaseMutation([{ sql: `UPDATE agent_sessions SET state = 'lost', failure_reason = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE conversation_id = ? AND generation = ? AND state = 'available' AND external_session_ref = ?`,
      params: [input.reason, input.conversationId, input.generation, input.expectedExternalSessionRef], expectedChanges: 1 }]);
  }

  async beginSessionGeneration(input: { conversationId: string; expectedGeneration: number | null }): Promise<{ generation: number }> {
    this.#assertOpen();
    const conversation = this.#database.prepare("SELECT provider_id, provider_model_id, provider_locked_at FROM conversations WHERE id = ? AND lifecycle_state = 'active'")
      .get(input.conversationId) as { provider_id: string; provider_model_id: string; provider_locked_at: string | null } | undefined;
    if (!conversation?.provider_locked_at) throw new ProductStoreV2Error("Agent session requires a provider-locked active conversation.");
    const prior = this.#database.prepare("SELECT id, generation, state FROM agent_sessions WHERE conversation_id = ? ORDER BY generation DESC LIMIT 1")
      .get(input.conversationId) as { id: string; generation: number; state: DurableAgentSessionState } | undefined;
    if ((prior?.generation ?? null) !== input.expectedGeneration) throw new ProductStoreV2Error("Agent session generation changed.");
    const generation = (prior?.generation ?? 0) + 1;
    const id = `session_${randomUUID().replaceAll("-", "")}`;
    this.#databaseMutation([
      activeLifecycleGuard("conversations", input.conversationId),
      ...(prior && prior.state !== "closed" ? [{ sql: "UPDATE agent_sessions SET state = 'closed', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND generation = ? AND state = ?",
        params: [prior.id, prior.generation, prior.state], expectedChanges: 1 } satisfies DatabaseMutationStatement] : []),
      { sql: `INSERT INTO agent_sessions (id, conversation_id, generation, state, provider_id, provider_model_id, created_at, updated_at)
        VALUES (?, ?, ?, 'creating', ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
        params: [id, input.conversationId, generation, conversation.provider_id, conversation.provider_model_id], expectedChanges: 1 },
    ]);
    return { generation };
  }

  async activateSession(input: { conversationId: string; generation: number; externalSessionRef: string; contextSha256: string }): Promise<void> {
    if (!input.externalSessionRef || !/^[0-9a-f]{64}$/u.test(input.contextSha256)) throw new ProductStoreV2Error("Agent session activation is invalid.");
    this.#databaseMutation([{ sql: `UPDATE agent_sessions SET state = 'available', external_session_ref = ?, context_sha256 = ?, failure_reason = NULL,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE conversation_id = ? AND generation = ? AND state IN ('creating', 'rebuilding')`,
      params: [input.externalSessionRef, input.contextSha256, input.conversationId, input.generation], expectedChanges: 1 }]);
  }

  async failSessionGeneration(input: { conversationId: string; generation: number; reason: string }): Promise<void> {
    if (!input.reason.trim() || input.reason.length > 200) throw new ProductStoreV2Error("Agent session failure reason is invalid.");
    this.#databaseMutation([{ sql: `UPDATE agent_sessions SET state = 'closed', failure_reason = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE conversation_id = ? AND generation = ? AND state IN ('creating', 'rebuilding')`,
      params: [input.reason, input.conversationId, input.generation], expectedChanges: 1 }]);
  }

  transitionAgentSession(conversationId: string, expectedGeneration: number, state: "available" | "lost" | "rebuilding" | "closed", at: IsoTimestamp): void {
    this.#databaseMutation([{ sql: `UPDATE agent_sessions SET state = ?, updated_at = ?
      WHERE conversation_id = ? AND generation = ? AND state != 'closed'`, params: [state, at, conversationId, expectedGeneration], expectedChanges: 1 }]);
  }

  readConversationContext(conversationId: string, limits: { maxMessages: number; maxBytes: number }): ContextSnapshot {
    this.#assertOpen();
    if (!Number.isSafeInteger(limits.maxMessages) || limits.maxMessages < 1 || limits.maxMessages > 500
      || !Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 1 || limits.maxBytes > 1_000_000) throw new ProductStoreV2Error("Conversation context limits are invalid.");
    const conversation = this.#database.prepare("SELECT * FROM conversations WHERE id = ?").get(conversationId) as any;
    if (!conversation) throw new ProductStoreV2Error("Conversation does not exist.");
    const summaryRow = this.#database.prepare("SELECT * FROM conversation_summaries WHERE conversation_id = ?").get(conversationId) as any;
    const candidates = this.#database.prepare(`SELECT * FROM messages WHERE conversation_id = ? AND status IN ('complete', 'failed')
      AND ordinal > ? ORDER BY ordinal DESC LIMIT ?`).all(conversationId, summaryRow?.covered_through_ordinal ?? -1, limits.maxMessages) as any[];
    let usedBytes = 0;
    const selected: any[] = [];
    for (const row of candidates) {
      const size = Buffer.byteLength(row.text, "utf8") + Buffer.byteLength(row.content_json, "utf8");
      if (size > limits.maxBytes - usedBytes) continue;
      selected.push(row); usedBytes += size;
    }
    selected.reverse();
    const messages = selected.map(messageDto);
    const owner = conversation.model_id ? { kind: "model" as const, id: conversation.model_id } : { kind: "project" as const, id: conversation.project_id };
    const summary = summaryRow ? { content: summaryRow.content, coveredThroughOrdinal: summaryRow.covered_through_ordinal } : null;
    const payload = { conversationId, owner, summary, messages, includedMessageIds: messages.map((message) => message.id), limits: { ...limits } };
    return { ...payload, digest: canonicalDigest(payload) };
  }

  advanceConversationSummary(input: { conversationId: string; expectedCoveredThroughOrdinal: number | null; coveredThroughOrdinal: number; content: string; at: IsoTimestamp }): void {
    if (Buffer.byteLength(input.content, "utf8") > 65_536 || input.coveredThroughOrdinal < 0) throw new ProductStoreV2Error("Conversation summary is invalid.");
    const digest = sha256(Buffer.from(input.content, "utf8"));
    const max = this.#database.prepare("SELECT max(ordinal) AS ordinal FROM messages WHERE conversation_id = ? AND status IN ('complete', 'failed')")
      .get(input.conversationId) as { ordinal: number | null };
    if (max.ordinal === null || input.coveredThroughOrdinal > max.ordinal) throw new ProductStoreV2Error("Conversation summary coverage exceeds durable messages.");
    if (input.expectedCoveredThroughOrdinal === null) {
      this.#databaseMutation([activeLifecycleGuard("conversations", input.conversationId), { sql: `INSERT INTO conversation_summaries
        (conversation_id, covered_through_ordinal, content, content_sha256, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
        params: [input.conversationId, input.coveredThroughOrdinal, input.content, digest, input.at, input.at], expectedChanges: 1 }]);
    } else {
      this.#databaseMutation([activeLifecycleGuard("conversations", input.conversationId), { sql: `UPDATE conversation_summaries
        SET covered_through_ordinal = ?, content = ?, content_sha256 = ?, updated_at = ?
        WHERE conversation_id = ? AND covered_through_ordinal = ?`, params: [input.coveredThroughOrdinal, input.content, digest, input.at, input.conversationId, input.expectedCoveredThroughOrdinal], expectedChanges: 1 }]);
    }
  }

  recordSkillUse(input: RecordSkillUseInput): SkillUseDto {
    assertId(input.id);
    this.#databaseMutation([{ sql: `INSERT INTO skill_uses
      (id, conversation_id, turn_id, skill_id, skill_version, routing_mode, catalog_sha256, instruction_sha256, load_state, rationale, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, params: [input.id, input.conversationId, input.turnId, input.skillId, input.skillVersion, input.routingMode,
        input.catalogDigest, input.instructionDigest, input.loadState, input.rationale ?? null, input.createdAt], expectedChanges: 1 }]);
    return this.#skillUses(input.turnId).find((row) => row.id === input.id)!;
  }

  recordAction(input: RecordActionInput): ActionRecordDto {
    assertId(input.id);
    this.#databaseMutation([{ sql: `INSERT INTO action_records
      (id, conversation_id, turn_id, action_kind, intent_json, permission_decision, state, affected_resources_json, error_code, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, params: [input.id, input.conversationId, input.turnId, input.actionKind, json(input.intent),
        input.permissionDecision, input.state, json(input.affectedResources ?? []), input.errorCode ?? null, input.createdAt, input.createdAt], expectedChanges: 1 }]);
    return this.#actions(input.turnId).find((row) => row.id === input.id)!;
  }

  transitionActionRecord(input: { id: string; expectedState: "proposed" | "authorized" | "staging"; state: "authorized" | "staging" | "committed" | "denied" | "rolled_back" | "failed"; mutationTransactionId?: string | null; affectedResources?: unknown[]; errorCode?: string | null; at: IsoTimestamp }): ActionRecordDto {
    const allowed = new Set(["proposed:authorized", "proposed:denied", "authorized:staging", "staging:committed", "staging:rolled_back", "staging:failed", "authorized:failed"]);
    if (!allowed.has(`${input.expectedState}:${input.state}`)) throw new ProductStoreV2Error("Action transition is invalid.");
    this.#databaseMutation([{ sql: `UPDATE action_records SET state = ?, permission_decision = CASE
        WHEN ? = 'authorized' THEN 'allowed' WHEN ? = 'denied' THEN 'denied' ELSE permission_decision END,
        mutation_transaction_id = coalesce(?, mutation_transaction_id), affected_resources_json = ?, error_code = ?, updated_at = ?
      WHERE id = ? AND state = ?`, params: [input.state, input.state, input.state, input.mutationTransactionId ?? null,
        json(input.affectedResources ?? []), input.errorCode ?? null, input.at, input.id, input.expectedState], expectedChanges: 1 }]);
    const row = this.#database.prepare("SELECT turn_id FROM action_records WHERE id = ?").get(input.id) as { turn_id: string };
    return this.#actions(row.turn_id).find((action) => action.id === input.id)!;
  }

  createAttachment(input: CreateAttachmentInput): StoredObjectMetadata {
    const owner = { kind: "conversation" as const, id: input.conversationId };
    const relativePath = `attachments/${input.relativePath}`;
    const bytes = Buffer.from(input.bytes);
    const digest = sha256(bytes);
    this.#coordinator.execute({ files: [{ operation: "write", target: { owner, relativePath }, bytes, expectedPriorSha256: null }], statements: [
      activeLifecycleGuard("conversations", input.conversationId),
      objectInsert({ id: input.objectFileId, owner, kind: "conversation_attachment", relativePath, mediaType: input.mediaType, sizeBytes: bytes.byteLength, digest, createdAt: input.createdAt }),
      { sql: `INSERT INTO attachments (id, conversation_id, object_file_id, original_name, purpose, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`, params: [input.id, input.conversationId, input.objectFileId, input.originalName, input.purpose ?? null, input.createdAt], expectedChanges: 1 },
    ] });
    return this.#file(input.objectFileId);
  }

  /** Backend-only attachment metadata. Absolute paths and bytes are omitted. */
  getConversationAttachment(id: string): {
    id: string; conversationId: string; objectFileId: string; originalName: string; purpose: string | null;
    mediaType: string; sizeBytes: number; sha256: string; relativePath: string;
  } {
    this.#assertOpen();
    const row = this.#database.prepare(`SELECT a.id, a.conversation_id, a.object_file_id, a.original_name, a.purpose,
      f.media_type, f.size_bytes, f.sha256, f.relative_path FROM attachments a JOIN object_files f ON f.id = a.object_file_id
      WHERE a.id = ? AND f.owner_conversation_id = a.conversation_id AND f.kind = 'conversation_attachment'`).get(id) as any;
    if (!row) throw new ProductStoreV2Error("Conversation attachment does not exist.");
    this.#verifiedMetadata(this.#objectRow(row.object_file_id));
    return { id: row.id, conversationId: row.conversation_id, objectFileId: row.object_file_id, originalName: row.original_name,
      purpose: row.purpose, mediaType: row.media_type, sizeBytes: row.size_bytes, sha256: row.sha256, relativePath: row.relative_path };
  }

  readConversationAttachment(id: string, conversationId: string, maximumBytes = 64_000): Buffer {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 1_048_576) throw new ProductStoreV2Error("Attachment read limit is invalid.");
    const attachment = this.getConversationAttachment(id);
    if (attachment.conversationId !== conversationId) throw new ProductStoreV2Error("Conversation attachment ownership mismatch.");
    if (attachment.sizeBytes > maximumBytes) throw new ProductStoreV2Error("Conversation attachment exceeds the bounded read limit.");
    return this.readObjectFile(attachment.objectFileId);
  }

  listTemporaryDocuments(conversationId: string): Array<{
    id: string; conversationId: string; sourceMessageId: string | null; name: string; documentState: TemporaryDocumentState;
    mediaType: string; content: string; lifecycleState: LifecycleState; createdAt: string; updatedAt: string;
  }> {
    this.#assertOpen();
    if (!this.#database.prepare("SELECT 1 FROM conversations WHERE id = ?").get(conversationId)) throw new ProductStoreV2Error("Conversation does not exist.");
    return (this.#database.prepare("SELECT * FROM temporary_documents WHERE conversation_id = ? ORDER BY created_at, id").all(conversationId) as any[]).map((row) => ({
      id: row.id, conversationId: row.conversation_id, sourceMessageId: row.source_message_id, name: row.name,
      documentState: row.document_state, mediaType: row.media_type, content: row.content, lifecycleState: row.lifecycle_state,
      createdAt: row.created_at, updatedAt: row.updated_at,
    }));
  }

  linkMessageAttachment(messageId: string, attachmentId: string): void {
    this.#databaseMutation([
      { sql: `UPDATE conversations SET updated_at = updated_at WHERE lifecycle_state = 'active'
        AND id = (SELECT conversation_id FROM messages WHERE id = ?)`, params: [messageId], expectedChanges: 1 },
      { sql: "INSERT INTO message_attachments (message_id, attachment_id) VALUES (?, ?)", params: [messageId, attachmentId], expectedChanges: 1 },
    ]);
  }

  adoptAttachment(input: AdoptAttachmentInput): StoredObjectMetadata {
    if (!input.purpose.trim()) throw new ProductStoreV2Error("Attachment adoption purpose is required.");
    const source = this.#database.prepare(`SELECT a.id, f.owner_conversation_id, f.relative_path, f.media_type, f.size_bytes, f.sha256
      FROM attachments a JOIN object_files f ON f.id = a.object_file_id WHERE a.id = ?`).get(input.sourceAttachmentId) as {
        id: string; owner_conversation_id: string; relative_path: string; media_type: string; size_bytes: number; sha256: string;
      } | undefined;
    if (!source) throw new ProductStoreV2Error("Source attachment does not exist.");
    const inspected = this.#objects.readWithInspection({ owner: { kind: "conversation", id: source.owner_conversation_id }, relativePath: source.relative_path });
    if (!inspected || inspected.sha256 !== source.sha256 || inspected.sizeBytes !== source.size_bytes) throw new ProductStoreV2Error("Source attachment metadata or bytes drifted.");
    const relativePath = `attachments/${input.relativePath}`;
    this.#coordinator.execute({ ...(input.transactionId ? { transactionId: input.transactionId } : {}), files: [{ operation: "write", target: { owner: input.owner, relativePath }, bytes: inspected.bytes, expectedPriorSha256: null }], statements: [
      activeLifecycleGuard("conversations", source.owner_conversation_id),
      activeOwnerGuard(input.owner),
      objectInsert({ id: input.objectFileId, owner: input.owner, kind: "adopted_attachment", relativePath, mediaType: source.media_type,
        sizeBytes: inspected.sizeBytes, digest: inspected.sha256, sourceAttachmentId: input.sourceAttachmentId, adoptionPurpose: input.purpose, createdAt: input.createdAt }),
    ] });
    return this.#file(input.objectFileId);
  }

  createExperiment(input: CreateExperimentInput): ExperimentConfigurationRecord {
    throw new ProductStoreV2Error("Version-3 experiment creation is unavailable under execution contract v4; use createExperimentV4.");
  }

  createExperimentV4(input: CreateExperimentV4Input): ExperimentConfigurationRecordV4 {
    assertCommandId(input.commandId);
    assertId(input.id);
    assertId(input.projectId);
    assertPlannerPlan(input.plan);
    const configurationJson = json(input.plan.configuration);
    const intentDigest = canonicalDigest({
      schemaVersion: 1,
      commandKind: "experiment.create",
      id: input.id,
      projectId: input.projectId,
      name: input.name,
      configuration: input.plan.configuration,
    });
    return this.#withImmediateTransaction(() => {
      const replayed = this.#experimentCommandReceipt(
        input.commandId, "create", input.projectId, input.id, intentDigest,
      );
      if (replayed) return replayed;
      this.#executeDatabaseStatements([
        activeLifecycleGuard("projects", input.projectId),
        {
          sql: `INSERT INTO experiment_configurations
            (id, project_id, name, configuration_json, estimated_sample_count, created_at, updated_at,
              contract_version, legacy_digest, configuration_sha256, sample_count)
            VALUES (?, ?, ?, ?, ?, ?, ?, 4, NULL, ?, ?)`,
          params: [
            input.id,
            input.projectId,
            input.name,
            configurationJson,
            input.plan.sampleCount,
            input.createdAt,
            input.createdAt,
            input.plan.configurationDigest,
            input.plan.sampleCount,
          ],
          expectedChanges: 1,
          },
      ]);
      const response = this.#experimentConfiguration(input.projectId, input.id) as ExperimentConfigurationRecordV4;
      const responseJson = json(response);
      this.#executeDatabaseStatements([{
        sql: `INSERT INTO experiment_command_receipts
          (command_id, command_kind, project_id, experiment_id, intent_sha256,
            response_json, response_sha256, created_at)
          VALUES (?, 'create', ?, ?, ?, ?, ?, ?)`,
        params: [input.commandId, input.projectId, input.id, intentDigest,
          responseJson, canonicalDigest(response), input.createdAt],
        expectedChanges: 1,
      }]);
      return response;
    });
  }

  updateExperimentV4(input: UpdateExperimentV4Input): ExperimentConfigurationRecordV4 {
    assertCommandId(input.commandId);
    assertId(input.id);
    assertId(input.projectId);
    assertDigest(input.expectedConfigurationDigest, "Expected experiment configuration digest");
    assertDigest(input.expectedRecordDigest, "Expected experiment record digest");
    if (input.name === undefined && input.configuration === undefined) {
      throw new ProductStoreV2Error("Experiment update must contain a name or configuration patch.");
    }
    if ((input.configuration === undefined) !== (input.plan === undefined)) {
      throw new ProductStoreV2Error("Experiment configuration patch and validated plan must be supplied together.");
    }
    if (input.name !== undefined && (!input.name.trim() || input.name.length > 200)) {
      throw new ProductStoreV2Error("Experiment configuration name is invalid.");
    }
    if (input.plan !== undefined) assertPlannerPlan(input.plan);
    const intentDigest = experimentUpdateIntentDigest(input);
    return this.#withImmediateTransaction(() => {
      const replayed = this.#experimentCommandReceipt(
        input.commandId, "update", input.projectId, input.id, intentDigest,
      );
      if (replayed) return replayed;
      const current = this.#experimentConfiguration(input.projectId, input.id);
      if (current.contractVersion !== 4) throw legacyReadOnlyError("experiment");
      if (current.configurationDigest !== input.expectedConfigurationDigest) {
        throw new ProductStoreV2Error("stale_configuration: the observed experiment configuration digest is no longer current.");
      }
      if (experimentConfigurationRecordDigest(current as ExperimentConfigurationRecordV4) !== input.expectedRecordDigest) {
        throw new ProductStoreV2Error("stale_record: the observed experiment record is no longer current.");
      }
      const nextName = input.name ?? current.name;
      const nextConfiguration = input.plan?.configuration ?? current.configuration;
      const nextConfigurationDigest = input.plan?.configurationDigest ?? current.configurationDigest;
      const nextSampleCount = input.plan?.sampleCount ?? current.sampleCount;
      this.#executeDatabaseStatements([
        activeLifecycleGuard("projects", input.projectId),
        {
          sql: `UPDATE experiment_configurations
            SET name = ?, configuration_json = ?, estimated_sample_count = ?,
              configuration_sha256 = ?, sample_count = ?, updated_at = ?
            WHERE id = ? AND project_id = ? AND contract_version = 4
              AND lifecycle_state = 'active' AND configuration_sha256 = ?
              AND name = ? AND updated_at = ?`,
          params: [
            nextName,
            json(nextConfiguration),
            nextSampleCount,
            nextConfigurationDigest,
            nextSampleCount,
            input.updatedAt,
            input.id,
            input.projectId,
            input.expectedConfigurationDigest,
            current.name,
            current.updatedAt,
          ],
          expectedChanges: 1,
          mismatchMessage: "stale_record: the observed experiment record is no longer current.",
        },
      ]);
      const response = this.#experimentConfiguration(input.projectId, input.id) as ExperimentConfigurationRecordV4;
      const responseJson = json(response);
      this.#executeDatabaseStatements([{
        sql: `INSERT INTO experiment_command_receipts
          (command_id, command_kind, project_id, experiment_id, intent_sha256,
            response_json, response_sha256, created_at)
          VALUES (?, 'update', ?, ?, ?, ?, ?, ?)`,
        params: [input.commandId, input.projectId, input.id, intentDigest,
          responseJson, canonicalDigest(response), input.updatedAt],
        expectedChanges: 1,
      }]);
      return response;
    });
  }

  getExperimentUpdateReceipt(input: ExperimentUpdateIntentV4): ExperimentConfigurationRecordV4 | null {
    assertCommandId(input.commandId);
    assertId(input.id);
    assertId(input.projectId);
    assertDigest(input.expectedConfigurationDigest, "Expected experiment configuration digest");
    assertDigest(input.expectedRecordDigest, "Expected experiment record digest");
    if (input.name === undefined && input.configuration === undefined) {
      throw new ProductStoreV2Error("Experiment update must contain a name or configuration patch.");
    }
    return this.#experimentCommandReceipt(
      input.commandId,
      "update",
      input.projectId,
      input.id,
      experimentUpdateIntentDigest(input),
    );
  }

  updateExperiment(input: UpdateExperimentInput): ExperimentConfigurationRecord {
    const row = this.#database.prepare(
      "SELECT contract_version FROM experiment_configurations WHERE id = ? AND project_id = ?",
    ).get(input.id, input.projectId) as { contract_version: number } | undefined;
    if (row?.contract_version === 3) throw legacyReadOnlyError("experiment");
    if (row?.contract_version === 4) {
      throw new ProductStoreV2Error("Version-4 experiments require updateExperimentV4 compare-and-set.");
    }
    throw new ProductStoreV2Error("Experiment configuration does not exist.");
  }

  createRun(input: CreateRunInput): void {
    throw new ProductStoreV2Error("Arbitrary run creation is unavailable under execution contract v4; use createFrozenRun.");
  }

  getFrozenRunStartReceipt(intent: StartRunIntent): FrozenRunStartReceipt | null {
    assertStartRunIntent(intent);
    return this.#frozenRunStartReceipt(intent, startRunIntentDigest(intent));
  }

  getFrozenRunCancelReceipt(intent: CancelRunIntent): FrozenRunCancelReceipt | null {
    assertCancelRunIntent(intent);
    return this.#frozenRunCancelReceipt(intent, cancelRunIntentDigest(intent));
  }

  cancelRun(input: CancelRunInput): FrozenRunCancelReceipt {
    assertCancelRunIntent(input);
    const intentDigest = cancelRunIntentDigest(input);
    const replayed = this.#frozenRunCancelReceipt(input, intentDigest);
    if (replayed) return replayed;
    return this.#withImmediateTransaction(() => {
      const committed = this.#frozenRunCancelReceipt(input, intentDigest);
      if (committed) return committed;
      const row = this.#database.prepare(
        "SELECT * FROM runs WHERE id = ? AND project_id = ?",
      ).get(input.runId, input.projectId) as any;
      if (!row) throw new ProductStoreV2Error("Run does not exist.");
      const run = runRecord(row);
      if (run.contractVersion === 3) throw legacyReadOnlyError("run");

      const terminal = ["succeeded", "failed", "cancelled", "timed_out", "trashed"].includes(run.status);
      const alreadyRequested = !terminal && run.cancelRequestedAt !== null;
      const applied = !terminal && !alreadyRequested;
      const cancelRequestedAt = terminal
        ? run.cancelRequestedAt
        : alreadyRequested ? run.cancelRequestedAt : input.requestedAt;
      const status = terminal ? run.status as FrozenRunCancelReceipt["status"] : "cancelling";
      const code: FrozenRunCancelReceipt["code"] = terminal
        ? "run_already_terminal"
        : alreadyRequested ? "cancellation_already_requested" : "cancellation_requested";
      const receipt: FrozenRunCancelReceipt = Object.freeze({
        schemaVersion: 1,
        commandId: input.commandId,
        projectId: input.projectId,
        runId: input.runId,
        applied,
        code,
        status,
        cancelRequestedAt,
        createdAt: input.requestedAt,
      });
      const receiptJson = json(receipt);
      const receiptDigest = canonicalDigest(receipt);
      this.#executeDatabaseStatements([
        {
          sql: `INSERT INTO run_commands
            (id, run_id, command_kind, request_key, intent_sha256, state, outcome_json, created_at, updated_at)
            VALUES (?, ?, 'cancel', ?, ?, 'committed', ?, ?, ?)`,
          params: [
            input.commandId,
            input.runId,
            input.commandId,
            intentDigest,
            receiptJson,
            input.requestedAt,
            input.requestedAt,
          ],
          expectedChanges: 1,
        },
        {
          sql: `INSERT INTO run_command_receipts
            (id, run_id, command_id, receipt_kind, payload_sha256, payload_json, committed_at)
            VALUES (?, ?, ?, 'run.cancel.v1', ?, ?, ?)`,
          params: [
            `receipt_${canonicalDigest(input.commandId).slice(0, 32)}`,
            input.runId,
            input.commandId,
            receiptDigest,
            receiptJson,
            input.requestedAt,
          ],
          expectedChanges: 1,
        },
        ...(applied ? [{
          sql: `UPDATE runs
            SET cancel_requested_at = ?, first_cancel_command_id = ?, updated_at = ?
            WHERE id = ? AND project_id = ? AND contract_version = 4
              AND status IN ('queued', 'running')
              AND cancel_requested_at IS NULL AND first_cancel_command_id IS NULL`,
          params: [
            input.requestedAt,
            input.commandId,
            input.requestedAt,
            input.runId,
            input.projectId,
          ],
          expectedChanges: 1,
          mismatchMessage: "run_cancel_conflict: cancellation lost its durable compare-and-set.",
        }] : []),
      ]);
      return receipt;
    });
  }

  createFrozenRun(input: CreateFrozenRunInput): FrozenRunStartReceipt {
    assertStartRunIntent(input);
    const intentDigest = startRunIntentDigest(input);
    const replayed = this.#frozenRunStartReceipt(input, intentDigest);
    if (replayed) return replayed;
    const experimentContract = this.#database.prepare(
      "SELECT contract_version FROM experiment_configurations WHERE id = ? AND project_id = ?",
    ).get(input.experimentConfigId, input.projectId) as { contract_version: number } | undefined;
    if (experimentContract?.contract_version === 3) throw legacyReadOnlyError("experiment");

    assertId(input.runId);
    assertDigest(input.expectedConfigurationDigest, "Expected experiment configuration digest");
    assertDigest(input.projectSnapshotDigest, "Project snapshot digest");
    assertDigest(input.executionDescriptionDigest, "Execution description digest");
    assertRunLimits(input.limits);
    assertPlannerPlan(input.plan, input.limits.maxSamples);
    if (input.expectedConfigurationDigest !== input.plan.configurationDigest) {
      throw new ProductStoreV2Error("stale_configuration: the planned configuration differs from the expected digest.");
    }
    const limitsDigest = canonicalDigest(input.limits);
    const receipt: FrozenRunStartReceipt = Object.freeze({
      schemaVersion: 1,
      commandId: input.commandId,
      intentDigest,
      runId: input.runId,
      projectId: input.projectId,
      experimentConfigId: input.experimentConfigId,
      completionConversationId: input.completionConversationId,
      status: "queued",
      runKind: input.plan.configuration.runKind,
      frozenConfigurationDigest: input.plan.configurationDigest,
      samplePlanDigest: input.plan.samplePlanDigest,
      sampleCount: input.plan.sampleCount,
      projectSnapshotDigest: input.projectSnapshotDigest,
      executionDescriptionDigest: input.executionDescriptionDigest,
      limitsDigest,
      createdAt: input.createdAt,
    });
    const receiptJson = json(receipt);
    const receiptDigest = canonicalDigest(receipt);

    return this.#withImmediateTransaction(() => {
      const committed = this.#frozenRunStartReceipt(input, intentDigest);
      if (committed) return committed;
      const project = this.#database.prepare("SELECT * FROM projects WHERE id = ?").get(input.projectId) as {
          lifecycle_state: LifecycleState;
          model_snapshot_digest: string;
          execution_description_json: string;
        } | undefined;
      if (!project || project.lifecycle_state !== "active"
        || project.model_snapshot_digest !== input.projectSnapshotDigest
        || canonicalDigest(JSON.parse(project.execution_description_json)) !== input.executionDescriptionDigest) {
        throw new ProductStoreV2Error("project_snapshot_corrupt: the active Project does not match the verified frozen digests.");
      }
      this.#verifyFrozenProject(project);
      assertRunnableExecutionDescription(
        JSON.parse(project.execution_description_json),
        input.plan,
        input.limits.maxSamples,
      );
      this.#executeDatabaseStatements([
        {
          sql: `UPDATE projects SET updated_at = updated_at
            WHERE id = ? AND lifecycle_state = 'active'
              AND model_snapshot_digest = ?
              AND riff_canonical_sha256(execution_description_json) = ?`,
          params: [input.projectId, input.projectSnapshotDigest, input.executionDescriptionDigest],
          expectedChanges: 1,
          mismatchMessage: "project_snapshot_corrupt: the active Project does not match the verified frozen digests.",
        },
        {
          sql: `UPDATE experiment_configurations SET updated_at = updated_at
            WHERE id = ? AND project_id = ? AND contract_version = 4
              AND lifecycle_state = 'active' AND configuration_sha256 = ?
              AND configuration_json = ? AND sample_count = ?`,
          params: [
            input.experimentConfigId,
            input.projectId,
            input.expectedConfigurationDigest,
            json(input.plan.configuration),
            input.plan.sampleCount,
          ],
          expectedChanges: 1,
          mismatchMessage: "stale_configuration: the experiment changed before the run snapshot committed.",
        },
        ...(input.completionConversationId === null ? [] : [{
          sql: `UPDATE conversations SET updated_at = updated_at
            WHERE id = ? AND project_id = ?`,
          params: [input.completionConversationId, input.projectId],
          expectedChanges: 1,
          mismatchMessage: "completion_conversation_project_mismatch: the completion conversation does not belong to the Project.",
        }]),
        {
          sql: `INSERT INTO runs
            (id, project_id, experiment_configuration_id, status,
              frozen_configuration_json, requested_sample_count, created_at, updated_at,
              contract_version, legacy_digest, run_kind, completion_conversation_id,
              execution_description_sha256, project_snapshot_sha256,
              frozen_configuration_sha256, sample_plan_json, sample_plan_sha256,
              limits_json, limits_sha256, start_receipt_sha256, completion_card_disposition)
            VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, 4, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          params: [
            input.runId,
            input.projectId,
            input.experimentConfigId,
            json(input.plan.configuration),
            input.plan.sampleCount,
            input.createdAt,
            input.createdAt,
            input.plan.configuration.runKind,
            input.completionConversationId,
            input.executionDescriptionDigest,
            input.projectSnapshotDigest,
            input.plan.configurationDigest,
            json(input.plan.samples),
            input.plan.samplePlanDigest,
            json(input.limits),
            limitsDigest,
            receiptDigest,
            input.completionConversationId === null ? "not_requested" : "pending",
          ],
          expectedChanges: 1,
        },
        {
          sql: `INSERT INTO run_commands
            (id, run_id, command_kind, request_key, intent_sha256, state, outcome_json, created_at, updated_at)
            VALUES (?, ?, 'start', ?, ?, 'committed', ?, ?, ?)`,
          params: [
            input.commandId,
            input.runId,
            input.commandId,
            intentDigest,
            receiptJson,
            input.createdAt,
            input.createdAt,
          ],
          expectedChanges: 1,
        },
        {
          sql: `INSERT INTO run_command_receipts
            (id, run_id, command_id, receipt_kind, payload_sha256, payload_json, committed_at)
            VALUES (?, ?, ?, 'run.start.v1', ?, ?, ?)`,
          params: [
            `receipt_${canonicalDigest(input.commandId).slice(0, 32)}`,
            input.runId,
            input.commandId,
            receiptDigest,
            receiptJson,
            input.createdAt,
          ],
          expectedChanges: 1,
        },
      ]);
      return receipt;
    });
  }

  createOutput(input: CreateOutputInput): StoredObjectMetadata {
    const run = this.#database.prepare(
      "SELECT contract_version FROM runs WHERE id = ?",
    ).get(input.runId) as { contract_version: number } | undefined;
    if (!run) throw new ProductStoreV2Error("Run does not exist.");
    if (run.contract_version === 3) throw legacyReadOnlyError("run");
    throw new ProductStoreV2Error(
      "atomic_batch_output_required: version-4 outputs can only be published with the successful run terminal commit.",
    );
  }

  activateDispatcherGeneration(input: { generation: string; activatedAt: IsoTimestamp }): void {
    assertDigest(input.generation, "Dispatcher generation");
    this.#withImmediateTransaction(() => {
      const current = this.#database.prepare(
        "SELECT generation FROM dispatcher_state WHERE singleton = 1",
      ).get() as { generation: string } | undefined;
      if (current?.generation === input.generation) return;
      const liveAttempts = Number((this.#database.prepare(`SELECT count(*) AS count
        FROM run_attempts WHERE state IN ('claimed', 'starting', 'running')`
      ).get() as { count: number }).count);
      const liveProcesses = Number((this.#database.prepare(`SELECT count(*) AS count
        FROM process_attempts WHERE state NOT IN ('cleanup_complete', 'cleanup_unverified')`
      ).get() as { count: number }).count);
      if (liveAttempts !== 0 || liveProcesses !== 0) {
        throw new ProductStoreV2Error(
          "dispatcher_recovery_required: a prior dispatcher still owns live run or process attempts.",
        );
      }
      this.#executeDatabaseStatements([{
        sql: `INSERT INTO dispatcher_state (singleton, generation, activated_at)
          VALUES (1, ?, ?)
          ON CONFLICT(singleton) DO UPDATE SET generation = excluded.generation, activated_at = excluded.activated_at`,
        params: [input.generation, input.activatedAt],
        expectedChanges: 1,
      }]);
    });
  }

  claimNextQueuedBatchRun(input: {
    dispatcherGeneration: string;
    claimedAt: IsoTimestamp;
    leaseExpiresAt: IsoTimestamp;
  }): ClaimedBatchRun | null {
    assertDigest(input.dispatcherGeneration, "Dispatcher generation");
    return this.#withImmediateTransaction(() => {
      this.#assertCurrentDispatcherGeneration(input.dispatcherGeneration);
      const row = this.#database.prepare(`SELECT *
        FROM runs
        WHERE contract_version = 4 AND run_kind = 'batch' AND status = 'queued'
          AND cancel_requested_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM run_attempts a
            WHERE a.run_id = runs.id AND a.state IN ('claimed', 'starting', 'running')
          )
        ORDER BY created_at, id
        LIMIT 1`).get() as any;
      if (!row) return null;
      const attemptGeneration = Number((this.#database.prepare(
        "SELECT coalesce(max(attempt_generation), 0) + 1 AS generation FROM run_attempts WHERE run_id = ?",
      ).get(row.id) as { generation: number }).generation);
      const attemptId = `attempt_${canonicalDigest({
        runId: row.id,
        attemptGeneration,
        dispatcherGeneration: input.dispatcherGeneration,
      }).slice(0, 32)}`;
      this.#executeDatabaseStatements([
        {
          sql: `INSERT INTO run_attempts
            (id, run_id, attempt_generation, dispatcher_generation, state, claimed_at, lease_expires_at)
            VALUES (?, ?, ?, ?, 'claimed', ?, ?)`,
          params: [
            attemptId,
            row.id,
            attemptGeneration,
            input.dispatcherGeneration,
            input.claimedAt,
            input.leaseExpiresAt,
          ],
          expectedChanges: 1,
        },
        {
          sql: `UPDATE runs
            SET status = 'running', started_at = ?, updated_at = ?
            WHERE id = ? AND contract_version = 4 AND run_kind = 'batch'
              AND status = 'queued' AND cancel_requested_at IS NULL`,
          params: [input.claimedAt, input.claimedAt, row.id],
          expectedChanges: 1,
          mismatchMessage: "run_claim_conflict: the queued batch run was already claimed.",
        },
      ]);
      return Object.freeze({
        run: runRecord(this.#database.prepare("SELECT * FROM runs WHERE id = ?").get(row.id)) as Extract<RunRecord, { contractVersion: 4 }>,
        attempt: runAttemptRecord(this.#database.prepare("SELECT * FROM run_attempts WHERE id = ?").get(attemptId)),
      });
    });
  }

  finalizeNextCancelledQueuedRun(input: {
    finishedAt: IsoTimestamp;
  }): Extract<RunRecord, { contractVersion: 4 }> | null {
    return this.#withImmediateTransaction(() => {
      const row = this.#database.prepare(`SELECT id
        FROM runs
        WHERE contract_version = 4 AND status = 'queued'
          AND cancel_requested_at IS NOT NULL AND first_cancel_command_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM run_attempts a
            WHERE a.run_id = runs.id AND a.state IN ('claimed', 'starting', 'running')
          )
        ORDER BY cancel_requested_at, id
        LIMIT 1`).get() as { id: string } | undefined;
      if (!row) return null;
      this.#executeDatabaseStatements([{
        sql: `UPDATE runs
          SET status = 'cancelled', terminal_code = 'run_cancelled',
            terminal_diagnostics_json = ?,
            resource_overview_json = '{}',
            finished_at = ?, updated_at = ?
          WHERE id = ? AND contract_version = 4 AND status = 'queued'
            AND cancel_requested_at IS NOT NULL AND first_cancel_command_id IS NOT NULL`,
        params: [
          json({ code: "run_cancelled", diagnostic: "The queued run was cancelled before launch." }),
          input.finishedAt,
          input.finishedAt,
          row.id,
        ],
        expectedChanges: 1,
        mismatchMessage: "run_cancel_conflict: queued cancellation lost its durable compare-and-set.",
      }]);
      return runRecord(this.#database.prepare("SELECT * FROM runs WHERE id = ?").get(row.id)) as Extract<RunRecord, { contractVersion: 4 }>;
    });
  }

  isRunCancellationRequested(runId: string): boolean {
    assertId(runId);
    const row = this.#database.prepare(`SELECT cancel_requested_at, first_cancel_command_id
      FROM runs WHERE id = ? AND contract_version = 4 AND status IN ('queued', 'running')`
    ).get(runId) as { cancel_requested_at: string | null; first_cancel_command_id: string | null } | undefined;
    return row?.cancel_requested_at !== null && row?.cancel_requested_at !== undefined
      && row.first_cancel_command_id !== null;
  }

  markRunAttemptStarting(input: RunAttemptIdentity & { startedAt: IsoTimestamp }): RunAttemptRecord {
    return this.#transitionRunAttempt({
      ...input,
      expectedState: "claimed",
      nextState: "starting",
      at: input.startedAt,
      updates: { startedAt: input.startedAt },
    });
  }

  markRunAttemptRunning(input: RunAttemptIdentity & {
    startedAt: IsoTimestamp;
    leaseExpiresAt: IsoTimestamp;
  }): RunAttemptRecord {
    return this.#transitionRunAttempt({
      ...input,
      expectedState: "starting",
      nextState: "running",
      at: input.startedAt,
      updates: {
        startedAt: input.startedAt,
        heartbeatAt: input.startedAt,
        leaseExpiresAt: input.leaseExpiresAt,
      },
    });
  }

  heartbeatRunAttempt(input: RunAttemptIdentity & {
    expectedState: "claimed" | "starting" | "running";
    heartbeatAt: IsoTimestamp;
    leaseExpiresAt: IsoTimestamp;
  }): RunAttemptRecord {
    assertRunAttemptIdentity(input);
    return this.#withImmediateTransaction(() => {
      this.#assertCurrentDispatcherGeneration(input.dispatcherGeneration);
      this.#executeDatabaseStatements([{
        sql: `UPDATE run_attempts
          SET heartbeat_at = ?, lease_expires_at = ?
          WHERE id = ? AND run_id = ? AND attempt_generation = ?
            AND dispatcher_generation = ? AND state = ?`,
        params: [
          input.heartbeatAt,
          input.leaseExpiresAt,
          input.attemptId,
          input.runId,
          input.attemptGeneration,
          input.dispatcherGeneration,
          input.expectedState,
        ],
        expectedChanges: 1,
        mismatchMessage: "stale_dispatcher_generation: the run-attempt heartbeat lost its compare-and-set.",
      }]);
      return runAttemptRecord(this.#database.prepare("SELECT * FROM run_attempts WHERE id = ?").get(input.attemptId));
    });
  }

  prepareBatchProcessLaunch(input: BatchLaunchIdentity & {
    createdAt: IsoTimestamp;
  }): BatchLaunchManifestBinding {
    assertRunAttemptIdentity(input);
    assertBatchScratchPlan(input);
    return this.#withImmediateTransaction(() => {
      this.#assertCurrentDispatcherGeneration(input.dispatcherGeneration);
      const attempt = this.#database.prepare(`SELECT a.state, r.contract_version, r.sample_plan_json
        FROM run_attempts a
        JOIN runs r ON r.id = a.run_id
        WHERE a.id = ? AND a.run_id = ? AND a.attempt_generation = ?
          AND a.dispatcher_generation = ?`
      ).get(input.attemptId, input.runId, input.attemptGeneration, input.dispatcherGeneration) as {
        state: string;
        contract_version: number;
        sample_plan_json: string;
      } | undefined;
      const sample = attempt ? (JSON.parse(attempt.sample_plan_json) as Array<{ sampleIndex: number; sampleId: string }>)[input.sampleIndex] : undefined;
      if (!attempt || attempt.contract_version !== 4 || !["starting", "running"].includes(attempt.state)
        || sample?.sampleIndex !== input.sampleIndex || sample.sampleId !== input.sampleId) {
        throw new ProductStoreV2Error("process_launch_manifest_invalid: launch planning requires the current v4 attempt and frozen sample.");
      }
      const manifest = launchManifestPayload(input);
      const manifestDigest = canonicalDigest(manifest);
      const manifestId = `launch_${manifestDigest.slice(0, 32)}`;
      this.#executeDatabaseStatements([
        {
          sql: `INSERT INTO run_scratch_leases
            (id, run_id, run_attempt_id, dispatcher_generation, sample_index, sample_id,
              relative_path, state, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'planned', ?)`,
          params: [
            input.scratchId,
            input.runId,
            input.attemptId,
            input.dispatcherGeneration,
            input.sampleIndex,
            input.sampleId,
            input.relativePath,
            input.createdAt,
          ],
          expectedChanges: 1,
        },
        {
          sql: `INSERT INTO process_launch_manifests
            (id, run_attempt_id, scratch_lease_id, state, manifest_json, manifest_sha256, created_at)
            VALUES (?, ?, ?, 'planned', ?, ?, ?)`,
          params: [
            manifestId,
            input.attemptId,
            input.scratchId,
            json(manifest),
            manifestDigest,
            input.createdAt,
          ],
          expectedChanges: 1,
        },
      ]);
      return Object.freeze({ manifestId, manifestDigest });
    });
  }

  registerBatchScratchDirectory(input: BatchLaunchIdentity & BatchScratchDirectoryIdentity & {
    registeredAt: IsoTimestamp;
  }): RunScratchLeaseRecord {
    assertRunAttemptIdentity(input);
    assertBatchScratchPlan(input);
    for (const [label, value, minimum] of [
      ["Scratch owner", input.ownerUid, 0],
      ["Scratch device", input.device, 0],
      ["Scratch inode", input.inode, 1],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < minimum) {
        throw new ProductStoreV2Error(`${label} identity is invalid.`);
      }
    }
    return this.#withImmediateTransaction(() => {
      this.#assertCurrentDispatcherGeneration(input.dispatcherGeneration);
      this.#executeDatabaseStatements([{
        sql: `UPDATE run_scratch_leases
          SET state = 'created', owner_uid = ?, device = ?, inode = ?, registered_at = ?
          WHERE id = ? AND run_id = ? AND run_attempt_id = ? AND dispatcher_generation = ?
            AND sample_index = ? AND sample_id = ? AND relative_path = ? AND state = 'planned'`,
        params: [
          input.ownerUid,
          input.device,
          input.inode,
          input.registeredAt,
          input.scratchId,
          input.runId,
          input.attemptId,
          input.dispatcherGeneration,
          input.sampleIndex,
          input.sampleId,
          input.relativePath,
        ],
        expectedChanges: 1,
        mismatchMessage: "process_launch_manifest_invalid: scratch directory registration lost its exact lease.",
      }]);
      return scratchLeaseRecord(this.#database.prepare(
        "SELECT * FROM run_scratch_leases WHERE id = ?",
      ).get(input.scratchId));
    });
  }

  registerBatchProcessAttempt(input: BatchProcessIdentity & {
    launchedAt: IsoTimestamp;
    launchReceipt?: BatchLaunchReceipt;
  }): ProcessAttemptRecord {
    assertBatchProcessIdentity(input);
    return this.#withImmediateTransaction(() => {
      this.#assertCurrentDispatcherGeneration(input.dispatcherGeneration);
      const attempt = this.#database.prepare(`SELECT a.state, r.sample_plan_json
        FROM run_attempts a
        JOIN runs r ON r.id = a.run_id
        WHERE a.id = ? AND a.run_id = ? AND a.attempt_generation = ? AND a.dispatcher_generation = ?`
      ).get(input.attemptId, input.runId, input.attemptGeneration, input.dispatcherGeneration) as {
        state: string;
        sample_plan_json: string;
      } | undefined;
      if (!attempt || !["starting", "running"].includes(attempt.state)) {
        throw new ProductStoreV2Error("invalid_run_transition: batch process registration requires the current starting or running attempt.");
      }
      const samples = JSON.parse(attempt.sample_plan_json) as Array<{ sampleIndex: number; sampleId: string }>;
      if (samples[input.sampleIndex]?.sampleIndex !== input.sampleIndex
        || samples[input.sampleIndex]?.sampleId !== input.sampleId) {
        throw new ProductStoreV2Error("process_attempt_sample_mismatch: the process sample does not match the frozen run plan.");
      }
      this.#ensureRegisteredLaunchEvidence(input);
      this.#executeDatabaseStatements([{
        sql: `INSERT INTO process_attempts
          (id, run_attempt_id, process_kind, sample_index, sample_id, pid, process_start_token,
            process_group_id, launch_gate_state, state, launched_at)
          VALUES (?, ?, 'batch', ?, ?, ?, ?, ?, 'blocked', 'blocked', ?)`,
        params: [
          input.processAttemptId,
          input.attemptId,
          input.sampleIndex,
          input.sampleId,
          input.pid,
          input.processStartToken,
          input.processGroupId,
          input.launchedAt,
        ],
        expectedChanges: 1,
      }]);
      return processAttemptRecord(this.#database.prepare("SELECT * FROM process_attempts WHERE id = ?").get(input.processAttemptId));
    });
  }

  markBatchProcessGateReleased(input: BatchProcessIdentity & {
    startedAt: IsoTimestamp;
  }): ProcessAttemptRecord {
    return this.#transitionBatchProcess(input, {
      expectedState: "blocked",
      nextState: "released",
      set: "launch_gate_state = 'released', state = 'released', started_at = ?",
      params: [input.startedAt],
      extraStatements: [{
        sql: `UPDATE process_launch_manifests
          SET state = 'released'
          WHERE process_attempt_id = ? AND state = 'registered'`,
        params: [input.processAttemptId],
        expectedChanges: 1,
        mismatchMessage: "process_launch_manifest_invalid: gate release lacks registered launch evidence.",
      }],
    });
  }

  markBatchProcessStarted(input: BatchProcessIdentity & {
    startedAt: IsoTimestamp;
  }): ProcessAttemptRecord {
    return this.#transitionBatchProcess(input, {
      expectedState: "released",
      nextState: "running",
      set: "state = 'running', started_at = coalesce(started_at, ?), heartbeat_at = ?",
      params: [input.startedAt, input.startedAt],
    });
  }

  heartbeatBatchProcess(input: BatchProcessIdentity & {
    expectedState: "released" | "running";
    heartbeatAt: IsoTimestamp;
  }): ProcessAttemptRecord {
    return this.#transitionBatchProcess(input, {
      expectedState: input.expectedState,
      nextState: input.expectedState,
      set: "heartbeat_at = ?",
      params: [input.heartbeatAt],
      stateTransition: false,
    });
  }

  recordBatchProcessExit(input: BatchProcessIdentity & {
    expectedState: "blocked" | "released" | "running";
    exitedAt: IsoTimestamp;
    exitCode: number | null;
    exitSignal: string | null;
  }): ProcessAttemptRecord {
    if (input.exitCode !== null && !Number.isSafeInteger(input.exitCode)) {
      throw new ProductStoreV2Error("Batch process exit code is invalid.");
    }
    if (input.exitSignal !== null && (!input.exitSignal || input.exitSignal.length > 100)) {
      throw new ProductStoreV2Error("Batch process exit signal is invalid.");
    }
    return this.#transitionBatchProcess(input, {
      expectedState: input.expectedState,
      nextState: "exited",
      set: "state = 'exited', exited_at = ?, exit_code = ?, exit_signal = ?",
      params: [input.exitedAt, input.exitCode, input.exitSignal],
      extraStatements: [{
        sql: `UPDATE process_launch_manifests
          SET state = 'exited'
          WHERE process_attempt_id = ? AND state IN ('registered', 'released')`,
        params: [input.processAttemptId],
        expectedChanges: 1,
        mismatchMessage: "process_launch_manifest_invalid: process exit lacks launch evidence.",
      }],
    });
  }

  finalizeBatchProcessCleanup(input: BatchProcessIdentity & {
    cleanupVerified: boolean;
    cleanupReceiptDigest: string | null;
    cleanedAt?: IsoTimestamp;
  }): ProcessAttemptRecord {
    if (input.cleanupVerified) assertDigest(input.cleanupReceiptDigest ?? "", "Cleanup receipt digest");
    if (!input.cleanupVerified && input.cleanupReceiptDigest !== null) {
      throw new ProductStoreV2Error("Unverified cleanup cannot carry a verified cleanup receipt.");
    }
    const cleanedAt = input.cleanedAt ?? new Date().toISOString();
    const scratchReceipt = input.cleanupVerified ? {
      schemaVersion: 1,
      kind: "batch_scratch_cleanup",
      processAttemptId: input.processAttemptId,
      scratchId: input.scratchId ?? null,
      supervisorReceiptDigest: input.cleanupReceiptDigest,
      cleanedAt,
      verified: true,
    } : null;
    const scratchReceiptDigest = scratchReceipt ? canonicalDigest(scratchReceipt) : null;
    return this.#transitionBatchProcess(input, {
      expectedState: "exited",
      nextState: input.cleanupVerified ? "cleanup_complete" : "cleanup_unverified",
      set: "state = ?, cleanup_receipt_sha256 = ?",
      params: [input.cleanupVerified ? "cleanup_complete" : "cleanup_unverified", input.cleanupReceiptDigest],
      extraStatements: [
        {
          sql: `UPDATE run_scratch_leases
            SET state = ?, cleaned_at = ?, cleanup_receipt_json = ?, cleanup_receipt_sha256 = ?
            WHERE id = (
              SELECT scratch_lease_id FROM process_launch_manifests
              WHERE process_attempt_id = ?
            ) AND state IN ('created', 'active')`,
          params: [
            input.cleanupVerified ? "cleanup_complete" : "cleanup_unverified",
            cleanedAt,
            scratchReceipt ? json(scratchReceipt) : null,
            scratchReceiptDigest,
            input.processAttemptId,
          ],
          expectedChanges: 1,
          mismatchMessage: "scratch_cleanup_unverified: process cleanup lacks its exact scratch lease.",
        },
        ...(input.cleanupVerified ? [{
          sql: `UPDATE process_launch_manifests
            SET state = 'cleanup_complete'
            WHERE process_attempt_id = ? AND state = 'exited'`,
          params: [input.processAttemptId],
          expectedChanges: 1,
          mismatchMessage: "scratch_cleanup_unverified: process cleanup lacks exited launch evidence.",
        }] : []),
      ],
    });
  }

  finalizeBatchRunTerminal(input: RunAttemptIdentity & {
    expectedAttemptState: "starting" | "running";
    status: "failed" | "timed_out";
    terminalCode: string;
    terminalDiagnostics: Record<string, unknown>;
    resourceOverview: Record<string, unknown>;
    finishedAt: IsoTimestamp;
  }): Extract<RunRecord, { contractVersion: 4 }> {
    assertRunAttemptIdentity(input);
    assertTerminalData(input.terminalCode, input.terminalDiagnostics, input.resourceOverview);
    return this.#withImmediateTransaction(() => {
      this.#assertCurrentDispatcherGeneration(input.dispatcherGeneration);
      const runState = this.#database.prepare(
        `SELECT cancel_requested_at, first_cancel_command_id
          FROM runs WHERE id = ? AND contract_version = 4 AND status = 'running'`,
      ).get(input.runId) as {
        cancel_requested_at: string | null;
        first_cancel_command_id: string | null;
      } | undefined;
      if (!runState) {
        throw new ProductStoreV2Error("invalid_run_transition: the batch run is no longer running.");
      }
      const cancellationWon = runState.cancel_requested_at !== null
        && runState.first_cancel_command_id !== null;
      const status = cancellationWon ? "cancelled" : input.status;
      const terminalCode = cancellationWon ? "run_cancelled" : input.terminalCode;
      const terminalDiagnostics = cancellationWon
        ? { code: "run_cancelled", diagnostic: "Cancellation committed before the terminal run receipt." }
        : input.terminalDiagnostics;
      const liveProcesses = Number((this.#database.prepare(`SELECT count(*) AS count
        FROM process_attempts
        WHERE run_attempt_id = ? AND state != 'cleanup_complete'`
      ).get(input.attemptId) as { count: number }).count);
      if (liveProcesses !== 0) {
        throw new ProductStoreV2Error("process_cleanup_unverified: a batch run cannot finalize unless every process has verified cleanup.");
      }
      this.#executeDatabaseStatements([
        {
          sql: `UPDATE run_attempts
            SET state = ?, finished_at = ?, heartbeat_at = ?
            WHERE id = ? AND run_id = ? AND attempt_generation = ?
              AND dispatcher_generation = ? AND state = ?`,
          params: [
            status,
            input.finishedAt,
            input.finishedAt,
            input.attemptId,
            input.runId,
            input.attemptGeneration,
            input.dispatcherGeneration,
            input.expectedAttemptState,
          ],
          expectedChanges: 1,
          mismatchMessage: "stale_dispatcher_generation: the terminal run-attempt compare-and-set failed.",
        },
        {
          sql: `UPDATE runs
            SET status = ?, terminal_code = ?, terminal_diagnostics_json = ?,
              resource_overview_json = ?, finished_at = ?, updated_at = ?
            WHERE id = ? AND contract_version = 4 AND run_kind = 'batch' AND status = 'running'`,
          params: [
            status,
            terminalCode,
            json(terminalDiagnostics),
            json(input.resourceOverview),
            input.finishedAt,
            input.finishedAt,
            input.runId,
          ],
          expectedChanges: 1,
          mismatchMessage: "invalid_run_transition: the batch run is no longer running.",
        },
      ]);
      return runRecord(this.#database.prepare("SELECT * FROM runs WHERE id = ?").get(input.runId)) as Extract<RunRecord, { contractVersion: 4 }>;
    });
  }

  commitBatchRunSuccess(input: RunAttemptIdentity & {
    outputs: readonly BatchOutputCommit[];
    terminalDiagnostics: Record<string, unknown>;
    resourceOverview: Record<string, unknown>;
    finishedAt: IsoTimestamp;
  }): BatchSuccessCommitReceipt {
    assertRunAttemptIdentity(input);
    assertTerminalData("run_succeeded", input.terminalDiagnostics, input.resourceOverview);
    this.#assertCurrentDispatcherGeneration(input.dispatcherGeneration);
    const runRow = this.#database.prepare("SELECT * FROM runs WHERE id = ?").get(input.runId) as any;
    if (!runRow) throw new ProductStoreV2Error("Run does not exist.");
    const run = runRecord(runRow);
    if (run.contractVersion !== 4) throw legacyReadOnlyError("run");
    if (run.runKind !== "batch" || run.status !== "running") {
      throw new ProductStoreV2Error("invalid_run_transition: success requires a running v4 batch run.");
    }
    if (run.cancelRequestedAt !== null) {
      throw new ProductStoreV2Error("run_cancellation_won: cancellation committed before successful output publication.");
    }
    const attempt = this.#database.prepare(`SELECT * FROM run_attempts
      WHERE id = ? AND run_id = ? AND attempt_generation = ? AND dispatcher_generation = ?`
    ).get(input.attemptId, input.runId, input.attemptGeneration, input.dispatcherGeneration) as any;
    if (!attempt || attempt.state !== "running") {
      throw new ProductStoreV2Error("invalid_run_transition: success requires the current running attempt.");
    }
    const project = this.#project(run.projectId);
    let execution;
    try {
      execution = validateExecutionDescriptionV2(project.executionDescription);
      assertRunCapabilityV2(execution, "batch");
    } catch (error) {
      if (error instanceof ExecutionProtocolV2Error) {
        throw new ProductStoreV2Error(`${error.code}: ${error.message}`, { cause: error });
      }
      throw error;
    }
    const samples = run.samplePlan as Array<{
      sampleIndex: number;
      sampleId: string;
    }>;
    const processes = this.#database.prepare(`SELECT sample_index, sample_id, state, exit_code
      FROM process_attempts WHERE run_attempt_id = ? ORDER BY sample_index, id`
    ).all(input.attemptId) as Array<{ sample_index: number; sample_id: string; state: string; exit_code: number | null }>;
    if (processes.length !== samples.length || processes.some((process, index) =>
      process.sample_index !== samples[index]?.sampleIndex
      || process.sample_id !== samples[index]?.sampleId
      || process.state !== "cleanup_complete"
      || process.exit_code !== 0)) {
      throw new ProductStoreV2Error("process_cleanup_unverified: success requires one verified zero-exit process per frozen sample.");
    }
    const declarations = new Map(execution.outputs.map((output) => [output.logicalName, output]));
    const seen = new Set<string>();
    const outputs = input.outputs.map((output) => {
      const sample = samples[output.sampleIndex];
      const declaration = declarations.get(output.logicalName);
      const key = `${output.sampleIndex}:${output.logicalName}`;
      if (!sample || sample.sampleIndex !== output.sampleIndex || sample.sampleId !== output.sampleId
        || !declaration || seen.has(key)
        || typeof output.outputType !== "string" || !output.outputType.trim() || output.outputType.length > 200
        || !(output.bytes instanceof Uint8Array)) {
        throw new ProductStoreV2Error("run_output_invalid: a successful output is undeclared, duplicated, or bound to the wrong sample.");
      }
      seen.add(key);
      const bytes = Buffer.from(output.bytes);
      const identity = { runId: input.runId, sampleIndex: output.sampleIndex, logicalName: output.logicalName };
      const id = `output_${canonicalDigest(identity).slice(0, 32)}`;
      const objectFileId = `file_${canonicalDigest({ ...identity, kind: "run_output" }).slice(0, 32)}`;
      const relativePath = `outputs/${output.sampleIndex}/${declaration.relativePath.replace(/^outputs\//u, "")}`;
      const digest = sha256(bytes);
      const outputContractDigest = canonicalDigest({
        runId: input.runId,
        logicalName: output.logicalName,
        outputType: output.outputType,
        sampleIndex: output.sampleIndex,
        sampleId: output.sampleId,
        declaredRole: declaration.role,
      });
      return {
        ...output,
        id,
        objectFileId,
        relativePath,
        mediaType: declaration.mediaType,
        declaredRole: declaration.role,
        bytes,
        digest,
        outputContractDigest,
      };
    }).sort((left, right) => left.sampleIndex - right.sampleIndex || compareStrings(left.logicalName, right.logicalName));
    for (const sample of samples) {
      for (const declaration of execution.outputs) {
        if (declaration.required && !seen.has(`${sample.sampleIndex}:${declaration.logicalName}`)) {
          throw new ProductStoreV2Error("run_output_invalid: a required declared output is missing.");
        }
      }
    }
    const limits = run.limits as RunLimitsV1;
    const totalBytes = outputs.reduce((sum, output) => sum + output.bytes.byteLength, 0);
    if (outputs.length > limits.maxOutputFiles) {
      throw new ProductStoreV2Error("run_output_file_limit: successful outputs exceed the frozen file limit.");
    }
    if (!Number.isSafeInteger(totalBytes) || totalBytes > limits.maxOutputBytes) {
      throw new ProductStoreV2Error("run_output_byte_limit: successful outputs exceed the frozen byte limit.");
    }
    const owner = { kind: "run" as const, id: input.runId };
    const files = outputs.map((output) => ({
      operation: "write" as const,
      target: {
        owner,
        runProjectId: run.projectId,
        relativePath: output.relativePath,
      } satisfies OwnerPath,
      bytes: output.bytes,
      expectedPriorSha256: null,
    }));
    const statements: DatabaseMutationStatement[] = [
      {
        sql: "UPDATE dispatcher_state SET activated_at = activated_at WHERE singleton = 1 AND generation = ?",
        params: [input.dispatcherGeneration],
        expectedChanges: 1,
      },
      {
        sql: `UPDATE run_attempts SET state = 'succeeded', finished_at = ?, heartbeat_at = ?
          WHERE id = ? AND run_id = ? AND attempt_generation = ?
            AND dispatcher_generation = ? AND state = 'running'
            AND EXISTS (
              SELECT 1 FROM runs r
              WHERE r.id = run_attempts.run_id AND r.status = 'running'
                AND r.cancel_requested_at IS NULL
                AND r.first_cancel_command_id IS NULL
            )
            AND (
              SELECT count(*) FROM process_attempts
              WHERE run_attempt_id = run_attempts.id
                AND state = 'cleanup_complete' AND exit_code = 0
            ) = ?
            AND NOT EXISTS (
              SELECT 1 FROM process_attempts
              WHERE run_attempt_id = run_attempts.id
                AND (state != 'cleanup_complete' OR exit_code != 0)
            )`,
        params: [
          input.finishedAt,
          input.finishedAt,
          input.attemptId,
          input.runId,
          input.attemptGeneration,
          input.dispatcherGeneration,
          samples.length,
        ],
        expectedChanges: 1,
      },
      {
        sql: `UPDATE runs
          SET status = 'succeeded', terminal_code = 'run_succeeded',
            terminal_diagnostics_json = ?, resource_overview_json = ?,
            finished_at = ?, updated_at = ?
          WHERE id = ? AND contract_version = 4 AND run_kind = 'batch'
            AND status = 'running'
            AND cancel_requested_at IS NULL AND first_cancel_command_id IS NULL`,
        params: [
          json(input.terminalDiagnostics),
          json(input.resourceOverview),
          input.finishedAt,
          input.finishedAt,
          input.runId,
        ],
        expectedChanges: 1,
      },
      ...outputs.flatMap((output): DatabaseMutationStatement[] => [
        objectInsert({
          id: output.objectFileId,
          owner,
          kind: "run_file",
          relativePath: output.relativePath,
          mediaType: output.mediaType,
          sizeBytes: output.bytes.byteLength,
          digest: output.digest,
          createdAt: input.finishedAt,
        }),
        {
          sql: `INSERT INTO output_indexes
            (id, run_id, object_file_id, logical_name, output_type, contract_version, legacy_digest,
              sample_index, sample_id, declared_role, output_contract_sha256, created_at)
            VALUES (?, ?, ?, ?, ?, 4, NULL, ?, ?, ?, ?, ?)`,
          params: [
            output.id,
            input.runId,
            output.objectFileId,
            output.logicalName,
            output.outputType,
            output.sampleIndex,
            output.sampleId,
            output.declaredRole,
            output.outputContractDigest,
            input.finishedAt,
          ],
          expectedChanges: 1,
        },
      ]),
    ];
    withAtomicBatchSuccessRunContext(this.#database, input.runId, () => {
      this.#coordinator.execute({
        transactionId: `mutation_${canonicalDigest({
          kind: "batch_success",
          runId: input.runId,
          attemptGeneration: input.attemptGeneration,
        }).slice(0, 48)}`,
        files,
        statements,
      });
    });
    return Object.freeze({
      run: runRecord(this.#database.prepare("SELECT * FROM runs WHERE id = ?").get(input.runId)) as Extract<RunRecord, { contractVersion: 4 }>,
      outputs: Object.freeze(this.listRunOutputs(input.runId)
        .filter((output): output is Extract<OutputIndexRecord, { contractVersion: 4 }> => output.contractVersion === 4)),
    });
  }

  listModels(options: { includeArchived?: boolean; includeTrashed?: boolean } = {}): ModelRecord[] {
    return (this.#database.prepare(`SELECT * FROM models ORDER BY id`).all() as any[]).map(modelRecord)
      .filter((row) => visible(row.lifecycleState, options));
  }

  listProjects(options: { includeArchived?: boolean; includeTrashed?: boolean } = {}): ProjectRecord[] {
    return (this.#database.prepare(`SELECT * FROM projects ORDER BY id`).all() as any[]).map(projectRecord)
      .filter((row) => visible(row.lifecycleState, options));
  }

  getProject(id: string): ProjectRecord {
    assertId(id);
    return this.#project(id);
  }

  listExperimentConfigurations(projectId: string, options: { includeArchived?: boolean; includeTrashed?: boolean } = {}): ExperimentConfigurationRecord[] {
    assertId(projectId);
    return (this.#database.prepare("SELECT * FROM experiment_configurations WHERE project_id = ? ORDER BY updated_at DESC, id").all(projectId) as any[])
      .map(experimentConfigurationRecord)
      .filter((row) => visible(row.lifecycleState, options));
  }

  listRuns(projectId: string, options: { includeTrashed?: boolean } = {}): RunRecord[] {
    assertId(projectId);
    return (this.#database.prepare("SELECT * FROM runs WHERE project_id = ? ORDER BY updated_at DESC, id").all(projectId) as any[])
      .map(runRecord)
      .filter((row) => row.status !== "trashed" || Boolean(options.includeTrashed));
  }

  getRun(projectId: string, runId: string, options: { includeTrashed?: boolean } = {}): RunRecord {
    assertId(projectId);
    assertId(runId);
    const row = this.#database.prepare(
      "SELECT * FROM runs WHERE id = ? AND project_id = ?",
    ).get(runId, projectId) as any;
    if (!row) throw new ProductStoreV2Error("Run does not exist.");
    const run = runRecord(row);
    if (run.status === "trashed" && !options.includeTrashed) {
      throw new ProductStoreV2Error("Run does not exist.");
    }
    return run;
  }

  listRunAttempts(runId: string): RunAttemptRecord[] {
    assertId(runId);
    return (this.#database.prepare(
      "SELECT * FROM run_attempts WHERE run_id = ? ORDER BY attempt_generation",
    ).all(runId) as any[]).map(runAttemptRecord);
  }

  listPriorDispatcherRecoveryUnits(): PriorDispatcherRecoveryUnit[] {
    this.#assertOpen();
    const attempts = this.#database.prepare(`SELECT a.*
      FROM run_attempts a
      JOIN runs r ON r.id = a.run_id
      WHERE r.contract_version = 4
        AND a.state IN ('claimed', 'starting', 'running')
      ORDER BY a.claimed_at, a.id`
    ).all() as any[];
    return attempts.map((row) => {
      const attempt = runAttemptRecord({
        id: row.id,
        run_id: row.run_id,
        attempt_generation: row.attempt_generation,
        dispatcher_generation: row.dispatcher_generation,
        state: row.state,
        claimed_at: row.claimed_at,
        lease_expires_at: row.lease_expires_at,
        heartbeat_at: row.heartbeat_at,
        started_at: row.started_at,
        finished_at: row.finished_at,
      });
      const run = runRecord(this.#database.prepare("SELECT * FROM runs WHERE id = ?").get(attempt.runId));
      if (run.contractVersion !== 4) throw new ProductStoreV2Error("legacy_contract_read_only: recovery cannot include a v3 run.");
      const leases = (this.#database.prepare(
        "SELECT * FROM run_scratch_leases WHERE run_attempt_id = ? ORDER BY sample_index, id",
      ).all(attempt.id) as any[]).map(scratchLeaseRecord);
      const processRows = this.#database.prepare(`SELECT
          p.*, s.id AS scratch_id, s.relative_path, s.owner_uid, s.device, s.inode,
          s.state AS scratch_state, s.registered_at AS scratch_registered_at,
          m.id AS manifest_id, m.state AS manifest_state, m.manifest_json,
          m.manifest_sha256, m.launch_receipt_json, m.launch_receipt_sha256
        FROM process_attempts p
        LEFT JOIN process_launch_manifests m ON m.process_attempt_id = p.id
        LEFT JOIN run_scratch_leases s ON s.id = m.scratch_lease_id
        WHERE p.run_attempt_id = ?
        ORDER BY p.sample_index, p.id`
      ).all(attempt.id) as any[];
      const processes = processRows.map((process): RecoveryProcessRecord => {
        if (!process.scratch_id || !process.manifest_id || !process.manifest_sha256
          || process.owner_uid === null || process.device === null || process.inode === null
          || !process.scratch_registered_at) {
          throw new ProductStoreV2Error(
            "dispatcher_recovery_required: a live process lacks durable launch or scratch evidence.",
          );
        }
        assertStoredProcessLaunchEvidence(process, attempt);
        return Object.freeze({
          runId: attempt.runId,
          attemptId: attempt.id,
          attemptGeneration: attempt.attemptGeneration,
          dispatcherGeneration: attempt.dispatcherGeneration,
          processAttemptId: process.id,
          sampleIndex: process.sample_index,
          sampleId: process.sample_id,
          pid: process.pid,
          processStartToken: process.process_start_token,
          processGroupId: process.process_group_id,
          scratchId: process.scratch_id,
          scratchLease: Object.freeze({
            runId: attempt.runId,
            sampleIndex: process.sample_index,
            sampleId: process.sample_id,
            scratchId: process.scratch_id,
            relativePath: process.relative_path,
            ownerUid: process.owner_uid,
            device: process.device,
            inode: process.inode,
            registeredAt: process.scratch_registered_at,
          }),
          launchManifest: Object.freeze({
            manifestId: process.manifest_id,
            manifestDigest: process.manifest_sha256,
          }),
          state: process.state,
          exitCode: process.exit_code,
          exitSignal: process.exit_signal,
        });
      });
      const pendingLaunches = (this.#database.prepare(`SELECT
          m.id AS manifest_id, m.manifest_sha256, s.*
        FROM process_launch_manifests m
        JOIN run_scratch_leases s ON s.id = m.scratch_lease_id
        WHERE m.run_attempt_id = ? AND m.process_attempt_id IS NULL
          AND s.state != 'cleanup_complete'
        ORDER BY s.sample_index, m.id`
      ).all(attempt.id) as any[]).map((pending): PendingLaunchRecoveryRecord => Object.freeze({
        scratchLease: scratchLeaseRecord(pending),
        launchManifest: Object.freeze({
          manifestId: pending.manifest_id,
          manifestDigest: pending.manifest_sha256,
        }),
      }));
      return Object.freeze({
        run,
        attempt,
        processes: Object.freeze(processes),
        scratchLeases: Object.freeze(leases),
        pendingLaunches: Object.freeze(pendingLaunches),
      });
    });
  }

  beginRunRecovery(input: {
    attemptId: string;
    priorDispatcherGeneration: string;
    candidateDispatcherGeneration: string;
    createdAt: IsoTimestamp;
  }): string {
    assertId(input.attemptId);
    assertDigest(input.priorDispatcherGeneration, "Prior dispatcher generation");
    assertDigest(input.candidateDispatcherGeneration, "Candidate dispatcher generation");
    const action = {
      schemaVersion: 1,
      kind: "cross_restart_recovery",
      attemptId: input.attemptId,
      priorDispatcherGeneration: input.priorDispatcherGeneration,
      candidateDispatcherGeneration: input.candidateDispatcherGeneration,
    };
    const id = `recovery_${canonicalDigest(action).slice(0, 32)}`;
    return this.#withImmediateTransaction(() => {
      this.#assertCurrentDispatcherGeneration(input.priorDispatcherGeneration);
      const started = this.#database.prepare(`SELECT id
        FROM run_recovery_actions
        WHERE run_attempt_id = ? AND prior_dispatcher_generation = ? AND state = 'started'
        ORDER BY id`
      ).all(input.attemptId, input.priorDispatcherGeneration) as Array<{ id: string }>;
      if (started.length > 1) {
        throw new ProductStoreV2Error("dispatcher_recovery_required: multiple started recovery actions are ambiguous.");
      }
      if (started.length === 1) {
        // A backend crash mints a fresh candidate generation. The unfinished
        // action still owns the same prior attempt and must be adopted instead
        // of stranded behind its original random candidate generation.
        return started[0]!.id;
      }
      const prior = this.#database.prepare(
        "SELECT state FROM run_recovery_actions WHERE id = ?",
      ).get(id) as { state: string } | undefined;
      if (prior) {
        if (prior.state !== "started") {
          throw new ProductStoreV2Error("dispatcher_recovery_required: a terminal recovery action cannot be replayed.");
        }
        return id;
      }
      this.#executeDatabaseStatements([{
        sql: `INSERT INTO run_recovery_actions
          (id, run_attempt_id, prior_dispatcher_generation, candidate_dispatcher_generation,
            state, action_json, action_sha256, created_at)
          VALUES (?, ?, ?, ?, 'started', ?, ?, ?)`,
        params: [
          id,
          input.attemptId,
          input.priorDispatcherGeneration,
          input.candidateDispatcherGeneration,
          json(action),
          canonicalDigest(action),
          input.createdAt,
        ],
        expectedChanges: 1,
      }]);
      return id;
    });
  }

  adoptRecoveredLaunchReceipt(input: RunAttemptIdentity & {
    processAttemptId: string;
    launchReceipt: BatchLaunchReceipt;
    launchedAt: IsoTimestamp;
  }): ProcessAttemptRecord {
    const receipt = input.launchReceipt;
    return this.registerBatchProcessAttempt({
      ...input,
      sampleIndex: receipt.sampleIndex,
      sampleId: receipt.sampleId,
      pid: receipt.pid,
      processStartToken: receipt.processStartToken,
      processGroupId: receipt.processGroupId,
      scratchId: receipt.scratchId,
      launchReceipt: receipt,
      launchedAt: input.launchedAt,
    });
  }

  finalizeUnlaunchedScratchLease(input: {
    leaseId: string;
    runAttemptId: string;
    receipt: RecoveredScratchCleanupReceipt;
  }): void {
    assertId(input.leaseId);
    assertId(input.runAttemptId);
    this.#databaseMutation([{
      sql: `UPDATE run_scratch_leases
        SET state = 'cleanup_complete', cleaned_at = ?,
          cleanup_receipt_json = ?, cleanup_receipt_sha256 = ?
        WHERE id = ? AND run_attempt_id = ?
          AND state IN ('planned', 'created')`,
      params: [
        input.receipt.cleanedAt,
        json(input.receipt),
        canonicalDigest(input.receipt),
        input.leaseId,
        input.runAttemptId,
      ],
      expectedChanges: 1,
      mismatchMessage: "scratch_cleanup_unverified: unlaunched scratch cleanup lost its lease.",
    }]);
  }

  completeRecoveredRun(input: RunAttemptIdentity & {
    recoveryActionId: string;
    disposition: "interrupted" | "cancelled";
    processReceipts: readonly RecoveredProcessTerminationReceipt[];
    scratchReceipts: readonly RecoveredScratchCleanupReceipt[];
    finishedAt: IsoTimestamp;
  }): Extract<RunRecord, { contractVersion: 4 }> {
    assertRunAttemptIdentity(input);
    assertId(input.recoveryActionId);
    const receipt = {
      schemaVersion: 1,
      kind: "run_cross_restart_cleanup",
      runId: input.runId,
      attemptId: input.attemptId,
      disposition: input.disposition,
      processReceiptDigests: [...input.processReceipts].map((item) => item.receiptDigest).sort(),
      scratchReceiptDigests: [...input.scratchReceipts].map((item) => item.receiptDigest).sort(),
      finishedAt: input.finishedAt,
      verified: true,
    };
    return this.#withImmediateTransaction(() => {
      this.#assertCurrentDispatcherGeneration(input.dispatcherGeneration);
      const run = this.#database.prepare(`SELECT cancel_requested_at, first_cancel_command_id
        FROM runs WHERE id = ? AND contract_version = 4 AND status = 'running'`
      ).get(input.runId) as { cancel_requested_at: string | null; first_cancel_command_id: string | null } | undefined;
      if (!run) throw new ProductStoreV2Error("invalid_run_transition: recovered run is no longer running.");
      const cancellationWon = run.cancel_requested_at !== null && run.first_cancel_command_id !== null;
      if ((input.disposition === "cancelled") !== cancellationWon) {
        throw new ProductStoreV2Error("run_cancellation_won: recovery disposition violates committed cancellation precedence.");
      }
      const openProcesses = Number((this.#database.prepare(`SELECT count(*) AS count
        FROM process_attempts WHERE run_attempt_id = ? AND state != 'cleanup_complete'`
      ).get(input.attemptId) as { count: number }).count);
      const openLeases = Number((this.#database.prepare(`SELECT count(*) AS count
        FROM run_scratch_leases WHERE run_attempt_id = ? AND state != 'cleanup_complete'`
      ).get(input.attemptId) as { count: number }).count);
      if (openProcesses || openLeases) {
        throw new ProductStoreV2Error("process_cleanup_unverified: recovery cannot finalize before every process and scratch lease is clean.");
      }
      const runStatus = cancellationWon ? "cancelled" : "failed";
      const attemptState = cancellationWon ? "cancelled" : "interrupted";
      const terminalCode = cancellationWon ? "run_cancelled" : "runtime_interrupted";
      this.#executeDatabaseStatements([
        {
          sql: `UPDATE run_attempts SET state = ?, finished_at = ?, heartbeat_at = ?
            WHERE id = ? AND run_id = ? AND attempt_generation = ?
              AND dispatcher_generation = ? AND state IN ('claimed', 'starting', 'running')`,
          params: [
            attemptState,
            input.finishedAt,
            input.finishedAt,
            input.attemptId,
            input.runId,
            input.attemptGeneration,
            input.dispatcherGeneration,
          ],
          expectedChanges: 1,
        },
        {
          sql: `UPDATE runs SET status = ?, terminal_code = ?,
              terminal_diagnostics_json = ?, resource_overview_json = '{}',
              finished_at = ?, updated_at = ?
            WHERE id = ? AND contract_version = 4 AND status = 'running'`,
          params: [
            runStatus,
            terminalCode,
            json({
              code: terminalCode,
              diagnostic: cancellationWon
                ? "Cancellation committed before cross-restart recovery."
                : "The prior runtime was interrupted and reconciled before dispatcher generation handoff.",
            }),
            input.finishedAt,
            input.finishedAt,
            input.runId,
          ],
          expectedChanges: 1,
        },
        {
          sql: `UPDATE run_recovery_actions
            SET state = 'completed', terminal_disposition = ?,
              cleanup_receipt_json = ?, cleanup_receipt_sha256 = ?, finished_at = ?
            WHERE id = ? AND run_attempt_id = ? AND state = 'started'`,
          params: [
            input.disposition,
            json(receipt),
            canonicalDigest(receipt),
            input.finishedAt,
            input.recoveryActionId,
            input.attemptId,
          ],
          expectedChanges: 1,
        },
      ]);
      return runRecord(this.#database.prepare("SELECT * FROM runs WHERE id = ?").get(input.runId)) as Extract<RunRecord, { contractVersion: 4 }>;
    });
  }

  failRunRecovery(input: {
    recoveryActionId: string;
    attemptId: string;
    failedAt: IsoTimestamp;
  }): void {
    this.#databaseMutation([{
      sql: `UPDATE run_recovery_actions
        SET state = 'failed', finished_at = ?
        WHERE id = ? AND run_attempt_id = ? AND state = 'started'`,
      params: [input.failedAt, input.recoveryActionId, input.attemptId],
      expectedChanges: 1,
    }]);
  }

  auditRecoveredBatchSuccesses(): void {
    this.#assertOpen();
    const rows = this.#database.prepare(`SELECT id, project_id
      FROM runs
      WHERE contract_version = 4 AND run_kind = 'batch' AND status = 'succeeded'
      ORDER BY id`
    ).all() as Array<{ id: string; project_id: string }>;
    for (const row of rows) {
      const run = this.getRun(row.project_id, row.id);
      if (run.contractVersion !== 4) continue;
      const attempt = this.#database.prepare(`SELECT id, attempt_generation
        FROM run_attempts WHERE run_id = ? AND state = 'succeeded'
        ORDER BY attempt_generation DESC LIMIT 1`
      ).get(row.id) as { id: string; attempt_generation: number } | undefined;
      if (!attempt) {
        throw new ProductStoreV2Error("batch_success_recovery_invalid: succeeded run lacks a succeeded attempt.");
      }
      const transactionId = `mutation_${canonicalDigest({
        kind: "batch_success",
        runId: row.id,
        attemptGeneration: attempt.attempt_generation,
      }).slice(0, 48)}`;
      if (!this.#database.prepare(
        "SELECT 1 FROM committed_mutations WHERE transaction_id = ?",
      ).get(transactionId)) {
        throw new ProductStoreV2Error("batch_success_recovery_invalid: succeeded run lacks its committed mutation receipt.");
      }
      const samples = run.samplePlan as Array<{ sampleIndex: number; sampleId: string }>;
      const processes = this.#database.prepare(`SELECT sample_index, sample_id, state, exit_code
        FROM process_attempts WHERE run_attempt_id = ? ORDER BY sample_index, id`
      ).all(attempt.id) as Array<{
        sample_index: number;
        sample_id: string;
        state: string;
        exit_code: number | null;
      }>;
      if (processes.length !== samples.length || processes.some((process, index) =>
        process.sample_index !== samples[index]?.sampleIndex
        || process.sample_id !== samples[index]?.sampleId
        || process.state !== "cleanup_complete"
        || process.exit_code !== 0)) {
        throw new ProductStoreV2Error(
          "batch_success_recovery_invalid: success requires one cleaned zero-exit process per frozen sample.",
        );
      }
      let execution: ExecutionDescriptionV2;
      try {
        execution = validateExecutionDescriptionV2(this.#project(run.projectId).executionDescription);
        assertRunCapabilityV2(execution, "batch");
      } catch (error) {
        throw new ProductStoreV2Error(
          "batch_success_recovery_invalid: the frozen execution output contract is invalid.",
          { cause: error },
        );
      }
      if (canonicalDigest(execution) !== run.executionDescriptionDigest) {
        throw new ProductStoreV2Error(
          "batch_success_recovery_invalid: the execution output contract digest changed.",
        );
      }
      const declarations = new Map(execution.outputs.map((output) => [output.logicalName, output]));
      const seen = new Set<string>();
      const outputs = this.listRunOutputs(row.id);
      for (const output of outputs) {
        if (output.contractVersion !== 4) {
          throw new ProductStoreV2Error("batch_success_recovery_invalid: succeeded v4 run contains a legacy output.");
        }
        const sample = samples[output.sampleIndex];
        const declaration = declarations.get(output.logicalName);
        const key = `${output.sampleIndex}:${output.logicalName}`;
        const expectedContractDigest = canonicalDigest({
          runId: run.id,
          logicalName: output.logicalName,
          outputType: output.outputType,
          sampleIndex: output.sampleIndex,
          sampleId: output.sampleId,
          declaredRole: output.declaredRole,
        });
        if (!sample || sample.sampleIndex !== output.sampleIndex || sample.sampleId !== output.sampleId
          || !declaration || seen.has(key)
          || output.declaredRole !== declaration.role
          || output.file.mediaType !== declaration.mediaType
          || output.outputContractDigest !== expectedContractDigest) {
          throw new ProductStoreV2Error(
            "batch_success_recovery_invalid: a recovered output contradicts its frozen sample or declaration.",
          );
        }
        seen.add(key);
      }
      for (const sample of samples) {
        for (const declaration of execution.outputs) {
          if (declaration.required && !seen.has(`${sample.sampleIndex}:${declaration.logicalName}`)) {
            throw new ProductStoreV2Error(
              "batch_success_recovery_invalid: a required recovered output is missing.",
            );
          }
        }
      }
    }
  }

  projectExecutionCapability(projectId: string): ProjectExecutionCapability {
    assertId(projectId);
    const row = this.#database.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as any;
    if (!row || row.lifecycle_state !== "active") {
      throw new ProductStoreV2Error("Project does not exist or is not active.");
    }
    const expectedExecutionRootDigest = this.#verifyFrozenProject(row);
    let execution: ExecutionDescriptionV2;
    try {
      execution = validateExecutionDescriptionV2(JSON.parse(row.execution_description_json));
    } catch (error) {
      if (error instanceof ExecutionProtocolV2Error) {
        throw new ProductStoreV2Error(`${error.code}: ${error.message}`, { cause: error });
      }
      throw error;
    }
    const snapshotRoot = this.#objects.resolveOwnerPath({
      owner: { kind: "project", id: projectId },
      relativePath: "model-snapshot",
    });
    const workspace = createModelWorkspaceCapability(snapshotRoot, `project-execution:${projectId}`);
    return Object.freeze({
      workspace: verifyProjectExecutionRootCapability(workspace, execution, expectedExecutionRootDigest),
      executionDescription: execution,
    });
  }

  listRunOutputs(runId: string): OutputIndexRecord[] {
    assertId(runId);
    return (this.#database.prepare(`SELECT
        o.id AS output_index_id, o.run_id AS output_run_id, o.object_file_id AS output_object_file_id,
        o.logical_name, o.output_type, o.contract_version AS output_contract_version,
        o.legacy_digest AS output_legacy_digest, o.sample_index, o.sample_id, o.declared_role,
        o.output_contract_sha256,
        o.created_at AS output_created_at,
        f.*, r.project_id AS run_project_id
      FROM output_indexes o
      JOIN object_files f ON f.id = o.object_file_id
      JOIN runs r ON r.id = o.run_id
      WHERE o.run_id = ?
      ORDER BY o.logical_name, o.id`).all(runId) as any[]).map((row) => {
      const verifiedFile = this.#verifiedMetadata(row);
      const record = {
        id: row.output_index_id,
        runId: row.output_run_id,
        logicalName: row.logical_name,
        outputType: row.output_type,
        file: verifiedFile,
        createdAt: row.output_created_at,
      };
      return row.output_contract_version === 3
        ? Object.assign(record, {
          contractVersion: 3 as const,
          readOnly: true as const,
          legacyDigest: row.output_legacy_digest,
        })
        : Object.assign(record, {
          contractVersion: 4 as const,
          readOnly: false as const,
          legacyDigest: null,
          sampleIndex: row.sample_index,
          sampleId: row.sample_id,
          declaredRole: row.declared_role,
          outputContractDigest: row.output_contract_sha256,
        });
    });
  }

  renameResource(kind: NamedManagedResourceKind, id: string, name: string, updatedAt: IsoTimestamp): void {
    this.#assertMutableExecutionContract(kind, id);
    const { table } = managedTable(kind);
    this.#databaseMutation([{ sql: `UPDATE ${table} SET name = ?, updated_at = ? WHERE id = ? AND lifecycle_state != 'trashed'`, params: [name, updatedAt, id], expectedChanges: 1 }]);
  }

  archiveResource(kind: NamedManagedResourceKind, id: string, at: IsoTimestamp): void {
    this.#assertMutableExecutionContract(kind, id);
    const { table } = managedTable(kind);
    this.#databaseMutation([{ sql: `UPDATE ${table} SET lifecycle_state = 'archived', archived_at = ?, updated_at = ?
      WHERE id = ? AND lifecycle_state = 'active'`, params: [at, at, id], expectedChanges: 1 }]);
  }

  restoreResource(kind: ManagedResourceKind, id: string, at: IsoTimestamp): void {
    this.#assertMutableExecutionContract(kind, id);
    if (kind === "run") {
      const row = this.#database.prepare("SELECT status, pre_trash_status FROM runs WHERE id = ?").get(id) as { status: RunStatus; pre_trash_status: RunStatus | null } | undefined;
      if (!row || row.status !== "trashed" || !row.pre_trash_status) throw new ProductStoreV2Error("Run is not restorable from trash.");
      this.#databaseMutation([
        { sql: "UPDATE runs SET status = ?, pre_trash_status = NULL, trashed_at = NULL, updated_at = ? WHERE id = ? AND status = 'trashed'", params: [row.pre_trash_status, at, id], expectedChanges: 1 },
        { sql: "UPDATE trash_entries SET restored_at = ? WHERE run_id = ? AND restored_at IS NULL", params: [at, id], expectedChanges: 1 },
      ]);
      return;
    }
    const { table, trashColumn } = managedTable(kind);
    const row = this.#database.prepare(`SELECT lifecycle_state, pre_trash_state FROM ${table} WHERE id = ?`).get(id) as { lifecycle_state: LifecycleState; pre_trash_state: "active" | "archived" | null } | undefined;
    if (!row) throw new ProductStoreV2Error("Resource does not exist.");
    if (row.lifecycle_state === "archived") {
      this.#databaseMutation([{ sql: `UPDATE ${table} SET lifecycle_state = 'active', archived_at = NULL, updated_at = ? WHERE id = ? AND lifecycle_state = 'archived'`, params: [at, id], expectedChanges: 1 }]);
      return;
    }
    if (row.lifecycle_state !== "trashed" || !row.pre_trash_state) throw new ProductStoreV2Error("Resource is not restorable.");
    this.#databaseMutation([
      { sql: `UPDATE ${table} SET lifecycle_state = ?, pre_trash_state = NULL, trashed_at = NULL, updated_at = ? WHERE id = ? AND lifecycle_state = 'trashed'`, params: [row.pre_trash_state, at, id], expectedChanges: 1 },
      { sql: `UPDATE trash_entries SET restored_at = ? WHERE ${trashColumn} = ? AND restored_at IS NULL`, params: [at, id], expectedChanges: 1 },
    ]);
  }

  trashResource(kind: ManagedResourceKind, id: string, at: IsoTimestamp): void {
    this.#assertMutableExecutionContract(kind, id);
    const trashId = `trash_${randomUUID().replaceAll("-", "")}`;
    if (kind === "run") {
      const row = this.#database.prepare("SELECT status FROM runs WHERE id = ?").get(id) as { status: RunStatus } | undefined;
      if (!row || row.status === "trashed") throw new ProductStoreV2Error("Run is not trashable.");
      this.#databaseMutation([
        { sql: "UPDATE runs SET status = 'trashed', pre_trash_status = ?, trashed_at = ?, updated_at = ? WHERE id = ? AND status = ?", params: [row.status, at, at, id, row.status], expectedChanges: 1 },
        { sql: "INSERT INTO trash_entries (id, run_id, prior_state, trashed_at) VALUES (?, ?, ?, ?)", params: [trashId, id, row.status, at], expectedChanges: 1 },
      ]);
      return;
    }
    const { table, trashColumn } = managedTable(kind);
    const row = this.#database.prepare(`SELECT lifecycle_state FROM ${table} WHERE id = ?`).get(id) as { lifecycle_state: LifecycleState } | undefined;
    if (!row || row.lifecycle_state === "trashed") throw new ProductStoreV2Error("Resource is not trashable.");
    this.#databaseMutation([
      { sql: `UPDATE ${table} SET lifecycle_state = 'trashed', pre_trash_state = ?, trashed_at = ?, updated_at = ? WHERE id = ? AND lifecycle_state = ?`, params: [row.lifecycle_state, at, at, id, row.lifecycle_state], expectedChanges: 1 },
      { sql: `INSERT INTO trash_entries (id, ${trashColumn}, prior_state, trashed_at) VALUES (?, ?, ?, ?)`, params: [trashId, id, row.lifecycle_state, at], expectedChanges: 1 },
    ]);
  }

  previewPermanentDelete(kind: ManagedResourceKind, id: string): PermanentDeletePreview {
    this.#assertOpen();
    const target = { kind, id };
    const records: PermanentDeletePreview["records"] = [];
    const blockers: PermanentDeletePreview["blockingReferences"] = [];
    const exclusions: PermanentDeletePreview["exclusions"] = [];
    const fileRows: ObjectRow[] = [];
    const stateRows: unknown[] = [];
    const addRows = (table: string, rows: any[], key: (row: any) => Record<string, string | number> = (row) => ({ id: row.id })) => {
      for (const row of rows) { records.push({ table, key: key(row) }); stateRows.push({ table, row: { ...row } }); }
    };
    const row = this.#database.prepare(`SELECT * FROM ${managedTable(kind).table} WHERE id = ?`).get(id) as any;
    if (!row) throw new ProductStoreV2Error("Preview target does not exist.");
    addRows(managedTable(kind).table, [row]);

    if (kind === "model" || kind === "project") {
      const ownerColumn = kind === "model" ? "model_id" : "project_id";
      const conversations = this.#database.prepare(`SELECT * FROM conversations WHERE ${ownerColumn} = ? ORDER BY id`).all(id) as any[];
      addRows("conversations", conversations);
      this.#collectConversationClosure(conversations.map((item) => item.id), addRows, fileRows, blockers, exclusions);
      fileRows.push(...this.#objectRows(`owner_${kind}_id = ?`, [id]));
      if (kind === "model") {
        addRows("model_technical_checks", this.#database.prepare("SELECT * FROM model_technical_checks WHERE model_id = ? ORDER BY id").all(id) as any[]);
        for (const project of this.#database.prepare("SELECT id FROM projects WHERE source_model_id = ? ORDER BY id").all(id) as Array<{ id: string }>) blockers.push({ kind: "project_lineage", id: project.id });
      } else {
        exclusions.push({ kind: "model", id: row.source_model_id, reason: "source lineage outside project closure" });
        const experiments = this.#database.prepare("SELECT * FROM experiment_configurations WHERE project_id = ? ORDER BY id").all(id) as any[];
        addRows("experiment_configurations", experiments);
        addRows("experiment_command_receipts",
          this.#database.prepare("SELECT * FROM experiment_command_receipts WHERE project_id = ? ORDER BY command_id").all(id) as any[],
          (receipt) => ({ command_id: receipt.command_id }));
        const runs = this.#database.prepare("SELECT * FROM runs WHERE project_id = ? ORDER BY id").all(id) as any[];
        addRows("runs", runs);
        this.#collectRunExecutionClosure(runs.map((run) => run.id), addRows, fileRows);
      }
    } else if (kind === "conversation") {
      this.#collectConversationClosure([id], addRows, fileRows, blockers, exclusions);
      for (const run of this.#database.prepare(
        "SELECT id FROM runs WHERE completion_conversation_id = ? ORDER BY id",
      ).all(id) as Array<{ id: string }>) blockers.push({ kind: "run_completion_conversation", id: run.id });
    } else if (kind === "temporary_document") {
      exclusions.push({ kind: "conversation", id: row.conversation_id, reason: "owner outside temporary-document closure" });
      if (row.source_message_id) exclusions.push({ kind: "message", id: row.source_message_id, reason: "source reference outside temporary-document closure" });
    } else if (kind === "experiment") {
      const runs = this.#database.prepare("SELECT id FROM runs WHERE experiment_configuration_id = ? ORDER BY id").all(id) as Array<{ id: string }>;
      blockers.push(...runs.map((run) => ({ kind: "run", id: run.id })));
      addRows("experiment_command_receipts",
        this.#database.prepare("SELECT * FROM experiment_command_receipts WHERE experiment_id = ? ORDER BY command_id").all(id) as any[],
        (receipt) => ({ command_id: receipt.command_id }));
      exclusions.push({ kind: "project", id: row.project_id, reason: "owner outside experiment closure" });
    } else {
      this.#collectRunExecutionClosure([id], addRows, fileRows);
      exclusions.push({ kind: "experiment", id: row.experiment_configuration_id, reason: "configuration outside run closure" });
      exclusions.push({ kind: "project", id: row.project_id, reason: "owner outside run closure" });
    }

    const trashBindings: Record<string, string> = {
      models: "model_id", projects: "project_id", conversations: "conversation_id",
      temporary_documents: "temporary_document_id", experiment_configurations: "experiment_configuration_id", runs: "run_id",
    };
    for (const record of [...records]) {
      const column = trashBindings[record.table];
      const resourceId = record.key.id;
      if (!column || typeof resourceId !== "string") continue;
      addRows("trash_entries", this.#database.prepare(`SELECT * FROM trash_entries WHERE ${column} = ? ORDER BY id`).all(resourceId) as any[]);
    }

    const uniqueFiles = [...new Map(fileRows.map((file) => [file.id, file])).values()].sort(compareObjectRows);
    addRows("object_files", uniqueFiles);
    const includedFileIds = new Set(uniqueFiles.map((file) => file.id));
    for (let index = blockers.length - 1; index >= 0; index -= 1) {
      if (blockers[index]!.kind === "adopted_attachment" && includedFileIds.has(blockers[index]!.id)) blockers.splice(index, 1);
    }
    for (let index = exclusions.length - 1; index >= 0; index -= 1) {
      if (exclusions[index]!.kind === "adopted_attachment" && includedFileIds.has(exclusions[index]!.id)) exclusions.splice(index, 1);
    }
    let totalBytes = 0;
    for (const row of uniqueFiles) {
      if (!Number.isSafeInteger(row.size_bytes) || row.size_bytes < 0 || !Number.isSafeInteger(totalBytes + row.size_bytes)) {
        throw new ProductStoreV2Error("Permanent-delete preview byte total is not a safe integer.");
      }
      totalBytes += row.size_bytes;
    }
    const files = uniqueFiles.map((file) => this.#verifiedMetadata(file));
    records.sort((left, right) => compareStrings(canonicalDigest(left), canonicalDigest(right)));
    blockers.sort(compareKindId);
    exclusions.sort(compareKindId);
    const payload = { target, records, files, totalBytes, blockingReferences: blockers, exclusions };
    return { ...payload, previewToken: canonicalDigest(payload), stateToken: canonicalDigest({ target, stateRows, files, blockers, exclusions }) };
  }

  #collectRunExecutionClosure(
    runIds: readonly string[],
    addRows: (table: string, rows: any[], key?: (row: any) => Record<string, string | number>) => void,
    fileRows: ObjectRow[],
  ): void {
    for (const runId of runIds) {
      fileRows.push(...this.#objectRows("owner_run_id = ?", [runId]));
      addRows("output_indexes", this.#database.prepare("SELECT * FROM output_indexes WHERE run_id = ? ORDER BY id").all(runId) as any[]);
      const attempts = this.#database.prepare("SELECT * FROM run_attempts WHERE run_id = ? ORDER BY id").all(runId) as any[];
      addRows("run_attempts", attempts);
      for (const attempt of attempts) {
        addRows("run_scratch_leases",
          this.#database.prepare("SELECT * FROM run_scratch_leases WHERE run_attempt_id = ? ORDER BY id").all(attempt.id) as any[]);
        addRows("process_launch_manifests",
          this.#database.prepare("SELECT * FROM process_launch_manifests WHERE run_attempt_id = ? ORDER BY id").all(attempt.id) as any[]);
        addRows("run_recovery_actions",
          this.#database.prepare("SELECT * FROM run_recovery_actions WHERE run_attempt_id = ? ORDER BY id").all(attempt.id) as any[]);
        addRows("process_attempts",
          this.#database.prepare("SELECT * FROM process_attempts WHERE run_attempt_id = ? ORDER BY id").all(attempt.id) as any[]);
      }
      const commands = this.#database.prepare("SELECT * FROM run_commands WHERE run_id = ? ORDER BY id").all(runId) as any[];
      addRows("run_commands", commands);
      addRows("run_command_receipts",
        this.#database.prepare("SELECT * FROM run_command_receipts WHERE run_id = ? ORDER BY id").all(runId) as any[]);
    }
  }

  listObjectFiles(owner: ResourceOwner): StoredObjectMetadata[] {
    const column = owner.kind === "model" ? "owner_model_id" : owner.kind === "project" ? "owner_project_id" : owner.kind === "conversation" ? "owner_conversation_id" : "owner_run_id";
    return this.#objectRows(`${column} = ?`, [owner.id]).sort(compareObjectRows).map((row) => this.#verifiedMetadata(row));
  }

  replaceModelFile(objectFileId: string, bytesInput: Uint8Array, updatedAt: IsoTimestamp): StoredObjectMetadata {
    const row = this.#objectRow(objectFileId);
    if (!row.owner_model_id || !["model_code", "model_environment", "model_visual_asset", "adopted_attachment"].includes(row.kind)) {
      throw new ProductStoreV2Error("Only a Model-owned file can be replaced through this method.");
    }
    const model = this.#database.prepare("SELECT lifecycle_state FROM models WHERE id = ?").get(row.owner_model_id) as { lifecycle_state: LifecycleState } | undefined;
    if (!model || model.lifecycle_state !== "active") throw new ProductStoreV2Error("Model must be active before its files can change.");
    const bytes = Buffer.from(bytesInput);
    const digest = sha256(bytes);
    this.#coordinator.execute({ files: [{ operation: "write", target: ownerPath(row), bytes, expectedPriorSha256: row.sha256 }], statements: [
      { sql: "UPDATE object_files SET size_bytes = ?, sha256 = ? WHERE id = ? AND sha256 = ?", params: [bytes.byteLength, digest, row.id, row.sha256], expectedChanges: 1 },
      { sql: "UPDATE models SET updated_at = ? WHERE id = ? AND lifecycle_state = 'active'", params: [updatedAt, row.owner_model_id], expectedChanges: 1 },
    ] });
    return this.#file(objectFileId);
  }

  mutateModelFiles(input: { modelId: string; files: ModelFileMutation[]; executionDescription?: Record<string, unknown>; updatedAt: IsoTimestamp; transactionId?: string }): StoredObjectMetadata[] {
    this.#assertOpen();
    if (!input.files.length || new Set(input.files.map((file) => file.objectFileId)).size !== input.files.length) throw new ProductStoreV2Error("Model mutation requires unique files.");
    const plans = input.files.map((file) => {
      assertId(file.objectFileId);
      const relativePath = modelFilePath(file.kind, file.relativePath);
      const prior = this.#database.prepare("SELECT * FROM object_files WHERE id = ?").get(file.objectFileId) as ObjectRow | undefined;
      if (prior) {
        if (prior.owner_model_id !== input.modelId || prior.kind !== file.kind || prior.relative_path !== relativePath || prior.sha256 !== file.expectedPriorSha256) {
          throw new ProductStoreV2Error("Model file mutation precondition or ownership mismatch.");
        }
      } else if (file.expectedPriorSha256 !== null) throw new ProductStoreV2Error("New Model file must expect no prior digest.");
      const bytes = Buffer.from(file.bytes);
      const digest = sha256(bytes);
      return { file, prior, bytes, digest, relativePath, target: { owner: { kind: "model" as const, id: input.modelId }, relativePath } };
    });
    const statements: DatabaseMutationStatement[] = [activeLifecycleGuard("models", input.modelId), ...plans.map(({ file, prior, bytes, digest, relativePath }) => prior ? ({
      sql: "UPDATE object_files SET media_type = ?, size_bytes = ?, sha256 = ? WHERE id = ? AND owner_model_id = ? AND sha256 = ?",
      params: [file.mediaType, bytes.byteLength, digest, file.objectFileId, input.modelId, file.expectedPriorSha256], expectedChanges: 1,
    }) : objectInsert({ id: file.objectFileId, owner: { kind: "model", id: input.modelId }, kind: file.kind, relativePath,
      mediaType: file.mediaType, sizeBytes: bytes.byteLength, digest, createdAt: input.updatedAt })), {
      sql: `UPDATE models SET technical_status = 'draft', execution_description_json = coalesce(?, execution_description_json), updated_at = ?
        WHERE id = ? AND lifecycle_state = 'active'`, params: [input.executionDescription === undefined ? null : json(input.executionDescription), input.updatedAt, input.modelId], expectedChanges: 1,
    }];
    this.#coordinator.execute({ transactionId: input.transactionId, files: plans.map(({ target, bytes, file }) => ({ operation: "write" as const, target, bytes, expectedPriorSha256: file.expectedPriorSha256 })), statements });
    return plans.map(({ file }) => this.#file(file.objectFileId));
  }

  createModelWithFirstConversation(input: { model: CreateModelInput; conversation: Omit<CreateConversationInput, "owner"> }): { model: ModelRecord; conversation: ConversationDto } {
    this.#assertOpen();
    const { model, conversation } = input;
    assertId(model.id); assertId(conversation.id);
    if (!model.files.length) throw new ProductStoreV2Error("A Model requires at least one initial owned file.");
    const owner = { kind: "model" as const, id: model.id };
    const files = model.files.map((file) => {
      assertId(file.id);
      if (!FILE_KINDS.has(file.kind)) throw new ProductStoreV2Error("Initial Model file kind is invalid.");
      const relativePath = modelFilePath(file.kind, file.relativePath); const bytes = Buffer.from(file.bytes); const digest = sha256(bytes);
      return { file, relativePath, bytes, digest, target: { owner, relativePath } satisfies OwnerPath };
    });
    const existing = this.#database.prepare("SELECT id FROM models WHERE id = ?").get(model.id);
    if (existing) {
      const existingModel = this.#database.prepare("SELECT * FROM models WHERE id = ?").get(model.id) as any;
      const existingConversation = this.#database.prepare("SELECT * FROM conversations WHERE id = ? AND model_id = ?").get(conversation.id, model.id) as any;
      const rows = this.#objectRows("owner_model_id = ? AND kind IN ('model_code', 'model_environment', 'model_visual_asset')", [model.id]);
      const matches = existingConversation && existingModel.name === model.name && existingModel.technical_status === model.technicalStatus
        && existingModel.run_mode === model.runMode && existingModel.execution_description_json === json(model.executionDescription)
        && existingModel.created_at === model.createdAt && existingConversation.name === conversation.name
        && existingConversation.provider_id === conversation.providerId && existingConversation.provider_model_id === conversation.providerModelId
        && existingConversation.created_at === conversation.createdAt && rows.length === files.length
        && files.every(({ file, relativePath, bytes, digest }) => rows.some((row) => row.id === file.id && row.kind === file.kind
          && row.relative_path === relativePath && row.media_type === file.mediaType && row.size_bytes === bytes.byteLength && row.sha256 === digest));
      if (!matches) throw new ProductStoreV2Error("Composite Model creation ID was reused with different intent.");
      return { model: this.#model(model.id), conversation: this.getConversation(conversation.id) };
    }
    const statements: DatabaseMutationStatement[] = [{ sql: `INSERT INTO models
      (id, name, technical_status, run_mode, execution_description_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      params: [model.id, model.name, model.technicalStatus, model.runMode, json(model.executionDescription), model.createdAt, model.createdAt], expectedChanges: 1 },
      ...files.map(({ file, bytes, relativePath, digest }) => objectInsert({ id: file.id, owner, kind: file.kind, relativePath, mediaType: file.mediaType,
        sizeBytes: bytes.byteLength, digest, createdAt: model.createdAt })),
      { sql: `INSERT INTO conversations (id, model_id, name, provider_id, provider_model_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        params: [conversation.id, model.id, conversation.name, conversation.providerId, conversation.providerModelId, conversation.createdAt, conversation.createdAt], expectedChanges: 1 }];
    this.#coordinator.execute({ transactionId: stableTransactionId("create_model_conversation", model.id),
      files: files.map(({ target, bytes }) => ({ operation: "write" as const, target, bytes, expectedPriorSha256: null })), statements });
    return { model: this.#model(model.id), conversation: this.getConversation(conversation.id) };
  }

  startTechnicalCheck(input: { id: string; modelId: string; limits: Record<string, unknown>; startedAt: IsoTimestamp }): {
    workspaceDigest: string;
    executionDescriptionDigest: string;
    executionDescription: Record<string, unknown>;
  } {
    assertId(input.id);
    const model = this.#database.prepare("SELECT execution_description_json FROM models WHERE id = ? AND lifecycle_state = 'active'").get(input.modelId) as { execution_description_json: string } | undefined;
    if (!model) throw new ProductStoreV2Error("Technical check requires an active Model.");
    const files = this.#objectRows("owner_model_id = ? AND kind IN ('model_code', 'model_environment', 'model_visual_asset', 'adopted_attachment')", [input.modelId]);
    files.forEach((file) => this.#verifiedMetadata(file));
    const workspaceDigest = workspaceDigestOf(files);
    const executionDescription = JSON.parse(model.execution_description_json) as Record<string, unknown>;
    const executionDescriptionDigest = canonicalDigest(executionDescription);
    this.#databaseMutation([activeLifecycleGuard("models", input.modelId), { sql: `INSERT INTO model_technical_checks
      (id, model_id, workspace_sha256, execution_description_sha256, state, results_json, limits_json, started_at)
      VALUES (?, ?, ?, ?, 'running', '{}', ?, ?)`, params: [input.id, input.modelId, workspaceDigest, executionDescriptionDigest, json(input.limits), input.startedAt], expectedChanges: 1 },
      { sql: `UPDATE models SET technical_status = 'checking', updated_at = ? WHERE id = ? AND lifecycle_state = 'active'`, params: [input.startedAt, input.modelId], expectedChanges: 1 }]);
    return { workspaceDigest, executionDescriptionDigest, executionDescription };
  }

  finishTechnicalCheck(input: { id: string; state: "passed" | "failed" | "cancelled"; results: Record<string, unknown>; finishedAt: IsoTimestamp }): { published: boolean } {
    const row = this.#database.prepare(`SELECT t.*, m.execution_description_json FROM model_technical_checks t JOIN models m ON m.id = t.model_id WHERE t.id = ?`)
      .get(input.id) as any;
    if (!row || row.state !== "running") throw new ProductStoreV2Error("Technical check is not running.");
    const currentFiles = this.#objectRows("owner_model_id = ? AND kind IN ('model_code', 'model_environment', 'model_visual_asset', 'adopted_attachment')", [row.model_id]);
    const workspaceDigest = workspaceDigestOf(currentFiles);
    const executionDigest = canonicalDigest(JSON.parse(row.execution_description_json));
    const publish = workspaceDigest === row.workspace_sha256 && executionDigest === row.execution_description_sha256;
    this.#databaseMutation([{ sql: `UPDATE model_technical_checks SET state = ?, results_json = ?, finished_at = ? WHERE id = ? AND state = 'running'`,
      params: [input.state, json({ ...input.results, published: publish }), input.finishedAt, input.id], expectedChanges: 1 },
      ...(publish ? [{ sql: "UPDATE models SET technical_status = ?, updated_at = ? WHERE id = ? AND technical_status = 'checking'",
        params: [input.state === "passed" ? "executable" : "failed", input.finishedAt, row.model_id], expectedChanges: 1 } satisfies DatabaseMutationStatement] : [])]);
    return { published: publish };
  }

  getTechnicalCheck(modelId: string, id: string): TechnicalCheckRecord {
    assertId(modelId); assertId(id);
    const row = this.#database.prepare("SELECT * FROM model_technical_checks WHERE id = ? AND model_id = ?").get(id, modelId) as any;
    if (!row) throw new ProductStoreV2Error("Technical check does not exist.");
    return {
      id: row.id,
      modelId: row.model_id,
      workspaceDigest: row.workspace_sha256,
      executionDescriptionDigest: row.execution_description_sha256,
      state: row.state,
      results: JSON.parse(row.results_json),
      limits: JSON.parse(row.limits_json),
      startedAt: row.started_at,
      finishedAt: row.finished_at,
    };
  }

  readObjectFile(id: string): Buffer {
    const row = this.#objectRow(id);
    const inspected = this.#objects.readWithInspection(ownerPath(row));
    if (!inspected || inspected.sha256 !== row.sha256 || inspected.sizeBytes !== row.size_bytes) throw new ProductStoreV2Error("Stored object metadata or bytes drifted.");
    return inspected.bytes;
  }

  #sessionProjection(conversationId: string): "none" | "connecting" | "available" | "lost" | "read_only" {
    const row = this.#database.prepare("SELECT state FROM agent_sessions WHERE conversation_id = ? AND state != 'closed'").get(conversationId) as { state: DurableAgentSessionState } | undefined;
    if (!row) return "none";
    if (row.state === "available") return "available";
    if (row.state === "lost") return "lost";
    return "connecting";
  }

  #skillUses(turnId: string): SkillUseDto[] {
    return (this.#database.prepare("SELECT * FROM skill_uses WHERE turn_id = ? ORDER BY created_at, id").all(turnId) as any[]).map((row) => ({
      id: row.id, skillId: row.skill_id, skillVersion: row.skill_version, routingMode: row.routing_mode,
      loadState: row.load_state, rationale: row.rationale,
    }));
  }

  #actions(turnId: string): ActionRecordDto[] {
    return (this.#database.prepare("SELECT * FROM action_records WHERE turn_id = ? ORDER BY created_at, id").all(turnId) as any[]).map((row) => ({
      id: row.id, actionKind: row.action_kind, intent: JSON.parse(row.intent_json), permissionDecision: row.permission_decision,
      state: row.state, affectedResources: JSON.parse(row.affected_resources_json), errorCode: row.error_code,
    }));
  }

  #agentTurn(conversationId: string, requestKey: string): AgentTurnDto {
    const row = this.#database.prepare("SELECT * FROM agent_turns WHERE conversation_id = ? AND request_key = ?").get(conversationId, requestKey) as any;
    if (!row) throw new ProductStoreV2Error("Agent turn does not exist.");
    return {
      requestKey: row.request_key, state: row.state, userMessageId: row.input_message_id, assistantMessageId: row.assistant_message_id,
      skillUses: this.#skillUses(row.id), actions: this.#actions(row.id),
      failure: row.failure_code ? { code: row.failure_code, retryable: Boolean(row.failure_retryable) } : null,
    };
  }

  #collectConversationClosure(
    conversationIds: string[], addRows: (table: string, rows: any[], key?: (row: any) => Record<string, string | number>) => void,
    files: ObjectRow[], blockers: Array<{ kind: string; id: string }>, exclusions: Array<{ kind: string; id: string; reason: string }>,
  ): void {
    for (const conversationId of conversationIds.sort()) {
      addRows("messages", this.#database.prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY ordinal").all(conversationId) as any[]);
      addRows("conversation_summaries", this.#database.prepare("SELECT * FROM conversation_summaries WHERE conversation_id = ?").all(conversationId) as any[], (item) => ({ conversation_id: item.conversation_id }));
      addRows("agent_sessions", this.#database.prepare("SELECT * FROM agent_sessions WHERE conversation_id = ? ORDER BY generation").all(conversationId) as any[]);
      const turns = this.#database.prepare("SELECT * FROM agent_turns WHERE conversation_id = ? ORDER BY created_at, id").all(conversationId) as any[];
      addRows("agent_turns", turns);
      for (const turn of turns) {
        addRows("skill_uses", this.#database.prepare("SELECT * FROM skill_uses WHERE turn_id = ? ORDER BY id").all(turn.id) as any[]);
        const actions = this.#database.prepare("SELECT * FROM action_records WHERE turn_id = ? ORDER BY id").all(turn.id) as any[];
        addRows("action_records", actions);
        for (const action of actions) addRows("temporary_document_adoptions", this.#database.prepare("SELECT * FROM temporary_document_adoptions WHERE action_record_id = ? ORDER BY document_id").all(action.id) as any[], (item) => ({ document_id: item.document_id, action_record_id: item.action_record_id }));
      }
      addRows("temporary_documents", this.#database.prepare("SELECT * FROM temporary_documents WHERE conversation_id = ? ORDER BY id").all(conversationId) as any[]);
      const attachments = this.#database.prepare("SELECT * FROM attachments WHERE conversation_id = ? ORDER BY id").all(conversationId) as any[];
      addRows("attachments", attachments);
      const messageAttachments = this.#database.prepare(`SELECT ma.* FROM message_attachments ma JOIN messages m ON m.id = ma.message_id
        WHERE m.conversation_id = ? ORDER BY ma.message_id, ma.attachment_id`).all(conversationId) as any[];
      addRows("message_attachments", messageAttachments, (item) => ({ message_id: item.message_id, attachment_id: item.attachment_id }));
      files.push(...this.#objectRows("owner_conversation_id = ?", [conversationId]));
      for (const attachment of attachments) {
        for (const adopted of this.#database.prepare("SELECT id FROM object_files WHERE source_attachment_id = ? ORDER BY id").all(attachment.id) as Array<{ id: string }>) {
          blockers.push({ kind: "adopted_attachment", id: adopted.id });
          exclusions.push({ kind: "adopted_attachment", id: adopted.id, reason: "adopted copy is owned outside the source conversation" });
        }
      }
    }
  }

  #ensureRegisteredLaunchEvidence(input: BatchProcessIdentity & {
    launchedAt: IsoTimestamp;
    launchReceipt?: BatchLaunchReceipt;
  }): void {
    const existing = input.scratchId ? this.#database.prepare(`SELECT
        m.id AS manifest_id, m.manifest_sha256, m.state AS manifest_state,
        s.id AS scratch_id, s.relative_path, s.state AS scratch_state
      FROM process_launch_manifests m
      JOIN run_scratch_leases s ON s.id = m.scratch_lease_id
      WHERE m.run_attempt_id = ? AND s.id = ?`
    ).get(input.attemptId, input.scratchId) as {
      manifest_id: string;
      manifest_sha256: string;
      manifest_state: string;
      scratch_id: string;
      relative_path: string;
      scratch_state: string;
    } | undefined : undefined;
    if (existing) {
      const receipt = input.launchReceipt;
      if (!receipt || existing.manifest_state !== "planned" || existing.scratch_state !== "created"
        || receipt.schemaVersion !== 1
        || receipt.manifestId !== existing.manifest_id
        || receipt.manifestDigest !== existing.manifest_sha256
        || receipt.runId !== input.runId
        || receipt.sampleIndex !== input.sampleIndex
        || receipt.sampleId !== input.sampleId
        || receipt.scratchId !== existing.scratch_id
        || receipt.relativePath !== existing.relative_path
        || receipt.pid !== input.pid
        || receipt.processGroupId !== input.processGroupId
        || receipt.processStartToken !== input.processStartToken
        || receipt.receiptDigest !== launchReceiptUnsignedDigest(receipt)) {
        throw new ProductStoreV2Error("process_launch_manifest_invalid: launch receipt does not match its planned process.");
      }
      this.#executeDatabaseStatements([
        {
          sql: `UPDATE run_scratch_leases
            SET state = 'active'
            WHERE id = ? AND run_attempt_id = ? AND state = 'created'`,
          params: [existing.scratch_id, input.attemptId],
          expectedChanges: 1,
        },
        {
          sql: `UPDATE process_launch_manifests
            SET process_attempt_id = ?, state = 'registered',
              launch_receipt_json = ?, launch_receipt_sha256 = ?, registered_at = ?
            WHERE id = ? AND run_attempt_id = ? AND state = 'planned'`,
          params: [
            input.processAttemptId,
            json(receipt),
            canonicalDigest(receipt),
            input.launchedAt,
            existing.manifest_id,
            input.attemptId,
          ],
          expectedChanges: 1,
        },
      ]);
      return;
    }

    // Direct Store tests and non-process test doubles do not own a filesystem
    // scratch capability. They still receive complete schema evidence, while
    // the production GenericBatchSupervisor always takes the pre-spawn path.
    const scratchId = `scratch_${canonicalDigest({
      processAttemptId: input.processAttemptId,
      syntheticScratchHint: input.scratchId ?? null,
    }).slice(0, 32)}`;
    const relativePath = `synthetic-${canonicalDigest({ scratchId }).slice(0, 32)}`;
    const plan = {
      ...input,
      scratchId,
      relativePath,
    };
    const manifest = launchManifestPayload(plan);
    const manifestDigest = canonicalDigest(manifest);
    const manifestId = `launch_${manifestDigest.slice(0, 32)}`;
    const unsignedReceipt = {
      schemaVersion: 1 as const,
      manifestId,
      manifestDigest,
      runId: input.runId,
      sampleIndex: input.sampleIndex,
      sampleId: input.sampleId,
      scratchId,
      relativePath,
      pid: input.pid,
      processGroupId: input.processGroupId,
      processStartToken: input.processStartToken,
      createdAt: input.launchedAt,
    };
    const receipt = { ...unsignedReceipt, receiptDigest: canonicalDigest(unsignedReceipt) };
    this.#executeDatabaseStatements([
      {
        sql: `INSERT INTO run_scratch_leases
          (id, run_id, run_attempt_id, dispatcher_generation, sample_index, sample_id,
            relative_path, state, owner_uid, device, inode, created_at, registered_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, 0, 1, ?, ?)`,
        params: [
          scratchId,
          input.runId,
          input.attemptId,
          input.dispatcherGeneration,
          input.sampleIndex,
          input.sampleId,
          relativePath,
          typeof process.getuid === "function" ? process.getuid() : 0,
          input.launchedAt,
          input.launchedAt,
        ],
        expectedChanges: 1,
      },
      {
        sql: `INSERT INTO process_launch_manifests
          (id, run_attempt_id, scratch_lease_id, process_attempt_id, state,
            manifest_json, manifest_sha256, launch_receipt_json, launch_receipt_sha256,
            created_at, registered_at)
          VALUES (?, ?, ?, ?, 'registered', ?, ?, ?, ?, ?, ?)`,
        params: [
          manifestId,
          input.attemptId,
          scratchId,
          input.processAttemptId,
          json(manifest),
          manifestDigest,
          json(receipt),
          canonicalDigest(receipt),
          input.launchedAt,
          input.launchedAt,
        ],
        expectedChanges: 1,
      },
    ]);
  }

  #assertCurrentDispatcherGeneration(generation: string): void {
    const row = this.#database.prepare(
      "SELECT generation FROM dispatcher_state WHERE singleton = 1",
    ).get() as { generation: string } | undefined;
    if (row?.generation !== generation) {
      throw new ProductStoreV2Error("stale_dispatcher_generation: the dispatcher generation is no longer current.");
    }
  }

  #transitionRunAttempt(input: RunAttemptIdentity & {
    expectedState: "claimed" | "starting";
    nextState: "starting" | "running";
    at: IsoTimestamp;
    updates: {
      startedAt?: IsoTimestamp;
      heartbeatAt?: IsoTimestamp;
      leaseExpiresAt?: IsoTimestamp;
    };
  }): RunAttemptRecord {
    assertRunAttemptIdentity(input);
    return this.#withImmediateTransaction(() => {
      this.#assertCurrentDispatcherGeneration(input.dispatcherGeneration);
      const assignments = ["state = ?", "heartbeat_at = coalesce(?, heartbeat_at)"];
      const params: Array<string | number | null> = [input.nextState, input.updates.heartbeatAt ?? null];
      if (input.updates.startedAt !== undefined) {
        assignments.push("started_at = ?");
        params.push(input.updates.startedAt);
      }
      if (input.updates.leaseExpiresAt !== undefined) {
        assignments.push("lease_expires_at = ?");
        params.push(input.updates.leaseExpiresAt);
      }
      params.push(
        input.attemptId,
        input.runId,
        input.attemptGeneration,
        input.dispatcherGeneration,
        input.expectedState,
      );
      this.#executeDatabaseStatements([{
        sql: `UPDATE run_attempts SET ${assignments.join(", ")}
          WHERE id = ? AND run_id = ? AND attempt_generation = ?
            AND dispatcher_generation = ? AND state = ?`,
        params,
        expectedChanges: 1,
        mismatchMessage: "invalid_run_transition: the run-attempt transition lost its compare-and-set.",
      }]);
      return runAttemptRecord(this.#database.prepare("SELECT * FROM run_attempts WHERE id = ?").get(input.attemptId));
    });
  }

  #transitionBatchProcess(
    input: BatchProcessIdentity,
    transition: {
      expectedState: "blocked" | "released" | "running" | "exited";
      nextState: "released" | "running" | "exited" | "cleanup_complete" | "cleanup_unverified";
      set: string;
      params: Array<string | number | null>;
      stateTransition?: boolean;
      extraStatements?: ProductDatabaseMutationStatement[];
    },
  ): ProcessAttemptRecord {
    assertBatchProcessIdentity(input);
    return this.#withImmediateTransaction(() => {
      this.#assertCurrentDispatcherGeneration(input.dispatcherGeneration);
      this.#executeDatabaseStatements([
        {
          sql: `UPDATE process_attempts
            SET ${transition.set}
            WHERE id = ? AND run_attempt_id = ? AND process_kind = 'batch'
              AND sample_index = ? AND sample_id = ? AND pid = ?
              AND process_start_token = ? AND process_group_id = ? AND state = ?
              AND EXISTS (
                SELECT 1 FROM run_attempts a
                WHERE a.id = process_attempts.run_attempt_id
                  AND a.run_id = ? AND a.attempt_generation = ?
                  AND a.dispatcher_generation = ?
              )`,
          params: [
            ...transition.params,
            input.processAttemptId,
            input.attemptId,
            input.sampleIndex,
            input.sampleId,
            input.pid,
            input.processStartToken,
            input.processGroupId,
            transition.expectedState,
            input.runId,
            input.attemptGeneration,
            input.dispatcherGeneration,
          ],
          expectedChanges: 1,
          mismatchMessage: "stale_dispatcher_generation: the batch process transition lost its full-identity compare-and-set.",
        },
        ...(transition.extraStatements ?? []),
      ]);
      return processAttemptRecord(this.#database.prepare("SELECT * FROM process_attempts WHERE id = ?").get(input.processAttemptId));
    });
  }

  #verifiedMetadata(row: ObjectRow): StoredObjectMetadata {
    const inspected = this.#objects.readWithInspection(ownerPath(row));
    if (!inspected || inspected.sha256 !== row.sha256 || inspected.sizeBytes !== row.size_bytes) {
      throw new ProductStoreV2Error("Object metadata or bytes drifted.");
    }
    return metadata(row);
  }

  #databaseMutation(statements: ProductDatabaseMutationStatement[]): void {
    this.#withImmediateTransaction(() => {
      this.#executeDatabaseStatements(statements);
    });
  }

  #executeDatabaseStatements(statements: ProductDatabaseMutationStatement[]): void {
    for (const statement of statements) {
      if (!Number.isSafeInteger(statement.expectedChanges)) throw new ProductStoreV2Error("Every database mutation requires expectedChanges.");
      const result = this.#database.prepare(statement.sql).run(...(statement.params ?? []));
      if (Number(result.changes) !== statement.expectedChanges) {
        throw new ProductStoreV2Error(statement.mismatchMessage ?? "Database mutation affected an unexpected number of rows.");
      }
    }
  }

  #withImmediateTransaction<T>(body: () => T): T {
    this.#assertOpen();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = body();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.#database.exec("ROLLBACK"); }
      catch (rollbackError) {
        this.#closed = true;
        try { this.#database.close(); }
        catch { throw new ProductStoreV2Error("Database rollback and close failed; writer lock retained.", { cause: rollbackError }); }
        this.#coordinator.close();
        throw new ProductStoreV2Error("Database rollback failed; database was closed before releasing the writer lock.", { cause: rollbackError });
      }
      if (error instanceof ProductStoreV2Error) throw error;
      throw new ProductStoreV2Error("Product database mutation failed.", { cause: error });
    }
  }

  #reconcileInterruptedAgentState(): void {
    const committedActions = (this.#database.prepare(`SELECT count(*) AS count FROM action_records a WHERE a.state = 'staging'
      AND a.mutation_transaction_id IS NOT NULL AND EXISTS (SELECT 1 FROM committed_mutations m WHERE m.transaction_id = a.mutation_transaction_id)`).get() as { count: number }).count;
    const rolledBackActions = (this.#database.prepare(`SELECT count(*) AS count FROM action_records a WHERE a.state = 'staging'
      AND (a.mutation_transaction_id IS NULL OR NOT EXISTS (SELECT 1 FROM committed_mutations m WHERE m.transaction_id = a.mutation_transaction_id))`).get() as { count: number }).count;
    const runningTurns = (this.#database.prepare("SELECT count(*) AS count FROM agent_turns WHERE state IN ('queued', 'running')").get() as { count: number }).count;
    const liveSessions = (this.#database.prepare("SELECT count(*) AS count FROM agent_sessions WHERE state != 'closed'").get() as { count: number }).count;
    const runningChecks = (this.#database.prepare("SELECT count(*) AS count FROM model_technical_checks WHERE state = 'running'").get() as { count: number }).count;
    const checkingModels = (this.#database.prepare(`SELECT count(*) AS count FROM models m WHERE m.technical_status = 'checking'
      AND EXISTS (SELECT 1 FROM model_technical_checks t WHERE t.model_id = m.id AND t.state = 'running')`).get() as { count: number }).count;
    if (committedActions + rolledBackActions + runningTurns + liveSessions + runningChecks === 0) return;
    const now = new Date().toISOString();
    this.#databaseMutation([
      { sql: `UPDATE action_records SET state = 'committed', updated_at = ? WHERE state = 'staging' AND mutation_transaction_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM committed_mutations m WHERE m.transaction_id = action_records.mutation_transaction_id)`, params: [now], expectedChanges: committedActions },
      { sql: `UPDATE action_records SET state = 'rolled_back', error_code = 'interrupted_before_commit', updated_at = ? WHERE state = 'staging'
        AND (mutation_transaction_id IS NULL OR NOT EXISTS (SELECT 1 FROM committed_mutations m WHERE m.transaction_id = action_records.mutation_transaction_id))`, params: [now], expectedChanges: rolledBackActions },
      { sql: `UPDATE agent_turns SET state = 'failed', failure_code = 'interrupted', failure_retryable = 1, updated_at = ?
        WHERE state IN ('queued', 'running')`, params: [now], expectedChanges: runningTurns },
      { sql: `UPDATE agent_sessions SET state = 'lost', failure_reason = 'process_restarted', updated_at = ? WHERE state != 'closed'`, params: [now], expectedChanges: liveSessions },
      { sql: `UPDATE models SET technical_status = 'failed', updated_at = ? WHERE technical_status = 'checking'
        AND EXISTS (SELECT 1 FROM model_technical_checks t WHERE t.model_id = models.id AND t.state = 'running')`, params: [now], expectedChanges: checkingModels },
      { sql: `UPDATE model_technical_checks SET state = 'failed', results_json = '{"failureCode":"interrupted"}', finished_at = ? WHERE state = 'running'`, params: [now], expectedChanges: runningChecks },
    ]);
  }

  #model(id: string): ModelRecord {
    const row = this.#database.prepare("SELECT * FROM models WHERE id = ?").get(id) as any;
    if (!row) throw new ProductStoreV2Error("Model does not exist.");
    return modelRecord(row);
  }

  #project(id: string): ProjectRecord {
    const row = this.#database.prepare("SELECT * FROM projects WHERE id = ?").get(id) as any;
    if (!row) throw new ProductStoreV2Error("Project does not exist.");
    return projectRecord(row);
  }

  #experimentConfiguration(projectId: string, id: string): ExperimentConfigurationRecord {
    const row = this.#database.prepare("SELECT * FROM experiment_configurations WHERE id = ? AND project_id = ?").get(id, projectId) as any;
    if (!row) throw new ProductStoreV2Error("Experiment configuration does not exist.");
    return experimentConfigurationRecord(row);
  }

  #experimentCommandReceipt(
    commandId: string,
    commandKind: "create" | "update",
    projectId: string,
    experimentId: string,
    intentDigest: string,
  ): ExperimentConfigurationRecordV4 | null {
    const row = this.#database.prepare(
      `SELECT command_kind, project_id, experiment_id, intent_sha256, response_json, response_sha256
       FROM experiment_command_receipts WHERE command_id = ?`,
    ).get(commandId) as {
      command_kind: string;
      project_id: string;
      experiment_id: string;
      intent_sha256: string;
      response_json: string;
      response_sha256: string;
    } | undefined;
    if (!row) return null;
    if (row.command_kind !== commandKind || row.project_id !== projectId
      || row.experiment_id !== experimentId || row.intent_sha256 !== intentDigest) {
      throw new ProductStoreV2Error("Experiment configuration command already exists with a different intent.");
    }
    let response: unknown;
    try { response = JSON.parse(row.response_json); }
    catch (error) {
      throw new ProductStoreV2Error("Experiment command receipt contains invalid JSON.", { cause: error });
    }
    assertExperimentV4Response(response);
    if (canonicalDigest(response) !== row.response_sha256
      || response.id !== experimentId || response.projectId !== projectId) {
      throw new ProductStoreV2Error("Experiment command receipt digest or resource binding is corrupt.");
    }
    return response;
  }

  #assertMutableExecutionContract(kind: ManagedResourceKind, id: string): void {
    if (kind !== "experiment" && kind !== "run") return;
    const table = kind === "experiment" ? "experiment_configurations" : "runs";
    const row = this.#database.prepare(`SELECT contract_version FROM ${table} WHERE id = ?`).get(id) as {
      contract_version: number;
    } | undefined;
    if (row?.contract_version === 3) throw legacyReadOnlyError(kind);
  }

  #frozenRunStartReceipt(intent: StartRunIntent, intentDigest: string): FrozenRunStartReceipt | null {
    const row = this.#database.prepare(`SELECT
        c.run_id AS command_run_id, c.command_kind, c.request_key, c.intent_sha256,
        c.state AS command_state, c.outcome_json,
        q.receipt_kind, q.payload_sha256, q.payload_json,
        r.project_id, r.experiment_configuration_id, r.contract_version, r.status,
        r.run_kind, r.completion_conversation_id, r.execution_description_sha256,
        r.project_snapshot_sha256, r.frozen_configuration_json,
        r.frozen_configuration_sha256, r.sample_plan_json, r.sample_plan_sha256,
        r.requested_sample_count, r.limits_json, r.limits_sha256,
        r.start_receipt_sha256, r.created_at
      FROM run_commands c
      LEFT JOIN run_command_receipts q ON q.command_id = c.id AND q.run_id = c.run_id
      LEFT JOIN runs r ON r.id = c.run_id
      WHERE c.id = ?`).get(intent.commandId) as any;
    if (!row) return null;
    if (row.command_kind !== "start" || row.request_key !== intent.commandId || row.intent_sha256 !== intentDigest) {
      throw new ProductStoreV2Error("Run command already exists with a different intent.");
    }
    if (row.command_state !== "committed" || row.receipt_kind !== "run.start.v1"
      || typeof row.payload_json !== "string" || typeof row.outcome_json !== "string") {
      throw new ProductStoreV2Error("Committed run-start receipt is incomplete.");
    }
    let payload: unknown;
    let outcome: unknown;
    let limits: unknown;
    let frozenConfiguration: unknown;
    let samplePlan: unknown;
    try {
      payload = JSON.parse(row.payload_json);
      outcome = JSON.parse(row.outcome_json);
      limits = JSON.parse(row.limits_json);
      frozenConfiguration = JSON.parse(row.frozen_configuration_json);
      samplePlan = JSON.parse(row.sample_plan_json);
    } catch (error) {
      throw new ProductStoreV2Error("Committed run-start receipt contains invalid JSON.", { cause: error });
    }
    assertFrozenRunStartReceipt(payload);
    if (canonicalDigest(payload) !== row.payload_sha256
      || !canonicalJsonV2(payload).equals(canonicalJsonV2(outcome))) {
      throw new ProductStoreV2Error("Committed run-start receipt digest or outcome does not match.");
    }
    const receipt = payload as FrozenRunStartReceipt;
    if (receipt.commandId !== intent.commandId
      || receipt.intentDigest !== intentDigest
      || receipt.projectId !== intent.projectId
      || receipt.experimentConfigId !== intent.experimentConfigId
      || receipt.completionConversationId !== intent.completionConversationId
      || receipt.runId !== row.command_run_id
      || row.contract_version !== 4
      || row.project_id !== receipt.projectId
      || row.experiment_configuration_id !== receipt.experimentConfigId
      || row.run_kind !== receipt.runKind
      || row.completion_conversation_id !== receipt.completionConversationId
      || row.execution_description_sha256 !== receipt.executionDescriptionDigest
      || row.project_snapshot_sha256 !== receipt.projectSnapshotDigest
      || row.frozen_configuration_sha256 !== receipt.frozenConfigurationDigest
      || row.sample_plan_sha256 !== receipt.samplePlanDigest
      || row.requested_sample_count !== receipt.sampleCount
      || row.created_at !== receipt.createdAt
      || row.limits_sha256 !== receipt.limitsDigest
      || row.start_receipt_sha256 !== row.payload_sha256
      || canonicalDigest(frozenConfiguration) !== receipt.frozenConfigurationDigest
      || canonicalDigest(samplePlan) !== receipt.samplePlanDigest
      || canonicalDigest(limits) !== receipt.limitsDigest) {
      throw new ProductStoreV2Error("Committed run-start receipt no longer matches its immutable run.");
    }
    return Object.freeze({ ...receipt });
  }

  #frozenRunCancelReceipt(intent: CancelRunIntent, intentDigest: string): FrozenRunCancelReceipt | null {
    const row = this.#database.prepare(`SELECT
        c.run_id AS command_run_id, c.command_kind, c.request_key, c.intent_sha256,
        c.state AS command_state, c.outcome_json,
        q.receipt_kind, q.payload_sha256, q.payload_json,
        r.project_id, r.contract_version, r.cancel_requested_at,
        r.first_cancel_command_id
      FROM run_commands c
      LEFT JOIN run_command_receipts q ON q.command_id = c.id AND q.run_id = c.run_id
      LEFT JOIN runs r ON r.id = c.run_id
      WHERE c.id = ?`).get(intent.commandId) as any;
    if (!row) return null;
    if (row.command_kind !== "cancel" || row.request_key !== intent.commandId
      || row.intent_sha256 !== intentDigest) {
      throw new ProductStoreV2Error("Run command already exists with a different intent.");
    }
    if (row.command_state !== "committed" || row.receipt_kind !== "run.cancel.v1"
      || typeof row.payload_json !== "string" || typeof row.outcome_json !== "string") {
      throw new ProductStoreV2Error("Committed run-cancel receipt is incomplete.");
    }
    let payload: unknown;
    let outcome: unknown;
    try {
      payload = JSON.parse(row.payload_json);
      outcome = JSON.parse(row.outcome_json);
    } catch (error) {
      throw new ProductStoreV2Error("Committed run-cancel receipt contains invalid JSON.", { cause: error });
    }
    assertFrozenRunCancelReceipt(payload);
    if (canonicalDigest(payload) !== row.payload_sha256
      || !canonicalJsonV2(payload).equals(canonicalJsonV2(outcome))) {
      throw new ProductStoreV2Error("Committed run-cancel receipt digest or outcome does not match.");
    }
    const receipt = payload as FrozenRunCancelReceipt;
    if (receipt.commandId !== intent.commandId
      || receipt.projectId !== intent.projectId
      || receipt.runId !== intent.runId
      || receipt.runId !== row.command_run_id
      || row.contract_version !== 4
      || row.project_id !== receipt.projectId
      || row.cancel_requested_at !== receipt.cancelRequestedAt
      || ((row.cancel_requested_at === null) !== (row.first_cancel_command_id === null))
      || (receipt.applied && row.first_cancel_command_id !== receipt.commandId)) {
      throw new ProductStoreV2Error("Committed run-cancel receipt resource binding is corrupt.");
    }
    return Object.freeze({ ...receipt });
  }

  #verifyFrozenProject(project: any): string {
    const rows = this.#objectRows("owner_project_id = ? AND kind = 'project_model_snapshot'", [project.id]).sort(compareObjectRows);
    if (!rows.length) throw new ProductStoreV2Error("Existing Project snapshot is incomplete.");
    const files = rows.map((row) => this.#verifiedMetadata(row));
    const digest = canonicalDigest(files.map((file) => ({ relativePath: file.relativePath, mediaType: file.mediaType, sizeBytes: file.sizeBytes, sha256: file.sha256 }))
      .sort((left, right) => compareStrings(left.relativePath, right.relativePath)));
    if (digest !== project.model_snapshot_digest) throw new ProductStoreV2Error("Existing Project snapshot digest is corrupt.");
    const prefix = "model-snapshot/";
    if (files.some((file) => !file.relativePath.startsWith(prefix))) {
      throw new ProductStoreV2Error("Existing Project snapshot path is corrupt.");
    }
    return canonicalDigest(files.map((file) => ({
      relativePath: file.relativePath.slice(prefix.length),
      sizeBytes: file.sizeBytes,
      sha256: file.sha256,
    })).sort((left, right) => compareStrings(left.relativePath, right.relativePath)));
  }

  #file(id: string): StoredObjectMetadata { return metadata(this.#objectRow(id)); }

  #objectRow(id: string): ObjectRow {
    const row = this.#database.prepare(`SELECT f.*, r.project_id AS run_project_id FROM object_files f
      LEFT JOIN runs r ON r.id = f.owner_run_id WHERE f.id = ?`).get(id) as ObjectRow | undefined;
    if (!row) throw new ProductStoreV2Error("Object metadata does not exist.");
    return row;
  }

  #objectRows(where: string, params: Array<string>): ObjectRow[] {
    return this.#database.prepare(`SELECT f.*, r.project_id AS run_project_id FROM object_files f
      LEFT JOIN runs r ON r.id = f.owner_run_id WHERE ${where} ORDER BY f.id`).all(...params) as ObjectRow[];
  }

  #assertOpen(): void { if (this.#closed) throw new ProductStoreV2Error("Product store is closed."); }
}

const objectInsert = (input: {
  id: string; owner: ResourceOwner; kind: ObjectFileKind; relativePath: string; mediaType: string;
  sizeBytes: number; digest: string; sourceAttachmentId?: string | null; adoptionPurpose?: string | null; createdAt: string;
}): DatabaseMutationStatement => ({
  sql: `INSERT INTO object_files
    (id, owner_model_id, owner_project_id, owner_conversation_id, owner_run_id, kind, relative_path, media_type,
      size_bytes, sha256, source_attachment_id, adoption_purpose, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  params: [input.id, input.owner.kind === "model" ? input.owner.id : null, input.owner.kind === "project" ? input.owner.id : null,
    input.owner.kind === "conversation" ? input.owner.id : null, input.owner.kind === "run" ? input.owner.id : null,
    input.kind, input.relativePath, input.mediaType, input.sizeBytes, input.digest, input.sourceAttachmentId ?? null, input.adoptionPurpose ?? null, input.createdAt],
  expectedChanges: 1,
});

const modelFilePath = (kind: InitialModelFile["kind"], relativePath: string): string => {
  const prefix = kind === "model_code" ? "code" : kind === "model_environment" ? "environment" : "visuals";
  return `${prefix}/${relativePath}`;
};

const ownerPath = (row: ObjectRow): OwnerPath => {
  if (row.owner_model_id) return { owner: { kind: "model", id: row.owner_model_id }, relativePath: row.relative_path };
  if (row.owner_project_id) return { owner: { kind: "project", id: row.owner_project_id }, relativePath: row.relative_path };
  if (row.owner_conversation_id) return { owner: { kind: "conversation", id: row.owner_conversation_id }, relativePath: row.relative_path };
  if (row.owner_run_id && row.run_project_id) return { owner: { kind: "run", id: row.owner_run_id }, runProjectId: row.run_project_id, relativePath: row.relative_path };
  throw new ProductStoreV2Error("Object metadata has no valid owner.");
};

const metadata = (row: ObjectRow): StoredObjectMetadata => ({
  id: row.id,
  owner: ownerPath(row).owner,
  kind: row.kind,
  relativePath: row.relative_path,
  mediaType: row.media_type,
  sizeBytes: row.size_bytes,
  sha256: row.sha256,
  sourceAttachmentId: row.source_attachment_id,
  adoptionPurpose: row.adoption_purpose,
  createdAt: row.created_at,
});

const conversationDto = (row: any, sessionState: ConversationDto["sessionState"]): ConversationDto => ({
  id: row.id,
  owner: row.model_id ? { kind: "model", id: row.model_id } : { kind: "project", id: row.project_id },
  name: row.name,
  provider: { providerId: row.provider_id, modelId: row.provider_model_id, locked: row.provider_locked_at !== null },
  sessionState,
  lifecycleState: row.lifecycle_state,
  updatedAt: row.updated_at,
});

const messageDto = (row: any): ConversationMessageDto => ({
  id: row.id, ordinal: row.ordinal, role: row.role, status: row.status, text: row.text,
  content: JSON.parse(row.content_json), createdAt: row.created_at, updatedAt: row.updated_at,
});

const modelRecord = (row: any): ModelRecord => ({
  id: row.id, name: row.name, lifecycleState: row.lifecycle_state, technicalStatus: row.technical_status, runMode: row.run_mode,
  executionDescription: JSON.parse(row.execution_description_json), createdAt: row.created_at, updatedAt: row.updated_at,
  archivedAt: row.archived_at, trashedAt: row.trashed_at,
});

const projectRecord = (row: any): ProjectRecord => ({
  id: row.id, name: row.name, lifecycleState: row.lifecycle_state, sourceModelId: row.source_model_id,
  modelSnapshotDigest: row.model_snapshot_digest, executionDescription: JSON.parse(row.execution_description_json),
  createdAt: row.created_at, updatedAt: row.updated_at, archivedAt: row.archived_at, trashedAt: row.trashed_at,
});

const experimentConfigurationRecord = (row: any): ExperimentConfigurationRecord => {
  const record = {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    configuration: JSON.parse(row.configuration_json),
    estimatedSampleCount: row.estimated_sample_count,
    lifecycleState: row.lifecycle_state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  return row.contract_version === 3
    ? Object.assign(record, { contractVersion: 3 as const, readOnly: true as const, legacyDigest: row.legacy_digest })
    : Object.assign(record, {
      contractVersion: 4 as const,
      readOnly: false as const,
      legacyDigest: null,
      configurationDigest: row.configuration_sha256,
      sampleCount: row.sample_count,
    });
};

const runRecord = (row: any): RunRecord => {
  const record = {
    id: row.id,
    projectId: row.project_id,
    experimentConfigurationId: row.experiment_configuration_id,
    status: row.status,
    frozenConfiguration: JSON.parse(row.frozen_configuration_json),
    requestedSampleCount: row.requested_sample_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
  return row.contract_version === 3
    ? Object.assign(record, { contractVersion: 3 as const, readOnly: true as const, legacyDigest: row.legacy_digest })
    : Object.assign(record, {
      contractVersion: 4 as const,
      readOnly: false as const,
      legacyDigest: null,
      runKind: row.run_kind,
      completionConversationId: row.completion_conversation_id,
      executionDescriptionDigest: row.execution_description_sha256,
      projectSnapshotDigest: row.project_snapshot_sha256,
      frozenConfigurationDigest: row.frozen_configuration_sha256,
      samplePlan: JSON.parse(row.sample_plan_json),
      samplePlanDigest: row.sample_plan_sha256,
      limits: JSON.parse(row.limits_json),
      limitsDigest: row.limits_sha256,
      startReceiptDigest: row.start_receipt_sha256,
      cancelRequestedAt: row.cancel_requested_at,
      terminalCode: row.terminal_code,
      terminalDiagnostics: row.terminal_diagnostics_json === null ? null : JSON.parse(row.terminal_diagnostics_json),
      resourceOverview: row.resource_overview_json === null ? null : JSON.parse(row.resource_overview_json),
      completionCardDisposition: row.completion_card_disposition,
    });
};

const runAttemptRecord = (row: any): RunAttemptRecord => {
  if (!row) throw new ProductStoreV2Error("Run attempt does not exist.");
  return {
    id: row.id,
    runId: row.run_id,
    attemptGeneration: row.attempt_generation,
    dispatcherGeneration: row.dispatcher_generation,
    state: row.state,
    claimedAt: row.claimed_at,
    leaseExpiresAt: row.lease_expires_at,
    heartbeatAt: row.heartbeat_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
};

const processAttemptRecord = (row: any): ProcessAttemptRecord => {
  if (!row) throw new ProductStoreV2Error("Process attempt does not exist.");
  return {
    id: row.id,
    runAttemptId: row.run_attempt_id,
    processKind: row.process_kind,
    sampleIndex: row.sample_index,
    sampleId: row.sample_id,
    pid: row.pid,
    processStartToken: row.process_start_token,
    processGroupId: row.process_group_id,
    state: row.state,
    cleanupReceiptDigest: row.cleanup_receipt_sha256,
  };
};

const scratchLeaseRecord = (row: any): RunScratchLeaseRecord => {
  if (!row) throw new ProductStoreV2Error("Scratch lease does not exist.");
  return {
    id: row.id,
    runId: row.run_id,
    runAttemptId: row.run_attempt_id,
    dispatcherGeneration: row.dispatcher_generation,
    sampleIndex: row.sample_index,
    sampleId: row.sample_id,
    relativePath: row.relative_path,
    state: row.state,
    ownerUid: row.owner_uid,
    device: row.device,
    inode: row.inode,
    createdAt: row.created_at,
    registeredAt: row.registered_at,
    cleanedAt: row.cleaned_at,
    cleanupReceiptDigest: row.cleanup_receipt_sha256,
  };
};

const managedTable = (kind: ManagedResourceKind): { table: string; trashColumn: string } => {
  switch (kind) {
    case "model": return { table: "models", trashColumn: "model_id" };
    case "project": return { table: "projects", trashColumn: "project_id" };
    case "conversation": return { table: "conversations", trashColumn: "conversation_id" };
    case "temporary_document": return { table: "temporary_documents", trashColumn: "temporary_document_id" };
    case "experiment": return { table: "experiment_configurations", trashColumn: "experiment_configuration_id" };
    case "run": return { table: "runs", trashColumn: "run_id" };
  }
};

const compareObjectRows = (left: ObjectRow, right: ObjectRow): number => compareStrings(left.relative_path, right.relative_path) || compareStrings(left.id, right.id);
const workspaceDigestOf = (rows: ObjectRow[]): string => canonicalDigest(rows.map((file) => ({
  relativePath: file.relative_path,
  sizeBytes: file.size_bytes,
  sha256: file.sha256,
})).sort((left, right) => compareStrings(left.relativePath, right.relativePath)));
const compareKindId = (left: { kind: string; id: string }, right: { kind: string; id: string }): number => compareStrings(left.kind, right.kind) || compareStrings(left.id, right.id);
const compareStrings = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const visible = (state: LifecycleState, options: { includeArchived?: boolean; includeTrashed?: boolean }): boolean => state === "active" || state === "archived" && Boolean(options.includeArchived) || state === "trashed" && Boolean(options.includeTrashed);
const json = (value: unknown): string => canonicalJsonV2(value).toString("utf8");
const DIGEST = /^[0-9a-f]{64}$/u;

const assertDigest = (value: string, label: string): void => {
  if (!DIGEST.test(value)) throw new ProductStoreV2Error(`${label} must be a lowercase SHA-256 digest.`);
};

const assertCommandId = (id: string): void => {
  if (!SAFE_ID.test(id) || id.length < 8) throw new ProductStoreV2Error("Command ID is invalid.");
};

const assertStartRunIntent = (intent: StartRunIntent): void => {
  assertCommandId(intent.commandId);
  assertId(intent.projectId);
  assertId(intent.experimentConfigId);
  if (intent.completionConversationId !== null) assertId(intent.completionConversationId);
};

const assertCancelRunIntent = (intent: CancelRunIntent): void => {
  assertCommandId(intent.commandId);
  assertId(intent.projectId);
  assertId(intent.runId);
};

const assertRunAttemptIdentity = (input: RunAttemptIdentity): void => {
  assertId(input.runId);
  assertId(input.attemptId);
  if (!Number.isSafeInteger(input.attemptGeneration) || input.attemptGeneration < 1) {
    throw new ProductStoreV2Error("Run attempt generation is invalid.");
  }
  assertDigest(input.dispatcherGeneration, "Dispatcher generation");
};

const assertBatchScratchPlan = (input: BatchScratchPlan): void => {
  assertId(input.runId);
  assertId(input.scratchId);
  if (!Number.isSafeInteger(input.sampleIndex) || input.sampleIndex < 0) {
    throw new ProductStoreV2Error("Batch scratch sample index is invalid.");
  }
  assertDigest(input.sampleId, "Batch scratch sample ID");
  if (typeof input.relativePath !== "string" || input.relativePath.length < 3
    || input.relativePath.length > 200 || !/^[A-Za-z0-9._-]+$/u.test(input.relativePath)
    || [".", ".."].includes(input.relativePath)) {
    throw new ProductStoreV2Error("Batch scratch relative path is invalid.");
  }
};

const launchManifestPayload = (input: RunAttemptIdentity & BatchScratchPlan): Record<string, unknown> => ({
  schemaVersion: 1,
  kind: "batch_process_launch",
  runId: input.runId,
  attemptId: input.attemptId,
  attemptGeneration: input.attemptGeneration,
  dispatcherGeneration: input.dispatcherGeneration,
  sampleIndex: input.sampleIndex,
  sampleId: input.sampleId,
  scratchId: input.scratchId,
  relativePath: input.relativePath,
});

const assertStoredProcessLaunchEvidence = (
  row: Record<string, any>,
  attempt: RunAttemptRecord,
): void => {
  let manifest: Record<string, unknown>;
  let receipt: BatchLaunchReceipt;
  try {
    manifest = JSON.parse(row.manifest_json);
    receipt = JSON.parse(row.launch_receipt_json);
  } catch (error) {
    throw new ProductStoreV2Error(
      "dispatcher_recovery_required: process launch evidence is not valid JSON.",
      { cause: error },
    );
  }
  const expectedManifest = launchManifestPayload({
    runId: attempt.runId,
    attemptId: attempt.id,
    attemptGeneration: attempt.attemptGeneration,
    dispatcherGeneration: attempt.dispatcherGeneration,
    sampleIndex: row.sample_index,
    sampleId: row.sample_id,
    scratchId: row.scratch_id,
    relativePath: row.relative_path,
  });
  const receiptShapeValid = Boolean(receipt && typeof receipt === "object" && !Array.isArray(receipt));
  const receiptKeys = receiptShapeValid ? Object.keys(receipt).sort().join("\n") : "";
  const expectedReceiptKeys = [
    "createdAt", "manifestDigest", "manifestId", "pid", "processGroupId",
    "processStartToken", "receiptDigest", "relativePath", "runId", "sampleId",
    "sampleIndex", "schemaVersion", "scratchId",
  ].sort().join("\n");
  const expectedManifestState =
    row.state === "blocked" ? "registered"
      : ["released", "running"].includes(row.state) ? "released"
        : row.state === "cleanup_complete" ? "cleanup_complete"
          : "exited";
  const expectedScratchState =
    row.state === "cleanup_complete" ? "cleanup_complete"
      : row.state === "cleanup_unverified" ? "cleanup_unverified"
        : "active";
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)
    || canonicalDigest(manifest) !== row.manifest_sha256
    || canonicalDigest(manifest) !== canonicalDigest(expectedManifest)
    || row.manifest_id !== `launch_${row.manifest_sha256.slice(0, 32)}`
    || row.manifest_state !== expectedManifestState
    || row.scratch_state !== expectedScratchState
    || !receiptShapeValid
    || receiptKeys !== expectedReceiptKeys
    || canonicalDigest(receipt) !== row.launch_receipt_sha256
    || receipt.schemaVersion !== 1
    || receipt.manifestId !== row.manifest_id
    || receipt.manifestDigest !== row.manifest_sha256
    || receipt.runId !== attempt.runId
    || receipt.sampleIndex !== row.sample_index
    || receipt.sampleId !== row.sample_id
    || receipt.scratchId !== row.scratch_id
    || receipt.relativePath !== row.relative_path
    || receipt.pid !== row.pid
    || receipt.processGroupId !== row.process_group_id
    || receipt.processStartToken !== row.process_start_token
    || !Number.isSafeInteger(receipt.pid) || receipt.pid < 1
    || receipt.processGroupId !== receipt.pid
    || typeof receipt.createdAt !== "string"
    || typeof receipt.receiptDigest !== "string"
    || !/^[0-9a-f]{64}$/u.test(receipt.receiptDigest)
    || receipt.receiptDigest !== launchReceiptUnsignedDigest(receipt)) {
    throw new ProductStoreV2Error(
      "dispatcher_recovery_required: process row contradicts its durable launch receipt.",
    );
  }
};

const launchReceiptUnsignedDigest = (receipt: BatchLaunchReceipt): string => {
  const { receiptDigest: _receiptDigest, ...unsigned } = receipt;
  return canonicalDigest(unsigned);
};

const assertBatchProcessIdentity = (input: BatchProcessIdentity): void => {
  assertRunAttemptIdentity(input);
  assertId(input.processAttemptId);
  if (!Number.isSafeInteger(input.sampleIndex) || input.sampleIndex < 0) {
    throw new ProductStoreV2Error("Batch sample index is invalid.");
  }
  assertDigest(input.sampleId, "Batch sample ID");
  if (!Number.isSafeInteger(input.pid) || input.pid < 1
    || !Number.isSafeInteger(input.processGroupId) || input.processGroupId < 1
    || typeof input.processStartToken !== "string" || !input.processStartToken
    || input.processStartToken.length > 300) {
    throw new ProductStoreV2Error("Batch process OS identity is invalid.");
  }
};

const assertTerminalData = (
  code: string,
  diagnostics: Record<string, unknown>,
  resourceOverview: Record<string, unknown>,
): void => {
  if (typeof code !== "string" || !code || code.length > 200
    || !diagnostics || typeof diagnostics !== "object" || Array.isArray(diagnostics)
    || !resourceOverview || typeof resourceOverview !== "object" || Array.isArray(resourceOverview)) {
    throw new ProductStoreV2Error("Batch terminal data is invalid.");
  }
  try {
    const diagnosticsBytes = canonicalJsonV2(diagnostics);
    const overviewBytes = canonicalJsonV2(resourceOverview);
    if (diagnosticsBytes.byteLength > 64_000 || overviewBytes.byteLength > 64_000) {
      throw new ProductStoreV2Error("Batch terminal data exceeds its bounded persistence limit.");
    }
  } catch (error) {
    if (error instanceof ProductStoreV2Error) throw error;
    throw new ProductStoreV2Error("Batch terminal data is not finite canonical JSON.", { cause: error });
  }
};

const startRunIntentDigest = (intent: StartRunIntent): string => canonicalDigest({
  schemaVersion: 1,
  commandKind: "run.start",
  projectId: intent.projectId,
  experimentConfigId: intent.experimentConfigId,
  completionConversationId: intent.completionConversationId,
});

const cancelRunIntentDigest = (intent: CancelRunIntent): string => canonicalDigest({
  schemaVersion: 1,
  commandKind: "run.cancel",
  projectId: intent.projectId,
  runId: intent.runId,
});

const experimentUpdateIntentDigest = (input: ExperimentUpdateIntentV4): string => canonicalDigest({
  schemaVersion: 1,
  commandKind: "experiment.update",
  id: input.id,
  projectId: input.projectId,
  expectedConfigurationDigest: input.expectedConfigurationDigest,
  expectedRecordDigest: input.expectedRecordDigest,
  patch: {
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.configuration === undefined ? {} : { configuration: input.configuration }),
  },
});

const RUN_LIMIT_KEYS = Object.freeze([
  "schemaVersion",
  "wallTimeMs",
  "startupTimeMs",
  "terminationGraceMs",
  "maxStdoutBytes",
  "maxStderrBytes",
  "maxOutputFiles",
  "maxOutputBytes",
  "maxEventCount",
  "maxEventBytes",
  "maxSamples",
  "maxConcurrency",
].sort());

const assertRunLimits = (limits: RunLimitsV1): void => {
  if (!limits || typeof limits !== "object" || Array.isArray(limits)
    || Object.keys(limits).sort().join("\n") !== RUN_LIMIT_KEYS.join("\n")
    || limits.schemaVersion !== 1) {
    throw new ProductStoreV2Error("RunLimitsV1 is invalid.");
  }
  for (const key of RUN_LIMIT_KEYS) {
    if (key === "schemaVersion") continue;
    const value = limits[key as keyof RunLimitsV1];
    if (!Number.isSafeInteger(value) || value < 1) throw new ProductStoreV2Error(`RunLimitsV1.${key} is invalid.`);
  }
};

const assertRunnableExecutionDescription = (
  input: unknown,
  plan: ExperimentPlan,
  maxSamples: number,
): void => {
  let description;
  try {
    description = validateExecutionDescriptionV2(input);
    assertRunCapabilityV2(description, plan.configuration.runKind);
    if (plan.configuration.runKind === "visual") {
      throw new ProductStoreV2Error("capability_not_available: visual run dispatch is not available in this milestone.");
    }
    if (description.batch?.domainEvents) {
      throw new ProductStoreV2Error("domain_events_not_supported: batch domain events are not supported by this run dispatcher.");
    }
  } catch (error) {
    if (error instanceof ExecutionProtocolV2Error) {
      throw new ProductStoreV2Error(`${error.code}: ${error.message}`, { cause: error });
    }
    throw error;
  }
  const replanned = planExperiment({ configuration: plan.configuration, inputSchema: description.inputs.schema, maxSamples });
  if (canonicalDigest(replanned) !== canonicalDigest(plan)) {
    throw new ProductStoreV2Error("invalid_sample_plan: the supplied plan does not match the copied Project input schema.");
  }
};

const FROZEN_RUN_RECEIPT_KEYS = Object.freeze([
  "schemaVersion",
  "commandId",
  "intentDigest",
  "runId",
  "projectId",
  "experimentConfigId",
  "completionConversationId",
  "status",
  "runKind",
  "frozenConfigurationDigest",
  "samplePlanDigest",
  "sampleCount",
  "projectSnapshotDigest",
  "executionDescriptionDigest",
  "limitsDigest",
  "createdAt",
].sort());

const RUN_CANCEL_RECEIPT_KEYS = Object.freeze([
  "schemaVersion",
  "commandId",
  "projectId",
  "runId",
  "applied",
  "code",
  "status",
  "cancelRequestedAt",
  "createdAt",
].sort());

const EXPERIMENT_V4_RESPONSE_KEYS = Object.freeze([
  "id",
  "projectId",
  "name",
  "configuration",
  "estimatedSampleCount",
  "lifecycleState",
  "createdAt",
  "updatedAt",
  "contractVersion",
  "readOnly",
  "legacyDigest",
  "configurationDigest",
  "sampleCount",
].sort());

const assertExperimentV4Response: (value: unknown) => asserts value is ExperimentConfigurationRecordV4 = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProductStoreV2Error("Experiment command receipt has an invalid response shape.");
  }
  const response = value as Record<string, unknown>;
  if (Object.keys(response).sort().join("\n") !== EXPERIMENT_V4_RESPONSE_KEYS.join("\n")
    || response.contractVersion !== 4
    || response.readOnly !== false
    || response.legacyDigest !== null
    || typeof response.id !== "string"
    || typeof response.projectId !== "string"
    || typeof response.name !== "string"
    || !response.configuration
    || typeof response.configuration !== "object"
    || Array.isArray(response.configuration)
    || !Number.isSafeInteger(response.sampleCount)
    || response.sampleCount !== response.estimatedSampleCount
    || typeof response.configurationDigest !== "string"
    || !DIGEST.test(response.configurationDigest)
    || canonicalDigest(response.configuration) !== response.configurationDigest) {
    throw new ProductStoreV2Error("Experiment command receipt has an invalid response shape.");
  }
};

const assertFrozenRunStartReceipt: (value: unknown) => asserts value is FrozenRunStartReceipt = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProductStoreV2Error("Committed run-start receipt has an invalid shape.");
  }
  const receipt = value as Record<string, unknown>;
  if (Object.keys(receipt).sort().join("\n") !== FROZEN_RUN_RECEIPT_KEYS.join("\n")
    || receipt.schemaVersion !== 1
    || receipt.status !== "queued"
    || !["batch", "visual"].includes(String(receipt.runKind))
    || !Number.isSafeInteger(receipt.sampleCount)
    || Number(receipt.sampleCount) < 1
    || typeof receipt.createdAt !== "string"
    || typeof receipt.commandId !== "string"
    || typeof receipt.runId !== "string"
    || typeof receipt.projectId !== "string"
    || typeof receipt.experimentConfigId !== "string"
    || !(receipt.completionConversationId === null || typeof receipt.completionConversationId === "string")) {
    throw new ProductStoreV2Error("Committed run-start receipt has an invalid shape.");
  }
  for (const field of [
    "intentDigest",
    "frozenConfigurationDigest",
    "samplePlanDigest",
    "projectSnapshotDigest",
    "executionDescriptionDigest",
    "limitsDigest",
  ]) {
    if (typeof receipt[field] !== "string" || !DIGEST.test(receipt[field])) {
      throw new ProductStoreV2Error("Committed run-start receipt has an invalid digest.");
    }
  }
};

const assertFrozenRunCancelReceipt: (value: unknown) => asserts value is FrozenRunCancelReceipt = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProductStoreV2Error("Committed run-cancel receipt has an invalid shape.");
  }
  const receipt = value as Record<string, unknown>;
  if (Object.keys(receipt).sort().join("\n") !== RUN_CANCEL_RECEIPT_KEYS.join("\n")
    || receipt.schemaVersion !== 1
    || typeof receipt.commandId !== "string"
    || typeof receipt.projectId !== "string"
    || typeof receipt.runId !== "string"
    || typeof receipt.applied !== "boolean"
    || typeof receipt.createdAt !== "string"
    || !["cancellation_requested", "cancellation_already_requested", "run_already_terminal"].includes(String(receipt.code))
    || !["cancelling", "succeeded", "failed", "cancelled", "timed_out", "trashed"].includes(String(receipt.status))
    || !(receipt.cancelRequestedAt === null || typeof receipt.cancelRequestedAt === "string")
    || receipt.applied !== (receipt.code === "cancellation_requested")
    || (receipt.status === "cancelling" && receipt.cancelRequestedAt === null)
    || (receipt.code !== "run_already_terminal" && receipt.status !== "cancelling")
    || (receipt.code === "run_already_terminal" && receipt.status === "cancelling")) {
    throw new ProductStoreV2Error("Committed run-cancel receipt has an invalid shape.");
  }
};

const legacyReadOnlyError = (kind: "experiment" | "run"): ProductStoreV2Error =>
  new ProductStoreV2Error(`legacy_contract_read_only: version-3 ${kind} records are permanently read only.`);

const stableTransactionId = (operation: string, id: string): string => `mutation_${operation}_${canonicalDigest(id).slice(0, 32)}`;
const activeLifecycleGuard = (table: "models" | "projects" | "conversations", id: string): DatabaseMutationStatement => ({
  sql: `UPDATE ${table} SET updated_at = updated_at WHERE id = ? AND lifecycle_state = 'active'`, params: [id], expectedChanges: 1,
});
const activeOwnerGuard = (owner: Extract<ResourceOwner, { kind: "model" | "project" }>): DatabaseMutationStatement => activeLifecycleGuard(owner.kind === "model" ? "models" : "projects", owner.id);
const assertId = (id: string): void => { if (!SAFE_ID.test(id)) throw new ProductStoreV2Error("Resource ID is invalid."); };
const commandReceiptInsert = (transactionId: string, intentDigest: string): DatabaseMutationStatement => ({
  sql: "INSERT INTO committed_mutations (transaction_id, manifest_sha256, committed_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
  params: [transactionId, intentDigest],
  expectedChanges: 1,
});
const assertOptions = (options: ProductStoreV2Options): void => {
  if (Object.keys(options).some((key) => !["initFaultInjector", "coordinatorOptions"].includes(key))) throw new ProductStoreV2Error("Product store options contain an unsupported capability.");
};

const removeExactFreshStage = (stage: string): void => {
  const info = lstatSync(stage);
  const uid = process.getuid?.();
  if (info.isSymbolicLink() || !info.isDirectory() || realpathSync(stage) !== stage || uid === undefined || info.uid !== uid || (info.mode & 0o022) !== 0) {
    throw new ProductStoreV2Error("Fresh initialization staging root changed before cleanup.");
  }
  rmSync(stage, { recursive: true, force: false });
};

const assertSecureParent = (parent: string): void => {
  if (!existsSync(parent) || realpathSync(parent) !== parent) throw new ProductStoreV2Error("Product storage parent must be an existing canonical directory.");
  const info = lstatSync(parent);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o022) !== 0) throw new ProductStoreV2Error("Product storage parent is unsafe.");
  const uid = process.getuid?.();
  if (uid === undefined || info.uid !== uid) throw new ProductStoreV2Error("Product storage parent is not owned by the current user.");
};

const syncExternalDirectory = (path: string): void => {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isDirectory()) throw new ProductStoreV2Error("Directory sync target is invalid.");
    fsyncSync(fd);
  } finally { closeSync(fd); }
};
