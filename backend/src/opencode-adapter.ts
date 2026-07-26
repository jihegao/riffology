import { createHash, randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { ApiError } from "./errors.ts";
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
  /** Backend-only binding for one short-lived, capability-scoped Riff MCP server. */
  scopedMcpScopeId?: string;
};

export type OpenCodeProviderModel = {
  providerId: string;
  modelId: string;
  qualifiedId: string;
};

export type OpenCodeAssistantResponse = {
  messageId: string | null;
  text: string;
  content: { source: "opencode"; textParts: number };
};

export type OpenCodeRuntimeEvent = { id?: string; type?: string; properties?: Record<string, unknown> };

/**
 * Backend-only Product workspace identity. The directory is always resolved by
 * Riff from the durable Conversation owner; browser input must never populate it.
 */
export type OpenCodeWorkspaceBinding = Readonly<{
  owner: { kind: "model" | "project"; id: string };
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
  bindScopedMcp?(scopeId: string, mcpUrl: string, workspace: OpenCodeWorkspaceBinding): Promise<void>;
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
  readonly #scopedMcp = new Map<string, { name: string; url: string; directory: string }>();
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
    await this.#assertSessionWorkspace(sessionId, directory, deadlineSignal);
    const before = await this.#sessionMessages(sessionId, deadlineSignal, directory);
    const priorMessageIds = new Set(before.map(messageId).filter((id): id is string => Boolean(id)));
    // OpenCode treats `directory` as routing context rather than an ownership
    // boundary, so revalidate immediately before the prompt side effect.
    await this.#assertSessionWorkspace(sessionId, directory, deadlineSignal);
    await this.#json(`/session/${encodeURIComponent(sessionId)}/prompt_async`, {
      method: "POST",
      signal: deadlineSignal,
      body: JSON.stringify({
        model,
        system: prompt.system,
        parts,
        tools: this.#promptTools(prompt.scopedMcpScopeId, directory),
      }),
    }, directory);
    return this.#waitForAssistant(
      sessionId,
      priorMessageIds,
      deadlineSignal,
      directory,
      workspace,
    );
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
    workspace?: OpenCodeWorkspaceBinding,
  ): Promise<void> {
    if (this.config.skipLive) return;
    await this.#ensureReady(workspace);
    this.#requireLiveBaseUrl();
    assertOpaqueId(scopeId, "Riff MCP scope ID");
    const directory = this.#workspaceDirectory(workspace);
    const safeMcpUrl = loopbackMcpUrl(mcpUrl).toString();
    const name = scopedMcpName(scopeId);
    const existing = this.#scopedMcp.get(scopeId);
    if (existing?.url === safeMcpUrl && existing.directory === directory) return;
    if (existing && existing.directory !== directory) {
      throw new ApiError(
        409,
        "opencode_mcp_workspace_mismatch",
        "The scoped Riff MCP binding belongs to a different Product workspace.",
      );
    }
    await this.#json("/mcp", {
      method: "POST",
      body: JSON.stringify({ name, config: { type: "remote", url: safeMcpUrl, enabled: true, oauth: false, timeout: 10_000 } }),
    }, directory);
    const connected = await this.#request(
      `/mcp/${encodeURIComponent(name)}/connect`,
      { method: "POST" },
      directory,
    );
    if (!connected.response.ok) throw apiErrorFromResponse(connected.response, connected.payload);
    this.#scopedMcp.set(scopeId, { name, url: safeMcpUrl, directory });
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
    directory: string,
  ): Record<string, boolean> {
    // OpenCode may have unrelated local or plugin MCP servers configured.
    // Deny every tool first, then enable only this turn's opaque Riff scope.
    // The explicit built-in map is retained for compatibility with versions
    // that merge exact names after wildcard rules.
    const tools = { "*": false, ...disabledBuiltInTools() };
    if (!scopeId) return tools;
    const binding = this.#scopedMcp.get(scopeId);
    if (!binding) throw new ApiError(503, "opencode_mcp_unbound", "The scoped Riff MCP server is not bound for this turn.");
    if (binding.directory !== directory) {
      throw new ApiError(
        409,
        "opencode_mcp_workspace_mismatch",
        "The scoped Riff MCP binding belongs to a different Product workspace.",
      );
    }
    return { ...tools, [`${binding.name}_*`]: true };
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

  async #waitForAssistant(
    sessionId: string,
    priorMessageIds: Set<string>,
    deadlineSignal: AbortSignal,
    directory: string,
    workspace?: OpenCodeWorkspaceBinding,
  ): Promise<OpenCodeAssistantResponse> {
    let userMessageId: string | null = null;
    while (!deadlineSignal.aborted) {
      const messages = await this.#sessionMessages(sessionId, deadlineSignal, directory);
      userMessageId ??= messageId(messages.find((entry: any) => entry?.info?.role === "user"
        && !priorMessageIds.has(messageId(entry) ?? "")));
      if (!userMessageId) {
        await abortableDelay(50, deadlineSignal);
        continue;
      }
      const assistants = messages.filter((entry: any) => entry?.info?.role === "assistant" && entry.info.parentID === userMessageId);
      for (const assistant of assistants.toReversed()) {
        if (assistant.info?.error) {
          await this.#ensureReady(workspace, deadlineSignal);
          await this.#assertSessionWorkspace(sessionId, directory, deadlineSignal);
          throw new ApiError(502, "opencode_prompt_failed", "OpenCode failed to complete the assistant response.");
        }
        try {
          const candidate = normalizedAssistantResponse(assistant);
          // A same-URL OpenCode restart can occur after prompt submission.
          // Re-establish server and session identity only once a non-empty
          // response is ready to return; tool-only streaming polls stay cheap.
          await this.#ensureReady(workspace, deadlineSignal);
          await this.#assertSessionWorkspace(sessionId, directory, deadlineSignal);
          return candidate;
        }
        catch (error) {
          if (!(error instanceof ApiError) || error.code !== "opencode_empty_response") throw error;
        }
      }
      await abortableDelay(50, deadlineSignal);
    }
    throw deadlineSignal.reason ?? new ApiError(504, "opencode_prompt_timeout", "OpenCode did not complete the assistant response in time.");
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
      if (!["model", "project"].includes(workspace.owner.kind)
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

  #setReadinessError(code: string, message: string): OpenCodeReadiness {
    this.#readiness = { status: "error", modelId: null, lastError: { code, message } };
    return this.#readiness;
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

const splitQualifiedModel = (qualifiedId: string): { providerId: string; modelId: string } => {
  const result = splitQualifiedModelOrNull(qualifiedId);
  if (!result) throw new ApiError(503, "opencode_invalid_model", "OpenCode returned an invalid provider/model ID.");
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

const normalizedAssistantResponse = (payload: Record<string, any>): OpenCodeAssistantResponse => {
  const parts = Array.isArray(payload.parts) ? payload.parts : Array.isArray(payload.message?.parts) ? payload.message.parts : [];
  const texts = parts
    .filter((part: any) => part && part.type === "text" && typeof part.text === "string" && part.text.trim())
    .map((part: any) => part.text.trim());
  if (!texts.length && typeof payload.text === "string" && payload.text.trim()) texts.push(payload.text.trim());
  const text = texts.join("\n").trim();
  if (!text) throw new ApiError(502, "opencode_empty_response", "OpenCode returned no assistant text.");
  const rawId = payload.info?.id ?? payload.info?.messageID ?? payload.id ?? payload.messageID;
  const messageId = typeof rawId === "string" && rawId.length <= 500 && !/[\u0000-\u001f\u007f]/u.test(rawId) ? rawId : null;
  return { messageId, text, content: { source: "opencode", textParts: texts.length } };
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
