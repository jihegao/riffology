import assert from "node:assert/strict";
import test from "node:test";
import type { ActionRecordDto } from "../src/agent-domain.ts";
import {
  type AgentGoalVerificationInput,
  verifyAgentGoal,
} from "../src/agent-goal-verifier.ts";
import { canonicalDigest } from "../src/canonical-json-v2.ts";

const INTENT_DIGEST = "a".repeat(64);
const OWNER_STATE_DIGEST = "b".repeat(64);
const VERIFIED_AT = "2026-07-26T05:00:00.000Z";

const action = (
  state: ActionRecordDto["state"],
  suffix: string,
  affectedResources: unknown = [],
): ActionRecordDto => ({
  id: `action_${suffix}`,
  actionKind: `test_${suffix}`,
  intent: { operation: suffix },
  permissionDecision: state === "denied" ? "denied" : "allowed",
  state,
  mutationTransactionId: state === "committed"
    ? `mutation_${suffix}`
    : null,
  affectedResources,
  errorCode: state === "failed" ? "bounded_test_failure" : null,
});

const input = (
  overrides: Partial<AgentGoalVerificationInput> = {},
): AgentGoalVerificationInput => ({
  phase: "idle",
  goalText: "Update the current Model.",
  goalDigest: INTENT_DIGEST,
  intentAuthority: "explicit",
  ownerKind: "model",
  sessionGeneration: 4,
  assistantDelivered: true,
  actions: [],
  ownerEvidence: {
    stateDigest: OWNER_STATE_DIGEST,
    runMode: "batch",
    executionDescriptionValid: true,
    affectedResourcesVerified: true,
  },
  verifiedAt: VERIFIED_AT,
  ...overrides,
});

test("proposal-only response delivery completes without claiming a mutation", () => {
  const receipt = verifyAgentGoal(input({
    goalText: "Explain the current Model.",
    intentAuthority: "proposal_only",
    actions: [],
  }));
  assert.equal(receipt.disposition, "completed");
  assert.equal(receipt.reasonCode, "durable_response_delivered");
  assert.deepEqual(receipt.evidence, {
    openCodeTerminal: "idle",
    intentKind: "response_delivery",
    actionCount: 0,
    terminalActionCount: 0,
    committedActionCount: 0,
    affectedResourceCount: 0,
    ownerStateDigest: OWNER_STATE_DIGEST,
    ownerStateVerified: true,
    partialEffect: false,
  });
});

test("an explicit goal with no committed action needs user input", () => {
  const receipt = verifyAgentGoal(input());
  assert.equal(receipt.disposition, "needs_user_input");
  assert.equal(receipt.reasonCode, "explicit_goal_unverified");
  assert.equal(receipt.evidence.intentKind, "explicit_mutation");
  assert.equal(receipt.evidence.openCodeTerminal, "idle");
});

test("generic completion requires a nonempty, goal-matched committed effect", () => {
  const emptyEffect = verifyAgentGoal(input({
    actions: [action("committed", "empty")],
  }));
  assert.equal(emptyEffect.disposition, "outcome_unknown");
  assert.equal(emptyEffect.reasonCode, "committed_receipt_state_mismatch");

  const unrelated = verifyAgentGoal(input({
    goalText: "Delete the current Model now.",
    actions: [{
      ...action("committed", "unrelated", [{
        kind: "model_file",
        id: "file_unrelated",
        sha256: "c".repeat(64),
      }]),
      actionKind: "model_files_mutate",
    }],
  }));
  assert.equal(unrelated.disposition, "needs_user_input");
  assert.equal(unrelated.reasonCode, "explicit_goal_unverified");

  const matched = verifyAgentGoal(input({
    goalText: "Update the current Model file.",
    actions: [{
      ...action("committed", "matched", [{
        kind: "model_file",
        id: "file_matched",
        sha256: "d".repeat(64),
      }]),
      actionKind: "model_files_mutate",
    }],
  }));
  assert.equal(matched.disposition, "completed");
  assert.equal(matched.reasonCode, "committed_owner_state_verified");
});

test("generated-view publication can satisfy a view goal but never a visual Model mutation goal", () => {
  const generated = {
    ...action("committed", "generated_views", [{
      kind: "model_generated_view_set",
      id: "model_views",
      sha256: "e".repeat(64),
    }]),
    actionKind: "model_generated_views_publish",
  };
  const viewGoal = verifyAgentGoal(input({
    goalText: "Generate a structure view for this Model.",
    actions: [generated],
  }));
  assert.equal(viewGoal.disposition, "completed");
  assert.equal(viewGoal.reasonCode, "committed_owner_state_verified");

  const visualModelGoal = verifyAgentGoal(input({
    goalText: "Create a visualization Model.",
    actions: [generated],
    ownerEvidence: {
      ...input().ownerEvidence,
      runMode: "visual",
    },
  }));
  assert.equal(visualModelGoal.disposition, "needs_user_input");
  assert.equal(visualModelGoal.reasonCode, "visual_model_goal_unverified");
});

test("a visual Model goal rejects batch evidence and accepts visual or both only with current committed evidence", () => {
  const committed = {
    ...action("committed", "visual", [
      { kind: "model_file", id: "file_visual", sha256: "c".repeat(64) },
      { kind: "execution_description", id: "model_visual", sha256: "d".repeat(64) },
    ]),
    actionKind: "model_files_mutate",
  };
  const visualInput = {
    goalText: "Create a visualization Model.",
    actions: [committed],
  } satisfies Partial<AgentGoalVerificationInput>;

  const batch = verifyAgentGoal(input({
    ...visualInput,
    ownerEvidence: {
      ...input().ownerEvidence,
      runMode: "batch",
    },
  }));
  assert.equal(batch.disposition, "needs_user_input");
  assert.equal(batch.reasonCode, "visual_model_goal_unverified");
  assert.equal(batch.evidence.intentKind, "model_visual");

  for (const runMode of ["visual", "both"] as const) {
    const completed = verifyAgentGoal(input({
      ...visualInput,
      ownerEvidence: {
        stateDigest: OWNER_STATE_DIGEST,
        runMode,
        executionDescriptionValid: true,
        affectedResourcesVerified: true,
      },
    }));
    assert.equal(completed.disposition, "completed", runMode);
    assert.equal(completed.reasonCode, "visual_model_state_verified", runMode);
    assert.equal(completed.evidence.ownerStateVerified, true);
    assert.equal(completed.evidence.committedActionCount, 1);
    assert.equal(completed.evidence.affectedResourceCount, 2);
  }

  const unrelatedDocument = verifyAgentGoal(input({
    goalText: "Create a visualization Model.",
    actions: [{
      ...action("committed", "visual-document", [{
        kind: "temporary_document",
        id: "document_visual",
      }]),
      actionKind: "temporary_document_create",
    }],
    ownerEvidence: {
      ...input().ownerEvidence,
      runMode: "visual",
    },
  }));
  assert.equal(unrelatedDocument.disposition, "needs_user_input");
  assert.equal(
    unrelatedDocument.reasonCode,
    "visual_model_goal_unverified",
  );

  for (const ownerEvidence of [
    {
      stateDigest: null,
      runMode: "visual" as const,
      executionDescriptionValid: true,
      affectedResourcesVerified: true,
    },
    {
      stateDigest: OWNER_STATE_DIGEST,
      runMode: "visual" as const,
      executionDescriptionValid: false,
      affectedResourcesVerified: true,
    },
  ]) {
    const unverified = verifyAgentGoal(input({
      ...visualInput,
      ownerEvidence,
    }));
    assert.equal(unverified.disposition, "needs_user_input");
    assert.equal(unverified.reasonCode, "visual_model_goal_unverified");
  }
});

test("denied and partially successful actions require explicit user review", () => {
  const denied = verifyAgentGoal(input({
    actions: [action("denied", "denied")],
  }));
  assert.equal(denied.disposition, "needs_user_input");
  assert.equal(denied.reasonCode, "action_requires_user_input");
  assert.equal(denied.evidence.partialEffect, false);

  const partial = verifyAgentGoal(input({
    actions: [
      action("committed", "committed", [{ kind: "model_file", id: "file_a" }]),
      action("failed", "failed"),
    ],
  }));
  assert.equal(partial.disposition, "needs_user_input");
  assert.equal(partial.reasonCode, "partial_effect_requires_review");
  assert.equal(partial.evidence.partialEffect, true);
  assert.equal(partial.evidence.committedActionCount, 1);
  assert.equal(partial.evidence.terminalActionCount, 2);
});

test("nonterminal actions and committed receipt drift remain outcome unknown", () => {
  const nonterminal = verifyAgentGoal(input({
    actions: [action("staging", "staging")],
  }));
  assert.equal(nonterminal.disposition, "outcome_unknown");
  assert.equal(nonterminal.reasonCode, "action_reconciliation_incomplete");
  assert.equal(nonterminal.evidence.terminalActionCount, 0);

  const receiptDrift = verifyAgentGoal(input({
    actions: [
      action("committed", "drift", [{ kind: "model_file", id: "file_drift" }]),
    ],
    ownerEvidence: {
      ...input().ownerEvidence,
      affectedResourcesVerified: false,
    },
  }));
  assert.equal(receiptDrift.disposition, "outcome_unknown");
  assert.equal(receiptDrift.reasonCode, "committed_receipt_state_mismatch");
  assert.equal(receiptDrift.evidence.ownerStateVerified, false);
});

test("timeout without effect exhausts budget while timeout after an action is unknown", () => {
  const withoutEffect = verifyAgentGoal(input({
    phase: "timeout",
    actions: [],
  }));
  assert.equal(withoutEffect.disposition, "budget_exhausted");
  assert.equal(withoutEffect.reasonCode, "wall_budget_exhausted_without_effect");
  assert.equal(withoutEffect.evidence.openCodeTerminal, "unknown");

  const afterAction = verifyAgentGoal(input({
    phase: "timeout",
    actions: [
      action("committed", "timeout", [{ kind: "model_file", id: "file_timeout" }]),
    ],
  }));
  assert.equal(afterAction.disposition, "outcome_unknown");
  assert.equal(afterAction.reasonCode, "wall_budget_exhausted_after_action");
});

test("interruption before an action fails while interruption after an action is unknown", () => {
  const beforeAction = verifyAgentGoal(input({
    phase: "interrupted",
    actions: [],
  }));
  assert.equal(beforeAction.disposition, "failed");
  assert.equal(beforeAction.reasonCode, "interrupted_before_action");

  const afterAction = verifyAgentGoal(input({
    phase: "interrupted",
    actions: [action("denied", "interrupted")],
  }));
  assert.equal(afterAction.disposition, "outcome_unknown");
  assert.equal(afterAction.reasonCode, "interrupted_after_action");
});

test("the receipt is closed, frozen, deterministic, and digest-bound to the complete intent", () => {
  const verificationInput = input({
    intentAuthority: "proposal_only",
    goalText: "Explain the Model without changing it.",
  });
  const first = verifyAgentGoal(verificationInput);
  const second = verifyAgentGoal(structuredClone(verificationInput));
  assert.deepEqual(first, second);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.evidence), true);
  assert.deepEqual(Object.keys(first).sort(), [
    "disposition",
    "evidence",
    "goalDigest",
    "reasonCode",
    "receiptDigest",
    "schemaVersion",
    "sessionGeneration",
    "verifiedAt",
  ]);
  assert.deepEqual(Object.keys(first.evidence).sort(), [
    "actionCount",
    "affectedResourceCount",
    "committedActionCount",
    "intentKind",
    "openCodeTerminal",
    "ownerStateDigest",
    "ownerStateVerified",
    "partialEffect",
    "terminalActionCount",
  ]);
  assert.equal(first.goalDigest, INTENT_DIGEST);
  const { receiptDigest, ...unsigned } = first;
  assert.equal(receiptDigest, canonicalDigest(unsigned));
  assert.equal(JSON.stringify(first).includes(verificationInput.goalText), false);
  assert.notEqual(
    verifyAgentGoal({ ...verificationInput, goalDigest: "f".repeat(64) }).receiptDigest,
    receiptDigest,
  );
});
