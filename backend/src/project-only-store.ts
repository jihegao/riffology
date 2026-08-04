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
    if (input.source.kind === "blank") {
      files = normalizeFiles([{
        id: `${input.id}_scaffold`,
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
      const row = this.#database.prepare(`SELECT run_mode, execution_description_json, files_json, content_digest
        FROM project_templates WHERE id = ? AND version = ?`).get(input.source.templateId, input.source.version) as any;
      if (!row) throw new ProjectOnlyStoreError("template_not_found", "Project template version does not exist.");
      runMode = row.run_mode;
      executionDescription = JSON.parse(row.execution_description_json);
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
    });
    return this.project(input.id);
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

  updateExperiment(input: Readonly<{ id: string; projectId: string; configuration: Record<string, unknown>; updatedAt: string }>): void {
    this.#assertOpen();
    const result = this.#database.prepare(`UPDATE experiment_configurations SET configuration_json = ?, updated_at = ?
      WHERE id = ? AND project_id = ?`).run(json(input.configuration), input.updatedAt, input.id, input.projectId);
    if (result.changes !== 1) throw new ProjectOnlyStoreError("experiment_not_found", "Experiment does not exist.");
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
      this.#database.prepare(`UPDATE project_technical_checks SET status = ?, diagnostics_json = ?, finished_at = ? WHERE id = ?`)
        .run(input.succeeded ? "succeeded" : "failed", json(input.diagnostics), input.finishedAt, input.id);
      this.#database.prepare("DELETE FROM execution_locks WHERE project_id = ? AND holder_kind = 'technical_check' AND holder_id = ?")
        .run(projectId, input.id);
      this.#database.prepare("UPDATE projects SET technical_status = ?, updated_at = ? WHERE id = ?")
        .run(input.succeeded ? "executable" : "failed", input.finishedAt, projectId);
    });
    return this.project(projectId);
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

  /** Test/integration inspection; never expose this handle to browser code. */
  databaseForTesting(): ProjectOnlyDatabase { return this.#database; }

  #transaction<T>(body: () => T): T {
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

const json = (value: unknown): string => JSON.stringify(value);
