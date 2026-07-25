import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  BrowserFrameInspectionTimeoutError,
  type BrowserFrameTarget,
  type BrowserFrameTargetResolver,
} from "../src/browser-frame-capability.ts";
import type { BrowserNetworkAddress } from "../src/browser-network-topology.ts";
import type { MesaAdapter, MesaRunRequest } from "../src/mesa-adapter.ts";
import type { OpenCodeAdapter, OpenCodePrompt, OpenCodeReadiness } from "../src/opencode-adapter.ts";
import { BackendApp, createProductBrowserFrameTargetResolver } from "../src/server.ts";
import type { HealthyVisualFrameTarget } from "../src/product-store-v2.ts";
import type { MesaModel, MesaResults, MesaRun } from "../src/types.ts";

test("production exact-app visual host is a fixed no-store self-only page", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "riff-visual-host-"));
  const app = new BackendApp({
    mesa: new FrameFakeMesa(),
    openCode: new FrameFakeOpenCode(),
    workspaceRoot: workspace,
    browserFrameTargetResolver: {
      resolve: async () => null,
      inspect: async () => false,
    },
  });
  await app.initialize();
  const network = await app.listenBrowserNetwork();
  t.after(async () => {
    await app.close();
    await rm(workspace, { recursive: true, force: true });
  });

  const path = "/browser/projects/project_alpha/runs/run_alpha/visual";
  const navigationHeaders = {
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "none",
  };
  const page = await raw(network.app, "GET", path, navigationHeaders);
  assert.equal(page.status, 200);
  assert.equal(page.headers["cache-control"], "no-store");
  assert.equal(page.headers["content-type"], "text/html; charset=utf-8");
  assert.equal(page.headers["referrer-policy"], "no-referrer");
  assert.equal(page.headers["x-content-type-options"], "nosniff");
  assert.equal(page.headers["access-control-allow-origin"], undefined);
  assert.equal(page.headers["set-cookie"], undefined);
  assert.match(
    String(page.headers["content-security-policy"]),
    new RegExp(
      `^default-src 'none'; script-src 'nonce-([a-f0-9]{32})'; connect-src 'self'; frame-src ${
        network.broker.origin.replaceAll("[", "\\[").replaceAll("]", "\\]")
      }; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'$`,
      "u",
    ),
  );
  const cspNonce = /script-src 'nonce-([^']+)'/u.exec(
    String(page.headers["content-security-policy"]),
  )?.[1];
  assert.ok(cspNonce);
  assert.match(page.text, new RegExp(`<script nonce="${cspNonce}">`, "u"));
  const inlineScript = /<script nonce="[^"]+">([\s\S]+)<\/script>/u.exec(page.text)?.[1];
  assert.ok(inlineScript);
  assert.doesNotThrow(() => new Function(inlineScript));
  assert.match(page.text, /id="visual-host" data-status="loading" data-stage="bootstrap"/u);
  assert.match(
    page.text,
    /id="visual-frame"[^>]+sandbox="allow-scripts allow-same-origin"[^>]+referrerpolicy="no-referrer"/u,
  );
  assert.match(page.text, /credentials: "same-origin"/u);
  assert.match(page.text, /new URL\(issued\.frameUrl\)\.origin !== brokerOrigin/u);
  assert.match(page.text, /host\.dataset\.status = "loaded"/u);
  assert.match(page.text, /host\.dataset\.stage = "navigation-complete"/u);
  assert.match(page.text, /host\.dataset\.errorCode = code/u);
  assert.doesNotMatch(page.text, /localStorage|sessionStorage|indexedDB/u);
  assert.doesNotMatch(page.text, /project_alpha|run_alpha/u);

  const head = await raw(network.app, "HEAD", path);
  assert.equal(head.status, 200);
  assert.equal(head.text, "");
  assert.equal(head.headers["content-length"], page.headers["content-length"]);
  assert.equal(head.headers["content-security-policy"] === page.headers["content-security-policy"], false);
  assert.match(String(head.headers["content-security-policy"]), /frame-ancestors 'self'$/u);

  const wrongMethod = await raw(network.app, "POST", path);
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.json.error.code, "browser_method_denied");

  const query = await raw(network.app, "GET", `${path}?frameUrl=must-not-be-accepted`, navigationHeaders);
  assert.equal(query.status, 404);
  assert.equal(query.json.error.code, "browser_session_denied");

  const invalidId = await raw(
    network.app,
    "GET",
    "/browser/projects/%2Fescape/runs/run_alpha/visual",
    navigationHeaders,
  );
  assert.equal(invalidId.status, 403);
  assert.equal(invalidId.json.error.code, "browser_session_denied");

  for (const headers of [
    {},
    { ...navigationHeaders, "sec-fetch-site": "same-site" },
    { ...navigationHeaders, "sec-fetch-site": "cross-site" },
    { ...navigationHeaders, "sec-fetch-mode": "cors" },
    { ...navigationHeaders, "sec-fetch-dest": "iframe" },
  ]) {
    const confusedDeputy = await raw(network.app, "GET", path, headers);
    assert.equal(confusedDeputy.status, 403);
    assert.equal(confusedDeputy.json.error.code, "browser_session_denied");
  }
});

test("BackendApp completes the one-use frame HTTP flow without leaking browser credentials", async (t) => {
  let childHeaders: IncomingHttpHeaders | undefined;
  const child = createServer((incoming, response) => {
    childHeaders = incoming.headers;
    const resources: Record<string, readonly [string, string]> = {
      "/": ["text/html; charset=utf-8", "<!doctype html><link rel=\"stylesheet\" href=\"assets/app.css\"><img src=\"assets/pixel.png\"><script src=\"assets/app.js\"></script>"],
      "/assets/app.css": ["text/css", "body{color:green}"],
      "/assets/app.js": ["text/javascript", "fetch('api/state').then(()=>globalThis.frameReady=true)"],
      "/assets/pixel.png": ["image/png", "png"],
      "/api/state": ["application/json", "{\"ok\":true}"],
    };
    const [contentType, source] = resources[incoming.url ?? "/"] ?? ["application/json", "{\"ok\":true}"];
    const body = Buffer.from(source);
    response.writeHead(200, {
      "access-control-allow-origin": "*",
      "content-length": body.byteLength,
      "content-type": contentType,
      location: "http://attacker.invalid/",
      "set-cookie": "child=secret",
    });
    response.end(body);
  });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  const childAddress = child.address();
  assert.ok(childAddress && typeof childAddress !== "string");

  const target: BrowserFrameTarget = Object.freeze({
    projectId: "project_alpha",
    runId: "run_alpha",
    attemptGeneration: 3,
    port: childAddress.port,
    expiresAtMs: Date.now() + 120_000,
  });
  let current = true;
  const targets: BrowserFrameTargetResolver = {
    resolve: async (projectId, runId) =>
      current && projectId === target.projectId && runId === target.runId ? target : null,
    inspect: async (candidate) => current
      && candidate.projectId === target.projectId
      && candidate.runId === target.runId
      && candidate.attemptGeneration === target.attemptGeneration
      && candidate.port === target.port
      && candidate.expiresAtMs === target.expiresAtMs,
  };
  const workspace = await mkdtemp(join(tmpdir(), "riff-frame-api-"));
  const app = new BackendApp({
    mesa: new FrameFakeMesa(),
    openCode: new FrameFakeOpenCode(),
    workspaceRoot: workspace,
    browserFrameTargetResolver: targets,
  });
  await app.initialize();
  const network = await app.listenBrowserNetwork();
  t.after(async () => {
    await app.close();
    await new Promise<void>((resolve, reject) =>
      child.close((error) => error ? reject(error) : resolve()));
    await rm(workspace, { recursive: true, force: true });
  });

  const appBoundary = {
    origin: network.app.origin,
    "sec-fetch-site": "same-origin",
  };
  const bootstrap = await raw(network.app, "POST", "/api/browser-session/bootstrap", appBoundary);
  assert.equal(bootstrap.status, 201);
  assert.equal(bootstrap.json.schemaVersion, 1);
  assert.match(bootstrap.json.csrfToken, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(bootstrap.headers["access-control-allow-origin"], network.app.origin);
  const appCookie = cookiePair(bootstrap.headers["set-cookie"]);

  const issued = await raw(
    network.app,
    "POST",
    "/api/projects/project_alpha/runs/run_alpha/visual-frame-session",
    {
      ...appBoundary,
      cookie: appCookie,
      "x-riff-csrf": bootstrap.json.csrfToken,
    },
  );
  assert.equal(issued.status, 201);
  const frameUrl = new URL(issued.json.frameUrl);
  assert.equal(frameUrl.origin, network.broker.origin);

  const redeemed = await raw(network.broker, "GET", `${frameUrl.pathname}${frameUrl.search}`);
  assert.equal(redeemed.status, 303);
  assert.match(String(redeemed.headers.location), /^\/frame\/c\/[A-Za-z0-9_-]{43}\/$/u);
  assert.doesNotMatch(String(redeemed.headers.location), /redeem|nonce/u);
  const brokerCookie = cookiePair(redeemed.headers["set-cookie"]);

  const replay = await raw(network.broker, "GET", frameUrl.pathname);
  assert.equal(replay.status, 404);
  assert.equal(replay.json.error.code, "visual_frame_nonce_invalid");

  const proxied = await raw(network.broker, "GET", String(redeemed.headers.location), {
    accept: "text/html",
    authorization: "Bearer must-not-cross",
    cookie: brokerCookie,
    origin: network.broker.origin,
  });
  assert.equal(proxied.status, 200);
  assert.match(proxied.text, /href="assets\/app\.css"/u);
  assert.match(proxied.text, /src="assets\/app\.js"/u);
  assert.equal(proxied.headers["set-cookie"], undefined);
  assert.equal(proxied.headers.location, undefined);
  assert.equal(proxied.headers["access-control-allow-origin"], undefined);
  assert.equal(
    proxied.headers["content-security-policy"],
    `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; frame-ancestors ${network.app.origin}`,
  );
  assert.equal(childHeaders?.host, `127.0.0.1:${target.port}`);
  assert.equal(childHeaders?.cookie, undefined);
  assert.equal(childHeaders?.authorization, undefined);
  assert.equal(childHeaders?.origin, undefined);

  const base = String(redeemed.headers.location);
  const css = await raw(network.broker, "GET", `${base}assets/app.css`, { cookie: brokerCookie });
  assert.equal(css.status, 200);
  assert.equal(css.headers["content-type"], "text/css");
  const script = await raw(network.broker, "GET", `${base}assets/app.js`, { cookie: brokerCookie });
  assert.equal(script.status, 200);
  assert.equal(script.headers["content-type"], "text/javascript");
  const image = await raw(network.broker, "GET", `${base}assets/pixel.png`, { cookie: brokerCookie });
  assert.equal(image.status, 200);
  assert.equal(image.headers["content-type"], "image/png");
  const data = await raw(network.broker, "GET", `${base}api/state`, { cookie: brokerCookie });
  assert.equal(data.status, 200);
  assert.deepEqual(data.json, { ok: true });
  const rootAbsolute = await raw(network.broker, "GET", "/assets/app.js", { cookie: brokerCookie });
  assert.equal(rootAbsolute.status, 404);
  assert.equal(rootAbsolute.json.error.code, "broker_route_denied");

  current = false;
  const stale = await raw(network.broker, "GET", String(redeemed.headers.location), {
    cookie: brokerCookie,
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.error.code, "visual_frame_unavailable");

  current = true;
  const rotatedBootstrap = await raw(network.app, "POST", "/api/browser-session/bootstrap", appBoundary);
  const rotatedIssued = await raw(
    network.app,
    "POST",
    "/api/projects/project_alpha/runs/run_alpha/visual-frame-session",
    {
      ...appBoundary,
      cookie: cookiePair(rotatedBootstrap.headers["set-cookie"]),
      "x-riff-csrf": rotatedBootstrap.json.csrfToken,
    },
  );
  const rotatedFrame = new URL(rotatedIssued.json.frameUrl);
  const rotatedRedeem = await raw(network.broker, "GET", rotatedFrame.pathname);
  const rotatedCookie = cookiePair(rotatedRedeem.headers["set-cookie"]);
  await raw(network.app, "POST", "/api/browser-session/bootstrap", appBoundary);
  const revoked = await raw(network.broker, "GET", String(rotatedRedeem.headers.location), {
    cookie: rotatedCookie,
  });
  assert.equal(revoked.status, 403);
  assert.equal(revoked.json.error.code, "visual_frame_session_denied");
});

test("platform frame endpoints reject foreign origins, missing CSRF, methods, and Vite origins", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "riff-frame-api-negative-"));
  const targets: BrowserFrameTargetResolver = {
    resolve: async () => null,
    inspect: async () => false,
  };
  const app = new BackendApp({
    mesa: new FrameFakeMesa(),
    openCode: new FrameFakeOpenCode(),
    workspaceRoot: workspace,
    browserFrameTargetResolver: targets,
  });
  await app.initialize();
  const network = await app.listenBrowserNetwork();
  t.after(async () => {
    await app.close();
    await rm(workspace, { recursive: true, force: true });
  });

  for (const headers of [
    { origin: "http://localhost:5173", "sec-fetch-site": "same-site" },
    { origin: "null", "sec-fetch-site": "cross-site" },
    { origin: network.broker.origin, "sec-fetch-site": "same-site" },
    { origin: network.app.origin, "sec-fetch-site": "same-origin", authorization: "Bearer agent" },
  ]) {
    const denied = await raw(network.app, "POST", "/api/browser-session/bootstrap", headers);
    assert.equal(denied.status, 403);
    assert.equal(denied.json.error.code, "browser_session_denied");
    assert.equal(
      denied.headers["access-control-allow-origin"],
      headers.origin === network.app.origin ? network.app.origin : undefined,
    );
  }

  const wrongMethod = await raw(network.app, "GET", "/api/browser-session/bootstrap", {
    origin: network.app.origin,
    "sec-fetch-site": "same-origin",
  });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.json.error.code, "browser_method_denied");

  const bootstrap = await raw(network.app, "POST", "/api/browser-session/bootstrap", {
    origin: network.app.origin,
    "sec-fetch-site": "same-origin",
  });
  const missingCsrf = await raw(
    network.app,
    "POST",
    "/api/projects/project_alpha/runs/run_alpha/visual-frame-session",
    {
      origin: network.app.origin,
      "sec-fetch-site": "same-origin",
      cookie: cookiePair(bootstrap.headers["set-cookie"]),
    },
  );
  assert.equal(missingCsrf.status, 403);
  assert.equal(missingCsrf.json.error.code, "browser_session_denied");

  const invalidId = await raw(
    network.app,
    "POST",
    "/api/projects/%2Fescape/runs/run_alpha/visual-frame-session",
    {
      origin: network.app.origin,
      "sec-fetch-site": "same-origin",
      cookie: cookiePair(bootstrap.headers["set-cookie"]),
      "x-riff-csrf": bootstrap.json.csrfToken,
    },
  );
  assert.equal(invalidId.status, 403);
  assert.equal(invalidId.json.error.code, "browser_session_denied");

  const preflight = await raw(network.app, "OPTIONS", "/api/browser-session/bootstrap", {
    origin: network.app.origin,
    "sec-fetch-site": "same-origin",
    "access-control-request-method": "POST",
    "access-control-request-headers": "Content-Type, X-Riff-CSRF",
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers["access-control-allow-origin"], network.app.origin);
  assert.equal(preflight.headers["access-control-allow-credentials"], "true");
});

test("production frame resolver revalidates Store identity and serializes asynchronous OS inspections", async () => {
  let generation = 3;
  const attemptExpiresAt = new Date(Date.now() + 120_000).toISOString();
  const healthyAt = new Date().toISOString();
  const healthy = (): HealthyVisualFrameTarget => Object.freeze({
    projectId: "project_alpha",
    runId: "run_alpha",
    attemptId: "attempt_alpha",
    attemptGeneration: generation,
    dispatcherGeneration: "d".repeat(64),
    attemptExpiresAt,
    processAttemptId: "process_alpha",
    pid: 9_001,
    processStartToken: "Fri Jul 25 10:00:00 2026",
    processGroupId: 9_001,
    loopbackHost: "127.0.0.1",
    loopbackPort: 41_237,
    healthPath: "/healthz",
    healthyAt,
  });
  let active = 0;
  let maxActive = 0;
  const resolver = createProductBrowserFrameTargetResolver(
    { currentHealthyVisualFrameTarget: () => healthy() },
    async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active -= 1;
      return true;
    },
  );
  const target = await resolver.resolve("project_alpha", "run_alpha");
  assert.ok(target);
  assert.deepEqual(target, {
    projectId: "project_alpha",
    runId: "run_alpha",
    attemptGeneration: 3,
    port: 41_237,
    expiresAtMs: Date.parse(attemptExpiresAt),
  });
  assert.deepEqual(await Promise.all([
    resolver.inspect(target),
    resolver.inspect(target),
    resolver.inspect(target),
  ]), [true, true, true]);
  assert.equal(maxActive, 1);
  generation = 4;
  assert.equal(await resolver.inspect(target), false);
});

test("production frame resolver bounds its global asynchronous inspection queue", async () => {
  const attemptExpiresAt = new Date(Date.now() + 120_000).toISOString();
  const healthyAt = new Date().toISOString();
  const healthy: HealthyVisualFrameTarget = Object.freeze({
    projectId: "project_alpha",
    runId: "run_alpha",
    attemptId: "attempt_alpha",
    attemptGeneration: 1,
    dispatcherGeneration: "d".repeat(64),
    attemptExpiresAt,
    processAttemptId: "process_alpha",
    pid: 9_001,
    processStartToken: "Fri Jul 25 10:00:00 2026",
    processGroupId: 9_001,
    loopbackHost: "127.0.0.1",
    loopbackPort: 41_237,
    healthPath: "/healthz",
    healthyAt,
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const resolver = createProductBrowserFrameTargetResolver(
    { currentHealthyVisualFrameTarget: () => healthy },
    async () => {
      await gate;
      return true;
    },
  );
  const target = await resolver.resolve(healthy.projectId, healthy.runId);
  assert.ok(target);
  const inspections = Array.from({ length: 17 }, () => resolver.inspect(target));
  await new Promise<void>((resolve) => setImmediate(resolve));
  release();
  const results = await Promise.all(inspections);
  assert.equal(results.filter((value) => value).length, 16);
  assert.equal(results.filter((value) => !value).length, 1);
});

test("production frame resolver rejects Store generation change during asynchronous inspection", async () => {
  let generation = 1;
  let entered!: () => void;
  let release!: () => void;
  const inspectionEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const inspectionBlocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const attemptExpiresAt = new Date(Date.now() + 120_000).toISOString();
  const healthyAt = new Date().toISOString();
  const store = {
    currentHealthyVisualFrameTarget: (): HealthyVisualFrameTarget => Object.freeze({
      projectId: "project_alpha",
      runId: "run_alpha",
      attemptId: `attempt_${generation}`,
      attemptGeneration: generation,
      dispatcherGeneration: String(generation).repeat(64),
      attemptExpiresAt,
      processAttemptId: `process_${generation}`,
      pid: 9_000 + generation,
      processStartToken: `start-${generation}`,
      processGroupId: 9_000 + generation,
      loopbackHost: "127.0.0.1",
      loopbackPort: 41_237,
      healthPath: "/healthz",
      healthyAt,
    }),
  };
  const resolver = createProductBrowserFrameTargetResolver(store, async () => {
    entered();
    await inspectionBlocked;
    return true;
  });
  const target = await resolver.resolve("project_alpha", "run_alpha");
  assert.ok(target);
  const pending = resolver.inspect(target);
  await inspectionEntered;
  generation = 2;
  release();
  assert.equal(await pending, false);
});

test("production frame resolver applies an overall inspection queue deadline", async () => {
  const attemptExpiresAt = new Date(Date.now() + 120_000).toISOString();
  const healthy: HealthyVisualFrameTarget = Object.freeze({
    projectId: "project_alpha",
    runId: "run_alpha",
    attemptId: "attempt_alpha",
    attemptGeneration: 1,
    dispatcherGeneration: "d".repeat(64),
    attemptExpiresAt,
    processAttemptId: "process_alpha",
    pid: 9_001,
    processStartToken: "start-alpha",
    processGroupId: 9_001,
    loopbackHost: "127.0.0.1",
    loopbackPort: 41_237,
    healthPath: "/healthz",
    healthyAt: new Date().toISOString(),
  });
  const resolver = createProductBrowserFrameTargetResolver(
    { currentHealthyVisualFrameTarget: () => healthy },
    async () => new Promise<boolean>(() => undefined),
    20,
  );
  const target = await resolver.resolve(healthy.projectId, healthy.runId);
  assert.ok(target);
  const started = Date.now();
  await assert.rejects(
    resolver.inspect(target),
    (error: unknown) => error instanceof BrowserFrameInspectionTimeoutError,
  );
  assert.equal(Date.now() - started < 250, true);
});

const raw = async (
  address: BrowserNetworkAddress,
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<{
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
  json: any;
}> => new Promise((resolve, reject) => {
  const outgoing = request({
    family: 6,
    headers: { host: address.authority, ...headers },
    host: address.host,
    method,
    path,
    port: address.port,
  }, (response) => {
    const chunks: Buffer[] = [];
    response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    response.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      let json: any = {};
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        json = {};
      }
      resolve({ status: response.statusCode ?? 0, headers: response.headers, text, json });
    });
  });
  outgoing.once("error", reject);
  outgoing.end();
});

const cookiePair = (header: string | string[] | undefined): string => {
  const value = Array.isArray(header) ? header[0] : header;
  assert.ok(value);
  return value.split(";", 1)[0]!;
};

class FrameFakeMesa implements MesaAdapter {
  async loadModel(): Promise<MesaModel> { throw new Error("unused"); }
  async startRun(_projectId: string, _request: MesaRunRequest): Promise<MesaRun> { throw new Error("unused"); }
  async getRun(): Promise<MesaRun> { throw new Error("unused"); }
  async cancelRun(): Promise<MesaRun> { throw new Error("unused"); }
  async getResults(): Promise<MesaResults> { throw new Error("unused"); }
}

class FrameFakeOpenCode implements OpenCodeAdapter {
  async initialize(): Promise<OpenCodeReadiness> { return { status: "unconfigured", modelId: null }; }
  async createSession(): Promise<string> { throw new Error("unused"); }
  async prompt(_sessionId: string, _prompt: OpenCodePrompt): Promise<void> { throw new Error("unused"); }
  async abort(): Promise<void> {}
}
