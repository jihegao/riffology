import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalDigest } from "../src/canonical-json-v2.ts";
import { planExperiment } from "../src/experiment-planner.ts";
import type {
  BatchOutputCandidate,
  BatchScratchCleanupReceipt,
  BatchSupervisionResult,
  SuperviseBatchInput,
} from "../src/generic-batch-supervisor.ts";
import { openProductDatabase } from "../src/product-schema.ts";
import {
  ProductRunDispatcher,
  type BatchSupervisorPort,
} from "../src/product-run-dispatcher.ts";
import {
  ProductStoreV2,
  type BatchProcessIdentity,
  type RunAttemptIdentity,
  type RunLimitsV1,
} from "../src/product-store-v2.ts";

const INPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: { seed: { type: "integer" } },
  required: [],
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
  maxStdoutBytes: 100_000,
  maxStderrBytes: 100_000,
  maxOutputFiles: 10,
  maxOutputBytes: 1_000_000,
  maxEventCount: 1_000,
  maxEventBytes: 1_000_000,
  maxSamples: 10,
  maxConcurrency: 2,
};
const GENERATION_A = "a".repeat(64);
const GENERATION_B = "b".repeat(64);

test("dispatcher generation fences claims and batch attempts while success publishes outputs atomically", () => {
  const parent = mkdtempSync(join(tmpdir(), "riff-product-orchestration-"));
  let injectSuccessFault = false;
  const store = ProductStoreV2.openForTesting(join(parent, "store"), {
    coordinatorOptions: {
      faultInjector(point) {
        if (injectSuccessFault && point === "after_database_changes") {
          injectSuccessFault = false;
          throw new Error("injected batch success fault");
        }
      },
    },
  });
  try {
    store.createModel({
      id: "model_orchestration",
      name: "Orchestration",
      technicalStatus: "executable",
      runMode: "batch",
      executionDescription: EXECUTION_DESCRIPTION,
      createdAt: "2026-07-24T05:00:00.000Z",
      files: [
        {
          id: "file_orchestration_model",
          kind: "model_code",
          relativePath: "model.py",
          mediaType: "text/x-python",
          bytes: Buffer.from("print('orchestration')\n"),
        },
        {
          id: "file_orchestration_environment",
          kind: "model_environment",
          relativePath: "requirements.txt",
          mediaType: "text/plain",
          bytes: Buffer.from("# no external dependencies\n"),
        },
      ],
    });
    const project = store.createProjectFromModel({
      projectId: "project_orchestration",
      projectName: "Orchestration",
      sourceModelId: "model_orchestration",
      createdAt: "2026-07-24T05:00:00.000Z",
    });
    const executionCapability = store.projectExecutionCapability(project.id);
    assert.equal(executionCapability.executionDescription.schemaVersion, 2);
    assert.match(executionCapability.workspace.expectedExecutionRootDigest, /^[0-9a-f]{64}$/u);
    assert.equal(executionCapability.workspace.root.endsWith(
      "/objects/projects/project_orchestration/model-snapshot",
    ), true);
    const plan = planExperiment({
      configuration: {
        schemaVersion: 1,
        runKind: "batch",
        parameters: {},
        sampling: { kind: "multiple-seeds", seeds: [11, 12] },
      },
      inputSchema: INPUT_SCHEMA,
      maxSamples: LIMITS.maxSamples,
    });
    store.createExperimentV4({
      commandId: "command_create_orchestration",
      id: "experiment_orchestration",
      projectId: project.id,
      name: "Orchestration",
      plan,
      createdAt: "2026-07-24T05:00:00.000Z",
    });
    for (const [index, suffix] of ["stale", "success", "failure", "timeout", "atomic"].entries()) {
      store.createFrozenRun({
        commandId: `command_start_${suffix}`,
        runId: `run_${suffix}`,
        projectId: project.id,
        experimentConfigId: "experiment_orchestration",
        completionConversationId: null,
        expectedConfigurationDigest: plan.configurationDigest,
        plan,
        projectSnapshotDigest: project.modelSnapshotDigest,
        executionDescriptionDigest: canonicalDigest(project.executionDescription),
        limits: LIMITS,
        createdAt: `2026-07-24T05:0${index + 1}:00.000Z`,
      });
    }

    store.activateDispatcherGeneration({
      generation: GENERATION_A,
      activatedAt: "2026-07-24T06:00:00.000Z",
    });
    const staleClaim = store.claimNextQueuedBatchRun({
      dispatcherGeneration: GENERATION_A,
      claimedAt: "2026-07-24T06:00:01.000Z",
      leaseExpiresAt: "2026-07-24T06:00:31.000Z",
    })!;
    assert.equal(staleClaim.run.id, "run_stale");
    assert.throws(() => store.activateDispatcherGeneration({
      generation: GENERATION_B,
      activatedAt: "2026-07-24T06:00:02.000Z",
    }), /dispatcher_recovery_required/u);
    assert.doesNotThrow(() => store.heartbeatRunAttempt({
      ...attemptIdentity(staleClaim),
      expectedState: "claimed",
      heartbeatAt: "2026-07-24T06:00:03.000Z",
      leaseExpiresAt: "2026-07-24T06:00:33.000Z",
    }));
    store.markRunAttemptStarting({
      ...attemptIdentity(staleClaim),
      startedAt: "2026-07-24T06:00:04.000Z",
    });
    store.finalizeBatchRunTerminal({
      ...attemptIdentity(staleClaim),
      expectedAttemptState: "starting",
      status: "failed",
      terminalCode: "dispatcher_test_terminal",
      terminalDiagnostics: {},
      resourceOverview: {},
      finishedAt: "2026-07-24T06:00:05.000Z",
    });
    store.activateDispatcherGeneration({
      generation: GENERATION_B,
      activatedAt: "2026-07-24T06:00:06.000Z",
    });

    const successClaim = store.claimNextQueuedBatchRun({
      dispatcherGeneration: GENERATION_B,
      claimedAt: "2026-07-24T06:01:00.000Z",
      leaseExpiresAt: "2026-07-24T06:01:30.000Z",
    })!;
    assert.equal(successClaim.run.id, "run_success");
    const successAttempt = attemptIdentity(successClaim);
    store.markRunAttemptStarting({ ...successAttempt, startedAt: "2026-07-24T06:01:01.000Z" });
    store.markRunAttemptRunning({
      ...successAttempt,
      startedAt: "2026-07-24T06:01:02.000Z",
      leaseExpiresAt: "2026-07-24T06:01:32.000Z",
    });
    assert.throws(() => store.registerBatchProcessAttempt({
      ...processIdentity(successClaim, 0, plan.samples[1]!.sampleId),
      launchedAt: "2026-07-24T06:01:03.000Z",
    }), /process_attempt_sample_mismatch/u);
    for (const sample of plan.samples) completeSample(store, successClaim, sample.sampleIndex, sample.sampleId);
    assert.throws(() => store.commitBatchRunSuccess({
      ...successAttempt,
      outputs: [{
        sampleIndex: plan.samples[0]!.sampleIndex,
        sampleId: plan.samples[1]!.sampleId,
        logicalName: "result",
        outputType: "data",
        bytes: Buffer.from("{}"),
      }],
      terminalDiagnostics: {},
      resourceOverview: {},
      finishedAt: "2026-07-24T06:01:59.000Z",
    }), /run_output_invalid/u);
    assert.deepEqual(store.listRunOutputs(successClaim.run.id), []);
    const success = store.commitBatchRunSuccess({
      ...successAttempt,
      outputs: plan.samples.map((sample) => ({
        sampleIndex: sample.sampleIndex,
        sampleId: sample.sampleId,
        logicalName: "result",
        outputType: "data",
        bytes: Buffer.from(JSON.stringify({ seed: sample.seed })),
      })),
      terminalDiagnostics: { truncated: false },
      resourceOverview: { outputFiles: 2 },
      finishedAt: "2026-07-24T06:02:00.000Z",
    });
    assert.equal(success.run.status, "succeeded");
    assert.equal(success.outputs.length, 2);
    assert.deepEqual(success.outputs.map((output) => output.sampleId).sort(), plan.samples.map((sample) => sample.sampleId).sort());
    assert.equal(success.outputs.every((output) => store.readObjectFile(output.file.id).byteLength > 0), true);
    const tampered = success.outputs[0]!;
    writeFileSync(join(
      store.root,
      "objects",
      "projects",
      project.id,
      "runs",
      successClaim.run.id,
      tampered.file.relativePath,
    ), "tampered output");
    assert.throws(() => store.listRunOutputs(successClaim.run.id), /metadata or bytes drifted/u);

    const failureClaim = store.claimNextQueuedBatchRun({
      dispatcherGeneration: GENERATION_B,
      claimedAt: "2026-07-24T06:03:00.000Z",
      leaseExpiresAt: "2026-07-24T06:03:30.000Z",
    })!;
    store.markRunAttemptStarting({ ...attemptIdentity(failureClaim), startedAt: "2026-07-24T06:03:01.000Z" });
    assert.equal(store.finalizeBatchRunTerminal({
      ...attemptIdentity(failureClaim),
      expectedAttemptState: "starting",
      status: "failed",
      terminalCode: "batch_process_failed",
      terminalDiagnostics: { sampleIndex: 0 },
      resourceOverview: {},
      finishedAt: "2026-07-24T06:03:02.000Z",
    }).status, "failed");

    const timeoutClaim = store.claimNextQueuedBatchRun({
      dispatcherGeneration: GENERATION_B,
      claimedAt: "2026-07-24T06:04:00.000Z",
      leaseExpiresAt: "2026-07-24T06:04:30.000Z",
    })!;
    store.markRunAttemptStarting({ ...attemptIdentity(timeoutClaim), startedAt: "2026-07-24T06:04:01.000Z" });
    assert.equal(store.finalizeBatchRunTerminal({
      ...attemptIdentity(timeoutClaim),
      expectedAttemptState: "starting",
      status: "timed_out",
      terminalCode: "run_wall_timeout",
      terminalDiagnostics: {},
      resourceOverview: {},
      finishedAt: "2026-07-24T06:04:02.000Z",
    }).status, "timed_out");

    const atomicClaim = store.claimNextQueuedBatchRun({
      dispatcherGeneration: GENERATION_B,
      claimedAt: "2026-07-24T06:05:00.000Z",
      leaseExpiresAt: "2026-07-24T06:05:30.000Z",
    })!;
    const atomicAttempt = attemptIdentity(atomicClaim);
    store.markRunAttemptStarting({ ...atomicAttempt, startedAt: "2026-07-24T06:05:01.000Z" });
    store.markRunAttemptRunning({
      ...atomicAttempt,
      startedAt: "2026-07-24T06:05:02.000Z",
      leaseExpiresAt: "2026-07-24T06:05:32.000Z",
    });
    for (const sample of plan.samples) completeSample(store, atomicClaim, sample.sampleIndex, sample.sampleId);
    const atomicCommit = {
      ...atomicAttempt,
      outputs: plan.samples.map((sample) => ({
        sampleIndex: sample.sampleIndex,
        sampleId: sample.sampleId,
        logicalName: "result",
        outputType: "data",
        bytes: Buffer.from("{}"),
      })),
      terminalDiagnostics: {},
      resourceOverview: {},
      finishedAt: "2026-07-24T06:06:00.000Z",
    };
    injectSuccessFault = true;
    assert.throws(() => store.commitBatchRunSuccess(atomicCommit), /injected batch success fault/u);
    assert.equal(store.getRun(project.id, atomicClaim.run.id).status, "running");
    assert.deepEqual(store.listRunOutputs(atomicClaim.run.id), []);
    assert.equal(store.commitBatchRunSuccess(atomicCommit).run.status, "succeeded");
    assert.equal(store.listRunOutputs(atomicClaim.run.id).length, 2);
  } finally {
    store.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("version-3 experiments are rejected before run admission", () => {
  const parent = mkdtempSync(join(tmpdir(), "riff-product-v3-run-reject-"));
  const root = join(parent, "store");
  let store = ProductStoreV2.open(root);
  try {
    store.createModel({
      id: "model_v3_reject",
      name: "V3 reject",
      technicalStatus: "executable",
      runMode: "batch",
      executionDescription: EXECUTION_DESCRIPTION,
      createdAt: "2026-07-24T07:00:00.000Z",
      files: [{
        id: "file_v3_reject",
        kind: "model_code",
        relativePath: "model.py",
        mediaType: "text/x-python",
        bytes: Buffer.from("print('v3')\n"),
      }],
    });
    const project = store.createProjectFromModel({
      projectId: "project_v3_reject",
      projectName: "V3 reject",
      sourceModelId: "model_v3_reject",
      createdAt: "2026-07-24T07:00:00.000Z",
    });
    store.close();
    const database = openProductDatabase(join(root, "product.sqlite3"));
    database.exec("DROP TRIGGER experiment_v4_shape_insert");
    database.prepare(`INSERT INTO experiment_configurations
      (id, project_id, name, configuration_json, estimated_sample_count,
        lifecycle_state, created_at, updated_at, contract_version, legacy_digest,
        configuration_sha256, sample_count)
      VALUES ('experiment_v3_reject', ?, 'Legacy', ?, 1, 'active', ?, ?, 3, ?, NULL, NULL)`
    ).run(
      project.id,
      JSON.stringify({
        schemaVersion: 1,
        runKind: "batch",
        parameters: {},
        sampling: { kind: "single" },
      }),
      "2026-07-24T07:00:00.000Z",
      "2026-07-24T07:00:00.000Z",
      "c".repeat(64),
    );
    database.close();
    store = ProductStoreV2.open(root);
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
    assert.throws(() => store.createFrozenRun({
      commandId: "command_start_v3_reject",
      runId: "run_v3_reject",
      projectId: project.id,
      experimentConfigId: "experiment_v3_reject",
      completionConversationId: null,
      expectedConfigurationDigest: plan.configurationDigest,
      plan,
      projectSnapshotDigest: project.modelSnapshotDigest,
      executionDescriptionDigest: canonicalDigest(project.executionDescription),
      limits: LIMITS,
      createdAt: "2026-07-24T07:01:00.000Z",
    }), /legacy_contract_read_only/u);
  } finally {
    store.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("atomic batch success survives after-commit crash recovery without replaying guarded SQL", () => {
  let injectCrash = false;
  const fixture = createDispatcherFixture("atomic_success_recovery", {
    coordinatorOptions: {
      preserveRecoveryOnFault: true,
      faultInjector(point) {
        if (injectCrash && point === "after_sqlite_commit") throw new Error("injected after-commit crash");
      },
    },
  });
  let reopened: ProductStoreV2 | undefined;
  try {
    const generation = "c".repeat(64);
    fixture.store.activateDispatcherGeneration({
      generation,
      activatedAt: "2026-07-24T10:02:00.000Z",
    });
    const claim = fixture.store.claimNextQueuedBatchRun({
      dispatcherGeneration: generation,
      claimedAt: "2026-07-24T10:02:01.000Z",
      leaseExpiresAt: "2026-07-24T10:02:31.000Z",
    })!;
    const attempt = attemptIdentity(claim);
    fixture.store.markRunAttemptStarting({ ...attempt, startedAt: "2026-07-24T10:02:02.000Z" });
    fixture.store.markRunAttemptRunning({
      ...attempt,
      startedAt: "2026-07-24T10:02:03.000Z",
      leaseExpiresAt: "2026-07-24T10:02:33.000Z",
    });
    const sample = claim.run.samplePlan[0]!;
    completeSample(fixture.store, claim, sample.sampleIndex, sample.sampleId);
    injectCrash = true;
    assert.throws(() => fixture.store.commitBatchRunSuccess({
      ...attempt,
      outputs: [{
        sampleIndex: sample.sampleIndex,
        sampleId: sample.sampleId,
        logicalName: "result",
        outputType: "data",
        bytes: Buffer.from("{\"recovered\":true}"),
      }],
      terminalDiagnostics: { crashPoint: "after_sqlite_commit" },
      resourceOverview: { outputFiles: 1 },
      finishedAt: "2026-07-24T10:02:04.000Z",
    }), /injected after-commit crash/u);
    fixture.store.close();

    reopened = ProductStoreV2.open(fixture.root);
    assert.equal(reopened.getRun(fixture.projectId, fixture.runId).status, "succeeded");
    const outputs = reopened.listRunOutputs(fixture.runId);
    assert.equal(outputs.length, 1);
    assert.equal(reopened.readObjectFile(outputs[0]!.file.id).toString("utf8"), "{\"recovered\":true}");
    assert.deepEqual(readdirSync(join(fixture.root, ".recovery")), []);
  } finally {
    reopened?.close();
    fixture.store.close();
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("dispatcher persists pre-registration failures and surfaces registered-process failures", async () => {
  const parent = mkdtempSync(join(tmpdir(), "riff-product-dispatcher-errors-"));
  const store = ProductStoreV2.openForTesting(join(parent, "store"), {});
  let dispatcher: ProductRunDispatcher | undefined;
  try {
    store.createModel({
      id: "model_dispatcher_errors",
      name: "Dispatcher errors",
      technicalStatus: "executable",
      runMode: "batch",
      executionDescription: EXECUTION_DESCRIPTION,
      createdAt: "2026-07-24T08:00:00.000Z",
      files: [
        {
          id: "file_dispatcher_error_model",
          kind: "model_code",
          relativePath: "model.py",
          mediaType: "text/x-python",
          bytes: Buffer.from("raise SystemExit(0)\n"),
        },
        {
          id: "file_dispatcher_error_environment",
          kind: "model_environment",
          relativePath: "requirements.txt",
          mediaType: "text/plain",
          bytes: Buffer.from("# no external dependencies\n"),
        },
      ],
    });
    const project = store.createProjectFromModel({
      projectId: "project_dispatcher_errors",
      projectName: "Dispatcher errors",
      sourceModelId: "model_dispatcher_errors",
      createdAt: "2026-07-24T08:00:00.000Z",
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
      commandId: "command_dispatcher_error_experiment",
      id: "experiment_dispatcher_errors",
      projectId: project.id,
      name: "Dispatcher errors",
      plan,
      createdAt: "2026-07-24T08:00:00.000Z",
    });
    for (const [index, suffix] of [
      "before_register",
      "blocked_failure",
      "released_failure",
      "after_register",
    ].entries()) {
      store.createFrozenRun({
        commandId: `command_dispatcher_${suffix}`,
        runId: `run_dispatcher_${suffix}`,
        projectId: project.id,
        experimentConfigId: "experiment_dispatcher_errors",
        completionConversationId: null,
        expectedConfigurationDigest: plan.configurationDigest,
        plan,
        projectSnapshotDigest: project.modelSnapshotDigest,
        executionDescriptionDigest: canonicalDigest(project.executionDescription),
        limits: LIMITS,
        createdAt: `2026-07-24T08:0${index + 1}:00.000Z`,
      });
    }

    let calls = 0;
    const failedResult = (
      input: SuperviseBatchInput,
      identity: {
        runId: string;
        sampleIndex: number;
        sampleId: string;
        scratchId: string;
        pid: number;
        processGroupId: number;
        startToken: string;
      },
    ): BatchSupervisionResult => ({
      runId: input.run.runId,
      status: "failed",
      code: "launch_gate_hook_failed",
      diagnostic: "The launch gate hook failed.",
      startedAt: "2026-07-24T08:05:00.000Z",
      finishedAt: "2026-07-24T08:05:01.000Z",
      samples: [{
        sampleIndex: identity.sampleIndex,
        sampleId: identity.sampleId,
        status: "failed",
        code: "launch_gate_hook_failed",
        diagnostic: "The launch gate hook failed.",
        identity,
        exitCode: null,
        signal: "SIGTERM",
        durationMs: 1,
        stdout: "",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        scratchId: identity.scratchId,
        scratchPath: `/private/fake/${identity.scratchId}`,
        outputs: [],
      }],
      outputs: [],
      resources: {
        maxConcurrencyObserved: 1,
        stdoutBytes: 0,
        stderrBytes: 0,
        outputFiles: 0,
        outputBytes: 0,
      },
    });
    const supervisor = {
      async supervise(input: SuperviseBatchInput): Promise<BatchSupervisionResult> {
        calls += 1;
        if (calls === 1) throw new Error("injected supervisor failure before registration");
        const sample = input.run.samples[0]!;
        const identity = {
          runId: input.run.runId,
          sampleIndex: sample.sampleIndex,
          sampleId: sample.sampleId,
          scratchId: "scratch-dispatcher-error",
          pid: 9_321,
          processGroupId: 9_321,
          startToken: "start-dispatcher-error",
        };
        await input.hooks?.registerProcess?.(identity);
        if (calls === 2) return failedResult(input, identity);
        await input.hooks?.markGateReleased?.(identity);
        if (calls === 3) return failedResult(input, identity);
        await input.hooks?.markProcessStarted?.(identity);
        throw new Error("injected supervisor failure after process registration");
      },
      cleanup(result: BatchSupervisionResult): BatchScratchCleanupReceipt {
        const receipt = {
          schemaVersion: 1 as const,
          runId: result.runId,
          scratchIds: result.samples.map((sample) => sample.scratchId),
          cleanedAt: "2026-07-24T08:05:02.000Z",
          verified: true as const,
        };
        return { ...receipt, receiptDigest: canonicalDigest(receipt) };
      },
    } satisfies BatchSupervisorPort;
    dispatcher = new ProductRunDispatcher({ store, supervisor, leaseMs: 1_000 });
    await dispatcher.start();
    for (let attempt = 0; attempt < 100 && !dispatcher.lastError; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const preRegistration = store.getRun(project.id, "run_dispatcher_before_register");
    assert.equal(preRegistration.status, "failed");
    assert.equal(preRegistration.terminalCode, "batch_supervisor_failed");
    assert.equal(store.listRunAttempts(preRegistration.id)[0]!.state, "failed");
    for (const suffix of ["blocked_failure", "released_failure"]) {
      const hookFailure = store.getRun(project.id, `run_dispatcher_${suffix}`);
      assert.equal(hookFailure.status, "failed");
      assert.equal(hookFailure.terminalCode, "launch_gate_hook_failed");
      assert.equal(store.listRunAttempts(hookFailure.id)[0]!.state, "failed");
    }
    assert.match(dispatcher.lastError?.message ?? "", /dispatcher_recovery_required/u);
    const registeredFailure = store.getRun(project.id, "run_dispatcher_after_register");
    assert.equal(registeredFailure.status, "running");
    assert.equal(store.listRunAttempts(registeredFailure.id)[0]!.state, "running");
    const replacement = new ProductRunDispatcher({ store, supervisor, leaseMs: 1_000 });
    await assert.rejects(() => replacement.start(), /dispatcher_recovery_required/u);
  } finally {
    await dispatcher?.stop();
    store.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("dispatcher stop aborts an active supervisor and durably cleans up the failed run", async () => {
  const parent = mkdtempSync(join(tmpdir(), "riff-product-dispatcher-stop-"));
  const store = ProductStoreV2.openForTesting(join(parent, "store"), {});
  let dispatcher: ProductRunDispatcher | undefined;
  try {
    store.createModel({
      id: "model_dispatcher_stop",
      name: "Dispatcher stop",
      technicalStatus: "executable",
      runMode: "batch",
      executionDescription: EXECUTION_DESCRIPTION,
      createdAt: "2026-07-24T09:00:00.000Z",
      files: [
        {
          id: "file_dispatcher_stop_model",
          kind: "model_code",
          relativePath: "model.py",
          mediaType: "text/x-python",
          bytes: Buffer.from("raise SystemExit(0)\n"),
        },
        {
          id: "file_dispatcher_stop_environment",
          kind: "model_environment",
          relativePath: "requirements.txt",
          mediaType: "text/plain",
          bytes: Buffer.from("# no external dependencies\n"),
        },
      ],
    });
    const project = store.createProjectFromModel({
      projectId: "project_dispatcher_stop",
      projectName: "Dispatcher stop",
      sourceModelId: "model_dispatcher_stop",
      createdAt: "2026-07-24T09:00:00.000Z",
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
      commandId: "command_dispatcher_stop_experiment",
      id: "experiment_dispatcher_stop",
      projectId: project.id,
      name: "Dispatcher stop",
      plan,
      createdAt: "2026-07-24T09:00:00.000Z",
    });
    store.createFrozenRun({
      commandId: "command_dispatcher_stop_run",
      runId: "run_dispatcher_stop",
      projectId: project.id,
      experimentConfigId: "experiment_dispatcher_stop",
      completionConversationId: null,
      expectedConfigurationDigest: plan.configurationDigest,
      plan,
      projectSnapshotDigest: project.modelSnapshotDigest,
      executionDescriptionDigest: canonicalDigest(project.executionDescription),
      limits: LIMITS,
      createdAt: "2026-07-24T09:01:00.000Z",
    });

    let entered!: () => void;
    const active = new Promise<void>((resolve) => { entered = resolve; });
    const supervisor = {
      async supervise(input: SuperviseBatchInput): Promise<BatchSupervisionResult> {
        const sample = input.run.samples[0]!;
        const identity = {
          runId: input.run.runId,
          sampleIndex: sample.sampleIndex,
          sampleId: sample.sampleId,
          scratchId: "scratch-dispatcher-stop",
          pid: 9_654,
          processGroupId: 9_654,
          startToken: "start-dispatcher-stop",
        };
        await input.hooks?.registerProcess?.(identity);
        await input.hooks?.markGateReleased?.(identity);
        await input.hooks?.markProcessStarted?.(identity);
        entered();
        await new Promise<void>((resolve) => {
          if (input.signal?.aborted) resolve();
          else input.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return {
          runId: input.run.runId,
          status: "failed",
          code: "dispatcher_shutdown",
          diagnostic: "The dispatcher shut down.",
          startedAt: "2026-07-24T09:01:01.000Z",
          finishedAt: "2026-07-24T09:01:02.000Z",
          samples: [{
            sampleIndex: sample.sampleIndex,
            sampleId: sample.sampleId,
            status: "failed",
            code: "dispatcher_shutdown",
            diagnostic: "The dispatcher shut down.",
            identity,
            exitCode: null,
            signal: "SIGTERM",
            durationMs: 1,
            stdout: "",
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
            scratchId: identity.scratchId,
            scratchPath: "/private/fake/dispatcher-stop",
            outputs: [],
          }],
          outputs: [],
          resources: {
            maxConcurrencyObserved: 1,
            stdoutBytes: 0,
            stderrBytes: 0,
            outputFiles: 0,
            outputBytes: 0,
          },
        };
      },
      cleanup(result: BatchSupervisionResult): BatchScratchCleanupReceipt {
        const receipt = {
          schemaVersion: 1 as const,
          runId: result.runId,
          scratchIds: result.samples.map((sample) => sample.scratchId),
          cleanedAt: "2026-07-24T09:01:03.000Z",
          verified: true as const,
        };
        return { ...receipt, receiptDigest: canonicalDigest(receipt) };
      },
    } satisfies BatchSupervisorPort;
    dispatcher = new ProductRunDispatcher({ store, supervisor, leaseMs: 1_000 });
    await dispatcher.start();
    await active;
    await dispatcher.stop();

    const run = store.getRun(project.id, "run_dispatcher_stop");
    assert.equal(run.status, "failed");
    assert.equal(run.terminalCode, "dispatcher_shutdown");
    assert.equal(store.listRunAttempts(run.id)[0]!.state, "failed");
    assert.equal(dispatcher.lastError, null);
  } finally {
    await dispatcher?.stop();
    store.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("dispatcher unwinds a Project capability failure before any process registration", async () => {
  const fixture = createDispatcherFixture("capability_unwind");
  let dispatcher: ProductRunDispatcher | undefined;
  try {
    const storePort = overrideDispatcherStore(fixture.store, {
      projectExecutionCapability() {
        throw new Error("project_snapshot_corrupt: injected capability failure");
      },
    });
    const supervisor = {
      async supervise(): Promise<BatchSupervisionResult> {
        throw new Error("supervisor must not run after a capability failure");
      },
      cleanup(): BatchScratchCleanupReceipt {
        throw new Error("cleanup must not run without a supervision result");
      },
    } satisfies BatchSupervisorPort;
    dispatcher = new ProductRunDispatcher({ store: storePort, supervisor, leaseMs: 1_000 });
    await dispatcher.start();
    const run = await waitForTerminalRun(fixture.store, fixture.projectId, fixture.runId);
    assert.equal(run.status, "failed");
    assert.equal(run.terminalCode, "project_snapshot_corrupt");
    assert.equal(fixture.store.listRunAttempts(run.id)[0]!.state, "failed");
    assert.equal(dispatcher.lastError, null);
  } finally {
    await dispatcher?.stop();
    fixture.close();
  }
});

test("dispatcher heartbeat failure aborts and unwinds returned process evidence", async () => {
  const fixture = createDispatcherFixture("heartbeat_unwind");
  let dispatcher: ProductRunDispatcher | undefined;
  try {
    const storePort = overrideDispatcherStore(fixture.store, {
      heartbeatRunAttempt() {
        throw new Error("injected heartbeat failure");
      },
    });
    const supervisor = syntheticSupervisor({
      status: "failed",
      code: "batch_process_failed",
      delayMs: 350,
    });
    dispatcher = new ProductRunDispatcher({ store: storePort, supervisor, leaseMs: 1_000 });
    await dispatcher.start();
    const run = await waitForTerminalRun(fixture.store, fixture.projectId, fixture.runId);
    assert.equal(run.status, "failed");
    assert.equal(run.terminalCode, "dispatcher_heartbeat_failed");
    const replacement = new ProductRunDispatcher({ store: fixture.store, supervisor, leaseMs: 1_000 });
    await assert.doesNotReject(() => replacement.start());
    await replacement.stop();
    assert.equal(dispatcher.lastError, null);
  } finally {
    await dispatcher?.stop();
    fixture.close();
  }
});

test("dispatcher converts an atomic success-publication exception into a cleaned failed run", async () => {
  const fixture = createDispatcherFixture("commit_unwind");
  let dispatcher: ProductRunDispatcher | undefined;
  try {
    const storePort = overrideDispatcherStore(fixture.store, {
      commitBatchRunSuccess() {
        throw new Error("injected commit failure");
      },
    });
    const baseSupervisor = syntheticSupervisor({
      status: "succeeded",
      code: "batch_run_succeeded",
      includeOutput: true,
    });
    let cleanupCalls = 0;
    const supervisor = {
      supervise: baseSupervisor.supervise,
      cleanup(result: BatchSupervisionResult): BatchScratchCleanupReceipt {
        cleanupCalls += 1;
        if (cleanupCalls > 1) throw new Error("scratch_cleanup_unverified: cleanup is not idempotent");
        return baseSupervisor.cleanup(result);
      },
    } satisfies BatchSupervisorPort;
    dispatcher = new ProductRunDispatcher({
      store: storePort,
      supervisor,
      leaseMs: 1_000,
      consumeOutput: () => Buffer.from("{}"),
    });
    await dispatcher.start();
    const run = await waitForTerminalRun(fixture.store, fixture.projectId, fixture.runId);
    assert.equal(run.status, "failed");
    assert.equal(run.terminalCode, "batch_publication_failed");
    assert.deepEqual(fixture.store.listRunOutputs(run.id), []);
    assert.equal(cleanupCalls, 1);
    const replacement = new ProductRunDispatcher({ store: fixture.store, supervisor, leaseMs: 1_000 });
    await assert.doesNotReject(() => replacement.start());
    await replacement.stop();
    assert.equal(dispatcher.lastError, null);
  } finally {
    await dispatcher?.stop();
    fixture.close();
  }
});

test("dispatcher leaves a run recovery-required when cleanup cannot be proven", async () => {
  const fixture = createDispatcherFixture("cleanup_recovery");
  let dispatcher: ProductRunDispatcher | undefined;
  try {
    const base = syntheticSupervisor({
      status: "failed",
      code: "batch_process_failed",
    });
    const supervisor = {
      supervise: base.supervise,
      cleanup(): BatchScratchCleanupReceipt {
        throw new Error("injected cleanup verification failure");
      },
    } satisfies BatchSupervisorPort;
    dispatcher = new ProductRunDispatcher({ store: fixture.store, supervisor, leaseMs: 1_000 });
    await dispatcher.start();
    for (let attempt = 0; attempt < 200 && !dispatcher.lastError; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.match(dispatcher.lastError?.message ?? "", /dispatcher_recovery_required/u);
    assert.equal(fixture.store.getRun(fixture.projectId, fixture.runId).status, "running");
    const replacement = new ProductRunDispatcher({ store: fixture.store, supervisor, leaseMs: 1_000 });
    await assert.rejects(() => replacement.start(), /dispatcher_recovery_required/u);
  } finally {
    await dispatcher?.stop();
    fixture.close();
  }
});

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
  pid: 1_000 + sampleIndex,
  processStartToken: `start-${sampleIndex}`,
  processGroupId: 1_000 + sampleIndex,
});

const completeSample = (
  store: ProductStoreV2,
  claim: {
    run: { id: string };
    attempt: { id: string; attemptGeneration: number; dispatcherGeneration: string };
  },
  sampleIndex: number,
  sampleId: string,
): void => {
  const identity = processIdentity(claim, sampleIndex, sampleId);
  store.registerBatchProcessAttempt({ ...identity, launchedAt: "2026-07-24T06:01:03.000Z" });
  store.markBatchProcessGateReleased({ ...identity, startedAt: "2026-07-24T06:01:04.000Z" });
  store.markBatchProcessStarted({ ...identity, startedAt: "2026-07-24T06:01:05.000Z" });
  store.heartbeatBatchProcess({ ...identity, expectedState: "running", heartbeatAt: "2026-07-24T06:01:06.000Z" });
  store.recordBatchProcessExit({
    ...identity,
    expectedState: "running",
    exitedAt: "2026-07-24T06:01:07.000Z",
    exitCode: 0,
    exitSignal: null,
  });
  store.finalizeBatchProcessCleanup({
    ...identity,
    cleanupVerified: true,
    cleanupReceiptDigest: canonicalDigest(identity),
  });
};

const createDispatcherFixture = (
  suffix: string,
  options: Parameters<typeof ProductStoreV2.openForTesting>[1] = {},
): {
  store: ProductStoreV2;
  projectId: string;
  runId: string;
  root: string;
  parent: string;
  close: () => void;
} => {
  const parent = mkdtempSync(join(tmpdir(), `riff-product-${suffix}-`));
  const root = join(parent, "store");
  const store = ProductStoreV2.openForTesting(root, options);
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
    createdAt: "2026-07-24T10:00:00.000Z",
    files: [
      {
        id: `file_${suffix}_model`,
        kind: "model_code",
        relativePath: "model.py",
        mediaType: "text/x-python",
        bytes: Buffer.from("raise SystemExit(0)\n"),
      },
      {
        id: `file_${suffix}_environment`,
        kind: "model_environment",
        relativePath: "requirements.txt",
        mediaType: "text/plain",
        bytes: Buffer.from("# no external dependencies\n"),
      },
    ],
  });
  const project = store.createProjectFromModel({
    projectId,
    projectName: suffix,
    sourceModelId: modelId,
    createdAt: "2026-07-24T10:00:00.000Z",
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
    createdAt: "2026-07-24T10:00:00.000Z",
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
    createdAt: "2026-07-24T10:01:00.000Z",
  });
  return {
    store,
    projectId,
    runId,
    root,
    parent,
    close() {
      store.close();
      rmSync(parent, { recursive: true, force: true });
    },
  };
};

const overrideDispatcherStore = (
  store: ProductStoreV2,
  overrides: Partial<Record<keyof ProductStoreV2, (...args: any[]) => any>>,
): ProductStoreV2 => new Proxy(store, {
  get(target, property, receiver) {
    const override = overrides[property as keyof ProductStoreV2];
    if (override) return override;
    const value = Reflect.get(target, property, receiver);
    return typeof value === "function" ? value.bind(target) : value;
  },
});

const syntheticSupervisor = (options: {
  status: "succeeded" | "failed";
  code: string;
  delayMs?: number;
  includeOutput?: boolean;
}): BatchSupervisorPort => ({
  async supervise(input): Promise<BatchSupervisionResult> {
    const sample = input.run.samples[0]!;
    const identity = {
      runId: input.run.runId,
      sampleIndex: sample.sampleIndex,
      sampleId: sample.sampleId,
      scratchId: `scratch-${input.run.runId}`,
      pid: 9_876,
      processGroupId: 9_876,
      startToken: `start-${input.run.runId}`,
    };
    await input.hooks?.registerProcess?.(identity);
    await input.hooks?.markGateReleased?.(identity);
    await input.hooks?.markProcessStarted?.(identity);
    if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    const output: BatchOutputCandidate = {
      sampleIndex: sample.sampleIndex,
      sampleId: sample.sampleId,
      logicalName: "result",
      relativePath: "outputs/result.json",
      mediaType: "application/json",
      role: "data",
      sourcePath: "/private/fake/result.json",
      scratchPath: `/private/fake/${identity.scratchId}`,
      sizeBytes: 2,
      sha256: canonicalDigest({}),
      owner: 0,
      device: 1,
      inode: 1,
    };
    return {
      runId: input.run.runId,
      status: options.status,
      code: options.code,
      diagnostic: options.code,
      startedAt: "2026-07-24T10:01:01.000Z",
      finishedAt: "2026-07-24T10:01:02.000Z",
      samples: [{
        sampleIndex: sample.sampleIndex,
        sampleId: sample.sampleId,
        status: options.status,
        code: options.code,
        diagnostic: options.code,
        identity,
        exitCode: options.status === "succeeded" ? 0 : 1,
        signal: null,
        durationMs: 1,
        stdout: "",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        scratchId: identity.scratchId,
        scratchPath: `/private/fake/${identity.scratchId}`,
        outputs: options.includeOutput ? [output] : [],
      }],
      outputs: options.includeOutput ? [output] : [],
      resources: {
        maxConcurrencyObserved: 1,
        stdoutBytes: 0,
        stderrBytes: 0,
        outputFiles: options.includeOutput ? 1 : 0,
        outputBytes: options.includeOutput ? 2 : 0,
      },
    };
  },
  cleanup(result): BatchScratchCleanupReceipt {
    const receipt = {
      schemaVersion: 1 as const,
      runId: result.runId,
      scratchIds: result.samples.map((sample) => sample.scratchId),
      cleanedAt: "2026-07-24T10:01:03.000Z",
      verified: true as const,
    };
    return { ...receipt, receiptDigest: canonicalDigest(receipt) };
  },
});

const waitForTerminalRun = async (
  store: ProductStoreV2,
  projectId: string,
  runId: string,
): Promise<ReturnType<ProductStoreV2["getRun"]>> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const run = store.getRun(projectId, runId);
    if (["succeeded", "failed", "timed_out", "cancelled"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${runId} to become terminal.`);
};
