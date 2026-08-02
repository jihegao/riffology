import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalDigest } from "../src/canonical-json-v2.ts";
import { ProductStoreV2 } from "../src/product-store-v2.ts";
import { WorkspaceBootstrapMcpServer } from "../src/workspace-bootstrap-mcp.ts";

const T0 = "2026-08-02T06:00:00.000Z";
const T1 = "2026-08-02T06:01:00.000Z";
const T2 = "2026-08-02T06:02:00.000Z";

for (const kind of ["model", "project"] as const) {
  test(`bound ${kind} permanent delete recovery is atomic, durable, and generation-fenced`, async () => {
    const parent = mkdtempSync(join(tmpdir(), `riff-binding-delete-${kind}-`));
    const root = join(parent, "store");
    let store = ProductStoreV2.open(root);
    try {
      store.createModel({
        id: "model_delete_binding",
        name: "Source",
        technicalStatus: kind === "project" ? "executable" : "draft",
        runMode: "batch",
        executionDescription: {},
        createdAt: T0,
        files: [{
          id: "file_delete_binding",
          kind: "model_code",
          relativePath: "model.py",
          mediaType: "text/x-python",
          bytes: Buffer.from("print('delete')\n"),
        }],
      });
      if (kind === "project") {
        store.createProjectFromModel({
          projectId: "project_delete_binding",
          projectName: "Project",
          sourceModelId: "model_delete_binding",
          createdAt: T0,
        });
      }
      const owner = {
        kind,
        id: kind === "model" ? "model_delete_binding" : "project_delete_binding",
      } as const;
      const conversationId = `conversation_delete_${kind}`;
      store.createConversation({
        id: conversationId,
        owner,
        name: "Bound",
        providerId: "provider",
        providerModelId: "model",
        createdAt: T0,
      });
      const created = store.createWorkspaceBinding({
        commandId: `command_create_binding_${kind}`,
        workspaceKey: `workspace_delete_${kind}`,
        createdAt: T0,
      });
      const staleCapabilityServer = new WorkspaceBootstrapMcpServer({
        executeWorkspaceBootstrapTool: async (grant) => {
          const current = store.getWorkspaceBinding(grant.workspaceKey);
          if (current.state !== "unbound"
            || current.generation !== grant.generation
            || current.bindingDigest !== grant.bindingDigest) {
            throw new Error("stale workspace bootstrap capability");
          }
          return { ok: true };
        },
      });
      const staleCapability = staleCapabilityServer.grant({
        workspaceKey: created.binding.workspaceKey,
        conversationId: created.binding.conversation.id,
        generation: created.binding.generation,
        bindingDigest: created.binding.bindingDigest,
        turnId: `turn_delete_${kind}`,
        allowedTools: new Set(["riff_bootstrap_list_objects"]),
        providerRef: "provider_stale_capability",
        operationCommitmentDigest: "a".repeat(64),
      });
      const bound = store.bindWorkspaceOwner({
        commandId: `command_bind_${kind}`,
        workspaceKey: created.binding.workspaceKey,
        expectedGeneration: created.binding.generation,
        expectedBindingDigest: created.binding.bindingDigest,
        owner,
        conversationId,
        committedAt: T1,
      });
      store.trashResource(kind, owner.id, T1);
      const preview = store.previewPermanentDelete(kind, owner.id);
      assert.deepEqual(preview.blockingReferences, []);
      const canonicalIntentDigest = canonicalDigest({
        kind,
        id: owner.id,
        previewToken: preview.previewToken,
        stateToken: preview.stateToken,
        confirmation: {
          action: "permanently_delete",
          kind,
          id: owner.id,
          recordCount: preview.records.length,
          fileCount: preview.files.length,
          totalBytes: preview.totalBytes,
        },
      });
      const deleteReceipt = store.commitPermanentDelete({
        commandId: `command_permanent_delete_${kind}`,
        kind,
        id: owner.id,
        previewToken: preview.previewToken,
        stateToken: preview.stateToken,
        canonicalIntentDigest,
        committedAt: T2,
      });
      assert.equal(deleteReceipt.workspaceRecoveryReceipts.length, 1);
      const evidence = deleteReceipt.workspaceRecoveryReceipts[0]!;
      const recovered = store.getWorkspaceBinding(created.binding.workspaceKey);
      assert.equal(recovered.state, "recovery_required");
      assert.equal(recovered.generation, bound.binding.generation + 1);
      assert.equal(recovered.owner, null);
      assert.equal(recovered.conversation.kind, "bootstrap");
      assert.equal(evidence.workspaceKey, recovered.workspaceKey);
      const recoveryReceipt = store.getWorkspaceBindingReceipt(evidence.commandId)!;
      assert.equal(recoveryReceipt.operation, "recover_owner_deleted");
      assert.equal(recoveryReceipt.bindingDigest, recovered.bindingDigest);
      assert.equal(recoveryReceipt.receiptDigest, evidence.receiptDigest);
      assert.deepEqual(recoveryReceipt.recoveryCause, {
        action: "permanently_delete",
        commandId: `command_permanent_delete_${kind}`,
        owner,
      });
      assert.throws(() => store.updateWorkspaceBindingDraft({
        commandId: `command_stale_draft_${kind}`,
        workspaceKey: recovered.workspaceKey,
        expectedGeneration: bound.binding.generation,
        expectedBindingDigest: bound.binding.bindingDigest,
        draft: "revive",
        updatedAt: T2,
      }), /stale_workspace_generation/u);
      const denied: any = await staleCapabilityServer.handle(staleCapability, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "riff_bootstrap_list_objects", arguments: {} },
      });
      assert.equal(denied.result.isError, true);

      store.close();
      store = ProductStoreV2.open(root);
      assert.deepEqual(store.getWorkspaceBinding(recovered.workspaceKey), recovered);
      assert.deepEqual(store.getWorkspaceBindingReceipt(evidence.commandId), recoveryReceipt);
      assert.deepEqual(store.permanentDeleteReceipt(
        `command_permanent_delete_${kind}`,
        kind,
        owner.id,
        canonicalIntentDigest,
      ), deleteReceipt);
      assert.equal(kind === "model"
        ? store.listModels({ includeArchived: true, includeTrashed: true }).length
        : store.listProjects({ includeArchived: true, includeTrashed: true }).length,
      0);
    } finally {
      store.close();
      rmSync(parent, { recursive: true, force: true });
    }
  });
}

test("bound Conversation permanent delete atomically recovers and fences its WorkspaceBinding", () => {
  const parent = mkdtempSync(join(tmpdir(), "riff-binding-delete-conversation-"));
  const root = join(parent, "store");
  let store = ProductStoreV2.open(root);
  try {
    store.createModel({
      id: "model_conversation_delete",
      name: "Conversation owner",
      technicalStatus: "draft",
      runMode: "batch",
      executionDescription: {},
      createdAt: T0,
      files: [{
        id: "file_conversation_delete",
        kind: "model_code",
        relativePath: "model.py",
        mediaType: "text/x-python",
        bytes: Buffer.from("print('conversation')\n"),
      }],
    });
    const owner = { kind: "model" as const, id: "model_conversation_delete" };
    store.createConversation({
      id: "conversation_delete_bound",
      owner,
      name: "Bound conversation",
      providerId: "provider",
      providerModelId: "model",
      createdAt: T0,
    });
    const created = store.createWorkspaceBinding({
      commandId: "command_create_conversation_binding",
      workspaceKey: "workspace_delete_conversation",
      createdAt: T0,
    });
    const bound = store.bindWorkspaceOwner({
      commandId: "command_bind_conversation",
      workspaceKey: created.binding.workspaceKey,
      expectedGeneration: created.binding.generation,
      expectedBindingDigest: created.binding.bindingDigest,
      owner,
      conversationId: "conversation_delete_bound",
      committedAt: T1,
    });
    store.trashResource("conversation", "conversation_delete_bound", T1);
    const preview = store.previewPermanentDelete(
      "conversation", "conversation_delete_bound",
    );
    assert.deepEqual(preview.blockingReferences, []);
    const canonicalIntentDigest = canonicalDigest({
      kind: "conversation",
      id: "conversation_delete_bound",
      previewToken: preview.previewToken,
      stateToken: preview.stateToken,
      confirmation: {
        action: "permanently_delete",
        kind: "conversation",
        id: "conversation_delete_bound",
        recordCount: preview.records.length,
        fileCount: preview.files.length,
        totalBytes: preview.totalBytes,
      },
    });
    const deleted = store.commitPermanentDelete({
      commandId: "command_permanent_delete_conversation",
      kind: "conversation",
      id: "conversation_delete_bound",
      previewToken: preview.previewToken,
      stateToken: preview.stateToken,
      canonicalIntentDigest,
      committedAt: T2,
    });
    assert.equal(deleted.workspaceRecoveryReceipts.length, 1);
    const recovered = store.getWorkspaceBinding(created.binding.workspaceKey);
    assert.equal(recovered.state, "recovery_required");
    assert.equal(recovered.generation, bound.binding.generation + 1);
    assert.equal(recovered.owner, null);
    assert.equal(recovered.conversation.kind, "bootstrap");
    assert.throws(() => store.bindWorkspaceOwner({
      commandId: "command_stale_rebind_conversation",
      workspaceKey: recovered.workspaceKey,
      expectedGeneration: bound.binding.generation,
      expectedBindingDigest: bound.binding.bindingDigest,
      owner,
      conversationId: "conversation_delete_bound",
      committedAt: T2,
    }), /does not exist|stale_workspace_generation/u);

    store.close();
    store = ProductStoreV2.open(root);
    assert.deepEqual(store.getWorkspaceBinding(recovered.workspaceKey), recovered);
    assert.throws(() => store.getConversation("conversation_delete_bound"), /does not exist/u);
    store.createConversation({
      id: "conversation_rebind_after_delete",
      owner,
      name: "Replacement",
      providerId: "provider",
      providerModelId: "model",
      createdAt: T2,
    });
    const replacement = store.createWorkspaceBinding({
      commandId: "command_create_replacement_binding",
      workspaceKey: "workspace_rebind_after_delete",
      createdAt: T2,
    });
    const rebound = store.bindWorkspaceOwner({
      commandId: "command_rebind_after_delete",
      workspaceKey: replacement.binding.workspaceKey,
      expectedGeneration: replacement.binding.generation,
      expectedBindingDigest: replacement.binding.bindingDigest,
      owner,
      conversationId: "conversation_rebind_after_delete",
      committedAt: T2,
    });
    assert.equal(rebound.binding.state, "bound");
  } finally {
    store.close();
    rmSync(parent, { recursive: true, force: true });
  }
});
