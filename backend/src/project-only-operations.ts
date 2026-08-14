import { createHash } from "node:crypto";
import { canonicalDigest } from "./canonical-json-v2.ts";
import { validateExecutionDescriptionV2 } from "./execution-protocol-v2.ts";
import {
  ProjectOnlyStore,
  ProjectOnlyStoreError,
  type ProjectFileInput,
  type ProjectFileKind,
  type ProjectRunMode,
} from "./project-only-store.ts";

export type ProjectRunAdmissionEnvelope = Readonly<{
  schemaVersion: 1;
  commandId: string;
  projectId: string;
  runId: string;
  runKind: "batch" | "visual";
  status: "queued";
  sourceWorkspaceDigest: string;
  frozenConfigurationDigest: string;
  sourceFilesRetained: false;
  admittedAt: string;
}>;

export type ProjectOperationEnvelope = Readonly<{
  receiptDigest: string;
  affectedResources: readonly Readonly<Record<string, unknown>>[];
  result: Readonly<Record<string, unknown>>;
}>;

export type ProjectFileChange =
  | Readonly<{
      operation: "upsert";
      relativePath: string;
      mediaType: string;
      text: string;
      expectedPriorSha256: string | null;
    }>
  | Readonly<{
      operation: "delete";
      relativePath: string;
      expectedPriorSha256: string;
    }>;

const MAX_CHANGES = 64;
const MAX_FILE_BYTES = 1_048_576;
const MAX_WRITE_BYTES = 8_388_608;

export class ProjectOnlyOperationsAdapter {
  readonly store: ProjectOnlyStore;
  readonly now: () => string;

  constructor(
    store: ProjectOnlyStore,
    now: () => string = () => new Date().toISOString(),
  ) {
    this.store = store;
    this.now = now;
  }

  async writeProjectFiles(input: Readonly<{
    commandId: string;
    projectId: string;
    conversationId: string;
    turnId: string;
    expectedWorkspaceDigest: string;
    changes: readonly Readonly<Record<string, unknown>>[];
    executionDescription?: Readonly<Record<string, unknown>>;
    runMode?: ProjectRunMode;
  }>): Promise<ProjectOperationEnvelope> {
    const commandId = boundedId(input.commandId);
    const projectId = boundedId(input.projectId);
    const parsed = parseChanges(input.changes);
    const executionDescription = input.executionDescription === undefined
      ? undefined
      : validateExecutionDescriptionV2(input.executionDescription);
    const intentDigest = canonicalDigest({
      projectId,
      conversationId: input.conversationId,
      turnId: input.turnId,
      expectedWorkspaceDigest: input.expectedWorkspaceDigest,
      changes: parsed.map((change) => change.operation === "delete"
        ? change
        : {
            operation: change.operation,
            relativePath: change.relativePath,
            mediaType: change.mediaType,
            expectedPriorSha256: change.expectedPriorSha256,
            textSha256: createHash("sha256").update(change.text, "utf8").digest("hex"),
          }),
      executionDescription: executionDescription ?? null,
      runMode: input.runMode ?? null,
    });
    return this.store.atomicProjectMutation(() => {
    const priorReceipt = this.store.deliveryReceipt(commandId);
    if (priorReceipt) {
      if (priorReceipt.projectId !== projectId || priorReceipt.intentDigest !== intentDigest) {
        throw new ProjectOnlyStoreError("idempotency_conflict", "Project write command was already used with different intent.");
      }
      return Object.freeze(priorReceipt.response as unknown as ProjectOperationEnvelope);
    }

    const before = this.store.project(projectId);
    if (before.workspaceDigest !== input.expectedWorkspaceDigest) {
      throw new ProjectOnlyStoreError("stale_workspace_digest", "Project workspace changed before the write.");
    }
    const beforeRecords = this.store.projectFiles(projectId);
    const beforeByPath = new Map(beforeRecords.map((file) => [file.relativePath, file]));
    const changes = parsed.map((change, index): ProjectFileInput | Readonly<{ relativePath: string; bytes: null }> => {
      const existing = beforeByPath.get(change.relativePath);
      if ((existing?.sha256 ?? null) !== change.expectedPriorSha256) {
        throw new ProjectOnlyStoreError("stale_project_file", "Project file prior digest is stale.");
      }
      if (change.operation === "delete") {
        if (!existing) throw new ProjectOnlyStoreError("project_file_not_found", "Project file does not exist.");
        return Object.freeze({ relativePath: change.relativePath, bytes: null });
      }
      return Object.freeze({
        id: existing?.id ?? stableId("project_file", `${commandId}:${index}:${change.relativePath}`),
        kind: inferFileKind(change.relativePath, change.mediaType),
        relativePath: change.relativePath,
        mediaType: change.mediaType,
        bytes: Buffer.from(change.text, "utf8"),
      });
    });

    const beforeFiles = new Map(beforeRecords.map((file) => [file.relativePath, file.sha256]));
    const effectiveRunMode = input.runMode
      ?? (executionDescription && isRunMode(executionDescription.runMode)
        ? executionDescription.runMode
        : undefined);
    const after = this.store.updateProjectWorkspace({
      projectId,
      expectedWorkspaceDigest: input.expectedWorkspaceDigest,
      changes,
      ...(executionDescription ? { executionDescription: { ...executionDescription } } : {}),
      ...(effectiveRunMode ? { runMode: effectiveRunMode } : {}),
      updatedAt: this.now(),
    });
    const reread = this.store.project(projectId);
    if (reread.workspaceDigest !== after.workspaceDigest) {
      throw new ProjectOnlyStoreError("delivery_reread_failed", "Committed Project bytes did not match the authoritative reread.");
    }
    const afterFiles = new Map(this.store.projectFiles(projectId).map((file) => [file.relativePath, file.sha256]));
    const committedAt = this.now();
    const stableResult = Object.freeze({
      state: "committed" as const,
      beforeWorkspaceDigest: before.workspaceDigest,
      afterWorkspaceDigest: reread.workspaceDigest,
      files: Object.freeze(parsed.map(({ relativePath }) => relativePath).sort().map((relativePath) => {
        const priorSha256 = beforeFiles.get(relativePath) ?? null;
        const afterSha256 = afterFiles.get(relativePath) ?? null;
        return Object.freeze({ relativePath, priorSha256, afterSha256 });
      })),
      committedAt,
    });
    const receiptDigest = canonicalDigest({ operation: "project_write", commandId, intentDigest, result: stableResult });
    const result = Object.freeze({ ...stableResult, receiptDigest });
    const response: ProjectOperationEnvelope = Object.freeze({
      receiptDigest,
      affectedResources: Object.freeze([
        Object.freeze({ kind: "project", id: projectId, sha256: reread.workspaceDigest }),
        ...result.files.map((file) => Object.freeze({
          kind: "project_file",
          id: file.relativePath,
          sha256: file.afterSha256,
        })),
      ]),
      result,
    });
    this.store.recordDeliveryReceipt({
      commandId,
      projectId,
      intentDigest,
      response: response as unknown as Record<string, unknown>,
      receiptDigest,
      committedAt,
    });
    return response;
    });
  }

  startRunAdmission(input: Readonly<{
    commandId: string;
    projectId: string;
    experimentConfigurationId: string;
    runKind: "batch" | "visual";
    expectedWorkspaceDigest: string;
  }>): ProjectRunAdmissionEnvelope {
    const commandId = boundedId(input.commandId);
    const projectId = boundedId(input.projectId);
    const runId = stableId("run", commandId);
    try {
      const existing = this.store.run(runId);
      if (existing.projectId !== projectId
        || existing.experimentConfigurationId !== input.experimentConfigurationId
        || existing.runKind !== input.runKind
        || existing.sourceWorkspaceDigest !== input.expectedWorkspaceDigest) {
        throw new ProjectOnlyStoreError("idempotency_conflict", "Run command was already used with different intent.");
      }
      return runAdmission(commandId, existing);
    } catch (error) {
      if (!(error instanceof ProjectOnlyStoreError) || error.code !== "run_not_found") throw error;
    }
    const admittedAt = this.now();
    this.store.startRun({
      id: runId,
      projectId,
      experimentConfigurationId: boundedId(input.experimentConfigurationId),
      runKind: input.runKind,
      expectedWorkspaceDigest: input.expectedWorkspaceDigest,
      createdAt: admittedAt,
    });
    return runAdmission(commandId, this.store.run(runId));
  }
}

const parseChanges = (changes: readonly Readonly<Record<string, unknown>>[]): readonly ProjectFileChange[] => {
  if (!Array.isArray(changes) || changes.length < 1 || changes.length > MAX_CHANGES) {
    throw new ProjectOnlyStoreError("invalid_project_changes", "A Project write requires between 1 and 64 file changes.");
  }
  let totalBytes = 0;
  const parsed = changes.map((raw): ProjectFileChange => {
    const operation = raw.operation === "delete" ? "delete" : raw.operation === "upsert" ? "upsert" : null;
    const relativePath = typeof raw.relativePath === "string" ? raw.relativePath : "";
    const expectedPriorSha256 = raw.expectedPriorSha256 === null
      ? null
      : typeof raw.expectedPriorSha256 === "string" && /^[0-9a-f]{64}$/u.test(raw.expectedPriorSha256)
        ? raw.expectedPriorSha256
        : undefined;
    if (!operation || expectedPriorSha256 === undefined) {
      throw new ProjectOnlyStoreError("invalid_project_change", "Project file change operation or prior digest is invalid.");
    }
    if (operation === "delete") {
      if (expectedPriorSha256 === null || Object.keys(raw).some((key) =>
        !["operation", "relativePath", "expectedPriorSha256"].includes(key))) {
        throw new ProjectOnlyStoreError("invalid_project_change", "Project file deletion is invalid.");
      }
      return Object.freeze({ operation, relativePath, expectedPriorSha256 });
    }
    if (Object.keys(raw).some((key) =>
      !["operation", "relativePath", "mediaType", "text", "expectedPriorSha256"].includes(key))
      || typeof raw.mediaType !== "string" || !isTextMediaType(raw.mediaType)
      || typeof raw.text !== "string" || Buffer.from(raw.text, "utf8").toString("utf8") !== raw.text) {
      throw new ProjectOnlyStoreError("invalid_project_change", "Project text-file upsert is invalid.");
    }
    const size = Buffer.byteLength(raw.text, "utf8");
    if (size > MAX_FILE_BYTES) throw new ProjectOnlyStoreError("project_file_too_large", "Project text files cannot exceed 1 MiB.");
    totalBytes += size;
    if (totalBytes > MAX_WRITE_BYTES) throw new ProjectOnlyStoreError("project_write_too_large", "One Project write cannot exceed 8 MiB.");
    return Object.freeze({
      operation,
      relativePath,
      mediaType: raw.mediaType,
      text: raw.text,
      expectedPriorSha256,
    });
  });
  const normalizedPaths = parsed.map((change) =>
    change.relativePath.normalize("NFC").toLocaleLowerCase("en-US"));
  if (new Set(normalizedPaths).size !== normalizedPaths.length) {
    throw new ProjectOnlyStoreError("duplicate_project_change", "One Project write cannot change the same normalized path twice.");
  }
  return Object.freeze(parsed);
};

const inferFileKind = (relativePath: string, mediaType: string): ProjectFileKind => {
  if (relativePath.startsWith("environment/")) return "project_environment";
  if (relativePath === "visual.html" || relativePath.startsWith("visual/") || mediaType === "text/html") {
    return "project_visual_asset";
  }
  if (relativePath.startsWith("code/") || /\.(?:py|js|mjs|cjs|ts|tsx|jsx|rs|go|java|c|cc|cpp|h|hpp|sh)$/iu.test(relativePath)) {
    return "project_code";
  }
  return "project_artifact";
};

const isTextMediaType = (value: string): boolean => {
  if (!value.trim() || value.length > 200) return false;
  return value.startsWith("text/") || /^(?:application\/(?:json|javascript|xml|yaml|toml)|image\/svg\+xml)$/u.test(value);
};

const isRunMode = (value: unknown): value is ProjectRunMode =>
  value === "batch" || value === "visual" || value === "both";

const runAdmission = (commandId: string, run: ReturnType<ProjectOnlyStore["run"]>): ProjectRunAdmissionEnvelope => Object.freeze({
  schemaVersion: 1,
  commandId,
  projectId: run.projectId,
  runId: run.id,
  runKind: run.runKind,
  status: "queued",
  sourceWorkspaceDigest: run.sourceWorkspaceDigest,
  frozenConfigurationDigest: canonicalDigest(run.frozenConfiguration),
  sourceFilesRetained: false,
  admittedAt: run.createdAt,
});

const stableId = (prefix: string, value: string): string =>
  `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;

const boundedId = (value: string): string => {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/u.test(value)) {
    throw new ProjectOnlyStoreError("invalid_id", "Project operation ID is invalid.");
  }
  return value;
};
