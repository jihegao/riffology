import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { canonicalDigest } from "./canonical-json-v2.ts";
import type { ModelTechnicalCheckResult } from "./model-technical-checker.ts";
import type { ModelTechnicalCheckerPort } from "./model-technical-check-service.ts";
import { captureWorkspaceDigest, executionDescriptionDigest, resolveModelWorkspace } from "./model-workspace.ts";
import {
  ProjectOnlyStore,
  ProjectOnlyStoreError,
  type ProjectFileInput,
  type ProjectTechnicalCheckRecord,
} from "./project-only-store.ts";

export type ProjectTechnicalCheckEnvelope = Readonly<{
  schemaVersion: 1;
  id: string;
  projectId: string;
  state: "succeeded" | "failed" | "interrupted";
  aggregate: "executable" | "failed" | "cancelled";
  capturedWorkspaceDigest: string;
  capturedFileDigest: string;
  executionDescriptionDigest: string;
  checks: readonly Readonly<{ name: string; state: string; code: string; detail: string }>[];
  startedAt: string;
  finishedAt: string;
  claim: "technical_execution_only";
}>;

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

export class ProjectOnlyOperationsAdapter {
  readonly #pendingChecks = new Map<string, Promise<ProjectTechnicalCheckEnvelope>>();
  readonly store: ProjectOnlyStore;
  readonly checker: ModelTechnicalCheckerPort;
  readonly now: () => string;
  constructor(
    store: ProjectOnlyStore,
    checker: ModelTechnicalCheckerPort,
    now: () => string = () => new Date().toISOString(),
  ) {
    this.store = store;
    this.checker = checker;
    this.now = now;
  }

  async startProjectTechnicalCheck(input: Readonly<{
    projectId: string;
    commandId: string;
    expectedWorkspaceDigest: string;
  }>): Promise<ProjectOperationEnvelope> {
    const project = this.store.project(boundedId(input.projectId));
    if (project.workspaceDigest !== input.expectedWorkspaceDigest) {
      throw new ProjectOnlyStoreError("stale_workspace_digest", "Project workspace changed before technical check.");
    }
    const technicalCheck = await this.#startTechnicalCheck(project.id, input.commandId);
    const result = Object.freeze({
      status: technicalCheck.aggregate === "executable" ? "succeeded" : "failed",
      partialEffect: false,
      workspaceDigest: technicalCheck.capturedWorkspaceDigest,
      technicalCheck,
    });
    const receiptDigest = canonicalDigest({ operation: "project_technical_check", commandId: input.commandId, result });
    return Object.freeze({
      receiptDigest,
      affectedResources: Object.freeze([
        Object.freeze({ kind: "project", id: project.id, sha256: project.workspaceDigest }),
        Object.freeze({ kind: "project_technical_check", id: technicalCheck.id }),
      ]),
      result,
    });
  }

  #startTechnicalCheck(projectId: string, commandId: string): Promise<ProjectTechnicalCheckEnvelope> {
    const checkedProjectId = boundedId(projectId);
    const checkedCommandId = boundedId(commandId);
    const id = stableId("project_check", `${checkedProjectId}:${checkedCommandId}`);
    try {
      const existing = this.store.technicalCheck(id);
      if (existing.status !== "running") return Promise.resolve(publicTechnicalCheck(existing));
    } catch (error) {
      if (!(error instanceof ProjectOnlyStoreError) || error.code !== "technical_check_not_found") throw error;
    }
    const pending = this.#pendingChecks.get(id);
    if (pending) return pending;
    const operation = this.#runTechnicalCheck(checkedProjectId, id)
      .finally(() => { if (this.#pendingChecks.get(id) === operation) this.#pendingChecks.delete(id); });
    this.#pendingChecks.set(id, operation);
    return operation;
  }

  async deliverProjectChanges(input: Readonly<{
    commandId: string;
    projectId: string;
    conversationId: string;
    turnId: string;
    expectedWorkspaceDigest: string;
    changes: readonly Readonly<Record<string, unknown>>[];
    executionDescription?: Readonly<Record<string, unknown>>;
    run?: Readonly<{ configurationId: string }>;
  }>): Promise<ProjectOperationEnvelope> {
    const commandId = boundedId(input.commandId);
    const projectId = boundedId(input.projectId);
    const intentDigest = canonicalDigest({
      projectId,
      conversationId: input.conversationId,
      turnId: input.turnId,
      expectedWorkspaceDigest: input.expectedWorkspaceDigest,
      changes: input.changes.map((change) => ({
        fileRef: change.fileRef ?? null,
        kind: change.kind,
        relativePath: change.relativePath,
        mediaType: change.mediaType,
        textSha256: createHash("sha256").update(String(change.text ?? ""), "utf8").digest("hex"),
        expectedPriorSha256: change.expectedPriorSha256 ?? null,
      })),
      executionDescription: input.executionDescription ?? null,
      run: input.run ?? null,
    });
    const priorReceipt = this.store.deliveryReceipt(commandId);
    if (priorReceipt) {
      if (priorReceipt.projectId !== projectId || priorReceipt.intentDigest !== intentDigest) {
        throw new ProjectOnlyStoreError("idempotency_conflict", "Delivery command was already used with different intent.");
      }
      return Object.freeze(priorReceipt.response as unknown as ProjectOperationEnvelope);
    }
    const before = this.store.project(projectId);
    const beforeRecords = this.store.projectFiles(projectId);
    const beforeByPath = new Map(beforeRecords.map((file) => [file.relativePath, file]));
    const changes = input.changes.map((raw, index): ProjectFileInput => {
      const relativePath = String(raw.relativePath ?? "");
      const existing = beforeByPath.get(relativePath);
      const expectedPriorSha256 = raw.expectedPriorSha256 === null ? null : String(raw.expectedPriorSha256 ?? "");
      const fileRef = raw.fileRef === null ? null : String(raw.fileRef ?? "");
      if ((existing?.sha256 ?? null) !== expectedPriorSha256 || (fileRef === null) !== (existing === undefined)) {
        throw new ProjectOnlyStoreError("stale_project_file", "Project delivery file reference or prior digest is stale.");
      }
      const kind = raw.kind === "environment" ? "project_environment" as const
        : raw.kind === "visual_asset" ? "project_visual_asset" as const
          : raw.kind === "code" ? "project_code" as const
            : null;
      if (!kind) throw new ProjectOnlyStoreError("invalid_project_file_kind", "Project delivery file kind is invalid.");
      return Object.freeze({
        id: existing?.id ?? stableId("project_file", `${commandId}:${index}:${relativePath}`),
        kind,
        relativePath,
        mediaType: String(raw.mediaType ?? ""),
        bytes: Buffer.from(String(raw.text ?? ""), "utf8"),
      });
    });
    if (before.workspaceDigest !== input.expectedWorkspaceDigest) throw new ProjectOnlyStoreError("stale_workspace_digest", "Project workspace changed before delivery.");
    const beforeFiles = new Map(beforeRecords.map((file) => [file.relativePath, file.sha256]));
    const after = this.store.updateProjectWorkspace({
      projectId,
      expectedWorkspaceDigest: input.expectedWorkspaceDigest,
      changes,
      ...(input.executionDescription ? { executionDescription: { ...input.executionDescription } } : {}),
      ...(input.executionDescription
        && ["batch", "visual", "both"].includes(String(input.executionDescription.runMode))
        ? { runMode: input.executionDescription.runMode as "batch" | "visual" | "both" }
        : {}),
      updatedAt: this.now(),
    });
    const reread = this.store.project(projectId);
    if (reread.workspaceDigest !== after.workspaceDigest || reread.technicalStatus !== "draft") {
      throw new ProjectOnlyStoreError("delivery_reread_failed", "Committed Project bytes did not match the authoritative reread.");
    }
    const afterFiles = new Map(this.store.projectFiles(projectId).map((file) => [file.relativePath, file.sha256]));
    const technicalCheck = await this.#startTechnicalCheck(projectId, stableId("delivery_check", commandId));
    let run: ProjectRunAdmissionEnvelope | Readonly<{ status: "failed"; code: string }> | null = null;
    let postWriteFailure = technicalCheck.aggregate !== "executable";
    if (input.run && !postWriteFailure) {
      try {
        const current = this.store.project(projectId);
        run = this.startRunAdmission({
          commandId: stableId("delivery_run", commandId),
          projectId,
          experimentConfigurationId: boundedId(input.run.configurationId),
          runKind: current.runMode === "batch" ? "batch" : "visual",
          expectedWorkspaceDigest: current.workspaceDigest,
        });
      } catch (error) {
        postWriteFailure = true;
        run = Object.freeze({ status: "failed", code: error instanceof ProjectOnlyStoreError ? error.code : "run_admission_failed" });
      }
    }
    const committedAt = this.now();
    const mutationStable = Object.freeze({
      schemaVersion: 1,
      beforeWorkspaceDigest: before.workspaceDigest,
      afterWorkspaceDigest: reread.workspaceDigest,
      files: Object.freeze([...new Set([...beforeFiles.keys(), ...afterFiles.keys()])].sort().flatMap((relativePath) => {
        const priorSha256 = beforeFiles.get(relativePath) ?? null;
        const afterSha256 = afterFiles.get(relativePath) ?? null;
        return priorSha256 === afterSha256 ? [] : [Object.freeze({ relativePath, priorSha256, afterSha256 })];
      })),
      committedAt,
    });
    const mutationReceipt = Object.freeze({ ...mutationStable, receiptDigest: canonicalDigest(mutationStable) });
    const result = Object.freeze({
      status: postWriteFailure ? "failed" : "succeeded",
      partialEffect: postWriteFailure,
      workspaceDigest: reread.workspaceDigest,
      mutationReceipt,
      technicalCheck,
      run,
    });
    const receiptDigest = canonicalDigest({ operation: "project_delivery", commandId, intentDigest, result });
    const response: ProjectOperationEnvelope = Object.freeze({
      receiptDigest,
      affectedResources: Object.freeze([
        Object.freeze({ kind: "project", id: projectId, sha256: reread.workspaceDigest }),
        ...mutationReceipt.files.map((file) => Object.freeze({ kind: "project_file", id: file.relativePath, sha256: file.afterSha256 })),
        Object.freeze({ kind: "project_technical_check", id: technicalCheck.id }),
        ...(run && "runId" in run ? [Object.freeze({ kind: "run", id: run.runId, sha256: run.sourceWorkspaceDigest })] : []),
      ]),
      result,
    });
    this.store.recordDeliveryReceipt({ commandId, projectId, intentDigest, response: response as unknown as Record<string, unknown>, receiptDigest, committedAt });
    return response;
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

  async #runTechnicalCheck(projectId: string, id: string): Promise<ProjectTechnicalCheckEnvelope> {
    const project = this.store.project(projectId);
    const startedAt = this.now();
    this.store.startTechnicalCheck({ id, projectId, expectedWorkspaceDigest: project.workspaceDigest, startedAt });
    const root = mkdtempSync(resolve(tmpdir(), "riff-project-only-check-"));
    let result: ModelTechnicalCheckResult;
    try {
      for (const file of this.store.projectFiles(projectId)) {
        const target = resolveInside(root, file.relativePath);
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
        writeFileSync(target, file.bytes, { mode: 0o600 });
      }
      const workspace = resolveModelWorkspace(root, `project-check:${id}`);
      const captured = captureWorkspaceDigest(workspace);
      result = await this.checker.check({ workspace, executionDescription: project.executionDescription });
      const expectedExecutionDigest = executionDescriptionDigest(project.executionDescription as any);
      if (result.capturedWorkspaceDigest !== captured.digest || result.executionDescriptionDigest !== expectedExecutionDigest) {
        result = mismatchResult(id, captured.digest, expectedExecutionDigest, startedAt, this.now());
      }
    } catch (error) {
      result = failureResult(id, startedAt, this.now(), error);
    } finally { rmSync(root, { recursive: true, force: true }); }
    const succeeded = result.aggregate === "executable";
    this.store.finishTechnicalCheck({
      id,
      succeeded,
      diagnostics: result.checks,
      capturedFileDigest: result.capturedWorkspaceDigest,
      executionDescriptionDigest: result.executionDescriptionDigest,
      finishedAt: result.finishedAt,
    });
    return Object.freeze({
      schemaVersion: 1,
      id,
      projectId,
      state: succeeded ? "succeeded" : result.aggregate === "cancelled" ? "interrupted" : "failed",
      aggregate: result.aggregate,
      capturedWorkspaceDigest: project.workspaceDigest,
      capturedFileDigest: result.capturedWorkspaceDigest,
      executionDescriptionDigest: result.executionDescriptionDigest,
      checks: result.checks.map(({ name, state, code, detail }) => ({ name, state, code, detail: safeDetail(detail) })),
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      claim: "technical_execution_only",
    });
  }
}

const publicTechnicalCheck = (record: ProjectTechnicalCheckRecord): ProjectTechnicalCheckEnvelope => Object.freeze({
  schemaVersion: 1,
  id: record.id,
  projectId: record.projectId,
  state: record.status === "succeeded" ? "succeeded" : record.status === "interrupted" ? "interrupted" : "failed",
  aggregate: record.status === "succeeded" ? "executable" : record.status === "interrupted" ? "cancelled" : "failed",
  capturedWorkspaceDigest: record.capturedWorkspaceDigest,
  capturedFileDigest: record.capturedFileDigest,
  executionDescriptionDigest: record.executionDescriptionDigest,
  checks: (record.diagnostics as any[]).map((item) => ({ name: String(item?.name ?? ""), state: String(item?.state ?? ""), code: String(item?.code ?? ""), detail: safeDetail(String(item?.detail ?? "")) })),
  startedAt: record.startedAt,
  finishedAt: record.finishedAt ?? record.startedAt,
  claim: "technical_execution_only",
});

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

const failureResult = (id: string, startedAt: string, finishedAt: string, error: unknown): ModelTechnicalCheckResult => Object.freeze({
  attemptId: id,
  aggregate: "failed",
  capturedWorkspaceDigest: "",
  executionDescriptionDigest: "",
  dependencyDescriptionDigest: "",
  environmentKey: "",
  startedAt,
  finishedAt,
  limits: Object.freeze({ timeoutMs: 0, maxOutputBytes: 0, maxWorkspaceFiles: 0, maxWorkspaceBytes: 0 }),
  checks: Object.freeze([{ name: "path", state: "failed", code: "technical_check_failed", detail: safeDetail(error instanceof Error ? error.message : "Technical check failed.") }]),
  log: "",
});

const mismatchResult = (id: string, fileDigest: string, descriptionDigest: string, startedAt: string, finishedAt: string): ModelTechnicalCheckResult => Object.freeze({
  ...failureResult(id, startedAt, finishedAt, new Error("Technical check result did not bind the captured Project digest.")),
  capturedWorkspaceDigest: fileDigest,
  executionDescriptionDigest: descriptionDigest,
  checks: Object.freeze([{ name: "path", state: "failed", code: "technical_check_snapshot_mismatch", detail: "Technical check result did not bind the captured Project digest." }]),
});

const stableId = (prefix: string, value: string): string => `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
const boundedId = (value: string): string => {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/u.test(value)) throw new ProjectOnlyStoreError("invalid_id", "Project operation ID is invalid.");
  return value;
};
const resolveInside = (root: string, relativePath: string): string => {
  const target = resolve(root, relativePath);
  if (!target.startsWith(`${root}/`)) throw new ProjectOnlyStoreError("invalid_project_path", "Project file escaped the technical-check workspace.");
  return target;
};
const safeDetail = (value: string): string => value.slice(0, 500).replace(/(?:\/[A-Za-z0-9._-]+){2,}/gu, "[path]");
