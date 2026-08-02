import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { ProductStoreV2 } from "../src/product-store-v2.ts";

const T0 = "2026-08-02T01:00:00.000Z";
const T1 = "2026-08-02T01:01:00.000Z";
const T2 = "2026-08-02T01:02:00.000Z";

test("WorkspaceBinding is durable, generation-fenced, owner-scoped, and receipt-backed", () => {
  const parent = mkdtempSync(join(tmpdir(), "riff-stage6-binding-"));
  const root = join(parent, "store");
  let store: ProductStoreV2 | undefined;
  try {
    store = ProductStoreV2.open(root);
    const created = store.createWorkspaceBinding({
      commandId: "command_workspace_create",
      workspaceKey: "workspace_alpha",
      createdAt: T0,
    });
    assert.equal(created.binding.state, "unbound");
    assert.equal(created.binding.generation, 1);
    assert.equal(created.binding.conversation.kind, "bootstrap");
    assert.match(created.binding.bindingDigest, /^[0-9a-f]{64}$/u);
    assert.equal(created.receipt.previousGeneration, null);
    assert.match(created.receipt.receiptDigest, /^[0-9a-f]{64}$/u);

    const drafted = store.updateWorkspaceBindingDraft({
      commandId: "command_workspace_draft",
      workspaceKey: "workspace_alpha",
      expectedGeneration: 1,
      expectedBindingDigest: created.binding.bindingDigest,
      draft: "建立一个通用离散事件模型",
      provider: { providerId: "provider", modelId: "model" },
      updatedAt: T1,
    });
    assert.equal(drafted.binding.generation, 2);
    assert.equal(drafted.binding.draft, "建立一个通用离散事件模型");
    assert.deepEqual(drafted.binding.provider, {
      providerId: "provider",
      modelId: "model",
    });
    assert.throws(() => store!.updateWorkspaceBindingDraft({
      commandId: "command_workspace_stale",
      workspaceKey: "workspace_alpha",
      expectedGeneration: 1,
      expectedBindingDigest: created.binding.bindingDigest,
      draft: "stale",
      updatedAt: T2,
    }), /stale_workspace_generation/u);

    store.createModel({
      id: "model_alpha",
      name: "Alpha",
      technicalStatus: "draft",
      runMode: "batch",
      executionDescription: {},
      createdAt: T1,
      files: [{
        id: "file_model_alpha",
        kind: "model_code",
        relativePath: "model.py",
        mediaType: "text/x-python",
        bytes: Buffer.from("print('alpha')\n"),
      }],
    });
    store.createConversation({
      id: "conversation_alpha",
      owner: { kind: "model", id: "model_alpha" },
      name: "Main",
      providerId: "provider",
      providerModelId: "model",
      createdAt: T1,
    });
    store.createModel({
      id: "model_beta",
      name: "Beta",
      technicalStatus: "draft",
      runMode: "batch",
      executionDescription: {},
      createdAt: T1,
      files: [{
        id: "file_model_beta",
        kind: "model_code",
        relativePath: "model.py",
        mediaType: "text/x-python",
        bytes: Buffer.from("print('beta')\n"),
      }],
    });
    assert.throws(() => store!.bindWorkspaceOwner({
      commandId: "command_workspace_cross_owner",
      workspaceKey: "workspace_alpha",
      expectedGeneration: 2,
      expectedBindingDigest: drafted.binding.bindingDigest,
      owner: { kind: "model", id: "model_beta" },
      conversationId: "conversation_alpha",
      committedAt: T2,
    }), /does not belong/u);

    const bound = store.bindWorkspaceOwner({
      commandId: "command_workspace_bind",
      workspaceKey: "workspace_alpha",
      expectedGeneration: 2,
      expectedBindingDigest: drafted.binding.bindingDigest,
      owner: { kind: "model", id: "model_alpha" },
      conversationId: "conversation_alpha",
      committedAt: T2,
    });
    assert.equal(bound.binding.state, "bound");
    assert.equal(bound.binding.generation, 3);
    assert.deepEqual(bound.binding.owner, { kind: "model", id: "model_alpha" });
    assert.equal(bound.receipt.ownerRecordDigest?.length, 64);
    assert.equal(JSON.stringify(bound).includes("externalSession"), false);
    assert.equal(JSON.stringify(bound).includes("workspacePath"), false);

    store.close();
    store = ProductStoreV2.open(root);
    assert.deepEqual(store.getWorkspaceBinding("workspace_alpha"), bound.binding);
    const conversationBeforeProjectionChange = store.getConversation("conversation_alpha");
    store.executeLifecycleCommand({
      commandId: "command_rename_bound_conversation",
      action: "rename",
      kind: "conversation",
      id: "conversation_alpha",
      expectedRecordDigest: conversationBeforeProjectionChange.recordDigest,
      name: "Renamed conversation",
      committedAt: T2,
    });
    const renamedConversation = store.getConversation("conversation_alpha");
    store.changeConversationProviderCommand({
      commandId: "command_provider_bound_conversation",
      conversationId: "conversation_alpha",
      expectedRecordDigest: renamedConversation.recordDigest,
      providerId: "provider-next",
      providerModelId: "model-next",
      committedAt: T2,
    });
    const projected = store.getWorkspaceBinding("workspace_alpha");
    assert.equal(projected.generation, bound.binding.generation);
    assert.equal(projected.bindingDigest, bound.binding.bindingDigest,
      "display-only Conversation name/provider projection cannot drift the binding CAS digest");
    assert.equal(projected.conversation.name, "Renamed conversation");
    assert.deepEqual(projected.conversation.provider, {
      providerId: "provider-next", modelId: "model-next",
    });
    const replay = store.bindWorkspaceOwner({
      commandId: "command_workspace_bind",
      workspaceKey: "workspace_alpha",
      expectedGeneration: 2,
      expectedBindingDigest: drafted.binding.bindingDigest,
      owner: { kind: "model", id: "model_alpha" },
      conversationId: "conversation_alpha",
      committedAt: T2,
    });
    assert.equal(replay.receipt.receiptDigest, bound.receipt.receiptDigest);
    assert.equal(replay.binding.generation, 3);
    assert.equal(replay.binding.bindingDigest, bound.binding.bindingDigest);
  } finally {
    store?.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("WorkspaceBinding startup audit rejects state without matching latest receipt", () => {
  const parent = mkdtempSync(join(tmpdir(), "riff-stage6-binding-audit-"));
  const root = join(parent, "store");
  const store = ProductStoreV2.open(root);
  try {
    store.createWorkspaceBinding({
      commandId: "command_workspace_audit_create",
      workspaceKey: "workspace_audit",
      createdAt: T0,
    });
  } finally { store.close(); }
  const database = new DatabaseSync(join(root, "product.sqlite3"));
  try {
    database.prepare(
      "UPDATE workspace_bindings SET draft_text = ? WHERE workspace_key = ?",
    ).run("unreceipted drift", "workspace_audit");
  } finally { database.close(); }
  try {
    assert.throws(
      () => ProductStoreV2.open(root),
      /lacks matching receipt evidence/u,
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
