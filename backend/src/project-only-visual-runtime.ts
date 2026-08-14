import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import type {
  BrowserFrameConnectedPeer,
  BrowserFrameTarget,
  BrowserFrameTargetResolver,
  BrowserFrameWebSocketPolicy,
} from "./browser-frame-capability.ts";
import { planExperiment } from "./experiment-planner.ts";
import {
  verifyProjectExecutionRootCapability,
} from "./generic-batch-supervisor.ts";
import {
  GenericVisualSupervisor,
  consumeVisualOutputCandidate,
  type VisualProcessIdentity,
  type VisualSupervisionResult,
} from "./generic-visual-supervisor.ts";
import { captureWorkspaceDigest, resolveModelWorkspace } from "./model-workspace.ts";
import type { RunLimitsV1 } from "./product-store-v2.ts";
import { ProjectOnlyStore } from "./project-only-store.ts";

const LOOPBACK_HOST = "127.0.0.1" as const;
const MAX_VISUAL_SAMPLES = 1;
const ATTEMPT_TTL_MS = 24 * 60 * 60_000;
const RUN_LIMITS: RunLimitsV1 = Object.freeze({
  schemaVersion: 1,
  wallTimeMs: ATTEMPT_TTL_MS,
  startupTimeMs: 30_000,
  terminationGraceMs: 5_000,
  maxStdoutBytes: 1_000_000,
  maxStderrBytes: 1_000_000,
  maxOutputFiles: 100,
  maxOutputBytes: 64_000_000,
  maxEventCount: 1,
  maxEventBytes: 1,
  maxSamples: MAX_VISUAL_SAMPLES,
  maxConcurrency: 1,
});

type ActiveVisual = {
  projectId: string;
  runId: string;
  attemptGeneration: number;
  expiresAtMs: number;
  abort: AbortController;
  port: number | null;
  healthy: boolean;
  identity: VisualProcessIdentity | null;
  webSocket?: BrowserFrameWebSocketPolicy;
  ready: Promise<void>;
  resolveReady: () => void;
  rejectReady: (error: Error) => void;
  readySettled: boolean;
  completion: Promise<void>;
};

/**
 * Executes the frozen visual capability of one Project-only Run.
 *
 * The Project source and frozen Experiment remain authoritative. The live
 * listener is exposed to BrowserFrameCapability only after the generic visual
 * supervisor has bound it to the launched process and completed its declared
 * health probe. No Project HTML projection is treated as a Run by this class.
 */
export class ProjectOnlyVisualRuntime {
  readonly store: ProjectOnlyStore;
  readonly supervisor: GenericVisualSupervisor;
  readonly now: () => string;
  readonly #active = new Map<string, ActiveVisual>();
  #generation = 0;

  constructor(input: Readonly<{
    store: ProjectOnlyStore;
    pythonExecutable: string;
    scratchRoot: string;
    now?: () => string;
    supervisor?: GenericVisualSupervisor;
  }>) {
    this.store = input.store;
    this.now = input.now ?? (() => new Date().toISOString());
    mkdirSync(input.scratchRoot, { recursive: true, mode: 0o700 });
    this.supervisor = input.supervisor ?? new GenericVisualSupervisor({
      pythonExecutable: input.pythonExecutable,
      scratchRoot: input.scratchRoot,
    });
  }

  readonly targetResolver: BrowserFrameTargetResolver = Object.freeze({
    resolve: async (projectId: string, runId: string): Promise<BrowserFrameTarget | null> => {
      const active = this.#active.get(runId);
      if (!active || active.projectId !== projectId || !this.#isLive(active)) return null;
      return publicTarget(active);
    },
    inspect: async (target: BrowserFrameTarget): Promise<boolean> =>
      this.#matches(target),
    inspectConnectedPeer: async (
      target: BrowserFrameTarget,
      peer: BrowserFrameConnectedPeer,
    ): Promise<boolean> => this.#matches(target)
      && peer.localHost === LOOPBACK_HOST
      && peer.localPort === target.port
      && peer.remoteHost === LOOPBACK_HOST,
  });

  async start(input: Readonly<{
    projectId: string;
    runId: string;
  }>): Promise<Readonly<{ runId: string; status: "running" }>> {
    const run = this.store.run(input.runId);
    if (run.projectId !== input.projectId || run.runKind !== "visual") {
      throw visualError("visual_run_scope_mismatch", "The visual Run is outside this Project scope.");
    }
    const existing = this.#active.get(run.id);
    if (existing) {
      await existing.ready;
      return Object.freeze({ runId: run.id, status: "running" });
    }
    if (run.status !== "queued") {
      throw visualError("visual_run_not_queued", "The visual Run is not queued for launch.");
    }

    const deferred = readyDeferred();
    const active: ActiveVisual = {
      projectId: input.projectId,
      runId: run.id,
      attemptGeneration: ++this.#generation,
      expiresAtMs: Date.now() + ATTEMPT_TTL_MS,
      abort: new AbortController(),
      port: null,
      healthy: false,
      identity: null,
      ready: deferred.promise,
      resolveReady: deferred.resolve,
      rejectReady: deferred.reject,
      readySettled: false,
      completion: Promise.resolve(),
    };
    this.#active.set(run.id, active);
    active.completion = this.#execute(active).finally(() => {
      if (this.#active.get(run.id) === active) this.#active.delete(run.id);
    });
    await active.ready;
    return Object.freeze({ runId: run.id, status: "running" });
  }

  /** Stop one live visual process and wait for its terminal Store record. */
  async stop(input: Readonly<{
    projectId: string;
    runId: string;
    at?: string;
  }>): Promise<Readonly<{
    runId: string;
    status: "cancelled" | "already_terminal";
    terminalStatus: string;
  }>> {
    const run = this.store.run(input.runId);
    if (run.projectId !== input.projectId || run.runKind !== "visual") {
      throw visualError("visual_run_scope_mismatch", "The visual Run is outside this Project scope.");
    }
    if (!isActiveRunStatus(run.status)) {
      return Object.freeze({
        runId: run.id,
        status: "already_terminal",
        terminalStatus: run.status,
      });
    }

    const active = this.#active.get(run.id);
    if (!active) {
      const at = input.at ?? this.now();
      this.store.commitVisualRunResult({
        runId: run.id,
        status: "cancelled",
        terminalCode: "user_cancelled",
        outputs: [],
        completion: visualCompletionWithoutProcess(run.id, "cancelled", "user_cancelled", at),
        finishedAt: at,
      });
      return Object.freeze({ runId: run.id, status: "cancelled", terminalStatus: "cancelled" });
    }

    active.healthy = false;
    const current = this.store.run(run.id);
    if (current.status === "running") {
      this.store.transitionRun({ id: run.id, status: "cancelling", at: input.at ?? this.now() });
    }
    active.abort.abort(visualError("user_cancelled", "The visual Run was cancelled by the user."));
    await active.completion;
    const terminal = this.store.run(run.id);
    return Object.freeze({
      runId: run.id,
      status: terminal.status === "cancelled" ? "cancelled" : "already_terminal",
      terminalStatus: terminal.status,
    });
  }

  async wait(runId: string): Promise<void> {
    await this.#active.get(runId)?.completion;
  }

  async close(): Promise<void> {
    const active = [...this.#active.values()];
    for (const item of active) {
      item.healthy = false;
      item.abort.abort(visualError("backend_shutdown", "The visual runtime is shutting down."));
    }
    await Promise.allSettled(active.map((item) => item.completion));
  }

  async #execute(active: ActiveVisual): Promise<void> {
    const root = mkdtempSync(resolve(tmpdir(), "riff-project-visual-"));
    let supervision: VisualSupervisionResult | null = null;
    let cleaned = false;
    try {
      const run = this.store.run(active.runId);
      const project = this.store.project(run.projectId);
      if (project.workspaceDigest !== run.sourceWorkspaceDigest) {
        throw visualError("project_snapshot_digest_drift", "The Project changed after visual Run admission.");
      }
      for (const file of this.store.projectFiles(project.id)) {
        const path = resolve(root, file.relativePath);
        if (path !== root && !path.startsWith(`${root}/`)) {
          throw visualError("unsafe_project_path", "A Project file path escaped its execution root.");
        }
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        writeFileSync(path, file.bytes, { mode: 0o600 });
      }
      const execution = this.store.runExecutionDescription(run.id) as any;
      const plan = planExperiment({
        configuration: run.frozenConfiguration,
        inputSchema: execution.inputs?.schema,
        maxSamples: MAX_VISUAL_SAMPLES,
      });
      if (plan.configuration.runKind !== "visual" || plan.samples.length !== 1) {
        throw visualError("visual_experiment_required", "A visual Run requires one frozen visual sample.");
      }
      active.webSocket = execution.visual?.webSocket
        ? Object.freeze({ ...execution.visual.webSocket }) : undefined;
      const workspace = resolveModelWorkspace(root, `project-visual:${run.id}`);
      const digest = captureWorkspaceDigest(workspace).digest;
      supervision = await this.supervisor.supervise({
        run: Object.freeze({
          runId: run.id,
          runKind: "visual" as const,
          sample: Object.freeze({ ...plan.samples[0], sampleIndex: 0 as const }),
          limits: RUN_LIMITS,
        }),
        project: Object.freeze({
          workspace: verifyProjectExecutionRootCapability(workspace, execution, digest),
          executionDescription: execution,
        }),
        signal: active.abort.signal,
        hooks: Object.freeze({
          registerProcess: async (identity: VisualProcessIdentity) => {
            if (this.#active.get(run.id) !== active || active.abort.signal.aborted) {
              throw visualError("visual_attempt_revoked", "The visual attempt is no longer active.");
            }
            active.identity = identity;
            active.port = identity.loopbackPort;
          },
          recordHealth: async (identity: VisualProcessIdentity) => {
            if (this.#active.get(run.id) !== active || active.abort.signal.aborted
              || !sameVisualIdentity(active.identity, identity)) {
              throw visualError("visual_attempt_revoked", "The visual attempt changed before health publication.");
            }
            const current = this.store.run(run.id);
            if (current.status === "queued") {
              this.store.transitionRun({ id: run.id, status: "running", at: this.now() });
            } else if (current.status !== "running") {
              throw visualError("visual_attempt_revoked", "The visual Run cannot publish health in its current state.");
            }
            active.healthy = true;
            this.#resolveReady(active);
          },
        }),
      });
      active.healthy = false;
      const outputBytes = supervision.status === "succeeded" && !active.abort.signal.aborted
        ? supervision.outputs.map((candidate) => ({
          id: stableId("run_output", `${run.id}:0:${candidate.logicalName}`),
          sampleIndex: 0,
          sampleId: plan.samples[0]!.sampleId,
          logicalName: candidate.logicalName,
          relativePath: candidate.relativePath,
          mediaType: candidate.mediaType,
          declaredRole: candidate.role,
          bytes: consumeVisualOutputCandidate(candidate),
        })) : [];
      this.supervisor.cleanup(supervision);
      cleaned = true;
      const aborted = active.abort.signal.aborted;
      const status = aborted ? abortStatus(active.abort.signal.reason) : supervision.status;
      const finishedAt = supervision.finishedAt;
      const completion = Object.freeze({
        schemaVersion: 1,
        sampleCount: 1,
        samplePlanDigest: plan.samplePlanDigest,
        configurationDigest: plan.configurationDigest,
        status,
        code: aborted ? abortCode(active.abort.signal.reason) : supervision.code,
        diagnostic: aborted
          ? abortDiagnostic(active.abort.signal.reason)
          : supervision.diagnostic,
        sample: Object.freeze({
          sampleIndex: 0,
          sampleId: plan.samples[0]!.sampleId,
          seed: plan.samples[0]!.seed,
        }),
        resources: visualResources(supervision),
        startedAt: supervision.startedAt,
        finishedAt,
      });
      this.store.commitVisualRunResult({
        runId: run.id,
        status,
        terminalCode: completion.code,
        outputs: outputBytes,
        completion,
        finishedAt,
      });
      if (!active.readySettled) {
        this.#rejectReady(active, visualError(completion.code, completion.diagnostic));
      }
    } catch (error) {
      active.healthy = false;
      if (supervision && !cleaned) {
        try {
          this.supervisor.cleanup(supervision);
          cleaned = true;
        } catch (cleanupError) {
          error = cleanupError;
        }
      }
      const current = this.store.run(active.runId);
      if (isActiveRunStatus(current.status)) {
        const aborted = active.abort.signal.aborted;
        const finishedAt = this.now();
        const status = aborted ? abortStatus(active.abort.signal.reason) : "failed";
        const code = aborted ? abortCode(active.abort.signal.reason) : safeCode(error);
        const diagnostic = aborted
          ? abortDiagnostic(active.abort.signal.reason) : safeDiagnostic(error);
        this.store.commitVisualRunResult({
          runId: current.id,
          status,
          terminalCode: code,
          outputs: [],
          completion: visualCompletionWithoutProcess(
            current.id,
            status,
            code,
            finishedAt,
            diagnostic,
          ),
          finishedAt,
        });
      }
      if (!active.readySettled) this.#rejectReady(active, asVisualError(error, active.abort.signal.reason));
    } finally {
      active.healthy = false;
      rmSync(root, { recursive: true, force: true });
    }
  }

  #resolveReady(active: ActiveVisual): void {
    if (active.readySettled) return;
    active.readySettled = true;
    active.resolveReady();
  }

  #rejectReady(active: ActiveVisual, error: Error): void {
    if (active.readySettled) return;
    active.readySettled = true;
    active.rejectReady(error);
  }

  #isLive(active: ActiveVisual): boolean {
    return active.healthy && !active.abort.signal.aborted && active.port !== null
      && active.identity !== null && active.expiresAtMs > Date.now();
  }

  #matches(target: BrowserFrameTarget): boolean {
    const active = this.#active.get(target.runId);
    return Boolean(active && this.#isLive(active)
      && active.projectId === target.projectId
      && active.attemptGeneration === target.attemptGeneration
      && active.port === target.port
      && active.expiresAtMs === target.expiresAtMs);
  }
}

const readyDeferred = (): Readonly<{
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
}> => {
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  return Object.freeze({ promise, resolve: resolveReady, reject: rejectReady });
};

const publicTarget = (active: ActiveVisual): BrowserFrameTarget => Object.freeze({
  projectId: active.projectId,
  runId: active.runId,
  attemptGeneration: active.attemptGeneration,
  port: active.port!,
  expiresAtMs: active.expiresAtMs,
  ...(active.webSocket ? { webSocket: active.webSocket } : {}),
});

const sameVisualIdentity = (
  left: VisualProcessIdentity | null,
  right: VisualProcessIdentity,
): boolean => Boolean(left
  && left.processAttemptId === right.processAttemptId
  && left.pid === right.pid
  && left.processStartToken === right.processStartToken
  && left.loopbackPort === right.loopbackPort
  && left.healthPath === right.healthPath);

const isActiveRunStatus = (status: string): boolean =>
  ["queued", "running", "cancelling"].includes(status);

const visualResources = (result: VisualSupervisionResult): Readonly<Record<string, number | boolean>> =>
  Object.freeze({
    stdoutBytes: result.stdoutBytes,
    stderrBytes: result.stderrBytes,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
    healthVerified: result.healthVerified,
  });

const visualCompletionWithoutProcess = (
  runId: string,
  status: "failed" | "cancelled" | "interrupted",
  code: string,
  finishedAt: string,
  diagnostic = status === "cancelled"
    ? "The visual Run was cancelled before a live process completed."
    : "The visual Run failed before a live process completed.",
): Readonly<Record<string, unknown>> => Object.freeze({
  schemaVersion: 1,
  runId,
  sampleCount: 0,
  samplePlanDigest: null,
  configurationDigest: null,
  status,
  code,
  diagnostic,
  sample: null,
  resources: null,
  startedAt: null,
  finishedAt,
});

const stableId = (prefix: string, value: string): string =>
  `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;

const visualError = (code: string, message: string): Error & { code: string } =>
  Object.assign(new Error(message), { code });

const safeCode = (error: unknown): string => {
  const code = error && typeof error === "object" && typeof (error as any).code === "string"
    ? (error as any).code : error instanceof Error ? error.message : "visual_run_failed";
  return /^[a-z0-9_]{1,200}$/u.test(code) ? code : "visual_run_failed";
};

const safeDiagnostic = (error: unknown): string => {
  const message = error instanceof Error
    ? error.message : "Visual execution failed before durable output publication.";
  const normalized = message.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
  return normalized
    ? normalized.slice(0, 1_000)
    : "Visual execution failed before durable output publication.";
};

const abortCode = (reason: unknown): string =>
  reason && typeof reason === "object" && typeof (reason as any).code === "string"
    && ["user_cancelled", "backend_shutdown"].includes((reason as any).code)
    ? (reason as any).code : "user_cancelled";

const abortStatus = (reason: unknown): "cancelled" | "interrupted" =>
  abortCode(reason) === "backend_shutdown" ? "interrupted" : "cancelled";

const abortDiagnostic = (reason: unknown): string =>
  abortCode(reason) === "backend_shutdown"
    ? "The visual Run was interrupted because the backend shut down."
    : "The visual Run was cancelled by the user.";

const asVisualError = (error: unknown, abortReason: unknown): Error => {
  if (abortReason) return visualError(abortCode(abortReason), abortDiagnostic(abortReason));
  if (error instanceof Error) return error;
  return visualError("visual_run_failed", "The visual Run failed before health publication.");
};
