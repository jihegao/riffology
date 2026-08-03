import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentWorkspaceService } from "../src/agent-workspace-service.ts";
import { WORKSPACE_BOOTSTRAP_TOOLS, type AgentToolName } from "../src/agent-tools.ts";
import type {
  OpenCodeAssistantResponse,
  OpenCodeConversationPort,
  OpenCodePrompt,
  OpenCodeProviderModel,
  OpenCodeWorkspaceBinding,
} from "../src/opencode-adapter.ts";
import { ProductStoreV2 } from "../src/product-store-v2.ts";
import {
  WorkspaceBootstrapMcpServer,
  workspaceBootstrapOperationCommitment,
} from "../src/workspace-bootstrap-mcp.ts";

const NOW = "2026-08-02T03:00:00.000Z";
const stableId = (prefix: string, value: string) =>
  `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;

class BootstrapOpenCode implements OpenCodeConversationPort {
  readonly sessions = new Set<string>();
  readonly workspaces: OpenCodeWorkspaceBinding[] = [];
  readonly allowedTools: readonly AgentToolName[][] = [];
  createCount = 0;
  promptCount = 0;
  capability: string | null = null;
  service: AgentWorkspaceService | null = null;
  createOwner = false;
  createName = "Agent-created Model";
  failPrompt = false;
  abortCount = 0;

  async discoverProviderModels(): Promise<OpenCodeProviderModel[]> {
    return [
      { providerId: "provider", modelId: "model", qualifiedId: "provider/model" },
      { providerId: "alternate", modelId: "other", qualifiedId: "alternate/other" },
    ];
  }
  async getSession(sessionId: string, workspace: OpenCodeWorkspaceBinding): Promise<boolean> {
    this.workspaces.push(workspace);
    return this.sessions.has(sessionId);
  }
  async createSession(_conversationId: string, workspace: OpenCodeWorkspaceBinding): Promise<string> {
    this.workspaces.push(workspace);
    const id = `opaque-bootstrap-${++this.createCount}`;
    this.sessions.add(id);
    return id;
  }
  async injectContext(
    _sessionId: string,
    _context: string,
    _signal: AbortSignal | undefined,
    workspace: OpenCodeWorkspaceBinding,
  ): Promise<void> { this.workspaces.push(workspace); }
  async bindScopedMcp(
    _scopeId: string,
    mcpUrl: string,
    allowedTools: readonly AgentToolName[],
    workspace: OpenCodeWorkspaceBinding,
  ): Promise<void> {
    this.workspaces.push(workspace);
    this.allowedTools.push([...allowedTools]);
    this.capability = new URL(mcpUrl).searchParams.get("cap");
  }
  async unbindScopedMcp(): Promise<void> {}
  async promptWithModel(
    _sessionId: string,
    _binding: { providerId: string; modelId: string },
    prompt: OpenCodePrompt,
    _signal: AbortSignal | undefined,
    workspace: OpenCodeWorkspaceBinding,
  ): Promise<OpenCodeAssistantResponse> {
    this.workspaces.push(workspace);
    this.promptCount += 1;
    if (this.failPrompt) throw new Error("upstream busy");
    assert.deepEqual(prompt.scopedMcpTools, this.createOwner
      ? ["riff_bootstrap_create_model", "riff_bootstrap_list_objects"]
      : ["riff_bootstrap_list_objects"]);
    assert.ok(this.capability);
    if (this.createOwner) {
      const listed: any = await this.service!.handleAgentMcp(this.capability!, {
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "riff_bootstrap_list_objects", arguments: {} },
      });
      const inventory = JSON.parse(listed.result.content[0].text);
      assert.deepEqual(inventory.providers.map((item: any) => item.qualifiedId), [
        "provider/model",
      ]);
      const alternate: any = await this.service!.handleAgentMcp(this.capability!, {
        jsonrpc: "2.0", id: 11, method: "tools/call",
        params: { name: "riff_bootstrap_create_model", arguments: {
          requestKey: "alternate_provider",
          name: "Must not exist",
          providerRef: `provider_${"0".repeat(48)}`,
          expectedGeneration: inventory.generation,
          expectedBindingDigest: inventory.bindingDigest,
        } },
      });
      assert.equal(alternate.result.isError, true);
      assert.match(alternate.result.content[0].text, /selected WorkspaceBinding provider/u);
      const renamed: any = await this.service!.handleAgentMcp(this.capability!, {
        jsonrpc: "2.0", id: 12, method: "tools/call",
        params: { name: "riff_bootstrap_create_model", arguments: {
          requestKey: "substituted_name",
          name: "Substituted Model",
          providerRef: inventory.providers[0].providerRef,
          expectedGeneration: inventory.generation,
          expectedBindingDigest: inventory.bindingDigest,
        } },
      });
      assert.equal(renamed.result.isError, true);
      assert.match(renamed.result.content[0].text, /exact commitment/u);
      const denied: any = await this.service!.handleAgentMcp(this.capability!, {
        jsonrpc: "2.0", id: 2, method: "tools/call",
        params: { name: "riff_bootstrap_create_model", arguments: {
          requestKey: "tool_forbidden",
          name: "Forbidden",
          providerRef: inventory.providers[0].providerRef,
          expectedGeneration: inventory.generation,
          expectedBindingDigest: inventory.bindingDigest,
          modelId: "must-not-be-accepted",
        } },
      });
      assert.equal(denied.result.isError, true);
      assert.match(denied.result.content[0].text, /server-owned scope/u);
      const created: any = await this.service!.handleAgentMcp(this.capability!, {
        jsonrpc: "2.0", id: 3, method: "tools/call",
        params: { name: "riff_bootstrap_create_model", arguments: {
          requestKey: "tool_create_model",
          name: this.createName,
          providerRef: inventory.providers[0].providerRef,
          expectedGeneration: inventory.generation,
          expectedBindingDigest: inventory.bindingDigest,
        } },
      });
      assert.equal(created.result.isError, undefined);
    }
    return {
      messageId: `assistant-${this.promptCount}`,
      text: `guide:${this.promptCount}`,
      content: { source: "opencode", textParts: 1, parts: [{ ordinal: 0, kind: "text", state: "complete" }] },
    };
  }
  async abort(): Promise<void> { this.abortCount += 1; }
}

const serviceFor = (store: ProductStoreV2, openCode: BootstrapOpenCode) => {
  const service = new AgentWorkspaceService(
    store, openCode, () => NOW, undefined, undefined,
    (capability) => `http://127.0.0.1:8765/a2/mcp?cap=${encodeURIComponent(capability)}`,
  );
  openCode.service = service;
  return service;
};

test("one bootstrap mutation capability is consumed before concurrent execution", async () => {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let calls = 0;
  const server = new WorkspaceBootstrapMcpServer({
    async executeWorkspaceBootstrapTool() {
      calls += 1;
      entered();
      await gate;
      return { ok: true };
    },
  });
  const bindingDigest = "a".repeat(64);
  const providerRef = "provider_selected";
  const committedInput = {
    name: "Budget Model", providerRef, expectedGeneration: 2,
    expectedBindingDigest: bindingDigest,
  };
  const capability = server.grant({
    workspaceKey: "workspace_budget",
    conversationId: "conversation_budget",
    generation: 2,
    bindingDigest,
    turnId: "turn_budget",
    allowedTools: new Set(["riff_bootstrap_create_model"]),
    providerRef,
    operationCommitmentDigest: workspaceBootstrapOperationCommitment(
      "riff_bootstrap_create_model", committedInput,
    ),
  });
  const mutation = (requestKey: string) => ({
    jsonrpc: "2.0", id: requestKey, method: "tools/call",
    params: { name: "riff_bootstrap_create_model", arguments: {
      requestKey,
      name: "Budget Model",
      providerRef,
      expectedGeneration: 2,
      expectedBindingDigest: bindingDigest,
    } },
  });

  const first = server.handle(capability, mutation("create_first"));
  await started;
  const concurrent = await server.handle(capability, mutation("create_concurrent"));
  assert.equal((concurrent?.result as any).isError, true);
  assert.match((concurrent?.result as any).content[0].text, /operation_budget_exhausted/u);
  assert.equal(calls, 1);
  release();
  assert.equal(((await first)?.result as any).isError, undefined);
  const sequential = await server.handle(capability, mutation("create_after_success"));
  assert.equal((sequential?.result as any).isError, true);
  assert.match((sequential?.result as any).content[0].text, /operation_budget_exhausted/u);
  assert.equal(calls, 1);
});

test("a failed bootstrap mutation still consumes the capability budget", async () => {
  let calls = 0;
  const server = new WorkspaceBootstrapMcpServer({
    async executeWorkspaceBootstrapTool() {
      calls += 1;
      throw new Error("bounded failure");
    },
  });
  const bindingDigest = "c".repeat(64);
  const providerRef = "provider_selected";
  const committedInput = {
    objectRef: "owner_existing", providerRef, expectedGeneration: 1,
    expectedBindingDigest: bindingDigest,
  };
  const capability = server.grant({
    workspaceKey: "workspace_failed_budget",
    conversationId: "conversation_failed_budget",
    generation: 1,
    bindingDigest,
    turnId: "turn_failed_budget",
    allowedTools: new Set(["riff_bootstrap_bind_owner"]),
    providerRef,
    operationCommitmentDigest: workspaceBootstrapOperationCommitment(
      "riff_bootstrap_bind_owner", committedInput,
    ),
  });
  const bind = (requestKey: string) => ({
    jsonrpc: "2.0", id: requestKey, method: "tools/call",
    params: { name: "riff_bootstrap_bind_owner", arguments: {
      requestKey,
      objectRef: "owner_existing",
      providerRef,
      expectedGeneration: 1,
      expectedBindingDigest: bindingDigest,
    } },
  });

  const failed = await server.handle(capability, bind("bind_first"));
  assert.equal((failed?.result as any).isError, true);
  assert.match((failed?.result as any).content[0].text, /tool_failed/u);
  const retry = await server.handle(capability, bind("bind_retry"));
  assert.equal((retry?.result as any).isError, true);
  assert.match((retry?.result as any).content[0].text, /operation_budget_exhausted/u);
  assert.equal(calls, 1);
});

test("bootstrap Project permission binds exact name, source, and provider parameters", async () => {
  let calls = 0;
  const server = new WorkspaceBootstrapMcpServer({
    async executeWorkspaceBootstrapTool() { calls += 1; return { ok: true }; },
  });
  const bindingDigest = "e".repeat(64);
  const approved = {
    requestKey: "create_project",
    name: "Approved Project",
    sourceModelRef: `object_${"1".repeat(48)}`,
    providerRef: `provider_${"2".repeat(48)}`,
    expectedGeneration: 3,
    expectedBindingDigest: bindingDigest,
  };
  const capability = server.grant({
    workspaceKey: "workspace_project_exact",
    conversationId: "conversation_project_exact",
    generation: 3,
    bindingDigest,
    turnId: "turn_project_exact",
    allowedTools: new Set(["riff_bootstrap_create_project"]),
    providerRef: approved.providerRef,
    operationCommitmentDigest: workspaceBootstrapOperationCommitment(
      "riff_bootstrap_create_project", approved,
    ),
  });
  for (const input of [
    { ...approved, name: "Substituted Project" },
    { ...approved, sourceModelRef: `object_${"3".repeat(48)}` },
    { ...approved, providerRef: `provider_${"4".repeat(48)}` },
  ]) {
    const response = await server.handle(capability, {
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "riff_bootstrap_create_project", arguments: input },
    });
    assert.equal((response?.result as any).isError, true);
  }
  assert.equal(calls, 0);
  const accepted = await server.handle(capability, {
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "riff_bootstrap_create_project", arguments: approved },
  });
  assert.equal((accepted?.result as any).isError, undefined);
  assert.equal(calls, 1);
});

test("bootstrap turn exposes only exact capability tools and atomically binds a tool-created owner", async () => {
  const parent = mkdtempSync(join(tmpdir(), "riff-stage6-bootstrap-turn-"));
  let store: ProductStoreV2 | undefined;
  try {
    store = ProductStoreV2.open(join(parent, "store"));
    const openCode = new BootstrapOpenCode();
    openCode.createOwner = true;
    const service = serviceFor(store, openCode);
    const created = await service.createWorkspaceBinding({
      commandId: "workspace_create", workspaceKey: "workspace_turn",
    });
    const selected = await service.updateWorkspaceBinding({
      commandId: "workspace_provider",
      workspaceKey: "workspace_turn",
      expectedGeneration: created.binding.generation,
      expectedBindingDigest: created.binding.bindingDigest,
      draft: "Create a Model named Agent-created Model",
      provider: { providerId: "provider", modelId: "model" },
    });
    const result = await service.runWorkspaceBootstrapTurn({
      workspaceKey: "workspace_turn",
      requestKey: "turn_create",
      expectedGeneration: selected.binding.generation,
      expectedBindingDigest: selected.binding.bindingDigest,
      text: "Create a Model named Agent-created Model.",
    });
    assert.equal(result.mode, "live");
    assert.equal(result.binding.state, "bound");
    assert.equal(result.binding.owner?.kind, "model");
    const turnId = stableId(
      "bootstrap_turn", "workspace_turn:turn_create",
    );
    const serverCommandId = stableId(
      "command", `workspace-bootstrap:${turnId}`,
    );
    assert.equal(
      result.binding.owner?.id,
      stableId("model", serverCommandId),
      "model-supplied requestKey must not control durable command identity",
    );
    assert.deepEqual(openCode.allowedTools[0], [
      "riff_bootstrap_create_model", "riff_bootstrap_list_objects",
    ]);
    assert.ok(openCode.workspaces.every((workspace) =>
      workspace.owner.kind === "workspace"
      && workspace.owner.id === "workspace_turn"
      && workspace.directory.startsWith(join(store!.root, "workspace-bootstrap")))),
    assert.equal(JSON.stringify(result).includes("directory"), false);
    assert.equal(JSON.stringify(result).includes("externalSession"), false);
    assert.deepEqual(result.binding.bootstrapMessages.map((message) => message.role), ["user", "assistant"]);
  } finally {
    store?.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("unbound bootstrap conversation is durable across turns and Store restart", async () => {
  const parent = mkdtempSync(join(tmpdir(), "riff-stage6-bootstrap-multiturn-"));
  const root = join(parent, "store");
  let store: ProductStoreV2 | undefined;
  try {
    const openCode = new BootstrapOpenCode();
    store = ProductStoreV2.open(root);
    let service = serviceFor(store, openCode);
    const created = await service.createWorkspaceBinding({
      commandId: "workspace_multi_create", workspaceKey: "workspace_multi",
    });
    const selected = await service.updateWorkspaceBinding({
      commandId: "workspace_multi_provider",
      workspaceKey: "workspace_multi",
      expectedGeneration: created.binding.generation,
      expectedBindingDigest: created.binding.bindingDigest,
      draft: "Discuss first",
      provider: { providerId: "provider", modelId: "model" },
    });
    await service.runWorkspaceBootstrapTurn({
      workspaceKey: "workspace_multi", requestKey: "turn_one",
      expectedGeneration: selected.binding.generation,
      expectedBindingDigest: selected.binding.bindingDigest,
      text: "First question",
    });
    store.close();
    store = ProductStoreV2.open(root);
    service = serviceFor(store, openCode);
    const restored = await service.workspaceBinding("workspace_multi");
    assert.equal(restored.bootstrapMessages.length, 2);
    await service.runWorkspaceBootstrapTurn({
      workspaceKey: "workspace_multi", requestKey: "turn_two",
      expectedGeneration: restored.generation,
      expectedBindingDigest: restored.bindingDigest,
      text: "Second question",
    });
    const final = await service.workspaceBinding("workspace_multi");
    assert.deepEqual(final.bootstrapMessages.map((message) => message.text), [
      "First question", "guide:1", "Second question", "guide:2",
    ]);
    assert.equal(openCode.createCount, 1);
  } finally {
    store?.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("bootstrap extracts a quoted Chinese model name exactly", async () => {
  const parent = mkdtempSync(join(tmpdir(), "riff-stage6-bootstrap-name-"));
  let store: ProductStoreV2 | undefined;
  try {
    store = ProductStoreV2.open(join(parent, "store"));
    const openCode = new BootstrapOpenCode();
    openCode.createOwner = true;
    openCode.createName = "航空保障三级物流网络";
    const service = serviceFor(store, openCode);
    const created = await service.createWorkspaceBinding({
      commandId: "workspace_name_create", workspaceKey: "workspace_name",
    });
    const selected = await service.updateWorkspaceBinding({
      commandId: "workspace_name_provider",
      workspaceKey: "workspace_name",
      expectedGeneration: created.binding.generation,
      expectedBindingDigest: created.binding.bindingDigest,
      draft: "请创建一个名为“航空保障三级物流网络”的模型，只创建 Model。",
      provider: { providerId: "provider", modelId: "model" },
    });
    const result = await service.runWorkspaceBootstrapTurn({
      workspaceKey: "workspace_name", requestKey: "turn_name",
      expectedGeneration: selected.binding.generation,
      expectedBindingDigest: selected.binding.bindingDigest,
      text: "请创建一个名为“航空保障三级物流网络”的模型，只创建 Model，不创建 Project，也不要运行仿真。",
    });
    assert.equal(result.mode, "live");
    assert.equal(result.binding.owner?.kind, "model");
  } finally {
    store?.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("failed bootstrap turn retires the upstream session before the next retry", async () => {
  const parent = mkdtempSync(join(tmpdir(), "riff-stage6-bootstrap-failure-"));
  let store: ProductStoreV2 | undefined;
  try {
    store = ProductStoreV2.open(join(parent, "store"));
    const openCode = new BootstrapOpenCode();
    openCode.failPrompt = true;
    const service = serviceFor(store, openCode);
    const created = await service.createWorkspaceBinding({
      commandId: "workspace_failure_create", workspaceKey: "workspace_failure",
    });
    const selected = await service.updateWorkspaceBinding({
      commandId: "workspace_failure_provider",
      workspaceKey: "workspace_failure",
      expectedGeneration: created.binding.generation,
      expectedBindingDigest: created.binding.bindingDigest,
      draft: "Create a Model named Retry Model",
      provider: { providerId: "provider", modelId: "model" },
    });
    const failed = await service.runWorkspaceBootstrapTurn({
      workspaceKey: "workspace_failure", requestKey: "turn_failed",
      expectedGeneration: selected.binding.generation,
      expectedBindingDigest: selected.binding.bindingDigest,
      text: "Create a Model named Retry Model.",
    });
    assert.equal(failed.mode, "read_only");
    assert.equal(openCode.abortCount, 1);
    assert.equal(store.getWorkspaceBootstrapRuntime("workspace_failure").session.state, "lost");

    openCode.failPrompt = false;
    const retried = await service.runWorkspaceBootstrapTurn({
      workspaceKey: "workspace_failure", requestKey: "turn_retry",
      expectedGeneration: failed.binding.generation,
      expectedBindingDigest: failed.binding.bindingDigest,
      text: "List available objects.",
    });
    assert.equal(retried.mode, "live");
    assert.equal(openCode.createCount, 2);
  } finally {
    store?.close();
    rmSync(parent, { recursive: true, force: true });
  }
});
