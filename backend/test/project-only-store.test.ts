import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProjectOnlyStore, ProjectOnlyStoreError } from "../src/project-only-store.ts";

const NOW = "2026-08-04T04:00:00.000Z";
const LATER = "2026-08-04T04:01:00.000Z";
const EXECUTION = Object.freeze({ schemaVersion: 2, batch: { entrypoint: "model.py" } });

test("fresh Project-only Store contains no Model table or owner columns", (t) => {
  const root = mkdtempSync(join(tmpdir(), "riff-project-only-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = ProjectOnlyStore.open(join(root, ".riff-product"));
  t.after(() => store.close());
  const database = store.databaseForTesting();
  const tables = (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map(({ name }) => name);
  assert.equal(tables.includes("models"), false);
  assert.equal(tables.includes("projects"), true);
  for (const table of tables) {
    const columns = (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(({ name }) => name);
    assert.equal(columns.some((name) => /model_id|source_model|model_snapshot/u.test(name)), false, table);
  }
});

test("Project workspace status, technical lock, one active Run, and non-retained source are enforced", (t) => {
  const root = mkdtempSync(join(tmpdir(), "riff-project-lock-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = ProjectOnlyStore.open(join(root, ".riff-product"));
  t.after(() => store.close());
  let project = store.createProject({
    id: "project_alpha",
    name: "Alpha",
    source: { kind: "import", importDigest: "a".repeat(64), files: [{
      id: "project_file_alpha", kind: "project_code", relativePath: "model.py",
      mediaType: "text/x-python", bytes: Buffer.from("print('ok')\n"),
    }] },
    runMode: "both",
    executionDescription: EXECUTION,
    createdAt: NOW,
  });
  assert.equal(project.technicalStatus, "draft");
  assert.match(project.workspaceDigest, /^[0-9a-f]{64}$/u);
  store.createExperiment({ id: "experiment_alpha", projectId: project.id, name: "Smoke", configuration: { seed: 1 }, createdAt: NOW });

  store.startTechnicalCheck({ id: "technical_alpha", projectId: project.id, expectedWorkspaceDigest: project.workspaceDigest, startedAt: NOW });
  assert.equal(store.project(project.id).executionLock?.holderKind, "technical_check");
  assert.throws(() => store.updateProjectWorkspace({
    projectId: project.id, expectedWorkspaceDigest: project.workspaceDigest, updatedAt: LATER,
    changes: [{ id: "project_file_alpha", kind: "project_code", relativePath: "model.py", mediaType: "text/x-python", bytes: Buffer.from("print('changed')\n") }],
  }), (error: unknown) => error instanceof ProjectOnlyStoreError && error.code === "project_execution_locked");
  store.updateExperiment({ id: "experiment_alpha", projectId: project.id, configuration: { seed: 2 }, updatedAt: LATER });
  project = store.finishTechnicalCheck({ id: "technical_alpha", succeeded: true, diagnostics: [], finishedAt: LATER });
  assert.equal(project.technicalStatus, "executable");
  assert.equal(project.executionLock, null);

  store.startRun({ id: "run_alpha", projectId: project.id, experimentConfigurationId: "experiment_alpha", runKind: "batch", expectedWorkspaceDigest: project.workspaceDigest, createdAt: LATER });
  assert.equal(store.project(project.id).executionLock?.holderId, "run_alpha");
  assert.throws(() => store.startRun({ id: "run_beta", projectId: project.id, experimentConfigurationId: "experiment_alpha", runKind: "visual", expectedWorkspaceDigest: project.workspaceDigest, createdAt: LATER }),
    (error: unknown) => error instanceof ProjectOnlyStoreError && error.code === "project_execution_locked");
  store.updateExperiment({ id: "experiment_alpha", projectId: project.id, configuration: { seed: 3 }, updatedAt: LATER });
  store.transitionRun({ id: "run_alpha", status: "running", at: LATER });
  store.transitionRun({ id: "run_alpha", status: "succeeded", at: LATER });
  assert.equal(store.project(project.id).executionLock, null);
  const run = store.databaseForTesting().prepare("SELECT source_files_retained, frozen_configuration_json FROM runs WHERE id = 'run_alpha'").get() as any;
  assert.equal(run.source_files_retained, 0);
  assert.deepEqual(JSON.parse(run.frozen_configuration_json), { seed: 2 });

  project = store.updateProjectWorkspace({
    projectId: project.id, expectedWorkspaceDigest: project.workspaceDigest, updatedAt: LATER,
    changes: [{ id: "project_file_alpha", kind: "project_code", relativePath: "model.py", mediaType: "text/x-python", bytes: Buffer.from("print('changed')\n") }],
  });
  assert.equal(project.technicalStatus, "draft");
  assert.notEqual(project.workspaceDigest, store.databaseForTesting().prepare("SELECT source_workspace_digest FROM runs WHERE id = 'run_alpha'").get()!.source_workspace_digest);
});

test("template versions are immutable and blank/template/import are explicit creation sources", (t) => {
  const root = mkdtempSync(join(tmpdir(), "riff-project-template-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = ProjectOnlyStore.open(join(root, ".riff-product"));
  t.after(() => store.close());
  const template = {
    id: "template_alpha", version: "1", description: "Seed", runMode: "batch" as const,
    executionDescription: EXECUTION, defaultExperiment: { seed: 1 }, createdAt: NOW,
    files: [{ id: "template_file_alpha", kind: "project_code" as const, relativePath: "model.py", mediaType: "text/x-python", bytes: Buffer.from("print('template')\n") }],
  };
  const first = store.createTemplateVersion(template);
  assert.deepEqual(store.createTemplateVersion(template), first);
  assert.throws(() => store.createTemplateVersion({ ...template, files: [{ ...template.files[0]!, bytes: Buffer.from("different\n") }] }),
    (error: unknown) => error instanceof ProjectOnlyStoreError && error.code === "template_version_immutable");
  const blank = store.createProject({ id: "project_blank", name: "Blank", source: { kind: "blank" }, createdAt: NOW });
  const copied = store.createProject({ id: "project_copy", name: "Copy", source: { kind: "template", templateId: template.id, version: template.version }, createdAt: NOW });
  assert.equal(blank.creationSource, "blank");
  assert.equal(copied.creationSource, "template");
  assert.equal(store.projectFiles(copied.id)[0]?.bytes.toString("utf8"), "print('template')\n");
});

test("restart reconciliation terminates orphaned execution and releases the durable lock", (t) => {
  const root = mkdtempSync(join(tmpdir(), "riff-project-reconcile-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = ProjectOnlyStore.open(join(root, ".riff-product"));
  t.after(() => store.close());
  const project = store.createProject({ id: "project_alpha", name: "Alpha", source: { kind: "blank" }, createdAt: NOW });
  store.startTechnicalCheck({ id: "technical_alpha", projectId: project.id, expectedWorkspaceDigest: project.workspaceDigest, startedAt: NOW });
  assert.deepEqual(store.reconcileInterruptedExecutions(LATER), { checks: 1, runs: 0 });
  assert.equal(store.project(project.id).executionLock, null);
  assert.equal(store.project(project.id).technicalStatus, "failed");
});
