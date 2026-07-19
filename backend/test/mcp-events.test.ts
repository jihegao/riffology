import assert from "node:assert/strict";
import test from "node:test";
import { McpToolServer } from "../src/mcp.ts";
import { OpenCodeEventBridge } from "../src/opencode-events.ts";
import { ProjectStore } from "../src/project-store.ts";
import { SimulationActions } from "../src/simulation-actions.ts";
import type { MesaAdapter } from "../src/mesa-adapter.ts";
import type { MesaModel, MesaResults, MesaRun } from "../src/types.ts";
import type { WorkbenchIntent, WorkbenchProjector } from "../src/playwright-projection.ts";

class ToolMesa implements MesaAdapter {
  loads = 0;
  async loadModel(): Promise<MesaModel> {
    this.loads += 1;
    return {
      modelId: "queue-network-v1",
      modelRevision: "mr_tool",
      title: "Service queue",
      parameterSchema: { fields: [{ key: "arrival_rate", label: "Arrival rate", type: "number", default: 6, required: true }] },
    };
  }
  async startRun(): Promise<MesaRun> { throw new Error("not used"); }
  async getRun(): Promise<MesaRun> { throw new Error("not used"); }
  async cancelRun(): Promise<MesaRun> { throw new Error("not used"); }
  async getResults(): Promise<MesaResults> { throw new Error("not used"); }
}

test("MCP tool calls use a capability-scoped session and reject project injection", async () => {
  const store = new ProjectStore();
  store.create("browser-1", { modelId: "deepseek/v4", status: "ready" });
  const mesa = new ToolMesa();
  const server = new McpToolServer(new SimulationActions(store, mesa));
  const capability = server.grant("browser-1");

  const initialization = await server.handle(undefined, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  assert.equal((initialization as any).result.serverInfo.name, "riff-simulation-workbench");
  const listed = await server.handle(capability, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  assert.equal((listed as any).result.tools.length, 6);
  assert.equal((listed as any).result.tools.some((tool: any) => tool.name === "riff_drive_workbench_ui"), false);

  const result = await server.handle(capability, {
    jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "riff_select_and_load_model", arguments: { modelId: "queue-network-v1" } },
  });
  assert.equal((result as any).result.isError, undefined);
  assert.deepEqual(JSON.parse((result as any).result.content[0].text), {
    action: "model_loaded",
    modelId: "queue-network-v1",
    modelRevision: "mr_tool",
    parameters: [{ key: "arrival_rate", label: "Arrival rate", type: "number", default: 6 }],
  });
  assert.equal(mesa.loads, 1);
  assert.equal(store.snapshot("browser-1").model?.id, "queue-network-v1");

  const objectResult = await server.handle(capability, {
    jsonrpc: "2.0", id: 31, method: "tools/call",
    params: { name: "riff_set_parameters", arguments: { values: { arrival_rate: 8 } } },
  });
  assert.equal((objectResult as any).result.structuredContent, undefined);
  assert.deepEqual(JSON.parse((objectResult as any).result.content[0].text), { arrival_rate: 8 });

  const arrayResult = await server.handle(capability, {
    jsonrpc: "2.0", id: 32, method: "tools/call",
    params: { name: "riff_inspect_uploaded_files", arguments: {} },
  });
  assert.equal((arrayResult as any).result.structuredContent, undefined);
  assert.deepEqual(JSON.parse((arrayResult as any).result.content[0].text), []);

  const injected = await server.handle(capability, {
    jsonrpc: "2.0", id: 4, method: "tools/call",
    params: { name: "riff_select_and_load_model", arguments: { modelId: "queue-network-v1", projectId: "other-project" } },
  });
  assert.equal((injected as any).result.isError, true);
  assert.match((injected as any).result.content[0].text, /project_scope_forbidden/);
  assert.equal(mesa.loads, 1);

  const labelBasedIntent = await server.handle(capability, {
    jsonrpc: "2.0", id: 5, method: "tools/call",
    params: { name: "riff_drive_workbench_ui", arguments: { intent: { type: "set_parameter", label: "Arrival rate", value: 8 } } },
  });
  assert.equal((labelBasedIntent as any).result.isError, true);
  assert.match((labelBasedIntent as any).result.content[0].text, /tool_not_allowed/);

  const denied = await server.handle("wrong-capability", { jsonrpc: "2.0", id: 6, method: "tools/list", params: {} });
  assert.equal((denied as any).error.code, -32001);

  server.revokeSession("browser-1");
  const revoked = await server.handle(capability, { jsonrpc: "2.0", id: 6, method: "tools/list", params: {} });
  assert.equal((revoked as any).error.code, -32001);
});

test("MCP capabilities expire without exposing another session", async () => {
  let now = 1_000;
  const store = new ProjectStore();
  store.create("browser-expiry", { modelId: "deepseek/v4", status: "ready" });
  const server = new McpToolServer(new SimulationActions(store, new ToolMesa()), { capabilityTtlMs: 10, now: () => now });
  const capability = server.grant("browser-expiry");
  assert.equal((await server.handle(capability, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) as any).result.tools.length, 6);
  now += 11;
  const expired = await server.handle(capability, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  assert.equal((expired as any).error.code, -32001);
});

test("OpenCode streaming has one text delivery path and terminal patches complete or fail messages", () => {
  const store = new ProjectStore();
  store.create("browser-2", { modelId: "deepseek/v4", status: "ready" });
  const bridge = new OpenCodeEventBridge(store);
  bridge.bind("ses_live", "browser-2");
  const browserEvents: any[] = [];
  const unsubscribe = store.subscribe("browser-2", (event) => browserEvents.push(event));

  bridge.handle({ id: "evt_delta", type: "message.part.delta", properties: { sessionID: "ses_live", messageID: "msg_live", partID: "prt_1", field: "text", delta: "Result at /Users/name/secret" } });
  const patchesDuringDelta = browserEvents.filter((event) => event.type === "project.patch");
  assert.equal(patchesDuringDelta.length, 1);
  assert.equal(JSON.stringify(patchesDuringDelta[0]).includes("Result at"), false);
  assert.equal(browserEvents.filter((event) => event.type === "conversation.delta").length, 1);
  assert.match((browserEvents.find((event) => event.type === "conversation.delta") as any).data.textDelta, /\[local path\]/);

  bridge.handle({ id: "evt_tool", type: "session.next.tool.called", properties: { sessionID: "ses_live", tool: "riff_select_and_load_model", callID: "call_1" } });
  bridge.handle({ id: "evt_idle", type: "session.idle", properties: { sessionID: "ses_live" } });

  bridge.bind("ses_error", "browser-2");
  bridge.handle({ id: "evt_error_delta", type: "message.part.delta", properties: { sessionID: "ses_error", messageID: "msg_error", partID: "prt_2", field: "text", delta: "Unable to continue" } });
  bridge.handle({ id: "evt_error", type: "session.error", properties: { sessionID: "ses_error" } });
  unsubscribe();

  const state = store.snapshot("browser-2");
  assert.equal(state.conversation.length, 2);
  assert.match(state.conversation[0].text, /\[local path\]/);
  assert.equal(state.conversation[0].status, "complete");
  assert.equal(state.conversation[1].status, "failed");
  assert.equal(state.agent?.status, "error");
  assert.ok(browserEvents.some((event) => event.type === "conversation.delta"));
  assert.ok(browserEvents.some((event) => event.type === "agent.status"));
  assert.ok(browserEvents.some((event) => event.type === "project.patch"));
});

class ProjectionMesa extends ToolMesa {
  async startRun(): Promise<MesaRun> {
    return { runId: "run_projection", status: "succeeded", progress: { completedSteps: 4, totalSteps: 4 } };
  }
  async getResults(): Promise<MesaResults> {
    return { runId: "run_projection", summary: [], timeSeries: { xKey: "tick", xLabel: "Tick", series: [] }, table: { columns: [], rows: [] } };
  }
}

class OrderingProjector implements WorkbenchProjector {
  readonly observed: Array<{ intent: WorkbenchIntent; state: ReturnType<ProjectStore["snapshot"]> }> = [];
  private readonly store: ProjectStore;
  result: { status: "verified" | "failed"; reason?: string } = { status: "verified" };

  constructor(store: ProjectStore) {
    this.store = store;
  }

  async project(intent: WorkbenchIntent): Promise<{ status: "verified" | "failed"; reason?: string }> {
    this.observed.push({ intent, state: this.store.snapshot("browser-projection") });
    return this.result;
  }
}

test("agent UI projection commits matching domain state before a browser observation", async () => {
  const store = new ProjectStore();
  store.create("browser-projection", { modelId: "deepseek/v4", status: "ready" });
  const projector = new OrderingProjector(store);
  const actions = new SimulationActions(store, new ProjectionMesa(), projector);
  const events: any[] = [];
  const unsubscribe = store.subscribe("browser-projection", (event) => events.push(event));
  await actions.loadModel("browser-projection", "queue-network-v1");

  await actions.execute("browser-projection", { name: "drive_workbench_ui", intent: { type: "set_parameter", key: "arrival_rate", value: 9 } });
  assert.equal(projector.observed[0].state.model?.parameterValues.arrival_rate, 9);
  assert.equal(projector.observed[0].state.uiControl?.status, "verifying");
  assert.equal(store.snapshot("browser-projection").uiControl?.status, "verified");
  assert.ok(events.some((event) => event.type === "project.patch" && event.data.operations.some((operation: any) => operation.path === "/uiControl")));

  await actions.execute("browser-projection", { name: "drive_workbench_ui", intent: { type: "start_run" } });
  assert.equal(projector.observed[1].state.run?.id, "run_projection");
  assert.equal(projector.observed[1].state.results?.runId, "run_projection");
  assert.equal(store.snapshot("browser-projection").uiControl?.intent, "start_run");

  projector.result = { status: "failed", reason: "Visible workbench was not attached." };
  await actions.execute("browser-projection", { name: "drive_workbench_ui", intent: { type: "open_tab", tab: "results" } });
  assert.deepEqual(store.snapshot("browser-projection").uiControl, {
    intent: "open_tab", status: "failed", expectedRevision: projector.observed[2].state.uiControl!.expectedRevision, message: "Visible workbench was not attached.",
  });
  unsubscribe();
});
