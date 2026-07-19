import { randomUUID } from "node:crypto";
import { ProjectStore } from "./project-store.ts";
import type { OpenCodeRuntimeEvent } from "./opencode-adapter.ts";
import type { ProjectState } from "./types.ts";

/** Converts native OpenCode events into the browser's five canonical event types. */
export class OpenCodeEventBridge {
  readonly #sessions = new Map<string, string>();
  readonly #messageIds = new Map<string, string>();
  readonly #sessionMessages = new Map<string, Set<string>>();
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
    this.#sessionMessages.delete(openCodeSessionId);
  }

  unbindBrowserSession(browserSessionId: string): void {
    for (const [openCodeSessionId, mappedBrowserSessionId] of this.#sessions) {
      if (mappedBrowserSessionId === browserSessionId) this.unbind(openCodeSessionId);
    }
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
      if (messageId && delta) this.#appendDelta(browserSessionId, openCodeSessionId, messageId, delta);
      return;
    }
    if (event.type === "session.status") {
      const status = string(properties.status);
      if (status === "busy") this.#setAgentStatus(browserSessionId, "thinking");
      if (status === "idle") {
        this.#finishStreaming(browserSessionId, openCodeSessionId, "complete");
        this.#setAgentStatus(browserSessionId, "ready");
      }
      return;
    }
    if (event.type === "session.next.tool.called") {
      const tool = string(properties.tool);
      if (tool?.startsWith("riff_")) this.#setAgentStatus(browserSessionId, "waiting_for_action");
      return;
    }
    if (event.type === "session.idle") {
      this.#finishStreaming(browserSessionId, openCodeSessionId, "complete");
      this.#setAgentStatus(browserSessionId, "ready");
      return;
    }
    if (event.type === "session.error") {
      this.#finishStreaming(browserSessionId, openCodeSessionId, "failed");
      this.#setAgentStatus(browserSessionId, "error", { code: "opencode_session_error", message: "The modelling assistant could not complete that turn." });
    }
  }

  #appendDelta(browserSessionId: string, openCodeSessionId: string, openCodeMessageId: string, delta: string): void {
    const key = `${browserSessionId}:${openCodeSessionId}:${openCodeMessageId}`;
    let browserMessageId = this.#messageIds.get(key);
    if (!browserMessageId) {
      browserMessageId = `assistant_${randomUUID()}`;
      this.#messageIds.set(key, browserMessageId);
      this.store.mutate(browserSessionId, (draft) => {
        draft.conversation.push({ id: browserMessageId!, role: "assistant", text: "", status: "streaming", createdAt: new Date().toISOString() });
      });
      const messages = this.#sessionMessages.get(openCodeSessionId) ?? new Set<string>();
      messages.add(browserMessageId);
      this.#sessionMessages.set(openCodeSessionId, messages);
    }
    const current = this.store.snapshot(browserSessionId).conversation.find((message) => message.id === browserMessageId);
    if (current?.status !== "streaming") return;
    this.store.appendConversationDelta(browserSessionId, browserMessageId, redact(delta));
  }

  #finishStreaming(browserSessionId: string, openCodeSessionId: string, status: "complete" | "failed"): void {
    const messageIds = this.#sessionMessages.get(openCodeSessionId);
    if (!messageIds?.size) return;
    const active = new Set(messageIds);
    this.store.mutate(browserSessionId, (draft) => {
      for (const message of draft.conversation) {
        if (active.has(message.id) && message.status === "streaming") message.status = status;
      }
    });
    this.#sessionMessages.delete(openCodeSessionId);
  }

  #setAgentStatus(browserSessionId: string, status: NonNullable<ProjectState["agent"]>["status"], lastError?: { code: string; message: string }): void {
    const current = this.store.snapshot(browserSessionId).agent;
    if (!current || (current.status === status && JSON.stringify(current.lastError) === JSON.stringify(lastError))) return;
    this.store.setAgent(browserSessionId, {
      modelId: current.modelId,
      status,
      ...(lastError ? { lastError } : {}),
    });
  }
}

const string = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
const redact = (text: string): string => text
  .replace(/(?:sk|rk|api)[-_][A-Za-z0-9]{12,}/gi, "[redacted]")
  .replace(/(?:\/Users\/|\/home\/)[^\s)]+/g, "[local path]");
