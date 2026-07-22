import assert from "node:assert/strict";
import test from "node:test";
import { AgentConversationSessionManager, type AgentSessionRepositoryPort, type DurableConversationRuntime } from "../src/agent-session-manager.ts";
import type { AgentContextInput } from "../src/agent-context.ts";
import { HttpOpenCodeAdapter, type OpenCodeConversationPort, type OpenCodePrompt, type OpenCodeProviderModel } from "../src/opencode-adapter.ts";

const context = (conversationId = "conversation-a"): AgentContextInput => ({
  conversationId,
  owner: { kind: "model", id: "model-a" },
  ownerSummary: { owner: { kind: "model", id: "model-a" }, text: "Generic model", workspaceDigest: "b".repeat(64) },
  messages: [{ id: "message-a", conversationId, ordinal: 0, role: "user", status: "complete", text: "Inspect the model" }],
  sensitiveValues: ["external-one", "external-two"],
});

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
  createDelay?: Promise<void>;
  failDiscovery?: Error;
  failCreate?: Error;

  async discoverProviderModels() { if (this.failDiscovery) throw this.failDiscovery; return this.catalogue; }
  async getSession(sessionId: string) { return this.existing.has(sessionId); }
  async createSession(conversationId: string) {
    if (this.createDelay) await this.createDelay;
    if (this.failCreate) throw this.failCreate;
    const id = `external-${this.created.length + 1}`;
    this.created.push(conversationId);
    this.existing.add(id);
    return id;
  }
  async injectContext(sessionId: string, value: string) { this.injected.push({ sessionId, context: value }); }
  async promptWithModel(sessionId: string, binding: { providerId: string; modelId: string }, prompt: OpenCodePrompt) { this.prompts.push({ sessionId, binding, prompt }); }
  async abort() {}
}

test("adapter accepts only credential-free loopback HTTP base URLs", () => {
  assert.doesNotThrow(() => new HttpOpenCodeAdapter({ baseUrl: "http://127.0.0.1:4096" }));
  assert.doesNotThrow(() => new HttpOpenCodeAdapter({ baseUrl: "http://localhost:4096" }));
  assert.doesNotThrow(() => new HttpOpenCodeAdapter({ baseUrl: "http://[::1]:4096" }));
  for (const unsafe of [
    "https://127.0.0.1:4096", "http://example.com", "http://user:secret@127.0.0.1:4096",
    "http://127.0.0.1:4096/path", "http://127.0.0.1:4096?target=remote",
  ]) assert.throws(() => new HttpOpenCodeAdapter({ baseUrl: unsafe }), /loopback HTTP URL|unauthenticated|path/u);
});

test("adapter refuses redirects and never follows a cross-host location", async () => {
  const calls: Array<{ url: string; redirect?: RequestRedirect }> = [];
  const adapter = new HttpOpenCodeAdapter({
    baseUrl: "http://127.0.0.1:4096",
    model: "provider-z/model-2",
    fetch: async (input, init) => {
      calls.push({ url: String(input), redirect: init?.redirect });
      return new Response(null, { status: 302, headers: { location: "http://attacker.example/steal" } });
    },
  });
  await assert.rejects(() => adapter.discoverProviderModels(), (error: any) => error.code === "opencode_redirect_forbidden");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].redirect, "manual");
  assert.match(calls[0].url, /^http:\/\/127\.0\.0\.1:4096\//u);
});

test("provider discovery is stable, deduplicated, allowlisted, and has no first-model fallback", async () => {
  const calls: string[] = [];
  const adapter = new HttpOpenCodeAdapter({
    baseUrl: "http://127.0.0.1:4096",
    allowedProviders: ["provider-z", "provider-a"],
    fetch: async (input) => {
      const path = new URL(String(input)).pathname;
      calls.push(path);
      if (path === "/global/health") return Response.json({ healthy: true, version: "test" });
      return Response.json({ providers: [
        { id: "provider-z", models: { "model-2": {}, "model-1": {} } },
        { id: "provider-a", models: ["model-x", "model-x"] },
        { id: "provider-disallowed", models: { model: {} } },
      ] });
    },
  });
  assert.deepEqual(await adapter.discoverProviderModels(), [
    { providerId: "provider-a", modelId: "model-x", qualifiedId: "provider-a/model-x" },
    { providerId: "provider-z", modelId: "model-1", qualifiedId: "provider-z/model-1" },
    { providerId: "provider-z", modelId: "model-2", qualifiedId: "provider-z/model-2" },
  ]);
  const readiness = await adapter.initialize();
  assert.equal(readiness.status, "error");
  assert.equal(readiness.lastError?.code, "opencode_model_unconfigured");
  assert.equal(calls.filter((path) => path === "/config/providers").length, 1, "initialize must not discover or select a fallback without explicit model");
});

test("adapter sends every A2 prompt with its explicit provider/model and disabled built-ins", async () => {
  const bodies: any[] = [];
  let userMessageId = "";
  const adapter = new HttpOpenCodeAdapter({
    baseUrl: "http://127.0.0.1:4096",
    allowedProviders: ["provider-z"],
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/prompt_async")) {
        const body = JSON.parse(String(init?.body));
        bodies.push(body);
        userMessageId = body.messageID;
        return new Response(null, { status: 204 });
      }
      return Response.json([{ info: { id: "ok", role: "assistant", parentID: userMessageId }, parts: [{ type: "text", text: "assistant answer" }] }]);
    },
  });
  await adapter.promptWithModel("opaque-session", { providerId: "provider-z", modelId: "model-2" }, { text: "hello", system: "bounded", attachments: [] });
  assert.deepEqual(bodies[0].model, { providerID: "provider-z", modelID: "model-2" });
  assert.equal(bodies[0].tools["*"], false);
  assert.equal(Object.values(bodies[0].tools).every((value) => value === false), true);
});

test("adapter binds one uniquely named scoped MCP and enables only that server for the prompt", async () => {
  const calls: Array<{ path: string; body: any }> = [];
  let userMessageId = "";
  const adapter = new HttpOpenCodeAdapter({
    baseUrl: "http://127.0.0.1:4096",
    allowedProviders: ["provider-z"],
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ path, body });
      if (path === "/mcp" || path.endsWith("/disconnect")) return Response.json({});
      if (path.endsWith("/prompt_async")) { userMessageId = body.messageID; return new Response(null, { status: 204 }); }
      return Response.json([{ info: { id: "ok", role: "assistant", parentID: userMessageId }, parts: [{ type: "text", text: "scoped answer" }] }]);
    },
  });
  const scopeId = "turn_scoped_binding";
  await adapter.bindScopedMcp(scopeId, "http://127.0.0.1:8787/a2/mcp?cap=opaque-capability");
  await adapter.promptWithModel("opaque-session", { providerId: "provider-z", modelId: "model-2" }, {
    text: "change", system: "bounded", attachments: [], scopedMcpScopeId: scopeId,
  });
  await adapter.unbindScopedMcp(scopeId);

  const registration = calls.find((call) => call.path === "/mcp")!;
  assert.match(registration.body.name, /^riffa2[0-9a-f]{24}$/u);
  assert.equal(registration.body.config.url, "http://127.0.0.1:8787/a2/mcp?cap=opaque-capability");
  const prompt = calls.find((call) => call.path.endsWith("/prompt_async"))!.body;
  assert.equal(prompt.tools["*"], false);
  assert.equal(prompt.tools[`${registration.body.name}_*`], true);
  assert.ok(calls.some((call) => call.path === `/mcp/${registration.body.name}/disconnect`));
  await assert.rejects(() => adapter.promptWithModel("opaque-session", { providerId: "provider-z", modelId: "model-2" }, {
    text: "stale", system: "bounded", attachments: [], scopedMcpScopeId: scopeId,
  }), (error: any) => error.code === "opencode_mcp_unbound");
  await assert.rejects(() => adapter.bindScopedMcp("turn_external", "http://example.com/a2/mcp?cap=x"), /capability-scoped local/u);
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

test("adapter ignores a stale assistant and waits for the response parented to this prompt", async () => {
  let requestedMessageId = "";
  let polls = 0;
  const adapter = new HttpOpenCodeAdapter({
    baseUrl: "http://127.0.0.1:4096",
    allowedProviders: ["provider-z"],
    fetch: async (input, init) => {
      if (new URL(String(input)).pathname.endsWith("/prompt_async")) {
        requestedMessageId = JSON.parse(String(init?.body)).messageID;
        return new Response(null, { status: 204 });
      }
      polls += 1;
      const messages: any[] = [{ info: { id: "stale", role: "assistant", parentID: "older-user" }, parts: [{ type: "text", text: "old answer" }] }];
      if (polls > 1) messages.push({ info: { id: "fresh", role: "assistant", parentID: requestedMessageId }, parts: [{ type: "text", text: "new answer" }] });
      return Response.json(messages);
    },
  });
  const result = await adapter.promptWithModel("opaque-session", { providerId: "provider-z", modelId: "model-2" }, { text: "next", system: "bounded", attachments: [] });
  assert.equal(result.text, "new answer");
  assert.equal(polls, 2);
});

test("adapter waits past a tool-only assistant segment for the final text segment", async () => {
  let requestedMessageId = "";
  let polls = 0;
  const adapter = new HttpOpenCodeAdapter({
    baseUrl: "http://127.0.0.1:4096",
    allowedProviders: ["provider-z"],
    fetch: async (input, init) => {
      if (new URL(String(input)).pathname.endsWith("/prompt_async")) {
        requestedMessageId = JSON.parse(String(init?.body)).messageID;
        return new Response(null, { status: 204 });
      }
      polls += 1;
      const messages: any[] = [{ info: { id: "tool-segment", role: "assistant", parentID: requestedMessageId }, parts: [{ type: "tool", tool: "riff_read_owner_summary" }] }];
      if (polls > 1) messages.push({ info: { id: "final-segment", role: "assistant", parentID: requestedMessageId }, parts: [{ type: "text", text: "final answer" }] });
      return Response.json(messages);
    },
  });
  const result = await adapter.promptWithModel("opaque-session", { providerId: "provider-z", modelId: "model-2" }, { text: "next", system: "bounded", attachments: [] });
  assert.equal(result.text, "final answer");
  assert.equal(result.messageId, "final-segment");
  assert.equal(polls, 2);
});

test("session manager reuses one available session per conversation", async () => {
  const repository = new MemoryRepository();
  repository.runtime.session = { generation: 3, state: "available", externalSessionRef: "external-one" };
  const openCode = new FakeConversationOpenCode();
  openCode.existing.add("external-one");
  const manager = new AgentConversationSessionManager(repository, openCode);
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

test("a second named conversation receives an independent external session", async () => {
  const repository = new MemoryRepository();
  const openCode = new FakeConversationOpenCode();
  const manager = new AgentConversationSessionManager(repository, openCode);
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
  const manager = new AgentConversationSessionManager(repository, openCode, { maxBytes: 512 });
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
  const manager = new AgentConversationSessionManager(repository, openCode);
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
    const result = await new AgentConversationSessionManager(repository, openCode).prompt("conversation-a", context(), "must not be sent");
    assert.deepEqual(result, { mode: "read_only", conversationId: "conversation-a", reason, retryable: true });
    assert.equal(openCode.created.length, 0);
    assert.equal(openCode.prompts.length, 0);
  }
  const repository = new MemoryRepository();
  const openCode = new FakeConversationOpenCode();
  openCode.failCreate = new Error("down");
  const result = await new AgentConversationSessionManager(repository, openCode).prompt("conversation-a", context(), "must not be sent");
  assert.deepEqual(result, { mode: "read_only", conversationId: "conversation-a", reason: "session_rebuild_failed", retryable: true });
  assert.equal(openCode.prompts.length, 0);
  assert.equal(repository.failed.length, 1);
});
