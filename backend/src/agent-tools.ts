export type AgentOwner = { kind: "model" | "project"; id: string };

export const MODEL_AGENT_TOOLS = [
  "riff_read_owner_summary",
  "riff_list_model_workspace",
  "riff_read_model_file",
  "riff_apply_model_changes",
  "riff_create_temporary_document",
  "riff_transition_temporary_document",
  "riff_adopt_attachment",
] as const;

export const PROJECT_AGENT_TOOLS = [
  "riff_read_owner_summary",
  "riff_create_temporary_document",
  "riff_transition_temporary_document",
  "riff_adopt_attachment",
] as const;

export type AgentToolName = (typeof MODEL_AGENT_TOOLS)[number];

export type AgentToolGrant = {
  conversationId: string;
  owner: AgentOwner;
  turnId: string;
  externalSessionGeneration: number;
  allowedTools: ReadonlySet<AgentToolName>;
  intentAuthority: "explicit" | "proposal_only";
  attachmentIds: ReadonlySet<string>;
  expiresAt: number;
};

export interface AgentToolExecutor {
  execute(grant: AgentToolGrant, tool: AgentToolName, input: Readonly<Record<string, unknown>>): Promise<unknown>;
}

export const toolsForOwner = (owner: AgentOwner): ReadonlySet<AgentToolName> => new Set(
  owner.kind === "model" ? MODEL_AGENT_TOOLS : PROJECT_AGENT_TOOLS,
);

export const isAgentToolName = (value: string): value is AgentToolName =>
  (MODEL_AGENT_TOOLS as readonly string[]).includes(value);

export const assertToolInputCannotOverrideScope = (input: Readonly<Record<string, unknown>>): void => {
  const forbidden = new Set([
    "capability", "conversationId", "externalSessionRef", "externalSessionGeneration",
    "modelId", "owner", "ownerId", "ownerKind", "projectId", "sessionId", "turnId",
    "workspace", "workspacePath",
  ]);
  const inspect = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(inspect);
    if (!value || typeof value !== "object") return;
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (forbidden.has(key)) throw new AgentToolPermissionError("Agent tool input cannot override its server-owned scope.");
      inspect(nested);
    }
  };
  inspect(input);
};

export class AgentToolPermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentToolPermissionError";
  }
}
