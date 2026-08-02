export type LifecycleState = "active" | "archived" | "trashed";

export type ResourceAction =
  | "open"
  | "rename"
  | "archive"
  | "restore"
  | "trash"
  | "permanent_delete_preview";

type ResourceSummary = Readonly<{
  id: string;
  name: string;
  lifecycleState: LifecycleState;
  recordDigest: string;
  createdAt: string;
  updatedAt: string;
  recentActivityAt: string;
  recentActivityKind: string;
  allowedActions: readonly ResourceAction[];
}>;

export type ModelSummary = ResourceSummary & Readonly<{
  kind: "model";
  technicalStatus: "draft" | "checking" | "executable" | "failed";
  runMode: "batch" | "visual" | "both" | null;
}>;

export type ProjectSummary = ResourceSummary & Readonly<{
  kind: "project";
  sourceModelId: string;
  modelSnapshotDigest: string;
  lastRun: null | Readonly<{
    id: string;
    status: string;
    updatedAt: string;
  }>;
}>;

export type ExecutableModelOption = Readonly<{
  id: string;
  name: string;
  technicalStatus: "executable";
  runMode: "batch" | "visual" | "both";
  updatedAt: string;
  recordDigest: string;
}>;

export type HomeDto = Readonly<{
  schemaVersion: 1;
  generatedAt: string;
  collectionDigest: string;
  models: readonly ModelSummary[];
  projects: readonly ProjectSummary[];
  newProjectModels: readonly ExecutableModelOption[];
  providerAvailability:
    | Readonly<{ mode: "live"; providerModelCount: number }>
    | Readonly<{
      mode: "read_only";
      reason: "opencode_unavailable" | "opencode_auth_failed";
    }>;
}>;

export type ProviderModel = Readonly<{
  providerId: string;
  modelId: string;
  qualifiedId: string;
}>;

export type ProviderDiscovery =
  | Readonly<{ mode: "live"; providerModels: readonly ProviderModel[] }>
  | Readonly<{
    mode: "read_only";
    reason: "opencode_unavailable" | "opencode_auth_failed";
    providerModels: readonly [];
  }>;

export type WorkspaceBinding = Readonly<{
  schemaVersion: 1;
  workspaceKey: string;
  conversation: Readonly<{
    kind: "bootstrap" | "owner";
    id: string;
    name: string;
    provider: Readonly<{ providerId: string; modelId: string }> | null;
  }>;
  owner: Readonly<{ kind: "model" | "project"; id: string }> | null;
  generation: number;
  bindingDigest: string;
  state: "unbound" | "bound" | "recovery_required";
  draft: string;
  provider: Readonly<{ providerId: string; modelId: string }> | null;
  providerMode: "live" | "read_only";
  providerReason: "opencode_unavailable" | "opencode_auth_failed" | null;
  ownerProjection: Readonly<{
    kind: "model" | "project";
    id: string;
    name: string;
    recordDigest: string;
  }> | null;
  bootstrapMessages: readonly Readonly<{
    id: string;
    ordinal: number;
    role: "user" | "assistant" | "system";
    status: "complete" | "failed";
    text: string;
    createdAt: string;
  }>[];
  createdAt: string;
  updatedAt: string;
}>;

export type WorkspaceBindingMutation = Readonly<{
  binding: WorkspaceBinding;
  receipt: Readonly<{ receiptDigest: string; generation: number }>;
}>;

export type WorkspaceBootstrapTurn = Readonly<{
  schemaVersion: 1;
  mode: "live" | "read_only";
  reason: string | null;
  binding: WorkspaceBinding;
  assistantText: string | null;
}>;

export type AgentDiscovery =
  | Readonly<{
    mode: "live";
    agents: readonly Readonly<{
      name: string;
      label: string;
      description: string | null;
    }>[];
  }>
  | Readonly<{
    mode: "read_only";
    reason: string;
    agents: readonly [];
  }>;

export type ConversationSummary = Readonly<{
  id: string;
  owner: Readonly<{ kind: OwnerKind; id: string }>;
  name: string;
  lifecycleState: LifecycleState;
  recordDigest: string;
  provider: Readonly<{
    providerId: string;
    modelId: string;
    locked: boolean;
  }>;
  sessionState: "none" | "connecting" | "available" | "lost" | "read_only";
  updatedAt: string;
}>;

export type BrowserRecoveryState =
  | "ready"
  | "closed"
  | "expired"
  | "disconnected"
  | "unavailable";

export type BrowserSessionDto = Readonly<{
  schemaVersion: 1;
  conversationGeneration: number;
  pageGeneration: number;
  projectedUrl: string | null;
  trustState: "trusted_riff" | "none";
  controlMode: "observer" | "agent" | "human";
  remainingBudget: number | null;
  recoveryState: BrowserRecoveryState;
  canGoBack: boolean;
  canReload: boolean;
  expiresAt: string | null;
}>;

export type BrowserScreenshotDto = Readonly<{
  schemaVersion: 1;
  pageGeneration: number;
  contentType: "image/png";
  pngBase64: string;
}>;

export type ConversationMessage = Readonly<{
  id: string;
  ordinal: number;
  role: "user" | "assistant" | "system" | "tool";
  status: "streaming" | "complete" | "failed";
  messageKind: "conversation" | "platform_card";
  text: string;
  platformCard?: Readonly<{
    runId: string;
    status: "succeeded" | "failed" | "cancelled" | "timed_out";
    sampleCount: number;
    outputCount: number;
    outputIds: readonly string[];
  }>;
  visualInteractionMarker?: Readonly<{
    schemaVersion: 1;
    actionKind: "click" | "type" | "select";
    locatorKind: "role_name" | "label";
    actionCommitmentDigest: string;
    valueDigest: string | null;
  }>;
  createdAt: string;
  updatedAt: string;
}>;

export type ConversationAttachment = Readonly<{
  id: string;
  originalName: string;
  purpose: string | null;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
}>;

export type TemporaryDocumentCard = Readonly<{
  id: string;
  sourceMessageId: string | null;
  name: string;
  documentState: "draft" | "adopted" | "rejected" | "superseded";
  mediaType: string;
  lifecycleState: LifecycleState;
  createdAt: string;
  updatedAt: string;
}>;

export type SkillUse = Readonly<{
  id: string;
  skillId: string;
  skillVersion: string;
  routingMode: "explicit" | "automatic";
  loadState: "selected" | "loaded" | "failed";
}>;

export type DirectMutationReceipt = Readonly<{
  operation: "direct_apply";
  receiptDigest: string;
  beforeWorkspaceDigest: string;
  afterWorkspaceDigest: string;
  committedAt: string;
  files: readonly Readonly<{
    relativePath: string;
    priorSha256: string | null;
    proposedSha256: string;
  }>[];
}>;

export type ActionRecord = Readonly<{
  id: string;
  actionKind: string;
  permissionDecision: "pending" | "allowed" | "denied";
  state: "proposed" | "authorized" | "staging" | "committed" | "denied" | "rolled_back" | "failed";
  errorCode: string | null;
  mutationReceipt?: DirectMutationReceipt;
}>;

export type ConversationRuntimeStatus =
  | "busy"
  | "waiting_for_tool"
  | "waiting_for_user"
  | "idle"
  | "failed";

export type ConversationRuntimePart = Readonly<{
  id: string;
  kind: "text" | "tool_call" | "tool_result" | "error" | "command" | "skill" | "mcp";
  state: "streaming" | "pending" | "complete" | "failed";
  title: string;
  summary: string | null;
}>;

export type AgentGoalDisposition =
  | "completed"
  | "needs_user_input"
  | "failed"
  | "read_only"
  | "outcome_unknown"
  | "budget_exhausted";

export type AgentGoalVerification = Readonly<{
  disposition: AgentGoalDisposition;
  reasonCode: string;
  receiptDigest: string;
  evidence: Readonly<{
    openCodeTerminal: "idle" | "not_reached" | "unknown";
    intentKind: "response_delivery" | "explicit_mutation" | "model_visual";
    actionCount: number;
    terminalActionCount: number;
    committedActionCount: number;
    affectedResourceCount: number;
    ownerStateVerified: boolean;
    partialEffect: boolean;
  }>;
}>;

export type ConversationInteraction =
  | Readonly<{
    id: string;
    kind: "permission";
    title: string;
    prompt: string;
    decisions: readonly ("allow_once" | "reject")[];
  }>
  | Readonly<{
    id: string;
    kind: "question";
    title: string;
    questions: readonly Readonly<{
      prompt: string;
      multiple: boolean;
      custom: boolean;
      choices: readonly Readonly<{ value: string; label: string }>[];
    }>[];
  }>;

export type ConversationRuntimeProjection = Readonly<{
  schemaVersion: 1;
  revision: string;
  status: ConversationRuntimeStatus;
  activeTurn: null | Readonly<{
    requestKey: string;
    canStop: boolean;
    canRetry: boolean;
  }>;
  parts: readonly ConversationRuntimePart[];
  pendingInteractions: readonly ConversationInteraction[];
  goalVerification: AgentGoalVerification | null;
  agent: Readonly<{
    selectedName: string | null;
    locked: boolean;
  }>;
  mcp: Readonly<{
    state: "connected" | "disconnected" | "unavailable";
    label: string;
  }>;
}>;

export type ConversationBundle = Readonly<{
  conversation: ConversationSummary;
  messages: readonly ConversationMessage[];
  attachments: readonly ConversationAttachment[];
  documents: readonly TemporaryDocumentCard[];
  skillUses: readonly SkillUse[];
  actions: readonly ActionRecord[];
}>;

export type AgentTurnResult = Readonly<{
  mode: "live" | "read_only";
  reason?: string;
  turn: Readonly<{
    requestKey: string;
    state: "queued" | "running" | "complete" | "failed" | "read_only";
    userMessageId: string | null;
    assistantMessageId: string | null;
    skillUses: readonly SkillUse[];
    actions: readonly ActionRecord[];
    goalVerification: AgentGoalVerification | null;
    failure: null | Readonly<{ code: string; retryable: boolean }>;
  }>;
  messages: readonly ConversationMessage[];
}>;

export type ProductLifecycleReceipt = Readonly<{
  schemaVersion: 1;
  commandId: string;
  action: "rename" | "archive" | "restore" | "trash";
  kind: "conversation";
  id: string;
  previousLifecycleState: LifecycleState;
  currentLifecycleState: LifecycleState;
  previousRecordDigest: string;
  currentRecordDigest: string;
  committedAt: string;
  receiptDigest: string;
}>;

export type PermanentDeletePreview = Readonly<{
  schemaVersion: 1;
  action: "permanent_delete_preview";
  target: Readonly<{ kind: "conversation"; id: string }>;
  recordCount: number;
  fileCount: number;
  totalBytes: number;
  blockingReferences: readonly Readonly<{ reasonCode: string; id: string }>[];
  exclusions: readonly Readonly<{ reasonCode: string; id: string }>[];
  previewToken: string;
  stateToken: string;
  confirmationToken: string;
  expiresAt: string;
}>;

export type PermanentDeleteReceipt = Readonly<{
  schemaVersion: 1;
  commandId: string;
  action: "permanently_delete";
  kind: "conversation";
  id: string;
  recordCount: number;
  fileCount: number;
  totalBytes: number;
  committedAt: string;
  receiptDigest: string;
}>;

export type ExecutionDescription = Readonly<{
  schemaVersion: 2;
  runtime: "python";
  runMode: "batch" | "visual" | "both";
  dependencyFile: string;
  inputs: Readonly<{
    schemaProfile: string;
    schema: Record<string, unknown>;
    smoke: Record<string, unknown>;
  }>;
  outputs: readonly Readonly<{
    logicalName: string;
    relativePath: string;
    mediaType: string;
    required: boolean;
    role: "metric" | "table" | "document" | "data" | "diagnostic";
  }>[];
  overview?: Readonly<{
    stepOrHorizonPointer?: string;
    metricNames?: readonly string[];
  }>;
  batch?: Readonly<{
    entryPoint: string;
    protocol: "riff-batch-v1";
    domainEvents?: Readonly<{
      relativePath: string;
      mediaType: "application/x-ndjson";
      role: "diagnostic";
    }>;
  }>;
  visual?: Readonly<{
    entryPoint: string;
    protocol: "riff-visual-v1";
  }>;
  cancellation: Readonly<{ signal: "SIGTERM"; graceMs: number }>;
}>;

export type WorkspaceFile = Readonly<{
  id: string;
  kind?: string;
  relativePath?: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  createdAt?: string;
}>;

export type ProjectWorkspaceFile = Readonly<{
  fileRef: string;
  relativePath: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
  readOnly: true;
}>;

export type GeneratedViewSet = Readonly<{
  sourceWorkspaceDigest: string;
  currentWorkspaceDigest: string;
  setDigest: string;
  freshness: "fresh" | "stale";
  publishedAt: string;
  views: readonly Readonly<{
    id: string;
    title: string;
    position: number;
    rendererKind: string;
    mediaType: string;
    payloadDigest: string;
    sourceFileRefs: readonly string[];
  }>[];
}>;

export type ModelChangeSet = Readonly<{
  id: string;
  baseWorkspaceDigest: string;
  currentWorkspaceDigest: string;
  changeSetDigest: string;
  freshness: "fresh" | "stale";
  state: "pending" | "applied" | "rejected";
  createdAt: string;
  resolvedAt: string | null;
  files: readonly Readonly<{
    itemId: string;
    kind: string;
    relativePath: string;
    mediaType: string;
    priorSha256: string | null;
    proposedSha256: string;
    proposedText: string;
  }>[];
}>;

export type ModelMutationReceipt = Readonly<{
  schemaVersion: 1;
  commandId: string;
  operation: "apply" | "reject" | "direct_apply";
  modelId: string;
  changeSetId: string | null;
  changeSetDigest: string;
  beforeWorkspaceDigest: string;
  afterWorkspaceDigest: string;
  files: readonly Readonly<{
    itemId: string;
    relativePath: string;
    priorSha256: string | null;
    proposedSha256: string;
  }>[];
  committedAt: string;
  receiptDigest: string;
}>;

export type TechnicalCheck = Readonly<{
  id: string;
  modelId: string;
  state: "running" | "passed" | "failed" | "cancelled";
  publication: "pending" | "published" | "superseded";
  capturedWorkspaceDigest: string;
  executionDescriptionDigest: string;
  aggregate: "pending" | "executable" | "failed" | "cancelled";
  checks: readonly Readonly<{
    name: string;
    state: string;
    code: string;
    detail: string;
  }>[];
  startedAt: string;
  finishedAt: string | null;
  claim: "technical_execution_only";
}>;

export type ExperimentConfiguration = Readonly<{
  id: string;
  projectId: string;
  name: string;
  configuration: Record<string, unknown>;
  estimatedSampleCount: number;
  lifecycleState: LifecycleState;
  createdAt: string;
  updatedAt: string;
  contractVersion: 3 | 4;
  readOnly: boolean;
  legacyDigest: string | null;
  configurationDigest?: string;
  sampleCount?: number;
  recordDigest: string | null;
  samplePreview?: readonly Record<string, unknown>[];
  samplePreviewTruncated?: boolean;
}>;

export type RunOutput = Readonly<{
  id: string;
  runId: string;
  logicalName: string;
  outputType: string;
  contractVersion?: 3 | 4;
  readOnly?: boolean;
  legacyDigest?: string | null;
  sampleIndex: number | null;
  sampleId: string | null;
  declaredRole: string | null;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
}>;

export type ProjectRun = Readonly<{
  id: string;
  projectId: string;
  experimentConfigurationId: string;
  status: "queued" | "running" | "cancelling" | "succeeded" | "failed" | "cancelled" | "timed_out" | "trashed";
  requestedSampleCount: number;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  contractVersion: 3 | 4;
  readOnly: boolean;
  legacyDigest: string | null;
  runKind: "batch" | "visual" | null;
  cancelRequestedAt: string | null;
  terminalCode: string | null;
  completionCardDisposition: string | null;
  terminalStatus: "succeeded" | "failed" | "cancelled" | "timed_out" | null;
  terminalClosureDigest: string | null;
  lifecycleDigest: string | null;
  seedCount: number;
  stepOrHorizon: string | number | null;
  durationMs: number | null;
  resourceOverview: Readonly<Record<string, number | boolean>> | null;
  outputs: readonly RunOutput[];
}>;

export type RunDiagnosticEvent = Readonly<{
  sequence: number;
  sampleIndex: number;
  type: string;
  occurredAt: string | null;
  payload: Record<string, unknown> | readonly unknown[];
}>;

export type DiagnosticEventPage = Readonly<{
  items: readonly RunDiagnosticEvent[];
  nextCursor: string | null;
  truncated: boolean;
}>;

type WorkspaceBase<K extends OwnerKind> = Readonly<{
  owner: Readonly<{
    id: string;
    name: string;
    kind: K;
    lifecycleState: LifecycleState;
    technicalStatus?: ModelSummary["technicalStatus"];
  }>;
  conversations: readonly ConversationSummary[];
}>;

export type ModelWorkspaceDto = WorkspaceBase<"model"> & Readonly<{
  digest: string;
  execution: ExecutionDescription;
  files: readonly WorkspaceFile[];
}>;

export type ProjectWorkspaceDto = WorkspaceBase<"project"> & Readonly<{
  sourceModelId: string;
  modelSnapshotDigest: string;
  execution: ExecutionDescription;
  executionDescriptionDigest: string;
  files: readonly ProjectWorkspaceFile[];
  experimentConfigurations: readonly ExperimentConfiguration[];
  runs: readonly ProjectRun[];
}>;

export type WorkspaceDto = ModelWorkspaceDto | ProjectWorkspaceDto;

export type ModelCreationDto = Readonly<{
  model: Readonly<{
    id: string;
    name: string;
    lifecycleState: LifecycleState;
  }>;
  conversation: ConversationSummary;
}>;

export type ProjectCreationDto = Readonly<{
  project: Readonly<{
    id: string;
    name: string;
    lifecycleState: LifecycleState;
  }>;
}>;

export type OwnerKind = "model" | "project";

export type ProductRoute =
  | Readonly<{ page: "home" }>
  | Readonly<{
    page: "workspace";
    kind: OwnerKind;
    id: string;
    conversationId?: string;
  }>
  | Readonly<{ page: "not_found" }>;
