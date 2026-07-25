import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  DIAGNOSTIC_EVENT_CURSOR_MAX_CHARACTERS,
  DiagnosticEventCursorCodec,
  DiagnosticEventCursorError,
  normalizeDiagnosticEventCursorFilters,
  type DiagnosticEventCursorContext,
} from "../src/diagnostic-event-cursor.ts";

const KEY = Buffer.alloc(32, 0x31);
const OTHER_KEY = Buffer.alloc(32, 0x32);
const CONTRACT_DIGEST = "a".repeat(64);
const EVENT_SET_DIGEST = "b".repeat(64);
const LIFECYCLE_DIGEST = "c".repeat(64);
const NOW = Date.parse("2026-07-25T08:00:00.000Z");
const DOMAIN = Buffer.from("riff-diagnostic-event-cursor-v1\0", "utf8");

const context = (overrides: Partial<DiagnosticEventCursorContext> = {}): DiagnosticEventCursorContext => ({
  projectId: "project_alpha",
  runId: "run_terminal_1",
  frozenContractDigest: CONTRACT_DIGEST,
  eventSetDigest: EVENT_SET_DIGEST,
  lifecycleDigest: LIFECYCLE_DIGEST,
  direction: "forward",
  filters: {
    types: ["repair_started", "failure"],
    sampleIndexes: [9, 2],
    occurredAtFrom: "2026-07-01T00:00:00.000Z",
    occurredAtTo: "2026-07-24T23:59:59.999Z",
  },
  limit: 25,
  ...overrides,
});

const codec = (options: {
  key?: Uint8Array;
  keyEpoch?: number;
  now?: () => number;
} = {}): DiagnosticEventCursorCodec => new DiagnosticEventCursorCodec({
  secret: options.key ?? KEY,
  keyEpoch: options.keyEpoch ?? 4,
  now: options.now ?? (() => NOW),
});

const errorIsGeneric = (error: unknown): boolean => {
  assert.ok(error instanceof DiagnosticEventCursorError);
  assert.equal(error.code, "invalid_diagnostic_event_cursor");
  assert.equal(error.message, "The diagnostic event cursor is invalid.");
  assert.doesNotMatch(error.message, /project_alpha|run_terminal|aaaa|bbbb|3131/u);
  return true;
};

const signedRaw = (json: string, key: Uint8Array = KEY): string => {
  const payload = Buffer.from(json, "utf8");
  const signature = createHmac("sha256", key).update(DOMAIN).update(payload).digest("base64url");
  return `${payload.toString("base64url")}.${signature}`;
};

const decodedPayload = (token: string): Record<string, unknown> => {
  const [payload] = token.split(".");
  return JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")) as Record<string, unknown>;
};

test("issues a compact canonical authenticated cursor and verifies normalized claims", () => {
  const current = codec();
  const token = current.issue({ ...context(), nextSequence: 42 });
  assert.ok(token.length < DIAGNOSTIC_EVENT_CURSOR_MAX_CHARACTERS);
  assert.match(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u);

  const claims = current.verify(token, context());
  assert.deepEqual(claims, {
    version: 1,
    keyEpoch: 4,
    projectId: "project_alpha",
    runId: "run_terminal_1",
    frozenContractDigest: CONTRACT_DIGEST,
    eventSetDigest: EVENT_SET_DIGEST,
    lifecycleDigest: LIFECYCLE_DIGEST,
    nextSequence: 42,
    direction: "forward",
    filters: {
      types: ["failure", "repair_started"],
      sampleIndexes: [2, 9],
      occurredAtFrom: "2026-07-01T00:00:00.000Z",
      occurredAtTo: "2026-07-24T23:59:59.999Z",
    },
    limit: 25,
    issuedAtMs: NOW,
    expiresAtMs: NOW + 15 * 60_000,
  });
  assert.ok(Object.isFrozen(claims));
  assert.ok(Object.isFrozen(claims.filters));
  assert.ok(Object.isFrozen(claims.filters.types));
});

test("same key and epoch survive reconstruction while rotation and epoch changes invalidate", () => {
  const token = codec().issue({ ...context(), nextSequence: 8 });
  assert.equal(codec().verify(token, context()).nextSequence, 8);
  assert.throws(() => codec({ key: OTHER_KEY }).verify(token, context()), errorIsGeneric);
  assert.throws(() => codec({ keyEpoch: 5 }).verify(token, context()), errorIsGeneric);
});

test("verification binds every route, immutable set, lifecycle digest, direction, filter, and limit field", () => {
  const token = codec().issue({ ...context(), nextSequence: 8 });
  const mismatches: DiagnosticEventCursorContext[] = [
    context({ projectId: "project_beta" }),
    context({ runId: "run_terminal_2" }),
    context({ frozenContractDigest: "c".repeat(64) }),
    context({ eventSetDigest: "d".repeat(64) }),
    context({ lifecycleDigest: "e".repeat(64) }),
    context({ direction: "backward" }),
    context({ filters: { ...context().filters, types: ["failure"] } }),
    context({ filters: { ...context().filters, sampleIndexes: [2] } }),
    context({ filters: { ...context().filters, occurredAtFrom: null } }),
    context({ filters: { ...context().filters, occurredAtTo: null } }),
    context({ limit: 24 }),
  ];
  for (const mismatch of mismatches) {
    assert.throws(() => codec().verify(token, mismatch), errorIsGeneric);
  }
});

test("tampering, invalid base64url, segment ambiguity, and overlong input fail closed", () => {
  const token = codec().issue({ ...context(), nextSequence: 8 });
  const [payload, signature] = token.split(".");
  const changedPayload = `${payload!.slice(0, -1)}${payload!.endsWith("A") ? "B" : "A"}.${signature}`;
  const changedSignature = `${payload}.${signature!.slice(0, -1)}${signature!.endsWith("A") ? "B" : "A"}`;
  for (const invalid of [
    "",
    "not-a-token",
    `${payload}.${signature}.extra`,
    `${payload}=.${signature}`,
    `${payload}.abc+def`,
    changedPayload,
    changedSignature,
    `A${"A".repeat(DIAGNOSTIC_EVENT_CURSOR_MAX_CHARACTERS)}.${signature}`,
  ]) {
    assert.throws(() => codec().verify(invalid, context()), errorIsGeneric);
  }
});

test("signed but noncanonical, unknown-key, unsafe-number, version, epoch, and type payloads fail", () => {
  const valid = codec().issue({ ...context(), nextSequence: 8 });
  const payload = decodedPayload(valid);
  const cases: string[] = [
    JSON.stringify(payload, null, 1),
    JSON.stringify({ ...payload, unknown: true }),
    JSON.stringify({ ...payload, n: 9_007_199_254_740_992 }),
    JSON.stringify({ ...payload, v: 2 }),
    JSON.stringify({ ...payload, k: 5 }),
    JSON.stringify({ ...payload, l: "25" }),
    JSON.stringify({ ...payload, d: "sideways" }),
    JSON.stringify({ ...payload, f: { ...(payload.f as object), unknown: true } }),
    JSON.stringify({ ...payload, f: { ...(payload.f as object), t: "failure" } }),
    JSON.stringify({ ...payload, f: { ...(payload.f as object), t: ["repair_started", "failure"] } }),
  ];
  for (const raw of cases) {
    assert.throws(() => codec().verify(signedRaw(raw), context()), errorIsGeneric);
  }
});

test("duplicate JSON keys and noncanonical key order are rejected even with a valid MAC", () => {
  const valid = codec().issue({ ...context(), nextSequence: 8 });
  const payload = decodedPayload(valid);
  const canonical = JSON.stringify(payload);
  const duplicate = canonical.replace(/^\{"c":/u, '{"c":"a","c":');
  assert.throws(() => codec().verify(signedRaw(duplicate), context()), errorIsGeneric);

  const reversed = JSON.stringify(Object.fromEntries(Object.entries(payload).reverse()));
  assert.throws(() => codec().verify(signedRaw(reversed), context()), errorIsGeneric);
});

test("expiry, future issue time, invalid interval, and excessive lifetime are rejected", () => {
  const issueAt = codec();
  const token = issueAt.issue({ ...context(), nextSequence: 8, ttlMs: 1_000 });
  assert.equal(codec({ now: () => NOW + 999 }).verify(token, context()).nextSequence, 8);
  assert.throws(() => codec({ now: () => NOW + 1_000 }).verify(token, context()), errorIsGeneric);
  assert.throws(() => codec({ now: () => NOW - 1 }).verify(token, context()), errorIsGeneric);

  const payload = decodedPayload(token);
  assert.throws(
    () => codec().verify(signedRaw(JSON.stringify({ ...payload, x: payload.i })), context()),
    errorIsGeneric,
  );
  assert.throws(
    () => codec().verify(signedRaw(JSON.stringify({
      ...payload,
      x: Number(payload.i) + 24 * 60 * 60_000 + 1,
    })), context()),
    errorIsGeneric,
  );
});

test("constructor and issuance reject weak keys and unsafe or unbounded claims", () => {
  assert.throws(() => new DiagnosticEventCursorCodec({ secret: Buffer.alloc(31), keyEpoch: 1 }), /32 bytes/u);
  assert.throws(() => new DiagnosticEventCursorCodec({ secret: Buffer.alloc(33), keyEpoch: 1 }), /32 bytes/u);
  assert.throws(() => new DiagnosticEventCursorCodec({ secret: KEY, keyEpoch: 0 }), /positive safe integer/u);
  assert.throws(() => codec().issue({ ...context(), nextSequence: -1 }), /nonnegative safe integer/u);
  assert.throws(() => codec().issue({ ...context(), nextSequence: Number.MAX_SAFE_INTEGER + 1 }), /safe integer/u);
  assert.throws(() => codec().issue({ ...context({ limit: 101 }), nextSequence: 1 }), /limit is too large/u);
  assert.throws(() => codec().issue({
    ...context({ projectId: "p".repeat(257) }),
    nextSequence: 1,
  }), /projectId is invalid/u);
  assert.throws(() => codec().issue({
    ...context({ frozenContractDigest: "A".repeat(64) }),
    nextSequence: 1,
  }), /SHA-256/u);
  assert.throws(() => codec().issue({ ...context(), nextSequence: 1, ttlMs: 24 * 60 * 60_000 + 1 }), /TTL/u);
});

test("filter normalization is deterministic and rejects duplicates, unsafe indexes, and invalid ranges", () => {
  assert.deepEqual(normalizeDiagnosticEventCursorFilters({
    types: ["z", "a"],
    sampleIndexes: [10, 0],
    occurredAtFrom: "2026-07-01T00:00:00.000Z",
  }), {
    types: ["a", "z"],
    sampleIndexes: [0, 10],
    occurredAtFrom: "2026-07-01T00:00:00.000Z",
    occurredAtTo: null,
  });
  assert.throws(() => normalizeDiagnosticEventCursorFilters({ types: ["a", "a"] }), /unique/u);
  assert.throws(() => normalizeDiagnosticEventCursorFilters({ sampleIndexes: [1, 1] }), /unique/u);
  assert.throws(() => normalizeDiagnosticEventCursorFilters({ sampleIndexes: [-1] }), /nonnegative/u);
  for (const occurredAtFrom of [
    "2026-07-01T08:00:00.000+08:00",
    "2026-07-01T00:00:00Z",
    "2026-07-01T00:00:00.00Z",
    "2026-07-01T00:00:00.0000Z",
  ]) {
    assert.throws(
      () => normalizeDiagnosticEventCursorFilters({ occurredAtFrom }),
      /occurredAtFrom is invalid/u,
    );
  }
  assert.throws(() => normalizeDiagnosticEventCursorFilters({
    occurredAtFrom: "2026-07-02T00:00:00.000Z",
    occurredAtTo: "2026-07-01T00:00:00.000Z",
  }), /range/u);
  assert.throws(() => normalizeDiagnosticEventCursorFilters({
    types: Array.from({ length: 33 }, (_, index) => `type_${index}`),
  }), /Too many/u);
  assert.throws(() => normalizeDiagnosticEventCursorFilters({
    unknown: true,
  } as never), errorIsGeneric);
});
