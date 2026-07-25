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
  async discoverProviderModels(): Promise<OpenCodeProviderModel[]> {
    return [{
      providerId: "provider-a",
      modelId: "model-a",
      qualifiedId: "provider-a/model-a",
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
