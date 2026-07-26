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
          brokerOrigin: "http://localhost:8788",
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
          brokerOrigin: "http://localhost:8788",
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
          brokerOrigin: "http://localhost:8788",
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

  it("uses typed PR3 turn-control routes without exposing a session identifier", async () => {
    const calls: Array<{ input: string; body?: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input: String(input), body: typeof init?.body === "string" ? init.body : undefined });
      if (String(input).endsWith("/bootstrap")) {
        return new Response(JSON.stringify({
          schemaVersion: 1,
          generation: 1,
          csrfToken: "csrf-token",
          platformOrigin: "http://localhost:8787",
          brokerOrigin: "http://localhost:8788",
          expiresAt: "2026-07-25T00:05:00.000Z",
        }), { status: 201 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }));
    const client = new HttpProductClient();

    await client.stopConversation({
      conversationId: "conversation-one",
      requestKey: "turn-one",
    });
    await client.retryConversation({
      conversationId: "conversation-one",
      oldRequestKey: "turn-one",
      newRequestKey: "turn-two",
    });
    await client.respondConversationInteraction({
      conversationId: "conversation-one",
      requestKey: "turn-one",
      interactionId: "permission-one",
      kind: "permission",
      decision: "allow_once",
    });
    await client.respondConversationInteraction({
      conversationId: "conversation-one",
      requestKey: "turn-one",
      interactionId: "question-one",
      kind: "question",
      response: { answers: [["alpha", "beta"], ["custom"]] },
    });

    expect(calls.map((call) => call.input)).toEqual([
      "/api/browser-session/bootstrap",
      "/api/conversations/conversation-one/turns/turn-one/stop",
      "/api/conversations/conversation-one/turns/turn-one/retry",
      "/api/conversations/conversation-one/turns/turn-one/resume",
      "/api/conversations/conversation-one/turns/turn-one/resume",
    ]);
    expect(JSON.parse(calls[1].body ?? "{}")).toEqual({});
    expect(JSON.parse(calls[2].body ?? "{}")).toEqual({
      requestKey: "turn-two",
    });
    expect(JSON.parse(calls[3].body ?? "{}")).toEqual({
      interactionId: "permission-one",
      kind: "permission",
      decision: "once",
    });
    expect(JSON.parse(calls[4].body ?? "{}")).toEqual({
      interactionId: "question-one",
      kind: "question",
      answers: [["alpha", "beta"], ["custom"]],
    });
    expect(JSON.stringify(calls)).not.toContain("sessionID");
    expect(JSON.stringify(calls)).not.toContain("capability");
  });

  it("parses only the closed public runtime DTO and rejects the internal service shape", async () => {
    const choiceId = `choice_${"a".repeat(32)}`;
    let runtimeBody: unknown = {
      schemaVersion: 1,
      revision: "runtime-revision",
      status: "waiting_for_user",
      activeTurn: { requestKey: "turn-one", canStop: true, canRetry: false },
      parts: [{
        id: "assistant-one",
        kind: "text",
        state: "streaming",
        title: "Assistant",
        summary: "Choose one.",
      }],
      pendingInteractions: [{
        id: "question-one",
        kind: "question",
        title: "Choice",
        questions: [{
          prompt: "Which option?",
          multiple: false,
          custom: false,
          choices: [{ value: choiceId, label: "Same public label" }],
        }],
      }],
      agent: { selectedName: "build", locked: true },
      mcp: { state: "connected", label: "Riff tools" },
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith("/bootstrap")
        ? new Response(JSON.stringify({
          schemaVersion: 1,
          generation: 1,
          csrfToken: "csrf-token",
          brokerOrigin: "http://localhost:8788",
          expiresAt: "2026-07-25T00:05:00.000Z",
        }), { status: 201 })
        : new Response(JSON.stringify(runtimeBody), { status: 200 })));

    const client = new HttpProductClient();
    await expect(client.conversationRuntime("conversation-one")).resolves.toMatchObject({
      schemaVersion: 1,
      activeTurn: { requestKey: "turn-one" },
      pendingInteractions: [{
        kind: "question",
        questions: [{ choices: [{ value: choiceId, label: "Same public label" }] }],
      }],
    });

    runtimeBody = {
      revision: "internal-shape",
      status: "waiting_for_user",
      activeRequestKey: "turn-one",
      assistant: { status: "streaming", text: "This must not be normalized." },
      tools: [],
      interactions: [],
      activity: { skillUses: [], actions: [] },
    };
    await expect(client.conversationRuntime("conversation-one"))
      .rejects.toMatchObject({ code: "invalid_response", status: 502 });
  });

  it("scopes Agent discovery to the exact Product owner query", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      if (String(input).endsWith("/bootstrap")) {
        return new Response(JSON.stringify({
          schemaVersion: 1,
          generation: 1,
          csrfToken: "csrf-token",
          brokerOrigin: "http://localhost:8788",
          expiresAt: "2026-07-25T00:05:00.000Z",
        }), { status: 201 });
      }
      return new Response(JSON.stringify({
        mode: "live",
        agents: [{ name: "build", description: null }],
      }), { status: 200 });
    }));

    await new HttpProductClient().agents("project", "project-one");
    expect(calls[1]).toBe("/api/agents?ownerKind=project&ownerId=project-one");
  });

  it("issues a visual frame through the current browser session without a JSON body", async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      if (String(input).endsWith("/bootstrap")) {
        return new Response(JSON.stringify({
          schemaVersion: 1,
          generation: 7,
          csrfToken: "csrf-token",
          platformOrigin: "http://localhost:8787",
          brokerOrigin: "http://localhost:8788",
          expiresAt: "2026-07-25T00:05:00.000Z",
        }), { status: 201 });
      }
      return new Response(JSON.stringify({
        schemaVersion: 1,
        frameUrl: `http://localhost:8788/frame/redeem/${"a".repeat(43)}`,
        expiresAt: "2026-07-25T00:01:00.000Z",
      }), { status: 201 });
    }));

    const frame = await new HttpProductClient().issueVisualFrame("project-one", "run-one");

    expect(frame.frameUrl).toContain("/frame/redeem/");
    expect(calls[1]?.init).toEqual({
      method: "POST",
      credentials: "same-origin",
      headers: { "x-riff-csrf": "csrf-token" },
      body: undefined,
    });
  });

  it("derives the exact visual host page from the bootstrapped platform origin", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      schemaVersion: 1,
      generation: 7,
      csrfToken: "csrf-token",
      platformOrigin: "http://localhost:8787",
      brokerOrigin: "http://localhost:8788",
      expiresAt: "2026-07-25T00:05:00.000Z",
    }), { status: 201 })));

    await expect(new HttpProductClient().visualHostUrl("project-one", "run-one"))
      .resolves.toBe(
        "http://localhost:8787/browser/projects/project-one/runs/run-one/visual",
      );
  });

  it("rejects a visual frame URL outside the bootstrapped broker origin", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith("/bootstrap")
        ? new Response(JSON.stringify({
          schemaVersion: 1,
          generation: 7,
          csrfToken: "csrf-token",
          brokerOrigin: "http://localhost:8788",
          expiresAt: "2026-07-25T00:05:00.000Z",
        }), { status: 201 })
        : new Response(JSON.stringify({
          schemaVersion: 1,
          frameUrl: `https://example.invalid/frame/redeem/${"a".repeat(43)}`,
          expiresAt: "2026-07-25T00:01:00.000Z",
        }), { status: 201 })));

    await expect(new HttpProductClient().issueVisualFrame("project-one", "run-one"))
      .rejects.toMatchObject({ code: "visual_frame_unavailable" });
  });
});
