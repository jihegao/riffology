import assert from "node:assert/strict";
import test from "node:test";
import {
  INPUT_SCHEMA_PROFILE,
  ExecutionProtocolV2Error,
  assertRunCapabilityV2,
  batchProcessArguments,
  createBatchInputV1,
  resolveBatchOutputPathsV1,
  validateBatchInputV1,
  validateExecutionDescriptionV2,
} from "../src/execution-protocol-v2.ts";
import { planExperiment } from "../src/experiment-planner.ts";
import { createGenericModelScaffold } from "../src/model-workspace.ts";

const validDescription = () => structuredClone(
  createGenericModelScaffold("model_execution_protocol").executionDescription,
);

test("execution-description v2 is strict, canonical, and deeply frozen", () => {
  const validated = validateExecutionDescriptionV2(validDescription());
  assert.equal(validated.schemaVersion, 2);
  assert.equal(validated.inputs.schemaProfile, INPUT_SCHEMA_PROFILE);
  assert.equal(validated.batch?.protocol, "riff-batch-v1");
  assert.equal(validated.outputs[0]?.role, "data");
  assert.equal(Object.isFrozen(validated), true);
  assert.equal(Object.isFrozen(validated.inputs), true);
  assert.equal(Object.isFrozen(validated.inputs.schema), true);
  assert.equal(Object.isFrozen(validated.outputs), true);

  const invalidCases = [
    { ...validDescription(), schemaVersion: 1 },
    { ...validDescription(), unexpected: true },
    { ...validDescription(), inputs: { ...validDescription().inputs, schemaProfile: "unknown" } },
    { ...validDescription(), batch: { ...validDescription().batch, protocol: "python-cli" } },
    { ...validDescription(), outputs: [{ ...validDescription().outputs[0], role: undefined }] },
    { ...validDescription(), cancellation: { signal: "SIGKILL", graceMs: 1 } },
    { ...validDescription(), runMode: "visual" },
  ];
  for (const value of invalidCases) {
    assert.throws(() => validateExecutionDescriptionV2(value), (error: unknown) =>
      error instanceof ExecutionProtocolV2Error && error.code === "execution_protocol_upgrade_required");
  }
});

test("run capability, batch envelope, CLI arguments, and output paths share one frozen contract", () => {
  const description = validateExecutionDescriptionV2(validDescription());
  assert.doesNotThrow(() => assertRunCapabilityV2(description, "batch"));
  assert.throws(() => assertRunCapabilityV2(description, "visual"), (error: unknown) =>
    error instanceof ExecutionProtocolV2Error && error.code === "capability_not_declared");

  const parameters = { stepLimit: 3, demand: 4.5 };
  const input = createBatchInputV1({
    runId: "run_protocol",
    sampleIndex: 0,
    parameters,
    seed: 37,
  });
  const planned = planExperiment({
    configuration: {
      schemaVersion: 1,
      runKind: "batch",
      parameters,
      sampling: { kind: "single", seed: 37 },
    },
    inputSchema: description.inputs.schema,
    maxSamples: 1,
  });
  assert.equal(input.sampleId, planned.samples[0]?.sampleId);
  assert.deepEqual(validateBatchInputV1(structuredClone(input)), input);
  assert.equal(Object.isFrozen(input), true);
  assert.equal(Object.isFrozen(input.parameters), true);
  assert.throws(() => validateBatchInputV1({ ...input, sampleId: "a".repeat(64) }), (error: unknown) =>
    error instanceof ExecutionProtocolV2Error && error.code === "invalid_batch_input");
  assert.throws(() => validateBatchInputV1({ ...input, seed: undefined }), (error: unknown) =>
    error instanceof ExecutionProtocolV2Error && error.code === "invalid_batch_input");
  const { sampleId: _sampleId, ...missingSampleId } = input;
  assert.throws(() => validateBatchInputV1(missingSampleId), (error: unknown) =>
    error instanceof ExecutionProtocolV2Error && error.code === "invalid_batch_input");

  assert.deepEqual(batchProcessArguments(description, "/private/tmp/run/input.json", "/private/tmp/run/output"), [
    "code/riff_entry.py",
    "--riff-input",
    "/private/tmp/run/input.json",
    "--riff-output-dir",
    "/private/tmp/run/output",
  ]);
  assert.deepEqual(resolveBatchOutputPathsV1(description, "/private/tmp/run/output"), [{
    logicalName: "summary",
    relativePath: "summary.json",
    mediaType: "application/json",
    required: true,
    role: "data",
    absolutePath: "/private/tmp/run/output/summary.json",
  }]);
  assert.throws(() => batchProcessArguments(description, "relative-input.json", "/private/tmp/run/output"),
    /application-owned absolute path/u);
});
