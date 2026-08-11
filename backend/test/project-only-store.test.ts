import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProjectOnlyStore, ProjectOnlyStoreError } from "../src/project-only-store.ts";

const NOW = "2026-08-04T04:00:00.000Z";
const LATER = "2026-08-04T04:01:00.000Z";
const EXECUTION = Object.freeze({ schemaVersion: 2, batch: { entrypoint: "model.py" } });

test("fresh Project-only v4 Store has no technical-check authority", (t) => {
  const root = mkdtempSync(join(tmpdir(), "riff-project-only-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = ProjectOnlyStore.open(join(root, ".riff-product"));
  t.after(() => store.close());
  const database = store.databaseForTesting();
  const tableRows = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>;
  const tables = tableRows.map(({ name }) => name);
  assert.equal(tables.includes("models"), false);
  assert.equal(tables.includes("project_technical_checks"), false);
  assert.equal(database.prepare("PRAGMA user_version").get()!.user_version, 4);
  const projectColumnRows = database.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>;
  const projectColumns = projectColumnRows.map(({ name }) => name);
  assert.equal(projectColumns.includes("technical_status"), false);
  const fileSql = String((database.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'project_files'",
  ).get() as any).sql);
  assert.match(fileSql, /project_artifact/u);
  const lockSql = String((database.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'execution_locks'",
  ).get() as any).sql);
  assert.match(lockSql, /holder_kind = 'run'/u);
  assert.doesNotMatch(lockSql, /technical_check/u);
});

test("Project and first Conversation creation is atomic, idempotent, and restart-safe", (t) => {
  const root = mkdtempSync(join(tmpdir(), "riff-project-conversation-create-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let store = ProjectOnlyStore.open(join(root, ".riff-product"));
  t.after(() => { try { store.close(); } catch { /* already closed */ } });
  const input = {
    commandId: "command_project_create",
    project: { id: "project_create", name: "Created", source: { kind: "blank" as const }, createdAt: NOW },
    conversation: {
      id: "conversation_create", name: "模型设计", providerId: "provider", modelId: "agent",
    },
  };
  const created = store.createProjectWithConversation(input);
  assert.match(created.receiptDigest, /^[0-9a-f]{64}$/u);
  assert.deepEqual(store.createProjectWithConversation(input), created);
  store.close();
  store = ProjectOnlyStore.open(join(root, ".riff-product"));
  assert.deepEqual(store.createProjectWithConversation(input), created);
  assert.equal(store.projects().length, 1);
  assert.equal(store.conversations("project_create").length, 1);
  assert.throws(() => store.createProjectWithConversation({
    ...input,
    project: { ...input.project, name: "Conflicting intent" },
  }), (error: unknown) => error instanceof ProjectOnlyStoreError && error.code === "idempotency_conflict");
});

test("only an active Run locks Project writes and terminal failure preserves diagnostics", (t) => {
  const root = mkdtempSync(join(tmpdir(), "riff-project-lock-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = ProjectOnlyStore.open(join(root, ".riff-product"));
  t.after(() => store.close());
  const project = store.createProject({
    id: "project_alpha",
    name: "Alpha",
    source: { kind: "import", importDigest: "a".repeat(64), files: [{
      id: "project_file_alpha", kind: "project_code", relativePath: "model.py",
      mediaType: "text/x-python", bytes: Buffer.from("def broken(:\n"),
    }] },
    runMode: "both",
    executionDescription: EXECUTION,
    createdAt: NOW,
  });
  store.createExperiment({
    id: "experiment_alpha", projectId: project.id, name: "Smoke",
    configuration: { schemaVersion: 1, runKind: "batch", parameters: {}, sampling: { kind: "single" } },
    createdAt: NOW,
  });
  store.startRun({
    id: "run_alpha", projectId: project.id, experimentConfigurationId: "experiment_alpha",
    runKind: "batch", expectedWorkspaceDigest: project.workspaceDigest, createdAt: NOW,
  });
  assert.equal(store.project(project.id).executionLock?.holderKind, "run");
  assert.throws(() => store.updateProjectWorkspace({
    projectId: project.id, expectedWorkspaceDigest: project.workspaceDigest, updatedAt: LATER,
    changes: [{
      id: "project_file_alpha", kind: "project_code", relativePath: "model.py",
      mediaType: "text/x-python", bytes: Buffer.from("print('fixed')\n"),
    }],
  }), (error: unknown) => error instanceof ProjectOnlyStoreError && error.code === "project_execution_locked");
  store.failRunStart({
    id: "run_alpha", code: "python_syntax_error",
    diagnostic: "SyntaxError: invalid syntax", at: LATER,
  });
  assert.equal(store.project(project.id).executionLock, null);
  assert.equal(store.run("run_alpha").status, "failed");
  assert.equal(store.runCompletion("run_alpha")?.completion.diagnostic, "SyntaxError: invalid syntax");
  assert.equal(store.projectFiles(project.id)[0]!.bytes.toString("utf8"), "def broken(:\n");
});

test("Project paths accept nested Unicode text and reject traversal, reserved roots, and normalized collisions", (t) => {
  const root = mkdtempSync(join(tmpdir(), "riff-project-paths-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = ProjectOnlyStore.open(join(root, ".riff-product"));
  t.after(() => store.close());
  const project = store.createProject({ id: "project_alpha", name: "Alpha", source: { kind: "blank" }, createdAt: NOW });
  const create = (relativePath: string) => store.updateProjectWorkspace({
    projectId: project.id,
    expectedWorkspaceDigest: store.project(project.id).workspaceDigest,
    updatedAt: LATER,
    changes: [{
      id: `file_${Buffer.from(relativePath).toString("hex").slice(0, 64)}`,
      kind: "project_artifact" as const,
      relativePath,
      mediaType: "text/plain",
      bytes: Buffer.from("ok\n"),
    }],
  });
  create("分析/阶段一/结论.txt");
  assert.equal(store.projectFiles(project.id).some((file) => file.relativePath === "分析/阶段一/结论.txt"), true);
  for (const path of [
    "../secret.txt", "/tmp/secret.txt", "C:/secret.txt", ".git/config", ".OPENCODE/config",
    "node_modules/x.txt", "a\\b.txt", "a//b.txt",
  ]) {
    assert.throws(() => create(path), (error: unknown) => error instanceof ProjectOnlyStoreError
      && ["invalid_project_path", "reserved_project_path"].includes(error.code), path);
  }
  create("Reports/Result.txt");
  assert.throws(() => create("reports/result.txt"),
    (error: unknown) => error instanceof ProjectOnlyStoreError && error.code === "project_path_collision");
  create("prefix");
  assert.throws(() => create("prefix/child.txt"),
    (error: unknown) => error instanceof ProjectOnlyStoreError && error.code === "project_path_collision");
});

test("archived Projects reject writes and Run admission", (t) => {
  const root = mkdtempSync(join(tmpdir(), "riff-project-archived-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = ProjectOnlyStore.open(join(root, ".riff-product"));
  t.after(() => store.close());
  const project = store.createProject({
    id: "project_archived", name: "Archived", source: { kind: "blank" },
    runMode: "batch", executionDescription: EXECUTION, createdAt: NOW,
  });
  store.createExperiment({
    id: "experiment_archived", projectId: project.id, name: "Batch",
    configuration: { schemaVersion: 1, runKind: "batch", parameters: {}, sampling: { kind: "single" } },
    createdAt: NOW,
  });
  store.databaseForTesting().prepare("UPDATE projects SET lifecycle_state = 'archived' WHERE id = ?")
    .run(project.id);
  assert.throws(() => store.updateProjectWorkspace({
    projectId: project.id,
    expectedWorkspaceDigest: project.workspaceDigest,
    changes: [{
      id: "archived_file", kind: "project_artifact", relativePath: "notes.txt",
      mediaType: "text/plain", bytes: Buffer.from("blocked\n"),
    }],
    updatedAt: LATER,
  }), (error: unknown) => error instanceof ProjectOnlyStoreError && error.code === "project_not_writable");
  assert.throws(() => store.startRun({
    id: "run_archived",
    projectId: project.id,
    experimentConfigurationId: "experiment_archived",
    runKind: "batch",
    expectedWorkspaceDigest: project.workspaceDigest,
    createdAt: LATER,
  }), (error: unknown) => error instanceof ProjectOnlyStoreError && error.code === "project_not_writable");
});

test("template versions remain immutable and Project artifacts are independent copies", (t) => {
  const root = mkdtempSync(join(tmpdir(), "riff-project-template-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = ProjectOnlyStore.open(join(root, ".riff-product"));
  t.after(() => store.close());
  const template = {
    id: "template_alpha", version: "1", description: "Seed", runMode: "batch" as const,
    executionDescription: EXECUTION, defaultExperiment: { seed: 1 }, createdAt: NOW,
    files: [{
      id: "template_file_alpha", kind: "project_artifact" as const,
      relativePath: "notes/readme.custom", mediaType: "text/plain", bytes: Buffer.from("template\n"),
    }],
  };
  const first = store.createTemplateVersion(template);
  assert.deepEqual(store.createTemplateVersion(template), first);
  assert.throws(() => store.createTemplateVersion({
    ...template,
    files: [{ ...template.files[0]!, bytes: Buffer.from("different\n") }],
  }), (error: unknown) => error instanceof ProjectOnlyStoreError && error.code === "template_version_immutable");
  const copied = store.createProject({
    id: "project_copy", name: "Copy",
    source: { kind: "template", templateId: template.id, version: template.version }, createdAt: NOW,
  });
  assert.equal(store.projectFiles(copied.id)[0]?.bytes.toString("utf8"), "template\n");
});

test("restart reconciliation terminalizes only orphaned Runs and releases their lock", (t) => {
  const root = mkdtempSync(join(tmpdir(), "riff-project-reconcile-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = ProjectOnlyStore.open(join(root, ".riff-product"));
  t.after(() => store.close());
  const project = store.createProject({
    id: "project_alpha", name: "Alpha",
    source: { kind: "import", importDigest: "a".repeat(64), files: [{
      id: "project_file_alpha", kind: "project_code", relativePath: "model.py",
      mediaType: "text/x-python", bytes: Buffer.from("print('ok')\n"),
    }] },
    runMode: "batch", executionDescription: EXECUTION, createdAt: NOW,
  });
  store.createExperiment({
    id: "experiment_alpha", projectId: project.id, name: "Batch",
    configuration: { schemaVersion: 1, runKind: "batch", parameters: {}, sampling: { kind: "single" } },
    createdAt: NOW,
  });
  store.startRun({
    id: "run_alpha", projectId: project.id, experimentConfigurationId: "experiment_alpha",
    runKind: "batch", expectedWorkspaceDigest: project.workspaceDigest, createdAt: NOW,
  });
  assert.deepEqual(store.reconcileInterruptedExecutions(LATER), { runs: 1 });
  assert.equal(store.project(project.id).executionLock, null);
  assert.equal(store.run("run_alpha").status, "interrupted");
});
