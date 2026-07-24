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
  ResourceOwner,
  RunRecord,
  RunStatus,
  StoredObjectMetadata,
  TemporaryDocumentState,
} from "./product-domain.ts";
import { MutationCoordinator, type DatabaseMutationStatement, type MutationCoordinatorOptions } from "./mutation-coordinator.ts";
import { ProductObjectStore, sha256, type OwnerPath } from "./object-store.ts";
import { openProductDatabase, type ProductDatabase } from "./product-schema.ts";

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

export type CreateOutputInput = {
  id: string;
  objectFileId: string;
  runId: string;
  relativePath: string;
  logicalName: string;
  outputType: string;
  mediaType: string;
  bytes: Uint8Array;
  createdAt: IsoTimestamp;
};

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
    const existing = this.#database.prepare("SELECT * FROM experiment_configurations WHERE id = ?").get(input.id) as any;
    if (existing) {
      const matches = existing.project_id === input.projectId && existing.name === input.name
        && existing.configuration_json === json(input.configuration) && existing.estimated_sample_count === input.estimatedSampleCount;
      if (!matches) throw new ProductStoreV2Error("Experiment configuration ID already exists with a different creation intent.");
      return experimentConfigurationRecord(existing);
    }
    this.#databaseMutation([activeLifecycleGuard("projects", input.projectId), { sql: `INSERT INTO experiment_configurations
      (id, project_id, name, configuration_json, estimated_sample_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`, params: [input.id, input.projectId, input.name, json(input.configuration), input.estimatedSampleCount, input.createdAt, input.createdAt], expectedChanges: 1 },
      ...(input.transactionId ? [commandReceiptInsert(input.transactionId, canonicalDigest({ id: input.id, projectId: input.projectId, name: input.name, configuration: input.configuration, estimatedSampleCount: input.estimatedSampleCount }))] : []),
    ]);
    return this.#experimentConfiguration(input.projectId, input.id);
  }

  updateExperiment(input: UpdateExperimentInput): ExperimentConfigurationRecord {
    const existingReceipt = this.#database.prepare("SELECT manifest_sha256 FROM committed_mutations WHERE transaction_id = ?").get(input.transactionId) as { manifest_sha256: string } | undefined;
    if (existingReceipt) {
      if (existingReceipt.manifest_sha256 !== input.intentDigest) throw new ProductStoreV2Error("Experiment configuration command already exists with a different intent.");
      const current = this.#experimentConfiguration(input.projectId, input.id);
      if (current.name !== input.name || canonicalDigest(current.configuration) !== canonicalDigest(input.configuration)
        || current.estimatedSampleCount !== input.estimatedSampleCount) {
        throw new ProductStoreV2Error("Experiment configuration command was already committed but current state changed.");
      }
      return current;
    }
    this.#databaseMutation([
      activeLifecycleGuard("projects", input.projectId),
      { sql: `UPDATE experiment_configurations SET name = ?, configuration_json = ?, estimated_sample_count = ?, updated_at = ?
        WHERE id = ? AND project_id = ? AND lifecycle_state = 'active'`,
      params: [input.name, json(input.configuration), input.estimatedSampleCount, input.updatedAt, input.id, input.projectId], expectedChanges: 1 },
      commandReceiptInsert(input.transactionId, input.intentDigest),
    ]);
    return this.#experimentConfiguration(input.projectId, input.id);
  }

  createRun(input: CreateRunInput): void {
    this.#databaseMutation([
      activeLifecycleGuard("projects", input.projectId),
      { sql: `UPDATE experiment_configurations SET updated_at = updated_at WHERE id = ? AND project_id = ? AND lifecycle_state = 'active'`, params: [input.experimentId, input.projectId], expectedChanges: 1 },
      { sql: `INSERT INTO runs
      (id, project_id, experiment_configuration_id, status, frozen_configuration_json, requested_sample_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, params: [input.id, input.projectId, input.experimentId, input.status, json(input.frozenConfiguration), input.requestedSampleCount, input.createdAt, input.createdAt], expectedChanges: 1 },
    ]);
  }

  createOutput(input: CreateOutputInput): StoredObjectMetadata {
    const run = this.#database.prepare("SELECT project_id FROM runs WHERE id = ?").get(input.runId) as { project_id: string } | undefined;
    if (!run) throw new ProductStoreV2Error("Run does not exist.");
    const owner = { kind: "run" as const, id: input.runId };
    const relativePath = `outputs/${input.relativePath}`;
    const target: OwnerPath = { owner, runProjectId: run.project_id, relativePath };
    const bytes = Buffer.from(input.bytes);
    const digest = sha256(bytes);
    this.#coordinator.execute({ files: [{ operation: "write", target, bytes, expectedPriorSha256: null }], statements: [
      activeLifecycleGuard("projects", run.project_id),
      { sql: "UPDATE runs SET updated_at = updated_at WHERE id = ? AND project_id = ? AND status != 'trashed'", params: [input.runId, run.project_id], expectedChanges: 1 },
      objectInsert({ id: input.objectFileId, owner, kind: "run_file", relativePath, mediaType: input.mediaType, sizeBytes: bytes.byteLength, digest, createdAt: input.createdAt }),
      { sql: `INSERT INTO output_indexes (id, run_id, object_file_id, logical_name, output_type, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`, params: [input.id, input.runId, input.objectFileId, input.logicalName, input.outputType, input.createdAt], expectedChanges: 1 },
    ] });
    return this.#file(input.objectFileId);
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

  listRunOutputs(runId: string): OutputIndexRecord[] {
    assertId(runId);
    return (this.#database.prepare(`SELECT
        o.id AS output_index_id, o.run_id AS output_run_id, o.object_file_id AS output_object_file_id,
        o.logical_name, o.output_type, o.created_at AS output_created_at,
        f.*, r.project_id AS run_project_id
      FROM output_indexes o
      JOIN object_files f ON f.id = o.object_file_id
      JOIN runs r ON r.id = o.run_id
      WHERE o.run_id = ?
      ORDER BY o.logical_name, o.id`).all(runId) as any[]).map((row) => ({
      id: row.output_index_id,
      runId: row.output_run_id,
      logicalName: row.logical_name,
      outputType: row.output_type,
      file: metadata({
        id: row.output_object_file_id,
        owner_model_id: row.owner_model_id,
        owner_project_id: row.owner_project_id,
        owner_conversation_id: row.owner_conversation_id,
        owner_run_id: row.owner_run_id,
        kind: row.kind,
        relative_path: row.relative_path,
        media_type: row.media_type,
        size_bytes: row.size_bytes,
        sha256: row.sha256,
        source_attachment_id: row.source_attachment_id,
        adoption_purpose: row.adoption_purpose,
        created_at: row.created_at,
        run_project_id: row.run_project_id,
      }),
      createdAt: row.output_created_at,
    }));
  }

  renameResource(kind: NamedManagedResourceKind, id: string, name: string, updatedAt: IsoTimestamp): void {
    const { table } = managedTable(kind);
    this.#databaseMutation([{ sql: `UPDATE ${table} SET name = ?, updated_at = ? WHERE id = ? AND lifecycle_state != 'trashed'`, params: [name, updatedAt, id], expectedChanges: 1 }]);
  }

  archiveResource(kind: NamedManagedResourceKind, id: string, at: IsoTimestamp): void {
    const { table } = managedTable(kind);
    this.#databaseMutation([{ sql: `UPDATE ${table} SET lifecycle_state = 'archived', archived_at = ?, updated_at = ?
      WHERE id = ? AND lifecycle_state = 'active'`, params: [at, at, id], expectedChanges: 1 }]);
  }

  restoreResource(kind: ManagedResourceKind, id: string, at: IsoTimestamp): void {
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
        for (const experiment of this.#database.prepare("SELECT * FROM experiment_configurations WHERE project_id = ? ORDER BY id").all(id) as any[]) addRows("experiment_configurations", [experiment]);
        for (const run of this.#database.prepare("SELECT * FROM runs WHERE project_id = ? ORDER BY id").all(id) as any[]) {
          addRows("runs", [run]);
          fileRows.push(...this.#objectRows("owner_run_id = ?", [run.id]));
          addRows("output_indexes", this.#database.prepare("SELECT * FROM output_indexes WHERE run_id = ? ORDER BY id").all(run.id) as any[]);
        }
      }
    } else if (kind === "conversation") {
      this.#collectConversationClosure([id], addRows, fileRows, blockers, exclusions);
    } else if (kind === "temporary_document") {
      exclusions.push({ kind: "conversation", id: row.conversation_id, reason: "owner outside temporary-document closure" });
      if (row.source_message_id) exclusions.push({ kind: "message", id: row.source_message_id, reason: "source reference outside temporary-document closure" });
    } else if (kind === "experiment") {
      const runs = this.#database.prepare("SELECT id FROM runs WHERE experiment_configuration_id = ? ORDER BY id").all(id) as Array<{ id: string }>;
      blockers.push(...runs.map((run) => ({ kind: "run", id: run.id })));
      exclusions.push({ kind: "project", id: row.project_id, reason: "owner outside experiment closure" });
    } else {
      fileRows.push(...this.#objectRows("owner_run_id = ?", [id]));
      addRows("output_indexes", this.#database.prepare("SELECT * FROM output_indexes WHERE run_id = ? ORDER BY id").all(id) as any[]);
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

  #verifiedMetadata(row: ObjectRow): StoredObjectMetadata {
    const inspected = this.#objects.readWithInspection(ownerPath(row));
    if (!inspected || inspected.sha256 !== row.sha256 || inspected.sizeBytes !== row.size_bytes) throw new ProductStoreV2Error("Permanent-delete preview found object metadata or digest drift.");
    return metadata(row);
  }

  #databaseMutation(statements: DatabaseMutationStatement[]): void {
    this.#assertOpen();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      for (const statement of statements) {
        if (!Number.isSafeInteger(statement.expectedChanges)) throw new ProductStoreV2Error("Every database mutation requires expectedChanges.");
        const result = this.#database.prepare(statement.sql).run(...(statement.params ?? []));
        if (Number(result.changes) !== statement.expectedChanges) throw new ProductStoreV2Error("Database mutation affected an unexpected number of rows.");
      }
      this.#database.exec("COMMIT");
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

  #verifyFrozenProject(project: any): void {
    const rows = this.#objectRows("owner_project_id = ? AND kind = 'project_model_snapshot'", [project.id]).sort(compareObjectRows);
    if (!rows.length) throw new ProductStoreV2Error("Existing Project snapshot is incomplete.");
    const files = rows.map((row) => this.#verifiedMetadata(row));
    const digest = canonicalDigest(files.map((file) => ({ relativePath: file.relativePath, mediaType: file.mediaType, sizeBytes: file.sizeBytes, sha256: file.sha256 }))
      .sort((left, right) => compareStrings(left.relativePath, right.relativePath)));
    if (digest !== project.model_snapshot_digest) throw new ProductStoreV2Error("Existing Project snapshot digest is corrupt.");
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

const experimentConfigurationRecord = (row: any): ExperimentConfigurationRecord => ({
  id: row.id,
  projectId: row.project_id,
  name: row.name,
  configuration: JSON.parse(row.configuration_json),
  estimatedSampleCount: row.estimated_sample_count,
  lifecycleState: row.lifecycle_state,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const runRecord = (row: any): RunRecord => ({
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
});

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
