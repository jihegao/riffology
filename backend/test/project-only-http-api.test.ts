import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { ModelTechnicalCheckInput, ModelTechnicalCheckResult } from "../src/model-technical-checker.ts";
import { captureWorkspaceDigest, createGenericModelScaffold, executionDescriptionDigest } from "../src/model-workspace.ts";
import { openProjectOnlyServerRuntime } from "../src/project-only-server-factory.ts";
import { BackendApp } from "../src/server.ts";

const NOW = "2026-08-04T07:00:00.000Z";
const scaffold = createGenericModelScaffold("project_http");
const checker = {
  async check(input: ModelTechnicalCheckInput): Promise<ModelTechnicalCheckResult> {
    const captured = captureWorkspaceDigest(input.workspace);
    return Object.freeze({
      attemptId: "check_http",
      aggregate: "executable" as const,
      capturedWorkspaceDigest: captured.digest,
      executionDescriptionDigest: executionDescriptionDigest(input.executionDescription as any),
      dependencyDescriptionDigest: "d".repeat(64),
      environmentKey: "fixture",
      startedAt: NOW,
      finishedAt: NOW,
      limits: Object.freeze({ timeoutMs: 1000, maxOutputBytes: 1000, maxWorkspaceFiles: 100, maxWorkspaceBytes: 100000 }),
      checks: Object.freeze([{ name: "path" as const, state: "passed" as const, code: "ok", detail: "fixture" }]),
      log: "",
    });
  },
};

const start = async (t: test.TestContext) => {
  const temp = mkdtempSync(join(tmpdir(), "riff-project-http-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const runtime = openProjectOnlyServerRuntime({ root: join(temp, ".riff-product"), checker, now: () => NOW });
  assert.equal(runtime.mode, "ready");
  if (runtime.mode !== "ready") throw new Error("fixture runtime did not open");
  runtime.store.createTemplateVersion({
    id: "template_http",
    version: "1",
    description: "HTTP template",
    runMode: scaffold.runMode,
    executionDescription: scaffold.executionDescription,
    defaultExperiment: { seed: 1 },
    files: scaffold.files.map((file, index) => ({
      id: `template_file_${index}`,
      kind: file.kind === "model_environment" ? "project_environment" as const
        : file.kind === "model_visual_asset" ? "project_visual_asset" as const : "project_code" as const,
      relativePath: file.relativePath,
      mediaType: file.mediaType,
      bytes: file.bytes,
    })),
    createdAt: NOW,
  });
  const project = runtime.store.createProject({
    id: "project_http",
    name: "HTTP Project",
    source: { kind: "template", templateId: "template_http", version: "1" },
    createdAt: NOW,
  });
  const app = new BackendApp({ projectOnlyRuntime: runtime });
  await app.initialize();
  const address = await app.listen();
  t.after(() => app.close());
  return { app, runtime, project, origin: `http://127.0.0.1:${address.port}` };
};

const body = async (response: Response): Promise<any> => JSON.parse(await response.text());

test("Project-only HTTP exposes Home/workspace/check and retires every Model route", async (t) => {
  const { origin, project } = await start(t);
  const homeResponse = await fetch(`${origin}/api/home`);
  assert.equal(homeResponse.status, 200);
  const home = await body(homeResponse);
  assert.deepEqual(Object.keys(home).sort(), [
    "collectionDigest", "generatedAt", "projects", "providerAvailability", "recentConversations", "schemaVersion", "templates",
  ]);
  assert.equal("models" in home, false);
  assert.equal(home.projects[0].id, project.id);
  assert.equal(home.templates[0].id, "template_http");

  for (const request of [
    fetch(`${origin}/api/models`),
    fetch(`${origin}/api/models/model_legacy/workspace`),
    fetch(`${origin}/api/models/model_legacy/technical-checks`, { method: "POST" }),
  ]) {
    const response = await request;
    assert.equal(response.status, 410);
    assert.equal((await body(response)).error.code, "legacy_model_api_removed");
  }

  const workspaceResponse = await fetch(`${origin}/api/projects/${project.id}/workspace`);
  assert.equal(workspaceResponse.status, 200);
  const workspace = await body(workspaceResponse);
  assert.equal(workspace.owner.kind, "project");
  assert.equal(workspace.owner.id, project.id);
  assert.deepEqual(workspace.conversations, []);
  assert.equal(workspace.workspaceDigest, project.workspaceDigest);
  assert.equal(workspace.files.length > 0, true);
  assert.deepEqual(workspace.executionLock, { state: "unlocked", runId: null, sourceDigest: null });

  const checkResponse = await fetch(`${origin}/api/projects/${project.id}/technical-checks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ commandId: "command_http_check" }),
  });
  assert.equal(checkResponse.status, 201, JSON.stringify(await checkResponse.clone().text()));
  const check = await body(checkResponse);
  assert.equal(check.projectId, project.id);
  assert.equal(check.state, "passed");
  assert.equal(check.aggregate, "executable");
  assert.equal(check.capturedWorkspaceDigest, project.workspaceDigest);
});

test("Project creation source DTOs are accepted structurally but fail closed before partial creation", async (t) => {
  const { origin, runtime } = await start(t);
  const sources = [
    { kind: "blank" },
    { kind: "template", templateId: "template_http", templateVersion: "1" },
    { kind: "import", filename: "project.riff.json", mediaType: "application/vnd.riff.project+json", base64: Buffer.from("{}").toString("base64") },
  ];
  for (const [index, source] of sources.entries()) {
    const response = await fetch(`${origin}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandId: `command_create_${index}`,
        name: `Project ${index}`,
        provider: { providerId: "provider", modelId: "agent" },
        source,
      }),
    });
    assert.equal(response.status, 501);
    assert.equal((await body(response)).error.code, "project_conversation_service_unavailable");
  }
  assert.equal(runtime.store.projects().length, 1);
});

test("legacy schema starts recovery-only and cannot expose Product or Model data", async (t) => {
  const temp = mkdtempSync(join(tmpdir(), "riff-project-http-recovery-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const root = join(temp, ".riff-product");
  mkdirSync(root);
  const legacy = new DatabaseSync(join(root, "riff.sqlite3"));
  legacy.exec("CREATE TABLE models (id TEXT PRIMARY KEY)");
  legacy.close();
  const runtime = openProjectOnlyServerRuntime({ root, checker, now: () => NOW });
  assert.equal(runtime.mode, "recovery_only");
  if (runtime.mode !== "recovery_only") throw new Error("legacy fixture was not gated");
  const app = new BackendApp({
    productOnly: true,
    recoveryStatus: {
      state: "recovery_required",
      code: runtime.code,
      observedAt: NOW,
      retryable: runtime.retryable,
    },
  });
  await app.initialize();
  const address = await app.listen();
  t.after(() => app.close());
  const origin = `http://127.0.0.1:${address.port}`;
  const health = await fetch(`${origin}/api/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await body(health), { healthy: false, state: "recovery_required" });
  for (const path of ["/api/home", "/api/projects", "/api/models", "/api/models/legacy/workspace"]) {
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, 503, path);
    assert.equal((await body(response)).error.code, "recovery_required");
  }
});
