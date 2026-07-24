import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalDigest } from "../src/canonical-json-v2.ts";
import { planExperiment } from "../src/experiment-planner.ts";
import { experimentConfigurationRecordDigest, ProductStoreV2 } from "../src/product-store-v2.ts";

const NOW = "2026-07-22T01:00:00.000Z";
const LATER = "2026-07-22T02:00:00.000Z";
const INPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: { seed: { type: "integer" } },
  required: [],
  additionalProperties: false,
};
const RUN_LIMITS = {
  schemaVersion: 1 as const,
  wallTimeMs: 60_000,
  startupTimeMs: 10_000,
  terminationGraceMs: 1_000,
  maxStdoutBytes: 100_000,
  maxStderrBytes: 100_000,
  maxOutputFiles: 10,
  maxOutputBytes: 1_000_000,
  maxEventCount: 1_000,
  maxEventBytes: 1_000_000,
  maxSamples: 10,
  maxConcurrency: 2,
};

test("fresh ProductStoreV2 atomically initializes and round-trips the complete Stage 1 graph", () => {
  const parent = mkdtempSync(join(tmpdir(), "riff-product-v2-"));
  const root = join(parent, "store");
  const sentinel = join(parent, "untracked-sentinel.txt");
  writeFileSync(sentinel, "do not touch");
  let store: ProductStoreV2 | undefined;
  try {
    assert.equal(existsSync(root), false);
    store = ProductStoreV2.open(root);
    assert.equal(existsSync(join(root, "product.sqlite3")), true);
    assert.throws(() => ProductStoreV2.open(root), /Another mutation writer/u);

    const model = store.createModel({
      id: "model_alpha",
      name: "Alpha",
      technicalStatus: "executable",
      runMode: "both",
      executionDescription: {
        schemaVersion: 2,
        runtime: "python",
        runMode: "batch",
        dependencyFile: "environment/requirements.txt",
        inputs: {
          schemaProfile: "riff-json-schema-2020-12-v1",
          schema: INPUT_SCHEMA,
          smoke: { seed: 7 },
        },
        outputs: [{
          logicalName: "result",
          relativePath: "outputs/result.json",
          mediaType: "application/json",
          required: true,
          role: "data",
        }],
        batch: { entryPoint: "code/model.py", protocol: "riff-batch-v1" },
        cancellation: { signal: "SIGTERM", graceMs: 1_000 },
      },
      createdAt: NOW,
      files: [
        { id: "file_model_code", kind: "model_code", relativePath: "model.py", mediaType: "text/x-python", bytes: Buffer.from("print('alpha')\n") },
        { id: "file_model_env", kind: "model_environment", relativePath: "requirements.txt", mediaType: "text/plain", bytes: Buffer.from("mesa==3\n") },
        { id: "file_model_visual", kind: "model_visual_asset", relativePath: "icon.svg", mediaType: "image/svg+xml", bytes: Buffer.from("<svg/>\n") },
      ],
    });
    assert.equal(model.technicalStatus, "executable");
    store.createConversation({ id: "conversation_model", owner: { kind: "model", id: model.id }, name: "Build", providerId: "provider", providerModelId: "model", createdAt: NOW });
    store.createMessage({ id: "message_model", conversationId: "conversation_model", ordinal: 0, role: "user", status: "complete", text: "Use this input", createdAt: NOW });
    store.createTemporaryDocument({ id: "document_model", conversationId: "conversation_model", sourceMessageId: "message_model", name: "Plan", documentState: "draft", mediaType: "text/markdown", content: "# Plan", createdAt: NOW });
    store.createAttachment({ id: "attachment_model", objectFileId: "file_attachment_model", conversationId: "conversation_model", relativePath: "input.csv", originalName: "input.csv", mediaType: "text/csv", purpose: "source", bytes: Buffer.from("x\n1\n"), createdAt: NOW });
    store.linkMessageAttachment("message_model", "attachment_model");
    store.adoptAttachment({ objectFileId: "file_adopted_model", owner: { kind: "model", id: model.id }, sourceAttachmentId: "attachment_model", relativePath: "input.csv", purpose: "model calibration input", createdAt: NOW });

    const project = store.createProjectFromModel({ projectId: "project_alpha", projectName: "Project Alpha", sourceModelId: model.id, createdAt: NOW });
    const projectAgain = store.createProjectFromModel({ projectId: "project_beta", projectName: "Project Beta", sourceModelId: model.id, createdAt: NOW });
    assert.equal(project.modelSnapshotDigest, projectAgain.modelSnapshotDigest);
    assert.deepEqual(project.executionDescription, model.executionDescription);
    const snapshotRows = store.listObjectFiles({ kind: "project", id: project.id }).filter((row) => row.kind === "project_model_snapshot");
    assert.deepEqual(snapshotRows.map((row) => row.relativePath), [
      "model-snapshot/attachments/input.csv",
      "model-snapshot/code/model.py",
      "model-snapshot/environment/requirements.txt",
      "model-snapshot/visuals/icon.svg",
    ]);
    const frozenCode = store.readObjectFile(snapshotRows.find((row) => row.relativePath.endsWith("code/model.py"))!.id);
    const changedSource = Buffer.from("print('changed source')\n");
    store.replaceModelFile("file_model_code", changedSource, LATER);
    assert.equal(store.readObjectFile("file_model_code").equals(changedSource), true);
    assert.equal(store.readObjectFile(snapshotRows.find((row) => row.relativePath.endsWith("code/model.py"))!.id).equals(frozenCode), true);

    store.createConversation({ id: "conversation_project", owner: { kind: "project", id: project.id }, name: "Analyze", providerId: "provider", providerModelId: "model", createdAt: NOW });
    store.createMessage({ id: "message_project", conversationId: "conversation_project", ordinal: 0, role: "assistant", status: "complete", text: "Ready", content: { ok: true }, createdAt: NOW });
    const basePlan = planExperiment({ configuration: {
      schemaVersion: 1, runKind: "batch", parameters: { seed: 7 }, sampling: { kind: "single" },
    }, inputSchema: INPUT_SCHEMA, maxSamples: RUN_LIMITS.maxSamples });
    const createdExperiment = store.createExperimentV4({
      commandId: "command_create_experiment_alpha",
      id: "experiment_alpha",
      projectId: project.id,
      name: "Base",
      plan: basePlan,
      createdAt: NOW,
    });
    assert.throws(() => store.createExperimentV4({ commandId: "command_create_experiment_alpha", id: "experiment_alpha", projectId: project.id, name: "Changed", plan: basePlan, createdAt: NOW }), /different intent/u);
    const updatedPlan = planExperiment({ configuration: {
      schemaVersion: 1, runKind: "batch", parameters: {}, sampling: { kind: "multiple-seeds", seeds: [1, 2] },
    }, inputSchema: INPUT_SCHEMA, maxSamples: RUN_LIMITS.maxSamples });
    const renamed = store.updateExperimentV4({ commandId: "command_update_experiment_alpha", id: "experiment_alpha", projectId: project.id,
      name: "Renamed", expectedConfigurationDigest: basePlan.configurationDigest,
      expectedRecordDigest: experimentConfigurationRecordDigest(createdExperiment),
      configuration: updatedPlan.configuration, plan: updatedPlan, updatedAt: LATER });
    assert.equal(renamed.name, "Renamed");
    assert.equal(renamed.estimatedSampleCount, 2);
    assert.equal(store.updateExperimentV4({ commandId: "command_update_experiment_alpha", id: "experiment_alpha", projectId: project.id,
      name: "Renamed", expectedConfigurationDigest: basePlan.configurationDigest,
      expectedRecordDigest: experimentConfigurationRecordDigest(createdExperiment),
      configuration: updatedPlan.configuration, plan: updatedPlan, updatedAt: LATER }).sampleCount, 2);
    assert.throws(() => store.updateExperimentV4({ commandId: "command_update_experiment_alpha", id: "experiment_alpha", projectId: project.id,
      name: "Other", expectedConfigurationDigest: updatedPlan.configurationDigest,
      expectedRecordDigest: experimentConfigurationRecordDigest(renamed),
      configuration: basePlan.configuration, plan: basePlan, updatedAt: LATER }), /different intent/u);
    store.createFrozenRun({
      commandId: "command_start_run_alpha",
      runId: "run_alpha",
      projectId: project.id,
      experimentConfigId: "experiment_alpha",
      completionConversationId: "conversation_project",
      expectedConfigurationDigest: updatedPlan.configurationDigest,
      plan: updatedPlan,
      projectSnapshotDigest: project.modelSnapshotDigest,
      executionDescriptionDigest: canonicalDigest(project.executionDescription),
      limits: RUN_LIMITS,
      createdAt: NOW,
    });
    assert.deepEqual(store.listExperimentConfigurations(project.id).map((item) => item.id), ["experiment_alpha"]);
    assert.deepEqual(store.listRuns(project.id).map((item) => item.id), ["run_alpha"]);
    assert.deepEqual(store.listRunOutputs("run_alpha"), []);

    store.renameResource("temporary_document", "document_model", "Updated plan", LATER);
    store.archiveResource("experiment", "experiment_alpha", LATER);
    store.restoreResource("experiment", "experiment_alpha", LATER);
    assert.throws(() => store.trashResource("run", "run_alpha", LATER), /Product database mutation failed/u);
    store.archiveResource("model", model.id, LATER);
    assert.throws(() => store.createProjectFromModel({ projectId: "project_gamma", projectName: "Rejected", sourceModelId: model.id, createdAt: LATER }), /not active and technically executable/u);
    store.trashResource("model", model.id, LATER);
    assert.throws(() => store.archiveResource("model", model.id, LATER), /unexpected number of rows/u);
    assert.equal(store.readObjectFile(snapshotRows.find((row) => row.relativePath.endsWith("code/model.py"))!.id).equals(frozenCode), true);
    assert.equal(store.listModels({ includeTrashed: true })[0]!.lifecycleState, "trashed");
    assert.equal(store.listProjects().length, 2);
    store.close();
    store = undefined;

    const reopened = ProductStoreV2.open(root);
    store = reopened;
    const recordTables = new Set([
      ...reopened.previewPermanentDelete("model", "model_alpha").records,
      ...reopened.previewPermanentDelete("project", "project_alpha").records,
    ].map((record) => record.table));
    for (const table of ["models", "projects", "conversations", "messages", "temporary_documents", "attachments", "message_attachments", "experiment_configurations", "runs", "trash_entries"]) assert.equal(recordTables.has(table), true, table);
    assert.equal(reopened.listObjectFiles({ kind: "project", id: "project_alpha" }).length > 0, true);
    assert.equal(reopened.readObjectFile(snapshotRows.find((row) => row.relativePath.endsWith("code/model.py"))!.id).equals(frozenCode), true);
    assert.equal(readFileSync(sentinel, "utf8"), "do not touch");
  } finally {
    store?.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("child creation guards reject trashed parents and trashed attachment sources", () => {
  const parent = mkdtempSync(join(tmpdir(), "riff-product-guards-"));
  const store = ProductStoreV2.open(join(parent, "store"));
  try {
    store.createModel({ id: "model_guard", name: "Guard", technicalStatus: "executable", runMode: "batch", executionDescription: {}, createdAt: NOW,
      files: [{ id: "file_guard", kind: "model_code", relativePath: "model.py", mediaType: "text/plain", bytes: Buffer.from("x") }] });
    store.createConversation({ id: "conversation_guard", owner: { kind: "model", id: "model_guard" }, name: "Guard", providerId: "p", providerModelId: "m", createdAt: NOW });
    store.createAttachment({ id: "attachment_guard", objectFileId: "file_attachment_guard", conversationId: "conversation_guard", relativePath: "x.txt", originalName: "x.txt", mediaType: "text/plain", bytes: Buffer.from("x"), createdAt: NOW });
    store.trashResource("conversation", "conversation_guard", LATER);
    assert.throws(() => store.adoptAttachment({ objectFileId: "file_adopt_rejected", owner: { kind: "model", id: "model_guard" }, sourceAttachmentId: "attachment_guard", relativePath: "x.txt", purpose: "input", createdAt: LATER }), /unexpected number of rows/u);

    store.createProjectFromModel({ projectId: "project_guard", projectName: "Guard", sourceModelId: "model_guard", createdAt: NOW });
    store.trashResource("project", "project_guard", LATER);
    const rejectedPlan = planExperiment({ configuration: {
      schemaVersion: 1, runKind: "batch", parameters: {}, sampling: { kind: "single" },
    }, inputSchema: INPUT_SCHEMA, maxSamples: RUN_LIMITS.maxSamples });
    assert.throws(() => store.createExperimentV4({ commandId: "command_rejected_experiment", id: "experiment_rejected",
      projectId: "project_guard", name: "No", plan: rejectedPlan, createdAt: LATER }), /unexpected number of rows/u);
  } finally { store.close(); rmSync(parent, { recursive: true, force: true }); }
});
