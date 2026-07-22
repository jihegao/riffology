import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BackendApp } from "../src/server.ts";
import { UnavailableMesaAdapter } from "../src/mesa-adapter.ts";
import type { OpenCodeAdapter, OpenCodeAssistantResponse, OpenCodeConversationPort, OpenCodePrompt, OpenCodeProviderModel, OpenCodeReadiness } from "../src/opencode-adapter.ts";

class ApiOpenCode implements OpenCodeAdapter, OpenCodeConversationPort {
  catalogue: OpenCodeProviderModel[] = [{ providerId: "provider-a", modelId: "model-a", qualifiedId: "provider-a/model-a" }];
  sessions = new Set<string>();
  created: Array<{ conversationId: string; sessionId: string }> = [];
  injections: Array<{ sessionId: string; text: string }> = [];
  prompts: Array<{ sessionId: string; binding: { providerId: string; modelId: string }; text: string }> = [];
  assistantText = "A real normalized assistant response.";
  discoveryError?: Error;

  async initialize(): Promise<OpenCodeReadiness> { return { status: "ready", modelId: "provider-a/model-a", version: "test" }; }
  async discoverProviderModels() { if (this.discoveryError) throw this.discoveryError; return this.catalogue; }
  async getSession(sessionId: string) { return this.sessions.has(sessionId); }
  async createSession(conversationId: string) {
    const sessionId = `opaque-session-${this.created.length + 1}`;
    this.created.push({ conversationId, sessionId });
    this.sessions.add(sessionId);
    return sessionId;
  }
  async injectContext(sessionId: string, text: string) { this.injections.push({ sessionId, text }); }
  async promptWithModel(sessionId: string, binding: { providerId: string; modelId: string }, prompt: OpenCodePrompt): Promise<OpenCodeAssistantResponse> {
    this.prompts.push({ sessionId, binding, text: prompt.text });
    if (!this.assistantText) {
      const error: any = new Error("OpenCode returned no assistant text.");
      error.status = 502; error.code = "opencode_empty_response";
      throw error;
    }
    return { messageId: `upstream-${this.prompts.length}`, text: this.assistantText, content: { source: "opencode", textParts: 1 } };
  }
  async prompt() {}
  async abort() {}
}

const start = async (base: string, openCode: ApiOpenCode) => {
  await mkdir(join(base, "legacy"), { mode: 0o700, recursive: true });
  const app = new BackendApp({
    mesa: new UnavailableMesaAdapter(),
    openCode,
    a2OpenCode: openCode,
    a2ProductRoot: join(base, "product"),
    workspaceRoot: join(base, "legacy"),
    defaultSessionId: "legacy-test",
  });
  await app.initialize();
  const address = await app.listen();
  return { app, baseUrl: `http://127.0.0.1:${address.port}` };
};

const post = (url: string, body: unknown) => fetch(url, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const createModel = async (baseUrl: string, commandId = "create-model-a") => {
  const response = await post(`${baseUrl}/api/models`, { commandId, name: "Generic Model", providerId: "provider-a", modelId: "model-a" });
  assert.equal(response.status, 201);
  return response.json() as Promise<any>;
};

test("A2 providers, atomic Model creation, conversations, live turn, and public secrecy", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "riff-a2-api-"));
  const openCode = new ApiOpenCode();
  const { app, baseUrl } = await start(base, openCode);
  t.after(async () => { await app.close(); await rm(base, { recursive: true, force: true }); });

  const providers = await (await fetch(`${baseUrl}/api/providers`)).json() as any;
  assert.deepEqual(providers, { mode: "live", providerModels: openCode.catalogue });

  const html = await (await fetch(`${baseUrl}/a2`)).text();
  assert.match(html, /Milestone A2 technical acceptance surface/u);
  assert.match(html, /not the Milestone A shared product shell/u);
  assert.doesNotMatch(html, /externalSessionRef|opaque-session|authorization|password|capability/u);

  const created = await createModel(baseUrl);
  assert.equal(created.model.name, "Generic Model");
  assert.equal(created.model.technicalStatus, "draft");
  assert.deepEqual(Object.keys(created.model).sort(), ["createdAt", "id", "lifecycleState", "name", "runMode", "technicalStatus", "updatedAt"]);
  const retry = await createModel(baseUrl);
  assert.deepEqual(retry, created);

  const unknown = await post(`${baseUrl}/api/models`, { commandId: "bad", name: "Bad", providerId: "provider-a", modelId: "model-a", workspacePath: "/tmp/leak" });
  assert.equal(unknown.status, 422);
  assert.equal((await unknown.json() as any).error.code, "unknown_field");

  const ownerUrl = `${baseUrl}/api/objects/model/${created.model.id}/conversations`;
  const listed = await (await fetch(ownerUrl)).json() as any;
  assert.deepEqual(listed.conversations.map((item: any) => item.id), [created.conversation.id]);
  const detail = await (await fetch(`${baseUrl}/api/conversations/${created.conversation.id}`)).json() as any;
  assert.equal(detail.sessionState, "none");

  const turnResponse = await post(`${baseUrl}/api/conversations/${created.conversation.id}/turns`, {
    requestKey: "turn-a", text: "Describe the generic model.", attachmentIds: [],
  });
  assert.equal(turnResponse.status, 200);
  const turn = await turnResponse.json() as any;
  assert.equal(turn.mode, "live");
  assert.equal(turn.turn.state, "complete");
  assert.equal(turn.messages.at(-1).text, openCode.assistantText);
  assert.deepEqual(openCode.prompts[0].binding, { providerId: "provider-a", modelId: "model-a" });
  assert.equal(openCode.created.length, 1);

  const retryTurn = await post(`${baseUrl}/api/conversations/${created.conversation.id}/turns`, {
    requestKey: "turn-a", text: "Describe the generic model.", attachmentIds: [],
  });
  assert.equal(retryTurn.status, 200);
  assert.equal(openCode.prompts.length, 1, "durable completed turn retry must not call OpenCode again");

  const publicText = JSON.stringify({ created, detail, turn: await retryTurn.json() });
  assert.doesNotMatch(publicText, /opaque-session|externalSessionRef|workspacePath|authorization|password|capability/u);
});

test("two conversations keep independent sessions and a missing session rebuilds", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "riff-a2-sessions-"));
  const openCode = new ApiOpenCode();
  const { app, baseUrl } = await start(base, openCode);
  t.after(async () => { await app.close(); await rm(base, { recursive: true, force: true }); });
  const created = await createModel(baseUrl);
  const ownerUrl = `${baseUrl}/api/objects/model/${created.model.id}/conversations`;
  const secondResponse = await post(ownerUrl, { commandId: "second-conversation", name: "Independent", providerId: "provider-a", modelId: "model-a" });
  assert.equal(secondResponse.status, 201);
  const second = await secondResponse.json() as any;

  for (const [conversationId, key] of [[created.conversation.id, "first-turn"], [second.id, "second-turn"]]) {
    const response = await post(`${baseUrl}/api/conversations/${conversationId}/turns`, { requestKey: key, text: "Hello", attachmentIds: [] });
    assert.equal(response.status, 200);
  }
  assert.equal(openCode.created.length, 2);
  assert.notEqual(openCode.created[0].sessionId, openCode.created[1].sessionId);

  openCode.sessions.delete(openCode.created[0].sessionId);
  const rebuilt = await post(`${baseUrl}/api/conversations/${created.conversation.id}/turns`, { requestKey: "after-loss", text: "Continue", attachmentIds: [] });
  assert.equal(rebuilt.status, 200);
  assert.equal(openCode.created.length, 3);
  assert.equal(openCode.created[2].conversationId, created.conversation.id);
  assert.equal(openCode.injections.length, 3);
});

test("restart preserves completed transcript while provider loss persists a failed read-only turn", async () => {
  const base = await mkdtemp(join(tmpdir(), "riff-a2-restart-"));
  const openCode = new ApiOpenCode();
  const first = await start(base, openCode);
  const created = await createModel(first.baseUrl);
  const complete = await post(`${first.baseUrl}/api/conversations/${created.conversation.id}/turns`, { requestKey: "before-restart", text: "Persist me", attachmentIds: [] });
  assert.equal(complete.status, 200);
  await first.app.close();

  const second = await start(base, openCode);
  try {
    const messages = await (await fetch(`${second.baseUrl}/api/conversations/${created.conversation.id}/messages`)).json() as any;
    assert.deepEqual(messages.messages.map((message: any) => message.role), ["user", "assistant"]);
    openCode.catalogue = [];
    const readOnly = await post(`${second.baseUrl}/api/conversations/${created.conversation.id}/turns`, { requestKey: "offline-turn", text: "Do not fake a reply", attachmentIds: [] });
    assert.equal(readOnly.status, 503);
    const payload = await readOnly.json() as any;
    assert.equal(payload.mode, "read_only");
    assert.equal(payload.reason, "provider_unavailable");
    assert.equal(payload.turn.state, "failed");
    assert.equal(payload.messages.at(-1).role, "user");
    assert.equal(payload.messages.some((message: any) => /canned|simulated reply/u.test(message.text)), false);
  } finally {
    await second.app.close();
    await rm(base, { recursive: true, force: true });
  }
});

test("an empty synchronous OpenCode response fails durably without assistant fabrication", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "riff-a2-empty-"));
  const openCode = new ApiOpenCode();
  const { app, baseUrl } = await start(base, openCode);
  t.after(async () => { await app.close(); await rm(base, { recursive: true, force: true }); });
  const created = await createModel(baseUrl);
  openCode.assistantText = "";
  const response = await post(`${baseUrl}/api/conversations/${created.conversation.id}/turns`, { requestKey: "empty-answer", text: "Answer", attachmentIds: [] });
  assert.equal(response.status, 503);
  const payload = await response.json() as any;
  assert.equal(payload.turn.state, "failed");
  assert.equal(payload.messages.length, 1);
  assert.equal(payload.messages[0].role, "user");
});
