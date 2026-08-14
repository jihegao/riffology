import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { PROJECT_ONLY_BATCH_ENTRY_SOURCE } from "../src/project-only-runtime-assets.ts";
import { ProjectOnlyBatchRuntime } from "../src/project-only-batch-runtime.ts";
import { ProjectOnlyOperationsAdapter } from "../src/project-only-operations.ts";
import { ProjectOnlyStore } from "../src/project-only-store.ts";

const NOW = "2026-08-05T08:00:00.000Z";
const LATER = "2026-08-05T08:01:00.000Z";
const execution = {
  schemaVersion: 2,
  runtime: "python",
  runMode: "batch",
  dependencyFile: "environment/requirements.txt",
  inputs: {
    schemaProfile: "riff-json-schema-2020-12-v1",
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        steps: { type: "integer", minimum: 1, maximum: 1000 },
        demand: { type: "number", minimum: 0, maximum: 100 },
      },
      required: ["steps", "demand"],
      additionalProperties: false,
    },
    smoke: { steps: 2, demand: 1 },
  },
  outputs: [{ logicalName: "summary", relativePath: "summary.json", mediaType: "application/json", required: true, role: "metric" }],
  batch: { entryPoint: "code/riff_entry.py", protocol: "riff-batch-v1" },
  cancellation: { signal: "SIGTERM", graceMs: 500 },
};

test("Project-only batch runtime executes a frozen multi-seed Mesa plan and publishes durable outputs", async (t) => {
  // Production keeps its scratch root below the application-owned repository
  // data directory, so exercise the same /Users path and sandbox exclusions.
  const root = mkdtempSync(resolve(import.meta.dirname, "../../.riff-project-batch-runtime-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = ProjectOnlyStore.open(join(root, ".riff-product"));
  t.after(() => store.close());
  const project = store.createProject({
    id: "project_batch_runtime",
    name: "Batch runtime",
    source: {
      kind: "import",
      importDigest: "a".repeat(64),
      files: [
        {
          id: "batch_entry",
          kind: "project_code",
          relativePath: "code/riff_entry.py",
          mediaType: "text/x-python",
          bytes: Buffer.from(PROJECT_ONLY_BATCH_ENTRY_SOURCE),
        },
        {
          id: "batch_model",
          kind: "project_code",
          relativePath: "code/model.py",
          mediaType: "text/x-python",
          bytes: Buffer.from(`from mesa import Model\n\nclass SimulationModel(Model):\n    def __init__(self, demand=1, seed=None):\n        super().__init__(seed=seed)\n        self.demand = demand\n        self.value = 0.0\n    def step(self):\n        self.value += self.random.random() * self.demand\n    def snapshot(self):\n        return {"value": self.value, "demand": self.demand}\n`),
        },
        {
          id: "batch_requirements",
          kind: "project_environment",
          relativePath: "environment/requirements.txt",
          mediaType: "text/plain",
          bytes: Buffer.from("mesa>=3,<4\n"),
        },
      ],
    },
    runMode: "batch",
    executionDescription: execution,
    createdAt: NOW,
  });
  store.createExperiment({
    id: "batch_experiment",
    projectId: project.id,
    name: "Three seeds",
    configuration: {
      schemaVersion: 1,
      runKind: "batch",
      parameters: { steps: 4, demand: 2 },
      sampling: { kind: "multiple-seeds", seeds: [1, 2, 3] },
    },
    createdAt: NOW,
  });
  const operations = new ProjectOnlyOperationsAdapter(store, () => NOW);
  const admitted = operations.startRunAdmission({
    commandId: "batch_runtime_run",
    projectId: project.id,
    experimentConfigurationId: "batch_experiment",
    runKind: "batch",
    expectedWorkspaceDigest: project.workspaceDigest,
  });
  const runtime = new ProjectOnlyBatchRuntime({
    store,
    pythonExecutable: resolve(import.meta.dirname, "../../mesa_service/.venv/bin/python"),
    scratchRoot: join(root, "scratch"),
  });
  t.after(() => runtime.close());
  runtime.start({ projectId: project.id, runId: admitted.runId });
  await runtime.wait(admitted.runId);

  const run = store.run(admitted.runId);
  assert.equal(
    run.status,
    "succeeded",
    JSON.stringify(store.runCompletion(run.id)?.completion) ?? run.terminalCode ?? "missing terminal code",
  );
  const outputs = store.runOutputs(run.id);
  assert.equal(outputs.length, 3);
  assert.deepEqual(outputs.map((output) => output.declaredRole), ["metric", "metric", "metric"]);
  assert.deepEqual(outputs.map((output) => JSON.parse(output.bytes.toString("utf8")).seed), [1, 2, 3]);
  assert.equal(store.runCompletion(run.id)?.completion.sampleCount, 3);
  assert.equal(store.project(project.id).executionLock, null);
});

test("batch runtime distinguishes explicit cancellation from backend shutdown across reopen", async (t) => {
  const root = mkdtempSync(resolve(import.meta.dirname, "../../.riff-project-batch-shutdown-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const storeRoot = join(root, ".riff-product");
  const store = ProjectOnlyStore.open(storeRoot);
  t.after(() => store.close());
  const project = store.createProject({
    id: "project_batch_shutdown",
    name: "Batch shutdown",
    source: {
      kind: "import",
      importDigest: "b".repeat(64),
      files: [{
        id: "batch_shutdown_entry",
        kind: "project_code",
        relativePath: "code/riff_entry.py",
        mediaType: "text/x-python",
        bytes: Buffer.from(PROJECT_ONLY_BATCH_ENTRY_SOURCE),
      }, {
        id: "batch_shutdown_requirements",
        kind: "project_environment",
        relativePath: "environment/requirements.txt",
        mediaType: "text/plain",
        bytes: Buffer.from("mesa>=3,<4\n"),
      }],
    },
    runMode: "batch",
    executionDescription: execution,
    createdAt: NOW,
  });
  store.createExperiment({
    id: "batch_shutdown_experiment",
    projectId: project.id,
    name: "Two seeds",
    configuration: {
      schemaVersion: 1,
      runKind: "batch",
      parameters: { steps: 4, demand: 2 },
      sampling: { kind: "multiple-seeds", seeds: [1, 2] },
    },
    createdAt: NOW,
  });

  let invocationCount = 0;
  const enteredResolvers: Array<() => void> = [];
  const entered = [0, 1].map(() => new Promise<void>((resolveEntered) => {
    enteredResolvers.push(resolveEntered);
  }));
  const supervisor = {
    supervise: async (input: any) => {
      const invocation = invocationCount++;
      enteredResolvers[invocation]!();
      const signal = input.signal as AbortSignal;
      if (!signal.aborted) {
        await new Promise<void>((resolveAborted) =>
          signal.addEventListener("abort", () => resolveAborted(), { once: true }));
      }
      return Object.freeze({
        runId: input.run.runId,
        status: "failed",
        code: "supervisor_aborted",
        diagnostic: "Supervisor was aborted.",
        startedAt: NOW,
        finishedAt: LATER,
        samples: Object.freeze(input.run.samples.map((sample: any) => Object.freeze({
          sampleIndex: sample.sampleIndex,
          sampleId: sample.sampleId,
          status: "not_started",
          code: "supervisor_aborted",
          diagnostic: "Supervisor was aborted.",
          identity: null,
          exitCode: null,
          signal: null,
          durationMs: 0,
          stdout: "",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          scratchId: `scratch_${sample.sampleIndex}`,
          scratchPath: join(root, `scratch_${sample.sampleIndex}`),
          outputs: Object.freeze([]),
        }))),
        outputs: Object.freeze([]),
        resources: Object.freeze({
          maxConcurrencyObserved: 0,
          stdoutBytes: 0,
          stderrBytes: 0,
          outputFiles: 0,
          outputBytes: 0,
        }),
      });
    },
    cleanup: () => undefined,
  };
  const runtime = new ProjectOnlyBatchRuntime({
    store,
    pythonExecutable: resolve(import.meta.dirname, "../../mesa_service/.venv/bin/python"),
    scratchRoot: join(root, "scratch"),
    supervisor: supervisor as any,
  });
  t.after(() => runtime.close());
  const operations = new ProjectOnlyOperationsAdapter(store, () => NOW);

  const cancelled = operations.startRunAdmission({
    commandId: "batch_user_cancel",
    projectId: project.id,
    experimentConfigurationId: "batch_shutdown_experiment",
    runKind: "batch",
    expectedWorkspaceDigest: project.workspaceDigest,
  });
  runtime.start({ projectId: project.id, runId: cancelled.runId });
  await entered[0];
  await runtime.cancel(project.id, cancelled.runId);
  assert.equal(store.run(cancelled.runId).status, "cancelled");
  assert.equal(store.run(cancelled.runId).terminalCode, "user_cancelled");
  assert.equal(store.runCompletion(cancelled.runId)?.completion.status, "cancelled");
  assert.equal(store.runCompletion(cancelled.runId)?.completion.code, "user_cancelled");

  const interrupted = operations.startRunAdmission({
    commandId: "batch_backend_shutdown",
    projectId: project.id,
    experimentConfigurationId: "batch_shutdown_experiment",
    runKind: "batch",
    expectedWorkspaceDigest: project.workspaceDigest,
  });
  runtime.start({ projectId: project.id, runId: interrupted.runId });
  await entered[1];
  await runtime.close();

  const interruptedRun = store.run(interrupted.runId);
  const completion = store.runCompletion(interrupted.runId);
  assert.equal(interruptedRun.status, "interrupted");
  assert.equal(interruptedRun.terminalCode, "backend_shutdown");
  assert.equal(completion?.completion.status, "interrupted");
  assert.equal(completion?.completion.code, "backend_shutdown");
  assert.equal(completion?.completion.sampleCount, 2);
  assert.match(String(completion?.completion.samplePlanDigest), /^[0-9a-f]{64}$/u);
  assert.match(String(completion?.completion.configurationDigest), /^[0-9a-f]{64}$/u);
  assert.match(completion?.digest ?? "", /^[0-9a-f]{64}$/u);
  assert.equal(store.project(project.id).executionLock, null);

  const completionDigest = completion!.digest;
  store.close();
  const reopened = ProjectOnlyStore.open(storeRoot);
  t.after(() => reopened.close());
  assert.deepEqual(reopened.reconcileInterruptedExecutions(LATER), { runs: 0 });
  assert.equal(reopened.run(interrupted.runId).status, "interrupted");
  assert.equal(reopened.runCompletion(interrupted.runId)?.digest, completionDigest);
  assert.equal(reopened.project(project.id).executionLock, null);
});
