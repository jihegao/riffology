import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
  BROKER_DOCUMENT_CSP,
  BrowserFrameCapability,
  BrowserFrameCapabilityError,
  BrowserFrameInspectionTimeoutError,
  FixedChildHttpTransport,
  FrameHttpTransportFailure,
  type BrowserFrameTarget,
  type BrowserFrameWebSocketOwner,
  type FrameHttpTransport,
  type FrameHttpTransportRequest,
  type FrameHttpTransportResponse,
} from "../src/browser-frame-capability.ts";

const APP_ORIGIN = "http://[::1]:8787";
const BROKER_ORIGIN = "http://[::1]:18788";
const APP_HOST = "[::1]:8787";
const BROKER_HOST = "[::1]:18788";
const WEB_SOCKET_POLICY = Object.freeze({
  path: "/events",
  subprotocols: Object.freeze(["riff.visual.v1", "riff.visual.json"]),
  maxFrameBytes: 65_536,
  maxConnections: 2,
  idleTimeoutMs: 30_000,
});

test("bootstrap requires the exact browser boundary and emits a bounded HTTP cookie", () => {
  const fixture = createFixture();
  const result = fixture.capability.bootstrap(bootstrapRequest());
  assert.equal(result.generation, 1);
  assert.equal(result.expiresAtMs, fixture.now() + 15 * 60_000);
  assert.match(result.csrfToken, /^[A-Za-z0-9_-]{43}$/u);
  assert.match(result.setCookie, /^riff_app=[A-Za-z0-9_-]{43}; Path=\/api\/; Max-Age=900;/u);
  assert.match(result.setCookie, /; HttpOnly; SameSite=Strict$/u);
  assert.doesNotMatch(result.setCookie, /(?:Domain|Secure)/u);
  assert.throws(
    () => fixture.capability.bootstrap({ ...bootstrapRequest(), method: "GET" }),
    errorCode("browser_method_denied"),
  );

  for (const request of [
    { ...bootstrapRequest(), host: "localhost:8787" },
    { ...bootstrapRequest(), origin: undefined },
    { ...bootstrapRequest(), origin: "null" },
    { ...bootstrapRequest(), origin: "http://[::1]:9999" },
    { ...bootstrapRequest(), origin: [APP_ORIGIN, APP_ORIGIN] },
    { ...bootstrapRequest(), fetchSite: "same-site" },
    { ...bootstrapRequest(), authorization: "Bearer agent" },
  ]) {
    assert.throws(() => fixture.capability.bootstrap(request), errorCode("browser_session_denied"));
  }
});

test("HTTPS mode is explicit and adds Secure to both cookie classes", async () => {
  const fixture = createFixture({
    appOrigin: "https://[::1]:8787",
    brokerOrigin: "https://[::1]:18788",
    secureCookies: true,
  });
  const bootstrap = fixture.capability.bootstrap(bootstrapRequest("https://[::1]:8787"));
  assert.match(bootstrap.setCookie, /; Secure$/u);
  const frame = await fixture.capability.issueFrameSession(
    frameRequest(bootstrap, "https://[::1]:8787"),
    { projectId: "project", runId: "run" },
  );
  const redeemed = await fixture.capability.redeem({
    method: "GET",
    host: BROKER_HOST,
    path: new URL(frame.frameUrl).pathname,
  });
  assert.match(redeemed.setCookie, /; Secure$/u);
  assert.throws(() => createFixture({
    appOrigin: "http://[::1]:8787",
    brokerOrigin: "http://[::1]:18788",
    secureCookies: true,
  }), /Secure cookie mode/u);
});

test("frame session binds exact app cookie, CSRF, target identity, and generation", async () => {
  const fixture = createFixture();
  const bootstrap = fixture.capability.bootstrap(bootstrapRequest());
  const issued = await fixture.capability.issueFrameSession(
    frameRequest(bootstrap),
    { projectId: "project", runId: "run" },
  );
  assert.equal(new URL(issued.frameUrl).origin, BROKER_ORIGIN);
  assert.match(new URL(issued.frameUrl).pathname, /^\/frame\/redeem\/[A-Za-z0-9_-]{43}$/u);
  assert.equal(issued.expiresAtMs, fixture.now() + 60_000);
  assert.deepEqual(fixture.resolved, [["project", "run"]]);

  for (const request of [
    { ...frameRequest(bootstrap), csrf: "wrong-token-value-that-is-long-enough" },
    { ...frameRequest(bootstrap), cookie: "riff_app=wrong-token-value-that-is-long-enough" },
    { ...frameRequest(bootstrap), cookie: `${cookiePair(bootstrap.setCookie)}; ${cookiePair(bootstrap.setCookie)}` },
    { ...frameRequest(bootstrap), origin: BROKER_ORIGIN },
    { ...frameRequest(bootstrap), fetchSite: undefined },
  ]) {
    await assert.rejects(
      fixture.capability.issueFrameSession(request, { projectId: "project", runId: "run" }),
      errorCode("browser_session_denied"),
    );
  }

  fixture.inspectAllowed = false;
  await assert.rejects(
    fixture.capability.issueFrameSession(frameRequest(bootstrap), { projectId: "project", runId: "run" }),
    errorCode("visual_frame_unavailable"),
  );

  const mismatched = createFixture({ target: { projectId: "other-project" } });
  const mismatchBootstrap = mismatched.capability.bootstrap(bootstrapRequest());
  await assert.rejects(
    mismatched.capability.issueFrameSession(
      frameRequest(mismatchBootstrap),
      { projectId: "project", runId: "run" },
    ),
    errorCode("visual_frame_unavailable"),
  );
});

test("nonce redemption is atomic, one-use, no-Origin, nonce-free, and independently cookied", async () => {
  const fixture = createFixture();
  const bootstrap = fixture.capability.bootstrap(bootstrapRequest());
  const issued = await fixture.capability.issueFrameSession(
    frameRequest(bootstrap),
    { projectId: "project", runId: "run" },
  );
  const request = {
    method: "GET",
    host: BROKER_HOST,
    path: new URL(issued.frameUrl).pathname,
  };
  const results = await Promise.allSettled([
    fixture.capability.redeem(request),
    fixture.capability.redeem(request),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const redeemed = (results.find((result) => result.status === "fulfilled") as PromiseFulfilledResult<any>).value;
  assert.match(redeemed.location, /^\/frame\/c\/[A-Za-z0-9_-]{43}\/$/u);
  assert.equal(redeemed.location.includes(new URL(issued.frameUrl).pathname.split("/").at(-1)!), false);
  assert.match(redeemed.setCookie, /^riff_frame_[A-Za-z0-9_-]{22}=[A-Za-z0-9_-]{43}; Path=\/frame\/c\//u);
  assert.doesNotMatch(redeemed.setCookie, new RegExp(cookiePair(bootstrap.setCookie).split("=")[1], "u"));
  await assert.rejects(
    fixture.capability.redeem({ ...request, origin: BROKER_ORIGIN }),
    errorStatus("visual_frame_nonce_invalid", 404),
  );
});

test("nonce expiry, clear, rotation, and restart invalidate browser authority", async () => {
  const fixture = createFixture();
  let bootstrap = fixture.capability.bootstrap(bootstrapRequest());
  let issued = await fixture.capability.issueFrameSession(
    frameRequest(bootstrap),
    { projectId: "project", runId: "run" },
  );
  fixture.advance(60_000);
  await assert.rejects(
    fixture.capability.redeem({ method: "GET", host: BROKER_HOST, path: new URL(issued.frameUrl).pathname }),
    errorStatus("visual_frame_nonce_invalid", 404),
  );

  fixture.advance(-60_000);
  bootstrap = fixture.capability.bootstrap(bootstrapRequest());
  issued = await fixture.capability.issueFrameSession(frameRequest(bootstrap), { projectId: "project", runId: "run" });
  fixture.capability.bootstrap(bootstrapRequest());
  await assert.rejects(
    fixture.capability.redeem({ method: "GET", host: BROKER_HOST, path: new URL(issued.frameUrl).pathname }),
    errorCode("visual_frame_nonce_invalid"),
  );

  const restarted = createFixture();
  await assert.rejects(
    restarted.capability.redeem({ method: "GET", host: BROKER_HOST, path: new URL(issued.frameUrl).pathname }),
    errorCode("visual_frame_nonce_invalid"),
  );
  fixture.capability.clear();
});

test("redeemed broker authority survives app-session expiry until its own bounded expiry", async () => {
  const fixture = createFixture();
  const bootstrap = fixture.capability.bootstrap(bootstrapRequest());
  fixture.advance(14 * 60_000 + 59_000);
  const issued = await fixture.capability.issueFrameSession(
    frameRequest(bootstrap),
    { projectId: "project", runId: "run" },
  );
  const redeemed = await fixture.capability.redeem({
    method: "GET",
    host: BROKER_HOST,
    path: new URL(issued.frameUrl).pathname,
  });
  fixture.advance(2_000);
  const response = await fixture.capability.proxy({
    method: "GET",
    host: BROKER_HOST,
    cookie: cookiePair(redeemed.setCookie),
    path: `${redeemed.location}index.html`,
  });
  assert.equal(response.status, 200);
});

test("HTTP proxy fixes the child target, normalizes the route, and exposes only allowlisted response policy", async () => {
  const fixture = createFixture();
  fixture.transport.response = {
    status: 200,
    headers: {
      "content-type": "text/html; charset=UTF-8",
      "set-cookie": "child=secret",
      location: "http://evil.test/",
      "x-child-secret": "secret",
      etag: "\"asset-v1\"",
      "last-modified": "Sat, 25 Jul 2026 00:00:00 GMT",
      "accept-ranges": "bytes",
      "cache-control": "private, max-age=30",
    },
    body: Buffer.from("<!doctype html><title>safe</title>"),
  };
  const session = await issueAndRedeem(fixture);
  const response = await fixture.capability.proxy({
    method: "GET",
    host: BROKER_HOST,
    origin: BROKER_ORIGIN,
    cookie: cookiePair(session.redeemed.setCookie),
    path: `${session.redeemed.location}assets/app.js?version=1`,
    headers: {
      accept: "text/html",
      authorization: "Bearer secret",
      cookie: "platform=secret",
      host: "evil.test",
      origin: "http://evil.test",
      "x-forwarded-host": "evil.test",
    },
  });
  assert.deepEqual(fixture.transport.requests[0], {
    method: "GET",
    host: "127.0.0.1",
    port: 4567,
    path: "/assets/app.js?version=1",
    headers: { accept: "text/html" },
    maxHeaderBytes: 32 * 1_024,
    maxBodyBytes: 8 * 1_024 * 1_024,
    timeoutMs: 5_000,
  });
  assert.equal(response.status, 200);
  assert.equal(Buffer.from(response.body).toString(), "<!doctype html><title>safe</title>");
  assert.equal(response.headers["content-security-policy"], `${BROKER_DOCUMENT_CSP}; frame-ancestors ${APP_ORIGIN}`);
  assert.equal(response.headers["cache-control"], "private, no-store");
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.equal(response.headers.etag, "\"asset-v1\"");
  assert.equal(response.headers["last-modified"], "Sat, 25 Jul 2026 00:00:00 GMT");
  assert.equal(response.headers["accept-ranges"], "bytes");
  assert.equal(response.headers["set-cookie"], undefined);
  assert.equal(response.headers.location, undefined);
  assert.doesNotMatch(JSON.stringify(response.headers), /secret|evil/u);
});

test("HTTP proxy rejects methods, bodies, duplicate cookies, origins, traversal, and stale targets before transport", async () => {
  const fixture = createFixture();
  const session = await issueAndRedeem(fixture);
  const base = {
    method: "GET",
    host: BROKER_HOST,
    cookie: cookiePair(session.redeemed.setCookie),
    path: `${session.redeemed.location}index.html`,
  };
  await assert.rejects(
    fixture.capability.proxy({ ...base, method: "POST" }),
    errorStatus("visual_frame_proxy_denied", 405),
  );
  for (const request of [
    { ...base, method: "GET", body: Buffer.from("x") },
    { ...base, host: APP_HOST },
    { ...base, origin: APP_ORIGIN },
    { ...base, cookie: `${base.cookie}; ${base.cookie}` },
    { ...base, path: `${session.redeemed.location}../secret` },
    { ...base, path: `${session.redeemed.location}%2e%2e/secret` },
    { ...base, path: `${session.redeemed.location}%2f%2fexample.test` },
    { ...base, path: `${session.redeemed.location}%5csecret` },
    { ...base, path: `${session.redeemed.location}%252fsecret` },
    { ...base, path: `${session.redeemed.location}assets//secret` },
    { ...base, path: `http://127.0.0.1:4567/` },
  ]) {
    await assert.rejects(fixture.capability.proxy(request), BrowserFrameCapabilityError);
  }
  assert.equal(fixture.transport.requests.length, 0);
  fixture.inspectAllowed = false;
  await assert.rejects(fixture.capability.proxy(base), errorCode("visual_frame_unavailable"));
  assert.equal(fixture.transport.requests.length, 0);
});

test("HTTP proxy denies redirects and oversized bodies with stable generic errors", async () => {
  const fixture = createFixture();
  const session = await issueAndRedeem(fixture);
  const request = {
    method: "GET",
    host: BROKER_HOST,
    cookie: cookiePair(session.redeemed.setCookie),
    path: `${session.redeemed.location}index.html`,
  };
  const cases: FrameHttpTransportResponse[] = [
    { status: 302, headers: { "content-type": "text/html", location: "http://evil.test" }, body: new Uint8Array() },
    { status: 200, headers: { "content-type": "text/html" }, body: new Uint8Array(8 * 1_024 * 1_024 + 1) },
  ];
  for (const response of cases) {
    fixture.transport.response = response;
    await assert.rejects(fixture.capability.proxy(request), (error: unknown) =>
      error instanceof BrowserFrameCapabilityError
      && ["visual_frame_proxy_redirect_denied", "visual_frame_proxy_denied", "visual_frame_proxy_limit_exceeded"].includes(error.code)
      && error.message === "The browser frame request was denied."
      && !JSON.stringify(error).includes("127.0.0.1"));
  }
});

test("HTTP proxy preserves non-redirect statuses, general valid MIME, HEAD length, and long allowlisted headers", async () => {
  const fixture = createFixture();
  const session = await issueAndRedeem(fixture);
  fixture.transport.response = {
    status: 404,
    headers: {
      "cache-control": "no-cache",
      "content-length": "17",
      "content-type": "application/wasm",
    },
    body: Buffer.from("not-found-payload"),
  };
  const response = await fixture.capability.proxy({
    method: "HEAD",
    host: BROKER_HOST,
    cookie: cookiePair(session.redeemed.setCookie),
    path: `${session.redeemed.location}module.wasm`,
    headers: { accept: "x".repeat(2_048) },
  });
  assert.equal(response.status, 404);
  assert.equal(response.body.byteLength, 0);
  assert.equal(response.headers["content-length"], "17");
  assert.equal(response.headers["content-type"], "application/wasm");
  assert.equal(response.headers["cache-control"], "private, no-store");
  assert.equal(fixture.transport.requests.at(-1)?.headers.accept, "x".repeat(2_048));
});

test("HTTP proxy rechecks exact target authority after the child exchange", async () => {
  const transport = new DeferredTransport();
  const fixture = createFixture();
  fixture.capability = fixture.newCapability(transport);
  const session = await issueAndRedeem(fixture);
  const pending = fixture.capability.proxy({
    method: "GET",
    host: BROKER_HOST,
    cookie: cookiePair(session.redeemed.setCookie),
    path: `${session.redeemed.location}index.html`,
  });
  await transport.entered(1);
  fixture.inspectAllowed = false;
  transport.release();
  await assert.rejects(pending, errorStatus("visual_frame_unavailable", 409));
});

test("HTTP proxy preserves validated range metadata and distinguishes transport timeout and limits", async () => {
  const fixture = createFixture();
  fixture.transport.response = {
    status: 206,
    headers: {
      "content-type": "image/png",
      "content-range": "bytes 0-3/10",
      "accept-ranges": "bytes",
    },
    body: Buffer.from([1, 2, 3, 4]),
  };
  const session = await issueAndRedeem(fixture);
  const request = {
    method: "GET",
    host: BROKER_HOST,
    cookie: cookiePair(session.redeemed.setCookie),
    path: `${session.redeemed.location}asset.png`,
    headers: { range: "bytes=0-3" },
  };
  const response = await fixture.capability.proxy(request);
  assert.equal(response.status, 206);
  assert.equal(response.headers["content-range"], "bytes 0-3/10");
  assert.equal(response.headers["accept-ranges"], "bytes");
  assert.equal(fixture.transport.requests[0].headers.range, "bytes=0-3");

  for (const [kind, code] of [
    ["timeout", "visual_frame_proxy_timeout"],
    ["limit", "visual_frame_proxy_limit_exceeded"],
  ] as const) {
    const failing = createFixture();
    failing.capability = failing.newCapability({
      request: async () => {
        throw new FrameHttpTransportFailure(kind);
      },
    });
    const failingSession = await issueAndRedeem(failing);
    await assert.rejects(
      failing.capability.proxy({
        method: "GET",
        host: BROKER_HOST,
        cookie: cookiePair(failingSession.redeemed.setCookie),
        path: `${failingSession.redeemed.location}index.html`,
      }),
      errorCode(code),
    );
  }
});

test("HTTP proxy enforces eight concurrent requests per capability", async () => {
  const fixture = createFixture();
  const deferred = new DeferredTransport();
  fixture.capability = fixture.newCapability(deferred);
  const session = await issueAndRedeem(fixture);
  const request = {
    method: "GET",
    host: BROKER_HOST,
    cookie: cookiePair(session.redeemed.setCookie),
    path: `${session.redeemed.location}index.html`,
  };
  const firstEight = Array.from({ length: 8 }, () => fixture.capability.proxy(request));
  await deferred.entered(8);
  await assert.rejects(fixture.capability.proxy(request), errorCode("visual_frame_proxy_limit_exceeded"));
  deferred.release();
  assert.equal((await Promise.all(firstEight)).length, 8);
});

test("WebSocket admission freezes the exact broker path, origin, cookie, upgrade, and subprotocol policy", async () => {
  const fixture = createFixture({ target: { webSocket: WEB_SOCKET_POLICY } });
  const session = await issueAndRedeem(fixture);
  const owner = new RecordingWebSocketOwner();
  const admission = await fixture.capability.admitWebSocket(
    webSocketRequest(session.redeemed, {
      protocols: "riff.visual.json, riff.visual.v1",
      extensions: "permessage-deflate; client_max_window_bits",
    }),
    owner,
  );
  assert.equal(admission.childPath, "/events");
  assert.deepEqual(admission.offeredSubprotocols, ["riff.visual.json", "riff.visual.v1"]);
  assert.equal(admission.maxFrameBytes, 65_536);
  assert.equal(admission.idleTimeoutMs, 30_000);
  assert.equal(admission.live(), true);
  assert.equal(Object.isFrozen(admission.target.webSocket), true);
  assert.equal(Object.isFrozen(admission.target.webSocket?.subprotocols), true);
  await admission.recheck();
  admission.markOpen();
  admission.release();
  assert.equal(admission.live(), false);
  assert.deepEqual(owner.codes, []);
});

test("WebSocket connected-peer recheck binds the exact child socket before repeating Store authority", async () => {
  const observations: string[] = [];
  const fixture = createFixture({
    target: { webSocket: WEB_SOCKET_POLICY },
    inspectConnectedPeer: async (target, peer) => {
      observations.push(`peer:${target.port}:${peer.localPort}:${peer.remotePort}`);
      return true;
    },
  });
  const originalInspect = fixture.inspectTarget;
  fixture.inspectTarget = async () => {
    observations.push("target");
    return originalInspect();
  };
  const session = await issueAndRedeem(fixture);
  observations.length = 0;
  const admission = await fixture.capability.admitWebSocket(
    webSocketRequest(session.redeemed, { protocols: "riff.visual.v1" }),
    new RecordingWebSocketOwner(),
  );
  observations.length = 0;
  await admission.recheckConnected({
    localHost: "127.0.0.1",
    localPort: 52_001,
    remoteHost: "127.0.0.1",
    remotePort: 4_567,
  });
  assert.deepEqual(observations, ["peer:4567:52001:4567", "target"]);
  assert.equal(admission.live(), true);
  admission.release();
});

test("WebSocket connected-peer recheck releases the slot when peer inspection is absent or false", async () => {
  for (const inspectConnectedPeer of [
    undefined,
    async () => false,
    async () => { throw new Error("private peer inspection failure"); },
  ]) {
    const fixture = createFixture({
      target: { webSocket: WEB_SOCKET_POLICY },
      ...(inspectConnectedPeer ? { inspectConnectedPeer } : {}),
    });
    const session = await issueAndRedeem(fixture);
    const admission = await fixture.capability.admitWebSocket(
      webSocketRequest(session.redeemed, { protocols: "riff.visual.v1" }),
      new RecordingWebSocketOwner(),
    );
    await assert.rejects(
      admission.recheckConnected({
        localHost: "127.0.0.1",
        localPort: 52_001,
        remoteHost: "127.0.0.1",
        remotePort: 4_567,
      }),
      errorStatus("visual_frame_unavailable", 409),
    );
    assert.equal(admission.live(), false);
  }
});

test("WebSocket inspection timeout is 504 while HTTP inspection denial remains 409", async () => {
  const httpFixture = createFixture();
  const bootstrap = httpFixture.capability.bootstrap(bootstrapRequest());
  httpFixture.inspectTarget = async () => {
    throw new BrowserFrameInspectionTimeoutError();
  };
  await assert.rejects(
    httpFixture.capability.issueFrameSession(
      frameRequest(bootstrap),
      { projectId: "project", runId: "run" },
    ),
    errorStatus("visual_frame_unavailable", 409),
  );

  const initialTimeout = createFixture({ target: { webSocket: WEB_SOCKET_POLICY } });
  const initialSession = await issueAndRedeem(initialTimeout);
  initialTimeout.inspectTarget = async () => {
    throw new BrowserFrameInspectionTimeoutError();
  };
  await assert.rejects(
    initialTimeout.capability.admitWebSocket(
      webSocketRequest(initialSession.redeemed, { protocols: "riff.visual.v1" }),
      new RecordingWebSocketOwner(),
    ),
    errorStatus("visual_websocket_timeout", 504),
  );

  const connectedTimeout = createFixture({
    target: { webSocket: WEB_SOCKET_POLICY },
    inspectConnectedPeer: async () => {
      throw new BrowserFrameInspectionTimeoutError();
    },
  });
  const connectedSession = await issueAndRedeem(connectedTimeout);
  const admission = await connectedTimeout.capability.admitWebSocket(
    webSocketRequest(connectedSession.redeemed, { protocols: "riff.visual.v1" }),
    new RecordingWebSocketOwner(),
  );
  await assert.rejects(
    admission.recheckConnected({
      localHost: "127.0.0.1",
      localPort: 52_001,
      remoteHost: "127.0.0.1",
      remotePort: 4_567,
    }),
    errorStatus("visual_websocket_timeout", 504),
  );
  assert.equal(admission.live(), false);
});

test("WebSocket admission rejects every wrong raw upgrade or policy field with stable pre-101 pairs", async () => {
  const fixture = createFixture({ target: { webSocket: WEB_SOCKET_POLICY } });
  const session = await issueAndRedeem(fixture);
  const base = webSocketRequest(session.redeemed, { protocols: "riff.visual.v1" });
  const cases: Array<{
    request: typeof base;
    code: BrowserFrameCapabilityError["code"];
    status: number;
  }> = [
    { request: { ...base, method: "POST" }, code: "visual_websocket_protocol_denied", status: 405 },
    { request: { ...base, host: APP_HOST }, code: "visual_frame_session_denied", status: 403 },
    { request: { ...base, origin: undefined }, code: "visual_frame_session_denied", status: 403 },
    { request: { ...base, origin: [BROKER_ORIGIN, BROKER_ORIGIN] }, code: "visual_frame_session_denied", status: 403 },
    { request: { ...base, cookie: "riff_frame_wrong=wrong-token-value-that-is-long-enough" }, code: "visual_frame_session_denied", status: 403 },
    { request: { ...base, authorization: "Bearer agent" }, code: "visual_frame_session_denied", status: 403 },
    { request: { ...base, path: `${session.redeemed.location}other` }, code: "visual_websocket_not_declared", status: 404 },
    { request: { ...base, path: `${session.redeemed.location}events?query=1` }, code: "visual_websocket_not_declared", status: 404 },
    { request: { ...base, protocols: undefined }, code: "visual_websocket_protocol_denied", status: 403 },
    { request: { ...base, protocols: "not-declared" }, code: "visual_websocket_protocol_denied", status: 403 },
    { request: { ...base, protocols: "riff.visual.v1, riff.visual.v1" }, code: "visual_websocket_protocol_denied", status: 403 },
    { request: { ...base, protocols: ["riff.visual.v1", "riff.visual.json"] }, code: "visual_websocket_protocol_denied", status: 403 },
    { request: { ...base, upgrade: ["websocket", "websocket"] }, code: "visual_websocket_protocol_denied", status: 400 },
    { request: { ...base, connection: ["Upgrade", "Upgrade"] }, code: "visual_websocket_protocol_denied", status: 400 },
    { request: { ...base, version: ["13", "13"] }, code: "visual_websocket_protocol_denied", status: 400 },
    { request: { ...base, key: ["AQEBAQEBAQEBAQEBAQEBAQ==", "AgICAgICAgICAgICAgICAg=="] }, code: "visual_websocket_protocol_denied", status: 400 },
    { request: { ...base, extensions: ["permessage-deflate", "permessage-deflate"] }, code: "visual_websocket_protocol_denied", status: 400 },
  ];
  for (const entry of cases) {
    await assert.rejects(
      fixture.capability.admitWebSocket(entry.request, new RecordingWebSocketOwner()),
      errorStatus(entry.code, entry.status),
    );
  }

  const noProtocol = createFixture({
    target: { webSocket: { ...WEB_SOCKET_POLICY, subprotocols: Object.freeze([]) } },
  });
  const noProtocolSession = await issueAndRedeem(noProtocol);
  const admission = await noProtocol.capability.admitWebSocket(
    webSocketRequest(noProtocolSession.redeemed),
    new RecordingWebSocketOwner(),
  );
  admission.release();
  await assert.rejects(
    noProtocol.capability.admitWebSocket(
      webSocketRequest(noProtocolSession.redeemed, { protocols: "riff.visual.v1" }),
      new RecordingWebSocketOwner(),
    ),
    errorStatus("visual_websocket_protocol_denied", 403),
  );

  const undeclared = createFixture();
  const undeclaredSession = await issueAndRedeem(undeclared);
  await assert.rejects(
    undeclared.capability.admitWebSocket(
      webSocketRequest(undeclaredSession.redeemed),
      new RecordingWebSocketOwner(),
    ),
    errorStatus("visual_websocket_not_declared", 404),
  );
});

test("WebSocket pending and open slots are attempt-global and revoke closes owners before authority removal", async () => {
  const fixture = createFixture({
    target: {
      webSocket: { ...WEB_SOCKET_POLICY, subprotocols: Object.freeze([]), maxConnections: 1 },
    },
  });
  const first = await issueAndRedeem(fixture);
  const secondIssued = await fixture.capability.issueFrameSession(
    frameRequest(first.bootstrap),
    { projectId: "project", runId: "run" },
  );
  const secondRedeemed = await fixture.capability.redeem({
    method: "GET",
    host: BROKER_HOST,
    path: new URL(secondIssued.frameUrl).pathname,
  });
  let entered!: () => void;
  let releaseInspection!: () => void;
  const inspectionEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const inspectionBlocked = new Promise<void>((resolve) => {
    releaseInspection = resolve;
  });
  fixture.inspectTarget = async () => {
    entered();
    await inspectionBlocked;
    return true;
  };
  const owner = new RecordingWebSocketOwner();
  const pending = fixture.capability.admitWebSocket(
    webSocketRequest(first.redeemed),
    owner,
  );
  await inspectionEntered;
  await assert.rejects(
    fixture.capability.admitWebSocket(
      webSocketRequest(secondRedeemed),
      new RecordingWebSocketOwner(),
    ),
    errorStatus("visual_websocket_limit", 429),
  );
  fixture.capability.revokeRun("run");
  assert.deepEqual(owner.codes, [1008]);
  releaseInspection();
  await assert.rejects(pending, errorStatus("visual_frame_session_denied", 403));
});

test("revoke removes pending nonce and redeemed HTTP authority", async () => {
  const fixture = createFixture();
  let session = await issueAndRedeem(fixture);
  fixture.capability.revoke("project", "run");
  await assert.rejects(
    fixture.capability.proxy({
      method: "GET",
      host: BROKER_HOST,
      cookie: cookiePair(session.redeemed.setCookie),
      path: `${session.redeemed.location}index.html`,
    }),
    errorCode("visual_frame_session_denied"),
  );

  const bootstrap = fixture.capability.bootstrap(bootstrapRequest());
  const issued = await fixture.capability.issueFrameSession(frameRequest(bootstrap), { projectId: "project", runId: "run" });
  fixture.capability.revoke("project");
  await assert.rejects(
    fixture.capability.redeem({ method: "GET", host: BROKER_HOST, path: new URL(issued.frameUrl).pathname }),
    errorCode("visual_frame_nonce_invalid"),
  );
});

test("native transport sends no browser credentials to a fixed IPv4 child", async (t) => {
  let observed: Record<string, unknown> | undefined;
  const child = createServer((request, response) => {
    observed = {
      host: request.headers.host,
      authorization: request.headers.authorization,
      cookie: request.headers.cookie,
      forwarded: request.headers.forwarded,
      acceptEncoding: request.headers["accept-encoding"],
      url: request.url,
    };
    const body = Buffer.from("body");
    response.writeHead(200, {
      "content-length": body.byteLength,
      "content-type": "text/plain",
      "set-cookie": "child=secret",
    });
    response.end(body);
  });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  t.after(() => new Promise<void>((resolve) => child.close(() => resolve())));
  const address = child.address();
  assert.ok(address && typeof address !== "string");
  const fixture = createFixture({ target: { port: address.port } });
  const session = await issueAndRedeem(fixture);
  const response = await fixture.capability.proxy({
    method: "GET",
    host: BROKER_HOST,
    cookie: cookiePair(session.redeemed.setCookie),
    path: `${session.redeemed.location}asset.txt`,
    headers: {
      accept: "text/plain",
      authorization: "Bearer browser-secret",
      cookie: "riff_app=browser-secret",
      forwarded: "for=evil",
    },
  });
  assert.equal(Buffer.from(response.body).toString(), "body");
  assert.deepEqual(observed, {
    host: `127.0.0.1:${address.port}`,
    authorization: undefined,
    cookie: undefined,
    forwarded: undefined,
    acceptEncoding: "identity",
    url: "/asset.txt",
  });
  assert.equal(response.headers["set-cookie"], undefined);
});

test("native transport enforces real header, streaming body, and deadline bounds", async (t) => {
  const child = createServer((request, response) => {
    if (request.url === "/slow") {
      setTimeout(() => {
        if (!response.destroyed) response.end("late");
      }, 100).unref?.();
      return;
    }
    if (request.url === "/headers") {
      response.writeHead(200, {
        "content-type": "text/plain",
        "x-large": "x".repeat(256),
      });
      response.end("ok");
      return;
    }
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("x".repeat(64));
  });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  t.after(() => new Promise<void>((resolve) => child.close(() => resolve())));
  const address = child.address();
  assert.ok(address && typeof address !== "string");
  const transport = new FixedChildHttpTransport();
  const base = {
    method: "GET" as const,
    host: "127.0.0.1" as const,
    port: address.port,
    headers: {},
  };
  await assert.rejects(
    transport.request({ ...base, path: "/body", maxHeaderBytes: 32_768, maxBodyBytes: 16, timeoutMs: 1_000 }),
    (error: unknown) => error instanceof FrameHttpTransportFailure && error.kind === "limit",
  );
  await assert.rejects(
    transport.request({ ...base, path: "/headers", maxHeaderBytes: 128, maxBodyBytes: 1_024, timeoutMs: 1_000 }),
    (error: unknown) => error instanceof FrameHttpTransportFailure && error.kind === "limit",
  );
  await assert.rejects(
    transport.request({ ...base, path: "/slow", maxHeaderBytes: 32_768, maxBodyBytes: 1_024, timeoutMs: 20 }),
    (error: unknown) => error instanceof FrameHttpTransportFailure && error.kind === "timeout",
  );
});

test("constructor and injected dependencies fail closed", () => {
  assert.throws(() => createFixture({ appOrigin: "http://localhost:8787" }), /exact bracketed IPv6/u);
  assert.throws(() => createFixture({ brokerOrigin: APP_ORIGIN }), /must be distinct/u);
  const fixture = createFixture({ random: () => new Uint8Array(31) });
  assert.throws(() => fixture.capability.bootstrap(bootstrapRequest()), /CSPRNG returned an invalid result/u);
});

type FixtureOptions = {
  appOrigin?: string;
  brokerOrigin?: string;
  secureCookies?: boolean;
  random?: (size: number) => Uint8Array;
  target?: Partial<BrowserFrameTarget>;
  inspectConnectedPeer?: NonNullable<
    ConstructorParameters<typeof BrowserFrameCapability>[0]["targets"]["inspectConnectedPeer"]
  >;
};

const createFixture = (options: FixtureOptions = {}) => {
  let current = 1_800_000_000_000;
  let randomSequence = 0;
  const resolved: Array<[string, string]> = [];
  const transport = new RecordingTransport();
  const fixture = {
    appOrigin: options.appOrigin ?? APP_ORIGIN,
    now: () => current,
    advance: (milliseconds: number) => {
      current += milliseconds;
    },
    inspectAllowed: true,
    resolved,
    transport,
    capability: undefined as unknown as BrowserFrameCapability,
    newCapability: (selectedTransport: FrameHttpTransport | null = transport) => new BrowserFrameCapability({
      appOrigin: options.appOrigin ?? APP_ORIGIN,
      brokerOrigin: options.brokerOrigin ?? BROKER_ORIGIN,
      secureCookies: options.secureCookies,
      now: () => current,
      random: options.random ?? ((size) => {
        randomSequence += 1;
        return new Uint8Array(size).fill(randomSequence);
      }),
      targets: {
        resolve: async (projectId, runId) => {
          resolved.push([projectId, runId]);
          return Object.freeze({
            projectId: options.target?.projectId ?? projectId,
            runId: options.target?.runId ?? runId,
            attemptGeneration: options.target?.attemptGeneration ?? 3,
            port: options.target?.port ?? 4567,
            expiresAtMs: options.target?.expiresAtMs ?? current + 30 * 60_000,
            ...(options.target?.webSocket ? { webSocket: options.target.webSocket } : {}),
          });
        },
        inspect: async () => fixture.inspectTarget(),
        ...(options.inspectConnectedPeer
          ? { inspectConnectedPeer: options.inspectConnectedPeer }
          : {}),
      },
      ...(selectedTransport ? { transport: selectedTransport } : {}),
    }),
    inspectTarget: async (): Promise<boolean> => fixture.inspectAllowed,
  };
  fixture.capability = fixture.newCapability(options.target?.port ? null : transport);
  return fixture;
};

class RecordingTransport implements FrameHttpTransport {
  requests: FrameHttpTransportRequest[] = [];
  response: FrameHttpTransportResponse = {
    status: 200,
    headers: { "content-type": "text/html" },
    body: Buffer.from("<!doctype html>"),
  };
  async request(input: FrameHttpTransportRequest): Promise<FrameHttpTransportResponse> {
    this.requests.push(input);
    return this.response;
  }
}

class DeferredTransport implements FrameHttpTransport {
  #entered = 0;
  #enteredWaiters: Array<() => void> = [];
  #release?: () => void;
  readonly #released = new Promise<void>((resolve) => {
    this.#release = resolve;
  });
  async request(): Promise<FrameHttpTransportResponse> {
    this.#entered += 1;
    for (const waiter of this.#enteredWaiters.splice(0)) waiter();
    await this.#released;
    return { status: 200, headers: { "content-type": "text/html" }, body: Buffer.from("ok") };
  }
  async entered(count: number): Promise<void> {
    while (this.#entered < count) {
      await new Promise<void>((resolve) => this.#enteredWaiters.push(resolve));
    }
  }
  release(): void {
    this.#release?.();
  }
}

class RecordingWebSocketOwner implements BrowserFrameWebSocketOwner {
  readonly codes: number[] = [];
  close(code: 1008): void {
    this.codes.push(code);
  }
}

const bootstrapRequest = (origin = APP_ORIGIN) => ({
  method: "POST",
  host: APP_HOST,
  origin,
  fetchSite: "same-origin",
});

const frameRequest = (
  bootstrap: { csrfToken: string; setCookie: string },
  origin = APP_ORIGIN,
) => ({
  ...bootstrapRequest(origin),
  cookie: cookiePair(bootstrap.setCookie),
  csrf: bootstrap.csrfToken,
});

const issueAndRedeem = async (fixture: ReturnType<typeof createFixture>) => {
  const bootstrap = fixture.capability.bootstrap(bootstrapRequest(fixture.appOrigin));
  const issued = await fixture.capability.issueFrameSession(
    frameRequest(bootstrap, fixture.appOrigin),
    { projectId: "project", runId: "run" },
  );
  const brokerHost = new URL(issued.frameUrl).host;
  const redeemed = await fixture.capability.redeem({
    method: "GET",
    host: brokerHost,
    path: new URL(issued.frameUrl).pathname,
  });
  return { bootstrap, issued, redeemed };
};

const webSocketRequest = (
  redeemed: { location: string; setCookie: string },
  overrides: Partial<{
    method: string;
    host: string | undefined;
    origin: string | readonly string[] | undefined;
    cookie: string | readonly string[] | undefined;
    authorization: string | readonly string[] | undefined;
    path: string;
    protocols: string | readonly string[] | undefined;
    upgrade: string | readonly string[] | undefined;
    connection: string | readonly string[] | undefined;
    version: string | readonly string[] | undefined;
    key: string | readonly string[] | undefined;
    extensions: string | readonly string[] | undefined;
  }> = {},
) => ({
  method: "GET",
  host: BROKER_HOST,
  origin: BROKER_ORIGIN,
  cookie: cookiePair(redeemed.setCookie),
  path: `${redeemed.location}events`,
  upgrade: "websocket",
  connection: "keep-alive, Upgrade",
  version: "13",
  key: "AQEBAQEBAQEBAQEBAQEBAQ==",
  ...overrides,
});

const cookiePair = (setCookie: string): string => setCookie.split(";", 1)[0];

const errorCode = (code: BrowserFrameCapabilityError["code"]) => (error: unknown): boolean =>
  error instanceof BrowserFrameCapabilityError
  && error.code === code
  && error.message === "The browser frame request was denied."
  && !Object.hasOwn(error, "cause");

const errorStatus = (
  code: BrowserFrameCapabilityError["code"],
  status: number,
) => (error: unknown): boolean => errorCode(code)(error)
  && (error as BrowserFrameCapabilityError).status === status;
