import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { MutationFaultPoint } from "../src/mutation-coordinator.ts";
import { ProductStoreV2 } from "../src/product-store-v2.ts";

const NOW = "2026-07-22T07:00:00.000Z";
const LATER = "2026-07-22T08:00:00.000Z";
const model = (suffix: string) => ({
  id: `model_v3_${suffix}`, name: `V3 ${suffix}`, technicalStatus: "draft" as const, runMode: "batch" as const,
  executionDescription: { entryPoint: "model.py" }, createdAt: NOW,
  files: [
    { id: `file_v3_${suffix}_a`, kind: "model_code" as const, relativePath: "model.py", mediaType: "text/x-python", bytes: Buffer.from("a=1\n") },
    { id: `file_v3_${suffix}_b`, kind: "model_environment" as const, relativePath: "requirements.txt", mediaType: "text/plain", bytes: Buffer.from("mesa==3\n") },
  ],
});

test("composite New Model plus first conversation recovers atomically at every fault boundary", () => {
  for (const point of ["after_manifest", "after_database_changes", "after_files_promoted", "after_sqlite_commit"] satisfies MutationFaultPoint[]) {
    const parent = mkdtempSync(join(tmpdir(), `riff-v3-composite-${point}-`));
    const root = join(parent, "store");
    let store = ProductStoreV2.openForTesting(root, { coordinatorOptions: { faultInjector(seen) { if (seen === point) throw new Error(`fault:${point}`); } } });
    try {
      const input = { model: model(point), conversation: { id: `conversation_v3_${point}`, name: "First", providerId: "p", providerModelId: "m", createdAt: NOW } };
      assert.throws(() => store.createModelWithFirstConversation(input), new RegExp(`fault:${point}`, "u"));
      const committed = point === "after_sqlite_commit";
      assert.equal(store.listModels({ includeArchived: true, includeTrashed: true }).length, committed ? 1 : 0, point);
      if (committed) {
        assert.equal(store.createModelWithFirstConversation(input).conversation.id, input.conversation.id);
        assert.equal(store.listConversations({ kind: "model", id: input.model.id }).length, 1);
        assert.throws(() => store.createModelWithFirstConversation({ ...input, conversation: { ...input.conversation, providerId: "different" } }), /different intent/u);
      }
      store.close();
      store = ProductStoreV2.open(root);
      assert.equal(store.listModels({ includeArchived: true, includeTrashed: true }).length, committed ? 1 : 0, `restart:${point}`);
      assert.equal(store.listConversations({ kind: "model", id: input.model.id }).length, committed ? 1 : 0, `restart:${point}`);
    } finally { store.close(); rmSync(parent, { recursive: true, force: true }); }
  }
});

test("multi-file Model mutation is all-or-none and response-loss commit is recoverable", () => {
  for (const point of ["after_database_changes", "after_files_promoted", "after_sqlite_commit"] satisfies MutationFaultPoint[]) {
    const parent = mkdtempSync(join(tmpdir(), `riff-v3-files-${point}-`));
    const root = join(parent, "store");
    const initial = ProductStoreV2.open(root);
    const created = model(point);
    initial.createModel(created);
    const prior = initial.listObjectFiles({ kind: "model", id: created.id });
    initial.close();
    let store = ProductStoreV2.openForTesting(root, { coordinatorOptions: { faultInjector(seen) { if (seen === point) throw new Error(`fault:${point}`); } } });
    try {
      assert.throws(() => store.mutateModelFiles({ modelId: created.id, updatedAt: LATER, transactionId: `mutation_v3_${point}`,
        executionDescription: { entryPoint: "next.py" }, files: prior.map((file, index) => ({ objectFileId: file.id,
          kind: file.kind as "model_code" | "model_environment", relativePath: file.relativePath.replace(/^(code|environment)\//u, ""), mediaType: file.mediaType,
          bytes: Buffer.from(`next-${index}`), expectedPriorSha256: file.sha256 })) }), new RegExp(`fault:${point}`, "u"));
      const committed = point === "after_sqlite_commit";
      const bytes = prior.map((file) => store.readObjectFile(file.id).toString("utf8"));
      assert.deepEqual(bytes, committed ? ["next-0", "next-1"] : ["a=1\n", "mesa==3\n"], point);
      assert.equal(store.listModels({ includeArchived: true })[0]!.executionDescription.entryPoint, committed ? "next.py" : "model.py");
      store.close(); store = ProductStoreV2.open(root);
      assert.deepEqual(prior.map((file) => store.readObjectFile(file.id).toString("utf8")), bytes);
    } finally { store.close(); rmSync(parent, { recursive: true, force: true }); }
  }
});

test("committed action evidence adopts documents and technical-check CAS rejects workspace drift", () => {
  const parent = mkdtempSync(join(tmpdir(), "riff-v3-evidence-"));
  const store = ProductStoreV2.open(join(parent, "store"));
  try {
    const created = model("evidence"); store.createModel(created);
    store.createConversation({ id: "conversation_evidence", owner: { kind: "model", id: created.id }, name: "Evidence", providerId: "p", providerModelId: "m", createdAt: NOW });
    store.startAgentTurn({ turnId: "turn_evidence", userMessageId: "message_evidence", conversationId: "conversation_evidence", requestKey: "evidence", text: "Apply change", createdAt: NOW });
    store.createTemporaryDocument({ id: "document_evidence", conversationId: "conversation_evidence", sourceMessageId: "message_evidence", name: "Patch",
      documentState: "draft", mediaType: "text/markdown", content: "change", createdAt: NOW });
    store.recordAction({ id: "action_evidence", conversationId: "conversation_evidence", turnId: "turn_evidence", actionKind: "replace_model_files",
      intent: { files: 1 }, permissionDecision: "pending", state: "proposed", createdAt: NOW });
    store.transitionActionRecord({ id: "action_evidence", expectedState: "proposed", state: "authorized", at: NOW });
    store.transitionActionRecord({ id: "action_evidence", expectedState: "authorized", state: "staging", mutationTransactionId: "mutation_action_evidence", at: NOW });
    const code = store.listObjectFiles({ kind: "model", id: created.id }).find((file) => file.kind === "model_code")!;
    store.mutateModelFiles({ modelId: created.id, transactionId: "mutation_action_evidence", updatedAt: LATER, files: [{ objectFileId: code.id,
      kind: "model_code", relativePath: "model.py", mediaType: code.mediaType, bytes: Buffer.from("a=2\n"), expectedPriorSha256: code.sha256 }] });
    assert.equal(store.transitionActionRecord({ id: "action_evidence", expectedState: "staging", state: "committed", mutationTransactionId: "mutation_action_evidence",
      affectedResources: [{ kind: "model", id: created.id }], at: LATER }).state, "committed");
    store.transitionTemporaryDocument("document_evidence", "adopted", ["action_evidence"], LATER);

    store.startTechnicalCheck({ id: "technical_check_stale", modelId: created.id, limits: { seconds: 1 }, startedAt: LATER });
    const changed = store.listObjectFiles({ kind: "model", id: created.id }).find((file) => file.kind === "model_code")!;
    store.mutateModelFiles({ modelId: created.id, updatedAt: LATER, files: [{ objectFileId: changed.id, kind: "model_code", relativePath: "model.py",
      mediaType: changed.mediaType, bytes: Buffer.from("a=3\n"), expectedPriorSha256: changed.sha256 }] });
    assert.deepEqual(store.finishTechnicalCheck({ id: "technical_check_stale", state: "passed", results: { ok: true }, finishedAt: LATER }), { published: false });
    assert.equal(store.listModels({ includeArchived: true })[0]!.technicalStatus, "draft");
    store.startTechnicalCheck({ id: "technical_check_current", modelId: created.id, limits: { seconds: 1 }, startedAt: LATER });
    assert.deepEqual(store.finishTechnicalCheck({ id: "technical_check_current", state: "passed", results: { ok: true }, finishedAt: LATER }), { published: true });
    assert.equal(store.listModels({ includeArchived: true })[0]!.technicalStatus, "executable");
  } finally { store.close(); rmSync(parent, { recursive: true, force: true }); }
});

test("restart reconciles in-flight turns, sessions, checks, and staged actions from receipts", async () => {
  const parent = mkdtempSync(join(tmpdir(), "riff-v3-reconcile-"));
  const root = join(parent, "store");
  let store = ProductStoreV2.open(root);
  try {
    const created = model("reconcile"); store.createModel(created);
    store.createConversation({ id: "conversation_reconcile", owner: { kind: "model", id: created.id }, name: "Recover", providerId: "p", providerModelId: "m", createdAt: NOW });
    store.startAgentTurn({ turnId: "turn_reconcile", userMessageId: "message_reconcile", conversationId: "conversation_reconcile", requestKey: "recover", text: "Change", createdAt: NOW });
    store.recordAction({ id: "action_reconcile_commit", conversationId: "conversation_reconcile", turnId: "turn_reconcile", actionKind: "replace_model_files",
      intent: { file: "model.py" }, permissionDecision: "allowed", state: "authorized", createdAt: NOW });
    store.transitionActionRecord({ id: "action_reconcile_commit", expectedState: "authorized", state: "staging", mutationTransactionId: "mutation_reconcile_commit", at: NOW });
    store.recordAction({ id: "action_reconcile_rollback", conversationId: "conversation_reconcile", turnId: "turn_reconcile", actionKind: "replace_model_files",
      intent: { file: "missing.py" }, permissionDecision: "allowed", state: "authorized", createdAt: NOW });
    store.transitionActionRecord({ id: "action_reconcile_rollback", expectedState: "authorized", state: "staging", mutationTransactionId: "mutation_reconcile_missing", at: NOW });
    const code = store.listObjectFiles({ kind: "model", id: created.id }).find((file) => file.kind === "model_code")!;
    store.mutateModelFiles({ modelId: created.id, transactionId: "mutation_reconcile_commit", updatedAt: LATER, files: [{ objectFileId: code.id,
      kind: "model_code", relativePath: "model.py", mediaType: code.mediaType, bytes: Buffer.from("recovered\n"), expectedPriorSha256: code.sha256 }] });
    await store.beginSessionGeneration({ conversationId: "conversation_reconcile", expectedGeneration: null });
    store.startTechnicalCheck({ id: "technical_check_interrupted", modelId: created.id, limits: { seconds: 1 }, startedAt: LATER });
    store.close();
    store = ProductStoreV2.open(root);
    const replay = store.startAgentTurn({ turnId: "turn_reconcile", userMessageId: "message_reconcile", conversationId: "conversation_reconcile", requestKey: "recover", text: "Change", createdAt: NOW });
    assert.equal(replay.state, "failed");
    assert.deepEqual(replay.actions.map((action) => [action.id, action.state]), [
      ["action_reconcile_commit", "committed"], ["action_reconcile_rollback", "rolled_back"],
    ]);
    assert.equal((await store.getConversationRuntime("conversation_reconcile"))?.session?.state, "lost");
    assert.equal(store.listModels({ includeArchived: true })[0]!.technicalStatus, "failed");
    assert.equal(store.readObjectFile(code.id).toString("utf8"), "recovered\n");
  } finally { store.close(); rmSync(parent, { recursive: true, force: true }); }
});
