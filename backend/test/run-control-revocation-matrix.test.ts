import assert from "node:assert/strict";
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import test from "node:test";
import {
  VisualAgentAuthority,
  VisualAgentAuthorityError,
  type VisualAgentAuditFactInput,
  type VisualAgentAuthorityStore,
  type VisualAgentTarget,
  type VisualAgentTurnScope,
} from "../src/agent-visual-authority.ts";
import {
  BrowserFrameCapability,
  BrowserFrameCapabilityError,
  type BrowserFrameWebSocketOwner,
} from "../src/browser-frame-capability.ts";
import { ApiError } from "../src/errors.ts";
import type { AgentWorkspaceService } from "../src/agent-workspace-service.ts";
import { MilestoneA2Api } from "../src/milestone-a2-api.ts";

const PROJECT_ID = "project_revocation_matrix";
const RUN_ID = "run_revocation_matrix";
const DIGEST = "a".repeat(64);
const NOW_MS = Date.parse("2026-07-25T18:00:00.000Z");
const APP_PATH = `/api/projects/${PROJECT_ID}/runs/${RUN_ID}`;
const WEB_SOCKET_POLICY = Object.freeze({
  path: "/events",
  subprotocols: Object.freeze(["riff.visual.v1"]),
  maxFrameBytes: 65_536,
  maxConnections: 1,
  idleTimeoutMs: 30_000,
});

test("run trash route revokes every visual authority and restore cannot revive it", async (t) => {
  let api: MilestoneA2Api | undefined;
  const server = createServer((request, response) => {
    void handle(api, request, response);
  });
  const port = await listen(server);
  t.after(() => close(server));

  const appOrigin = `http://localhost:${port}`;
  const brokerOrigin = `http://localhost:${port + 1}`;
  const target = Object.freeze({
    projectId: PROJECT_ID,
    runId: RUN_ID,
    attemptGeneration: 1,
    port: 45_678,
    expiresAtMs: NOW_MS + 60_000,
    webSocket: WEB_SOCKET_POLICY,
  });
  const frames = new BrowserFrameCapability({
    appOrigin,
    brokerOrigin,
    now: () => NOW_MS,
    targets: {
      resolve: async (projectId, runId) =>
        projectId === PROJECT_ID && runId === RUN_ID ? target : null,
      inspect: async () => true,
    },
  });
  const visualStore = new MatrixVisualStore();
  const visualAuthority = new VisualAgentAuthority(visualStore, {
    now: () => new Date(NOW_MS),
    ttlMs: 30_000,
    epochSecret: Buffer.alloc(32, 7),
  });
  let lifecycle: "succeeded" | "trashed" = "succeeded";
  const service = {
    trashRun(input: { beforeCommit?: () => void }) {
      input.beforeCommit?.();
      lifecycle = "trashed";
      return {
        schemaVersion: 1,
        commandId: "command_trash_matrix",
        action: "trash",
        projectId: PROJECT_ID,
        runId: RUN_ID,
        lifecycleDigest: DIGEST,
        applied: true,
      };
    },
    restoreRun() {
      lifecycle = "succeeded";
      return {
        schemaVersion: 1,
        commandId: "command_restore_matrix",
        action: "restore",
        projectId: PROJECT_ID,
        runId: RUN_ID,
        lifecycleDigest: DIGEST,
        applied: true,
      };
    },
    getRun() {
      return { status: lifecycle };
    },
  } as unknown as AgentWorkspaceService;
  api = new MilestoneA2Api(service, {
    authorizeProductMutation: (request) => frames.authorizeAppMutation({
      method: request.method ?? "",
      host: request.headers.host,
      origin: request.headers.origin,
      fetchSite: request.headers["sec-fetch-site"],
      fetchMode: request.headers["sec-fetch-mode"],
      fetchDest: request.headers["sec-fetch-dest"],
      cookie: request.headers.cookie,
      csrf: request.headers["x-riff-csrf"],
      authorization: request.headers.authorization,
    }),
    revokeRunAccess: (runId) => {
      frames.revokeRun(runId);
      visualAuthority.revokeRun(runId);
    },
  });

  const bootstrap = frames.bootstrap({
    method: "POST",
    host: `localhost:${port}`,
    origin: appOrigin,
    fetchSite: "same-origin",
    fetchMode: "cors",
    fetchDest: "empty",
  });
  const appMutation = {
    method: "POST",
    host: `localhost:${port}`,
    origin: appOrigin,
    fetchSite: "same-origin",
    fetchMode: "cors",
    fetchDest: "empty",
    cookie: cookiePair(bootstrap.setCookie),
    csrf: bootstrap.csrfToken,
  } as const;
  const unredeemed = await frames.issueFrameSession(appMutation, {
    projectId: PROJECT_ID,
    runId: RUN_ID,
  });
  const redeemable = await frames.issueFrameSession(appMutation, {
    projectId: PROJECT_ID,
    runId: RUN_ID,
  });
  const redeemed = await frames.redeem({
    method: "GET",
    host: new URL(brokerOrigin).host,
    path: new URL(redeemable.frameUrl).pathname,
  });
  const webSocketOwner = new RecordingWebSocketOwner();
  const oldWebSocketRequest = {
    method: "GET",
    host: new URL(brokerOrigin).host,
    origin: brokerOrigin,
    cookie: cookiePair(redeemed.setCookie),
    path: `${redeemed.location}events`,
    protocols: "riff.visual.v1",
    upgrade: "websocket",
    connection: "Upgrade",
    version: "13",
    key: "AQEBAQEBAQEBAQEBAQEBAQ==",
  } as const;
  const webSocket = await frames.admitWebSocket(oldWebSocketRequest, webSocketOwner);
  webSocket.markOpen();
  const operation = { kind: "observe_accessibility" } as const;
  const visualCapability = visualAuthority.mint({
    conversationId: visualStore.scope.conversationId,
    turnId: visualStore.scope.turnId,
    externalSessionGeneration: visualStore.scope.externalSessionGeneration,
    operation,
    intentAuthority: "proposal_only",
  });

  const trash = await command(port, bootstrap, "trash", {
    commandId: "command_trash_matrix",
    expectedLifecycleDigest: DIGEST,
    confirmation: {
      action: "trash_run",
      projectId: PROJECT_ID,
      runId: RUN_ID,
      terminalStatus: "succeeded",
      terminalClosureDigest: DIGEST,
    },
  });
  assert.equal(trash.status, 200, trash.text);
  assert.equal(lifecycle, "trashed");
  await assert.rejects(
    frames.redeem({
      method: "GET",
      host: new URL(brokerOrigin).host,
      path: new URL(unredeemed.frameUrl).pathname,
    }),
    capabilityError("visual_frame_nonce_invalid"),
  );
  await assert.rejects(
    frames.proxy({
      method: "GET",
      host: new URL(brokerOrigin).host,
      path: redeemed.location,
      cookie: cookiePair(redeemed.setCookie),
    }),
    capabilityError("visual_frame_session_denied"),
  );
  assert.deepEqual(webSocketOwner.codes, [1008]);
  assert.equal(webSocket.live(), false);
  await assert.rejects(webSocket.recheck(), capabilityError("visual_frame_session_denied"));
  assert.throws(
    () => visualAuthority.consume(visualCapability, operation),
    VisualAgentAuthorityError,
  );
  assert.equal(visualStore.facts.at(-1)?.outcomeCode, "run_revoked");

  const restore = await command(port, bootstrap, "restore", {
    commandId: "command_restore_matrix",
    expectedLifecycleDigest: DIGEST,
  });
  assert.equal(restore.status, 200, restore.text);
  assert.equal(lifecycle, "succeeded");
  await assert.rejects(
    frames.redeem({
      method: "GET",
      host: new URL(brokerOrigin).host,
      path: new URL(unredeemed.frameUrl).pathname,
    }),
    capabilityError("visual_frame_nonce_invalid"),
  );
  await assert.rejects(
    frames.proxy({
      method: "GET",
      host: new URL(brokerOrigin).host,
      path: redeemed.location,
      cookie: cookiePair(redeemed.setCookie),
    }),
    capabilityError("visual_frame_session_denied"),
  );
  assert.equal(webSocket.live(), false);
  await assert.rejects(
    frames.admitWebSocket(oldWebSocketRequest, new RecordingWebSocketOwner()),
    capabilityError("visual_frame_session_denied"),
  );
  assert.throws(
    () => visualAuthority.consume(visualCapability, operation),
    VisualAgentAuthorityError,
  );
});

class MatrixVisualStore implements VisualAgentAuthorityStore {
  readonly scope: VisualAgentTurnScope = Object.freeze({
    conversationId: "conversation_revocation_matrix",
    turnId: "turn_revocation_matrix",
    immutableUserMessageId: "message_revocation_matrix",
    externalSessionGeneration: 1,
    projectId: PROJECT_ID,
  });
  readonly target: VisualAgentTarget = Object.freeze({
    projectId: PROJECT_ID,
    runId: RUN_ID,
    attemptId: "attempt_revocation_matrix",
    attemptGeneration: 1,
    dispatcherGeneration: "b".repeat(64),
    attemptExpiresAt: new Date(NOW_MS + 60_000).toISOString(),
    processAttemptId: "process_revocation_matrix",
    pid: 9_001,
    processStartToken: "revocation-matrix-process-token",
    processGroupId: 9_001,
    loopbackHost: "127.0.0.1",
    loopbackPort: 45_678,
    entryPath: "/",
    healthPath: "/health",
    healthyAt: new Date(NOW_MS - 1_000).toISOString(),
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

class RecordingWebSocketOwner implements BrowserFrameWebSocketOwner {
  readonly codes: number[] = [];
  close(code: 1008): void {
    this.codes.push(code);
  }
}

const command = async (
  port: number,
  bootstrap: { csrfToken: string; setCookie: string },
  action: "trash" | "restore",
  body: Record<string, unknown>,
): Promise<{ status: number; text: string }> => new Promise((resolve, reject) => {
  const bytes = Buffer.from(JSON.stringify(body));
  const request = httpRequest({
    host: "127.0.0.1",
    port,
    path: `${APP_PATH}/${action}`,
    method: "POST",
    headers: {
      host: `localhost:${port}`,
      origin: `http://localhost:${port}`,
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "cors",
      "sec-fetch-dest": "empty",
      cookie: cookiePair(bootstrap.setCookie),
      "x-riff-csrf": bootstrap.csrfToken,
      "content-type": "application/json",
      "content-length": bytes.byteLength,
    },
  }, (response) => {
    const chunks: Buffer[] = [];
    response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    response.on("end", () => resolve({
      status: response.statusCode ?? 0,
      text: Buffer.concat(chunks).toString("utf8"),
    }));
  });
  request.once("error", reject);
  request.end(bytes);
});

const handle = async (
  api: MilestoneA2Api | undefined,
  request: IncomingMessage,
  response: import("node:http").ServerResponse,
): Promise<void> => {
  try {
    if (!api) throw new ApiError(503, "api_unavailable", "The API is unavailable.");
    const url = new URL(request.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (!await api.handle(request, response, url, parts)) {
      throw new ApiError(404, "not_found", "No matching route.");
    }
  } catch (error) {
    const failure = error instanceof ApiError
      ? error
      : new ApiError(500, "unexpected_error", "The request failed.");
    const bytes = Buffer.from(JSON.stringify({
      accepted: false,
      error: { code: failure.code, message: failure.message },
    }));
    response.writeHead(failure.status, {
      "cache-control": "private, no-store",
      "content-type": "application/json; charset=utf-8",
      "content-length": bytes.byteLength,
    });
    response.end(bytes);
  }
};

const listen = async (server: Server): Promise<number> => {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
};

const close = (server: Server): Promise<void> =>
  new Promise((resolve) => server.close(() => resolve()));

const cookiePair = (setCookie: string): string => setCookie.split(";", 1)[0];

const capabilityError = (code: BrowserFrameCapabilityError["code"]) =>
  (error: unknown): boolean =>
    error instanceof BrowserFrameCapabilityError && error.code === code;
