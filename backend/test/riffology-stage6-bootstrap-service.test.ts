import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentWorkspaceService } from "../src/agent-workspace-service.ts";
import type {
  OpenCodeConversationPort,
  OpenCodeProviderModel,
} from "../src/opencode-adapter.ts";
import { ProductStoreV2 } from "../src/product-store-v2.ts";

const NOW = "2026-08-02T02:00:00.000Z";

class CatalogueOnlyOpenCode implements OpenCodeConversationPort {
  readonly failDiscovery: boolean;

  constructor(failDiscovery = false) { this.failDiscovery = failDiscovery; }

  async discoverProviderModels(): Promise<OpenCodeProviderModel[]> {
    if (this.failDiscovery) throw new Error("provider unavailable");
    return [{ providerId: "provider", modelId: "model", qualifiedId: "provider/model" }];
  }

  async getSession(): Promise<boolean> { throw new Error("not used"); }
  async createSession(): Promise<string> { throw new Error("not used"); }
  async injectContext(): Promise<void> { throw new Error("not used"); }
  async promptWithModel(): Promise<never> { throw new Error("not used"); }
  async abort(): Promise<void> { throw new Error("not used"); }
}

test("bootstrap Model creation atomically creates its owner Conversation and WorkspaceBinding receipt", async () => {
  const parent = mkdtempSync(join(tmpdir(), "riff-stage6-bootstrap-model-"));
  const root = join(parent, "store");
  let store: ProductStoreV2 | undefined;
  try {
    store = ProductStoreV2.open(root);
    const service = new AgentWorkspaceService(store, new CatalogueOnlyOpenCode(), () => NOW);
    const created = await service.createWorkspaceBinding({
      commandId: "command_workspace_create",
      workspaceKey: "workspace_model",
    });
    const result = await service.bootstrapCreateModel({
      commandId: "command_bootstrap_model",
      workspaceKey: "workspace_model",
      expectedGeneration: created.binding.generation,
      expectedBindingDigest: created.binding.bindingDigest,
      name: "Bootstrap model",
      providerId: "provider",
      modelId: "model",
    });
    assert.equal(result.binding.state, "bound");
    assert.equal(result.binding.owner?.kind, "model");
    assert.equal(result.binding.conversation.kind, "owner");
    assert.equal(result.receipt.operation, "bind");
    assert.equal(store.listModels().length, 1);
    assert.equal(store.listConversations(result.binding.owner!).length, 1);

    await assert.rejects(service.bootstrapCreateModel({
      commandId: "command_bootstrap_model_stale",
      workspaceKey: "workspace_model",
      expectedGeneration: created.binding.generation,
      expectedBindingDigest: created.binding.bindingDigest,
      name: "Must not exist",
      providerId: "provider",
      modelId: "model",
    }), (error: any) => error?.code === "stale_workspace_binding");
    assert.equal(store.listModels().length, 1);

    store.close();
    store = ProductStoreV2.open(root);
    const readOnly = new AgentWorkspaceService(store, new CatalogueOnlyOpenCode(true), () => NOW);
    const restored = await readOnly.workspaceBinding("workspace_model");
    assert.equal(restored.state, "bound");
    assert.equal(restored.providerMode, "read_only");
    assert.equal(restored.providerReason, "opencode_unavailable");
    assert.match(restored.ownerProjection?.recordDigest ?? "", /^[0-9a-f]{64}$/u);
  } finally {
    store?.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("bootstrap Project creation consumes only a generation-bound opaque source ref", async () => {
  const parent = mkdtempSync(join(tmpdir(), "riff-stage6-bootstrap-project-"));
  let store: ProductStoreV2 | undefined;
  try {
    store = ProductStoreV2.open(join(parent, "store"));
    store.createModel({
      id: "source_model",
      name: "Executable source",
      technicalStatus: "executable",
      runMode: "batch",
      executionDescription: {},
      createdAt: NOW,
      files: [{
        id: "source_file",
        kind: "model_code",
        relativePath: "model.py",
        mediaType: "text/x-python",
        bytes: Buffer.from("print('ok')\n"),
      }],
    });
    const service = new AgentWorkspaceService(store, new CatalogueOnlyOpenCode(), () => NOW);
    const first = await service.createWorkspaceBinding({
      commandId: "command_project_workspace",
      workspaceKey: "workspace_project",
    });
    const inventory = await service.workspaceBootstrapInventory("workspace_project");
    const source = inventory.objects.find((item) => item.kind === "model");
    assert.ok(source);
    assert.equal(JSON.stringify(inventory).includes("source_model"), false);

    const other = await service.createWorkspaceBinding({
      commandId: "command_other_workspace",
      workspaceKey: "workspace_other",
    });
    await assert.rejects(service.bootstrapCreateProject({
      commandId: "command_cross_workspace_project",
      workspaceKey: "workspace_other",
      expectedGeneration: other.binding.generation,
      expectedBindingDigest: other.binding.bindingDigest,
      name: "Cross workspace",
      sourceModelRef: source.objectRef,
      providerId: "provider",
      modelId: "model",
    }), (error: any) => error?.code === "stale_object_ref");

    const result = await service.bootstrapCreateProject({
      commandId: "command_bootstrap_project",
      workspaceKey: "workspace_project",
      expectedGeneration: first.binding.generation,
      expectedBindingDigest: first.binding.bindingDigest,
      name: "Bootstrap project",
      sourceModelRef: source.objectRef,
      providerId: "provider",
      modelId: "model",
    });
    assert.equal(result.binding.state, "bound");
    assert.equal(result.binding.owner?.kind, "project");
    assert.equal(result.binding.conversation.kind, "owner");
    assert.equal(store.listProjects().length, 1);
    const project = store.listProjects()[0]!;
    assert.equal(project.sourceModelId, "source_model");
    assert.equal(store.listConversations({ kind: "project", id: project.id }).length, 1);
  } finally {
    store?.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("provider-down permits only local unbound draft persistence and denies every Riff bootstrap write", async () => {
  const parent = mkdtempSync(join(tmpdir(), "riff-stage6-bootstrap-provider-down-"));
  let store: ProductStoreV2 | undefined;
  try {
    store = ProductStoreV2.open(join(parent, "store"));
    store.createModel({
      id: "source_provider_down", name: "Existing source",
      technicalStatus: "executable", runMode: "batch",
      executionDescription: {}, createdAt: NOW,
      files: [{
        id: "file_provider_down", kind: "model_code",
        relativePath: "model.py", mediaType: "text/x-python",
        bytes: Buffer.from("print('ok')\n"),
      }],
    });
    const live = new AgentWorkspaceService(
      store, new CatalogueOnlyOpenCode(), () => NOW,
    );
    const created = await live.createWorkspaceBinding({
      commandId: "workspace_provider_down_create",
      workspaceKey: "workspace_provider_down",
    });
    const selected = await live.updateWorkspaceBinding({
      commandId: "workspace_provider_down_select",
      workspaceKey: "workspace_provider_down",
      expectedGeneration: created.binding.generation,
      expectedBindingDigest: created.binding.bindingDigest,
      draft: "Initial local draft",
      provider: { providerId: "provider", modelId: "model" },
    });

    const unavailable = new AgentWorkspaceService(
      store, new CatalogueOnlyOpenCode(true), () => NOW,
    );
    const drafted = await unavailable.updateWorkspaceBinding({
      commandId: "workspace_provider_down_draft",
      workspaceKey: "workspace_provider_down",
      expectedGeneration: selected.binding.generation,
      expectedBindingDigest: selected.binding.bindingDigest,
      draft: "Locally persisted while OpenCode is unavailable",
    });
    assert.equal(drafted.binding.state, "unbound");
    assert.equal(drafted.binding.providerMode, "read_only");
    assert.equal(drafted.binding.draft, "Locally persisted while OpenCode is unavailable");
    assert.equal(drafted.receipt.operation, "update_draft");

    const inventory = await unavailable.workspaceBootstrapInventory(
      "workspace_provider_down",
    );
    assert.equal(inventory.providerMode, "read_only");
    assert.deepEqual(inventory.providers, []);
    const source = inventory.objects.find((item) => item.kind === "model");
    assert.ok(source);

    const common = {
      workspaceKey: "workspace_provider_down",
      expectedGeneration: drafted.binding.generation,
      expectedBindingDigest: drafted.binding.bindingDigest,
      providerId: "provider",
      modelId: "model",
    };
    await assert.rejects(unavailable.bootstrapCreateModel({
      ...common,
      commandId: "provider_down_create_model",
      name: "Must not exist",
    }), (error: any) => error?.code === "opencode_unavailable");
    await assert.rejects(unavailable.bootstrapBindOwner({
      ...common,
      commandId: "provider_down_bind_owner",
      objectRef: source.objectRef,
    }), (error: any) => error?.code === "opencode_unavailable");

    const turn = await unavailable.runWorkspaceBootstrapTurn({
      workspaceKey: "workspace_provider_down",
      requestKey: "provider_down_turn",
      expectedGeneration: drafted.binding.generation,
      expectedBindingDigest: drafted.binding.bindingDigest,
      text: "Create a Model",
    });
    assert.equal(turn.mode, "read_only");
    assert.equal(turn.reason, "opencode_unavailable");
    assert.equal(turn.assistantText, null);
    assert.equal(store.listModels().length, 1);
    assert.equal(store.listProjects().length, 0);
    assert.equal(store.getWorkspaceBinding("workspace_provider_down").state, "unbound");
  } finally {
    store?.close();
    rmSync(parent, { recursive: true, force: true });
  }
});
