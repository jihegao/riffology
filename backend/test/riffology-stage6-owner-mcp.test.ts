import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentTurnRuntime } from "../src/agent-turn-runtime.ts";
import { AgentWorkspaceService } from "../src/agent-workspace-service.ts";
import { agentToolOperationCommitment, type AgentToolName } from "../src/agent-tools.ts";
import { ProductStoreV2 } from "../src/product-store-v2.ts";
import { SimulationSkillCatalog } from "../src/simulation-skill-catalog.ts";

const NOW = "2026-08-02T04:00:00.000Z";
const call = (name: string, args: Record<string, unknown> = {}) => ({
  jsonrpc: "2.0", id: 1, method: "tools/call",
  params: { name, arguments: args },
});
const authorize = (
  runtime: AgentTurnRuntime,
  capability: string,
  tool: AgentToolName,
  args: Record<string, unknown>,
) => runtime.authorizeConsequentialOperation(capability, {
  toolName: tool,
  operationCommitment: agentToolOperationCommitment(tool, args).digest,
});

test("owner MCP exposes fixed-copy reads and receipt-backed Experiment/Run operations without raw owner IDs", async (t) => {
  const parent = mkdtempSync(join(tmpdir(), "riff-stage6-owner-mcp-"));
  const skillRoot = join(parent, "skills"); mkdirSync(skillRoot);
  const store = ProductStoreV2.open(join(parent, "store"));
  t.after(() => { store.close(); rmSync(parent, { recursive: true, force: true }); });
  const inputSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object", additionalProperties: false,
    properties: { horizon: { type: "integer", minimum: 1 } },
    required: ["horizon"],
  };
  store.createModel({
    id: "model_owner_mcp", name: "Source", technicalStatus: "executable",
    runMode: "batch", createdAt: NOW,
    executionDescription: {
      schemaVersion: 2, runtime: "python", runMode: "batch",
      dependencyFile: "environment/requirements.txt",
      inputs: { schemaProfile: "riff-json-schema-2020-12-v1", schema: inputSchema, smoke: { horizon: 1 } },
      outputs: [{ logicalName: "summary", relativePath: "summary.json", mediaType: "application/json", required: true, role: "data" }],
      batch: { entryPoint: "code/model.py", protocol: "riff-batch-v1" },
      cancellation: { signal: "SIGTERM", graceMs: 100 },
    },
    files: [
      { id: "file_owner_mcp", kind: "model_code", relativePath: "model.py", mediaType: "text/x-python", bytes: Buffer.from("print('ok')\n") },
      { id: "env_owner_mcp", kind: "model_environment", relativePath: "requirements.txt", mediaType: "text/plain", bytes: Buffer.from("") },
    ],
  });
  store.createConversation({ id: "conversation_model_mcp", owner: { kind: "model", id: "model_owner_mcp" }, name: "Model", providerId: "provider", providerModelId: "model", createdAt: NOW });
  store.createProjectFromModel({ projectId: "project_owner_mcp", projectName: "Project", sourceModelId: "model_owner_mcp", createdAt: NOW });
  store.createConversation({ id: "conversation_project_mcp", owner: { kind: "project", id: "project_owner_mcp" }, name: "Project", providerId: "provider", providerModelId: "model", createdAt: NOW });

  const runtime = new AgentTurnRuntime(store, new SimulationSkillCatalog(skillRoot, []), { now: () => NOW });
  const revokedBrowserConversations: string[] = [];
  runtime.configureBrowserAuthority({
    async revokeConversation(conversationId: string) {
      revokedBrowserConversations.push(conversationId);
    },
    async revokeTurn() {},
    async revokeAll() {},
  } as any);
  new AgentWorkspaceService(
    store,
    { discoverProviderModels: async () => [{ providerId: "provider", modelId: "model", qualifiedId: "provider/model" }] } as any,
    () => NOW,
    { check: async () => ({
      attemptId: "attempt", aggregate: "failed", capturedWorkspaceDigest: "0".repeat(64),
      executionDescriptionDigest: "1".repeat(64), dependencyDescriptionDigest: "",
      environmentKey: "", startedAt: NOW, finishedAt: NOW,
      limits: { timeoutMs: 1, maxOutputBytes: 1, maxWorkspaceFiles: 1, maxWorkspaceBytes: 1 },
      checks: [], log: "",
    }) },
    runtime,
  );

  store.startAgentTurn({
    turnId: "turn_project_owner_mcp", userMessageId: "message_project_owner_mcp",
    conversationId: "conversation_project_mcp", requestKey: "project-owner-mcp",
    text: "Create an experiment configuration", createdAt: NOW,
  });
  store.bindAgentSession({
    id: "session_project_owner_mcp", conversationId: "conversation_project_mcp",
    expectedGeneration: 0, state: "available", externalSessionRef: "opaque-project", at: NOW,
  });
  const prepared = await runtime.prepare({
    conversationId: "conversation_project_mcp", turnId: "turn_project_owner_mcp",
    text: "Create an experiment configuration", attachmentIds: [],
  });
  t.after(() => prepared.release());
  const listed: any = await runtime.handle(prepared.capability, {
    jsonrpc: "2.0", id: 1, method: "tools/list",
  });
  const names = listed.result.tools.map((tool: any) => tool.name);
  for (const expected of [
    "riff_list_project_workspace", "riff_read_project_file",
    "riff_create_experiment_configuration", "riff_list_run_outputs",
    "riff_read_run_output", "riff_read_run_events",
  ]) assert.ok(names.includes(expected), expected);
  for (const deniedTool of [
    "riff_start_run", "riff_cancel_run", "riff_trash_run",
    "riff_restore_run", "riff_transition_owner_lifecycle",
  ]) assert.equal(names.includes(deniedTool), false, deniedTool);

  const files: any = await runtime.handle(prepared.capability, call("riff_list_project_workspace"));
  const fileList = JSON.parse(files.result.content[0].text);
  assert.ok(fileList[0].fileRef);
  assert.equal(JSON.stringify(fileList).includes("file_owner_mcp"), false);
  const read: any = await runtime.handle(prepared.capability, call("riff_read_project_file", { fileRef: fileList[0].fileRef }));
  assert.match(read.result.content[0].text, /print\('ok'\)/u);
  const crossFile: any = await runtime.handle(prepared.capability, call("riff_read_project_file", { fileRef: `project_file_${"0".repeat(48)}` }));
  assert.equal(crossFile.result.isError, true);

  const createInput = {
    requestKey: "create-experiment", name: "Agent experiment",
    configuration: { schemaVersion: 1, runKind: "batch", parameters: { horizon: 1 }, sampling: { kind: "single", seed: 1 } },
  };
  authorize(runtime, prepared.capability, "riff_create_experiment_configuration", createInput);
  const changedName: any = await runtime.handle(prepared.capability, call(
    "riff_create_experiment_configuration",
    { ...createInput, name: "Substituted experiment" },
  ));
  assert.equal(changedName.result.isError, true);
  const created: any = await runtime.handle(prepared.capability, call("riff_create_experiment_configuration", createInput));
  const createResult = JSON.parse(created.result.content[0].text);
  assert.equal(createResult.state, "committed", JSON.stringify(created));
  assert.match(createResult.receipt.recordDigest, /^[0-9a-f]{64}$/u);
  const createReplay: any = await runtime.handle(prepared.capability, call("riff_create_experiment_configuration", {
    requestKey: "create-experiment", name: "Agent experiment",
    configuration: { schemaVersion: 1, runKind: "batch", parameters: { horizon: 1 }, sampling: { kind: "single", seed: 1 } },
  }));
  assert.equal(createReplay.result.isError, true);

  store.startAgentTurn({
    turnId: "turn_project_start_mcp", userMessageId: "message_project_start_mcp",
    conversationId: "conversation_project_mcp", requestKey: "project-start-mcp",
    text: "Start the run", createdAt: NOW,
  });
  const startPrepared = await runtime.prepare({
    conversationId: "conversation_project_mcp", turnId: "turn_project_start_mcp",
    text: "Start the run", attachmentIds: [],
  });
  t.after(() => startPrepared.release());

  const startInput = {
    requestKey: "start-run", configurationId: createResult.receipt.id,
  };
  authorize(runtime, startPrepared.capability, "riff_start_run", startInput);
  const wrongConfiguration: any = await runtime.handle(startPrepared.capability, call(
    "riff_start_run", { ...startInput, configurationId: "configuration_substituted" },
  ));
  assert.equal(wrongConfiguration.result.isError, true);
  const started: any = await runtime.handle(startPrepared.capability, call("riff_start_run", startInput));
  const startResult = JSON.parse(started.result.content[0].text);
  assert.equal(startResult.state, "committed");
  assert.match(startResult.receipt.runId, /^run_/u);
  const runs: any = await runtime.handle(startPrepared.capability, call("riff_list_runs"));
  const runList = JSON.parse(runs.result.content[0].text);
  assert.ok(runList[0].runRef);
  assert.equal(JSON.stringify(runList).includes(startResult.receipt.runId), false);

  const wrongTurnCancel: any = await runtime.handle(startPrepared.capability, call("riff_cancel_run", {
    requestKey: "stale-run", runRef: `run_${"0".repeat(48)}`,
  }));
  assert.equal(wrongTurnCancel.result.isError, true);

  store.startAgentTurn({
    turnId: "turn_project_cancel_mcp", userMessageId: "message_project_cancel_mcp",
    conversationId: "conversation_project_mcp", requestKey: "project-cancel-mcp",
    text: "Cancel the run", createdAt: NOW,
  });
  const cancelPrepared = await runtime.prepare({
    conversationId: "conversation_project_mcp", turnId: "turn_project_cancel_mcp",
    text: "Cancel the run", attachmentIds: [],
  });
  t.after(() => cancelPrepared.release());
  const cancelInput = {
    requestKey: "cancel-run", runRef: runList[0].runRef,
  };
  authorize(runtime, cancelPrepared.capability, "riff_cancel_run", cancelInput);
  const substitutedRun: any = await runtime.handle(cancelPrepared.capability, call(
    "riff_cancel_run", { ...cancelInput, runRef: `run_${"0".repeat(48)}` },
  ));
  assert.equal(substitutedRun.result.isError, true);
  const cancelled: any = await runtime.handle(cancelPrepared.capability, call("riff_cancel_run", cancelInput));
  const cancelResult = JSON.parse(cancelled.result.content[0].text);
  assert.equal(cancelResult.state, "committed", JSON.stringify(cancelled));
  assert.equal(cancelResult.receipt.code, "cancellation_requested");
  assert.match(cancelResult.receiptDigest, /^[0-9a-f]{64}$/u);

  const denied: any = await runtime.handle(cancelPrepared.capability, call("riff_cancel_run", {
    requestKey: "forbidden", runRef: runList[0].runRef, runId: startResult.receipt.runId,
  }));
  assert.equal(denied.result.isError, true);
  assert.match(denied.result.content[0].text, /operation_budget_exhausted/u);

  const summary: any = await runtime.handle(prepared.capability, call("riff_read_owner_summary"));
  const owner = JSON.parse(summary.result.content[0].text);
  store.startAgentTurn({
    turnId: "turn_project_rename_mcp", userMessageId: "message_project_rename_mcp",
    conversationId: "conversation_project_mcp", requestKey: "project-rename-mcp",
    text: "Rename this Project", createdAt: NOW,
  });
  const renamePrepared = await runtime.prepare({
    conversationId: "conversation_project_mcp", turnId: "turn_project_rename_mcp",
    text: "Rename this Project", attachmentIds: [],
  });
  t.after(() => renamePrepared.release());
  const renameInput = {
    requestKey: "rename-owner", action: "rename",
    expectedRecordDigest: owner.recordDigest, name: "Renamed Project",
  };
  authorize(runtime, renamePrepared.capability, "riff_transition_owner_lifecycle", renameInput);
  const substitutedName: any = await runtime.handle(renamePrepared.capability, call(
    "riff_transition_owner_lifecycle", { ...renameInput, name: "Substituted Project" },
  ));
  assert.equal(substitutedName.result.isError, true);
  const renamed: any = await runtime.handle(renamePrepared.capability, call("riff_transition_owner_lifecycle", renameInput));
  const renameResult = JSON.parse(renamed.result.content[0].text);
  assert.equal(renameResult.state, "committed", JSON.stringify(renamed));
  assert.equal(store.getProject("project_owner_mcp").name, "Renamed Project");

  store.startAgentTurn({
    turnId: "turn_project_archive_mcp", userMessageId: "message_project_archive_mcp",
    conversationId: "conversation_project_mcp", requestKey: "project-archive-mcp",
    text: "Archive this Project", createdAt: NOW,
  });
  const archivePrepared = await runtime.prepare({
    conversationId: "conversation_project_mcp", turnId: "turn_project_archive_mcp",
    text: "Archive this Project", attachmentIds: [],
  });
  t.after(() => archivePrepared.release());
  const currentOwner: any = await runtime.handle(
    archivePrepared.capability,
    call("riff_read_owner_summary"),
  );
  const archiveInput = {
    requestKey: "archive-owner", action: "archive",
    expectedRecordDigest: JSON.parse(currentOwner.result.content[0].text).recordDigest,
  };
  authorize(runtime, archivePrepared.capability, "riff_transition_owner_lifecycle", archiveInput);
  const archived: any = await runtime.handle(
    archivePrepared.capability,
    call("riff_transition_owner_lifecycle", archiveInput),
  );
  assert.equal(JSON.parse(archived.result.content[0].text).state, "committed");
  const staleAfterArchive: any = await runtime.handle(
    archivePrepared.capability,
    call("riff_read_owner_summary"),
  );
  assert.equal(staleAfterArchive.error?.code, -32001);
  assert.deepEqual(revokedBrowserConversations, ["conversation_project_mcp"]);
  assert.equal(await store.getConversationRuntime("conversation_project_mcp"), null);
  assert.throws(() => store.startAgentTurn({
    turnId: "turn_after_owner_archive", userMessageId: "message_after_owner_archive",
    conversationId: "conversation_project_mcp", requestKey: "after-owner-archive",
    text: "Create an experiment configuration", createdAt: NOW,
  }), /unexpected number/u);
  assert.equal(
    store.agentGoalEvidence("conversation_project_mcp", "project-owner-mcp")
      .affectedResourcesVerified,
    true,
    "terminal goal evidence must verify every authoritative Experiment, Run, and lifecycle receipt",
  );
});

test("Model owner MCP can start a technical check and exposes owner lifecycle digest", async (t) => {
  const parent = mkdtempSync(join(tmpdir(), "riff-stage6-model-mcp-"));
  const skillRoot = join(parent, "skills"); mkdirSync(skillRoot);
  const store = ProductStoreV2.open(join(parent, "store"));
  t.after(() => { store.close(); rmSync(parent, { recursive: true, force: true }); });
  store.createModel({ id: "model_check_mcp", name: "Check", technicalStatus: "draft", runMode: "batch", executionDescription: {}, createdAt: NOW,
    files: [{ id: "file_check_mcp", kind: "model_code", relativePath: "model.py", mediaType: "text/x-python", bytes: Buffer.from("print('ok')\n") }] });
  store.createConversation({ id: "conversation_check_mcp", owner: { kind: "model", id: "model_check_mcp" }, name: "Model", providerId: "provider", providerModelId: "model", createdAt: NOW });
  const runtime = new AgentTurnRuntime(store, new SimulationSkillCatalog(skillRoot, []), { now: () => NOW });
  new AgentWorkspaceService(store, { discoverProviderModels: async () => [] } as any, () => NOW, {
    check: async () => { throw new Error("bounded failure"); },
  }, runtime);
  store.startAgentTurn({ turnId: "turn_check_mcp", userMessageId: "message_check_mcp", conversationId: "conversation_check_mcp", requestKey: "check", text: "Start the technical check", createdAt: NOW });
  store.bindAgentSession({ id: "session_check_mcp", conversationId: "conversation_check_mcp", expectedGeneration: 0, state: "available", externalSessionRef: "opaque-model", at: NOW });
  const prepared = await runtime.prepare({ conversationId: "conversation_check_mcp", turnId: "turn_check_mcp", text: "Start the technical check", attachmentIds: [] });
  t.after(() => prepared.release());
  const tools: any = await runtime.handle(prepared.capability, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  const names = tools.result.tools.map((tool: any) => tool.name);
  assert.ok(names.includes("riff_start_model_technical_check"));
  assert.ok(!names.includes("riff_transition_owner_lifecycle"));
  const summary: any = await runtime.handle(prepared.capability, call("riff_read_owner_summary"));
  assert.match(JSON.parse(summary.result.content[0].text).recordDigest, /^[0-9a-f]{64}$/u);
  const checkInput = { requestKey: "technical-check" };
  authorize(runtime, prepared.capability, "riff_start_model_technical_check", checkInput);
  const checked: any = await runtime.handle(prepared.capability, call("riff_start_model_technical_check", checkInput));
  const result = JSON.parse(checked.result.content[0].text);
  assert.equal(result.state, "committed", JSON.stringify(checked));
  assert.equal(result.receipt.claim, "technical_execution_only");
  assert.equal(
    store.agentGoalEvidence("conversation_check_mcp", "check")
      .affectedResourcesVerified,
    true,
    "terminal goal evidence must verify the actual technical-check record",
  );
});
