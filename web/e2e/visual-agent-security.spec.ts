import { chromium, expect, test } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server as HttpServer,
} from "node:http";
import {
  connect,
  createServer as createTcpServer,
  type Socket,
  type Server as TcpServer,
} from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { VisualAgentInteractor } from "../../backend/src/visual-agent-interactor.ts";

const LEGACY_COOKIE = "legacy_cookie_c4_canary";
const LEGACY_STORAGE = "legacy_storage_c4_canary";
const FRAME_SECRET = "frame_cookie_nonce_ws_c4_canary";
const TYPED_SECRET = "typed_value_c4_canary";
const PROCESS_IDENTITY = Object.freeze({
  runId: "run_c4_browser",
  processAttemptId: "process_c4_browser",
  pid: process.pid,
  processStartToken: "c4-browser-fixture",
  processGroupId: process.pid,
  loopbackHost: "127.0.0.1" as const,
});

test.describe.configure({ mode: "serial" });

test("the published BackendApp turn chain performs one real interaction without touching live CDP", async () => {
  const legacy = await startLegacyCdp();
  const child = await startExactChild();
  const root = await realpath(await mkdtemp(join(tmpdir(), "riff-a3-2c4-chain-")));
  const priorCdp = process.env.RIFF_CDP_URL;
  process.env.RIFF_CDP_URL = legacy.proxyOrigin;
  let app: InstanceType<(typeof import("../../backend/src/server.ts"))["BackendApp"]> | undefined;
  let productBrowser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    // These production modules are first evaluated only after the live CDP
    // endpoint is installed, so import-time ambient capture cannot pass unseen.
    const [
      { BackendApp },
      { VisualAgentInteractor },
      { UnavailableMesaAdapter },
      { PlaywrightCdpProjector },
      { planExperiment },
      { canonicalDigest },
      { openProductDatabase },
    ] = await Promise.all([
      import("../../backend/src/server.ts"),
      import("../../backend/src/visual-agent-interactor.ts"),
      import("../../backend/src/mesa-adapter.ts"),
      import("../../backend/src/playwright-projection.ts"),
      import("../../backend/src/experiment-planner.ts"),
      import("../../backend/src/canonical-json-v2.ts"),
      import("../../backend/src/product-schema.ts"),
    ]);
    const openCode = new FullChainOpenCode();
    app = new BackendApp({
      mesa: new UnavailableMesaAdapter(),
      openCode,
      a2OpenCode: openCode,
      a2ProductRoot: join(root, "product"),
      workspaceRoot: join(root, "legacy"),
      defaultSessionId: "c4-chain",
      projector: new PlaywrightCdpProjector(legacy.proxyOrigin),
      a3VisualInteractor: new VisualAgentInteractor(),
    });
    await app.initialize();
    const store = app.productStore!;
    const inputSchema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { horizon: { type: "integer", minimum: 1 } },
      required: ["horizon"],
      additionalProperties: false,
    };
    const execution = {
      schemaVersion: 2,
      runtime: "python",
      runMode: "visual",
      dependencyFile: "environment/requirements.txt",
      inputs: {
        schemaProfile: "riff-json-schema-2020-12-v1",
        schema: inputSchema,
        smoke: { horizon: 1 },
      },
      outputs: [{
        logicalName: "result",
        relativePath: "outputs/result.json",
        mediaType: "application/json",
        required: true,
        role: "data",
      }],
      visual: {
        entryPoint: "code/model.py",
        protocol: "riff-visual-v1",
        healthPath: "/health",
      },
      cancellation: { signal: "SIGTERM", graceMs: 1_000 },
    };
    const limits = {
      schemaVersion: 1,
      wallTimeMs: 60_000,
      startupTimeMs: 10_000,
      terminationGraceMs: 1_000,
      maxStdoutBytes: 10_000,
      maxStderrBytes: 10_000,
      maxOutputFiles: 10,
      maxOutputBytes: 100_000,
      maxEventCount: 10,
      maxEventBytes: 10_000,
      maxSamples: 1,
      maxConcurrency: 1,
    };
    const createdAt = new Date(Date.now() - 2_000).toISOString();
    store.createModel({
      id: "model_c4_chain",
      name: "C4 chain",
      technicalStatus: "executable",
      runMode: "visual",
      executionDescription: execution,
      createdAt,
      files: [
        {
          id: "file_c4_chain",
          kind: "model_code",
          relativePath: "code/model.py",
          mediaType: "text/x-python",
          bytes: Buffer.from("print('visual')\n"),
        },
        {
          id: "environment_c4_chain",
          kind: "model_environment",
          relativePath: "environment/requirements.txt",
          mediaType: "text/plain",
          bytes: Buffer.from(""),
        },
      ],
    });
    const project = store.createProjectFromModel({
      projectId: "project_c4_chain",
      projectName: "C4 chain",
      sourceModelId: "model_c4_chain",
      createdAt,
    });
    const plan = planExperiment({
      configuration: {
        schemaVersion: 1,
        runKind: "visual",
        parameters: { horizon: 1 },
        sampling: { kind: "single" },
      },
      inputSchema,
      maxSamples: 1,
    });
    store.createExperimentV4({
      commandId: "command_c4_experiment",
      id: "experiment_c4_chain",
      projectId: project.id,
      name: "C4 visual",
      plan,
      createdAt,
    });
    store.createFrozenRun({
      commandId: "command_c4_run",
      runId: "run_c4_chain",
      projectId: project.id,
      experimentConfigId: "experiment_c4_chain",
      completionConversationId: null,
      expectedConfigurationDigest: plan.configurationDigest,
      plan,
      projectSnapshotDigest: project.modelSnapshotDigest,
      executionDescriptionDigest: canonicalDigest(project.executionDescription),
      limits,
      createdAt,
    });
    const databasePath = join(store.root, "product.sqlite3");
    const setupDatabase = openProductDatabase(databasePath);
    const dispatcher = setupDatabase.prepare(
      "SELECT generation FROM dispatcher_state WHERE singleton = 1",
    ).get() as { generation?: string } | undefined;
    if (!dispatcher?.generation) throw new Error("dispatcher generation was unavailable");
    const startedAt = new Date(Date.now() - 1_000).toISOString();
    const leaseExpiresAt = new Date(Date.now() + 60_000).toISOString();
    setupDatabase.prepare(`INSERT INTO run_attempts
      (id, run_id, attempt_generation, dispatcher_generation, state,
        claimed_at, lease_expires_at)
      VALUES (?, ?, 1, ?, 'claimed', ?, ?)`
    ).run("attempt_c4_chain", "run_c4_chain", dispatcher.generation, createdAt, leaseExpiresAt);
    setupDatabase.prepare(
      "UPDATE runs SET status = 'running', started_at = ?, updated_at = ? WHERE id = ?",
    ).run(startedAt, startedAt, "run_c4_chain");
    setupDatabase.prepare(
      "UPDATE run_attempts SET state = 'starting', started_at = ? WHERE id = ?",
    ).run(startedAt, "attempt_c4_chain");
    setupDatabase.prepare(
      "UPDATE run_attempts SET state = 'running', heartbeat_at = ? WHERE id = ?",
    ).run(startedAt, "attempt_c4_chain");
    setupDatabase.close();
    const attempt = {
      runId: "run_c4_chain",
      attemptId: "attempt_c4_chain",
      attemptGeneration: 1,
      dispatcherGeneration: dispatcher.generation,
    };
    const sample = plan.samples[0]!;
    const launch = {
      ...attempt,
      processKind: "visual" as const,
      sampleIndex: 0,
      sampleId: sample.sampleId,
      scratchId: "scratch_c4_chain",
      relativePath: "visual-c4-chain",
      loopbackPort: child.port,
      healthPath: "/health",
    };
    const processIdentity = {
      ...attempt,
      processKind: "visual" as const,
      processAttemptId: "process_c4_chain",
      pid: child.pid,
      processStartToken: child.processStartToken,
      processGroupId: child.processGroupId,
      loopbackPort: child.port,
      scratchId: launch.scratchId,
    };
    const binding = store.prepareVisualProcessLaunch({
      ...launch,
      createdAt,
    });
    store.registerVisualScratchDirectory({
      ...launch,
      ownerUid: process.getuid?.() ?? 501,
      device: 42,
      inode: 99,
      registeredAt: startedAt,
    });
    const unsignedReceipt = {
      schemaVersion: 1,
      manifestId: binding.manifestId,
      manifestDigest: binding.manifestDigest,
      runId: attempt.runId,
      sampleIndex: 0,
      sampleId: sample.sampleId,
      scratchId: launch.scratchId,
      relativePath: launch.relativePath,
      pid: child.pid,
      processGroupId: child.processGroupId,
      processStartToken: child.processStartToken,
      loopbackHost: "127.0.0.1",
      loopbackPort: child.port,
      healthPath: "/health",
      createdAt: startedAt,
    };
    store.registerVisualProcessAttempt({
      ...processIdentity,
      launchReceipt: Object.freeze({
        ...unsignedReceipt,
        receiptDigest: canonicalDigest(unsignedReceipt),
      }),
      launchedAt: startedAt,
    });
    store.markVisualProcessGateReleased({ ...processIdentity, startedAt });
    store.markVisualProcessStarted({ ...processIdentity, startedAt });
    store.recordVisualProcessHealth({
      ...processIdentity,
      healthyAt: new Date(Date.now() - 500).toISOString(),
    });
    store.createConversation({
      id: "conversation_c4_chain",
      owner: { kind: "project", id: project.id },
      name: "C4 chain",
      providerId: "provider-c4",
      providerModelId: "model-c4",
      createdAt,
    });
    const network = await app.listenBrowserNetwork();
    productBrowser = await chromium.launch();
    const productContext = await productBrowser.newContext();
    const productPage = await productContext.newPage();
    await productPage.goto(`${network.app.origin}/a2`);
    const browserSession = await productPage.evaluate(async () => {
      const response = await fetch("/api/browser-session/bootstrap", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      return {
        status: response.status,
        body: await response.json() as { csrfToken?: string },
      };
    });
    expect(browserSession.status).toBe(201);
    expect(browserSession.body.csrfToken).toMatch(/^[A-Za-z0-9_-]+$/u);
    await legacy.resetConnections();
    expect(await probeCdpVersion(legacy.proxyOrigin))
      .toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\//u);
    expect(legacy.connections).toBeGreaterThan(0);
    await legacy.resetConnections();
    expect(legacy.connections).toBe(0);
    const turnResponse = await productPage.evaluate(
      async ({ csrfToken, body }) => {
        const response = await fetch(
          "/api/conversations/conversation_c4_chain/turns",
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-riff-csrf": csrfToken,
            },
            body: JSON.stringify(body),
          },
        );
        const text = await response.text();
        return {
          status: response.status,
          text,
          body: text ? JSON.parse(text) : null,
        };
      },
      {
        csrfToken: browserSession.body.csrfToken!,
        body: {
          requestKey: "c4-chain-interaction",
          text: "Perform the separately confirmed visual interaction.",
          attachmentIds: [],
          visualInteractionConfirmation: {
            kind: "type",
            locator: { kind: "label", label: "Secret value" },
            value: TYPED_SECRET,
          },
        },
      },
    );
    expect(turnResponse.status, turnResponse.text).toBe(200);
    const publicTurn = turnResponse.body;
    const database = new DatabaseSync(databasePath, {
      open: true,
      readOnly: true,
    });
    const persistedMessages = database.prepare(
      "SELECT role, status, content_json FROM messages ORDER BY ordinal",
    ).all();
    const auditFacts = database.prepare(
      "SELECT * FROM visual_agent_audit_facts ORDER BY created_at, id",
    ).all();
    database.close();
    expect(openCode.toolResult?.result?.isError, JSON.stringify({
      toolResult: openCode.toolResult,
      toolList: openCode.toolList,
      denials: openCode.denials,
      childRequests: child.requests,
      auditFacts,
    })).toBeUndefined();
    expect(JSON.parse(openCode.toolResult!.result.content[0].text)).toEqual({
      schemaVersion: 1,
      kind: "type",
      status: "dispatched",
      untrusted: true,
    });
    expect(legacy.connections).toBe(0);
    expect(await legacy.page.locator("#legacy-state").textContent()).toBe("untouched");
    expect(await legacy.ambientSecrets()).toEqual({
      appCookie: FRAME_SECRET,
      brokerCookie: FRAME_SECRET,
      frameNonce: FRAME_SECRET,
      frameWebSocketRoute: FRAME_SECRET,
    });
    expect(auditFacts.map((fact: any) => fact.fact_kind)).toEqual([
      "mint",
      "consume",
      "outcome",
    ]);
    const persistenceBytes = Buffer.concat(await Promise.all(
      [databasePath, `${databasePath}-wal`, `${databasePath}-shm`].map(async (path) =>
        await readFile(path).catch(() => Buffer.alloc(0))),
    )).toString("latin1");
    const evidence = JSON.stringify({
      publicTurn,
      toolResult: openCode.toolResult,
      toolList: openCode.toolList,
      denials: openCode.denials,
      auditFacts,
      persistedMessages,
      childRequests: child.requests,
    });
    const evidenceSecrets = [
      legacy.proxyOrigin,
      LEGACY_COOKIE,
      LEGACY_STORAGE,
      FRAME_SECRET,
      TYPED_SECRET,
      "Secret value",
      child.processStartToken,
    ];
    for (const secret of evidenceSecrets) {
      expect(evidence).not.toContain(secret);
    }
    for (const secret of evidenceSecrets.slice(0, -1)) {
      expect(persistenceBytes).not.toContain(secret);
    }
    expect(child.requests.map((entry) => `${entry.method} ${entry.url}`)).toEqual([
      "GET /",
      "GET /app.js",
    ]);
    expect(child.requests.some((entry) =>
      entry.headers["x-riff-agent-bridge"] !== undefined)).toBe(false);
    expect(openCode.toolList).toContain("riff_interact_current_visual");
    expect(openCode.toolList).not.toContain("drive_workbench_ui");
    expect(openCode.toolList).not.toContain("riff_drive_workbench_ui");
    expect(openCode.denials).toHaveLength(3);
    expect(openCode.denials.every((entry) => entry.result?.isError === true))
      .toBe(true);
  } finally {
    await productBrowser?.close().catch(() => undefined);
    await app?.close().catch(() => undefined);
    restoreEnv("RIFF_CDP_URL", priorCdp);
    await rm(root, { recursive: true, force: true });
    await child.close();
    await legacy.close();
  }
});

test("fresh Chromium interaction leaves a real live-CDP browser and its secrets untouched", async () => {
  const legacy = await startLegacyCdp();
  const child = await startChild("local");
  const priorCdp = process.env.RIFF_CDP_URL;
  process.env.RIFF_CDP_URL = legacy.proxyOrigin;
  try {
    expect(legacy.validationConnections).toBeGreaterThan(0);
    await legacy.resetConnections();
    const receipt = await interact(child.port, {
      kind: "click",
      locator: { kind: "role_name", role: "button", name: "Run" },
    });
    expect(receipt).toEqual({
      schemaVersion: 1,
      kind: "click",
      status: "dispatched",
      untrusted: true,
    });
    expect(legacy.connections).toBe(0);
    expect(await legacy.page.evaluate(() => ({
      state: document.querySelector("#legacy-state")?.textContent,
      cookie: document.cookie,
      local: localStorage.getItem("legacy"),
      session: sessionStorage.getItem("legacy"),
    }))).toEqual({
      state: "untouched",
      cookie: `legacy=${LEGACY_COOKIE}`,
      local: LEGACY_STORAGE,
      session: LEGACY_STORAGE,
    });
    expect(child.requests.map((entry) => `${entry.method} ${entry.url}`)).toEqual([
      "GET /",
      "GET /app.js",
    ]);
    for (const request of child.requests) {
      expect(request.headers.cookie).toBeUndefined();
      expect(request.headers.authorization).toBeUndefined();
      expect(request.headers.origin).toBeUndefined();
      expect(request.headers["x-riff-agent-bridge"]).toBeUndefined();
      expect(JSON.stringify(request)).not.toContain(FRAME_SECRET);
      expect(JSON.stringify(request)).not.toContain(LEGACY_COOKIE);
      expect(JSON.stringify(request)).not.toContain(LEGACY_STORAGE);
    }
    expect(JSON.stringify(receipt)).not.toContain(TYPED_SECRET);
    expect(JSON.stringify(receipt)).not.toContain(legacy.proxyOrigin);
  } finally {
    restoreEnv("RIFF_CDP_URL", priorCdp);
    await child.close();
    await legacy.close();
  }
});

test("real Chromium independently fails browser-generated write, popup, navigation, dialog, and WebSocket side effects", async () => {
  const legacy = await startLegacyCdp();
  const priorCdp = process.env.RIFF_CDP_URL;
  process.env.RIFF_CDP_URL = legacy.proxyOrigin;
  try {
    await legacy.resetConnections();
    for (const behavior of [
      "post",
      "popup",
      "navigation",
      "dialog",
      "websocket",
    ] as const) {
      const child = await startChild(behavior);
      try {
        const error = await interact(child.port, {
          kind: "click",
          locator: { kind: "role_name", role: "button", name: "Run" },
        }).catch((cause: unknown) => cause);
        if (behavior !== "post") {
          expect(error, behavior).toBeInstanceOf(Error);
          expect((error as Error & { mayHaveDispatched?: boolean }).mayHaveDispatched,
            behavior).toBe(true);
        } else {
          expect((error as { status?: string }).status, behavior).toBe("dispatched");
        }
        expect(child.requests.every((entry) =>
          entry.method === "GET" && (entry.url === "/" || entry.url === "/app.js")),
        behavior).toBe(true);
      } finally {
        await child.close();
      }
    }
    expect(legacy.connections).toBe(0);
    expect(await legacy.page.locator("#legacy-state").textContent()).toBe("untouched");
  } finally {
    restoreEnv("RIFF_CDP_URL", priorCdp);
    await legacy.close();
  }
});

test("real Chromium blocks Service Worker registration without granting child network authority", async () => {
  const child = await startChild("worker");
  try {
    const receipt = await interact(child.port, {
      kind: "click",
      locator: { kind: "role_name", role: "button", name: "Run" },
    });
    expect(receipt.status).toBe("dispatched");
    expect(child.requests.map((entry) => `${entry.method} ${entry.url}`)).toEqual([
      "GET /",
      "GET /app.js",
    ]);
  } finally {
    await child.close();
  }
});

test("real Chromium denies form, upload, download, clipboard, permission, and credential escalation", async () => {
  for (const behavior of [
    "form",
    "upload",
    "download",
    "clipboard",
    "permission",
    "auth-challenge",
  ] as const) {
    const child = await startChild(behavior);
    try {
      const operation = behavior === "upload"
        ? {
            kind: "type" as const,
            locator: { kind: "label" as const, label: "Secret value" },
            value: TYPED_SECRET,
          }
        : {
            kind: "click" as const,
            locator: { kind: "role_name" as const, role: "button", name: "Run" },
          };
      const result = await interact(child.port, operation)
        .catch((cause: unknown) => cause);
      if (["form", "upload", "download", "auth-challenge"].includes(behavior)) {
        expect(result, behavior).toBeInstanceOf(Error);
      } else {
        expect((result as { status?: string }).status, behavior).toBe("dispatched");
      }
      expect(child.requests.every((entry) =>
        entry.method === "GET"
        && (entry.url === "/" || entry.url === "/app.js")), behavior).toBe(true);
      expect(JSON.stringify(child.requests), behavior).not.toContain(TYPED_SECRET);
      expect(child.requests.some((entry) =>
        entry.headers.authorization !== undefined), behavior).toBe(false);
    } finally {
      await child.close();
    }
  }
});

test("real Chromium rejects child credentials and response authority before dispatch", async () => {
  const child = await startChild("set-cookie");
  try {
    const error = await interact(child.port, {
      kind: "type",
      locator: { kind: "label", label: "Secret value" },
      value: TYPED_SECRET,
    }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error & { mayHaveDispatched?: boolean }).mayHaveDispatched)
      .toBe(false);
    expect(child.requests).toHaveLength(1);
    expect(child.requests[0]!.headers.cookie).toBeUndefined();
    expect(child.requests[0]!.headers.authorization).toBeUndefined();
    expect(JSON.stringify(child.requests)).not.toContain(TYPED_SECRET);
    const errorEvidence = `${String(error)}\n${JSON.stringify({
      name: (error as Error).name,
      message: (error as Error).message,
      code: (error as Error & { code?: string }).code,
      mayHaveDispatched: (error as Error & { mayHaveDispatched?: boolean })
        .mayHaveDispatched,
    })}`;
    expect(errorEvidence).not.toContain(TYPED_SECRET);
    expect(errorEvidence).not.toContain(FRAME_SECRET);
  } finally {
    await child.close();
  }
});

const interact = async (
  port: number,
  operation: Parameters<VisualAgentInteractor["interact"]>[0]["operation"],
) => {
  const { VisualAgentInteractor } = await import(
    "../../backend/src/visual-agent-interactor.ts"
  );
  return await new VisualAgentInteractor({
    inspection: {
      async inspectListener() {},
      async inspectConnectedPeer() {},
    },
  }).interact({
    target: { ...PROCESS_IDENTITY, loopbackPort: port },
    operation,
    assertLive() {},
    signal: new AbortController().signal,
  });
};

class FullChainOpenCode {
  readonly sessions = new Set<string>();
  readonly scoped = new Map<string, string>();
  toolList: string[] = [];
  toolResult?: any;
  denials: any[] = [];

  async initialize() {
    return { status: "ready" as const, modelId: "provider-c4/model-c4", version: "c4" };
  }
  async discoverProviderModels() {
    return [{
      providerId: "provider-c4",
      modelId: "model-c4",
      qualifiedId: "provider-c4/model-c4",
    }];
  }
  async getSession(sessionId: string) { return this.sessions.has(sessionId); }
  async createSession(conversationId: string) {
    const sessionId = `session-${conversationId}`;
    this.sessions.add(sessionId);
    return sessionId;
  }
  async injectContext() {}
  async bindScopedMcp(scopeId: string, url: string) { this.scoped.set(scopeId, url); }
  async unbindScopedMcp(scopeId: string) { this.scoped.delete(scopeId); }
  async promptWithModel(
    _sessionId: string,
    _binding: unknown,
    prompt: { scopedMcpScopeId?: string },
  ) {
    const url = prompt.scopedMcpScopeId
      ? this.scoped.get(prompt.scopedMcpScopeId)
      : undefined;
    if (!url) throw new Error("scoped MCP was not bound");
    const rpc = async (body: unknown) => {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error("scoped MCP request failed");
      return await response.json() as any;
    };
    const listed = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    this.toolList = listed.result.tools.map((tool: { name: string }) => tool.name);
    this.denials = [
      await rpc(mcpCall("drive_workbench_ui", {})),
      await rpc(mcpCall("riff_drive_workbench_ui", {})),
      await rpc(mcpCall("riff_interact_current_visual", {
        url: process.env.RIFF_CDP_URL,
        cookie: FRAME_SECRET,
        value: TYPED_SECRET,
      })),
    ];
    this.toolResult = await rpc(mcpCall("riff_interact_current_visual", {}));
    return {
      messageId: "assistant-c4",
      text: "The bounded interaction dispatch completed.",
      content: { source: "opencode", textParts: 1 },
    };
  }
  async prompt() {}
  async abort() {}
}

const mcpCall = (name: string, args: Record<string, unknown>) => ({
  jsonrpc: "2.0",
  id: 2,
  method: "tools/call",
  params: { name, arguments: args },
});

type ChildBehavior =
  | "local"
  | "post"
  | "popup"
  | "navigation"
  | "dialog"
  | "websocket"
  | "worker"
  | "form"
  | "upload"
  | "download"
  | "clipboard"
  | "permission"
  | "auth-challenge"
  | "set-cookie";
type ChildRequest = Readonly<{
  method: string | undefined;
  url: string | undefined;
  headers: IncomingHttpHeaders;
}>;

const startChild = async (behavior: ChildBehavior): Promise<{
  port: number;
  requests: ChildRequest[];
  close(): Promise<void>;
}> => {
  const requests: ChildRequest[] = [];
  const server = createHttpServer((request, response) => {
    requests.push(Object.freeze({
      method: request.method,
      url: request.url,
      headers: Object.freeze({ ...request.headers }),
    }));
    if (request.url === "/") {
      if (behavior === "auth-challenge") {
        response.writeHead(401, {
          "content-type": "text/html; charset=utf-8",
          "www-authenticate": `Basic realm="${FRAME_SECRET}"`,
        });
        response.end("authentication required");
        return;
      }
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        ...(behavior === "set-cookie"
          ? { "set-cookie": `child=${FRAME_SECRET}; HttpOnly; SameSite=Strict` }
          : {}),
      });
      response.end(`<!doctype html><html><body>
        ${behavior === "form"
          ? `<form method="post" action="/submit"><button type="submit">Run</button></form>`
          : `<button>Run</button>`}
        <label for="secret">Secret value</label><input id="secret"${behavior === "upload" ? ` type="file"` : ""}>
        <script src="/app.js"></script>
      </body></html>`);
      return;
    }
    if (request.url === "/app.js") {
      response.writeHead(200, { "content-type": "application/javascript" });
      const effect: Record<Exclude<ChildBehavior, "set-cookie" | "auth-challenge">, string> = {
        local: `document.body.dataset.local = "changed";`,
        post: `fetch("/write", {method:"POST", body:"forbidden"}).catch(() => {});`,
        popup: `window.open("/popup");`,
        navigation: `location.href = "/next";`,
        dialog: `alert("blocked");`,
        websocket: `new WebSocket("ws://" + location.host + "/socket");`,
        worker: `navigator.serviceWorker.register("/worker.js").catch(() => {});`,
        form: `document.body.dataset.form = "preflight-denied";`,
        upload: `document.body.dataset.upload = "preflight-denied";`,
        download: `Object.assign(document.createElement("a"), {
          href: "data:text/plain,blocked",
          download: "blocked.txt",
        }).click();`,
        clipboard: `navigator.clipboard.writeText("${TYPED_SECRET}").catch(() => {});`,
        permission: `Notification.requestPermission().catch(() => {});`,
      };
      response.end(`document.querySelector("button").addEventListener("click", () => {
        ${effect[behavior === "set-cookie" || behavior === "auth-challenge" ? "local" : behavior]}
      });`);
      return;
    }
    response.writeHead(500, { "content-type": "text/plain" });
    response.end("unexpected");
  });
  await listen(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("child fixture did not bind");
  return {
    port: address.port,
    requests,
    close: () => closeServer(server),
  };
};

const startExactChild = async (): Promise<{
  port: number;
  pid: number;
  processGroupId: number;
  processStartToken: string;
  requests: ChildRequest[];
  close(): Promise<void>;
}> => {
  const source = String.raw`
    const { createServer } = require("node:http");
    const server = createServer((request, response) => {
      process.stdout.write(JSON.stringify({
        kind: "request",
        method: request.method,
        url: request.url,
        headers: request.headers,
      }) + "\n");
      if (request.url === "/") {
        response.writeHead(200, {"content-type":"text/html; charset=utf-8"});
        response.end('<!doctype html><html><body><label for="secret">Secret value</label><input id="secret"><script src="/app.js"></script></body></html>');
        return;
      }
      if (request.url === "/app.js") {
        response.writeHead(200, {"content-type":"application/javascript"});
        response.end('document.querySelector("#secret").addEventListener("input", () => { document.body.dataset.local = "changed"; });');
        return;
      }
      response.writeHead(500, {"content-type":"text/plain"});
      response.end("unexpected");
    });
    server.listen({host:"127.0.0.1", port:0}, () => {
      process.stdout.write(JSON.stringify({
        kind: "ready",
        port: server.address().port,
        pid: process.pid,
      }) + "\n");
    });
    const close = () => server.close(() => process.exit(0));
    process.on("SIGTERM", close);
    process.on("SIGINT", close);
  `;
  const child = spawn(process.execPath, ["-e", source], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!child.stdout || !child.stderr || !child.pid) {
    child.kill("SIGKILL");
    throw new Error("exact child fixture did not start");
  }
  const requests: ChildRequest[] = [];
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.setEncoding("utf8");
  let buffered = "";
  const ready = await new Promise<{ port: number; pid: number }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`exact child fixture timed out: ${stderr}`)), 5_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`exact child fixture exited early: ${code}: ${stderr}`));
    });
    child.stdout!.on("data", (chunk: string) => {
      buffered += chunk;
      while (buffered.includes("\n")) {
        const index = buffered.indexOf("\n");
        const line = buffered.slice(0, index);
        buffered = buffered.slice(index + 1);
        const record = JSON.parse(line);
        if (record.kind === "ready") {
          clearTimeout(timer);
          resolve({ port: record.port, pid: record.pid });
        } else if (record.kind === "request") {
          requests.push(Object.freeze({
            method: record.method,
            url: record.url,
            headers: Object.freeze(record.headers),
          }));
        }
      }
    });
  });
  const processStartToken = execFileSync(
    "ps",
    ["-o", "lstart=", "-p", String(ready.pid)],
    { encoding: "utf8", timeout: 1_000 },
  ).trim();
  if (!processStartToken) throw new Error("exact child identity was unavailable");
  return {
    port: ready.port,
    pid: ready.pid,
    processGroupId: ready.pid,
    processStartToken,
    requests,
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try { process.kill(-ready.pid, "SIGTERM"); } catch {}
      const exited = once(child, "exit").then(() => true);
      if (!await Promise.race([
        exited,
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000)),
      ])) {
        try { process.kill(-ready.pid, "SIGKILL"); } catch {}
        await once(child, "exit").catch(() => undefined);
      }
    },
  };
};

const startLegacyCdp = async (): Promise<{
  page: Awaited<ReturnType<Awaited<ReturnType<typeof chromium.launch>>["newPage"]>>;
  proxyOrigin: string;
  readonly connections: number;
  readonly validationConnections: number;
  ambientSecrets(): Promise<{
    appCookie: string | undefined;
    brokerCookie: string | undefined;
    frameNonce: string | null;
    frameWebSocketRoute: string | null;
  }>;
  resetConnections(): Promise<void>;
  close(): Promise<void>;
}> => {
  const sentinel = createHttpServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><html><body>
      <button id="legacy-state">untouched</button>
    </body></html>`);
  });
  let cleanupBrowser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let cleanupProxy: TcpServer | undefined;
  const proxySockets = new Set<Socket>();
  try {
  await listen(sentinel);
  const sentinelAddress = sentinel.address();
  if (!sentinelAddress || typeof sentinelAddress === "string") throw new Error("legacy fixture did not bind");
  const debugPort = await reservePort();
  const browser = await chromium.launch({
    headless: true,
    args: [
      `--remote-debugging-port=${debugPort}`,
      "--remote-allow-origins=*",
    ],
  });
  cleanupBrowser = browser;
  const context = await browser.newContext();
  await context.addCookies([{
    name: "legacy",
    value: LEGACY_COOKIE,
    url: `http://127.0.0.1:${sentinelAddress.port}`,
    httpOnly: false,
    sameSite: "Strict",
  }, {
    name: "riff_app_session",
    value: FRAME_SECRET,
    url: `http://127.0.0.1:${sentinelAddress.port}/api/`,
    httpOnly: true,
    sameSite: "Strict",
  }, {
    name: "riff_broker_session",
    value: FRAME_SECRET,
    url: `http://127.0.0.1:${sentinelAddress.port}/frame/c/c4-canary/`,
    httpOnly: true,
    sameSite: "Strict",
  }]);
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${sentinelAddress.port}/`);
  await page.evaluate((value) => {
    localStorage.setItem("legacy", value);
    sessionStorage.setItem("legacy", value);
  }, LEGACY_STORAGE);
  await page.evaluate((value) => {
    localStorage.setItem("frameNonce", value);
    sessionStorage.setItem("frameWebSocketRoute", value);
  }, FRAME_SECRET);
  await expect.poll(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
      return response.ok && Boolean((await response.json()).webSocketDebuggerUrl);
    } catch {
      return false;
    }
  }).toBe(true);
  let connections = 0;
  let validationConnections = 0;
  const proxy = createTcpServer((client) => {
    connections += 1;
    validationConnections += 1;
    const upstream = connect({ host: "127.0.0.1", port: debugPort });
    proxySockets.add(client);
    proxySockets.add(upstream);
    client.pipe(upstream);
    upstream.pipe(client);
    const close = (): void => {
      proxySockets.delete(client);
      proxySockets.delete(upstream);
      client.destroy();
      upstream.destroy();
    };
    client.on("error", close);
    upstream.on("error", close);
    client.on("close", close);
    upstream.on("close", close);
  });
  cleanupProxy = proxy;
  await listen(proxy);
  const proxyAddress = proxy.address();
  if (!proxyAddress || typeof proxyAddress === "string") throw new Error("CDP proxy did not bind");
  const proxyOrigin = `http://127.0.0.1:${proxyAddress.port}`;
  expect(await probeCdpVersion(proxyOrigin))
    .toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\//u);
  return {
    page,
    proxyOrigin,
    get connections() { return connections; },
    get validationConnections() { return validationConnections; },
    async ambientSecrets() {
      const cookies = await context.cookies();
      return {
        appCookie: cookies.find((cookie) => cookie.name === "riff_app_session")?.value,
        brokerCookie: cookies.find((cookie) =>
          cookie.name === "riff_broker_session")?.value,
        frameNonce: await page.evaluate(() => localStorage.getItem("frameNonce")),
        frameWebSocketRoute: await page.evaluate(() =>
          sessionStorage.getItem("frameWebSocketRoute")),
      };
    },
    async resetConnections() {
      for (const socket of proxySockets) socket.destroy();
      proxySockets.clear();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      connections = 0;
    },
    async close() {
      for (const socket of proxySockets) socket.destroy();
      proxySockets.clear();
      await closeServer(proxy);
      await browser.close();
      await closeServer(sentinel);
    },
  };
  } catch (error) {
    for (const socket of proxySockets) socket.destroy();
    proxySockets.clear();
    if (cleanupProxy) await closeServer(cleanupProxy).catch(() => undefined);
    await cleanupBrowser?.close().catch(() => undefined);
    await closeServer(sentinel).catch(() => undefined);
    throw error;
  }
};

const reservePort = async (): Promise<number> => {
  const server = createTcpServer();
  await listen(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("port reservation failed");
  await closeServer(server);
  return address.port;
};

const probeCdpVersion = async (origin: string): Promise<string> =>
  await new Promise<string>((resolve, reject) => {
    const request = httpRequest(`${origin}/json/version`, {
      agent: false,
      headers: { connection: "close" },
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.once("end", () => {
        if (response.statusCode !== 200) {
          reject(new Error(`CDP version probe failed with ${response.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(body).webSocketDebuggerUrl);
        } catch (error) {
          reject(error);
        }
      });
    });
    request.once("error", reject);
    request.end();
  });

const listen = async (server: HttpServer | TcpServer): Promise<void> => {
  server.listen({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
};

const closeServer = async (server: HttpServer | TcpServer): Promise<void> => {
  for (const connection of "closeAllConnections" in server
    ? [server.closeAllConnections.bind(server)]
    : []) connection();
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
};

const restoreEnv = (name: string, value: string | undefined): void => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};
