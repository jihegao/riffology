import { randomUUID } from "node:crypto";
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
};

export type OpenCodeProviderModel = {
  providerId: string;
  modelId: string;
  qualifiedId: string;
};

export type OpenCodeRuntimeEvent = { id?: string; type?: string; properties?: Record<string, unknown> };

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
  discoverProviderModels(): Promise<OpenCodeProviderModel[]>;
  getSession(sessionId: string): Promise<boolean>;
  createSession(conversationId: string): Promise<string>;
  injectContext(sessionId: string, context: string, signal?: AbortSignal): Promise<void>;
  promptWithModel(
    sessionId: string,
    binding: { providerId: string; modelId: string },
    prompt: OpenCodePrompt,
    signal?: AbortSignal,
  ): Promise<void>;
  abort(sessionId: string): Promise<void>;
}

export type OpenCodeConfig = {
  baseUrl?: string;
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

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_000_000;
const DEFAULT_MAX_EVENT_BUFFER_BYTES = 256_000;

export class HttpOpenCodeAdapter implements OpenCodeAdapter, OpenCodeConversationPort {
  readonly #fetch: typeof fetch;
  private readonly config: OpenCodeConfig;
  readonly #mcpProjects = new Map<string, string>();
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
    if (this.config.skipLive) {
      // Compatibility-only deterministic mode for the old component-test route.
      this.#readiness = { status: "ready", modelId: "dev/deterministic" };
      return this.#readiness;
    }
    if (!this.#baseUrl) return this.#setReadinessError("opencode_unconfigured", "Set OPENCODE_URL and OPENCODE_MODEL to enable the modelling assistant.");
    if (!this.config.model) return this.#setReadinessError("opencode_model_unconfigured", "Select an explicit provider/model before enabling the modelling assistant.");
    try {
      const binding = splitQualifiedModel(this.config.model);
      const allowed = new Set((this.config.allowedProviders ?? []).map((value) => value.trim()).filter(Boolean));
      if (allowed.size && !allowed.has(binding.providerId)) {
        return this.#setReadinessError("opencode_provider_not_allowed", "The configured OpenCode provider is not approved.");
      }
      const health = await this.#json("/global/health");
      const models = await this.discoverProviderModels();
      const candidate = models.find((item) => item.providerId === binding.providerId && item.modelId === binding.modelId);
      if (!candidate) return this.#setReadinessError("opencode_model_unavailable", "The configured OpenCode model was not found in the live provider catalogue.");
      this.#readiness = { status: "ready", modelId: candidate.qualifiedId, version: typeof health.version === "string" ? health.version : undefined };
      return this.#readiness;
    } catch (error) {
      return this.#setReadinessError(
        error instanceof ApiError && error.status === 401 ? "opencode_auth_failed" : "opencode_unavailable",
        error instanceof ApiError && error.status === 401 ? "OpenCode rejected the local server credential." : "The local OpenCode server is not reachable.",
      );
    }
  }

  async discoverProviderModels(): Promise<OpenCodeProviderModel[]> {
    this.#requireLiveBaseUrl();
    const payload = await this.#json("/config/providers");
    const allowed = new Set((this.config.allowedProviders ?? []).map((value) => value.trim()).filter(Boolean));
    return discoveredProviderModels(payload).filter((item) => !allowed.size || allowed.has(item.providerId));
  }

  async getSession(sessionId: string): Promise<boolean> {
    this.#requireLiveBaseUrl();
    assertOpaqueId(sessionId, "OpenCode session ID");
    const result = await this.#request(`/session/${encodeURIComponent(sessionId)}`, { method: "GET" });
    if (result.response.status === 404) return false;
    if (!result.response.ok) throw apiErrorFromResponse(result.response, result.payload);
    return true;
  }

  async createSession(projectOrConversationId: string): Promise<string> {
    if (this.config.skipLive) return `dev-${projectOrConversationId}-${randomUUID()}`;
    this.#requireLiveBaseUrl();
    const session = await this.#json("/session", {
      method: "POST",
      body: JSON.stringify({ title: `Riff ${safeTitleFragment(projectOrConversationId)}` }),
    });
    const sessionId = String(session.id ?? session.sessionID ?? "");
    if (!sessionId) throw new ApiError(502, "opencode_invalid_session", "OpenCode did not return a session ID.");
    assertOpaqueId(sessionId, "OpenCode session ID");
    return sessionId;
  }

  async injectContext(sessionId: string, context: string, signal?: AbortSignal): Promise<void> {
    if (this.config.skipLive) return;
    assertOpaqueId(sessionId, "OpenCode session ID");
    if (!context) return;
    await this.#json(`/session/${encodeURIComponent(sessionId)}/message`, {
      method: "POST",
      signal,
      body: JSON.stringify({
        messageID: `msg_${randomUUID()}`,
        noReply: true,
        parts: [{ type: "text", text: context }],
        tools: disabledBuiltInTools(),
      }),
    });
  }

  async promptWithModel(
    sessionId: string,
    binding: { providerId: string; modelId: string },
    prompt: OpenCodePrompt,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.config.skipLive) return;
    assertOpaqueId(sessionId, "OpenCode session ID");
    const model = validatedModelReference(binding);
    const allowed = new Set((this.config.allowedProviders ?? []).map((value) => value.trim()).filter(Boolean));
    if (allowed.size && !allowed.has(model.providerID)) throw new ApiError(503, "opencode_provider_not_allowed", "The selected OpenCode provider is not allowed.");
    const attachmentText = prompt.attachments.map((attachment) =>
      `- attachment ${safeContextLabel(attachment.id)}: ${safeContextLabel(attachment.mediaType)}, ${safeContextLabel(attachment.workspaceRelativePath)}`,
    ).join("\n");
    const parts = [{ type: "text", text: `${prompt.text}\n\nAttachments:\n${attachmentText || "(none)"}` }];
    await this.#json(`/session/${encodeURIComponent(sessionId)}/message`, {
      method: "POST",
      signal,
      body: JSON.stringify({
        messageID: `msg_${randomUUID()}`,
        model,
        system: prompt.system,
        parts,
        tools: disabledBuiltInTools(),
      }),
    });
  }

  async prompt(sessionId: string, prompt: OpenCodePrompt, signal?: AbortSignal): Promise<void> {
    if (this.config.skipLive) return;
    if (this.#readiness.status !== "ready" || !this.#readiness.modelId) {
      throw new ApiError(503, "agent_not_ready", this.#readiness.lastError?.message ?? "The modelling assistant is not ready.");
    }
    await this.promptWithModel(sessionId, splitQualifiedModel(this.#readiness.modelId), prompt, signal);
  }

  async abort(sessionId: string): Promise<void> {
    if (!this.#baseUrl || this.config.skipLive) return;
    assertOpaqueId(sessionId, "OpenCode session ID");
    await this.#json(`/session/${encodeURIComponent(sessionId)}/abort`, { method: "POST" });
  }

  async bindProject(projectId: string, mcpUrl: string): Promise<void> {
    if (this.config.skipLive) return;
    this.#requireLiveBaseUrl();
    const safeMcpUrl = loopbackHttpUrl(mcpUrl, "Riff MCP URL").toString();
    if (this.#mcpProjects.get(projectId) === safeMcpUrl) return;
    const name = `riff-${projectId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 24)}`;
    await this.#json("/mcp", {
      method: "POST",
      body: JSON.stringify({ name, config: { type: "remote", url: safeMcpUrl, enabled: true, oauth: false, timeout: 10_000 } }),
    });
    this.#mcpProjects.set(projectId, safeMcpUrl);
  }

  async subscribeEvents(listener: (event: OpenCodeRuntimeEvent) => void): Promise<() => void> {
    if (!this.#baseUrl || this.config.skipLive) return () => undefined;
    const controller = new AbortController();
    let response: Response;
    try {
      response = await this.#fetch(new URL("/event", this.#baseUrl), {
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

  async #json(path: string, init: RequestInit = {}): Promise<Record<string, any>> {
    const result = await this.#request(path, init);
    if (!result.response.ok) throw apiErrorFromResponse(result.response, result.payload);
    return result.payload;
  }

  async #request(path: string, init: RequestInit): Promise<{ response: Response; payload: Record<string, any> }> {
    const base = this.#requireLiveBaseUrl();
    // Existing callers already impose a stricter turn timeout and require their
    // exact signal to reach fetch. Unsignalled discovery/session calls receive
    // the adapter's own bounded timeout.
    const signal = init.signal ?? AbortSignal.timeout(this.#requestTimeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(new URL(path, base), {
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

  #setReadinessError(code: string, message: string): OpenCodeReadiness {
    this.#readiness = { status: "error", modelId: null, lastError: { code, message } };
    return this.#readiness;
  }
}

export const opencodeFromEnvironment = (env: NodeJS.ProcessEnv = process.env): HttpOpenCodeAdapter => new HttpOpenCodeAdapter({
  baseUrl: env.OPENCODE_URL,
  serverUsername: env.OPENCODE_SERVER_USERNAME,
  serverPassword: env.OPENCODE_SERVER_PASSWORD,
  model: env.OPENCODE_MODEL,
  allowedProviders: env.OPENCODE_ALLOWED_PROVIDERS?.split(",").map((value) => value.trim()),
  skipLive: env.RIFF_SKIP_OPENCODE === "true",
});

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

const isLoopbackHostname = (hostname: string): boolean => {
  const normalized = hostname.toLowerCase();
  if (normalized === "localhost" || normalized === "[::1]" || normalized === "::1") return true;
  const match = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(normalized);
  return Boolean(match && match.slice(1).every((part) => Number(part) <= 255));
};

const readBoundedJson = async (response: Response, maximumBytes: number): Promise<Record<string, any>> => {
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
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { throw new ApiError(502, "opencode_invalid_response", "OpenCode returned invalid JSON."); }
};

const apiErrorFromResponse = (response: Response, payload: Record<string, any>): ApiError =>
  new ApiError(response.status, String(payload?.error?.code ?? "opencode_error"), "OpenCode rejected the local request.");

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

const isRedirect = (status: number): boolean => status >= 300 && status < 400;
const safeTitleFragment = (value: string): string => value.replace(/[^A-Za-z0-9_-]/gu, "").slice(0, 32) || "conversation";
const safeContextLabel = (value: string): string => value.replace(/[\r\n\u0000-\u001f\u007f]/gu, " ").slice(0, 500);
const assertOpaqueId = (value: string, label: string): void => {
  if (!value || value.length > 500 || /[\u0000-\u001f\u007f]/u.test(value)) throw new ApiError(422, "opencode_invalid_session", `${label} is invalid.`);
};
