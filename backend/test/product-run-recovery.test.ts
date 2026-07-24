import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalDigest } from "../src/canonical-json-v2.ts";
import { planExperiment } from "../src/experiment-planner.ts";
import type {
  BatchLaunchReceipt,
  RecoveredProcessTerminationReceipt,
  RecoveredScratchCleanupReceipt,
} from "../src/generic-batch-supervisor.ts";
import { GenericBatchSupervisor } from "../src/generic-batch-supervisor.ts";
import { ProductRunDispatcher } from "../src/product-run-dispatcher.ts";
import { openProductDatabase } from "../src/product-schema.ts";
import {
  ProductRunRecovery,
  type ProductRunRecoverySupervisorPort,
} from "../src/product-run-recovery.ts";
import {
  ProductStoreV2,
  type BatchProcessIdentity,
  type ClaimedBatchRun,
  type RunAttemptIdentity,
  type RunLimitsV1,
} from "../src/product-store-v2.ts";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const NOW = "2026-07-25T03:00:00.000Z";
const INPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {},
  additionalProperties: false,
};
const EXECUTION_DESCRIPTION = {
  schemaVersion: 2,
  runtime: "python",
  runMode: "batch",
  dependencyFile: "environment/requirements.txt",
  inputs: {
    schemaProfile: "riff-json-schema-2020-12-v1",
    schema: INPUT_SCHEMA,
    smoke: {},
  },
  outputs: [{
    logicalName: "result",
    relativePath: "outputs/result.json",
    mediaType: "application/json",
    required: true,
    role: "data",
  }],
  batch: { entryPoint: "code/model.py", protocol: "riff-batch-v1" },
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
  maxSamples: 2,
  maxConcurrency: 1,
};

test("recovery preserves uncancelled queued work and finalizes cancelled queued work without launch", async () => {
  const fixture = createFixture("queued");
  try {
    const uncancelled = fixture.createRun("uncancelled");
    const cancelled = fixture.createRun("cancelled");
    fixture.store.cancelRun({
      commandId: "command_recovery_cancelled_cancel",
      projectId: fixture.projectId,
      runId: cancelled,
      requestedAt: "2026-07-25T03:01:00.000Z",
    });
    await new ProductRunRecovery({
      store: fixture.store,
      supervisor: {},
      now: () => new Date("2026-07-25T03:02:00.000Z"),
    }).recoverBeforeGenerationActivation(B);
    assert.equal(fixture.store.getRun(fixture.projectId, uncancelled).status, "queued");
    assert.equal(fixture.store.getRun(fixture.projectId, cancelled).status, "cancelled");
    assert.deepEqual(fixture.store.listRunAttempts(uncancelled), []);
    assert.deepEqual(fixture.store.listRunAttempts(cancelled), []);
  } finally {
    fixture.close();
  }
});

test("claimed prior generation becomes runtime_interrupted before generation handoff", async () => {
  const fixture = createFixture("claimed");
  try {
    const runId = fixture.createRun("claimed");
    const claim = fixture.claim(runId);
    const recovery = new ProductRunRecovery({
      store: fixture.store,
      supervisor: recoverySupervisor(),
      now: () => new Date("2026-07-25T03:03:00.000Z"),
    });
    await recovery.recoverBeforeGenerationActivation(B);
    const run = fixture.store.getRun(fixture.projectId, runId);
    assert.equal(run.status, "failed");
    assert.equal(run.terminalCode, "runtime_interrupted");
    assert.equal(fixture.store.listRunAttempts(runId)[0]!.state, "interrupted");
    assert.doesNotThrow(() => fixture.store.activateDispatcherGeneration({
      generation: B,
      activatedAt: "2026-07-25T03:03:01.000Z",
    }));
    assert.equal(claim.attempt.dispatcherGeneration, A);
    const nextRunId = fixture.createRun("next_generation");
    const next = fixture.store.claimNextQueuedBatchRun({
      dispatcherGeneration: B,
      claimedAt: "2026-07-25T03:03:02.000Z",
      leaseExpiresAt: "2026-07-25T03:04:02.000Z",
    });
    assert.equal(next?.run.id, nextRunId);
    assert.equal(next?.attempt.dispatcherGeneration, B);
  } finally {
    fixture.close();
  }
});

test("planned scratch with no directory is durably closed before the run is interrupted", async () => {
  const fixture = createFixture("planned_absent");
  try {
    const runId = fixture.createRun("planned_absent");
    const claim = fixture.claim(runId);
    const attempt = attemptOf(claim);
    fixture.store.markRunAttemptStarting({ ...attempt, startedAt: "2026-07-25T03:03:10.000Z" });
    prepareLaunch(fixture.store, claim, "planned_absent");
    const calls: string[] = [];
    const supervisor = recoverySupervisor(calls);
    supervisor.cleanupPlannedScratch = (plan, cleanedAt) => {
      calls.push("planned_absent");
      return recoverySupervisor().cleanupPlannedScratch(plan, cleanedAt);
    };
    await new ProductRunRecovery({
      store: fixture.store,
      supervisor,
      now: () => new Date("2026-07-25T03:03:11.000Z"),
    }).recoverBeforeGenerationActivation(B);
    assert.deepEqual(calls, ["planned_absent"]);
    assert.equal(fixture.store.getRun(fixture.projectId, runId).terminalCode, "runtime_interrupted");
    assert.deepEqual(fixture.store.listPriorDispatcherRecoveryUnits(), []);
  } finally {
    fixture.close();
  }
});

test("starting and running attempts with no process or scratch evidence interrupt without signalling", async () => {
  for (const state of ["starting", "running"] as const) {
    const fixture = createFixture(`no_process_${state}`);
    try {
      const runId = fixture.createRun(`no_process_${state}`);
      const claim = fixture.claim(runId);
      const attempt = attemptOf(claim);
      fixture.store.markRunAttemptStarting({ ...attempt, startedAt: "2026-07-25T03:03:12.000Z" });
      if (state === "running") {
        fixture.store.markRunAttemptRunning({
          ...attempt,
          startedAt: "2026-07-25T03:03:13.000Z",
          leaseExpiresAt: "2026-07-25T03:04:13.000Z",
        });
      }
      const calls: string[] = [];
      await new ProductRunRecovery({
        store: fixture.store,
        supervisor: recoverySupervisor(calls),
        now: () => new Date("2026-07-25T03:03:14.000Z"),
      }).recoverBeforeGenerationActivation(B);
      assert.deepEqual(calls, [], state);
      assert.equal(fixture.store.getRun(fixture.projectId, runId).terminalCode, "runtime_interrupted");
    } finally {
      fixture.close();
    }
  }
});

test("created scratch without a durable launch receipt fails closed without cleanup or handoff", async () => {
  const fixture = createFixture("created_no_receipt");
  try {
    const runId = fixture.createRun("created_no_receipt");
    const claim = fixture.claim(runId);
    const attempt = attemptOf(claim);
    fixture.store.markRunAttemptStarting({ ...attempt, startedAt: "2026-07-25T03:03:20.000Z" });
    const launch = prepareLaunch(fixture.store, claim, "created_no_receipt");
    fixture.store.registerBatchScratchDirectory({
      ...attempt,
      runId,
      sampleIndex: launch.sampleIndex,
      sampleId: launch.sampleId,
      scratchId: launch.scratchId,
      relativePath: launch.relativePath,
      ownerUid: 501,
      device: 42,
      inode: 100,
      registeredAt: "2026-07-25T03:03:21.000Z",
    });
    let cleanupCalled = false;
    const supervisor = recoverySupervisor();
    supervisor.cleanupDurableScratch = (...args) => {
      cleanupCalled = true;
      return recoverySupervisor().cleanupDurableScratch(...args);
    };
    await assert.rejects(() => new ProductRunRecovery({
      store: fixture.store,
      supervisor,
      now: () => new Date("2026-07-25T03:03:22.000Z"),
    }).recoverBeforeGenerationActivation(B), /created scratch lease has no durable launch receipt/u);
    assert.equal(cleanupCalled, false);
    assert.equal(fixture.store.getRun(fixture.projectId, runId).status, "running");
    assert.throws(() => fixture.store.activateDispatcherGeneration({
      generation: B,
      activatedAt: "2026-07-25T03:03:23.000Z",
    }), /recovery_required/u);
  } finally {
    fixture.close();
  }
});

test("a child-authored receipt committed before Store registration is adopted and reconciled", async () => {
  const fixture = createFixture("receipt_before_store");
  try {
    const runId = fixture.createRun("receipt_before_store");
    const claim = fixture.claim(runId);
    const attempt = attemptOf(claim);
    fixture.store.markRunAttemptStarting({ ...attempt, startedAt: "2026-07-25T03:03:24.000Z" });
    fixture.store.markRunAttemptRunning({
      ...attempt,
      startedAt: "2026-07-25T03:03:25.000Z",
      leaseExpiresAt: "2026-07-25T03:04:25.000Z",
    });
    const launch = prepareLaunch(fixture.store, claim, "receipt_before_store");
    fixture.store.registerBatchScratchDirectory({
      ...attempt,
      runId,
      sampleIndex: launch.sampleIndex,
      sampleId: launch.sampleId,
      scratchId: launch.scratchId,
      relativePath: launch.relativePath,
      ownerUid: 501,
      device: 42,
      inode: 101,
      registeredAt: "2026-07-25T03:03:26.000Z",
    });
    const unsigned = {
      schemaVersion: 1 as const,
      manifestId: launch.binding.manifestId,
      manifestDigest: launch.binding.manifestDigest,
      runId,
      sampleIndex: launch.sampleIndex,
      sampleId: launch.sampleId,
      scratchId: launch.scratchId,
      relativePath: launch.relativePath,
      pid: 9_998,
      processGroupId: 9_998,
      processStartToken: "Fri Jul 25 03:03:26 2026",
      createdAt: "2026-07-25T03:03:26.000Z",
    };
    const receipt: BatchLaunchReceipt = { ...unsigned, receiptDigest: canonicalDigest(unsigned) };
    const calls: string[] = [];
    const supervisor = recoverySupervisor(calls);
    supervisor.readDurableLaunchReceipt = () => {
      calls.push("receipt");
      return receipt;
    };
    await new ProductRunRecovery({
      store: fixture.store,
      supervisor,
      now: () => new Date("2026-07-25T03:03:27.000Z"),
    }).recoverBeforeGenerationActivation(B);
    assert.deepEqual(calls, ["receipt", "inspect", "terminate", "gone", "scratch"]);
    assert.equal(fixture.store.getRun(fixture.projectId, runId).terminalCode, "runtime_interrupted");
  } finally {
    fixture.close();
  }
});

test("a started recovery action is adopted by a new random generation and completes exactly once", async () => {
  const fixture = createFixture("recovery_replay");
  try {
    const runId = fixture.createRun("recovery_replay");
    const claim = fixture.claim(runId);
    const attempt = attemptOf(claim);
    fixture.store.markRunAttemptStarting({ ...attempt, startedAt: "2026-07-25T03:03:30.000Z" });
    prepareLaunch(fixture.store, claim, "recovery_replay");
    const actionId = fixture.store.beginRunRecovery({
      attemptId: attempt.attemptId,
      priorDispatcherGeneration: A,
      candidateDispatcherGeneration: B,
      createdAt: "2026-07-25T03:03:31.000Z",
    });
    assert.match(actionId, /^recovery_/u);
    await new ProductRunRecovery({
      store: fixture.store,
      supervisor: recoverySupervisor(),
      now: () => new Date("2026-07-25T03:03:32.000Z"),
    }).recoverBeforeGenerationActivation(C);
    assert.equal(fixture.store.getRun(fixture.projectId, runId).terminalCode, "runtime_interrupted");
    assert.doesNotThrow(() => fixture.store.activateDispatcherGeneration({
      generation: C,
      activatedAt: "2026-07-25T03:03:32.500Z",
    }));
    await new ProductRunRecovery({
      store: fixture.store,
      supervisor: {},
      now: () => new Date("2026-07-25T03:03:33.000Z"),
    }).recoverBeforeGenerationActivation(C);
    assert.equal(fixture.store.getRun(fixture.projectId, runId).terminalCode, "runtime_interrupted");
  } finally {
    fixture.close();
  }
});

test("blocked, released, exited, and cleanup-complete process checkpoints converge idempotently", async () => {
  for (const state of ["blocked", "released", "exited", "cleanup_complete"] as const) {
    const fixture = createFixture(`checkpoint_${state}`);
    try {
      const runId = fixture.createRun(`checkpoint_${state}`);
      const claim = fixture.claim(runId);
      const attempt = attemptOf(claim);
      fixture.store.markRunAttemptStarting({ ...attempt, startedAt: "2026-07-25T03:03:40.000Z" });
      fixture.store.markRunAttemptRunning({
        ...attempt,
        startedAt: "2026-07-25T03:03:41.000Z",
        leaseExpiresAt: "2026-07-25T03:04:41.000Z",
      });
      const process = registerProcess(fixture.store, claim);
      if (state !== "blocked") {
        fixture.store.markBatchProcessGateReleased({ ...process, startedAt: "2026-07-25T03:03:42.000Z" });
      }
      if (state === "exited" || state === "cleanup_complete") {
        fixture.store.recordBatchProcessExit({
          ...process,
          expectedState: "released",
          exitedAt: "2026-07-25T03:03:43.000Z",
          exitCode: null,
          exitSignal: "recovery_test",
        });
      }
      if (state === "cleanup_complete") {
        fixture.store.finalizeBatchProcessCleanup({
          ...process,
          cleanupVerified: true,
          cleanupReceiptDigest: "d".repeat(64),
          cleanedAt: "2026-07-25T03:03:44.000Z",
        });
      }
      await new ProductRunRecovery({
        store: fixture.store,
        supervisor: recoverySupervisor(),
        now: () => new Date("2026-07-25T03:03:45.000Z"),
      }).recoverBeforeGenerationActivation(B);
      assert.equal(
        fixture.store.getRun(fixture.projectId, runId).terminalCode,
        "runtime_interrupted",
        state,
      );
      assert.deepEqual(fixture.store.listPriorDispatcherRecoveryUnits(), [], state);
    } finally {
      fixture.close();
    }
  }
});

test("running process recovery rechecks exact identity, records cleanup, and honors cancel precedence", async () => {
  const fixture = createFixture("running_cancel");
  try {
    const runId = fixture.createRun("running_cancel");
    const claim = fixture.claim(runId);
    const attempt = attemptOf(claim);
    fixture.store.markRunAttemptStarting({ ...attempt, startedAt: "2026-07-25T03:04:01.000Z" });
    fixture.store.markRunAttemptRunning({
      ...attempt,
      startedAt: "2026-07-25T03:04:02.000Z",
      leaseExpiresAt: "2026-07-25T03:05:02.000Z",
    });
    const process = registerProcess(fixture.store, claim);
    fixture.store.markBatchProcessGateReleased({ ...process, startedAt: "2026-07-25T03:04:04.000Z" });
    fixture.store.markBatchProcessStarted({ ...process, startedAt: "2026-07-25T03:04:05.000Z" });
    fixture.store.cancelRun({
      commandId: "command_recovery_running_cancel",
      projectId: fixture.projectId,
      runId,
      requestedAt: "2026-07-25T03:04:06.000Z",
    });
    const calls: string[] = [];
    await new ProductRunRecovery({
      store: fixture.store,
      supervisor: recoverySupervisor(calls),
      now: () => new Date("2026-07-25T03:04:07.000Z"),
    }).recoverBeforeGenerationActivation(B);
    assert.deepEqual(calls, ["inspect", "terminate", "gone", "scratch"]);
    const run = fixture.store.getRun(fixture.projectId, runId);
    assert.equal(run.status, "cancelled");
    assert.equal(run.terminalCode, "run_cancelled");
    assert.equal(fixture.store.listRunAttempts(runId)[0]!.state, "cancelled");
  } finally {
    fixture.close();
  }
});

test("PID/start-token mismatch fails closed without generation handoff or signal", async () => {
  const fixture = createFixture("identity_mismatch");
  try {
    const runId = fixture.createRun("identity_mismatch");
    const claim = fixture.claim(runId);
    const attempt = attemptOf(claim);
    fixture.store.markRunAttemptStarting({ ...attempt, startedAt: "2026-07-25T03:06:01.000Z" });
    fixture.store.markRunAttemptRunning({
      ...attempt,
      startedAt: "2026-07-25T03:06:02.000Z",
      leaseExpiresAt: "2026-07-25T03:07:02.000Z",
    });
    registerProcess(fixture.store, claim);
    let signalled = false;
    const supervisor = recoverySupervisor();
    supervisor.inspectRecordedProcess = () => {
      throw new Error("process_identity_mismatch");
    };
    supervisor.terminateRecordedProcess = async (...args) => {
      signalled = true;
      return recoverySupervisor().terminateRecordedProcess(...args);
    };
    await assert.rejects(() => new ProductRunRecovery({
      store: fixture.store,
      supervisor,
      now: () => new Date("2026-07-25T03:06:03.000Z"),
    }).recoverBeforeGenerationActivation(B), /dispatcher_recovery_required/u);
    assert.equal(signalled, false);
    assert.equal(fixture.store.getRun(fixture.projectId, runId).status, "running");
    assert.throws(() => fixture.store.activateDispatcherGeneration({
      generation: B,
      activatedAt: "2026-07-25T03:06:04.000Z",
    }), /recovery_required/u);
  } finally {
    fixture.close();
  }
});

test("a durable launch receipt that contradicts its process row is rejected before signal", async () => {
  const fixture = createFixture("receipt_mismatch");
  let reopened: ProductStoreV2 | undefined;
  try {
    const runId = fixture.createRun("receipt_mismatch");
    const claim = fixture.claim(runId);
    const attempt = attemptOf(claim);
    fixture.store.markRunAttemptStarting({ ...attempt, startedAt: "2026-07-25T03:07:01.000Z" });
    fixture.store.markRunAttemptRunning({
      ...attempt,
      startedAt: "2026-07-25T03:07:02.000Z",
      leaseExpiresAt: "2026-07-25T03:08:02.000Z",
    });
    registerProcess(fixture.store, claim);
    fixture.store.close();
    const database = openProductDatabase(join(fixture.storeRoot, "product.sqlite3"));
    const row = database.prepare(
      "SELECT id, launch_receipt_json FROM process_launch_manifests WHERE run_attempt_id = ?",
    ).get(attempt.attemptId) as { id: string; launch_receipt_json: string };
    const receipt = JSON.parse(row.launch_receipt_json) as BatchLaunchReceipt;
    const { receiptDigest: _priorDigest, ...unsigned } = receipt;
    const tamperedUnsigned = { ...unsigned, pid: receipt.pid + 1, processGroupId: receipt.processGroupId + 1 };
    const tampered = { ...tamperedUnsigned, receiptDigest: canonicalDigest(tamperedUnsigned) };
    database.exec("DROP TRIGGER launch_receipt_immutable_v6");
    database.prepare(`UPDATE process_launch_manifests
      SET launch_receipt_json = ?, launch_receipt_sha256 = ?
      WHERE id = ?`
    ).run(JSON.stringify(tampered), canonicalDigest(tampered), row.id);
    database.close();

    reopened = ProductStoreV2.open(fixture.storeRoot);
    let signalled = false;
    const supervisor = recoverySupervisor();
    supervisor.terminateRecordedProcess = async (...args) => {
      signalled = true;
      return recoverySupervisor().terminateRecordedProcess(...args);
    };
    await assert.rejects(() => new ProductRunRecovery({
      store: reopened!,
      supervisor,
      now: () => new Date("2026-07-25T03:07:03.000Z"),
    }).recoverBeforeGenerationActivation(B), /contradicts its durable launch receipt/u);
    assert.equal(signalled, false);
  } finally {
    reopened?.close();
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("a killed dispatcher parent is reopened, reconciled, and fenced before the next generation", {
  skip: process.platform !== "darwin",
  timeout: 15_000,
}, async () => {
  const parent = mkdtempSync(join(tmpdir(), "riff-run-parent-crash-"));
  const storeRoot = join(parent, "store");
  const scratchRoot = join(parent, "scratch");
  const readyPath = join(parent, "ready.json");
  mkdirSync(scratchRoot, { mode: 0o700 });
  const fixturePath = join(import.meta.dirname, "fixtures", "a3-1c-crash-parent.ts");
  const child = spawn(process.execPath, [
    "--experimental-strip-types",
    fixturePath,
    storeRoot,
    scratchRoot,
    readyPath,
  ], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  let reopened: ProductStoreV2 | undefined;
  let replacement: ProductRunDispatcher | undefined;
  try {
    const ready = await waitFor(() => existsSync(readyPath) || child.exitCode !== null, 8_000);
    assert.equal(ready, true);
    assert.equal(existsSync(readyPath), true, stderr);
    const identity = JSON.parse(readFileSync(readyPath, "utf8")) as {
      processGroupId: number;
    };
    assert.ok(Number.isSafeInteger(identity.processGroupId));
    child.kill("SIGKILL");
    await new Promise<void>((resolveClose) => child.once("close", () => resolveClose()));

    reopened = ProductStoreV2.open(storeRoot);
    const supervisor = new GenericBatchSupervisor({
      pythonExecutable: "/usr/bin/python3",
      scratchRoot,
    });
    replacement = new ProductRunDispatcher({
      store: reopened,
      supervisor,
      leaseMs: 5_000,
    });
    await replacement.start();
    const run = reopened.getRun("project_crash_parent", "run_crash_parent");
    assert.equal(run.status, "failed");
    assert.equal(run.terminalCode, "runtime_interrupted");
    assert.equal(reopened.listRunAttempts(run.id)[0]!.state, "interrupted");
    assert.deepEqual(readdirSync(scratchRoot), []);
    assert.equal(await waitForProcessGroupGone(identity.processGroupId), true);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await replacement?.stop();
    reopened?.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

const recoverySupervisor = (calls: string[] = []): ProductRunRecoverySupervisorPort => ({
  inspectRecordedProcess() {
    calls.push("inspect");
    return "present";
  },
  async terminateRecordedProcess(identity, _graceMs, observedAt): Promise<RecoveredProcessTerminationReceipt> {
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
    return null;
  },
  cleanupDurableScratch(lease, cleanedAt): RecoveredScratchCleanupReceipt {
    calls.push("scratch");
    const unsigned = {
      schemaVersion: 1 as const,
      runId: lease.runId,
      sampleIndex: lease.sampleIndex,
      sampleId: lease.sampleId,
      scratchId: lease.scratchId,
      relativePath: lease.relativePath,
      disposition: "removed" as const,
      cleanedAt,
      verified: true as const,
    };
    return { ...unsigned, receiptDigest: canonicalDigest(unsigned) };
  },
  cleanupPlannedScratch(plan, cleanedAt): RecoveredScratchCleanupReceipt {
    const unsigned = {
      schemaVersion: 1 as const,
      runId: plan.runId,
      sampleIndex: plan.sampleIndex,
      sampleId: plan.sampleId,
      scratchId: plan.scratchId,
      relativePath: plan.relativePath,
      disposition: "already_absent" as const,
      cleanedAt,
      verified: true as const,
    };
    return { ...unsigned, receiptDigest: canonicalDigest(unsigned) };
  },
});

const registerProcess = (store: ProductStoreV2, claim: ClaimedBatchRun): BatchProcessIdentity => {
  const attempt = attemptOf(claim);
  const sample = claim.run.samplePlan[0] as { sampleIndex: number; sampleId: string };
  const launch = prepareLaunch(store, claim, "recovery");
  const { scratchId, relativePath, binding } = launch;
  store.registerBatchScratchDirectory({
    ...attempt,
    runId: claim.run.id,
    sampleIndex: sample.sampleIndex,
    sampleId: sample.sampleId,
    scratchId,
    relativePath,
    ownerUid: 501,
    device: 42,
    inode: 99,
    registeredAt: "2026-07-25T03:04:03.000Z",
  });
  const processAttemptId = `process_${canonicalDigest({
    runId: claim.run.id,
    attemptGeneration: attempt.attemptGeneration,
    sampleIndex: sample.sampleIndex,
  }).slice(0, 32)}`;
  const identity: BatchProcessIdentity = {
    ...attempt,
    processAttemptId,
    sampleIndex: sample.sampleIndex,
    sampleId: sample.sampleId,
    pid: 9_999,
    processStartToken: "Fri Jul 25 03:04:03 2026",
    processGroupId: 9_999,
    scratchId,
  };
  const unsigned = {
    schemaVersion: 1 as const,
    manifestId: binding.manifestId,
    manifestDigest: binding.manifestDigest,
    runId: claim.run.id,
    sampleIndex: sample.sampleIndex,
    sampleId: sample.sampleId,
    scratchId,
    relativePath,
    pid: identity.pid,
    processGroupId: identity.processGroupId,
    processStartToken: identity.processStartToken,
    createdAt: "2026-07-25T03:04:03.000Z",
  };
  const launchReceipt: BatchLaunchReceipt = {
    ...unsigned,
    receiptDigest: canonicalDigest(unsigned),
  };
  store.registerBatchProcessAttempt({
    ...identity,
    launchedAt: launchReceipt.createdAt,
    launchReceipt,
  });
  return identity;
};

const prepareLaunch = (
  store: ProductStoreV2,
  claim: ClaimedBatchRun,
  suffix: string,
): {
  sampleIndex: number;
  sampleId: string;
  scratchId: string;
  relativePath: string;
  binding: ReturnType<ProductStoreV2["prepareBatchProcessLaunch"]>;
} => {
  const attempt = attemptOf(claim);
  const sample = claim.run.samplePlan[0] as { sampleIndex: number; sampleId: string };
  const scratchId = `scratch_${canonicalDigest({ runId: claim.run.id, suffix }).slice(0, 32)}`;
  const relativePath = `riff-${claim.run.id}-0-${suffix}`;
  const binding = store.prepareBatchProcessLaunch({
    ...attempt,
    runId: claim.run.id,
    sampleIndex: sample.sampleIndex,
    sampleId: sample.sampleId,
    scratchId,
    relativePath,
    createdAt: "2026-07-25T03:03:00.000Z",
  });
  return {
    sampleIndex: sample.sampleIndex,
    sampleId: sample.sampleId,
    scratchId,
    relativePath,
    binding,
  };
};

const attemptOf = (claim: ClaimedBatchRun): RunAttemptIdentity => ({
  runId: claim.run.id,
  attemptId: claim.attempt.id,
  attemptGeneration: claim.attempt.attemptGeneration,
  dispatcherGeneration: claim.attempt.dispatcherGeneration,
});

const waitFor = async (condition: () => boolean, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  return condition();
};

const waitForProcessGroupGone = async (processGroupId: number): Promise<boolean> =>
  waitFor(() => {
    try {
      process.kill(-processGroupId, 0);
      return false;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") return true;
      throw error;
    }
  }, 2_000);

const createFixture = (suffix: string) => {
  const parent = mkdtempSync(join(tmpdir(), "riff-run-recovery-"));
  const store = ProductStoreV2.open(join(parent, "store"));
  const projectId = `project_${suffix}`;
  const experimentId = `experiment_${suffix}`;
  store.createModel({
    id: `model_${suffix}`,
    name: "Recovery",
    technicalStatus: "executable",
    runMode: "batch",
    executionDescription: EXECUTION_DESCRIPTION,
    createdAt: NOW,
    files: [
      {
        id: `file_${suffix}_code`,
        kind: "model_code",
        relativePath: "model.py",
        mediaType: "text/x-python",
        bytes: Buffer.from("raise SystemExit(0)\n"),
      },
      {
        id: `file_${suffix}_env`,
        kind: "model_environment",
        relativePath: "requirements.txt",
        mediaType: "text/plain",
        bytes: Buffer.from("# empty\n"),
      },
    ],
  });
  const project = store.createProjectFromModel({
    projectId,
    projectName: "Recovery",
    sourceModelId: `model_${suffix}`,
    createdAt: NOW,
  });
  const plan = planExperiment({
    configuration: {
      schemaVersion: 1,
      runKind: "batch",
      parameters: {},
      sampling: { kind: "single" },
    },
    inputSchema: INPUT_SCHEMA,
    maxSamples: LIMITS.maxSamples,
  });
  store.createExperimentV4({
    commandId: `command_${suffix}_experiment`,
    id: experimentId,
    projectId,
    name: "Recovery",
    plan,
    createdAt: NOW,
  });
  const createRun = (name: string): string => {
    const runId = `run_${suffix}_${name}`;
    store.createFrozenRun({
      commandId: `command_${suffix}_${name}_run`,
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
    return runId;
  };
  const claim = (runId: string): ClaimedBatchRun => {
    store.activateDispatcherGeneration({ generation: A, activatedAt: NOW });
    const claimed = store.claimNextQueuedBatchRun({
      dispatcherGeneration: A,
      claimedAt: "2026-07-25T03:00:01.000Z",
      leaseExpiresAt: "2026-07-25T03:01:01.000Z",
    });
    assert.equal(claimed?.run.id, runId);
    return claimed!;
  };
  return {
    store,
    parent,
    storeRoot: join(parent, "store"),
    projectId,
    createRun,
    claim,
    close() {
      store.close();
      rmSync(parent, { recursive: true, force: true });
    },
  };
};
