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
    changes: { type: "array", minItems: 1, maxItems: 64, items: { type: "object" } },
    executionDescription: { type: "object" },
  }, ["requestKey", "changes"]),
  riff_create_temporary_document: definition("Create a persistent draft document in this conversation.", {
    name: { type: "string" }, mediaType: { type: "string" }, content: { type: "string" },
  }, ["name", "mediaType", "content"]),
  riff_transition_temporary_document: definition("Adopt, reject, or supersede one current-conversation draft document.", {
    documentId: { type: "string" }, transition: { type: "string", enum: ["adopt", "reject", "supersede"] },
  }, ["documentId", "transition"]),
  riff_adopt_attachment: definition("Copy a current-conversation attachment into its bound object with a purpose.", {
    attachmentId: { type: "string" }, purpose: { type: "string" }, logicalName: { type: "string" },
  }, ["attachmentId", "purpose", "logicalName"]),
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
      const input = record(params.arguments ?? {});
      assertToolInputCannotOverrideScope(input);
      validateInput(name, input);
      const result = await this.#executor.execute(grant, name, input);
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

function validateInput(name: AgentToolName, input: Record<string, unknown>): void {
  const allowed: Record<AgentToolName, readonly string[]> = {
    riff_read_owner_summary: [],
    riff_list_model_workspace: [],
    riff_read_model_file: ["fileId"],
    riff_apply_model_changes: ["requestKey", "changes", "executionDescription"],
    riff_create_temporary_document: ["name", "mediaType", "content"],
    riff_transition_temporary_document: ["documentId", "transition"],
    riff_adopt_attachment: ["attachmentId", "purpose", "logicalName"],
  };
  if (Object.keys(input).some((key) => !allowed[name].includes(key))) throw new AgentToolPermissionError("Agent tool input includes an unsupported field.");
  const text = (key: string, maximum: number): void => {
    const value = input[key];
    if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > maximum) throw new AgentToolPermissionError(`Agent tool ${key} is invalid.`);
  };
  if (name === "riff_read_model_file") text("fileId", 256);
  if (name === "riff_apply_model_changes") {
    text("requestKey", 256);
    if (!Array.isArray(input.changes) || input.changes.length < 1 || input.changes.length > 64 || input.changes.some((change) => !change || typeof change !== "object" || Array.isArray(change))) {
      throw new AgentToolPermissionError("Agent model changes are invalid.");
    }
    if (input.executionDescription !== undefined && (!input.executionDescription || typeof input.executionDescription !== "object" || Array.isArray(input.executionDescription))) {
      throw new AgentToolPermissionError("Agent execution description is invalid.");
    }
  }
  if (name === "riff_create_temporary_document") { text("name", 400); text("mediaType", 200); text("content", 1_000_000); }
  if (name === "riff_transition_temporary_document") {
    text("documentId", 256);
    if (!new Set(["adopt", "reject", "supersede"]).has(String(input.transition))) throw new AgentToolPermissionError("Agent document transition is invalid.");
  }
  if (name === "riff_adopt_attachment") { text("attachmentId", 256); text("purpose", 2_000); text("logicalName", 400); }
}

const rpcError = (id: string | number | null, code: number, message: string): RpcResponse => ({ jsonrpc: "2.0", id, error: { code, message } });
