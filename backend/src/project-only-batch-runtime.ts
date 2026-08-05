import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { planExperiment } from "./experiment-planner.ts";
import {
  GenericBatchSupervisor,
  verifyProjectExecutionRootCapability,
  type BatchSupervisionResult,
} from "./generic-batch-supervisor.ts";
import { captureWorkspaceDigest, resolveModelWorkspace } from "./model-workspace.ts";
import type { RunLimitsV1 } from "./product-store-v2.ts";
import { ProjectOnlyStore } from "./project-only-store.ts";

const MAX_BATCH_SAMPLES = 500;
const RUN_LIMITS: RunLimitsV1 = Object.freeze({
  schemaVersion: 1,
  wallTimeMs: 300_000,
  startupTimeMs: 30_000,
  terminationGraceMs: 5_000,
  maxStdoutBytes: 1_000_000,
  maxStderrBytes: 1_000_000,
  maxOutputFiles: 1_000,
  maxOutputBytes: 64_000_000,
  maxEventCount: 50_000,
  maxEventBytes: 64_000_000,
  maxSamples: MAX_BATCH_SAMPLES,
  maxConcurrency: 4,
});

/**
 * Background batch execution for the Project-only Store. The supervisor owns
 * process isolation; this class owns Store-bound admission completion and
 * durable publication of validated output bytes.
 */
export class ProjectOnlyBatchRuntime {
  readonly store: ProjectOnlyStore;
  readonly supervisor: GenericBatchSupervisor;
  readonly now: () => string;
  readonly #active = new Map<string, { abort: AbortController; completion: Promise<void> }>();

  constructor(input: Readonly<{
    store: ProjectOnlyStore;
    pythonExecutable: string;
    scratchRoot: string;
    now?: () => string;
    supervisor?: GenericBatchSupervisor;
  }>) {
    this.store = input.store;
    this.now = input.now ?? (() => new Date().toISOString());
    mkdirSync(input.scratchRoot, { recursive: true, mode: 0o700 });
    this.supervisor = input.supervisor ?? new GenericBatchSupervisor({
      pythonExecutable: input.pythonExecutable,
      scratchRoot: input.scratchRoot,
    });
  }

  start(input: Readonly<{ projectId: string; runId: string }>): Readonly<{ runId: string; status: "running" }> {
    const run = this.store.run(input.runId);
    if (run.projectId !== input.projectId || run.runKind !== "batch") throw new Error("batch_run_scope_mismatch");
    const existing = this.#active.get(run.id);
    if (existing) return Object.freeze({ runId: run.id, status: "running" });
    if (run.status !== "queued") throw new Error("batch_run_not_queued");
    this.store.transitionRun({ id: run.id, status: "running", at: this.now() });
    const abort = new AbortController();
    const completion = this.#execute(run.id, abort.signal)
      .finally(() => { if (this.#active.get(run.id)?.completion === completion) this.#active.delete(run.id); });
    this.#active.set(run.id, { abort, completion });
    return Object.freeze({ runId: run.id, status: "running" });
  }

  async cancel(projectId: string, runId: string): Promise<void> {
    const run = this.store.run(runId);
    if (run.projectId !== projectId || run.runKind !== "batch") throw new Error("batch_run_scope_mismatch");
    const active = this.#active.get(runId);
    if (!active) {
      if (run.status === "queued") {
        this.store.transitionRun({ id: run.id, status: "cancelled", at: this.now(), terminalCode: "user_cancelled" });
      }
      return;
    }
    if (run.status === "running") this.store.transitionRun({ id: run.id, status: "cancelling", at: this.now() });
    active.abort.abort(new Error("user_cancelled"));
    await active.completion;
  }

  async wait(runId: string): Promise<void> {
    await this.#active.get(runId)?.completion;
  }

  async close(): Promise<void> {
    const active = [...this.#active.values()];
    for (const item of active) item.abort.abort(new Error("backend_shutdown"));
    await Promise.allSettled(active.map((item) => item.completion));
  }

  async #execute(runId: string, signal: AbortSignal): Promise<void> {
    const root = mkdtempSync(resolve(tmpdir(), "riff-project-batch-"));
    let supervision: BatchSupervisionResult | null = null;
    try {
      const run = this.store.run(runId);
      const project = this.store.project(run.projectId);
      if (project.workspaceDigest !== run.sourceWorkspaceDigest) throw new Error("project_snapshot_digest_drift");
      for (const file of this.store.projectFiles(project.id)) {
        const path = resolve(root, file.relativePath);
        if (path !== root && !path.startsWith(`${root}/`)) throw new Error("unsafe_project_path");
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        writeFileSync(path, file.bytes, { mode: 0o600 });
      }
      const execution = this.store.runExecutionDescription(run.id) as any;
      const plan = planExperiment({
        configuration: run.frozenConfiguration,
        inputSchema: execution.inputs?.schema,
        maxSamples: MAX_BATCH_SAMPLES,
      });
      if (plan.configuration.runKind !== "batch") throw new Error("batch_experiment_required");
      const workspace = resolveModelWorkspace(root, `project-batch:${run.id}`);
      const digest = captureWorkspaceDigest(workspace).digest;
      supervision = await this.supervisor.supervise({
        run: Object.freeze({
          runId: run.id,
          runKind: "batch" as const,
          samples: plan.samples,
          limits: RUN_LIMITS,
        }),
        project: Object.freeze({
          workspace: verifyProjectExecutionRootCapability(workspace, execution, digest),
          executionDescription: execution,
        }),
        signal,
      });
      const outputBytes = supervision.status === "succeeded" && !signal.aborted
        ? supervision.outputs.map((candidate) => {
          const bytes = readFileSync(candidate.sourcePath);
          const sha256 = createHash("sha256").update(bytes).digest("hex");
          if (sha256 !== candidate.sha256 || bytes.byteLength !== candidate.sizeBytes) {
            throw new Error("run_output_changed_before_publication");
          }
          return {
            id: stableId("run_output", `${run.id}:${candidate.sampleIndex}:${candidate.logicalName}`),
            sampleIndex: candidate.sampleIndex,
            sampleId: candidate.sampleId,
            logicalName: candidate.logicalName,
            relativePath: candidate.relativePath,
            mediaType: candidate.mediaType,
            declaredRole: candidate.role,
            bytes,
          };
        })
        : [];
      this.supervisor.cleanup(supervision);
      const cancelled = signal.aborted;
      const status = cancelled ? "cancelled" as const : supervision.status;
      const completion = {
        schemaVersion: 1,
        sampleCount: plan.sampleCount,
        samplePlanDigest: plan.samplePlanDigest,
        configurationDigest: plan.configurationDigest,
        status,
        code: cancelled ? "user_cancelled" : supervision.code,
        diagnostic: cancelled ? "The batch Run was cancelled by the user." : supervision.diagnostic,
        samples: supervision.samples.map((sample) => ({
          sampleIndex: sample.sampleIndex,
          sampleId: sample.sampleId,
          seed: plan.samples[sample.sampleIndex]?.seed ?? null,
          status: sample.status,
          code: sample.code,
          durationMs: sample.durationMs,
        })),
        resources: supervision.resources,
        startedAt: supervision.startedAt,
        finishedAt: supervision.finishedAt,
      };
      this.store.commitBatchRunResult({
        runId: run.id,
        status,
        terminalCode: completion.code,
        outputs: outputBytes,
        completion,
        finishedAt: supervision.finishedAt,
      });
    } catch (error) {
      if (supervision) {
        try { this.supervisor.cleanup(supervision); } catch { /* terminal evidence below remains fail-closed */ }
      }
      const run = this.store.run(runId);
      if (["queued", "running", "cancelling"].includes(run.status)) {
        const cancelled = signal.aborted;
        const finishedAt = this.now();
        const code = cancelled ? "user_cancelled" : safeCode(error);
        const diagnostic = cancelled ? "The batch Run was cancelled." : safeDiagnostic(error);
        this.store.commitBatchRunResult({
          runId,
          status: cancelled ? "cancelled" : "failed",
          terminalCode: code,
          outputs: [],
          completion: {
            schemaVersion: 1,
            sampleCount: 0,
            samplePlanDigest: null,
            configurationDigest: null,
            status: cancelled ? "cancelled" : "failed",
            code,
            diagnostic,
            samples: [],
            resources: null,
            startedAt: run.startedAt,
            finishedAt,
          },
          finishedAt,
        });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}

const stableId = (prefix: string, value: string): string =>
  `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;

const safeCode = (error: unknown): string => {
  const code = error && typeof error === "object" && typeof (error as any).code === "string"
    ? (error as any).code
    : error instanceof Error ? error.message : "batch_run_failed";
  return /^[a-z0-9_]{1,200}$/u.test(code) ? code : "batch_run_failed";
};

const safeDiagnostic = (error: unknown): string => {
  const message = error instanceof Error ? error.message : "Batch execution failed before durable output publication.";
  const normalized = message.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
  return normalized ? normalized.slice(0, 1_000) : "Batch execution failed before durable output publication.";
};
