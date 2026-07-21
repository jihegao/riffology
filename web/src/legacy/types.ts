export type Scalar = string | number | boolean;

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

export interface ParameterField {
  key: string;
  label: string;
  type: "number" | "integer" | "boolean" | "string";
  default: Scalar;
  minimum?: number;
  maximum?: number;
  step?: number;
  description?: string;
  required: boolean;
}
export interface ProjectState {
  sessionId: string;
  revision: number;
  phase: ProjectPhase;
  agent?: {
    modelId: string | null;
    status: AgentStatus;
    lastError?: { code: string; message: string };
  };
  uiControl?: {
    intent: "open_tab" | "set_parameter" | "start_run" | "open_results";
    status: "verifying" | "verified" | "failed";
    expectedRevision: number;
    message?: string;
  };
  attachments: Array<{
    id: string;
    displayName: string;
    mediaType: string;
    sizeBytes: number;
    status: "pending" | "ready" | "rejected";
    error?: { code: string; message: string };
  }>;
  conversation: Array<{
    id: string;
    role: "user" | "assistant" | "system";
    text: string;
    attachmentIds?: string[];
    status: "streaming" | "complete" | "failed";
    createdAt: string;
  }>;
  model: null | {
    id: string;
    name: string;
    description: string;
    status: "preparing" | "ready" | "failed";
    parameterSchema: { fields: ParameterField[] };
    parameterValues: Record<string, Scalar>;
    error?: { code: string; message: string };
  };
  run: null | {
    id: string;
    status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out";
    progress: { completedSteps: number; totalSteps: number | null };
    logTail: string[];
    error?: { code: string; message: string };
    startedAt?: string;
    finishedAt?: string;
  };
  results: null | {
    runId: string;
    summary: Array<{ key: string; label: string; value: number | string; unit?: string }>;
    timeSeries: {
      xKey: string;
      xLabel: string;
      series: Array<{ key: string; label: string; values: number[] }>;
    };
    table: {
      columns: Array<{ key: string; label: string }>;
      rows: Array<Record<string, string | number>>;
    };
  };
}

export interface ProjectPatch {
  sessionId: string;
  revision: number;
  operations: JsonPatchOperation[];
}

export interface JsonPatchOperation {
  op: "add" | "replace" | "remove";
  path: string;
  value?: unknown;
}

export type BrowserEvent =
  | { type: "project.snapshot"; data: ProjectState }
  | { type: "project.patch"; data: ProjectPatch }
  | { type: "conversation.delta"; data: { messageId: string; textDelta: string } }
  | { type: "agent.status"; data: ProjectState["agent"] }
  | { type: "connection.status"; data: { status: "connected" | "reconnecting" | "offline" } };

export interface CommandRejected {
  accepted: false;
  error: { code: string; message: string };
}

export interface DemoClient {
  getSnapshot(sessionId: string): Promise<ProjectState>;
  subscribe(sessionId: string, onEvent: (event: BrowserEvent) => void): () => void;
  upload(sessionId: string, baseRevision: number, file: File): Promise<void>;
  removeAttachment(sessionId: string, baseRevision: number, attachmentId: string): Promise<void>;
  sendChat(sessionId: string, baseRevision: number, text: string, attachmentIds: string[]): Promise<void>;
  saveParameters(sessionId: string, baseRevision: number, modelId: string, values: Record<string, Scalar>): Promise<void>;
  startRun(sessionId: string, baseRevision: number, modelId: string, parameters: Record<string, Scalar>): Promise<void>;
  cancelRun(sessionId: string, baseRevision: number, runId: string): Promise<void>;
}
