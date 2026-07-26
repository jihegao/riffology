import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProductStoreV2 } from "../src/product-store-v2.ts";

const NOW = "2026-07-26T07:00:00.000Z";
const LATER = "2026-07-26T07:01:00.000Z";
const BATCH_EXECUTION = {
  schemaVersion: 2,
  runtime: "python",
  runMode: "batch",
  dependencyFile: "environment/requirements.txt",
  inputs: {
    schemaProfile: "riff-json-schema-2020-12-v1",
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    smoke: {},
  },
  outputs: [{
    logicalName: "result",
    relativePath: "outputs/result.json",
    mediaType: "application/json",
    required: true,
    role: "data",
  }],
  batch: { entryPoint: "code/model.py", protocol: "riff-batch-v1" },
  cancellation: { signal: "SIGTERM", graceMs: 100 },
} as const;
const VISUAL_EXECUTION = {
  schemaVersion: 2,
  runtime: "python",
  runMode: "visual",
  dependencyFile: "environment/requirements.txt",
  inputs: {
    schemaProfile: "riff-json-schema-2020-12-v1",
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    smoke: {},
  },
  outputs: [{
    logicalName: "result",
    relativePath: "outputs/result.json",
    mediaType: "application/json",
    required: true,
    role: "data",
  }],
  visual: {
    entryPoint: "code/model.py",
    protocol: "riff-visual-v1",
    healthPath: "/healthz",
  },
  cancellation: { signal: "SIGTERM", graceMs: 100 },
} as const;

test("startup records interrupted goals and preserves a committed visual action as outcome unknown", () => {
  const parent = mkdtempSync(join(tmpdir(), "riff-agent-goal-recovery-"));
  const root = join(parent, "store");
  let store = ProductStoreV2.open(root);
  try {
    store.createModel({
      id: "model_goal_recovery",
      name: "Goal recovery",
      technicalStatus: "draft",
      runMode: "batch",
      executionDescription: BATCH_EXECUTION,
      createdAt: NOW,
      files: [
        {
          id: "file_goal_recovery_code",
          kind: "model_code",
          relativePath: "model.py",
          mediaType: "text/x-python",
          bytes: Buffer.from("value = 1\n"),
        },
        {
          id: "file_goal_recovery_environment",
          kind: "model_environment",
          relativePath: "requirements.txt",
          mediaType: "text/plain",
          bytes: Buffer.from(""),
        },
      ],
    });
    store.createConversation({
      id: "conversation_goal_no_action",
      owner: { kind: "model", id: "model_goal_recovery" },
      name: "No action",
      providerId: "provider",
      providerModelId: "model",
      createdAt: NOW,
    });
    store.createConversation({
      id: "conversation_goal_after_action",
      owner: { kind: "model", id: "model_goal_recovery" },
      name: "After action",
      providerId: "provider",
      providerModelId: "model",
      createdAt: NOW,
    });
    store.startAgentTurn({
      turnId: "turn_goal_no_action",
      userMessageId: "message_goal_no_action",
      conversationId: "conversation_goal_no_action",
      requestKey: "request-goal-no-action",
      text: "将 wind-turbine-visual 建立为可视化仿真模型。",
      createdAt: NOW,
    });
    store.startAgentTurn({
      turnId: "turn_goal_after_action",
      userMessageId: "message_goal_after_action",
      conversationId: "conversation_goal_after_action",
      requestKey: "request-goal-after-action",
      text: "Create a visual Model.",
      createdAt: NOW,
    });
    store.recordAction({
      id: "action_goal_visual",
      conversationId: "conversation_goal_after_action",
      turnId: "turn_goal_after_action",
      actionKind: "replace_model_files",
      intent: { runMode: "visual" },
      permissionDecision: "allowed",
      state: "authorized",
      createdAt: NOW,
    });
    store.transitionActionRecord({
      id: "action_goal_visual",
      expectedState: "authorized",
      state: "staging",
      mutationTransactionId: "mutation_goal_visual",
      at: NOW,
    });
    const code = store.listObjectFiles({
      kind: "model",
      id: "model_goal_recovery",
    }).find((file) => file.kind === "model_code")!;
    store.mutateModelFiles({
      modelId: "model_goal_recovery",
      transactionId: "mutation_goal_visual",
      updatedAt: LATER,
      executionDescription: VISUAL_EXECUTION,
      files: [{
        objectFileId: code.id,
        kind: "model_code",
        relativePath: "model.py",
        mediaType: code.mediaType,
        bytes: Buffer.from("value = 'visual'\n"),
        expectedPriorSha256: code.sha256,
      }],
    });
    assert.equal(
      store.listModels({ includeArchived: true })[0]?.runMode,
      "visual",
    );
    assert.equal(
      store.listModels({ includeArchived: true })[0]
        ?.executionDescription.runMode,
      "visual",
    );

    store.close();
    store = ProductStoreV2.open(root);

    const noAction = store.latestAgentTurn("conversation_goal_no_action")!;
    assert.equal(noAction.state, "failed");
    assert.deepEqual(noAction.failure, {
      code: "interrupted",
      retryable: true,
    });
    assert.equal(noAction.goalVerification?.disposition, "failed");
    assert.equal(
      noAction.goalVerification?.reasonCode,
      "interrupted_before_action",
    );
    assert.equal(
      noAction.goalVerification?.evidence.intentKind,
      "model_visual",
    );

    const afterAction = store.latestAgentTurn(
      "conversation_goal_after_action",
    )!;
    assert.equal(afterAction.state, "failed");
    assert.deepEqual(afterAction.failure, {
      code: "agent_outcome_unknown",
      retryable: false,
    });
    assert.deepEqual(
      afterAction.actions.map((item) => [item.id, item.state]),
      [["action_goal_visual", "committed"]],
    );
    assert.equal(
      afterAction.goalVerification?.disposition,
      "outcome_unknown",
    );
    assert.equal(
      afterAction.goalVerification?.reasonCode,
      "committed_receipt_state_mismatch",
    );
    assert.equal(
      afterAction.goalVerification?.evidence.ownerStateVerified,
      false,
    );
    assert.equal(
      store.listModels({ includeArchived: true })[0]?.runMode,
      "visual",
    );
    assert.equal(
      store.listModels({ includeArchived: true })[0]
        ?.executionDescription.runMode,
      "visual",
    );
    assert.deepEqual(
      store.listConversationMessages("conversation_goal_after_action")
        .map((message) => message.role),
      ["user"],
    );
  } finally {
    store.close();
    rmSync(parent, { recursive: true, force: true });
  }
});
