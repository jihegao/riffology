import { randomUUID } from "node:crypto";
import { canonicalDigest } from "./canonical-json-v2.ts";
import {
  consumeBatchDiagnosticEventFileCandidate,
  consumeBatchOutputCandidate,
  type BatchDiagnosticEventFileCandidate,
  type BatchOutputCandidate,
  type BatchScratchCleanupReceipt,
  type BatchSupervisionResult,
  type GenericBatchSupervisor,
  type SuperviseBatchInput,
} from "./generic-batch-supervisor.ts";
import {
  consumeVisualOutputCandidate,
  type GenericVisualSupervisor,
  type SuperviseVisualInput,
  type VisualOutputCandidate,
  type VisualProcessIdentity as SupervisorVisualProcessIdentity,
  type VisualScratchCleanupReceipt,
  type VisualScratchPlan,
  type VisualSupervisionResult,
} from "./generic-visual-supervisor.ts";
import {
  ProductRunRecovery,
  type ProductRunRecoverySupervisorPort,
} from "./product-run-recovery.ts";
import {
  ProductStoreV2,
  type BatchProcessIdentity as StoreBatchProcessIdentity,
  type ClaimedBatchRun,
  type ClaimedVisualRun,
  type RunAttemptIdentity,
  type RunLimitsV1,
  type VisualProcessIdentity as StoreVisualProcessIdentity,
} from "./product-store-v2.ts";

export type BatchSupervisorPort =
  & Pick<GenericBatchSupervisor, "supervise" | "cleanup">
  & Partial<ProductRunRecoverySupervisorPort>;

export type VisualSupervisorPort =
  Pick<GenericVisualSupervisor, "supervise" | "cleanup">;

export type ProductRunDispatcherOptions = Readonly<{
  store: ProductStoreV2;
  supervisor: BatchSupervisorPort;
  visualSupervisor?: VisualSupervisorPort;
  revokeVisualAccess?: (runId: string) => void;
  now?: () => Date;
  leaseMs?: number;
  consumeOutput?: (candidate: BatchOutputCandidate) => Buffer;
  consumeDiagnosticEvents?: (
    candidate: BatchDiagnosticEventFileCandidate,
  ) => ReturnType<typeof consumeBatchDiagnosticEventFileCandidate>;
  consumeVisualOutput?: (candidate: VisualOutputCandidate) => Buffer;
}>;

const activeDispatcherByStore = new WeakMap<ProductStoreV2, ProductRunDispatcher>();

export class ProductRunDispatcher {
  readonly #store: ProductStoreV2;
  readonly #supervisor: BatchSupervisorPort;
  readonly #visualSupervisor: VisualSupervisorPort | null;
  readonly #now: () => Date;
  readonly #leaseMs: number;
  readonly #consumeOutput: (candidate: BatchOutputCandidate) => Buffer;
  readonly #consumeDiagnosticEvents: (
    candidate: BatchDiagnosticEventFileCandidate,
  ) => ReturnType<typeof consumeBatchDiagnosticEventFileCandidate>;
  readonly #consumeVisualOutput: (candidate: VisualOutputCandidate) => Buffer;
  readonly #revokeVisualAccessHook: (runId: string) => void;
  readonly #generation = canonicalDigest({ dispatcher: randomUUID(), startedAt: Date.now() });
  #recoveryPrepared = false;
  #started = false;
  #stopping = false;
  #batchTail: Promise<void> = Promise.resolve();
  #visualTail: Promise<void> = Promise.resolve();
  #lastError: Error | null = null;
  readonly #activeAborts = new Map<string, AbortController>();
  readonly #activeVisualRuns = new Set<string>();

  constructor(options: ProductRunDispatcherOptions) {
    this.#store = options.store;
    this.#supervisor = options.supervisor;
    this.#visualSupervisor = options.visualSupervisor ?? null;
    this.#now = options.now ?? (() => new Date());
    this.#leaseMs = options.leaseMs ?? 30_000;
    this.#consumeOutput = options.consumeOutput ?? consumeBatchOutputCandidate;
    this.#consumeDiagnosticEvents = options.consumeDiagnosticEvents
      ?? consumeBatchDiagnosticEventFileCandidate;
    this.#consumeVisualOutput = options.consumeVisualOutput ?? consumeVisualOutputCandidate;
    this.#revokeVisualAccessHook = options.revokeVisualAccess ?? (() => undefined);
    if (!Number.isSafeInteger(this.#leaseMs) || this.#leaseMs < 1_000 || this.#leaseMs > 300_000) {
      throw new Error("ProductRunDispatcher lease duration is invalid.");
    }
  }

  async recoverBeforeStart(): Promise<void> {
    if (this.#recoveryPrepared || this.#started) return;
    for (const unit of this.#store.listPriorDispatcherRecoveryUnits()) {
      if (unit.run.runKind === "visual") this.#revokeVisualAccess(unit.run.id);
    }
    await new ProductRunRecovery({
      store: this.#store,
      supervisor: this.#supervisor,
      now: this.#now,
    }).recoverBeforeGenerationActivation(this.#generation);
    this.#recoveryPrepared = true;
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
      await this.recoverBeforeStart();
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
    if (!this.#started || this.#stopping || this.#lastError) return;
    this.#batchTail = this.#batchTail.then(() => this.#drainBatch()).catch((error) => {
      this.#latchFatal(
        error instanceof Error ? error : new Error("Product run dispatcher failed."),
      );
    });
    if (this.#visualSupervisor) {
      this.#visualTail = this.#visualTail.then(() => this.#drainVisual()).catch((error) => {
        this.#latchFatal(
          error instanceof Error ? error : new Error("Product visual run dispatcher failed."),
        );
      });
    }
  }

  requestCancellation(runId: string): void {
    try {
      this.#revokeVisualAccess(runId);
    } catch (error) {
      this.#latchFatal(asError(error));
      return;
    }
    this.#activeAborts.get(runId)?.abort();
    this.notify();
  }

  get lastError(): Error | null { return this.#lastError; }

  async stop(): Promise<void> {
    this.#stopping = true;
    let revokeError: Error | null = null;
    for (const runId of this.#activeVisualRuns) {
      try {
        this.#revokeVisualAccess(runId);
      } catch (error) {
        revokeError ??= asError(error);
      }
    }
    for (const abort of this.#activeAborts.values()) abort.abort();
    try {
      await Promise.all([this.#batchTail, this.#visualTail]);
    } finally {
      if (activeDispatcherByStore.get(this.#store) === this) {
        activeDispatcherByStore.delete(this.#store);
      }
    }
    if (revokeError) throw revokeError;
  }

  async #drainBatch(): Promise<void> {
    while (!this.#stopping && !this.#lastError) {
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

  async #drainVisual(): Promise<void> {
    if (!this.#visualSupervisor) return;
    while (!this.#stopping && !this.#lastError) {
      const claimedAt = this.#now();
      const cancelled = this.#store.finalizeNextCancelledQueuedRun({
        finishedAt: claimedAt.toISOString(),
      });
      if (cancelled) continue;
      const claim = this.#store.claimNextQueuedVisualRun({
        dispatcherGeneration: this.#generation,
        claimedAt: claimedAt.toISOString(),
        leaseExpiresAt: new Date(claimedAt.getTime() + this.#leaseMs).toISOString(),
      });
      if (!claim) return;
      await this.#executeVisual(claim, this.#visualSupervisor);
    }
  }

  #latchFatal(error: Error): void {
    this.#lastError ??= error;
    for (const abort of this.#activeAborts.values()) abort.abort();
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
      if (this.#activeAborts.has(attempt.runId)) {
        throw dispatcherFailure(
          "dispatcher_recovery_required",
          "A run already has an active in-process dispatcher owner.",
        );
      }
      this.#activeAborts.set(attempt.runId, abort);
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
      let diagnosticEventFiles: Array<{
        candidate: BatchDiagnosticEventFileCandidate;
        consumed: ReturnType<typeof consumeBatchDiagnosticEventFileCandidate>;
      }> = [];
      let terminalOverride: { status: "failed"; code: string; diagnostic: string } | null = null;
      if (result.status === "succeeded") {
        try {
          outputBytes = result.outputs.map((candidate) => ({
            candidate,
            bytes: this.#consumeOutput(candidate),
          }));
          diagnosticEventFiles = (result.diagnosticEventFiles ?? []).map((candidate) => ({
            candidate,
            consumed: this.#consumeDiagnosticEvents(candidate),
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
            diagnosticEventFiles: diagnosticEventFiles.map(({ candidate, consumed }) => ({
              sampleIndex: candidate.sampleIndex,
              sampleId: candidate.sampleId,
              bytes: consumed.bytes,
              fileEventSetDigest: consumed.parsed.eventSetDigest,
              events: consumed.parsed.events,
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
      if (abort && this.#activeAborts.get(attempt.runId) === abort) {
        this.#activeAborts.delete(attempt.runId);
      }
    }
  }

  async #executeVisual(
    claim: ClaimedVisualRun,
    supervisor: VisualSupervisorPort,
  ): Promise<void> {
    const attempt = attemptIdentity(claim);
    this.#activeVisualRuns.add(attempt.runId);
    const sample = claim.run.samplePlan[0] as SuperviseVisualInput["run"]["sample"] | undefined;
    let planned: VisualScratchPlan | null = null;
    let registered: StoreVisualProcessIdentity | null = null;
    let phase: "blocked" | "released" | "running" | null = null;
    let exited = false;
    let cleanupFinalized = false;
    let attemptState: "claimed" | "starting" | "running" = "claimed";
    let heartbeatError: Error | null = null;
    let heartbeat: NodeJS.Timeout | null = null;
    let result: VisualSupervisionResult | null = null;
    let cleanupReceipt: VisualScratchCleanupReceipt | null = null;
    let abort: AbortController | null = null;
    try {
      if (!sample || sample.sampleIndex !== 0) {
        throw dispatcherFailure(
          "visual_run_invalid",
          "A claimed visual run does not contain its one frozen sample.",
        );
      }
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
      abort = new AbortController();
      if (this.#activeAborts.has(attempt.runId)) {
        throw dispatcherFailure(
          "dispatcher_recovery_required",
          "A run already has an active in-process dispatcher owner.",
        );
      }
      this.#activeAborts.set(attempt.runId, abort);
      if (this.#store.isRunCancellationRequested(attempt.runId)) abort.abort();
      heartbeat = setInterval(() => {
        if (heartbeatError) return;
        const at = this.#now();
        try {
          if (this.#store.isRunCancellationRequested(attempt.runId)) {
            this.#revokeVisualAccess(attempt.runId);
            abort?.abort();
            return;
          }
          this.#store.heartbeatRunAttempt({
            ...attempt,
            expectedState: "running",
            heartbeatAt: at.toISOString(),
            leaseExpiresAt: new Date(at.getTime() + this.#leaseMs).toISOString(),
          });
          if (registered && (phase === "released" || phase === "running")) {
            this.#store.heartbeatVisualProcess({
              ...registered,
              expectedState: phase,
              heartbeatAt: at.toISOString(),
            });
          }
        } catch (error) {
          heartbeatError = error instanceof Error ? error : new Error("Visual dispatcher heartbeat failed.");
          try {
            this.#revokeVisualAccess(attempt.runId);
          } catch (revokeError) {
            heartbeatError = asError(revokeError);
          }
          abort?.abort();
        }
      }, Math.max(250, Math.floor(this.#leaseMs / 3)));
      heartbeat.unref?.();
      result = await supervisor.supervise({
        run: {
          runId: claim.run.id,
          runKind: "visual",
          sample,
          limits: claim.run.limits as RunLimitsV1,
        },
        project,
        signal: abort.signal,
        hooks: {
          planScratch: async (plan) => {
            const manifest = this.#store.prepareVisualProcessLaunch({
              ...attempt,
              ...plan,
              createdAt: this.#now().toISOString(),
            });
            planned = plan;
            return manifest;
          },
          registerScratchDirectory: async (identity) => {
            this.#store.registerVisualScratchDirectory({
              ...attempt,
              ...identity,
              registeredAt: this.#now().toISOString(),
            });
          },
          registerProcess: async (identity, launchReceipt) => {
            const durable = storeVisualProcessIdentity(attempt, identity);
            this.#store.registerVisualProcessAttempt({
              ...durable,
              launchedAt: launchReceipt.createdAt,
              launchReceipt,
            });
            registered = durable;
            phase = "blocked";
          },
          markGateReleased: async (identity) => {
            const durable = requiredVisualIdentity(registered, identity);
            this.#store.markVisualProcessGateReleased({
              ...durable,
              startedAt: this.#now().toISOString(),
            });
            phase = "released";
          },
          markProcessStarted: async (identity) => {
            const durable = requiredVisualIdentity(registered, identity);
            this.#store.markVisualProcessStarted({
              ...durable,
              startedAt: this.#now().toISOString(),
            });
            phase = "running";
          },
          recordHealth: async (identity) => {
            const durable = requiredVisualIdentity(registered, identity);
            this.#store.recordVisualProcessHealth({
              ...durable,
              healthyAt: this.#now().toISOString(),
            });
          },
        },
      });
      if (heartbeatError) throw dispatcherFailure(
        "dispatcher_heartbeat_failed",
        "The durable visual dispatcher heartbeat failed.",
        heartbeatError,
      );
      if (!registered) {
        if (result.identity || result.status === "succeeded" || !planned) {
          throw dispatcherFailure(
            "dispatcher_recovery_required",
            "A visual supervisor result lacks its exact durable launch identity.",
          );
        }
        cleanupReceipt = supervisor.cleanup(result);
        this.#store.finalizeUnlaunchedVisualScratchLease({
          ...attempt,
          ...planned,
          cleanupReceiptDigest: cleanupReceipt.receiptDigest,
          cleanedAt: cleanupReceipt.cleanedAt,
        });
        planned = null;
        this.#revokeVisualAccess(attempt.runId);
        this.#store.finalizeVisualRunTerminal({
          ...attempt,
          expectedAttemptState: "running",
          status: result.status === "timed_out" ? "timed_out" : "failed",
          terminalCode: result.code,
          terminalDiagnostics: {
            code: result.code,
            diagnostic: result.diagnostic,
          },
          resourceOverview: visualResourceOverview(result),
          finishedAt: result.finishedAt,
        });
        return;
      }

      let outputBytes: Array<{ candidate: VisualOutputCandidate; bytes: Buffer }> = [];
      let terminalOverride: { status: "failed"; code: string; diagnostic: string } | null = null;
      if (result.status === "succeeded") {
        try {
          outputBytes = result.outputs.map((candidate) => ({
            candidate,
            bytes: this.#consumeVisualOutput(candidate),
          }));
        } catch {
          terminalOverride = {
            status: "failed",
            code: "run_output_invalid",
            diagnostic: "A validated visual output changed before durable publication.",
          };
        }
      }

      this.#recordVisualResultExit(result, registered, phase);
      exited = true;
      cleanupReceipt = supervisor.cleanup(result);
      this.#store.finalizeVisualProcessCleanup({
        ...registered,
        cleanupVerified: true,
        cleanupReceiptDigest: cleanupReceipt.receiptDigest,
        cleanedAt: cleanupReceipt.cleanedAt,
      });
      cleanupFinalized = true;

      const diagnostics = {
        code: terminalOverride?.code ?? result.code,
        diagnostic: terminalOverride?.diagnostic ?? result.diagnostic,
      };
      const resources = visualResourceOverview(result);
      if (result.status === "succeeded" && !terminalOverride) {
        try {
          this.#revokeVisualAccess(attempt.runId);
          this.#store.commitVisualRunSuccess({
            ...attempt,
            outputs: outputBytes.map(({ candidate, bytes }) => ({
              sampleIndex: 0,
              sampleId: sample.sampleId,
              logicalName: candidate.logicalName,
              outputType: candidate.role,
              bytes,
            })),
            terminalDiagnostics: diagnostics,
            resourceOverview: resources,
            finishedAt: result.finishedAt,
          });
          return;
        } catch (error) {
          throw dispatcherFailure(
            "visual_publication_failed",
            "Atomic visual success publication failed.",
            error,
          );
        }
      }
      const terminal = terminalOverride ?? result;
      this.#revokeVisualAccess(attempt.runId);
      this.#store.finalizeVisualRunTerminal({
        ...attempt,
        expectedAttemptState: "running",
        status: terminal.status === "timed_out" ? "timed_out" : "failed",
        terminalCode: terminal.code,
        terminalDiagnostics: diagnostics,
        resourceOverview: resources,
        finishedAt: result.finishedAt,
      });
    } catch (error) {
      abort?.abort();
      const failure = asError(error);
      const code = dispatcherErrorCode(failure);
      const finishedAt = this.#now().toISOString();
      const safeToFinalize = this.#bestEffortVisualUnwind({
        attempt,
        projectId: claim.run.projectId,
        attemptState,
        planned,
        registered,
        phase,
        exited,
        cleanupFinalized,
        result,
        cleanupReceipt,
        terminalCode: code,
        finishedAt,
        supervisor,
      });
      if (!safeToFinalize) {
        throw dispatcherFailure(
          "dispatcher_recovery_required",
          "Visual dispatcher unwind could not prove every launch, process, and scratch lease exited and was cleaned.",
          failure,
        );
      }
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      if (abort && this.#activeAborts.get(attempt.runId) === abort) {
        this.#activeAborts.delete(attempt.runId);
      }
      this.#activeVisualRuns.delete(attempt.runId);
    }
  }

  #bestEffortVisualUnwind(input: {
    attempt: RunAttemptIdentity;
    projectId: string;
    attemptState: "claimed" | "starting" | "running";
    planned: VisualScratchPlan | null;
    registered: StoreVisualProcessIdentity | null;
    phase: "blocked" | "released" | "running" | null;
    exited: boolean;
    cleanupFinalized: boolean;
    result: VisualSupervisionResult | null;
    cleanupReceipt: VisualScratchCleanupReceipt | null;
    terminalCode: string;
    finishedAt: string;
    supervisor: VisualSupervisorPort;
  }): boolean {
    try {
      this.#revokeVisualAccess(input.attempt.runId);
    } catch {
      return false;
    }
    if (!input.result) {
      if (input.registered || input.planned) return false;
    } else {
      if (!input.registered) {
        if (input.result.identity) return false;
        try {
          input.cleanupReceipt ??= input.supervisor.cleanup(input.result);
          if (!input.planned) return false;
          this.#store.finalizeUnlaunchedVisualScratchLease({
            ...input.attempt,
            ...input.planned,
            cleanupReceiptDigest: input.cleanupReceipt.receiptDigest,
            cleanedAt: input.cleanupReceipt.cleanedAt,
          });
        } catch {
          return false;
        }
        input.planned = null;
      }
      if (input.registered && !input.exited) {
        try {
          this.#recordVisualResultExit(input.result, input.registered, input.phase);
          input.exited = true;
        } catch {
          return false;
        }
      }
      if (input.registered && !input.cleanupFinalized) {
        let cleanup = input.cleanupReceipt;
        if (!cleanup) {
          try {
            cleanup = input.supervisor.cleanup(input.result);
          } catch {
            return false;
          }
        }
        try {
          this.#store.finalizeVisualProcessCleanup({
            ...input.registered,
            cleanupVerified: true,
            cleanupReceiptDigest: cleanup.receiptDigest,
            cleanedAt: cleanup.cleanedAt,
          });
          input.cleanupFinalized = true;
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
        return true;
      }
    } catch {
      // Continue to the exact terminal compare-and-set when current state is not provable.
    }
    if (input.attemptState === "claimed") return false;
    try {
      this.#store.finalizeVisualRunTerminal({
        ...input.attempt,
        expectedAttemptState: input.attemptState,
        status: "failed",
        terminalCode: input.terminalCode,
        terminalDiagnostics: {
          code: input.terminalCode,
          diagnostic: "The visual dispatcher failed and completed its best-effort unwind.",
        },
        resourceOverview: input.result ? visualResourceOverview(input.result) : {},
        finishedAt: input.result?.finishedAt ?? input.finishedAt,
      });
      return true;
    } catch {
      return false;
    }
  }

  #recordVisualResultExit(
    result: VisualSupervisionResult,
    registered: StoreVisualProcessIdentity,
    phase: "blocked" | "released" | "running" | null,
  ): void {
    assertVisualResultIdentity(result, registered);
    if (!phase) {
      throw dispatcherFailure(
        "dispatcher_recovery_required",
        "A registered visual process lacks its durable launch phase.",
      );
    }
    this.#store.recordVisualProcessExit({
      ...registered,
      expectedState: phase,
      exitedAt: result.finishedAt,
      exitCode: result.exitCode,
      exitSignal: result.signal,
    });
  }

  #revokeVisualAccess(runId: string): void {
    this.#revokeVisualAccessHook(runId);
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

const attemptIdentity = (
  claim: ClaimedBatchRun | ClaimedVisualRun,
): RunAttemptIdentity => ({
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

const storeVisualProcessIdentity = (
  attempt: RunAttemptIdentity,
  identity: SupervisorVisualProcessIdentity,
): StoreVisualProcessIdentity => ({
  ...attempt,
  processKind: "visual",
  processAttemptId: identity.processAttemptId,
  pid: identity.pid,
  processStartToken: identity.processStartToken,
  processGroupId: identity.processGroupId,
  loopbackPort: identity.loopbackPort,
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

const requiredVisualIdentity = (
  registered: StoreVisualProcessIdentity | null,
  identity: SupervisorVisualProcessIdentity,
): StoreVisualProcessIdentity => {
  if (!registered
    || registered.processAttemptId !== identity.processAttemptId
    || registered.runId !== identity.runId
    || registered.scratchId !== identity.scratchId
    || registered.pid !== identity.pid
    || registered.processGroupId !== identity.processGroupId
    || registered.processStartToken !== identity.processStartToken
    || registered.loopbackPort !== identity.loopbackPort) {
    throw dispatcherFailure(
      "dispatcher_recovery_required",
      "The visual process hook identity changed after durable registration.",
    );
  }
  return registered;
};

const assertVisualResultIdentity = (
  result: VisualSupervisionResult,
  registered: StoreVisualProcessIdentity,
): void => {
  const identity = result.identity;
  if (!identity
    || identity.processAttemptId !== registered.processAttemptId
    || identity.runId !== registered.runId
    || identity.scratchId !== registered.scratchId
    || identity.pid !== registered.pid
    || identity.processGroupId !== registered.processGroupId
    || identity.processStartToken !== registered.processStartToken) {
    throw dispatcherFailure(
      "dispatcher_recovery_required",
      "A registered visual process has no matching terminal supervisor identity.",
    );
  }
};

const visualResourceOverview = (
  result: VisualSupervisionResult,
): Readonly<Record<string, number | boolean>> => Object.freeze({
  stdoutBytes: result.stdoutBytes,
  stderrBytes: result.stderrBytes,
  stdoutTruncated: result.stdoutTruncated,
  stderrTruncated: result.stderrTruncated,
  healthVerified: result.healthVerified,
});

const asError = (error: unknown): Error =>
  error instanceof Error ? error : new Error("Product run dispatcher failed.");

const dispatcherErrorCode = (error: Error): string => {
  const prefixed = /^([a-z][a-z0-9_]*):/u.exec(error.message)?.[1];
  return prefixed ?? "batch_supervisor_failed";
};

const dispatcherFailure = (code: string, message: string, cause?: unknown): Error =>
  new Error(`${code}: ${message}`, cause === undefined ? undefined : { cause });
