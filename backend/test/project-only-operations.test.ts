import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createGenericModelScaffold } from "../src/model-workspace.ts";
import { ProjectOnlyOperationsAdapter } from "../src/project-only-operations.ts";
import { openProjectOnlyServerRuntime } from "../src/project-only-server-factory.ts";
import { ProjectOnlyStore, ProjectOnlyStoreError } from "../src/project-only-store.ts";

const NOW = "2026-08-04T05:00:00.000Z";
const scaffold = createGenericModelScaffold("project_alpha");

const projectFiles = () => scaffold.files.map((file, index) => ({
  id: `project_file_${index}`,
  kind: file.kind === "model_environment" ? "project_environment" as const
    : file.kind === "model_visual_asset" ? "project_visual_asset" as const
      : "project_code" as const,
  relativePath: file.relativePath,
  mediaType: file.mediaType,
  bytes: file.bytes,
}));

test("direct Project write commits syntax-invalid text, replays its receipt, and admits a Run", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "riff-project-ops-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let store = ProjectOnlyStore.open(join(root, ".riff-product"));
  t.after(() => { try { store.close(); } catch { /* already closed */ } });
  const project = store.createProject({
    id: "project_alpha",
    name: "Alpha",
    source: { kind: "import", importDigest: "a".repeat(64), files: projectFiles() },
    runMode: scaffold.runMode,
    executionDescription: scaffold.executionDescription,
    createdAt: NOW,
  });
  store.createExperiment({
    id: "experiment_alpha",
    projectId: project.id,
    name: "Smoke",
    configuration: { schemaVersion: 1, runKind: "batch", parameters: {}, sampling: { kind: "single", seed: 1 } },
    createdAt: NOW,
  });
  const operations = new ProjectOnlyOperationsAdapter(store, () => NOW);
  const model = store.projectFiles(project.id).find((file) => file.relativePath === "model.py")!;
  const request = {
    commandId: "command_delivery",
    projectId: project.id,
    conversationId: "conversation_alpha",
    turnId: "turn_alpha",
    expectedWorkspaceDigest: project.workspaceDigest,
    changes: [{
      operation: "upsert",
      relativePath: model.relativePath,
      mediaType: model.mediaType,
      text: "def broken(:\n",
      expectedPriorSha256: model.sha256,
    }],
  } as const;
  const delivery = await operations.writeProjectFiles(request);
  assert.equal(delivery.result.state, "committed");
  assert.notEqual(delivery.result.afterWorkspaceDigest, project.workspaceDigest);
  assert.equal(store.projectFiles(project.id).find((file) => file.id === model.id)?.bytes.toString("utf8"), "def broken(:\n");
  assert.deepEqual(await operations.writeProjectFiles(request), delivery);
  assert.deepEqual(store.deliveryReceipt("command_delivery")?.response, delivery);

  store.close();
  store = ProjectOnlyStore.open(join(root, ".riff-product"));
  assert.equal(store.projectFiles(project.id).find((file) => file.id === model.id)?.bytes.toString("utf8"), "def broken(:\n");

  const admission = operationsFor(store).startRunAdmission({
    commandId: "command_run",
    projectId: project.id,
    experimentConfigurationId: "experiment_alpha",
    runKind: "batch",
    expectedWorkspaceDigest: String(delivery.result.afterWorkspaceDigest),
  });
  assert.equal(admission.status, "queued");
  assert.equal(admission.sourceFilesRetained, false);
});

test("direct Project write enforces workspace/file CAS and the active Run lock", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "riff-project-cas-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = ProjectOnlyStore.open(join(root, ".riff-product"));
  t.after(() => store.close());
  const project = store.createProject({
    id: "project_alpha", name: "Alpha",
    source: { kind: "import", importDigest: "a".repeat(64), files: projectFiles() },
    runMode: "batch", executionDescription: scaffold.executionDescription, createdAt: NOW,
  });
  const file = store.projectFiles(project.id)[0]!;
  const operations = operationsFor(store);
  await assert.rejects(() => operations.writeProjectFiles({
    commandId: "command_stale_workspace", projectId: project.id,
    conversationId: "conversation_alpha", turnId: "turn_alpha",
    expectedWorkspaceDigest: "f".repeat(64),
    changes: [{ operation: "delete", relativePath: file.relativePath, expectedPriorSha256: file.sha256 }],
  }), (error: unknown) => error instanceof ProjectOnlyStoreError && error.code === "stale_workspace_digest");
  await assert.rejects(() => operations.writeProjectFiles({
    commandId: "command_stale_file", projectId: project.id,
    conversationId: "conversation_alpha", turnId: "turn_alpha",
    expectedWorkspaceDigest: project.workspaceDigest,
    changes: [{ operation: "delete", relativePath: file.relativePath, expectedPriorSha256: "e".repeat(64) }],
  }), (error: unknown) => error instanceof ProjectOnlyStoreError && error.code === "stale_project_file");

  store.createExperiment({
    id: "experiment_alpha", projectId: project.id, name: "Batch",
    configuration: { schemaVersion: 1, runKind: "batch", parameters: {}, sampling: { kind: "single" } },
    createdAt: NOW,
  });
  store.startRun({
    id: "run_alpha", projectId: project.id, experimentConfigurationId: "experiment_alpha",
    runKind: "batch", expectedWorkspaceDigest: project.workspaceDigest, createdAt: NOW,
  });
  await assert.rejects(() => operations.writeProjectFiles({
    commandId: "command_locked", projectId: project.id,
    conversationId: "conversation_alpha", turnId: "turn_alpha",
    expectedWorkspaceDigest: project.workspaceDigest,
    changes: [{
      operation: "upsert", relativePath: "notes/结论.md", mediaType: "text/markdown",
      text: "保留文件，等待 Run 终态。\n", expectedPriorSha256: null,
    }],
  }), (error: unknown) => error instanceof ProjectOnlyStoreError && error.code === "project_execution_locked");
});

test("direct Project write supports generic nested artifacts and enforces bounded UTF-8 changes", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "riff-project-bounds-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = ProjectOnlyStore.open(join(root, ".riff-product"));
  t.after(() => store.close());
  let project = store.createProject({
    id: "project_alpha", name: "Alpha",
    source: { kind: "import", importDigest: "a".repeat(64), files: projectFiles() },
    runMode: "batch", executionDescription: scaffold.executionDescription, createdAt: NOW,
  });
  const operations = operationsFor(store);
  const created = await operations.writeProjectFiles({
    commandId: "command_artifacts", projectId: project.id,
    conversationId: "conversation_alpha", turnId: "turn_alpha",
    expectedWorkspaceDigest: project.workspaceDigest,
    changes: [
      { operation: "upsert", relativePath: "分析/summary.custom", mediaType: "text/plain", text: "结论\n", expectedPriorSha256: null },
      { operation: "upsert", relativePath: "reports/view.html", mediaType: "text/html", text: "<!doctype html><title>View</title>", expectedPriorSha256: null },
      { operation: "upsert", relativePath: "data/config.json", mediaType: "application/json", text: "{}\n", expectedPriorSha256: null },
    ],
  });
  assert.equal(created.result.state, "committed");
  assert.equal(store.projectFiles(project.id).find((file) => file.relativePath === "分析/summary.custom")?.kind, "project_artifact");
  project = store.project(project.id);
  const artifact = store.projectFiles(project.id).find((file) => file.relativePath === "分析/summary.custom")!;
  const deleted = await operations.writeProjectFiles({
    commandId: "command_delete_artifact", projectId: project.id,
    conversationId: "conversation_alpha", turnId: "turn_beta",
    expectedWorkspaceDigest: project.workspaceDigest,
    changes: [{ operation: "delete", relativePath: artifact.relativePath, expectedPriorSha256: artifact.sha256 }],
  });
  assert.equal(deleted.result.state, "committed");
  assert.equal(store.projectFiles(project.id).some((file) => file.relativePath === artifact.relativePath), false);
  await assert.rejects(() => operations.writeProjectFiles({
    commandId: "command_artifacts", projectId: project.id,
    conversationId: "conversation_alpha", turnId: "turn_alpha",
    expectedWorkspaceDigest: project.workspaceDigest,
    changes: [{ operation: "upsert", relativePath: "different.txt", mediaType: "text/plain", text: "x", expectedPriorSha256: null }],
  }), (error: unknown) => error instanceof ProjectOnlyStoreError && error.code === "idempotency_conflict");

  const currentDigest = store.project(project.id).workspaceDigest;
  await assert.rejects(() => operations.writeProjectFiles({
    commandId: "command_file_too_large", projectId: project.id,
    conversationId: "conversation_alpha", turnId: "turn_gamma",
    expectedWorkspaceDigest: currentDigest,
    changes: [{ operation: "upsert", relativePath: "large.txt", mediaType: "text/plain", text: "x".repeat(1_048_577), expectedPriorSha256: null }],
  }), (error: unknown) => error instanceof ProjectOnlyStoreError && error.code === "project_file_too_large");
  await assert.rejects(() => operations.writeProjectFiles({
    commandId: "command_write_too_large", projectId: project.id,
    conversationId: "conversation_alpha", turnId: "turn_delta",
    expectedWorkspaceDigest: currentDigest,
    changes: Array.from({ length: 9 }, (_, index) => ({
      operation: "upsert", relativePath: `large/${index}.txt`, mediaType: "text/plain",
      text: "x".repeat(1_000_000), expectedPriorSha256: null,
    })),
  }), (error: unknown) => error instanceof ProjectOnlyStoreError && error.code === "project_write_too_large");
  await assert.rejects(() => operations.writeProjectFiles({
    commandId: "command_binary", projectId: project.id,
    conversationId: "conversation_alpha", turnId: "turn_epsilon",
    expectedWorkspaceDigest: currentDigest,
    changes: [{ operation: "upsert", relativePath: "image.png", mediaType: "image/png", text: "not binary", expectedPriorSha256: null }],
  }), (error: unknown) => error instanceof ProjectOnlyStoreError && error.code === "invalid_project_change");
});

test("server factory opens v4 Project runtime and gates legacy Model schema as recovery-only", (t) => {
  const root = mkdtempSync(join(tmpdir(), "riff-project-factory-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ready = openProjectOnlyServerRuntime({ root: join(root, "fresh"), now: () => NOW });
  assert.equal(ready.mode, "ready");
  if (ready.mode === "ready") ready.store.close();
  const legacyRoot = join(root, "legacy");
  mkdirSync(legacyRoot);
  const legacy = new DatabaseSync(join(legacyRoot, "riff.sqlite3"));
  legacy.exec("CREATE TABLE models (id TEXT PRIMARY KEY)");
  legacy.close();
  const gated = openProjectOnlyServerRuntime({ root: legacyRoot, now: () => NOW });
  assert.equal(gated.mode, "recovery_only");
  if (gated.mode === "recovery_only") assert.equal(gated.code, "legacy_store_recovery_required");
});

const operationsFor = (store: ProjectOnlyStore): ProjectOnlyOperationsAdapter =>
  new ProjectOnlyOperationsAdapter(store, () => NOW);
