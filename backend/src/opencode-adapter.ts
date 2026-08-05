import { createHash, randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { ApiError } from "./errors.ts";
import { canonicalJsonV2 } from "./canonical-json-v2.ts";
import {
  agentToolOperationCommitment,
  CONSEQUENTIAL_AGENT_TOOLS,
  isAgentToolName,
  legacyPromptToolsCompatible,
  type AgentToolName,
} from "./agent-tools.ts";
import {
  BROWSER_AGENT_ACTION_BUDGET,
  BROWSER_AGENT_GRANT_TTL_MS,
  browserAgentOperationCommitment,
  isBrowserAgentToolName,
} from "./browser-agent-tools.ts";
import type { AgentStatus } from "./types.ts";

export type OpenCodeReadiness = {
  status: AgentStatus;
  modelId: string | null;
  lastError?: { code: string; message: string };
  version?: string;
};

export type OpenCodePrompt = {
  text: string;
  system: string;
  attachments: Array<{ id: string; mediaType: string; workspaceRelativePath: string }>;
  /** Exact discovered primary/all Agent name. Never inferred from assistant text. */
  agentName?: string;
  /** Backend-only binding for one short-lived, capability-scoped Riff MCP server. */
  scopedMcpScopeId?: string;
  /** Exact, sorted tools from the matching Riff capability grant. */
  scopedMcpTools?: readonly AgentToolName[];
};

export type OpenCodeProviderModel = {
  providerId: string;
  modelId: string;
  qualifiedId: string;
};

export type OpenCodeAgent = {
  name: string;
  description: string | null;
  mode: "primary" | "all";
  native: boolean;
};

export type OpenCodeRuntimeTool = {
  id: string;
  tool: string;
  title: string | null;
  status: "pending" | "running" | "completed" | "error";
};

export type OpenCodeRuntimeInteraction =
  | {
      id: string;
      kind: "permission";
      title: string;
      permission: string;
    }
  | {
      id: string;
      kind: "question";
      questions: Array<{
        header: string;
        question: string;
        multiple: boolean;
        custom: boolean;
        options: Array<{ id: string; label: string; description: string }>;
      }>;
    };

export type OpenCodeConversationRuntimeSnapshot = {
  status: "busy" | "retry" | "idle";
  assistant: {
    status: "streaming" | "complete" | "error";
    text: string;
  } | null;
  tools: OpenCodeRuntimeTool[];
  interactions: OpenCodeRuntimeInteraction[];
  failureCode: "opencode_auth_failed" | "opencode_session_aborted" | "opencode_session_error" | null;
  scopedMcp: { label: "Riff tools"; status: "connected" | "disconnected" | "unavailable" };
};

export type OpenCodePermissionAuthority = Readonly<{
  toolName: AgentToolName;
  operationCommitment: string;
}>;

export type OpenCodeAssistantResponse = {
  messageId: string | null;
  text: string;
  content: {
    source: "opencode";
    textParts: number;
    parts: Array<{
      ordinal: number;
      kind: "text" | "tool";
      state: "complete";
      toolName?: string;
    }>;
  };
};

export type OpenCodeRuntimeEvent = { id?: string; type?: string; properties?: Record<string, unknown> };

/**
 * Backend-only Product workspace identity. The directory is always resolved by
 * Riff from the durable Conversation owner; browser input must never populate it.
 */
export type OpenCodeWorkspaceBinding = Readonly<{
  owner: { kind: "model" | "project" | "workspace"; id: string };
  directory: string;
}>;

/** Legacy Gate adapter retained while the old server routes are migrated. */
export interface OpenCodeAdapter {
  initialize(): Promise<OpenCodeReadiness>;
  createSession(projectId: string): Promise<string>;
  prompt(sessionId: string, prompt: OpenCodePrompt, signal?: AbortSignal): Promise<void>;
  abort(sessionId: string): Promise<void>;
  bindProject?(projectId: string, mcpUrl: string): Promise<void>;
  subscribeEvents?(listener: (event: OpenCodeRuntimeEvent) => void): Promise<() => void>;
}

/** Narrow A2 port: provider/model is explicit on every prompt. */
export interface OpenCodeConversationPort {
  /** Optional for test/fake ports; production adapters use it to establish the live server contract. */
  initialize?(): Promise<OpenCodeReadiness>;
  discoverProviderModels(workspace?: OpenCodeWorkspaceBinding): Promise<OpenCodeProviderModel[]>;
  discoverAgents?(workspace: OpenCodeWorkspaceBinding): Promise<OpenCodeAgent[]>;
  getSession(sessionId: string, workspace: OpenCodeWorkspaceBinding): Promise<boolean>;
  createSession(conversationId: string, workspace: OpenCodeWorkspaceBinding): Promise<string>;
  injectContext(
    sessionId: string,
    context: string,
    signal: AbortSignal | undefined,
    workspace: OpenCodeWorkspaceBinding,
  ): Promise<void>;
  promptWithModel(
    sessionId: string,
    binding: { providerId: string; modelId: string },
    prompt: OpenCodePrompt,
    signal: AbortSignal | undefined,
    workspace: OpenCodeWorkspaceBinding,
  ): Promise<OpenCodeAssistantResponse>;
  abort(sessionId: string, workspace: OpenCodeWorkspaceBinding): Promise<void>;
  runtimeSnapshot?(
    sessionId: string,
    scopedMcpScopeId: string | undefined,
    workspace: OpenCodeWorkspaceBinding,
  ): Promise<OpenCodeConversationRuntimeSnapshot>;
  respondPermission?(
    sessionId: string,
    publicRequestId: string,
    response: "once" | "reject",
    workspace: OpenCodeWorkspaceBinding,
    expectedAuthority?: OpenCodePermissionAuthority,
  ): Promise<void>;
  resolvePermissionAuthority?(
    sessionId: string,
    publicRequestId: string,
    workspace: OpenCodeWorkspaceBinding,
  ): Promise<OpenCodePermissionAuthority | null>;
  respondQuestion?(
    sessionId: string,
    publicRequestId: string,
    response: { answers: string[][] } | { reject: true },
    workspace: OpenCodeWorkspaceBinding,
  ): Promise<void>;
  releaseRuntimeBoundary?(sessionId: string, workspace: OpenCodeWorkspaceBinding): void;
  bindScopedMcp?(
    scopeId: string,
    mcpUrl: string,
    allowedTools: readonly AgentToolName[],
    workspace: OpenCodeWorkspaceBinding,
  ): Promise<void>;
  unbindScopedMcp?(scopeId: string, workspace: OpenCodeWorkspaceBinding): Promise<void>;
}

export type OpenCodeConfig = {
  baseUrl?: string;
  /** Canonical directory that the separately-started OpenCode Server must report from /path. */
  workdir?: string;
  /** Exact server version selected for this local compatibility contract. */
  expectedVersion?: string;
  serverUsername?: string;
  serverPassword?: string;
  model?: string;
  allowedProviders?: string[];
  skipLive?: boolean;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
  maxEventBufferBytes?: number;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_000_000;
const DEFAULT_MAX_EVENT_BUFFER_BYTES = 256_000;

export class HttpOpenCodeAdapter implements OpenCodeAdapter, OpenCodeConversationPort {
  readonly #fetch: typeof fetch;
  private readonly config: OpenCodeConfig;
  readonly #mcpProjects = new Map<string, string>();
  readonly #scopedMcp = new Map<string, {
    name: string;
    url: string;
    directory: string;
    allowedTools: readonly AgentToolName[];
  }>();
  readonly #runtimeBoundaries = new Map<string, {
    priorMessageIds: Set<string>;
    userMessageId: string | null;
    workspace: OpenCodeWorkspaceBinding | undefined;
    failureBoundaryId: string | null;
    scopedMcpScopeId: string | undefined;
  }>();
  readonly #permissionAuthorities = new Map<string, Readonly<{
    authority: OpenCodePermissionAuthority;
    upstreamId: string;
    messageId: string;
    callId: string;
    scopedToolName: string;
  }>>();
  readonly #baseUrl?: URL;
  readonly #requestTimeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #maxEventBufferBytes: number;
  #readiness: OpenCodeReadiness = { status: "unconfigured", modelId: null };

  constructor(config: OpenCodeConfig) {
    this.config = config;
    this.#fetch = config.fetch ?? fetch;
    this.#baseUrl = config.baseUrl ? loopbackHttpUrl(config.baseUrl, "OpenCode URL") : undefined;
    this.#requestTimeoutMs = positiveLimit(config.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, "OpenCode request timeout");
    this.#maxResponseBytes = positiveLimit(config.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, "OpenCode response limit");
    this.#maxEventBufferBytes = positiveLimit(config.maxEventBufferBytes, DEFAULT_MAX_EVENT_BUFFER_BYTES, "OpenCode event buffer limit");
  }

  async initialize(): Promise<OpenCodeReadiness> {
    return this.#checkReadiness(undefined, true);
  }

  async #checkReadiness(
    workspace: OpenCodeWorkspaceBinding | undefined,
    verifyConfiguredModel: boolean,
    signal?: AbortSignal,
  ): Promise<OpenCodeReadiness> {
    if (this.config.skipLive) {
      // Compatibility-only deterministic mode for the old component-test route.
      this.#readiness = { status: "ready", modelId: "dev/deterministic" };
      return this.#readiness;
    }
    if (!this.#baseUrl) return this.#setReadinessError("opencode_unconfigured", "Set OPENCODE_URL and OPENCODE_MODEL to enable the modelling assistant.");
    if (!this.config.model) return this.#setReadinessError("opencode_model_unconfigured", "Select an explicit provider/model before enabling the modelling assistant.");
    if (!this.config.workdir) return this.#setReadinessError("opencode_workdir_unconfigured", "Set an explicit OPENCODE_WORKDIR before enabling the modelling assistant.");
    let workdir: string;
    try {
      normalizeOpenCodeWorkdir(this.config.workdir);
      workdir = this.#workspaceDirectory(workspace);
    }
    catch { return this.#setReadinessError("opencode_invalid_workdir", "OPENCODE_WORKDIR must be an absolute existing directory."); }
    if (!this.config.expectedVersion) return this.#setReadinessError("opencode_version_unconfigured", "Set an explicit OPENCODE_EXPECTED_VERSION before enabling the modelling assistant.");
    let expectedVersion: string;
    try { expectedVersion = requiredOpenCodeVersion(this.config.expectedVersion); }
    catch { return this.#setReadinessError("opencode_invalid_version", "OPENCODE_EXPECTED_VERSION must be a non-empty printable version string."); }
    try {
      const binding = splitQualifiedModel(this.config.model);
      const allowed = new Set((this.config.allowedProviders ?? []).map((value) => value.trim()).filter(Boolean));
      if (allowed.size && !allowed.has(binding.providerId)) {
        return this.#setReadinessError("opencode_provider_not_allowed", "The configured OpenCode provider is not approved.");
      }
      const health = await this.#json(
        "/global/health",
        signal ? { signal } : {},
      );
      const version = openCodeVersion(health);
      if (health.healthy !== true || !version) {
        return this.#setReadinessError("opencode_unavailable", "The local OpenCode server did not report a healthy compatible version.");
      }
      if (version !== expectedVersion) {
        return this.#setReadinessError("opencode_version_mismatch", "The local OpenCode server version does not match this Riff deployment.");
      }
      const activePath = await this.#json(
        "/path",
        signal ? { signal } : {},
        workdir,
      );
      const activeWorkdir = openCodePath(activePath);
      if (!activeWorkdir) {
        return this.#setReadinessError("opencode_unavailable", "The local OpenCode server did not report its active directory.");
      }
      if (activeWorkdir !== workdir) {
        return this.#setReadinessError("opencode_workdir_mismatch", "The local OpenCode server is running from a different directory.");
      }
      if (verifyConfiguredModel) {
        const models = await this.#discoverProviderModelsUnchecked(workdir, signal);
        const candidate = models.find((item) => item.providerId === binding.providerId && item.modelId === binding.modelId);
        if (!candidate) return this.#setReadinessError("opencode_model_unavailable", "The configured OpenCode model was not found in the live provider catalogue.");
      }
      this.#readiness = { status: "ready", modelId: `${binding.providerId}/${binding.modelId}`, version };
      return this.#readiness;
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      return this.#setReadinessError(
        error instanceof ApiError && error.status === 401 ? "opencode_auth_failed" : "opencode_unavailable",
        error instanceof ApiError && error.status === 401 ? "OpenCode rejected the local server credential." : "The local OpenCode server is not reachable.",
      );
    }
  }

  async discoverProviderModels(workspace?: OpenCodeWorkspaceBinding): Promise<OpenCodeProviderModel[]> {
    await this.#ensureReady(workspace);
    return this.#discoverProviderModelsUnchecked(this.#workspaceDirectory(workspace));
  }

  async discoverAgents(workspace: OpenCodeWorkspaceBinding): Promise<OpenCodeAgent[]> {
    await this.#ensureReady(workspace);
    const directory = this.#workspaceDirectory(workspace);
    const payload = await this.#list("/agent", undefined, directory);
    return discoveredAgents(payload);
  }

  async #discoverProviderModelsUnchecked(
    directory?: string,
    signal?: AbortSignal,
  ): Promise<OpenCodeProviderModel[]> {
    this.#requireLiveBaseUrl();
    const payload = await this.#json(
      "/config/providers",
      signal ? { signal } : {},
      directory,
    );
    const allowed = new Set((this.config.allowedProviders ?? []).map((value) => value.trim()).filter(Boolean));
    return discoveredProviderModels(payload).filter((item) => !allowed.size || allowed.has(item.providerId));
  }

  async getSession(sessionId: string, workspace?: OpenCodeWorkspaceBinding): Promise<boolean> {
    await this.#ensureReady(workspace);
    this.#requireLiveBaseUrl();
    assertOpaqueId(sessionId, "OpenCode session ID");
    return this.#sessionMatchesWorkspace(
      sessionId,
      this.#workspaceDirectory(workspace),
    );
  }

  async createSession(
    projectOrConversationId: string,
    workspace?: OpenCodeWorkspaceBinding,
  ): Promise<string> {
    if (this.config.skipLive) return `dev-${projectOrConversationId}-${randomUUID()}`;
    await this.#ensureReady(workspace);
    this.#requireLiveBaseUrl();
    const directory = this.#workspaceDirectory(workspace);
    const session = await this.#json("/session", {
      method: "POST",
      body: JSON.stringify({ title: `Riff ${safeTitleFragment(projectOrConversationId)}` }),
    }, directory);
    if (openCodePath(session) !== directory) {
      throw new ApiError(
        502,
        "opencode_session_workspace_mismatch",
        "OpenCode created the session in a different Product workspace.",
      );
    }
    const sessionId = String(session.id ?? session.sessionID ?? "");
    if (!sessionId) throw new ApiError(502, "opencode_invalid_session", "OpenCode did not return a session ID.");
    assertOpaqueId(sessionId, "OpenCode session ID");
    return sessionId;
  }

  async injectContext(
    sessionId: string,
    context: string,
    signal?: AbortSignal,
    workspace?: OpenCodeWorkspaceBinding,
  ): Promise<void> {
    if (this.config.skipLive) return;
    assertOpaqueId(sessionId, "OpenCode session ID");
    if (!context) return;
    // Do not persist reconstruction context as a synthetic user message.
    // OpenCode can later treat that no-reply message as the parent of the first
    // real prompt, causing the next synchronous prompt to return the previous
    // assistant response. The bounded context is supplied as `system` on every
    // real prompt instead, so a recreated session remains deterministic without
    // corrupting message ordering.
    void signal;
    void workspace;
  }

  async promptWithModel(
    sessionId: string,
    binding: { providerId: string; modelId: string },
    prompt: OpenCodePrompt,
    signal?: AbortSignal,
    workspace?: OpenCodeWorkspaceBinding,
  ): Promise<OpenCodeAssistantResponse> {
    if (this.config.skipLive) throw new ApiError(503, "opencode_canned_forbidden", "A live OpenCode response is required.");
    await this.#ensureReady(workspace);
    assertOpaqueId(sessionId, "OpenCode session ID");
    const model = validatedModelReference(binding);
    const allowed = new Set((this.config.allowedProviders ?? []).map((value) => value.trim()).filter(Boolean));
    if (allowed.size && !allowed.has(model.providerID)) throw new ApiError(503, "opencode_provider_not_allowed", "The selected OpenCode provider is not allowed.");
    const attachmentText = prompt.attachments.map((attachment) =>
      `- attachment ${safeContextLabel(attachment.id)}: ${safeContextLabel(attachment.mediaType)}, ${safeContextLabel(attachment.workspaceRelativePath)}`,
    ).join("\n");
    const parts = [{ type: "text", text: `${prompt.text}\n\nAttachments:\n${attachmentText || "(none)"}` }];
    const deadlineSignal = signal ?? AbortSignal.timeout(this.#requestTimeoutMs);
    const directory = this.#workspaceDirectory(workspace);
    let lifecycle: OpenCodeTurnEventSupervisor | undefined;
    let permissionRulesInstalled = false;
    try {
      await this.#assertSessionWorkspace(sessionId, directory, deadlineSignal);
      const before = await this.#sessionMessages(sessionId, deadlineSignal, directory);
      const priorMessageIds = new Set(before.map(messageId).filter((id): id is string => Boolean(id)));
      this.#runtimeBoundaries.set(sessionId, {
        priorMessageIds,
        userMessageId: null,
        workspace,
        failureBoundaryId: null,
        scopedMcpScopeId: prompt.scopedMcpScopeId,
      });
      lifecycle = this.#startTurnEventSupervisor(
        sessionId,
        deadlineSignal,
        directory,
      );
      // OpenCode treats `directory` as routing context rather than an ownership
      // boundary, so revalidate immediately before the prompt side effect.
      await this.#assertSessionWorkspace(sessionId, directory, deadlineSignal);
      const promptTools = this.#promptTools(
        prompt.scopedMcpScopeId,
        prompt.scopedMcpTools,
        directory,
      );
      // OpenCode 1.18.11 still accepts the legacy prompt-level `tools` map as
      // an availability allowlist. Preserve that compatibility shape only for
      // purely read-only Riff scopes. Consequential and Browser tools rely
      // exclusively on the ordered session permission rules below: setting a
      // prompt-level `true` for those names would be appended after `ask` and
      // could silently widen a single-turn approval into `allow`.
      const legacyPromptTools = prompt.scopedMcpTools ?? [];
      const legacyPromptToolsSafe = Boolean(prompt.scopedMcpScopeId)
        && legacyPromptToolsCompatible(legacyPromptTools);
      await this.#json(`/session/${encodeURIComponent(sessionId)}`, {
        method: "PATCH",
        signal: deadlineSignal,
        body: JSON.stringify({
          permission: this.#promptPermissionRules(
            prompt.scopedMcpScopeId,
            prompt.scopedMcpTools,
            directory,
          ),
        }),
      }, directory);
      permissionRulesInstalled = true;
      await this.#json(`/session/${encodeURIComponent(sessionId)}/prompt_async`, {
        method: "POST",
        signal: deadlineSignal,
        body: JSON.stringify({
          model,
          ...(prompt.agentName ? { agent: validatedAgentName(prompt.agentName) } : {}),
          system: prompt.system,
          parts,
          ...(!prompt.scopedMcpScopeId || legacyPromptToolsSafe ? { tools: promptTools } : {}),
        }),
      }, directory);
      lifecycle.arm();
      return await this.#waitForAssistantUntilIdle(
        sessionId,
        priorMessageIds,
        deadlineSignal,
        lifecycle,
        directory,
        prompt.scopedMcpScopeId
          ? new Set(Object.entries(promptTools)
              .filter(([, enabled]) => enabled)
              .map(([name]) => name))
          : undefined,
        workspace,
      );
    } catch (error) {
      if (!deadlineSignal.aborted) throw error;
      throw signal
        ? new ApiError(409, "opencode_session_aborted", "The target OpenCode session turn was cancelled.")
        : new ApiError(504, "opencode_prompt_timeout", "OpenCode did not complete the target session turn in time.");
    } finally {
      lifecycle?.close();
      if (permissionRulesInstalled) {
        try {
          await this.#assertSessionWorkspace(sessionId, directory);
          await this.#json(`/session/${encodeURIComponent(sessionId)}`, {
            method: "PATCH",
            body: JSON.stringify({ permission: [] }),
          }, directory);
        } catch {
          // A restrictive stale ruleset is safer than widening on cleanup
          // failure; the session generation will be retired on turn failure.
        }
      }
    }
  }

  async prompt(sessionId: string, prompt: OpenCodePrompt, signal?: AbortSignal): Promise<void> {
    if (this.config.skipLive) return;
    await this.#ensureReady();
    if (!this.#readiness.modelId) throw new ApiError(503, "agent_not_ready", "The modelling assistant is not ready.");
    const binding = splitQualifiedModel(this.#readiness.modelId);
    const attachmentText = prompt.attachments.map((attachment) =>
      `- attachment ${safeContextLabel(attachment.id)}: ${safeContextLabel(attachment.mediaType)}, ${safeContextLabel(attachment.workspaceRelativePath)}`,
    ).join("\n");
    const directory = this.#workspaceDirectory();
    await this.#assertSessionWorkspace(sessionId, directory, signal);
    await this.#json(`/session/${encodeURIComponent(sessionId)}/message`, {
      method: "POST",
      signal,
      body: JSON.stringify({
        messageID: `msg_${randomUUID()}`,
        model: validatedModelReference(binding),
        system: prompt.system,
        parts: [{ type: "text", text: `${prompt.text}\n\nAttachments:\n${attachmentText || "(none)"}` }],
        tools: disabledBuiltInTools(),
      }),
    }, directory);
  }

  async abort(sessionId: string, workspace?: OpenCodeWorkspaceBinding): Promise<void> {
    if (!this.#baseUrl || this.config.skipLive) return;
    await this.#ensureReady(workspace);
    assertOpaqueId(sessionId, "OpenCode session ID");
    const directory = this.#workspaceDirectory(workspace);
    await this.#assertSessionWorkspace(sessionId, directory);
    await this.#json(
      `/session/${encodeURIComponent(sessionId)}/abort`,
      { method: "POST" },
      directory,
    );
  }

  async runtimeSnapshot(
    sessionId: string,
    scopedMcpScopeId: string | undefined,
    workspace?: OpenCodeWorkspaceBinding,
  ): Promise<OpenCodeConversationRuntimeSnapshot> {
    await this.#ensureReady(workspace);
    assertOpaqueId(sessionId, "OpenCode session ID");
    const signal = AbortSignal.timeout(this.#requestTimeoutMs);
    const boundary = this.#runtimeBoundaries.get(sessionId);
    if (!boundary || workspace && !sameWorkspace(boundary.workspace, workspace)) {
      throw new ApiError(
        409,
        "opencode_session_workspace_mismatch",
        "The OpenCode runtime boundary belongs to a different Product workspace.",
      );
    }
    const directory = this.#workspaceDirectory(workspace ?? boundary.workspace);
    await this.#assertSessionWorkspace(sessionId, directory, signal);
    const effectiveScopeId = scopedMcpScopeId ?? boundary.scopedMcpScopeId;
    const [status, messages, permissions, questions, scopedMcp] = await Promise.all([
      this.#sessionStatus(sessionId, signal, directory),
      this.#sessionMessages(sessionId, signal, directory),
      this.#list("/permission", signal, directory),
      this.#list("/question", signal, directory),
      this.#scopedMcpStatus(effectiveScopeId, signal, directory),
    ]);
    await this.#assertSessionWorkspace(sessionId, directory, signal);
    const assistants = currentRuntimeAttempt(
      messages,
      boundary.userMessageId,
      boundary,
    );
    const assistantMessageIds = new Set(
      assistants.map(messageId).filter((id): id is string => Boolean(id)),
    );
    const scopedBinding = effectiveScopeId ? this.#scopedMcp.get(effectiveScopeId) : undefined;
    const sensitiveValues = [
      sessionId,
      boundary.userMessageId ?? "",
      scopedBinding?.url ?? "",
      scopedCapabilityValue(scopedBinding?.url),
      ...assistants.flatMap((assistant) => [
        messageId(assistant) ?? "",
        ...assistantParts(assistant).flatMap((part) => [
          boundedOpaqueRuntimeValue(part?.id, 500) ?? "",
          boundedOpaqueRuntimeValue(part?.callID ?? part?.callId, 500) ?? "",
        ]),
      ]),
      ...permissions.map(runtimeUpstreamId).filter((id): id is string => Boolean(id)),
      ...questions.map(runtimeUpstreamId).filter((id): id is string => Boolean(id)),
    ].filter((value): value is string => Boolean(value));
    for (const key of this.#permissionAuthorities.keys()) {
      if (key.startsWith(`${sessionId}\u0000`)) this.#permissionAuthorities.delete(key);
    }
    const interactions = [
      ...runtimePermissions(
        permissions,
        sessionId,
        assistantMessageIds,
        assistants,
        scopedBinding?.name,
        scopedBinding?.allowedTools ?? [],
        sensitiveValues,
        (publicRequestId, proof) => {
          this.#permissionAuthorities.set(
            `${sessionId}\u0000${publicRequestId}`,
            Object.freeze({
              ...proof,
              authority: Object.freeze({ ...proof.authority }),
            }),
          );
        },
      ),
      ...runtimeQuestions(
        questions,
        sessionId,
        assistantMessageIds,
        assistants,
        sensitiveValues,
      ),
    ];
    return {
      status,
      assistant: runtimeAssistant(assistants, sensitiveValues),
      tools: runtimeTools(
        assistants,
        sessionId,
        scopedBinding?.name,
        scopedBinding?.allowedTools ?? [],
      ),
      interactions,
      failureCode: assistantFailureCode(assistants),
      scopedMcp: { label: "Riff tools", status: scopedMcp },
    };
  }

  releaseRuntimeBoundary(sessionId: string, workspace?: OpenCodeWorkspaceBinding): void {
    const boundary = this.#runtimeBoundaries.get(sessionId);
    if (boundary && (!workspace || sameWorkspace(boundary.workspace, workspace))) {
      this.#runtimeBoundaries.delete(sessionId);
      for (const key of this.#permissionAuthorities.keys()) {
        if (key.startsWith(`${sessionId}\u0000`)) this.#permissionAuthorities.delete(key);
      }
    }
  }

  async respondPermission(
    sessionId: string,
    publicRequestId: string,
    response: "once" | "reject",
    workspace?: OpenCodeWorkspaceBinding,
    expectedAuthority?: OpenCodePermissionAuthority,
  ): Promise<void> {
    await this.#ensureReady(workspace);
    assertOpaqueId(sessionId, "OpenCode session ID");
    if (response !== "once" && response !== "reject") {
      throw new ApiError(422, "invalid_interaction_response", "The permission response is invalid.");
    }
    const directory = this.#workspaceDirectory(workspace);
    const visible = await this.runtimeSnapshot(sessionId, undefined, workspace);
    if (!visible.interactions.some((interaction) =>
      interaction.kind === "permission" && interaction.id === publicRequestId)) {
      throw new ApiError(409, "interaction_not_pending", "The permission request is no longer pending for this turn.");
    }
    const privateRecord = this.#permissionAuthorities.get(`${sessionId}\u0000${publicRequestId}`);
    if (expectedAuthority && (!privateRecord
      || privateRecord.authority.toolName !== expectedAuthority.toolName
      || privateRecord.authority.operationCommitment !== expectedAuthority.operationCommitment)) {
      throw new ApiError(409, "interaction_not_pending", "The permission request is no longer pending for this turn.");
    }
    const requests = await this.#list("/permission", undefined, directory);
    const upstream = expectedAuthority
      ? privateRecord?.upstreamId ?? null
      : upstreamRuntimeRequest(requests, "permission", sessionId, publicRequestId);
    if (!upstream) throw new ApiError(409, "interaction_not_pending", "The permission request is no longer pending for this turn.");
    const currentPermission = requests.find((item) => item?.sessionID === sessionId
      && runtimeUpstreamId(item) === upstream);
    if (!currentPermission || expectedAuthority
      && runtimeRequestId(
        "permission",
        sessionId,
        upstream,
        currentPermission,
        expectedAuthority.operationCommitment,
      ) !== publicRequestId) {
      throw new ApiError(409, "interaction_not_pending", "The permission request is no longer pending for this turn.");
    }
    if (expectedAuthority) {
      const boundary = this.#runtimeBoundaries.get(sessionId);
      const scopedBinding = boundary?.scopedMcpScopeId
        ? this.#scopedMcp.get(boundary.scopedMcpScopeId) : undefined;
      const denyProof = (): never => {
        this.#permissionAuthorities.delete(`${sessionId}\u0000${publicRequestId}`);
        throw new ApiError(409, "interaction_not_pending", "The permission request is no longer pending for this turn.");
      };
      if (!boundary || !scopedBinding || !privateRecord
        || privateRecord.upstreamId !== upstream
        || currentPermission?.tool?.messageID !== privateRecord.messageId
        || currentPermission?.tool?.callID !== privateRecord.callId) denyProof();
      const messages = await this.#sessionMessages(
        sessionId,
        AbortSignal.timeout(this.#requestTimeoutMs),
        directory,
      );
      const assistants = currentRuntimeAttempt(messages, boundary.userMessageId, boundary);
      const evidence = assistantToolCalls(assistants)
        .get(`${privateRecord.messageId}\u0000${privateRecord.callId}`);
      const exactTool = evidence
        ? exactScopedToolName(evidence.tool, scopedBinding.name, scopedBinding.allowedTools)
        : null;
      let currentCommitment: string | null = null;
      if (exactTool && evidence?.inputSource === "state") {
        try {
          currentCommitment = isBrowserAgentToolName(exactTool)
            ? browserAgentOperationCommitment(
              exactTool,
              runtimeToolInput(evidence?.input),
            ).digest
            : CONSEQUENTIAL_AGENT_TOOLS.has(exactTool)
              ? agentToolOperationCommitment(
                exactTool,
                runtimeToolInput(evidence?.input),
              ).digest
              : null;
        } catch { currentCommitment = null; }
      }
      if (!evidence || evidence.tool !== privateRecord.scopedToolName
        || exactTool !== privateRecord.authority.toolName
        || currentCommitment !== privateRecord.authority.operationCommitment
        || privateRecord.authority.toolName !== expectedAuthority.toolName
        || privateRecord.authority.operationCommitment !== expectedAuthority.operationCommitment) {
        denyProof();
      }
    }
    await this.#assertSessionWorkspace(sessionId, directory);
    await this.#json(`/permission/${encodeURIComponent(upstream)}/reply`, {
      method: "POST",
      body: JSON.stringify({ reply: response }),
    }, directory);
  }

  async resolvePermissionAuthority(
    sessionId: string,
    publicRequestId: string,
    workspace?: OpenCodeWorkspaceBinding,
  ): Promise<OpenCodePermissionAuthority | null> {
    const snapshot = await this.runtimeSnapshot(sessionId, undefined, workspace);
    if (!snapshot.interactions.some((interaction) =>
      interaction.kind === "permission" && interaction.id === publicRequestId)) return null;
    return this.#permissionAuthorities.get(`${sessionId}\u0000${publicRequestId}`)?.authority ?? null;
  }

  async respondQuestion(
    sessionId: string,
    publicRequestId: string,
    response: { answers: string[][] } | { reject: true },
    workspace?: OpenCodeWorkspaceBinding,
  ): Promise<void> {
    await this.#ensureReady(workspace);
    assertOpaqueId(sessionId, "OpenCode session ID");
    const directory = this.#workspaceDirectory(workspace);
    const visible = await this.runtimeSnapshot(sessionId, undefined, workspace);
    if (!visible.interactions.some((interaction) =>
      interaction.kind === "question" && interaction.id === publicRequestId)) {
      throw new ApiError(409, "interaction_not_pending", "The question request is no longer pending for this turn.");
    }
    const requests = await this.#list("/question", undefined, directory);
    const upstream = upstreamRuntimeRequest(requests, "question", sessionId, publicRequestId);
    if (!upstream) throw new ApiError(409, "interaction_not_pending", "The question request is no longer pending for this turn.");
    const pending = requests.find((item) => runtimeUpstreamId(item) === upstream && item?.sessionID === sessionId);
    await this.#assertSessionWorkspace(sessionId, directory);
    if ("reject" in response) {
      await this.#json(`/question/${encodeURIComponent(upstream)}/reject`, { method: "POST" }, directory);
      return;
    }
    await this.#json(`/question/${encodeURIComponent(upstream)}/reply`, {
      method: "POST",
      body: JSON.stringify({
        answers: validatedQuestionAnswers(
          response.answers,
          pending?.questions,
          sessionId,
          upstream,
        ),
      }),
    }, directory);
  }

  async bindProject(projectId: string, mcpUrl: string): Promise<void> {
    if (this.config.skipLive) return;
    await this.#ensureReady();
    this.#requireLiveBaseUrl();
    const directory = this.#workspaceDirectory();
    const safeMcpUrl = loopbackHttpUrl(mcpUrl, "Riff MCP URL").toString();
    if (this.#mcpProjects.get(projectId) === safeMcpUrl) return;
    const name = `riff-${projectId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 24)}`;
    await this.#json("/mcp", {
      method: "POST",
      body: JSON.stringify({ name, config: { type: "remote", url: safeMcpUrl, enabled: true, oauth: false, timeout: 10_000 } }),
    }, directory);
    this.#mcpProjects.set(projectId, safeMcpUrl);
  }

  async bindScopedMcp(
    scopeId: string,
    mcpUrl: string,
    allowedTools: readonly AgentToolName[],
    workspace?: OpenCodeWorkspaceBinding,
  ): Promise<void> {
    if (this.config.skipLive) return;
    await this.#ensureReady(workspace);
    this.#requireLiveBaseUrl();
    assertOpaqueId(scopeId, "Riff MCP scope ID");
    const directory = this.#workspaceDirectory(workspace);
    const safeMcpUrl = loopbackMcpUrl(mcpUrl).toString();
    const exactAllowedTools = validatedScopedMcpTools(allowedTools);
    const name = scopedMcpName(scopeId);
    const existing = this.#scopedMcp.get(scopeId);
    if (existing && (existing.directory !== directory
      || !sameAgentTools(existing.allowedTools, exactAllowedTools))) {
      throw new ApiError(
        409,
        existing.directory !== directory
          ? "opencode_mcp_workspace_mismatch"
          : "opencode_mcp_binding_changed",
        existing.directory !== directory
          ? "The scoped Riff MCP binding belongs to a different Product workspace."
          : "The active scoped Riff MCP binding cannot change its capability or tool grant.",
      );
    }
    this.#scopedMcp.delete(scopeId);
    let registrationAttempted = false;
    try {
      const registry = await this.#json("/mcp", {}, directory);
      if (Object.hasOwn(registry, name)) {
        const disconnected = await this.#request(
          `/mcp/${encodeURIComponent(name)}/disconnect`,
          { method: "POST" },
          directory,
        );
        if (!disconnected.response.ok && disconnected.response.status !== 404) {
          throw apiErrorFromResponse(disconnected.response, disconnected.payload);
        }
      }
      registrationAttempted = true;
      await this.#json("/mcp", {
        method: "POST",
        body: JSON.stringify({
          name,
          config: {
            type: "remote",
            url: safeMcpUrl,
            enabled: true,
            oauth: false,
            timeout: BROWSER_AGENT_GRANT_TTL_MS + 5_000,
          },
        }),
      }, directory);
      const connected = await this.#request(
        `/mcp/${encodeURIComponent(name)}/connect`,
        { method: "POST" },
        directory,
      );
      if (!connected.response.ok) throw apiErrorFromResponse(connected.response, connected.payload);
      await this.#waitForMcpConnected(name, directory);
      this.#scopedMcp.set(scopeId, {
        name,
        url: safeMcpUrl,
        directory,
        allowedTools: exactAllowedTools,
      });
    } catch (error) {
      this.#scopedMcp.delete(scopeId);
      if (registrationAttempted) {
        await this.#request(
          `/mcp/${encodeURIComponent(name)}/disconnect`,
          { method: "POST" },
          directory,
        ).catch(() => undefined);
      }
      throw error;
    }
  }

  async #waitForMcpConnected(name: string, directory: string): Promise<void> {
    const deadline = Date.now() + Math.min(this.#requestTimeoutMs, 5_000);
    while (Date.now() < deadline) {
      const registry = await this.#json("/mcp", {}, directory);
      const status = typeof registry[name]?.status === "string"
        ? registry[name].status : "missing";
      if (status === "connected") return;
      if (["failed", "needs_auth", "needs_client_registration"].includes(status)) {
        throw new ApiError(
          503,
          "opencode_mcp_unavailable",
          "OpenCode rejected the scoped Riff MCP connection.",
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new ApiError(
      503,
      "opencode_mcp_unavailable",
      "OpenCode did not connect the scoped Riff MCP server before the bounded deadline.",
    );
  }

  async unbindScopedMcp(
    scopeId: string,
    workspace?: OpenCodeWorkspaceBinding,
  ): Promise<void> {
    if (this.config.skipLive) return;
    assertOpaqueId(scopeId, "Riff MCP scope ID");
    const binding = this.#scopedMcp.get(scopeId);
    if (!binding) return;
    const directory = this.#workspaceDirectory(workspace);
    if (binding.directory !== directory) {
      throw new ApiError(
        409,
        "opencode_mcp_workspace_mismatch",
        "The scoped Riff MCP binding belongs to a different Product workspace.",
      );
    }
    try {
      await this.#ensureReady(workspace);
      await this.#json(
        `/mcp/${encodeURIComponent(binding.name)}/disconnect`,
        { method: "POST" },
        directory,
      );
    } finally {
      this.#scopedMcp.delete(scopeId);
    }
  }

  #promptTools(
    scopeId: string | undefined,
    allowedTools: readonly AgentToolName[] | undefined,
    directory: string,
  ): Record<string, boolean> {
    // OpenCode may have unrelated local or plugin MCP servers configured.
    // Deny every tool first, then enable only the exact tools in this turn's
    // opaque Riff capability. Riff loads allowlisted skills into bounded
    // context; OpenCode's ambient filesystem-backed `skill` tool stays denied.
    // The explicit built-in map is retained for compatibility with versions
    // that merge exact names after wildcard rules.
    const tools = { "*": false, ...disabledBuiltInTools(), question: Boolean(scopeId) };
    if (!scopeId) {
      if (allowedTools !== undefined) {
        throw new ApiError(503, "opencode_mcp_unbound", "Riff MCP tools require a bound turn scope.");
      }
      return tools;
    }
    const binding = this.#scopedMcp.get(scopeId);
    if (!binding) throw new ApiError(503, "opencode_mcp_unbound", "The scoped Riff MCP server is not bound for this turn.");
    if (binding.directory !== directory) {
      throw new ApiError(
        409,
        "opencode_mcp_workspace_mismatch",
        "The scoped Riff MCP binding belongs to a different Product workspace.",
      );
    }
    const exact = validatedScopedMcpTools(allowedTools);
    if (!sameAgentTools(binding.allowedTools, exact)) {
      throw new ApiError(503, "opencode_mcp_tools_invalid", "The scoped Riff MCP tool grant is invalid.");
    }
    return Object.fromEntries([
      ...Object.entries(tools),
      ...exact.map((tool) => [`${binding.name}_${tool}`, true] as const),
    ]);
  }

  #promptPermissionRules(
    scopeId: string | undefined,
    allowedTools: readonly AgentToolName[] | undefined,
    directory: string,
  ): readonly Readonly<{
    permission: string;
    pattern: string;
    action: "ask" | "allow" | "deny";
  }>[] {
    const rules: Array<{
      permission: string;
      pattern: string;
      action: "ask" | "allow" | "deny";
    }> = [
      { permission: "*", pattern: "*", action: "deny" },
    ];
    if (!scopeId) return Object.freeze(rules.map(Object.freeze));
    rules.push({ permission: "question", pattern: "*", action: "allow" });
    const binding = this.#scopedMcp.get(scopeId);
    if (!binding || binding.directory !== directory) {
      throw new ApiError(503, "opencode_mcp_unbound", "The scoped Riff MCP server is not bound for this turn.");
    }
    const exact = validatedScopedMcpTools(allowedTools);
    if (!sameAgentTools(binding.allowedTools, exact)) {
      throw new ApiError(503, "opencode_mcp_tools_invalid", "The scoped Riff MCP tool grant is invalid.");
    }
    for (const tool of exact) {
      rules.push({
        permission: `${binding.name}_${tool}`,
        pattern: "*",
        // Browser tools enter BrowserAgentAuthority's Riff-owned permission
        // queue; an upstream OpenCode ask would create competing controllers.
        action: CONSEQUENTIAL_AGENT_TOOLS.has(tool) ? "ask" : "allow",
      });
    }
    return Object.freeze(rules.map(Object.freeze));
  }

  async subscribeEvents(
    listener: (event: OpenCodeRuntimeEvent) => void,
    workspace?: OpenCodeWorkspaceBinding,
  ): Promise<() => void> {
    if (this.config.skipLive) return () => undefined;
    await this.#ensureReady(workspace);
    const baseUrl = this.#requireLiveBaseUrl();
    const eventUrl = new URL("/event", baseUrl);
    eventUrl.searchParams.set("directory", this.#workspaceDirectory(workspace));
    const controller = new AbortController();
    let response: Response;
    try {
      response = await this.#fetch(eventUrl, {
        headers: this.#authorization(),
        signal: controller.signal,
        redirect: "manual",
      });
    } catch {
      throw new ApiError(503, "opencode_unavailable", "The local OpenCode server is not reachable.");
    }
    if (isRedirect(response.status)) throw new ApiError(502, "opencode_redirect_forbidden", "OpenCode redirects are not accepted.");
    if (!response.ok || !response.body) throw new ApiError(503, "opencode_event_unavailable", "OpenCode event streaming is unavailable.");
    void consumeSse(response.body, listener, controller.signal, this.#maxEventBufferBytes);
    return () => controller.abort();
  }

  async #json(
    path: string,
    init: RequestInit = {},
    directory?: string,
  ): Promise<Record<string, any>> {
    const result = await this.#request(path, init, directory);
    if (!result.response.ok) throw apiErrorFromResponse(result.response, result.payload);
    if (!result.payload || typeof result.payload !== "object" || Array.isArray(result.payload)) {
      if (result.response.status === 204) return {};
      throw new ApiError(502, "opencode_invalid_response", "OpenCode returned an unexpected JSON payload.");
    }
    return result.payload;
  }

  async #sessionMatchesWorkspace(
    sessionId: string,
    directory: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const result = await this.#request(
      `/session/${encodeURIComponent(sessionId)}`,
      { method: "GET", ...(signal ? { signal } : {}) },
      directory,
    );
    if (result.response.status === 404) return false;
    if (!result.response.ok) throw apiErrorFromResponse(result.response, result.payload);
    return openCodePath(result.payload) === directory;
  }

  async #assertSessionWorkspace(
    sessionId: string,
    directory: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (await this.#sessionMatchesWorkspace(sessionId, directory, signal)) return;
    throw new ApiError(
      409,
      "opencode_session_workspace_mismatch",
      "The OpenCode session does not belong to this Product workspace.",
    );
  }

  async #sessionMessages(
    sessionId: string,
    signal: AbortSignal,
    directory: string,
  ): Promise<any[]> {
    const result = await this.#request(
      `/session/${encodeURIComponent(sessionId)}/message`,
      { method: "GET", signal },
      directory,
    );
    if (!result.response.ok) throw apiErrorFromResponse(result.response, result.payload);
    return Array.isArray(result.payload) ? result.payload : [];
  }

  async #list(path: string, signal?: AbortSignal, directory?: string): Promise<any[]> {
    const result = await this.#request(
      path,
      { method: "GET", ...(signal ? { signal } : {}) },
      directory,
    );
    if (!result.response.ok) throw apiErrorFromResponse(result.response, result.payload);
    if (!Array.isArray(result.payload)) {
      throw new ApiError(502, "opencode_invalid_response", "OpenCode returned an unexpected list payload.");
    }
    return result.payload;
  }

  async #scopedMcpStatus(
    scopeId: string | undefined,
    signal: AbortSignal,
    directory: string,
  ): Promise<"connected" | "disconnected" | "unavailable"> {
    if (!scopeId) return "disconnected";
    const binding = this.#scopedMcp.get(scopeId);
    if (!binding) return "disconnected";
    if (binding.directory !== directory) {
      throw new ApiError(
        409,
        "opencode_mcp_workspace_mismatch",
        "The scoped Riff MCP binding belongs to a different Product workspace.",
      );
    }
    try {
      const result = await this.#request("/mcp", { method: "GET", signal }, directory);
      if (!result.response.ok) return "unavailable";
      const payload = result.payload;
      const value = payload && typeof payload === "object" && !Array.isArray(payload)
        ? payload[binding.name]
        : undefined;
      return value?.status === "connected" ? "connected"
        : value?.status === "disabled" ? "disconnected"
          : "unavailable";
    } catch {
      return "unavailable";
    }
  }

  async #sessionStatus(
    sessionId: string,
    signal: AbortSignal,
    directory: string,
  ): Promise<"busy" | "retry" | "idle"> {
    const result = await this.#request(
      "/session/status",
      { method: "GET", signal },
      directory,
    );
    if (!result.response.ok) throw apiErrorFromResponse(result.response, result.payload);
    const statuses = result.payload;
    if (!statuses || typeof statuses !== "object" || Array.isArray(statuses)) {
      throw new ApiError(502, "opencode_invalid_response", "OpenCode returned an invalid session status payload.");
    }
    // OpenCode removes idle sessions from this map. Own-property lookup avoids
    // treating an opaque session ID such as "constructor" as inherited state.
    if (!Object.prototype.hasOwnProperty.call(statuses, sessionId)) return "idle";
    const type = statuses[sessionId]?.type;
    if (type === "busy" || type === "retry" || type === "idle") return type;
    throw new ApiError(502, "opencode_invalid_response", "OpenCode returned an invalid target session status.");
  }

  async #waitForAssistantUntilIdle(
    sessionId: string,
    priorMessageIds: Set<string>,
    deadlineSignal: AbortSignal,
    lifecycle: OpenCodeTurnEventSupervisor,
    directory: string,
    allowedToolNames: ReadonlySet<string> | undefined,
    workspace?: OpenCodeWorkspaceBinding,
  ): Promise<OpenCodeAssistantResponse> {
    let userMessageId: string | null = null;
    let failureBoundaryId: string | null = null;
    const toolEvidence = new AssistantToolEvidenceTracker();
    while (!deadlineSignal.aborted) {
      let status: "busy" | "retry" | "idle";
      let messages: any[];
      try {
        status = await this.#sessionStatus(sessionId, deadlineSignal, directory);
        messages = await this.#sessionMessages(sessionId, deadlineSignal, directory);
      } catch (error) {
        if (deadlineSignal.aborted) throw deadlineSignal.reason ?? error;
        if (!retryableLifecyclePollError(error)) throw error;
        await abortableDelay(50, deadlineSignal);
        continue;
      }
      userMessageId ??= messageId(messages.find((entry: any) => entry?.info?.role === "user"
        && !priorMessageIds.has(messageId(entry) ?? "")));
      if (!userMessageId) {
        await lifecycle.wait(50, deadlineSignal);
        continue;
      }
      const boundary = this.#runtimeBoundaries.get(sessionId);
      if (boundary && !boundary.userMessageId) boundary.userMessageId = userMessageId;
      if (boundary?.failureBoundaryId
        && boundary.failureBoundaryId !== failureBoundaryId) {
        failureBoundaryId = boundary.failureBoundaryId;
        toolEvidence.clear();
      }
      lifecycle.observeUser();
      const assistants = uniqueMessages(messages.filter((entry: any) => entry?.info?.role === "assistant" && entry.info.parentID === userMessageId));
      const lastFailureIndex = assistants.findLastIndex(
        (assistant: any) => Boolean(assistant.info?.error),
      );
      const existingBoundaryIndex = failureBoundaryId === null
        ? -1
        : assistants.findIndex((assistant) => messageId(assistant) === failureBoundaryId);
      if (lastFailureIndex >= 0
        && (failureBoundaryId === null
          || existingBoundaryIndex >= 0 && lastFailureIndex > existingBoundaryIndex)) {
        const observedBoundary = messageId(assistants[lastFailureIndex]);
        if (!observedBoundary) {
          throw new ApiError(502, "opencode_invalid_response", "OpenCode returned an assistant error without a stable message ID.");
        }
        if (observedBoundary !== failureBoundaryId) {
          failureBoundaryId = observedBoundary;
          if (boundary) boundary.failureBoundaryId = observedBoundary;
          toolEvidence.clear();
        }
      }
      const boundaryIndex = failureBoundaryId === null
        ? -1
        : assistants.findIndex((assistant) => messageId(assistant) === failureBoundaryId);
      // Once a failed attempt has been observed, a later canonical replay must
      // retain that boundary. Otherwise Riff cannot prove which tool parts
      // belong to the post-retry attempt and must keep waiting fail-closed.
      const replayHasFailureBoundary = failureBoundaryId === null || boundaryIndex >= 0;
      const currentAttempt = replayHasFailureBoundary
        ? assistants.slice(boundaryIndex + 1)
        : [];
      assertObservedToolsAllowed(currentAttempt, allowedToolNames);
      toolEvidence.observe(currentAttempt);
      // Text is only a streaming observation while the target session remains
      // busy/retrying. Idle (including an absent status-map entry) is terminal
      // only after OpenCode marks the final post-retry sequence complete.
      if (status === "idle" && assistants.length > 0 && replayHasFailureBoundary) {
        if (failureBoundaryId !== null && currentAttempt.length === 0) {
          await this.#ensureReady(workspace, deadlineSignal);
          await this.#assertSessionWorkspace(sessionId, directory, deadlineSignal);
          throw assistantFailure(assistants[boundaryIndex].info.error);
        }
        if (currentAttempt.length > 0
          && currentAttempt.every(completedAssistant)) {
          const toolState = toolEvidence.state();
          if (toolState === "failed") {
            await this.#ensureReady(workspace, deadlineSignal);
            await this.#assertSessionWorkspace(sessionId, directory, deadlineSignal);
            throw new ApiError(
              502,
              "opencode_session_error",
              "OpenCode reported a failed tool call for the target session turn.",
            );
          }
          if (toolState === "complete") {
            try {
              const response = normalizedAssistantResponses(
                currentAttempt,
                toolEvidence.completed(),
              );
              await this.#ensureReady(workspace, deadlineSignal);
              await this.#assertSessionWorkspace(sessionId, directory, deadlineSignal);
              return response;
            } catch (error) {
              if (!(error instanceof ApiError)
                || error.code !== "opencode_empty_response") throw error;
            }
          }
        }
      }
      await lifecycle.wait(50, deadlineSignal);
    }
    throw new ApiError(504, "opencode_prompt_timeout", "OpenCode did not complete the target session turn in time.");
  }

  async #request(
    path: string,
    init: RequestInit,
    directory?: string,
  ): Promise<{ response: Response; payload: any }> {
    const base = this.#requireLiveBaseUrl();
    const target = new URL(path, base);
    if (directory) target.searchParams.set("directory", directory);
    // Existing callers already impose a stricter turn timeout and require their
    // exact signal to reach fetch. Unsignalled discovery/session calls receive
    // the adapter's own bounded timeout.
    const signal = init.signal ?? AbortSignal.timeout(this.#requestTimeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(target, {
        ...init,
        signal,
        redirect: "manual",
        headers: { "content-type": "application/json", ...this.#authorization(), ...(init.headers ?? {}) },
      });
    } catch (error) {
      if (init.signal?.aborted) throw error;
      throw new ApiError(503, "opencode_unavailable", "The local OpenCode server is not reachable.");
    }
    if (isRedirect(response.status)) throw new ApiError(502, "opencode_redirect_forbidden", "OpenCode redirects are not accepted.");
    const payload = await readBoundedJson(response, this.#maxResponseBytes);
    return { response, payload };
  }

  #authorization(): Record<string, string> {
    if (!this.config.serverPassword) return {};
    const username = this.config.serverUsername || "opencode";
    return { authorization: `Basic ${Buffer.from(`${username}:${this.config.serverPassword}`).toString("base64")}` };
  }

  #requireLiveBaseUrl(): URL {
    if (!this.#baseUrl) throw new ApiError(503, "opencode_unconfigured", "The local OpenCode server is not configured.");
    return this.#baseUrl;
  }

  async #ensureReady(
    workspace?: OpenCodeWorkspaceBinding,
    signal?: AbortSignal,
  ): Promise<void> {
    const readiness = await this.#checkReadiness(workspace, false, signal);
    if (readiness.status === "ready") return;
    throw new ApiError(
      503,
      readiness.lastError?.code ?? "agent_not_ready",
      readiness.lastError?.message ?? "The local OpenCode server has not passed readiness checks.",
    );
  }

  #workspaceDirectory(workspace?: OpenCodeWorkspaceBinding): string {
    const raw = workspace?.directory ?? this.config.workdir;
    if (!raw) {
      throw new ApiError(
        503,
        "opencode_workdir_unconfigured",
        "Set an explicit OPENCODE_WORKDIR before enabling the modelling assistant.",
      );
    }
    if (workspace) {
      if (!["model", "project", "workspace"].includes(workspace.owner.kind)
        || !/^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/u.test(workspace.owner.id)) {
        throw new ApiError(
          503,
          "opencode_invalid_workspace",
          "The Product workspace owner binding is invalid.",
        );
      }
    }
    return normalizeOpenCodeWorkdir(raw);
  }

  #startTurnEventSupervisor(
    sessionId: string,
    signal: AbortSignal,
    directory: string,
  ): OpenCodeTurnEventSupervisor {
    const baseUrl = this.#requireLiveBaseUrl();
    const eventUrl = new URL("/event", baseUrl);
    eventUrl.searchParams.set("directory", directory);
    return new OpenCodeTurnEventSupervisor({
      sessionId,
      signal,
      maximumBufferBytes: this.#maxEventBufferBytes,
      open: async (streamSignal) => {
        let response: Response;
        try {
          response = await this.#fetch(eventUrl, {
            headers: this.#authorization(),
            signal: streamSignal,
            redirect: "manual",
          });
        } catch (error) {
          if (streamSignal.aborted) throw error;
          throw new ApiError(503, "opencode_event_unavailable", "OpenCode event streaming is unavailable.");
        }
        if (isRedirect(response.status)) throw new ApiError(502, "opencode_redirect_forbidden", "OpenCode redirects are not accepted.");
        if (!response.ok || !response.body) throw new ApiError(503, "opencode_event_unavailable", "OpenCode event streaming is unavailable.");
        return response.body;
      },
    });
  }

  #setReadinessError(code: string, message: string): OpenCodeReadiness {
    this.#readiness = { status: "error", modelId: null, lastError: { code, message } };
    return this.#readiness;
  }
}

type OpenCodeTurnEventSupervisorOptions = {
  sessionId: string;
  signal: AbortSignal;
  maximumBufferBytes: number;
  open: (signal: AbortSignal) => Promise<ReadableStream<Uint8Array>>;
};

class OpenCodeTurnEventSupervisor {
  readonly #options: OpenCodeTurnEventSupervisorOptions;
  readonly #controller = new AbortController();
  readonly #seen = new Set<string>();
  readonly #seenOrder: string[] = [];
  readonly #waiters = new Set<() => void>();
  #armed = false;
  #userObserved = false;
  #closed = false;

  constructor(options: OpenCodeTurnEventSupervisorOptions) {
    this.#options = options;
    if (options.signal.aborted) this.close();
    else options.signal.addEventListener("abort", this.#onPromptAbort, { once: true });
    // Starting the async loop initiates the first /event fetch synchronously
    // before prompt_async is dispatched; connection failure is replay-safe.
    void this.#run();
  }

  arm(): void {
    if (this.#closed) return;
    this.#armed = true;
    this.#wake();
  }

  observeUser(): void {
    if (this.#closed || this.#userObserved) return;
    this.#userObserved = true;
    this.#wake();
  }

  wait(milliseconds: number, signal: AbortSignal): Promise<void> {
    if (this.#closed) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        this.#waiters.delete(finish);
        resolve();
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#waiters.delete(finish);
        reject(signal.reason);
      };
      const timer = setTimeout(finish, milliseconds);
      this.#waiters.add(finish);
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#options.signal.removeEventListener("abort", this.#onPromptAbort);
    this.#controller.abort();
    this.#wake();
  }

  readonly #onPromptAbort = (): void => this.close();

  async #run(): Promise<void> {
    let reconnectDelayMs = 50;
    while (!this.#closed) {
      try {
        const stream = await this.#options.open(this.#controller.signal);
        if (this.#closed) {
          await stream.cancel().catch(() => undefined);
          return;
        }
        reconnectDelayMs = 50;
        await consumeSse(
          stream,
          (event) => this.#handle(event),
          this.#controller.signal,
          this.#options.maximumBufferBytes,
        );
      } catch {
        // Status/message replay remains authoritative while SSE reconnects.
      }
      if (this.#closed) return;
      try { await abortableDelay(reconnectDelayMs, this.#controller.signal); }
      catch { return; }
      reconnectDelayMs = Math.min(reconnectDelayMs * 2, 500);
    }
  }

  #handle(event: OpenCodeRuntimeEvent): void {
    if (runtimeEventSessionId(event) !== this.#options.sessionId) return;
    const eventId = safeRuntimeEventId(event.id);
    if (eventId) {
      if (this.#seen.has(eventId)) return;
      this.#seen.add(eventId);
      this.#seenOrder.push(eventId);
      if (this.#seenOrder.length > 512) {
        const expired = this.#seenOrder.shift();
        if (expired) this.#seen.delete(expired);
      }
    }
    const status = event.type === "session.status" ? runtimeSessionStatus(event.properties?.status) : undefined;
    const terminal = event.type === "session.idle" || event.type === "session.error" || status === "idle";
    if (terminal && (!this.#armed || !this.#userObserved)) return;
    // The same opaque session is reused across turns and OpenCode events carry
    // no prompt/message cursor. Even an exact-session error can therefore be a
    // delayed prior-turn event. SSE only accelerates canonical replay; failure
    // is accepted exclusively from an assistant parented to this turn's new
    // user message.
    this.#wake();
  }

  #wake(): void {
    for (const waiter of [...this.#waiters]) waiter();
  }
}

export const opencodeFromEnvironment = (env: NodeJS.ProcessEnv = process.env): HttpOpenCodeAdapter => new HttpOpenCodeAdapter({
  baseUrl: env.OPENCODE_URL,
  workdir: env.OPENCODE_WORKDIR,
  expectedVersion: env.OPENCODE_EXPECTED_VERSION,
  serverUsername: env.OPENCODE_SERVER_USERNAME,
  serverPassword: env.OPENCODE_SERVER_PASSWORD,
  model: env.OPENCODE_MODEL,
  allowedProviders: env.OPENCODE_ALLOWED_PROVIDERS?.split(",").map((value) => value.trim()),
  requestTimeoutMs: optionalPositiveInteger(env.OPENCODE_REQUEST_TIMEOUT_MS ?? env.OPENCODE_PROMPT_TIMEOUT_MS),
  skipLive: env.RIFF_SKIP_OPENCODE === "true",
});

/** Resolves a configured workspace once so /path comparisons cannot be bypassed with a symlink. */
export const normalizeOpenCodeWorkdir = (raw: string): string => {
  if (!raw || !isAbsolute(raw)) throw new ApiError(503, "opencode_invalid_workdir", "OPENCODE_WORKDIR must be an absolute existing directory.");
  let resolved: string;
  try {
    resolved = realpathSync(raw);
    if (!statSync(resolved).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new ApiError(503, "opencode_invalid_workdir", "OPENCODE_WORKDIR must be an absolute existing directory.");
  }
  return resolved;
};

const openCodeVersion = (payload: Record<string, any>): string | null => {
  const value = typeof payload.version === "string" ? payload.version.trim() : "";
  return value && value.length <= 100 && !/[\u0000-\u001f\u007f]/u.test(value) ? value : null;
};

const requiredOpenCodeVersion = (raw: string): string => {
  const version = openCodeVersion({ version: raw });
  if (!version) throw new ApiError(503, "opencode_invalid_version", "OPENCODE_EXPECTED_VERSION must be a non-empty printable version string.");
  return version;
};

const openCodePath = (payload: Record<string, any>): string | null => {
  if (typeof payload.directory !== "string") return null;
  try { return normalizeOpenCodeWorkdir(payload.directory); }
  catch { return null; }
};

const discoveredProviderModels = (payload: Record<string, any>): OpenCodeProviderModel[] => {
  const found = new Map<string, OpenCodeProviderModel>();
  const providers = payload.providers ?? payload.all ?? [];
  const list = Array.isArray(providers)
    ? providers
    : providers && typeof providers === "object"
      ? Object.entries(providers).map(([id, value]) => ({ id, ...(value && typeof value === "object" ? value as object : {}) }))
      : [];
  for (const provider of list) {
    const providerId = validIdentifier(String(provider.id ?? provider.name ?? ""));
    if (!providerId) continue;
    const models = provider.models ?? {};
    const candidates = Array.isArray(models)
      ? models.map((model) => typeof model === "string" ? model : String(model?.id ?? model?.name ?? ""))
      : models && typeof models === "object" ? Object.keys(models) : [];
    for (const rawModelId of candidates) {
      const explicit = rawModelId.includes("/") ? splitQualifiedModelOrNull(rawModelId) : null;
      const modelProvider = explicit?.providerId ?? providerId;
      const modelId = validIdentifier(explicit?.modelId ?? rawModelId);
      if (!modelId || modelProvider !== providerId) continue;
      const qualifiedId = `${providerId}/${modelId}`;
      found.set(qualifiedId, { providerId, modelId, qualifiedId });
    }
  }
  return [...found.values()].sort((left, right) => left.qualifiedId.localeCompare(right.qualifiedId, "en"));
};

const discoveredAgents = (payload: any[]): OpenCodeAgent[] => {
  const found = new Map<string, OpenCodeAgent>();
  for (const item of payload) {
    if (!item || typeof item !== "object" || item.hidden === true
      || (item.mode !== "primary" && item.mode !== "all")) continue;
    const name = validIdentifier(String(item.name ?? ""));
    if (!name) continue;
    const description = safeOptionalPublicText(item.description, 500);
    found.set(name, {
      name,
      description,
      mode: item.mode,
      native: item.native === true,
    });
  }
  return [...found.values()].sort((left, right) => left.name.localeCompare(right.name, "en"));
};

const splitQualifiedModel = (qualifiedId: string): { providerId: string; modelId: string } => {
  const result = splitQualifiedModelOrNull(qualifiedId);
  if (!result) throw new ApiError(503, "opencode_invalid_model", "OpenCode returned an invalid provider/model ID.");
  return result;
};

const validatedAgentName = (value: string): string => {
  const result = validIdentifier(value);
  if (!result) throw new ApiError(422, "opencode_invalid_agent", "The selected OpenCode Agent is invalid.");
  return result;
};

const splitQualifiedModelOrNull = (qualifiedId: string): { providerId: string; modelId: string } | null => {
  const slash = qualifiedId.indexOf("/");
  if (slash <= 0 || slash === qualifiedId.length - 1) return null;
  const providerId = validIdentifier(qualifiedId.slice(0, slash));
  const modelId = validIdentifier(qualifiedId.slice(slash + 1));
  return providerId && modelId ? { providerId, modelId } : null;
};

const validatedModelReference = (binding: { providerId: string; modelId: string }): { providerID: string; modelID: string } => {
  const providerID = validIdentifier(binding.providerId);
  const modelID = validIdentifier(binding.modelId);
  if (!providerID || !modelID) throw new ApiError(422, "opencode_invalid_model", "The provider/model binding is invalid.");
  return { providerID, modelID };
};

const validIdentifier = (value: string): string | null => {
  const trimmed = value.trim();
  return trimmed && trimmed.length <= 300 && !/[\u0000-\u001f\u007f\s]/u.test(trimmed) ? trimmed : null;
};

const loopbackHttpUrl = (raw: string, label: string): URL => {
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new ApiError(503, "opencode_invalid_url", `${label} must be an absolute loopback HTTP URL.`); }
  if (url.protocol !== "http:" || url.username || url.password || !isLoopbackHostname(url.hostname)) {
    throw new ApiError(503, "opencode_invalid_url", `${label} must be an unauthenticated loopback HTTP URL.`);
  }
  if (url.pathname !== "/" || url.search || url.hash) throw new ApiError(503, "opencode_invalid_url", `${label} must not include a path, query, or fragment.`);
  return url;
};

const loopbackMcpUrl = (raw: string): URL => {
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new ApiError(503, "opencode_invalid_url", "Riff MCP URL must be an absolute loopback HTTP URL."); }
  if (url.protocol !== "http:" || url.username || url.password || !isLoopbackHostname(url.hostname)
    || url.pathname !== "/a2/mcp" || url.hash || url.searchParams.size !== 1 || !url.searchParams.get("cap")) {
    throw new ApiError(503, "opencode_invalid_url", "Riff MCP URL must be a capability-scoped local A2 MCP endpoint.");
  }
  return url;
};

const scopedMcpName = (scopeId: string): string => `riffa2${createHash("sha256").update(scopeId).digest("hex").slice(0, 24)}`;

const isLoopbackHostname = (hostname: string): boolean => {
  const normalized = hostname.toLowerCase();
  if (normalized === "localhost" || normalized === "[::1]" || normalized === "::1") return true;
  const match = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(normalized);
  return Boolean(match && match.slice(1).every((part) => Number(part) <= 255));
};

const readBoundedJson = async (response: Response, maximumBytes: number): Promise<any> => {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maximumBytes) throw new ApiError(502, "opencode_response_too_large", "OpenCode returned an oversized response.");
  if (!response.body) return {};
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximumBytes) throw new ApiError(502, "opencode_response_too_large", "OpenCode returned an oversized response.");
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  if (!total) return {};
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
  try {
    const value = JSON.parse(bytes.toString("utf8"));
    return value && typeof value === "object" ? value : {};
  } catch { throw new ApiError(502, "opencode_invalid_response", "OpenCode returned invalid JSON."); }
};

const apiErrorFromResponse = (response: Response, payload: Record<string, any>): ApiError =>
  new ApiError(response.status, String(payload?.error?.code ?? "opencode_error"), "OpenCode rejected the local request.");

type CompletedToolEvidence = Readonly<{
  key: string;
  toolName: string;
}>;

const assertObservedToolsAllowed = (
  payloads: Array<Record<string, any>>,
  allowedToolNames: ReadonlySet<string> | undefined,
): void => {
  if (!allowedToolNames) return;
  for (const payload of payloads) {
    for (const part of assistantParts(payload)) {
      if (!part || part.type !== "tool") continue;
      const toolName = typeof part.tool === "string"
        ? part.tool
        : typeof part.name === "string" ? part.name : "";
      if (!allowedToolNames.has(toolName)) {
        throw new ApiError(
          502,
          "opencode_tool_not_allowed",
          "OpenCode returned a tool call outside the exact turn grant.",
        );
      }
    }
  }
};

class AssistantToolEvidenceTracker {
  readonly #tools = new Map<string, { toolName: string; state: "pending" | "complete" | "failed" }>();

  clear(): void {
    this.#tools.clear();
  }

  observe(payloads: Array<Record<string, any>>): void {
    for (const payload of payloads) {
      const parts = assistantParts(payload);
      for (const [index, part] of parts.entries()) {
        if (!part || part.type !== "tool") continue;
        const key = toolEvidenceKey(payload, part, index);
        const prior = this.#tools.get(key);
        if (!prior && this.#tools.size >= 512) {
          throw new ApiError(502, "opencode_response_too_large", "OpenCode returned too many assistant tool parts for one turn.");
        }
        const status = part.state?.status;
        const observedState = status === "error" || status === "failed"
          ? "failed"
          : status === "completed" ? "complete" : "pending";
        this.#tools.set(key, {
          toolName: safeToolName(part.tool ?? part.name),
          // Terminal evidence is monotonic within one attempt. A later partial
          // replay cannot erase an already observed completion or failure.
          state: prior?.state === "failed" || observedState === "failed"
            ? "failed"
            : prior?.state === "complete" || observedState === "complete"
              ? "complete"
              : "pending",
        });
      }
    }
  }

  state(): "complete" | "pending" | "failed" {
    if ([...this.#tools.values()].some((tool) => tool.state === "failed")) return "failed";
    if ([...this.#tools.values()].some((tool) => tool.state !== "complete")) return "pending";
    return "complete";
  }

  completed(): CompletedToolEvidence[] {
    return [...this.#tools.entries()].map(([key, tool]) => {
      if (tool.state !== "complete") {
        throw new ApiError(502, "opencode_invalid_response", "OpenCode tool evidence is not terminal.");
      }
      return Object.freeze({ key, toolName: tool.toolName });
    });
  }
}

const normalizedAssistantResponses = (
  payloads: Array<Record<string, any>>,
  completedTools: CompletedToolEvidence[],
): OpenCodeAssistantResponse => {
  const texts: string[] = [];
  const seenParts = new Set<string>();
  const summarizedTools = new Set<string>();
  const completedToolMap = new Map(completedTools.map((tool) => [tool.key, tool]));
  const summary: OpenCodeAssistantResponse["content"]["parts"] = [];
  for (const payload of payloads) {
    const parts = assistantParts(payload);
    for (const [index, part] of parts.entries()) {
      if (!part || !["text", "tool"].includes(part.type) || part.ignored === true) continue;
      const partId = typeof part.id === "string" ? `${messageId(payload) ?? ""}:${part.id}` : null;
      if (partId && seenParts.has(partId)) continue;
      if (partId) seenParts.add(partId);
      if (summary.length >= 512) {
        throw new ApiError(502, "opencode_response_too_large", "OpenCode returned too many assistant parts for one turn.");
      }
      if (part.type === "tool") {
        const key = toolEvidenceKey(payload, part, index);
        const evidence = completedToolMap.get(key);
        if (!evidence || summarizedTools.has(key)) continue;
        summarizedTools.add(key);
        summary.push({
          ordinal: summary.length,
          kind: "tool",
          state: "complete",
          toolName: evidence.toolName,
        });
        continue;
      }
      if (typeof part.text !== "string" || !part.text.trim()) continue;
      texts.push(part.text.trim());
      summary.push({ ordinal: summary.length, kind: "text", state: "complete" });
    }
    if (!parts.length && typeof payload.text === "string" && payload.text.trim()) {
      if (summary.length >= 512) {
        throw new ApiError(502, "opencode_response_too_large", "OpenCode returned too many assistant parts for one turn.");
      }
      texts.push(payload.text.trim());
      summary.push({ ordinal: summary.length, kind: "text", state: "complete" });
    }
  }
  for (const evidence of completedTools) {
    if (summarizedTools.has(evidence.key)) continue;
    if (summary.length >= 512) {
      throw new ApiError(502, "opencode_response_too_large", "OpenCode returned too many assistant parts for one turn.");
    }
    summarizedTools.add(evidence.key);
    summary.push({
      ordinal: summary.length,
      kind: "tool",
      state: "complete",
      toolName: evidence.toolName,
    });
  }
  const text = texts.join("\n").trim();
  if (!text) throw new ApiError(502, "opencode_empty_response", "OpenCode returned no assistant text.");
  return {
    messageId: messageId(payloads.at(-1)),
    text,
    content: { source: "opencode", textParts: texts.length, parts: summary },
  };
};

const assistantParts = (payload: Record<string, any>): any[] =>
  Array.isArray(payload.parts)
    ? payload.parts
    : Array.isArray(payload.message?.parts) ? payload.message.parts : [];

const toolEvidenceKey = (
  payload: Record<string, any>,
  part: Record<string, any>,
  index: number,
): string => {
  const ownerMessageId = messageId(payload);
  if (!ownerMessageId) {
    throw new ApiError(502, "opencode_invalid_response", "OpenCode returned a tool part without a stable assistant message ID.");
  }
  const partIdentity = [part.id, part.callID, part.callId].find(
    (value) => typeof value === "string" && value.length > 0 && value.length <= 500
      && !/[\u0000-\u001f\u007f]/u.test(value),
  );
  return `${ownerMessageId}:${partIdentity ?? `ordinal-${index}`}`;
};

const safeToolName = (value: unknown): string =>
  typeof value === "string" && /^[A-Za-z0-9_.:-]{1,120}$/u.test(value)
    ? value
    : "tool";

const runtimeRequestId = (
  kind: "permission" | "question",
  sessionId: string,
  upstreamId: string,
  item: any,
  operationCommitment?: string,
): string => `${kind}_${createHash("sha256")
  .update(`${kind}\u0000${sessionId}\u0000${upstreamId}\u0000${runtimeRequestCommitment(kind, item)}`
    + `\u0000${operationCommitment ?? ""}`)
  .digest("hex")
  .slice(0, 32)}`;

const upstreamRuntimeRequest = (
  payload: any[],
  kind: "permission" | "question",
  sessionId: string,
  publicRequestId: string,
): string | null => {
  if (!/^(?:permission|question)_[0-9a-f]{32}$/u.test(publicRequestId)) return null;
  for (const item of payload) {
    const upstreamId = runtimeUpstreamId(item);
    if (item?.sessionID !== sessionId || !upstreamId) continue;
    if (runtimeRequestId(kind, sessionId, upstreamId, item) === publicRequestId) return upstreamId;
  }
  return null;
};

const runtimePermissions = (
  payload: any[],
  sessionId: string,
  assistantMessageIds: Set<string>,
  assistants: any[],
  scopedMcpName: string | undefined,
  allowedTools: readonly AgentToolName[],
  sensitiveValues: readonly string[],
  recordAuthority: (
    publicRequestId: string,
    proof: Readonly<{
      upstreamId: string;
      messageId: string;
      callId: string;
      scopedToolName: string;
      authority: OpenCodePermissionAuthority;
    }>,
  ) => void,
): OpenCodeRuntimeInteraction[] => {
  if (!scopedMcpName) return [];
  const allowedCalls = assistantToolCalls(assistants);
  const result: OpenCodeRuntimeInteraction[] = [];
  for (const item of payload) {
    const upstreamId = runtimeUpstreamId(item);
    const ownerMessageId = String(item?.tool?.messageID ?? "");
    const callId = String(item?.tool?.callID ?? "");
    const call = allowedCalls.get(`${ownerMessageId}\u0000${callId}`);
    const tool = call?.tool;
    if (item?.sessionID !== sessionId || !upstreamId || !assistantMessageIds.has(ownerMessageId)
      || !isExactScopedTool(tool, scopedMcpName, allowedTools)
      || !validPermissionRequest(item)) continue;
    const exactTool = exactScopedToolName(tool, scopedMcpName, allowedTools);
    if (!exactTool) continue;
    let operationCommitment: string | undefined;
    let browserAliasSummary = "fixed active grant alias (riff-app, riff-visual, or riff-artifact)";
    if (isBrowserAgentToolName(exactTool)
      || CONSEQUENTIAL_AGENT_TOOLS.has(exactTool)) {
      if (call?.inputSource !== "state") continue;
      try {
        if (isBrowserAgentToolName(exactTool)) {
          const committed = browserAgentOperationCommitment(
            exactTool,
            runtimeToolInput(call?.input),
          );
          operationCommitment = committed.digest;
          if (exactTool === "browser_open") {
            browserAliasSummary = `alias ${String(committed.normalized.alias)}`;
          }
        } else {
          operationCommitment = agentToolOperationCommitment(
            exactTool,
            runtimeToolInput(call?.input),
          ).digest;
        }
      } catch { continue; }
    }
    const label = publicToolLabel(tool, scopedMcpName) ?? "Riff tool";
    const consequentialSummary = operationCommitment
      && !isBrowserAgentToolName(exactTool)
      ? consequentialPermissionSummary(
        exactTool,
        runtimeToolInput(call?.input),
      ) : null;
    const browserSummary = isBrowserAgentToolName(exactTool)
      ? `Allow Browser control for this turn? Target ${browserAliasSummary}; operation ${exactTool}; `
        + `budget ${BROWSER_AGENT_ACTION_BUDGET}; expires within `
        + `${Math.floor(BROWSER_AGENT_GRANT_TTL_MS / 1_000)} seconds.`
      : consequentialSummary
        ? `Allow ${label} once for the current turn? ${consequentialSummary}`
        : `Allow ${label} once for the current turn?`;
    const publicRequestId = runtimeRequestId(
      "permission",
      sessionId,
      upstreamId,
      item,
      operationCommitment,
    );
    if (operationCommitment) {
      recordAuthority(publicRequestId, Object.freeze({
        upstreamId,
        messageId: ownerMessageId,
        callId,
        scopedToolName: tool!,
        authority: Object.freeze({
          toolName: exactTool,
          operationCommitment: operationCommitment!,
        }),
      }));
    }
    result.push({
      id: publicRequestId,
      kind: "permission",
      title: "Permission required",
      permission: safeOptionalPublicText(
        browserSummary,
        500,
        sensitiveValues,
      ) ?? "Allow this Riff tool once for the current turn?",
    });
    if (result.length >= 32) break;
  }
  return result;
};

export const consequentialPermissionSummary = (
  tool: AgentToolName,
  input: Readonly<Record<string, unknown>>,
): string => {
  const publicValue = (value: unknown, maximum = 200): string | null =>
    typeof value === "string" && value.trim().length > 0
      && value.trim().length <= maximum
      && !/[\u0000-\u001f\u007f\p{Cf}]/u.test(value)
      ? value.trim() : null;
  const experimentShape = (): string => {
    const configuration = input.configuration;
    if (!configuration || typeof configuration !== "object"
      || Array.isArray(configuration)) {
      return "Cannot approve: Experiment configuration details are incomplete.";
    }
    const record = configuration as Record<string, unknown>;
    const runKind = publicValue(record.runKind, 32);
    if (record.schemaVersion !== 1
      || (runKind !== "batch" && runKind !== "visual")
      || !record.parameters || typeof record.parameters !== "object"
      || Array.isArray(record.parameters)) {
      return "Cannot approve: Experiment configuration details are incomplete.";
    }
    const parameters = Object.entries(record.parameters as Record<string, unknown>)
      .filter(([key]) => /^[A-Za-z0-9_.-]{1,80}$/u.test(key))
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .slice(0, 12)
      .map(([key, value]) => {
        if (value === null) return `${key}=null`;
        if (typeof value === "boolean") return `${key}=${String(value)}`;
        if (typeof value === "number" && Number.isFinite(value)) {
          return `${key}=${Object.is(value, -0) ? 0 : String(value)}`;
        }
        if (typeof value === "string") return `${key}=string(${value.length})`;
        if (Array.isArray(value)) return `${key}=array(${value.length})`;
        if (value && typeof value === "object") return `${key}=object`;
        return `${key}=unsupported`;
      });
    const sampling = record.sampling && typeof record.sampling === "object"
      && !Array.isArray(record.sampling)
      ? record.sampling as Record<string, unknown> : {};
    const sampleCount = sampling.kind === "single" ? 1
      : sampling.kind === "multiple-seeds" && Array.isArray(sampling.seeds)
        && sampling.seeds.length > 0 ? sampling.seeds.length
        : sampling.kind === "cartesian-sweep" && Array.isArray(sampling.axes)
          && sampling.axes.length > 0
          ? sampling.axes.reduce((count, axis) => {
            if (!axis || typeof axis !== "object" || Array.isArray(axis)
              || !Array.isArray((axis as Record<string, unknown>).values)
              || !(axis as Record<string, unknown>).values) return Number.NaN;
            return count * ((axis as Record<string, unknown>).values as unknown[]).length;
          }, Array.isArray(sampling.seeds) ? sampling.seeds.length : 1)
          : null;
    if (!Number.isSafeInteger(sampleCount) || Number(sampleCount) < 1) {
      return "Cannot approve: Experiment sampling details are incomplete.";
    }
    return `Run kind ${runKind}; samples ${sampleCount}; parameters `
      + `${parameters.length ? parameters.join(", ") : "none"}.`;
  };
  switch (tool) {
    case "riff_start_model_technical_check":
      return "Start a technical check for the current Model.";
    case "riff_start_project_technical_check":
      return "Start a technical check for the current Project workspace digest.";
    case "riff_deliver_project_changes": {
      const changes = Array.isArray(input.changes) ? input.changes.slice(0, 64) : [];
      const paths = changes.flatMap((change) => {
        if (!change || typeof change !== "object" || Array.isArray(change)) return [];
        const path = publicValue(
          (change as Record<string, unknown>).relativePath, 240,
        );
        return path && !path.startsWith("/") && !path.includes("..") ? [path] : [];
      }).slice(0, 8);
      const run = input.run && typeof input.run === "object"
        && !Array.isArray(input.run)
        ? publicValue((input.run as Record<string, unknown>).configurationId, 256)
        : null;
      return `Deliver ${changes.length} Project file operation(s)`
        + `${paths.length ? `: ${paths.join(", ")}` : ""}; then run the technical check`
        + `${run ? ` and start Experiment ${run}` : ""}. File contents are hidden.`;
    }
    case "riff_apply_model_changes": {
      let changes: unknown = input.changes;
      if (typeof changes === "string" && changes.length <= 256_000) {
        try { changes = JSON.parse(changes); } catch { changes = null; }
      }
      const list = Array.isArray(changes) ? changes.slice(0, 64) : [];
      const paths = list.flatMap((change) => {
        if (!change || typeof change !== "object" || Array.isArray(change)) return [];
        const path = publicValue((change as Record<string, unknown>).relativePath, 240)
          ?? publicValue((change as Record<string, unknown>).path, 240);
        return path && !path.startsWith("/") && !path.includes("..") ? [path] : [];
      }).slice(0, 8);
      return `Apply ${list.length} Model file operation(s)`
        + `${paths.length ? `: ${paths.join(", ")}` : ""}. File contents are hidden.`;
    }
    case "riff_create_experiment_configuration":
      return `Create Experiment "${publicValue(input.name) ?? "unnamed"}". ${experimentShape()}`;
    case "riff_update_experiment_configuration":
      return `Update Experiment ${publicValue(input.configurationId, 256) ?? "selection"}`
        + `${publicValue(input.name) ? ` and name it "${publicValue(input.name)}"` : ""}. `
        + experimentShape();
    case "riff_start_run":
      return `Start a Run from Experiment ${publicValue(input.configurationId, 256) ?? "selection"}.`;
    case "riff_cancel_run":
      return `Cancel Run ${publicValue(input.runRef, 256) ?? "selection"}.`;
    case "riff_trash_run":
      return `Move Run ${publicValue(input.runRef, 256) ?? "selection"} to trash.`;
    case "riff_restore_run":
      return `Restore Run ${publicValue(input.runRef, 256) ?? "selection"}.`;
    case "riff_transition_owner_lifecycle": {
      const action = publicValue(input.action, 32) ?? "change";
      return action === "rename"
        ? `Rename the current object to "${publicValue(input.name) ?? "unnamed"}".`
        : `${action[0]?.toUpperCase() ?? "C"}${action.slice(1)} the current object.`;
    }
    case "riff_create_analysis_document":
      return `Create analysis document "${publicValue(input.name) ?? "unnamed"}"; content hidden.`;
    case "riff_transition_temporary_document":
      return `Apply ${publicValue(input.transition, 32) ?? "a lifecycle change"} to document `
        + `${publicValue(input.documentId, 256) ?? "selection"}.`;
    case "riff_adopt_attachment":
      return `Adopt attachment ${publicValue(input.attachmentId, 256) ?? "selection"} as `
        + `"${publicValue(input.logicalName, 240) ?? "an owned file"}".`;
    default:
      return "Apply the exact server-held parameters shown for this request.";
  }
};

const runtimeQuestions = (
  payload: any[],
  sessionId: string,
  assistantMessageIds: Set<string>,
  assistants: any[],
  sensitiveValues: readonly string[],
): OpenCodeRuntimeInteraction[] => {
  const allowedCalls = assistantToolCalls(assistants);
  const result: OpenCodeRuntimeInteraction[] = [];
  for (const item of payload) {
    const upstreamId = runtimeUpstreamId(item);
    const ownerMessageId = String(item?.tool?.messageID ?? "");
    const callId = String(item?.tool?.callID ?? "");
    if (item?.sessionID !== sessionId || !upstreamId || !Array.isArray(item.questions)
      || !assistantMessageIds.has(ownerMessageId)
      || allowedCalls.get(`${ownerMessageId}\u0000${callId}`)?.tool !== "question") continue;
    const questions = item.questions.slice(0, 16).flatMap((question: any, questionIndex: number) => {
      const header = safeOptionalPublicText(question?.header, 100, sensitiveValues);
      const text = safeOptionalPublicText(question?.question, 2_000, sensitiveValues);
      if (!header || !text || !Array.isArray(question.options)) return [];
      const options = question.options.slice(0, 32).flatMap((option: any, optionIndex: number) => {
        const label = safeOptionalPublicText(option?.label, 200, sensitiveValues);
        const description = safeOptionalPublicText(option?.description, 1_000, sensitiveValues);
        return label && description ? [{
          id: runtimeQuestionChoiceId(
            sessionId,
            upstreamId,
            questionIndex,
            optionIndex,
            option.label,
          ),
          label,
          description,
        }] : [];
      });
      return [{
        header,
        question: text,
        multiple: question.multiple === true,
        custom: question.custom !== false,
        options,
      }];
    });
    if (!questions.length) continue;
    result.push({
      id: runtimeRequestId("question", sessionId, upstreamId, item),
      kind: "question",
      questions,
    });
    if (result.length >= 32) break;
  }
  return result;
};

const runtimeTools = (
  assistants: any[],
  sessionId: string,
  scopedMcpName: string | undefined,
  allowedTools: readonly AgentToolName[],
): OpenCodeRuntimeTool[] => {
  const latest = new Map<string, OpenCodeRuntimeTool>();
  for (const message of assistants) {
    if (message?.info?.sessionID !== sessionId && message?.info?.sessionID !== undefined) continue;
    if (!Array.isArray(message.parts)) continue;
    for (const part of message.parts) {
      if (!part || part.type !== "tool") continue;
      const upstreamId = boundedOpaqueRuntimeValue(part.callID ?? part.id, 500);
      const rawTool = boundedOpaqueRuntimeValue(part.tool, 500);
      if (rawTool !== "question"
        && !isExactScopedTool(rawTool, scopedMcpName, allowedTools)) continue;
      const tool = publicToolLabel(part.tool, scopedMcpName);
      const status = part.state?.status;
      if (!upstreamId || !tool || !["pending", "running", "completed", "error"].includes(status)) continue;
      latest.set(upstreamId, {
        id: `tool_${createHash("sha256").update(`tool\u0000${sessionId}\u0000${upstreamId}`).digest("hex").slice(0, 32)}`,
        tool,
        title: null,
        status,
      });
      if (latest.size > 256) throw new ApiError(502, "opencode_response_too_large", "OpenCode returned too many tool parts.");
    }
  }
  return [...latest.values()];
};

const exactScopedToolName = (
  value: string | null | undefined,
  scopedMcpName: string | undefined,
  allowedTools: readonly AgentToolName[],
): AgentToolName | null => scopedMcpName && value
  ? allowedTools.find((tool) => value === `${scopedMcpName}_${tool}`) ?? null
  : null;

const isExactScopedTool = (
  value: string | null | undefined,
  scopedMcpName: string | undefined,
  allowedTools: readonly AgentToolName[],
): boolean => exactScopedToolName(value, scopedMcpName, allowedTools) !== null;

const currentRuntimeAttempt = (
  messages: any[],
  userMessageId: string | null,
  boundary: { failureBoundaryId: string | null },
): any[] => {
  if (!userMessageId) return [];
  const assistants = uniqueMessages(messages.filter((message: any) =>
    message?.info?.role === "assistant" && message.info.parentID === userMessageId));
  const priorBoundaryIndex = boundary.failureBoundaryId === null
    ? -1
    : assistants.findIndex((assistant) => messageId(assistant) === boundary.failureBoundaryId);
  const latestFailureIndex = assistants.findLastIndex((assistant) => Boolean(assistant.info?.error));
  if (latestFailureIndex >= 0
    && (boundary.failureBoundaryId === null
      || priorBoundaryIndex >= 0 && latestFailureIndex > priorBoundaryIndex)) {
    const observedBoundary = messageId(assistants[latestFailureIndex]);
    if (!observedBoundary) {
      throw new ApiError(
        502,
        "opencode_invalid_response",
        "OpenCode returned an assistant error without a stable message ID.",
      );
    }
    boundary.failureBoundaryId = observedBoundary;
  }
  if (!boundary.failureBoundaryId) return assistants;
  const boundaryIndex = assistants.findIndex((assistant) =>
    messageId(assistant) === boundary.failureBoundaryId);
  return boundaryIndex < 0 ? [] : assistants.slice(boundaryIndex + 1);
};

const runtimeAssistant = (
  assistants: any[],
  sensitiveValues: readonly string[],
): OpenCodeConversationRuntimeSnapshot["assistant"] => {
  if (!assistants.length) return null;
  const text: string[] = [];
  for (const assistant of assistants) {
    for (const part of Array.isArray(assistant.parts) ? assistant.parts : []) {
      if (part?.type !== "text" || part.ignored === true || typeof part.text !== "string") continue;
      const value = safeOptionalPublicText(part.text, 64_000, sensitiveValues);
      if (value) text.push(value);
    }
  }
  const failed = assistants.some((assistant) => assistant.info?.error);
  const complete = assistants.every(completedAssistant);
  return {
    status: failed ? "error" : complete ? "complete" : "streaming",
    text: text.join("\n").slice(0, 64_000),
  };
};

const assistantFailureCode = (
  assistants: any[],
): OpenCodeConversationRuntimeSnapshot["failureCode"] => {
  for (const message of assistants) {
    const name = message?.info?.error?.name;
    if (name === "ProviderAuthError") return "opencode_auth_failed";
    if (name === "MessageAbortedError") return "opencode_session_aborted";
    if (typeof name === "string" && name) return "opencode_session_error";
  }
  return null;
};

const runtimeUpstreamId = (item: any): string | null =>
  boundedOpaqueRuntimeValue(item?.id ?? item?.requestID, 500);

const safeOptionalPublicText = (
  value: unknown,
  maximum: number,
  sensitiveValues: readonly string[] = [],
): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = redactPublicRuntimeText(value, sensitiveValues)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ")
    .trim();
  return trimmed ? trimmed.slice(0, maximum) : null;
};

const validatedQuestionAnswers = (
  answers: unknown,
  questions: unknown,
  sessionId: string,
  upstreamId: string,
): string[][] => {
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > 16
    || !Array.isArray(answers) || answers.length !== questions.length) {
    throw new ApiError(422, "invalid_interaction_response", "Question answers must be a bounded array.");
  }
  return answers.map((answer, index) => {
    const question = questions[index] as any;
    if (!Array.isArray(answer) || answer.length < 1 || answer.length > 32
      || question?.multiple !== true && answer.length !== 1) {
      throw new ApiError(422, "invalid_interaction_response", "Each question answer must be a bounded string array.");
    }
    const normalized = answer.map((value) => {
      const text = boundedInteractionAnswer(value);
      if (!text) throw new ApiError(422, "invalid_interaction_response", "Question answers must contain non-empty text.");
      return text;
    });
    if (new Set(normalized).size !== normalized.length) {
      throw new ApiError(422, "invalid_interaction_response", "Question answers must be unique.");
    }
    const allowed = new Map<string, string>(
      Array.isArray(question?.options)
        ? question.options.flatMap((option: any, optionIndex: number) => {
            if (typeof option?.label !== "string") return [];
            return [[runtimeQuestionChoiceId(
              sessionId,
              upstreamId,
              index,
              optionIndex,
              option.label,
            ), option.label] as const];
          })
        : [],
    );
    return normalized.map((answerText) => {
      const upstreamLabel = allowed.get(answerText);
      if (upstreamLabel !== undefined) return upstreamLabel;
      if (/^choice_[0-9a-f]{32}$/u.test(answerText)) {
        throw new ApiError(422, "invalid_interaction_response", "The selected question choice is no longer available.");
      }
      if (question?.custom === false) {
        throw new ApiError(422, "invalid_interaction_response", "Question answers must use an offered option.");
      }
      return answerText;
    });
  });
};

const boundedInteractionAnswer = (value: unknown): string | null => {
  if (typeof value !== "string" || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= 1_000 ? trimmed : null;
};

const publicToolLabel = (value: unknown, scopedMcpName: string | undefined): string | null => {
  if (typeof value !== "string") return null;
  if (scopedMcpName && value.startsWith(`${scopedMcpName}_`)) {
    const suffix = value.slice(scopedMcpName.length + 1)
      .replace(/^riff_/u, "")
      .replace(/[_-]+/gu, " ")
      .trim();
    return suffix ? `Riff ${suffix}`.slice(0, 300) : "Riff tool";
  }
  if (value === "question") return "Question";
  return "Agent tool";
};

const assistantToolCalls = (
  assistants: any[],
): Map<string, {
  tool: string;
  input: Readonly<Record<string, unknown>>;
  inputSource: "state" | "legacy_part" | "empty";
} | null> => {
  const result = new Map<string, {
    tool: string;
    input: Readonly<Record<string, unknown>>;
    inputSource: "state" | "legacy_part" | "empty";
  } | null>();
  for (const assistant of assistants) {
    const ownerMessageId = messageId(assistant);
    if (!ownerMessageId || !Array.isArray(assistant.parts)) continue;
    for (const part of assistant.parts) {
      const callId = boundedOpaqueRuntimeValue(part?.callID ?? part?.callId, 500);
      const tool = boundedOpaqueRuntimeValue(part?.tool, 500);
      const state = part?.state;
      const stateInput = state && typeof state === "object" && !Array.isArray(state)
        && Object.hasOwn(state, "input")
        && state.input && typeof state.input === "object" && !Array.isArray(state.input)
        ? state.input as Readonly<Record<string, unknown>> : null;
      // OpenCode versions before the pinned state.input projection exposed
      // non-Browser tool input on the part (or omitted it for inputless tools).
      // Keep that compatibility for ordinary Riff/question projection only.
      const legacyInput = part?.input && typeof part.input === "object" && !Array.isArray(part.input)
        ? part.input as Readonly<Record<string, unknown>> : null;
      const input = stateInput ?? legacyInput ?? Object.freeze({});
      if (part?.type === "tool" && callId && tool && input) {
        const key = `${ownerMessageId}\u0000${callId}`;
        // Duplicate assistant evidence is ambiguous. Never let a later part win.
        result.set(key, result.has(key) ? null : {
          tool,
          input,
          inputSource: stateInput ? "state" : legacyInput ? "legacy_part" : "empty",
        });
      }
    }
  }
  return result;
};

const runtimeToolInput = (value: unknown): Readonly<Record<string, unknown>> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid browser tool input");
  }
  return value as Readonly<Record<string, unknown>>;
};

const runtimeRequestCommitment = (
  kind: "permission" | "question",
  item: any,
): string => canonicalJsonV2(kind === "permission"
  ? {
      permission: boundedCommitmentText(item?.permission, 500),
      patterns: boundedCommitmentStrings(item?.patterns, 256, 4_000),
      always: boundedCommitmentStrings(item?.always, 256, 4_000),
      tool: {
        messageID: boundedCommitmentText(item?.tool?.messageID, 500),
        callID: boundedCommitmentText(item?.tool?.callID, 500),
      },
    }
  : {
      tool: {
        messageID: boundedCommitmentText(item?.tool?.messageID, 500),
        callID: boundedCommitmentText(item?.tool?.callID, 500),
      },
      questions: Array.isArray(item?.questions)
        ? item.questions.slice(0, 16).map((question: any) => ({
            header: boundedCommitmentText(question?.header, 100),
            question: boundedCommitmentText(question?.question, 2_000),
            multiple: question?.multiple === true,
            custom: question?.custom !== false,
            options: Array.isArray(question?.options)
              ? question.options.slice(0, 32).map((option: any) => ({
                  label: boundedCommitmentText(option?.label, 200),
                  description: boundedCommitmentText(option?.description, 1_000),
                }))
              : [],
          }))
        : [],
    }).toString("utf8");

const boundedCommitmentText = (value: unknown, maximum: number): string | null =>
  typeof value === "string" && value.length > 0 && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/u.test(value) ? value : null;

const boundedCommitmentStrings = (
  value: unknown,
  maximumItems: number,
  maximumItemLength: number,
): readonly string[] | null => boundedStringArray(value, maximumItems, maximumItemLength)
  ? Object.freeze([...(value as string[])]) : null;

const validPermissionRequest = (item: any): boolean =>
  boundedOpaqueRuntimeValue(item?.permission, 500) !== null
  && boundedStringArray(item?.patterns, 256, 4_000)
  && boundedStringArray(item?.always, 256, 4_000);

const boundedStringArray = (
  value: unknown,
  maximumItems: number,
  maximumItemLength: number,
): boolean => Array.isArray(value)
  && value.length <= maximumItems
  && value.every((item) => typeof item === "string"
    && item.length <= maximumItemLength
    && !/[\u0000-\u001f\u007f]/u.test(item));

const runtimeQuestionChoiceId = (
  sessionId: string,
  upstreamId: string,
  questionIndex: number,
  optionIndex: number,
  upstreamLabel: unknown,
): string => `choice_${createHash("sha256")
  .update(`choice\u0000${sessionId}\u0000${upstreamId}\u0000${questionIndex}\u0000${optionIndex}\u0000${String(upstreamLabel)}`)
  .digest("hex")
  .slice(0, 32)}`;

const boundedOpaqueRuntimeValue = (value: unknown, maximum: number): string | null =>
  typeof value === "string" && value.length > 0 && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/u.test(value)
    ? value
    : null;

const sameWorkspace = (
  left: OpenCodeWorkspaceBinding | undefined,
  right: OpenCodeWorkspaceBinding | undefined,
): boolean => left?.directory === right?.directory
  && left?.owner.kind === right?.owner.kind
  && left?.owner.id === right?.owner.id;

const scopedCapabilityValue = (url: string | undefined): string => {
  if (!url) return "";
  try {
    return new URL(url).searchParams.get("cap") ?? "";
  } catch {
    return "";
  }
};

const replaceSensitiveValues = (value: string, sensitiveValues: readonly string[]): string => {
  const unique = [...new Set(sensitiveValues)].filter(Boolean);
  if (unique.some((item) => item.length < 4 && value.includes(item))) {
    return "[runtime text redacted]";
  }
  let redacted = value;
  for (const sensitive of unique
    .sort((left, right) => right.length - left.length)) {
    redacted = redacted.split(sensitive).join("[sensitive value]");
  }
  return redacted;
};

export const redactPublicRuntimeText = (
  value: string,
  sensitiveValues: readonly string[] = [],
): string => replaceSensitiveValues(value, sensitiveValues)
  .replace(/-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/giu, "[credential redacted]")
  .replace(/\b(?:authorization\s*:\s*bearer|bearer)\s+[^\s]+/giu, "[credential redacted]")
  .replace(/\b(?:api[_-]?key|access[_-]?token|token|secret|password)\s*[:=]\s*[^\s,;]+/giu, "[credential redacted]")
  .replace(/\b(?:sk|rk|api)[-_][A-Za-z0-9_-]{12,}\b/gu, "[credential redacted]")
  .replace(/file:\/\/[^\s)"'`,;}\]>]+/giu, "[local path]")
  .replace(/(?<![\w:/.])\/(?!\/)[^\s)"'`,;}\]>]+/gu, "[local path]")
  .replace(/(?<![\w/])(?:\.\.?\/)+[^\s)"'`,;}\]>]+/gu, "[local path]")
  .replace(/\b(?:workspace|code|environment|outputs?|private|secrets?)\/[^\s)"'`,;}\]>]+/giu, "[local path]")
  .replace(/\b(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+\.[A-Za-z0-9]{1,16}\b/gu, "[local path]")
  .replace(/\b[A-Za-z]:\\[^\s)"'`,;]+/gu, "[local path]")
  .replace(/\\\\[A-Za-z0-9._-]+\\[^\s)"'`,;]+/gu, "[local path]")
  .replace(/\bhttps?:\/\/(?:127(?:\.\d{1,3}){3}|localhost|\[::1\])(?::\d+)?[^\s)"'`,;}\]>]*/giu, "[local service]")
  .replace(/([?&]cap=)[^&\s)"'`,;}\]>]+/giu, "$1[capability redacted]");

const assistantFailure = (error: unknown): ApiError => {
  const name = error && typeof error === "object" && typeof (error as any).name === "string" ? (error as any).name : "";
  if (name === "MessageAbortedError") return new ApiError(409, "opencode_session_aborted", "OpenCode aborted the target session turn.");
  if (name === "ProviderAuthError") return new ApiError(401, "opencode_auth_failed", "OpenCode provider authentication failed.");
  return new ApiError(502, "opencode_session_error", "OpenCode failed to complete the target session turn.");
};

const runtimeEventSessionId = (event: OpenCodeRuntimeEvent): string | null => {
  const properties = event.properties;
  const nested = properties?.part && typeof properties.part === "object"
    ? properties.part as Record<string, unknown>
    : properties?.info && typeof properties.info === "object"
      ? properties.info as Record<string, unknown>
      : undefined;
  const value = properties?.sessionID ?? nested?.sessionID;
  return typeof value === "string" && value.length <= 500 && !/[\u0000-\u001f\u007f]/u.test(value) ? value : null;
};

const runtimeSessionStatus = (value: unknown): "busy" | "retry" | "idle" | null => {
  const type = typeof value === "string"
    ? value
    : value && typeof value === "object" ? (value as Record<string, unknown>).type : undefined;
  return type === "busy" || type === "retry" || type === "idle" ? type : null;
};

const safeRuntimeEventId = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 && value.length <= 500 && !/[\u0000-\u001f\u007f]/u.test(value) ? value : null;

const retryableLifecyclePollError = (error: unknown): boolean =>
  error instanceof ApiError && (error.code === "opencode_unavailable"
    || error.status >= 500 && !["opencode_invalid_response", "opencode_response_too_large", "opencode_redirect_forbidden"].includes(error.code));

const completedAssistant = (payload: Record<string, any>): boolean =>
  Number.isFinite(payload.info?.time?.completed);

const uniqueMessages = (payloads: Array<Record<string, any>>): Array<Record<string, any>> => {
  const latest = new Map<string, { payload: Record<string, any>; index: number }>();
  for (const [index, payload] of payloads.entries()) {
    const id = messageId(payload);
    if (!id) continue;
    latest.set(id, { payload, index });
  }
  if (latest.size > 512) throw new ApiError(502, "opencode_response_too_large", "OpenCode returned too many assistant messages for one turn.");
  // Replay may contain an early incomplete copy followed by the updated
  // completed message with the same ID. Last list occurrence is authoritative.
  return [...latest.values()].sort((left, right) => left.index - right.index).map((entry) => entry.payload);
};

const messageId = (payload: Record<string, any> | undefined): string | null => {
  const rawId = payload?.info?.id ?? payload?.info?.messageID ?? payload?.id ?? payload?.messageID;
  return typeof rawId === "string" && rawId.length <= 500 && !/[\u0000-\u001f\u007f]/u.test(rawId) ? rawId : null;
};

const disabledBuiltInTools = () => ({
  invalid: false,
  question: false,
  bash: false,
  read: false,
  glob: false,
  grep: false,
  write: false,
  edit: false,
  task: false,
  webfetch: false,
  todowrite: false,
  websearch: false,
  skill: false,
  apply_patch: false,
});

const validatedScopedMcpTools = (raw: unknown): readonly AgentToolName[] => {
  if (!Array.isArray(raw) || !raw.length
    || raw.some((tool) => typeof tool !== "string" || !isAgentToolName(tool))
    || new Set(raw).size !== raw.length
    || raw.some((tool, index) =>
      index > 0 && String(raw[index - 1]).localeCompare(String(tool), "en") >= 0)) {
    throw new ApiError(503, "opencode_mcp_tools_invalid", "The scoped Riff MCP tool grant is invalid.");
  }
  return Object.freeze([...raw] as AgentToolName[]);
};

const sameAgentTools = (
  left: readonly AgentToolName[],
  right: readonly AgentToolName[],
): boolean => left.length === right.length
  && left.every((tool, index) => tool === right[index]);

const consumeSse = async (
  stream: ReadableStream<Uint8Array>,
  listener: (event: OpenCodeRuntimeEvent) => void,
  signal: AbortSignal,
  maximumBufferBytes: number,
): Promise<void> => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!signal.aborted) {
      const next = await reader.read();
      if (next.done) return;
      buffer += decoder.decode(next.value, { stream: true });
      if (Buffer.byteLength(buffer, "utf8") > maximumBufferBytes) return;
      let split: number;
      while ((split = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
        if (!data) continue;
        try { listener(JSON.parse(data)); } catch { /* malformed source events are ignored */ }
      }
    }
  } catch {
    // Canonical Riff state remains authoritative; the service can reconnect.
  } finally { reader.releaseLock(); }
};

const positiveLimit = (value: number | undefined, fallback: number, label: string): number => {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1) throw new ApiError(500, "opencode_invalid_limit", `${label} must be a positive integer.`);
  return selected;
};
const optionalPositiveInteger = (value: string | undefined): number | undefined => {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
};

const isRedirect = (status: number): boolean => status >= 300 && status < 400;
const abortableDelay = (milliseconds: number, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  if (signal.aborted) return reject(signal.reason);
  const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
  const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, milliseconds);
  signal.addEventListener("abort", onAbort, { once: true });
});
const safeTitleFragment = (value: string): string => value.replace(/[^A-Za-z0-9_-]/gu, "").slice(0, 32) || "conversation";
const safeContextLabel = (value: string): string => value.replace(/[\r\n\u0000-\u001f\u007f]/gu, " ").slice(0, 500);
const assertOpaqueId = (value: string, label: string): void => {
  if (!value || value.length > 500 || /[\u0000-\u001f\u007f]/u.test(value)) throw new ApiError(422, "opencode_invalid_session", `${label} is invalid.`);
};
