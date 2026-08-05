import { createServer, type Server } from "node:http";
import type {
  BrowserFrameConnectedPeer,
  BrowserFrameTarget,
  BrowserFrameTargetResolver,
} from "./browser-frame-capability.ts";
import { ProjectOnlyStore } from "./project-only-store.ts";

const LOOPBACK_HOST = "127.0.0.1" as const;
const MAX_VISUAL_HTML_BYTES = 2 * 1024 * 1024;
const ATTEMPT_TTL_MS = 24 * 60 * 60_000;

type ActiveVisual = Readonly<{
  projectId: string;
  runId: string;
  attemptGeneration: number;
  port: number;
  expiresAtMs: number;
  server: Server;
}>;

/**
 * Project-only visual service lifecycle used by the cutover vertical slice.
 *
 * The Store remains authoritative for Run admission/state. This process-local
 * registry owns only the live HTTP projection and the frame target needed by
 * BrowserFrameCapability. No child port is serialized to Product clients.
 */
export class ProjectOnlyVisualRuntime {
  readonly store: ProjectOnlyStore;
  readonly #active = new Map<string, ActiveVisual>();
  #generation = 0;

  constructor(store: ProjectOnlyStore) {
    this.store = store;
  }

  readonly targetResolver: BrowserFrameTargetResolver = Object.freeze({
    resolve: async (projectId: string, runId: string): Promise<BrowserFrameTarget | null> => {
      const active = this.#active.get(runId);
      if (!active || active.projectId !== projectId || !active.server.listening
        || active.expiresAtMs <= Date.now()) return null;
      return publicTarget(active);
    },
    inspect: async (target: BrowserFrameTarget): Promise<boolean> =>
      this.#matches(target),
    inspectConnectedPeer: async (
      target: BrowserFrameTarget,
      peer: BrowserFrameConnectedPeer,
    ): Promise<boolean> => this.#matches(target)
      && peer.localHost === LOOPBACK_HOST
      && peer.localPort === target.port
      && peer.remoteHost === LOOPBACK_HOST,
  });

  async start(input: Readonly<{
    projectId: string;
    runId: string;
    html: string;
    at?: string;
  }>): Promise<Readonly<{ runId: string; status: "running" }>> {
    const run = this.store.run(input.runId);
    if (run.projectId !== input.projectId || run.runKind !== "visual") {
      throw new Error("visual_run_scope_mismatch");
    }
    const existing = this.#active.get(input.runId);
    if (existing?.server.listening) return Object.freeze({ runId: input.runId, status: "running" });
    const bytes = Buffer.from(input.html, "utf8");
    if (bytes.byteLength < 1 || bytes.byteLength > MAX_VISUAL_HTML_BYTES) {
      throw new Error("visual_document_invalid");
    }
    const server = createServer((request, response) => {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, { "content-length": "0" });
        response.end();
        return;
      }
      if (path === "/health") {
        const health = Buffer.from('{"status":"ok"}\n');
        response.writeHead(200, {
          "cache-control": "no-store",
          "content-length": health.byteLength,
          "content-type": "application/json; charset=utf-8",
          "x-content-type-options": "nosniff",
        });
        response.end(request.method === "HEAD" ? undefined : health);
        return;
      }
      if (path !== "/" && path !== "/index.html") {
        response.writeHead(404, { "content-length": "0" });
        response.end();
        return;
      }
      response.writeHead(200, {
        "cache-control": "private, no-store",
        "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; font-src 'none'; media-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors *",
        "content-length": bytes.byteLength,
        "content-type": "text/html; charset=utf-8",
        "cross-origin-resource-policy": "same-origin",
        "permissions-policy": "camera=(), microphone=(), geolocation=()",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      });
      response.end(request.method === "HEAD" ? undefined : bytes);
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(0, LOOPBACK_HOST);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      await closeServer(server);
      throw new Error("visual_listener_unavailable");
    }
    const active: ActiveVisual = Object.freeze({
      projectId: input.projectId,
      runId: input.runId,
      attemptGeneration: ++this.#generation,
      port: address.port,
      expiresAtMs: Date.now() + ATTEMPT_TTL_MS,
      server,
    });
    this.#active.set(input.runId, active);
    server.once("close", () => {
      if (this.#active.get(input.runId) === active) this.#active.delete(input.runId);
    });
    try {
      if (run.status === "queued") {
        this.store.transitionRun({ id: input.runId, status: "running", at: input.at ?? new Date().toISOString() });
      }
    } catch (error) {
      this.#active.delete(input.runId);
      await closeServer(server);
      throw error;
    }
    return Object.freeze({ runId: input.runId, status: "running" });
  }

  /**
   * Stops one visual projection and terminalizes its authoritative Run.
   * Repeating the same command after terminalization is intentionally
   * idempotent: the terminal Store record, not the process-local map, wins.
   */
  async stop(input: Readonly<{
    projectId: string;
    runId: string;
    at?: string;
  }>): Promise<Readonly<{
    runId: string;
    status: "cancelled" | "already_terminal";
    terminalStatus: string;
  }>> {
    const run = this.store.run(input.runId);
    if (run.projectId !== input.projectId || run.runKind !== "visual") {
      throw new Error("visual_run_scope_mismatch");
    }
    if (!["queued", "running", "cancelling"].includes(run.status)) {
      return Object.freeze({
        runId: run.id,
        status: "already_terminal",
        terminalStatus: run.status,
      });
    }

    const active = this.#active.get(run.id);
    if (active) {
      this.#active.delete(run.id);
      await closeServer(active.server);
    }

    const at = input.at ?? new Date().toISOString();
    const current = this.store.run(run.id);
    if (current.status === "running") {
      this.store.transitionRun({ id: run.id, status: "cancelling", at });
    }
    const cancelling = this.store.run(run.id);
    if (["queued", "cancelling"].includes(cancelling.status)) {
      this.store.transitionRun({
        id: run.id,
        status: "cancelled",
        at,
        terminalCode: "user_cancelled",
      });
    }
    return Object.freeze({ runId: run.id, status: "cancelled", terminalStatus: "cancelled" });
  }

  async close(): Promise<void> {
    const at = new Date().toISOString();
    const active = [...this.#active.values()];
    this.#active.clear();
    for (const item of active) {
      await closeServer(item.server);
      try {
        const run = this.store.run(item.runId);
        if (["queued", "running", "cancelling"].includes(run.status)) {
          this.store.transitionRun({ id: item.runId, status: "interrupted", at, terminalCode: "backend_shutdown" });
        }
      } catch { /* Store close/recovery remains authoritative. */ }
    }
  }

  #matches(target: BrowserFrameTarget): boolean {
    const active = this.#active.get(target.runId);
    return Boolean(active
      && active.projectId === target.projectId
      && active.attemptGeneration === target.attemptGeneration
      && active.port === target.port
      && active.expiresAtMs === target.expiresAtMs
      && active.server.listening
      && active.expiresAtMs > Date.now());
  }
}

const publicTarget = (active: ActiveVisual): BrowserFrameTarget => Object.freeze({
  projectId: active.projectId,
  runId: active.runId,
  attemptGeneration: active.attemptGeneration,
  port: active.port,
  expiresAtMs: active.expiresAtMs,
});

const closeServer = (server: Server): Promise<void> => new Promise((resolve, reject) => {
  if (!server.listening) {
    resolve();
    return;
  }
  server.close((error) => error ? reject(error) : resolve());
  server.closeAllConnections?.();
});
