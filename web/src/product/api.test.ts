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
      provider: { providerId: "provider", modelId: "language-model" },
      source: { kind: "blank" },
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

  it("uses dynamic generated-view, review, and Project file routes without fixed view names", async () => {
    const calls: Array<{ input: string; method?: string; body?: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        input: String(input),
        method: init?.method,
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      if (String(input).endsWith("/bootstrap")) {
        return new Response(JSON.stringify({
          schemaVersion: 1,
          generation: 1,
          csrfToken: "csrf-token",
          brokerOrigin: "http://localhost:8788",
          expiresAt: "2026-07-25T00:05:00.000Z",
        }), { status: 201 });
      }
      if (String(input).endsWith("/change-sets")) {
        return new Response(JSON.stringify({ changeSets: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({
        kind: "json",
        title: "fixture",
        value: {},
        schemaVersion: 1,
        operation: "apply",
        files: [],
      }), { status: 200 });
    }));
    const client = new HttpProductClient();

    await client.projectGeneratedViews("project / one");
    await client.projectGeneratedViewRenderable("project / one", "agent view");
    await client.projectChangeSets("project / one");
    await client.applyProjectChangeSet({
      projectId: "project / one",
      changeSetId: "change / one",
      commandId: "apply-command",
      expectedChangeSetDigest: "a".repeat(64),
      expectedWorkspaceDigest: "b".repeat(64),
    });
    await client.rejectProjectChangeSet({
      projectId: "project / one",
      changeSetId: "change / one",
      commandId: "reject-command",
      expectedChangeSetDigest: "a".repeat(64),
    });
    await client.projectFileRenderable("project / one", "file / ref");
    await client.projectFileWorkbenchRenderable("project / one", "file / ref");

    expect(calls.map((call) => call.input)).toEqual([
      "/api/browser-session/bootstrap",
      "/api/projects/project%20%2F%20one/generated-views",
      "/api/projects/project%20%2F%20one/generated-views/agent%20view/renderable",
      "/api/projects/project%20%2F%20one/change-sets",
      "/api/projects/project%20%2F%20one/change-sets/change%20%2F%20one/apply",
      "/api/projects/project%20%2F%20one/change-sets/change%20%2F%20one/reject",
      "/api/projects/project%20%2F%20one/files/file%20%2F%20ref/renderable",
      "/api/projects/project%20%2F%20one/files/file%20%2F%20ref/workbench-renderable",
    ]);
    expect(JSON.parse(calls[4]?.body ?? "{}")).toEqual({
      commandId: "apply-command",
      expectedChangeSetDigest: "a".repeat(64),
      expectedWorkspaceDigest: "b".repeat(64),
    });
    expect(JSON.parse(calls[5]?.body ?? "{}")).toEqual({
      commandId: "reject-command",
      expectedChangeSetDigest: "a".repeat(64),
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
        summary: "Choose one.\nThen explain the choice.",
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
      goalVerification: null,
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
      parts: [{
        summary: "Choose one.\nThen explain the choice.",
      }],
      pendingInteractions: [{
        kind: "question",
        questions: [{ choices: [{ value: choiceId, label: "Same public label" }] }],
      }],
    });

    runtimeBody = {
      ...(runtimeBody as Record<string, unknown>),
      parts: [{
        id: "assistant-one",
        kind: "text",
        state: "streaming",
        title: "Assistant",
        summary: "Reject embedded\u0000controls.",
      }],
    };
    await expect(client.conversationRuntime("conversation-one"))
      .rejects.toMatchObject({ code: "invalid_response", status: 502 });

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

  it("normalizes only the bounded durable goal-verification projection", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith("/bootstrap")
        ? new Response(JSON.stringify({
          schemaVersion: 1,
          generation: 1,
          csrfToken: "csrf-token",
          platformOrigin: "http://localhost:8787",
          brokerOrigin: "http://localhost:8788",
          expiresAt: "2026-07-25T00:05:00.000Z",
        }), { status: 201 })
        : new Response(JSON.stringify({
          schemaVersion: 1,
          revision: "runtime-goal-receipt",
          status: "idle",
          activeTurn: null,
          parts: [{
            id: "part-model-change",
            kind: "tool_result",
            state: "complete",
            title: "Riff apply model changes",
            summary: "Tool completed.",
          }],
          pendingInteractions: [],
          goalVerification: {
            disposition: "completed",
            reasonCode: "visual_model_state_verified",
            receiptDigest: "a".repeat(64),
            evidence: {
              openCodeTerminal: "idle",
              intentKind: "model_visual",
              actionCount: 2,
              terminalActionCount: 2,
              committedActionCount: 2,
              affectedResourceCount: 3,
              ownerStateDigest: "b".repeat(64),
              ownerStateVerified: true,
              partialEffect: false,
              rawWorkspacePath: "/private/owner/path",
            },
            goalText: "secret prompt",
          },
          mcp: {
            state: "disconnected",
            label: "Riff tools",
          },
          agent: { selectedName: null, locked: false },
        }), { status: 200 })));

    const runtime = await new HttpProductClient()
      .conversationRuntime("conversation-one");

    expect(runtime.goalVerification).toEqual({
      disposition: "completed",
      reasonCode: "visual_model_state_verified",
      receiptDigest: "a".repeat(64),
      evidence: {
        openCodeTerminal: "idle",
        intentKind: "model_visual",
        actionCount: 2,
        terminalActionCount: 2,
        committedActionCount: 2,
        affectedResourceCount: 3,
        ownerStateVerified: true,
        partialEffect: false,
      },
    });
    expect(JSON.stringify(runtime)).not.toContain("secret prompt");
    expect(JSON.stringify(runtime)).not.toContain("/private/owner/path");
    expect(JSON.stringify(runtime)).not.toContain("ownerStateDigest");
    expect(runtime.activeTurn).toBeNull();
    expect(runtime.parts).toEqual([{
      id: "part-model-change",
      kind: "tool_result",
      state: "complete",
      title: "Riff apply model changes",
      summary: "Tool completed.",
    }]);
    expect(runtime.pendingInteractions).toEqual([]);
    expect(runtime.agent).toEqual({ selectedName: null, locked: false });
    expect(runtime.mcp).toEqual({ state: "disconnected", label: "Riff tools" });
  });

  it("normalizes the actual public permission projection for exact-turn Resume", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith("/bootstrap")
        ? new Response(JSON.stringify({
          schemaVersion: 1,
          generation: 1,
          csrfToken: "csrf-token",
          platformOrigin: "http://localhost:8787",
          brokerOrigin: "http://localhost:8788",
          expiresAt: "2026-07-25T00:05:00.000Z",
        }), { status: 201 })
        : new Response(JSON.stringify({
          schemaVersion: 1,
          revision: "runtime-permission",
          status: "waiting_for_user",
          activeTurn: {
            requestKey: "request-goal",
            canStop: true,
            canRetry: false,
          },
          goalVerification: null,
          parts: [{
            id: "part-model-change",
            kind: "tool_call",
            state: "pending",
            title: "Riff apply model changes",
            summary: "Waiting for permission.",
          }],
          pendingInteractions: [{
            id: "permission-goal",
            kind: "permission",
            title: "Permission required",
            prompt: "Allow this scoped Agent tool for the current turn?",
            decisions: ["allow_once", "reject"],
          }],
          agent: { selectedName: "build", locked: true },
          mcp: { state: "connected", label: "Riff tools" },
        }), { status: 200 })));

    const runtime = await new HttpProductClient()
      .conversationRuntime("conversation-one");

    expect(runtime.activeTurn).toEqual({
      requestKey: "request-goal",
      canStop: true,
      canRetry: false,
    });
    expect(runtime.pendingInteractions).toEqual([{
      id: "permission-goal",
      kind: "permission",
      title: "Permission required",
      prompt: "Allow this scoped Agent tool for the current turn?",
      decisions: ["allow_once", "reject"],
    }]);
    expect(runtime.parts[0]).toMatchObject({
      id: "part-model-change",
      kind: "tool_call",
      state: "pending",
    });
    expect(runtime.agent).toEqual({ selectedName: "build", locked: true });
    expect(runtime.mcp).toEqual({ state: "connected", label: "Riff tools" });
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

  it("uses only projected aliases and generations for workbench Browser observation", async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    const state = {
      schemaVersion: 1 as const,
      conversationGeneration: 3,
      pageGeneration: 5,
      projectedUrl: "riff-app://project",
      trustState: "trusted_riff" as const,
      controlMode: "observer" as const,
      remainingBudget: null,
      recoveryState: "ready" as const,
      canGoBack: false,
      canReload: true,
      expiresAt: "2026-08-02T00:15:00.000Z",
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input: String(input), init });
      if (String(input).endsWith("/bootstrap")) {
        return new Response(JSON.stringify({
          schemaVersion: 1,
          generation: 1,
          csrfToken: "csrf-token",
          brokerOrigin: "http://localhost:8788",
          expiresAt: "2026-08-02T00:15:00.000Z",
        }), { status: 201 });
      }
      if (String(input).includes("/screenshot?")) {
        return new Response(JSON.stringify({
          schemaVersion: 1,
          pageGeneration: 5,
          contentType: "image/png",
          pngBase64: "iVBORw0KGgo=",
        }), { status: 200 });
      }
      return new Response(JSON.stringify(state), { status: 200 });
    }));
    const client = new HttpProductClient();

    const opened = await client.browserOpen("conversation / one", "riff-app");
    await client.browserReload("conversation / one", opened);
    await client.browserTakeover("conversation / one", opened);
    await client.browserReturn("conversation / one", opened);
    await client.browserScreenshot("conversation / one", opened);

    expect(calls[1]?.input).toBe(
      "/api/conversations/conversation%20%2F%20one/browser/open",
    );
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ alias: "riff-app" });
    expect(String(calls[1]?.init?.body)).not.toMatch(/url|host|port|token/iu);
    expect(JSON.parse(String(calls[2]?.init?.body))).toEqual({
      conversationGeneration: 3,
      pageGeneration: 5,
    });
    expect(calls[3]?.input).toContain("/browser/takeover");
    expect(JSON.parse(String(calls[3]?.init?.body))).toEqual({
      conversationGeneration: 3,
      pageGeneration: 5,
    });
    expect(calls[4]?.input).toContain("/browser/return");
    expect(calls[5]?.input).toContain(
      "conversationGeneration=3&pageGeneration=5",
    );
  });

  it("rejects Browser control projections with undeclared modes or fields", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls += 1;
      if (calls === 1) return new Response(JSON.stringify({
        schemaVersion: 1,
        generation: 1,
        csrfToken: "csrf-token",
        brokerOrigin: "http://localhost:8788",
        expiresAt: "2026-08-02T00:15:00.000Z",
      }), { status: 201 });
      return new Response(JSON.stringify({
        schemaVersion: 1,
        conversationGeneration: 3,
        pageGeneration: 5,
        projectedUrl: "riff-app://project",
        trustState: "trusted_riff",
        controlMode: "root",
        remainingBudget: 3,
        recoveryState: "ready",
        canGoBack: false,
        canReload: true,
        expiresAt: "2026-08-02T00:15:00.000Z",
        capability: "must-not-pass",
      }), { status: 200 });
    }));
    await expect(new HttpProductClient().browserState("conversation-one"))
      .rejects.toMatchObject({ code: "invalid_response" });
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
