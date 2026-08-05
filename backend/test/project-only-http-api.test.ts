import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { ModelTechnicalCheckInput, ModelTechnicalCheckResult } from "../src/model-technical-checker.ts";
import { captureWorkspaceDigest, createGenericModelScaffold, executionDescriptionDigest } from "../src/model-workspace.ts";
import type { OpenCodeConversationPort } from "../src/opencode-adapter.ts";
import {
  boundedOperation,
  normalizeAgentInputSchema,
  parseAgentInstruction,
  parseParameterPatch,
  projectCommandIntent,
  removeStaleProjectionEntries,
} from "../src/project-only-agent-service.ts";
import { openProjectOnlyServerRuntime } from "../src/project-only-server-factory.ts";
import { BackendApp } from "../src/server.ts";

const NOW = "2026-08-04T07:00:00.000Z";
const scaffold = createGenericModelScaffold("project_http");
const checker = {
  async check(input: ModelTechnicalCheckInput): Promise<ModelTechnicalCheckResult> {
    const captured = captureWorkspaceDigest(input.workspace);
    return Object.freeze({
      attemptId: "check_http",
      aggregate: "executable" as const,
      capturedWorkspaceDigest: captured.digest,
      executionDescriptionDigest: executionDescriptionDigest(input.executionDescription as any),
      dependencyDescriptionDigest: "d".repeat(64),
      environmentKey: "fixture",
      startedAt: NOW,
      finishedAt: NOW,
      limits: Object.freeze({ timeoutMs: 1000, maxOutputBytes: 1000, maxWorkspaceFiles: 100, maxWorkspaceBytes: 100000 }),
      checks: Object.freeze([{ name: "path" as const, state: "passed" as const, code: "ok", detail: "fixture" }]),
      log: "",
    });
  },
};

const openCode: OpenCodeConversationPort = {
  async initialize() { return { status: "ready", modelId: "agent", version: "fixture" }; },
  async discoverProviderModels() {
    return [{ providerId: "provider", modelId: "agent", qualifiedId: "provider/agent" }];
  },
  async discoverAgents() { return []; },
  async getSession() { return false; },
  async createSession(conversationId) { return `session_${conversationId}`; },
  async injectContext() {},
  async promptWithModel() {
    return {
      messageId: "message_fixture",
      text: JSON.stringify({ operation: "none", assistantText: "fixture" }),
      content: { source: "opencode", textParts: 1, parts: [{ ordinal: 0, kind: "text", state: "complete" }] },
    };
  },
  async abort() {},
};

const start = async (t: test.TestContext) => {
  const temp = mkdtempSync(join(tmpdir(), "riff-project-http-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const runtime = openProjectOnlyServerRuntime({ root: join(temp, ".riff-product"), checker, now: () => NOW });
  assert.equal(runtime.mode, "ready");
  if (runtime.mode !== "ready") throw new Error("fixture runtime did not open");
  runtime.store.createTemplateVersion({
    id: "template_http",
    version: "1",
    description: "HTTP template",
    runMode: scaffold.runMode,
    executionDescription: scaffold.executionDescription,
    defaultExperiment: { seed: 1 },
    files: scaffold.files.map((file, index) => ({
      id: `template_file_${index}`,
      kind: file.kind === "model_environment" ? "project_environment" as const
        : file.kind === "model_visual_asset" ? "project_visual_asset" as const : "project_code" as const,
      relativePath: file.relativePath,
      mediaType: file.mediaType,
      bytes: file.bytes,
    })),
    createdAt: NOW,
  });
  const project = runtime.store.createProject({
    id: "project_http",
    name: "HTTP Project",
    source: { kind: "template", templateId: "template_http", version: "1" },
    createdAt: NOW,
  });
  const app = new BackendApp({ projectOnlyRuntime: runtime, projectOnlyOpenCode: openCode });
  await app.initialize();
  const address = await app.listen();
  t.after(() => app.close());
  return { app, runtime, project, origin: `http://127.0.0.1:${address.port}` };
};

const body = async (response: Response): Promise<any> => JSON.parse(await response.text());

test("Project-only structured Agent responses accept null optional fields without weakening operation validation", () => {
  assert.deepEqual(parseAgentInstruction(JSON.stringify({
    operation: "none",
    assistantText: "无需变更",
    modelSource: null,
    visual: null,
  })), {
    operation: "none",
    assistantText: "无需变更",
  });
  assert.throws(() => parseAgentInstruction(JSON.stringify({
    operation: "deliver_project",
    assistantText: "交付",
    modelSource: 42,
  })), /invalid structured result/u);
});

test("Project-only model mutations mentioning batch capability are not misrouted as batch starts", () => {
  const intent = projectCommandIntent("修改当前模型并交付可批量执行的 Mesa 3 模型");
  assert.equal(intent.explicitMutation, true);
  assert.equal(intent.startBatch, true);
  assert.equal(intent.requiresAgent, true);
});

test("Project-only parameter reruns accept an explicit bounded JSON patch", () => {
  assert.deepEqual(
    parseParameterPatch('修改参数并再次运行大样本实验：{"steps":20,"num_pickers":4}'),
    { steps: 20, num_pickers: 4 },
  );
  assert.equal(parseParameterPatch("修改参数并再次运行大样本实验：没有 JSON"), null);
  assert.equal(parseParameterPatch('修改参数并再次运行大样本实验：{"__proto__":{}}'), null);
});

test("Project-only Agent schemas discard harmless annotations but preserve parameter names", () => {
  assert.deepEqual(normalizeAgentInputSchema({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    description: "Agent annotation",
    properties: {
      seed: { type: "integer", description: "random seed" },
      description: { type: "string", description: "a real parameter named description" },
    },
    required: ["seed", "description"],
    additionalProperties: false,
  }), {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      seed: { type: "integer" },
      description: { type: "string" },
    },
    required: ["seed", "description"],
    additionalProperties: false,
  });
});

test("Project-only OpenCode session setup is independently bounded", async () => {
  await assert.rejects(
    boundedOperation(new Promise<never>(() => {}), 5, "opencode_session_setup_timeout"),
    (error: any) => error?.code === "opencode_session_setup_timeout",
  );
});

test("Project-only materialization removes stale Python cache directories and root projections", () => {
  const root = mkdtempSync(join(tmpdir(), "riff-project-projection-"));
  try {
    mkdirSync(join(root, "code", "__pycache__"), { recursive: true });
    writeFileSync(join(root, "code", "model.py"), "authoritative");
    writeFileSync(join(root, "code", "__pycache__", "model.pyc"), "stale");
    writeFileSync(join(root, "model.py"), "stale root projection");
    removeStaleProjectionEntries(root, new Set(["code/model.py"]));
    assert.equal(existsSync(join(root, "code", "model.py")), true);
    assert.equal(existsSync(join(root, "code", "__pycache__")), false);
    assert.equal(existsSync(join(root, "model.py")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Project-only HTTP exposes Home/workspace/check and retires every Model route", async (t) => {
  const { origin, project } = await start(t);
  const homeResponse = await fetch(`${origin}/api/home`);
  assert.equal(homeResponse.status, 200);
  const home = await body(homeResponse);
  assert.deepEqual(Object.keys(home).sort(), [
    "collectionDigest", "generatedAt", "projects", "providerAvailability", "recentConversations", "schemaVersion", "templates",
  ]);
  assert.equal("models" in home, false);
  assert.equal(home.projects[0].id, project.id);
  assert.equal(home.templates[0].id, "template_http");

  for (const request of [
    fetch(`${origin}/api/models`),
    fetch(`${origin}/api/models/model_legacy/workspace`),
    fetch(`${origin}/api/models/model_legacy/technical-checks`, { method: "POST" }),
  ]) {
    const response = await request;
    assert.equal(response.status, 410);
    assert.equal((await body(response)).error.code, "legacy_model_api_removed");
  }

  const workspaceResponse = await fetch(`${origin}/api/projects/${project.id}/workspace`);
  assert.equal(workspaceResponse.status, 200);
  const workspace = await body(workspaceResponse);
  assert.equal(workspace.project.id, project.id);
  assert.deepEqual(workspace.conversations, []);
  assert.equal(workspace.workspaceDigest, project.workspaceDigest);
  assert.equal(workspace.files.length > 0, true);
  assert.deepEqual(workspace.executionLock, { state: "unlocked", runId: null, sourceDigest: null });

  const checkResponse = await fetch(`${origin}/api/projects/${project.id}/technical-checks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ commandId: "command_http_check" }),
  });
  assert.equal(checkResponse.status, 201, JSON.stringify(await checkResponse.clone().text()));
  const check = await body(checkResponse);
  assert.equal(check.projectId, project.id);
  assert.equal(check.state, "passed");
  assert.equal(check.aggregate, "executable");
  assert.equal(check.capturedWorkspaceDigest, project.workspaceDigest);
});

test("Project creation atomically creates the Project and first Conversation for every source DTO", async (t) => {
  const { origin, runtime } = await start(t);
  const sources = [
    { kind: "blank" },
    { kind: "template", templateId: "template_http", templateVersion: "1" },
    { kind: "import", filename: "project.riff.json", mediaType: "application/vnd.riff.project+json", base64: Buffer.from("{}").toString("base64") },
  ];
  for (const [index, source] of sources.entries()) {
    const response = await fetch(`${origin}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandId: `command_create_${index}`,
        name: `Project ${index}`,
        provider: { providerId: "provider", modelId: "agent" },
        source,
      }),
    });
    assert.equal(response.status, 201, await response.clone().text());
    const created = await body(response);
    assert.match(created.project.id, /^project_[0-9a-f]{32}$/u);
    assert.match(created.conversation.id, /^conversation_[0-9a-f]{32}$/u);
    assert.deepEqual(created.conversation.owner, { kind: "project", id: created.project.id });
    assert.deepEqual(created.conversation.provider, { providerId: "provider", modelId: "agent", locked: false });
  }
  assert.equal(runtime.store.projects().length, 4);
  assert.equal(runtime.store.projects().slice(1).every((project) => runtime.store.conversations(project.id).length === 1), true);
});

test("Project-only direct visual cancellation terminalizes the Run, releases the lock, and is idempotent", async (t) => {
  const { origin, runtime, app } = await start(t);
  const visualExecution = {
    schemaVersion: 2,
    runtime: "python",
    runMode: "visual",
    dependencyFile: "environment/requirements.txt",
    inputs: {
      schemaProfile: "riff-json-schema-2020-12-v1",
      schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: { seed: { type: "integer" }, steps: { type: "integer", minimum: 1 } },
        required: ["seed", "steps"],
        additionalProperties: false,
      },
      smoke: { seed: 1, steps: 2 },
    },
    outputs: [{ logicalName: "status", relativePath: "status.json", mediaType: "application/json", required: false, role: "diagnostic" }],
    visual: { entryPoint: "code/visual.py", protocol: "riff-visual-v1", healthPath: "/health" },
    cancellation: { signal: "SIGTERM", graceMs: 500 },
  };
  const project = runtime.store.createProject({
    id: "project_visual_cancel",
    name: "Visual cancellation",
    source: {
      kind: "import",
      importDigest: "a".repeat(64),
      files: [
        { id: "visual_code", kind: "project_code", relativePath: "code/visual.py", mediaType: "text/x-python", bytes: Buffer.from("print('visual')\n") },
        { id: "visual_html", kind: "project_visual_asset", relativePath: "visual.html", mediaType: "text/html", bytes: Buffer.from("<!doctype html><title>Visual</title>") },
        { id: "visual_requirements", kind: "project_environment", relativePath: "environment/requirements.txt", mediaType: "text/plain", bytes: Buffer.from("mesa\n") },
      ],
    },
    runMode: "visual",
    executionDescription: visualExecution,
    createdAt: NOW,
  });
  await runtime.projectOperations.startProjectTechnicalCheck({
    projectId: project.id,
    commandId: "check_visual_cancel",
    expectedWorkspaceDigest: project.workspaceDigest,
  });
  runtime.store.createExperiment({
    id: "experiment_visual_cancel",
    projectId: project.id,
    name: "Visual",
    configuration: { schemaVersion: 1, runKind: "visual", parameters: { seed: 1, steps: 2 }, sampling: { kind: "single", seed: 1 } },
    createdAt: NOW,
  });
  const run = runtime.projectOperations.startRunAdmission({
    commandId: "run_visual_cancel",
    projectId: project.id,
    experimentConfigurationId: "experiment_visual_cancel",
    runKind: "visual",
    expectedWorkspaceDigest: project.workspaceDigest,
  });
  await app.projectOnlyApi!.agent!.visualRuntime.start({
    projectId: project.id,
    runId: run.runId,
    html: "<!doctype html><title>Visual</title>",
    at: NOW,
  });
  assert.equal(runtime.store.project(project.id).executionLock?.holderId, run.runId);

  for (const commandId of ["cancel_visual", "cancel_visual_retry"]) {
    const response = await fetch(`${origin}/api/projects/${project.id}/runs/${run.runId}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandId }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await body(response)).status, "cancelled");
  }
  assert.equal(runtime.store.run(run.runId).terminalCode, "user_cancelled");
  assert.equal(runtime.store.project(project.id).executionLock, null);
});

test("legacy schema starts recovery-only and cannot expose Product or Model data", async (t) => {
  const temp = mkdtempSync(join(tmpdir(), "riff-project-http-recovery-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const root = join(temp, ".riff-product");
  mkdirSync(root);
  const legacy = new DatabaseSync(join(root, "riff.sqlite3"));
  legacy.exec("CREATE TABLE models (id TEXT PRIMARY KEY)");
  legacy.close();
  const runtime = openProjectOnlyServerRuntime({ root, checker, now: () => NOW });
  assert.equal(runtime.mode, "recovery_only");
  if (runtime.mode !== "recovery_only") throw new Error("legacy fixture was not gated");
  const app = new BackendApp({
    productOnly: true,
    recoveryStatus: {
      state: "recovery_required",
      code: runtime.code,
      observedAt: NOW,
      retryable: runtime.retryable,
    },
  });
  await app.initialize();
  const address = await app.listen();
  t.after(() => app.close());
  const origin = `http://127.0.0.1:${address.port}`;
  const health = await fetch(`${origin}/api/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await body(health), { healthy: false, state: "recovery_required" });
  for (const path of ["/api/home", "/api/projects", "/api/models", "/api/models/legacy/workspace"]) {
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, 503, path);
    assert.equal((await body(response)).error.code, "recovery_required");
  }
});
