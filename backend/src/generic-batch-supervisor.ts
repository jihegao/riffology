import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";
import { canonicalDigest, canonicalJsonV2, sha256Hex } from "./canonical-json-v2.ts";
import {
  assertRunCapabilityV2,
  batchProcessArguments,
  resolveBatchOutputPathsV1,
  validateBatchInputV1,
  validateExecutionDescriptionV2,
  type BatchInputV1,
  type ExecutionDescriptionV2,
  type ExecutionOutputV2,
} from "./execution-protocol-v2.ts";
import {
  canonicalRestrictedExecutable,
  macosBatchSandboxProfile,
  trustedPythonRuntimeRoots,
  type ModelWorkspaceCapability,
} from "./restricted-process.ts";
import type { RunLimitsV1 } from "./product-store-v2.ts";

export type FrozenBatchSample = Readonly<{
  sampleIndex: number;
  sampleId: string;
  parameters: BatchInputV1["parameters"];
  seed: number | null;
}>;

export type FrozenBatchRun = Readonly<{
  runId: string;
  runKind: "batch";
  samples: readonly FrozenBatchSample[];
  limits: RunLimitsV1;
}>;

/**
 * Capability for the exact Project-owned `model-snapshot/` execution root.
 * `code/` and `environment/` are direct children; an object-store or Project
 * owner root is deliberately not this capability.
 */
export type VerifiedProjectExecutionRootCapability = ModelWorkspaceCapability & Readonly<{
  capabilityKind: "verified-project-execution-root-v1";
  expectedExecutionRootDigest: string;
}>;

export type BatchProcessIdentity = Readonly<{
  runId: string;
  sampleIndex: number;
  sampleId: string;
  scratchId: string;
  pid: number;
  processGroupId: number;
  startToken: string;
}>;

export type BatchScratchPlan = Readonly<{
  runId: string;
  sampleIndex: number;
  sampleId: string;
  scratchId: string;
  relativePath: string;
}>;

export type BatchScratchDirectoryIdentity = BatchScratchPlan & Readonly<{
  ownerUid: number;
  device: number;
  inode: number;
}>;

export type BatchLaunchManifestBinding = Readonly<{
  manifestId: string;
  manifestDigest: string;
}>;

export type BatchLaunchReceipt = Readonly<{
  schemaVersion: 1;
  manifestId: string;
  manifestDigest: string;
  runId: string;
  sampleIndex: number;
  sampleId: string;
  scratchId: string;
  relativePath: string;
  pid: number;
  processGroupId: number;
  processStartToken: string;
  createdAt: string;
  receiptDigest: string;
}>;

export type DurableBatchScratchLease = BatchScratchDirectoryIdentity & Readonly<{
  registeredAt: string;
}>;

export type RecoveredProcessTerminationReceipt = Readonly<{
  schemaVersion: 1;
  runId: string;
  sampleIndex: number;
  sampleId: string;
  scratchId: string;
  pid: number;
  processGroupId: number;
  processStartToken: string;
  termSent: boolean;
  killSent: boolean;
  groupGone: true;
  observedAt: string;
  receiptDigest: string;
}>;

export type RecoveredScratchCleanupReceipt = Readonly<{
  schemaVersion: 1;
  runId: string;
  sampleIndex: number;
  sampleId: string;
  scratchId: string;
  relativePath: string;
  disposition: "removed" | "already_absent";
  cleanedAt: string;
  verified: true;
  receiptDigest: string;
}>;

export type BatchSupervisorHooks = Readonly<{
  planScratch?: (plan: BatchScratchPlan) => Promise<BatchLaunchManifestBinding>;
  registerScratchDirectory?: (identity: BatchScratchDirectoryIdentity) => Promise<void>;
  registerProcess?: (identity: BatchProcessIdentity, receipt: BatchLaunchReceipt) => Promise<void>;
  markGateReleased?: (identity: BatchProcessIdentity) => Promise<void>;
  markProcessStarted?: (identity: BatchProcessIdentity) => Promise<void>;
}>;

export type BatchOutputCandidate = Readonly<{
  sampleIndex: number;
  sampleId: string;
  logicalName: string;
  relativePath: string;
  mediaType: string;
  role: ExecutionOutputV2["role"];
  sourcePath: string;
  scratchPath: string;
  sizeBytes: number;
  sha256: string;
  owner: number;
  device: number;
  inode: number;
}>;

export type BatchSampleResult = Readonly<{
  sampleIndex: number;
  sampleId: string;
  status: "succeeded" | "failed" | "timed_out" | "not_started";
  code: string;
  diagnostic: string;
  identity: BatchProcessIdentity | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  scratchId: string;
  scratchPath: string;
  outputs: readonly BatchOutputCandidate[];
}>;

export type BatchSupervisionResult = Readonly<{
  runId: string;
  status: "succeeded" | "failed" | "timed_out";
  code: string;
  diagnostic: string;
  startedAt: string;
  finishedAt: string;
  samples: readonly BatchSampleResult[];
  outputs: readonly BatchOutputCandidate[];
  resources: Readonly<{
    maxConcurrencyObserved: number;
    stdoutBytes: number;
    stderrBytes: number;
    outputFiles: number;
    outputBytes: number;
  }>;
}>;

export type BatchScratchCleanupReceipt = Readonly<{
  schemaVersion: 1;
  runId: string;
  scratchIds: readonly string[];
  cleanedAt: string;
  verified: true;
  receiptDigest: string;
}>;

export type GenericBatchSupervisorOptions = Readonly<{
  pythonExecutable: string;
  scratchRoot: string;
  registrationTimeoutMs?: number;
  now?: () => number;
  faultInjector?: (
    checkpoint:
      | "after_execution_root_verified"
      | "after_scratch_lease_planned"
      | "after_scratch_directory_registered"
      | "after_execution_root_copied"
      | "after_launch_receipt_persisted"
      | "before_output_discovery",
    paths: Readonly<{ projectRoot: string; projectCopy?: string; outputDirectory?: string }>,
  ) => void;
}>;

export type SuperviseBatchInput = Readonly<{
  run: FrozenBatchRun;
  project: Readonly<{
    workspace: VerifiedProjectExecutionRootCapability;
    executionDescription: ExecutionDescriptionV2;
  }>;
  hooks?: BatchSupervisorHooks;
  signal?: AbortSignal;
}>;

export class GenericBatchSupervisorError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GenericBatchSupervisorError";
    this.code = code;
  }
}

type MutableSample = {
  sampleIndex: number;
  sampleId: string;
  scratchId: string;
  scratchPath: string;
  identity: BatchProcessIdentity | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  startedAt: number;
  finishedAt: number;
  stdout: Buffer[];
  stderr: Buffer[];
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  outputs: BatchOutputCandidate[];
  status: BatchSampleResult["status"];
  code: string;
  diagnostic: string;
};

type ActiveProcess = {
  child: ChildProcess;
  identity: BatchProcessIdentity;
  completion: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>;
  closed: Promise<void>;
  groupContinuityLost: boolean;
  groupMonitor?: NodeJS.Timeout;
  termination?: Promise<void>;
};

type Fatal = { status: "failed" | "timed_out"; code: string; diagnostic: string };

const REGISTRATION_TIMEOUT_MS = 5_000;
const MAX_REGISTRATION_TIMEOUT_MS = 5_000;
const MAX_SNAPSHOT_FILES = 10_000;
const MAX_SNAPSHOT_BYTES = 512 * 1024 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/u;
const BASE_ENV = Object.freeze({
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  PYTHONHASHSEED: "0",
  PYTHONNOUSERSITE: "1",
  PYTHONDONTWRITEBYTECODE: "1",
  RIFF_EXECUTION_PROTOCOL: "riff-batch-v1",
  __CF_USER_TEXT_ENCODING: "0x0:0:0",
});

// Only platform code runs before fd 3 is released. The Model then receives the
// exact riff-batch-v1 argv vector produced by batchProcessArguments().
/**
 * Executes one immutable riff-batch-v1 process per frozen sample. This layer
 * deliberately has no ProductStore dependency at runtime: hooks are the
 * durable-registration seam and the returned candidates are not publication.
 */
export class GenericBatchSupervisor {
  readonly #python: string;
  readonly #runtimeReadRoots: readonly string[];
  readonly #pythonImportRoots: readonly string[];
  readonly #scratchRoot: string;
  readonly #registrationTimeoutMs: number;
  readonly #now: () => number;
  readonly #faultInjector?: GenericBatchSupervisorOptions["faultInjector"];
  readonly #scratchLeases = new Map<string, {
    runId: string;
    sampleIndex: number;
    sampleId: string;
    relativePath: string;
    path: string;
    identity: BatchProcessIdentity | null;
    exited: boolean;
    groupGoneVerified: boolean;
  }>();

  constructor(options: GenericBatchSupervisorOptions) {
    this.#python = canonicalRestrictedExecutable(options.pythonExecutable);
    this.#runtimeReadRoots = Object.freeze(trustedPythonRuntimeRoots(options.pythonExecutable, this.#python));
    this.#pythonImportRoots = Object.freeze(pythonImportRoots(options.pythonExecutable));
    this.#scratchRoot = canonicalOwnedDirectory(options.scratchRoot, "batch scratch root");
    const timeout = options.registrationTimeoutMs ?? REGISTRATION_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_REGISTRATION_TIMEOUT_MS) {
      throw new GenericBatchSupervisorError("invalid_batch_supervisor", "The launch-gate registration timeout is invalid.");
    }
    this.#registrationTimeoutMs = timeout;
    this.#now = options.now ?? Date.now;
    this.#faultInjector = options.faultInjector;
  }

  async supervise(input: SuperviseBatchInput): Promise<BatchSupervisionResult> {
    if (process.platform !== "darwin") {
      throw new GenericBatchSupervisorError(
        "network_isolation_unavailable",
        "Generic batch execution requires the macOS network-denying process boundary.",
      );
    }
    const description = validateExecutionDescriptionV2(input.project.executionDescription);
    assertRunCapabilityV2(description, "batch");
    if (description.batch?.domainEvents) {
      throw new GenericBatchSupervisorError(
        "domain_events_not_supported",
        "A3-1b batch execution does not admit domain-event declarations.",
      );
    }
    const run = validateFrozenRun(input.run);
    if (canonicalOwnedDirectory(this.#scratchRoot, "batch scratch root") !== this.#scratchRoot) {
      throw new GenericBatchSupervisorError("unsafe_batch_path", "The batch scratch root changed before execution.");
    }
    const projectRoot = assertVerifiedProjectExecutionRoot(input.project.workspace, description);
    this.#faultInjector?.("after_execution_root_verified", { projectRoot });
    const started = this.#now();
    const runDeadline = started + run.limits.wallTimeMs;
    const startedAt = new Date(started).toISOString();
    const active = new Map<number, ActiveProcess>();
    const results = new Map<number, MutableSample>();
    const outputIdentities = new Set<string>();
    let fatal: Fatal | null = null;
    let nextIndex = 0;
    let activeCount = 0;
    let maxConcurrencyObserved = 0;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputFiles = 0;
    let outputBytes = 0;

    const terminateAll = (): void => {
      for (const process of active.values()) {
        void terminateProcess(process, run.limits.terminationGraceMs).catch(() => {
          // Each owning sample awaits the same termination promise and records
          // the cleanup failure through its structured result.
        });
      }
    };
    const fail = (next: Fatal): void => {
      if (fatal) return;
      fatal = next;
      terminateAll();
    };
    const abortForDispatcherShutdown = (): void => fail({
      status: "failed",
      code: "dispatcher_shutdown",
      diagnostic: "The batch dispatcher shut down before the frozen run completed.",
    });
    input.signal?.addEventListener("abort", abortForDispatcherShutdown, { once: true });
    if (input.signal?.aborted) abortForDispatcherShutdown();
    const wallTimer = setTimeout(() => fail({
      status: "timed_out",
      code: "run_wall_timeout",
      diagnostic: "The frozen run wall-time budget expired.",
    }), boundedDelay(run.limits.wallTimeMs));
    wallTimer.unref?.();

    const appendStream = (sample: MutableSample, stream: "stdout" | "stderr", chunk: Buffer): void => {
      const isStdout = stream === "stdout";
      const used = isStdout ? stdoutBytes : stderrBytes;
      const limit = isStdout ? run.limits.maxStdoutBytes : run.limits.maxStderrBytes;
      const accepted = chunk.subarray(0, Math.max(0, limit - used));
      if (accepted.byteLength) {
        sample[stream].push(accepted);
        if (isStdout) stdoutBytes += accepted.byteLength;
        else stderrBytes += accepted.byteLength;
      }
      if (accepted.byteLength !== chunk.byteLength) {
        if (isStdout) sample.stdoutTruncated = true;
        else sample.stderrTruncated = true;
        fail({
          status: "failed",
          code: isStdout ? "run_stdout_limit" : "run_stderr_limit",
          diagnostic: `The frozen run ${stream} byte limit was exceeded.`,
        });
      }
    };

    const runSample = async (sample: FrozenBatchSample): Promise<void> => {
      if (fatal) return;
      const nonce = randomUUID().replaceAll("-", "");
      const scratchId = `scratch_${nonce}`;
      const relativePath = `riff-${safePrefix(run.runId)}-${sample.sampleIndex}-${nonce}`;
      const scratchPath = join(this.#scratchRoot, relativePath);
      const scratchPlan = Object.freeze({
        runId: run.runId,
        sampleIndex: sample.sampleIndex,
        sampleId: sample.sampleId,
        scratchId,
        relativePath,
      });
      const manifestBinding = await (input.hooks?.planScratch?.(scratchPlan)
        ?? Promise.resolve(localManifestBinding(scratchPlan)));
      assertManifestBinding(manifestBinding);
      this.#faultInjector?.("after_scratch_lease_planned", { projectRoot });
      mkdirSync(scratchPath, { recursive: false, mode: 0o700 });
      const scratchInfo = lstatSync(scratchPath);
      if (scratchInfo.isSymbolicLink() || !scratchInfo.isDirectory()
        || realpathSync(scratchPath) !== scratchPath || dirname(scratchPath) !== this.#scratchRoot) {
        throw new GenericBatchSupervisorError("unsafe_batch_path", "The planned scratch directory is unsafe.");
      }
      const scratchDirectoryIdentity = Object.freeze({
        ...scratchPlan,
        ownerUid: scratchInfo.uid,
        device: scratchInfo.dev,
        inode: scratchInfo.ino,
      });
      await (input.hooks?.registerScratchDirectory?.(scratchDirectoryIdentity) ?? Promise.resolve());
      this.#faultInjector?.("after_scratch_directory_registered", { projectRoot });
      const mutable = initialSample(sample, scratchId, scratchPath, this.#now());
      const scratchLease = {
        runId: run.runId,
        sampleIndex: sample.sampleIndex,
        sampleId: sample.sampleId,
        relativePath,
        path: scratchPath,
        identity: null as BatchProcessIdentity | null,
        exited: false,
        // No child exists yet. A successful spawn clears this until either
        // the unreleased gate closes or the verified group is proven gone.
        groupGoneVerified: true,
      };
      this.#scratchLeases.set(scratchId, scratchLease);
      results.set(sample.sampleIndex, mutable);
      let processCopyDigest = "";
      try {
        const projectCopy = join(scratchPath, "project");
        const outputDirectory = join(scratchPath, "output");
        const tempDirectory = join(scratchPath, "tmp");
        mkdirSync(projectCopy, { recursive: false, mode: 0o700 });
        mkdirSync(outputDirectory, { recursive: false, mode: 0o700 });
        mkdirSync(tempDirectory, { recursive: false, mode: 0o700 });
        const expectedRootDigest = input.project.workspace.expectedExecutionRootDigest;
        if (scanRegularTree(projectRoot, runDeadline, this.#now, "project_snapshot_corrupt").digest !== expectedRootDigest) {
          throw new GenericBatchSupervisorError("project_snapshot_corrupt", "The execution root changed before its sample copy.");
        }
        processCopyDigest = copyRegularTree(projectRoot, projectCopy, runDeadline, this.#now);
        this.#faultInjector?.("after_execution_root_copied", { projectRoot, projectCopy });
        if (processCopyDigest !== expectedRootDigest
          || scanRegularTree(projectRoot, runDeadline, this.#now, "project_snapshot_corrupt").digest !== expectedRootDigest) {
          throw new GenericBatchSupervisorError("project_snapshot_corrupt", "The execution root changed while its sample copy was captured.");
        }

        const batchInput = validateBatchInputV1({
          schemaVersion: 1,
          runId: run.runId,
          sampleIndex: sample.sampleIndex,
          sampleId: sample.sampleId,
          parameters: sample.parameters,
          seed: sample.seed,
        });
        const inputPath = join(scratchPath, "input.json");
        writeExclusiveRegular(inputPath, Buffer.concat([canonicalJsonV2(batchInput), Buffer.from("\n")]), 0o400);
        const argv = batchProcessArguments(description, inputPath, outputDirectory);
        const entryPath = resolve(projectCopy, description.batch!.entryPoint);
        assertContainedRegular(projectCopy, entryPath, "batch_entrypoint_invalid");

        const registrationDeadline = this.#now() + this.#registrationTimeoutMs;
        const launchNonce = `nonce_${randomUUID().replaceAll("-", "")}`;
        const launchReceiptPath = join(scratchPath, "launch-receipt.json");
        const launchReceiptBase = {
          schemaVersion: 1 as const,
          manifestId: manifestBinding.manifestId,
          manifestDigest: manifestBinding.manifestDigest,
          runId: run.runId,
          sampleIndex: sample.sampleIndex,
          sampleId: sample.sampleId,
          scratchId,
          relativePath,
          createdAt: new Date(this.#now()).toISOString(),
        };
        const child = this.#spawnGated(
          projectCopy,
          inputPath,
          outputDirectory,
          tempDirectory,
          launchReceiptPath,
          launchNonce,
          launchReceiptBase,
          argv,
        );
        if (!child.pid) throw new GenericBatchSupervisorError("process_spawn_failed", "The batch helper did not receive a PID.");
        scratchLease.groupGoneVerified = false;
        const lifecycle = observeChild(child);
        let identity: BatchProcessIdentity;
        let launchReceipt: BatchLaunchReceipt;
        try {
          await runGateHook(
            waitForLaunchReceiptSignal(child),
            registrationDeadline,
            this.#now,
            input.signal,
          );
          launchReceipt = bindLaunchReceiptToExactIdentity(validateLaunchReceipt(
            JSON.parse(readFileSync(launchReceiptPath, "utf8")),
            scratchDirectoryIdentity,
            manifestBinding,
          ));
          identity = readProcessIdentity(child.pid, {
            runId: run.runId,
            sampleIndex: sample.sampleIndex,
            sampleId: sample.sampleId,
            scratchId,
          });
          if (identity.pid !== launchReceipt.pid
            || identity.processGroupId !== launchReceipt.processGroupId
            || identity.startToken !== launchReceipt.processStartToken) {
            throw new GenericBatchSupervisorError("process_identity_mismatch", "The self-authored launch receipt differs from the OS process identity.");
          }
        } catch (error) {
          closeGateWithoutRelease(child);
          await runGateHook(lifecycle.completion, registrationDeadline, this.#now);
          await runGateHook(lifecycle.closed, registrationDeadline, this.#now);
          scratchLease.groupGoneVerified = true;
          throw error;
        }
        mutable.identity = identity;
        scratchLease.identity = identity;
        const tracked: ActiveProcess = {
          child,
          identity,
          completion: lifecycle.completion,
          closed: lifecycle.closed,
          groupContinuityLost: false,
        };
        startProcessGroupMonitor(tracked);
        active.set(identity.pid, tracked);
        activeCount += 1;
        maxConcurrencyObserved = Math.max(maxConcurrencyObserved, activeCount);
        child.stdout!.on("data", (chunk: Buffer) => appendStream(mutable, "stdout", Buffer.from(chunk)));
        child.stderr!.on("data", (chunk: Buffer) => appendStream(mutable, "stderr", Buffer.from(chunk)));

        this.#faultInjector?.("after_launch_receipt_persisted", { projectRoot, projectCopy });
        await runGateHook(
          input.hooks?.registerProcess?.(identity, launchReceipt) ?? Promise.resolve(),
          registrationDeadline,
          this.#now,
          input.signal,
        );
        if (!sameIdentity(identity, readProcessIdentity(identity.pid, {
          runId: run.runId,
          sampleIndex: sample.sampleIndex,
          sampleId: sample.sampleId,
          scratchId,
        }, identity.startToken))) {
          throw new GenericBatchSupervisorError("process_identity_mismatch", "The launch-gate process identity changed before release.");
        }
        await runGateHook(
          input.hooks?.markGateReleased?.(identity) ?? Promise.resolve(),
          registrationDeadline,
          this.#now,
          input.signal,
        );
        const startedSignal = waitForStartedSignal(child);
        releaseGate(child);
        await runGateHook(startedSignal, registrationDeadline, this.#now, input.signal);
        await runGateHook(
          input.hooks?.markProcessStarted?.(identity) ?? Promise.resolve(),
          registrationDeadline,
          this.#now,
          input.signal,
        );

        const completion = await tracked.completion;
        mutable.exitCode = completion.exitCode;
        mutable.signal = completion.signal;
        const groupState = verifyProcessGroupTarget(tracked);
        const descendantSurvivedLeader = groupState === "present";
        if (groupState === "present") {
          await terminateProcess(tracked, run.limits.terminationGraceMs);
        }
        scratchLease.groupGoneVerified = verifyProcessGroupTarget(tracked) === "gone";
        if (!scratchLease.groupGoneVerified) {
          throw new GenericBatchSupervisorError("process_cleanup_unverified", "The batch process group remains after termination.");
        }
        await tracked.closed;
        stopProcessGroupMonitor(tracked);
        active.delete(identity.pid);
        activeCount -= 1;

        if (fatal) {
          applyFatal(mutable, fatal);
          return;
        }
        if (descendantSurvivedLeader) {
          const next: Fatal = {
            status: "failed",
            code: "batch_process_descendant",
            diagnostic: `Sample ${sample.sampleIndex} left a descendant in its process group.`,
          };
          fail(next);
          applyFatal(mutable, next);
          return;
        }
        if (completion.exitCode !== 0 || completion.signal !== null) {
          const next: Fatal = {
            status: "failed",
            code: "batch_process_failed",
            diagnostic: `Sample ${sample.sampleIndex} exited without successful completion.`,
          };
          fail(next);
          applyFatal(mutable, next);
          return;
        }
        if (scanRegularTree(projectCopy, runDeadline, this.#now).digest !== processCopyDigest) {
          const next: Fatal = {
            status: "failed",
            code: "batch_scratch_violation",
            diagnostic: `Sample ${sample.sampleIndex} changed its copied Project tree.`,
          };
          fail(next);
          applyFatal(mutable, next);
          return;
        }

        this.#faultInjector?.("before_output_discovery", { projectRoot, projectCopy, outputDirectory });
        const validated = validateOutputCandidates({
          description,
          outputDirectory,
          sample,
          outputIdentities,
          remainingFiles: run.limits.maxOutputFiles - outputFiles,
          remainingBytes: run.limits.maxOutputBytes - outputBytes,
          deadline: runDeadline,
          now: this.#now,
        });
        outputFiles += validated.fileCount;
        outputBytes += validated.totalBytes;
        mutable.outputs.push(...validated.candidates);
        mutable.status = "succeeded";
        mutable.code = "batch_sample_succeeded";
        mutable.diagnostic = `Sample ${sample.sampleIndex} produced every required declared output.`;
      } catch (error) {
        let caught = error;
        if (mutable.identity) {
          const tracked = active.get(mutable.identity.pid);
          if (tracked) {
            try {
              await terminateProcess(tracked, run.limits.terminationGraceMs);
              const completion = await tracked.completion;
              mutable.exitCode = completion.exitCode;
              mutable.signal = completion.signal;
              scratchLease.groupGoneVerified = verifyProcessGroupTarget(tracked) === "gone";
              if (!scratchLease.groupGoneVerified) {
                throw new GenericBatchSupervisorError("process_cleanup_unverified", "The failed batch process group remains after termination.");
              }
              await tracked.closed;
            } catch (cleanupError) {
              caught = cleanupError;
            }
            stopProcessGroupMonitor(tracked);
            active.delete(mutable.identity.pid);
            activeCount = Math.max(0, activeCount - 1);
          }
        }
        const next = supervisorFailure(caught);
        fail(next);
        applyFatal(mutable, fatal ?? next);
      } finally {
        scratchLease.exited = scratchLease.groupGoneVerified;
        mutable.finishedAt = this.#now();
      }
    };

    const worker = async (): Promise<void> => {
      while (true) {
        if (fatal) return;
        const cursor = nextIndex;
        nextIndex += 1;
        if (cursor >= run.samples.length) return;
        await runSample(run.samples[cursor]!);
      }
    };

    try {
      const workers = Math.min(run.limits.maxConcurrency, run.samples.length);
      await Promise.all(Array.from({ length: workers }, () => worker()));
    } finally {
      clearTimeout(wallTimer);
      input.signal?.removeEventListener("abort", abortForDispatcherShutdown);
      terminateAll();
    }

    const finalFatal = fatal as Fatal | null;
    for (const sample of run.samples) {
      if (results.has(sample.sampleIndex)) continue;
      const scratchId = `not-started-${sample.sampleIndex}`;
      const value = initialSample(sample, scratchId, "", started);
      value.finishedAt = this.#now();
      value.status = "not_started";
      value.code = finalFatal?.code ?? "batch_not_started";
      value.diagnostic = finalFatal?.diagnostic ?? "The sample was not started.";
      results.set(sample.sampleIndex, value);
    }
    if (finalFatal) {
      for (const sample of results.values()) sample.outputs = [];
    }
    const samples = [...results.values()].sort((left, right) => left.sampleIndex - right.sampleIndex).map(freezeSample);
    const outputs = samples.flatMap((sample) => sample.outputs);
    const status = finalFatal?.status ?? "succeeded";
    return Object.freeze({
      runId: run.runId,
      status,
      code: finalFatal?.code ?? "batch_run_succeeded",
      diagnostic: finalFatal?.diagnostic ?? "Every frozen batch sample completed with validated declared outputs.",
      startedAt,
      finishedAt: new Date(this.#now()).toISOString(),
      samples: Object.freeze(samples),
      outputs: Object.freeze(outputs),
      resources: Object.freeze({
        maxConcurrencyObserved,
        stdoutBytes,
        stderrBytes,
        outputFiles,
        outputBytes,
      }),
    });
  }

  /**
   * Deletes only scratch directories minted by this supervisor instance after
   * their exact process groups are observed exited. The receipt is the Store
   * finalizeBatchProcessCleanup seam; callers never issue an arbitrary rm.
   */
  cleanup(result: BatchSupervisionResult): BatchScratchCleanupReceipt {
    if (!SAFE_ID.test(result.runId)) {
      throw new GenericBatchSupervisorError("scratch_cleanup_unverified", "The cleanup run identity is invalid.");
    }
    const leases = result.samples
      .filter((sample) => sample.scratchPath)
      .map((sample) => {
        const lease = this.#scratchLeases.get(sample.scratchId);
        if (!lease || lease.runId !== result.runId || lease.sampleIndex !== sample.sampleIndex
          || lease.path !== sample.scratchPath || !lease.exited || !lease.groupGoneVerified) {
          throw new GenericBatchSupervisorError("scratch_cleanup_unverified", "A batch scratch lease is absent, mismatched, or still active.");
        }
        if (lease.identity) assertProcessGroupGoneForCleanup(lease.identity);
        assertExactScratchDirectory(this.#scratchRoot, lease.path, result.runId, lease.sampleIndex);
        return { sample, lease };
      });
    for (const { sample, lease } of leases) {
      removeOwnedScratchTree(lease.path);
      if (existsSync(lease.path)) {
        throw new GenericBatchSupervisorError("scratch_cleanup_unverified", "A batch scratch directory remains after cleanup.");
      }
      this.#scratchLeases.delete(sample.scratchId);
    }
    const unsigned = {
      schemaVersion: 1 as const,
      runId: result.runId,
      scratchIds: Object.freeze(leases.map(({ sample }) => sample.scratchId).sort()),
      cleanedAt: new Date(this.#now()).toISOString(),
      verified: true as const,
    };
    return Object.freeze({
      ...unsigned,
      receiptDigest: canonicalDigest(unsigned),
    });
  }

  inspectRecordedProcess(identity: BatchProcessIdentity): "present" | "gone" {
    return inspectRecordedIdentity(identity);
  }

  async terminateRecordedProcess(
    identity: BatchProcessIdentity,
    graceMs: number,
    observedAt = new Date(this.#now()).toISOString(),
  ): Promise<RecoveredProcessTerminationReceipt> {
    if (!Number.isSafeInteger(graceMs) || graceMs < 1 || graceMs > 300_000) {
      throw new GenericBatchSupervisorError("process_cleanup_unverified", "The recovery termination grace is invalid.");
    }
    let termSent = false;
    let killSent = false;
    if (inspectRecordedIdentity(identity) === "present") {
      signalRecordedProcessGroup(identity, "SIGTERM");
      termSent = true;
      if (!await waitForRecordedProcessGroupGone(identity, graceMs)) {
        signalRecordedProcessGroup(identity, "SIGKILL");
        killSent = true;
        if (!await waitForRecordedProcessGroupGone(identity, 2_000)) {
          throw new GenericBatchSupervisorError("process_cleanup_unverified", "The recovered process group survived SIGKILL.");
        }
      }
    }
    if (inspectRecordedIdentity(identity) !== "gone") {
      throw new GenericBatchSupervisorError("process_cleanup_unverified", "The recovered process group could not be proven gone.");
    }
    const unsigned = {
      schemaVersion: 1 as const,
      runId: identity.runId,
      sampleIndex: identity.sampleIndex,
      sampleId: identity.sampleId,
      scratchId: identity.scratchId,
      pid: identity.pid,
      processGroupId: identity.processGroupId,
      processStartToken: identity.startToken,
      termSent,
      killSent,
      groupGone: true as const,
      observedAt,
    };
    return Object.freeze({ ...unsigned, receiptDigest: canonicalDigest(unsigned) });
  }

  verifyRecordedProcessGroupGone(identity: BatchProcessIdentity): true {
    if (inspectRecordedIdentity(identity) !== "gone") {
      throw new GenericBatchSupervisorError("process_cleanup_unverified", "The recorded process group is not gone.");
    }
    return true;
  }

  readDurableLaunchReceipt(
    lease: Pick<DurableBatchScratchLease,
      "runId" | "sampleIndex" | "sampleId" | "scratchId" | "relativePath"
      | "ownerUid" | "device" | "inode">,
    manifest: BatchLaunchManifestBinding,
  ): BatchLaunchReceipt | null {
    const path = exactScratchPath(this.#scratchRoot, lease.relativePath);
    if (!existsSync(path)) return null;
    assertExactDurableScratchDirectory(this.#scratchRoot, path, lease);
    const receiptPath = join(path, "launch-receipt.json");
    if (!existsSync(receiptPath)) return null;
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(receiptPath, "utf8"));
    } catch (error) {
      throw new GenericBatchSupervisorError("process_identity_mismatch", "The durable launch receipt is invalid JSON.", { cause: error });
    }
    const selfReceipt = validateLaunchReceipt(value, lease, manifest);
    try {
      return bindLaunchReceiptToExactIdentity(selfReceipt);
    } catch (error) {
      if (error instanceof GenericBatchSupervisorError && error.code === "process_identity_unavailable") {
        // The launch helper can close its gate and exit after its parent dies.
        // Preserve the child-authored receipt so recovery can prove that the
        // exact PID/PGID is absent; a reused live PID will still fail the
        // start-token comparison before any signal is sent.
        return selfReceipt;
      }
      throw error;
    }
  }

  cleanupDurableScratch(
    lease: DurableBatchScratchLease,
    cleanedAt = new Date(this.#now()).toISOString(),
  ): RecoveredScratchCleanupReceipt {
    const path = exactScratchPath(this.#scratchRoot, lease.relativePath);
    let disposition: "removed" | "already_absent" = "already_absent";
    if (existsSync(path)) {
      assertExactDurableScratchDirectory(this.#scratchRoot, path, lease);
      removeOwnedScratchTree(path);
      if (existsSync(path)) {
        throw new GenericBatchSupervisorError("scratch_cleanup_unverified", "The durable scratch directory remains after recovery cleanup.");
      }
      disposition = "removed";
    }
    const unsigned = {
      schemaVersion: 1 as const,
      runId: lease.runId,
      sampleIndex: lease.sampleIndex,
      sampleId: lease.sampleId,
      scratchId: lease.scratchId,
      relativePath: lease.relativePath,
      disposition,
      cleanedAt,
      verified: true as const,
    };
    return Object.freeze({ ...unsigned, receiptDigest: canonicalDigest(unsigned) });
  }

  cleanupPlannedScratch(
    plan: BatchScratchPlan,
    cleanedAt = new Date(this.#now()).toISOString(),
  ): RecoveredScratchCleanupReceipt {
    const path = exactScratchPath(this.#scratchRoot, plan.relativePath);
    if (existsSync(path)) {
      throw new GenericBatchSupervisorError(
        "scratch_cleanup_unverified",
        "A planned scratch path exists without a durable directory identity.",
      );
    }
    const unsigned = {
      schemaVersion: 1 as const,
      runId: plan.runId,
      sampleIndex: plan.sampleIndex,
      sampleId: plan.sampleId,
      scratchId: plan.scratchId,
      relativePath: plan.relativePath,
      disposition: "already_absent" as const,
      cleanedAt,
      verified: true as const,
    };
    return Object.freeze({ ...unsigned, receiptDigest: canonicalDigest(unsigned) });
  }

  #spawnGated(
    cwd: string,
    inputPath: string,
    outputDirectory: string,
    tempDirectory: string,
    launchReceiptPath: string,
    launchNonce: string,
    launchReceiptBase: Omit<BatchLaunchReceipt,
      "pid" | "processGroupId" | "processStartToken" | "receiptDigest">,
    modelArgv: readonly string[],
  ): ChildProcess {
    const sandbox = canonicalRestrictedExecutable("/usr/bin/sandbox-exec");
    const profile = macosBatchSandboxProfile({
      projectRoot: cwd,
      inputPath,
      outputRoot: outputDirectory,
      tempRoot: tempDirectory,
      launchReceiptPath,
      executable: this.#python,
      runtimeReadRoots: this.#runtimeReadRoots,
    });
    try {
      return spawn(sandbox, [
        "-p",
        profile,
        this.#python,
        "-I",
        "-c",
        pythonGateWrapper(this.#pythonImportRoots),
        launchNonce,
        JSON.stringify(launchReceiptBase),
        launchReceiptPath,
        ...modelArgv,
      ], {
        cwd,
        env: { ...BASE_ENV, TMPDIR: tempDirectory },
        shell: false,
        detached: true,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe", "pipe", "pipe", "pipe"],
      });
    } catch (error) {
      throw new GenericBatchSupervisorError("process_spawn_failed", "The launch-gated batch process could not start.", { cause: error });
    }
  }
}

const validateFrozenRun = (input: FrozenBatchRun): FrozenBatchRun => {
  if (!input || typeof input !== "object" || input.runKind !== "batch" || !SAFE_ID.test(input.runId)
    || !Array.isArray(input.samples) || input.samples.length < 1) {
    throw new GenericBatchSupervisorError("invalid_batch_input", "The frozen batch run is invalid.");
  }
  const limits = input.limits;
  const expectedLimitKeys = [
    "schemaVersion", "wallTimeMs", "startupTimeMs", "terminationGraceMs",
    "maxStdoutBytes", "maxStderrBytes", "maxOutputFiles", "maxOutputBytes",
    "maxEventCount", "maxEventBytes", "maxSamples", "maxConcurrency",
  ].sort();
  if (!limits || typeof limits !== "object" || Array.isArray(limits)
    || Object.keys(limits).sort().join("\n") !== expectedLimitKeys.join("\n")
    || limits.schemaVersion !== 1
    || expectedLimitKeys.some((key) => key !== "schemaVersion"
      && (!Number.isSafeInteger(limits[key as keyof RunLimitsV1]) || Number(limits[key as keyof RunLimitsV1]) < 1))
    || input.samples.length > limits.maxSamples) {
    throw new GenericBatchSupervisorError("invalid_batch_input", "The frozen batch limits or sample count are invalid.");
  }
  const ids = new Set<string>();
  for (const [index, sample] of input.samples.entries()) {
    if (sample.sampleIndex !== index || ids.has(sample.sampleId)) {
      throw new GenericBatchSupervisorError("invalid_batch_input", "Frozen samples require unique IDs and contiguous indexes.");
    }
    validateBatchInputV1({
      schemaVersion: 1,
      runId: input.runId,
      sampleIndex: sample.sampleIndex,
      sampleId: sample.sampleId,
      parameters: sample.parameters,
      seed: sample.seed,
    });
    ids.add(sample.sampleId);
  }
  return input;
};

const canonicalOwnedDirectory = (input: string, label: string): string => {
  const absolute = resolve(input);
  let canonical: string;
  try {
    if (lstatSync(absolute).isSymbolicLink()) throw new Error("symlink");
    canonical = realpathSync(absolute);
    if (!statSync(canonical).isDirectory()) throw new Error("not directory");
  } catch (error) {
    throw new GenericBatchSupervisorError("unsafe_batch_path", `The ${label} is unavailable or unsafe.`, { cause: error });
  }
  return canonical;
};

const recheckWorkspaceCapability = (workspace: ModelWorkspaceCapability): string => {
  try {
    if (realpathSync(workspace.root) !== workspace.root || !statSync(workspace.root).isDirectory()) throw new Error("changed");
    return workspace.root;
  } catch (error) {
    throw new GenericBatchSupervisorError("project_snapshot_corrupt", "The verified Project execution root changed before launch.", { cause: error });
  }
};

export const verifyProjectExecutionRootCapability = (
  workspace: ModelWorkspaceCapability,
  executionDescription: unknown,
  expectedExecutionRootDigest: string,
): VerifiedProjectExecutionRootCapability => {
  if (!/^[0-9a-f]{64}$/u.test(expectedExecutionRootDigest)) {
    throw new GenericBatchSupervisorError("project_snapshot_corrupt", "The expected execution-root digest is invalid.");
  }
  const description = validateExecutionDescriptionV2(executionDescription);
  const root = assertVerifiedProjectExecutionRoot({
    ...workspace,
    capabilityKind: "verified-project-execution-root-v1",
    expectedExecutionRootDigest,
  }, description);
  return Object.freeze({
    root,
    capabilityId: workspace.capabilityId,
    capabilityKind: "verified-project-execution-root-v1",
    expectedExecutionRootDigest,
  });
};

const assertVerifiedProjectExecutionRoot = (
  workspace: VerifiedProjectExecutionRootCapability,
  description: ExecutionDescriptionV2,
): string => {
  if (workspace.capabilityKind !== "verified-project-execution-root-v1"
    || !/^[0-9a-f]{64}$/u.test(workspace.expectedExecutionRootDigest)) {
    throw new GenericBatchSupervisorError("project_snapshot_corrupt", "The Project execution-root capability is invalid.");
  }
  const root = recheckWorkspaceCapability(workspace);
  assertDirectOwnedDirectory(root, "code");
  assertDirectOwnedDirectory(root, "environment");
  assertContainedRegular(root, resolve(root, description.dependencyFile), "batch_dependency_invalid");
  if (description.batch) {
    assertContainedRegular(root, resolve(root, description.batch.entryPoint), "batch_entrypoint_invalid");
  }
  if (scanRegularTree(root, Number.POSITIVE_INFINITY, Date.now, "project_snapshot_corrupt").digest
    !== workspace.expectedExecutionRootDigest) {
    throw new GenericBatchSupervisorError("project_snapshot_corrupt", "The Project execution root differs from its expected digest.");
  }
  return root;
};

const assertDirectOwnedDirectory = (root: string, name: "code" | "environment"): void => {
  const path = join(root, name);
  try {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isDirectory() || dirname(path) !== root) throw new Error("unsafe directory");
  } catch (error) {
    throw new GenericBatchSupervisorError(
      "project_snapshot_corrupt",
      `The exact Project execution root does not directly contain ${name}/.`,
      { cause: error },
    );
  }
};

const copyRegularTree = (
  sourceRoot: string,
  destinationRoot: string,
  deadline = Number.POSITIVE_INFINITY,
  now: () => number = Date.now,
): string => {
  const sourceOwner = statSync(sourceRoot).uid;
  const identities = new Set<string>();
  const manifest: Array<{ relativePath: string; sizeBytes: number; sha256: string }> = [];
  let entryCount = 0;
  let totalBytes = 0;
  const visit = (sourceDirectory: string, destinationDirectory: string): void => {
    for (const entry of readdirSync(sourceDirectory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      assertBeforeDeadline(deadline, now);
      entryCount += 1;
      if (entryCount > MAX_SNAPSHOT_FILES) {
        throw new GenericBatchSupervisorError("project_snapshot_corrupt", "The Project snapshot exceeds the supervisor entry bound.");
      }
      const sourcePath = resolve(sourceDirectory, entry.name);
      const logical = normalizedContainedRelative(sourceRoot, sourcePath);
      const info = lstatSync(sourcePath);
      if (info.isSymbolicLink()) throw new GenericBatchSupervisorError("project_snapshot_corrupt", "The Project snapshot contains a symbolic link.");
      const destination = resolve(destinationRoot, logical);
      if (info.isDirectory()) {
        mkdirSync(destination, { recursive: false, mode: 0o700 });
        visit(sourcePath, destination);
        chmodSync(destination, 0o500);
        continue;
      }
      if (!info.isFile() || info.nlink !== 1 || info.uid !== sourceOwner) {
        throw new GenericBatchSupervisorError("project_snapshot_corrupt", "The Project snapshot contains a special, linked, or foreign-owned file.");
      }
      totalBytes += info.size;
      if (totalBytes > MAX_SNAPSHOT_BYTES || !Number.isSafeInteger(totalBytes)) {
        throw new GenericBatchSupervisorError("project_snapshot_corrupt", "The Project snapshot exceeds the supervisor copy bound.");
      }
      const identity = `${info.dev}:${info.ino}`;
      if (identities.has(identity)) throw new GenericBatchSupervisorError("project_snapshot_corrupt", "The Project snapshot repeats a file identity.");
      identities.add(identity);
      const captured = readStableRegular(sourcePath, sourceOwner, "project_snapshot_corrupt");
      writeExclusiveRegular(destination, captured.bytes, 0o400);
      manifest.push({ relativePath: logical, sizeBytes: captured.bytes.byteLength, sha256: captured.sha256 });
    }
  };
  visit(sourceRoot, destinationRoot);
  chmodSync(destinationRoot, 0o500);
  return sha256Hex(canonicalJsonV2(manifest.sort(compareManifestPaths)));
};

const scanRegularTree = (
  root: string,
  deadline = Number.POSITIVE_INFINITY,
  now: () => number = Date.now,
  unsafeCode = "batch_scratch_violation",
): { digest: string } => {
  const owner = statSync(root).uid;
  const manifest: Array<{ relativePath: string; sizeBytes: number; sha256: string }> = [];
  let entryCount = 0;
  let totalBytes = 0;
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      assertBeforeDeadline(deadline, now);
      entryCount += 1;
      if (entryCount > MAX_SNAPSHOT_FILES) {
        throw new GenericBatchSupervisorError("project_snapshot_corrupt", "The execution root exceeds the supervisor entry bound.");
      }
      const path = resolve(directory, entry.name);
      const logical = normalizedContainedRelative(root, path);
      const info = lstatSync(path);
      if (info.isSymbolicLink()) throw new GenericBatchSupervisorError(unsafeCode, "The Project tree contains a symbolic link.");
      if (info.isDirectory()) { visit(path); continue; }
      if (!info.isFile() || info.nlink !== 1 || info.uid !== owner) {
        throw new GenericBatchSupervisorError(unsafeCode, "The Project tree contains an unsafe file.");
      }
      const captured = readStableRegular(path, owner, unsafeCode);
      totalBytes += captured.bytes.byteLength;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_SNAPSHOT_BYTES) {
        throw new GenericBatchSupervisorError("project_snapshot_corrupt", "The execution root exceeds the supervisor byte bound.");
      }
      manifest.push({ relativePath: logical, sizeBytes: captured.bytes.byteLength, sha256: captured.sha256 });
    }
  };
  visit(root);
  return { digest: sha256Hex(canonicalJsonV2(manifest.sort(compareManifestPaths))) };
};

const compareManifestPaths = (
  left: Readonly<{ relativePath: string }>,
  right: Readonly<{ relativePath: string }>,
): number => left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0;

const validateOutputCandidates = (input: {
  description: ExecutionDescriptionV2;
  outputDirectory: string;
  sample: FrozenBatchSample;
  outputIdentities: Set<string>;
  remainingFiles: number;
  remainingBytes: number;
  deadline: number;
  now: () => number;
}): { candidates: BatchOutputCandidate[]; fileCount: number; totalBytes: number } => {
  let rootInfo: ReturnType<typeof lstatSync>;
  try {
    rootInfo = lstatSync(input.outputDirectory);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()
      || realpathSync(input.outputDirectory) !== input.outputDirectory) {
      throw new Error("unsafe output root");
    }
  } catch (error) {
    throw new GenericBatchSupervisorError("batch_output_unsafe", "The assigned output root changed before discovery.", { cause: error });
  }
  const owner = rootInfo.uid;
  const declarations = new Map(resolveBatchOutputPathsV1(input.description, input.outputDirectory)
    .map((output) => [output.relativePath, output]));
  const eventPath = input.description.batch?.domainEvents?.relativePath;
  const allowed = new Set([...declarations.keys(), ...(eventPath ? [eventPath] : [])]);
  const found = new Map<string, ReturnType<typeof readStableRegular> & { absolutePath: string }>();
  let fileCount = 0;
  let totalBytes = 0;
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      assertBeforeDeadline(input.deadline, input.now);
      fileCount += 1;
      if (fileCount > input.remainingFiles) {
        throw new GenericBatchSupervisorError("run_output_file_limit", "The frozen run output entry limit was exceeded.");
      }
      const path = resolve(directory, entry.name);
      const logical = normalizedContainedRelative(input.outputDirectory, path);
      const info = lstatSync(path);
      if (info.isSymbolicLink()) throw new GenericBatchSupervisorError("batch_output_unsafe", "A batch output contains a symbolic link.");
      if (info.isDirectory()) { visit(path); continue; }
      if (!info.isFile() || info.nlink !== 1 || info.uid !== owner) {
        throw new GenericBatchSupervisorError("batch_output_unsafe", "A batch output is special, linked, or foreign-owned.");
      }
      if (!allowed.has(logical)) {
        throw new GenericBatchSupervisorError("batch_undeclared_output", `The batch process wrote undeclared output ${logical}.`);
      }
      totalBytes += info.size;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > input.remainingBytes) {
        throw new GenericBatchSupervisorError("run_output_byte_limit", "The frozen run output byte limit was exceeded.");
      }
      const captured = readStableRegular(path, owner, "batch_output_unsafe");
      const inodeIdentity = `${captured.device}:${captured.inode}`;
      if (input.outputIdentities.has(inodeIdentity)) {
        throw new GenericBatchSupervisorError("batch_output_unsafe", "A batch output repeats an inode identity across samples.");
      }
      input.outputIdentities.add(inodeIdentity);
      found.set(logical, { ...captured, absolutePath: path });
    }
  };
  visit(input.outputDirectory);
  const candidates: BatchOutputCandidate[] = [];
  for (const [logical, declaration] of declarations) {
    const captured = found.get(logical);
    if (!captured) {
      if (declaration.required) {
        throw new GenericBatchSupervisorError("batch_required_output_missing", `Required output ${declaration.logicalName} is missing.`);
      }
      continue;
    }
    validateMediaBytes(captured.bytes, declaration.mediaType);
    candidates.push(Object.freeze({
      sampleIndex: input.sample.sampleIndex,
      sampleId: input.sample.sampleId,
      logicalName: declaration.logicalName,
      relativePath: declaration.relativePath,
      mediaType: declaration.mediaType,
      role: declaration.role,
      sourcePath: captured.absolutePath,
      scratchPath: dirname(input.outputDirectory),
      sizeBytes: captured.bytes.byteLength,
      sha256: captured.sha256,
      owner,
      device: captured.device,
      inode: captured.inode,
    }));
  }
  return { candidates, fileCount, totalBytes };
};

/**
 * Captures bytes for the Store commit through the same no-follow boundary used
 * during discovery. A replaced path or a newly introduced hardlink fails
 * before any bytes are returned.
 */
export const consumeBatchOutputCandidate = (candidate: BatchOutputCandidate): Buffer => {
  assertNoSymlinkAncestors(candidate.scratchPath, candidate.sourcePath, "batch_output_changed");
  const captured = readStableRegular(candidate.sourcePath, candidate.owner, "batch_output_changed");
  if (captured.device !== candidate.device || captured.inode !== candidate.inode
    || captured.bytes.byteLength !== candidate.sizeBytes || captured.sha256 !== candidate.sha256) {
    throw new GenericBatchSupervisorError(
      "batch_output_changed",
      "A validated batch output changed before immutable byte capture.",
    );
  }
  return Buffer.from(captured.bytes);
};

const assertNoSymlinkAncestors = (root: string, path: string, code: string): void => {
  normalizedContainedRelative(root, path);
  let cursor = dirname(path);
  while (true) {
    try {
      const info = lstatSync(cursor);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("unsafe ancestor");
    } catch (error) {
      throw new GenericBatchSupervisorError(code, "A validated batch output ancestor changed.", { cause: error });
    }
    if (cursor === root) return;
    cursor = dirname(cursor);
    if (cursor.length < root.length) {
      throw new GenericBatchSupervisorError(code, "A validated batch output escaped its scratch root.");
    }
  }
};

const readStableRegular = (
  path: string,
  expectedOwner: number,
  code: string,
): { bytes: Buffer; sha256: string; device: number; inode: number } => {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || before.uid !== expectedOwner) throw new Error("unsafe file");
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    const pathAfter = lstatSync(path);
    if (!sameFile(before, after) || !sameFile(after, pathAfter) || bytes.byteLength !== after.size) throw new Error("file changed");
    return { bytes, sha256: sha256Hex(bytes), device: after.dev, inode: after.ino };
  } catch (error) {
    throw new GenericBatchSupervisorError(code, "A no-follow file verification failed.", { cause: error });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
};

const writeExclusiveRegular = (path: string, bytes: Uint8Array, mode: number): void => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
    writeFileSync(descriptor, bytes);
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.nlink !== 1 || info.size !== bytes.byteLength) throw new Error("write verification");
  } catch (error) {
    throw new GenericBatchSupervisorError("unsafe_batch_path", "An application-owned scratch file could not be created safely.", { cause: error });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
};

const normalizedContainedRelative = (root: string, path: string): string => {
  const logical = relative(root, path).split(sep).join("/");
  if (!logical || logical === ".." || logical.startsWith("../") || logical.startsWith("/")
    || logical.includes("\\") || logical.includes("\0")
    || logical.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new GenericBatchSupervisorError("unsafe_batch_path", "A batch path escaped its application-owned root.");
  }
  return logical;
};

const assertContainedRegular = (root: string, path: string, code: string): void => {
  normalizedContainedRelative(root, path);
  let cursor = path;
  while (true) {
    const info = lstatSync(cursor);
    if (info.isSymbolicLink() || (cursor === path ? !info.isFile() || info.nlink !== 1 : !info.isDirectory())) {
      throw new GenericBatchSupervisorError(code, "The batch entry point path is unsafe.");
    }
    if (cursor === root) break;
    cursor = dirname(cursor);
    if (cursor.length < root.length) throw new GenericBatchSupervisorError(code, "The batch entry point escaped its Project copy.");
  }
};

const validateMediaBytes = (bytes: Buffer, mediaType: string): void => {
  try {
    if (mediaType === "application/json" || mediaType.endsWith("+json")) {
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } else if (mediaType === "application/x-ndjson") {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      for (const line of text.split(/\r?\n/u)) if (line) JSON.parse(line);
    } else if (mediaType.startsWith("text/")) {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    }
  } catch (error) {
    throw new GenericBatchSupervisorError("batch_output_media_invalid", "A declared batch output does not match its media contract.", { cause: error });
  }
};

const readProcessIdentity = (
  pid: number,
  base: Omit<BatchProcessIdentity, "pid" | "processGroupId" | "startToken">,
): BatchProcessIdentity => {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new GenericBatchSupervisorError("process_identity_unavailable", "The launch-gate PID is invalid.");
  const probe = spawnSync("/bin/ps", ["-o", "pgid=", "-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    timeout: 1_000,
    env: { LANG: "C", LC_ALL: "C" },
  });
  if (probe.status !== 0 || !probe.stdout.trim()) {
    throw new GenericBatchSupervisorError("process_identity_unavailable", "The launch-gate OS identity could not be observed.");
  }
  const match = /^\s*(\d+)\s+(.+?)\s*$/u.exec(probe.stdout);
  const processGroupId = Number(match?.[1]);
  const startToken = match?.[2]?.trim() ?? "";
  if (processGroupId !== pid || !startToken || startToken.length > 200) {
    throw new GenericBatchSupervisorError("process_identity_mismatch", "The launch helper is not the expected new process-group leader.");
  }
  return Object.freeze({ ...base, pid, processGroupId, startToken });
};

const localManifestBinding = (plan: BatchScratchPlan): BatchLaunchManifestBinding => {
  const manifest = {
    schemaVersion: 1,
    kind: "batch_process_launch",
    runId: plan.runId,
    sampleIndex: plan.sampleIndex,
    sampleId: plan.sampleId,
    scratchId: plan.scratchId,
    relativePath: plan.relativePath,
  };
  return Object.freeze({
    manifestId: `launch_${canonicalDigest(manifest).slice(0, 32)}`,
    manifestDigest: canonicalDigest(manifest),
  });
};

const assertManifestBinding = (binding: BatchLaunchManifestBinding): void => {
  if (!binding || typeof binding !== "object"
    || !SAFE_ID.test(binding.manifestId)
    || !/^[0-9a-f]{64}$/u.test(binding.manifestDigest)) {
    throw new GenericBatchSupervisorError("process_registration_failed", "The durable launch manifest binding is invalid.");
  }
};

const validateLaunchReceipt = (
  value: unknown,
  lease: Pick<DurableBatchScratchLease,
    "runId" | "sampleIndex" | "sampleId" | "scratchId" | "relativePath">,
  manifest: BatchLaunchManifestBinding,
): BatchLaunchReceipt => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GenericBatchSupervisorError("process_identity_mismatch", "The durable launch receipt has an invalid shape.");
  }
  const receipt = value as BatchLaunchReceipt;
  const keys = Object.keys(receipt).sort();
  const expectedKeys = [
    "createdAt", "manifestDigest", "manifestId", "pid", "processGroupId",
    "processStartToken", "receiptDigest", "relativePath", "runId", "sampleId",
    "sampleIndex", "schemaVersion", "scratchId",
  ].sort();
  const { receiptDigest, ...unsigned } = receipt;
  if (keys.join("\n") !== expectedKeys.join("\n")
    || receipt.schemaVersion !== 1
    || receipt.manifestId !== manifest.manifestId
    || receipt.manifestDigest !== manifest.manifestDigest
    || receipt.runId !== lease.runId
    || receipt.sampleIndex !== lease.sampleIndex
    || receipt.sampleId !== lease.sampleId
    || receipt.scratchId !== lease.scratchId
    || receipt.relativePath !== lease.relativePath
    || !Number.isSafeInteger(receipt.pid) || receipt.pid < 1
    || receipt.processGroupId !== receipt.pid
    || typeof receipt.processStartToken !== "string"
    || receipt.processStartToken.length < 1 || receipt.processStartToken.length > 300
    || typeof receipt.createdAt !== "string"
    || !/^[0-9a-f]{64}$/u.test(receipt.receiptDigest)
    || canonicalDigest(unsigned) !== receipt.receiptDigest) {
    throw new GenericBatchSupervisorError("process_identity_mismatch", "The durable launch receipt does not match its manifest and scratch lease.");
  }
  return Object.freeze({ ...receipt });
};

const bindLaunchReceiptToExactIdentity = (
  selfReceipt: BatchLaunchReceipt,
): BatchLaunchReceipt => {
  const identity = readProcessIdentity(selfReceipt.pid, {
    runId: selfReceipt.runId,
    sampleIndex: selfReceipt.sampleIndex,
    sampleId: selfReceipt.sampleId,
    scratchId: selfReceipt.scratchId,
  });
  if (identity.processGroupId !== selfReceipt.processGroupId) {
    throw new GenericBatchSupervisorError(
      "process_identity_mismatch",
      "The durable launch receipt process group differs from the OS identity.",
    );
  }
  const startedAt = Date.parse(identity.startToken);
  const receiptAt = Date.parse(selfReceipt.createdAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(receiptAt)
    || Math.abs(startedAt - receiptAt) > 10_000) {
    throw new GenericBatchSupervisorError(
      "process_identity_mismatch",
      "The durable launch receipt timestamp does not match the OS process start.",
    );
  }
  const { receiptDigest: _receiptDigest, ...unsignedSelf } = selfReceipt;
  const unsigned = { ...unsignedSelf, processStartToken: identity.startToken };
  return Object.freeze({ ...unsigned, receiptDigest: canonicalDigest(unsigned) });
};

const sameIdentity = (left: BatchProcessIdentity, right: BatchProcessIdentity): boolean =>
  left.pid === right.pid && left.processGroupId === right.processGroupId && left.startToken === right.startToken
  && left.runId === right.runId && left.sampleIndex === right.sampleIndex
  && left.sampleId === right.sampleId && left.scratchId === right.scratchId;

const inspectRecordedIdentity = (identity: BatchProcessIdentity): "present" | "gone" => {
  try {
    const current = readProcessIdentity(identity.pid, {
      runId: identity.runId,
      sampleIndex: identity.sampleIndex,
      sampleId: identity.sampleId,
      scratchId: identity.scratchId,
    });
    if (!sameIdentity(identity, current)) {
      throw new GenericBatchSupervisorError("process_identity_mismatch", "The recorded process leader identity changed.");
    }
    return "present";
  } catch (error) {
    if (!(error instanceof GenericBatchSupervisorError) || error.code !== "process_identity_unavailable") throw error;
  }
  const first = requiredProcessGroupMembers(identity.processGroupId);
  const second = requiredProcessGroupMembers(identity.processGroupId);
  if (canonicalDigest(first) !== canonicalDigest(second)) {
    throw new GenericBatchSupervisorError("process_identity_mismatch", "The recorded process group changed during recovery inspection.");
  }
  if (second.length) {
    if (Number.isFinite(Date.parse(identity.startToken))) {
      // A process group cannot be reassigned while descendants still retain
      // it. An OS-bound leader start token therefore keeps the exact group
      // signalable even after the leader exits. Child-only nonce receipts do
      // not satisfy this condition and remain fail-closed.
      return "present";
    }
    throw new GenericBatchSupervisorError(
      "process_identity_mismatch",
      "The recorded leader disappeared while its process group still contains unverifiable members.",
    );
  }
  return "gone";
};

const signalRecordedProcessGroup = (identity: BatchProcessIdentity, signal: "SIGTERM" | "SIGKILL"): void => {
  if (inspectRecordedIdentity(identity) === "gone") return;
  try {
    process.kill(-identity.processGroupId, signal);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH"
      && inspectRecordedIdentity(identity) === "gone") return;
    throw new GenericBatchSupervisorError("process_cleanup_unverified", `The recovered process group could not receive ${signal}.`, { cause: error });
  }
};

const waitForRecordedProcessGroupGone = async (
  identity: BatchProcessIdentity,
  timeoutMs: number,
): Promise<boolean> => {
  const deadline = Date.now() + boundedDelay(timeoutMs);
  while (Date.now() < deadline) {
    if (inspectRecordedIdentity(identity) === "gone") return true;
    await delay(20);
  }
  return inspectRecordedIdentity(identity) === "gone";
};

const observeChild = (child: ChildProcess): {
  completion: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>;
  closed: Promise<void>;
} => {
  const completion = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolveCompletion, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolveCompletion({ exitCode: child.exitCode, signal: child.signalCode as NodeJS.Signals | null });
      return;
    }
    child.once("error", (error) => reject(new GenericBatchSupervisorError("process_runtime_failed", "The batch process failed.", { cause: error })));
    child.once("exit", (exitCode, signal) => resolveCompletion({ exitCode, signal: signal as NodeJS.Signals | null }));
  });
  const closed = new Promise<void>((resolveClosed, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      setImmediate(resolveClosed);
      return;
    }
    child.once("error", (error) => reject(new GenericBatchSupervisorError("process_runtime_failed", "The batch process streams failed.", { cause: error })));
    child.once("close", () => resolveClosed());
  });
  return { completion, closed };
};

const waitForStartedSignal = (child: ChildProcess): Promise<void> =>
  new Promise((resolveStarted, reject) => {
    const stream = child.stdio[4];
    if (!stream || typeof stream === "number" || !("once" in stream)) {
      reject(new GenericBatchSupervisorError("process_registration_failed", "The launch-gate start acknowledgement pipe is unavailable."));
      return;
    }
    stream.once("data", (chunk: Buffer) => {
      if (Buffer.from(chunk).subarray(0, 1).toString() === "1") resolveStarted();
      else reject(new GenericBatchSupervisorError("process_registration_failed", "The launch-gate start acknowledgement is invalid."));
    });
    stream.once("error", (error) => reject(new GenericBatchSupervisorError("process_registration_failed", "The launch-gate start acknowledgement failed.", { cause: error })));
    stream.once("end", () => reject(new GenericBatchSupervisorError("process_registration_failed", "The launch gate closed before Model start.")));
  });

const waitForLaunchReceiptSignal = (child: ChildProcess): Promise<void> =>
  new Promise((resolveReceipt, reject) => {
    const stream = child.stdio[5];
    if (!stream || typeof stream === "number" || !("once" in stream)) {
      reject(new GenericBatchSupervisorError("process_registration_failed", "The durable launch-receipt acknowledgement pipe is unavailable."));
      return;
    }
    stream.once("data", (chunk: Buffer) => {
      if (Buffer.from(chunk).subarray(0, 1).toString() === "1") resolveReceipt();
      else reject(new GenericBatchSupervisorError("process_registration_failed", "The durable launch-receipt acknowledgement is invalid."));
    });
    stream.once("error", (error) => reject(new GenericBatchSupervisorError("process_registration_failed", "The durable launch-receipt acknowledgement failed.", { cause: error })));
    stream.once("end", () => reject(new GenericBatchSupervisorError("process_registration_failed", "The launch helper closed before persisting its receipt.")));
  });

const releaseGate = (child: ChildProcess): void => {
  const stream = child.stdio[3];
  if (!stream || typeof stream === "number" || !("end" in stream)) {
    throw new GenericBatchSupervisorError("process_registration_failed", "The launch-gate release pipe is unavailable.");
  }
  stream.end("1");
};

const closeGateWithoutRelease = (child: ChildProcess): void => {
  const stream = child.stdio[3];
  if (stream && typeof stream !== "number" && "end" in stream) stream.end();
};

const withinRegistrationDeadline = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  let abortListener: (() => void) | undefined;
  try {
    const abort = new Promise<never>((_resolve, reject) => {
      if (!signal) return;
      abortListener = () => reject(new GenericBatchSupervisorError(
        "dispatcher_shutdown",
        "The batch dispatcher shut down during launch-gate registration.",
      ));
      if (signal.aborted) abortListener();
      else signal.addEventListener("abort", abortListener, { once: true });
    });
    return await Promise.race([
      promise,
      abort,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new GenericBatchSupervisorError(
          "process_registration_timeout",
          "The launch gate was not durably registered and released within its fixed deadline.",
        )), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && abortListener) signal.removeEventListener("abort", abortListener);
  }
};

const runGateHook = async <T>(
  promise: Promise<T>,
  deadline: number,
  now: () => number,
  signal?: AbortSignal,
): Promise<T> => {
  const remaining = deadline - now();
  if (remaining <= 0) {
    throw new GenericBatchSupervisorError(
      "process_registration_timeout",
      "The launch gate exceeded its fixed durable-registration deadline.",
    );
  }
  try {
    return await withinRegistrationDeadline(promise, remaining, signal);
  } catch (error) {
    if (error instanceof GenericBatchSupervisorError) throw error;
    throw new GenericBatchSupervisorError(
      "process_registration_failed",
      "The durable launch-gate callback rejected process registration.",
      { cause: error },
    );
  }
};

const terminateProcess = (tracked: ActiveProcess, graceMs: number): Promise<void> => {
  if (tracked.termination) return tracked.termination;
  tracked.termination = (async () => {
    const termSent = signalVerifiedProcessGroup(tracked, "SIGTERM");
    if (!termSent) {
      stopProcessGroupMonitor(tracked);
      return;
    }
    if (await waitForProcessGroupGone(tracked, graceMs)) {
      stopProcessGroupMonitor(tracked);
      return;
    }
    const killSent = signalVerifiedProcessGroup(tracked, "SIGKILL");
    if (killSent && !await waitForProcessGroupGone(tracked, 2_000)) {
      throw new GenericBatchSupervisorError("process_cleanup_unverified", "The batch process group survived SIGKILL.");
    }
    if (verifyProcessGroupTarget(tracked) !== "gone") {
      throw new GenericBatchSupervisorError("process_cleanup_unverified", "The batch process group could not be proven gone.");
    }
    stopProcessGroupMonitor(tracked);
  })();
  return tracked.termination;
};

const startProcessGroupMonitor = (tracked: ActiveProcess): void => {
  tracked.groupMonitor = setInterval(() => {
    const members = readProcessGroupMembers(tracked.identity.processGroupId);
    if (members && members.length === 0) tracked.groupContinuityLost = true;
  }, 25);
  tracked.groupMonitor.unref?.();
};

const stopProcessGroupMonitor = (tracked: ActiveProcess): void => {
  if (tracked.groupMonitor) clearInterval(tracked.groupMonitor);
  tracked.groupMonitor = undefined;
};

const verifyProcessGroupTarget = (tracked: ActiveProcess): "present" | "gone" => {
  try {
    const current = readProcessIdentity(tracked.identity.pid, {
      runId: tracked.identity.runId,
      sampleIndex: tracked.identity.sampleIndex,
      sampleId: tracked.identity.sampleId,
      scratchId: tracked.identity.scratchId,
    });
    if (!sameIdentity(tracked.identity, current)) {
      throw new GenericBatchSupervisorError("process_identity_mismatch", "The batch process leader identity changed.");
    }
    return "present";
  } catch (error) {
    if (!(error instanceof GenericBatchSupervisorError) || error.code !== "process_identity_unavailable") throw error;
  }
  const first = requiredProcessGroupMembers(tracked.identity.processGroupId);
  if (first.length === 0) {
    tracked.groupContinuityLost = true;
    return "gone";
  }
  if (tracked.groupContinuityLost) {
    throw new GenericBatchSupervisorError("process_identity_mismatch", "The process-group continuity was lost before descendant cleanup.");
  }
  const second = requiredProcessGroupMembers(tracked.identity.processGroupId);
  if (canonicalDigest(first) !== canonicalDigest(second)) {
    throw new GenericBatchSupervisorError("process_identity_mismatch", "The process-group member identities changed during verification.");
  }
  return "present";
};

const signalVerifiedProcessGroup = (tracked: ActiveProcess, signal: "SIGTERM" | "SIGKILL"): boolean => {
  if (verifyProcessGroupTarget(tracked) === "gone") return false;
  try {
    process.kill(-tracked.identity.processGroupId, signal);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH"
      && verifyProcessGroupTarget(tracked) === "gone") return false;
    throw new GenericBatchSupervisorError("process_cleanup_unverified", `The verified process group could not receive ${signal}.`, { cause: error });
  }
};

const waitForProcessGroupGone = async (tracked: ActiveProcess, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + boundedDelay(timeoutMs);
  while (Date.now() < deadline) {
    if (verifyProcessGroupTarget(tracked) === "gone") return true;
    await delay(20);
  }
  return verifyProcessGroupTarget(tracked) === "gone";
};

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

type ProcessGroupMember = Readonly<{ pid: number; processGroupId: number; startToken: string }>;

const readProcessGroupMembers = (processGroupId: number): ProcessGroupMember[] | null => {
  const probe = spawnSync("/bin/ps", ["-axo", "pid=", "-o", "pgid=", "-o", "lstart="], {
    encoding: "utf8",
    timeout: 1_000,
    env: { LANG: "C", LC_ALL: "C" },
  });
  if (probe.status !== 0 || typeof probe.stdout !== "string") return null;
  const members: ProcessGroupMember[] = [];
  for (const line of probe.stdout.split(/\r?\n/u)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/u.exec(line);
    if (!match || Number(match[2]) !== processGroupId) continue;
    members.push(Object.freeze({
      pid: Number(match[1]),
      processGroupId: Number(match[2]),
      startToken: match[3]!,
    }));
  }
  return members.sort((left, right) => left.pid - right.pid);
};

const requiredProcessGroupMembers = (processGroupId: number): ProcessGroupMember[] => {
  const members = readProcessGroupMembers(processGroupId);
  if (!members) {
    throw new GenericBatchSupervisorError("process_identity_unavailable", "The process-group identities could not be observed.");
  }
  return members;
};

const initialSample = (
  sample: FrozenBatchSample,
  scratchId: string,
  scratchPath: string,
  startedAt: number,
): MutableSample => ({
  sampleIndex: sample.sampleIndex,
  sampleId: sample.sampleId,
  scratchId,
  scratchPath,
  identity: null,
  exitCode: null,
  signal: null,
  startedAt,
  finishedAt: startedAt,
  stdout: [],
  stderr: [],
  stdoutTruncated: false,
  stderrTruncated: false,
  outputs: [],
  status: "failed",
  code: "batch_sample_failed",
  diagnostic: "The sample did not complete.",
});

const applyFatal = (sample: MutableSample, fatal: Fatal): void => {
  sample.status = fatal.status;
  sample.code = fatal.code;
  sample.diagnostic = fatal.diagnostic;
};

const freezeSample = (sample: MutableSample): BatchSampleResult => Object.freeze({
  sampleIndex: sample.sampleIndex,
  sampleId: sample.sampleId,
  status: sample.status,
  code: sample.code,
  diagnostic: sample.diagnostic,
  identity: sample.identity,
  exitCode: sample.exitCode,
  signal: sample.signal,
  durationMs: Math.max(0, sample.finishedAt - sample.startedAt),
  stdout: Buffer.concat(sample.stdout).toString("utf8"),
  stderr: Buffer.concat(sample.stderr).toString("utf8"),
  stdoutTruncated: sample.stdoutTruncated,
  stderrTruncated: sample.stderrTruncated,
  scratchId: sample.scratchId,
  scratchPath: sample.scratchPath,
  outputs: Object.freeze([...sample.outputs]),
});

const supervisorFailure = (error: unknown): Fatal => {
  if (error instanceof GenericBatchSupervisorError) {
    return {
      status: error.code === "run_wall_timeout" ? "timed_out" : "failed",
      code: error.code,
      diagnostic: boundedDiagnostic(error.message),
    };
  }
  const code = typeof error === "object" && error && "code" in error && typeof error.code === "string"
    ? error.code
    : "batch_supervisor_failed";
  const message = error instanceof Error ? error.message : "The generic batch supervisor failed.";
  return { status: "failed", code, diagnostic: boundedDiagnostic(message) };
};

const boundedDiagnostic = (message: string): string =>
  Buffer.from(message, "utf8").subarray(0, 2_048).toString("utf8");

const sameFile = (
  left: ReturnType<typeof fstatSync>,
  right: ReturnType<typeof fstatSync> | ReturnType<typeof lstatSync>,
): boolean =>
  left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
  && left.uid === right.uid && left.gid === right.gid && left.nlink === right.nlink
  && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;

const assertProcessGroupGoneForCleanup = (identity: BatchProcessIdentity): void => {
  try {
    const current = readProcessIdentity(identity.pid, {
      runId: identity.runId,
      sampleIndex: identity.sampleIndex,
      sampleId: identity.sampleId,
      scratchId: identity.scratchId,
    });
    if (sameIdentity(identity, current)) {
      throw new GenericBatchSupervisorError("scratch_cleanup_unverified", "The original batch process leader is still present.");
    }
  } catch (error) {
    if (!(error instanceof GenericBatchSupervisorError) || error.code !== "process_identity_unavailable") throw error;
  }
  const first = requiredProcessGroupMembers(identity.processGroupId);
  const second = requiredProcessGroupMembers(identity.processGroupId);
  if (canonicalDigest(first) !== canonicalDigest(second)) {
    throw new GenericBatchSupervisorError("scratch_cleanup_unverified", "The process-group identity changed during cleanup verification.");
  }
  if (second.length) {
    throw new GenericBatchSupervisorError("scratch_cleanup_unverified", "The original batch process group still has live members.");
  }
};

const assertExactScratchDirectory = (
  scratchRoot: string,
  path: string,
  runId: string,
  sampleIndex: number,
): void => {
  try {
    const info = lstatSync(path);
    const expectedPrefix = `riff-${safePrefix(runId)}-${sampleIndex}-`;
    const name = path.slice(dirname(path).length + 1);
    if (info.isSymbolicLink() || !info.isDirectory() || dirname(path) !== scratchRoot
      || realpathSync(path) !== path || !name.startsWith(expectedPrefix)) {
      throw new Error("scratch lease changed");
    }
  } catch (error) {
    throw new GenericBatchSupervisorError(
      "scratch_cleanup_unverified",
      "The exact application-owned scratch directory changed before cleanup.",
      { cause: error },
    );
  }
};

const exactScratchPath = (scratchRoot: string, relativePath: string): string => {
  if (!relativePath || relativePath === "." || relativePath === ".."
    || relativePath.includes("/") || relativePath.includes("\\")
    || relativePath.includes("\0") || !/^[A-Za-z0-9._-]+$/u.test(relativePath)) {
    throw new GenericBatchSupervisorError("scratch_cleanup_unverified", "The durable scratch relative path is invalid.");
  }
  const path = join(scratchRoot, relativePath);
  if (dirname(path) !== scratchRoot) {
    throw new GenericBatchSupervisorError("scratch_cleanup_unverified", "The durable scratch path escaped its root.");
  }
  return path;
};

const assertExactDurableScratchDirectory = (
  scratchRoot: string,
  path: string,
  lease: Pick<DurableBatchScratchLease,
    "relativePath" | "ownerUid" | "device" | "inode">,
): void => {
  try {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isDirectory()
      || dirname(path) !== scratchRoot || realpathSync(path) !== path
      || info.uid !== lease.ownerUid || info.dev !== lease.device || info.ino !== lease.inode
      || path !== exactScratchPath(scratchRoot, lease.relativePath)) {
      throw new Error("durable scratch identity changed");
    }
  } catch (error) {
    throw new GenericBatchSupervisorError(
      "scratch_cleanup_unverified",
      "The exact durable scratch directory changed before recovery.",
      { cause: error },
    );
  }
};

const removeOwnedScratchTree = (directory: string): void => {
  const info = lstatSync(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new GenericBatchSupervisorError("scratch_cleanup_unverified", "Scratch cleanup encountered a non-directory root.");
  }
  chmodSync(directory, 0o700);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const child = lstatSync(path);
    if (child.isSymbolicLink() || !child.isDirectory()) {
      unlinkSync(path);
      continue;
    }
    removeOwnedScratchTree(path);
  }
  rmdirSync(directory);
};

const safePrefix = (value: string): string => value.slice(0, 32);
const boundedDelay = (value: number): number => Math.min(value, 2_147_483_647);
const assertBeforeDeadline = (deadline: number, now: () => number): void => {
  if (now() >= deadline) {
    throw new GenericBatchSupervisorError("run_wall_timeout", "The frozen run wall-time budget expired during filesystem verification.");
  }
};

const pythonImportRoots = (requestedExecutable: string): string[] => {
  const virtualEnvironment = resolve(requestedExecutable, "../..");
  if (!existsSync(join(virtualEnvironment, "pyvenv.cfg"))) return [];
  const lib = join(virtualEnvironment, "lib");
  try {
    return readdirSync(lib)
      .filter((name) => /^python\d+(?:\.\d+)?$/u.test(name))
      .sort()
      .map((name) => join(lib, name, "site-packages"))
      .filter(existsSync);
  } catch {
    return [];
  }
};

const pythonGateWrapper = (importRoots: readonly string[]): string => [
  "import hashlib,json,os,runpy,sys",
  `sys.path[:0]=${JSON.stringify(importRoots)}`,
  "nonce=sys.argv[1]",
  "base=json.loads(sys.argv[2])",
  "receipt_path=sys.argv[3]",
  "unsigned=dict(base,pid=os.getpid(),processGroupId=os.getpgid(0),processStartToken=nonce)",
  "payload=json.dumps(unsigned,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode('utf-8')",
  "receipt=dict(unsigned,receiptDigest=hashlib.sha256(payload).hexdigest())",
  "encoded=json.dumps(receipt,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode('utf-8')+b'\\n'",
  "fd=os.open(receipt_path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o400)",
  "os.write(fd,encoded)",
  "os.fsync(fd)",
  "os.close(fd)",
  "dirfd=os.open(os.path.dirname(receipt_path),os.O_RDONLY)",
  "os.fsync(dirfd)",
  "os.close(dirfd)",
  "os.write(5,b'1')",
  "os.close(5)",
  "gate=os.read(3,1)",
  "if gate != b'1': raise SystemExit(125)",
  "entry=sys.argv[4]",
  "sys.path.insert(0,os.path.dirname(os.path.abspath(entry)))",
  "sys.argv=sys.argv[4:]",
  "os.write(4,b'1')",
  "os.close(4)",
  "runpy.run_path(entry,run_name='__main__')",
].join("\n");
