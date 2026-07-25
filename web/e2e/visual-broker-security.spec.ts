import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
// The browser fixture reuses the backend's pinned runtime dependency.
// @ts-expect-error ws publishes no declaration beside this ESM entrypoint.
import { WebSocketServer } from "../../backend/node_modules/ws/wrapper.mjs";
import type {
  BrowserFrameConnectedPeer,
  BrowserFrameTarget,
  BrowserFrameTargetResolver,
} from "../../backend/src/browser-frame-capability.ts";
import {
  VisualAgentAuthority,
  VisualAgentAuthorityError,
  type VisualAgentAuditFactInput,
  type VisualAgentAuthorityStore,
  type VisualAgentTarget,
  type VisualAgentTurnScope,
} from "../../backend/src/agent-visual-authority.ts";
import type { MesaAdapter, MesaRunRequest } from "../../backend/src/mesa-adapter.ts";
import type {
  OpenCodeAdapter,
  OpenCodePrompt,
  OpenCodeReadiness,
} from "../../backend/src/opencode-adapter.ts";
import { BackendApp } from "../../backend/src/server.ts";
import type { MesaModel, MesaResults, MesaRun } from "../../backend/src/types.ts";

const PROJECT_ID = "project_browser_matrix";
const RUN_ID = "run_browser_matrix";
const WS_PROTOCOL = "riff.echo";
const FRAME_MESSAGE_SOURCE = "riff-a3-2b4-frame";

test.describe.configure({ mode: "serial" });

test("Chromium uses the real cookie jar, one-use nonce, relative resources, and no-store frame path", async ({ context, page }) => {
  const stack = await startStack();
  try {
    const traffic: string[] = [];
    page.on("request", (request) => traffic.push(request.url()));
    await openHost(page, stack);
    await expect(page.locator("#visual-host")).toHaveAttribute("data-status", "loaded");
    const frame = page.frameLocator("#visual-frame");
    await expect(frame.locator("#frame-ready")).toHaveText("ready");
    await expect(frame.locator("body")).toHaveCSS("color", "rgb(0, 128, 0)");
    await expect(frame.locator("#state")).toHaveText("state-ok");
    await expect(frame.locator("#pixel")).toHaveJSProperty("complete", true);
    const finalFrameUrl = page.frames().find((candidate) => candidate !== page.mainFrame())?.url();
    await expect(page.locator("#visual-frame")).toHaveAttribute("sandbox", "allow-scripts allow-same-origin");
    expect(finalFrameUrl).toMatch(/^http:\/\/localhost:\d+\/frame\/c\/[A-Za-z0-9_-]{43}\/$/u);
    expect(traffic.some((url) => url.includes("/frame/redeem/"))).toBe(true);
    expect(traffic.some((url) => url.includes("/frame/c/"))).toBe(true);

    const cookies = await context.cookies();
    const appCookie = cookies.find((cookie) => cookie.path === "/api/");
    const brokerCookie = cookies.find((cookie) => /^\/frame\/c\/[A-Za-z0-9_-]{43}\/$/u.test(cookie.path));
    expect(appCookie).toMatchObject({ domain: "localhost", httpOnly: true, sameSite: "Strict", secure: false });
    expect(brokerCookie).toMatchObject({ domain: "localhost", httpOnly: true, sameSite: "Strict", secure: false });
    const apiDocument = await context.newPage();
    await apiDocument.goto(`${stack.network!.app.origin}/api/not-a-document`);
    expect(await apiDocument.evaluate(() => document.cookie)).not.toContain(appCookie!.name);
    await apiDocument.close();
    expect(await frame.locator("body").evaluate(() => document.cookie)).not.toContain(brokerCookie!.name);
    expect(stack.httpRequests.length).toBeGreaterThanOrEqual(4);
    for (const request of stack.httpRequests) {
      expect(request.headers.cookie).toBeUndefined();
      expect(request.headers.authorization).toBeUndefined();
      expect(request.headers.origin).toBeUndefined();
    }

    const hitsBeforeReload = stack.documentHits;
    await page.locator("#visual-frame").evaluate((element: HTMLIFrameElement, url) => {
      element.src = url;
    }, finalFrameUrl!);
    await expect.poll(() => stack.documentHits).toBeGreaterThan(hitsBeforeReload);

    const redeemUrl = traffic.find((url) => url.includes("/frame/redeem/"));
    expect(redeemUrl).toBeTruthy();
    const replay = await context.newPage();
    await replay.goto(redeemUrl!);
    await expect(replay.locator("body")).toContainText("visual_frame_nonce_invalid");
    await replay.close();

    const registration = await frame.locator("body").evaluate(async () => {
      try {
        await navigator.serviceWorker.register("sw.js");
        return { name: "registered", message: "" };
      } catch (error) {
        return error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: "rejected", message: "" };
      }
    });
    expect(registration.name).toBe("SecurityError");
    expect(registration.message).toMatch(/Content Security Policy/u);
    expect(stack.httpRequests.some((request) => request.url === "/sw.js")).toBe(false);
  } finally {
    await stack.close();
  }
});

test("Chromium enforces frame ancestors, SOP, sandbox, and browser-generated WebSocket Origin", async ({ context, page }) => {
  const stack = await startStack();
  try {
    const events = await collectFrameEvents(page, stack.network!.broker.origin);
    await openHost(page, stack);
    await expect(page.locator("#visual-host")).toHaveAttribute("data-status", "loaded");
    await expect.poll(() => events.some((event) => event.type === "ws-open")).toBe(true);
    await expect.poll(() => events.some((event) => event.type === "ws-text" && event.value === "browser-text")).toBe(true);
    await expect.poll(() => events.some((event) => event.type === "ws-binary" && event.value === "4")).toBe(true);
    expect(events.find((event) => event.type === "ws-open")?.protocol).toBe(WS_PROTOCOL);
    await expect.poll(() => events.some((event) => event.type === "parent-dom-denied")).toBe(true);
    await expect.poll(() => events.some((event) => event.type === "popup-denied")).toBe(true);
    await expect.poll(() => events.some((event) => event.type === "top-navigation-denied")).toBe(true);

    expect(stack.wsRequests).toHaveLength(1);
    expect(stack.wsRequests[0]!.headers.origin).toBe(stack.network!.broker.origin);
    expect(stack.wsRequests[0]!.headers.cookie).toBeUndefined();
    expect(stack.wsRequests[0]!.headers.authorization).toBeUndefined();
    expect(stack.wsRequests[0]!.url).toBe("/socket");

    const frameUrl = page.frames().find((candidate) => candidate !== page.mainFrame())?.url();
    const wsUrl = frameUrl!.replace(/^http/u, "ws") + "socket";
    const childConnections = stack.wsConnections;
    const hostileSameSite = await openHostile(context, stack.foreignV6!, frameUrl!, wsUrl);
    expect(hostileSameSite.frameStatus).toBe(200);
    await expect(hostileSameSite.page.frameLocator("#foreign-frame").locator("#frame-ready")).toHaveCount(0);
    await expect(hostileSameSite.page.locator("#ws-result")).toHaveText("denied");
    expect(stack.wsConnections).toBe(childConnections);
    await hostileSameSite.page.close();

    const hostileIpv4 = await openHostile(context, stack.foreignV4!, frameUrl!, wsUrl);
    expect(hostileIpv4.frameStatus).toBe(403);
    await expect(hostileIpv4.page.frameLocator("#foreign-frame").locator("#frame-ready")).toHaveCount(0);
    await expect(hostileIpv4.page.locator("#ws-result")).toHaveText("denied");
    expect(stack.wsConnections).toBe(childConnections);
    await hostileIpv4.page.close();

    for (const foreign of [stack.foreignV6!, stack.foreignV4!]) {
      const deputy = await context.newPage();
      await deputy.goto(foreign.origin);
      const denied = deputy.waitForResponse((response) =>
        response.url().includes("/browser/projects/foreign/runs/foreign/visual"));
      await deputy.evaluate((url) => {
        location.href = url;
      }, `${stack.network!.app.origin}/browser/projects/foreign/runs/foreign/visual`);
      expect((await denied).status()).toBe(403);
      await deputy.close();
    }
    await page.frameLocator("#visual-frame").locator("body").evaluate(() => {
      (globalThis as typeof globalThis & { __riffTestSocket: WebSocket }).__riffTestSocket.send("still-open");
    });
    await expect.poll(() => events.some((event) =>
      event.type === "ws-text" && event.value === "still-open")).toBe(true);
  } finally {
    await stack.close();
  }
});

test("Chromium observes generation revocation before state reuse and cannot reconnect or restore cached frame content", async ({ page }) => {
  const stack = await startStack();
  try {
    const events = await collectFrameEvents(page, stack.network!.broker.origin);
    await openHost(page, stack);
    await expect.poll(() => events.some((event) => event.type === "ws-open")).toBe(true);
    const childConnections = stack.wsConnections;
    const documentHits = stack.documentHits;
    const finalFrameUrl = page.frames().find((candidate) => candidate !== page.mainFrame())?.url();
    expect(finalFrameUrl).toMatch(/\/frame\/c\//u);

    const rotationStatus = await page.evaluate(async () => {
      const response = await fetch("/api/browser-session/bootstrap", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      return response.status;
    });
    expect(rotationStatus).toBe(201);
    await expect.poll(() => events.some((event) => event.type === "ws-close" && event.code === 1008)).toBe(true);
    await expect.poll(() => events.some((event) => event.type === "ws-reconnect-denied")).toBe(true);
    expect(stack.wsConnections).toBe(childConnections);

    await page.locator("#visual-frame").evaluate((element: HTMLIFrameElement, url) => {
      element.src = url;
    }, finalFrameUrl!);
    await expect(page.frameLocator("#visual-frame").locator("body")).toContainText("visual_frame_session_denied");
    await expect.poll(() => stack.documentHits).toBe(documentHits);
    expect(stack.wsConnections).toBe(childConnections);
  } finally {
    await stack.close();
  }
});

test("run trash revokes nonce, frame, WebSocket, and Visual-Agent authority without restore revival", async ({ context, page }) => {
  const visualStore = new BrowserVisualAuthorityStore();
  const visualAuthority = new VisualAgentAuthority(visualStore, {
    ttlMs: 30_000,
    epochSecret: Buffer.alloc(32, 7),
  });
  const stack = await startStack({ visualAuthority });
  try {
    let lifecycle: "succeeded" | "trashed" = "succeeded";
    Object.assign(stack.app.a2!.service, {
      trashRun(input: { beforeCommit?: () => void }) {
        input.beforeCommit?.();
        lifecycle = "trashed";
        return {
          schemaVersion: 1,
          commandId: "command_browser_trash",
          action: "trash",
          projectId: PROJECT_ID,
          runId: RUN_ID,
          lifecycleDigest: "a".repeat(64),
          applied: true,
        };
      },
      restoreRun() {
        lifecycle = "succeeded";
        return {
          schemaVersion: 1,
          commandId: "command_browser_restore",
          action: "restore",
          projectId: PROJECT_ID,
          runId: RUN_ID,
          lifecycleDigest: "a".repeat(64),
          applied: true,
        };
      },
      getRun() {
        return { status: lifecycle };
      },
    });
    await page.addInitScript(() => {
      const originalFetch = globalThis.fetch.bind(globalThis);
      globalThis.fetch = async (input, init) => {
        const response = await originalFetch(input, init);
        const url = new URL(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
          location.href,
        );
        if (url.pathname === "/api/browser-session/bootstrap" && response.ok) {
          const body = await response.clone().json();
          (globalThis as typeof globalThis & { __riffCsrf?: string }).__riffCsrf =
            typeof body.csrfToken === "string" ? body.csrfToken : undefined;
        }
        return response;
      };
    });
    const events = await collectFrameEvents(page, stack.network!.broker.origin);
    await openHost(page, stack);
    await expect(page.locator("#visual-host")).toHaveAttribute("data-status", "loaded");
    await expect.poll(() => events.some((event) => event.type === "ws-open")).toBe(true);
    const redeemedFrameUrl = page.frames()
      .find((candidate) => candidate !== page.mainFrame())?.url();
    expect(redeemedFrameUrl).toMatch(/\/frame\/c\//u);
    const unredeemedFrameUrl = await page.evaluate(async ({ projectId, runId }) => {
      const csrf = (globalThis as typeof globalThis & { __riffCsrf?: string }).__riffCsrf;
      if (!csrf) throw new Error("browser csrf was not captured");
      const response = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/visual-frame-session`,
        {
          method: "POST",
          headers: { "x-riff-csrf": csrf },
        },
      );
      if (!response.ok) throw new Error(`frame issue failed: ${response.status}`);
      return (await response.json()).frameUrl as string;
    }, { projectId: PROJECT_ID, runId: RUN_ID });
    expect(unredeemedFrameUrl).toContain("/frame/redeem/");
    const operation = { kind: "observe_accessibility" } as const;
    const agentCapability = visualAuthority.mint({
      conversationId: visualStore.scope.conversationId,
      turnId: visualStore.scope.turnId,
      externalSessionGeneration: visualStore.scope.externalSessionGeneration,
      operation,
      intentAuthority: "proposal_only",
    });

    const trashStatus = await page.evaluate(async ({ projectId, runId }) => {
      const csrf = (globalThis as typeof globalThis & { __riffCsrf?: string }).__riffCsrf;
      const response = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/trash`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-riff-csrf": csrf ?? "",
          },
          body: JSON.stringify({
            commandId: "command_browser_trash",
            expectedLifecycleDigest: "a".repeat(64),
            confirmation: {
              action: "trash_run",
              projectId,
              runId,
              terminalStatus: "succeeded",
              terminalClosureDigest: "a".repeat(64),
            },
          }),
        },
      );
      return response.status;
    }, { projectId: PROJECT_ID, runId: RUN_ID });
    expect(trashStatus).toBe(200);
    expect(lifecycle).toBe("trashed");
    await expect.poll(() => events.some((event) =>
      event.type === "ws-close" && event.code === 1008)).toBe(true);
    await expect.poll(() => events.some((event) =>
      event.type === "ws-reconnect-denied")).toBe(true);
    expect(() => visualAuthority.consume(agentCapability, operation))
      .toThrow(VisualAgentAuthorityError);
    expect(visualStore.facts.at(-1)?.outcomeCode).toBe("run_revoked");

    const nonceReplay = await context.newPage();
    await nonceReplay.goto(unredeemedFrameUrl);
    await expect(nonceReplay.locator("body")).toContainText("visual_frame_nonce_invalid");
    await page.locator("#visual-frame").evaluate(
      (element: HTMLIFrameElement, url) => {
        element.src = url;
      },
      redeemedFrameUrl!,
    );
    await expect(page.frameLocator("#visual-frame").locator("body"))
      .toContainText("visual_frame_session_denied");

    const restoreStatus = await page.evaluate(async ({ projectId, runId }) => {
      const csrf = (globalThis as typeof globalThis & { __riffCsrf?: string }).__riffCsrf;
      const response = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/restore`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-riff-csrf": csrf ?? "",
          },
          body: JSON.stringify({
            commandId: "command_browser_restore",
            expectedLifecycleDigest: "a".repeat(64),
          }),
        },
      );
      return response.status;
    }, { projectId: PROJECT_ID, runId: RUN_ID });
    expect(restoreStatus).toBe(200);
    expect(lifecycle).toBe("succeeded");
    await nonceReplay.goto(unredeemedFrameUrl);
    await expect(nonceReplay.locator("body")).toContainText("visual_frame_nonce_invalid");
    await page.locator("#visual-frame").evaluate(
      (element: HTMLIFrameElement, url) => {
        element.src = url;
      },
      redeemedFrameUrl!,
    );
    await expect(page.frameLocator("#visual-frame").locator("body"))
      .toContainText("visual_frame_session_denied");
    const childConnections = stack.wsConnections;
    const oldSocketResult = await page.frameLocator("#visual-frame").locator("body")
      .evaluate(async () => {
        const result = await new Promise<"opened" | "denied">((resolve) => {
          const socket = new WebSocket(new URL("socket", location.href), ["riff.echo"]);
          socket.onopen = () => {
            socket.close();
            resolve("opened");
          };
          socket.onerror = () => resolve("denied");
          socket.onclose = () => resolve("denied");
        });
        return result;
      });
    expect(oldSocketResult).toBe("denied");
    expect(stack.wsConnections).toBe(childConnections);
    expect(events.some((event) => event.type === "ws-reconnect-open")).toBe(false);
    expect(() => visualAuthority.consume(agentCapability, operation))
      .toThrow(VisualAgentAuthorityError);
    await nonceReplay.close();
  } finally {
    await stack.close();
  }
});

test("Chromium rejects an unredeemed nonce after the attempt expiry", async ({ page }) => {
  const stack = await startStack({ expiresInMs: 1_500 });
  try {
    await page.goto(`${stack.network!.app.origin}/health`);
    const frameUrl = await page.evaluate(async ({ projectId, runId }) => {
      const bootstrap = await fetch("/api/browser-session/bootstrap", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const session = await bootstrap.json();
      const issued = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/visual-frame-session`,
        { method: "POST", headers: { "x-riff-csrf": session.csrfToken } },
      );
      return (await issued.json()).frameUrl as string;
    }, { projectId: PROJECT_ID, runId: RUN_ID });
    expect(frameUrl).toContain("/frame/redeem/");
    await new Promise((resolve) => setTimeout(resolve, 1_700));
    await page.goto(frameUrl);
    await expect(page.locator("body")).toContainText("visual_frame_nonce_invalid");
    expect(stack.documentHits).toBe(0);
  } finally {
    await stack.close();
  }
});

test("Chromium cannot reuse a redeemed route after backend restart", async ({ page }) => {
  const stack = await startStack();
  try {
    await openHost(page, stack);
    await expect(page.frameLocator("#visual-frame").locator("#frame-ready")).toHaveText("ready");
    const finalFrameUrl = page.frames().find((candidate) => candidate !== page.mainFrame())?.url();
    expect(finalFrameUrl).toMatch(/\/frame\/c\//u);
    const hits = stack.documentHits;
    await stack.restartBackend();
    await page.goto(finalFrameUrl!);
    await expect(page.locator("body")).toContainText("visual_frame_session_denied");
    expect(stack.documentHits).toBe(hits);
  } finally {
    await stack.close();
  }
});

type FrameEvent = { type: string; value?: string; protocol?: string; code?: number };

const collectFrameEvents = async (page: Page, brokerOrigin: string): Promise<FrameEvent[]> => {
  const events: FrameEvent[] = [];
  await page.exposeFunction("__recordFrameEvent", (event: FrameEvent) => events.push(event));
  await page.addInitScript(({ source, brokerOrigin }) => {
    window.addEventListener("message", (message) => {
      const frame = document.getElementById("visual-frame") as HTMLIFrameElement | null;
      if (message.data?.source === source
        && message.origin === brokerOrigin
        && message.source === frame?.contentWindow) {
        void (globalThis as typeof globalThis & {
          __recordFrameEvent(event: unknown): Promise<void>;
        }).__recordFrameEvent(message.data);
      }
    });
  }, { source: FRAME_MESSAGE_SOURCE, brokerOrigin });
  return events;
};

const openHost = async (page: Page, stack: TestStack): Promise<void> => {
  await page.goto(`${stack.network!.app.origin}/browser/projects/${PROJECT_ID}/runs/${RUN_ID}/visual`);
};

const openHostile = async (
  context: BrowserContext,
  server: AddressedServer,
  frameUrl: string,
  wsUrl: string,
): Promise<{ page: Page; frameStatus: number }> => {
  const page = await context.newPage();
  const frameResponse = page.waitForResponse((response) => response.url() === frameUrl);
  await page.goto(`${server.origin}/?frame=${encodeURIComponent(frameUrl)}&ws=${encodeURIComponent(wsUrl)}`);
  return { page, frameStatus: (await frameResponse).status() };
};

type AddressedServer = { server: Server; origin: string };

type TestStack = {
  app: BackendApp;
  network?: Awaited<ReturnType<BackendApp["listenBrowserNetwork"]>>;
  childServer: Server;
  childWebSockets: WebSocketServer;
  foreignV6?: AddressedServer;
  foreignV4?: AddressedServer;
  workspace: string;
  target: BrowserFrameTarget;
  resolver: BrowserFrameTargetResolver;
  httpRequests: Array<{ url: string | undefined; headers: IncomingHttpHeaders }>;
  wsRequests: Array<{ url: string | undefined; headers: IncomingHttpHeaders }>;
  documentHits: number;
  wsConnections: number;
  restartBackend(): Promise<void>;
  close(): Promise<void>;
};

const startStack = async (options: {
  expiresInMs?: number;
  visualAuthority?: VisualAgentAuthority;
} = {}): Promise<TestStack> => {
  const httpRequests: TestStack["httpRequests"] = [];
  const wsRequests: TestStack["wsRequests"] = [];
  const childServer = createServer((request, response) => {
    httpRequests.push({ url: request.url, headers: request.headers });
    if (request.url === "/") stack.documentHits += 1;
    const resources: Record<string, readonly [string, Buffer]> = {
      "/": ["text/html; charset=utf-8", Buffer.from(frameHtml())],
      "/assets/app.css": ["text/css; charset=utf-8", Buffer.from("body{color:green}")],
      "/assets/app.js": ["text/javascript; charset=utf-8", Buffer.from(frameScript())],
      "/assets/pixel.svg": ["image/svg+xml", Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"1\" height=\"1\"/>")],
      "/api/state": ["application/json; charset=utf-8", Buffer.from("{\"value\":\"state-ok\"}")],
      "/sw.js": ["text/javascript; charset=utf-8", Buffer.from("self.addEventListener('fetch',()=>{})")],
    };
    const [contentType, body] = resources[request.url ?? "/"] ?? ["text/plain; charset=utf-8", Buffer.from("missing")];
    response.writeHead(resources[request.url ?? "/"] ? 200 : 404, {
      "cache-control": "public, max-age=3600",
      "content-length": body.byteLength,
      "content-type": contentType,
      "set-cookie": "child_cookie=must-not-cross",
    });
    response.end(body);
  });
  const childWebSockets = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    handleProtocols: (protocols) => protocols.has(WS_PROTOCOL) ? WS_PROTOCOL : false,
  });
  childServer.on("upgrade", (request, socket, head) => {
    wsRequests.push({ url: request.url, headers: request.headers });
    childWebSockets.handleUpgrade(request, socket, head, (webSocket) => {
      childWebSockets.emit("connection", webSocket, request);
    });
  });
  childWebSockets.on("connection", (webSocket) => {
    stack.wsConnections += 1;
    webSocket.on("message", (data, isBinary) => webSocket.send(data, { binary: isBinary }));
  });
  await listen(childServer, "127.0.0.1");
  const childAddress = childServer.address();
  if (!childAddress || typeof childAddress === "string") throw new Error("Child listener missing.");

  const target: BrowserFrameTarget = Object.freeze({
    projectId: PROJECT_ID,
    runId: RUN_ID,
    attemptGeneration: 1,
    port: childAddress.port,
    expiresAtMs: Date.now() + (options.expiresInMs ?? 120_000),
    webSocket: Object.freeze({
      path: "/socket",
      subprotocols: Object.freeze([WS_PROTOCOL]),
      maxFrameBytes: 4_096,
      maxConnections: 2,
      idleTimeoutMs: 30_000,
    }),
  });
  const peers: BrowserFrameConnectedPeer[] = [];
  const resolver: BrowserFrameTargetResolver = {
    resolve: async (projectId, runId) =>
      projectId === PROJECT_ID && runId === RUN_ID ? target : null,
    inspect: async (candidate) => sameTarget(candidate, target),
    inspectConnectedPeer: async (candidate, peer) => {
      peers.push(peer);
      return sameTarget(candidate, target)
        && peer.localHost === "127.0.0.1"
        && peer.remoteHost === "127.0.0.1"
        && peer.remotePort === target.port;
    },
  };
  const workspace = await mkdtemp(join(tmpdir(), "riff-a3-2b4-browser-"));
  const app = new BackendApp({
    mesa: new BrowserFakeMesa(),
    openCode: new BrowserFakeOpenCode(),
    workspaceRoot: workspace,
    browserFrameTargetResolver: resolver,
    ...(options.visualAuthority
      ? {
          a2ProductRoot: join(workspace, "product"),
          a3VisualAuthority: options.visualAuthority,
        }
      : {}),
  });
  const stack: TestStack = {
    app,
    childServer,
    childWebSockets,
    workspace,
    target,
    resolver,
    httpRequests,
    wsRequests,
    documentHits: 0,
    wsConnections: 0,
    restartBackend: async () => {
      const appPort = stack.network!.app.port;
      const brokerPort = stack.network!.broker.port;
      await stack.app.close();
      stack.app = new BackendApp({
        mesa: new BrowserFakeMesa(),
        openCode: new BrowserFakeOpenCode(),
        workspaceRoot: workspace,
        browserFrameTargetResolver: resolver,
      });
      await stack.app.initialize();
      stack.network = await stack.app.listenBrowserNetwork(appPort, brokerPort);
    },
    close: async () => {
      await stack.app.close();
      for (const client of childWebSockets.clients) client.terminate();
      await closeWebSocketServer(childWebSockets);
      await closeServer(childServer);
      if (stack.foreignV6) await closeServer(stack.foreignV6.server);
      if (stack.foreignV4) await closeServer(stack.foreignV4.server);
      await rm(workspace, { recursive: true, force: true });
    },
  };
  await app.initialize();
  stack.network = await app.listenBrowserNetwork();
  stack.foreignV6 = await startForeignServer("::1");
  stack.foreignV4 = await startForeignServer("127.0.0.1");
  return stack;
};

const frameHtml = (): string => `<!doctype html>
<html><head><link rel="stylesheet" href="assets/app.css"></head>
<body><strong id="frame-ready">ready</strong><span id="state"></span>
<img id="pixel" src="assets/pixel.svg" alt="">
<script src="assets/app.js"></script></body></html>`;

const frameScript = (): string => `(() => {
  const send = (type, detail = {}) => parent.postMessage({ source: "${FRAME_MESSAGE_SOURCE}", type, ...detail }, "*");
  fetch("api/state").then((response) => response.json()).then((body) => {
    document.querySelector("#state").textContent = body.value;
  });
  try { void parent.document.body; send("parent-dom-readable"); }
  catch { send("parent-dom-denied"); }
  try { const popup = window.open("about:blank"); if (popup) popup.close(); send(popup ? "popup-opened" : "popup-denied"); }
  catch { send("popup-denied"); }
  try { top.location.href = "http://127.0.0.1:1/escape"; send("top-navigation-opened"); }
  catch { send("top-navigation-denied"); }
  let reconnectAttempted = false;
  const connect = () => {
    const socket = new WebSocket(new URL("socket", location.href), ["${WS_PROTOCOL}"]);
    globalThis.__riffTestSocket = socket;
    socket.binaryType = "arraybuffer";
    socket.onopen = () => {
      send(reconnectAttempted ? "ws-reconnect-open" : "ws-open", { protocol: socket.protocol });
      if (!reconnectAttempted) {
        socket.send("browser-text");
        socket.send(new Uint8Array([1, 2, 3, 4]));
      }
    };
    socket.onmessage = (message) => {
      if (typeof message.data === "string") send("ws-text", { value: message.data });
      else send("ws-binary", { value: String(message.data.byteLength) });
    };
    socket.onerror = () => {
      if (reconnectAttempted) send("ws-reconnect-denied");
    };
    socket.onclose = (event) => {
      send("ws-close", { code: event.code });
      if (!reconnectAttempted && event.code === 1008) {
        reconnectAttempted = true;
        connect();
      }
    };
  };
  connect();
})();`;

const startForeignServer = async (host: "::1" | "127.0.0.1"): Promise<AddressedServer> => {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://foreign.invalid");
    const frame = url.searchParams.get("frame") ?? "";
    const ws = url.searchParams.get("ws") ?? "";
    const body = Buffer.from(`<!doctype html><body>
      <iframe id="foreign-frame" src="${escapeHtml(frame)}"></iframe>
      <output id="ws-result">pending</output>
      <script>
        const socket = new WebSocket(${JSON.stringify(ws)}, ["${WS_PROTOCOL}"]);
        socket.onopen = () => document.querySelector("#ws-result").textContent = "opened";
        socket.onerror = () => document.querySelector("#ws-result").textContent = "denied";
      </script>
    </body>`);
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-length": body.byteLength,
      "content-type": "text/html; charset=utf-8",
    });
    response.end(body);
  });
  await listen(server, host);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Foreign listener missing.");
  return { server, origin: `http://${host === "::1" ? "localhost" : host}:${address.port}` };
};

const listen = (server: Server, host: string): Promise<void> => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen({ host, port: 0 }, resolve);
});

const closeServer = (server: Server): Promise<void> => new Promise((resolve) => {
  if (!server.listening) return resolve();
  server.close(() => resolve());
  server.closeAllConnections?.();
});

const closeWebSocketServer = (server: WebSocketServer): Promise<void> => new Promise((resolve) => {
  server.close(() => resolve());
});

const sameTarget = (left: BrowserFrameTarget, right: BrowserFrameTarget): boolean =>
  left.projectId === right.projectId
  && left.runId === right.runId
  && left.attemptGeneration === right.attemptGeneration
  && left.port === right.port
  && left.expiresAtMs === right.expiresAtMs;

const escapeHtml = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll("\"", "&quot;").replaceAll("<", "&lt;");

class BrowserFakeMesa implements MesaAdapter {
  async loadModel(): Promise<MesaModel> { throw new Error("unused"); }
  async startRun(_projectId: string, _request: MesaRunRequest): Promise<MesaRun> { throw new Error("unused"); }
  async getRun(): Promise<MesaRun> { throw new Error("unused"); }
  async cancelRun(): Promise<MesaRun> { throw new Error("unused"); }
  async getResults(): Promise<MesaResults> { throw new Error("unused"); }
}

class BrowserFakeOpenCode implements OpenCodeAdapter {
  async initialize(): Promise<OpenCodeReadiness> { return { status: "unconfigured", modelId: null }; }
  async discoverProviderModels(): Promise<[]> { return []; }
  async getSession(): Promise<boolean> { return false; }
  async createSession(): Promise<string> { throw new Error("unused"); }
  async injectContext(): Promise<void> {}
  async promptWithModel(): Promise<never> { throw new Error("unused"); }
  async prompt(_sessionId: string, _prompt: OpenCodePrompt): Promise<void> { throw new Error("unused"); }
  async abort(): Promise<void> {}
}

class BrowserVisualAuthorityStore implements VisualAgentAuthorityStore {
  readonly scope: VisualAgentTurnScope = Object.freeze({
    conversationId: "conversation_browser_revocation",
    turnId: "turn_browser_revocation",
    immutableUserMessageId: "message_browser_revocation",
    externalSessionGeneration: 1,
    projectId: PROJECT_ID,
  });
  readonly target: VisualAgentTarget = Object.freeze({
    projectId: PROJECT_ID,
    runId: RUN_ID,
    attemptId: "attempt_browser_revocation",
    attemptGeneration: 1,
    dispatcherGeneration: "b".repeat(64),
    attemptExpiresAt: new Date(Date.now() + 120_000).toISOString(),
    processAttemptId: "process_browser_revocation",
    pid: 9_001,
    processStartToken: "browser-revocation-process-token",
    processGroupId: 9_001,
    loopbackHost: "127.0.0.1",
    loopbackPort: 45_678,
    entryPath: "/",
    healthPath: "/health",
    healthyAt: new Date(Date.now() - 1_000).toISOString(),
  });
  readonly facts: VisualAgentAuditFactInput[] = [];

  resolveVisualAgentTurnScope(input: {
    conversationId: string;
    turnId: string;
    externalSessionGeneration: number;
  }): VisualAgentTurnScope {
    if (input.conversationId !== this.scope.conversationId
      || input.turnId !== this.scope.turnId
      || input.externalSessionGeneration !== this.scope.externalSessionGeneration) {
      throw new Error("scope unavailable");
    }
    return this.scope;
  }

  currentHealthyVisualAgentTarget(projectId: string): VisualAgentTarget {
    if (projectId !== PROJECT_ID) throw new Error("target unavailable");
    return this.target;
  }

  recordVisualAgentAuditFact(input: VisualAgentAuditFactInput): void {
    this.facts.push(input);
  }
}
