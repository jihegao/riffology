import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { ApiError } from "./errors.ts";
import { canonicalDigest } from "./canonical-json-v2.ts";
import type { ModelTechnicalCheckInput, ModelTechnicalCheckResult } from "./model-technical-checker.ts";
import { ModelTechnicalChecker } from "./model-technical-checker.ts";
import { resolveModelWorkspace } from "./model-workspace.ts";
import type { ModelRecord, StoredObjectMetadata } from "./product-domain.ts";
import { ProductStoreV2, ProductStoreV2Error, type TechnicalCheckRecord } from "./product-store-v2.ts";

export type ModelTechnicalCheckerPort = { check(input: ModelTechnicalCheckInput): Promise<ModelTechnicalCheckResult> };

export type ModelWorkspaceProjectionDto = {
  model: Pick<ModelRecord, "id" | "name" | "technicalStatus" | "runMode" | "updatedAt">;
  digest: string;
  files: Array<Pick<StoredObjectMetadata, "id" | "kind" | "relativePath" | "mediaType" | "sizeBytes" | "sha256">>;
};

export type TechnicalCheckDto = {
  id: string;
  modelId: string;
  state: TechnicalCheckRecord["state"];
  publication: "pending" | "published" | "superseded";
  capturedWorkspaceDigest: string;
  executionDescriptionDigest: string;
  aggregate: "pending" | "executable" | "failed" | "cancelled";
  checks: Array<{ name: string; state: string; code: string; detail: string }>;
  limits: Record<string, unknown>;
  startedAt: string;
  finishedAt: string | null;
  claim: "technical_execution_only";
};

const DEFAULT_LIMITS = Object.freeze({ timeoutMs: 15_000, maxOutputBytes: 256 * 1024, maxWorkspaceFiles: 512, maxWorkspaceBytes: 64 * 1024 * 1024 });
const configuredPython = (): string => process.env.RIFF_MODEL_PYTHON ?? "/usr/bin/python3";
const productionChecker = (): ModelTechnicalChecker => new ModelTechnicalChecker({ pythonExecutable: configuredPython() });

export class ModelTechnicalCheckService {
  readonly #pending = new Map<string, Promise<TechnicalCheckDto>>();
  readonly #now: () => string;
  readonly store: ProductStoreV2;
  readonly checker: ModelTechnicalCheckerPort;
  constructor(
    store: ProductStoreV2,
    checker: ModelTechnicalCheckerPort = productionChecker(),
    now: () => string = () => new Date().toISOString(),
  ) { this.store = store; this.checker = checker; this.#now = now; }

  workspace(modelId: string): ModelWorkspaceProjectionDto {
    const model = this.#model(modelId);
    const files = this.store.listObjectFiles({ kind: "model", id: model.id }).filter(checkableFile);
    return {
      model: { id: model.id, name: model.name, technicalStatus: model.technicalStatus, runMode: model.runMode, updatedAt: model.updatedAt },
      digest: projectionDigest(files),
      files: files.map(({ id, kind, relativePath, mediaType, sizeBytes, sha256 }) => ({ id, kind, relativePath, mediaType, sizeBytes, sha256 })),
    };
  }

  start(modelId: string, commandId: string): Promise<TechnicalCheckDto> {
    const checkedModelId = boundedId(modelId);
    const checkedCommandId = boundedKey(commandId);
    const id = stableCheckId(checkedModelId, checkedCommandId);
    try { return Promise.resolve(publicCheck(this.store.getTechnicalCheck(checkedModelId, id))); }
    catch (error) { if (!(error instanceof ProductStoreV2Error) || !/does not exist/u.test(error.message)) throw storeError(error); }
    const existing = this.#pending.get(id);
    if (existing) return existing;
    const operation = this.#run(checkedModelId, id).finally(() => { if (this.#pending.get(id) === operation) this.#pending.delete(id); });
    this.#pending.set(id, operation);
    return operation;
  }

  read(modelId: string, checkId: string): TechnicalCheckDto {
    try { return publicCheck(this.store.getTechnicalCheck(boundedId(modelId), boundedId(checkId))); }
    catch (error) { throw storeError(error); }
  }

  async #run(modelId: string, id: string): Promise<TechnicalCheckDto> {
    let started: { workspaceDigest: string; executionDescriptionDigest: string; executionDescription: Record<string, unknown> };
    try { started = this.store.startTechnicalCheck({ id, modelId, limits: DEFAULT_LIMITS, startedAt: this.#now() }); }
    catch (error) {
      try { return publicCheck(this.store.getTechnicalCheck(modelId, id)); }
      catch { throw storeError(error); }
    }
    const root = mkdtempSync(resolve(tmpdir(), "riff-model-owned-check-"));
    let result: ModelTechnicalCheckResult;
    try {
      for (const file of this.store.listObjectFiles({ kind: "model", id: modelId }).filter(checkableFile)) {
        const target = resolveInside(root, file.relativePath);
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
        writeFileSync(target, this.store.readObjectFile(file.id), { mode: 0o600 });
      }
      result = await this.checker.check({ workspace: resolveModelWorkspace(root, `technical-check:${id}`), executionDescription: started.executionDescription });
      if (result.capturedWorkspaceDigest !== started.workspaceDigest || result.executionDescriptionDigest !== started.executionDescriptionDigest) {
        result = snapshotMismatchResult(id, started, result.finishedAt);
      }
    } catch (error) {
      result = failureResult(id, started, this.#now(), error);
    } finally { rmSync(root, { recursive: true, force: true }); }
    const terminal = result.aggregate === "executable" ? "passed" : result.aggregate === "cancelled" ? "cancelled" : "failed";
    try {
      const publication = this.store.finishTechnicalCheck({ id, state: terminal, results: storedResult(result), finishedAt: result.finishedAt });
      return publicCheck(this.store.getTechnicalCheck(modelId, id), publication.published);
    } catch (error) { throw storeError(error); }
  }

  #model(id: string): ModelRecord {
    const checked = boundedId(id);
    const model = this.store.listModels({ includeArchived: true, includeTrashed: true }).find((item) => item.id === checked);
    if (!model || model.lifecycleState !== "active") throw new ApiError(404, "resource_not_found", "The active Model does not exist.");
    return model;
  }
}

const checkableFile = (file: StoredObjectMetadata): boolean => ["model_code", "model_environment", "model_visual_asset", "adopted_attachment"].includes(file.kind);
const projectionDigest = (files: StoredObjectMetadata[]): string => canonicalDigest(files.map((file) => ({
  relativePath: file.relativePath,
  sizeBytes: file.sizeBytes,
  sha256: file.sha256,
})).sort((a, b) => compare(a.relativePath, b.relativePath)));
const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const resolveInside = (root: string, relativePath: string): string => {
  if (!relativePath || relativePath.startsWith("/") || relativePath.split("/").some((part) => !part || part === "." || part === "..")) throw new ApiError(500, "invalid_model_workspace", "A stored Model file path is invalid.");
  const target = resolve(root, relativePath);
  if (!target.startsWith(`${root}/`)) throw new ApiError(500, "invalid_model_workspace", "A stored Model file path escaped its workspace.");
  return target;
};
const stableCheckId = (modelId: string, commandId: string): string => `technical_check_${createHash("sha256").update(`${modelId}\u0000${commandId}`).digest("hex").slice(0, 32)}`;
const boundedId = (value: string): string => { if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/u.test(value)) throw new ApiError(422, "invalid_id", "A resource ID is invalid."); return value; };
const boundedKey = (value: string): string => { if (typeof value !== "string" || !value.trim() || value.length > 300 || /[\u0000-\u001f\u007f]/u.test(value)) throw new ApiError(422, "invalid_request", "commandId is invalid."); return value; };
const storedResult = (result: ModelTechnicalCheckResult): Record<string, unknown> => ({ aggregate: result.aggregate, capturedWorkspaceDigest: result.capturedWorkspaceDigest, executionDescriptionDigest: result.executionDescriptionDigest, dependencyDescriptionDigest: result.dependencyDescriptionDigest, environmentKey: result.environmentKey, checks: result.checks, log: result.log });
const publicCheck = (record: TechnicalCheckRecord, justPublished?: boolean): TechnicalCheckDto => {
  const result = record.results;
  const checks = Array.isArray(result.checks) ? result.checks.filter((item): item is any => Boolean(item) && typeof item === "object").map((item) => ({ name: safeText(item.name, 100), state: safeText(item.state, 30), code: safeText(item.code, 100), detail: safeDetail(item.detail) })) : [];
  const aggregate = record.state === "running" ? "pending" : result.aggregate === "executable" ? "executable" : record.state === "cancelled" ? "cancelled" : "failed";
  const published = typeof justPublished === "boolean" ? justPublished : result.published === true;
  return { id: record.id, modelId: record.modelId, state: record.state, publication: record.state === "running" ? "pending" : published ? "published" : "superseded", capturedWorkspaceDigest: record.workspaceDigest, executionDescriptionDigest: record.executionDescriptionDigest, aggregate, checks, limits: record.limits, startedAt: record.startedAt, finishedAt: record.finishedAt, claim: "technical_execution_only" };
};
const safeText = (value: unknown, max: number): string => typeof value === "string" ? value.slice(0, max) : "";
const safeDetail = (value: unknown): string => safeText(value, 500).replace(/(?:\/[A-Za-z0-9._-]+){2,}/gu, "[path]");
const failureResult = (id: string, started: { workspaceDigest: string; executionDescriptionDigest: string }, finishedAt: string, error: unknown): ModelTechnicalCheckResult => ({ attemptId: id, aggregate: "failed", capturedWorkspaceDigest: started.workspaceDigest, executionDescriptionDigest: started.executionDescriptionDigest, dependencyDescriptionDigest: "", environmentKey: "", startedAt: finishedAt, finishedAt, limits: DEFAULT_LIMITS, checks: [{ name: "path", state: "failed", code: "technical_check_failed", detail: error instanceof Error ? safeDetail(error.message) : "The technical check failed." }], log: "" });
const snapshotMismatchResult = (id: string, started: { workspaceDigest: string; executionDescriptionDigest: string }, finishedAt: string): ModelTechnicalCheckResult => ({
  attemptId: id,
  aggregate: "failed",
  capturedWorkspaceDigest: started.workspaceDigest,
  executionDescriptionDigest: started.executionDescriptionDigest,
  dependencyDescriptionDigest: "",
  environmentKey: "",
  startedAt: finishedAt,
  finishedAt,
  limits: DEFAULT_LIMITS,
  checks: [{ name: "path", state: "failed", code: "technical_check_snapshot_mismatch", detail: "The checked workspace did not match the captured technical-check snapshot." }],
  log: "",
});
const storeError = (error: unknown): ApiError => {
  if (error instanceof ApiError) return error;
  if (error instanceof ProductStoreV2Error && /does not exist/u.test(error.message)) return new ApiError(404, "resource_not_found", "The requested technical check does not exist.");
  if (error instanceof ProductStoreV2Error && /running|active|UNIQUE|constraint/iu.test(error.message)) return new ApiError(409, "state_conflict", "The technical check conflicts with current Model state.");
  return new ApiError(500, "technical_check_failed", "The technical check could not be completed.");
};
