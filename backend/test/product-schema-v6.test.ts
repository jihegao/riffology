import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalDigest, canonicalJsonV2 } from "../src/canonical-json-v2.ts";
import { ProductStoreV2 } from "../src/product-store-v2.ts";
import {
  configureProductDatabase,
  initializeProductSchema,
  PRODUCT_SCHEMA_MIGRATIONS,
  PRODUCT_SCHEMA_SQL,
  PRODUCT_SCHEMA_V2_SQL,
  PRODUCT_SCHEMA_V3_SQL,
  PRODUCT_SCHEMA_V4_SQL,
  PRODUCT_SCHEMA_V5_SQL,
  PRODUCT_SCHEMA_V6_SQL,
} from "../src/product-schema.ts";

const NOW = "2026-07-25T02:00:00.000Z";
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const GENERATION = "c".repeat(64);
const json = (value: unknown): string => canonicalJsonV2(value).toString("utf8");

const installV5 = (database: DatabaseSync): void => {
  configureProductDatabase(database);
  for (const sql of [
    PRODUCT_SCHEMA_SQL,
    PRODUCT_SCHEMA_V2_SQL,
    PRODUCT_SCHEMA_V3_SQL,
    PRODUCT_SCHEMA_V4_SQL,
    PRODUCT_SCHEMA_V5_SQL,
  ]) database.exec(sql);
  database.prepare("UPDATE product_schema SET version = 5 WHERE singleton = 1").run();
  database.exec("PRAGMA user_version = 5");
};

const insertClaimedV4Run = (database: DatabaseSync): void => {
  const samplePlan = [{ sampleIndex: 0, sampleId: DIGEST_A, parameters: {}, seed: null }];
  const limits = { schemaVersion: 1, wallTimeMs: 60_000, terminationGraceMs: 1_000 };
  database.prepare(`INSERT INTO models
    (id, name, technical_status, run_mode, execution_description_json, created_at, updated_at)
    VALUES ('model_recovery', 'Recovery', 'executable', 'batch', '{}', ?, ?)`
  ).run(NOW, NOW);
  database.prepare(`INSERT INTO projects
    (id, name, source_model_id, model_snapshot_digest, execution_description_json, created_at, updated_at)
    VALUES ('project_recovery', 'Recovery', 'model_recovery', ?, '{}', ?, ?)`
  ).run(DIGEST_A, NOW, NOW);
  database.prepare(`INSERT INTO experiment_configurations
    (id, project_id, name, configuration_json, estimated_sample_count, created_at, updated_at,
      contract_version, configuration_sha256, sample_count)
    VALUES ('experiment_recovery', 'project_recovery', 'Recovery', '{}', 1, ?, ?, 4, ?, 1)`
  ).run(NOW, NOW, canonicalDigest({}));
  database.prepare(`INSERT INTO runs
    (id, project_id, experiment_configuration_id, status, frozen_configuration_json,
      requested_sample_count, created_at, updated_at, started_at, contract_version, run_kind,
      execution_description_sha256, project_snapshot_sha256, frozen_configuration_sha256,
      sample_plan_json, sample_plan_sha256, limits_json, limits_sha256,
      start_receipt_sha256, completion_card_disposition)
    VALUES ('run_recovery', 'project_recovery', 'experiment_recovery', 'queued', '{}',
      1, ?, ?, NULL, 4, 'batch', ?, ?, ?, ?, ?, ?, ?, ?, 'not_requested')`
  ).run(
    NOW,
    NOW,
    canonicalDigest({}),
    DIGEST_A,
    canonicalDigest({}),
    json(samplePlan),
    canonicalDigest(samplePlan),
    json(limits),
    canonicalDigest(limits),
    DIGEST_B,
  );
  database.prepare(
    "INSERT INTO dispatcher_state (singleton, generation, activated_at) VALUES (1, ?, ?)",
  ).run(GENERATION, NOW);
  database.prepare(`INSERT INTO run_attempts
    (id, run_id, attempt_generation, dispatcher_generation, state, claimed_at, lease_expires_at)
    VALUES ('attempt_recovery', 'run_recovery', 1, ?, 'claimed', ?, ?)`
  ).run(GENERATION, NOW, NOW);
  database.prepare(
    "UPDATE runs SET status = 'running', started_at = ?, updated_at = ? WHERE id = 'run_recovery'",
  ).run(NOW, NOW);
};

test("schema v6 preserves a legal live v4 attempt for recovery and keeps execution contract 4", () => {
  const database = new DatabaseSync(":memory:");
  try {
    installV5(database);
    insertClaimedV4Run(database);
    initializeProductSchema(database);
    assert.equal((database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 6);
    assert.deepEqual({ ...database.prepare(
      "SELECT contract_version, status FROM runs WHERE id = 'run_recovery'",
    ).get() as object }, { contract_version: 4, status: "running" });
    assert.equal((database.prepare(
      "SELECT state FROM run_attempts WHERE id = 'attempt_recovery'",
    ).get() as { state: string }).state, "claimed");
    for (const table of ["run_scratch_leases", "process_launch_manifests", "run_recovery_actions"]) {
      assert.ok(database.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
      ).get(table), table);
    }
  } finally {
    database.close();
  }
});

test("schema v6 migration failure rolls back every recovery table and version marker", () => {
  const database = new DatabaseSync(":memory:");
  try {
    installV5(database);
    const broken = [
      ...PRODUCT_SCHEMA_MIGRATIONS.slice(0, 5),
      { version: 6, sql: `${PRODUCT_SCHEMA_V6_SQL}\nSELECT * FROM missing_v6_guard;` },
    ];
    assert.throws(() => initializeProductSchema(database, broken), /missing_v6_guard/u);
    assert.equal((database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 5);
    assert.equal((database.prepare(
      "SELECT version FROM product_schema WHERE singleton = 1",
    ).get() as { version: number }).version, 5);
    assert.equal(Boolean(database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'run_scratch_leases'",
    ).get()), false);
  } finally {
    database.close();
  }
});

test("schema v6 refuses a process row without its durable scratch and launch receipt", () => {
  const database = new DatabaseSync(":memory:");
  try {
    installV5(database);
    insertClaimedV4Run(database);
    initializeProductSchema(database);
    database.prepare(
      "UPDATE run_attempts SET state = 'starting', started_at = ? WHERE id = 'attempt_recovery'",
    ).run(NOW);
    assert.throws(() => database.prepare(`INSERT INTO process_attempts
      (id, run_attempt_id, process_kind, sample_index, sample_id, pid,
        process_start_token, process_group_id, launch_gate_state, state, launched_at)
      VALUES ('process_unregistered', 'attempt_recovery', 'batch', 0, ?, 9999,
        'start', 9999, 'blocked', 'blocked', ?)`
    ).run(DIGEST_A, NOW), /durable launch manifest and receipt/u);
  } finally {
    database.close();
  }
});

test("schema v6 binds launch receipt semantics and freezes registered filesystem/process identity", () => {
  const database = new DatabaseSync(":memory:");
  try {
    installV5(database);
    insertClaimedV4Run(database);
    initializeProductSchema(database);
    database.prepare(
      "UPDATE run_attempts SET state = 'starting', started_at = ? WHERE id = 'attempt_recovery'",
    ).run(NOW);
    const scratchId = "scratch_recovery";
    const relativePath = "riff-run_recovery-0-exact";
    const manifest = {
      schemaVersion: 1,
      kind: "batch_process_launch",
      runId: "run_recovery",
      attemptId: "attempt_recovery",
      attemptGeneration: 1,
      dispatcherGeneration: GENERATION,
      sampleIndex: 0,
      sampleId: DIGEST_A,
      scratchId,
      relativePath,
    };
    const manifestDigest = canonicalDigest(manifest);
    const manifestId = `launch_${manifestDigest.slice(0, 32)}`;
    const unsignedReceipt = {
      schemaVersion: 1,
      manifestId,
      manifestDigest,
      runId: "run_recovery",
      sampleIndex: 0,
      sampleId: DIGEST_A,
      scratchId,
      relativePath,
      pid: 9_999,
      processGroupId: 9_999,
      processStartToken: "Fri Jul 25 02:00:00 2026",
      createdAt: NOW,
    };
    const receipt = { ...unsignedReceipt, receiptDigest: canonicalDigest(unsignedReceipt) };
    database.prepare(`INSERT INTO run_scratch_leases
      (id, run_id, run_attempt_id, dispatcher_generation, sample_index, sample_id,
        relative_path, state, created_at)
      VALUES (?, 'run_recovery', 'attempt_recovery', ?, 0, ?, ?, 'planned', ?)`
    ).run(scratchId, GENERATION, DIGEST_A, relativePath, NOW);
    database.prepare(`UPDATE run_scratch_leases
      SET state = 'created', owner_uid = 501, device = 42, inode = 99, registered_at = ?
      WHERE id = ?`
    ).run(NOW, scratchId);
    database.prepare(`INSERT INTO process_launch_manifests
      (id, run_attempt_id, scratch_lease_id, state, manifest_json, manifest_sha256, created_at)
      VALUES (?, 'attempt_recovery', ?, 'planned', ?, ?, ?)`
    ).run(manifestId, scratchId, json(manifest), manifestDigest, NOW);
    database.prepare(`UPDATE process_launch_manifests
      SET process_attempt_id = 'process_recovery', state = 'registered',
        launch_receipt_json = ?, launch_receipt_sha256 = ?, registered_at = ?
      WHERE id = ?`
    ).run(json(receipt), canonicalDigest(receipt), NOW, manifestId);
    database.prepare("UPDATE run_scratch_leases SET state = 'active' WHERE id = ?").run(scratchId);
    assert.throws(() => database.prepare(`INSERT INTO process_attempts
      (id, run_attempt_id, process_kind, sample_index, sample_id, pid,
        process_start_token, process_group_id, launch_gate_state, state, launched_at)
      VALUES ('process_recovery', 'attempt_recovery', 'batch', 0, ?, 9998,
        ?, 9998, 'blocked', 'blocked', ?)`
    ).run(DIGEST_A, unsignedReceipt.processStartToken, NOW), /durable launch manifest and receipt/u);
    database.prepare(`INSERT INTO process_attempts
      (id, run_attempt_id, process_kind, sample_index, sample_id, pid,
        process_start_token, process_group_id, launch_gate_state, state, launched_at)
      VALUES ('process_recovery', 'attempt_recovery', 'batch', 0, ?, 9999,
        ?, 9999, 'blocked', 'blocked', ?)`
    ).run(DIGEST_A, unsignedReceipt.processStartToken, NOW);

    assert.throws(
      () => database.prepare("UPDATE run_scratch_leases SET inode = 100 WHERE id = ?").run(scratchId),
      /filesystem identity is immutable/u,
    );
    assert.throws(
      () => database.prepare(
        "UPDATE process_launch_manifests SET process_attempt_id = 'process_other' WHERE id = ?",
      ).run(manifestId),
      /process binding is immutable/u,
    );
    assert.throws(
      () => database.prepare(
        "UPDATE process_launch_manifests SET launch_receipt_json = launch_receipt_json WHERE id = ?",
      ).run(manifestId),
      /launch receipt is immutable/u,
    );
  } finally {
    database.close();
  }
});

test("a migrated v5 live process without v6 launch evidence fails startup recovery closed", () => {
  const parent = mkdtempSync(join(tmpdir(), "riff-schema-v6-live-process-"));
  const root = join(parent, "store");
  let store: ProductStoreV2 | undefined;
  try {
    mkdirSync(root, { mode: 0o700 });
    const database = new DatabaseSync(join(root, "product.sqlite3"), { open: true });
    installV5(database);
    insertClaimedV4Run(database);
    database.prepare(
      "UPDATE run_attempts SET state = 'starting', started_at = ? WHERE id = 'attempt_recovery'",
    ).run(NOW);
    database.prepare(`INSERT INTO process_attempts
      (id, run_attempt_id, process_kind, sample_index, sample_id, pid,
        process_start_token, process_group_id, launch_gate_state, state, launched_at)
      VALUES ('process_v5_live', 'attempt_recovery', 'batch', 0, ?, 9999,
        'Fri Jul 25 02:00:00 2026', 9999, 'blocked', 'blocked', ?)`
    ).run(DIGEST_A, NOW);
    database.close();
    store = ProductStoreV2.open(root);
    assert.throws(
      () => store!.listPriorDispatcherRecoveryUnits(),
      /lacks durable launch or scratch evidence/u,
    );
  } finally {
    store?.close();
    rmSync(parent, { recursive: true, force: true });
  }
});
