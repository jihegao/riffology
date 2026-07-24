import { canonicalDigest } from "./canonical-json-v2.ts";
import type {
  BatchLaunchReceipt,
  BatchProcessIdentity,
  BatchScratchPlan,
  DurableBatchScratchLease,
  GenericBatchSupervisor,
  RecoveredProcessTerminationReceipt,
  RecoveredScratchCleanupReceipt,
} from "./generic-batch-supervisor.ts";
import {
  ProductStoreV2,
  type PriorDispatcherRecoveryUnit,
  type RecoveryProcessRecord,
  type RunAttemptIdentity,
} from "./product-store-v2.ts";

export type ProductRunRecoverySupervisorPort = Pick<
  GenericBatchSupervisor,
  | "inspectRecordedProcess"
  | "terminateRecordedProcess"
  | "verifyRecordedProcessGroupGone"
  | "readDurableLaunchReceipt"
  | "cleanupDurableScratch"
  | "cleanupPlannedScratch"
>;

export type ProductRunRecoveryOptions = Readonly<{
  store: ProductStoreV2;
  supervisor: Partial<ProductRunRecoverySupervisorPort>;
  now?: () => Date;
}>;

export class ProductRunRecoveryError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(`${code}: ${message}`, options);
    this.name = "ProductRunRecoveryError";
    this.code = code;
  }
}

/**
 * Reconciles only durable v4 run-attempt evidence. MutationCoordinator recovery
 * has already run in ProductStoreV2.open(), so successful bytes/indexes are
 * audited before any prior runtime identity is inspected or signalled.
 */
export class ProductRunRecovery {
  readonly #store: ProductStoreV2;
  readonly #supervisor: Partial<ProductRunRecoverySupervisorPort>;
  readonly #now: () => Date;

  constructor(options: ProductRunRecoveryOptions) {
    this.#store = options.store;
    this.#supervisor = options.supervisor;
    this.#now = options.now ?? (() => new Date());
  }

  async recoverBeforeGenerationActivation(candidateDispatcherGeneration: string): Promise<void> {
    if (!/^[0-9a-f]{64}$/u.test(candidateDispatcherGeneration)) {
      throw new ProductRunRecoveryError("dispatcher_recovery_required", "The candidate dispatcher generation is invalid.");
    }
    this.#store.auditRecoveredBatchSuccesses();
    while (this.#store.finalizeNextCancelledQueuedRun({
      finishedAt: this.#now().toISOString(),
    })) {
      // Drain every committed queued cancellation without creating an attempt.
    }
    const units = this.#store.listPriorDispatcherRecoveryUnits();
    if (!units.length) return;
    const supervisor = requireRecoverySupervisor(this.#supervisor);
    for (const unit of units) {
      await this.#recoverUnit(unit, candidateDispatcherGeneration, supervisor);
    }
  }

  async #recoverUnit(
    unit: PriorDispatcherRecoveryUnit,
    candidateDispatcherGeneration: string,
    supervisor: ProductRunRecoverySupervisorPort,
  ): Promise<void> {
    const attempt = attemptIdentity(unit);
    const actionId = this.#store.beginRunRecovery({
      attemptId: attempt.attemptId,
      priorDispatcherGeneration: attempt.dispatcherGeneration,
      candidateDispatcherGeneration,
      createdAt: this.#now().toISOString(),
    });
    const processReceipts: RecoveredProcessTerminationReceipt[] = [];
    const scratchReceipts: RecoveredScratchCleanupReceipt[] = [];
    try {
      const processes = [...unit.processes];
      for (const pending of unit.pendingLaunches) {
        const lease = pending.scratchLease;
        if (lease.state === "planned") {
          const receipt = supervisor.cleanupPlannedScratch(scratchPlan(lease), this.#now().toISOString());
          this.#store.finalizeUnlaunchedScratchLease({
            leaseId: lease.id,
            runAttemptId: attempt.attemptId,
            receipt,
          });
          scratchReceipts.push(receipt);
          continue;
        }
        if (lease.state !== "created" || lease.ownerUid === null
          || lease.device === null || lease.inode === null || lease.registeredAt === null) {
          throw new ProductRunRecoveryError(
            "dispatcher_recovery_required",
            "A pending launch has contradictory scratch evidence.",
          );
        }
        const durableLease = durableLeaseOf(lease);
        const launchReceipt = supervisor.readDurableLaunchReceipt(
          durableLease,
          pending.launchManifest,
        );
        if (!launchReceipt) {
          throw new ProductRunRecoveryError(
            "dispatcher_recovery_required",
            "A created scratch lease has no durable launch receipt; spawn cannot be excluded.",
          );
        }
        const processAttemptId = processAttemptIdFor(attempt, launchReceipt.sampleIndex);
        this.#store.adoptRecoveredLaunchReceipt({
          ...attempt,
          processAttemptId,
          launchReceipt,
          launchedAt: launchReceipt.createdAt,
        });
        processes.push(recoveryProcessFromReceipt(unit, launchReceipt, processAttemptId, durableLease, pending.launchManifest));
      }

      for (const process of processes) {
        if (process.state === "cleanup_unverified") {
          throw new ProductRunRecoveryError(
            "dispatcher_recovery_required",
            "A prior process has terminal unverified cleanup evidence.",
          );
        }
        if (process.state === "cleanup_complete") continue;
        const identity = supervisorIdentity(process);
        // Inspection is deliberately separate so identity mismatch is observed
        // before any signal API is entered.
        supervisor.inspectRecordedProcess(identity);
        const termination = await supervisor.terminateRecordedProcess(
          identity,
          Number(unit.run.limits.terminationGraceMs),
          this.#now().toISOString(),
        );
        supervisor.verifyRecordedProcessGroupGone(identity);
        processReceipts.push(termination);
        if (process.state !== "exited") {
          this.#store.recordBatchProcessExit({
            ...process,
            expectedState: process.state,
            exitedAt: termination.observedAt,
            exitCode: null,
            exitSignal: termination.killSent
              ? "SIGKILL"
              : termination.termSent
                ? "SIGTERM"
                : "recovery_observed_gone",
          });
        }
        const scratch = supervisor.cleanupDurableScratch(
          process.scratchLease,
          this.#now().toISOString(),
        );
        scratchReceipts.push(scratch);
        this.#store.finalizeBatchProcessCleanup({
          ...process,
          cleanupVerified: true,
          cleanupReceiptDigest: scratch.receiptDigest,
          cleanedAt: scratch.cleanedAt,
        });
      }

      const disposition = unit.run.cancelRequestedAt === null ? "interrupted" : "cancelled";
      this.#store.completeRecoveredRun({
        ...attempt,
        recoveryActionId: actionId,
        disposition,
        processReceipts,
        scratchReceipts,
        finishedAt: this.#now().toISOString(),
      });
    } catch (error) {
      try {
        this.#store.failRunRecovery({
          recoveryActionId: actionId,
          attemptId: attempt.attemptId,
          failedAt: this.#now().toISOString(),
        });
      } catch {
        // Preserve the first recovery failure; the durable live attempt still
        // prevents generation activation.
      }
      if (error instanceof ProductRunRecoveryError) throw error;
      throw new ProductRunRecoveryError(
        "dispatcher_recovery_required",
        "Prior dispatcher runtime reconciliation failed closed.",
        { cause: error },
      );
    }
  }
}

const requireRecoverySupervisor = (
  port: Partial<ProductRunRecoverySupervisorPort>,
): ProductRunRecoverySupervisorPort => {
  for (const name of [
    "inspectRecordedProcess",
    "terminateRecordedProcess",
    "verifyRecordedProcessGroupGone",
    "readDurableLaunchReceipt",
    "cleanupDurableScratch",
    "cleanupPlannedScratch",
  ] as const) {
    if (typeof port[name] !== "function") {
      throw new ProductRunRecoveryError(
        "dispatcher_recovery_required",
        `The batch supervisor lacks ${name} for cross-restart recovery.`,
      );
    }
  }
  return port as ProductRunRecoverySupervisorPort;
};

const attemptIdentity = (unit: PriorDispatcherRecoveryUnit): RunAttemptIdentity => ({
  runId: unit.run.id,
  attemptId: unit.attempt.id,
  attemptGeneration: unit.attempt.attemptGeneration,
  dispatcherGeneration: unit.attempt.dispatcherGeneration,
});

const processAttemptIdFor = (attempt: RunAttemptIdentity, sampleIndex: number): string =>
  `process_${canonicalDigest({
    runId: attempt.runId,
    attemptGeneration: attempt.attemptGeneration,
    sampleIndex,
  }).slice(0, 32)}`;

const scratchPlan = (lease: PriorDispatcherRecoveryUnit["scratchLeases"][number]): BatchScratchPlan => ({
  runId: lease.runId,
  sampleIndex: lease.sampleIndex,
  sampleId: lease.sampleId,
  scratchId: lease.id,
  relativePath: lease.relativePath,
});

const durableLeaseOf = (
  lease: PriorDispatcherRecoveryUnit["scratchLeases"][number],
): DurableBatchScratchLease => {
  if (lease.ownerUid === null || lease.device === null || lease.inode === null || lease.registeredAt === null) {
    throw new ProductRunRecoveryError("dispatcher_recovery_required", "A durable scratch lease lacks filesystem identity.");
  }
  return Object.freeze({
    ...scratchPlan(lease),
    ownerUid: lease.ownerUid,
    device: lease.device,
    inode: lease.inode,
    registeredAt: lease.registeredAt,
  });
};

const supervisorIdentity = (process: RecoveryProcessRecord): BatchProcessIdentity => ({
  runId: process.runId,
  sampleIndex: process.sampleIndex,
  sampleId: process.sampleId,
  scratchId: process.scratchId,
  pid: process.pid,
  processGroupId: process.processGroupId,
  startToken: process.processStartToken,
});

const recoveryProcessFromReceipt = (
  unit: PriorDispatcherRecoveryUnit,
  receipt: BatchLaunchReceipt,
  processAttemptId: string,
  scratchLease: DurableBatchScratchLease,
  launchManifest: RecoveryProcessRecord["launchManifest"],
): RecoveryProcessRecord => Object.freeze({
  runId: unit.run.id,
  attemptId: unit.attempt.id,
  attemptGeneration: unit.attempt.attemptGeneration,
  dispatcherGeneration: unit.attempt.dispatcherGeneration,
  processAttemptId,
  sampleIndex: receipt.sampleIndex,
  sampleId: receipt.sampleId,
  pid: receipt.pid,
  processStartToken: receipt.processStartToken,
  processGroupId: receipt.processGroupId,
  scratchId: receipt.scratchId,
  scratchLease,
  launchManifest,
  state: "blocked",
  exitCode: null,
  exitSignal: null,
});
