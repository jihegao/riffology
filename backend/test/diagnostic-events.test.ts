import assert from "node:assert/strict";
import test from "node:test";
import {
  DiagnosticEventParseError,
  parseDiagnosticEventNdjson,
} from "../src/diagnostic-events.ts";

const utf8 = (value: string): Buffer => Buffer.from(value, "utf8");
const record = (payload: unknown, extra = ""): Buffer => utf8(`{"type":"repair_started",${extra}"payload":${JSON.stringify(payload)}}\n`);
const expectCode = (code: DiagnosticEventParseError["code"], fn: () => unknown): void => {
  assert.throws(fn, (error: unknown) => error instanceof DiagnosticEventParseError && error.code === code);
};

test("strict diagnostic NDJSON produces immutable canonical candidates and a semantic ordered digest", () => {
  const source = utf8(
    "{\"type\":\"repair_started\",\"occurredAt\":\"2026-07-25T01:02:03.004Z\",\"payload\":{\"count\":2,\"nested\":[true,null]}}\n"
      + "{\"type\":\"repair_finished\",\"payload\":{\"duration\":1.5}}\n",
  );
  const parsed = parseDiagnosticEventNdjson(source);
  assert.equal(parsed.eventCount, 2);
  assert.equal(parsed.totalBytes, source.byteLength);
  assert.equal(parsed.events[0]?.sourceOrdinal, 0);
  assert.equal(parsed.events[0]?.occurredAt, "2026-07-25T01:02:03.004Z");
  assert.equal(parsed.events[1]?.occurredAt, null);
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.events), true);
  assert.equal(Object.isFrozen(parsed.events[0]?.payload), true);

  const differentWhitespace = utf8(
    " { \"payload\" : { \"nested\" : [ true , null ] , \"count\" : 2 }, \"occurredAt\" : \"2026-07-25T01:02:03.004Z\" , \"type\" : \"repair_started\" }\n"
      + "{\"payload\":{\"duration\":1.5},\"type\":\"repair_finished\"}\n",
  );
  assert.equal(parseDiagnosticEventNdjson(differentWhitespace).eventSetDigest, parsed.eventSetDigest);
  assert.notEqual(parseDiagnosticEventNdjson(differentWhitespace).totalBytes, parsed.totalBytes);
});

test("strict diagnostic NDJSON rejects framing, UTF-8, duplicate keys, unsafe numbers, and exact envelope violations", () => {
  expectCode("invalid_diagnostic_events", () => parseDiagnosticEventNdjson(Buffer.alloc(0)));
  expectCode("invalid_diagnostic_events", () => parseDiagnosticEventNdjson(utf8("{\"type\":\"x\",\"payload\":{}}")));
  expectCode("invalid_diagnostic_events", () => parseDiagnosticEventNdjson(utf8("{\"type\":\"x\",\"payload\":{}}\r\n")));
  expectCode("invalid_diagnostic_events", () => parseDiagnosticEventNdjson(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), record({})])));
  expectCode("invalid_diagnostic_events", () => parseDiagnosticEventNdjson(utf8("{\"type\":\"x\",\"payload\":{\"text\":\"\ufeff\"}}\n")));
  expectCode("invalid_diagnostic_events", () => parseDiagnosticEventNdjson(Buffer.concat([record({}), Buffer.from("\n")] )));
  expectCode("invalid_diagnostic_events", () => parseDiagnosticEventNdjson(Buffer.from([0x7b, 0x22, 0x74, 0x79, 0x70, 0x65, 0x22, 0x3a, 0x22, 0x78, 0x22, 0x2c, 0xff, 0x0a])));
  expectCode("invalid_diagnostic_events", () => parseDiagnosticEventNdjson(utf8("{\"type\":\"x\",\"type\":\"y\",\"payload\":{}}\n")));
  expectCode("invalid_diagnostic_events", () => parseDiagnosticEventNdjson(utf8("{\"type\":\"x\",\"payload\":{\"n\":1,\"n\":2}}\n")));
  expectCode("invalid_diagnostic_events", () => parseDiagnosticEventNdjson(utf8("{\"type\":\"x\",\"payload\":{\"n\":9007199254740992}}\n")));
  expectCode("invalid_diagnostic_events", () => parseDiagnosticEventNdjson(utf8("{\"type\":\"x\",\"payload\":{},\"extra\":true}\n")));
  expectCode("invalid_diagnostic_events", () => parseDiagnosticEventNdjson(utf8("{\"type\":\"not a token\",\"payload\":{}}\n")));
  expectCode("invalid_diagnostic_events", () => parseDiagnosticEventNdjson(utf8("{\"type\":\"x\",\"occurredAt\":\"2026-07-25T01:02:03Z\",\"payload\":{}}\n")));
  expectCode("invalid_diagnostic_events", () => parseDiagnosticEventNdjson(utf8("{\"type\":\"x\",\"occurredAt\":\"2026-02-29T01:02:03.004Z\",\"payload\":{}}\n")));
});

test("diagnostic parser enforces per-record, count, byte, depth, width, and string bounds", () => {
  expectCode("run_event_count_limit", () => parseDiagnosticEventNdjson(Buffer.concat([record({}), record({})]), { limits: { maxEventCount: 1 } }));
  expectCode("run_event_byte_limit", () => parseDiagnosticEventNdjson(record({}), { limits: { maxEventBytes: 10 } }));
  expectCode("run_event_byte_limit", () => parseDiagnosticEventNdjson(record({ value: "abcd" }), { limits: { maxRecordBytes: 20, maxEventBytes: 100 } }));
  expectCode("invalid_diagnostic_events", () => parseDiagnosticEventNdjson(record({ deep: { again: { end: 1 } } }), { limits: { maxDepth: 2 } }));
  expectCode("invalid_diagnostic_events", () => parseDiagnosticEventNdjson(record({ first: 1, second: 2 }), { limits: { maxObjectKeys: 1 } }));
  expectCode("invalid_diagnostic_events", () => parseDiagnosticEventNdjson(record({ items: [1, 2] }), { limits: { maxArrayItems: 1 } }));
  expectCode("invalid_diagnostic_events", () => parseDiagnosticEventNdjson(record({ value: "abcd" }), { limits: { maxStringBytes: 3 } }));
});

test("declared closed payload schema validates and normalizes object payloads before immutable candidates", () => {
  const schema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      status: { type: "string", enum: ["ok", "failed"] },
      attempts: { type: "integer", minimum: 0, default: 0 },
    },
    required: ["status"],
    additionalProperties: false,
  };
  const options = { payloadSchema: { schemaProfile: "riff-json-schema-2020-12-v1" as const, schema } };
  const parsed = parseDiagnosticEventNdjson(record({ status: "ok" }), options);
  assert.deepEqual(parsed.events[0]?.payload, { attempts: 0, status: "ok" });
  expectCode("invalid_diagnostic_events", () => parseDiagnosticEventNdjson(record({ status: "other" }), options));
  expectCode("invalid_diagnostic_events", () => parseDiagnosticEventNdjson(record(["ok"]), options));
  expectCode("invalid_diagnostic_events", () => parseDiagnosticEventNdjson(record({ status: "ok" }), {
    payloadSchema: { schemaProfile: "other" as any, schema },
  }));
  expectCode("invalid_diagnostic_events", () => parseDiagnosticEventNdjson(record({ status: "ok" }), {
    payloadSchema: { schemaProfile: "riff-json-schema-2020-12-v1", schema: { type: "object" } as any },
  }));
});
