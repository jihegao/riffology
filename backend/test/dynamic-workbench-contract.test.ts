import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { AgentWorkspaceService } from "../src/agent-workspace-service.ts";
import { canonicalDigest } from "../src/canonical-json-v2.ts";
import {
  ProductStoreV2,
  ProductStoreV2Error,
} from "../src/product-store-v2.ts";

const NOW = "2026-07-28T12:00:00.000Z";
const LATER = "2026-07-28T12:01:00.000Z";
const EXECUTION = {
  schemaVersion: 2,
  runtime: "python",
  runMode: "batch",
  dependencyFile: "environment/requirements.txt",
  inputs: {
    schemaProfile: "riff-json-schema-2020-12-v1",
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    smoke: {},
  },
  outputs: [{
    logicalName: "summary",
    relativePath: "summary.json",
    mediaType: "application/json",
    required: true,
    role: "data",
  }],
  batch: { entryPoint: "code/model.py", protocol: "riff-batch-v1" },
  cancellation: { signal: "SIGTERM", graceMs: 100 },
} as const;

test("generated views stay derived and stale while change sets apply atomically and replay", (t) => {
  const parent = mkdtempSync(join(tmpdir(), "riff-dynamic-workbench-"));
  const root = join(parent, "store");
  let store = ProductStoreV2.open(root);
  t.after(() => {
    try { store.close(); } catch { /* already closed */ }
    rmSync(parent, { recursive: true, force: true });
  });
  store.createModelWithFirstConversation({
    model: {
      id: "model_dynamic",
      name: "Dynamic",
      technicalStatus: "draft",
      runMode: "batch",
      executionDescription: EXECUTION,
      createdAt: NOW,
      files: [{
        id: "file_dynamic",
        kind: "model_code",
        relativePath: "model.py",
        mediaType: "text/x-python",
        bytes: Buffer.from("value = 1\n"),
      }],
    },
    conversation: {
      id: "conversation_dynamic",
      name: "Design",
      providerId: "provider",
      providerModelId: "model",
      createdAt: NOW,
    },
  });
  store.startAgentTurn({
    turnId: "turn_dynamic",
    userMessageId: "message_dynamic",
    conversationId: "conversation_dynamic",
    requestKey: "dynamic",
    text: "Could we review a possible Model change?",
    createdAt: NOW,
  });

  const sourceDigest = store.modelWorkspaceDigest("model_dynamic");
  const generated = store.publishGeneratedViews({
    modelId: "model_dynamic",
    conversationId: "conversation_dynamic",
    turnId: "turn_dynamic",
    sourceWorkspaceDigest: sourceDigest,
    views: [{
      id: "view_relationships",
      title: "Relationships chosen for this Model",
      mediaType: "application/vnd.riff.diagram+json",
      payload: JSON.stringify({
        edges: [{ from: "a", to: "b" }],
        nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
        summary: "Derived structure",
      }),
      sourceFileIds: ["file_dynamic"],
    }],
    publishedAt: NOW,
  });
  assert.equal(generated.views[0]?.title, "Relationships chosen for this Model");
  assert.equal(store.modelWorkspaceDigest("model_dynamic"), sourceDigest);
  const service = new AgentWorkspaceService(store, {} as any, () => LATER);
  service.modelWorkspace("model_dynamic");
  assert.equal(service.generatedViews("model_dynamic")?.freshness, "fresh");
  assert.equal(
    service.generatedViewRenderable("model_dynamic", "view_relationships").kind,
    "diagram",
  );

  const file = store.listObjectFiles({ kind: "model", id: "model_dynamic" })[0]!;
  const proposed = store.createModelChangeSet({
    id: "change_set_dynamic",
    modelId: "model_dynamic",
    conversationId: "conversation_dynamic",
    turnId: "turn_dynamic",
    baseWorkspaceDigest: sourceDigest,
    files: [{
      objectFileId: file.id,
      kind: "model_code",
      relativePath: "model.py",
      mediaType: "text/x-python",
      bytes: Buffer.from("value = 2\n"),
      expectedPriorSha256: file.sha256,
    }],
    createdAt: NOW,
  });
  assert.equal(store.readObjectFile(file.id).toString("utf8"), "value = 1\n");
  const applied = store.applyModelChangeSet({
    commandId: "command_apply_dynamic",
    modelId: "model_dynamic",
    changeSetId: proposed.id,
    expectedChangeSetDigest: proposed.changeSetDigest,
    expectedWorkspaceDigest: sourceDigest,
    committedAt: LATER,
  });
  assert.equal(applied.operation, "apply");
  assert.equal(store.readObjectFile(file.id).toString("utf8"), "value = 2\n");
  assert.deepEqual(store.applyModelChangeSet({
    commandId: "command_apply_dynamic",
    modelId: "model_dynamic",
    changeSetId: proposed.id,
    expectedChangeSetDigest: proposed.changeSetDigest,
    expectedWorkspaceDigest: sourceDigest,
    committedAt: LATER,
  }), applied);
  assert.equal(service.generatedViews("model_dynamic")?.freshness, "stale");

  const current = store.listObjectFiles({ kind: "model", id: "model_dynamic" })[0]!;
  const stale = store.createModelChangeSet({
    id: "change_set_stale",
    modelId: "model_dynamic",
    conversationId: "conversation_dynamic",
    turnId: "turn_dynamic",
    baseWorkspaceDigest: store.modelWorkspaceDigest("model_dynamic"),
    files: [{
      objectFileId: current.id,
      kind: "model_code",
      relativePath: "model.py",
      mediaType: "text/x-python",
      bytes: Buffer.from("value = 3\n"),
      expectedPriorSha256: current.sha256,
    }],
    createdAt: LATER,
  });
  store.mutateModelFiles({
    modelId: "model_dynamic",
    files: [{
      objectFileId: current.id,
      kind: "model_code",
      relativePath: "model.py",
      mediaType: "text/x-python",
      bytes: Buffer.from("value = 4\n"),
      expectedPriorSha256: current.sha256,
    }],
    updatedAt: LATER,
  });
  assert.throws(() => store.applyModelChangeSet({
    commandId: "command_apply_stale",
    modelId: "model_dynamic",
    changeSetId: stale.id,
    expectedChangeSetDigest: stale.changeSetDigest,
    expectedWorkspaceDigest: stale.baseWorkspaceDigest,
    committedAt: LATER,
  }), /Model change set is stale/u);
  assert.equal(store.readObjectFile(current.id).toString("utf8"), "value = 4\n");
  const rejected = store.rejectModelChangeSet({
    commandId: "command_reject_stale",
    modelId: "model_dynamic",
    changeSetId: stale.id,
    expectedChangeSetDigest: stale.changeSetDigest,
    committedAt: LATER,
  });
  assert.equal(rejected.operation, "reject");
  assert.equal(rejected.beforeWorkspaceDigest, rejected.afterWorkspaceDigest);
  assert.deepEqual(store.rejectModelChangeSet({
    commandId: "command_reject_stale",
    modelId: "model_dynamic",
    changeSetId: stale.id,
    expectedChangeSetDigest: stale.changeSetDigest,
    committedAt: LATER,
  }), rejected);
  assert.equal(store.readObjectFile(current.id).toString("utf8"), "value = 4\n");
  const direct = store.commitDirectModelChanges({
    commandId: "command_direct_dynamic",
    modelId: "model_dynamic",
    files: [{
      objectFileId: current.id,
      kind: "model_code",
      relativePath: "model.py",
      mediaType: "text/x-python",
      bytes: Buffer.from("value = 5\n"),
      expectedPriorSha256: store.listObjectFiles({ kind: "model", id: "model_dynamic" })[0]!.sha256,
    }],
    committedAt: LATER,
    transactionId: "transaction_direct_dynamic",
  });
  assert.deepEqual(store.commitDirectModelChanges({
    commandId: "command_direct_dynamic",
    modelId: "model_dynamic",
    files: [{
      objectFileId: current.id,
      kind: "model_code",
      relativePath: "model.py",
      mediaType: "text/x-python",
      bytes: Buffer.from("value = 5\n"),
      expectedPriorSha256: direct.files[0]!.priorSha256,
    }],
    committedAt: LATER,
    transactionId: "transaction_direct_dynamic_replay",
  }), direct);
  assert.equal(store.readObjectFile(current.id).toString("utf8"), "value = 5\n");

  const digestBeforeMediaType = store.modelWorkspaceDigest("model_dynamic");
  const metadataDatabase = new DatabaseSync(join(root, "product.sqlite3"));
  try {
    metadataDatabase.prepare(
      "UPDATE object_files SET media_type = ? WHERE id = ?",
    ).run("text/plain", current.id);
  } finally {
    metadataDatabase.close();
  }
  const digestAfterMediaType = store.modelWorkspaceDigest("model_dynamic");
  assert.notEqual(digestAfterMediaType, digestBeforeMediaType);
  const metadataView = store.publishGeneratedViews({
    modelId: "model_dynamic",
    conversationId: "conversation_dynamic",
    turnId: "turn_dynamic",
    sourceWorkspaceDigest: digestAfterMediaType,
    views: [{
      id: "view_metadata",
      title: "Metadata-bound view",
      mediaType: "text/markdown",
      payload: "# Metadata-bound\n",
      sourceFileIds: [current.id],
    }],
    publishedAt: LATER,
  });
  const metadataFile = store.listObjectFiles({
    kind: "model",
    id: "model_dynamic",
  })[0]!;
  const metadataChangeSet = store.createModelChangeSet({
    id: "change_set_metadata",
    modelId: "model_dynamic",
    conversationId: "conversation_dynamic",
    turnId: "turn_dynamic",
    baseWorkspaceDigest: digestAfterMediaType,
    files: [{
      objectFileId: metadataFile.id,
      kind: "model_code",
      relativePath: "model.py",
      mediaType: metadataFile.mediaType,
      bytes: Buffer.from("value = 6\n"),
      expectedPriorSha256: metadataFile.sha256,
    }],
    createdAt: LATER,
  });
  const changedExecution = structuredClone(EXECUTION) as any;
  changedExecution.cancellation.graceMs = 101;
  const executionDatabase = new DatabaseSync(join(root, "product.sqlite3"));
  try {
    executionDatabase.prepare(
      "UPDATE models SET execution_description_json = ? WHERE id = ?",
    ).run(JSON.stringify(changedExecution), "model_dynamic");
  } finally {
    executionDatabase.close();
  }
  const digestAfterExecution = store.modelWorkspaceDigest("model_dynamic");
  assert.notEqual(digestAfterExecution, digestAfterMediaType);
  assert.equal(service.generatedViews("model_dynamic")?.freshness, "stale");
  assert.equal(metadataView.sourceWorkspaceDigest, digestAfterMediaType);
  assert.throws(() => store.applyModelChangeSet({
    commandId: "command_apply_metadata_stale",
    modelId: "model_dynamic",
    changeSetId: metadataChangeSet.id,
    expectedChangeSetDigest: metadataChangeSet.changeSetDigest,
    expectedWorkspaceDigest: metadataChangeSet.baseWorkspaceDigest,
    committedAt: LATER,
  }), /Model change set is stale/u);

  const previewTables = new Set(
    store.previewPermanentDelete("model", "model_dynamic").records
      .map((record) => record.table),
  );
  for (const table of [
    "model_generated_view_sets",
    "model_generated_views",
    "model_change_sets",
    "model_change_set_files",
    "model_change_set_receipts",
  ]) {
    assert.equal(previewTables.has(table), true, table);
  }

  store.createModel({
    id: "model_receipt_other",
    name: "Receipt owner probe",
    technicalStatus: "draft",
    runMode: "batch",
    executionDescription: EXECUTION,
    createdAt: NOW,
    files: [{
      id: "file_receipt_other",
      kind: "model_code",
      relativePath: "model.py",
      mediaType: "text/x-python",
      bytes: Buffer.from("value = 0\n"),
    }],
  });
  const database = new DatabaseSync(join(root, "product.sqlite3"));
  try {
    database.exec("PRAGMA foreign_keys = ON");
    assert.throws(() => database.prepare(
      "UPDATE model_change_set_receipts SET committed_at = ? WHERE command_id = ?",
    ).run(NOW, "command_apply_dynamic"), /immutable/u);
    const crossUnsigned = {
      ...applied,
      commandId: "command_cross_receipt",
      modelId: "model_receipt_other",
    };
    delete (crossUnsigned as any).receiptDigest;
    const crossReceipt = {
      ...crossUnsigned,
      receiptDigest: canonicalDigest(crossUnsigned),
    };
    assert.throws(() => database.prepare(
      `INSERT INTO model_change_set_receipts
        (command_id, model_id, change_set_id, operation,
          canonical_intent_sha256, receipt_json, receipt_sha256, committed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      crossReceipt.commandId,
      crossReceipt.modelId,
      crossReceipt.changeSetId,
      crossReceipt.operation,
      "0".repeat(64),
      JSON.stringify(crossReceipt),
      crossReceipt.receiptDigest,
      crossReceipt.committedAt,
    ), /FOREIGN KEY|constraint/u);
    const nullChangeUnsigned = {
      ...applied,
      commandId: "command_null_change_receipt",
      changeSetId: null,
    };
    delete (nullChangeUnsigned as any).receiptDigest;
    const nullChangeReceipt = {
      ...nullChangeUnsigned,
      receiptDigest: canonicalDigest(nullChangeUnsigned),
    };
    assert.throws(() => database.prepare(
      `INSERT INTO model_change_set_receipts
        (command_id, model_id, change_set_id, operation,
          canonical_intent_sha256, receipt_json, receipt_sha256, committed_at)
       VALUES (?, ?, ?, 'apply', ?, ?, ?, ?)`,
    ).run(
      nullChangeReceipt.commandId,
      nullChangeReceipt.modelId,
      null,
      "0".repeat(64),
      JSON.stringify(nullChangeReceipt),
      nullChangeReceipt.receiptDigest,
      nullChangeReceipt.committedAt,
    ), /CHECK|constraint/u);
    const directWithChangeUnsigned = {
      ...applied,
      commandId: "command_direct_with_change",
      operation: "direct_apply" as const,
    };
    delete (directWithChangeUnsigned as any).receiptDigest;
    const directWithChangeReceipt = {
      ...directWithChangeUnsigned,
      receiptDigest: canonicalDigest(directWithChangeUnsigned),
    };
    assert.throws(() => database.prepare(
      `INSERT INTO model_change_set_receipts
        (command_id, model_id, change_set_id, operation,
          canonical_intent_sha256, receipt_json, receipt_sha256, committed_at)
       VALUES (?, ?, ?, 'direct_apply', ?, ?, ?, ?)`,
    ).run(
      directWithChangeReceipt.commandId,
      directWithChangeReceipt.modelId,
      directWithChangeReceipt.changeSetId,
      "0".repeat(64),
      JSON.stringify(directWithChangeReceipt),
      directWithChangeReceipt.receiptDigest,
      directWithChangeReceipt.committedAt,
    ), /CHECK|constraint/u);
    database.prepare(
      `UPDATE model_generated_views SET payload_sha256 = ?
       WHERE model_id = ? AND id = ?`,
    ).run("0".repeat(64), "model_dynamic", "view_metadata");
    assert.throws(
      () => store.getGeneratedViewSet("model_dynamic"),
      /Generated-view evidence is invalid/u,
    );
    database.prepare(
      `UPDATE model_generated_views SET payload_sha256 = ?
       WHERE model_id = ? AND id = ?`,
    ).run(
      metadataView.views[0]!.payloadDigest,
      "model_dynamic",
      "view_metadata",
    );
    database.prepare(
      `UPDATE model_generated_views SET source_file_ids_json = ?
       WHERE model_id = ? AND id = ?`,
    ).run(
      JSON.stringify(["file_receipt_other"]),
      "model_dynamic",
      "view_metadata",
    );
    assert.throws(
      () => store.getGeneratedViewSet("model_dynamic"),
      /Generated-view evidence is invalid/u,
    );
    database.prepare(
      `UPDATE model_generated_views SET source_file_ids_json = ?
       WHERE model_id = ? AND id = ?`,
    ).run(
      JSON.stringify([current.id]),
      "model_dynamic",
      "view_metadata",
    );
    assert.equal(
      store.getGeneratedViewSet("model_dynamic")?.setDigest,
      metadataView.setDigest,
    );
    database.prepare(
      "UPDATE model_generated_view_sets SET set_sha256 = ? WHERE model_id = ?",
    ).run("f".repeat(64), "model_dynamic");
    assert.throws(
      () => store.getGeneratedViewSet("model_dynamic"),
      /Generated-view evidence is invalid/u,
    );
    database.prepare(
      "UPDATE model_generated_view_sets SET set_sha256 = ? WHERE model_id = ?",
    ).run(metadataView.setDigest, "model_dynamic");
  } finally {
    database.close();
  }
  const corruptionDatabase = new DatabaseSync(join(root, "product.sqlite3"));
  try {
    corruptionDatabase.exec(
      "DROP TRIGGER model_change_set_receipts_immutable_update_v17",
    );
    const corruptedReceipt = {
      ...applied,
      afterWorkspaceDigest: "f".repeat(64),
      receiptDigest: "e".repeat(64),
    };
    corruptionDatabase.prepare(
      `UPDATE model_change_set_receipts
       SET receipt_json = ?, receipt_sha256 = ?
       WHERE command_id = ?`,
    ).run(
      JSON.stringify(corruptedReceipt),
      corruptedReceipt.receiptDigest,
      applied.commandId,
    );
  } finally {
    corruptionDatabase.close();
  }
  assert.throws(() => store.applyModelChangeSet({
    commandId: "command_apply_dynamic",
    modelId: "model_dynamic",
    changeSetId: proposed.id,
    expectedChangeSetDigest: proposed.changeSetDigest,
    expectedWorkspaceDigest: sourceDigest,
    committedAt: LATER,
  }), /Model mutation receipt is invalid/u);

  store.close();
  store = ProductStoreV2.open(root);
  assert.equal(
    store.getModelChangeSet("model_dynamic", "change_set_dynamic").state,
    "applied",
  );
  assert.equal(
    store.getGeneratedViewSet("model_dynamic")?.setDigest,
    metadataView.setDigest,
  );
  store.trashResource("model", "model_dynamic", LATER);
  const deletePreview = store.previewPermanentDelete("model", "model_dynamic");
  const confirmation = {
    action: "permanently_delete" as const,
    kind: "model" as const,
    id: "model_dynamic",
    recordCount: deletePreview.records.length,
    fileCount: deletePreview.files.length,
    totalBytes: deletePreview.totalBytes,
  };
  store.commitPermanentDelete({
    commandId: "command_delete_dynamic",
    kind: "model",
    id: "model_dynamic",
    previewToken: deletePreview.previewToken,
    stateToken: deletePreview.stateToken,
    canonicalIntentDigest: canonicalDigest({
      kind: "model",
      id: "model_dynamic",
      previewToken: deletePreview.previewToken,
      stateToken: deletePreview.stateToken,
      confirmation,
    }),
    committedAt: LATER,
  });
  assert.equal(store.listModels({
    includeArchived: true,
    includeTrashed: true,
  }).some((model) => model.id === "model_dynamic"), false);
});

test("generated-view and change-set count and byte limits fail closed", (t) => {
  const parent = mkdtempSync(join(tmpdir(), "riff-dynamic-limits-"));
  const store = ProductStoreV2.open(join(parent, "store"));
  t.after(() => {
    store.close();
    rmSync(parent, { recursive: true, force: true });
  });
  store.createModelWithFirstConversation({
    model: {
      id: "model_limits",
      name: "Limits",
      technicalStatus: "draft",
      runMode: "batch",
      executionDescription: EXECUTION,
      createdAt: NOW,
      files: [{
        id: "file_limits",
        kind: "model_code",
        relativePath: "model.py",
        mediaType: "text/x-python",
        bytes: Buffer.from("value = 1\n"),
      }],
    },
    conversation: {
      id: "conversation_limits",
      name: "Limits",
      providerId: "provider",
      providerModelId: "model",
      createdAt: NOW,
    },
  });
  store.startAgentTurn({
    turnId: "turn_limits",
    userMessageId: "message_limits",
    conversationId: "conversation_limits",
    requestKey: "limits",
    text: "Discuss limits",
    createdAt: NOW,
  });
  const digest = store.modelWorkspaceDigest("model_limits");
  const sixteenViews = Array.from({ length: 16 }, (_, index) => ({
    id: `view_exact_${index}`,
    title: `View ${index}`,
    mediaType: "text/markdown",
    payload: "ok",
    sourceFileIds: [] as string[],
  }));
  assert.equal(store.publishGeneratedViews({
    modelId: "model_limits",
    conversationId: "conversation_limits",
    turnId: "turn_limits",
    sourceWorkspaceDigest: digest,
    views: sixteenViews,
    publishedAt: NOW,
  }).views.length, 16);
  assert.throws(() => store.publishGeneratedViews({
    modelId: "model_limits",
    conversationId: "conversation_limits",
    turnId: "turn_limits",
    sourceWorkspaceDigest: digest,
    views: Array.from({ length: 17 }, (_, index) => ({
      id: `view_${index}`,
      title: `View ${index}`,
      mediaType: "text/markdown",
      payload: "ok",
      sourceFileIds: [],
    })),
    publishedAt: NOW,
  }), ProductStoreV2Error);
  const exactViewPayload = `"${"a".repeat(2_097_150)}"`;
  assert.equal(Buffer.byteLength(exactViewPayload), 2_097_152);
  assert.equal(store.publishGeneratedViews({
    modelId: "model_limits",
    conversationId: "conversation_limits",
    turnId: "turn_limits",
    sourceWorkspaceDigest: digest,
    views: Array.from({ length: 4 }, (_, index) => ({
      id: `view_group_exact_${index}`,
      title: `Exact ${index}`,
      mediaType: "application/json",
      payload: exactViewPayload,
      sourceFileIds: [],
    })),
    publishedAt: NOW,
  }).views.length, 4);
  assert.throws(() => store.publishGeneratedViews({
    modelId: "model_limits",
    conversationId: "conversation_limits",
    turnId: "turn_limits",
    sourceWorkspaceDigest: digest,
    views: [
      ...Array.from({ length: 4 }, (_, index) => ({
        id: `view_group_over_${index}`,
        title: `Over ${index}`,
        mediaType: "application/json",
        payload: exactViewPayload,
        sourceFileIds: [] as string[],
      })),
      {
        id: "view_group_over_tail",
        title: "Over tail",
        mediaType: "text/plain",
        payload: "x",
        sourceFileIds: [],
      },
    ],
    publishedAt: NOW,
  }), /payload limit/u);
  assert.throws(() => store.publishGeneratedViews({
    modelId: "model_limits",
    conversationId: "conversation_limits",
    turnId: "turn_limits",
    sourceWorkspaceDigest: digest,
    views: [{
      id: "view_item_over",
      title: "Item over",
      mediaType: "text/plain",
      payload: "a".repeat(2_097_153),
      sourceFileIds: [],
    }],
    publishedAt: NOW,
  }), /payload limit/u);
  const exactFile = (index: number, size = 1) => ({
    objectFileId: `file_exact_${index}`,
    kind: "model_code" as const,
    relativePath: `exact-${index}.py`,
    mediaType: "text/x-python",
    bytes: Buffer.alloc(size, 97),
    expectedPriorSha256: null,
  });
  assert.equal(store.createModelChangeSet({
    id: "change_set_exact_64",
    modelId: "model_limits",
    conversationId: "conversation_limits",
    turnId: "turn_limits",
    baseWorkspaceDigest: digest,
    files: Array.from({ length: 64 }, (_, index) => exactFile(index)),
    createdAt: NOW,
  }).files.length, 64);
  assert.throws(() => store.createModelChangeSet({
    id: "change_set_over_64",
    modelId: "model_limits",
    conversationId: "conversation_limits",
    turnId: "turn_limits",
    baseWorkspaceDigest: digest,
    files: Array.from({ length: 65 }, (_, index) => ({
      ...exactFile(index),
      objectFileId: `file_over_count_${index}`,
      relativePath: `over-count-${index}.py`,
    })),
    createdAt: NOW,
  }), /file or identity limit/u);
  assert.equal(store.createModelChangeSet({
    id: "change_set_exact_8mib",
    modelId: "model_limits",
    conversationId: "conversation_limits",
    turnId: "turn_limits",
    baseWorkspaceDigest: digest,
    files: Array.from({ length: 8 }, (_, index) => ({
      ...exactFile(index, 1_048_576),
      objectFileId: `file_exact_group_${index}`,
      relativePath: `exact-group-${index}.py`,
    })),
    createdAt: NOW,
  }).files.length, 8);
  assert.throws(() => store.createModelChangeSet({
    id: "change_set_over_8mib",
    modelId: "model_limits",
    conversationId: "conversation_limits",
    turnId: "turn_limits",
    baseWorkspaceDigest: digest,
    files: [
      ...Array.from({ length: 8 }, (_, index) => ({
        ...exactFile(index, 1_048_576),
        objectFileId: `file_over_group_${index}`,
        relativePath: `over-group-${index}.py`,
      })),
      {
        ...exactFile(9),
        objectFileId: "file_over_group_tail",
        relativePath: "over-group-tail.py",
      },
    ],
    createdAt: NOW,
  }), /payload limit/u);
  assert.throws(() => store.createModelChangeSet({
    id: "change_set_too_large",
    modelId: "model_limits",
    conversationId: "conversation_limits",
    turnId: "turn_limits",
    baseWorkspaceDigest: digest,
    files: [{
      objectFileId: "file_too_large",
      kind: "model_code",
      relativePath: "large.py",
      mediaType: "text/x-python",
      bytes: Buffer.alloc(1_048_577, 97),
      expectedPriorSha256: null,
    }],
    createdAt: NOW,
  }), /payload limit/u);
});

test("change-set apply rolls back files, state, and receipt together after an injected fault", (t) => {
  const parent = mkdtempSync(join(tmpdir(), "riff-dynamic-atomic-"));
  const root = join(parent, "store");
  let store = ProductStoreV2.open(root);
  t.after(() => {
    try { store.close(); } catch { /* already closed */ }
    rmSync(parent, { recursive: true, force: true });
  });
  store.createModelWithFirstConversation({
    model: {
      id: "model_atomic",
      name: "Atomic",
      technicalStatus: "draft",
      runMode: "batch",
      executionDescription: EXECUTION,
      createdAt: NOW,
      files: [{
        id: "file_atomic",
        kind: "model_code",
        relativePath: "model.py",
        mediaType: "text/x-python",
        bytes: Buffer.from("value = 1\n"),
      }],
    },
    conversation: {
      id: "conversation_atomic",
      name: "Atomic",
      providerId: "provider",
      providerModelId: "model",
      createdAt: NOW,
    },
  });
  store.startAgentTurn({
    turnId: "turn_atomic",
    userMessageId: "message_atomic",
    conversationId: "conversation_atomic",
    requestKey: "atomic",
    text: "Discuss an atomic proposal",
    createdAt: NOW,
  });
  const file = store.listObjectFiles({ kind: "model", id: "model_atomic" })[0]!;
  const changeSet = store.createModelChangeSet({
    id: "change_set_atomic",
    modelId: "model_atomic",
    conversationId: "conversation_atomic",
    turnId: "turn_atomic",
    baseWorkspaceDigest: store.modelWorkspaceDigest("model_atomic"),
    files: [{
      objectFileId: file.id,
      kind: "model_code",
      relativePath: "model.py",
      mediaType: "text/x-python",
      bytes: Buffer.from("value = 2\n"),
      expectedPriorSha256: file.sha256,
    }],
    createdAt: NOW,
  });
  store.close();
  let faulted = false;
  store = ProductStoreV2.openForTesting(root, {
    coordinatorOptions: {
      faultInjector(point) {
        if (!faulted && point === "after_database_changes") {
          faulted = true;
          throw new Error("injected_change_set_atomic_fault");
        }
      },
    },
  });
  const intent = {
    commandId: "command_atomic_apply",
    modelId: "model_atomic",
    changeSetId: changeSet.id,
    expectedChangeSetDigest: changeSet.changeSetDigest,
    expectedWorkspaceDigest: changeSet.baseWorkspaceDigest,
    committedAt: LATER,
  };
  assert.throws(
    () => store.applyModelChangeSet(intent),
    /injected_change_set_atomic_fault/u,
  );
  assert.equal(store.readObjectFile(file.id).toString("utf8"), "value = 1\n");
  assert.equal(
    store.getModelChangeSet("model_atomic", changeSet.id).state,
    "pending",
  );
  const receiptDatabase = new DatabaseSync(join(root, "product.sqlite3"));
  try {
    assert.equal(Boolean(receiptDatabase.prepare(
      "SELECT 1 FROM model_change_set_receipts WHERE command_id = ?",
    ).get(intent.commandId)), false);
  } finally {
    receiptDatabase.close();
  }
  const retry = store.applyModelChangeSet(intent);
  assert.equal(retry.operation, "apply");
  assert.equal(store.readObjectFile(file.id).toString("utf8"), "value = 2\n");
});
