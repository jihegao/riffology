import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { MesaAdapter, MesaModel, MesaRun, MesaRunRequest } from "../src/adapters.ts";
import type {
  OpenCodeAssistantResponse,
  OpenCodeConversationPort,
  OpenCodePrompt,
  OpenCodeProviderModel,
  OpenCodeSession,
  OpenCodeReadiness,
} from "../src/opencode-adapter.ts";
import { BackendApp } from "../src/server.ts";

const NOW = "2026-07-25T10:00:00.000Z";

class ProductApiOpenCode implements OpenCodeConversationPort {
  discoveryError?: Error;

  async discoverProviderModels(): Promise<OpenCodeProviderModel[]> {
    if (this.discoveryError) throw this.discoveryError;
    return [{
      providerId: "provider-a",
      modelId: "model-a",
      qualifiedId: "provider-a/model-a",
    }, {
      providerId: "provider-b",
      modelId: "model-b",
      qualifiedId: "provider-b/model-b",
    }];
  }
  async initialize(): Promise<OpenCodeReadiness> {
    return { status: "ready", modelId: "provider-a/model-a", version: "test" };
  }
  async getSession(): Promise<OpenCodeSession | undefined> { return undefined; }
  async createSession(): Promise<OpenCodeSession> {
    throw new Error("unused");
  }
  async injectContext(): Promise<void> { throw new Error("unused"); }
  async promptWithModel(
    _sessionId: string,
    _providerId: string,
    _modelId: string,
    _prompt: OpenCodePrompt,
  ): Promise<OpenCodeAssistantResponse> {
    throw new Error("unused");
  }
  async prompt(): Promise<void> {}
  async abort(): Promise<void> {}
}

class ProductApiMesa implements MesaAdapter {
  async loadModel(): Promise<MesaModel> { throw new Error("unused"); }
  async startRun(_projectId: string, _request: MesaRunRequest): Promise<MesaRun> {
    throw new Error("unused");
  }
  async getRun(): Promise<MesaRun> { throw new Error("unused"); }
  async cancelRun(): Promise<MesaRun> { throw new Error("unused"); }
}

type BrowserSession = Readonly<{
  cookie: string;
  csrfToken: string;
  generation: number;
}>;

const bootstrap = async (baseUrl: string): Promise<BrowserSession> => {
  const response = await fetch(`${baseUrl}/api/browser-session/bootstrap`, {
    method: "POST",
    body: "{}",
    headers: {
      "content-type": "application/json",
      origin: baseUrl,
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "cors",
      "sec-fetch-dest": "empty",
    },
  });
  assert.equal(response.status, 201, await response.clone().text());
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);
  const body = await response.json() as any;
  return {
    cookie,
    csrfToken: body.csrfToken,
    generation: body.generation,
  };
};

const readHeaders = (session: BrowserSession): Record<string, string> => ({
  cookie: session.cookie,
  "sec-fetch-site": "same-origin",
  "sec-fetch-mode": "cors",
  "sec-fetch-dest": "empty",
});

const mutationHeaders = (
  baseUrl: string,
  session: BrowserSession,
): Record<string, string> => ({
  "content-type": "application/json",
  cookie: session.cookie,
  origin: baseUrl,
  "sec-fetch-site": "same-origin",
  "sec-fetch-mode": "cors",
  "sec-fetch-dest": "empty",
  "x-riff-csrf": session.csrfToken,
});

const requestJson = async (
  baseUrl: string,
  session: BrowserSession,
  method: "POST" | "PATCH",
  path: string,
  body: unknown,
) => await fetch(`${baseUrl}${path}`, {
  method,
  headers: mutationHeaders(baseUrl, session),
  body: JSON.stringify(body),
});

const addFixtureData = (app: BackendApp): void => {
  const executionDescription = {
    schemaVersion: 2,
    runtime: "python",
    runMode: "batch",
    dependencyFile: "environment/requirements.txt",
    inputs: {
      schemaProfile: "riff-json-schema-2020-12-v1",
      schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      smoke: {},
    },
    outputs: [{
      logicalName: "result",
      relativePath: "outputs/result.json",
      mediaType: "application/json",
      required: true,
      role: "data",
    }],
    batch: { entryPoint: "code/model.py", protocol: "riff-batch-v1" },
    cancellation: { signal: "SIGTERM", graceMs: 500 },
  };
  app.productStore!.createModel({
    id: "model_a4_api",
    name: "A4 API Model",
    technicalStatus: "executable",
    runMode: "batch",
    executionDescription,
    createdAt: NOW,
    files: [{
      id: "file_a4_api_model",
      kind: "model_code",
      relativePath: "model.py",
      mediaType: "text/x-python",
      bytes: Buffer.from("print('ok')\n"),
    }, {
      id: "file_a4_api_environment",
      kind: "model_environment",
      relativePath: "requirements.txt",
      mediaType: "text/plain",
      bytes: Buffer.from("# none\n"),
    }, {
      id: "file_a4_api_active",
      kind: "model_visual_asset",
      relativePath: "preview.html",
      mediaType: "text/html",
      bytes: Buffer.from("<script>globalThis.unsafe = true</script>\n"),
    }],
  });
  app.productStore!.createProjectFromModel({
    projectId: "project_a4_api",
    projectName: "A4 API Project",
    sourceModelId: "model_a4_api",
    createdAt: NOW,
  });
  app.productStore!.createConversation({
    id: "conversation_a4_delete",
    owner: { kind: "model", id: "model_a4_api" },
    name: "Delete me",
    providerId: "provider-a",
    providerModelId: "model-a",
    createdAt: NOW,
  });
  app.productStore!.createConversation({
    id: "conversation_a4_token",
    owner: { kind: "model", id: "model_a4_api" },
    name: "Token negative",
    providerId: "provider-a",
    providerModelId: "model-a",
    createdAt: NOW,
  });
};

test("A4-1 browser API exposes closed collections and replays confirmed delete after restart", {
  timeout: 30_000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "riff-a4-product-api-"));
  const productRoot = join(root, "product");
  const legacyRoot = join(root, "legacy");
  await mkdir(legacyRoot, { recursive: true, mode: 0o700 });
  const openCode = new ProductApiOpenCode();
  let app: BackendApp | undefined;
  t.after(async () => {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  });

  app = new BackendApp({
    mesa: new ProductApiMesa(),
    openCode,
    a2OpenCode: openCode,
    a2ProductRoot: productRoot,
    workspaceRoot: legacyRoot,
    defaultSessionId: "a4-product-api",
    a3PythonExecutable: process.execPath,
    browserFrameTargetResolver: {
      resolve: async (projectId, runId) => ({
        projectId,
        runId,
        attemptGeneration: 1,
        port: 45_967,
        expiresAtMs: Date.now() + 60_000,
      }),
      inspect: async () => true,
    },
  });
  await app.initialize();
  addFixtureData(app);
  let network = await app.listenBrowserNetwork();
  let baseUrl = network.app.origin;
  let session = await bootstrap(baseUrl);

  const retiredGate3 = await fetch(
    `${baseUrl}/api/projects/project_a4_api/browser-projection/v1`,
    { headers: readHeaders(session) },
  );
  assert.equal(retiredGate3.status, 404);
  const retiredGate3Body = await retiredGate3.json() as any;
  assert.equal(retiredGate3Body.error.code, "not_found");
  assert.equal(retiredGate3Body.schema_id, undefined);
  assert.doesNotMatch(JSON.stringify(retiredGate3Body), /evidence-studio/u);

  const unauthenticated = await fetch(`${baseUrl}/api/home`);
  assert.equal(unauthenticated.status, 403);
  assert.equal(unauthenticated.headers.get("cache-control"), "private, no-store");
  assert.equal(unauthenticated.headers.get("x-content-type-options"), "nosniff");

  const homeResponse = await fetch(`${baseUrl}/api/home`, {
    headers: readHeaders(session),
  });
  assert.equal(homeResponse.status, 200, await homeResponse.clone().text());
  assert.equal(homeResponse.headers.get("cache-control"), "private, no-store");
  const home = await homeResponse.json() as any;
  assert.equal(home.schemaVersion, 1);
  assert.equal(home.models.length, 1);
  assert.equal(home.projects.length, 1);
  assert.equal(home.newProjectModels.length, 1);
  assert.equal(home.providerAvailability.mode, "live");
  assert.match(home.collectionDigest, /^[0-9a-f]{64}$/u);
  const serializedHome = JSON.stringify(home);
  for (const forbidden of [
    productRoot,
    legacyRoot,
    "executionDescription",
    "relativePath",
    "externalSessionRef",
  ]) {
    assert.equal(serializedHome.includes(forbidden), false, forbidden);
  }

  const modelWorkspaceResponse = await fetch(
    `${baseUrl}/api/models/model_a4_api/workspace`,
    { headers: readHeaders(session) },
  );
  assert.equal(modelWorkspaceResponse.status, 200);
  const modelWorkspace = await modelWorkspaceResponse.json() as any;
  assert.equal(modelWorkspace.execution.runMode, "batch");
  assert.equal(modelWorkspace.execution.outputs[0].logicalName, "result");
  assert.equal(modelWorkspace.files.some((file: any) => file.relativePath === "code/model.py"), true);

  const modelRenderableResponse = await fetch(
    `${baseUrl}/api/models/model_a4_api/renderables/file_a4_api_model`,
    { headers: readHeaders(session) },
  );
  assert.equal(modelRenderableResponse.status, 200);
  const modelRenderable = await modelRenderableResponse.json() as any;
  assert.deepEqual(modelRenderable, {
    kind: "code",
    title: "code/model.py",
    language: "python",
    text: "print('ok')\n",
  });
  const activeRenderableResponse = await fetch(
    `${baseUrl}/api/models/model_a4_api/renderables/file_a4_api_active`,
    { headers: readHeaders(session) },
  );
  assert.equal(activeRenderableResponse.status, 200);
  const activeRenderable = await activeRenderableResponse.json() as any;
  assert.equal(activeRenderable.kind, "attachment");
  assert.equal(activeRenderable.mediaType, "text/html");
  assert.equal(activeRenderable.reason, "active_content");
  assert.match(activeRenderable.sha256, /^[0-9a-f]{64}$/u);
  assert.equal(JSON.stringify(activeRenderable).includes("<script>"), false);
  const activeDownloadResponse = await fetch(
    `${baseUrl}/api/models/model_a4_api/files/file_a4_api_active/download`,
    { headers: readHeaders(session) },
  );
  assert.equal(activeDownloadResponse.status, 200);
  assert.equal(activeDownloadResponse.headers.get("cache-control"), "private, no-store");
  assert.equal(activeDownloadResponse.headers.get("content-type"), "application/octet-stream");
  assert.equal(activeDownloadResponse.headers.get("content-security-policy"), "sandbox");
  assert.equal(activeDownloadResponse.headers.get("x-content-type-options"), "nosniff");
  assert.match(activeDownloadResponse.headers.get("content-disposition") ?? "", /^attachment;/u);
  assert.equal(
    await activeDownloadResponse.text(),
    "<script>globalThis.unsafe = true</script>\n",
  );

  const projectWorkspaceResponse = await fetch(
    `${baseUrl}/api/projects/project_a4_api/workspace`,
    { headers: readHeaders(session) },
  );
  assert.equal(projectWorkspaceResponse.status, 200);
  const projectWorkspace = await projectWorkspaceResponse.json() as any;
  assert.equal(projectWorkspace.execution.runMode, "batch");
  assert.match(projectWorkspace.executionDescriptionDigest, /^[0-9a-f]{64}$/u);
  assert.equal(projectWorkspace.project.sourceModelId, "model_a4_api");

  const experimentCreate = await requestJson(
    baseUrl,
    session,
    "POST",
    "/api/projects/project_a4_api/experiment-configs",
    {
      commandId: "command_a4_experiment_create",
      name: "Two seeds",
      configuration: {
        schemaVersion: 1,
        runKind: "batch",
        parameters: {},
        sampling: { kind: "multiple-seeds", seeds: [3, 7] },
      },
    },
  );
  assert.equal(experimentCreate.status, 201, await experimentCreate.clone().text());
  const experiment = await experimentCreate.json() as any;
  assert.equal(experiment.sampleCount, 2);
  assert.equal(experiment.samplePreview.length, 2);
  assert.deepEqual(experiment.samplePreview.map((sample: any) => sample.seed), [3, 7]);
  assert.equal(experiment.samplePreviewTruncated, false);

  const activeModels = await fetch(`${baseUrl}/api/models?lifecycle=active`, {
    headers: readHeaders(session),
  });
  assert.equal(activeModels.status, 200);
  assert.equal((await activeModels.json() as any).models.length, 1);
  const duplicateLifecycle = await fetch(
    `${baseUrl}/api/models?lifecycle=active&lifecycle=active`,
    { headers: readHeaders(session) },
  );
  assert.equal(duplicateLifecycle.status, 422);

  for (const [kind, id] of [
    ["model", "model_a4_api"],
    ["project", "project_a4_api"],
  ] as const) {
    const initialRecordDigest = app.productStore!.resourceRecordDigest(kind, id);
    const archived = await requestJson(
      baseUrl,
      session,
      "POST",
      `/api/resources/${kind}/${id}/archive`,
      {
        commandId: `command_a4_${kind}_archive`,
        expectedRecordDigest: initialRecordDigest,
      },
    );
    assert.equal(archived.status, 200, await archived.clone().text());
    const archiveReceipt = await archived.json() as any;
    assert.equal(archiveReceipt.currentLifecycleState, "archived");
    const restored = await requestJson(
      baseUrl,
      session,
      "POST",
      `/api/resources/${kind}/${id}/restore`,
      {
        commandId: `command_a4_${kind}_restore`,
        expectedRecordDigest: archiveReceipt.currentRecordDigest,
      },
    );
    assert.equal(restored.status, 200, await restored.clone().text());
    assert.equal((await restored.json() as any).currentLifecycleState, "active");
  }

  const modelPreviewResponse = await requestJson(
    baseUrl,
    session,
    "POST",
    "/api/resources/model/model_a4_api/permanent-delete-preview",
    {},
  );
  assert.equal(modelPreviewResponse.status, 200);
  const modelPreview = await modelPreviewResponse.json() as any;
  assert.ok(modelPreview.blockingReferences.some((reference: any) =>
    reference.reasonCode === "project_lineage"
    && reference.id === "project_a4_api"));

  const retiredCreateBody = {
    commandId: "command_a4_retired_create",
    name: "Retired Model",
    providerId: "provider-a",
    modelId: "model-a",
  };
  const retiredCreatedResponse = await requestJson(
    baseUrl,
    session,
    "POST",
    "/api/models",
    retiredCreateBody,
  );
  assert.equal(
    retiredCreatedResponse.status,
    201,
    await retiredCreatedResponse.clone().text(),
  );
  const retiredCreated = await retiredCreatedResponse.json() as any;
  const retiredModelId = retiredCreated.model.id as string;
  const retiredTrash = await requestJson(
    baseUrl,
    session,
    "POST",
    `/api/resources/model/${retiredModelId}/trash`,
    {
      commandId: "command_a4_retired_trash",
      expectedRecordDigest: app.productStore!.resourceRecordDigest(
        "model",
        retiredModelId,
      ),
    },
  );
  assert.equal(retiredTrash.status, 200, await retiredTrash.clone().text());
  const retiredPreviewResponse = await requestJson(
    baseUrl,
    session,
    "POST",
    `/api/resources/model/${retiredModelId}/permanent-delete-preview`,
    {},
  );
  assert.equal(retiredPreviewResponse.status, 200);
  const retiredPreview = await retiredPreviewResponse.json() as any;
  const retiredDelete = await requestJson(
    baseUrl,
    session,
    "POST",
    `/api/resources/model/${retiredModelId}/permanent-delete`,
    {
      commandId: "command_a4_retired_delete",
      previewToken: retiredPreview.previewToken,
      stateToken: retiredPreview.stateToken,
      confirmationToken: retiredPreview.confirmationToken,
      confirmation: {
        action: "permanently_delete",
        kind: "model",
        id: retiredModelId,
        recordCount: retiredPreview.recordCount,
        fileCount: retiredPreview.fileCount,
        totalBytes: retiredPreview.totalBytes,
      },
    },
  );
  assert.equal(retiredDelete.status, 200, await retiredDelete.clone().text());
  const delayedCreateReplay = await requestJson(
    baseUrl,
    session,
    "POST",
    "/api/models",
    retiredCreateBody,
  );
  assert.equal(delayedCreateReplay.status, 409);
  assert.equal(
    (await delayedCreateReplay.json() as any).error.code,
    "idempotency_conflict",
  );

  const frameIssued = await fetch(
    `${baseUrl}/api/projects/project_a4_api/runs/run_a4_frame/visual-frame-session`,
    {
      method: "POST",
      headers: {
        cookie: session.cookie,
        origin: baseUrl,
        "sec-fetch-site": "same-origin",
        "sec-fetch-mode": "cors",
        "sec-fetch-dest": "empty",
        "x-riff-csrf": session.csrfToken,
      },
    },
  );
  assert.equal(frameIssued.status, 201, await frameIssued.clone().text());
  const projectTrash = await requestJson(
    baseUrl,
    session,
    "POST",
    "/api/resources/project/project_a4_api/trash",
    {
      commandId: "command_a4_project_trash_with_frame",
      expectedRecordDigest: app.productStore!.resourceRecordDigest(
        "project",
        "project_a4_api",
      ),
    },
  );
  assert.equal(projectTrash.status, 200, await projectTrash.clone().text());
  const projectPreviewResponse = await requestJson(
    baseUrl,
    session,
    "POST",
    "/api/resources/project/project_a4_api/permanent-delete-preview",
    {},
  );
  assert.equal(projectPreviewResponse.status, 200);
  const projectPreview = await projectPreviewResponse.json() as any;
  assert.ok(projectPreview.blockingReferences.some((reference: any) =>
    reference.reasonCode === "browser_authority_active"));
  const projectDeleteBlocked = await requestJson(
    baseUrl,
    session,
    "POST",
    "/api/resources/project/project_a4_api/permanent-delete",
    {
      commandId: "command_a4_project_delete_with_frame",
      previewToken: projectPreview.previewToken,
      stateToken: projectPreview.stateToken,
      confirmationToken: projectPreview.confirmationToken,
      confirmation: {
        action: "permanently_delete",
        kind: "project",
        id: "project_a4_api",
        recordCount: projectPreview.recordCount,
        fileCount: projectPreview.fileCount,
        totalBytes: projectPreview.totalBytes,
      },
    },
  );
  assert.equal(projectDeleteBlocked.status, 409);
  const projectRestore = await requestJson(
    baseUrl,
    session,
    "POST",
    "/api/resources/project/project_a4_api/restore",
    {
      commandId: "command_a4_project_restore_after_frame_block",
      expectedRecordDigest: app.productStore!.resourceRecordDigest(
        "project",
        "project_a4_api",
      ),
    },
  );
  assert.equal(projectRestore.status, 200, await projectRestore.clone().text());

  const tokenDigest = app.productStore!.resourceRecordDigest(
    "conversation",
    "conversation_a4_token",
  );
  const tokenTrash = await requestJson(
    baseUrl,
    session,
    "POST",
    "/api/resources/conversation/conversation_a4_token/trash",
    {
      commandId: "command_a4_token_trash",
      expectedRecordDigest: tokenDigest,
    },
  );
  assert.equal(tokenTrash.status, 200);
  const tokenPreviewResponse = await requestJson(
    baseUrl,
    session,
    "POST",
    "/api/resources/conversation/conversation_a4_token/permanent-delete-preview",
    {},
  );
  const tokenPreview = await tokenPreviewResponse.json() as any;
  const tokenDeleteBody = {
    commandId: "command_a4_token_delete",
    previewToken: tokenPreview.previewToken,
    stateToken: tokenPreview.stateToken,
    confirmationToken: tokenPreview.confirmationToken,
    confirmation: {
      action: "permanently_delete",
      kind: "conversation",
      id: "conversation_a4_token",
      recordCount: tokenPreview.recordCount,
      fileCount: tokenPreview.fileCount,
      totalBytes: tokenPreview.totalBytes,
    },
  };
  const mismatchedCount = await requestJson(
    baseUrl,
    session,
    "POST",
    "/api/resources/conversation/conversation_a4_token/permanent-delete",
    {
      ...tokenDeleteBody,
      confirmation: {
        ...tokenDeleteBody.confirmation,
        recordCount: tokenDeleteBody.confirmation.recordCount + 1,
      },
    },
  );
  assert.equal(mismatchedCount.status, 409);
  const reusedAfterFailure = await requestJson(
    baseUrl,
    session,
    "POST",
    "/api/resources/conversation/conversation_a4_token/permanent-delete",
    tokenDeleteBody,
  );
  assert.equal(reusedAfterFailure.status, 409);
  const rotatedPreviewResponse = await requestJson(
    baseUrl,
    session,
    "POST",
    "/api/resources/conversation/conversation_a4_token/permanent-delete-preview",
    {},
  );
  const rotatedPreview = await rotatedPreviewResponse.json() as any;
  session = await bootstrap(baseUrl);
  const rotatedTokenAttempt = await requestJson(
    baseUrl,
    session,
    "POST",
    "/api/resources/conversation/conversation_a4_token/permanent-delete",
    {
      commandId: "command_a4_rotated_delete",
      previewToken: rotatedPreview.previewToken,
      stateToken: rotatedPreview.stateToken,
      confirmationToken: rotatedPreview.confirmationToken,
      confirmation: {
        action: "permanently_delete",
        kind: "conversation",
        id: "conversation_a4_token",
        recordCount: rotatedPreview.recordCount,
        fileCount: rotatedPreview.fileCount,
        totalBytes: rotatedPreview.totalBytes,
      },
    },
  );
  assert.equal(rotatedTokenAttempt.status, 409);

  const initialDigest = app.productStore!.resourceRecordDigest(
    "conversation",
    "conversation_a4_delete",
  );
  const renamed = await requestJson(
    baseUrl,
    session,
    "PATCH",
    "/api/resources/conversation/conversation_a4_delete",
    {
      commandId: "command_a4_rename",
      expectedRecordDigest: initialDigest,
      name: "Renamed",
    },
  );
  assert.equal(renamed.status, 200, await renamed.clone().text());
  const renameReceipt = await renamed.json() as any;
  assert.equal(renameReceipt.action, "rename");
  assert.match(renameReceipt.receiptDigest, /^[0-9a-f]{64}$/u);
  const renameReplay = await requestJson(
    baseUrl,
    session,
    "PATCH",
    "/api/resources/conversation/conversation_a4_delete",
    {
      commandId: "command_a4_rename",
      expectedRecordDigest: initialDigest,
      name: "Renamed",
    },
  );
  assert.deepEqual(await renameReplay.json(), renameReceipt);

  const trash = await requestJson(
    baseUrl,
    session,
    "POST",
    "/api/resources/conversation/conversation_a4_delete/trash",
    {
      commandId: "command_a4_trash",
      expectedRecordDigest: renameReceipt.currentRecordDigest,
    },
  );
  assert.equal(trash.status, 200, await trash.clone().text());
  const trashReceipt = await trash.json() as any;
  assert.equal(trashReceipt.currentLifecycleState, "trashed");

  const previewResponse = await requestJson(
    baseUrl,
    session,
    "POST",
    "/api/resources/conversation/conversation_a4_delete/permanent-delete-preview",
    {},
  );
  assert.equal(previewResponse.status, 200, await previewResponse.clone().text());
  const preview = await previewResponse.json() as any;
  assert.equal(preview.action, "permanent_delete_preview");
  assert.equal(preview.target.kind, "conversation");
  assert.equal(preview.blockingReferences.length, 0);
  assert.match(preview.confirmationToken, /^[A-Za-z0-9_-]{43}$/u);
  const serializedPreview = JSON.stringify(preview);
  for (const forbidden of ["table", "relativePath", productRoot]) {
    assert.equal(serializedPreview.includes(forbidden), false, forbidden);
  }
  const deleteBody = {
    commandId: "command_a4_delete",
    previewToken: preview.previewToken,
    stateToken: preview.stateToken,
    confirmationToken: preview.confirmationToken,
    confirmation: {
      action: "permanently_delete",
      kind: "conversation",
      id: "conversation_a4_delete",
      recordCount: preview.recordCount,
      fileCount: preview.fileCount,
      totalBytes: preview.totalBytes,
    },
  };
  const deleted = await requestJson(
    baseUrl,
    session,
    "POST",
    "/api/resources/conversation/conversation_a4_delete/permanent-delete",
    deleteBody,
  );
  assert.equal(deleted.status, 200, await deleted.clone().text());
  const deleteReceipt = await deleted.json() as any;
  assert.equal(deleteReceipt.action, "permanently_delete");
  assert.equal(JSON.stringify(deleteReceipt).includes(preview.confirmationToken), false);

  const sameProcessReplay = await requestJson(
    baseUrl,
    session,
    "POST",
    "/api/resources/conversation/conversation_a4_delete/permanent-delete",
    deleteBody,
  );
  assert.equal(sameProcessReplay.status, 200);
  assert.deepEqual(await sameProcessReplay.json(), deleteReceipt);

  await app.close();
  app = new BackendApp({
    mesa: new ProductApiMesa(),
    openCode,
    a2OpenCode: openCode,
    a2ProductRoot: productRoot,
    workspaceRoot: legacyRoot,
    defaultSessionId: "a4-product-api",
    a3PythonExecutable: process.execPath,
  });
  await app.initialize();
  network = await app.listenBrowserNetwork();
  baseUrl = network.app.origin;
  session = await bootstrap(baseUrl);
  const restartReplay = await requestJson(
    baseUrl,
    session,
    "POST",
    "/api/resources/conversation/conversation_a4_delete/permanent-delete",
    { ...deleteBody, confirmationToken: "A".repeat(43) },
  );
  assert.equal(restartReplay.status, 200, await restartReplay.clone().text());
  assert.deepEqual(await restartReplay.json(), deleteReceipt);
  assert.equal(app.productStore!.listModels().length, 1);
  assert.equal(app.productStore!.listProjects().length, 1);
});

test("A4-3 Conversation browser projections bind providers, redact durable cards, and restore lifecycle state", {
  timeout: 30_000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "riff-a4-conversation-api-"));
  const productRoot = join(root, "product");
  const legacyRoot = join(root, "legacy");
  await mkdir(legacyRoot, { recursive: true, mode: 0o700 });
  const openCode = new ProductApiOpenCode();
  let app: BackendApp | undefined;
  const createApp = () => new BackendApp({
    mesa: new ProductApiMesa(),
    openCode,
    a2OpenCode: openCode,
    a2ProductRoot: productRoot,
    workspaceRoot: legacyRoot,
    defaultSessionId: "a4-conversation-api",
    a3PythonExecutable: process.execPath,
  });
  t.after(async () => {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  });

  app = createApp();
  await app.initialize();
  addFixtureData(app);
  app.productStore!.createConversation({
    id: "conversation_a4_binding",
    owner: { kind: "model", id: "model_a4_api" },
    name: "Provider binding",
    providerId: "provider-a",
    providerModelId: "model-a",
    createdAt: NOW,
  });
  app.productStore!.createConversation({
    id: "conversation_a4_project",
    owner: { kind: "project", id: "project_a4_api" },
    name: "Project thread",
    providerId: "provider-a",
    providerModelId: "model-a",
    createdAt: NOW,
  });
  app.productStore!.createConversation({
    id: "conversation_a4_activity",
    owner: { kind: "model", id: "model_a4_api" },
    name: "Activity projection",
    providerId: "provider-a",
    providerModelId: "model-a",
    createdAt: NOW,
  });
  app.productStore!.createTemporaryDocument({
    id: "document_a4_private",
    conversationId: "conversation_a4_binding",
    name: "Safe card",
    documentState: "draft",
    mediaType: "text/markdown",
    content: "PRIVATE_DOCUMENT_CONTENT_/Users/private/model.md",
    createdAt: NOW,
  });
  app.productStore!.startAgentTurn({
    turnId: "turn_a4_activity",
    userMessageId: "message_a4_activity",
    conversationId: "conversation_a4_activity",
    requestKey: "request_a4_activity",
    text: "Record safe public activity.",
    createdAt: NOW,
  });
  app.productStore!.recordSkillUse({
    id: "skill_use_a4_private",
    conversationId: "conversation_a4_activity",
    turnId: "turn_a4_activity",
    skillId: "safe-skill",
    skillVersion: "1",
    routingMode: "automatic",
    catalogDigest: "a".repeat(64),
    instructionDigest: "b".repeat(64),
    loadState: "loaded",
    rationale: "PRIVATE_SKILL_RATIONALE",
    createdAt: NOW,
  });
  app.productStore!.recordAction({
    id: "action_a4_private",
    conversationId: "conversation_a4_activity",
    turnId: "turn_a4_activity",
    actionKind: "inspect",
    intent: { rawToolPayload: "PRIVATE_RAW_TOOL_PAYLOAD" },
    permissionDecision: "allowed",
    state: "authorized",
    affectedResources: [{ absolutePath: "/Users/private/model.py" }],
    createdAt: NOW,
  });
  app.productStore!.failAgentTurn(
    "conversation_a4_activity",
    "request_a4_activity",
    "fixture_complete",
    false,
    NOW,
  );
  let network = await app.listenBrowserNetwork();
  let baseUrl = network.app.origin;
  let session = await bootstrap(baseUrl);

  const ownerPath = "/api/objects/model/model_a4_api/conversations";
  const active = await fetch(`${baseUrl}${ownerPath}?lifecycle=active`, {
    headers: readHeaders(session),
  });
  assert.equal(active.status, 200);
  const activeBody = await active.json() as any;
  assert.equal(
    activeBody.conversations.some(
      (conversation: any) => conversation.id === "conversation_a4_project",
    ),
    false,
  );
  const initial = activeBody.conversations.find(
    (conversation: any) => conversation.id === "conversation_a4_binding",
  );
  assert.ok(initial);
  assert.match(initial.recordDigest, /^[0-9a-f]{64}$/u);
  assert.deepEqual(Object.keys(initial).sort(), [
    "id",
    "lifecycleState",
    "name",
    "owner",
    "provider",
    "recordDigest",
    "sessionState",
    "updatedAt",
  ]);

  for (const query of [
    "?lifecycle=active&lifecycle=archived",
    "?lifecycle=unknown",
    "?unknown=active",
  ]) {
    const rejected = await fetch(`${baseUrl}${ownerPath}${query}`, {
      headers: readHeaders(session),
    });
    assert.equal(rejected.status, 422, query);
  }

  const bindingIntent = {
    commandId: "command_a4_provider_binding",
    expectedRecordDigest: initial.recordDigest,
    providerId: "provider-b",
    modelId: "model-b",
  };
  const bound = await requestJson(
    baseUrl,
    session,
    "PATCH",
    "/api/conversations/conversation_a4_binding/provider-binding",
    bindingIntent,
  );
  assert.equal(bound.status, 200, await bound.clone().text());
  const bindingReceipt = await bound.json() as any;
  assert.equal(bindingReceipt.provider.providerId, "provider-b");
  assert.match(bindingReceipt.receiptDigest, /^[0-9a-f]{64}$/u);
  const replay = await requestJson(
    baseUrl,
    session,
    "PATCH",
    "/api/conversations/conversation_a4_binding/provider-binding",
    bindingIntent,
  );
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), bindingReceipt);
  const changedIntent = await requestJson(
    baseUrl,
    session,
    "PATCH",
    "/api/conversations/conversation_a4_binding/provider-binding",
    { ...bindingIntent, providerId: "provider-a", modelId: "model-a" },
  );
  assert.equal(changedIntent.status, 409);

  const upload = await requestJson(
    baseUrl,
    session,
    "POST",
    "/api/conversations/conversation_a4_binding/attachments",
    {
      commandId: "command_a4_attachment",
      originalName: "input.json",
      mediaType: "application/json",
      base64: Buffer.from('{"value":1}').toString("base64"),
      purpose: "Conversation input",
    },
  );
  assert.equal(upload.status, 201, await upload.clone().text());
  const attachment = await upload.json() as any;
  assert.deepEqual(Object.keys(attachment).sort(), [
    "createdAt",
    "id",
    "mediaType",
    "originalName",
    "purpose",
    "sha256",
    "sizeBytes",
  ]);
  const attachments = await fetch(
    `${baseUrl}/api/conversations/conversation_a4_binding/attachments`,
    { headers: readHeaders(session) },
  );
  assert.equal(attachments.status, 200);
  assert.deepEqual((await attachments.json() as any).attachments, [attachment]);
  for (const unsafe of [{
    commandId: "command_a4_attachment_path",
    originalName: "../private.json",
    mediaType: "application/json",
    base64: Buffer.from("{}").toString("base64"),
  }, {
    commandId: "command_a4_attachment_media",
    originalName: "unsafe.html",
    mediaType: "text/html",
    base64: Buffer.from("<p>unsafe</p>").toString("base64"),
  }]) {
    const rejected = await requestJson(
      baseUrl,
      session,
      "POST",
      "/api/conversations/conversation_a4_binding/attachments",
      unsafe,
    );
    assert.equal(rejected.status, 422, JSON.stringify(unsafe));
  }
  const foreignUpload = await requestJson(
    baseUrl,
    session,
    "POST",
    "/api/conversations/conversation_a4_project/attachments",
    {
      commandId: "command_a4_foreign_attachment",
      originalName: "foreign.json",
      mediaType: "application/json",
      base64: Buffer.from("{}").toString("base64"),
    },
  );
  assert.equal(foreignUpload.status, 201);
  const foreignAttachment = await foreignUpload.json() as any;
  const foreignRejected = await requestJson(
    baseUrl,
    session,
    "POST",
    "/api/conversations/conversation_a4_binding/turns",
    {
      requestKey: "request_a4_foreign_attachment",
      text: "Use the foreign attachment.",
      attachmentIds: [foreignAttachment.id],
    },
  );
  assert.equal(foreignRejected.status, 409);
  for (const route of ["documents", "actions"]) {
    const response = await fetch(
      `${baseUrl}/api/conversations/conversation_a4_binding/${route}`,
      { headers: readHeaders(session) },
    );
    assert.equal(response.status, 200, route);
    const text = await response.text();
    assert.doesNotMatch(
      text,
      /(?:externalSessionRef|objectFileId|relativePath|capability|\/Users\/)/u,
    );
  }
  const documents = await (await fetch(
    `${baseUrl}/api/conversations/conversation_a4_binding/documents`,
    { headers: readHeaders(session) },
  )).json() as any;
  assert.equal(documents.documents[0].name, "Safe card");
  assert.equal(JSON.stringify(documents).includes("PRIVATE_DOCUMENT_CONTENT"), false);
  const activity = await (await fetch(
    `${baseUrl}/api/conversations/conversation_a4_activity/actions`,
    { headers: readHeaders(session) },
  )).json() as any;
  assert.deepEqual(Object.keys(activity.skillUses[0]).sort(), [
    "id", "loadState", "routingMode", "skillId", "skillVersion",
  ]);
  assert.deepEqual(Object.keys(activity.actions[0]).sort(), [
    "actionKind", "errorCode", "id", "permissionDecision", "state",
  ]);
  assert.doesNotMatch(
    JSON.stringify(activity),
    /(?:PRIVATE_|rawToolPayload|affectedResources|\/Users\/)/u,
  );

  const turn = await requestJson(
    baseUrl,
    session,
    "POST",
    "/api/conversations/conversation_a4_binding/turns",
    {
      requestKey: "request_a4_read_only",
      text: "Use the attached input.",
      attachmentIds: [attachment.id],
    },
  );
  assert.equal(turn.status, 200);
  const turnBody = await turn.json() as any;
  assert.equal(turnBody.mode, "read_only");
  assert.deepEqual(
    turnBody.messages.map((message: any) => message.role),
    ["user"],
  );
  assert.equal(
    turnBody.messages.some((message: any) => message.role === "assistant"),
    false,
  );
  const locked = await (await fetch(
    `${baseUrl}/api/conversations/conversation_a4_binding`,
    { headers: readHeaders(session) },
  )).json() as any;
  assert.equal(locked.provider.locked, true);
  const lockRejected = await requestJson(
    baseUrl,
    session,
    "PATCH",
    "/api/conversations/conversation_a4_binding/provider-binding",
    {
      commandId: "command_a4_provider_after_turn",
      expectedRecordDigest: locked.recordDigest,
      providerId: "provider-a",
      modelId: "model-a",
    },
  );
  assert.equal(lockRejected.status, 409);

  const archived = await requestJson(
    baseUrl,
    session,
    "POST",
    "/api/resources/conversation/conversation_a4_binding/archive",
    {
      commandId: "command_a4_conversation_archive",
      expectedRecordDigest: locked.recordDigest,
    },
  );
  assert.equal(archived.status, 200, await archived.clone().text());
  const archiveReceipt = await archived.json() as any;
  const archivedList = await fetch(
    `${baseUrl}${ownerPath}?lifecycle=archived`,
    { headers: readHeaders(session) },
  );
  assert.equal(archivedList.status, 200);
  assert.deepEqual(
    (await archivedList.json() as any).conversations.map(
      (conversation: any) => conversation.id,
    ),
    ["conversation_a4_binding"],
  );
  const restored = await requestJson(
    baseUrl,
    session,
    "POST",
    "/api/resources/conversation/conversation_a4_binding/restore",
    {
      commandId: "command_a4_conversation_restore",
      expectedRecordDigest: archiveReceipt.currentRecordDigest,
    },
  );
  assert.equal(restored.status, 200, await restored.clone().text());

  await app.close();
  app = undefined;
  app = createApp();
  await app.initialize();
  network = await app.listenBrowserNetwork();
  baseUrl = network.app.origin;
  session = await bootstrap(baseUrl);
  openCode.discoveryError = new Error("provider catalogue unavailable");
  const restartReplay = await requestJson(
    baseUrl,
    session,
    "PATCH",
    "/api/conversations/conversation_a4_binding/provider-binding",
    bindingIntent,
  );
  assert.equal(restartReplay.status, 200);
  assert.deepEqual(await restartReplay.json(), bindingReceipt);
  const restartChangedIntent = await requestJson(
    baseUrl,
    session,
    "PATCH",
    "/api/conversations/conversation_a4_binding/provider-binding",
    { ...bindingIntent, providerId: "provider-a", modelId: "model-a" },
  );
  assert.equal(restartChangedIntent.status, 409);
  const unavailableNewCommand = await requestJson(
    baseUrl,
    session,
    "PATCH",
    "/api/conversations/conversation_a4_binding/provider-binding",
    { ...bindingIntent, commandId: "command_a4_provider_unavailable" },
  );
  assert.equal(unavailableNewCommand.status, 503);
  const restartDetail = await (await fetch(
    `${baseUrl}/api/conversations/conversation_a4_binding`,
    { headers: readHeaders(session) },
  )).json() as any;
  assert.equal(restartDetail.provider.locked, true);
  assert.equal(restartDetail.lifecycleState, "active");
  assert.equal(restartDetail.sessionState, "read_only");
});
