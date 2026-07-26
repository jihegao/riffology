import { join, resolve } from "node:path";
import { ApiError } from "../../backend/src/errors.ts";
import { UnavailableMesaAdapter } from "../../backend/src/mesa-adapter.ts";
import type {
  OpenCodeAdapter,
  OpenCodeAssistantResponse,
  OpenCodeConversationPort,
  OpenCodePrompt,
  OpenCodeReadiness,
} from "../../backend/src/opencode-adapter.ts";
import { BackendApp } from "../../backend/src/server.ts";

class DeterministicConversationProvider
implements OpenCodeAdapter, OpenCodeConversationPort {
  readonly #sessions = new Set<string>();
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
    _sessionId: string,
    binding: { providerId: string; modelId: string },
    prompt: OpenCodePrompt,
  ): Promise<OpenCodeAssistantResponse> {
    if (prompt.text === "[fixture:provider-unavailable]") {
      throw new ApiError(
        503,
        "opencode_unavailable",
        "The deterministic provider is unavailable for this acceptance case.",
      );
    }
    return {
      messageId: `fixture-message-${++this.#sequence}`,
      text: `Assistant (${binding.providerId}/${binding.modelId}) retained: ${prompt.text}`,
      content: { source: "opencode", textParts: 1, parts: [{ ordinal: 0, kind: "text", state: "complete" }] },
    };
  }

  async prompt(): Promise<void> {}
  async abort(): Promise<void> {}
  async bindScopedMcp(): Promise<void> {}
  async unbindScopedMcp(): Promise<void> {}
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
