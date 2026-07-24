import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BackendApp } from "../src/server.ts";
import { planExperiment } from "../src/experiment-planner.ts";
import { UnavailableMesaAdapter } from "../src/mesa-adapter.ts";
import type { OpenCodeAdapter, OpenCodeAssistantResponse, OpenCodeConversationPort, OpenCodePrompt, OpenCodeProviderModel, OpenCodeReadiness } from "../src/opencode-adapter.ts";
import { captureWorkspaceDigest, executionDescriptionDigest, validateExecutionDescription } from "../src/model-workspace.ts";
import type { ModelTechnicalCheckerPort } from "../src/model-technical-check-service.ts";

class ApiOpenCode implements OpenCodeAdapter, OpenCodeConversationPort {
  catalogue: OpenCodeProviderModel[] = [{ providerId: "provider-a", modelId: "model-a", qualifiedId: "provider-a/model-a" }];
  sessions = new Set<string>();
  created: Array<{ conversationId: string; sessionId: string }> = [];
  injections: Array<{ sessionId: string; text: string }> = [];
  prompts: Array<{ sessionId: string; binding: { providerId: string; modelId: string }; text: string }> = [];
  assistantText = "A real normalized assistant response.";
  discoveryError?: Error;
  scopedBindings = new Map<string, string>();
  scopedUrls: string[] = [];
  unboundScopes: string[] = [];
  executeScopedMutation = false;

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
    if (this.executeScopedMutation) {
      const scopeId = prompt.scopedMcpScopeId;
      const mcpUrl = scopeId ? this.scopedBindings.get(scopeId) : undefined;
      assert.ok(mcpUrl, "a scoped MCP binding must be active before the prompt");
      const rpc = async (body: unknown) => {
        const response = await post(mcpUrl, body);
        assert.equal(response.status, 200);
        return await response.json() as any;
      };
      const listed = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
      assert.ok(listed.result.tools.some((tool: any) => tool.name === "riff_apply_model_changes"));
      const workspace = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "riff_list_model_workspace", arguments: {} } });
      const files = JSON.parse(workspace.result.content[0].text);
      const code = files.find((file: any) => file.kind === "model_code");
      const changed = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "riff_apply_model_changes", arguments: {
        requestKey: "fake-opencode-scoped-change",
        changes: [{ objectFileId: code.id, kind: code.kind, relativePath: code.relativePath, mediaType: code.mediaType,
          text: "print('scoped MCP')\n", expectedPriorSha256: code.sha256 }],
      } } });
      assert.equal(changed.result.isError, undefined, JSON.stringify(changed));
    }
    if (!this.assistantText) {
      const error: any = new Error("OpenCode returned no assistant text.");
      error.status = 502; error.code = "opencode_empty_response";
      throw error;
    }
    return { messageId: `upstream-${this.prompts.length}`, text: this.assistantText, content: { source: "opencode", textParts: 1 } };
  }
  async prompt() {}
  async abort() {}
  async bindScopedMcp(scopeId: string, mcpUrl: string) { this.scopedBindings.set(scopeId, mcpUrl); this.scopedUrls.push(mcpUrl); }
  async unbindScopedMcp(scopeId: string) { this.scopedBindings.delete(scopeId); this.unboundScopes.push(scopeId); }
}

class ApiTechnicalChecker implements ModelTechnicalCheckerPort {
  calls = 0;
  roots: string[] = [];
  descriptions: unknown[] = [];
  async check(input: Parameters<ModelTechnicalCheckerPort["check"]>[0]) {
    this.calls += 1;
    this.roots.push(input.workspace.root);
    this.descriptions.push(structuredClone(input.executionDescription));
    const captured = captureWorkspaceDigest(input.workspace);
    const description = validateExecutionDescription(input.executionDescription);
    return {
      attemptId: `fake_${this.calls}`, aggregate: "executable" as const, capturedWorkspaceDigest: captured.digest,
      executionDescriptionDigest: executionDescriptionDigest(description), dependencyDescriptionDigest: "a".repeat(64), environmentKey: `python-${"a".repeat(64)}`,
      startedAt: "2026-07-22T00:00:00.000Z", finishedAt: "2026-07-22T00:00:01.000Z",
      limits: { timeoutMs: 1, maxOutputBytes: 1000, maxWorkspaceFiles: 20, maxWorkspaceBytes: 100000 },
      checks: [{ name: "smoke" as const, state: "passed" as const, code: "smoke_passed", detail: "Private workspace passed." }], log: "private log",
    };
  }
}

const start = async (
  base: string,
  openCode: ApiOpenCode,
  technicalChecker: ModelTechnicalCheckerPort = new ApiTechnicalChecker(),
) => {
  await mkdir(join(base, "legacy"), { mode: 0o700, recursive: true });
  const app = new BackendApp({
    mesa: new UnavailableMesaAdapter(),
    openCode,
    a2OpenCode: openCode,
    a2ProductRoot: join(base, "product"),
    a2TechnicalChecker: technicalChecker,
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
const patch = (url: string, body: unknown) => fetch(url, {
  method: "PATCH",
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

  const attachmentResponse = await post(`${baseUrl}/api/conversations/${created.conversation.id}/attachments`, {
    commandId: "attachment-a", originalName: "inputs.json", mediaType: "application/json",
    base64: Buffer.from('{"rate":2}').toString("base64"), purpose: "turn input",
  });
  assert.equal(attachmentResponse.status, 201);
  const attachment = await attachmentResponse.json() as any;
  assert.equal(attachment.originalName, "inputs.json");
  assert.doesNotMatch(JSON.stringify(attachment), /\/Users\/|externalSessionRef|capability/u);
  const attachmentConflict = await post(`${baseUrl}/api/conversations/${created.conversation.id}/attachments`, {
    commandId: "attachment-a", originalName: "inputs.json", mediaType: "application/json",
    base64: Buffer.from('{"rate":2}').toString("base64"), purpose: "different intent",
  });
  assert.equal(attachmentConflict.status, 409);
  assert.equal((await attachmentConflict.json() as any).error.code, "idempotency_conflict");
  const documents = await (await fetch(`${baseUrl}/api/conversations/${created.conversation.id}/documents`)).json() as any;
  assert.deepEqual(documents, { documents: [] });

  const turnResponse = await post(`${baseUrl}/api/conversations/${created.conversation.id}/turns`, {
    requestKey: "turn-a", text: "Describe the generic model.", attachmentIds: [attachment.id],
  });
  assert.equal(turnResponse.status, 200);
  const turn = await turnResponse.json() as any;
  assert.equal(turn.mode, "live");
  assert.equal(turn.turn.state, "complete");
  assert.equal(turn.messages.at(-1).text, openCode.assistantText);
  assert.deepEqual(openCode.prompts[0].binding, { providerId: "provider-a", modelId: "model-a" });
  assert.equal(openCode.created.length, 1);

  const retryTurn = await post(`${baseUrl}/api/conversations/${created.conversation.id}/turns`, {
    requestKey: "turn-a", text: "Describe the generic model.", attachmentIds: [attachment.id],
  });
  assert.equal(retryTurn.status, 200);
  assert.equal(openCode.prompts.length, 1, "durable completed turn retry must not call OpenCode again");

  const publicText = JSON.stringify({ created, detail, turn: await retryTurn.json() });
  assert.doesNotMatch(publicText, /opaque-session|externalSessionRef|workspacePath|authorization|password|capability/u);
});

test("A2 turn binds one capability-scoped MCP endpoint through tools/list and atomic model mutation", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "riff-a2-scoped-mcp-"));
  const openCode = new ApiOpenCode();
  const { app, baseUrl } = await start(base, openCode);
  t.after(async () => { await app.close(); await rm(base, { recursive: true, force: true }); });
  const created = await createModel(baseUrl, "scoped-mcp-model");
  openCode.executeScopedMutation = true;

  const response = await post(`${baseUrl}/api/conversations/${created.conversation.id}/turns`, {
    requestKey: "scoped-mcp-turn", text: "Update the model file now", attachmentIds: [],
  });
  assert.equal(response.status, 200, await response.clone().text());
  const payload = await response.json() as any;
  assert.equal(payload.mode, "live");
  assert.equal(openCode.scopedBindings.size, 0);
  assert.equal(openCode.unboundScopes.length, 1);
  assert.equal(openCode.scopedUrls.length, 1);
  assert.doesNotMatch(JSON.stringify(payload), /cap=|capability|externalSessionRef|workspacePath|opaque-session/u);

  const code = app.productStore!.listObjectFiles({ kind: "model", id: created.model.id }).find((file) => file.kind === "model_code")!;
  assert.equal(app.productStore!.readObjectFile(code.id).toString("utf8"), "print('scoped MCP')\n");
  assert.equal(payload.turn.actions[0]?.state, "committed");

  const expired = await post(openCode.scopedUrls[0]!, { jsonrpc: "2.0", id: 4, method: "tools/list" });
  assert.equal(expired.status, 200);
  assert.equal((await expired.json() as any).error.code, -32001);
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

test("Model workspace projection and technical-check start/read are digest-bound and path-safe", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "riff-a2-technical-check-"));
  const openCode = new ApiOpenCode();
  const checker = new ApiTechnicalChecker();
  const { app, baseUrl } = await start(base, openCode, checker);
  t.after(async () => { await app.close(); await rm(base, { recursive: true, force: true }); });
  const created = await createModel(baseUrl, "technical-model");

  const workspaceResponse = await fetch(`${baseUrl}/api/models/${created.model.id}/workspace`);
  assert.equal(workspaceResponse.status, 200);
  const workspace = await workspaceResponse.json() as any;
  assert.equal(workspace.model.technicalStatus, "draft");
  assert.match(workspace.digest, /^[0-9a-f]{64}$/u);
  assert.equal(workspace.files.some((file: any) => file.relativePath === "code/model.py"), true);
  assert.deepEqual(Object.keys(workspace.files[0]).sort(), ["id", "kind", "mediaType", "relativePath", "sha256", "sizeBytes"]);

  const startedResponse = await post(`${baseUrl}/api/models/${created.model.id}/technical-checks`, { commandId: "check-once" });
  assert.equal(startedResponse.status, 200);
  const started = await startedResponse.json() as any;
  assert.equal(started.state, "passed");
  assert.equal(started.aggregate, "executable");
  assert.equal(started.publication, "published");
  assert.equal(started.capturedWorkspaceDigest, workspace.digest);
  assert.equal(started.claim, "technical_execution_only");
  assert.equal(checker.calls, 1);

  const readResponse = await fetch(`${baseUrl}/api/models/${created.model.id}/technical-checks/${started.id}`);
  assert.equal(readResponse.status, 200);
  const read = await readResponse.json() as any;
  assert.deepEqual(read, started);
  const retry = await post(`${baseUrl}/api/models/${created.model.id}/technical-checks`, { commandId: "check-once" });
  assert.equal(retry.status, 200);
  assert.deepEqual(await retry.json(), started);
  assert.equal(checker.calls, 1, "same commandId must return durable evidence without rerunning the checker");

  const publicText = JSON.stringify({ workspace, started, read });
  assert.doesNotMatch(publicText, /riff-model-owned-check|\/private\/|\/Users\/|workspacePath|capabilityId|private log/u);
  assert.equal(checker.roots.every((root) => !publicText.includes(root)), true);
});

test("A3 New project creates a fixed Model copy and exposes a sanitized workspace", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "riff-a3-project-api-"));
  const openCode = new ApiOpenCode();
  const checker = new ApiTechnicalChecker();
  const { app, baseUrl } = await start(base, openCode, checker);
  t.after(async () => { await app.close(); await rm(base, { recursive: true, force: true }); });
  const created = await createModel(baseUrl, "a3-source-model");

  const draftProject = await post(`${baseUrl}/api/projects`, { commandId: "project-from-draft", name: "Rejected", modelId: created.model.id });
  assert.equal(draftProject.status, 409);
  assert.equal((await draftProject.json() as any).error.code, "state_conflict");

  const check = await post(`${baseUrl}/api/models/${created.model.id}/technical-checks`, { commandId: "publish-source-model" });
  assert.equal(check.status, 200);
  assert.equal((await check.json() as any).publication, "published");

  const unknownField = await post(`${baseUrl}/api/projects`, {
    commandId: "bad-project", name: "Bad", modelId: created.model.id, workspacePath: "/tmp/leak",
  });
  assert.equal(unknownField.status, 422);
  assert.equal((await unknownField.json() as any).error.code, "unknown_field");

  const projectResponse = await post(`${baseUrl}/api/projects`, { commandId: "new-project", name: "Scenario Project", modelId: created.model.id });
  assert.equal(projectResponse.status, 201, await projectResponse.clone().text());
  const project = await projectResponse.json() as any;
  assert.equal(project.project.name, "Scenario Project");
  assert.equal(project.project.sourceModelId, created.model.id);
  assert.match(project.project.modelSnapshotDigest, /^[0-9a-f]{64}$/u);
  assert.deepEqual(Object.keys(project.project).sort(), ["createdAt", "id", "lifecycleState", "modelSnapshotDigest", "name", "sourceModelId", "updatedAt"]);

  const retry = await post(`${baseUrl}/api/projects`, { commandId: "new-project", name: "Scenario Project", modelId: created.model.id });
  assert.equal(retry.status, 201);
  assert.deepEqual(await retry.json(), project);
  const conflict = await post(`${baseUrl}/api/projects`, { commandId: "new-project", name: "Different", modelId: created.model.id });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json() as any).error.code, "idempotency_conflict");

  const workspaceResponse = await fetch(`${baseUrl}/api/projects/${project.project.id}/workspace`);
  assert.equal(workspaceResponse.status, 200);
  const workspace = await workspaceResponse.json() as any;
  assert.deepEqual(workspace.project, project.project);
  assert.equal(workspace.files.length > 0, true);
  assert.equal(workspace.files.every((file: any) =>
    JSON.stringify(Object.keys(file).sort()) === JSON.stringify(["createdAt", "id", "mediaType", "sha256", "sizeBytes"])), true);
  assert.deepEqual(workspace.conversations, []);
  assert.deepEqual(workspace.experimentConfigurations, []);
  assert.deepEqual(workspace.runs, []);

  const conversationResponse = await post(`${baseUrl}/api/objects/project/${project.project.id}/conversations`, {
    commandId: "project-conversation", name: "Project chat", providerId: "provider-a", modelId: "model-a",
  });
  assert.equal(conversationResponse.status, 201);
  const conversation = await conversationResponse.json() as any;
  assert.deepEqual(conversation.owner, { kind: "project", id: project.project.id });
  const workspaceWithConversation = await (await fetch(`${baseUrl}/api/projects/${project.project.id}/workspace`)).json() as any;
  assert.deepEqual(workspaceWithConversation.conversations.map((item: any) => item.id), [conversation.id]);

  const baselineConfiguration = {
    schemaVersion: 1,
    runKind: "batch",
    parameters: { stepLimit: 4, demand: 1 },
    sampling: {
      kind: "cartesian-sweep",
      axes: [{ pointer: "/demand", values: [1, 2, 3] }],
    },
  };
  const experimentResponse = await post(`${baseUrl}/api/projects/${project.project.id}/experiment-configs`, {
    commandId: "create-experiment",
    name: "Baseline",
    configuration: baselineConfiguration,
  });
  assert.equal(experimentResponse.status, 201, await experimentResponse.clone().text());
  const experiment = await experimentResponse.json() as any;
  assert.equal(experiment.name, "Baseline");
  assert.equal(experiment.projectId, project.project.id);
  assert.equal(experiment.contractVersion, 4);
  assert.equal(experiment.readOnly, false);
  assert.equal(experiment.sampleCount, 3);
  assert.equal(experiment.estimatedSampleCount, 3);
  assert.match(experiment.configurationDigest, /^[0-9a-f]{64}$/u);
  assert.match(experiment.recordDigest, /^[0-9a-f]{64}$/u);
  assert.deepEqual(experiment.configuration, baselineConfiguration);
  const experimentRetry = await post(`${baseUrl}/api/projects/${project.project.id}/experiment-configs`, {
    commandId: "create-experiment",
    name: "Baseline",
    configuration: baselineConfiguration,
  });
  assert.equal(experimentRetry.status, 201);
  assert.deepEqual(await experimentRetry.json(), experiment);
  const experimentConflict = await post(`${baseUrl}/api/projects/${project.project.id}/experiment-configs`, {
    commandId: "create-experiment",
    name: "Changed",
    configuration: { ...baselineConfiguration, sampling: { kind: "single" } },
  });
  assert.equal(experimentConflict.status, 409);
  assert.equal((await experimentConflict.json() as any).error.code, "idempotency_conflict");

  const duplicateSeed = await post(`${baseUrl}/api/projects/${project.project.id}/experiment-configs`, {
    commandId: "duplicate-seed",
    name: "Invalid duplicate seed",
    configuration: {
      schemaVersion: 1,
      runKind: "batch",
      parameters: { stepLimit: 4, demand: 1 },
      sampling: { kind: "multiple-seeds", seeds: [7, 7] },
    },
  });
  assert.equal(duplicateSeed.status, 400);
  assert.equal((await duplicateSeed.json() as any).error.code, "duplicate_sample_seed");

  const overlappingSweep = await post(`${baseUrl}/api/projects/${project.project.id}/experiment-configs`, {
    commandId: "overlapping-sweep",
    name: "Invalid overlap",
    configuration: {
      schemaVersion: 1,
      runKind: "batch",
      parameters: { stepLimit: 4, demand: 1 },
      sampling: {
        kind: "cartesian-sweep",
        axes: [
          { pointer: "/stepLimit", values: [2] },
          { pointer: "/stepLimit/value", values: [3] },
        ],
      },
    },
  });
  assert.equal(overlappingSweep.status, 400);
  assert.equal((await overlappingSweep.json() as any).error.code, "overlapping_sweep_pointer");

  const updatedConfiguration = {
    schemaVersion: 1,
    runKind: "batch",
    parameters: { stepLimit: 5, demand: 3 },
    sampling: {
      kind: "cartesian-sweep",
      axes: [{ pointer: "/demand", values: [10, 20] }],
      seeds: [1, 2],
    },
  };
  const missingUpdateDigest = await patch(`${baseUrl}/api/projects/${project.project.id}/experiment-configs/${experiment.id}`, {
    commandId: "missing-update-digest",
    name: "Missing CAS",
  });
  assert.equal(missingUpdateDigest.status, 422);
  assert.equal((await missingUpdateDigest.json() as any).error.code, "missing_field");

  const updateResponse = await patch(`${baseUrl}/api/projects/${project.project.id}/experiment-configs/${experiment.id}`, {
    commandId: "update-experiment",
    expectedConfigurationDigest: experiment.configurationDigest,
    expectedRecordDigest: experiment.recordDigest,
    configuration: updatedConfiguration,
  });
  assert.equal(updateResponse.status, 200, await updateResponse.clone().text());
  const updatedExperiment = await updateResponse.json() as any;
  assert.equal(updatedExperiment.name, "Baseline");
  assert.equal(updatedExperiment.sampleCount, 4);
  assert.equal(updatedExperiment.estimatedSampleCount, 4);
  assert.notEqual(updatedExperiment.configurationDigest, experiment.configurationDigest);
  assert.notEqual(updatedExperiment.recordDigest, experiment.recordDigest);
  assert.deepEqual(updatedExperiment.configuration, updatedConfiguration);
  const updateRetry = await patch(`${baseUrl}/api/projects/${project.project.id}/experiment-configs/${experiment.id}`, {
    commandId: "update-experiment",
    expectedConfigurationDigest: experiment.configurationDigest,
    expectedRecordDigest: experiment.recordDigest,
    configuration: updatedConfiguration,
  });
  assert.equal(updateRetry.status, 200);
  assert.deepEqual(await updateRetry.json(), updatedExperiment);
  const updateConflict = await patch(`${baseUrl}/api/projects/${project.project.id}/experiment-configs/${experiment.id}`, {
    commandId: "update-experiment",
    expectedConfigurationDigest: experiment.configurationDigest,
    expectedRecordDigest: experiment.recordDigest,
    configuration: { ...baselineConfiguration, sampling: { kind: "single", seed: 9 } },
  });
  assert.equal(updateConflict.status, 409);
  assert.equal((await updateConflict.json() as any).error.code, "idempotency_conflict");

  const staleUpdate = await patch(`${baseUrl}/api/projects/${project.project.id}/experiment-configs/${experiment.id}`, {
    commandId: "stale-experiment-update",
    expectedConfigurationDigest: experiment.configurationDigest,
    expectedRecordDigest: experiment.recordDigest,
    name: "Stale name",
  });
  assert.equal(staleUpdate.status, 409);
  assert.equal((await staleUpdate.json() as any).error.code, "stale_configuration");

  const renameAfterUpdateResponse = await patch(`${baseUrl}/api/projects/${project.project.id}/experiment-configs/${experiment.id}`, {
    commandId: "rename-after-update",
    expectedConfigurationDigest: updatedExperiment.configurationDigest,
    expectedRecordDigest: updatedExperiment.recordDigest,
    name: "Renamed after update",
  });
  assert.equal(renameAfterUpdateResponse.status, 200);
  const renamedAfterUpdate = await renameAfterUpdateResponse.json() as any;
  assert.equal(renamedAfterUpdate.name, "Renamed after update");

  const historicalPartialRetry = await patch(`${baseUrl}/api/projects/${project.project.id}/experiment-configs/${experiment.id}`, {
    commandId: "update-experiment",
    expectedConfigurationDigest: experiment.configurationDigest,
    expectedRecordDigest: experiment.recordDigest,
    configuration: updatedConfiguration,
  });
  assert.equal(historicalPartialRetry.status, 200);
  assert.deepEqual(await historicalPartialRetry.json(), updatedExperiment);

  const firstConcurrentNameResponse = await patch(`${baseUrl}/api/projects/${project.project.id}/experiment-configs/${experiment.id}`, {
    commandId: "first-concurrent-name",
    expectedConfigurationDigest: renamedAfterUpdate.configurationDigest,
    expectedRecordDigest: renamedAfterUpdate.recordDigest,
    name: "First concurrent name",
  });
  assert.equal(firstConcurrentNameResponse.status, 200);
  const firstConcurrentName = await firstConcurrentNameResponse.json() as any;
  assert.equal(firstConcurrentName.name, "First concurrent name");
  const lostConcurrentName = await patch(`${baseUrl}/api/projects/${project.project.id}/experiment-configs/${experiment.id}`, {
    commandId: "lost-concurrent-name",
    expectedConfigurationDigest: renamedAfterUpdate.configurationDigest,
    expectedRecordDigest: renamedAfterUpdate.recordDigest,
    name: "Lost concurrent name",
  });
  assert.equal(lostConcurrentName.status, 409);
  assert.equal((await lostConcurrentName.json() as any).error.code, "stale_record");

  const workspaceWithExperiment = await (await fetch(`${baseUrl}/api/projects/${project.project.id}/workspace`)).json() as any;
  assert.deepEqual(workspaceWithExperiment.experimentConfigurations.map((item: any) => ({ id: item.id, sampleCount: item.sampleCount })), [
    { id: experiment.id, sampleCount: 4 },
  ]);

  const sourceCode = app.productStore!.listObjectFiles({ kind: "model", id: created.model.id }).find((file) => file.kind === "model_code")!;
  const snapshotCode = app.productStore!.listObjectFiles({ kind: "project", id: project.project.id }).find((file) => file.relativePath.endsWith("code/model.py"))!;
  const frozenBytes = app.productStore!.readObjectFile(snapshotCode.id);
  app.productStore!.replaceModelFile(sourceCode.id, Buffer.from("print('changed after project')\n"), "2026-07-22T03:00:00.000Z");
  assert.equal(app.productStore!.readObjectFile(snapshotCode.id).equals(frozenBytes), true);

  const outputSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: { seed: { type: "integer" } },
    required: ["seed"],
    additionalProperties: false,
  };
  const outputExecutionDescription = {
    schemaVersion: 2,
    runtime: "python",
    runMode: "batch",
    dependencyFile: "environment/requirements.txt",
    inputs: {
      schemaProfile: "riff-json-schema-2020-12-v1",
      schema: outputSchema,
      smoke: { seed: 1 },
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
  };
  app.productStore!.createModel({
    id: "model_public_run_projection",
    name: "Public run projection",
    technicalStatus: "executable",
    runMode: "batch",
    executionDescription: outputExecutionDescription,
    createdAt: "2026-07-24T04:00:00.000Z",
    files: [
      {
        id: "file_public_run_model",
        kind: "model_code",
        relativePath: "model.py",
        mediaType: "text/x-python",
        bytes: Buffer.from(`from __future__ import annotations
import argparse
import json
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--riff-input", required=True, type=Path)
parser.add_argument("--riff-output-dir", required=True, type=Path)
args = parser.parse_args()
envelope = json.loads(args.riff_input.read_text(encoding="utf-8"))
target = args.riff_output_dir / "outputs" / "result.json"
target.parent.mkdir(parents=True, exist_ok=True)
payload = {
    "sampleIndex": envelope["sampleIndex"],
    "sampleId": envelope["sampleId"],
    "seed": envelope["seed"],
}
target.write_text(
    json.dumps(payload, sort_keys=True, separators=(",", ":")) + "\\n",
    encoding="utf-8",
)
`),
      },
      {
        id: "file_public_run_environment",
        kind: "model_environment",
        relativePath: "requirements.txt",
        mediaType: "text/plain",
        bytes: Buffer.from("# no external dependencies\n"),
      },
    ],
  });
  const outputProject = app.productStore!.createProjectFromModel({
    projectId: "project_public_run_projection",
    projectName: "Public run projection",
    sourceModelId: "model_public_run_projection",
    createdAt: "2026-07-24T04:00:00.000Z",
  });
  const outputPlan = planExperiment({
    configuration: {
      schemaVersion: 1,
      runKind: "batch",
      parameters: { seed: 1 },
      sampling: { kind: "single" },
    },
    inputSchema: outputSchema,
    maxSamples: 1,
  });
  app.productStore!.createExperimentV4({
    commandId: "command_public_run_experiment",
    id: "experiment_public_run_projection",
    projectId: outputProject.id,
    name: "Public run projection",
    plan: outputPlan,
    createdAt: "2026-07-24T04:00:00.000Z",
  });
  const eventExecutionDescription = structuredClone(outputExecutionDescription) as any;
  eventExecutionDescription.batch.domainEvents = {
    relativePath: "events.ndjson",
    mediaType: "application/x-ndjson",
    role: "diagnostic",
  };
  app.productStore!.createModel({
    id: "model_domain_events_rejected",
    name: "Domain events rejected",
    technicalStatus: "executable",
    runMode: "batch",
    executionDescription: eventExecutionDescription,
    createdAt: "2026-07-24T04:00:01.000Z",
    files: [
      {
        id: "file_domain_events_model",
        kind: "model_code",
        relativePath: "model.py",
        mediaType: "text/x-python",
        bytes: Buffer.from("raise SystemExit(0)\n"),
      },
      {
        id: "file_domain_events_environment",
        kind: "model_environment",
        relativePath: "requirements.txt",
        mediaType: "text/plain",
        bytes: Buffer.from("# no external dependencies\n"),
      },
    ],
  });
  const eventProject = app.productStore!.createProjectFromModel({
    projectId: "project_domain_events_rejected",
    projectName: "Domain events rejected",
    sourceModelId: "model_domain_events_rejected",
    createdAt: "2026-07-24T04:00:01.000Z",
  });
  app.productStore!.createExperimentV4({
    commandId: "command_domain_events_experiment",
    id: "experiment_domain_events_rejected",
    projectId: eventProject.id,
    name: "Domain events rejected",
    plan: outputPlan,
    createdAt: "2026-07-24T04:00:01.000Z",
  });
  const rejectedDomainEvents = await post(`${baseUrl}/api/projects/${eventProject.id}/runs`, {
    commandId: "command_domain_events_run",
    experimentConfigId: "experiment_domain_events_rejected",
  });
  assert.equal(rejectedDomainEvents.status, 409);
  assert.equal((await rejectedDomainEvents.json() as any).error.code, "domain_events_not_supported");
  assert.deepEqual(app.productStore!.listRuns(eventProject.id), []);
  const visualExecutionDescription = structuredClone(outputExecutionDescription) as any;
  visualExecutionDescription.runMode = "visual";
  delete visualExecutionDescription.batch;
  visualExecutionDescription.visual = {
    entryPoint: "code/app.py",
    protocol: "riff-visual-v1",
    healthPath: "/health",
  };
  app.productStore!.createModel({
    id: "model_visual_run_rejected",
    name: "Visual run rejected",
    technicalStatus: "executable",
    runMode: "visual",
    executionDescription: visualExecutionDescription,
    createdAt: "2026-07-24T04:00:02.000Z",
    files: [
      {
        id: "file_visual_run_model",
        kind: "model_code",
        relativePath: "app.py",
        mediaType: "text/x-python",
        bytes: Buffer.from("raise SystemExit(0)\n"),
      },
      {
        id: "file_visual_run_environment",
        kind: "model_environment",
        relativePath: "requirements.txt",
        mediaType: "text/plain",
        bytes: Buffer.from("# no external dependencies\n"),
      },
    ],
  });
  const visualProject = app.productStore!.createProjectFromModel({
    projectId: "project_visual_run_rejected",
    projectName: "Visual run rejected",
    sourceModelId: "model_visual_run_rejected",
    createdAt: "2026-07-24T04:00:02.000Z",
  });
  const visualPlan = planExperiment({
    configuration: {
      schemaVersion: 1,
      runKind: "visual",
      parameters: { seed: 1 },
      sampling: { kind: "single" },
    },
    inputSchema: outputSchema,
    maxSamples: 1,
  });
  app.productStore!.createExperimentV4({
    commandId: "command_visual_run_experiment",
    id: "experiment_visual_run_rejected",
    projectId: visualProject.id,
    name: "Visual run rejected",
    plan: visualPlan,
    createdAt: "2026-07-24T04:00:02.000Z",
  });
  const rejectedVisualRun = await post(`${baseUrl}/api/projects/${visualProject.id}/runs`, {
    commandId: "command_visual_run",
    experimentConfigId: "experiment_visual_run_rejected",
  });
  assert.equal(rejectedVisualRun.status, 409);
  assert.equal((await rejectedVisualRun.json() as any).error.code, "capability_not_available");
  assert.deepEqual(app.productStore!.listRuns(visualProject.id), []);
  const rejectedRunAuthority = await post(`${baseUrl}/api/projects/${outputProject.id}/runs`, {
    commandId: "command_rejected_run_authority",
    experimentConfigId: "experiment_public_run_projection",
    limits: { maxSamples: 99 },
  });
  assert.equal(rejectedRunAuthority.status, 422);
  assert.equal((await rejectedRunAuthority.json() as any).error.code, "unknown_field");
  const publicStartResponse = await post(`${baseUrl}/api/projects/${outputProject.id}/runs`, {
    commandId: "command_public_api_start",
    experimentConfigId: "experiment_public_run_projection",
  });
  assert.equal(publicStartResponse.status, 201, await publicStartResponse.clone().text());
  const publicStart = await publicStartResponse.json() as any;
  assert.deepEqual(Object.keys(publicStart).sort(), [
    "commandId", "completionConversationId", "createdAt", "experimentConfigId", "projectId",
    "runId", "runKind", "sampleCount", "schemaVersion", "status",
  ]);
  assert.equal(publicStart.status, "queued");
  assert.equal(publicStart.sampleCount, 1);
  const publicStartRetry = await post(`${baseUrl}/api/projects/${outputProject.id}/runs`, {
    commandId: "command_public_api_start",
    experimentConfigId: "experiment_public_run_projection",
  });
  assert.equal(publicStartRetry.status, 201);
  assert.deepEqual(await publicStartRetry.json(), publicStart);
  let publicRun: any;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const publicRunRead = await fetch(`${baseUrl}/api/projects/${outputProject.id}/runs/${publicStart.runId}`);
    assert.equal(publicRunRead.status, 200);
    publicRun = await publicRunRead.json() as any;
    if (publicRun.status === "succeeded") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(publicRun.id, publicStart.runId);
  assert.equal(publicRun.status, "succeeded");
  assert.notEqual(app.productStore!.listRunAttempts(publicStart.runId)[0]!.heartbeatAt, null);
  assert.equal("samplePlan" in publicRun, false);
  assert.equal("limits" in publicRun, false);
  const requestedCancellationRunIds: string[] = [];
  const originalRequestCancellation = app.productRunDispatcher!.requestCancellation.bind(app.productRunDispatcher);
  app.productRunDispatcher!.requestCancellation = (runId: string): void => {
    requestedCancellationRunIds.push(runId);
    originalRequestCancellation(runId);
  };
  const rejectedCancelAuthority = await post(
    `${baseUrl}/api/projects/${outputProject.id}/runs/${publicStart.runId}/cancel`,
    { commandId: "command_public_cancel_unknown", signal: "SIGKILL" },
  );
  assert.equal(rejectedCancelAuthority.status, 422);
  assert.equal((await rejectedCancelAuthority.json() as any).error.code, "unknown_field");
  const publicCancelResponse = await post(
    `${baseUrl}/api/projects/${outputProject.id}/runs/${publicStart.runId}/cancel`,
    { commandId: "command_public_terminal_cancel" },
  );
  assert.equal(publicCancelResponse.status, 200);
  const publicCancel = await publicCancelResponse.json() as any;
  assert.deepEqual(publicCancel, {
    schemaVersion: 1,
    commandId: "command_public_terminal_cancel",
    projectId: outputProject.id,
    runId: publicStart.runId,
    applied: false,
    code: "run_already_terminal",
    status: "succeeded",
    cancelRequestedAt: null,
    createdAt: publicCancel.createdAt,
  });
  assert.deepEqual(requestedCancellationRunIds, [publicStart.runId]);
  const publicCancelRetry = await post(
    `${baseUrl}/api/projects/${outputProject.id}/runs/${publicStart.runId}/cancel`,
    { commandId: "command_public_terminal_cancel" },
  );
  assert.equal(publicCancelRetry.status, 200);
  assert.deepEqual(await publicCancelRetry.json(), publicCancel);
  assert.deepEqual(requestedCancellationRunIds, [publicStart.runId, publicStart.runId]);
  const outputWorkspace = await (await fetch(`${baseUrl}/api/projects/${outputProject.id}/workspace`)).json() as any;
  const projectedRunWithOutput = outputWorkspace.runs.find((run: any) => run.id === publicStart.runId);
  assert.deepEqual(Object.keys(projectedRunWithOutput).sort(), [
    "cancelRequestedAt", "completionCardDisposition", "contractVersion", "createdAt",
    "experimentConfigurationId", "finishedAt", "id", "legacyDigest", "outputs",
    "projectId", "readOnly", "requestedSampleCount", "runKind", "startedAt", "status",
    "terminalCode", "updatedAt",
  ]);
  assert.deepEqual(Object.keys(projectedRunWithOutput.outputs[0]).sort(), [
    "contractVersion", "createdAt", "declaredRole", "id", "legacyDigest", "logicalName",
    "mediaType", "outputType", "readOnly", "runId", "sampleId", "sampleIndex", "sha256",
    "sizeBytes",
  ]);

  const publicText = JSON.stringify({ project, workspace: workspaceWithExperiment, experiment: updatedExperiment });
  assert.doesNotMatch(publicText, /\/tmp\/|\/Users\/|workspacePath|externalSessionRef|opaque-session|capability|proxy|processCommand/u);
  assert.doesNotMatch(publicText, /"(?:executionDescription|entryPoint|dependencyFile|relativePath|objectFileId|limits|samplePlan|startReceiptDigest|outputContractDigest)"\s*:/u);
  assert.doesNotMatch(JSON.stringify(outputWorkspace), /"(?:executionDescription|entryPoint|dependencyFile|relativePath|objectFileId|file|limits|samplePlan|startReceiptDigest|outputContractDigest)"\s*:/u);
});

test("technical-check executes the execution description captured by start, not an earlier Model read", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "riff-a2-technical-description-capture-"));
  const openCode = new ApiOpenCode();
  const checker = new ApiTechnicalChecker();
  const { app, baseUrl } = await start(base, openCode, checker);
  t.after(async () => { await app.close(); await rm(base, { recursive: true, force: true }); });
  const created = await createModel(baseUrl, "technical-description-capture-model");
  const store = app.productStore!;
  const originalStart = store.startTechnicalCheck.bind(store);
  let intercepted = false;
  (store as any).startTechnicalCheck = (input: Parameters<typeof originalStart>[0]) => {
    if (!intercepted) {
      intercepted = true;
      const model = store.listModels({ includeArchived: true }).find((item) => item.id === created.model.id)!;
      const code = store.listObjectFiles({ kind: "model", id: created.model.id }).find((item) => item.kind === "model_code")!;
      const executionDescription = structuredClone(model.executionDescription) as any;
      executionDescription.cancellation.graceMs = 9_999;
      store.mutateModelFiles({ modelId: created.model.id, updatedAt: "2026-07-22T00:30:00.000Z", executionDescription,
        files: [{ objectFileId: code.id, kind: "model_code", relativePath: code.relativePath.replace(/^code\//u, ""), mediaType: code.mediaType,
          bytes: store.readObjectFile(code.id), expectedPriorSha256: code.sha256 }] });
    }
    return originalStart(input);
  };

  const response = await post(`${baseUrl}/api/models/${created.model.id}/technical-checks`, { commandId: "capture-current-description" });
  assert.equal(response.status, 200);
  const result = await response.json() as any;
  assert.equal(result.state, "passed");
  assert.equal(result.publication, "published");
  assert.equal((checker.descriptions[0] as any).cancellation.graceMs, 9_999);
  assert.equal(result.executionDescriptionDigest, executionDescriptionDigest(validateExecutionDescription(checker.descriptions[0])));
});

test("technical-check rejects checker evidence whose snapshot digests differ from the captured start", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "riff-a2-technical-digest-contract-"));
  const openCode = new ApiOpenCode();
  const baseChecker = new ApiTechnicalChecker();
  const checker: ModelTechnicalCheckerPort = { async check(input) {
    const result = await baseChecker.check(input);
    return { ...result, capturedWorkspaceDigest: "f".repeat(64), executionDescriptionDigest: "e".repeat(64) };
  } };
  const { app, baseUrl } = await start(base, openCode, checker);
  t.after(async () => { await app.close(); await rm(base, { recursive: true, force: true }); });
  const created = await createModel(baseUrl, "technical-digest-contract-model");

  const response = await post(`${baseUrl}/api/models/${created.model.id}/technical-checks`, { commandId: "mismatched-checker-evidence" });
  assert.equal(response.status, 200);
  const result = await response.json() as any;
  assert.equal(result.state, "failed");
  assert.equal(result.aggregate, "failed");
  assert.equal(result.publication, "published");
  assert.notEqual(result.capturedWorkspaceDigest, "f".repeat(64));
  assert.notEqual(result.executionDescriptionDigest, "e".repeat(64));
  assert.equal(result.checks[0].code, "technical_check_snapshot_mismatch");
  const workspace = await (await fetch(`${baseUrl}/api/models/${created.model.id}/workspace`)).json() as any;
  assert.equal(workspace.model.technicalStatus, "failed");
});

test("technical-check CAS preserves newer draft files and execution description during execution", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "riff-a2-technical-cas-"));
  const openCode = new ApiOpenCode();
  let release!: () => void;
  let entered!: () => void;
  const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
  const releasePromise = new Promise<void>((resolve) => { release = resolve; });
  const baseChecker = new ApiTechnicalChecker();
  const checker: ModelTechnicalCheckerPort = { async check(input) { entered(); await releasePromise; return baseChecker.check(input); } };
  const { app, baseUrl } = await start(base, openCode, checker);
  t.after(async () => { await app.close(); await rm(base, { recursive: true, force: true }); });
  const created = await createModel(baseUrl, "technical-cas-model");
  const pending = post(`${baseUrl}/api/models/${created.model.id}/technical-checks`, { commandId: "drifting-check" });
  await enteredPromise;
  const file = app.productStore!.listObjectFiles({ kind: "model", id: created.model.id }).find((item) => item.kind === "model_code")!;
  const priorDescription = app.productStore!.listModels({ includeArchived: true }).find((item) => item.id === created.model.id)!.executionDescription;
  const newerDescription = structuredClone(priorDescription) as any;
  newerDescription.cancellation.graceMs = 8_888;
  app.productStore!.mutateModelFiles({ modelId: created.model.id, updatedAt: "2026-07-22T01:00:00.000Z", executionDescription: newerDescription,
    files: [{ objectFileId: file.id, kind: "model_code", relativePath: file.relativePath.replace(/^code\//u, ""), mediaType: file.mediaType,
      bytes: Buffer.from("# newer draft\n"), expectedPriorSha256: file.sha256 }] });
  release();
  const response = await pending;
  assert.equal(response.status, 200);
  const result = await response.json() as any;
  assert.equal(result.state, "passed", "historical check evidence remains terminal");
  assert.equal(result.publication, "superseded", "stale evidence must not publish technical status");
  const workspace = await (await fetch(`${baseUrl}/api/models/${created.model.id}/workspace`)).json() as any;
  assert.equal(workspace.model.technicalStatus, "draft");
  assert.notEqual(workspace.digest, result.capturedWorkspaceDigest);
  const currentDescription = app.productStore!.listModels({ includeArchived: true }).find((item) => item.id === created.model.id)!.executionDescription;
  assert.equal((baseChecker.descriptions[0] as any).cancellation.graceMs, (priorDescription as any).cancellation.graceMs,
    "the checker must retain the start-captured execution description");
  assert.equal((currentDescription as any).cancellation.graceMs, 8_888);
  assert.notEqual(executionDescriptionDigest(validateExecutionDescription(currentDescription)), result.executionDescriptionDigest,
    "finish CAS must supersede evidence after execution-description drift");
});
