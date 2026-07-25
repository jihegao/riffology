import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalDigest } from "../src/canonical-json-v2.ts";
import { parseDiagnosticEventNdjson } from "../src/diagnostic-events.ts";
import { planExperiment } from "../src/experiment-planner.ts";
import { openProductDatabase } from "../src/product-schema.ts";
import {
  ProductStoreV2,
  type BatchProcessIdentity,
  type RunAttemptIdentity,
  type RunLimitsV1,
} from "../src/product-store-v2.ts";

const GENERATION = "a".repeat(64);
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
  batch: {
    entryPoint: "code/model.py",
    protocol: "riff-batch-v1",
    domainEvents: {
      relativePath: "events.ndjson",
      mediaType: "application/x-ndjson",
      role: "diagnostic",
    },
  },
  cancellation: { signal: "SIGTERM", graceMs: 1_000 },
};
const LIMITS: RunLimitsV1 = {
  schemaVersion: 1,
  wallTimeMs: 60_000,
  startupTimeMs: 10_000,
  terminationGraceMs: 1_000,
  maxStdoutBytes: 100_000,
  maxStderrBytes: 100_000,
  maxOutputFiles: 10,
  maxOutputBytes: 1_000_000,
  maxEventCount: 1_000,
  maxEventBytes: 1_000_000,
  maxSamples: 10,
  maxConcurrency: 2,
};

test("run lifecycle binding and durable trash/restore receipts remain exact across restart", () => {
  const fixture = createFixture("roundtrip");
  try {
    finishSucceeded(fixture.store, fixture.runId);
    const initial = fixture.store.currentRunLifecycleBinding(
      fixture.projectId,
      fixture.runId,
    );
    assert.equal(initial.status, "succeeded");
    assert.equal(initial.terminalStatus, "succeeded");
    assert.match(initial.terminalClosureDigest!, /^[0-9a-f]{64}$/u);

    let callbackStatus: string | undefined;
    assert.throws(() => fixture.store.trashRun({
      ...trashInput(fixture, initial, "command_roundtrip_fault"),
      committedAt: "2026-07-25T10:03:00.000Z",
      beforeCommit() {
        callbackStatus = fixture.store.currentRunLifecycleBinding(
          fixture.projectId,
          fixture.runId,
        ).status;
        throw new Error("injected before commit");
      },
    }), /Product database mutation failed/u);
    assert.equal(callbackStatus, "succeeded");
    assert.deepEqual(
      fixture.store.currentRunLifecycleBinding(fixture.projectId, fixture.runId),
      initial,
    );

    const trash = fixture.store.trashRun({
      ...trashInput(fixture, initial, "command_roundtrip_trash"),
      committedAt: "2026-07-25T10:03:01.000Z",
    });
    assert.equal(trash.action, "trash_run");
    assert.equal(trash.priorStatus, "succeeded");
    assert.equal(trash.status, "trashed");
    assert.equal(trash.terminalClosureDigest, initial.terminalClosureDigest);
    assert.notEqual(trash.lifecycleDigest, initial.lifecycleDigest);
    assert.deepEqual(fixture.store.trashRun({
      ...trashInput(fixture, initial, "command_roundtrip_trash"),
      committedAt: "2099-01-01T00:00:00.000Z",
    }), trash);
    assert.throws(() => fixture.store.trashRun({
      ...trashInput(fixture, initial, "command_roundtrip_race"),
      committedAt: "2026-07-25T10:03:02.000Z",
    }), /state_conflict:/u);

    let restoreCallbackStatus: string | undefined;
    assert.throws(() => fixture.store.restoreRun({
      commandId: "command_roundtrip_restore",
      projectId: fixture.projectId,
      runId: fixture.runId,
      expectedLifecycleDigest: trash.lifecycleDigest,
      committedAt: "2026-07-25T10:03:03.000Z",
      beforeCommit() {
        restoreCallbackStatus = fixture.store.currentRunLifecycleBinding(
          fixture.projectId,
          fixture.runId,
        ).status;
        throw new Error("injected restore before commit");
      },
    }), /Product database mutation failed/u);
    assert.equal(restoreCallbackStatus, "trashed");
    assert.equal(
      fixture.store.currentRunLifecycleBinding(fixture.projectId, fixture.runId)
        .lifecycleDigest,
      trash.lifecycleDigest,
    );
    const restore = fixture.store.restoreRun({
      commandId: "command_roundtrip_restore",
      projectId: fixture.projectId,
      runId: fixture.runId,
      expectedLifecycleDigest: trash.lifecycleDigest,
      committedAt: "2026-07-25T10:03:03.000Z",
    });
    assert.equal(restore.action, "restore_run");
    assert.equal(restore.priorStatus, "trashed");
    assert.equal(restore.status, "succeeded");
    assert.equal(restore.trashEntryId, trash.trashEntryId);
    assert.equal(restore.terminalClosureDigest, initial.terminalClosureDigest);
    assert.notEqual(restore.lifecycleDigest, initial.lifecycleDigest);
    assert.notEqual(restore.lifecycleDigest, trash.lifecycleDigest);
    assert.deepEqual(fixture.store.restoreRun({
      commandId: "command_roundtrip_restore",
      projectId: fixture.projectId,
      runId: fixture.runId,
      expectedLifecycleDigest: trash.lifecycleDigest,
      committedAt: "2099-01-01T00:00:00.000Z",
    }), restore);
    assert.throws(() => fixture.store.restoreRun({
      commandId: "command_roundtrip_restore",
      projectId: fixture.projectId,
      runId: fixture.runId,
      expectedLifecycleDigest: initial.lifecycleDigest,
      committedAt: "2026-07-25T10:03:03.000Z",
    }), /idempotency_conflict:/u);
    assert.deepEqual(fixture.store.trashRun({
      ...trashInput(fixture, initial, "command_roundtrip_trash"),
      committedAt: "2099-01-01T00:00:00.000Z",
    }), trash);
    assert.throws(() => fixture.store.trashRun({
      ...trashInput(fixture, initial, "command_roundtrip_trash"),
      confirmation: {
        ...trashInput(fixture, initial, "unused").confirmation,
        terminalClosureDigest: "f".repeat(64),
      },
      committedAt: "2026-07-25T10:03:04.000Z",
    }), /idempotency_conflict:/u);
    assert.throws(() => fixture.store.trashRun({
      ...trashInput(fixture, initial, "command_roundtrip_stale"),
      committedAt: "2026-07-25T10:03:05.000Z",
    }), /state_conflict:/u);
    const terminalCancel = fixture.store.cancelRun({
      commandId: "command_roundtrip_terminal_cancel",
      projectId: fixture.projectId,
      runId: fixture.runId,
      requestedAt: "2026-07-25T10:03:05.500Z",
    });
    assert.equal(terminalCancel.code, "run_already_terminal");
    fixture.store.trashResource(
      "project",
      fixture.projectId,
      "2026-07-25T10:03:06.000Z",
    );
    assert.throws(() => fixture.store.cancelRun({
      commandId: "command_roundtrip_terminal_cancel",
      projectId: fixture.projectId,
      runId: fixture.runId,
      requestedAt: "2026-07-25T10:03:05.500Z",
    }), /Run does not exist/u);
    assert.throws(() => fixture.store.trashRun({
      ...trashInput(fixture, initial, "command_roundtrip_trash"),
      committedAt: "2099-01-01T00:00:00.000Z",
    }), /Run does not exist/u);
    assert.throws(() => fixture.store.restoreRun({
      commandId: "command_roundtrip_restore",
      projectId: fixture.projectId,
      runId: fixture.runId,
      expectedLifecycleDigest: trash.lifecycleDigest,
      committedAt: "2099-01-01T00:00:00.000Z",
    }), /Run does not exist/u);
    fixture.store.restoreResource(
      "project",
      fixture.projectId,
      "2026-07-25T10:03:07.000Z",
    );

    fixture.store.close();
    const database = openProductDatabase(join(fixture.root, "product.sqlite3"));
    try {
      assert.deepEqual(database.prepare(
        "SELECT command_kind FROM run_commands WHERE id IN (?, ?) ORDER BY command_kind",
      ).all("command_roundtrip_trash", "command_roundtrip_restore")
        .map((row) => ({ ...row })), [
        { command_kind: "restore" },
        { command_kind: "trash" },
      ]);
      assert.deepEqual(database.prepare(
        "SELECT receipt_kind FROM run_command_receipts WHERE command_id IN (?, ?) ORDER BY receipt_kind",
      ).all("command_roundtrip_trash", "command_roundtrip_restore")
        .map((row) => ({ ...row })), [
        { receipt_kind: "run.restore.v1" },
        { receipt_kind: "run.trash.v1" },
      ]);
    } finally {
      database.close();
    }
    fixture.store = ProductStoreV2.open(fixture.root);
    assert.deepEqual(fixture.store.trashRun({
      ...trashInput(fixture, initial, "command_roundtrip_trash"),
      committedAt: "2099-01-01T00:00:00.000Z",
    }), trash);
    assert.deepEqual(fixture.store.restoreRun({
      commandId: "command_roundtrip_restore",
      projectId: fixture.projectId,
      runId: fixture.runId,
      expectedLifecycleDigest: trash.lifecycleDigest,
      committedAt: "2099-01-01T00:00:00.000Z",
    }), restore);
  } finally {
    fixture.close();
  }
});

test("every version-4 terminal status can make one exact trash/restore round trip", () => {
  for (const status of ["succeeded", "failed", "cancelled", "timed_out"] as const) {
    const fixture = createFixture(`terminal_${status}`);
    try {
      if (status === "succeeded") {
        finishSucceeded(fixture.store, fixture.runId);
      } else {
        finishTerminal(fixture.store, fixture.runId, status);
      }
      const initial = fixture.store.currentRunLifecycleBinding(
        fixture.projectId,
        fixture.runId,
      );
      assert.equal(initial.status, status);
      assert.equal(initial.terminalStatus, status);
      assert.match(initial.terminalClosureDigest!, /^[0-9a-f]{64}$/u);
      const trash = fixture.store.trashRun({
        ...trashInput(fixture, initial, `command_${status}_trash`),
        committedAt: "2026-07-25T10:05:00.000Z",
      });
      assert.equal(trash.priorStatus, status);
      assert.equal(trash.status, "trashed");
      assert.equal(trash.terminalClosureDigest, initial.terminalClosureDigest);
      const restore = fixture.store.restoreRun({
        commandId: `command_${status}_restore`,
        projectId: fixture.projectId,
        runId: fixture.runId,
        expectedLifecycleDigest: trash.lifecycleDigest,
        committedAt: "2026-07-25T10:05:01.000Z",
      });
      assert.equal(restore.status, status);
      assert.equal(restore.terminalClosureDigest, initial.terminalClosureDigest);
      assert.notEqual(restore.lifecycleDigest, initial.lifecycleDigest);
      assert.notEqual(restore.lifecycleDigest, trash.lifecycleDigest);
    } finally {
      fixture.close();
    }
  }
});

test("nonterminal and stale lifecycle commands fail without partial publication", () => {
  const fixture = createFixture("negative");
  try {
    const queued = fixture.store.currentRunLifecycleBinding(
      fixture.projectId,
      fixture.runId,
    );
    assert.equal(queued.status, "queued");
    assert.equal(queued.terminalStatus, null);
    assert.equal(queued.terminalClosureDigest, null);
    fixture.store.trashResource(
      "project",
      fixture.projectId,
      "2026-07-25T11:00:00.000Z",
    );
    assert.throws(() => fixture.store.cancelRun({
      commandId: "command_negative_cancel_trashed_project",
      projectId: fixture.projectId,
      runId: fixture.runId,
      requestedAt: "2026-07-25T11:00:00.500Z",
    }), /Run does not exist/u);
    assert.throws(() => fixture.store.currentRunLifecycleBinding(
      fixture.projectId,
      fixture.runId,
    ), /Run does not exist/u);
    fixture.store.restoreResource(
      "project",
      fixture.projectId,
      "2026-07-25T11:00:01.000Z",
    );
    assert.throws(() => fixture.store.trashRun({
      commandId: "command_negative_nonterminal",
      projectId: fixture.projectId,
      runId: fixture.runId,
      expectedLifecycleDigest: queued.lifecycleDigest,
      confirmation: {
        action: "trash_run",
        projectId: fixture.projectId,
        runId: fixture.runId,
        terminalStatus: "succeeded",
        terminalClosureDigest: "a".repeat(64),
      },
      committedAt: "2026-07-25T11:01:00.000Z",
    }), /run_not_terminal:/u);
    assert.throws(() => fixture.store.restoreRun({
      commandId: "command_negative_restore",
      projectId: fixture.projectId,
      runId: fixture.runId,
      expectedLifecycleDigest: queued.lifecycleDigest,
      committedAt: "2026-07-25T11:01:01.000Z",
    }), /state_conflict:/u);
    assert.equal(
      fixture.store.currentRunLifecycleBinding(fixture.projectId, fixture.runId).status,
      "queued",
    );
  } finally {
    fixture.close();
  }
});

const trashInput = (
  fixture: Pick<Fixture, "projectId" | "runId">,
  binding: ReturnType<ProductStoreV2["currentRunLifecycleBinding"]>,
  commandId: string,
) => ({
  commandId,
  projectId: fixture.projectId,
  runId: fixture.runId,
  expectedLifecycleDigest: binding.lifecycleDigest,
  confirmation: {
    action: "trash_run" as const,
    projectId: fixture.projectId,
    runId: fixture.runId,
    terminalStatus: binding.terminalStatus!,
    terminalClosureDigest: binding.terminalClosureDigest!,
  },
});

type Fixture = {
  store: ProductStoreV2;
  root: string;
  parent: string;
  projectId: string;
  runId: string;
  close: () => void;
};

const createFixture = (suffix: string): Fixture => {
  const parent = mkdtempSync(join(tmpdir(), `riff-run-lifecycle-${suffix}-`));
  const root = join(parent, "store");
  const store = ProductStoreV2.open(root);
  const modelId = `model_${suffix}`;
  const projectId = `project_${suffix}`;
  const experimentId = `experiment_${suffix}`;
  const runId = `run_${suffix}`;
  store.createModel({
    id: modelId,
    name: suffix,
    technicalStatus: "executable",
    runMode: "batch",
    executionDescription: EXECUTION_DESCRIPTION,
    createdAt: "2026-07-25T10:00:00.000Z",
    files: [{
      id: `file_${suffix}_model`,
      kind: "model_code",
      relativePath: "model.py",
      mediaType: "text/x-python",
      bytes: Buffer.from("raise SystemExit(0)\n"),
    }, {
      id: `file_${suffix}_environment`,
      kind: "model_environment",
      relativePath: "requirements.txt",
      mediaType: "text/plain",
      bytes: Buffer.from("# no external dependencies\n"),
    }],
  });
  const project = store.createProjectFromModel({
    projectId,
    projectName: suffix,
    sourceModelId: modelId,
    createdAt: "2026-07-25T10:00:00.000Z",
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
    name: suffix,
    plan,
    createdAt: "2026-07-25T10:00:00.000Z",
  });
  store.createFrozenRun({
    commandId: `command_${suffix}_run`,
    runId,
    projectId,
    experimentConfigId: experimentId,
    completionConversationId: null,
    expectedConfigurationDigest: plan.configurationDigest,
    plan,
    projectSnapshotDigest: project.modelSnapshotDigest,
    executionDescriptionDigest: canonicalDigest(project.executionDescription),
    limits: LIMITS,
    createdAt: "2026-07-25T10:01:00.000Z",
  });
  const fixture: Fixture = {
    store,
    root,
    parent,
    projectId,
    runId,
    close() {
      fixture.store.close();
      rmSync(parent, { recursive: true, force: true });
    },
  };
  return fixture;
};

const finishSucceeded = (store: ProductStoreV2, runId: string): void => {
  store.activateDispatcherGeneration({
    generation: GENERATION,
    activatedAt: "2026-07-25T10:01:01.000Z",
  });
  const claim = store.claimNextQueuedBatchRun({
    dispatcherGeneration: GENERATION,
    claimedAt: "2026-07-25T10:01:02.000Z",
    leaseExpiresAt: "2026-07-25T10:02:02.000Z",
  })!;
  assert.equal(claim.run.id, runId);
  const attempt = attemptIdentity(claim);
  store.markRunAttemptStarting({
    ...attempt,
    startedAt: "2026-07-25T10:01:03.000Z",
  });
  store.markRunAttemptRunning({
    ...attempt,
    startedAt: "2026-07-25T10:01:04.000Z",
    leaseExpiresAt: "2026-07-25T10:02:04.000Z",
  });
  const sample = claim.run.samplePlan[0] as { sampleIndex: number; sampleId: string };
  const process = processIdentity(claim, sample.sampleIndex, sample.sampleId);
  store.registerBatchProcessAttempt({
    ...process,
    launchedAt: "2026-07-25T10:01:05.000Z",
  });
  store.markBatchProcessGateReleased({
    ...process,
    startedAt: "2026-07-25T10:01:06.000Z",
  });
  store.markBatchProcessStarted({
    ...process,
    startedAt: "2026-07-25T10:01:07.000Z",
  });
  store.recordBatchProcessExit({
    ...process,
    expectedState: "running",
    exitedAt: "2026-07-25T10:01:08.000Z",
    exitCode: 0,
    exitSignal: null,
  });
  store.finalizeBatchProcessCleanup({
    ...process,
    cleanupVerified: true,
    cleanupReceiptDigest: canonicalDigest(process),
  });
  const eventBytes = Buffer.from(
    "{\"type\":\"sample_finished\",\"payload\":{\"ok\":true}}\n",
  );
  const parsed = parseDiagnosticEventNdjson(eventBytes);
  store.commitBatchRunSuccess({
    ...attempt,
    outputs: [{
      sampleIndex: sample.sampleIndex,
      sampleId: sample.sampleId,
      logicalName: "result",
      outputType: "data",
      bytes: Buffer.from("{\"ok\":true}\n"),
    }],
    diagnosticEventFiles: [{
      sampleIndex: sample.sampleIndex,
      sampleId: sample.sampleId,
      bytes: eventBytes,
      fileEventSetDigest: parsed.eventSetDigest,
      events: parsed.events,
    }],
    terminalDiagnostics: {},
    resourceOverview: { outputFiles: 2 },
    finishedAt: "2026-07-25T10:02:00.000Z",
  });
};

const finishTerminal = (
  store: ProductStoreV2,
  runId: string,
  status: "failed" | "cancelled" | "timed_out",
): void => {
  store.activateDispatcherGeneration({
    generation: GENERATION,
    activatedAt: "2026-07-25T10:01:01.000Z",
  });
  const claim = store.claimNextQueuedBatchRun({
    dispatcherGeneration: GENERATION,
    claimedAt: "2026-07-25T10:01:02.000Z",
    leaseExpiresAt: "2026-07-25T10:02:02.000Z",
  })!;
  assert.equal(claim.run.id, runId);
  const attempt = attemptIdentity(claim);
  store.markRunAttemptStarting({
    ...attempt,
    startedAt: "2026-07-25T10:01:03.000Z",
  });
  if (status === "cancelled") {
    store.cancelRun({
      commandId: `command_${runId}_cancel`,
      projectId: claim.run.projectId,
      runId,
      requestedAt: "2026-07-25T10:01:04.000Z",
    });
  }
  const terminal = store.finalizeBatchRunTerminal({
    ...attempt,
    expectedAttemptState: "starting",
    status: status === "timed_out" ? "timed_out" : "failed",
    terminalCode: status === "timed_out" ? "run_wall_timeout" : "batch_process_failed",
    terminalDiagnostics: {},
    resourceOverview: {},
    finishedAt: "2026-07-25T10:02:00.000Z",
  });
  assert.equal(terminal.status, status);
};

const attemptIdentity = (claim: {
  run: { id: string };
  attempt: { id: string; attemptGeneration: number; dispatcherGeneration: string };
}): RunAttemptIdentity => ({
  runId: claim.run.id,
  attemptId: claim.attempt.id,
  attemptGeneration: claim.attempt.attemptGeneration,
  dispatcherGeneration: claim.attempt.dispatcherGeneration,
});

const processIdentity = (
  claim: {
    run: { id: string };
    attempt: { id: string; attemptGeneration: number; dispatcherGeneration: string };
  },
  sampleIndex: number,
  sampleId: string,
): BatchProcessIdentity => ({
  ...attemptIdentity(claim),
  processAttemptId: `process_${claim.run.id}_${sampleIndex}`,
  sampleIndex,
  sampleId,
  pid: 2_000 + sampleIndex,
  processStartToken: `start-${sampleIndex}`,
  processGroupId: 2_000 + sampleIndex,
});
