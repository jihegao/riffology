import assert from "node:assert/strict";
import test from "node:test";
import { McpToolServer } from "../src/mcp.ts";
import { OpenCodeEventBridge } from "../src/opencode-events.ts";
import { ProjectStore } from "../src/project-store.ts";
import { SimulationActions } from "../src/simulation-actions.ts";
import type { MesaAdapter } from "../src/mesa-adapter.ts";
import type { MesaModel, MesaResults, MesaRun } from "../src/types.ts";

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
  assert.equal((listed as any).result.tools.length, 7);

  const result = await server.handle(capability, {
    jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "riff_select_and_load_model", arguments: { modelId: "queue-network-v1" } },
  });
  assert.equal((result as any).result.isError, undefined);
  assert.equal(mesa.loads, 1);
  assert.equal(store.snapshot("browser-1").model?.id, "queue-network-v1");

  const injected = await server.handle(capability, {
    jsonrpc: "2.0", id: 4, method: "tools/call",
    params: { name: "riff_select_and_load_model", arguments: { modelId: "queue-network-v1", projectId: "other-project" } },
  });
  assert.equal((injected as any).result.isError, true);
  assert.match((injected as any).result.content[0].text, /project_scope_forbidden/);
  assert.equal(mesa.loads, 1);

  const denied = await server.handle("wrong-capability", { jsonrpc: "2.0", id: 5, method: "tools/list", params: {} });
  assert.equal((denied as any).error.code, -32001);
});

test("OpenCode recorded event fixtures become canonical state and conversation events", () => {
  const store = new ProjectStore();
  store.create("browser-2", { modelId: "deepseek/v4", status: "ready" });
  const bridge = new OpenCodeEventBridge(store);
  bridge.bind("ses_live", "browser-2");
  const browserEvents: any[] = [];
  const unsubscribe = store.subscribe("browser-2", (event) => browserEvents.push(event));

  bridge.handle({ id: "evt_delta", type: "message.part.delta", properties: { sessionID: "ses_live", messageID: "msg_live", partID: "prt_1", field: "text", delta: "Result at /Users/name/secret" } });
  bridge.handle({ id: "evt_tool", type: "session.next.tool.called", properties: { sessionID: "ses_live", tool: "riff_select_and_load_model", callID: "call_1" } });
  bridge.handle({ id: "evt_idle", type: "session.idle", properties: { sessionID: "ses_live" } });
  unsubscribe();

  const state = store.snapshot("browser-2");
  assert.equal(state.conversation.length, 1);
  assert.match(state.conversation[0].text, /\[local path\]/);
  assert.equal(state.agent?.status, "ready");
  assert.ok(browserEvents.some((event) => event.type === "conversation.delta"));
  assert.ok(browserEvents.some((event) => event.type === "agent.status"));
  assert.ok(browserEvents.some((event) => event.type === "project.patch"));
});
