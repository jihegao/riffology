import { canonicalDigest } from "./canonical-json-v2.ts";
import type {
  ActionRecordDto,
  AgentGoalDisposition,
  AgentGoalVerificationReceipt,
} from "./agent-domain.ts";

export type AgentGoalVerificationInput = Readonly<{
  phase: "idle" | "read_only" | "failed" | "timeout" | "interrupted";
  goalText: string;
  goalDigest: string;
  intentAuthority: "explicit" | "proposal_only";
  ownerKind: "model" | "project";
  sessionGeneration: number | null;
  assistantDelivered: boolean;
  actions: readonly ActionRecordDto[];
  ownerEvidence: Readonly<{
    stateDigest: string | null;
    runMode: "batch" | "visual" | "both" | null;
    executionDescriptionValid: boolean;
    affectedResourcesVerified: boolean;
  }>;
  verifiedAt: string;
}>;

const TERMINAL_ACTION_STATES = new Set([
  "committed",
  "denied",
  "rolled_back",
  "failed",
]);
export const AGENT_GOAL_REASON_CODES = Object.freeze([
  "action_reconciliation_incomplete",
  "committed_receipt_state_mismatch",
  "agent_read_only",
  "wall_budget_exhausted_after_action",
  "wall_budget_exhausted_without_effect",
  "interrupted_after_action",
  "interrupted_before_action",
  "agent_failed_after_action",
  "agent_failed_without_effect",
  "durable_response_delivered",
  "assistant_response_missing",
  "partial_effect_requires_review",
  "action_requires_user_input",
  "visual_model_state_verified",
  "visual_model_goal_unverified",
  "committed_owner_state_verified",
  "explicit_goal_unverified",
] as const);

export const goalVerificationIntentAuthority = (
  text: string,
  capabilityIntentAuthority: "explicit" | "proposal_only" = "proposal_only",
): "explicit" | "proposal_only" => {
  if (capabilityIntentAuthority === "explicit") return "explicit";
  const normalized = text.trim().toLowerCase();
  const mutationImperative =
    /^(?:please\s+)?(?:set|change|update|replace|add|create|write|modify|apply|adopt|reject|supersede|remove|delete)\b|^(?:请)?(?:设置|修改|更新|替换|新增|创建|建立|写入|应用|采用|拒绝|取代|删除)|^(?:请)?(?:把|将(?!来))[^?？\n]{1,500}(?:设置|修改|更新|替换|新增|创建|建立|写入|应用|采用|拒绝|取代|删除)/u;
  const visualNavigation =
    /^(?:please\s+)?(?:open|launch|start|show)\b[\s\S]{0,500}\b(?:visual|visualization|simulation|page)\b|^(?:请)?(?:打开|启动|展示)[\s\S]{0,500}(?:可视化|仿真|页面)/iu;
  return mutationImperative.test(normalized) || visualNavigation.test(normalized)
    ? "explicit"
    : "proposal_only";
};

export const verifyAgentGoal = (
  input: AgentGoalVerificationInput,
): AgentGoalVerificationReceipt => {
  if (!/^[0-9a-f]{64}$/u.test(input.goalDigest)) {
    throw new Error("Agent goal digest is invalid.");
  }
  const actions = [...input.actions];
  const committed = actions.filter((action) => action.state === "committed");
  const committedEffectsDeclared = committed.every((action) =>
    Array.isArray(action.affectedResources)
    && action.affectedResources.length > 0);
  const terminal = actions.filter((action) =>
    TERMINAL_ACTION_STATES.has(action.state));
  const nonterminal = terminal.length !== actions.length;
  const unsuccessful = actions.filter((action) =>
    action.state === "denied"
    || action.state === "rolled_back"
    || action.state === "failed");
  const partialEffect = committed.length > 0 && unsuccessful.length > 0;
  const affectedResourceCount = committed.reduce(
    (count, action) =>
      count + (Array.isArray(action.affectedResources)
        ? action.affectedResources.length
        : 0),
    0,
  );
  const visualGoal = input.ownerKind === "model"
    && input.intentAuthority === "explicit"
    && visualModelMutationGoal(input.goalText);
  const committedVisualMutation = committed.some((action) =>
    action.actionKind === "model_files_mutate"
    && Array.isArray(action.affectedResources)
    && action.affectedResources.some((resource) =>
      Boolean(resource)
      && typeof resource === "object"
      && (resource as { kind?: unknown }).kind === "model_file"));
  const intentKind = visualGoal
    ? "model_visual" as const
    : input.intentAuthority === "explicit"
      ? "explicit_mutation" as const
      : "response_delivery" as const;
  let disposition: AgentGoalDisposition;
  let reasonCode: string;

  if (nonterminal || (committed.length > 0
    && (!committedEffectsDeclared
      || !input.ownerEvidence.affectedResourcesVerified))) {
    disposition = "outcome_unknown";
    reasonCode = nonterminal
      ? "action_reconciliation_incomplete"
      : "committed_receipt_state_mismatch";
  } else if (input.phase === "read_only") {
    if (actions.length > 0) {
      disposition = "outcome_unknown";
      reasonCode = "agent_failed_after_action";
    } else {
      disposition = "read_only";
      reasonCode = "agent_read_only";
    }
  } else if (input.phase === "timeout") {
    if (committed.length > 0 || actions.length !== terminal.length) {
      disposition = "outcome_unknown";
      reasonCode = "wall_budget_exhausted_after_action";
    } else {
      disposition = "budget_exhausted";
      reasonCode = "wall_budget_exhausted_without_effect";
    }
  } else if (input.phase === "interrupted") {
    if (actions.length > 0) {
      disposition = "outcome_unknown";
      reasonCode = "interrupted_after_action";
    } else {
      disposition = "failed";
      reasonCode = "interrupted_before_action";
    }
  } else if (input.phase === "failed") {
    if (committed.length > 0 || partialEffect) {
      disposition = "outcome_unknown";
      reasonCode = "agent_failed_after_action";
    } else {
      disposition = "failed";
      reasonCode = "agent_failed_without_effect";
    }
  } else if (input.intentAuthority === "proposal_only") {
    disposition = input.assistantDelivered ? "completed" : "failed";
    reasonCode = input.assistantDelivered
      ? "durable_response_delivered"
      : "assistant_response_missing";
  } else if (partialEffect || unsuccessful.length > 0) {
    disposition = "needs_user_input";
    reasonCode = partialEffect
      ? "partial_effect_requires_review"
      : "action_requires_user_input";
  } else if (visualGoal) {
    if (committedVisualMutation
      && input.ownerEvidence.stateDigest
      && (input.ownerEvidence.runMode === "visual"
        || input.ownerEvidence.runMode === "both")
      && input.ownerEvidence.executionDescriptionValid
      && input.ownerEvidence.affectedResourcesVerified) {
      disposition = "completed";
      reasonCode = "visual_model_state_verified";
    } else {
      disposition = "needs_user_input";
      reasonCode = "visual_model_goal_unverified";
    }
  } else if (committed.length > 0
    && input.ownerEvidence.stateDigest
    && input.ownerEvidence.affectedResourcesVerified
    && genericExplicitGoalMatchesCommittedActions(
      input.goalText,
      input.ownerKind,
      committed,
    )) {
    disposition = "completed";
    reasonCode = "committed_owner_state_verified";
  } else {
    disposition = "needs_user_input";
    reasonCode = "explicit_goal_unverified";
  }

  const unsigned = Object.freeze({
    schemaVersion: 1 as const,
    disposition,
    reasonCode,
    goalDigest: input.goalDigest,
    sessionGeneration: input.sessionGeneration,
    evidence: Object.freeze({
      openCodeTerminal: input.phase === "idle"
        ? "idle" as const
        : input.phase === "read_only"
          ? "not_reached" as const
          : "unknown" as const,
      intentKind,
      actionCount: actions.length,
      terminalActionCount: terminal.length,
      committedActionCount: committed.length,
      affectedResourceCount,
      ownerStateDigest: input.ownerEvidence.stateDigest,
      ownerStateVerified: input.ownerEvidence.affectedResourcesVerified
        && input.ownerEvidence.executionDescriptionValid,
      partialEffect,
    }),
    verifiedAt: input.verifiedAt,
  });
  return Object.freeze({
    ...unsigned,
    receiptDigest: canonicalDigest(unsigned),
  });
};

const genericExplicitGoalMatchesCommittedActions = (
  goalText: string,
  ownerKind: "model" | "project",
  committed: readonly ActionRecordDto[],
): boolean => {
  const text = goalText.toLowerCase();
  const destructiveOwnerRequest =
    /\b(?:delete|remove)\b[\s\S]{0,120}\b(?:model|project)\b|(?:删除|移除)[^。！？\n]{0,120}(?:模型|项目)/iu.test(text);
  if (destructiveOwnerRequest) return false;
  return committed.every((action) => {
    if (action.actionKind === "model_files_mutate") {
      return ownerKind === "model"
        && /\b(?:model|workspace|file|code|environment)\b|(?:模型|工作区|文件|代码|环境)/iu.test(text);
    }
    if (action.actionKind === "experiment_configuration_update") {
      return ownerKind === "project"
        && /\b(?:experiment|configuration)\b|(?:实验|配置)/iu.test(text);
    }
    if (action.actionKind === "analysis_document_create") {
      return /\b(?:analysis|report|document)\b|(?:分析|报告|文档)/iu.test(text);
    }
    if (action.actionKind === "temporary_document_create") {
      return /\b(?:draft|note|document)\b|(?:草稿|笔记|文档)/iu.test(text);
    }
    if (action.actionKind === "attachment_adopt") {
      return /\b(?:adopt|attachment)\b|(?:采用|附件)/iu.test(text);
    }
    if (action.actionKind === "model_generated_views_publish") {
      return ownerKind === "model"
        && /\b(?:generated view|diagram|structure view)\b|(?:生成视图|结构视图|图示)/iu.test(text);
    }
    return false;
  });
};

const visualModelMutationGoal = (goalText: string): boolean => {
  const text = goalText.trim().toLowerCase();
  const visualTarget = /\bvisual(?:ization)?\b|可视化/iu.test(text);
  const mutationImperative =
    /^(?:please\s+)?(?:set|change|update|replace|add|create|write|modify|apply)\b|^(?:请)?(?:设置|修改|更新|替换|新增|创建|建立|写入|应用)|^(?:请)?(?:把|将(?!来))[^?？\n]{1,500}(?:设置|修改|更新|替换|新增|创建|建立|写入|应用)/u;
  return visualTarget && mutationImperative.test(text);
};
