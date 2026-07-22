import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProductStoreV2 } from "../src/product-store-v2.ts";
import { openProductDatabase } from "../src/product-schema.ts";

const NOW = "2026-07-22T04:00:00.000Z";

const fixture = (): { parent: string; store: ProductStoreV2 } => {
  const parent = mkdtempSync(join(tmpdir(), "riff-product-preview-"));
  const store = ProductStoreV2.open(join(parent, "store"));
  store.createModel({
    id: "model_alpha", name: "Alpha", technicalStatus: "executable", runMode: "batch",
    executionDescription: { entryPoint: "model.py" }, createdAt: NOW,
    files: [{ id: "file_model", kind: "model_code", relativePath: "model.py", mediaType: "text/x-python", bytes: Buffer.from("print('alpha')\n") }],
  });
  store.createConversation({ id: "conversation_model", owner: { kind: "model", id: "model_alpha" }, name: "Build", providerId: "provider", providerModelId: "model", createdAt: NOW });
  store.createMessage({ id: "message_model", conversationId: "conversation_model", ordinal: 0, role: "user", status: "complete", text: "input", createdAt: NOW });
  store.createTemporaryDocument({ id: "document_model", conversationId: "conversation_model", sourceMessageId: "message_model", name: "Plan", documentState: "draft", mediaType: "text/markdown", content: "# Plan", createdAt: NOW });
  store.createAttachment({ id: "attachment_model", objectFileId: "file_attachment", conversationId: "conversation_model", relativePath: "input.csv", originalName: "input.csv", mediaType: "text/csv", bytes: Buffer.from("x\n1\n"), createdAt: NOW });
  store.linkMessageAttachment("message_model", "attachment_model");
  store.adoptAttachment({ objectFileId: "file_adopted", owner: { kind: "model", id: "model_alpha" }, sourceAttachmentId: "attachment_model", relativePath: "input.csv", purpose: "calibration", createdAt: NOW });
  store.createProjectFromModel({ projectId: "project_alpha", projectName: "Project", sourceModelId: "model_alpha", createdAt: NOW });
  store.createConversation({ id: "conversation_project", owner: { kind: "project", id: "project_alpha" }, name: "Analyze", providerId: "provider", providerModelId: "model", createdAt: NOW });
  store.createExperiment({ id: "experiment_alpha", projectId: "project_alpha", name: "Base", configuration: { seed: 1 }, estimatedSampleCount: 1, createdAt: NOW });
  store.createRun({ id: "run_alpha", projectId: "project_alpha", experimentId: "experiment_alpha", status: "succeeded", frozenConfiguration: { seed: 1 }, requestedSampleCount: 1, createdAt: NOW });
  store.createOutput({ id: "output_alpha", objectFileId: "file_output", runId: "run_alpha", relativePath: "result.csv", logicalName: "result.csv", outputType: "table", mediaType: "text/csv", bytes: Buffer.from("metric\n1\n"), createdAt: NOW });
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
    assert.ok(project.exclusions.some((item) => item.kind === "model" && item.id === "model_alpha"));

    const conversation = store.previewPermanentDelete("conversation", "conversation_model");
    assert.ok(conversation.blockingReferences.some((item) => item.kind === "adopted_attachment" && item.id === "file_adopted"));
    assert.ok(conversation.exclusions.some((item) => item.id === "file_adopted"));
    assert.equal(conversation.files.some((file) => file.id === "file_adopted"), false);

    const document = store.previewPermanentDelete("temporary_document", "document_model");
    assert.deepEqual(document.records.map((item) => item.table), ["temporary_documents"]);
    assert.ok(document.exclusions.some((item) => item.kind === "conversation"));

    const experiment = store.previewPermanentDelete("experiment", "experiment_alpha");
    assert.deepEqual(experiment.blockingReferences, [{ kind: "run", id: "run_alpha" }]);
    assert.ok(experiment.exclusions.some((item) => item.kind === "project"));

    store.trashResource("run", "run_alpha", NOW);
    const run = store.previewPermanentDelete("run", "run_alpha");
    assert.ok(run.records.some((item) => item.table === "trash_entries"));
    assert.ok(run.records.some((item) => item.table === "output_indexes"));
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
