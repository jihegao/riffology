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
  validateBatchInputV1,
  validateExecutionDescriptionV2,
  visualProcessArguments,
  type BatchInputV1,
  type ExecutionDescriptionV2,
  type ExecutionOutputV2,
} from "./execution-protocol-v2.ts";
import type { VerifiedProjectExecutionRootCapability } from "./generic-batch-supervisor.ts";
import { captureWorkspaceDigest } from "./model-workspace.ts";
import type {
  RunLimitsV1,
  VisualLaunchManifestBinding,
  VisualLaunchReceipt,
} from "./product-store-v2.ts";
import {
  canonicalRestrictedExecutable,
  trustedPythonRuntimeRoots,
} from "./restricted-process.ts";
import {
  inspectVisualListener,
  selectVisualLoopbackPort,
  VisualListenerInspectionError,
} from "./visual-listener-inspector.ts";
import {
  VisualHealthProbe,
  VisualHealthProbeError,
} from "./visual-health-probe.ts";
import {
  createVisualProcessSandboxLaunchSpec,
  VISUAL_LOOPBACK_HOST,
} from "./visual-process-sandbox.ts";

export type FrozenVisualSample = Readonly<{
  sampleIndex: 0;
  sampleId: string;
  parameters: BatchInputV1["parameters"];
  seed: number | null;
}>;

export type FrozenVisualRun = Readonly<{
  runId: string;
  runKind: "visual";
  sample: FrozenVisualSample;
  limits: RunLimitsV1;
}>;

export type VisualScratchPlan = Readonly<{
  processKind: "visual";
  runId: string;
  sampleIndex: 0;
  sampleId: string;
  scratchId: string;
  relativePath: string;
  loopbackPort: number;
  healthPath: string;
}>;

export type VisualScratchDirectoryIdentity = VisualScratchPlan & Readonly<{
  ownerUid: number;
  device: number;
  inode: number;
}>;

export type VisualProcessIdentity = Readonly<{
  processKind: "visual";
  processAttemptId: string;
  runId: string;
  sampleIndex: 0;
  sampleId: string;
  scratchId: string;
  pid: number;
  processGroupId: number;
  processStartToken: string;
  loopbackPort: number;
  healthPath: string;
}>;

export type VisualResultProcessIdentity = Readonly<Omit<
  VisualProcessIdentity,
  "loopbackPort" | "healthPath"
>>;

export type VisualSupervisorHooks = Readonly<{
  planScratch?: (plan: VisualScratchPlan) => Promise<VisualLaunchManifestBinding>;
  registerScratchDirectory?: (identity: VisualScratchDirectoryIdentity) => Promise<void>;
  registerProcess?: (
    identity: VisualProcessIdentity,
    receipt: VisualLaunchReceipt,
  ) => Promise<void>;
  markGateReleased?: (identity: VisualProcessIdentity) => Promise<void>;
  markProcessStarted?: (identity: VisualProcessIdentity) => Promise<void>;
  recordHealth?: (identity: VisualProcessIdentity) => Promise<void>;
}>;

export type VisualOutputCandidate = Readonly<{
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

export type VisualSupervisionResult = Readonly<{
  /**
   * Private dispatcher handoff only. This structure contains process identity,
   * bounded diagnostics, and scratch paths and must never be returned by an
   * HTTP/API serializer.
   */
  runId: string;
  status: "succeeded" | "failed" | "timed_out";
  code: string;
  diagnostic: string;
  startedAt: string;
  finishedAt: string;
  identity: VisualResultProcessIdentity | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  scratchId: string;
  scratchPath: string;
  outputs: readonly VisualOutputCandidate[];
  healthVerified: boolean;
}>;

export type VisualScratchCleanupReceipt = Readonly<{
  schemaVersion: 1;
  runId: string;
  scratchId: string;
  cleanedAt: string;
  verified: true;
  receiptDigest: string;
}>;

export type GenericVisualSupervisorOptions = Readonly<{
  pythonExecutable: string;
  scratchRoot: string;
  registrationTimeoutMs?: number;
  now?: () => number;
}>;

export type SuperviseVisualInput = Readonly<{
  run: FrozenVisualRun;
  project: Readonly<{
    workspace: VerifiedProjectExecutionRootCapability;
    executionDescription: ExecutionDescriptionV2;
  }>;
  hooks?: VisualSupervisorHooks;
  signal?: AbortSignal;
}>;

export class GenericVisualSupervisorError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GenericVisualSupervisorError";
    this.code = code;
  }
}

export const consumeVisualOutputCandidate = (
  candidate: VisualOutputCandidate,
): Buffer => {
  assertNoSymlinkAncestors(candidate.scratchPath, candidate.sourcePath);
  const captured = readStableRegular(
    candidate.sourcePath,
    candidate.owner,
    "run_output_invalid",
  );
  if (captured.device !== candidate.device
    || captured.inode !== candidate.inode
    || captured.bytes.byteLength !== candidate.sizeBytes
    || captured.sha256 !== candidate.sha256) {
    throw new GenericVisualSupervisorError(
      "run_output_invalid",
      "A validated visual output changed before immutable byte capture.",
    );
  }
  return Buffer.from(captured.bytes);
};

type ScratchLease = {
  runId: string;
  scratchId: string;
  relativePath: string;
  path: string;
  ownerUid: number;
  device: number;
  inode: number;
  identity: VisualProcessIdentity | null;
  groupGoneVerified: boolean;
};

type ChildLifecycle = Readonly<{
  completion: Promise<Readonly<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  }>>;
  closed: Promise<void>;
}>;

type ActiveVisualTarget = {
  identity: VisualProcessIdentity;
  groupContinuityLost: boolean;
  groupMonitor?: NodeJS.Timeout;
  termination?: Promise<void>;
};

type Failure = Readonly<{
  status: "failed" | "timed_out";
  code: string;
  diagnostic: string;
}>;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/u;
const REGISTRATION_TIMEOUT_MS = 5_000;
const POLL_MS = 20;
const MAX_TREE_FILES = 10_000;
const MAX_TREE_BYTES = 512 * 1024 * 1024;

/**
 * Supervises one already-claimed visual attempt. Queue claim, global visual
 * admission, heartbeat ownership, terminal Store commits, and HTTP exposure
 * deliberately belong to the later dispatcher layer.
 *
 * The launch-gate/process-group/file helpers below are intentionally local
 * copies of GenericBatchSupervisor's private safety boundary. They should move
 * into a shared internal module once both supervisors have stabilized.
 */
export class GenericVisualSupervisor {
  readonly #requestedPython: string;
  readonly #python: string;
  readonly #runtimeReadRoots: readonly string[];
  readonly #pythonImportRoots: readonly string[];
  readonly #scratchRoot: string;
  readonly #registrationTimeoutMs: number;
  readonly #now: () => number;
  readonly #leases = new Map<string, ScratchLease>();

  constructor(options: GenericVisualSupervisorOptions) {
    this.#requestedPython = options.pythonExecutable;
    this.#python = canonicalRestrictedExecutable(options.pythonExecutable);
    this.#runtimeReadRoots = Object.freeze(
      trustedPythonRuntimeRoots(options.pythonExecutable, this.#python),
    );
    this.#pythonImportRoots = Object.freeze(pythonImportRoots(options.pythonExecutable));
    this.#scratchRoot = canonicalDirectory(options.scratchRoot, "visual scratch root");
    const timeout = options.registrationTimeoutMs ?? REGISTRATION_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > REGISTRATION_TIMEOUT_MS) {
      throw new GenericVisualSupervisorError(
        "invalid_visual_supervisor",
        "The visual launch-gate registration timeout is invalid.",
      );
    }
    this.#registrationTimeoutMs = timeout;
    this.#now = options.now ?? Date.now;
  }

  async supervise(input: SuperviseVisualInput): Promise<VisualSupervisionResult> {
    if (process.platform !== "darwin") {
      throw new GenericVisualSupervisorError(
        "network_isolation_unavailable",
        "Generic visual execution requires the macOS process boundary.",
      );
    }
    const run = validateFrozenVisualRun(input.run);
    const description = validateExecutionDescriptionV2(input.project.executionDescription);
    assertRunCapabilityV2(description, "visual");
    const projectRoot = verifyProjectCapability(input.project.workspace);
    const started = this.#now();
    const wallDeadline = started + run.limits.wallTimeMs;
    const startedAt = new Date(started).toISOString();
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let identity: VisualProcessIdentity | null = null;
    let lifecycle: ChildLifecycle | null = null;
    let child: ChildProcess | null = null;
    let tracked: ActiveVisualTarget | null = null;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let processClosedVerified = false;
    let healthVerified = false;
    let outputs: readonly VisualOutputCandidate[] = Object.freeze([]);
    let failure: Failure | null = null;
    let streamFailure: GenericVisualSupervisorError | null = null;
    let terminationListenerChecked = false;
    let terminationListenerError: unknown = null;

    const inspectBeforeHealthyTermination = (): void => {
      if (!healthVerified || !identity || terminationListenerChecked) return;
      terminationListenerChecked = true;
      try {
        inspectIdentityListener(identity);
      } catch (error) {
        terminationListenerError = error;
      }
    };

    const loopbackPort = await selectVisualLoopbackPort();
    const nonce = randomUUID().replaceAll("-", "");
    const scratchId = `scratch_${nonce}`;
    const relativePath = `riff-${safePrefix(run.runId)}-visual-${nonce}`;
    const scratchPath = join(this.#scratchRoot, relativePath);
    const healthPath = description.visual!.healthPath;
    const plan: VisualScratchPlan = Object.freeze({
      processKind: "visual",
      runId: run.runId,
      sampleIndex: 0,
      sampleId: run.sample.sampleId,
      scratchId,
      relativePath,
      loopbackPort,
      healthPath,
    });
    const manifest = await waitUntil(
      input.hooks?.planScratch?.(plan)
        ?? Promise.resolve(localManifestBinding(plan)),
      wallDeadline,
      this.#now,
      input.signal,
      "run_wall_timeout",
    );
    assertManifestBinding(manifest);

    mkdirSync(scratchPath, { recursive: false, mode: 0o700 });
    const scratchInfo = lstatSync(scratchPath);
    if (scratchInfo.isSymbolicLink() || !scratchInfo.isDirectory()
      || realpathSync(scratchPath) !== scratchPath || dirname(scratchPath) !== this.#scratchRoot) {
      throw new GenericVisualSupervisorError(
        "unsafe_visual_path",
        "The planned visual scratch directory is unsafe.",
      );
    }
    const directoryIdentity: VisualScratchDirectoryIdentity = Object.freeze({
      ...plan,
      ownerUid: scratchInfo.uid,
      device: scratchInfo.dev,
      inode: scratchInfo.ino,
    });
    try {
      await waitUntil(
        input.hooks?.registerScratchDirectory?.(directoryIdentity) ?? Promise.resolve(),
        wallDeadline,
        this.#now,
        input.signal,
        "run_wall_timeout",
      );
    } catch (error) {
      const current = lstatSync(scratchPath);
      if (current.isSymbolicLink() || !current.isDirectory()
        || realpathSync(scratchPath) !== scratchPath
        || current.uid !== scratchInfo.uid
        || current.dev !== scratchInfo.dev
        || current.ino !== scratchInfo.ino) {
        throw new GenericVisualSupervisorError(
          "scratch_cleanup_unverified",
          "The unregistered visual scratch directory changed before rollback.",
          { cause: error },
        );
      }
      rmdirSync(scratchPath);
      throw new GenericVisualSupervisorError(
        "visual_process_failed",
        "The visual scratch directory registration failed.",
        { cause: error },
      );
    }
    const lease: ScratchLease = {
      runId: run.runId,
      scratchId,
      relativePath,
      path: scratchPath,
      ownerUid: scratchInfo.uid,
      device: scratchInfo.dev,
      inode: scratchInfo.ino,
      identity: null,
      groupGoneVerified: true,
    };
    this.#leases.set(scratchId, lease);

    const projectCopy = join(scratchPath, "project");
    const outputDirectory = join(scratchPath, "output");
    const tempDirectory = join(scratchPath, "tmp");
    const inputPath = join(scratchPath, "input.json");
    const receiptPath = join(scratchPath, "launch-receipt.json");

    try {
      ensureNotStopped(input.signal, wallDeadline, this.#now);
      mkdirSync(projectCopy, { recursive: false, mode: 0o700 });
      mkdirSync(outputDirectory, { recursive: false, mode: 0o700 });
      mkdirSync(tempDirectory, { recursive: false, mode: 0o700 });
      const expectedDigest = input.project.workspace.expectedExecutionRootDigest;
      if (captureWorkspaceDigest(input.project.workspace, {
        maxFiles: MAX_TREE_FILES,
        maxTotalBytes: MAX_TREE_BYTES,
      }).digest !== expectedDigest) {
        throw new GenericVisualSupervisorError(
          "project_snapshot_corrupt",
          "The verified Project execution root changed before visual launch.",
        );
      }
      const projectCopyDigest = copyRegularTree(
        projectRoot,
        projectCopy,
        wallDeadline,
        this.#now,
      );
      if (captureWorkspaceDigest(input.project.workspace, {
        maxFiles: MAX_TREE_FILES,
        maxTotalBytes: MAX_TREE_BYTES,
      }).digest !== expectedDigest) {
        throw new GenericVisualSupervisorError(
          "project_snapshot_corrupt",
          "The verified Project execution root changed during visual capture.",
        );
      }
      const visualInput = validateBatchInputV1({
        schemaVersion: 1,
        runId: run.runId,
        sampleIndex: 0,
        sampleId: run.sample.sampleId,
        parameters: run.sample.parameters,
        seed: run.sample.seed,
      });
      writeExclusiveRegular(
        inputPath,
        Buffer.concat([canonicalJsonV2(visualInput), Buffer.from("\n")]),
        0o400,
      );
      const modelArgv = visualProcessArguments(description, inputPath, outputDirectory);
      assertContainedRegular(
        projectCopy,
        resolve(projectCopy, description.visual!.entryPoint),
      );

      const registrationDeadline = Math.min(
        wallDeadline,
        this.#now() + this.#registrationTimeoutMs,
      );
      const launchNonce = `nonce_${randomUUID().replaceAll("-", "")}`;
      const receiptBase = {
        schemaVersion: 1 as const,
        manifestId: manifest.manifestId,
        manifestDigest: manifest.manifestDigest,
        runId: run.runId,
        sampleIndex: 0 as const,
        sampleId: run.sample.sampleId,
        scratchId,
        relativePath,
        loopbackHost: VISUAL_LOOPBACK_HOST,
        loopbackPort,
        healthPath,
        createdAt: new Date(this.#now()).toISOString(),
      };
      const launchSpec = createVisualProcessSandboxLaunchSpec({
        projectRoot: projectCopy,
        inputPath,
        outputRoot: outputDirectory,
        scratchRoot: scratchPath,
        tempRoot: tempDirectory,
        launchReceiptPath: receiptPath,
        executable: this.#requestedPython,
        runtimeReadRoots: this.#runtimeReadRoots,
        assignedHost: VISUAL_LOOPBACK_HOST,
        assignedPort: loopbackPort,
        childArgv: [
          "-I",
          "-c",
          pythonGateWrapper(this.#pythonImportRoots),
          launchNonce,
          JSON.stringify(receiptBase),
          receiptPath,
          ...modelArgv,
        ],
      });
      child = spawn(launchSpec.sandboxExecutable, launchSpec.argv, {
        cwd: launchSpec.cwd,
        env: {
          LANG: "C.UTF-8",
          LC_ALL: "C.UTF-8",
          PYTHONHASHSEED: "0",
          PYTHONNOUSERSITE: "1",
          PYTHONDONTWRITEBYTECODE: "1",
          RIFF_EXECUTION_PROTOCOL: "riff-visual-v1",
          TMPDIR: tempDirectory,
          __CF_USER_TEXT_ENCODING: "0x0:0:0",
        },
        shell: false,
        detached: true,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe", "pipe", "pipe", "pipe"],
      });
      if (!child.pid) {
        throw new GenericVisualSupervisorError(
          "visual_process_failed",
          "The visual launch helper did not receive a PID.",
        );
      }
      lease.groupGoneVerified = false;
      lifecycle = observeChild(child);
      ensureNotStopped(
        input.signal,
        registrationDeadline,
        this.#now,
        "process_registration_timeout",
      );
      const osIdentity = readProcessIdentity(child.pid);
      identity = Object.freeze({
        processKind: "visual",
        processAttemptId: `process_${scratchId}`,
        runId: run.runId,
        sampleIndex: 0,
        sampleId: run.sample.sampleId,
        scratchId,
        pid: osIdentity.pid,
        processGroupId: osIdentity.processGroupId,
        processStartToken: osIdentity.startToken,
        loopbackPort,
        healthPath,
      });
      tracked = {
        identity,
        groupContinuityLost: false,
      };
      lease.identity = identity;
      startGroupMonitor(tracked);
      ensureNotStopped(
        input.signal,
        registrationDeadline,
        this.#now,
        "process_registration_timeout",
      );
      child.stdout!.on("data", (value: Buffer) => {
        const chunk = Buffer.from(value);
        const accepted = chunk.subarray(
          0,
          Math.max(0, run.limits.maxStdoutBytes - stdoutBytes),
        );
        if (accepted.byteLength) {
          stdoutBytes += accepted.byteLength;
        }
        if (accepted.byteLength !== chunk.byteLength) {
          stdoutTruncated = true;
          streamFailure ??= new GenericVisualSupervisorError(
            "run_stdout_limit",
            "The visual stdout byte limit was exceeded.",
          );
          if (identity) {
            inspectBeforeHealthyTermination();
            void terminateTrackedProcess(tracked!, run.limits.terminationGraceMs)
              .catch(() => undefined);
          }
        }
      });
      child.stderr!.on("data", (value: Buffer) => {
        const chunk = Buffer.from(value);
        const accepted = chunk.subarray(
          0,
          Math.max(0, run.limits.maxStderrBytes - stderrBytes),
        );
        if (accepted.byteLength) {
          stderrBytes += accepted.byteLength;
        }
        if (accepted.byteLength !== chunk.byteLength) {
          stderrTruncated = true;
          streamFailure ??= new GenericVisualSupervisorError(
            "run_stderr_limit",
            "The visual stderr byte limit was exceeded.",
          );
          if (identity) {
            inspectBeforeHealthyTermination();
            void terminateTrackedProcess(tracked!, run.limits.terminationGraceMs)
              .catch(() => undefined);
          }
        }
      });

      await waitUntil(
        waitForReceiptSignal(child),
        registrationDeadline,
        this.#now,
        input.signal,
        "process_registration_timeout",
      );
      const receipt = bindVisualReceipt(
        JSON.parse(readFileSync(receiptPath, "utf8")),
        directoryIdentity,
        manifest,
        osIdentity,
      );
      await waitUntil(
        input.hooks?.registerProcess?.(identity, receipt) ?? Promise.resolve(),
        registrationDeadline,
        this.#now,
        input.signal,
        "process_registration_timeout",
      );
      assertSameProcessIdentity(identity, readProcessIdentity(identity.pid));
      await waitUntil(
        input.hooks?.markGateReleased?.(identity) ?? Promise.resolve(),
        registrationDeadline,
        this.#now,
        input.signal,
        "process_registration_timeout",
      );
      const startedSignal = waitForStartedSignal(child);
      releaseGate(child);
      await waitUntil(
        startedSignal,
        registrationDeadline,
        this.#now,
        input.signal,
        "process_registration_timeout",
      );
      await waitUntil(
        input.hooks?.markProcessStarted?.(identity) ?? Promise.resolve(),
        registrationDeadline,
        this.#now,
        input.signal,
        "process_registration_timeout",
      );

      const startupDeadline = Math.min(
        wallDeadline,
        this.#now() + run.limits.startupTimeMs,
      );
      await waitForExactListener(
        identity,
        lifecycle.completion,
        startupDeadline,
        this.#now,
        input.signal,
        () => streamFailure,
      );
      let listenerAssertionFailed = false;
      const assertListener = async (): Promise<void> => {
        try {
          inspectIdentityListener(identity!);
        } catch {
          listenerAssertionFailed = true;
          throw new Error("listener assertion failed");
        }
      };
      try {
        await new VisualHealthProbe({
          host: VISUAL_LOOPBACK_HOST,
          assignedPort: loopbackPort,
          healthPath,
          deadlineAtMs: startupDeadline,
          assertListenerBefore: assertListener,
          assertListenerAfter: assertListener,
        }).probe();
      } catch (error) {
        if (listenerAssertionFailed) {
          throw new GenericVisualSupervisorError(
            "visual_listener_invalid",
            "The visual listener changed during its health probe.",
            { cause: error },
          );
        }
        if (error instanceof VisualHealthProbeError
          && error.code === "visual_health_deadline_exceeded") {
          throw new GenericVisualSupervisorError(
            "visual_startup_timeout",
            "The visual process did not complete health startup in time.",
            { cause: error },
          );
        }
        throw new GenericVisualSupervisorError(
          "visual_health_failed",
          "The visual process failed its one-shot health probe.",
          { cause: error },
        );
      }
      await waitUntil(
        input.hooks?.recordHealth?.(identity) ?? Promise.resolve(),
        wallDeadline,
        this.#now,
        input.signal,
        "run_wall_timeout",
      );
      healthVerified = true;

      const completion = await waitForHealthyCompletion(
        identity,
        tracked,
        lifecycle.completion,
        wallDeadline,
        this.#now,
        input.signal,
        () => streamFailure,
      );
      exitCode = completion.exitCode;
      exitSignal = completion.signal;
      const naturallyGone = await waitForNaturalProcessGroupExit(tracked, 500);
      if (!naturallyGone) {
        await terminateTrackedProcess(tracked, run.limits.terminationGraceMs);
        throw new GenericVisualSupervisorError(
          "visual_process_failed",
          "The visual process left a live process-group member.",
        );
      }
      lease.groupGoneVerified = true;
      stopGroupMonitor(tracked);
      await lifecycle.closed;
      processClosedVerified = true;
      if (stdoutTruncated) {
        throw new GenericVisualSupervisorError(
          "run_stdout_limit",
          "The visual stdout byte limit was exceeded.",
        );
      }
      if (stderrTruncated) {
        throw new GenericVisualSupervisorError(
          "run_stderr_limit",
          "The visual stderr byte limit was exceeded.",
        );
      }
      if (completion.exitCode !== 0 || completion.signal !== null) {
        throw new GenericVisualSupervisorError(
          "visual_process_failed",
          "The visual process exited without successful completion.",
        );
      }
      if (scanRegularTree(projectCopy, wallDeadline, this.#now) !== projectCopyDigest) {
        throw new GenericVisualSupervisorError(
          "project_snapshot_corrupt",
          "The copied Project tree changed during visual execution.",
        );
      }
      outputs = discoverVisualOutputs(
        description,
        outputDirectory,
        scratchPath,
        run.limits,
        wallDeadline,
        this.#now,
      );
    } catch (error) {
      failure = classifyFailure(streamFailure ?? error);
      if (child && lifecycle && !processClosedVerified) {
        try {
          closeGate(child);
          const targetPresent = tracked
            ? verifyTrackedTarget(tracked) === "present"
            : false;
          if (healthVerified && failure?.code !== "visual_listener_invalid") {
            if (targetPresent) inspectBeforeHealthyTermination();
            if (terminationListenerError) {
              failure = classifyFailure(new GenericVisualSupervisorError(
                "visual_listener_invalid",
                "The healthy visual listener changed before termination.",
                { cause: terminationListenerError },
              ));
            }
          }
          if (tracked && targetPresent) {
            await terminateTrackedProcess(tracked, run.limits.terminationGraceMs);
          }
          const cleanupDeadline = Date.now()
            + run.limits.terminationGraceMs
            + 3_000;
          const completion = await waitUntil(
            lifecycle.completion,
            cleanupDeadline,
            Date.now,
            undefined,
            "process_cleanup_unverified",
          );
          exitCode = completion.exitCode;
          exitSignal = completion.signal;
          await waitUntil(
            lifecycle.closed,
            cleanupDeadline,
            Date.now,
            undefined,
            "process_cleanup_unverified",
          );
          lease.groupGoneVerified = tracked
            ? verifyTrackedTarget(tracked) === "gone"
            : liveProcessGroupMembers(
              stableProcessGroupMembers(child.pid!),
            ).length === 0;
          if (tracked) stopGroupMonitor(tracked);
          if (!lease.groupGoneVerified) {
            failure = classifyFailure(new GenericVisualSupervisorError(
              "process_cleanup_unverified",
              "The failed visual process group remains alive.",
            ));
          }
        } catch (cleanupError) {
          failure = classifyFailure(cleanupError);
        }
      }
      outputs = Object.freeze([]);
    }

    return Object.freeze({
      runId: run.runId,
      status: failure?.status ?? "succeeded",
      code: failure?.code ?? "visual_run_succeeded",
      diagnostic: failure?.diagnostic
        ?? "The visual process passed health, exited cleanly, and produced declared outputs.",
      startedAt,
      finishedAt: new Date(this.#now()).toISOString(),
      identity: identity ? redactResultIdentity(identity) : null,
      exitCode,
      signal: exitSignal,
      stdoutBytes,
      stderrBytes,
      stdoutTruncated,
      stderrTruncated,
      scratchId,
      scratchPath,
      outputs,
      healthVerified,
    });
  }

  cleanup(result: VisualSupervisionResult): VisualScratchCleanupReceipt {
    const lease = this.#leases.get(result.scratchId);
    if (!SAFE_ID.test(result.runId) || !lease || lease.runId !== result.runId
      || lease.path !== result.scratchPath || !lease.groupGoneVerified) {
      throw new GenericVisualSupervisorError(
        "scratch_cleanup_unverified",
        "The visual scratch lease is absent, mismatched, or still active.",
      );
    }
    if (lease.identity) verifyIdentityGoneForCleanup(lease.identity);
    const info = lstatSync(lease.path);
    if (info.isSymbolicLink() || !info.isDirectory()
      || realpathSync(lease.path) !== lease.path
      || dirname(lease.path) !== this.#scratchRoot
      || info.uid !== lease.ownerUid || info.dev !== lease.device || info.ino !== lease.inode) {
      throw new GenericVisualSupervisorError(
        "scratch_cleanup_unverified",
        "The exact visual scratch directory changed before cleanup.",
      );
    }
    removeOwnedTree(lease.path);
    if (existsSync(lease.path)) {
      throw new GenericVisualSupervisorError(
        "scratch_cleanup_unverified",
        "The visual scratch directory remains after cleanup.",
      );
    }
    this.#leases.delete(result.scratchId);
    const unsigned = {
      schemaVersion: 1 as const,
      runId: result.runId,
      scratchId: result.scratchId,
      cleanedAt: new Date(this.#now()).toISOString(),
      verified: true as const,
    };
    return Object.freeze({
      ...unsigned,
      receiptDigest: canonicalDigest(unsigned),
    });
  }
}

const validateFrozenVisualRun = (run: FrozenVisualRun): FrozenVisualRun => {
  if (!run || typeof run !== "object" || run.runKind !== "visual"
    || !SAFE_ID.test(run.runId) || !run.sample || run.sample.sampleIndex !== 0) {
    throw new GenericVisualSupervisorError(
      "invalid_visual_input",
      "The frozen visual run is invalid.",
    );
  }
  validateBatchInputV1({
    schemaVersion: 1,
    runId: run.runId,
    sampleIndex: 0,
    sampleId: run.sample.sampleId,
    parameters: run.sample.parameters,
    seed: run.sample.seed,
  });
  const limits = run.limits;
  const keys = [
    "schemaVersion", "wallTimeMs", "startupTimeMs", "terminationGraceMs",
    "maxStdoutBytes", "maxStderrBytes", "maxOutputFiles", "maxOutputBytes",
    "maxEventCount", "maxEventBytes", "maxSamples", "maxConcurrency",
  ].sort();
  if (!limits || typeof limits !== "object"
    || Object.keys(limits).sort().join("\n") !== keys.join("\n")
    || limits.schemaVersion !== 1
    || keys.some((key) => key !== "schemaVersion"
      && (!Number.isSafeInteger(limits[key as keyof RunLimitsV1])
        || Number(limits[key as keyof RunLimitsV1]) < 1))) {
    throw new GenericVisualSupervisorError(
      "invalid_visual_input",
      "The frozen visual limits are invalid.",
    );
  }
  return run;
};

const verifyProjectCapability = (
  workspace: VerifiedProjectExecutionRootCapability,
): string => {
  if (workspace.capabilityKind !== "verified-project-execution-root-v1"
    || !/^[0-9a-f]{64}$/u.test(workspace.expectedExecutionRootDigest)) {
    throw new GenericVisualSupervisorError(
      "project_snapshot_corrupt",
      "The Project execution capability is invalid.",
    );
  }
  const root = canonicalDirectory(workspace.root, "Project execution root");
  if (root !== workspace.root) {
    throw new GenericVisualSupervisorError(
      "project_snapshot_corrupt",
      "The Project execution root changed before visual launch.",
    );
  }
  return root;
};

const copyRegularTree = (
  sourceRoot: string,
  destinationRoot: string,
  deadline: number,
  now: () => number,
): string => {
  let files = 0;
  let bytes = 0;
  const owner = statSync(sourceRoot).uid;
  const manifest: Array<Readonly<{
    relativePath: string;
    sizeBytes: number;
    sha256: string;
  }>> = [];
  const visit = (source: string, destination: string): void => {
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      ensureNotStopped(undefined, deadline, now);
      const sourcePath = join(source, entry.name);
      const destinationPath = join(destination, entry.name);
      const info = lstatSync(sourcePath);
      if (info.isSymbolicLink()) {
        throw new GenericVisualSupervisorError(
          "project_snapshot_corrupt",
          "The Project snapshot contains a symbolic link.",
        );
      }
      if (info.isDirectory()) {
        mkdirSync(destinationPath, { recursive: false, mode: 0o700 });
        visit(sourcePath, destinationPath);
        chmodSync(destinationPath, 0o500);
        continue;
      }
      files += 1;
      bytes += info.size;
      if (!info.isFile() || info.nlink !== 1 || info.uid !== owner
        || files > MAX_TREE_FILES || bytes > MAX_TREE_BYTES) {
        throw new GenericVisualSupervisorError(
          "project_snapshot_corrupt",
          "The Project snapshot contains an unsafe or excessive file.",
        );
      }
      const captured = readStableRegular(
        sourcePath,
        owner,
        "project_snapshot_corrupt",
      );
      writeExclusiveRegular(destinationPath, captured.bytes, 0o400);
      manifest.push(Object.freeze({
        relativePath: relative(sourceRoot, sourcePath).split(sep).join("/"),
        sizeBytes: captured.bytes.byteLength,
        sha256: captured.sha256,
      }));
    }
  };
  visit(sourceRoot, destinationRoot);
  chmodSync(destinationRoot, 0o500);
  return sha256Hex(canonicalJsonV2(manifest.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath, "en"))));
};

const scanRegularTree = (
  root: string,
  deadline: number,
  now: () => number,
): string => {
  const owner = statSync(root).uid;
  const manifest: Array<Readonly<{
    relativePath: string;
    sizeBytes: number;
    sha256: string;
  }>> = [];
  let files = 0;
  let bytes = 0;
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      ensureNotStopped(undefined, deadline, now);
      const path = join(directory, entry.name);
      const info = lstatSync(path);
      if (info.isSymbolicLink()) {
        throw new GenericVisualSupervisorError(
          "project_snapshot_corrupt",
          "The copied Project tree contains a symbolic link.",
        );
      }
      if (info.isDirectory()) {
        visit(path);
        continue;
      }
      files += 1;
      bytes += info.size;
      if (!info.isFile() || files > MAX_TREE_FILES || bytes > MAX_TREE_BYTES) {
        throw new GenericVisualSupervisorError(
          "project_snapshot_corrupt",
          "The copied Project tree is unsafe or excessive.",
        );
      }
      const captured = readStableRegular(path, owner, "project_snapshot_corrupt");
      manifest.push(Object.freeze({
        relativePath: relative(root, path).split(sep).join("/"),
        sizeBytes: captured.bytes.byteLength,
        sha256: captured.sha256,
      }));
    }
  };
  visit(root);
  return sha256Hex(canonicalJsonV2(manifest.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath, "en"))));
};

const canonicalDirectory = (input: string, label: string): string => {
  try {
    const absolute = resolve(input);
    if (lstatSync(absolute).isSymbolicLink()) throw new Error("symlink");
    const canonical = realpathSync(absolute);
    if (!statSync(canonical).isDirectory()) throw new Error("not directory");
    return canonical;
  } catch (error) {
    throw new GenericVisualSupervisorError(
      "unsafe_visual_path",
      `The ${label} is unavailable or unsafe.`,
      { cause: error },
    );
  }
};

const writeExclusiveRegular = (
  path: string,
  bytes: Uint8Array,
  mode: number,
): void => {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      mode,
    );
    writeFileSync(descriptor, bytes);
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.nlink !== 1 || info.size !== bytes.byteLength) {
      throw new Error("unsafe write");
    }
  } catch (error) {
    throw new GenericVisualSupervisorError(
      "unsafe_visual_path",
      "An application-owned visual scratch file could not be created safely.",
      { cause: error },
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
};

const assertContainedRegular = (root: string, path: string): void => {
  const logical = relative(root, path);
  if (!logical || logical === ".." || logical.startsWith(`..${sep}`)) {
    throw new GenericVisualSupervisorError(
      "visual_process_failed",
      "The visual entry point escaped its Project copy.",
    );
  }
  let cursor = path;
  while (true) {
    const info = lstatSync(cursor);
    if (info.isSymbolicLink()
      || (cursor === path ? !info.isFile() || info.nlink !== 1 : !info.isDirectory())) {
      throw new GenericVisualSupervisorError(
        "visual_process_failed",
        "The visual entry point path is unsafe.",
      );
    }
    if (cursor === root) return;
    cursor = dirname(cursor);
  }
};

const localManifestBinding = (
  plan: VisualScratchPlan,
): VisualLaunchManifestBinding => {
  const manifest = { schemaVersion: 1, kind: "visual_process_launch", ...plan };
  return Object.freeze({
    manifestId: `launch_${canonicalDigest(manifest).slice(0, 32)}`,
    manifestDigest: canonicalDigest(manifest),
  });
};

const assertManifestBinding = (binding: VisualLaunchManifestBinding): void => {
  if (!binding || !SAFE_ID.test(binding.manifestId)
    || !/^[0-9a-f]{64}$/u.test(binding.manifestDigest)) {
    throw new GenericVisualSupervisorError(
      "visual_process_failed",
      "The visual launch manifest binding is invalid.",
    );
  }
};

const readProcessIdentity = (
  pid: number,
): Readonly<{
  pid: number;
  processGroupId: number;
  startToken: string;
  state: string;
}> => {
  if (!Number.isSafeInteger(pid) || pid < 1) {
    throw new GenericVisualSupervisorError(
      "process_identity_unavailable",
      "The visual process PID is invalid.",
    );
  }
  const probe = spawnSync(
    "/bin/ps",
    ["-o", "state=", "-o", "pgid=", "-o", "lstart=", "-p", String(pid)],
    { encoding: "utf8", timeout: 1_000, env: { LANG: "C", LC_ALL: "C" } },
  );
  const match = /^\s*(\S+)\s+(\d+)\s+(.+?)\s*$/u.exec(probe.stdout ?? "");
  const state = match?.[1] ?? "";
  const processGroupId = Number(match?.[2]);
  const startToken = match?.[3]?.trim() ?? "";
  if (probe.status !== 0 || !probe.stdout?.trim()) {
    throw new GenericVisualSupervisorError(
      "process_identity_unavailable",
      "The visual launch process identity could not be verified.",
    );
  }
  if (processGroupId !== pid || !state || !startToken) {
    throw new GenericVisualSupervisorError(
      "process_identity_mismatch",
      "The visual launch helper is not its expected process-group leader.",
    );
  }
  return Object.freeze({ pid, processGroupId, startToken, state });
};

const assertSameProcessIdentity = (
  expected: VisualProcessIdentity,
  actual: Readonly<{
    pid: number;
    processGroupId: number;
    startToken: string;
    state?: string;
  }>,
): void => {
  if (expected.pid !== actual.pid
    || expected.processGroupId !== actual.processGroupId
    || expected.processStartToken !== actual.startToken) {
    throw new GenericVisualSupervisorError(
      "visual_process_failed",
      "The visual process identity changed before gate release.",
    );
  }
};

const bindVisualReceipt = (
  value: unknown,
  scratch: VisualScratchDirectoryIdentity,
  manifest: VisualLaunchManifestBinding,
  identity: Readonly<{ pid: number; processGroupId: number; startToken: string }>,
): VisualLaunchReceipt => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GenericVisualSupervisorError(
      "visual_process_failed",
      "The visual launch receipt has an invalid shape.",
    );
  }
  const receipt = value as VisualLaunchReceipt;
  const expectedKeys = [
    "createdAt", "healthPath", "loopbackHost", "loopbackPort", "manifestDigest",
    "manifestId", "pid", "processGroupId", "processStartToken", "receiptDigest",
    "relativePath", "runId", "sampleId", "sampleIndex", "schemaVersion", "scratchId",
  ].sort().join("\n");
  const { receiptDigest, ...unsignedReceipt } = receipt;
  const createdAt = Date.parse(receipt.createdAt);
  const observedAt = Date.parse(identity.startToken);
  if (Object.keys(receipt).sort().join("\n") !== expectedKeys
    || receipt.schemaVersion !== 1
    || receipt.manifestId !== manifest.manifestId
    || receipt.manifestDigest !== manifest.manifestDigest
    || receipt.runId !== scratch.runId
    || receipt.sampleIndex !== 0
    || receipt.sampleId !== scratch.sampleId
    || receipt.scratchId !== scratch.scratchId
    || receipt.relativePath !== scratch.relativePath
    || receipt.loopbackHost !== VISUAL_LOOPBACK_HOST
    || receipt.loopbackPort !== scratch.loopbackPort
    || receipt.healthPath !== scratch.healthPath
    || receipt.pid !== identity.pid
    || receipt.processGroupId !== identity.processGroupId
    || typeof receipt.processStartToken !== "string"
    || receipt.processStartToken.length < 1
    || receipt.processStartToken.length > 300
    || !Number.isFinite(createdAt)
    || !Number.isFinite(observedAt)
    || Math.abs(createdAt - observedAt) > 10_000
    || !/^[0-9a-f]{64}$/u.test(receiptDigest)
    || canonicalDigest(unsignedReceipt) !== receiptDigest) {
    throw new GenericVisualSupervisorError(
      "visual_process_failed",
      "The visual launch receipt does not match its durable launch identity.",
    );
  }
  const unsigned = {
    ...unsignedReceipt,
    processStartToken: identity.startToken,
  };
  return Object.freeze({
    ...unsigned,
    receiptDigest: canonicalDigest(unsigned),
  }) as VisualLaunchReceipt;
};

const observeChild = (child: ChildProcess): ChildLifecycle => ({
  completion: new Promise((resolveCompletion, rejectCompletion) => {
    child.once("error", (error) => rejectCompletion(new GenericVisualSupervisorError(
      "visual_process_failed",
      "The visual process failed.",
      { cause: error },
    )));
    child.once("exit", (exitCode, signal) => resolveCompletion(Object.freeze({
      exitCode,
      signal: signal as NodeJS.Signals | null,
    })));
  }),
  closed: new Promise((resolveClosed, rejectClosed) => {
    child.once("error", (error) => rejectClosed(new GenericVisualSupervisorError(
      "visual_process_failed",
      "The visual process streams failed.",
      { cause: error },
    )));
    child.once("close", () => resolveClosed());
  }),
});

const waitForReceiptSignal = (child: ChildProcess): Promise<void> =>
  waitForPipeByte(child, 5, "receipt");

const waitForStartedSignal = (child: ChildProcess): Promise<void> =>
  waitForPipeByte(child, 4, "start");

const waitForPipeByte = (
  child: ChildProcess,
  descriptor: number,
  label: string,
): Promise<void> => new Promise((resolveSignal, rejectSignal) => {
  const stream = child.stdio[descriptor];
  if (!stream || typeof stream === "number" || !("once" in stream)) {
    rejectSignal(new GenericVisualSupervisorError(
      "visual_process_failed",
      `The visual launch-gate ${label} pipe is unavailable.`,
    ));
    return;
  }
  let received = false;
  stream.once("data", (chunk: Buffer) => {
    received = true;
    if (Buffer.from(chunk).subarray(0, 1).toString() === "1") resolveSignal();
    else rejectSignal(new GenericVisualSupervisorError(
      "visual_process_failed",
      `The visual launch-gate ${label} acknowledgement is invalid.`,
    ));
  });
  stream.once("error", (error) => rejectSignal(new GenericVisualSupervisorError(
    "visual_process_failed",
    `The visual launch-gate ${label} acknowledgement failed.`,
    { cause: error },
  )));
  stream.once("end", () => {
    if (!received) rejectSignal(new GenericVisualSupervisorError(
      "visual_process_failed",
      `The visual launch gate closed before ${label} acknowledgement.`,
    ));
  });
});

const releaseGate = (child: ChildProcess): void => {
  const stream = child.stdio[3];
  if (!stream || typeof stream === "number" || !("end" in stream)) {
    throw new GenericVisualSupervisorError(
      "visual_process_failed",
      "The visual launch-gate release pipe is unavailable.",
    );
  }
  stream.end("1");
};

const closeGate = (child: ChildProcess): void => {
  const stream = child.stdio[3];
  if (stream && typeof stream !== "number" && "end" in stream) stream.end();
};

const waitUntil = async <T>(
  promise: Promise<T>,
  deadline: number,
  now: () => number,
  signal: AbortSignal | undefined,
  timeoutCode: string,
): Promise<T> => {
  const remaining = deadline - now();
  if (remaining <= 0) {
    throw new GenericVisualSupervisorError(timeoutCode, "The visual deadline expired.");
  }
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new GenericVisualSupervisorError(
          timeoutCode,
          "The visual deadline expired.",
        )), Math.min(remaining, 2_147_483_647));
        timer.unref?.();
      }),
      new Promise<never>((_resolve, reject) => {
        if (!signal) return;
        onAbort = () => reject(new GenericVisualSupervisorError(
          "dispatcher_shutdown",
          "The visual dispatcher shut down during supervision.",
        ));
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
};

const waitForHealthyCompletion = async <T>(
  identity: VisualProcessIdentity,
  tracked: ActiveVisualTarget,
  completion: Promise<T>,
  deadline: number,
  now: () => number,
  signal?: AbortSignal,
  currentStreamFailure?: () => GenericVisualSupervisorError | null,
): Promise<T> => {
  while (true) {
    ensureNotStopped(signal, deadline, now);
    const streamError = currentStreamFailure?.();
    if (streamError) throw streamError;
    const outcome = await Promise.race([
      completion.then((value) => Object.freeze({ kind: "completed" as const, value })),
      delay(POLL_MS).then(() => Object.freeze({ kind: "poll" as const })),
    ]);
    if (outcome.kind === "completed") return outcome.value;
    try {
      inspectIdentityListener(identity);
    } catch (error) {
      // The poll timer and Node's child "exit" event are separate event-loop
      // observations. Under load the timer can win after the kernel has already
      // closed the listener and reaped the exact process group, while the exit
      // callback is still queued. Reconcile against the frozen OS identity:
      // listener loss is healthy only when that exact target is already gone.
      if (error instanceof VisualListenerInspectionError
        && (error.code === "visual_listener_identity_mismatch"
          || error.code === "visual_listener_missing")
        && verifyTrackedTarget(tracked) === "gone") {
        return await waitUntil(
          completion,
          deadline,
          now,
          signal,
          "run_wall_timeout",
        );
      }
      throw new GenericVisualSupervisorError(
        "visual_listener_invalid",
        "The healthy visual listener closed or changed before process exit.",
        { cause: error },
      );
    }
  }
};

const waitForExactListener = async (
  identity: VisualProcessIdentity,
  completion: ChildLifecycle["completion"],
  deadline: number,
  now: () => number,
  signal?: AbortSignal,
  currentStreamFailure?: () => GenericVisualSupervisorError | null,
): Promise<void> => {
  while (true) {
    ensureNotStopped(signal, deadline, now, "visual_startup_timeout");
    const streamError = currentStreamFailure?.();
    if (streamError) throw streamError;
    try {
      inspectIdentityListener(identity);
      return;
    } catch (error) {
      if (!(error instanceof VisualListenerInspectionError)
        || error.code !== "visual_listener_missing") {
        throw new GenericVisualSupervisorError(
          "visual_listener_invalid",
          "The visual listener did not match its frozen process identity.",
          { cause: error },
        );
      }
    }
    const outcome = await Promise.race([
      completion.then((value) => Object.freeze({ kind: "completed" as const, value })),
      delay(POLL_MS).then(() => Object.freeze({ kind: "poll" as const })),
    ]);
    if (outcome.kind === "completed") {
      throw new GenericVisualSupervisorError(
        "visual_process_failed",
        "The visual process exited before its listener became ready.",
      );
    }
  }
};

const inspectIdentityListener = (identity: VisualProcessIdentity): void => {
  inspectVisualListener({
    runId: identity.runId,
    processAttemptId: identity.processAttemptId,
    pid: identity.pid,
    processStartToken: identity.processStartToken,
    processGroupId: identity.processGroupId,
    assignedPort: identity.loopbackPort,
  });
};

const ensureNotStopped = (
  signal: AbortSignal | undefined,
  deadline: number,
  now: () => number,
  timeoutCode = "run_wall_timeout",
): void => {
  if (signal?.aborted) {
    throw new GenericVisualSupervisorError(
      "dispatcher_shutdown",
      "The visual dispatcher shut down during supervision.",
    );
  }
  if (now() >= deadline) {
    throw new GenericVisualSupervisorError(
      timeoutCode,
      "The visual supervision deadline expired.",
    );
  }
};

type ProcessGroupMember = Readonly<{
  pid: number;
  processGroupId: number;
  state: string;
  startToken: string;
}>;

const readProcessGroupMembers = (
  processGroupId: number,
): readonly ProcessGroupMember[] => {
  const probe = spawnSync(
    "/bin/ps",
    ["-axo", "pid=", "-o", "pgid=", "-o", "state=", "-o", "lstart="],
    { encoding: "utf8", timeout: 1_000, env: { LANG: "C", LC_ALL: "C" } },
  );
  if (probe.status !== 0) {
    throw new GenericVisualSupervisorError(
      "process_cleanup_unverified",
      "The visual process group could not be inspected.",
    );
  }
  const members: ProcessGroupMember[] = [];
  for (const line of probe.stdout.split(/\r?\n/u)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/u.exec(line);
    if (!match || Number(match[2]) !== processGroupId) continue;
    members.push(Object.freeze({
      pid: Number(match[1]),
      processGroupId: Number(match[2]),
      state: match[3]!,
      startToken: match[4]!,
    }));
  }
  return Object.freeze(members.sort((left, right) => left.pid - right.pid));
};

const stableProcessGroupMembers = (
  processGroupId: number,
): readonly ProcessGroupMember[] => {
  let previous = readProcessGroupMembers(processGroupId);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const current = readProcessGroupMembers(processGroupId);
    if (canonicalDigest(previous) === canonicalDigest(current)) {
      return current;
    }
    previous = current;
  }
  throw new GenericVisualSupervisorError(
    "process_cleanup_unverified",
    "The visual process-group identity did not reach a stable observation.",
  );
};

const startGroupMonitor = (tracked: ActiveVisualTarget): void => {
  tracked.groupMonitor = setInterval(() => {
    try {
      if (liveProcessGroupMembers(
        readProcessGroupMembers(tracked.identity.processGroupId),
      ).length === 0) {
        tracked.groupContinuityLost = true;
      }
    } catch {
      tracked.groupContinuityLost = true;
    }
  }, 25);
  tracked.groupMonitor.unref?.();
};

const stopGroupMonitor = (tracked: ActiveVisualTarget): void => {
  if (tracked.groupMonitor) clearInterval(tracked.groupMonitor);
  tracked.groupMonitor = undefined;
};

const verifyTrackedTarget = (
  tracked: ActiveVisualTarget,
): "present" | "gone" => {
  let leaderIsZombie = false;
  try {
    const current = readProcessIdentity(tracked.identity.pid);
    assertSameProcessIdentity(tracked.identity, current);
    leaderIsZombie = current.state.startsWith("Z");
    if (!leaderIsZombie) return "present";
  } catch (error) {
    if (!(error instanceof GenericVisualSupervisorError)
      || error.code !== "process_identity_unavailable") {
      throw error;
    }
  }
  const members = liveProcessGroupMembers(
    stableProcessGroupMembers(tracked.identity.processGroupId),
  );
  if (members.length === 0) {
    tracked.groupContinuityLost = true;
    return "gone";
  }
  if (tracked.groupContinuityLost) {
    throw new GenericVisualSupervisorError(
      "process_cleanup_unverified",
      "The visual process-group continuity was lost before signalling.",
    );
  }
  return "present";
};

const terminateTrackedProcess = (
  tracked: ActiveVisualTarget,
  graceMs: number,
): Promise<void> => {
  if (tracked.termination) return tracked.termination;
  tracked.termination = (async () => {
    if (verifyTrackedTarget(tracked) === "gone") {
      stopGroupMonitor(tracked);
      return;
    }
    try {
      process.kill(-tracked.identity.processGroupId, "SIGTERM");
    } catch (error) {
      if (verifyTrackedTarget(tracked) === "gone") {
        stopGroupMonitor(tracked);
        return;
      }
      throw new GenericVisualSupervisorError(
        "process_cleanup_unverified",
        "The exact visual process group could not receive SIGTERM.",
        { cause: error },
      );
    }
    if (await waitForTrackedGone(tracked, graceMs)) {
      stopGroupMonitor(tracked);
      return;
    }
    if (verifyTrackedTarget(tracked) === "gone") {
      stopGroupMonitor(tracked);
      return;
    }
    process.kill(-tracked.identity.processGroupId, "SIGKILL");
    if (!await waitForTrackedGone(tracked, 2_000)) {
      throw new GenericVisualSupervisorError(
        "process_cleanup_unverified",
        "The exact visual process group survived SIGKILL.",
      );
    }
    stopGroupMonitor(tracked);
  })();
  return tracked.termination;
};

const verifyIdentityGoneForCleanup = (
  identity: VisualProcessIdentity,
): void => {
  try {
    const current = readProcessIdentity(identity.pid);
    if (current.pid === identity.pid
      && current.processGroupId === identity.processGroupId
      && current.startToken === identity.processStartToken
      && !current.state.startsWith("Z")) {
      throw new GenericVisualSupervisorError(
        "scratch_cleanup_unverified",
        "The exact visual process identity remains active before cleanup.",
      );
    }
    throw new GenericVisualSupervisorError(
      "scratch_cleanup_unverified",
      "The visual process PID was reused before cleanup.",
    );
  } catch (error) {
    if (!(error instanceof GenericVisualSupervisorError)
      || error.code !== "process_identity_unavailable") {
      throw error;
    }
  }
  if (liveProcessGroupMembers(
    stableProcessGroupMembers(identity.processGroupId),
  ).length !== 0) {
    throw new GenericVisualSupervisorError(
      "scratch_cleanup_unverified",
      "The exact visual process group remains active before cleanup.",
    );
  }
};

const liveProcessGroupMembers = (
  members: readonly ProcessGroupMember[],
): readonly ProcessGroupMember[] =>
  members.filter((member) => !member.state.startsWith("Z"));

const waitForTrackedGone = async (
  tracked: ActiveVisualTarget,
  timeoutMs: number,
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (verifyTrackedTarget(tracked) === "gone") return true;
    await delay(POLL_MS);
  }
  return verifyTrackedTarget(tracked) === "gone";
};

const waitForNaturalProcessGroupExit = async (
  tracked: ActiveVisualTarget,
  timeoutMs: number,
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (verifyTrackedTarget(tracked) === "gone") return true;
    } catch (error) {
      if (!(error instanceof GenericVisualSupervisorError)
        || error.code !== "process_cleanup_unverified") {
        throw error;
      }
      // A leader exit can race the two OS snapshots. Retry without signalling;
      // only an exact stable target may ever reach terminateTrackedProcess.
    }
    await delay(POLL_MS);
  }
  try {
    return verifyTrackedTarget(tracked) === "gone";
  } catch (error) {
    if (error instanceof GenericVisualSupervisorError
      && error.code === "process_cleanup_unverified") {
      return false;
    }
    throw error;
  }
};

const discoverVisualOutputs = (
  description: ExecutionDescriptionV2,
  outputDirectory: string,
  scratchPath: string,
  limits: RunLimitsV1,
  deadline: number,
  now: () => number,
): readonly VisualOutputCandidate[] => {
  const root = lstatSync(outputDirectory);
  if (root.isSymbolicLink() || !root.isDirectory()
    || realpathSync(outputDirectory) !== outputDirectory) {
    throw new GenericVisualSupervisorError(
      "run_output_invalid",
      "The visual output directory changed before discovery.",
    );
  }
  const declarations = new Map(
    description.outputs.map((output) => [output.relativePath, output]),
  );
  const found = new Map<string, ReturnType<typeof captureRegular>>();
  let count = 0;
  let bytes = 0;
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      ensureNotStopped(undefined, deadline, now);
      count += 1;
      if (count > limits.maxOutputFiles) {
        throw new GenericVisualSupervisorError(
          "run_output_file_limit",
          "The visual output file limit was exceeded.",
        );
      }
      const path = join(directory, entry.name);
      const logical = relative(outputDirectory, path).split(sep).join("/");
      const info = lstatSync(path);
      if (info.isSymbolicLink()) {
        throw new GenericVisualSupervisorError(
          "run_output_invalid",
          "A visual output contains a symbolic link.",
        );
      }
      if (info.isDirectory()) {
        visit(path);
        continue;
      }
      if (!info.isFile() || info.nlink !== 1 || info.uid !== root.uid) {
        throw new GenericVisualSupervisorError(
          "run_output_invalid",
          "A visual output is not a single-link owned regular file.",
        );
      }
      if (!declarations.has(logical)) {
        throw new GenericVisualSupervisorError(
          "run_output_invalid",
          "The visual process wrote an undeclared output.",
        );
      }
      const captured = captureRegular(path, root.uid);
      bytes += captured.bytes.byteLength;
      if (bytes > limits.maxOutputBytes) {
        throw new GenericVisualSupervisorError(
          "run_output_byte_limit",
          "The visual output byte limit was exceeded.",
        );
      }
      found.set(logical, captured);
    }
  };
  visit(outputDirectory);
  const candidates: VisualOutputCandidate[] = [];
  for (const [logical, declaration] of declarations) {
    const captured = found.get(logical);
    if (!captured) {
      if (declaration.required) {
        throw new GenericVisualSupervisorError(
          "run_output_invalid",
          "A required visual output is missing.",
        );
      }
      continue;
    }
    validateMedia(captured.bytes, declaration.mediaType);
    candidates.push(Object.freeze({
      logicalName: declaration.logicalName,
      relativePath: logical,
      mediaType: declaration.mediaType,
      role: declaration.role,
      sourcePath: captured.path,
      scratchPath,
      sizeBytes: captured.bytes.byteLength,
      sha256: sha256Hex(captured.bytes),
      owner: root.uid,
      device: captured.device,
      inode: captured.inode,
    }));
  }
  return Object.freeze(candidates);
};

const captureRegular = (
  path: string,
  owner: number,
): Readonly<{ path: string; bytes: Buffer; device: number; inode: number }> => {
  const captured = readStableRegular(path, owner, "run_output_invalid");
  return Object.freeze({
    path,
    bytes: captured.bytes,
    device: captured.device,
    inode: captured.inode,
  });
};

const readStableRegular = (
  path: string,
  owner: number,
  code: string,
): Readonly<{
  bytes: Buffer;
  sha256: string;
  device: number;
  inode: number;
}> => {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || before.uid !== owner) {
      throw new Error("unsafe file");
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    const pathAfter = lstatSync(path);
    if (before.dev !== after.dev || before.ino !== after.ino
      || before.mode !== after.mode || before.uid !== after.uid
      || before.nlink !== after.nlink || before.size !== after.size
      || after.dev !== pathAfter.dev || after.ino !== pathAfter.ino
      || after.mode !== pathAfter.mode || after.uid !== pathAfter.uid
      || after.nlink !== pathAfter.nlink || after.size !== pathAfter.size
      || bytes.byteLength !== after.size) {
      throw new Error("file changed");
    }
    return Object.freeze({
      bytes,
      sha256: sha256Hex(bytes),
      device: after.dev,
      inode: after.ino,
    });
  } catch (error) {
    throw new GenericVisualSupervisorError(
      code,
      "A no-follow visual file verification failed.",
      { cause: error },
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
};

const assertNoSymlinkAncestors = (
  root: string,
  path: string,
): void => {
  const logical = relative(root, path);
  if (!logical || logical === ".." || logical.startsWith(`..${sep}`)
    || logical.startsWith(sep)) {
    throw new GenericVisualSupervisorError(
      "run_output_invalid",
      "A visual output escaped its scratch root.",
    );
  }
  let cursor = dirname(path);
  while (true) {
    const info = lstatSync(cursor);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new GenericVisualSupervisorError(
        "run_output_invalid",
        "A visual output ancestor changed before capture.",
      );
    }
    if (cursor === root) return;
    cursor = dirname(cursor);
  }
};

const validateMedia = (bytes: Buffer, mediaType: string): void => {
  try {
    if (mediaType === "application/json" || mediaType.endsWith("+json")) {
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } else if (mediaType.startsWith("text/")) {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    }
  } catch (error) {
    throw new GenericVisualSupervisorError(
      "run_output_invalid",
      "A declared visual output does not match its media type.",
      { cause: error },
    );
  }
};

const classifyFailure = (error: unknown): Failure => {
  if (error instanceof GenericVisualSupervisorError) {
    return Object.freeze({
      status: error.code === "run_wall_timeout"
        || error.code === "visual_startup_timeout"
        ? "timed_out"
        : "failed",
      code: error.code,
      diagnostic: boundedDiagnostic(error.message),
    });
  }
  return Object.freeze({
    status: "failed",
    code: "visual_process_failed",
    diagnostic: "The visual supervisor failed.",
  });
};

const redactResultIdentity = (
  identity: VisualProcessIdentity,
): VisualResultProcessIdentity => Object.freeze({
  processKind: identity.processKind,
  processAttemptId: identity.processAttemptId,
  runId: identity.runId,
  sampleIndex: identity.sampleIndex,
  sampleId: identity.sampleId,
  scratchId: identity.scratchId,
  pid: identity.pid,
  processGroupId: identity.processGroupId,
  processStartToken: identity.processStartToken,
});

const removeOwnedTree = (directory: string): void => {
  chmodSync(directory, 0o700);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const info = lstatSync(path);
    if (info.isDirectory() && !info.isSymbolicLink()) {
      removeOwnedTree(path);
    } else {
      unlinkSync(path);
    }
  }
  rmdirSync(directory);
};

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

const boundedDiagnostic = (message: string): string =>
  Buffer.from(message, "utf8").subarray(0, 2_048).toString("utf8");

const safePrefix = (value: string): string => value.slice(0, 32);

const pythonImportRoots = (requestedExecutable: string): string[] => {
  const environment = resolve(requestedExecutable, "../..");
  const lib = join(environment, "lib");
  if (!existsSync(join(environment, "pyvenv.cfg")) || !existsSync(lib)) return [];
  return readdirSync(lib)
    .filter((name) => /^python\d+(?:\.\d+)?$/u.test(name))
    .sort()
    .map((name) => join(lib, name, "site-packages"))
    .filter(existsSync);
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
