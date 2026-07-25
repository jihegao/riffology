import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { canonicalDigest, canonicalJsonV2 } from "../src/canonical-json-v2.ts";
import { PRODUCT_SCHEMA_VERSION } from "../src/product-domain.ts";
import {
  configureProductDatabase,
  initializeProductSchema,
  PRODUCT_SCHEMA_MIGRATIONS,
  PRODUCT_SCHEMA_V8_SQL,
  withAtomicVisualHealthContext,
} from "../src/product-schema.ts";

const NOW = "2026-07-25T10:00:00.000Z";
const STARTED_AT = "2026-07-25T10:00:01.000Z";
const HEALTHY_AT = "2026-07-25T10:00:02.000Z";
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const GENERATION = "c".repeat(64);
const PORT = 41_237;
const json = (value: unknown): string => canonicalJsonV2(value).toString("utf8");

const VISUAL_EXECUTION = {
  schemaVersion: 2,
  runtime: "python",
  runMode: "visual",
  dependencyFile: "environment/requirements.txt",
  inputs: {
    schemaProfile: "riff-json-schema-2020-12-v1",
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    smoke: {},
  },
  outputs: [],
  visual: {
    entryPoint: "code/model.py",
    protocol: "riff-visual-v1",
    healthPath: "/healthz",
  },
  cancellation: { signal: "SIGTERM", graceMs: 1_000 },
};
const SAMPLE_PLAN = [{
  sampleIndex: 0,
  sampleId: DIGEST_A,
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

const insertVisualRun = (
  database: DatabaseSync,
  suffix: string,
  attemptState: "claimed" | "starting" | "running" = "running",
): {
  runId: string;
  attemptId: string;
  processId: string;
  scratchId: string;
  manifestId: string;
} => {
  const modelId = `model_visual_${suffix}`;
  const projectId = `project_visual_${suffix}`;
  const experimentId = `experiment_visual_${suffix}`;
  const runId = `run_visual_${suffix}`;
  const attemptId = `attempt_visual_${suffix}`;
  const processId = `process_visual_${suffix}`;
  const scratchId = `scratch_visual_${suffix}`;
  const relativePath = `visual-${suffix}`;
  const executionJson = json(VISUAL_EXECUTION);
  database.prepare(`INSERT INTO models
    (id, name, technical_status, run_mode, execution_description_json, created_at, updated_at)
    VALUES (?, 'Visual', 'executable', 'visual', ?, ?, ?)`
  ).run(modelId, executionJson, NOW, NOW);
  database.prepare(`INSERT INTO projects
    (id, name, source_model_id, model_snapshot_digest, execution_description_json,
      created_at, updated_at)
    VALUES (?, 'Visual', ?, ?, ?, ?, ?)`
  ).run(projectId, modelId, DIGEST_B, executionJson, NOW, NOW);
  database.prepare(`INSERT INTO experiment_configurations
    (id, project_id, name, configuration_json, estimated_sample_count,
      created_at, updated_at, contract_version, configuration_sha256, sample_count)
    VALUES (?, ?, 'Visual', '{}', 1, ?, ?, 4, ?, 1)`
  ).run(experimentId, projectId, NOW, NOW, canonicalDigest({}));
  database.prepare(`INSERT INTO runs
    (id, project_id, experiment_configuration_id, status, frozen_configuration_json,
      requested_sample_count, created_at, updated_at, contract_version, run_kind,
      execution_description_sha256, project_snapshot_sha256, frozen_configuration_sha256,
      sample_plan_json, sample_plan_sha256, limits_json, limits_sha256,
      start_receipt_sha256, completion_card_disposition)
    VALUES (?, ?, ?, 'queued', '{}', 1, ?, ?, 4, 'visual', ?, ?, ?, ?, ?, ?, ?, ?,
      'not_requested')`
  ).run(
    runId,
    projectId,
    experimentId,
    NOW,
    NOW,
    canonicalDigest(VISUAL_EXECUTION),
    DIGEST_B,
    canonicalDigest({}),
    json(SAMPLE_PLAN),
    canonicalDigest(SAMPLE_PLAN),
    json(LIMITS),
    canonicalDigest(LIMITS),
    DIGEST_A,
  );
  database.prepare(`INSERT INTO dispatcher_state (singleton, generation, activated_at)
    VALUES (1, ?, ?)
    ON CONFLICT(singleton) DO UPDATE SET generation = excluded.generation,
      activated_at = excluded.activated_at`
  ).run(GENERATION, NOW);
  database.prepare(`INSERT INTO run_attempts
    (id, run_id, attempt_generation, dispatcher_generation, state,
      claimed_at, lease_expires_at, started_at)
    VALUES (?, ?, 1, ?, 'claimed', ?, ?, NULL)`
  ).run(
    attemptId,
    runId,
    GENERATION,
    NOW,
    LIMITS.wallTimeMs.toString(),
  );
  database.prepare(
    "UPDATE runs SET status = 'running', started_at = ?, updated_at = ? WHERE id = ?",
  ).run(STARTED_AT, STARTED_AT, runId);
  if (attemptState !== "claimed") {
    database.prepare(
      "UPDATE run_attempts SET state = 'starting', started_at = ? WHERE id = ?",
    ).run(STARTED_AT, attemptId);
  }
  if (attemptState === "running") {
    database.prepare(
      "UPDATE run_attempts SET state = 'running', heartbeat_at = ? WHERE id = ?",
    ).run(STARTED_AT, attemptId);
  }
  return { runId, attemptId, processId, scratchId, manifestId: "", };
};

const prepareRegisteredBatchProcessEvidence = (
  database: DatabaseSync,
  suffix: string,
  receiptPid = 8_001,
): {
  runId: string;
  attemptId: string;
  processId: string;
  scratchId: string;
  manifestId: string;
} => {
  const modelId = `model_batch_${suffix}`;
  const projectId = `project_batch_${suffix}`;
  const experimentId = `experiment_batch_${suffix}`;
  const runId = `run_batch_${suffix}`;
  const attemptId = `attempt_batch_${suffix}`;
  const processId = `process_batch_${suffix}`;
  const scratchId = `scratch_batch_${suffix}`;
  const relativePath = `batch-${suffix}`;
  database.prepare(`INSERT INTO models
    (id, name, technical_status, run_mode, execution_description_json, created_at, updated_at)
    VALUES (?, 'Batch', 'executable', 'batch', '{}', ?, ?)`
  ).run(modelId, NOW, NOW);
  database.prepare(`INSERT INTO projects
    (id, name, source_model_id, model_snapshot_digest, execution_description_json,
      created_at, updated_at)
    VALUES (?, 'Batch', ?, ?, '{}', ?, ?)`
  ).run(projectId, modelId, DIGEST_B, NOW, NOW);
  database.prepare(`INSERT INTO experiment_configurations
    (id, project_id, name, configuration_json, estimated_sample_count,
      created_at, updated_at, contract_version, configuration_sha256, sample_count)
    VALUES (?, ?, 'Batch', '{}', 1, ?, ?, 4, ?, 1)`
  ).run(experimentId, projectId, NOW, NOW, canonicalDigest({}));
  database.prepare(`INSERT INTO runs
    (id, project_id, experiment_configuration_id, status, frozen_configuration_json,
      requested_sample_count, created_at, updated_at, contract_version, run_kind,
      execution_description_sha256, project_snapshot_sha256, frozen_configuration_sha256,
      sample_plan_json, sample_plan_sha256, limits_json, limits_sha256,
      start_receipt_sha256, completion_card_disposition)
    VALUES (?, ?, ?, 'queued', '{}', 1, ?, ?, 4, 'batch', ?, ?, ?, ?, ?, ?, ?, ?,
      'not_requested')`
  ).run(
    runId,
    projectId,
    experimentId,
    NOW,
    NOW,
    canonicalDigest({}),
    DIGEST_B,
    canonicalDigest({}),
    json(SAMPLE_PLAN),
    canonicalDigest(SAMPLE_PLAN),
    json(LIMITS),
    canonicalDigest(LIMITS),
    DIGEST_A,
  );
  database.prepare(`INSERT INTO dispatcher_state (singleton, generation, activated_at)
    VALUES (1, ?, ?)
    ON CONFLICT(singleton) DO UPDATE SET generation = excluded.generation,
      activated_at = excluded.activated_at`
  ).run(GENERATION, NOW);
  database.prepare(`INSERT INTO run_attempts
    (id, run_id, attempt_generation, dispatcher_generation, state,
      claimed_at, lease_expires_at)
    VALUES (?, ?, 1, ?, 'claimed', ?, ?)`
  ).run(attemptId, runId, GENERATION, NOW, LIMITS.wallTimeMs.toString());
  database.prepare(
    "UPDATE runs SET status = 'running', started_at = ?, updated_at = ? WHERE id = ?",
  ).run(STARTED_AT, STARTED_AT, runId);
  database.prepare(
    "UPDATE run_attempts SET state = 'starting', started_at = ? WHERE id = ?",
  ).run(STARTED_AT, attemptId);
  database.prepare(
    "UPDATE run_attempts SET state = 'running', heartbeat_at = ? WHERE id = ?",
  ).run(STARTED_AT, attemptId);
  const manifest = {
    schemaVersion: 1,
    kind: "batch_process_launch",
    runId,
    attemptId,
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
    runId,
    sampleIndex: 0,
    sampleId: DIGEST_A,
    scratchId,
    relativePath,
    pid: receiptPid,
    processGroupId: 8_001,
    processStartToken: `batch-start-${suffix}`,
    createdAt: STARTED_AT,
  };
  const receipt = {
    ...unsignedReceipt,
    receiptDigest: canonicalDigest(unsignedReceipt),
  };
  database.prepare(`INSERT INTO run_scratch_leases
    (id, run_id, run_attempt_id, dispatcher_generation, sample_index, sample_id,
      relative_path, state, owner_uid, device, inode, created_at, registered_at)
    VALUES (?, ?, ?, ?, 0, ?, ?, 'active', 501, 42, 99, ?, ?)`
  ).run(scratchId, runId, attemptId, GENERATION, DIGEST_A, relativePath, NOW, STARTED_AT);
  database.prepare(`INSERT INTO process_launch_manifests
    (id, run_attempt_id, scratch_lease_id, process_attempt_id, state,
      manifest_json, manifest_sha256, launch_receipt_json, launch_receipt_sha256,
      created_at, registered_at)
    VALUES (?, ?, ?, ?, 'registered', ?, ?, ?, ?, ?, ?)`
  ).run(
    manifestId,
    attemptId,
    scratchId,
    processId,
    json(manifest),
    manifestDigest,
    json(receipt),
    canonicalDigest(receipt),
    NOW,
    STARTED_AT,
  );
  return { runId, attemptId, processId, scratchId, manifestId };
};

const insertBatchProcessAttempt = (
  database: DatabaseSync,
  ids: ReturnType<typeof prepareRegisteredBatchProcessEvidence>,
  pid = 8_001,
): void => {
  database.prepare(`INSERT INTO process_attempts
    (id, run_attempt_id, process_kind, sample_index, sample_id, pid,
      process_start_token, process_group_id, launch_gate_state, state, launched_at)
    VALUES (?, ?, 'batch', 0, ?, ?, ?, 8001, 'blocked', 'blocked', ?)`
  ).run(
    ids.processId,
    ids.attemptId,
    DIGEST_A,
    pid,
    `batch-start-${ids.processId.slice("process_batch_".length)}`,
    STARTED_AT,
  );
};

const prepareRegisteredVisualProcessEvidence = (
  database: DatabaseSync,
  suffix: string,
  overrides: Readonly<{
    manifest?: Readonly<Partial<{
      loopbackPort: number;
      healthPath: string;
    }>>;
    receipt?: Readonly<Partial<{
      pid: number;
      processGroupId: number;
      processStartToken: string;
      loopbackPort: number;
      healthPath: string;
    }>>;
  }> = {},
): ReturnType<typeof insertVisualRun> => {
  const ids = insertVisualRun(database, suffix);
  const relativePath = `visual-${suffix}`;
  const manifest = {
    schemaVersion: 1,
    kind: "visual_process_launch",
    runId: ids.runId,
    attemptId: ids.attemptId,
    attemptGeneration: 1,
    dispatcherGeneration: GENERATION,
    sampleIndex: 0,
    sampleId: DIGEST_A,
    scratchId: ids.scratchId,
    relativePath,
    loopbackHost: "127.0.0.1",
    loopbackPort: overrides.manifest?.loopbackPort ?? PORT,
    healthPath: overrides.manifest?.healthPath ?? VISUAL_EXECUTION.visual.healthPath,
  };
  const manifestDigest = canonicalDigest(manifest);
  const manifestId = `launch_${manifestDigest.slice(0, 32)}`;
  const unsignedReceipt = {
    schemaVersion: 1,
    manifestId,
    manifestDigest,
    runId: ids.runId,
    sampleIndex: 0,
    sampleId: DIGEST_A,
    scratchId: ids.scratchId,
    relativePath,
    pid: overrides.receipt?.pid ?? 9_001,
    processGroupId: overrides.receipt?.processGroupId ?? 9_001,
    processStartToken: overrides.receipt?.processStartToken ?? `visual-start-${suffix}`,
    loopbackHost: "127.0.0.1",
    loopbackPort: overrides.receipt?.loopbackPort ?? PORT,
    healthPath: overrides.receipt?.healthPath ?? VISUAL_EXECUTION.visual.healthPath,
    createdAt: STARTED_AT,
  };
  const receipt = {
    ...unsignedReceipt,
    receiptDigest: canonicalDigest(unsignedReceipt),
  };
  database.prepare(`INSERT INTO run_scratch_leases
    (id, run_id, run_attempt_id, dispatcher_generation, sample_index, sample_id,
      relative_path, state, owner_uid, device, inode, created_at, registered_at)
    VALUES (?, ?, ?, ?, 0, ?, ?, 'active', 501, 42, 99, ?, ?)`
  ).run(
    ids.scratchId,
    ids.runId,
    ids.attemptId,
    GENERATION,
    DIGEST_A,
    relativePath,
    NOW,
    STARTED_AT,
  );
  database.prepare(`INSERT INTO process_launch_manifests
    (id, run_attempt_id, scratch_lease_id, process_attempt_id, state,
      manifest_json, manifest_sha256, launch_receipt_json, launch_receipt_sha256,
      created_at, registered_at)
    VALUES (?, ?, ?, ?, 'registered', ?, ?, ?, ?, ?, ?)`
  ).run(
    manifestId,
    ids.attemptId,
    ids.scratchId,
    ids.processId,
    json(manifest),
    manifestDigest,
    json(receipt),
    canonicalDigest(receipt),
    NOW,
    STARTED_AT,
  );
  return { ...ids, manifestId };
};

const insertVisualProcessAttempt = (
  database: DatabaseSync,
  ids: ReturnType<typeof prepareRegisteredVisualProcessEvidence>,
  overrides: Readonly<Partial<{
    pid: number;
    processStartToken: string;
    processGroupId: number;
    loopbackPort: number;
  }>> = {},
): void => {
  const suffix = ids.processId.slice("process_visual_".length);
  database.prepare(`INSERT INTO process_attempts
    (id, run_attempt_id, process_kind, sample_index, sample_id, pid,
      process_start_token, process_group_id, launch_gate_state, state,
      loopback_port, launched_at)
    VALUES (?, ?, 'visual', NULL, NULL, ?, ?, ?, 'blocked', 'blocked', ?, ?)`
  ).run(
    ids.processId,
    ids.attemptId,
    overrides.pid ?? 9_001,
    overrides.processStartToken ?? `visual-start-${suffix}`,
    overrides.processGroupId ?? 9_001,
    overrides.loopbackPort ?? PORT,
    STARTED_AT,
  );
};

const insertRegisteredVisualProcess = (
  database: DatabaseSync,
  suffix: string,
): ReturnType<typeof prepareRegisteredVisualProcessEvidence> => {
  const ids = prepareRegisteredVisualProcessEvidence(database, suffix);
  insertVisualProcessAttempt(database, ids);
  return ids;
};

const markVisualRunning = (
  database: DatabaseSync,
  ids: ReturnType<typeof insertRegisteredVisualProcess>,
): void => {
  database.prepare(`UPDATE process_attempts
    SET launch_gate_state = 'released', state = 'released', started_at = ?
    WHERE id = ?`
  ).run(STARTED_AT, ids.processId);
  database.prepare(
    "UPDATE process_launch_manifests SET state = 'released' WHERE id = ?",
  ).run(ids.manifestId);
  database.prepare(
    "UPDATE process_attempts SET state = 'running', heartbeat_at = ? WHERE id = ?",
  ).run(STARTED_AT, ids.processId);
};

const healthReceipt = (
  database: DatabaseSync,
  ids: ReturnType<typeof insertRegisteredVisualProcess>,
  overrides: Partial<{
    runId: string;
    attemptId: string;
    processAttemptId: string;
    launchManifestId: string;
    launchManifestDigest: string;
    pid: number;
    processStartToken: string;
    processGroupId: number;
    loopbackPort: number;
    healthPath: string;
    healthyAt: string;
  }> = {},
): Record<string, unknown> => {
  const manifest = database.prepare(
    "SELECT manifest_sha256 FROM process_launch_manifests WHERE id = ?",
  ).get(ids.manifestId) as { manifest_sha256: string };
  return {
    schemaVersion: 1,
    kind: "visual_process_health",
    runId: overrides.runId ?? ids.runId,
    attemptId: overrides.attemptId ?? ids.attemptId,
    attemptGeneration: 1,
    processAttemptId: overrides.processAttemptId ?? ids.processId,
    launchManifestId: overrides.launchManifestId ?? ids.manifestId,
    launchManifestDigest: overrides.launchManifestDigest ?? manifest.manifest_sha256,
    pid: overrides.pid ?? 9_001,
    processStartToken: overrides.processStartToken
      ?? `visual-start-${ids.processId.slice("process_visual_".length)}`,
    processGroupId: overrides.processGroupId ?? 9_001,
    loopbackPort: overrides.loopbackPort ?? PORT,
    healthPath: overrides.healthPath ?? VISUAL_EXECUTION.visual.healthPath,
    healthyAt: overrides.healthyAt ?? HEALTHY_AT,
  };
};

const assertNoVisualHealthEvidence = (
  database: DatabaseSync,
  processAttemptId: string,
): void => {
  assert.equal((database.prepare(
    "SELECT health_at FROM process_attempts WHERE id = ?",
  ).get(processAttemptId) as { health_at: string | null }).health_at, null);
  assert.equal((database.prepare(
    "SELECT count(*) AS count FROM visual_health_receipts WHERE process_attempt_id = ?",
  ).get(processAttemptId) as { count: number }).count, 0);
};

const insertHealthReceiptRow = (
  database: DatabaseSync,
  ids: ReturnType<typeof insertRegisteredVisualProcess>,
  receipt: Record<string, unknown>,
  rowOverrides: Partial<{
    runId: string;
    runAttemptId: string;
    launchManifestId: string;
    pid: number;
    processStartToken: string;
    processGroupId: number;
    loopbackPort: number;
    healthPath: string;
    healthyAt: string;
  }> = {},
): void => {
  database.prepare(`INSERT INTO visual_health_receipts
    (process_attempt_id, run_id, run_attempt_id, launch_manifest_id,
      pid, process_start_token, process_group_id, loopback_port, health_path,
      healthy_at, receipt_json, receipt_sha256, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    ids.processId,
    rowOverrides.runId ?? ids.runId,
    rowOverrides.runAttemptId ?? ids.attemptId,
    rowOverrides.launchManifestId ?? ids.manifestId,
    rowOverrides.pid ?? 9_001,
    rowOverrides.processStartToken ?? `visual-start-${ids.processId.slice("process_visual_".length)}`,
    rowOverrides.processGroupId ?? 9_001,
    rowOverrides.loopbackPort ?? PORT,
    rowOverrides.healthPath ?? VISUAL_EXECUTION.visual.healthPath,
    rowOverrides.healthyAt ?? HEALTHY_AT,
    json(receipt),
    canonicalDigest(receipt),
    rowOverrides.healthyAt ?? HEALTHY_AT,
  );
};

test("schema v8 migrates a clean v7 database, installs private health evidence, and passes quick_check", () => {
  const database = new DatabaseSync(":memory:");
  try {
    installVersion(database, 7);
    const sentinel = prepareRegisteredBatchProcessEvidence(database, "v7_sentinel");
    insertBatchProcessAttempt(database, sentinel);
    const readSentinel = (): Record<string, unknown> => ({
      run: database.prepare("SELECT * FROM runs WHERE id = ?").get(sentinel.runId),
      attempt: database.prepare("SELECT * FROM run_attempts WHERE id = ?").get(sentinel.attemptId),
      scratch: database.prepare("SELECT * FROM run_scratch_leases WHERE id = ?").get(sentinel.scratchId),
      manifest: database.prepare("SELECT * FROM process_launch_manifests WHERE id = ?").get(sentinel.manifestId),
      process: database.prepare("SELECT * FROM process_attempts WHERE id = ?").get(sentinel.processId),
    });
    const preservedTriggers = database.prepare(`SELECT name, sql FROM sqlite_master
      WHERE type = 'trigger'
        AND name NOT IN (
          'process_requires_launch_receipt_v6',
          'run_success_atomic_context_v4',
          'output_v4_run_contract_insert',
          'run_output_object_atomic_success_v4',
          'experiment_legacy_delete_v4',
          'experiment_receipt_delete_v4',
          'run_legacy_delete_v4',
          'output_legacy_delete_v4',
          'run_receipt_delete_v4',
          'run_command_terminal_delete_v5',
          'run_attempt_delete_v5',
          'process_attempt_delete_v5',
          'scratch_lease_delete_v6',
          'launch_manifest_delete_v6',
          'recovery_action_delete_v6',
          'platform_card_delete_v7',
          'run_completion_card_delete_v7',
          'visual_health_receipt_delete_v8',
          'visual_agent_audit_immutable_delete_v10',
          'diagnostic_event_sets_immutable_delete_v12',
          'diagnostic_event_files_immutable_delete_v12',
          'diagnostic_events_immutable_delete_v12'
        )
      ORDER BY name`
    ).all() as Array<{ name: string; sql: string }>;
    const batchSentinelBefore = readSentinel();
    initializeProductSchema(database);
    assert.equal((database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, PRODUCT_SCHEMA_VERSION);
    assert.equal((database.prepare(
      "SELECT version FROM product_schema WHERE singleton = 1",
    ).get() as { version: number }).version, PRODUCT_SCHEMA_VERSION);
    assert.ok(database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'visual_health_receipts'",
    ).get());
    assert.ok(database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'process_requires_launch_receipt_v8'",
    ).get());
    assert.deepEqual(readSentinel(), batchSentinelBefore);
    for (const trigger of preservedTriggers) {
      assert.deepEqual(database.prepare(
        "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name = ?",
      ).get(trigger.name), trigger, trigger.name);
    }
    assert.equal((database.prepare("PRAGMA quick_check").get() as { quick_check: string }).quick_check, "ok");
  } finally {
    database.close();
  }
});

test("schema v8 migration failure rolls back its table, trigger replacement, and version markers", () => {
  const database = new DatabaseSync(":memory:");
  try {
    installVersion(database, 7);
    const broken = [
      ...PRODUCT_SCHEMA_MIGRATIONS.slice(0, 7),
      { version: 8, sql: `${PRODUCT_SCHEMA_V8_SQL}\nSELECT * FROM missing_v8_guard;` },
      ...PRODUCT_SCHEMA_MIGRATIONS.slice(8),
    ];
    assert.throws(() => initializeProductSchema(database, broken), /missing_v8_guard/u);
    assert.equal((database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 7);
    assert.equal((database.prepare(
      "SELECT version FROM product_schema WHERE singleton = 1",
    ).get() as { version: number }).version, 7);
    assert.equal(Boolean(database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'visual_health_receipts'",
    ).get()), false);
    assert.ok(database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'process_requires_launch_receipt_v6'",
    ).get());
  } finally {
    database.close();
  }
});

test("schema v8 rejects pre-v8 live visual and separately rejects terminal unproven health", () => {
  for (const evidence of ["live_process", "terminal_health"] as const) {
    const database = new DatabaseSync(":memory:");
    try {
      installVersion(database, 5);
      const ids = insertVisualRun(database, `legacy_${evidence}`, "running");
      database.prepare(`INSERT INTO process_attempts
        (id, run_attempt_id, process_kind, pid, process_start_token, process_group_id,
          launch_gate_state, state, loopback_port, launched_at)
        VALUES (?, ?, 'visual', 9001, 'legacy-start', 9001, 'blocked', 'blocked', ?, ?)`
      ).run(ids.processId, ids.attemptId, PORT, NOW);
      if (evidence === "terminal_health") {
        database.prepare(
          "UPDATE process_attempts SET health_at = ? WHERE id = ?",
        ).run(HEALTHY_AT, ids.processId);
        database.prepare(`UPDATE process_attempts
          SET state = 'exited', exited_at = ?, exit_signal = 'legacy_exit'
          WHERE id = ?`
        ).run(HEALTHY_AT, ids.processId);
        database.prepare(`UPDATE process_attempts
          SET state = 'cleanup_complete', cleanup_receipt_sha256 = ?
          WHERE id = ?`
        ).run(DIGEST_B, ids.processId);
        database.prepare(`UPDATE run_attempts
          SET state = 'interrupted', finished_at = ? WHERE id = ?`
        ).run(HEALTHY_AT, ids.attemptId);
        database.prepare(`UPDATE runs
          SET status = 'failed', terminal_code = 'runtime_interrupted',
            terminal_diagnostics_json = '{}', resource_overview_json = '{}',
            finished_at = ?, updated_at = ?
          WHERE id = ?`
        ).run(HEALTHY_AT, HEALTHY_AT, ids.runId);
        assert.equal((database.prepare(
          "SELECT state FROM process_attempts WHERE id = ?",
        ).get(ids.processId) as { state: string }).state, "cleanup_complete");
      } else {
        assert.equal((database.prepare(
          "SELECT health_at FROM process_attempts WHERE id = ?",
        ).get(ids.processId) as { health_at: string | null }).health_at, null);
      }
      const processBefore = database.prepare(
        "SELECT * FROM process_attempts WHERE id = ?",
      ).get(ids.processId);
      assert.throws(
        () => initializeProductSchema(database),
        /CHECK constraint failed: valid = 1/u,
        evidence,
      );
      assert.equal((database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 5);
      assert.equal((database.prepare(
        "SELECT version FROM product_schema WHERE singleton = 1",
      ).get() as { version: number }).version, 5);
      assert.deepEqual(
        database.prepare("SELECT * FROM process_attempts WHERE id = ?").get(ids.processId),
        processBefore,
      );
      for (const name of [
        "run_scratch_leases",
        "process_launch_manifests",
        "run_recovery_actions",
        "run_completion_cards",
        "visual_health_receipts",
      ]) {
        assert.equal(Boolean(database.prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        ).get(name)), false, name);
      }
      for (const name of [
        "process_requires_launch_receipt_v6",
        "process_requires_launch_receipt_v8",
        "visual_health_transition_v8",
      ]) {
        assert.equal(Boolean(database.prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?",
        ).get(name)), false, name);
      }
    } finally {
      database.close();
    }
  }
});

test("schema v8 binds a visual launch receipt and makes its assigned port absolutely immutable", () => {
  const database = new DatabaseSync(":memory:");
  try {
    initializeProductSchema(database);
    const ids = insertRegisteredVisualProcess(database, "binding");
    assert.deepEqual({ ...database.prepare(`SELECT process_kind, sample_index, sample_id,
        loopback_port, state
      FROM process_attempts WHERE id = ?`
    ).get(ids.processId) as object }, {
      process_kind: "visual",
      sample_index: null,
      sample_id: null,
      loopback_port: PORT,
      state: "blocked",
    });
    assert.throws(() => database.prepare(
      "UPDATE process_attempts SET loopback_port = loopback_port WHERE id = ?",
    ).run(ids.processId), /loopback port is immutable/u);

    assert.equal((database.prepare("PRAGMA quick_check").get() as { quick_check: string }).quick_check, "ok");
  } finally {
    database.close();
  }
});

test("schema v8 accepts a real v6-shaped batch launch and rejects a mismatched batch receipt", () => {
  const database = new DatabaseSync(":memory:");
  try {
    initializeProductSchema(database);
    const valid = prepareRegisteredBatchProcessEvidence(database, "v8_valid");
    insertBatchProcessAttempt(database, valid);
    assert.deepEqual({ ...database.prepare(`SELECT process_kind, sample_index, sample_id,
        loopback_port, state
      FROM process_attempts WHERE id = ?`
    ).get(valid.processId) as object }, {
      process_kind: "batch",
      sample_index: 0,
      sample_id: DIGEST_A,
      loopback_port: null,
      state: "blocked",
    });

    const invalid = prepareRegisteredBatchProcessEvidence(database, "v8_invalid", 8_002);
    assert.throws(
      () => insertBatchProcessAttempt(database, invalid, 8_001),
      /durable launch manifest and receipt/u,
    );
    assert.equal((database.prepare(
      "SELECT count(*) AS count FROM process_attempts WHERE id = ?",
    ).get(invalid.processId) as { count: number }).count, 0);
  } finally {
    database.close();
  }
});

test("visual launch rejects mismatched PID, start token, process group, port, and health path before process insertion", () => {
  const cases = [
    {
      name: "pid",
      evidence: { receipt: { pid: 9_002 } },
    },
    {
      name: "process_start_token",
      evidence: { receipt: { processStartToken: "wrong-start-token" } },
    },
    {
      name: "process_group_id",
      evidence: { receipt: { processGroupId: 9_002 } },
    },
    {
      name: "loopback_port_process_side",
      process: { loopbackPort: PORT + 1 },
    },
    {
      name: "loopback_port_manifest_side",
      evidence: {
        manifest: { loopbackPort: PORT + 1 },
        receipt: { loopbackPort: PORT + 1 },
      },
    },
    {
      name: "health_path_receipt_side",
      evidence: { receipt: { healthPath: "/wrong-health" } },
    },
    {
      name: "health_path_manifest_side",
      evidence: {
        manifest: { healthPath: "/wrong-health" },
        receipt: { healthPath: "/wrong-health" },
      },
    },
  ] as const;
  for (const item of cases) {
    const database = new DatabaseSync(":memory:");
    try {
      initializeProductSchema(database);
      const ids = prepareRegisteredVisualProcessEvidence(
        database,
        `launch_${item.name}`,
        item.evidence ?? {},
      );
      assert.throws(
        () => insertVisualProcessAttempt(database, ids, item.process ?? {}),
        /durable launch manifest and receipt/u,
        item.name,
      );
      assert.equal((database.prepare(
        "SELECT count(*) AS count FROM process_attempts WHERE id = ?",
      ).get(ids.processId) as { count: number }).count, 0, item.name);
      assert.deepEqual({ ...database.prepare(`SELECT state, process_attempt_id
        FROM process_launch_manifests WHERE id = ?`
      ).get(ids.manifestId) as object }, {
        state: "registered",
        process_attempt_id: ids.processId,
      }, item.name);
    } finally {
      database.close();
    }
  }
});

test("visual health is one controlled null-to-timestamp update with one immutable matching receipt", () => {
  const database = new DatabaseSync(":memory:");
  try {
    initializeProductSchema(database);
    const ids = insertRegisteredVisualProcess(database, "health");
    markVisualRunning(database, ids);

    assert.throws(() => database.prepare(
      "UPDATE process_attempts SET health_at = ? WHERE id = ?",
    ).run(HEALTHY_AT, ids.processId), /one atomic matching receipt/u);
    assert.equal((database.prepare(
      "SELECT count(*) AS count FROM visual_health_receipts",
    ).get() as { count: number }).count, 0);

    assert.throws(() => withAtomicVisualHealthContext(database, {
      processAttemptId: ids.processId,
      healthyAt: HEALTHY_AT,
    }, () => database.prepare(
      "UPDATE process_attempts SET health_at = ? WHERE id = ?",
    ).run("2026-07-25T10:00:03.000Z", ids.processId)), /one atomic matching receipt/u);

    withAtomicVisualHealthContext(database, {
      processAttemptId: ids.processId,
      healthyAt: HEALTHY_AT,
    }, () => database.prepare(
      "UPDATE process_attempts SET health_at = ? WHERE id = ?",
    ).run(HEALTHY_AT, ids.processId));

    const receipt = database.prepare(`SELECT process_attempt_id, run_id, run_attempt_id,
        launch_manifest_id, pid, process_start_token, process_group_id, loopback_port,
        health_path, healthy_at, receipt_json, receipt_sha256, created_at
      FROM visual_health_receipts WHERE process_attempt_id = ?`
    ).get(ids.processId) as Record<string, string | number>;
    assert.equal(receipt.process_attempt_id, ids.processId);
    assert.equal(receipt.run_id, ids.runId);
    assert.equal(receipt.run_attempt_id, ids.attemptId);
    assert.equal(receipt.launch_manifest_id, ids.manifestId);
    assert.equal(receipt.pid, 9_001);
    assert.equal(receipt.process_start_token, "visual-start-health");
    assert.equal(receipt.process_group_id, 9_001);
    assert.equal(receipt.loopback_port, PORT);
    assert.equal(receipt.health_path, VISUAL_EXECUTION.visual.healthPath);
    assert.equal(receipt.healthy_at, HEALTHY_AT);
    assert.equal(receipt.created_at, HEALTHY_AT);
    assert.equal(receipt.receipt_sha256, canonicalDigest(JSON.parse(String(receipt.receipt_json))));
    assert.equal((database.prepare(
      "SELECT count(*) AS count FROM visual_health_receipts WHERE process_attempt_id = ?",
    ).get(ids.processId) as { count: number }).count, 1);

    assert.throws(() => withAtomicVisualHealthContext(database, {
      processAttemptId: ids.processId,
      healthyAt: HEALTHY_AT,
    }, () => database.prepare(
      "UPDATE process_attempts SET health_at = health_at WHERE id = ?",
    ).run(ids.processId)), /one atomic matching receipt/u);
    assert.throws(() => database.prepare(
      "UPDATE visual_health_receipts SET health_path = health_path WHERE process_attempt_id = ?",
    ).run(ids.processId), /health receipts are immutable/u);
    assert.throws(() => database.prepare(
      "DELETE FROM visual_health_receipts WHERE process_attempt_id = ?",
    ).run(ids.processId), /immutable evidence/u);
  } finally {
    database.close();
  }
});

test("a failure while the AFTER trigger writes its receipt rolls back health and receipt together", () => {
  const database = new DatabaseSync(":memory:");
  try {
    initializeProductSchema(database);
    const ids = insertRegisteredVisualProcess(database, "atomic_rollback");
    markVisualRunning(database, ids);
    database.exec(`CREATE TRIGGER test_visual_health_receipt_write_failure
      BEFORE INSERT ON visual_health_receipts
      BEGIN SELECT RAISE(ABORT, 'injected receipt write failure'); END;`);
    assert.throws(() => withAtomicVisualHealthContext(database, {
      processAttemptId: ids.processId,
      healthyAt: HEALTHY_AT,
    }, () => database.prepare(
      "UPDATE process_attempts SET health_at = ? WHERE id = ?",
    ).run(HEALTHY_AT, ids.processId)), /injected receipt write failure/u);
    assertNoVisualHealthEvidence(database, ids.processId);
  } finally {
    database.close();
  }
});

test("receipt-only insertion and an exact duplicate receipt both fail closed", () => {
  const database = new DatabaseSync(":memory:");
  try {
    initializeProductSchema(database);
    const ids = insertRegisteredVisualProcess(database, "receipt_edges");
    markVisualRunning(database, ids);
    const receipt = healthReceipt(database, ids);
    assert.throws(
      () => insertHealthReceiptRow(database, ids, receipt),
      /does not match the running process/u,
    );
    assertNoVisualHealthEvidence(database, ids.processId);

    withAtomicVisualHealthContext(database, {
      processAttemptId: ids.processId,
      healthyAt: HEALTHY_AT,
    }, () => database.prepare(
      "UPDATE process_attempts SET health_at = ? WHERE id = ?",
    ).run(HEALTHY_AT, ids.processId));
    assert.throws(() => withAtomicVisualHealthContext(database, {
      processAttemptId: ids.processId,
      healthyAt: HEALTHY_AT,
    }, () => insertHealthReceiptRow(database, ids, receipt)), /UNIQUE constraint failed/u);
    assert.equal((database.prepare(
      "SELECT count(*) AS count FROM visual_health_receipts WHERE process_attempt_id = ?",
    ).get(ids.processId) as { count: number }).count, 1);
  } finally {
    database.close();
  }
});

test("authorized receipt validation rejects every mismatched identity, port, path, and timestamp without one-sided evidence", () => {
  const cases = [
    {
      name: "pid",
      receipt: { pid: 9_002 },
      row: { pid: 9_002 },
    },
    {
      name: "process_start_token",
      receipt: { processStartToken: "wrong-start-token" },
      row: { processStartToken: "wrong-start-token" },
    },
    {
      name: "process_group_id",
      receipt: { processGroupId: 9_002 },
      row: { processGroupId: 9_002 },
    },
    {
      name: "loopback_port",
      receipt: { loopbackPort: PORT + 1 },
      row: { loopbackPort: PORT + 1 },
    },
    {
      name: "health_path",
      receipt: { healthPath: "/wrong-health" },
      row: { healthPath: "/wrong-health" },
    },
    {
      name: "healthy_at",
      receipt: { healthyAt: "2026-07-25T10:00:03.000Z" },
      row: { healthyAt: "2026-07-25T10:00:03.000Z" },
    },
  ] as const;
  for (const item of cases) {
    const database = new DatabaseSync(":memory:");
    try {
      initializeProductSchema(database);
      const ids = insertRegisteredVisualProcess(database, `mismatch_${item.name}`);
      markVisualRunning(database, ids);
      database.exec("DROP TRIGGER visual_health_receipt_after_process_update_v8");
      database.exec("BEGIN IMMEDIATE");
      assert.throws(() => withAtomicVisualHealthContext(database, {
        processAttemptId: ids.processId,
        healthyAt: HEALTHY_AT,
      }, () => {
        database.prepare(
          "UPDATE process_attempts SET health_at = ? WHERE id = ?",
        ).run(HEALTHY_AT, ids.processId);
        insertHealthReceiptRow(
          database,
          ids,
          healthReceipt(database, ids, item.receipt),
          item.row,
        );
      }), /does not match the running process/u, item.name);
      database.exec("ROLLBACK");
      assertNoVisualHealthEvidence(database, ids.processId);
    } finally {
      database.close();
    }
  }
});

test("authorized receipt validation rejects cross-run and cross-attempt bindings without one-sided evidence", () => {
  for (const kind of ["cross_run", "cross_attempt"] as const) {
    const database = new DatabaseSync(":memory:");
    try {
      initializeProductSchema(database);
      const ids = insertRegisteredVisualProcess(database, `${kind}_target`);
      const other = insertRegisteredVisualProcess(database, `${kind}_other`);
      markVisualRunning(database, ids);
      database.exec("DROP TRIGGER visual_health_receipt_after_process_update_v8");
      database.exec("BEGIN IMMEDIATE");
      const receiptOverrides = kind === "cross_run"
        ? { runId: other.runId }
        : { runId: other.runId, attemptId: other.attemptId };
      const rowOverrides = kind === "cross_run"
        ? { runId: other.runId }
        : { runId: other.runId, runAttemptId: other.attemptId };
      assert.throws(() => withAtomicVisualHealthContext(database, {
        processAttemptId: ids.processId,
        healthyAt: HEALTHY_AT,
      }, () => {
        database.prepare(
          "UPDATE process_attempts SET health_at = ? WHERE id = ?",
        ).run(HEALTHY_AT, ids.processId);
        insertHealthReceiptRow(
          database,
          ids,
          healthReceipt(database, ids, receiptOverrides),
          rowOverrides,
        );
      }), /does not match the running process/u, kind);
      database.exec("ROLLBACK");
      assertNoVisualHealthEvidence(database, ids.processId);
    } finally {
      database.close();
    }
  }
});
