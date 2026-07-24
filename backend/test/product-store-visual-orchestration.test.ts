import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalDigest } from "../src/canonical-json-v2.ts";
import { planExperiment, type ExperimentPlan } from "../src/experiment-planner.ts";
import {
  openProductDatabase,
  withAtomicVisualSuccessRunContext,
} from "../src/product-schema.ts";
import { ProductRunRecovery } from "../src/product-run-recovery.ts";
import {
  ProductStoreV2,
  type ClaimedVisualRun,
  type ProductStoreV2Options,
  type RunAttemptIdentity,
  type RunLimitsV1,
  type VisualLaunchReceipt,
  type VisualProcessIdentity,
} from "../src/product-store-v2.ts";

const NOW = "2026-07-25T15:00:00.000Z";
const CLAIMED_AT = "2026-07-25T15:00:01.000Z";
const STARTED_AT = "2026-07-25T15:00:02.000Z";
const HEALTHY_AT = "2026-07-25T15:00:03.000Z";
const EXITED_AT = "2026-07-25T15:00:04.000Z";
const CLEANED_AT = "2026-07-25T15:00:05.000Z";
const FINISHED_AT = "2026-07-25T15:00:06.000Z";
const GENERATION = "d".repeat(64);
const OTHER_GENERATION = "e".repeat(64);
const CLEANUP_DIGEST = "f".repeat(64);
const PORT = 42_311;
const INPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: { horizon: { type: "integer", minimum: 1 } },
  required: ["horizon"],
  additionalProperties: false,
};
const EXECUTION = {
  schemaVersion: 2,
  runtime: "python",
  runMode: "visual",
  dependencyFile: "environment/requirements.txt",
  inputs: {
    schemaProfile: "riff-json-schema-2020-12-v1",
    schema: INPUT_SCHEMA,
    smoke: { horizon: 1 },
  },
  outputs: [{
    logicalName: "result",
    relativePath: "outputs/result.json",
    mediaType: "application/json",
    required: true,
    role: "data",
  }],
  visual: {
    entryPoint: "code/model.py",
    protocol: "riff-visual-v1",
    healthPath: "/healthz",
  },
  cancellation: { signal: "SIGTERM", graceMs: 1_000 },
};
const LIMITS: RunLimitsV1 = {
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
type Fixture = {
  parent: string;
  root: string;
  store: ProductStoreV2;
  projectId: string;
  runId: string;
  plan: ExperimentPlan;
  close(): void;
};

const createFixture = (
  suffix: string,
  options: ProductStoreV2Options = {},
): Fixture => {
  const parent = mkdtempSync(join(tmpdir(), `riff-visual-orchestration-${suffix}-`));
  const root = join(parent, "store");
  const modelId = `model_${suffix}`;
  const projectId = `project_${suffix}`;
  const experimentId = `experiment_${suffix}`;
  const runId = `run_${suffix}`;
  let store = ProductStoreV2.openForTesting(root, options);
  store.createModel({
    id: modelId,
    name: "Visual",
    technicalStatus: "executable",
    runMode: "visual",
    executionDescription: EXECUTION,
    createdAt: NOW,
    files: [
      {
        id: `file_code_${suffix}`,
        kind: "model_code",
        relativePath: "code/model.py",
        mediaType: "text/x-python",
        bytes: Buffer.from("print('visual')\n"),
      },
      {
        id: `file_environment_${suffix}`,
        kind: "model_environment",
        relativePath: "environment/requirements.txt",
        mediaType: "text/plain",
        bytes: Buffer.from(""),
      },
    ],
  });
  const project = store.createProjectFromModel({
    projectId,
    projectName: "Visual project",
    sourceModelId: modelId,
    createdAt: NOW,
  });
  const plan = planExperiment({
    configuration: {
      schemaVersion: 1,
      runKind: "visual",
      parameters: { horizon: 10 },
      sampling: { kind: "single" },
    },
    inputSchema: INPUT_SCHEMA,
    maxSamples: 1,
  });
  store.createExperimentV4({
    commandId: `command_experiment_${suffix}`,
    id: experimentId,
    projectId,
    name: "Visual experiment",
    plan,
    createdAt: NOW,
  });
  store.createFrozenRun({
    commandId: `command_start_${suffix}`,
    runId,
    projectId,
    experimentConfigId: experimentId,
    completionConversationId: null,
    expectedConfigurationDigest: plan.configurationDigest,
    plan,
    projectSnapshotDigest: project.modelSnapshotDigest,
    executionDescriptionDigest: canonicalDigest(project.executionDescription),
    limits: LIMITS,
    createdAt: NOW,
  });
  return {
    parent,
    root,
    store,
    projectId,
    runId,
    plan,
    close() {
      store.close();
      rmSync(parent, { recursive: true, force: true });
    },
  };
};

const attemptIdentity = (claim: ClaimedVisualRun): RunAttemptIdentity => ({
  runId: claim.run.id,
  attemptId: claim.attempt.id,
  attemptGeneration: claim.attempt.attemptGeneration,
  dispatcherGeneration: claim.attempt.dispatcherGeneration,
});

const claimVisual = (fixture: Fixture): ClaimedVisualRun => {
  fixture.store.activateDispatcherGeneration({
    generation: GENERATION,
    activatedAt: NOW,
  });
  assert.throws(() => fixture.store.claimNextQueuedVisualRun({
    dispatcherGeneration: OTHER_GENERATION,
    claimedAt: CLAIMED_AT,
    leaseExpiresAt: FINISHED_AT,
  }), /stale_dispatcher_generation/u);
  const claim = fixture.store.claimNextQueuedVisualRun({
    dispatcherGeneration: GENERATION,
    claimedAt: CLAIMED_AT,
    leaseExpiresAt: FINISHED_AT,
  });
  assert.ok(claim);
  assert.equal(claim.run.runKind, "visual");
  assert.equal(fixture.store.claimNextQueuedVisualRun({
    dispatcherGeneration: GENERATION,
    claimedAt: CLAIMED_AT,
    leaseExpiresAt: FINISHED_AT,
  }), null);
  return claim;
};

const completeVisualProcess = (
  fixture: Fixture,
  claim: ClaimedVisualRun,
  suffix: string,
  commitHealth: boolean,
  leaveRunning = false,
): VisualProcessIdentity => {
  const attempt = attemptIdentity(claim);
  fixture.store.markRunAttemptStarting({ ...attempt, startedAt: STARTED_AT });
  fixture.store.markRunAttemptRunning({
    ...attempt,
    startedAt: STARTED_AT,
    leaseExpiresAt: FINISHED_AT,
  });
  const sample = fixture.plan.samples[0]!;
  const scratchId = `scratch_${suffix}`;
  const relativePath = `visual-${suffix}`;
  const launch = {
    ...attempt,
    processKind: "visual" as const,
    sampleIndex: 0 as const,
    sampleId: sample.sampleId,
    scratchId,
    relativePath,
    loopbackPort: PORT,
    healthPath: EXECUTION.visual.healthPath,
  };
  const binding = fixture.store.prepareVisualProcessLaunch({
    ...launch,
    createdAt: STARTED_AT,
  });
  fixture.store.registerVisualScratchDirectory({
    ...launch,
    ownerUid: 501,
    device: 42,
    inode: 99,
    registeredAt: STARTED_AT,
  });
  const process = {
    ...attempt,
    processKind: "visual" as const,
    processAttemptId: `process_${suffix}`,
    pid: 9_101,
    processStartToken: `start-${suffix}`,
    processGroupId: 9_101,
    loopbackPort: PORT,
    scratchId,
  };
  const unsignedReceipt = {
    schemaVersion: 1 as const,
    manifestId: binding.manifestId,
    manifestDigest: binding.manifestDigest,
    runId: claim.run.id,
    sampleIndex: 0 as const,
    sampleId: sample.sampleId,
    scratchId,
    relativePath,
    pid: process.pid,
    processGroupId: process.processGroupId,
    processStartToken: process.processStartToken,
    loopbackHost: "127.0.0.1" as const,
    loopbackPort: PORT,
    healthPath: EXECUTION.visual.healthPath,
    createdAt: STARTED_AT,
  };
  const launchReceipt: VisualLaunchReceipt = Object.freeze({
    ...unsignedReceipt,
    receiptDigest: canonicalDigest(unsignedReceipt),
  });
  fixture.store.registerVisualProcessAttempt({
    ...process,
    launchReceipt,
    launchedAt: STARTED_AT,
  });
  fixture.store.markVisualProcessGateReleased({ ...process, startedAt: STARTED_AT });
  fixture.store.markVisualProcessStarted({ ...process, startedAt: STARTED_AT });
  if (commitHealth) {
    fixture.store.recordVisualProcessHealth({ ...process, healthyAt: HEALTHY_AT });
  }
  if (leaveRunning) return process;
  fixture.store.recordVisualProcessExit({
    ...process,
    expectedState: "running",
    exitedAt: EXITED_AT,
    exitCode: 0,
    exitSignal: null,
  });
  fixture.store.finalizeVisualProcessCleanup({
    ...process,
    cleanupVerified: true,
    cleanupReceiptDigest: CLEANUP_DIGEST,
    cleanedAt: CLEANED_AT,
  });
  return process;
};

const successCommit = (fixture: Fixture, claim: ClaimedVisualRun) => ({
  ...attemptIdentity(claim),
  outputs: [{
    sampleIndex: 0,
    sampleId: fixture.plan.samples[0]!.sampleId,
    logicalName: "result",
    outputType: "data",
    bytes: Buffer.from("{}"),
  }],
  terminalDiagnostics: { code: "visual_run_succeeded" },
  resourceOverview: { stdoutBytes: 0, stderrBytes: 0 },
  finishedAt: FINISHED_AT,
});

test("visual claim is generation-fenced and queued cancellation is terminal without any card", () => {
  const fixture = createFixture("claim_cancel");
  try {
    fixture.store.activateDispatcherGeneration({ generation: GENERATION, activatedAt: NOW });
    const cancel = fixture.store.cancelRun({
      commandId: "command_cancel_claim_visual",
      projectId: fixture.projectId,
      runId: fixture.runId,
      requestedAt: CLAIMED_AT,
    });
    assert.equal(cancel.code, "cancellation_requested");
    assert.equal(fixture.store.claimNextQueuedVisualRun({
      dispatcherGeneration: GENERATION,
      claimedAt: CLAIMED_AT,
      leaseExpiresAt: FINISHED_AT,
    }), null);
    const terminal = fixture.store.finalizeNextCancelledQueuedRun({ finishedAt: FINISHED_AT });
    assert.equal(terminal?.status, "cancelled");
    assert.equal(terminal?.runKind, "visual");
    assert.equal(terminal?.completionConversationId, null);
    assert.equal(terminal?.completionCardDisposition, "not_requested");
    fixture.store.close();
    const database = openProductDatabase(join(fixture.root, "product.sqlite3"));
    try {
      assert.equal((database.prepare(
        "SELECT count(*) AS count FROM run_completion_cards WHERE run_id = ?",
      ).get(fixture.runId) as { count: number }).count, 0);
      assert.equal((database.prepare(`SELECT count(*) AS count FROM messages
        WHERE message_kind = 'platform_card'
          AND json_extract(content_json, '$.runId') = ?`
      ).get(fixture.runId) as { count: number }).count, 0);
    } finally {
      database.close();
    }
  } finally {
    fixture.close();
  }
});

test("queued visual cancellation rejects a coordinated NULL completion disposition", () => {
  const fixture = createFixture("cancel_null");
  try {
    const database = openProductDatabase(join(fixture.root, "product.sqlite3"));
    try {
      database.exec("DROP TRIGGER run_visual_completion_update_v9");
      database.prepare(
        "UPDATE runs SET completion_card_disposition = NULL WHERE id = ?",
      ).run(fixture.runId);
    } finally {
      database.close();
    }
    fixture.store.cancelRun({
      commandId: "command_cancel_null_visual",
      projectId: fixture.projectId,
      runId: fixture.runId,
      requestedAt: CLAIMED_AT,
    });
    assert.throws(
      () => fixture.store.finalizeNextCancelledQueuedRun({ finishedAt: FINISHED_AT }),
      /visual_completion_invalid/u,
    );
    const run = fixture.store.getRun(
      fixture.projectId,
      fixture.runId,
    ) as unknown as { status: string; completionCardDisposition: string | null };
    assert.equal(run.status, "queued");
    assert.equal(run.completionCardDisposition, null);
  } finally {
    fixture.close();
  }
});

test("visual success rejects missing health or cleanup and publishes required outputs atomically", () => {
  const noHealth = createFixture("no_health");
  try {
    const claim = claimVisual(noHealth);
    completeVisualProcess(noHealth, claim, "no_health", false);
    assert.throws(
      () => noHealth.store.commitVisualRunSuccess(successCommit(noHealth, claim)),
      /healthy, verified-cleanup, zero-exit visual process/u,
    );
    assert.equal(noHealth.store.getRun(noHealth.projectId, noHealth.runId).status, "running");
    assert.deepEqual(noHealth.store.listRunOutputs(noHealth.runId), []);
  } finally {
    noHealth.close();
  }

  const success = createFixture("success");
  try {
    const claim = claimVisual(success);
    assert.throws(
      () => success.store.commitVisualRunSuccess(successCommit(success, claim)),
      /current running attempt|healthy, verified-cleanup/u,
    );
    completeVisualProcess(success, claim, "success", true);
    assert.throws(
      () => success.store.commitVisualRunSuccess({
        ...successCommit(success, claim),
        outputs: [],
      }),
      /required declared output is missing/u,
    );
    assert.equal(success.store.getRun(success.projectId, success.runId).status, "running");
    assert.deepEqual(success.store.listRunOutputs(success.runId), []);

    const committed = success.store.commitVisualRunSuccess(successCommit(success, claim));
    assert.equal(committed.run.status, "succeeded");
    assert.equal(committed.run.terminalCode, "visual_run_succeeded");
    assert.equal(committed.run.completionCardDisposition, "not_requested");
    assert.equal(committed.outputs.length, 1);
    assert.equal(success.store.listRunOutputs(success.runId).length, 1);
  } finally {
    success.close();
  }
});

test("visual success coordinator failure rolls back run, attempt, files, and outputs for exact retry", () => {
  let injectFault = false;
  const fixture = createFixture("atomic_retry", {
    coordinatorOptions: {
      faultInjector(point) {
        if (injectFault && point === "after_database_changes") {
          injectFault = false;
          throw new Error("injected visual success fault");
        }
      },
    },
  });
  try {
    const claim = claimVisual(fixture);
    completeVisualProcess(fixture, claim, "atomic_retry", true);
    const commit = successCommit(fixture, claim);
    injectFault = true;
    assert.throws(
      () => fixture.store.commitVisualRunSuccess(commit),
      /injected visual success fault/u,
    );
    assert.equal(fixture.store.getRun(fixture.projectId, fixture.runId).status, "running");
    assert.equal(fixture.store.listRunAttempts(fixture.runId)[0]?.state, "running");
    assert.deepEqual(fixture.store.listRunOutputs(fixture.runId), []);

    const retried = fixture.store.commitVisualRunSuccess(commit);
    assert.equal(retried.run.status, "succeeded");
    assert.equal(retried.outputs.length, 1);
  } finally {
    fixture.close();
  }
});

test("visual success rejects a coordinated second live attempt and process in Store CAS and schema trigger", () => {
  const fixture = createFixture("second_live");
  try {
    const claim = claimVisual(fixture);
    completeVisualProcess(fixture, claim, "second_live_primary", true);
    const secondAttemptId = "attempt_second_live_conflict";
    const database = openProductDatabase(join(fixture.root, "product.sqlite3"));
    try {
      database.exec("DROP INDEX one_nonterminal_run_attempt_v4");
      database.prepare(`INSERT INTO run_attempts
        (id, run_id, attempt_generation, dispatcher_generation, state,
          claimed_at, lease_expires_at)
        VALUES (?, ?, 2, ?, 'claimed', ?, ?)`
      ).run(
        secondAttemptId,
        fixture.runId,
        GENERATION,
        CLAIMED_AT,
        FINISHED_AT,
      );
    } finally {
      database.close();
    }
    const secondAttempt = fixture.store.listRunAttempts(fixture.runId)
      .find((attempt) => attempt.id === secondAttemptId);
    assert.ok(secondAttempt);
    completeVisualProcess(fixture, {
      run: claim.run,
      attempt: secondAttempt,
    }, "second_live_conflict", true, true);

    assert.throws(
      () => fixture.store.commitVisualRunSuccess(successCommit(fixture, claim)),
      /Database mutation affected an unexpected number of rows/u,
    );
    assert.equal(fixture.store.getRun(fixture.projectId, fixture.runId).status, "running");
    assert.equal(
      fixture.store.listRunAttempts(fixture.runId)
        .find((attempt) => attempt.id === claim.attempt.id)?.state,
      "running",
    );
    assert.deepEqual(fixture.store.listRunOutputs(fixture.runId), []);

    const schemaDatabase = openProductDatabase(join(fixture.root, "product.sqlite3"));
    try {
      schemaDatabase.prepare(`UPDATE run_attempts
        SET state = 'succeeded', finished_at = ?, heartbeat_at = ?
        WHERE id = ? AND state = 'running'`
      ).run(FINISHED_AT, FINISHED_AT, claim.attempt.id);
      assert.throws(() => withAtomicVisualSuccessRunContext(
        schemaDatabase,
        fixture.runId,
        () => schemaDatabase.prepare(`UPDATE runs
          SET status = 'succeeded', terminal_code = 'visual_run_succeeded',
            terminal_diagnostics_json = '{}', resource_overview_json = '{}',
            completion_card_disposition = 'not_requested',
            finished_at = ?, updated_at = ?
          WHERE id = ?`
        ).run(FINISHED_AT, FINISHED_AT, fixture.runId),
      ), /matching visual run context/u);
      assert.equal((schemaDatabase.prepare(
        "SELECT status FROM runs WHERE id = ?",
      ).get(fixture.runId) as { status: string }).status, "running");
      assert.equal((schemaDatabase.prepare(
        "SELECT count(*) AS count FROM output_indexes WHERE run_id = ?",
      ).get(fixture.runId) as { count: number }).count, 0);
    } finally {
      schemaDatabase.close();
    }
  } finally {
    fixture.close();
  }
});

test("visual success requires exactly one all-time attempt, process, and health receipt", () => {
  const fixture = createFixture("terminal_history");
  try {
    const claim = claimVisual(fixture);
    completeVisualProcess(fixture, claim, "terminal_history_primary", true);
    const historicalAttemptId = "attempt_terminal_history_conflict";
    const database = openProductDatabase(join(fixture.root, "product.sqlite3"));
    try {
      database.exec("DROP INDEX one_nonterminal_run_attempt_v4");
      database.prepare(`INSERT INTO run_attempts
        (id, run_id, attempt_generation, dispatcher_generation, state,
          claimed_at, lease_expires_at)
        VALUES (?, ?, 2, ?, 'claimed', ?, ?)`
      ).run(
        historicalAttemptId,
        fixture.runId,
        GENERATION,
        CLAIMED_AT,
        FINISHED_AT,
      );
    } finally {
      database.close();
    }
    const historicalAttempt = fixture.store.listRunAttempts(fixture.runId)
      .find((attempt) => attempt.id === historicalAttemptId);
    assert.ok(historicalAttempt);
    completeVisualProcess(fixture, {
      run: claim.run,
      attempt: historicalAttempt,
    }, "terminal_history_conflict", true);

    const terminalDatabase = openProductDatabase(join(fixture.root, "product.sqlite3"));
    try {
      terminalDatabase.prepare(`UPDATE run_attempts
        SET state = 'failed', finished_at = ?, heartbeat_at = ?
        WHERE id = ? AND state = 'running'`
      ).run(FINISHED_AT, FINISHED_AT, historicalAttemptId);
      terminalDatabase.exec(`CREATE UNIQUE INDEX one_nonterminal_run_attempt_v4
        ON run_attempts(run_id)
        WHERE state IN ('claimed', 'starting', 'running')`);
    } finally {
      terminalDatabase.close();
    }

    assert.throws(
      () => fixture.store.commitVisualRunSuccess(successCommit(fixture, claim)),
      /Database mutation affected an unexpected number of rows/u,
    );
    assert.equal(fixture.store.getRun(fixture.projectId, fixture.runId).status, "running");
    assert.equal(
      fixture.store.listRunAttempts(fixture.runId)
        .find((attempt) => attempt.id === claim.attempt.id)?.state,
      "running",
    );
    assert.deepEqual(fixture.store.listRunOutputs(fixture.runId), []);

    const schemaDatabase = openProductDatabase(join(fixture.root, "product.sqlite3"));
    try {
      schemaDatabase.prepare(`UPDATE run_attempts
        SET state = 'succeeded', finished_at = ?, heartbeat_at = ?
        WHERE id = ? AND state = 'running'`
      ).run(FINISHED_AT, FINISHED_AT, claim.attempt.id);
      assert.throws(() => withAtomicVisualSuccessRunContext(
        schemaDatabase,
        fixture.runId,
        () => schemaDatabase.prepare(`UPDATE runs
          SET status = 'succeeded', terminal_code = 'visual_run_succeeded',
            terminal_diagnostics_json = '{}', resource_overview_json = '{}',
            completion_card_disposition = 'not_requested',
            finished_at = ?, updated_at = ?
          WHERE id = ?`
        ).run(FINISHED_AT, FINISHED_AT, fixture.runId),
      ), /matching visual run context/u);
      assert.equal((schemaDatabase.prepare(
        "SELECT status FROM runs WHERE id = ?",
      ).get(fixture.runId) as { status: string }).status, "running");
      assert.deepEqual({
        ...schemaDatabase.prepare(`SELECT
          (SELECT count(*) FROM run_attempts WHERE run_id = ?) AS attempts,
          (SELECT count(*) FROM process_attempts process
            JOIN run_attempts attempt ON attempt.id = process.run_attempt_id
            WHERE attempt.run_id = ?) AS processes,
          (SELECT count(*) FROM visual_health_receipts WHERE run_id = ?) AS health`
        ).get(fixture.runId, fixture.runId, fixture.runId) as object,
      }, { attempts: 2, processes: 2, health: 2 });
      assert.equal((schemaDatabase.prepare(
        "SELECT count(*) AS count FROM output_indexes WHERE run_id = ?",
      ).get(fixture.runId) as { count: number }).count, 0);
    } finally {
      schemaDatabase.close();
    }
  } finally {
    fixture.close();
  }
});

test("visual failure terminal honors cancellation precedence and never creates completion evidence", () => {
  const fixture = createFixture("terminal_cancel");
  try {
    const claim = claimVisual(fixture);
    fixture.store.markRunAttemptStarting({
      ...attemptIdentity(claim),
      startedAt: STARTED_AT,
    });
    fixture.store.cancelRun({
      commandId: "command_cancel_running_visual",
      projectId: fixture.projectId,
      runId: fixture.runId,
      requestedAt: HEALTHY_AT,
    });
    const terminal = fixture.store.finalizeVisualRunTerminal({
      ...attemptIdentity(claim),
      expectedAttemptState: "starting",
      status: "failed",
      terminalCode: "visual_process_failed",
      terminalDiagnostics: { code: "visual_process_failed" },
      resourceOverview: {},
      finishedAt: FINISHED_AT,
    });
    assert.equal(terminal.status, "cancelled");
    assert.equal(terminal.terminalCode, "run_cancelled");
    assert.equal(terminal.completionCardDisposition, "not_requested");
    assert.equal(fixture.store.listRunAttempts(fixture.runId)[0]?.state, "cancelled");
  } finally {
    fixture.close();
  }
});

test("recovery audit rejects tampered visual success evidence before a new dispatcher generation can claim", async () => {
  for (const corruption of ["launch_receipt_identity", "health_path"] as const) {
    const fixture = createFixture(`recovered_success_${corruption}`);
    let originalClosed = false;
    let reopened: ProductStoreV2 | undefined;
    try {
      const claim = claimVisual(fixture);
      completeVisualProcess(fixture, claim, `recovered_success_${corruption}`, true);
      const committed = fixture.store.commitVisualRunSuccess(successCommit(fixture, claim));
      assert.equal(committed.run.status, "succeeded", corruption);
      assert.doesNotThrow(
        () => fixture.store.auditRecoveredVisualSuccesses(),
        corruption,
      );
      fixture.store.close();
      originalClosed = true;

      const database = openProductDatabase(join(fixture.root, "product.sqlite3"));
      try {
        if (corruption === "launch_receipt_identity") {
          const row = database.prepare(`SELECT
              manifest.id, manifest.launch_receipt_json
            FROM process_launch_manifests manifest
            JOIN run_attempts attempt ON attempt.id = manifest.run_attempt_id
            WHERE attempt.run_id = ?`
          ).get(fixture.runId) as {
            id: string;
            launch_receipt_json: string;
          };
          const receipt = JSON.parse(row.launch_receipt_json) as VisualLaunchReceipt;
          const {
            receiptDigest: _priorReceiptDigest,
            ...priorUnsigned
          } = receipt;
          const tamperedUnsigned = {
            ...priorUnsigned,
            processStartToken: `${receipt.processStartToken}-tampered`,
          };
          const tamperedReceipt: VisualLaunchReceipt = {
            ...tamperedUnsigned,
            receiptDigest: canonicalDigest(tamperedUnsigned),
          };
          database.exec(`
            DROP TRIGGER launch_manifest_terminal_immutable_v6;
            DROP TRIGGER launch_receipt_immutable_v6;
          `);
          database.prepare(`UPDATE process_launch_manifests
            SET launch_receipt_json = ?, launch_receipt_sha256 = ?
            WHERE id = ?`
          ).run(
            JSON.stringify(tamperedReceipt),
            canonicalDigest(tamperedReceipt),
            row.id,
          );
        } else {
          const row = database.prepare(`SELECT
              health.process_attempt_id, health.receipt_json
            FROM visual_health_receipts health
            JOIN run_attempts attempt ON attempt.id = health.run_attempt_id
            WHERE attempt.run_id = ?`
          ).get(fixture.runId) as {
            process_attempt_id: string;
            receipt_json: string;
          };
          const receipt = {
            ...(JSON.parse(row.receipt_json) as Record<string, unknown>),
            healthPath: "/tampered-health",
          };
          database.exec("DROP TRIGGER visual_health_receipt_immutable_v8");
          database.prepare(`UPDATE visual_health_receipts
            SET health_path = ?, receipt_json = ?, receipt_sha256 = ?
            WHERE process_attempt_id = ?`
          ).run(
            "/tampered-health",
            JSON.stringify(receipt),
            canonicalDigest(receipt),
            row.process_attempt_id,
          );
        }
      } finally {
        database.close();
      }

      reopened = ProductStoreV2.open(fixture.root);
      assert.throws(
        () => reopened!.auditRecoveredVisualSuccesses(),
        /visual_success_recovery_invalid/u,
        corruption,
      );
      await assert.rejects(
        () => new ProductRunRecovery({
          store: reopened!,
          supervisor: {},
          now: () => new Date(FINISHED_AT),
        }).recoverBeforeGenerationActivation(OTHER_GENERATION),
        /visual_success_recovery_invalid/u,
        corruption,
      );
      assert.equal(
        reopened.getRun(fixture.projectId, fixture.runId).status,
        "succeeded",
        corruption,
      );
      assert.throws(() => reopened!.claimNextQueuedVisualRun({
        dispatcherGeneration: OTHER_GENERATION,
        claimedAt: FINISHED_AT,
        leaseExpiresAt: "2026-07-25T15:01:00.000Z",
      }), /stale_dispatcher_generation/u, corruption);
    } finally {
      if (!originalClosed) fixture.store.close();
      reopened?.close();
      rmSync(fixture.parent, { recursive: true, force: true });
    }
  }
});
