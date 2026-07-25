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
  name: string;
  lifecycleState: LifecycleState;
  provider: Readonly<{
    providerId: string;
    modelId: string;
    locked: boolean;
  }>;
  sessionState: "none" | "connecting" | "available" | "lost" | "read_only";
  updatedAt: string;
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
