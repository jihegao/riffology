import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PermanentDeletePreview } from "../src/product-domain.ts";
import { openProductDatabase, PRODUCT_DATABASE_PRAGMAS } from "../src/product-schema.ts";

const NOW = "2026-07-22T00:00:00.000Z";
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

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

test("fresh product storage initializes with durable SQLite policy and survives restart", () => {
  const root = mkdtempSync(join(tmpdir(), "riff-product-schema-"));
  const path = join(root, "riff.sqlite3");
  try {
    const database = openProductDatabase(path);
    assert.equal((database.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys, 1);
    assert.equal((database.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode, PRODUCT_DATABASE_PRAGMAS.journalMode.toLowerCase());
    assert.equal((database.prepare("PRAGMA synchronous").get() as { synchronous: number }).synchronous, 2);
    assert.equal((database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 1);
    assert.equal((database.prepare("SELECT version FROM product_schema WHERE singleton = 1").get() as { version: number }).version, 1);
    insertModel(database);
    insertProject(database, "project_alpha", "model_alpha");
    database.close();

    const reopened = openProductDatabase(path);
    assert.deepEqual(reopened.prepare("SELECT id, source_model_id FROM projects").all().map((row) => ({ ...row })), [{ id: "project_alpha", source_model_id: "model_alpha" }]);
    reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
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

    database.prepare(`INSERT INTO experiment_configurations
      (id, project_id, name, configuration_json, estimated_sample_count, created_at, updated_at)
      VALUES ('experiment_one', 'project_one', 'Base', '{}', 1, ?, ?)`
    ).run(NOW, NOW);
    assert.throws(() => database.prepare(`INSERT INTO runs
      (id, project_id, experiment_configuration_id, status, frozen_configuration_json, requested_sample_count, created_at, updated_at)
      VALUES ('run_wrong_project', 'project_two', 'experiment_one', 'configured', '{}', 1, ?, ?)`
    ).run(NOW, NOW), /FOREIGN KEY constraint failed/u);

    assert.throws(() => database.prepare(`UPDATE models SET lifecycle_state = 'trashed', trashed_at = ? WHERE id = 'model_one'`).run(NOW), /CHECK constraint failed/u);
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

    database.prepare(`INSERT INTO experiment_configurations
      (id, project_id, name, configuration_json, estimated_sample_count, created_at, updated_at)
      VALUES ('experiment_a', 'project_alpha', 'Base', '{}', 1, ?, ?)`
    ).run(NOW, NOW);
    database.prepare(`INSERT INTO runs
      (id, project_id, experiment_configuration_id, status, frozen_configuration_json, requested_sample_count, created_at, updated_at)
      VALUES ('run_a', 'project_alpha', 'experiment_a', 'succeeded', '{}', 1, ?, ?)`
    ).run(NOW, NOW);
    database.prepare(`INSERT INTO object_files
      (id, owner_project_id, kind, relative_path, media_type, size_bytes, sha256, created_at)
      VALUES ('file_not_run', 'project_alpha', 'adopted_attachment', 'result.csv', 'text/csv', 10, ?, ?)`
    ).run(DIGEST_A, NOW);
    assert.throws(() => database.prepare(`INSERT INTO output_indexes
      (id, run_id, object_file_id, logical_name, output_type, created_at)
      VALUES ('output_wrong', 'run_a', 'file_not_run', 'result.csv', 'table', ?)`
    ).run(NOW), /output object ownership mismatch/u);
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

    database.prepare("UPDATE object_files SET sha256 = ?, size_bytes = 11 WHERE id = 'file_model'").run(DIGEST_B);
    assert.deepEqual({ ...database.prepare("SELECT sha256, size_bytes FROM object_files WHERE id = 'file_snapshot'").get() }, { sha256: DIGEST_A, size_bytes: 10 });
  } finally {
    database.close();
  }
});

test("permanent-delete previews carry deterministic content and stale-state tokens", () => {
  const preview = {
    target: { kind: "model", id: "model_alpha" },
    records: [{ table: "models", id: "model_alpha" }],
    files: [],
    totalBytes: 0,
    blockingReferences: [],
    previewToken: DIGEST_A,
    stateToken: DIGEST_B,
  } satisfies PermanentDeletePreview;

  assert.equal(preview.previewToken.length, 64);
  assert.equal(preview.stateToken.length, 64);
  assert.notEqual(preview.previewToken, preview.stateToken);
});
