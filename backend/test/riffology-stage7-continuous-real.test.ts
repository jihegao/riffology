import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { planExperiment } from "../src/experiment-planner.ts";
import { HttpOpenCodeAdapter } from "../src/opencode-adapter.ts";
import { BackendApp } from "../src/server.ts";
import type { AgentWorkspaceService } from "../src/agent-workspace-service.ts";

const liveModel = process.env.RIFFOLOGY_STAGE7_SMOKE_MODEL?.trim() ?? "";
const runLive = process.env.RUN_RIFFOLOGY_STAGE7_CONTINUOUS_REAL === "true"
  && liveModel.includes("/");
const expectedVersion = process.env.OPENCODE_EXPECTED_VERSION?.trim() || "1.18.11";
const repositoryRoot = resolve(import.meta.dirname, "../..");
const NOW = "2026-08-02T08:00:00.000Z";

test(`opt-in Stage 7 keeps one real Provider to terminal Run, viewer, Browser, and restart chain (${expectedVersion})`, {
  skip: !runLive,
  timeout: 420_000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "riffology-stage7-continuous-"));
  const productRoot = join(root, "product");
  const port = await freePort();
  const child = spawn(
    "opencode",
    ["serve", "--pure", "--hostname", "127.0.0.1", "--port", String(port)],
    { cwd: root, stdio: "ignore", env: process.env },
  );
  let app: BackendApp | undefined;
  let browser: Browser | undefined;
  t.after(async () => {
    await browser?.close().catch(() => undefined);
    await app?.close().catch(() => undefined);
    await stopChild(child);
    await rm(root, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(`${baseUrl}/global/health`);
  const health = await fetch(`${baseUrl}/global/health`).then((response) => response.json());
  assert.equal(health.version, expectedVersion);
  const [providerId, ...modelParts] = liveModel.split("/");
  const modelId = modelParts.join("/");
  const createAdapter = () => new HttpOpenCodeAdapter({
      baseUrl,
      workdir: root,
      expectedVersion,
      model: liveModel,
      allowedProviders: [providerId],
      requestTimeoutMs: 180_000,
    });
  let adapter = createAdapter();
  assert.equal((await adapter.initialize()).status, "ready");

  const startApp = async (): Promise<Readonly<{ app: BackendApp; origin: string }>> => {
    const next = new BackendApp({
      productOnly: true,
      a2ProductRoot: productRoot,
      a2OpenCode: adapter,
      a3InstallPreinstalledWind: true,
      a3PreinstalledWindRepositoryRoot: repositoryRoot,
      a3PythonExecutable: resolve(repositoryRoot, "mesa_service/.venv/bin/python"),
      repositoryRoot,
      staticWebRoot: resolve(repositoryRoot, "web/dist"),
      recoveryOnlyOnFailure: false,
    });
    await next.initialize();
    const network = await next.listenBrowserNetwork();
    return { app: next, origin: network.app.origin };
  };

  let started = await startApp();
  app = started.app;
  const store = app.productStore!;
  const sourceModel = store.listModels().find((candidate) =>
    candidate.technicalStatus === "executable" && candidate.runMode === "batch");
  assert.ok(sourceModel, "preinstalled executable batch Model is unavailable");
  const projectId = "project_stage7_continuous";
  const conversationId = "conversation_stage7_continuous";
  store.createProjectFromModel({
    projectId,
    projectName: "Stage 7 Continuous Project",
    sourceModelId: sourceModel.id,
    createdAt: NOW,
  });
  store.createConversation({
    id: conversationId,
    owner: { kind: "project", id: projectId },
    name: "Continuous acceptance",
    providerId,
    providerModelId: modelId,
    createdAt: NOW,
  });
  const project = store.getProject(projectId);
  const configuration = {
    schemaVersion: 1 as const,
    runKind: "batch" as const,
    parameters: structuredClone(project.executionDescription.inputs.smoke),
    sampling: { kind: "single" as const, seed: 7 },
  };
  const experimentId = "experiment_stage7_continuous";
  store.createExperimentV4({
    commandId: "command_stage7_continuous_experiment",
    id: experimentId,
    projectId,
    name: "Stage 7 continuous smoke",
    plan: planExperiment({
      configuration,
      inputSchema: project.executionDescription.inputs.schema,
      maxSamples: 1,
    }),
    createdAt: NOW,
  });

  const service = app.a2!.service;
  const runTurn = await runAuthorizedTurn(service, {
    conversationId,
    requestKey: "stage7_continuous_run",
    text: "Start exactly one Run now from the Stage 7 continuous smoke Experiment configuration.",
    permissionMatches: (prompt) => prompt.includes(`Start a Run from Experiment ${experimentId}.`),
  });
  if (runTurn.mode !== "live") {
    const diagnostic = JSON.stringify({
      failure: runTurn.turn.failure,
      runs: store.listRuns(projectId).map((run) => ({ id: run.id, status: run.status })),
      messages: store.listConversationMessages(conversationId).map((message) => ({
        ordinal: message.ordinal,
        role: message.role,
        status: message.status,
        messageKind: message.messageKind,
        text: message.text.slice(0, 160),
      })),
      runtime: await service.conversationRuntime(conversationId),
    });
    t.diagnostic(diagnostic);
  }
  assert.equal(runTurn.mode, "live", JSON.stringify(runTurn.turn.failure));
  assert.equal(runTurn.turn.goalVerification?.disposition, "completed");
  const runAction = runTurn.turn.actions.find((action) =>
    action.actionKind === "run_start" && action.state === "committed");
  const startResource = runAction?.affectedResources.find((resource) =>
    resource.kind === "run_start_receipt") as Record<string, unknown> | undefined;
  assert.ok(startResource, "Run Action did not bind the immutable start receipt");
  const runId = String(startResource.id);
  const commandId = String(startResource.commandId);
  const startReceipt = store.getRunCommandReceiptEvidence({
    commandId,
    commandKind: "start",
    projectId,
  });
  assert.equal(startReceipt?.runId, runId);
  assert.equal(startReceipt?.receiptDigest, startResource.sha256);

  const succeeded = await waitForSucceededRun(app, projectId, runId);
  assert.equal(succeeded.status, "succeeded");
  const outputs = store.listRunOutputs(runId);
  assert.ok(outputs.length > 0, "succeeded Run published no immutable output");
  const output = outputs[0]!;
  const outputBytes = store.readObjectFile(output.file.id);
  assert.equal(outputBytes.byteLength, output.file.sizeBytes);
  const workspace = service.projectWorkspace(projectId);
  const projectedOutput = workspace.runs.find((item) => item.id === runId)
    ?.outputs.find((item) => item.id === output.id);
  assert.equal(projectedOutput?.sha256, output.file.sha256);
  const renderable = service.runOutputRenderable(projectId, runId, output.id);
  assert.equal(renderable.title, output.logicalName);

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const ownerUrl = (origin: string) => `${origin}/workbench/projects/${projectId}`
    + `?conversation=${conversationId}`;
  await page.goto(ownerUrl(started.origin));
  await page.getByRole("banner").waitFor({ timeout: 30_000 });
  await page.getByRole("img", { name: /受信浏览器页面观察/u })
    .waitFor({ timeout: 30_000 });
  const firstBrowserState = await browserState(page, conversationId);
  assert.equal(firstBrowserState.responseStatus, 200);
  assert.equal(firstBrowserState.body.recoveryState, "ready");
  const outputButton = page.getByRole("button", {
    name: new RegExp(escapeRegExp(output.logicalName), "u"),
  }).last();
  await outputButton.waitFor({ timeout: 30_000 });
  await outputButton.click();
  await page.getByRole("heading", { name: output.logicalName, exact: true })
    .waitFor({ timeout: 30_000 });

  await page.goto("about:blank");
  await app.close();
  app = undefined;
  // A BackendApp restart creates a new adapter process boundary. Reusing the
  // old in-memory adapter would retain process-local runtime boundaries that
  // cannot exist after a real service restart.
  adapter = createAdapter();
  assert.equal((await adapter.initialize()).status, "ready");
  started = await startApp();
  app = started.app;
  const restoredService = app.a2!.service;
  const restoredRun = app.productStore!.listRuns(projectId).find((item) => item.id === runId);
  assert.equal(restoredRun?.status, "succeeded");
  const restoredOutput = app.productStore!.listRunOutputs(runId)
    .find((item) => item.id === output.id);
  assert.equal(restoredOutput?.file.sha256, output.file.sha256);
  const restoredReceipt = app.productStore!.getRunCommandReceiptEvidence({
    commandId,
    commandKind: "start",
    projectId,
  });
  assert.equal(restoredReceipt?.receiptDigest, startReceipt?.receiptDigest);
  const restoredWorkspace = restoredService.projectWorkspace(projectId);
  assert.equal(restoredWorkspace.runs.find((item) => item.id === runId)
    ?.outputs.find((item) => item.id === output.id)?.sha256, output.file.sha256);
  assert.equal(
    restoredService.runOutputRenderable(projectId, runId, output.id).title,
    output.logicalName,
  );

  await page.goto(ownerUrl(started.origin));
  await page.getByRole("img", { name: /受信浏览器页面观察/u })
    .waitFor({ timeout: 30_000 });
  const secondBrowserState = await browserState(page, conversationId);
  assert.equal(secondBrowserState.responseStatus, 200);
  assert.equal(secondBrowserState.body.recoveryState, "ready");
  assert.equal(
    secondBrowserState.body.conversationGeneration,
    firstBrowserState.body.conversationGeneration,
    "restart changed the still-valid durable OpenCode session generation",
  );
  assert.notEqual(
    secondBrowserState.body.pageGeneration,
    firstBrowserState.body.pageGeneration,
    "restart reused the prior process-random Browser page generation seed",
  );
  const staleScreenshot = await page.evaluate(async ({ id, generation, pageGeneration }) => {
    const query = new URLSearchParams({
      conversationGeneration: String(generation),
      pageGeneration: String(pageGeneration),
    });
    const response = await fetch(`/api/conversations/${encodeURIComponent(id)}/browser/screenshot?${query}`);
    return { status: response.status, body: await response.json() };
  }, {
    id: conversationId,
    generation: firstBrowserState.body.conversationGeneration,
    pageGeneration: firstBrowserState.body.pageGeneration,
  });
  assert.equal(staleScreenshot.status, 409);
  assert.equal(staleScreenshot.body.error.code, "browser_page_stale");
  await page.getByRole("button", {
    name: new RegExp(escapeRegExp(output.logicalName), "u"),
  }).last().click();
  await page.getByRole("heading", { name: output.logicalName, exact: true })
    .waitFor({ timeout: 30_000 });

  t.diagnostic(
    `provider/model ${liveModel}; fallback 0; Run ${runId} succeeded; `
      + `output ${output.id} ${output.file.sha256}; Browser page generation `
      + `${firstBrowserState.body.pageGeneration}->`
      + `${secondBrowserState.body.pageGeneration}; restart receipt stable`,
  );
});

const runAuthorizedTurn = async (
  service: AgentWorkspaceService,
  input: Readonly<{
    conversationId: string;
    requestKey: string;
    text: string;
    permissionMatches: (prompt: string) => boolean;
  }>,
) => {
  let settled: Awaited<ReturnType<AgentWorkspaceService["runTurn"]>> | undefined;
  let failed: unknown;
  const turn = service.runTurn(input);
  void turn.then((value) => { settled = value; }, (error) => { failed = error; });
  const deadline = Date.now() + 180_000;
  const answered = new Set<string>();
  let authorized = false;
  while (Date.now() < deadline) {
    if (failed) throw failed;
    if (settled) break;
    const runtime = await service.conversationRuntime(input.conversationId);
    const candidate = runtime.interactions.find((item) =>
      item.kind === "permission" && !answered.has(item.id));
    if (candidate?.kind === "permission") {
      answered.add(candidate.id);
      const allow = !authorized && input.permissionMatches(candidate.permission);
      await service.resumeTurn({
        conversationId: input.conversationId,
        requestKey: input.requestKey,
        interactionId: candidate.id,
        response: { kind: "permission", decision: allow ? "once" : "reject" },
      });
      if (allow) authorized = true;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  assert.equal(authorized, true, "real turn did not expose the exact Run permission");
  assert.ok(settled, "real turn did not settle after bounded permission handling");
  return turn;
};

const waitForSucceededRun = async (app: BackendApp, projectId: string, runId: string) => {
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    const run = app.productStore!.listRuns(projectId).find((item) => item.id === runId);
    if (run && ["succeeded", "failed", "cancelled", "timed_out"].includes(run.status)) {
      assert.equal(run.status, "succeeded", JSON.stringify(run));
      return run;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error("real dispatcher did not publish a terminal Run in time");
};

const browserState = async (page: Page, conversationId: string) => page.evaluate(async (id) => {
  const response = await fetch(`/api/conversations/${encodeURIComponent(id)}/browser`);
  return { responseStatus: response.status, body: await response.json() };
}, conversationId);

const waitForHealth = async (url: string): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(750) });
      if (response.ok) return;
    } catch { /* OpenCode is still starting. */ }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error("OpenCode pure server did not become healthy");
};

const freePort = async (): Promise<number> => new Promise((resolvePort, reject) => {
  const server = createNetServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    server.close((error) => error
      ? reject(error)
      : resolvePort(typeof address === "object" && address ? address.port : 0));
  });
});

const stopChild = async (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await Promise.race([exited, new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000))]);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
};

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
