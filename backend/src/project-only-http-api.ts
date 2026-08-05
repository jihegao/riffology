import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ApiError } from "./errors.ts";
import { canonicalDigest } from "./canonical-json-v2.ts";
import { planExperiment } from "./experiment-planner.ts";
import type { ProjectOnlyAgentService } from "./project-only-agent-service.ts";
import type { ProjectOnlyOperationsAdapter, ProjectTechnicalCheckEnvelope } from "./project-only-operations.ts";
import {
  ProjectOnlyStore,
  ProjectOnlyStoreError,
  type ProjectConversationMessageRecord,
  type ProjectConversationRecord,
  type ProjectConversationTurnRecord,
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
  readonly agent?: ProjectOnlyAgentService;
  readonly now: () => string;

  constructor(
    store: ProjectOnlyStore,
    operations: ProjectOnlyOperationsAdapter,
    agent?: ProjectOnlyAgentService,
    now: () => string = () => new Date().toISOString(),
  ) {
    this.store = store;
    this.operations = operations;
    this.agent = agent;
    this.now = now;
  }

  async initialize(): Promise<void> { await this.agent?.initialize(); }
  async close(): Promise<void> {
    await this.agent?.close();
    this.store.close();
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
      return sendJson(response, 200, await this.#home());
    }
    if (request.method === "GET" && parts.length === 2 && parts[1] === "providers") {
      exactQuery(url, []);
      return sendJson(response, 200, this.agent
        ? await this.agent.providers()
        : { mode: "read_only", reason: "opencode_unavailable", providerModels: [] });
    }
    if (request.method === "GET" && parts.length === 2 && parts[1] === "agents") {
      exactQuery(url, ["ownerKind", "ownerId"]);
      const ownerId = url.searchParams.get("ownerId");
      if (url.searchParams.get("ownerKind") !== "project" || !ownerId) {
        throw new ApiError(422, "invalid_request", "Project ownerKind and ownerId are required.");
      }
      return sendJson(response, 200, this.agent
        ? await this.agent.agents(ownerId)
        : { mode: "read_only", reason: "opencode_unavailable", agents: [] });
    }
    if (parts[1] === "workspace-bindings") {
      throw unsupported("project_conversation_service_unavailable", "Project Conversations are not available in this Store runtime.");
    }
    if (parts[1] === "objects") return this.#handleObjectConversations(request, response, url, parts);
    if (parts[1] === "conversations") return this.#handleConversation(request, response, url, parts);
    if (parts[1] !== "projects") return false;
    if (request.method === "GET" && parts.length === 2) {
      exactQuery(url, []);
      return sendJson(response, 200, { projects: this.store.projects().map((project) => this.#projectSummary(project)) });
    }
    if (request.method === "POST" && parts.length === 2) {
      exactQuery(url, []);
      const body = await jsonBody(request) as Record<string, any>;
      validateProjectCreation(body);
      if (!this.agent) throw unsupported("project_conversation_service_unavailable", "Project creation requires the durable Project Conversation service.");
      await this.agent.assertProvider(body.provider.providerId, body.provider.modelId);
      const projectId = stablePublicId("project", body.commandId);
      const conversationId = stablePublicId("conversation", body.commandId);
      const source = body.source.kind === "blank"
        ? { kind: "blank" as const }
        : body.source.kind === "template"
          ? { kind: "template" as const, templateId: body.source.templateId, version: body.source.templateVersion }
          : importSource(projectId, body.source);
      const created = this.store.createProjectWithConversation({
        commandId: body.commandId,
        project: { id: projectId, name: body.name.trim(), source, createdAt: this.now() },
        conversation: {
          id: conversationId,
          name: "模型设计",
          providerId: body.provider.providerId,
          modelId: body.provider.modelId,
        },
      });
      return sendJson(response, 201, Object.freeze({
        project: Object.freeze({
          id: created.project.id,
          name: created.project.name,
          lifecycleState: created.project.lifecycleState,
        }),
        conversation: publicConversation(created.conversation),
      }));
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
    if (request.method === "GET" && parts.length === 6 && parts[3] === "files"
      && parts[5] === "workbench-renderable") {
      exactQuery(url, []);
      const project = this.store.project(projectId);
      const file = this.store.projectFiles(project.id).find((candidate) => candidate.id === parts[4]);
      if (!file) throw new ApiError(404, "resource_not_found", "The Project file was not found.");
      return sendJson(response, 200, publicRenderable(file.relativePath, file.mediaType, file.bytes, file.sha256));
    }
    if (request.method === "POST" && parts.length === 4 && parts[3] === "experiment-configs") {
      exactQuery(url, []);
      const body = exactRecord(await jsonBody(request), ["commandId", "name", "configuration"]);
      const commandId = requiredCommandId(body.commandId);
      if (typeof body.name !== "string" || !body.name.trim() || body.name.length > 200
        || !body.configuration || typeof body.configuration !== "object" || Array.isArray(body.configuration)) {
        throw new ApiError(422, "invalid_request", "Experiment creation is invalid.");
      }
      const project = this.store.project(projectId);
      const plan = planExperiment({
        configuration: body.configuration,
        inputSchema: (project.executionDescription as any).inputs?.schema,
        maxSamples: 500,
      });
      if (project.runMode !== "both" && project.runMode !== plan.configuration.runKind) {
        throw new ApiError(409, "run_kind_not_declared", "Experiment kind is not declared by this Project.");
      }
      const id = stablePublicId("experiment", `${projectId}:${commandId}`);
      const existing = this.store.experiments(projectId).find((item) => item.id === id);
      if (existing) {
        if (existing.name !== body.name.trim() || canonicalDigest(existing.configuration) !== plan.configurationDigest) {
          throw new ApiError(409, "idempotency_conflict", "Experiment command was reused with different intent.");
        }
        return sendJson(response, 201, publicExperiment(existing, project));
      }
      this.store.createExperiment({
        id,
        projectId,
        name: body.name.trim(),
        configuration: plan.configuration as unknown as Record<string, unknown>,
        createdAt: this.now(),
      });
      return sendJson(response, 201, publicExperiment(this.store.experiments(projectId).find((item) => item.id === id)!, project));
    }
    if (request.method === "PATCH" && parts.length === 5 && parts[3] === "experiment-configs") {
      exactQuery(url, []);
      const body = optionalRecord(await jsonBody(request),
        ["commandId", "expectedConfigurationDigest", "expectedRecordDigest"], ["name", "configuration"]);
      requiredCommandId(body.commandId);
      const project = this.store.project(projectId);
      const experiment = this.store.experiments(projectId).find((item) => item.id === parts[4]);
      if (!experiment) throw new ApiError(404, "resource_not_found", "The Experiment was not found.");
      const current = publicExperiment(experiment, project) as any;
      if (body.expectedConfigurationDigest !== current.configurationDigest
        || body.expectedRecordDigest !== current.recordDigest) {
        throw new ApiError(409, "stale_record_digest", "Experiment changed before update.");
      }
      const nextConfiguration = body.configuration ?? experiment.configuration;
      const plan = planExperiment({
        configuration: nextConfiguration,
        inputSchema: (project.executionDescription as any).inputs?.schema,
        maxSamples: 500,
      });
      const name = body.name === undefined ? experiment.name : String(body.name).trim();
      if (!name || name.length > 200) throw new ApiError(422, "invalid_request", "Experiment name is invalid.");
      this.store.updateExperiment({
        id: experiment.id,
        projectId,
        name,
        configuration: plan.configuration as unknown as Record<string, unknown>,
        updatedAt: this.now(),
      });
      return sendJson(response, 200, publicExperiment(this.store.experiments(projectId).find((item) => item.id === experiment.id)!, project));
    }
    if (request.method === "POST" && parts.length === 4 && parts[3] === "runs") {
      exactQuery(url, []);
      const body = optionalRecord(await jsonBody(request), ["commandId", "experimentConfigId"], ["completionConversationId"]);
      const commandId = requiredCommandId(body.commandId);
      if (typeof body.experimentConfigId !== "string") throw new ApiError(422, "invalid_request", "Experiment ID is invalid.");
      const project = this.store.project(projectId);
      const experiment = this.store.experiments(projectId).find((item) => item.id === body.experimentConfigId);
      if (!experiment) throw new ApiError(404, "resource_not_found", "The Experiment was not found.");
      const plan = planExperiment({
        configuration: experiment.configuration,
        inputSchema: (project.executionDescription as any).inputs?.schema,
        maxSamples: 500,
      });
      if (plan.configuration.runKind !== "batch") {
        throw unsupported("project_visual_direct_start_unavailable", "Start visual Runs through the Project Conversation.");
      }
      if (!this.agent) throw unsupported("project_runtime_service_unavailable", "The batch runtime is unavailable.");
      const admitted = this.operations.startRunAdmission({
        commandId,
        projectId,
        experimentConfigurationId: experiment.id,
        runKind: "batch",
        expectedWorkspaceDigest: project.workspaceDigest,
      });
      this.agent.batchRuntime.start({ projectId, runId: admitted.runId });
      return sendJson(response, 201, {
        runId: admitted.runId,
        status: "queued",
        runKind: "batch",
        sampleCount: plan.sampleCount,
      });
    }
    if (request.method === "GET" && parts.length === 5 && parts[3] === "runs") {
      exactQuery(url, []);
      const project = this.store.project(projectId);
      const run = this.store.run(parts[4]!);
      if (run.projectId !== project.id) throw new ApiError(404, "resource_not_found", "The Run was not found.");
      return sendJson(response, 200, publicRun(run, project.workspaceDigest, this.store));
    }
    if (request.method === "POST" && parts.length === 6 && parts[3] === "runs" && parts[5] === "cancel") {
      exactQuery(url, []);
      const body = exactRecord(await jsonBody(request), ["commandId"]);
      requiredCommandId(body.commandId);
      const run = this.store.run(parts[4]!);
      if (run.projectId !== projectId) throw new ApiError(404, "resource_not_found", "The Run was not found.");
      if (!this.agent) throw unsupported("project_runtime_service_unavailable", "The visual runtime is unavailable.");
      if (run.runKind === "visual") await this.agent.cancelVisualRun(projectId, run.id);
      else await this.agent.batchRuntime.cancel(projectId, run.id);
      return sendJson(response, 200, publicRun(this.store.run(run.id), this.store.project(projectId).workspaceDigest, this.store));
    }
    if (request.method === "GET" && parts.length === 8 && parts[3] === "runs"
      && parts[5] === "outputs" && parts[7] === "renderable") {
      exactQuery(url, []);
      const run = this.store.run(parts[4]!);
      if (run.projectId !== projectId) throw new ApiError(404, "resource_not_found", "The Run was not found.");
      const output = this.store.runOutputs(run.id).find((item) => item.id === parts[6]);
      if (!output) throw new ApiError(404, "resource_not_found", "The output was not found.");
      return sendJson(response, 200, publicRenderable(output.relativePath, output.mediaType, output.bytes, output.sha256));
    }
    if (request.method === "GET" && parts.length === 8 && parts[3] === "runs"
      && parts[5] === "outputs" && parts[7] === "download") {
      exactQuery(url, []);
      const run = this.store.run(parts[4]!);
      if (run.projectId !== projectId) throw new ApiError(404, "resource_not_found", "The Run was not found.");
      const output = this.store.runOutputs(run.id).find((item) => item.id === parts[6]);
      if (!output) throw new ApiError(404, "resource_not_found", "The output was not found.");
      response.writeHead(200, {
        "cache-control": "private, no-store",
        "content-disposition": `attachment; filename="${output.logicalName.replace(/[^A-Za-z0-9._-]/gu, "_")}.json"`,
        "content-length": output.bytes.byteLength,
        "content-type": output.mediaType,
        "x-content-type-options": "nosniff",
      });
      response.end(output.bytes);
      return true;
    }
    if (parts[3] === "runs" || parts[3] === "experiment-configs"
      || parts[3] === "generated-views" || parts[3] === "change-sets"
      || parts[3] === "files") {
      throw unsupported("project_runtime_service_unavailable", "The requested Project runtime authority is not connected.");
    }
    throw new ApiError(404, "resource_not_found", "The requested Project resource was not found.");
  }

  async #home(): Promise<Record<string, unknown>> {
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
    const providerDiscovery = this.agent
      ? await this.agent.providers()
      : { mode: "read_only" as const, reason: "opencode_unavailable" as const, providerModels: [] as const };
    const recentConversations = this.store.projects().flatMap((project) =>
      this.store.conversations(project.id, "active").map((conversation) => Object.freeze({
        id: conversation.id,
        owner: Object.freeze({ kind: "project", id: project.id, name: project.name }),
        name: conversation.name,
        updatedAt: conversation.updatedAt,
      }))).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, 12);
    return Object.freeze({
      schemaVersion: 1,
      generatedAt: this.now(),
      collectionDigest: canonicalDigest({ projects, templates }),
      projects: Object.freeze(projects),
      templates: Object.freeze(templates),
      recentConversations: Object.freeze(recentConversations),
      providerAvailability: providerDiscovery.mode === "live"
        ? Object.freeze({ mode: "live", providerModelCount: providerDiscovery.providerModels.length })
        : Object.freeze({ mode: "read_only", reason: providerDiscovery.reason }),
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
      project: Object.freeze({
        id: project.id,
        name: project.name,
        kind: "project",
        lifecycleState: project.lifecycleState,
        technicalStatus: project.technicalStatus,
      }),
      conversations: Object.freeze(this.store.conversations(projectId).map(publicConversation)),
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
      experimentConfigurations: Object.freeze(this.store.experiments(projectId)
        .map((experiment) => publicExperiment(experiment, project))),
      runs: Object.freeze(runs.map((run) => publicRun(run, project.workspaceDigest, this.store))),
    });
  }

  async #handleObjectConversations(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    parts: readonly string[],
  ): Promise<true> {
    if (parts.length !== 5 || parts[2] !== "project" || parts[4] !== "conversations") {
      throw new ApiError(404, "resource_not_found", "The Project Conversation collection was not found.");
    }
    const projectId = parts[3]!;
    this.store.project(projectId);
    if (request.method === "GET") {
      exactQuery(url, ["lifecycle"]);
      const lifecycle = url.searchParams.get("lifecycle") ?? "active";
      if (!["active", "archived", "trashed"].includes(lifecycle)) {
        throw new ApiError(422, "invalid_request", "Conversation lifecycle is invalid.");
      }
      return sendJson(response, 200, {
        conversations: this.store.conversations(projectId, lifecycle as "active" | "archived" | "trashed")
          .map(publicConversation),
      });
    }
    if (request.method === "POST") {
      exactQuery(url, []);
      if (!this.agent) throw unsupported("project_conversation_service_unavailable", "Project Conversations are unavailable.");
      const body = exactRecord(await jsonBody(request), ["commandId", "name", "providerId", "modelId"]);
      const commandId = requiredCommandId(body.commandId);
      if (typeof body.name !== "string" || !body.name.trim()
        || typeof body.providerId !== "string" || typeof body.modelId !== "string") {
        throw new ApiError(422, "invalid_request", "Conversation creation is invalid.");
      }
      await this.agent.assertProvider(body.providerId, body.modelId);
      const created = this.store.createConversation({
        id: stablePublicId("conversation", `${projectId}:${commandId}`), projectId,
        name: body.name.trim(), providerId: body.providerId, modelId: body.modelId,
        createdAt: this.now(),
      });
      return sendJson(response, 201, publicConversation(created));
    }
    throw new ApiError(405, "method_not_allowed", "The method is not allowed.");
  }

  async #handleConversation(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    parts: readonly string[],
  ): Promise<true> {
    const conversationId = parts[2];
    if (!conversationId) throw new ApiError(404, "resource_not_found", "The Conversation was not found.");
    const conversation = this.store.conversation(conversationId);
    const tail = parts[3];
    if (request.method === "GET" && parts.length === 3) {
      exactQuery(url, []);
      return sendJson(response, 200, publicConversation(conversation));
    }
    if (request.method === "GET" && parts.length === 4 && tail === "messages") {
      exactQuery(url, []);
      return sendJson(response, 200, { messages: this.store.conversationMessages(conversationId).map(publicMessage) });
    }
    if (request.method === "GET" && parts.length === 4 && tail === "attachments") {
      exactQuery(url, []); return sendJson(response, 200, { attachments: [] });
    }
    if (request.method === "GET" && parts.length === 4 && tail === "documents") {
      exactQuery(url, []); return sendJson(response, 200, { documents: [] });
    }
    if (request.method === "GET" && parts.length === 4 && tail === "actions") {
      exactQuery(url, []);
      return sendJson(response, 200, {
        skillUses: [], actions: this.store.conversationTurns(conversationId).flatMap((turn) => turn.actions),
      });
    }
    if (request.method === "GET" && parts.length === 4 && tail === "runtime") {
      exactQuery(url, []);
      if (!this.agent) throw unsupported("project_conversation_service_unavailable", "Conversation runtime is unavailable.");
      return sendJson(response, 200, this.agent.runtime(conversationId));
    }
    if (request.method === "GET" && parts.length === 4 && tail === "composer-capabilities") {
      exactQuery(url, []);
      const revision = this.agent?.runtime(conversationId).revision ?? canonicalDigest(publicConversation(conversation));
      return sendJson(response, 200, {
        schemaVersion: 1, revision,
        commands: [], skills: [],
      });
    }
    if (request.method === "POST" && parts.length === 4 && tail === "turns") {
      exactQuery(url, []);
      if (!this.agent) throw unsupported("project_conversation_service_unavailable", "Conversation runtime is unavailable.");
      const body = optionalRecord(await jsonBody(request), ["requestKey", "text", "attachmentIds"], ["agentName"]);
      const requestKey = requiredCommandId(body.requestKey);
      if (typeof body.text !== "string" || !Array.isArray(body.attachmentIds) || body.attachmentIds.length !== 0
        || body.agentName !== undefined && typeof body.agentName !== "string") {
        throw new ApiError(422, "invalid_request", "Conversation turn input is invalid.");
      }
      const result = await this.agent.runTurn({
        conversationId, requestKey, text: body.text,
        ...(typeof body.agentName === "string" ? { agentName: body.agentName } : {}),
      });
      return sendJson(response, 200, publicTurnResult(result));
    }
    if (request.method === "PATCH" && parts.length === 4 && tail === "provider-binding") {
      exactQuery(url, []);
      if (!this.agent) throw unsupported("project_conversation_service_unavailable", "Conversation runtime is unavailable.");
      const body = exactRecord(await jsonBody(request), ["commandId", "expectedRecordDigest", "providerId", "modelId"]);
      requiredCommandId(body.commandId);
      if (typeof body.expectedRecordDigest !== "string" || body.expectedRecordDigest !== publicConversation(conversation).recordDigest
        || typeof body.providerId !== "string" || typeof body.modelId !== "string") {
        throw new ApiError(409, "stale_record_digest", "Conversation changed before provider update.");
      }
      await this.agent.assertProvider(body.providerId, body.modelId);
      return sendJson(response, 200, publicConversation(this.store.changeConversationProvider({
        conversationId, providerId: body.providerId, modelId: body.modelId, updatedAt: this.now(),
      })));
    }
    throw new ApiError(404, "resource_not_found", "The Conversation route was not found.");
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

const publicExperiment = (
  experiment: ReturnType<ProjectOnlyStore["experiments"]>[number],
  project: ProjectRecord,
): Record<string, unknown> => {
  let plan: ReturnType<typeof planExperiment> | null = null;
  try {
    plan = planExperiment({
      configuration: experiment.configuration,
      inputSchema: (project.executionDescription as any).inputs?.schema,
      maxSamples: 500,
    });
  } catch { /* Historical configurations remain visible even after source-schema changes. */ }
  const configurationDigest = canonicalDigest(experiment.configuration);
  const sampleCount = plan?.sampleCount ?? 0;
  return Object.freeze({
    ...experiment,
    estimatedSampleCount: sampleCount,
    lifecycleState: "active",
    contractVersion: 4,
    readOnly: false,
    legacyDigest: null,
    configurationDigest,
    sampleCount,
    samplePreview: Object.freeze((plan?.samples ?? []).slice(0, 100).map((sample) => Object.freeze({
      sampleIndex: sample.sampleIndex,
      sampleId: sample.sampleId,
      seed: sample.seed,
      parameters: sample.parameters,
    }))),
    samplePreviewTruncated: sampleCount > 100,
    recordDigest: canonicalDigest({
      id: experiment.id,
      name: experiment.name,
      configurationDigest,
      updatedAt: experiment.updatedAt,
    }),
  });
};

const publicRun = (run: ProjectRunRecord, currentDigest: string, store: ProjectOnlyStore): Record<string, unknown> => {
  const completion = store.runCompletion(run.id)?.completion as any;
  const outputs = store.runOutputs(run.id);
  const status = publicRunStatus(run);
  return Object.freeze({
  id: run.id,
  projectId: run.projectId,
  experimentConfigurationId: run.experimentConfigurationId,
  status: publicRunStatus(run),
  requestedSampleCount: Number(completion?.sampleCount ?? (run.runKind === "visual" ? 1 : 0)),
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
  terminalStatus: ["succeeded", "failed", "cancelled", "timed_out"].includes(status) ? status : null,
  terminalClosureDigest: null,
  lifecycleDigest: null,
  seedCount: Array.isArray((run.frozenConfiguration as any).sampling?.seeds)
    ? (run.frozenConfiguration as any).sampling.seeds.length : 1,
  stepOrHorizon: null,
  durationMs: completion?.startedAt && completion?.finishedAt
    ? Math.max(0, Date.parse(completion.finishedAt) - Date.parse(completion.startedAt)) : null,
  resourceOverview: completion?.resources ?? null,
  sourceDigest: run.sourceWorkspaceDigest,
  reproducibility: run.sourceWorkspaceDigest === currentDigest ? "current_source" : "source_not_retained",
  outputs: Object.freeze(outputs.map((output) => Object.freeze({
    id: output.id,
    runId: output.runId,
    logicalName: output.logicalName,
    outputType: output.declaredRole,
    contractVersion: 4,
    readOnly: false,
    legacyDigest: null,
    sampleIndex: output.sampleIndex,
    sampleId: output.sampleId,
    declaredRole: output.declaredRole,
    mediaType: output.mediaType,
    sizeBytes: output.sizeBytes,
    sha256: output.sha256,
    createdAt: output.createdAt,
  }))),
  });
};

const publicRunStatus = (run: ProjectRunRecord): string =>
  run.status === "interrupted" ? "failed" : run.status;

const publicConversation = (conversation: ProjectConversationRecord): Record<string, any> => {
  const stable = Object.freeze({
    id: conversation.id,
    owner: Object.freeze({ kind: "project", id: conversation.projectId }),
    name: conversation.name,
    lifecycleState: conversation.lifecycleState,
    provider: conversation.provider,
    sessionState: conversation.sessionState,
    updatedAt: conversation.updatedAt,
  });
  return Object.freeze({ ...stable, recordDigest: canonicalDigest(stable) });
};

const publicMessage = (message: ProjectConversationMessageRecord): Record<string, unknown> => Object.freeze({
  id: message.id,
  ordinal: message.ordinal,
  role: message.role,
  status: message.status,
  messageKind: message.messageKind,
  text: message.text,
  createdAt: message.createdAt,
  updatedAt: message.updatedAt,
});

const publicTurnResult = (result: Readonly<{
  mode: "live" | "read_only";
  reason?: string;
  turn: ProjectConversationTurnRecord;
  messages: readonly ProjectConversationMessageRecord[];
}>): Record<string, unknown> => Object.freeze({
  mode: result.mode,
  ...(result.reason ? { reason: result.reason } : {}),
  turn: Object.freeze({
    requestKey: result.turn.requestKey,
    state: result.turn.state,
    userMessageId: result.turn.userMessageId,
    assistantMessageId: result.turn.assistantMessageId,
    skillUses: Object.freeze([]),
    actions: result.turn.actions,
    goalVerification: result.turn.goalVerification,
    failure: result.turn.failureCode
      ? Object.freeze({ code: result.turn.failureCode, retryable: false }) : null,
  }),
  messages: Object.freeze(result.messages.map(publicMessage)),
});

const publicRenderable = (
  relativePath: string,
  mediaType: string,
  bytes: Buffer,
  sha256: string,
): Record<string, unknown> => {
  const text = bytes.toString("utf8");
  if (mediaType === "application/json" || relativePath.endsWith(".json")) {
    try { return Object.freeze({ kind: "json", title: relativePath, value: JSON.parse(text) }); }
    catch { /* malformed JSON remains source text */ }
  }
  if (mediaType === "text/markdown" || relativePath.endsWith(".md")) {
    return Object.freeze({ kind: "markdown", title: relativePath, text });
  }
  if (mediaType.startsWith("text/") || relativePath.endsWith(".py")) {
    const language = relativePath.endsWith(".py") ? "python"
      : relativePath.endsWith(".html") ? "html" : "text";
    return Object.freeze({ kind: "code", title: relativePath, language, text });
  }
  return Object.freeze({
    kind: "attachment", title: relativePath, mediaType, sizeBytes: bytes.byteLength,
    sha256, reason: "unsupported_media",
  });
};

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

const importSource = (projectId: string, source: Record<string, string>) => {
  const filename = source.filename.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u.test(filename)) {
    throw new ApiError(422, "invalid_request", "Project import filename is invalid.");
  }
  const bytes = Buffer.from(source.base64, "base64");
  if (!bytes.length || bytes.byteLength > MAX_JSON_BYTES) {
    throw new ApiError(422, "invalid_request", "Project import content is invalid.");
  }
  const importDigest = createHash("sha256").update(bytes).digest("hex");
  return Object.freeze({
    kind: "import" as const,
    importDigest,
    files: Object.freeze([Object.freeze({
      id: stablePublicId("project_file", `${projectId}:${filename}`),
      kind: filename.endsWith(".html") ? "project_visual_asset" as const : "project_code" as const,
      relativePath: `imports/${filename}`,
      mediaType: source.mediaType,
      bytes,
    })]),
  });
};

const stablePublicId = (prefix: string, value: string): string =>
  `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;

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

const optionalRecord = (
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
): Record<string, any> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(422, "invalid_request", "A JSON object is required.");
  }
  const record = value as Record<string, unknown>;
  const allowed = [...required, ...optional];
  if (Object.keys(record).some((key) => !allowed.includes(key))
    || required.some((key) => !(key in record))) {
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
