import assert from "node:assert/strict";
import test from "node:test";
import { canonicalDigest, canonicalJsonV2, sha256Hex } from "../src/canonical-json-v2.ts";
import { ApiError } from "../src/errors.ts";
import {
  assertExperimentPlan,
  JSON_SCHEMA_2020_12,
  normalizeInputParameters,
  planExperiment,
  validateInputSchema,
} from "../src/experiment-planner.ts";

const schema = {
  $schema: JSON_SCHEMA_2020_12,
  type: "object",
  additionalProperties: false,
  required: ["nested"],
  properties: {
    count: { type: "integer", minimum: 1, default: 2 },
    nullable: { type: ["integer", "null"], default: 7 },
    nested: {
      type: "object",
      additionalProperties: false,
      properties: {
        rate: { type: "number", minimum: 0, default: 0.5 },
        label: { type: "string", minLength: 1, default: "base" },
      },
    },
  },
} as const;

const config = (sampling: unknown, parameters: unknown = { nested: {} }) => ({
  schemaVersion: 1,
  runKind: "batch",
  parameters,
  sampling,
});

const expectCode = (code: string, action: () => unknown): void => {
  assert.throws(action, (error: unknown) => error instanceof ApiError && error.status === 400 && error.code === code);
};

test("single planning applies nested defaults, preserves explicit null, and hashes explicit seed null", () => {
  const plan = planExperiment({
    inputSchema: schema,
    configuration: config({ kind: "single" }, { nested: {}, nullable: null }),
    maxSamples: 10,
  });
  assert.equal(plan.sampleCount, 1);
  assert.deepEqual(plan.configuration.parameters, {
    count: 2,
    nullable: null,
    nested: { rate: 0.5, label: "base" },
  });
  assert.deepEqual(plan.samples[0], {
    sampleIndex: 0,
    sampleId: sha256Hex(canonicalJsonV2({
      schemaVersion: 1,
      parameters: plan.configuration.parameters,
      seed: null,
    })),
    parameters: plan.configuration.parameters,
    seed: null,
  });
  assert.equal(Object.isFrozen(plan.samples), true);
  assert.equal(Object.isFrozen(plan.samples[0].parameters), true);
});

test("multiple seeds retain declaration order and reject duplicates and unsafe values", () => {
  const plan = planExperiment({
    inputSchema: schema,
    configuration: config({ kind: "multiple-seeds", seeds: [9, -2, 4] }),
    maxSamples: 3,
  });
  assert.deepEqual(plan.samples.map(({ sampleIndex, seed }) => ({ sampleIndex, seed })), [
    { sampleIndex: 0, seed: 9 },
    { sampleIndex: 1, seed: -2 },
    { sampleIndex: 2, seed: 4 },
  ]);
  expectCode("duplicate_sample_seed", () => planExperiment({
    inputSchema: schema,
    configuration: config({ kind: "multiple-seeds", seeds: [0, -0] }),
    maxSamples: 3,
  }));
  expectCode("invalid_sample_plan", () => planExperiment({
    inputSchema: schema,
    configuration: config({ kind: "multiple-seeds", seeds: [Number.MAX_SAFE_INTEGER + 1] }),
    maxSamples: 3,
  }));
  expectCode("sample_limit_exceeded", () => planExperiment({
    inputSchema: schema,
    configuration: config({ kind: "multiple-seeds", seeds: [1, 2] }),
    maxSamples: 1,
  }));
});

test("canonical number normalization rewrites a single negative-zero seed to zero", () => {
  const plan = planExperiment({
    inputSchema: schema,
    configuration: config({ kind: "single", seed: -0 }),
    maxSamples: 1,
  });
  assert.equal(Object.is((plan.configuration.sampling as any).seed, -0), false);
  assert.equal(Object.is(plan.samples[0].seed, -0), false);
  assert.equal(plan.samples[0].seed, 0);
});

test("cartesian expansion is axis order, then value order, then seed order", () => {
  const plan = planExperiment({
    inputSchema: schema,
    configuration: config({
      kind: "cartesian-sweep",
      axes: [
        { pointer: "/count", values: [3, 5] },
        { pointer: "/nested/label", values: ["a", "b"] },
      ],
      seeds: [7, 8],
    }),
    maxSamples: 8,
  });
  assert.equal(plan.sampleCount, 8);
  assert.deepEqual(plan.samples.map((sample) => [
    sample.parameters.count,
    (sample.parameters.nested as any).label,
    sample.seed,
  ]), [
    [3, "a", 7], [3, "a", 8],
    [3, "b", 7], [3, "b", 8],
    [5, "a", 7], [5, "a", 8],
    [5, "b", 7], [5, "b", 8],
  ]);
  assert.equal(new Set(plan.samples.map((sample) => sample.sampleId)).size, 8);
});

test("cartesian without seeds emits one explicit null branch and enforces exact limit", () => {
  const exact = planExperiment({
    inputSchema: schema,
    configuration: config({ kind: "cartesian-sweep", axes: [{ pointer: "/count", values: [2, 3] }] }),
    maxSamples: 2,
  });
  assert.deepEqual(exact.samples.map((sample) => sample.seed), [null, null]);
  expectCode("sample_limit_exceeded", () => planExperiment({
    inputSchema: schema,
    configuration: config({ kind: "cartesian-sweep", axes: [{ pointer: "/count", values: [2, 3] }] }),
    maxSamples: 1,
  }));
});

test("cartesian configuration freezes schema-normalized axis values for later exact reconstruction", () => {
  const plan = planExperiment({
    inputSchema: schema,
    configuration: config({
      kind: "cartesian-sweep",
      axes: [{ pointer: "/nested", values: [{ rate: 2 }] }],
    }),
    maxSamples: 1,
  });
  assert.deepEqual((plan.configuration.sampling as any).axes[0].values, [
    { rate: 2, label: "base" },
  ]);
  assert.deepEqual(plan.samples[0].parameters.nested, { rate: 2, label: "base" });
  assert.deepEqual(assertExperimentPlan(structuredClone(plan)), plan);
});

test("canonical duplicate values and overlapping pointers fail before expansion", () => {
  expectCode("duplicate_sweep_value", () => planExperiment({
    inputSchema: schema,
    configuration: config({ kind: "cartesian-sweep", axes: [{ pointer: "/count", values: [1, 1.0] }] }),
    maxSamples: 10,
  }));
  expectCode("overlapping_sweep_pointer", () => planExperiment({
    inputSchema: schema,
    configuration: config({
      kind: "cartesian-sweep",
      axes: [
        { pointer: "/nested", values: [{ rate: 1, label: "x" }] },
        { pointer: "/nested/rate", values: [1] },
      ],
    }),
    maxSamples: 10,
  }));
  expectCode("overlapping_sweep_pointer", () => planExperiment({
    inputSchema: schema,
    configuration: config({ kind: "cartesian-sweep", axes: [{ pointer: "", values: [1] }] }),
    maxSamples: 10,
  }));
});

test("RFC 6901 escaping resolves schema fields and missing fields require schema permission", () => {
  const pointerSchema = {
    $schema: JSON_SCHEMA_2020_12,
    type: "object",
    additionalProperties: { type: "integer" },
    properties: {
      "a/b": { type: "integer" },
      "t~n": { type: "integer" },
    },
  };
  const plan = planExperiment({
    inputSchema: pointerSchema,
    configuration: config({
      kind: "cartesian-sweep",
      axes: [
        { pointer: "/a~1b", values: [2] },
        { pointer: "/t~0n", values: [3] },
        { pointer: "/new", values: [4] },
      ],
    }, { "a/b": 1, "t~n": 1 }),
    maxSamples: 1,
  });
  assert.deepEqual(plan.samples[0].parameters, { "a/b": 2, "t~n": 3, new: 4 });
  expectCode("overlapping_sweep_pointer", () => planExperiment({
    inputSchema: pointerSchema,
    configuration: config({ kind: "cartesian-sweep", axes: [{ pointer: "/bad~2escape", values: [1] }] }, {}),
    maxSamples: 1,
  }));
});

test("closed schema profile rejects unknown vocabulary, format, external/cyclic refs, and open objects", () => {
  for (const inputSchema of [
    { ...schema, format: "custom" },
    { ...schema, title: "annotation is not in the closed profile" },
    { $schema: JSON_SCHEMA_2020_12, type: "object", properties: {} },
    { $schema: JSON_SCHEMA_2020_12, type: "object", properties: {}, additionalProperties: true },
    {
      $schema: JSON_SCHEMA_2020_12,
      type: "object",
      additionalProperties: false,
      properties: {
        nested: { type: "object", properties: {}, additionalProperties: true },
      },
    },
    {
      $schema: JSON_SCHEMA_2020_12,
      type: "object",
      additionalProperties: false,
      properties: { value: { $ref: "other.json" } },
    },
    {
      $schema: JSON_SCHEMA_2020_12,
      type: "object",
      additionalProperties: false,
      properties: { value: { $ref: "#/$defs/bad~2escape" } },
      $defs: { "bad~2escape": { type: "integer" } },
    },
    {
      $schema: JSON_SCHEMA_2020_12,
      type: "object",
      additionalProperties: false,
      $defs: {
        a: { $ref: "#/$defs/b" },
        b: { $ref: "#/$defs/a" },
      },
      properties: { value: { $ref: "#/$defs/a" } },
    },
  ]) expectCode("input_schema_unsupported", () => validateInputSchema(inputSchema));
});

test("schema validation and planning do not freeze or rewrite caller-owned schema objects", () => {
  const callerSchema = structuredClone(schema) as any;
  validateInputSchema(callerSchema);
  callerSchema.properties.count.minimum = 0;
  assert.equal(callerSchema.properties.count.minimum, 0);
});

test("local refs, Unicode code-point length, no coercion, and safe integers use one normalizer", () => {
  const local = {
    $schema: JSON_SCHEMA_2020_12,
    type: "object",
    additionalProperties: false,
    $defs: {
      label: { type: "string", minLength: 1, maxLength: 1 },
      count: { type: "integer" },
    },
    required: ["label", "count"],
    properties: {
      label: { $ref: "#/$defs/label" },
      count: { $ref: "#/$defs/count" },
    },
  };
  assert.deepEqual(normalizeInputParameters(local, { label: "😀", count: 2 }), { label: "😀", count: 2 });
  expectCode("invalid_sample_plan", () => normalizeInputParameters(local, { label: "😀😀", count: 2 }));
  expectCode("invalid_sample_plan", () => normalizeInputParameters(local, { label: "x", count: "2" }));
  expectCode("invalid_sample_plan", () => normalizeInputParameters(local, { label: "x", count: Number.MAX_SAFE_INTEGER + 1 }));
});

test("axis values are validated after application and visual runs stay single", () => {
  expectCode("invalid_sample_plan", () => planExperiment({
    inputSchema: schema,
    configuration: config({ kind: "cartesian-sweep", axes: [{ pointer: "/count", values: [0] }] }),
    maxSamples: 1,
  }));
  expectCode("invalid_sample_plan", () => planExperiment({
    inputSchema: schema,
    configuration: { ...config({ kind: "multiple-seeds", seeds: [1] }), runKind: "visual" },
    maxSamples: 1,
  }));
});

test("assertExperimentPlan returns a canonical deep-frozen Store-boundary copy", () => {
  const original = planExperiment({
    inputSchema: schema,
    configuration: config({
      kind: "cartesian-sweep",
      axes: [{ pointer: "/count", values: [2, 3] }],
      seeds: [8, 9],
    }),
    maxSamples: 4,
  });
  const persisted = structuredClone(original);
  const checked = assertExperimentPlan(persisted, 4);
  assert.deepEqual(checked, original);
  assert.notEqual(checked, persisted);
  assert.equal(Object.isFrozen(checked), true);
  assert.equal(Object.isFrozen(checked.configuration), true);
  assert.equal(Object.isFrozen(checked.configuration.sampling), true);
  assert.equal(Object.isFrozen(checked.samples), true);
  assert.equal(Object.isFrozen(checked.samples[0].parameters), true);
  assert.equal(Object.isFrozen(persisted), false);
});

test("assertExperimentPlan rejects corrupt configuration and sample-plan digests", () => {
  const original = planExperiment({
    inputSchema: schema,
    configuration: config({ kind: "single" }),
    maxSamples: 1,
  });
  const badConfiguration = structuredClone(original);
  badConfiguration.configurationDigest = "0".repeat(64);
  expectCode("invalid_sample_plan", () => assertExperimentPlan(badConfiguration));

  const badPlan = structuredClone(original);
  badPlan.samplePlanDigest = "f".repeat(64);
  expectCode("invalid_sample_plan", () => assertExperimentPlan(badPlan));
});

test("assertExperimentPlan rejects gaps, payload-ID drift, and duplicate sample IDs", () => {
  const original = planExperiment({
    inputSchema: schema,
    configuration: config({ kind: "multiple-seeds", seeds: [3, 4] }),
    maxSamples: 2,
  });
  const gap = structuredClone(original);
  gap.samples[1].sampleIndex = 2;
  gap.samplePlanDigest = canonicalDigest(gap.samples);
  expectCode("invalid_sample_plan", () => assertExperimentPlan(gap));

  const drift = structuredClone(original);
  drift.samples[0].parameters.count = 99;
  drift.samplePlanDigest = canonicalDigest(drift.samples);
  expectCode("invalid_sample_plan", () => assertExperimentPlan(drift));

  const sweep = planExperiment({
    inputSchema: schema,
    configuration: config({ kind: "cartesian-sweep", axes: [{ pointer: "/count", values: [2, 3] }] }),
    maxSamples: 2,
  });
  const duplicate = structuredClone(sweep);
  duplicate.samples[1] = { ...structuredClone(duplicate.samples[0]), sampleIndex: 1 };
  duplicate.samplePlanDigest = canonicalDigest(duplicate.samples);
  expectCode("invalid_sample_plan", () => assertExperimentPlan(duplicate));
});

test("assertExperimentPlan reconstructs cartesian value and seed order instead of trusting rehashed samples", () => {
  const original = planExperiment({
    inputSchema: schema,
    configuration: config({
      kind: "cartesian-sweep",
      axes: [
        { pointer: "/count", values: [2, 3] },
        { pointer: "/nested/label", values: ["a", "b"] },
      ],
      seeds: [7, 8],
    }),
    maxSamples: 8,
  });
  const forged = structuredClone(original);
  [forged.samples[0], forged.samples[2]] = [forged.samples[2], forged.samples[0]];
  forged.samples.forEach((sample, sampleIndex) => {
    sample.sampleIndex = sampleIndex;
    sample.sampleId = sha256Hex(canonicalJsonV2({
      schemaVersion: 1,
      parameters: sample.parameters,
      seed: sample.seed,
    }));
  });
  forged.samplePlanDigest = canonicalDigest(forged.samples);
  expectCode("invalid_sample_plan", () => assertExperimentPlan(forged));

  const offAxis = structuredClone(original);
  offAxis.samples[0].parameters.count = 99;
  offAxis.samples[0].sampleId = sha256Hex(canonicalJsonV2({
    schemaVersion: 1,
    parameters: offAxis.samples[0].parameters,
    seed: offAxis.samples[0].seed,
  }));
  offAxis.samplePlanDigest = canonicalDigest(offAxis.samples);
  expectCode("invalid_sample_plan", () => assertExperimentPlan(offAxis));
});

test("assertExperimentPlan rechecks visual-single and maxSamples constraints", () => {
  const batch = planExperiment({
    inputSchema: schema,
    configuration: config({ kind: "multiple-seeds", seeds: [1, 2] }),
    maxSamples: 2,
  });
  expectCode("sample_limit_exceeded", () => assertExperimentPlan(structuredClone(batch), 1));

  const corruptVisual = structuredClone(batch);
  corruptVisual.configuration.runKind = "visual";
  corruptVisual.configurationDigest = canonicalDigest(corruptVisual.configuration);
  expectCode("invalid_sample_plan", () => assertExperimentPlan(corruptVisual, 2));
});
