import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { canonicalDigest, canonicalJsonV2 } from "../src/canonical-json-v2.ts";
import {
  configureProductDatabase,
  initializeProductSchema,
  PRODUCT_SCHEMA_SQL,
  PRODUCT_SCHEMA_V2_SQL,
  PRODUCT_SCHEMA_V3_SQL,
  PRODUCT_SCHEMA_V4_SQL,
} from "../src/product-schema.ts";

const NOW = "2026-07-25T00:00:00.000Z";
const CANCEL_AT = "2026-07-25T00:01:00.000Z";
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const SAMPLE_PLAN = JSON.stringify([{ sampleIndex: 0, sampleId: DIGEST_A, parameters: {}, seed: null }]);
const LIMITS = JSON.stringify({ schemaVersion: 1, wallTimeMs: 1_000 });
const digest = (value: unknown): string => canonicalDigest(value);
const json = (value: unknown): string => canonicalJsonV2(value).toString("utf8");

const installV4 = (database: DatabaseSync): void => {
  configureProductDatabase(database);
  database.exec(PRODUCT_SCHEMA_SQL);
  database.exec(PRODUCT_SCHEMA_V2_SQL);
  database.exec(PRODUCT_SCHEMA_V3_SQL);
  database.exec(PRODUCT_SCHEMA_V4_SQL);
  database.prepare("UPDATE product_schema SET version = 4 WHERE singleton = 1").run();
  database.exec("PRAGMA user_version = 4");
};

const insertV4Run = (database: DatabaseSync, suffix = "alpha"): {
  projectId: string;
  runId: string;
} => {
  const modelId = `model_${suffix}`;
  const projectId = `project_${suffix}`;
  const experimentId = `experiment_${suffix}`;
  const runId = `run_${suffix}`;
  database.prepare(`INSERT INTO models
    (id, name, technical_status, run_mode, execution_description_json, created_at, updated_at)
    VALUES (?, 'Model', 'executable', 'batch', '{}', ?, ?)`
  ).run(modelId, NOW, NOW);
  database.prepare(`INSERT INTO projects
    (id, name, source_model_id, model_snapshot_digest, execution_description_json, created_at, updated_at)
    VALUES (?, 'Project', ?, ?, '{}', ?, ?)`
  ).run(projectId, modelId, DIGEST_A, NOW, NOW);
  database.prepare(`INSERT INTO experiment_configurations
    (id, project_id, name, configuration_json, estimated_sample_count, created_at, updated_at,
      contract_version, configuration_sha256, sample_count)
    VALUES (?, ?, 'Base', '{}', 1, ?, ?, 4, ?, 1)`
  ).run(experimentId, projectId, NOW, NOW, digest({}));
  database.prepare(`INSERT INTO runs
    (id, project_id, experiment_configuration_id, status, frozen_configuration_json,
      requested_sample_count, created_at, updated_at, contract_version, run_kind,
      execution_description_sha256, project_snapshot_sha256, frozen_configuration_sha256,
      sample_plan_json, sample_plan_sha256, limits_json, limits_sha256,
      start_receipt_sha256, completion_card_disposition)
    VALUES (?, ?, ?, 'queued', '{}', 1, ?, ?, 4, 'batch', ?, ?, ?, ?, ?, ?, ?, ?, 'not_requested')`
  ).run(runId, projectId, experimentId, NOW, NOW, digest({}), DIGEST_A, digest({}),
    SAMPLE_PLAN, digest(JSON.parse(SAMPLE_PLAN)), LIMITS, digest(JSON.parse(LIMITS)), DIGEST_B);
  return { projectId, runId };
};

const insertAppliedCancelReceiptV4 = (
  database: DatabaseSync,
  projectId: string,
  runId: string,
  commandId = "command_cancel_alpha",
  at = CANCEL_AT,
  applied: boolean | number = true,
): void => {
  const payload = {
    schemaVersion: 1,
    commandId,
    projectId,
    runId,
    applied,
    code: "cancellation_requested",
    status: "cancelling",
    cancelRequestedAt: at,
    createdAt: at,
  };
  const bytes = json(payload);
  database.prepare(`INSERT INTO run_commands
    (id, run_id, command_kind, request_key, intent_sha256, state, outcome_json, created_at, updated_at)
    VALUES (?, ?, 'cancel', ?, ?, 'committed', ?, ?, ?)`
  ).run(commandId, runId, commandId, digest({
    schemaVersion: 1,
    commandKind: "run.cancel",
    projectId,
    runId,
  }), bytes, at, at);
  database.prepare(`INSERT INTO run_command_receipts
    (id, run_id, command_id, receipt_kind, payload_sha256, payload_json, committed_at)
    VALUES (?, ?, ?, 'run.cancel.v1', ?, ?, ?)`
  ).run(`receipt_${digest(commandId).slice(0, 32)}`, runId, commandId, digest(payload), bytes, at);
};

test("schema v5 upgrades a clean v4 database without changing execution contract version", () => {
  const database = new DatabaseSync(":memory:");
  try {
    installV4(database);
    const { runId } = insertV4Run(database);
    initializeProductSchema(database);
    assert.equal((database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 5);
    assert.equal((database.prepare("SELECT version FROM product_schema WHERE singleton = 1").get() as { version: number }).version, 5);
    assert.equal((database.prepare("SELECT contract_version FROM runs WHERE id = ?").get(runId) as { contract_version: number }).contract_version, 4);
    assert.equal((database.prepare("SELECT first_cancel_command_id FROM runs WHERE id = ?").get(runId) as { first_cancel_command_id: string | null }).first_cancel_command_id, null);
    assert.equal(Boolean(database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'run_cancel_binding_update_v5'",
    ).get()), true);
  } finally {
    database.close();
  }
});

test("schema v5 backfills only an exact committed applied cancellation receipt", () => {
  const database = new DatabaseSync(":memory:");
  try {
    installV4(database);
    const { projectId, runId } = insertV4Run(database, "backfill");
    insertAppliedCancelReceiptV4(database, projectId, runId, "command_cancel_backfill");
    database.prepare("UPDATE runs SET cancel_requested_at = ?, updated_at = ? WHERE id = ?")
      .run(CANCEL_AT, CANCEL_AT, runId);
    initializeProductSchema(database);
    assert.deepEqual({ ...database.prepare(
      "SELECT cancel_requested_at, first_cancel_command_id FROM runs WHERE id = ?",
    ).get(runId) as object }, {
      cancel_requested_at: CANCEL_AT,
      first_cancel_command_id: "command_cancel_backfill",
    });
  } finally {
    database.close();
  }
});

test("schema v5 rejects unbound v4 cancellation state and rolls the migration back", () => {
  const database = new DatabaseSync(":memory:");
  try {
    installV4(database);
    const { runId } = insertV4Run(database, "invalid");
    database.prepare("UPDATE runs SET cancel_requested_at = ?, updated_at = ? WHERE id = ?")
      .run(CANCEL_AT, CANCEL_AT, runId);
    assert.throws(() => initializeProductSchema(database), /CHECK constraint failed: valid = 1/u);
    assert.equal((database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 4);
    assert.equal((database.prepare("SELECT version FROM product_schema WHERE singleton = 1").get() as { version: number }).version, 4);
    assert.equal((database.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>)
      .some(({ name }) => name === "first_cancel_command_id"), false);
  } finally {
    database.close();
  }
});

test("schema v5 raw SQL cannot create unbound or mismatched cancellation state", () => {
  const database = new DatabaseSync(":memory:");
  try {
    installV4(database);
    const { projectId, runId } = insertV4Run(database, "raw");
    initializeProductSchema(database);
    assert.throws(() => database.prepare(
      "UPDATE runs SET cancel_requested_at = ?, updated_at = ? WHERE id = ?",
    ).run(CANCEL_AT, CANCEL_AT, runId), /invalid v4 run cancellation receipt binding/u);

    insertAppliedCancelReceiptV4(database, projectId, runId, "command_cancel_raw", CANCEL_AT);
    assert.throws(() => database.prepare(`UPDATE runs
      SET cancel_requested_at = ?, first_cancel_command_id = ?, updated_at = ?
      WHERE id = ?`
    ).run("2026-07-25T00:02:00.000Z", "command_cancel_raw", CANCEL_AT, runId),
    /invalid v4 run cancellation receipt binding/u);
    assert.throws(() => database.prepare(`UPDATE runs
      SET status = 'cancelled', terminal_code = 'run_cancelled',
        terminal_diagnostics_json = '{}', resource_overview_json = '{}',
        finished_at = ?, updated_at = ?
      WHERE id = ?`
    ).run(CANCEL_AT, CANCEL_AT, runId), /committed cancellation precedence/u);

    database.prepare(`UPDATE runs
      SET cancel_requested_at = ?, first_cancel_command_id = ?, updated_at = ?
      WHERE id = ?`
    ).run(CANCEL_AT, "command_cancel_raw", CANCEL_AT, runId);
    assert.deepEqual({ ...database.prepare(
      "SELECT cancel_requested_at, first_cancel_command_id FROM runs WHERE id = ?",
    ).get(runId) as object }, {
      cancel_requested_at: CANCEL_AT,
      first_cancel_command_id: "command_cancel_raw",
    });
  } finally {
    database.close();
  }
});

test("schema v5 rejects numeric applied receipts instead of treating them as boolean true", () => {
  const database = new DatabaseSync(":memory:");
  try {
    installV4(database);
    const { projectId, runId } = insertV4Run(database, "numeric_applied");
    insertAppliedCancelReceiptV4(
      database,
      projectId,
      runId,
      "command_cancel_numeric_applied",
      CANCEL_AT,
      1,
    );
    database.prepare("UPDATE runs SET cancel_requested_at = ?, updated_at = ? WHERE id = ?")
      .run(CANCEL_AT, CANCEL_AT, runId);
    assert.throws(() => initializeProductSchema(database), /CHECK constraint failed: valid = 1/u);
    assert.equal(
      (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
      4,
    );
  } finally {
    database.close();
  }
});

test("schema v5 keeps the bound cancel command and process evidence immutable", () => {
  const database = new DatabaseSync(":memory:");
  try {
    installV4(database);
    const { projectId, runId } = insertV4Run(database, "immutable_evidence");
    initializeProductSchema(database);
    insertAppliedCancelReceiptV4(
      database,
      projectId,
      runId,
      "command_cancel_immutable_evidence",
      CANCEL_AT,
    );
    database.prepare(`UPDATE runs
      SET cancel_requested_at = ?, first_cancel_command_id = ?, updated_at = ?
      WHERE id = ?`
    ).run(CANCEL_AT, "command_cancel_immutable_evidence", CANCEL_AT, runId);

    assert.throws(() => database.prepare(
      "UPDATE run_commands SET outcome_json = '{}', updated_at = ? WHERE id = ?",
    ).run(NOW, "command_cancel_immutable_evidence"), /terminal run command is immutable/u);
    assert.throws(() => database.prepare(
      "DELETE FROM run_commands WHERE id = ?",
    ).run("command_cancel_immutable_evidence"), /terminal run command is immutable/u);
    assert.throws(() => database.prepare(`UPDATE runs
      SET status = 'running', started_at = ?, updated_at = ?
      WHERE id = ?`
    ).run(NOW, NOW, runId), /cancelled queued run cannot launch/u);

    const processEvidence = insertV4Run(database, "process_evidence");
    const generation = "c".repeat(64);
    database.prepare(
      "INSERT INTO dispatcher_state (singleton, generation, activated_at) VALUES (1, ?, ?)",
    ).run(generation, NOW);
    database.prepare(`UPDATE runs
      SET status = 'running', started_at = ?, updated_at = ?
      WHERE id = ?`
    ).run(NOW, NOW, processEvidence.runId);
    database.prepare(`INSERT INTO run_attempts
      (id, run_id, attempt_generation, dispatcher_generation, state,
        claimed_at, lease_expires_at)
      VALUES ('attempt_immutable_evidence', ?, 1, ?, 'claimed', ?, ?)`
    ).run(processEvidence.runId, generation, NOW, CANCEL_AT);
    database.prepare(`INSERT INTO process_attempts
      (id, run_attempt_id, process_kind, sample_index, sample_id,
        pid, process_start_token, process_group_id, launch_gate_state, state, launched_at)
      VALUES ('process_immutable_evidence', 'attempt_immutable_evidence', 'batch', 0, ?,
        4242, 'start-token', 4242, 'blocked', 'blocked', ?)`
    ).run(DIGEST_A, NOW);
    assert.throws(() => database.prepare(
      "DELETE FROM process_attempts WHERE id = 'process_immutable_evidence'",
    ).run(), /v4 process attempts cannot be deleted directly/u);
  } finally {
    database.close();
  }
});
