import { canonicalDigest, canonicalJsonV2, parseCanonicalJsonV2, type CanonicalJson } from "./canonical-json-v2.ts";
import {
  INPUT_SCHEMA_PROFILE,
  normalizeInputParameters,
  validateInputSchema,
  type JsonObject,
} from "./experiment-planner.ts";
import { PRODUCT_DIAGNOSTIC_EVENT_LIMITS } from "./product-run-limits.ts";

/**
 * The parser deliberately knows nothing about a Run, a filesystem path, or a
 * database transaction.  It turns one already-captured diagnostic artifact
 * into immutable candidates; admission and atomic publication remain the
 * caller's responsibility.
 */
export type DiagnosticEventPayloadSchema = Readonly<{
  schemaProfile: typeof INPUT_SCHEMA_PROFILE;
  schema: CanonicalJson;
}>;

export type DiagnosticEventParseLimits = Readonly<{
  maxEventCount: number;
  maxEventBytes: number;
  maxRecordBytes: number;
  maxDepth: number;
  maxObjectKeys: number;
  maxArrayItems: number;
  maxStringBytes: number;
}>;

export type DiagnosticEventCandidate = Readonly<{
  sourceOrdinal: number;
  type: string;
  occurredAt: string | null;
  payload: JsonObject | readonly CanonicalJson[];
  payloadDigest: string;
  byteCount: number;
}>;

export type ParsedDiagnosticEventSet = Readonly<{
  events: readonly DiagnosticEventCandidate[];
  eventCount: number;
  totalBytes: number;
  /** SHA-256 of the ordered canonical semantic event candidates, not raw whitespace. */
  eventSetDigest: string;
}>;

export class DiagnosticEventParseError extends Error {
  readonly code: "invalid_diagnostic_events" | "run_event_count_limit" | "run_event_byte_limit";

  constructor(
    code: DiagnosticEventParseError["code"],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DiagnosticEventParseError";
    this.code = code;
  }
}

export const DEFAULT_DIAGNOSTIC_EVENT_PARSE_LIMITS: DiagnosticEventParseLimits = Object.freeze({
  ...PRODUCT_DIAGNOSTIC_EVENT_LIMITS,
  maxRecordBytes: 1_048_576,
  maxDepth: 32,
  maxObjectKeys: 128,
  maxArrayItems: 1_024,
  maxStringBytes: 16_384,
});

/**
 * Parses one complete diagnostic NDJSON file.  The input must be the exact
 * bytes captured from the child; it is not a streaming parser and therefore
 * cannot itself make publication atomic across multiple samples.
 */
export const parseDiagnosticEventNdjson = (
  input: Uint8Array,
  options: Readonly<{
    limits?: Partial<DiagnosticEventParseLimits>;
    payloadSchema?: DiagnosticEventPayloadSchema | null;
  }> = {},
): ParsedDiagnosticEventSet => {
  const limits = resolveLimits(options.limits);
  const bytes = Buffer.from(input);
  if (bytes.byteLength === 0) {
    throw failure("invalid_diagnostic_events", "Diagnostic NDJSON must contain at least one LF-terminated record.");
  }
  if (bytes.byteLength > limits.maxEventBytes) {
    throw failure("run_event_byte_limit", "Diagnostic event bytes exceed the frozen run limit.");
  }
  if (containsUtf8Bom(bytes)) {
    throw failure("invalid_diagnostic_events", "Diagnostic NDJSON must not begin with a UTF-8 BOM.");
  }
  if (bytes.includes(0x0d) || bytes.at(-1) !== 0x0a) {
    throw failure("invalid_diagnostic_events", "Diagnostic NDJSON must use LF records and end with one LF.");
  }

  const payloadSchema = resolvePayloadSchema(options.payloadSchema);
  const events: DiagnosticEventCandidate[] = [];
  let start = 0;
  let ordinal = 0;
  for (let cursor = 0; cursor < bytes.byteLength; cursor += 1) {
    if (bytes[cursor] !== 0x0a) continue;
    const line = bytes.subarray(start, cursor);
    start = cursor + 1;
    if (line.byteLength === 0) throw failure("invalid_diagnostic_events", "Diagnostic NDJSON cannot contain blank records.");
    if (line.byteLength > limits.maxRecordBytes) throw failure("run_event_byte_limit", "A diagnostic event record exceeds the byte limit.");
    if (events.length >= limits.maxEventCount) throw failure("run_event_count_limit", "Diagnostic event count exceeds the frozen run limit.");

    const value = parseLine(line, ordinal);
    assertStructuralBounds(value, limits, 0);
    const envelope = exactEnvelope(value, ordinal);
    const type = eventType(envelope.type, limits, ordinal);
    const occurredAt = eventTimestamp(envelope.occurredAt, ordinal);
    const rawPayload = eventPayload(envelope.payload, ordinal);
    const payload = payloadSchema
      ? normalizeSchemaPayload(payloadSchema, rawPayload, ordinal)
      : immutableClone(rawPayload) as JsonObject | readonly CanonicalJson[];
    // The normalized schema payload can carry a default, so bound it too.
    assertStructuralBounds(payload, limits, 0);
    events.push(Object.freeze({
      sourceOrdinal: ordinal,
      type,
      occurredAt,
      payload,
      payloadDigest: canonicalDigest(payload),
      byteCount: line.byteLength,
    }));
    ordinal += 1;
  }

  // A final LF always closes the final record. This also guards future edits
  // that might accidentally accept a trailing partial record.
  if (start !== bytes.byteLength) throw failure("invalid_diagnostic_events", "Diagnostic NDJSON has an unterminated record.");
  const frozenEvents = Object.freeze(events);
  const eventSetDigest = canonicalDigest(frozenEvents.map((event) => ({
    sourceOrdinal: event.sourceOrdinal,
    type: event.type,
    occurredAt: event.occurredAt,
    payload: event.payload,
  })));
  return Object.freeze({
    events: frozenEvents,
    eventCount: frozenEvents.length,
    totalBytes: bytes.byteLength,
    eventSetDigest,
  });
};

const resolveLimits = (input: Partial<DiagnosticEventParseLimits> | undefined): DiagnosticEventParseLimits => {
  const limits = {
    ...DEFAULT_DIAGNOSTIC_EVENT_PARSE_LIMITS,
    ...input,
    // A caller commonly supplies only its frozen run byte limit. Keep the
    // per-record default bounded by it without making that ordinary use an
    // invalid parser configuration.
    maxRecordBytes: input?.maxRecordBytes ?? Math.min(
      DEFAULT_DIAGNOSTIC_EVENT_PARSE_LIMITS.maxRecordBytes,
      input?.maxEventBytes ?? DEFAULT_DIAGNOSTIC_EVENT_PARSE_LIMITS.maxEventBytes,
    ),
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw failure("invalid_diagnostic_events", `Diagnostic parser limit ${name} must be a positive safe integer.`);
    }
  }
  if (limits.maxRecordBytes > limits.maxEventBytes) {
    throw failure("invalid_diagnostic_events", "Diagnostic record byte limit cannot exceed the total event byte limit.");
  }
  return Object.freeze(limits);
};

const resolvePayloadSchema = (
  value: DiagnosticEventPayloadSchema | null | undefined,
): DiagnosticEventPayloadSchema | null => {
  if (value === undefined || value === null) return null;
  if (!plainRecord(value) || Object.keys(value).sort().join("\n") !== ["schema", "schemaProfile"].join("\n")
    || value.schemaProfile !== INPUT_SCHEMA_PROFILE) {
    throw failure("invalid_diagnostic_events", "Diagnostic payload schema declaration is invalid.");
  }
  try {
    validateInputSchema(value.schema);
    return Object.freeze({
      schemaProfile: INPUT_SCHEMA_PROFILE,
      schema: immutableClone(value.schema) as CanonicalJson,
    });
  } catch (error) {
    throw failure("invalid_diagnostic_events", "Diagnostic payload schema is not in the closed profile.", error);
  }
};

const parseLine = (line: Uint8Array, ordinal: number): CanonicalJson => {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(line);
  } catch (error) {
    throw failure("invalid_diagnostic_events", `Diagnostic event ${ordinal} is not strict UTF-8.`, error);
  }
  try {
    // parseCanonicalJsonV2 rejects duplicate/dangerous keys, invalid Unicode,
    // non-finite values, and unsafe integer values before canonicalization.
    return parseCanonicalJsonV2(text);
  } catch (error) {
    throw failure("invalid_diagnostic_events", `Diagnostic event ${ordinal} is not valid bounded JSON.`, error);
  }
};

const exactEnvelope = (value: CanonicalJson, ordinal: number): Record<string, CanonicalJson> => {
  if (!plainRecord(value)) throw failure("invalid_diagnostic_events", `Diagnostic event ${ordinal} envelope must be an object.`);
  const keys = Object.keys(value).sort();
  const expected = Object.hasOwn(value, "occurredAt") ? ["occurredAt", "payload", "type"] : ["payload", "type"];
  if (keys.join("\n") !== expected.join("\n")) {
    throw failure("invalid_diagnostic_events", `Diagnostic event ${ordinal} envelope keys are not exact.`);
  }
  return value;
};

const eventType = (value: CanonicalJson, limits: DiagnosticEventParseLimits, ordinal: number): string => {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 128
    || Buffer.byteLength(value, "utf8") > limits.maxStringBytes
    || !/^[A-Za-z][A-Za-z0-9._:-]*$/u.test(value)) {
    throw failure("invalid_diagnostic_events", `Diagnostic event ${ordinal} type is invalid.`);
  }
  return value;
};

const eventTimestamp = (value: CanonicalJson | undefined, ordinal: number): string | null => {
  if (value === undefined) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    throw failure("invalid_diagnostic_events", `Diagnostic event ${ordinal} occurredAt must be an exact UTC ISO instant.`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw failure("invalid_diagnostic_events", `Diagnostic event ${ordinal} occurredAt is invalid.`);
  }
  return value;
};

const eventPayload = (value: CanonicalJson, ordinal: number): JsonObject | readonly CanonicalJson[] => {
  if (!plainRecord(value) && !Array.isArray(value)) {
    throw failure("invalid_diagnostic_events", `Diagnostic event ${ordinal} payload must be an object or array.`);
  }
  return value as JsonObject | readonly CanonicalJson[];
};

const normalizeSchemaPayload = (
  declaration: DiagnosticEventPayloadSchema,
  payload: JsonObject | readonly CanonicalJson[],
  ordinal: number,
): JsonObject => {
  if (!plainRecord(payload)) {
    throw failure("invalid_diagnostic_events", `Diagnostic event ${ordinal} payload must be an object for its declared schema.`);
  }
  try {
    return normalizeInputParameters(declaration.schema, payload);
  } catch (error) {
    throw failure("invalid_diagnostic_events", `Diagnostic event ${ordinal} payload does not satisfy its declared schema.`, error);
  }
};

const assertStructuralBounds = (value: CanonicalJson, limits: DiagnosticEventParseLimits, depth: number): void => {
  if (depth > limits.maxDepth) throw failure("invalid_diagnostic_events", "Diagnostic event nesting depth exceeds the limit.");
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > limits.maxStringBytes) {
      throw failure("invalid_diagnostic_events", "Diagnostic event string exceeds the limit.");
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > limits.maxArrayItems) throw failure("invalid_diagnostic_events", "Diagnostic event array width exceeds the limit.");
    for (const item of value) assertStructuralBounds(item, limits, depth + 1);
    return;
  }
  if (plainRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length > limits.maxObjectKeys) throw failure("invalid_diagnostic_events", "Diagnostic event object width exceeds the limit.");
    for (const [key, item] of entries) {
      if (Buffer.byteLength(key, "utf8") > limits.maxStringBytes) {
        throw failure("invalid_diagnostic_events", "Diagnostic event object key exceeds the string limit.");
      }
      assertStructuralBounds(item, limits, depth + 1);
    }
  }
};

const immutableClone = (value: CanonicalJson): CanonicalJson => deepFreeze(
  parseCanonicalJsonV2(canonicalJsonV2(value).toString("utf8")),
);

const plainRecord = (value: unknown): value is Record<string, CanonicalJson> => {
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

const containsUtf8Bom = (bytes: Uint8Array): boolean => {
  for (let index = 0; index + 2 < bytes.byteLength; index += 1) {
    if (bytes[index] === 0xef && bytes[index + 1] === 0xbb && bytes[index + 2] === 0xbf) return true;
  }
  return false;
};

const failure = (
  code: DiagnosticEventParseError["code"],
  message: string,
  cause?: unknown,
): DiagnosticEventParseError => new DiagnosticEventParseError(code, message, cause === undefined ? undefined : { cause });
