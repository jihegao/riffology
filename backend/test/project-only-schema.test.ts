import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProjectOnlyStore } from "../src/project-only-store.ts";

const NOW = "2026-08-04T03:00:00.000Z";
const LATER = "2026-08-04T03:01:00.000Z";

test("schema v3 to v5 preserves Project, files, Conversation, Experiment, Run, Output, and receipts", (t) => {
  const root = mkdtempSync(join(tmpdir(), "riff-project-schema-v4-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const storeRoot = join(root, ".riff-product");
  let store = ProjectOnlyStore.open(storeRoot);
  const created = store.createProjectWithConversation({
    commandId: "command_create",
    project: {
      id: "project_alpha",
      name: "Alpha",
      source: {
        kind: "import",
        importDigest: "a".repeat(64),
        files: [{
          id: "project_file_alpha",
          kind: "project_code",
          relativePath: "code/model.py",
          mediaType: "text/x-python",
          bytes: Buffer.from("print('ok')\n"),
        }],
      },
      runMode: "batch",
      executionDescription: { schemaVersion: 2, runMode: "batch" },
      createdAt: NOW,
    },
    conversation: {
      id: "conversation_alpha",
      name: "Main",
      providerId: "provider",
      modelId: "model",
    },
  });
  store.createExperiment({
    id: "experiment_alpha",
    projectId: created.project.id,
    name: "Batch",
    configuration: { schemaVersion: 1, runKind: "batch", parameters: {}, sampling: { kind: "single", seed: 1 } },
    createdAt: NOW,
  });
  store.startRun({
    id: "run_alpha",
    projectId: created.project.id,
    experimentConfigurationId: "experiment_alpha",
    runKind: "batch",
    expectedWorkspaceDigest: created.project.workspaceDigest,
    createdAt: NOW,
  });
  store.transitionRun({ id: "run_alpha", status: "running", at: NOW });
  store.commitBatchRunResult({
    runId: "run_alpha",
    status: "succeeded",
    terminalCode: "ok",
    outputs: [{
      id: "output_alpha",
      sampleIndex: 0,
      sampleId: "d".repeat(64),
      logicalName: "summary",
      relativePath: "summary.json",
      mediaType: "application/json",
      declaredRole: "data",
      bytes: Buffer.from('{"ok":true}\n'),
    }],
    completion: { schemaVersion: 1, status: "succeeded", code: "ok" },
    finishedAt: LATER,
  });
  store.recordDeliveryReceipt({
    commandId: "command_receipt",
    projectId: created.project.id,
    intentDigest: "b".repeat(64),
    response: { state: "committed" },
    receiptDigest: "c".repeat(64),
    committedAt: LATER,
  });
  const before = snapshot(store);
  const database = store.databaseForTesting();
  database.exec(`
    ALTER TABLE projects ADD COLUMN technical_status TEXT NOT NULL DEFAULT 'executable'
      CHECK (technical_status IN ('draft', 'checking', 'executable', 'failed'));
    CREATE TABLE project_technical_checks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      state TEXT NOT NULL
    ) STRICT;
    INSERT INTO project_technical_checks (id, project_id, state)
      VALUES ('technical_old', 'project_alpha', 'passed');
    ALTER TABLE project_only_schema RENAME TO project_only_schema_v4_fixture;
    CREATE TABLE project_only_schema (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      version INTEGER NOT NULL CHECK (version = 3),
      installed_at TEXT NOT NULL
    ) STRICT;
    INSERT INTO project_only_schema (singleton, version, installed_at)
      SELECT singleton, 3, installed_at FROM project_only_schema_v4_fixture;
    DROP TABLE project_only_schema_v4_fixture;
    PRAGMA user_version = 3;
  `);
  store.close();

  store = ProjectOnlyStore.open(storeRoot);
  t.after(() => store.close());
  assert.deepEqual(snapshot(store), before);
  const migrated = store.databaseForTesting();
  assert.equal(migrated.prepare("PRAGMA user_version").get()!.user_version, 5);
  const tables = migrated.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  ).all() as Array<{ name: string }>;
  assert.equal(tables.some(({ name }) => name === "project_technical_checks"), false);
  const projectColumns = migrated.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>;
  assert.equal(projectColumns.some(({ name }) => name === "technical_status"), false);
  assert.equal(migrated.prepare("PRAGMA foreign_key_check").get(), undefined);
  assert.equal(migrated.prepare("PRAGMA quick_check").get()!.quick_check, "ok");
});

test("schema v4 to v5 preserves existing outputs and accepts metric and table roles", (t) => {
  const root = mkdtempSync(join(tmpdir(), "riff-project-schema-v5-output-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const storeRoot = join(root, ".riff-product");
  let store = ProjectOnlyStore.open(storeRoot);
  const project = store.createProject({
    id: "project_roles",
    name: "Roles",
    source: { kind: "blank" },
    runMode: "batch",
    executionDescription: { schemaVersion: 2, runMode: "batch" },
    createdAt: NOW,
  });
  store.createExperiment({
    id: "experiment_roles",
    projectId: project.id,
    name: "Roles",
    configuration: { schemaVersion: 1, runKind: "batch", parameters: {}, sampling: { kind: "single", seed: 1 } },
    createdAt: NOW,
  });
  store.startRun({
    id: "run_existing",
    projectId: project.id,
    experimentConfigurationId: "experiment_roles",
    runKind: "batch",
    expectedWorkspaceDigest: project.workspaceDigest,
    createdAt: NOW,
  });
  store.commitBatchRunResult({
    runId: "run_existing",
    status: "succeeded",
    terminalCode: "ok",
    outputs: [{
      id: "output_existing",
      sampleIndex: 0,
      sampleId: "a".repeat(64),
      logicalName: "existing",
      relativePath: "existing.json",
      mediaType: "application/json",
      declaredRole: "data",
      bytes: Buffer.from('{"existing":true}\n'),
    }],
    completion: { schemaVersion: 1, status: "succeeded", code: "ok" },
    finishedAt: LATER,
  });

  const database = store.databaseForTesting();
  database.exec(`
    ALTER TABLE run_outputs RENAME TO run_outputs_v5_fixture;
    CREATE TABLE run_outputs (
      id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 3 AND 128),
      run_id TEXT NOT NULL REFERENCES runs(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
      sample_index INTEGER NOT NULL CHECK (sample_index >= 0),
      sample_id TEXT NOT NULL CHECK (length(sample_id) = 64 AND sample_id NOT GLOB '*[^0-9a-f]*'),
      logical_name TEXT NOT NULL CHECK (length(trim(logical_name)) BETWEEN 1 AND 200),
      relative_path TEXT NOT NULL CHECK (length(trim(relative_path)) BETWEEN 1 AND 1024),
      media_type TEXT NOT NULL CHECK (length(trim(media_type)) BETWEEN 1 AND 200),
      declared_role TEXT NOT NULL CHECK (declared_role IN ('data', 'diagnostic', 'replay', 'visual', 'document')),
      bytes BLOB NOT NULL,
      size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0 AND size_bytes = length(bytes)),
      sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
      created_at TEXT NOT NULL,
      UNIQUE (run_id, sample_index, logical_name)
    ) STRICT;
    INSERT INTO run_outputs
      (id, run_id, sample_index, sample_id, logical_name, relative_path, media_type,
        declared_role, bytes, size_bytes, sha256, created_at)
      SELECT id, run_id, sample_index, sample_id, logical_name, relative_path, media_type,
        declared_role, bytes, size_bytes, sha256, created_at
      FROM run_outputs_v5_fixture;
    DROP TABLE run_outputs_v5_fixture;
    ALTER TABLE project_only_schema RENAME TO project_only_schema_v5_fixture;
    CREATE TABLE project_only_schema (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      version INTEGER NOT NULL CHECK (version = 4),
      installed_at TEXT NOT NULL
    ) STRICT;
    INSERT INTO project_only_schema (singleton, version, installed_at)
      SELECT singleton, 4, installed_at FROM project_only_schema_v5_fixture;
    DROP TABLE project_only_schema_v5_fixture;
    PRAGMA user_version = 4;
  `);
  store.close();

  store = ProjectOnlyStore.open(storeRoot);
  t.after(() => store.close());
  assert.equal(store.databaseForTesting().prepare("PRAGMA user_version").get()!.user_version, 5);
  assert.equal(store.runOutputs("run_existing")[0]?.declaredRole, "data");
  store.startRun({
    id: "run_roles",
    projectId: project.id,
    experimentConfigurationId: "experiment_roles",
    runKind: "batch",
    expectedWorkspaceDigest: project.workspaceDigest,
    createdAt: LATER,
  });
  store.commitBatchRunResult({
    runId: "run_roles",
    status: "succeeded",
    terminalCode: "ok",
    outputs: [{
      id: "output_metric",
      sampleIndex: 0,
      sampleId: "b".repeat(64),
      logicalName: "metrics",
      relativePath: "metrics.json",
      mediaType: "application/json",
      declaredRole: "metric",
      bytes: Buffer.from('{"value":1}\n'),
    }, {
      id: "output_table",
      sampleIndex: 0,
      sampleId: "b".repeat(64),
      logicalName: "table",
      relativePath: "table.csv",
      mediaType: "text/csv",
      declaredRole: "table",
      bytes: Buffer.from("value\n1\n"),
    }],
    completion: { schemaVersion: 1, status: "succeeded", code: "ok" },
    finishedAt: LATER,
  });
  assert.deepEqual(store.runOutputs("run_roles").map((output) => output.declaredRole), ["metric", "table"]);
  const outputSql = String((store.databaseForTesting().prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'run_outputs'",
  ).get() as any).sql);
  assert.match(outputSql, /'metric'/u);
  assert.match(outputSql, /'table'/u);
  assert.equal(store.databaseForTesting().prepare("PRAGMA foreign_key_check").get(), undefined);
  assert.equal(store.databaseForTesting().prepare("PRAGMA quick_check").get()!.quick_check, "ok");
});

const snapshot = (store: ProjectOnlyStore) => ({
  project: store.project("project_alpha"),
  files: store.projectFiles("project_alpha"),
  conversations: store.conversations("project_alpha"),
  experiments: store.experiments("project_alpha"),
  runs: store.runs("project_alpha"),
  outputs: store.runOutputs("run_alpha"),
  completion: store.runCompletion("run_alpha"),
  receipt: store.deliveryReceipt("command_receipt"),
});
