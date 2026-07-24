export const PRODUCT_SCHEMA_VERSION = 7 as const;

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
export type ExecutionContractVersion = 3 | 4;
export type RunKind = "batch" | "visual";
export type RunAttemptState = "claimed" | "starting" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out" | "interrupted";
export type ProcessAttemptState = "blocked" | "released" | "running" | "exited" | "cleanup_complete" | "cleanup_unverified";
export type RunCommandKind = "start" | "cancel" | "trash" | "restore";
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

type ExperimentConfigurationRecordBase = {
  id: ProductId;
  projectId: ProductId;
  name: string;
  configuration: Record<string, unknown>;
  estimatedSampleCount: number;
  lifecycleState: LifecycleState;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
};

export type LegacyExecutionContract = {
  contractVersion: 3;
  readOnly: true;
  legacyDigest: Sha256Digest;
};

export type ExperimentConfigurationRecord =
  | (ExperimentConfigurationRecordBase & LegacyExecutionContract)
  | (ExperimentConfigurationRecordBase & {
      contractVersion: 4;
      readOnly: false;
      legacyDigest: null;
      configurationDigest: Sha256Digest;
      sampleCount: number;
    });

type RunRecordBase = {
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

export type RunRecord =
  | (RunRecordBase & LegacyExecutionContract)
  | (RunRecordBase & {
      contractVersion: 4;
      readOnly: false;
      legacyDigest: null;
      runKind: RunKind;
      completionConversationId: ProductId | null;
      executionDescriptionDigest: Sha256Digest;
      projectSnapshotDigest: Sha256Digest;
      frozenConfigurationDigest: Sha256Digest;
      samplePlan: Array<Record<string, unknown>>;
      samplePlanDigest: Sha256Digest;
      limits: Record<string, unknown>;
      limitsDigest: Sha256Digest;
      startReceiptDigest: Sha256Digest;
      cancelRequestedAt: IsoTimestamp | null;
      terminalCode: string | null;
      terminalDiagnostics: unknown;
      resourceOverview: Record<string, unknown> | null;
      completionCardDisposition: "not_requested" | "pending" | "published" | "conversation_unavailable";
    });

type OutputIndexRecordBase = {
  id: ProductId;
  runId: ProductId;
  logicalName: string;
  outputType: string;
  file: StoredObjectMetadata;
  createdAt: IsoTimestamp;
};

export type OutputIndexRecord =
  | (OutputIndexRecordBase & LegacyExecutionContract)
  | (OutputIndexRecordBase & {
      contractVersion: 4;
      readOnly: false;
      legacyDigest: null;
      sampleIndex: number;
      sampleId: Sha256Digest;
      declaredRole: "metric" | "table" | "document" | "data" | "diagnostic";
      outputContractDigest: Sha256Digest;
    });

export type RunAttemptRecord = {
  id: ProductId;
  runId: ProductId;
  attemptGeneration: number;
  dispatcherGeneration: Sha256Digest;
  state: RunAttemptState;
  claimedAt: IsoTimestamp;
  leaseExpiresAt: IsoTimestamp;
  heartbeatAt: IsoTimestamp | null;
  startedAt: IsoTimestamp | null;
  finishedAt: IsoTimestamp | null;
};

export type ProcessAttemptRecord = {
  id: ProductId;
  runAttemptId: ProductId;
  processKind: RunKind;
  sampleIndex: number | null;
  sampleId: Sha256Digest | null;
  pid: number;
  processStartToken: string;
  processGroupId: number;
  state: ProcessAttemptState;
  cleanupReceiptDigest: Sha256Digest | null;
};

export type RunScratchLeaseRecord = {
  id: ProductId;
  runId: ProductId;
  runAttemptId: ProductId;
  dispatcherGeneration: Sha256Digest;
  sampleIndex: number;
  sampleId: Sha256Digest;
  relativePath: string;
  state: "planned" | "created" | "active" | "cleanup_complete" | "cleanup_unverified";
  ownerUid: number | null;
  device: number | null;
  inode: number | null;
  createdAt: IsoTimestamp;
  registeredAt: IsoTimestamp | null;
  cleanedAt: IsoTimestamp | null;
  cleanupReceiptDigest: Sha256Digest | null;
};

export type ProcessLaunchManifestRecord = {
  id: ProductId;
  runAttemptId: ProductId;
  scratchLeaseId: ProductId;
  processAttemptId: ProductId | null;
  state: "planned" | "registered" | "released" | "exited" | "cleanup_complete";
  manifest: Record<string, unknown>;
  manifestDigest: Sha256Digest;
  launchReceipt: Record<string, unknown> | null;
  launchReceiptDigest: Sha256Digest | null;
  createdAt: IsoTimestamp;
  registeredAt: IsoTimestamp | null;
};

export type RunCommandRecord = {
  id: ProductId;
  runId: ProductId;
  commandKind: RunCommandKind;
  requestKey: string;
  intentDigest: Sha256Digest;
  state: "accepted" | "committed" | "rejected";
  outcome: Record<string, unknown>;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
};

export type ExperimentCommandReceiptRecord = {
  commandId: ProductId;
  commandKind: "create" | "update";
  projectId: ProductId;
  experimentId: ProductId;
  intentDigest: Sha256Digest;
  response: Record<string, unknown>;
  responseDigest: Sha256Digest;
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
