import { randomUUID } from "node:crypto";
import { canonicalDigest } from "./canonical-json-v2.ts";
import {
  consumeBatchOutputCandidate,
  type BatchOutputCandidate,
  type BatchScratchCleanupReceipt,
  type BatchSupervisionResult,
  type GenericBatchSupervisor,
  type SuperviseBatchInput,
} from "./generic-batch-supervisor.ts";
import {
  ProductRunRecovery,
  type ProductRunRecoverySupervisorPort,
} from "./product-run-recovery.ts";
import {
  ProductStoreV2,
  type BatchProcessIdentity as StoreBatchProcessIdentity,
  type ClaimedBatchRun,
  type RunAttemptIdentity,
  type RunLimitsV1,
} from "./product-store-v2.ts";

export type BatchSupervisorPort =
  & Pick<GenericBatchSupervisor, "supervise" | "cleanup">
  & Partial<ProductRunRecoverySupervisorPort>;

export type ProductRunDispatcherOptions = Readonly<{
  store: ProductStoreV2;
  supervisor: BatchSupervisorPort;
  now?: () => Date;
  leaseMs?: number;
  consumeOutput?: (candidate: BatchOutputCandidate) => Buffer;
}>;

const activeDispatcherByStore = new WeakMap<ProductStoreV2, ProductRunDispatcher>();

export class ProductRunDispatcher {
  readonly #store: ProductStoreV2;
  readonly #supervisor: BatchSupervisorPort;
  readonly #now: () => Date;
  readonly #leaseMs: number;
  readonly #consumeOutput: (candidate: BatchOutputCandidate) => Buffer;
  readonly #generation = canonicalDigest({ dispatcher: randomUUID(), startedAt: Date.now() });
  #started = false;
  #stopping = false;
  #tail: Promise<void> = Promise.resolve();
  #lastError: Error | null = null;
  #activeAbort: AbortController | null = null;
  #activeRunId: string | null = null;

  constructor(options: ProductRunDispatcherOptions) {
    this.#store = options.store;
    this.#supervisor = options.supervisor;
    this.#now = options.now ?? (() => new Date());
    this.#leaseMs = options.leaseMs ?? 30_000;
    this.#consumeOutput = options.consumeOutput ?? consumeBatchOutputCandidate;
    if (!Number.isSafeInteger(this.#leaseMs) || this.#leaseMs < 1_000 || this.#leaseMs > 300_000) {
      throw new Error("ProductRunDispatcher lease duration is invalid.");
    }
  }

  async start(): Promise<void> {
    if (this.#started) return;
    const owner = activeDispatcherByStore.get(this.#store);
    if (owner && owner !== this) {
      throw new Error("dispatcher_already_active: this ProductStore already has an in-process dispatcher.");
    }
    if (owner === this) {
      throw new Error("dispatcher_start_in_progress: this dispatcher is already starting.");
    }
    activeDispatcherByStore.set(this.#store, this);
    try {
      await new ProductRunRecovery({
        store: this.#store,
        supervisor: this.#supervisor,
        now: this.#now,
      }).recoverBeforeGenerationActivation(this.#generation);
      const now = this.#now().toISOString();
      this.#store.activateDispatcherGeneration({ generation: this.#generation, activatedAt: now });
      this.#started = true;
      this.notify();
    } catch (error) {
      activeDispatcherByStore.delete(this.#store);
      throw error;
    }
  }

  notify(): void {
    if (!this.#started || this.#stopping) return;
    this.#tail = this.#tail.then(() => this.#drain()).catch((error) => {
      this.#lastError = error instanceof Error ? error : new Error("Product run dispatcher failed.");
    });
  }

  requestCancellation(runId: string): void {
    if (this.#activeRunId === runId) this.#activeAbort?.abort();
    this.notify();
  }

  get lastError(): Error | null { return this.#lastError; }

  async stop(): Promise<void> {
    this.#stopping = true;
    this.#activeAbort?.abort();
    try {
      await this.#tail;
    } finally {
      if (activeDispatcherByStore.get(this.#store) === this) {
        activeDispatcherByStore.delete(this.#store);
      }
    }
  }

  async #drain(): Promise<void> {
    while (!this.#stopping) {
      const claimedAt = this.#now();
      const cancelled = this.#store.finalizeNextCancelledQueuedRun({
        finishedAt: claimedAt.toISOString(),
      });
      if (cancelled) continue;
      const claim = this.#store.claimNextQueuedBatchRun({
        dispatcherGeneration: this.#generation,
        claimedAt: claimedAt.toISOString(),
        leaseExpiresAt: new Date(claimedAt.getTime() + this.#leaseMs).toISOString(),
      });
      if (!claim) return;
      await this.#execute(claim);
    }
  }

  async #execute(claim: ClaimedBatchRun): Promise<void> {
    const attempt = attemptIdentity(claim);
    const registered = new Map<number, StoreBatchProcessIdentity>();
    const phases = new Map<number, "blocked" | "released" | "running">();
    const exited = new Set<number>();
    const cleanupFinalized = new Set<number>();
    let attemptState: "claimed" | "starting" | "running" = "claimed";
    let heartbeatError: Error | null = null;
    let heartbeat: NodeJS.Timeout | null = null;
    let result: BatchSupervisionResult | null = null;
    let cleanupReceipt: BatchScratchCleanupReceipt | null = null;
    let abort: AbortController | null = null;
    try {
      const startingAt = this.#now();
      this.#store.markRunAttemptStarting({ ...attempt, startedAt: startingAt.toISOString() });
      attemptState = "starting";
      const project = this.#store.projectExecutionCapability(claim.run.projectId);
      const runningAt = this.#now();
      this.#store.markRunAttemptRunning({
        ...attempt,
        startedAt: runningAt.toISOString(),
        leaseExpiresAt: new Date(runningAt.getTime() + this.#leaseMs).toISOString(),
      });
      attemptState = "running";
      heartbeat = setInterval(() => {
        if (heartbeatError) return;
        const at = this.#now();
        try {
          if (this.#store.isRunCancellationRequested(attempt.runId)) {
            abort?.abort();
            return;
          }
          this.#store.heartbeatRunAttempt({
            ...attempt,
            expectedState: "running",
            heartbeatAt: at.toISOString(),
            leaseExpiresAt: new Date(at.getTime() + this.#leaseMs).toISOString(),
          });
          for (const [sampleIndex, phase] of phases) {
            if (phase !== "running") continue;
            this.#store.heartbeatBatchProcess({
              ...requiredIdentity(registered, sampleIndex),
              expectedState: "running",
              heartbeatAt: at.toISOString(),
            });
          }
        } catch (error) {
          heartbeatError = error instanceof Error ? error : new Error("Dispatcher heartbeat failed.");
          abort?.abort();
        }
      }, Math.max(250, Math.floor(this.#leaseMs / 3)));
      heartbeat.unref?.();
      abort = new AbortController();
      this.#activeAbort = abort;
      this.#activeRunId = attempt.runId;
      if (this.#store.isRunCancellationRequested(attempt.runId)) abort.abort();
      result = await this.#supervisor.supervise({
        run: {
          runId: claim.run.id,
          runKind: "batch",
          samples: claim.run.samplePlan as SuperviseBatchInput["run"]["samples"],
          limits: claim.run.limits as RunLimitsV1,
        },
        project,
        signal: abort.signal,
        hooks: {
          planScratch: async (plan) => this.#store.prepareBatchProcessLaunch({
            ...attempt,
            ...plan,
            createdAt: this.#now().toISOString(),
          }),
          registerScratchDirectory: async (identity) => {
            this.#store.registerBatchScratchDirectory({
              ...attempt,
              ...identity,
              registeredAt: this.#now().toISOString(),
            });
          },
          registerProcess: async (identity, launchReceipt) => {
            const durable = storeProcessIdentity(attempt, identity);
            this.#store.registerBatchProcessAttempt({
              ...durable,
              launchedAt: this.#now().toISOString(),
              launchReceipt,
            });
            registered.set(identity.sampleIndex, durable);
            phases.set(identity.sampleIndex, "blocked");
          },
          markGateReleased: async (identity) => {
            const durable = requiredIdentity(registered, identity.sampleIndex);
            this.#store.markBatchProcessGateReleased({ ...durable, startedAt: this.#now().toISOString() });
            phases.set(identity.sampleIndex, "released");
          },
          markProcessStarted: async (identity) => {
            const durable = requiredIdentity(registered, identity.sampleIndex);
            this.#store.markBatchProcessStarted({ ...durable, startedAt: this.#now().toISOString() });
            phases.set(identity.sampleIndex, "running");
          },
        },
      });
      if (heartbeatError) throw dispatcherFailure(
        "dispatcher_heartbeat_failed",
        "The durable dispatcher heartbeat failed.",
        heartbeatError,
      );

      let outputBytes: Array<{ candidate: BatchOutputCandidate; bytes: Buffer }> = [];
      let terminalOverride: { status: "failed"; code: string; diagnostic: string } | null = null;
      if (result.status === "succeeded") {
        try {
          outputBytes = result.outputs.map((candidate) => ({
            candidate,
            bytes: this.#consumeOutput(candidate),
          }));
        } catch {
          terminalOverride = {
            status: "failed",
            code: "run_output_invalid",
            diagnostic: "A validated output changed before durable publication.",
          };
        }
      }

      this.#recordResultExits(result, registered, phases, exited);

      cleanupReceipt = this.#supervisor.cleanup(result);
      this.#finalizeProcessCleanup(registered, exited, cleanupFinalized, cleanupReceipt);

      const diagnostics = {
        code: terminalOverride?.code ?? result.code,
        diagnostic: terminalOverride?.diagnostic ?? result.diagnostic,
      };
      if (result.status === "succeeded" && !terminalOverride) {
        try {
          this.#store.commitBatchRunSuccess({
            ...attempt,
            outputs: outputBytes.map(({ candidate, bytes }) => ({
              sampleIndex: candidate.sampleIndex,
              sampleId: candidate.sampleId,
              logicalName: candidate.logicalName,
              outputType: candidate.role,
              bytes,
            })),
            terminalDiagnostics: diagnostics,
            resourceOverview: result.resources,
            finishedAt: result.finishedAt,
          });
          return;
        } catch (error) {
          throw dispatcherFailure(
            "batch_publication_failed",
            "Atomic batch success publication failed.",
            error,
          );
        }
      }
      const terminal = terminalOverride ?? result;
      this.#store.finalizeBatchRunTerminal({
        ...attempt,
        expectedAttemptState: "running",
        status: terminal.status === "timed_out" ? "timed_out" : "failed",
        terminalCode: terminal.code,
        terminalDiagnostics: diagnostics,
        resourceOverview: result.resources,
        finishedAt: result.finishedAt,
      });
      return;
    } catch (error) {
      abort?.abort();
      const failure = asError(error);
      const code = dispatcherErrorCode(failure);
      const finishedAt = this.#now().toISOString();
      const safeToFinalize = this.#bestEffortUnwind({
        attempt,
        projectId: claim.run.projectId,
        attemptState,
        registered,
        phases,
        exited,
        cleanupFinalized,
        result,
        cleanupReceipt,
        terminalCode: code,
        finishedAt,
      });
      if (!safeToFinalize) {
        throw dispatcherFailure(
          "dispatcher_recovery_required",
          "Dispatcher unwind could not prove every registered process exited and was cleaned.",
          failure,
        );
      }
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      if (abort && this.#activeAbort === abort) {
        this.#activeAbort = null;
        this.#activeRunId = null;
      }
    }
  }

  #bestEffortUnwind(input: {
    attempt: RunAttemptIdentity;
    projectId: string;
    attemptState: "claimed" | "starting" | "running";
    registered: Map<number, StoreBatchProcessIdentity>;
    phases: Map<number, "blocked" | "released" | "running">;
    exited: Set<number>;
    cleanupFinalized: Set<number>;
    result: BatchSupervisionResult | null;
    cleanupReceipt: BatchScratchCleanupReceipt | null;
    terminalCode: string;
    finishedAt: string;
  }): boolean {
    if (input.registered.size > 0 && !input.result) return false;
    if (input.result) {
      try {
        this.#recordResultExits(input.result, input.registered, input.phases, input.exited);
      } catch {
        return false;
      }
      if ([...input.registered.keys()].some((sampleIndex) => !input.cleanupFinalized.has(sampleIndex))) {
        let cleanup = input.cleanupReceipt;
        if (!cleanup) {
          try {
            cleanup = this.#supervisor.cleanup(input.result);
          } catch {
            return false;
          }
        }
        try {
          this.#finalizeProcessCleanup(
            input.registered,
            input.exited,
            input.cleanupFinalized,
            cleanup,
          );
        } catch {
          return false;
        }
      }
    }
    try {
      const current = this.#store.getRun(input.projectId, input.attempt.runId, {
        includeTrashed: true,
      });
      if (["succeeded", "failed", "cancelled", "timed_out"].includes(current.status)) {
        this.#store.auditRunCompletionCards();
        return true;
      }
    } catch {
      // Continue to the normal unwind path when durable terminal state is not provable.
    }
    if (input.attemptState === "claimed") return false;
    try {
      this.#store.finalizeBatchRunTerminal({
        ...input.attempt,
        expectedAttemptState: input.attemptState,
        status: "failed",
        terminalCode: input.terminalCode,
        terminalDiagnostics: {
          code: input.terminalCode,
          diagnostic: "The dispatcher failed and completed its best-effort unwind.",
        },
        resourceOverview: input.result?.resources ?? {},
        finishedAt: input.result?.finishedAt ?? input.finishedAt,
      });
      return true;
    } catch {
      return false;
    }
  }

  #recordResultExits(
    result: BatchSupervisionResult,
    registered: Map<number, StoreBatchProcessIdentity>,
    phases: Map<number, "blocked" | "released" | "running">,
    exited: Set<number>,
  ): void {
    for (const [sampleIndex, durable] of registered) {
      if (exited.has(sampleIndex)) continue;
      const sample = result.samples.find((candidate) => candidate.sampleIndex === sampleIndex);
      if (!sample?.identity) {
        throw dispatcherFailure(
          "dispatcher_recovery_required",
          "A registered batch process has no terminal supervisor identity.",
        );
      }
      this.#store.recordBatchProcessExit({
        ...durable,
        expectedState: phases.get(sampleIndex) ?? "blocked",
        exitedAt: result.finishedAt,
        exitCode: sample.exitCode,
        exitSignal: sample.signal,
      });
      exited.add(sampleIndex);
    }
  }

  #finalizeProcessCleanup(
    registered: Map<number, StoreBatchProcessIdentity>,
    exited: Set<number>,
    cleanupFinalized: Set<number>,
    cleanup: BatchScratchCleanupReceipt,
  ): void {
    for (const [sampleIndex, durable] of registered) {
      if (cleanupFinalized.has(sampleIndex)) continue;
      if (!exited.has(sampleIndex)) {
        throw dispatcherFailure(
          "dispatcher_recovery_required",
          "A batch process cannot finalize cleanup before durable exit evidence.",
        );
      }
      this.#store.finalizeBatchProcessCleanup({
        ...durable,
        cleanupVerified: true,
        cleanupReceiptDigest: cleanup.receiptDigest,
        cleanedAt: cleanup.cleanedAt,
      });
      cleanupFinalized.add(sampleIndex);
    }
  }
}

const attemptIdentity = (claim: ClaimedBatchRun): RunAttemptIdentity => ({
  runId: claim.run.id,
  attemptId: claim.attempt.id,
  attemptGeneration: claim.attempt.attemptGeneration,
  dispatcherGeneration: claim.attempt.dispatcherGeneration,
});

const storeProcessIdentity = (
  attempt: RunAttemptIdentity,
  identity: {
    runId: string;
    sampleIndex: number;
    sampleId: string;
    pid: number;
    processGroupId: number;
    startToken: string;
  },
): StoreBatchProcessIdentity => ({
  ...attempt,
  processAttemptId: `process_${canonicalDigest({
    runId: attempt.runId,
    attemptGeneration: attempt.attemptGeneration,
    sampleIndex: identity.sampleIndex,
  }).slice(0, 32)}`,
  sampleIndex: identity.sampleIndex,
  sampleId: identity.sampleId,
  pid: identity.pid,
  processStartToken: identity.startToken,
  processGroupId: identity.processGroupId,
  scratchId: identity.scratchId,
});

const requiredIdentity = (
  registered: Map<number, StoreBatchProcessIdentity>,
  sampleIndex: number,
): StoreBatchProcessIdentity => {
  const identity = registered.get(sampleIndex);
  if (!identity) throw new Error("Batch process hook identity was not durably registered.");
  return identity;
};

const asError = (error: unknown): Error =>
  error instanceof Error ? error : new Error("Product run dispatcher failed.");

const dispatcherErrorCode = (error: Error): string => {
  const prefixed = /^([a-z][a-z0-9_]*):/u.exec(error.message)?.[1];
  return prefixed ?? "batch_supervisor_failed";
};

const dispatcherFailure = (code: string, message: string, cause?: unknown): Error =>
  new Error(`${code}: ${message}`, cause === undefined ? undefined : { cause });
