import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HttpOpenCodeAdapter, type OpenCodeAdapter, type OpenCodePrompt, type OpenCodeReadiness } from "../src/opencode-adapter.ts";
import { BackendApp } from "../src/server.ts";
import { HttpMesaAdapter } from "../src/mesa-adapter.ts";
import type { MesaAdapter, MesaRunRequest } from "../src/mesa-adapter.ts";
import type { MesaModel, MesaResults, MesaRun } from "../src/types.ts";

class FakeMesa implements MesaAdapter {
  requests: MesaRunRequest[] = [];
  async loadModel(): Promise<MesaModel> {
    return {
      modelId: "queue-network-v1",
      modelRevision: "mr_test",
      title: "Service queue",
      parameterSchema: {
        defaultSteps: 12,
        maximumSteps: 50,
        fields: [
          { key: "arrival_rate", label: "Arrival rate", type: "number", default: 6, minimum: 0.1, maximum: 100, required: true },
          { key: "service_capacity", label: "Service capacity", type: "integer", default: 2, minimum: 1, maximum: 50, required: true },
        ],
      },
    };
  }
  async startRun(_projectId: string, request: MesaRunRequest): Promise<MesaRun> {
    this.requests.push(request);
    return { runId: "run_1", status: "succeeded", progress: { completedSteps: request.steps, totalSteps: request.steps } };
  }
  async getRun(): Promise<MesaRun> { return { runId: "run_1", status: "succeeded" }; }
  async cancelRun(): Promise<MesaRun> { return { runId: "run_1", status: "cancelled" }; }
  async getResults(): Promise<MesaResults> {
    return {
      runId: "run_1",
      summary: [{ key: "completed_jobs", label: "Completed jobs", value: 9 }],
      timeSeries: { xKey: "tick", xLabel: "Tick", series: [] },
      table: { columns: [], rows: [] },
    };
  }
}

class FakeOpenCode implements OpenCodeAdapter {
  prompts: OpenCodePrompt[] = [];
  async initialize(): Promise<OpenCodeReadiness> { return { status: "ready", modelId: "deepseek/test-v4", version: "test" }; }
  async createSession(): Promise<string> { return "opaque-open-code-session"; }
  async prompt(_sessionId: string, prompt: OpenCodePrompt): Promise<void> { this.prompts.push(prompt); }
  async abort(): Promise<void> {}
}

class BindAwareOpenCode extends FakeOpenCode {
  bindings: Array<{ projectId: string; mcpUrl: string }> = [];
  async bindProject(projectId: string, mcpUrl: string): Promise<void> {
    this.bindings.push({ projectId, mcpUrl });
  }
}

test("public routes preserve revision, attachment, chat, parameter, and Mesa run boundaries", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "riff-backend-"));
  const mesa = new FakeMesa();
  const openCode = new FakeOpenCode();
  const app = new BackendApp({ mesa, openCode, workspaceRoot: workspace, defaultSessionId: "demo" });
  await app.initialize();
  const { port } = await app.listen();
  const base = `http://127.0.0.1:${port}/api/sessions/demo`;
  t.after(async () => { await app.close(); await rm(workspace, { recursive: true, force: true }); });

  let state = await getJson(`${base}/snapshot`);
  assert.deepEqual(Object.keys(state.agent).sort(), ["modelId", "status"]);
  assert.equal(state.agent.modelId, "deepseek/test-v4");

  const upload = new FormData();
  upload.set("envelope", JSON.stringify({ commandId: "upload-1", sessionId: "demo", baseRevision: state.revision, payload: { clientFileName: "arrivals.csv" } }));
  upload.set("file", new Blob(["time,value\n0,1\n"], { type: "text/csv" }), "arrivals.csv");
  let response = await fetch(`${base}/uploads`, { method: "POST", body: upload });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { accepted: true, commandId: "upload-1" });
  state = await getJson(`${base}/snapshot`);
  const attachmentId = state.attachments[0].id;
  assert.equal(state.attachments[0].mediaType, "text/csv");

  response = await command(`${base}/chat`, { commandId: "chat-1", sessionId: "demo", baseRevision: state.revision, payload: { text: "prepare queue model", attachmentIds: [attachmentId] } });
  assert.equal(response.status, 202);
  await response.text();
  assert.equal(openCode.prompts.length, 1);
  assert.equal(openCode.prompts[0].attachments[0].workspaceRelativePath.startsWith("inputs/"), true);
  state = await getJson(`${base}/snapshot`);

  response = await command(`${base}/attachments/${attachmentId}`, { commandId: "remove-in-use", sessionId: "demo", baseRevision: state.revision, payload: { attachmentId } }, "DELETE");
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, "attachment_in_use");

  const removable = new FormData();
  removable.set("envelope", JSON.stringify({ commandId: "upload-2", sessionId: "demo", baseRevision: state.revision, payload: { clientFileName: "notes.txt" } }));
  removable.set("file", new Blob(["context"], { type: "text/plain" }), "notes.txt");
  response = await fetch(`${base}/uploads`, { method: "POST", body: removable });
  assert.equal(response.status, 202);
  await response.text();
  state = await getJson(`${base}/snapshot`);
  const removableId = state.attachments.find((item: any) => item.id !== attachmentId).id;
  response = await command(`${base}/attachments/${removableId}`, { commandId: "remove-1", sessionId: "demo", baseRevision: state.revision, payload: { attachmentId: removableId } }, "DELETE");
  assert.equal(response.status, 202);
  await response.text();
  state = await getJson(`${base}/snapshot`);
  assert.equal(state.attachments.some((item: any) => item.id === removableId), false);

  await app.actions.loadModel("demo", "queue-network-v1");
  state = await getJson(`${base}/snapshot`);
  response = await command(`${base}/parameters`, { commandId: "params-1", sessionId: "demo", baseRevision: state.revision, payload: { modelId: "queue-network-v1", values: { arrival_rate: 8, service_capacity: 3 } } }, "PUT");
  assert.equal(response.status, 202);
  await response.text();
  state = await getJson(`${base}/snapshot`);
  response = await command(`${base}/runs`, { commandId: "run-1", sessionId: "demo", baseRevision: state.revision, payload: { modelId: "queue-network-v1", parameters: { arrival_rate: 8, service_capacity: 3 }, steps: 10, seeds: [7] } });
  assert.equal(response.status, 202);
  await response.text();
  assert.deepEqual(mesa.requests[0], { model_revision: "mr_test", parameters: { arrival_rate: 8, service_capacity: 3 }, steps: 10, seeds: [7] });
  state = await getJson(`${base}/snapshot`);
  assert.equal(state.phase, "succeeded");
  assert.equal(state.run.status, "succeeded");
  assert.equal(state.results.runId, "run_1");
});

test("development OpenCode skip is explicit and only loads the approved deterministic model", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "riff-backend-"));
  const adapter = new HttpOpenCodeAdapter({ skipLive: true });
  const app = new BackendApp({ mesa: new FakeMesa(), openCode: adapter, workspaceRoot: workspace, defaultSessionId: "skip" });
  await app.initialize();
  const { port } = await app.listen();
  const base = `http://127.0.0.1:${port}/api/sessions/skip`;
  t.after(async () => { await app.close(); await rm(workspace, { recursive: true, force: true }); });
  const state = await getJson(`${base}/snapshot`);
  assert.equal(state.agent.status, "ready");
  assert.equal(state.agent.modelId, "dev/deterministic");
  const response = await command(`${base}/chat`, { commandId: "skip-chat", sessionId: "skip", baseRevision: state.revision, payload: { text: "Load the queue model", attachmentIds: [] } });
  assert.equal(response.status, 202);
  const updated = await getJson(`${base}/snapshot`);
  assert.equal(updated.model.id, "queue-network-v1");
  assert.match(updated.conversation.at(-1).text, /Development demo mode loaded/);
});

test("live chat binds one capability-scoped MCP URL and revokes it when the browser session ends", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "riff-backend-"));
  const openCode = new BindAwareOpenCode();
  const app = new BackendApp({
    mesa: new FakeMesa(),
    openCode,
    workspaceRoot: workspace,
    defaultSessionId: "live-bind",
    mcpUrl: "http://127.0.0.1:8787/mcp?instance=local-demo",
  });
  await app.initialize();
  const { port } = await app.listen();
  const base = `http://127.0.0.1:${port}/api/sessions/live-bind`;
  t.after(async () => { await app.close(); await rm(workspace, { recursive: true, force: true }); });

  const state = await getJson(`${base}/snapshot`);
  const response = await command(`${base}/chat`, {
    commandId: "live-bind-chat", sessionId: "live-bind", baseRevision: state.revision,
    payload: { text: "Inspect the approved model", attachmentIds: [] },
  });
  assert.equal(response.status, 202);
  assert.equal(openCode.bindings.length, 1);
  const bound = new URL(openCode.bindings[0].mcpUrl);
  assert.equal(bound.pathname, "/mcp");
  assert.equal(bound.searchParams.get("instance"), "local-demo");
  const capability = bound.searchParams.get("cap");
  assert.match(capability ?? "", /^[0-9a-f-]{36}$/);
  assert.match(openCode.bindings[0].projectId, /^[0-9a-f-]{36}$/);

  app.closeSession("live-bind");
  const denied = await app.mcp.handle(capability ?? "", { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  assert.equal((denied as any).error.code, -32001);
});

test("OpenCode adapter discovers the configured model and limits prompt tools", async () => {
  const calls: Array<{ path: string; body?: any }> = [];
  const adapter = new HttpOpenCodeAdapter({
    baseUrl: "http://127.0.0.1:4096",
    model: "deepseek/v4",
    allowedProviders: ["deepseek"],
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ path, body });
      if (path === "/global/health") return Response.json({ healthy: true, version: "1.2.3" });
      if (path === "/config/providers") return Response.json({ providers: [{ id: "deepseek", models: { v4: {} } }] });
      if (path === "/session") return Response.json({ id: "internal-session" });
      if (path.endsWith("/prompt_async")) return new Response(null, { status: 204 });
      return new Response(null, { status: 404 });
    },
  });
  assert.deepEqual(await adapter.initialize(), { status: "ready", modelId: "deepseek/v4", version: "1.2.3" });
  const sessionId = await adapter.createSession("project-a");
  await adapter.prompt(sessionId, { text: "load model", system: "restricted", attachments: [] });
  const prompt = calls.find((call) => call.path.endsWith("/prompt_async"))!.body;
  assert.deepEqual(prompt.tools, {
    bash: false,
    write: false,
    edit: false,
    webfetch: false,
  });
  assert.equal(Object.keys(prompt.tools).some((name) => name.startsWith("riff_")), false);
  assert.deepEqual(prompt.model, { providerID: "deepseek", modelID: "v4" });
});

test("Mesa adapter maps the service summary and CSV-derived rows into visible results", async () => {
  const adapter = new HttpMesaAdapter("http://mesa.test", async () => Response.json({
    run_id: "run_mesa",
    summary: {
      metrics: ["queue_length", "completed_jobs", "mean_wait_time"],
      aggregate_final: {
        queue_length: { mean: 3, min: 3, max: 3 },
        completed_jobs: { mean: 9, min: 9, max: 9 },
        mean_wait_time: { mean: 1.5, min: 1.5, max: 1.5 },
      },
    },
    timeseries: [
      { seed: "7", tick: "0", queue_length: "0", completed_jobs: "0", mean_wait_time: "0" },
      { seed: "7", tick: "1", queue_length: "3", completed_jobs: "9", mean_wait_time: "1.5" },
    ],
  }));
  const results = await adapter.getResults("project", "run_mesa");
  assert.deepEqual(results.summary.map((item) => [item.key, item.value]), [["queue_length", 3], ["completed_jobs", 9], ["mean_wait_time", 1.5]]);
  assert.deepEqual(results.timeSeries.series[0].values, [0, 3]);
  assert.equal(results.table.rows.length, 2);
});

const getJson = async (url: string): Promise<any> => {
  const response = await fetch(url);
  assert.equal(response.status, 200);
  return response.json();
};

const command = (url: string, value: unknown, method = "POST"): Promise<Response> => fetch(url, {
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(value),
});
