import assert from "node:assert/strict";
import test from "node:test";
import { AgentMcpServer } from "../src/agent-mcp.ts";
import {
  agentToolOperationCommitment,
  toolsForOwner,
  type AgentToolGrant,
  type AgentToolName,
} from "../src/agent-tools.ts";
import { McpToolServer as LegacyMcpToolServer } from "../src/mcp.ts";
import { validateExecutionDescriptionV2 } from "../src/execution-protocol-v2.ts";
import { JSON_SCHEMA_2020_12 } from "../src/experiment-planner.ts";
import { createGenericModelScaffold } from "../src/model-workspace.ts";
import { ProjectStore } from "../src/project-store.ts";
import { SimulationActions } from "../src/simulation-actions.ts";

const call = (name: string, args: Record<string, unknown> = {}) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
const authorize = (
  server: AgentMcpServer,
  capability: string,
  tool: AgentToolName,
  args: Record<string, unknown>,
) => server.authorizeConsequentialOperation(capability, {
  toolName: tool,
  operationCommitment: agentToolOperationCommitment(tool, args).digest,
});

test("Agent capabilities bind conversation, owner, turn, generation and exact tools", async () => {
  let now = 10;
  const seen: AgentToolGrant[] = [];
  const server = new AgentMcpServer({ async execute(grant) { seen.push(grant); return { ok: true }; } }, { now: () => now, ttlMs: 5 });
  const projectCapability = server.grant({ conversationId: "conversation_project", owner: { kind: "project", id: "project_a" }, turnId: "turn_a", externalSessionGeneration: 2, allowedTools: toolsForOwner({ kind: "project", id: "project_a" }) });
  const listed = await server.handle(projectCapability, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  const names = ((listed?.result as any).tools as any[]).map((item) => item.name);
  assert.ok(!names.includes("riff_apply_model_changes"));
  assert.ok(names.includes("riff_list_experiment_configurations"));
  assert.ok(names.includes("riff_update_experiment_configuration"));
  assert.ok(names.includes("riff_create_analysis_document"));
  assert.ok(!names.includes("riff_create_temporary_document"));
  assert.ok(names.includes("riff_observe_current_visual"));
  assert.ok(!names.includes("riff_interact_current_visual"));
  assert.ok(!names.includes("riff_drive_workbench_ui"));
  const denied = await server.handle(projectCapability, call("riff_apply_model_changes", { requestKey: "r", changes: [{}] }));
  assert.equal((denied?.result as any).isError, true);
  const analysisInput = { name: "Analysis", mediaType: "text/markdown", content: "x" };
  authorize(server, projectCapability, "riff_create_analysis_document", analysisInput);
  const allowed = await server.handle(projectCapability, call("riff_create_analysis_document", analysisInput));
  assert.equal((allowed?.result as any).isError, undefined);
  assert.deepEqual(seen[0]?.owner, { kind: "project", id: "project_a" });
  assert.equal(seen[0]?.externalSessionGeneration, 2);
  server.revokeSessionGeneration("conversation_project", 2);
  assert.equal((await server.handle(projectCapability, { jsonrpc: "2.0", id: 1, method: "tools/list" }))?.error?.code, -32001);

  const expiring = server.grant({ conversationId: "conversation_model", owner: { kind: "model", id: "model_a" }, turnId: "turn_b", externalSessionGeneration: 1, allowedTools: toolsForOwner({ kind: "model", id: "model_a" }) });
  now = 15;
  assert.equal((await server.handle(expiring, { jsonrpc: "2.0", id: 1, method: "tools/list" }))?.error?.code, -32001);
});

test("Project-only MCP publishes composite delivery and no-argument visual-open contracts", async () => {
  const server = new AgentMcpServer({ async execute() { return { ok: true }; } });
  const capability = server.grant({
    conversationId: "conversation_project_only",
    owner: { kind: "project", id: "project_only" },
    turnId: "turn_project_only",
    externalSessionGeneration: 1,
    allowedTools: new Set([
      ...toolsForOwner({ kind: "project", id: "project_only" }),
      "riff_write_project_files" as const,
    ]),
  });
  const listed = await server.handle(capability, {
    jsonrpc: "2.0", id: 1, method: "tools/list",
  });
  const tools = (listed?.result as any).tools as any[];
  const names = tools.map((tool) => tool.name);
  assert.ok(names.includes("riff_start_project_technical_check"));
  assert.ok(names.includes("riff_deliver_project_changes"));
  assert.ok(names.includes("riff_open_current_visualization"));
  assert.ok(names.includes("riff_list_experiment_configurations"));
  assert.ok(names.includes("riff_start_run"));
  assert.ok(names.includes("riff_list_run_outputs"));
  assert.ok(!names.includes("riff_apply_model_changes"));
  assert.deepEqual(
    tools.find((tool) => tool.name === "riff_open_current_visualization")
      ?.inputSchema,
    { type: "object", properties: {}, additionalProperties: false },
  );
  const delivery = tools.find((tool) =>
    tool.name === "riff_deliver_project_changes")?.inputSchema;
  assert.deepEqual(delivery.required, [
    "requestKey", "expectedWorkspaceDigest", "changes",
  ]);
  assert.deepEqual(
    delivery.properties.changes.items.properties.kind.enum,
    ["code", "environment", "visual_asset"],
  );
  assert.doesNotMatch(
    JSON.stringify(delivery),
    /modelId|sourceModelId|modelSnapshotDigest|ownerKind|ownerId/u,
  );
  for (const name of ["riff_deliver_project_changes", "riff_write_project_files"]) {
    const execution = tools.find((tool) => tool.name === name)
      ?.inputSchema?.properties?.executionDescription;
    const inputSchema = execution?.properties?.inputs?.properties?.schema;
    assert.deepEqual(inputSchema?.required, ["$schema"]);
    assert.deepEqual(inputSchema?.properties?.$schema?.enum, [JSON_SCHEMA_2020_12]);
    assert.match(inputSchema?.description ?? "", /must declare "\$schema" exactly/u);
    const eventSchema = execution?.properties?.batch?.properties?.domainEvents
      ?.properties?.payloadSchema?.properties?.schema;
    assert.deepEqual(eventSchema?.required, ["$schema"]);
    assert.deepEqual(eventSchema?.properties?.$schema?.enum, [JSON_SCHEMA_2020_12]);
  }
});

test("default Agent capability leaves a bounded human review window for large operations", async () => {
  let now = 0;
  const server = new AgentMcpServer(
    { async execute() { return { ok: true }; } },
    { now: () => now },
  );
  const capability = server.grant({
    conversationId: "conversation_large_review",
    owner: { kind: "model", id: "model_large_review" },
    turnId: "turn_large_review",
    externalSessionGeneration: 1,
    allowedTools: toolsForOwner({ kind: "model", id: "model_large_review" }),
  });

  now = 10 * 60_000 + 1;
  assert.equal(
    (await server.handle(capability, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    }))?.error,
    undefined,
  );

  now = 30 * 60_000;
  assert.equal(
    (await server.handle(capability, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    }))?.error?.code,
    -32001,
  );
});

test("Experiment MCP definitions publish the closed ExperimentConfigurationV1 envelope", async () => {
  const server = new AgentMcpServer({ async execute() { return {}; } });
  const capability = server.grant({
    conversationId: "conversation_experiment_schema",
    owner: { kind: "project", id: "project_experiment_schema" },
    turnId: "turn_experiment_schema",
    externalSessionGeneration: 1,
    allowedTools: toolsForOwner({ kind: "project", id: "project_experiment_schema" }),
  });
  const listed = await server.handle(capability, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
  });
  const tools = (listed?.result as any).tools as any[];
  for (const name of [
    "riff_create_experiment_configuration",
    "riff_update_experiment_configuration",
  ]) {
    const configuration = tools.find((tool) => tool.name === name)
      ?.inputSchema?.properties?.configuration;
    assert.equal(configuration?.type, "object");
    assert.deepEqual(configuration?.required, [
      "schemaVersion",
      "runKind",
      "parameters",
      "sampling",
    ]);
    assert.equal(configuration?.additionalProperties, false);
    assert.deepEqual(configuration?.properties?.schemaVersion?.enum, [1]);
    assert.deepEqual(configuration?.properties?.runKind?.enum, ["batch", "visual"]);
    assert.equal(configuration?.properties?.parameters?.type, "object");
    assert.deepEqual(configuration?.properties?.parameters?.additionalProperties, {});
    const sampling = configuration?.properties?.sampling?.oneOf;
    assert.equal(sampling?.length, 3);
    assert.deepEqual(sampling?.map((variant: any) => variant.properties.kind.enum[0]), [
      "single",
      "multiple-seeds",
      "cartesian-sweep",
    ]);
    assert.ok(sampling.every((variant: any) => variant.additionalProperties === false));
    assert.deepEqual(sampling[1].required, ["kind", "seeds"]);
    assert.equal(sampling[1].properties.seeds.uniqueItems, true);
    assert.deepEqual(sampling[2].required, ["kind", "axes"]);
    assert.equal(sampling[2].properties.axes.minItems, 1);
    assert.equal(sampling[2].properties.axes.items.additionalProperties, false);
    assert.deepEqual(sampling[2].properties.axes.items.required, ["pointer", "values"]);
  }
});

test("Model mutation MCP definitions publish the complete optional execution-description v2 contract", async () => {
  const server = new AgentMcpServer({ async execute() { return {}; } });
  const capability = server.grant({
    conversationId: "conversation_model_execution_schema",
    owner: { kind: "model", id: "model_execution_schema" },
    turnId: "turn_model_execution_schema",
    externalSessionGeneration: 1,
    allowedTools: toolsForOwner({ kind: "model", id: "model_execution_schema" }),
  });
  const listed = await server.handle(capability, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
  });
  const tools = (listed?.result as any).tools as any[];
  for (const name of ["riff_apply_model_changes", "riff_propose_model_changes"]) {
    const tool = tools.find((candidate) => candidate.name === name);
    const execution = tool?.inputSchema?.properties?.executionDescription;
    assert.match(tool?.description ?? "", /Omit executionDescription/u);
    assert.deepEqual(execution?.required, [
      "schemaVersion",
      "runtime",
      "runMode",
      "dependencyFile",
      "inputs",
      "outputs",
      "cancellation",
    ]);
    assert.equal(execution?.additionalProperties, false);
    assert.deepEqual(execution?.properties?.schemaVersion?.enum, [2]);
    assert.deepEqual(execution?.properties?.runtime?.enum, ["python"]);
    assert.deepEqual(execution?.properties?.inputs?.properties?.schemaProfile?.enum, [
      "riff-json-schema-2020-12-v1",
    ]);
    assert.deepEqual(execution?.properties?.batch?.properties?.protocol?.enum, [
      "riff-batch-v1",
    ]);
    assert.deepEqual(execution?.properties?.visual?.properties?.protocol?.enum, [
      "riff-visual-v1",
    ]);
  }
});

test("Model mutation contract errors stay actionable instead of degrading to tool_failed", async () => {
  const server = new AgentMcpServer({
    async execute() {
      throw Object.assign(new Error("internal execution contract detail"), {
        code: "execution_protocol_upgrade_required",
      });
    },
  });
  const capability = server.grant({
    conversationId: "conversation_model_invalid_execution",
    owner: { kind: "model", id: "model_invalid_execution" },
    turnId: "turn_model_invalid_execution",
    externalSessionGeneration: 1,
    allowedTools: new Set(["riff_propose_model_changes"]),
  });
  const response = await server.handle(capability, call(
    "riff_propose_model_changes",
    {
      requestKey: "proposal_without_execution_change",
      changes: [{
        objectFileId: "file_model",
        kind: "model_code",
        relativePath: "model.py",
        mediaType: "text/x-python",
        text: "value = 1\n",
        expectedPriorSha256: "a".repeat(64),
      }],
    },
  ));
  const content = (response?.result as any).content[0].text as string;
  assert.equal((response?.result as any).isError, true);
  assert.match(content, /invalid_tool_input/u);
  assert.match(content, /omit it when only Model files change/u);
  assert.doesNotMatch(content, /internal execution contract detail/u);
  assert.doesNotMatch(content, /tool_failed/u);
});

test("one consequential Agent capability is consumed synchronously across concurrent calls", async () => {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let calls = 0;
  const server = new AgentMcpServer({
    async execute() {
      calls += 1;
      entered();
      await gate;
      return { ok: true };
    },
  });
  const capability = server.grant({
    conversationId: "conversation_budget",
    owner: { kind: "project", id: "project_budget" },
    turnId: "turn_budget",
    externalSessionGeneration: 1,
    allowedTools: new Set(["riff_start_run"]),
  });
  const firstInput = {
    requestKey: "run_first",
    configurationId: "configuration_a",
  };
  authorize(server, capability, "riff_start_run", firstInput);
  const first = server.handle(capability, call("riff_start_run", firstInput));
  await started;
  const concurrent = await server.handle(capability, call("riff_start_run", {
    requestKey: "run_concurrent",
    configurationId: "configuration_b",
  }));
  assert.equal((concurrent?.result as any).isError, true);
  assert.match((concurrent?.result as any).content[0].text, /operation_budget_exhausted/u);
  assert.equal(calls, 1);

  release();
  assert.equal(((await first)?.result as any).isError, undefined);
  const sequential = await server.handle(capability, call("riff_start_run", {
    requestKey: "run_after_success",
    configurationId: "configuration_c",
  }));
  assert.equal((sequential?.result as any).isError, true);
  assert.match((sequential?.result as any).content[0].text, /operation_budget_exhausted/u);
  assert.equal(calls, 1);
});

test("explicit Project-only implicit authority is tool-scoped and synchronously budgeted", async () => {
  let calls = 0;
  const server = new AgentMcpServer({
    async execute() { calls += 1; return { ok: true }; },
  });
  const capability = server.grant({
    conversationId: "conversation_implicit_budget",
    owner: { kind: "project", id: "project_implicit_budget" },
    turnId: "turn_implicit_budget",
    externalSessionGeneration: 1,
    allowedTools: new Set([
      "riff_create_experiment_configuration",
      "riff_list_project_workspace",
    ]),
    implicitConsequentialToolBudgets: new Map([
      ["riff_create_experiment_configuration", 2],
    ]),
    intentAuthority: "explicit",
  });
  const experiment = (requestKey: string) => call(
    "riff_create_experiment_configuration",
    {
      requestKey,
      name: requestKey,
      configuration: {
        schemaVersion: 1,
        runKind: "batch",
        parameters: {},
        sampling: { kind: "single" },
      },
    },
  );
  assert.equal((await server.handle(capability, experiment("experiment_one")))?.result?.isError, undefined);
  assert.equal((await server.handle(capability, experiment("experiment_two")))?.result?.isError, undefined);
  const exhausted = await server.handle(capability, experiment("experiment_three"));
  assert.equal((exhausted?.result as any).isError, true);
  assert.match((exhausted?.result as any).content[0].text, /operation_budget_exhausted/u);
  assert.equal(calls, 2);
  assert.throws(() => server.grant({
    conversationId: "conversation_proposal_budget",
    owner: { kind: "project", id: "project_proposal_budget" },
    turnId: "turn_proposal_budget",
    externalSessionGeneration: 1,
    allowedTools: new Set(["riff_create_experiment_configuration"]),
    implicitConsequentialToolBudgets: new Map([
      ["riff_create_experiment_configuration", 1],
    ]),
    intentAuthority: "proposal_only",
  }), /Implicit Agent tool budgets/u);
});

test("explicit Project file path authority rejects out-of-scope writes before budget consumption", async () => {
  for (const [suffix, authority, deniedPath, allowedPath] of [
    [
      "exact",
      [{ kind: "exact", normalizedPath: "requirements/modeling-requirements.md" }],
      "code/model.py",
      "Requirements/Modeling-Requirements.md",
    ],
    [
      "prefix",
      [{ kind: "prefix", normalizedPath: "requirements/" }],
      "requirements-evil/model.md",
      "requirements/domain/model.md",
    ],
  ] as const) {
    let calls = 0;
    const server = new AgentMcpServer({
      async execute() { calls += 1; return { ok: true }; },
    });
    const capability = server.grant({
      conversationId: `conversation_path_${suffix}`,
      owner: { kind: "project", id: `project_path_${suffix}` },
      turnId: `turn_path_${suffix}`,
      externalSessionGeneration: 1,
      allowedTools: new Set(["riff_write_project_files"]),
      implicitConsequentialToolBudgets: new Map([["riff_write_project_files", 1]]),
      implicitProjectFilePathAuthority: authority,
      intentAuthority: "explicit",
    });
    const write = (requestKey: string, relativePath: string) => call(
      "riff_write_project_files",
      {
        requestKey,
        expectedWorkspaceDigest: "a".repeat(64),
        changes: [{
          operation: "upsert",
          relativePath,
          mediaType: "text/markdown",
          text: "# Authorized artifact\n",
          expectedPriorSha256: null,
        }],
      },
    );

    const denied = await server.handle(capability, write(`denied_${suffix}`, deniedPath));
    assert.equal((denied?.result as any).isError, true);
    assert.match((denied?.result as any).content[0].text, /tool_not_allowed/u);
    assert.equal(calls, 0);

    const allowed = await server.handle(capability, write(`allowed_${suffix}`, allowedPath));
    assert.equal((allowed?.result as any).isError, undefined, JSON.stringify(allowed));
    assert.equal(calls, 1);

    const exhausted = await server.handle(capability, write(`exhausted_${suffix}`, allowedPath));
    assert.equal((exhausted?.result as any).isError, true);
    assert.match((exhausted?.result as any).content[0].text, /operation_budget_exhausted/u);
    assert.equal(calls, 1);
  }
});

test("execution-contract validation explains the exact dialect before reserving implicit budget", async () => {
  let calls = 0;
  const server = new AgentMcpServer({
    async execute(_grant, _tool, input) {
      calls += 1;
      validateExecutionDescriptionV2(input.executionDescription);
      return { ok: true };
    },
  });
  const capability = server.grant({
    conversationId: "conversation_execution_retry",
    owner: { kind: "project", id: "project_execution_retry" },
    turnId: "turn_execution_retry",
    externalSessionGeneration: 1,
    allowedTools: new Set(["riff_write_project_files"]),
    implicitConsequentialToolBudgets: new Map([["riff_write_project_files", 1]]),
    intentAuthority: "explicit",
  });
  const description = structuredClone(
    createGenericModelScaffold("model_execution_retry").executionDescription,
  ) as any;
  delete description.inputs.schema.$schema;
  const write = (requestKey: string, executionDescription: Record<string, unknown>) => call(
    "riff_write_project_files",
    {
      requestKey,
      expectedWorkspaceDigest: "a".repeat(64),
      changes: [{
        operation: "upsert",
        relativePath: "code/model.py",
        mediaType: "text/x-python",
        text: "value = 1\n",
        expectedPriorSha256: null,
      }],
      executionDescription,
    },
  );
  const rejected = await server.handle(capability, write("write_invalid", description));
  const rejectedContent = (rejected?.result as any).content[0].text as string;
  assert.equal((rejected?.result as any).isError, true);
  assert.match(rejectedContent, /invalid_tool_input/u);
  assert.match(rejectedContent, /inputs\.schema\.\$schema/u);
  assert.match(rejectedContent, new RegExp(JSON_SCHEMA_2020_12.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));

  const corrected = await server.handle(capability, write(
    "write_corrected",
    createGenericModelScaffold("model_execution_retry").executionDescription,
  ));
  assert.equal((corrected?.result as any).isError, undefined);
  assert.equal(calls, 1);

  const exhausted = await server.handle(capability, write(
    "write_after_success",
    createGenericModelScaffold("model_execution_retry").executionDescription,
  ));
  assert.equal((exhausted?.result as any).isError, true);
  assert.match((exhausted?.result as any).content[0].text, /operation_budget_exhausted/u);
  assert.equal(calls, 1);
});

test("untyped invalid-tool failures stay redacted and consume implicit mutation budget", async () => {
  let calls = 0;
  const server = new AgentMcpServer({
    async execute() {
      calls += 1;
      throw Object.assign(new Error("secret executor detail"), { code: "invalid_tool_input" });
    },
  });
  const capability = server.grant({
    conversationId: "conversation_untyped_invalid",
    owner: { kind: "project", id: "project_untyped_invalid" },
    turnId: "turn_untyped_invalid",
    externalSessionGeneration: 1,
    allowedTools: new Set(["riff_write_project_files"]),
    implicitConsequentialToolBudgets: new Map([["riff_write_project_files", 1]]),
    intentAuthority: "explicit",
  });
  const input = {
    requestKey: "write_untyped_invalid",
    expectedWorkspaceDigest: "a".repeat(64),
    changes: [{
      operation: "upsert",
      relativePath: "notes.txt",
      mediaType: "text/plain",
      text: "note\n",
      expectedPriorSha256: null,
    }],
  };
  const rejected = await server.handle(capability, call("riff_write_project_files", input));
  const content = (rejected?.result as any).content[0].text as string;
  assert.match(content, /invalid_tool_input/u);
  assert.doesNotMatch(content, /secret executor detail/u);
  const exhausted = await server.handle(capability, call("riff_write_project_files", {
    ...input,
    requestKey: "write_after_untyped_invalid",
  }));
  assert.match((exhausted?.result as any).content[0].text, /operation_budget_exhausted/u);
  assert.equal(calls, 1);
});

test("allow-once permission binds the exact normalized consequential parameters", async () => {
  let calls = 0;
  const server = new AgentMcpServer({
    async execute() { calls += 1; return { ok: true }; },
  });
  const capability = server.grant({
    conversationId: "conversation_exact_permission",
    owner: { kind: "project", id: "project_exact_permission" },
    turnId: "turn_exact_permission",
    externalSessionGeneration: 1,
    allowedTools: new Set(["riff_transition_owner_lifecycle"]),
  });
  const approved = {
    requestKey: "rename_exact",
    action: "rename",
    expectedRecordDigest: "a".repeat(64),
    name: "Approved name",
  };
  authorize(server, capability, "riff_transition_owner_lifecycle", approved);
  for (const substituted of [
    { ...approved, name: "Substituted name" },
    { ...approved, expectedRecordDigest: "b".repeat(64) },
    { ...approved, action: "archive", name: undefined },
  ]) {
    const result = await server.handle(
      capability,
      call("riff_transition_owner_lifecycle", substituted),
    );
    assert.equal((result?.result as any).isError, true);
    assert.match((result?.result as any).content[0].text, /allow-once permission/u);
  }
  assert.equal(calls, 0);
  const accepted = await server.handle(
    capability,
    call("riff_transition_owner_lifecycle", approved),
  );
  assert.equal((accepted?.result as any).isError, undefined);
  assert.equal(calls, 1);
});

test("a second pending consequential approval revokes instead of overwriting the first", async () => {
  let calls = 0;
  const server = new AgentMcpServer({
    async execute() { calls += 1; return { ok: true }; },
  });
  const capability = server.grant({
    conversationId: "conversation_competing_permissions",
    owner: { kind: "project", id: "project_competing_permissions" },
    turnId: "turn_competing_permissions",
    externalSessionGeneration: 1,
    allowedTools: new Set(["riff_start_run"]),
  });
  const first = { requestKey: "first", configurationId: "configuration_a" };
  const second = { requestKey: "second", configurationId: "configuration_b" };
  authorize(server, capability, "riff_start_run", first);
  assert.throws(
    () => authorize(server, capability, "riff_start_run", second),
    /competing consequential permission/u,
  );
  for (const input of [first, second]) {
    const response = await server.handle(
      capability,
      call("riff_start_run", input),
    );
    assert.equal(response?.error?.code, -32001);
  }
  assert.equal(calls, 0);
});

test("repeating an identical pending consequential approval is idempotent", async () => {
  let calls = 0;
  const server = new AgentMcpServer({
    async execute() { calls += 1; return { ok: true }; },
  });
  const capability = server.grant({
    conversationId: "conversation_idempotent_permission",
    owner: { kind: "project", id: "project_idempotent_permission" },
    turnId: "turn_idempotent_permission",
    externalSessionGeneration: 1,
    allowedTools: new Set(["riff_start_run"]),
  });
  const input = { requestKey: "same_request", configurationId: "configuration_a" };
  authorize(server, capability, "riff_start_run", input);
  assert.doesNotThrow(() => authorize(server, capability, "riff_start_run", input));
  const response = await server.handle(capability, call("riff_start_run", input));
  assert.equal((response?.result as any).isError, undefined);
  assert.equal(calls, 1);
});

test("a fresh approval can replace an exact operation rejected before execution", async () => {
  let calls = 0;
  const server = new AgentMcpServer({
    async execute() { calls += 1; return { ok: true }; },
  });
  const capability = server.grant({
    conversationId: "conversation_corrected_permission",
    owner: { kind: "model", id: "model_corrected_permission" },
    turnId: "turn_corrected_permission",
    externalSessionGeneration: 1,
    allowedTools: new Set(["riff_apply_model_changes"]),
  });
  const malformed = {
    requestKey: "apply_visual",
    changes: [{
      objectFileId: "file_visual",
      kind: "model_visual_asset",
      relativePath: "diagram.html",
      mediaType: "text/html",
      text: "<html></html>",
      expectedPriorSha256: null,
    }],
    executionDescription: { ownerId: "attempted_scope_override" },
  };
  authorize(server, capability, "riff_apply_model_changes", malformed);
  const rejected = await server.handle(
    capability,
    call("riff_apply_model_changes", malformed),
  );
  assert.equal((rejected?.result as any).isError, true);
  assert.match((rejected?.result as any).content[0].text, /server-owned scope/u);
  assert.equal(calls, 0);

  const corrected = {
    requestKey: "apply_visual",
    changes: malformed.changes,
  };
  assert.doesNotThrow(() => authorize(
    server,
    capability,
    "riff_apply_model_changes",
    corrected,
  ));
  const applied = await server.handle(
    capability,
    call("riff_apply_model_changes", corrected),
  );
  assert.equal((applied?.result as any).isError, undefined);
  assert.equal(calls, 1);
});

test("a failed consequential Agent operation still consumes the turn budget", async () => {
  let calls = 0;
  const server = new AgentMcpServer({
    async execute() {
      calls += 1;
      throw new Error("bounded failure");
    },
  });
  const capability = server.grant({
    conversationId: "conversation_failed_budget",
    owner: { kind: "model", id: "model_failed_budget" },
    turnId: "turn_failed_budget",
    externalSessionGeneration: 1,
    allowedTools: new Set(["riff_start_model_technical_check"]),
  });
  const firstInput = {
    requestKey: "check_first",
  };
  authorize(server, capability, "riff_start_model_technical_check", firstInput);
  const failed = await server.handle(capability, call("riff_start_model_technical_check", firstInput));
  assert.equal((failed?.result as any).isError, true);
  assert.match((failed?.result as any).content[0].text, /tool_failed/u);
  const retry = await server.handle(capability, call("riff_start_model_technical_check", {
    requestKey: "check_retry",
  }));
  assert.equal((retry?.result as any).isError, true);
  assert.match((retry?.result as any).content[0].text, /operation_budget_exhausted/u);
  assert.equal(calls, 1);
});

test("generated-view publication accepts an OpenCode JSON-stringified views array", async () => {
  let received: Record<string, unknown> | undefined;
  const server = new AgentMcpServer({
    async execute(_grant, _tool, input) {
      received = input;
      return { ok: true };
    },
  });
  const capability = server.grant({
    conversationId: "conversation_model",
    owner: { kind: "model", id: "model_a" },
    turnId: "turn_views",
    externalSessionGeneration: 1,
    allowedTools: toolsForOwner({ kind: "model", id: "model_a" }),
  });
  const views = [{
    id: "view_class_diagram",
    title: "Class diagram",
    mediaType: "image/svg+xml",
    payload: "<svg xmlns=\"http://www.w3.org/2000/svg\"/>",
    sourceFileIds: ["file_model_code"],
  }];

  const response = await server.handle(capability, call(
    "riff_publish_model_generated_views",
    { requestKey: "publish_class_diagram", views: JSON.stringify(views) },
  ));

  assert.equal((response?.result as any).isError, undefined, JSON.stringify(response));
  assert.deepEqual(received?.views, views);
});

test("generated-view publication rejects malformed serialized views before execution", async () => {
  let calls = 0;
  const server = new AgentMcpServer({ async execute() { calls += 1; return { ok: true }; } });
  const capability = server.grant({
    conversationId: "conversation_model",
    owner: { kind: "model", id: "model_a" },
    turnId: "turn_invalid_views",
    externalSessionGeneration: 1,
    allowedTools: toolsForOwner({ kind: "model", id: "model_a" }),
  });

  const response = await server.handle(capability, call(
    "riff_publish_model_generated_views",
    { requestKey: "invalid_views", views: "{not-json}" },
  ));

  assert.equal((response?.result as any).isError, true);
  assert.equal(calls, 0);
});

test("screenshot observation is returned as bounded MCP image content", async () => {
  const server = new AgentMcpServer({
    async execute() {
      return {
        schemaVersion: 1,
        kind: "observe_screenshot",
        untrusted: true,
        contentType: "image/png",
        pngBase64: Buffer.from([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        ]).toString("base64"),
      };
    },
  });
  const capability = server.grant({
    conversationId: "conversation_project",
    owner: { kind: "project", id: "project_a" },
    turnId: "turn_a",
    externalSessionGeneration: 1,
    allowedTools: toolsForOwner({ kind: "project", id: "project_a" }),
  });
  const response = await server.handle(
    capability,
    call("riff_observe_current_visual", { kind: "screenshot" }),
  );
  assert.deepEqual((response?.result as any).content, [
    {
      type: "text",
      text: JSON.stringify({
        schemaVersion: 1,
        kind: "observe_screenshot",
        untrusted: true,
        contentType: "image/png",
      }),
    },
    {
      type: "image",
      data: Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]).toString("base64"),
      mimeType: "image/png",
    },
  ]);
});

test("Browser screenshot is returned as strict bounded MCP image content", async () => {
  const pngBase64 = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]).toString("base64");
  const server = new AgentMcpServer({
    async execute() {
      return { schemaVersion: 1, pageGeneration: 9, contentType: "image/png", pngBase64 };
    },
  });
  const capability = server.grant({
    conversationId: "conversation_browser_shot",
    owner: { kind: "model", id: "model_browser_shot" },
    turnId: "turn_browser_shot",
    externalSessionGeneration: 1,
    allowedTools: toolsForOwner({ kind: "model", id: "model_browser_shot" }),
  });
  const response = await server.handle(capability, call("browser_screenshot"));
  assert.deepEqual((response?.result as any).content, [{
    type: "text",
    text: JSON.stringify({
      schemaVersion: 1,
      kind: "browser_screenshot",
      pageGeneration: 9,
      contentType: "image/png",
    }),
  }, { type: "image", data: pngBase64, mimeType: "image/png" }]);

  for (const invalid of [{
    schemaVersion: 1,
    pageGeneration: 9,
    contentType: "image/png",
    pngBase64,
    capability: "must-not-pass",
  }, {
    schemaVersion: 1,
    pageGeneration: 9,
    contentType: "image/png",
    pngBase64: Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(4 * 1024 * 1024),
    ]).toString("base64"),
  }]) {
    const rejecting = new AgentMcpServer({ async execute() { return invalid; } });
    const rejectedCapability = rejecting.grant({
      conversationId: "conversation_browser_shot",
      owner: { kind: "model", id: "model_browser_shot" },
      turnId: "turn_browser_shot_invalid",
      externalSessionGeneration: 1,
      allowedTools: toolsForOwner({ kind: "model", id: "model_browser_shot" }),
    });
    const denied = await rejecting.handle(rejectedCapability, call("browser_screenshot"));
    assert.equal((denied?.result as any).isError, true);
  }
});

test("legacy CDP configuration never exposes or dispatches a Project Agent browser tool", async () => {
  const prior = process.env.RIFF_CDP_URL;
  process.env.RIFF_CDP_URL = "http://127.0.0.1:9222";
  let calls = 0;
  try {
    const server = new AgentMcpServer({
      async execute() {
        calls += 1;
        return {};
      },
    });
    const capability = server.grant({
      conversationId: "conversation_project",
      owner: { kind: "project", id: "project_a" },
      turnId: "turn_a",
      externalSessionGeneration: 1,
      allowedTools: toolsForOwner({ kind: "project", id: "project_a" }),
    });
    const listed = await server.handle(capability, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    const names = ((listed?.result as any).tools as any[]).map((item) => item.name);
    for (const forbidden of [
      "drive_workbench_ui",
      "riff_drive_workbench_ui",
      "riff_interact_current_visual",
    ]) assert.equal(names.includes(forbidden), false);
    assert.equal(names.includes("riff_observe_current_visual"), true);
    for (const forbidden of ["drive_workbench_ui", "riff_drive_workbench_ui"]) {
      const denied = await server.handle(capability, call(forbidden));
      assert.equal((denied?.result as any).isError, true);
    }
    assert.equal(calls, 0);
  } finally {
    if (prior === undefined) delete process.env.RIFF_CDP_URL;
    else process.env.RIFF_CDP_URL = prior;
  }
});

test("legacy MCP parser cannot reach a configured projector spy through a browser-shaped call", async () => {
  let projectorCalls = 0;
  const actions = new SimulationActions(
    new ProjectStore(),
    {} as never,
    {
      async project() {
        projectorCalls += 1;
        return { status: "succeeded", message: "must not run" };
      },
    },
  );
  const legacy = new LegacyMcpToolServer(actions);
  const capability = legacy.grant("session_projector_isolation");
  const listed = await legacy.handle(capability, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
  });
  const names = ((listed?.result as any).tools as any[]).map((item) => item.name);
  assert.equal(names.includes("riff_drive_workbench_ui"), false);
  const denied = await legacy.handle(
    capability,
    call("riff_drive_workbench_ui", {
      intent: { kind: "click", target: "Run" },
    }),
  );
  assert.equal((denied?.result as any).isError, true);
  assert.equal(projectorCalls, 0);
});

test("Agent tool input cannot replace a server-owned scope", async () => {
  let calls = 0;
  const server = new AgentMcpServer({ async execute() { calls += 1; return {}; } });
  const capability = server.grant({ conversationId: "conversation_a", owner: { kind: "model", id: "model_a" }, turnId: "turn_a", externalSessionGeneration: 1, allowedTools: toolsForOwner({ kind: "model", id: "model_a" }) });
  for (const injected of [
    { ownerId: "model_b" }, { modelId: "model_b" }, { projectId: "project_b" },
    { conversationId: "conversation_b" }, { workspacePath: "/tmp/other" }, { capability: "forged" },
    { runId: "run_other" }, { url: "http://127.0.0.1:9999" }, { port: 9999 },
    { path: "/tmp/other" }, { cookie: "secret" }, { nonce: "secret" },
    { frameUrl: "http://127.0.0.1/frame" }, { selector: "#secret" },
    { nested: { ownerId: "model_b" } },
    { nested: { runId: "run_other" } },
  ]) {
    const response = await server.handle(capability, call("riff_read_owner_summary", injected));
    assert.equal((response?.result as any).isError, true);
  }
  assert.equal(calls, 0);
});
