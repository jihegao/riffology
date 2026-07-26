import { join, resolve } from "node:path";
import { ApiError } from "../../backend/src/errors.ts";
import { UnavailableMesaAdapter } from "../../backend/src/mesa-adapter.ts";
import type {
  OpenCodeAdapter,
  OpenCodeAssistantResponse,
  OpenCodeConversationPort,
  OpenCodeConversationRuntimeSnapshot,
  OpenCodePrompt,
  OpenCodeReadiness,
  OpenCodeWorkspaceBinding,
} from "../../backend/src/opencode-adapter.ts";
import { BackendApp } from "../../backend/src/server.ts";

class DeterministicConversationProvider
implements OpenCodeAdapter, OpenCodeConversationPort {
  readonly #sessions = new Set<string>();
  readonly #nativeTurns = new Map<string, {
    mode: "controls" | "stoppable";
    permissionPending: boolean;
    questionPending: boolean;
    resolve: (response: OpenCodeAssistantResponse) => void;
    reject: (reason: unknown) => void;
  }>();
  readonly #promptCounts = new Map<string, number>();
  #sequence = 0;

  async initialize(): Promise<OpenCodeReadiness> {
    return {
      status: "ready",
      modelId: "fixture/model-a",
      version: "a4-3-deterministic",
    };
  }

  async discoverProviderModels() {
    return [
      {
        providerId: "fixture",
        modelId: "model-a",
        qualifiedId: "fixture/model-a",
      },
      {
        providerId: "fixture",
        modelId: "model-b",
        qualifiedId: "fixture/model-b",
      },
    ];
  }

  async discoverAgents(_workspace: OpenCodeWorkspaceBinding) {
    return [{
      name: "planner",
      description: "Plans work inside the current Product owner.",
      mode: "primary" as const,
      native: true,
    }];
  }

  async getSession(sessionId: string): Promise<boolean> {
    return this.#sessions.has(sessionId);
  }

  async createSession(conversationId: string): Promise<string> {
    const sessionId = `fixture-session-${conversationId}-${++this.#sequence}`;
    this.#sessions.add(sessionId);
    return sessionId;
  }

  async injectContext(): Promise<void> {}

  async promptWithModel(
    sessionId: string,
    binding: { providerId: string; modelId: string },
    prompt: OpenCodePrompt,
    signal?: AbortSignal,
  ): Promise<OpenCodeAssistantResponse> {
    if (prompt.text === "[fixture:provider-unavailable]") {
      throw new ApiError(
        503,
        "opencode_unavailable",
        "The deterministic provider is unavailable for this acceptance case.",
      );
    }
    if (prompt.text === "[fixture:native-controls]") {
      return this.#pendingNativeTurn(sessionId, "controls", signal);
    }
    if (prompt.text === "[fixture:stop-and-retry]") {
      const count = (this.#promptCounts.get(prompt.text) ?? 0) + 1;
      this.#promptCounts.set(prompt.text, count);
      if (count === 1) return this.#pendingNativeTurn(sessionId, "stoppable", signal);
      return this.#response("Retry completed through the durable original intent.");
    }
    return {
      messageId: `fixture-message-${++this.#sequence}`,
      text: `Assistant (${binding.providerId}/${binding.modelId}) retained: ${prompt.text}`,
      content: { source: "opencode", textParts: 1, parts: [{ ordinal: 0, kind: "text", state: "complete" }] },
    };
  }

  async prompt(): Promise<void> {}
  async abort(sessionId: string, _workspace?: OpenCodeWorkspaceBinding): Promise<void> {
    const active = this.#nativeTurns.get(sessionId);
    if (!active) return;
    this.#nativeTurns.delete(sessionId);
    active.reject(new ApiError(
      409,
      "opencode_session_aborted",
      "The deterministic native turn was stopped.",
    ));
  }
  async runtimeSnapshot(
    sessionId: string,
    _scopeId: string | undefined,
    _workspace: OpenCodeWorkspaceBinding,
  ): Promise<OpenCodeConversationRuntimeSnapshot> {
    const active = this.#nativeTurns.get(sessionId);
    if (!active) {
      return {
        status: "idle",
        assistant: null,
        tools: [],
        interactions: [],
        failureCode: null,
        scopedMcp: { label: "Riff tools", status: "disconnected" },
      };
    }
    return {
      status: "busy",
      assistant: {
        status: "streaming",
        text: active.mode === "controls"
          ? "I inspected the Model and need confirmation."
          : "Waiting for the long-running fixture to finish.",
      },
      tools: active.mode === "controls" ? [{
        id: "tool_public_inspect",
        tool: "Riff inspect workspace",
        title: "Workspace inspected",
        status: "completed",
      }] : [],
      interactions: active.mode === "controls" ? [
        ...(active.permissionPending ? [{
          id: "permission_public_model_update",
          kind: "permission" as const,
          title: "Allow Model update",
          permission: "Allow this scoped change once for the current turn?",
        }] : []),
        ...(active.questionPending ? [{
          id: "question_public_output_details",
          kind: "question" as const,
          questions: [{
            header: "Choose output details",
            question: "Which views should be enabled?",
            multiple: true,
            custom: true,
            options: [{
              id: `choice_${"a".repeat(32)}`,
              label: "Chart",
              description: "Add a chart.",
            }, {
              id: `choice_${"b".repeat(32)}`,
              label: "Table",
              description: "Add a table.",
            }],
          }, {
            header: "Short note",
            question: "Add a short note.",
            multiple: false,
            custom: true,
            options: [],
          }],
        }] : []),
      ] : [],
      failureCode: null,
      scopedMcp: { label: "Riff tools", status: "connected" },
    };
  }
  async respondPermission(
    sessionId: string,
    publicRequestId: string,
    response: "once" | "reject",
    _workspace: OpenCodeWorkspaceBinding,
  ): Promise<void> {
    const active = this.#nativeTurns.get(sessionId);
    if (!active || active.mode !== "controls" || !active.permissionPending
      || publicRequestId !== "permission_public_model_update") {
      throw new ApiError(409, "interaction_not_pending", "Permission is not pending.");
    }
    if (response === "reject") {
      this.#nativeTurns.delete(sessionId);
      active.reject(new ApiError(409, "opencode_session_aborted", "Permission was rejected."));
      return;
    }
    active.permissionPending = false;
    this.#completeControlsIfReady(sessionId, active);
  }
  async respondQuestion(
    sessionId: string,
    publicRequestId: string,
    response: { answers: string[][] } | { reject: true },
    _workspace: OpenCodeWorkspaceBinding,
  ): Promise<void> {
    const active = this.#nativeTurns.get(sessionId);
    if (!active || active.mode !== "controls" || !active.questionPending
      || publicRequestId !== "question_public_output_details") {
      throw new ApiError(409, "interaction_not_pending", "Question is not pending.");
    }
    if ("reject" in response) {
      this.#nativeTurns.delete(sessionId);
      active.reject(new ApiError(409, "opencode_session_aborted", "Question was rejected."));
      return;
    }
    active.questionPending = false;
    this.#completeControlsIfReady(sessionId, active);
  }
  releaseRuntimeBoundary(): void {}
  async bindScopedMcp(): Promise<void> {}
  async unbindScopedMcp(): Promise<void> {}

  #pendingNativeTurn(
    sessionId: string,
    mode: "controls" | "stoppable",
    signal?: AbortSignal,
  ): Promise<OpenCodeAssistantResponse> {
    return new Promise<OpenCodeAssistantResponse>((resolve, reject) => {
      const onAbort = () => {
        this.#nativeTurns.delete(sessionId);
        reject(signal?.reason ?? new ApiError(
          409,
          "opencode_session_aborted",
          "The deterministic native turn was stopped.",
        ));
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#nativeTurns.set(sessionId, {
        mode,
        permissionPending: mode === "controls",
        questionPending: mode === "controls",
        resolve: (response) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(response);
        },
        reject: (reason) => {
          signal?.removeEventListener("abort", onAbort);
          reject(reason);
        },
      });
    });
  }

  #completeControlsIfReady(
    sessionId: string,
    active: {
      permissionPending: boolean;
      questionPending: boolean;
      resolve: (response: OpenCodeAssistantResponse) => void;
    },
  ): void {
    if (active.permissionPending || active.questionPending) return;
    this.#nativeTurns.delete(sessionId);
    active.resolve(this.#response("Native controls completed through the real Product API."));
  }

  #response(text: string): OpenCodeAssistantResponse {
    return {
      messageId: `fixture-message-${++this.#sequence}`,
      text,
      content: {
        source: "opencode",
        textParts: 1,
        parts: [{ ordinal: 0, kind: "text", state: "complete" }],
      },
    };
  }
}

const port = Number(process.env.PORT ?? 8787);
const workspaceRoot = process.env.WORKSPACE_ROOT;
if (!workspaceRoot || !Number.isSafeInteger(port)) {
  throw new Error("The A4-3 browser fixture requires WORKSPACE_ROOT and PORT.");
}

const openCode = new DeterministicConversationProvider();
const app = new BackendApp({
  mesa: new UnavailableMesaAdapter(),
  openCode,
  a2OpenCode: openCode,
  a2ProductRoot: join(workspaceRoot, "product"),
  a3InstallPreinstalledWind: true,
  a3PreinstalledWindRepositoryRoot: resolve(import.meta.dirname, "../.."),
  workspaceRoot: join(workspaceRoot, "workspace"),
});
await app.initialize();
const network = await app.listenBrowserNetwork(port);
console.log(`A4-3 browser fixture listening at ${network.app.origin}`);

let closing = false;
const close = (): void => {
  if (closing) return;
  closing = true;
  void app.close().finally(() => process.exit(0));
};
process.once("SIGINT", close);
process.once("SIGTERM", close);
