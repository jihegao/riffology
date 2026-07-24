import { isAbsolute, normalize, resolve, sep } from "node:path";
import { canonicalDigest, parseCanonicalJsonV2, type CanonicalJson } from "./canonical-json-v2.ts";
import {
  INPUT_SCHEMA_PROFILE,
  normalizeInputParameters,
  validateInputSchema,
  type JsonObject,
} from "./experiment-planner.ts";

export { INPUT_SCHEMA_PROFILE };

export type ExecutionRunKindV2 = "batch" | "visual";
export type ExecutionOutputRoleV2 = "metric" | "table" | "document" | "data" | "diagnostic";

export type ExecutionOutputV2 = Readonly<{
  logicalName: string;
  relativePath: string;
  mediaType: string;
  required: boolean;
  role: ExecutionOutputRoleV2;
}>;

export type ExecutionDescriptionV2 = Readonly<{
  schemaVersion: 2;
  runtime: "python";
  runMode: "batch" | "visual" | "both";
  dependencyFile: string;
  inputs: Readonly<{
    schemaProfile: typeof INPUT_SCHEMA_PROFILE;
    schema: CanonicalJson;
    smoke: JsonObject;
  }>;
  outputs: readonly ExecutionOutputV2[];
  overview?: Readonly<{
    stepOrHorizonPointer?: string;
    metricNames?: readonly string[];
  }>;
  batch?: Readonly<{
    entryPoint: string;
    protocol: "riff-batch-v1";
    domainEvents?: Readonly<{
      relativePath: string;
      mediaType: "application/x-ndjson";
      role: "diagnostic";
      payloadSchema?: Readonly<{
        schemaProfile: typeof INPUT_SCHEMA_PROFILE;
        schema: CanonicalJson;
      }>;
    }>;
  }>;
  visual?: Readonly<{
    entryPoint: string;
    protocol: "riff-visual-v1";
    healthPath: string;
    structuredInspectionPath?: string;
    webSocket?: Readonly<{
      path: string;
      subprotocols: readonly string[];
      maxFrameBytes: number;
      maxConnections: number;
      idleTimeoutMs: number;
    }>;
  }>;
  cancellation: Readonly<{ signal: "SIGTERM"; graceMs: number }>;
}>;

export type BatchInputV1 = Readonly<{
  schemaVersion: 1;
  runId: string;
  sampleIndex: number;
  sampleId: string;
  parameters: JsonObject;
  seed: number | null;
}>;

export type ResolvedBatchOutputV1 = ExecutionOutputV2 & Readonly<{ absolutePath: string }>;

export class ExecutionProtocolV2Error extends Error {
  readonly code: "execution_protocol_upgrade_required" | "capability_not_declared" | "invalid_batch_input";

  constructor(code: ExecutionProtocolV2Error["code"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ExecutionProtocolV2Error";
    this.code = code;
  }
}

export const validateExecutionDescriptionV2 = (input: unknown): ExecutionDescriptionV2 => {
  try {
    const description = exactRecord(input, [
      "schemaVersion", "runtime", "runMode", "dependencyFile", "inputs", "outputs", "cancellation",
    ], ["overview", "batch", "visual"], "execution description");
    if (description.schemaVersion !== 2 || description.runtime !== "python"
      || !["batch", "visual", "both"].includes(String(description.runMode))) {
      invalidDescription("The copied execution description is not an execution-description v2 Python contract.");
    }

    const dependencyFile = ownedRelativePath(description.dependencyFile, "dependencyFile");
    if (!dependencyFile.startsWith("environment/")) {
      invalidDescription("The dependency file must be owned by the environment section.");
    }

    const rawInputs = exactRecord(description.inputs, ["schemaProfile", "schema", "smoke"], [], "inputs");
    if (rawInputs.schemaProfile !== INPUT_SCHEMA_PROFILE || !plainRecord(rawInputs.smoke)) {
      invalidDescription("The copied input schema profile is unsupported.");
    }
    validateInputSchema(rawInputs.schema);
    const normalizedSmoke = normalizeInputParameters(rawInputs.schema, rawInputs.smoke);
    if (canonicalDigest(normalizedSmoke) !== canonicalDigest(rawInputs.smoke as JsonObject)) {
      invalidDescription("The copied smoke input must already contain its canonical defaulted values.");
    }

    if (!Array.isArray(description.outputs) || description.outputs.length < 1 || description.outputs.length > 64) {
      invalidDescription("The execution description requires one through 64 declared outputs.");
    }
    const outputNames = new Set<string>();
    const outputPaths = new Set<string>();
    const outputs = description.outputs.map((value, index): ExecutionOutputV2 => {
      const output = exactRecord(value, ["logicalName", "relativePath", "mediaType", "required", "role"], [], `output ${index}`);
      const logicalName = boundedToken(output.logicalName, 128, `output ${index} logicalName`);
      const relativePath = ownedRelativePath(output.relativePath, `output ${index} relativePath`);
      const mediaType = boundedText(output.mediaType, 200, `output ${index} mediaType`);
      if (typeof output.required !== "boolean"
        || !["metric", "table", "document", "data", "diagnostic"].includes(String(output.role))
        || outputNames.has(logicalName)
        || outputPaths.has(relativePath)) {
        invalidDescription("Output declarations must have unique names and paths with a supported role.");
      }
      outputNames.add(logicalName);
      outputPaths.add(relativePath);
      return Object.freeze({
        logicalName,
        relativePath,
        mediaType,
        required: output.required,
        role: output.role as ExecutionOutputRoleV2,
      });
    });

    const runMode = description.runMode as ExecutionDescriptionV2["runMode"];
    const needsBatch = runMode === "batch" || runMode === "both";
    const needsVisual = runMode === "visual" || runMode === "both";
    if (needsBatch !== Object.hasOwn(description, "batch") || needsVisual !== Object.hasOwn(description, "visual")) {
      invalidDescription("The copied execution capability declaration is invalid.");
    }

    const batch = needsBatch ? validateBatchCapability(description.batch) : undefined;
    const visual = needsVisual ? validateVisualCapability(description.visual) : undefined;
    const cancellation = validateCancellation(description.cancellation);
    const overview = Object.hasOwn(description, "overview") ? validateOverview(description.overview) : undefined;

    return deepFreeze({
      schemaVersion: 2,
      runtime: "python",
      runMode,
      dependencyFile,
      inputs: {
        schemaProfile: INPUT_SCHEMA_PROFILE,
        schema: cloneCanonical(rawInputs.schema, "input schema"),
        smoke: cloneCanonical(normalizedSmoke, "smoke input") as JsonObject,
      },
      outputs,
      ...(overview ? { overview } : {}),
      ...(batch ? { batch } : {}),
      ...(visual ? { visual } : {}),
      cancellation,
    });
  } catch (error) {
    if (error instanceof ExecutionProtocolV2Error) throw error;
    throw new ExecutionProtocolV2Error(
      "execution_protocol_upgrade_required",
      "The copied execution description does not satisfy execution-description v2.",
      { cause: error },
    );
  }
};

export const assertRunCapabilityV2 = (
  description: ExecutionDescriptionV2,
  runKind: ExecutionRunKindV2,
): void => {
  if ((runKind === "batch" && !description.batch) || (runKind === "visual" && !description.visual)) {
    throw new ExecutionProtocolV2Error(
      "capability_not_declared",
      `The execution description does not declare ${runKind} capability.`,
    );
  }
};

export const batchSampleIdV1 = (parameters: JsonObject, seed: number | null): string => {
  try {
    assertSeed(seed);
    return canonicalDigest({ schemaVersion: 1, parameters: cloneCanonical(parameters, "batch parameters"), seed });
  } catch (error) {
    if (error instanceof ExecutionProtocolV2Error && error.code === "invalid_batch_input") throw error;
    throw new ExecutionProtocolV2Error("invalid_batch_input", "The batch sample preimage is invalid.", { cause: error });
  }
};

export const createBatchInputV1 = (input: Readonly<{
  runId: string;
  sampleIndex: number;
  parameters: JsonObject;
  seed: number | null;
}>): BatchInputV1 => validateBatchInputV1({
  schemaVersion: 1,
  runId: input.runId,
  sampleIndex: input.sampleIndex,
  sampleId: batchSampleIdV1(input.parameters, input.seed),
  parameters: input.parameters,
  seed: input.seed,
});

export const validateBatchInputV1 = (input: unknown): BatchInputV1 => {
  try {
    const value = exactRecord(input, [
      "schemaVersion", "runId", "sampleIndex", "sampleId", "parameters", "seed",
    ], [], "batch input");
    if (value.schemaVersion !== 1 || typeof value.runId !== "string"
      || value.runId.length < 3 || value.runId.length > 128 || /[\u0000-\u001f\u007f]/u.test(value.runId)
      || !Number.isSafeInteger(value.sampleIndex) || Number(value.sampleIndex) < 0
      || typeof value.sampleId !== "string" || !/^[0-9a-f]{64}$/u.test(value.sampleId)
      || !plainRecord(value.parameters)) {
      invalidBatchInput("The riff-batch-v1 input envelope is invalid.");
    }
    assertSeed(value.seed);
    const parameters = cloneCanonical(value.parameters, "batch parameters") as JsonObject;
    const seed = value.seed === null ? null : Object.is(value.seed, -0) ? 0 : value.seed as number;
    const expectedSampleId = batchSampleIdV1(parameters, seed);
    if (value.sampleId !== expectedSampleId) {
      invalidBatchInput("The batch sample ID does not match its canonical parameters and seed.");
    }
    return deepFreeze({
      schemaVersion: 1,
      runId: value.runId,
      sampleIndex: value.sampleIndex as number,
      sampleId: value.sampleId,
      parameters,
      seed,
    });
  } catch (error) {
    if (error instanceof ExecutionProtocolV2Error && error.code === "invalid_batch_input") throw error;
    throw new ExecutionProtocolV2Error("invalid_batch_input", "The riff-batch-v1 input envelope is invalid.", { cause: error });
  }
};

export const batchProcessArguments = (
  description: ExecutionDescriptionV2,
  inputPath: string,
  outputDirectory: string,
): readonly string[] => {
  assertRunCapabilityV2(description, "batch");
  const input = absoluteScratchPath(inputPath, "batch input path");
  const output = absoluteScratchPath(outputDirectory, "batch output directory");
  return Object.freeze([
    description.batch!.entryPoint,
    "--riff-input",
    input,
    "--riff-output-dir",
    output,
  ]);
};

export const resolveBatchOutputPathsV1 = (
  description: ExecutionDescriptionV2,
  outputDirectory: string,
): readonly ResolvedBatchOutputV1[] => {
  assertRunCapabilityV2(description, "batch");
  const root = absoluteScratchPath(outputDirectory, "batch output directory");
  return Object.freeze(description.outputs.map((output) => Object.freeze({
    ...output,
    absolutePath: resolve(root, ...output.relativePath.split("/")),
  })));
};

const validateBatchCapability = (input: unknown): NonNullable<ExecutionDescriptionV2["batch"]> => {
  const batch = exactRecord(input, ["entryPoint", "protocol"], ["domainEvents"], "batch capability");
  if (batch.protocol !== "riff-batch-v1") invalidDescription("The copied execution capability declaration is invalid.");
  const entryPoint = ownedRelativePath(batch.entryPoint, "batch entryPoint");
  if (!entryPoint.startsWith("code/")) invalidDescription("The batch entry point must be owned by the code section.");
  if (!Object.hasOwn(batch, "domainEvents")) return Object.freeze({ entryPoint, protocol: "riff-batch-v1" });
  const events = exactRecord(batch.domainEvents, ["relativePath", "mediaType", "role"], ["payloadSchema"], "batch domainEvents");
  if (events.mediaType !== "application/x-ndjson" || events.role !== "diagnostic") {
    invalidDescription("Batch domain events require the declared diagnostic NDJSON contract.");
  }
  let payloadSchema: NonNullable<NonNullable<ExecutionDescriptionV2["batch"]>["domainEvents"]>["payloadSchema"];
  if (Object.hasOwn(events, "payloadSchema")) {
    const payload = exactRecord(events.payloadSchema, ["schemaProfile", "schema"], [], "domain event payloadSchema");
    if (payload.schemaProfile !== INPUT_SCHEMA_PROFILE) invalidDescription("The domain-event schema profile is unsupported.");
    validateInputSchema(payload.schema);
    payloadSchema = Object.freeze({
      schemaProfile: INPUT_SCHEMA_PROFILE,
      schema: cloneCanonical(payload.schema, "domain-event schema"),
    });
  }
  return deepFreeze({
    entryPoint,
    protocol: "riff-batch-v1",
    domainEvents: {
      relativePath: ownedRelativePath(events.relativePath, "domain events relativePath"),
      mediaType: "application/x-ndjson",
      role: "diagnostic",
      ...(payloadSchema ? { payloadSchema } : {}),
    },
  });
};

const validateVisualCapability = (input: unknown): NonNullable<ExecutionDescriptionV2["visual"]> => {
  const visual = exactRecord(input, ["entryPoint", "protocol", "healthPath"], ["structuredInspectionPath", "webSocket"], "visual capability");
  if (visual.protocol !== "riff-visual-v1") invalidDescription("The visual protocol must be riff-visual-v1.");
  const entryPoint = ownedRelativePath(visual.entryPoint, "visual entryPoint");
  if (!entryPoint.startsWith("code/")) invalidDescription("The visual entry point must be owned by the code section.");
  const healthPath = sameOriginPath(visual.healthPath, "visual healthPath");
  const structuredInspectionPath = Object.hasOwn(visual, "structuredInspectionPath")
    ? sameOriginPath(visual.structuredInspectionPath, "visual structuredInspectionPath")
    : undefined;
  let webSocket: NonNullable<NonNullable<ExecutionDescriptionV2["visual"]>["webSocket"]> | undefined;
  if (Object.hasOwn(visual, "webSocket")) {
    const socket = exactRecord(visual.webSocket, [
      "path", "subprotocols", "maxFrameBytes", "maxConnections", "idleTimeoutMs",
    ], [], "visual webSocket");
    if (!Array.isArray(socket.subprotocols) || socket.subprotocols.length > 8
      || socket.subprotocols.some((value) => typeof value !== "string" || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,128}$/u.test(value))
      || new Set(socket.subprotocols).size !== socket.subprotocols.length) {
      invalidDescription("Visual WebSocket subprotocols are invalid.");
    }
    boundedInteger(socket.maxFrameBytes, 1, 1_048_576, "maxFrameBytes");
    boundedInteger(socket.maxConnections, 1, 8, "maxConnections");
    boundedInteger(socket.idleTimeoutMs, 1_000, 300_000, "idleTimeoutMs");
    webSocket = Object.freeze({
      path: sameOriginPath(socket.path, "visual webSocket path"),
      subprotocols: Object.freeze([...socket.subprotocols] as string[]),
      maxFrameBytes: socket.maxFrameBytes as number,
      maxConnections: socket.maxConnections as number,
      idleTimeoutMs: socket.idleTimeoutMs as number,
    });
  }
  return deepFreeze({
    entryPoint,
    protocol: "riff-visual-v1",
    healthPath,
    ...(structuredInspectionPath ? { structuredInspectionPath } : {}),
    ...(webSocket ? { webSocket } : {}),
  });
};

const validateCancellation = (input: unknown): ExecutionDescriptionV2["cancellation"] => {
  const cancellation = exactRecord(input, ["signal", "graceMs"], [], "cancellation");
  if (cancellation.signal !== "SIGTERM") invalidDescription("The cancellation signal must be SIGTERM.");
  boundedInteger(cancellation.graceMs, 1, 300_000, "cancellation graceMs");
  return Object.freeze({ signal: "SIGTERM", graceMs: cancellation.graceMs as number });
};

const validateOverview = (input: unknown): NonNullable<ExecutionDescriptionV2["overview"]> => {
  const overview = exactRecord(input, [], ["stepOrHorizonPointer", "metricNames"], "overview");
  const stepOrHorizonPointer = Object.hasOwn(overview, "stepOrHorizonPointer")
    ? jsonPointer(overview.stepOrHorizonPointer)
    : undefined;
  let metricNames: readonly string[] | undefined;
  if (Object.hasOwn(overview, "metricNames")) {
    if (!Array.isArray(overview.metricNames) || overview.metricNames.length > 64) invalidDescription("Overview metric names are invalid.");
    const values = overview.metricNames.map((value) => boundedToken(value, 128, "overview metric name"));
    if (new Set(values).size !== values.length) invalidDescription("Overview metric names must be unique.");
    metricNames = Object.freeze(values);
  }
  return Object.freeze({
    ...(stepOrHorizonPointer !== undefined ? { stepOrHorizonPointer } : {}),
    ...(metricNames ? { metricNames } : {}),
  });
};

const exactRecord = (
  input: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): Record<string, unknown> => {
  if (!plainRecord(input)) invalidDescription(`The ${label} must be a plain object.`);
  const keys = Object.keys(input);
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(input, key)) || keys.some((key) => !allowed.has(key))) {
    invalidDescription(`The ${label} fields do not match the versioned contract.`);
  }
  return input;
};

const ownedRelativePath = (input: unknown, label: string): string => {
  if (typeof input !== "string" || !input || input.length > 1024 || input.startsWith("/")
    || input.includes("\\") || /[\u0000-\u001f\u007f]/u.test(input) || input.includes("?") || input.includes("#")
    || normalize(input) !== input || input.split("/").some((part) => !part || part === "." || part === "..")) {
    invalidDescription(`The ${label} is not a safe relative path.`);
  }
  return input;
};

const absoluteScratchPath = (input: string, label: string): string => {
  if (typeof input !== "string" || !isAbsolute(input) || input.length > 4096 || input.includes("\0")
    || /[\u0000-\u001f\u007f]/u.test(input) || normalize(input) !== input || input === sep) {
    throw new ExecutionProtocolV2Error("invalid_batch_input", `The ${label} is not an application-owned absolute path.`);
  }
  return input;
};

const sameOriginPath = (input: unknown, label: string): string => {
  if (typeof input !== "string" || !input.startsWith("/") || input.startsWith("//")
    || input.includes("?") || input.includes("#") || input.includes("\\") || /[\u0000-\u001f\u007f]/u.test(input)
    || normalize(input) !== input) {
    invalidDescription(`The ${label} is not an exact same-origin path.`);
  }
  return input;
};

const jsonPointer = (input: unknown): string => {
  if (typeof input !== "string" || input.length > 1024 || (input !== "" && !input.startsWith("/"))
    || /~(?:[^01]|$)/u.test(input)) invalidDescription("The overview JSON Pointer is invalid.");
  return input;
};

const boundedToken = (input: unknown, max: number, label: string): string => {
  if (typeof input !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(input) || input.length > max) {
    invalidDescription(`The ${label} is invalid.`);
  }
  return input;
};

const boundedText = (input: unknown, max: number, label: string): string => {
  if (typeof input !== "string" || !input.trim() || input.length > max || /[\u0000-\u001f\u007f]/u.test(input)) {
    invalidDescription(`The ${label} is invalid.`);
  }
  return input;
};

const boundedInteger = (input: unknown, min: number, max: number, label: string): void => {
  if (!Number.isSafeInteger(input) || Number(input) < min || Number(input) > max) {
    invalidDescription(`The ${label} is outside the supported range.`);
  }
};

const assertSeed = (input: unknown): void => {
  if (input !== null && !Number.isSafeInteger(input)) invalidBatchInput("The batch seed must be a safe integer or null.");
};

const cloneCanonical = (input: unknown, label: string): CanonicalJson => {
  try {
    return parseCanonicalJsonV2(JSON.stringify(input));
  } catch (error) {
    invalidDescription(`The ${label} is not canonical JSON.`, error);
  }
};

const plainRecord = (input: unknown): input is Record<string, unknown> =>
  input !== null && typeof input === "object" && !Array.isArray(input)
  && [Object.prototype, null].includes(Object.getPrototypeOf(input));

const deepFreeze = <T>(input: T): T => {
  if (input && typeof input === "object" && !Object.isFrozen(input)) {
    for (const value of Object.values(input)) deepFreeze(value);
    Object.freeze(input);
  }
  return input;
};

const invalidDescription = (message: string, cause?: unknown): never => {
  throw new ExecutionProtocolV2Error("execution_protocol_upgrade_required", message, cause === undefined ? undefined : { cause });
};

const invalidBatchInput = (message: string): never => {
  throw new ExecutionProtocolV2Error("invalid_batch_input", message);
};
