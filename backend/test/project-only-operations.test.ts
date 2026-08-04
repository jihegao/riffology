import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { ModelTechnicalCheckInput, ModelTechnicalCheckResult } from "../src/model-technical-checker.ts";
import { captureWorkspaceDigest, createGenericModelScaffold, executionDescriptionDigest } from "../src/model-workspace.ts";
import { ProjectOnlyOperationsAdapter } from "../src/project-only-operations.ts";
import { openProjectOnlyServerRuntime } from "../src/project-only-server-factory.ts";
import { ProjectOnlyStore } from "../src/project-only-store.ts";

const NOW = "2026-08-04T05:00:00.000Z";
const scaffold = createGenericModelScaffold("project_alpha");

const checker = (aggregate: "executable" | "failed") => ({
  async check(input: ModelTechnicalCheckInput): Promise<ModelTechnicalCheckResult> {
    const snapshot = captureWorkspaceDigest(input.workspace);
    return Object.freeze({
      attemptId: "checker_attempt",
      aggregate,
      capturedWorkspaceDigest: snapshot.digest,
      executionDescriptionDigest: executionDescriptionDigest(input.executionDescription as any),
      dependencyDescriptionDigest: "d".repeat(64),
      environmentKey: "fixture",
      startedAt: NOW,
      finishedAt: NOW,
      limits: Object.freeze({ timeoutMs: 1000, maxOutputBytes: 1000, maxWorkspaceFiles: 100, maxWorkspaceBytes: 100000 }),
      checks: Object.freeze([{ name: "path" as const, state: aggregate === "executable" ? "passed" as const : "failed" as const, code: aggregate === "executable" ? "ok" : "fixture_failure", detail: "fixture" }]),
      log: "",
    });
  },
});

const projectFiles = () => scaffold.files.map((file, index) => ({
  id: `project_file_${index}`,
  kind: file.kind === "model_environment" ? "project_environment" as const
    : file.kind === "model_visual_asset" ? "project_visual_asset" as const
      : "project_code" as const,
  relativePath: file.relativePath,
  mediaType: file.mediaType,
  bytes: file.bytes,
}));

test("Project operations adapter binds technical check, delivery reread, receipt replay, and Run admission", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "riff-project-ops-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = ProjectOnlyStore.open(join(root, ".riff-product"));
  t.after(() => store.close());
  let project = store.createProject({
    id: "project_alpha",
    name: "Alpha",
    source: { kind: "import", importDigest: "a".repeat(64), files: projectFiles() },
    runMode: scaffold.runMode,
    executionDescription: scaffold.executionDescription,
    createdAt: NOW,
  });
  store.createExperiment({ id: "experiment_alpha", projectId: project.id, name: "Smoke", configuration: { inputs: scaffold.executionDescription.inputs.smoke, seeds: [1] }, createdAt: NOW });
  const operations = new ProjectOnlyOperationsAdapter(store, checker("executable"), () => NOW);
  const initial = await operations.startProjectTechnicalCheck({ projectId: project.id, commandId: "command_check", expectedWorkspaceDigest: project.workspaceDigest });
  assert.equal(initial.result.status, "succeeded");
  assert.equal(initial.result.workspaceDigest, project.workspaceDigest);
  assert.match(String((initial.result.technicalCheck as any).capturedFileDigest), /^[0-9a-f]{64}$/u);
  assert.deepEqual(await operations.startProjectTechnicalCheck({ projectId: project.id, commandId: "command_check", expectedWorkspaceDigest: project.workspaceDigest }), initial);

  project = store.project(project.id);
  const model = store.projectFiles(project.id).find((file) => file.relativePath === "model.py")!;
  const delivery = await operations.deliverProjectChanges({
    commandId: "command_delivery",
    projectId: project.id,
    conversationId: "conversation_alpha",
    turnId: "turn_alpha",
    expectedWorkspaceDigest: project.workspaceDigest,
    changes: [{ fileRef: "project_file_ref", kind: "code", relativePath: model.relativePath, mediaType: model.mediaType, text: `${model.bytes.toString("utf8")}\n# delivered\n`, expectedPriorSha256: model.sha256 }],
    run: { configurationId: "experiment_alpha" },
  });
  assert.equal(delivery.result.status, "succeeded");
  assert.equal(delivery.result.partialEffect, false);
  assert.notEqual(delivery.result.workspaceDigest, project.workspaceDigest);
  assert.equal(store.project(project.id).technicalStatus, "executable");
  assert.equal((delivery.result.run as any).status, "queued");
  assert.deepEqual(await operations.deliverProjectChanges({
    commandId: "command_delivery",
    projectId: project.id,
    conversationId: "conversation_alpha",
    turnId: "turn_alpha",
    expectedWorkspaceDigest: project.workspaceDigest,
    changes: [{ fileRef: "project_file_ref", kind: "code", relativePath: model.relativePath, mediaType: model.mediaType, text: `${model.bytes.toString("utf8")}\n# delivered\n`, expectedPriorSha256: model.sha256 }],
    run: { configurationId: "experiment_alpha" },
  }), delivery);

  const deliveredRunId = String((delivery.result.run as any).runId);
  store.transitionRun({ id: deliveredRunId, status: "running", at: NOW });
  store.transitionRun({ id: deliveredRunId, status: "succeeded", at: NOW });

  const admission = operations.startRunAdmission({
    commandId: "command_run",
    projectId: project.id,
    experimentConfigurationId: "experiment_alpha",
    runKind: "batch",
    expectedWorkspaceDigest: String(delivery.result.workspaceDigest),
  });
  assert.equal(admission.status, "queued");
  assert.equal(admission.sourceFilesRetained, false);
  assert.deepEqual(operations.startRunAdmission({
    commandId: "command_run",
    projectId: project.id,
    experimentConfigurationId: "experiment_alpha",
    runKind: "batch",
    expectedWorkspaceDigest: String(delivery.result.workspaceDigest),
  }), admission);
});

test("delivery reports partialEffect after committed write when technical check fails", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "riff-project-partial-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = ProjectOnlyStore.open(join(root, ".riff-product"));
  t.after(() => store.close());
  const project = store.createProject({ id: "project_alpha", name: "Alpha", source: { kind: "import", importDigest: "a".repeat(64), files: projectFiles() }, runMode: scaffold.runMode, executionDescription: scaffold.executionDescription, createdAt: NOW });
  const file = store.projectFiles(project.id)[0]!;
  const delivery = await new ProjectOnlyOperationsAdapter(store, checker("failed"), () => NOW).deliverProjectChanges({
    commandId: "command_delivery",
    projectId: project.id,
    conversationId: "conversation_alpha",
    turnId: "turn_alpha",
    expectedWorkspaceDigest: project.workspaceDigest,
    changes: [{ fileRef: "project_file_ref", kind: file.kind === "project_environment" ? "environment" : file.kind === "project_visual_asset" ? "visual_asset" : "code", relativePath: file.relativePath, mediaType: file.mediaType, text: `${file.bytes.toString("utf8")}\n# changed\n`, expectedPriorSha256: file.sha256 }],
  });
  assert.equal(delivery.result.status, "failed");
  assert.equal(delivery.result.partialEffect, true);
  assert.equal(store.project(project.id).technicalStatus, "failed");
  assert.equal(store.project(project.id).workspaceDigest, delivery.result.workspaceDigest);
});

test("server factory opens fresh Project runtime and gates legacy Model schema as recovery-only", (t) => {
  const root = mkdtempSync(join(tmpdir(), "riff-project-factory-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const freshRoot = join(root, "fresh");
  const ready = openProjectOnlyServerRuntime({ root: freshRoot, checker: checker("executable"), now: () => NOW });
  assert.equal(ready.mode, "ready");
  if (ready.mode === "ready") ready.store.close();
  const legacyRoot = join(root, "legacy");
  mkdirSync(legacyRoot);
  const legacy = new DatabaseSync(join(legacyRoot, "riff.sqlite3"));
  legacy.exec("CREATE TABLE models (id TEXT PRIMARY KEY)");
  legacy.close();
  const gated = openProjectOnlyServerRuntime({ root: legacyRoot, checker: checker("executable"), now: () => NOW });
  assert.equal(gated.mode, "recovery_only");
  if (gated.mode === "recovery_only") assert.equal(gated.code, "legacy_store_recovery_required");
});
