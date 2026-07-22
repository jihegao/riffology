export const PRODUCT_SCHEMA_VERSION = 1 as const;

export type ProductId = string;
export type IsoTimestamp = string;
export type Sha256Digest = string;

export type LifecycleState = "active" | "archived" | "trashed";
export type RestorableLifecycleState = Exclude<LifecycleState, "trashed">;
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

/**
 * Stage 1 store primitive. Implementations must copy bytes, never retain paths
 * into the source model, and commit the project, file rows and bytes as one
 * recoverable mixed database/filesystem mutation.
 */
export type CreateProjectFromModelInput = {
  projectId: ProductId;
  projectName: string;
  sourceModelId: ProductId;
  snapshotFiles: ProjectSnapshotFile[];
  snapshotDigest: Sha256Digest;
  executionDescription: Record<string, unknown>;
  createdAt: IsoTimestamp;
};

export type PermanentDeletePreview = {
  target: { kind: "model" | "project" | "conversation" | "experiment" | "run"; id: ProductId };
  records: Array<{ table: string; id: ProductId }>;
  files: StoredObjectMetadata[];
  totalBytes: number;
  blockingReferences: Array<{ kind: string; id: ProductId }>;
  /** Digest of the canonical, deterministically ordered preview payload. */
  previewToken: Sha256Digest;
  /** Digest of target and dependency state, used to reject stale previews. */
  stateToken: Sha256Digest;
};

export interface ProductRepository {
  createModel(record: ModelRecord): void;
  createProjectFromModel(input: CreateProjectFromModelInput): ProjectRecord;
  listModels(options?: { includeArchived?: boolean; includeTrashed?: boolean }): ModelRecord[];
  listProjects(options?: { includeArchived?: boolean; includeTrashed?: boolean }): ProjectRecord[];
  renameResource(kind: "model" | "project" | "conversation" | "experiment", id: ProductId, name: string, updatedAt: IsoTimestamp): void;
  archiveResource(kind: "model" | "project" | "conversation" | "experiment", id: ProductId, at: IsoTimestamp): void;
  restoreResource(kind: "model" | "project" | "conversation" | "experiment" | "run", id: ProductId, at: IsoTimestamp): void;
  trashResource(kind: "model" | "project" | "conversation" | "experiment" | "run", id: ProductId, at: IsoTimestamp): void;
  previewPermanentDelete(kind: "model" | "project" | "conversation" | "experiment" | "run", id: ProductId): PermanentDeletePreview;
}
