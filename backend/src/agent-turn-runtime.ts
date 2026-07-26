import { createHash } from "node:crypto";
import { ApiError } from "./errors.ts";
import { canonicalJsonV2 } from "./canonical-json-v2.ts";
import { AgentMcpServer } from "./agent-mcp.ts";
import { toolsForOwner, type AgentToolExecutor, type AgentToolGrant, type AgentToolName } from "./agent-tools.ts";
import type { AgentContextInput } from "./agent-context.ts";
import type { ConversationOwner, ModelFileMutation } from "./agent-domain.ts";
import {
  experimentConfigurationRecordDigest,
  ProductStoreV2,
  type ExperimentConfigurationRecordV4,
} from "./product-store-v2.ts";
import { planExperiment } from "./experiment-planner.ts";
import { SimulationSkillCatalog, type LoadedSimulationSkill } from "./simulation-skill-catalog.ts";
import { VisualAgentAuthority } from "./agent-visual-authority.ts";

const VISUAL_OBSERVATION_OPERATIONS = Object.freeze({
  structured: "observe_structured",
  accessibility: "observe_accessibility",
  dom_text: "observe_dom_text",
  screenshot: "observe_screenshot",
} as const);

export type PreparedAgentTurnRuntime = Readonly<{
  capability: string;
  turnId: string;
  externalSessionGeneration: number;
  intentAuthority: "explicit" | "proposal_only";
  requiresMcp: boolean;
  /** Exact, sorted Riff tool names projected into this turn's OpenCode prompt. */
  allowedTools: readonly AgentToolName[];
  context: Pick<AgentContextInput, "attachments" | "documents" | "selectedSkills">;
  promptAttachments: Array<{ id: string; mediaType: string; workspaceRelativePath: string }>;
  release(): void;
}>;

export class AgentTurnRuntime implements AgentToolExecutor {
  readonly store: ProductStoreV2;
  readonly skills: SimulationSkillCatalog;
  readonly mcp: AgentMcpServer;
  readonly visualAuthority?: VisualAgentAuthority;
  readonly #now: () => string;
  readonly #authorityIssuanceAllowed: (
    scope: Readonly<{
      modelIds?: ReadonlySet<string>;
      projectIds?: ReadonlySet<string>;
      conversationIds: ReadonlySet<string>;
    }>,
  ) => boolean;
  readonly #consumedVisualInteractionGrants = new WeakSet<AgentToolGrant>();

  constructor(store: ProductStoreV2, skills: SimulationSkillCatalog, options: {
    now?: () => string;
    capabilityTtlMs?: number;
    visualAuthority?: VisualAgentAuthority;
    authorityIssuanceAllowed?: (
      scope: Readonly<{
        modelIds?: ReadonlySet<string>;
        projectIds?: ReadonlySet<string>;
        conversationIds: ReadonlySet<string>;
      }>,
    ) => boolean;
  } = {}) {
    this.store = store;
    this.skills = skills;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.mcp = new AgentMcpServer(this, { ttlMs: options.capabilityTtlMs });
    this.visualAuthority = options.visualAuthority;
    this.#authorityIssuanceAllowed = options.authorityIssuanceAllowed
      ?? (() => true);
  }

  async prepare(input: { conversationId: string; turnId: string; text: string; attachmentIds: string[]; confirmedVisualInteraction?: import("./agent-visual-authority.ts").VisualAgentOperation }): Promise<PreparedAgentTurnRuntime> {
    const conversation = this.store.getConversation(input.conversationId);
    const authorityScope = {
      conversationIds: new Set([input.conversationId]),
      ...(conversation.owner.kind === "model"
        ? { modelIds: new Set([conversation.owner.id]) }
        : { projectIds: new Set([conversation.owner.id]) }),
    };
    if (!this.#authorityIssuanceAllowed(authorityScope)) {
      throw new ApiError(
        409,
        "resource_deletion_in_progress",
        "The resource is being permanently deleted.",
      );
    }
    const runtime = await this.store.getConversationRuntime(input.conversationId);
    if (!runtime) throw new ApiError(409, "conversation_not_ready", "The conversation is not ready for an Agent turn.");
    const intentText = input.text.replace(/(?:^|\s)\$[a-z0-9][a-z0-9-]{1,63}(?=\s|$)/gu, " ").trim();
    const intentAuthority = explicitImperative(intentText) ? "explicit" : "proposal_only";
    const loadedSkill = this.#routeSkill(input.text, input.conversationId, input.turnId);
    const attachments = input.attachmentIds.map((id) => {
      const metadata = this.store.getConversationAttachment(id);
      if (metadata.conversationId !== input.conversationId) throw new ApiError(422, "attachment_scope_mismatch", "An attachment does not belong to this conversation.");
      const previewable = new Set(["text/plain", "text/markdown", "text/csv", "application/json"]).has(metadata.mediaType);
      const preview = previewable && metadata.sizeBytes <= 64_000
        ? this.store.readConversationAttachment(id, input.conversationId, 64_000).toString("utf8")
        : `[${metadata.mediaType}; ${metadata.sizeBytes} bytes; preview omitted]`;
      return { metadata, preview };
    });
    const generation = runtime.session?.state === "available"
      ? runtime.session.generation
      : (runtime.session?.generation ?? 0) + 1;
    const allowedTools = new Set(toolsForOwner(conversation.owner));
    if (!this.visualAuthority?.observationAvailable) {
      allowedTools.delete("riff_observe_current_visual");
    }
    if (!input.confirmedVisualInteraction
      || conversation.owner.kind !== "project"
      || !this.visualAuthority?.interactionAvailable) {
      allowedTools.delete("riff_interact_current_visual");
    } else {
      try {
        this.store.assertConfirmedVisualInteraction({ conversationId: input.conversationId, turnId: input.turnId, operation: input.confirmedVisualInteraction });
        allowedTools.add("riff_interact_current_visual");
      } catch { allowedTools.delete("riff_interact_current_visual"); }
    }
    if (intentAuthority !== "explicit") {
      allowedTools.delete("riff_apply_model_changes");
      allowedTools.delete("riff_update_experiment_configuration");
      allowedTools.delete("riff_create_analysis_document");
      allowedTools.delete("riff_transition_temporary_document");
      allowedTools.delete("riff_adopt_attachment");
    }
    if (conversation.owner.kind === "project") {
      if (!explicitExperimentUpdateIntent(intentText)) {
        allowedTools.delete("riff_update_experiment_configuration");
      }
      if (!explicitAnalysisDocumentIntent(intentText)) {
        allowedTools.delete("riff_create_analysis_document");
      }
    }
    if (!this.#authorityIssuanceAllowed(authorityScope)) {
      throw new ApiError(
        409,
        "resource_deletion_in_progress",
        "The resource is being permanently deleted.",
      );
    }
    const capability = this.mcp.grant({
      conversationId: input.conversationId,
      owner: conversation.owner,
      turnId: input.turnId,
      externalSessionGeneration: Math.max(1, generation),
      allowedTools,
      intentAuthority,
      attachmentIds: new Set(input.attachmentIds),
      ...(allowedTools.has("riff_interact_current_visual") ? { confirmedVisualInteraction: input.confirmedVisualInteraction } : {}),
    });
    const exactAllowedTools = Object.freeze(
      [...allowedTools].sort((left, right) => left.localeCompare(right, "en")),
    );
    return Object.freeze({
      capability,
      turnId: input.turnId,
      externalSessionGeneration: Math.max(1, generation),
      intentAuthority,
      requiresMcp: intentAuthority === "explicit" || Boolean(input.confirmedVisualInteraction)
        || input.attachmentIds.length > 0 || Boolean(loadedSkill)
        || /\b(?:model|workspace|file|document|attachment|schema|dependency|visual|observe|screenshot)\b|(?:模型|工作区|文件|文档|附件|模式|依赖|可视化|观察|截图)/iu.test(intentText),
      allowedTools: exactAllowedTools,
      context: {
        attachments: attachments.map(({ metadata, preview }) => ({ id: metadata.id, conversationId: input.conversationId, mediaType: metadata.mediaType, preview, relevant: true })),
        documents: this.store.listTemporaryDocuments(input.conversationId).filter((document) => document.lifecycleState === "active")
          .map((document) => ({ id: document.id, conversationId: input.conversationId, mediaType: document.mediaType, text: document.content, relevant: true })),
        selectedSkills: loadedSkill ? [{ id: loadedSkill.id, version: loadedSkill.version, instructions: loadedSkill.instructions }] : [],
      },
      promptAttachments: attachments.map(({ metadata }) => ({ id: metadata.id, mediaType: metadata.mediaType, workspaceRelativePath: metadata.relativePath })),
      release: () => {
        this.mcp.revoke(capability);
        this.visualAuthority?.revokeTurn(input.conversationId, input.turnId);
      },
    });
  }

  revokeAll(): void {
    this.mcp.revokeAll();
    this.visualAuthority?.revokeAll();
  }

  revokeVisualRun(runId: string): void {
    this.visualAuthority?.revokeRun(runId);
  }

  hasActiveAuthority(input: {
    conversationIds: ReadonlySet<string>;
    projectIds: ReadonlySet<string>;
    runIds: ReadonlySet<string>;
  }): boolean {
    return this.mcp.hasActiveConversation(input.conversationIds)
      || Boolean(this.visualAuthority?.hasActiveScope({
        projectIds: input.projectIds,
        runIds: input.runIds,
      }));
  }

  handle(capability: string | undefined, request: unknown) {
    return this.mcp.handle(capability, request as any);
  }

  async execute(grant: AgentToolGrant, tool: AgentToolName, input: Readonly<Record<string, unknown>>): Promise<unknown> {
    const conversation = this.store.getConversation(grant.conversationId);
    if (conversation.owner.kind !== grant.owner.kind || conversation.owner.id !== grant.owner.id) throw new AgentRuntimeError("scope_changed", "The durable conversation scope changed.");
    if (!grant.allowedTools.has(tool)) {
      throw new AgentRuntimeError(
        "operation_not_authorized",
        "The user did not authorize this operation in the current turn.",
      );
    }
    try {
      this.store.assertActiveAgentToolGrant({
        conversationId: grant.conversationId,
        turnId: grant.turnId,
        externalSessionGeneration: grant.externalSessionGeneration,
      });
    } catch {
      throw new AgentRuntimeError("stale_capability", "The Agent capability no longer matches the active turn and session generation.");
    }
    if (grant.intentAuthority !== "explicit" && new Set<AgentToolName>([
      "riff_apply_model_changes",
      "riff_update_experiment_configuration",
      "riff_create_analysis_document",
      "riff_transition_temporary_document",
      "riff_adopt_attachment",
    ]).has(tool)) throw new AgentRuntimeError("explicit_intent_required", "This durable action requires an explicit imperative.");
    switch (tool) {
      case "riff_read_owner_summary": return this.#ownerSummary(grant.owner);
      case "riff_list_model_workspace": return this.#listModelWorkspace(grant);
      case "riff_read_model_file": return this.#readModelFile(grant, String(input.fileId));
      case "riff_apply_model_changes": return this.#applyModelChanges(grant, input);
      case "riff_list_experiment_configurations":
        return this.#listExperimentConfigurations(grant);
      case "riff_update_experiment_configuration":
        return this.#updateExperimentConfiguration(grant, input);
      case "riff_create_analysis_document":
        return this.#createTemporaryDocument(
          grant,
          input,
          "analysis_document_create",
          true,
        );
      case "riff_create_temporary_document": return this.#createTemporaryDocument(grant, input);
      case "riff_transition_temporary_document": return this.#transitionTemporaryDocument(grant, input);
      case "riff_adopt_attachment": return this.#adoptAttachment(grant, input);
      case "riff_observe_current_visual": {
        if (grant.owner.kind !== "project" || !this.visualAuthority) {
          throw new AgentRuntimeError(
            "visual_observation_unavailable",
            "The scoped visual observation is unavailable.",
          );
        }
        const kind = String(input.kind);
        const operationKind = VISUAL_OBSERVATION_OPERATIONS[
          kind as keyof typeof VISUAL_OBSERVATION_OPERATIONS
        ];
        if (!operationKind) {
          throw new AgentRuntimeError(
            "visual_observation_kind_invalid",
            "The scoped visual observation is unavailable.",
          );
        }
        return await this.visualAuthority.observe({
          conversationId: grant.conversationId,
          turnId: grant.turnId,
          externalSessionGeneration: grant.externalSessionGeneration,
          operation: Object.freeze({ kind: operationKind }),
          intentAuthority: grant.intentAuthority,
        });
      }
      case "riff_interact_current_visual": {
        if (grant.owner.kind !== "project" || !this.visualAuthority || !grant.confirmedVisualInteraction) {
          throw new AgentRuntimeError("visual_interaction_unavailable", "The scoped visual interaction is unavailable.");
        }
        if (this.#consumedVisualInteractionGrants.has(grant)) {
          throw new AgentRuntimeError("visual_interaction_consumed", "The scoped visual interaction is unavailable.");
        }
        // Synchronous consume-before-validation closes sequential and concurrent
        // replay within this process. The durable audit mint uniqueness closes
        // replay after backend restart.
        this.#consumedVisualInteractionGrants.add(grant);
        this.store.assertConfirmedVisualInteraction({ conversationId: grant.conversationId, turnId: grant.turnId, operation: grant.confirmedVisualInteraction });
        return await this.visualAuthority.interact({
          conversationId: grant.conversationId,
          turnId: grant.turnId,
          externalSessionGeneration: grant.externalSessionGeneration,
          operation: grant.confirmedVisualInteraction as Extract<import("./agent-visual-authority.ts").VisualAgentOperation, { kind: "click" | "type" | "select" }>,
          intentAuthority: "visual_interaction_confirmed",
        });
      }
    }
  }

  #routeSkill(text: string, conversationId: string, turnId: string): LoadedSimulationSkill | null {
    const explicit = /(?:^|\s)\$([a-z0-9][a-z0-9-]{1,63})(?=\s|$)/u.exec(text)?.[1];
    const metadata = this.skills.list();
    let selected = explicit ? metadata.find((skill) => skill.id === explicit) : undefined;
    let routingMode: "explicit" | "automatic" = explicit ? "explicit" : "automatic";
    if (explicit && !selected) {
      this.store.recordSkillUse({ id: stableId("skilluse", `${turnId}:${explicit}`), conversationId, turnId, skillId: explicit,
        skillVersion: "unknown", routingMode, catalogDigest: this.skills.digest, instructionDigest: "0".repeat(64), loadState: "failed",
        rationale: "Explicit skill is unknown or disallowed.", createdAt: this.#now() });
      throw new ApiError(422, "skill_unavailable", "The explicitly requested simulation skill is unavailable.");
    }
    if (!selected) {
      const words = new Set(text.toLowerCase().match(/[a-z0-9]{3,}/gu) ?? []);
      const candidate = metadata.map((skill) => ({ skill, score: (skill.description.toLowerCase().match(/[a-z0-9]{3,}/gu) ?? []).filter((word) => words.has(word)).length }))
        .sort((left, right) => right.score - left.score || left.skill.id.localeCompare(right.skill.id, "en"))[0];
      selected = candidate?.score ? candidate.skill : undefined;
    }
    if (!selected) return null;
    let loaded: LoadedSimulationSkill;
    try { loaded = this.skills.load(selected.id); }
    catch {
      this.store.recordSkillUse({ id: stableId("skilluse", `${turnId}:${selected.id}`), conversationId, turnId, skillId: selected.id,
        skillVersion: selected.version, routingMode, catalogDigest: this.skills.digest, instructionDigest: selected.instructionDigest,
        loadState: "failed", rationale: "Selected skill instructions could not be loaded.", createdAt: this.#now() });
      throw new ApiError(409, "skill_load_failed", "The selected simulation skill could not be loaded.");
    }
    this.store.recordSkillUse({ id: stableId("skilluse", `${turnId}:${selected.id}`), conversationId, turnId, skillId: selected.id,
      skillVersion: selected.version, routingMode, catalogDigest: this.skills.digest, instructionDigest: selected.instructionDigest,
      loadState: "loaded", rationale: explicit ? "Explicit user selection." : "Catalog metadata matched the turn.", createdAt: this.#now() });
    return loaded;
  }

  #ownerSummary(owner: ConversationOwner) {
    const record = owner.kind === "model"
      ? this.store.listModels({ includeArchived: true }).find((item) => item.id === owner.id)
      : this.store.listProjects({ includeArchived: true }).find((item) => item.id === owner.id);
    if (!record) throw new AgentRuntimeError("owner_missing", "The bound owner no longer exists.");
    return { owner: { ...owner }, name: record.name, lifecycleState: record.lifecycleState, ...(owner.kind === "model" ? { technicalStatus: (record as any).technicalStatus, runMode: (record as any).runMode } : { fixedModelSnapshot: true }) };
  }

  #listModelWorkspace(grant: AgentToolGrant) {
    this.#requireModel(grant);
    return this.store.listObjectFiles(grant.owner).filter((file) => ["model_code", "model_environment", "model_visual_asset"].includes(file.kind))
      .map((file) => ({ id: file.id, kind: file.kind, relativePath: stripOwnedPrefix(file.kind, file.relativePath), mediaType: file.mediaType, sizeBytes: file.sizeBytes, sha256: file.sha256 }));
  }

  #readModelFile(grant: AgentToolGrant, fileId: string) {
    const files = this.#listModelWorkspace(grant);
    const file = files.find((item) => item.id === fileId);
    if (!file) throw new AgentRuntimeError("file_scope_mismatch", "The requested file is outside the bound Model workspace.");
    if (file.sizeBytes > 256_000) throw new AgentRuntimeError("file_too_large", "The requested Model file exceeds the bounded read limit.");
    return { ...file, content: this.store.readObjectFile(file.id).toString("utf8") };
  }

  #applyModelChanges(grant: AgentToolGrant, input: Readonly<Record<string, unknown>>) {
    this.#requireModel(grant);
    const actionId = stableId("action", `${grant.turnId}:apply:${canonical(input)}`);
    this.#recordProposed(actionId, grant, "model_files_mutate", input);
    if (grant.intentAuthority !== "explicit") return this.#deny(actionId, "explicit_imperative_required");
    const raw = input.changes;
    if (!Array.isArray(raw) || !raw.length || raw.length > 64) return this.#deny(actionId, "invalid_model_changes");
    let files: ModelFileMutation[];
    try { files = raw.map(parseModelFileMutation); }
    catch { return this.#deny(actionId, "invalid_model_changes"); }
    const executionDescription = input.executionDescription;
    if (executionDescription !== undefined && (!executionDescription || typeof executionDescription !== "object" || Array.isArray(executionDescription))) return this.#deny(actionId, "invalid_execution_description");
    const at = this.#now();
    this.store.transitionActionRecord({ id: actionId, expectedState: "proposed", state: "authorized", at });
    const transactionId = `mutation_agent_${createHash("sha256").update(actionId).digest("hex").slice(0, 32)}`;
    this.store.transitionActionRecord({ id: actionId, expectedState: "authorized", state: "staging", mutationTransactionId: transactionId, at });
    try {
      const changed = this.store.mutateModelFiles({ modelId: grant.owner.id, files, ...(executionDescription ? { executionDescription: executionDescription as Record<string, unknown> } : {}), updatedAt: at, transactionId });
      return this.store.transitionActionRecord({ id: actionId, expectedState: "staging", state: "committed", mutationTransactionId: transactionId,
        affectedResources: changed.map((file) => ({ kind: "model_file", id: file.id, sha256: file.sha256 })), at });
    } catch (error) {
      try { this.store.transitionActionRecord({ id: actionId, expectedState: "staging", state: "rolled_back", mutationTransactionId: transactionId, errorCode: "model_mutation_failed", at }); } catch { /* startup reconciliation owns ambiguous staging */ }
      throw error;
    }
  }

  #listExperimentConfigurations(grant: AgentToolGrant) {
    this.#requireProject(grant);
    return this.store.listExperimentConfigurations(grant.owner.id)
      .filter((record): record is ExperimentConfigurationRecordV4 =>
        record.contractVersion === 4 && record.lifecycleState === "active")
      .map((record) => ({
        id: record.id,
        name: record.name,
        configuration: record.configuration,
        configurationDigest: record.configurationDigest,
        recordDigest: experimentConfigurationRecordDigest(record),
        sampleCount: record.sampleCount,
      }));
  }

  #updateExperimentConfiguration(
    grant: AgentToolGrant,
    input: Readonly<Record<string, unknown>>,
  ) {
    this.#requireProject(grant);
    const actionId = stableId("action", `${grant.turnId}:experiment:${canonical(input)}`);
    const action = this.#recordProposed(
      actionId,
      grant,
      "experiment_configuration_update",
      input,
    );
    if (grant.intentAuthority !== "explicit") {
      return this.#deny(actionId, "explicit_imperative_required");
    }
    const configurationId = boundedId(input.configurationId);
    const expectedConfigurationDigest = boundedDigest(input.expectedConfigurationDigest);
    const expectedRecordDigest = boundedDigest(input.expectedRecordDigest);
    const requestKey = boundedText(input.requestKey, 256);
    const configuration = input.configuration;
    if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)) {
      return this.#deny(actionId, "invalid_experiment_configuration");
    }
    const transactionId =
      `mutation_agent_${createHash("sha256").update(actionId).digest("hex").slice(0, 32)}`;
    const updateIntent = {
      commandId: stableId("command", `${grant.turnId}:${requestKey}`),
      transactionId,
      id: configurationId,
      projectId: grant.owner.id,
      expectedConfigurationDigest,
      expectedRecordDigest,
      ...(input.name === undefined ? {} : { name: boundedText(input.name, 200) }),
      configuration: configuration as Record<string, unknown>,
    };
    const current = this.#listExperimentConfigurations(grant)
      .find((record) => record.id === configurationId);
    if (!current) return this.#deny(actionId, "experiment_configuration_missing");
    const project = this.store.getProject(grant.owner.id);
    const inputs = project.executionDescription.inputs;
    if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)
      || !Object.hasOwn(inputs, "schema")) {
      return this.#deny(actionId, "project_input_schema_missing");
    }
    const plan = planExperiment({
      configuration,
      inputSchema: (inputs as Record<string, unknown>).schema,
      maxSamples: 10_000,
    });
    const normalizedUpdateIntent = {
      ...updateIntent,
      configuration: plan.configuration,
    };
    const replayed = this.store.getExperimentUpdateReceipt(
      normalizedUpdateIntent,
    );
    if (replayed) {
      const affectedResources = [{
        kind: "experiment_configuration",
        id: replayed.id,
        sha256: replayed.configurationDigest,
      }];
      if (action.state === "staging") {
        this.store.transitionActionRecord({
          id: actionId,
          expectedState: "staging",
          state: "committed",
          mutationTransactionId: transactionId,
          affectedResources,
          at: this.#now(),
        });
      } else if (action.state !== "committed") {
        throw new AgentRuntimeError(
          "experiment_replay_state_invalid",
          "The durable Experiment receipt does not match the action state.",
        );
      }
      return experimentUpdateResult(replayed);
    }
    if (action.state !== "proposed") {
      throw new AgentRuntimeError(
        "experiment_replay_receipt_missing",
        "The prior Experiment action has no matching durable receipt.",
      );
    }
    const at = this.#now();
    this.store.transitionActionRecord({
      id: actionId,
      expectedState: "proposed",
      state: "authorized",
      at,
    });
    this.store.transitionActionRecord({
      id: actionId,
      expectedState: "authorized",
      state: "staging",
      mutationTransactionId: transactionId,
      at,
    });
    try {
      const updated = this.store.updateExperimentV4({
        ...normalizedUpdateIntent,
        plan,
        updatedAt: at,
      });
      this.store.transitionActionRecord({
        id: actionId,
        expectedState: "staging",
        state: "committed",
        mutationTransactionId: transactionId,
        affectedResources: [{
          kind: "experiment_configuration",
          id: updated.id,
          sha256: updated.configurationDigest,
        }],
        at,
      });
      return experimentUpdateResult(updated);
    } catch (error) {
      try {
        this.store.transitionActionRecord({
          id: actionId,
          expectedState: "staging",
          state: "rolled_back",
          mutationTransactionId: transactionId,
          errorCode: "experiment_configuration_update_failed",
          at,
        });
      } catch {
        // Startup reconciliation owns ambiguous staging.
      }
      throw error;
    }
  }

  #createTemporaryDocument(
    grant: AgentToolGrant,
    input: Readonly<Record<string, unknown>>,
    actionKind = "temporary_document_create",
    explicitOnly = false,
  ) {
    const actionId = stableId(
      "action",
      `${grant.turnId}:${actionKind}:${canonical(input)}`,
    );
    this.#recordProposed(actionId, grant, actionKind, input);
    if (explicitOnly && grant.intentAuthority !== "explicit") {
      return this.#deny(actionId, "explicit_imperative_required");
    }
    const name = boundedText(input.name, 200); const mediaType = boundedText(input.mediaType, 200); const content = boundedText(input.content, 1_000_000, true);
    const documentId = stableId("document", actionId);
    const at = this.#now();
    const transactionId = `mutation_agent_${createHash("sha256").update(actionId).digest("hex").slice(0, 32)}`;
    this.store.transitionActionRecord({ id: actionId, expectedState: "proposed", state: "authorized", at });
    this.store.transitionActionRecord({ id: actionId, expectedState: "authorized", state: "staging", mutationTransactionId: transactionId, at });
    try {
      this.store.createTemporaryDocument({ id: documentId, conversationId: grant.conversationId, name, documentState: "draft", mediaType, content, transactionId, createdAt: at });
      this.store.transitionActionRecord({ id: actionId, expectedState: "staging", state: "committed", mutationTransactionId: transactionId, affectedResources: [{ kind: "temporary_document", id: documentId }], at });
      return { id: documentId, state: "draft", committedOwnerState: false };
    } catch (error) {
      try { this.store.transitionActionRecord({ id: actionId, expectedState: "staging", state: "failed", errorCode: "document_create_failed", at }); } catch { /* preserve original */ }
      throw error;
    }
  }

  #transitionTemporaryDocument(grant: AgentToolGrant, input: Readonly<Record<string, unknown>>) {
    const documentId = String(input.documentId); const transition = String(input.transition);
    const document = this.store.listTemporaryDocuments(grant.conversationId).find((item) => item.id === documentId);
    if (!document) throw new AgentRuntimeError("document_scope_mismatch", "The document is outside this conversation.");
    if (transition === "adopt") throw new AgentRuntimeError("adoption_action_required", "Document adoption requires committed change action evidence.");
    const next = transition === "reject" ? "rejected" : transition === "supersede" ? "superseded" : null;
    if (!next) throw new AgentRuntimeError("invalid_document_transition", "The document transition is invalid.");
    this.store.transitionTemporaryDocument(documentId, next, [], this.#now());
    return { id: documentId, state: next };
  }

  #adoptAttachment(grant: AgentToolGrant, input: Readonly<Record<string, unknown>>) {
    const attachmentId = String(input.attachmentId);
    if (!grant.attachmentIds.has(attachmentId)) throw new AgentRuntimeError("attachment_scope_mismatch", "Only an attachment explicitly included in this turn can be adopted.");
    const attachment = this.store.getConversationAttachment(attachmentId);
    if (attachment.conversationId !== grant.conversationId) throw new AgentRuntimeError("attachment_scope_mismatch", "The attachment is outside this conversation.");
    const purpose = boundedText(input.purpose, 2_000); const logicalName = safeLogicalName(boundedText(input.logicalName, 240));
    const actionId = stableId("action", `${grant.turnId}:adopt:${canonical(input)}`); this.#recordProposed(actionId, grant, "attachment_adopt", input);
    const at = this.#now(); const transactionId = `mutation_agent_${createHash("sha256").update(actionId).digest("hex").slice(0, 32)}`;
    this.store.transitionActionRecord({ id: actionId, expectedState: "proposed", state: "authorized", at });
    this.store.transitionActionRecord({ id: actionId, expectedState: "authorized", state: "staging", mutationTransactionId: transactionId, at });
    try {
      const adopted = this.store.adoptAttachment({ objectFileId: stableId("file", actionId), owner: grant.owner, sourceAttachmentId: attachmentId, relativePath: logicalName, purpose, transactionId, createdAt: at });
      this.store.transitionActionRecord({ id: actionId, expectedState: "staging", state: "committed", mutationTransactionId: transactionId, affectedResources: [{ kind: "adopted_attachment", id: adopted.id, sha256: adopted.sha256 }], at });
      return { id: adopted.id, sha256: adopted.sha256, purpose };
    } catch (error) {
      try { this.store.transitionActionRecord({ id: actionId, expectedState: "staging", state: "failed", errorCode: "attachment_adoption_failed", at }); } catch { /* preserve original */ }
      throw error;
    }
  }

  #recordProposed(id: string, grant: AgentToolGrant, kind: string, intent: Readonly<Record<string, unknown>>) {
    return this.store.recordAction({ id, conversationId: grant.conversationId, turnId: grant.turnId, actionKind: kind, intent: intent as Record<string, unknown>, permissionDecision: "pending", state: "proposed", createdAt: this.#now() });
  }
  #deny(id: string, code: string) { return this.store.transitionActionRecord({ id, expectedState: "proposed", state: "denied", errorCode: code, at: this.#now() }); }
  #requireModel(grant: AgentToolGrant): void { if (grant.owner.kind !== "model") throw new AgentRuntimeError("project_model_mutation_forbidden", "Project conversations cannot read or change Model workspace files."); }
  #requireProject(grant: AgentToolGrant): void { if (grant.owner.kind !== "project") throw new AgentRuntimeError("model_project_mutation_forbidden", "Model conversations cannot change Project Experiment configurations."); }
}

export class AgentRuntimeError extends Error { readonly code: string; constructor(code: string, message: string) { super(message); this.name = "AgentRuntimeError"; this.code = code; } }

export const explicitImperative = (text: string): boolean => {
  const normalized = text.trim().toLowerCase();
  if (!normalized || /\?|\b(?:if|maybe|might|could|would|should we|discuss|explain|suggest|consider|how|what|why)\b|(?:如果|也许|可能|是否|能否|可以吗|讨论|解释|建议|如何|为什么)/u.test(normalized)) return false;
  return /^(?:please\s+)?(?:set|change|update|replace|add|create|write|modify|apply|adopt|reject|supersede|remove|delete)\b|^(?:请)?(?:设置|修改|更新|替换|新增|创建|建立|写入|应用|采用|拒绝|取代|删除)|^(?:请)?(?:把|将(?!来))[^?？\n]{1,500}(?:设置|修改|更新|替换|新增|创建|建立|写入|应用|采用|拒绝|取代|删除)/u.test(normalized);
};

const PROJECT_OPERATION_BOUNDARY =
  "(?:^|[.!?;]\\s*|\\b(?:and|then)\\s+|[。！？；]\\s*|(?:并且|然后)\\s*)";

const explicitExperimentUpdateIntent = (text: string): boolean =>
  explicitImperative(text)
  && new RegExp(
    `${PROJECT_OPERATION_BOUNDARY}(?:please\\s+)?`
      + "(?:set|change|update|replace|modify|edit|apply)\\s+"
      + "(?:the\\s+)?(?:active\\s+)?"
      + "(?:experiment(?:\\s+configuration)?|configuration)"
      + "|"
      + `${PROJECT_OPERATION_BOUNDARY}(?:请)?`
      + "(?:设置|修改|更新|替换|应用)"
      + "(?:当前)?(?:实验配置|实验|配置)",
    "iu",
  ).test(text);

const explicitAnalysisDocumentIntent = (text: string): boolean =>
  explicitImperative(text)
  && new RegExp(
    `${PROJECT_OPERATION_BOUNDARY}(?:please\\s+)?`
      + "(?:add|create|write|generate)\\s+"
      + "(?:an?\\s+|the\\s+)?(?:analysis|analytical)"
      + "(?:\\s+report)?\\s+(?:document|file)"
      + "|"
      + `${PROJECT_OPERATION_BOUNDARY}(?:请)?`
      + "(?:新增|创建|写入|生成)(?:一份)?(?:分析文档|分析报告)",
    "iu",
  ).test(text);

const experimentUpdateResult = (updated: ExperimentConfigurationRecordV4) => ({
  id: updated.id,
  name: updated.name,
  configuration: updated.configuration,
  configurationDigest: updated.configurationDigest,
  recordDigest: experimentConfigurationRecordDigest(updated),
  sampleCount: updated.sampleCount,
});

const parseModelFileMutation = (value: unknown): ModelFileMutation => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some((key) => !["objectFileId", "kind", "relativePath", "mediaType", "text", "expectedPriorSha256"].includes(key))) throw new Error("invalid");
  const objectFileId = boundedId(row.objectFileId); const relativePath = safeLogicalName(boundedText(row.relativePath, 400)); const mediaType = boundedText(row.mediaType, 200);
  const kind = row.kind; if (!new Set(["model_code", "model_environment", "model_visual_asset"]).has(String(kind))) throw new Error("invalid");
  const text = boundedText(row.text, 1_000_000, true); const expected = row.expectedPriorSha256;
  if (expected !== null && (typeof expected !== "string" || !/^[0-9a-f]{64}$/u.test(expected))) throw new Error("invalid");
  return { objectFileId, kind: kind as ModelFileMutation["kind"], relativePath, mediaType, bytes: Buffer.from(text), expectedPriorSha256: expected as string | null };
};
const boundedId = (value: unknown): string => { if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/u.test(value)) throw new Error("invalid"); return value; };
const boundedDigest = (value: unknown): string => {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new AgentRuntimeError("invalid_tool_input", "Agent tool digest is invalid.");
  }
  return value;
};
const boundedText = (value: unknown, max: number, empty = false): string => { if (typeof value !== "string" || (!empty && !value.trim()) || Buffer.byteLength(value) > max || value.includes("\0")) throw new AgentRuntimeError("invalid_tool_input", "Agent tool text is invalid."); return empty ? value : value.trim(); };
const safeLogicalName = (value: string): string => { if (value.startsWith("/") || value.includes("\\") || value.split("/").some((part) => !part || part === "." || part === "..")) throw new AgentRuntimeError("invalid_logical_path", "Agent logical path is invalid."); return value; };
const stripOwnedPrefix = (kind: string, value: string): string => {
  const prefix = kind === "model_code" ? "code/" : kind === "model_environment" ? "environment/" : "visuals/";
  if (!value.startsWith(prefix)) throw new AgentRuntimeError("invalid_owned_path", "Stored Model path has an invalid kind prefix.");
  return value.slice(prefix.length);
};
const stableId = (prefix: string, input: string): string => `${prefix}_${createHash("sha256").update(input).digest("hex").slice(0, 32)}`;
const canonical = (value: unknown): string => canonicalJsonV2(value);
