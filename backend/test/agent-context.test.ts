import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { buildBoundedAgentContext, type AgentContextInput } from "../src/agent-context.ts";

const digest = "a".repeat(64);

const input = (): AgentContextInput => ({
  conversationId: "conversation-a",
  owner: { kind: "model", id: "model-a" },
  ownerSummary: { owner: { kind: "model", id: "model-a" }, text: "Current generic Mesa model", workspaceDigest: digest },
  rollingSummary: { text: "Earlier bounded discussion", throughOrdinal: 2 },
  messages: [
    { id: "m0", conversationId: "conversation-a", ordinal: 0, role: "user", status: "complete", text: "old" },
    { id: "m1", conversationId: "conversation-a", ordinal: 1, role: "assistant", status: "failed", text: "failed excluded" },
    { id: "m2", conversationId: "conversation-b", ordinal: 2, role: "user", status: "complete", text: "other owner excluded" },
    { id: "m3", conversationId: "conversation-a", ordinal: 3, role: "user", status: "complete", text: "recent one" },
    { id: "m4", conversationId: "conversation-a", ordinal: 4, role: "assistant", status: "complete", text: "recent two" },
  ],
  documents: [
    { id: "doc-a", conversationId: "conversation-a", mediaType: "text/markdown", text: "API_KEY=super-secret", relevant: true },
    { id: "doc-b", conversationId: "conversation-b", mediaType: "text/plain", text: "other document", relevant: true },
    { id: "doc-c", conversationId: "conversation-a", mediaType: "text/plain", text: "irrelevant", relevant: false },
  ],
  attachments: [
    { id: "attachment-a", conversationId: "conversation-a", mediaType: "text/plain", preview: "opaque-session-ref", relevant: true },
    { id: "attachment-b", conversationId: "conversation-b", mediaType: "text/plain", preview: "other attachment", relevant: true },
  ],
  selectedSkills: [{ id: "abm-modeling", version: "1", instructions: "Use bounded model tools." }],
  sensitiveValues: ["opaque-session-ref", "super-secret"],
});

test("bounded context is deterministic, owner scoped, terminal-only, and secret scrubbed", () => {
  const first = buildBoundedAgentContext(input(), { maxMessages: 2 });
  const second = buildBoundedAgentContext(input(), { maxMessages: 2 });
  assert.deepEqual(first, second);
  assert.deepEqual(first.included.messageIds, ["m3", "m4"]);
  assert.deepEqual(first.included.documentIds, ["doc-a"]);
  assert.deepEqual(first.included.attachmentIds, ["attachment-a"]);
  assert.deepEqual(first.included.skillIds, ["abm-modeling"]);
  assert.doesNotMatch(first.text, /failed excluded|other owner|other document|other attachment|irrelevant/u);
  assert.doesNotMatch(first.text, /opaque-session-ref|super-secret/u);
  assert.match(first.text, /credential redacted|sensitive value redacted/u);
  assert.match(first.text, /UNTRUSTED CONTENT/u);
  assert.match(first.text, /UNTRUSTED PREVIEW/u);
  assert.equal(first.sha256, createHash("sha256").update(first.text).digest("hex"));
  assert.equal(first.byteLength, Buffer.byteLength(first.text));
});

test("context enforces total and per-item UTF-8 byte budgets", () => {
  const value = input();
  value.ownerSummary.text = "风".repeat(100);
  value.messages = [];
  value.documents = [];
  value.attachments = [];
  value.selectedSkills = [];
  const context = buildBoundedAgentContext(value, { maxBytes: 180, maxItemBytes: 33 });
  assert.ok(context.byteLength <= 180);
  assert.ok(Buffer.byteLength(context.text, "utf8") <= 180);
  assert.doesNotMatch(context.text, /�/u);
});

test("context rejects an owner-summary mismatch and invalid limits", () => {
  const mismatch = input();
  mismatch.ownerSummary.owner = { kind: "model", id: "model-other" };
  assert.throws(() => buildBoundedAgentContext(mismatch), /does not match/u);
  assert.throws(() => buildBoundedAgentContext(input(), { maxBytes: 0 }), /positive integer/u);
});

test("extra external-session or credential-shaped fields are never serialized", () => {
  const value = input() as AgentContextInput & { externalSessionRef: string; providerCredential: string };
  value.externalSessionRef = "external-ref-not-allowed";
  value.providerCredential = "provider-credential-not-allowed";
  const context = buildBoundedAgentContext(value);
  assert.doesNotMatch(context.text, /external-ref-not-allowed|provider-credential-not-allowed/u);
});

test("platform cards use a separate strict allowlisted context section", () => {
  const value = input();
  value.messages = [{
    id: "run_completion_card",
    conversationId: value.conversationId,
    ordinal: 5,
    role: "system",
    status: "complete",
    messageKind: "platform_card",
    text: "diagnostic=/private/secret.log",
    content: {
      runId: "run_alpha",
      status: "succeeded",
      sampleCount: 2,
      outputCount: 2,
      outputIds: ["output_a", "output_b"],
    },
  }];
  const context = buildBoundedAgentContext(value);
  assert.match(context.text, /--- PLATFORM CARD ---/u);
  assert.match(context.text, /run_id: run_alpha/u);
  assert.match(context.text, /output_ids: output_a,output_b/u);
  assert.doesNotMatch(context.text, /diagnostic|private|secret\\.log|--- MESSAGE ---/u);
  assert.deepEqual(context.included.messageIds, ["run_completion_card"]);

  value.messages[0]!.content = {
    runId: "run_alpha",
    status: "succeeded",
    sampleCount: 2,
    outputCount: 2,
    outputIds: ["output_a", "output_b"],
    diagnostics: "not allowed",
  };
  assert.throws(() => buildBoundedAgentContext(value), /Platform card context is invalid/u);
});
