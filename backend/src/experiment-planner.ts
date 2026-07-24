import { canonicalDigest, canonicalJsonV2, sha256Hex, type CanonicalJson } from "./canonical-json-v2.ts";
import { ApiError } from "./errors.ts";

export const INPUT_SCHEMA_PROFILE = "riff-json-schema-2020-12-v1" as const;
export const JSON_SCHEMA_2020_12 = "https://json-schema.org/draft/2020-12/schema" as const;

export type JsonValue = CanonicalJson;
export type JsonObject = { [key: string]: JsonValue };
export type SafeInteger = number;
export type JsonPointer = string;

export type ExperimentConfigurationV1 = Readonly<{
  schemaVersion: 1;
  runKind: "batch" | "visual";
  parameters: JsonObject;
  sampling:
    | Readonly<{ kind: "single"; seed?: SafeInteger }>
    | Readonly<{ kind: "multiple-seeds"; seeds: readonly SafeInteger[] }>
    | Readonly<{
        kind: "cartesian-sweep";
        axes: readonly Readonly<{ pointer: JsonPointer; values: readonly JsonValue[] }>[];
        seeds?: readonly SafeInteger[];
      }>;
}>;

export type PlannedSample = Readonly<{
  sampleIndex: number;
  sampleId: string;
  parameters: JsonObject;
  seed: SafeInteger | null;
}>;

export type ExperimentPlan = Readonly<{
  configuration: ExperimentConfigurationV1;
  configurationDigest: string;
  sampleCount: number;
  samples: readonly PlannedSample[];
  samplePlanDigest: string;
}>;

export type ExperimentPlannerInput = Readonly<{
  configuration: unknown;
  inputSchema: unknown;
  maxSamples: number;
}>;

type SchemaObject = Record<string, unknown>;
type Schema = boolean | SchemaObject;
type ResolvedPointer = Readonly<{ normalized: string; tokens: readonly string[] }>;

const ALLOWED_SCHEMA_KEYS = new Set([
  "$schema", "$id", "$defs", "$ref", "type", "properties", "required",
  "additionalProperties", "items", "minItems", "maxItems", "enum", "const",
  "default", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum",
  "minLength", "maxLength",
]);
const ALLOWED_TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const MISSING = Symbol("missing");

export const planExperiment = (input: ExperimentPlannerInput): ExperimentPlan => {
  if (!Number.isSafeInteger(input.maxSamples) || input.maxSamples < 1) {
    fail("invalid_sample_plan", "The sample limit must be a positive safe integer.");
  }
  const schema = validateSchemaProfile(input.inputSchema);
  const raw = configurationRecord(input.configuration);
  const normalizedParameters = normalizeAgainstSchema(schema, raw.parameters, schema, "$");
  if (!isPlainObject(normalizedParameters)) fail("invalid_sample_plan", "Experiment parameters must be a JSON object.");

  const runKind = raw.runKind as "batch" | "visual";
  const sampling = samplingRecord(raw.sampling);
  const seeds = validateSeeds(sampling);
  const declaredSampling = normalizeSampling(sampling, seeds);
  const normalizedSampling = declaredSampling.kind === "cartesian-sweep"
    ? normalizeCartesianSampling(schema, normalizedParameters as JsonObject, declaredSampling)
    : declaredSampling;
  const configuration = deepFreeze({
    schemaVersion: 1 as const,
    runKind,
    parameters: normalizedParameters as JsonObject,
    sampling: normalizedSampling,
  });

  let payloads: Array<Readonly<{ parameters: JsonObject; seed: SafeInteger | null }>>;
  if (normalizedSampling.kind === "single") {
    payloads = [{ parameters: normalizedParameters as JsonObject, seed: normalizedSampling.seed ?? null }];
  } else if (normalizedSampling.kind === "multiple-seeds") {
    if (normalizedSampling.seeds.length > input.maxSamples) fail("sample_limit_exceeded", "The exact sample count exceeds the run limit.");
    payloads = normalizedSampling.seeds.map((seed) => ({ parameters: normalizedParameters as JsonObject, seed }));
  } else {
    payloads = expandCartesian(schema, normalizedParameters as JsonObject, normalizedSampling, input.maxSamples);
  }

  if (runKind === "visual" && (normalizedSampling.kind !== "single" || payloads.length !== 1)) {
    fail("invalid_sample_plan", "Visual experiments require single sampling and exactly one sample.");
  }
  if (payloads.length > input.maxSamples) fail("sample_limit_exceeded", "The exact sample count exceeds the run limit.");

  const ids = new Set<string>();
  const samples = payloads.map(({ parameters, seed }, sampleIndex): PlannedSample => {
    const samplePayload = deepFreeze({ schemaVersion: 1 as const, parameters, seed });
    const sampleId = sha256Hex(canonicalJsonV2(samplePayload));
    if (ids.has(sampleId)) fail("invalid_sample_plan", "The expanded sample plan contains duplicate sample IDs.");
    ids.add(sampleId);
    return deepFreeze({ sampleIndex, sampleId, parameters, seed });
  });
  const frozenSamples = deepFreeze(samples);
  return deepFreeze({
    configuration,
    configurationDigest: canonicalDigest(configuration),
    sampleCount: frozenSamples.length,
    samples: frozenSamples,
    samplePlanDigest: canonicalDigest(frozenSamples),
  });
};

/**
 * Revalidates a persisted/frozen planner result without consulting mutable
 * experiment or schema state. The returned value is a canonical deep-frozen
 * copy suitable for use at the Store boundary.
 */
export const assertExperimentPlan = (input: unknown, maxSamples?: number): ExperimentPlan => {
  if (maxSamples !== undefined && (!Number.isSafeInteger(maxSamples) || maxSamples < 1)) {
    fail("invalid_sample_plan", "The sample limit must be a positive safe integer.");
  }
  assertJson(input, "Experiment plan");
  const plan = exactRecord(cloneJson(input as JsonValue), [
    "configuration",
    "configurationDigest",
    "sampleCount",
    "samples",
    "samplePlanDigest",
  ], "Experiment plan");

  const rawConfiguration = configurationRecord(plan.configuration);
  const sampling = samplingRecord(rawConfiguration.sampling);
  const seeds = validateSeeds(sampling);
  const normalizedConfiguration = {
    schemaVersion: 1 as const,
    runKind: rawConfiguration.runKind as "batch" | "visual",
    parameters: cloneJson(rawConfiguration.parameters as JsonValue) as JsonObject,
    sampling: normalizeSampling(sampling, seeds),
  };
  if (!jsonEqual(rawConfiguration, normalizedConfiguration)) {
    fail("invalid_sample_plan", "The frozen experiment configuration is not canonical.");
  }
  if (!isSha256(plan.configurationDigest) || plan.configurationDigest !== canonicalDigest(normalizedConfiguration)) {
    fail("invalid_sample_plan", "The frozen experiment configuration digest is invalid.");
  }

  if (!Number.isSafeInteger(plan.sampleCount) || (plan.sampleCount as number) < 1 || !Array.isArray(plan.samples) || plan.samples.length !== plan.sampleCount) {
    fail("invalid_sample_plan", "The frozen sample count does not match the sample plan.");
  }
  const expectedSampleCount = exactConfigurationSampleCount(normalizedConfiguration.sampling);
  if (expectedSampleCount !== plan.sampleCount) fail("invalid_sample_plan", "The sample plan does not match its sampling declaration.");
  if (maxSamples !== undefined && expectedSampleCount > maxSamples) {
    fail("sample_limit_exceeded", "The exact sample count exceeds the run limit.");
  }
  if (normalizedConfiguration.runKind === "visual" && (normalizedConfiguration.sampling.kind !== "single" || expectedSampleCount !== 1)) {
    fail("invalid_sample_plan", "Visual experiments require single sampling and exactly one sample.");
  }

  const expectedPayloads = expectedSamplePayloads(normalizedConfiguration);
  if (expectedPayloads.length !== expectedSampleCount) {
    fail("invalid_sample_plan", "The sample plan does not match its sampling declaration.");
  }
  const sampleIds = new Set<string>();
  const samples = (plan.samples as unknown[]).map((inputSample, sampleIndex): PlannedSample => {
    const sample = exactRecord(inputSample, ["sampleIndex", "sampleId", "parameters", "seed"], `Sample ${sampleIndex}`);
    const expectedPayload = expectedPayloads[sampleIndex]!;
    if (sample.sampleIndex !== sampleIndex) fail("invalid_sample_plan", "Sample indexes must be zero-based and continuous.");
    if (!isPlainObject(sample.parameters)) fail("invalid_sample_plan", "Every sample must contain JSON-object parameters.");
    assertJson(sample.parameters, `Sample ${sampleIndex} parameters`);
    if (sample.seed !== null) assertSafeInteger(sample.seed, `Sample ${sampleIndex} seed`);
    if (sample.seed !== expectedPayload.seed) fail("invalid_sample_plan", "Sample seeds do not follow the frozen declaration order.");
    if (!jsonEqual(sample.parameters, expectedPayload.parameters)) {
      fail("invalid_sample_plan", "Sample parameters do not follow the frozen sampling declaration.");
    }
    const samplePayload = {
      schemaVersion: 1 as const,
      parameters: sample.parameters,
      seed: sample.seed,
    };
    const expectedSampleId = sha256Hex(canonicalJsonV2(samplePayload));
    if (!isSha256(sample.sampleId) || sample.sampleId !== expectedSampleId) fail("invalid_sample_plan", "A sample ID does not match its canonical payload.");
    const sampleId = sample.sampleId as string;
    if (sampleIds.has(sampleId)) fail("invalid_sample_plan", "The frozen sample plan contains duplicate sample IDs.");
    sampleIds.add(sampleId);
    return {
      sampleIndex,
      sampleId,
      parameters: cloneJson(sample.parameters as JsonValue) as JsonObject,
      seed: sample.seed as number | null,
    };
  });
  if (!isSha256(plan.samplePlanDigest) || plan.samplePlanDigest !== canonicalDigest(samples)) {
    fail("invalid_sample_plan", "The frozen sample-plan digest is invalid.");
  }
  return deepFreeze({
    configuration: normalizedConfiguration,
    configurationDigest: plan.configurationDigest as string,
    sampleCount: expectedSampleCount,
    samples,
    samplePlanDigest: plan.samplePlanDigest as string,
  });
};

/**
 * Validates the closed profile and returns the same schema identity. Callers
 * may use this independently at Model technical-check time.
 */
export const validateInputSchema = (inputSchema: unknown): Schema => validateSchemaProfile(inputSchema);

/**
 * Applies the profile's defaulting and validation rules without coercion.
 */
export const normalizeInputParameters = (inputSchema: unknown, parameters: unknown): JsonObject => {
  const schema = validateSchemaProfile(inputSchema);
  const normalized = normalizeAgainstSchema(schema, parameters, schema, "$");
  if (!isPlainObject(normalized)) fail("invalid_sample_plan", "Experiment parameters must be a JSON object.");
  return deepFreeze(normalized as JsonObject);
};

const configurationRecord = (value: unknown): Record<string, unknown> => {
  const record = exactRecord(value, ["schemaVersion", "runKind", "parameters", "sampling"], "Experiment configuration");
  if (record.schemaVersion !== 1 || (record.runKind !== "batch" && record.runKind !== "visual") || !isPlainObject(record.parameters)) {
    fail("invalid_sample_plan", "The ExperimentConfigurationV1 envelope is invalid.");
  }
  assertJson(record.parameters, "Experiment parameters");
  return record;
};

const samplingRecord = (value: unknown): Record<string, unknown> => {
  if (!isPlainObject(value) || typeof value.kind !== "string") fail("invalid_sample_plan", "The sampling declaration is invalid.");
  const record = value as Record<string, unknown>;
  if (record.kind === "single") {
    return exactRecord(record, Object.hasOwn(record, "seed") ? ["kind", "seed"] : ["kind"], "Single sampling");
  }
  if (record.kind === "multiple-seeds") return exactRecord(record, ["kind", "seeds"], "Multiple-seed sampling");
  if (record.kind === "cartesian-sweep") {
    return exactRecord(record, Object.hasOwn(record, "seeds") ? ["kind", "axes", "seeds"] : ["kind", "axes"], "Cartesian sampling");
  }
  return fail("invalid_sample_plan", "The sampling kind is unsupported.");
};

const validateSeeds = (sampling: Record<string, unknown>): readonly number[] => {
  if (sampling.kind === "single") {
    if (!Object.hasOwn(sampling, "seed")) return [];
    assertSafeInteger(sampling.seed, "Single seed");
    return [Object.is(sampling.seed, -0) ? 0 : sampling.seed as number];
  }
  const raw = sampling.seeds;
  if (sampling.kind === "multiple-seeds" || Object.hasOwn(sampling, "seeds")) {
    if (!Array.isArray(raw) || raw.length === 0) fail("invalid_sample_plan", "A declared seed list must be non-empty.");
    const seedList = raw as unknown[];
    const seen = new Set<number>();
    for (const seed of seedList) {
      assertSafeInteger(seed, "Sample seed");
      const numericSeed = seed as number;
      if (seen.has(numericSeed)) fail("duplicate_sample_seed", "Sample seeds must be unique.");
      seen.add(numericSeed);
    }
    return Object.freeze([...seen]);
  }
  return [];
};

const normalizeSampling = (
  sampling: Record<string, unknown>,
  seeds: readonly number[],
): ExperimentConfigurationV1["sampling"] => {
  if (sampling.kind === "single") return Object.hasOwn(sampling, "seed")
    ? deepFreeze({ kind: "single" as const, seed: seeds[0] })
    : deepFreeze({ kind: "single" as const });
  if (sampling.kind === "multiple-seeds") return deepFreeze({ kind: "multiple-seeds" as const, seeds: [...seeds] });
  if (!Array.isArray(sampling.axes) || sampling.axes.length === 0) fail("invalid_sample_plan", "Cartesian sampling requires at least one axis.");
  const rawAxes = sampling.axes as unknown[];
  const pointers: ResolvedPointer[] = [];
  const axes = rawAxes.map((axis, index) => {
    const record = exactRecord(axis, ["pointer", "values"], `Sweep axis ${index}`);
    const pointer = parsePointer(record.pointer);
    if (pointer.tokens.length === 0) fail("overlapping_sweep_pointer", "The root pointer cannot be swept.");
    if (!Array.isArray(record.values) || record.values.length === 0) fail("invalid_sample_plan", "Every sweep axis requires at least one value.");
    const rawValues = record.values as unknown[];
    const seen = new Set<string>();
    const values = rawValues.map((value) => {
      assertJson(value, "Sweep value");
      const key = canonicalJsonV2(value).toString("utf8");
      if (seen.has(key)) fail("duplicate_sweep_value", "Sweep values must be unique by canonical JSON equality.");
      seen.add(key);
      return cloneJson(value as JsonValue);
    });
    pointers.push(pointer);
    return deepFreeze({ pointer: pointer.normalized, values });
  });
  for (let left = 0; left < pointers.length; left += 1) {
    for (let right = left + 1; right < pointers.length; right += 1) {
      if (isTokenPrefix(pointers[left].tokens, pointers[right].tokens) || isTokenPrefix(pointers[right].tokens, pointers[left].tokens)) {
        fail("overlapping_sweep_pointer", "Sweep pointers must be unique and cannot have a parent/child overlap.");
      }
    }
  }
  return Object.hasOwn(sampling, "seeds")
    ? deepFreeze({ kind: "cartesian-sweep" as const, axes, seeds: [...seeds] })
    : deepFreeze({ kind: "cartesian-sweep" as const, axes });
};

const normalizeCartesianSampling = (
  rootSchema: Schema,
  base: JsonObject,
  sampling: Extract<ExperimentConfigurationV1["sampling"], { kind: "cartesian-sweep" }>,
): Extract<ExperimentConfigurationV1["sampling"], { kind: "cartesian-sweep" }> => {
  const axes = sampling.axes.map((axis) => {
    const pointer = parsePointer(axis.pointer);
    const values = axis.values.map((value) => {
      const candidate = setPointer(rootSchema, base, pointer, value);
      const normalized = normalizeAgainstSchema(rootSchema, candidate, rootSchema, "$");
      if (!isPlainObject(normalized)) fail("invalid_sample_plan", "Sweep normalization must retain object parameters.");
      return readDeclaredPointer(normalized as JsonObject, pointer);
    });
    return deepFreeze({ pointer: axis.pointer, values });
  });
  return Object.hasOwn(sampling, "seeds")
    ? deepFreeze({ kind: "cartesian-sweep" as const, axes, seeds: [...sampling.seeds!] })
    : deepFreeze({ kind: "cartesian-sweep" as const, axes });
};

const expandCartesian = (
  rootSchema: Schema,
  base: JsonObject,
  sampling: Extract<ExperimentConfigurationV1["sampling"], { kind: "cartesian-sweep" }>,
  maxSamples: number,
): Array<Readonly<{ parameters: JsonObject; seed: number | null }>> => {
  let count = 1;
  for (const axis of sampling.axes) {
    if (count > Math.floor(maxSamples / axis.values.length)) fail("sample_limit_exceeded", "The exact sample count exceeds the run limit.");
    count *= axis.values.length;
  }
  const branchSeeds: readonly (number | null)[] = sampling.seeds ?? [null];
  if (count > Math.floor(maxSamples / branchSeeds.length)) fail("sample_limit_exceeded", "The exact sample count exceeds the run limit.");

  const resolved = sampling.axes.map((axis) => ({ axis, pointer: parsePointer(axis.pointer) }));
  for (const { axis, pointer } of resolved) {
    for (const value of axis.values) {
      const candidate = setPointer(rootSchema, base, pointer, value);
      normalizeAgainstSchema(rootSchema, candidate, rootSchema, "$");
    }
  }

  const combinations: JsonObject[] = [];
  const visit = (axisIndex: number, parameters: JsonObject): void => {
    if (axisIndex === resolved.length) {
      combinations.push(normalizeAgainstSchema(rootSchema, parameters, rootSchema, "$") as JsonObject);
      return;
    }
    const { axis, pointer } = resolved[axisIndex];
    for (const value of axis.values) visit(axisIndex + 1, setPointer(rootSchema, parameters, pointer, value));
  };
  visit(0, base);

  const payloads: Array<Readonly<{ parameters: JsonObject; seed: number | null }>> = [];
  for (const parameters of combinations) {
    for (const seed of branchSeeds) payloads.push(deepFreeze({ parameters: deepFreeze(parameters), seed }));
  }
  return payloads;
};

const exactConfigurationSampleCount = (sampling: ExperimentConfigurationV1["sampling"]): number => {
  if (sampling.kind === "single") return 1;
  if (sampling.kind === "multiple-seeds") return sampling.seeds.length;
  let count = 1;
  for (const axis of sampling.axes) {
    if (count > Math.floor(Number.MAX_SAFE_INTEGER / axis.values.length)) {
      fail("invalid_sample_plan", "The declared sample count exceeds safe-integer bounds.");
    }
    count *= axis.values.length;
  }
  const seedBranches = sampling.seeds?.length ?? 1;
  if (count > Math.floor(Number.MAX_SAFE_INTEGER / seedBranches)) {
    fail("invalid_sample_plan", "The declared sample count exceeds safe-integer bounds.");
  }
  return count * seedBranches;
};

const expectedSamplePayloads = (
  configuration: ExperimentConfigurationV1,
): Array<Readonly<{ parameters: JsonObject; seed: number | null }>> => {
  const { parameters, sampling } = configuration;
  if (sampling.kind === "single") {
    return [{ parameters: cloneJson(parameters), seed: sampling.seed ?? null }];
  }
  if (sampling.kind === "multiple-seeds") {
    return sampling.seeds.map((seed) => ({ parameters: cloneJson(parameters), seed }));
  }

  const resolved = sampling.axes.map((axis) => ({ axis, pointer: parsePointer(axis.pointer) }));
  const combinations: JsonObject[] = [];
  const visit = (axisIndex: number, current: JsonObject): void => {
    if (axisIndex === resolved.length) {
      combinations.push(cloneJson(current));
      return;
    }
    const { axis, pointer } = resolved[axisIndex]!;
    for (const value of axis.values) {
      visit(axisIndex + 1, setDeclaredPointer(current, pointer, value));
    }
  };
  visit(0, parameters);

  const branchSeeds: readonly (number | null)[] = sampling.seeds ?? [null];
  const payloads: Array<Readonly<{ parameters: JsonObject; seed: number | null }>> = [];
  for (const current of combinations) {
    for (const seed of branchSeeds) payloads.push({ parameters: cloneJson(current), seed });
  }
  return payloads;
};

const validateSchemaProfile = (value: unknown): Schema => {
  assertSchemaJson(value, "Input schema");
  const root = asSchema(cloneJson(value as JsonValue), true, false, "$");
  if (root === true || root === false || root.$schema !== JSON_SCHEMA_2020_12) {
    schemaFail("The input schema must declare the exact JSON Schema 2020-12 dialect.");
  }
  const schemas: Record<string, unknown>[] = [];
  walkSchema(root, true, false, "$", schemas);
  const rootSchema = root as Schema;
  const visiting = new Set<Schema>();
  const visited = new Set<Schema>();
  const visitReferences = (schema: Schema): void => {
    if (typeof schema === "boolean" || visited.has(schema)) return;
    if (visiting.has(schema)) schemaFail("Local schema references must be acyclic.");
    visiting.add(schema);
    if (typeof schema.$ref === "string") visitReferences(resolveReference(rootSchema, schema.$ref));
    for (const child of schemaChildren(schema)) visitReferences(child);
    visiting.delete(schema);
    visited.add(schema);
  };
  visitReferences(rootSchema);
  for (const schema of schemas) {
    if (Object.hasOwn(schema, "default")) normalizeAgainstSchema(rootSchema, schema.default, schema, "$default", true);
  }
  return deepFreeze(rootSchema);
};

const walkSchema = (
  input: Schema,
  isRoot: boolean,
  isProperty: boolean,
  path: string,
  schemas: Record<string, unknown>[],
): void => {
  if (typeof input === "boolean") return;
  const schema: SchemaObject = input;
  schemas.push(schema);
  for (const key of Object.keys(schema)) if (!ALLOWED_SCHEMA_KEYS.has(key)) schemaFail(`Unsupported schema keyword ${key}.`);
  if (Object.hasOwn(schema, "format")) schemaFail("The format keyword is unsupported.");
  if (Object.hasOwn(schema, "$schema") && schema.$schema !== JSON_SCHEMA_2020_12) schemaFail("The schema dialect is unsupported.");
  if (Object.hasOwn(schema, "$id") && typeof schema.$id !== "string") schemaFail("Schema $id must be a string.");
  if (Object.hasOwn(schema, "$ref") && typeof schema.$ref !== "string") schemaFail("Schema $ref must be a string.");

  const types = schemaTypes(schema.type);
  const objectKeywords = Object.hasOwn(schema, "properties") || Object.hasOwn(schema, "required") || Object.hasOwn(schema, "additionalProperties");
  if ((types.has("object") || objectKeywords) && !Object.hasOwn(schema, "additionalProperties")) {
    schemaFail(`Object schema ${path} must declare additionalProperties.`);
  }
  if (Object.hasOwn(schema, "additionalProperties") && schema.additionalProperties !== false && !isPlainObject(schema.additionalProperties)) {
    schemaFail("additionalProperties must be false or an allowed-profile schema.");
  }
  if (Object.hasOwn(schema, "properties")) {
    if (!isPlainObject(schema.properties)) schemaFail("Schema properties must be an object.");
    for (const [key, child] of Object.entries(schema.properties as Record<string, unknown>)) {
      assertSafeKey(key, "Schema property");
      walkSchema(asSchema(child, false, true, `${path}/properties/${key}`), false, true, `${path}/properties/${key}`, schemas);
    }
  }
  if (Object.hasOwn(schema, "$defs")) {
    if (!isPlainObject(schema.$defs)) schemaFail("Schema $defs must be an object.");
    for (const [key, child] of Object.entries(schema.$defs as Record<string, unknown>)) {
      assertSafeKey(key, "Schema definition");
      walkSchema(asSchema(child, false, false, `${path}/$defs/${key}`), false, false, `${path}/$defs/${key}`, schemas);
    }
  }
  if (typeof schema.additionalProperties === "object") walkSchema(schema.additionalProperties as Schema, false, false, `${path}/additionalProperties`, schemas);
  if (Object.hasOwn(schema, "items")) walkSchema(asSchema(schema.items, false, false, `${path}/items`), false, false, `${path}/items`, schemas);

  if (Object.hasOwn(schema, "required")) {
    if (!Array.isArray(schema.required) || schema.required.some((item) => typeof item !== "string") || new Set(schema.required).size !== schema.required.length) {
      schemaFail("Schema required must contain unique property names.");
    }
  }
  for (const key of ["minItems", "maxItems", "minLength", "maxLength"] as const) {
    if (Object.hasOwn(schema, key) && (!Number.isSafeInteger(schema[key]) || (schema[key] as number) < 0)) schemaFail(`${key} must be a non-negative safe integer.`);
  }
  for (const key of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"] as const) {
    if (Object.hasOwn(schema, key) && (typeof schema[key] !== "number" || !Number.isFinite(schema[key]))) schemaFail(`${key} must be finite.`);
  }
  if (Object.hasOwn(schema, "enum")) {
    if (!Array.isArray(schema.enum) || schema.enum.length === 0) schemaFail("Schema enum must be non-empty.");
    const values = new Set<string>();
    for (const item of schema.enum as unknown[]) {
      assertSchemaJson(item, "Schema enum");
      const key = canonicalJsonV2(item).toString("utf8");
      if (values.has(key)) schemaFail("Schema enum values must be unique by canonical JSON equality.");
      values.add(key);
    }
  }
  if (Object.hasOwn(schema, "const")) assertSchemaJson(schema.const, "Schema const");
  if (Object.hasOwn(schema, "default")) {
    if (!isProperty) schemaFail("Schema default is allowed only on a property schema.");
    assertSchemaJson(schema.default, "Schema default");
  }
  if (isRoot && types.size > 0 && !types.has("object")) schemaFail("The input parameter schema must allow an object.");
};

const asSchema = (value: unknown, _isRoot: boolean, _isProperty: boolean, _path: string): Schema => {
  if (typeof value === "boolean") return value;
  if (!isPlainObject(value)) schemaFail("Every schema node must be a boolean or plain object.");
  return value as Record<string, unknown>;
};

const schemaTypes = (value: unknown): Set<string> => {
  if (value === undefined) return new Set();
  const list = typeof value === "string" ? [value] : Array.isArray(value) ? value : schemaFail("Schema type is invalid.");
  if (list.length === 0 || list.some((item) => typeof item !== "string" || !ALLOWED_TYPES.has(item)) || new Set(list).size !== list.length) {
    schemaFail("Schema type names must be supported and unique.");
  }
  return new Set(list as string[]);
};

const schemaChildren = (schema: Record<string, unknown>): Schema[] => {
  const result: Schema[] = [];
  if (isPlainObject(schema.$defs)) result.push(...Object.values(schema.$defs) as Schema[]);
  if (isPlainObject(schema.properties)) result.push(...Object.values(schema.properties) as Schema[]);
  if (typeof schema.additionalProperties === "boolean" || isPlainObject(schema.additionalProperties)) result.push(schema.additionalProperties as Schema);
  if (typeof schema.items === "boolean" || isPlainObject(schema.items)) result.push(schema.items as Schema);
  return result;
};

const normalizeAgainstSchema = (
  root: Schema,
  input: unknown,
  inputSchema: Schema,
  path: string,
  validatingDefault = false,
): JsonValue => {
  let schema = inputSchema;
  if (typeof schema !== "boolean" && typeof schema.$ref === "string") {
    const throughReference = normalizeAgainstSchema(root, input, resolveReference(root, schema.$ref), path, validatingDefault);
    const siblings = { ...schema };
    delete siblings.$ref;
    if (Object.keys(siblings).length === 0) return throughReference;
    schema = siblings;
    input = throughReference;
  }
  if (schema === false) validationFail(path, "is rejected by the schema");
  if (schema === true) {
    assertJson(input, path);
    return cloneJson(input as JsonValue);
  }
  const objectSchema = schema as SchemaObject;
  assertJson(input, path);
  let value = cloneJson(input as JsonValue);

  if (Object.hasOwn(objectSchema, "enum") && !(objectSchema.enum as unknown[]).some((candidate) => jsonEqual(candidate, value))) validationFail(path, "is not an allowed enum value");
  if (Object.hasOwn(objectSchema, "const") && !jsonEqual(objectSchema.const, value)) validationFail(path, "does not equal const");

  const types = schemaTypes(objectSchema.type);
  if (types.size > 0 && ![...types].some((type) => valueHasType(value, type))) validationFail(path, "has the wrong JSON type");

  if (isPlainObject(value)) {
    const properties = isPlainObject(objectSchema.properties) ? objectSchema.properties : {};
    const output = cloneJson(value) as JsonObject;
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (!Object.hasOwn(output, key) && isPlainObject(propertySchema) && Object.hasOwn(propertySchema, "default")) {
        output[key] = cloneJson(propertySchema.default as JsonValue);
      }
      if (Object.hasOwn(output, key)) output[key] = normalizeAgainstSchema(root, output[key], propertySchema as Schema, `${path}/${escapeToken(key)}`, validatingDefault);
    }
    for (const required of (objectSchema.required ?? []) as string[]) if (!Object.hasOwn(output, required)) validationFail(path, `is missing required property ${required}`);
    for (const key of Object.keys(output)) {
      if (Object.hasOwn(properties, key)) continue;
      if (objectSchema.additionalProperties === false) validationFail(path, `contains unknown property ${key}`);
      if (typeof objectSchema.additionalProperties === "boolean" || isPlainObject(objectSchema.additionalProperties)) {
        output[key] = normalizeAgainstSchema(root, output[key], objectSchema.additionalProperties as Schema, `${path}/${escapeToken(key)}`, validatingDefault);
      }
    }
    value = output;
  }
  if (Array.isArray(value)) {
    if (typeof objectSchema.minItems === "number" && value.length < objectSchema.minItems) validationFail(path, "has too few items");
    if (typeof objectSchema.maxItems === "number" && value.length > objectSchema.maxItems) validationFail(path, "has too many items");
    if (Object.hasOwn(objectSchema, "items")) value = value.map((item, index) => normalizeAgainstSchema(root, item, objectSchema.items as Schema, `${path}/${index}`, validatingDefault));
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) validationFail(path, "must be finite");
    if (types.has("integer") && !types.has("number") && !Number.isSafeInteger(value)) validationFail(path, "must be a safe integer");
    if (typeof objectSchema.minimum === "number" && value < objectSchema.minimum) validationFail(path, "is below minimum");
    if (typeof objectSchema.maximum === "number" && value > objectSchema.maximum) validationFail(path, "is above maximum");
    if (typeof objectSchema.exclusiveMinimum === "number" && value <= objectSchema.exclusiveMinimum) validationFail(path, "is not above exclusiveMinimum");
    if (typeof objectSchema.exclusiveMaximum === "number" && value >= objectSchema.exclusiveMaximum) validationFail(path, "is not below exclusiveMaximum");
    if (Object.is(value, -0)) value = 0;
  }
  if (typeof value === "string") {
    const length = [...value].length;
    if (typeof objectSchema.minLength === "number" && length < objectSchema.minLength) validationFail(path, "is shorter than minLength");
    if (typeof objectSchema.maxLength === "number" && length > objectSchema.maxLength) validationFail(path, "is longer than maxLength");
  }
  return value;
};

const resolveReference = (root: Schema, reference: string): Schema => {
  if (!reference.startsWith("#/$defs/")) schemaFail("Only canonical local #/$defs/... references are supported.");
  const pointer = parsePointer(reference.slice(1), true, "input_schema_unsupported");
  if (pointer.tokens[0] !== "$defs") schemaFail("Only canonical local #/$defs/... references are supported.");
  let current: unknown = root;
  for (const token of pointer.tokens) {
    if (!isPlainObject(current) || !Object.hasOwn(current, token)) schemaFail("A local schema reference does not resolve.");
    current = (current as Record<string, unknown>)[token];
  }
  return asSchema(current, false, false, reference);
};

const setPointer = (rootSchema: Schema, input: JsonObject, pointer: ResolvedPointer, value: JsonValue): JsonObject => {
  const output = cloneJson(input) as JsonObject;
  let currentValue: JsonValue = output;
  let currentSchema = rootSchema;
  for (let index = 0; index < pointer.tokens.length; index += 1) {
    currentSchema = dereference(rootSchema, currentSchema);
    const token = pointer.tokens[index];
    const final = index === pointer.tokens.length - 1;
    if (isPlainObject(currentValue)) {
      const currentObject = currentValue as JsonObject;
      const childSchema = objectChildSchema(currentSchema, token);
      if (childSchema === MISSING) validationFail(pointer.normalized, "does not resolve to a schema-allowed parameter field");
      if (final) {
        currentObject[token] = cloneJson(value);
        return output;
      }
      if (!Object.hasOwn(currentObject, token)) validationFail(pointer.normalized, "has a missing parent value");
      currentValue = currentObject[token];
      currentSchema = childSchema as Schema;
      continue;
    }
    if (Array.isArray(currentValue)) {
      if (!/^(?:0|[1-9]\d*)$/u.test(token)) validationFail(pointer.normalized, "contains a non-canonical array index");
      const childIndex = Number(token);
      if (!Number.isSafeInteger(childIndex) || childIndex >= currentValue.length) validationFail(pointer.normalized, "does not resolve to an existing array item");
      const childSchema = arrayChildSchema(currentSchema);
      if (childSchema === MISSING) validationFail(pointer.normalized, "does not resolve to a schema-allowed array item");
      if (final) {
        currentValue[childIndex] = cloneJson(value);
        return output;
      }
      currentValue = currentValue[childIndex];
      currentSchema = childSchema as Schema;
      continue;
    }
    validationFail(pointer.normalized, "has a non-container parent value");
  }
  return fail("overlapping_sweep_pointer", "The root pointer cannot be swept.");
};

const setDeclaredPointer = (input: JsonObject, pointer: ResolvedPointer, value: JsonValue): JsonObject => {
  const output = cloneJson(input);
  let current: JsonValue = output;
  for (let index = 0; index < pointer.tokens.length; index += 1) {
    const token = pointer.tokens[index]!;
    const final = index === pointer.tokens.length - 1;
    if (isPlainObject(current)) {
      if (final) {
        current[token] = cloneJson(value);
        return output;
      }
      if (!Object.hasOwn(current, token)) {
        fail("invalid_sample_plan", "A frozen sweep pointer has a missing parent value.");
      }
      current = current[token]!;
      continue;
    }
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/u.test(token)) {
        fail("invalid_sample_plan", "A frozen sweep pointer contains a non-canonical array index.");
      }
      const childIndex = Number(token);
      if (!Number.isSafeInteger(childIndex) || childIndex >= current.length) {
        fail("invalid_sample_plan", "A frozen sweep pointer does not resolve to an existing array item.");
      }
      if (final) {
        current[childIndex] = cloneJson(value);
        return output;
      }
      current = current[childIndex]!;
      continue;
    }
    fail("invalid_sample_plan", "A frozen sweep pointer has a non-container parent value.");
  }
  return fail("invalid_sample_plan", "The root pointer cannot be swept.");
};

const readDeclaredPointer = (input: JsonObject, pointer: ResolvedPointer): JsonValue => {
  let current: JsonValue = input;
  for (const token of pointer.tokens) {
    if (isPlainObject(current) && Object.hasOwn(current, token)) {
      current = current[token]!;
      continue;
    }
    if (Array.isArray(current) && /^(?:0|[1-9]\d*)$/u.test(token)) {
      const childIndex = Number(token);
      if (Number.isSafeInteger(childIndex) && childIndex < current.length) {
        current = current[childIndex]!;
        continue;
      }
    }
    return fail("invalid_sample_plan", "A normalized sweep pointer could not be read back.");
  }
  return cloneJson(current);
};

const dereference = (root: Schema, schema: Schema): Schema => {
  let current = schema;
  while (typeof current !== "boolean" && typeof current.$ref === "string") current = resolveReference(root, current.$ref);
  return current;
};

const objectChildSchema = (schema: Schema, key: string): Schema | typeof MISSING => {
  const resolved = schema;
  if (typeof resolved === "boolean") return resolved ? true : MISSING;
  if (isPlainObject(resolved.properties) && Object.hasOwn(resolved.properties, key)) return resolved.properties[key] as Schema;
  if (typeof resolved.additionalProperties === "boolean") return resolved.additionalProperties ? true : MISSING;
  if (isPlainObject(resolved.additionalProperties)) return resolved.additionalProperties as Schema;
  return MISSING;
};

const arrayChildSchema = (schema: Schema): Schema | typeof MISSING => {
  if (typeof schema === "boolean") return schema ? true : MISSING;
  if (typeof schema.items === "boolean" || isPlainObject(schema.items)) return schema.items as Schema;
  return MISSING;
};

const parsePointer = (
  value: unknown,
  allowRoot = false,
  errorCode = "overlapping_sweep_pointer",
): ResolvedPointer => {
  if (typeof value !== "string" || (!allowRoot && !value.startsWith("/")) || (allowRoot && value !== "" && !value.startsWith("/"))) {
    fail(errorCode, "JSON pointers must use RFC 6901 syntax.");
  }
  const pointerValue = value as string;
  if (pointerValue === "") return { normalized: "", tokens: [] };
  const tokens = pointerValue.slice(1).split("/").map((token) => {
    if (/~(?:[^01]|$)/u.test(token)) fail(errorCode, "JSON pointers must use canonical RFC 6901 escaping.");
    return token.replaceAll("~1", "/").replaceAll("~0", "~");
  });
  return { normalized: `/${tokens.map(escapeToken).join("/")}`, tokens };
};

const isTokenPrefix = (prefix: readonly string[], value: readonly string[]): boolean =>
  prefix.length <= value.length && prefix.every((token, index) => token === value[index]);

const escapeToken = (token: string): string => token.replaceAll("~", "~0").replaceAll("/", "~1");
const jsonEqual = (left: unknown, right: unknown): boolean => canonicalJsonV2(left).equals(canonicalJsonV2(right));
const isSha256 = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
const cloneJson = <T extends JsonValue>(value: T): T => JSON.parse(canonicalJsonV2(value).toString("utf8")) as T;

const valueHasType = (value: JsonValue, type: string): boolean => {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isPlainObject(value);
  if (type === "integer") return typeof value === "number" && Number.isSafeInteger(value);
  return typeof value === type;
};

const assertJson = (value: unknown, label: string): void => {
  try {
    canonicalJsonV2(value);
  } catch {
    fail("invalid_sample_plan", `${label} must be finite canonical JSON.`);
  }
};

const assertSchemaJson = (value: unknown, label: string): void => {
  try {
    canonicalJsonV2(value);
  } catch {
    schemaFail(`${label} must be finite canonical JSON.`);
  }
};

const assertSafeInteger = (value: unknown, label: string): void => {
  if (!Number.isSafeInteger(value)) fail("invalid_sample_plan", `${label} must be a safe integer.`);
};

const assertSafeKey = (key: string, label: string): void => {
  if (DANGEROUS_KEYS.has(key)) schemaFail(`${label} name is forbidden.`);
};

const exactRecord = (value: unknown, keys: readonly string[], label: string): Record<string, unknown> => {
  if (!isPlainObject(value) || Object.keys(value).sort().join("\n") !== [...keys].sort().join("\n")) {
    fail("invalid_sample_plan", `${label} must contain exactly ${keys.join(", ")}.`);
  }
  return value as Record<string, unknown>;
};

const isPlainObject = (value: unknown): value is Record<string, any> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
};

const validationFail = (path: string, reason: string): never =>
  fail("invalid_sample_plan", `Input at ${path} ${reason}.`, { path });

const schemaFail = (message: string): never => fail("input_schema_unsupported", message);

const fail = (code: string, message: string, details?: Record<string, unknown>): never => {
  throw new ApiError(400, code, message, details);
};
