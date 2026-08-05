import assert from "node:assert/strict";
import { createServer, request as httpRequest, type Server } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  OpenCodeAssistantResponse,
  OpenCodeConversationPort,
  OpenCodePrompt,
  OpenCodeProviderModel,
  OpenCodeReadiness,
} from "../src/opencode-adapter.ts";
import {
  BackendApp,
  WorkbenchObservationTargetRegistry,
  WorkbenchVisualServiceFrameRegistry,
  workbenchObservationTargetMatches,
} from "../src/server.ts";
import { registerLocalBrowserTarget } from "../src/local-browser-broker.ts";

const NOW = "2026-08-02T00:00:00.000Z";

test("default observation target tokens expire and revoke with their exact scope", () => {
  let now = 1_000;
  const registry = new WorkbenchObservationTargetRegistry(1_000, () => now);
  const scope = { conversationId: "conversation_registry", conversationGeneration: 4 };
  const token = registry.register(scope, { kind: "project", id: "project_registry" });
  assert.equal(token.length, 43);
  assert.deepEqual(registry.resolve(token)?.owner, { kind: "project", id: "project_registry" });
  now += 1_001;
  assert.equal(registry.resolve(token), null);

  const revoked = registry.register(scope, { kind: "project", id: "project_registry" });
  registry.revoke(scope);
  assert.equal(registry.resolve(revoked), null);
});

test("observation targets bind exact Model or Project owner and reject cross-owner reuse", () => {
  const scope = { conversationId: "conversation_owner", conversationGeneration: 6 };
  const model = { scope, owner: { kind: "model" as const, id: "owner_same" } };
  const project = { scope, owner: { kind: "project" as const, id: "owner_same" } };
  assert.equal(workbenchObservationTargetMatches(model, 6, model.owner), true);
  assert.equal(workbenchObservationTargetMatches(project, 6, project.owner), true);
  assert.equal(workbenchObservationTargetMatches(model, 6, project.owner), false);
  assert.equal(workbenchObservationTargetMatches(project, 6, model.owner), false);
  assert.equal(workbenchObservationTargetMatches(model, 7, model.owner), false);
});

test("visual service frame tokens are short-lived and revoke by exact conversation scope", () => {
  let now = 1_000;
  const registry = new WorkbenchVisualServiceFrameRegistry(1_000, () => now);
  const scope = { conversationId: "conversation_visual_registry", conversationGeneration: 3 };
  const issued = registry.register({
    scope,
    owner: { kind: "model", id: "model_visual_registry" },
    pageGeneration: 8,
    targetUrl: "http://localhost:8765/",
    projectedUrl: "riff-visual://solara/",
  });
  assert.equal(issued.token.length, 43);
  assert.equal(registry.resolve(issued.token)?.pageGeneration, 8);
  registry.revoke({ ...scope, conversationGeneration: 2 });
  assert.equal(registry.resolve(issued.token)?.projectedUrl, "riff-visual://solara/");
  registry.revoke(scope);
  assert.equal(registry.resolve(issued.token), null);

  const expired = registry.register({
    scope,
    owner: { kind: "model", id: "model_visual_registry" },
    pageGeneration: 9,
    targetUrl: "http://localhost:8765/",
    projectedUrl: "riff-visual://solara/",
  });
  now += 1_001;
  assert.equal(registry.resolve(expired.token), null);
  now += 1;
  const cleared = registry.register({
    scope,
    owner: { kind: "model", id: "model_visual_registry" },
    pageGeneration: 10,
    targetUrl: "http://localhost:8765/",
    projectedUrl: "riff-visual://solara/",
  });
  registry.clear();
  assert.equal(registry.resolve(cleared.token), null);
});

test("workbench Browser HTTP API admits only aliases and generation-fences observation", {
  timeout: 30_000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "riff-workbench-browser-api-"));
  await mkdir(join(root, "legacy"), { recursive: true, mode: 0o700 });
  let holdNextTarget = false;
  let targetStarted: (() => void) | undefined;
  let releaseTarget: (() => void) | undefined;
  const targetServer = createServer(async (_request, response) => {
    if (holdNextTarget) {
      holdNextTarget = false;
      targetStarted?.();
      await new Promise<void>((resolve) => { releaseTarget = resolve; });
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>Declared Riff app</title><h1>Observed</h1>");
  });
  await new Promise<void>((resolve, reject) => {
    targetServer.once("error", reject);
    targetServer.listen(0, "::1", resolve);
  });
  const targetAddress = targetServer.address();
  assert.ok(targetAddress && typeof targetAddress !== "string");
  const targetOrigin = `http://localhost:${targetAddress.port}`;

  const app = new BackendApp({
    a2OpenCode: new BrowserApiOpenCode(),
    a2ProductRoot: join(root, "product"),
    workspaceRoot: join(root, "legacy"),
    a3PythonExecutable: process.execPath,
    workbenchBrowserTargetResolver: (alias) => alias === "riff-app"
      ? registerLocalBrowserTarget({
        alias,
        url: `${targetOrigin}/project`,
        projectedUrl: "riff-app://projects/project_browser_api",
      })
      : alias === "riff-visual"
        ? registerLocalBrowserTarget({
          alias,
          url: `${targetOrigin}/visual`,
          projectedUrl: "riff-visual://solara/",
        })
        : null,
  });
  t.after(async () => {
    await app.close();
    targetServer.closeAllConnections?.();
    await new Promise<void>((resolve) => targetServer.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  await app.initialize();
  seed(app);
  const network = await app.listenBrowserNetwork();
  const browserSession = await bootstrap(network.app.origin);

  const unauthenticated = await fetch(
    `${network.app.origin}/api/conversations/conversation_browser_api/browser`,
  );
  assert.equal(unauthenticated.status, 403);

  const openedResponse = await mutation(
    network.app.origin,
    browserSession,
    "/api/conversations/conversation_browser_api/browser/open",
    { alias: "riff-app" },
  );
  assert.equal(openedResponse.status, 200, await openedResponse.clone().text());
  const opened = await openedResponse.json() as any;
  let current = opened;
  assert.equal(opened.conversationGeneration, 1);
  assert.equal(opened.projectedUrl, "riff-app://projects/project_browser_api");
  assert.equal(opened.trustState, "trusted_riff");
  assert.equal(JSON.stringify(opened).includes(targetOrigin), false);

  const screenshot = await fetch(
    `${network.app.origin}/api/conversations/conversation_browser_api/browser/screenshot`
      + `?conversationGeneration=1&pageGeneration=${opened.pageGeneration}`,
    { headers: reads(browserSession) },
  );
  assert.equal(screenshot.status, 200, await screenshot.clone().text());
  assert.equal((await screenshot.json() as any).contentType, "image/png");

  const takeoverResponse = await mutation(
    network.app.origin,
    browserSession,
    "/api/conversations/conversation_browser_api/browser/takeover",
    { conversationGeneration: 1, pageGeneration: current.pageGeneration },
  );
  assert.equal(takeoverResponse.status, 200, await takeoverResponse.clone().text());
  current = await takeoverResponse.json() as any;
  assert.equal(current.controlMode, "human");
  assert.equal(current.recoveryState, "ready");
  const returnResponse = await mutation(
    network.app.origin,
    browserSession,
    "/api/conversations/conversation_browser_api/browser/return",
    { conversationGeneration: 1, pageGeneration: current.pageGeneration },
  );
  assert.equal(returnResponse.status, 200, await returnResponse.clone().text());
  current = await returnResponse.json() as any;
  assert.equal(current.controlMode, "observer");

  const looseTakeover = await mutation(
    network.app.origin,
    browserSession,
    "/api/conversations/conversation_browser_api/browser/takeover",
    { conversationGeneration: 1, pageGeneration: current.pageGeneration, capability: "caller" },
  );
  assert.equal(looseTakeover.status, 422);

  const callerUrl = await mutation(
    network.app.origin,
    browserSession,
    "/api/conversations/conversation_browser_api/browser/open",
    { alias: "riff-app", url: "https://example.com" },
  );
  assert.equal(callerUrl.status, 422);

  const nonVisualFrame = await mutation(
    network.app.origin,
    browserSession,
    "/api/conversations/conversation_browser_api/browser/service-frame",
    { conversationGeneration: 1, pageGeneration: current.pageGeneration },
  );
  assert.equal(nonVisualFrame.status, 409);
  assert.equal(
    (await nonVisualFrame.json() as any).error.code,
    "browser_visual_service_unavailable",
  );

  const visualResponse = await mutation(
    network.app.origin,
    browserSession,
    "/api/conversations/conversation_browser_api/browser/open",
    { alias: "riff-visual" },
  );
  assert.equal(visualResponse.status, 200, await visualResponse.clone().text());
  current = await visualResponse.json() as any;
  assert.equal(current.projectedUrl, "riff-visual://solara/");
  const frameResponse = await mutation(
    network.app.origin,
    browserSession,
    "/api/conversations/conversation_browser_api/browser/service-frame",
    { conversationGeneration: 1, pageGeneration: current.pageGeneration },
  );
  assert.equal(frameResponse.status, 201, await frameResponse.clone().text());
  const frameText = await frameResponse.text();
  assert.equal(frameText.includes(targetOrigin), false);
  const issuedFrame = JSON.parse(frameText) as any;
  assert.match(issuedFrame.frameUrl, /^\/browser\/visual-service\/[A-Za-z0-9_-]{43}$/u);
  const issuedFrameUrl = new URL(issuedFrame.frameUrl, network.app.origin).href;

  const hostPage = await frameNavigation(issuedFrameUrl, browserSession.cookie);
  assert.equal(hostPage.status, 200, hostPage.body);
  const hostHtml = hostPage.body;
  assert.match(hostHtml, /sandbox="allow-scripts allow-same-origin"/u);
  assert.match(hostHtml, /referrerpolicy="no-referrer"/u);
  assert.match(hostHtml, /html,body,iframe\{width:100%;height:100%/u);
  assert.doesNotMatch(
    String(hostPage.headers["content-security-policy"] ?? ""),
    /unsafe-inline/u,
  );
  assert.match(
    String(hostPage.headers["content-security-policy"] ?? ""),
    new RegExp(`frame-src ${targetOrigin.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`),
  );

  const reloadedResponse = await mutation(
    network.app.origin,
    browserSession,
    "/api/conversations/conversation_browser_api/browser/reload",
    { conversationGeneration: 1, pageGeneration: current.pageGeneration },
  );
  assert.equal(reloadedResponse.status, 200, await reloadedResponse.clone().text());
  current = await reloadedResponse.json() as any;
  assert.equal((await frameNavigation(issuedFrameUrl)).status, 404);
  const restartFrameResponse = await mutation(
    network.app.origin,
    browserSession,
    "/api/conversations/conversation_browser_api/browser/service-frame",
    { conversationGeneration: 1, pageGeneration: current.pageGeneration },
  );
  assert.equal(restartFrameResponse.status, 201, await restartFrameResponse.clone().text());
  const restartFrameUrl = new URL(
    (await restartFrameResponse.json() as any).frameUrl as string,
    network.app.origin,
  ).href;

  const restartedResponse = await mutation(
    network.app.origin,
    browserSession,
    "/api/conversations/conversation_browser_api/browser/restart",
    { conversationGeneration: 1, pageGeneration: current.pageGeneration },
  );
  assert.equal(restartedResponse.status, 200, await restartedResponse.clone().text());
  current = await restartedResponse.json() as any;
  const revokedAfterRestart = await frameNavigation(restartFrameUrl);
  assert.equal(revokedAfterRestart.status, 404);

  const closeFrameResponse = await mutation(
    network.app.origin,
    browserSession,
    "/api/conversations/conversation_browser_api/browser/service-frame",
    { conversationGeneration: 1, pageGeneration: current.pageGeneration },
  );
  assert.equal(closeFrameResponse.status, 201, await closeFrameResponse.clone().text());
  const closeFrameUrl = new URL(
    (await closeFrameResponse.json() as any).frameUrl as string,
    network.app.origin,
  ).href;
  const closedResponse = await mutation(
    network.app.origin,
    browserSession,
    "/api/conversations/conversation_browser_api/browser/close",
    { conversationGeneration: 1, pageGeneration: current.pageGeneration },
  );
  assert.equal(closedResponse.status, 200, await closedResponse.clone().text());
  assert.equal((await frameNavigation(closeFrameUrl)).status, 404);

  const reopenedVisualResponse = await mutation(
    network.app.origin,
    browserSession,
    "/api/conversations/conversation_browser_api/browser/open",
    { alias: "riff-visual" },
  );
  assert.equal(reopenedVisualResponse.status, 200, await reopenedVisualResponse.clone().text());
  current = await reopenedVisualResponse.json() as any;
  const nextFrameResponse = await mutation(
    network.app.origin,
    browserSession,
    "/api/conversations/conversation_browser_api/browser/service-frame",
    { conversationGeneration: 1, pageGeneration: current.pageGeneration },
  );
  assert.equal(nextFrameResponse.status, 201, await nextFrameResponse.clone().text());
  const nextFrameUrl = new URL(
    (await nextFrameResponse.json() as any).frameUrl as string,
    network.app.origin,
  ).href;

  const targetPending = new Promise<void>((resolve) => { targetStarted = resolve; });
  holdNextTarget = true;
  const inFlightReload = mutation(
    network.app.origin,
    browserSession,
    "/api/conversations/conversation_browser_api/browser/reload",
    { conversationGeneration: 1, pageGeneration: current.pageGeneration },
  );
  await targetPending;
  app.productStore!.bindAgentSession({
    id: "session_browser_api_2",
    conversationId: "conversation_browser_api",
    expectedGeneration: 1,
    state: "available",
    externalSessionRef: "opaque-browser-api-2",
    at: "2026-08-02T00:01:00.000Z",
  });
  releaseTarget?.();
  const stale = await inFlightReload;
  assert.equal(stale.status, 409);
  assert.equal((await stale.json() as any).error.code, "browser_conversation_stale");
  const afterDrift = await fetch(
    `${network.app.origin}/api/conversations/conversation_browser_api/browser`,
    { headers: reads(browserSession) },
  );
  assert.equal(afterDrift.status, 200);
  assert.equal((await afterDrift.json() as any).recoveryState, "closed");
  const revokedAfterGenerationDrift = await frameNavigation(nextFrameUrl);
  assert.equal(revokedAfterGenerationDrift.status, 404);
});

test("default riff-app observation never bootstraps the SPA or rotates the outer browser session", {
  timeout: 30_000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "riff-workbench-default-browser-"));
  await mkdir(join(root, "legacy"), { recursive: true, mode: 0o700 });
  const app = new BackendApp({
    a2OpenCode: new BrowserApiOpenCode(),
    a2ProductRoot: join(root, "product"),
    workspaceRoot: join(root, "legacy"),
    a3PythonExecutable: process.execPath,
  });
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  await app.initialize();
  seed(app);
  const network = await app.listenBrowserNetwork();
  const outerSession = await bootstrap(network.app.origin);

  const openedResponse = await mutation(
    network.app.origin,
    outerSession,
    "/api/conversations/conversation_browser_api/browser/open",
    { alias: "riff-app" },
  );
  assert.equal(openedResponse.status, 200, await openedResponse.clone().text());
  const opened = await openedResponse.json() as any;
  assert.equal(opened.projectedUrl, "riff-app://projects/project_browser_api?conversation=conversation_browser_api");
  assert.equal(JSON.stringify(opened).match(/browser\/observe|[A-Za-z0-9_-]{43}/u), null);

  const screenshot = await fetch(
    `${network.app.origin}/api/conversations/conversation_browser_api/browser/screenshot`
      + `?conversationGeneration=1&pageGeneration=${opened.pageGeneration}`,
    { headers: reads(outerSession) },
  );
  assert.equal(screenshot.status, 200, await screenshot.clone().text());
  const state = await fetch(
    `${network.app.origin}/api/conversations/conversation_browser_api/browser`,
    { headers: reads(outerSession) },
  );
  assert.equal(state.status, 200, await state.clone().text());
  assert.equal((await state.json() as any).recoveryState, "ready");

  const modelOpenedResponse = await mutation(
    network.app.origin,
    outerSession,
    "/api/conversations/conversation_model_browser_api/browser/open",
    { alias: "riff-app" },
  );
  assert.equal(modelOpenedResponse.status, 200, await modelOpenedResponse.clone().text());
  const modelOpened = await modelOpenedResponse.json() as any;
  assert.equal(
    modelOpened.projectedUrl,
    "riff-app://models/model_browser_api?conversation=conversation_model_browser_api",
  );
  assert.equal(modelOpened.trustState, "trusted_riff");

  app.productStore!.archiveResource(
    "project", "project_browser_api", "2026-08-02T00:02:00.000Z",
  );
  assert.equal(
    await app.productStore!.getConversationRuntime("conversation_browser_api"),
    null,
  );
  for (const response of [
    await fetch(
      `${network.app.origin}/api/conversations/conversation_browser_api/browser`,
      { headers: reads(outerSession) },
    ),
    await mutation(
      network.app.origin,
      outerSession,
      "/api/conversations/conversation_browser_api/browser/open",
      { alias: "riff-app" },
    ),
  ]) {
    assert.equal(response.status, 409);
    assert.equal(
      (await response.json() as any).error.code,
      "browser_conversation_unavailable",
    );
  }

  app.productStore!.trashResource(
    "model", "model_browser_api", "2026-08-02T00:03:00.000Z",
  );
  assert.equal(
    await app.productStore!.getConversationRuntime("conversation_model_browser_api"),
    null,
  );
  const modelReconnect = await mutation(
    network.app.origin,
    outerSession,
    "/api/conversations/conversation_model_browser_api/browser/open",
    { alias: "riff-app" },
  );
  assert.equal(modelReconnect.status, 409);
  assert.equal(
    (await modelReconnect.json() as any).error.code,
    "browser_conversation_unavailable",
  );
});

const seed = (app: BackendApp): void => {
  app.productStore!.createModel({
    id: "model_browser_api",
    name: "Browser API model",
    technicalStatus: "executable",
    runMode: "batch",
    executionDescription: {
      schemaVersion: 2,
      runtime: "python",
      runMode: "batch",
      dependencyFile: "environment/requirements.txt",
      inputs: {
        schemaProfile: "riff-json-schema-2020-12-v1",
        schema: { type: "object", properties: {}, additionalProperties: false },
        smoke: {},
      },
      outputs: [{
        logicalName: "result",
        relativePath: "outputs/result.json",
        mediaType: "application/json",
        required: true,
        role: "data",
      }],
      batch: { entryPoint: "code/model.py", protocol: "riff-batch-v1" },
      cancellation: { signal: "SIGTERM", graceMs: 500 },
    },
    createdAt: NOW,
    files: [{
      id: "file_browser_api",
      kind: "model_code",
      relativePath: "code/model.py",
      mediaType: "text/x-python",
      bytes: Buffer.from("print('ok')\n"),
    }, {
      id: "file_browser_api_environment",
      kind: "model_environment",
      relativePath: "environment/requirements.txt",
      mediaType: "text/plain",
      bytes: Buffer.from(""),
    }],
  });
  app.productStore!.createProjectFromModel({
    projectId: "project_browser_api",
    projectName: "Browser API project",
    sourceModelId: "model_browser_api",
    createdAt: NOW,
  });
  app.productStore!.createConversation({
    id: "conversation_browser_api",
    owner: { kind: "project", id: "project_browser_api" },
    name: "Browser API conversation",
    providerId: "provider-browser-api",
    providerModelId: "model-browser-api",
    createdAt: NOW,
  });
  app.productStore!.createConversation({
    id: "conversation_model_browser_api",
    owner: { kind: "model", id: "model_browser_api" },
    name: "Model Browser API conversation",
    providerId: "provider-browser-api",
    providerModelId: "model-browser-api",
    createdAt: NOW,
  });
  app.productStore!.createMessage({
    id: "message_browser_api_user",
    conversationId: "conversation_browser_api",
    ordinal: 0,
    role: "user",
    status: "complete",
    text: "Open the declared Riff page.",
    createdAt: NOW,
  });
  app.productStore!.createMessage({
    id: "message_model_browser_api_user",
    conversationId: "conversation_model_browser_api",
    ordinal: 0,
    role: "user",
    status: "complete",
    text: "Open the declared Riff Model page.",
    createdAt: NOW,
  });
  app.productStore!.bindAgentSession({
    id: "session_browser_api_1",
    conversationId: "conversation_browser_api",
    expectedGeneration: 0,
    state: "available",
    externalSessionRef: "opaque-browser-api-1",
    at: NOW,
  });
  app.productStore!.bindAgentSession({
    id: "session_model_browser_api_1",
    conversationId: "conversation_model_browser_api",
    expectedGeneration: 0,
    state: "available",
    externalSessionRef: "opaque-model-browser-api-1",
    at: NOW,
  });
};

type Session = Readonly<{ cookie: string; csrf: string }>;

const bootstrap = async (origin: string): Promise<Session> => {
  const response = await fetch(`${origin}/api/browser-session/bootstrap`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "cors",
      "sec-fetch-dest": "empty",
    },
    body: "{}",
  });
  assert.equal(response.status, 201, await response.clone().text());
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);
  return { cookie, csrf: (await response.json() as any).csrfToken };
};

const reads = (session: Session): Record<string, string> => ({
  cookie: session.cookie,
  "sec-fetch-site": "same-origin",
  "sec-fetch-mode": "cors",
  "sec-fetch-dest": "empty",
});

const mutation = (
  origin: string,
  session: Session,
  path: string,
  body: unknown,
): Promise<Response> => fetch(`${origin}${path}`, {
  method: "POST",
  headers: {
    ...reads(session),
    "content-type": "application/json",
    origin,
    "x-riff-csrf": session.csrf,
  },
  body: JSON.stringify(body),
});

const frameNavigation = (
  rawUrl: string,
  cookie?: string,
): Promise<Readonly<{
  status: number;
  headers: import("node:http").IncomingHttpHeaders;
  body: string;
}>> => new Promise((resolve, reject) => {
  const request = httpRequest(new URL(rawUrl), {
    method: "GET",
    headers: {
      ...(cookie ? { cookie } : {}),
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "iframe",
    },
  }, (response) => {
    const chunks: Buffer[] = [];
    response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    response.once("error", reject);
    response.once("end", () => resolve(Object.freeze({
      status: response.statusCode ?? 0,
      headers: response.headers,
      body: Buffer.concat(chunks).toString("utf8"),
    })));
  });
  request.once("error", reject);
  request.end();
});

class BrowserApiOpenCode implements OpenCodeConversationPort {
  async initialize(): Promise<OpenCodeReadiness> {
    return { status: "ready", modelId: "provider-browser-api/model-browser-api", version: "test" };
  }
  async discoverProviderModels(): Promise<OpenCodeProviderModel[]> { return []; }
  async getSession(): Promise<boolean> { return false; }
  async createSession(): Promise<string> { throw new Error("unused"); }
  async injectContext(): Promise<void> { throw new Error("unused"); }
  async promptWithModel(
    _sessionId: string,
    _binding: { providerId: string; modelId: string },
    _prompt: OpenCodePrompt,
  ): Promise<OpenCodeAssistantResponse> { throw new Error("unused"); }
  async prompt(): Promise<void> {}
  async abort(): Promise<void> {}
}
