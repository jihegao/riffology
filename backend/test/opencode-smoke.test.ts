import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HttpOpenCodeAdapter } from "../src/opencode-adapter.ts";

const liveMultiToolModel = process.env.OPENCODE_LIVE_SMOKE_MODEL?.trim() ?? "";
const runLiveMultiToolSmoke = process.env.RUN_OPENCODE_MULTI_TOOL_SMOKE === "true" && liveMultiToolModel.includes("/");

test("optional installed OpenCode pure-server discovery smoke uses no provider credentials", { skip: process.env.RUN_OPENCODE_SMOKE !== "true" }, async (t) => {
  const port = await freePort();
  const emptyHome = await mkdtemp(join(tmpdir(), "riff-opencode-smoke-"));
  const child = spawn("opencode", ["serve", "--pure", "--hostname", "127.0.0.1", "--port", String(port)], {
    stdio: "ignore",
    env: { PATH: process.env.PATH ?? "", HOME: emptyHome },
  });
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1_000))]);
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await exited;
      }
    }
    await rm(emptyHome, { recursive: true, force: true });
  });
  await waitForHealth(`http://127.0.0.1:${port}/global/health`);
  const health = await readJson(`http://127.0.0.1:${port}/global/health`);
  const providers = await readJson(`http://127.0.0.1:${port}/config/providers`);
  assert.equal(health.healthy, true);
  assert.equal(typeof health.version, "string");
  assert.ok(Array.isArray(providers.providers));
});

test("opt-in installed OpenCode 1.18.4 completes two scoped MCP tools before idle reconciliation and revocation", {
  skip: !runLiveMultiToolSmoke,
  timeout: 120_000,
}, async (t) => {
  const port = await freePort();
  const workdir = await mkdtemp(join(tmpdir(), "riff-opencode-live-workdir-"));
  const mcp = await controlledMcpServer(t);
  const child = spawn("opencode", ["serve", "--pure", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: workdir,
    stdio: "ignore",
    env: process.env,
  });
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1_000))]);
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await exited;
      }
    }
    await rm(workdir, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(`${baseUrl}/global/health`);
  const health = await readJson(`${baseUrl}/global/health`);
  assert.equal(health.version, "1.18.4", "the live smoke is intentionally pinned to the supported OpenCode binary");

  const [providerId, ...modelSegments] = liveMultiToolModel.split("/");
  const modelId = modelSegments.join("/");
  const statusObservations: string[] = [];
  let observedSessionId = "";
  let canonicalIdleObserved = false;
  let settledBeforeCanonicalIdle = false;
  const adapter = new HttpOpenCodeAdapter({
    baseUrl,
    workdir,
    expectedVersion: "1.18.4",
    model: liveMultiToolModel,
    allowedProviders: [providerId],
    requestTimeoutMs: 90_000,
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      if (new URL(String(input)).pathname === "/session/status" && response.ok) {
        const payload = await response.clone().json() as Record<string, { type?: string }>;
        const status = payload[observedSessionId]?.type ?? "idle";
        statusObservations.push(status);
        if (status === "idle") canonicalIdleObserved = true;
      }
      return response;
    },
  });
  assert.equal((await adapter.initialize()).status, "ready");

  const scopeId = "turn_live_multi_tool_smoke";
  await adapter.bindScopedMcp(scopeId, mcp.url);
  const sessionId = await adapter.createSession("live-multi-tool-smoke");
  observedSessionId = sessionId;
  const operation = adapter.promptWithModel(sessionId, { providerId, modelId }, {
    system: [
      "This is a deterministic integration smoke.",
      "Use the two enabled scoped MCP tools and no other tools.",
      "Call observe_phase exactly once, then call commit_phase exactly once.",
      "Only after both tool results, return a short text confirmation.",
    ].join(" "),
    text: "Execute both required phases now.",
    attachments: [],
    scopedMcpScopeId: scopeId,
  }).finally(() => { settledBeforeCanonicalIdle = !canonicalIdleObserved; });
  const response = await operation;

  assert.equal(settledBeforeCanonicalIdle, false, "the adapter must not settle before canonical replay observes exact-session idle");
  assert.ok(statusObservations.includes("busy") || statusObservations.includes("retry"), "the live turn must expose a non-terminal status");
  assert.deepEqual(mcp.calls.map((call) => call.name), ["observe_phase", "commit_phase"]);
  assert.match(response.text, /\S/u);
  assert.equal(mcp.calls.every((call) => call.completed), true, "both controlled MCP calls must reconcile before prompt completion");

  await adapter.unbindScopedMcp(scopeId);
  assert.equal(mcp.calls.length, 2, "revocation must happen after durable tool reconciliation, without an extra call");
  await assert.rejects(
    () => adapter.promptWithModel(sessionId, { providerId, modelId }, {
      system: "Do not run.",
      text: "This revoked scope must be denied before prompt submission.",
      attachments: [],
      scopedMcpScopeId: scopeId,
    }),
    (error: any) => error?.code === "opencode_mcp_unbound",
  );
});

const freePort = async (): Promise<number> => new Promise((resolve, reject) => {
  const server = createNetServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    server.close((error) => error ? reject(error) : resolve(typeof address === "object" && address ? address.port : 0));
  });
});

const waitForHealth = async (url: string): Promise<void> => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(750) });
      if (response.ok) return;
    } catch { /* process is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("OpenCode pure server did not become healthy within five seconds.");
};

const readJson = async (url: string): Promise<any> => {
  const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
  if (!response.ok) throw new Error(`OpenCode smoke endpoint returned ${response.status}.`);
  return response.json();
};

const controlledMcpServer = async (t: any): Promise<{
  url: string;
  calls: Array<{ name: string; completed: boolean }>;
}> => {
  const calls: Array<{ name: string; completed: boolean }> = [];
  const server = createHttpServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/a2/mcp" || url.searchParams.get("cap") !== "live-smoke") {
      response.writeHead(404).end();
      return;
    }
    if (request.method === "GET") {
      response.writeHead(405).end();
      return;
    }
    const body = await requestBody(request);
    const payload = JSON.parse(body || "{}");
    const rpc = Array.isArray(payload) ? payload : [payload];
    const results = rpc.flatMap((entry: any) => {
      if (entry.method === "notifications/initialized") return [];
      if (entry.method === "initialize") return [{
        jsonrpc: "2.0",
        id: entry.id,
        result: {
          protocolVersion: entry.params?.protocolVersion ?? "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "riff-controlled-live-smoke", version: "1.0.0" },
        },
      }];
      if (entry.method === "tools/list") return [{
        jsonrpc: "2.0",
        id: entry.id,
        result: {
          tools: [
            {
              name: "observe_phase",
              description: "Required first phase. Observe the controlled live smoke state.",
              inputSchema: { type: "object", properties: {}, additionalProperties: false },
            },
            {
              name: "commit_phase",
              description: "Required second phase. Commit the controlled live smoke state after observation.",
              inputSchema: { type: "object", properties: {}, additionalProperties: false },
            },
          ],
        },
      }];
      if (entry.method === "tools/call") {
        const name = String(entry.params?.name ?? "");
        const call = { name, completed: false };
        calls.push(call);
        call.completed = true;
        return [{
          jsonrpc: "2.0",
          id: entry.id,
          result: {
            content: [{ type: "text", text: JSON.stringify({ ok: true, phase: name, ordinal: calls.length }) }],
            isError: false,
          },
        }];
      }
      return [{ jsonrpc: "2.0", id: entry.id, error: { code: -32601, message: "Method not found" } }];
    });
    if (results.length === 0) {
      response.writeHead(202).end();
      return;
    }
    response.writeHead(200, {
      "content-type": "application/json",
      "mcp-session-id": "riff-live-smoke-session",
    });
    response.end(JSON.stringify(Array.isArray(payload) ? results : results[0]));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Controlled MCP server did not bind a TCP port.");
  return { url: `http://127.0.0.1:${address.port}/a2/mcp?cap=live-smoke`, calls };
};

const requestBody = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
};
