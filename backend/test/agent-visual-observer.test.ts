import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { once } from "node:events";
import {
  VisualAgentObservationError,
  VisualAgentObserver,
  type VisualAgentObservation,
  type VisualObservationKind,
} from "../src/visual-agent-observer.ts";

type Fixture = {
  readonly server: Server;
  readonly port: number;
  readonly requests: Array<{ url: string; method: string }>;
  readonly close: () => Promise<void>;
};

const PROCESS_IDENTITY = Object.freeze({
  runId: "run_observer",
  processAttemptId: "process_observer",
  pid: process.pid,
  processStartToken: "test-process-start-token",
  processGroupId: process.pid,
});

const observation = new VisualAgentObserver({
  async inspectListener() {},
  async inspectConnectedPeer() {},
});

const startFixture = async (): Promise<Fixture> => {
  const requests: Array<{ url: string; method: string }> = [];
  const server = createServer((request, response) => {
    requests.push({ url: request.url ?? "", method: request.method ?? "" });
    if (request.url === "/inspection") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ready", nested: { count: 2 } }));
      return;
    }
    if (request.url === "/slow") {
      setTimeout(() => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      }, 1_000).unref();
      return;
    }
    if (request.url === "/bad-json") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("not json");
      return;
    }
    if (request.url === "/oversize") {
      response.writeHead(200, {
        "content-type": "application/json",
        "transfer-encoding": "chunked",
      });
      for (let index = 0; index < 300; index += 1) {
        if (response.destroyed) break;
        response.write("x".repeat(1_024));
      }
      response.end();
      return;
    }
    if (request.url === "/huge-header") {
      response.writeHead(200, {
        "content-type": "application/json",
        "x-oversized": "x".repeat(20 * 1_024),
      });
      response.end("{}");
      return;
    }
    if (request.url === "/drip") {
      response.writeHead(200, {
        "content-type": "application/json",
        "transfer-encoding": "chunked",
      });
      response.write("{");
      const timer = setInterval(() => response.write(" "), 1_000);
      response.on("close", () => clearInterval(timer));
      return;
    }
    if (request.url === "/") {
      const origin = `http://${request.headers.host}`;
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><body>untrusted-child-content-canary
        <button>Run</button>
        <script src="${origin}/blocked-script.js"></script>
        <img src="${origin}/blocked-image.png">
        <script>document.body.append("INLINE_SCRIPT_EXECUTED");fetch("${origin}/blocked-fetch")</script>
        <script src="http://example.invalid/blocked.js"></script></body>`);
      return;
    }
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("missing");
  });
  server.listen({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    server,
    port: address.port,
    requests,
    close: async () => { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); },
  };
};

const observe = (port: number, kind: VisualObservationKind, path = "/inspection", signal = new AbortController().signal) =>
  observation.observe({
    target: {
      ...PROCESS_IDENTITY,
      loopbackHost: "127.0.0.1",
      loopbackPort: port,
      ...(path ? { structuredInspectionPath: path } : {}),
    },
    kind,
    signal,
  });

const unavailable = async (promise: Promise<unknown>): Promise<void> => {
  await assert.rejects(promise, (error: unknown) =>
    error instanceof VisualAgentObservationError
      && error.code === "visual_observation_failed"
      && error.message === "The scoped visual observation is unavailable.");
};

test("the observer returns exactly four bounded, explicitly-untrusted read-only projections", async (t) => {
  const fixture = await startFixture();
  t.after(fixture.close);
  const results: VisualAgentObservation[] = [];
  for (const kind of [
    "observe_structured",
    "observe_accessibility",
    "observe_dom_text",
    "observe_screenshot",
  ] as const) results.push(await observe(fixture.port, kind));

  assert.deepEqual(results.map((result) => result.kind), [
    "observe_structured", "observe_accessibility", "observe_dom_text", "observe_screenshot",
  ]);
  for (const result of results) assert.equal(result.untrusted, true);
  assert.deepEqual(results[0], {
    schemaVersion: 1,
    kind: "observe_structured",
    untrusted: true,
    contentType: "application/json",
    value: { status: "ready", nested: { count: 2 } },
  });
  assert.equal(results[1]?.contentType, "text/plain");
  assert.match((results[1] as { text: string }).text, /Run/u);
  assert.equal(results[2]?.contentType, "text/plain");
  assert.match((results[2] as { text: string }).text, /untrusted-child-content-canary/u);
  assert.doesNotMatch((results[2] as { text: string }).text, /INLINE_SCRIPT_EXECUTED/u);
  assert.equal(results[3]?.contentType, "image/png");
  assert.ok(Buffer.from((results[3] as { pngBase64: string }).pngBase64, "base64").byteLength > 32);
  assert.ok(fixture.requests.every((request) => request.method === "GET"));
  assert.equal(fixture.requests.some((request) => request.url.includes("blocked")), false);
});

test("structured observation is declaration-bound and all target or content failures converge without scope leakage", async (t) => {
  const fixture = await startFixture();
  t.after(fixture.close);
  await unavailable(observe(fixture.port, "observe_structured", ""));
  await unavailable(observe(fixture.port, "observe_structured", "/bad-json"));
  await unavailable(observe(fixture.port, "observe_structured", "/oversize"));
  await unavailable(observe(fixture.port, "observe_structured", "/huge-header"));
  await unavailable(observe(fixture.port, "observe_structured", "/inspection?forbidden"));
  await unavailable(observation.observe({
    target: { ...PROCESS_IDENTITY, loopbackHost: "127.0.0.1", loopbackPort: fixture.port, structuredInspectionPath: "/inspection", selector: "#secret", url: "http://attacker.invalid", script: "alert(1)", cdpUrl: "ws://attacker.invalid" } as never,
    kind: "observe_structured",
    signal: new AbortController().signal,
  }));
  const error = await observation.observe({
    target: { ...PROCESS_IDENTITY, loopbackHost: "127.0.0.1", loopbackPort: 0, structuredInspectionPath: "/inspection" } as never,
    kind: "observe_structured",
    signal: new AbortController().signal,
  }).catch((cause: unknown) => cause);
  assert.ok(error instanceof VisualAgentObservationError);
  const serialized = JSON.stringify(error);
  for (const forbidden of [String(fixture.port), "attacker.invalid", "#secret", "alert(1)", "ws://"]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("abort before and during an observation denies without accepting a partial result", async (t) => {
  const fixture = await startFixture();
  t.after(fixture.close);
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  await unavailable(observe(fixture.port, "observe_structured", "/inspection", alreadyAborted.signal));
  assert.equal(fixture.requests.length, 0);

  const controller = new AbortController();
  const started = new Promise<void>((resolve) => {
    const listener = (request: { url?: string }) => {
      if (request.url === "/slow") { fixture.server.off("request", listener); resolve(); }
    };
    fixture.server.on("request", listener);
  });
  const pending = observe(fixture.port, "observe_structured", "/slow", controller.signal);
  await started;
  controller.abort();
  await unavailable(pending);
});

test("listener and connected-peer identity gates run before any HTTP request", async (t) => {
  const fixture = await startFixture();
  t.after(fixture.close);
  const target = {
    ...PROCESS_IDENTITY,
    loopbackHost: "127.0.0.1" as const,
    loopbackPort: fixture.port,
    structuredInspectionPath: "/inspection",
  };
  const listenerDenied = new VisualAgentObserver({
    async inspectListener() { throw new Error("foreign listener"); },
    async inspectConnectedPeer() { throw new Error("must not run"); },
  });
  await unavailable(listenerDenied.observe({
    target,
    kind: "observe_structured",
    signal: new AbortController().signal,
  }));
  assert.equal(fixture.requests.length, 0);

  let connectedChecks = 0;
  const peerDenied = new VisualAgentObserver({
    async inspectListener() {},
    async inspectConnectedPeer() {
      connectedChecks += 1;
      throw new Error("foreign peer");
    },
  });
  await unavailable(peerDenied.observe({
    target,
    kind: "observe_structured",
    signal: new AbortController().signal,
  }));
  assert.equal(connectedChecks, 1);
  assert.equal(fixture.requests.length, 0);
});

test("slow-drip responses cannot extend the total observation deadline", async (t) => {
  const fixture = await startFixture();
  t.after(fixture.close);
  const startedAt = Date.now();
  await unavailable(observe(fixture.port, "observe_structured", "/drip"));
  const elapsedMs = Date.now() - startedAt;
  assert.ok(elapsedMs >= 4_000, String(elapsedMs));
  assert.ok(elapsedMs < 7_000, String(elapsedMs));
});

test("the observer source has no caller-controlled interaction, script, selector, or legacy-CDP control surface", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("../src/visual-agent-observer.ts", import.meta.url), "utf8"));
  for (const forbidden of [
    "connectOverCDP", "page.click", "page.fill", "page.type", "page.selectOption",
    "page.evaluate", "page.goto(input", "selector:", "script:", "cdpUrl:",
  ]) assert.equal(source.includes(forbidden), false, forbidden);
  assert.match(source, /acceptDownloads: false/u);
  assert.match(source, /serviceWorkers: "block"/u);
  assert.match(source, /routeWebSocket/u);
  assert.match(source, /maxHeaderSize: MAX_RESPONSE_HEADER_BYTES/u);
  assert.match(source, /const NAVIGATION_TIMEOUT_MS = 5_000/u);
  assert.match(source, /timeout: NAVIGATION_TIMEOUT_MS/u);
});
