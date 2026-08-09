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
  parseAgentResponse,
  parseAgentInstruction,
  parseParameterPatch,
  parseProjectModelSource,
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

const start = async (t: test.TestContext, options: Readonly<{
  openCode?: OpenCodeConversationPort;
  projectOnlySkillRoot?: string;
  projectOnlyAllowedSkills?: string[];
}> = {}) => {
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
  const app = new BackendApp({
    projectOnlyRuntime: runtime,
    projectOnlyOpenCode: options.openCode ?? openCode,
    projectOnlySkillRoot: options.projectOnlySkillRoot,
    projectOnlyAllowedSkills: options.projectOnlyAllowedSkills,
  });
  await app.initialize();
  const address = await app.listen();
  t.after(() => app.close());
  return { app, runtime, project, origin: `http://127.0.0.1:${address.port}` };
};

const body = async (response: Response): Promise<any> => JSON.parse(await response.text());

const awaitProjectTurn = async (
  origin: string,
  conversationId: string,
  requestKey: string,
): Promise<any> => {
  const statusUrl = `${origin}/api/conversations/${conversationId}/turns/${requestKey}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetch(statusUrl);
    assert.equal(response.status, 200, await response.clone().text());
    const status = await body(response);
    if (status.terminal === true) return status.result;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1));
  }
  throw new Error("Project-only Turn did not reach a terminal state.");
};

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

test("Project-only repairs only bare JSON control characters inside OpenCode string fields", () => {
  const instruction = parseAgentInstruction(
    '{"operation":"deliver_design","assistantText":"已补充设计",'
      + '"designMarkdown":"# 可视化设计\\n\\n```\n楼层示意\\n```"}',
  );
  assert.equal(instruction.operation, "deliver_design");
  assert.match(instruction.designMarkdown ?? "", /```\n楼层示意/u);
  assert.throws(
    () => parseAgentInstruction('{"operation":"deliver_design","assistantText":"已补充设计",]'),
    /required JSON object/u,
  );
  assert.throws(
    () => parseAgentInstruction(
      '{"operation":"deliver_project","assistantText":"实现模型",'
        + '"inputSchema":{"type":"object","properties":{"role":{"enum":["guest","staff","random\\"], '
        + '\\"default\\":\\"random\\"}}}}',
    ),
    /required JSON object/u,
  );
});

test("Project-only model-source frames keep long Python outside JSON and fail closed on malformed frames", () => {
  const source = "from mesa import Model\n\nclass SimulationModel(Model):\n    pass\n";
  assert.equal(parseProjectModelSource(`RIFF_MODEL_SOURCE_V1\n${source}`), source);
  assert.equal(parseProjectModelSource(`RIFF_MODEL_SOURCE_V1\n\`\`\`python\n${source}\`\`\``), source);
  assert.throws(() => parseProjectModelSource(source), /required model-source frame/u);
  assert.throws(
    () => parseProjectModelSource("RIFF_MODEL_SOURCE_V1\nRIFF_MODEL_SOURCE_V1\nclass SimulationModel: pass"),
    /invalid model-source frame/u,
  );
});

test("Project-only parses one framed Project delivery without placing Python in JSON", () => {
  const metadata = JSON.stringify({
    operation: "deliver_project",
    assistantText: "实现模型",
    inputSchema: { type: "object", properties: { steps: { type: "integer", default: 2 } }, required: ["steps"], additionalProperties: false },
    defaultParameters: { steps: 2 },
  });
  const parsed = parseAgentResponse(`RIFF_PROJECT_DELIVERY_V1\n${metadata}\nRIFF_MODEL_SOURCE_V1\nclass SimulationModel: pass`);
  assert.equal(parsed.operation, "deliver_project");
  assert.equal(parsed.modelSource, "class SimulationModel: pass\n");
  assert.throws(
    () => parseAgentResponse(`RIFF_PROJECT_DELIVERY_V1\n${metadata}\nclass SimulationModel: pass`),
    /required Project-delivery frame/u,
  );
});

test("Project-only model mutations mentioning batch capability are not misrouted as batch starts", () => {
  const intent = projectCommandIntent("修改当前模型并交付可批量执行的 Mesa 3 模型");
  assert.equal(intent.explicitMutation, true);
  assert.equal(intent.startBatch, true);
  assert.equal(intent.requiresAgent, true);
});

test("Project-only routes model-design wording through the Agent without a semantic design label", () => {
  const intent = projectCommandIntent("补充可视化仿真设计方案，要求能3D查看全部楼层");
  assert.equal(intent.explicitMutation, true);
  assert.equal(intent.requiresAgent, true);
  assert.equal("modelDesign" in intent, false);
});

test("Project-only routes cruise cabin layout requests to the visual asset owner", () => {
  const intent = projectCommandIntent("调整可视化页面，体现游轮舱室布局");
  assert.equal(intent.visualControls, true);
  assert.equal(intent.requiresAgent, false);
});

test("Project-only accepts OpenCode design delivery for raw visual-design wording with bounded skills preloaded", async (t) => {
  let capturedPrompt: Parameters<OpenCodeConversationPort["promptWithModel"]>[2] | undefined;
  const structuredOpenCode: OpenCodeConversationPort = {
    ...openCode,
    async promptWithModel(_sessionId, _provider, prompt) {
      capturedPrompt = prompt;
      return {
        messageId: "message_design",
        text: JSON.stringify({
          operation: "deliver_design",
          assistantText: "已补充邮轮3D分层可视化设计。",
          designMarkdown: "# 邮轮病毒传播模型\n\n## 可视化设计\n支持全部楼层、单层切换和SEIR颜色。\n",
        }),
        content: { source: "opencode", textParts: 1, parts: [{ ordinal: 0, kind: "text", state: "complete" }] },
      };
    },
  };
  const { origin, runtime, project } = await start(t, {
    openCode: structuredOpenCode,
    projectOnlySkillRoot: join(import.meta.dirname, "../../.opencode/skills"),
    projectOnlyAllowedSkills: ["simulation-domain-requirements", "simulation-model-visualization"],
  });
  const conversation = runtime.store.createConversation({
    id: "conversation_design",
    projectId: project.id,
    name: "Design",
    providerId: "provider",
    modelId: "agent",
    createdAt: NOW,
  });
  const text = "补充可视化仿真设计方案，要求能3D或伪3D查看全部楼层、切换单独楼层显示，能用颜色显示每个人的SEIR状态";
  const response = await fetch(`${origin}/api/conversations/${conversation.id}/turns`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ requestKey: "request_design", text, attachmentIds: [] }),
  });
  assert.equal(response.status, 202, await response.clone().text());
  const designSubmission = await body(response);
  assert.equal(designSubmission.schemaVersion, 1);
  assert.equal(designSubmission.accepted, true);
  assert.equal(designSubmission.requestKey, "request_design");
  assert.match(designSubmission.turnId, /^turn_[0-9a-f]{32}$/u);
  assert.equal(designSubmission.state, "running");
  assert.equal(designSubmission.terminal, false);
  assert.equal(designSubmission.statusUrl, `/api/conversations/${conversation.id}/turns/request_design`);
  await awaitProjectTurn(origin, conversation.id, "request_design");
  assert.equal(capturedPrompt?.text, text);
  assert.match(capturedPrompt?.system ?? "", /BEGIN LOADED PROJECT SKILL \(simulation-domain-requirements@local-v1\)/u);
  assert.match(capturedPrompt?.system ?? "", /Create a reviewable domain brief/u);
  assert.match(capturedPrompt?.system ?? "", /BEGIN LOADED PROJECT SKILL \(simulation-model-visualization@local-v1\)/u);
  assert.match(capturedPrompt?.system ?? "", /Simulation model and runtime visualization/u);
  assert.doesNotMatch(capturedPrompt?.system ?? "", /intent=|"modelDesign"/u);
  const design = runtime.store.projectFiles(project.id)
    .find((file) => file.relativePath === "design/model-design.md");
  assert.match(design?.bytes.toString("utf8") ?? "", /全部楼层、单层切换和SEIR颜色/u);
});

test("Project-only stages Mesa source after validating compact Project metadata", async (t) => {
  const prompts: Array<Parameters<OpenCodeConversationPort["promptWithModel"]>[2]> = [];
  const promptSessionIds: string[] = [];
  const createdSessionIds: string[] = [];
  const stagedOpenCode: OpenCodeConversationPort = {
    ...openCode,
    async createSession(conversationId) {
      createdSessionIds.push(conversationId);
      return `session_${createdSessionIds.length}`;
    },
    async promptWithModel(sessionId, _provider, prompt) {
      prompts.push(prompt);
      promptSessionIds.push(sessionId);
      const metadata = JSON.stringify({
        operation: "deliver_project",
        assistantText: "已实现 Mesa 3 邮轮病毒扩散模型。",
        inputSchema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: {
            steps: { type: "integer", minimum: 1, maximum: 365, default: 45 },
            seed: { type: "integer", minimum: 0, maximum: 2147483647, default: 42 },
          },
          required: ["steps", "seed"],
          additionalProperties: false,
        },
        defaultParameters: { steps: 45, seed: 42 },
        visual: { title: "邮轮 SEIR", summary: "分层楼层与 SEIR 颜色" },
      });
      return {
        messageId: "message_project_source",
        text: `RIFF_PROJECT_DELIVERY_V1
${metadata}
RIFF_MODEL_SOURCE_V1
from mesa import Model

class SimulationModel(Model):
    def __init__(self, steps=45, seed=42):
        super().__init__(seed=seed)
        self.steps = steps
        self.day = 0

    def step(self):
        self.day += 1

    def snapshot(self):
        return {"day": self.day, "S": 999, "E": 0, "I": 1, "R": 0, "person_positions": []}
`,
        content: { source: "opencode", textParts: 1, parts: [{ ordinal: 0, kind: "text", state: "complete" }] },
      };
    },
  };
  const { origin, runtime, project } = await start(t, {
    openCode: stagedOpenCode,
    projectOnlySkillRoot: join(import.meta.dirname, "../../.opencode/skills"),
    projectOnlyAllowedSkills: ["simulation-domain-requirements", "simulation-model-visualization"],
  });
  const conversation = runtime.store.createConversation({
    id: "conversation_project_delivery",
    projectId: project.id,
    name: "Project delivery",
    providerId: "provider",
    modelId: "agent",
    createdAt: NOW,
  });
  const text = "实现mesa可视化仿真模型";
  const response = await fetch(`${origin}/api/conversations/${conversation.id}/turns`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ requestKey: "request_project_delivery", text, attachmentIds: [] }),
  });
  assert.equal(response.status, 202, await response.clone().text());
  const submission = await body(response);
  assert.equal(submission.accepted, true);
  assert.equal(submission.requestKey, "request_project_delivery");
  assert.equal(submission.terminal, false);
  await awaitProjectTurn(origin, conversation.id, "request_project_delivery");
  assert.equal(prompts.length, 1);
  assert.equal(createdSessionIds.length, 1);
  assert.deepEqual(promptSessionIds, ["session_1"]);
  assert.equal(prompts[0]?.text, text);
  assert.match(prompts[0]?.system ?? "", /RIFF_PROJECT_DELIVERY_V1/u);
  assert.match(prompts[0]?.system ?? "", /RIFF_MODEL_SOURCE_V1/u);
  assert.match(prompts[0]?.system ?? "", /never read, create, or increment self\._steps/u);
  assert.match(prompts[0]?.system ?? "", /\$schema to exactly "https:\/\/json-schema\.org\/draft\/2020-12\/schema"/u);
  assert.match(prompts[0]?.system ?? "", /Every Mesa Agent subclass must call super\(\)\.__init__\(model\)/u);
  assert.match(prompts[0]?.system ?? "", /never pass unique_id to Agent\.__init__/u);
  assert.doesNotMatch(prompts[0]?.system ?? "", /"modelSource"\?:/u);
  const source = runtime.store.projectFiles(project.id)
    .find((file) => file.relativePath === "code/model.py");
  assert.match(source?.bytes.toString("utf8") ?? "", /class SimulationModel\(Model\)/u);
  const latest = runtime.store.conversationTurns(conversation.id).at(-1);
  assert.equal(latest?.state, "complete");
  assert.equal(latest?.goalVerification?.disposition, "completed");
});

test("Project-only Turn submission returns 202 before OpenCode completes and duplicate submissions share one job", async (t) => {
  let resolvePrompt!: (value: Awaited<ReturnType<OpenCodeConversationPort["promptWithModel"]>>) => void;
  const deferred = new Promise<Awaited<ReturnType<OpenCodeConversationPort["promptWithModel"]>>>((resolve) => {
    resolvePrompt = resolve;
  });
  let promptCount = 0;
  const delayedOpenCode: OpenCodeConversationPort = {
    ...openCode,
    async promptWithModel() {
      promptCount += 1;
      return deferred;
    },
  };
  const { origin, runtime, project } = await start(t, { openCode: delayedOpenCode });
  const conversation = runtime.store.createConversation({
    id: "conversation_async_turn",
    projectId: project.id,
    name: "Async",
    providerId: "provider",
    modelId: "agent",
    createdAt: NOW,
  });
  const submit = () => fetch(`${origin}/api/conversations/${conversation.id}/turns`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ requestKey: "request_async_turn", text: "请解释当前模型", attachmentIds: [] }),
  });
  const first = await submit();
  assert.equal(first.status, 202);
  assert.equal((await body(first)).terminal, false);
  const duplicate = await submit();
  assert.equal(duplicate.status, 202);
  assert.equal(promptCount, 1);
  const running = await fetch(`${origin}/api/conversations/${conversation.id}/turns/request_async_turn`);
  assert.equal((await body(running)).terminal, false);
  resolvePrompt({
    messageId: "message_async",
    text: JSON.stringify({ operation: "none", assistantText: "当前模型可执行。" }),
    content: { source: "opencode", textParts: 1, parts: [{ ordinal: 0, kind: "text", state: "complete" }] },
  });
  const completed = await awaitProjectTurn(origin, conversation.id, "request_async_turn");
  assert.equal(completed.turn.state, "complete");
  assert.equal(promptCount, 1);
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
