import assert from "node:assert/strict";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalDigest, canonicalJsonV2 } from "../src/canonical-json-v2.ts";
import { planExperiment, type ExperimentPlan } from "../src/experiment-planner.ts";
import {
  ProductRunRecovery,
  type ProductRunRecoverySupervisorPort,
} from "../src/product-run-recovery.ts";
import { openProductDatabase } from "../src/product-schema.ts";
import {
  ProductStoreV2,
  type RunAttemptIdentity,
  type RunLimitsV1,
  type VisualLaunchIdentity,
  type VisualLaunchReceipt,
  type VisualProcessIdentity,
} from "../src/product-store-v2.ts";
import type {
  RecoveredProcessTerminationReceipt,
  RecoveredScratchCleanupReceipt,
} from "../src/generic-batch-supervisor.ts";
import { GenericBatchSupervisor } from "../src/generic-batch-supervisor.ts";

const NOW = "2026-07-25T13:00:00.000Z";
const STARTED_AT = "2026-07-25T13:00:01.000Z";
const HEALTHY_AT = "2026-07-25T13:00:02.000Z";
const RECOVERED_AT = "2026-07-25T13:00:10.000Z";
const A = "a".repeat(64);
const B = "b".repeat(64);
const CLEANUP_DIGEST = "c".repeat(64);
const PORT = 42_731;
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
const json = (value: unknown): string => canonicalJsonV2(value).toString("utf8");

type Fixture = Readonly<{
  parent: string;
  root: string;
  store: ProductStoreV2;
  projectId: string;
  runId: string;
  plan: ExperimentPlan;
  attempt: RunAttemptIdentity;
  launch: VisualLaunchIdentity;
  process: VisualProcessIdentity;
}>;

type Checkpoint =
  | "planned"
  | "created"
  | "receipt_before_adoption"
  | "registered"
  | "released"
  | "running"
  | "healthy"
  | "exited"
  | "cleanup_complete";

const createFixture = (suffix: string): Fixture => {
  const parent = mkdtempSync(join(tmpdir(), `riff-visual-recovery-${suffix}-`));
  const root = join(parent, "store");
  const projectId = `project_visual_recovery_${suffix}`;
  const experimentId = `experiment_visual_recovery_${suffix}`;
  const runId = `run_visual_recovery_${suffix}`;
  const attemptId = `attempt_visual_recovery_${suffix}`;
  let store = ProductStoreV2.open(root);
  store.createModel({
    id: `model_visual_recovery_${suffix}`,
    name: "Visual recovery",
    technicalStatus: "executable",
    runMode: "visual",
    executionDescription: EXECUTION,
    createdAt: NOW,
    files: [
      {
        id: `file_visual_recovery_code_${suffix}`,
        kind: "model_code",
        relativePath: "code/model.py",
        mediaType: "text/x-python",
        bytes: Buffer.from("print('visual')\n"),
      },
      {
        id: `file_visual_recovery_env_${suffix}`,
        kind: "model_environment",
        relativePath: "environment/requirements.txt",
        mediaType: "text/plain",
        bytes: Buffer.from(""),
      },
    ],
  });
  const project = store.createProjectFromModel({
    projectId,
    projectName: "Visual recovery",
    sourceModelId: `model_visual_recovery_${suffix}`,
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
    commandId: `command_visual_recovery_experiment_${suffix}`,
    id: experimentId,
    projectId,
    name: "Visual recovery",
    plan,
    createdAt: NOW,
  });
  store.close();

  const database = openProductDatabase(join(root, "product.sqlite3"));
  try {
    database.prepare(`INSERT INTO runs
      (id, project_id, experiment_configuration_id, status, frozen_configuration_json,
        requested_sample_count, created_at, updated_at, contract_version, run_kind,
        completion_conversation_id, execution_description_sha256, project_snapshot_sha256,
        frozen_configuration_sha256, sample_plan_json, sample_plan_sha256, limits_json,
        limits_sha256, start_receipt_sha256, completion_card_disposition)
      VALUES (?, ?, ?, 'queued', ?, 1, ?, ?, 4, 'visual', NULL, ?, ?, ?, ?, ?, ?, ?, ?,
        'not_requested')`
    ).run(
      runId,
      projectId,
      experimentId,
      json(plan.configuration),
      NOW,
      NOW,
      canonicalDigest(project.executionDescription),
      project.modelSnapshotDigest,
      plan.configurationDigest,
      json(plan.samples),
      plan.samplePlanDigest,
      json(LIMITS),
      canonicalDigest(LIMITS),
      CLEANUP_DIGEST,
    );
    database.prepare(
      "INSERT INTO dispatcher_state (singleton, generation, activated_at) VALUES (1, ?, ?)",
    ).run(A, NOW);
    database.prepare(`INSERT INTO run_attempts
      (id, run_id, attempt_generation, dispatcher_generation, state,
        claimed_at, lease_expires_at)
      VALUES (?, ?, 1, ?, 'claimed', ?, ?)`
    ).run(
      attemptId,
      runId,
      A,
      NOW,
      "2026-07-25T13:01:00.000Z",
    );
    database.prepare(
      "UPDATE runs SET status = 'running', started_at = ?, updated_at = ? WHERE id = ?",
    ).run(STARTED_AT, STARTED_AT, runId);
    database.prepare(
      "UPDATE run_attempts SET state = 'starting', started_at = ? WHERE id = ?",
    ).run(STARTED_AT, attemptId);
    database.prepare(
      "UPDATE run_attempts SET state = 'running', heartbeat_at = ? WHERE id = ?",
    ).run(STARTED_AT, attemptId);
  } finally {
    database.close();
  }
  store = ProductStoreV2.open(root);
  const attempt = {
    runId,
    attemptId,
    attemptGeneration: 1,
    dispatcherGeneration: A,
  } as const;
  const sample = plan.samples[0]!;
  const launch = {
    ...attempt,
    processKind: "visual",
    sampleIndex: 0,
    sampleId: sample.sampleId,
    scratchId: `scratch_visual_recovery_${suffix}`,
    relativePath: `visual-recovery-${suffix}`,
    loopbackPort: PORT,
    healthPath: EXECUTION.visual.healthPath,
  } as const;
  const process = {
    ...attempt,
    processKind: "visual",
    processAttemptId: `process_${canonicalDigest({
      runId,
      attemptGeneration: 1,
      sampleIndex: 0,
    }).slice(0, 32)}`,
    pid: 10_731,
    processStartToken: `visual-recovery-start-${suffix}`,
    processGroupId: 10_731,
    loopbackPort: PORT,
    scratchId: launch.scratchId,
  } as const;
  return { parent, root, store, projectId, runId, plan, attempt, launch, process };
};

const launchReceipt = (
  fixture: Fixture,
  binding: Readonly<{ manifestId: string; manifestDigest: string }>,
): VisualLaunchReceipt => {
  const unsigned = {
    schemaVersion: 1 as const,
    manifestId: binding.manifestId,
    manifestDigest: binding.manifestDigest,
    runId: fixture.runId,
    sampleIndex: 0 as const,
    sampleId: fixture.launch.sampleId,
    scratchId: fixture.launch.scratchId,
    relativePath: fixture.launch.relativePath,
    pid: fixture.process.pid,
    processGroupId: fixture.process.processGroupId,
    processStartToken: fixture.process.processStartToken,
    loopbackHost: "127.0.0.1" as const,
    loopbackPort: fixture.process.loopbackPort,
    healthPath: fixture.launch.healthPath,
    createdAt: STARTED_AT,
  };
  return Object.freeze({ ...unsigned, receiptDigest: canonicalDigest(unsigned) });
};

const prepareCheckpoint = (
  fixture: Fixture,
  checkpoint: Checkpoint,
): VisualLaunchReceipt => {
  const binding = fixture.store.prepareVisualProcessLaunch({
    ...fixture.launch,
    createdAt: NOW,
  });
  const receipt = launchReceipt(fixture, binding);
  if (checkpoint === "planned") return receipt;
  fixture.store.registerVisualScratchDirectory({
    ...fixture.launch,
    ownerUid: 501,
    device: 42,
    inode: 99,
    registeredAt: STARTED_AT,
  });
  if (checkpoint === "created" || checkpoint === "receipt_before_adoption") return receipt;
  fixture.store.registerVisualProcessAttempt({
    ...fixture.process,
    launchReceipt: receipt,
    launchedAt: STARTED_AT,
  });
  if (checkpoint === "registered") return receipt;
  fixture.store.markVisualProcessGateReleased({
    ...fixture.process,
    startedAt: STARTED_AT,
  });
  if (checkpoint === "released") return receipt;
  fixture.store.markVisualProcessStarted({
    ...fixture.process,
    startedAt: STARTED_AT,
  });
  if (checkpoint === "running") return receipt;
  if (checkpoint === "healthy") {
    fixture.store.recordVisualProcessHealth({
      ...fixture.process,
      healthyAt: HEALTHY_AT,
    });
    return receipt;
  }
  fixture.store.recordVisualProcessExit({
    ...fixture.process,
    expectedState: "running",
    exitedAt: HEALTHY_AT,
    exitCode: 0,
    exitSignal: null,
  });
  if (checkpoint === "exited") return receipt;
  fixture.store.finalizeVisualProcessCleanup({
    ...fixture.process,
    cleanupVerified: true,
    cleanupReceiptDigest: CLEANUP_DIGEST,
    cleanedAt: HEALTHY_AT,
  });
  return receipt;
};

const recoverySupervisor = (
  calls: string[],
  durableReceipt: VisualLaunchReceipt | null = null,
): ProductRunRecoverySupervisorPort => ({
  inspectRecordedProcess() {
    calls.push("inspect");
    return "present";
  },
  async terminateRecordedProcess(
    identity,
    _graceMs,
    observedAt,
  ): Promise<RecoveredProcessTerminationReceipt> {
    calls.push("terminate");
    const unsigned = {
      schemaVersion: 1 as const,
      runId: identity.runId,
      sampleIndex: identity.sampleIndex,
      sampleId: identity.sampleId,
      scratchId: identity.scratchId,
      pid: identity.pid,
      processGroupId: identity.processGroupId,
      processStartToken: identity.startToken,
      termSent: true,
      killSent: false,
      groupGone: true as const,
      observedAt,
    };
    return { ...unsigned, receiptDigest: canonicalDigest(unsigned) };
  },
  verifyRecordedProcessGroupGone() {
    calls.push("gone");
    return true;
  },
  readDurableLaunchReceipt() {
    calls.push("receipt");
    return durableReceipt;
  },
  cleanupDurableScratch(lease, cleanedAt): RecoveredScratchCleanupReceipt {
    calls.push("scratch");
    return scratchReceipt(lease, cleanedAt, "removed");
  },
  cleanupPlannedScratch(plan, cleanedAt): RecoveredScratchCleanupReceipt {
    calls.push("planned");
    return scratchReceipt(plan, cleanedAt, "already_absent");
  },
});

const scratchReceipt = (
  plan: {
    runId: string;
    sampleIndex: number;
    sampleId: string;
    scratchId: string;
    relativePath: string;
  },
  cleanedAt: string,
  disposition: "removed" | "already_absent",
): RecoveredScratchCleanupReceipt => {
  const unsigned = {
    schemaVersion: 1 as const,
    runId: plan.runId,
    sampleIndex: plan.sampleIndex,
    sampleId: plan.sampleId,
    scratchId: plan.scratchId,
    relativePath: plan.relativePath,
    disposition,
    cleanedAt,
    verified: true as const,
  };
  return { ...unsigned, receiptDigest: canonicalDigest(unsigned) };
};

const assertPrivateVisualCompletion = (
  fixture: Fixture,
  expectedStatus: "failed" | "cancelled",
): void => {
  const run = fixture.store.getRun(fixture.projectId, fixture.runId);
  assert.equal(run.status, expectedStatus);
  assert.equal(run.completionConversationId, null);
  assert.equal(run.completionCardDisposition, "not_requested");
  const database = openProductDatabase(join(fixture.root, "product.sqlite3"));
  try {
    assert.equal(Number((database.prepare(
      "SELECT count(*) AS count FROM run_completion_cards WHERE run_id = ?",
    ).get(fixture.runId) as { count: number }).count), 0);
    assert.equal(Number((database.prepare(`SELECT count(*) AS count FROM messages
      WHERE message_kind = 'platform_card' AND json_valid(content_json)
        AND json_extract(content_json, '$.runId') = ?`
    ).get(fixture.runId) as { count: number }).count), 0);
  } finally {
    database.close();
  }
};

test("visual recovery converges every durable checkpoint with fake process supervision", async () => {
  for (const checkpoint of [
    "planned",
    "receipt_before_adoption",
    "registered",
    "released",
    "running",
    "healthy",
    "exited",
    "cleanup_complete",
  ] as const) {
    const fixture = createFixture(checkpoint);
    try {
      const receipt = prepareCheckpoint(fixture, checkpoint);
      const calls: string[] = [];
      await new ProductRunRecovery({
        store: fixture.store,
        supervisor: recoverySupervisor(
          calls,
          checkpoint === "receipt_before_adoption" ? receipt : null,
        ),
        now: () => new Date(RECOVERED_AT),
      }).recoverBeforeGenerationActivation(B);
      const expectedCalls = checkpoint === "planned"
        ? ["planned"]
        : checkpoint === "cleanup_complete"
          ? []
          : checkpoint === "receipt_before_adoption"
            ? ["receipt", "inspect", "terminate", "gone", "scratch"]
            : ["inspect", "terminate", "gone", "scratch"];
      assert.deepEqual(calls, expectedCalls, checkpoint);
      assertPrivateVisualCompletion(fixture, "failed");
      const attempt = fixture.store.listRunAttempts(fixture.runId)[0]!;
      assert.equal(attempt.state, "interrupted", checkpoint);
      assert.equal(attempt.dispatcherGeneration, A, checkpoint);
      assert.deepEqual(fixture.store.listPriorDispatcherRecoveryUnits(), [], checkpoint);
      assert.doesNotThrow(() => fixture.store.activateDispatcherGeneration({
        generation: B,
        activatedAt: RECOVERED_AT,
      }), checkpoint);
    } finally {
      fixture.store.close();
      rmSync(fixture.parent, { recursive: true, force: true });
    }
  }
});

test("production supervisor reads and adopts an exact durable visual launch receipt", async () => {
  const fixture = createFixture("production_receipt");
  const scratchRoot = join(fixture.parent, "supervisor-scratch");
  mkdirSync(scratchRoot, { mode: 0o700 });
  try {
    const binding = fixture.store.prepareVisualProcessLaunch({
      ...fixture.launch,
      createdAt: NOW,
    });
    const scratchPath = join(scratchRoot, fixture.launch.relativePath);
    mkdirSync(scratchPath, { mode: 0o700 });
    const directory = lstatSync(scratchPath);
    fixture.store.registerVisualScratchDirectory({
      ...fixture.launch,
      ownerUid: directory.uid,
      device: directory.dev,
      inode: directory.ino,
      registeredAt: STARTED_AT,
    });
    const receipt = launchReceipt(fixture, binding);
    writeFileSync(join(scratchPath, "launch-receipt.json"), json(receipt), {
      encoding: "utf8",
      mode: 0o600,
    });
    const supervisor = new GenericBatchSupervisor({
      pythonExecutable: "/usr/bin/python3",
      scratchRoot,
    });
    const durableLease = {
      runId: fixture.runId,
      sampleIndex: 0,
      sampleId: fixture.launch.sampleId,
      scratchId: fixture.launch.scratchId,
      relativePath: fixture.launch.relativePath,
      ownerUid: directory.uid,
      device: directory.dev,
      inode: directory.ino,
      registeredAt: STARTED_AT,
    };
    assert.deepEqual(
      supervisor.readDurableLaunchReceipt(durableLease, binding, "visual"),
      receipt,
    );
    await new ProductRunRecovery({
      store: fixture.store,
      supervisor,
      now: () => new Date(RECOVERED_AT),
    }).recoverBeforeGenerationActivation(B);
    assertPrivateVisualCompletion(fixture, "failed");
    assert.equal(fixture.store.listRunAttempts(fixture.runId)[0]!.state, "interrupted");
    assert.equal(lstatSync(scratchRoot).isDirectory(), true);
    assert.throws(() => lstatSync(scratchPath), /ENOENT/u);
  } finally {
    fixture.store.close();
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("created visual scratch without a durable receipt fails before inspection or signal", async () => {
  const fixture = createFixture("created_no_receipt");
  try {
    prepareCheckpoint(fixture, "created");
    const calls: string[] = [];
    await assert.rejects(() => new ProductRunRecovery({
      store: fixture.store,
      supervisor: recoverySupervisor(calls),
      now: () => new Date(RECOVERED_AT),
    }).recoverBeforeGenerationActivation(B), /no durable launch receipt/u);
    assert.deepEqual(calls, ["receipt"]);
    assert.equal(fixture.store.getRun(fixture.projectId, fixture.runId).status, "running");
    assert.throws(() => fixture.store.activateDispatcherGeneration({
      generation: B,
      activatedAt: RECOVERED_AT,
    }), /recovery_required/u);
  } finally {
    fixture.store.close();
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("visual recovery preserves committed cancellation precedence without completion artifacts", async () => {
  const fixture = createFixture("cancelled");
  try {
    prepareCheckpoint(fixture, "running");
    fixture.store.cancelRun({
      commandId: "command_visual_recovery_cancelled",
      projectId: fixture.projectId,
      runId: fixture.runId,
      requestedAt: HEALTHY_AT,
    });
    const calls: string[] = [];
    await new ProductRunRecovery({
      store: fixture.store,
      supervisor: recoverySupervisor(calls),
      now: () => new Date(RECOVERED_AT),
    }).recoverBeforeGenerationActivation(B);
    assert.deepEqual(calls, ["inspect", "terminate", "gone", "scratch"]);
    assertPrivateVisualCompletion(fixture, "cancelled");
    assert.equal(fixture.store.listRunAttempts(fixture.runId)[0]!.state, "cancelled");
  } finally {
    fixture.store.close();
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("contradictory visual health evidence fails before inspect or signal", async () => {
  for (const corruption of [
    "timestamp_without_receipt",
    "receipt_without_timestamp",
    "mismatched_receipt",
    "mismatched_manifest",
  ] as const) {
    const fixture = createFixture(corruption);
    let reopened: ProductStoreV2 | undefined;
    try {
      prepareCheckpoint(fixture, "healthy");
      const wrongManifest = corruption === "mismatched_manifest"
        ? (() => {
            const manifest = {
              schemaVersion: 1,
              kind: "visual_process_launch",
              runId: fixture.runId,
              attemptId: fixture.attempt.attemptId,
              attemptGeneration: fixture.attempt.attemptGeneration,
              dispatcherGeneration: fixture.attempt.dispatcherGeneration,
              sampleIndex: 0,
              sampleId: fixture.launch.sampleId,
              scratchId: fixture.launch.scratchId,
              relativePath: fixture.launch.relativePath,
              loopbackHost: "127.0.0.1",
              loopbackPort: fixture.launch.loopbackPort + 1,
              healthPath: fixture.launch.healthPath,
            };
            const manifestDigest = canonicalDigest(manifest);
            return {
              manifest,
              manifestId: `launch_${manifestDigest.slice(0, 32)}`,
              manifestDigest,
            };
          })()
        : null;
      fixture.store.close();
      const database = openProductDatabase(join(fixture.root, "product.sqlite3"));
      try {
        if (corruption === "timestamp_without_receipt") {
          database.exec("DROP TRIGGER visual_health_receipt_delete_v8");
          database.prepare(
            "DELETE FROM visual_health_receipts WHERE process_attempt_id = ?",
          ).run(fixture.process.processAttemptId);
        } else if (corruption === "receipt_without_timestamp") {
          database.exec("DROP TRIGGER visual_health_transition_v8");
          database.prepare(
            "UPDATE process_attempts SET health_at = NULL WHERE id = ?",
          ).run(fixture.process.processAttemptId);
        } else if (corruption === "mismatched_receipt") {
          const row = database.prepare(`SELECT receipt_json
            FROM visual_health_receipts WHERE process_attempt_id = ?`
          ).get(fixture.process.processAttemptId) as { receipt_json: string };
          const receipt = {
            ...(JSON.parse(row.receipt_json) as Record<string, unknown>),
            healthPath: "/wrong-health",
          };
          database.exec("DROP TRIGGER visual_health_receipt_immutable_v8");
          database.prepare(`UPDATE visual_health_receipts
            SET health_path = ?, receipt_json = ?, receipt_sha256 = ?
            WHERE process_attempt_id = ?`
          ).run(
            "/wrong-health",
            json(receipt),
            canonicalDigest(receipt),
            fixture.process.processAttemptId,
          );
        } else {
          database.prepare(`INSERT INTO process_launch_manifests
            (id, run_attempt_id, scratch_lease_id, state, manifest_json,
              manifest_sha256, created_at)
            VALUES (?, ?, ?, 'planned', ?, ?, ?)`
          ).run(
            wrongManifest!.manifestId,
            fixture.attempt.attemptId,
            fixture.launch.scratchId,
            json(wrongManifest!.manifest),
            wrongManifest!.manifestDigest,
            HEALTHY_AT,
          );
          const row = database.prepare(`SELECT receipt_json
            FROM visual_health_receipts WHERE process_attempt_id = ?`
          ).get(fixture.process.processAttemptId) as { receipt_json: string };
          const receipt = {
            ...(JSON.parse(row.receipt_json) as Record<string, unknown>),
            launchManifestId: wrongManifest!.manifestId,
            launchManifestDigest: wrongManifest!.manifestDigest,
          };
          database.exec("DROP TRIGGER visual_health_receipt_immutable_v8");
          database.prepare(`UPDATE visual_health_receipts
            SET launch_manifest_id = ?, receipt_json = ?, receipt_sha256 = ?
            WHERE process_attempt_id = ?`
          ).run(
            wrongManifest!.manifestId,
            json(receipt),
            canonicalDigest(receipt),
            fixture.process.processAttemptId,
          );
        }
      } finally {
        database.close();
      }
      reopened = ProductStoreV2.open(fixture.root);
      const calls: string[] = [];
      await assert.rejects(() => new ProductRunRecovery({
        store: reopened!,
        supervisor: recoverySupervisor(calls),
        now: () => new Date(RECOVERED_AT),
      }).recoverBeforeGenerationActivation(B), /dispatcher_recovery_required/u, corruption);
      assert.deepEqual(calls, [], corruption);
      assert.equal(reopened.getRun(fixture.projectId, fixture.runId).status, "running");
    } finally {
      reopened?.close();
      rmSync(fixture.parent, { recursive: true, force: true });
    }
  }
});
