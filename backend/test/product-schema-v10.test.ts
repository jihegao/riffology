import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { canonicalDigest, canonicalJsonV2 } from "../src/canonical-json-v2.ts";
import { PRODUCT_SCHEMA_VERSION } from "../src/product-domain.ts";
import {
  configureProductDatabase,
  initializeProductSchema,
  PRODUCT_SCHEMA_MIGRATIONS,
  PRODUCT_SCHEMA_V10_SQL,
  PRODUCT_SCHEMA_V11_SQL,
} from "../src/product-schema.ts";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const NOW = "2026-07-25T16:00:00.000Z";
const EXPIRES_AT = "2026-07-25T16:01:00.000Z";
const STARTED_AT = "2026-07-25T16:00:01.000Z";
const GENERATION = "c".repeat(64);
const SAMPLE_ID = "d".repeat(64);
const json = (value: unknown): string => canonicalJsonV2(value).toString("utf8");
const VISUAL_EXECUTION = {
  schemaVersion: 2,
  runtime: "python",
  runMode: "visual",
  dependencyFile: "environment/requirements.txt",
  inputs: { schemaProfile: "riff-json-schema-2020-12-v1", schema: { type: "object", properties: {}, additionalProperties: false }, smoke: {} },
  outputs: [],
  visual: { entryPoint: "code/model.py", protocol: "riff-visual-v1", healthPath: "/healthz" },
  cancellation: { signal: "SIGTERM", graceMs: 1_000 },
};
const SAMPLE_PLAN = [{ sampleIndex: 0, sampleId: SAMPLE_ID, parameters: {}, seed: null }];
const LIMITS = {
  schemaVersion: 1, wallTimeMs: 60_000, startupTimeMs: 10_000, terminationGraceMs: 1_000,
  maxStdoutBytes: 10_000, maxStderrBytes: 10_000, maxOutputFiles: 10, maxOutputBytes: 100_000,
  maxEventCount: 10, maxEventBytes: 10_000, maxSamples: 1, maxConcurrency: 1,
};

const installVersion = (database: DatabaseSync, version: number): void => {
  configureProductDatabase(database);
  for (const migration of PRODUCT_SCHEMA_MIGRATIONS.slice(0, version)) database.exec(migration.sql);
  database.prepare("UPDATE product_schema SET version = ? WHERE singleton = 1").run(version);
  database.exec(`PRAGMA user_version = ${version}`);
};

const insertBoundVisualAuthorityFixture = (database: DatabaseSync): {
  insertAudit: (input: Readonly<{ id: string; capability: string; fact: "mint" | "consume" | "outcome" | "failure"; attemptGeneration?: number; commitment?: string }>) => void;
} => {
  const executionJson = json(VISUAL_EXECUTION);
  database.prepare(`INSERT INTO models (id, name, technical_status, run_mode, execution_description_json, created_at, updated_at)
    VALUES ('model_v10', 'Visual', 'executable', 'visual', ?, ?, ?)`).run(executionJson, NOW, NOW);
  database.prepare(`INSERT INTO projects (id, name, source_model_id, model_snapshot_digest, execution_description_json, created_at, updated_at)
    VALUES ('project_v10', 'Visual', 'model_v10', ?, ?, ?, ?)`).run(DIGEST_B, executionJson, NOW, NOW);
  database.prepare(`INSERT INTO conversations (id, project_id, name, provider_id, provider_model_id, provider_locked_at, rolling_summary, created_at, updated_at)
    VALUES ('conversation_v10', 'project_v10', 'Visual', 'test', 'test-model', ?, '', ?, ?)`).run(NOW, NOW, NOW);
  database.prepare(`INSERT INTO messages (id, conversation_id, ordinal, role, status, text, created_at, updated_at)
    VALUES ('message_v10', 'conversation_v10', 0, 'user', 'complete', 'observe', ?, ?)`).run(NOW, NOW);
  database.prepare(`INSERT INTO agent_turns (id, conversation_id, request_key, intent_sha256, input_message_id, state, created_at, updated_at)
    VALUES ('turn_v10', 'conversation_v10', 'visual', ?, 'message_v10', 'running', ?, ?)`).run(DIGEST_A, NOW, NOW);
  database.prepare(`INSERT INTO experiment_configurations
    (id, project_id, name, configuration_json, estimated_sample_count, created_at, updated_at, contract_version, configuration_sha256, sample_count)
    VALUES ('experiment_v10', 'project_v10', 'Visual', '{}', 1, ?, ?, 4, ?, 1)`).run(NOW, NOW, canonicalDigest({}));
  database.prepare(`INSERT INTO runs
    (id, project_id, experiment_configuration_id, status, frozen_configuration_json, requested_sample_count, created_at, updated_at,
      contract_version, run_kind, execution_description_sha256, project_snapshot_sha256, frozen_configuration_sha256,
      sample_plan_json, sample_plan_sha256, limits_json, limits_sha256, start_receipt_sha256, completion_card_disposition)
    VALUES ('run_v10', 'project_v10', 'experiment_v10', 'queued', '{}', 1, ?, ?, 4, 'visual', ?, ?, ?, ?, ?, ?, ?, ?, 'not_requested')`).run(
    NOW, NOW, canonicalDigest(VISUAL_EXECUTION), DIGEST_B, canonicalDigest({}), json(SAMPLE_PLAN), canonicalDigest(SAMPLE_PLAN), json(LIMITS), canonicalDigest(LIMITS), DIGEST_A,
  );
  database.prepare("INSERT INTO dispatcher_state (singleton, generation, activated_at) VALUES (1, ?, ?)").run(GENERATION, NOW);
  database.prepare(`INSERT INTO run_attempts
    (id, run_id, attempt_generation, dispatcher_generation, state, claimed_at, lease_expires_at, started_at)
    VALUES ('attempt_v10', 'run_v10', 1, ?, 'claimed', ?, ?, NULL)`).run(GENERATION, NOW, LIMITS.wallTimeMs.toString());
  database.prepare("UPDATE runs SET status = 'running', started_at = ?, updated_at = ? WHERE id = 'run_v10'").run(STARTED_AT, STARTED_AT);
  database.prepare("UPDATE run_attempts SET state = 'starting', started_at = ? WHERE id = 'attempt_v10'").run(STARTED_AT);
  database.prepare("UPDATE run_attempts SET state = 'running', heartbeat_at = ? WHERE id = 'attempt_v10'").run(STARTED_AT);
  const manifest = { schemaVersion: 1, kind: "visual_process_launch", runId: "run_v10", attemptId: "attempt_v10", attemptGeneration: 1,
    dispatcherGeneration: GENERATION, sampleIndex: 0, sampleId: SAMPLE_ID, scratchId: "scratch_v10", relativePath: "visual-v10",
    loopbackHost: "127.0.0.1", loopbackPort: 41237, healthPath: "/healthz" };
  const manifestDigest = canonicalDigest(manifest);
  const receiptBody = { schemaVersion: 1, manifestId: "manifest_v10", manifestDigest, runId: "run_v10", sampleIndex: 0, sampleId: SAMPLE_ID,
    scratchId: "scratch_v10", relativePath: "visual-v10", pid: 9001, processGroupId: 9001, processStartToken: "visual-v10", loopbackHost: "127.0.0.1",
    loopbackPort: 41237, healthPath: "/healthz", createdAt: STARTED_AT };
  const receipt = { ...receiptBody, receiptDigest: canonicalDigest(receiptBody) };
  database.prepare(`INSERT INTO run_scratch_leases
    (id, run_id, run_attempt_id, dispatcher_generation, sample_index, sample_id, relative_path, state, owner_uid, device, inode, created_at, registered_at)
    VALUES ('scratch_v10', 'run_v10', 'attempt_v10', ?, 0, ?, 'visual-v10', 'active', 501, 42, 99, ?, ?)`).run(GENERATION, SAMPLE_ID, NOW, STARTED_AT);
  database.prepare(`INSERT INTO process_launch_manifests
    (id, run_attempt_id, scratch_lease_id, process_attempt_id, state, manifest_json, manifest_sha256, launch_receipt_json, launch_receipt_sha256, created_at, registered_at)
    VALUES ('manifest_v10', 'attempt_v10', 'scratch_v10', 'process_v10', 'registered', ?, ?, ?, ?, ?, ?)`).run(json(manifest), manifestDigest, json(receipt), canonicalDigest(receipt), NOW, STARTED_AT);
  database.prepare(`INSERT INTO process_attempts
    (id, run_attempt_id, process_kind, sample_index, sample_id, pid, process_start_token, process_group_id, launch_gate_state, state, loopback_port, launched_at)
    VALUES ('process_v10', 'attempt_v10', 'visual', NULL, NULL, 9001, 'visual-v10', 9001, 'blocked', 'blocked', 41237, ?)`).run(STARTED_AT);
  return {
    insertAudit: ({ id, capability, fact, attemptGeneration = 1, commitment = DIGEST_B }) => {
      database.prepare(`INSERT INTO visual_agent_audit_facts
        (id, capability_ref_sha256, fact_kind, conversation_id, turn_id, project_id, run_id, run_attempt_id, process_attempt_id,
          attempt_generation, process_identity_sha256, capability_epoch_sha256, operation_kind, action_kind, locator_kind, locator_role_sha256,
          locator_value_sha256, action_commitment_sha256, value_sha256, outcome_code, capability_expires_at, created_at)
        VALUES (?, ?, ?, 'conversation_v10', 'turn_v10', 'project_v10', 'run_v10', 'attempt_v10', 'process_v10', ?, ?, ?, 'interact',
          'click', 'role_name', ?, ?, ?, NULL, ?, ?, ?)`)
        .run(id, capability, fact, attemptGeneration, DIGEST_A, DIGEST_B, DIGEST_B, DIGEST_A, commitment,
          fact === "outcome" ? "ok" : fact === "failure" ? "failed" : null, EXPIRES_AT, NOW);
    },
  };
};

test("current schema migrates v9 through the v10 audit foundation without backfill and passes quick_check", () => {
  const database = new DatabaseSync(":memory:");
  try {
    installVersion(database, 9);
    initializeProductSchema(database);

    assert.equal((database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, PRODUCT_SCHEMA_VERSION);
    assert.equal((database.prepare("SELECT version FROM product_schema WHERE singleton = 1").get() as { version: number }).version, PRODUCT_SCHEMA_VERSION);
    assert.equal((database.prepare("SELECT count(*) AS count FROM visual_agent_audit_facts").get() as { count: number }).count, 0);
    for (const trigger of [
      "visual_agent_audit_binding_v10",
      "visual_agent_audit_immutable_update_v10",
      "visual_agent_audit_immutable_delete_v10",
    ]) assert.equal(Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(trigger)), true);
    assert.equal((database.prepare("PRAGMA quick_check").get() as { quick_check: string }).quick_check, "ok");
  } finally {
    database.close();
  }
});

test("schema v10 audit facts enforce one mint, one consume, one terminal fact, and append-only rows", () => {
  const database = new DatabaseSync(":memory:");
  try {
    installVersion(database, 10);
    // This test isolates table-level constraints. The production binding trigger is
    // asserted above and requires real v4 visual-process evidence.
    database.exec("DROP TRIGGER visual_agent_audit_binding_v10; PRAGMA foreign_keys = OFF;");
    const insert = database.prepare(`INSERT INTO visual_agent_audit_facts
      (id, capability_ref_sha256, fact_kind, conversation_id, turn_id, project_id,
        run_id, run_attempt_id, process_attempt_id, attempt_generation,
        process_identity_sha256, capability_epoch_sha256, operation_kind,
        action_kind, locator_kind, locator_role_sha256, locator_value_sha256,
        action_commitment_sha256, value_sha256, outcome_code,
        capability_expires_at, created_at)
      VALUES (?, ?, ?, 'conversation_alpha', 'turn_alpha', 'project_alpha',
        'run_alpha', 'attempt_alpha', 'process_alpha', 1, ?, ?, 'interact',
        'click', 'role_name', ?, ?, ?, NULL, ?, ?, ?)`);
    const capability = DIGEST_A;
    insert.run("audit_mint", capability, "mint", DIGEST_B, DIGEST_A, DIGEST_B, DIGEST_A, DIGEST_B, null, EXPIRES_AT, NOW);
    assert.throws(
      () => insert.run("audit_mint_again", capability, "mint", DIGEST_B, DIGEST_A, DIGEST_B, DIGEST_A, DIGEST_B, null, EXPIRES_AT, NOW),
      /UNIQUE constraint failed/u,
    );
    insert.run("audit_consume", capability, "consume", DIGEST_B, DIGEST_A, DIGEST_B, DIGEST_A, DIGEST_B, null, EXPIRES_AT, NOW);
    assert.throws(
      () => insert.run("audit_consume_again", capability, "consume", DIGEST_B, DIGEST_A, DIGEST_B, DIGEST_A, DIGEST_B, null, EXPIRES_AT, NOW),
      /UNIQUE constraint failed/u,
    );
    insert.run("audit_outcome", capability, "outcome", DIGEST_B, DIGEST_A, DIGEST_B, DIGEST_A, DIGEST_B, "ok", EXPIRES_AT, NOW);
    assert.throws(
      () => insert.run("audit_failure", capability, "failure", DIGEST_B, DIGEST_A, DIGEST_B, DIGEST_A, DIGEST_B, "failed", EXPIRES_AT, NOW),
      /UNIQUE constraint failed/u,
    );
    assert.throws(() => database.prepare("UPDATE visual_agent_audit_facts SET outcome_code = 'changed' WHERE id = 'audit_outcome'").run(), /append-only/u);
    assert.throws(() => database.prepare("DELETE FROM visual_agent_audit_facts WHERE id = 'audit_outcome'").run(), /append-only/u);

    const observe = database.prepare(`INSERT INTO visual_agent_audit_facts
      (id, capability_ref_sha256, fact_kind, conversation_id, turn_id, project_id,
        run_id, run_attempt_id, process_attempt_id, attempt_generation,
        process_identity_sha256, capability_epoch_sha256, operation_kind,
        action_kind, locator_kind, locator_role_sha256, locator_value_sha256,
        action_commitment_sha256, value_sha256, outcome_code,
        capability_expires_at, created_at)
      VALUES ('audit_observe_bad', ?, 'mint', 'conversation_alpha', 'turn_alpha',
        'project_alpha', 'run_alpha', 'attempt_alpha', 'process_alpha', 1, ?, ?,
        'observe', 'screenshot', 'label', NULL, ?, ?, NULL,
        NULL, ?, ?)`);
    assert.throws(() => observe.run(DIGEST_B, DIGEST_B, DIGEST_A, DIGEST_A, DIGEST_B, EXPIRES_AT, NOW), /CHECK constraint failed/u);

    const crashGap = database.prepare(`INSERT INTO visual_agent_audit_facts
      (id, capability_ref_sha256, fact_kind, conversation_id, turn_id, project_id,
        run_id, run_attempt_id, process_attempt_id, attempt_generation,
        process_identity_sha256, capability_epoch_sha256, operation_kind,
        action_kind, locator_kind, locator_role_sha256, locator_value_sha256,
        action_commitment_sha256, value_sha256, outcome_code,
        capability_expires_at, created_at)
      VALUES (?, ?, 'crash_gap', 'conversation_alpha', 'turn_alpha', 'project_alpha',
        'run_alpha', 'attempt_alpha', 'process_alpha', 1, ?, ?, 'observe',
        'screenshot', NULL, NULL, NULL, ?, NULL, 'process_restarted', ?, ?)`);
    const crashCapability = "c".repeat(64);
    const crashMint = database.prepare(`INSERT INTO visual_agent_audit_facts
      (id, capability_ref_sha256, fact_kind, conversation_id, turn_id, project_id,
        run_id, run_attempt_id, process_attempt_id, attempt_generation,
        process_identity_sha256, capability_epoch_sha256, operation_kind,
        action_kind, locator_kind, locator_role_sha256, locator_value_sha256,
        action_commitment_sha256, value_sha256, outcome_code,
        capability_expires_at, created_at)
      VALUES ('audit_crash_mint', ?, 'mint', 'conversation_alpha', 'turn_alpha',
        'project_alpha', 'run_alpha', 'attempt_alpha', 'process_alpha', 1, ?, ?,
        'observe', 'screenshot', NULL, NULL, NULL, ?, NULL, NULL, ?, ?)`);
    crashMint.run(crashCapability, DIGEST_B, DIGEST_A, DIGEST_B, EXPIRES_AT, NOW);
    crashGap.run("audit_crash_gap", crashCapability, DIGEST_B, DIGEST_A, DIGEST_B, EXPIRES_AT, NOW);
  } finally {
    database.close();
  }
});

test("schema v10 production binding trigger rejects mismatched authority tuples and terminal facts without consume", () => {
  const database = new DatabaseSync(":memory:");
  try {
    installVersion(database, 10);
    const { insertAudit } = insertBoundVisualAuthorityFixture(database);

    insertAudit({ id: "mint_binding", capability: DIGEST_A, fact: "mint" });
    assert.throws(
      () => insertAudit({ id: "consume_wrong_generation", capability: DIGEST_A, fact: "consume", attemptGeneration: 2 }),
      /visual agent audit binding mismatch/u,
    );
    assert.throws(
      () => insertAudit({ id: "consume_wrong_tuple", capability: DIGEST_A, fact: "consume", commitment: GENERATION }),
      /visual agent audit fact does not match mint/u,
    );

    const outcomeCapability = "e".repeat(64);
    insertAudit({ id: "mint_outcome", capability: outcomeCapability, fact: "mint" });
    assert.throws(
      () => insertAudit({ id: "outcome_without_consume", capability: outcomeCapability, fact: "outcome" }),
      /visual agent audit terminal fact requires consume/u,
    );

    const failureCapability = "f".repeat(64);
    insertAudit({ id: "mint_failure", capability: failureCapability, fact: "mint" });
    assert.throws(
      () => insertAudit({ id: "failure_without_consume", capability: failureCapability, fact: "failure" }),
      /visual agent audit terminal fact requires consume/u,
    );
  } finally {
    database.close();
  }
});

test("schema v11 durably admits only one interaction mint per turn and action commitment", () => {
  const database = new DatabaseSync(":memory:");
  try {
    installVersion(database, 10);
    initializeProductSchema(database);
    const { insertAudit } = insertBoundVisualAuthorityFixture(database);
    insertAudit({ id: "mint_confirmation_once", capability: DIGEST_A, fact: "mint" });
    assert.throws(
      () => insertAudit({
        id: "mint_confirmation_replay",
        capability: "e".repeat(64),
        fact: "mint",
      }),
      /UNIQUE constraint failed/u,
    );
    insertAudit({
      id: "mint_distinct_confirmation",
      capability: "f".repeat(64),
      fact: "mint",
      commitment: GENERATION,
    });
    assert.equal(
      (database.prepare(`SELECT count(*) AS count
        FROM visual_agent_audit_facts
        WHERE fact_kind = 'mint' AND operation_kind = 'interact'`).get() as { count: number }).count,
      2,
    );
  } finally {
    database.close();
  }
});

test("schema v11 migration failure rolls back version markers and its unique index", () => {
  const database = new DatabaseSync(":memory:");
  try {
    installVersion(database, 10);
    const broken = [...PRODUCT_SCHEMA_MIGRATIONS.slice(0, 10), {
      version: 11,
      sql: `${PRODUCT_SCHEMA_V11_SQL}\nSELECT * FROM missing_v11_guard;`,
    }, ...PRODUCT_SCHEMA_MIGRATIONS.slice(11)];
    assert.throws(() => initializeProductSchema(database, broken), /missing_v11_guard/u);
    assert.equal((database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 10);
    assert.equal((database.prepare("SELECT version FROM product_schema WHERE singleton = 1").get() as { version: number }).version, 10);
    assert.equal(Boolean(database.prepare(`SELECT 1 FROM sqlite_master
      WHERE type = 'index' AND name = 'one_visual_interaction_confirmation_mint_v11'`).get()), false);
  } finally {
    database.close();
  }
});

test("schema v10 migration failure rolls back version markers and the new table", () => {
  const database = new DatabaseSync(":memory:");
  try {
    installVersion(database, 9);
    const broken = [...PRODUCT_SCHEMA_MIGRATIONS.slice(0, 9), {
      version: 10,
      sql: `${PRODUCT_SCHEMA_V10_SQL}\nSELECT * FROM missing_v10_guard;`,
    }, ...PRODUCT_SCHEMA_MIGRATIONS.slice(10)];
    assert.throws(() => initializeProductSchema(database, broken), /missing_v10_guard/u);
    assert.equal((database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 9);
    assert.equal((database.prepare("SELECT version FROM product_schema WHERE singleton = 1").get() as { version: number }).version, 9);
    assert.equal(Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'visual_agent_audit_facts'").get()), false);
  } finally {
    database.close();
  }
});
