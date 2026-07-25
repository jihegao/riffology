import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { canonicalDigest, canonicalJsonV2 } from "../src/canonical-json-v2.ts";
import { PRODUCT_SCHEMA_VERSION } from "../src/product-domain.ts";
import {
  configureProductDatabase,
  initializeProductSchema,
  PRODUCT_SCHEMA_MIGRATIONS,
  PRODUCT_SCHEMA_V9_SQL,
  withAtomicBatchSuccessRunContext,
} from "../src/product-schema.ts";

const NOW = "2026-07-25T14:00:00.000Z";
const FINISHED_AT = "2026-07-25T14:00:01.000Z";
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const SAMPLE_ID = "c".repeat(64);
const json = (value: unknown): string => canonicalJsonV2(value).toString("utf8");
const SAMPLE_PLAN = [{
  sampleIndex: 0,
  sampleId: SAMPLE_ID,
  parameters: {},
  seed: null,
}];
const LIMITS = {
  schemaVersion: 1,
  wallTimeMs: 60_000,
  startupTimeMs: 10_000,
  terminationGraceMs: 1_000,
  maxStdoutBytes: 10_000,
  maxStderrBytes: 10_000,
  maxOutputFiles: 10,
  maxOutputBytes: 100_000,
  maxEventCount: 10,
  maxEventBytes: 10_000,
  maxSamples: 1,
  maxConcurrency: 1,
};

const installVersion = (database: DatabaseSync, version: number): void => {
  configureProductDatabase(database);
  for (const migration of PRODUCT_SCHEMA_MIGRATIONS.slice(0, version)) {
    database.exec(migration.sql);
  }
  database.prepare("UPDATE product_schema SET version = ? WHERE singleton = 1").run(version);
  database.exec(`PRAGMA user_version = ${version}`);
};

const insertRunFixture = (
  database: DatabaseSync,
  suffix: string,
  runKind: "batch" | "visual",
  completionConversationId: string | null = null,
  completionDisposition: "not_requested" | "pending" | null = completionConversationId === null
    ? "not_requested"
    : "pending",
): Readonly<{ projectId: string; runId: string }> => {
  const modelId = `model_${suffix}`;
  const projectId = `project_${suffix}`;
  const experimentId = `experiment_${suffix}`;
  const runId = `run_${suffix}`;
  const execution = {};
  const configuration = {
    schemaVersion: 1,
    runKind,
    parameters: {},
    sampling: { kind: "single" },
  };
  database.prepare(`INSERT INTO models
    (id, name, technical_status, run_mode, execution_description_json, created_at, updated_at)
    VALUES (?, 'Model', 'executable', ?, ?, ?, ?)`
  ).run(modelId, runKind, json(execution), NOW, NOW);
  database.prepare(`INSERT INTO projects
    (id, name, source_model_id, model_snapshot_digest, execution_description_json,
      created_at, updated_at)
    VALUES (?, 'Project', ?, ?, ?, ?, ?)`
  ).run(projectId, modelId, DIGEST_B, json(execution), NOW, NOW);
  database.prepare(`INSERT INTO experiment_configurations
    (id, project_id, name, configuration_json, estimated_sample_count,
      created_at, updated_at, contract_version, configuration_sha256, sample_count)
    VALUES (?, ?, 'Experiment', ?, 1, ?, ?, 4, ?, 1)`
  ).run(
    experimentId,
    projectId,
    json(configuration),
    NOW,
    NOW,
    canonicalDigest(configuration),
  );
  if (completionConversationId !== null) {
    database.prepare(`INSERT INTO conversations
      (id, project_id, name, provider_id, provider_model_id,
        created_at, updated_at)
      VALUES (?, ?, 'Completion', 'provider', 'model', ?, ?)`
    ).run(completionConversationId, projectId, NOW, NOW);
  }
  database.prepare(`INSERT INTO runs
    (id, project_id, experiment_configuration_id, status, frozen_configuration_json,
      requested_sample_count, created_at, updated_at, contract_version, run_kind,
      completion_conversation_id, execution_description_sha256, project_snapshot_sha256,
      frozen_configuration_sha256, sample_plan_json, sample_plan_sha256, limits_json,
      limits_sha256, start_receipt_sha256, completion_card_disposition)
    VALUES (?, ?, ?, 'queued', ?, 1, ?, ?, 4, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?)`
  ).run(
    runId,
    projectId,
    experimentId,
    json(configuration),
    NOW,
    NOW,
    runKind,
    completionConversationId,
    canonicalDigest(execution),
    DIGEST_B,
    canonicalDigest(configuration),
    json(SAMPLE_PLAN),
    canonicalDigest(SAMPLE_PLAN),
    json(LIMITS),
    canonicalDigest(LIMITS),
    DIGEST_A,
    completionDisposition,
  );
  return { projectId, runId };
};

test("schema v9 migrates a real v8 database, preserves batch success/output semantics, and passes quick_check", () => {
  const database = new DatabaseSync(":memory:");
  try {
    installVersion(database, 8);
    const batch = insertRunFixture(database, "v8_batch_sentinel", "batch");
    const before = database.prepare("SELECT * FROM runs WHERE id = ?").get(batch.runId);

    initializeProductSchema(database);

    assert.equal(
      (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
      PRODUCT_SCHEMA_VERSION,
    );
    assert.equal(
      (database.prepare("SELECT version FROM product_schema WHERE singleton = 1").get() as {
        version: number;
      }).version,
      PRODUCT_SCHEMA_VERSION,
    );
    assert.deepEqual(database.prepare("SELECT * FROM runs WHERE id = ?").get(batch.runId), before);
    assert.equal(Boolean(database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'run_success_atomic_context_v9'",
    ).get()), true);
    assert.equal(Boolean(database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'run_success_atomic_context_v4'",
    ).get()), false);

    database.prepare(
      "UPDATE runs SET status = 'running', started_at = ?, updated_at = ? WHERE id = ?",
    ).run(NOW, NOW, batch.runId);
    withAtomicBatchSuccessRunContext(database, batch.runId, () => {
      database.prepare(`UPDATE runs
        SET status = 'succeeded', terminal_code = 'run_succeeded',
          terminal_diagnostics_json = '{}', resource_overview_json = '{}',
          finished_at = ?, updated_at = ?
        WHERE id = ?`
      ).run(FINISHED_AT, FINISHED_AT, batch.runId);
      database.prepare(`INSERT INTO object_files
        (id, owner_run_id, kind, relative_path, media_type, size_bytes, sha256, created_at)
        VALUES ('file_v9_batch', ?, 'run_file', 'outputs/0/result.json',
          'application/json', 2, ?, ?)`
      ).run(batch.runId, DIGEST_A, FINISHED_AT);
      const contract = {
        runId: batch.runId,
        logicalName: "result",
        outputType: "data",
        sampleIndex: 0,
        sampleId: SAMPLE_ID,
        declaredRole: "data",
      };
      database.prepare(`INSERT INTO output_indexes
        (id, run_id, object_file_id, logical_name, output_type, contract_version,
          sample_index, sample_id, declared_role, output_contract_sha256, created_at)
        VALUES ('output_v9_batch', ?, 'file_v9_batch', 'result', 'data', 4,
          0, ?, 'data', ?, ?)`
      ).run(batch.runId, SAMPLE_ID, canonicalDigest(contract), FINISHED_AT);
    });
    assert.equal((database.prepare(
      "SELECT count(*) AS count FROM output_indexes WHERE run_id = ?",
    ).get(batch.runId) as { count: number }).count, 1);
    assert.equal(
      (database.prepare("PRAGMA quick_check").get() as { quick_check: string }).quick_check,
      "ok",
    );
  } finally {
    database.close();
  }
});

test("schema v9 migration failure restores v8 triggers and both version markers", () => {
  const database = new DatabaseSync(":memory:");
  try {
    installVersion(database, 8);
    const broken = [
      ...PRODUCT_SCHEMA_MIGRATIONS.slice(0, 8),
      {
        version: 9,
        sql: `${PRODUCT_SCHEMA_V9_SQL}\nSELECT * FROM missing_v9_guard;`,
      },
      PRODUCT_SCHEMA_MIGRATIONS[9],
      PRODUCT_SCHEMA_MIGRATIONS[10],
    ];
    assert.throws(() => initializeProductSchema(database, broken), /missing_v9_guard/u);
    assert.equal(
      (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
      8,
    );
    assert.equal(
      (database.prepare("SELECT version FROM product_schema WHERE singleton = 1").get() as {
        version: number;
      }).version,
      8,
    );
    assert.equal(Boolean(database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'run_success_atomic_context_v4'",
    ).get()), true);
    assert.equal(Boolean(database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'run_success_atomic_context_v9'",
    ).get()), false);
  } finally {
    database.close();
  }
});

test("schema v9 rejects a v8 visual NULL completion disposition and rolls migration back", () => {
  const database = new DatabaseSync(":memory:");
  try {
    installVersion(database, 8);
    const visual = insertRunFixture(database, "v8_null_disposition", "visual");
    database.prepare(
      "UPDATE runs SET completion_card_disposition = NULL WHERE id = ?",
    ).run(visual.runId);
    assert.equal((database.prepare(
      "SELECT completion_card_disposition FROM runs WHERE id = ?",
    ).get(visual.runId) as { completion_card_disposition: null }).completion_card_disposition, null);

    assert.throws(
      () => initializeProductSchema(database),
      /CHECK constraint failed: valid = 1/u,
    );
    assert.equal(
      (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
      8,
    );
    assert.equal(
      (database.prepare("SELECT version FROM product_schema WHERE singleton = 1").get() as {
        version: number;
      }).version,
      8,
    );
    assert.equal(Boolean(database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'run_success_atomic_context_v4'",
    ).get()), true);
    assert.equal(Boolean(database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'run_success_atomic_context_v9'",
    ).get()), false);
  } finally {
    database.close();
  }
});

test("schema v9 rejects visual completion conversations and dispositions at SQL insertion", () => {
  const database = new DatabaseSync(":memory:");
  try {
    initializeProductSchema(database);
    assert.throws(
      () => insertRunFixture(
        database,
        "visual_completion",
        "visual",
        "conversation_visual_completion",
      ),
      /visual runs cannot request completion cards/u,
    );
    assert.throws(
      () => insertRunFixture(
        database,
        "visual_disposition",
        "visual",
        null,
        "pending",
      ),
      /visual runs cannot request completion cards/u,
    );
    assert.throws(
      () => insertRunFixture(
        database,
        "visual_null_disposition",
        "visual",
        null,
        null,
      ),
      /visual runs cannot request completion cards/u,
    );
    const valid = insertRunFixture(database, "visual_update_null", "visual");
    assert.throws(
      () => database.prepare(
        "UPDATE runs SET completion_card_disposition = NULL WHERE id = ?",
      ).run(valid.runId),
      /visual runs cannot request completion cards/u,
    );
    assert.equal((database.prepare(
      "SELECT completion_card_disposition FROM runs WHERE id = ?",
    ).get(valid.runId) as { completion_card_disposition: string }).completion_card_disposition,
    "not_requested");
    assert.equal((database.prepare(
      "SELECT count(*) AS count FROM runs WHERE run_kind = 'visual'",
    ).get() as { count: number }).count, 1);
  } finally {
    database.close();
  }
});
