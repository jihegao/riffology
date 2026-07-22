import { DatabaseSync } from "node:sqlite";
import { PRODUCT_SCHEMA_VERSION } from "./product-domain.ts";

const SQL = String.raw;

export type ProductDatabase = DatabaseSync;

export const PRODUCT_DATABASE_PRAGMAS = Object.freeze({
  foreignKeys: true,
  journalMode: "WAL",
  synchronous: "FULL",
  busyTimeoutMs: 5_000,
} as const);

export const configureProductDatabase = (database: ProductDatabase): void => {
  database.exec(SQL`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = ${PRODUCT_DATABASE_PRAGMAS.busyTimeoutMs};
  `);
};

export const initializeProductSchema = (database: ProductDatabase): void => {
  configureProductDatabase(database);
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(PRODUCT_SCHEMA_SQL);
    const version = database.prepare("SELECT version FROM product_schema WHERE singleton = 1").get() as { version: number } | undefined;
    if (!version || version.version !== PRODUCT_SCHEMA_VERSION) {
      throw new Error(`Unsupported product schema version: ${String(version?.version ?? "missing")}`);
    }
    database.exec(`PRAGMA user_version = ${PRODUCT_SCHEMA_VERSION}`);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* preserve the initialization error */ }
    throw error;
  }
};

export const openProductDatabase = (path: string): ProductDatabase => {
  const database = new DatabaseSync(path);
  try {
    initializeProductSchema(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
};

export const PRODUCT_SCHEMA_SQL = SQL`
  CREATE TABLE IF NOT EXISTS product_schema (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    version INTEGER NOT NULL CHECK (version >= 1),
    installed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ) STRICT;
  INSERT INTO product_schema (singleton, version) VALUES (1, ${PRODUCT_SCHEMA_VERSION})
    ON CONFLICT(singleton) DO NOTHING;

  CREATE TABLE IF NOT EXISTS models (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 3 AND 128),
    name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
    lifecycle_state TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle_state IN ('active', 'archived', 'trashed')),
    pre_trash_state TEXT CHECK (pre_trash_state IN ('active', 'archived')),
    technical_status TEXT NOT NULL DEFAULT 'draft' CHECK (technical_status IN ('draft', 'checking', 'executable', 'failed')),
    run_mode TEXT NOT NULL CHECK (run_mode IN ('visual', 'batch', 'both')),
    execution_description_json TEXT NOT NULL CHECK (json_valid(execution_description_json) AND json_type(execution_description_json) = 'object'),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT,
    trashed_at TEXT,
    CHECK ((lifecycle_state = 'active' AND archived_at IS NULL AND trashed_at IS NULL AND pre_trash_state IS NULL)
      OR (lifecycle_state = 'archived' AND archived_at IS NOT NULL AND trashed_at IS NULL AND pre_trash_state IS NULL)
      OR (lifecycle_state = 'trashed' AND trashed_at IS NOT NULL AND pre_trash_state IS NOT NULL))
  ) STRICT;

  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 3 AND 128),
    name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
    lifecycle_state TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle_state IN ('active', 'archived', 'trashed')),
    pre_trash_state TEXT CHECK (pre_trash_state IN ('active', 'archived')),
    source_model_id TEXT NOT NULL REFERENCES models(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    model_snapshot_digest TEXT NOT NULL CHECK (length(model_snapshot_digest) = 64 AND model_snapshot_digest NOT GLOB '*[^0-9a-f]*'),
    execution_description_json TEXT NOT NULL CHECK (json_valid(execution_description_json) AND json_type(execution_description_json) = 'object'),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT,
    trashed_at TEXT,
    CHECK ((lifecycle_state = 'active' AND archived_at IS NULL AND trashed_at IS NULL AND pre_trash_state IS NULL)
      OR (lifecycle_state = 'archived' AND archived_at IS NOT NULL AND trashed_at IS NULL AND pre_trash_state IS NULL)
      OR (lifecycle_state = 'trashed' AND trashed_at IS NOT NULL AND pre_trash_state IS NOT NULL))
  ) STRICT;

  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 3 AND 128),
    model_id TEXT REFERENCES models(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    project_id TEXT REFERENCES projects(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
    lifecycle_state TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle_state IN ('active', 'archived', 'trashed')),
    pre_trash_state TEXT CHECK (pre_trash_state IN ('active', 'archived')),
    provider_id TEXT NOT NULL CHECK (length(trim(provider_id)) BETWEEN 1 AND 200),
    provider_model_id TEXT NOT NULL CHECK (length(trim(provider_model_id)) BETWEEN 1 AND 300),
    provider_locked_at TEXT,
    external_session_ref TEXT,
    rolling_summary TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT,
    trashed_at TEXT,
    CHECK ((model_id IS NOT NULL) != (project_id IS NOT NULL)),
    CHECK ((lifecycle_state = 'active' AND archived_at IS NULL AND trashed_at IS NULL AND pre_trash_state IS NULL)
      OR (lifecycle_state = 'archived' AND archived_at IS NOT NULL AND trashed_at IS NULL AND pre_trash_state IS NULL)
      OR (lifecycle_state = 'trashed' AND trashed_at IS NOT NULL AND pre_trash_state IS NOT NULL))
  ) STRICT;

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 3 AND 128),
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
    status TEXT NOT NULL CHECK (status IN ('streaming', 'complete', 'failed')),
    text TEXT NOT NULL,
    content_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(content_json)),
    action_json TEXT CHECK (action_json IS NULL OR json_valid(action_json)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (conversation_id, ordinal)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS temporary_documents (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 3 AND 128),
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    source_message_id TEXT REFERENCES messages(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
    document_state TEXT NOT NULL CHECK (document_state IN ('draft', 'adopted', 'rejected', 'superseded')),
    media_type TEXT NOT NULL CHECK (length(trim(media_type)) BETWEEN 1 AND 200),
    content TEXT NOT NULL,
    lifecycle_state TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle_state IN ('active', 'archived', 'trashed')),
    pre_trash_state TEXT CHECK (pre_trash_state IN ('active', 'archived')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT,
    trashed_at TEXT,
    CHECK ((lifecycle_state = 'active' AND archived_at IS NULL AND trashed_at IS NULL AND pre_trash_state IS NULL)
      OR (lifecycle_state = 'archived' AND archived_at IS NOT NULL AND trashed_at IS NULL AND pre_trash_state IS NULL)
      OR (lifecycle_state = 'trashed' AND trashed_at IS NOT NULL AND pre_trash_state IS NOT NULL))
  ) STRICT;

  CREATE TABLE IF NOT EXISTS experiment_configurations (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 3 AND 128),
    project_id TEXT NOT NULL REFERENCES projects(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
    configuration_json TEXT NOT NULL CHECK (json_valid(configuration_json) AND json_type(configuration_json) = 'object'),
    estimated_sample_count INTEGER NOT NULL CHECK (estimated_sample_count >= 1),
    lifecycle_state TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle_state IN ('active', 'archived', 'trashed')),
    pre_trash_state TEXT CHECK (pre_trash_state IN ('active', 'archived')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT,
    trashed_at TEXT,
    UNIQUE (id, project_id),
    CHECK ((lifecycle_state = 'active' AND archived_at IS NULL AND trashed_at IS NULL AND pre_trash_state IS NULL)
      OR (lifecycle_state = 'archived' AND archived_at IS NOT NULL AND trashed_at IS NULL AND pre_trash_state IS NULL)
      OR (lifecycle_state = 'trashed' AND trashed_at IS NOT NULL AND pre_trash_state IS NOT NULL))
  ) STRICT;

  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 3 AND 128),
    project_id TEXT NOT NULL REFERENCES projects(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    experiment_configuration_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('configured', 'queued', 'running', 'succeeded', 'failed', 'cancelled', 'timed_out', 'trashed')),
    pre_trash_status TEXT CHECK (pre_trash_status IN ('configured', 'queued', 'running', 'succeeded', 'failed', 'cancelled', 'timed_out')),
    frozen_configuration_json TEXT NOT NULL CHECK (json_valid(frozen_configuration_json) AND json_type(frozen_configuration_json) = 'object'),
    requested_sample_count INTEGER NOT NULL CHECK (requested_sample_count >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    trashed_at TEXT,
    UNIQUE (id, project_id),
    FOREIGN KEY (experiment_configuration_id, project_id)
      REFERENCES experiment_configurations(id, project_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CHECK ((status = 'trashed' AND trashed_at IS NOT NULL AND pre_trash_status IS NOT NULL)
      OR (status != 'trashed' AND trashed_at IS NULL AND pre_trash_status IS NULL))
  ) STRICT;

  CREATE TABLE IF NOT EXISTS object_files (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 3 AND 128),
    owner_model_id TEXT REFERENCES models(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    owner_project_id TEXT REFERENCES projects(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    owner_conversation_id TEXT REFERENCES conversations(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    owner_run_id TEXT REFERENCES runs(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    kind TEXT NOT NULL CHECK (kind IN ('model_code', 'model_environment', 'model_visual_asset', 'conversation_attachment', 'adopted_attachment', 'project_model_snapshot', 'run_file')),
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
    size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
    sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
    source_attachment_id TEXT REFERENCES attachments(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    created_at TEXT NOT NULL,
    CHECK ((owner_model_id IS NOT NULL) + (owner_project_id IS NOT NULL) + (owner_conversation_id IS NOT NULL) + (owner_run_id IS NOT NULL) = 1),
    CHECK ((kind IN ('model_code', 'model_environment', 'model_visual_asset') AND owner_model_id IS NOT NULL)
      OR (kind = 'conversation_attachment' AND owner_conversation_id IS NOT NULL)
      OR (kind IN ('adopted_attachment', 'project_model_snapshot') AND (owner_model_id IS NOT NULL OR owner_project_id IS NOT NULL))
      OR (kind = 'run_file' AND owner_run_id IS NOT NULL)),
    CHECK ((source_attachment_id IS NULL) OR kind = 'adopted_attachment')
  ) STRICT;

  CREATE UNIQUE INDEX IF NOT EXISTS object_files_model_path ON object_files(owner_model_id, relative_path) WHERE owner_model_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS object_files_project_path ON object_files(owner_project_id, relative_path) WHERE owner_project_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS object_files_conversation_path ON object_files(owner_conversation_id, relative_path) WHERE owner_conversation_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS object_files_run_path ON object_files(owner_run_id, relative_path) WHERE owner_run_id IS NOT NULL;

  CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 3 AND 128),
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    object_file_id TEXT NOT NULL UNIQUE REFERENCES object_files(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    original_name TEXT NOT NULL CHECK (length(trim(original_name)) BETWEEN 1 AND 500),
    purpose TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (id, conversation_id)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS message_attachments (
    message_id TEXT NOT NULL REFERENCES messages(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    attachment_id TEXT NOT NULL REFERENCES attachments(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    PRIMARY KEY (message_id, attachment_id)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS output_indexes (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 3 AND 128),
    run_id TEXT NOT NULL REFERENCES runs(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    object_file_id TEXT NOT NULL UNIQUE REFERENCES object_files(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    logical_name TEXT NOT NULL CHECK (length(trim(logical_name)) BETWEEN 1 AND 500),
    output_type TEXT NOT NULL CHECK (length(trim(output_type)) BETWEEN 1 AND 200),
    created_at TEXT NOT NULL,
    UNIQUE (run_id, logical_name)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS trash_entries (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 3 AND 128),
    model_id TEXT REFERENCES models(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    project_id TEXT REFERENCES projects(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    conversation_id TEXT REFERENCES conversations(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    temporary_document_id TEXT REFERENCES temporary_documents(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    experiment_configuration_id TEXT REFERENCES experiment_configurations(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    run_id TEXT REFERENCES runs(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    prior_state TEXT NOT NULL,
    trashed_at TEXT NOT NULL,
    restored_at TEXT,
    CHECK ((model_id IS NOT NULL) + (project_id IS NOT NULL) + (conversation_id IS NOT NULL)
      + (temporary_document_id IS NOT NULL) + (experiment_configuration_id IS NOT NULL) + (run_id IS NOT NULL) = 1)
  ) STRICT;
  CREATE UNIQUE INDEX IF NOT EXISTS active_trash_model ON trash_entries(model_id) WHERE model_id IS NOT NULL AND restored_at IS NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS active_trash_project ON trash_entries(project_id) WHERE project_id IS NOT NULL AND restored_at IS NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS active_trash_conversation ON trash_entries(conversation_id) WHERE conversation_id IS NOT NULL AND restored_at IS NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS active_trash_document ON trash_entries(temporary_document_id) WHERE temporary_document_id IS NOT NULL AND restored_at IS NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS active_trash_experiment ON trash_entries(experiment_configuration_id) WHERE experiment_configuration_id IS NOT NULL AND restored_at IS NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS active_trash_run ON trash_entries(run_id) WHERE run_id IS NOT NULL AND restored_at IS NULL;

  CREATE TABLE IF NOT EXISTS committed_mutations (
    transaction_id TEXT PRIMARY KEY CHECK (length(transaction_id) BETWEEN 8 AND 128),
    manifest_sha256 TEXT NOT NULL CHECK (length(manifest_sha256) = 64 AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'),
    committed_at TEXT NOT NULL
  ) STRICT;

  CREATE TRIGGER IF NOT EXISTS attachment_file_owner_insert
  BEFORE INSERT ON attachments
  BEGIN
    SELECT CASE WHEN NOT EXISTS (
      SELECT 1 FROM object_files
      WHERE id = NEW.object_file_id AND owner_conversation_id = NEW.conversation_id AND kind = 'conversation_attachment'
    ) THEN RAISE(ABORT, 'attachment object ownership mismatch') END;
  END;

  CREATE TRIGGER IF NOT EXISTS attachment_file_owner_update
  BEFORE UPDATE OF conversation_id, object_file_id ON attachments
  BEGIN
    SELECT CASE WHEN NOT EXISTS (
      SELECT 1 FROM object_files
      WHERE id = NEW.object_file_id AND owner_conversation_id = NEW.conversation_id AND kind = 'conversation_attachment'
    ) THEN RAISE(ABORT, 'attachment object ownership mismatch') END;
  END;

  CREATE TRIGGER IF NOT EXISTS message_attachment_owner_insert
  BEFORE INSERT ON message_attachments
  BEGIN
    SELECT CASE WHEN NOT EXISTS (
      SELECT 1 FROM messages m JOIN attachments a ON a.conversation_id = m.conversation_id
      WHERE m.id = NEW.message_id AND a.id = NEW.attachment_id
    ) THEN RAISE(ABORT, 'message attachment conversation mismatch') END;
  END;

  CREATE TRIGGER IF NOT EXISTS temporary_document_message_owner_insert
  BEFORE INSERT ON temporary_documents WHEN NEW.source_message_id IS NOT NULL
  BEGIN
    SELECT CASE WHEN NOT EXISTS (
      SELECT 1 FROM messages WHERE id = NEW.source_message_id AND conversation_id = NEW.conversation_id
    ) THEN RAISE(ABORT, 'document source message conversation mismatch') END;
  END;

  CREATE TRIGGER IF NOT EXISTS output_file_owner_insert
  BEFORE INSERT ON output_indexes
  BEGIN
    SELECT CASE WHEN NOT EXISTS (
      SELECT 1 FROM object_files WHERE id = NEW.object_file_id AND owner_run_id = NEW.run_id AND kind = 'run_file'
    ) THEN RAISE(ABORT, 'output object ownership mismatch') END;
  END;

  CREATE TRIGGER IF NOT EXISTS project_source_immutable
  BEFORE UPDATE OF source_model_id ON projects
  BEGIN
    SELECT RAISE(ABORT, 'project source model is immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS conversation_owner_immutable
  BEFORE UPDATE OF model_id, project_id ON conversations
  BEGIN
    SELECT RAISE(ABORT, 'conversation owner is immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS message_conversation_immutable
  BEFORE UPDATE OF conversation_id ON messages
  BEGIN
    SELECT RAISE(ABORT, 'message conversation is immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS message_attachment_binding_immutable
  BEFORE UPDATE ON message_attachments
  BEGIN
    SELECT RAISE(ABORT, 'message attachment binding is immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS document_binding_immutable
  BEFORE UPDATE OF conversation_id, source_message_id ON temporary_documents
  BEGIN
    SELECT RAISE(ABORT, 'document conversation binding is immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS attachment_binding_immutable
  BEFORE UPDATE OF conversation_id, object_file_id ON attachments
  BEGIN
    SELECT RAISE(ABORT, 'attachment binding is immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS object_file_owner_immutable
  BEFORE UPDATE OF owner_model_id, owner_project_id, owner_conversation_id, owner_run_id, kind, source_attachment_id ON object_files
  BEGIN
    SELECT RAISE(ABORT, 'object file ownership is immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS run_binding_immutable
  BEFORE UPDATE OF project_id, experiment_configuration_id ON runs
  BEGIN
    SELECT RAISE(ABORT, 'run project and experiment binding is immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS experiment_project_immutable
  BEFORE UPDATE OF project_id ON experiment_configurations
  BEGIN
    SELECT RAISE(ABORT, 'experiment project binding is immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS output_binding_immutable
  BEFORE UPDATE OF run_id, object_file_id ON output_indexes
  BEGIN
    SELECT RAISE(ABORT, 'output binding is immutable');
  END;


  CREATE TRIGGER IF NOT EXISTS trash_target_immutable
  BEFORE UPDATE OF model_id, project_id, conversation_id, temporary_document_id, experiment_configuration_id, run_id ON trash_entries
  BEGIN
    SELECT RAISE(ABORT, 'trash target is immutable');
  END;
`;
