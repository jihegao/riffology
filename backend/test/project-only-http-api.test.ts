import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import type {
  OpenCodeAssistantResponse,
  OpenCodeConversationPort,
  OpenCodePrompt,
  OpenCodeWorkspaceBinding,
} from "../src/opencode-adapter.ts";
import { PROJECT_ONLY_BATCH_ENTRY_SOURCE } from "../src/project-only-runtime-assets.ts";
import { openProjectOnlyServerRuntime } from "../src/project-only-server-factory.ts";
import { BackendApp } from "../src/server.ts";

const NOW = "2026-08-04T07:00:00.000Z";
const execution = {
  schemaVersion: 2,
  runtime: "python",
  runMode: "batch",
  dependencyFile: "environment/requirements.txt",
  inputs: {
    schemaProfile: "riff-json-schema-2020-12-v1",
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        steps: { type: "integer", minimum: 1, maximum: 1000 },
        demand: { type: "number", minimum: 0, maximum: 100 },
      },
      required: ["steps", "demand"],
      additionalProperties: false,
    },
    smoke: { steps: 2, demand: 1 },
  },
  outputs: [{
    logicalName: "summary", relativePath: "summary.json",
    mediaType: "application/json", required: true, role: "data",
  }],
  batch: { entryPoint: "code/riff_entry.py", protocol: "riff-batch-v1" },
  cancellation: { signal: "SIGTERM", graceMs: 500 },
};
const validModelSource = `from mesa import Model

class SimulationModel(Model):
    def __init__(self, demand=1, seed=None):
        super().__init__(seed=seed)
        self.demand = demand
        self.value = 0.0
    def step(self):
        self.value += self.random.random() * self.demand
    def snapshot(self):
        return {"value": self.value, "demand": self.demand}
`;
const experiment = {
  schemaVersion: 1,
  runKind: "batch",
  parameters: { steps: 2, demand: 1 },
  sampling: { kind: "single", seed: 7 },
};

class NaturalLanguageOpenCode implements OpenCodeConversationPort {
  mcpUrl: string | null = null;
  readonly prompts: OpenCodePrompt[] = [];
  readonly toolLists: string[][] = [];
  nextRpcId = 0;

  async initialize() { return { status: "ready" as const, modelId: "agent", version: "fixture" }; }
  async discoverProviderModels() {
    return [{ providerId: "provider", modelId: "agent", qualifiedId: "provider/agent" }];
  }
  async discoverAgents() { return []; }
  async getSession() { return false; }
  async createSession(conversationId: string) { return `session_${conversationId}`; }
  async injectContext() {}
  async abort() {}
  async bindScopedMcp(
    _scopeId: string,
    mcpUrl: string,
    _allowedTools: readonly any[],
    _workspace: OpenCodeWorkspaceBinding,
  ) {
    this.mcpUrl = mcpUrl;
    const listed = await this.rpc("tools/list", {});
    this.toolLists.push((listed.tools as Array<{ name: string }>).map(({ name }) => name));
  }
  async unbindScopedMcp() { this.mcpUrl = null; }

  async promptWithModel(
    _sessionId: string,
    _binding: { providerId: string; modelId: string },
    prompt: OpenCodePrompt,
  ): Promise<OpenCodeAssistantResponse> {
    this.prompts.push(prompt);
    const workspace = await this.call("riff_list_project_workspace", {});
    const model = (workspace.files as Array<any>).find((file) => file.relativePath === "code/model.py");
    assert.ok(model);
    if (prompt.text.includes("故障")) {
      const write = await this.call("riff_write_project_files", {
        requestKey: "write_broken",
        expectedWorkspaceDigest: workspace.project.workspaceDigest,
        changes: [{
          operation: "upsert",
          relativePath: model.relativePath,
          mediaType: model.mediaType,
          text: "def broken(:\n",
          expectedPriorSha256: model.sha256,
        }],
      });
      assert.equal(write.state, "committed");
      const experiments = await this.call("riff_list_experiment_configurations", {});
      await this.call("riff_start_project_run", {
        requestKey: "run_broken",
        experimentConfigurationId: experiments.experiments[0].id,
        runKind: "batch",
      });
      return response("已按要求保存故障模型并启动真实 Run。");
    }

    const diagnostics = await this.call("riff_read_project_run_diagnostics", {});
    assert.equal(diagnostics.status, "failed");
    assert.equal(typeof diagnostics.completion.diagnostic, "string");
    await this.call("riff_read_project_file", { fileRef: model.fileRef });
    const write = await this.call("riff_write_project_files", {
      requestKey: "write_fixed",
      expectedWorkspaceDigest: workspace.project.workspaceDigest,
      changes: [{
        operation: "upsert",
        relativePath: model.relativePath,
        mediaType: model.mediaType,
        text: validModelSource,
        expectedPriorSha256: model.sha256,
      }],
    });
    assert.equal(write.state, "committed");
    const experiments = await this.call("riff_list_experiment_configurations", {});
    await this.call("riff_start_project_run", {
      requestKey: "run_fixed",
      experimentConfigurationId: experiments.experiments[0].id,
      runKind: "batch",
    });
    return response("已读取失败诊断、修复源文件并重新启动 Run。");
  }

  async call(name: string, args: Record<string, unknown>): Promise<any> {
    const result = await this.rpc("tools/call", { name, arguments: args });
    return JSON.parse(result.content[0].text);
  }

  async rpc(method: string, params: Record<string, unknown>): Promise<any> {
    assert.ok(this.mcpUrl);
    const request = { jsonrpc: "2.0", id: ++this.nextRpcId, method, params };
    const result = await fetch(this.mcpUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    assert.equal(result.status, 200, await result.clone().text());
    const envelope = await result.json() as any;
    if (envelope.error) throw new Error(envelope.error.message);
    return envelope.result;
  }
}

class VisualRepairOpenCode extends NaturalLanguageOpenCode {
  lastFailedStart: any = null;

  async promptWithModel(
    _sessionId: string,
    _binding: { providerId: string; modelId: string },
    prompt: OpenCodePrompt,
  ): Promise<OpenCodeAssistantResponse> {
    this.prompts.push(prompt);
    const workspace = await this.call("riff_list_project_workspace", {});
    if (prompt.text.includes("故障")) {
      const write = await this.call("riff_write_project_files", {
        requestKey: "visual_prepare",
        expectedWorkspaceDigest: workspace.project.workspaceDigest,
        changes: [{
          operation: "upsert",
          relativePath: "notes/visual-request.txt",
          mediaType: "text/plain",
          text: "visual run requested\n",
          expectedPriorSha256: null,
        }],
        runMode: "both",
      });
      assert.equal(write.state, "committed");
      const failedStart = await this.call("riff_start_project_run", {
        requestKey: "visual_missing_document",
        experimentConfigurationId: "experiment_visual",
        runKind: "visual",
      });
      this.lastFailedStart = failedStart;
      const diagnostics = await this.call("riff_read_project_run_diagnostics", {});
      assert.equal(diagnostics.completion.code, "visual_document_missing");
      return response("文件已经保存；可视化 Run 按预期因缺少文档而失败。");
    }

    const diagnostics = await this.call("riff_read_project_run_diagnostics", {});
    assert.equal(diagnostics.status, "failed");
    assert.equal(diagnostics.completion.code, "visual_document_missing");
    const write = await this.call("riff_write_project_files", {
      requestKey: "visual_repair",
      expectedWorkspaceDigest: workspace.project.workspaceDigest,
      changes: [{
        operation: "upsert",
        relativePath: "visual.html",
        mediaType: "text/html",
        text: "<!doctype html><html><body><main>visual repaired</main></body></html>",
        expectedPriorSha256: null,
      }],
    });
    assert.equal(write.state, "committed");
    const started = await this.call("riff_start_project_run", {
      requestKey: "visual_repaired_run",
      experimentConfigurationId: "experiment_visual",
      runKind: "visual",
    });
    assert.equal(started.state, "started");
    return response("已读取可视化失败诊断、补齐文档并重新启动 Run。");
  }
}

const start = async (t: test.TestContext, openCode = new NaturalLanguageOpenCode()) => {
  const temp = mkdtempSync(join(tmpdir(), "riff-project-http-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const runtime = openProjectOnlyServerRuntime({ root: join(temp, ".riff-product"), now: () => NOW });
  assert.equal(runtime.mode, "ready");
  if (runtime.mode !== "ready") throw new Error("fixture runtime did not open");
  runtime.store.createTemplateVersion({
    id: "template_http",
    version: "1",
    description: "HTTP template",
    runMode: "batch",
    executionDescription: execution,
    defaultExperiment: experiment,
    files: [{
      id: "template_file_entry", kind: "project_code",
      relativePath: "code/riff_entry.py", mediaType: "text/x-python",
      bytes: Buffer.from(PROJECT_ONLY_BATCH_ENTRY_SOURCE),
    }, {
      id: "template_file_model", kind: "project_code",
      relativePath: "code/model.py", mediaType: "text/x-python",
      bytes: Buffer.from(validModelSource),
    }, {
      id: "template_file_environment", kind: "project_environment",
      relativePath: "environment/requirements.txt", mediaType: "text/plain",
      bytes: Buffer.from("mesa>=3,<4\n"),
    }],
    createdAt: NOW,
  });
  const project = runtime.store.createProject({
    id: "project_http",
    name: "HTTP Project",
    source: { kind: "template", templateId: "template_http", version: "1" },
    createdAt: NOW,
  });
  const conversation = runtime.store.createConversation({
    id: "conversation_http",
    projectId: project.id,
    name: "Main",
    providerId: "provider",
    modelId: "agent",
    createdAt: NOW,
  });
  const app = new BackendApp({
    projectOnlyRuntime: runtime,
    projectOnlyOpenCode: openCode,
    a3PythonExecutable: resolve(import.meta.dirname, "../../mesa_service/.venv/bin/python"),
  });
  await app.initialize();
  const address = await app.listen();
  t.after(() => app.close());
  return { app, runtime, project, conversation, openCode, origin: `http://127.0.0.1:${address.port}` };
};

test("Project-only HTTP removes technical-check routes and summarizes latest Run state", async (t) => {
  const { origin, project } = await start(t);
  const homeResponse = await fetch(`${origin}/api/home`);
  assert.equal(homeResponse.status, 200);
  const home = await homeResponse.json() as any;
  assert.equal("technicalStatus" in home.projects[0], false);
  assert.equal(home.projects[0].lastRun, null);

  const workspaceResponse = await fetch(`${origin}/api/projects/${project.id}/workspace`);
  assert.equal(workspaceResponse.status, 200);
  const workspace = await workspaceResponse.json() as any;
  assert.equal("technicalStatus" in workspace.project, false);
  assert.deepEqual(workspace.executionLock, { state: "unlocked", runId: null, sourceDigest: null });

  const removed = await fetch(`${origin}/api/projects/${project.id}/technical-checks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ commandId: "removed_check" }),
  });
  assert.equal(removed.status, 404);
});

test("natural-language turns save a broken model, persist failed Run diagnostics, then repair and succeed", async (t) => {
  const { origin, runtime, conversation, app, openCode } = await start(t);
  const broken = await sendTurn(origin, conversation.id, "turn_broken", "生成一个有 Python 语法故障的模型并启动大样本实验");
  assert.equal(broken.turn.state, "complete");
  assert.match(broken.messages.at(-1).text, /文件已保存/u);
  const brokenRunId = broken.turn.actions.find((action: any) => action.actionKind === "run_start")!.runId;
  const brokenRun = runtime.store.run(brokenRunId);
  await app.projectOnlyApi!.agent!.batchRuntime.wait(brokenRun.id);
  assert.equal(runtime.store.run(brokenRun.id).status, "failed");
  assert.equal(runtime.store.project("project_http").executionLock, null);
  assert.equal(runtime.store.projectFiles("project_http")
    .find((file) => file.relativePath === "code/model.py")?.bytes.toString("utf8"), "def broken(:\n");
  assert.match(JSON.stringify(runtime.store.runCompletion(brokenRun.id)?.completion), /SyntaxError/iu);

  const fixed = await sendTurn(origin, conversation.id, "turn_fixed", "读取刚才的运行错误，修复模型，然后重新运行");
  assert.equal(fixed.turn.state, "complete");
  assert.match(fixed.messages.at(-1).text, /文件已保存/u);
  const fixedRunId = fixed.turn.actions.find((action: any) => action.actionKind === "run_start")!.runId;
  const fixedRun = runtime.store.run(fixedRunId);
  await app.projectOnlyApi!.agent!.batchRuntime.wait(fixedRun.id);
  assert.equal(
    runtime.store.run(fixedRun.id).status,
    "succeeded",
    JSON.stringify(runtime.store.runCompletion(fixedRun.id)?.completion),
  );
  assert.equal(runtime.store.runOutputs(fixedRun.id).length > 0, true);
  assert.equal(openCode.prompts.every((prompt) => prompt.scopedMcpScopeId && prompt.scopedMcpTools), true);
  assert.equal(openCode.toolLists.every((tools) => tools.includes("riff_write_project_files")
    && tools.includes("riff_read_project_run_diagnostics")
    && !tools.includes("riff_start_project_technical_check")), true);
});

test("natural-language visual startup failure persists diagnostics, unlocks, and can be repaired", async (t) => {
  const openCode = new VisualRepairOpenCode();
  const { origin, runtime, project, conversation, app } = await start(t, openCode);
  runtime.store.createExperiment({
    id: "experiment_visual",
    projectId: project.id,
    name: "Visual",
    configuration: {
      schemaVersion: 1,
      runKind: "visual",
      parameters: { steps: 2, demand: 1 },
      sampling: { kind: "single", seed: 11 },
    },
    createdAt: NOW,
  });

  const failedTurn = await sendTurn(
    origin,
    conversation.id,
    "turn_visual_failure",
    "保存可视化准备文件，并启动一个缺少 visual.html 的故障 Run",
  );
  assert.equal(failedTurn.turn.state, "complete", JSON.stringify(failedTurn));
  assert.equal(openCode.lastFailedStart?.error?.code, "tool_failed", JSON.stringify(openCode.lastFailedStart));
  assert.match(failedTurn.messages.at(-1).text, /文件已保存/u);
  const failedRun = runtime.store.runs(project.id).find((run) => run.runKind === "visual");
  assert.ok(failedRun);
  assert.equal(failedRun.status, "failed");
  assert.equal(runtime.store.project(project.id).executionLock, null);
  assert.equal(runtime.store.runCompletion(failedRun.id)?.completion.code, "visual_document_missing");

  const repairedTurn = await sendTurn(
    origin,
    conversation.id,
    "turn_visual_repair",
    "读取刚才的可视化错误，补齐缺失文件并重新运行",
  );
  assert.equal(repairedTurn.turn.state, "complete");
  assert.match(repairedTurn.messages.at(-1).text, /文件已保存/u);
  const running = runtime.store.runs(project.id)
    .filter((run) => run.runKind === "visual" && run.id !== failedRun.id)[0];
  assert.ok(running);
  assert.equal(running.status, "running");
  assert.equal(runtime.store.project(project.id).executionLock?.holderId, running.id);
  await app.projectOnlyApi!.agent!.cancelVisualRun(project.id, running.id);
  assert.equal(runtime.store.run(running.id).status, "cancelled");
  assert.equal(runtime.store.project(project.id).executionLock, null);
});

const sendTurn = async (
  origin: string,
  conversationId: string,
  requestKey: string,
  text: string,
): Promise<any> => {
  const accepted = await fetch(`${origin}/api/conversations/${conversationId}/turns`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ requestKey, text, attachmentIds: [] }),
  });
  assert.equal(accepted.status, 202, await accepted.clone().text());
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const result = await fetch(`${origin}/api/conversations/${conversationId}/turns/${requestKey}`);
    assert.equal(result.status, 200, await result.clone().text());
    const payload = await result.json() as any;
    if (payload.terminal) return payload.result;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Project-only Turn did not become terminal.");
};

const response = (text: string): OpenCodeAssistantResponse => ({
  messageId: "message_fixture",
  text,
  content: {
    source: "opencode",
    textParts: 1,
    parts: [{ ordinal: 0, kind: "text", state: "complete" }],
  },
});
