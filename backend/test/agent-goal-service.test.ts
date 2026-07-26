import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentWorkspaceService } from "../src/agent-workspace-service.ts";
import { ApiError } from "../src/errors.ts";
import type {
  OpenCodeAssistantResponse,
  OpenCodeConversationPort,
  OpenCodePrompt,
  OpenCodeProviderModel,
} from "../src/opencode-adapter.ts";
import { ProductStoreV2 } from "../src/product-store-v2.ts";

const NOW = "2026-07-26T08:00:00.000Z";
const PRIVATE_PATH = "/private/riff/goal-secret";

const stableId = (prefix: string, value: string): string =>
  `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;

class GoalOpenCode implements OpenCodeConversationPort {
  catalogue: OpenCodeProviderModel[] = [{
    providerId: "provider",
    modelId: "model",
    qualifiedId: "provider/model",
  }];
  readonly sessions = new Set<string>();
  outcome: "idle" | "timeout" | "stale" | "abort" = "idle";
  beforeFailure?: () => void;
  #nextSession = 0;

  async discoverProviderModels(): Promise<OpenCodeProviderModel[]> {
    return this.catalogue;
  }
  async getSession(sessionId: string): Promise<boolean> {
    return this.sessions.has(sessionId);
  }
  async createSession(): Promise<string> {
    const sessionId = `opaque-session-${++this.#nextSession}`;
    this.sessions.add(sessionId);
    return sessionId;
  }
  async injectContext(): Promise<void> {}
  async promptWithModel(
    _sessionId: string,
    _binding: { providerId: string; modelId: string },
    _prompt: OpenCodePrompt,
  ): Promise<OpenCodeAssistantResponse> {
    if (this.outcome === "idle") {
      return {
        messageId: "upstream-safe",
        text: "A bounded answer was durably delivered.",
        content: { source: "opencode", textParts: 1 },
      };
    }
    this.beforeFailure?.();
    if (this.outcome === "timeout") {
      throw new ApiError(
        504,
        "opencode_prompt_timeout",
        "The bounded OpenCode wall budget expired.",
      );
    }
    if (this.outcome === "stale") {
      throw new ApiError(
        409,
        "opencode_session_generation_changed",
        "The exact OpenCode session generation changed.",
      );
    }
    throw new ApiError(
      409,
      "opencode_session_aborted",
      "The exact OpenCode session was aborted.",
    );
  }
  async abort(): Promise<void> {}
}

type Fixture = Readonly<{
  root: string;
  store: ProductStoreV2;
  service: AgentWorkspaceService;
  openCode: GoalOpenCode;
  modelId: string;
  conversationId: string;
}>;

const fixture = async (name: string): Promise<Fixture> => {
  const root = mkdtempSync(join(tmpdir(), `riff-agent-goal-${name}-`));
  const store = ProductStoreV2.open(join(root, "store"));
  const openCode = new GoalOpenCode();
  const service = new AgentWorkspaceService(store, openCode, () => NOW);
  const created = await service.createModel({
    commandId: `model-${name}`,
    name: `Goal ${name}`,
    providerId: "provider",
    modelId: "model",
  });
  return {
    root,
    store,
    service,
    openCode,
    modelId: created.model.id,
    conversationId: created.conversation.id,
  };
};

const commitOneModelEffect = (
  value: Fixture,
  requestKey: string,
): void => {
  const turnId = stableId(
    "turn",
    `${value.conversationId}:${requestKey}`,
  );
  const actionId = stableId("action", `${turnId}:test-effect`);
  const transactionId = `mutation_goal_${createHash("sha256")
    .update(actionId).digest("hex").slice(0, 32)}`;
  value.store.recordAction({
    id: actionId,
    conversationId: value.conversationId,
    turnId,
    actionKind: "model_files_mutate",
    intent: { source: "focused-goal-finalization-test" },
    permissionDecision: "allowed",
    state: "authorized",
    createdAt: NOW,
  });
  value.store.transitionActionRecord({
    id: actionId,
    expectedState: "authorized",
    state: "staging",
    mutationTransactionId: transactionId,
    at: NOW,
  });
  const code = value.store.listObjectFiles({
    kind: "model",
    id: value.modelId,
  }).find((file) => file.kind === "model_code")!;
  const changed = value.store.mutateModelFiles({
    modelId: value.modelId,
    transactionId,
    updatedAt: NOW,
    files: [{
      objectFileId: code.id,
      kind: "model_code",
      relativePath: code.relativePath.replace(/^code\//u, ""),
      mediaType: code.mediaType,
      bytes: Buffer.from(`print(${JSON.stringify(requestKey)})\n`),
      expectedPriorSha256: code.sha256,
    }],
  });
  value.store.transitionActionRecord({
    id: actionId,
    expectedState: "staging",
    state: "committed",
    mutationTransactionId: transactionId,
    affectedResources: changed.map((file) => ({
      kind: "model_file",
      id: file.id,
      sha256: file.sha256,
    })),
    at: NOW,
  });
};

const assertBoundedRefresh = async (
  value: Fixture,
  expectedDisposition: string,
  promptCanary: string,
  expectedStatus: "idle" | "waiting_for_user" | "failed",
): Promise<void> => {
  const refreshed = await value.service.conversationRuntime(
    value.conversationId,
  );
  assert.equal(refreshed.status, expectedStatus);
  assert.equal(
    refreshed.goalVerification?.disposition,
    expectedDisposition,
  );
  const serialized = JSON.stringify(refreshed);
  assert.equal(serialized.includes(promptCanary), false);
  assert.equal(serialized.includes(PRIVATE_PATH), false);
  assert.equal(serialized.includes("opaque-session-"), false);
  assert.equal(serialized.includes("goalDigest"), false);
};

test("provider-down finalizes a bounded read-only goal receipt", async () => {
  const value = await fixture("provider-down");
  const promptCanary = "PROMPT_SECRET_PROVIDER_DOWN";
  try {
    value.openCode.catalogue = [];
    const result = await value.service.runTurn({
      conversationId: value.conversationId,
      requestKey: "request-provider-down",
      text: `Explain the Model. ${promptCanary} ${PRIVATE_PATH}`,
    });
    assert.equal(result.mode, "read_only");
    assert.equal(result.turn.goalVerification?.disposition, "read_only");
    assert.deepEqual(result.turn.failure, {
      code: "provider_unavailable",
      retryable: true,
    });
    await assertBoundedRefresh(
      value,
      "read_only",
      promptCanary,
      "failed",
    );
  } finally {
    value.store.close();
    rmSync(value.root, { recursive: true, force: true });
  }
});

for (const scenario of [
  {
    name: "timeout-no-effect",
    outcome: "timeout",
    withEffect: false,
    expectedDisposition: "budget_exhausted",
    expectedFailure: "agent_budget_exhausted",
  },
  {
    name: "timeout-after-effect",
    outcome: "timeout",
    withEffect: true,
    expectedDisposition: "outcome_unknown",
    expectedFailure: "agent_outcome_unknown",
  },
  {
    name: "stale-after-effect",
    outcome: "stale",
    withEffect: true,
    expectedDisposition: "outcome_unknown",
    expectedFailure: "agent_outcome_unknown",
  },
  {
    name: "abort-after-effect",
    outcome: "abort",
    withEffect: true,
    expectedDisposition: "outcome_unknown",
    expectedFailure: "agent_outcome_unknown",
  },
] as const) {
  test(`${scenario.name} finalizes the stable non-retryable goal outcome`, async () => {
    const value = await fixture(scenario.name);
    const requestKey = `request-${scenario.name}`;
    const promptCanary = `PROMPT_SECRET_${scenario.name.toUpperCase()}`;
    try {
      value.openCode.outcome = scenario.outcome;
      if (scenario.withEffect) {
        value.openCode.beforeFailure = () =>
          commitOneModelEffect(value, requestKey);
      }
      const result = await value.service.runTurn({
        conversationId: value.conversationId,
        requestKey,
        text: `Create a visual Model. ${promptCanary} ${PRIVATE_PATH}`,
      });
      assert.equal(result.mode, "read_only");
      assert.equal(result.reason, scenario.expectedFailure);
      assert.equal(
        result.turn.goalVerification?.disposition,
        scenario.expectedDisposition,
      );
      assert.deepEqual(result.turn.failure, {
        code: scenario.expectedFailure,
        retryable: false,
      });
      await assertBoundedRefresh(
        value,
        scenario.expectedDisposition,
        promptCanary,
        "failed",
      );
    } finally {
      value.store.close();
      rmSync(value.root, { recursive: true, force: true });
    }
  });
}

for (const scenario of [
  {
    name: "explicit-idle-no-action",
    text: "Create a visual Model.",
    expectedDisposition: "needs_user_input",
    expectedStatus: "waiting_for_user",
  },
  {
    name: "chinese-visual-model-idle-no-action",
    text: "将 wind-turbine-visual 建立为可视化仿真模型。",
    expectedDisposition: "needs_user_input",
    expectedStatus: "waiting_for_user",
  },
  {
    name: "chinese-open-visual-idle-no-action",
    text: "打开风机运维可视化仿真页面",
    expectedDisposition: "needs_user_input",
    expectedStatus: "waiting_for_user",
  },
  {
    name: "proposal-idle",
    text: "Explain the current Model.",
    expectedDisposition: "completed",
    expectedStatus: "idle",
  },
] as const) {
  test(`${scenario.name} restores its durable idle disposition`, async () => {
    const value = await fixture(scenario.name);
    const promptCanary = `PROMPT_SECRET_${scenario.name.toUpperCase()}`;
    try {
      const result = await value.service.runTurn({
        conversationId: value.conversationId,
        requestKey: `request-${scenario.name}`,
        text: `${scenario.text} ${promptCanary} ${PRIVATE_PATH}`,
      });
      assert.equal(result.mode, "live");
      assert.equal(
        result.turn.goalVerification?.disposition,
        scenario.expectedDisposition,
      );
      assert.equal(result.turn.failure, null);
      await assertBoundedRefresh(
        value,
        scenario.expectedDisposition,
        promptCanary,
        scenario.expectedStatus,
      );
    } finally {
      value.store.close();
      rmSync(value.root, { recursive: true, force: true });
    }
  });
}
