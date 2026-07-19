import { randomUUID } from "node:crypto";
import { ProjectStore } from "./project-store.ts";
import type { OpenCodeRuntimeEvent } from "./opencode-adapter.ts";
import type { ProjectState } from "./types.ts";

/** Converts native OpenCode events into the browser's five canonical event types. */
export class OpenCodeEventBridge {
  readonly #sessions = new Map<string, string>();
  readonly #messageIds = new Map<string, string>();
  readonly #seen = new Set<string>();
  private readonly store: ProjectStore;

  constructor(store: ProjectStore) {
    this.store = store;
  }

  bind(openCodeSessionId: string, browserSessionId: string): void {
    this.#sessions.set(openCodeSessionId, browserSessionId);
  }

  unbind(openCodeSessionId: string): void {
    this.#sessions.delete(openCodeSessionId);
  }

  handle(event: OpenCodeRuntimeEvent): void {
    if (event.id && this.#seen.has(event.id)) return;
    if (event.id) this.#seen.add(event.id);
    const properties = event.properties ?? {};
    const openCodeSessionId = string(properties.sessionID);
    const browserSessionId = openCodeSessionId ? this.#sessions.get(openCodeSessionId) : undefined;
    if (!browserSessionId) return;
    if (event.type === "message.part.delta" && properties.field === "text") {
      const messageId = string(properties.messageID);
      const delta = string(properties.delta);
      if (messageId && delta) this.#appendDelta(browserSessionId, messageId, delta);
      return;
    }
    if (event.type === "session.status") {
      const status = string(properties.status);
      const current = this.store.snapshot(browserSessionId).agent;
      if (!current) return;
      const next: ProjectState["agent"] = {
        modelId: current.modelId,
        status: status === "busy" ? "thinking" : status === "idle" ? "ready" : current.status,
        ...(current.lastError ? { lastError: current.lastError } : {}),
      };
      this.store.setAgent(browserSessionId, next);
      return;
    }
    if (event.type === "session.next.tool.called") {
      const tool = string(properties.tool);
      const current = this.store.snapshot(browserSessionId).agent;
      if (tool?.startsWith("riff_") && current) {
        this.store.setAgent(browserSessionId, { modelId: current.modelId, status: "waiting_for_action" });
      }
      return;
    }
    if (event.type === "session.idle") {
      const current = this.store.snapshot(browserSessionId).agent;
      if (current) this.store.setAgent(browserSessionId, { modelId: current.modelId, status: "ready" });
      return;
    }
    if (event.type === "session.error") {
      const current = this.store.snapshot(browserSessionId).agent;
      if (current) this.store.setAgent(browserSessionId, { modelId: current.modelId, status: "error", lastError: { code: "opencode_session_error", message: "The modelling assistant could not complete that turn." } });
    }
  }

  #appendDelta(browserSessionId: string, openCodeMessageId: string, delta: string): void {
    const key = `${browserSessionId}:${openCodeMessageId}`;
    let browserMessageId = this.#messageIds.get(key);
    if (!browserMessageId) {
      browserMessageId = `assistant_${randomUUID()}`;
      this.#messageIds.set(key, browserMessageId);
      this.store.mutate(browserSessionId, (draft) => {
        draft.conversation.push({ id: browserMessageId!, role: "assistant", text: "", status: "streaming", createdAt: new Date().toISOString() });
      });
    }
    this.store.mutate(browserSessionId, (draft) => {
      const message = draft.conversation.find((item) => item.id === browserMessageId);
      if (message) message.text += redact(delta);
    });
    this.store.publish(browserSessionId, { type: "conversation.delta", data: { messageId: browserMessageId, textDelta: redact(delta) } });
  }
}

const string = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
const redact = (text: string): string => text
  .replace(/(?:sk|rk|api)[-_][A-Za-z0-9]{12,}/gi, "[redacted]")
  .replace(/(?:\/Users\/|\/home\/)[^\s)]+/g, "[local path]");
