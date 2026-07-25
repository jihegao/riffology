import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import test from "node:test";
import {
  VisualAgentInteractionError,
  VisualAgentInteractor,
} from "../src/visual-agent-interactor.ts";

const PROCESS_IDENTITY = Object.freeze({
  runId: "run_interactor",
  processAttemptId: "process_interactor",
  pid: process.pid,
  processStartToken: "interactor-test",
  processGroupId: process.pid,
  loopbackHost: "127.0.0.1" as const,
});

const interactor = new VisualAgentInteractor({
  inspection: {
    async inspectListener() {},
    async inspectConnectedPeer() {},
  },
});

const fixture = async (behavior: "local" | "popup" = "local"): Promise<{
  server: Server;
  port: number;
  requests: string[];
  close(): Promise<void>;
}> => {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    if (request.url === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><body>
        <button>Run</button>
        <label for="crew">Crew count</label><input id="crew" value="1">
        <label for="mode">Mode</label><select id="mode"><option value="safe">Safe</option><option value="fast">Fast</option></select>
        <p id="state">idle</p>
        <script src="/app.js"></script>
      </body></html>`);
      return;
    }
    if (request.url === "/app.js") {
      response.writeHead(200, { "content-type": "application/javascript" });
      response.end(behavior === "popup"
        ? `document.querySelector("button").addEventListener("click", () => window.open("/"));`
        : `document.querySelector("button").addEventListener("click", () => {
        document.querySelector("#state").textContent = "local-only";
        fetch("/forbidden-write", {method:"POST", body:"secret"}).catch(() => {});
      });`);
      return;
    }
    requests.push("UNEXPECTED");
    response.writeHead(500, { "content-type": "text/plain" });
    response.end("unexpected");
  });
  server.listen({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    server,
    port: address.port,
    requests,
    close: async () => await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())),
  };
};

const run = (
  port: number,
  operation: Parameters<VisualAgentInteractor["interact"]>[0]["operation"],
) => interactor.interact({
  target: { ...PROCESS_IDENTITY, loopbackPort: port },
  operation,
  assertLive() {},
  signal: new AbortController().signal,
});

test("fresh interactor dispatches one exact local UI primitive without child mutation authority", async (t) => {
  const child = await fixture();
  t.after(child.close);
  const receipt = await run(child.port, {
    kind: "click",
    locator: { kind: "role_name", role: "button", name: "Run" },
  });
  assert.deepEqual(receipt, {
    schemaVersion: 1,
    kind: "click",
    status: "dispatched",
    untrusted: true,
  });
  assert.ok(child.requests.includes("GET /"));
  assert.ok(child.requests.includes("GET /app.js"));
  assert.equal(child.requests.some((entry) => entry.includes("forbidden-write")), false);
  assert.equal(JSON.stringify(receipt).includes("local-only"), false);
});

test("interactor accepts exact label type/select and rejects caller-shaped locators or navigation roles", async (t) => {
  const child = await fixture();
  t.after(child.close);
  assert.equal((await run(child.port, {
    kind: "type",
    locator: { kind: "label", label: "Crew count" },
    value: "3",
  })).kind, "type");
  assert.equal((await run(child.port, {
    kind: "select",
    locator: { kind: "label", label: "Mode" },
    value: "fast",
  })).kind, "select");
  await assert.rejects(run(child.port, {
    kind: "click",
    locator: { kind: "role_name", role: "link", name: "Elsewhere" },
  } as never), VisualAgentInteractionError);
  await assert.rejects(run(child.port, {
    kind: "click",
    locator: { kind: "css", selector: "#run" },
  } as never), VisualAgentInteractionError);
});

test("popup or new-document side effects fail the interaction after the one primitive", async (t) => {
  const child = await fixture("popup");
  t.after(child.close);
  const error = await run(child.port, {
    kind: "click",
    locator: { kind: "role_name", role: "button", name: "Run" },
  }).catch((cause: unknown) => cause);
  assert.ok(error instanceof VisualAgentInteractionError);
  assert.equal(error.mayHaveDispatched, true);
  assert.equal(child.requests.some((entry) => entry !== "GET /" && entry !== "GET /app.js"), false);
});
