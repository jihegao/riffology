import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import test, { type TestContext } from "node:test";
import {
  VISUAL_HEALTH_MAX_BODY_BYTES,
  VISUAL_HEALTH_MAX_HEADER_BYTES,
  VisualHealthProbe,
  VisualHealthProbeError,
  type VisualHealthProbeErrorCode,
} from "../src/visual-health-probe.ts";

const HEALTH_PATH = "/internal/healthz";
const RESPONSE_MARKER = "private-health-body-marker";

type TestServer = Readonly<{
  server: Server;
  port: number;
  requests: IncomingMessage[];
}>;

const startServer = async (
  t: TestContext,
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<TestServer> => {
  const requests: IncomingMessage[] = [];
  const server = createServer((request, response) => {
    requests.push(request);
    handler(request, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  t.after(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  });
  return Object.freeze({ server, port: address.port, requests });
};

const makeProbe = (
  server: TestServer,
  overrides: Partial<ConstructorParameters<typeof VisualHealthProbe>[0]> = {},
): VisualHealthProbe => new VisualHealthProbe({
  host: "127.0.0.1",
  assignedPort: server.port,
  healthPath: HEALTH_PATH,
  deadlineAtMs: Date.now() + 2_000,
  assertListenerBefore: async () => {},
  assertListenerAfter: async () => {},
  ...overrides,
});

const expectProbeError = async (
  promise: Promise<unknown>,
  code: VisualHealthProbeErrorCode,
  server: TestServer,
): Promise<void> => {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof VisualHealthProbeError);
    assert.equal(error.code, code);
    assert.equal(error.message.includes(String(server.port)), false);
    assert.equal(error.message.includes(HEALTH_PATH), false);
    assert.equal(error.message.includes(RESPONSE_MARKER), false);
    assert.equal(error.message.includes("http://"), false);
    return true;
  });
};

test("one-shot visual health probe performs one exact GET between listener assertions", async (t) => {
  const order: string[] = [];
  const server = await startServer(t, (request, response) => {
    order.push("request");
    assert.equal(request.method, "GET");
    assert.equal(request.url, HEALTH_PATH);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(`{"ok":true,"marker":"${RESPONSE_MARKER}"}`);
  });
  const probe = makeProbe(server, {
    assertListenerBefore: async () => { order.push("before"); },
    assertListenerAfter: async () => { order.push("after"); },
  });

  await probe.probe();
  assert.deepEqual(order, ["before", "request", "after"]);
  assert.equal(server.requests.length, 1);

  await expectProbeError(
    probe.probe(),
    "visual_health_probe_already_used",
    server,
  );
  assert.equal(server.requests.length, 1);
});

test("redirect is rejected without following the Location target", async (t) => {
  let afterCalls = 0;
  const server = await startServer(t, (request, response) => {
    if (request.url === HEALTH_PATH) {
      response.writeHead(302, { location: "/redirect-target" });
      response.end("redirect");
      return;
    }
    response.writeHead(200);
    response.end();
  });
  await expectProbeError(
    makeProbe(server, {
      assertListenerAfter: async () => { afterCalls += 1; },
    }).probe(),
    "visual_health_redirect_rejected",
    server,
  );
  assert.deepEqual(server.requests.map(({ url }) => url), [HEALTH_PATH]);
  assert.equal(afterCalls, 1);
});

test("wrong path and non-200 status each fail after exactly one request", async (t) => {
  await t.test("wrong path", async (t) => {
    const server = await startServer(t, (request, response) => {
      response.writeHead(request.url === HEALTH_PATH ? 200 : 404);
      response.end();
    });
    await expectProbeError(
      makeProbe(server, { healthPath: "/wrong-health-path" }).probe(),
      "visual_health_status_rejected",
      server,
    );
    assert.equal(server.requests.length, 1);
  });

  await t.test("non-200", async (t) => {
    const server = await startServer(t, (_request, response) => {
      response.writeHead(503);
      response.end(RESPONSE_MARKER);
    });
    await expectProbeError(
      makeProbe(server).probe(),
      "visual_health_status_rejected",
      server,
    );
    assert.equal(server.requests.length, 1);
  });
});

test("oversized response body is bounded and rejected", async (t) => {
  const server = await startServer(t, (_request, response) => {
    response.writeHead(200);
    response.write(Buffer.alloc(VISUAL_HEALTH_MAX_BODY_BYTES, "a"));
    response.end("b");
  });
  await expectProbeError(
    makeProbe(server).probe(),
    "visual_health_body_too_large",
    server,
  );
  assert.equal(server.requests.length, 1);
});

test("oversized response headers are bounded and rejected", async (t) => {
  const server = await startServer(t, (_request, response) => {
    response.writeHead(200, {
      "x-oversized-health-header": "h".repeat(VISUAL_HEALTH_MAX_HEADER_BYTES + 1_024),
    });
    response.end();
  });
  await expectProbeError(
    makeProbe(server).probe(),
    "visual_health_headers_too_large",
    server,
  );
  assert.equal(server.requests.length, 1);
});

test("deadline covers the complete response rather than only headers", async (t) => {
  const server = await startServer(t, (_request, response) => {
    response.writeHead(200);
    response.write("{");
    setTimeout(() => response.end("}"), 200).unref();
  });
  await expectProbeError(
    makeProbe(server, { deadlineAtMs: Date.now() + 40 }).probe(),
    "visual_health_deadline_exceeded",
    server,
  );
  assert.equal(server.requests.length, 1);
});

test("connection reset fails once without retry", async (t) => {
  const server = await startServer(t, (request) => {
    request.socket.destroy();
  });
  await expectProbeError(
    makeProbe(server).probe(),
    "visual_health_transport_failed",
    server,
  );
  assert.equal(server.requests.length, 1);
});

test("concurrent call is rejected before it can create another request", async (t) => {
  const server = await startServer(t, (_request, response) => {
    response.writeHead(200);
    response.end();
  });
  let releaseBefore!: () => void;
  let enteredBefore!: () => void;
  const beforeEntered = new Promise<void>((resolve) => { enteredBefore = resolve; });
  const holdBefore = new Promise<void>((resolve) => { releaseBefore = resolve; });
  const probe = makeProbe(server, {
    assertListenerBefore: async () => {
      enteredBefore();
      await holdBefore;
    },
  });

  const first = probe.probe();
  await beforeEntered;
  await expectProbeError(
    probe.probe(),
    "visual_health_probe_already_used",
    server,
  );
  assert.equal(server.requests.length, 0);
  releaseBefore();
  await first;
  assert.equal(server.requests.length, 1);
});

test("listener assertion failures are single-use and never trigger a second request", async (t) => {
  await t.test("before request", async (t) => {
    let afterCalls = 0;
    const server = await startServer(t, (_request, response) => {
      response.writeHead(200);
      response.end();
    });
    const probe = makeProbe(server, {
      assertListenerBefore: async () => { throw new Error("private callback failure"); },
      assertListenerAfter: async () => { afterCalls += 1; },
    });
    await expectProbeError(
      probe.probe(),
      "visual_health_listener_before_failed",
      server,
    );
    assert.equal(server.requests.length, 0);
    assert.equal(afterCalls, 0);
    await expectProbeError(
      probe.probe(),
      "visual_health_probe_already_used",
      server,
    );
    assert.equal(server.requests.length, 0);
  });

  await t.test("after complete response", async (t) => {
    let beforeCalls = 0;
    const server = await startServer(t, (_request, response) => {
      response.writeHead(200);
      response.end();
    });
    const probe = makeProbe(server, {
      assertListenerBefore: async () => { beforeCalls += 1; },
      assertListenerAfter: async () => { throw new Error("private callback failure"); },
    });
    await expectProbeError(
      probe.probe(),
      "visual_health_listener_after_failed",
      server,
    );
    assert.equal(beforeCalls, 1);
    assert.equal(server.requests.length, 1);
    await expectProbeError(
      probe.probe(),
      "visual_health_probe_already_used",
      server,
    );
    assert.equal(server.requests.length, 1);
  });
});
