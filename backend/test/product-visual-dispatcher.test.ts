import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { canonicalDigest } from "../src/canonical-json-v2.ts";
import { planExperiment } from "../src/experiment-planner.ts";
import type {
  BatchLaunchReceipt,
  BatchOutputCandidate,
  BatchScratchCleanupReceipt,
  BatchSupervisionResult,
  SuperviseBatchInput,
} from "../src/generic-batch-supervisor.ts";
import type {
  SuperviseVisualInput,
  VisualOutputCandidate,
  VisualScratchCleanupReceipt,
  VisualSupervisionResult,
} from "../src/generic-visual-supervisor.ts";
import {
  ProductRunDispatcher,
  type BatchSupervisorPort,
  type VisualSupervisorPort,
} from "../src/product-run-dispatcher.ts";
import {
  ProductStoreV2,
  type RunLimitsV1,
  type VisualLaunchReceipt,
} from "../src/product-store-v2.ts";

const INPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: { value: { type: "integer" } },
  required: ["value"],
  additionalProperties: false,
};
const OUTPUTS = [{
  logicalName: "result",
  relativePath: "outputs/result.json",
  mediaType: "application/json",
  required: true,
  role: "data",
}] as const;
const VISUAL_EXECUTION = {
  schemaVersion: 2,
  runtime: "python",
  runMode: "visual",
  dependencyFile: "environment/requirements.txt",
  inputs: {
    schemaProfile: "riff-json-schema-2020-12-v1",
    schema: INPUT_SCHEMA,
    smoke: { value: 1 },
  },
  outputs: OUTPUTS,
  visual: {
    entryPoint: "code/model.py",
    protocol: "riff-visual-v1",
    healthPath: "/healthz",
  },
  cancellation: { signal: "SIGTERM", graceMs: 1_000 },
};
const BATCH_EXECUTION = {
  schemaVersion: 2,
  runtime: "python",
  runMode: "batch",
  dependencyFile: "environment/requirements.txt",
  inputs: {
    schemaProfile: "riff-json-schema-2020-12-v1",
    schema: INPUT_SCHEMA,
    smoke: { value: 1 },
  },
  outputs: OUTPUTS,
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
  maxEventCount: 100,
  maxEventBytes: 100_000,
  maxSamples: 10,
  maxConcurrency: 2,
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
};

type LaneControl = {
  entered: Deferred<void>;
  release: Deferred<void>;
  wait: "none" | "abort" | "release-or-abort" | "abort-then-release";
  onStart?: () => void;
};

const deferred = <T = void>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((done) => { resolve = done; }),
    resolve,
  };
};

const laneControl = (
  wait: LaneControl["wait"],
  onStart?: () => void,
): LaneControl => ({
  entered: deferred(),
  release: deferred(),
  wait,
  ...(onStart ? { onStart } : {}),
});

const waitForAbort = async (signal: AbortSignal | undefined): Promise<void> => {
  assert.ok(signal, "dispatcher must pass an AbortSignal");
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
};

const obeyControl = async (
  control: LaneControl,
  signal: AbortSignal | undefined,
): Promise<void> => {
  control.onStart?.();
  control.entered.resolve();
  if (control.wait === "none") return;
  if (control.wait === "abort") return waitForAbort(signal);
  if (control.wait === "release-or-abort") {
    await Promise.race([control.release.promise, waitForAbort(signal)]);
    return;
  }
  await waitForAbort(signal);
  await control.release.promise;
};

type VisualHarness = {
  supervisor: VisualSupervisorPort;
  calls: string[];
  cleanupCalls: string[];
  signals: Map<string, AbortSignal>;
  processAttemptIds: Map<string, string>;
};

const visualHarness = (
  controls: ReadonlyMap<string, LaneControl>,
): VisualHarness => {
  const calls: string[] = [];
  const cleanupCalls: string[] = [];
  const signals = new Map<string, AbortSignal>();
  const processAttemptIds = new Map<string, string>();
  let sequence = 0;
  const supervisor: VisualSupervisorPort = {
    async supervise(input: SuperviseVisualInput): Promise<VisualSupervisionResult> {
      const control = controls.get(input.run.runId);
      assert.ok(control, `missing visual control for ${input.run.runId}`);
      assert.ok(input.signal);
      calls.push(input.run.runId);
      signals.set(input.run.runId, input.signal);
      sequence += 1;
      const plan = {
        processKind: "visual" as const,
        runId: input.run.runId,
        sampleIndex: 0 as const,
        sampleId: input.run.sample.sampleId,
        scratchId: `scratch_${input.run.runId}`,
        relativePath: `visual-${input.run.runId}`,
        loopbackPort: 42_300 + sequence,
        healthPath: "/healthz",
      };
      const binding = await input.hooks?.planScratch?.(plan);
      assert.ok(binding);
      await input.hooks?.registerScratchDirectory?.({
        ...plan,
        ownerUid: 501,
        device: 42,
        inode: 1_000 + sequence,
      });
      const identity = {
        processKind: "visual" as const,
        processAttemptId: `process_${input.run.runId}_exact`,
        runId: input.run.runId,
        sampleIndex: 0 as const,
        sampleId: input.run.sample.sampleId,
        scratchId: plan.scratchId,
        pid: 9_100 + sequence,
        processGroupId: 9_100 + sequence,
        processStartToken: `visual-start-${sequence}`,
        loopbackPort: plan.loopbackPort,
        healthPath: plan.healthPath,
      };
      processAttemptIds.set(input.run.runId, identity.processAttemptId);
      const unsignedReceipt = {
        schemaVersion: 1 as const,
        manifestId: binding.manifestId,
        manifestDigest: binding.manifestDigest,
        runId: identity.runId,
        sampleIndex: identity.sampleIndex,
        sampleId: identity.sampleId,
        scratchId: identity.scratchId,
        relativePath: plan.relativePath,
        pid: identity.pid,
        processGroupId: identity.processGroupId,
        processStartToken: identity.processStartToken,
        loopbackHost: "127.0.0.1" as const,
        loopbackPort: identity.loopbackPort,
        healthPath: identity.healthPath,
        createdAt: new Date().toISOString(),
      };
      const receipt: VisualLaunchReceipt = {
        ...unsignedReceipt,
        receiptDigest: canonicalDigest(unsignedReceipt),
      };
      await input.hooks?.registerProcess?.(identity, receipt);
      await input.hooks?.markGateReleased?.(identity);
      await input.hooks?.markProcessStarted?.(identity);
      await input.hooks?.recordHealth?.(identity);
      await obeyControl(control, input.signal);

      const failed = input.signal.aborted;
      const output: VisualOutputCandidate = {
        logicalName: "result",
        relativePath: "outputs/result.json",
        mediaType: "application/json",
        role: "data",
        sourcePath: `/private/fake/${input.run.runId}/outputs/result.json`,
        scratchPath: `/private/fake/${plan.scratchId}`,
        sizeBytes: 2,
        sha256: canonicalDigest({}),
        owner: 501,
        device: 42,
        inode: 2_000 + sequence,
      };
      return {
        runId: input.run.runId,
        status: failed ? "failed" : "succeeded",
        code: failed ? "dispatcher_shutdown" : "visual_run_succeeded",
        diagnostic: failed ? "The visual dispatcher shut down." : "Visual run succeeded.",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        identity: {
          processKind: identity.processKind,
          processAttemptId: identity.processAttemptId,
          runId: identity.runId,
          sampleIndex: identity.sampleIndex,
          sampleId: identity.sampleId,
          scratchId: identity.scratchId,
          pid: identity.pid,
          processGroupId: identity.processGroupId,
          processStartToken: identity.processStartToken,
        },
        exitCode: failed ? null : 0,
        signal: failed ? "SIGTERM" : null,
        stdoutBytes: 0,
        stderrBytes: 0,
        stdoutTruncated: false,
        stderrTruncated: false,
        scratchId: plan.scratchId,
        scratchPath: `/private/fake/${plan.scratchId}`,
        outputs: failed ? [] : [output],
        healthVerified: true,
      };
    },
    cleanup(result: VisualSupervisionResult): VisualScratchCleanupReceipt {
      cleanupCalls.push(result.runId);
      const unsigned = {
        schemaVersion: 1 as const,
        runId: result.runId,
        scratchId: result.scratchId,
        cleanedAt: new Date().toISOString(),
        verified: true as const,
      };
      return { ...unsigned, receiptDigest: canonicalDigest(unsigned) };
    },
  };
  return { supervisor, calls, cleanupCalls, signals, processAttemptIds };
};

type BatchHarness = {
  supervisor: BatchSupervisorPort;
  calls: string[];
  cleanupCalls: string[];
  signals: Map<string, AbortSignal>;
};

const batchHarness = (
  controls: ReadonlyMap<string, LaneControl>,
): BatchHarness => {
  const calls: string[] = [];
  const cleanupCalls: string[] = [];
  const signals = new Map<string, AbortSignal>();
  let sequence = 0;
  const supervisor: BatchSupervisorPort = {
    async supervise(input: SuperviseBatchInput): Promise<BatchSupervisionResult> {
      const control = controls.get(input.run.runId);
      assert.ok(control, `missing batch control for ${input.run.runId}`);
      assert.ok(input.signal);
      calls.push(input.run.runId);
      signals.set(input.run.runId, input.signal);
      sequence += 1;
      const sample = input.run.samples[0]!;
      const plan = {
        runId: input.run.runId,
        sampleIndex: sample.sampleIndex,
        sampleId: sample.sampleId,
        scratchId: `scratch_${input.run.runId}`,
        relativePath: `batch-${input.run.runId}`,
      };
      const binding = await input.hooks?.planScratch?.(plan);
      assert.ok(binding);
      await input.hooks?.registerScratchDirectory?.({
        ...plan,
        ownerUid: 501,
        device: 43,
        inode: 3_000 + sequence,
      });
      const identity = {
        runId: input.run.runId,
        sampleIndex: sample.sampleIndex,
        sampleId: sample.sampleId,
        scratchId: plan.scratchId,
        pid: 9_300 + sequence,
        processGroupId: 9_300 + sequence,
        startToken: `batch-start-${sequence}`,
      };
      const unsignedReceipt = {
        schemaVersion: 1 as const,
        manifestId: binding.manifestId,
        manifestDigest: binding.manifestDigest,
        runId: identity.runId,
        sampleIndex: identity.sampleIndex,
        sampleId: identity.sampleId,
        scratchId: identity.scratchId,
        relativePath: plan.relativePath,
        pid: identity.pid,
        processGroupId: identity.processGroupId,
        processStartToken: identity.startToken,
        createdAt: new Date().toISOString(),
      };
      const receipt: BatchLaunchReceipt = {
        ...unsignedReceipt,
        receiptDigest: canonicalDigest(unsignedReceipt),
      };
      await input.hooks?.registerProcess?.(identity, receipt);
      await input.hooks?.markGateReleased?.(identity);
      await input.hooks?.markProcessStarted?.(identity);
      await obeyControl(control, input.signal);

      const failed = input.signal.aborted;
      const output: BatchOutputCandidate = {
        sampleIndex: sample.sampleIndex,
        sampleId: sample.sampleId,
        logicalName: "result",
        relativePath: "outputs/result.json",
        mediaType: "application/json",
        role: "data",
        sourcePath: `/private/fake/${input.run.runId}/outputs/result.json`,
        scratchPath: `/private/fake/${plan.scratchId}`,
        sizeBytes: 2,
        sha256: canonicalDigest({}),
        owner: 501,
        device: 43,
        inode: 4_000 + sequence,
      };
      return {
        runId: input.run.runId,
        status: failed ? "failed" : "succeeded",
        code: failed ? "dispatcher_shutdown" : "batch_run_succeeded",
        diagnostic: failed ? "The batch dispatcher shut down." : "Batch run succeeded.",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        samples: [{
          sampleIndex: sample.sampleIndex,
          sampleId: sample.sampleId,
          status: failed ? "failed" : "succeeded",
          code: failed ? "dispatcher_shutdown" : "batch_run_succeeded",
          diagnostic: failed ? "The batch dispatcher shut down." : "Batch run succeeded.",
          identity,
          exitCode: failed ? null : 0,
          signal: failed ? "SIGTERM" : null,
          durationMs: 1,
          stdout: "",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          scratchId: plan.scratchId,
          scratchPath: `/private/fake/${plan.scratchId}`,
          outputs: failed ? [] : [output],
        }],
        outputs: failed ? [] : [output],
        resources: {
          maxConcurrencyObserved: 1,
          stdoutBytes: 0,
          stderrBytes: 0,
          outputFiles: failed ? 0 : 1,
          outputBytes: failed ? 0 : 2,
        },
      };
    },
    cleanup(result: BatchSupervisionResult): BatchScratchCleanupReceipt {
      cleanupCalls.push(result.runId);
      const unsigned = {
        schemaVersion: 1 as const,
        runId: result.runId,
        scratchIds: result.samples.map((sample) => sample.scratchId),
        cleanedAt: new Date().toISOString(),
        verified: true as const,
      };
      return { ...unsigned, receiptDigest: canonicalDigest(unsigned) };
    },
  };
  return { supervisor, calls, cleanupCalls, signals };
};

type Fixture = {
  parent: string;
  store: ProductStoreV2;
  visualProjectId: string;
  batchProjectId: string;
  createVisualRun(name: string, createdAt: string): string;
  createBatchRun(name: string, createdAt: string): string;
  close(): void;
};

const createFixture = (suffix: string): Fixture => {
  const parent = mkdtempSync(join(tmpdir(), `riff-visual-dispatcher-${suffix}-`));
  const store = ProductStoreV2.openForTesting(join(parent, "store"), {});
  const visualModelId = `model_visual_${suffix}`;
  const batchModelId = `model_batch_${suffix}`;
  const visualProjectId = `project_visual_${suffix}`;
  const batchProjectId = `project_batch_${suffix}`;
  const visualExperimentId = `experiment_visual_${suffix}`;
  const batchExperimentId = `experiment_batch_${suffix}`;
  const createdAt = "2026-07-25T18:00:00.000Z";
  for (const model of [
    {
      id: visualModelId,
      name: "Visual dispatcher fixture",
      runMode: "visual" as const,
      executionDescription: VISUAL_EXECUTION,
    },
    {
      id: batchModelId,
      name: "Batch dispatcher fixture",
      runMode: "batch" as const,
      executionDescription: BATCH_EXECUTION,
    },
  ]) {
    store.createModel({
      ...model,
      technicalStatus: "executable",
      createdAt,
      files: [
        {
          id: `file_code_${model.id}`,
          kind: "model_code",
          relativePath: "model.py",
          mediaType: "text/x-python",
          bytes: Buffer.from("raise SystemExit(0)\n"),
        },
        {
          id: `file_environment_${model.id}`,
          kind: "model_environment",
          relativePath: "requirements.txt",
          mediaType: "text/plain",
          bytes: Buffer.from(""),
        },
      ],
    });
  }
  const visualProject = store.createProjectFromModel({
    projectId: visualProjectId,
    projectName: "Visual dispatcher fixture",
    sourceModelId: visualModelId,
    createdAt,
  });
  const batchProject = store.createProjectFromModel({
    projectId: batchProjectId,
    projectName: "Batch dispatcher fixture",
    sourceModelId: batchModelId,
    createdAt,
  });
  const visualPlan = planExperiment({
    configuration: {
      schemaVersion: 1,
      runKind: "visual",
      parameters: { value: 1 },
      sampling: { kind: "single" },
    },
    inputSchema: INPUT_SCHEMA,
    maxSamples: 1,
  });
  const batchPlan = planExperiment({
    configuration: {
      schemaVersion: 1,
      runKind: "batch",
      parameters: { value: 1 },
      sampling: { kind: "single" },
    },
    inputSchema: INPUT_SCHEMA,
    maxSamples: LIMITS.maxSamples,
  });
  store.createExperimentV4({
    commandId: `command_visual_experiment_${suffix}`,
    id: visualExperimentId,
    projectId: visualProjectId,
    name: "Visual dispatcher fixture",
    plan: visualPlan,
    createdAt,
  });
  store.createExperimentV4({
    commandId: `command_batch_experiment_${suffix}`,
    id: batchExperimentId,
    projectId: batchProjectId,
    name: "Batch dispatcher fixture",
    plan: batchPlan,
    createdAt,
  });

  const createRun = (
    kind: "visual" | "batch",
    name: string,
    runCreatedAt: string,
  ): string => {
    const runId = `run_${suffix}_${name}`;
    const project = kind === "visual" ? visualProject : batchProject;
    const plan = kind === "visual" ? visualPlan : batchPlan;
    const experimentConfigId = kind === "visual" ? visualExperimentId : batchExperimentId;
    store.createFrozenRun({
      commandId: `command_${suffix}_${name}`,
      runId,
      projectId: project.id,
      experimentConfigId,
      completionConversationId: null,
      expectedConfigurationDigest: plan.configurationDigest,
      plan,
      projectSnapshotDigest: project.modelSnapshotDigest,
      executionDescriptionDigest: canonicalDigest(project.executionDescription),
      limits: LIMITS,
      createdAt: runCreatedAt,
    });
    return runId;
  };
  return {
    parent,
    store,
    visualProjectId,
    batchProjectId,
    createVisualRun: (name, runCreatedAt) => createRun("visual", name, runCreatedAt),
    createBatchRun: (name, runCreatedAt) => createRun("batch", name, runCreatedAt),
    close() {
      store.close();
      rmSync(parent, { recursive: true, force: true });
    },
  };
};

const waitForRun = async (
  store: ProductStoreV2,
  projectId: string,
  runId: string,
  status: "running" | "succeeded" | "failed" | "cancelled",
): Promise<ReturnType<ProductStoreV2["getRun"]>> => {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const run = store.getRun(projectId, runId);
    if (run.status === status) return run;
    if (["succeeded", "failed", "timed_out", "cancelled"].includes(run.status)) {
      assert.fail(`Run ${runId} reached ${run.status}, expected ${status}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for ${runId} to reach ${status}.`);
};

const waitUntil = async (predicate: () => boolean, message: string): Promise<void> => {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
};

const activeProcessAttemptId = (store: ProductStoreV2, runId: string): string => {
  const unit = store.listPriorDispatcherRecoveryUnits().find((candidate) => candidate.run.id === runId);
  assert.ok(unit, `missing active recovery unit for ${runId}`);
  assert.equal(unit.processes.length, 1);
  return unit.processes[0]!.processAttemptId;
};

const expectedBatchProcessAttemptId = (runId: string): string =>
  `process_${canonicalDigest({ runId, attemptGeneration: 1, sampleIndex: 0 }).slice(0, 32)}`;

const assertNoCompletionEvidence = (fixture: Fixture, runId: string): void => {
  const database = new DatabaseSync(join(fixture.store.root, "product.sqlite3"), {
    open: true,
    readOnly: true,
  });
  try {
    assert.equal(Number((database.prepare(
      "SELECT count(*) AS count FROM run_completion_cards WHERE run_id = ?",
    ).get(runId) as { count: number }).count), 0);
    assert.equal(Number((database.prepare(`SELECT count(*) AS count FROM messages
      WHERE message_kind = 'platform_card' AND json_valid(content_json)
        AND json_extract(content_json, '$.runId') = ?`
    ).get(runId) as { count: number }).count), 0);
  } finally {
    database.close();
  }
};

test("one visual slot preserves batch progress and releases the next visual only after exact cleanup and terminal commit", {
  timeout: 15_000,
}, async () => {
  const fixture = createFixture("fairness");
  let dispatcher: ProductRunDispatcher | undefined;
  const firstVisual = fixture.createVisualRun("visual_first", "2026-07-25T18:01:00.000Z");
  const secondVisual = fixture.createVisualRun("visual_second", "2026-07-25T18:01:01.000Z");
  const batchRun = fixture.createBatchRun("batch", "2026-07-25T18:01:02.000Z");
  const firstControl = laneControl("release-or-abort");
  const firstCleanupObserved: string[] = [];
  const secondControl = laneControl("none", () => {
    assert.deepEqual(firstCleanupObserved, [firstVisual]);
    assert.equal(fixture.store.getRun(fixture.visualProjectId, firstVisual).status, "succeeded");
  });
  const batchControl = laneControl("none");
  const visual = visualHarness(new Map([
    [firstVisual, firstControl],
    [secondVisual, secondControl],
  ]));
  const originalVisualCleanup = visual.supervisor.cleanup.bind(visual.supervisor);
  visual.supervisor.cleanup = (result) => {
    const receipt = originalVisualCleanup(result);
    if (result.runId === firstVisual) firstCleanupObserved.push(result.runId);
    return receipt;
  };
  const batch = batchHarness(new Map([[batchRun, batchControl]]));
  try {
    dispatcher = new ProductRunDispatcher({
      store: fixture.store,
      supervisor: batch.supervisor,
      visualSupervisor: visual.supervisor,
      leaseMs: 1_000,
      consumeOutput: () => Buffer.from("{}"),
      consumeVisualOutput: () => Buffer.from("{}"),
    });
    await dispatcher.start();
    await Promise.all([firstControl.entered.promise, batchControl.entered.promise]);
    await waitForRun(fixture.store, fixture.batchProjectId, batchRun, "succeeded");

    assert.equal(fixture.store.getRun(fixture.visualProjectId, firstVisual).status, "running");
    assert.equal(fixture.store.getRun(fixture.visualProjectId, secondVisual).status, "queued");
    assert.deepEqual(visual.calls, [firstVisual]);
    assert.deepEqual(batch.calls, [batchRun]);
    assert.equal(
      activeProcessAttemptId(fixture.store, firstVisual),
      visual.processAttemptIds.get(firstVisual),
    );
    assert.equal(fixture.store.listRunAttempts(secondVisual).length, 0);
    assert.equal(fixture.store.listRunOutputs(batchRun).length, 1);

    firstControl.release.resolve();
    await waitForRun(fixture.store, fixture.visualProjectId, firstVisual, "succeeded");
    await secondControl.entered.promise;
    await waitForRun(fixture.store, fixture.visualProjectId, secondVisual, "succeeded");

    assert.deepEqual(visual.calls, [firstVisual, secondVisual]);
    assert.deepEqual(visual.cleanupCalls, [firstVisual, secondVisual]);
    assert.equal(fixture.store.listRunAttempts(firstVisual).length, 1);
    assert.equal(fixture.store.listRunAttempts(secondVisual).length, 1);
    assert.equal(fixture.store.listRunOutputs(firstVisual).length, 1);
    assert.equal(fixture.store.listRunOutputs(secondVisual).length, 1);
    assert.equal(
      fixture.store.getRun(fixture.visualProjectId, firstVisual).completionCardDisposition,
      "not_requested",
    );
    assert.equal(dispatcher.lastError, null);
  } finally {
    firstControl.release.resolve();
    secondControl.release.resolve();
    batchControl.release.resolve();
    await dispatcher?.stop();
    fixture.close();
  }
});

test("active visual cancellation aborts only its exact lane and cancellation wins without output or card", {
  timeout: 15_000,
}, async () => {
  const fixture = createFixture("cancel");
  let dispatcher: ProductRunDispatcher | undefined;
  const visualRun = fixture.createVisualRun("visual", "2026-07-25T18:02:00.000Z");
  const batchRun = fixture.createBatchRun("batch", "2026-07-25T18:02:00.000Z");
  const visualControl = laneControl("abort");
  const batchControl = laneControl("release-or-abort");
  const visual = visualHarness(new Map([[visualRun, visualControl]]));
  const batch = batchHarness(new Map([[batchRun, batchControl]]));
  try {
    dispatcher = new ProductRunDispatcher({
      store: fixture.store,
      supervisor: batch.supervisor,
      visualSupervisor: visual.supervisor,
      leaseMs: 1_000,
      consumeOutput: () => Buffer.from("{}"),
      consumeVisualOutput: () => Buffer.from("{}"),
    });
    await dispatcher.start();
    await Promise.all([visualControl.entered.promise, batchControl.entered.promise]);
    assert.equal(
      activeProcessAttemptId(fixture.store, visualRun),
      visual.processAttemptIds.get(visualRun),
    );

    const cancellation = fixture.store.cancelRun({
      commandId: "command_cancel_active_visual",
      projectId: fixture.visualProjectId,
      runId: visualRun,
      requestedAt: new Date().toISOString(),
    });
    assert.equal(cancellation.code, "cancellation_requested");
    dispatcher.requestCancellation(visualRun);
    const terminal = await waitForRun(
      fixture.store,
      fixture.visualProjectId,
      visualRun,
      "cancelled",
    );

    assert.equal(visual.signals.get(visualRun)?.aborted, true);
    assert.equal(batch.signals.get(batchRun)?.aborted, false);
    assert.equal(fixture.store.getRun(fixture.batchProjectId, batchRun).status, "running");
    assert.equal(terminal.terminalCode, "run_cancelled");
    assert.equal(terminal.completionCardDisposition, "not_requested");
    assert.equal(fixture.store.listRunAttempts(visualRun)[0]!.state, "cancelled");
    assert.deepEqual(fixture.store.listRunOutputs(visualRun), []);
    assert.deepEqual(visual.calls, [visualRun]);
    assertNoCompletionEvidence(fixture, visualRun);

    batchControl.release.resolve();
    await waitForRun(fixture.store, fixture.batchProjectId, batchRun, "succeeded");
    assert.deepEqual(batch.calls, [batchRun]);
    assert.equal(dispatcher.lastError, null);
  } finally {
    visualControl.release.resolve();
    batchControl.release.resolve();
    await dispatcher?.stop();
    fixture.close();
  }
});

test("dispatcher stop aborts and joins active batch and visual lanes before returning", {
  timeout: 15_000,
}, async () => {
  const fixture = createFixture("stop");
  let dispatcher: ProductRunDispatcher | undefined;
  const visualRun = fixture.createVisualRun("visual", "2026-07-25T18:03:00.000Z");
  const batchRun = fixture.createBatchRun("batch", "2026-07-25T18:03:00.000Z");
  const visualControl = laneControl("abort-then-release");
  const batchControl = laneControl("abort-then-release");
  const visual = visualHarness(new Map([[visualRun, visualControl]]));
  const batch = batchHarness(new Map([[batchRun, batchControl]]));
  try {
    dispatcher = new ProductRunDispatcher({
      store: fixture.store,
      supervisor: batch.supervisor,
      visualSupervisor: visual.supervisor,
      leaseMs: 1_000,
      consumeOutput: () => Buffer.from("{}"),
      consumeVisualOutput: () => Buffer.from("{}"),
    });
    await dispatcher.start();
    await Promise.all([visualControl.entered.promise, batchControl.entered.promise]);
    assert.equal(
      activeProcessAttemptId(fixture.store, visualRun),
      visual.processAttemptIds.get(visualRun),
    );
    assert.equal(activeProcessAttemptId(fixture.store, batchRun), expectedBatchProcessAttemptId(batchRun));

    let stopSettled = false;
    const stopPromise = dispatcher.stop().then(() => { stopSettled = true; });
    await waitUntil(
      () => visual.signals.get(visualRun)?.aborted === true
        && batch.signals.get(batchRun)?.aborted === true,
      "stop did not abort both active lanes",
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(stopSettled, false);

    visualControl.release.resolve();
    const visualTerminal = await waitForRun(
      fixture.store,
      fixture.visualProjectId,
      visualRun,
      "failed",
    );
    assert.equal(visualTerminal.terminalCode, "dispatcher_shutdown");
    assert.equal(stopSettled, false);

    batchControl.release.resolve();
    await stopPromise;
    const batchTerminal = fixture.store.getRun(fixture.batchProjectId, batchRun);
    assert.equal(batchTerminal.status, "failed");
    assert.equal(batchTerminal.terminalCode, "dispatcher_shutdown");
    assert.deepEqual(visual.cleanupCalls, [visualRun]);
    assert.deepEqual(batch.cleanupCalls, [batchRun]);
    assert.deepEqual(visual.calls, [visualRun]);
    assert.deepEqual(batch.calls, [batchRun]);
    assert.equal(fixture.store.listRunAttempts(visualRun)[0]!.state, "failed");
    assert.equal(fixture.store.listRunAttempts(batchRun)[0]!.state, "failed");
    assert.deepEqual(fixture.store.listRunOutputs(visualRun), []);
    assert.deepEqual(fixture.store.listRunOutputs(batchRun), []);
    assert.equal(dispatcher.lastError, null);
  } finally {
    visualControl.release.resolve();
    batchControl.release.resolve();
    await dispatcher?.stop();
    fixture.close();
  }
});

test("spawned visual identity with rejected Store registration remains recovery-required", {
  timeout: 15_000,
}, async () => {
  const fixture = createFixture("register_rejected");
  let dispatcher: ProductRunDispatcher | undefined;
  const visualRun = fixture.createVisualRun(
    "visual",
    "2026-07-25T18:04:00.000Z",
  );
  let spawnedIdentity: {
    processAttemptId: string;
    runId: string;
    scratchId: string;
  } | null = null;
  let cleanupCalls = 0;
  const visualSupervisor: VisualSupervisorPort = {
    async supervise(input): Promise<VisualSupervisionResult> {
      const plan = {
        processKind: "visual" as const,
        runId: input.run.runId,
        sampleIndex: 0 as const,
        sampleId: input.run.sample.sampleId,
        scratchId: `scratch_${input.run.runId}`,
        relativePath: `visual-${input.run.runId}`,
        loopbackPort: 42_399,
        healthPath: "/healthz",
      };
      const binding = await input.hooks?.planScratch?.(plan);
      assert.ok(binding);
      await input.hooks?.registerScratchDirectory?.({
        ...plan,
        ownerUid: 501,
        device: 42,
        inode: 9_999,
      });
      const identity = {
        processKind: "visual" as const,
        processAttemptId: `process_${input.run.runId}_spawned`,
        runId: input.run.runId,
        sampleIndex: 0 as const,
        sampleId: input.run.sample.sampleId,
        scratchId: plan.scratchId,
        pid: 9_999,
        processGroupId: 9_999,
        processStartToken: "spawned-before-registration",
        loopbackPort: plan.loopbackPort,
        healthPath: plan.healthPath,
      };
      spawnedIdentity = identity;
      const unsignedReceipt = {
        schemaVersion: 1 as const,
        manifestId: binding.manifestId,
        manifestDigest: binding.manifestDigest,
        runId: identity.runId,
        sampleIndex: identity.sampleIndex,
        sampleId: identity.sampleId,
        scratchId: identity.scratchId,
        relativePath: plan.relativePath,
        pid: identity.pid,
        processGroupId: identity.processGroupId,
        processStartToken: identity.processStartToken,
        loopbackHost: "127.0.0.1" as const,
        loopbackPort: identity.loopbackPort,
        healthPath: identity.healthPath,
        createdAt: new Date().toISOString(),
      };
      const receipt: VisualLaunchReceipt = {
        ...unsignedReceipt,
        receiptDigest: canonicalDigest(unsignedReceipt),
      };
      await assert.rejects(
        () => input.hooks!.registerProcess!(identity, receipt),
        /injected visual registration rejection/u,
      );
      return {
        runId: input.run.runId,
        status: "failed",
        code: "visual_process_failed",
        diagnostic: "The spawned visual process was terminated after registration failed.",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        identity: {
          processKind: identity.processKind,
          processAttemptId: identity.processAttemptId,
          runId: identity.runId,
          sampleIndex: identity.sampleIndex,
          sampleId: identity.sampleId,
          scratchId: identity.scratchId,
          pid: identity.pid,
          processGroupId: identity.processGroupId,
          processStartToken: identity.processStartToken,
        },
        exitCode: null,
        signal: "SIGTERM",
        stdoutBytes: 0,
        stderrBytes: 0,
        stdoutTruncated: false,
        stderrTruncated: false,
        scratchId: identity.scratchId,
        scratchPath: `/private/fake/${identity.scratchId}`,
        outputs: [],
        healthVerified: false,
      };
    },
    cleanup(): VisualScratchCleanupReceipt {
      cleanupCalls += 1;
      throw new Error("dispatcher must not treat an uncommitted process as registered cleanup");
    },
  };
  const storePort = new Proxy(fixture.store, {
    get(target, property, receiver) {
      if (property === "registerVisualProcessAttempt") {
        return () => {
          throw new Error("injected visual registration rejection");
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const batchSupervisor: BatchSupervisorPort = {
    async supervise(): Promise<BatchSupervisionResult> {
      throw new Error("no batch run should be supervised");
    },
    cleanup(): BatchScratchCleanupReceipt {
      throw new Error("no batch scratch should be cleaned");
    },
  };
  try {
    dispatcher = new ProductRunDispatcher({
      store: storePort,
      supervisor: batchSupervisor,
      visualSupervisor,
      leaseMs: 1_000,
    });
    await dispatcher.start();
    await waitUntil(
      () => dispatcher?.lastError !== null,
      "dispatcher did not surface rejected visual registration",
    );

    assert.ok(spawnedIdentity);
    assert.match(dispatcher.lastError?.message ?? "", /dispatcher_recovery_required/u);
    const run = fixture.store.getRun(fixture.visualProjectId, visualRun);
    assert.equal(run.status, "running");
    assert.equal(run.terminalCode, null);
    assert.equal(fixture.store.listRunAttempts(visualRun)[0]!.state, "running");
    assert.deepEqual(fixture.store.listRunOutputs(visualRun), []);
    assert.equal(cleanupCalls, 0);

    const unit = fixture.store.listPriorDispatcherRecoveryUnits()
      .find((candidate) => candidate.run.id === visualRun);
    assert.ok(unit);
    assert.equal(unit.processes.length, 0);
    assert.equal(unit.pendingLaunches.length, 1);
    assert.equal(unit.pendingLaunches[0]!.processKind, "visual");
    assert.equal(unit.pendingLaunches[0]!.scratchLease.state, "created");
    assert.equal(
      unit.pendingLaunches[0]!.scratchLease.id,
      spawnedIdentity.scratchId,
    );
    assert.match(unit.pendingLaunches[0]!.launchManifest.manifestDigest, /^[0-9a-f]{64}$/u);
  } finally {
    await dispatcher?.stop();
    fixture.close();
  }
});
