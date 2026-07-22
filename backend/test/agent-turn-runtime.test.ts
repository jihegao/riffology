import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { AgentTurnRuntime, explicitImperative } from "../src/agent-turn-runtime.ts";
import { ProductStoreV2 } from "../src/product-store-v2.ts";
import { SimulationSkillCatalog } from "../src/simulation-skill-catalog.ts";

const NOW = "2026-07-22T01:00:00.000Z";
const call = (name: string, args: Record<string, unknown> = {}) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });

test("explicit Model turn loads and records a skill, scopes its attachment, and atomically mutates only its Model", async (t) => {
  const fixture = setup(t);
  const { store, runtime } = fixture;
  store.createAttachment({ id: "attachment_alpha", objectFileId: "file_attachment_alpha", conversationId: "conversation_model", relativePath: "notes.txt", originalName: "notes.txt", mediaType: "text/plain", bytes: Buffer.from("bounded input"), createdAt: NOW });
  const turn = store.startAgentTurn({ turnId: "turn_explicit", userMessageId: "message_explicit", conversationId: "conversation_model", requestKey: "explicit", text: "$abm-modeling update the model file", attachmentIds: ["attachment_alpha"], createdAt: NOW });
  store.bindAgentSession({ id: "session_model_1", conversationId: "conversation_model", expectedGeneration: 0, state: "available", externalSessionRef: "opaque-model-1", at: NOW });
  const prepared = await runtime.prepare({ conversationId: "conversation_model", turnId: "turn_explicit", text: "$abm-modeling update the model file", attachmentIds: ["attachment_alpha"] });
  t.after(() => prepared.release());
  assert.equal(prepared.intentAuthority, "explicit");
  assert.deepEqual(prepared.context.attachments?.map((item) => [item.id, item.preview]), [["attachment_alpha", "bounded input"]]);
  assert.equal(prepared.context.selectedSkills?.[0]?.id, "abm-modeling");
  const listed = await runtime.handle(prepared.capability, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.ok(((listed?.result as any).tools as any[]).some((item) => item.name === "riff_apply_model_changes"));
  const modelFile = store.listObjectFiles({ kind: "model", id: "model_alpha" }).find((file) => file.id === "file_model_alpha")!;
  const response = await runtime.handle(prepared.capability, call("riff_apply_model_changes", { requestKey: "change-a", changes: [{
    objectFileId: modelFile.id, kind: "model_code", relativePath: "model.py", mediaType: "text/x-python", text: "value = 2\n", expectedPriorSha256: modelFile.sha256,
  }] }));
  assert.equal((response?.result as any).isError, undefined, JSON.stringify(response));
  assert.equal(store.readObjectFile(modelFile.id).toString("utf8"), "value = 2\n");
  const replay = store.startAgentTurn({ turnId: "turn_explicit", userMessageId: "message_explicit", conversationId: "conversation_model", requestKey: "explicit", text: "$abm-modeling update the model file", attachmentIds: ["attachment_alpha"], createdAt: NOW });
  assert.equal(replay.skillUses[0]?.loadState, "loaded");
  assert.equal(replay.actions[0]?.state, "committed");
  assert.equal(turn.state, "running");
  store.bindAgentSession({ id: "session_model_2", conversationId: "conversation_model", expectedGeneration: 1, state: "available", externalSessionRef: "opaque-model-2", at: NOW });
  const stale = await runtime.handle(prepared.capability, call("riff_read_owner_summary"));
  assert.equal((stale?.result as any).isError, true, "a generation change must invalidate the outstanding capability");
});

test("ambiguous discussion has proposal-only capability and can persist a draft without mutating Model state", async (t) => {
  const { store, runtime } = setup(t);
  const before = store.listObjectFiles({ kind: "model", id: "model_alpha" }).map((file) => file.sha256);
  store.startAgentTurn({ turnId: "turn_ambiguous", userMessageId: "message_ambiguous", conversationId: "conversation_model", requestKey: "ambiguous", text: "Could we discuss changing the model?", createdAt: NOW });
  store.bindAgentSession({ id: "session_model_1", conversationId: "conversation_model", expectedGeneration: 0, state: "available", externalSessionRef: "opaque-model-1", at: NOW });
  const prepared = await runtime.prepare({ conversationId: "conversation_model", turnId: "turn_ambiguous", text: "Could we discuss changing the model?", attachmentIds: [] });
  t.after(() => prepared.release());
  assert.equal(prepared.intentAuthority, "proposal_only");
  const listed = await runtime.handle(prepared.capability, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  const names = ((listed?.result as any).tools as any[]).map((item) => item.name);
  assert.ok(!names.includes("riff_apply_model_changes"));
  assert.ok(!names.includes("riff_transition_temporary_document"));
  assert.ok(!names.includes("riff_adopt_attachment"));
  const denied = await runtime.handle(prepared.capability, call("riff_apply_model_changes", { requestKey: "forged", changes: [{}] }));
  assert.equal((denied?.result as any).isError, true);
  const document = await runtime.handle(prepared.capability, call("riff_create_temporary_document", { name: "Possible change", mediaType: "text/markdown", content: "# Proposal" }));
  assert.equal((document?.result as any).isError, undefined, JSON.stringify(document));
  assert.equal(store.listTemporaryDocuments("conversation_model")[0]?.documentState, "draft");
  assert.deepEqual(store.listObjectFiles({ kind: "model", id: "model_alpha" }).map((file) => file.sha256), before);
  assert.equal(store.startAgentTurn({ turnId: "turn_ambiguous", userMessageId: "message_ambiguous", conversationId: "conversation_model", requestKey: "ambiguous", text: "Could we discuss changing the model?", createdAt: NOW }).actions[0]?.state, "committed");
});

test("Project capability never exposes Model workspace mutation and attachment adoption is limited to current turn", async (t) => {
  const { store, runtime } = setup(t, true);
  store.createAttachment({ id: "attachment_project", objectFileId: "file_attachment_project", conversationId: "conversation_project", relativePath: "source.csv", originalName: "source.csv", mediaType: "text/csv", bytes: Buffer.from("x\n1\n"), createdAt: NOW });
  store.createAttachment({ id: "attachment_other", objectFileId: "file_attachment_other", conversationId: "conversation_project", relativePath: "other.csv", originalName: "other.csv", mediaType: "text/csv", bytes: Buffer.from("x\n2\n"), createdAt: NOW });
  store.startAgentTurn({ turnId: "turn_project", userMessageId: "message_project", conversationId: "conversation_project", requestKey: "project", text: "Adopt this attachment", attachmentIds: ["attachment_project"], createdAt: NOW });
  store.bindAgentSession({ id: "session_project_1", conversationId: "conversation_project", expectedGeneration: 0, state: "available", externalSessionRef: "opaque-project-1", at: NOW });
  const prepared = await runtime.prepare({ conversationId: "conversation_project", turnId: "turn_project", text: "Adopt this attachment", attachmentIds: ["attachment_project"] });
  t.after(() => prepared.release());
  const listed = await runtime.handle(prepared.capability, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  const names = ((listed?.result as any).tools as any[]).map((item) => item.name);
  assert.ok(!names.includes("riff_apply_model_changes")); assert.ok(!names.includes("riff_read_model_file"));
  const forged = await runtime.handle(prepared.capability, call("riff_adopt_attachment", { attachmentId: "attachment_other", purpose: "forged", logicalName: "other.csv" }));
  assert.equal((forged?.result as any).isError, true);
  const adopted = await runtime.handle(prepared.capability, call("riff_adopt_attachment", { attachmentId: "attachment_project", purpose: "project input", logicalName: "source.csv" }));
  assert.equal((adopted?.result as any).isError, undefined, JSON.stringify(adopted));
  const projectFiles = store.listObjectFiles({ kind: "project", id: "project_alpha" });
  assert.ok(projectFiles.some((file) => file.kind === "adopted_attachment" && file.sourceAttachmentId === "attachment_project"));
  assert.equal(store.readObjectFile("file_model_alpha").toString("utf8"), "value = 1\n");
});

test("intent classifier is conservative for questions and conditionals", () => {
  assert.equal(explicitImperative("Update the model file now"), true);
  assert.equal(explicitImperative("请修改模型文件"), true);
  assert.equal(explicitImperative("Could you update the model?"), false);
  assert.equal(explicitImperative("如果修改模型会怎样"), false);
  assert.equal(explicitImperative("Explain the model"), false);
});

function setup(t: TestContext, withProject = false) {
  const root = mkdtempSync(join(tmpdir(), "riff-agent-runtime-"));
  const skillRoot = mkdtempSync(join(tmpdir(), "riff-agent-skills-"));
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(skillRoot, { recursive: true, force: true }); });
  mkdirSync(join(skillRoot, "abm-modeling"));
  writeFileSync(join(skillRoot, "abm-modeling/SKILL.md"), "---\nname: abm-modeling\ndescription: agent model simulation\n---\n\nBounded instructions.\n");
  const store = ProductStoreV2.open(root);
  t.after(() => store.close());
  store.createModel({ id: "model_alpha", name: "Generic", technicalStatus: "executable", runMode: "batch", executionDescription: { entry: "model.py" }, createdAt: NOW,
    files: [{ id: "file_model_alpha", kind: "model_code", relativePath: "model.py", mediaType: "text/x-python", bytes: Buffer.from("value = 1\n") }] });
  store.createConversation({ id: "conversation_model", owner: { kind: "model", id: "model_alpha" }, name: "Model", providerId: "provider", providerModelId: "model", createdAt: NOW });
  if (withProject) {
    store.createProjectFromModel({ projectId: "project_alpha", projectName: "Project", sourceModelId: "model_alpha", createdAt: NOW });
    store.createConversation({ id: "conversation_project", owner: { kind: "project", id: "project_alpha" }, name: "Project", providerId: "provider", providerModelId: "model", createdAt: NOW });
  }
  const skills = new SimulationSkillCatalog(skillRoot, ["abm-modeling"]);
  return { store, runtime: new AgentTurnRuntime(store, skills, { now: () => NOW }) };
}
