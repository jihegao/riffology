import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  OpenCodeAdapter,
  OpenCodeAssistantResponse,
  OpenCodeConversationPort,
  OpenCodePrompt,
  OpenCodeProviderModel,
  OpenCodeReadiness,
} from "../src/opencode-adapter.ts";
import { UnavailableMesaAdapter } from "../src/mesa-adapter.ts";
import { BackendApp } from "../src/server.ts";

class AcceptanceOpenCode implements OpenCodeAdapter, OpenCodeConversationPort {
  readonly catalogue: OpenCodeProviderModel[] = [{
    providerId: "provider-a",
    modelId: "model-a",
    qualifiedId: "provider-a/model-a",
  }];

  async initialize(): Promise<OpenCodeReadiness> {
    return { status: "ready", modelId: "provider-a/model-a", version: "test" };
  }
  async discoverProviderModels(): Promise<OpenCodeProviderModel[]> { return this.catalogue; }
  async getSession(): Promise<boolean> { return false; }
  async createSession(): Promise<string> { return "unused-a3-1-acceptance-session"; }
  async injectContext(): Promise<void> {}
  async promptWithModel(
    _sessionId: string,
    _binding: { providerId: string; modelId: string },
    _prompt: OpenCodePrompt,
  ): Promise<OpenCodeAssistantResponse> {
    throw new Error("A3-1 API acceptance must not depend on an Agent turn.");
  }
  async prompt(): Promise<void> {}
  async abort(): Promise<void> {}
}

const post = (url: string, body: unknown) => fetch(url, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

test("A3-2d1 output authority is unavailable on the legacy listener", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "riff-a3-2d1-legacy-denial-"));
  const legacyRoot = join(base, "legacy");
  await mkdir(legacyRoot, { recursive: true, mode: 0o700 });
  const openCode = new AcceptanceOpenCode();
  const app = new BackendApp({
    mesa: new UnavailableMesaAdapter(),
    openCode,
    a2OpenCode: openCode,
    a2ProductRoot: join(base, "product"),
    workspaceRoot: legacyRoot,
    defaultSessionId: "a3-2d1-legacy-denial",
  });
  t.after(async () => {
    await app.close();
    await rm(base, { recursive: true, force: true });
  });
  await app.initialize();
  const address = await app.listen();
  const response = await fetch(
    `http://127.0.0.1:${address.port}/api/projects/project_denied/runs/run_denied/outputs`,
  );
  assert.equal(response.status, 403);
  assert.equal((await response.json() as any).error.code, "output_access_denied");
});

const patch = (url: string, body: unknown) => fetch(url, {
  method: "PATCH",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const start = async (base: string) => {
  const legacyRoot = join(base, "legacy");
  await mkdir(legacyRoot, { recursive: true, mode: 0o700 });
  const openCode = new AcceptanceOpenCode();
  const app = new BackendApp({
    mesa: new UnavailableMesaAdapter(),
    openCode,
    a2OpenCode: openCode,
    a2ProductRoot: join(base, "product"),
    workspaceRoot: legacyRoot,
    defaultSessionId: "a3-1-api-acceptance",
  });
  try {
    await app.initialize();
    const network = await app.listenBrowserNetwork();
    return { app, baseUrl: network.app.origin };
  } catch (error) {
    await app.close();
    throw error;
  }
};

const browserOutputHeaders = (cookie: string) => ({
  cookie,
  "sec-fetch-site": "same-origin",
  "sec-fetch-mode": "cors",
  "sec-fetch-dest": "empty",
});

const bootstrapAppSession = async (baseUrl: string): Promise<string> => {
  const response = await fetch(`${baseUrl}/api/browser-session/bootstrap`, {
    method: "POST",
    headers: {
      origin: baseUrl,
      "sec-fetch-site": "same-origin",
      "content-length": "0",
    },
  });
  assert.equal(response.status, 201, await response.clone().text());
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);
  return cookie;
};

const waitForRun = async (
  baseUrl: string,
  projectId: string,
  runId: string,
  status: "running" | "succeeded" | "failed" | "cancelled",
): Promise<any> => {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/projects/${projectId}/runs/${runId}`);
    assert.equal(response.status, 200, await response.clone().text());
    const run = await response.json() as any;
    if (run.status === status) return run;
    if (["failed", "timed_out", "trashed"].includes(run.status)) {
      assert.fail(`Run ${runId} reached unexpected terminal status ${run.status}: ${run.terminalCode}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`Run ${runId} did not reach ${status}.`);
};

const listMessages = async (baseUrl: string, conversationId: string): Promise<any[]> => {
  const response = await fetch(`${baseUrl}/api/conversations/${conversationId}/messages`);
  assert.equal(response.status, 200, await response.clone().text());
  return ((await response.json()) as any).messages;
};

const assertCompletionCard = (
  card: any,
  expected: {
    runId: string;
    status: "succeeded" | "cancelled";
    outputIds: string[];
  },
): void => {
  assert.equal(card.role, "system");
  assert.equal(card.status, "complete");
  assert.equal(card.messageKind, "platform_card");
  assert.equal(card.text, "");
  assert.deepEqual(Object.keys(card.content).sort(), [
    "outputCount",
    "outputIds",
    "runId",
    "sampleCount",
    "status",
  ]);
  assert.deepEqual(card.content, {
    runId: expected.runId,
    status: expected.status,
    sampleCount: 1,
    outputCount: expected.outputIds.length,
    outputIds: expected.outputIds,
  });
};

test("A3-1 public API vertical preserves a real batch result and exactly-once cards across restart", {
  timeout: 45_000,
}, async (t) => {
  const base = await mkdtemp(join(tmpdir(), "riff-a3-1-api-vertical-"));
  let current: BackendApp | undefined;
  t.after(async () => {
    await current?.close();
    await rm(base, { recursive: true, force: true });
  });

  let started = await start(base);
  current = started.app;
  let baseUrl = started.baseUrl;

  const inputSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: { value: { type: "integer" } },
    required: ["value"],
    additionalProperties: false,
  };
  current.productStore!.createModel({
    id: "model_a3_1_api_vertical",
    name: "A3-1 API vertical fixture",
    technicalStatus: "executable",
    runMode: "batch",
    executionDescription: {
      schemaVersion: 2,
      runtime: "python",
      runMode: "batch",
      dependencyFile: "environment/requirements.txt",
      inputs: {
        schemaProfile: "riff-json-schema-2020-12-v1",
        schema: inputSchema,
        smoke: { value: 1 },
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
    },
    createdAt: "2026-07-25T00:00:00.000Z",
    files: [{
      id: "file_a3_1_api_vertical_model",
      kind: "model_code",
      relativePath: "model.py",
      mediaType: "text/x-python",
      bytes: Buffer.from(`from __future__ import annotations
import argparse
import json
import time
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--riff-input", required=True, type=Path)
parser.add_argument("--riff-output-dir", required=True, type=Path)
args = parser.parse_args()
envelope = json.loads(args.riff_input.read_text(encoding="utf-8"))
if envelope["parameters"]["value"] == 99:
    time.sleep(30)
target = args.riff_output_dir / "outputs" / "result.json"
target.parent.mkdir(parents=True, exist_ok=True)
target.write_text(json.dumps({
    "sampleIndex": envelope["sampleIndex"],
    "sampleId": envelope["sampleId"],
    "seed": envelope["seed"],
    "value": envelope["parameters"]["value"],
}, sort_keys=True, separators=(",", ":")) + "\\n", encoding="utf-8")
`),
    }, {
      id: "file_a3_1_api_vertical_environment",
      kind: "model_environment",
      relativePath: "requirements.txt",
      mediaType: "text/plain",
      bytes: Buffer.from("# no external dependencies\n"),
    }],
  });

  const projectResponse = await post(`${baseUrl}/api/projects`, {
    commandId: "create-a3-1-api-project",
    name: "A3-1 API Project",
    modelId: "model_a3_1_api_vertical",
  });
  assert.equal(projectResponse.status, 201, await projectResponse.clone().text());
  const project = (await projectResponse.json() as any).project;

  const conversationResponse = await post(
    `${baseUrl}/api/objects/project/${project.id}/conversations`,
    {
      commandId: "create-a3-1-api-conversation",
      name: "A3-1 completion records",
      providerId: "provider-a",
      modelId: "model-a",
    },
  );
  assert.equal(conversationResponse.status, 201, await conversationResponse.clone().text());
  const conversation = await conversationResponse.json() as any;

  const createExperimentResponse = await post(
    `${baseUrl}/api/projects/${project.id}/experiment-configs`,
    {
      commandId: "create-a3-1-api-experiment",
      name: "API vertical",
      configuration: {
        schemaVersion: 1,
        runKind: "batch",
        parameters: { value: 1 },
        sampling: { kind: "single", seed: 7 },
      },
    },
  );
  assert.equal(createExperimentResponse.status, 201, await createExperimentResponse.clone().text());
  const createdExperiment = await createExperimentResponse.json() as any;

  const updateExperimentResponse = await patch(
    `${baseUrl}/api/projects/${project.id}/experiment-configs/${createdExperiment.id}`,
    {
      commandId: "update-a3-1-api-experiment",
      expectedConfigurationDigest: createdExperiment.configurationDigest,
      expectedRecordDigest: createdExperiment.recordDigest,
      configuration: {
        schemaVersion: 1,
        runKind: "batch",
        parameters: { value: 2 },
        sampling: { kind: "single", seed: 11 },
      },
    },
  );
  assert.equal(updateExperimentResponse.status, 200, await updateExperimentResponse.clone().text());
  const experiment = await updateExperimentResponse.json() as any;
  assert.notEqual(experiment.configurationDigest, createdExperiment.configurationDigest);

  const runStartResponse = await post(`${baseUrl}/api/projects/${project.id}/runs`, {
    commandId: "start-a3-1-api-success",
    experimentConfigId: experiment.id,
    completionConversationId: conversation.id,
  });
  assert.equal(runStartResponse.status, 201, await runStartResponse.clone().text());
  const runStart = await runStartResponse.json() as any;
  const succeeded = await waitForRun(baseUrl, project.id, runStart.runId, "succeeded");
  assert.equal(succeeded.completionCardDisposition, "published");
  assert.equal(succeeded.outputs.length, 1);
  assert.equal(succeeded.outputs[0].logicalName, "result");
  assert.equal(succeeded.outputs[0].sampleIndex, 0);
  assert.match(succeeded.outputs[0].sha256, /^[0-9a-f]{64}$/u);

  const successMessages = await listMessages(baseUrl, conversation.id);
  const successCards = successMessages.filter((message) =>
    message.messageKind === "platform_card" && message.content?.runId === runStart.runId);
  assert.equal(successCards.length, 1);
  assertCompletionCard(successCards[0], {
    runId: runStart.runId,
    status: "succeeded",
    outputIds: [succeeded.outputs[0].id],
  });

  const unauthenticatedOutputs = await fetch(
    `${baseUrl}/api/projects/${project.id}/runs/${runStart.runId}/outputs`,
  );
  assert.equal(unauthenticatedOutputs.status, 403);
  const appCookie = await bootstrapAppSession(baseUrl);
  const outputHeaders = browserOutputHeaders(appCookie);
  const outputListResponse = await fetch(
    `${baseUrl}/api/projects/${project.id}/runs/${runStart.runId}/outputs`,
    { headers: outputHeaders },
  );
  assert.equal(outputListResponse.status, 200, await outputListResponse.clone().text());
  assert.equal(outputListResponse.headers.get("cache-control"), "private, no-store");
  const outputList = await outputListResponse.json() as any;
  assert.deepEqual(outputList.outputs, [{
    id: succeeded.outputs[0].id,
    runId: runStart.runId,
    sampleIndex: 0,
    sampleId: succeeded.outputs[0].sampleId,
    logicalName: "result",
    declaredRole: "data",
    outputType: succeeded.outputs[0].outputType,
    mediaType: "application/json",
    sizeBytes: succeeded.outputs[0].sizeBytes,
    sha256: succeeded.outputs[0].sha256,
    createdAt: succeeded.outputs[0].createdAt,
  }]);
  assert.equal(JSON.stringify(outputList).includes("relativePath"), false);
  assert.equal(JSON.stringify(outputList).includes("objectFileId"), false);
  const downloadUrl =
    `${baseUrl}/api/projects/${project.id}/runs/${runStart.runId}/outputs/${succeeded.outputs[0].id}/download`;
  const fullDownload = await fetch(downloadUrl, { headers: outputHeaders });
  assert.equal(fullDownload.status, 200, await fullDownload.clone().text());
  assert.equal(fullDownload.headers.get("cache-control"), "private, no-store");
  assert.equal(fullDownload.headers.get("content-type"), "application/json");
  assert.equal(fullDownload.headers.get("x-content-type-options"), "nosniff");
  assert.match(fullDownload.headers.get("content-disposition") ?? "",
    /^attachment; filename="output_[A-Za-z0-9_-]+\.json"$/u);
  assert.equal(fullDownload.headers.get("etag"),
    `"sha256-${succeeded.outputs[0].sha256}"`);
  const fullBytes = Buffer.from(await fullDownload.arrayBuffer());
  assert.equal(fullBytes.byteLength, succeeded.outputs[0].sizeBytes);
  assert.equal(JSON.parse(fullBytes.toString("utf8")).value, 2);

  const rangeDownload = await fetch(downloadUrl, {
    headers: { ...outputHeaders, range: "bytes=0-9" },
  });
  assert.equal(rangeDownload.status, 206, await rangeDownload.clone().text());
  assert.equal(rangeDownload.headers.get("content-range"),
    `bytes 0-9/${succeeded.outputs[0].sizeBytes}`);
  assert.equal((await rangeDownload.arrayBuffer()).byteLength, 10);
  const headDownload = await fetch(downloadUrl, {
    method: "HEAD",
    headers: { ...outputHeaders, range: "bytes=0-0" },
  });
  assert.equal(headDownload.status, 206);
  assert.equal(headDownload.headers.get("content-length"), "1");
  assert.equal((await headDownload.arrayBuffer()).byteLength, 0);
  const invalidRange = await fetch(downloadUrl, {
    headers: { ...outputHeaders, range: "bytes=0-1,3-4" },
  });
  assert.equal(invalidRange.status, 416);
  assert.equal(invalidRange.headers.get("content-range"),
    `bytes */${succeeded.outputs[0].sizeBytes}`);
  const internalOutput = current.productStore!.listRunOutputs(runStart.runId)[0]!;
  const committedOutputPath = join(
    base,
    "product",
    "objects",
    "projects",
    project.id,
    "runs",
    runStart.runId,
    internalOutput.file.relativePath,
  );
  const drifted = Buffer.from(fullBytes);
  drifted[0] = drifted[0] === 0x7b ? 0x5b : 0x7b;
  await writeFile(committedOutputPath, drifted);
  const integrityFailure = await fetch(downloadUrl, { headers: outputHeaders });
  assert.equal(integrityFailure.status, 500);
  const integrityError = await integrityFailure.json() as any;
  assert.equal(integrityError.error.code, "output_integrity_failed");
  assert.equal(JSON.stringify(integrityError).includes(committedOutputPath), false);
  assert.equal(JSON.stringify(integrityError).includes(succeeded.outputs[0].sha256), false);
  await writeFile(committedOutputPath, fullBytes);
  const crossRun = await fetch(
    `${baseUrl}/api/projects/${project.id}/runs/run_other_scope/outputs/${succeeded.outputs[0].id}/download`,
    { headers: outputHeaders },
  );
  assert.equal(crossRun.status, 404);
  const wrongSession = await fetch(downloadUrl, {
    headers: { ...outputHeaders, cookie: "riff_app=wrong-session" },
  });
  assert.equal(wrongSession.status, 403);
  const missingFetchMetadata = await fetch(downloadUrl, {
    headers: { cookie: appCookie },
  });
  assert.equal(missingFetchMetadata.status, 403);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const allowed = await fetch(downloadUrl, {
      headers: { ...outputHeaders, range: "bytes=0-0" },
    });
    assert.equal(allowed.status, 206);
    await allowed.arrayBuffer();
  }
  const rateLimited = await fetch(downloadUrl, {
    headers: { ...outputHeaders, range: "bytes=0-0" },
  });
  assert.equal(rateLimited.status, 429);
  assert.equal(rateLimited.headers.get("retry-after"), "1");
  await new Promise((resolve) => setTimeout(resolve, 1_050));
  const afterRateWindow = await fetch(downloadUrl, {
    headers: { ...outputHeaders, range: "bytes=0-0" },
  });
  assert.equal(afterRateWindow.status, 206);
  await afterRateWindow.arrayBuffer();
  current.productStore!.trashResource(
    "project",
    project.id,
    "2026-07-25T01:00:00.000Z",
  );
  const trashedProjectOutputList = await fetch(
    `${baseUrl}/api/projects/${project.id}/runs/${runStart.runId}/outputs`,
    { headers: outputHeaders },
  );
  assert.equal(trashedProjectOutputList.status, 404);
  assert.equal(
    (await trashedProjectOutputList.json() as any).error.code,
    "output_not_found",
  );
  current.productStore!.restoreResource(
    "project",
    project.id,
    "2026-07-25T01:00:01.000Z",
  );
  const restoredProjectOutputList = await fetch(
    `${baseUrl}/api/projects/${project.id}/runs/${runStart.runId}/outputs`,
    { headers: outputHeaders },
  );
  assert.equal(restoredProjectOutputList.status, 200);

  await current.close();
  current = undefined;
  started = await start(base);
  current = started.app;
  baseUrl = started.baseUrl;

  const succeededAfterRestart = await waitForRun(
    baseUrl,
    project.id,
    runStart.runId,
    "succeeded",
  );
  assert.deepEqual(succeededAfterRestart, succeeded);
  const restartedCookie = await bootstrapAppSession(baseUrl);
  const restartedDownload = await fetch(downloadUrl.replace(
    /^http:\/\/localhost:\d+/u,
    baseUrl,
  ), { headers: browserOutputHeaders(restartedCookie) });
  assert.equal(restartedDownload.status, 200, await restartedDownload.clone().text());
  assert.deepEqual(Buffer.from(await restartedDownload.arrayBuffer()), fullBytes);
  const messagesAfterRestart = await listMessages(baseUrl, conversation.id);
  assert.deepEqual(messagesAfterRestart, successMessages);
  assert.equal(messagesAfterRestart.filter((message) =>
    message.messageKind === "platform_card" && message.content?.runId === runStart.runId
  ).length, 1);

  const blockerExperimentResponse = await patch(
    `${baseUrl}/api/projects/${project.id}/experiment-configs/${experiment.id}`,
    {
      commandId: "update-a3-1-api-blocker",
      expectedConfigurationDigest: experiment.configurationDigest,
      expectedRecordDigest: experiment.recordDigest,
      configuration: {
        schemaVersion: 1,
        runKind: "batch",
        parameters: { value: 99 },
        sampling: { kind: "single", seed: 13 },
      },
    },
  );
  assert.equal(
    blockerExperimentResponse.status,
    200,
    await blockerExperimentResponse.clone().text(),
  );
  const blockerExperiment = await blockerExperimentResponse.json() as any;
  const blockerStartResponse = await post(`${baseUrl}/api/projects/${project.id}/runs`, {
    commandId: "start-a3-1-api-blocker",
    experimentConfigId: blockerExperiment.id,
  });
  assert.equal(blockerStartResponse.status, 201, await blockerStartResponse.clone().text());
  const blockerStart = await blockerStartResponse.json() as any;
  await waitForRun(baseUrl, project.id, blockerStart.runId, "running");

  const targetExperimentResponse = await patch(
    `${baseUrl}/api/projects/${project.id}/experiment-configs/${blockerExperiment.id}`,
    {
      commandId: "update-a3-1-api-cancel-target",
      expectedConfigurationDigest: blockerExperiment.configurationDigest,
      expectedRecordDigest: blockerExperiment.recordDigest,
      configuration: {
        schemaVersion: 1,
        runKind: "batch",
        parameters: { value: 3 },
        sampling: { kind: "single", seed: 17 },
      },
    },
  );
  assert.equal(
    targetExperimentResponse.status,
    200,
    await targetExperimentResponse.clone().text(),
  );
  const targetExperiment = await targetExperimentResponse.json() as any;
  const cancelStartResponse = await post(`${baseUrl}/api/projects/${project.id}/runs`, {
    commandId: "start-a3-1-api-cancel",
    experimentConfigId: targetExperiment.id,
    completionConversationId: conversation.id,
  });
  assert.equal(cancelStartResponse.status, 201, await cancelStartResponse.clone().text());
  const cancelStart = await cancelStartResponse.json() as any;
  assert.equal(cancelStart.status, "queued");
  const queuedTargetResponse = await fetch(
    `${baseUrl}/api/projects/${project.id}/runs/${cancelStart.runId}`,
  );
  assert.equal(queuedTargetResponse.status, 200, await queuedTargetResponse.clone().text());
  assert.equal(((await queuedTargetResponse.json()) as any).status, "queued");

  const cancelResponse = await post(
    `${baseUrl}/api/projects/${project.id}/runs/${cancelStart.runId}/cancel`,
    { commandId: "cancel-a3-1-api-queued" },
  );
  assert.equal(cancelResponse.status, 200, await cancelResponse.clone().text());
  const cancelReceipt = await cancelResponse.json() as any;
  assert.equal(cancelReceipt.applied, true);
  assert.equal(cancelReceipt.code, "cancellation_requested");
  assert.equal(cancelReceipt.status, "cancelling");

  const cancelReplayResponse = await post(
    `${baseUrl}/api/projects/${project.id}/runs/${cancelStart.runId}/cancel`,
    { commandId: "cancel-a3-1-api-queued" },
  );
  assert.equal(cancelReplayResponse.status, 200);
  assert.deepEqual(await cancelReplayResponse.json(), cancelReceipt);

  const blockerCancelResponse = await post(
    `${baseUrl}/api/projects/${project.id}/runs/${blockerStart.runId}/cancel`,
    { commandId: "cancel-a3-1-api-blocker" },
  );
  assert.equal(blockerCancelResponse.status, 200, await blockerCancelResponse.clone().text());
  const blockerCancelReceipt = await blockerCancelResponse.json() as any;
  assert.equal(blockerCancelReceipt.applied, true);
  assert.equal(blockerCancelReceipt.code, "cancellation_requested");
  await waitForRun(baseUrl, project.id, blockerStart.runId, "cancelled");

  const cancelled = await waitForRun(baseUrl, project.id, cancelStart.runId, "cancelled");
  assert.equal(cancelled.completionCardDisposition, "published");
  assert.deepEqual(cancelled.outputs, []);

  const finalMessages = await listMessages(baseUrl, conversation.id);
  const cancelledCards = finalMessages.filter((message) =>
    message.messageKind === "platform_card" && message.content?.runId === cancelStart.runId);
  assert.equal(cancelledCards.length, 1);
  assertCompletionCard(cancelledCards[0], {
    runId: cancelStart.runId,
    status: "cancelled",
    outputIds: [],
  });
  assert.equal(finalMessages.filter((message) => message.messageKind === "platform_card").length, 2);
  assert.equal(finalMessages.filter((message) =>
    message.messageKind === "platform_card" && message.content?.runId === runStart.runId
  ).length, 1);
  assert.equal(finalMessages.filter((message) =>
    message.messageKind === "platform_card" && message.content?.runId === cancelStart.runId
  ).length, 1);

  await current.close();
  current = undefined;
  started = await start(base);
  current = started.app;
  baseUrl = started.baseUrl;

  const cancelledAfterRestart = await waitForRun(
    baseUrl,
    project.id,
    cancelStart.runId,
    "cancelled",
  );
  assert.deepEqual(cancelledAfterRestart, cancelled);
  const finalMessagesAfterRestart = await listMessages(baseUrl, conversation.id);
  assert.deepEqual(finalMessagesAfterRestart, finalMessages);
  for (const expectedRunId of [runStart.runId, cancelStart.runId]) {
    assert.equal(finalMessagesAfterRestart.filter((message) =>
      message.messageKind === "platform_card" && message.content?.runId === expectedRunId
    ).length, 1);
  }
});

test("A3-2d2 atomically publishes generic diagnostic events and pages them across restart", {
  timeout: 45_000,
}, async (t) => {
  const base = await mkdtemp(join(tmpdir(), "riff-a3-2d2-api-vertical-"));
  let current: BackendApp | undefined;
  t.after(async () => {
    await current?.close();
    await rm(base, { recursive: true, force: true });
  });

  let started = await start(base);
  current = started.app;
  let baseUrl = started.baseUrl;
  current.productStore!.createModel({
    id: "model_a3_2d2_api_vertical",
    name: "A3-2d2 diagnostic event fixture",
    technicalStatus: "executable",
    runMode: "batch",
    executionDescription: {
      schemaVersion: 2,
      runtime: "python",
      runMode: "batch",
      dependencyFile: "environment/requirements.txt",
      inputs: {
        schemaProfile: "riff-json-schema-2020-12-v1",
        schema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: { value: { type: "integer" } },
          required: ["value"],
          additionalProperties: false,
        },
        smoke: { value: 1 },
      },
      outputs: [{
        logicalName: "result",
        relativePath: "outputs/result.json",
        mediaType: "application/json",
        required: true,
        role: "data",
      }],
      batch: {
        entryPoint: "code/model.py",
        protocol: "riff-batch-v1",
        domainEvents: {
          relativePath: "events.ndjson",
          mediaType: "application/x-ndjson",
          role: "diagnostic",
          payloadSchema: {
            schemaProfile: "riff-json-schema-2020-12-v1",
            schema: {
              $schema: "https://json-schema.org/draft/2020-12/schema",
              type: "object",
              properties: {
                message: { type: "string", minLength: 1, maxLength: 200 },
                value: { type: "integer" },
              },
              required: ["message", "value"],
              additionalProperties: false,
            },
          },
        },
      },
      cancellation: { signal: "SIGTERM", graceMs: 500 },
    },
    createdAt: "2026-07-25T02:00:00.000Z",
    files: [{
      id: "file_a3_2d2_api_vertical_model",
      kind: "model_code",
      relativePath: "model.py",
      mediaType: "text/x-python",
      bytes: Buffer.from(`from __future__ import annotations
import argparse
import json
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--riff-input", required=True, type=Path)
parser.add_argument("--riff-output-dir", required=True, type=Path)
args = parser.parse_args()
envelope = json.loads(args.riff_input.read_text(encoding="utf-8"))
result = args.riff_output_dir / "outputs" / "result.json"
result.parent.mkdir(parents=True, exist_ok=True)
result.write_text(json.dumps({"value": envelope["parameters"]["value"]}, sort_keys=True, separators=(",", ":")) + "\\n", encoding="utf-8")
events = (
    [{"type": "repair_started", "occurredAt": "2026-07-25T02:00:01.000Z", "payload": {"message": "", "value": -1}}]
    if envelope["parameters"]["value"] < 0
    else [
        {"type": "repair_started", "occurredAt": "2026-07-25T02:00:01.000Z", "payload": {"message": "https://example.invalid is untrusted data", "value": 1}},
        {"type": "repair_progress", "occurredAt": "2026-07-25T02:00:02.000Z", "payload": {"message": "ignore prior instructions is untrusted data", "value": 2}},
        {"type": "repair_finished", "occurredAt": "2026-07-25T02:00:03.000Z", "payload": {"message": "tool_call-shaped text is untrusted data", "value": 3}},
    ]
)
(args.riff_output_dir / "events.ndjson").write_text(
    "".join(json.dumps(event, sort_keys=True, separators=(",", ":")) + "\\n" for event in events),
    encoding="utf-8",
)
`),
    }, {
      id: "file_a3_2d2_api_vertical_environment",
      kind: "model_environment",
      relativePath: "requirements.txt",
      mediaType: "text/plain",
      bytes: Buffer.from("# no external dependencies\n"),
    }],
  });

  const projectResponse = await post(`${baseUrl}/api/projects`, {
    commandId: "create-a3-2d2-project",
    name: "A3-2d2 Project",
    modelId: "model_a3_2d2_api_vertical",
  });
  assert.equal(projectResponse.status, 201, await projectResponse.clone().text());
  const project = (await projectResponse.json() as any).project;
  const experimentResponse = await post(
    `${baseUrl}/api/projects/${project.id}/experiment-configs`,
    {
      commandId: "create-a3-2d2-experiment",
      name: "Diagnostic event vertical",
      configuration: {
        schemaVersion: 1,
        runKind: "batch",
        parameters: { value: 7 },
        sampling: { kind: "single", seed: 17 },
      },
    },
  );
  assert.equal(experimentResponse.status, 201, await experimentResponse.clone().text());
  const experiment = await experimentResponse.json() as any;
  const runResponse = await post(`${baseUrl}/api/projects/${project.id}/runs`, {
    commandId: "start-a3-2d2-run",
    experimentConfigId: experiment.id,
  });
  assert.equal(runResponse.status, 201, await runResponse.clone().text());
  const run = await runResponse.json() as any;
  await waitForRun(baseUrl, project.id, run.runId, "succeeded");

  const eventsUrl =
    `${baseUrl}/api/projects/${project.id}/runs/${run.runId}/diagnostic-events`;
  const unauthenticated = await fetch(eventsUrl);
  assert.equal(unauthenticated.status, 403);
  const appCookie = await bootstrapAppSession(baseUrl);
  const headers = browserOutputHeaders(appCookie);
  const first = await fetch(`${eventsUrl}?limit=1`, { headers });
  assert.equal(first.status, 200, await first.clone().text());
  assert.equal(first.headers.get("cache-control"), "private, no-store");
  assert.equal(first.headers.get("x-content-type-options"), "nosniff");
  const firstPage = await first.json() as any;
  assert.equal(firstPage.items.length, 1);
  assert.deepEqual(firstPage.items[0], {
    sequence: 0,
    sampleIndex: 0,
    type: "repair_started",
    occurredAt: "2026-07-25T02:00:01.000Z",
    payload: {
      message: "https://example.invalid is untrusted data",
      value: 1,
    },
  });
  assert.equal(firstPage.truncated, true);
  assert.equal(typeof firstPage.nextCursor, "string");
  assert.equal(firstPage.nextCursor.includes(project.id), false);

  const invalidExperimentResponse = await post(
    `${baseUrl}/api/projects/${project.id}/experiment-configs`,
    {
      commandId: "create-a3-2d2-invalid-experiment",
      name: "Invalid diagnostic event vertical",
      configuration: {
        schemaVersion: 1,
        runKind: "batch",
        parameters: { value: -1 },
        sampling: { kind: "single", seed: 19 },
      },
    },
  );
  assert.equal(
    invalidExperimentResponse.status,
    201,
    await invalidExperimentResponse.clone().text(),
  );
  const invalidExperiment = await invalidExperimentResponse.json() as any;
  const invalidRunResponse = await post(
    `${baseUrl}/api/projects/${project.id}/runs`,
    {
      commandId: "start-a3-2d2-invalid-run",
      experimentConfigId: invalidExperiment.id,
    },
  );
  assert.equal(invalidRunResponse.status, 201, await invalidRunResponse.clone().text());
  const invalidRun = await invalidRunResponse.json() as any;
  await waitForRun(baseUrl, project.id, invalidRun.runId, "failed");
  assert.deepEqual(current.productStore!.listRunOutputs(invalidRun.runId), []);
  assert.deepEqual(current.productStore!.listObjectFiles({
    kind: "run",
    id: invalidRun.runId,
  }), []);
  assert.throws(
    () => current!.productStore!.diagnosticEventCursorBinding(
      project.id,
      invalidRun.runId,
    ),
    /events_not_available/u,
  );
  const invalidEventsRead = await fetch(
    `${baseUrl}/api/projects/${project.id}/runs/${invalidRun.runId}/diagnostic-events`,
    { headers },
  );
  assert.equal(invalidEventsRead.status, 409);
  assert.equal(
    (await invalidEventsRead.json() as any).error.code,
    "events_not_available",
  );

  await current.close();
  current = undefined;
  started = await start(base);
  current = started.app;
  baseUrl = started.baseUrl;
  const restartedCookie = await bootstrapAppSession(baseUrl);
  const restartedHeaders = browserOutputHeaders(restartedCookie);
  const restartedEventsUrl =
    `${baseUrl}/api/projects/${project.id}/runs/${run.runId}/diagnostic-events`;
  const second = await fetch(
    `${restartedEventsUrl}?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor)}`,
    { headers: restartedHeaders },
  );
  assert.equal(second.status, 200, await second.clone().text());
  const secondPage = await second.json() as any;
  assert.equal(secondPage.items[0].sequence, 1);
  assert.equal(secondPage.items[0].type, "repair_progress");
  assert.equal(secondPage.truncated, true);

  const tamperedCursor = `${firstPage.nextCursor.slice(0, -1)}${
    firstPage.nextCursor.endsWith("A") ? "B" : "A"
  }`;
  const tampered = await fetch(
    `${restartedEventsUrl}?limit=1&cursor=${encodeURIComponent(tamperedCursor)}`,
    { headers: restartedHeaders },
  );
  assert.equal(tampered.status, 422);
  assert.equal((await tampered.json() as any).error.code, "invalid_event_cursor");
  const filterSubstitution = await fetch(
    `${restartedEventsUrl}?limit=1&type=repair_finished&cursor=${
      encodeURIComponent(firstPage.nextCursor)
    }`,
    { headers: restartedHeaders },
  );
  assert.equal(filterSubstitution.status, 422);
  const duplicateQuery = await fetch(
    `${restartedEventsUrl}?limit=1&limit=2`,
    { headers: restartedHeaders },
  );
  assert.equal(duplicateQuery.status, 422);
  const filtered = await fetch(
    `${restartedEventsUrl}?type=repair_finished`,
    { headers: restartedHeaders },
  );
  assert.equal(filtered.status, 200);
  const filteredPage = await filtered.json() as any;
  assert.deepEqual(filteredPage.items.map((item: any) => item.type), [
    "repair_finished",
  ]);

  const eventObject = current.productStore!.listObjectFiles({
    kind: "run",
    id: run.runId,
  }).find((file) => file.mediaType === "application/x-ndjson");
  assert.ok(eventObject);
  const eventPath = join(
    base,
    "product",
    "objects",
    "projects",
    project.id,
    "runs",
    run.runId,
    eventObject.relativePath,
  );
  const originalEventBytes = await readFile(eventPath);
  const driftedEventBytes = Buffer.from(originalEventBytes);
  driftedEventBytes[0] = driftedEventBytes[0] === 0x7b ? 0x5b : 0x7b;
  await writeFile(eventPath, driftedEventBytes);
  const driftedRead = await fetch(restartedEventsUrl, { headers: restartedHeaders });
  assert.equal(driftedRead.status, 500);
  assert.equal((await driftedRead.json() as any).error.code, "event_integrity_failed");
  await current.close();
  current = undefined;
  await assert.rejects(
    () => start(base),
    /batch_success_recovery_invalid: the diagnostic event success closure is inconsistent/u,
  );
  await writeFile(eventPath, originalEventBytes);
  started = await start(base);
  current = started.app;
  baseUrl = started.baseUrl;
  const recoveredCookie = await bootstrapAppSession(baseUrl);
  const recoveredHeaders = browserOutputHeaders(recoveredCookie);
  const recoveredEventsUrl =
    `${baseUrl}/api/projects/${project.id}/runs/${run.runId}/diagnostic-events`;

  const preTrashUpdatedAt = current.productStore!.getProject(project.id).updatedAt;
  current.productStore!.trashResource(
    "project",
    project.id,
    preTrashUpdatedAt,
  );
  const trashedRead = await fetch(recoveredEventsUrl, { headers: recoveredHeaders });
  assert.equal(trashedRead.status, 409);
  current.productStore!.restoreResource(
    "project",
    project.id,
    preTrashUpdatedAt,
  );
  const staleAfterRestore = await fetch(
    `${recoveredEventsUrl}?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor)}`,
    { headers: recoveredHeaders },
  );
  assert.equal(staleAfterRestore.status, 422);
  assert.equal((await staleAfterRestore.json() as any).error.code, "invalid_event_cursor");
  await current.close();
  current = undefined;
  await rm(join(base, "product", ".diagnostic-event-cursor.key"));
  await assert.rejects(
    () => start(base),
    /diagnostic event cursor key is missing, corrupt, or insecure/u,
  );
});
