import { randomUUID } from "node:crypto";
import { canonicalDigest } from "./canonical-json-v2.ts";
import {
  AgentToolPermissionError,
  assertToolInputCannotOverrideScope,
  WORKSPACE_BOOTSTRAP_TOOLS,
  type WorkspaceBootstrapToolName,
} from "./agent-tools.ts";

type RpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
};
type RpcResponse = {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
};

export type WorkspaceBootstrapGrant = Readonly<{
  workspaceKey: string;
  conversationId: string;
  generation: number;
  bindingDigest: string;
  turnId: string;
  allowedTools: ReadonlySet<WorkspaceBootstrapToolName>;
  providerRef: string;
  operationCommitmentDigest: string;
  expiresAt: number;
}>;

export interface WorkspaceBootstrapToolExecutor {
  executeWorkspaceBootstrapTool(
    grant: WorkspaceBootstrapGrant,
    tool: WorkspaceBootstrapToolName,
    input: Readonly<Record<string, unknown>>,
  ): Promise<unknown>;
}

const definitions: Readonly<Record<WorkspaceBootstrapToolName, {
  description: string;
  inputSchema: Record<string, unknown>;
}>> = {
  riff_bootstrap_list_objects: definition(
    "List generation-bound opaque Riff objects and provider choices.", {}, [],
  ),
  riff_bootstrap_create_model: mutationDefinition(
    "Create a Model and bind this workspace atomically.",
    { name: { type: "string" } }, ["name"],
  ),
  riff_bootstrap_create_project: mutationDefinition(
    "Create a Project fixed copy and bind this workspace atomically.",
    { name: { type: "string" }, sourceModelRef: { type: "string" } },
    ["name", "sourceModelRef"],
  ),
  riff_bootstrap_bind_owner: mutationDefinition(
    "Bind this workspace to an existing opaque Riff object.",
    { objectRef: { type: "string" } }, ["objectRef"],
  ),
};

export class WorkspaceBootstrapMcpServer {
  readonly #grants = new Map<string, WorkspaceBootstrapGrant>();
  readonly #consumedMutationCapabilities = new Set<string>();
  readonly #executor: WorkspaceBootstrapToolExecutor;
  readonly #now: () => number;
  readonly #ttlMs: number;

  constructor(
    executor: WorkspaceBootstrapToolExecutor,
    options: Readonly<{ now?: () => number; ttlMs?: number }> = {},
  ) {
    this.#executor = executor;
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? 10 * 60_000;
  }

  grant(input: Omit<WorkspaceBootstrapGrant, "expiresAt">): string {
    if (!input.workspaceKey || !input.conversationId || !input.turnId
      || !Number.isSafeInteger(input.generation) || input.generation < 1
      || !/^[0-9a-f]{64}$/u.test(input.bindingDigest)
      || !/^[0-9a-f]{64}$/u.test(input.operationCommitmentDigest)
      || !input.providerRef
      || input.allowedTools.size < 1
      || [...input.allowedTools].some((tool) =>
        !(WORKSPACE_BOOTSTRAP_TOOLS as readonly string[]).includes(tool))) {
      throw new AgentToolPermissionError("Workspace bootstrap capability scope is invalid.");
    }
    const capability = `bootstrap_${randomUUID()}`;
    this.#grants.set(capability, Object.freeze({
      ...input,
      allowedTools: new Set(input.allowedTools),
      expiresAt: this.#now() + this.#ttlMs,
    }));
    return capability;
  }

  has(capability: string | undefined): boolean {
    if (!capability) return false;
    return Boolean(this.#active(capability));
  }

  revoke(capability: string): void {
    this.#grants.delete(capability);
    this.#consumedMutationCapabilities.delete(capability);
  }

  revokeWorkspace(workspaceKey: string): void {
    for (const [capability, grant] of this.#grants) {
      if (grant.workspaceKey === workspaceKey) this.revoke(capability);
    }
  }

  async handle(
    capability: string | undefined,
    request: RpcRequest,
  ): Promise<RpcResponse | undefined> {
    const id = request.id ?? null;
    if (request.jsonrpc !== "2.0" || typeof request.method !== "string") {
      return rpcError(id, -32600, "Invalid JSON-RPC request.");
    }
    if (request.method === "notifications/initialized") return undefined;
    if (request.method === "initialize") return {
      jsonrpc: "2.0", id, result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "riff-workspace-bootstrap", version: "0.1.0" },
      },
    };
    const grant = capability ? this.#active(capability) : undefined;
    if (!grant) return rpcError(id, -32001, "Unknown or expired bootstrap capability.");
    if (request.method === "tools/list") return {
      jsonrpc: "2.0", id, result: {
        tools: [...grant.allowedTools].sort().map((name) => ({ name, ...definitions[name] })),
      },
    };
    if (request.method !== "tools/call") {
      return rpcError(id, -32601, "Unsupported MCP method.");
    }
    try {
      const params = record(request.params);
      const tool = typeof params.name === "string"
        && (WORKSPACE_BOOTSTRAP_TOOLS as readonly string[]).includes(params.name)
        ? params.name as WorkspaceBootstrapToolName : null;
      if (!tool) throw new AgentToolPermissionError("Bootstrap tool is not allowed.");
      if (!grant.allowedTools.has(tool)) {
        throw new AgentToolPermissionError("Bootstrap tool is outside this turn's exact operation commitment.");
      }
      const input = record(params.arguments ?? {});
      assertToolInputCannotOverrideScope(input);
      validate(tool, input, grant);
      if (tool !== "riff_bootstrap_list_objects") {
        if (this.#consumedMutationCapabilities.has(capability!)) {
          throw new AgentToolPermissionError("The bootstrap turn's single mutation has already been consumed.");
        }
        if (workspaceBootstrapOperationCommitment(tool, input)
          !== grant.operationCommitmentDigest) {
          throw new AgentToolPermissionError(
            "Bootstrap mutation parameters differ from this turn's exact commitment.",
          );
        }
        this.#consumedMutationCapabilities.add(capability!);
      }
      const result = await this.#executor.executeWorkspaceBootstrapTool(
        grant, tool, input,
      );
      return {
        jsonrpc: "2.0", id,
        result: { content: [{ type: "text", text: JSON.stringify(result) ?? "null" }] },
      };
    } catch (error) {
      const denied = error instanceof AgentToolPermissionError;
      const budgetExhausted = denied
        && /single mutation has already been consumed/u.test(error.message);
      return {
        jsonrpc: "2.0", id, result: {
          isError: true,
          content: [{ type: "text", text: JSON.stringify({ error: {
            code: budgetExhausted ? "operation_budget_exhausted"
              : denied ? "tool_not_allowed" : "tool_failed",
            message: denied ? error.message : "The workspace bootstrap action failed.",
          } }) }],
        },
      };
    }
  }

  #active(capability: string): WorkspaceBootstrapGrant | undefined {
    const grant = this.#grants.get(capability);
    if (grant && grant.expiresAt <= this.#now()) this.revoke(capability);
    return grant && grant.expiresAt > this.#now() ? grant : undefined;
  }
}

export const workspaceBootstrapOperationCommitment = (
  tool: Exclude<WorkspaceBootstrapToolName, "riff_bootstrap_list_objects">,
  input: Readonly<Record<string, unknown>>,
): string => canonicalDigest({
  schemaVersion: 1,
  tool,
  parameters: {
    providerRef: String(input.providerRef),
    expectedGeneration: Number(input.expectedGeneration),
    expectedBindingDigest: String(input.expectedBindingDigest),
    ...(tool === "riff_bootstrap_create_model"
      ? { name: String(input.name).trim() }
      : tool === "riff_bootstrap_create_project"
        ? {
          name: String(input.name).trim(),
          sourceModelRef: String(input.sourceModelRef),
        }
        : { objectRef: String(input.objectRef) }),
  },
});

function mutationDefinition(
  description: string,
  extra: Record<string, unknown>,
  requiredExtra: string[],
) { return definition(description, {
  requestKey: { type: "string" },
  providerRef: { type: "string" },
  expectedGeneration: { type: "integer", minimum: 1 },
  expectedBindingDigest: { type: "string", pattern: "^[0-9a-f]{64}$" },
  ...extra,
}, ["requestKey", "providerRef", "expectedGeneration",
  "expectedBindingDigest", ...requiredExtra]); }

function definition(
  description: string,
  properties: Record<string, unknown>,
  required: string[],
) {
  return {
    description,
    inputSchema: {
      type: "object",
      properties,
      ...(required.length ? { required } : {}),
      additionalProperties: false,
    },
  };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AgentToolPermissionError("Bootstrap tool input must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

function validate(
  tool: WorkspaceBootstrapToolName,
  input: Record<string, unknown>,
  grant: WorkspaceBootstrapGrant,
): void {
  const allowed: Record<WorkspaceBootstrapToolName, readonly string[]> = {
    riff_bootstrap_list_objects: [],
    riff_bootstrap_create_model: ["requestKey", "name", "providerRef", "expectedGeneration", "expectedBindingDigest"],
    riff_bootstrap_create_project: ["requestKey", "name", "sourceModelRef", "providerRef", "expectedGeneration", "expectedBindingDigest"],
    riff_bootstrap_bind_owner: ["requestKey", "objectRef", "providerRef", "expectedGeneration", "expectedBindingDigest"],
  };
  if (Object.keys(input).some((key) => !allowed[tool].includes(key))) {
    throw new AgentToolPermissionError("Bootstrap tool input includes an unsupported field.");
  }
  if (tool === "riff_bootstrap_list_objects") return;
  if (input.expectedGeneration !== grant.generation
    || input.expectedBindingDigest !== grant.bindingDigest) {
    throw new AgentToolPermissionError("Workspace bootstrap capability is stale.");
  }
  boundedText(input.requestKey, 256, "requestKey");
  boundedText(input.providerRef, 512, "providerRef");
  if (input.providerRef !== grant.providerRef) {
    throw new AgentToolPermissionError("Bootstrap provider differs from the selected WorkspaceBinding provider.");
  }
  if (tool === "riff_bootstrap_create_model"
    || tool === "riff_bootstrap_create_project") boundedText(input.name, 200, "name");
  if (tool === "riff_bootstrap_create_project") boundedText(input.sourceModelRef, 512, "sourceModelRef");
  if (tool === "riff_bootstrap_bind_owner") boundedText(input.objectRef, 512, "objectRef");
}

function boundedText(value: unknown, maximum: number, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()
    || Buffer.byteLength(value, "utf8") > maximum) {
    throw new AgentToolPermissionError(`Bootstrap ${label} is invalid.`);
  }
}

const rpcError = (
  id: string | number | null,
  code: number,
  message: string,
): RpcResponse => ({ jsonrpc: "2.0", id, error: { code, message } });
