import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ApiError } from "./errors.ts";
import { canonicalDigest } from "./canonical-json-v2.ts";
import type { ProjectOnlyOperationsAdapter, ProjectTechnicalCheckEnvelope } from "./project-only-operations.ts";
import {
  ProjectOnlyStore,
  ProjectOnlyStoreError,
  type ProjectRecord,
  type ProjectRunRecord,
} from "./project-only-store.ts";

const MAX_JSON_BYTES = 8 * 1024 * 1024;
const SAFE_COMMAND_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/u;

/**
 * Narrow public HTTP surface backed exclusively by ProjectOnlyStore.
 *
 * Missing Project-only authorities are rejected instead of falling through to
 * ProductStoreV2. In particular, Project creation is fail-closed until the
 * durable Conversation service can participate in the same creation unit.
 */
export class ProjectOnlyHttpApi {
  readonly store: ProjectOnlyStore;
  readonly operations: ProjectOnlyOperationsAdapter;
  readonly now: () => string;

  constructor(
    store: ProjectOnlyStore,
    operations: ProjectOnlyOperationsAdapter,
    now: () => string = () => new Date().toISOString(),
  ) {
    this.store = store;
    this.operations = operations;
    this.now = now;
  }

  async handle(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    parts: readonly string[],
  ): Promise<boolean> {
    try {
      return await this.#handle(request, response, url, parts);
    } catch (error) {
      if (error instanceof ProjectOnlyStoreError) throw projectOnlyErrorBody(error);
      throw error;
    }
  }

  async #handle(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    parts: readonly string[],
  ): Promise<boolean> {
    if (parts[0] !== "api") return false;
    if (parts[1] === "models") {
      throw new ApiError(410, "legacy_model_api_removed", "The Model API was removed. Use Project resources.");
    }
    if (request.method === "GET" && parts.length === 2 && parts[1] === "home") {
      exactQuery(url, []);
      return sendJson(response, 200, this.#home());
    }
    if (request.method === "GET" && parts.length === 2 && parts[1] === "providers") {
      exactQuery(url, []);
      return sendJson(response, 200, {
        mode: "read_only",
        reason: "opencode_unavailable",
        providerModels: [],
      });
    }
    if (request.method === "GET" && parts.length === 2 && parts[1] === "agents") {
      exactQuery(url, ["ownerKind", "ownerId"]);
      if (url.searchParams.get("ownerKind") !== "project" || !url.searchParams.get("ownerId")) {
        throw new ApiError(422, "invalid_request", "Project ownerKind and ownerId are required.");
      }
      return sendJson(response, 200, {
        mode: "read_only",
        reason: "project_conversation_service_unavailable",
        agents: [],
      });
    }
    if (parts[1] === "conversations" || parts[1] === "workspace-bindings") {
      throw unsupported("project_conversation_service_unavailable", "Project Conversations are not available in this Store runtime.");
    }
    if (parts[1] !== "projects") return false;
    if (request.method === "GET" && parts.length === 2) {
      exactQuery(url, []);
      return sendJson(response, 200, { projects: this.store.projects().map((project) => this.#projectSummary(project)) });
    }
    if (request.method === "POST" && parts.length === 2) {
      exactQuery(url, []);
      const body = await jsonBody(request);
      validateProjectCreation(body);
      // A Project must be born with its Project-scoped Conversation. Creating
      // only the workspace would leave an unrepairable partial public result.
      throw unsupported("project_conversation_service_unavailable", "Project creation requires the durable Project Conversation service.");
    }
    const projectId = parts[2];
    if (!projectId) throw new ApiError(404, "resource_not_found", "The Project resource was not found.");
    if (request.method === "GET" && parts.length === 4 && parts[3] === "workspace") {
      exactQuery(url, []);
      return sendJson(response, 200, this.#workspace(projectId));
    }
    if (request.method === "POST" && parts.length === 4 && parts[3] === "technical-checks") {
      exactQuery(url, []);
      const body = exactRecord(await jsonBody(request), ["commandId"]);
      const commandId = requiredCommandId(body.commandId);
      const project = this.store.project(projectId);
      const envelope = await this.operations.startProjectTechnicalCheck({
        projectId,
        commandId,
        expectedWorkspaceDigest: project.workspaceDigest,
      });
      const technicalCheck = (envelope.result as { technicalCheck: ProjectTechnicalCheckEnvelope }).technicalCheck;
      return sendJson(response, 201, publicTechnicalCheck(technicalCheck));
    }
    if (request.method === "GET" && parts.length === 5 && parts[3] === "technical-checks") {
      exactQuery(url, []);
      const check = this.store.technicalCheck(parts[4]!);
      if (check.projectId !== projectId) throw new ApiError(404, "resource_not_found", "The technical check was not found.");
      return sendJson(response, 200, publicStoredTechnicalCheck(check));
    }
    if (parts[3] === "runs" || parts[3] === "experiment-configs"
      || parts[3] === "generated-views" || parts[3] === "change-sets"
      || parts[3] === "files") {
      throw unsupported("project_runtime_service_unavailable", "The requested Project runtime authority is not connected.");
    }
    throw new ApiError(404, "resource_not_found", "The requested Project resource was not found.");
  }

  #home(): Record<string, unknown> {
    const projects = this.store.projects().map((project) => this.#projectSummary(project));
    const templates = this.store.templates().map((template) => Object.freeze({
      id: template.id,
      name: template.id,
      version: template.version,
      description: template.description,
      runMode: template.runMode,
      updatedAt: template.createdAt,
      templateDigest: template.contentDigest,
    }));
    return Object.freeze({
      schemaVersion: 1,
      generatedAt: this.now(),
      collectionDigest: canonicalDigest({ projects, templates }),
      projects: Object.freeze(projects),
      templates: Object.freeze(templates),
      recentConversations: Object.freeze([]),
      providerAvailability: Object.freeze({ mode: "read_only", reason: "opencode_unavailable" }),
    });
  }

  #projectSummary(project: ProjectRecord): Record<string, unknown> {
    const runs = this.store.runs(project.id);
    const lastRun = runs.at(-1) ?? null;
    const stable = {
      id: project.id,
      name: project.name,
      lifecycleState: project.lifecycleState,
      technicalStatus: project.technicalStatus,
      workspaceDigest: project.workspaceDigest,
      updatedAt: project.updatedAt,
    };
    return Object.freeze({
      ...stable,
      kind: "project",
      recordDigest: canonicalDigest(stable),
      createdAt: project.createdAt,
      recentActivityAt: lastRun?.updatedAt ?? project.updatedAt,
      recentActivityKind: lastRun ? "run" : "project",
      allowedActions: Object.freeze(["open"]),
      executionLock: publicExecutionLock(project, runs),
      lastRun: lastRun ? Object.freeze({ id: lastRun.id, status: publicRunStatus(lastRun), updatedAt: lastRun.updatedAt }) : null,
    });
  }

  #workspace(projectId: string): Record<string, unknown> {
    const project = this.store.project(projectId);
    const runs = this.store.runs(projectId);
    return Object.freeze({
      owner: Object.freeze({
        id: project.id,
        name: project.name,
        kind: "project",
        lifecycleState: project.lifecycleState,
        technicalStatus: project.technicalStatus,
      }),
      conversations: Object.freeze([]),
      workspaceDigest: project.workspaceDigest,
      execution: Object.freeze({ ...project.executionDescription }),
      executionDescriptionDigest: canonicalDigest(project.executionDescription),
      executionLock: publicExecutionLock(project, runs),
      files: Object.freeze(this.store.projectFiles(projectId).map((file) => Object.freeze({
        fileRef: file.id,
        relativePath: file.relativePath,
        mediaType: file.mediaType,
        sizeBytes: file.sizeBytes,
        sha256: file.sha256,
        createdAt: file.createdAt,
        readOnly: project.executionLock !== null,
      }))),
      experimentConfigurations: Object.freeze(this.store.experiments(projectId).map((experiment) => {
        const configurationDigest = canonicalDigest(experiment.configuration);
        return Object.freeze({
          ...experiment,
          estimatedSampleCount: 1,
          lifecycleState: "active",
          contractVersion: 4,
          readOnly: false,
          legacyDigest: null,
          configurationDigest,
          sampleCount: 1,
          recordDigest: canonicalDigest({
            id: experiment.id,
            name: experiment.name,
            configurationDigest,
            updatedAt: experiment.updatedAt,
          }),
        });
      })),
      runs: Object.freeze(runs.map((run) => publicRun(run, project.workspaceDigest))),
    });
  }
}

const publicExecutionLock = (
  project: ProjectRecord,
  runs: readonly ProjectRunRecord[],
): Record<string, unknown> => {
  const lock = project.executionLock;
  if (!lock) return Object.freeze({ state: "unlocked", runId: null, sourceDigest: null });
  if (lock.holderKind === "technical_check") {
    return Object.freeze({ state: "checking", runId: null, sourceDigest: lock.sourceWorkspaceDigest });
  }
  const run = runs.find((candidate) => candidate.id === lock.holderId);
  const state = run && ["queued", "running", "cancelling"].includes(run.status) ? run.status : "queued";
  return Object.freeze({ state, runId: lock.holderId, sourceDigest: lock.sourceWorkspaceDigest });
};

const publicRun = (run: ProjectRunRecord, currentDigest: string): Record<string, unknown> => Object.freeze({
  id: run.id,
  projectId: run.projectId,
  experimentConfigurationId: run.experimentConfigurationId,
  status: publicRunStatus(run),
  requestedSampleCount: 1,
  createdAt: run.createdAt,
  updatedAt: run.updatedAt,
  startedAt: run.startedAt,
  finishedAt: run.finishedAt,
  contractVersion: 4,
  readOnly: false,
  legacyDigest: null,
  runKind: run.runKind,
  cancelRequestedAt: run.status === "cancelling" ? run.updatedAt : null,
  terminalCode: run.terminalCode,
  completionCardDisposition: null,
  terminalStatus: ["succeeded", "failed", "cancelled", "timed_out"].includes(run.status) ? run.status : null,
  terminalClosureDigest: null,
  lifecycleDigest: null,
  seedCount: 1,
  stepOrHorizon: null,
  durationMs: null,
  resourceOverview: null,
  sourceDigest: run.sourceWorkspaceDigest,
  reproducibility: run.sourceWorkspaceDigest === currentDigest ? "current_source" : "source_not_retained",
  outputs: Object.freeze([]),
});

const publicRunStatus = (run: ProjectRunRecord): string =>
  run.status === "interrupted" ? "failed" : run.status;

const publicTechnicalCheck = (check: ProjectTechnicalCheckEnvelope): Record<string, unknown> => Object.freeze({
  id: check.id,
  projectId: check.projectId,
  state: check.state === "succeeded" ? "passed" : check.state === "interrupted" ? "cancelled" : "failed",
  publication: "published",
  capturedWorkspaceDigest: check.capturedWorkspaceDigest,
  executionDescriptionDigest: check.executionDescriptionDigest,
  aggregate: check.aggregate,
  checks: check.checks,
  startedAt: check.startedAt,
  finishedAt: check.finishedAt,
  claim: check.claim,
});

const publicStoredTechnicalCheck = (check: ReturnType<ProjectOnlyStore["technicalCheck"]>): Record<string, unknown> => Object.freeze({
  id: check.id,
  projectId: check.projectId,
  state: check.status === "succeeded" ? "passed" : check.status === "interrupted" ? "cancelled" : check.status,
  publication: check.status === "running" ? "pending" : "published",
  capturedWorkspaceDigest: check.capturedWorkspaceDigest,
  executionDescriptionDigest: check.executionDescriptionDigest,
  aggregate: check.status === "running" ? "pending" : check.status === "succeeded" ? "executable" : check.status === "interrupted" ? "cancelled" : "failed",
  checks: check.diagnostics,
  startedAt: check.startedAt,
  finishedAt: check.finishedAt,
  claim: "technical_execution_only",
});

const unsupported = (code: string, message: string): ApiError => new ApiError(501, code, message);

const validateProjectCreation = (value: unknown): void => {
  const body = exactRecord(value, ["commandId", "name", "provider", "source"]);
  requiredCommandId(body.commandId);
  if (typeof body.name !== "string" || body.name.trim().length < 1 || body.name.length > 200) {
    throw new ApiError(422, "invalid_request", "Project name is invalid.");
  }
  const provider = exactRecord(body.provider, ["providerId", "modelId"]);
  if (typeof provider.providerId !== "string" || typeof provider.modelId !== "string"
    || !provider.providerId || !provider.modelId) {
    throw new ApiError(422, "invalid_request", "Project provider selection is invalid.");
  }
  const source = exactRecord(body.source, sourceKeys(body.source));
  if (source.kind === "blank") return;
  if (source.kind === "template") {
    if (typeof source.templateId !== "string" || typeof source.templateVersion !== "string"
      || !source.templateId || !source.templateVersion) {
      throw new ApiError(422, "invalid_request", "Project template source is invalid.");
    }
    return;
  }
  if (source.kind === "import") {
    if (typeof source.filename !== "string" || typeof source.mediaType !== "string"
      || typeof source.base64 !== "string" || !source.filename || !source.mediaType
      || source.base64.length > MAX_JSON_BYTES * 2 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(source.base64)) {
      throw new ApiError(422, "invalid_request", "Project import source is invalid.");
    }
    return;
  }
  throw new ApiError(422, "invalid_request", "Project source kind is invalid.");
};

const sourceKeys = (value: unknown): readonly string[] => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["kind"];
  const kind = (value as Record<string, unknown>).kind;
  return kind === "blank" ? ["kind"]
    : kind === "template" ? ["kind", "templateId", "templateVersion"]
      : kind === "import" ? ["kind", "filename", "mediaType", "base64"] : ["kind"];
};

const requiredCommandId = (value: unknown): string => {
  if (typeof value !== "string" || !SAFE_COMMAND_ID.test(value)) {
    throw new ApiError(422, "invalid_request", "commandId is invalid.");
  }
  return value;
};

const exactRecord = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(422, "invalid_request", "A JSON object is required.");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !keys.includes(key)) || keys.some((key) => !(key in record))) {
    throw new ApiError(422, "invalid_request", "The request contains missing or unknown fields.");
  }
  return record;
};

const exactQuery = (url: URL, allowed: readonly string[]): void => {
  if ([...url.searchParams.keys()].some((key) => !allowed.includes(key))) {
    throw new ApiError(422, "invalid_request", "The request query contains unknown fields.");
  }
};

const jsonBody = async (request: IncomingMessage): Promise<unknown> => {
  const contentType = String(request.headers["content-type"] ?? "").split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new ApiError(415, "unsupported_media_type", "Use application/json.");
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const raw of request) {
    const chunk = Buffer.from(raw);
    length += chunk.byteLength;
    if (length > MAX_JSON_BYTES) throw new ApiError(413, "request_too_large", "The request is too large.");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new ApiError(422, "invalid_json", "The request body is not valid JSON."); }
};

const sendJson = (response: ServerResponse, status: number, body: unknown): true => {
  const bytes = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "cache-control": "private, no-store",
    "content-type": "application/json; charset=utf-8",
    "content-length": bytes.byteLength,
    "x-content-type-options": "nosniff",
  });
  response.end(bytes);
  return true;
};

export const projectOnlyErrorBody = (error: ProjectOnlyStoreError): ApiError => {
  const status = error.code.endsWith("_not_found") ? 404
    : error.code.startsWith("stale_") || error.code.includes("locked") ? 409 : 422;
  return new ApiError(status, error.code, error.message, { requestId: randomUUID() });
};
