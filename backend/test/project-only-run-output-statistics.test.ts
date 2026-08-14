import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { ApiError } from "../src/errors.ts";
import { summarizeJsonOutputSeries } from "../src/project-only-agent-service.ts";
import type {
  ProjectRunOutputRecord,
  ProjectRunRecord,
} from "../src/project-only-store.ts";

const RUN: ProjectRunRecord = Object.freeze({
  id: "run_statistics",
  projectId: "project_statistics",
  experimentConfigurationId: "experiment_statistics",
  runKind: "batch",
  status: "succeeded",
  sourceWorkspaceDigest: "4".repeat(64),
  frozenConfiguration: {},
  sourceFilesRetained: false,
  createdAt: "2026-08-13T08:00:00.000Z",
  updatedAt: "2026-08-13T08:00:01.000Z",
  startedAt: "2026-08-13T08:00:00.000Z",
  finishedAt: "2026-08-13T08:00:01.000Z",
  terminalCode: "batch_run_succeeded",
});

const provenance = (sampleCount: number) => Object.freeze({
  completionDigest: "1".repeat(64),
  sampleCount,
  samplePlanDigest: "2".repeat(64),
  configurationDigest: "3".repeat(64),
});

const output = (
  sampleIndex: number,
  document: unknown,
  overrides: Partial<ProjectRunOutputRecord> = {},
): ProjectRunOutputRecord => {
  const bytes = Buffer.from(JSON.stringify(document), "utf8");
  return Object.freeze({
    id: `run_output_${sampleIndex}`,
    runId: RUN.id,
    sampleIndex,
    sampleId: `sample_${sampleIndex}`,
    logicalName: "metrics",
    relativePath: "metrics.json",
    mediaType: "application/json",
    declaredRole: "data",
    bytes,
    sizeBytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    createdAt: RUN.finishedAt!,
    ...overrides,
  });
};

const summarize = (
  outputs: readonly ProjectRunOutputRecord[],
  fields: readonly string[] = ["/metrics/value"],
) => summarizeJsonOutputSeries({
  run: RUN,
  outputs,
  provenance: provenance(outputs.length),
  logicalName: "metrics",
  fields,
  quantiles: [0.5, 0.95],
});

test("Run JSON statistics are deterministic, sample-standardized, and provenance bound", () => {
  const outputs = [0, 1, 2, 3].map((value, sampleIndex) =>
    output(sampleIndex, { metrics: { value } }));
  const first = summarize(outputs);
  const second = summarize(outputs);

  assert.deepEqual(first, second);
  assert.equal(first.completeOutputCoverage, true);
  assert.equal(first.sampleCount, 4);
  assert.equal(first.outputCount, 4);
  assert.deepEqual(first.outputSha256BySample, outputs.map((item) => item.sha256));
  assert.match(first.outputSetDigest, /^[0-9a-f]{64}$/u);
  assert.match(first.statisticsDigest, /^[0-9a-f]{64}$/u);
  assert.ok(Math.abs(first.statistics[0]!.sampleStdDev! - Math.sqrt(5 / 3)) < 1e-15);
  assert.deepEqual(first.statistics.map((statistic) => ({
    ...statistic,
    sampleStdDev: null,
  })), [{
    field: "/metrics/value",
    count: 4,
    mean: 1.5,
    sampleStdDev: null,
    min: 0,
    quantiles: [
      { probability: 0.5, value: 1.5 },
      { probability: 0.95, value: 2.8499999999999996 },
    ],
    max: 3,
    nonZeroCount: 3,
  }]);
});

test("Run JSON statistics reject missing samples, missing fields, and non-numeric fields", () => {
  const complete = [
    output(0, { metrics: { value: 1 } }),
    output(1, { metrics: { value: 2 } }),
  ];
  assert.throws(() => summarizeJsonOutputSeries({
    run: RUN,
    outputs: complete.slice(0, 1),
    provenance: provenance(2),
    logicalName: "metrics",
    fields: ["/metrics/value"],
    quantiles: [0.5],
  }), (error) => error instanceof ApiError && error.code === "invalid_tool_input");
  assert.throws(() => summarize(complete, ["/metrics/missing"]),
    (error) => error instanceof ApiError && error.code === "invalid_tool_input");
  assert.throws(() => summarize([
    output(0, { metrics: { value: 1 } }),
    output(1, { metrics: { value: "2" } }),
  ]), (error) => error instanceof ApiError && error.code === "invalid_tool_input");
});

test("Run JSON statistics reject binary, invalid UTF-8, and truncated persisted bytes", () => {
  const binary = output(0, { metrics: { value: 1 } }, {
    mediaType: "application/octet-stream",
  });
  assert.throws(() => summarize([binary]),
    (error) => error instanceof ApiError && error.code === "invalid_tool_input");

  const invalidBytes = Buffer.from([0xff]);
  const invalidUtf8 = output(0, {}, {
    bytes: invalidBytes,
    sizeBytes: invalidBytes.byteLength,
    sha256: createHash("sha256").update(invalidBytes).digest("hex"),
  });
  assert.throws(() => summarize([invalidUtf8]),
    (error) => error instanceof ApiError && error.code === "run_output_invalid_utf8");

  const intact = output(0, { metrics: { value: 1 } });
  const truncated = Object.freeze({
    ...intact,
    bytes: intact.bytes.subarray(0, intact.bytes.byteLength - 1),
  });
  assert.throws(() => summarize([truncated]),
    (error) => error instanceof ApiError && error.code === "run_output_integrity_failed");
});
