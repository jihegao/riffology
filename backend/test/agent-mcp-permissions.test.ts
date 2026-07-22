import assert from "node:assert/strict";
import test from "node:test";
import { AgentMcpServer } from "../src/agent-mcp.ts";
import { toolsForOwner, type AgentToolGrant } from "../src/agent-tools.ts";

const call = (name: string, args: Record<string, unknown> = {}) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });

test("Agent capabilities bind conversation, owner, turn, generation and exact tools", async () => {
  let now = 10;
  const seen: AgentToolGrant[] = [];
  const server = new AgentMcpServer({ async execute(grant) { seen.push(grant); return { ok: true }; } }, { now: () => now, ttlMs: 5 });
  const projectCapability = server.grant({ conversationId: "conversation_project", owner: { kind: "project", id: "project_a" }, turnId: "turn_a", externalSessionGeneration: 2, allowedTools: toolsForOwner({ kind: "project", id: "project_a" }) });
  const listed = await server.handle(projectCapability, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  const names = ((listed?.result as any).tools as any[]).map((item) => item.name);
  assert.ok(!names.includes("riff_apply_model_changes"));
  const denied = await server.handle(projectCapability, call("riff_apply_model_changes", { requestKey: "r", changes: [{}] }));
  assert.equal((denied?.result as any).isError, true);
  const allowed = await server.handle(projectCapability, call("riff_create_temporary_document", { name: "Draft", mediaType: "text/markdown", content: "x" }));
  assert.equal((allowed?.result as any).isError, undefined);
  assert.deepEqual(seen[0]?.owner, { kind: "project", id: "project_a" });
  assert.equal(seen[0]?.externalSessionGeneration, 2);
  server.revokeSessionGeneration("conversation_project", 2);
  assert.equal((await server.handle(projectCapability, { jsonrpc: "2.0", id: 1, method: "tools/list" }))?.error?.code, -32001);

  const expiring = server.grant({ conversationId: "conversation_model", owner: { kind: "model", id: "model_a" }, turnId: "turn_b", externalSessionGeneration: 1, allowedTools: toolsForOwner({ kind: "model", id: "model_a" }) });
  now = 15;
  assert.equal((await server.handle(expiring, { jsonrpc: "2.0", id: 1, method: "tools/list" }))?.error?.code, -32001);
});

test("Agent tool input cannot replace a server-owned scope", async () => {
  let calls = 0;
  const server = new AgentMcpServer({ async execute() { calls += 1; return {}; } });
  const capability = server.grant({ conversationId: "conversation_a", owner: { kind: "model", id: "model_a" }, turnId: "turn_a", externalSessionGeneration: 1, allowedTools: toolsForOwner({ kind: "model", id: "model_a" }) });
  for (const injected of [
    { ownerId: "model_b" }, { modelId: "model_b" }, { projectId: "project_b" },
    { conversationId: "conversation_b" }, { workspacePath: "/tmp/other" }, { capability: "forged" },
    { nested: { ownerId: "model_b" } },
  ]) {
    const response = await server.handle(capability, call("riff_read_owner_summary", injected));
    assert.equal((response?.result as any).isError, true);
  }
  assert.equal(calls, 0);
});
