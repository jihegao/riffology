import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { ApiError, asApiError } from "./errors.ts";
import { parseCanonicalJsonV2 } from "./canonical-json-v2.ts";
import { DurableProjectStore } from "./durable-project-store.ts";
import type { ProjectCommand } from "./durable-project-types.ts";
import { Gate2Runtime } from "./gate2-runtime.ts";
import { McpToolServer } from "./mcp.ts";
import type { MesaAdapter } from "./mesa-adapter.ts";
import type { OpenCodeAdapter, OpenCodeReadiness } from "./opencode-adapter.ts";
import { OpenCodeEventBridge } from "./opencode-events.ts";
import type { WorkbenchProjector } from "./playwright-projection.ts";
import { ProjectStore, type StoredAttachment } from "./project-store.ts";
import { SimulationActions } from "./simulation-actions.ts";
import type { BrowserEvent, ProjectState, Scalar, UiCommand } from "./types.ts";

export type BackendOptions = {
  mesa: MesaAdapter;
  openCode: OpenCodeAdapter;
  workspaceRoot: string;
  defaultSessionId?: string;
  projector?: WorkbenchProjector;
  promptTimeoutMs?: number;
  mcpUrl?: string;
  store?: ProjectStore;
  durableStore?: DurableProjectStore;
};

export class BackendApp {
  readonly store: ProjectStore;
  readonly actions: SimulationActions;
  readonly mcp: McpToolServer;
  readonly gate2: Gate2Runtime;
  private readonly options: BackendOptions;
  readonly #openCodeEvents: OpenCodeEventBridge;
  readonly #mcpCapabilities = new Map<string, string>();
  #unsubscribeOpenCode?: () => void;
  #readiness: OpenCodeReadiness = { status: "unconfigured", modelId: null };
  #server?: Server;

  constructor(options: BackendOptions) {
    this.options = options;
    this.store = options.store ?? new ProjectStore();
    this.gate2 = new Gate2Runtime(options.workspaceRoot, options.mesa, options.durableStore);
    this.actions = new SimulationActions(this.store, options.mesa, options.projector);
    this.mcp = new McpToolServer(this.actions);
    this.#openCodeEvents = new OpenCodeEventBridge(this.store);
  }

  async initialize(): Promise<ProjectState> {
    this.gate2.start();
    this.#readiness = await this.options.openCode.initialize();
    if (this.#readiness.status === "ready" && this.options.openCode.subscribeEvents) {
      try {
        this.#unsubscribeOpenCode = await this.options.openCode.subscribeEvents((event) => this.#openCodeEvents.handle(event));
      } catch {
        this.#readiness = { status: "error", modelId: null, lastError: { code: "opencode_event_unavailable", message: "OpenCode event streaming is unavailable." } };
      }
    }
    return this.createSession(this.options.defaultSessionId ?? "local-demo");
  }

  createSession(sessionId = randomUUID()): ProjectState {
    const snapshot = this.store.create(sessionId, publicAgent(this.#readiness));
    if (!this.#mcpCapabilities.has(sessionId)) this.#mcpCapabilities.set(sessionId, this.mcp.grant(sessionId));
    return snapshot;
  }

  /** Ends a browser session's local control authority without exposing its capability. */
  closeSession(sessionId: string): void {
    const capability = this.#mcpCapabilities.get(sessionId);
    if (capability) this.mcp.revoke(capability);
    this.mcp.revokeSession(sessionId);
    this.#mcpCapabilities.delete(sessionId);
    this.#openCodeEvents.unbindBrowserSession(sessionId);
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
    this.#unsubscribeOpenCode?.();
    this.#unsubscribeOpenCode = undefined;
    for (const sessionId of this.#mcpCapabilities.keys()) this.closeSession(sessionId);
    this.mcp.revokeAll();
    await this.gate2.close();
    if (!this.#server) return;
    this.#server.closeIdleConnections?.();
    this.#server.closeAllConnections?.();
    await new Promise<void>((resolve, reject) => this.#server!.close((error) => error ? reject(error) : resolve()));
    this.#server = undefined;
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      if (request.method === "GET" && url.pathname === "/health") return json(response, 200, { healthy: true, agent: publicAgent(this.#readiness) });
      if (request.method === "POST" && url.pathname === "/mcp") return await this.#mcp(request, response, url);
      if (parts[0] === "api" && parts[1] === "projects") return await this.#gate2(request, response, url, parts);
      if (request.method === "POST" && parts[0] === "api" && parts[1] === "sessions" && parts.length === 2) return this.#createBrowserSession(request, response);
      if (parts[0] !== "api" || parts[1] !== "sessions" || !parts[2]) throw new ApiError(404, "not_found", "No matching local demo route exists.");
      const sessionId = parts[2];
      if (request.method === "GET" && parts.length === 4 && parts[3] === "snapshot") return json(response, 200, this.store.snapshot(sessionId));
      if (request.method === "GET" && parts.length === 4 && parts[3] === "events") return this.#events(sessionId, request, response);
      if (request.method === "POST" && parts.length === 4 && parts[3] === "uploads") return await this.#upload(sessionId, request, response);
      if (request.method === "DELETE" && parts.length === 5 && parts[3] === "attachments") return await this.#removeAttachment(sessionId, parts[4], request, response);
      if (request.method === "POST" && parts.length === 4 && parts[3] === "chat") return await this.#chat(sessionId, request, response);
      if (request.method === "PUT" && parts.length === 4 && parts[3] === "parameters") return await this.#parameters(sessionId, request, response);
      if (request.method === "POST" && parts.length === 4 && parts[3] === "runs") return await this.#startRun(sessionId, request, response);
      if (request.method === "POST" && parts.length === 6 && parts[3] === "runs" && parts[5] === "cancel") return await this.#cancelRun(sessionId, parts[4], request, response);
      throw new ApiError(404, "not_found", "No matching local demo route exists.");
    } catch (error) {
      const apiError = asApiError(error);
      if (!response.headersSent) json(response, apiError.status, { accepted: false, error: { code: apiError.code, message: apiError.message, correlation_id: randomUUID(), ...(apiError.details ? { details: apiError.details } : {}) } });
      else response.end();
    }
  }

  async #gate2(request: IncomingMessage, response: ServerResponse, url: URL, parts: string[]): Promise<void> {
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

  #events(sessionId: string, request: IncomingMessage, response: ServerResponse): void {
    const snapshot = this.store.snapshot(sessionId);
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    sendEvent(response, { type: "project.snapshot", data: snapshot });
    sendEvent(response, { type: "connection.status", data: { status: "connected" } });
    const unsubscribe = this.store.subscribe(sessionId, (event) => sendEvent(response, event));
    const keepAlive = setInterval(() => response.write(": keepalive\n\n"), 15_000);
    request.once("close", () => {
      clearInterval(keepAlive);
      unsubscribe();
    });
  }

  async #mcp(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    let payload: unknown;
    try { payload = JSON.parse(await bodyText(request, 256_000)); }
    catch { throw new ApiError(422, "invalid_mcp_request", "MCP requests must contain valid JSON."); }
    const result = await this.mcp.handle(url.searchParams.get("cap") ?? undefined, payload as any);
    if (!result) {
      response.writeHead(202, { "cache-control": "no-store" });
      response.end();
      return;
    }
    json(response, 200, result);
  }

  #createBrowserSession(request: IncomingMessage, response: ServerResponse): void {
    // The route intentionally has no client-controlled creation payload.
    request.resume();
    const sessionId = `session_${randomUUID()}`;
    const state = this.createSession(sessionId);
    json(response, 201, { sessionId, state });
  }

  async #upload(sessionId: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const { envelope, file } = await multipart(request, 1_200_000);
    const command = parseCommand<{ clientFileName?: string }>(envelope, sessionId);
    const duplicate = this.store.beginCommand(command);
    if (duplicate) return json(response, 202, duplicate);
    if (!file) throw new ApiError(422, "missing_file", "Attach one CSV, JSON, or TXT input file.");
    const declaredName = typeof command.payload.clientFileName === "string" ? command.payload.clientFileName : file.filename;
    const allowed = attachmentType(declaredName, file.contentType);
    if (!allowed) throw new ApiError(422, "unsupported_attachment", "Only CSV, JSON, and TXT files up to 1 MiB are supported.");
    if (file.data.byteLength > 1024 * 1024) throw new ApiError(413, "attachment_too_large", "Attachments are limited to 1 MiB.");
    const id = `upl_${randomUUID()}`;
    const projectId = this.store.projectId(sessionId);
    const displayName = safeFilename(declaredName);
    const workspacePath = join(this.options.workspaceRoot, "projects", projectId, "inputs", `${id}-${displayName}`);
    await mkdir(join(this.options.workspaceRoot, "projects", projectId, "inputs"), { recursive: true });
    await writeFile(workspacePath, file.data, { flag: "wx" });
    const attachment: StoredAttachment = {
      id,
      displayName,
      originalName: displayName,
      mediaType: allowed,
      sizeBytes: file.data.byteLength,
      status: "ready",
      workspacePath,
      sha256: createHash("sha256").update(file.data).digest("hex"),
    };
    this.store.addAttachment(sessionId, attachment);
    json(response, 202, this.store.acceptCommand(sessionId, command.commandId));
  }

  async #removeAttachment(sessionId: string, attachmentId: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const command = parseCommand<{ attachmentId: string }>(await bodyText(request), sessionId);
    if (command.payload.attachmentId !== attachmentId) throw new ApiError(422, "attachment_mismatch", "Attachment payload does not match the route.");
    const duplicate = this.store.beginCommand(command);
    if (duplicate) return json(response, 202, duplicate);
    const attachment = this.store.attachment(sessionId, attachmentId);
    const state = this.store.snapshot(sessionId);
    if (state.conversation.some((message) => message.attachmentIds?.includes(attachmentId))) {
      throw new ApiError(409, "attachment_in_use", "This attachment is retained because the conversation already references it.");
    }
    await rm(attachment.workspacePath, { force: false });
    this.store.removeAttachment(sessionId, attachmentId);
    json(response, 202, this.store.acceptCommand(sessionId, command.commandId));
  }

  async #chat(sessionId: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const command = parseCommand<{ text: string; attachmentIds: string[] }>(await bodyText(request), sessionId);
    const duplicate = this.store.beginCommand(command);
    if (duplicate) return json(response, 202, duplicate);
    if (!command.payload.text?.trim()) throw new ApiError(422, "empty_message", "Enter a message for the modelling assistant.");
    const attachments = command.payload.attachmentIds ?? [];
    const stored = attachments.map((id) => this.store.attachment(sessionId, id));
    if (stored.some((attachment) => attachment.status !== "ready")) throw new ApiError(409, "attachment_not_ready", "Wait for all selected attachments before sending a message.");
    if (this.#readiness.status !== "ready" || !this.#readiness.modelId) throw new ApiError(503, "agent_not_ready", this.#readiness.lastError?.message ?? "The modelling assistant is not ready.");
    const messageId = `msg_${randomUUID()}`;
    this.store.mutate(sessionId, (draft) => {
      draft.conversation.push({ id: messageId, role: "user", text: command.payload.text.trim(), attachmentIds: attachments, status: "complete", createdAt: new Date().toISOString() });
      draft.agent = { modelId: this.#readiness.modelId, status: "thinking" };
    });
    this.store.publish(sessionId, { type: "agent.status", data: { modelId: this.#readiness.modelId, status: "thinking" } });
    const projectId = this.store.projectId(sessionId);
    if (this.#readiness.modelId !== "dev/deterministic" && this.options.openCode.bindProject) {
      if (!this.options.mcpUrl) throw new ApiError(503, "mcp_unconfigured", "Set RIFF_MCP_URL before using live OpenCode tools.");
      const capability = this.#mcpCapabilities.get(sessionId);
      if (!capability) throw new ApiError(500, "mcp_capability_missing", "The local MCP capability is unavailable.");
      await this.options.openCode.bindProject(projectId, withCapability(this.options.mcpUrl, capability));
    }
    const openCodeSession = await this.options.openCode.createSession(projectId);
    this.#openCodeEvents.bind(openCodeSession, sessionId);
    try {
      const promptAbort = new AbortController();
      await withTimeout(
        this.options.openCode.prompt(openCodeSession, {
          text: command.payload.text.trim(),
          attachments: stored.map((attachment) => ({ id: attachment.id, mediaType: attachment.mediaType, workspaceRelativePath: `inputs/${attachment.id}-${attachment.displayName}` })),
          system: restrictedSystemPrompt(),
        }, promptAbort.signal),
        this.options.promptTimeoutMs ?? 30_000,
        () => {
          promptAbort.abort();
          return this.options.openCode.abort(openCodeSession);
        },
      );
      if (this.#readiness.modelId === "dev/deterministic") {
        await this.#runDeterministicDevAction(sessionId, command.payload.text);
        this.store.setAgent(sessionId, { modelId: this.#readiness.modelId, status: "ready" });
      }
      json(response, 202, this.store.acceptCommand(sessionId, command.commandId));
    } catch (error) {
      const apiError = asApiError(error);
      this.store.mutate(sessionId, (draft) => {
        draft.agent = { modelId: this.#readiness.modelId, status: "error", lastError: { code: apiError.code, message: apiError.message } };
      });
      this.store.publish(sessionId, { type: "agent.status", data: { modelId: this.#readiness.modelId, status: "error", lastError: { code: apiError.code, message: apiError.message } } });
      throw apiError;
    }
  }

  async #runDeterministicDevAction(sessionId: string, text: string): Promise<void> {
    const normalized = text.toLowerCase();
    const requestsModel = /\b(load|prepare|build)\b/.test(normalized) && /\b(queue|model|simulation)\b/.test(normalized);
    if (!requestsModel) {
      this.store.mutate(sessionId, (draft) => {
        draft.conversation.push({
          id: `msg_${randomUUID()}`,
          role: "assistant",
          text: "Development demo mode can load the approved queue simulation. Ask me to load the queue model.",
          status: "complete",
          createdAt: new Date().toISOString(),
        });
      });
      return;
    }
    await this.actions.loadModel(sessionId, "queue-network-v1");
    this.store.mutate(sessionId, (draft) => {
      draft.conversation.push({
        id: `msg_${randomUUID()}`,
        role: "assistant",
        text: "Development demo mode loaded the approved queue-network-v1 model. Configure its parameters in the workbench.",
        status: "complete",
        createdAt: new Date().toISOString(),
      });
    });
  }

  async #parameters(sessionId: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const command = parseCommand<{ modelId: string; values: Record<string, Scalar> }>(await bodyText(request), sessionId);
    const duplicate = this.store.beginCommand(command);
    if (duplicate) return json(response, 202, duplicate);
    const state = this.store.snapshot(sessionId);
    if (state.model?.id !== command.payload.modelId) throw new ApiError(409, "model_not_active", "The selected model is no longer active.");
    this.actions.saveParameters(sessionId, command.payload.values);
    json(response, 202, this.store.acceptCommand(sessionId, command.commandId));
  }

  async #startRun(sessionId: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const command = parseCommand<{ modelId: string; parameters?: Record<string, Scalar>; steps?: number; seeds?: number[] }>(await bodyText(request), sessionId);
    const duplicate = this.store.beginCommand(command);
    if (duplicate) return json(response, 202, duplicate);
    const state = this.store.snapshot(sessionId);
    if (!state.model || command.payload.modelId !== state.model.id) throw new ApiError(409, "model_not_active", "The selected model is no longer active.");
    if (command.payload.parameters && !sameValues(command.payload.parameters, state.model.parameterValues)) {
      throw new ApiError(409, "parameters_not_saved", "Save parameter changes before starting a run.");
    }
    await this.actions.startRun(sessionId, { steps: command.payload.steps, seeds: command.payload.seeds });
    json(response, 202, this.store.acceptCommand(sessionId, command.commandId));
  }

  async #cancelRun(sessionId: string, runId: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const command = parseCommand<Record<string, never>>(await bodyText(request), sessionId);
    const duplicate = this.store.beginCommand(command);
    if (duplicate) return json(response, 202, duplicate);
    await this.actions.cancelRun(sessionId, runId);
    json(response, 202, this.store.acceptCommand(sessionId, command.commandId));
  }
}

const publicAgent = (readiness: OpenCodeReadiness): ProjectState["agent"] => ({
  modelId: readiness.modelId,
  status: readiness.status,
  ...(readiness.lastError ? { lastError: readiness.lastError } : {}),
});

const json = (response: ServerResponse, status: number, payload: unknown): void => {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(payload));
};

const sendEvent = (response: ServerResponse, event: BrowserEvent): void => {
  response.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
};

const parseCommand = <T>(text: string, routeSessionId: string): UiCommand<T> => {
  let value: UiCommand<T>;
  try { value = JSON.parse(text); } catch { throw new ApiError(422, "invalid_json", "Request body must be valid JSON."); }
  if (!value || typeof value.commandId !== "string" || typeof value.sessionId !== "string" || typeof value.baseRevision !== "number" || value.payload === undefined) {
    throw new ApiError(422, "invalid_command", "Request does not match the local command envelope.");
  }
  if (value.sessionId !== routeSessionId) throw new ApiError(422, "session_mismatch", "Command session does not match the route.");
  return value;
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

type MultipartFile = { filename: string; contentType: string; data: Buffer };
const multipart = async (request: IncomingMessage, limit: number): Promise<{ envelope: string; file?: MultipartFile }> => {
  const contentType = request.headers["content-type"] ?? "";
  const match = /boundary=([^;]+)/i.exec(contentType);
  if (!match) throw new ApiError(422, "invalid_upload", "Use multipart form data for file uploads.");
  const raw = Buffer.from(await bodyText(request, limit));
  const boundary = Buffer.from(`--${match[1].replace(/^"|"$/g, "")}`);
  const pieces = splitBuffer(raw, boundary).slice(1, -1);
  let envelope = "";
  let file: MultipartFile | undefined;
  for (const part of pieces) {
    const trimmed = part.subarray(0, 2).equals(Buffer.from("\r\n")) ? part.subarray(2) : part;
    const divider = trimmed.indexOf(Buffer.from("\r\n\r\n"));
    if (divider < 0) continue;
    const header = trimmed.subarray(0, divider).toString("utf8");
    const data = trimmed.subarray(divider + 4, trimmed.length - 2);
    const name = /name="([^"]+)"/i.exec(header)?.[1];
    if (name === "envelope") envelope = data.toString("utf8");
    if (name === "file") file = {
      filename: /filename="([^"]*)"/i.exec(header)?.[1] ?? "upload",
      contentType: /content-type:\s*([^\r\n]+)/i.exec(header)?.[1]?.trim().toLowerCase() ?? "application/octet-stream",
      data,
    };
  }
  if (!envelope) throw new ApiError(422, "missing_command", "The upload command envelope is required.");
  return { envelope, file };
};

const splitBuffer = (source: Buffer, separator: Buffer): Buffer[] => {
  const values: Buffer[] = [];
  let offset = 0;
  while (offset <= source.length) {
    const index = source.indexOf(separator, offset);
    if (index < 0) { values.push(source.subarray(offset)); break; }
    values.push(source.subarray(offset, index));
    offset = index + separator.length;
  }
  return values;
};

const attachmentType = (filename: string, contentType: string): string | undefined => {
  const extension = basename(filename).toLowerCase().split(".").pop();
  const expected = extension === "csv" ? "text/csv" : extension === "json" ? "application/json" : extension === "txt" ? "text/plain" : undefined;
  if (!expected) return undefined;
  const normalized = contentType.split(";", 1)[0].toLowerCase();
  return normalized === expected || normalized === "application/octet-stream" ? expected : undefined;
};

const safeFilename = (filename: string): string => {
  const safe = basename(filename).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
  if (!safe || safe === "." || safe === "..") throw new ApiError(422, "invalid_filename", "The attachment filename is invalid.");
  return safe;
};

const sameValues = (left: Record<string, Scalar>, right: Record<string, Scalar>): boolean => {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
};

const withCapability = (mcpUrl: string, capability: string): string => {
  let url: URL;
  try {
    url = new URL(mcpUrl);
  } catch {
    throw new ApiError(503, "mcp_unconfigured", "RIFF_MCP_URL must be an absolute local MCP URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ApiError(503, "mcp_unconfigured", "RIFF_MCP_URL must use HTTP or HTTPS.");
  }
  url.searchParams.set("cap", capability);
  return url.toString();
};

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, abort: () => Promise<void>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new ApiError(504, "agent_timeout", "The modelling assistant timed out.")), timeoutMs);
      }),
    ]);
  } catch (error) {
    if (error instanceof ApiError && error.code === "agent_timeout") void abort().catch(() => undefined);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const restrictedSystemPrompt = (): string => [
  "You are the local Riff Mesa modelling assistant.",
  "Use only the Riff MCP tools exposed in this session: riff_inspect_uploaded_files, riff_select_and_load_model(queue-network-v1), riff_set_parameters, riff_run_experiment, riff_get_run_status, and riff_read_run_results.",
  "Never call python-interpreter tools or any non-Riff tool. Do not use shell, local files, generic read/search/edit/write/task, network, browser, skill, or code-generation tools.",
  "Do not call riff_drive_workbench_ui or show_dashboard; they are not part of this assistant surface. If an action is unsupported, explain the limit and ask the user instead.",
  "After riff_select_and_load_model returns model_loaded, use its returned parameter metadata; do not inspect the local runtime to infer the model.",
  "For riff_get_run_status, omit runId when the run ID is unknown; an empty string is not a run ID and means the current run.",
  "After riff_read_run_results returns results_loaded, summarize its metrics and final series values in Chinese; do not reload or rerun a succeeded model unless the user asks.",
  "Do not claim an action succeeded until its tool result confirms it.",
].join("\n");
