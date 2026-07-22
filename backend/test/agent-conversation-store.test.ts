import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentSessionRepositoryPort } from "../src/agent-session-manager.ts";
import { ProductStoreV2 } from "../src/product-store-v2.ts";

const NOW = "2026-07-22T04:00:00.000Z";
const LATER = "2026-07-22T05:00:00.000Z";
const END = "2026-07-22T06:00:00.000Z";

const modelInput = (id: string) => ({
  id, name: `Model ${id}`, technicalStatus: "draft" as const, runMode: "both" as const,
  executionDescription: { entryPoint: "model.py", modes: ["batch"] }, createdAt: NOW,
  files: [
    { id: `file_${id}_code`, kind: "model_code" as const, relativePath: "model.py", mediaType: "text/x-python", bytes: Buffer.from("print('one')\n") },
    { id: `file_${id}_env`, kind: "model_environment" as const, relativePath: "requirements.txt", mediaType: "text/plain", bytes: Buffer.from("mesa==3\n") },
  ],
});

test("Agent conversation records lock provider, preserve idempotency, bound context, and omit opaque sessions", () => {
  const parent = mkdtempSync(join(tmpdir(), "riff-agent-store-"));
  const root = join(parent, "store");
  let store = ProductStoreV2.open(root);
  try {
    const created = store.createModelWithFirstConversation({ model: modelInput("model_agent"), conversation: {
      id: "conversation_agent", name: "Build", providerId: "provider-a", providerModelId: "model-a", createdAt: NOW,
    } });
    assert.equal(created.conversation.provider.locked, false);
    assert.deepEqual(store.createModelWithFirstConversation({ model: modelInput("model_agent"), conversation: {
      id: "conversation_agent", name: "Build", providerId: "provider-a", providerModelId: "model-a", createdAt: NOW,
    } }).model.id, "model_agent");
    assert.throws(() => store.createModelWithFirstConversation({ model: { ...modelInput("model_agent"), name: "changed" }, conversation: {
      id: "conversation_agent", name: "Build", providerId: "provider-a", providerModelId: "model-a", createdAt: NOW,
    } }), /different intent/u);

    store.changeConversationProvider("conversation_agent", "provider-b", "model-b", LATER);
    const started = store.startAgentTurn({ turnId: "turn_agent_001", userMessageId: "message_user_001", conversationId: "conversation_agent",
      requestKey: "request-001", text: "Update the model", createdAt: LATER });
    assert.equal(started.state, "running");
    assert.equal(store.getConversation("conversation_agent").provider.locked, true);
    assert.throws(() => store.changeConversationProvider("conversation_agent", "provider-c", "model-c", END), /unexpected number/u);
    assert.equal(store.startAgentTurn({ turnId: "turn_agent_001", userMessageId: "message_user_001", conversationId: "conversation_agent",
      requestKey: "request-001", text: "Update the model", createdAt: LATER }).userMessageId, "message_user_001");
    assert.throws(() => store.startAgentTurn({ turnId: "turn_agent_001", userMessageId: "message_user_001", conversationId: "conversation_agent",
      requestKey: "request-001", text: "Different", createdAt: LATER }), /different intent/u);

    assert.deepEqual(store.bindAgentSession({ id: "session_agent_001", conversationId: "conversation_agent", expectedGeneration: 0,
      state: "available", externalSessionRef: "opaque-secret-ref", at: LATER }), { generation: 1, state: "available" });
    const publicConversation = store.getConversation("conversation_agent");
    assert.equal(publicConversation.sessionState, "available");
    assert.equal(JSON.stringify(publicConversation).includes("opaque-secret-ref"), false);
    store.transitionAgentSession("conversation_agent", 1, "lost", END);
    assert.throws(() => store.bindAgentSession({ id: "session_stale", conversationId: "conversation_agent", expectedGeneration: 0,
      state: "rebuilding", externalSessionRef: "stale", at: END }), /generation changed/u);
    assert.deepEqual(store.bindAgentSession({ id: "session_agent_002", conversationId: "conversation_agent", expectedGeneration: 1,
      state: "rebuilding", externalSessionRef: "opaque-new-ref", at: END }), { generation: 2, state: "rebuilding" });

    const completed = store.completeAgentTurn({ conversationId: "conversation_agent", requestKey: "request-001", assistantMessageId: "message_assistant_001",
      assistantText: "Done", assistantContent: { answer: "Done" }, completedAt: END });
    assert.equal(completed.state, "complete");
    assert.equal(store.completeAgentTurn({ conversationId: "conversation_agent", requestKey: "request-001", assistantMessageId: "message_assistant_001",
      assistantText: "Done", assistantContent: { answer: "Done" }, completedAt: END }).assistantMessageId, "message_assistant_001");
    assert.deepEqual(store.listConversationMessages("conversation_agent").map((message) => message.ordinal), [0, 1]);

    store.advanceConversationSummary({ conversationId: "conversation_agent", expectedCoveredThroughOrdinal: null, coveredThroughOrdinal: 0, content: "User requested a model update.", at: END });
    const context = store.readConversationContext("conversation_agent", { maxMessages: 1, maxBytes: 1000 });
    assert.equal(context.summary?.coveredThroughOrdinal, 0);
    assert.deepEqual(context.includedMessageIds, ["message_assistant_001"]);
    assert.equal(context.digest.length, 64);

    const skill = store.recordSkillUse({ id: "skill_use_001", conversationId: "conversation_agent", turnId: "turn_agent_001", skillId: "mesa",
      skillVersion: "1", routingMode: "explicit", catalogDigest: "a".repeat(64), instructionDigest: "b".repeat(64), loadState: "loaded", createdAt: END });
    assert.equal(skill.routingMode, "explicit");
    const denied = store.recordAction({ id: "action_denied_001", conversationId: "conversation_agent", turnId: "turn_agent_001", actionKind: "shell",
      intent: { command: "rm" }, permissionDecision: "denied", state: "denied", errorCode: "not_allowed", createdAt: END });
    assert.equal(denied.state, "denied");

    store.close();
    store = ProductStoreV2.open(root);
    const replay = store.startAgentTurn({ turnId: "turn_agent_001", userMessageId: "message_user_001", conversationId: "conversation_agent",
      requestKey: "request-001", text: "Update the model", createdAt: LATER });
    assert.equal(replay.state, "complete");
    assert.equal(replay.skillUses.length, 1);
    assert.equal(replay.actions.length, 1);
    assert.equal(JSON.stringify(store.getConversation("conversation_agent")).includes("opaque-new-ref"), false);
  } finally { store.close(); rmSync(parent, { recursive: true, force: true }); }
});

test("cross-owner turn attachments roll back provider lock/message and document transitions are terminal", () => {
  const parent = mkdtempSync(join(tmpdir(), "riff-agent-owner-"));
  const store = ProductStoreV2.open(join(parent, "store"));
  try {
    store.createModel(modelInput("model_owner_a"));
    store.createModel(modelInput("model_owner_b"));
    store.createConversation({ id: "conversation_owner_a", owner: { kind: "model", id: "model_owner_a" }, name: "A", providerId: "p", providerModelId: "m", createdAt: NOW });
    store.createConversation({ id: "conversation_owner_b", owner: { kind: "model", id: "model_owner_b" }, name: "B", providerId: "p", providerModelId: "m", createdAt: NOW });
    store.createAttachment({ id: "attachment_owner_b", objectFileId: "file_attachment_owner_b", conversationId: "conversation_owner_b",
      relativePath: "input.txt", originalName: "input.txt", mediaType: "text/plain", bytes: Buffer.from("b"), createdAt: NOW });
    assert.throws(() => store.startAgentTurn({ turnId: "turn_cross_owner", userMessageId: "message_cross_owner", conversationId: "conversation_owner_a",
      requestKey: "cross-owner", text: "Use attachment", attachmentIds: ["attachment_owner_b"], createdAt: LATER }), /unexpected number/u);
    assert.equal(store.getConversation("conversation_owner_a").provider.locked, false);
    assert.deepEqual(store.listConversationMessages("conversation_owner_a"), []);

    store.startAgentTurn({ turnId: "turn_owner_a", userMessageId: "message_owner_a", conversationId: "conversation_owner_a",
      requestKey: "valid", text: "Draft a plan", createdAt: LATER });
    store.createTemporaryDocument({ id: "document_owner_a", conversationId: "conversation_owner_a", sourceMessageId: "message_owner_a",
      name: "Plan", documentState: "draft", mediaType: "text/markdown", content: "# plan", createdAt: LATER });
    store.transitionTemporaryDocument("document_owner_a", "rejected", [], END);
    assert.throws(() => store.transitionTemporaryDocument("document_owner_a", "superseded", [], END), /unexpected number/u);
  } finally { store.close(); rmSync(parent, { recursive: true, force: true }); }
});

test("backend session repository uses generation and external-ref CAS without leaking the ref", async () => {
  const parent = mkdtempSync(join(tmpdir(), "riff-agent-session-port-"));
  const store = ProductStoreV2.open(join(parent, "store"));
  const repository: AgentSessionRepositoryPort = store;
  try {
    store.createModel(modelInput("model_session_port"));
    store.createConversation({ id: "conversation_session_port", owner: { kind: "model", id: "model_session_port" }, name: "Session", providerId: "p", providerModelId: "m", createdAt: NOW });
    store.startAgentTurn({ turnId: "turn_session_port", userMessageId: "message_session_port", conversationId: "conversation_session_port",
      requestKey: "session", text: "Hello", createdAt: NOW });
    assert.deepEqual(await repository.beginSessionGeneration({ conversationId: "conversation_session_port", expectedGeneration: null }), { generation: 1 });
    assert.equal((await repository.getConversationRuntime("conversation_session_port"))?.session?.externalSessionRef, null);
    await repository.activateSession({ conversationId: "conversation_session_port", generation: 1, externalSessionRef: "opaque-port-ref", contextSha256: "c".repeat(64) });
    assert.equal((await repository.getConversationRuntime("conversation_session_port"))?.session?.externalSessionRef, "opaque-port-ref");
    await assert.rejects(repository.markSessionLost({ conversationId: "conversation_session_port", generation: 1, expectedExternalSessionRef: "wrong", reason: "missing" }), /unexpected number/u);
    assert.equal((await repository.getConversationRuntime("conversation_session_port"))?.session?.state, "available");
    await repository.markSessionLost({ conversationId: "conversation_session_port", generation: 1, expectedExternalSessionRef: "opaque-port-ref", reason: "missing" });
    assert.deepEqual(await repository.beginSessionGeneration({ conversationId: "conversation_session_port", expectedGeneration: 1 }), { generation: 2 });
    await repository.failSessionGeneration({ conversationId: "conversation_session_port", generation: 2, reason: "rebuild_failed" });
    assert.equal((await repository.getConversationRuntime("conversation_session_port"))?.session?.state, "closed");
    assert.equal(JSON.stringify(store.getConversation("conversation_session_port")).includes("opaque-port-ref"), false);
  } finally { store.close(); rmSync(parent, { recursive: true, force: true }); }
});
