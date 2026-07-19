export type ProjectPhase =
  | "idle"
  | "uploading"
  | "preparing_model"
  | "model_ready"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out";

export type AgentStatus =
  | "unconfigured"
  | "ready"
  | "thinking"
  | "waiting_for_action"
  | "error";

export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out";

export type Scalar = string | number | boolean;

export type ParameterField = {
  key: string;
  label: string;
  type: "number" | "integer" | "boolean" | "string";
  default: Scalar;
  minimum?: number;
  maximum?: number;
  step?: number;
  description?: string;
  required: boolean;
};

export type ParameterSchema = { fields: ParameterField[]; defaultSteps?: number; maximumSteps?: number };

export type Attachment = {
  id: string;
  displayName: string;
  mediaType: string;
  sizeBytes: number;
  status: "pending" | "ready" | "rejected";
  error?: { code: string; message: string };
};

export type ConversationMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  attachmentIds?: string[];
  status: "streaming" | "complete" | "failed";
  createdAt: string;
};

export type ProjectState = {
  sessionId: string;
  revision: number;
  phase: ProjectPhase;
  agent?: {
    modelId: string | null;
    status: AgentStatus;
    lastError?: { code: string; message: string };
  };
  /**
   * A browser-control observation only. It never represents a Mesa/domain
   * result, which is committed before Playwright is asked to mirror it.
   */
  uiControl?: {
    intent: "open_tab" | "set_parameter" | "start_run" | "open_results";
    status: "verifying" | "verified" | "failed";
    expectedRevision: number;
    message?: string;
  };
  attachments: Attachment[];
  conversation: ConversationMessage[];
  model: null | {
    id: string;
    name: string;
    description: string;
    status: "preparing" | "ready" | "failed";
    parameterSchema: ParameterSchema;
    parameterValues: Record<string, Scalar>;
    modelRevision?: string;
    error?: { code: string; message: string };
  };
  run: null | {
    id: string;
    status: RunStatus;
    progress: { completedSteps: number; totalSteps: number | null };
    logTail: string[];
    error?: { code: string; message: string };
    startedAt?: string;
    finishedAt?: string;
  };
  results: null | {
    runId: string;
    summary: Array<{ key: string; label: string; value: number | string; unit?: string }>;
    timeSeries: { xKey: string; xLabel: string; series: Array<{ key: string; label: string; values: number[] }> };
    table: { columns: Array<{ key: string; label: string }>; rows: Array<Record<string, string | number>> };
  };
};

export type UiCommand<T> = {
  commandId: string;
  sessionId: string;
  baseRevision: number;
  payload: T;
};

/** RFC-6902 JSON Patch operation; paths are RFC-6901 JSON Pointers. */
export type JsonPatch =
  | { op: "add" | "replace"; path: string; value: unknown }
  | { op: "remove"; path: string };

export type BrowserEvent =
  | { type: "project.snapshot"; data: ProjectState }
  | { type: "project.patch"; data: { sessionId: string; revision: number; operations: JsonPatch[] } }
  | { type: "conversation.delta"; data: { messageId: string; textDelta: string } }
  | { type: "agent.status"; data: NonNullable<ProjectState["agent"]> }
  | { type: "connection.status"; data: { status: "connected" | "reconnecting" | "offline" } };

export type MesaModel = {
  modelId: string;
  modelRevision: string;
  title: string;
  description?: string;
  parameterSchema: ParameterSchema;
};

export type MesaRun = {
  runId: string;
  status: RunStatus;
  progress?: { completedSteps: number; totalSteps: number | null };
  logTail?: string[];
  error?: { code: string; message: string };
  startedAt?: string;
  finishedAt?: string;
};

export type MesaResults = NonNullable<ProjectState["results"]>;
