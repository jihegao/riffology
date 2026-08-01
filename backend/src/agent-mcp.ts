import { randomUUID } from "node:crypto";
import {
  AgentToolPermissionError,
  assertToolInputCannotOverrideScope,
  isAgentToolName,
  type AgentOwner,
  type AgentToolExecutor,
  type AgentToolGrant,
  type AgentToolName,
} from "./agent-tools.ts";

type RpcRequest = { jsonrpc?: string; id?: string | number | null; method?: string; params?: unknown };
type RpcResponse = { jsonrpc: "2.0"; id: string | number | null; result?: unknown; error?: { code: number; message: string } };

const DEFINITIONS: Readonly<Record<AgentToolName, { description: string; inputSchema: Record<string, unknown> }>> = {
  riff_read_owner_summary: definition("Read the bounded summary for the conversation's current object.", {}),
  riff_list_model_workspace: definition("List logical files in the bound Model workspace.", {}),
  riff_read_model_file: definition("Read one bounded Model file by its logical file ID.", { fileId: { type: "string" } }, ["fileId"]),
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
  riff_update_experiment_configuration: definition(
    "Apply one explicit, validated, compare-and-set Experiment configuration update.",
    {
      requestKey: { type: "string" },
      configurationId: { type: "string" },
      expectedConfigurationDigest: { type: "string" },
      expectedRecordDigest: { type: "string" },
      name: { type: "string" },
      configuration: { type: "object" },
    },
    [
      "requestKey",
      "configurationId",
      "expectedConfigurationDigest",
      "expectedRecordDigest",
      "configuration",
    ],
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
};

export class AgentMcpServer {
  readonly #grants = new Map<string, AgentToolGrant>();
  readonly #executor: AgentToolExecutor;
  readonly #now: () => number;
  readonly #ttlMs: number;

  constructor(executor: AgentToolExecutor, options: { now?: () => number; ttlMs?: number } = {}) {
    this.#executor = executor;
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? 10 * 60_000;
  }

  grant(input: {
    conversationId: string;
    owner: AgentOwner;
    turnId: string;
    externalSessionGeneration: number;
    allowedTools: ReadonlySet<AgentToolName>;
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
      intentAuthority: input.intentAuthority ?? "proposal_only",
      attachmentIds: new Set(input.attachmentIds ?? []),
      expiresAt: this.#now() + this.#ttlMs,
    });
    return capability;
  }

  revoke(capability: string): void { this.#grants.delete(capability); }

  revokeConversation(conversationId: string): void {
    for (const [capability, grant] of this.#grants) if (grant.conversationId === conversationId) this.#grants.delete(capability);
  }

  revokeSessionGeneration(conversationId: string, generation: number): void {
    for (const [capability, grant] of this.#grants) {
      if (grant.conversationId === conversationId && grant.externalSessionGeneration === generation) this.#grants.delete(capability);
    }
  }

  revokeAll(): void { this.#grants.clear(); }

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
      const input = normalizeToolInput(name, record(params.arguments ?? {}));
      assertToolInputCannotOverrideScope(input);
      validateInput(name, input);
      const result = await this.#executor.execute(grant, name, input);
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
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result) ?? "null" }] } };
    } catch (error) {
      const message = error instanceof AgentToolPermissionError ? error.message : "The scoped Agent action failed.";
      return { jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: JSON.stringify({ error: { code: error instanceof AgentToolPermissionError ? "tool_not_allowed" : "tool_failed", message } }) }] } };
    }
  }

  #activeGrant(capability: string): AgentToolGrant | undefined {
    const grant = this.#grants.get(capability);
    if (grant && grant.expiresAt <= this.#now()) this.#grants.delete(capability);
    return grant && grant.expiresAt > this.#now() ? grant : undefined;
  }
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
  const allowed: Record<AgentToolName, readonly string[]> = {
    riff_read_owner_summary: [],
    riff_list_model_workspace: [],
    riff_read_model_file: ["fileId"],
    riff_apply_model_changes: ["requestKey", "changes", "executionDescription"],
    riff_propose_model_changes: ["requestKey", "changes", "executionDescription"],
    riff_publish_model_generated_views: ["requestKey", "views"],
    riff_list_experiment_configurations: [],
    riff_update_experiment_configuration: [
      "requestKey",
      "configurationId",
      "expectedConfigurationDigest",
      "expectedRecordDigest",
      "name",
      "configuration",
    ],
    riff_create_analysis_document: ["name", "mediaType", "content"],
    riff_create_temporary_document: ["name", "mediaType", "content"],
    riff_transition_temporary_document: ["documentId", "transition"],
    riff_adopt_attachment: ["attachmentId", "purpose", "logicalName"],
    riff_observe_current_visual: ["kind"],
    riff_interact_current_visual: [],
  };
  if (Object.keys(input).some((key) => !allowed[name].includes(key))) throw new AgentToolPermissionError("Agent tool input includes an unsupported field.");
  const text = (key: string, maximum: number): void => {
    const value = input[key];
    if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > maximum) throw new AgentToolPermissionError(`Agent tool ${key} is invalid.`);
  };
  if (name === "riff_read_model_file") text("fileId", 256);
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

const validBoundedPngBase64 = (value: string): boolean => {
  if (value.length > 2_796_208
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    return false;
  }
  const bytes = Buffer.from(value, "base64");
  return bytes.byteLength <= 2 * 1024 * 1024
    && bytes.subarray(0, 8).equals(Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]));
};
