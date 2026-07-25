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

export type ActionRecord = Readonly<{
  id: string;
  actionKind: string;
  permissionDecision: "pending" | "allowed" | "denied";
  state: "proposed" | "authorized" | "staging" | "committed" | "denied" | "rolled_back" | "failed";
  errorCode: string | null;
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

export type WorkspaceDto = Readonly<{
  owner: Readonly<{
    id: string;
    name: string;
    kind: "model" | "project";
    lifecycleState: LifecycleState;
    technicalStatus?: ModelSummary["technicalStatus"];
  }>;
  conversations: readonly ConversationSummary[];
}>;

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
