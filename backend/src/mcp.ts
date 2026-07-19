import { randomUUID } from "node:crypto";
import { ApiError } from "./errors.ts";
import { SimulationActions, type RestrictedAction } from "./simulation-actions.ts";

type JsonRpcRequest = { jsonrpc?: string; id?: string | number | null; method?: string; params?: unknown };
type JsonRpcResponse = { jsonrpc: "2.0"; id: string | number | null; result?: unknown; error?: { code: number; message: string; data?: unknown } };

const tools = [
  tool("riff_inspect_uploaded_files", "Inspect bounded previews of uploaded CSV, JSON, or TXT files.", { type: "object", properties: { uploadIds: { type: "array", items: { type: "string" } } }, additionalProperties: false }),
  tool("riff_select_and_load_model", "Load the only approved bundled Mesa model.", { type: "object", properties: { modelId: { type: "string", enum: ["queue-network-v1"] } }, required: ["modelId"], additionalProperties: false }),
  tool("riff_set_parameters", "Save schema-validated parameters for the active bundled model.", { type: "object", properties: { values: { type: "object" } }, required: ["values"], additionalProperties: false }),
  tool("riff_run_experiment", "Run the active Mesa model with optional documented steps and seeds.", { type: "object", properties: { steps: { type: "integer", minimum: 1 }, seeds: { type: "array", items: { type: "integer" }, minItems: 1, maxItems: 5 } }, additionalProperties: false }),
  tool("riff_get_run_status", "Read status for the active or named project run.", { type: "object", properties: { runId: { type: "string" } }, additionalProperties: false }),
  tool("riff_read_run_results", "Read artifact-backed results for a succeeded run.", { type: "object", properties: { runId: { type: "string" } }, required: ["runId"], additionalProperties: false }),
];

export class McpToolServer {
  readonly #grants = new Map<string, { sessionId: string; expiresAt: number }>();
  private readonly actions: SimulationActions;
  private readonly capabilityTtlMs: number;
  private readonly now: () => number;

  constructor(actions: SimulationActions, options: { capabilityTtlMs?: number; now?: () => number } = {}) {
    this.actions = actions;
    this.capabilityTtlMs = options.capabilityTtlMs ?? 10 * 60_000;
    this.now = options.now ?? Date.now;
  }

  grant(sessionId: string): string {
    const capability = randomUUID();
    this.#grants.set(capability, { sessionId, expiresAt: this.now() + this.capabilityTtlMs });
    return capability;
  }

  revoke(capability: string): void {
    this.#grants.delete(capability);
  }

  revokeSession(sessionId: string): void {
    for (const [capability, grant] of this.#grants) {
      if (grant.sessionId === sessionId) this.#grants.delete(capability);
    }
  }

  revokeAll(): void {
    this.#grants.clear();
  }

  async handle(capability: string | undefined, request: JsonRpcRequest): Promise<JsonRpcResponse | undefined> {
    const id = request.id ?? null;
    if (request.jsonrpc !== "2.0" || typeof request.method !== "string") return rpcError(id, -32600, "Invalid JSON-RPC request.");
    if (request.method === "notifications/initialized") return undefined;
    if (request.method === "initialize") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "riff-simulation-workbench", version: "0.1.0" },
        },
      };
    }
    const grant = capability ? this.#grants.get(capability) : undefined;
    if (grant && grant.expiresAt <= this.now()) this.#grants.delete(capability!);
    const sessionId = grant && grant.expiresAt > this.now() ? grant.sessionId : undefined;
    if (!sessionId) return rpcError(id, -32001, "Unknown or expired local MCP capability.");
    if (request.method === "tools/list") return { jsonrpc: "2.0", id, result: { tools } };
    if (request.method !== "tools/call") return rpcError(id, -32601, "Unsupported MCP method.");
    const call = asObject(request.params);
    const name = typeof call.name === "string" ? call.name : "";
    try {
      const action = parseAction(name, call.arguments);
      const result = await this.actions.execute(sessionId, action);
      return { jsonrpc: "2.0", id, result: toolResult(result) };
    } catch (error) {
      const api = error instanceof ApiError ? error : new ApiError(500, "tool_failed", "The local simulation action failed.");
      return {
        jsonrpc: "2.0",
        id,
        result: { isError: true, content: [{ type: "text", text: JSON.stringify({ error: { code: api.code, message: api.message } }) }] },
      };
    }
  }
}

function tool(name: string, description: string, inputSchema: Record<string, unknown>) {
  return { name, description, inputSchema };
}

const parseAction = (name: string, raw: unknown): RestrictedAction => {
  const input = asObject(raw ?? {});
  rejectProjectFields(input);
  switch (name) {
    case "riff_inspect_uploaded_files":
      assertKeys(input, ["uploadIds"]);
      if (input.uploadIds !== undefined && (!Array.isArray(input.uploadIds) || input.uploadIds.some((value) => typeof value !== "string"))) throw new ApiError(422, "invalid_tool_input", "uploadIds must be an array of attachment IDs.");
      return { name: "inspect_uploaded_files", ...(input.uploadIds ? { uploadIds: input.uploadIds } : {}) };
    case "riff_select_and_load_model":
      assertKeys(input, ["modelId"]);
      if (input.modelId !== "queue-network-v1") throw new ApiError(422, "unsupported_model", "Only queue-network-v1 is available.");
      return { name: "select_and_load_model", modelId: "queue-network-v1" };
    case "riff_set_parameters":
      assertKeys(input, ["values"]);
      return { name: "set_parameters", values: scalarRecord(input.values) };
    case "riff_run_experiment":
      assertKeys(input, ["steps", "seeds"]);
      if (input.steps !== undefined && (!Number.isInteger(input.steps) || Number(input.steps) < 1)) throw new ApiError(422, "invalid_tool_input", "steps must be a positive integer.");
      if (input.seeds !== undefined && (!Array.isArray(input.seeds) || input.seeds.some((value) => !Number.isInteger(value)))) throw new ApiError(422, "invalid_tool_input", "seeds must be integers.");
      return { name: "run_experiment", ...(input.steps !== undefined ? { steps: Number(input.steps) } : {}), ...(input.seeds ? { seeds: input.seeds as number[] } : {}) };
    case "riff_get_run_status":
      assertKeys(input, ["runId"]);
      if (input.runId !== undefined && typeof input.runId !== "string") throw new ApiError(422, "invalid_tool_input", "runId must be text.");
      return { name: "get_run_status", ...(typeof input.runId === "string" ? { runId: input.runId } : {}) };
    case "riff_read_run_results":
      assertKeys(input, ["runId"]);
      if (typeof input.runId !== "string") throw new ApiError(422, "invalid_tool_input", "runId is required.");
      return { name: "read_run_results", runId: input.runId };
    default:
      throw new ApiError(422, "tool_not_allowed", "That OpenCode tool is not available in this demo.");
  }
};

const asObject = (value: unknown): Record<string, any> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(422, "invalid_tool_input", "Tool input must be a JSON object.");
  return value as Record<string, any>;
};
const scalarRecord = (value: unknown): Record<string, string | number | boolean> => {
  const object = asObject(value);
  if (Object.values(object).some((item) => !["string", "number", "boolean"].includes(typeof item))) throw new ApiError(422, "invalid_tool_input", "Parameter values must be scalar JSON values.");
  return object as Record<string, string | number | boolean>;
};
const rejectProjectFields = (input: Record<string, unknown>): void => {
  for (const key of ["projectId", "sessionId", "modelRevision", "workspacePath", "capability"]) {
    if (key in input) throw new ApiError(422, "project_scope_forbidden", "Tool input cannot select a project or workspace.");
  }
};
const assertKeys = (input: Record<string, unknown>, allowed: string[]): void => {
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw new ApiError(422, "invalid_tool_input", "Tool input includes unsupported fields.");
};
// OpenCode 1.17 validates structuredContent as a record. Some approved Riff
// actions intentionally return arrays, so use the portable MCP text content.
const toolResult = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) ?? "null" }] });
const rpcError = (id: string | number | null, code: number, message: string): JsonRpcResponse => ({ jsonrpc: "2.0", id, error: { code, message } });
