import { createHmac, timingSafeEqual } from "node:crypto";
import {
  canonicalJsonV2,
  parseCanonicalJsonV2,
  type CanonicalJson,
} from "./canonical-json-v2.ts";

const CURSOR_VERSION = 1;
const SECRET_BYTES = 32;
const SIGNATURE_BYTES = 32;
const SIGNATURE_CHARACTERS = 43;
const MAX_CURSOR_CHARACTERS = 2_048;
const MAX_PAYLOAD_BYTES = 1_536;
const MAX_IDENTIFIER_BYTES = 256;
const MAX_EVENT_TYPES = 32;
const MAX_SAMPLE_INDEXES = 256;
const MAX_EVENT_TYPE_BYTES = 128;
const MAX_PAGE_LIMIT = 100;
const DEFAULT_TTL_MS = 15 * 60_000;
const MAX_TTL_MS = 24 * 60 * 60_000;
const SIGNING_DOMAIN = Buffer.from("riff-diagnostic-event-cursor-v1\0", "utf8");
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const EXACT_PAYLOAD_KEYS = Object.freeze([
  "c", "d", "e", "f", "g", "i", "k", "l", "n", "p", "r", "v", "x",
]);
const EXACT_FILTER_KEYS = Object.freeze(["a", "s", "t", "z"]);

export const DIAGNOSTIC_EVENT_CURSOR_VERSION = CURSOR_VERSION;
export const DIAGNOSTIC_EVENT_CURSOR_MAX_CHARACTERS = MAX_CURSOR_CHARACTERS;

export type DiagnosticEventCursorDirection = "forward" | "backward";

export type DiagnosticEventCursorFilters = Readonly<{
  types?: readonly string[];
  sampleIndexes?: readonly number[];
  occurredAtFrom?: string | null;
  occurredAtTo?: string | null;
}>;

export type NormalizedDiagnosticEventCursorFilters = Readonly<{
  types: readonly string[];
  sampleIndexes: readonly number[];
  occurredAtFrom: string | null;
  occurredAtTo: string | null;
}>;

export type DiagnosticEventCursorContext = Readonly<{
  projectId: string;
  runId: string;
  frozenContractDigest: string;
  eventSetDigest: string;
  lifecycleDigest: string;
  direction: DiagnosticEventCursorDirection;
  filters: DiagnosticEventCursorFilters;
  limit: number;
}>;

export type DiagnosticEventCursorIssue = DiagnosticEventCursorContext & Readonly<{
  nextSequence: number;
  ttlMs?: number;
}>;

export type DiagnosticEventCursorClaims = Readonly<{
  version: typeof CURSOR_VERSION;
  keyEpoch: number;
  projectId: string;
  runId: string;
  frozenContractDigest: string;
  eventSetDigest: string;
  lifecycleDigest: string;
  nextSequence: number;
  direction: DiagnosticEventCursorDirection;
  filters: NormalizedDiagnosticEventCursorFilters;
  limit: number;
  issuedAtMs: number;
  expiresAtMs: number;
}>;

export type DiagnosticEventCursorCodecOptions = Readonly<{
  secret: Uint8Array;
  keyEpoch: number;
  now?: () => number;
  defaultTtlMs?: number;
}>;

export class DiagnosticEventCursorError extends Error {
  readonly code = "invalid_diagnostic_event_cursor";

  constructor() {
    super("The diagnostic event cursor is invalid.");
    this.name = "DiagnosticEventCursorError";
  }
}

type CursorPayload = Readonly<{
  v: number;
  k: number;
  p: string;
  r: string;
  c: string;
  e: string;
  g: string;
  n: number;
  d: DiagnosticEventCursorDirection;
  f: Readonly<{
    t: readonly string[];
    s: readonly number[];
    a: string | null;
    z: string | null;
  }>;
  l: number;
  i: number;
  x: number;
}>;

export class DiagnosticEventCursorCodec {
  readonly #secret: Buffer;
  readonly #keyEpoch: number;
  readonly #now: () => number;
  readonly #defaultTtlMs: number;

  constructor(options: DiagnosticEventCursorCodecOptions) {
    if (!(options.secret instanceof Uint8Array) || options.secret.byteLength !== SECRET_BYTES) {
      throw new TypeError("Diagnostic event cursor secret must contain exactly 32 bytes.");
    }
    this.#secret = Buffer.from(options.secret);
    this.#keyEpoch = positiveSafeInteger(options.keyEpoch, "keyEpoch");
    this.#now = options.now ?? Date.now;
    this.#defaultTtlMs = validTtl(options.defaultTtlMs ?? DEFAULT_TTL_MS);
  }

  issue(input: DiagnosticEventCursorIssue): string {
    const context = normalizeContext(input);
    const nextSequence = nonnegativeSafeInteger(input.nextSequence, "nextSequence");
    const issuedAtMs = nonnegativeSafeInteger(this.#now(), "current time");
    const ttlMs = validTtl(input.ttlMs ?? this.#defaultTtlMs);
    const expiresAtMs = issuedAtMs + ttlMs;
    if (!Number.isSafeInteger(expiresAtMs)) {
      throw new RangeError("Diagnostic event cursor expiry is outside the safe integer range.");
    }
    const payload = payloadFrom(context, {
      version: CURSOR_VERSION,
      keyEpoch: this.#keyEpoch,
      nextSequence,
      issuedAtMs,
      expiresAtMs,
    });
    const payloadBytes = canonicalJsonV2(payload);
    if (payloadBytes.byteLength > MAX_PAYLOAD_BYTES) {
      throw new RangeError("Diagnostic event cursor payload exceeds the byte limit.");
    }
    const token = `${payloadBytes.toString("base64url")}.${this.#mac(payloadBytes).toString("base64url")}`;
    if (token.length > MAX_CURSOR_CHARACTERS) {
      throw new RangeError("Diagnostic event cursor exceeds the encoded size limit.");
    }
    return token;
  }

  verify(token: string, expected: DiagnosticEventCursorContext): DiagnosticEventCursorClaims {
    try {
      const expectedContext = normalizeContext(expected);
      const payloadBytes = decodeToken(token, (payload, signature) => this.#verifyMac(payload, signature));
      const payload = parsePayload(payloadBytes);
      const now = nonnegativeSafeInteger(this.#now(), "current time");
      validatePayload(payload, this.#keyEpoch, now);
      const actualContext = contextFromPayload(payload);
      if (!sameContext(actualContext, expectedContext)) throw new DiagnosticEventCursorError();
      return Object.freeze({
        version: CURSOR_VERSION,
        keyEpoch: payload.k,
        projectId: payload.p,
        runId: payload.r,
        frozenContractDigest: payload.c,
        eventSetDigest: payload.e,
        lifecycleDigest: payload.g,
        nextSequence: payload.n,
        direction: payload.d,
        filters: actualContext.filters,
        limit: payload.l,
        issuedAtMs: payload.i,
        expiresAtMs: payload.x,
      });
    } catch {
      throw new DiagnosticEventCursorError();
    }
  }

  #mac(payload: Uint8Array): Buffer {
    return createHmac("sha256", this.#secret)
      .update(SIGNING_DOMAIN)
      .update(payload)
      .digest();
  }

  /** Verify a token MAC before parsing any attacker-controlled JSON. */
  #verifyMac(payload: Uint8Array, encodedSignature: string): void {
    const signature = strictBase64url(encodedSignature, SIGNATURE_BYTES);
    const expected = this.#mac(payload);
    if (!timingSafeEqual(signature, expected)) throw new DiagnosticEventCursorError();
  }
}

export const normalizeDiagnosticEventCursorFilters = (
  input: DiagnosticEventCursorFilters,
): NormalizedDiagnosticEventCursorFilters => {
  if (!isPlainRecord(input)) throw new TypeError("Diagnostic event cursor filters must be an object.");
  exactKeys(input, ["occurredAtFrom", "occurredAtTo", "sampleIndexes", "types"], true);
  if (input.types !== undefined && !Array.isArray(input.types)) {
    throw new TypeError("Diagnostic event type filters must be an array.");
  }
  if (input.sampleIndexes !== undefined && !Array.isArray(input.sampleIndexes)) {
    throw new TypeError("Diagnostic event sample filters must be an array.");
  }
  const types = [...(input.types ?? [])];
  if (types.length > MAX_EVENT_TYPES) throw new RangeError("Too many diagnostic event type filters.");
  for (const value of types) boundedString(value, "event type", MAX_EVENT_TYPE_BYTES);
  types.sort(compareUtf16);
  if (hasAdjacentDuplicate(types)) throw new TypeError("Diagnostic event type filters must be unique.");

  const sampleIndexes = [...(input.sampleIndexes ?? [])];
  if (sampleIndexes.length > MAX_SAMPLE_INDEXES) throw new RangeError("Too many diagnostic event sample filters.");
  for (const value of sampleIndexes) nonnegativeSafeInteger(value, "sample index");
  sampleIndexes.sort((left, right) => left - right);
  if (hasAdjacentDuplicate(sampleIndexes)) throw new TypeError("Diagnostic event sample filters must be unique.");

  const occurredAtFrom = normalizeInstant(input.occurredAtFrom, "occurredAtFrom");
  const occurredAtTo = normalizeInstant(input.occurredAtTo, "occurredAtTo");
  if (occurredAtFrom !== null && occurredAtTo !== null && occurredAtFrom > occurredAtTo) {
    throw new RangeError("Diagnostic event time filter range is invalid.");
  }
  return Object.freeze({
    types: Object.freeze(types),
    sampleIndexes: Object.freeze(sampleIndexes),
    occurredAtFrom,
    occurredAtTo,
  });
};

const normalizeContext = (
  input: DiagnosticEventCursorContext,
): Omit<DiagnosticEventCursorClaims, "version" | "keyEpoch" | "nextSequence" | "issuedAtMs" | "expiresAtMs"> => {
  if (!isPlainRecord(input)) throw new TypeError("Diagnostic event cursor context must be an object.");
  const projectId = boundedString(input.projectId, "projectId", MAX_IDENTIFIER_BYTES);
  const runId = boundedString(input.runId, "runId", MAX_IDENTIFIER_BYTES);
  const frozenContractDigest = digest(input.frozenContractDigest, "frozenContractDigest");
  const eventSetDigest = digest(input.eventSetDigest, "eventSetDigest");
  const lifecycleDigest = digest(input.lifecycleDigest, "lifecycleDigest");
  if (input.direction !== "forward" && input.direction !== "backward") {
    throw new TypeError("Diagnostic event cursor direction is invalid.");
  }
  const limit = positiveSafeInteger(input.limit, "limit");
  if (limit > MAX_PAGE_LIMIT) throw new RangeError("Diagnostic event cursor limit is too large.");
  return Object.freeze({
    projectId,
    runId,
    frozenContractDigest,
    eventSetDigest,
    lifecycleDigest,
    direction: input.direction,
    filters: normalizeDiagnosticEventCursorFilters(input.filters),
    limit,
  });
};

const payloadFrom = (
  context: ReturnType<typeof normalizeContext>,
  values: Pick<DiagnosticEventCursorClaims, "version" | "keyEpoch" | "nextSequence" | "issuedAtMs" | "expiresAtMs">,
): CursorPayload => Object.freeze({
  v: values.version,
  k: values.keyEpoch,
  p: context.projectId,
  r: context.runId,
  c: context.frozenContractDigest,
  e: context.eventSetDigest,
  g: context.lifecycleDigest,
  n: values.nextSequence,
  d: context.direction,
  f: Object.freeze({
    t: context.filters.types,
    s: context.filters.sampleIndexes,
    a: context.filters.occurredAtFrom,
    z: context.filters.occurredAtTo,
  }),
  l: context.limit,
  i: values.issuedAtMs,
  x: values.expiresAtMs,
});

const contextFromPayload = (payload: CursorPayload): ReturnType<typeof normalizeContext> =>
  normalizeContext({
    projectId: payload.p,
    runId: payload.r,
    frozenContractDigest: payload.c,
    eventSetDigest: payload.e,
    lifecycleDigest: payload.g,
    direction: payload.d,
    filters: {
      types: payload.f.t,
      sampleIndexes: payload.f.s,
      occurredAtFrom: payload.f.a,
      occurredAtTo: payload.f.z,
    },
    limit: payload.l,
  });

const decodeToken = (
  token: string,
  verifyMac: (payload: Uint8Array, encodedSignature: string) => void,
): Buffer => {
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_CURSOR_CHARACTERS) {
    throw new DiagnosticEventCursorError();
  }
  const separator = token.indexOf(".");
  if (separator <= 0 || separator !== token.lastIndexOf(".")) throw new DiagnosticEventCursorError();
  const payloadPart = token.slice(0, separator);
  const signaturePart = token.slice(separator + 1);
  if (signaturePart.length !== SIGNATURE_CHARACTERS) throw new DiagnosticEventCursorError();
  const payloadBytes = strictBase64url(payloadPart);
  if (payloadBytes.byteLength === 0 || payloadBytes.byteLength > MAX_PAYLOAD_BYTES) {
    throw new DiagnosticEventCursorError();
  }
  // Kept separate so invalid signatures never reach JSON parsing.
  verifyMac(payloadBytes, signaturePart);
  return payloadBytes;
};

const parsePayload = (payloadBytes: Buffer): CursorPayload => {
  const text = payloadBytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(payloadBytes)) throw new DiagnosticEventCursorError();
  const parsed = parseCanonicalJsonV2(text);
  if (!canonicalJsonV2(parsed).equals(payloadBytes)) throw new DiagnosticEventCursorError();
  if (!isPlainRecord(parsed)) throw new DiagnosticEventCursorError();
  exactKeys(parsed, EXACT_PAYLOAD_KEYS);
  if (!isPlainRecord(parsed.f)) throw new DiagnosticEventCursorError();
  exactKeys(parsed.f, EXACT_FILTER_KEYS);
  return parsed as unknown as CursorPayload;
};

const validatePayload = (payload: CursorPayload, keyEpoch: number, now: number): void => {
  if (payload.v !== CURSOR_VERSION || payload.k !== keyEpoch) throw new DiagnosticEventCursorError();
  positiveSafeInteger(payload.k, "key epoch");
  nonnegativeSafeInteger(payload.n, "next sequence");
  nonnegativeSafeInteger(payload.i, "issued time");
  nonnegativeSafeInteger(payload.x, "expiry time");
  if (payload.i > now || payload.x <= now || payload.x <= payload.i || payload.x - payload.i > MAX_TTL_MS) {
    throw new DiagnosticEventCursorError();
  }
  const context = contextFromPayload(payload);
  const normalizedFilters = {
    t: context.filters.types,
    s: context.filters.sampleIndexes,
    a: context.filters.occurredAtFrom,
    z: context.filters.occurredAtTo,
  };
  if (!canonicalJsonV2(payload.f).equals(canonicalJsonV2(normalizedFilters))) {
    throw new DiagnosticEventCursorError();
  }
};

const sameContext = (
  left: ReturnType<typeof normalizeContext>,
  right: ReturnType<typeof normalizeContext>,
): boolean => canonicalJsonV2(left).equals(canonicalJsonV2(right));

const strictBase64url = (value: string, expectedBytes?: number): Buffer => {
  if (!BASE64URL.test(value)) throw new DiagnosticEventCursorError();
  const decoded = Buffer.from(value, "base64url");
  if (expectedBytes !== undefined && decoded.byteLength !== expectedBytes) throw new DiagnosticEventCursorError();
  if (decoded.toString("base64url") !== value) throw new DiagnosticEventCursorError();
  return decoded;
};

const digest = (value: unknown, name: string): string => {
  if (typeof value !== "string" || !SHA256.test(value)) throw new TypeError(`${name} must be a SHA-256 digest.`);
  return value;
};

const boundedString = (value: unknown, name: string, maxBytes: number): string => {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new TypeError(`${name} is invalid.`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) throw new TypeError(`${name} contains a control character.`);
  canonicalJsonV2(value);
  return value;
};

const normalizeInstant = (value: unknown, name: string): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    throw new TypeError(`${name} is invalid.`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new TypeError(`${name} is invalid.`);
  }
  return value;
};

const nonnegativeSafeInteger = (value: unknown, name: string): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new RangeError(`${name} must be a nonnegative safe integer.`);
  return Number(value);
};

const positiveSafeInteger = (value: unknown, name: string): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new RangeError(`${name} must be a positive safe integer.`);
  return Number(value);
};

const validTtl = (value: unknown): number => {
  const ttl = positiveSafeInteger(value, "ttlMs");
  if (ttl > MAX_TTL_MS) throw new RangeError("Diagnostic event cursor TTL is too large.");
  return ttl;
};

const compareUtf16 = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

const hasAdjacentDuplicate = <T>(values: readonly T[]): boolean =>
  values.some((value, index) => index > 0 && value === values[index - 1]);

const isPlainRecord = (value: unknown): value is Record<string, CanonicalJson | undefined> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const exactKeys = (
  value: Record<string, unknown>,
  expected: readonly string[],
  optional = false,
): void => {
  const keys = Object.keys(value).sort(compareUtf16);
  if (optional) {
    if (keys.some((key) => !expected.includes(key))) throw new DiagnosticEventCursorError();
    return;
  }
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new DiagnosticEventCursorError();
  }
};
