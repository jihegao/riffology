import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
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
  await app.initialize();
  const address = await app.listen();
  return { app, baseUrl: `http://127.0.0.1:${address.port}` };
};

const waitForRun = async (
  baseUrl: string,
  projectId: string,
  runId: string,
  status: "running" | "succeeded" | "cancelled",
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
