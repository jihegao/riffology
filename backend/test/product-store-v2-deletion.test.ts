import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalDigest } from "../src/canonical-json-v2.ts";
import { planExperiment } from "../src/experiment-planner.ts";
import { ProductStoreV2, type RunLimitsV1 } from "../src/product-store-v2.ts";
import { openProductDatabase } from "../src/product-schema.ts";

const NOW = "2026-07-22T04:00:00.000Z";
const INPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: { seed: { type: "integer" } },
  required: ["seed"],
  additionalProperties: false,
};
const LIMITS: RunLimitsV1 = {
  schemaVersion: 1,
  wallTimeMs: 60_000,
  startupTimeMs: 10_000,
  terminationGraceMs: 1_000,
  maxStdoutBytes: 100_000,
  maxStderrBytes: 100_000,
  maxOutputFiles: 10,
  maxOutputBytes: 1_000_000,
  maxEventCount: 1_000,
  maxEventBytes: 1_000_000,
  maxSamples: 1,
  maxConcurrency: 1,
};

const fixture = (): { parent: string; store: ProductStoreV2 } => {
  const parent = mkdtempSync(join(tmpdir(), "riff-product-preview-"));
  let store = ProductStoreV2.open(join(parent, "store"));
  store.createModel({
    id: "model_alpha", name: "Alpha", technicalStatus: "executable", runMode: "batch",
    executionDescription: {
      schemaVersion: 2,
      runtime: "python",
      runMode: "batch",
      dependencyFile: "environment/requirements.txt",
      inputs: {
        schemaProfile: "riff-json-schema-2020-12-v1",
        schema: INPUT_SCHEMA,
        smoke: { seed: 1 },
      },
      outputs: [{
        logicalName: "result.csv",
        relativePath: "outputs/result.csv",
        mediaType: "text/csv",
        required: true,
        role: "table",
      }],
      batch: { entryPoint: "code/model.py", protocol: "riff-batch-v1" },
      cancellation: { signal: "SIGTERM", graceMs: 1_000 },
    },
    createdAt: NOW,
    files: [{ id: "file_model", kind: "model_code", relativePath: "model.py", mediaType: "text/x-python", bytes: Buffer.from("print('alpha')\n") }],
  });
  store.createConversation({ id: "conversation_model", owner: { kind: "model", id: "model_alpha" }, name: "Build", providerId: "provider", providerModelId: "model", createdAt: NOW });
  store.createMessage({ id: "message_model", conversationId: "conversation_model", ordinal: 0, role: "user", status: "complete", text: "input", createdAt: NOW });
  store.createTemporaryDocument({ id: "document_model", conversationId: "conversation_model", sourceMessageId: "message_model", name: "Plan", documentState: "draft", mediaType: "text/markdown", content: "# Plan", createdAt: NOW });
  store.createAttachment({ id: "attachment_model", objectFileId: "file_attachment", conversationId: "conversation_model", relativePath: "input.csv", originalName: "input.csv", mediaType: "text/csv", bytes: Buffer.from("x\n1\n"), createdAt: NOW });
  store.linkMessageAttachment("message_model", "attachment_model");
  store.adoptAttachment({ objectFileId: "file_adopted", owner: { kind: "model", id: "model_alpha" }, sourceAttachmentId: "attachment_model", relativePath: "input.csv", purpose: "calibration", createdAt: NOW });
  const project = store.createProjectFromModel({ projectId: "project_alpha", projectName: "Project", sourceModelId: "model_alpha", createdAt: NOW });
  store.createConversation({ id: "conversation_project", owner: { kind: "project", id: "project_alpha" }, name: "Analyze", providerId: "provider", providerModelId: "model", createdAt: NOW });
  const plan = planExperiment({
    configuration: { schemaVersion: 1, runKind: "batch", parameters: { seed: 1 }, sampling: { kind: "single" } },
    inputSchema: INPUT_SCHEMA,
    maxSamples: LIMITS.maxSamples,
  });
  store.createExperimentV4({ commandId: "command_create_preview", id: "experiment_alpha", projectId: "project_alpha", name: "Base", plan, createdAt: NOW });
  store.createFrozenRun({
    commandId: "command_start_preview",
    runId: "run_alpha",
    projectId: "project_alpha",
    experimentConfigId: "experiment_alpha",
    completionConversationId: "conversation_project",
    expectedConfigurationDigest: plan.configurationDigest,
    plan,
    projectSnapshotDigest: project.modelSnapshotDigest,
    executionDescriptionDigest: canonicalDigest(project.executionDescription),
    limits: LIMITS,
    createdAt: NOW,
  });
  store.close();
  const database = openProductDatabase(join(parent, "store", "product.sqlite3"));
  database.prepare(`INSERT INTO run_attempts
    (id, run_id, attempt_generation, dispatcher_generation, state, claimed_at, lease_expires_at)
    VALUES ('attempt_preview', 'run_alpha', 1, ?, 'claimed', ?, ?)`
  ).run("a".repeat(64), NOW, NOW);
  database.prepare(`INSERT INTO process_attempts
    (id, run_attempt_id, process_kind, sample_index, sample_id, pid, process_start_token,
      process_group_id, launch_gate_state, state, launched_at)
    VALUES ('process_preview', 'attempt_preview', 'batch', 0, ?, 101, 'start-101', 101, 'blocked', 'blocked', ?)`
  ).run(plan.samples[0]!.sampleId, NOW);
  database.prepare("UPDATE process_attempts SET launch_gate_state = 'timed_out' WHERE id = 'process_preview'").run();
  database.prepare("UPDATE process_attempts SET state = 'exited', exited_at = ? WHERE id = 'process_preview'").run(NOW);
  database.prepare("UPDATE process_attempts SET state = 'cleanup_complete', cleanup_receipt_sha256 = ? WHERE id = 'process_preview'")
    .run("b".repeat(64));
  database.prepare("UPDATE run_attempts SET state = 'interrupted', finished_at = ? WHERE id = 'attempt_preview'").run(NOW);
  database.prepare("UPDATE runs SET status = 'running', started_at = ?, updated_at = ? WHERE id = 'run_alpha' AND status = 'queued'").run(NOW, NOW);
  database.prepare("UPDATE runs SET status = 'succeeded', finished_at = ?, updated_at = ? WHERE id = 'run_alpha' AND status = 'running'").run(NOW, NOW);
  database.close();
  store = ProductStoreV2.open(join(parent, "store"));
  store.createOutput({
    id: "output_alpha",
    objectFileId: "file_output",
    runId: "run_alpha",
    relativePath: "result.csv",
    logicalName: "result.csv",
    outputType: "table",
    sampleIndex: plan.samples[0]!.sampleIndex,
    sampleId: plan.samples[0]!.sampleId,
    declaredRole: "table",
    mediaType: "text/csv",
    bytes: Buffer.from("metric\n1\n"),
    createdAt: NOW,
  });
  return { parent, store };
};

test("permanent-delete previews are deterministic exact closures with composite keys, blockers, and exclusions", () => {
  const { parent, store } = fixture();
  try {
    const model = store.previewPermanentDelete("model", "model_alpha");
    assert.deepEqual(store.previewPermanentDelete("model", "model_alpha"), model);
    assert.equal(model.previewToken.length, 64);
    assert.equal(model.stateToken.length, 64);
    assert.equal(model.totalBytes, model.files.reduce((sum, file) => sum + file.sizeBytes, 0));
    assert.ok(model.blockingReferences.some((item) => item.kind === "project_lineage" && item.id === "project_alpha"));
    assert.ok(model.records.some((item) => item.table === "message_attachments"
      && item.key.message_id === "message_model" && item.key.attachment_id === "attachment_model"));
    assert.ok(model.records.some((item) => item.table === "object_files" && item.key.id === "file_model"));

    const project = store.previewPermanentDelete("project", "project_alpha");
    assert.ok(project.records.some((item) => item.table === "runs" && item.key.id === "run_alpha"));
    assert.ok(project.records.some((item) => item.table === "output_indexes" && item.key.id === "output_alpha"));
    for (const [table, key, id] of [
      ["experiment_command_receipts", "command_id", "command_create_preview"],
      ["run_commands", "id", "command_start_preview"],
      ["run_command_receipts", "id", `receipt_${canonicalDigest("command_start_preview").slice(0, 32)}`],
      ["run_attempts", "id", "attempt_preview"],
      ["process_attempts", "id", "process_preview"],
    ] as const) {
      assert.ok(project.records.some((item) => item.table === table && item.key[key] === id), `${table} is in the Project purge closure`);
    }
    assert.ok(project.exclusions.some((item) => item.kind === "model" && item.id === "model_alpha"));

    const conversation = store.previewPermanentDelete("conversation", "conversation_model");
    assert.ok(conversation.blockingReferences.some((item) => item.kind === "adopted_attachment" && item.id === "file_adopted"));
    assert.ok(conversation.exclusions.some((item) => item.id === "file_adopted"));
    assert.equal(conversation.files.some((file) => file.id === "file_adopted"), false);
    const completionConversation = store.previewPermanentDelete("conversation", "conversation_project");
    assert.ok(completionConversation.blockingReferences.some((item) =>
      item.kind === "run_completion_conversation" && item.id === "run_alpha"));

    const document = store.previewPermanentDelete("temporary_document", "document_model");
    assert.deepEqual(document.records.map((item) => item.table), ["temporary_documents"]);
    assert.ok(document.exclusions.some((item) => item.kind === "conversation"));

    const experiment = store.previewPermanentDelete("experiment", "experiment_alpha");
    assert.deepEqual(experiment.blockingReferences, [{ kind: "run", id: "run_alpha" }]);
    assert.ok(experiment.records.some((item) => item.table === "experiment_command_receipts"
      && item.key.command_id === "command_create_preview"));
    assert.ok(experiment.exclusions.some((item) => item.kind === "project"));

    store.trashResource("run", "run_alpha", NOW);
    const run = store.previewPermanentDelete("run", "run_alpha");
    assert.ok(run.records.some((item) => item.table === "trash_entries"));
    assert.ok(run.records.some((item) => item.table === "output_indexes"));
    assert.ok(run.records.some((item) => item.table === "run_commands" && item.key.id === "command_start_preview"));
    assert.ok(run.records.some((item) => item.table === "run_command_receipts"));
    assert.ok(run.records.some((item) => item.table === "run_attempts" && item.key.id === "attempt_preview"));
    assert.ok(run.records.some((item) => item.table === "process_attempts" && item.key.id === "process_preview"));
    assert.ok(run.exclusions.some((item) => item.kind === "experiment"));
    assert.equal(store.listModels({ includeArchived: true, includeTrashed: true }).length, 1, "preview never purges");
    const snapshot = store.listObjectFiles({ kind: "project", id: "project_alpha" }).find((file) => file.kind === "project_model_snapshot")!;
    writeFileSync(join(store.root, "objects/projects/project_alpha", snapshot.relativePath), "corrupt snapshot");
    assert.throws(() => store.createProjectFromModel({ projectId: "project_alpha", projectName: "Project", sourceModelId: "model_alpha", createdAt: NOW }), /drift/u);
  } finally { store.close(); rmSync(parent, { recursive: true, force: true }); }
});

test("preview fails closed on digest drift, symlinks, and owner/path mismatches without touching an outside sentinel", () => {
  for (const mode of ["digest", "symlink", "owner", "unsafe_total"] as const) {
    const created = fixture();
    const { parent } = created;
    let store = created.store;
    const outside = join(parent, "outside.txt");
    writeFileSync(outside, "sentinel");
    try {
      if (mode === "digest") {
        writeFileSync(join(store.root, "objects/models/model_alpha/code/model.py"), "changed");
        assert.throws(() => store.previewPermanentDelete("model", "model_alpha"), /digest drift/u);
        assert.throws(() => store.createModel({ id: "model_alpha", name: "Alpha", technicalStatus: "executable", runMode: "batch", executionDescription: { entryPoint: "model.py" }, createdAt: NOW,
          files: [{ id: "file_model", kind: "model_code", relativePath: "model.py", mediaType: "text/x-python", bytes: Buffer.from("print('alpha')\n") }] }), /drift/u);
      } else if (mode === "symlink") {
        const target = join(store.root, "objects/models/model_alpha/code/model.py");
        unlinkSync(target);
        symlinkSync(outside, target);
        assert.throws(() => store.previewPermanentDelete("model", "model_alpha"), /symlink/u);
      } else if (mode === "owner") {
        store.close();
        const database = openProductDatabase(join(store.root, "product.sqlite3"));
        database.prepare(`INSERT INTO object_files
          (id, owner_model_id, kind, relative_path, media_type, size_bytes, sha256, created_at)
          VALUES ('file_owner_mismatch', 'model_alpha', 'model_code', 'code/missing.py', 'text/x-python', 1, ?, ?)`
        ).run("a".repeat(64), NOW);
        database.close();
        store = ProductStoreV2.open(join(parent, "store"));
        assert.throws(() => store.previewPermanentDelete("model", "model_alpha"), /digest drift/u);
      } else {
        store.close();
        const database = openProductDatabase(join(store.root, "product.sqlite3"));
        database.prepare("UPDATE object_files SET size_bytes = ? WHERE owner_model_id = ?").run(Number.MAX_SAFE_INTEGER, "model_alpha");
        database.close();
        store = ProductStoreV2.open(join(parent, "store"));
        assert.throws(() => store.previewPermanentDelete("model", "model_alpha"), /byte total is not a safe integer/u);
      }
      assert.equal(readFileSync(outside, "utf8"), "sentinel");
    } finally { store.close(); rmSync(parent, { recursive: true, force: true }); }
  }
});
