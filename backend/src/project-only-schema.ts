import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";

export const PROJECT_ONLY_SCHEMA_VERSION = 5 as const;

export type ProjectOnlyDatabase = DatabaseSync;

const SQL = String.raw;

export const PROJECT_ONLY_SCHEMA_SQL = SQL`
  CREATE TABLE project_only_schema (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    version INTEGER NOT NULL CHECK (version = 5),
    installed_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE projects (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 3 AND 128),
    name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
    lifecycle_state TEXT NOT NULL DEFAULT 'active'
      CHECK (lifecycle_state IN ('active', 'archived', 'trashed')),
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
    kind TEXT NOT NULL CHECK (kind IN (
      'project_code', 'project_environment', 'project_visual_asset', 'project_artifact'
    )),
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

  CREATE TABLE run_outputs (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 3 AND 128),
    run_id TEXT NOT NULL REFERENCES runs(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    sample_index INTEGER NOT NULL CHECK (sample_index >= 0),
    sample_id TEXT NOT NULL CHECK (length(sample_id) = 64 AND sample_id NOT GLOB '*[^0-9a-f]*'),
    logical_name TEXT NOT NULL CHECK (length(trim(logical_name)) BETWEEN 1 AND 200),
    relative_path TEXT NOT NULL CHECK (length(trim(relative_path)) BETWEEN 1 AND 1024),
    media_type TEXT NOT NULL CHECK (length(trim(media_type)) BETWEEN 1 AND 200),
    declared_role TEXT NOT NULL CHECK (declared_role IN (
      'metric', 'table', 'document', 'data', 'diagnostic', 'replay', 'visual'
    )),
    bytes BLOB NOT NULL,
    size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0 AND size_bytes = length(bytes)),
    sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
    created_at TEXT NOT NULL,
    UNIQUE (run_id, sample_index, logical_name)
  ) STRICT;

  CREATE TABLE run_completion_records (
    run_id TEXT PRIMARY KEY REFERENCES runs(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    completion_json TEXT NOT NULL
      CHECK (json_valid(completion_json) AND json_type(completion_json) = 'object'),
    completion_digest TEXT NOT NULL
      CHECK (length(completion_digest) = 64 AND completion_digest NOT GLOB '*[^0-9a-f]*'),
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE execution_locks (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    holder_kind TEXT NOT NULL CHECK (holder_kind = 'run'),
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

  CREATE TABLE project_creation_receipts (
    command_id TEXT PRIMARY KEY CHECK (length(command_id) BETWEEN 3 AND 128),
    intent_digest TEXT NOT NULL
      CHECK (length(intent_digest) = 64 AND intent_digest NOT GLOB '*[^0-9a-f]*'),
    project_id TEXT NOT NULL REFERENCES projects(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    conversation_id TEXT NOT NULL,
    response_json TEXT NOT NULL
      CHECK (json_valid(response_json) AND json_type(response_json) = 'object'),
    receipt_digest TEXT NOT NULL
      CHECK (length(receipt_digest) = 64 AND receipt_digest NOT GLOB '*[^0-9a-f]*'),
    committed_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE project_conversations (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 3 AND 128),
    project_id TEXT NOT NULL REFERENCES projects(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
    lifecycle_state TEXT NOT NULL DEFAULT 'active'
      CHECK (lifecycle_state IN ('active', 'archived', 'trashed')),
    provider_id TEXT NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 200),
    model_id TEXT NOT NULL CHECK (length(model_id) BETWEEN 1 AND 500),
    provider_locked INTEGER NOT NULL DEFAULT 0 CHECK (provider_locked IN (0, 1)),
    session_state TEXT NOT NULL DEFAULT 'none'
      CHECK (session_state IN ('none', 'connecting', 'available', 'lost', 'read_only')),
    session_generation INTEGER NOT NULL DEFAULT 1 CHECK (session_generation >= 1),
    external_session_ref TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (id, project_id)
  ) STRICT;

  CREATE INDEX project_conversations_by_owner
    ON project_conversations(project_id, lifecycle_state, updated_at, id);

  CREATE TABLE project_conversation_messages (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 3 AND 128),
    conversation_id TEXT NOT NULL REFERENCES project_conversations(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
    status TEXT NOT NULL CHECK (status IN ('streaming', 'complete', 'failed')),
    message_kind TEXT NOT NULL DEFAULT 'conversation'
      CHECK (message_kind IN ('conversation', 'platform_card')),
    text TEXT NOT NULL CHECK (length(text) <= 262144),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (conversation_id, ordinal)
  ) STRICT;

  CREATE TABLE project_conversation_turns (
    request_key TEXT PRIMARY KEY CHECK (length(request_key) BETWEEN 3 AND 128),
    id TEXT NOT NULL UNIQUE CHECK (length(id) BETWEEN 3 AND 128),
    conversation_id TEXT NOT NULL REFERENCES project_conversations(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    state TEXT NOT NULL CHECK (state IN ('running', 'complete', 'failed', 'read_only')),
    user_message_id TEXT NOT NULL REFERENCES project_conversation_messages(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    assistant_message_id TEXT REFERENCES project_conversation_messages(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    agent_name TEXT,
    actions_json TEXT NOT NULL DEFAULT '[]'
      CHECK (json_valid(actions_json) AND json_type(actions_json) = 'array'),
    goal_verification_json TEXT
      CHECK (goal_verification_json IS NULL OR (json_valid(goal_verification_json) AND json_type(goal_verification_json) = 'object')),
    failure_code TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE UNIQUE INDEX one_active_turn_per_project_conversation
    ON project_conversation_turns(conversation_id)
    WHERE state = 'running';

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
    if (userVersion === 1 && tables.some(({ name }) => name === "project_only_schema")) {
      migrateProjectOnlySchemaV1ToV2(database, installedAt);
      migrateProjectOnlySchemaV2ToV3(database, installedAt);
      migrateProjectOnlySchemaV3ToV4(database, installedAt);
      migrateProjectOnlySchemaV4ToV5(database, installedAt);
      return;
    }
    if (userVersion === 2 && tables.some(({ name }) => name === "project_only_schema")) {
      migrateProjectOnlySchemaV2ToV3(database, installedAt);
      migrateProjectOnlySchemaV3ToV4(database, installedAt);
      migrateProjectOnlySchemaV4ToV5(database, installedAt);
      return;
    }
    if (userVersion === 3 && tables.some(({ name }) => name === "project_only_schema")) {
      migrateProjectOnlySchemaV3ToV4(database, installedAt);
      migrateProjectOnlySchemaV4ToV5(database, installedAt);
      return;
    }
    if (userVersion === 4 && tables.some(({ name }) => name === "project_only_schema")) {
      migrateProjectOnlySchemaV4ToV5(database, installedAt);
      return;
    }
    throw new Error(`Unsupported Project-only schema state: user_version=${userVersion}`);
  }
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(PROJECT_ONLY_SCHEMA_SQL);
    database.prepare("INSERT INTO project_only_schema (singleton, version, installed_at) VALUES (1, 5, ?)").run(installedAt);
    database.exec(`PRAGMA user_version = ${PROJECT_ONLY_SCHEMA_VERSION}`);
    const foreignKeyViolation = database.prepare("PRAGMA foreign_key_check").get();
    if (foreignKeyViolation) throw new Error("Project-only schema contains a foreign-key violation");
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* preserve initialization error */ }
    throw error;
  }
};

const PROJECT_ONLY_V4_PROJECT_FILES_SQL = SQL`
  CREATE TABLE project_files (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 3 AND 128),
    project_id TEXT NOT NULL REFERENCES projects(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    kind TEXT NOT NULL CHECK (kind IN (
      'project_code', 'project_environment', 'project_visual_asset', 'project_artifact'
    )),
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
`;

const PROJECT_ONLY_V4_EXECUTION_LOCKS_SQL = SQL`
  CREATE TABLE execution_locks (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    holder_kind TEXT NOT NULL CHECK (holder_kind = 'run'),
    holder_id TEXT NOT NULL,
    source_workspace_digest TEXT NOT NULL,
    acquired_at TEXT NOT NULL
  ) STRICT;
  CREATE UNIQUE INDEX execution_lock_holder ON execution_locks(holder_kind, holder_id);
`;

const PROJECT_ONLY_V4_FILE_TRIGGERS_SQL = PROJECT_ONLY_SCHEMA_SQL.slice(
  PROJECT_ONLY_SCHEMA_SQL.indexOf("CREATE TRIGGER project_files_blocked_by_execution_lock_insert"),
);

const PROJECT_ONLY_V5_RUN_OUTPUTS_SQL = SQL`
  CREATE TABLE run_outputs (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 3 AND 128),
    run_id TEXT NOT NULL REFERENCES runs(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    sample_index INTEGER NOT NULL CHECK (sample_index >= 0),
    sample_id TEXT NOT NULL CHECK (length(sample_id) = 64 AND sample_id NOT GLOB '*[^0-9a-f]*'),
    logical_name TEXT NOT NULL CHECK (length(trim(logical_name)) BETWEEN 1 AND 200),
    relative_path TEXT NOT NULL CHECK (length(trim(relative_path)) BETWEEN 1 AND 1024),
    media_type TEXT NOT NULL CHECK (length(trim(media_type)) BETWEEN 1 AND 200),
    declared_role TEXT NOT NULL CHECK (declared_role IN (
      'metric', 'table', 'document', 'data', 'diagnostic', 'replay', 'visual'
    )),
    bytes BLOB NOT NULL,
    size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0 AND size_bytes = length(bytes)),
    sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
    created_at TEXT NOT NULL,
    UNIQUE (run_id, sample_index, logical_name)
  ) STRICT;
`;

const migrateProjectOnlySchemaV4ToV5 = (
  database: ProjectOnlyDatabase,
  installedAt: string,
): void => {
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec("ALTER TABLE run_outputs RENAME TO run_outputs_v4");
    database.exec(PROJECT_ONLY_V5_RUN_OUTPUTS_SQL);
    database.exec(`INSERT INTO run_outputs
      (id, run_id, sample_index, sample_id, logical_name, relative_path, media_type,
        declared_role, bytes, size_bytes, sha256, created_at)
      SELECT id, run_id, sample_index, sample_id, logical_name, relative_path, media_type,
        declared_role, bytes, size_bytes, sha256, created_at
      FROM run_outputs_v4`);
    database.exec("DROP TABLE run_outputs_v4");
    database.exec("ALTER TABLE project_only_schema RENAME TO project_only_schema_v4");
    database.exec(`CREATE TABLE project_only_schema (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      version INTEGER NOT NULL CHECK (version = 5),
      installed_at TEXT NOT NULL
    ) STRICT`);
    database.prepare("INSERT INTO project_only_schema (singleton, version, installed_at) VALUES (1, 5, ?)")
      .run(installedAt);
    database.exec("DROP TABLE project_only_schema_v4");
    database.exec(`PRAGMA user_version = ${PROJECT_ONLY_SCHEMA_VERSION}`);
    const foreignKeyViolation = database.prepare("PRAGMA foreign_key_check").get();
    if (foreignKeyViolation) throw new Error("Project-only schema migration contains a foreign-key violation");
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* preserve migration error */ }
    throw error;
  }
};

const migrateProjectOnlySchemaV3ToV4 = (
  database: ProjectOnlyDatabase,
  installedAt: string,
): void => {
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(`
      DROP TRIGGER project_files_blocked_by_execution_lock_insert;
      DROP TRIGGER project_files_blocked_by_execution_lock_update;
      DROP TRIGGER project_files_blocked_by_execution_lock_delete;
      DROP TRIGGER project_execution_description_blocked_by_lock;
      DROP TRIGGER project_file_digest_verified_insert;
      DROP TRIGGER project_file_digest_verified_update;
      DELETE FROM execution_locks WHERE holder_kind = 'technical_check';
      DROP TABLE project_technical_checks;
      ALTER TABLE projects DROP COLUMN technical_status;
      ALTER TABLE project_files RENAME TO project_files_v3;
    `);
    database.exec(PROJECT_ONLY_V4_PROJECT_FILES_SQL);
    database.exec(`INSERT INTO project_files
      (id, project_id, kind, relative_path, media_type, bytes, size_bytes, sha256, created_at, updated_at)
      SELECT id, project_id, kind, relative_path, media_type, bytes, size_bytes, sha256, created_at, updated_at
      FROM project_files_v3`);
    database.exec(`
      DROP TABLE project_files_v3;
      DROP INDEX execution_lock_holder;
      ALTER TABLE execution_locks RENAME TO execution_locks_v3;
    `);
    database.exec(PROJECT_ONLY_V4_EXECUTION_LOCKS_SQL);
    database.exec(`INSERT INTO execution_locks
      (project_id, holder_kind, holder_id, source_workspace_digest, acquired_at)
      SELECT project_id, holder_kind, holder_id, source_workspace_digest, acquired_at
      FROM execution_locks_v3 WHERE holder_kind = 'run'`);
    database.exec("DROP TABLE execution_locks_v3");
    database.exec(PROJECT_ONLY_V4_FILE_TRIGGERS_SQL);
    database.exec("ALTER TABLE project_only_schema RENAME TO project_only_schema_v3");
    database.exec(`CREATE TABLE project_only_schema (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      version INTEGER NOT NULL CHECK (version = 4),
      installed_at TEXT NOT NULL
    ) STRICT`);
    database.prepare("INSERT INTO project_only_schema (singleton, version, installed_at) VALUES (1, 4, ?)")
      .run(installedAt);
    database.exec("DROP TABLE project_only_schema_v3");
    database.exec("PRAGMA user_version = 4");
    const foreignKeyViolation = database.prepare("PRAGMA foreign_key_check").get();
    if (foreignKeyViolation) throw new Error("Project-only schema migration contains a foreign-key violation");
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* preserve migration error */ }
    throw error;
  }
};

const PROJECT_ONLY_SCHEMA_V3_ADDITIONS_SQL = PROJECT_ONLY_SCHEMA_SQL.slice(
  PROJECT_ONLY_SCHEMA_SQL.indexOf("CREATE TABLE run_outputs"),
  PROJECT_ONLY_SCHEMA_SQL.indexOf("CREATE TABLE execution_locks"),
);

const migrateProjectOnlySchemaV2ToV3 = (
  database: ProjectOnlyDatabase,
  installedAt: string,
): void => {
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(PROJECT_ONLY_SCHEMA_V3_ADDITIONS_SQL);
    database.exec("ALTER TABLE project_only_schema RENAME TO project_only_schema_v2");
    database.exec(`CREATE TABLE project_only_schema (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      version INTEGER NOT NULL CHECK (version = 3),
      installed_at TEXT NOT NULL
    ) STRICT`);
    database.prepare("INSERT INTO project_only_schema (singleton, version, installed_at) VALUES (1, 3, ?)")
      .run(installedAt);
    database.exec("DROP TABLE project_only_schema_v2");
    database.exec("PRAGMA user_version = 3");
    const foreignKeyViolation = database.prepare("PRAGMA foreign_key_check").get();
    if (foreignKeyViolation) throw new Error("Project-only schema migration contains a foreign-key violation");
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* preserve migration error */ }
    throw error;
  }
};

const PROJECT_ONLY_SCHEMA_V2_ADDITIONS_SQL = PROJECT_ONLY_SCHEMA_SQL.slice(
  PROJECT_ONLY_SCHEMA_SQL.indexOf("CREATE TABLE project_creation_receipts"),
  PROJECT_ONLY_SCHEMA_SQL.indexOf("CREATE TRIGGER project_files_blocked_by_execution_lock_insert"),
);

const migrateProjectOnlySchemaV1ToV2 = (
  database: ProjectOnlyDatabase,
  installedAt: string,
): void => {
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(PROJECT_ONLY_SCHEMA_V2_ADDITIONS_SQL);
    database.exec("ALTER TABLE project_only_schema RENAME TO project_only_schema_v1");
    database.exec(`CREATE TABLE project_only_schema (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      version INTEGER NOT NULL CHECK (version = 2),
      installed_at TEXT NOT NULL
    ) STRICT`);
    database.prepare("INSERT INTO project_only_schema (singleton, version, installed_at) VALUES (1, 2, ?)")
      .run(installedAt);
    database.exec("DROP TABLE project_only_schema_v1");
    database.exec("PRAGMA user_version = 2");
    const foreignKeyViolation = database.prepare("PRAGMA foreign_key_check").get();
    if (foreignKeyViolation) throw new Error("Project-only schema migration contains a foreign-key violation");
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* preserve migration error */ }
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
