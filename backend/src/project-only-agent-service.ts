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
  type ProjectRunRecord,
} from "./project-only-store.ts";
import { ProjectOnlyVisualRuntime } from "./project-only-visual-runtime.ts";
import type { LoadedSimulationSkill } from "./simulation-skill-catalog.ts";
import { estimatedTurnTokens, type TestUserAccess } from "./test-user-access.ts";

const OPENCODE_SESSION_SETUP_TIMEOUT_MS = 10_000;
const OPENCODE_PROJECT_DELIVERY_TIMEOUT_MS = 600_000;

const PROJECT_ONLY_TURN_TOOLS = Object.freeze([
  "riff_list_project_workspace",
  "riff_read_project_file",
  "riff_write_project_files",
  "riff_list_experiment_configurations",
  "riff_list_runs",
  "riff_start_project_run",
  "riff_read_project_run_diagnostics",
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
      capability = this.#mcp.grant({
        conversationId: conversation.id,
        owner: Object.freeze({ kind: "project", id: project.id }),
        turnId: turn.id,
        externalSessionGeneration: session.generation,
        allowedTools: new Set(PROJECT_ONLY_TURN_TOOLS),
        intentAuthority: "explicit",
      });
      await boundedOperation(
        this.openCode.bindScopedMcp(
          turn.id,
          this.scopedMcpUrl(capability),
          PROJECT_ONLY_TURN_TOOLS,
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
          scopedMcpTools: PROJECT_ONLY_TURN_TOOLS,
          ...(input.agentName ? { agentName: input.agentName } : {}),
        }, AbortSignal.timeout(OPENCODE_PROJECT_DELIVERY_TIMEOUT_MS), workspace),
        OPENCODE_PROJECT_DELIVERY_TIMEOUT_MS,
        "opencode_prompt_timeout",
      );
      const actions = Object.freeze([...(this.#turnActions.get(turn.id) ?? [])]);
      const fileCommitCount = actions.filter((action) => action.actionKind === "project_files_write"
        && action.state === "committed").length;
      const assistantText = `${response.text.trim() || "操作已完成。"}${fileCommitCount > 0
        ? `\n\n文件已保存（${fileCommitCount} 个提交回执）。` : ""}`;
      const completed = this.store.completeConversationTurn({
        requestKey: input.requestKey,
        assistantText,
        actions,
        goalVerification: goalVerification({
          disposition: "completed",
          reasonCode: fileCommitCount > 0 ? "project_files_committed" : "response_delivered",
          intentKind: fileCommitCount > 0 ? "explicit_mutation" : "response_delivery",
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
      if (scopeBound && workspace) {
        try { await this.openCode.unbindScopedMcp(turn.id, workspace); } catch { /* capability revocation is authoritative */ }
      }
      if (capability) this.#mcp.revoke(capability);
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
        }))),
      });
    }
    if (tool === "riff_list_runs") {
      return Object.freeze({
        runs: Object.freeze(this.store.runs(project.id).map((run) => Object.freeze({
          id: run.id,
          runKind: run.runKind,
          status: run.status,
          sourceWorkspaceDigest: run.sourceWorkspaceDigest,
          terminalCode: run.terminalCode,
          createdAt: run.createdAt,
          finishedAt: run.finishedAt,
        }))),
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
      try {
        if (runKind === "batch") {
          this.batchRuntime.start({ projectId: project.id, runId: admitted.runId });
        } else {
          const html = this.store.projectFiles(project.id)
            .find((file) => file.relativePath === "visual.html")?.bytes.toString("utf8");
          if (!html) throw new ApiError(409, "visual_document_missing", "The Project visual document is missing.");
          await this.visualRuntime.start({ projectId: project.id, runId: admitted.runId, html, at: this.now() });
        }
      } catch (error) {
        this.store.failRunStart({
          id: admitted.runId,
          code: errorCode(error),
          diagnostic: safeDiagnostic(error),
          at: this.now(),
        });
        throw error;
      }
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
      this.#recordTurnAction(grant.turnId, action);
      return Object.freeze({
        state: "started",
        runId: admitted.runId,
        runKind,
        status: this.store.run(admitted.runId).status,
        sourceWorkspaceDigest: admitted.sourceWorkspaceDigest,
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
    const filesCommitted = actions.some((action) => action.actionKind === "project_files_write"
      && action.state === "committed");
    const failed = this.store.failConversationTurn({
      requestKey: turn.requestKey,
      state: "failed",
      code,
      assistantText: filesCommitted
        ? `文件已保存；本轮后续操作未完成（${code}）。`
        : `OpenCode 未能完成本轮操作（${code}）。`,
      actions,
      goalVerification: goalVerification({
        disposition: "failed",
        reasonCode: code,
        intentKind: filesCommitted ? "explicit_mutation" : "response_delivery",
        actions,
        affectedResourceCount: actions.length,
        partialEffect: filesCommitted,
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
      title: "OpenCode 正在处理", summary: "当前 Project 工具作用域已绑定。",
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
Use the scoped Riff tools to inspect authoritative files, write requested UTF-8 project artifacts, list Experiments, start real Runs, and read failed-Run diagnostics. Return ordinary prose, not a structured delivery envelope.
Project files are changed only by riff_write_project_files. Its committed receipt is the sole authority that bytes were saved; never claim a file was saved unless that tool returned state=committed. The write is immediate, does not run syntax/dependency/smoke/technical checks, and does not create a revision.
Before writing, list the workspace and use the current workspace digest plus each affected file's current SHA-256. You may write files and then start a Run in the same turn; the Run must use the latest committed workspace. Do not retry a failed Run or modify files automatically. When the user asks to repair a failure, read the latest Run diagnostics and relevant files, then submit an explicit new write.
Use riff_start_project_run only with an existing Experiment configuration whose runKind matches. A real Run is the only executable-code verdict. A failed Run never rolls back Project files.
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
