import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentTurnRuntime } from "../src/agent-turn-runtime.ts";
import { AgentWorkspaceService } from "../src/agent-workspace-service.ts";
import { HttpOpenCodeAdapter } from "../src/opencode-adapter.ts";
import { ProductStoreV2 } from "../src/product-store-v2.ts";
import { SimulationSkillCatalog } from "../src/simulation-skill-catalog.ts";

const liveModel = process.env.RIFFOLOGY_STAGE6_SMOKE_MODEL?.trim() ?? "";
const runLive = process.env.RUN_RIFFOLOGY_STAGE6_REAL_OPENCODE === "true"
  && liveModel.includes("/");
const expectedVersion = process.env.OPENCODE_EXPECTED_VERSION?.trim() || "1.18.11";
const NOW = "2026-08-02T06:00:00.000Z";

/**
 * Opt-in acceptance harness. It inherits the operator's existing local
 * OpenCode authentication and never reads, prints, copies, or writes provider
 * credentials. The default test suite skips it.
 */
test(`opt-in Riffology Stage 6 completes bootstrap, multi-turn Model/Project, and restart recovery (${expectedVersion})`, {
  skip: !runLive,
  timeout: 240_000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "riffology-stage6-real-opencode-"));
  const skillRoot = join(root, "skills");
  await mkdir(skillRoot);
  const port = await freePort();
  const child = spawn(
    "opencode",
    ["serve", "--pure", "--hostname", "127.0.0.1", "--port", String(port)],
    { cwd: root, stdio: "ignore", env: process.env },
  );
  let store: ProductStoreV2 | undefined;
  let mcpServer: Server | undefined;
  t.after(async () => {
    if (mcpServer) await closeServer(mcpServer);
    await stopChild(child);
    store?.close();
    await rm(root, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(`${baseUrl}/global/health`);
  const health = await readJson(`${baseUrl}/global/health`);
  assert.equal(health.version, expectedVersion);
  const [providerId, ...modelParts] = liveModel.split("/");
  const modelId = modelParts.join("/");
  const adapter = new HttpOpenCodeAdapter({
    baseUrl,
    workdir: root,
    expectedVersion,
    model: liveModel,
    allowedProviders: [providerId],
    requestTimeoutMs: 180_000,
  });
  assert.equal((await adapter.initialize()).status, "ready");

  store = ProductStoreV2.open(join(root, "store"));
  store.createModel({
    id: "model_stage6_source", name: "Stage 6 Source",
    technicalStatus: "executable", runMode: "batch", createdAt: NOW,
    executionDescription: executableDescription(),
    files: [
      { id: "file_stage6_source", kind: "model_code", relativePath: "model.py", mediaType: "text/x-python", bytes: Buffer.from("print('ok')\n") },
      { id: "env_stage6_source", kind: "model_environment", relativePath: "requirements.txt", mediaType: "text/plain", bytes: Buffer.from("") },
    ],
  });
  const projectWorkspace = store.createWorkspaceBinding({
    commandId: "stage6_live_project_workspace_create",
    workspaceKey: "stage6_live_project_workspace",
    createdAt: NOW,
  });
  store.createProjectFromModel({
    projectId: "project_stage6_live", projectName: "Stage 6 Project",
    sourceModelId: "model_stage6_source", createdAt: NOW,
    conversation: {
      id: "conversation_stage6_live_project", name: "Main",
      providerId, providerModelId: modelId, createdAt: NOW,
    },
    workspaceBinding: {
      commandId: "stage6_live_project_create",
      workspaceKey: "stage6_live_project_workspace",
      expectedGeneration: projectWorkspace.binding.generation,
      expectedBindingDigest: projectWorkspace.binding.bindingDigest,
    },
  });

  let runtime = new AgentTurnRuntime(
    store, new SimulationSkillCatalog(skillRoot, []), { now: () => NOW },
  );
  let lastAdapterStage = "none";
  let lastAdapterFailureCode = "none";
  let restartRecoveryActive = false;
  const adapterFailures: Array<{
    code: string;
    stage: string;
    restartRecoveryActive: boolean;
  }> = [];
  const observedAdapter = new Proxy(adapter, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        lastAdapterStage = String(property);
        try { return await value.apply(target, args); }
        catch (error) {
          lastAdapterFailureCode = typeof (error as any)?.code === "string"
            ? (error as any).code : "non_api_error";
          adapterFailures.push({
            code: lastAdapterFailureCode,
            stage: lastAdapterStage,
            restartRecoveryActive,
          });
          throw error;
        }
      };
    },
  });
  let service!: AgentWorkspaceService;
  const endpoint = await mcpEndpoint((capability, request) =>
    service.handleAgentMcp(capability, request));
  mcpServer = endpoint.server;
  service = new AgentWorkspaceService(
    store, observedAdapter, () => NOW, undefined, runtime,
    (capability) => `${endpoint.origin}/a2/mcp?cap=${encodeURIComponent(capability)}`,
  );

  const unbound = await service.createWorkspaceBinding({
    commandId: "stage6_live_workspace_create",
    workspaceKey: "stage6_live_workspace",
  });
  const selected = await service.updateWorkspaceBinding({
    commandId: "stage6_live_workspace_provider",
    workspaceKey: "stage6_live_workspace",
    expectedGeneration: unbound.binding.generation,
    expectedBindingDigest: unbound.binding.bindingDigest,
    draft: "Create a Model named Live Bootstrap Model.",
    provider: { providerId, modelId },
  });
  const bootstrapRuntime = store.getWorkspaceBootstrapRuntime(
    selected.binding.workspaceKey,
  );
  assert.equal(bootstrapRuntime.directory, await realpath(bootstrapRuntime.directory));
  const bootstrapModels = await adapter.discoverProviderModels({
    owner: { kind: "workspace", id: selected.binding.workspaceKey },
    directory: bootstrapRuntime.directory,
  });
  assert.equal(bootstrapModels.some((candidate) =>
    candidate.providerId === providerId && candidate.modelId === modelId), true);
  const bootstrapped = await service.runWorkspaceBootstrapTurn({
    workspaceKey: "stage6_live_workspace",
    requestKey: "stage6_live_bootstrap_model",
    expectedGeneration: selected.binding.generation,
    expectedBindingDigest: selected.binding.bindingDigest,
    text: "Create a Model named Live Bootstrap Model.",
  });
  assert.equal(bootstrapped.mode, "live",
    `${bootstrapped.reason ?? "bootstrap failed"}:${lastAdapterStage}:${lastAdapterFailureCode}`);
  assert.equal(bootstrapped.binding.state, "bound");
  assert.equal(bootstrapped.binding.owner?.kind, "model");
  assert.equal(bootstrapped.binding.conversation.kind, "owner");
  const bootstrappedModelId = bootstrapped.binding.owner!.id;
  const modelConversationId = bootstrapped.binding.conversation.id;
  assert.ok(store.getWorkspaceBindingReceipt(
    "stage6_live_bootstrap_model",
  ) || store.getWorkspaceBinding("stage6_live_workspace").state === "bound");

  const modelTurn = await runAuthorizedTurn(t, service, {
    conversationId: modelConversationId,
    requestKey: "stage6_live_model_rename",
    text: "Rename this Model to Stage 6 Accepted Model.",
  });
  assert.equal(modelTurn.mode, "live", JSON.stringify(modelTurn.turn.failure));
  assert.equal(modelTurn.turn.goalVerification?.disposition, "completed");
  assert.equal(
    store.listModels({ includeArchived: true }).find((item) =>
      item.id === bootstrappedModelId)?.name,
    "Stage 6 Accepted Model",
  );
  assert.equal(
    store.agentGoalEvidence(
      modelConversationId, "stage6_live_model_rename",
    ).affectedResourcesVerified,
    true,
  );
  const modelTurnTwo = await runAuthorizedTurn(t, service, {
    conversationId: modelConversationId,
    requestKey: "stage6_live_model_rename_two",
    text: "Rename this Model to Stage 6 Accepted Model Two.",
  });
  assert.equal(modelTurnTwo.mode, "live", JSON.stringify(modelTurnTwo.turn.failure));
  assert.equal(modelTurnTwo.turn.goalVerification?.disposition, "completed");
  assert.equal(store.listModels({ includeArchived: true }).find((item) =>
    item.id === bootstrappedModelId)?.name, "Stage 6 Accepted Model Two");

  const projectTurn = await runAuthorizedTurn(t, service, {
    conversationId: "conversation_stage6_live_project",
    requestKey: "stage6_live_project_experiment",
    text: "Create a new Experiment configuration named Live acceptance with one batch sample and horizon 1.",
  });
  assert.equal(projectTurn.mode, "live", JSON.stringify(projectTurn.turn.failure));
  assert.equal(projectTurn.turn.goalVerification?.disposition, "completed");
  assert.equal(store.listExperimentConfigurations("project_stage6_live").length, 1);
  assert.equal(
    store.agentGoalEvidence(
      "conversation_stage6_live_project", "stage6_live_project_experiment",
    ).affectedResourcesVerified,
    true,
  );
  const liveExperiment = store.listExperimentConfigurations(
    "project_stage6_live",
  )[0]!;
  const projectRunTurn = await runAuthorizedTurn(t, service, {
    conversationId: "conversation_stage6_live_project",
    requestKey: "stage6_live_project_run",
    text: "Start one Run from the Live acceptance Experiment configuration now.",
    permissionMatches: (permission) => permission.includes(
      `Start a Run from Experiment ${liveExperiment.id}.`,
    ),
  });
  assert.equal(
    projectRunTurn.mode,
    "live",
    JSON.stringify(projectRunTurn.turn.failure),
  );
  assert.equal(projectRunTurn.turn.goalVerification?.disposition, "completed");
  assert.equal(
    store.agentGoalEvidence(
      "conversation_stage6_live_project", "stage6_live_project_run",
    ).affectedResourcesVerified,
    true,
  );
  const liveRun = store.listRuns("project_stage6_live")[0]!;
  assert.equal(liveRun.status, "queued");
  const liveRunAction = projectRunTurn.turn.actions.find((action) =>
    action.actionKind === "run_start" && action.state === "committed");
  const liveRunResource = liveRunAction?.affectedResources.find((resource) =>
    resource.kind === "run_start_receipt") as Record<string, unknown> | undefined;
  assert.equal(liveRunResource?.id, liveRun.id);
  const liveRunCommandId = String(liveRunResource?.commandId ?? "");
  const liveRunReceipt = store.getRunCommandReceiptEvidence({
    commandId: liveRunCommandId,
    commandKind: "start",
    projectId: "project_stage6_live",
  });
  assert.equal(liveRunReceipt?.runId, liveRun.id);
  assert.equal(liveRunReceipt?.receiptDigest, liveRunResource?.sha256);
  const projectTurnTwo = await runAuthorizedTurn(t, service, {
    conversationId: "conversation_stage6_live_project",
    requestKey: "stage6_live_project_rename",
    text: "Rename this Project to Stage 6 Accepted Project.",
  });
  assert.equal(projectTurnTwo.mode, "live", JSON.stringify(projectTurnTwo.turn.failure));
  assert.equal(projectTurnTwo.turn.goalVerification?.disposition, "completed");
  assert.equal(store.getProject("project_stage6_live").name, "Stage 6 Accepted Project");

  restartRecoveryActive = true;
  store.close();
  store = undefined;
  store = ProductStoreV2.open(join(root, "store"));
  runtime = new AgentTurnRuntime(
    store, new SimulationSkillCatalog(skillRoot, []), { now: () => NOW },
  );
  service = new AgentWorkspaceService(
    store, adapter, () => NOW, undefined, runtime,
    (capability) => `${endpoint.origin}/a2/mcp?cap=${encodeURIComponent(capability)}`,
  );
  const restoredBinding = await service.workspaceBinding("stage6_live_workspace");
  assert.equal(restoredBinding.state, "bound");
  assert.deepEqual(restoredBinding.owner, {
    kind: "model", id: bootstrappedModelId,
  });
  assert.equal(restoredBinding.conversation.id, modelConversationId);
  const restoredProjectBinding = await service.workspaceBinding(
    "stage6_live_project_workspace",
  );
  assert.equal(restoredProjectBinding.state, "bound");
  assert.deepEqual(restoredProjectBinding.owner, {
    kind: "project", id: "project_stage6_live",
  });
  const restoredRun = store.listRuns("project_stage6_live").find((run) =>
    run.id === liveRun.id);
  assert.equal(restoredRun?.status, "queued");
  const restoredRunReceipt = store.getRunCommandReceiptEvidence({
    commandId: liveRunCommandId,
    commandKind: "start",
    projectId: "project_stage6_live",
  });
  assert.equal(restoredRunReceipt?.receiptDigest, liveRunReceipt?.receiptDigest);
  assert.equal(
    restoredProjectBinding.conversation.id,
    "conversation_stage6_live_project",
  );
  assert.ok(store.listConversationMessages(modelConversationId).length >= 4);
  assert.ok(store.listConversationMessages("conversation_stage6_live_project").length >= 4);
  assert.equal(store.listExperimentConfigurations("project_stage6_live").length, 1);

  const modelAfterRestart = await service.runTurn({
    conversationId: modelConversationId,
    requestKey: "stage6_live_model_after_restart",
    text: "Explain the current Model without changing it.",
  });
  assert.equal(modelAfterRestart.mode, "live", JSON.stringify(modelAfterRestart.turn.failure));
  assert.equal(modelAfterRestart.turn.goalVerification?.disposition, "completed");
  const projectAfterRestart = await service.runTurn({
    conversationId: "conversation_stage6_live_project",
    requestKey: "stage6_live_project_after_restart",
    text: "Explain the current Project without changing it.",
  });
  assert.equal(projectAfterRestart.mode, "live", JSON.stringify(projectAfterRestart.turn.failure));
  assert.equal(projectAfterRestart.turn.goalVerification?.disposition, "completed");
  assert.ok(adapterFailures.length > 0);
  assert.ok(adapterFailures.every((failure) =>
    failure.code === "opencode_session_workspace_mismatch"),
  `only expected old-session workspace rejections may occur: ${JSON.stringify(adapterFailures)}`);
  t.diagnostic(
    `provider/model ${providerId}/${modelId}; fallback 0; provider/auth failure 0; `
      + `expected session-workspace identity rejection signals ${adapterFailures.length}; `
      + `post-restart signals ${adapterFailures.filter((item) =>
        item.restartRecoveryActive).length}; Model and Project rebuild 2/2`,
  );
});

const runAuthorizedTurn = async (
  t: { diagnostic(message: string): void },
  service: AgentWorkspaceService,
  input: Readonly<{
    conversationId: string;
    requestKey: string;
    text: string;
    permissionMatches?: (permission: string) => boolean;
  }>,
) => {
  let settled: unknown;
  let failed: unknown;
  const turn = service.runTurn(input);
  void turn.then((value) => { settled = value; }, (error) => { failed = error; });
  const deadline = Date.now() + 120_000;
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
      assert.doesNotMatch(
        JSON.stringify(candidate),
        /capability|operationCommitment|[0-9a-f]{64}/u,
      );
      const permissionMatchesGoal = input.permissionMatches
        ? input.permissionMatches(candidate.permission) : (() => {
        switch (input.requestKey) {
          case "stage6_live_model_rename":
            return candidate.permission.includes(
              'Rename the current object to "Stage 6 Accepted Model".',
            );
          case "stage6_live_model_rename_two":
            return candidate.permission.includes(
              'Rename the current object to "Stage 6 Accepted Model Two".',
            );
          case "stage6_live_project_experiment":
            return candidate.permission.includes('Create Experiment "Live acceptance".')
              && candidate.permission.includes("Run kind batch; samples 1;")
              && candidate.permission.includes("horizon=1");
          case "stage6_live_project_rename":
            return candidate.permission.includes(
              'Rename the current object to "Stage 6 Accepted Project".',
            );
          default:
            return false;
        }
      })();
      const decision = authorized || !permissionMatchesGoal
        ? "reject" as const : "once" as const;
      t.diagnostic(`${input.requestKey}: ${decision} ${candidate.permission}`);
      await service.resumeTurn({
        conversationId: input.conversationId,
        requestKey: input.requestKey,
        interactionId: candidate.id,
        response: { kind: "permission", decision },
      });
      if (decision === "once") authorized = true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(authorized, true,
    `turn completed before exact permission: ${JSON.stringify(settled)}`);
  assert.ok(settled, "real OpenCode turn did not settle after bounded permission handling");
  return turn;
};

const executableDescription = () => ({
  schemaVersion: 2,
  runtime: "python",
  runMode: "batch",
  dependencyFile: "environment/requirements.txt",
  inputs: {
    schemaProfile: "riff-json-schema-2020-12-v1",
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object", additionalProperties: false,
      properties: { horizon: { type: "integer", minimum: 1 } },
      required: ["horizon"],
    },
    smoke: { horizon: 1 },
  },
  outputs: [{
    logicalName: "summary", relativePath: "summary.json",
    mediaType: "application/json", required: true, role: "data",
  }],
  batch: { entryPoint: "code/model.py", protocol: "riff-batch-v1" },
  cancellation: { signal: "SIGTERM", graceMs: 100 },
});

const mcpEndpoint = async (
  handle: (capability: string | undefined, request: unknown) => Promise<unknown> | unknown,
): Promise<{ server: Server; origin: string }> => {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method !== "POST" || url.pathname !== "/a2/mcp") {
        response.writeHead(404).end();
        return;
      }
      const payload = JSON.parse(await requestBody(request) || "null");
      const entries = Array.isArray(payload) ? payload : [payload];
      const results = (await Promise.all(entries.map((entry) =>
        handle(url.searchParams.get("cap") ?? undefined, entry))))
        .filter((entry) => entry !== undefined);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(Array.isArray(payload) ? results : results[0] ?? null));
    } catch {
      response.writeHead(400).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("MCP endpoint did not bind.");
  return { server, origin: `http://127.0.0.1:${address.port}` };
};

const requestBody = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 1_000_000) throw new Error("MCP request exceeds limit.");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
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
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(750) });
      if (response.ok) return;
    } catch { /* process is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("OpenCode pure server did not become healthy.");
};

const readJson = async (url: string): Promise<any> => {
  const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
  if (!response.ok) throw new Error(`OpenCode smoke endpoint returned ${response.status}.`);
  return response.json();
};

const stopChild = async (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1_000))]);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
};

const closeServer = async (server: Server): Promise<void> =>
  new Promise((resolve) => server.close(() => resolve()));
