import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { canonicalDigest, parseCanonicalJsonV2 } from "../src/canonical-json-v2.ts";
import type { CreateProjectFromModelInput } from "../src/product-domain.ts";
import {
  initializeProductSchema,
  openProductDatabase,
  PRODUCT_DATABASE_PRAGMAS,
  PRODUCT_SCHEMA_MIGRATIONS,
  PRODUCT_SCHEMA_SQL,
  PRODUCT_SCHEMA_V2_SQL,
} from "../src/product-schema.ts";

const NOW = "2026-07-22T00:00:00.000Z";
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const SAMPLE_PLAN = JSON.stringify([{ sampleIndex: 0, sampleId: DIGEST_A, parameters: {}, seed: null }]);
const LIMITS = JSON.stringify({ schemaVersion: 1 });
const digest = (value: string): string => canonicalDigest(parseCanonicalJsonV2(value));
const outputContractDigest = (runId: string, logicalName: string): string => canonicalDigest({
  runId,
  logicalName,
  outputType: "table",
  sampleIndex: 0,
  sampleId: DIGEST_A,
  declaredRole: "table",
});

const PROJECT_INTENT = {
  projectId: "project_alpha",
  projectName: "Project",
  sourceModelId: "model_alpha",
  createdAt: NOW,
} satisfies CreateProjectFromModelInput;

const insertModel = (database: ReturnType<typeof openProductDatabase>, id = "model_alpha"): void => {
  database.prepare(`INSERT INTO models
    (id, name, technical_status, run_mode, execution_description_json, created_at, updated_at)
    VALUES (?, ?, 'executable', 'both', '{}', ?, ?)`
  ).run(id, "Alpha", NOW, NOW);
};

const insertProject = (database: ReturnType<typeof openProductDatabase>, id: string, modelId: string): void => {
  database.prepare(`INSERT INTO projects
    (id, name, source_model_id, model_snapshot_digest, execution_description_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, '{}', ?, ?)`
  ).run(id, "Project", modelId, DIGEST_A, NOW, NOW);
};

const insertConversation = (database: ReturnType<typeof openProductDatabase>, id: string, owner: { model?: string; project?: string }): void => {
  database.prepare(`INSERT INTO conversations
    (id, model_id, project_id, name, provider_id, provider_model_id, created_at, updated_at)
    VALUES (?, ?, ?, 'Conversation', 'provider', 'model', ?, ?)`
  ).run(id, owner.model ?? null, owner.project ?? null, NOW, NOW);
};

const insertV4Experiment = (database: DatabaseSync, id: string, projectId: string): void => {
  database.prepare(`INSERT INTO experiment_configurations
    (id, project_id, name, configuration_json, estimated_sample_count, created_at, updated_at,
      contract_version, configuration_sha256, sample_count)
    VALUES (?, ?, 'Base', '{}', 1, ?, ?, 4, ?, 1)`
  ).run(id, projectId, NOW, NOW, digest("{}"));
};

const insertV4Run = (database: DatabaseSync, id: string, projectId: string, experimentId: string): void => {
  database.prepare(`INSERT INTO runs
    (id, project_id, experiment_configuration_id, status, frozen_configuration_json,
      requested_sample_count, created_at, updated_at, contract_version, run_kind,
      execution_description_sha256, project_snapshot_sha256, frozen_configuration_sha256,
      sample_plan_json, sample_plan_sha256, limits_json, limits_sha256,
      start_receipt_sha256, completion_card_disposition)
    VALUES (?, ?, ?, 'queued', '{}', 1, ?, ?, 4, 'batch', ?, ?, ?, ?, ?, ?, ?, ?, 'not_requested')`
  ).run(id, projectId, experimentId, NOW, NOW, digest("{}"), DIGEST_A, digest("{}"),
    SAMPLE_PLAN, digest(SAMPLE_PLAN), LIMITS, digest(LIMITS), DIGEST_B);
};

const finishV4Run = (database: DatabaseSync, id: string): void => {
  database.prepare("UPDATE runs SET status = 'running', started_at = ?, updated_at = ? WHERE id = ?").run(NOW, NOW, id);
  database.prepare("UPDATE runs SET status = 'succeeded', finished_at = ?, updated_at = ? WHERE id = ?").run(NOW, NOW, id);
};

test("fresh product storage initializes with durable SQLite policy and survives restart", () => {
  const root = mkdtempSync(join(tmpdir(), "riff-product-schema-"));
  const path = join(root, "riff.sqlite3");
  try {
    const database = openProductDatabase(path);
    assert.equal((database.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys, 1);
    assert.equal((database.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode, PRODUCT_DATABASE_PRAGMAS.journalMode.toLowerCase());
    assert.equal((database.prepare("PRAGMA synchronous").get() as { synchronous: number }).synchronous, 2);
    assert.equal((database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 4);
    assert.equal((database.prepare("SELECT version FROM product_schema WHERE singleton = 1").get() as { version: number }).version, 4);
    assert.deepEqual(Object.keys(PROJECT_INTENT).sort(), ["createdAt", "projectId", "projectName", "sourceModelId"]);
    insertModel(database);
    insertProject(database, "project_alpha", "model_alpha");
    insertConversation(database, "conversation_alpha", { project: "project_alpha" });
    database.prepare(`INSERT INTO object_files
      (id, owner_conversation_id, kind, relative_path, media_type, size_bytes, sha256, created_at)
      VALUES ('file_attachment', 'conversation_alpha', 'conversation_attachment', 'input.csv', 'text/csv', 10, ?, ?)`
    ).run(DIGEST_A, NOW);
    database.prepare(`INSERT INTO attachments
      (id, conversation_id, object_file_id, original_name, purpose, created_at)
      VALUES ('attachment_alpha', 'conversation_alpha', 'file_attachment', 'input.csv', 'source data', ?)`
    ).run(NOW);
    database.prepare("UPDATE conversations SET provider_locked_at = ? WHERE id = 'conversation_alpha'").run(NOW);
    database.prepare(`INSERT INTO messages
      (id, conversation_id, ordinal, role, status, text, created_at, updated_at)
      VALUES ('message_alpha', 'conversation_alpha', 0, 'user', 'complete', 'hello', ?, ?)`
    ).run(NOW, NOW);
    database.prepare("INSERT INTO message_attachments (message_id, attachment_id) VALUES ('message_alpha', 'attachment_alpha')").run();
    database.prepare(`INSERT INTO temporary_documents
      (id, conversation_id, source_message_id, name, document_state, media_type, content, created_at, updated_at)
      VALUES ('document_alpha', 'conversation_alpha', 'message_alpha', 'Plan', 'draft', 'text/markdown', '# plan', ?, ?)`
    ).run(NOW, NOW);
    insertV4Experiment(database, "experiment_alpha", "project_alpha");
    insertV4Run(database, "run_alpha", "project_alpha", "experiment_alpha");
    finishV4Run(database, "run_alpha");
    database.prepare(`INSERT INTO object_files
      (id, owner_run_id, kind, relative_path, media_type, size_bytes, sha256, created_at)
      VALUES ('file_output', 'run_alpha', 'run_file', 'result.csv', 'text/csv', 10, ?, ?)`
    ).run(DIGEST_B, NOW);
    database.prepare(`INSERT INTO output_indexes
      (id, run_id, object_file_id, logical_name, output_type, contract_version,
        sample_index, sample_id, declared_role, output_contract_sha256, created_at)
      VALUES ('output_alpha', 'run_alpha', 'file_output', 'result.csv', 'table', 4, 0, ?, 'table', ?, ?)`
    ).run(DIGEST_A, outputContractDigest("run_alpha", "result.csv"), NOW);
    database.prepare(`INSERT INTO committed_mutations (transaction_id, manifest_sha256, committed_at)
      VALUES ('mutation_alpha', ?, ?)`
    ).run(DIGEST_A, NOW);
    database.prepare(`UPDATE temporary_documents
      SET lifecycle_state = 'trashed', pre_trash_state = 'active', trashed_at = ?, updated_at = ?
      WHERE id = 'document_alpha'`).run(NOW, NOW);
    database.prepare(`INSERT INTO trash_entries
      (id, temporary_document_id, prior_state, trashed_at)
      VALUES ('trash_document_alpha', 'document_alpha', 'active', ?)`
    ).run(NOW);
    database.close();

    const reopened = openProductDatabase(path);
    assert.deepEqual(reopened.prepare("SELECT id, source_model_id FROM projects").all().map((row) => ({ ...row })), [{ id: "project_alpha", source_model_id: "model_alpha" }]);
    for (const table of ["models", "projects", "conversations", "messages", "temporary_documents", "experiment_configurations", "runs", "object_files", "attachments", "message_attachments", "output_indexes", "trash_entries", "committed_mutations"]) {
      assert.equal((reopened.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count > 0, true, table);
    }
    for (const table of ["conversation_summaries", "agent_sessions", "agent_turns", "skill_uses", "action_records", "temporary_document_adoptions",
      "model_technical_checks", "run_attempts", "process_attempts", "run_commands", "run_command_receipts",
      "experiment_command_receipts"]) {
      assert.equal(Boolean(reopened.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)), true, table);
    }
    reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("schema migrations advance sequentially from v1 through v4 and expose Agent and execution records", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(PRODUCT_SCHEMA_SQL);
    database.exec("PRAGMA user_version = 1");
    initializeProductSchema(database);
    assert.equal((database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 4);
    assert.equal((database.prepare("SELECT version FROM product_schema WHERE singleton = 1").get() as { version: number }).version, 4);
    const columns = database.prepare("PRAGMA table_info(object_files)").all() as Array<{ name: string }>;
    assert.equal(columns.some(({ name }) => name === "adoption_purpose"), true);
    for (const table of ["agent_turns", "run_attempts", "process_attempts", "run_commands", "run_command_receipts",
      "experiment_command_receipts"]) {
      assert.equal(Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)), true, table);
    }
  } finally {
    database.close();
  }
});

test("ordered v2 through v4 migration locks legacy providers and preserves execution migration atomicity", () => {
  const legacy = new DatabaseSync(":memory:");
  try {
    legacy.exec(PRODUCT_SCHEMA_SQL);
    legacy.exec(PRODUCT_SCHEMA_V2_SQL);
    legacy.prepare("UPDATE product_schema SET version = 2 WHERE singleton = 1").run();
    legacy.exec("PRAGMA user_version = 2");
    insertModel(legacy);
    insertConversation(legacy, "conversation_legacy", { model: "model_alpha" });
    legacy.prepare(`INSERT INTO messages (id, conversation_id, ordinal, role, status, text, created_at, updated_at)
      VALUES ('message_legacy', 'conversation_legacy', 0, 'user', 'complete', 'hello', ?, ?)`).run(NOW, NOW);
    initializeProductSchema(legacy);
    assert.equal((legacy.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 4);
    assert.equal((legacy.prepare("SELECT provider_locked_at FROM conversations WHERE id = 'conversation_legacy'").get() as { provider_locked_at: string }).provider_locked_at, NOW);
  } finally { legacy.close(); }

  const root = mkdtempSync(join(tmpdir(), "riff-product-v3-invalid-"));
  const path = join(root, "riff.sqlite3");
  try {
    const invalid = new DatabaseSync(path);
    invalid.exec(PRODUCT_SCHEMA_SQL);
    invalid.exec(PRODUCT_SCHEMA_V2_SQL);
    invalid.prepare("UPDATE product_schema SET version = 2 WHERE singleton = 1").run();
    invalid.exec("PRAGMA user_version = 2");
    insertModel(invalid);
    insertConversation(invalid, "conversation_invalid", { model: "model_alpha" });
    invalid.prepare("UPDATE conversations SET provider_locked_at = ? WHERE id = 'conversation_invalid'").run(NOW);
    invalid.close();
    for (let attempt = 0; attempt < 2; attempt += 1) assert.throws(() => openProductDatabase(path), /CHECK constraint failed: valid = 1/u);
    const inspected = new DatabaseSync(path);
    assert.equal((inspected.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 2);
    assert.equal((inspected.prepare("SELECT version FROM product_schema WHERE singleton = 1").get() as { version: number }).version, 2);
    assert.equal(Boolean(inspected.prepare("SELECT 1 FROM sqlite_master WHERE name = 'agent_turns'").get()), false);
    assert.equal((inspected.prepare("SELECT provider_locked_at FROM conversations WHERE id = 'conversation_invalid'").get() as { provider_locked_at: string }).provider_locked_at, NOW);
    inspected.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("v2 migration rejects legacy integrity violations without rewriting v1 data", () => {
  const cases: Array<{ name: string; arrange: (database: DatabaseSync) => string }> = [
    {
      name: "model-owned project snapshot",
      arrange(database) {
        insertModel(database);
        database.prepare(`INSERT INTO object_files
          (id, owner_model_id, kind, relative_path, media_type, size_bytes, sha256, created_at)
          VALUES ('legacy_bad_snapshot', 'model_alpha', 'project_model_snapshot', 'model.py', 'text/x-python', 1, ?, ?)`
        ).run(DIGEST_A, NOW);
        return "legacy_bad_snapshot";
      },
    },
    {
      name: "adopted attachment without source or purpose",
      arrange(database) {
        insertModel(database);
        database.prepare(`INSERT INTO object_files
          (id, owner_model_id, kind, relative_path, media_type, size_bytes, sha256, created_at)
          VALUES ('legacy_bad_adoption', 'model_alpha', 'adopted_attachment', 'input.csv', 'text/csv', 1, ?, ?)`
        ).run(DIGEST_A, NOW);
        return "legacy_bad_adoption";
      },
    },
    {
      name: "adopted attachment with a cross-owner source",
      arrange(database) {
        insertModel(database, "model_a");
        insertModel(database, "model_b");
        insertConversation(database, "conversation_a", { model: "model_a" });
        database.prepare(`INSERT INTO object_files
          (id, owner_conversation_id, kind, relative_path, media_type, size_bytes, sha256, created_at)
          VALUES ('legacy_source_file', 'conversation_a', 'conversation_attachment', 'input.csv', 'text/csv', 1, ?, ?)`
        ).run(DIGEST_A, NOW);
        database.prepare(`INSERT INTO attachments
          (id, conversation_id, object_file_id, original_name, created_at)
          VALUES ('legacy_source', 'conversation_a', 'legacy_source_file', 'input.csv', ?)`
        ).run(NOW);
        database.prepare(`INSERT INTO object_files
          (id, owner_model_id, kind, relative_path, media_type, size_bytes, sha256, source_attachment_id, created_at)
          VALUES ('legacy_cross_adoption', 'model_b', 'adopted_attachment', 'input.csv', 'text/csv', 1, ?, 'legacy_source', ?)`
        ).run(DIGEST_A, NOW);
        return "legacy_cross_adoption";
      },
    },
    {
      name: "trashed active pre-state retaining archived timestamp",
      arrange(database) {
        insertModel(database);
        database.prepare(`UPDATE models SET lifecycle_state = 'trashed', pre_trash_state = 'active', archived_at = ?, trashed_at = ?
          WHERE id = 'model_alpha'`).run(NOW, NOW);
        return "model_alpha";
      },
    },
  ];

  for (const fixture of cases) {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(PRODUCT_SCHEMA_SQL);
      database.exec("PRAGMA user_version = 1");
      const preservedId = fixture.arrange(database);
      assert.throws(() => initializeProductSchema(database), /CHECK constraint failed: valid = 1/u, fixture.name);
      assert.equal((database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 1, fixture.name);
      assert.equal((database.prepare("SELECT version FROM product_schema WHERE singleton = 1").get() as { version: number }).version, 1, fixture.name);
      assert.equal((database.prepare("SELECT count(*) AS count FROM object_files WHERE id = ?").get(preservedId) as { count: number }).count
        + (database.prepare("SELECT count(*) AS count FROM models WHERE id = ?").get(preservedId) as { count: number }).count, 1, fixture.name);
      assert.equal((database.prepare("PRAGMA table_info(object_files)").all() as Array<{ name: string }>).some(({ name }) => name === "adoption_purpose"), false, fixture.name);
    } finally {
      database.close();
    }
  }
});

test("v2 migration repeatedly rejects a file-backed v1 foreign-key orphan without partial upgrade", () => {
  const root = mkdtempSync(join(tmpdir(), "riff-product-orphan-"));
  const path = join(root, "riff.sqlite3");
  try {
    const legacy = new DatabaseSync(path);
    legacy.exec("PRAGMA foreign_keys = OFF");
    legacy.exec(PRODUCT_SCHEMA_SQL);
    legacy.exec("PRAGMA user_version = 1");
    legacy.prepare(`INSERT INTO object_files
      (id, owner_model_id, kind, relative_path, media_type, size_bytes, sha256, created_at)
      VALUES ('orphan_file', 'missing_model', 'model_code', 'model.py', 'text/x-python', 1, ?, ?)`
    ).run(DIGEST_A, NOW);
    legacy.close();

    assert.throws(() => openProductDatabase(path), /migration 2 found a foreign-key violation/u);

    const inspected = new DatabaseSync(path);
    assert.equal((inspected.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 1);
    assert.equal((inspected.prepare("SELECT version FROM product_schema WHERE singleton = 1").get() as { version: number }).version, 1);
    assert.equal((inspected.prepare("PRAGMA table_info(object_files)").all() as Array<{ name: string }>).some(({ name }) => name === "adoption_purpose"), false);
    assert.equal((inspected.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name LIKE '%_v2_%'").get() as { count: number }).count, 0);
    assert.deepEqual({ ...inspected.prepare("SELECT id, owner_model_id FROM object_files WHERE id = 'orphan_file'").get() }, {
      id: "orphan_file",
      owner_model_id: "missing_model",
    });
    inspected.close();

    assert.throws(() => openProductDatabase(path), /migration 2 found a foreign-key violation/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("schema version drift and failed migrations fail closed with transactional rollback", () => {
  const drifted = new DatabaseSync(":memory:");
  try {
    drifted.exec("CREATE TABLE product_schema (singleton INTEGER PRIMARY KEY, version INTEGER NOT NULL); INSERT INTO product_schema VALUES (1, 1)");
    assert.throws(() => initializeProductSchema(drifted), /Product schema version drift/u);
    assert.equal((drifted.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 0);
  } finally {
    drifted.close();
  }

  const failed = new DatabaseSync(":memory:");
  try {
    assert.throws(() => initializeProductSchema(failed, [
      PRODUCT_SCHEMA_MIGRATIONS[0],
      { version: 2, sql: "CREATE TABLE migration_sentinel (id INTEGER); INSERT INTO missing_table VALUES (1);" },
      PRODUCT_SCHEMA_MIGRATIONS[2],
      PRODUCT_SCHEMA_MIGRATIONS[3],
    ]), /missing_table/u);
    assert.equal(Boolean(failed.prepare("SELECT 1 FROM sqlite_master WHERE name = 'product_schema'").get()), false);
    assert.equal(Boolean(failed.prepare("SELECT 1 FROM sqlite_master WHERE name = 'migration_sentinel'").get()), false);
    assert.equal((failed.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 0);
  } finally {
    failed.close();
  }
});

test("owner, lifecycle, path, digest and cross-project constraints fail closed", () => {
  const database = openProductDatabase(":memory:");
  try {
    insertModel(database, "model_one");
    insertModel(database, "model_two");
    insertProject(database, "project_one", "model_one");
    insertProject(database, "project_two", "model_two");

    assert.throws(() => insertConversation(database, "conversation_none", {}), /CHECK constraint failed/u);
    assert.throws(() => insertConversation(database, "conversation_two", { model: "model_one", project: "project_one" }), /CHECK constraint failed/u);
    insertConversation(database, "conversation_one", { project: "project_one" });
    insertConversation(database, "conversation_other", { project: "project_two" });

    assert.throws(() => database.prepare(`INSERT INTO object_files
      (id, owner_model_id, owner_project_id, kind, relative_path, media_type, size_bytes, sha256, created_at)
      VALUES ('file_two_owners', 'model_one', 'project_one', 'model_code', 'model.py', 'text/x-python', 1, ?, ?)`
    ).run(DIGEST_A, NOW), /CHECK constraint failed/u);

    assert.throws(() => database.prepare(`INSERT INTO object_files
      (id, owner_model_id, kind, relative_path, media_type, size_bytes, sha256, created_at)
      VALUES ('file_escape', 'model_one', 'model_code', '../secret', 'text/plain', 1, ?, ?)`
    ).run(DIGEST_A, NOW), /CHECK constraint failed/u);

    for (const [id, path] of [["file_dot", "code/./model.py"], ["file_nul", "code/\0model.py"]] as const) {
      assert.throws(() => database.prepare(`INSERT INTO object_files
        (id, owner_model_id, kind, relative_path, media_type, size_bytes, sha256, created_at)
        VALUES (?, 'model_one', 'model_code', ?, 'text/plain', 1, ?, ?)`
      ).run(id, path, DIGEST_A, NOW), /CHECK constraint failed/u);
    }

    assert.throws(() => database.prepare(`INSERT INTO object_files
      (id, owner_model_id, kind, relative_path, media_type, size_bytes, sha256, created_at)
      VALUES ('file_bad_digest', 'model_one', 'model_code', 'code.py', 'text/plain', 1, ?, ?)`
    ).run("A".repeat(64), NOW), /CHECK constraint failed/u);

    insertV4Experiment(database, "experiment_one", "project_one");
    database.prepare(`INSERT INTO temporary_documents
      (id, conversation_id, name, document_state, media_type, content, created_at, updated_at)
      VALUES ('document_one', 'conversation_one', 'Plan', 'draft', 'text/markdown', '# plan', ?, ?)`
    ).run(NOW, NOW);
    assert.throws(() => insertV4Run(database, "run_wrong_project", "project_two", "experiment_one"), /FOREIGN KEY constraint failed/u);

    assert.throws(() => database.prepare(`UPDATE models SET lifecycle_state = 'trashed', trashed_at = ? WHERE id = 'model_one'`).run(NOW), /CHECK constraint failed/u);

    for (const [table, id] of [
      ["models", "model_one"],
      ["projects", "project_one"],
      ["conversations", "conversation_one"],
      ["temporary_documents", "document_one"],
      ["experiment_configurations", "experiment_one"],
    ] as const) {
      assert.throws(() => database.prepare(`UPDATE ${table}
        SET lifecycle_state = 'trashed', pre_trash_state = 'active', archived_at = ?, trashed_at = ? WHERE id = ?`
      ).run(NOW, NOW, id), /lifecycle timestamp and pre-trash state mismatch/u, `${table}: active pre-state cannot retain archived_at`);
      assert.throws(() => database.prepare(`UPDATE ${table}
        SET lifecycle_state = 'trashed', pre_trash_state = 'archived', archived_at = NULL, trashed_at = ? WHERE id = ?`
      ).run(NOW, id), /lifecycle timestamp and pre-trash state mismatch/u, `${table}: archived pre-state requires archived_at`);
    }

    assert.throws(() => database.prepare(`INSERT INTO object_files
      (id, owner_model_id, kind, relative_path, media_type, size_bytes, sha256, created_at)
      VALUES ('snapshot_wrong_owner', 'model_one', 'project_model_snapshot', 'snapshot/model.py', 'text/x-python', 1, ?, ?)`
    ).run(DIGEST_A, NOW), /object file kind ownership or adoption metadata mismatch/u);
  } finally {
    database.close();
  }
});

test("attachment, message, document and output links cannot cross ownership boundaries", () => {
  const database = openProductDatabase(":memory:");
  try {
    insertModel(database);
    insertProject(database, "project_alpha", "model_alpha");
    insertConversation(database, "conversation_a", { project: "project_alpha" });
    insertConversation(database, "conversation_b", { project: "project_alpha" });

    database.prepare(`INSERT INTO object_files
      (id, owner_conversation_id, kind, relative_path, media_type, size_bytes, sha256, created_at)
      VALUES ('file_attachment', 'conversation_a', 'conversation_attachment', 'input.csv', 'text/csv', 10, ?, ?)`
    ).run(DIGEST_A, NOW);
    assert.throws(() => database.prepare(`INSERT INTO attachments
      (id, conversation_id, object_file_id, original_name, created_at)
      VALUES ('attachment_wrong', 'conversation_b', 'file_attachment', 'input.csv', ?)`
    ).run(NOW), /attachment object ownership mismatch/u);
    database.prepare(`INSERT INTO attachments
      (id, conversation_id, object_file_id, original_name, created_at)
      VALUES ('attachment_a', 'conversation_a', 'file_attachment', 'input.csv', ?)`
    ).run(NOW);

    database.prepare("UPDATE conversations SET provider_locked_at = ? WHERE id IN ('conversation_a', 'conversation_b')").run(NOW);
    database.prepare(`INSERT INTO messages
      (id, conversation_id, ordinal, role, status, text, created_at, updated_at)
      VALUES ('message_b', 'conversation_b', 0, 'user', 'complete', 'hello', ?, ?)`
    ).run(NOW, NOW);
    assert.throws(() => database.prepare(`INSERT INTO message_attachments (message_id, attachment_id)
      VALUES ('message_b', 'attachment_a')`).run(), /message attachment conversation mismatch/u);
    assert.throws(() => database.prepare(`INSERT INTO temporary_documents
      (id, conversation_id, source_message_id, name, document_state, media_type, content, created_at, updated_at)
      VALUES ('document_crossed', 'conversation_a', 'message_b', 'Plan', 'draft', 'text/markdown', '# plan', ?, ?)`
    ).run(NOW, NOW), /document source message conversation mismatch/u);

    insertV4Experiment(database, "experiment_a", "project_alpha");
    insertV4Run(database, "run_a", "project_alpha", "experiment_a");
    finishV4Run(database, "run_a");
    database.prepare(`INSERT INTO object_files
      (id, owner_project_id, kind, relative_path, media_type, size_bytes, sha256, created_at)
      VALUES ('file_not_run', 'project_alpha', 'project_model_snapshot', 'result.csv', 'text/csv', 10, ?, ?)`
    ).run(DIGEST_A, NOW);
    assert.throws(() => database.prepare(`INSERT INTO output_indexes
      (id, run_id, object_file_id, logical_name, output_type, contract_version,
        sample_index, sample_id, declared_role, output_contract_sha256, created_at)
      VALUES ('output_wrong', 'run_a', 'file_not_run', 'result.csv', 'table', 4, 0, ?, 'table', ?, ?)`
    ).run(DIGEST_A, outputContractDigest("run_a", "result.csv"), NOW), /output object ownership mismatch/u);
  } finally {
    database.close();
  }
});

test("adopted attachments require source, purpose, and the source conversation owner", () => {
  const database = openProductDatabase(":memory:");
  try {
    insertModel(database, "model_a");
    insertModel(database, "model_b");
    insertProject(database, "project_a", "model_a");
    insertProject(database, "project_b", "model_b");
    insertConversation(database, "conversation_a", { project: "project_a" });
    database.prepare(`INSERT INTO object_files
      (id, owner_conversation_id, kind, relative_path, media_type, size_bytes, sha256, created_at)
      VALUES ('source_file', 'conversation_a', 'conversation_attachment', 'source.csv', 'text/csv', 10, ?, ?)`
    ).run(DIGEST_A, NOW);
    database.prepare(`INSERT INTO attachments
      (id, conversation_id, object_file_id, original_name, created_at)
      VALUES ('source_attachment', 'conversation_a', 'source_file', 'source.csv', ?)`
    ).run(NOW);

    assert.throws(() => database.prepare(`INSERT INTO object_files
      (id, owner_project_id, kind, relative_path, media_type, size_bytes, sha256, adoption_purpose, created_at)
      VALUES ('adopted_no_source', 'project_a', 'adopted_attachment', 'attachments/no-source.csv', 'text/csv', 10, ?, 'calibration input', ?)`
    ).run(DIGEST_A, NOW), /object file kind ownership or adoption metadata mismatch/u);
    assert.throws(() => database.prepare(`INSERT INTO object_files
      (id, owner_project_id, kind, relative_path, media_type, size_bytes, sha256, source_attachment_id, created_at)
      VALUES ('adopted_no_purpose', 'project_a', 'adopted_attachment', 'attachments/no-purpose.csv', 'text/csv', 10, ?, 'source_attachment', ?)`
    ).run(DIGEST_A, NOW), /object file kind ownership or adoption metadata mismatch/u);
    assert.throws(() => database.prepare(`INSERT INTO object_files
      (id, owner_project_id, kind, relative_path, media_type, size_bytes, sha256, source_attachment_id, adoption_purpose, created_at)
      VALUES ('adopted_cross_owner', 'project_b', 'adopted_attachment', 'attachments/cross.csv', 'text/csv', 10, ?, 'source_attachment', 'calibration input', ?)`
    ).run(DIGEST_A, NOW), /adopted attachment owner does not match source conversation owner/u);

    database.prepare(`INSERT INTO object_files
      (id, owner_project_id, kind, relative_path, media_type, size_bytes, sha256, source_attachment_id, adoption_purpose, created_at)
      VALUES ('adopted_valid', 'project_a', 'adopted_attachment', 'attachments/source.csv', 'text/csv', 10, ?, 'source_attachment', 'calibration input', ?)`
    ).run(DIGEST_A, NOW);
    assert.deepEqual({ ...database.prepare("SELECT source_attachment_id, adoption_purpose FROM object_files WHERE id = 'adopted_valid'").get() }, {
      source_attachment_id: "source_attachment",
      adoption_purpose: "calibration input",
    });
  } finally {
    database.close();
  }
});

test("project snapshot file metadata remains independent of later source-model edits", () => {
  const database = openProductDatabase(":memory:");
  try {
    insertModel(database);
    insertProject(database, "project_alpha", "model_alpha");
    database.prepare(`INSERT INTO object_files
      (id, owner_model_id, kind, relative_path, media_type, size_bytes, sha256, created_at)
      VALUES ('file_model', 'model_alpha', 'model_code', 'model.py', 'text/x-python', 10, ?, ?)`
    ).run(DIGEST_A, NOW);
    database.prepare(`INSERT INTO object_files
      (id, owner_project_id, kind, relative_path, media_type, size_bytes, sha256, created_at)
      VALUES ('file_snapshot', 'project_alpha', 'project_model_snapshot', 'model.py', 'text/x-python', 10, ?, ?)`
    ).run(DIGEST_A, NOW);

    assert.throws(() => database.prepare(
      "UPDATE projects SET model_snapshot_digest = ? WHERE id = 'project_alpha'",
    ).run(DIGEST_B), /project frozen copy is immutable/u);
    assert.throws(() => database.prepare(
      "UPDATE projects SET execution_description_json = '{}' WHERE id = 'project_alpha'",
    ).run(), /project frozen copy is immutable/u);
    for (const statement of [
      "UPDATE object_files SET relative_path = 'changed.py' WHERE id = 'file_snapshot'",
      "UPDATE object_files SET media_type = 'application/octet-stream' WHERE id = 'file_snapshot'",
      "UPDATE object_files SET size_bytes = 11 WHERE id = 'file_snapshot'",
      `UPDATE object_files SET sha256 = '${DIGEST_B}' WHERE id = 'file_snapshot'`,
      "UPDATE object_files SET created_at = '2026-07-24T01:00:00.000Z' WHERE id = 'file_snapshot'",
    ]) {
      assert.throws(() => database.prepare(statement).run(), /project snapshot metadata is immutable/u);
    }

    database.prepare("UPDATE object_files SET sha256 = ?, size_bytes = 11 WHERE id = 'file_model'").run(DIGEST_B);
    assert.deepEqual({ ...database.prepare("SELECT sha256, size_bytes FROM object_files WHERE id = 'file_snapshot'").get() }, { sha256: DIGEST_A, size_bytes: 10 });
  } finally {
    database.close();
  }
});
