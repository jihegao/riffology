import { ApiError } from "./errors.ts";
import { buildBoundedAgentContext, type AgentContextInput, type AgentContextLimits, type BoundedAgentContext } from "./agent-context.ts";
import type { OpenCodeAssistantResponse, OpenCodeConversationPort } from "./opencode-adapter.ts";

export type DurableConversationRuntime = {
  conversationId: string;
  owner: { kind: "model" | "project"; id: string };
  providerId: string;
  providerModelId: string;
  session: null | {
    generation: number;
    state: "creating" | "available" | "lost" | "rebuilding" | "closed";
    externalSessionRef: string | null;
  };
};

/** Repository port deliberately contains no SQL or ProductStoreV2 implementation details. */
export interface AgentSessionRepositoryPort {
  getConversationRuntime(conversationId: string): Promise<DurableConversationRuntime | null>;
  markSessionLost(input: { conversationId: string; generation: number; expectedExternalSessionRef: string; reason: string }): Promise<void>;
  beginSessionGeneration(input: { conversationId: string; expectedGeneration: number | null }): Promise<{ generation: number }>;
  activateSession(input: { conversationId: string; generation: number; externalSessionRef: string; contextSha256: string }): Promise<void>;
  failSessionGeneration(input: { conversationId: string; generation: number; reason: string }): Promise<void>;
}

export type AgentReadOnlyReason =
  | "opencode_unavailable"
  | "opencode_auth_failed"
  | "provider_unavailable"
  | "model_unavailable"
  | "session_validation_failed"
  | "session_rebuild_failed"
  | "empty_assistant_response";

export type PreparedConversationSession =
  | {
      mode: "live";
      conversationId: string;
      generation: number;
      /** Backend-only. Never include this value in a browser DTO or context. */
      externalSessionRef: string;
      providerId: string;
      modelId: string;
      reconstructed: boolean;
      context: BoundedAgentContext;
    }
  | { mode: "read_only"; conversationId: string; reason: AgentReadOnlyReason; retryable: boolean };

export type ConversationPromptResult =
  | (Extract<PreparedConversationSession, { mode: "live" }> & { assistant: OpenCodeAssistantResponse })
  | Extract<PreparedConversationSession, { mode: "read_only" }>;

export class AgentConversationSessionManager {
  readonly #pending = new Map<string, Promise<PreparedConversationSession>>();
  readonly #repository: AgentSessionRepositoryPort;
  readonly #openCode: OpenCodeConversationPort;
  readonly #contextLimits: Partial<AgentContextLimits>;

  constructor(
    repository: AgentSessionRepositoryPort,
    openCode: OpenCodeConversationPort,
    contextLimits: Partial<AgentContextLimits> = {},
  ) {
    this.#repository = repository;
    this.#openCode = openCode;
    this.#contextLimits = contextLimits;
  }

  ensureSession(conversationId: string, contextInput: AgentContextInput): Promise<PreparedConversationSession> {
    const active = this.#pending.get(conversationId);
    if (active) return active;
    const operation = this.#ensure(conversationId, contextInput).finally(() => {
      if (this.#pending.get(conversationId) === operation) this.#pending.delete(conversationId);
    });
    this.#pending.set(conversationId, operation);
    return operation;
  }

  async prompt(
    conversationId: string,
    contextInput: AgentContextInput,
    text: string,
    attachments: Array<{ id: string; mediaType: string; workspaceRelativePath: string }> = [],
    scopedMcpScopeId?: string,
    signal?: AbortSignal,
  ): Promise<ConversationPromptResult> {
    const prepared = await this.ensureSession(conversationId, contextInput);
    if (prepared.mode === "read_only") return prepared;
    try {
      const assistant = await this.#openCode.promptWithModel(
        prepared.externalSessionRef,
        { providerId: prepared.providerId, modelId: prepared.modelId },
        { text, system: prepared.context.text, attachments, ...(scopedMcpScopeId ? { scopedMcpScopeId } : {}) },
        signal,
      );
      return { ...prepared, assistant };
    } catch (error) {
      const reason = stableReason(error, "opencode_unavailable");
      // A prompt may have reached OpenCode even when the client times out or
      // disconnects. Retiring that opaque session prevents a late user/assistant
      // pair from being mistaken for the next serialized Riff turn.
      await this.#openCode.abort(prepared.externalSessionRef).catch(() => undefined);
      await this.#repository.markSessionLost({
        conversationId,
        generation: prepared.generation,
        expectedExternalSessionRef: prepared.externalSessionRef,
        reason: `prompt_failed:${reason}`,
      });
      if (signal?.aborted) throw error;
      return { mode: "read_only", conversationId, reason, retryable: true };
    }
  }

  async #ensure(conversationId: string, contextInput: AgentContextInput): Promise<PreparedConversationSession> {
    const runtime = await this.#repository.getConversationRuntime(conversationId);
    if (!runtime) throw new ApiError(404, "conversation_not_found", "The conversation does not exist.");
    if (runtime.conversationId !== contextInput.conversationId || runtime.owner.kind !== contextInput.owner.kind || runtime.owner.id !== contextInput.owner.id) {
      throw new ApiError(409, "conversation_context_mismatch", "The bounded context does not belong to this conversation.");
    }
    const context = buildBoundedAgentContext(contextInput, this.#contextLimits);
    let catalogue;
    try { catalogue = await this.#openCode.discoverProviderModels(); }
    catch (error) {
      return { mode: "read_only", conversationId, reason: stableReason(error, "opencode_unavailable"), retryable: true };
    }
    const providerExists = catalogue.some((item) => item.providerId === runtime.providerId);
    if (!providerExists) return { mode: "read_only", conversationId, reason: "provider_unavailable", retryable: true };
    const modelExists = catalogue.some((item) => item.providerId === runtime.providerId && item.modelId === runtime.providerModelId);
    if (!modelExists) return { mode: "read_only", conversationId, reason: "model_unavailable", retryable: true };

    const current = runtime.session;
    if (current?.state === "available" && current.externalSessionRef) {
      try {
        if (await this.#openCode.getSession(current.externalSessionRef)) {
          return {
            mode: "live", conversationId, generation: current.generation, externalSessionRef: current.externalSessionRef,
            providerId: runtime.providerId, modelId: runtime.providerModelId, reconstructed: false, context,
          };
        }
        await this.#repository.markSessionLost({
          conversationId,
          generation: current.generation,
          expectedExternalSessionRef: current.externalSessionRef,
          reason: "external_session_missing",
        });
      } catch (error) {
        return { mode: "read_only", conversationId, reason: stableReason(error, "session_validation_failed"), retryable: true };
      }
    }

    let generation: number | undefined;
    try {
      const started = await this.#repository.beginSessionGeneration({ conversationId, expectedGeneration: current?.generation ?? null });
      generation = started.generation;
      const externalSessionRef = await this.#openCode.createSession(conversationId);
      await this.#openCode.injectContext(externalSessionRef, context.text);
      await this.#repository.activateSession({ conversationId, generation, externalSessionRef, contextSha256: context.sha256 });
      return {
        mode: "live", conversationId, generation, externalSessionRef, providerId: runtime.providerId,
        modelId: runtime.providerModelId, reconstructed: true, context,
      };
    } catch (error) {
      if (generation !== undefined) await this.#repository.failSessionGeneration({ conversationId, generation, reason: "session_rebuild_failed" }).catch(() => undefined);
      return { mode: "read_only", conversationId, reason: stableReason(error, "session_rebuild_failed"), retryable: true };
    }
  }
}

const stableReason = (error: unknown, fallback: AgentReadOnlyReason): AgentReadOnlyReason => {
  if (!(error instanceof ApiError)) return fallback;
  if (error.code === "opencode_auth_failed" || error.status === 401) return "opencode_auth_failed";
  if (["opencode_unavailable", "opencode_unconfigured", "agent_not_ready"].includes(error.code)) return "opencode_unavailable";
  if (error.code === "opencode_model_unavailable") return "model_unavailable";
  if (error.code === "opencode_empty_response") return "empty_assistant_response";
  return fallback;
};
