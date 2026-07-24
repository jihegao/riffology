import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { canonicalDigest, parseCanonicalJsonV2 } from "../src/canonical-json-v2.ts";
import {
  initializeProductSchema,
  openProductDatabase,
  PRODUCT_SCHEMA_MIGRATIONS,
  PRODUCT_SCHEMA_SQL,
  PRODUCT_SCHEMA_V2_SQL,
  PRODUCT_SCHEMA_V3_SQL,
  PRODUCT_SCHEMA_V4_SQL,
  PRODUCT_SCHEMA_V5_SQL,
  PRODUCT_SCHEMA_V6_SQL,
  withAtomicBatchSuccessRunContext,
} from "../src/product-schema.ts";

const NOW = "2026-07-24T00:00:00.000Z";
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const SAMPLE_PLAN = JSON.stringify([{ sampleIndex: 0, sampleId: DIGEST_A, parameters: {}, seed: null }]);
const LIMITS = JSON.stringify({ schemaVersion: 1, wallTimeMs: 1_000 });
const digest = (value: string): string => canonicalDigest(parseCanonicalJsonV2(value));
const outputContractDigest = (sampleId: string, logicalName = "result"): string => canonicalDigest({
  runId: "run_alpha",
  logicalName,
  outputType: "table",
  sampleIndex: 0,
  sampleId,
  declaredRole: "table",
});

const insertModelAndProject = (database: DatabaseSync, suffix = "alpha"): void => {
  database.prepare(`INSERT INTO models
    (id, name, technical_status, run_mode, execution_description_json, created_at, updated_at)
    VALUES (?, 'Model', 'executable', 'batch', '{}', ?, ?)`
  ).run(`model_${suffix}`, NOW, NOW);
  database.prepare(`INSERT INTO projects
    (id, name, source_model_id, model_snapshot_digest, execution_description_json, created_at, updated_at)
    VALUES (?, 'Project', ?, ?, '{}', ?, ?)`
  ).run(`project_${suffix}`, `model_${suffix}`, DIGEST_A, NOW, NOW);
};

const insertV4Experiment = (database: DatabaseSync, suffix = "alpha"): void => {
  database.prepare(`INSERT INTO experiment_configurations
    (id, project_id, name, configuration_json, estimated_sample_count, created_at, updated_at,
      contract_version, configuration_sha256, sample_count)
    VALUES (?, ?, 'Base', '{}', 1, ?, ?, 4, ?, 1)`
  ).run(`experiment_${suffix}`, `project_${suffix}`, NOW, NOW, digest("{}"));
};

const insertV4Run = (database: DatabaseSync, suffix = "alpha", conversationId: string | null = null): void => {
  database.prepare(`INSERT INTO runs
    (id, project_id, experiment_configuration_id, status, frozen_configuration_json,
      requested_sample_count, created_at, updated_at, contract_version, run_kind,
      completion_conversation_id, execution_description_sha256, project_snapshot_sha256,
      frozen_configuration_sha256, sample_plan_json, sample_plan_sha256, limits_json,
      limits_sha256, start_receipt_sha256, completion_card_disposition)
    VALUES (?, ?, ?, 'queued', '{}', 1, ?, ?, 4, 'batch', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(`run_${suffix}`, `project_${suffix}`, `experiment_${suffix}`, NOW, NOW, conversationId,
    digest("{}"), DIGEST_A, digest("{}"), SAMPLE_PLAN, digest(SAMPLE_PLAN), LIMITS, digest(LIMITS), DIGEST_B,
    conversationId ? "pending" : "not_requested");
};

test("v3 execution rows migrate transactionally to read-only version-3 contracts with digests", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(PRODUCT_SCHEMA_SQL);
    database.exec(PRODUCT_SCHEMA_V2_SQL);
    database.exec(PRODUCT_SCHEMA_V3_SQL);
    database.prepare("UPDATE product_schema SET version = 3 WHERE singleton = 1").run();
    database.exec("PRAGMA user_version = 3");
    insertModelAndProject(database);
    database.prepare(`INSERT INTO experiment_configurations
      (id, project_id, name, configuration_json, estimated_sample_count, created_at, updated_at)
      VALUES ('experiment_legacy', 'project_alpha', 'Legacy', '{"seed":7}', 1, ?, ?)`
    ).run(NOW, NOW);
    database.prepare(`INSERT INTO runs
      (id, project_id, experiment_configuration_id, status, frozen_configuration_json,
        requested_sample_count, created_at, updated_at, started_at, finished_at)
      VALUES ('run_legacy', 'project_alpha', 'experiment_legacy', 'succeeded', '{"seed":7}', 1, ?, ?, ?, ?)`
    ).run(NOW, NOW, NOW, NOW);
    database.prepare(`INSERT INTO object_files
      (id, owner_run_id, kind, relative_path, media_type, size_bytes, sha256, created_at)
      VALUES ('file_legacy', 'run_legacy', 'run_file', 'result.csv', 'text/csv', 1, ?, ?)`
    ).run(DIGEST_A, NOW);
    database.prepare(`INSERT INTO output_indexes
      (id, run_id, object_file_id, logical_name, output_type, created_at)
      VALUES ('output_legacy', 'run_legacy', 'file_legacy', 'result', 'table', ?)`
    ).run(NOW);

    initializeProductSchema(database);
    assert.equal((database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 6);
    const expectedDigests = new Map([
      ["experiment_configurations", canonicalDigest({
        contractVersion: 3,
        id: "experiment_legacy",
        projectId: "project_alpha",
        name: "Legacy",
        configuration: { seed: 7 },
        estimatedSampleCount: 1,
        lifecycleState: "active",
        createdAt: NOW,
        updatedAt: NOW,
      })],
      ["runs", canonicalDigest({
        contractVersion: 3,
        id: "run_legacy",
        projectId: "project_alpha",
        experimentConfigurationId: "experiment_legacy",
        status: "succeeded",
        frozenConfiguration: { seed: 7 },
        requestedSampleCount: 1,
        createdAt: NOW,
        updatedAt: NOW,
        startedAt: NOW,
        finishedAt: NOW,
      })],
      ["output_indexes", canonicalDigest({
        contractVersion: 3,
        id: "output_legacy",
        runId: "run_legacy",
        objectFileId: "file_legacy",
        logicalName: "result",
        outputType: "table",
        createdAt: NOW,
      })],
    ]);
    for (const [table, id] of [
      ["experiment_configurations", "experiment_legacy"],
      ["runs", "run_legacy"],
      ["output_indexes", "output_legacy"],
    ] as const) {
      const row = database.prepare(`SELECT contract_version, legacy_digest FROM ${table} WHERE id = ?`).get(id) as {
        contract_version: number;
        legacy_digest: string;
      };
      assert.equal(row.contract_version, 3, table);
      assert.equal(row.legacy_digest, expectedDigests.get(table), table);
    }
    assert.throws(() => database.prepare("UPDATE experiment_configurations SET name = 'Changed' WHERE id = 'experiment_legacy'").run(),
      /legacy experiment contract is read only/u);
    assert.throws(() => database.prepare("UPDATE runs SET status = 'failed' WHERE id = 'run_legacy'").run(),
      /legacy run contract is read only/u);
    assert.throws(() => database.prepare("DELETE FROM output_indexes WHERE id = 'output_legacy'").run(),
      /legacy output contract is read only/u);
  } finally {
    database.close();
  }
});

test("v4 migration rejects ambiguous legacy run lifecycle and rolls back atomically", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(PRODUCT_SCHEMA_SQL);
    database.exec(PRODUCT_SCHEMA_V2_SQL);
    database.exec(PRODUCT_SCHEMA_V3_SQL);
    database.prepare("UPDATE product_schema SET version = 3 WHERE singleton = 1").run();
    database.exec("PRAGMA user_version = 3");
    insertModelAndProject(database);
    database.prepare(`INSERT INTO experiment_configurations
      (id, project_id, name, configuration_json, estimated_sample_count, created_at, updated_at)
      VALUES ('experiment_legacy', 'project_alpha', 'Legacy', '{}', 1, ?, ?)`
    ).run(NOW, NOW);
    database.prepare(`INSERT INTO runs
      (id, project_id, experiment_configuration_id, status, frozen_configuration_json,
        requested_sample_count, created_at, updated_at)
      VALUES ('run_legacy', 'project_alpha', 'experiment_legacy', 'succeeded', '{}', 1, ?, ?)`
    ).run(NOW, NOW);

    assert.throws(() => initializeProductSchema(database), /legacy run lifecycle is ambiguous/u);
    assert.equal((database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 3);
    assert.equal((database.prepare("SELECT version FROM product_schema WHERE singleton = 1").get() as { version: number }).version, 3);
    assert.equal((database.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>)
      .some(({ name }) => name === "contract_version"), false);
    assert.deepEqual({ ...database.prepare(
      "SELECT status, started_at, finished_at FROM runs WHERE id = 'run_legacy'",
    ).get() }, {
      status: "succeeded",
      started_at: null,
      finished_at: null,
    });
  } finally {
    database.close();
  }
});

test("canonical schema digests ignore semantic object key order and reject duplicate keys", () => {
  const database = openProductDatabase(":memory:");
  try {
    const statement = database.prepare("SELECT riff_canonical_sha256(?) AS digest");
    const left = statement.get('{"b":2,"a":1}') as { digest: string };
    const right = statement.get('{"a":1,"b":2}') as { digest: string };
    assert.equal(left.digest, right.digest);
    assert.equal(left.digest, canonicalDigest({ a: 1, b: 2 }));
    assert.throws(() => statement.get('{"a":1,"a":2}'), /invalid canonical JSON input/u);
  } finally {
    database.close();
  }
});

test("a failed v4 migration rolls back columns, tables, legacy markers, and version", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(PRODUCT_SCHEMA_SQL);
    database.exec(PRODUCT_SCHEMA_V2_SQL);
    database.exec(PRODUCT_SCHEMA_V3_SQL);
    database.prepare("UPDATE product_schema SET version = 3 WHERE singleton = 1").run();
    database.exec("PRAGMA user_version = 3");
    insertModelAndProject(database);
    database.prepare(`INSERT INTO experiment_configurations
      (id, project_id, name, configuration_json, estimated_sample_count, created_at, updated_at)
      VALUES ('experiment_legacy', 'project_alpha', 'Legacy', '{}', 1, ?, ?)`
    ).run(NOW, NOW);

    assert.throws(() => initializeProductSchema(database, [
      PRODUCT_SCHEMA_MIGRATIONS[0],
      PRODUCT_SCHEMA_MIGRATIONS[1],
      PRODUCT_SCHEMA_MIGRATIONS[2],
      { version: 4, sql: `${PRODUCT_SCHEMA_V4_SQL}\nINSERT INTO missing_v4_table VALUES (1);` },
      { version: 5, sql: PRODUCT_SCHEMA_V5_SQL },
      { version: 6, sql: PRODUCT_SCHEMA_V6_SQL },
    ]), /missing_v4_table/u);
    assert.equal((database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 3);
    assert.equal((database.prepare("SELECT version FROM product_schema WHERE singleton = 1").get() as { version: number }).version, 3);
    assert.equal((database.prepare("PRAGMA table_info(experiment_configurations)").all() as Array<{ name: string }>)
      .some(({ name }) => name === "contract_version"), false);
    assert.equal(Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'run_attempts'").get()), false);
    assert.deepEqual({ ...database.prepare("SELECT id, name FROM experiment_configurations").get() }, {
      id: "experiment_legacy",
      name: "Legacy",
    });
  } finally {
    database.close();
  }
});

test("experiment command receipts replay exact responses and reject conflicting or mutable history", () => {
  const database = openProductDatabase(":memory:");
  try {
    insertModelAndProject(database);
    insertV4Experiment(database);
    assert.throws(() => database.prepare(
      "UPDATE experiment_configurations SET configuration_json = '{\"changed\":true}' WHERE id = 'experiment_alpha'",
    ).run(), /updated experiment requires matching v4 contract fields/u);
    assert.throws(() => database.prepare(
      "UPDATE experiment_configurations SET sample_count = 2 WHERE id = 'experiment_alpha'",
    ).run(), /updated experiment requires matching v4 contract fields/u);
    const responseJson = '{"experimentId":"experiment_alpha","sampleCount":1}';
    const responseDigest = digest(responseJson);
    const insert = database.prepare(`INSERT INTO experiment_command_receipts
      (command_id, command_kind, project_id, experiment_id, intent_sha256,
        response_json, response_sha256, created_at)
      VALUES (?, 'create', 'project_alpha', 'experiment_alpha', ?, ?, ?, ?)`);
    assert.equal(insert.run("experiment-command-alpha", DIGEST_A, responseJson, responseDigest, NOW).changes, 1);

    const exactReplay = database.prepare(`INSERT INTO experiment_command_receipts
      (command_id, command_kind, project_id, experiment_id, intent_sha256,
        response_json, response_sha256, created_at)
      VALUES (?, 'create', 'project_alpha', 'experiment_alpha', ?, ?, ?, ?)
      ON CONFLICT(command_id) DO NOTHING`
    ).run("experiment-command-alpha", DIGEST_A, responseJson, responseDigest, NOW);
    assert.equal(exactReplay.changes, 0);
    assert.deepEqual({ ...database.prepare(`SELECT command_id, command_kind, project_id, experiment_id,
      intent_sha256, response_json, response_sha256, created_at
      FROM experiment_command_receipts WHERE command_id = ?`).get("experiment-command-alpha") }, {
      command_id: "experiment-command-alpha",
      command_kind: "create",
      project_id: "project_alpha",
      experiment_id: "experiment_alpha",
      intent_sha256: DIGEST_A,
      response_json: responseJson,
      response_sha256: responseDigest,
      created_at: NOW,
    });

    assert.throws(() => insert.run("experiment-command-alpha", DIGEST_B, responseJson, responseDigest, NOW),
      /UNIQUE constraint failed: experiment_command_receipts.command_id/u);
    assert.throws(() => insert.run("experiment-command-bad-digest", DIGEST_A, responseJson, DIGEST_B, NOW),
      /experiment receipt response digest mismatch/u);
    insertModelAndProject(database, "other");
    insertV4Experiment(database, "other");
    assert.throws(() => database.prepare(`INSERT INTO experiment_command_receipts
      (command_id, command_kind, project_id, experiment_id, intent_sha256,
        response_json, response_sha256, created_at)
      VALUES ('experiment-command-cross-project', 'update', 'project_other', 'experiment_alpha', ?, ?, ?, ?)`
    ).run(DIGEST_A, responseJson, responseDigest, NOW), /experiment receipt project or experiment mismatch/u);
    assert.throws(() => database.prepare(`UPDATE experiment_command_receipts
      SET response_json = '{"experimentId":"changed"}'
      WHERE command_id = 'experiment-command-alpha'`).run(), /experiment receipt is immutable/u);
    assert.throws(() => database.prepare(`DELETE FROM experiment_command_receipts
      WHERE command_id = 'experiment-command-alpha'`).run(), /experiment receipt is immutable/u);
  } finally {
    database.close();
  }
});

test("v4 frozen runs, attempts, process identities, commands, and receipts fail closed", () => {
  const database = openProductDatabase(":memory:");
  try {
    insertModelAndProject(database);
    insertV4Experiment(database);
    assert.throws(() => database.prepare(`INSERT INTO experiment_configurations
      (id, project_id, name, configuration_json, estimated_sample_count, created_at, updated_at)
      VALUES ('experiment_missing_v4', 'project_alpha', 'Bad', '{}', 1, ?, ?)`
    ).run(NOW, NOW), /new experiment requires v4 contract fields/u);

    insertModelAndProject(database, "other");
    database.prepare(`INSERT INTO conversations
      (id, project_id, name, provider_id, provider_model_id, created_at, updated_at)
      VALUES ('conversation_other', 'project_other', 'Other', 'provider', 'model', ?, ?)`
    ).run(NOW, NOW);
    assert.throws(() => insertV4Run(database, "alpha", "conversation_other"), /run completion conversation project mismatch/u);
    insertV4Run(database);
    assert.throws(() => database.prepare("UPDATE runs SET sample_plan_sha256 = ? WHERE id = 'run_alpha'").run(DIGEST_B),
      /run frozen contract is immutable/u);
    assert.throws(() => database.prepare(
      "UPDATE runs SET terminal_code = 'premature' WHERE id = 'run_alpha'",
    ).run(), /v4 run (?:evidence does not match status|terminal evidence requires one terminal transition)/u);
    assert.throws(() => database.prepare("UPDATE runs SET status = 'succeeded' WHERE id = 'run_alpha'").run(),
      /v4 run success requires atomic batch success context/u);
    assert.throws(() => database.prepare(`INSERT INTO object_files
      (id, owner_run_id, kind, relative_path, media_type, size_bytes, sha256, created_at)
      VALUES ('file_output_v4', 'run_alpha', 'run_file', 'result.csv', 'text/csv', 1, ?, ?)`
    ).run(DIGEST_A, NOW), /v4 run output object requires atomic successful terminal context/u);

    database.prepare("INSERT INTO dispatcher_state (singleton, generation, activated_at) VALUES (1, ?, ?)")
      .run(DIGEST_A, NOW);
    database.prepare(`INSERT INTO run_attempts
      (id, run_id, attempt_generation, dispatcher_generation, state, claimed_at, lease_expires_at)
      VALUES ('attempt_alpha', 'run_alpha', 1, ?, 'claimed', ?, ?)`
    ).run(DIGEST_A, NOW, NOW);
    assert.throws(() => database.prepare(`INSERT INTO run_attempts
      (id, run_id, attempt_generation, dispatcher_generation, state, claimed_at,
        lease_expires_at, finished_at)
      VALUES ('attempt_terminal_insert', 'run_alpha', 2, ?, 'failed', ?, ?, ?)`
    ).run(DIGEST_A, NOW, NOW, NOW), /new run attempt requires claimed evidence shape|UNIQUE constraint failed/u);
    assert.throws(() => database.prepare(`INSERT INTO run_attempts
      (id, run_id, attempt_generation, dispatcher_generation, state, claimed_at, lease_expires_at)
      VALUES ('attempt_duplicate', 'run_alpha', 2, ?, 'claimed', ?, ?)`
    ).run(DIGEST_A, NOW, NOW), /UNIQUE constraint failed/u);
    database.prepare(
      "UPDATE runs SET status = 'running', started_at = ?, updated_at = ? WHERE id = 'run_alpha'",
    ).run(NOW, NOW);
    database.prepare(
      "UPDATE run_attempts SET state = 'starting', started_at = ? WHERE id = 'attempt_alpha'",
    ).run(NOW);
    database.prepare(
      "UPDATE run_attempts SET state = 'running', heartbeat_at = ? WHERE id = 'attempt_alpha'",
    ).run(NOW);
    assert.throws(() => database.prepare(`INSERT INTO object_files
      (id, owner_run_id, kind, relative_path, media_type, size_bytes, sha256, created_at)
      VALUES ('file_running_raw', 'run_alpha', 'run_file', 'running-raw.json',
        'application/json', 1, ?, ?)`
    ).run(DIGEST_A, NOW), /v4 run output object requires atomic successful terminal context/u);

    const launchManifest = {
      schemaVersion: 1,
      kind: "batch_process_launch",
      runId: "run_alpha",
      attemptId: "attempt_alpha",
      attemptGeneration: 1,
      dispatcherGeneration: DIGEST_A,
      sampleIndex: 0,
      sampleId: DIGEST_A,
      scratchId: "scratch_alpha",
      relativePath: "synthetic-process-alpha",
    };
    const launchManifestDigest = canonicalDigest(launchManifest);
    const launchManifestId = `launch_${launchManifestDigest.slice(0, 32)}`;
    const unsignedLaunchReceipt = {
      schemaVersion: 1,
      manifestId: launchManifestId,
      manifestDigest: launchManifestDigest,
      runId: "run_alpha",
      sampleIndex: 0,
      sampleId: DIGEST_A,
      scratchId: "scratch_alpha",
      relativePath: "synthetic-process-alpha",
      pid: 101,
      processGroupId: 101,
      processStartToken: "start-101",
      createdAt: NOW,
    };
    const launchReceipt = {
      ...unsignedLaunchReceipt,
      receiptDigest: canonicalDigest(unsignedLaunchReceipt),
    };
    database.prepare(`INSERT INTO run_scratch_leases
      (id, run_id, run_attempt_id, dispatcher_generation, sample_index, sample_id,
        relative_path, state, owner_uid, device, inode, created_at, registered_at)
      VALUES ('scratch_alpha', 'run_alpha', 'attempt_alpha', ?, 0, ?,
        'synthetic-process-alpha', 'active', 0, 0, 1, ?, ?)`
    ).run(DIGEST_A, DIGEST_A, NOW, NOW);
    database.prepare(`INSERT INTO process_launch_manifests
      (id, run_attempt_id, scratch_lease_id, process_attempt_id, state,
        manifest_json, manifest_sha256, launch_receipt_json, launch_receipt_sha256,
        created_at, registered_at)
      VALUES (?, 'attempt_alpha', 'scratch_alpha', 'process_alpha', 'registered',
        ?, ?, ?, ?, ?, ?)`
    ).run(
      launchManifestId,
      JSON.stringify(launchManifest),
      launchManifestDigest,
      JSON.stringify(launchReceipt),
      canonicalDigest(launchReceipt),
      NOW,
      NOW,
    );
    database.prepare(`INSERT INTO process_attempts
      (id, run_attempt_id, process_kind, sample_index, sample_id, pid, process_start_token,
        process_group_id, launch_gate_state, state, launched_at)
      VALUES ('process_alpha', 'attempt_alpha', 'batch', 0, ?, 101, 'start-101', 101, 'blocked', 'blocked', ?)`
    ).run(DIGEST_A, NOW);
    assert.throws(() => database.prepare(`INSERT INTO process_attempts
      (id, run_attempt_id, process_kind, sample_index, sample_id, pid, process_start_token,
        process_group_id, launch_gate_state, state, launched_at)
      VALUES ('process_bad_sample', 'attempt_alpha', 'batch', 0, ?, 102, 'start-102', 102, 'blocked', 'blocked', ?)`
    ).run(DIGEST_B, NOW), /process attempt run or sample mismatch|UNIQUE constraint failed|durable launch manifest/u);
    assert.throws(() => database.prepare(`INSERT INTO process_attempts
      (id, run_attempt_id, process_kind, sample_index, sample_id, pid, process_start_token,
        process_group_id, launch_gate_state, state, launched_at, exited_at, exit_code)
      VALUES ('process_prefilled_exit', 'attempt_alpha', 'batch', 0, ?, 102, 'start-102', 102,
        'blocked', 'blocked', ?, ?, 0)`
    ).run(DIGEST_A, NOW, NOW), /new process attempt requires blocked evidence shape|UNIQUE constraint failed|durable launch manifest/u);
    assert.throws(() => database.prepare("UPDATE process_attempts SET pid = 999 WHERE id = 'process_alpha'").run(),
      /process attempt identity is immutable/u);
    assert.throws(() => database.prepare(
      "UPDATE process_attempts SET state = 'released' WHERE id = 'process_alpha'",
    ).run(), /process attempt evidence does not match gate and state|CHECK constraint failed/u);
    assert.throws(() => database.prepare(
      "UPDATE process_attempts SET exited_at = ?, exit_code = 0 WHERE id = 'process_alpha'",
    ).run(NOW), /process exit evidence requires one exited transition|process attempt evidence does not match gate and state/u);
    database.prepare(
      `UPDATE process_attempts
        SET launch_gate_state = 'released', state = 'released', started_at = ?
        WHERE id = 'process_alpha'`,
    ).run(NOW);
    database.prepare(
      "UPDATE process_attempts SET state = 'running', heartbeat_at = ? WHERE id = 'process_alpha'",
    ).run(NOW);
    database.prepare(
      "UPDATE process_attempts SET state = 'exited', exited_at = ?, exit_code = 0 WHERE id = 'process_alpha'",
    ).run(NOW);
    assert.throws(() => database.prepare(
      "UPDATE process_attempts SET exit_code = 1 WHERE id = 'process_alpha'",
    ).run(), /process exit evidence requires one exited transition/u);
    database.prepare(
      "UPDATE process_attempts SET state = 'cleanup_complete', cleanup_receipt_sha256 = ? WHERE id = 'process_alpha'",
    ).run(DIGEST_A);
    assert.throws(() => database.prepare(
      "UPDATE process_attempts SET heartbeat_at = ? WHERE id = 'process_alpha'",
    ).run(DIGEST_B), /terminal process attempt is immutable/u);

    insertModelAndProject(database, "unverified");
    insertV4Experiment(database, "unverified");
    insertV4Run(database, "unverified");
    database.prepare(`INSERT INTO run_attempts
      (id, run_id, attempt_generation, dispatcher_generation, state, claimed_at, lease_expires_at)
      VALUES ('attempt_unverified', 'run_unverified', 1, ?, 'claimed', ?, ?)`
    ).run(DIGEST_A, NOW, NOW);
    database.prepare(
      "UPDATE runs SET status = 'running', started_at = ?, updated_at = ? WHERE id = 'run_unverified'",
    ).run(NOW, NOW);
    database.prepare(
      "UPDATE run_attempts SET state = 'starting', started_at = ? WHERE id = 'attempt_unverified'",
    ).run(NOW);
    database.prepare(
      "UPDATE run_attempts SET state = 'running', heartbeat_at = ? WHERE id = 'attempt_unverified'",
    ).run(NOW);
    const unverifiedManifest = {
      schemaVersion: 1,
      kind: "batch_process_launch",
      runId: "run_unverified",
      attemptId: "attempt_unverified",
      attemptGeneration: 1,
      dispatcherGeneration: DIGEST_A,
      sampleIndex: 0,
      sampleId: DIGEST_A,
      scratchId: "scratch_unverified",
      relativePath: "synthetic-process-unverified",
    };
    const unverifiedManifestDigest = canonicalDigest(unverifiedManifest);
    const unverifiedManifestId = `launch_${unverifiedManifestDigest.slice(0, 32)}`;
    const unsignedUnverifiedReceipt = {
      schemaVersion: 1,
      manifestId: unverifiedManifestId,
      manifestDigest: unverifiedManifestDigest,
      runId: "run_unverified",
      sampleIndex: 0,
      sampleId: DIGEST_A,
      scratchId: "scratch_unverified",
      relativePath: "synthetic-process-unverified",
      pid: 202,
      processGroupId: 202,
      processStartToken: "start-202",
      createdAt: NOW,
    };
    const unverifiedReceipt = {
      ...unsignedUnverifiedReceipt,
      receiptDigest: canonicalDigest(unsignedUnverifiedReceipt),
    };
    database.prepare(`INSERT INTO run_scratch_leases
      (id, run_id, run_attempt_id, dispatcher_generation, sample_index, sample_id,
        relative_path, state, owner_uid, device, inode, created_at, registered_at)
      VALUES ('scratch_unverified', 'run_unverified', 'attempt_unverified', ?, 0, ?,
        'synthetic-process-unverified', 'active', 0, 0, 2, ?, ?)`
    ).run(DIGEST_A, DIGEST_A, NOW, NOW);
    database.prepare(`INSERT INTO process_launch_manifests
      (id, run_attempt_id, scratch_lease_id, process_attempt_id, state,
        manifest_json, manifest_sha256, launch_receipt_json, launch_receipt_sha256,
        created_at, registered_at)
      VALUES (?, 'attempt_unverified', 'scratch_unverified',
        'process_unverified', 'registered', ?, ?, ?, ?, ?, ?)`
    ).run(
      unverifiedManifestId,
      JSON.stringify(unverifiedManifest),
      unverifiedManifestDigest,
      JSON.stringify(unverifiedReceipt),
      canonicalDigest(unverifiedReceipt),
      NOW,
      NOW,
    );
    database.prepare(`INSERT INTO process_attempts
      (id, run_attempt_id, process_kind, sample_index, sample_id, pid, process_start_token,
        process_group_id, launch_gate_state, state, launched_at)
      VALUES ('process_unverified', 'attempt_unverified', 'batch', 0, ?, 202, 'start-202',
        202, 'blocked', 'blocked', ?)`
    ).run(DIGEST_A, NOW);
    database.prepare(`UPDATE process_attempts
      SET launch_gate_state = 'released', state = 'released', started_at = ?
      WHERE id = 'process_unverified'`
    ).run(NOW);
    database.prepare(
      "UPDATE process_attempts SET state = 'running', heartbeat_at = ? WHERE id = 'process_unverified'",
    ).run(NOW);
    database.prepare(`UPDATE process_attempts
      SET state = 'exited', exited_at = ?, exit_code = NULL, exit_signal = 'SIGKILL'
      WHERE id = 'process_unverified'`
    ).run(NOW);
    database.prepare(
      "UPDATE process_attempts SET state = 'cleanup_unverified' WHERE id = 'process_unverified'",
    ).run();
    for (const statement of [
      "UPDATE process_attempts SET heartbeat_at = 'later' WHERE id = 'process_unverified'",
      "UPDATE process_attempts SET started_at = 'later' WHERE id = 'process_unverified'",
      "UPDATE process_attempts SET launch_gate_state = 'timed_out' WHERE id = 'process_unverified'",
      "UPDATE process_attempts SET exit_signal = 'SIGTERM' WHERE id = 'process_unverified'",
      `UPDATE process_attempts SET cleanup_receipt_sha256 = '${DIGEST_B}' WHERE id = 'process_unverified'`,
    ]) assert.throws(() => database.prepare(statement).run(), /terminal process attempt is immutable/u);

    assert.throws(() => database.prepare(`UPDATE runs
      SET terminal_code = 'premature', terminal_diagnostics_json = '{}',
        resource_overview_json = '{}', finished_at = ?
      WHERE id = 'run_alpha'`
    ).run(NOW), /v4 run terminal evidence requires one terminal transition|v4 run evidence does not match status/u);
    withAtomicBatchSuccessRunContext(database, "run_alpha", () => {
      database.prepare(
        `UPDATE run_attempts
          SET state = 'succeeded', finished_at = ?, heartbeat_at = ?
          WHERE id = 'attempt_alpha'`,
      ).run(NOW, NOW);
      database.prepare(`UPDATE runs
        SET status = 'succeeded', terminal_code = 'run_succeeded',
          terminal_diagnostics_json = '{}', resource_overview_json = '{}',
          finished_at = ?, updated_at = ?
        WHERE id = 'run_alpha'`
      ).run(NOW, NOW);
      database.prepare(`INSERT INTO object_files
        (id, owner_run_id, kind, relative_path, media_type, size_bytes, sha256, created_at)
        VALUES ('file_output_v4', 'run_alpha', 'run_file', 'result.csv', 'text/csv', 1, ?, ?)`
      ).run(DIGEST_A, NOW);
      assert.throws(() => database.prepare(`INSERT INTO output_indexes
        (id, run_id, object_file_id, logical_name, output_type, contract_version,
          sample_index, sample_id, declared_role, output_contract_sha256, created_at)
        VALUES ('output_bad_sample', 'run_alpha', 'file_output_v4', 'result', 'table', 4, 0, ?, 'table', ?, ?)`
      ).run(DIGEST_B, outputContractDigest(DIGEST_B), NOW), /new output requires atomic v4 run success/u);
      database.prepare(`INSERT INTO output_indexes
        (id, run_id, object_file_id, logical_name, output_type, contract_version,
          sample_index, sample_id, declared_role, output_contract_sha256, created_at)
        VALUES ('output_v4', 'run_alpha', 'file_output_v4', 'result', 'table', 4, 0, ?, 'table', ?, ?)`
      ).run(DIGEST_A, outputContractDigest(DIGEST_A), NOW);
    });
    assert.throws(() => database.prepare(`INSERT INTO output_indexes
      (id, run_id, object_file_id, logical_name, output_type, contract_version,
        sample_index, sample_id, declared_role, output_contract_sha256, created_at)
      VALUES ('output_after_commit', 'run_alpha', 'file_output_v4', 'result-2', 'table', 4, 0, ?, 'table', ?, ?)`
    ).run(DIGEST_A, outputContractDigest(DIGEST_A, "result-2"), NOW), /new output requires atomic v4 run success/u);
    for (const statement of [
      "UPDATE output_indexes SET logical_name = 'changed' WHERE id = 'output_v4'",
      "UPDATE output_indexes SET output_type = 'document' WHERE id = 'output_v4'",
      "UPDATE output_indexes SET declared_role = 'document' WHERE id = 'output_v4'",
    ]) assert.throws(() => database.prepare(statement).run(), /output binding is immutable/u);
    assert.throws(() => database.prepare(
      "UPDATE runs SET terminal_code = 'changed' WHERE id = 'run_alpha'",
    ).run(), /v4 run terminal evidence is immutable/u);
    assert.throws(() => database.prepare(
      "UPDATE run_attempts SET heartbeat_at = ? WHERE id = 'attempt_alpha'",
    ).run(DIGEST_B), /terminal run attempt is immutable/u);

    insertModelAndProject(database, "failed");
    insertV4Experiment(database, "failed");
    insertV4Run(database, "failed");
    database.prepare(`UPDATE runs
      SET status = 'failed', terminal_code = 'admission_failed',
        terminal_diagnostics_json = '{}', resource_overview_json = '{}',
        finished_at = ?, updated_at = ?
      WHERE id = 'run_failed'`
    ).run(NOW, NOW);
    assert.throws(() => database.prepare(`INSERT INTO object_files
      (id, owner_run_id, kind, relative_path, media_type, size_bytes, sha256, created_at)
      VALUES ('file_failed_raw', 'run_failed', 'run_file', 'failed-raw.json',
        'application/json', 1, ?, ?)`
    ).run(DIGEST_A, NOW), /v4 run output object requires atomic successful terminal context/u);
    assert.throws(() => database.prepare(`INSERT INTO output_indexes
      (id, run_id, object_file_id, logical_name, output_type, contract_version,
        sample_index, sample_id, declared_role, output_contract_sha256, created_at)
      VALUES ('output_failed_raw', 'run_failed', 'file_output_v4', 'result', 'table',
        4, 0, ?, 'table', ?, ?)`
    ).run(DIGEST_A, canonicalDigest({
      runId: "run_failed",
      logicalName: "result",
      outputType: "table",
      sampleIndex: 0,
      sampleId: DIGEST_A,
      declaredRole: "table",
    }), NOW), /new output requires atomic v4 run success|output object ownership mismatch/u);

    database.prepare(`INSERT INTO run_commands
      (id, run_id, command_kind, request_key, intent_sha256, state, outcome_json, created_at, updated_at)
      VALUES ('command_alpha', 'run_alpha', 'start', 'start-once', ?, 'committed', '{}', ?, ?)`
    ).run(DIGEST_A, NOW, NOW);
    database.prepare(`INSERT INTO run_command_receipts
      (id, run_id, command_id, receipt_kind, payload_sha256, payload_json, committed_at)
      VALUES ('receipt_alpha', 'run_alpha', 'command_alpha', 'run_created', ?, '{}', ?)`
    ).run(digest("{}"), NOW);
    assert.throws(() => database.prepare(`INSERT INTO run_command_receipts
      (id, run_id, command_id, receipt_kind, payload_sha256, payload_json, committed_at)
      VALUES ('receipt_bad_digest', 'run_alpha', 'command_alpha', 'run_created', ?, '{}', ?)`
    ).run(DIGEST_A, NOW), /run receipt payload digest mismatch/u);
    assert.throws(() => database.prepare("UPDATE run_command_receipts SET receipt_kind = 'changed' WHERE id = 'receipt_alpha'").run(),
      /run receipt is immutable/u);
    database.prepare(`UPDATE runs
      SET status = 'trashed', pre_trash_status = 'succeeded', trashed_at = ?
      WHERE id = 'run_alpha'`
    ).run(NOW);
    assert.throws(() => database.prepare(
      "UPDATE runs SET terminal_diagnostics_json = '{\"changed\":true}' WHERE id = 'run_alpha'",
    ).run(), /v4 run terminal evidence is immutable/u);
  } finally {
    database.close();
  }
});
