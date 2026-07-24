import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { GenericVisualSupervisor } from "../src/generic-visual-supervisor.ts";
import { UnavailableMesaAdapter } from "../src/mesa-adapter.ts";
import type {
  OpenCodeAdapter,
  OpenCodeAssistantResponse,
  OpenCodeConversationPort,
  OpenCodePrompt,
  OpenCodeProviderModel,
  OpenCodeReadiness,
} from "../src/opencode-adapter.ts";
import { BackendApp } from "../src/server.ts";

const PYTHON = "/usr/bin/python3";
const MODEL_SOURCE = readFileSync(
  join(import.meta.dirname, "fixtures", "generic-visual-model.py"),
);
const INPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["mode"],
  properties: {
    mode: {
      type: "string",
      enum: [
        "success",
        "redirect",
        "no_listener",
        "wildcard",
        "linger",
        "premature_exit",
        "stdout_overflow",
        "listener_drift",
        "hardlink_output",
      ],
    },
  },
};
const EXECUTION_DESCRIPTION = {
  schemaVersion: 2,
  runtime: "python",
  runMode: "visual",
  dependencyFile: "environment/requirements.txt",
  inputs: {
    schemaProfile: "riff-json-schema-2020-12-v1",
    schema: INPUT_SCHEMA,
    smoke: { mode: "success" },
  },
  outputs: [{
    logicalName: "summary",
    relativePath: "summary.json",
    mediaType: "application/json",
    required: true,
    role: "data",
  }],
  visual: {
    entryPoint: "code/model.py",
    protocol: "riff-visual-v1",
    healthPath: "/health",
  },
  cancellation: { signal: "SIGTERM", graceMs: 100 },
};

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
  async createSession(): Promise<string> { return "unused-a3-2a2c-session"; }
  async injectContext(): Promise<void> {}
  async promptWithModel(
    _sessionId: string,
    _binding: { providerId: string; modelId: string },
    _prompt: OpenCodePrompt,
  ): Promise<OpenCodeAssistantResponse> {
    throw new Error("A3-2a2c API acceptance must not depend on an Agent turn.");
  }
  async prompt(): Promise<void> {}
  async abort(): Promise<void> {}
}

const post = (url: string, body: unknown): Promise<Response> => fetch(url, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const start = async (base: string): Promise<{
  app: BackendApp;
  baseUrl: string;
  scratchRoot: string;
}> => {
  const legacyRoot = join(base, "legacy");
  const scratchRoot = join(base, "visual-scratch");
  await mkdir(legacyRoot, { recursive: true, mode: 0o700 });
  await mkdir(scratchRoot, { recursive: true, mode: 0o700 });
  const openCode = new AcceptanceOpenCode();
  const app = new BackendApp({
    mesa: new UnavailableMesaAdapter(),
    openCode,
    a2OpenCode: openCode,
    a2ProductRoot: join(base, "product"),
    workspaceRoot: legacyRoot,
    defaultSessionId: "a3-2a2c-api-acceptance",
    a3PythonExecutable: PYTHON,
    a3ScratchRoot: scratchRoot,
    a3DispatcherLeaseMs: 1_000,
    a3VisualSupervisor: new GenericVisualSupervisor({
      pythonExecutable: PYTHON,
      scratchRoot,
    }),
  });
  await app.initialize();
  const address = await app.listen();
  return {
    app,
    baseUrl: `http://127.0.0.1:${address.port}`,
    scratchRoot,
  };
};

const waitForSucceededRun = async (
  baseUrl: string,
  projectId: string,
  runId: string,
): Promise<any> => {
  for (let attempt = 0; attempt < 800; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/projects/${projectId}/runs/${runId}`);
    assert.equal(response.status, 200, await response.clone().text());
    const run = await response.json() as any;
    if (run.status === "succeeded") return run;
    if (["failed", "timed_out", "cancelled", "trashed"].includes(run.status)) {
      assert.fail(`Visual run ${runId} reached ${run.status}: ${run.terminalCode}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`Visual run ${runId} did not succeed.`);
};

type PrivateProcessEvidence = {
  pid: number;
  process_group_id: number;
  process_start_token: string;
  loopback_port: number;
  relative_path: string;
};

const privateProcessEvidence = (
  app: BackendApp,
  runId: string,
): PrivateProcessEvidence => {
  const database = new DatabaseSync(join(app.productStore!.root, "product.sqlite3"), {
    open: true,
    readOnly: true,
  });
  try {
    const row = database.prepare(`SELECT
        p.pid, p.process_group_id, p.process_start_token, p.loopback_port,
        s.relative_path
      FROM process_attempts p
      JOIN run_attempts a ON a.id = p.run_attempt_id
      JOIN process_launch_manifests m ON m.process_attempt_id = p.id
      JOIN run_scratch_leases s ON s.id = m.scratch_lease_id
      WHERE a.run_id = ? AND p.process_kind = 'visual'`
    ).get(runId) as PrivateProcessEvidence | undefined;
    assert.ok(row);
    return row;
  } finally {
    database.close();
  }
};

const assertNoCompletionEvidence = (app: BackendApp, runId: string): void => {
  const database = new DatabaseSync(join(app.productStore!.root, "product.sqlite3"), {
    open: true,
    readOnly: true,
  });
  try {
    assert.equal(Number((database.prepare(
      "SELECT count(*) AS count FROM run_completion_cards WHERE run_id = ?",
    ).get(runId) as { count: number }).count), 0);
    assert.equal(Number((database.prepare(`SELECT count(*) AS count FROM messages
      WHERE message_kind = 'platform_card' AND json_valid(content_json)
        AND json_extract(content_json, '$.runId') = ?`
    ).get(runId) as { count: number }).count), 0);
  } finally {
    database.close();
  }
};

const assertPublicEvidenceIsRedacted = (
  values: readonly unknown[],
  privateEvidence: PrivateProcessEvidence,
  scratchRoot: string,
): void => {
  const forbiddenKeys = new Set([
    "healthPath",
    "healthUrl",
    "loopbackPort",
    "pgid",
    "pid",
    "processGroupId",
    "processStartToken",
    "scratchId",
    "scratchPath",
  ]);
  const privateNumbers = new Set([
    privateEvidence.pid,
    privateEvidence.process_group_id,
    privateEvidence.loopback_port,
  ]);
  const privateStrings = [
    privateEvidence.process_start_token,
    privateEvidence.relative_path,
    join(scratchRoot, privateEvidence.relative_path),
    `http://127.0.0.1:${privateEvidence.loopback_port}/health`,
  ];
  const visit = (value: unknown, path: string): void => {
    if (typeof value === "number") {
      assert.equal(
        privateNumbers.has(value),
        false,
        `${path} exposed a private process/listener number`,
      );
      return;
    }
    if (typeof value === "string") {
      for (const secret of privateStrings) {
        assert.equal(
          value.includes(secret),
          false,
          `${path} exposed private process/scratch/listener evidence`,
        );
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      assert.equal(forbiddenKeys.has(key), false, `${path}.${key} is a private field`);
      visit(item, `${path}.${key}`);
    }
  };
  values.forEach((value, index) => visit(value, `public[${index}]`));
};

test("A3-2a2c public Project run route executes one real visual run without leaking child authority", {
  skip: process.platform !== "darwin",
  timeout: 45_000,
}, async (t) => {
  const base = await mkdtemp(join(tmpdir(), "riff-a3-2a2c-api-vertical-"));
  let current: BackendApp | undefined;
  t.after(async () => {
    await current?.close();
    await rm(base, { recursive: true, force: true });
  });

  let started = await start(base);
  current = started.app;
  let baseUrl = started.baseUrl;
  current.productStore!.createModel({
    id: "model_a3_2a2c_visual",
    name: "A3-2a2c real visual fixture",
    technicalStatus: "executable",
    runMode: "visual",
    executionDescription: EXECUTION_DESCRIPTION,
    createdAt: "2026-07-25T19:00:00.000Z",
    files: [
      {
        id: "file_a3_2a2c_visual_model",
        kind: "model_code",
        relativePath: "model.py",
        mediaType: "text/x-python",
        bytes: MODEL_SOURCE,
      },
      {
        id: "file_a3_2a2c_visual_environment",
        kind: "model_environment",
        relativePath: "requirements.txt",
        mediaType: "text/plain",
        bytes: Buffer.from("# no external dependencies\n"),
      },
    ],
  });

  const projectResponse = await post(`${baseUrl}/api/projects`, {
    commandId: "create-a3-2a2c-visual-project",
    name: "A3-2a2c Visual Project",
    modelId: "model_a3_2a2c_visual",
  });
  assert.equal(projectResponse.status, 201, await projectResponse.clone().text());
  const project = (await projectResponse.json() as any).project;

  const experimentResponse = await post(
    `${baseUrl}/api/projects/${project.id}/experiment-configs`,
    {
      commandId: "create-a3-2a2c-visual-experiment",
      name: "Real visual success",
      configuration: {
        schemaVersion: 1,
        runKind: "visual",
        parameters: { mode: "success" },
        sampling: { kind: "single" },
      },
    },
  );
  assert.equal(experimentResponse.status, 201, await experimentResponse.clone().text());
  const experiment = await experimentResponse.json() as any;

  const startRequest = {
    commandId: "start-a3-2a2c-real-visual",
    experimentConfigId: experiment.id,
  };
  const startResponse = await post(
    `${baseUrl}/api/projects/${project.id}/runs`,
    startRequest,
  );
  assert.equal(startResponse.status, 201, await startResponse.clone().text());
  const startReceipt = await startResponse.json() as any;
  assert.deepEqual(startReceipt, {
    schemaVersion: 1,
    commandId: startRequest.commandId,
    runId: startReceipt.runId,
    projectId: project.id,
    experimentConfigId: experiment.id,
    completionConversationId: null,
    status: "queued",
    runKind: "visual",
    sampleCount: 1,
    createdAt: startReceipt.createdAt,
  });

  const replayResponse = await post(
    `${baseUrl}/api/projects/${project.id}/runs`,
    startRequest,
  );
  assert.equal(replayResponse.status, 201, await replayResponse.clone().text());
  const replayReceipt = await replayResponse.json();
  assert.deepEqual(replayReceipt, startReceipt);

  const succeeded = await waitForSucceededRun(
    baseUrl,
    project.id,
    startReceipt.runId,
  );
  assert.equal(succeeded.runKind, "visual");
  assert.equal(succeeded.terminalCode, "visual_run_succeeded");
  assert.equal(succeeded.completionCardDisposition, "not_requested");
  assert.equal(succeeded.outputs.length, 1);
  assert.equal(succeeded.outputs[0].logicalName, "summary");
  assert.equal(succeeded.outputs[0].declaredRole, "data");
  assert.equal(succeeded.outputs[0].sampleIndex, 0);
  assert.match(succeeded.outputs[0].sha256, /^[0-9a-f]{64}$/u);

  const internalOutputs = current.productStore!.listRunOutputs(startReceipt.runId);
  assert.equal(internalOutputs.length, 1);
  assert.equal(internalOutputs[0]!.id, succeeded.outputs[0].id);
  const outputBytes = current.productStore!.readObjectFile(internalOutputs[0]!.file.id);
  const output = JSON.parse(outputBytes.toString("utf8"));
  assert.equal(output.mode, "success");
  assert.equal(output.requestCount, 1);
  assert.equal(output.sampleId, succeeded.outputs[0].sampleId);
  assertNoCompletionEvidence(current, startReceipt.runId);
  assert.equal(current.productStore!.listRunAttempts(startReceipt.runId).length, 1);

  const workspaceResponse = await fetch(`${baseUrl}/api/projects/${project.id}/workspace`);
  assert.equal(workspaceResponse.status, 200, await workspaceResponse.clone().text());
  const workspace = await workspaceResponse.json();
  const errorResponse = await post(`${baseUrl}/api/projects/${project.id}/runs`, {
    commandId: "reject-a3-2a2c-private-authority",
    experimentConfigId: experiment.id,
    loopbackPort: 42_399,
  });
  assert.equal(errorResponse.status, 422, await errorResponse.clone().text());
  const publicError = await errorResponse.json();
  const privateEvidence = privateProcessEvidence(current, startReceipt.runId);
  assertPublicEvidenceIsRedacted(
    [startReceipt, replayReceipt, succeeded, workspace, publicError],
    privateEvidence,
    started.scratchRoot,
  );

  await current.close();
  current = undefined;
  started = await start(base);
  current = started.app;
  baseUrl = started.baseUrl;

  const succeededAfterRestart = await waitForSucceededRun(
    baseUrl,
    project.id,
    startReceipt.runId,
  );
  assert.deepEqual(succeededAfterRestart, succeeded);
  const workspaceAfterRestartResponse = await fetch(
    `${baseUrl}/api/projects/${project.id}/workspace`,
  );
  assert.equal(
    workspaceAfterRestartResponse.status,
    200,
    await workspaceAfterRestartResponse.clone().text(),
  );
  const workspaceAfterRestart = await workspaceAfterRestartResponse.json();
  assert.deepEqual(workspaceAfterRestart, workspace);
  const reopenedOutputs = current.productStore!.listRunOutputs(startReceipt.runId);
  assert.equal(reopenedOutputs.length, 1);
  assert.deepEqual(
    current.productStore!.readObjectFile(reopenedOutputs[0]!.file.id),
    outputBytes,
  );
  assert.equal(current.productStore!.listRunAttempts(startReceipt.runId).length, 1);
  assertNoCompletionEvidence(current, startReceipt.runId);
  assertPublicEvidenceIsRedacted(
    [succeededAfterRestart, workspaceAfterRestart],
    privateEvidence,
    started.scratchRoot,
  );
});
