import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { afterEach, test } from "node:test";
import {
  BrowserAgentAuthority,
  BrowserAgentAuthorityError,
} from "../src/browser-agent-authority.ts";
import {
  BROWSER_AGENT_TOOLS,
  browserAgentOperationCommitment,
} from "../src/browser-agent-tools.ts";
import {
  LocalBrowserBroker,
  LocalBrowserBrokerError,
  registerLocalBrowserTarget,
} from "../src/local-browser-broker.ts";

const brokers: LocalBrowserBroker[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.allSettled(brokers.splice(0).map((broker) => broker.shutdown()));
  await Promise.allSettled(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  })));
});

test("dormant Browser authority requires exact allow-once commitments for real snapshot and click", async () => {
  const origin = await fixture();
  const broker = new LocalBrowserBroker({
    pageGenerationSeed: 100,
    resolveTarget: (alias) => registerLocalBrowserTarget({
      alias,
      url: `${origin}/control`,
      projectedUrl: `${alias}://controlled`,
    }),
  });
  brokers.push(broker);
  const authority = new BrowserAgentAuthority(broker);
  const workspace = {
    owner: { kind: "project" as const, id: "project_browser_agent" },
    directory: "/private/server-owned/project_browser_agent",
  };
  const scope = { conversationId: "conversation_browser_agent", conversationGeneration: 3 };
  const common = {
    conversationId: scope.conversationId,
    turnId: "turn_browser_agent",
    externalSessionGeneration: scope.conversationGeneration,
  };
  await authority.prepareDormant({
    scope,
    turnId: common.turnId,
    workspace,
    target: "riff-app",
    operations: new Set(BROWSER_AGENT_TOOLS),
    budget: 8,
  });

  const opening = authority.execute({
    ...common,
    tool: "browser_open",
    arguments: { alias: "riff-app" },
  });
  await waitFor(async () => (await authority.pendingForTurn(
    common.conversationId,
    common.turnId,
  )).length === 1);
  const [pendingOpen] = await authority.pendingForTurn(
    common.conversationId,
    common.turnId,
  );
  assert.deepEqual(Object.keys(pendingOpen!).sort(), [
    "expiresAtMs", "id", "remainingBudget", "targetSummary", "tool",
  ]);
  assert.equal(pendingOpen!.tool, "browser_open");
  assert.equal(pendingOpen!.targetSummary, "alias riff-app");
  assert.doesNotMatch(JSON.stringify(pendingOpen), /private|digest|commitment|element_/iu);
  await authority.approvePending({
    id: pendingOpen!.id,
    ...common,
    workspace,
  });
  const opened = await opening as any;
  assert.equal(opened.projectedUrl, "riff-app://controlled");
  assert.equal((await broker.state(scope)).controlMode, "agent");

  await allow(authority, { ...common, workspace }, "browser_snapshot", {});
  const snapshot = await authority.execute({
    ...common,
    tool: "browser_snapshot",
    arguments: {},
  }) as any;
  const button = snapshot.elements.find((element: any) => element.name === "Increment");
  assert.match(button.ref, /^element_[0-9a-f]{32}$/u);
  assert.equal(button.name, "Increment");
  assert.equal(JSON.stringify(snapshot).includes(workspace.directory), false);

  await allow(authority, { ...common, workspace }, "browser_click", { ref: button.ref });
  await authority.execute({
    ...common,
    tool: "browser_click",
    arguments: { ref: button.ref },
  });

  await allow(authority, { ...common, workspace }, "browser_click", { ref: button.ref });
  await assert.rejects(
    authority.execute({
      ...common,
      tool: "browser_click",
      arguments: { ref: button.ref },
    }),
    (error: unknown) => authorityError(error, "browser_element_stale"),
  );
});

test("permission activation binds exact workspace, generation, operation, and normalized parameters", async () => {
  const origin = await fixture();
  const broker = new LocalBrowserBroker({
    resolveTarget: (alias) => registerLocalBrowserTarget({
      alias,
      url: `${origin}/control`,
      projectedUrl: `${alias}://controlled`,
    }),
  });
  brokers.push(broker);
  const authority = new BrowserAgentAuthority(broker);
  const workspace = {
    owner: { kind: "model" as const, id: "model_browser_agent" },
    directory: "/private/server-owned/model_browser_agent",
  };
  const scope = { conversationId: "conversation_model_browser", conversationGeneration: 7 };
  await authority.prepareDormant({
    scope,
    turnId: "turn_model_browser",
    workspace,
    target: "riff-app",
    operations: new Set(["browser_open"] as const),
  });
  const commitment = browserAgentOperationCommitment("browser_open", { alias: "riff-app" });
  await assert.rejects(
    authority.activatePermission({
      conversationId: scope.conversationId,
      turnId: "turn_model_browser",
      externalSessionGeneration: 8,
      workspace,
      tool: "browser_open",
      operationCommitment: commitment.digest,
    }),
    (error: unknown) => authorityError(error, "browser_grant_scope_mismatch"),
  );
  await assert.rejects(
    authority.execute({
      conversationId: scope.conversationId,
      turnId: "turn_model_browser",
      externalSessionGeneration: 7,
      tool: "browser_open",
      arguments: { alias: "riff-app" },
    }),
    (error: unknown) => authorityError(error, "browser_grant_unavailable"),
  );
});

test("server-owned pending permissions deduplicate and fail closed on reject, revoke, and TTL", async () => {
  const broker = { async releaseAgent() {} } as unknown as LocalBrowserBroker;
  const authority = new BrowserAgentAuthority(broker);
  const workspace = {
    owner: { kind: "model" as const, id: "model_pending" },
    directory: "/private/server-owned/model_pending",
  };
  const scope = { conversationId: "conversation_pending", conversationGeneration: 1 };
  const executeOpen = (turnId: string) => authority.execute({
    conversationId: scope.conversationId,
    turnId,
    externalSessionGeneration: 1,
    tool: "browser_open",
    arguments: { alias: "riff-app" },
  });

  await authority.prepareDormant({
    scope,
    turnId: "turn_reject",
    workspace,
    operations: new Set(["browser_open"] as const),
  });
  const first = executeOpen("turn_reject");
  const duplicate = executeOpen("turn_reject");
  await waitFor(async () => (await authority.pendingForTurn(
    scope.conversationId, "turn_reject",
  )).length === 1);
  const [pending] = await authority.pendingForTurn(scope.conversationId, "turn_reject");
  await authority.rejectPending({
    id: pending!.id,
    conversationId: scope.conversationId,
    turnId: "turn_reject",
  });
  for (const operation of [first, duplicate]) {
    await assert.rejects(
      operation,
      (error: unknown) => authorityError(error, "browser_permission_rejected"),
    );
  }

  await authority.prepareDormant({
    scope,
    turnId: "turn_revoke_pending",
    workspace,
    operations: new Set(["browser_open"] as const),
  });
  const revoked = executeOpen("turn_revoke_pending");
  await waitFor(async () => (await authority.pendingForTurn(
    scope.conversationId, "turn_revoke_pending",
  )).length === 1);
  await authority.revokeTurn(scope.conversationId, "turn_revoke_pending");
  await assert.rejects(
    revoked,
    (error: unknown) => authorityError(error, "browser_grant_unavailable"),
  );

  await authority.prepareDormant({
    scope,
    turnId: "turn_pending_ttl",
    workspace,
    operations: new Set(["browser_open"] as const),
    ttlMs: 20,
  });
  await assert.rejects(
    executeOpen("turn_pending_ttl"),
    (error: unknown) => authorityError(error, "browser_grant_expired"),
  );
  assert.deepEqual(await authority.pendingForTurn(
    scope.conversationId, "turn_pending_ttl",
  ), []);
});

test("real Chromium executes the remaining committed Browser tools and revokes on close", async () => {
  const origin = await fixture();
  const broker = new LocalBrowserBroker({
    pageGenerationSeed: 500,
    resolveTarget: (alias) => registerLocalBrowserTarget({
      alias,
      url: `${origin}/control`,
      projectedUrl: `${alias}://controlled`,
    }),
  });
  brokers.push(broker);
  const authority = new BrowserAgentAuthority(broker);
  const workspace = {
    owner: { kind: "project" as const, id: "project_remaining_tools" },
    directory: "/private/server-owned/project_remaining_tools",
  };
  const scope = { conversationId: "conversation_remaining_tools", conversationGeneration: 4 };
  const common = {
    conversationId: scope.conversationId,
    turnId: "turn_remaining_tools",
    externalSessionGeneration: scope.conversationGeneration,
  };
  await authority.prepareDormant({
    scope,
    turnId: common.turnId,
    workspace,
    operations: new Set(BROWSER_AGENT_TOOLS),
    budget: 20,
  });

  await allow(authority, { ...common, workspace }, "browser_open", { alias: "riff-app" });
  await authority.execute({ ...common, tool: "browser_open", arguments: { alias: "riff-app" } });
  await allow(authority, { ...common, workspace }, "browser_snapshot", {});
  const initial = await authority.execute({
    ...common,
    tool: "browser_snapshot",
    arguments: {},
  }) as any;
  const input = initial.elements.find((element: any) => element.name === "Message");
  assert.match(input.ref, /^element_[0-9a-f]{32}$/u);

  const exactText = "exact digest 世界";
  await allow(authority, { ...common, workspace }, "browser_type", {
    ref: input.ref,
    text: exactText,
  });
  await assert.rejects(
    authority.execute({
      ...common,
      tool: "browser_type",
      arguments: { ref: input.ref, text: `${exactText}!` },
    }),
    (error: unknown) => authorityError(error, "browser_operation_not_authorized"),
  );
  await authority.execute({
    ...common,
    tool: "browser_type",
    arguments: { ref: input.ref, text: exactText },
  });
  await allow(authority, { ...common, workspace }, "browser_snapshot", {});
  const typed = await authority.execute({
    ...common,
    tool: "browser_snapshot",
    arguments: {},
  }) as any;
  assert.ok(typed.elements.some((element: any) => element.name === "Changed"));

  await allow(authority, { ...common, workspace }, "browser_scroll", { deltaY: 600 });
  await authority.execute({ ...common, tool: "browser_scroll", arguments: { deltaY: 600 } });
  await allow(authority, { ...common, workspace }, "browser_wait", { milliseconds: 50 });
  await authority.execute({ ...common, tool: "browser_wait", arguments: { milliseconds: 50 } });
  await allow(authority, { ...common, workspace }, "browser_screenshot", {});
  const screenshot = await authority.execute({
    ...common,
    tool: "browser_screenshot",
    arguments: {},
  }) as any;
  assert.equal(screenshot.contentType, "image/png");
  assert.match(screenshot.pngBase64, /^iVBOR/u);

  await allow(authority, { ...common, workspace }, "browser_snapshot", {});
  const beforeReload = await authority.execute({
    ...common,
    tool: "browser_snapshot",
    arguments: {},
  }) as any;
  const staleRef = beforeReload.elements[0].ref;
  await allow(authority, { ...common, workspace }, "browser_reload", {});
  await authority.execute({ ...common, tool: "browser_reload", arguments: {} });
  const budgetBeforeFailure = (await broker.state(scope)).remainingBudget;
  await allow(authority, { ...common, workspace }, "browser_click", { ref: staleRef });
  await assert.rejects(
    authority.execute({ ...common, tool: "browser_click", arguments: { ref: staleRef } }),
    (error: unknown) => authorityError(error, "browser_element_stale"),
  );
  assert.equal((await broker.state(scope)).remainingBudget, Number(budgetBeforeFailure) - 1);

  await allow(authority, { ...common, workspace }, "browser_close", {});
  const closed = await authority.execute({
    ...common,
    tool: "browser_close",
    arguments: {},
  }) as any;
  assert.equal(closed.recoveryState, "closed");
  assert.equal(closed.remainingBudget, null);
  await assert.rejects(
    allow(authority, { ...common, workspace }, "browser_snapshot", {}),
    (error: unknown) => authorityError(error, "browser_grant_unavailable"),
  );
});

test("releaseAgent synchronously invalidates an in-flight wait control epoch", async () => {
  const origin = await fixture();
  const broker = new LocalBrowserBroker({
    pageGenerationSeed: 700,
    resolveTarget: (alias) => registerLocalBrowserTarget({
      alias,
      url: `${origin}/control`,
      projectedUrl: `${alias}://controlled`,
    }),
  });
  brokers.push(broker);
  const scope = { conversationId: "conversation_epoch", conversationGeneration: 2 };
  const opened = await broker.open(scope, "riff-app");
  const lease = await broker.claimAgent(scope, 5);
  const waiting = broker.agentWait(scope, opened.pageGeneration, lease.controlEpoch, 300);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const released = broker.releaseAgent(scope);
  await assert.rejects(
    waiting,
    (error: unknown) => brokerError(error, "browser_control_stale"),
  );
  assert.equal((await released).controlMode, "observer");
  assert.equal((await broker.state(scope)).remainingBudget, null);
});

test("authority takeover revokes the old grant and return requires a new grant", async () => {
  const origin = await fixture();
  const broker = new LocalBrowserBroker({
    pageGenerationSeed: 900,
    resolveTarget: (alias) => registerLocalBrowserTarget({
      alias,
      url: `${origin}/control`,
      projectedUrl: `${alias}://controlled`,
    }),
  });
  brokers.push(broker);
  const authority = new BrowserAgentAuthority(broker);
  const workspace = {
    owner: { kind: "model" as const, id: "model_takeover" },
    directory: "/private/server-owned/model_takeover",
  };
  const scope = { conversationId: "conversation_authority_takeover", conversationGeneration: 1 };
  const first = {
    conversationId: scope.conversationId,
    turnId: "turn_before_takeover",
    externalSessionGeneration: 1,
  };
  await authority.prepareDormant({
    scope,
    turnId: first.turnId,
    workspace,
    operations: new Set(BROWSER_AGENT_TOOLS),
  });
  await allow(authority, { ...first, workspace }, "browser_open", { alias: "riff-app" });
  await authority.execute({ ...first, tool: "browser_open", arguments: { alias: "riff-app" } });
  await allow(authority, { ...first, workspace }, "browser_snapshot", {});
  const before = await authority.execute({
    ...first,
    tool: "browser_snapshot",
    arguments: {},
  }) as any;
  const oldRef = before.elements[0].ref;
  const state = await broker.state(scope);
  await allow(authority, { ...first, workspace }, "browser_wait", { milliseconds: 1_000 });
  const waiting = authority.execute({
    ...first,
    tool: "browser_wait",
    arguments: { milliseconds: 1_000 },
  });
  const waitingRejected = assert.rejects(
    waiting,
    (error: unknown) => authorityError(error, "browser_control_stale"),
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  const human = await authority.takeoverConversation(scope, state.pageGeneration) as any;
  await waitingRejected;
  assert.equal(human.controlMode, "human");
  await assert.rejects(
    allow(authority, { ...first, workspace }, "browser_snapshot", {}),
    (error: unknown) => authorityError(error, "browser_grant_unavailable"),
  );

  const observer = await authority.returnConversationToObserver(
    scope,
    human.pageGeneration,
  ) as any;
  assert.equal(observer.controlMode, "observer");
  const second = { ...first, turnId: "turn_after_takeover" };
  await authority.prepareDormant({
    scope,
    turnId: second.turnId,
    workspace,
    operations: new Set(["browser_snapshot", "browser_click"] as const),
  });
  await allow(authority, { ...second, workspace }, "browser_snapshot", {});
  await authority.execute({ ...second, tool: "browser_snapshot", arguments: {} });
  await allow(authority, { ...second, workspace }, "browser_click", { ref: oldRef });
  await assert.rejects(
    authority.execute({ ...second, tool: "browser_click", arguments: { ref: oldRef } }),
    (error: unknown) => authorityError(error, "browser_element_stale"),
  );
});

test("budget, TTL, and duplicate allow-once commitments fail closed", async () => {
  const origin = await fixture();
  let now = 10_000;
  const broker = new LocalBrowserBroker({
    resolveTarget: (alias) => registerLocalBrowserTarget({
      alias,
      url: `${origin}/control`,
      projectedUrl: `${alias}://controlled`,
    }),
  });
  brokers.push(broker);
  const authority = new BrowserAgentAuthority(broker, { now: () => now });
  const workspace = {
    owner: { kind: "project" as const, id: "project_budget" },
    directory: "/private/server-owned/project_budget",
  };
  const scope = { conversationId: "conversation_budget", conversationGeneration: 1 };
  const common = {
    conversationId: scope.conversationId,
    turnId: "turn_budget",
    externalSessionGeneration: 1,
  };
  await authority.prepareDormant({
    scope,
    turnId: common.turnId,
    workspace,
    operations: new Set(["browser_open"] as const),
    budget: 2,
    ttlMs: 1_000,
  });
  await allow(authority, { ...common, workspace }, "browser_open", { alias: "riff-app" });
  await allow(authority, { ...common, workspace }, "browser_open", { alias: "riff-app" });
  await authority.execute({ ...common, tool: "browser_open", arguments: { alias: "riff-app" } });
  const replay = authority.execute({
    ...common,
    tool: "browser_open",
    arguments: { alias: "riff-app" },
  });
  await waitFor(async () => (await authority.pendingForTurn(
    scope.conversationId, common.turnId,
  )).length === 1);
  const [replayPermission] = await authority.pendingForTurn(
    scope.conversationId, common.turnId,
  );
  await authority.rejectPending({
    id: replayPermission!.id,
    conversationId: scope.conversationId,
    turnId: common.turnId,
  });
  await assert.rejects(
    replay,
    (error: unknown) => authorityError(error, "browser_permission_rejected"),
  );
  await authority.revokeTurn(scope.conversationId, common.turnId);
  assert.equal((await broker.state(scope)).controlMode, "observer");

  await authority.prepareDormant({
    scope,
    turnId: "turn_budget_one",
    workspace,
    operations: new Set(["browser_open"] as const),
    budget: 1,
  });
  await allow(authority, {
    conversationId: scope.conversationId,
    turnId: "turn_budget_one",
    externalSessionGeneration: 1,
    workspace,
  }, "browser_open", { alias: "riff-app" });
  await authority.execute({
    conversationId: scope.conversationId,
    turnId: "turn_budget_one",
    externalSessionGeneration: 1,
    tool: "browser_open",
    arguments: { alias: "riff-app" },
  });
  assert.equal((await broker.state(scope)).controlMode, "observer");

  await authority.prepareDormant({
    scope,
    turnId: "turn_expired",
    workspace,
    operations: new Set(["browser_open"] as const),
    ttlMs: 100,
  });
  now += 101;
  await assert.rejects(
    allow(authority, {
      conversationId: scope.conversationId,
      turnId: "turn_expired",
      externalSessionGeneration: 1,
      workspace,
    }, "browser_open", { alias: "riff-app" }),
    (error: unknown) => authorityError(error, "browser_grant_expired"),
  );
});

test("replacement waits for the prior Agent-control release before publishing a new grant", async () => {
  let releaseStarted!: () => void;
  let finishRelease!: () => void;
  const started = new Promise<void>((resolve) => { releaseStarted = resolve; });
  const release = new Promise<void>((resolve) => { finishRelease = resolve; });
  const fakeBroker = {
    async releaseAgent() { releaseStarted(); await release; },
  };
  const authority = new BrowserAgentAuthority(fakeBroker as any);
  const workspace = {
    owner: { kind: "model" as const, id: "model_replace" },
    directory: "/private/server-owned/model_replace",
  };
  const scope = { conversationId: "conversation_replace", conversationGeneration: 1 };
  await authority.prepareDormant({
    scope,
    turnId: "turn_replace",
    workspace,
    operations: new Set(["browser_open"] as const),
  });
  const replacement = authority.prepareDormant({
    scope,
    turnId: "turn_replace",
    workspace,
    operations: new Set(["browser_open"] as const),
  });
  await started;
  let completed = false;
  void replacement.then(() => { completed = true; });
  await Promise.resolve();
  assert.equal(completed, false);
  finishRelease();
  await replacement;
});

test("one Conversation cannot prepare two turn controllers while other Conversations remain independent", async () => {
  const fakeBroker = { async releaseAgent() {} };
  const authority = new BrowserAgentAuthority(fakeBroker as any);
  const workspace = {
    owner: { kind: "model" as const, id: "model_conflict" },
    directory: "/private/server-owned/model_conflict",
  };
  const firstScope = { conversationId: "conversation_conflict", conversationGeneration: 1 };
  await authority.prepareDormant({
    scope: firstScope,
    turnId: "turn_one",
    workspace,
    operations: new Set(["browser_open"] as const),
  });
  await assert.rejects(
    authority.prepareDormant({
      scope: firstScope,
      turnId: "turn_two",
      workspace,
      operations: new Set(["browser_open"] as const),
    }),
    (error: unknown) => authorityError(error, "browser_control_conflict"),
  );
  await authority.prepareDormant({
    scope: { conversationId: "conversation_independent", conversationGeneration: 1 },
    turnId: "turn_parallel",
    workspace,
    operations: new Set(["browser_open"] as const),
  });
  await authority.revokeTurn(firstScope.conversationId, "turn_one");
  await authority.prepareDormant({
    scope: firstScope,
    turnId: "turn_two",
    workspace,
    operations: new Set(["browser_open"] as const),
  });
});

test("Chromium disconnect permanently denies the old grant and control epoch", async () => {
  const origin = await fixture();
  const broker = new LocalBrowserBroker({
    pageGenerationSeed: 1_100,
    resolveTarget: (alias) => registerLocalBrowserTarget({
      alias,
      url: `${origin}/control`,
      projectedUrl: `${alias}://controlled`,
    }),
  });
  brokers.push(broker);
  const authority = new BrowserAgentAuthority(broker);
  const workspace = {
    owner: { kind: "project" as const, id: "project_disconnect" },
    directory: "/private/server-owned/project_disconnect",
  };
  const scope = { conversationId: "conversation_disconnect", conversationGeneration: 1 };
  const common = {
    conversationId: scope.conversationId,
    turnId: "turn_disconnect",
    externalSessionGeneration: 1,
  };
  await authority.prepareDormant({
    scope,
    turnId: common.turnId,
    workspace,
    operations: new Set(["browser_open", "browser_snapshot"] as const),
  });
  await allow(authority, { ...common, workspace }, "browser_open", { alias: "riff-app" });
  await authority.execute({ ...common, tool: "browser_open", arguments: { alias: "riff-app" } });
  await broker.disconnect();
  await allow(authority, { ...common, workspace }, "browser_snapshot", {});
  await assert.rejects(
    authority.execute({ ...common, tool: "browser_snapshot", arguments: {} }),
    (error: unknown) => authorityError(error, "browser_session_disconnected"),
  );
  const disconnected = await broker.state(scope);
  await broker.reconnect(scope, disconnected.pageGeneration);
  await assert.rejects(
    allow(authority, { ...common, workspace }, "browser_snapshot", {}),
    (error: unknown) => authorityError(error, "browser_grant_unavailable"),
  );
  await assert.rejects(
    authority.execute({ ...common, tool: "browser_snapshot", arguments: {} }),
    (error: unknown) => authorityError(error, "browser_grant_unavailable"),
  );
});

const allow = async (
  authority: BrowserAgentAuthority,
  scope: Readonly<{
    conversationId: string;
    turnId: string;
    externalSessionGeneration: number;
    workspace: { owner: { kind: "model" | "project"; id: string }; directory: string };
  }>,
  tool: Parameters<typeof browserAgentOperationCommitment>[0],
  input: Readonly<Record<string, unknown>>,
): Promise<void> => authority.activatePermission({
  ...scope,
  tool,
  operationCommitment: browserAgentOperationCommitment(tool, input).digest,
});

const waitFor = async (predicate: () => Promise<boolean>): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("timed out waiting for Browser pending permission");
};

const fixture = async (): Promise<string> => {
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'",
    });
    response.end(`<!doctype html><title>Control</title>
      <input aria-label="Message" oninput="document.querySelector('#echo').setAttribute('aria-label', 'Changed')">
      <button id="echo" type="button" aria-label="Empty">Empty</button>
      <button type="button" aria-label="Increment" onclick="document.querySelector('output').textContent = String(Number(document.querySelector('output').textContent) + 1)">Increment</button>
      <output>0</output><div style="height: 3000px"></div>`);
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "::1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://localhost:${address.port}`;
};

const authorityError = (error: unknown, code: string): boolean =>
  error instanceof BrowserAgentAuthorityError && error.code === code;

const brokerError = (error: unknown, code: string): boolean =>
  error instanceof LocalBrowserBrokerError && error.code === code;
