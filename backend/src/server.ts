import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { ApiError, asApiError } from "./errors.ts";
import { canonicalJsonV2, parseCanonicalJsonV2 } from "./canonical-json-v2.ts";
import { DurableProjectStore } from "./durable-project-store.ts";
import type { ProjectCommand } from "./durable-project-types.ts";
import { Gate2Runtime } from "./gate2-runtime.ts";
import { Gate3Runtime, type Gate3ActivationCheckpoint } from "./gate3-runtime.ts";
import type { MesaAdapter } from "./mesa-adapter.ts";

export type BackendOptions = {
  mesa: MesaAdapter;
  workspaceRoot: string;
  durableStore?: DurableProjectStore;
  gate3FaultInjector?: (checkpoint: Gate3ActivationCheckpoint) => void;
};

export class BackendApp {
  readonly gate2: Gate2Runtime;
  readonly gate3: Gate3Runtime;
  #server?: Server;

  constructor(options: BackendOptions) {
    this.gate2 = new Gate2Runtime(options.workspaceRoot, options.mesa, options.durableStore);
    this.gate3 = new Gate3Runtime(this.gate2, options.mesa, options.workspaceRoot, options.gate3FaultInjector);
  }

  async initialize(): Promise<void> {
    await this.gate3.recover();
    this.gate2.start();
  }

  async listen(port = 0, host = "127.0.0.1"): Promise<{ port: number; host: string }> {
    if (!this.#server) this.#server = createServer((request, response) => void this.#handle(request, response));
    await new Promise<void>((resolve, reject) => {
      this.#server!.once("error", reject);
      this.#server!.listen(port, host, () => {
        this.#server!.off("error", reject);
        resolve();
      });
    });
    const address = this.#server.address();
    if (!address || typeof address === "string") throw new Error("Backend did not expose a TCP address.");
    return { port: address.port, host };
  }

  async close(): Promise<void> {
    await this.gate2.close();
    if (!this.#server) return;
    this.#server.closeIdleConnections?.();
    this.#server.closeAllConnections?.();
    await new Promise<void>((resolve, reject) => this.#server!.close((error) => error ? reject(error) : resolve()));
    this.#server = undefined;
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    try {
      const url = requestUrl;
      const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      if (request.method === "GET" && url.pathname === "/health") return json(response, 200, { healthy: true, workspace_lifecycle: this.gate2.store.workspaceLifecycleProof() });
      if (parts[0] === "api" && parts[1] === "projects") return await this.#gate2(request, response, url, parts);
      throw new ApiError(404, "not_found", "No matching backend route exists.");
    } catch (error) {
      const apiError = asApiError(error);
      if (!response.headersSent) { const correlationId = randomUUID(); const error = { code: apiError.code, message: apiError.message, correlation_id: correlationId, ...(apiError.details ? { details: apiError.details } : {}) }; const gate3 = isGate3Route(request.method ?? "", requestUrl.pathname); (gate3 ? canonicalJson : json)(response, apiError.status, gate3 ? { schema_id: "riff://evidence-studio/error/v1", schema_version: 1, canonical_json_version: "riff-canonical-json-v2", accepted: false, error } : { accepted: false, error }); }
      else response.end();
    }
  }

  async #gate2(request: IncomingMessage, response: ServerResponse, url: URL, parts: string[]): Promise<void> {
    if (request.method === "GET" && parts.length === 3 && parts[2] === "default") return json(response, 200, this.gate3.defaultProject());
    if (request.method === "POST" && parts.length === 2) {
      const payload = await gate2JsonBody(request);
      const result = this.gate2.store.createProject(payload as any);
      return json(response, result.status, result.body);
    }
    const projectId = parts[2];
    if (!projectId) throw new ApiError(404, "resource_not_found", "The requested resource was not found.");
    if (request.method === "POST" && parts.length === 4 && parts[3] === "sessions") {
      const payload = await gate2JsonBody(request); exactObject(payload, ["actor_id"]);
      return json(response, 201, this.gate2.store.attachSession(projectId, String(payload.actor_id)));
    }
    if (request.method === "GET" && parts.length === 5 && parts[3] === "browser-projection" && parts[4] === "v1") return json(response, 200, this.gate3.browserProjection(projectId));
    if (request.method === "GET" && parts.length === 5 && parts[3] === "events" && parts[4] === "browser-v1") { exactQueryKeys(url, []); return this.#gate3BrowserEvents(projectId, request, response); }
    if (request.method === "GET" && parts.length === 5 && parts[3] === "wind" && parts[4] === "framed-candidate") return json(response, 200, await this.gate3.framedCandidate(projectId));
    if (request.method === "POST" && parts.length === 6 && parts[3] === "wind" && parts[4] === "framed-evidence" && parts[5] === "activate") { const result = await this.gate3.activate(await gate2Command(request, projectId)); return canonicalJson(response, result.status, result.body); }
    if (request.method === "GET" && parts.length === 6 && parts[3] === "brief" && parts[4] === "revisions") return json(response, 200, this.gate3.businessRevision(projectId, "decision_brief", parts[5]));
    if (request.method === "GET" && parts.length === 6 && parts[3] === "alignment" && parts[4] === "revisions") return json(response, 200, this.gate3.businessRevision(projectId, "alignment_map", parts[5]));
    if (request.method === "GET" && parts.length === 6 && parts[3] === "models" && parts[5] === "view-sources") return json(response, 200, this.gate3.modelViewSources(projectId, parts[4]));
    if (request.method === "GET" && parts.length === 7 && parts[3] === "models" && parts[5] === "view-sources") {
      const source = this.gate3.modelViewSource(projectId, parts[4], parts[6]); response.writeHead(200, { "content-type": "application/json", etag: `"sha256-${source.sha256}"`, "cache-control": "private, no-store" }); response.end(source.bytes); return;
    }
    if (request.method === "GET" && parts.length === 4 && parts[3] === "attestations") {
      exactQueryKeys(url, ["subject_revision_id", "after", "limit"]); const subject = url.searchParams.get("subject_revision_id"); if (!subject) throw new ApiError(422, "invalid_request", "subject_revision_id is required."); const limit = strictQueryInteger(url, "limit", 25, 1, 100); return json(response, 200, this.gate3.attestationPage(projectId, subject, url.searchParams.get("after"), limit));
    }
    if (request.method === "GET" && parts.length === 6 && parts[3] === "runs" && parts[5] === "evidence") { exactQueryKeys(url, []); return json(response, 200, await this.gate3.evidenceIndex(projectId, parts[4])); }
    if (request.method === "GET" && parts.length === 7 && parts[3] === "runs" && parts[5] === "event-projection" && parts[6] === "v1") {
      const allowed = ["after", "limit", "from_day", "to_day", "event_type", "turbine_id", "crew_id", "work_order_id"]; exactQueryKeys(url, allowed); const after = strictQueryInteger(url, "after", 0, 0, Number.MAX_SAFE_INTEGER); const limit = strictQueryInteger(url, "limit", 100, 1, 500); const fromDay = optionalFinite(url, "from_day"); const toDay = optionalFinite(url, "to_day"); if (fromDay !== null && fromDay < 0 || toDay !== null && (toDay < 0 || fromDay !== null && toDay < fromDay)) throw new ApiError(422, "invalid_request", "Event day filters are invalid."); const filters = { from_day: fromDay, to_day: toDay, event_type: url.searchParams.get("event_type"), turbine_id: url.searchParams.get("turbine_id"), crew_id: url.searchParams.get("crew_id"), work_order_id: url.searchParams.get("work_order_id") }; return json(response, 200, await this.gate3.filteredEvents(projectId, parts[4], after, limit, filters));
    }
    if (request.method === "GET" && parts.length === 6 && parts[3] === "runs" && parts[5] === "kpis") { exactQueryKeys(url, ["after_day", "limit"]); const afterDay = strictQueryInteger(url, "after_day", -1, -1, 3660); const limit = strictQueryInteger(url, "limit", 100, 1, 366); return json(response, 200, await this.gate3.kpis(projectId, parts[4], afterDay, limit)); }
    if (request.method === "GET" && parts.length === 6 && parts[3] === "runs" && parts[5] === "replay") { exactQueryKeys(url, ["after_frame", "limit"]); const afterFrame = strictQueryInteger(url, "after_frame", -1, -1, 119); const limit = strictQueryInteger(url, "limit", 14, 1, 31); return json(response, 200, await this.gate3.replay(projectId, parts[4], afterFrame, limit)); }
    if (request.method === "GET" && parts.length === 4 && parts[3] === "snapshot") return json(response, 200, this.gate2.store.publicProjection(projectId));
    if (request.method === "GET" && parts.length === 4 && parts[3] === "events") return this.#gate2ProjectEvents(projectId, request, response, url);
    if (request.method === "POST" && parts.length === 4 && parts[3] === "actors") return this.#gate2Mutation(response, await gate2Command(request, projectId), (command) => this.gate2.store.createActor(command as any));
    if (request.method === "POST" && parts.length === 5 && parts[3] === "wind" && parts[4] === "bootstrap") {
      const result = await this.gate2.bootstrap(await gate2Command(request, projectId)); return json(response, result.status, result.body);
    }
    if (request.method === "POST" && parts.length === 5 && parts[3] === "brief" && parts[4] === "revisions") return this.#gate2Mutation(response, await gate2Command(request, projectId), (command) => this.gate2.store.createBrief(command as any));
    if (request.method === "POST" && parts.length === 5 && parts[3] === "alignment" && parts[4] === "revisions") return this.#gate2Mutation(response, await gate2Command(request, projectId), (command) => this.gate2.store.createAlignment(command as any));
    if (request.method === "POST" && parts.length === 5 && parts[3] === "experiments" && parts[4] === "revisions") return this.#gate2Mutation(response, await gate2Command(request, projectId), (command) => this.gate2.store.createExperiment(command));
    if (request.method === "POST" && parts.length === 4 && parts[3] === "issues") return this.#gate2Mutation(response, await gate2Command(request, projectId), (command) => this.gate2.store.createIssue(command as any));
    if (request.method === "GET" && parts.length === 6 && parts[3] === "issues" && parts[5] === "history") return json(response, 200, this.gate2.store.issueHistory(projectId, parts[4]));
    if (request.method === "POST" && parts.length === 6 && parts[3] === "issues" && parts[5] === "comments") {
      const command = await gate2Command(request, projectId); if ((command.payload as any).issue_id !== parts[4] || (command.payload as any).event_type !== "commented") throw new ApiError(422, "validation_error", "Issue comment payload does not match its route.");
      return this.#gate2Mutation(response, command, (value) => this.gate2.store.appendIssueEvent(value as any));
    }
    if (request.method === "PATCH" && parts.length === 5 && parts[3] === "issues") {
      const command = await gate2Command(request, projectId); if ((command.payload as any).issue_id !== parts[4]) throw new ApiError(422, "validation_error", "Issue update payload does not match its route.");
      return this.#gate2Mutation(response, command, (value) => this.gate2.store.appendIssueEvent(value as any));
    }
    if (request.method === "POST" && parts.length === 4 && parts[3] === "attestations") return this.#gate2Mutation(response, await gate2Command(request, projectId), (command) => this.gate2.store.createAttestations(command as any));
    if (request.method === "POST" && parts.length === 4 && parts[3] === "runs") return this.#gate2Mutation(response, await gate2Command(request, projectId), (command) => this.gate2.startRun(command as any));
    if (request.method === "GET" && parts.length === 5 && parts[3] === "runs") return json(response, 200, { run: this.gate2.run(projectId, parts[4]) });
    if (request.method === "POST" && parts.length === 6 && parts[3] === "runs" && parts[5] === "cancel") {
      const command = await gate2Command(request, projectId); if ((command.payload as any).run_id !== parts[4]) throw new ApiError(422, "validation_error", "Run cancellation payload does not match its route.");
      return this.#gate2Mutation(response, command, (value) => this.gate2.cancelRun(value as any));
    }
    if (request.method === "GET" && parts.length === 6 && parts[3] === "runs" && parts[5] === "events") {
      const after = strictQueryInteger(url, "after", 0, 0, Number.MAX_SAFE_INTEGER); const limit = strictQueryInteger(url, "limit", 100, 1, 1000);
      return json(response, 200, await this.gate2.domainEvents(projectId, parts[4], after, limit));
    }
    if (request.method === "GET" && parts.length === 5 && parts[3] === "artifacts") {
      const artifact = await this.gate2.artifact(projectId, parts[4]);
      response.writeHead(200, { "content-type": artifact.media_type, "content-length": artifact.bytes.byteLength, "content-disposition": `attachment; filename="${artifact.filename}"`, "cache-control": "private, no-store" }); response.end(artifact.bytes); return;
    }
    throw new ApiError(404, "resource_not_found", "The requested resource was not found.");
  }

  #gate3BrowserEvents(projectId: string, request: IncomingMessage, response: ServerResponse): void {
    const initial = this.gate3.browserProjection(projectId); response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    response.write(`event: browser.project.snapshot.v1\ndata: ${JSON.stringify({ ...initial, event_type: "browser.project.snapshot.v1" })}\n\n`); let prior = initial; let closed = false;
    const timer = setInterval(() => { if (closed) return; try { const next = this.gate3.browserProjection(projectId); if (next.snapshot_revision === prior.snapshot_revision && next.projection_digest === prior.projection_digest) return; if (next.snapshot_revision === prior.snapshot_revision + 1) response.write(`event: browser.project.patch.v1\ndata: ${JSON.stringify({ schema_id: "riff://evidence-studio/browser-project-patch/v1", schema_version: 1, canonical_json_version: "riff-canonical-json-v2", event_type: "browser.project.patch.v1", project_id: projectId, base_snapshot_revision: prior.snapshot_revision, snapshot_revision: next.snapshot_revision, projection_digest: next.projection_digest, operations: [{ op: "replace", path: "", value: next.projection }] })}\n\n`); else response.write(`event: browser.project.reload-required.v1\ndata: ${JSON.stringify({ schema_id: "riff://evidence-studio/browser-project-reload-required/v1", schema_version: 1, canonical_json_version: "riff-canonical-json-v2", event_type: "browser.project.reload-required.v1", project_id: projectId, base_snapshot_revision: prior.snapshot_revision, snapshot_revision: next.snapshot_revision, projection_digest: next.projection_digest, reason: next.snapshot_revision > prior.snapshot_revision + 1 ? "revision_gap" : "projection_changed_while_disconnected" })}\n\n`); prior = next; } catch { response.end(); clearInterval(timer); } }, 250); timer.unref?.();
    const cleanup = (): void => { if (closed) return; closed = true; clearInterval(timer); }; request.on("close", cleanup); response.on("close", cleanup);
  }

  #gate2Mutation(response: ServerResponse, command: ProjectCommand<any>, action: (command: ProjectCommand<any>) => { status: number; body: Record<string, unknown> }): void {
    const result = action(command); json(response, result.status, result.body);
  }

  #gate2ProjectEvents(projectId: string, request: IncomingMessage, response: ServerResponse, url: URL): void {
    if (!String(request.headers.accept ?? "").includes("text/event-stream")) {
      const after = strictQueryInteger(url, "after", -1, -1, Number.MAX_SAFE_INTEGER); const limit = strictQueryInteger(url, "limit", 100, 1, 100);
      return json(response, 200, { snapshot: this.gate2.store.publicProjection(projectId), ...this.gate2.store.projectEventPage(projectId, after, limit) });
    }
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
    let projection = this.gate2.store.publicProjection(projectId) as any; let revision = projection.snapshot_revision as number;
    response.write(`id: ${revision}\nevent: project.snapshot\ndata: ${JSON.stringify(projection)}\n\n`);
    const poll = setInterval(() => {
      try {
        const next = this.gate2.store.publicProjection(projectId) as any; const nextRevision = next.snapshot_revision as number;
        if (nextRevision === revision) return;
        if (nextRevision !== revision + 1) response.write(`event: project.reload_required\ndata: ${JSON.stringify({ snapshot_revision: nextRevision })}\n\n`);
        else response.write(`id: ${nextRevision}\nevent: project.patch\ndata: ${JSON.stringify({ snapshot_revision: nextRevision, operations: [{ op: "replace", path: "", value: next }] })}\n\n`);
        projection = next; revision = nextRevision;
      } catch { response.end(); }
    }, 250);
    const keepAlive = setInterval(() => response.write(": keepalive\n\n"), 15_000);
    request.once("close", () => { clearInterval(poll); clearInterval(keepAlive); });
  }

}

const json = (response: ServerResponse, status: number, payload: unknown): void => {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(payload));
};

const canonicalJson = (response: ServerResponse, status: number, payload: unknown): void => {
  const bytes = canonicalJsonV2(payload);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": bytes.byteLength, "cache-control": "no-store" });
  response.end(bytes);
};

const exactObject = (value: unknown, keys: string[]): asserts value is Record<string, unknown> => {
  let plain = false; try { plain = value !== null && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)); } catch { plain = false; } if (!plain) throw new ApiError(422, "validation_error", "Request body must be a plain object.");
  let actual: string[]; try { actual = Object.keys(value as Record<string, unknown>).sort(); } catch { throw new ApiError(422, "validation_error", "Request body must be a plain object."); } const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new ApiError(422, "validation_error", "The request contains missing or unsupported fields.");
};

const gate2JsonBody = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
  const text = await bodyText(request, 256_000);
  let value: unknown; try { value = parseCanonicalJsonV2(text); } catch { throw new ApiError(422, "validation_error", "Request body must be strict JSON without duplicate or unsafe keys."); }
  const keys = value !== null && typeof value === "object" && !Array.isArray(value) ? Object.keys(value as Record<string, unknown>) : []; exactObject(value, keys);
  return value;
};

const gate2Command = async (request: IncomingMessage, projectId: string): Promise<ProjectCommand<any>> => {
  const value = await gate2JsonBody(request);
  exactObject(value, ["command_id", "project_id", "session_id", "base_snapshot_revision", "payload"]);
  const payload = value.payload;
  const payloadKeys = payload !== null && typeof payload === "object" && !Array.isArray(payload) ? Object.keys(payload as Record<string, unknown>) : [];
  exactObject(payload, payloadKeys);
  if (value.project_id !== projectId) throw new ApiError(404, "resource_not_found", "The requested resource was not found.");
  return value as ProjectCommand<any>;
};

const strictQueryInteger = (url: URL, name: string, fallback: number, minimum: number, maximum: number): number => {
  const raw = url.searchParams.get(name); if (raw === null) return fallback;
  if (!(minimum < 0 && raw === "-1") && !/^(?:0|[1-9]\d*)$/u.test(raw)) throw new ApiError(422, "invalid_request", `Query parameter ${name} must be an integer.`);
  const value = Number(raw); if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new ApiError(422, "invalid_request", `Query parameter ${name} is out of range.`);
  return value;
};

const exactQueryKeys = (url: URL, allowed: string[]): void => {
  const permitted = new Set(allowed); const seen = new Set<string>();
  for (const key of [...url.searchParams.keys()].sort()) { if (!permitted.has(key) || seen.has(key)) throw new ApiError(422, "invalid_request", "The request query is invalid."); seen.add(key); }
};

const isGate3Route = (method: string, pathname: string): boolean => {
  if (pathname === "/api/projects/default") return true;
  if (!pathname.startsWith("/api/projects/")) return false;
  return /\/(?:browser-projection\/v1|events\/browser-v1|wind\/framed-candidate|wind\/framed-evidence\/activate|attestations\/detail)$/u.test(pathname)
    || method === "GET" && /\/attestations$/u.test(pathname)
    || /\/models\/[^/]+\/view-sources(?:\/[^/]+)?$/u.test(pathname)
    || method === "GET" && /\/(?:brief|alignment)\/revisions\/[^/]+$/u.test(pathname)
    || /\/runs\/[^/]+\/(?:evidence|event-projection\/v1|kpis|replay)$/u.test(pathname);
};

const optionalFinite = (url: URL, name: string): number | null => { const raw = url.searchParams.get(name); if (raw === null) return null; if (raw.trim() === "" || !Number.isFinite(Number(raw))) throw new ApiError(422, "invalid_request", `Query parameter ${name} must be finite.`); return Number(raw); };

const bodyText = async (request: IncomingMessage, limit = 1_100_000): Promise<string> => {
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    received += buffer.length;
    if (received > limit) throw new ApiError(413, "request_too_large", "The request is too large.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
};
