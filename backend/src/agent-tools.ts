import {
  BROWSER_AGENT_TOOLS,
  isBrowserAgentToolName,
  type BrowserAgentToolName,
} from "./browser-agent-tools.ts";
import { canonicalDigest, canonicalJsonV2 } from "./canonical-json-v2.ts";

export type AgentOwner = { kind: "model" | "project"; id: string };

export const MODEL_AGENT_TOOLS = [
  "riff_read_owner_summary",
  "riff_list_model_workspace",
  "riff_read_model_file",
  "riff_start_model_technical_check",
  "riff_transition_owner_lifecycle",
  "riff_apply_model_changes",
  "riff_propose_model_changes",
  "riff_publish_model_generated_views",
  "riff_create_temporary_document",
  "riff_transition_temporary_document",
  "riff_adopt_attachment",
  ...BROWSER_AGENT_TOOLS,
] as const;

export const PROJECT_AGENT_TOOLS = [
  "riff_read_owner_summary",
  "riff_list_project_workspace",
  "riff_read_project_file",
  "riff_start_project_technical_check",
  "riff_deliver_project_changes",
  "riff_list_experiment_configurations",
  "riff_create_experiment_configuration",
  "riff_update_experiment_configuration",
  "riff_list_runs",
  "riff_start_run",
  "riff_cancel_run",
  "riff_trash_run",
  "riff_restore_run",
  "riff_list_run_outputs",
  "riff_read_run_output",
  "riff_read_run_events",
  "riff_transition_owner_lifecycle",
  "riff_create_analysis_document",
  "riff_transition_temporary_document",
  "riff_adopt_attachment",
  "riff_open_current_visualization",
  "riff_observe_current_visual",
  ...BROWSER_AGENT_TOOLS,
] as const;

export const WORKSPACE_BOOTSTRAP_TOOLS = [
  "riff_bootstrap_list_objects",
  "riff_bootstrap_create_model",
  "riff_bootstrap_create_project",
  "riff_bootstrap_bind_owner",
] as const;

export type WorkspaceBootstrapToolName = typeof WORKSPACE_BOOTSTRAP_TOOLS[number];

export type AgentToolName =
  | (typeof MODEL_AGENT_TOOLS)[number]
  | (typeof PROJECT_AGENT_TOOLS)[number]
  | WorkspaceBootstrapToolName
  | "riff_write_project_files"
  | "riff_start_project_run"
  | "riff_read_project_run_diagnostics"
  | "riff_interact_current_visual"
  | BrowserAgentToolName;

/**
 * Exhaustive positive allowlist for OpenCode 1.18.11's legacy prompt-level
 * tool availability map. Keep this narrower than all observational tools:
 * Bootstrap writes and all Browser/visual authorities never use the
 * compatibility path; only the bootstrap list operation is read-only. A newly
 * added AgentToolName remains unsafe until explicitly reviewed and added here.
 */
export const READ_ONLY_AGENT_TOOLS: ReadonlySet<AgentToolName> = new Set([
  "riff_read_owner_summary",
  "riff_list_model_workspace",
  "riff_read_model_file",
  "riff_list_project_workspace",
  "riff_read_project_file",
  "riff_open_current_visualization",
  "riff_list_experiment_configurations",
  "riff_list_runs",
  "riff_list_run_outputs",
  "riff_read_run_output",
  "riff_read_run_events",
  "riff_bootstrap_list_objects",
]);

export const legacyPromptToolsCompatible = (
  tools: readonly AgentToolName[],
): boolean => tools.length > 0
  && tools.every((tool) => READ_ONLY_AGENT_TOOLS.has(tool));

export const CONSEQUENTIAL_AGENT_TOOLS: ReadonlySet<AgentToolName> = new Set([
  "riff_apply_model_changes",
  "riff_start_model_technical_check",
  "riff_start_project_technical_check",
  "riff_deliver_project_changes",
  "riff_create_experiment_configuration",
  "riff_update_experiment_configuration",
  "riff_start_run",
  "riff_cancel_run",
  "riff_trash_run",
  "riff_restore_run",
  "riff_transition_owner_lifecycle",
  "riff_create_analysis_document",
  "riff_transition_temporary_document",
  "riff_adopt_attachment",
]);

export type AgentToolGrant = {
  conversationId: string;
  owner: AgentOwner;
  turnId: string;
  externalSessionGeneration: number;
  allowedTools: ReadonlySet<AgentToolName>;
  operationCommitment: Readonly<{
    tool: AgentToolName;
    digest: string;
  }> | null;
  intentAuthority: "explicit" | "proposal_only";
  attachmentIds: ReadonlySet<string>;
  confirmedVisualInteraction?: import("./agent-visual-authority.ts").VisualAgentOperation;
  expiresAt: number;
};

export interface AgentToolExecutor {
  execute(grant: AgentToolGrant, tool: AgentToolName, input: Readonly<Record<string, unknown>>): Promise<unknown>;
}

export const toolsForOwner = (owner: AgentOwner): ReadonlySet<AgentToolName> => new Set(
  owner.kind === "model" ? MODEL_AGENT_TOOLS : PROJECT_AGENT_TOOLS,
);

export const isAgentToolName = (value: string): value is AgentToolName =>
  (MODEL_AGENT_TOOLS as readonly string[]).includes(value)
  || (PROJECT_AGENT_TOOLS as readonly string[]).includes(value)
  || (WORKSPACE_BOOTSTRAP_TOOLS as readonly string[]).includes(value)
  || value === "riff_write_project_files"
  || value === "riff_start_project_run"
  || value === "riff_read_project_run_diagnostics"
  || value === "riff_interact_current_visual"
  || isBrowserAgentToolName(value);

/** Exact private commitment for one consequential MCP call's raw JSON arguments. */
export const agentToolOperationCommitment = (
  tool: AgentToolName,
  input: Readonly<Record<string, unknown>>,
): Readonly<{ tool: AgentToolName; digest: string }> => {
  if (!CONSEQUENTIAL_AGENT_TOOLS.has(tool)) {
    throw new TypeError("Only consequential Agent tools can be committed.");
  }
  const bytes = canonicalJsonV2(input);
  if (bytes.byteLength > 256_000) {
    throw new TypeError("Agent tool commitment exceeds the bounded input size.");
  }
  return Object.freeze({
    tool,
    digest: canonicalDigest({ schemaVersion: 1, tool, arguments: input }),
  });
};

export const assertToolInputCannotOverrideScope = (input: Readonly<Record<string, unknown>>): void => {
  const forbidden = new Set([
    "capability", "conversationId", "externalSessionRef", "externalSessionGeneration",
    "cookie", "frameUrl", "modelId", "nonce", "owner", "ownerId", "ownerKind",
    "path", "port", "projectId", "runId", "selector", "sessionId", "turnId", "url",
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
