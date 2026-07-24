import { DatabaseSync } from "node:sqlite";
import { canonicalDigest, parseCanonicalJsonV2 } from "./canonical-json-v2.ts";
import { PRODUCT_SCHEMA_VERSION } from "./product-domain.ts";

const SQL = String.raw;

export type ProductDatabase = DatabaseSync;
export type ProductSchemaMigration = Readonly<{ version: number; sql: string }>;

export const PRODUCT_DATABASE_PRAGMAS = Object.freeze({
  foreignKeys: true,
  journalMode: "WAL",
  synchronous: "FULL",
  busyTimeoutMs: 5_000,
} as const);

export const configureProductDatabase = (database: ProductDatabase): void => {
  database.function("riff_canonical_sha256", { deterministic: true }, (value: string) => {
    if (typeof value !== "string") throw new TypeError("canonical SHA-256 input must be JSON text");
    return canonicalDigest(parseCanonicalJsonV2(value));
  });
  database.exec(SQL`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = ${PRODUCT_DATABASE_PRAGMAS.busyTimeoutMs};
  `);
};

export const initializeProductSchema = (
  database: ProductDatabase,
  migrations: readonly ProductSchemaMigration[] = PRODUCT_SCHEMA_MIGRATIONS,
): void => {
  configureProductDatabase(database);
  assertMigrationSequence(migrations);
  const installed = (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  const hasSchemaTable = Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'product_schema'").get());
  const declared = hasSchemaTable
    ? (database.prepare("SELECT version FROM product_schema WHERE singleton = 1").get() as { version: number } | undefined)?.version
    : undefined;
  if (installed > PRODUCT_SCHEMA_VERSION) throw new Error(`Unsupported product schema version: ${installed}`);
  if (hasSchemaTable && declared !== installed) {
    throw new Error(`Product schema version drift: user_version=${installed}, product_schema=${String(declared ?? "missing")}`);
  }
  if (!hasSchemaTable && installed !== 0) {
    throw new Error(`Product schema version drift: user_version=${installed}, product_schema=missing`);
  }

  database.exec("BEGIN IMMEDIATE");
  try {
    let version = installed;
    for (const migration of migrations) {
      if (migration.version <= version) continue;
      if (migration.version !== version + 1) throw new Error(`Missing product schema migration from ${version} to ${migration.version}`);
      database.exec(migration.sql);
      assertProductDatabaseIntegrity(database, migration.version);
      database.prepare("UPDATE product_schema SET version = ? WHERE singleton = 1").run(migration.version);
      database.exec(`PRAGMA user_version = ${migration.version}`);
      version = migration.version;
    }
    const schemaRow = database.prepare("SELECT version FROM product_schema WHERE singleton = 1").get() as { version: number } | undefined;
    const userVersion = (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (!schemaRow || schemaRow.version !== PRODUCT_SCHEMA_VERSION || userVersion !== PRODUCT_SCHEMA_VERSION) {
      throw new Error(`Incomplete product schema migration: user_version=${userVersion}, product_schema=${String(schemaRow?.version ?? "missing")}`);
    }
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* preserve the initialization error */ }
    throw error;
  }
};

const assertProductDatabaseIntegrity = (database: ProductDatabase, migrationVersion: number): void => {
  const foreignKeyViolation = database.prepare("PRAGMA foreign_key_check").get();
  if (foreignKeyViolation) {
    throw new Error(`Product schema migration ${migrationVersion} found a foreign-key violation`);
  }
  const rows = database.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>;
  if (rows.length !== 1 || rows[0]?.integrity_check !== "ok") {
    throw new Error(`Product schema migration ${migrationVersion} failed SQLite integrity_check`);
  }
};

const assertMigrationSequence = (migrations: readonly ProductSchemaMigration[]): void => {
  if (migrations.length !== PRODUCT_SCHEMA_VERSION) throw new Error("Product schema migration list does not reach the current version");
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) throw new Error(`Product schema migrations are not sequential at index ${index}`);
  });
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
  INSERT INTO product_schema (singleton, version) VALUES (1, 1)
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

const lifecycleIntegrityTriggers = (table: string): string => SQL`
  CREATE TRIGGER ${table}_lifecycle_v2_insert
  BEFORE INSERT ON ${table}
  WHEN NOT (
    (NEW.lifecycle_state = 'active' AND NEW.archived_at IS NULL AND NEW.trashed_at IS NULL AND NEW.pre_trash_state IS NULL)
    OR (NEW.lifecycle_state = 'archived' AND NEW.archived_at IS NOT NULL AND NEW.trashed_at IS NULL AND NEW.pre_trash_state IS NULL)
    OR (NEW.lifecycle_state = 'trashed' AND NEW.trashed_at IS NOT NULL AND NEW.pre_trash_state = 'active' AND NEW.archived_at IS NULL)
    OR (NEW.lifecycle_state = 'trashed' AND NEW.trashed_at IS NOT NULL AND NEW.pre_trash_state = 'archived' AND NEW.archived_at IS NOT NULL)
  )
  BEGIN
    SELECT RAISE(ABORT, 'lifecycle timestamp and pre-trash state mismatch');
  END;

  CREATE TRIGGER ${table}_lifecycle_v2_update
  BEFORE UPDATE OF lifecycle_state, pre_trash_state, archived_at, trashed_at ON ${table}
  WHEN NOT (
    (NEW.lifecycle_state = 'active' AND NEW.archived_at IS NULL AND NEW.trashed_at IS NULL AND NEW.pre_trash_state IS NULL)
    OR (NEW.lifecycle_state = 'archived' AND NEW.archived_at IS NOT NULL AND NEW.trashed_at IS NULL AND NEW.pre_trash_state IS NULL)
    OR (NEW.lifecycle_state = 'trashed' AND NEW.trashed_at IS NOT NULL AND NEW.pre_trash_state = 'active' AND NEW.archived_at IS NULL)
    OR (NEW.lifecycle_state = 'trashed' AND NEW.trashed_at IS NOT NULL AND NEW.pre_trash_state = 'archived' AND NEW.archived_at IS NOT NULL)
  )
  BEGIN
    SELECT RAISE(ABORT, 'lifecycle timestamp and pre-trash state mismatch');
  END;
`;

export const PRODUCT_SCHEMA_V2_SQL = SQL`
  ALTER TABLE object_files ADD COLUMN adoption_purpose TEXT;

  CREATE TEMP TABLE product_schema_v2_guard (
    valid INTEGER NOT NULL CHECK (valid = 1)
  ) STRICT;

  INSERT INTO product_schema_v2_guard(valid)
  SELECT 0 WHERE EXISTS (
    SELECT 1 FROM object_files
    WHERE kind = 'project_model_snapshot' AND owner_project_id IS NULL
  );

  INSERT INTO product_schema_v2_guard(valid)
  SELECT 0 WHERE EXISTS (
    SELECT 1
    FROM object_files f
    WHERE (f.kind = 'adopted_attachment' AND (
        f.source_attachment_id IS NULL
        OR f.adoption_purpose IS NULL
        OR length(trim(f.adoption_purpose)) = 0
        OR NOT EXISTS (
          SELECT 1
          FROM attachments a
          JOIN conversations c ON c.id = a.conversation_id
          WHERE a.id = f.source_attachment_id
            AND ((f.owner_model_id IS NOT NULL AND c.model_id = f.owner_model_id)
              OR (f.owner_project_id IS NOT NULL AND c.project_id = f.owner_project_id))
        )
      ))
      OR (f.kind != 'adopted_attachment' AND (f.source_attachment_id IS NOT NULL OR f.adoption_purpose IS NOT NULL))
  );

  ${["models", "projects", "conversations", "temporary_documents", "experiment_configurations"].map((table) => SQL`
    INSERT INTO product_schema_v2_guard(valid)
    SELECT 0 WHERE EXISTS (
      SELECT 1 FROM ${table}
      WHERE NOT (
        (lifecycle_state = 'active' AND archived_at IS NULL AND trashed_at IS NULL AND pre_trash_state IS NULL)
        OR (lifecycle_state = 'archived' AND archived_at IS NOT NULL AND trashed_at IS NULL AND pre_trash_state IS NULL)
        OR (lifecycle_state = 'trashed' AND trashed_at IS NOT NULL AND pre_trash_state = 'active' AND archived_at IS NULL)
        OR (lifecycle_state = 'trashed' AND trashed_at IS NOT NULL AND pre_trash_state = 'archived' AND archived_at IS NOT NULL)
      )
    );
  `).join("\n")}

  DROP TABLE product_schema_v2_guard;

  CREATE TRIGGER object_file_kind_owner_v2_insert
  BEFORE INSERT ON object_files
  WHEN (NEW.kind = 'project_model_snapshot' AND NEW.owner_project_id IS NULL)
    OR (NEW.kind = 'adopted_attachment' AND (
      NEW.source_attachment_id IS NULL OR NEW.adoption_purpose IS NULL OR length(trim(NEW.adoption_purpose)) = 0
    ))
    OR (NEW.kind != 'adopted_attachment' AND (NEW.source_attachment_id IS NOT NULL OR NEW.adoption_purpose IS NOT NULL))
  BEGIN
    SELECT RAISE(ABORT, 'object file kind ownership or adoption metadata mismatch');
  END;

  CREATE TRIGGER adopted_attachment_scope_v2_insert
  BEFORE INSERT ON object_files WHEN NEW.kind = 'adopted_attachment' AND NEW.source_attachment_id IS NOT NULL
  BEGIN
    SELECT CASE WHEN NOT EXISTS (
      SELECT 1
      FROM attachments a
      JOIN conversations c ON c.id = a.conversation_id
      WHERE a.id = NEW.source_attachment_id
        AND ((NEW.owner_model_id IS NOT NULL AND c.model_id = NEW.owner_model_id)
          OR (NEW.owner_project_id IS NOT NULL AND c.project_id = NEW.owner_project_id))
    ) THEN RAISE(ABORT, 'adopted attachment owner does not match source conversation owner') END;
  END;

  CREATE TRIGGER object_file_adoption_purpose_immutable_v2
  BEFORE UPDATE OF adoption_purpose ON object_files
  BEGIN
    SELECT RAISE(ABORT, 'object file adoption purpose is immutable');
  END;

  ${lifecycleIntegrityTriggers("models")}
  ${lifecycleIntegrityTriggers("projects")}
  ${lifecycleIntegrityTriggers("conversations")}
  ${lifecycleIntegrityTriggers("temporary_documents")}
  ${lifecycleIntegrityTriggers("experiment_configurations")}
`;

export const PRODUCT_SCHEMA_V3_SQL = SQL`
  CREATE TEMP TABLE product_schema_v3_guard (valid INTEGER NOT NULL CHECK (valid = 1)) STRICT;

  INSERT INTO product_schema_v3_guard(valid)
  SELECT 0 WHERE EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.provider_locked_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.role = 'user')
  );

  INSERT INTO product_schema_v3_guard(valid)
  SELECT 0 WHERE EXISTS (
    SELECT 1 FROM messages m
    WHERE m.ordinal != (SELECT count(*) - 1 FROM messages prior
      WHERE prior.conversation_id = m.conversation_id AND prior.ordinal <= m.ordinal)
  );

  INSERT INTO product_schema_v3_guard(valid)
  SELECT 0 WHERE EXISTS (SELECT 1 FROM messages WHERE NOT json_valid(content_json) OR (action_json IS NOT NULL AND NOT json_valid(action_json)));

  UPDATE conversations
  SET provider_locked_at = (
    SELECT min(created_at) FROM messages WHERE conversation_id = conversations.id AND role = 'user'
  )
  WHERE provider_locked_at IS NULL
    AND EXISTS (SELECT 1 FROM messages WHERE conversation_id = conversations.id AND role = 'user');

  DROP TABLE product_schema_v3_guard;

  CREATE UNIQUE INDEX messages_id_conversation_v3 ON messages(id, conversation_id);

  CREATE TABLE conversation_summaries (
    conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    covered_through_ordinal INTEGER NOT NULL CHECK (covered_through_ordinal >= 0),
    content TEXT NOT NULL CHECK (length(content) <= 65536),
    content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE agent_sessions (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 3 AND 128),
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    generation INTEGER NOT NULL CHECK (generation >= 1),
    state TEXT NOT NULL CHECK (state IN ('creating', 'available', 'lost', 'rebuilding', 'closed')),
    provider_id TEXT NOT NULL,
    provider_model_id TEXT NOT NULL,
    external_session_ref TEXT CHECK (external_session_ref IS NULL OR length(external_session_ref) BETWEEN 1 AND 4096),
    context_sha256 TEXT CHECK (context_sha256 IS NULL OR (length(context_sha256) = 64 AND context_sha256 NOT GLOB '*[^0-9a-f]*')),
    failure_reason TEXT CHECK (failure_reason IS NULL OR length(failure_reason) BETWEEN 1 AND 200),
    last_successful_turn_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (conversation_id, generation),
    FOREIGN KEY (last_successful_turn_id, conversation_id)
      REFERENCES agent_turns(id, conversation_id) DEFERRABLE INITIALLY DEFERRED,
    CHECK (state != 'available' OR external_session_ref IS NOT NULL)
  ) STRICT;
  CREATE UNIQUE INDEX one_live_agent_session_v3 ON agent_sessions(conversation_id) WHERE state != 'closed';

  CREATE TABLE agent_turns (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 3 AND 128),
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    request_key TEXT NOT NULL CHECK (length(request_key) BETWEEN 1 AND 300),
    intent_sha256 TEXT NOT NULL CHECK (length(intent_sha256) = 64 AND intent_sha256 NOT GLOB '*[^0-9a-f]*'),
    input_message_id TEXT NOT NULL,
    assistant_message_id TEXT,
    state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'complete', 'failed', 'read_only')),
    reconstructed_context_sha256 TEXT CHECK (reconstructed_context_sha256 IS NULL OR (length(reconstructed_context_sha256) = 64 AND reconstructed_context_sha256 NOT GLOB '*[^0-9a-f]*')),
    failure_code TEXT CHECK (failure_code IS NULL OR length(failure_code) BETWEEN 1 AND 200),
    failure_retryable INTEGER CHECK (failure_retryable IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (conversation_id, request_key),
    UNIQUE (id, conversation_id),
    FOREIGN KEY (input_message_id, conversation_id) REFERENCES messages(id, conversation_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    FOREIGN KEY (assistant_message_id, conversation_id) REFERENCES messages(id, conversation_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CHECK ((state = 'failed' AND failure_code IS NOT NULL AND failure_retryable IS NOT NULL)
      OR (state != 'failed' AND failure_code IS NULL AND failure_retryable IS NULL))
  ) STRICT;

  CREATE TABLE skill_uses (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 3 AND 128),
    conversation_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    skill_id TEXT NOT NULL CHECK (length(trim(skill_id)) BETWEEN 1 AND 300),
    skill_version TEXT NOT NULL CHECK (length(trim(skill_version)) BETWEEN 1 AND 100),
    routing_mode TEXT NOT NULL CHECK (routing_mode IN ('explicit', 'automatic')),
    catalog_sha256 TEXT NOT NULL CHECK (length(catalog_sha256) = 64 AND catalog_sha256 NOT GLOB '*[^0-9a-f]*'),
    instruction_sha256 TEXT NOT NULL CHECK (length(instruction_sha256) = 64 AND instruction_sha256 NOT GLOB '*[^0-9a-f]*'),
    load_state TEXT NOT NULL CHECK (load_state IN ('selected', 'loaded', 'failed')),
    rationale TEXT CHECK (rationale IS NULL OR length(rationale) <= 2000),
    created_at TEXT NOT NULL,
    UNIQUE (id, turn_id),
    FOREIGN KEY (turn_id, conversation_id) REFERENCES agent_turns(id, conversation_id) ON UPDATE RESTRICT ON DELETE RESTRICT
  ) STRICT;

  CREATE TABLE action_records (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 3 AND 128),
    conversation_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    action_kind TEXT NOT NULL CHECK (length(trim(action_kind)) BETWEEN 1 AND 200),
    intent_json TEXT NOT NULL CHECK (json_valid(intent_json) AND json_type(intent_json) = 'object'),
    permission_decision TEXT NOT NULL CHECK (permission_decision IN ('pending', 'allowed', 'denied')),
    state TEXT NOT NULL CHECK (state IN ('proposed', 'authorized', 'staging', 'committed', 'denied', 'rolled_back', 'failed')),
    mutation_transaction_id TEXT,
    affected_resources_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(affected_resources_json) AND json_type(affected_resources_json) = 'array'),
    error_code TEXT CHECK (error_code IS NULL OR length(error_code) BETWEEN 1 AND 200),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (id, turn_id),
    FOREIGN KEY (turn_id, conversation_id) REFERENCES agent_turns(id, conversation_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CHECK ((state = 'denied' AND permission_decision = 'denied')
      OR (state IN ('authorized', 'staging', 'committed') AND permission_decision = 'allowed')
      OR state IN ('proposed', 'rolled_back', 'failed'))
  ) STRICT;

  CREATE TABLE temporary_document_adoptions (
    document_id TEXT NOT NULL REFERENCES temporary_documents(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    action_record_id TEXT NOT NULL REFERENCES action_records(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (document_id, action_record_id)
  ) STRICT;

  CREATE TABLE model_technical_checks (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 3 AND 128),
    model_id TEXT NOT NULL REFERENCES models(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    workspace_sha256 TEXT NOT NULL CHECK (length(workspace_sha256) = 64 AND workspace_sha256 NOT GLOB '*[^0-9a-f]*'),
    execution_description_sha256 TEXT NOT NULL CHECK (length(execution_description_sha256) = 64 AND execution_description_sha256 NOT GLOB '*[^0-9a-f]*'),
    state TEXT NOT NULL CHECK (state IN ('running', 'passed', 'failed', 'cancelled')),
    results_json TEXT NOT NULL CHECK (json_valid(results_json) AND json_type(results_json) = 'object'),
    limits_json TEXT NOT NULL CHECK (json_valid(limits_json) AND json_type(limits_json) = 'object'),
    log_object_file_id TEXT REFERENCES object_files(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    CHECK ((state = 'running' AND finished_at IS NULL) OR (state != 'running' AND finished_at IS NOT NULL))
  ) STRICT;
  CREATE UNIQUE INDEX one_running_model_check_v3 ON model_technical_checks(model_id) WHERE state = 'running';

  CREATE TRIGGER conversation_provider_locked_v3
  BEFORE UPDATE OF provider_id, provider_model_id ON conversations
  WHEN OLD.provider_locked_at IS NOT NULL
  BEGIN SELECT RAISE(ABORT, 'conversation provider is locked'); END;

  CREATE TRIGGER first_user_message_requires_provider_lock_v3
  BEFORE INSERT ON messages WHEN NEW.role = 'user'
  BEGIN
    SELECT CASE WHEN NOT EXISTS (
      SELECT 1 FROM conversations WHERE id = NEW.conversation_id AND provider_locked_at IS NOT NULL
    ) THEN RAISE(ABORT, 'first user message requires provider lock') END;
  END;

  CREATE TRIGGER message_ordinal_append_only_v3
  BEFORE INSERT ON messages
  WHEN NEW.ordinal != (SELECT count(*) FROM messages WHERE conversation_id = NEW.conversation_id)
  BEGIN SELECT RAISE(ABORT, 'message ordinal must append contiguously'); END;

  CREATE TRIGGER summary_coverage_forward_v3
  BEFORE UPDATE OF covered_through_ordinal ON conversation_summaries
  WHEN NEW.covered_through_ordinal <= OLD.covered_through_ordinal
  BEGIN SELECT RAISE(ABORT, 'summary coverage must advance'); END;

  CREATE TRIGGER agent_session_provider_owner_v3
  BEFORE INSERT ON agent_sessions
  BEGIN
    SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM conversations c WHERE c.id = NEW.conversation_id
      AND c.provider_id = NEW.provider_id AND c.provider_model_id = NEW.provider_model_id AND c.provider_locked_at IS NOT NULL)
      THEN RAISE(ABORT, 'agent session provider mismatch') END;
  END;

  CREATE TRIGGER technical_check_log_owner_v3
  BEFORE INSERT ON model_technical_checks WHEN NEW.log_object_file_id IS NOT NULL
  BEGIN
    SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM object_files WHERE id = NEW.log_object_file_id AND owner_model_id = NEW.model_id)
      THEN RAISE(ABORT, 'technical check log owner mismatch') END;
  END;

  CREATE TRIGGER document_adoption_owner_v3
  BEFORE INSERT ON temporary_document_adoptions
  BEGIN
    SELECT CASE WHEN NOT EXISTS (
      SELECT 1 FROM temporary_documents d JOIN action_records a ON a.id = NEW.action_record_id
      WHERE d.id = NEW.document_id AND d.conversation_id = a.conversation_id AND a.state = 'committed'
    ) THEN RAISE(ABORT, 'document adoption action owner mismatch') END;
  END;

  CREATE TRIGGER temporary_document_transition_v3
  BEFORE UPDATE OF document_state ON temporary_documents
  WHEN OLD.document_state != 'draft' OR NEW.document_state NOT IN ('adopted', 'rejected', 'superseded')
  BEGIN SELECT RAISE(ABORT, 'invalid temporary document transition'); END;

  CREATE TRIGGER committed_action_receipt_v3
  BEFORE UPDATE OF state ON action_records WHEN NEW.state = 'committed'
  BEGIN
    SELECT CASE WHEN NEW.mutation_transaction_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM committed_mutations WHERE transaction_id = NEW.mutation_transaction_id
    ) THEN RAISE(ABORT, 'committed action requires mutation receipt') END;
  END;
`;

export const PRODUCT_SCHEMA_V4_SQL = SQL`
  ALTER TABLE experiment_configurations
    ADD COLUMN contract_version INTEGER NOT NULL DEFAULT 4 CHECK (contract_version IN (3, 4));
  ALTER TABLE experiment_configurations
    ADD COLUMN legacy_digest TEXT CHECK (legacy_digest IS NULL OR (length(legacy_digest) = 64 AND legacy_digest NOT GLOB '*[^0-9a-f]*'));
  ALTER TABLE experiment_configurations
    ADD COLUMN configuration_sha256 TEXT CHECK (configuration_sha256 IS NULL OR (length(configuration_sha256) = 64 AND configuration_sha256 NOT GLOB '*[^0-9a-f]*'));
  ALTER TABLE experiment_configurations
    ADD COLUMN sample_count INTEGER CHECK (sample_count IS NULL OR sample_count >= 1);

  ALTER TABLE runs
    ADD COLUMN contract_version INTEGER NOT NULL DEFAULT 4 CHECK (contract_version IN (3, 4));
  ALTER TABLE runs
    ADD COLUMN legacy_digest TEXT CHECK (legacy_digest IS NULL OR (length(legacy_digest) = 64 AND legacy_digest NOT GLOB '*[^0-9a-f]*'));
  ALTER TABLE runs ADD COLUMN run_kind TEXT CHECK (run_kind IS NULL OR run_kind IN ('batch', 'visual'));
  ALTER TABLE runs ADD COLUMN completion_conversation_id TEXT REFERENCES conversations(id) ON UPDATE RESTRICT ON DELETE RESTRICT;
  ALTER TABLE runs
    ADD COLUMN execution_description_sha256 TEXT CHECK (execution_description_sha256 IS NULL OR (length(execution_description_sha256) = 64 AND execution_description_sha256 NOT GLOB '*[^0-9a-f]*'));
  ALTER TABLE runs
    ADD COLUMN project_snapshot_sha256 TEXT CHECK (project_snapshot_sha256 IS NULL OR (length(project_snapshot_sha256) = 64 AND project_snapshot_sha256 NOT GLOB '*[^0-9a-f]*'));
  ALTER TABLE runs
    ADD COLUMN frozen_configuration_sha256 TEXT CHECK (frozen_configuration_sha256 IS NULL OR (length(frozen_configuration_sha256) = 64 AND frozen_configuration_sha256 NOT GLOB '*[^0-9a-f]*'));
  ALTER TABLE runs ADD COLUMN sample_plan_json TEXT CHECK (sample_plan_json IS NULL OR (json_valid(sample_plan_json) AND json_type(sample_plan_json) = 'array'));
  ALTER TABLE runs
    ADD COLUMN sample_plan_sha256 TEXT CHECK (sample_plan_sha256 IS NULL OR (length(sample_plan_sha256) = 64 AND sample_plan_sha256 NOT GLOB '*[^0-9a-f]*'));
  ALTER TABLE runs ADD COLUMN limits_json TEXT CHECK (limits_json IS NULL OR (json_valid(limits_json) AND json_type(limits_json) = 'object'));
  ALTER TABLE runs
    ADD COLUMN limits_sha256 TEXT CHECK (limits_sha256 IS NULL OR (length(limits_sha256) = 64 AND limits_sha256 NOT GLOB '*[^0-9a-f]*'));
  ALTER TABLE runs
    ADD COLUMN start_receipt_sha256 TEXT CHECK (start_receipt_sha256 IS NULL OR (length(start_receipt_sha256) = 64 AND start_receipt_sha256 NOT GLOB '*[^0-9a-f]*'));
  ALTER TABLE runs ADD COLUMN cancel_requested_at TEXT;
  ALTER TABLE runs ADD COLUMN terminal_code TEXT CHECK (terminal_code IS NULL OR length(terminal_code) BETWEEN 1 AND 200);
  ALTER TABLE runs ADD COLUMN terminal_diagnostics_json TEXT CHECK (terminal_diagnostics_json IS NULL OR json_valid(terminal_diagnostics_json));
  ALTER TABLE runs ADD COLUMN resource_overview_json TEXT CHECK (resource_overview_json IS NULL OR (json_valid(resource_overview_json) AND json_type(resource_overview_json) = 'object'));
  ALTER TABLE runs ADD COLUMN completion_card_disposition TEXT
    CHECK (completion_card_disposition IS NULL OR completion_card_disposition IN ('not_requested', 'pending', 'published', 'conversation_unavailable'));

  CREATE TEMP TABLE product_schema_v4_run_lifecycle_guard (
    valid INTEGER NOT NULL
  ) STRICT;
  CREATE TEMP TRIGGER product_schema_v4_run_lifecycle_guard_reject
  BEFORE INSERT ON product_schema_v4_run_lifecycle_guard
  WHEN NEW.valid != 1
  BEGIN SELECT RAISE(ABORT, 'legacy run lifecycle is ambiguous'); END;
  INSERT INTO product_schema_v4_run_lifecycle_guard (valid)
  SELECT 0
  FROM runs
  WHERE NOT (
    (status IN ('configured', 'queued') AND started_at IS NULL AND finished_at IS NULL)
    OR (status = 'running' AND started_at IS NOT NULL AND finished_at IS NULL)
    OR (status IN ('succeeded', 'failed', 'cancelled', 'timed_out', 'trashed')
      AND started_at IS NOT NULL AND finished_at IS NOT NULL)
  );
  DROP TRIGGER product_schema_v4_run_lifecycle_guard_reject;
  DROP TABLE product_schema_v4_run_lifecycle_guard;

  UPDATE experiment_configurations
  SET contract_version = 3,
      legacy_digest = riff_canonical_sha256(json_object(
        'contractVersion', 3,
        'id', id,
        'projectId', project_id,
        'name', name,
        'configuration', json(configuration_json),
        'estimatedSampleCount', estimated_sample_count,
        'lifecycleState', lifecycle_state,
        'createdAt', created_at,
        'updatedAt', updated_at
      ));

  UPDATE runs
  SET contract_version = 3,
      legacy_digest = riff_canonical_sha256(json_object(
        'contractVersion', 3,
        'id', id,
        'projectId', project_id,
        'experimentConfigurationId', experiment_configuration_id,
        'status', status,
        'frozenConfiguration', json(frozen_configuration_json),
        'requestedSampleCount', requested_sample_count,
        'createdAt', created_at,
        'updatedAt', updated_at,
        'startedAt', started_at,
        'finishedAt', finished_at
      ));

  ALTER TABLE output_indexes RENAME TO output_indexes_v3;
  CREATE TABLE output_indexes (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 3 AND 128),
    run_id TEXT NOT NULL REFERENCES runs(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    object_file_id TEXT NOT NULL UNIQUE REFERENCES object_files(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    logical_name TEXT NOT NULL CHECK (length(trim(logical_name)) BETWEEN 1 AND 500),
    output_type TEXT NOT NULL CHECK (length(trim(output_type)) BETWEEN 1 AND 200),
    contract_version INTEGER NOT NULL DEFAULT 4 CHECK (contract_version IN (3, 4)),
    legacy_digest TEXT CHECK (legacy_digest IS NULL OR (length(legacy_digest) = 64 AND legacy_digest NOT GLOB '*[^0-9a-f]*')),
    sample_index INTEGER CHECK (sample_index IS NULL OR sample_index >= 0),
    sample_id TEXT CHECK (sample_id IS NULL OR (length(sample_id) = 64 AND sample_id NOT GLOB '*[^0-9a-f]*')),
    declared_role TEXT CHECK (declared_role IS NULL OR declared_role IN ('metric', 'table', 'document', 'data', 'diagnostic')),
    output_contract_sha256 TEXT CHECK (output_contract_sha256 IS NULL OR (length(output_contract_sha256) = 64 AND output_contract_sha256 NOT GLOB '*[^0-9a-f]*')),
    created_at TEXT NOT NULL,
    UNIQUE (run_id, sample_index, logical_name),
    CHECK ((contract_version = 3 AND legacy_digest IS NOT NULL AND sample_index IS NULL AND sample_id IS NULL)
      OR (contract_version = 4 AND legacy_digest IS NULL AND sample_index IS NOT NULL AND sample_id IS NOT NULL
        AND declared_role IS NOT NULL AND output_contract_sha256 IS NOT NULL))
  ) STRICT;

  INSERT INTO output_indexes
    (id, run_id, object_file_id, logical_name, output_type, contract_version, legacy_digest, created_at)
  SELECT id, run_id, object_file_id, logical_name, output_type, 3,
    riff_canonical_sha256(json_object(
      'contractVersion', 3,
      'id', id,
      'runId', run_id,
      'objectFileId', object_file_id,
      'logicalName', logical_name,
      'outputType', output_type,
      'createdAt', created_at
    )),
    created_at
  FROM output_indexes_v3;
  DROP TABLE output_indexes_v3;

  CREATE TEMP TABLE product_schema_v4_guard (valid INTEGER NOT NULL CHECK (valid = 1)) STRICT;
  INSERT INTO product_schema_v4_guard(valid)
  SELECT 0 WHERE EXISTS (
    SELECT 1 FROM experiment_configurations
    WHERE contract_version != 3 OR legacy_digest IS NULL
  );
  INSERT INTO product_schema_v4_guard(valid)
  SELECT 0 WHERE EXISTS (
    SELECT 1 FROM runs
    WHERE contract_version != 3 OR legacy_digest IS NULL
  );
  INSERT INTO product_schema_v4_guard(valid)
  SELECT 0 WHERE EXISTS (
    SELECT 1 FROM output_indexes
    WHERE contract_version != 3 OR legacy_digest IS NULL
  );
  DROP TABLE product_schema_v4_guard;

  CREATE TABLE run_attempts (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 3 AND 128),
    run_id TEXT NOT NULL REFERENCES runs(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    attempt_generation INTEGER NOT NULL CHECK (attempt_generation >= 1),
    dispatcher_generation TEXT NOT NULL CHECK (length(dispatcher_generation) = 64 AND dispatcher_generation NOT GLOB '*[^0-9a-f]*'),
    state TEXT NOT NULL CHECK (state IN ('claimed', 'starting', 'running', 'succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted')),
    claimed_at TEXT NOT NULL,
    lease_expires_at TEXT NOT NULL,
    heartbeat_at TEXT,
    started_at TEXT,
    finished_at TEXT,
    UNIQUE (run_id, attempt_generation),
    CHECK ((state IN ('succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted') AND finished_at IS NOT NULL)
      OR (state NOT IN ('succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted') AND finished_at IS NULL))
  ) STRICT;
  CREATE UNIQUE INDEX one_nonterminal_run_attempt_v4 ON run_attempts(run_id)
    WHERE state IN ('claimed', 'starting', 'running');

  CREATE TABLE process_attempts (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 3 AND 128),
    run_attempt_id TEXT NOT NULL REFERENCES run_attempts(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    process_kind TEXT NOT NULL CHECK (process_kind IN ('batch', 'visual')),
    sample_index INTEGER CHECK (sample_index IS NULL OR sample_index >= 0),
    sample_id TEXT CHECK (sample_id IS NULL OR (length(sample_id) = 64 AND sample_id NOT GLOB '*[^0-9a-f]*')),
    pid INTEGER NOT NULL CHECK (pid >= 1),
    process_start_token TEXT NOT NULL CHECK (length(process_start_token) BETWEEN 1 AND 300),
    process_group_id INTEGER NOT NULL CHECK (process_group_id >= 1),
    launch_gate_state TEXT NOT NULL CHECK (launch_gate_state IN ('blocked', 'released', 'timed_out')),
    state TEXT NOT NULL CHECK (state IN ('blocked', 'released', 'running', 'exited', 'cleanup_complete', 'cleanup_unverified')),
    loopback_port INTEGER CHECK (loopback_port IS NULL OR loopback_port BETWEEN 1 AND 65535),
    launched_at TEXT NOT NULL,
    started_at TEXT,
    health_at TEXT,
    heartbeat_at TEXT,
    exited_at TEXT,
    exit_code INTEGER,
    exit_signal TEXT CHECK (exit_signal IS NULL OR length(exit_signal) BETWEEN 1 AND 100),
    cleanup_receipt_sha256 TEXT CHECK (cleanup_receipt_sha256 IS NULL OR (length(cleanup_receipt_sha256) = 64 AND cleanup_receipt_sha256 NOT GLOB '*[^0-9a-f]*')),
    CHECK ((process_kind = 'batch' AND sample_index IS NOT NULL AND sample_id IS NOT NULL AND loopback_port IS NULL)
      OR (process_kind = 'visual' AND sample_index IS NULL AND sample_id IS NULL AND loopback_port IS NOT NULL)),
    CHECK ((state = 'cleanup_complete' AND cleanup_receipt_sha256 IS NOT NULL)
      OR state != 'cleanup_complete')
  ) STRICT;
  CREATE UNIQUE INDEX one_batch_process_attempt_v4 ON process_attempts(run_attempt_id, sample_index)
    WHERE process_kind = 'batch' AND state NOT IN ('cleanup_complete', 'cleanup_unverified');
  CREATE UNIQUE INDEX one_visual_process_attempt_v4 ON process_attempts(run_attempt_id)
    WHERE process_kind = 'visual' AND state NOT IN ('cleanup_complete', 'cleanup_unverified');

  CREATE TABLE run_commands (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 3 AND 128),
    run_id TEXT NOT NULL REFERENCES runs(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    command_kind TEXT NOT NULL CHECK (command_kind IN ('start', 'cancel', 'trash', 'restore')),
    request_key TEXT NOT NULL CHECK (length(request_key) BETWEEN 1 AND 300),
    intent_sha256 TEXT NOT NULL CHECK (length(intent_sha256) = 64 AND intent_sha256 NOT GLOB '*[^0-9a-f]*'),
    state TEXT NOT NULL CHECK (state IN ('accepted', 'committed', 'rejected')),
    outcome_json TEXT NOT NULL CHECK (json_valid(outcome_json) AND json_type(outcome_json) = 'object'),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (run_id, request_key)
  ) STRICT;

  CREATE TABLE run_command_receipts (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 3 AND 128),
    run_id TEXT NOT NULL REFERENCES runs(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    command_id TEXT NOT NULL UNIQUE REFERENCES run_commands(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    receipt_kind TEXT NOT NULL CHECK (length(receipt_kind) BETWEEN 1 AND 100),
    payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256) = 64 AND payload_sha256 NOT GLOB '*[^0-9a-f]*'),
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND json_type(payload_json) = 'object'),
    committed_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE experiment_command_receipts (
    command_id TEXT PRIMARY KEY CHECK (length(command_id) BETWEEN 3 AND 128),
    command_kind TEXT NOT NULL CHECK (command_kind IN ('create', 'update')),
    project_id TEXT NOT NULL REFERENCES projects(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    experiment_id TEXT NOT NULL REFERENCES experiment_configurations(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    intent_sha256 TEXT NOT NULL CHECK (length(intent_sha256) = 64 AND intent_sha256 NOT GLOB '*[^0-9a-f]*'),
    response_json TEXT NOT NULL CHECK (json_valid(response_json) AND json_type(response_json) = 'object'),
    response_sha256 TEXT NOT NULL CHECK (length(response_sha256) = 64 AND response_sha256 NOT GLOB '*[^0-9a-f]*'),
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE TRIGGER project_frozen_copy_immutable_v4
  BEFORE UPDATE OF model_snapshot_digest, execution_description_json ON projects
  BEGIN SELECT RAISE(ABORT, 'project frozen copy is immutable'); END;

  CREATE TRIGGER project_snapshot_metadata_immutable_v4
  BEFORE UPDATE OF id, relative_path, media_type, size_bytes, sha256, created_at ON object_files
  WHEN OLD.kind = 'project_model_snapshot' OR NEW.kind = 'project_model_snapshot'
  BEGIN SELECT RAISE(ABORT, 'project snapshot metadata is immutable'); END;

  CREATE TRIGGER experiment_v4_shape_insert
  BEFORE INSERT ON experiment_configurations
  WHEN NEW.contract_version != 4
    OR NEW.legacy_digest IS NOT NULL
    OR NEW.configuration_sha256 IS NULL
    OR NEW.configuration_sha256 != riff_canonical_sha256(NEW.configuration_json)
    OR NEW.sample_count IS NULL
    OR NEW.sample_count != NEW.estimated_sample_count
  BEGIN SELECT RAISE(ABORT, 'new experiment requires v4 contract fields'); END;
  CREATE TRIGGER experiment_v4_shape_update
  BEFORE UPDATE OF configuration_json, configuration_sha256, sample_count, estimated_sample_count
    ON experiment_configurations
  WHEN OLD.contract_version = 4 AND (
    NEW.configuration_sha256 IS NULL
    OR NEW.configuration_sha256 != riff_canonical_sha256(NEW.configuration_json)
    OR NEW.sample_count IS NULL
    OR NEW.sample_count != NEW.estimated_sample_count
  )
  BEGIN SELECT RAISE(ABORT, 'updated experiment requires matching v4 contract fields'); END;

  CREATE TRIGGER experiment_legacy_read_only_v4
  BEFORE UPDATE ON experiment_configurations WHEN OLD.contract_version = 3
  BEGIN SELECT RAISE(ABORT, 'legacy experiment contract is read only'); END;
  CREATE TRIGGER experiment_legacy_delete_v4
  BEFORE DELETE ON experiment_configurations WHEN OLD.contract_version = 3
  BEGIN SELECT RAISE(ABORT, 'legacy experiment contract is read only'); END;
  CREATE TRIGGER experiment_contract_immutable_v4
  BEFORE UPDATE OF contract_version, legacy_digest ON experiment_configurations
  BEGIN SELECT RAISE(ABORT, 'experiment contract identity is immutable'); END;

  CREATE TRIGGER experiment_receipt_owner_v4
  BEFORE INSERT ON experiment_command_receipts
  BEGIN
    SELECT CASE WHEN NOT EXISTS (
      SELECT 1 FROM experiment_configurations
      WHERE id = NEW.experiment_id
        AND project_id = NEW.project_id
        AND contract_version = 4
    ) THEN RAISE(ABORT, 'experiment receipt project or experiment mismatch') END;
  END;
  CREATE TRIGGER experiment_receipt_digest_v4
  BEFORE INSERT ON experiment_command_receipts
  WHEN NEW.response_sha256 != riff_canonical_sha256(NEW.response_json)
  BEGIN SELECT RAISE(ABORT, 'experiment receipt response digest mismatch'); END;
  CREATE TRIGGER experiment_receipt_immutable_v4
  BEFORE UPDATE ON experiment_command_receipts
  BEGIN SELECT RAISE(ABORT, 'experiment receipt is immutable'); END;
  CREATE TRIGGER experiment_receipt_delete_v4
  BEFORE DELETE ON experiment_command_receipts
  BEGIN SELECT RAISE(ABORT, 'experiment receipt is immutable'); END;

  CREATE TRIGGER run_v4_shape_insert
  BEFORE INSERT ON runs
  WHEN NEW.contract_version != 4
    OR NEW.legacy_digest IS NOT NULL
    OR NEW.status != 'queued'
    OR NEW.run_kind IS NULL
    OR NEW.execution_description_sha256 IS NULL
    OR NEW.project_snapshot_sha256 IS NULL
    OR NEW.frozen_configuration_sha256 IS NULL
    OR NEW.sample_plan_json IS NULL
    OR NEW.sample_plan_sha256 IS NULL
    OR NEW.limits_json IS NULL
    OR NEW.limits_sha256 IS NULL
    OR NEW.start_receipt_sha256 IS NULL
    OR NEW.frozen_configuration_sha256 != riff_canonical_sha256(NEW.frozen_configuration_json)
    OR NEW.sample_plan_sha256 != riff_canonical_sha256(NEW.sample_plan_json)
    OR NEW.limits_sha256 != riff_canonical_sha256(NEW.limits_json)
    OR json_array_length(NEW.sample_plan_json) != NEW.requested_sample_count
    OR (NEW.run_kind = 'visual' AND NEW.requested_sample_count != 1)
    OR NEW.started_at IS NOT NULL
    OR NEW.finished_at IS NOT NULL
    OR NEW.trashed_at IS NOT NULL
  BEGIN SELECT RAISE(ABORT, 'new run requires a queued v4 frozen contract'); END;

  CREATE TRIGGER run_v4_project_digests_insert
  BEFORE INSERT ON runs WHEN NEW.contract_version = 4
  BEGIN
    SELECT CASE WHEN NOT EXISTS (
      SELECT 1 FROM projects
      WHERE id = NEW.project_id
        AND model_snapshot_digest = NEW.project_snapshot_sha256
        AND riff_canonical_sha256(execution_description_json) = NEW.execution_description_sha256
    ) THEN RAISE(ABORT, 'run frozen Project digests mismatch') END;
  END;

  CREATE TRIGGER run_completion_conversation_owner_v4
  BEFORE INSERT ON runs WHEN NEW.completion_conversation_id IS NOT NULL
  BEGIN
    SELECT CASE WHEN NOT EXISTS (
      SELECT 1 FROM conversations
      WHERE id = NEW.completion_conversation_id AND project_id = NEW.project_id
    ) THEN RAISE(ABORT, 'run completion conversation project mismatch') END;
  END;

  CREATE TRIGGER run_legacy_read_only_v4
  BEFORE UPDATE ON runs WHEN OLD.contract_version = 3
  BEGIN SELECT RAISE(ABORT, 'legacy run contract is read only'); END;
  CREATE TRIGGER run_legacy_delete_v4
  BEFORE DELETE ON runs WHEN OLD.contract_version = 3
  BEGIN SELECT RAISE(ABORT, 'legacy run contract is read only'); END;
  CREATE TRIGGER run_frozen_contract_immutable_v4
  BEFORE UPDATE OF contract_version, legacy_digest, run_kind, execution_description_sha256,
    project_snapshot_sha256, frozen_configuration_json, frozen_configuration_sha256,
    requested_sample_count, sample_plan_json, sample_plan_sha256, limits_json, limits_sha256,
    start_receipt_sha256,
    completion_conversation_id ON runs
  WHEN OLD.contract_version = 4
  BEGIN SELECT RAISE(ABORT, 'run frozen contract is immutable'); END;

  CREATE TRIGGER run_status_transition_v4
  BEFORE UPDATE OF status ON runs WHEN OLD.contract_version = 4 AND NOT (
    (OLD.status = 'queued' AND NEW.status IN ('running', 'failed', 'cancelled'))
    OR (OLD.status = 'running' AND NEW.status IN ('succeeded', 'failed', 'cancelled', 'timed_out'))
    OR (OLD.status IN ('succeeded', 'failed', 'cancelled', 'timed_out') AND NEW.status = 'trashed'
      AND NEW.pre_trash_status = OLD.status AND NEW.trashed_at IS NOT NULL)
    OR (OLD.status = 'trashed' AND NEW.status = OLD.pre_trash_status
      AND OLD.pre_trash_status IN ('succeeded', 'failed', 'cancelled', 'timed_out')
      AND NEW.pre_trash_status IS NULL AND NEW.trashed_at IS NULL)
  )
  BEGIN SELECT RAISE(ABORT, 'invalid v4 run status transition'); END;

  CREATE TRIGGER run_cancel_intent_v4
  BEFORE UPDATE OF cancel_requested_at ON runs WHEN OLD.contract_version = 4 AND (
    OLD.cancel_requested_at IS NOT NULL
    OR NEW.cancel_requested_at IS NULL
    OR OLD.status NOT IN ('queued', 'running')
  )
  BEGIN SELECT RAISE(ABORT, 'invalid v4 run cancellation intent'); END;

  CREATE TRIGGER run_timestamp_state_v4
  BEFORE UPDATE OF status, started_at, finished_at ON runs WHEN OLD.contract_version = 4 AND NOT (
    (NEW.status = 'queued' AND NEW.started_at IS NULL AND NEW.finished_at IS NULL)
    OR (NEW.status = 'running' AND NEW.started_at IS NOT NULL AND NEW.finished_at IS NULL)
    OR (NEW.status IN ('succeeded', 'failed', 'cancelled', 'timed_out', 'trashed')
      AND NEW.finished_at IS NOT NULL)
  )
  BEGIN SELECT RAISE(ABORT, 'v4 run timestamps do not match status'); END;

  CREATE TRIGGER output_file_owner_insert_v4
  BEFORE INSERT ON output_indexes
  BEGIN
    SELECT CASE WHEN NOT EXISTS (
      SELECT 1 FROM object_files WHERE id = NEW.object_file_id AND owner_run_id = NEW.run_id AND kind = 'run_file'
    ) THEN RAISE(ABORT, 'output object ownership mismatch') END;
  END;
  CREATE TRIGGER output_v4_run_contract_insert
  BEFORE INSERT ON output_indexes
  BEGIN
    SELECT CASE WHEN NEW.contract_version != 4
      OR NEW.legacy_digest IS NOT NULL
      OR NEW.output_contract_sha256 != riff_canonical_sha256(json_object(
        'runId', NEW.run_id,
        'logicalName', NEW.logical_name,
        'outputType', NEW.output_type,
        'sampleIndex', NEW.sample_index,
        'sampleId', NEW.sample_id,
        'declaredRole', NEW.declared_role
      ))
      OR NOT EXISTS (
      SELECT 1 FROM runs
      WHERE id = NEW.run_id
        AND contract_version = 4
        AND NEW.sample_index < requested_sample_count
        AND json_extract(sample_plan_json, '$[' || NEW.sample_index || '].sampleIndex') = NEW.sample_index
        AND json_extract(sample_plan_json, '$[' || NEW.sample_index || '].sampleId') = NEW.sample_id
    ) THEN RAISE(ABORT, 'new output requires v4 run contract') END;
  END;
  CREATE TRIGGER output_legacy_read_only_v4
  BEFORE UPDATE ON output_indexes WHEN OLD.contract_version = 3
  BEGIN SELECT RAISE(ABORT, 'legacy output contract is read only'); END;
  CREATE TRIGGER output_legacy_delete_v4
  BEFORE DELETE ON output_indexes WHEN OLD.contract_version = 3
  BEGIN SELECT RAISE(ABORT, 'legacy output contract is read only'); END;
  CREATE TRIGGER output_binding_immutable_v4
  BEFORE UPDATE OF run_id, object_file_id, logical_name, output_type, contract_version, legacy_digest,
    sample_index, sample_id, declared_role, output_contract_sha256 ON output_indexes
  BEGIN SELECT RAISE(ABORT, 'output binding is immutable'); END;

  CREATE TRIGGER run_attempt_v4_owner
  BEFORE INSERT ON run_attempts
  BEGIN
    SELECT CASE WHEN NOT EXISTS (
      SELECT 1 FROM runs WHERE id = NEW.run_id AND contract_version = 4 AND status IN ('queued', 'running')
    ) THEN RAISE(ABORT, 'run attempt requires nonterminal v4 run') END;
  END;
  CREATE TRIGGER run_attempt_binding_immutable_v4
  BEFORE UPDATE OF run_id, attempt_generation, dispatcher_generation ON run_attempts
  BEGIN SELECT RAISE(ABORT, 'run attempt binding is immutable'); END;
  CREATE TRIGGER run_attempt_transition_v4
  BEFORE UPDATE OF state ON run_attempts WHEN NOT (
    (OLD.state = 'claimed' AND NEW.state IN ('starting', 'cancelled', 'interrupted'))
    OR (OLD.state = 'starting' AND NEW.state IN ('running', 'failed', 'cancelled', 'timed_out', 'interrupted'))
    OR (OLD.state = 'running' AND NEW.state IN ('succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted'))
  )
  BEGIN SELECT RAISE(ABORT, 'invalid run attempt transition'); END;

  CREATE TRIGGER process_attempt_v4_owner
  BEFORE INSERT ON process_attempts
  BEGIN
    SELECT CASE WHEN NOT EXISTS (
      SELECT 1 FROM run_attempts a
      JOIN runs r ON r.id = a.run_id
      WHERE a.id = NEW.run_attempt_id AND r.contract_version = 4
        AND NEW.process_kind = r.run_kind
        AND (NEW.process_kind = 'visual' OR (
          NEW.sample_index < r.requested_sample_count
          AND json_extract(r.sample_plan_json, '$[' || NEW.sample_index || '].sampleId') = NEW.sample_id
        ))
    ) THEN RAISE(ABORT, 'process attempt run or sample mismatch') END;
  END;
  CREATE TRIGGER process_attempt_binding_immutable_v4
  BEFORE UPDATE OF run_attempt_id, process_kind, sample_index, sample_id,
    pid, process_start_token, process_group_id ON process_attempts
  BEGIN SELECT RAISE(ABORT, 'process attempt identity is immutable'); END;
  CREATE TRIGGER process_attempt_transition_v4
  BEFORE UPDATE OF state ON process_attempts WHEN NOT (
    (OLD.state = 'blocked' AND NEW.state IN ('released', 'exited', 'cleanup_unverified'))
    OR (OLD.state = 'released' AND NEW.state IN ('running', 'exited', 'cleanup_unverified'))
    OR (OLD.state = 'running' AND NEW.state IN ('exited', 'cleanup_unverified'))
    OR (OLD.state = 'exited' AND NEW.state IN ('cleanup_complete', 'cleanup_unverified'))
  )
  BEGIN SELECT RAISE(ABORT, 'invalid process attempt transition'); END;
  CREATE TRIGGER process_launch_gate_transition_v4
  BEFORE UPDATE OF launch_gate_state ON process_attempts
  WHEN OLD.launch_gate_state != 'blocked' OR NEW.launch_gate_state NOT IN ('released', 'timed_out')
  BEGIN SELECT RAISE(ABORT, 'invalid process launch gate transition'); END;

  CREATE TRIGGER run_command_v4_owner
  BEFORE INSERT ON run_commands
  BEGIN
    SELECT CASE WHEN NOT EXISTS (
      SELECT 1 FROM runs WHERE id = NEW.run_id AND contract_version = 4
    ) THEN RAISE(ABORT, 'run command requires v4 run') END;
  END;
  CREATE TRIGGER run_command_binding_immutable_v4
  BEFORE UPDATE OF run_id, command_kind, request_key, intent_sha256 ON run_commands
  BEGIN SELECT RAISE(ABORT, 'run command identity is immutable'); END;
  CREATE TRIGGER run_command_transition_v4
  BEFORE UPDATE OF state ON run_commands
  WHEN OLD.state != 'accepted' OR NEW.state NOT IN ('committed', 'rejected')
  BEGIN SELECT RAISE(ABORT, 'invalid run command transition'); END;

  CREATE TRIGGER run_receipt_owner_v4
  BEFORE INSERT ON run_command_receipts
  BEGIN
    SELECT CASE WHEN NOT EXISTS (
      SELECT 1 FROM run_commands WHERE id = NEW.command_id AND run_id = NEW.run_id AND state = 'committed'
    ) THEN RAISE(ABORT, 'run receipt command mismatch') END;
  END;
  CREATE TRIGGER run_receipt_digest_v4
  BEFORE INSERT ON run_command_receipts
  WHEN NEW.payload_sha256 != riff_canonical_sha256(NEW.payload_json)
  BEGIN SELECT RAISE(ABORT, 'run receipt payload digest mismatch'); END;
  CREATE TRIGGER run_receipt_immutable_v4
  BEFORE UPDATE ON run_command_receipts
  BEGIN SELECT RAISE(ABORT, 'run receipt is immutable'); END;
  CREATE TRIGGER run_receipt_delete_v4
  BEFORE DELETE ON run_command_receipts
  BEGIN SELECT RAISE(ABORT, 'run receipt is immutable'); END;
`;

export const PRODUCT_SCHEMA_MIGRATIONS: readonly ProductSchemaMigration[] = Object.freeze([
  Object.freeze({ version: 1, sql: PRODUCT_SCHEMA_SQL }),
  Object.freeze({ version: 2, sql: PRODUCT_SCHEMA_V2_SQL }),
  Object.freeze({ version: 3, sql: PRODUCT_SCHEMA_V3_SQL }),
  Object.freeze({ version: 4, sql: PRODUCT_SCHEMA_V4_SQL }),
]);
