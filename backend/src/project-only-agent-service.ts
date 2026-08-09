import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ApiError } from "./errors.ts";
import { canonicalDigest } from "./canonical-json-v2.ts";
import {
  INPUT_SCHEMA_PROFILE,
  JSON_SCHEMA_2020_12,
  normalizeInputParameters,
  planExperiment,
  validateInputSchema,
} from "./experiment-planner.ts";
import type {
  OpenCodeAgent,
  OpenCodeConversationPort,
  OpenCodeProviderModel,
  OpenCodeReadiness,
  OpenCodeWorkspaceBinding,
} from "./opencode-adapter.ts";
import { ProjectOnlyOperationsAdapter } from "./project-only-operations.ts";
import { ProjectOnlyBatchRuntime } from "./project-only-batch-runtime.ts";
import {
  ProjectOnlyStore,
  ProjectOnlyStoreError,
  type ProjectConversationMessageRecord,
  type ProjectConversationRecord,
  type ProjectConversationTurnRecord,
  type ProjectFileRecord,
  type ProjectRecord,
} from "./project-only-store.ts";
import { ProjectOnlyVisualRuntime } from "./project-only-visual-runtime.ts";
import type { LoadedSimulationSkill } from "./simulation-skill-catalog.ts";
import { estimatedTurnTokens, type TestUserAccess } from "./test-user-access.ts";

const MAX_PROJECT_CONTEXT_BYTES = 96 * 1024;
const OPENCODE_SESSION_SETUP_TIMEOUT_MS = 10_000;
const OPENCODE_PROMPT_TIMEOUT_MS = 180_000;
const OPENCODE_PROJECT_DELIVERY_TIMEOUT_MS = 600_000;
const PROJECT_DELIVERY_RESPONSE_HEADER = "RIFF_PROJECT_DELIVERY_V1\n";
const MODEL_SOURCE_RESPONSE_HEADER = "RIFF_MODEL_SOURCE_V1\n";
const VISUAL_COMMAND = /^\s*(?:开启|启动|打开|运行)\s*(?:可视化)?仿真(?:页面)?[。！!]?\s*$/u;
const STOP_VISUAL_FRAGMENT = /(?:关闭|停止|结束)\s*(?:可视化)?(?:仿真)?(?:页面|运行|Run)?/iu;
const START_BATCH_COMMAND = /(?:启动|开始|运行|执行).{0,16}(?:大样本|批量|批处理)(?:仿真|实验|运行)?|(?:大样本|批量|批处理).{0,16}(?:启动|开始|运行|执行)/u;
const INTERPRET_RESULTS_COMMAND = /(?:解读|解释|分析|总结).{0,16}(?:实验|仿真|运行)?结果|(?:实验|仿真|运行)?结果.{0,16}(?:解读|解释|分析|总结)/u;
const UPDATE_AND_RERUN_COMMAND = /(?:修改|改动|调整|更改).{0,32}(?:参数).{0,32}(?:再次|重新|再).{0,16}(?:运行|实验|仿真)/u;
const VISUAL_CONTROLS_COMMAND = /(?:可视化|仿真).{0,24}(?:页面).{0,32}(?:重置|单步).{0,32}(?:开始|暂停)|(?:重置|开始|单步|暂停).{0,48}(?:控制按钮)/u;
const VISUAL_LAYOUT_COMMAND = /(?:游轮|舱室|客房).{0,48}(?:布局|可视化|页面)|(?:布局|可视化|页面).{0,48}(?:游轮|舱室|客房)/u;
const EXPLICIT_PROJECT_MUTATION = /(?:生成|创建|编写|设计|增加|添加|修改|改动|调整|删除|重写|实现|修复).{0,24}(?:模型|代码|页面|按钮|可视化|参数|设计)|(?:模型|代码|页面|按钮|可视化|参数|设计).{0,24}(?:生成|创建|编写|设计|增加|添加|修改|改动|调整|删除|重写|实现|修复)/u;

type ProjectCommandIntent = Readonly<{
  startVisual: boolean;
  stopVisual: boolean;
  startBatch: boolean;
  interpretResults: boolean;
  updateAndRerun: boolean;
  visualControls: boolean;
  explicitMutation: boolean;
  requiresAgent: boolean;
}>;

type AgentInstruction = Readonly<{
  operation: "deliver_design" | "deliver_project" | "start_visual" | "stop_visual" | "update_experiment_and_start_batch" | "none";
  assistantText: string;
  modelSource?: string;
  designMarkdown?: string;
  experimentConfiguration?: Record<string, unknown>;
  inputSchema?: Record<string, unknown>;
  defaultParameters?: Record<string, unknown>;
  visual?: Readonly<{
    title?: string;
    summary?: string;
    entities?: readonly Readonly<{ name?: string; color?: string; value?: number }>[];
    series?: readonly number[];
  }>;
}>;

type TurnOutcome = Readonly<{
  assistantText: string;
  actions: readonly Record<string, unknown>[];
  goalVerification: Record<string, unknown>;
}>;

export type ProjectOnlyProviderAvailability =
  | Readonly<{ mode: "live"; providerModels: readonly OpenCodeProviderModel[] }>
  | Readonly<{ mode: "read_only"; reason: "opencode_unavailable" | "opencode_auth_failed"; providerModels: readonly [] }>;

/**
 * Project-only Conversation bridge. OpenCode supplies a bounded structured
 * modelling result; this service alone commits it to the authoritative Store,
 * verifies the reread, runs the technical check, and starts visual Runs.
 */
export class ProjectOnlyAgentService {
  readonly store: ProjectOnlyStore;
  readonly operations: ProjectOnlyOperationsAdapter;
  readonly openCode?: OpenCodeConversationPort;
  readonly visualRuntime: ProjectOnlyVisualRuntime;
  readonly batchRuntime: ProjectOnlyBatchRuntime;
  readonly loadedSkills: readonly LoadedSimulationSkill[];
  readonly testUserAccess?: TestUserAccess;
  readonly now: () => string;
  #readiness: OpenCodeReadiness = { status: "unconfigured", modelId: null };
  #providers: readonly OpenCodeProviderModel[] = Object.freeze([]);
  readonly #pendingTurns = new Map<string, Promise<unknown>>();

  constructor(input: Readonly<{
    store: ProjectOnlyStore;
    operations: ProjectOnlyOperationsAdapter;
    openCode?: OpenCodeConversationPort;
    visualRuntime: ProjectOnlyVisualRuntime;
    batchRuntime: ProjectOnlyBatchRuntime;
    loadedSkills?: readonly LoadedSimulationSkill[];
    testUserAccess?: TestUserAccess;
    now?: () => string;
  }>) {
    this.store = input.store;
    this.operations = input.operations;
    this.openCode = input.openCode;
    this.visualRuntime = input.visualRuntime;
    this.batchRuntime = input.batchRuntime;
    this.loadedSkills = Object.freeze([...(input.loadedSkills ?? [])]);
    this.testUserAccess = input.testUserAccess;
    this.now = input.now ?? (() => new Date().toISOString());
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
    const intent = projectCommandIntent(input.text.trim());
    let preliminary: TurnOutcome | null = null;
    if (intent.stopVisual) {
      try {
        preliminary = await this.#stopVisual({ project, turn, requestKey: input.requestKey });
        if (!intent.requiresAgent && !intent.visualControls && !intent.startBatch && !intent.interpretResults) {
          const completed = this.store.completeConversationTurn({
            requestKey: input.requestKey,
            assistantText: preliminary.assistantText,
            actions: preliminary.actions,
            goalVerification: preliminary.goalVerification,
            completedAt: this.now(),
          });
          return Object.freeze({
            mode: "live",
            turn: completed,
            messages: Object.freeze(this.store.conversationMessages(conversation.id)),
          });
        }
      } catch (error) {
        return this.#failTurn(turn, error, intent, null);
      }
    }
    if (intent.startVisual) {
      try {
        const outcome = await this.#startVisual({
          conversation,
          turn,
          project: this.store.project(project.id),
          input: { requestKey: input.requestKey, text: input.text },
          instruction: { operation: "start_visual", assistantText: "启动可视化仿真" },
        });
        const completed = this.store.completeConversationTurn({
          requestKey: input.requestKey,
          assistantText: outcome.assistantText,
          actions: outcome.actions,
          goalVerification: outcome.goalVerification,
          completedAt: this.now(),
        });
        return Object.freeze({
          mode: "live",
          turn: completed,
          messages: Object.freeze(this.store.conversationMessages(conversation.id)),
        });
      } catch (error) {
        return this.#failTurn(turn, error, intent, preliminary);
      }
    }
    if (intent.visualControls) {
      try {
        const outcome = await this.#updateVisualControls({ project: this.store.project(project.id), turn, requirement: input.text });
        const merged = preliminary ? mergeTurnOutcomes(preliminary, outcome) : outcome;
        const completed = this.store.completeConversationTurn({
          requestKey: input.requestKey,
          assistantText: merged.assistantText,
          actions: merged.actions,
          goalVerification: merged.goalVerification,
          completedAt: this.now(),
        });
        return Object.freeze({
          mode: "live",
          turn: completed,
          messages: Object.freeze(this.store.conversationMessages(conversation.id)),
        });
      } catch (error) {
        return this.#failTurn(turn, error, intent, preliminary);
      }
    }
    if (intent.startBatch && !intent.explicitMutation && !intent.updateAndRerun) {
      try {
        const outcome = await this.#startBatch({ project, turn, requestKey: input.requestKey });
        const merged = preliminary ? mergeTurnOutcomes(preliminary, outcome) : outcome;
        const completed = this.store.completeConversationTurn({
          requestKey: input.requestKey,
          assistantText: merged.assistantText,
          actions: merged.actions,
          goalVerification: merged.goalVerification,
          completedAt: this.now(),
        });
        return Object.freeze({
          mode: "live",
          turn: completed,
          messages: Object.freeze(this.store.conversationMessages(conversation.id)),
        });
      } catch (error) {
        return this.#failTurn(turn, error, intent, preliminary);
      }
    }
    if (intent.interpretResults) {
      try {
        const outcome = this.#interpretBatchResults({ project, turn });
        const completed = this.store.completeConversationTurn({
          requestKey: input.requestKey,
          assistantText: outcome.assistantText,
          actions: outcome.actions,
          goalVerification: outcome.goalVerification,
          completedAt: this.now(),
        });
        return Object.freeze({
          mode: "live",
          turn: completed,
          messages: Object.freeze(this.store.conversationMessages(conversation.id)),
        });
      } catch (error) {
        return this.#failTurn(turn, error, intent, preliminary);
      }
    }
    if (intent.updateAndRerun) {
      const parameterPatch = parseParameterPatch(input.text);
      if (parameterPatch) {
        try {
          const existing = [...this.store.experiments(project.id)].reverse()
            .find((candidate) => candidate.configuration.runKind === "batch");
          const base = existing?.configuration
            ?? defaultBatchExperiment(project.executionDescription, 30);
          const baseParameters = base.parameters && typeof base.parameters === "object"
            && !Array.isArray(base.parameters) ? base.parameters : {};
          const configuration = Object.freeze({
            ...base,
            parameters: Object.freeze({ ...baseParameters, ...parameterPatch }),
          });
          const outcome = await this.#updateExperimentAndStartBatch({
            project,
            turn,
            input: { requestKey: input.requestKey, text: input.text },
            instruction: Object.freeze({
              operation: "update_experiment_and_start_batch",
              assistantText: `已读取参数 ${JSON.stringify(parameterPatch)}。`,
              experimentConfiguration: configuration,
            }),
          });
          const completed = this.store.completeConversationTurn({
            requestKey: input.requestKey,
            assistantText: outcome.assistantText,
            actions: outcome.actions,
            goalVerification: outcome.goalVerification,
            completedAt: this.now(),
          });
          return Object.freeze({
            mode: "live",
            turn: completed,
            messages: Object.freeze(this.store.conversationMessages(conversation.id)),
          });
        } catch (error) {
          return this.#failTurn(turn, error, intent, preliminary);
        }
      }
    }
    let discovery: ProjectOnlyProviderAvailability;
    try {
      discovery = await boundedOperation(
        this.providers(),
        OPENCODE_SESSION_SETUP_TIMEOUT_MS,
        "opencode_discovery_timeout",
      );
    } catch (error) {
      return this.#failTurn(turn, error, intent, preliminary);
    }
    if (discovery.mode !== "live" || !this.openCode) {
      return this.#failReadOnly(
        turn,
        discovery.mode === "read_only" ? discovery.reason : "opencode_unavailable",
        preliminary,
      );
    }
    if (!discovery.providerModels.some((item) => item.providerId === conversation.provider.providerId
      && item.modelId === conversation.provider.modelId)) {
      return this.#failReadOnly(turn, "opencode_model_unavailable", preliminary);
    }

    let sessionId: string | null = null;
    let workspace: OpenCodeWorkspaceBinding | null = null;
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
      const promptTimeoutMs = intent.explicitMutation
        ? OPENCODE_PROJECT_DELIVERY_TIMEOUT_MS
        : OPENCODE_PROMPT_TIMEOUT_MS;
      const response = await boundedOperation(
        this.openCode.promptWithModel(sessionId, conversation.provider, {
          text: input.text.trim(),
          system: projectSystemPrompt(
            project,
            this.store.projectFiles(project.id),
            this.store.experiments(project.id),
            this.loadedSkills,
          ),
          attachments: [],
          ...(input.agentName ? { agentName: input.agentName } : {}),
        }, AbortSignal.timeout(promptTimeoutMs), workspace),
        promptTimeoutMs,
        "opencode_prompt_timeout",
      );
      const instruction = parseAgentResponse(response.text);
      const applied = await this.#applyInstruction({ conversation, turn, project, input, instruction, intent });
      const outcome = preliminary ? mergeTurnOutcomes(preliminary, applied) : applied;
      const completed = this.store.completeConversationTurn({
        requestKey: input.requestKey,
        assistantText: outcome.assistantText,
        actions: outcome.actions,
        goalVerification: outcome.goalVerification,
        completedAt: this.now(),
      });
      return Object.freeze({
        mode: "live",
        turn: completed,
        messages: Object.freeze(this.store.conversationMessages(conversation.id)),
      });
    } catch (error) {
      if (sessionId && workspace) {
        try { await this.openCode.abort(sessionId, workspace); } catch { /* the lost generation remains fail-closed */ }
        try { this.openCode.releaseRuntimeBoundary?.(sessionId, workspace); } catch { /* generation retirement is enough */ }
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
      return this.#failTurn(turn, error, intent, preliminary);
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

  runtime(conversationId: string): Record<string, unknown> {
    const conversation = this.store.conversation(conversationId);
    const turns = this.store.conversationTurns(conversationId);
    const active = [...turns].reverse().find((turn) => turn.state === "running") ?? null;
    const latest = turns.at(-1) ?? null;
    const parts = active ? [{
      id: `${active.id}_opencode`, kind: "mcp", state: "pending",
      title: "OpenCode 正在处理", summary: "等待当前 provider/model 返回结构化结果。",
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
      mcp: Object.freeze({ state: "unavailable", label: "Riff direct delivery" }),
    });
  }

  async close(): Promise<void> {
    await this.batchRuntime.close();
    await this.visualRuntime.close();
  }

  async #applyInstruction(input: Readonly<{
    conversation: ProjectConversationRecord;
    turn: ProjectConversationTurnRecord;
    project: ProjectRecord;
    input: Readonly<{ requestKey: string; text: string }>;
    instruction: AgentInstruction;
    intent: ProjectCommandIntent;
  }>): Promise<Readonly<{
    assistantText: string;
    actions: readonly Record<string, unknown>[];
    goalVerification: Record<string, unknown>;
  }>> {
    if (input.intent.startVisual) {
      if (input.instruction.operation !== "start_visual") {
        throw new ApiError(502, "opencode_visual_intent_mismatch", "OpenCode did not confirm the requested visual Run.");
      }
      return this.#startVisual(input);
    }
    if (input.instruction.operation === "stop_visual") {
      if (input.intent.explicitMutation) {
        throw new ApiError(502, "opencode_intent_mismatch", "OpenCode omitted the requested Project mutation.");
      }
      return this.#stopVisual({ project: input.project, turn: input.turn, requestKey: input.input.requestKey });
    }
    if (input.instruction.operation === "deliver_design") {
      if (!input.instruction.designMarkdown?.trim()) {
        throw new ApiError(502, "opencode_invalid_structured_response", "OpenCode omitted designMarkdown for a design delivery.");
      }
      return this.#deliverDesign(input);
    }
    if (input.instruction.operation === "update_experiment_and_start_batch") {
      if (!input.intent.updateAndRerun || !input.instruction.experimentConfiguration) {
        throw new ApiError(502, "opencode_intent_mismatch", "OpenCode returned an unexpected Experiment operation.");
      }
      return this.#updateExperimentAndStartBatch(input);
    }
    if (input.intent.updateAndRerun) {
      throw new ApiError(502, "opencode_intent_mismatch", "OpenCode omitted the requested Experiment update and rerun.");
    }
    if (input.intent.explicitMutation && input.instruction.operation !== "deliver_project") {
      throw new ApiError(502, "opencode_intent_mismatch", "OpenCode did not return the requested Project mutation.");
    }
    if (input.instruction.operation === "start_visual") return this.#startVisual(input);
    if (input.instruction.operation === "deliver_project" && !input.instruction.modelSource?.trim()) {
      throw new ApiError(502, "opencode_invalid_structured_response", "OpenCode omitted modelSource for a Project delivery.");
    }
    if (input.instruction.operation !== "deliver_project") {
      const verification = goalVerification({
        disposition: "needs_user_input", reasonCode: "no_project_change_requested",
        intentKind: "response_delivery", actions: [], affectedResourceCount: 0,
        partialEffect: false, openCodeTerminal: "idle",
      });
      return Object.freeze({ assistantText: input.instruction.assistantText, actions: Object.freeze([]), goalVerification: verification });
    }

    const currentFiles = this.store.projectFiles(input.project.id);
    const existing = new Map(currentFiles.map((file) => [file.relativePath, file]));
    const visualHtml = buildProjectVisualHtml(input.project.name, input.input.text, input.instruction.visual);
    const nextExecutionDescription = executionDescription(input.instruction);
    const generated = [
      projectChange(existing.get("code/model.py"), "code/model.py", "code", "text/x-python", input.instruction.modelSource),
      projectChange(existing.get("code/riff_entry.py"), "code/riff_entry.py", "code", "text/x-python", PROJECT_ONLY_BATCH_ENTRY_SOURCE),
      projectChange(existing.get("code/visual.py"), "code/visual.py", "code", "text/x-python", PROJECT_ONLY_VISUAL_SERVER_SOURCE),
      projectChange(existing.get("environment/requirements.txt"), "environment/requirements.txt", "environment", "text/plain", "mesa>=3,<4\n"),
      projectChange(existing.get("visual.html"), "visual.html", "visual_asset", "text/html", visualHtml),
    ];
    const envelope = await this.operations.deliverProjectChanges({
      commandId: stableId("delivery", input.input.requestKey),
      projectId: input.project.id,
      conversationId: input.conversation.id,
      turnId: input.turn.id,
      expectedWorkspaceDigest: input.project.workspaceDigest,
      changes: generated,
      executionDescription: nextExecutionDescription,
    });
    const result = envelope.result as any;
    const mutation = result.mutationReceipt;
    const action = Object.freeze({
      id: stableId("action", `${input.turn.id}:deliver`),
      actionKind: "model_files_mutate",
      permissionDecision: "allowed",
      state: result.status === "succeeded" ? "committed" : "failed",
      errorCode: result.status === "succeeded" ? null : "project_delivery_failed_after_commit",
      mutationReceipt: Object.freeze({
        operation: "direct_apply",
        receiptDigest: mutation.receiptDigest,
        beforeWorkspaceDigest: mutation.beforeWorkspaceDigest,
        afterWorkspaceDigest: mutation.afterWorkspaceDigest,
        committedAt: mutation.committedAt,
        files: Object.freeze(mutation.files.map((file: any) => Object.freeze({
          relativePath: file.relativePath,
          priorSha256: file.priorSha256,
          proposedSha256: file.afterSha256,
        }))),
      }),
    });
    const actions = Object.freeze([action]);
    const verified = result.status === "succeeded" && result.technicalCheck?.aggregate === "executable";
    const verification = goalVerification({
      disposition: verified ? "completed" : "failed",
      reasonCode: verified ? "project_delivery_verified" : "project_delivery_failed_after_commit",
      intentKind: "explicit_mutation", actions,
      affectedResourceCount: envelope.affectedResources.length,
      partialEffect: !verified,
      openCodeTerminal: "idle",
    });
    return Object.freeze({
      assistantText: verified
        ? `${input.instruction.assistantText}\n\n模型文件已写入并通过技术检查。`
        : `${input.instruction.assistantText}\n\n文件已写入，但技术检查未通过；请查看回执。`,
      actions,
      goalVerification: verification,
    });
  }

  #deliverDesign(input: Readonly<{
    project: ProjectRecord;
    turn: ProjectConversationTurnRecord;
    instruction: AgentInstruction;
  }>): TurnOutcome {
    const before = this.store.project(input.project.id);
    const existing = this.store.projectFiles(before.id).find((file) => file.relativePath === "design/model-design.md");
    const bytes = Buffer.from(`${input.instruction.designMarkdown!.trim()}\n`, "utf8");
    const after = this.store.updateProjectWorkspace({
      projectId: before.id,
      expectedWorkspaceDigest: before.workspaceDigest,
      changes: [{
        id: existing?.id ?? stableId("project_file", `${before.id}:model-design`),
        kind: "project_code",
        relativePath: "design/model-design.md",
        mediaType: "text/markdown",
        bytes,
      }],
      updatedAt: this.now(),
    });
    const reread = this.store.projectFiles(after.id).find((file) => file.relativePath === "design/model-design.md");
    if (!reread || !reread.bytes.equals(bytes)) {
      throw new ApiError(500, "project_delivery_reread_failed", "The model design did not match its authoritative reread.");
    }
    const receiptStable = {
      operation: "direct_apply",
      beforeWorkspaceDigest: before.workspaceDigest,
      afterWorkspaceDigest: after.workspaceDigest,
      committedAt: this.now(),
      files: [{
        relativePath: reread.relativePath,
        priorSha256: existing?.sha256 ?? null,
        proposedSha256: reread.sha256,
      }],
    };
    const action = Object.freeze({
      id: stableId("action", `${input.turn.id}:design`),
      actionKind: "project_design_mutate",
      permissionDecision: "allowed",
      state: "committed",
      errorCode: null,
      mutationReceipt: Object.freeze({ ...receiptStable, receiptDigest: canonicalDigest(receiptStable) }),
    });
    const actions = Object.freeze([action]);
    return Object.freeze({
      assistantText: `${input.instruction.assistantText}\n\n模型设计已保存为 design/model-design.md；尚未把设计视为可执行模型。`,
      actions,
      goalVerification: goalVerification({
        disposition: "completed",
        reasonCode: "model_design_delivered",
        intentKind: "explicit_mutation",
        actions,
        affectedResourceCount: 2,
        partialEffect: false,
        openCodeTerminal: "idle",
      }),
    });
  }

  async #updateVisualControls(input: Readonly<{
    project: ProjectRecord;
    turn: ProjectConversationTurnRecord;
    requirement: string;
  }>): Promise<TurnOutcome> {
    const before = this.store.project(input.project.id);
    const existing = this.store.projectFiles(before.id).find((file) => file.relativePath === "visual.html");
    const bytes = Buffer.from(buildProjectVisualHtml(before.name, input.requirement), "utf8");
    const after = this.store.updateProjectWorkspace({
      projectId: before.id,
      expectedWorkspaceDigest: before.workspaceDigest,
      changes: [{
        id: existing?.id ?? stableId("project_file", `${before.id}:visual-html`),
        kind: "project_visual_asset",
        relativePath: "visual.html",
        mediaType: "text/html",
        bytes,
      }],
      updatedAt: this.now(),
    });
    const reread = this.store.projectFiles(after.id).find((file) => file.relativePath === "visual.html");
    if (!reread || !reread.bytes.equals(bytes)) {
      throw new ApiError(500, "project_delivery_reread_failed", "The visual controls did not match their authoritative reread.");
    }
    const receiptStable = {
      operation: "direct_apply",
      beforeWorkspaceDigest: before.workspaceDigest,
      afterWorkspaceDigest: after.workspaceDigest,
      committedAt: this.now(),
      files: [{
        relativePath: reread.relativePath,
        priorSha256: existing?.sha256 ?? null,
        proposedSha256: reread.sha256,
      }],
    };
    const mutationAction = Object.freeze({
      id: stableId("action", `${input.turn.id}:visual-controls`),
      actionKind: "visual_asset_mutate",
      permissionDecision: "allowed",
      state: "committed",
      errorCode: null,
      mutationReceipt: Object.freeze({ ...receiptStable, receiptDigest: canonicalDigest(receiptStable) }),
    });
    const checked = await this.operations.startProjectTechnicalCheck({
      projectId: after.id,
      commandId: stableId("visual_controls_check", input.turn.requestKey),
      expectedWorkspaceDigest: after.workspaceDigest,
    });
    const verified = (checked.result as any).status === "succeeded";
    const checkAction = Object.freeze({
      id: stableId("action", `${input.turn.id}:visual-controls-check`),
      actionKind: "project_technical_check",
      permissionDecision: "allowed",
      state: verified ? "committed" : "failed",
      errorCode: verified ? null : "project_not_executable",
    });
    const actions = Object.freeze([mutationAction, checkAction]);
    const layoutRequested = VISUAL_LAYOUT_COMMAND.test(input.requirement);
    return Object.freeze({
      assistantText: verified
        ? layoutRequested
          ? "可视化页面已增加游轮舱室布局（10层客房甲板、2层公共区、1层工作人员宿舍）并保留仿真控制，已通过当前 Project 技术检查。"
          : "可视化页面已增加重置、开始、单步和暂停控制，并通过当前 Project 技术检查。"
        : layoutRequested
          ? "游轮舱室布局已写入，但当前 Project 技术检查未通过；页面资产已保留。"
          : "可视化控制已写入，但当前 Project 技术检查未通过；页面资产已保留。",
      actions,
      goalVerification: goalVerification({
        disposition: verified ? "completed" : "failed",
        reasonCode: verified ? "visual_controls_verified" : "visual_controls_written_check_failed",
        intentKind: "explicit_mutation",
        actions,
        affectedResourceCount: 2,
        partialEffect: !verified,
        openCodeTerminal: "not_reached",
      }),
    });
  }

  async #updateExperimentAndStartBatch(input: Readonly<{
    project: ProjectRecord;
    turn: ProjectConversationTurnRecord;
    input: Readonly<{ requestKey: string; text: string }>;
    instruction: AgentInstruction;
  }>): Promise<TurnOutcome> {
    const execution = input.project.executionDescription as any;
    const configuration = input.instruction.experimentConfiguration!;
    const plan = planExperiment({
      configuration,
      inputSchema: execution.inputs?.schema,
      maxSamples: 500,
    });
    if (plan.configuration.runKind !== "batch") {
      throw new ApiError(422, "batch_experiment_required", "The updated Experiment must be a batch configuration.");
    }
    const existing = [...this.store.experiments(input.project.id)].reverse()
      .find((experiment) => experiment.configuration.runKind === "batch");
    if (existing) {
      this.store.updateExperiment({
        id: existing.id,
        projectId: input.project.id,
        configuration: plan.configuration as unknown as Record<string, unknown>,
        updatedAt: this.now(),
      });
    } else {
      this.store.createExperiment({
        id: stableId("experiment", `${input.project.id}:default-batch`),
        projectId: input.project.id,
        name: "Large-sample batch",
        configuration: plan.configuration as unknown as Record<string, unknown>,
        createdAt: this.now(),
      });
    }
    const started = await this.#startBatch({
      project: this.store.project(input.project.id),
      turn: input.turn,
      requestKey: input.input.requestKey,
    });
    return Object.freeze({
      ...started,
      assistantText: `${input.instruction.assistantText}\n\n实验参数已更新；${started.assistantText}`,
    });
  }

  async #startBatch(input: Readonly<{
    project: ProjectRecord;
    turn: ProjectConversationTurnRecord;
    requestKey: string;
  }>): Promise<TurnOutcome> {
    let project = this.store.project(input.project.id);
    if (project.technicalStatus !== "executable") {
      const checked = await this.operations.startProjectTechnicalCheck({
        projectId: project.id,
        commandId: stableId("batch_check", input.requestKey),
        expectedWorkspaceDigest: project.workspaceDigest,
      });
      if ((checked.result as any).status !== "succeeded") {
        throw new ApiError(409, "project_not_executable", "The current Project did not pass technical checks.");
      }
      project = this.store.project(project.id);
    }
    if (project.runMode !== "batch" && project.runMode !== "both") {
      throw new ApiError(409, "batch_capability_not_declared", "The current Project does not declare batch execution.");
    }
    let experiment = [...this.store.experiments(project.id)].reverse()
      .find((candidate) => candidate.configuration.runKind === "batch");
    if (!experiment) {
      const configuration = defaultBatchExperiment(project.executionDescription, 30);
      const id = stableId("experiment", `${project.id}:default-batch`);
      this.store.createExperiment({
        id,
        projectId: project.id,
        name: "Large-sample batch",
        configuration,
        createdAt: this.now(),
      });
      experiment = this.store.experiments(project.id).find((item) => item.id === id)!;
    }
    const plan = planExperiment({
      configuration: experiment.configuration,
      inputSchema: (project.executionDescription as any).inputs?.schema,
      maxSamples: 500,
    });
    const admitted = this.operations.startRunAdmission({
      commandId: stableId("batch_run", input.requestKey),
      projectId: project.id,
      experimentConfigurationId: experiment.id,
      runKind: "batch",
      expectedWorkspaceDigest: project.workspaceDigest,
    });
    this.batchRuntime.start({ projectId: project.id, runId: admitted.runId });
    const action = Object.freeze({
      id: stableId("action", `${input.turn.id}:batch`),
      actionKind: "run_start",
      permissionDecision: "allowed",
      state: "committed",
      errorCode: null,
      runId: admitted.runId,
      runKind: "batch",
      sampleCount: plan.sampleCount,
      samplePlanDigest: plan.samplePlanDigest,
    });
    const actions = Object.freeze([action]);
    return Object.freeze({
      assistantText: `大样本实验已在后台启动：Run ${admitted.runId}，共 ${plan.sampleCount} 个冻结样本。`,
      actions,
      goalVerification: goalVerification({
        disposition: "completed",
        reasonCode: "batch_run_started",
        intentKind: "project_batch",
        actions,
        affectedResourceCount: 1,
        partialEffect: false,
        openCodeTerminal: "not_reached",
      }),
    });
  }

  #interpretBatchResults(input: Readonly<{
    project: ProjectRecord;
    turn: ProjectConversationTurnRecord;
  }>): TurnOutcome {
    const run = [...this.store.runs(input.project.id)].reverse().find((candidate) => candidate.runKind === "batch");
    if (!run) throw new ApiError(404, "batch_run_not_found", "No batch Run is available to interpret.");
    const action = Object.freeze({
      id: stableId("action", `${input.turn.id}:interpret`),
      actionKind: "run_outputs_read",
      permissionDecision: "allowed",
      state: "committed",
      errorCode: null,
      runId: run.id,
    });
    const actions = Object.freeze([action]);
    if (["queued", "running", "cancelling"].includes(run.status)) {
      return Object.freeze({
        assistantText: `Run ${run.id} 仍在${run.status === "queued" ? "排队" : "运行"}，尚无可解释的终态输出。`,
        actions,
        goalVerification: goalVerification({
          disposition: "needs_user_input",
          reasonCode: "batch_run_still_active",
          intentKind: "project_batch",
          actions,
          affectedResourceCount: 1,
          partialEffect: false,
          openCodeTerminal: "not_reached",
        }),
      });
    }
    const completion = this.store.runCompletion(run.id);
    if (run.status !== "succeeded" || !completion) {
      return Object.freeze({
        assistantText: `Run ${run.id} 终态为 ${run.status}（${run.terminalCode ?? "无终态代码"}）。它不能作为成功实验结果解读；请先修复失败原因后重跑。`,
        actions,
        goalVerification: goalVerification({
          disposition: "completed",
          reasonCode: "batch_run_not_successful",
          intentKind: "project_batch",
          actions,
          affectedResourceCount: 1,
          partialEffect: false,
          openCodeTerminal: "not_reached",
        }),
      });
    }
    const outputs = this.store.runOutputs(run.id);
    const values = outputs.flatMap((output) => {
      try { return [JSON.parse(output.bytes.toString("utf8"))]; }
      catch { return []; }
    });
    const statistics = summarizeNumericMetrics(values);
    const metricLines = statistics.slice(0, 12).map((metric) =>
      `- ${metric.path}: 均值 ${formatNumber(metric.mean)}，范围 ${formatNumber(metric.min)}–${formatNumber(metric.max)}，n=${metric.count}`);
    const frozen = run.frozenConfiguration as any;
    const sampleCount = Number((completion.completion as any).sampleCount ?? outputs.length);
    const seeds = frozen.sampling?.kind === "multiple-seeds" ? frozen.sampling.seeds : null;
    return Object.freeze({
      assistantText: [
        `Run ${run.id} 已成功完成。`,
        `问题与配置：对冻结参数 ${JSON.stringify(frozen.parameters ?? {})} 进行大样本仿真。`,
        `证据范围：${sampleCount} 个样本${Array.isArray(seeds) ? `，种子 ${seeds.slice(0, 12).join(", ")}${seeds.length > 12 ? "…" : ""}` : ""}；源摘要 ${run.sourceWorkspaceDigest}。`,
        metricLines.length ? `数值结果与样本间变化：\n${metricLines.join("\n")}` : "输出中没有可聚合的数值指标。",
        "限制：这是当前模型与参数下的随机仿真证据，不等于现实校准、因果证明或运营建议；浏览器动画不计入本批量证据。",
      ].join("\n\n"),
      actions,
      goalVerification: goalVerification({
        disposition: "completed",
        reasonCode: "batch_results_interpreted",
        intentKind: "project_batch",
        actions,
        affectedResourceCount: outputs.length + 1,
        partialEffect: false,
        openCodeTerminal: "not_reached",
      }),
    });
  }

  async #stopVisual(input: Readonly<{
    project: ProjectRecord;
    turn: ProjectConversationTurnRecord;
    requestKey: string;
  }>): Promise<TurnOutcome> {
    const active = [...this.store.runs(input.project.id)].reverse().find((run) =>
      run.runKind === "visual" && ["queued", "running", "cancelling"].includes(run.status));
    const action = Object.freeze({
      id: stableId("action", `${input.turn.id}:visual-stop`),
      actionKind: "run_cancel",
      permissionDecision: "allowed",
      state: "committed",
      errorCode: null,
      runId: active?.id ?? null,
      disposition: active ? "cancelled" : "already_stopped",
    });
    const actions = Object.freeze([action]);
    if (active) {
      await this.visualRuntime.stop({ projectId: input.project.id, runId: active.id, at: this.now() });
    }
    return Object.freeze({
      assistantText: active ? "可视化 Run 已关闭，执行锁已释放。" : "当前没有运行中的可视化 Run，无需重复关闭。",
      actions,
      goalVerification: goalVerification({
        disposition: "completed",
        reasonCode: active ? "visual_run_cancelled" : "visual_already_stopped",
        intentKind: "project_visual",
        actions,
        affectedResourceCount: active ? 1 : 0,
        partialEffect: false,
        openCodeTerminal: "not_reached",
      }),
    });
  }

  async #startVisual(input: Readonly<{
    conversation: ProjectConversationRecord;
    turn: ProjectConversationTurnRecord;
    project: ProjectRecord;
    input: Readonly<{ requestKey: string; text: string }>;
    instruction: AgentInstruction;
  }>): Promise<Readonly<{
    assistantText: string;
    actions: readonly Record<string, unknown>[];
    goalVerification: Record<string, unknown>;
  }>> {
    let project = this.store.project(input.project.id);
    if (project.technicalStatus !== "executable") {
      const checked = await this.operations.startProjectTechnicalCheck({
        projectId: project.id,
        commandId: stableId("visual_check", input.input.requestKey),
        expectedWorkspaceDigest: project.workspaceDigest,
      });
      if ((checked.result as any).status !== "succeeded") {
        throw new ApiError(409, "project_not_executable", "The current Project did not pass technical checks.");
      }
      project = this.store.project(project.id);
    }
    if (project.runMode !== "visual" && project.runMode !== "both") {
      throw new ApiError(409, "visual_capability_not_declared", "The current Project does not declare visual execution.");
    }
    const visualConfiguration = defaultVisualExperiment(project.executionDescription);
    const validVisual = (configuration: Record<string, unknown>): boolean => {
      try {
        return planExperiment({
          configuration,
          inputSchema: (project.executionDescription as any).inputs?.schema,
          maxSamples: 1,
        }).configuration.runKind === "visual";
      } catch { return false; }
    };
    let experiment = [...this.store.experiments(project.id)].reverse()
      .find((candidate) => candidate.configuration.runKind === "visual" && validVisual(candidate.configuration));
    if (!experiment) {
      const id = stableId("experiment", `${project.id}:default-visual`);
      const stale = this.store.experiments(project.id).find((item) => item.id === id);
      if (stale) {
        this.store.updateExperiment({
          id,
          projectId: project.id,
          configuration: visualConfiguration,
          updatedAt: this.now(),
        });
      } else {
        this.store.createExperiment({
          id, projectId: project.id, name: "Default visual",
          configuration: visualConfiguration, createdAt: this.now(),
        });
      }
      experiment = this.store.experiments(project.id).find((item) => item.id === id)!;
    }
    const admitted = this.operations.startRunAdmission({
      commandId: stableId("visual_run", input.input.requestKey),
      projectId: project.id,
      experimentConfigurationId: experiment.id,
      runKind: "visual",
      expectedWorkspaceDigest: project.workspaceDigest,
    });
    const html = this.store.projectFiles(project.id).find((file) => file.relativePath === "visual.html")?.bytes.toString("utf8");
    if (!html) throw new ApiError(409, "visual_document_missing", "The Project visual document is missing.");
    await this.visualRuntime.start({ projectId: project.id, runId: admitted.runId, html, at: this.now() });
    const action = Object.freeze({
      id: stableId("action", `${input.turn.id}:visual`),
      actionKind: "run_start",
      permissionDecision: "allowed",
      state: "committed",
      errorCode: null,
    });
    const actions = Object.freeze([action]);
    const verification = goalVerification({
      disposition: "completed", reasonCode: "visual_run_healthy",
      intentKind: "project_visual", actions, affectedResourceCount: 1,
      partialEffect: false, openCodeTerminal: "idle",
    });
    return Object.freeze({
      assistantText: `${input.instruction.assistantText}\n\n可视化 Run 已健康启动，工作台正在打开受限页面。`,
      actions,
      goalVerification: verification,
    });
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

  #failTurn(
    turn: ProjectConversationTurnRecord,
    error: unknown,
    intent: ProjectCommandIntent,
    preliminary: TurnOutcome | null,
  ): Readonly<{
    mode: "live";
    reason: string;
    turn: ProjectConversationTurnRecord;
    messages: readonly ProjectConversationMessageRecord[];
  }> {
    const code = errorCode(error);
    const actions = preliminary?.actions ?? Object.freeze([]);
    const verification = goalVerification({
      disposition: "failed",
      reasonCode: code,
      intentKind: intent.startBatch || intent.interpretResults || intent.updateAndRerun
        ? "project_batch"
        : intent.startVisual || intent.stopVisual ? "project_visual" : "explicit_mutation",
      actions,
      affectedResourceCount: Number((preliminary?.goalVerification as any)?.evidence?.affectedResourceCount ?? 0),
      partialEffect: actions.length > 0 || code === "project_delivery_failed_after_commit",
      openCodeTerminal: "unknown",
    });
    const prefix = preliminary ? `${preliminary.assistantText}\n\n` : "";
    const failed = this.store.failConversationTurn({
      requestKey: turn.requestKey,
      state: "failed",
      code,
      assistantText: `${prefix}OpenCode 未能完成其余操作（${code}）。`,
      actions,
      goalVerification: verification,
      failedAt: this.now(),
    });
    return Object.freeze({
      mode: "live",
      reason: code,
      turn: failed,
      messages: Object.freeze(this.store.conversationMessages(turn.conversationId)),
    });
  }

  #failReadOnly(turn: ProjectConversationTurnRecord, reason: string, preliminary: TurnOutcome | null = null): Readonly<{
    mode: "read_only";
    reason: string;
    turn: ProjectConversationTurnRecord;
    messages: readonly ProjectConversationMessageRecord[];
  }> {
    const actions = preliminary?.actions ?? Object.freeze([]);
    const verification = goalVerification({
      disposition: "read_only", reasonCode: safeReasonCode(reason),
      intentKind: preliminary ? "project_visual" : "response_delivery",
      actions,
      affectedResourceCount: Number((preliminary?.goalVerification as any)?.evidence?.affectedResourceCount ?? 0),
      partialEffect: actions.length > 0,
      openCodeTerminal: "not_reached",
    });
    const failed = this.store.failConversationTurn({
      requestKey: turn.requestKey,
      state: "read_only",
      code: safeReasonCode(reason),
      assistantText: preliminary
        ? `${preliminary.assistantText}\n\nOpenCode 当前不可用；其余操作没有写入 Project。`
        : "OpenCode 当前不可用；本轮没有写入 Project。",
      actions,
      goalVerification: verification,
      failedAt: this.now(),
    });
    return Object.freeze({
      mode: "read_only", reason: safeReasonCode(reason), turn: failed,
      messages: Object.freeze(this.store.conversationMessages(turn.conversationId)),
    });
  }
}

const projectSystemPrompt = (
  project: ProjectRecord,
  files: readonly ProjectFileRecord[],
  experiments: readonly Readonly<{ id: string; name: string; configuration: Record<string, unknown> }>[],
  loadedSkills: readonly LoadedSimulationSkill[] = [],
): string => {
  const fileContext = projectFileContext(files);
  const skillContext = loadedSkillContext(loadedSkills);
  return `You are the modelling agent for one Riff Project. For operations other than deliver_project, return exactly one JSON object with no Markdown fences or outside commentary.
  Choose the operation from the user's message itself. Riff intentionally does not provide a semantic intent label; do not ask for one.
  The phase-one schema is {"operation":"deliver_design"|"deliver_project"|"start_visual"|"stop_visual"|"update_experiment_and_start_batch"|"none","assistantText":string,"designMarkdown"?:string,"inputSchema"?:object,"defaultParameters"?:object,"experimentConfiguration"?:object,"visual"?:{"title"?:string,"summary"?:string,"entities"?:array,"series"?:number[]}}.
  For an explicit request to generate a model design, choose deliver_design and provide a complete Markdown design in designMarkdown: question, scope, entities/agents, state, processes, parameters, outputs, assumptions, validation, and experiment plan. Do not provide executable code for that operation.
  For a concrete modelling requirement, choose deliver_project and return one framed response with exactly this layout: first line RIFF_PROJECT_DELIVERY_V1; then one compact JSON object containing operation=deliver_project, assistantText, visual, inputSchema, and defaultParameters but no modelSource; then a line RIFF_MODEL_SOURCE_V1; then the complete raw Python module. Do not use Markdown fences, encode the Python inside JSON, or add any other marker/commentary. Use Mesa 3 APIs, define a Mesa Model subclass named SimulationModel with a seed-aware constructor accepting every inputSchema property including steps, implement step() and snapshot(), and return JSON-compatible metrics plus per-person position/state data required by the visual design. SimulationModel must call super().__init__(seed=seed). Every Mesa Agent subclass must call super().__init__(model); Mesa 3 assigns unique_id itself, so never pass unique_id to Agent.__init__. Mesa 3 owns Model.steps and wraps step(): never read, create, or increment self._steps, and never increment self.steps manually; use the public self.steps value only for bounded stopping logic. Do not use removed mesa.time schedulers, start a server, or access files/network. Every required inputSchema property must have a value in defaultParameters. The root inputSchema must set $schema to exactly "${JSON_SCHEMA_2020_12}"; never use the Draft-07 URI or omit $schema. The schema must be closed with additionalProperties=false and may only use $schema, $id, $defs, $ref, type, properties, required, additionalProperties, items, minItems, maxItems, enum, const, default, minimum, maximum, exclusiveMinimum, exclusiveMaximum, minLength, and maxLength; omit annotations such as description, title, examples, and $comment.
  For an explicit request to start/open visual simulation, choose start_visual. Do not rewrite the model in that response.
  For a request that only stops/closes visual simulation, choose stop_visual. If the same request also asks to change the Project, choose deliver_project because Riff has already handled the stop directly.
  For an explicit request to change Experiment parameters and rerun a batch, choose update_experiment_and_start_batch and return the complete schemaVersion=1 batch Experiment configuration. Preserve unspecified current parameters and use multiple-seeds or a bounded cartesian sweep.
  For discussion without a requested change, choose none.
  Never ask for confirmation when the user explicitly requested a Project change. Never return none for an explicit mutation.
  Never claim a file was written, checked, or a Run started; Riff verifies those effects after your response.
  Current project: ${project.name}; digest=${project.workspaceDigest}.${skillContext}
  Current authoritative Experiment configurations: ${JSON.stringify(experiments.map(({ id, name, configuration }) => ({ id, name, configuration })))}.
  Authoritative current files follow:\n${fileContext}`;
};

const projectFileContext = (files: readonly ProjectFileRecord[]): string => files.map((file) => {
  const text = file.mediaType.startsWith("text/") || file.relativePath.endsWith(".py")
    || file.relativePath.endsWith(".json") ? file.bytes.toString("utf8").slice(0, 24_000) : "[binary omitted]";
  return `FILE ${file.relativePath}\n${text}`;
}).join("\n\n").slice(0, MAX_PROJECT_CONTEXT_BYTES);

const loadedSkillContext = (loadedSkills: readonly LoadedSimulationSkill[]): string => loadedSkills.length > 0
  ? `\nThe project-local skills listed below are already loaded. Follow the skills relevant to this delivery directly. Do not call or announce loading a skill or any other tool; tools are intentionally unavailable for this bounded response. Treat referenced files that are not included here as unavailable source data and mark unresolved choices explicitly.\n${loadedSkills.map((skill) => `BEGIN LOADED PROJECT SKILL (${skill.id}@${skill.version})\n${skill.instructions.slice(0, 16_000)}\nEND LOADED PROJECT SKILL`).join("\n")}`
  : "\nDo not call or announce loading a skill or any other tool; tools are intentionally unavailable for this bounded response.";

export const parseAgentInstruction = (text: string): AgentInstruction => {
  const candidate = text.trim().replace(/^```(?:json)?\s*/u, "").replace(/\s*```$/u, "");
  let raw: any;
  try { raw = JSON.parse(escapeJsonStringControlCharacters(candidate)); }
  catch { throw new ApiError(502, "opencode_invalid_structured_response", "OpenCode did not return the required JSON object."); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)
    || !["deliver_design", "deliver_project", "start_visual", "stop_visual", "update_experiment_and_start_batch", "none"].includes(raw.operation)
    || typeof raw.assistantText !== "string" || !raw.assistantText.trim() || raw.assistantText.length > 16_000
    || raw.modelSource !== undefined && raw.modelSource !== null
      && (typeof raw.modelSource !== "string" || raw.modelSource.length > 128_000)
    || raw.designMarkdown !== undefined && raw.designMarkdown !== null
      && (typeof raw.designMarkdown !== "string" || raw.designMarkdown.length > 128_000)
    || raw.inputSchema !== undefined && raw.inputSchema !== null
      && (typeof raw.inputSchema !== "object" || Array.isArray(raw.inputSchema))
    || raw.defaultParameters !== undefined && raw.defaultParameters !== null
      && (typeof raw.defaultParameters !== "object" || Array.isArray(raw.defaultParameters))) {
    throw new ApiError(502, "opencode_invalid_structured_response", "OpenCode returned an invalid structured result.");
  }
  return Object.freeze({
    operation: raw.operation,
    assistantText: raw.assistantText.trim(),
    ...(typeof raw.designMarkdown === "string" ? { designMarkdown: raw.designMarkdown } : {}),
    ...(typeof raw.modelSource === "string" ? { modelSource: raw.modelSource } : {}),
    ...(raw.inputSchema && typeof raw.inputSchema === "object" && !Array.isArray(raw.inputSchema)
      ? { inputSchema: Object.freeze(raw.inputSchema) } : {}),
    ...(raw.defaultParameters && typeof raw.defaultParameters === "object" && !Array.isArray(raw.defaultParameters)
      ? { defaultParameters: Object.freeze(raw.defaultParameters) } : {}),
    ...(raw.experimentConfiguration && typeof raw.experimentConfiguration === "object"
      && !Array.isArray(raw.experimentConfiguration)
      ? { experimentConfiguration: Object.freeze(raw.experimentConfiguration) } : {}),
    ...(raw.visual && typeof raw.visual === "object" && !Array.isArray(raw.visual)
      ? { visual: Object.freeze(raw.visual) } : {}),
  });
};

export const parseAgentResponse = (text: string): AgentInstruction => {
  const normalized = text.replace(/\r\n?/gu, "\n").trim();
  if (!normalized.startsWith(PROJECT_DELIVERY_RESPONSE_HEADER)) {
    return parseAgentInstruction(normalized);
  }
  const sourceMarker = `\n${MODEL_SOURCE_RESPONSE_HEADER}`;
  const sourceMarkerAt = normalized.indexOf(sourceMarker, PROJECT_DELIVERY_RESPONSE_HEADER.length);
  if (sourceMarkerAt < 0 || normalized.indexOf(sourceMarker, sourceMarkerAt + sourceMarker.length) >= 0) {
    throw new ApiError(502, "opencode_invalid_project_delivery_frame", "OpenCode did not return the required Project-delivery frame.");
  }
  const instruction = parseAgentInstruction(
    normalized.slice(PROJECT_DELIVERY_RESPONSE_HEADER.length, sourceMarkerAt).trim(),
  );
  if (instruction.operation !== "deliver_project" || instruction.modelSource !== undefined
    || !instruction.inputSchema || !instruction.defaultParameters) {
    throw new ApiError(502, "opencode_invalid_project_delivery_frame", "OpenCode returned invalid Project-delivery metadata.");
  }
  return Object.freeze({
    ...instruction,
    modelSource: parseProjectModelSource(normalized.slice(sourceMarkerAt + 1)),
  });
};

export const parseProjectModelSource = (text: string): string => {
  const normalized = text.replace(/\r\n?/gu, "\n");
  if (!normalized.startsWith(MODEL_SOURCE_RESPONSE_HEADER)) {
    throw new ApiError(502, "opencode_invalid_model_source", "OpenCode did not return the required model-source frame.");
  }
  let source = normalized.slice(MODEL_SOURCE_RESPONSE_HEADER.length);
  const fenced = source.match(/^```(?:python)?\n([\s\S]*)\n```\s*$/u);
  if (fenced) source = fenced[1]!;
  if (!source.trim() || source.length > 128_000 || source.includes(MODEL_SOURCE_RESPONSE_HEADER)) {
    throw new ApiError(502, "opencode_invalid_model_source", "OpenCode returned an invalid model-source frame.");
  }
  return source.endsWith("\n") ? source : `${source}\n`;
};

const escapeJsonStringControlCharacters = (candidate: string): string => {
  let inString = false;
  let escaped = false;
  let normalized = "";
  for (const character of candidate) {
    if (!inString) {
      normalized += character;
      if (character === '"') inString = true;
      continue;
    }
    if (escaped) {
      normalized += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      normalized += character;
      escaped = true;
      continue;
    }
    if (character === '"') {
      normalized += character;
      inString = false;
      continue;
    }
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x1f) {
      normalized += codePoint === 0x08 ? "\\b"
        : codePoint === 0x09 ? "\\t"
          : codePoint === 0x0a ? "\\n"
            : codePoint === 0x0c ? "\\f"
              : codePoint === 0x0d ? "\\r"
                : `\\u${codePoint.toString(16).padStart(4, "0")}`;
      continue;
    }
    normalized += character;
  }
  return normalized;
};

export const projectCommandIntent = (text: string): ProjectCommandIntent => {
  const startVisual = VISUAL_COMMAND.test(text);
  const stopVisual = STOP_VISUAL_FRAGMENT.test(text);
  const startBatch = START_BATCH_COMMAND.test(text);
  const interpretResults = INTERPRET_RESULTS_COMMAND.test(text);
  const updateAndRerun = UPDATE_AND_RERUN_COMMAND.test(text);
  const visualControls = VISUAL_CONTROLS_COMMAND.test(text) || VISUAL_LAYOUT_COMMAND.test(text);
  const residual = stopVisual
    ? text.replace(STOP_VISUAL_FRAGMENT, "").replace(/[\s，,。.!！、；;：:]/gu, "")
    : text.trim();
  const explicitMutation = EXPLICIT_PROJECT_MUTATION.test(text);
  const direct = (stopVisual && residual.length === 0)
    || startVisual
    || (startBatch && !explicitMutation && !updateAndRerun)
    || interpretResults
    || visualControls;
  return Object.freeze({
    startVisual,
    stopVisual,
    startBatch,
    interpretResults,
    updateAndRerun,
    visualControls,
    explicitMutation,
    requiresAgent: !direct,
  });
};

export const parseParameterPatch = (text: string): Readonly<Record<string, unknown>> | null => {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start || end - start > 16_384) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
      || Object.getPrototypeOf(parsed) !== Object.prototype) return null;
    const blocked = new Set(["__proto__", "constructor", "prototype"]);
    if (Object.keys(parsed).some((key) => blocked.has(key))) return null;
    return Object.freeze({ ...parsed });
  } catch {
    return null;
  }
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

const mergeTurnOutcomes = (first: TurnOutcome, second: TurnOutcome): TurnOutcome => {
  const actions = Object.freeze([...first.actions, ...second.actions]);
  const firstVerification = first.goalVerification as any;
  const secondVerification = second.goalVerification as any;
  return Object.freeze({
    assistantText: `${first.assistantText}\n\n${second.assistantText}`,
    actions,
    goalVerification: goalVerification({
      disposition: secondVerification.disposition,
      reasonCode: secondVerification.reasonCode,
      intentKind: secondVerification.evidence?.intentKind ?? "explicit_mutation",
      actions,
      affectedResourceCount:
        Number(firstVerification.evidence?.affectedResourceCount ?? 0)
        + Number(secondVerification.evidence?.affectedResourceCount ?? 0),
      partialEffect: Boolean(firstVerification.evidence?.partialEffect || secondVerification.evidence?.partialEffect),
      openCodeTerminal: secondVerification.evidence?.openCodeTerminal ?? "idle",
    }),
  });
};

/** Keep the backend-owned OpenCode projection equal to the authoritative Store. */
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

const projectChange = (
  existing: ProjectFileRecord | undefined,
  relativePath: string,
  kind: "code" | "environment" | "visual_asset",
  mediaType: string,
  text: string,
): Record<string, unknown> => Object.freeze({
  fileRef: existing?.id ?? null,
  kind,
  relativePath,
  mediaType,
  text,
  expectedPriorSha256: existing?.sha256 ?? null,
});

const executionDescription = (instruction: AgentInstruction): Record<string, unknown> => {
  const fallbackSchema = Object.freeze({
    $schema: JSON_SCHEMA_2020_12,
    type: "object",
    properties: Object.freeze({
      steps: Object.freeze({ type: "integer", minimum: 1, maximum: 1000, default: 100 }),
    }),
    required: Object.freeze(["steps"]),
    additionalProperties: false,
  });
  const schema = normalizeAgentInputSchema(instruction.inputSchema ?? fallbackSchema);
  const smoke = normalizeInputParameters(schema, instruction.defaultParameters ?? { steps: 10 });
  return Object.freeze({
  schemaVersion: 2,
  runtime: "python",
  runMode: "both",
  dependencyFile: "environment/requirements.txt",
  inputs: Object.freeze({
    schemaProfile: INPUT_SCHEMA_PROFILE,
    schema,
    smoke,
  }),
  outputs: Object.freeze([
    Object.freeze({
      logicalName: "summary", relativePath: "summary.json",
      mediaType: "application/json", required: true, role: "data",
    }),
    Object.freeze({
      logicalName: "visual_status", relativePath: "visual-status.json",
      mediaType: "application/json", required: false, role: "diagnostic",
    }),
  ]),
  batch: Object.freeze({ entryPoint: "code/riff_entry.py", protocol: "riff-batch-v1" }),
  visual: Object.freeze({
    entryPoint: "code/visual.py", protocol: "riff-visual-v1", healthPath: "/health",
  }),
  cancellation: Object.freeze({ signal: "SIGTERM", graceMs: 2_000 }),
  });
};

const INPUT_SCHEMA_ANNOTATIONS = new Set(["description", "title", "examples", "$comment", "readOnly", "writeOnly"]);

export const normalizeAgentInputSchema = (input: unknown): ReturnType<typeof validateInputSchema> => {
  const stripNode = (value: unknown, namedSchemaMap = false): unknown => {
    if (typeof value === "boolean") return value;
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(source)) {
      if (namedSchemaMap) {
        result[key] = stripNode(item);
        continue;
      }
      if (INPUT_SCHEMA_ANNOTATIONS.has(key)) continue;
      if (key === "properties" || key === "$defs") {
        result[key] = stripNode(item, true);
      } else if (key === "items" || key === "additionalProperties") {
        result[key] = stripNode(item);
      } else {
        result[key] = item;
      }
    }
    return result;
  };
  return validateInputSchema(stripNode(input));
};

const defaultVisualExperiment = (executionDescription: Record<string, unknown>): Record<string, unknown> => Object.freeze({
  schemaVersion: 1,
  runKind: "visual",
  parameters: Object.freeze({ ...((executionDescription as any).inputs?.smoke ?? { steps: 10 }) }),
  sampling: Object.freeze({ kind: "single", seed: 1 }),
});

const defaultBatchExperiment = (
  executionDescription: Record<string, unknown>,
  sampleCount: number,
): Record<string, unknown> => {
  const smoke = (executionDescription as any).inputs?.smoke;
  const parameters = smoke && typeof smoke === "object" && !Array.isArray(smoke) ? { ...smoke } : { steps: 100 };
  return Object.freeze({
    schemaVersion: 1,
    runKind: "batch",
    parameters: Object.freeze(parameters),
    sampling: Object.freeze({
      kind: "multiple-seeds",
      seeds: Object.freeze(Array.from({ length: sampleCount }, (_, index) => index + 1)),
    }),
  });
};

const summarizeNumericMetrics = (values: readonly unknown[]): Array<Readonly<{
  path: string;
  count: number;
  mean: number;
  min: number;
  max: number;
}>> => {
  const collected = new Map<string, number[]>();
  const visit = (value: unknown, path: string): void => {
    if (typeof value === "number" && Number.isFinite(value)) {
      const bucket = collected.get(path) ?? [];
      bucket.push(value);
      collected.set(path, bucket);
      return;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      visit(item, path ? `${path}.${key}` : key);
    }
  };
  for (const value of values) visit(value, "");
  return [...collected.entries()].map(([path, items]) => Object.freeze({
    path,
    count: items.length,
    mean: items.reduce((sum, item) => sum + item, 0) / items.length,
    min: Math.min(...items),
    max: Math.max(...items),
  })).sort((left, right) => left.path.localeCompare(right.path));
};

const formatNumber = (value: number): string => Number.isInteger(value)
  ? String(value)
  : value.toLocaleString("zh-CN", { maximumFractionDigits: 4 });

export const PROJECT_ONLY_BATCH_ENTRY_SOURCE = `from __future__ import annotations
import argparse
import importlib
import inspect
import json
import math
import re
import signal
import time
from pathlib import Path

import mesa

def _snake(name: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()

def _json_value(value):
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {str(key): _json_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_value(item) for item in value]
    if hasattr(value, "item"):
        return _json_value(value.item())
    return str(value)

def _model_class(module):
    candidate = getattr(module, "SimulationModel", None)
    if inspect.isclass(candidate) and issubclass(candidate, mesa.Model):
        return candidate
    choices = [value for value in vars(module).values()
               if inspect.isclass(value) and value is not mesa.Model and issubclass(value, mesa.Model)
               and value.__module__ == module.__name__]
    if len(choices) != 1:
        raise ValueError("model.py must define one Mesa Model subclass or SimulationModel")
    return choices[0]

def _construct(model_class, parameters: dict, seed):
    signature = inspect.signature(model_class)
    accepts_extra = any(item.kind == inspect.Parameter.VAR_KEYWORD for item in signature.parameters.values())
    normalized = {_snake(str(key)): value for key, value in parameters.items()}
    kwargs = normalized if accepts_extra else {key: value for key, value in normalized.items() if key in signature.parameters}
    if "seed" in signature.parameters and "seed" not in kwargs:
        kwargs["seed"] = seed
    return model_class(**kwargs)

def _snapshot(model):
    for name in ("snapshot", "summary"):
        method = getattr(model, name, None)
        if callable(method):
            value = method()
            if not isinstance(value, dict):
                raise ValueError(f"{name}() must return a dictionary")
            return _json_value(value)
    collector = getattr(model, "datacollector", None)
    if collector is not None and hasattr(collector, "get_model_vars_dataframe"):
        frame = collector.get_model_vars_dataframe()
        if len(frame.index):
            return _json_value(frame.iloc[-1].to_dict())
    return {key: _json_value(value) for key, value in vars(model).items()
            if not key.startswith("_") and isinstance(value, (str, bool, int, float, type(None)))}

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--riff-input", type=Path)
    parser.add_argument("--riff-output-dir", type=Path)
    parser.add_argument("--riff-cancellation-probe", action="store_true")
    args = parser.parse_args()
    if args.riff_cancellation_probe:
        signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(SystemExit(0)))
        print("RIFF_CANCELLATION_READY", flush=True)
        while True:
            time.sleep(0.05)
    if args.riff_input is None or args.riff_output_dir is None:
        parser.error("--riff-input and --riff-output-dir are required")
    envelope = json.loads(args.riff_input.read_text(encoding="utf-8"))
    required = {"schemaVersion", "runId", "sampleIndex", "sampleId", "parameters", "seed"}
    if not isinstance(envelope, dict) or set(envelope) != required or envelope["schemaVersion"] != 1:
        raise ValueError("input must be a riff-batch-v1 envelope")
    parameters = dict(envelope["parameters"])
    steps = parameters.pop("steps", 100)
    if type(steps) is not int or not 1 <= steps <= 1000:
        raise ValueError("steps must be an integer from 1 through 1000")
    module = importlib.import_module("model")
    model = _construct(_model_class(module), parameters, envelope["seed"])
    completed_steps = 0
    for _ in range(steps):
        if getattr(model, "running", True) is False:
            break
        model.step()
        completed_steps += 1
    output = {
        "schemaVersion": 1,
        "sampleIndex": envelope["sampleIndex"],
        "sampleId": envelope["sampleId"],
        "seed": envelope["seed"],
        "completedSteps": completed_steps,
        "metrics": _snapshot(model),
    }
    args.riff_output_dir.mkdir(parents=True, exist_ok=True)
    (args.riff_output_dir / "summary.json").write_text(
        json.dumps(output, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\\n",
        encoding="utf-8",
    )
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
`;

export const PROJECT_ONLY_VISUAL_SERVER_SOURCE = `from __future__ import annotations
import argparse
import json
import signal
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HTML = (Path(__file__).resolve().parent.parent / "visual.html").read_bytes()

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            body = b'{"status":"ok"}\\n'
            self.send_response(200); self.send_header("Content-Type", "application/json")
        elif self.path in ("/", "/index.html"):
            body = HTML
            self.send_response(200); self.send_header("Content-Type", "text/html; charset=utf-8")
        else:
            body = b""; self.send_response(404)
        self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def log_message(self, *_args):
        return

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--riff-health-check")
    parser.add_argument("--riff-cancellation-probe", action="store_true")
    parser.add_argument("--riff-input")
    parser.add_argument("--riff-output-dir")
    parser.add_argument("--riff-host", default="127.0.0.1")
    parser.add_argument("--riff-port", type=int, default=0)
    args = parser.parse_args()
    if args.riff_health_check:
        raise SystemExit(0 if args.riff_health_check == "/health" and HTML else 1)
    if args.riff_cancellation_probe:
        def exit_on_signal(*_args):
            raise SystemExit(0)
        signal.signal(signal.SIGTERM, exit_on_signal)
        while True: time.sleep(1)
    server = ThreadingHTTPServer((args.riff_host, args.riff_port), Handler)
    signal.signal(signal.SIGTERM, lambda *_: server.shutdown())
    server.serve_forever()

if __name__ == "__main__":
    main()
`;

export const buildProjectVisualHtml = (
  projectName: string,
  requirement: string,
  visual?: AgentInstruction["visual"],
): string => {
  const title = boundedText(visual?.title, projectName);
  const summary = boundedText(visual?.summary, requirement);
  const entities = Array.isArray(visual?.entities) && visual.entities.length
    ? visual.entities.slice(0, 12).map((entity, index) => ({
      name: boundedText(entity?.name, `Agent ${index + 1}`),
      color: /^#[0-9a-fA-F]{6}$/u.test(String(entity?.color ?? "")) ? entity!.color : palette[index % palette.length],
      value: Number.isFinite(entity?.value) ? Math.max(0, Math.min(100, Number(entity!.value))) : 35 + index * 7,
    }))
    : [
      { name: "Agent flow", color: "#7dd3fc", value: 72 },
      { name: "Resource load", color: "#facc15", value: 48 },
      { name: "Completed", color: "#86efac", value: 64 },
    ];
  const series = Array.isArray(visual?.series) && visual.series.length > 2
    ? visual.series.slice(0, 48).map((value) => Number.isFinite(value) ? Number(value) : 0)
    : [12, 18, 15, 27, 33, 29, 41, 52, 47, 61, 68, 74];
  const data = JSON.stringify({ title, summary, entities, series }).replaceAll("<", "\\u003c");
  const maximum = Math.max(...series, 1);
  const minimum = Math.min(...series, 0);
  const span = Math.max(1, maximum - minimum);
  const points = series.map((value, index) => [
    40 + index * (660 / Math.max(1, series.length - 1)),
    275 - (value - minimum) / span * 230,
  ]);
  const pointText = points.map((point) => point.join(",")).join(" ");
  const dotHtml = points.map((point) => `<circle class="dot" cx="${point[0]}" cy="${point[1]}" r="4"/>`).join("");
  const entityHtml = entities.map((entity) => `<div class="entity"><span>${htmlEscape(entity.name)}</span><div class="bar"><i style="width:${entity.value}%;background:${entity.color}"></i></div><b>${Math.round(entity.value)}</b></div>`).join("");
  const layoutRequested = VISUAL_LAYOUT_COMMAND.test(requirement);
  const layoutHtml = layoutRequested ? `<section class="layout-card" aria-labelledby="deck-layout-title"><style>.layout-card{background:#0c1829dd;border:1px solid #213450;border-radius:16px;padding:18px;box-shadow:0 18px 60px #0005}.layout-head{display:flex;justify-content:space-between;gap:18px;align-items:start}.layout-head p{color:#9fb2cc;margin:.4rem 0 0}.deck-tabs{display:flex;flex-wrap:wrap;gap:7px;margin:16px 0}.deck-tabs button{border:1px solid #31527b;background:#12253f;color:#e8f0ff;border-radius:9px;padding:7px 10px;cursor:pointer;font-size:12px}.deck-tabs button.active,.deck-tabs button:focus-visible{background:#1b385e;outline:2px solid #7dd3fc;outline-offset:2px}.deck-summary{display:flex;gap:12px;align-items:center;color:#9fb2cc;margin-bottom:14px}.deck-summary strong{color:#e8f0ff}.deck-map{display:grid;grid-template-columns:repeat(10,minmax(48px,1fr));gap:7px;padding:14px;border:1px solid #213450;border-radius:12px;background:#081424}.room{min-height:48px;border:1px solid #2b4869;border-radius:7px;background:#112944;padding:6px;display:flex;flex-direction:column;justify-content:space-between;gap:4px;font-size:10px;color:#a9bed8}.room small{color:#6f89a6}.room-dot{width:8px;height:8px;border-radius:50%;display:inline-block;box-shadow:0 0 0 2px #07101f}.state-legend{display:flex;flex-wrap:wrap;gap:8px;justify-content:end;font-size:11px;color:#9fb2cc}.state-legend span{white-space:nowrap}.state-legend i{width:9px;height:9px;border-radius:50%;display:inline-block;margin-right:3px}.state-s{background:#60a5fa}.state-e{background:#facc15}.state-i{background:#f87171}.state-r{background:#4ade80}@media(max-width:760px){.layout-head{flex-direction:column}.deck-map{grid-template-columns:repeat(5,minmax(48px,1fr))}.state-legend{justify-content:start}}</style><div class="layout-head"><div><h2 id="deck-layout-title">游轮舱室布局</h2><p>13层甲板：10层客房、2层公共区、1层工作人员宿舍。点击楼层查看舱室分区。</p></div><div class="state-legend" aria-label="SEIR状态图例"><span><i class="state-s"/>S 易感</span><span><i class="state-e"/>E 潜伏</span><span><i class="state-i"/>I 感染</span><span><i class="state-r"/>R 康复</span></div></div><nav class="deck-tabs" aria-label="甲板楼层"><button data-deck="0">公共区 1</button><button data-deck="1">公共区 2</button>${Array.from({ length: 10 }, (_, index) => `<button data-deck="${index + 2}">客房甲板 ${index + 1}</button>`).join("")}<button data-deck="12">员工宿舍</button></nav><div class="deck-summary"><strong id="deck-name">客房甲板 1</strong><span id="deck-detail">40间客房 · 每间2个位置 · 员工清扫动线</span></div><div id="deck-map" class="deck-map" role="grid" aria-label="当前甲板舱室网格"></div></section>` : "";
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${htmlEscape(title)}</title><style>
:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui;background:#07101f;color:#e8f0ff}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at 15% 15%,#16365f 0,transparent 34%),#07101f}.wrap{padding:28px;display:grid;gap:20px}.head{display:flex;justify-content:space-between;align-items:end}.head p{max-width:720px;color:#9fb2cc;margin:.5rem 0 0}.badge{border:1px solid #2f8f72;color:#8ff0c8;border-radius:999px;padding:7px 11px}.controls{display:flex;flex-wrap:wrap;gap:9px;align-items:center}.controls button{border:1px solid #31527b;background:#12253f;color:#e8f0ff;border-radius:9px;padding:8px 14px;cursor:pointer}.controls button:hover,.controls button:focus-visible{background:#1b385e;outline:2px solid #7dd3fc;outline-offset:2px}.controls output{color:#8ff0c8;margin-left:4px}.grid{display:grid;grid-template-columns:1.4fr .8fr;gap:18px}.card{background:#0c1829dd;border:1px solid #213450;border-radius:16px;padding:18px;box-shadow:0 18px 60px #0005}svg{width:100%;height:320px}.axis{stroke:#29405d;stroke-width:1}.line{fill:none;stroke:#7dd3fc;stroke-width:4;stroke-linecap:round}.dot{fill:#e8f0ff}.entity{display:grid;grid-template-columns:110px 1fr 42px;gap:10px;align-items:center;margin:18px 0}.bar{height:10px;background:#172942;border-radius:99px;overflow:hidden}.bar i{display:block;height:100%;border-radius:inherit;transition:width .25s}.ticker{font-variant-numeric:tabular-nums;color:#8ff0c8}footer{color:#7086a4;font-size:12px}@media(max-width:760px){.grid{grid-template-columns:1fr}.head{align-items:start;flex-direction:column;gap:12px}}
</style></head><body><main class="wrap"><header class="head"><div><h1>${htmlEscape(title)}</h1><p>${htmlEscape(summary)}</p></div><span class="badge">● READY · riff-visual-v1</span></header><nav class="controls" aria-label="仿真控制"><button id="reset" type="button">重置</button><button id="start" type="button">开始</button><button id="step-once" type="button">单步</button><button id="pause" type="button">暂停</button><output id="control-state" aria-live="polite">已暂停</output></nav><section class="grid"><article class="card"><h2>仿真趋势</h2><svg viewBox="0 0 720 320" role="img" aria-label="仿真指标趋势"><path class="axis" d="M40 275H700M40 30V275"/><polyline class="line" points="${pointText}"/><g>${dotHtml}</g></svg><p class="ticker">Step <b id="step">1</b> · 当前指标 <b id="metric">${series[0] ?? 0}</b></p></article><aside class="card"><h2>主体与资源</h2><div id="entities">${entityHtml}</div></aside></section>${layoutHtml}<footer>控制按钮驱动当前 Run 的可视化投影；Project/Run 权威状态与批量证据保存在 Riff Store。</footer></main><script>
const d=${data};const stepNode=document.getElementById('step');const metricNode=document.getElementById('metric');const entityRoot=document.getElementById('entities');const stateNode=document.getElementById('control-state');let i=0;let timer=null;const render=()=>{stepNode.textContent=String(i+1);metricNode.textContent=String(d.series[i]);d.entities.forEach((e,n)=>{e.value=Math.max(8,Math.min(96,e.value+Math.sin(i+n)*3))});entityRoot.querySelectorAll('.bar i').forEach((el,n)=>el.style.width=d.entities[n].value+'%');entityRoot.querySelectorAll('.entity b').forEach((el,n)=>el.textContent=String(Math.round(d.entities[n].value)))};const advance=()=>{i=(i+1)%d.series.length;render()};const pause=()=>{if(timer!==null){clearInterval(timer);timer=null}stateNode.textContent='已暂停'};document.getElementById('reset').addEventListener('click',()=>{pause();i=0;render();stateNode.textContent='已重置'});document.getElementById('start').addEventListener('click',()=>{if(timer===null)timer=setInterval(advance,700);stateNode.textContent='运行中'});document.getElementById('step-once').addEventListener('click',()=>{pause();advance();stateNode.textContent='已单步'});document.getElementById('pause').addEventListener('click',pause);render();
</script>${layoutRequested ? `<script>const deckName=document.getElementById('deck-name');const deckDetail=document.getElementById('deck-detail');const deckMap=document.getElementById('deck-map');const deckLabels=['公共区 1','公共区 2',...Array.from({length:10},(_,n)=>'客房甲板 '+(n+1)),'员工宿舍'];const paintDeck=(deck)=>{const cabin=deck>=2&&deck<=11;deckName.textContent=deckLabels[deck];deckDetail.textContent=cabin?'40间客房 · 每间2个位置 · 员工清扫动线':deck===12?'工作人员宿舍 · 集体空间 · 休息与交接班':'公共区 · 餐厅、剧场与阳光甲板';deckMap.innerHTML='';const count=cabin?40:12;for(let n=0;n<count;n++){const room=document.createElement('div');room.className='room';room.setAttribute('role','gridcell');room.innerHTML='<span>'+(cabin?'舱室':'区域')+' '+String(n+1).padStart(2,'0')+'</span><small>'+(cabin?'2人':'公共空间')+'</small><i class="room-dot state-'+['s','e','i','r'][n%4]+'" aria-label="SEIR状态"></i>';deckMap.appendChild(room)}};document.querySelectorAll('[data-deck]').forEach((button)=>button.addEventListener('click',()=>{document.querySelectorAll('[data-deck]').forEach((item)=>item.classList.remove('active'));button.classList.add('active');paintDeck(Number(button.dataset.deck))}));document.querySelector('[data-deck="2"]').classList.add('active');paintDeck(2);</script>` : ''}</body></html>`;
};

const palette = ["#7dd3fc", "#facc15", "#86efac", "#f9a8d4", "#c4b5fd", "#fdba74"];
const boundedText = (value: unknown, fallback: string): string => {
  const text = typeof value === "string" ? value.trim() : "";
  return (text || fallback).slice(0, 500);
};
const htmlEscape = (value: string): string => value.replace(/[&<>"']/gu, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[character]!));

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
