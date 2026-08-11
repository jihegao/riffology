import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProjectOnlyStore } from "../src/project-only-store.ts";

const NOW = "2026-08-04T03:00:00.000Z";
const LATER = "2026-08-04T03:01:00.000Z";

test("schema v3 to v4 preserves Project, files, Conversation, Experiment, Run, Output, and receipts", (t) => {
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
  assert.equal(migrated.prepare("PRAGMA user_version").get()!.user_version, 4);
  const tables = migrated.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  ).all() as Array<{ name: string }>;
  assert.equal(tables.some(({ name }) => name === "project_technical_checks"), false);
  const projectColumns = migrated.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>;
  assert.equal(projectColumns.some(({ name }) => name === "technical_status"), false);
  assert.equal(migrated.prepare("PRAGMA foreign_key_check").get(), undefined);
  assert.equal(migrated.prepare("PRAGMA quick_check").get()!.quick_check, "ok");
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
