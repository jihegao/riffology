import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentTurnRuntime } from "../src/agent-turn-runtime.ts";
import { AgentWorkspaceService } from "../src/agent-workspace-service.ts";
import {
  BrowserAgentAuthority,
  BrowserAgentAuthorityError,
} from "../src/browser-agent-authority.ts";
import { browserAgentOperationCommitment } from "../src/browser-agent-tools.ts";
import {
  LocalBrowserBroker,
  registerLocalBrowserTarget,
} from "../src/local-browser-broker.ts";
import type {
  OpenCodeAssistantResponse,
  OpenCodeConversationPort,
  OpenCodeConversationRuntimeSnapshot,
  OpenCodePrompt,
  OpenCodeProviderModel,
  OpenCodeWorkspaceBinding,
} from "../src/opencode-adapter.ts";
import { ProductStoreV2 } from "../src/product-store-v2.ts";

type Deferred = { promise: Promise<void>; resolve: () => void };
const deferred = (): Deferred => {
  let resolve!: () => void;
  return { promise: new Promise<void>((done) => { resolve = done; }), resolve };
};

class ControlledOpenCode implements OpenCodeConversationPort {
  readonly catalogue: OpenCodeProviderModel[] = [{ providerId: "provider", modelId: "model", qualifiedId: "provider/model" }];
  readonly sessions = new Map<string, string>();
  readonly starts: Array<{ conversationId: string; text: string }> = [];
  readonly holds = new Map<string, Deferred>();
  readonly aborted: string[] = [];
  readonly permissionResponses: string[] = [];
  readonly permissionDecisions: Array<"once" | "reject"> = [];
  readonly returned = new Set<string>();
  readonly creating: string[] = [];
  readonly controlWorkspaces: OpenCodeWorkspaceBinding[] = [];
  cleanupHold?: Deferred;
  createHold?: Deferred;
  onAbort?: () => void;
  permissionAuthority: { toolName: "browser_open"; operationCommitment: string } | null = null;
  #nextSession = 0;

  hold(text: string): Deferred { const value = deferred(); this.holds.set(text, value); return value; }
  async discoverProviderModels(): Promise<OpenCodeProviderModel[]> { return this.catalogue; }
  async getSession(sessionId: string): Promise<boolean> { return this.sessions.has(sessionId); }
  async createSession(conversationId: string): Promise<string> {
    this.creating.push(conversationId);
    if (this.createHold) await this.createHold.promise;
    const id = `opaque-session-${++this.#nextSession}`;
    this.sessions.set(id, conversationId);
    return id;
  }
  async injectContext(): Promise<void> {}
  async promptWithModel(
    sessionId: string,
    _binding: { providerId: string; modelId: string },
    prompt: OpenCodePrompt,
    signal?: AbortSignal,
  ): Promise<OpenCodeAssistantResponse> {
    const conversationId = this.sessions.get(sessionId);
    if (!conversationId) throw new Error("unknown test session");
    this.starts.push({ conversationId, text: prompt.text });
    const hold = this.holds.get(prompt.text);
    if (hold) {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => reject(signal?.reason ?? new Error("aborted"));
        if (signal?.aborted) return onAbort();
        signal?.addEventListener("abort", onAbort, { once: true });
        void hold.promise.then(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        });
      });
    }
    this.returned.add(sessionId);
    return {
      messageId: `upstream-${this.starts.length}`,
      text: `answer:${prompt.text}`,
      content: { source: "opencode", textParts: 1, parts: [{ ordinal: 0, kind: "text", state: "complete" }] },
    };
  }
  async abort(sessionId: string, workspace: OpenCodeWorkspaceBinding): Promise<void> {
    this.onAbort?.();
    this.controlWorkspaces.push(workspace);
    this.aborted.push(sessionId);
  }
  async runtimeSnapshot(
    sessionId: string,
    _scopeId: string | undefined,
    workspace: OpenCodeWorkspaceBinding,
  ): Promise<OpenCodeConversationRuntimeSnapshot> {
    this.controlWorkspaces.push(workspace);
    if (this.returned.has(sessionId) && this.cleanupHold) await this.cleanupHold.promise;
    return {
      status: "busy",
      assistant: { status: "streaming", text: "Waiting for a scoped answer." },
      tools: [],
      interactions: [{
        id: "permission_public",
        kind: "permission",
        title: "Permission required",
        permission: "Allow this scoped Agent tool for the current turn?",
      }],
      failureCode: null,
      scopedMcp: { label: "Riff tools", status: "disconnected" },
    };
  }
  async respondPermission(
    _sessionId: string,
    publicRequestId: string,
    response: "once" | "reject",
    workspace: OpenCodeWorkspaceBinding,
  ): Promise<void> {
    this.controlWorkspaces.push(workspace);
    this.permissionResponses.push(publicRequestId);
    this.permissionDecisions.push(response);
  }
  async resolvePermissionAuthority(): Promise<typeof this.permissionAuthority> {
    return this.permissionAuthority;
  }
}

const waitFor = async (predicate: () => boolean | Promise<boolean>): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("timed out waiting for concurrent turn state");
};

test("runTurn merges one request key, serializes different keys per conversation, and preserves cross-conversation parallelism", async () => {
  const parent = mkdtempSync(join(tmpdir(), "riff-agent-workspace-concurrency-"));
  const store = ProductStoreV2.open(join(parent, "store"));
  const openCode = new ControlledOpenCode();
  const service = new AgentWorkspaceService(store, openCode, () => "2026-07-22T09:00:00.000Z");
  try {
    const created = await service.createModel({ commandId: "model-command", name: "Concurrent", providerId: "provider", modelId: "model" });
    const secondConversation = await service.createConversation({ commandId: "second-conversation", owner: { kind: "model", id: created.model.id },
      name: "Second", providerId: "provider", modelId: "model" });

    const firstHold = openCode.hold("first");
    const secondHold = openCode.hold("second");
    const first = service.runTurn({ conversationId: created.conversation.id, requestKey: "request-first", text: "first" });
    await waitFor(() => openCode.starts.some((item) => item.text === "first"));
    const second = service.runTurn({ conversationId: created.conversation.id, requestKey: "request-second", text: "second" });
    const duplicateSecond = service.runTurn({ conversationId: created.conversation.id, requestKey: "request-second", text: "second" });
    assert.equal(duplicateSecond, second, "same in-flight request key must return the same Promise");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(openCode.starts.some((item) => item.text === "second"), false, "a second key for one conversation must wait");
    firstHold.resolve();
    assert.equal((await first).turn.state, "complete");
    await waitFor(() => openCode.starts.some((item) => item.text === "second"));
    secondHold.resolve();
    assert.equal((await second).turn.state, "complete");
    assert.equal((await duplicateSecond).turn.requestKey, "request-second");
    assert.deepEqual(service.listMessages(created.conversation.id).map((message) => message.ordinal), [0, 1, 2, 3]);

    const leftHold = openCode.hold("parallel-left");
    const rightHold = openCode.hold("parallel-right");
    const left = service.runTurn({ conversationId: created.conversation.id, requestKey: "parallel-left", text: "parallel-left" });
    const right = service.runTurn({ conversationId: secondConversation.id, requestKey: "parallel-right", text: "parallel-right" });
    await waitFor(() => openCode.starts.some((item) => item.text === "parallel-left") && openCode.starts.some((item) => item.text === "parallel-right"));
    assert.notEqual(openCode.starts.find((item) => item.text === "parallel-left")!.conversationId,
      openCode.starts.find((item) => item.text === "parallel-right")!.conversationId);
    leftHold.resolve(); rightHold.resolve();
    assert.deepEqual((await Promise.all([left, right])).map((result) => result.turn.state), ["complete", "complete"]);

    const recoveryHold = openCode.hold("after-invalid");
    const invalid = service.runTurn({ conversationId: created.conversation.id, requestKey: "invalid-head", text: "" });
    const afterInvalid = service.runTurn({ conversationId: created.conversation.id, requestKey: "after-invalid", text: "after-invalid" });
    await assert.rejects(invalid, /empty or too large/u);
    await waitFor(() => openCode.starts.some((item) => item.text === "after-invalid"));
    recoveryHold.resolve();
    assert.equal((await afterInvalid).turn.state, "complete", "a rejected queue head must not poison later keys");
  } finally { store.close(); rmSync(parent, { recursive: true, force: true }); }
});

test("turn controls close at durable terminal state and serialize Stop ahead of Resume", async () => {
  const parent = mkdtempSync(join(tmpdir(), "riff-agent-turn-control-"));
  const store = ProductStoreV2.open(join(parent, "store"));
  const openCode = new ControlledOpenCode();
  const service = new AgentWorkspaceService(store, openCode, () => "2026-07-22T09:00:00.000Z");
  try {
    const created = await service.createModel({
      commandId: "control-model-command",
      name: "Turn controls",
      providerId: "provider",
      modelId: "model",
    });

    const cleanupHold = deferred();
    openCode.cleanupHold = cleanupHold;
    const completeHold = openCode.hold("complete-before-cleanup");
    const completing = service.runTurn({
      conversationId: created.conversation.id,
      requestKey: "request-complete-before-cleanup",
      text: "complete-before-cleanup",
    });
    await waitFor(() => openCode.starts.some((item) => item.text === "complete-before-cleanup"));
    completeHold.resolve();
    await waitFor(() =>
      store.latestAgentTurn(created.conversation.id)?.state === "complete");
    await assert.rejects(
      () => service.stopTurn(created.conversation.id, "request-complete-before-cleanup"),
      (error: any) => error.code === "turn_not_active",
    );
    assert.deepEqual(openCode.aborted, []);
    assert.equal((await service.conversationRuntime(created.conversation.id)).status, "idle");
    cleanupHold.resolve();
    assert.equal((await completing).turn.state, "complete");
    openCode.cleanupHold = undefined;

    const stopHold = openCode.hold("stop-before-resume");
    const running = service.runTurn({
      conversationId: created.conversation.id,
      requestKey: "request-stop-before-resume",
      text: "stop-before-resume",
    });
    await waitFor(() => openCode.starts.some((item) => item.text === "stop-before-resume"));
    const stopping = service.stopTurn(
      created.conversation.id,
      "request-stop-before-resume",
    );
    const resuming = service.resumeTurn({
      conversationId: created.conversation.id,
      requestKey: "request-stop-before-resume",
      interactionId: "permission_public",
      response: { kind: "permission", decision: "once" },
    });
    await assert.rejects(
      resuming,
      (error: any) => error.code === "turn_not_waiting",
    );
    const stoppedRuntime = await stopping;
    assert.equal(stoppedRuntime.status, "failed");
    assert.equal(stoppedRuntime.turnActive, false);
    assert.deepEqual(openCode.permissionResponses, []);
    assert.ok(openCode.aborted.length >= 1);
    assert.equal(openCode.controlWorkspaces.every((workspace) =>
      workspace.owner.kind === "model"
      && workspace.owner.id === created.model.id), true);
    assert.equal((await running).turn.state, "failed");
    assert.equal(
      service.getConversation(created.conversation.id).sessionState,
      "lost",
      "a user Stop is retryable turn failure, not persistent provider read-only state",
    );
    stopHold.resolve();

    const setupHold = deferred();
    openCode.createHold = setupHold;
    openCode.sessions.clear();
    const stoppedDuringSetup = service.runTurn({
      conversationId: created.conversation.id,
      requestKey: "request-stop-during-session-setup",
      text: "must-not-prompt-after-stop",
    });
    await waitFor(() => openCode.creating.length >= 2);
    const stoppingDuringSetup = service.stopTurn(
      created.conversation.id,
      "request-stop-during-session-setup",
    );
    setupHold.resolve();
    const setupRuntime = await stoppingDuringSetup;
    assert.equal(setupRuntime.turnActive, false);
    assert.equal(
      openCode.starts.some((item) => item.text === "must-not-prompt-after-stop"),
      false,
      "Stop during session setup must close the turn before prepare, MCP binding, or prompt",
    );
    assert.equal((await stoppedDuringSetup).turn.state, "failed");
  } finally { store.close(); rmSync(parent, { recursive: true, force: true }); }
});

test("native OpenCode Browser permission is rejected and cannot bypass the Riffology pending gate", async () => {
  const parent = mkdtempSync(join(tmpdir(), "riff-native-browser-permission-"));
  const store = ProductStoreV2.open(join(parent, "store"));
  const openCode = new ControlledOpenCode();
  openCode.permissionAuthority = {
    toolName: "browser_open",
    operationCommitment: "a".repeat(64),
  };
  const service = new AgentWorkspaceService(
    store,
    openCode,
    () => "2026-07-22T09:00:00.000Z",
  );
  try {
    const created = await service.createModel({
      commandId: "native-browser-model-command",
      name: "Native permission",
      providerId: "provider",
      modelId: "model",
    });
    const hold = openCode.hold("native browser permission");
    const running = service.runTurn({
      conversationId: created.conversation.id,
      requestKey: "request-native-browser",
      text: "native browser permission",
    });
    await waitFor(() => openCode.starts.some((item) => item.text === "native browser permission"));
    await assert.rejects(
      service.resumeTurn({
        conversationId: created.conversation.id,
        requestKey: "request-native-browser",
        interactionId: "permission_public",
        response: { kind: "permission", decision: "once" },
      }),
      (error: any) => error?.code === "browser_permission_gate_required",
    );
    assert.deepEqual(openCode.permissionDecisions, ["reject"]);
    const stopping = service.stopTurn(created.conversation.id, "request-native-browser");
    hold.resolve();
    await stopping;
    await running;
  } finally {
    store.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("stopTurn synchronously revokes an in-flight Browser wait before OpenCode abort", async () => {
  const parent = mkdtempSync(join(tmpdir(), "riff-agent-stop-browser-"));
  const store = ProductStoreV2.open(join(parent, "store"));
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>Stop Browser fixture</title><button aria-label='Ready'>Ready</button>");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "::1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://localhost:${address.port}`;
  const broker = new LocalBrowserBroker({
    resolveTarget: (alias) => registerLocalBrowserTarget({
      alias,
      url: `${origin}/control`,
      projectedUrl: `${alias}://control`,
    }),
  });
  const authority = new BrowserAgentAuthority(broker);
  const openCode = new ControlledOpenCode();
  let prepared: { turnId: string; workspace: OpenCodeWorkspaceBinding } | null = null;
  let revocationStarted = false;
  const events: string[] = [];
  const controlledRuntime = {
    async prepare(input: any) {
      prepared = { turnId: input.turnId, workspace: input.workspace };
      await authority.prepareDormant({
        scope: { conversationId: input.conversationId, conversationGeneration: 1 },
        turnId: input.turnId,
        workspace: input.workspace,
        target: "riff-app",
        operations: new Set(["browser_open", "browser_wait"] as const),
        budget: 4,
      });
      return Object.freeze({
        capability: "test-browser-capability",
        turnId: input.turnId,
        externalSessionGeneration: 1,
        intentAuthority: "explicit" as const,
        requiresMcp: false,
        allowedTools: Object.freeze([]),
        context: { attachments: [], documents: [], selectedSkills: [] },
        promptAttachments: [],
        release: async () => authority.revokeTurn(input.conversationId, input.turnId),
      });
    },
    revokeBrowserTurn(conversationId: string, turnId: string) {
      revocationStarted = true;
      events.push("browser-revoke");
      return authority.revokeTurn(conversationId, turnId);
    },
  } as unknown as AgentTurnRuntime;
  const service = new AgentWorkspaceService(
    store,
    openCode,
    () => "2026-07-22T09:00:00.000Z",
    undefined,
    controlledRuntime,
  );
  try {
    const created = await service.createModel({
      commandId: "stop-browser-model-command",
      name: "Stop Browser",
      providerId: "provider",
      modelId: "model",
    });
    const hold = openCode.hold("wait in browser");
    const running = service.runTurn({
      conversationId: created.conversation.id,
      requestKey: "request-stop-browser",
      text: "wait in browser",
    });
    await waitFor(() => openCode.starts.some((item) => item.text === "wait in browser"));
    assert.ok(prepared);
    const common = {
      conversationId: created.conversation.id,
      turnId: prepared.turnId,
      externalSessionGeneration: 1,
    };
    const activate = async (tool: "browser_open" | "browser_wait", input: Record<string, unknown>) =>
      authority.activatePermission({
        ...common,
        workspace: prepared!.workspace,
        tool,
        operationCommitment: browserAgentOperationCommitment(tool, input).digest,
      });
    await activate("browser_open", { alias: "riff-app" });
    await authority.execute({
      ...common,
      tool: "browser_open",
      arguments: { alias: "riff-app" },
    });
    await activate("browser_wait", { milliseconds: 2_000 });
    const waiting = authority.execute({
      ...common,
      tool: "browser_wait",
      arguments: { milliseconds: 2_000 },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    openCode.onAbort = () => {
      events.push("opencode-abort");
      assert.equal(revocationStarted, true,
        "Browser grant must be synchronously invalidated before OpenCode abort is observed");
    };
    const stopping = service.stopTurn(created.conversation.id, "request-stop-browser");
    await assert.rejects(
      waiting,
      (error: unknown) => error instanceof BrowserAgentAuthorityError
        && error.code === "browser_control_stale",
    );
    const stopped = await stopping;
    assert.equal(stopped.turnActive, false);
    assert.deepEqual(events.slice(0, 2), ["browser-revoke", "opencode-abort"]);
    await assert.rejects(
      activate("browser_wait", { milliseconds: 50 }),
      (error: unknown) => error instanceof BrowserAgentAuthorityError
        && error.code === "browser_grant_unavailable",
    );
    await assert.rejects(
      authority.execute({
        ...common,
        tool: "browser_wait",
        arguments: { milliseconds: 2_000 },
      }),
      (error: unknown) => error instanceof BrowserAgentAuthorityError
        && error.code === "browser_grant_unavailable",
    );
    assert.equal((await running).turn.state, "failed");
    hold.resolve();
  } finally {
    await broker.shutdown();
    await new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
    store.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("Conversation runtime projects and resolves a server-owned Browser permission without OpenCode permission reply", async () => {
  const parent = mkdtempSync(join(tmpdir(), "riff-agent-browser-permission-"));
  const store = ProductStoreV2.open(join(parent, "store"));
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>Permission fixture</title><button aria-label='Ready'>Ready</button>");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "::1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const broker = new LocalBrowserBroker({
    resolveTarget: (alias) => registerLocalBrowserTarget({
      alias,
      url: `http://localhost:${address.port}/control`,
      projectedUrl: `${alias}://control`,
    }),
  });
  const authority = new BrowserAgentAuthority(broker);
  const openCode = new ControlledOpenCode();
  let prepared: { turnId: string; workspace: OpenCodeWorkspaceBinding } | null = null;
  const controlledRuntime = {
    async prepare(input: any) {
      prepared = { turnId: input.turnId, workspace: input.workspace };
      await authority.prepareDormant({
        scope: { conversationId: input.conversationId, conversationGeneration: 1 },
        turnId: input.turnId,
        workspace: input.workspace,
        operations: new Set(["browser_open"] as const),
      });
      return Object.freeze({
        capability: "test-browser-pending-capability",
        turnId: input.turnId,
        externalSessionGeneration: 1,
        intentAuthority: "explicit" as const,
        requiresMcp: false,
        allowedTools: Object.freeze([]),
        context: { attachments: [], documents: [], selectedSkills: [] },
        promptAttachments: [],
        release: async () => authority.revokeTurn(input.conversationId, input.turnId),
      });
    },
    async browserPendingInteractions(conversationId: string, turnId: string) {
      return (await authority.pendingForTurn(conversationId, turnId)).map((item) => ({
        id: item.id,
        kind: "permission" as const,
        title: "Permission required",
        permission: `Allow ${item.tool} once for ${item.targetSummary}?`,
      }));
    },
    async respondBrowserPermission(input: any) {
      const pending = await authority.pendingForTurn(input.conversationId, input.turnId);
      if (!pending.some((item) => item.id === input.id)) return false;
      if (input.decision === "once") await authority.approvePending(input);
      else await authority.rejectPending(input);
      return true;
    },
    revokeBrowserTurn(conversationId: string, turnId: string) {
      return authority.revokeTurn(conversationId, turnId);
    },
  } as unknown as AgentTurnRuntime;
  const service = new AgentWorkspaceService(
    store,
    openCode,
    () => "2026-07-22T09:00:00.000Z",
    undefined,
    controlledRuntime,
  );
  try {
    const created = await service.createModel({
      commandId: "browser-permission-model-command",
      name: "Browser permission",
      providerId: "provider",
      modelId: "model",
    });
    const hold = openCode.hold("open browser");
    const running = service.runTurn({
      conversationId: created.conversation.id,
      requestKey: "request-browser-permission",
      text: "open browser",
    });
    await waitFor(() => openCode.starts.some((item) => item.text === "open browser"));
    assert.ok(prepared);
    const opening = authority.execute({
      conversationId: created.conversation.id,
      turnId: prepared.turnId,
      externalSessionGeneration: 1,
      tool: "browser_open",
      arguments: { alias: "riff-app" },
    });
    await waitFor(() => authority.pendingForTurn(
      created.conversation.id,
      prepared!.turnId,
    ).then((items) => items.length === 1));
    const runtime = await service.conversationRuntime(created.conversation.id);
    assert.equal(runtime.status, "waiting_for_user");
    const permission = runtime.interactions.find((item) => item.kind === "permission")!;
    assert.match(permission.id, /^browser_permission_[0-9a-f]{32}$/u);
    assert.doesNotMatch(JSON.stringify(permission), /commitment|digest|capability|localhost/iu);
    await service.resumeTurn({
      conversationId: created.conversation.id,
      requestKey: "request-browser-permission",
      interactionId: permission.id,
      response: { kind: "permission", decision: "once" },
    });
    assert.equal((await opening as any).controlMode, "agent");
    assert.deepEqual(openCode.permissionResponses, [],
      "the Browser gate is owned by Riffology, not OpenCode permission state");
    hold.resolve();
    assert.equal((await running).turn.state, "complete");
  } finally {
    await broker.shutdown();
    await new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
    store.close();
    rmSync(parent, { recursive: true, force: true });
  }
});
