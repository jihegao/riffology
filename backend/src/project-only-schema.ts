import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";

export const PROJECT_ONLY_SCHEMA_VERSION = 1 as const;

export type ProjectOnlyDatabase = DatabaseSync;

const SQL = String.raw;

export const PROJECT_ONLY_SCHEMA_SQL = SQL`
  CREATE TABLE project_only_schema (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    version INTEGER NOT NULL CHECK (version = 1),
    installed_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE projects (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 3 AND 128),
    name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
    lifecycle_state TEXT NOT NULL DEFAULT 'active'
      CHECK (lifecycle_state IN ('active', 'archived', 'trashed')),
    technical_status TEXT NOT NULL DEFAULT 'draft'
      CHECK (technical_status IN ('draft', 'checking', 'executable', 'failed')),
    run_mode TEXT NOT NULL CHECK (run_mode IN ('visual', 'batch', 'both')),
    execution_description_json TEXT NOT NULL
      CHECK (json_valid(execution_description_json) AND json_type(execution_description_json) = 'object'),
    workspace_digest TEXT NOT NULL
      CHECK (length(workspace_digest) = 64 AND workspace_digest NOT GLOB '*[^0-9a-f]*'),
    creation_source TEXT NOT NULL CHECK (creation_source IN ('blank', 'template', 'import')),
    creation_source_ref TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE project_files (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 3 AND 128),
    project_id TEXT NOT NULL REFERENCES projects(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    kind TEXT NOT NULL CHECK (kind IN ('project_code', 'project_environment', 'project_visual_asset')),
    relative_path TEXT NOT NULL CHECK (
      length(relative_path) BETWEEN 1 AND 1024
      AND substr(relative_path, 1, 1) != '/'
      AND instr(relative_path, char(92)) = 0
      AND instr(relative_path, char(0)) = 0
      AND instr('/' || relative_path || '/', '/../') = 0
      AND instr('/' || relative_path || '/', '/./') = 0
      AND instr(relative_path, '//') = 0
      AND substr(relative_path, -1, 1) != '/'
    ),
    media_type TEXT NOT NULL CHECK (length(trim(media_type)) BETWEEN 1 AND 200),
    bytes BLOB NOT NULL,
    size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0 AND size_bytes = length(bytes)),
    sha256 TEXT NOT NULL
      CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (project_id, relative_path)
  ) STRICT;

  CREATE TABLE project_templates (
    id TEXT NOT NULL CHECK (length(id) BETWEEN 3 AND 128),
    version TEXT NOT NULL CHECK (length(version) BETWEEN 1 AND 64),
    description TEXT NOT NULL,
    run_mode TEXT NOT NULL CHECK (run_mode IN ('visual', 'batch', 'both')),
    execution_description_json TEXT NOT NULL
      CHECK (json_valid(execution_description_json) AND json_type(execution_description_json) = 'object'),
    default_experiment_json TEXT NOT NULL
      CHECK (json_valid(default_experiment_json) AND json_type(default_experiment_json) = 'object'),
    files_json TEXT NOT NULL
      CHECK (json_valid(files_json) AND json_type(files_json) = 'array'),
    content_digest TEXT NOT NULL
      CHECK (length(content_digest) = 64 AND content_digest NOT GLOB '*[^0-9a-f]*'),
    created_at TEXT NOT NULL,
    PRIMARY KEY (id, version)
  ) WITHOUT ROWID, STRICT;

  CREATE TABLE project_technical_checks (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 3 AND 128),
    project_id TEXT NOT NULL REFERENCES projects(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    captured_workspace_digest TEXT NOT NULL,
    captured_file_digest TEXT,
    execution_description_digest TEXT,
    status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'interrupted')),
    diagnostics_json TEXT NOT NULL DEFAULT '[]'
      CHECK (json_valid(diagnostics_json) AND json_type(diagnostics_json) = 'array'),
    started_at TEXT NOT NULL,
    finished_at TEXT
  ) STRICT;

  CREATE TABLE experiment_configurations (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 3 AND 128),
    project_id TEXT NOT NULL REFERENCES projects(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
    configuration_json TEXT NOT NULL
      CHECK (json_valid(configuration_json) AND json_type(configuration_json) = 'object'),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (id, project_id)
  ) STRICT;

  CREATE TABLE runs (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 3 AND 128),
    project_id TEXT NOT NULL REFERENCES projects(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    experiment_configuration_id TEXT NOT NULL,
    run_kind TEXT NOT NULL CHECK (run_kind IN ('batch', 'visual')),
    status TEXT NOT NULL CHECK (status IN (
      'queued', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted'
    )),
    source_workspace_digest TEXT NOT NULL,
    frozen_configuration_json TEXT NOT NULL
      CHECK (json_valid(frozen_configuration_json) AND json_type(frozen_configuration_json) = 'object'),
    execution_description_json TEXT NOT NULL
      CHECK (json_valid(execution_description_json) AND json_type(execution_description_json) = 'object'),
    source_files_retained INTEGER NOT NULL DEFAULT 0 CHECK (source_files_retained = 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    terminal_code TEXT,
    FOREIGN KEY (experiment_configuration_id, project_id)
      REFERENCES experiment_configurations(id, project_id) ON UPDATE RESTRICT ON DELETE RESTRICT
  ) STRICT;

  CREATE UNIQUE INDEX one_active_run_per_project
    ON runs(project_id)
    WHERE status IN ('queued', 'running', 'cancelling');

  CREATE TABLE execution_locks (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    holder_kind TEXT NOT NULL CHECK (holder_kind IN ('technical_check', 'run')),
    holder_id TEXT NOT NULL,
    source_workspace_digest TEXT NOT NULL,
    acquired_at TEXT NOT NULL
  ) STRICT;

  CREATE UNIQUE INDEX execution_lock_holder ON execution_locks(holder_kind, holder_id);

  CREATE TABLE project_delivery_receipts (
    command_id TEXT PRIMARY KEY CHECK (length(command_id) BETWEEN 3 AND 128),
    project_id TEXT NOT NULL REFERENCES projects(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    intent_digest TEXT NOT NULL
      CHECK (length(intent_digest) = 64 AND intent_digest NOT GLOB '*[^0-9a-f]*'),
    response_json TEXT NOT NULL
      CHECK (json_valid(response_json) AND json_type(response_json) = 'object'),
    receipt_digest TEXT NOT NULL
      CHECK (length(receipt_digest) = 64 AND receipt_digest NOT GLOB '*[^0-9a-f]*'),
    committed_at TEXT NOT NULL
  ) STRICT;

  CREATE TRIGGER project_files_blocked_by_execution_lock_insert
  BEFORE INSERT ON project_files
  WHEN EXISTS (SELECT 1 FROM execution_locks WHERE project_id = NEW.project_id)
  BEGIN SELECT RAISE(ABORT, 'project_execution_locked'); END;

  CREATE TRIGGER project_files_blocked_by_execution_lock_update
  BEFORE UPDATE ON project_files
  WHEN EXISTS (SELECT 1 FROM execution_locks WHERE project_id = NEW.project_id)
  BEGIN SELECT RAISE(ABORT, 'project_execution_locked'); END;

  CREATE TRIGGER project_files_blocked_by_execution_lock_delete
  BEFORE DELETE ON project_files
  WHEN EXISTS (SELECT 1 FROM execution_locks WHERE project_id = OLD.project_id)
  BEGIN SELECT RAISE(ABORT, 'project_execution_locked'); END;

  CREATE TRIGGER project_execution_description_blocked_by_lock
  BEFORE UPDATE OF execution_description_json, run_mode ON projects
  WHEN EXISTS (SELECT 1 FROM execution_locks WHERE project_id = OLD.id)
  BEGIN SELECT RAISE(ABORT, 'project_execution_locked'); END;

  CREATE TRIGGER project_file_digest_verified_insert
  BEFORE INSERT ON project_files
  WHEN riff_sha256(NEW.bytes) != NEW.sha256
  BEGIN SELECT RAISE(ABORT, 'project_file_digest_mismatch'); END;

  CREATE TRIGGER project_file_digest_verified_update
  BEFORE UPDATE OF bytes, sha256, size_bytes ON project_files
  WHEN riff_sha256(NEW.bytes) != NEW.sha256
  BEGIN SELECT RAISE(ABORT, 'project_file_digest_mismatch'); END;
`;

export const configureProjectOnlyDatabase = (database: ProjectOnlyDatabase): void => {
  database.function("riff_sha256", { deterministic: true }, (value: Uint8Array) =>
    createHash("sha256").update(value).digest("hex"));
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = 5000;
  `);
};

export const initializeProjectOnlySchema = (
  database: ProjectOnlyDatabase,
  installedAt = new Date().toISOString(),
): void => {
  configureProjectOnlyDatabase(database);
  const userVersion = (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>;
  if (tables.some(({ name }) => name === "models")) throw new ProjectOnlyRecoveryRequiredError();
  if (userVersion !== 0 || tables.length !== 0) {
    if (userVersion === PROJECT_ONLY_SCHEMA_VERSION && tables.some(({ name }) => name === "project_only_schema")) return;
    throw new Error(`Unsupported Project-only schema state: user_version=${userVersion}`);
  }
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(PROJECT_ONLY_SCHEMA_SQL);
    database.prepare("INSERT INTO project_only_schema (singleton, version, installed_at) VALUES (1, 1, ?)").run(installedAt);
    database.exec(`PRAGMA user_version = ${PROJECT_ONLY_SCHEMA_VERSION}`);
    const foreignKeyViolation = database.prepare("PRAGMA foreign_key_check").get();
    if (foreignKeyViolation) throw new Error("Project-only schema contains a foreign-key violation");
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* preserve initialization error */ }
    throw error;
  }
};

export class ProjectOnlyRecoveryRequiredError extends Error {
  readonly code = "legacy_store_recovery_required" as const;
  constructor() {
    super("Legacy Model/Project storage is recovery-only. Export and verify it before Project-only cutover.");
    this.name = "ProjectOnlyRecoveryRequiredError";
  }
}

export const openProjectOnlyDatabase = (path: string): ProjectOnlyDatabase => {
  const database = new DatabaseSync(path);
  try {
    initializeProjectOnlySchema(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
};
