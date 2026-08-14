import { createHash } from "node:crypto";
import { ApiError } from "./errors.ts";
import { canonicalDigest, canonicalJsonV2 } from "./canonical-json-v2.ts";
import { AgentMcpServer } from "./agent-mcp.ts";
import { CONSEQUENTIAL_AGENT_TOOLS, toolsForOwner, type AgentToolExecutor, type AgentToolGrant, type AgentToolName } from "./agent-tools.ts";
import type { AgentContextInput } from "./agent-context.ts";
import type {
  ActionRecordDto,
  ConversationOwner,
  ModelFileMutation,
} from "./agent-domain.ts";
import {
  experimentConfigurationRecordDigest,
  ProductStoreV2,
  type ExperimentConfigurationRecordV4,
  type TechnicalCheckRecord,
} from "./product-store-v2.ts";
import { planExperiment } from "./experiment-planner.ts";
import { SimulationSkillCatalog, type LoadedSimulationSkill } from "./simulation-skill-catalog.ts";
import { VisualAgentAuthority } from "./agent-visual-authority.ts";
import { rendererDto } from "./renderer-registry.ts";
import { validateExecutionDescriptionV2 } from "./execution-protocol-v2.ts";
import { BrowserAgentAuthority } from "./browser-agent-authority.ts";
import {
  BROWSER_AGENT_TOOLS,
  isBrowserAgentToolName,
} from "./browser-agent-tools.ts";
import type {
  OpenCodeConversationRuntimeSnapshot,
  OpenCodeWorkspaceBinding,
} from "./opencode-adapter.ts";

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
  release(): Promise<void>;
}>;

type ProjectAgentOperations = Readonly<{
  startTechnicalCheck(input: Readonly<{ modelId: string; commandId: string }>): Promise<unknown>;
  startProjectTechnicalCheck?: (input: Readonly<{
    projectId: string;
    commandId: string;
    expectedWorkspaceDigest: string;
  }>) => Promise<ProjectOperationEnvelope>;
  deliverProjectChanges?: (input: Readonly<{
    projectId: string;
    conversationId: string;
    turnId: string;
    commandId: string;
    expectedWorkspaceDigest: string;
    changes: readonly Readonly<Record<string, unknown>>[];
    executionDescription?: Readonly<Record<string, unknown>>;
    run?: Readonly<{ configurationId: string }>;
  }>) => Promise<ProjectOperationEnvelope>;
  createExperiment(input: Readonly<{ projectId: string; commandId: string; name: string; configuration: Record<string, unknown> }>): unknown;
  startRun(input: Readonly<{ projectId: string; commandId: string; experimentConfigId: string; completionConversationId?: string }>): unknown;
  cancelRun(input: Readonly<{ projectId: string; runId: string; commandId: string }>): unknown;
  trashRun(input: any): unknown;
  restoreRun(input: any): unknown;
  transitionOwner(input: any): unknown;
}>;

type ProjectOperationEnvelope = Readonly<{
  receiptDigest: string;
  affectedResources: readonly Readonly<Record<string, unknown>>[];
  result: Readonly<Record<string, unknown>>;
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
  #browserAuthority?: BrowserAgentAuthority;
  #projectOperations?: ProjectAgentOperations;

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

  configureBrowserAuthority(authority: BrowserAgentAuthority): void {
    if (this.#browserAuthority && this.#browserAuthority !== authority) {
      throw new Error("Browser Agent authority is already configured.");
    }
    this.#browserAuthority = authority;
  }

  configureProjectOperations(operations: ProjectAgentOperations): void {
    if (this.#projectOperations && this.#projectOperations !== operations) {
      throw new Error("Project Agent operations are already configured.");
    }
    this.#projectOperations = operations;
  }

  async prepare(input: { conversationId: string; turnId: string; text: string; attachmentIds: string[]; workspace?: OpenCodeWorkspaceBinding; confirmedVisualInteraction?: import("./agent-visual-authority.ts").VisualAgentOperation }): Promise<PreparedAgentTurnRuntime> {
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
    const imperativeText = imperativeClauses(intentText).join(". ");
    const intentAuthority = imperativeText ? "explicit" : "proposal_only";
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
    const browserRequested = explicitBrowserIntent(intentText)
      && !currentVisualizationOpenIntent(intentText);
    if (!browserRequested || !input.workspace || !this.#browserAuthority) {
      for (const tool of BROWSER_AGENT_TOOLS) allowedTools.delete(tool);
    }
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
    const operationSelection = consequentialOperationSelection(
      conversation.owner, imperativeText || intentText, intentAuthority,
    );
    for (const tool of CONSEQUENTIAL_AGENT_TOOLS) allowedTools.delete(tool);
    if (operationSelection) allowedTools.add(operationSelection.tool);
    if (!this.#authorityIssuanceAllowed(authorityScope)) {
      throw new ApiError(
        409,
        "resource_deletion_in_progress",
        "The resource is being permanently deleted.",
      );
    }
    if (browserRequested && input.workspace && this.#browserAuthority) {
      await this.#browserAuthority.prepareDormant({
        scope: {
          conversationId: input.conversationId,
          conversationGeneration: Math.max(1, generation),
        },
        turnId: input.turnId,
        workspace: input.workspace,
        operations: new Set(BROWSER_AGENT_TOOLS.filter((tool) => allowedTools.has(tool))),
      });
    }
    let capability: string;
    try {
      capability = this.mcp.grant({
        conversationId: input.conversationId,
        owner: conversation.owner,
        turnId: input.turnId,
        externalSessionGeneration: Math.max(1, generation),
        allowedTools,
        operationCommitment: null,
        intentAuthority,
        attachmentIds: new Set(input.attachmentIds),
        ...(allowedTools.has("riff_interact_current_visual") ? { confirmedVisualInteraction: input.confirmedVisualInteraction } : {}),
      });
    } catch (error) {
      await this.#browserAuthority?.revokeTurn(input.conversationId, input.turnId);
      throw error;
    }
    const exactAllowedTools = Object.freeze(
      [...allowedTools].sort((left, right) => left.localeCompare(right, "en")),
    );
    return Object.freeze({
      capability,
      turnId: input.turnId,
      externalSessionGeneration: Math.max(1, generation),
      intentAuthority,
      requiresMcp: browserRequested || intentAuthority === "explicit" || Boolean(input.confirmedVisualInteraction)
        || input.attachmentIds.length > 0 || Boolean(loadedSkill)
        || /\b(?:model|project|workspace|file|document|attachment|schema|dependency|experiment|run|output|event|technical check|visual|observe|screenshot)\b|(?:模型|项目|工作区|文件|文档|附件|模式|依赖|实验|运行|输出|事件|技术检查|可视化|观察|截图)/iu.test(intentText),
      allowedTools: exactAllowedTools,
      context: {
        attachments: attachments.map(({ metadata, preview }) => ({ id: metadata.id, conversationId: input.conversationId, mediaType: metadata.mediaType, preview, relevant: true })),
        documents: this.store.listTemporaryDocuments(input.conversationId).filter((document) => document.lifecycleState === "active")
          .map((document) => ({ id: document.id, conversationId: input.conversationId, mediaType: document.mediaType, text: document.content, relevant: true })),
        selectedSkills: loadedSkill ? [{ id: loadedSkill.id, version: loadedSkill.version, instructions: loadedSkill.instructions }] : [],
      },
      promptAttachments: attachments.map(({ metadata }) => ({ id: metadata.id, mediaType: metadata.mediaType, workspaceRelativePath: metadata.relativePath })),
      release: async () => {
        this.mcp.revoke(capability);
        this.visualAuthority?.revokeTurn(input.conversationId, input.turnId);
        await this.#browserAuthority?.revokeTurn(input.conversationId, input.turnId);
      },
    });
  }

  async revokeAll(): Promise<void> {
    this.mcp.revokeAll();
    this.visualAuthority?.revokeAll();
    await this.#browserAuthority?.revokeAll();
  }

  async revokeBrowserTurn(conversationId: string, turnId: string): Promise<void> {
    await this.#browserAuthority?.revokeTurn(conversationId, turnId);
  }

  async revokeConversation(conversationId: string): Promise<void> {
    this.mcp.revokeConversation(conversationId);
    this.visualAuthority?.revokeConversation(conversationId);
    await this.#browserAuthority?.revokeConversation(conversationId);
  }

  async browserPendingInteractions(
    conversationId: string,
    turnId: string,
  ): Promise<OpenCodeConversationRuntimeSnapshot["interactions"]> {
    const pending = await this.#browserAuthority?.pendingForTurn(conversationId, turnId) ?? [];
    return Object.freeze(pending.map((item) => Object.freeze({
      id: item.id,
      kind: "permission" as const,
      title: "Permission required",
      permission: `Allow ${item.tool} once for ${item.targetSummary}? Budget ${item.remainingBudget}; `
        + `expires at ${new Date(item.expiresAtMs).toISOString()}.`,
    })));
  }

  async respondBrowserPermission(input: Readonly<{
    id: string;
    conversationId: string;
    turnId: string;
    externalSessionGeneration: number;
    workspace: OpenCodeWorkspaceBinding;
    decision: "once" | "reject";
  }>): Promise<boolean> {
    if (!this.#browserAuthority) return false;
    const pending = await this.#browserAuthority.pendingForTurn(
      input.conversationId,
      input.turnId,
    );
    if (!pending.some((item) => item.id === input.id)) return false;
    if (input.decision === "once") {
      await this.#browserAuthority.approvePending(input);
    } else {
      await this.#browserAuthority.rejectPending(input);
    }
    return true;
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

  authorizeConsequentialOperation(
    capability: string,
    authority: Readonly<{
      toolName: AgentToolName;
      operationCommitment: string;
    }>,
  ): void {
    this.mcp.authorizeConsequentialOperation(capability, authority);
  }

  revokeCapability(capability: string): void { this.mcp.revoke(capability); }

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
      "riff_start_model_technical_check",
      "riff_start_project_technical_check",
      "riff_deliver_project_changes",
      "riff_create_experiment_configuration",
      "riff_update_experiment_configuration",
      "riff_start_run",
      "riff_cancel_run",
      "riff_trash_run",
      "riff_restore_run",
      "riff_transition_owner_lifecycle",
      "riff_create_analysis_document",
      "riff_transition_temporary_document",
      "riff_adopt_attachment",
    ]).has(tool)) throw new AgentRuntimeError("explicit_intent_required", "This durable action requires an explicit imperative.");
    if (isBrowserAgentToolName(tool)) {
      if (!this.#browserAuthority) throw new AgentRuntimeError(
        "browser_authority_unavailable",
        "Browser authority is unavailable.",
      );
      return await this.#browserAuthority.execute({
        conversationId: grant.conversationId,
        turnId: grant.turnId,
        externalSessionGeneration: grant.externalSessionGeneration,
        tool,
        arguments: input,
      });
    }
    switch (tool) {
      case "riff_read_owner_summary": return this.#ownerSummary(grant.owner);
      case "riff_list_model_workspace": return this.#listModelWorkspace(grant);
      case "riff_read_model_file": return this.#readModelFile(grant, String(input.fileId));
      case "riff_start_model_technical_check": return this.#startModelTechnicalCheck(grant, input);
      case "riff_apply_model_changes": return this.#applyModelChanges(grant, input);
      case "riff_propose_model_changes": return this.#proposeModelChanges(grant, input);
      case "riff_publish_model_generated_views":
        return this.#publishModelGeneratedViews(grant, input);
      case "riff_list_experiment_configurations":
        return this.#listExperimentConfigurations(grant);
      case "riff_list_project_workspace": return this.#listProjectWorkspace(grant);
      case "riff_read_project_file": return this.#readProjectFile(grant, String(input.fileRef));
      case "riff_start_project_technical_check":
        return this.#startProjectTechnicalCheck(grant, input);
      case "riff_deliver_project_changes":
        return this.#deliverProjectChanges(grant, input);
      case "riff_create_experiment_configuration": return this.#createExperimentConfiguration(grant, input);
      case "riff_update_experiment_configuration":
        return this.#updateExperimentConfiguration(grant, input);
      case "riff_list_runs": return this.#listRuns(grant);
      case "riff_start_run": return this.#startRun(grant, input);
      case "riff_cancel_run": return this.#cancelRun(grant, input);
      case "riff_trash_run": return this.#trashRun(grant, input);
      case "riff_restore_run": return this.#restoreRun(grant, input);
      case "riff_list_run_outputs": return this.#listRunOutputs(grant, input);
      case "riff_read_run_output": return this.#readRunOutput(grant, input);
      case "riff_read_run_events": return this.#readRunEvents(grant, input);
      case "riff_transition_owner_lifecycle": return this.#transitionOwnerLifecycle(grant, input);
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
      case "riff_open_current_visualization":
        return this.#openCurrentVisualization(grant);
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
    return { owner: { ...owner }, name: record.name, lifecycleState: record.lifecycleState,
      recordDigest: this.store.resourceRecordDigest(owner.kind, owner.id),
      ...(owner.kind === "model" ? { technicalStatus: (record as any).technicalStatus, runMode: (record as any).runMode } : { fixedModelSnapshot: true }) };
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

  #listProjectWorkspace(grant: AgentToolGrant) {
    this.#requireProject(grant);
    return this.store.listObjectFiles(grant.owner)
      .filter((file) => file.kind === "project_model_snapshot")
      .map((file) => ({
        fileRef: scopedRef("project_file", grant.owner.id, file.id, file.sha256),
        relativePath: file.relativePath.replace(/^model-snapshot\//u, ""),
        mediaType: file.mediaType,
        sizeBytes: file.sizeBytes,
        sha256: file.sha256,
      }));
  }

  #readProjectFile(grant: AgentToolGrant, fileRef: string) {
    const publicFiles = this.#listProjectWorkspace(grant);
    const selected = publicFiles.find((file) => file.fileRef === fileRef);
    if (!selected) throw new AgentRuntimeError(
      "file_scope_mismatch", "The requested file is outside the Project fixed copy.",
    );
    if (selected.sizeBytes > 256_000 || !isTextualMediaType(selected.mediaType)) {
      throw new AgentRuntimeError("file_not_renderable", "The requested Project file is not a bounded textual artifact.");
    }
    const stored = this.store.listObjectFiles(grant.owner).find((file) =>
      file.kind === "project_model_snapshot"
      && scopedRef("project_file", grant.owner.id, file.id, file.sha256) === fileRef);
    if (!stored) throw new AgentRuntimeError("file_scope_mismatch", "The Project file reference is stale.");
    return { ...selected, content: this.store.readObjectFile(stored.id).toString("utf8") };
  }

  async #startProjectTechnicalCheck(
    grant: AgentToolGrant,
    input: Readonly<Record<string, unknown>>,
  ) {
    this.#requireProject(grant);
    if (!this.#projectOperations?.startProjectTechnicalCheck) {
      throw new AgentRuntimeError(
        "project_operations_unavailable",
        "Project technical-check operations are unavailable.",
      );
    }
    const requestKey = boundedText(input.requestKey, 256);
    const expectedWorkspaceDigest = boundedDigest(input.expectedWorkspaceDigest);
    return await this.#commitExternalProjectOperation(
      grant,
      "project_technical_check_start",
      requestKey,
      input,
      () => this.#projectOperations!.startProjectTechnicalCheck!({
        projectId: grant.owner.id,
        commandId: stableId(
          "command", `${grant.turnId}:project-technical-check:${requestKey}`,
        ),
        expectedWorkspaceDigest,
      }),
    );
  }

  async #deliverProjectChanges(
    grant: AgentToolGrant,
    input: Readonly<Record<string, unknown>>,
  ) {
    this.#requireProject(grant);
    if (!this.#projectOperations?.deliverProjectChanges) {
      throw new AgentRuntimeError(
        "project_operations_unavailable",
        "Project delivery operations are unavailable.",
      );
    }
    const parsed = parseProjectDeliveryInput(input);
    return await this.#commitExternalProjectOperation(
      grant,
      "project_delivery",
      parsed.requestKey,
      input,
      () => this.#projectOperations!.deliverProjectChanges!({
        projectId: grant.owner.id,
        conversationId: grant.conversationId,
        turnId: grant.turnId,
        commandId: stableId(
          "command", `${grant.turnId}:project-delivery:${parsed.requestKey}`,
        ),
        expectedWorkspaceDigest: parsed.expectedWorkspaceDigest,
        changes: parsed.changes,
        ...(parsed.executionDescription
          ? { executionDescription: parsed.executionDescription }
          : {}),
        ...(parsed.run ? { run: parsed.run } : {}),
      }),
    );
  }

  #openCurrentVisualization(grant: AgentToolGrant) {
    this.#requireProject(grant);
    try {
      const target = this.store.currentHealthyVisualAgentTarget(grant.owner.id, {
        now: this.#now(),
      });
      const run = this.store.listRuns(grant.owner.id, { includeTrashed: false })
        .find((candidate) => candidate.id === target.runId);
      if (!run || run.contractVersion !== 4 || run.runKind !== "visual") {
        throw new Error("visual run missing");
      }
      const sourceDigest = (run as unknown as {
        sourceDigest?: unknown;
        projectSnapshotDigest?: unknown;
      }).sourceDigest
        ?? (run as unknown as { projectSnapshotDigest?: unknown }).projectSnapshotDigest;
      if (typeof sourceDigest !== "string" || !/^[0-9a-f]{64}$/u.test(sourceDigest)) {
        throw new Error("visual source digest missing");
      }
      return Object.freeze({
        schemaVersion: 1,
        state: "healthy",
        serviceRef: scopedRef(
          "visual_service", grant.owner.id, target.runId, sourceDigest,
        ),
        runRef: scopedRef("run", grant.owner.id, run.id, canonical(run)),
        sourceDigest,
        frameAvailable: true,
      });
    } catch (error) {
      throw new AgentRuntimeError(
        "no_active_visual_service",
        "The current Project has no sole healthy visual service.",
      );
    }
  }

  async #startModelTechnicalCheck(
    grant: AgentToolGrant,
    input: Readonly<Record<string, unknown>>,
  ) {
    this.#requireModel(grant);
    if (!this.#projectOperations) throw new AgentRuntimeError(
      "model_operations_unavailable", "Model technical-check operations are unavailable.",
    );
    const requestKey = boundedText(input.requestKey, 256);
    const actionId = stableId("action", `${grant.turnId}:technical-check:${requestKey}`);
    let action = this.#recordProposed(actionId, grant, "model_technical_check_start", input);
    const at = this.#now();
    const transactionId = `mutation_agent_${createHash("sha256").update(actionId).digest("hex").slice(0, 32)}`;
    if (action.state === "proposed") action = this.store.transitionActionRecord({
      id: actionId, expectedState: "proposed", state: "authorized", at,
    });
    if (action.state === "authorized") action = this.store.transitionActionRecord({
      id: actionId, expectedState: "authorized", state: "staging",
      mutationTransactionId: transactionId, at,
    });
    try {
      const receipt = await this.#projectOperations.startTechnicalCheck({
        modelId: grant.owner.id,
        commandId: stableId("command", `${grant.turnId}:technical-check:${requestKey}`),
      });
      const evidence = this.#verifiedOperationEvidence(
        grant, "model_technical_check_start", requestKey, receipt,
      );
      if (action.state === "staging") action = this.store.commitReceiptBackedAgentAction({
        actionId, mutationTransactionId: transactionId,
        receiptDigest: evidence.receiptDigest,
        affectedResources: evidence.affectedResources,
        committedAt: at,
      });
      return safeActionResult(action, {
        receipt,
        receiptDigest: evidence.receiptDigest,
      });
    } catch (error) {
      // The domain service may have committed before its projection/return
      // failed.  Keep staging so deterministic receipt recovery decides.
      throw error;
    }
  }

  #createExperimentConfiguration(
    grant: AgentToolGrant,
    input: Readonly<Record<string, unknown>>,
  ) {
    this.#requireProject(grant);
    if (!this.#projectOperations) throw new AgentRuntimeError(
      "project_operations_unavailable", "Project write operations are unavailable.",
    );
    const requestKey = boundedText(input.requestKey, 256);
    const name = boundedText(input.name, 200);
    if (!input.configuration || typeof input.configuration !== "object"
      || Array.isArray(input.configuration)) {
      throw new AgentRuntimeError("invalid_experiment_configuration", "The Experiment configuration is invalid.");
    }
    return this.#commitProjectOperation(
      grant,
      "experiment_configuration_create",
      requestKey,
      input,
      () => this.#projectOperations!.createExperiment({
        projectId: grant.owner.id,
        commandId: stableId("command", `${grant.turnId}:create-experiment:${requestKey}`),
        name,
        configuration: input.configuration as Record<string, unknown>,
      }),
    );
  }

  #listRuns(grant: AgentToolGrant) {
    this.#requireProject(grant);
    return this.store.listRuns(grant.owner.id, { includeTrashed: true }).map((run) => {
      const lifecycle = run.contractVersion === 4
        ? this.store.currentRunLifecycleBinding(grant.owner.id, run.id) : null;
      return ({
      runRef: scopedRef("run", grant.owner.id, run.id, canonical(run)),
      status: run.status,
      lifecycleDigest: lifecycle?.lifecycleDigest ?? null,
      terminalStatus: lifecycle?.terminalStatus ?? null,
      terminalClosureDigest: lifecycle?.terminalClosureDigest ?? null,
      runKind: run.contractVersion === 4 ? run.runKind : null,
      experimentConfigurationId: run.experimentConfigurationId,
      createdAt: run.createdAt,
      completedAt: run.finishedAt,
    }); });
  }

  #resolveRunRef(grant: AgentToolGrant, runRef: string) {
    const run = this.store.listRuns(grant.owner.id, { includeTrashed: true })
      .find((candidate) => scopedRef(
        "run", grant.owner.id, candidate.id, canonical(candidate),
      ) === runRef);
    if (!run) throw new AgentRuntimeError("stale_run_ref", "The Run reference is stale or outside this Project.");
    return run;
  }

  #startRun(grant: AgentToolGrant, input: Readonly<Record<string, unknown>>) {
    this.#requireProject(grant);
    if (!this.#projectOperations) throw new AgentRuntimeError(
      "project_operations_unavailable", "Project write operations are unavailable.",
    );
    const requestKey = boundedText(input.requestKey, 256);
    const configurationId = boundedId(input.configurationId);
    return this.#commitProjectOperation(
      grant,
      "run_start",
      requestKey,
      input,
      () => this.#projectOperations!.startRun({
        projectId: grant.owner.id,
        commandId: stableId("command", `${grant.turnId}:start-run:${requestKey}`),
        experimentConfigId: configurationId,
        completionConversationId: grant.conversationId,
      }),
    );
  }

  #cancelRun(grant: AgentToolGrant, input: Readonly<Record<string, unknown>>) {
    this.#requireProject(grant);
    if (!this.#projectOperations) throw new AgentRuntimeError(
      "project_operations_unavailable", "Project write operations are unavailable.",
    );
    const requestKey = boundedText(input.requestKey, 256);
    const run = this.#resolveRunRef(grant, boundedText(input.runRef, 256));
    return this.#commitProjectOperation(
      grant,
      "run_cancel",
      requestKey,
      input,
      () => this.#projectOperations!.cancelRun({
        projectId: grant.owner.id,
        runId: run.id,
        commandId: stableId("command", `${grant.turnId}:cancel-run:${requestKey}`),
      }),
    );
  }

  #trashRun(grant: AgentToolGrant, input: Readonly<Record<string, unknown>>) {
    this.#requireProject(grant);
    if (!this.#projectOperations) throw new AgentRuntimeError(
      "project_operations_unavailable", "Project write operations are unavailable.",
    );
    const requestKey = boundedText(input.requestKey, 256);
    const run = this.#resolveRunRef(grant, boundedText(input.runRef, 256));
    const current = this.store.currentRunLifecycleBinding(grant.owner.id, run.id);
    const expectedLifecycleDigest = boundedDigest(input.expectedLifecycleDigest);
    const terminalClosureDigest = boundedDigest(input.terminalClosureDigest);
    const terminalStatus = String(input.terminalStatus) as "succeeded" | "failed" | "cancelled" | "timed_out";
    if (current.lifecycleDigest !== expectedLifecycleDigest
      || current.terminalStatus !== terminalStatus
      || current.terminalClosureDigest !== terminalClosureDigest) {
      throw new AgentRuntimeError("stale_run_lifecycle", "The Run lifecycle or terminal closure changed.");
    }
    return this.#commitProjectOperation(
      grant, "run_trash", requestKey, input,
      () => this.#projectOperations!.trashRun({
        projectId: grant.owner.id,
        runId: run.id,
        commandId: stableId("command", `${grant.turnId}:trash-run:${requestKey}`),
        expectedLifecycleDigest,
        confirmation: {
          action: "trash_run",
          projectId: grant.owner.id,
          runId: run.id,
          terminalStatus,
          terminalClosureDigest,
        },
      }),
    );
  }

  #restoreRun(grant: AgentToolGrant, input: Readonly<Record<string, unknown>>) {
    this.#requireProject(grant);
    if (!this.#projectOperations) throw new AgentRuntimeError(
      "project_operations_unavailable", "Project write operations are unavailable.",
    );
    const requestKey = boundedText(input.requestKey, 256);
    const run = this.#resolveRunRef(grant, boundedText(input.runRef, 256));
    const expectedLifecycleDigest = boundedDigest(input.expectedLifecycleDigest);
    if (this.store.currentRunLifecycleBinding(grant.owner.id, run.id).lifecycleDigest
      !== expectedLifecycleDigest) {
      throw new AgentRuntimeError("stale_run_lifecycle", "The Run lifecycle changed.");
    }
    return this.#commitProjectOperation(
      grant, "run_restore", requestKey, input,
      () => this.#projectOperations!.restoreRun({
        projectId: grant.owner.id,
        runId: run.id,
        commandId: stableId("command", `${grant.turnId}:restore-run:${requestKey}`),
        expectedLifecycleDigest,
      }),
    );
  }

  #transitionOwnerLifecycle(
    grant: AgentToolGrant,
    input: Readonly<Record<string, unknown>>,
  ) {
    if (!this.#projectOperations) throw new AgentRuntimeError(
      "owner_operations_unavailable", "Owner lifecycle operations are unavailable.",
    );
    const requestKey = boundedText(input.requestKey, 256);
    const action = String(input.action) as "rename" | "archive" | "trash" | "restore";
    const expectedRecordDigest = boundedDigest(input.expectedRecordDigest);
    if (this.store.resourceRecordDigest(grant.owner.kind, grant.owner.id)
      !== expectedRecordDigest) {
      throw new AgentRuntimeError("stale_owner_record", "The owner record changed.");
    }
    return this.#commitProjectOperation(
      grant, `owner_${action}`, requestKey, input,
      () => this.#projectOperations!.transitionOwner({
        commandId: stableId("command", `${grant.turnId}:owner-${action}:${requestKey}`),
        action,
        kind: grant.owner.kind,
        id: grant.owner.id,
        expectedRecordDigest,
        ...(action === "rename" ? { name: boundedText(input.name, 200) } : {}),
      }),
    );
  }

  #listRunOutputs(grant: AgentToolGrant, input: Readonly<Record<string, unknown>>) {
    this.#requireProject(grant);
    const runRef = boundedText(input.runRef, 256);
    const run = this.#resolveRunRef(grant, runRef);
    if (run.status !== "succeeded") throw new AgentRuntimeError(
      "output_not_available", "Run outputs are available only after a successful receipt-backed Run.",
    );
    const limit = input.limit === undefined ? 50 : Number(input.limit);
    const afterOutputRef = input.afterOutputRef === undefined
      ? null : boundedText(input.afterOutputRef, 256);
    const logicalName = input.logicalName === undefined
      ? null : boundedText(input.logicalName, 256);
    const declaredRole = input.declaredRole === undefined
      ? null : boundedText(input.declaredRole, 64);
    const all = this.store.listRunOutputs(run.id).map((output) => ({
      outputRef: scopedRef("output", run.id, output.id, output.file.sha256),
      logicalName: output.logicalName,
      sampleIndex: output.contractVersion === 4 ? output.sampleIndex : null,
      mediaType: output.file.mediaType,
      declaredRole: output.contractVersion === 4 ? output.declaredRole : output.outputType,
      sizeBytes: output.file.sizeBytes,
      sha256: output.file.sha256,
    })).filter((output) => (!logicalName || output.logicalName === logicalName)
      && (!declaredRole || output.declaredRole === declaredRole));
    const pagedRequest = [
      "afterOutputRef", "limit", "logicalName", "declaredRole", "includeText",
    ].some((key) => input[key] !== undefined);
    if (!pagedRequest) return all;
    const afterIndex = afterOutputRef
      ? all.findIndex((output) => output.outputRef === afterOutputRef) : -1;
    if (afterOutputRef && afterIndex < 0) throw new AgentRuntimeError(
      "invalid_output_cursor", "The Run output cursor is not in this filtered result set.",
    );
    const outputs = all.slice(afterIndex + 1, afterIndex + 1 + limit).map((output) => {
      if (input.includeText !== true || !isTextualMediaType(output.mediaType)) return output;
      const stored = this.store.listRunOutputs(run.id).find((candidate) =>
        scopedRef("output", run.id, candidate.id, candidate.file.sha256) === output.outputRef);
      if (!stored) throw new AgentRuntimeError(
        "stale_output_ref", "The Run output reference is stale.",
      );
      const bytes = this.store.readObjectFile(stored.file.id);
      const page = boundedUtf8Page(bytes, 0, 32 * 1024);
      return { ...output, text: page.text, textTruncated: page.truncated };
    });
    const hasMore = afterIndex + 1 + outputs.length < all.length;
    return {
      runRef,
      outputs,
      matchedOutputCount: all.length,
      nextOutputRef: hasMore ? outputs.at(-1)?.outputRef ?? null : null,
      hasMore,
    };
  }

  #readRunOutput(grant: AgentToolGrant, input: Readonly<Record<string, unknown>>) {
    const runRef = boundedText(input.runRef, 256);
    const outputRef = boundedText(input.outputRef, 256);
    const run = this.#resolveRunRef(grant, boundedText(runRef, 256));
    if (run.status !== "succeeded") throw new AgentRuntimeError(
      "output_not_available", "Run outputs are available only after a successful receipt-backed Run.",
    );
    const stored = this.store.listRunOutputs(run.id).find((output) =>
      scopedRef("output", run.id, output.id, output.file.sha256) === outputRef);
    if (!stored || stored.file.sizeBytes > 1_000_000
      || !isTextualMediaType(stored.file.mediaType)) {
      throw new AgentRuntimeError("output_not_renderable", "The Run output is not a bounded textual artifact.");
    }
    const bytes = this.store.readObjectFile(stored.file.id);
    const selected = {
      outputRef,
      logicalName: stored.logicalName,
      sampleIndex: stored.contractVersion === 4 ? stored.sampleIndex : null,
      mediaType: stored.file.mediaType,
      declaredRole: stored.contractVersion === 4 ? stored.declaredRole : stored.outputType,
      sizeBytes: stored.file.sizeBytes,
      sha256: stored.file.sha256,
    };
    if (input.offset === undefined && input.maxBytes === undefined) {
      return { ...selected, content: bytes.toString("utf8") };
    }
    const offset = input.offset === undefined ? 0 : Number(input.offset);
    const maxBytes = input.maxBytes === undefined ? 64 * 1024 : Number(input.maxBytes);
    if (offset > bytes.byteLength) throw new AgentRuntimeError(
      "invalid_output_offset", "The Run output offset exceeds the output size.",
    );
    const page = boundedUtf8Page(bytes, offset, maxBytes);
    return {
      ...selected,
      offset,
      content: page.text,
      truncated: page.truncated,
      nextOffset: page.truncated ? page.endOffset : null,
    };
  }

  #readRunEvents(grant: AgentToolGrant, input: Readonly<Record<string, unknown>>) {
    this.#requireProject(grant);
    const run = this.#resolveRunRef(grant, boundedText(input.runRef, 256));
    const afterSequence = input.afterSequence === undefined ? 0 : Number(input.afterSequence);
    const limit = input.limit === undefined ? 100 : Number(input.limit);
    const page = this.store.listRunDiagnosticEvents({
      projectId: grant.owner.id,
      runId: run.id,
      afterSequence,
      limit,
      types: [],
      sampleIndexes: [],
      occurredAtFrom: null,
      occurredAtTo: null,
    });
    return {
      items: page.items.map((event) => ({
        sequence: event.sequence,
        sampleIndex: event.sampleIndex,
        type: event.type,
        occurredAt: event.occurredAt,
        payload: event.payload,
      })),
      hasMore: page.hasMore,
      lifecycleDigest: page.binding.lifecycleDigest,
      eventSetDigest: page.binding.eventSet.eventSetDigest,
    };
  }

  #commitProjectOperation(
    grant: AgentToolGrant,
    actionKind: string,
    requestKey: string,
    intent: Readonly<Record<string, unknown>>,
    operation: () => unknown,
  ) {
    const actionId = stableId("action", `${grant.turnId}:${actionKind}:${requestKey}`);
    let action = this.#recordProposed(actionId, grant, actionKind, intent);
    if (action.state === "denied" || action.state === "rolled_back"
      || action.state === "failed") return safeActionResult(action);
    const at = this.#now();
    const transactionId = `mutation_agent_${createHash("sha256").update(actionId).digest("hex").slice(0, 32)}`;
    if (action.state === "proposed") action = this.store.transitionActionRecord({
      id: actionId, expectedState: "proposed", state: "authorized", at,
    });
    if (action.state === "authorized") action = this.store.transitionActionRecord({
      id: actionId, expectedState: "authorized", state: "staging",
      mutationTransactionId: transactionId, at,
    });
    try {
      const receipt = operation();
      const evidence = this.#verifiedOperationEvidence(
        grant, actionKind, requestKey, receipt,
      );
      if (action.state === "staging") action = this.store.commitReceiptBackedAgentAction({
        actionId, mutationTransactionId: transactionId,
        receiptDigest: evidence.receiptDigest,
        affectedResources: evidence.affectedResources,
        committedAt: at,
      });
      return safeActionResult(action, {
        receipt,
        receiptDigest: evidence.receiptDigest,
      });
    } catch (error) {
      // A receipt-backed operation can durably commit and then fail while
      // producing its public projection.  Never assert rollback here.
      throw error;
    }
  }

  async #commitExternalProjectOperation(
    grant: AgentToolGrant,
    actionKind: "project_technical_check_start" | "project_delivery",
    requestKey: string,
    intent: Readonly<Record<string, unknown>>,
    operation: () => Promise<ProjectOperationEnvelope>,
  ) {
    const actionId = stableId(
      "action", `${grant.turnId}:${actionKind}:${requestKey}`,
    );
    let action = this.#recordProposed(actionId, grant, actionKind, intent);
    if (["denied", "rolled_back", "failed"].includes(action.state)) {
      return safeActionResult(action);
    }
    const at = this.#now();
    const transactionId = `mutation_agent_${createHash("sha256")
      .update(actionId).digest("hex").slice(0, 32)}`;
    if (action.state === "proposed") {
      action = this.store.transitionActionRecord({
        id: actionId, expectedState: "proposed", state: "authorized", at,
      });
    }
    if (action.state === "authorized") {
      action = this.store.transitionActionRecord({
        id: actionId, expectedState: "authorized", state: "staging",
        mutationTransactionId: transactionId, at,
      });
    }
    const envelope = validateProjectOperationEnvelope(await operation(), actionKind);
    if (action.state === "staging") {
      action = this.store.commitReceiptBackedAgentAction({
        actionId,
        mutationTransactionId: transactionId,
        receiptDigest: envelope.receiptDigest,
        affectedResources: envelope.affectedResources,
        committedAt: at,
      });
    }
    return safeActionResult(action, {
      delivery: envelope.result,
      receiptDigest: envelope.receiptDigest,
    });
  }

  #verifiedOperationEvidence(
    grant: AgentToolGrant,
    actionKind: string,
    requestKey: string,
    receipt: unknown,
  ): Readonly<{
    receiptDigest: string;
    affectedResources: readonly Readonly<Record<string, unknown>>[];
  }> {
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
      throw new AgentRuntimeError(
        "invalid_domain_receipt", "The Riff operation did not return a receipt object.",
      );
    }
    const value = receipt as Record<string, unknown>;
    if (actionKind === "model_technical_check_start") {
      const id = boundedId(value.id);
      const commandId = stableId(
        "command", `${grant.turnId}:technical-check:${requestKey}`,
      );
      const expectedCheckId = `technical_check_${createHash("sha256").update(
        Buffer.from(`${grant.owner.id}\u0000${commandId}`, "utf8"),
      ).digest("hex").slice(0, 32)}`;
      if (grant.owner.kind !== "model" || value.modelId !== grant.owner.id) {
        throw new AgentRuntimeError("invalid_domain_receipt", "The technical-check receipt owner is invalid.");
      }
      if (id !== expectedCheckId) {
        throw new AgentRuntimeError("invalid_domain_receipt", "The technical-check receipt command binding is invalid.");
      }
      let evidence;
      try {
        evidence = this.store.getTechnicalCheckReceiptEvidence({
          modelId: grant.owner.id,
          checkId: id,
        });
      } catch {
        throw new AgentRuntimeError(
          "invalid_domain_receipt",
          "The technical-check receipt does not match Store authority.",
        );
      }
      if (!evidence) {
        throw new AgentRuntimeError("invalid_domain_receipt", "The technical-check receipt is not terminal.");
      }
      if (!canonicalJsonV2(value).equals(canonicalJsonV2(
        technicalCheckProjection(evidence.record),
      ))) {
        throw new AgentRuntimeError(
          "invalid_domain_receipt",
          "The technical-check projection does not match Store authority.",
        );
      }
      return Object.freeze({
        receiptDigest: evidence.receiptDigest,
        affectedResources: evidence.affectedResources,
      });
    }
    if (actionKind === "experiment_configuration_create") {
      if (grant.owner.kind !== "project") {
        throw new AgentRuntimeError("invalid_domain_receipt", "The Experiment receipt owner or contract is invalid.");
      }
      const commandId = stableId(
        "command", `${grant.turnId}:create-experiment:${requestKey}`,
      );
      const evidence = this.store.getExperimentCommandReceiptEvidence({
        commandId, commandKind: "create", projectId: grant.owner.id,
      });
      if (!evidence || value.id !== evidence.response.id
        || value.projectId !== evidence.response.projectId
        || value.configurationDigest !== evidence.response.configurationDigest
        || value.recordDigest !== experimentConfigurationRecordDigest(evidence.response)) {
        throw new AgentRuntimeError("invalid_domain_receipt", "The Experiment receipt does not match Store authority.");
      }
      return Object.freeze({
        receiptDigest: evidence.receiptDigest,
        affectedResources: evidence.affectedResources,
      });
    }
    if (["run_start", "run_cancel", "run_trash", "run_restore"].includes(actionKind)) {
      if (grant.owner.kind !== "project" || value.projectId !== grant.owner.id) {
        throw new AgentRuntimeError("invalid_domain_receipt", "The Run receipt owner is invalid.");
      }
      const commandLabel = actionKind === "run_start" ? "start-run"
        : actionKind === "run_cancel" ? "cancel-run"
          : actionKind === "run_trash" ? "trash-run" : "restore-run";
      const expectedCommandId = stableId(
        "command", `${grant.turnId}:${commandLabel}:${requestKey}`,
      );
      const commandKind = actionKind === "run_start" ? "start"
        : actionKind === "run_cancel" ? "cancel"
          : actionKind === "run_trash" ? "trash" : "restore";
      let evidence;
      try {
        evidence = this.store.getRunCommandReceiptEvidence({
          commandId: expectedCommandId,
          commandKind,
          projectId: grant.owner.id,
        });
      } catch {
        throw new AgentRuntimeError(
          "invalid_domain_receipt", "The Run receipt does not match Store authority.",
        );
      }
      if (!evidence
        || !canonicalJsonV2(value).equals(canonicalJsonV2(evidence.response))) {
        throw new AgentRuntimeError("invalid_domain_receipt", "The Run receipt does not match Store authority.");
      }
      return Object.freeze({
        receiptDigest: evidence.receiptDigest,
        affectedResources: evidence.affectedResources,
      });
    }
    if (/^owner_(?:rename|archive|trash|restore)$/u.test(actionKind)) {
      const expectedCommandId = stableId(
        "command",
        `${grant.turnId}:owner-${actionKind.slice("owner_".length)}:${requestKey}`,
      );
      const action = actionKind.slice("owner_".length) as
        "rename" | "archive" | "trash" | "restore";
      let evidence;
      try {
        evidence = this.store.getLifecycleCommandReceiptEvidence({
          commandId: expectedCommandId,
          action,
          kind: grant.owner.kind,
          id: grant.owner.id,
        });
      } catch {
        throw new AgentRuntimeError(
          "invalid_domain_receipt",
          "The owner lifecycle receipt does not match Store authority.",
        );
      }
      if (!evidence
        || !canonicalJsonV2(value).equals(canonicalJsonV2(evidence.response))) {
        throw new AgentRuntimeError("invalid_domain_receipt", "The owner lifecycle receipt does not match Store authority.");
      }
      return Object.freeze({
        receiptDigest: evidence.receiptDigest,
        affectedResources: evidence.affectedResources,
      });
    }
    throw new AgentRuntimeError(
      "invalid_domain_receipt", "The Riff operation has no authoritative receipt verifier.",
    );
  }

  #applyModelChanges(grant: AgentToolGrant, input: Readonly<Record<string, unknown>>) {
    this.#requireModel(grant);
    const parsed = parseModelMutationToolInput(input);
    const actionId = stableId(
      "action",
      `${grant.turnId}:apply:${parsed.requestKey}`,
    );
    if (!this.store.getActionRecord(grant.turnId, actionId)) {
      this.store.validateModelFileMutations(grant.owner.id, parsed.files);
    }
    let action = this.#recordProposed(
      actionId,
      grant,
      "model_files_mutate",
      parsed.auditDescriptor,
    );
    if (action.state === "denied"
      || action.state === "rolled_back"
      || action.state === "failed") {
      return safeActionResult(action);
    }
    if (grant.intentAuthority !== "explicit") {
      return action.state === "proposed"
        ? safeActionResult(this.#deny(actionId, "explicit_imperative_required"))
        : safeActionResult(action);
    }
    const at = this.#now();
    const transactionId = `mutation_agent_${createHash("sha256").update(actionId).digest("hex").slice(0, 32)}`;
    if (action.state === "proposed") {
      action = this.store.transitionActionRecord({
        id: actionId,
        expectedState: "proposed",
        state: "authorized",
        at,
      });
    }
    if (action.state === "authorized") {
      action = this.store.transitionActionRecord({
        id: actionId,
        expectedState: "authorized",
        state: "staging",
        mutationTransactionId: transactionId,
        at,
      });
    }
    try {
      const receipt = this.store.commitDirectModelChanges({
        commandId: stableId("model_command", `${grant.turnId}:${parsed.requestKey}`),
        modelId: grant.owner.id,
        files: parsed.files,
        ...(parsed.executionDescription
          ? { executionDescription: parsed.executionDescription }
          : {}),
        committedAt: at,
        transactionId,
      });
      if (action.state === "staging") {
        action = this.store.transitionActionRecord({
          id: actionId,
          expectedState: "staging",
          state: "committed",
          mutationTransactionId: transactionId,
          affectedResources: receipt.files.map((file) => ({
            kind: "model_file",
            id: file.itemId,
            sha256: file.proposedSha256,
          })),
          at,
        });
      }
      return safeActionResult(action, { mutationReceipt: receipt });
    } catch (error) {
      try { this.store.transitionActionRecord({ id: actionId, expectedState: "staging", state: "rolled_back", mutationTransactionId: transactionId, errorCode: "model_mutation_failed", at }); } catch { /* startup reconciliation owns ambiguous staging */ }
      throw error;
    }
  }

  #proposeModelChanges(
    grant: AgentToolGrant,
    input: Readonly<Record<string, unknown>>,
  ) {
    this.#requireModel(grant);
    const parsed = parseModelMutationToolInput(input);
    const actionId = stableId(
      "action",
      `${grant.turnId}:propose:${parsed.requestKey}`,
    );
    if (!this.store.getActionRecord(grant.turnId, actionId)) {
      this.store.validateModelFileMutations(grant.owner.id, parsed.files);
    }
    let action = this.#recordProposed(
      actionId,
      grant,
      "model_change_set_create",
      parsed.auditDescriptor,
    );
    const changeSetId = stableId(
      "change_set",
      `${grant.turnId}:${parsed.requestKey}`,
    );
    if (action.state === "committed") {
      return assertSafeProposalToolResult(this.store.getAgentToolResult(
        actionId,
        "riff_propose_model_changes",
      ));
    }
    if (action.state === "denied"
      || action.state === "rolled_back"
      || action.state === "failed") {
      return safeActionResult(action);
    }
    const at = this.#now();
    const transactionId =
      `mutation_agent_${createHash("sha256").update(actionId).digest("hex").slice(0, 32)}`;
    if (action.state === "proposed") {
      action = this.store.transitionActionRecord({
        id: actionId,
        expectedState: "proposed",
        state: "authorized",
        at,
      });
    }
    if (action.state === "authorized") {
      action = this.store.transitionActionRecord({
        id: actionId,
        expectedState: "authorized",
        state: "staging",
        mutationTransactionId: transactionId,
        at,
      });
    }
    try {
      const changeSet = this.store.createModelChangeSet({
        id: changeSetId,
        modelId: grant.owner.id,
        conversationId: grant.conversationId,
        turnId: grant.turnId,
        baseWorkspaceDigest: this.store.modelWorkspaceDigest(grant.owner.id),
        files: parsed.files,
        ...(parsed.executionDescription
          ? { executionDescription: parsed.executionDescription }
          : {}),
        createdAt: at,
        transactionId,
      });
      if (action.state === "staging") {
        const committed = this.store.commitActionWithToolResult({
          actionId,
          toolName: "riff_propose_model_changes",
          mutationTransactionId: transactionId,
          affectedResources: [{
            kind: "model_change_set",
            id: changeSet.id,
            sha256: changeSet.changeSetDigest,
          }],
          result: safeCommittedActionResult(action, {
            changeSet: safeChangeSetSummary(changeSet),
          }),
          at,
        });
        action = committed.action;
        return assertSafeProposalToolResult(committed.result);
      }
      return assertSafeProposalToolResult(this.store.getAgentToolResult(
        actionId,
        "riff_propose_model_changes",
      ));
    } catch (error) {
      try {
        this.store.transitionActionRecord({
          id: actionId,
          expectedState: "staging",
          state: "rolled_back",
          mutationTransactionId: transactionId,
          errorCode: "model_change_set_failed",
          at,
        });
      } catch {
        // Startup reconciliation owns ambiguous staging.
      }
      throw error;
    }
  }

  #publishModelGeneratedViews(
    grant: AgentToolGrant,
    input: Readonly<Record<string, unknown>>,
  ) {
    this.#requireModel(grant);
    const parsed = parseGeneratedViewsToolInput(input);
    const actionId = stableId(
      "action",
      `${grant.turnId}:views:${parsed.requestKey}`,
    );
    if (!this.store.getActionRecord(grant.turnId, actionId)) {
      const modelFiles = new Set(
        this.store.listObjectFiles(grant.owner).map((file) => file.id),
      );
      if (parsed.views.some((view) =>
        view.sourceFileIds.some((fileId) => !modelFiles.has(fileId)))) {
        throw new AgentRuntimeError(
          "file_scope_mismatch",
          "A generated-view source is outside the bound Model workspace.",
        );
      }
    }
    let action = this.#recordProposed(
      actionId,
      grant,
      "model_generated_views_publish",
      parsed.auditDescriptor,
    );
    if (action.state === "committed") {
      return assertSafeGeneratedViewsToolResult(
        this.store.getAgentToolResult(
          actionId,
          "riff_publish_model_generated_views",
        ),
      );
    }
    if (action.state === "denied"
      || action.state === "rolled_back"
      || action.state === "failed") {
      return safeActionResult(action);
    }
    const at = this.#now();
    const transactionId =
      `mutation_agent_${createHash("sha256").update(actionId).digest("hex").slice(0, 32)}`;
    if (action.state === "proposed") {
      action = this.store.transitionActionRecord({
        id: actionId,
        expectedState: "proposed",
        state: "authorized",
        at,
      });
    }
    if (action.state === "authorized") {
      action = this.store.transitionActionRecord({
        id: actionId,
        expectedState: "authorized",
        state: "staging",
        mutationTransactionId: transactionId,
        at,
      });
    }
    try {
      const set = this.store.publishGeneratedViews({
        modelId: grant.owner.id,
        conversationId: grant.conversationId,
        turnId: grant.turnId,
        sourceWorkspaceDigest: this.store.modelWorkspaceDigest(grant.owner.id),
        views: parsed.views,
        publishedAt: at,
        transactionId,
      });
      if (action.state === "staging") {
        const committed = this.store.commitActionWithToolResult({
          actionId,
          toolName: "riff_publish_model_generated_views",
          mutationTransactionId: transactionId,
          affectedResources: [{
            kind: "model_generated_view_set",
            id: grant.owner.id,
            sha256: set.setDigest,
          }],
          result: safeCommittedActionResult(action, {
            generatedViewSet: safeGeneratedViewSetSummary(set),
          }),
          at,
        });
        action = committed.action;
        return assertSafeGeneratedViewsToolResult(committed.result);
      }
      return assertSafeGeneratedViewsToolResult(
        this.store.getAgentToolResult(
          actionId,
          "riff_publish_model_generated_views",
        ),
      );
    } catch (error) {
      try {
        this.store.transitionActionRecord({
          id: actionId,
          expectedState: "staging",
          state: "rolled_back",
          mutationTransactionId: transactionId,
          errorCode: "generated_views_publish_failed",
          at,
        });
      } catch {
        // Startup reconciliation owns ambiguous staging.
      }
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
      commandId: stableId("command", `${grant.turnId}:update-experiment:${requestKey}`),
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
      const evidence = this.store.getExperimentCommandReceiptEvidence({
        commandId: normalizedUpdateIntent.commandId,
        commandKind: "update",
        projectId: grant.owner.id,
      });
      if (!evidence) throw new AgentRuntimeError(
        "experiment_replay_receipt_missing",
        "The durable Experiment receipt disappeared during verification.",
      );
      if (action.state === "staging") {
        this.store.commitReceiptBackedAgentAction({
          actionId,
          mutationTransactionId: transactionId,
          receiptDigest: evidence.receiptDigest,
          affectedResources: evidence.affectedResources,
          committedAt: this.#now(),
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
      const evidence = this.store.getExperimentCommandReceiptEvidence({
        commandId: normalizedUpdateIntent.commandId,
        commandKind: "update",
        projectId: grant.owner.id,
      });
      if (!evidence) throw new AgentRuntimeError(
        "experiment_receipt_missing",
        "The Experiment update did not produce durable receipt evidence.",
      );
      this.store.commitReceiptBackedAgentAction({
        actionId,
        mutationTransactionId: transactionId,
        receiptDigest: evidence.receiptDigest,
        affectedResources: evidence.affectedResources,
        committedAt: at,
      });
      return experimentUpdateResult(updated);
    } catch (error) {
      // The update receipt is authoritative even if response projection
      // throws.  Startup recovery owns every ambiguous staging outcome.
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

const consequentialOperationSelection = (
  owner: { kind: "model" | "project"; id: string },
  text: string,
  authority: "explicit" | "proposal_only",
): Readonly<{ tool: AgentToolName; action: string | null }> | null => {
  if (authority !== "explicit") return null;
  const candidates: Array<{ tool: AgentToolName; action: string | null }> = [];
  const add = (matched: boolean, tool: AgentToolName, action: string | null = null) => {
    if (matched) candidates.push({ tool, action });
  };
  if (owner.kind === "model") {
    add(/\b(?:start|run|perform)\b[^.!?。！？]{0,60}\btechnical[ -]?check\b|(?:启动|运行|执行)[^。！？]{0,30}(?:技术检查|技术校验)/iu.test(text),
      "riff_start_model_technical_check");
    add(/\b(?:update|change|modify|replace|apply|write)\b[^.!?。！？]{0,80}\b(?:model|code|file|workspace)\b|(?:更新|修改|替换|应用|写入)[^。！？]{0,50}(?:模型|代码|文件|工作区)/iu.test(text),
      "riff_apply_model_changes");
  } else {
    const projectMutation = /\b(?:update|change|modify|replace|apply|write|add|remove|delete)\b[^.!?。！？]{0,80}\b(?:project|code|file|workspace|dependency|controller|interface|simulation|visualization|page)\b|(?:更新|修改|替换|应用|写入|加入|新增|添加|删除)[^。！？]{0,50}(?:项目|代码|文件|工作区|依赖|控制器|界面|仿真|可视化|页面)/iu.test(text);
    const visualStart = /\b(?:start|run|launch)\b[^.!?。！？]{0,50}\b(?:visual(?:ization)?|simulation|visual\s+run)\b|(?:启动|运行)[^。！？]{0,30}(?:可视化仿真|可视化运行|可视化|仿真页面|仿真)/iu.test(text);
    const chainedRun = /\b(?:and|then)\s+run\b|(?:并|然后|再)运行/u.test(text);
    add(projectMutation,
      "riff_deliver_project_changes");
    add(!projectMutation && /\b(?:start|run|perform)\b[^.!?。！？]{0,60}\btechnical[ -]?check\b|(?:启动|运行|执行)[^。！？]{0,30}(?:技术检查|技术校验)/iu.test(text),
      "riff_start_project_technical_check");
    add(/\b(?:create|add|make)\b[^.!?。！？]{0,50}\bexperiment(?:\s+configuration)?\b|(?:创建|新增|建立)[^。！？]{0,30}(?:实验配置|实验)/iu.test(text),
      "riff_create_experiment_configuration");
    add(explicitExperimentUpdateIntent(text),
      "riff_update_experiment_configuration");
    add(!projectMutation && (visualStart || chainedRun
      || /\b(?:start|run|launch)\b[^.!?。！？]{0,40}\b(?:the\s+)?run\b|(?:启动|运行)[^。！？]{0,25}(?:仿真运行|运行任务|实验运行)/iu.test(text)),
      "riff_start_run");
    add(/\bcancel\b[^.!?。！？]{0,40}\brun\b|取消[^。！？]{0,25}(?:运行任务|实验运行|仿真运行)/iu.test(text),
      "riff_cancel_run");
    add(/\b(?:trash|delete)\b[^.!?。！？]{0,40}\brun\b|(?:移入回收站|删除)[^。！？]{0,25}(?:运行任务|实验运行|仿真运行)/iu.test(text),
      "riff_trash_run");
    add(/\brestore\b[^.!?。！？]{0,40}\brun\b|恢复[^。！？]{0,25}(?:运行任务|实验运行|仿真运行)/iu.test(text),
      "riff_restore_run");
    add(explicitAnalysisDocumentIntent(text), "riff_create_analysis_document");
    // A write followed by open/run remains one consequential delivery. The
    // optional Run is part of riff_deliver_project_changes, never a second
    // permission.
  }
  add(/\badopt\b[^.!?。！？]{0,50}\battachment\b|采用[^。！？]{0,30}附件/iu.test(text),
    "riff_adopt_attachment");
  const lifecycle = /\b(rename|archive|trash|restore)\b[^.!?。！？]{0,60}\b(?:this\s+|the\s+)?(?:model|project|owner)\b/iu.exec(text)
    ?? /(?:重命名|归档|移入回收站|恢复)[^。！？]{0,30}(?:模型|项目|当前对象)/u.exec(text);
  if (lifecycle) {
    const raw = lifecycle[1]?.toLowerCase() ?? lifecycle[0];
    const action = /archive|归档/u.test(raw) ? "archive"
      : /trash|移入回收站/u.test(raw) ? "trash"
        : /restore|恢复/u.test(raw) ? "restore" : "rename";
    candidates.push({ tool: "riff_transition_owner_lifecycle", action });
  }
  const unique = [...new Map(candidates.map((candidate) =>
    [`${candidate.tool}:${candidate.action ?? ""}`, candidate])).values()];
  if (unique.length !== 1) return null;
  const selected = unique[0]!;
  return Object.freeze(selected);
};

const explicitImperativeClause = (text: string): boolean => {
  const normalized = text.trim().toLowerCase()
    .replace(/^(?:另外|同时|然后|再)\s*/u, "");
  if (!normalized || /\?|\b(?:if|maybe|might|could|would|should we|discuss|explain|suggest|consider|how|what|why)\b|(?:如果|也许|可能|是否|能否|可以吗|讨论|解释|建议|如何|为什么)/u.test(normalized)) return false;
  return /^(?:please\s+)?(?:set|change|update|replace|add|create|write|modify|apply|start|run|cancel|archive|restore|trash|rename|adopt|reject|supersede|remove|delete)\b|^(?:请)?(?:设置|修改|更新|替换|新增|加入|添加|创建|建立|写入|应用|启动|运行|取消|归档|恢复|移入回收站|重命名|采用|拒绝|取代|删除)|^(?:请)?(?:把|将(?!来))[^?？\n]{1,500}(?:设置|修改|更新|替换|新增|加入|添加|创建|建立|写入|应用|启动|运行|取消|归档|恢复|移入回收站|重命名|采用|拒绝|取代|删除)/u.test(normalized);
};

export const imperativeClauses = (text: string): readonly string[] =>
  Object.freeze(text
    .split(/(?:[.!?;。！？；]\s*|[,，]\s*(?=(?:另外|同时|然后|再|请))|\s+\b(?:and|then)\b\s+)/iu)
    .map((clause) => clause.trim())
    .filter((clause) => clause && explicitImperativeClause(clause)));

export const explicitImperative = (text: string): boolean =>
  imperativeClauses(text).length > 0;

const explicitBrowserIntent = (text: string): boolean =>
  /\b(?:browser|web\s*page|page\s+snapshot|screenshot|click|type|scroll|reload|navigate)\b|(?:浏览器|网页|页面快照|截图|点击|输入|滚动|刷新页面|打开页面)/iu.test(text);

const currentVisualizationOpenIntent = (text: string): boolean =>
  /\b(?:open|show|view)\b[^.!?。！？]{0,40}\b(?:current\s+)?(?:visual(?:ization)?|simulation)(?:\s+page)?\b|(?:打开|显示|查看)[^。！？]{0,25}(?:当前)?(?:可视化|仿真页面)/iu.test(text);

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
  const text = boundedText(row.text, 1_048_576, true); const expected = row.expectedPriorSha256;
  if (expected !== null && (typeof expected !== "string" || !/^[0-9a-f]{64}$/u.test(expected))) throw new Error("invalid");
  return { objectFileId, kind: kind as ModelFileMutation["kind"], relativePath, mediaType, bytes: Buffer.from(text), expectedPriorSha256: expected as string | null };
};
const parseModelMutationToolInput = (
  input: Readonly<Record<string, unknown>>,
) => {
  if (Object.keys(input).some((key) =>
    !["requestKey", "changes", "executionDescription"].includes(key))
    || !Object.hasOwn(input, "requestKey")
    || !Object.hasOwn(input, "changes")
    || !Array.isArray(input.changes)
    || input.changes.length < 1
    || input.changes.length > 64) {
    throw new AgentRuntimeError(
      "invalid_tool_input",
      "Agent Model changes are invalid.",
    );
  }
  const requestKey = boundedId(input.requestKey);
  const files = input.changes.map(parseModelFileMutation);
  const executionDescription = input.executionDescription === undefined
    ? undefined
    : validateExecutionDescriptionV2(input.executionDescription);
  const changesDigest = createHash("sha256")
    .update(canonical({
      changes: files.map((file) => ({
        objectFileId: file.objectFileId,
        kind: file.kind,
        relativePath: file.relativePath,
        mediaType: file.mediaType,
        textSha256: createHash("sha256").update(file.bytes).digest("hex"),
        expectedPriorSha256: file.expectedPriorSha256,
      })),
      executionDescription: executionDescription ?? null,
    }))
    .digest("hex");
  return Object.freeze({
    requestKey,
    files: Object.freeze(files),
    executionDescription,
    auditDescriptor: Object.freeze({
      schemaVersion: 1,
      requestKey,
      changeCount: files.length,
      changesDigest,
      executionDescriptionDigest: executionDescription === undefined
        ? null
        : createHash("sha256")
          .update(canonical(executionDescription))
          .digest("hex"),
    }),
  });
};
const parseGeneratedView = (value: unknown) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid");
  }
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some((key) =>
    !["id", "title", "mediaType", "payload", "sourceFileIds"].includes(key))) {
    throw new Error("invalid");
  }
  const sourceFileIds = row.sourceFileIds;
  if (!Array.isArray(sourceFileIds) || sourceFileIds.length > 256
    || sourceFileIds.some((id) => typeof id !== "string")) {
    throw new Error("invalid");
  }
  return {
    id: boundedId(row.id),
    title: boundedText(row.title, 300),
    mediaType: boundedText(row.mediaType, 200),
    payload: boundedText(row.payload, 2_097_152, true),
    sourceFileIds: sourceFileIds.map(boundedId),
  };
};
const parseGeneratedViewsToolInput = (
  input: Readonly<Record<string, unknown>>,
) => {
  if (!closedInput(input, ["requestKey", "views"])
    || !Array.isArray(input.views)
    || input.views.length > 16) {
    throw new AgentRuntimeError(
      "invalid_tool_input",
      "Generated views are invalid.",
    );
  }
  const requestKey = boundedId(input.requestKey);
  const views = input.views.map(parseGeneratedView);
  if (new Set(views.map((view) => view.id)).size !== views.length) {
    throw new AgentRuntimeError(
      "invalid_tool_input",
      "Generated-view identities are invalid.",
    );
  }
  let totalBytes = 0;
  let activePayloads = 0;
  for (const view of views) {
    const bytes = Buffer.from(view.payload, "utf8");
    totalBytes += bytes.byteLength;
    if (totalBytes > 8 * 1024 * 1024
      || new Set(view.sourceFileIds).size !== view.sourceFileIds.length) {
      throw new AgentRuntimeError(
        "invalid_tool_input",
        "Generated views exceed their bounded contract.",
      );
    }
    const rendered = rendererDto({
      title: view.title,
      mediaType: view.mediaType,
      sizeBytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes,
    });
    if (rendered.kind === "attachment"
      && rendered.reason === "active_content") {
      activePayloads += 1;
      if (activePayloads > 1) {
        throw new AgentRuntimeError(
          "invalid_tool_input",
          "Only one active generated-view payload is allowed.",
        );
      }
    }
  }
  const viewsDigest = createHash("sha256").update(canonical(views.map((view) => ({
    id: view.id,
    title: view.title,
    mediaType: view.mediaType,
    payloadSha256: createHash("sha256").update(view.payload).digest("hex"),
    sourceFileIds: view.sourceFileIds,
  })))).digest("hex");
  return Object.freeze({
    requestKey,
    views: Object.freeze(views),
    auditDescriptor: Object.freeze({
      schemaVersion: 1,
      requestKey,
      viewCount: views.length,
      totalBytes,
      viewsDigest,
    }),
  });
};
const closedInput = (
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean =>
  Object.keys(value).sort().join("\u0000") === [...keys].sort().join("\u0000");

const parseProjectDeliveryInput = (
  input: Readonly<Record<string, unknown>>,
) => {
  const requestKey = boundedText(input.requestKey, 256);
  const expectedWorkspaceDigest = boundedDigest(input.expectedWorkspaceDigest);
  if (!Array.isArray(input.changes) || input.changes.length < 1
    || input.changes.length > 64) {
    throw new AgentRuntimeError(
      "invalid_tool_input", "Project delivery changes are invalid.",
    );
  }
  const changes = input.changes.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || !closedInput(value as Record<string, unknown>, [
        "fileRef", "kind", "relativePath", "mediaType", "text",
        "expectedPriorSha256",
      ])) {
      throw new AgentRuntimeError(
        "invalid_tool_input", "Project delivery change is invalid.",
      );
    }
    const change = value as Record<string, unknown>;
    const fileRef = change.fileRef === null
      ? null : boundedText(change.fileRef, 256);
    const kind = String(change.kind);
    if (!new Set(["code", "environment", "visual_asset"]).has(kind)) {
      throw new AgentRuntimeError(
        "invalid_tool_input", "Project delivery file kind is invalid.",
      );
    }
    const relativePath = safeLogicalName(boundedText(change.relativePath, 400));
    const mediaType = boundedText(change.mediaType, 200);
    const text = boundedText(change.text, 1_000_000, true);
    const expectedPriorSha256 = change.expectedPriorSha256 === null
      ? null : boundedDigest(change.expectedPriorSha256);
    if ((fileRef === null) !== (expectedPriorSha256 === null)) {
      throw new AgentRuntimeError(
        "invalid_tool_input",
        "New Project files require null fileRef and prior digest; existing files require both.",
      );
    }
    return Object.freeze({
      fileRef, kind, relativePath, mediaType, text, expectedPriorSha256,
    });
  });
  let executionDescription: Readonly<Record<string, unknown>> | undefined;
  if (input.executionDescription !== undefined) {
    try {
      executionDescription = validateExecutionDescriptionV2(
        input.executionDescription,
      ) as unknown as Readonly<Record<string, unknown>>;
    } catch {
      throw new AgentRuntimeError(
        "invalid_tool_input", "Project execution description is invalid.",
      );
    }
  }
  let run: Readonly<{ configurationId: string }> | undefined;
  if (input.run !== undefined) {
    if (!input.run || typeof input.run !== "object" || Array.isArray(input.run)
      || !closedInput(input.run as Record<string, unknown>, ["configurationId"])) {
      throw new AgentRuntimeError(
        "invalid_tool_input", "Project delivery Run request is invalid.",
      );
    }
    run = Object.freeze({
      configurationId: boundedId(
        (input.run as Record<string, unknown>).configurationId,
      ),
    });
  }
  return Object.freeze({
    requestKey,
    expectedWorkspaceDigest,
    changes: Object.freeze(changes),
    ...(executionDescription ? { executionDescription } : {}),
    ...(run ? { run } : {}),
  });
};

const validateProjectOperationEnvelope = (
  envelope: ProjectOperationEnvelope,
  actionKind: "project_technical_check_start" | "project_delivery",
): ProjectOperationEnvelope => {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)
    || !/^[0-9a-f]{64}$/u.test(String(envelope.receiptDigest))
    || !Array.isArray(envelope.affectedResources)
    || !envelope.result || typeof envelope.result !== "object"
    || Array.isArray(envelope.result)
    || canonicalJsonV2(envelope.result).byteLength > 256_000) {
    throw new AgentRuntimeError(
      "invalid_domain_receipt", "The Project operation receipt is invalid.",
    );
  }
  const expectedKeys = actionKind === "project_delivery"
    ? ["status", "partialEffect", "workspaceDigest", "mutationReceipt", "technicalCheck", "run"]
    : ["status", "partialEffect", "workspaceDigest", "technicalCheck"];
  const result = envelope.result;
  if (!closedInput(result, expectedKeys)
    || !new Set(["succeeded", "failed"]).has(String(result.status))
    || typeof result.partialEffect !== "boolean"
    || !/^[0-9a-f]{64}$/u.test(String(result.workspaceDigest))
    || (result.status === "succeeded" && result.partialEffect !== false)
    || (actionKind === "project_technical_check_start"
      && result.partialEffect !== false)
    || (actionKind === "project_delivery" && !result.mutationReceipt)
    || (actionKind === "project_delivery" && result.status === "failed"
      && result.partialEffect !== true)) {
    throw new AgentRuntimeError(
      "invalid_domain_receipt", "The Project operation result is invalid.",
    );
  }
  const forbidden = new Set([
    "modelId", "sourceModelId", "modelSnapshotDigest", "owner", "ownerId",
    "ownerKind", "path", "port", "url", "pid", "sessionId",
  ]);
  const inspect = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(inspect);
    if (!value || typeof value !== "object") return;
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (forbidden.has(key)) throw new AgentRuntimeError(
        "invalid_domain_receipt", "The Project operation result leaks private scope.",
      );
      inspect(nested);
    }
  };
  inspect(result);
  return Object.freeze({
    receiptDigest: envelope.receiptDigest,
    affectedResources: Object.freeze(envelope.affectedResources.map((item) =>
      Object.freeze({ ...item }))),
    result: Object.freeze({ ...result }),
  });
};
const safeActionResult = (
  action: ActionRecordDto,
  extra: Readonly<Record<string, unknown>> = {},
) => Object.freeze({
  id: action.id,
  actionKind: action.actionKind,
  permissionDecision: action.permissionDecision,
  state: action.state,
  errorCode: action.errorCode,
  ...extra,
});
const safeCommittedActionResult = (
  action: ActionRecordDto,
  extra: Readonly<Record<string, unknown>>,
) => safeActionResult({ ...action, state: "committed" }, extra);

const scopedRef = (
  kind: string,
  ownerId: string,
  resourceId: string,
  digest: string,
): string => `${kind}_${createHash("sha256")
  .update(canonical({ kind, ownerId, resourceId, digest }))
  .digest("hex").slice(0, 48)}`;

const isTextualMediaType = (mediaType: string): boolean =>
  mediaType.startsWith("text/")
  || ["application/json", "application/markdown", "application/csv"]
    .includes(mediaType.toLowerCase());
const assertSafeProposalToolResult = (
  value: Record<string, unknown>,
): Record<string, unknown> => {
  if (!closedInput(value, [
    "actionKind",
    "changeSet",
    "errorCode",
    "id",
    "permissionDecision",
    "state",
  ])
    || value.actionKind !== "model_change_set_create"
    || value.permissionDecision !== "allowed"
    || value.state !== "committed"
    || value.errorCode !== null
    || typeof value.id !== "string"
    || !value.changeSet
    || typeof value.changeSet !== "object"
    || Array.isArray(value.changeSet)
    || !closedInput(value.changeSet as Record<string, unknown>, [
      "baseWorkspaceDigest",
      "changeSetDigest",
      "id",
      "state",
    ])) {
    throw new AgentRuntimeError(
      "tool_result_corrupt",
      "The durable proposal result is invalid.",
    );
  }
  const changeSet = value.changeSet as Record<string, unknown>;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/u.test(String(value.id))
    || !/^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/u.test(String(changeSet.id))
    || !/^[0-9a-f]{64}$/u.test(String(changeSet.changeSetDigest))
    || !/^[0-9a-f]{64}$/u.test(String(changeSet.baseWorkspaceDigest))
    || changeSet.state !== "pending") {
    throw new AgentRuntimeError(
      "tool_result_corrupt",
      "The durable proposal result is invalid.",
    );
  }
  return Object.freeze(value);
};
const assertSafeGeneratedViewsToolResult = (
  value: Record<string, unknown>,
): Record<string, unknown> => {
  if (!closedInput(value, [
    "actionKind",
    "errorCode",
    "generatedViewSet",
    "id",
    "permissionDecision",
    "state",
  ])
    || value.actionKind !== "model_generated_views_publish"
    || value.permissionDecision !== "allowed"
    || value.state !== "committed"
    || value.errorCode !== null
    || typeof value.id !== "string"
    || !value.generatedViewSet
    || typeof value.generatedViewSet !== "object"
    || Array.isArray(value.generatedViewSet)
    || !closedInput(value.generatedViewSet as Record<string, unknown>, [
      "setDigest",
      "sourceWorkspaceDigest",
      "viewCount",
    ])) {
    throw new AgentRuntimeError(
      "tool_result_corrupt",
      "The durable generated-view result is invalid.",
    );
  }
  const set = value.generatedViewSet as Record<string, unknown>;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/u.test(String(value.id))
    || !/^[0-9a-f]{64}$/u.test(String(set.setDigest))
    || !/^[0-9a-f]{64}$/u.test(String(set.sourceWorkspaceDigest))
    || !Number.isSafeInteger(set.viewCount)
    || Number(set.viewCount) < 0
    || Number(set.viewCount) > 16) {
    throw new AgentRuntimeError(
      "tool_result_corrupt",
      "The durable generated-view result is invalid.",
    );
  }
  return Object.freeze(value);
};
const safeChangeSetSummary = (changeSet: Readonly<{
  id: string;
  changeSetDigest: string;
  baseWorkspaceDigest: string;
  state: string;
}>) => Object.freeze({
  id: changeSet.id,
  changeSetDigest: changeSet.changeSetDigest,
  baseWorkspaceDigest: changeSet.baseWorkspaceDigest,
  state: changeSet.state,
});
const safeGeneratedViewSetSummary = (set: Readonly<{
  setDigest: string;
  sourceWorkspaceDigest: string;
  views: readonly unknown[];
}>) => Object.freeze({
  setDigest: set.setDigest,
  sourceWorkspaceDigest: set.sourceWorkspaceDigest,
  viewCount: set.views.length,
});
const technicalCheckProjection = (record: TechnicalCheckRecord) => {
  const safeText = (value: unknown, maximum: number): string =>
    typeof value === "string" ? value.slice(0, maximum) : "";
  const checks = Array.isArray(record.results.checks)
    ? record.results.checks.filter((item): item is Record<string, unknown> =>
      Boolean(item) && typeof item === "object" && !Array.isArray(item))
      .map((item) => ({
        name: safeText(item.name, 100),
        state: safeText(item.state, 30),
        code: safeText(item.code, 100),
        detail: safeText(item.detail, 500)
          .replace(/(?:\/[A-Za-z0-9._-]+){2,}/gu, "[path]"),
      })) : [];
  const aggregate = record.state === "running" ? "pending"
    : record.results.aggregate === "executable" ? "executable"
      : record.state === "cancelled" ? "cancelled" : "failed";
  return Object.freeze({
    id: record.id,
    modelId: record.modelId,
    state: record.state,
    publication: record.state === "running" ? "pending"
      : record.results.published === true ? "published" : "superseded",
    capturedWorkspaceDigest: record.workspaceDigest,
    executionDescriptionDigest: record.executionDescriptionDigest,
    aggregate,
    checks,
    limits: record.limits,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    claim: "technical_execution_only",
  });
};
const boundedId = (value: unknown): string => { if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/u.test(value)) throw new Error("invalid"); return value; };
const boundedDigest = (value: unknown): string => {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new AgentRuntimeError("invalid_tool_input", "Agent tool digest is invalid.");
  }
  return value;
};
const boundedText = (value: unknown, max: number, empty = false): string => { if (typeof value !== "string" || (!empty && !value.trim()) || Buffer.byteLength(value) > max || value.includes("\0")) throw new AgentRuntimeError("invalid_tool_input", "Agent tool text is invalid."); return empty ? value : value.trim(); };
const boundedUtf8Page = (
  bytes: Buffer,
  offset: number,
  maxBytes: number,
): Readonly<{ text: string; endOffset: number; truncated: boolean }> => {
  let endOffset = Math.min(bytes.byteLength, offset + maxBytes);
  while (endOffset > offset && endOffset < bytes.byteLength
    && (bytes[endOffset]! & 0xc0) === 0x80) endOffset -= 1;
  if (endOffset === offset && endOffset < bytes.byteLength) {
    endOffset = Math.min(bytes.byteLength, offset + maxBytes);
    while (endOffset < bytes.byteLength && (bytes[endOffset]! & 0xc0) === 0x80) endOffset += 1;
  }
  const text = bytes.subarray(offset, endOffset).toString("utf8");
  if (Buffer.from(text, "utf8").byteLength !== endOffset - offset) {
    throw new AgentRuntimeError("output_not_renderable", "The requested byte page is not valid UTF-8.");
  }
  return Object.freeze({ text, endOffset, truncated: endOffset < bytes.byteLength });
};
const safeLogicalName = (value: string): string => { if (value.startsWith("/") || value.includes("\\") || value.split("/").some((part) => !part || part === "." || part === "..")) throw new AgentRuntimeError("invalid_logical_path", "Agent logical path is invalid."); return value; };
const stripOwnedPrefix = (kind: string, value: string): string => {
  const prefix = kind === "model_code" ? "code/" : kind === "model_environment" ? "environment/" : "visuals/";
  if (!value.startsWith(prefix)) throw new AgentRuntimeError("invalid_owned_path", "Stored Model path has an invalid kind prefix.");
  return value.slice(prefix.length);
};
const stableId = (prefix: string, input: string): string => `${prefix}_${createHash("sha256").update(input).digest("hex").slice(0, 32)}`;
const canonical = (value: unknown): string =>
  canonicalJsonV2(value).toString("utf8");
