import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentConversationSessionManager, type AgentSessionRepositoryPort, type DurableConversationRuntime } from "../src/agent-session-manager.ts";
import type { AgentContextInput } from "../src/agent-context.ts";
import { HttpOpenCodeAdapter, type OpenCodeConfig, type OpenCodeConversationPort, type OpenCodePrompt, type OpenCodeProviderModel } from "../src/opencode-adapter.ts";

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
  aborted: string[] = [];
  createDelay?: Promise<void>;
  failDiscovery?: Error;
  failCreate?: Error;
  failPrompt?: Error;

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
  async promptWithModel(sessionId: string, binding: { providerId: string; modelId: string }, prompt: OpenCodePrompt) {
    this.prompts.push({ sessionId, binding, prompt });
    if (this.failPrompt) throw this.failPrompt;
  }
  async abort(sessionId: string) { this.aborted.push(sessionId); }
}

const readyAdapter = async (t: any, config: OpenCodeConfig): Promise<HttpOpenCodeAdapter> => {
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
      return behavior(input, init);
    },
  });
  assert.equal((await adapter.initialize()).status, "ready");
  return adapter;
};

test("adapter accepts only credential-free loopback HTTP base URLs", () => {
  assert.doesNotThrow(() => new HttpOpenCodeAdapter({ baseUrl: "http://127.0.0.1:4096" }));
  assert.doesNotThrow(() => new HttpOpenCodeAdapter({ baseUrl: "http://localhost:4096" }));
  assert.doesNotThrow(() => new HttpOpenCodeAdapter({ baseUrl: "http://[::1]:4096" }));
  for (const unsafe of [
    "https://127.0.0.1:4096", "http://example.com", "http://user:secret@127.0.0.1:4096",
    "http://127.0.0.1:4096/path", "http://127.0.0.1:4096?target=remote",
  ]) assert.throws(() => new HttpOpenCodeAdapter({ baseUrl: unsafe }), /loopback HTTP URL|unauthenticated|path/u);
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
  assert.deepEqual(calls.map((call) => new URL(call.url).pathname), ["/global/health", "/path", "/config/providers", "/config/providers"]);
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

test("adapter sends every A2 prompt with its explicit provider/model and disabled built-ins", async (t) => {
  const bodies: any[] = [];
  let prompted = false;
  const adapter = await readyAdapter(t, {
    allowedProviders: ["provider-z"],
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
        { info: { id: "ok", role: "assistant", parentID: "server-user" }, parts: [{ type: "text", text: "assistant answer" }] },
      ] : []);
    },
  });
  await adapter.promptWithModel("opaque-session", { providerId: "provider-z", modelId: "model-2" }, { text: "hello", system: "bounded", attachments: [] });
  assert.deepEqual(bodies[0].model, { providerID: "provider-z", modelID: "model-2" });
  assert.equal("messageID" in bodies[0], false);
  assert.equal(bodies[0].tools["*"], false);
  assert.equal(Object.values(bodies[0].tools).every((value) => value === false), true);
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
          { info: { id: `assistant-${promptNumber}`, role: "assistant", parentID: userId }, parts: [{ type: "text", text: `answer-${promptNumber}` }] },
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
  const adapter = await readyAdapter(t, {
    allowedProviders: ["provider-z"],
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ path, body });
      if (path === "/mcp" || path.endsWith("/disconnect")) return Response.json({});
      if (path.endsWith("/prompt_async")) { prompted = true; return new Response(null, { status: 204 }); }
      return Response.json(prompted ? [
        { info: { id: "server-user", role: "user" }, parts: [{ type: "text", text: "change" }] },
        { info: { id: "ok", role: "assistant", parentID: "server-user" }, parts: [{ type: "text", text: "scoped answer" }] },
      ] : []);
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
      if (polls > 2) messages.push({ info: { id: "fresh", role: "assistant", parentID: "server-user" }, parts: [{ type: "text", text: "new answer" }] });
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
        { info: { id: "tool-segment", role: "assistant", parentID: "server-user" }, parts: [{ type: "tool", tool: "riff_read_owner_summary" }] },
      ] : [];
      if (polls > 2) messages.push({ info: { id: "final-segment", role: "assistant", parentID: "server-user" }, parts: [{ type: "text", text: "final answer" }] });
      return Response.json(messages);
    },
  });
  const result = await adapter.promptWithModel("opaque-session", { providerId: "provider-z", modelId: "model-2" }, { text: "next", system: "bounded", attachments: [] });
  assert.equal(result.text, "final answer");
  assert.equal(result.messageId, "final-segment");
  assert.equal(polls, 3);
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

test("a failed prompt retires its session before the next turn rebuilds", async () => {
  const repository = new MemoryRepository();
  repository.runtime.session = { generation: 3, state: "available", externalSessionRef: "external-one" };
  const openCode = new FakeConversationOpenCode();
  openCode.existing.add("external-one");
  openCode.failPrompt = new Error("timed out after OpenCode accepted the prompt");
  const manager = new AgentConversationSessionManager(repository, openCode);

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
