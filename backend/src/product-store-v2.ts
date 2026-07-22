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
  CreateProjectFromModelInput,
  IsoTimestamp,
  LifecycleState,
  ManagedResourceKind,
  ModelRecord,
  ModelRunMode,
  ModelTechnicalStatus,
  NamedManagedResourceKind,
  ObjectFileKind,
  PermanentDeletePreview,
  ProjectRecord,
  ResourceOwner,
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
  createdAt: IsoTimestamp;
};

export type CreateExperimentInput = {
  id: string;
  projectId: string;
  name: string;
  configuration: Record<string, unknown>;
  estimatedSampleCount: number;
  createdAt: IsoTimestamp;
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

  createConversation(input: CreateConversationInput): void {
    this.#databaseMutation([activeOwnerGuard(input.owner), {
      sql: `INSERT INTO conversations
        (id, model_id, project_id, name, provider_id, provider_model_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [input.id, input.owner.kind === "model" ? input.owner.id : null, input.owner.kind === "project" ? input.owner.id : null,
        input.name, input.providerId, input.providerModelId, input.createdAt, input.createdAt], expectedChanges: 1,
    }]);
  }

  createMessage(input: CreateMessageInput): void {
    this.#databaseMutation([activeLifecycleGuard("conversations", input.conversationId), {
      sql: `INSERT INTO messages
        (id, conversation_id, ordinal, role, status, text, content_json, action_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [input.id, input.conversationId, input.ordinal, input.role, input.status, input.text, json(input.content ?? {}), input.action === null || input.action === undefined ? null : json(input.action), input.createdAt, input.createdAt],
      expectedChanges: 1,
    }]);
  }

  createTemporaryDocument(input: CreateTemporaryDocumentInput): void {
    this.#databaseMutation([activeLifecycleGuard("conversations", input.conversationId), {
      sql: `INSERT INTO temporary_documents
        (id, conversation_id, source_message_id, name, document_state, media_type, content, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [input.id, input.conversationId, input.sourceMessageId ?? null, input.name, input.documentState, input.mediaType, input.content, input.createdAt, input.createdAt],
      expectedChanges: 1,
    }]);
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
    this.#coordinator.execute({ files: [{ operation: "write", target: { owner: input.owner, relativePath }, bytes: inspected.bytes, expectedPriorSha256: null }], statements: [
      activeLifecycleGuard("conversations", source.owner_conversation_id),
      activeOwnerGuard(input.owner),
      objectInsert({ id: input.objectFileId, owner: input.owner, kind: "adopted_attachment", relativePath, mediaType: source.media_type,
        sizeBytes: inspected.sizeBytes, digest: inspected.sha256, sourceAttachmentId: input.sourceAttachmentId, adoptionPurpose: input.purpose, createdAt: input.createdAt }),
    ] });
    return this.#file(input.objectFileId);
  }

  createExperiment(input: CreateExperimentInput): void {
    this.#databaseMutation([activeLifecycleGuard("projects", input.projectId), { sql: `INSERT INTO experiment_configurations
      (id, project_id, name, configuration_json, estimated_sample_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`, params: [input.id, input.projectId, input.name, json(input.configuration), input.estimatedSampleCount, input.createdAt, input.createdAt], expectedChanges: 1 }]);
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

  readObjectFile(id: string): Buffer {
    const row = this.#objectRow(id);
    const inspected = this.#objects.readWithInspection(ownerPath(row));
    if (!inspected || inspected.sha256 !== row.sha256 || inspected.sizeBytes !== row.size_bytes) throw new ProductStoreV2Error("Stored object metadata or bytes drifted.");
    return inspected.bytes;
  }

  #collectConversationClosure(
    conversationIds: string[], addRows: (table: string, rows: any[], key?: (row: any) => Record<string, string | number>) => void,
    files: ObjectRow[], blockers: Array<{ kind: string; id: string }>, exclusions: Array<{ kind: string; id: string; reason: string }>,
  ): void {
    for (const conversationId of conversationIds.sort()) {
      addRows("messages", this.#database.prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY ordinal").all(conversationId) as any[]);
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
