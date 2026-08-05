import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonicalDigest } from "./canonical-json-v2.ts";
import {
  openProjectOnlyDatabase,
  ProjectOnlyRecoveryRequiredError,
  type ProjectOnlyDatabase,
} from "./project-only-schema.ts";

const DATABASE_NAME = "project-only.sqlite3";
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/u;
const TERMINAL_RUN_STATES = new Set(["succeeded", "failed", "cancelled", "timed_out", "interrupted"]);

export type ProjectTechnicalStatus = "draft" | "checking" | "executable" | "failed";
export type ProjectRunMode = "batch" | "visual" | "both";
export type ProjectFileKind = "project_code" | "project_environment" | "project_visual_asset";
export type ProjectRunStatus = "queued" | "running" | "cancelling" | "succeeded" | "failed" | "cancelled" | "timed_out" | "interrupted";
export type ProjectConversationLifecycle = "active" | "archived" | "trashed";
export type ProjectConversationSessionState = "none" | "connecting" | "available" | "lost" | "read_only";

export type ProjectFileInput = Readonly<{
  id: string;
  kind: ProjectFileKind;
  relativePath: string;
  mediaType: string;
  bytes: Uint8Array;
}>;

export type ProjectRecord = Readonly<{
  id: string;
  name: string;
  lifecycleState: "active" | "archived" | "trashed";
  technicalStatus: ProjectTechnicalStatus;
  runMode: ProjectRunMode;
  executionDescription: Record<string, unknown>;
  workspaceDigest: string;
  creationSource: "blank" | "template" | "import";
  creationSourceRef: string | null;
  executionLock: null | Readonly<{
    holderKind: "technical_check" | "run";
    holderId: string;
    sourceWorkspaceDigest: string;
    acquiredAt: string;
  }>;
  createdAt: string;
  updatedAt: string;
}>;

export type ProjectFileRecord = Readonly<{
  id: string;
  projectId: string;
  kind: ProjectFileKind;
  relativePath: string;
  mediaType: string;
  bytes: Buffer;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
  updatedAt: string;
}>;

export type ProjectTechnicalCheckRecord = Readonly<{
  id: string;
  projectId: string;
  capturedWorkspaceDigest: string;
  capturedFileDigest: string;
  executionDescriptionDigest: string;
  status: "running" | "succeeded" | "failed" | "interrupted";
  diagnostics: readonly unknown[];
  startedAt: string;
  finishedAt: string | null;
}>;

export type ProjectTemplateRecord = Readonly<{
  id: string;
  version: string;
  description: string;
  runMode: ProjectRunMode;
  contentDigest: string;
  createdAt: string;
}>;

export type ProjectRunRecord = Readonly<{
  id: string;
  projectId: string;
  experimentConfigurationId: string;
  runKind: "batch" | "visual";
  status: ProjectRunStatus;
  sourceWorkspaceDigest: string;
  frozenConfiguration: Record<string, unknown>;
  sourceFilesRetained: false;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  terminalCode: string | null;
}>;

export type ProjectRunOutputRecord = Readonly<{
  id: string;
  runId: string;
  sampleIndex: number;
  sampleId: string;
  logicalName: string;
  relativePath: string;
  mediaType: string;
  declaredRole: "data" | "diagnostic" | "replay" | "visual" | "document";
  bytes: Buffer;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
}>;

export type CreateProjectInput = Readonly<{
  id: string;
  name: string;
  source:
    | Readonly<{ kind: "blank" }>
    | Readonly<{ kind: "template"; templateId: string; version: string }>
    | Readonly<{ kind: "import"; importDigest: string; files: readonly ProjectFileInput[] }>;
  runMode?: ProjectRunMode;
  executionDescription?: Record<string, unknown>;
  createdAt: string;
}>;

export type ProjectConversationRecord = Readonly<{
  id: string;
  projectId: string;
  name: string;
  lifecycleState: ProjectConversationLifecycle;
  provider: Readonly<{ providerId: string; modelId: string; locked: boolean }>;
  sessionState: ProjectConversationSessionState;
  sessionGeneration: number;
  createdAt: string;
  updatedAt: string;
}>;

export type ProjectConversationMessageRecord = Readonly<{
  id: string;
  conversationId: string;
  ordinal: number;
  role: "user" | "assistant" | "system" | "tool";
  status: "streaming" | "complete" | "failed";
  messageKind: "conversation" | "platform_card";
  text: string;
  createdAt: string;
  updatedAt: string;
}>;

export type ProjectConversationTurnRecord = Readonly<{
  id: string;
  requestKey: string;
  conversationId: string;
  state: "running" | "complete" | "failed" | "read_only";
  userMessageId: string;
  assistantMessageId: string | null;
  agentName: string | null;
  actions: readonly Record<string, unknown>[];
  goalVerification: Record<string, unknown> | null;
  failureCode: string | null;
  createdAt: string;
  updatedAt: string;
}>;

export class ProjectOnlyStoreError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "ProjectOnlyStoreError";
  }
}

export class ProjectOnlyStore {
  readonly root: string;
  readonly #database: ProjectOnlyDatabase;
  #closed = false;
  #savepointSerial = 0;

  static open(rootInput: string): ProjectOnlyStore {
    const requested = resolve(rootInput);
    if (!existsSync(requested)) {
      const parent = realpathSync(dirname(requested));
      const target = join(parent, basename(requested));
      mkdirSync(target, { mode: 0o700 });
    }
    const root = realpathSync(requested);
    const legacyDatabasePath = join(root, "riff.sqlite3");
    if (!existsSync(join(root, DATABASE_NAME)) && existsSync(legacyDatabasePath)) {
      const legacy = new DatabaseSync(legacyDatabasePath, { readOnly: true });
      try {
        if (legacy.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'models'").get()) {
          throw new ProjectOnlyRecoveryRequiredError();
        }
      } finally { legacy.close(); }
    }
    const database = openProjectOnlyDatabase(join(root, DATABASE_NAME));
    return new ProjectOnlyStore(root, database);
  }

  private constructor(root: string, database: ProjectOnlyDatabase) {
    this.root = root;
    this.#database = database;
  }

  close(): void {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
  }

  createTemplateVersion(input: Readonly<{
    id: string;
    version: string;
    description: string;
    runMode: ProjectRunMode;
    executionDescription: Record<string, unknown>;
    defaultExperiment: Record<string, unknown>;
    files: readonly ProjectFileInput[];
    createdAt: string;
  }>): Readonly<{ id: string; version: string; contentDigest: string }> {
    this.#assertOpen();
    assertId(input.id);
    const files = normalizeFiles(input.files);
    const serializedFiles = files.map((file) => ({
      id: file.id, kind: file.kind, relativePath: file.relativePath, mediaType: file.mediaType,
      bytesBase64: file.bytes.toString("base64"), sha256: file.sha256,
    }));
    const contentDigest = canonicalDigest({
      runMode: input.runMode,
      executionDescription: input.executionDescription,
      defaultExperiment: input.defaultExperiment,
      files: serializedFiles,
    });
    try {
      this.#database.prepare(`INSERT INTO project_templates
        (id, version, description, run_mode, execution_description_json, default_experiment_json,
          files_json, content_digest, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(input.id, input.version, input.description, input.runMode, json(input.executionDescription),
          json(input.defaultExperiment), json(serializedFiles), contentDigest, input.createdAt);
    } catch (error) {
      if (String(error).includes("UNIQUE constraint failed")) {
        const existing = this.#database.prepare("SELECT content_digest FROM project_templates WHERE id = ? AND version = ?")
          .get(input.id, input.version) as { content_digest: string } | undefined;
        if (existing?.content_digest === contentDigest) return Object.freeze({ id: input.id, version: input.version, contentDigest });
        throw new ProjectOnlyStoreError("template_version_immutable", "Template versions are immutable.");
      }
      throw error;
    }
    return Object.freeze({ id: input.id, version: input.version, contentDigest });
  }

  createProject(input: CreateProjectInput): ProjectRecord {
    this.#assertOpen();
    assertId(input.id);
    let files: ReturnType<typeof normalizeFiles>;
    let runMode = input.runMode ?? "batch";
    let executionDescription = input.executionDescription ?? {};
    let sourceRef: string | null = null;
    let defaultExperiment: Record<string, unknown> | null = null;
    if (input.source.kind === "blank") {
      files = normalizeFiles([{
        id: stableResourceId("project_file", `${input.id}:scaffold`),
        kind: "project_code",
        relativePath: "model.py",
        mediaType: "text/x-python",
        bytes: Buffer.from("# Add an executable simulation model.\n"),
      }]);
    } else if (input.source.kind === "import") {
      if (!/^[0-9a-f]{64}$/u.test(input.source.importDigest)) throw new ProjectOnlyStoreError("invalid_import_digest", "Import digest is invalid.");
      files = normalizeFiles(input.source.files);
      sourceRef = input.source.importDigest;
    } else {
      const row = this.#database.prepare(`SELECT run_mode, execution_description_json, default_experiment_json, files_json, content_digest
        FROM project_templates WHERE id = ? AND version = ?`).get(input.source.templateId, input.source.version) as any;
      if (!row) throw new ProjectOnlyStoreError("template_not_found", "Project template version does not exist.");
      runMode = row.run_mode;
      executionDescription = JSON.parse(row.execution_description_json);
      defaultExperiment = JSON.parse(row.default_experiment_json);
      files = normalizeFiles((JSON.parse(row.files_json) as any[]).map((file) => ({
        id: `${input.id}_${createHash("sha256").update(file.id).digest("hex").slice(0, 16)}`,
        kind: file.kind,
        relativePath: file.relativePath,
        mediaType: file.mediaType,
        bytes: Buffer.from(file.bytesBase64, "base64"),
      })));
      sourceRef = `${input.source.templateId}@${input.source.version}:${row.content_digest}`;
    }
    if (files.length === 0) throw new ProjectOnlyStoreError("empty_project_import", "A Project import requires at least one file.");
    const workspaceDigest = calculateWorkspaceDigest(files, runMode, executionDescription);
    this.#transaction(() => {
      this.#database.prepare(`INSERT INTO projects
        (id, name, technical_status, run_mode, execution_description_json, workspace_digest,
          creation_source, creation_source_ref, created_at, updated_at)
        VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?)`)
        .run(input.id, input.name, runMode, json(executionDescription), workspaceDigest,
          input.source.kind, sourceRef, input.createdAt, input.createdAt);
      const insert = this.#database.prepare(`INSERT INTO project_files
        (id, project_id, kind, relative_path, media_type, bytes, size_bytes, sha256, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const file of files) insert.run(file.id, input.id, file.kind, file.relativePath, file.mediaType,
        file.bytes, file.bytes.byteLength, file.sha256, input.createdAt, input.createdAt);
      if (defaultExperiment) {
        this.#database.prepare(`INSERT INTO experiment_configurations
          (id, project_id, name, configuration_json, created_at, updated_at)
          VALUES (?, ?, 'Default', ?, ?, ?)`)
          .run(stableResourceId("experiment", `${input.id}:template-default`), input.id,
            json(defaultExperiment), input.createdAt, input.createdAt);
      }
    });
    return this.project(input.id);
  }

  createProjectWithConversation(input: Readonly<{
    commandId: string;
    project: CreateProjectInput;
    conversation: Readonly<{
      id: string;
      name: string;
      providerId: string;
      modelId: string;
    }>;
  }>): Readonly<{
    project: ProjectRecord;
    conversation: ProjectConversationRecord;
    receiptDigest: string;
  }> {
    this.#assertOpen();
    assertId(input.commandId);
    assertId(input.conversation.id);
    const intentDigest = canonicalDigest({
      commandId: input.commandId,
      project: {
        id: input.project.id,
        name: input.project.name,
        source: input.project.source.kind === "import"
          ? {
            kind: "import",
            importDigest: input.project.source.importDigest,
            files: input.project.source.files.map((file) => ({
              id: file.id,
              kind: file.kind,
              relativePath: file.relativePath,
              mediaType: file.mediaType,
              sha256: createHash("sha256").update(file.bytes).digest("hex"),
            })),
          }
          : input.project.source,
        runMode: input.project.runMode ?? null,
        executionDescription: input.project.executionDescription ?? null,
        createdAt: input.project.createdAt,
      },
      conversation: input.conversation,
    });
    const prior = this.#database.prepare("SELECT * FROM project_creation_receipts WHERE command_id = ?")
      .get(input.commandId) as any;
    if (prior) {
      if (prior.intent_digest !== intentDigest) {
        throw new ProjectOnlyStoreError("idempotency_conflict", "Project creation command was reused with different intent.");
      }
      const project = this.project(prior.project_id);
      const conversation = this.conversation(prior.conversation_id);
      return Object.freeze({ project, conversation, receiptDigest: prior.receipt_digest });
    }
    let receiptDigest = "";
    this.#transaction(() => {
      const project = this.createProject(input.project);
      this.#insertConversation({
        id: input.conversation.id,
        projectId: project.id,
        name: input.conversation.name,
        providerId: input.conversation.providerId,
        modelId: input.conversation.modelId,
        createdAt: input.project.createdAt,
      });
      const response = {
        projectId: project.id,
        conversationId: input.conversation.id,
        workspaceDigest: project.workspaceDigest,
      };
      receiptDigest = canonicalDigest({ operation: "create_project_with_conversation", intentDigest, response });
      this.#database.prepare(`INSERT INTO project_creation_receipts
        (command_id, intent_digest, project_id, conversation_id, response_json, receipt_digest, committed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(input.commandId, intentDigest, project.id, input.conversation.id, json(response),
          receiptDigest, input.project.createdAt);
    });
    return Object.freeze({
      project: this.project(input.project.id),
      conversation: this.conversation(input.conversation.id),
      receiptDigest,
    });
  }

  createConversation(input: Readonly<{
    id: string;
    projectId: string;
    name: string;
    providerId: string;
    modelId: string;
    createdAt: string;
  }>): ProjectConversationRecord {
    this.#assertOpen();
    this.project(input.projectId);
    this.#insertConversation(input);
    return this.conversation(input.id);
  }

  conversation(id: string): ProjectConversationRecord {
    this.#assertOpen();
    const row = this.#database.prepare("SELECT * FROM project_conversations WHERE id = ?").get(id) as any;
    if (!row) throw new ProjectOnlyStoreError("conversation_not_found", "Conversation does not exist.");
    return conversationRecord(row);
  }

  conversations(projectId: string, lifecycle?: ProjectConversationLifecycle): ProjectConversationRecord[] {
    this.#assertOpen();
    const rows = lifecycle
      ? this.#database.prepare(`SELECT * FROM project_conversations
          WHERE project_id = ? AND lifecycle_state = ? ORDER BY updated_at, id`).all(projectId, lifecycle)
      : this.#database.prepare(`SELECT * FROM project_conversations
          WHERE project_id = ? ORDER BY updated_at, id`).all(projectId);
    return (rows as any[]).map(conversationRecord);
  }

  conversationMessages(conversationId: string): ProjectConversationMessageRecord[] {
    this.#assertOpen();
    this.conversation(conversationId);
    return (this.#database.prepare(`SELECT * FROM project_conversation_messages
      WHERE conversation_id = ? ORDER BY ordinal`).all(conversationId) as any[]).map(conversationMessageRecord);
  }

  conversationTurns(conversationId: string): ProjectConversationTurnRecord[] {
    this.#assertOpen();
    this.conversation(conversationId);
    return (this.#database.prepare(`SELECT * FROM project_conversation_turns
      WHERE conversation_id = ? ORDER BY created_at, id`).all(conversationId) as any[]).map(conversationTurnRecord);
  }

  conversationTurn(requestKey: string): ProjectConversationTurnRecord | null {
    this.#assertOpen();
    const row = this.#database.prepare("SELECT * FROM project_conversation_turns WHERE request_key = ?")
      .get(requestKey) as any;
    return row ? conversationTurnRecord(row) : null;
  }

  beginConversationTurn(input: Readonly<{
    id: string;
    requestKey: string;
    conversationId: string;
    text: string;
    agentName?: string;
    createdAt: string;
  }>): ProjectConversationTurnRecord {
    this.#assertOpen();
    assertId(input.id);
    assertId(input.requestKey);
    const prior = this.conversationTurn(input.requestKey);
    if (prior) {
      if (prior.conversationId !== input.conversationId) {
        throw new ProjectOnlyStoreError("idempotency_conflict", "Turn request key belongs to another Conversation.");
      }
      return prior;
    }
    this.#transaction(() => {
      const conversation = this.conversation(input.conversationId);
      if (conversation.lifecycleState !== "active") {
        throw new ProjectOnlyStoreError("conversation_not_active", "Conversation is not active.");
      }
      const ordinal = Number((this.#database.prepare(`SELECT coalesce(max(ordinal), 0) + 1 AS ordinal
        FROM project_conversation_messages WHERE conversation_id = ?`).get(input.conversationId) as any).ordinal);
      const userMessageId = stableResourceId("message", `${input.conversationId}:${input.requestKey}:user`);
      this.#database.prepare(`INSERT INTO project_conversation_messages
        (id, conversation_id, ordinal, role, status, message_kind, text, created_at, updated_at)
        VALUES (?, ?, ?, 'user', 'complete', 'conversation', ?, ?, ?)`)
        .run(userMessageId, input.conversationId, ordinal, input.text, input.createdAt, input.createdAt);
      this.#database.prepare(`INSERT INTO project_conversation_turns
        (request_key, id, conversation_id, state, user_message_id, agent_name, created_at, updated_at)
        VALUES (?, ?, ?, 'running', ?, ?, ?, ?)`)
        .run(input.requestKey, input.id, input.conversationId, userMessageId,
          input.agentName ?? null, input.createdAt, input.createdAt);
      this.#database.prepare(`UPDATE project_conversations
        SET provider_locked = 1, session_state = 'connecting', updated_at = ? WHERE id = ?`)
        .run(input.createdAt, input.conversationId);
    });
    return this.conversationTurn(input.requestKey)!;
  }

  setConversationSession(input: Readonly<{
    conversationId: string;
    state: ProjectConversationSessionState;
    externalSessionRef?: string | null;
    incrementGeneration?: boolean;
    updatedAt: string;
  }>): ProjectConversationRecord {
    this.#assertOpen();
    const changed = this.#database.prepare(`UPDATE project_conversations
      SET session_state = ?, external_session_ref = ?,
        session_generation = session_generation + ?, updated_at = ? WHERE id = ?`)
      .run(input.state, input.externalSessionRef ?? null, input.incrementGeneration ? 1 : 0,
        input.updatedAt, input.conversationId);
    if (changed.changes !== 1) throw new ProjectOnlyStoreError("conversation_not_found", "Conversation does not exist.");
    return this.conversation(input.conversationId);
  }

  conversationSession(conversationId: string): Readonly<{
    state: ProjectConversationSessionState;
    generation: number;
    externalSessionRef: string | null;
  }> {
    this.#assertOpen();
    const row = this.#database.prepare(`SELECT session_state, session_generation, external_session_ref
      FROM project_conversations WHERE id = ?`).get(conversationId) as any;
    if (!row) throw new ProjectOnlyStoreError("conversation_not_found", "Conversation does not exist.");
    return Object.freeze({
      state: row.session_state,
      generation: row.session_generation,
      externalSessionRef: row.external_session_ref,
    });
  }

  changeConversationProvider(input: Readonly<{
    conversationId: string;
    providerId: string;
    modelId: string;
    updatedAt: string;
  }>): ProjectConversationRecord {
    this.#assertOpen();
    const conversation = this.conversation(input.conversationId);
    if (conversation.provider.locked) {
      throw new ProjectOnlyStoreError("conversation_provider_locked", "Provider is locked after the first accepted message.");
    }
    this.#database.prepare(`UPDATE project_conversations SET provider_id = ?, model_id = ?, updated_at = ?
      WHERE id = ?`).run(input.providerId, input.modelId, input.updatedAt, input.conversationId);
    return this.conversation(input.conversationId);
  }

  completeConversationTurn(input: Readonly<{
    requestKey: string;
    assistantText: string;
    actions: readonly Record<string, unknown>[];
    goalVerification: Record<string, unknown>;
    completedAt: string;
  }>): ProjectConversationTurnRecord {
    this.#assertOpen();
    this.#transaction(() => {
      const turn = this.conversationTurn(input.requestKey);
      if (!turn || turn.state !== "running") {
        throw new ProjectOnlyStoreError("conversation_turn_not_running", "Conversation turn is not running.");
      }
      const ordinal = Number((this.#database.prepare(`SELECT coalesce(max(ordinal), 0) + 1 AS ordinal
        FROM project_conversation_messages WHERE conversation_id = ?`).get(turn.conversationId) as any).ordinal);
      const messageId = stableResourceId("message", `${turn.conversationId}:${input.requestKey}:assistant`);
      this.#database.prepare(`INSERT INTO project_conversation_messages
        (id, conversation_id, ordinal, role, status, message_kind, text, created_at, updated_at)
        VALUES (?, ?, ?, 'assistant', 'complete', 'conversation', ?, ?, ?)`)
        .run(messageId, turn.conversationId, ordinal, input.assistantText, input.completedAt, input.completedAt);
      this.#database.prepare(`UPDATE project_conversation_turns SET state = 'complete',
        assistant_message_id = ?, actions_json = ?, goal_verification_json = ?, updated_at = ?
        WHERE request_key = ?`).run(messageId, json(input.actions), json(input.goalVerification),
          input.completedAt, input.requestKey);
      this.#database.prepare(`UPDATE project_conversations SET session_state = 'available', updated_at = ? WHERE id = ?`)
        .run(input.completedAt, turn.conversationId);
    });
    return this.conversationTurn(input.requestKey)!;
  }

  failConversationTurn(input: Readonly<{
    requestKey: string;
    state: "failed" | "read_only";
    code: string;
    assistantText?: string;
    actions?: readonly Record<string, unknown>[];
    goalVerification: Record<string, unknown>;
    failedAt: string;
  }>): ProjectConversationTurnRecord {
    this.#assertOpen();
    this.#transaction(() => {
      const turn = this.conversationTurn(input.requestKey);
      if (!turn || turn.state !== "running") {
        throw new ProjectOnlyStoreError("conversation_turn_not_running", "Conversation turn is not running.");
      }
      let assistantMessageId: string | null = null;
      if (input.assistantText) {
        const ordinal = Number((this.#database.prepare(`SELECT coalesce(max(ordinal), 0) + 1 AS ordinal
          FROM project_conversation_messages WHERE conversation_id = ?`).get(turn.conversationId) as any).ordinal);
        assistantMessageId = stableResourceId("message", `${turn.conversationId}:${input.requestKey}:assistant`);
        this.#database.prepare(`INSERT INTO project_conversation_messages
          (id, conversation_id, ordinal, role, status, message_kind, text, created_at, updated_at)
          VALUES (?, ?, ?, 'assistant', 'failed', 'conversation', ?, ?, ?)`)
          .run(assistantMessageId, turn.conversationId, ordinal, input.assistantText, input.failedAt, input.failedAt);
      }
      this.#database.prepare(`UPDATE project_conversation_turns SET state = ?, assistant_message_id = ?,
        actions_json = ?, goal_verification_json = ?, failure_code = ?, updated_at = ? WHERE request_key = ?`)
        .run(input.state, assistantMessageId, json(input.actions ?? []), json(input.goalVerification), input.code,
          input.failedAt, input.requestKey);
      this.#database.prepare(`UPDATE project_conversations SET session_state = ?, updated_at = ? WHERE id = ?`)
        .run(input.state === "read_only" ? "read_only" : "lost", input.failedAt, turn.conversationId);
    });
    return this.conversationTurn(input.requestKey)!;
  }

  #insertConversation(input: Readonly<{
    id: string;
    projectId: string;
    name: string;
    providerId: string;
    modelId: string;
    createdAt: string;
  }>): void {
    assertId(input.id);
    if (!input.name.trim() || input.name.length > 200
      || !input.providerId || input.providerId.length > 200
      || !input.modelId || input.modelId.length > 500) {
      throw new ProjectOnlyStoreError("invalid_conversation", "Conversation creation input is invalid.");
    }
    this.#database.prepare(`INSERT INTO project_conversations
      (id, project_id, name, provider_id, model_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(input.id, input.projectId, input.name, input.providerId, input.modelId,
        input.createdAt, input.createdAt);
  }

  templates(): ProjectTemplateRecord[] {
    this.#assertOpen();
    return (this.#database.prepare(`SELECT id, version, description, run_mode, content_digest, created_at
      FROM project_templates ORDER BY created_at, id, version`).all() as any[])
      .map((row) => Object.freeze({
        id: row.id,
        version: row.version,
        description: row.description,
        runMode: row.run_mode,
        contentDigest: row.content_digest,
        createdAt: row.created_at,
      }));
  }

  project(id: string): ProjectRecord {
    this.#assertOpen();
    const row = this.#database.prepare(`SELECT p.*, l.holder_kind, l.holder_id,
      l.source_workspace_digest AS lock_source_workspace_digest, l.acquired_at
      FROM projects p LEFT JOIN execution_locks l ON l.project_id = p.id WHERE p.id = ?`).get(id) as any;
    if (!row) throw new ProjectOnlyStoreError("project_not_found", "Project does not exist.");
    return projectRecord(row);
  }

  projects(): ProjectRecord[] {
    this.#assertOpen();
    return (this.#database.prepare(`SELECT p.*, l.holder_kind, l.holder_id,
      l.source_workspace_digest AS lock_source_workspace_digest, l.acquired_at
      FROM projects p LEFT JOIN execution_locks l ON l.project_id = p.id ORDER BY p.created_at, p.id`).all() as any[])
      .map(projectRecord);
  }

  projectFiles(projectId: string): ProjectFileRecord[] {
    this.#assertOpen();
    return (this.#database.prepare("SELECT * FROM project_files WHERE project_id = ? ORDER BY relative_path")
      .all(projectId) as any[]).map(fileRecord);
  }

  updateProjectWorkspace(input: Readonly<{
    projectId: string;
    expectedWorkspaceDigest: string;
    changes: readonly (ProjectFileInput | Readonly<{ relativePath: string; bytes: null }>)[];
    executionDescription?: Record<string, unknown>;
    runMode?: ProjectRunMode;
    updatedAt: string;
  }>): ProjectRecord {
    this.#assertOpen();
    const current = this.project(input.projectId);
    if (current.executionLock) throw new ProjectOnlyStoreError("project_execution_locked", "Executable Project files are locked by an active check or Run.");
    if (current.workspaceDigest !== input.expectedWorkspaceDigest) throw new ProjectOnlyStoreError("stale_workspace_digest", "Project workspace changed before the write.");
    const existing = this.projectFiles(input.projectId);
    const next = new Map(existing.map((file) => [file.relativePath, {
      id: file.id, kind: file.kind, relativePath: file.relativePath, mediaType: file.mediaType,
      bytes: file.bytes, sha256: file.sha256,
    }]));
    for (const change of input.changes) {
      assertRelativePath(change.relativePath);
      if (change.bytes === null) next.delete(change.relativePath);
      else next.set(change.relativePath, normalizeFiles([change])[0]!);
    }
    if (next.size === 0) throw new ProjectOnlyStoreError("empty_project_workspace", "Project workspace cannot be empty.");
    const runMode = input.runMode ?? current.runMode;
    const executionDescription = input.executionDescription ?? current.executionDescription;
    const nextFiles = [...next.values()].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    const digest = calculateWorkspaceDigest(nextFiles, runMode, executionDescription);
    this.#transaction(() => {
      this.#database.prepare("DELETE FROM project_files WHERE project_id = ?").run(input.projectId);
      const insert = this.#database.prepare(`INSERT INTO project_files
        (id, project_id, kind, relative_path, media_type, bytes, size_bytes, sha256, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const file of nextFiles) insert.run(file.id, input.projectId, file.kind, file.relativePath,
        file.mediaType, file.bytes, file.bytes.byteLength, file.sha256, input.updatedAt, input.updatedAt);
      const changed = this.#database.prepare(`UPDATE projects SET technical_status = 'draft', run_mode = ?,
        execution_description_json = ?, workspace_digest = ?, updated_at = ?
        WHERE id = ? AND workspace_digest = ?`).run(runMode, json(executionDescription), digest, input.updatedAt,
          input.projectId, input.expectedWorkspaceDigest);
      if (changed.changes !== 1) throw new ProjectOnlyStoreError("stale_workspace_digest", "Project workspace changed before commit.");
    });
    return this.project(input.projectId);
  }

  createExperiment(input: Readonly<{ id: string; projectId: string; name: string; configuration: Record<string, unknown>; createdAt: string }>): void {
    this.#assertOpen();
    assertId(input.id);
    this.#database.prepare(`INSERT INTO experiment_configurations
      (id, project_id, name, configuration_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(input.id, input.projectId, input.name, json(input.configuration), input.createdAt, input.createdAt);
  }

  updateExperiment(input: Readonly<{ id: string; projectId: string; name?: string; configuration: Record<string, unknown>; updatedAt: string }>): void {
    this.#assertOpen();
    const result = this.#database.prepare(`UPDATE experiment_configurations SET name = coalesce(?, name),
      configuration_json = ?, updated_at = ? WHERE id = ? AND project_id = ?`)
      .run(input.name ?? null, json(input.configuration), input.updatedAt, input.id, input.projectId);
    if (result.changes !== 1) throw new ProjectOnlyStoreError("experiment_not_found", "Experiment does not exist.");
  }

  experiments(projectId: string): readonly Readonly<{
    id: string;
    projectId: string;
    name: string;
    configuration: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
  }>[] {
    this.#assertOpen();
    return (this.#database.prepare("SELECT * FROM experiment_configurations WHERE project_id = ? ORDER BY created_at, id").all(projectId) as any[])
      .map((row) => Object.freeze({
        id: row.id,
        projectId: row.project_id,
        name: row.name,
        configuration: JSON.parse(row.configuration_json),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
  }

  startTechnicalCheck(input: Readonly<{ id: string; projectId: string; expectedWorkspaceDigest: string; startedAt: string }>): void {
    this.#assertOpen();
    assertId(input.id);
    this.#transaction(() => {
      const project = this.project(input.projectId);
      if (project.workspaceDigest !== input.expectedWorkspaceDigest) throw new ProjectOnlyStoreError("stale_workspace_digest", "Project workspace changed before technical check.");
      if (project.executionLock) throw new ProjectOnlyStoreError("project_execution_locked", "Project already has an active check or Run.");
      this.#database.prepare(`INSERT INTO project_technical_checks
        (id, project_id, captured_workspace_digest, status, started_at) VALUES (?, ?, ?, 'running', ?)`)
        .run(input.id, input.projectId, input.expectedWorkspaceDigest, input.startedAt);
      this.#database.prepare(`INSERT INTO execution_locks
        (project_id, holder_kind, holder_id, source_workspace_digest, acquired_at)
        VALUES (?, 'technical_check', ?, ?, ?)`)
        .run(input.projectId, input.id, input.expectedWorkspaceDigest, input.startedAt);
      this.#database.prepare("UPDATE projects SET technical_status = 'checking', updated_at = ? WHERE id = ?")
        .run(input.startedAt, input.projectId);
    });
  }

  finishTechnicalCheck(input: Readonly<{
    id: string;
    succeeded: boolean;
    diagnostics: readonly unknown[];
    capturedFileDigest?: string;
    executionDescriptionDigest?: string;
    finishedAt: string;
  }>): ProjectRecord {
    this.#assertOpen();
    let projectId = "";
    this.#transaction(() => {
      const check = this.#database.prepare(`SELECT c.*, l.project_id AS locked_project_id FROM project_technical_checks c
        JOIN execution_locks l ON l.holder_kind = 'technical_check' AND l.holder_id = c.id WHERE c.id = ? AND c.status = 'running'`)
        .get(input.id) as any;
      if (!check) throw new ProjectOnlyStoreError("technical_check_not_active", "Technical check is not active.");
      projectId = check.project_id;
      const project = this.project(projectId);
      if (project.workspaceDigest !== check.captured_workspace_digest) throw new ProjectOnlyStoreError("technical_check_digest_drift", "Technical check source digest drifted.");
      this.#database.prepare(`UPDATE project_technical_checks SET status = ?, diagnostics_json = ?,
        captured_file_digest = ?, execution_description_digest = ?, finished_at = ? WHERE id = ?`)
        .run(input.succeeded ? "succeeded" : "failed", json(input.diagnostics),
          input.capturedFileDigest ?? null, input.executionDescriptionDigest ?? null, input.finishedAt, input.id);
      this.#database.prepare("DELETE FROM execution_locks WHERE project_id = ? AND holder_kind = 'technical_check' AND holder_id = ?")
        .run(projectId, input.id);
      this.#database.prepare("UPDATE projects SET technical_status = ?, updated_at = ? WHERE id = ?")
        .run(input.succeeded ? "executable" : "failed", input.finishedAt, projectId);
    });
    return this.project(projectId);
  }

  technicalCheck(id: string): ProjectTechnicalCheckRecord {
    this.#assertOpen();
    const row = this.#database.prepare("SELECT * FROM project_technical_checks WHERE id = ?").get(id) as any;
    if (!row) throw new ProjectOnlyStoreError("technical_check_not_found", "Technical check does not exist.");
    return Object.freeze({
      id: row.id,
      projectId: row.project_id,
      capturedWorkspaceDigest: row.captured_workspace_digest,
      capturedFileDigest: row.captured_file_digest ?? "",
      executionDescriptionDigest: row.execution_description_digest ?? "",
      status: row.status,
      diagnostics: JSON.parse(row.diagnostics_json),
      startedAt: row.started_at,
      finishedAt: row.finished_at,
    });
  }

  startRun(input: Readonly<{
    id: string;
    projectId: string;
    experimentConfigurationId: string;
    runKind: "batch" | "visual";
    expectedWorkspaceDigest: string;
    createdAt: string;
  }>): void {
    this.#assertOpen();
    assertId(input.id);
    this.#transaction(() => {
      const project = this.project(input.projectId);
      if (project.executionLock) throw new ProjectOnlyStoreError("project_execution_locked", "Project already has an active check or Run.");
      if (project.technicalStatus !== "executable" || project.workspaceDigest !== input.expectedWorkspaceDigest) {
        throw new ProjectOnlyStoreError("project_not_executable", "Run requires the technically checked current Project digest.");
      }
      if (project.runMode !== "both" && project.runMode !== input.runKind) throw new ProjectOnlyStoreError("run_kind_not_declared", "Run kind is not declared by this Project.");
      const check = this.#database.prepare(`SELECT 1 FROM project_technical_checks
        WHERE project_id = ? AND captured_workspace_digest = ? AND status = 'succeeded'
        ORDER BY finished_at DESC LIMIT 1`).get(input.projectId, input.expectedWorkspaceDigest);
      if (!check) throw new ProjectOnlyStoreError("technical_check_required", "The current Project digest has not passed technical checks.");
      const experiment = this.#database.prepare(`SELECT configuration_json FROM experiment_configurations
        WHERE id = ? AND project_id = ?`).get(input.experimentConfigurationId, input.projectId) as { configuration_json: string } | undefined;
      if (!experiment) throw new ProjectOnlyStoreError("experiment_not_found", "Experiment does not exist.");
      this.#database.prepare(`INSERT INTO runs
        (id, project_id, experiment_configuration_id, run_kind, status, source_workspace_digest,
          frozen_configuration_json, execution_description_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`)
        .run(input.id, input.projectId, input.experimentConfigurationId, input.runKind,
          input.expectedWorkspaceDigest, experiment.configuration_json, json(project.executionDescription), input.createdAt, input.createdAt);
      this.#database.prepare(`INSERT INTO execution_locks
        (project_id, holder_kind, holder_id, source_workspace_digest, acquired_at)
        VALUES (?, 'run', ?, ?, ?)`)
        .run(input.projectId, input.id, input.expectedWorkspaceDigest, input.createdAt);
    });
  }

  transitionRun(input: Readonly<{ id: string; status: ProjectRunStatus; at: string; terminalCode?: string | null }>): void {
    this.#assertOpen();
    const allowed: Record<ProjectRunStatus, readonly ProjectRunStatus[]> = {
      queued: ["running", "cancelled", "failed", "timed_out", "interrupted"],
      running: ["cancelling", "succeeded", "failed", "cancelled", "timed_out", "interrupted"],
      cancelling: ["cancelled", "failed", "timed_out", "interrupted"],
      succeeded: [], failed: [], cancelled: [], timed_out: [], interrupted: [],
    };
    this.#transaction(() => {
      const run = this.#database.prepare("SELECT project_id, status FROM runs WHERE id = ?").get(input.id) as { project_id: string; status: ProjectRunStatus } | undefined;
      if (!run) throw new ProjectOnlyStoreError("run_not_found", "Run does not exist.");
      if (!allowed[run.status].includes(input.status)) throw new ProjectOnlyStoreError("invalid_run_transition", `Cannot transition Run from ${run.status} to ${input.status}.`);
      const terminal = TERMINAL_RUN_STATES.has(input.status);
      this.#database.prepare(`UPDATE runs SET status = ?, updated_at = ?,
        started_at = CASE WHEN ? = 'running' THEN coalesce(started_at, ?) ELSE started_at END,
        finished_at = CASE WHEN ? THEN ? ELSE finished_at END,
        terminal_code = CASE WHEN ? THEN ? ELSE terminal_code END WHERE id = ?`)
        .run(input.status, input.at, input.status, input.at, terminal ? 1 : 0, input.at,
          terminal ? 1 : 0, input.terminalCode ?? null, input.id);
      if (terminal) this.#database.prepare("DELETE FROM execution_locks WHERE project_id = ? AND holder_kind = 'run' AND holder_id = ?")
        .run(run.project_id, input.id);
    });
  }

  run(id: string): ProjectRunRecord {
    this.#assertOpen();
    const row = this.#database.prepare("SELECT * FROM runs WHERE id = ?").get(id) as any;
    if (!row) throw new ProjectOnlyStoreError("run_not_found", "Run does not exist.");
    return runRecord(row);
  }

  runs(projectId: string): ProjectRunRecord[] {
    this.#assertOpen();
    return (this.#database.prepare("SELECT * FROM runs WHERE project_id = ? ORDER BY created_at, id")
      .all(projectId) as any[]).map(runRecord);
  }

  runExecutionDescription(id: string): Record<string, unknown> {
    this.#assertOpen();
    const row = this.#database.prepare("SELECT execution_description_json FROM runs WHERE id = ?")
      .get(id) as { execution_description_json: string } | undefined;
    if (!row) throw new ProjectOnlyStoreError("run_not_found", "Run does not exist.");
    return JSON.parse(row.execution_description_json);
  }

  runOutputs(runId: string): ProjectRunOutputRecord[] {
    this.#assertOpen();
    this.run(runId);
    return (this.#database.prepare("SELECT * FROM run_outputs WHERE run_id = ? ORDER BY sample_index, logical_name")
      .all(runId) as any[]).map(runOutputRecord);
  }

  runCompletion(runId: string): Readonly<{ completion: Record<string, unknown>; digest: string; createdAt: string }> | null {
    this.#assertOpen();
    const row = this.#database.prepare("SELECT * FROM run_completion_records WHERE run_id = ?").get(runId) as any;
    return row ? Object.freeze({
      completion: JSON.parse(row.completion_json),
      digest: row.completion_digest,
      createdAt: row.created_at,
    }) : null;
  }

  commitBatchRunResult(input: Readonly<{
    runId: string;
    status: "succeeded" | "failed" | "timed_out" | "cancelled";
    terminalCode: string;
    outputs: readonly Readonly<{
      id: string;
      sampleIndex: number;
      sampleId: string;
      logicalName: string;
      relativePath: string;
      mediaType: string;
      declaredRole: "data" | "diagnostic" | "replay" | "visual" | "document";
      bytes: Uint8Array;
    }>[];
    completion: Record<string, unknown>;
    finishedAt: string;
  }>): void {
    this.#assertOpen();
    const completionDigest = canonicalDigest(input.completion);
    this.#transaction(() => {
      const run = this.run(input.runId);
      if (run.runKind !== "batch") throw new ProjectOnlyStoreError("run_kind_mismatch", "Batch completion requires a batch Run.");
      if (!["queued", "running", "cancelling"].includes(run.status)) {
        const existing = this.runCompletion(run.id);
        if (existing?.digest === completionDigest && run.status === input.status) return;
        throw new ProjectOnlyStoreError("run_already_terminal", "Run is already terminal with different completion evidence.");
      }
      const insert = this.#database.prepare(`INSERT INTO run_outputs
        (id, run_id, sample_index, sample_id, logical_name, relative_path, media_type,
          declared_role, bytes, size_bytes, sha256, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const output of input.outputs) {
        const bytes = Buffer.from(output.bytes);
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        insert.run(output.id, run.id, output.sampleIndex, output.sampleId, output.logicalName,
          output.relativePath, output.mediaType, output.declaredRole, bytes, bytes.byteLength,
          sha256, input.finishedAt);
      }
      this.#database.prepare(`INSERT INTO run_completion_records
        (run_id, completion_json, completion_digest, created_at) VALUES (?, ?, ?, ?)`)
        .run(run.id, json(input.completion), completionDigest, input.finishedAt);
      this.#database.prepare(`UPDATE runs SET status = ?, updated_at = ?, finished_at = ?, terminal_code = ?
        WHERE id = ?`).run(input.status, input.finishedAt, input.finishedAt, input.terminalCode, run.id);
      this.#database.prepare("DELETE FROM execution_locks WHERE project_id = ? AND holder_kind = 'run' AND holder_id = ?")
        .run(run.projectId, run.id);
    });
  }

  deliveryReceipt(commandId: string): Readonly<{
    projectId: string;
    intentDigest: string;
    response: Record<string, unknown>;
    receiptDigest: string;
  }> | null {
    this.#assertOpen();
    const row = this.#database.prepare("SELECT * FROM project_delivery_receipts WHERE command_id = ?").get(commandId) as any;
    return row ? Object.freeze({
      projectId: row.project_id,
      intentDigest: row.intent_digest,
      response: JSON.parse(row.response_json),
      receiptDigest: row.receipt_digest,
    }) : null;
  }

  recordDeliveryReceipt(input: Readonly<{
    commandId: string;
    projectId: string;
    intentDigest: string;
    response: Record<string, unknown>;
    receiptDigest: string;
    committedAt: string;
  }>): void {
    this.#assertOpen();
    this.#database.prepare(`INSERT INTO project_delivery_receipts
      (command_id, project_id, intent_digest, response_json, receipt_digest, committed_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(input.commandId, input.projectId, input.intentDigest, json(input.response), input.receiptDigest, input.committedAt);
  }

  reconcileInterruptedExecutions(at: string): Readonly<{ checks: number; runs: number }> {
    this.#assertOpen();
    let checks = 0;
    let runs = 0;
    this.#transaction(() => {
      checks = Number(this.#database.prepare(`UPDATE project_technical_checks SET status = 'interrupted', finished_at = ?
        WHERE status = 'running' AND id IN (SELECT holder_id FROM execution_locks WHERE holder_kind = 'technical_check')`).run(at).changes);
      runs = Number(this.#database.prepare(`UPDATE runs SET status = 'interrupted', updated_at = ?, finished_at = ?, terminal_code = 'backend_restart'
        WHERE status IN ('queued', 'running', 'cancelling') AND id IN (SELECT holder_id FROM execution_locks WHERE holder_kind = 'run')`).run(at, at).changes);
      this.#database.prepare(`UPDATE projects SET technical_status = 'failed', updated_at = ?
        WHERE id IN (SELECT project_id FROM execution_locks WHERE holder_kind = 'technical_check')`).run(at);
      this.#database.prepare("DELETE FROM execution_locks").run();
    });
    return Object.freeze({ checks, runs });
  }

  reconcileInterruptedConversationTurns(at: string): number {
    this.#assertOpen();
    let turns = 0;
    this.#transaction(() => {
      const conversations = this.#database.prepare(`SELECT DISTINCT conversation_id
        FROM project_conversation_turns WHERE state = 'running'`).all() as Array<{ conversation_id: string }>;
      turns = Number(this.#database.prepare(`UPDATE project_conversation_turns
        SET state = 'failed', failure_code = 'backend_restart', updated_at = ?
        WHERE state = 'running'`).run(at).changes);
      const update = this.#database.prepare(`UPDATE project_conversations
        SET session_state = 'lost', external_session_ref = NULL,
          session_generation = session_generation + 1, updated_at = ? WHERE id = ?`);
      for (const conversation of conversations) update.run(at, conversation.conversation_id);
    });
    return turns;
  }

  /** Test/integration inspection; never expose this handle to browser code. */
  databaseForTesting(): ProjectOnlyDatabase { return this.#database; }

  #transaction<T>(body: () => T): T {
    if ((this.#database as ProjectOnlyDatabase & { isTransaction?: boolean }).isTransaction) {
      const savepoint = `project_only_${++this.#savepointSerial}`;
      this.#database.exec(`SAVEPOINT ${savepoint}`);
      try {
        const value = body();
        this.#database.exec(`RELEASE SAVEPOINT ${savepoint}`);
        return value;
      } catch (error) {
        try {
          this.#database.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          this.#database.exec(`RELEASE SAVEPOINT ${savepoint}`);
        } catch { /* preserve original error */ }
        throw error;
      }
    }
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const value = body();
      this.#database.exec("COMMIT");
      return value;
    } catch (error) {
      try { this.#database.exec("ROLLBACK"); } catch { /* preserve original error */ }
      throw error;
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new ProjectOnlyStoreError("store_closed", "Project-only Store is closed.");
  }
}

const normalizeFiles = (files: readonly ProjectFileInput[]) => {
  const paths = new Set<string>();
  return files.map((file) => {
    assertId(file.id);
    assertRelativePath(file.relativePath);
    if (paths.has(file.relativePath)) throw new ProjectOnlyStoreError("duplicate_project_path", "Project file paths must be unique.");
    paths.add(file.relativePath);
    if (!["project_code", "project_environment", "project_visual_asset"].includes(file.kind)) {
      throw new ProjectOnlyStoreError("invalid_project_file_kind", "Project file kind is invalid.");
    }
    const bytes = Buffer.from(file.bytes);
    return Object.freeze({ ...file, bytes, sha256: createHash("sha256").update(bytes).digest("hex") });
  });
};

const calculateWorkspaceDigest = (
  files: readonly Readonly<{ kind: string; relativePath: string; mediaType: string; sha256: string }>[],
  runMode: ProjectRunMode,
  executionDescription: Record<string, unknown>,
): string => canonicalDigest({
  files: [...files].sort((a, b) => a.relativePath.localeCompare(b.relativePath)).map((file) => ({
    kind: file.kind, relativePath: file.relativePath, mediaType: file.mediaType, sha256: file.sha256,
  })),
  runMode,
  executionDescription,
});

const projectRecord = (row: any): ProjectRecord => Object.freeze({
  id: row.id,
  name: row.name,
  lifecycleState: row.lifecycle_state,
  technicalStatus: row.technical_status,
  runMode: row.run_mode,
  executionDescription: JSON.parse(row.execution_description_json),
  workspaceDigest: row.workspace_digest,
  creationSource: row.creation_source,
  creationSourceRef: row.creation_source_ref,
  executionLock: row.holder_kind === null ? null : Object.freeze({
    holderKind: row.holder_kind,
    holderId: row.holder_id,
    sourceWorkspaceDigest: row.lock_source_workspace_digest,
    acquiredAt: row.acquired_at,
  }),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const fileRecord = (row: any): ProjectFileRecord => Object.freeze({
  id: row.id,
  projectId: row.project_id,
  kind: row.kind,
  relativePath: row.relative_path,
  mediaType: row.media_type,
  bytes: Buffer.from(row.bytes),
  sizeBytes: row.size_bytes,
  sha256: row.sha256,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const runRecord = (row: any): ProjectRunRecord => Object.freeze({
  id: row.id,
  projectId: row.project_id,
  experimentConfigurationId: row.experiment_configuration_id,
  runKind: row.run_kind,
  status: row.status,
  sourceWorkspaceDigest: row.source_workspace_digest,
  frozenConfiguration: JSON.parse(row.frozen_configuration_json),
  sourceFilesRetained: false,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  terminalCode: row.terminal_code,
});

const runOutputRecord = (row: any): ProjectRunOutputRecord => Object.freeze({
  id: row.id,
  runId: row.run_id,
  sampleIndex: row.sample_index,
  sampleId: row.sample_id,
  logicalName: row.logical_name,
  relativePath: row.relative_path,
  mediaType: row.media_type,
  declaredRole: row.declared_role,
  bytes: Buffer.from(row.bytes),
  sizeBytes: row.size_bytes,
  sha256: row.sha256,
  createdAt: row.created_at,
});

const conversationRecord = (row: any): ProjectConversationRecord => Object.freeze({
  id: row.id,
  projectId: row.project_id,
  name: row.name,
  lifecycleState: row.lifecycle_state,
  provider: Object.freeze({
    providerId: row.provider_id,
    modelId: row.model_id,
    locked: row.provider_locked === 1,
  }),
  sessionState: row.session_state,
  sessionGeneration: row.session_generation,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const conversationMessageRecord = (row: any): ProjectConversationMessageRecord => Object.freeze({
  id: row.id,
  conversationId: row.conversation_id,
  ordinal: row.ordinal,
  role: row.role,
  status: row.status,
  messageKind: row.message_kind,
  text: row.text,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const conversationTurnRecord = (row: any): ProjectConversationTurnRecord => Object.freeze({
  id: row.id,
  requestKey: row.request_key,
  conversationId: row.conversation_id,
  state: row.state,
  userMessageId: row.user_message_id,
  assistantMessageId: row.assistant_message_id,
  agentName: row.agent_name,
  actions: Object.freeze(JSON.parse(row.actions_json)),
  goalVerification: row.goal_verification_json ? JSON.parse(row.goal_verification_json) : null,
  failureCode: row.failure_code,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const assertId = (id: string): void => {
  if (!SAFE_ID.test(id)) throw new ProjectOnlyStoreError("invalid_id", "Project-only resource ID is invalid.");
};

const assertRelativePath = (path: string): void => {
  if (typeof path !== "string" || path.length < 1 || path.length > 1024 || path.includes("\0")
    || path.includes("\\") || path.startsWith("/") || path.endsWith("/")
    || path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new ProjectOnlyStoreError("invalid_project_path", "Project file path is invalid.");
  }
};

const stableResourceId = (prefix: string, value: string): string =>
  `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;

const json = (value: unknown): string => JSON.stringify(value);
