import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentConversationSessionManager, type AgentSessionRepositoryPort, type DurableConversationRuntime } from "../src/agent-session-manager.ts";
import type { AgentContextInput } from "../src/agent-context.ts";
import { ApiError } from "../src/errors.ts";
import {
  HttpOpenCodeAdapter,
  consequentialPermissionSummary,
  redactPublicRuntimeText,
  type OpenCodeConfig,
  type OpenCodeConversationPort,
  type OpenCodePrompt,
  type OpenCodeProviderModel,
  type OpenCodeWorkspaceBinding,
} from "../src/opencode-adapter.ts";

test("consequential permission summaries identify exact public targets without format controls", () => {
  const updateA = consequentialPermissionSummary(
    "riff_update_experiment_configuration",
    { configurationId: "experiment_alpha", name: "Alpha", configuration: {
      schemaVersion: 1, runKind: "batch",
      parameters: { horizon: 2, enabled: true, label: "private value", nested: { x: 1 } },
      sampling: { kind: "single" },
    } },
  );
  const updateB = consequentialPermissionSummary(
    "riff_update_experiment_configuration",
    { configurationId: "experiment_beta", name: "Alpha", configuration: {
      schemaVersion: 1, runKind: "batch",
      parameters: { horizon: 2 }, sampling: { kind: "single" },
    } },
  );
  assert.match(updateA, /experiment_alpha/u);
  assert.match(updateB, /experiment_beta/u);
  assert.notEqual(updateA, updateB, "two Experiment targets must not share a generic prompt");
  assert.match(updateA, /enabled=true/u);
  assert.match(updateA, /horizon=2/u);
  assert.match(updateA, /label=string\(13\)/u);
  assert.match(updateA, /nested=object/u);
  assert.doesNotMatch(updateA, /private value/u);
  assert.match(consequentialPermissionSummary(
    "riff_create_experiment_configuration",
    { name: "Incomplete" },
  ), /Cannot approve: Experiment configuration details are incomplete/u);
  assert.match(consequentialPermissionSummary(
    "riff_transition_temporary_document",
    { documentId: "document_public_a", transition: "reject" },
  ), /document_public_a/u);
  assert.match(consequentialPermissionSummary(
    "riff_adopt_attachment",
    { attachmentId: "attachment_public_b", logicalName: "inputs/data.csv" },
  ), /attachment_public_b.*inputs\/data\.csv/u);
  const deceptive = consequentialPermissionSummary(
    "riff_transition_owner_lifecycle",
    { action: "rename", name: "safe\u202eevil\u200b" },
  );
  assert.doesNotMatch(deceptive, /[\u202e\u200b]/u);
});

const context = (conversationId = "conversation-a"): AgentContextInput => ({
  conversationId,
  owner: { kind: "model", id: "model-a" },
  ownerSummary: { owner: { kind: "model", id: "model-a" }, text: "Generic model", workspaceDigest: "b".repeat(64) },
  messages: [{ id: "message-a", conversationId, ordinal: 0, role: "user", status: "complete", text: "Inspect the model" }],
  sensitiveValues: ["external-one", "external-two"],
});

const testWorkspaceForOwner = (
  owner: DurableConversationRuntime["owner"],
): OpenCodeWorkspaceBinding => ({ owner, directory: tmpdir() });

class MemoryRepository implements AgentSessionRepositoryPort {
  runtime: DurableConversationRuntime = {
    conversationId: "conversation-a",
    owner: { kind: "model", id: "model-a" },
    providerId: "provider-z",
    providerModelId: "model-2",
    session: null,
  };
  lost: any[] = [];
  failed: any[] = [];
  activated: any[] = [];

  async getConversationRuntime(conversationId: string) { return conversationId === this.runtime.conversationId ? structuredClone(this.runtime) : null; }
  async markSessionLost(value: any) { this.lost.push(value); this.runtime.session = { generation: value.generation, state: "lost", externalSessionRef: null }; }
  async beginSessionGeneration(value: any) {
    const generation = (value.expectedGeneration ?? 0) + 1;
    this.runtime.session = { generation, state: "rebuilding", externalSessionRef: null };
    return { generation };
  }
  async activateSession(value: any) {
    this.activated.push(value);
    this.runtime.session = { generation: value.generation, state: "available", externalSessionRef: value.externalSessionRef };
  }
  async failSessionGeneration(value: any) { this.failed.push(value); this.runtime.session = { generation: value.generation, state: "lost", externalSessionRef: null }; }
}

class FakeConversationOpenCode implements OpenCodeConversationPort {
  catalogue: OpenCodeProviderModel[] = [{ providerId: "provider-z", modelId: "model-2", qualifiedId: "provider-z/model-2" }];
  existing = new Set<string>();
  created: string[] = [];
  injected: Array<{ sessionId: string; context: string }> = [];
  prompts: Array<{ sessionId: string; binding: { providerId: string; modelId: string }; prompt: OpenCodePrompt }> = [];
  aborted: string[] = [];
  workspaces: Array<OpenCodeWorkspaceBinding | undefined> = [];
  createDelay?: Promise<void>;
  failDiscovery?: Error;
  failCreate?: Error;
  failPrompt?: Error;

  async discoverProviderModels(workspace?: OpenCodeWorkspaceBinding) {
    this.workspaces.push(workspace);
    if (this.failDiscovery) throw this.failDiscovery;
    return this.catalogue;
  }
  async getSession(sessionId: string, workspace?: OpenCodeWorkspaceBinding) {
    this.workspaces.push(workspace);
    return this.existing.has(sessionId);
  }
  async createSession(conversationId: string, workspace?: OpenCodeWorkspaceBinding) {
    this.workspaces.push(workspace);
    if (this.createDelay) await this.createDelay;
    if (this.failCreate) throw this.failCreate;
    const id = `external-${this.created.length + 1}`;
    this.created.push(conversationId);
    this.existing.add(id);
    return id;
  }
  async injectContext(
    sessionId: string,
    value: string,
    _signal?: AbortSignal,
    workspace?: OpenCodeWorkspaceBinding,
  ) {
    this.workspaces.push(workspace);
    this.injected.push({ sessionId, context: value });
  }
  async promptWithModel(
    sessionId: string,
    binding: { providerId: string; modelId: string },
    prompt: OpenCodePrompt,
    _signal?: AbortSignal,
    workspace?: OpenCodeWorkspaceBinding,
  ) {
    this.workspaces.push(workspace);
    this.prompts.push({ sessionId, binding, prompt });
    if (this.failPrompt) throw this.failPrompt;
  }
  async abort(sessionId: string, workspace?: OpenCodeWorkspaceBinding) {
    this.workspaces.push(workspace);
    this.aborted.push(sessionId);
  }
}

const readyAdapter = async (
  t: any,
  config: OpenCodeConfig,
  sessionStatus?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): Promise<HttpOpenCodeAdapter> => {
  const workdir = await mkdtemp(join(tmpdir(), "riff-opencode-ready-adapter-"));
  t.after(() => rm(workdir, { recursive: true, force: true }));
  const behavior = config.fetch ?? fetch;
  const model = config.model ?? "provider-z/model-2";
  const adapter = new HttpOpenCodeAdapter({
    ...config,
    baseUrl: config.baseUrl ?? "http://127.0.0.1:4096",
    model,
    workdir,
    expectedVersion: "test",
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/global/health") return Response.json({ healthy: true, version: "test" });
      if (path === "/path") return Response.json({ directory: workdir });
      if (path === "/config/providers") {
        const slash = model.indexOf("/");
        const providerId = model.slice(0, slash);
        const modelId = model.slice(slash + 1);
        return Response.json({ providers: [{ id: providerId, models: { [modelId]: {} } }] });
      }
      if (path === "/session/opaque-session" && init?.method === "PATCH") {
        (config as any).onSessionPermissionUpdate?.(
          JSON.parse(String(init.body)),
        );
        return Response.json({ id: "opaque-session", directory: workdir });
      }
      if (path === "/session/opaque-session") {
        return Response.json({ id: "opaque-session", directory: workdir });
      }
      if (path === "/session/status") return sessionStatus ? sessionStatus(input, init) : Response.json({});
      return behavior(input, init);
    },
  });
  assert.equal((await adapter.initialize()).status, "ready");
  return adapter;
};

const remainsPending = async (operation: Promise<unknown>, milliseconds = 25): Promise<boolean> =>
  Promise.race([
    operation.then(() => false, () => false),
    new Promise<true>((resolve) => setTimeout(() => resolve(true), milliseconds)),
  ]);

const waitUntil = async (predicate: () => boolean, label: string, timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const writeSse = (
  controller: ReadableStreamDefaultController<Uint8Array>,
  event: Record<string, unknown>,
): void => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));

test("adapter accepts only credential-free loopback HTTP base URLs", () => {
  assert.doesNotThrow(() => new HttpOpenCodeAdapter({ baseUrl: "http://127.0.0.1:4096" }));
  assert.doesNotThrow(() => new HttpOpenCodeAdapter({ baseUrl: "http://localhost:4096" }));
  assert.doesNotThrow(() => new HttpOpenCodeAdapter({ baseUrl: "http://[::1]:4096" }));
  for (const unsafe of [
    "https://127.0.0.1:4096", "http://example.com", "http://user:secret@127.0.0.1:4096",
    "http://127.0.0.1:4096/path", "http://127.0.0.1:4096?target=remote",
  ]) assert.throws(() => new HttpOpenCodeAdapter({ baseUrl: unsafe }), /loopback HTTP URL|unauthenticated|path/u);
});

test("public runtime text redacts punctuated local paths without hiding provider IDs or web URLs", () => {
  const redacted = redactPublicRuntimeText([
    "[/tmp/secret]",
    "x,/var/private",
    "path=[/Users/alice/private]",
    "note;file:///tmp/private",
    "foo{relative/private.txt}",
    "<./workspace/a>",
    "provider/model-b",
    "https://example.com/docs/runtime",
    "http://127.0.0.1:8787/a2/mcp?cap=opaque-capability",
    "\\\\server\\share\\private.txt",
    "exact-session-ref",
  ].join(" "));
  const exactRedacted = redactPublicRuntimeText(redacted, ["exact-session-ref"]);
  assert.doesNotMatch(
    exactRedacted,
    /\/tmp\/|\/var\/|\/Users\/|file:\/\/|relative\/|\.\/workspace|127\.0\.0\.1|opaque-capability|server\\share|exact-session-ref/u,
  );
  assert.match(exactRedacted, /provider\/model-b/u);
  assert.match(exactRedacted, /https:\/\/example\.com\/docs\/runtime/u);
});

test("ready adapter refuses redirects and never follows a cross-host location", async (t) => {
  const workdir = await mkdtemp(join(tmpdir(), "riff-opencode-redirect-"));
  t.after(() => rm(workdir, { recursive: true, force: true }));
  const calls: Array<{ url: string; redirect?: RequestRedirect }> = [];
  let providerRequests = 0;
  const adapter = new HttpOpenCodeAdapter({
    baseUrl: "http://127.0.0.1:4096",
    model: "provider-z/model-2",
    workdir,
    expectedVersion: "test",
    fetch: async (input, init) => {
      calls.push({ url: String(input), redirect: init?.redirect });
      const path = new URL(String(input)).pathname;
      if (path === "/global/health") return Response.json({ healthy: true, version: "test" });
      if (path === "/path") return Response.json({ directory: workdir });
      if (path === "/config/providers" && providerRequests++ === 0) {
        return Response.json({ providers: [{ id: "provider-z", models: { "model-2": {} } }] });
      }
      return new Response(null, { status: 302, headers: { location: "http://attacker.example/steal" } });
    },
  });
  assert.equal((await adapter.initialize()).status, "ready");
  await assert.rejects(() => adapter.discoverProviderModels(), (error: any) => error.code === "opencode_redirect_forbidden");
  assert.deepEqual(calls.map((call) => new URL(call.url).pathname), [
    "/global/health", "/path", "/config/providers",
    "/global/health", "/path", "/config/providers",
  ]);
  assert.equal(calls.every((call) => call.redirect === "manual"), true);
  assert.equal(calls.every((call) => /^http:\/\/127\.0\.0\.1:4096\//u.test(call.url)), true);
});

test("provider discovery is stable, deduplicated, allowlisted, and has no first-model fallback", async (t) => {
  const workdir = await mkdtemp(join(tmpdir(), "riff-opencode-provider-discovery-"));
  t.after(() => rm(workdir, { recursive: true, force: true }));
  const calls: string[] = [];
  const adapter = new HttpOpenCodeAdapter({
    baseUrl: "http://127.0.0.1:4096",
    model: "provider-z/model-2",
    workdir,
    expectedVersion: "test",
    allowedProviders: ["provider-z", "provider-a"],
    fetch: async (input) => {
      const path = new URL(String(input)).pathname;
      calls.push(path);
      if (path === "/global/health") return Response.json({ healthy: true, version: "test" });
      if (path === "/path") return Response.json({ directory: workdir });
      return Response.json({ providers: [
        { id: "provider-z", models: { "model-2": {}, "model-1": {} } },
        { id: "provider-a", models: ["model-x", "model-x"] },
        { id: "provider-disallowed", models: { model: {} } },
      ] });
    },
  });
  const readiness = await adapter.initialize();
  assert.equal(readiness.status, "ready");
  assert.deepEqual(await adapter.discoverProviderModels(), [
    { providerId: "provider-a", modelId: "model-x", qualifiedId: "provider-a/model-x" },
    { providerId: "provider-z", modelId: "model-1", qualifiedId: "provider-z/model-1" },
    { providerId: "provider-z", modelId: "model-2", qualifiedId: "provider-z/model-2" },
  ]);
  assert.equal(calls.filter((path) => path === "/config/providers").length, 2);

  let noFallbackRequests = 0;
  const missingModel = new HttpOpenCodeAdapter({
    baseUrl: "http://127.0.0.1:4096",
    workdir,
    expectedVersion: "test",
    fetch: async () => { noFallbackRequests += 1; throw new Error("missing model must not contact OpenCode"); },
  });
  const missingModelReadiness = await missingModel.initialize();
  assert.equal(missingModelReadiness.status, "error");
  assert.equal(missingModelReadiness.lastError?.code, "opencode_model_unconfigured");
  assert.equal(noFallbackRequests, 0, "initialize must not discover or select a fallback without explicit model");
});

test("opencode-go DeepSeek V4 models require catalogue discovery and preserve qualified IDs", async (t) => {
  const workdir = await mkdtemp(join(tmpdir(), "riff-opencode-go-provider-discovery-"));
  t.after(() => rm(workdir, { recursive: true, force: true }));
  const catalogue = [
    { id: "opencode-go", models: {
      "deepseek-v4-flash": {},
      "deepseek-v4-pro": {},
    } },
    { id: "other-provider", models: { "deepseek-v4-pro": {} } },
  ];
  const makeAdapter = (model: string, allowedProviders: string[] = ["opencode-go"]) => new HttpOpenCodeAdapter({
    baseUrl: "http://127.0.0.1:4096",
    model,
    workdir,
    expectedVersion: "test",
    allowedProviders,
    fetch: async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/global/health") return Response.json({ healthy: true, version: "test" });
      if (path === "/path") return Response.json({ directory: workdir });
      if (path === "/config/providers") return Response.json({ providers: catalogue });
      return new Response(null, { status: 404 });
    },
  });
  const expected = [
    { providerId: "opencode-go", modelId: "deepseek-v4-flash", qualifiedId: "opencode-go/deepseek-v4-flash" },
    { providerId: "opencode-go", modelId: "deepseek-v4-pro", qualifiedId: "opencode-go/deepseek-v4-pro" },
  ];

  for (const model of expected.map((item) => item.qualifiedId)) {
    const adapter = makeAdapter(model);
    assert.deepEqual(await adapter.initialize(), { status: "ready", modelId: model, version: "test" });
    assert.deepEqual(await adapter.discoverProviderModels(), expected);
  }

  const disallowed = makeAdapter("other-provider/deepseek-v4-pro");
  const disallowedReadiness = await disallowed.initialize();
  assert.equal(disallowedReadiness.status, "error");
  assert.equal(disallowedReadiness.lastError?.code, "opencode_provider_not_allowed");

  const missing = makeAdapter("opencode-go/deepseek-v4-missing");
  const missingReadiness = await missing.initialize();
  assert.equal(missingReadiness.status, "error");
  assert.equal(missingReadiness.lastError?.code, "opencode_model_unavailable");
});

test("adapter sends every A2 prompt with its explicit provider/model and disabled built-ins", async (t) => {
  const bodies: any[] = [];
  const sessionPermissionBodies: any[] = [];
  let prompted = false;
  const adapter = await readyAdapter(t, {
    allowedProviders: ["provider-z"],
    onSessionPermissionUpdate: (body: any) => sessionPermissionBodies.push(body),
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/prompt_async")) {
        const body = JSON.parse(String(init?.body));
        bodies.push(body);
        prompted = true;
        return new Response(null, { status: 204 });
      }
      return Response.json(prompted ? [
        { info: { id: "server-user", role: "user" }, parts: [{ type: "text", text: "hello" }] },
        { info: { id: "ok", role: "assistant", parentID: "server-user", time: { completed: 1 } }, parts: [{ type: "text", text: "assistant answer" }] },
      ] : []);
    },
  });
  await adapter.promptWithModel("opaque-session", { providerId: "provider-z", modelId: "model-2" }, { text: "hello", system: "bounded", attachments: [] });
  assert.deepEqual(bodies[0].model, { providerID: "provider-z", modelID: "model-2" });
  assert.equal("messageID" in bodies[0], false);
  assert.equal(Object.values(bodies[0].tools).every((enabled) => enabled === false), true,
    "an unscoped direct prompt must explicitly disable every built-in tool");
  assert.deepEqual(sessionPermissionBodies, [
    { permission: [
      { permission: "*", pattern: "*", action: "deny" },
    ] },
    { permission: [] },
  ]);
});

test("runtime snapshot stays on the current turn boundary and exposes only redacted typed controls", async (t) => {
  let prompted = false;
  let currentVisible = false;
  let terminal = false;
  let currentMessagePolls = 0;
  let mcpName = "";
  const scopeId = "runtime-snapshot-scope";
  let mutatePermissionDuringResponse = false;
  let permissionReadsAfterMutationTrigger = 0;
  const replies: Array<{ path: string; body: any }> = [];
  const old = [
    { info: { id: "old-user", sessionID: "opaque-session", role: "user" }, parts: [] },
    {
      info: {
        id: "old-assistant", sessionID: "opaque-session", role: "assistant",
        parentID: "old-user", error: { name: "ProviderAuthError" },
      },
      parts: [{ type: "tool", callID: "old-tool", tool: "old", state: { status: "running" } }],
    },
  ];
  const current = () => [
    { info: { id: "new-user", sessionID: "opaque-session", role: "user" }, parts: [] },
    {
      info: {
        id: "new-assistant", sessionID: "opaque-session", role: "assistant",
        parentID: "new-user", time: terminal ? { completed: 2 } : {},
      },
      parts: [
        {
          type: "text",
          text: [
            "token=api-secret-value",
            "runtime-secret-capability",
            "opaque-session new-user new-assistant new-tool q1",
            "[/Users/alice/private/model.py] x,/tmp/private.json",
            "note;file:///var/private.json <./workspace/model.py>",
            "foo{relative/private.txt} provider/model-b",
          ].join(" "),
        },
        {
          type: "tool", callID: "new-tool", tool: `${mcpName}_riff_apply_model_changes`,
          state: {
            status: terminal ? "completed" : "running",
            title: "raw input={path:/var/private.txt} output=relative/result.json",
            input: {
              requestKey: "apply-current-model-change",
              changes: [{
                operation: "replace",
                relativePath: "code/\u202emodel\u200b.py",
                content: "token=api-secret-value",
              }],
            },
          },
        },
        {
          type: "tool", callID: "q1", tool: "question",
          state: { status: terminal ? "completed" : "running" },
        },
      ],
    },
  ];
  const adapter = await readyAdapter(t, {
    allowedProviders: ["provider-z"],
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/prompt_async")) {
        prompted = true;
        return new Response(null, { status: 204 });
      }
      if (path.endsWith("/message")) {
        if (currentVisible) currentMessagePolls += 1;
        return Response.json([...old, ...(currentVisible ? current() : [])]);
      }
      if (path === "/permission") {
        if (mutatePermissionDuringResponse) permissionReadsAfterMutationTrigger += 1;
        return Response.json([
          { id: "per-old", sessionID: "opaque-session", permission: "old", tool: { messageID: "old-assistant", callID: "old-tool" } },
          {
            id: "per-new",
            sessionID: "opaque-session",
            permission: "edit",
            patterns: mutatePermissionDuringResponse
              && permissionReadsAfterMutationTrigger >= 2
              ? Array.from({ length: 257 }, (_, index) => `scope-${index}`)
              : ["current-turn-only"],
            always: [],
            tool: { messageID: "new-assistant", callID: "new-tool" },
          },
        ]);
      }
      if (path === "/question") return Response.json([
        {
          id: "que-new", sessionID: "opaque-session", tool: { messageID: "new-assistant", callID: "q1" },
          questions: [{
            header: "Choose [/tmp/private]", question: "Use token=api-secret-value or note;file:///var/private?",
            options: [
              { label: "/tmp/private-choice", description: "Use foo{relative/private.txt}" },
              { label: "/var/private-choice", description: "Use workspace/private.txt" },
            ],
            custom: false,
          }],
        },
      ]);
      if (path.startsWith("/permission/") || path.startsWith("/question/")) {
        replies.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null });
        return Response.json({ ok: true });
      }
      if (path === "/mcp" && init?.method === "POST") {
        mcpName = JSON.parse(String(init.body)).name;
        return Response.json({});
      }
      if (path === "/mcp") {
        return Response.json({ [mcpName]: { status: "connected" } });
      }
      if (path.startsWith("/mcp/")) return Response.json({});
      if (path === "/agent") return Response.json([
        {
          name: "build",
          description: "Build [/Users/alice/private] and foo{workspace/private.txt} with provider/model-b",
          mode: "primary",
          native: true,
        },
        { name: "hidden", mode: "primary", hidden: true },
        { name: "explore", mode: "subagent" },
      ]);
      throw new Error(`unexpected OpenCode endpoint ${path}`);
    },
  }, async () => Response.json(prompted ? { "opaque-session": { type: terminal ? "idle" : "busy" } } : {}));

  const agents = await adapter.discoverAgents();
  assert.deepEqual(agents.map((agent) => [agent.name, agent.mode, agent.native]), [
    ["build", "primary", true],
  ]);
  assert.doesNotMatch(
    agents[0].description ?? "",
    /\/Users\/|\/tmp\/|\/var\/|file:\/\/|workspace\/|relative\//u,
  );
  assert.match(agents[0].description ?? "", /provider\/model-b/u);
  const exactRuntimeTools = ["riff_apply_model_changes"] as const;
  await adapter.bindScopedMcp(
    scopeId,
    "http://127.0.0.1:8787/a2/mcp?cap=runtime-secret-capability",
    exactRuntimeTools,
  );
  const operation = adapter.promptWithModel(
    "opaque-session",
    { providerId: "provider-z", modelId: "model-2" },
    {
      text: "current",
      system: "bounded",
      attachments: [],
      agentName: "build",
      scopedMcpScopeId: scopeId,
      scopedMcpTools: exactRuntimeTools,
    },
  );
  await waitUntil(() => prompted, "prompt dispatch");
  const beforeUser = await adapter.runtimeSnapshot("opaque-session", scopeId);
  assert.equal(beforeUser.assistant, null);
  assert.deepEqual(beforeUser.tools, []);
  assert.deepEqual(beforeUser.interactions, []);
  assert.equal(beforeUser.failureCode, null);

  currentVisible = true;
  await waitUntil(() => currentMessagePolls > 0, "current user boundary");
  const active = await adapter.runtimeSnapshot("opaque-session", scopeId);
  assert.equal(active.assistant?.status, "streaming");
  assert.doesNotMatch(
    active.assistant?.text ?? "",
    /api-secret-value|runtime-secret-capability|opaque-session|new-user|new-assistant|new-tool|q1|\/Users\/|\/tmp\/|\/var\/|file:\/\/|(?:^|\s)(?:\.{1,2}\/|relative\/|workspace\/)/u,
  );
  assert.deepEqual(active.tools.map((tool) => [tool.tool, tool.status]), [
    ["Riff apply model changes", "running"],
    ["Question", "running"],
  ]);
  assert.equal(active.tools[0].title, null);
  assert.deepEqual(active.interactions.map((interaction) => interaction.kind), ["permission", "question"]);
  assert.doesNotMatch(
    JSON.stringify(active.interactions),
    /api-secret-value|\/Users\/|\/home\/|\/tmp\/|\/var\/|file:\/\/|relative\//u,
  );
  const permission = active.interactions.find((interaction) => interaction.kind === "permission")!;
  assert.match(
    permission.permission,
    /^Allow Riff apply model changes once for the current turn\? Apply 1 Model file operation/u,
  );
  assert.doesNotMatch(permission.permission, /api-secret-value|[0-9a-f]{32,}/u);
  assert.doesNotMatch(permission.permission, /[\u202e\u200b]/u);
  const permissionAuthority = await adapter.resolvePermissionAuthority(
    "opaque-session", permission.id,
  );
  assert.equal(permissionAuthority?.toolName, "riff_apply_model_changes");
  assert.match(permissionAuthority?.operationCommitment ?? "", /^[0-9a-f]{64}$/u);
  mutatePermissionDuringResponse = true;
  await assert.rejects(
    () => adapter.respondPermission(
      "opaque-session", permission.id, "once", undefined,
      permissionAuthority!,
    ),
    (error: any) => error.code === "interaction_not_pending",
  );
  assert.deepEqual(replies, [], "a mutated permission grant must fail before the control POST");
  mutatePermissionDuringResponse = false;
  permissionReadsAfterMutationTrigger = 0;
  const refreshedAuthority = await adapter.resolvePermissionAuthority(
    "opaque-session", permission.id,
  );
  await adapter.respondPermission(
    "opaque-session", permission.id, "once", undefined,
    refreshedAuthority!,
  );
  const question = active.interactions.find((interaction) => interaction.kind === "question")!;
  await assert.rejects(
    () => adapter.respondQuestion("opaque-session", question.id, { answers: [["Other"]] }),
    (error: any) => error.code === "invalid_interaction_response",
  );
  const publicChoices = question.questions[0].options;
  assert.equal(publicChoices[0].label, publicChoices[1].label,
    "distinct upstream labels may collapse to the same redacted public label");
  assert.notEqual(publicChoices[0].id, publicChoices[1].id,
    "opaque choice IDs must preserve exact option identity");
  await adapter.respondQuestion(
    "opaque-session",
    question.id,
    { answers: [[publicChoices[1].id]] },
  );
  assert.deepEqual(replies.map((reply) => [reply.path, reply.body]), [
    ["/permission/per-new/reply", { reply: "once" }],
    ["/question/que-new/reply", { answers: [["/var/private-choice"]] }],
  ]);
  terminal = true;
  assert.equal((await operation).text.includes("token=api-secret-value"), true,
    "durable assistant aggregation remains authoritative; public runtime alone is redacted");
  await adapter.unbindScopedMcp(scopeId);
  adapter.releaseRuntimeBoundary("opaque-session");
});

test("browser permission rejects final assistant evidence changed immediately before reply", async (t) => {
  let prompted = false;
  let terminal = false;
  let mcpName = "";
  let ref = `element_${"a".repeat(32)}`;
  let replies = 0;
  let raceFinalEvidence = false;
  let permissionReadsAfterRace = 0;
  const adapter = await readyAdapter(t, {
    allowedProviders: ["provider-z"],
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/prompt_async")) {
        prompted = true;
        return new Response(null, { status: 204 });
      }
      if (path.endsWith("/message")) {
        const projectedRef = raceFinalEvidence && permissionReadsAfterRace >= 2
          ? `element_${"b".repeat(32)}` : ref;
        return Response.json(prompted ? [
        { info: { id: "browser-user", sessionID: "opaque-session", role: "user" }, parts: [] },
        { info: { id: "browser-assistant", sessionID: "opaque-session", role: "assistant", parentID: "browser-user", ...(terminal ? { time: { completed: 2 } } : {}) }, parts: [
          { type: "tool", callID: "browser-call", tool: `${mcpName}_browser_click`, state: { status: terminal ? "completed" : "running", input: { ref: projectedRef } } },
          ...(terminal ? [{ type: "text", text: "Browser action complete." }] : []),
        ] },
      ] : []);
      }
      if (path === "/permission") {
        if (raceFinalEvidence) permissionReadsAfterRace += 1;
        return Response.json([{
        id: "permission-browser",
        sessionID: "opaque-session",
        permission: "external",
        patterns: ["browser"],
        always: [],
        tool: { messageID: "browser-assistant", callID: "browser-call" },
      }]);
      }
      if (path.startsWith("/permission/")) {
        replies += 1;
        assert.deepEqual(JSON.parse(String(init?.body)), { reply: "once" });
        return Response.json({ ok: true });
      }
      if (path === "/question") return Response.json([]);
      if (path === "/mcp" && init?.method === "POST") {
        mcpName = JSON.parse(String(init.body)).name;
        return Response.json({});
      }
      if (path === "/mcp") return Response.json({ [mcpName]: { status: "connected" } });
      if (path.startsWith("/mcp/")) return Response.json({});
      throw new Error(`unexpected OpenCode endpoint ${path}`);
    },
  }, async () => Response.json(prompted
    ? { "opaque-session": { type: terminal ? "idle" : "busy" } }
    : {}));
  const scopeId = "browser-permission-scope";
  await adapter.bindScopedMcp(
    scopeId,
    "http://127.0.0.1:8787/a2/mcp?cap=browser-secret-capability",
    ["browser_click"],
  );
  const operation = adapter.promptWithModel(
    "opaque-session",
    { providerId: "provider-z", modelId: "model-2" },
    {
      text: "Click the button",
      system: "bounded",
      attachments: [],
      scopedMcpScopeId: scopeId,
      scopedMcpTools: ["browser_click"],
    },
  );
  await waitUntil(() => prompted, "browser prompt dispatch");
  const first = await adapter.runtimeSnapshot("opaque-session", scopeId);
  const permission = first.interactions.find((item) => item.kind === "permission")!;
  const serialized = JSON.stringify(permission);
  assert.doesNotMatch(serialized, /operationCommitment|scopedToolName|element_[0-9a-f]+|browser-secret/u);
  assert.match(
    permission.permission,
    /fixed active grant alias \(riff-app, riff-visual, or riff-artifact\).*browser_click.*budget 12.*120 seconds/iu,
  );
  const authority = await adapter.resolvePermissionAuthority(
    "opaque-session",
    permission.id,
  );
  assert.equal(authority?.toolName, "browser_click");
  assert.match(authority?.operationCommitment ?? "", /^[0-9a-f]{64}$/u);

  raceFinalEvidence = true;
  await assert.rejects(
    adapter.respondPermission(
      "opaque-session",
      permission.id,
      "once",
      undefined,
      authority!,
    ),
    (error: any) => error.code === "interaction_not_pending",
  );
  assert.equal(replies, 0);
  assert.ok(permissionReadsAfterRace >= 2,
    "the final rejection must follow a fresh permission read and assistant evidence read");
  terminal = true;
  await operation;
});

const assertBrowserPermissionEvidenceRejected = async (
  t: any,
  mode: "duplicate" | "legacy_part_input",
): Promise<void> => {
  let prompted = false;
  let terminal = false;
  let mcpName = "";
  const permissionUpdates: any[] = [];
  const ref = `element_${"c".repeat(32)}`;
  const toolPart = () => ({
    type: "tool",
    callID: "browser-call",
    tool: `${mcpName}_browser_click`,
    ...(mode === "legacy_part_input" ? { input: { ref } } : {}),
    state: {
      status: terminal ? "completed" : "running",
      ...(mode === "duplicate" ? { input: { ref } } : {}),
    },
  });
  const adapter = await readyAdapter(t, {
    allowedProviders: ["provider-z"],
    onSessionPermissionUpdate: (body: any) => permissionUpdates.push(body),
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/prompt_async")) {
        prompted = true;
        return new Response(null, { status: 204 });
      }
      if (path.endsWith("/message")) return Response.json(prompted ? [
        { info: { id: "browser-user", sessionID: "opaque-session", role: "user" }, parts: [] },
        {
          info: {
            id: "browser-assistant", sessionID: "opaque-session", role: "assistant",
            parentID: "browser-user", ...(terminal ? { time: { completed: 2 } } : {}),
          },
          parts: [
            toolPart(),
            ...(mode === "duplicate" ? [toolPart()] : []),
            ...(terminal ? [{ type: "text", text: "done" }] : []),
          ],
        },
      ] : []);
      if (path === "/permission") return Response.json([{
        id: "permission-browser",
        sessionID: "opaque-session",
        permission: "external",
        patterns: ["browser"],
        always: [],
        tool: { messageID: "browser-assistant", callID: "browser-call" },
      }]);
      if (path === "/question") return Response.json([]);
      if (path === "/mcp" && init?.method === "POST") {
        mcpName = JSON.parse(String(init.body)).name;
        return Response.json({});
      }
      if (path === "/mcp") return Response.json({ [mcpName]: { status: "connected" } });
      if (path.startsWith("/mcp/")) return Response.json({});
      throw new Error(`unexpected OpenCode endpoint ${path}`);
    },
  }, async () => Response.json(prompted
    ? { "opaque-session": { type: terminal ? "idle" : "busy" } }
    : {}));
  const scopeId = `browser-evidence-${mode}`;
  await adapter.bindScopedMcp(
    scopeId,
    "http://127.0.0.1:8787/a2/mcp?cap=browser-secret-capability",
    ["browser_click"],
  );
  const operation = adapter.promptWithModel(
    "opaque-session",
    { providerId: "provider-z", modelId: "model-2" },
    {
      text: "Click",
      system: "bounded",
      attachments: [],
      scopedMcpScopeId: scopeId,
      scopedMcpTools: ["browser_click"],
    },
  );
  await waitUntil(() => prompted, "browser evidence prompt dispatch");
  assert.deepEqual(permissionUpdates[0].permission.at(-1), {
    permission: `${mcpName}_browser_click`,
    pattern: "*",
    action: "allow",
  }, "Browser tools must enter the Riff-owned Browser permission gate");
  const snapshot = await adapter.runtimeSnapshot("opaque-session", scopeId);
  assert.deepEqual(snapshot.interactions.filter((item) => item.kind === "permission"), []);
  assert.equal(await adapter.resolvePermissionAuthority(
    "opaque-session",
    "permission_00000000000000000000000000000000",
  ), null);
  terminal = true;
  await operation.catch(() => undefined);
};

test("browser permission rejects duplicate assistant messageID and callID evidence", async (t) => {
  await assertBrowserPermissionEvidenceRejected(t, "duplicate");
});

test("browser permission rejects legacy part.input without state.input", async (t) => {
  await assertBrowserPermissionEvidenceRejected(t, "legacy_part_input");
});

test("adapter reuses one OpenCode session across turns with server-generated user message IDs", async (t) => {
  const messages: any[] = [];
  let promptNumber = 0;
  const adapter = await readyAdapter(t, {
    allowedProviders: ["provider-z"],
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/prompt_async")) {
        const body = JSON.parse(String(init?.body));
        assert.equal("messageID" in body, false);
        promptNumber += 1;
        const userId = `server-user-${promptNumber}`;
        messages.push(
          { info: { id: userId, role: "user" }, parts: body.parts },
          { info: { id: `assistant-${promptNumber}`, role: "assistant", parentID: userId, time: { completed: promptNumber } }, parts: [{ type: "text", text: `answer-${promptNumber}` }] },
        );
        return new Response(null, { status: 204 });
      }
      return Response.json(messages);
    },
  });

  const first = await adapter.promptWithModel("opaque-session", { providerId: "provider-z", modelId: "model-2" }, { text: "first", system: "bounded", attachments: [] });
  const second = await adapter.promptWithModel("opaque-session", { providerId: "provider-z", modelId: "model-2" }, { text: "second", system: "bounded", attachments: [] });
  assert.equal(first.text, "answer-1");
  assert.equal(second.text, "answer-2");
});

test("adapter binds one uniquely named scoped MCP and enables only that server for the prompt", async (t) => {
  const calls: Array<{ path: string; body: any }> = [];
  let prompted = false;
  let scopedName = "";
  const adapter = await readyAdapter(t, {
    allowedProviders: ["provider-z"],
    onSessionPermissionUpdate: (body: any) => calls.push({
      path: "/session/opaque-session", body,
    }),
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ path, body });
      if (path === "/mcp" && init?.method === "POST") {
        scopedName = body.name;
        return Response.json({});
      }
      if (path === "/mcp") {
        return Response.json(scopedName ? { [scopedName]: { status: "connected" } } : {});
      }
      if (path.includes("/mcp/")) return Response.json({});
      if (path.endsWith("/prompt_async")) { prompted = true; return new Response(null, { status: 204 }); }
      return Response.json(prompted ? [
        { info: { id: "server-user", role: "user" }, parts: [{ type: "text", text: "change" }] },
        { info: { id: "ok", role: "assistant", parentID: "server-user", time: { completed: 1 } }, parts: [{ type: "text", text: "scoped answer" }] },
      ] : []);
    },
  });
  const scopeId = "turn_scoped_binding";
  const exactTools = [
    "riff_apply_model_changes",
    "riff_list_model_workspace",
    "riff_read_owner_summary",
  ] as const;
  await adapter.bindScopedMcp(
    scopeId,
    "http://127.0.0.1:8787/a2/mcp?cap=opaque-capability",
    exactTools,
  );
  await adapter.promptWithModel("opaque-session", { providerId: "provider-z", modelId: "model-2" }, {
    text: "change",
    system: "bounded",
    attachments: [],
    scopedMcpScopeId: scopeId,
    scopedMcpTools: exactTools,
  });

  const registration = calls.find((call) => call.path === "/mcp" && call.body?.name)!;
  assert.match(registration.body.name, /^riffa2[0-9a-f]{24}$/u);
  assert.equal(registration.body.config.url, "http://127.0.0.1:8787/a2/mcp?cap=opaque-capability");
  const prompt = calls.find((call) => call.path.endsWith("/prompt_async"))!.body;
  assert.equal("tools" in prompt, false,
    "prompt-level true rules must not override exact session ask rules");
  const permissionUpdates = calls.filter((call) =>
    call.path === "/session/opaque-session" && call.body?.permission);
  assert.ok(permissionUpdates.length > 0, JSON.stringify(calls));
  assert.deepEqual(permissionUpdates[0].body.permission, [
    { permission: "*", pattern: "*", action: "deny" },
    { permission: "question", pattern: "*", action: "allow" },
    { permission: `${registration.body.name}_riff_apply_model_changes`, pattern: "*", action: "ask" },
    { permission: `${registration.body.name}_riff_list_model_workspace`, pattern: "*", action: "allow" },
    { permission: `${registration.body.name}_riff_read_owner_summary`, pattern: "*", action: "allow" },
  ]);
  assert.deepEqual(permissionUpdates.at(-1)?.body, { permission: [] });
  const mcpPostsBeforeDrift = calls.filter((call) => call.path === "/mcp" && call.body?.name).length;
  await assert.rejects(
    () => adapter.bindScopedMcp(
      scopeId,
      "http://127.0.0.1:8787/a2/mcp?cap=opaque-capability",
      ["riff_read_owner_summary"],
    ),
    (error: any) => error.code === "opencode_mcp_binding_changed",
  );
  assert.equal(calls.filter((call) => call.path === "/mcp" && call.body?.name).length, mcpPostsBeforeDrift);
  const promptsBeforeDrift = calls.filter((call) => call.path.endsWith("/prompt_async")).length;
  for (const invalidTools of [
    ["riff_read_owner_summary"],
    ["riff_read_owner_summary", "riff_read_owner_summary"],
    ["riff_read_owner_summary", "riff_list_model_workspace"],
    ["riff_read_owner_summary", "third_party_search"],
  ]) {
    await assert.rejects(
      () => adapter.promptWithModel(
        "opaque-session",
        { providerId: "provider-z", modelId: "model-2" },
        {
          text: "must not dispatch",
          system: "bounded",
          attachments: [],
          scopedMcpScopeId: scopeId,
          scopedMcpTools: invalidTools as any,
        },
      ),
      (error: any) => error.code === "opencode_mcp_tools_invalid",
    );
  }
  assert.equal(
    calls.filter((call) => call.path.endsWith("/prompt_async")).length,
    promptsBeforeDrift,
  );
  await adapter.unbindScopedMcp(scopeId);
  assert.ok(calls.some((call) => call.path === `/mcp/${registration.body.name}/disconnect`));
  await assert.rejects(() => adapter.promptWithModel("opaque-session", { providerId: "provider-z", modelId: "model-2" }, {
    text: "stale", system: "bounded", attachments: [], scopedMcpScopeId: scopeId,
  }), (error: any) => error.code === "opencode_mcp_unbound");
  await assert.rejects(() => adapter.bindScopedMcp("turn_external", "http://example.com/a2/mcp?cap=x"), /capability-scoped local/u);
});

test("scoped MCP binding waits for connected and reconciles a retained upstream name", async (t) => {
  const calls: Array<{ method: string; path: string; url?: string }> = [];
  let name = "";
  let url = "";
  let status: "missing" | "disabled" | "connected" = "missing";
  let statusReadsAfterConnect = 0;
  const behavior = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const method = init?.method ?? "GET";
    if (path === "/mcp" && method === "POST") {
      const body = JSON.parse(String(init?.body));
      name = body.name;
      url = body.config.url;
      status = "disabled";
      calls.push({ method, path, url });
      return Response.json({});
    }
    if (path === "/mcp") {
      if (statusReadsAfterConnect > 0) {
        statusReadsAfterConnect += 1;
        if (status === "disabled" && statusReadsAfterConnect >= 3) status = "connected";
      }
      calls.push({ method, path });
      return Response.json(name && status !== "missing" ? { [name]: { status } } : {});
    }
    if (path.endsWith("/connect")) {
      statusReadsAfterConnect = 1;
      calls.push({ method, path });
      return Response.json({});
    }
    if (path.endsWith("/disconnect")) {
      status = "disabled";
      calls.push({ method, path });
      return Response.json({});
    }
    return Response.json({});
  };
  const first = await readyAdapter(t, { fetch: behavior });
  const scope = "conversation_reconnect";
  const tools = ["riff_read_owner_summary"] as const;
  await first.bindScopedMcp(
    scope,
    "http://127.0.0.1:8787/a2/mcp?cap=first-capability",
    tools,
  );
  assert.equal(status, "connected");
  assert.ok(statusReadsAfterConnect >= 2);

  const second = await readyAdapter(t, { fetch: behavior });
  const boundary = calls.length;
  await second.bindScopedMcp(
    scope,
    "http://127.0.0.1:8787/a2/mcp?cap=second-capability",
    tools,
  );
  assert.equal(url, "http://127.0.0.1:8787/a2/mcp?cap=second-capability");
  assert.deepEqual(
    calls.slice(boundary).filter((call) => call.path.startsWith("/mcp")).map((call) =>
      call.path === "/mcp" && call.method === "POST" ? "register"
        : call.path.endsWith("/disconnect") ? "disconnect"
          : call.path.endsWith("/connect") ? "connect" : "status"),
    ["status", "disconnect", "register", "connect", "status", "status"],
  );
});

test("scoped MCP binding fails closed and cleans a rejected connection", async (t) => {
  let name = "";
  let disconnected = false;
  const adapter = await readyAdapter(t, {
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/mcp" && init?.method === "POST") {
        name = JSON.parse(String(init.body)).name;
        return Response.json({});
      }
      if (path === "/mcp") {
        return Response.json(name ? { [name]: { status: "failed" } } : {});
      }
      if (path.endsWith("/disconnect")) {
        disconnected = true;
        return Response.json({});
      }
      if (path.endsWith("/connect")) return Response.json({});
      return Response.json({});
    },
  });
  await assert.rejects(
    () => adapter.bindScopedMcp(
      "conversation_failed_connect",
      "http://127.0.0.1:8787/a2/mcp?cap=failed-capability",
      ["riff_read_owner_summary"],
    ),
    (error: any) => error.code === "opencode_mcp_unavailable",
  );
  assert.equal(disconnected, true);
  await assert.rejects(
    () => adapter.promptWithModel(
      "opaque-session",
      { providerId: "provider-z", modelId: "model-2" },
      {
        text: "must not dispatch",
        system: "bounded",
        attachments: [],
        scopedMcpScopeId: "conversation_failed_connect",
        scopedMcpTools: ["riff_read_owner_summary"],
      },
    ),
    (error: any) => error.code === "opencode_mcp_unbound",
  );
});

test("a scoped turn rejects a completed tool outside its exact grant", async (t) => {
  let prompted = false;
  let terminal = false;
  let scopedName = "";
  let messageReads = 0;
  const adapter = await readyAdapter(t, {
    allowedProviders: ["provider-z"],
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/mcp" && init?.method === "POST") {
        scopedName = JSON.parse(String(init.body)).name;
        return Response.json({});
      }
      if (path === "/mcp") {
        return Response.json(scopedName ? { [scopedName]: { status: "connected" } } : {});
      }
      if (path.includes("/mcp/")) return Response.json({});
      if (path.endsWith("/prompt_async")) {
        prompted = true;
        return new Response(null, { status: 204 });
      }
      if (path.endsWith("/message")) {
        messageReads += 1;
        if (!prompted) return Response.json([]);
        const user = {
          info: { id: "server-user", sessionID: "opaque-session", role: "user" },
          parts: [{ type: "text", text: "inspect" }],
        };
        if (messageReads === 2) return Response.json([user]);
        return Response.json([user, {
          info: {
            id: "assistant",
            sessionID: "opaque-session",
            role: "assistant",
            parentID: "server-user",
            time: { completed: 1 },
          },
          parts: [{
            type: "tool",
            callID: "forged-call",
            tool: `${scopedName}_riff_apply_model_changes`,
            state: { status: "completed" },
          }],
        },
        ]);
      }
      if (path === "/permission") return Response.json(prompted ? [{
        id: "forged-permission",
        sessionID: "opaque-session",
        permission: "edit",
        patterns: [],
        always: [],
        tool: { messageID: "assistant", callID: "forged-call" },
      }] : []);
      if (path === "/question") return Response.json([]);
      return Response.json({});
    },
  }, async () => Response.json(prompted
    ? { "opaque-session": { type: terminal ? "idle" : "busy" } }
    : {}));
  const scopeId = "turn_exact_tool_replay";
  const exactTools = ["riff_read_owner_summary"] as const;
  await adapter.bindScopedMcp(
    scopeId,
    "http://127.0.0.1:8787/a2/mcp?cap=opaque-capability",
    exactTools,
  );
  const operation = adapter.promptWithModel(
      "opaque-session",
      { providerId: "provider-z", modelId: "model-2" },
      {
        text: "inspect",
        system: "bounded",
        attachments: [],
        scopedMcpScopeId: scopeId,
        scopedMcpTools: exactTools,
      },
    );
  await waitUntil(() => messageReads >= 2, "forged scoped tool user boundary");
  const projection = await adapter.runtimeSnapshot("opaque-session", scopeId);
  assert.deepEqual(projection.tools, []);
  assert.deepEqual(projection.interactions, []);
  terminal = true;
  await assert.rejects(
    operation,
    (error: any) => error.code === "opencode_tool_not_allowed",
  );
});

test("adapter does not persist bounded reconstruction context as a synthetic user message", async () => {
  let requests = 0;
  const adapter = new HttpOpenCodeAdapter({
    baseUrl: "http://127.0.0.1:4096",
    fetch: async () => { requests += 1; return Response.json({}); },
  });
  await adapter.injectContext("opaque-session", "bounded context");
  assert.equal(requests, 0);
});

test("adapter ignores a stale assistant and waits for the response parented to this prompt", async (t) => {
  let prompted = false;
  let polls = 0;
  const adapter = await readyAdapter(t, {
    allowedProviders: ["provider-z"],
    fetch: async (input, init) => {
      if (new URL(String(input)).pathname.endsWith("/prompt_async")) {
        prompted = true;
        return new Response(null, { status: 204 });
      }
      polls += 1;
      const messages: any[] = [{ info: { id: "stale", role: "assistant", parentID: "older-user" }, parts: [{ type: "text", text: "old answer" }] }];
      if (prompted) messages.push({ info: { id: "server-user", role: "user" }, parts: [{ type: "text", text: "next" }] });
      if (polls > 2) messages.push({ info: { id: "fresh", role: "assistant", parentID: "server-user", time: { completed: 1 } }, parts: [{ type: "text", text: "new answer" }] });
      return Response.json(messages);
    },
  });
  const result = await adapter.promptWithModel("opaque-session", { providerId: "provider-z", modelId: "model-2" }, { text: "next", system: "bounded", attachments: [] });
  assert.equal(result.text, "new answer");
  assert.equal(polls, 3);
});

test("adapter waits past a tool-only assistant segment for the final text segment", async (t) => {
  let prompted = false;
  let polls = 0;
  const adapter = await readyAdapter(t, {
    allowedProviders: ["provider-z"],
    fetch: async (input, init) => {
      if (new URL(String(input)).pathname.endsWith("/prompt_async")) {
        prompted = true;
        return new Response(null, { status: 204 });
      }
      polls += 1;
      const messages: any[] = prompted ? [
        { info: { id: "server-user", role: "user" }, parts: [{ type: "text", text: "next" }] },
        { info: { id: "tool-segment", role: "assistant", parentID: "server-user", time: { completed: 1 } }, parts: [
          { type: "tool", tool: "riff_read_owner_summary", state: { status: "completed" } },
        ] },
      ] : [];
      if (polls > 2) messages.push({ info: { id: "final-segment", role: "assistant", parentID: "server-user", time: { completed: 2 } }, parts: [{ type: "text", text: "final answer" }] });
      return Response.json(messages);
    },
  }, async () => Response.json({ "opaque-session": { type: polls > 2 ? "idle" : "busy" } }));
  const result = await adapter.promptWithModel("opaque-session", { providerId: "provider-z", modelId: "model-2" }, { text: "next", system: "bounded", attachments: [] });
  assert.equal(result.text, "final answer");
  assert.equal(result.messageId, "final-segment");
  assert.ok(polls >= 3, "terminal replay may perform one final canonical message read");
});

test("first assistant text cannot complete while the target session is busy or retrying, and all tool phases aggregate after idle", async (t) => {
  let prompted = false;
  let terminal = false;
  let statusPolls = 0;
  let observeBusy!: () => void;
  const busyObserved = new Promise<void>((resolve) => { observeBusy = resolve; });
  const adapter = await readyAdapter(t, {
    allowedProviders: ["provider-z"],
    fetch: async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/prompt_async")) { prompted = true; return new Response(null, { status: 204 }); }
      if (path.endsWith("/message")) {
        if (!prompted) return Response.json([]);
        return Response.json([
          { info: { id: "server-user", role: "user" }, parts: [{ type: "text", text: "change it" }] },
          { info: { id: "assistant-phase-1", role: "assistant", parentID: "server-user", time: { completed: 1 } }, parts: [
            { type: "text", text: "I will inspect the workspace." },
            { type: "tool", callID: "tool-1", tool: "riff_list_model_workspace", state: { status: "completed" } },
          ] },
          ...(terminal ? [{ info: { id: "assistant-phase-2", role: "assistant", parentID: "server-user", time: { completed: 2 } }, parts: [
            { type: "tool", callID: "tool-2", tool: "riff_apply_model_changes", state: { status: "completed" } },
            { type: "text", text: "The model change is committed." },
          ] }] : []),
        ]);
      }
      throw new Error(`unexpected OpenCode endpoint ${path}`);
    },
  }, async () => {
    if (!prompted) return Response.json({});
    statusPolls += 1;
    if (!terminal) {
      observeBusy();
      return Response.json({ unrelated_session: { type: "idle" }, "opaque-session": { type: statusPolls % 2 ? "busy" : "retry" } });
    }
    return Response.json({ unrelated_session: { type: "busy" }, "opaque-session": { type: "idle" } });
  });

  const operation = adapter.promptWithModel(
    "opaque-session",
    { providerId: "provider-z", modelId: "model-2" },
    { text: "change it", system: "bounded", attachments: [] },
  );
  const firstOutcome = await Promise.race([operation.then(() => "settled", () => "settled"), busyObserved.then(() => "busy")]);
  assert.equal(firstOutcome, "busy", "the first assistant text must not settle the turn before target-session status is terminal");
  assert.equal(await remainsPending(operation), true);
  terminal = true;
  const result = await operation;
  assert.equal(result.text, "I will inspect the workspace.\nThe model change is committed.");
  assert.equal(result.content.textParts, 2);
  assert.deepEqual(result.content.parts, [
    { ordinal: 0, kind: "text", state: "complete" },
    { ordinal: 1, kind: "tool", state: "complete", toolName: "riff_list_model_workspace" },
    { ordinal: 2, kind: "tool", state: "complete", toolName: "riff_apply_model_changes" },
    { ordinal: 3, kind: "text", state: "complete" },
  ]);
  assert.equal(result.messageId, "assistant-phase-2");
  assert.ok(statusPolls >= 1);
});

test("retry with an errored attempt stays nonterminal and accepts the later successful attempt", async (t) => {
  let prompted = false;
  let allowSuccess = false;
  let observedRetry!: () => void;
  const retryObserved = new Promise<void>((resolve) => { observedRetry = resolve; });
  const adapter = await readyAdapter(t, {
    fetch: async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/prompt_async")) {
        prompted = true;
        return new Response(null, { status: 204 });
      }
      if (path.endsWith("/message")) return Response.json(prompted ? [
        { info: { id: "server-user", role: "user" }, parts: [{ type: "text", text: "retry" }] },
        {
          info: {
            id: "failed-attempt",
            role: "assistant",
            parentID: "server-user",
            error: { name: "ProviderError", data: { message: "private retry detail" } },
          },
          parts: [],
        },
        ...(allowSuccess ? [{
          info: {
            id: "successful-attempt",
            role: "assistant",
            parentID: "server-user",
            time: { completed: 2 },
          },
          parts: [{ type: "text", text: "retry succeeded" }],
        }] : []),
      ] : []);
      if (path === "/permission" || path === "/question") return Response.json([]);
      throw new Error(`unexpected OpenCode endpoint ${path}`);
    },
  }, async () => {
    if (!prompted) return Response.json({});
    if (!allowSuccess) {
      observedRetry();
      return Response.json({ "opaque-session": { type: "retry" } });
    }
    return Response.json({ "opaque-session": { type: "idle" } });
  });

  const operation = adapter.promptWithModel(
    "opaque-session",
    { providerId: "provider-z", modelId: "model-2" },
    { text: "retry", system: "bounded", attachments: [] },
  );
  await retryObserved;
  assert.equal(await remainsPending(operation), true);
  const duringRetry = await adapter.runtimeSnapshot("opaque-session", undefined);
  assert.equal(duringRetry.assistant, null,
    "a failed attempt must not reappear as current streaming assistant content");
  assert.equal(duringRetry.failureCode, null,
    "the retained failure boundary is not the post-retry attempt");
  allowSuccess = true;
  const result = await operation;
  assert.equal(result.text, "retry succeeded");
  assert.doesNotMatch(JSON.stringify(result.content), /private retry detail/u);
});

test("runtime projection and durable completion share one fail-closed retry boundary", async (t) => {
  let prompted = false;
  let dropFailure = false;
  let observedRetry!: () => void;
  const retryObserved = new Promise<void>((resolve) => { observedRetry = resolve; });
  const adapter = await readyAdapter(t, {
    requestTimeoutMs: 120,
    fetch: async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/prompt_async")) {
        prompted = true;
        return new Response(null, { status: 204 });
      }
      if (path.endsWith("/message")) return Response.json(prompted ? [
        { info: { id: "server-user", role: "user" }, parts: [{ type: "text", text: "retry" }] },
        ...(!dropFailure ? [{
          info: {
            id: "failed-attempt",
            role: "assistant",
            parentID: "server-user",
            error: { name: "ProviderError" },
          },
          parts: [],
        }] : [{
          info: {
            id: "success-without-boundary",
            role: "assistant",
            parentID: "server-user",
            time: { completed: 2 },
          },
          parts: [{ type: "text", text: "must not be accepted" }],
        }]),
      ] : []);
      if (path === "/permission" || path === "/question") return Response.json([]);
      throw new Error(`unexpected OpenCode endpoint ${path}`);
    },
  }, async () => {
    if (!prompted) return Response.json({});
    if (!dropFailure) {
      observedRetry();
      return Response.json({ "opaque-session": { type: "retry" } });
    }
    return Response.json({ "opaque-session": { type: "idle" } });
  });

  const operation = adapter.promptWithModel(
    "opaque-session",
    { providerId: "provider-z", modelId: "model-2" },
    { text: "retry", system: "bounded", attachments: [] },
  );
  await retryObserved;
  await adapter.runtimeSnapshot("opaque-session", undefined);
  dropFailure = true;
  await assert.rejects(
    operation,
    (error: any) => error.code === "opencode_prompt_timeout",
  );
});

test("idle waits for terminal tool evidence and persists only a bounded redacted part summary", async (t) => {
  let prompted = false;
  let toolComplete = false;
  let observedRunning!: () => void;
  const runningObserved = new Promise<void>((resolve) => { observedRunning = resolve; });
  const adapter = await readyAdapter(t, {
    fetch: async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/prompt_async")) {
        prompted = true;
        return new Response(null, { status: 204 });
      }
      if (path.endsWith("/message")) {
        if (!prompted) return Response.json([]);
        if (!toolComplete) observedRunning();
        return Response.json([
          { info: { id: "server-user", role: "user" }, parts: [{ type: "text", text: "change" }] },
          {
            info: { id: "assistant", role: "assistant", parentID: "server-user", time: { completed: 1 } },
            parts: [
              { id: "text-1", type: "text", text: "change committed" },
              {
                id: "tool-1",
                type: "tool",
                tool: "riff_apply_model_changes",
                state: {
                  status: toolComplete ? "completed" : "running",
                  input: { workspacePath: "/private/owner", secret: "must-not-persist" },
                  output: "private tool output",
                },
              },
            ],
          },
        ]);
      }
      throw new Error(`unexpected OpenCode endpoint ${path}`);
    },
  }, async () => Response.json(prompted ? { "opaque-session": { type: "idle" } } : {}));

  const operation = adapter.promptWithModel(
    "opaque-session",
    { providerId: "provider-z", modelId: "model-2" },
    { text: "change", system: "bounded", attachments: [] },
  );
  await runningObserved;
  assert.equal(await remainsPending(operation), true);
  toolComplete = true;
  const result = await operation;
  assert.deepEqual(result.content.parts, [
    { ordinal: 0, kind: "text", state: "complete" },
    { ordinal: 1, kind: "tool", state: "complete", toolName: "riff_apply_model_changes" },
  ]);
  assert.doesNotMatch(JSON.stringify(result.content), /workspacePath|must-not-persist|private tool output/u);
});

test("idle rejects a failed tool part with a stable session error", async (t) => {
  let prompted = false;
  const adapter = await readyAdapter(t, {
    fetch: async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/prompt_async")) {
        prompted = true;
        return new Response(null, { status: 204 });
      }
      if (path.endsWith("/message")) return Response.json(prompted ? [
        { info: { id: "server-user", role: "user" }, parts: [] },
        {
          info: { id: "assistant", role: "assistant", parentID: "server-user", time: { completed: 1 } },
          parts: [
            { type: "text", text: "not terminal success" },
            { type: "tool", tool: "riff_apply_model_changes", state: { status: "error", error: "private" } },
          ],
        },
      ] : []);
      throw new Error(`unexpected OpenCode endpoint ${path}`);
    },
  }, async () => Response.json(prompted ? { "opaque-session": { type: "idle" } } : {}));

  await assert.rejects(
    () => adapter.promptWithModel(
      "opaque-session",
      { providerId: "provider-z", modelId: "model-2" },
      { text: "change", system: "bounded", attachments: [] },
    ),
    (error: any) => error.code === "opencode_session_error"
      && !error.message.includes("private"),
  );
});

test("durable assistant part evidence rejects an oversized terminal replay", async (t) => {
  let prompted = false;
  const adapter = await readyAdapter(t, {
    fetch: async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/prompt_async")) {
        prompted = true;
        return new Response(null, { status: 204 });
      }
      if (path.endsWith("/message")) return Response.json(prompted ? [
        { info: { id: "server-user", role: "user" }, parts: [] },
        {
          info: { id: "assistant", role: "assistant", parentID: "server-user", time: { completed: 1 } },
          parts: [
            { type: "text", text: "bounded terminal answer" },
            ...Array.from({ length: 512 }, (_, index) => ({
              id: `tool-${index}`,
              type: "tool",
              tool: "riff_read_owner_summary",
              state: { status: "completed" },
            })),
          ],
        },
      ] : []);
      throw new Error(`unexpected OpenCode endpoint ${path}`);
    },
  }, async () => Response.json(prompted ? { "opaque-session": { type: "idle" } } : {}));

  await assert.rejects(
    () => adapter.promptWithModel(
      "opaque-session",
      { providerId: "provider-z", modelId: "model-2" },
      { text: "inspect", system: "bounded", attachments: [] },
    ),
    (error: any) => error.code === "opencode_response_too_large",
  );
});

test("an absent target status does not complete until the new assistant message itself is complete", async (t) => {
  let prompted = false;
  let assistantComplete = false;
  let observeMissing!: () => void;
  const missingObserved = new Promise<void>((resolve) => { observeMissing = resolve; });
  const adapter = await readyAdapter(t, {
    fetch: async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/prompt_async")) { prompted = true; return new Response(null, { status: 204 }); }
      if (path.endsWith("/message")) return Response.json(prompted ? [
        { info: { id: "server-user", role: "user" }, parts: [{ type: "text", text: "continue" }] },
        { info: { id: "assistant", role: "assistant", parentID: "server-user", time: assistantComplete ? { completed: 1 } : {} }, parts: [{ type: "text", text: "complete only after reconciliation" }] },
      ] : []);
      throw new Error(`unexpected OpenCode endpoint ${path}`);
    },
  }, async () => { if (prompted) observeMissing(); return Response.json({ unrelated_session: { type: "idle" } }); });
  const operation = adapter.promptWithModel("opaque-session", { providerId: "provider-z", modelId: "model-2" }, { text: "continue", system: "bounded", attachments: [] });
  const firstOutcome = await Promise.race([operation.then(() => "settled", () => "settled"), missingObserved.then(() => "missing")]);
  assert.equal(firstOutcome, "missing");
  assert.equal(await remainsPending(operation), true);
  assistantComplete = true;
  assert.equal((await operation).text, "complete only after reconciliation");
});

test("transient status reconnects, duplicate messages are deduped, and late unrelated generations are ignored", async (t) => {
  let prompted = false;
  let statusPolls = 0;
  const adapter = await readyAdapter(t, {
    fetch: async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/prompt_async")) { prompted = true; return new Response(null, { status: 204 }); }
      if (path.endsWith("/message")) return Response.json(prompted ? [
        { info: { id: "late-user", role: "user" }, parts: [{ type: "text", text: "older generation" }] },
        { info: { id: "late-assistant", role: "assistant", parentID: "late-user", time: { completed: 1 } }, parts: [{ id: "late-part", type: "text", text: "late old answer" }] },
        { info: { id: "server-user", role: "user" }, parts: [{ type: "text", text: "current generation" }] },
        { info: { id: "fresh-assistant", role: "assistant", parentID: "server-user", time: {} }, parts: [{ id: "fresh-part", type: "text", text: "partial answer" }] },
        { info: { id: "fresh-assistant", role: "assistant", parentID: "server-user", time: { completed: 2 } }, parts: [{ id: "fresh-part", type: "text", text: "fresh answer" }] },
      ] : [
        { info: { id: "late-user", role: "user" }, parts: [{ type: "text", text: "older generation" }] },
        { info: { id: "late-assistant", role: "assistant", parentID: "late-user", time: { completed: 1 } }, parts: [{ id: "late-part", type: "text", text: "late old answer" }] },
      ]);
      throw new Error(`unexpected OpenCode endpoint ${path}`);
    },
  }, async () => {
    statusPolls += 1;
    if (statusPolls === 1) return Response.json({ error: { code: "server_restarting" } }, { status: 503 });
    if (statusPolls === 2) return Response.json({ retired_session: { type: "idle" }, "opaque-session": { type: "busy" } });
    return Response.json({ retired_session: { type: "busy" }, "opaque-session": { type: "idle" } });
  });
  const result = await adapter.promptWithModel("opaque-session", { providerId: "provider-z", modelId: "model-2" }, { text: "current generation", system: "bounded", attachments: [] });
  assert.equal(result.text, "fresh answer");
  assert.equal(result.content.textParts, 1);
  assert.equal(result.messageId, "fresh-assistant");
  assert.ok(statusPolls >= 3);
});

test("managed /event reconnect filters duplicate, late, and unrelated events while canonical replay gates idle and cleanup", async (t) => {
  let prompted = false;
  let terminal = false;
  let messagePolls = 0;
  let eventRequests = 0;
  const order: string[] = [];
  const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
  const signals: AbortSignal[] = [];
  const adapter = await readyAdapter(t, {
    requestTimeoutMs: 2_000,
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/event") {
        eventRequests += 1;
        order.push(`event:${eventRequests}`);
        const signal = init?.signal;
        if (!(signal instanceof AbortSignal)) throw new Error("missing managed event signal");
        signals.push(signal);
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controllers.push(controller);
            signal.addEventListener("abort", () => {
              try { controller.close(); } catch { /* deterministic disconnect may have closed it */ }
            }, { once: true });
          },
        }), { headers: { "content-type": "text/event-stream" } });
      }
      if (path.endsWith("/prompt_async")) {
        order.push("prompt");
        prompted = true;
        for (const event of [
          { id: "early-error", type: "session.error", properties: { sessionID: "opaque-session", error: { name: "ToolExecutionError" } } },
          { id: "late-other", type: "session.error", properties: { sessionID: "retired-session", error: { name: "ToolExecutionError" } } },
          { id: "duplicate", type: "session.status", properties: { sessionID: "opaque-session", status: { type: "busy" } } },
          { id: "duplicate", type: "session.status", properties: { sessionID: "opaque-session", status: { type: "idle" } } },
        ]) writeSse(controllers[0], event);
        await new Promise((resolve) => setImmediate(resolve));
        return new Response(null, { status: 204 });
      }
      if (path.endsWith("/message")) {
        if (!prompted) return Response.json([]);
        messagePolls += 1;
        return Response.json([
          { info: { id: "server-user", role: "user" }, parts: [{ type: "text", text: "current" }] },
          { info: { id: "assistant", role: "assistant", parentID: "server-user", time: { completed: 1 } }, parts: [{ type: "text", text: "canonical replay wins" }] },
        ]);
      }
      throw new Error(`unexpected OpenCode endpoint ${path}`);
    },
  }, async () => Response.json(prompted ? {
    "opaque-session": { type: terminal ? "idle" : "busy" },
    "retired-session": { type: "idle" },
  } : {}));

  const operation = adapter.promptWithModel("opaque-session", { providerId: "provider-z", modelId: "model-2" }, {
    text: "current", system: "bounded", attachments: [],
  });
  await waitUntil(() => messagePolls > 0 && controllers.length === 1, "initial replay");
  assert.deepEqual(order.slice(0, 2), ["event:1", "prompt"]);
  assert.equal(await remainsPending(operation), true, "pre-arm error and first complete text cannot bypass target busy");
  controllers[0].close();
  await waitUntil(() => eventRequests === 2 && controllers.length === 2, "event reconnect");
  writeSse(controllers[1], { id: "idle-accelerator", type: "session.idle", properties: { sessionID: "opaque-session" } });
  assert.equal(await remainsPending(operation), true, "idle event cannot override canonical busy");
  terminal = true;
  writeSse(controllers[1], {
    id: "idle-after-replay",
    type: "session.status",
    properties: { sessionID: "opaque-session", status: { type: "idle" } },
  });
  assert.equal((await operation).text, "canonical replay wins");
  assert.equal(signals.every((signal) => signal.aborted), true);
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.equal(eventRequests, 2, "terminal cleanup must prevent late reconnect");
});

test("managed /event never attributes a delayed exact-session error to the current turn without canonical evidence", async (t) => {
  let prompted = false;
  let terminal = false;
  let messagePolls = 0;
  let eventRequests = 0;
  const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
  const signals: AbortSignal[] = [];
  const adapter = await readyAdapter(t, {
    requestTimeoutMs: 2_000,
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/event") {
        eventRequests += 1;
        const signal = init?.signal;
        if (!(signal instanceof AbortSignal)) throw new Error("missing managed event signal");
        signals.push(signal);
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controllers.push(controller);
            signal.addEventListener("abort", () => {
              try { controller.close(); } catch { /* already closed */ }
            }, { once: true });
          },
        }));
      }
      if (path.endsWith("/prompt_async")) { prompted = true; return new Response(null, { status: 204 }); }
      if (path.endsWith("/message")) {
        if (!prompted) return Response.json([]);
        messagePolls += 1;
        return Response.json([
          { info: { id: "server-user", role: "user" }, parts: [] },
          {
            info: {
              id: "assistant",
              role: "assistant",
              parentID: "server-user",
              time: terminal ? { completed: 1 } : {},
            },
            parts: [{ type: "text", text: terminal ? "current turn succeeds" : "partial" }],
          },
        ]);
      }
      throw new Error(`unexpected OpenCode endpoint ${path}`);
    },
  }, async () => Response.json(prompted ? { "opaque-session": { type: terminal ? "idle" : "busy" } } : {}));

  const operation = adapter.promptWithModel("opaque-session", { providerId: "provider-z", modelId: "model-2" }, {
    text: "current", system: "bounded", attachments: [],
  });
  await waitUntil(() => messagePolls > 0, "new-user replay");
  writeSse(controllers[0], {
    id: "target-error",
    type: "session.error",
    properties: { sessionID: "opaque-session", error: { name: "ToolExecutionError", data: { message: "private" } } },
  });
  assert.equal(await remainsPending(operation), true,
    "a delayed prior-turn error with a new event ID cannot be associated to the current user message");
  writeSse(controllers[0], {
    id: "target-error",
    type: "session.error",
    properties: { sessionID: "opaque-session", error: { name: "MessageAbortedError" } },
  });
  terminal = true;
  writeSse(controllers[0], {
    id: "current-idle",
    type: "session.idle",
    properties: { sessionID: "opaque-session" },
  });
  assert.equal((await operation).text, "current turn succeeds");
  assert.equal(eventRequests, 1);
  assert.equal(signals[0].aborted, true);
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.equal(eventRequests, 1);
});

test("assistant abort and session errors map to stable terminal failures", async (t) => {
  for (const [errorName, code] of [
    ["MessageAbortedError", "opencode_session_aborted"],
    ["ToolExecutionError", "opencode_session_error"],
  ] as const) {
    let prompted = false;
    const adapter = await readyAdapter(t, {
      fetch: async (input) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/prompt_async")) { prompted = true; return new Response(null, { status: 204 }); }
        if (path.endsWith("/message")) return Response.json(prompted ? [
          { info: { id: "server-user", role: "user" }, parts: [{ type: "text", text: "continue" }] },
          { info: { id: `assistant-${errorName}`, role: "assistant", parentID: "server-user", error: { name: errorName, data: { message: "private upstream detail" } } }, parts: [] },
        ] : []);
        throw new Error(`unexpected OpenCode endpoint ${path}`);
      },
    }, async () => Response.json(prompted ? { "opaque-session": { type: "idle" } } : {}));
    await assert.rejects(
      () => adapter.promptWithModel("opaque-session", { providerId: "provider-z", modelId: "model-2" }, { text: "continue", system: "bounded", attachments: [] }),
      (error: any) => error.code === code && !error.message.includes("private upstream detail"),
    );
  }
});

test("a permanently busy target session times out with a stable bounded failure", async (t) => {
  let prompted = false;
  const adapter = await readyAdapter(t, {
    requestTimeoutMs: 40,
    fetch: async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/prompt_async")) { prompted = true; return new Response(null, { status: 204 }); }
      if (path.endsWith("/message")) return Response.json(prompted ? [
        { info: { id: "server-user", role: "user" }, parts: [{ type: "text", text: "continue" }] },
        { info: { id: "assistant-first-text", role: "assistant", parentID: "server-user" }, parts: [{ type: "text", text: "still working" }] },
      ] : []);
      throw new Error(`unexpected OpenCode endpoint ${path}`);
    },
  }, async () => Response.json(prompted ? { "opaque-session": { type: "busy" } } : {}));
  await assert.rejects(
    () => adapter.promptWithModel("opaque-session", { providerId: "provider-z", modelId: "model-2" }, { text: "continue", system: "bounded", attachments: [] }),
    (error: any) => error.code === "opencode_prompt_timeout",
  );
});

test("adapter revalidates server and session identity before accepting a polled reply", async (t) => {
  const workdir = await mkdtemp(join(tmpdir(), "riff-opencode-reply-drift-"));
  t.after(() => rm(workdir, { recursive: true, force: true }));
  let version = "test";
  let prompted = false;
  let messageReads = 0;
  const adapter = new HttpOpenCodeAdapter({
    baseUrl: "http://127.0.0.1:4096",
    model: "provider-z/model-2",
    workdir,
    expectedVersion: "test",
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/global/health") {
        return Response.json({ healthy: true, version });
      }
      if (path === "/path") return Response.json({ directory: workdir });
      if (path === "/config/providers") {
        return Response.json({
          providers: [{ id: "provider-z", models: { "model-2": {} } }],
        });
      }
      if (path === "/session/opaque-session") {
        return Response.json({ id: "opaque-session", directory: workdir });
      }
      if (path === "/session/opaque-session/prompt_async") {
        prompted = true;
        return new Response(null, { status: 204 });
      }
      if (path === "/session/status") {
        return Response.json(prompted ? { "opaque-session": { type: "idle" } } : {});
      }
      if (path === "/session/opaque-session/message") {
        messageReads += 1;
        if (!prompted) return Response.json([]);
        version = "restarted-version";
        return Response.json([
          { info: { id: "new-user", role: "user" }, parts: [{ type: "text", text: "next" }] },
          { info: { id: "untrusted-reply", role: "assistant", parentID: "new-user", time: { completed: 1 } }, parts: [{ type: "text", text: "must not be accepted" }] },
        ]);
      }
      throw new Error(`unexpected OpenCode endpoint ${path} ${init?.method ?? "GET"}`);
    },
  });
  assert.equal((await adapter.initialize()).status, "ready");
  const workspace = {
    owner: { kind: "model" as const, id: "model-owner" },
    directory: workdir,
  };
  await assert.rejects(
    () => adapter.promptWithModel(
      "opaque-session",
      { providerId: "provider-z", modelId: "model-2" },
      { text: "next", system: "bounded", attachments: [] },
      undefined,
      workspace,
    ),
    (error: any) => error.code === "opencode_version_mismatch",
  );
  assert.equal(messageReads, 2);
});

test("completed tool evidence survives a later abbreviated replay and performs one final identity check", async (t) => {
  const workdir = await mkdtemp(join(tmpdir(), "riff-opencode-tool-poll-"));
  t.after(() => rm(workdir, { recursive: true, force: true }));
  let healthChecks = 0;
  let pathChecks = 0;
  let prompted = false;
  let postPromptReads = 0;
  const adapter = new HttpOpenCodeAdapter({
    baseUrl: "http://127.0.0.1:4096",
    model: "provider-z/model-2",
    workdir,
    expectedVersion: "test",
    fetch: async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/global/health") {
        healthChecks += 1;
        return Response.json({ healthy: true, version: "test" });
      }
      if (path === "/path") {
        pathChecks += 1;
        return Response.json({ directory: workdir });
      }
      if (path === "/config/providers") {
        return Response.json({
          providers: [{ id: "provider-z", models: { "model-2": {} } }],
        });
      }
      if (path === "/session/opaque-session") {
        return Response.json({ id: "opaque-session", directory: workdir });
      }
      if (path === "/session/opaque-session/prompt_async") {
        prompted = true;
        return new Response(null, { status: 204 });
      }
      if (path === "/session/status") {
        return Response.json(prompted ? { "opaque-session": { type: "idle" } } : {});
      }
      if (path === "/session/opaque-session/message") {
        if (!prompted) return Response.json([]);
        postPromptReads += 1;
        return Response.json([
          { info: { id: "new-user", role: "user" }, parts: [{ type: "text", text: "next" }] },
          postPromptReads < 4
            ? {
              info: { id: "tool-only", role: "assistant", parentID: "new-user", time: { completed: postPromptReads } },
              parts: [{ type: "tool", tool: "riff_read_owner_summary", state: { status: "completed" } }],
            }
            : { info: { id: "final-text", role: "assistant", parentID: "new-user", time: { completed: 4 } }, parts: [{ type: "text", text: "final answer" }] },
        ]);
      }
      throw new Error(`unexpected OpenCode endpoint ${path}`);
    },
  });
  assert.equal((await adapter.initialize()).status, "ready");
  const workspace = {
    owner: { kind: "model" as const, id: "model-owner" },
    directory: workdir,
  };
  const result = await adapter.promptWithModel(
    "opaque-session",
    { providerId: "provider-z", modelId: "model-2" },
    { text: "next", system: "bounded", attachments: [] },
    undefined,
    workspace,
  );
  assert.equal(result.text, "final answer");
  assert.equal(postPromptReads, 4);
  assert.equal(healthChecks, 3, "initialize, prompt admission, and final acceptance only");
  assert.equal(pathChecks, 3, "initialize, prompt admission, and final acceptance only");
});

test("a running tool that disappears from replay cannot be mistaken for terminal success", async (t) => {
  let prompted = false;
  let messageReads = 0;
  const adapter = await readyAdapter(t, {
    requestTimeoutMs: 80,
    fetch: async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/prompt_async")) {
        prompted = true;
        return new Response(null, { status: 204 });
      }
      if (path.endsWith("/message")) {
        if (!prompted) return Response.json([]);
        messageReads += 1;
        return Response.json([
          { info: { id: "new-user", role: "user" }, parts: [{ type: "text", text: "next" }] },
          ...(messageReads === 1 ? [{
            info: { id: "tool-only", role: "assistant", parentID: "new-user", time: { completed: 1 } },
            parts: [{
              id: "running-tool",
              type: "tool",
              tool: "riff_read_owner_summary",
              state: { status: "running" },
            }],
          }] : [{
            info: { id: "final-text", role: "assistant", parentID: "new-user", time: { completed: 2 } },
            parts: [{ type: "text", text: "must not be accepted" }],
          }]),
        ]);
      }
      throw new Error(`unexpected OpenCode endpoint ${path}`);
    },
  }, async () => Response.json(prompted ? { "opaque-session": { type: "idle" } } : {}));

  await assert.rejects(
    () => adapter.promptWithModel(
      "opaque-session",
      { providerId: "provider-z", modelId: "model-2" },
      { text: "next", system: "bounded", attachments: [] },
    ),
    (error: any) => error.code === "opencode_prompt_timeout",
  );
  assert.ok(messageReads >= 2);
});

test("final reply identity revalidation inherits the turn abort signal", async (t) => {
  const workdir = await mkdtemp(join(tmpdir(), "riff-opencode-final-abort-"));
  t.after(() => rm(workdir, { recursive: true, force: true }));
  const controller = new AbortController();
  const cancelled = new Error("cancel final identity check");
  let prompted = false;
  let blockIdentity = false;
  let inheritedTurnSignal = false;
  const adapter = new HttpOpenCodeAdapter({
    baseUrl: "http://127.0.0.1:4096",
    model: "provider-z/model-2",
    workdir,
    expectedVersion: "test",
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/global/health") {
        if (!blockIdentity) {
          return Response.json({ healthy: true, version: "test" });
        }
        inheritedTurnSignal = init?.signal === controller.signal;
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          const rejectCancelled = () => reject(signal?.reason ?? cancelled);
          if (signal?.aborted) rejectCancelled();
          else signal?.addEventListener("abort", rejectCancelled, { once: true });
        });
      }
      if (path === "/path") return Response.json({ directory: workdir });
      if (path === "/config/providers") {
        return Response.json({
          providers: [{ id: "provider-z", models: { "model-2": {} } }],
        });
      }
      if (path === "/session/opaque-session") {
        return Response.json({ id: "opaque-session", directory: workdir });
      }
      if (path === "/session/opaque-session/prompt_async") {
        prompted = true;
        return new Response(null, { status: 204 });
      }
      if (path === "/session/status") {
        return Response.json(prompted ? { "opaque-session": { type: "idle" } } : {});
      }
      if (path === "/session/opaque-session/message") {
        if (!prompted) return Response.json([]);
        blockIdentity = true;
        return Response.json([
          { info: { id: "new-user", role: "user" }, parts: [{ type: "text", text: "next" }] },
          { info: { id: "candidate", role: "assistant", parentID: "new-user", time: { completed: 1 } }, parts: [{ type: "text", text: "candidate answer" }] },
        ]);
      }
      throw new Error(`unexpected OpenCode endpoint ${path}`);
    },
  });
  assert.equal((await adapter.initialize()).status, "ready");
  const workspace = {
    owner: { kind: "model" as const, id: "model-owner" },
    directory: workdir,
  };
  const pending = adapter.promptWithModel(
    "opaque-session",
    { providerId: "provider-z", modelId: "model-2" },
    { text: "next", system: "bounded", attachments: [] },
    controller.signal,
    workspace,
  );
  setTimeout(() => controller.abort(cancelled), 10);
  await assert.rejects(
    pending,
    (error: any) => error.code === "opencode_session_aborted",
  );
  assert.equal(inheritedTurnSignal, true);
});

test("session manager reuses one available session per conversation", async () => {
  const repository = new MemoryRepository();
  repository.runtime.session = { generation: 3, state: "available", externalSessionRef: "external-one" };
  const openCode = new FakeConversationOpenCode();
  openCode.existing.add("external-one");
  const manager = new AgentConversationSessionManager(repository, openCode, testWorkspaceForOwner);
  const first = await manager.prompt("conversation-a", context(), "first");
  const second = await manager.prompt("conversation-a", context(), "second");
  assert.equal(first.mode, "live");
  assert.equal(second.mode, "live");
  assert.equal(openCode.created.length, 0);
  assert.equal(openCode.injected.length, 0);
  assert.deepEqual(openCode.prompts.map((item) => [item.sessionId, item.binding]), [
    ["external-one", { providerId: "provider-z", modelId: "model-2" }],
    ["external-one", { providerId: "provider-z", modelId: "model-2" }],
  ]);
});

test("session manager derives one backend-only workspace binding from the durable owner", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "riff-owner-workspace-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = new MemoryRepository();
  const openCode = new FakeConversationOpenCode();
  const workspace = Object.freeze({
    owner: Object.freeze({ kind: "model" as const, id: "model-a" }),
    directory,
  });
  const manager = new AgentConversationSessionManager(
    repository,
    openCode,
    (owner) => {
      assert.deepEqual(owner, workspace.owner);
      return workspace;
    },
    {},
  );

  await manager.prompt("conversation-a", context(), "Inspect the model");
  assert.equal(openCode.workspaces.length >= 4, true);
  assert.equal(openCode.workspaces.every((value) => value === workspace), true);
});

test("adapter scopes Product sessions and controls to the server-derived owner directory", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "riff-opencode-owner-scope-"));
  const defaultDirectory = join(root, "default");
  const modelDirectory = join(root, "model");
  const projectDirectory = join(root, "project");
  await Promise.all([
    mkdir(defaultDirectory),
    mkdir(modelDirectory),
    mkdir(projectDirectory),
  ]);
  const modelCanonical = await realpath(modelDirectory);
  const projectCanonical = await realpath(projectDirectory);
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls: Array<{ path: string; directory: string | null; method: string }> = [];
  let misdirectCreatedSession = false;
  let projectPrompted = false;
  let scopedMcpName = "";
  const adapter = new HttpOpenCodeAdapter({
    baseUrl: "http://127.0.0.1:4096",
    model: "provider-z/model-2",
    workdir: defaultDirectory,
    expectedVersion: "test",
    fetch: async (input, init) => {
      const url = new URL(String(input));
      calls.push({
        path: url.pathname,
        directory: url.searchParams.get("directory"),
        method: init?.method ?? "GET",
      });
      if (url.pathname === "/global/health") {
        return Response.json({ healthy: true, version: "test" });
      }
      if (url.pathname === "/path") {
        return Response.json({ directory: url.searchParams.get("directory") });
      }
      if (url.pathname === "/config/providers") {
        return Response.json({
          providers: [{ id: "provider-z", models: { "model-2": {} } }],
        });
      }
      if (url.pathname === "/session" && init?.method === "POST") {
        return Response.json({
          id: url.searchParams.get("directory") === modelCanonical
            ? "session-model"
            : "session-project",
          directory: misdirectCreatedSession
            ? projectCanonical
            : url.searchParams.get("directory"),
        });
      }
      if (url.pathname === "/session/session-model") {
        return Response.json({ id: "session-model", directory: modelCanonical });
      }
      if (url.pathname === "/session/session-project") {
        return Response.json({
          id: "session-project",
          directory: projectCanonical,
        });
      }
      if (url.pathname === "/session/session-project/message") {
        return Response.json(projectPrompted ? [
          { info: { id: "project-user", role: "user" }, parts: [{ type: "text", text: "inspect" }] },
          { info: { id: "project-assistant", role: "assistant", parentID: "project-user", time: { completed: 1 } }, parts: [{ type: "text", text: "scoped answer" }] },
        ] : []);
      }
      if (url.pathname === "/session/session-project/prompt_async") {
        projectPrompted = true;
        return new Response(null, { status: 204 });
      }
      if (url.pathname === "/permission" || url.pathname === "/question") {
        return Response.json([]);
      }
      if (url.pathname.startsWith("/session/")) {
        return Response.json({});
      }
      if (url.pathname === "/mcp" && init?.method === "POST") {
        scopedMcpName = JSON.parse(String(init.body)).name;
        return Response.json({});
      }
      if (url.pathname === "/mcp") {
        return Response.json(scopedMcpName
          ? { [scopedMcpName]: { status: "connected" } } : {});
      }
      if (url.pathname.includes("/mcp/")) {
        return Response.json({});
      }
      if (url.pathname === "/event") {
        return new Response(new ReadableStream({
          start(controller) { controller.close(); },
        }), {
          headers: { "content-type": "text/event-stream" },
        });
      }
      throw new Error(`unexpected OpenCode endpoint ${url.pathname}`);
    },
  });
  assert.equal((await adapter.initialize()).status, "ready");
  const modelWorkspace = {
    owner: { kind: "model" as const, id: "model-owner" },
    directory: modelDirectory,
  };
  const projectWorkspace = {
    owner: { kind: "project" as const, id: "project-owner" },
    directory: projectDirectory,
  };

  assert.equal(
    await adapter.createSession("conversation-model", modelWorkspace),
    "session-model",
  );
  assert.equal(
    await adapter.createSession("conversation-project", projectWorkspace),
    "session-project",
  );
  assert.equal(await adapter.getSession("session-model", modelWorkspace), true);
  assert.equal(await adapter.getSession("session-model", projectWorkspace), false);
  misdirectCreatedSession = true;
  await assert.rejects(
    () => adapter.createSession("conversation-misdirected", modelWorkspace),
    (error: any) => error.code === "opencode_session_workspace_mismatch",
  );
  misdirectCreatedSession = false;
  const wrongOwnerStart = calls.length;
  await assert.rejects(
    () => adapter.promptWithModel(
      "session-model",
      { providerId: "provider-z", modelId: "model-2" },
      { text: "must not cross owners", system: "bounded", attachments: [] },
      undefined,
      projectWorkspace,
    ),
    (error: any) => error.code === "opencode_session_workspace_mismatch",
  );
  await assert.rejects(
    () => adapter.abort("session-model", projectWorkspace),
    (error: any) => error.code === "opencode_session_workspace_mismatch",
  );
  const wrongOwnerCalls = calls.slice(wrongOwnerStart);
  assert.equal(wrongOwnerCalls.some((call) =>
    call.path === "/session/session-model/message"
      || call.path === "/session/session-model/prompt_async"
      || call.path === "/session/session-model/abort"), false);

  const assistant = await adapter.promptWithModel(
    "session-project",
    { providerId: "provider-z", modelId: "model-2" },
    { text: "inspect", system: "bounded", attachments: [] },
    undefined,
    projectWorkspace,
  );
  assert.equal(assistant.text, "scoped answer");
  const projectRuntime = await adapter.runtimeSnapshot(
    "session-project",
    undefined,
    projectWorkspace,
  );
  assert.equal(projectRuntime.status, "idle");
  const crossOwnerControlStart = calls.length;
  await assert.rejects(
    () => adapter.runtimeSnapshot("session-project", undefined, modelWorkspace),
    (error: any) => error.code === "opencode_session_workspace_mismatch",
  );
  await assert.rejects(
    () => adapter.respondPermission(
      "session-project",
      `permission_${"a".repeat(32)}`,
      "once",
      modelWorkspace,
    ),
    (error: any) => error.code === "opencode_session_workspace_mismatch",
  );
  adapter.releaseRuntimeBoundary("session-project", modelWorkspace);
  assert.equal(
    (await adapter.runtimeSnapshot("session-project", undefined, projectWorkspace)).status,
    "idle",
    "a cross-owner release must not erase the admitted runtime boundary",
  );
  assert.equal(calls.slice(crossOwnerControlStart).some((call) =>
    call.method === "POST"
      && (call.path.startsWith("/permission/")
        || call.path.startsWith("/question/")
        || call.path.endsWith("/abort"))), false);
  await adapter.abort("session-project", projectWorkspace);
  await adapter.bindScopedMcp(
    "conversation-model",
    "http://127.0.0.1:8787/a2/mcp?cap=opaque-capability",
    ["riff_read_owner_summary"],
    modelWorkspace,
  );
  await adapter.unbindScopedMcp("conversation-model", modelWorkspace);
  const unsubscribe = await adapter.subscribeEvents(
    () => undefined,
    modelWorkspace,
  );
  unsubscribe();
  adapter.releaseRuntimeBoundary("session-project", projectWorkspace);

  const locationCalls = calls.filter((call) =>
    call.path.startsWith("/session") || call.path.startsWith("/mcp"));
  assert.equal(locationCalls.length > 0, true);
  assert.equal(locationCalls.every((call) =>
    call.directory === modelCanonical || call.directory === projectCanonical), true);
  assert.equal(locationCalls.some((call) => call.directory === modelCanonical), true);
  assert.equal(locationCalls.some((call) => call.directory === projectCanonical), true);
  assert.equal(calls.filter((call) => call.path === "/global/health")
    .every((call) => call.directory === null), true);
  assert.equal(calls.some((call) =>
    call.path === "/event" && call.directory === modelCanonical), true);
});

test("a failed prompt retires its session before the next turn rebuilds", async () => {
  const repository = new MemoryRepository();
  repository.runtime.session = { generation: 3, state: "available", externalSessionRef: "external-one" };
  const openCode = new FakeConversationOpenCode();
  openCode.existing.add("external-one");
  openCode.failPrompt = new Error("timed out after OpenCode accepted the prompt");
  const manager = new AgentConversationSessionManager(repository, openCode, testWorkspaceForOwner);

  const failed = await manager.prompt("conversation-a", context(), "first");
  assert.deepEqual(failed, { mode: "read_only", conversationId: "conversation-a", reason: "opencode_unavailable", retryable: true });
  assert.deepEqual(openCode.aborted, ["external-one"]);
  assert.deepEqual(repository.lost, [{
    conversationId: "conversation-a", generation: 3, expectedExternalSessionRef: "external-one",
    reason: "prompt_failed:opencode_unavailable",
  }]);

  openCode.failPrompt = undefined;
  const recovered = await manager.prompt("conversation-a", context(), "second");
  assert.equal(recovered.mode, "live");
  assert.deepEqual(openCode.prompts.map((item) => item.sessionId), ["external-one", "external-1"]);
  assert.equal(repository.activated.at(-1)?.generation, 4);
});

test("session manager maps lifecycle timeout and session error to durable read-only reasons before retiring the generation", async () => {
  for (const code of ["opencode_prompt_timeout", "opencode_session_error"] as const) {
    const repository = new MemoryRepository();
    repository.runtime.session = { generation: 7, state: "available", externalSessionRef: "external-one" };
    const openCode = new FakeConversationOpenCode();
    openCode.existing.add("external-one");
    openCode.failPrompt = new ApiError(504, code, "bounded lifecycle failure");
    const manager = new AgentConversationSessionManager(repository, openCode, testWorkspaceForOwner);

    assert.deepEqual(await manager.prompt("conversation-a", context(), "continue"), {
      mode: "read_only", conversationId: "conversation-a", reason: code, retryable: true,
    });
    assert.deepEqual(openCode.aborted, ["external-one"]);
    assert.equal(repository.lost[0]?.reason, `prompt_failed:${code}`);
    assert.equal(repository.runtime.session?.state, "lost");
  }
});

test("caller abort is rethrown only after the exact session generation is aborted and retired", async () => {
  const repository = new MemoryRepository();
  repository.runtime.session = { generation: 9, state: "available", externalSessionRef: "external-one" };
  const openCode = new FakeConversationOpenCode();
  openCode.existing.add("external-one");
  openCode.failPrompt = new ApiError(409, "opencode_session_aborted", "caller stopped the target session");
  const manager = new AgentConversationSessionManager(repository, openCode, testWorkspaceForOwner);
  const controller = new AbortController();
  controller.abort(new Error("caller stop"));

  await assert.rejects(
    () => manager.prompt("conversation-a", context(), "stop", [], undefined, controller.signal),
    (error: any) => error.code === "opencode_session_aborted",
  );
  assert.deepEqual(openCode.aborted, ["external-one"]);
  assert.deepEqual(repository.lost, [{
    conversationId: "conversation-a",
    generation: 9,
    expectedExternalSessionRef: "external-one",
    reason: "prompt_failed:opencode_session_aborted",
  }]);
});

test("a second named conversation receives an independent external session", async () => {
  const repository = new MemoryRepository();
  const openCode = new FakeConversationOpenCode();
  const manager = new AgentConversationSessionManager(repository, openCode, testWorkspaceForOwner);
  const first = await manager.ensureSession("conversation-a", context("conversation-a"));
  repository.runtime = {
    conversationId: "conversation-b",
    owner: { kind: "model", id: "model-a" },
    providerId: "provider-z",
    providerModelId: "model-2",
    session: null,
  };
  const second = await manager.ensureSession("conversation-b", context("conversation-b"));
  assert.equal(first.mode, "live");
  assert.equal(second.mode, "live");
  if (first.mode !== "live" || second.mode !== "live") return;
  assert.notEqual(first.externalSessionRef, second.externalSessionRef);
  assert.deepEqual(openCode.created, ["conversation-a", "conversation-b"]);
});

test("missing external session is marked lost and rebuilt with bounded Riff context", async () => {
  const repository = new MemoryRepository();
  repository.runtime.session = { generation: 4, state: "available", externalSessionRef: "external-one" };
  const openCode = new FakeConversationOpenCode();
  const manager = new AgentConversationSessionManager(
    repository,
    openCode,
    testWorkspaceForOwner,
    { maxBytes: 512 },
  );
  const result = await manager.ensureSession("conversation-a", context());
  assert.equal(result.mode, "live");
  if (result.mode !== "live") return;
  assert.equal(result.generation, 5);
  assert.equal(result.reconstructed, true);
  assert.equal(repository.lost.length, 1);
  assert.equal(openCode.created.length, 1);
  assert.equal(openCode.injected.length, 1);
  assert.ok(Buffer.byteLength(openCode.injected[0].context) <= 512);
  assert.doesNotMatch(openCode.injected[0].context, /external-one|external-two/u);
  assert.equal(repository.activated[0].contextSha256, result.context.sha256);
});

test("concurrent preparation for one conversation creates only one external session", async () => {
  const repository = new MemoryRepository();
  const openCode = new FakeConversationOpenCode();
  let release!: () => void;
  openCode.createDelay = new Promise<void>((resolve) => { release = resolve; });
  const manager = new AgentConversationSessionManager(repository, openCode, testWorkspaceForOwner);
  const first = manager.ensureSession("conversation-a", context());
  const second = manager.ensureSession("conversation-a", context());
  release();
  const [left, right] = await Promise.all([first, second]);
  assert.deepEqual(left, right);
  assert.equal(openCode.created.length, 1);
});

test("missing exact provider/model and rebuild failure yield stable read-only without canned prompt", async () => {
  for (const [catalogue, reason] of [
    [[], "provider_unavailable"],
    [[{ providerId: "provider-z", modelId: "other", qualifiedId: "provider-z/other" }], "model_unavailable"],
  ] as const) {
    const repository = new MemoryRepository();
    const openCode = new FakeConversationOpenCode();
    openCode.catalogue = [...catalogue];
    const result = await new AgentConversationSessionManager(
      repository,
      openCode,
      testWorkspaceForOwner,
    ).prompt("conversation-a", context(), "must not be sent");
    assert.deepEqual(result, { mode: "read_only", conversationId: "conversation-a", reason, retryable: true });
    assert.equal(openCode.created.length, 0);
    assert.equal(openCode.prompts.length, 0);
  }
  const repository = new MemoryRepository();
  const openCode = new FakeConversationOpenCode();
  openCode.failCreate = new Error("down");
  const result = await new AgentConversationSessionManager(
    repository,
    openCode,
    testWorkspaceForOwner,
  ).prompt("conversation-a", context(), "must not be sent");
  assert.deepEqual(result, { mode: "read_only", conversationId: "conversation-a", reason: "session_rebuild_failed", retryable: true });
  assert.equal(openCode.prompts.length, 0);
  assert.equal(repository.failed.length, 1);
});
