import type { IncomingMessage, ServerResponse } from "node:http";
import { ApiError } from "./errors.ts";
import { parseCanonicalJsonV2 } from "./canonical-json-v2.ts";
import type {
  AgentTurnDto,
  ConversationMessageDto,
  ConversationOwner,
} from "./agent-domain.ts";
import {
  AgentWorkspaceService,
  type ConversationRuntimeDto,
} from "./agent-workspace-service.ts";
import { redactPublicRuntimeText } from "./opencode-adapter.ts";
import type {
  PermanentDeleteReceipt,
  PermanentDeletePreview,
  ProductLifecycleKind,
} from "./product-domain.ts";
import {
  DiagnosticEventCursorCodec,
  DiagnosticEventCursorError,
  normalizeDiagnosticEventCursorFilters,
} from "./diagnostic-event-cursor.ts";

export class MilestoneA2Api {
  readonly service: AgentWorkspaceService;
  readonly #authorizeProductRead?: (request: IncomingMessage) => number | void;
  readonly #authorizeProductMutation?: (request: IncomingMessage) => number | void;
  readonly #requireBrowserAdmission: boolean;
  readonly #resourceDeleteRuntimeBlockers?: (
    preview: PermanentDeletePreview,
  ) => readonly { kind: string; id: string }[];
  readonly #commitResourcePermanentDelete?: (
    preview: PermanentDeletePreview,
    commit: () => PermanentDeleteReceipt,
  ) => PermanentDeleteReceipt;
  readonly #revokeRunAccess?: (runId: string) => void;
  readonly #diagnosticEventCursorCodec?: DiagnosticEventCursorCodec;
  #activeOutputDownloads = 0;
  readonly #activeOutputDownloadsByRun = new Map<string, number>();
  readonly #outputDownloadStarts: number[] = [];
  readonly #outputDownloadStartsByRun = new Map<string, number[]>();
  readonly #outputDownloadRevokersByRun = new Map<string, Set<() => void>>();
  readonly #outputDownloadsRevokedRuns = new Set<string>();

  constructor(
    service: AgentWorkspaceService,
    options: Readonly<{
      authorizeProductRead?: (request: IncomingMessage) => number | void;
      authorizeProductMutation?: (request: IncomingMessage) => number | void;
      requireBrowserAdmission?: boolean;
      resourceDeleteRuntimeBlockers?: (
        preview: PermanentDeletePreview,
      ) => readonly { kind: string; id: string }[];
      commitResourcePermanentDelete?: (
        preview: PermanentDeletePreview,
        commit: () => PermanentDeleteReceipt,
      ) => PermanentDeleteReceipt;
      revokeRunAccess?: (runId: string) => void;
      diagnosticEventCursorCodec?: DiagnosticEventCursorCodec;
    }> = {},
  ) {
    this.service = service;
    this.#authorizeProductRead = options.authorizeProductRead;
    this.#authorizeProductMutation = options.authorizeProductMutation;
    this.#requireBrowserAdmission = options.requireBrowserAdmission ?? false;
    this.#resourceDeleteRuntimeBlockers = options.resourceDeleteRuntimeBlockers;
    this.#commitResourcePermanentDelete = options.commitResourcePermanentDelete;
    this.#revokeRunAccess = options.revokeRunAccess;
    this.#diagnosticEventCursorCodec = options.diagnosticEventCursorCodec;
  }

  async handle(request: IncomingMessage, response: ServerResponse, url: URL, parts: string[]): Promise<boolean> {
    if (request.method === "POST" && url.pathname === "/a2/mcp") {
      if ([...url.searchParams.keys()].some((key) => key !== "cap") || url.searchParams.getAll("cap").length !== 1) {
        throw new ApiError(422, "invalid_mcp_capability", "The scoped A2 MCP capability query is invalid.");
      }
      const capability = url.searchParams.get("cap");
      if (!capability) throw new ApiError(401, "mcp_capability_required", "A scoped A2 MCP capability is required.");
      // The loopback capability-scoped MCP endpoint alone admits the domain's
      // reachable 8 MiB proposal/view payload ceiling plus bounded JSON
      // escaping overhead. Ordinary Product APIs retain their smaller limits.
      const body = await strictJsonBody(
        request,
        ["jsonrpc", "id", "method", "params"],
        ["id", "params"],
        18 * 1024 * 1024,
      );
      const result = await this.service.handleAgentMcp(capability, body);
      if (result === undefined) { response.writeHead(204, { "cache-control": "no-store" }); response.end(); }
      else json(response, 200, result);
      return true;
    }
    if (request.method === "GET" && url.pathname === "/a2") {
      html(response, acceptanceHtml());
      return true;
    }
    if (parts[0] !== "api") return false;
    let browserGeneration = 0;
    if (this.#requireBrowserAdmission
      && productRoute(request.method ?? "", parts)) {
      browserGeneration = this.#authorizeProductApi(request, url);
    }
    if (request.method === "GET" && parts.length === 2 && parts[1] === "home") {
      exactQuery(url, []);
      privateJson(response, 200, await this.service.home());
      return true;
    }
    if (request.method === "GET" && parts.length === 2
      && (parts[1] === "models" || parts[1] === "projects")) {
      const lifecycle = lifecycleQuery(url);
      privateJson(response, 200, parts[1] === "models"
        ? { models: this.service.listModelsByLifecycle(lifecycle) }
        : { projects: this.service.listProjectsByLifecycle(lifecycle) });
      return true;
    }
    if (request.method === "GET" && parts.length === 2 && parts[1] === "providers") {
      privateJson(response, 200, await this.service.discoverProviders());
      return true;
    }
    if (request.method === "POST" && parts.length === 2
      && parts[1] === "workspace-bindings") {
      const body = await strictJsonBody(request, ["commandId", "workspaceKey"]);
      privateJson(response, 201, await this.service.createWorkspaceBinding({
        commandId: requiredString(body.commandId, "commandId"),
        workspaceKey: requiredString(body.workspaceKey, "workspaceKey"),
      }));
      return true;
    }
    if (parts[1] === "workspace-bindings" && parts[2]) {
      const workspaceKey = parts[2];
      if (request.method === "GET" && parts.length === 3) {
        exactQuery(url, []);
        privateJson(response, 200, await this.service.workspaceBinding(workspaceKey));
        return true;
      }
      if (request.method === "PATCH" && parts.length === 3) {
        const body = await strictJsonBody(request, [
          "commandId", "expectedGeneration", "expectedBindingDigest", "draft", "provider",
        ], ["provider"]);
        const provider = body.provider === undefined
          ? undefined : body.provider === null ? null : workspaceProvider(body.provider);
        privateJson(response, 200, await this.service.updateWorkspaceBinding({
          commandId: requiredString(body.commandId, "commandId"),
          workspaceKey,
          expectedGeneration: requiredInteger(body.expectedGeneration, "expectedGeneration"),
          expectedBindingDigest: requiredString(body.expectedBindingDigest, "expectedBindingDigest"),
          draft: requiredString(body.draft, "draft", true),
          ...(provider === undefined ? {} : { provider }),
        }));
        return true;
      }
      if (request.method === "GET" && parts.length === 4
        && parts[3] === "bootstrap") {
        exactQuery(url, []);
        privateJson(response, 200,
          await this.service.workspaceBootstrapInventory(workspaceKey));
        return true;
      }
      if (request.method === "POST" && parts.length === 4
        && parts[3] === "turn") {
        const body = await strictJsonBody(request, [
          "requestKey", "expectedGeneration", "expectedBindingDigest", "text",
        ]);
        privateJson(response, 200, await this.service.runWorkspaceBootstrapTurn({
          workspaceKey,
          requestKey: requiredString(body.requestKey, "requestKey"),
          expectedGeneration: requiredInteger(body.expectedGeneration, "expectedGeneration"),
          expectedBindingDigest: requiredString(body.expectedBindingDigest, "expectedBindingDigest"),
          text: requiredString(body.text, "text"),
        }));
        return true;
      }
      if (request.method === "POST" && parts.length === 5
        && parts[3] === "bootstrap" && parts[4] === "create-model") {
        const body = await strictJsonBody(request, [
          "commandId", "expectedGeneration", "expectedBindingDigest", "name",
          "providerId", "modelId",
        ]);
        privateJson(response, 201, await this.service.bootstrapCreateModel({
          commandId: requiredString(body.commandId, "commandId"),
          workspaceKey,
          expectedGeneration: requiredInteger(body.expectedGeneration, "expectedGeneration"),
          expectedBindingDigest: requiredString(body.expectedBindingDigest, "expectedBindingDigest"),
          name: requiredString(body.name, "name"),
          providerId: requiredString(body.providerId, "providerId"),
          modelId: requiredString(body.modelId, "modelId"),
        }));
        return true;
      }
      if (request.method === "POST" && parts.length === 5
        && parts[3] === "bootstrap" && parts[4] === "create-project") {
        const body = await strictJsonBody(request, [
          "commandId", "expectedGeneration", "expectedBindingDigest", "name",
          "sourceModelRef", "providerId", "modelId",
        ]);
        privateJson(response, 201, await this.service.bootstrapCreateProject({
          commandId: requiredString(body.commandId, "commandId"),
          workspaceKey,
          expectedGeneration: requiredInteger(body.expectedGeneration, "expectedGeneration"),
          expectedBindingDigest: requiredString(body.expectedBindingDigest, "expectedBindingDigest"),
          name: requiredString(body.name, "name"),
          sourceModelRef: requiredString(body.sourceModelRef, "sourceModelRef"),
          providerId: requiredString(body.providerId, "providerId"),
          modelId: requiredString(body.modelId, "modelId"),
        }));
        return true;
      }
      if (request.method === "POST" && parts.length === 5
        && parts[3] === "bootstrap" && parts[4] === "bind-owner") {
        const body = await strictJsonBody(request, [
          "commandId", "expectedGeneration", "expectedBindingDigest", "objectRef",
          "providerId", "modelId",
        ]);
        privateJson(response, 200, await this.service.bootstrapBindOwner({
          commandId: requiredString(body.commandId, "commandId"),
          workspaceKey,
          expectedGeneration: requiredInteger(body.expectedGeneration, "expectedGeneration"),
          expectedBindingDigest: requiredString(body.expectedBindingDigest, "expectedBindingDigest"),
          objectRef: requiredString(body.objectRef, "objectRef"),
          providerId: requiredString(body.providerId, "providerId"),
          modelId: requiredString(body.modelId, "modelId"),
        }));
        return true;
      }
    }
    if (request.method === "GET" && parts.length === 2 && parts[1] === "agents") {
      exactQuery(url, ["ownerKind", "ownerId"]);
      const ownerKind = url.searchParams.get("ownerKind");
      const ownerId = url.searchParams.get("ownerId");
      if (!ownerKind || !ownerId) {
        throw new ApiError(422, "invalid_product_query", "Agent discovery requires one Product owner.");
      }
      const discovery = await this.service.discoverAgents(
        ownerFromRoute(ownerKind, ownerId),
      );
      privateJson(response, 200, {
        mode: discovery.mode,
        ...(discovery.mode === "read_only" ? { reason: discovery.reason } : {}),
        agents: discovery.agents.map((agent) => ({
          name: agent.name,
          label: agent.name,
          description: agent.description,
        })),
      });
      return true;
    }
    if (request.method === "POST" && parts.length === 2 && parts[1] === "models") {
      const body = await strictJsonBody(request, ["commandId", "name", "providerId", "modelId"]);
      json(response, 201, await this.service.createModel({
        commandId: requiredString(body.commandId, "commandId"),
        name: requiredString(body.name, "name"),
        providerId: requiredString(body.providerId, "providerId"),
        modelId: requiredString(body.modelId, "modelId"),
      }));
      return true;
    }
    if (parts.length >= 4 && parts[1] === "resources") {
      const kind = publicLifecycleKind(parts[2]);
      const id = parts[3];
      if (request.method === "PATCH" && parts.length === 4) {
        const body = await strictJsonBody(
          request,
          ["commandId", "expectedRecordDigest", "name"],
        );
        privateJson(response, 200, this.service.lifecycleCommand({
          commandId: requiredString(body.commandId, "commandId"),
          action: "rename",
          kind,
          id,
          expectedRecordDigest: requiredString(
            body.expectedRecordDigest,
            "expectedRecordDigest",
          ),
          name: requiredString(body.name, "name"),
        }));
        return true;
      }
      if (request.method === "POST" && parts.length === 5
        && ["archive", "restore", "trash"].includes(parts[4]!)) {
        const body = await strictJsonBody(
          request,
          ["commandId", "expectedRecordDigest"],
        );
        privateJson(response, 200, this.service.lifecycleCommand({
          commandId: requiredString(body.commandId, "commandId"),
          action: parts[4] as "archive" | "restore" | "trash",
          kind,
          id,
          expectedRecordDigest: requiredString(
            body.expectedRecordDigest,
            "expectedRecordDigest",
          ),
        }));
        return true;
      }
      if (request.method === "POST" && parts.length === 5
        && parts[4] === "permanent-delete-preview") {
        await strictJsonBody(request, []);
        const preview = this.service.store.previewPermanentDelete(kind, id);
        const runtimeBlockers = this.#runtimeDeleteBlockers(preview);
        privateJson(response, 200, this.service.permanentDeletePreview({
          kind,
          id,
          browserGeneration,
          runtimeBlockers,
        }));
        return true;
      }
      if (request.method === "POST" && parts.length === 5
        && parts[4] === "permanent-delete") {
        const body = await strictJsonBody(request, [
          "commandId",
          "previewToken",
          "stateToken",
          "confirmationToken",
          "confirmation",
        ]);
        const confirmation = permanentDeleteConfirmation(body.confirmation);
        privateJson(response, 200, this.service.permanentDelete({
          commandId: requiredString(body.commandId, "commandId"),
          kind,
          id,
          browserGeneration,
          previewToken: requiredString(body.previewToken, "previewToken"),
          stateToken: requiredString(body.stateToken, "stateToken"),
          confirmationToken: requiredString(
            body.confirmationToken,
            "confirmationToken",
          ),
          confirmation,
          commitWithFence: (preview, commit) => {
            const blockers = this.#runtimeDeleteBlockers(preview);
            if (blockers.length > 0) {
              throw new ApiError(
                409,
                "permanent_delete_active_authority",
                "The resource still has active browser or execution authority.",
              );
            }
            return this.#commitResourcePermanentDelete
              ? this.#commitResourcePermanentDelete(preview, commit)
              : commit();
          },
        }));
        return true;
      }
    }
    if (request.method === "POST" && parts.length === 2 && parts[1] === "projects") {
      const body = await strictJsonBody(request, ["commandId", "name", "modelId"]);
      json(response, 201, this.service.createProject({
        commandId: requiredString(body.commandId, "commandId"),
        name: requiredString(body.name, "name"),
        modelId: requiredString(body.modelId, "modelId"),
      }));
      return true;
    }
    if (request.method === "GET" && parts.length === 4 && parts[1] === "projects" && parts[3] === "workspace") {
      json(response, 200, this.service.projectWorkspace(parts[2]));
      return true;
    }
    if (request.method === "GET" && parts.length === 6
      && parts[1] === "projects" && parts[3] === "files"
      && parts[5] === "renderable") {
      privateJson(
        response,
        200,
        this.service.projectFileRenderable(parts[2], parts[4]),
      );
      return true;
    }
    if (request.method === "GET" && parts.length === 6
      && parts[1] === "projects" && parts[3] === "files"
      && parts[5] === "workbench-renderable") {
      privateJson(
        response,
        200,
        this.service.projectFileWorkbenchRenderable(parts[2], parts[4]),
      );
      return true;
    }
    if (parts.length >= 4 && parts[1] === "projects" && parts[3] === "runs") {
      const projectId = parts[2];
      if (request.method === "POST" && parts.length === 4) {
        const body = await strictJsonBody(
          request,
          ["commandId", "experimentConfigId", "completionConversationId"],
          ["completionConversationId"],
        );
        json(response, 201, this.service.startRun({
          projectId,
          commandId: requiredString(body.commandId, "commandId"),
          experimentConfigId: requiredString(body.experimentConfigId, "experimentConfigId"),
          ...(body.completionConversationId === undefined
            ? {}
            : { completionConversationId: requiredString(body.completionConversationId, "completionConversationId") }),
        }));
        return true;
      }
      if (request.method === "GET" && parts.length === 5) {
        json(response, 200, this.service.getRun(projectId, parts[4]));
        return true;
      }
      if (request.method === "GET" && parts.length === 6 && parts[5] === "outputs") {
        this.#authorizeOutputRead(request, url);
        privateJson(response, 200, this.service.listRunOutputs(projectId, parts[4]));
        return true;
      }
      if (request.method === "GET" && parts.length === 8
        && parts[5] === "outputs" && parts[7] === "renderable") {
        this.#authorizeOutputRead(request, url);
        privateJson(
          response,
          200,
          this.service.runOutputRenderable(projectId, parts[4], parts[6]),
        );
        return true;
      }
      if (request.method === "GET" && parts.length === 6
        && parts[5] === "diagnostic-events") {
        this.#authorizeEventRead(request);
        privateJson(
          response,
          200,
          this.#listDiagnosticEvents(url, projectId, parts[4]),
        );
        return true;
      }
      if ((request.method === "GET" || request.method === "HEAD")
        && parts.length === 8 && parts[5] === "outputs" && parts[7] === "download") {
        this.#authorizeOutputRead(request, url);
        this.#downloadOutput(request, response, projectId, parts[4], parts[6]);
        return true;
      }
      if (request.method === "POST" && parts.length === 6 && parts[5] === "cancel") {
        this.#authorizeRunMutation(request, url);
        const body = await strictJsonBody(request, ["commandId"], [], 4_096, true);
        privateJson(response, 200, this.service.cancelRun({
          projectId,
          runId: parts[4],
          commandId: requiredString(body.commandId, "commandId"),
        }));
        return true;
      }
      if (request.method === "POST" && parts.length === 6 && parts[5] === "trash") {
        this.#authorizeRunMutation(request, url);
        if (!this.#revokeRunAccess) {
          throw new ApiError(
            503,
            "run_control_unavailable",
            "Run revocation is unavailable.",
          );
        }
        const body = await strictJsonBody(
          request,
          ["commandId", "expectedLifecycleDigest", "confirmation"],
          [],
          4_096,
          true,
        );
        const runId = parts[4];
        const confirmation = trashRunConfirmation(body.confirmation);
        let downloadsRevoked = false;
        try {
          const result = this.service.trashRun({
            projectId,
            runId,
            commandId: requiredString(body.commandId, "commandId"),
            expectedLifecycleDigest: requiredString(
              body.expectedLifecycleDigest,
              "expectedLifecycleDigest",
            ),
            confirmation,
            beforeCommit: () => {
              this.#revokeOutputDownloads(runId);
              downloadsRevoked = true;
              this.#revokeRunAccess!(runId);
            },
          });
          privateJson(response, 200, result);
        } catch (error) {
          if (downloadsRevoked) {
            try {
              if (this.service.getRun(projectId, runId).status !== "trashed") {
                this.#allowOutputDownloads(runId);
              }
            } catch {
              // Keep the fail-closed fence unless durable non-trashed state is confirmed.
            }
          }
          throw error;
        }
        return true;
      }
      if (request.method === "POST" && parts.length === 6 && parts[5] === "restore") {
        this.#authorizeRunMutation(request, url);
        const body = await strictJsonBody(
          request,
          ["commandId", "expectedLifecycleDigest"],
          [],
          4_096,
          true,
        );
        const runId = parts[4];
        const result = this.service.restoreRun({
          projectId,
          runId,
          commandId: requiredString(body.commandId, "commandId"),
          expectedLifecycleDigest: requiredString(
            body.expectedLifecycleDigest,
            "expectedLifecycleDigest",
          ),
        });
        if (this.service.getRun(projectId, runId).status !== "trashed") {
          this.#allowOutputDownloads(runId);
        }
        privateJson(response, 200, result);
        return true;
      }
    }
    if (parts.length >= 4 && parts[1] === "projects" && parts[3] === "experiment-configs") {
      const projectId = parts[2];
      if (request.method === "POST" && parts.length === 4) {
        const body = await strictJsonBody(request, ["commandId", "name", "configuration"]);
        json(response, 201, this.service.createExperimentConfiguration({
          projectId,
          commandId: requiredString(body.commandId, "commandId"),
          name: requiredString(body.name, "name"),
          configuration: requiredObject(body.configuration, "configuration"),
        }));
        return true;
      }
      if (request.method === "PATCH" && parts.length === 5) {
        const body = await strictJsonBody(
          request,
          ["commandId", "expectedConfigurationDigest", "expectedRecordDigest", "name", "configuration"],
          ["name", "configuration"],
        );
        json(response, 200, this.service.updateExperimentConfiguration({
          projectId,
          configId: parts[4],
          commandId: requiredString(body.commandId, "commandId"),
          expectedConfigurationDigest: requiredString(body.expectedConfigurationDigest, "expectedConfigurationDigest"),
          expectedRecordDigest: requiredString(body.expectedRecordDigest, "expectedRecordDigest"),
          ...(body.name === undefined ? {} : { name: requiredString(body.name, "name") }),
          ...(body.configuration === undefined ? {} : { configuration: requiredObject(body.configuration, "configuration") }),
        }));
        return true;
      }
    }
    if (parts.length >= 4 && parts[1] === "models") {
      const modelId = parts[2];
      if (request.method === "GET" && parts.length === 4 && parts[3] === "workspace") {
        json(response, 200, this.service.modelWorkspace(modelId));
        return true;
      }
      if (request.method === "POST" && parts.length === 4 && parts[3] === "technical-checks") {
        const body = await strictJsonBody(request, ["commandId"]);
        json(response, 200, await this.service.startTechnicalCheck(modelId, requiredString(body.commandId, "commandId")));
        return true;
      }
      if (request.method === "GET" && parts.length === 5 && parts[3] === "renderables") {
        privateJson(response, 200, this.service.modelRenderable(modelId, parts[4]));
        return true;
      }
      if (request.method === "GET" && parts.length === 5 && parts[3] === "workbench-renderables") {
        privateJson(response, 200, this.service.modelWorkbenchRenderable(modelId, parts[4]));
        return true;
      }
      if (request.method === "GET" && parts.length === 4
        && parts[3] === "generated-views") {
        privateJson(response, 200, this.service.generatedViews(modelId));
        return true;
      }
      if (request.method === "GET" && parts.length === 6
        && parts[3] === "generated-views" && parts[5] === "renderable") {
        privateJson(
          response,
          200,
          this.service.generatedViewRenderable(modelId, parts[4]),
        );
        return true;
      }
      if (request.method === "GET" && parts.length === 4
        && parts[3] === "change-sets") {
        exactQuery(url, ["state"]);
        const state = url.searchParams.get("state");
        if (state !== null && !["pending", "applied", "rejected"].includes(state)) {
          throw new ApiError(422, "invalid_product_query", "Change-set state is invalid.");
        }
        privateJson(
          response,
          200,
          this.service.listModelChangeSets(
            modelId,
            state === null
              ? undefined
              : state as "pending" | "applied" | "rejected",
          ),
        );
        return true;
      }
      if (request.method === "GET" && parts.length === 5
        && parts[3] === "change-sets") {
        privateJson(
          response,
          200,
          this.service.getModelChangeSet(modelId, parts[4]),
        );
        return true;
      }
      if (request.method === "POST" && parts.length === 6
        && parts[3] === "change-sets" && parts[5] === "apply") {
        const body = await strictJsonBody(request, [
          "commandId",
          "expectedChangeSetDigest",
          "expectedWorkspaceDigest",
        ]);
        privateJson(response, 200, this.service.applyModelChangeSet({
          modelId,
          changeSetId: parts[4],
          commandId: requiredString(body.commandId, "commandId"),
          expectedChangeSetDigest: requiredString(
            body.expectedChangeSetDigest,
            "expectedChangeSetDigest",
          ),
          expectedWorkspaceDigest: requiredString(
            body.expectedWorkspaceDigest,
            "expectedWorkspaceDigest",
          ),
        }));
        return true;
      }
      if (request.method === "POST" && parts.length === 6
        && parts[3] === "change-sets" && parts[5] === "reject") {
        const body = await strictJsonBody(request, [
          "commandId",
          "expectedChangeSetDigest",
        ]);
        privateJson(response, 200, this.service.rejectModelChangeSet({
          modelId,
          changeSetId: parts[4],
          commandId: requiredString(body.commandId, "commandId"),
          expectedChangeSetDigest: requiredString(
            body.expectedChangeSetDigest,
            "expectedChangeSetDigest",
          ),
        }));
        return true;
      }
      if ((request.method === "GET" || request.method === "HEAD")
        && parts.length === 6 && parts[3] === "files" && parts[5] === "download") {
        this.#downloadModelFile(request, response, modelId, parts[4]);
        return true;
      }
      if (request.method === "GET" && parts.length === 5 && parts[3] === "technical-checks") {
        json(response, 200, this.service.getTechnicalCheck(modelId, parts[4]));
        return true;
      }
    }
    if (parts.length === 5 && parts[1] === "objects" && parts[4] === "conversations") {
      const owner = ownerFromRoute(parts[2], parts[3]);
      if (request.method === "GET") {
        const lifecycle = lifecycleQuery(url);
        json(response, 200, {
          conversations: this.service.listConversations(owner, lifecycle),
        });
        return true;
      }
      if (request.method === "POST") {
        const body = await strictJsonBody(request, ["commandId", "name", "providerId", "modelId"]);
        json(response, 201, await this.service.createConversation({
          commandId: requiredString(body.commandId, "commandId"),
          owner,
          name: requiredString(body.name, "name"),
          providerId: requiredString(body.providerId, "providerId"),
          modelId: requiredString(body.modelId, "modelId"),
        }));
        return true;
      }
    }
    if (parts.length >= 3 && parts[1] === "conversations") {
      const conversationId = parts[2];
      if (request.method === "GET" && parts.length === 3) {
        json(response, 200, this.service.getConversation(conversationId));
        return true;
      }
      if (request.method === "GET" && parts.length === 4 && parts[3] === "messages") {
        json(response, 200, {
          messages: this.service.listMessages(conversationId)
            .map(publicConversationMessage),
        });
        return true;
      }
      if (request.method === "GET" && parts.length === 4 && parts[3] === "attachments") {
        json(response, 200, {
          attachments: this.service.listAttachments(conversationId),
        });
        return true;
      }
      if (request.method === "GET" && parts.length === 4 && parts[3] === "documents") {
        json(response, 200, { documents: this.service.listTemporaryDocuments(conversationId) });
        return true;
      }
      if (request.method === "GET" && parts.length === 4 && parts[3] === "actions") {
        json(response, 200, this.service.listConversationActivity(conversationId));
        return true;
      }
      if (request.method === "GET" && parts.length === 4 && parts[3] === "composer-capabilities") {
        privateJson(response, 200, await this.service.composerCapabilities(conversationId));
        return true;
      }
      if (request.method === "POST" && parts.length === 4 && parts[3] === "composer-commands") {
        const body = await strictJsonBody(request, ["commandId", "commandKey", "expectedRevision"]);
        const commandId = requiredString(body.commandId, "commandId");
        if (!(["stop", "retry", "check-model"] as const).includes(commandId as "stop" | "retry" | "check-model")) {
          throw new ApiError(422, "invalid_composer_command", "The Conversation command is invalid.");
        }
        privateJson(response, 200, await this.service.executeComposerCommand({
          conversationId,
          commandId: commandId as "stop" | "retry" | "check-model",
          commandKey: requiredString(body.commandKey, "commandKey"),
          expectedRevision: requiredString(body.expectedRevision, "expectedRevision"),
        }));
        return true;
      }
      if (request.method === "GET" && parts.length === 4 && parts[3] === "runtime") {
        privateJson(response, 200, publicConversationRuntime(
          await this.service.conversationRuntime(conversationId),
        ));
        return true;
      }
      if (request.method === "GET" && parts.length === 5
        && parts[3] === "runtime" && parts[4] === "events") {
        this.service.getConversation(conversationId);
        this.#streamConversationRuntime(request, response, conversationId);
        return true;
      }
      if (request.method === "PATCH" && parts.length === 4
        && parts[3] === "provider-binding") {
        const body = await strictJsonBody(request, [
          "commandId",
          "expectedRecordDigest",
          "providerId",
          "modelId",
        ]);
        privateJson(response, 200, await this.service.changeConversationProvider({
          commandId: requiredString(body.commandId, "commandId"),
          conversationId,
          expectedRecordDigest: requiredString(
            body.expectedRecordDigest,
            "expectedRecordDigest",
          ),
          providerId: requiredString(body.providerId, "providerId"),
          modelId: requiredString(body.modelId, "modelId"),
        }));
        return true;
      }
      if (request.method === "POST" && parts.length === 4 && parts[3] === "attachments") {
        const body = await strictJsonBody(request, ["commandId", "originalName", "mediaType", "base64", "purpose"], ["purpose"], 1_500_000);
        json(response, 201, this.service.createAttachment({
          commandId: requiredString(body.commandId, "commandId"),
          conversationId,
          originalName: requiredString(body.originalName, "originalName"),
          mediaType: requiredString(body.mediaType, "mediaType"),
          bytes: strictBase64(body.base64),
          ...(body.purpose === undefined ? {} : { purpose: requiredString(body.purpose, "purpose") }),
        }));
        return true;
      }
      if (request.method === "POST" && parts.length === 4 && parts[3] === "turns") {
        const body = await strictJsonBody(request, ["requestKey", "text", "agentName", "attachmentIds", "visualInteractionConfirmation"], ["agentName", "attachmentIds", "visualInteractionConfirmation"]);
        const result = await this.service.runTurn({
          conversationId,
          requestKey: requiredString(body.requestKey, "requestKey"),
          text: requiredString(body.text, "text"),
          ...(body.agentName === undefined ? {} : { agentName: requiredString(body.agentName, "agentName") }),
          ...(body.attachmentIds === undefined ? {} : { attachmentIds: stringArray(body.attachmentIds, "attachmentIds") }),
          ...(body.visualInteractionConfirmation === undefined ? {} : { visualInteractionConfirmation: visualInteractionConfirmation(body.visualInteractionConfirmation) }),
        });
        json(
          response,
          200,
          {
            ...result,
            turn: publicAgentTurn(result.turn, this.service),
            messages: result.messages.map(publicConversationMessage),
          },
        );
        return true;
      }
      if (request.method === "POST" && parts.length === 6
        && parts[3] === "turns" && parts[5] === "stop") {
        const body = await strictJsonBody(request, ["commandId"], ["commandId"]);
        if (body.commandId !== undefined) requiredString(body.commandId, "commandId");
        privateJson(response, 200, await this.service.stopTurn(conversationId, parts[4]));
        return true;
      }
      if (request.method === "POST" && parts.length === 6
        && parts[3] === "turns" && parts[5] === "retry") {
        const body = await strictJsonBody(request, ["commandId", "requestKey"], ["commandId"]);
        if (body.commandId !== undefined) requiredString(body.commandId, "commandId");
        const result = await this.service.retryTurn({
          conversationId,
          sourceRequestKey: parts[4],
          requestKey: requiredString(body.requestKey, "requestKey"),
        });
        privateJson(response, 200, {
          ...result,
          turn: publicAgentTurn(result.turn, this.service),
          messages: result.messages.map(publicConversationMessage),
        });
        return true;
      }
      if (request.method === "POST" && parts.length === 6
        && parts[3] === "turns" && parts[5] === "resume") {
        const body = await strictJsonBody(
          request,
          ["interactionId", "kind", "decision", "answers", "reject"],
          ["decision", "answers", "reject"],
        );
        privateJson(response, 200, await this.service.resumeTurn({
          conversationId,
          requestKey: parts[4],
          interactionId: requiredString(body.interactionId, "interactionId"),
          response: interactionResponse(body),
        }));
        return true;
      }
    }
    return false;
  }

  #streamConversationRuntime(
    request: IncomingMessage,
    response: ServerResponse,
    conversationId: string,
  ): void {
    response.writeHead(200, {
      "cache-control": "private, no-store",
      "content-type": "text/event-stream; charset=utf-8",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "x-content-type-options": "nosniff",
    });
    let closed = false;
    let timer: NodeJS.Timeout | undefined;
    let lastRevision: string | null = null;
    const close = () => {
      closed = true;
      if (timer) clearTimeout(timer);
    };
    request.once("aborted", close);
    response.once("close", close);
    const poll = async (): Promise<void> => {
      if (closed) return;
      try {
        const snapshot = await this.service.conversationRuntime(conversationId);
        if (snapshot.revision !== lastRevision) {
          lastRevision = snapshot.revision;
          response.write(`id: ${snapshot.revision}\ndata: ${JSON.stringify(publicConversationRuntime(snapshot))}\n\n`);
        }
      } catch {
        // A normal GET snapshot is the recovery authority. The stream never
        // forwards raw upstream errors.
      }
      if (!closed) timer = setTimeout(() => { void poll(); }, 250);
    };
    void poll();
  }

  #authorizeProductApi(request: IncomingMessage, url: URL): number {
    const method = request.method ?? "";
    if (method === "GET" || method === "HEAD") {
      const collectionQuery = method === "GET"
        && (/^\/api\/(?:models|projects)$/u.test(url.pathname)
          || /^\/api\/objects\/(?:model|project)\/[^/]+\/conversations$/u
            .test(url.pathname));
      const eventQuery = method === "GET"
        && /\/diagnostic-events$/u.test(url.pathname);
      const agentQuery = method === "GET" && url.pathname === "/api/agents";
      const changeSetQuery = method === "GET"
        && /^\/api\/models\/[^/]+\/change-sets$/u.test(url.pathname);
      if (url.search !== "" && !collectionQuery && !eventQuery && !agentQuery
        && !changeSetQuery) {
        throw new ApiError(
          422,
          "invalid_product_query",
          "This Product API read does not accept query parameters.",
        );
      }
      const contentLength = exactProductRawHeader(request, "content-length");
      if (exactProductRawHeader(request, "transfer-encoding") !== undefined
        || contentLength !== undefined && contentLength !== "0"
        || exactProductRawHeader(request, "if-none-match") !== undefined
        || exactProductRawHeader(request, "if-modified-since") !== undefined
        || exactProductRawHeader(request, "if-range") !== undefined) {
        throw new ApiError(
          422,
          "invalid_product_read",
          "Product reads require one unconditional empty request.",
        );
      }
      if (!this.#authorizeProductRead) {
        throw new ApiError(
          403,
          "browser_session_denied",
          "The Product API requires a current browser session.",
        );
      }
      try {
        return Number(this.#authorizeProductRead(request) ?? 0);
      } catch {
        throw new ApiError(
          403,
          "browser_session_denied",
          "The Product API requires a current browser session.",
        );
      }
    }
    if (url.search !== "") {
      throw new ApiError(
        422,
        "invalid_product_mutation",
        "Product mutations do not accept query parameters.",
      );
    }
    const contentLength = exactProductRawHeader(request, "content-length");
    if (exactProductRawHeader(request, "transfer-encoding") !== undefined
      || contentLength === undefined
      || !/^(?:[1-9]\d{0,6})$/u.test(contentLength)
      || Number(contentLength) > 1_600_000) {
      throw new ApiError(
        422,
        "invalid_product_mutation",
        "Product mutations require one bounded JSON body.",
      );
    }
    if (exactProductRawHeader(request, "content-type") !== "application/json") {
      throw new ApiError(
        415,
        "unsupported_media_type",
        "Product mutations require exact application/json.",
      );
    }
    if (!this.#authorizeProductMutation) {
      throw new ApiError(
        403,
        "browser_session_denied",
        "The Product API requires a current browser session.",
      );
    }
    try {
      return Number(this.#authorizeProductMutation(request) ?? 0);
    } catch {
      throw new ApiError(
        403,
        "browser_session_denied",
        "The Product API requires a current browser session.",
      );
    }
  }

  #runtimeDeleteBlockers(
    preview: PermanentDeletePreview,
  ): Array<{ kind: string; id: string }> {
    const blockers: Array<{ kind: string; id: string }> = [];
    for (const record of preview.records) {
      if (record.table !== "runs" || typeof record.key.id !== "string") continue;
      if ((this.#activeOutputDownloadsByRun.get(record.key.id) ?? 0) > 0) {
        blockers.push({ kind: "output_download_active", id: record.key.id });
      }
    }
    blockers.push(...(this.#resourceDeleteRuntimeBlockers?.(preview) ?? []));
    return blockers;
  }

  #authorizeOutputRead(request: IncomingMessage, url: URL): void {
    if (url.search !== "") {
      throw new ApiError(422, "invalid_output_request",
        "Output reads do not accept query parameters.");
    }
    const contentLength = exactRawHeader(request, "content-length");
    if (exactRawHeader(request, "transfer-encoding") !== undefined
      || contentLength !== undefined && contentLength !== "0") {
      throw new ApiError(422, "invalid_output_request",
        "Output reads require an empty request body.");
    }
    if (exactRawHeader(request, "if-none-match") !== undefined
      || exactRawHeader(request, "if-modified-since") !== undefined
      || exactRawHeader(request, "if-range") !== undefined) {
      throw new ApiError(422, "invalid_output_request",
        "Conditional output reads are not supported.");
    }
    if (!this.#authorizeProductRead) {
      throw new ApiError(403, "output_access_denied",
        "The output is unavailable outside the browser app session.");
    }
    try {
      this.#authorizeProductRead(request);
    } catch {
      throw new ApiError(403, "output_access_denied",
        "The output is unavailable outside the browser app session.");
    }
  }

  #authorizeRunMutation(request: IncomingMessage, url: URL): void {
    if (url.search !== "") {
      throw new ApiError(
        422,
        "invalid_run_control_request",
        "Run controls do not accept query parameters.",
      );
    }
    const contentLength = exactRunControlRawHeader(request, "content-length");
    if (exactRunControlRawHeader(request, "transfer-encoding") !== undefined
      || contentLength === undefined
      || !/^(?:0|[1-9]\d{0,4})$/u.test(contentLength)) {
      throw new ApiError(
        422,
        "invalid_run_control_request",
        "Run controls require one bounded request body.",
      );
    }
    if (exactRunControlRawHeader(request, "content-type") !== "application/json") {
      throw new ApiError(
        415,
        "unsupported_media_type",
        "Run controls require exact application/json.",
      );
    }
    if (!this.#authorizeProductMutation) {
      throw new ApiError(
        403,
        "run_control_denied",
        "The run control is unavailable outside the current browser app session.",
      );
    }
    try {
      this.#authorizeProductMutation(request);
    } catch {
      throw new ApiError(
        403,
        "run_control_denied",
        "The run control is unavailable outside the current browser app session.",
      );
    }
  }

  #authorizeEventRead(request: IncomingMessage): void {
    const contentLength = exactEventRawHeader(request, "content-length");
    if (exactEventRawHeader(request, "transfer-encoding") !== undefined
      || contentLength !== undefined && contentLength !== "0") {
      throw new ApiError(
        422,
        "invalid_event_request",
        "Diagnostic event reads require an empty request body.",
      );
    }
    if (exactEventRawHeader(request, "if-none-match") !== undefined
      || exactEventRawHeader(request, "if-modified-since") !== undefined
      || exactEventRawHeader(request, "if-range") !== undefined
      || exactEventRawHeader(request, "range") !== undefined) {
      throw new ApiError(
        422,
        "invalid_event_request",
        "Conditional and range diagnostic event reads are not supported.",
      );
    }
    if (!this.#authorizeProductRead) {
      throw new ApiError(
        403,
        "event_access_denied",
        "Diagnostic events are unavailable outside the browser app session.",
      );
    }
    try {
      this.#authorizeProductRead(request);
    } catch {
      throw new ApiError(
        403,
        "event_access_denied",
        "Diagnostic events are unavailable outside the browser app session.",
      );
    }
  }

  #listDiagnosticEvents(
    url: URL,
    projectId: string,
    runId: string,
  ): Readonly<{
    items: readonly unknown[];
    nextCursor: string | null;
    truncated: boolean;
  }> {
    const codec = this.#diagnosticEventCursorCodec;
    if (!codec) {
      throw new ApiError(
        503,
        "event_cursor_unavailable",
        "Diagnostic event pagination is unavailable.",
      );
    }
    const allowed = new Set([
      "cursor",
      "limit",
      "occurredAfter",
      "occurredBefore",
      "sampleIndex",
      "type",
    ]);
    for (const key of url.searchParams.keys()) {
      if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) {
        throw new ApiError(
          422,
          "invalid_event_request",
          "The diagnostic event query is invalid.",
        );
      }
    }
    const limitText = url.searchParams.get("limit");
    const limit = limitText === null ? 50 : Number(limitText);
    if (limitText !== null && (!/^(?:[1-9]|[1-9]\d|100)$/u.test(limitText)
      || !Number.isSafeInteger(limit))) {
      throw new ApiError(
        422,
        "invalid_event_request",
        "The diagnostic event limit is invalid.",
      );
    }
    const sampleText = url.searchParams.get("sampleIndex");
    const sampleIndex = sampleText === null ? null : Number(sampleText);
    if (sampleText !== null
      && (!/^(?:0|[1-9]\d{0,5})$/u.test(sampleText)
        || !Number.isSafeInteger(sampleIndex))) {
      throw new ApiError(
        422,
        "invalid_event_request",
        "The diagnostic event sample filter is invalid.",
      );
    }
    const type = url.searchParams.get("type");
    if (type !== null
      && (!/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u.test(type)
        || Buffer.byteLength(type, "utf8") > 128)) {
      throw new ApiError(
        422,
        "invalid_event_request",
        "The diagnostic event type filter is invalid.",
      );
    }
    let filters;
    try {
      filters = normalizeDiagnosticEventCursorFilters({
        types: type === null ? [] : [type],
        sampleIndexes: sampleIndex === null ? [] : [sampleIndex],
        occurredAtFrom: url.searchParams.get("occurredAfter"),
        occurredAtTo: url.searchParams.get("occurredBefore"),
      });
    } catch {
      throw new ApiError(
        422,
        "invalid_event_request",
        "The diagnostic event filters are invalid.",
      );
    }
    const binding = this.service.diagnosticEventCursorBinding(projectId, runId);
    const context = Object.freeze({
      projectId,
      runId,
      frozenContractDigest: binding.eventSet.executionDescriptionDigest,
      eventSetDigest: binding.eventSet.eventSetDigest,
      lifecycleDigest: binding.lifecycleDigest,
      direction: "forward" as const,
      filters,
      limit,
    });
    const cursor = url.searchParams.get("cursor");
    let afterSequence = -1;
    if (cursor !== null) {
      if (!cursor || cursor.length > 2_048) {
        throw new ApiError(
          422,
          "invalid_event_cursor",
          "The diagnostic event cursor is invalid.",
        );
      }
      try {
        afterSequence = codec.verify(cursor, context).nextSequence;
      } catch (error) {
        if (error instanceof DiagnosticEventCursorError) {
          throw new ApiError(
            422,
            "invalid_event_cursor",
            "The diagnostic event cursor is invalid.",
          );
        }
        throw error;
      }
    }
    const page = this.service.listRunDiagnosticEvents({
      projectId,
      runId,
      afterSequence,
      limit,
      types: filters.types,
      sampleIndexes: filters.sampleIndexes,
      occurredAtFrom: filters.occurredAtFrom,
      occurredAtTo: filters.occurredAtTo,
    });
    if (page.binding.eventSet.eventSetDigest !== binding.eventSet.eventSetDigest
      || page.binding.lifecycleDigest !== binding.lifecycleDigest) {
      throw new ApiError(
        409,
        "event_cursor_stale",
        "The diagnostic event set changed while it was read.",
      );
    }
    const last = page.items.at(-1);
    const nextCursor = page.hasMore && last
      ? codec.issue({ ...context, nextSequence: last.sequence })
      : null;
    return Object.freeze({
      items: page.items,
      nextCursor,
      truncated: page.hasMore,
    });
  }

  #downloadOutput(
    request: IncomingMessage,
    response: ServerResponse,
    projectId: string,
    runId: string,
    outputId: string,
  ): void {
    if (this.#outputDownloadsRevokedRuns.has(runId)) {
      throw new ApiError(
        409,
        "output_not_available",
        "Outputs are unavailable while the run is revoked or trashed.",
      );
    }
    const now = Date.now();
    const cutoff = now - 1_000;
    while (this.#outputDownloadStarts[0] !== undefined
      && this.#outputDownloadStarts[0] <= cutoff) {
      this.#outputDownloadStarts.shift();
    }
    for (const [key, starts] of this.#outputDownloadStartsByRun) {
      while (starts[0] !== undefined && starts[0] <= cutoff) starts.shift();
      if (starts.length === 0) this.#outputDownloadStartsByRun.delete(key);
    }
    const runStarts = this.#outputDownloadStartsByRun.get(runId) ?? [];
    if (this.#outputDownloadStarts.length >= 24 || runStarts.length >= 8
      || !this.#outputDownloadStartsByRun.has(runId)
        && this.#outputDownloadStartsByRun.size >= 256) {
      response.setHeader("retry-after", "1");
      throw new ApiError(429, "output_download_rate_limited",
        "Output download requests are temporarily limited.");
    }
    this.#outputDownloadStarts.push(now);
    runStarts.push(now);
    this.#outputDownloadStartsByRun.set(runId, runStarts);
    if (this.#activeOutputDownloads >= 4) {
      throw new ApiError(503, "output_download_busy",
        "Too many output downloads are active.");
    }
    const runDownloads = this.#activeOutputDownloadsByRun.get(runId) ?? 0;
    if (runDownloads >= 2) {
      throw new ApiError(503, "output_download_busy",
        "Too many output downloads are active for this run.");
    }
    this.#activeOutputDownloads += 1;
    this.#activeOutputDownloadsByRun.set(runId, runDownloads + 1);
    let slotHeld = true;
    let streamTimer: ReturnType<typeof setTimeout> | undefined;
    let opened: ReturnType<AgentWorkspaceService["openRunOutputDownload"]> | undefined;
    let handedOff = false;
    const outputSocket = response.socket;
    let revoke = (): void => {};
    const release = (): void => {
      if (!slotHeld) return;
      slotHeld = false;
      if (streamTimer) clearTimeout(streamTimer);
      opened?.read.close();
      opened = undefined;
      this.#activeOutputDownloads -= 1;
      const remaining = (this.#activeOutputDownloadsByRun.get(runId) ?? 1) - 1;
      if (remaining > 0) this.#activeOutputDownloadsByRun.set(runId, remaining);
      else this.#activeOutputDownloadsByRun.delete(runId);
      const revokers = this.#outputDownloadRevokersByRun.get(runId);
      revokers?.delete(revoke);
      if (revokers?.size === 0) this.#outputDownloadRevokersByRun.delete(runId);
    };
    revoke = (): void => {
      response.destroy();
      outputSocket?.destroy();
      release();
    };
    const revokers = this.#outputDownloadRevokersByRun.get(runId) ?? new Set();
    revokers.add(revoke);
    this.#outputDownloadRevokersByRun.set(runId, revokers);
    try {
      opened = this.service.openRunOutputDownload(projectId, runId, outputId);
      if (this.#outputDownloadsRevokedRuns.has(runId)) {
        throw new ApiError(
          409,
          "output_not_available",
          "Outputs are unavailable while the run is revoked or trashed.",
        );
      }
      let range: Readonly<{ start: number; end: number }> | undefined;
      try {
        range = outputRange(exactRawHeader(request, "range"), opened.read.sizeBytes);
      } catch (error) {
        response.setHeader("content-range", `bytes */${opened.read.sizeBytes}`);
        throw error;
      }
      const start = range?.start ?? 0;
      const end = range?.end ?? Math.max(0, opened.read.sizeBytes - 1);
      const length = range ? end - start + 1 : opened.read.sizeBytes;
      const headers: Record<string, string> = {
        "accept-ranges": "bytes",
        "cache-control": "private, no-store",
        connection: "close",
        "content-disposition": `attachment; filename="${downloadFilename(opened.output.id, opened.output.mediaType)}"`,
        "content-length": String(length),
        "content-security-policy": "sandbox",
        "content-type": safeDownloadMediaType(opened.output.mediaType),
        etag: `"sha256-${opened.output.sha256}"`,
        "x-content-type-options": "nosniff",
      };
      if (range) headers["content-range"] = `bytes ${start}-${end}/${opened.read.sizeBytes}`;
      if (request.method === "HEAD") {
        response.writeHead(range ? 206 : 200, headers);
        response.end();
        release();
        return;
      }
      const stream = opened.read.stream(range);
      const onError = (): void => {
        release();
        response.destroy();
      };
      stream.once("error", onError);
      outputSocket?.once("close", release);
      streamTimer = setTimeout(() => {
        response.destroy();
        outputSocket?.destroy();
        release();
      }, 30_000);
      streamTimer.unref?.();
      response.writeHead(range ? 206 : 200, headers);
      handedOff = true;
      stream.pipe(response);
    } finally {
      if (!handedOff) release();
    }
  }

  #downloadModelFile(
    request: IncomingMessage,
    response: ServerResponse,
    modelId: string,
    fileId: string,
  ): void {
    const opened = this.service.openModelFileDownload(modelId, fileId);
    let handedOff = false;
    const close = (): void => opened.read.close();
    try {
      const headers = {
        "cache-control": "private, no-store",
        "content-disposition": `attachment; filename="${downloadFilename(opened.file.id, opened.file.mediaType)}"`,
        "content-length": String(opened.read.sizeBytes),
        "content-security-policy": "sandbox",
        "content-type": safeDownloadMediaType(opened.file.mediaType),
        etag: `"sha256-${opened.file.sha256}"`,
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      };
      response.writeHead(200, headers);
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      const stream = opened.read.stream();
      stream.once("error", () => {
        close();
        response.destroy();
      });
      response.once("close", close);
      handedOff = true;
      stream.pipe(response);
    } finally {
      if (!handedOff) close();
    }
  }

  #revokeOutputDownloads(runId: string): void {
    this.#outputDownloadsRevokedRuns.add(runId);
    const revokers = [...(this.#outputDownloadRevokersByRun.get(runId) ?? [])];
    for (const revoke of revokers) revoke();
    this.#outputDownloadRevokersByRun.delete(runId);
  }

  #allowOutputDownloads(runId: string): void {
    this.#outputDownloadsRevokedRuns.delete(runId);
  }
}

const exactRawHeader = (
  request: IncomingMessage,
  name: string,
): string | undefined => {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name) {
      values.push(request.rawHeaders[index + 1] ?? "");
    }
  }
  if (values.length > 1) {
    throw new ApiError(422, "invalid_output_request",
      "The output request contains a duplicate header.");
  }
  return values[0];
};

const exactEventRawHeader = (
  request: IncomingMessage,
  name: string,
): string | undefined => {
  try {
    return exactRawHeader(request, name);
  } catch {
    throw new ApiError(422, "invalid_event_request",
      "The diagnostic event request contains a duplicate header.");
  }
};

const exactProductRawHeader = (
  request: IncomingMessage,
  name: string,
): string | undefined => {
  try {
    return exactRawHeader(request, name);
  } catch {
    throw new ApiError(
      422,
      "invalid_product_request",
      "The Product API request contains a duplicate header.",
    );
  }
};

const exactRunControlRawHeader = (
  request: IncomingMessage,
  name: string,
): string | undefined => {
  try {
    return exactRawHeader(request, name);
  } catch {
    throw new ApiError(422, "invalid_run_control_request",
      "The run control request contains a duplicate header.");
  }
};

const outputRange = (
  value: string | undefined,
  size: number,
): Readonly<{ start: number; end: number }> | undefined => {
  if (value === undefined) return undefined;
  if (value.length > 100 || !/^bytes=(?:0|[1-9]\d*)-(?:0|[1-9]\d*)$/u.test(value)) {
    throw new ApiError(416, "range_not_satisfiable",
      "The output byte range is not satisfiable.");
  }
  const [startText, endText] = value.slice(6).split("-");
  const start = Number(startText);
  const end = Number(endText);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
    || start < 0 || end < start || end >= size) {
    throw new ApiError(416, "range_not_satisfiable",
      "The output byte range is not satisfiable.");
  }
  return Object.freeze({ start, end });
};

const safeDownloadMediaType = (value: string): string =>
  new Set([
    "application/json",
    "application/x-ndjson",
    "application/pdf",
    "image/jpeg",
    "image/png",
    "text/csv",
    "text/plain",
  ]).has(value.toLowerCase())
    ? value.toLowerCase()
    : "application/octet-stream";

const downloadFilename = (outputId: string, mediaType: string): string => {
  const extension = new Map([
    ["application/json", "json"],
    ["application/x-ndjson", "ndjson"],
    ["application/pdf", "pdf"],
    ["image/jpeg", "jpg"],
    ["image/png", "png"],
    ["text/csv", "csv"],
    ["text/plain", "txt"],
  ]).get(mediaType.toLowerCase()) ?? "bin";
  const safeId = /^[A-Za-z0-9_-]{3,128}$/u.test(outputId)
    ? outputId
    : "output";
  return `${safeId}.${extension}`;
};

const privateJson = (
  response: ServerResponse,
  status: number,
  payload: unknown,
): void => {
  const bytes = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, {
    "cache-control": "private, no-store",
    "content-length": bytes.byteLength,
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(bytes);
};

const productRoute = (method: string, parts: string[]): boolean => {
  if (parts[0] !== "api") return false;
  if (method === "GET" && parts.length === 2
    && ["home", "models", "projects", "providers", "agents"].includes(parts[1]!)) {
    return true;
  }
  if (method === "POST" && parts.length === 2
    && ["models", "projects", "workspace-bindings"].includes(parts[1]!)) {
    return true;
  }
  if (parts[1] === "workspace-bindings" && parts.length >= 3
    && ["GET", "POST", "PATCH"].includes(method)) return true;
  if (parts[1] === "resources" && parts.length >= 4
    && ["PATCH", "POST"].includes(method)) {
    return true;
  }
  if (parts[1] === "objects" && parts[4] === "conversations"
    && ["GET", "POST"].includes(method)) {
    return true;
  }
  if (parts[1] === "conversations"
    && ["GET", "POST", "PATCH"].includes(method)) {
    return true;
  }
  if (parts[1] === "models" && parts.length >= 4
    && ["GET", "HEAD", "POST"].includes(method)) {
    return true;
  }
  return parts[1] === "projects" && parts.length >= 4
    && ["GET", "HEAD", "POST", "PATCH"].includes(method);
};

const exactQuery = (url: URL, allowed: readonly string[]): void => {
  const allowedSet = new Set(allowed);
  for (const key of url.searchParams.keys()) {
    if (!allowedSet.has(key) || url.searchParams.getAll(key).length !== 1) {
      throw new ApiError(
        422,
        "invalid_product_query",
        "The Product API query is invalid.",
      );
    }
  }
};

const lifecycleQuery = (
  url: URL,
): "active" | "archived" | "trashed" => {
  exactQuery(url, ["lifecycle"]);
  const lifecycle = url.searchParams.get("lifecycle") ?? "active";
  if (!["active", "archived", "trashed"].includes(lifecycle)) {
    throw new ApiError(
      422,
      "invalid_lifecycle_filter",
      "The lifecycle filter is invalid.",
    );
  }
  return lifecycle as "active" | "archived" | "trashed";
};

const publicLifecycleKind = (value: string): ProductLifecycleKind => {
  if (value !== "model" && value !== "project" && value !== "conversation") {
    throw new ApiError(
      422,
      "invalid_resource_kind",
      "The resource kind is invalid.",
    );
  }
  return value;
};

const ownerFromRoute = (kind: string, id: string): ConversationOwner => {
  if (kind !== "model" && kind !== "project") throw new ApiError(422, "invalid_owner", "Conversation owner must be model or project.");
  return { kind, id };
};

const strictJsonBody = async (
  request: IncomingMessage,
  allowed: string[],
  optional: string[] = [],
  maximumBytes = 128_000,
  _rejectDuplicateKeys = false,
): Promise<Record<string, unknown>> => {
  const contentType = String(request.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") throw new ApiError(415, "unsupported_media_type", "Use application/json.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > maximumBytes) throw new ApiError(413, "request_too_large", "The request body is too large.");
    chunks.push(bytes);
  }
  let value: unknown;
  try {
    const text = Buffer.concat(chunks).toString("utf8");
    value = parseCanonicalJsonV2(text);
  }
  catch { throw new ApiError(422, "invalid_json", "The request body must be valid JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(422, "invalid_request", "The request body must be an object.");
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some((key) => !allowed.includes(key))) throw new ApiError(422, "unknown_field", "The request contains an unsupported field.");
  if (allowed.some((key) => !optional.includes(key) && !(key in object))) throw new ApiError(422, "missing_field", "The request is missing a required field.");
  return object;
};

const requiredString = (value: unknown, name: string, allowEmpty = false): string => {
  if (typeof value !== "string") throw new ApiError(422, "invalid_request", `${name} must be text.`);
  if (!allowEmpty && !value) throw new ApiError(422, "invalid_request", `${name} must not be empty.`);
  return value;
};

const requiredInteger = (value: unknown, name: string): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new ApiError(422, "invalid_request", `${name} must be a positive integer.`);
  }
  return Number(value);
};

const workspaceProvider = (value: unknown): { providerId: string; modelId: string } => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(422, "invalid_request", "provider must be an object.");
  }
  const provider = value as Record<string, unknown>;
  if (Object.keys(provider).sort().join("\n") !== "modelId\nproviderId") {
    throw new ApiError(422, "invalid_request", "provider contains unsupported fields.");
  }
  return {
    providerId: requiredString(provider.providerId, "provider.providerId"),
    modelId: requiredString(provider.modelId, "provider.modelId"),
  };
};

const permanentDeleteConfirmation = (value: unknown): {
  action: "permanently_delete";
  kind: ProductLifecycleKind;
  id: string;
  recordCount: number;
  fileCount: number;
  totalBytes: number;
} => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(
      422,
      "invalid_permanent_delete_confirmation",
      "The permanent-delete confirmation is invalid.",
    );
  }
  const confirmation = value as Record<string, unknown>;
  const keys = Object.keys(confirmation).sort();
  if (keys.join("\n") !== [
    "action",
    "fileCount",
    "id",
    "kind",
    "recordCount",
    "totalBytes",
  ].join("\n")
    || confirmation.action !== "permanently_delete"
    || typeof confirmation.id !== "string") {
    throw new ApiError(
      422,
      "invalid_permanent_delete_confirmation",
      "The permanent-delete confirmation is invalid.",
    );
  }
  const kind = publicLifecycleKind(String(confirmation.kind));
  for (const key of ["recordCount", "fileCount", "totalBytes"] as const) {
    if (!Number.isSafeInteger(confirmation[key])
      || Number(confirmation[key]) < 0) {
      throw new ApiError(
        422,
        "invalid_permanent_delete_confirmation",
        "The permanent-delete confirmation is invalid.",
      );
    }
  }
  return {
    action: "permanently_delete",
    kind,
    id: confirmation.id,
    recordCount: Number(confirmation.recordCount),
    fileCount: Number(confirmation.fileCount),
    totalBytes: Number(confirmation.totalBytes),
  };
};

const trashRunConfirmation = (value: unknown): {
  action: "trash_run";
  projectId: string;
  runId: string;
  terminalStatus: "succeeded" | "failed" | "cancelled" | "timed_out";
  terminalClosureDigest: string;
} => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(422, "invalid_request", "The trash confirmation is invalid.");
  }
  const confirmation = value as Record<string, unknown>;
  if (Object.keys(confirmation).sort().join("\n")
      !== [
        "action",
        "projectId",
        "runId",
        "terminalClosureDigest",
        "terminalStatus",
      ].join("\n")
    || confirmation.action !== "trash_run"
    || !["succeeded", "failed", "cancelled", "timed_out"].includes(
      String(confirmation.terminalStatus),
    )) {
    throw new ApiError(422, "invalid_request", "The trash confirmation is invalid.");
  }
  return {
    action: "trash_run",
    projectId: requiredString(confirmation.projectId, "confirmation.projectId"),
    runId: requiredString(confirmation.runId, "confirmation.runId"),
    terminalStatus: confirmation.terminalStatus as
      "succeeded" | "failed" | "cancelled" | "timed_out",
    terminalClosureDigest: requiredString(
      confirmation.terminalClosureDigest,
      "confirmation.terminalClosureDigest",
    ),
  };
};

const visualInteractionConfirmation = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(422, "invalid_visual_interaction_confirmation", "The visual interaction confirmation is invalid.");
  const action = value as Record<string, unknown>;
  if (!new Set(["click", "type", "select"]).has(action.kind)
    || Object.keys(action).some((key) => !["kind", "locator", "value"].includes(key))
    || (action.kind === "click" ? "value" in action : typeof action.value !== "string")) throw new ApiError(422, "invalid_visual_interaction_confirmation", "The visual interaction confirmation is invalid.");
  const locator = action.locator;
  if (!locator || typeof locator !== "object" || Array.isArray(locator)) throw new ApiError(422, "invalid_visual_interaction_confirmation", "The visual interaction confirmation is invalid.");
  const record = locator as Record<string, unknown>;
  const valid = record.kind === "role_name"
    ? Object.keys(record).every((key) => ["kind", "role", "name"].includes(key)) && typeof record.role === "string" && typeof record.name === "string"
    : record.kind === "label"
      ? Object.keys(record).every((key) => ["kind", "label"].includes(key)) && typeof record.label === "string"
      : false;
  if (!valid) throw new ApiError(422, "invalid_visual_interaction_confirmation", "The visual interaction confirmation is invalid.");
  return action;
};

const requiredObject = (value: unknown, name: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(422, "invalid_request", `${name} must be an object.`);
  return value as Record<string, unknown>;
};

const stringArray = (value: unknown, name: string): string[] => {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new ApiError(422, "invalid_request", `${name} must be a text array.`);
  return value;
};

const strictBase64 = (value: unknown): Buffer => {
  if (typeof value !== "string" || !value || value.length > 1_400_000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new ApiError(422, "invalid_attachment", "base64 must be canonical encoded attachment bytes.");
  }
  const bytes = Buffer.from(value, "base64");
  if (!bytes.length || bytes.byteLength > 1_048_576 || bytes.toString("base64") !== value) throw new ApiError(422, "invalid_attachment", "Attachment bytes are empty or too large.");
  return bytes;
};

const publicConversationMessage = (
  message: ConversationMessageDto,
): Readonly<Record<string, unknown>> => {
  const platformCard = message.messageKind === "platform_card"
    ? publicPlatformCard(message.content)
    : undefined;
  const visualInteractionMarker = message.role === "user"
    ? publicVisualInteractionMarker(message.content)
    : undefined;
  return Object.freeze({
    id: message.id,
    ordinal: message.ordinal,
    role: message.role,
    status: message.status,
    messageKind: message.messageKind,
    text: message.role === "tool"
      ? "Tool activity recorded."
      : message.role === "assistant" ? redactPublicRuntimeText(message.text) : message.text,
    ...(platformCard ? { platformCard } : {}),
    ...(visualInteractionMarker ? { visualInteractionMarker } : {}),
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
  });
};

const publicVisualInteractionMarker = (
  value: unknown,
): Readonly<Record<string, unknown>> | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const marker = (value as Record<string, unknown>).visualInteractionConfirmation;
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) return undefined;
  const record = marker as Record<string, unknown>;
  if (record.schemaVersion !== 1
    || !["click", "type", "select"].includes(String(record.actionKind))
    || !["role_name", "label"].includes(String(record.locatorKind))
    || typeof record.actionCommitmentDigest !== "string"
    || !/^[0-9a-f]{64}$/u.test(record.actionCommitmentDigest)
    || !(record.valueDigest === null
      || typeof record.valueDigest === "string"
        && /^[0-9a-f]{64}$/u.test(record.valueDigest))) return undefined;
  return Object.freeze({
    schemaVersion: 1,
    actionKind: record.actionKind,
    locatorKind: record.locatorKind,
    actionCommitmentDigest: record.actionCommitmentDigest,
    valueDigest: record.valueDigest,
  });
};

const publicPlatformCard = (
  value: unknown,
): Readonly<Record<string, unknown>> | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const card = value as Record<string, unknown>;
  const outputIds = card.outputIds;
  if (typeof card.runId !== "string"
    || !["succeeded", "failed", "cancelled", "timed_out"].includes(
      String(card.status),
    )
    || !Number.isSafeInteger(card.sampleCount)
    || Number(card.sampleCount) < 0
    || !Number.isSafeInteger(card.outputCount)
    || Number(card.outputCount) < 0
    || !Array.isArray(outputIds)
    || outputIds.some((id) => typeof id !== "string")
    || Number(card.outputCount) !== outputIds.length) {
    return undefined;
  }
  return Object.freeze({
    runId: card.runId,
    status: card.status,
    sampleCount: card.sampleCount,
    outputCount: card.outputCount,
    outputIds: Object.freeze([...outputIds]),
  });
};

const publicAgentTurn = (
  turn: AgentTurnDto,
  service: AgentWorkspaceService,
): Readonly<Record<string, unknown>> => Object.freeze({
  requestKey: turn.requestKey,
  agentName: turn.agentName,
  state: turn.state,
  userMessageId: turn.userMessageId,
  assistantMessageId: turn.assistantMessageId,
  skillUses: turn.skillUses.map((skill) => Object.freeze({
    id: skill.id,
    skillId: skill.skillId,
    skillVersion: skill.skillVersion,
    routingMode: skill.routingMode,
    loadState: skill.loadState,
  })),
  actions: service.publicActionRecords(turn.actions),
  goalVerification: publicGoalVerification(turn.goalVerification),
  failure: turn.failure,
});

const publicGoalVerification = (
  receipt: AgentTurnDto["goalVerification"],
): Readonly<Record<string, unknown>> | null => receipt
  ? Object.freeze({
      disposition: receipt.disposition,
      reasonCode: receipt.reasonCode,
      receiptDigest: receipt.receiptDigest,
      evidence: Object.freeze({
        openCodeTerminal: receipt.evidence.openCodeTerminal,
        intentKind: receipt.evidence.intentKind,
        actionCount: receipt.evidence.actionCount,
        terminalActionCount: receipt.evidence.terminalActionCount,
        committedActionCount: receipt.evidence.committedActionCount,
        affectedResourceCount: receipt.evidence.affectedResourceCount,
        ownerStateVerified: receipt.evidence.ownerStateVerified,
        partialEffect: receipt.evidence.partialEffect,
      }),
    })
  : null;

const publicConversationRuntime = (
  runtime: ConversationRuntimeDto,
): Readonly<Record<string, unknown>> => {
  const parts: Array<Readonly<Record<string, unknown>>> = [];
  if (runtime.assistant) {
    parts.push(Object.freeze({
      id: `text_${runtime.revision.slice(0, 32)}`,
      kind: runtime.assistant.status === "error" ? "error" : "text",
      state: runtime.assistant.status === "complete"
        ? "complete"
        : runtime.assistant.status === "error" ? "failed" : "streaming",
      title: runtime.assistant.status === "error" ? "Assistant error" : "Assistant",
      summary: runtime.assistant.text || null,
    }));
  }
  for (const tool of runtime.tools) {
    parts.push(Object.freeze({
      id: tool.id,
      kind: tool.status === "completed" || tool.status === "error"
        ? "tool_result"
        : "tool_call",
      state: tool.status === "pending"
        ? "pending"
        : tool.status === "running" ? "streaming"
          : tool.status === "completed" ? "complete" : "failed",
      title: tool.tool,
      summary: tool.title,
    }));
  }
  for (const skill of runtime.activity.skillUses) {
    parts.push(Object.freeze({
      id: skill.id,
      kind: "skill",
      state: skill.loadState === "failed" ? "failed"
        : skill.loadState === "loaded" ? "complete" : "pending",
      title: skill.skillId,
      summary: `${skill.routingMode} · ${skill.skillVersion}`,
    }));
  }
  for (const action of runtime.activity.actions) {
    parts.push(Object.freeze({
      id: action.id,
      kind: "command",
      state: action.state === "failed" || action.state === "denied"
        || action.state === "rolled_back" ? "failed"
        : action.state === "committed" ? "complete" : "pending",
      title: action.actionKind,
      summary: action.errorCode,
    }));
  }
  if (runtime.failure && !runtime.assistant) {
    parts.push(Object.freeze({
      id: `error_${runtime.revision.slice(0, 32)}`,
      kind: "error",
      state: "failed",
      title: "Agent turn failed",
      summary: runtime.failure.code,
    }));
  }
  parts.push(Object.freeze({
    id: `mcp_${runtime.revision.slice(0, 32)}`,
    kind: "mcp",
    state: runtime.scopedMcp.status === "unavailable" ? "failed" : "complete",
    title: runtime.scopedMcp.label,
    summary: runtime.scopedMcp.status,
  }));
  const activeTurn = runtime.activeRequestKey
    ? Object.freeze({
        requestKey: runtime.activeRequestKey,
        canStop: runtime.turnActive && (runtime.status === "busy"
          || runtime.status === "waiting_for_tool"
          || runtime.status === "waiting_for_user"),
        canRetry: !runtime.turnActive
          && runtime.status === "failed"
          && runtime.failure?.retryable === true,
      })
    : null;
  return Object.freeze({
    schemaVersion: 1,
    revision: runtime.revision,
    status: runtime.status,
    activeTurn,
    goalVerification: runtime.goalVerification,
    parts: Object.freeze(parts),
    pendingInteractions: Object.freeze(runtime.interactions.map((interaction) =>
      interaction.kind === "permission"
        ? Object.freeze({
            id: interaction.id,
            kind: "permission",
            title: interaction.title,
            prompt: interaction.permission,
            decisions: Object.freeze(["allow_once", "reject"]),
          })
        : Object.freeze({
            id: interaction.id,
            kind: "question",
            title: interaction.questions[0]?.header ?? "Question",
            questions: Object.freeze(interaction.questions.map((question) => Object.freeze({
              prompt: question.question,
              multiple: question.multiple,
              custom: question.custom,
              choices: Object.freeze(question.options.map((option) => Object.freeze({
                value: option.id,
                label: option.label,
              }))),
            }))),
          }))),
    agent: Object.freeze({
      selectedName: runtime.agent.selected,
      locked: runtime.status === "busy"
        || runtime.status === "waiting_for_tool"
        || runtime.status === "waiting_for_user",
    }),
    mcp: Object.freeze({
      state: runtime.scopedMcp.status,
      label: runtime.scopedMcp.label,
    }),
  });
};

const interactionResponse = (
  body: Record<string, unknown>,
):
  | { kind: "permission"; decision: "once" | "reject" }
  | { kind: "question"; answers: string[][] }
  | { kind: "question"; reject: true } => {
  const keys = Object.keys(body).sort().join("\n");
  if (body.kind === "permission"
    && keys === ["decision", "interactionId", "kind"].join("\n")
    && (body.decision === "once" || body.decision === "allow_once" || body.decision === "reject")) {
    return { kind: "permission", decision: body.decision === "allow_once" ? "once" : body.decision };
  }
  if (body.kind === "question"
    && keys === ["interactionId", "kind", "reject"].join("\n")
    && body.reject === true) {
    return { kind: "question", reject: true };
  }
  if (body.kind === "question"
    && keys === ["answers", "interactionId", "kind"].join("\n")
    && Array.isArray(body.answers)
    && body.answers.length >= 1
    && body.answers.length <= 16
    && body.answers.every((answer) => Array.isArray(answer)
      && answer.length >= 1
      && answer.length <= 32
      && answer.every((value) => typeof value === "string"))) {
    return { kind: "question", answers: body.answers as string[][] };
  }
  throw new ApiError(422, "invalid_interaction_response", "The interaction response is invalid.");
};


const json = (response: ServerResponse, status: number, payload: unknown): void => {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
};

const html = (response: ServerResponse, body: string): void => {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; base-uri 'none'",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
};

const acceptanceHtml = (): string => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Milestone A2 technical acceptance surface</title>
<style>body{font:15px system-ui;max-width:880px;margin:32px auto;padding:0 16px;color:#17202a}fieldset{margin:16px 0;padding:16px}label{display:block;margin:8px 0}input,select,textarea,button{font:inherit;padding:7px;width:100%;box-sizing:border-box}button{width:auto;margin-top:8px}pre{background:#f4f6f7;padding:12px;overflow:auto}.note{color:#566573}</style></head>
<body>
<h1>Milestone A2 technical acceptance surface</h1>
<p class="note">Narrow API proof only. This is not the Milestone A shared product shell.</p>
<section><h2>Provider availability</h2><pre id="providers">Loading…</pre></section>
<fieldset><legend>Create generic Model</legend>
<label>Name<input id="model-name" value="Generic simulation"></label>
<label>Provider/model<select id="provider-model"></select></label>
<button id="create-model">Create Model</button></fieldset>
<fieldset><legend>Conversation turn</legend>
<label>Conversation ID<input id="conversation-id"></label>
<label>Message<textarea id="turn-text">Describe this generic model.</textarea></label>
<button id="send-turn">Send live turn</button></fieldset>
<h2>Result</h2><pre id="result">No action yet.</pre>
<script>
const providers=document.querySelector('#providers'),select=document.querySelector('#provider-model'),result=document.querySelector('#result');
const show=(target,value)=>target.textContent=JSON.stringify(value,null,2);
async function request(url,options){const response=await fetch(url,options);const value=await response.json();show(result,value);return {response,value};}
async function load(){const response=await fetch('/api/providers');const value=await response.json();show(providers,value);select.replaceChildren();for(const item of value.providerModels||[]){const option=document.createElement('option');option.value=item.qualifiedId;option.textContent=item.qualifiedId;select.append(option)}}
document.querySelector('#create-model').onclick=async()=>{const [providerId,...rest]=select.value.split('/');const modelId=rest.join('/');const created=await request('/api/models',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({commandId:crypto.randomUUID(),name:document.querySelector('#model-name').value,providerId,modelId})});if(created.response.ok){document.querySelector('#conversation-id').value=created.value.conversation.id}};
document.querySelector('#send-turn').onclick=()=>request('/api/conversations/'+encodeURIComponent(document.querySelector('#conversation-id').value)+'/turns',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({requestKey:crypto.randomUUID(),text:document.querySelector('#turn-text').value,attachmentIds:[]})});
load().catch(()=>show(providers,{mode:'read_only',reason:'opencode_unavailable'}));
</script></body></html>`;
