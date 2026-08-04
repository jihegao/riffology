import { randomUUID } from "node:crypto";
import {
  AgentToolPermissionError,
  agentToolOperationCommitment,
  assertToolInputCannotOverrideScope,
  CONSEQUENTIAL_AGENT_TOOLS,
  isAgentToolName,
  type AgentOwner,
  type AgentToolExecutor,
  type AgentToolGrant,
  type AgentToolName,
} from "./agent-tools.ts";
import {
  browserAgentOperationCommitment,
  browserAgentToolDefinitions,
  isBrowserAgentToolName,
} from "./browser-agent-tools.ts";

type RpcRequest = { jsonrpc?: string; id?: string | number | null; method?: string; params?: unknown };
type RpcResponse = { jsonrpc: "2.0"; id: string | number | null; result?: unknown; error?: { code: number; message: string } };

const DEFINITIONS: Readonly<Record<AgentToolName, { description: string; inputSchema: Record<string, unknown> }>> = {
  riff_bootstrap_list_objects: definition(
    "List generation-bound opaque Riff objects and provider choices for this unbound workspace.",
    {},
  ),
  riff_bootstrap_create_model: definition(
    "Create a new Model, its owner Conversation, and bind this workspace atomically.",
    {
      requestKey: { type: "string" },
      name: { type: "string" },
      providerRef: { type: "string" },
      expectedGeneration: { type: "integer", minimum: 1 },
      expectedBindingDigest: { type: "string", pattern: "^[0-9a-f]{64}$" },
    },
    ["requestKey", "name", "providerRef", "expectedGeneration", "expectedBindingDigest"],
  ),
  riff_bootstrap_create_project: definition(
    "Create a Project fixed copy from an opaque Model reference, create its owner Conversation, and bind atomically.",
    {
      requestKey: { type: "string" },
      name: { type: "string" },
      sourceModelRef: { type: "string" },
      providerRef: { type: "string" },
      expectedGeneration: { type: "integer", minimum: 1 },
      expectedBindingDigest: { type: "string", pattern: "^[0-9a-f]{64}$" },
    },
    ["requestKey", "name", "sourceModelRef", "providerRef", "expectedGeneration", "expectedBindingDigest"],
  ),
  riff_bootstrap_bind_owner: definition(
    "Bind this workspace to an existing opaque Riff object and create its owner Conversation.",
    {
      requestKey: { type: "string" },
      objectRef: { type: "string" },
      providerRef: { type: "string" },
      expectedGeneration: { type: "integer", minimum: 1 },
      expectedBindingDigest: { type: "string", pattern: "^[0-9a-f]{64}$" },
    },
    ["requestKey", "objectRef", "providerRef", "expectedGeneration", "expectedBindingDigest"],
  ),
  riff_read_owner_summary: definition("Read the bounded summary for the conversation's current object.", {}),
  riff_list_model_workspace: definition("List logical files in the bound Model workspace.", {}),
  riff_read_model_file: definition("Read one bounded Model file by its logical file ID.", { fileId: { type: "string" } }, ["fileId"]),
  riff_start_model_technical_check: definition(
    "Start one receipt-backed technical check for the current Model.",
    { requestKey: { type: "string" } }, ["requestKey"],
  ),
  riff_apply_model_changes: definition("Apply one explicit, validated, atomic Model change set.", {
    requestKey: { type: "string" },
    changes: {
      type: "array",
      minItems: 1,
      maxItems: 64,
      items: {
        type: "object",
        properties: {
          objectFileId: { type: "string" },
          kind: {
            type: "string",
            enum: [
              "model_code",
              "model_environment",
              "model_visual_asset",
            ],
          },
          relativePath: { type: "string" },
          mediaType: { type: "string" },
          text: { type: "string" },
          expectedPriorSha256: {
            anyOf: [
              { type: "string", pattern: "^[0-9a-f]{64}$" },
              { type: "null" },
            ],
          },
        },
        required: [
          "objectFileId",
          "kind",
          "relativePath",
          "mediaType",
          "text",
          "expectedPriorSha256",
        ],
        additionalProperties: false,
      },
    },
    executionDescription: { type: "object" },
  }, ["requestKey", "changes"]),
  riff_propose_model_changes: definition(
    "Create one digest-bound, reviewable Model change set without modifying Model files.",
    {
      requestKey: { type: "string" },
      changes: {
        type: "array",
        minItems: 1,
        maxItems: 64,
        items: {
          type: "object",
          properties: {
            objectFileId: { type: "string" },
            kind: {
              type: "string",
              enum: [
                "model_code",
                "model_environment",
                "model_visual_asset",
              ],
            },
            relativePath: { type: "string" },
            mediaType: { type: "string" },
            text: { type: "string" },
            expectedPriorSha256: {
              anyOf: [
                { type: "string", pattern: "^[0-9a-f]{64}$" },
                { type: "null" },
              ],
            },
          },
          required: [
            "objectFileId",
            "kind",
            "relativePath",
            "mediaType",
            "text",
            "expectedPriorSha256",
          ],
          additionalProperties: false,
        },
      },
      executionDescription: { type: "object" },
    },
    ["requestKey", "changes"],
  ),
  riff_publish_model_generated_views: definition(
    "Atomically replace the current Model's bounded generated-view set. For a graphical class or relationship view, use mediaType application/vnd.riff.diagram+json and a JSON payload with summary, nodes [{id,label}], and edges [{from,to,label?}]. Do not publish SVG or HTML: active content is kept opaque for safety.",
    {
      requestKey: { type: "string" },
      views: {
        type: "array",
        maxItems: 16,
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            mediaType: { type: "string" },
            payload: { type: "string" },
            sourceFileIds: {
              type: "array",
              maxItems: 256,
              items: { type: "string" },
            },
          },
          required: [
            "id",
            "title",
            "mediaType",
            "payload",
            "sourceFileIds",
          ],
          additionalProperties: false,
        },
      },
    },
    ["requestKey", "views"],
  ),
  riff_list_experiment_configurations: definition(
    "List active, digest-bound Experiment configurations for the current Project.",
    {},
  ),
  riff_list_project_workspace: definition(
    "List immutable logical files in the current Project fixed Model copy.", {},
  ),
  riff_read_project_file: definition(
    "Read one bounded Project workspace file by opaque file reference.",
    { fileRef: { type: "string" } }, ["fileRef"],
  ),
  riff_start_project_technical_check: definition(
    "Start one receipt-backed technical check for the current Project workspace digest.",
    {
      requestKey: { type: "string" },
      expectedWorkspaceDigest: { type: "string", pattern: "^[0-9a-f]{64}$" },
    },
    ["requestKey", "expectedWorkspaceDigest"],
  ),
  riff_deliver_project_changes: definition(
    "Perform one authorized Project delivery: atomically write digest-bound workspace changes, reread the resulting digest, run the technical check, and optionally start one Run. A post-write failure is returned with partialEffect=true and an immutable mutation receipt.",
    {
      requestKey: { type: "string" },
      expectedWorkspaceDigest: { type: "string", pattern: "^[0-9a-f]{64}$" },
      changes: {
        type: "array",
        minItems: 1,
        maxItems: 64,
        items: {
          type: "object",
          properties: {
            fileRef: { anyOf: [{ type: "string" }, { type: "null" }] },
            kind: { type: "string", enum: ["code", "environment", "visual_asset"] },
            relativePath: { type: "string" },
            mediaType: { type: "string" },
            text: { type: "string" },
            expectedPriorSha256: {
              anyOf: [
                { type: "string", pattern: "^[0-9a-f]{64}$" },
                { type: "null" },
              ],
            },
          },
          required: [
            "fileRef", "kind", "relativePath", "mediaType", "text",
            "expectedPriorSha256",
          ],
          additionalProperties: false,
        },
      },
      executionDescription: { type: "object" },
      run: {
        type: "object",
        properties: { configurationId: { type: "string" } },
        required: ["configurationId"],
        additionalProperties: false,
      },
    },
    ["requestKey", "expectedWorkspaceDigest", "changes"],
  ),
  riff_create_experiment_configuration: definition(
    "Create one receipt-backed Experiment configuration for the current Project.",
    {
      requestKey: { type: "string" },
      name: { type: "string" },
      configuration: experimentConfigurationSchema(),
    }, ["requestKey", "name", "configuration"],
  ),
  riff_update_experiment_configuration: definition(
    "Apply one explicit, validated, compare-and-set Experiment configuration update.",
    {
      requestKey: { type: "string" },
      configurationId: { type: "string" },
      expectedConfigurationDigest: { type: "string" },
      expectedRecordDigest: { type: "string" },
      name: { type: "string" },
      configuration: experimentConfigurationSchema(),
    },
    [
      "requestKey",
      "configurationId",
      "expectedConfigurationDigest",
      "expectedRecordDigest",
      "configuration",
    ],
  ),
  riff_list_runs: definition(
    "List bounded Run summaries for the current Project using opaque run references.", {},
  ),
  riff_start_run: definition(
    "Start one receipt-backed Run from an active Experiment configuration.",
    { requestKey: { type: "string" }, configurationId: { type: "string" } },
    ["requestKey", "configurationId"],
  ),
  riff_cancel_run: definition(
    "Request cancellation of one current-Project Run by opaque reference.",
    { requestKey: { type: "string" }, runRef: { type: "string" } },
    ["requestKey", "runRef"],
  ),
  riff_trash_run: definition(
    "Move one terminal Run to trash with exact lifecycle and terminal closure evidence.",
    {
      requestKey: { type: "string" }, runRef: { type: "string" },
      expectedLifecycleDigest: { type: "string", pattern: "^[0-9a-f]{64}$" },
      terminalStatus: { type: "string", enum: ["succeeded", "failed", "cancelled", "timed_out"] },
      terminalClosureDigest: { type: "string", pattern: "^[0-9a-f]{64}$" },
    }, ["requestKey", "runRef", "expectedLifecycleDigest", "terminalStatus", "terminalClosureDigest"],
  ),
  riff_restore_run: definition(
    "Restore one trashed Run with an exact lifecycle digest.",
    { requestKey: { type: "string" }, runRef: { type: "string" }, expectedLifecycleDigest: { type: "string", pattern: "^[0-9a-f]{64}$" } },
    ["requestKey", "runRef", "expectedLifecycleDigest"],
  ),
  riff_list_run_outputs: definition(
    "List receipt-indexed outputs for one successful Run.",
    { runRef: { type: "string" } }, ["runRef"],
  ),
  riff_read_run_output: definition(
    "Read one bounded textual Run output by opaque references.",
    { runRef: { type: "string" }, outputRef: { type: "string" } },
    ["runRef", "outputRef"],
  ),
  riff_read_run_events: definition(
    "Read a bounded page of diagnostic events for one Run.",
    { runRef: { type: "string" }, afterSequence: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 200 } },
    ["runRef"],
  ),
  riff_transition_owner_lifecycle: definition(
    "Apply a receipt-backed lifecycle action to the current bound Model or Project.",
    {
      requestKey: { type: "string" },
      action: { type: "string", enum: ["rename", "archive", "trash", "restore"] },
      expectedRecordDigest: { type: "string", pattern: "^[0-9a-f]{64}$" },
      name: { type: "string" },
    }, ["requestKey", "action", "expectedRecordDigest"],
  ),
  riff_create_analysis_document: definition(
    "Create a persistent draft analysis document only after an explicit user request.",
    {
      name: { type: "string" },
      mediaType: { type: "string" },
      content: { type: "string" },
    },
    ["name", "mediaType", "content"],
  ),
  riff_create_temporary_document: definition("Create a persistent draft document in this conversation.", {
    name: { type: "string" }, mediaType: { type: "string" }, content: { type: "string" },
  }, ["name", "mediaType", "content"]),
  riff_transition_temporary_document: definition("Adopt, reject, or supersede one current-conversation draft document.", {
    documentId: { type: "string" }, transition: { type: "string", enum: ["adopt", "reject", "supersede"] },
  }, ["documentId", "transition"]),
  riff_adopt_attachment: definition("Copy a current-conversation attachment into its bound object with a purpose.", {
    attachmentId: { type: "string" }, purpose: { type: "string" }, logicalName: { type: "string" },
  }, ["attachmentId", "purpose", "logicalName"]),
  riff_open_current_visualization: definition(
    "Request the current Project's sole healthy visual service projection. This has no arguments, does not start a Run, and never acquires Browser Agent authority.",
    {},
  ),
  riff_observe_current_visual: definition(
    "Read one bounded, untrusted observation from the current Project's sole healthy visual attempt.",
    {
      kind: {
        type: "string",
        enum: ["structured", "accessibility", "dom_text", "screenshot"],
      },
    },
    ["kind"],
  ),
  riff_interact_current_visual: definition(
    "Perform the single exact visual interaction explicitly confirmed by the human in this turn.",
    {},
  ),
  ...browserAgentToolDefinitions,
};

export class AgentMcpServer {
  readonly #grants = new Map<string, AgentToolGrant>();
  readonly #inFlightConsequential = new Set<string>();
  readonly #consumedConsequential = new Set<string>();
  /**
   * An allow-once commitment may be reached by OpenCode, then rejected before
   * the executor starts because its arguments attempt to override server-owned
   * scope or otherwise fail local validation.  That attempt did not consume a
   * mutation budget.  Remember it so a fresh human approval for corrected,
   * different arguments can replace only that rejected commitment.
   */
  readonly #rejectedBeforeExecutionConsequential = new Set<string>();
  readonly #executor: AgentToolExecutor;
  readonly #now: () => number;
  readonly #ttlMs: number;

  constructor(executor: AgentToolExecutor, options: { now?: () => number; ttlMs?: number } = {}) {
    this.#executor = executor;
    this.#now = options.now ?? Date.now;
    // Large, reviewable payloads (for example a standalone model-design HTML
    // asset) can take several minutes for the provider to construct before the
    // permission card is even presented. Keep the grant bounded, but leave a
    // practical human review window; turn completion/stop still revokes it
    // immediately and consequential authority remains exact-operation-only.
    this.#ttlMs = options.ttlMs ?? 30 * 60_000;
  }

  grant(input: {
    conversationId: string;
    owner: AgentOwner;
    turnId: string;
    externalSessionGeneration: number;
    allowedTools: ReadonlySet<AgentToolName>;
    operationCommitment?: AgentToolGrant["operationCommitment"];
    intentAuthority?: "explicit" | "proposal_only";
    attachmentIds?: ReadonlySet<string>;
    confirmedVisualInteraction?: import("./agent-visual-authority.ts").VisualAgentOperation;
  }): string {
    if (!input.conversationId || !input.owner.id || !input.turnId || !Number.isSafeInteger(input.externalSessionGeneration) || input.externalSessionGeneration < 1) {
      throw new AgentToolPermissionError("Agent capability scope is invalid.");
    }
    const capability = randomUUID();
    this.#grants.set(capability, {
      ...input,
      allowedTools: new Set(input.allowedTools),
      operationCommitment: input.operationCommitment ?? null,
      intentAuthority: input.intentAuthority ?? "proposal_only",
      attachmentIds: new Set(input.attachmentIds ?? []),
      expiresAt: this.#now() + this.#ttlMs,
    });
    return capability;
  }

  revoke(capability: string): void {
    this.#grants.delete(capability);
    this.#inFlightConsequential.delete(capability);
    this.#consumedConsequential.delete(capability);
    this.#rejectedBeforeExecutionConsequential.delete(capability);
  }

  revokeConversation(conversationId: string): void {
    for (const [capability, grant] of this.#grants) if (grant.conversationId === conversationId) this.revoke(capability);
  }

  revokeSessionGeneration(conversationId: string, generation: number): void {
    for (const [capability, grant] of this.#grants) {
      if (grant.conversationId === conversationId && grant.externalSessionGeneration === generation) this.revoke(capability);
    }
  }

  revokeAll(): void {
    this.#grants.clear();
    this.#inFlightConsequential.clear();
    this.#consumedConsequential.clear();
    this.#rejectedBeforeExecutionConsequential.clear();
  }

  authorizeConsequentialOperation(
    capability: string,
    authority: Readonly<{ toolName: AgentToolName; operationCommitment: string }>,
  ): void {
    const grant = this.#activeGrant(capability);
    if (!grant || !grant.allowedTools.has(authority.toolName)
      || !CONSEQUENTIAL_AGENT_TOOLS.has(authority.toolName)
      || !/^[0-9a-f]{64}$/u.test(authority.operationCommitment)
      || this.#consumedConsequential.has(capability)) {
      throw new AgentToolPermissionError(
        "The exact consequential operation cannot be authorized in this scope.",
      );
    }
    if (grant.operationCommitment) {
      if (grant.operationCommitment.tool === authority.toolName
        && grant.operationCommitment.digest === authority.operationCommitment) {
        // A response retry for the identical pending OpenCode permission is
        // safe: it grants neither a different tool nor different arguments.
        // This must remain idempotent so a delayed UI/network retry does not
        // turn the original allow-once into a competing authorization.
        return;
      }
      if (!this.#rejectedBeforeExecutionConsequential.has(capability)) {
        this.revoke(capability);
        throw new AgentToolPermissionError(
          "A competing consequential permission revoked this capability.",
        );
      }
    }
    this.#rejectedBeforeExecutionConsequential.delete(capability);
    grant.operationCommitment = Object.freeze({
      tool: authority.toolName,
      digest: authority.operationCommitment,
    });
  }

  hasActiveConversation(conversationIds: ReadonlySet<string>): boolean {
    const now = this.#now();
    for (const [capability, grant] of this.#grants) {
      if (grant.expiresAt <= now) {
        this.#grants.delete(capability);
        continue;
      }
      if (conversationIds.has(grant.conversationId)) return true;
    }
    return false;
  }

  async handle(capability: string | undefined, request: RpcRequest): Promise<RpcResponse | undefined> {
    const id = request.id ?? null;
    if (request.jsonrpc !== "2.0" || typeof request.method !== "string") return rpcError(id, -32600, "Invalid JSON-RPC request.");
    if (request.method === "notifications/initialized") return undefined;
    if (request.method === "initialize") return { jsonrpc: "2.0", id, result: {
      protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "riff-agent-workspace", version: "0.1.0" },
    } };
    const grant = capability ? this.#activeGrant(capability) : undefined;
    if (!grant) return rpcError(id, -32001, "Unknown or expired local Agent capability.");
    if (request.method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: [...grant.allowedTools].sort().map((name) => ({ name, ...DEFINITIONS[name] })) } };
    if (request.method !== "tools/call") return rpcError(id, -32601, "Unsupported MCP method.");
    try {
      const params = record(request.params);
      const name = typeof params.name === "string" ? params.name : "";
      if (!isAgentToolName(name) || !grant.allowedTools.has(name)) throw new AgentToolPermissionError("That Agent tool is not available in this scope.");
      const rawInput = record(params.arguments ?? {});
      const consequential = CONSEQUENTIAL_AGENT_TOOLS.has(name);
      let consequentialCommitment: Readonly<{ tool: AgentToolName; digest: string }> | null = null;
      if (consequential && this.#consumedConsequential.has(capability!)) {
        throw new AgentToolPermissionError(
          "This turn's single consequential operation has already been consumed.",
        );
      }
      if (consequential) {
        try { consequentialCommitment = agentToolOperationCommitment(name, rawInput); }
        catch { /* stable permission failure below */ }
        if (!consequentialCommitment || grant.operationCommitment?.tool !== name
          || grant.operationCommitment.digest !== consequentialCommitment.digest) {
          throw new AgentToolPermissionError(
            "This exact consequential operation requires allow-once permission.",
          );
        }
      }
      let input: Record<string, unknown>;
      try {
        input = normalizeToolInput(name, rawInput);
        assertToolInputCannotOverrideScope(input);
        validateInput(name, input);
      } catch (error) {
        if (consequential && consequentialCommitment
          && grant.operationCommitment?.tool === consequentialCommitment.tool
          && grant.operationCommitment.digest === consequentialCommitment.digest) {
          this.#rejectedBeforeExecutionConsequential.add(capability!);
        }
        throw error;
      }
      if (consequential) {
        this.#rejectedBeforeExecutionConsequential.delete(capability!);
        this.#inFlightConsequential.add(capability!);
        this.#consumedConsequential.add(capability!);
      }
      let result: unknown;
      try {
        result = await this.#executor.execute(grant, name, input);
      } catch (error) {
        if (consequential) this.#inFlightConsequential.delete(capability!);
        throw error;
      }
      if (consequential) {
        this.#inFlightConsequential.delete(capability!);
      }
      if (name === "riff_observe_current_visual"
        && result
        && typeof result === "object"
        && !Array.isArray(result)
        && (result as Record<string, unknown>).kind === "observe_screenshot") {
        const screenshot = result as Record<string, unknown>;
        if (screenshot.schemaVersion !== 1
          || screenshot.untrusted !== true
          || screenshot.contentType !== "image/png"
          || typeof screenshot.pngBase64 !== "string"
          || !validBoundedPngBase64(screenshot.pngBase64)) {
          throw new Error("Invalid visual screenshot result.");
        }
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  schemaVersion: 1,
                  kind: "observe_screenshot",
                  untrusted: true,
                  contentType: "image/png",
                }),
              },
              {
                type: "image",
                data: screenshot.pngBase64,
                mimeType: "image/png",
              },
            ],
          },
        };
      }
      if (name === "browser_screenshot") {
        const screenshot = result && typeof result === "object" && !Array.isArray(result)
          ? result as Record<string, unknown> : null;
        if (!screenshot
          || Object.keys(screenshot).length !== 4
          || !["schemaVersion", "pageGeneration", "contentType", "pngBase64"]
            .every((key) => Object.hasOwn(screenshot, key))
          || screenshot.schemaVersion !== 1
          || !Number.isSafeInteger(screenshot.pageGeneration)
          || Number(screenshot.pageGeneration) < 0
          || screenshot.contentType !== "image/png"
          || typeof screenshot.pngBase64 !== "string"
          || !validBoundedPngBase64(screenshot.pngBase64, 4 * 1024 * 1024)) {
          throw new Error("Invalid Browser screenshot result.");
        }
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  schemaVersion: 1,
                  kind: "browser_screenshot",
                  pageGeneration: screenshot.pageGeneration,
                  contentType: "image/png",
                }),
              },
              { type: "image", data: screenshot.pngBase64, mimeType: "image/png" },
            ],
          },
        };
      }
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result) ?? "null" }] } };
    } catch (error) {
      const denied = error instanceof AgentToolPermissionError;
      const budgetExhausted = denied
        && /single consequential operation has already been consumed/u.test(error.message);
      const runtimeCode = !denied && error && typeof error === "object"
        && typeof (error as { code?: unknown }).code === "string"
        ? (error as { code: string }).code : null;
      const staleCapability = runtimeCode === "stale_capability"
        || runtimeCode === "scope_changed";
      const safeRuntimeCode = runtimeCode === "no_active_visual_service"
        || runtimeCode === "project_operations_unavailable"
        || runtimeCode === "invalid_tool_input"
        || runtimeCode === "invalid_domain_receipt"
        ? runtimeCode : null;
      const message = denied ? error.message
        : staleCapability ? "The Agent capability no longer matches its active durable scope."
          : safeRuntimeCode === "no_active_visual_service"
            ? "The current Project has no healthy visual service to open."
            : safeRuntimeCode === "project_operations_unavailable"
              ? "Project operations are unavailable in this runtime."
              : safeRuntimeCode === "invalid_tool_input"
                ? "The Project operation input is invalid."
                : safeRuntimeCode === "invalid_domain_receipt"
                  ? "The Project operation receipt could not be verified."
          : "The scoped Agent action failed.";
      return { jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: JSON.stringify({ error: { code: budgetExhausted ? "operation_budget_exhausted" : denied ? "tool_not_allowed" : staleCapability ? "stale_capability" : safeRuntimeCode ?? "tool_failed", message } }) }] } };
    }
  }

  #activeGrant(capability: string): AgentToolGrant | undefined {
    const grant = this.#grants.get(capability);
    if (grant && grant.expiresAt <= this.#now()) this.revoke(capability);
    return grant && grant.expiresAt > this.#now() ? grant : undefined;
  }
}

function experimentConfigurationSchema(): Record<string, unknown> {
  const safeInteger = {
    type: "integer",
    minimum: Number.MIN_SAFE_INTEGER,
    maximum: Number.MAX_SAFE_INTEGER,
  };
  const seeds = {
    type: "array",
    minItems: 1,
    maxItems: 10_000,
    uniqueItems: true,
    items: safeInteger,
  };
  return {
    type: "object",
    properties: {
      schemaVersion: { type: "integer", enum: [1] },
      runKind: { type: "string", enum: ["batch", "visual"] },
      parameters: {
        type: "object",
        maxProperties: 1_024,
        additionalProperties: {},
      },
      sampling: {
        oneOf: [
          {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["single"] },
              seed: safeInteger,
            },
            required: ["kind"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["multiple-seeds"] },
              seeds,
            },
            required: ["kind", "seeds"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["cartesian-sweep"] },
              axes: {
                type: "array",
                minItems: 1,
                maxItems: 128,
                items: {
                  type: "object",
                  properties: {
                    pointer: { type: "string", minLength: 1, maxLength: 1_024 },
                    values: {
                      type: "array",
                      minItems: 1,
                      maxItems: 10_000,
                      items: {},
                    },
                  },
                  required: ["pointer", "values"],
                  additionalProperties: false,
                },
              },
              seeds,
            },
            required: ["kind", "axes"],
            additionalProperties: false,
          },
        ],
      },
    },
    required: ["schemaVersion", "runKind", "parameters", "sampling"],
    additionalProperties: false,
  };
}

function definition(description: string, properties: Record<string, unknown>, required: string[] = []) {
  return { description, inputSchema: { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false } };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AgentToolPermissionError("Agent tool input must be a JSON object.");
  return value as Record<string, unknown>;
}

/**
 * Some OpenCode providers serialize an array-valued tool argument as its JSON
 * text instead of decoding it before forwarding the MCP request. Accept that
 * narrow wire-format variation here, then apply the normal bounded schema
 * validation below. No other field or server-owned scope is reconstructed.
 */
function normalizeToolInput(
  name: AgentToolName,
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (isBrowserAgentToolName(name)) {
    return { ...browserAgentOperationCommitment(name, input).normalized };
  }
  if (name !== "riff_publish_model_generated_views" || typeof input.views !== "string") {
    return input;
  }
  if (Buffer.byteLength(input.views, "utf8") > 16 * 1024 * 1024) {
    throw new AgentToolPermissionError("Agent generated views are invalid.");
  }
  try {
    const views = JSON.parse(input.views) as unknown;
    if (!Array.isArray(views)) throw new Error("views must be an array");
    return { ...input, views };
  } catch {
    throw new AgentToolPermissionError("Agent generated views are invalid.");
  }
}

function validateInput(name: AgentToolName, input: Record<string, unknown>): void {
  if (isBrowserAgentToolName(name)) return;
  const allowed: Partial<Record<AgentToolName, readonly string[]>> = {
    riff_bootstrap_list_objects: [],
    riff_bootstrap_create_model: ["requestKey", "name", "providerRef", "expectedGeneration", "expectedBindingDigest"],
    riff_bootstrap_create_project: ["requestKey", "name", "sourceModelRef", "providerRef", "expectedGeneration", "expectedBindingDigest"],
    riff_bootstrap_bind_owner: ["requestKey", "objectRef", "providerRef", "expectedGeneration", "expectedBindingDigest"],
    riff_read_owner_summary: [],
    riff_list_model_workspace: [],
    riff_read_model_file: ["fileId"],
    riff_start_model_technical_check: ["requestKey"],
    riff_apply_model_changes: ["requestKey", "changes", "executionDescription"],
    riff_propose_model_changes: ["requestKey", "changes", "executionDescription"],
    riff_publish_model_generated_views: ["requestKey", "views"],
    riff_list_experiment_configurations: [],
    riff_list_project_workspace: [],
    riff_read_project_file: ["fileRef"],
    riff_start_project_technical_check: ["requestKey", "expectedWorkspaceDigest"],
    riff_deliver_project_changes: ["requestKey", "expectedWorkspaceDigest", "changes", "executionDescription", "run"],
    riff_create_experiment_configuration: ["requestKey", "name", "configuration"],
    riff_update_experiment_configuration: [
      "requestKey",
      "configurationId",
      "expectedConfigurationDigest",
      "expectedRecordDigest",
      "name",
      "configuration",
    ],
    riff_list_runs: [],
    riff_start_run: ["requestKey", "configurationId"],
    riff_cancel_run: ["requestKey", "runRef"],
    riff_trash_run: ["requestKey", "runRef", "expectedLifecycleDigest", "terminalStatus", "terminalClosureDigest"],
    riff_restore_run: ["requestKey", "runRef", "expectedLifecycleDigest"],
    riff_list_run_outputs: ["runRef"],
    riff_read_run_output: ["runRef", "outputRef"],
    riff_read_run_events: ["runRef", "afterSequence", "limit"],
    riff_transition_owner_lifecycle: ["requestKey", "action", "expectedRecordDigest", "name"],
    riff_create_analysis_document: ["name", "mediaType", "content"],
    riff_create_temporary_document: ["name", "mediaType", "content"],
    riff_transition_temporary_document: ["documentId", "transition"],
    riff_adopt_attachment: ["attachmentId", "purpose", "logicalName"],
    riff_open_current_visualization: [],
    riff_observe_current_visual: ["kind"],
    riff_interact_current_visual: [],
  };
  if (Object.keys(input).some((key) => !allowed[name]!.includes(key))) throw new AgentToolPermissionError("Agent tool input includes an unsupported field.");
  const text = (key: string, maximum: number): void => {
    const value = input[key];
    if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > maximum) throw new AgentToolPermissionError(`Agent tool ${key} is invalid.`);
  };
  if (name.startsWith("riff_bootstrap_")) {
    if (name !== "riff_bootstrap_list_objects") {
      text("requestKey", 256);
      text("providerRef", 512);
      text("expectedBindingDigest", 64);
      if (!Number.isSafeInteger(input.expectedGeneration)
        || Number(input.expectedGeneration) < 1
        || !/^[0-9a-f]{64}$/u.test(String(input.expectedBindingDigest))) {
        throw new AgentToolPermissionError("Workspace bootstrap CAS is invalid.");
      }
    }
    if (name === "riff_bootstrap_create_model"
      || name === "riff_bootstrap_create_project") text("name", 200);
    if (name === "riff_bootstrap_create_project") text("sourceModelRef", 512);
    if (name === "riff_bootstrap_bind_owner") text("objectRef", 512);
    return;
  }
  if (name === "riff_read_model_file") text("fileId", 256);
  if (name === "riff_start_model_technical_check") text("requestKey", 256);
  if (name === "riff_read_project_file") text("fileRef", 256);
  if (name === "riff_start_project_technical_check") {
    text("requestKey", 256); text("expectedWorkspaceDigest", 64);
    if (!/^[0-9a-f]{64}$/u.test(String(input.expectedWorkspaceDigest))) {
      throw new AgentToolPermissionError("Agent Project workspace digest is invalid.");
    }
  }
  if (name === "riff_deliver_project_changes") {
    text("requestKey", 256); text("expectedWorkspaceDigest", 64);
    if (!/^[0-9a-f]{64}$/u.test(String(input.expectedWorkspaceDigest))
      || !Array.isArray(input.changes) || input.changes.length < 1
      || input.changes.length > 64
      || input.changes.some((change) => !change || typeof change !== "object"
        || Array.isArray(change))) {
      throw new AgentToolPermissionError("Agent Project delivery input is invalid.");
    }
    if (input.executionDescription !== undefined
      && (!input.executionDescription || typeof input.executionDescription !== "object"
        || Array.isArray(input.executionDescription))) {
      throw new AgentToolPermissionError("Agent Project execution description is invalid.");
    }
    if (input.run !== undefined) {
      if (!input.run || typeof input.run !== "object" || Array.isArray(input.run)
        || Object.keys(input.run as Record<string, unknown>).some((key) => key !== "configurationId")) {
        throw new AgentToolPermissionError("Agent Project delivery Run input is invalid.");
      }
      const run = input.run as Record<string, unknown>;
      if (typeof run.configurationId !== "string" || !run.configurationId.trim()
        || Buffer.byteLength(run.configurationId) > 256) {
        throw new AgentToolPermissionError("Agent Project delivery Run input is invalid.");
      }
    }
  }
  if (name === "riff_create_experiment_configuration") {
    text("requestKey", 256); text("name", 200);
    if (!input.configuration || typeof input.configuration !== "object"
      || Array.isArray(input.configuration)) {
      throw new AgentToolPermissionError("Agent Experiment configuration is invalid.");
    }
  }
  if (name === "riff_start_run") {
    text("requestKey", 256); text("configurationId", 256);
  }
  if (name === "riff_cancel_run") {
    text("requestKey", 256); text("runRef", 256);
  }
  if (name === "riff_trash_run" || name === "riff_restore_run") {
    text("requestKey", 256); text("runRef", 256);
    text("expectedLifecycleDigest", 64);
    if (!/^[0-9a-f]{64}$/u.test(String(input.expectedLifecycleDigest))) {
      throw new AgentToolPermissionError("Agent Run lifecycle digest is invalid.");
    }
    if (name === "riff_trash_run") {
      text("terminalStatus", 32); text("terminalClosureDigest", 64);
      if (!/^[0-9a-f]{64}$/u.test(String(input.terminalClosureDigest))) {
        throw new AgentToolPermissionError("Agent Run terminal closure is invalid.");
      }
    }
  }
  if (name === "riff_list_run_outputs") text("runRef", 256);
  if (name === "riff_read_run_output") {
    text("runRef", 256); text("outputRef", 256);
  }
  if (name === "riff_read_run_events") {
    text("runRef", 256);
    if (input.afterSequence !== undefined && (!Number.isSafeInteger(input.afterSequence)
      || Number(input.afterSequence) < 0)) throw new AgentToolPermissionError("Agent event cursor is invalid.");
    if (input.limit !== undefined && (!Number.isSafeInteger(input.limit)
      || Number(input.limit) < 1 || Number(input.limit) > 200)) {
      throw new AgentToolPermissionError("Agent event limit is invalid.");
    }
  }
  if (name === "riff_transition_owner_lifecycle") {
    text("requestKey", 256); text("action", 32); text("expectedRecordDigest", 64);
    if (!/^(?:rename|archive|trash|restore)$/u.test(String(input.action))
      || !/^[0-9a-f]{64}$/u.test(String(input.expectedRecordDigest))) {
      throw new AgentToolPermissionError("Agent owner lifecycle input is invalid.");
    }
    if (input.action === "rename") text("name", 200);
    else if (input.name !== undefined) throw new AgentToolPermissionError("Only rename accepts a name.");
  }
  if (name === "riff_apply_model_changes"
    || name === "riff_propose_model_changes") {
    text("requestKey", 256);
    if (!Array.isArray(input.changes) || input.changes.length < 1 || input.changes.length > 64 || input.changes.some((change) => !change || typeof change !== "object" || Array.isArray(change))) {
      throw new AgentToolPermissionError("Agent model changes are invalid.");
    }
    if (input.executionDescription !== undefined && (!input.executionDescription || typeof input.executionDescription !== "object" || Array.isArray(input.executionDescription))) {
      throw new AgentToolPermissionError("Agent execution description is invalid.");
    }
  }
  if (name === "riff_publish_model_generated_views") {
    text("requestKey", 256);
    if (!Array.isArray(input.views) || input.views.length > 16
      || input.views.some((view) => !view || typeof view !== "object"
        || Array.isArray(view))) {
      throw new AgentToolPermissionError("Agent generated views are invalid.");
    }
  }
  if (name === "riff_update_experiment_configuration") {
    text("requestKey", 256);
    text("configurationId", 256);
    text("expectedConfigurationDigest", 64);
    text("expectedRecordDigest", 64);
    if (!/^[0-9a-f]{64}$/u.test(String(input.expectedConfigurationDigest))
      || !/^[0-9a-f]{64}$/u.test(String(input.expectedRecordDigest))) {
      throw new AgentToolPermissionError("Agent Experiment digests are invalid.");
    }
    if (input.name !== undefined) text("name", 200);
    if (!input.configuration || typeof input.configuration !== "object"
      || Array.isArray(input.configuration)) {
      throw new AgentToolPermissionError("Agent Experiment configuration is invalid.");
    }
  }
  if (name === "riff_create_analysis_document") {
    text("name", 400);
    text("mediaType", 200);
    text("content", 1_000_000);
  }
  if (name === "riff_create_temporary_document") { text("name", 400); text("mediaType", 200); text("content", 1_000_000); }
  if (name === "riff_transition_temporary_document") {
    text("documentId", 256);
    if (!new Set(["adopt", "reject", "supersede"]).has(String(input.transition))) throw new AgentToolPermissionError("Agent document transition is invalid.");
  }
  if (name === "riff_adopt_attachment") { text("attachmentId", 256); text("purpose", 2_000); text("logicalName", 400); }
  if (name === "riff_observe_current_visual"
    && !new Set(["structured", "accessibility", "dom_text", "screenshot"]).has(
      String(input.kind),
    )) {
    throw new AgentToolPermissionError("Agent visual observation kind is invalid.");
  }
}

const rpcError = (id: string | number | null, code: number, message: string): RpcResponse => ({ jsonrpc: "2.0", id, error: { code, message } });

const validBoundedPngBase64 = (value: string, maximumBytes = 2 * 1024 * 1024): boolean => {
  if (value.length > Math.ceil(maximumBytes / 3) * 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    return false;
  }
  const bytes = Buffer.from(value, "base64");
  return bytes.byteLength <= maximumBytes
    && bytes.subarray(0, 8).equals(Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]));
};
