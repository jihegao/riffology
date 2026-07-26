import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { AgentTurnRuntime, explicitImperative } from "../src/agent-turn-runtime.ts";
import { normalizeVisualAgentOperation, visualAgentOperationCommitment, type VisualAgentAuthority } from "../src/agent-visual-authority.ts";
import { planExperiment } from "../src/experiment-planner.ts";
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
  const applyTool = ((listed?.result as any).tools as any[])
    .find((item) => item.name === "riff_apply_model_changes");
  assert.ok(applyTool);
  assert.deepEqual(
    applyTool.inputSchema.properties.changes.items.required,
    [
      "objectFileId",
      "kind",
      "relativePath",
      "mediaType",
      "text",
      "expectedPriorSha256",
    ],
  );
  assert.equal(
    applyTool.inputSchema.properties.changes.items.additionalProperties,
    false,
  );
  assert.deepEqual(
    applyTool.inputSchema.properties.changes.items.properties.kind.enum,
    ["model_code", "model_environment", "model_visual_asset"],
  );
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
  assert.ok(!names.includes("riff_observe_current_visual"));
  const forged = await runtime.handle(prepared.capability, call("riff_adopt_attachment", { attachmentId: "attachment_other", purpose: "forged", logicalName: "other.csv" }));
  assert.equal((forged?.result as any).isError, true);
  const adopted = await runtime.handle(prepared.capability, call("riff_adopt_attachment", { attachmentId: "attachment_project", purpose: "project input", logicalName: "source.csv" }));
  assert.equal((adopted?.result as any).isError, undefined, JSON.stringify(adopted));
  const projectFiles = store.listObjectFiles({ kind: "project", id: "project_alpha" });
  assert.ok(projectFiles.some((file) => file.kind === "adopted_attachment" && file.sourceAttachmentId === "attachment_project"));
  assert.equal(store.readObjectFile("file_model_alpha").toString("utf8"), "value = 1\n");
});

test("explicit Project turn compare-and-set updates an Experiment and creates requested analysis only", async (t) => {
  const { store, runtime } = setup(t, true);
  store.startAgentTurn({
    turnId: "turn_project_experiment",
    userMessageId: "message_project_experiment",
    conversationId: "conversation_project",
    requestKey: "project-experiment",
    text: "Update the Experiment horizon to 2 and create an analysis document now",
    createdAt: NOW,
  });
  store.bindAgentSession({
    id: "session_project_experiment",
    conversationId: "conversation_project",
    expectedGeneration: 0,
    state: "available",
    externalSessionRef: "opaque-project-experiment",
    at: NOW,
  });
  const prepared = await runtime.prepare({
    conversationId: "conversation_project",
    turnId: "turn_project_experiment",
    text: "Update the Experiment horizon to 2 and create an analysis document now",
    attachmentIds: [],
  });
  t.after(() => prepared.release());
  assert.equal(prepared.intentAuthority, "explicit");
  const listed = await runtime.handle(prepared.capability, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
  });
  const names = ((listed?.result as any).tools as any[]).map((item) => item.name);
  assert.ok(names.includes("riff_list_experiment_configurations"));
  assert.ok(names.includes("riff_update_experiment_configuration"));
  assert.ok(names.includes("riff_create_analysis_document"));
  assert.ok(!names.includes("riff_create_temporary_document"));

  const configurations = await runtime.handle(
    prepared.capability,
    call("riff_list_experiment_configurations"),
  );
  const current = JSON.parse((configurations?.result as any).content[0].text)[0];
  const nextConfiguration = structuredClone(current.configuration);
  nextConfiguration.parameters.horizon = 2;
  delete nextConfiguration.parameters.crewCount;
  const updateArguments = {
    requestKey: "agent-experiment-update",
    configurationId: current.id,
    expectedConfigurationDigest: current.configurationDigest,
    expectedRecordDigest: current.recordDigest,
    configuration: nextConfiguration,
  };
  const updated = await runtime.handle(
    prepared.capability,
    call("riff_update_experiment_configuration", updateArguments),
  );
  assert.equal((updated?.result as any).isError, undefined, JSON.stringify(updated));
  const replayed = await runtime.handle(
    prepared.capability,
    call("riff_update_experiment_configuration", updateArguments),
  );
  assert.equal(
    (replayed?.result as any).content[0].text,
    (updated?.result as any).content[0].text,
    "an exact retry after response loss must replay the durable result",
  );
  assert.equal(
    store.listExperimentConfigurations("project_alpha")[0]?.configuration.parameters.horizon,
    2,
  );
  assert.equal(
    store.listExperimentConfigurations("project_alpha")[0]?.configuration.parameters.crewCount,
    1,
    "schema defaults must normalize once and still replay exactly",
  );

  const analysis = await runtime.handle(
    prepared.capability,
    call("riff_create_analysis_document", {
      name: "Requested analysis",
      mediaType: "text/markdown",
      content: "# Analysis\n\nUser requested this document.",
    }),
  );
  assert.equal((analysis?.result as any).isError, undefined, JSON.stringify(analysis));
  assert.equal(
    store.listTemporaryDocuments("conversation_project")[0]?.name,
    "Requested analysis",
  );
  const actions = store.startAgentTurn({
    turnId: "turn_project_experiment",
    userMessageId: "message_project_experiment",
    conversationId: "conversation_project",
    requestKey: "project-experiment",
    text: "Update the Experiment horizon to 2 and create an analysis document now",
    createdAt: NOW,
  }).actions;
  assert.deepEqual(
    actions
      .map((action) => [action.actionKind, action.state])
      .sort(([left], [right]) => String(left).localeCompare(String(right))),
    [
      ["analysis_document_create", "committed"],
      ["experiment_configuration_update", "committed"],
    ],
  );
});

test("explicit Project operations receive separate mutation and analysis authority", async (t) => {
  const updateFixture = setup(t, true);
  updateFixture.store.startAgentTurn({
    turnId: "turn_project_update_only",
    userMessageId: "message_project_update_only",
    conversationId: "conversation_project",
    requestKey: "project-update-only",
    text: "Update the Experiment configuration horizon now",
    createdAt: NOW,
  });
  updateFixture.store.bindAgentSession({
    id: "session_project_update_only",
    conversationId: "conversation_project",
    expectedGeneration: 0,
    state: "available",
    externalSessionRef: "opaque-project-update-only",
    at: NOW,
  });
  const updatePrepared = await updateFixture.runtime.prepare({
    conversationId: "conversation_project",
    turnId: "turn_project_update_only",
    text: "Update the Experiment configuration horizon now",
    attachmentIds: [],
  });
  t.after(() => updatePrepared.release());
  const updateTools = await updateFixture.runtime.handle(
    updatePrepared.capability,
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
  );
  const updateNames = ((updateTools?.result as any).tools as any[])
    .map((item) => item.name);
  assert.ok(updateNames.includes("riff_update_experiment_configuration"));
  assert.ok(!updateNames.includes("riff_create_analysis_document"));
  const forgedAnalysis = await updateFixture.runtime.handle(
    updatePrepared.capability,
    call("riff_create_analysis_document", {
      name: "Unrequested analysis",
      mediaType: "text/markdown",
      content: "# Must not exist",
    }),
  );
  assert.equal((forgedAnalysis?.result as any).isError, true);
  assert.deepEqual(
    updateFixture.store.listTemporaryDocuments("conversation_project"),
    [],
  );
  const crossKeywordFixture = setup(t, true);
  crossKeywordFixture.store.startAgentTurn({
    turnId: "turn_project_cross_keyword",
    userMessageId: "message_project_cross_keyword",
    conversationId: "conversation_project",
    requestKey: "project-cross-keyword",
    text: "Create an analysis report document describing the turbine configuration.",
    createdAt: NOW,
  });
  crossKeywordFixture.store.bindAgentSession({
    id: "session_project_cross_keyword",
    conversationId: "conversation_project",
    expectedGeneration: 0,
    state: "available",
    externalSessionRef: "opaque-project-cross-keyword",
    at: NOW,
  });
  const crossKeywordPrepared = await crossKeywordFixture.runtime.prepare({
    conversationId: "conversation_project",
    turnId: "turn_project_cross_keyword",
    text: "Create an analysis report document describing the turbine configuration.",
    attachmentIds: [],
  });
  t.after(() => crossKeywordPrepared.release());
  const crossKeywordTools = await crossKeywordFixture.runtime.handle(
    crossKeywordPrepared.capability,
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
  );
  const crossKeywordNames = ((crossKeywordTools?.result as any).tools as any[])
    .map((item) => item.name);
  assert.ok(crossKeywordNames.includes("riff_create_analysis_document"));
  assert.ok(!crossKeywordNames.includes("riff_update_experiment_configuration"));

  const analysisFixture = setup(t, true);
  analysisFixture.store.startAgentTurn({
    turnId: "turn_project_analysis_only",
    userMessageId: "message_project_analysis_only",
    conversationId: "conversation_project",
    requestKey: "project-analysis-only",
    text: "Create an analysis document now",
    createdAt: NOW,
  });
  analysisFixture.store.bindAgentSession({
    id: "session_project_analysis_only",
    conversationId: "conversation_project",
    expectedGeneration: 0,
    state: "available",
    externalSessionRef: "opaque-project-analysis-only",
    at: NOW,
  });
  const analysisPrepared = await analysisFixture.runtime.prepare({
    conversationId: "conversation_project",
    turnId: "turn_project_analysis_only",
    text: "Create an analysis document now",
    attachmentIds: [],
  });
  t.after(() => analysisPrepared.release());
  const analysisTools = await analysisFixture.runtime.handle(
    analysisPrepared.capability,
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
  );
  const analysisNames = ((analysisTools?.result as any).tools as any[])
    .map((item) => item.name);
  assert.ok(analysisNames.includes("riff_create_analysis_document"));
  assert.ok(!analysisNames.includes("riff_update_experiment_configuration"));
  const forgedUpdate = await analysisFixture.runtime.handle(
    analysisPrepared.capability,
    call("riff_update_experiment_configuration", {
      requestKey: "forged-update",
      configurationId: "experiment_alpha",
      expectedConfigurationDigest: "0".repeat(64),
      expectedRecordDigest: "1".repeat(64),
      configuration: {},
    }),
  );
  assert.equal((forgedUpdate?.result as any).isError, true);
  assert.equal(
    analysisFixture.store
      .listExperimentConfigurations("project_alpha")[0]
      ?.configuration.parameters.horizon,
    1,
  );
});

test("Project-only visual observation keeps target authority server-side", async (t) => {
  const observed: unknown[] = [];
  const visualAuthority = {
    observationAvailable: true,
    async observe(input: unknown) {
      observed.push(input);
      return {
        schemaVersion: 1,
        kind: "observe_accessibility",
        untrusted: true,
        contentType: "text/plain",
        text: "- heading \"Current visual\"",
      };
    },
    revokeTurn() {},
    revokeAll() {},
  } as unknown as VisualAgentAuthority;
  const { store, runtime } = setup(t, true, visualAuthority);
  store.startAgentTurn({
    turnId: "turn_project_observe",
    userMessageId: "message_project_observe",
    conversationId: "conversation_project",
    requestKey: "project-observe",
    text: "Observe the current visual",
    createdAt: NOW,
  });
  store.bindAgentSession({
    id: "session_project_observe",
    conversationId: "conversation_project",
    expectedGeneration: 0,
    state: "available",
    externalSessionRef: "opaque-project-observe",
    at: NOW,
  });
  const prepared = await runtime.prepare({
    conversationId: "conversation_project",
    turnId: "turn_project_observe",
    text: "Observe the current visual",
    attachmentIds: [],
  });
  t.after(() => prepared.release());
  const listed = await runtime.handle(prepared.capability, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
  });
  const names = ((listed?.result as any).tools as any[]).map((item) => item.name);
  assert.ok(names.includes("riff_observe_current_visual"));
  assert.ok(!names.includes("riff_interact_current_visual"));
  const response = await runtime.handle(
    prepared.capability,
    call("riff_observe_current_visual", { kind: "accessibility" }),
  );
  assert.equal((response?.result as any).isError, undefined, JSON.stringify(response));
  const observedContent = JSON.parse(
    (response?.result as any).content[0].text,
  );
  assert.equal(observedContent.schemaVersion, 1);
  assert.equal(observedContent.untrusted, true);
  assert.equal(observedContent.kind, "observe_accessibility");
  assert.equal(observed.length, 1);
  assert.deepEqual(observed[0], {
    conversationId: "conversation_project",
    turnId: "turn_project_observe",
    externalSessionGeneration: 1,
    operation: { kind: "observe_accessibility" },
    intentAuthority: "proposal_only",
  });
  for (const injected of [
    { kind: "dom_text", url: "http://127.0.0.1:9222" },
    { kind: "dom_text", selector: "#secret" },
    { kind: "dom_text", script: "document.cookie" },
  ]) {
    const denied = await runtime.handle(
      prepared.capability,
      call("riff_observe_current_visual", injected),
    );
    assert.equal((denied?.result as any).isError, true);
  }
  assert.equal(observed.length, 1);
});

test("intent classifier is conservative for questions and conditionals", () => {
  assert.equal(explicitImperative("Update the model file now"), true);
  assert.equal(explicitImperative("请修改模型文件"), true);
  assert.equal(
    explicitImperative("将 wind-turbine-visual 建立为可视化仿真模型"),
    true,
  );
  assert.equal(explicitImperative("将来建立可视化模型的风险"), false);
  assert.equal(explicitImperative("将来建立模型的方案"), false);
  assert.equal(explicitImperative("Could you update the model?"), false);
  assert.equal(explicitImperative("如果修改模型会怎样"), false);
  assert.equal(explicitImperative("Explain the model"), false);
});

test("only a digest-marked Project human turn exposes one empty-schema visual interaction", async (t) => {
  const calls: unknown[] = [];
  const visualAuthority = {
    observationAvailable: false,
    interactionAvailable: true,
    async interact(input: unknown) {
      calls.push(input);
      await Promise.resolve();
      return { schemaVersion: 1, kind: "type", status: "dispatched", untrusted: true };
    },
    revokeTurn() {}, revokeAll() {},
  } as unknown as VisualAgentAuthority;
  const { store, runtime } = setup(t, true, visualAuthority);
  const operation = normalizeVisualAgentOperation({ kind: "type", locator: { kind: "label", label: "secret-locator-canary" }, value: "secret-value-canary" });
  const commitment = visualAgentOperationCommitment(operation);
  const marker = { schemaVersion: 1 as const, actionKind: "type" as const, locatorKind: "label" as const,
    actionCommitmentDigest: commitment.digest, valueDigest: commitment.valueDigest };
  store.startAgentTurn({ turnId: "turn_project_interact", userMessageId: "message_project_interact", conversationId: "conversation_project", requestKey: "project-interact", text: "Discuss only", visualInteractionMarker: marker, createdAt: NOW });
  store.bindAgentSession({ id: "session_project_interact", conversationId: "conversation_project", expectedGeneration: 0, state: "available", externalSessionRef: "opaque-project-interact", at: NOW });
  const prepared = await runtime.prepare({ conversationId: "conversation_project", turnId: "turn_project_interact", text: "Discuss only", attachmentIds: [], confirmedVisualInteraction: operation });
  t.after(() => prepared.release());
  const listed = await runtime.handle(prepared.capability, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  const tool = ((listed?.result as any).tools as any[]).find((item) => item.name === "riff_interact_current_visual");
  assert.deepEqual(tool?.inputSchema, { type: "object", properties: {}, additionalProperties: false });
  const stored = JSON.stringify(store.listConversationMessages("conversation_project"));
  assert.equal(stored.includes("secret-locator-canary"), false);
  assert.equal(stored.includes("secret-value-canary"), false);
  const injected = await runtime.handle(prepared.capability, call("riff_interact_current_visual", { value: "replacement" }));
  assert.equal((injected?.result as any).isError, true);
  assert.equal(calls.length, 0);
  const [accepted, concurrentReplay] = await Promise.all([
    runtime.handle(prepared.capability, call("riff_interact_current_visual")),
    runtime.handle(prepared.capability, call("riff_interact_current_visual")),
  ]);
  assert.equal((accepted?.result as any).isError, undefined, JSON.stringify(accepted));
  assert.equal((concurrentReplay?.result as any).isError, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    conversationId: "conversation_project", turnId: "turn_project_interact", externalSessionGeneration: 1,
    operation, intentAuthority: "visual_interaction_confirmed",
  });
  const replay = await runtime.handle(prepared.capability, call("riff_interact_current_visual"));
  assert.equal((replay?.result as any).isError, true);
  assert.equal(calls.length, 1);
  assert.throws(() => store.startAgentTurn({ turnId: "turn_project_interact", userMessageId: "message_project_interact", conversationId: "conversation_project", requestKey: "project-interact", text: "Discuss only", visualInteractionMarker: { ...marker, actionCommitmentDigest: "f".repeat(64) }, createdAt: NOW }), /request key was reused/u);

  store.startAgentTurn({ turnId: "turn_model_interact", userMessageId: "message_model_interact", conversationId: "conversation_model", requestKey: "model-interact", text: "Do it", visualInteractionMarker: marker, createdAt: NOW });
  store.bindAgentSession({ id: "session_model_interact", conversationId: "conversation_model", expectedGeneration: 0, state: "available", externalSessionRef: "opaque-model-interact", at: NOW });
  const model = await runtime.prepare({ conversationId: "conversation_model", turnId: "turn_model_interact", text: "Do it", attachmentIds: [], confirmedVisualInteraction: operation });
  t.after(() => model.release());
  const modelListed = await runtime.handle(model.capability, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  const modelNames = ((modelListed?.result as any).tools as any[]).map((item) => item.name);
  assert.equal(modelNames.includes("riff_interact_current_visual"), false);
});

function setup(
  t: TestContext,
  withProject = false,
  visualAuthority?: VisualAgentAuthority,
) {
  const root = mkdtempSync(join(tmpdir(), "riff-agent-runtime-"));
  const skillRoot = mkdtempSync(join(tmpdir(), "riff-agent-skills-"));
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(skillRoot, { recursive: true, force: true }); });
  mkdirSync(join(skillRoot, "abm-modeling"));
  writeFileSync(join(skillRoot, "abm-modeling/SKILL.md"), "---\nname: abm-modeling\ndescription: agent model simulation\n---\n\nBounded instructions.\n");
  const store = ProductStoreV2.open(root);
  t.after(() => store.close());
  const inputSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    required: ["horizon"],
    properties: {
      horizon: { type: "integer", minimum: 1, maximum: 10 },
      crewCount: { type: "integer", minimum: 1, maximum: 10, default: 1 },
    },
  };
  store.createModel({ id: "model_alpha", name: "Generic", technicalStatus: "executable", runMode: "batch", executionDescription: {
    schemaVersion: 2,
    runtime: "python",
    runMode: "batch",
    dependencyFile: "environment/requirements.txt",
    inputs: {
      schemaProfile: "riff-json-schema-2020-12-v1",
      schema: inputSchema,
      smoke: { horizon: 1 },
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
  }, createdAt: NOW,
    files: [
      { id: "file_model_alpha", kind: "model_code", relativePath: "model.py", mediaType: "text/x-python", bytes: Buffer.from("value = 1\n") },
      { id: "file_model_environment", kind: "model_environment", relativePath: "requirements.txt", mediaType: "text/plain", bytes: Buffer.from("") },
    ] });
  store.createConversation({ id: "conversation_model", owner: { kind: "model", id: "model_alpha" }, name: "Model", providerId: "provider", providerModelId: "model", createdAt: NOW });
  if (withProject) {
    store.createProjectFromModel({ projectId: "project_alpha", projectName: "Project", sourceModelId: "model_alpha", createdAt: NOW });
    store.createConversation({ id: "conversation_project", owner: { kind: "project", id: "project_alpha" }, name: "Project", providerId: "provider", providerModelId: "model", createdAt: NOW });
    store.createExperimentV4({
      commandId: "command_project_experiment",
      id: "experiment_project",
      projectId: "project_alpha",
      name: "Project Experiment",
      plan: planExperiment({
        configuration: {
          schemaVersion: 1,
          runKind: "batch",
          parameters: { horizon: 1 },
          sampling: { kind: "single", seed: 1 },
        },
        inputSchema,
        maxSamples: 10,
      }),
      createdAt: NOW,
    });
  }
  const skills = new SimulationSkillCatalog(skillRoot, ["abm-modeling"]);
  return {
    store,
    runtime: new AgentTurnRuntime(store, skills, {
      now: () => NOW,
      ...(visualAuthority ? { visualAuthority } : {}),
    }),
  };
}
