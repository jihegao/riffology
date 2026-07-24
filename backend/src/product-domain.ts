export const PRODUCT_SCHEMA_VERSION = 3 as const;

export type ProductId = string;
export type IsoTimestamp = string;
export type Sha256Digest = string;

export type LifecycleState = "active" | "archived" | "trashed";
export type RestorableLifecycleState = Exclude<LifecycleState, "trashed">;
export type ManagedResourceKind = "model" | "project" | "conversation" | "temporary_document" | "experiment" | "run";
export type NamedManagedResourceKind = Exclude<ManagedResourceKind, "run">;
export type ModelTechnicalStatus = "draft" | "checking" | "executable" | "failed";
export type ModelRunMode = "visual" | "batch" | "both";
export type ConversationProviderBinding = {
  providerId: string;
  providerModelId: string;
  providerLockedAt: IsoTimestamp | null;
  externalSessionRef: string | null;
};
export type MessageRole = "user" | "assistant" | "system" | "tool";
export type MessageStatus = "streaming" | "complete" | "failed";
export type TemporaryDocumentState = "draft" | "adopted" | "rejected" | "superseded";
export type RunStatus = "configured" | "queued" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out" | "trashed";
export type ObjectFileKind =
  | "model_code"
  | "model_environment"
  | "model_visual_asset"
  | "conversation_attachment"
  | "adopted_attachment"
  | "project_model_snapshot"
  | "run_file";

export type ResourceOwner =
  | { kind: "model"; id: ProductId }
  | { kind: "project"; id: ProductId }
  | { kind: "conversation"; id: ProductId }
  | { kind: "run"; id: ProductId };

export type StoredObjectMetadata = {
  id: ProductId;
  owner: ResourceOwner;
  kind: ObjectFileKind;
  relativePath: string;
  mediaType: string;
  sizeBytes: number;
  sha256: Sha256Digest;
  sourceAttachmentId: ProductId | null;
  adoptionPurpose: string | null;
  createdAt: IsoTimestamp;
};

export type ModelRecord = {
  id: ProductId;
  name: string;
  lifecycleState: LifecycleState;
  technicalStatus: ModelTechnicalStatus;
  runMode: ModelRunMode;
  executionDescription: Record<string, unknown>;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  archivedAt: IsoTimestamp | null;
  trashedAt: IsoTimestamp | null;
};

export type ProjectRecord = {
  id: ProductId;
  name: string;
  lifecycleState: LifecycleState;
  sourceModelId: ProductId;
  modelSnapshotDigest: Sha256Digest;
  executionDescription: Record<string, unknown>;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  archivedAt: IsoTimestamp | null;
  trashedAt: IsoTimestamp | null;
};

export type ProjectSnapshotFile = StoredObjectMetadata & {
  owner: Extract<ResourceOwner, { kind: "project" }>;
  kind: "project_model_snapshot";
};

export type ExperimentConfigurationRecord = {
  id: ProductId;
  projectId: ProductId;
  name: string;
  configuration: Record<string, unknown>;
  estimatedSampleCount: number;
  lifecycleState: LifecycleState;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
};

export type RunRecord = {
  id: ProductId;
  projectId: ProductId;
  experimentConfigurationId: ProductId;
  status: RunStatus;
  frozenConfiguration: Record<string, unknown>;
  requestedSampleCount: number;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  startedAt: IsoTimestamp | null;
  finishedAt: IsoTimestamp | null;
};

export type OutputIndexRecord = {
  id: ProductId;
  runId: ProductId;
  logicalName: string;
  outputType: string;
  file: StoredObjectMetadata;
  createdAt: IsoTimestamp;
};

/**
 * Stage 1 store primitive. Implementations must copy bytes, never retain paths
 * into the source model, and commit the project, file rows and bytes as one
 * recoverable mixed database/filesystem mutation.
 */
export type CreateProjectFromModelInput = {
  projectId: ProductId;
  projectName: string;
  sourceModelId: ProductId;
  createdAt: IsoTimestamp;
};

export type PermanentDeletePreview = {
  target: { kind: ManagedResourceKind; id: ProductId };
  records: Array<{ table: string; key: Readonly<Record<string, string | number>> }>;
  files: StoredObjectMetadata[];
  totalBytes: number;
  blockingReferences: Array<{ kind: string; id: ProductId }>;
  exclusions: Array<{ kind: string; id: ProductId; reason: string }>;
  /** Digest of the canonical, deterministically ordered preview payload. */
  previewToken: Sha256Digest;
  /** Digest of target and dependency state, used to reject stale previews. */
  stateToken: Sha256Digest;
};
