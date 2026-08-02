import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
} from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentMcpServer } from "../src/agent-mcp.ts";
import { BrowserAgentAuthority } from "../src/browser-agent-authority.ts";
import {
  BROWSER_AGENT_TOOLS,
  browserAgentOperationCommitment,
  isBrowserAgentToolName,
  type BrowserAgentToolName,
} from "../src/browser-agent-tools.ts";
import {
  LocalBrowserBroker,
  registerLocalBrowserTarget,
} from "../src/local-browser-broker.ts";
import { HttpOpenCodeAdapter } from "../src/opencode-adapter.ts";

const liveModel = process.env.OPENCODE_BROWSER_AGENT_SMOKE_MODEL?.trim() ?? "";
const runLiveSmoke = process.env.RUN_OPENCODE_BROWSER_AGENT_SMOKE === "true"
  && liveModel.includes("/");
const EXPECTED_OPENCODE_VERSION = "1.18.11";
const EXPECTED_TEXT = "Browser smoke exact 42";

/**
 * Opt-in real-provider smoke.
 *
 * This exercises the installed OpenCode process, HttpOpenCodeAdapter scoped
 * MCP binding, real MCP HTTP JSON-RPC, BrowserAgentAuthority, and Playwright
 * Chromium, and Riffology's server-owned pending permission boundary.
 */
test("opt-in OpenCode 1.18.11 drives the scoped Browser MCP through real Chromium", {
  skip: !runLiveSmoke,
  timeout: 180_000,
}, async (t) => {
  const [providerId, ...modelSegments] = liveModel.split("/");
  const modelId = modelSegments.join("/");
  const workdir = await mkdtemp(join(tmpdir(), "riff-opencode-browser-agent-"));
  const fixture = await browserFixture(t);
  const scope = Object.freeze({
    conversationId: "conversation_live_browser_smoke",
    conversationGeneration: 1,
  });
  const turnId = "turn_live_browser_smoke";
  const workspace = Object.freeze({
    owner: Object.freeze({ kind: "model" as const, id: "model_live_browser_smoke" }),
    directory: workdir,
  });
  const broker = new LocalBrowserBroker({
    pageGenerationSeed: 50_000,
    resolveTarget: (alias) => alias === "riff-app" ? registerLocalBrowserTarget({
      alias,
      url: `${fixture.origin}/control`,
      projectedUrl: "riff-app://models/model_live_browser_smoke",
    }) : null,
  });
  const authority = new BrowserAgentAuthority(broker);
  const exactTools = [
    "browser_open",
    "browser_snapshot",
    "browser_type",
    "browser_wait",
    "browser_screenshot",
  ] as const satisfies readonly BrowserAgentToolName[];
  const sortedAllowedTools = Object.freeze(
    [...exactTools].sort((left, right) => left.localeCompare(right, "en")),
  );
  await authority.prepareDormant({
    scope,
    turnId,
    workspace,
    operations: new Set(exactTools),
    budget: 8,
  });

  const observed = {
    calls: [] as Array<{
      tool: BrowserAgentToolName;
      input: Readonly<Record<string, unknown>>;
      commitment: string;
      completed: boolean;
    }>,
    pageChanged: false,
    pngObserved: false,
    riffMutationCount: 0,
  };
  const mcp = new AgentMcpServer({
    async execute(grant, tool, input) {
      assert.equal(grant.conversationId, scope.conversationId);
      assert.equal(grant.turnId, turnId);
      assert.ok(isBrowserAgentToolName(tool));
      if (!isBrowserAgentToolName(tool) || !exactTools.includes(tool as any)) {
        observed.riffMutationCount += tool.startsWith("riff_") ? 1 : 0;
        throw new Error(`Unexpected Browser smoke tool: ${tool}`);
      }
      const commitment = browserAgentOperationCommitment(tool, input);
      const call = {
        tool,
        input: commitment.normalized,
        commitment: commitment.digest,
        completed: false,
      };
      observed.calls.push(call);
      const result = await authority.execute({
        conversationId: scope.conversationId,
        turnId,
        externalSessionGeneration: scope.conversationGeneration,
        tool,
        arguments: input,
      });
      if (tool === "browser_snapshot") {
        const elements = (result as any).elements as Array<{ name: string }>;
        if (elements.some((element) => element.name === "Changed")) {
          observed.pageChanged = true;
        }
      }
      if (tool === "browser_screenshot") {
        const screenshot = result as any;
        observed.pngObserved = screenshot.contentType === "image/png"
          && typeof screenshot.pngBase64 === "string"
          && screenshot.pngBase64.startsWith("iVBOR");
      }
      call.completed = true;
      return result;
    },
  });
  const capability = mcp.grant({
    conversationId: scope.conversationId,
    owner: workspace.owner,
    turnId,
    externalSessionGeneration: scope.conversationGeneration,
    allowedTools: new Set(exactTools),
  });
  const endpoint = await scopedMcpEndpoint(t, { capability, mcp });

  const port = await freePort();
  const child = spawn(
    "opencode",
    ["serve", "--pure", "--hostname", "127.0.0.1", "--port", String(port)],
    { cwd: workdir, stdio: "ignore", env: process.env },
  );
  t.after(async () => {
    await authority.revokeTurn(scope.conversationId, turnId).catch(() => undefined);
    await broker.shutdown();
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
  assert.equal(health.version, EXPECTED_OPENCODE_VERSION);
  const adapter = new HttpOpenCodeAdapter({
    baseUrl,
    workdir,
    expectedVersion: EXPECTED_OPENCODE_VERSION,
    model: liveModel,
    allowedProviders: [providerId],
    requestTimeoutMs: 150_000,
  });
  assert.equal((await adapter.initialize()).status, "ready");
  await adapter.bindScopedMcp(turnId, endpoint.url, sortedAllowedTools);
  const sessionId = await adapter.createSession(scope.conversationId, workspace);
  let promptOutcome:
    | { state: "pending" }
    | { state: "fulfilled"; value: Awaited<ReturnType<HttpOpenCodeAdapter["promptWithModel"]>> }
    | { state: "rejected"; error: unknown } = { state: "pending" };
  const prompt = adapter.promptWithModel(
    sessionId,
    { providerId, modelId },
    {
      system: [
        "This is a deterministic Browser MCP integration smoke.",
        "Use only the enabled Browser tools and follow this exact order:",
        "browser_open with alias riff-app; browser_snapshot; browser_type into the editable element named Message",
        `with the exact text ${JSON.stringify(EXPECTED_TEXT)}; browser_snapshot; browser_wait for 50 milliseconds; browser_screenshot.`,
        "Use the opaque ref returned by the immediately preceding snapshot. Do not call any other tool.",
        "After all six calls, return a short text confirmation.",
      ].join(" "),
      text: "Run the exact Browser smoke sequence now.",
      attachments: [],
      scopedMcpScopeId: turnId,
      scopedMcpTools: sortedAllowedTools,
    },
    undefined,
    workspace,
  );
  void prompt.then(
    (value) => { promptOutcome = { state: "fulfilled", value }; },
    (error) => { promptOutcome = { state: "rejected", error }; },
  );
  const permissionReplies: Array<{
    id: string;
    tool: BrowserAgentToolName;
  }> = [];
  const replied = new Set<string>();
  for (let attempt = 0; attempt < 1_500 && promptOutcome.state === "pending"; attempt += 1) {
    for (const interaction of await authority.pendingForTurn(scope.conversationId, turnId)) {
      if (replied.has(interaction.id)) continue;
      assert.match(interaction.id, /^browser_permission_[0-9a-f]{32}$/u);
      assert.doesNotMatch(JSON.stringify(interaction), /commitment|digest|element_|exact 42/iu);
      await authority.approvePending({
        id: interaction.id,
        conversationId: scope.conversationId,
        turnId,
        externalSessionGeneration: scope.conversationGeneration,
        workspace,
      });
      replied.add(interaction.id);
      permissionReplies.push({
        id: interaction.id,
        tool: interaction.tool,
      });
    }
    if (promptOutcome.state === "pending") {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  if (promptOutcome.state === "pending") throw new Error("Browser permission smoke timed out.");
  if (promptOutcome.state === "rejected") {
    throw new Error(`Browser permission smoke failed after ${JSON.stringify({
      permissions: permissionReplies.map((reply) => reply.tool),
      calls: observed.calls.map((call) => ({ tool: call.tool, completed: call.completed })),
    })}`, { cause: promptOutcome.error });
  }
  const response = promptOutcome.value;
  assert.match(response.text, /\S/u);
  assert.deepEqual(observed.calls.map((call) => call.tool), [
    "browser_open",
    "browser_snapshot",
    "browser_type",
    "browser_snapshot",
    "browser_wait",
    "browser_screenshot",
  ]);
  assert.equal(observed.calls.every((call) => call.completed), true);
  assert.equal(observed.pageChanged, true,
    "the second snapshot must expose the fixed accessible changed state");
  assert.deepEqual(
    permissionReplies.map((reply) => reply.tool),
    observed.calls.map((call) => call.tool),
    "every MCP execution must follow one server-owned one-shot approval in exact order",
  );
  assert.equal(observed.pngObserved, true);
  assert.equal(observed.riffMutationCount, 0);
  const controlled = await broker.state(scope);
  assert.equal(controlled.controlMode, "agent");
  assert.equal(controlled.remainingBudget, 2);

  await adapter.unbindScopedMcp(turnId);
  await authority.revokeTurn(scope.conversationId, turnId);
  const revoked = await broker.state(scope);
  assert.equal(revoked.controlMode, "observer");
  assert.equal(revoked.remainingBudget, null);
  await assert.rejects(
    authority.activatePermission({
      conversationId: scope.conversationId,
      turnId,
      externalSessionGeneration: scope.conversationGeneration,
      workspace,
      tool: "browser_snapshot",
      operationCommitment: browserAgentOperationCommitment("browser_snapshot", {}).digest,
    }),
    (error: any) => error?.code === "browser_grant_unavailable",
  );
});

const scopedMcpEndpoint = async (
  t: any,
  input: Readonly<{
    capability: string;
    mcp: AgentMcpServer;
  }>,
): Promise<{ url: string }> => {
  const server = createHttpServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/a2/mcp" || url.searchParams.get("cap") !== "browser-live-smoke") {
        response.writeHead(404).end();
        return;
      }
      if (request.method === "GET") {
        response.writeHead(405).end();
        return;
      }
      const payload = JSON.parse(await requestBody(request) || "{}");
      const batch = Array.isArray(payload) ? payload : [payload];
      const results: unknown[] = [];
      for (const rpc of batch) {
        if (rpc?.method === "tools/call") {
          const args = rpc.params?.arguments;
          if (!args || typeof args !== "object" || Array.isArray(args)) {
            throw new Error("Browser smoke tools/call arguments must be an object.");
          }
        }
        const result = await input.mcp.handle(input.capability, rpc);
        if (result) results.push(result);
      }
      if (results.length === 0) {
        response.writeHead(202).end();
        return;
      }
      response.writeHead(200, {
        "content-type": "application/json",
        "mcp-session-id": "riff-browser-live-smoke",
      });
      response.end(JSON.stringify(Array.isArray(payload) ? results : results[0]));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : "smoke_failed" }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => closeServer(server));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { url: `http://127.0.0.1:${address.port}/a2/mcp?cap=browser-live-smoke` };
};

const browserFixture = async (t: any): Promise<{ origin: string }> => {
  const server = createHttpServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'",
    });
    response.end(`<!doctype html><title>Browser smoke</title>
      <input aria-label="Message" oninput="document.querySelector('#echo').setAttribute('aria-label', 'Changed')">
      <button id="echo" type="button" aria-label="Empty">Empty</button>`);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "::1", resolve);
  });
  t.after(() => closeServer(server));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { origin: `http://localhost:${address.port}` };
};

const freePort = async (): Promise<number> => new Promise((resolve, reject) => {
  const server = createNetServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    server.close((error) => error
      ? reject(error)
      : resolve(typeof address === "object" && address ? address.port : 0));
  });
});

const waitForHealth = async (url: string): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(750) });
      if (response.ok) return;
    } catch { /* OpenCode is still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("OpenCode did not become healthy within ten seconds.");
};

const readJson = async (url: string): Promise<any> => {
  const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
  if (!response.ok) throw new Error(`OpenCode smoke endpoint returned ${response.status}.`);
  return response.json();
};

const requestBody = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
};

const closeServer = (server: Server): Promise<void> => new Promise((resolve, reject) => {
  server.closeAllConnections?.();
  server.close((error) => error ? reject(error) : resolve());
});
