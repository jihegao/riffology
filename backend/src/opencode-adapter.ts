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

export type OpenCodeRuntimeEvent = { id?: string; type?: string; properties?: Record<string, unknown> };

export interface OpenCodeAdapter {
  initialize(): Promise<OpenCodeReadiness>;
  createSession(projectId: string): Promise<string>;
  prompt(sessionId: string, prompt: OpenCodePrompt): Promise<void>;
  abort(sessionId: string): Promise<void>;
  bindProject?(projectId: string, mcpUrl: string): Promise<void>;
  subscribeEvents?(listener: (event: OpenCodeRuntimeEvent) => void): Promise<() => void>;
}

type OpenCodeConfig = {
  baseUrl?: string;
  serverUsername?: string;
  serverPassword?: string;
  model?: string;
  allowedProviders?: string[];
  skipLive?: boolean;
  fetch?: typeof fetch;
};

export class HttpOpenCodeAdapter implements OpenCodeAdapter {
  readonly #sessions = new Map<string, string>();
  readonly #fetch: typeof fetch;
  private readonly config: OpenCodeConfig;
  readonly #mcpProjects = new Map<string, string>();
  #readiness: OpenCodeReadiness = { status: "unconfigured", modelId: null };

  constructor(config: OpenCodeConfig) {
    this.config = config;
    this.#fetch = config.fetch ?? fetch;
  }

  async initialize(): Promise<OpenCodeReadiness> {
    if (this.config.skipLive) {
      this.#readiness = {
        status: "ready",
        modelId: "dev/deterministic",
      };
      return this.#readiness;
    }
    if (!this.config.baseUrl) {
      this.#readiness = {
        status: "error",
        modelId: null,
        lastError: { code: "opencode_unconfigured", message: "Set OPENCODE_URL and OPENCODE_MODEL to enable the modelling assistant." },
      };
      return this.#readiness;
    }
    try {
      const health = await this.#json("/global/health");
      const providerConfig = await this.#json("/config/providers");
      const models = discoveredModels(providerConfig);
      const configured = this.config.model;
      const candidate = configured && models.includes(configured) ? configured : configured ? undefined : defaultModel(providerConfig, models);
      if (!candidate) {
        this.#readiness = {
          status: "error",
          modelId: null,
          lastError: { code: "opencode_model_unavailable", message: "The configured OpenCode model was not found in the live provider catalogue." },
        };
        return this.#readiness;
      }
      const provider = candidate.split("/", 1)[0];
      const allowed = this.config.allowedProviders?.filter(Boolean);
      if (allowed?.length && !allowed.includes(provider)) {
        this.#readiness = {
          status: "error",
          modelId: null,
          lastError: { code: "opencode_provider_not_allowed", message: "The configured OpenCode provider is not approved for this demo." },
        };
        return this.#readiness;
      }
      this.#readiness = { status: "ready", modelId: candidate, version: typeof health.version === "string" ? health.version : undefined };
      return this.#readiness;
    } catch (error) {
      this.#readiness = {
        status: "error",
        modelId: null,
        lastError: error instanceof ApiError && error.status === 401
          ? { code: "opencode_auth_failed", message: "OpenCode rejected the local server credential." }
          : { code: "opencode_unavailable", message: "The local OpenCode server is not reachable." },
      };
      return this.#readiness;
    }
  }

  async createSession(projectId: string): Promise<string> {
    if (this.#readiness.status !== "ready" || !this.#readiness.modelId) {
      throw new ApiError(503, "agent_not_ready", this.#readiness.lastError?.message ?? "The modelling assistant is not ready.");
    }
    const existing = this.#sessions.get(projectId);
    if (existing) return existing;
    if (this.config.skipLive) {
      const sessionId = `dev-${projectId}`;
      this.#sessions.set(projectId, sessionId);
      return sessionId;
    }
    const session = await this.#json("/session", { method: "POST", body: JSON.stringify({ title: `Riff ${projectId.slice(0, 8)}` }) });
    const sessionId = String(session.id ?? session.sessionID ?? "");
    if (!sessionId) throw new ApiError(502, "opencode_invalid_session", "OpenCode did not return a session ID.");
    this.#sessions.set(projectId, sessionId);
    return sessionId;
  }

  async prompt(sessionId: string, prompt: OpenCodePrompt): Promise<void> {
    if (this.#readiness.status !== "ready" || !this.#readiness.modelId) {
      throw new ApiError(503, "agent_not_ready", this.#readiness.lastError?.message ?? "The modelling assistant is not ready.");
    }
    if (this.config.skipLive) return;
    const attachmentText = prompt.attachments.map((attachment) =>
      `- attachment ${attachment.id}: ${attachment.mediaType}, ${attachment.workspaceRelativePath}`,
    ).join("\n");
    const parts = [{ type: "text", text: `${prompt.text}\n\nAttachments:\n${attachmentText || "(none)"}` }];
    await this.#json(`/session/${encodeURIComponent(sessionId)}/prompt_async`, {
      method: "POST",
      body: JSON.stringify({
        messageID: `msg_${randomUUID()}`,
        model: modelReference(this.#readiness.modelId),
        system: prompt.system,
        parts,
        tools: {
          // OpenCode 1.17 treats this object as built-in tool toggles. Riff's
          // MCP tools are discovered from the registered MCP server instead.
          bash: false,
          write: false,
          edit: false,
          webfetch: false,
        },
      }),
    });
  }

  async abort(sessionId: string): Promise<void> {
    if (!this.config.baseUrl) return;
    await this.#json(`/session/${encodeURIComponent(sessionId)}/abort`, { method: "POST" });
  }

  async bindProject(projectId: string, mcpUrl: string): Promise<void> {
    if (this.config.skipLive || !this.config.baseUrl) return;
    if (this.#mcpProjects.get(projectId) === mcpUrl) return;
    const name = `riff-${projectId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 24)}`;
    await this.#json("/mcp", {
      method: "POST",
      body: JSON.stringify({ name, config: { type: "remote", url: mcpUrl, enabled: true, oauth: false, timeout: 10_000 } }),
    });
    this.#mcpProjects.set(projectId, mcpUrl);
  }

  async subscribeEvents(listener: (event: OpenCodeRuntimeEvent) => void): Promise<() => void> {
    if (!this.config.baseUrl || this.config.skipLive) return () => undefined;
    const controller = new AbortController();
    const response = await this.#fetch(new URL("/event", this.config.baseUrl), {
      headers: this.#authorization(),
      signal: controller.signal,
    });
    if (!response.ok || !response.body) throw new ApiError(503, "opencode_event_unavailable", "OpenCode event streaming is unavailable.");
    void consumeSse(response.body, listener, controller.signal);
    return () => controller.abort();
  }

  async #json(path: string, init: RequestInit = {}): Promise<Record<string, any>> {
    let response: Response;
    try {
      response = await this.#fetch(new URL(path, this.config.baseUrl), {
        ...init,
        headers: { "content-type": "application/json", ...this.#authorization(), ...(init.headers ?? {}) },
      });
    } catch {
      throw new ApiError(503, "opencode_unavailable", "The local OpenCode server is not reachable.");
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new ApiError(response.status, String(payload?.error?.code ?? "opencode_error"), "OpenCode rejected the local request.");
    return payload;
  }

  #authorization(): Record<string, string> {
    if (!this.config.serverPassword) return {};
    const username = this.config.serverUsername || "opencode";
    return { authorization: `Basic ${Buffer.from(`${username}:${this.config.serverPassword}`).toString("base64")}` };
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

const discoveredModels = (payload: Record<string, any>): string[] => {
  const found = new Set<string>();
  const providers = payload.providers ?? payload.all ?? [];
  const list = Array.isArray(providers) ? providers : Object.entries(providers).map(([id, value]) => ({ id, ...(value as object) }));
  for (const provider of list) {
    const providerId = String(provider.id ?? provider.name ?? "");
    const models = provider.models ?? {};
    if (Array.isArray(models)) {
      for (const model of models) found.add(`${providerId}/${String(model.id ?? model.name ?? model)}`);
    } else if (models && typeof models === "object") {
      for (const [modelKey, model] of Object.entries(models)) found.add(String((model as any)?.id?.includes?.("/") ? (model as any).id : `${providerId}/${modelKey}`));
    }
  }
  return [...found];
};

const defaultModel = (payload: Record<string, any>, models: string[]): string | undefined => {
  const defaults = payload.default ?? {};
  for (const value of Object.values(defaults)) {
    if (typeof value === "string" && models.includes(value)) return value;
  }
  return models[0];
};

const modelReference = (modelId: string): { providerID: string; modelID: string } => {
  const slash = modelId.indexOf("/");
  if (slash <= 0 || slash === modelId.length - 1) throw new ApiError(503, "opencode_invalid_model", "OpenCode returned an invalid provider/model ID.");
  return { providerID: modelId.slice(0, slash), modelID: modelId.slice(slash + 1) };
};

const consumeSse = async (stream: ReadableStream<Uint8Array>, listener: (event: OpenCodeRuntimeEvent) => void, signal: AbortSignal): Promise<void> => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!signal.aborted) {
      const next = await reader.read();
      if (next.done) return;
      buffer += decoder.decode(next.value, { stream: true });
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
    // The bridge will retain canonical state and reconnect on the next startup.
  } finally {
    reader.releaseLock();
  }
};
