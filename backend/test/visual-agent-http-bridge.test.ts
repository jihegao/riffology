import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { once } from "node:events";
import type { Socket } from "node:net";
import test from "node:test";
import { VisualAgentHttpBridge } from "../src/visual-agent-http-bridge.ts";

const target = (port: number) => ({
  runId: "run_bridge", processAttemptId: "process_bridge", pid: process.pid,
  processStartToken: "bridge-test", processGroupId: process.pid,
  loopbackHost: "127.0.0.1" as const, loopbackPort: port,
});

const call = async (url: string, method = "GET", headers: Record<string, string> = {}, body?: string) => await new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
  const hit = request(url, { method, headers }, (response) => {
    const chunks: Buffer[] = [];
    response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
  });
  hit.on("error", reject); hit.end(body);
});

test("private bridge uses one inspected child socket and strips child authority", async (t) => {
  const seen: string[] = [];
  const child = createServer((requestIn, response) => {
    seen.push(`${requestIn.method} ${requestIn.url}`);
    assert.equal(requestIn.headers.cookie, undefined);
    assert.equal(requestIn.headers.authorization, undefined);
    assert.equal(requestIn.headers.host?.startsWith("127.0.0.1:"), true);
    response.writeHead(200, { "content-type": "text/html", "set-cookie": "secret=x" });
    response.end("<button>Run</button>");
  });
  child.listen(0, "127.0.0.1"); await once(child, "listening");
  const address = child.address(); assert.ok(address && typeof address !== "string");
  t.after(async () => { await new Promise<void>((resolve) => child.close(() => resolve())); });
  let listener = 0; let peer = 0;
  const bridge = await VisualAgentHttpBridge.open({
    target: target(address.port), assertLive() {}, signal: new AbortController().signal,
    inspection: { async inspectListener() { listener += 1; }, async inspectConnectedPeer() { peer += 1; } },
  });
  t.after(() => bridge.close());
  const response = await call(`${bridge.origin}/`, "GET", bridge.requestHeaders);
  assert.equal(response.status, 502, "Set-Cookie from child fails closed");
  assert.equal(listener, 1); assert.equal(peer, 1); assert.deepEqual(seen, ["GET /"]);
  const post = await call(`${bridge.origin}/`, "POST", bridge.requestHeaders);
  assert.equal(post.status, 502); assert.equal(listener, 1);
  const body = await call(`${bridge.origin}/`, "GET", {
    ...bridge.requestHeaders,
    "content-length": "1",
  }, "x");
  assert.equal(body.status, 502); assert.equal(listener, 1);
});

test("bridge forwards bounded GET response under its restrictive CSP", async (t) => {
  const child = createServer((_request, response) => { response.writeHead(200, { "content-type": "text/html" }); response.end("<button>Run</button>"); });
  child.listen(0, "127.0.0.1"); await once(child, "listening");
  const address = child.address(); assert.ok(address && typeof address !== "string");
  t.after(async () => { await new Promise<void>((resolve) => child.close(() => resolve())); });
  const bridge = await VisualAgentHttpBridge.open({ target: target(address.port), assertLive() {}, signal: new AbortController().signal, inspection: { async inspectListener() {}, async inspectConnectedPeer() {} } });
  t.after(() => bridge.close());
  const unauthorized = await call(`${bridge.origin}/`);
  assert.equal(unauthorized.status, 502);
  const response = await call(`${bridge.origin}/`, "GET", bridge.requestHeaders);
  assert.equal(response.status, 200); assert.equal(response.body, "<button>Run</button>");
  assert.match(String(response.headers["content-security-policy"]), /connect-src 'none'/u);
  assert.match(String(response.headers["content-security-policy"]), /form-action 'none'/u);
  assert.equal(response.headers["set-cookie"], undefined);
});

test("one absolute deadline aborts the full inspect-connect-peer-body chain and closes the child socket", async (t) => {
  const childSockets = new Set<Socket>();
  const child = createServer((_request, response) => {
    setTimeout(() => {
      if (!response.destroyed) {
        response.writeHead(200, { "content-type": "text/html" });
        response.end("<button>late</button>");
      }
    }, 35);
  });
  child.on("connection", (socket) => {
    childSockets.add(socket);
    socket.once("close", () => childSockets.delete(socket));
  });
  child.listen(0, "127.0.0.1");
  await once(child, "listening");
  const address = child.address();
  assert.ok(address && typeof address !== "string");
  t.after(async () => { await new Promise<void>((resolve) => child.close(() => resolve())); });
  const bridge = await VisualAgentHttpBridge.open({
    target: target(address.port),
    assertLive() {},
    signal: new AbortController().signal,
    deadlineMs: 70,
    inspection: {
      async inspectListener() {
        await new Promise((resolve) => setTimeout(resolve, 30));
      },
      async inspectConnectedPeer() {
        await new Promise((resolve) => setTimeout(resolve, 30));
      },
    },
  });
  t.after(() => bridge.close());
  const startedAt = Date.now();
  const response = await call(`${bridge.origin}/`, "GET", bridge.requestHeaders);
  const elapsedMs = Date.now() - startedAt;
  assert.equal(response.status, 502);
  assert.ok(elapsedMs >= 50, String(elapsedMs));
  assert.ok(elapsedMs < 250, String(elapsedMs));
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(childSockets.size, 0);
});
