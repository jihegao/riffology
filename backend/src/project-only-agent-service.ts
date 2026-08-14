import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AgentMcpServer } from "./agent-mcp.ts";
import type { AgentToolGrant, AgentToolName } from "./agent-tools.ts";
import { canonicalDigest } from "./canonical-json-v2.ts";
import { ApiError } from "./errors.ts";
import { planExperiment } from "./experiment-planner.ts";
import type {
  OpenCodeAgent,
  OpenCodeConversationPort,
  OpenCodeProviderModel,
  OpenCodeReadiness,
  OpenCodeWorkspaceBinding,
} from "./opencode-adapter.ts";
import { ProjectOnlyBatchRuntime } from "./project-only-batch-runtime.ts";
import { ProjectOnlyOperationsAdapter } from "./project-only-operations.ts";
import {
  ProjectOnlyStore,
  ProjectOnlyStoreError,
  type ProjectConversationMessageRecord,
  type ProjectConversationTurnRecord,
  type ProjectRecord,
  type ProjectRunOutputRecord,
  type ProjectRunRecord,
} from "./project-only-store.ts";
import { ProjectOnlyVisualRuntime } from "./project-only-visual-runtime.ts";
import type { LoadedSimulationSkill } from "./simulation-skill-catalog.ts";
import { estimatedTurnTokens, type TestUserAccess } from "./test-user-access.ts";

const OPENCODE_SESSION_SETUP_TIMEOUT_MS = 10_000;
const OPENCODE_PROJECT_DELIVERY_TIMEOUT_MS = 600_000;
const MAX_INLINE_RUN_OUTPUT_BYTES = 256 * 1024;
const MAX_STATISTIC_OUTPUT_BYTES = 1024 * 1024;
const MAX_STATISTIC_RUN_BYTES = 16 * 1024 * 1024;
const DEFAULT_RUN_OUTPUT_QUANTILES = Object.freeze([0.5, 0.95]);

const PROJECT_ONLY_OBSERVATION_TOOLS = Object.freeze([
  "riff_list_experiment_configurations",
  "riff_list_project_workspace",
  "riff_list_run_outputs",
  "riff_list_runs",
  "riff_read_project_file",
  "riff_read_project_run_diagnostics",
  "riff_read_run_output",
  "riff_summarize_run_outputs",
] satisfies readonly AgentToolName[]);

export type ProjectOnlyProviderAvailability =
  | Readonly<{ mode: "live"; providerModels: readonly OpenCodeProviderModel[] }>
  | Readonly<{
      mode: "read_only";
      reason: "opencode_unavailable" | "opencode_auth_failed";
      providerModels: readonly [];
    }>;

export class ProjectOnlyAgentService {
  readonly store: ProjectOnlyStore;
  readonly operations: ProjectOnlyOperationsAdapter;
  readonly openCode?: OpenCodeConversationPort;
  readonly visualRuntime: ProjectOnlyVisualRuntime;
  readonly batchRuntime: ProjectOnlyBatchRuntime;
  readonly loadedSkills: readonly LoadedSimulationSkill[];
  readonly testUserAccess?: TestUserAccess;
  readonly now: () => string;
  readonly scopedMcpUrl?: (capability: string) => string;
  readonly #mcp: AgentMcpServer;
  #readiness: OpenCodeReadiness = { status: "unconfigured", modelId: null };
  #providers: readonly OpenCodeProviderModel[] = Object.freeze([]);
  readonly #pendingTurns = new Map<string, Promise<unknown>>();
  readonly #turnActions = new Map<string, Record<string, unknown>[]>();

  constructor(input: Readonly<{
    store: ProjectOnlyStore;
    operations: ProjectOnlyOperationsAdapter;
    openCode?: OpenCodeConversationPort;
    visualRuntime: ProjectOnlyVisualRuntime;
    batchRuntime: ProjectOnlyBatchRuntime;
    loadedSkills?: readonly LoadedSimulationSkill[];
    testUserAccess?: TestUserAccess;
    now?: () => string;
    scopedMcpUrl?: (capability: string) => string;
  }>) {
    this.store = input.store;
    this.operations = input.operations;
    this.openCode = input.openCode;
    this.visualRuntime = input.visualRuntime;
    this.batchRuntime = input.batchRuntime;
    this.loadedSkills = Object.freeze([...(input.loadedSkills ?? [])]);
    this.testUserAccess = input.testUserAccess;
    this.now = input.now ?? (() => new Date().toISOString());
    this.scopedMcpUrl = input.scopedMcpUrl;
    this.#mcp = new AgentMcpServer({
      execute: (grant, tool, toolInput) => this.#executeProjectTool(grant, tool, toolInput),
    });
  }

  async initialize(): Promise<void> {
    this.testUserAccess?.reconcileTurnReservations((requestKey) => {
      const turn = this.store.conversationTurn(requestKey);
      if (!turn) return null;
      if (turn.state !== "complete") return Object.freeze({ state: turn.state });
      const messages = this.store.conversationMessages(turn.conversationId);
      const user = messages.find((message) => message.id === turn.userMessageId)?.text ?? "";
      const assistant = messages.find((message) => message.id === turn.assistantMessageId)?.text ?? "";
      return Object.freeze({
        state: "complete" as const,
        chargedTokens: estimatedTurnTokens(user, assistant),
      });
    });
    if (!this.openCode) return;
    try {
      this.#readiness = await this.openCode.initialize?.()
        ?? { status: "ready", modelId: null };
      if (this.#readiness.status === "ready") {
        this.#providers = Object.freeze(await this.openCode.discoverProviderModels());
      }
    } catch (error) {
      this.#readiness = readinessFailure(error);
      this.#providers = Object.freeze([]);
    }
  }

  async providers(refresh = false): Promise<ProjectOnlyProviderAvailability> {
    if (refresh || this.#readiness.status !== "ready" || this.#providers.length === 0) {
      await this.initialize();
    }
    if (this.#readiness.status === "ready" && this.#providers.length > 0) {
      return Object.freeze({ mode: "live", providerModels: this.#providers });
    }
    return Object.freeze({
      mode: "read_only",
      reason: this.#readiness.lastError?.code === "opencode_auth_failed"
        ? "opencode_auth_failed" : "opencode_unavailable",
      providerModels: Object.freeze([]),
    });
  }

  async assertProvider(providerId: string, modelId: string): Promise<void> {
    const discovery = await boundedOperation(
      this.providers(),
      OPENCODE_SESSION_SETUP_TIMEOUT_MS,
      "opencode_discovery_timeout",
    );
    if (discovery.mode !== "live"
      || !discovery.providerModels.some((item) => item.providerId === providerId && item.modelId === modelId)) {
      throw new ApiError(503, discovery.mode === "read_only" ? discovery.reason : "opencode_model_unavailable",
        "The selected OpenCode provider/model is not available.");
    }
  }

  async agents(projectId: string): Promise<Readonly<{
    mode: "live";
    agents: readonly OpenCodeAgent[];
  }> | Readonly<{ mode: "read_only"; reason: string; agents: readonly [] }>> {
    const project = this.store.project(projectId);
    let discovery: ProjectOnlyProviderAvailability;
    try {
      discovery = await boundedOperation(
        this.providers(),
        OPENCODE_SESSION_SETUP_TIMEOUT_MS,
        "opencode_discovery_timeout",
      );
    } catch (error) {
      return Object.freeze({ mode: "read_only" as const, reason: errorCode(error), agents: Object.freeze([]) });
    }
    if (discovery.mode !== "live" || !this.openCode?.discoverAgents) {
      return Object.freeze({ mode: "read_only", reason: discovery.mode === "live"
        ? "opencode_agents_unavailable" : discovery.reason, agents: Object.freeze([]) });
    }
    try {
      const workspace = this.#materialize(project);
      return Object.freeze({ mode: "live", agents: Object.freeze(await this.openCode.discoverAgents(workspace)) });
    } catch (error) {
      return Object.freeze({ mode: "read_only", reason: errorCode(error), agents: Object.freeze([]) });
    }
  }

  async cancelVisualRun(projectId: string, runId: string): Promise<Readonly<{
    runId: string;
    status: "cancelled" | "already_terminal";
    terminalStatus: string;
  }>> {
    return this.visualRuntime.stop({ projectId, runId, at: this.now() });
  }

  async runTurn(input: Readonly<{
    conversationId: string;
    requestKey: string;
    text: string;
    agentName?: string;
    testUsername?: string;
  }>): Promise<Readonly<{
    mode: "live" | "read_only";
    reason?: string;
    turn: ProjectConversationTurnRecord;
    messages: readonly ProjectConversationMessageRecord[];
  }>> {
    if (!input.text.trim() || input.text.length > 64_000) {
      throw new ApiError(422, "invalid_request", "Conversation text is invalid.");
    }
    const existing = this.store.conversationTurn(input.requestKey);
    if (existing && existing.state !== "running") {
      return Object.freeze({
        mode: existing.state === "read_only" ? "read_only" : "live",
        ...(existing.failureCode ? { reason: existing.failureCode } : {}),
        turn: existing,
        messages: Object.freeze(this.store.conversationMessages(existing.conversationId)),
      });
    }
    const conversation = this.store.conversation(input.conversationId);
    const project = this.store.project(conversation.projectId);
    const turn = existing ?? this.store.beginConversationTurn({
      id: stableId("turn", `${conversation.id}:${input.requestKey}`),
      requestKey: input.requestKey,
      conversationId: conversation.id,
      text: input.text.trim(),
      ...(input.agentName ? { agentName: input.agentName } : {}),
      createdAt: this.now(),
    });
    this.#turnActions.set(turn.id, []);

    let discovery: ProjectOnlyProviderAvailability;
    try {
      discovery = await boundedOperation(
        this.providers(),
        OPENCODE_SESSION_SETUP_TIMEOUT_MS,
        "opencode_discovery_timeout",
      );
    } catch (error) {
      return this.#failDirectTurn(turn, error);
    }
    if (discovery.mode !== "live" || !this.openCode) {
      return this.#failReadOnly(turn, discovery.mode === "read_only" ? discovery.reason : "opencode_unavailable");
    }
    if (!this.openCode.bindScopedMcp || !this.openCode.unbindScopedMcp || !this.scopedMcpUrl) {
      return this.#failDirectTurn(turn, new ApiError(
        503,
        "project_mcp_unavailable",
        "The scoped Project MCP bridge is unavailable.",
      ));
    }
    if (!discovery.providerModels.some((item) => item.providerId === conversation.provider.providerId
      && item.modelId === conversation.provider.modelId)) {
      return this.#failReadOnly(turn, "opencode_model_unavailable");
    }

    let sessionId: string | null = null;
    let workspace: OpenCodeWorkspaceBinding | null = null;
    let capability: string | null = null;
    let scopeBound = false;
    try {
      workspace = this.#materialize(project);
      const storedSession = this.store.conversationSession(conversation.id);
      if (storedSession.externalSessionRef
        && await boundedOperation(
          this.openCode.getSession(storedSession.externalSessionRef, workspace),
          OPENCODE_SESSION_SETUP_TIMEOUT_MS,
          "opencode_session_setup_timeout",
        )) {
        sessionId = storedSession.externalSessionRef;
      } else {
        sessionId = await boundedOperation(
          this.openCode.createSession(conversation.id, workspace),
          OPENCODE_SESSION_SETUP_TIMEOUT_MS,
          "opencode_session_setup_timeout",
        );
        this.store.setConversationSession({
          conversationId: conversation.id,
          state: "available",
          externalSessionRef: sessionId,
          incrementGeneration: Boolean(storedSession.externalSessionRef),
          updatedAt: this.now(),
        });
      }
      const session = this.store.conversationSession(conversation.id);
      const implicitToolBudgets = projectTurnImplicitToolBudgets(input.text);
      const implicitProjectFilePathAuthority = implicitToolBudgets.has("riff_write_project_files")
        ? requestedProjectFilePathAuthority(input.text)
        : null;
      const turnTools = Object.freeze([
        ...PROJECT_ONLY_OBSERVATION_TOOLS,
        ...implicitToolBudgets.keys(),
      ].sort((left, right) => left.localeCompare(right, "en")));
      capability = this.#mcp.grant({
        conversationId: conversation.id,
        owner: Object.freeze({ kind: "project", id: project.id }),
        turnId: turn.id,
        externalSessionGeneration: session.generation,
        allowedTools: new Set(turnTools),
        implicitConsequentialToolBudgets: implicitToolBudgets,
        implicitProjectFilePathAuthority,
        intentAuthority: "explicit",
      });
      await boundedOperation(
        this.openCode.bindScopedMcp(
          turn.id,
          this.scopedMcpUrl(capability),
          turnTools,
          workspace,
        ),
        OPENCODE_SESSION_SETUP_TIMEOUT_MS,
        "opencode_mcp_setup_timeout",
      );
      scopeBound = true;
      const response = await boundedOperation(
        this.openCode.promptWithModel(sessionId, conversation.provider, {
          text: input.text.trim(),
          system: projectToolSystemPrompt(project, this.loadedSkills),
          attachments: [],
          scopedMcpScopeId: turn.id,
          scopedMcpTools: turnTools,
          scopedMcpImplicitTools: Object.freeze(
            [...implicitToolBudgets.keys()].sort((left, right) => left.localeCompare(right, "en")),
          ),
          // Project-only HTTP currently has no interaction-response route.
          // Fail fast instead of allowing an invisible built-in question to
          // hold a turn until the ten-minute delivery timeout.
          allowQuestions: false,
          ...(input.agentName ? { agentName: input.agentName } : {}),
        }, AbortSignal.timeout(OPENCODE_PROJECT_DELIVERY_TIMEOUT_MS), workspace),
        OPENCODE_PROJECT_DELIVERY_TIMEOUT_MS,
        "opencode_prompt_timeout",
      );
      const actions = Object.freeze([...(this.#turnActions.get(turn.id) ?? [])]);
      const failedAdmittedRun = actions.find((action) => action.actionKind === "run_start"
        && action.state === "committed" && typeof action.errorCode === "string");
      if (failedAdmittedRun) {
        throw new ApiError(
          502,
          String(failedAdmittedRun.errorCode),
          "A durably admitted Run failed during runtime startup.",
        );
      }
      const fileCommitCount = actions.filter((action) => action.actionKind === "project_files_write"
        && action.state === "committed").length;
      const assistantText = `${response.text.trim() || "操作已完成。"}${fileCommitCount > 0
        ? `\n\n文件已保存（${fileCommitCount} 个提交回执）。` : ""}`;
      const expectedEvidence = requestedEvidenceKinds(input.text);
      const satisfiedEvidence = satisfiedEvidenceKinds(actions);
      const missingEvidence = expectedEvidence.filter((kind) => !satisfiedEvidence.has(kind));
      if (missingEvidence.length > 0) {
        throw new ApiError(
          409,
          `project_${missingEvidence[0]}_evidence_missing`,
          "OpenCode returned without the committed Project evidence required by this request.",
        );
      }
      const completed = this.store.completeConversationTurn({
        requestKey: input.requestKey,
        assistantText,
        actions,
        goalVerification: goalVerification({
          disposition: "completed",
          reasonCode: completionReason(actions),
          intentKind: completionIntent(actions),
          actions,
          affectedResourceCount: actions.length,
          partialEffect: false,
          openCodeTerminal: "idle",
        }),
        completedAt: this.now(),
      });
      return Object.freeze({
        mode: "live",
        turn: completed,
        messages: Object.freeze(this.store.conversationMessages(conversation.id)),
      });
    } catch (error) {
      if (sessionId && workspace) {
        try { await this.openCode.abort(sessionId, workspace); } catch { /* Store effects remain authoritative. */ }
        try { this.openCode.releaseRuntimeBoundary?.(sessionId, workspace); } catch { /* generation retirement is authoritative */ }
        try {
          this.store.setConversationSession({
            conversationId: conversation.id,
            state: "lost",
            externalSessionRef: null,
            incrementGeneration: true,
            updatedAt: this.now(),
          });
        } catch { /* the durable failed turn remains authoritative */ }
      }
      return this.#failDirectTurn(turn, error);
    } finally {
      if (capability) this.#mcp.revoke(capability);
      if (scopeBound && workspace) {
        try { await this.openCode.unbindScopedMcp(turn.id, workspace); } catch { /* capability revocation is authoritative */ }
      }
      this.#turnActions.delete(turn.id);
    }
  }

  submitTurn(input: Readonly<{
    conversationId: string;
    requestKey: string;
    text: string;
    agentName?: string;
    testUsername?: string;
  }>): Readonly<{
    schemaVersion: 1;
    accepted: true;
    requestKey: string;
    turnId: string;
    state: ProjectConversationTurnRecord["state"];
    terminal: boolean;
  }> {
    if (!input.text.trim() || input.text.length > 64_000) {
      throw new ApiError(422, "invalid_request", "Conversation text is invalid.");
    }
    const existing = this.store.conversationTurn(input.requestKey);
    if (existing && existing.conversationId !== input.conversationId) {
      throw new ApiError(409, "idempotency_conflict", "Turn request key belongs to another Conversation.");
    }
    if (!existing && !this.#pendingTurns.has(input.requestKey)) {
      if (this.testUserAccess && !input.testUsername) {
        throw new ApiError(401, "authentication_required", "A test-user session is required for Agent Turns.");
      }
      if (this.testUserAccess && input.testUsername) {
        this.testUserAccess.reserveTurn(input.testUsername, input.requestKey);
      }
      const operation = this.runTurn(input);
      this.#pendingTurns.set(input.requestKey, operation);
      void operation.then((result) => {
        if (!this.testUserAccess || !input.testUsername) return;
        if (result.turn.state !== "complete") {
          this.testUserAccess.releaseTurn(input.testUsername, input.requestKey);
          return;
        }
        const assistant = result.messages.find((message) =>
          message.id === result.turn.assistantMessageId)?.text ?? "";
        this.testUserAccess.settleTurn(
          input.testUsername,
          input.requestKey,
          estimatedTurnTokens(input.text.trim(), assistant),
        );
      }, () => {
        if (this.testUserAccess && input.testUsername) {
          this.testUserAccess.releaseTurn(input.testUsername, input.requestKey);
        }
      }).catch(() => undefined);
      void operation.catch((error) => {
        const current = this.store.conversationTurn(input.requestKey);
        if (!current || current.state !== "running") return;
        const code = errorCode(error);
        this.store.failConversationTurn({
          requestKey: current.requestKey,
          state: "failed",
          code,
          assistantText: `OpenCode 未能完成其余操作（${code}）。`,
          actions: Object.freeze([]),
          goalVerification: goalVerification({
            disposition: "failed",
            reasonCode: code,
            intentKind: "explicit_mutation",
            actions: Object.freeze([]),
            affectedResourceCount: 0,
            partialEffect: false,
            openCodeTerminal: "unknown",
          }),
          failedAt: this.now(),
        });
      }).finally(() => {
        if (this.#pendingTurns.get(input.requestKey) === operation) {
          this.#pendingTurns.delete(input.requestKey);
        }
      });
    }
    const turn = this.store.conversationTurn(input.requestKey);
    if (!turn) {
      throw new ApiError(503, "turn_submission_failed", "The Agent turn was not durably accepted.");
    }
    return Object.freeze({
      schemaVersion: 1,
      accepted: true,
      requestKey: turn.requestKey,
      turnId: turn.id,
      state: turn.state,
      terminal: turn.state !== "running",
    });
  }

  turnResult(conversationId: string, requestKey: string): Readonly<{
    mode: "live" | "read_only";
    reason?: string;
    turn: ProjectConversationTurnRecord;
    messages: readonly ProjectConversationMessageRecord[];
  }> {
    const turn = this.store.conversationTurn(requestKey);
    if (!turn || turn.conversationId !== conversationId) {
      throw new ApiError(404, "turn_not_found", "The Conversation turn was not found.");
    }
    return Object.freeze({
      mode: turn.state === "read_only" ? "read_only" : "live",
      ...(turn.failureCode ? { reason: turn.failureCode } : {}),
      turn,
      messages: Object.freeze(this.store.conversationMessages(conversationId)),
    });
  }

  async handleMcp(
    capability: string | undefined,
    request: Readonly<{ jsonrpc?: string; id?: string | number | null; method?: string; params?: unknown }>,
  ): Promise<unknown> {
    return this.#mcp.handle(capability, request);
  }

  async #executeProjectTool(
    grant: AgentToolGrant,
    tool: AgentToolName,
    input: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    if (grant.owner.kind !== "project") {
      throw new ApiError(403, "project_capability_required", "This tool requires a Project capability.");
    }
    const conversation = this.store.conversation(grant.conversationId);
    if (conversation.projectId !== grant.owner.id) {
      throw new ApiError(403, "project_capability_scope_mismatch", "The capability does not own this Project.");
    }
    const project = this.store.project(grant.owner.id);

    if (tool === "riff_list_project_workspace") {
      return Object.freeze({
        project: Object.freeze({
          id: project.id,
          name: project.name,
          workspaceDigest: project.workspaceDigest,
          runMode: project.runMode,
          executionDescription: project.executionDescription,
        }),
        files: Object.freeze(this.store.projectFiles(project.id).map((file) => Object.freeze({
          fileRef: file.id,
          relativePath: file.relativePath,
          mediaType: file.mediaType,
          sizeBytes: file.sizeBytes,
          sha256: file.sha256,
        }))),
      });
    }
    if (tool === "riff_read_project_file") {
      const fileRef = requiredToolString(input.fileRef, "fileRef");
      const file = this.store.projectFiles(project.id).find((candidate) => candidate.id === fileRef);
      if (!file) throw new ApiError(404, "project_file_not_found", "The scoped Project file was not found.");
      return Object.freeze({
        fileRef: file.id,
        relativePath: file.relativePath,
        mediaType: file.mediaType,
        sha256: file.sha256,
        text: file.bytes.toString("utf8"),
      });
    }
    if (tool === "riff_list_experiment_configurations") {
      return Object.freeze({
        workspaceDigest: project.workspaceDigest,
        experiments: Object.freeze(this.store.experiments(project.id).map((experiment) => Object.freeze({
          id: experiment.id,
          name: experiment.name,
          configuration: experiment.configuration,
          configurationDigest: canonicalDigest(experiment.configuration),
          recordDigest: experimentRecordDigest(experiment),
        }))),
      });
    }
    if (tool === "riff_create_experiment_configuration") {
      const requestKey = requiredToolString(input.requestKey, "requestKey");
      const name = requiredToolString(input.name, "name");
      const configuration = requiredToolRecord(input.configuration, "configuration");
      const plan = planExperiment({
        configuration,
        inputSchema: (project.executionDescription as any).inputs?.schema,
        maxSamples: 500,
      });
      if (project.runMode !== "both" && project.runMode !== plan.configuration.runKind) {
        throw new ApiError(409, "run_kind_not_declared", "Experiment kind is not declared by this Project.");
      }
      const id = stableId("experiment", `${project.id}:${requestKey}`);
      const existing = this.store.experiments(project.id).find((candidate) => candidate.id === id);
      if (existing) {
        if (existing.name !== name
          || canonicalDigest(existing.configuration) !== plan.configurationDigest) {
          throw new ApiError(409, "idempotency_conflict", "Experiment request key was reused with different intent.");
        }
        return experimentMutationResult(existing, plan.sampleCount, "existing");
      }
      this.store.createExperiment({
        id,
        projectId: project.id,
        name,
        configuration: plan.configuration as unknown as Record<string, unknown>,
        createdAt: this.now(),
      });
      const created = this.store.experiments(project.id).find((candidate) => candidate.id === id)!;
      const result = experimentMutationResult(created, plan.sampleCount, "committed");
      this.#recordTurnAction(grant.turnId, Object.freeze({
        id: stableId("action", `${grant.turnId}:experiment_create:${id}`),
        actionKind: "experiment_configuration_create",
        permissionDecision: "allowed",
        state: "committed",
        errorCode: null,
        experimentConfigurationId: id,
        configurationDigest: result.configurationDigest,
        recordDigest: result.recordDigest,
        sampleCount: plan.sampleCount,
      }));
      return result;
    }
    if (tool === "riff_update_experiment_configuration") {
      requiredToolString(input.requestKey, "requestKey");
      const configurationId = requiredToolString(input.configurationId, "configurationId");
      const current = this.store.experiments(project.id)
        .find((candidate) => candidate.id === configurationId);
      if (!current) throw new ApiError(404, "experiment_not_found", "The scoped Experiment was not found.");
      if (requiredToolDigest(input.expectedConfigurationDigest, "expectedConfigurationDigest")
        !== canonicalDigest(current.configuration)
        || requiredToolDigest(input.expectedRecordDigest, "expectedRecordDigest")
          !== experimentRecordDigest(current)) {
        throw new ApiError(409, "stale_record_digest", "Experiment changed before update.");
      }
      const configuration = requiredToolRecord(input.configuration, "configuration");
      const plan = planExperiment({
        configuration,
        inputSchema: (project.executionDescription as any).inputs?.schema,
        maxSamples: 500,
      });
      if (project.runMode !== "both" && project.runMode !== plan.configuration.runKind) {
        throw new ApiError(409, "run_kind_not_declared", "Experiment kind is not declared by this Project.");
      }
      const name = input.name === undefined
        ? current.name : requiredToolString(input.name, "name");
      this.store.updateExperiment({
        id: current.id,
        projectId: project.id,
        name,
        configuration: plan.configuration as unknown as Record<string, unknown>,
        updatedAt: this.now(),
      });
      const updated = this.store.experiments(project.id)
        .find((candidate) => candidate.id === current.id)!;
      const result = experimentMutationResult(updated, plan.sampleCount, "committed");
      this.#recordTurnAction(grant.turnId, Object.freeze({
        id: stableId("action", `${grant.turnId}:experiment_update:${current.id}:${result.recordDigest}`),
        actionKind: "experiment_configuration_update",
        permissionDecision: "allowed",
        state: "committed",
        errorCode: null,
        experimentConfigurationId: current.id,
        configurationDigest: result.configurationDigest,
        recordDigest: result.recordDigest,
        sampleCount: plan.sampleCount,
      }));
      return result;
    }
    if (tool === "riff_list_runs") {
      return Object.freeze({
        runs: Object.freeze(this.store.runs(project.id).map((run) => {
          const completion = this.store.runCompletion(run.id);
          const plannedSampleCount = frozenConfigurationSampleCount(run.frozenConfiguration);
          return Object.freeze({
            runRef: run.id,
            runKind: run.runKind,
            status: run.status,
            sourceWorkspaceDigest: run.sourceWorkspaceDigest,
            plannedSampleCount,
            completedSampleCount: succeededRunSampleCount(
              run,
              completion?.completion ?? null,
              plannedSampleCount,
            ),
            completionDigest: completion?.digest ?? null,
            terminalCode: run.terminalCode,
            createdAt: run.createdAt,
            finishedAt: run.finishedAt,
          });
        })),
      });
    }
    if (tool === "riff_list_run_outputs") {
      const runRef = requiredToolString(input.runRef, "runRef");
      const run = scopedProjectRun(this.store, project.id, runRef);
      if (run.status !== "succeeded") {
        throw new ApiError(409, "run_outputs_unavailable", "Run outputs are available only after success.");
      }
      const limit = input.limit === undefined ? 50 : Number(input.limit);
      const afterOutputRef = typeof input.afterOutputRef === "string"
        ? input.afterOutputRef : null;
      const logicalName = typeof input.logicalName === "string" ? input.logicalName : null;
      const declaredRole = typeof input.declaredRole === "string" ? input.declaredRole : null;
      const all = this.store.runOutputs(run.id).filter((output) =>
        (!logicalName || output.logicalName === logicalName)
        && (!declaredRole || output.declaredRole === declaredRole));
      const afterIndex = afterOutputRef
        ? all.findIndex((output) => output.id === afterOutputRef) : -1;
      if (afterOutputRef && afterIndex < 0) {
        throw new ApiError(422, "invalid_output_cursor", "Run output cursor is not in this filtered result set.");
      }
      const includeText = input.includeText === true;
      const provenance = runOutputProvenance(this.store, run);
      const selected: typeof all = [];
      const outputs: Array<Record<string, unknown>> = [];
      let inlineBytes = 0;
      for (const output of all.slice(afterIndex + 1)) {
        if (selected.length >= limit) break;
        const textual = isTextualMediaType(output.mediaType);
        if (includeText && textual && inlineBytes >= MAX_INLINE_RUN_OUTPUT_BYTES
          && selected.length > 0) break;
        selected.push(output);
        const inline = includeText
          ? boundedInlineOutput(
            output.bytes,
            output.mediaType,
            Math.min(32 * 1024, MAX_INLINE_RUN_OUTPUT_BYTES - inlineBytes),
          ) : {};
        if ("text" in inline && typeof inline.text === "string") {
          inlineBytes += Buffer.byteLength(inline.text, "utf8");
        }
        outputs.push(Object.freeze({
          outputRef: output.id,
          logicalName: output.logicalName,
          sampleIndex: output.sampleIndex,
          sampleId: output.sampleId,
          mediaType: output.mediaType,
          declaredRole: output.declaredRole,
          sizeBytes: output.sizeBytes,
          sha256: output.sha256,
          ...inline,
        }));
      }
      if (includeText) {
        for (const output of outputs) {
          const textBytes = typeof output.text === "string"
            ? Buffer.byteLength(output.text, "utf8") : 0;
          if (textBytes < 1) continue;
          this.#recordTurnAction(grant.turnId, Object.freeze({
            id: stableId("action", `${grant.turnId}:output_list:${run.id}:${output.outputRef}`),
            actionKind: "run_output_read",
            permissionDecision: "allowed",
            state: "observed",
            errorCode: null,
            runId: run.id,
            sourceWorkspaceDigest: run.sourceWorkspaceDigest,
            outputRef: output.outputRef,
            logicalName: output.logicalName,
            mediaType: output.mediaType,
            declaredRole: output.declaredRole,
            sha256: output.sha256,
            sampleIndex: output.sampleIndex,
            sizeBytes: output.sizeBytes,
            textBytes,
            ...provenance,
            byteRange: Object.freeze({
              offset: 0,
              endOffset: textBytes,
              truncated: output.textTruncated,
            }),
          }));
        }
      }
      const hasMore = afterIndex + 1 + selected.length < all.length;
      return Object.freeze({
        runRef: run.id,
        sourceWorkspaceDigest: run.sourceWorkspaceDigest,
        ...provenance,
        matchedOutputCount: all.length,
        outputs: Object.freeze(outputs),
        nextOutputRef: hasMore ? selected.at(-1)?.id ?? null : null,
        hasMore,
        ...(includeText ? {
          inlineTextBytes: inlineBytes,
          inlineTextBudgetBytes: MAX_INLINE_RUN_OUTPUT_BYTES,
        } : {}),
      });
    }
    if (tool === "riff_summarize_run_outputs") {
      const runRef = requiredToolString(input.runRef, "runRef");
      const run = scopedProjectRun(this.store, project.id, runRef);
      if (run.status !== "succeeded") {
        throw new ApiError(409, "run_outputs_unavailable", "Run outputs are available only after success.");
      }
      const fields = requiredStatisticFields(input.fields);
      const quantiles = requiredStatisticQuantiles(input.quantiles);
      const logicalName = input.logicalName === undefined
        ? null : requiredToolString(input.logicalName, "logicalName");
      const provenance = runOutputProvenance(this.store, run);
      const summary = summarizeJsonOutputSeries({
        run,
        outputs: this.store.runOutputs(run.id),
        provenance,
        logicalName,
        fields,
        quantiles,
      });
      this.#recordTurnAction(grant.turnId, Object.freeze({
        id: stableId("action", `${grant.turnId}:output_statistics:${run.id}:${summary.statisticsDigest}`),
        actionKind: "run_output_statistics",
        permissionDecision: "allowed",
        state: "observed",
        errorCode: null,
        runId: run.id,
        sourceWorkspaceDigest: run.sourceWorkspaceDigest,
        completionDigest: summary.completionDigest,
        sampleCount: summary.sampleCount,
        samplePlanDigest: summary.samplePlanDigest,
        configurationDigest: summary.configurationDigest,
        logicalName: summary.logicalName,
        mediaType: summary.mediaType,
        declaredRole: summary.declaredRole,
        outputCount: summary.outputCount,
        totalInputBytes: summary.totalInputBytes,
        completeOutputCoverage: true,
        coveredSampleIndicesDigest: summary.coveredSampleIndicesDigest,
        outputSetDigest: summary.outputSetDigest,
        outputSha256Digest: summary.outputSha256Digest,
        fieldPointers: summary.statistics.map((statistic) => statistic.field),
        quantiles: summary.quantiles,
        quantileMethod: summary.quantileMethod,
        statisticsDigest: summary.statisticsDigest,
      }));
      return summary;
    }
    if (tool === "riff_read_run_output") {
      const runRef = requiredToolString(input.runRef, "runRef");
      const outputRef = requiredToolString(input.outputRef, "outputRef");
      const run = scopedProjectRun(this.store, project.id, runRef);
      if (run.status !== "succeeded") {
        throw new ApiError(409, "run_outputs_unavailable", "Run outputs are available only after success.");
      }
      const output = this.store.runOutputs(run.id).find((candidate) => candidate.id === outputRef);
      if (!output) throw new ApiError(404, "run_output_not_found", "The scoped Run output was not found.");
      assertTextualOutput(output.mediaType);
      const offset = input.offset === undefined ? 0 : Number(input.offset);
      const maxBytes = input.maxBytes === undefined ? 64 * 1024 : Number(input.maxBytes);
      if (offset > output.bytes.byteLength) {
        throw new ApiError(422, "invalid_output_offset", "Run output offset exceeds the output size.");
      }
      const page = utf8OutputPage(output.bytes, offset, maxBytes);
      const provenance = runOutputProvenance(this.store, run);
      const textBytes = Buffer.byteLength(page.text, "utf8");
      if (textBytes > 0) {
        this.#recordTurnAction(grant.turnId, Object.freeze({
          id: stableId("action", `${grant.turnId}:output_read:${run.id}:${output.id}:${offset}:${page.endOffset}`),
          actionKind: "run_output_read",
          permissionDecision: "allowed",
          state: "observed",
          errorCode: null,
          runId: run.id,
          sourceWorkspaceDigest: run.sourceWorkspaceDigest,
          outputRef: output.id,
          logicalName: output.logicalName,
          mediaType: output.mediaType,
          declaredRole: output.declaredRole,
          sha256: output.sha256,
          sampleIndex: output.sampleIndex,
          sizeBytes: output.sizeBytes,
          textBytes,
          ...provenance,
          byteRange: Object.freeze({ offset, endOffset: page.endOffset, truncated: page.truncated }),
        }));
      }
      return Object.freeze({
        runRef: run.id,
        sourceWorkspaceDigest: run.sourceWorkspaceDigest,
        ...provenance,
        outputRef: output.id,
        logicalName: output.logicalName,
        sampleIndex: output.sampleIndex,
        sampleId: output.sampleId,
        mediaType: output.mediaType,
        declaredRole: output.declaredRole,
        sha256: output.sha256,
        sizeBytes: output.sizeBytes,
        offset,
        text: page.text,
        nextOffset: page.truncated ? page.endOffset : null,
        truncated: page.truncated,
      });
    }
    if (tool === "riff_write_project_files") {
      const envelope = await this.operations.writeProjectFiles({
        commandId: stableId("project_write", `${project.id}:${requiredToolString(input.requestKey, "requestKey")}`),
        projectId: project.id,
        conversationId: grant.conversationId,
        turnId: grant.turnId,
        expectedWorkspaceDigest: requiredToolDigest(input.expectedWorkspaceDigest, "expectedWorkspaceDigest"),
        changes: requiredToolChanges(input.changes),
        ...(isRecord(input.executionDescription)
          ? { executionDescription: input.executionDescription } : {}),
        ...(input.runMode === "batch" || input.runMode === "visual" || input.runMode === "both"
          ? { runMode: input.runMode } : {}),
      });
      const result = envelope.result;
      this.#recordTurnAction(grant.turnId, Object.freeze({
        id: stableId("action", `${grant.turnId}:${result.receiptDigest}`),
        actionKind: "project_files_write",
        permissionDecision: "allowed",
        state: "committed",
        errorCode: null,
        mutationReceipt: result,
      }));
      return result;
    }
    if (tool === "riff_start_project_run") {
      const requestKey = requiredToolString(input.requestKey, "requestKey");
      const experimentConfigurationId = requiredToolString(
        input.experimentConfigurationId,
        "experimentConfigurationId",
      );
      const runKind = input.runKind === "batch" || input.runKind === "visual" ? input.runKind : null;
      if (!runKind) throw new ApiError(422, "invalid_run_kind", "Run kind must be batch or visual.");
      const currentProject = this.store.project(project.id);
      const experiment = this.store.experiments(project.id)
        .find((candidate) => candidate.id === experimentConfigurationId);
      if (!experiment) throw new ApiError(404, "experiment_not_found", "The scoped Experiment was not found.");
      const planned = planExperiment({
        configuration: experiment.configuration,
        inputSchema: (currentProject.executionDescription as any).inputs?.schema,
        maxSamples: 500,
      });
      if (planned.configuration.runKind !== runKind) {
        throw new ApiError(409, "run_kind_mismatch", "The Experiment configuration declares another Run kind.");
      }
      const admitted = this.operations.startRunAdmission({
        commandId: stableId("project_run", `${project.id}:${requestKey}`),
        projectId: project.id,
        experimentConfigurationId,
        runKind,
        expectedWorkspaceDigest: currentProject.workspaceDigest,
      });
      const action = Object.freeze({
        id: stableId("action", `${grant.turnId}:${admitted.runId}`),
        actionKind: "run_start",
        permissionDecision: "allowed",
        state: "committed",
        errorCode: null,
        runId: admitted.runId,
        runKind,
        sourceWorkspaceDigest: admitted.sourceWorkspaceDigest,
      });
      // Admission is durable before a runtime is asked to start. Record that
      // effect immediately so a later runtime or visual-health failure cannot
      // make the failed Turn look side-effect-free.
      this.#recordTurnAction(grant.turnId, action);
      try {
        if (runKind === "batch") {
          this.batchRuntime.start({ projectId: project.id, runId: admitted.runId });
        } else {
          await this.visualRuntime.start({ projectId: project.id, runId: admitted.runId });
        }
      } catch (error) {
        this.#replaceTurnAction(grant.turnId, action.id, Object.freeze({
          ...action,
          errorCode: errorCode(error),
        }));
        const failed = this.store.run(admitted.runId);
        if (["queued", "running", "cancelling"].includes(failed.status)) {
          this.store.failRunStart({
            id: admitted.runId,
            code: errorCode(error),
            diagnostic: safeDiagnostic(error),
            at: this.now(),
          });
        }
        throw error;
      }
      return Object.freeze({
        state: "started",
        runId: admitted.runId,
        runKind,
        status: this.store.run(admitted.runId).status,
        sourceWorkspaceDigest: admitted.sourceWorkspaceDigest,
      });
    }
    if (tool === "riff_cancel_run") {
      requiredToolString(input.requestKey, "requestKey");
      const runRef = requiredToolString(input.runRef, "runRef");
      const run = scopedProjectRun(this.store, project.id, runRef);
      if (run.runKind === "visual") {
        await this.visualRuntime.stop({ projectId: project.id, runId: run.id, at: this.now() });
      } else {
        await this.batchRuntime.cancel(project.id, run.id);
      }
      const terminal = this.store.run(run.id);
      const committed = run.status !== terminal.status;
      this.#recordTurnAction(grant.turnId, Object.freeze({
        id: stableId("action", `${grant.turnId}:run_cancel:${run.id}`),
        actionKind: "run_cancel",
        permissionDecision: "allowed",
        state: committed ? "committed" : "observed",
        errorCode: null,
        runId: run.id,
        runKind: run.runKind,
        status: terminal.status,
      }));
      return Object.freeze({
        state: committed ? "committed" : "already_terminal",
        runRef: run.id,
        runKind: run.runKind,
        status: terminal.status,
      });
    }
    if (tool === "riff_read_project_run_diagnostics") {
      const requested = typeof input.runRef === "string" ? input.runRef : null;
      const candidates = this.store.runs(project.id);
      const run = requested
        ? candidates.find((candidate) => candidate.id === requested)
        : [...candidates].reverse().find((candidate) => candidate.status !== "succeeded");
      if (!run) throw new ApiError(404, "run_diagnostics_not_found", "No scoped Run diagnostics are available.");
      const completion = this.store.runCompletion(run.id);
      return boundedRunDiagnostics(run, completion);
    }
    throw new ApiError(403, "project_tool_not_allowed", "That tool is not available in Project-only mode.");
  }

  #recordTurnAction(turnId: string, action: Record<string, unknown>): void {
    const actions = this.#turnActions.get(turnId);
    if (!actions) throw new ApiError(409, "project_turn_not_active", "The Project turn is no longer active.");
    actions.push(action);
  }

  #replaceTurnAction(
    turnId: string,
    actionId: string,
    replacement: Record<string, unknown>,
  ): void {
    const actions = this.#turnActions.get(turnId);
    if (!actions) throw new ApiError(409, "project_turn_not_active", "The Project turn is no longer active.");
    const index = actions.findIndex((action) => action.id === actionId);
    if (index < 0) throw new ApiError(409, "project_turn_action_missing", "The Project Turn action was not found.");
    actions[index] = replacement;
  }

  #failDirectTurn(
    turn: ProjectConversationTurnRecord,
    error: unknown,
  ): Readonly<{
    mode: "live";
    reason: string;
    turn: ProjectConversationTurnRecord;
    messages: readonly ProjectConversationMessageRecord[];
  }> {
    const code = errorCode(error);
    const actions = Object.freeze([...(this.#turnActions.get(turn.id) ?? [])]);
    const committed = actions.filter((action) => action.state === "committed");
    const filesCommitted = committed.filter((action) =>
      action.actionKind === "project_files_write").length;
    const experimentsCommitted = committed.filter((action) =>
      String(action.actionKind).startsWith("experiment_configuration_")).length;
    const admittedRuns = committed.filter((action) => action.actionKind === "run_start");
    const admittedRunIds = admittedRuns.flatMap((action) =>
      typeof action.runId === "string" ? [action.runId] : []);
    const committedSummary = [
      filesCommitted > 0 ? `${filesCommitted} 个 Project 文件提交` : null,
      experimentsCommitted > 0 ? `${experimentsCommitted} 个实验配置提交` : null,
      admittedRuns.length > 0
        ? `${admittedRuns.length} 个 Run 已接纳${admittedRunIds.length > 0
          ? `（${admittedRunIds.join("、")}）` : ""}`
        : null,
    ].filter(Boolean).join("、");
    const hasCommittedEffect = committed.length > 0;
    const failed = this.store.failConversationTurn({
      requestKey: turn.requestKey,
      state: "failed",
      code,
      assistantText: hasCommittedEffect
        ? `${committedSummary || `${committed.length} 个操作已提交`}${filesCommitted > 0 ? "；文件已保存" : ""}；本轮后续操作未完成（${code}）。`
        : `OpenCode 未能完成本轮操作（${code}）。`,
      actions,
      goalVerification: goalVerification({
        disposition: "failed",
        reasonCode: code,
        intentKind: admittedRuns.length > 0
          ? committed.find((action) => action.actionKind === "run_start")?.runKind === "visual"
            ? "project_visual" : "project_batch"
          : hasCommittedEffect ? "explicit_mutation" : "response_delivery",
        actions,
        affectedResourceCount: actions.length,
        partialEffect: hasCommittedEffect,
        openCodeTerminal: "unknown",
      }),
      failedAt: this.now(),
    });
    this.#turnActions.delete(turn.id);
    return Object.freeze({
      mode: "live",
      reason: code,
      turn: failed,
      messages: Object.freeze(this.store.conversationMessages(turn.conversationId)),
    });
  }

  runtime(conversationId: string): Record<string, unknown> {
    const conversation = this.store.conversation(conversationId);
    const turns = this.store.conversationTurns(conversationId);
    const active = [...turns].reverse().find((turn) => turn.state === "running") ?? null;
    const latest = turns.at(-1) ?? null;
    const parts = active ? [{
      id: `${active.id}_opencode`, kind: "mcp", state: "pending",
      title: "正在生成 Project 文件或调用仿真工具",
      summary: "Provider 可能仍在组织工具参数；请等待提交回执，不要因暂时无可见文本而取消。",
    }] : latest?.failureCode ? [{
      id: `${latest.id}_error`, kind: "error", state: "failed",
      title: "本轮未完成", summary: latest.failureCode,
    }] : [];
    return Object.freeze({
      schemaVersion: 1,
      revision: canonicalDigest({ conversation: conversation.updatedAt, turns: turns.map((turn) => [turn.id, turn.state, turn.updatedAt]) }),
      status: active ? "busy" : latest?.state === "failed" || latest?.state === "read_only" ? "failed" : "idle",
      activeTurn: active ? Object.freeze({ requestKey: active.requestKey, canStop: false, canRetry: false }) : null,
      parts: Object.freeze(parts.map(Object.freeze)),
      pendingInteractions: Object.freeze([]),
      goalVerification: latest?.goalVerification ?? null,
      agent: Object.freeze({ selectedName: active?.agentName ?? latest?.agentName ?? null, locked: Boolean(active) }),
      mcp: Object.freeze({ state: active ? "connected" : "disconnected", label: "Project scoped tools" }),
    });
  }

  async close(): Promise<void> {
    this.#mcp.revokeAll();
    await this.batchRuntime.close();
    await this.visualRuntime.close();
  }

  #materialize(project: ProjectRecord): OpenCodeWorkspaceBinding {
    const directory = join(this.store.root, "opencode-workspaces", project.id);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const files = this.store.projectFiles(project.id);
    removeStaleProjectionEntries(directory, new Set(files.map((file) => file.relativePath)));
    for (const file of files) {
      const path = join(directory, file.relativePath);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, file.bytes, { mode: 0o600 });
    }
    return Object.freeze({ owner: Object.freeze({ kind: "project", id: project.id }), directory });
  }

  #failReadOnly(turn: ProjectConversationTurnRecord, reason: string): Readonly<{
    mode: "read_only";
    reason: string;
    turn: ProjectConversationTurnRecord;
    messages: readonly ProjectConversationMessageRecord[];
  }> {
    const actions = Object.freeze([]);
    const verification = goalVerification({
      disposition: "read_only", reasonCode: safeReasonCode(reason),
      intentKind: "response_delivery",
      actions,
      affectedResourceCount: 0,
      partialEffect: false,
      openCodeTerminal: "not_reached",
    });
    const failed = this.store.failConversationTurn({
      requestKey: turn.requestKey,
      state: "read_only",
      code: safeReasonCode(reason),
      assistantText: "OpenCode 当前不可用；本轮没有写入 Project。",
      actions,
      goalVerification: verification,
      failedAt: this.now(),
    });
    this.#turnActions.delete(turn.id);
    return Object.freeze({
      mode: "read_only", reason: safeReasonCode(reason), turn: failed,
      messages: Object.freeze(this.store.conversationMessages(turn.conversationId)),
    });
  }
}

const projectToolSystemPrompt = (
  project: ProjectRecord,
  loadedSkills: readonly LoadedSimulationSkill[],
): string => `You are the modelling agent for exactly one Riff Project. Work from the user's natural-language request.
Use the scoped Riff tools to inspect authoritative files, write requested UTF-8 project artifacts, create or update Experiment configurations, start real Runs, read failed-Run diagnostics, and read receipt-indexed outputs from successful Runs. Return ordinary prose, not a structured delivery envelope.
Project files are changed only by riff_write_project_files. Its committed receipt is the sole authority that bytes were saved; never claim a file was saved unless that tool returned state=committed. The write is immediate, does not run syntax/dependency/smoke/technical checks, and does not create a revision.
Before writing, list the workspace and use the current workspace digest plus each affected file's current SHA-256. You may write files and then start a Run in the same turn; the Run must use the latest committed workspace. Do not retry a failed Run or modify files automatically. When the user asks to repair a failure, read the latest Run diagnostics and relevant files, then submit an explicit new write.
Create an Experiment explicitly when the user asks for a new visual, batch, multi-seed, or sweep experiment; update an existing one only with its current configuration and record digests. Use riff_start_project_run only with a committed Experiment configuration whose runKind matches. A real Run is the only executable-code verdict. A failed Run never rolls back Project files.
For a requested numeric analysis over JSON outputs, prefer riff_summarize_run_outputs with RFC 6901 field pointers; it integrity-checks and consumes one complete canonical JSON output for every frozen sample and returns mean, sample standard deviation, min, requested quantiles, max, and non-zero count. For non-numeric or qualitative analysis, list one successful Run's immutable outputs and completely read at least one canonical data, metric, table, or document text output for every frozen sample, following nextOffset until truncated=false. Diagnostic, replay, and visual projections do not count as analysis evidence. Bind every conclusion to the Run ID, source workspace digest, completion digest, sample-plan digest, configuration digest, output-set or output hashes digest, statistics digest when used, and sample count. Save an analysis file only when the user requests a persistent conclusion; that file is Project source, not an automatic system fact.
Keep tool-call payloads concise. Do not draft large source files inside hidden reasoning or prose. After workspace inspection, call riff_write_project_files promptly with one bounded artifact group: requirements first, executable runner and execution v2 next, then visual assets only if needed. Use later calls or turns for genuinely independent work, and rely on each committed receipt before proceeding.
Return an ordinary concise answer after tool work. Distinguish saved files, started Runs, terminal Run results, and analysis conclusions.
Current Project: ${project.name}; workspaceDigest=${project.workspaceDigest}; runMode=${project.runMode}.
${loadedSkillContextForTools(loadedSkills)}`;

const loadedSkillContextForTools = (loadedSkills: readonly LoadedSimulationSkill[]): string => loadedSkills.length > 0
  ? `The following Project-local skill instructions are loaded and may guide domain/model design. They do not replace Store authority:\n${loadedSkills.map((skill) => `BEGIN PROJECT SKILL (${skill.id}@${skill.version})\n${skill.instructions.slice(0, 16_000)}\nEND PROJECT SKILL`).join("\n")}`
  : "No Project-local skill instructions are loaded.";

const requiredToolString = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !value.trim() || value.length > 1_024) {
    throw new ApiError(422, "invalid_tool_input", `${label} is invalid.`);
  }
  return value;
};

const requiredToolDigest = (value: unknown, label: string): string => {
  const digest = requiredToolString(value, label);
  if (!/^[0-9a-f]{64}$/u.test(digest)) {
    throw new ApiError(422, "invalid_tool_input", `${label} is invalid.`);
  }
  return digest;
};

const requiredToolRecord = (
  value: unknown,
  label: string,
): Readonly<Record<string, unknown>> => {
  if (!isRecord(value)) {
    throw new ApiError(422, "invalid_tool_input", `${label} is invalid.`);
  }
  return value;
};

type ProjectExperimentRecord = ReturnType<ProjectOnlyStore["experiments"]>[number];

const experimentRecordDigest = (experiment: ProjectExperimentRecord): string =>
  canonicalDigest({
    id: experiment.id,
    name: experiment.name,
    configurationDigest: canonicalDigest(experiment.configuration),
    updatedAt: experiment.updatedAt,
  });

const experimentMutationResult = (
  experiment: ProjectExperimentRecord,
  sampleCount: number,
  state: "committed" | "existing",
) => Object.freeze({
  state,
  experimentConfigurationId: experiment.id,
  name: experiment.name,
  configuration: experiment.configuration,
  configurationDigest: canonicalDigest(experiment.configuration),
  recordDigest: experimentRecordDigest(experiment),
  sampleCount,
});

const scopedProjectRun = (
  store: ProjectOnlyStore,
  projectId: string,
  runRef: string,
): ProjectRunRecord => {
  const run = store.runs(projectId).find((candidate) => candidate.id === runRef);
  if (!run) throw new ApiError(404, "run_not_found", "The scoped Run was not found.");
  return run;
};

const frozenConfigurationSampleCount = (
  configuration: Readonly<Record<string, unknown>>,
): number | null => {
  if (configuration.schemaVersion !== 1 || !isRecord(configuration.sampling)) return null;
  const sampling = configuration.sampling;
  if (sampling.kind === "single") return 1;
  if (sampling.kind === "multiple-seeds") {
    return Array.isArray(sampling.seeds) && sampling.seeds.length > 0
      && Number.isSafeInteger(sampling.seeds.length)
      ? sampling.seeds.length : null;
  }
  if (sampling.kind !== "cartesian-sweep"
    || !Array.isArray(sampling.axes) || sampling.axes.length < 1) return null;
  let count = 1;
  for (const rawAxis of sampling.axes) {
    if (!isRecord(rawAxis) || !Array.isArray(rawAxis.values) || rawAxis.values.length < 1) {
      return null;
    }
    count *= rawAxis.values.length;
    if (!Number.isSafeInteger(count)) return null;
  }
  if (Object.hasOwn(sampling, "seeds")) {
    if (!Array.isArray(sampling.seeds) || sampling.seeds.length < 1) return null;
    count *= sampling.seeds.length;
  }
  return Number.isSafeInteger(count) && count > 0 ? count : null;
};

const succeededRunSampleCount = (
  run: ProjectRunRecord,
  completion: Readonly<Record<string, unknown>> | null,
  plannedSampleCount: number | null,
): number | null => {
  if (run.status !== "succeeded" || completion?.status !== "succeeded") return null;
  const completed = completion.sampleCount;
  return Number.isSafeInteger(completed) && Number(completed) > 0
    && completed === plannedSampleCount
    ? Number(completed) : null;
};

const runOutputProvenance = (
  store: ProjectOnlyStore,
  run: ProjectRunRecord,
): Readonly<{
  completionDigest: string;
  sampleCount: number | null;
  samplePlanDigest: string | null;
  configurationDigest: string | null;
}> => {
  const completion = store.runCompletion(run.id);
  if (!completion) {
    throw new ApiError(409, "run_completion_unavailable", "Successful Run completion evidence is missing.");
  }
  const record = completion.completion;
  return Object.freeze({
    completionDigest: completion.digest,
    sampleCount: Number.isSafeInteger(record.sampleCount) ? Number(record.sampleCount) : null,
    samplePlanDigest: typeof record.samplePlanDigest === "string"
      ? record.samplePlanDigest : null,
    configurationDigest: typeof record.configurationDigest === "string"
      ? record.configurationDigest : null,
  });
};

const requiredStatisticFields = (value: unknown): readonly string[] => {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32
    || value.some((field) => typeof field !== "string"
      || Buffer.byteLength(field, "utf8") > 1_024
      || !/^\/(?:[^~]|~[01])*$/u.test(field))
    || new Set(value).size !== value.length) {
    throw new ApiError(422, "invalid_tool_input", "fields must be distinct RFC 6901 JSON Pointers.");
  }
  return Object.freeze([...value] as string[]);
};

const requiredStatisticQuantiles = (value: unknown): readonly number[] => {
  if (value === undefined) return DEFAULT_RUN_OUTPUT_QUANTILES;
  if (!Array.isArray(value) || value.length < 1 || value.length > 9
    || value.some((quantile) => typeof quantile !== "number"
      || !Number.isFinite(quantile) || quantile < 0 || quantile > 1)
    || new Set(value).size !== value.length) {
    throw new ApiError(422, "invalid_tool_input", "quantiles must be distinct finite probabilities from 0 through 1.");
  }
  return Object.freeze([...value] as number[]);
};

type RunOutputProvenance = ReturnType<typeof runOutputProvenance>;

type RunOutputStatistic = Readonly<{
  field: string;
  count: number;
  mean: number;
  sampleStdDev: number | null;
  min: number;
  quantiles: readonly Readonly<{ probability: number; value: number }>[];
  max: number;
  nonZeroCount: number;
}>;

type RunOutputStatisticsSummary = Readonly<{
  schemaVersion: 1;
  runRef: string;
  sourceWorkspaceDigest: string;
  completionDigest: string;
  sampleCount: number;
  samplePlanDigest: string;
  configurationDigest: string;
  logicalName: string;
  mediaType: string;
  declaredRole: string;
  outputCount: number;
  totalInputBytes: number;
  completeOutputCoverage: true;
  coveredSampleIndicesDigest: string;
  outputSetDigest: string;
  outputSha256Digest: string;
  outputSha256BySample: readonly string[];
  quantileMethod: "linear_type_7";
  quantiles: readonly number[];
  statistics: readonly RunOutputStatistic[];
  statisticsDigest: string;
}>;

export const summarizeJsonOutputSeries = (input: Readonly<{
  run: ProjectRunRecord;
  outputs: readonly ProjectRunOutputRecord[];
  provenance: RunOutputProvenance;
  logicalName: string | null;
  fields: readonly string[];
  quantiles: readonly number[];
}>): RunOutputStatisticsSummary => {
  const sampleCount = input.provenance.sampleCount;
  if (!Number.isSafeInteger(sampleCount) || Number(sampleCount) < 1
    || !SHA256_PATTERN.test(input.run.sourceWorkspaceDigest)
    || !SHA256_PATTERN.test(input.provenance.completionDigest)
    || typeof input.provenance.samplePlanDigest !== "string"
    || !SHA256_PATTERN.test(input.provenance.samplePlanDigest)
    || typeof input.provenance.configurationDigest !== "string"
    || !SHA256_PATTERN.test(input.provenance.configurationDigest)) {
    throw new ApiError(409, "run_completion_unavailable", "Successful Run provenance is incomplete.");
  }
  const eligible = input.outputs.filter((output) =>
    ANALYSIS_OUTPUT_ROLES.has(output.declaredRole) && isJsonMediaType(output.mediaType));
  const candidateNames = [...new Set(eligible.map((output) => output.logicalName))];
  const logicalName = input.logicalName ?? (candidateNames.length === 1 ? candidateNames[0]! : null);
  if (!logicalName) {
    throw new ApiError(
      422,
      "invalid_tool_input",
      "logicalName is required unless the Run has exactly one analysis-suitable JSON output series.",
    );
  }
  const selected = input.outputs.filter((output) => output.logicalName === logicalName)
    .sort((left, right) => left.sampleIndex - right.sampleIndex || left.id.localeCompare(right.id, "en"));
  if (selected.length !== sampleCount
    || selected.some((output, index) => output.sampleIndex !== index)
    || selected.some((output) => !ANALYSIS_OUTPUT_ROLES.has(output.declaredRole)
      || !isJsonMediaType(output.mediaType))) {
    throw new ApiError(
      422,
      "invalid_tool_input",
      "logicalName must identify one complete analysis-suitable JSON output for every frozen sample.",
    );
  }
  const mediaType = selected[0]!.mediaType;
  const declaredRole = selected[0]!.declaredRole;
  if (selected.some((output) => output.mediaType !== mediaType
    || output.declaredRole !== declaredRole)) {
    throw new ApiError(422, "invalid_tool_input", "The selected output series has inconsistent declarations.");
  }
  const totalInputBytes = selected.reduce((total, output) => total + output.bytes.byteLength, 0);
  if (selected.some((output) => output.bytes.byteLength < 1
      || output.bytes.byteLength > MAX_STATISTIC_OUTPUT_BYTES)
    || totalInputBytes > MAX_STATISTIC_RUN_BYTES) {
    throw new ApiError(
      422,
      "invalid_tool_input",
      "The selected JSON outputs cannot be summarized completely within the bounded byte contract; use paged reads.",
    );
  }
  const values = new Map(input.fields.map((field) => [field, [] as number[]]));
  const outputBindings: Array<Record<string, unknown>> = [];
  for (const output of selected) {
    const digest = createHash("sha256").update(output.bytes).digest("hex");
    if (output.sizeBytes !== output.bytes.byteLength || output.sha256 !== digest
      || !SHA256_PATTERN.test(output.sha256)) {
      throw new ApiError(409, "run_output_integrity_failed", "A frozen Run output failed its byte integrity check.");
    }
    const page = utf8OutputPage(output.bytes, 0, output.bytes.byteLength);
    if (page.truncated || page.endOffset !== output.sizeBytes) {
      throw new ApiError(422, "invalid_tool_input", "The selected JSON output is truncated.");
    }
    let document: unknown;
    try {
      document = JSON.parse(page.text) as unknown;
    } catch {
      throw new ApiError(422, "invalid_tool_input", "Every selected output must be one complete valid JSON document.");
    }
    for (const field of input.fields) {
      const value = resolveJsonPointer(document, field);
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new ApiError(
          422,
          "invalid_tool_input",
          `Field ${field} must resolve to a finite JSON number in every frozen sample.`,
        );
      }
      values.get(field)!.push(value);
    }
    outputBindings.push(Object.freeze({
      sampleIndex: output.sampleIndex,
      sampleId: output.sampleId,
      outputRef: output.id,
      logicalName: output.logicalName,
      relativePath: output.relativePath,
      mediaType: output.mediaType,
      declaredRole: output.declaredRole,
      sizeBytes: output.sizeBytes,
      sha256: output.sha256,
    }));
  }
  const statistics = Object.freeze(input.fields.map((field) =>
    summarizeNumericValues(field, values.get(field)!, input.quantiles)));
  const coveredSampleIndicesDigest = canonicalDigest(selected.map((output) => output.sampleIndex));
  const outputSha256BySample = Object.freeze(selected.map((output) => output.sha256));
  const outputSha256Digest = canonicalDigest(outputSha256BySample);
  const outputSetDigest = canonicalDigest({
    schemaVersion: 1,
    runRef: input.run.id,
    sourceWorkspaceDigest: input.run.sourceWorkspaceDigest,
    completionDigest: input.provenance.completionDigest,
    samplePlanDigest: input.provenance.samplePlanDigest,
    configurationDigest: input.provenance.configurationDigest,
    outputs: outputBindings,
  });
  const quantileMethod = "linear_type_7" as const;
  const statisticsDigest = canonicalDigest({
    schemaVersion: 1,
    outputSetDigest,
    fields: input.fields,
    quantiles: input.quantiles,
    quantileMethod,
    statistics,
  });
  return Object.freeze({
    schemaVersion: 1,
    runRef: input.run.id,
    sourceWorkspaceDigest: input.run.sourceWorkspaceDigest,
    completionDigest: input.provenance.completionDigest,
    sampleCount,
    samplePlanDigest: input.provenance.samplePlanDigest,
    configurationDigest: input.provenance.configurationDigest,
    logicalName,
    mediaType,
    declaredRole,
    outputCount: selected.length,
    totalInputBytes,
    completeOutputCoverage: true,
    coveredSampleIndicesDigest,
    outputSetDigest,
    outputSha256Digest,
    outputSha256BySample,
    quantileMethod,
    quantiles: Object.freeze([...input.quantiles]),
    statistics,
    statisticsDigest,
  });
};

const isJsonMediaType = (mediaType: string): boolean => {
  const essence = mediaType.split(";", 1)[0]!.trim().toLowerCase();
  return essence === "application/json" || essence.endsWith("+json");
};

const resolveJsonPointer = (document: unknown, pointer: string): unknown => {
  let current = document;
  for (const encoded of pointer.slice(1).split("/")) {
    const token = encoded.replace(/~1/gu, "/").replace(/~0/gu, "~");
    if ((typeof current !== "object" || current === null)
      || !Object.prototype.hasOwnProperty.call(current, token)) return undefined;
    current = (current as Record<string, unknown>)[token];
  }
  return current;
};

const summarizeNumericValues = (
  field: string,
  values: readonly number[],
  probabilities: readonly number[],
): RunOutputStatistic => {
  const scale = values.reduce((maximum, value) => Math.max(maximum, Math.abs(value)), 0);
  const normalizedMean = scale === 0
    ? 0 : values.reduce((sum, value) => sum + value / scale, 0) / values.length;
  const mean = finiteStatistic(scale === 0 ? 0 : scale * normalizedMean);
  const squaredDeviation = scale === 0 ? 0 : values.reduce((sum, value) => {
    const deviation = value / scale - normalizedMean;
    return sum + deviation * deviation;
  }, 0);
  const sampleStdDev = values.length < 2 ? null
    : finiteStatistic(scale * Math.sqrt(squaredDeviation / (values.length - 1)));
  const sorted = [...values].sort((left, right) => left - right);
  const quantiles = Object.freeze(probabilities.map((probability) => Object.freeze({
    probability,
    value: finiteStatistic(linearType7Quantile(sorted, probability)),
  })));
  return Object.freeze({
    field,
    count: values.length,
    mean,
    sampleStdDev,
    min: finiteStatistic(sorted[0]!),
    quantiles,
    max: finiteStatistic(sorted.at(-1)!),
    nonZeroCount: values.filter((value) => value !== 0).length,
  });
};

const linearType7Quantile = (sorted: readonly number[], probability: number): number => {
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower]!;
  const fraction = position - lower;
  return sorted[lower]! * (1 - fraction) + sorted[upper]! * fraction;
};

const finiteStatistic = (value: number): number => {
  if (!Number.isFinite(value)) {
    throw new ApiError(422, "invalid_tool_input", "The selected numeric range cannot be summarized as finite IEEE-754 statistics.");
  }
  return Object.is(value, -0) ? 0 : value;
};

const isTextualMediaType = (mediaType: string): boolean =>
  mediaType.startsWith("text/")
  || mediaType === "application/json"
  || mediaType.endsWith("+json")
  || mediaType === "application/x-ndjson";

const assertTextualOutput = (mediaType: string): void => {
  if (!isTextualMediaType(mediaType)) {
    throw new ApiError(415, "run_output_not_text", "Only textual Run outputs can be read by the Agent.");
  }
};

const utf8OutputPage = (
  bytes: Buffer,
  offset: number,
  maximumBytes: number,
): Readonly<{ text: string; endOffset: number; truncated: boolean }> => {
  const requestedEnd = Math.min(bytes.byteLength, offset + maximumBytes);
  let end = requestedEnd;
  while (end > offset && end < bytes.byteLength && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  if (end === offset && requestedEnd > offset) {
    end = requestedEnd;
    while (end < bytes.byteLength && (bytes[end]! & 0xc0) === 0x80) end += 1;
  }
  const page = bytes.subarray(offset, end).toString("utf8");
  if (Buffer.from(page, "utf8").byteLength !== end - offset) {
    throw new ApiError(422, "run_output_invalid_utf8", "The textual Run output is not valid UTF-8.");
  }
  return Object.freeze({ text: page, endOffset: end, truncated: end < bytes.byteLength });
};

const boundedInlineOutput = (
  bytes: Buffer,
  mediaType: string,
  maxBytes: number,
): Readonly<{ text: string | null; textTruncated: boolean }> => {
  if (!isTextualMediaType(mediaType)) return Object.freeze({ text: null, textTruncated: false });
  if (maxBytes < 1) return Object.freeze({ text: "", textTruncated: bytes.byteLength > 0 });
  const page = utf8OutputPage(bytes, 0, maxBytes);
  return Object.freeze({ text: page.text, textTruncated: page.truncated });
};

type RequestedEvidenceKind = "file_write" | "experiment" | "run" | "cancel" | "analysis";

const projectTurnImplicitToolBudgets = (
  text: string,
): ReadonlyMap<AgentToolName, number> => {
  if (isReadOnlyProjectTurn(text)) return new Map();
  const evidence = new Set(requestedEvidenceKinds(text));
  const entries: Array<readonly [AgentToolName, number]> = [];
  if (evidence.has("file_write")) {
    // One staged modelling request may commit source and a later requested
    // analysis document, but cannot write indefinitely from one bearer.
    entries.push(["riff_write_project_files", 2]);
  }
  if (evidence.has("experiment")) {
    const create = hasExperimentCreateIntent(text);
    const update = hasExperimentUpdateIntent(text);
    if (create || !update) entries.push(["riff_create_experiment_configuration", 2]);
    if (update || !create) entries.push(["riff_update_experiment_configuration", 1]);
  }
  if (evidence.has("run")) entries.push(["riff_start_project_run", 2]);
  if (evidence.has("cancel")) {
    entries.push(["riff_cancel_run", 1]);
  }
  return new Map(entries);
};

type ProjectFilePathAuthority = Readonly<{
  kind: "exact" | "prefix";
  normalizedPath: string;
}>;

const PROJECT_PATH_SEGMENT = String.raw`[A-Za-z0-9_-](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?`;
const EXPLICIT_PROJECT_PATH = new RegExp(
  String.raw`(?:^|[^A-Za-z0-9._/:-])(${PROJECT_PATH_SEGMENT}(?:/${PROJECT_PATH_SEGMENT})*/|${PROJECT_PATH_SEGMENT}(?:/${PROJECT_PATH_SEGMENT})+|${PROJECT_PATH_SEGMENT}\.(?:md|py|txt|html?|json|ya?ml|csv|tsv|js|mjs|cjs|ts|tsx|jsx|toml|ini|cfg|sh))(?=$|[^A-Za-z0-9._/-])`,
  "giu",
);

/**
 * Natural-language turns that name Project paths receive only those exact
 * paths (or an explicitly trailing-slash directory family). A turn without a
 * path stays broadly scoped because complete model requests legitimately need
 * several server-validated artifact families.
 */
const requestedProjectFilePathAuthority = (
  text: string,
): readonly ProjectFilePathAuthority[] | null => {
  const authorities = new Map<string, ProjectFilePathAuthority>();
  for (const match of text.matchAll(EXPLICIT_PROJECT_PATH)) {
    const requested = match[1];
    const requestedIndex = (match.index ?? 0) + match[0].lastIndexOf(requested ?? "");
    if (!requested || !isExplicitProjectPathTarget(
      text,
      requestedIndex,
      requestedIndex + requested.length,
    )) continue;
    const normalized = requested.normalize("NFC").toLocaleLowerCase("en-US");
    const authority = Object.freeze({
      kind: normalized.endsWith("/") ? "prefix" as const : "exact" as const,
      normalizedPath: normalized,
    });
    authorities.set(`${authority.kind}:${authority.normalizedPath}`, authority);
  }
  if (authorities.size === 0) return null;
  const prefixes = [...authorities.values()].filter((authority) => authority.kind === "prefix");
  return Object.freeze([...authorities.values()]
    .filter((authority) => authority.kind === "prefix"
      || !prefixes.some((prefix) => authority.normalizedPath.startsWith(prefix.normalizedPath)))
    .sort((left, right) => left.normalizedPath.localeCompare(right.normalizedPath, "en")));
};

const PROJECT_PATH_MUTATION = /(?:写入|保存|提交|落盘|形成|生成|创建|建立|修改|更新|修复|补齐|实现|覆盖|改写|删除|移除)|\b(?:write|save|commit|create|update|fix|implement|overwrite|delete|remove)\b/giu;

const isExplicitProjectPathTarget = (
  text: string,
  start: number,
  end: number,
): boolean => {
  const clauseStart = Math.max(
    text.lastIndexOf("。", start - 1),
    text.lastIndexOf("；", start - 1),
    text.lastIndexOf(";", start - 1),
    text.lastIndexOf("!", start - 1),
    text.lastIndexOf("！", start - 1),
    text.lastIndexOf("?", start - 1),
    text.lastIndexOf("？", start - 1),
    text.lastIndexOf("\n", start - 1),
  ) + 1;
  const beforeStart = Math.max(clauseStart, start - 160);
  const before = text.slice(beforeStart, start);
  const preceding = [...before.matchAll(PROJECT_PATH_MUTATION)].at(-1);
  if (preceding) {
    const mutationIndex = beforeStart + (preceding.index ?? 0);
    if (!isIntentMatchNegated(text, mutationIndex)) return true;
  }

  const following = text.slice(end, Math.min(text.length, end + 48));
  const followingClause = following.split(/[。；;.!?！？\r\n]/u, 1)[0] ?? "";
  const subsequent = followingClause.match(/^\s*(?:(?:需要|应当|应|必须|请)\s*)?(?:被\s*)?(?:写入|保存|提交|落盘|形成|生成|创建|建立|修改|更新|修复|补齐|实现|覆盖|改写|删除|移除|\b(?:write|save|commit|create|update|fix|implement|overwrite|delete|remove)\b)/iu);
  if (!subsequent) return false;
  return !isIntentMatchNegated(text, end + (subsequent.index ?? 0));
};

const requestedEvidenceKinds = (text: string): readonly RequestedEvidenceKind[] => {
  if (isReadOnlyProjectTurn(text)) return Object.freeze([]);
  const requested = new Set<RequestedEvidenceKind>();
  if (hasUnnegatedIntent(text, /(?:保存|写入|创建|建立|生成|修改|更新|修复|补齐|实现|落盘|形成).{0,24}(?:需求|模型|代码|文件|入口|可视化(?!实验|experiment)|仿真(?!实验|experiment)|visual(?!\s*experiment)|project|项目)|(?:保存|写入|提交|落盘|形成).{0,24}(?:requirements|code|environment|analysis)\/[A-Za-z0-9._/-]+|(?:从|以).{0,12}(?:空白|新建).{0,12}(?:project|项目).{0,40}(?:需求|模型|仿真|可视化)|(?:requirements|model|code|file|entrypoint|visual).{0,24}(?:save|write|create|update|fix|implement)|riff_write_project_files/iu)) {
    requested.add("file_write");
  }
  if (hasExperimentCreateIntent(text) || hasExperimentUpdateIntent(text)) {
    requested.add("experiment");
  }
  if (hasProjectRunStartIntent(text)
    || hasUnnegatedIntent(text, /(?:完整使用流程|完整.{0,8}流程)/u)
      && /(?:仿真|模拟|实验)/u.test(text)
      && /(?:分析|结论)/u.test(text)) {
    requested.add("run");
  }
  if (hasProjectRunCancelIntent(text)) {
    requested.add("cancel");
  }
  if (hasUnnegatedIntent(text, /(?:分析|结论|汇总|统计|比较|洞察)|(?:analy[sz]e|analysis|conclusion|summari[sz]e|statistics)/iu)) {
    requested.add("analysis");
  }
  return Object.freeze([...requested]);
};

const hasExperimentCreateIntent = (text: string): boolean =>
  hasUnnegatedIntent(text, /(?:创建|建立|新增|生成)[^，。；,.!?！？\r\n]{0,20}(?:实验|\bexperiment\b)|\b(?:create|add)\b[^，。；,.!?！？\r\n]{0,20}\bexperiment\b/iu);

const hasExperimentUpdateIntent = (text: string): boolean =>
  hasUnnegatedIntent(text, /(?:修改|更新|调整|重配|配置|保存)[^，。；,.!?！？\r\n]{0,20}(?:实验|\bexperiment\b)|(?:实验|\bexperiment\b)[^，。；,.!?！？\r\n]{0,20}(?:修改|更新|调整|重配|保存)|\b(?:update|modify|reconfigure|configure|save)\b[^，。；,.!?！？\r\n]{0,20}\bexperiment\b|\bexperiment\b[^，。；,.!?！？\r\n]{0,20}\b(?:update|modify|reconfigure|configure|save)\b/iu);

const hasProjectRunStartIntent = (text: string): boolean => {
  return hasUnnegatedIntent(text, /(?:启动|开始).{0,20}(?:run|仿真|模拟|实验|样本)|(?:重新运行|重跑|跑一次|运行批量|执行仿真|执行模拟)|\b(?:start|rerun|launch|execute)\b.{0,20}\b(?:simulation|experiment|run|batch)\b|\b(?:please\s+)?run\b\s+(?:(?:a|an|the|this|new|another)\s+)?(?:simulation|experiment|batch)\b|\brun\s+again\b/iu);
};

const hasProjectRunCancelIntent = (text: string): boolean =>
  hasUnnegatedIntent(text, /(?:取消|停止|终止|中止).{0,20}(?:run|运行|仿真|模拟|实验)|(?:cancel|stop|terminate|abort).{0,20}(?:run|simulation|experiment)/iu);

const hasUnnegatedIntent = (text: string, pattern: RegExp): boolean => {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  for (const match of text.matchAll(new RegExp(pattern.source, flags))) {
    if (!isIntentMatchNegated(text, match.index ?? 0)) {
      return true;
    }
  }
  return false;
};

const isIntentMatchNegated = (text: string, index: number): boolean => {
  const prefix = text.slice(Math.max(0, index - 32), index);
  if (/(?:不(?!仅|但|只)(?:需要|要|需|再|得)?|无需|禁止|请勿|别|do not|don't|without|no need to)[^，。；,.!?！？、\r\n]{0,20}$/iu.test(prefix)) {
    return true;
  }
  const coordinatedPrefix = text.slice(Math.max(0, index - 96), index);
  return /(?:不(?!仅|但|只)(?:需要|要|需|再|得)?|无需|禁止|请勿|别|do not|don't|without|no need to)\s*(?:启动|开始|运行|重新运行|重跑|取消|停止|终止|中止|创建|建立|生成|写入|保存|修改|更新|start|run|rerun|cancel|stop|terminate|abort|create|write|save|modify|update)(?:\s*(?:、|或|和|以及|\/|,\s*(?:and|or)?|\b(?:and|or)\b)\s*(?:启动|开始|运行|重新运行|重跑|取消|停止|终止|中止|创建|建立|生成|写入|保存|修改|更新|start|run|rerun|cancel|stop|terminate|abort|create|write|save|modify|update))*\s*(?:、|或|和|以及|\/|,\s*(?:and|or)?|\b(?:and|or)\b)\s*$/iu.test(coordinatedPrefix);
};

const isReadOnlyProjectTurn = (text: string): boolean => {
  const diagnosticQuestion = /(?:为什么|为何|原因|怎么回事|是否|能否|可以吗|解释|说明|诊断|查看|读取|分析).{0,32}(?:失败|错误|问题|状态|结果|原因|吗|？|\?)|(?:why|explain|diagnos|inspect|read|what happened|can you).{0,40}(?:fail|error|problem|status|result|why|\?)/iu.test(text);
  const explicitRemediation = hasUnnegatedIntent(text, /(?:修复|补齐|改正|重新运行|重跑|再次运行|然后启动|并启动|请启动|开始运行|修改(?:模型|代码|文件)|更新(?:模型|代码|文件))|(?:fix|repair|then start|rerun|run again|update (?:the )?(?:model|code|file))/iu);
  return diagnosticQuestion && !explicitRemediation
    && /[?？]|(?:为什么|为何|原因|解释|诊断|查看|读取)/u.test(text);
};

const satisfiedEvidenceKinds = (
  actions: readonly Record<string, unknown>[],
): ReadonlySet<RequestedEvidenceKind> => {
  const satisfied = new Set<RequestedEvidenceKind>();
  if (actions.some((action) => action.actionKind === "project_files_write"
    && action.state === "committed")) {
    satisfied.add("file_write");
  }
  if (actions.some((action) => [
    "experiment_configuration_create", "experiment_configuration_update",
  ].includes(String(action.actionKind)) && action.state === "committed")) {
    satisfied.add("experiment");
  }
  if (actions.some((action) => action.actionKind === "run_start"
    && action.state === "committed")) {
    satisfied.add("run");
  }
  if (actions.some((action) => action.actionKind === "run_cancel"
    && (action.state === "committed" || action.state === "observed"))) {
    satisfied.add("cancel");
  }
  // Analysis is evidence-backed only when the turn completely read at least
  // one canonical, analysis-suitable output for every frozen sample.
  // Persisting a conclusion additionally satisfies ordinary file-write
  // evidence above.
  if (analysisEvidenceSatisfied(actions)) {
    satisfied.add("analysis");
  }
  return satisfied;
};

const analysisEvidenceSatisfied = (
  actions: readonly Record<string, unknown>[],
): boolean => {
  // The statistics path preserves the complete-output standard: the server
  // parsed and integrity-checked exactly one canonical JSON document for
  // every frozen sample before recording this observation. Raw paged reads
  // below remain the independent evidence path for non-numeric analysis.
  if (actions.some(isCompleteRunOutputStatisticsObservation)) return true;
  const reads = actions.filter(isCanonicalAnalysisOutputRead);
  const byRun = new Map<string, Record<string, unknown>[]>();
  for (const read of reads) {
    const runId = String(read.runId);
    const group = byRun.get(runId) ?? [];
    group.push(read);
    byRun.set(runId, group);
  }
  for (const group of byRun.values()) {
    const sampleCount = Number(group[0]!.sampleCount);
    if (group.some((read) => Number(read.sampleCount) !== sampleCount
      || read.completionDigest !== group[0]!.completionDigest
      || read.sourceWorkspaceDigest !== group[0]!.sourceWorkspaceDigest
      || read.samplePlanDigest !== group[0]!.samplePlanDigest
      || read.configurationDigest !== group[0]!.configurationDigest)) continue;
    const completedSamples = new Set<number>();
    const byOutput = new Map<string, Record<string, unknown>[]>();
    for (const read of group) {
      const key = `${read.sampleIndex}:${read.outputRef}`;
      const outputReads = byOutput.get(key) ?? [];
      outputReads.push(read);
      byOutput.set(key, outputReads);
    }
    for (const outputReads of byOutput.values()) {
      if (completeCanonicalOutputRead(outputReads)) {
        completedSamples.add(Number(outputReads[0]!.sampleIndex));
      }
    }
    if (completedSamples.size === sampleCount
      && [...completedSamples].every((index) => index >= 0 && index < sampleCount)) return true;
  }
  return false;
};

const ANALYSIS_OUTPUT_ROLES = new Set(["data", "metric", "table", "document"]);
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

const isCompleteRunOutputStatisticsObservation = (
  action: Record<string, unknown>,
): boolean => {
  const sampleCount = Number(action.sampleCount);
  return action.actionKind === "run_output_statistics"
    && action.state === "observed"
    && typeof action.runId === "string"
    && typeof action.logicalName === "string"
    && Boolean(action.logicalName)
    && typeof action.mediaType === "string"
    && isJsonMediaType(action.mediaType)
    && typeof action.declaredRole === "string"
    && ANALYSIS_OUTPUT_ROLES.has(action.declaredRole)
    && Number.isSafeInteger(sampleCount)
    && sampleCount > 0
    && action.outputCount === sampleCount
    && Number.isSafeInteger(action.totalInputBytes)
    && Number(action.totalInputBytes) > 0
    && Number(action.totalInputBytes) <= MAX_STATISTIC_RUN_BYTES
    && action.completeOutputCoverage === true
    && action.coveredSampleIndicesDigest === canonicalDigest(
      Array.from({ length: sampleCount }, (_unused, index) => index),
    )
    && typeof action.fieldPointers !== "undefined"
    && Array.isArray(action.fieldPointers)
    && action.fieldPointers.length > 0
    && action.fieldPointers.length <= 32
    && action.fieldPointers.every((field) => typeof field === "string"
      && /^\/(?:[^~]|~[01])*$/u.test(field))
    && Array.isArray(action.quantiles)
    && action.quantiles.length > 0
    && action.quantiles.every((quantile) => typeof quantile === "number"
      && Number.isFinite(quantile) && quantile >= 0 && quantile <= 1)
    && action.quantileMethod === "linear_type_7"
    && [
      action.completionDigest,
      action.sourceWorkspaceDigest,
      action.samplePlanDigest,
      action.configurationDigest,
      action.outputSetDigest,
      action.outputSha256Digest,
      action.statisticsDigest,
    ].every((digest) => typeof digest === "string" && SHA256_PATTERN.test(digest));
};

const isCanonicalAnalysisOutputRead = (
  action: Record<string, unknown>,
): boolean => {
  if (action.actionKind !== "run_output_read"
    || action.state !== "observed"
    || typeof action.runId !== "string"
    || typeof action.outputRef !== "string"
    || typeof action.logicalName !== "string"
    || typeof action.mediaType !== "string"
    || !isTextualMediaType(action.mediaType)
    || typeof action.declaredRole !== "string"
    || !ANALYSIS_OUTPUT_ROLES.has(action.declaredRole)
    || typeof action.sha256 !== "string"
    || !SHA256_PATTERN.test(action.sha256)
    || !Number.isSafeInteger(action.sampleIndex)
    || Number(action.sampleIndex) < 0
    || !Number.isSafeInteger(action.sampleCount)
    || Number(action.sampleCount) < 1
    || !Number.isSafeInteger(action.sizeBytes)
    || Number(action.sizeBytes) < 1
    || !Number.isSafeInteger(action.textBytes)
    || Number(action.textBytes) < 1
    || typeof action.completionDigest !== "string"
    || !SHA256_PATTERN.test(action.completionDigest)
    || typeof action.sourceWorkspaceDigest !== "string"
    || !SHA256_PATTERN.test(action.sourceWorkspaceDigest)
    || typeof action.samplePlanDigest !== "string"
    || !SHA256_PATTERN.test(action.samplePlanDigest)
    || typeof action.configurationDigest !== "string"
    || !SHA256_PATTERN.test(action.configurationDigest)
    || !isRecord(action.byteRange)) return false;
  const offset = Number(action.byteRange.offset);
  const endOffset = Number(action.byteRange.endOffset);
  const sizeBytes = Number(action.sizeBytes);
  return Number.isSafeInteger(offset)
    && Number.isSafeInteger(endOffset)
    && offset >= 0
    && endOffset > offset
    && endOffset <= sizeBytes
    && Number(action.textBytes) === endOffset - offset
    && typeof action.byteRange.truncated === "boolean"
    && action.byteRange.truncated === (endOffset < sizeBytes);
};

const completeCanonicalOutputRead = (
  reads: readonly Record<string, unknown>[],
): boolean => {
  const first = reads[0];
  if (!first) return false;
  const sizeBytes = Number(first.sizeBytes);
  if (reads.some((read) => read.outputRef !== first.outputRef
    || read.logicalName !== first.logicalName
    || read.mediaType !== first.mediaType
    || read.declaredRole !== first.declaredRole
    || read.sha256 !== first.sha256
    || Number(read.sizeBytes) !== sizeBytes
    || Number(read.sampleIndex) !== Number(first.sampleIndex))) return false;
  const ranges = reads.map((read) => ({
    offset: Number((read.byteRange as Record<string, unknown>).offset),
    endOffset: Number((read.byteRange as Record<string, unknown>).endOffset),
  })).sort((left, right) => left.offset - right.offset || left.endOffset - right.endOffset);
  let coveredThrough = 0;
  for (const range of ranges) {
    if (range.offset > coveredThrough) break;
    coveredThrough = Math.max(coveredThrough, range.endOffset);
    if (coveredThrough === sizeBytes) return true;
  }
  return false;
};

const completionReason = (actions: readonly Record<string, unknown>[]): string => {
  if (actions.some((action) => action.actionKind === "run_start")) return "project_run_started";
  const cancellation = [...actions].reverse().find((action) => action.actionKind === "run_cancel");
  if (cancellation) {
    return cancellation.state === "committed" ? "project_run_cancelled" : "project_run_cancel_observed";
  }
  if (actions.some((action) => String(action.actionKind).startsWith("experiment_configuration_"))) {
    return "experiment_configuration_committed";
  }
  if (actions.some((action) => action.actionKind === "project_files_write")) return "project_files_committed";
  if (actions.some((action) => action.actionKind === "run_output_statistics")) {
    return "run_output_statistics_observed";
  }
  if (actions.some((action) => action.actionKind === "run_output_read")) return "run_outputs_observed";
  return "response_delivered";
};

const completionIntent = (
  actions: readonly Record<string, unknown>[],
): "response_delivery" | "explicit_mutation" | "project_visual" | "project_batch" => {
  const run = [...actions].reverse().find((action) => action.actionKind === "run_start");
  if (run?.runKind === "visual") return "project_visual";
  if (run?.runKind === "batch") return "project_batch";
  return actions.some((action) => action.state === "committed")
    ? "explicit_mutation" : "response_delivery";
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => Boolean(value)
  && typeof value === "object" && !Array.isArray(value);

const requiredToolChanges = (value: unknown): readonly Readonly<Record<string, unknown>>[] => {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64
    || value.some((change) => !isRecord(change))) {
    throw new ApiError(422, "invalid_tool_input", "Project file changes are invalid.");
  }
  return value as readonly Readonly<Record<string, unknown>>[];
};

const boundedRunDiagnostics = (
  run: ProjectRunRecord,
  completion: Readonly<{ completion: Record<string, unknown>; digest: string; createdAt: string }> | null,
): Readonly<Record<string, unknown>> => {
  const base = {
    runId: run.id,
    runKind: run.runKind,
    status: run.status,
    sourceWorkspaceDigest: run.sourceWorkspaceDigest,
    terminalCode: run.terminalCode,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    completionDigest: completion?.digest ?? null,
    completion: completion?.completion ?? null,
  };
  if (Buffer.byteLength(JSON.stringify(base), "utf8") <= 256_000) return Object.freeze(base);
  const detail = completion?.completion ?? {};
  return Object.freeze({
    ...base,
    completion: Object.freeze({
      status: detail.status ?? run.status,
      code: detail.code ?? run.terminalCode,
      diagnostic: typeof detail.diagnostic === "string" ? detail.diagnostic.slice(0, 8_000) : null,
      truncated: true,
    }),
  });
};

const safeDiagnostic = (error: unknown): string => {
  const message = error instanceof Error ? error.message : "Run startup failed.";
  return message.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim().slice(0, 4_000) || "Run startup failed.";
};

export const boundedOperation = async <T>(
  operation: Promise<T>,
  timeoutMs: number,
  code: string,
): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ApiError(504, code, "The bounded OpenCode setup operation timed out.")), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

export const removeStaleProjectionEntries = (root: string, expected: ReadonlySet<string>): void => {
  const visit = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(directory, entry.name);
      const stat = lstatSync(path);
      const requiredDirectory = [...expected].some((candidate) => candidate.startsWith(`${relativePath}/`));
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        if (expected.has(relativePath)) {
          rmSync(path, { recursive: true, force: true });
          continue;
        }
        visit(path, relativePath);
        if (!requiredDirectory && readdirSync(path).length === 0) rmSync(path, { recursive: true, force: true });
        continue;
      }
      if (!expected.has(relativePath) || requiredDirectory || stat.isSymbolicLink()) {
        rmSync(path, { recursive: false, force: true });
      }
    }
  };
  visit(root, "");
};

const goalVerification = (input: Readonly<{
  disposition: "completed" | "needs_user_input" | "failed" | "read_only";
  reasonCode: string;
  intentKind: "response_delivery" | "explicit_mutation" | "project_visual" | "project_batch";
  actions: readonly Record<string, unknown>[];
  affectedResourceCount: number;
  partialEffect: boolean;
  openCodeTerminal: "idle" | "not_reached" | "unknown";
}>): Record<string, unknown> => {
  const terminal = input.actions.filter((action) => ["committed", "failed", "denied", "rolled_back"].includes(String(action.state)));
  const stable = Object.freeze({
    disposition: input.disposition,
    reasonCode: safeReasonCode(input.reasonCode),
    evidence: Object.freeze({
      openCodeTerminal: input.openCodeTerminal,
      intentKind: input.intentKind,
      actionCount: input.actions.length,
      terminalActionCount: terminal.length,
      committedActionCount: terminal.filter((action) => action.state === "committed").length,
      affectedResourceCount: input.affectedResourceCount,
      ownerStateVerified: input.disposition === "completed",
      partialEffect: input.partialEffect,
    }),
  });
  return Object.freeze({ ...stable, receiptDigest: canonicalDigest(stable) });
};

const readinessFailure = (error: unknown): OpenCodeReadiness => Object.freeze({
  status: "unavailable",
  modelId: null,
  lastError: Object.freeze({ code: errorCode(error), message: "OpenCode is unavailable." }),
});
const errorCode = (error: unknown): string => safeReasonCode(
  error instanceof ApiError ? error.code
    : error instanceof ProjectOnlyStoreError ? error.code
      : error && typeof error === "object" && typeof (error as any).code === "string" ? (error as any).code
        : "project_agent_failed",
);
const safeReasonCode = (value: string): string => /^[a-z0-9_]{1,200}$/u.test(value) ? value : "project_agent_failed";
const stableId = (prefix: string, value: string): string =>
  `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
