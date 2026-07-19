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

export interface OpenCodeAdapter {
  initialize(): Promise<OpenCodeReadiness>;
  createSession(projectId: string): Promise<string>;
  prompt(sessionId: string, prompt: OpenCodePrompt): Promise<void>;
  abort(sessionId: string): Promise<void>;
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
  #readiness: OpenCodeReadiness = { status: "unconfigured", modelId: null };

  constructor(config: OpenCodeConfig) {
    this.config = config;
    this.#fetch = config.fetch ?? fetch;
  }

  async initialize(): Promise<OpenCodeReadiness> {
    if (this.config.skipLive) {
      this.#readiness = {
        status: "error",
        modelId: null,
        lastError: { code: "opencode_skipped", message: "Live OpenCode is disabled by RIFF_SKIP_OPENCODE for local development." },
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
    const attachmentText = prompt.attachments.map((attachment) =>
      `- attachment ${attachment.id}: ${attachment.mediaType}, ${attachment.workspaceRelativePath}`,
    ).join("\n");
    const parts = [{ type: "text", text: `${prompt.text}\n\nAttachments:\n${attachmentText || "(none)"}` }];
    await this.#json(`/session/${encodeURIComponent(sessionId)}/prompt_async`, {
      method: "POST",
      body: JSON.stringify({
        messageID: randomUUID(),
        model: this.#readiness.modelId,
        system: prompt.system,
        parts,
        tools: {
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
