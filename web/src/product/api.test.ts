import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpProductClient } from "./api";

describe("Product browser client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("bootstraps exactly once and carries the in-memory CSRF token on mutations", async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      if (String(input).endsWith("/bootstrap")) {
        return new Response(JSON.stringify({
          schemaVersion: 1,
          generation: 1,
          csrfToken: "csrf-token",
          expiresAt: "2026-07-25T00:05:00.000Z",
        }), { status: 201 });
      }
      if (String(input) === "/api/home") {
        return new Response(JSON.stringify({ schemaVersion: 1 }), { status: 200 });
      }
      return new Response(JSON.stringify({
        project: { id: "project-one", name: "Project", lifecycleState: "active" },
      }), { status: 201 });
    }));
    const client = new HttpProductClient();

    await client.home();
    await client.createProject({
      commandId: "command-one",
      name: "Project",
      modelId: "model-one",
    });
    await client.renameConversation({
      commandId: "rename-one",
      conversationId: "conversation-one",
      expectedRecordDigest: "a".repeat(64),
      name: "Renamed",
    });

    expect(calls.filter((call) => String(call.input).endsWith("/bootstrap"))).toHaveLength(1);
    expect(calls[0]?.init).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(calls[2]?.init).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      headers: {
        "content-type": "application/json",
        "x-riff-csrf": "csrf-token",
      },
    });
    expect(calls[3]?.init).toMatchObject({
      method: "PATCH",
      credentials: "same-origin",
      headers: {
        "content-type": "application/json",
        "x-riff-csrf": "csrf-token",
      },
    });
  });

  it("surfaces a stable public API error without leaking response text", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith("/bootstrap")
        ? new Response(JSON.stringify({
          schemaVersion: 1,
          generation: 1,
          csrfToken: "csrf-token",
          expiresAt: "2026-07-25T00:05:00.000Z",
        }), { status: 201 })
        : new Response(JSON.stringify({
          error: { code: "browser_session_denied", message: "The browser request was denied." },
        }), { status: 403 })));

    await expect(new HttpProductClient().home()).rejects.toMatchObject({
      status: 403,
      code: "browser_session_denied",
      message: "The browser request was denied.",
    });
  });

  it("treats a structured turn result as durable read-only without a transport error", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      if (String(input).endsWith("/bootstrap")) {
        return new Response(JSON.stringify({
          schemaVersion: 1,
          generation: 1,
          csrfToken: "csrf-token",
          expiresAt: "2026-07-25T00:05:00.000Z",
        }), { status: 201 });
      }
      return new Response(JSON.stringify({
        mode: "read_only",
        reason: "opencode_unavailable",
        turn: {
          requestKey: "request-one",
          state: "read_only",
          userMessageId: "message-one",
          assistantMessageId: null,
          skillUses: [],
          actions: [],
          failure: { code: "opencode_unavailable", retryable: true },
        },
        messages: [{
          id: "message-one",
          ordinal: 0,
          role: "user",
          status: "complete",
          messageKind: "conversation",
          text: "Hello",
          createdAt: "2026-07-25T00:00:00.000Z",
          updatedAt: "2026-07-25T00:00:00.000Z",
        }],
      }), { status: 200 });
    }));

    const result = await new HttpProductClient().sendTurn({
      requestKey: "request-one",
      conversationId: "conversation-one",
      text: "Hello",
      attachmentIds: [],
    });

    expect(result.mode).toBe("read_only");
    expect(result.messages).toHaveLength(1);
    expect(result.messages.some((message) => message.role === "assistant")).toBe(false);
    expect(calls).toContain("/api/conversations/conversation-one/turns");
  });
});
