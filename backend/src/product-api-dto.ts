import { canonicalDigest } from "./canonical-json-v2.ts";
import type { ProviderDiscoveryDto } from "./agent-workspace-service.ts";
import type {
  LifecycleState,
  ModelRecord,
  PermanentDeletePreview,
  ProjectRecord,
} from "./product-domain.ts";
import type { ProductStoreV2 } from "./product-store-v2.ts";

export type ResourceAction =
  | "open"
  | "rename"
  | "archive"
  | "restore"
  | "trash"
  | "permanent_delete_preview";

type ResourceSummaryBase = Readonly<{
  id: string;
  name: string;
  lifecycleState: LifecycleState;
  recordDigest: string;
  createdAt: string;
  updatedAt: string;
  recentActivityAt: string;
  recentActivityKind:
    | "resource_created"
    | "resource_updated"
    | "conversation_message"
    | "technical_check"
    | "run_started"
    | "run_terminal";
  allowedActions: readonly ResourceAction[];
}>;

export type ModelSummaryDto = ResourceSummaryBase & Readonly<{
  kind: "model";
  technicalStatus: "draft" | "checking" | "executable" | "failed";
  runMode: "batch" | "visual" | "both" | null;
}>;

export type ProjectSummaryDto = ResourceSummaryBase & Readonly<{
  kind: "project";
  sourceModelId: string;
  modelSnapshotDigest: string;
  lastRun: null | Readonly<{
    id: string;
    status:
      | "configured"
      | "queued"
      | "running"
      | "succeeded"
      | "failed"
      | "cancelled"
      | "timed_out"
      | "trashed";
    updatedAt: string;
  }>;
}>;

export type ExecutableModelOptionDto = Readonly<{
  id: string;
  name: string;
  technicalStatus: "executable";
  runMode: "batch" | "visual" | "both";
  updatedAt: string;
  recordDigest: string;
}>;

export type HomeRecentConversationDto = Readonly<{
  id: string;
  owner: Readonly<{ kind: "model" | "project"; id: string; name: string }>;
  name: string;
  updatedAt: string;
}>;

export type HomeDto = Readonly<{
  schemaVersion: 1;
  generatedAt: string;
  collectionDigest: string;
  models: readonly ModelSummaryDto[];
  projects: readonly ProjectSummaryDto[];
  recentConversations: readonly HomeRecentConversationDto[];
  newProjectModels: readonly ExecutableModelOptionDto[];
  providerAvailability:
    | { mode: "live"; providerModelCount: number }
    | {
      mode: "read_only";
      reason: "opencode_unavailable" | "opencode_auth_failed";
    };
}>;

export type PublicPermanentDeletePreviewDto = Readonly<{
  schemaVersion: 1;
  action: "permanent_delete_preview";
  target: Readonly<{
    kind: "model" | "project" | "conversation";
    id: string;
  }>;
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

export const modelSummary = (
  store: ProductStoreV2,
  record: ModelRecord,
): ModelSummaryDto => {
  const activity = store.resourceRecentActivity("model", record.id);
  return Object.freeze({
    id: record.id,
    name: record.name,
    kind: "model",
    lifecycleState: record.lifecycleState,
    technicalStatus: record.technicalStatus,
    runMode: record.runMode,
    recordDigest: store.resourceRecordDigest("model", record.id),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    recentActivityAt: activity.at,
    recentActivityKind: activity.kind,
    allowedActions: lifecycleActions(record.lifecycleState),
  });
};

export const projectSummary = (
  store: ProductStoreV2,
  record: ProjectRecord,
): ProjectSummaryDto => {
  const activity = store.resourceRecentActivity("project", record.id);
  const lastRun = store.projectLastRun(record.id);
  return Object.freeze({
    id: record.id,
    name: record.name,
    kind: "project",
    lifecycleState: record.lifecycleState,
    sourceModelId: record.sourceModelId,
    modelSnapshotDigest: record.modelSnapshotDigest,
    lastRun: lastRun ? Object.freeze({
      id: lastRun.id,
      status: lastRun.status,
      updatedAt: lastRun.updatedAt,
    }) : null,
    recordDigest: store.resourceRecordDigest("project", record.id),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    recentActivityAt: activity.at,
    recentActivityKind: activity.kind,
    allowedActions: lifecycleActions(record.lifecycleState),
  });
};

export const orderedModels = (
  store: ProductStoreV2,
  records: readonly ModelRecord[],
): ModelSummaryDto[] => records.map((record) => modelSummary(store, record))
  .sort(compareSummary);

export const orderedProjects = (
  store: ProductStoreV2,
  records: readonly ProjectRecord[],
): ProjectSummaryDto[] => records.map((record) => projectSummary(store, record))
  .sort(compareSummary);

export const executableModelOptions = (
  models: readonly ModelSummaryDto[],
): ExecutableModelOptionDto[] => models
  .filter((model): model is ModelSummaryDto & {
    technicalStatus: "executable";
    runMode: "batch" | "visual" | "both";
  } => model.lifecycleState === "active"
    && model.technicalStatus === "executable"
    && model.runMode !== null)
  .map((model) => Object.freeze({
    id: model.id,
    name: model.name,
    technicalStatus: model.technicalStatus,
    runMode: model.runMode,
    updatedAt: model.updatedAt,
    recordDigest: model.recordDigest,
  }))
  .sort((left, right) =>
    compareCodePoints(left.name.normalize("NFC"), right.name.normalize("NFC"))
    || compareCodePoints(left.id, right.id));

export const homeDto = (
  generatedAt: string,
  models: readonly ModelSummaryDto[],
  projects: readonly ProjectSummaryDto[],
  recentConversations: readonly HomeRecentConversationDto[],
  newProjectModels: readonly ExecutableModelOptionDto[],
  providers: ProviderDiscoveryDto,
): HomeDto => Object.freeze({
  schemaVersion: 1,
  generatedAt,
  collectionDigest: canonicalDigest({
    schemaVersion: 1,
    models: models.map((model) => [model.id, model.recordDigest]),
    projects: projects.map((project) => [project.id, project.recordDigest]),
    recentConversations: recentConversations.map((conversation) => [
      conversation.id, conversation.owner.kind, conversation.owner.id, conversation.updatedAt,
    ]),
    newProjectModels: newProjectModels.map((model) => [model.id, model.recordDigest]),
  }),
  models,
  projects,
  recentConversations,
  newProjectModels,
  providerAvailability: providers.mode === "live"
    ? Object.freeze({
      mode: "live" as const,
      providerModelCount: providers.providerModels.length,
    })
    : Object.freeze({
      mode: "read_only" as const,
      reason: providers.reason,
    }),
});

export const publicPermanentDeletePreview = (
  kind: "model" | "project" | "conversation",
  preview: PermanentDeletePreview,
  confirmationToken: string,
  expiresAt: string,
): PublicPermanentDeletePreviewDto => Object.freeze({
  schemaVersion: 1,
  action: "permanent_delete_preview",
  target: Object.freeze({ kind, id: preview.target.id }),
  recordCount: preview.records.length,
  fileCount: preview.files.length,
  totalBytes: preview.totalBytes,
  blockingReferences: Object.freeze(preview.blockingReferences.map((reference) =>
    Object.freeze({ reasonCode: reference.kind, id: reference.id }))),
  exclusions: Object.freeze(preview.exclusions.map((exclusion) =>
    Object.freeze({
      reasonCode: exclusionReasonCode(exclusion.reason),
      id: exclusion.id,
    }))),
  previewToken: preview.previewToken,
  stateToken: preview.stateToken,
  confirmationToken,
  expiresAt,
});

const lifecycleActions = (state: LifecycleState): readonly ResourceAction[] =>
  state === "active"
    ? Object.freeze(["open", "rename", "archive", "trash"])
    : state === "archived"
      ? Object.freeze(["open", "rename", "restore", "trash"])
      : Object.freeze(["restore", "permanent_delete_preview"]);

const compareSummary = (
  left: ResourceSummaryBase,
  right: ResourceSummaryBase,
): number => compareCodePoints(right.recentActivityAt, left.recentActivityAt)
  || compareCodePoints(left.name.normalize("NFC"), right.name.normalize("NFC"))
  || compareCodePoints(left.id, right.id);

const compareCodePoints = (left: string, right: string): number => {
  const leftPoints = Array.from(left, (value) => value.codePointAt(0)!);
  const rightPoints = Array.from(right, (value) => value.codePointAt(0)!);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) {
      return leftPoints[index]! < rightPoints[index]! ? -1 : 1;
    }
  }
  return leftPoints.length - rightPoints.length;
};

const exclusionReasonCode = (reason: string): string => {
  switch (reason) {
    case "source lineage outside project closure": return "source_model_retained";
    case "adopted copy is owned outside the source conversation":
      return "adopted_copy_retained";
    case "conversation-owned completion card outside run closure":
      return "completion_card_retained";
    case "configuration outside run closure": return "experiment_retained";
    case "owner outside run closure":
    case "owner outside experiment closure":
    case "owner outside temporary-document closure":
      return "owner_retained";
    case "source reference outside temporary-document closure":
      return "source_message_retained";
    default: return "related_resource_retained";
  }
};
