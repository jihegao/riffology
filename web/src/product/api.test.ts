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
});
