import assert from "node:assert/strict";
import test from "node:test";
import { AgentMcpServer } from "../src/agent-mcp.ts";
import { toolsForOwner, type AgentToolGrant } from "../src/agent-tools.ts";
import { McpToolServer as LegacyMcpToolServer } from "../src/mcp.ts";
import { ProjectStore } from "../src/project-store.ts";
import { SimulationActions } from "../src/simulation-actions.ts";

const call = (name: string, args: Record<string, unknown> = {}) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });

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
  const allowed = await server.handle(projectCapability, call("riff_create_analysis_document", { name: "Analysis", mediaType: "text/markdown", content: "x" }));
  assert.equal((allowed?.result as any).isError, undefined);
  assert.deepEqual(seen[0]?.owner, { kind: "project", id: "project_a" });
  assert.equal(seen[0]?.externalSessionGeneration, 2);
  server.revokeSessionGeneration("conversation_project", 2);
  assert.equal((await server.handle(projectCapability, { jsonrpc: "2.0", id: 1, method: "tools/list" }))?.error?.code, -32001);

  const expiring = server.grant({ conversationId: "conversation_model", owner: { kind: "model", id: "model_a" }, turnId: "turn_b", externalSessionGeneration: 1, allowedTools: toolsForOwner({ kind: "model", id: "model_a" }) });
  now = 15;
  assert.equal((await server.handle(expiring, { jsonrpc: "2.0", id: 1, method: "tools/list" }))?.error?.code, -32001);
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
