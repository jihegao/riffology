import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeSync,
} from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Duplex } from "node:stream";
import { ApiError, asApiError } from "./errors.ts";
import { canonicalJsonV2, parseCanonicalJsonV2 } from "./canonical-json-v2.ts";
import type { DurableProjectStore } from "./durable-project-store.ts";
import type { ProjectCommand } from "./durable-project-types.ts";
import type { Gate2Runtime } from "./gate2-runtime.ts";
import type { Gate3Runtime, Gate3ActivationCheckpoint } from "./gate3-runtime.ts";
import type { McpToolServer } from "./mcp.ts";
import type { MesaAdapter } from "./mesa-adapter.ts";
import type { OpenCodeAdapter, OpenCodeConversationPort, OpenCodeReadiness } from "./opencode-adapter.ts";
import type { OpenCodeEventBridge } from "./opencode-events.ts";
import { AgentWorkspaceService } from "./agent-workspace-service.ts";
import { AgentTurnRuntime } from "./agent-turn-runtime.ts";
import { MilestoneA2Api } from "./milestone-a2-api.ts";
import { DiagnosticEventCursorCodec } from "./diagnostic-event-cursor.ts";
import type { ModelTechnicalCheckerPort } from "./model-technical-check-service.ts";
import { ModelTechnicalChecker } from "./model-technical-checker.ts";
import {
  PreinstalledWindInstaller,
  type PreinstalledWindInstallerPort,
} from "./preinstalled-wind-installer.ts";
import {
  PreinstalledWindVisualInstaller,
  type PreinstalledWindVisualInstallerPort,
} from "./preinstalled-wind-visual-installer.ts";
import { ProductStoreV2, type HealthyVisualFrameTarget } from "./product-store-v2.ts";
import {
  authorityScopeForPermanentDelete,
  ProductAuthorityDeletionFence,
} from "./product-authority-deletion-fence.ts";
import { VisualAgentAuthority } from "./agent-visual-authority.ts";
import { VisualAgentObserver } from "./visual-agent-observer.ts";
import { VisualAgentInteractor } from "./visual-agent-interactor.ts";
import { GenericBatchSupervisor, type BatchOutputCandidate } from "./generic-batch-supervisor.ts";
import {
  GenericVisualSupervisor,
  type VisualOutputCandidate,
} from "./generic-visual-supervisor.ts";
import {
  ProductRunDispatcher,
  type BatchSupervisorPort,
  type VisualSupervisorPort,
} from "./product-run-dispatcher.ts";
import { SimulationSkillCatalog } from "./simulation-skill-catalog.ts";
import type { WorkbenchProjector } from "./playwright-projection.ts";
import type { ProjectStore, StoredAttachment } from "./project-store.ts";
import type { SimulationActions } from "./simulation-actions.ts";
import type { BrowserEvent, ProjectState, Scalar, UiCommand } from "./types.ts";
import {
  BrowserNetworkTopology,
  networkJson,
  rejectUpgrade,
  type BrowserNetworkAddress,
} from "./browser-network-topology.ts";
import {
  BrowserFrameCapability,
  BrowserFrameCapabilityError,
  BrowserFrameInspectionTimeoutError,
  type BrowserFrameConnectedPeer,
  type BrowserFrameTarget,
  type BrowserFrameTargetResolver,
  type BrowserRequestAdmission,
} from "./browser-frame-capability.ts";
import {
  BrowserWebSocketBridge,
  BrowserWebSocketBridgeError,
  type BrowserWebSocketPeerIdentity,
} from "./browser-websocket-bridge.ts";
import {
  inspectVisualConnectedPeerAsync,
  inspectVisualListenerAsync,
} from "./visual-listener-inspector.ts";
import {
  runLegacyStatePreflight,
  type LegacyPreflightReport,
} from "./legacy-state-preflight.ts";
import {
  LocalBrowserBroker,
  LocalBrowserBrokerError,
  RIFF_BROWSER_ALIASES,
  registerLocalBrowserTarget,
  type BrowserConversationScope,
  type BrowserTargetResolver,
  type RiffBrowserAlias,
} from "./local-browser-broker.ts";
import { BrowserAgentAuthority } from "./browser-agent-authority.ts";
import { ProjectOnlyHttpApi } from "./project-only-http-api.ts";
import type { ProjectOnlyServerRuntime } from "./project-only-server-factory.ts";

export const configuredBatchPythonExecutable = (explicit?: string): string => {
  const executable = explicit
    ?? process.env.RIFF_MODEL_PYTHON
    ?? resolve(import.meta.dirname, "../../mesa_service/.venv/bin/python");
  try {
    accessSync(executable, constants.X_OK);
  } catch (error) {
    throw new Error(
      `The configured batch Python is unavailable or not executable: ${executable}. Set RIFF_MODEL_PYTHON to the approved runtime.`,
      { cause: error },
    );
  }
  return executable;
};

const canonicalDirectory = (
  input: string,
  label: string,
  containedBy?: string,
): string => {
  const path = resolve(input);
  if (!existsSync(path)) throw new Error(`${label}_unavailable`);
  const info = lstatSync(path);
  const uid = process.getuid?.();
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(path) !== path
    || uid === undefined || info.uid !== uid || (info.mode & 0o022) !== 0) {
    throw new Error(`${label}_unsafe`);
  }
  if (containedBy) {
    const back = relative(containedBy, path);
    if (back === "" || back === ".." || back.startsWith(`..${sep}`) || isAbsolute(back)) {
      throw new Error(`${label}_outside_repository`);
    }
    let cursor = path;
    while (cursor !== containedBy) {
      const cursorInfo = lstatSync(cursor);
      if (!cursorInfo.isDirectory() || cursorInfo.isSymbolicLink()
        || realpathSync(cursor) !== cursor || cursorInfo.uid !== uid
        || (cursorInfo.mode & 0o022) !== 0) {
        throw new Error(`${label}_unsafe_chain`);
      }
      const parent = dirname(cursor);
      if (parent === cursor) throw new Error(`${label}_unsafe_chain`);
      cursor = parent;
    }
  }
  return path;
};

const loadOrCreateDiagnosticEventCursorSecret = (
  productRoot: string,
  allowCreate: boolean,
): Buffer => {
  const keyPath = join(productRoot, ".diagnostic-event-cursor.key");
  const readExisting = (): Buffer => {
    let descriptor: number | undefined;
    try {
      descriptor = openSync(keyPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = fstatSync(descriptor);
      const uid = process.getuid?.();
      if (!info.isFile() || info.nlink !== 1 || info.size !== 32
        || uid === undefined || info.uid !== uid || (info.mode & 0o077) !== 0) {
        throw new Error("unsafe key");
      }
      const bytes = readFileSync(descriptor);
      if (bytes.byteLength !== 32) throw new Error("invalid key length");
      return bytes;
    } catch (error) {
      throw new Error(
        "The diagnostic event cursor key is missing, corrupt, or insecure.",
        { cause: error },
      );
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  };
  try {
    return readExisting();
  } catch (error) {
    const code = error instanceof Error && error.cause
      && typeof error.cause === "object" && "code" in error.cause
      ? String(error.cause.code)
      : "";
    if (code !== "ENOENT" || !allowCreate) throw error;
  }
  const secret = randomBytes(32);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      keyPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    if (writeSync(descriptor, secret, 0, secret.byteLength, 0) !== secret.byteLength) {
      throw new Error("short key write");
    }
    fsyncSync(descriptor);
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.nlink !== 1 || info.size !== secret.byteLength
      || (info.mode & 0o077) !== 0) {
      throw new Error("unsafe key publication");
    }
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error
      ? String(error.code)
      : "";
    if (code === "EEXIST") return readExisting();
    throw new Error("The diagnostic event cursor key could not be created.", { cause: error });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  const rootDescriptor = openSync(productRoot, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(rootDescriptor);
  } finally {
    closeSync(rootDescriptor);
  }
  return Buffer.from(secret);
};

export type BackendOptions = {
  mesa?: MesaAdapter;
  openCode?: OpenCodeAdapter;
  workspaceRoot?: string;
  defaultSessionId?: string;
  projector?: WorkbenchProjector;
  promptTimeoutMs?: number;
  mcpUrl?: string;
  store?: ProjectStore;
  durableStore?: DurableProjectStore;
  gate3FaultInjector?: (checkpoint: Gate3ActivationCheckpoint) => void;
  a2ProductRoot?: string;
  productStore?: ProductStoreV2;
  projectOnlyRuntime?: Extract<ProjectOnlyServerRuntime, { mode: "ready" }>;
  a2OpenCode?: OpenCodeConversationPort;
  a2TechnicalChecker?: ModelTechnicalCheckerPort;
  a2SkillRoot?: string;
  a2AllowedSkills?: string[];
  a3BatchSupervisor?: BatchSupervisorPort;
  a3BatchOutputConsumer?: (candidate: BatchOutputCandidate) => Buffer;
  a3VisualSupervisor?: VisualSupervisorPort;
  a3VisualOutputConsumer?: (candidate: VisualOutputCandidate) => Buffer;
  a3VisualAuthority?: VisualAgentAuthority;
  a3VisualObserver?: VisualAgentObserver;
  a3VisualInteractor?: VisualAgentInteractor;
  a3PythonExecutable?: string;
  a3ScratchRoot?: string;
  a3DispatcherLeaseMs?: number;
  a3DiagnosticEventCursorSecret?: Uint8Array;
  a3InstallPreinstalledWind?: boolean;
  a3InstallPreinstalledWindVisual?: boolean;
  a3PreinstalledWindRepositoryRoot?: string;
  a3PreinstalledWindInstaller?: PreinstalledWindInstallerPort;
  a3PreinstalledWindVisualInstaller?: PreinstalledWindVisualInstallerPort;
  legacyCloseDrainTimeoutMs?: number;
  browserFrameTargetResolver?: BrowserFrameTargetResolver;
  productOnly?: boolean;
  recoveryOnlyOnFailure?: boolean;
  recoveryStatus?: Readonly<{
    state: "recovery_required";
    code: string;
    observedAt: string;
    retryable: boolean;
  }>;
  repositoryRoot?: string;
  staticWebRoot?: string;
  /** Explicit local rollback only; never inferred from a browser query. */
  staticLegacyProductRoutes?: boolean;
  workbenchBrowserBroker?: LocalBrowserBroker;
  workbenchBrowserTargetResolver?: BrowserTargetResolver;
  workbenchBrowserTtlMs?: number;
};

type WorkbenchObservationTarget = Readonly<{
  scope: BrowserConversationScope;
  owner: WorkbenchObservationOwner;
  expiresAtMs: number;
}>;

export type WorkbenchObservationOwner = Readonly<{
  kind: "model" | "project";
  id: string;
}>;

/** Process-local registry for the unguessable, expiring read-only observation route. */
export class WorkbenchObservationTargetRegistry {
  readonly #targets = new Map<string, WorkbenchObservationTarget>();
  readonly #ttlMs: number;
  readonly #now: () => number;

  constructor(ttlMs = 15 * 60_000, now: () => number = Date.now) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 60 * 60_000) {
      throw new Error("Workbench observation TTL is invalid.");
    }
    this.#ttlMs = ttlMs;
    this.#now = now;
  }

  register(scope: BrowserConversationScope, owner: WorkbenchObservationOwner): string {
    this.revokeConversation(scope.conversationId);
    let token: string;
    do token = randomBytes(32).toString("base64url"); while (this.#targets.has(token));
    this.#targets.set(token, Object.freeze({
      scope: Object.freeze({ ...scope }),
      owner: Object.freeze({ ...owner }),
      expiresAtMs: this.#now() + this.#ttlMs,
    }));
    return token;
  }

  resolve(token: string): WorkbenchObservationTarget | null {
    const target = this.#targets.get(token);
    if (!target || target.expiresAtMs <= this.#now()) {
      if (target) this.#targets.delete(token);
      return null;
    }
    return target;
  }

  revoke(scope: BrowserConversationScope): void {
    for (const [token, target] of this.#targets) {
      if (target.scope.conversationId === scope.conversationId
        && target.scope.conversationGeneration === scope.conversationGeneration) {
        this.#targets.delete(token);
      }
    }
  }

  revokeConversation(conversationId: string): void {
    for (const [token, target] of this.#targets) {
      if (target.scope.conversationId === conversationId) this.#targets.delete(token);
    }
  }

  clear(): void { this.#targets.clear(); }
}

export const workbenchObservationTargetMatches = (
  target: Readonly<{ scope: BrowserConversationScope; owner: WorkbenchObservationOwner }>,
  generation: number | null,
  owner: WorkbenchObservationOwner,
): boolean => generation === target.scope.conversationGeneration
  && owner.kind === target.owner.kind && owner.id === target.owner.id;

export type BrowserFrameListenerInspector = (
  target: HealthyVisualFrameTarget,
) => Promise<boolean>;

export type BrowserFrameConnectedPeerInspector = (
  target: HealthyVisualFrameTarget,
  peer: BrowserFrameConnectedPeer,
) => Promise<boolean>;

export const createProductBrowserFrameTargetResolver = (
  store: Pick<ProductStoreV2, "currentHealthyVisualFrameTarget">,
  inspect: BrowserFrameListenerInspector = async (target) => {
    try {
      await inspectVisualListenerAsync({
        runId: target.runId,
        processAttemptId: target.processAttemptId,
        pid: target.pid,
        processStartToken: target.processStartToken,
        processGroupId: target.processGroupId,
        assignedPort: target.loopbackPort,
      });
      return true;
    } catch {
      return false;
    }
  },
  inspectionDeadlineMs = 5_000,
  inspectConnectedPeer: BrowserFrameConnectedPeerInspector = async (target, peer) => {
    if (peer.localHost !== "127.0.0.1"
      || peer.remoteHost !== "127.0.0.1"
      || peer.remotePort !== target.loopbackPort) return false;
    try {
      await inspectVisualConnectedPeerAsync({
        runId: target.runId,
        processAttemptId: target.processAttemptId,
        pid: target.pid,
        processStartToken: target.processStartToken,
        processGroupId: target.processGroupId,
        assignedPort: target.loopbackPort,
        brokerLocalPort: peer.localPort,
      });
      return true;
    } catch {
      return false;
    }
  },
  resolutionDeadlineMs = 2_000,
): BrowserFrameTargetResolver => {
  if (!Number.isSafeInteger(inspectionDeadlineMs)
    || inspectionDeadlineMs < 1 || inspectionDeadlineMs > 5_000) {
    throw new Error("Browser frame inspection deadline must be between 1 and 5000 milliseconds.");
  }
  if (!Number.isSafeInteger(resolutionDeadlineMs)
    || resolutionDeadlineMs < 0 || resolutionDeadlineMs > 5_000) {
    throw new Error("Browser frame resolution deadline must be between 0 and 5000 milliseconds.");
  }
  const current = (projectId: string, runId: string): HealthyVisualFrameTarget | null => {
    try {
      return store.currentHealthyVisualFrameTarget(projectId, runId);
    } catch {
      return null;
    }
  };
  let inspectionQueue: Promise<void> = Promise.resolve();
  let pendingInspections = 0;
  const scheduleInspection = async (
    expected: BrowserFrameTarget,
    operation: (target: HealthyVisualFrameTarget) => Promise<boolean>,
  ): Promise<boolean> => {
    if (pendingInspections >= 16) return false;
    pendingInspections += 1;
    const prior = inspectionQueue;
    let cancelled = false;
    const task = prior.then(async (): Promise<boolean> => {
      if (cancelled) return false;
      const target = current(expected.projectId, expected.runId);
      if (!target || !matchesBrowserFrameTarget(target, expected)) return false;
      if (!await operation(target) || cancelled) return false;
      const after = current(expected.projectId, expected.runId);
      return Boolean(after
        && matchesBrowserFrameTarget(after, expected)
        && sameHealthyVisualFrameTarget(after, target));
    });
    inspectionQueue = task.then(() => undefined, () => undefined);
    void task.then(
      () => { pendingInspections -= 1; },
      () => { pendingInspections -= 1; },
    );
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        task.catch(() => false),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            cancelled = true;
            reject(new BrowserFrameInspectionTimeoutError());
          }, inspectionDeadlineMs);
        }),
      ]);
    } catch (error) {
      if (error instanceof BrowserFrameInspectionTimeoutError) throw error;
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  return Object.freeze({
    resolve: async (projectId: string, runId: string): Promise<BrowserFrameTarget | null> => {
      const deadline = Date.now() + resolutionDeadlineMs;
      let target = current(projectId, runId);
      while (!target && Date.now() < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        target = current(projectId, runId);
      }
      if (!target) return null;
      return Object.freeze({
        projectId: target.projectId,
        runId: target.runId,
        attemptGeneration: target.attemptGeneration,
        port: target.loopbackPort,
        expiresAtMs: Date.parse(target.attemptExpiresAt),
        ...(target.webSocket ? { webSocket: target.webSocket } : {}),
      });
    },
    inspect: async (expected: BrowserFrameTarget): Promise<boolean> =>
      scheduleInspection(expected, inspect),
    inspectConnectedPeer: async (
      expected: BrowserFrameTarget,
      peer: BrowserFrameConnectedPeer,
    ): Promise<boolean> => scheduleInspection(
      expected,
      (target) => inspectConnectedPeer(target, peer),
    ),
  });
};

const matchesBrowserFrameTarget = (
  target: HealthyVisualFrameTarget,
  expected: BrowserFrameTarget,
): boolean => target.projectId === expected.projectId
  && target.runId === expected.runId
  && target.attemptGeneration === expected.attemptGeneration
  && target.loopbackPort === expected.port
  && Date.parse(target.attemptExpiresAt) === expected.expiresAtMs
  && sameBrowserWebSocketPolicy(target.webSocket, expected.webSocket);

const sameHealthyVisualFrameTarget = (
  left: HealthyVisualFrameTarget,
  right: HealthyVisualFrameTarget,
): boolean => left.projectId === right.projectId
  && left.runId === right.runId
  && left.attemptId === right.attemptId
  && left.attemptGeneration === right.attemptGeneration
  && left.dispatcherGeneration === right.dispatcherGeneration
  && left.attemptExpiresAt === right.attemptExpiresAt
  && left.processAttemptId === right.processAttemptId
  && left.pid === right.pid
  && left.processStartToken === right.processStartToken
  && left.processGroupId === right.processGroupId
  && left.loopbackHost === right.loopbackHost
  && left.loopbackPort === right.loopbackPort
  && left.healthPath === right.healthPath
  && left.healthyAt === right.healthyAt
  && sameBrowserWebSocketPolicy(left.webSocket, right.webSocket);

const sameBrowserWebSocketPolicy = (
  left: HealthyVisualFrameTarget["webSocket"] | BrowserFrameTarget["webSocket"],
  right: HealthyVisualFrameTarget["webSocket"] | BrowserFrameTarget["webSocket"],
): boolean => left === undefined && right === undefined
  || Boolean(left && right
    && left.path === right.path
    && left.maxFrameBytes === right.maxFrameBytes
    && left.maxConnections === right.maxConnections
    && left.idleTimeoutMs === right.idleTimeoutMs
    && left.subprotocols.length === right.subprotocols.length
    && left.subprotocols.every((value, index) => value === right.subprotocols[index]));

export class BackendApp {
  store?: ProjectStore;
  actions?: SimulationActions;
  mcp?: McpToolServer;
  gate2?: Gate2Runtime;
  gate3?: Gate3Runtime;
  readonly productStore?: ProductStoreV2;
  readonly projectOnlyApi?: ProjectOnlyHttpApi;
  readonly productRunDispatcher?: ProductRunDispatcher;
  readonly a2?: MilestoneA2Api;
  readonly #agentTurnRuntime?: AgentTurnRuntime;
  readonly #authorityDeletionFence = new ProductAuthorityDeletionFence();
  readonly #preinstalledWindInstaller?: PreinstalledWindInstallerPort;
  readonly #preinstalledWindVisualInstaller?: PreinstalledWindVisualInstallerPort;
  readonly #a2OpenCode?: OpenCodeConversationPort;
  readonly #productMode: boolean;
  readonly #repositoryRoot?: string;
  readonly #staticWebRoot?: string;
  #legacyPreflight?: LegacyPreflightReport;
  #recoveryStatus?: BackendOptions["recoveryStatus"];
  private readonly options: BackendOptions;
  #openCodeEvents?: OpenCodeEventBridge;
  readonly #mcpCapabilities = new Map<string, string>();
  #unsubscribeOpenCode?: () => void;
  #readiness: OpenCodeReadiness = { status: "unconfigured", modelId: null };
  #server?: Server;
  #browserNetwork?: BrowserNetworkTopology;
  #browserFrames?: BrowserFrameCapability;
  #browserWebSockets?: BrowserWebSocketBridge;
  #browserBrokerOrigin?: string;
  #workbenchBrowserBroker?: LocalBrowserBroker;
  #browserAgentAuthority?: BrowserAgentAuthority;
  readonly #workbenchObservationTargets: WorkbenchObservationTargetRegistry;
  #listenerQueue: Promise<void> = Promise.resolve();
  #listenerMode: "idle" | "legacy" | "browser" | "closed" = "idle";
  readonly #legacyCloseDrainTimeoutMs: number;

  constructor(options: BackendOptions) {
    this.options = options;
    this.#workbenchObservationTargets = new WorkbenchObservationTargetRegistry(
      options.workbenchBrowserTtlMs,
    );
    this.#productMode = Boolean(
      options.productOnly || options.productStore || options.a2ProductRoot || options.projectOnlyRuntime,
    );
    this.#repositoryRoot = options.repositoryRoot
      ? canonicalDirectory(options.repositoryRoot, "repository_root")
      : undefined;
    this.#staticWebRoot = options.staticWebRoot
      ? canonicalDirectory(
        options.staticWebRoot,
        "static_web_root",
        this.#repositoryRoot,
      )
      : undefined;
    this.#recoveryStatus = options.recoveryStatus;
    this.#legacyCloseDrainTimeoutMs = exactLegacyCloseDrainTimeout(options.legacyCloseDrainTimeoutMs ?? 5_000);
    if (options.projectOnlyRuntime) {
      this.projectOnlyApi = new ProjectOnlyHttpApi(
        options.projectOnlyRuntime.store,
        options.projectOnlyRuntime.projectOperations,
      );
    }
    if (!this.#productMode) {
      if (!options.workspaceRoot || !options.mesa || !options.openCode) {
        throw new Error("The retired legacy test runtime requires explicit dependencies.");
      }
    }
    if (options.productStore || options.a2ProductRoot) {
      const a2OpenCode = options.a2OpenCode
        ?? (options.openCode ? asConversationOpenCode(options.openCode) : undefined);
      if (!a2OpenCode) {
        throw new Error("Product startup requires an OpenCode conversation adapter.");
      }
      this.#a2OpenCode = a2OpenCode;
      this.productStore = options.productStore ?? ProductStoreV2.open(options.a2ProductRoot!);
      let diagnosticEventCursorCodec: DiagnosticEventCursorCodec;
      try {
        diagnosticEventCursorCodec = new DiagnosticEventCursorCodec({
          secret: options.a3DiagnosticEventCursorSecret
            ?? loadOrCreateDiagnosticEventCursorSecret(
              this.productStore.root,
              !this.productStore.hasDiagnosticEventSets(),
            ),
          keyEpoch: 1,
        });
      } catch (error) {
        this.productStore.close();
        throw error;
      }
      const scratchRoot = options.a3ScratchRoot
        ?? join(options.workspaceRoot ?? this.productStore.root, ".riff-batch-scratch");
      mkdirSync(scratchRoot, { recursive: true, mode: 0o700 });
      let approvedPythonExecutable: string | undefined;
      const pythonExecutable = (): string =>
        approvedPythonExecutable ??= configuredBatchPythonExecutable(options.a3PythonExecutable);
      if (options.a3PreinstalledWindInstaller) {
        this.#preinstalledWindInstaller = options.a3PreinstalledWindInstaller;
      } else if (options.a3InstallPreinstalledWind) {
        this.#preinstalledWindInstaller = new PreinstalledWindInstaller({
          store: this.productStore,
          repositoryRoot: options.a3PreinstalledWindRepositoryRoot
            ?? resolve(import.meta.dirname, "../.."),
          technicalChecker: options.a2TechnicalChecker
            ?? new ModelTechnicalChecker({
              pythonExecutable: pythonExecutable(),
          }),
        });
      }
      if (options.a3PreinstalledWindVisualInstaller) {
        this.#preinstalledWindVisualInstaller =
          options.a3PreinstalledWindVisualInstaller;
      } else if (options.a3InstallPreinstalledWindVisual) {
        this.#preinstalledWindVisualInstaller =
          new PreinstalledWindVisualInstaller({
            store: this.productStore,
            repositoryRoot: options.a3PreinstalledWindRepositoryRoot
              ?? resolve(import.meta.dirname, "../.."),
            technicalChecker: options.a2TechnicalChecker
              ?? new ModelTechnicalChecker({
                pythonExecutable: pythonExecutable(),
              }),
          });
      }
      const batchSupervisor = options.a3BatchSupervisor ?? new GenericBatchSupervisor({
        pythonExecutable: pythonExecutable(),
        scratchRoot,
      });
      const visualSupervisor = options.a3VisualSupervisor ?? new GenericVisualSupervisor({
        pythonExecutable: pythonExecutable(),
        scratchRoot,
      });
      const visualAuthority = options.a3VisualAuthority
        ?? new VisualAgentAuthority(this.productStore, {
          observer: options.a3VisualObserver ?? new VisualAgentObserver(),
          interactor: options.a3VisualInteractor ?? new VisualAgentInteractor(),
          authorityIssuanceAllowed: (scope) =>
            this.#authorityDeletionFence.issuanceAllowed(scope),
        });
      this.productRunDispatcher = new ProductRunDispatcher({
        store: this.productStore,
        supervisor: batchSupervisor,
        visualSupervisor,
        ...(options.a3DispatcherLeaseMs ? { leaseMs: options.a3DispatcherLeaseMs } : {}),
        ...(options.a3BatchOutputConsumer ? { consumeOutput: options.a3BatchOutputConsumer } : {}),
        ...(options.a3VisualOutputConsumer
          ? { consumeVisualOutput: options.a3VisualOutputConsumer }
          : {}),
        revokeVisualAccess: (runId) => {
          this.#browserFrames?.revokeRun(runId);
          visualAuthority.revokeRun(runId);
        },
      });
      const skills = new SimulationSkillCatalog(options.a2SkillRoot ?? process.cwd(), options.a2AllowedSkills ?? []);
      const turnRuntime = new AgentTurnRuntime(this.productStore, skills, {
        visualAuthority,
        authorityIssuanceAllowed: (scope) =>
          this.#authorityDeletionFence.issuanceAllowed(scope),
      });
      this.#agentTurnRuntime = turnRuntime;
      const resourceDeleteRuntimeBlockers = (
        preview: import("./product-domain.ts").PermanentDeletePreview,
      ): Array<{ kind: string; id: string }> => {
        const conversationIds = new Set(preview.records
          .filter((record) => record.table === "conversations")
          .map((record) => String(record.key.id)));
        const projectIds = new Set(preview.records
          .filter((record) => record.table === "projects")
          .map((record) => String(record.key.id)));
        const runIds = new Set(preview.records
          .filter((record) => record.table === "runs")
          .map((record) => String(record.key.id)));
        const blockers: Array<{ kind: string; id: string }> = [];
        if (this.#browserFrames?.hasActiveScope({ projectIds, runIds })) {
          blockers.push({
            kind: "browser_authority_active",
            id: preview.target.id,
          });
        }
        if (turnRuntime.hasActiveAuthority({
          conversationIds,
          projectIds,
          runIds,
        })) {
          blockers.push({
            kind: "tool_authority_active",
            id: preview.target.id,
          });
        }
        return blockers;
      };
      this.a2 = new MilestoneA2Api(
        new AgentWorkspaceService(
          this.productStore,
          a2OpenCode,
          undefined,
          options.a2TechnicalChecker,
          turnRuntime,
          (capability) => this.#a2McpUrl(capability),
          (runId, cancellationRequested) => {
            if (cancellationRequested) this.productRunDispatcher?.requestCancellation(runId);
            else this.productRunDispatcher?.notify();
          },
          true,
        ),
        {
          authorizeProductRead: (request) => {
            const frames = this.#browserFrames;
            const address = this.#browserNetwork?.app;
            if (this.#listenerMode !== "browser" || !frames || !address) {
              throw new BrowserFrameCapabilityError(403, "browser_session_denied");
            }
            return frames.authorizeAppRead(browserAdmission(request, address));
          },
          authorizeProductMutation: (request) => {
            if (this.#listenerMode !== "browser") {
              throw new BrowserFrameCapabilityError(403, "browser_session_denied");
            }
            const frames = this.#browserFrames;
            const address = this.#browserNetwork?.app;
            if (!frames || !address) {
              throw new BrowserFrameCapabilityError(403, "browser_session_denied");
            }
            return frames.authorizeAppMutation(browserAdmission(request, address));
          },
          requireBrowserAdmission: true,
          resourceDeleteRuntimeBlockers,
          commitResourcePermanentDelete: (preview, commit) =>
            this.#authorityDeletionFence.withFence(
              authorityScopeForPermanentDelete(preview),
              () => {
                if (resourceDeleteRuntimeBlockers(preview).length > 0) {
                  throw new ApiError(
                    409,
                    "permanent_delete_active_authority",
                    "The resource still has active browser or execution authority.",
                  );
                }
                return commit();
              },
            ),
          revokeRunAccess: (runId) => {
            this.#browserFrames?.revokeRun(runId);
            visualAuthority.revokeRun(runId);
          },
          diagnosticEventCursorCodec,
        },
      );
    }
  }

  async initialize(): Promise<ProjectState | undefined> {
    if (this.#productMode) {
      if (this.#recoveryStatus) return undefined;
      if (this.#a2OpenCode?.initialize) {
        try {
          await this.#a2OpenCode.initialize();
        } catch {
          // OpenCode readiness is Agent-only. Product recovery, Home, and
          // direct lifecycle controls remain available in read-only Agent mode.
        }
      }
      try {
        await this.productRunDispatcher?.recoverBeforeStart();
        await this.#preinstalledWindInstaller?.install();
        await this.#preinstalledWindVisualInstaller?.install();
        if (this.#repositoryRoot) {
          this.#legacyPreflight = runLegacyStatePreflight(this.#repositoryRoot);
        }
        await this.productRunDispatcher?.start();
      } catch (error) {
        if (!this.options.recoveryOnlyOnFailure) throw error;
        const failureClass = error instanceof Error ? error.name : "UnknownError";
        console.error(`Riff Product recovery entered recovery-only mode (${failureClass}).`);
        this.#recoveryStatus = Object.freeze({
          state: "recovery_required",
          code: "product_recovery_failed",
          observedAt: new Date().toISOString(),
          retryable: false,
        });
      }
      return undefined;
    }
    const { createLegacyBackendRuntime } = await import("./legacy-backend-runtime.ts");
    const legacy = createLegacyBackendRuntime(this.options);
    this.store = legacy.store;
    this.gate2 = legacy.gate2;
    this.gate3 = legacy.gate3;
    this.actions = legacy.actions;
    this.mcp = legacy.mcp;
    this.#openCodeEvents = legacy.openCodeEvents;
    await this.gate3!.recover();
    this.gate2!.start();
    this.#readiness = await this.options.openCode!.initialize();
    if (this.#readiness.status === "ready" && this.options.openCode!.subscribeEvents) {
      try {
        this.#unsubscribeOpenCode = await this.options.openCode!.subscribeEvents(
          (event) => this.#openCodeEvents!.handle(event),
        );
      } catch {
        this.#readiness = { status: "error", modelId: null, lastError: { code: "opencode_event_unavailable", message: "OpenCode event streaming is unavailable." } };
      }
    }
    return this.createSession(this.options.defaultSessionId ?? "local-demo");
  }

  createSession(sessionId = randomUUID()): ProjectState {
    if (!this.store || !this.mcp) {
      throw new ApiError(404, "legacy_runtime_retired", "The legacy runtime is retired.");
    }
    const snapshot = this.store.create(sessionId, publicAgent(this.#readiness));
    if (!this.#mcpCapabilities.has(sessionId)) this.#mcpCapabilities.set(sessionId, this.mcp.grant(sessionId));
    return snapshot;
  }

  /** Ends a browser session's local control authority without exposing its capability. */
  closeSession(sessionId: string): void {
    const capability = this.#mcpCapabilities.get(sessionId);
    if (capability) this.mcp?.revoke(capability);
    this.mcp?.revokeSession(sessionId);
    this.#mcpCapabilities.delete(sessionId);
    this.#openCodeEvents?.unbindBrowserSession(sessionId);
  }

  async listen(port = 0, host = "127.0.0.1"): Promise<{ port: number; host: string }> {
    return this.#withListenerLock(async () => {
      if (this.#listenerMode !== "idle") throw new Error("A backend listener is already active or closed.");
      const server = createServer((request, response) => void this.#handle(request, response));
      this.#server = server;
      try {
        await new Promise<void>((resolve, reject) => {
          const onError = (error: Error): void => {
            server.off("listening", onListening);
            reject(error);
          };
          const onListening = (): void => {
            server.off("error", onError);
            resolve();
          };
          server.once("error", onError);
          server.once("listening", onListening);
          server.listen(port, host);
        });
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Backend did not expose a TCP address.");
        this.#listenerMode = "legacy";
        return { port: address.port, host };
      } catch (error) {
        this.#server = undefined;
        if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
        throw error;
      }
    });
  }

  async listenBrowserNetwork(
    appPort = 0,
    brokerPort = 0,
  ): Promise<{ app: BrowserNetworkAddress; broker: BrowserNetworkAddress }> {
    return this.#withListenerLock(async () => {
      if (this.#listenerMode === "browser" && this.#browserNetwork) {
        return { app: this.#browserNetwork.app, broker: this.#browserNetwork.broker };
      }
      if (this.#listenerMode !== "idle") throw new Error("A backend listener is already active or closed.");
      let network: BrowserNetworkTopology;
      try {
        network = await BrowserNetworkTopology.start({
          appPort,
          brokerPort,
          beforeReady: ({ app, broker }) => {
            this.#browserBrokerOrigin = broker.origin;
            this.#browserFrames = new BrowserFrameCapability({
              appOrigin: app.origin,
              brokerOrigin: broker.origin,
              targets: this.options.browserFrameTargetResolver ?? this.#productBrowserFrameTargets(),
              authorityIssuanceAllowed: (scope) =>
                this.#authorityDeletionFence.issuanceAllowed(scope),
            });
            this.#browserWebSockets = new BrowserWebSocketBridge();
            this.#workbenchBrowserBroker = this.options.workbenchBrowserBroker
              ?? new LocalBrowserBroker({
                ttlMs: this.options.workbenchBrowserTtlMs,
                resolveTarget: async (alias, scope) => {
                  const configured = await this.options.workbenchBrowserTargetResolver?.(alias, scope);
                  if (configured) return configured;
                  if (alias !== "riff-app" || !this.productStore) return null;
                  const conversation = this.productStore.getConversation(scope.conversationId);
                  const runtime = await this.productStore.getConversationRuntime(scope.conversationId);
                  if (!runtime?.session || runtime.session.generation !== scope.conversationGeneration
                    || !this.#workbenchOwnerExists(conversation.owner)) return null;
                  const token = this.#workbenchObservationTargets.register(
                    scope,
                    conversation.owner,
                  );
                  const collection = conversation.owner.kind === "model" ? "models" : "projects";
                  return registerLocalBrowserTarget({
                    alias,
                    url: `${app.origin}/browser/observe/${token}`,
                    projectedUrl: `riff-app://${collection}/${encodeURIComponent(conversation.owner.id)}`
                      + `?conversation=${encodeURIComponent(scope.conversationId)}`,
                  });
                },
              });
            this.#browserAgentAuthority = new BrowserAgentAuthority(
              this.#workbenchBrowserBroker,
            );
            this.#agentTurnRuntime?.configureBrowserAuthority(this.#browserAgentAuthority);
          },
          appHandler: async (request, response, address) => {
            if (await this.#handleBrowserFramePlatform(request, response, address)) return;
            if (this.#handleStaticProductShell(request, response, address)) return;
            await this.#handle(request, response);
          },
          brokerHandler: (request, response, address) =>
            this.#handleBrowserFrameBroker(request, response, address),
          brokerUpgradeHandler: (request, socket, head, address) =>
            this.#handleBrowserFrameWebSocket(request, socket, head, address),
        });
      } catch (error) {
        this.#browserFrames?.clear();
        this.#browserFrames = undefined;
        this.#browserWebSockets = undefined;
        this.#browserBrokerOrigin = undefined;
        await this.#workbenchBrowserBroker?.shutdown().catch(() => undefined);
        this.#workbenchBrowserBroker = undefined;
        this.#browserAgentAuthority = undefined;
        this.#workbenchObservationTargets.clear();
        throw error;
      }
      this.#browserNetwork = network;
      this.#listenerMode = "browser";
      return { app: network.app, broker: network.broker };
    });
  }

  async close(): Promise<void> {
    // Revoke every process-local authority synchronously before any fallible
    // asynchronous drain can yield or reject.
    await this.#agentTurnRuntime?.revokeAll();
    for (const sessionId of this.#mcpCapabilities.keys()) this.closeSession(sessionId);
    this.mcp?.revokeAll();
    this.#unsubscribeOpenCode?.();
    this.#unsubscribeOpenCode = undefined;

    let firstError: unknown;
    const attempt = async (action: () => Promise<void> | void): Promise<void> => {
      try {
        await action();
      } catch (error) {
        firstError ??= error;
      }
    };
    await attempt(() => this.#withListenerLock(async () => {
      if (this.#listenerMode === "closed") return;
      this.#listenerMode = "closed";
      let listenerError: unknown;
      if (this.#server) {
        try {
          await closeServerWithDrain(this.#server, this.#legacyCloseDrainTimeoutMs);
        } catch (error) {
          listenerError ??= error;
        } finally {
          this.#server = undefined;
        }
      }
      if (this.#browserNetwork) {
        this.#browserFrames?.clear();
        this.#browserFrames = undefined;
        this.#browserWebSockets = undefined;
        this.#browserBrokerOrigin = undefined;
        try {
          await this.#workbenchBrowserBroker?.shutdown();
        } catch (error) {
          listenerError ??= error;
        } finally {
          this.#workbenchBrowserBroker = undefined;
          this.#browserAgentAuthority = undefined;
          this.#workbenchObservationTargets.clear();
        }
        try {
          await this.#browserNetwork.close();
        } catch (error) {
          listenerError ??= error;
        } finally {
          this.#browserNetwork = undefined;
        }
      }
      if (listenerError) throw listenerError;
    }));
    await attempt(() => this.gate2?.close());
    await attempt(() => this.productRunDispatcher?.stop());
    await attempt(() => this.projectOnlyApi?.store.close());
    await attempt(() => this.productStore?.close());
    if (firstError) throw firstError;
  }

  async #withListenerLock<T>(action: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const prior = this.#listenerQueue;
    this.#listenerQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      return await action();
    } finally {
      release();
    }
  }

  #productBrowserFrameTargets(): BrowserFrameTargetResolver {
    const store = this.productStore;
    if (!store) {
      return Object.freeze({
        resolve: async () => null,
        inspect: async () => false,
      });
    }
    return createProductBrowserFrameTargetResolver(store);
  }

  #handleStaticProductShell(
    request: IncomingMessage,
    response: ServerResponse,
    address: BrowserNetworkAddress,
  ): boolean {
    if (!this.#staticWebRoot
      || (request.method !== "GET" && request.method !== "HEAD")) return false;
    const url = new URL(request.url ?? "/", address.origin);
    if (url.search.length > 1024 || url.pathname.startsWith("/api/")
      || url.pathname.startsWith("/browser/")) return false;
    let relativePath = "index.html";
    if (url.pathname.startsWith("/assets/")) {
      if (url.search !== "") return false;
      const name = url.pathname.slice("/assets/".length);
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(name)) return false;
      relativePath = `assets/${name}`;
    } else if (url.pathname !== "/"
      && !(this.options.staticLegacyProductRoutes
        ? /^\/(?:workbench(?:\/(?:new(?:\/[A-Za-z0-9_-]{1,80})?|(?:models|projects)\/[A-Za-z0-9_-]{1,160}))?|(?:models|projects)\/[A-Za-z0-9_-]{1,160})\/?$/u
        : /^\/workbench(?:\/(?:new(?:\/[A-Za-z0-9_-]{1,80})?|projects\/[A-Za-z0-9_-]{1,160}))?\/?$/u
      ).test(url.pathname)) {
      return false;
    }
    const path = join(this.#staticWebRoot, relativePath);
    let descriptor: number | undefined;
    try {
      if (realpathSync(dirname(path)) !== dirname(path)) {
        throw new Error("unsafe static asset parent");
      }
      descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = fstatSync(descriptor);
      const uid = process.getuid?.();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 8 * 1024 * 1024
        || uid === undefined || stat.uid !== uid) {
        throw new Error("unsafe static asset");
      }
      const bytes = readFileSync(descriptor);
      const after = fstatSync(descriptor);
      if (stat.dev !== after.dev || stat.ino !== after.ino || after.size !== bytes.byteLength) {
        throw new Error("static asset changed while reading");
      }
      let responseBytes = bytes;
      if (relativePath === "index.html") {
        const marker = '<meta name="riffology-server-legacy-product-ui" content="false" />';
        const html = bytes.toString("utf8");
        if (!html.includes(marker)) throw new Error("static rollback marker missing");
        responseBytes = Buffer.from(this.options.staticLegacyProductRoutes
          ? html.replace(marker,
            '<meta name="riffology-server-legacy-product-ui" content="true" />')
          : html, "utf8");
      }
      const contentType = relativePath.endsWith(".html")
        ? "text/html; charset=utf-8"
        : relativePath.endsWith(".js")
          ? "text/javascript; charset=utf-8"
          : relativePath.endsWith(".css")
            ? "text/css; charset=utf-8"
            : "application/octet-stream";
      const brokerOrigin = this.#browserBrokerOrigin;
      const csp = relativePath === "index.html"
        ? [
          "default-src 'none'",
          "script-src 'self'",
          "style-src 'self'",
          "img-src 'self' data:",
          "font-src 'self'",
          "connect-src 'self'",
          `frame-src ${brokerOrigin ?? "'none'"}`,
          "object-src 'none'",
          "base-uri 'none'",
          "form-action 'none'",
          "frame-ancestors 'none'",
        ].join("; ")
        : "default-src 'none'; sandbox";
      response.writeHead(200, {
        "cache-control": relativePath === "index.html"
          ? "no-store"
          : "public, max-age=31536000, immutable",
        "content-security-policy": csp,
        "content-length": responseBytes.byteLength,
        "content-type": contentType,
        "cross-origin-resource-policy": "same-origin",
        "permissions-policy": "camera=(), microphone=(), geolocation=()",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      });
      if (request.method === "GET") response.end(responseBytes);
      else response.end();
      return true;
    } catch {
      return false;
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }

  async #handleBrowserFramePlatform(
    request: IncomingMessage,
    response: ServerResponse,
    address: BrowserNetworkAddress,
  ): Promise<boolean> {
    const url = new URL(request.url ?? "/", address.origin);
      const hostPage = /^\/browser\/projects\/([^/]+)\/runs\/([^/]+)\/visual$/u.exec(url.pathname);
      const observationPage = /^\/browser\/observe\/([A-Za-z0-9_-]{43})$/u.exec(url.pathname);
      const bootstrap = url.pathname === "/api/browser-session/bootstrap";
      const match = /^\/api\/projects\/([^/]+)\/runs\/([^/]+)\/visual-frame-session$/u.exec(url.pathname);
      if (!hostPage && !observationPage && !bootstrap && !match) return false;
      if (this.#recoveryStatus && !bootstrap) {
        privateApiJson(response, 503, {
          accepted: false,
          error: {
            code: "recovery_required",
            message: "Riff requires recovery before this operation is available.",
          },
        });
        return true;
      }
    try {
      if (observationPage) {
        if (url.search !== "" || request.method !== "GET" && request.method !== "HEAD") {
          throw new BrowserFrameCapabilityError(404, "browser_session_denied");
        }
        const declared = this.#workbenchObservationTargets.resolve(observationPage[1]!);
        if (!declared || !this.productStore) {
          throw new BrowserFrameCapabilityError(404, "browser_session_denied");
        }
        const runtime = await this.productStore.getConversationRuntime(
          declared.scope.conversationId,
        );
        const conversation = this.productStore.getConversation(declared.scope.conversationId);
        if (!workbenchObservationTargetMatches(
          declared,
          runtime.session?.generation ?? null,
          conversation.owner,
        ) || !this.#workbenchOwnerExists(conversation.owner)) {
          this.#workbenchObservationTargets.revoke(declared.scope);
          throw new BrowserFrameCapabilityError(409, "browser_conversation_stale");
        }
        browserWorkbenchObservationPage(response, request.method, {
          owner: declared.owner,
          conversationId: declared.scope.conversationId,
          conversationGeneration: declared.scope.conversationGeneration,
        });
        return true;
      }
      if (hostPage) {
        if (url.search !== "") throw new BrowserFrameCapabilityError(404, "browser_session_denied");
        decodeBrowserPathId(hostPage[1]!);
        decodeBrowserPathId(hostPage[2]!);
        if (request.method !== "GET" && request.method !== "HEAD") {
          throw new BrowserFrameCapabilityError(405, "browser_method_denied");
        }
        if (request.method === "GET") {
          const fetchSite = rawBrowserHeader(request, "sec-fetch-site");
          if ((fetchSite !== "none" && fetchSite !== "same-origin")
            || rawBrowserHeader(request, "sec-fetch-mode") !== "navigate"
            || rawBrowserHeader(request, "sec-fetch-dest") !== "document") {
            throw new BrowserFrameCapabilityError(403, "browser_session_denied");
          }
        }
        const brokerOrigin = this.#browserBrokerOrigin;
        if (!brokerOrigin) throw new BrowserFrameCapabilityError(503, "browser_session_denied");
        browserVisualHostPage(response, request.method, brokerOrigin);
        return true;
      }
      if (request.method === "OPTIONS") {
        this.#browserFramePreflight(request, response, address);
        return true;
      }
      if (bootstrap && request.method !== "POST") {
        throw new BrowserFrameCapabilityError(405, "browser_method_denied");
      }
      if (bootstrap) {
        await exactEmptyJsonObject(request);
      } else {
        exactEmptyBrowserBody(request, "browser_session_denied");
      }
      if (url.search !== "") throw new BrowserFrameCapabilityError(403, "browser_session_denied");
      const frames = this.#browserFrames;
      if (!frames) throw new BrowserFrameCapabilityError(503, "browser_session_denied");
      const admission = browserAdmission(request, address);
      const cors = browserCorsHeaders(address.origin);
      if (bootstrap) {
        const result = frames.bootstrap(admission);
        await this.#agentTurnRuntime?.revokeAll();
        networkJsonWithHeaders(response, 201, {
          schemaVersion: 1,
          generation: result.generation,
          csrfToken: result.csrfToken,
          platformOrigin: address.origin,
          brokerOrigin: this.#browserBrokerOrigin,
          expiresAt: new Date(result.expiresAtMs).toISOString(),
        }, { ...cors, "set-cookie": result.setCookie });
        return true;
      }
      const result = await frames.issueFrameSession(admission, {
        projectId: decodeBrowserPathId(match![1]!),
        runId: decodeBrowserPathId(match![2]!),
      });
      networkJsonWithHeaders(response, 201, {
        schemaVersion: 1,
        frameUrl: result.frameUrl,
        expiresAt: new Date(result.expiresAtMs).toISOString(),
      }, cors);
      return true;
    } catch (error) {
      const origin = rawBrowserHeader(request, "origin");
      this.#browserFrameError(response, error, origin === address.origin ? address.origin : undefined);
      return true;
    }
  }

  async #handleBrowserFrameBroker(
    request: IncomingMessage,
    response: ServerResponse,
    address: BrowserNetworkAddress,
  ): Promise<void> {
    if (this.#recoveryStatus) {
      privateApiJson(response, 503, {
        accepted: false,
        error: {
          code: "recovery_required",
          message: "Riff requires recovery before visual access is available.",
        },
      });
      return;
    }
    const url = new URL(request.url ?? "/", address.origin);
    const frames = this.#browserFrames;
    if (!frames) {
      this.#browserFrameError(response, new BrowserFrameCapabilityError(503, "visual_frame_unavailable"));
      return;
    }
    try {
      if (url.pathname.startsWith("/frame/redeem/")) {
        exactEmptyBrowserBody(request, "visual_frame_nonce_invalid");
        if (url.search !== "") throw new BrowserFrameCapabilityError(404, "visual_frame_nonce_invalid");
        const result = await frames.redeem({
          ...browserAdmission(request, address),
          path: url.pathname,
        });
        response.writeHead(303, {
          "cache-control": "no-store",
          "content-length": "0",
          location: result.location,
          "referrer-policy": "no-referrer",
          "set-cookie": result.setCookie,
          "x-content-type-options": "nosniff",
        });
        response.end();
        return;
      }
      if (url.pathname.startsWith("/frame/c/")) {
        exactEmptyBrowserBody(request, "visual_frame_proxy_limit_exceeded");
        const result = await frames.proxy({
          method: request.method ?? "",
          host: address.authority,
          origin: rawBrowserHeader(request, "origin"),
          cookie: rawBrowserHeader(request, "cookie"),
          path: `${url.pathname}${url.search}`,
          headers: browserProxyHeaders(request),
        });
        response.writeHead(result.status, result.headers as Record<string, string>);
        response.end(Buffer.from(result.body));
        return;
      }
      networkJson(response, 404, {
        accepted: false,
        error: {
          code: "broker_route_denied",
          message: "No live visual frame route matches this request.",
        },
      });
    } catch (error) {
      this.#browserFrameError(response, error);
    }
  }

  async #handleBrowserFrameWebSocket(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    address: BrowserNetworkAddress,
  ): Promise<void> {
    if (this.#recoveryStatus) {
      rejectUpgrade(socket, 503, "recovery_required");
      return;
    }
    const frames = this.#browserFrames;
    const bridge = this.#browserWebSockets;
    if (!frames || !bridge) {
      rejectUpgrade(socket, 503, "broker_listener_unavailable");
      return;
    }
    const owner = bridge.createOwner(socket);
    let admission: Awaited<ReturnType<BrowserFrameCapability["admitWebSocket"]>> | undefined;
    try {
      const host = rawBrowserHeader(request, "host");
      admission = await frames.admitWebSocket({
        method: request.method ?? "",
        host: typeof host === "string" ? host : undefined,
        origin: rawBrowserHeader(request, "origin"),
        cookie: rawBrowserHeader(request, "cookie"),
        authorization: rawBrowserHeader(request, "authorization"),
        path: request.url ?? "/",
        protocols: rawBrowserHeader(request, "sec-websocket-protocol"),
        upgrade: rawBrowserHeader(request, "upgrade"),
        connection: rawBrowserHeader(request, "connection"),
        version: rawBrowserHeader(request, "sec-websocket-version"),
        key: rawBrowserHeader(request, "sec-websocket-key"),
        extensions: rawBrowserHeader(request, "sec-websocket-extensions"),
      }, owner);
      await bridge.upgrade(request, socket, head, owner, {
        childPort: admission.target.port,
        childPath: admission.childPath,
        declaredProtocols: admission.target.webSocket?.subprotocols ?? [],
        maxFrameBytes: admission.maxFrameBytes,
        idleTimeoutMs: admission.idleTimeoutMs,
        expiresAtMs: admission.expiresAtMs,
        brokerOrigin: address.origin,
        inspectConnectedPeer: async (peer: BrowserWebSocketPeerIdentity): Promise<boolean> => {
          await admission!.recheckConnected(toFrameConnectedPeer(peer));
          return true;
        },
        live: admission.live,
        markOpen: admission.markOpen,
        onClosed: admission.release,
      });
    } catch (error) {
      admission?.release();
      const denied = webSocketUpgradeError(error);
      rejectUpgrade(socket, denied.status, denied.code);
    }
  }

  #browserFramePreflight(
    request: IncomingMessage,
    response: ServerResponse,
    address: BrowserNetworkAddress,
  ): void {
    const origin = rawBrowserHeader(request, "origin");
    const fetchSite = rawBrowserHeader(request, "sec-fetch-site");
    const requestedMethod = rawBrowserHeader(request, "access-control-request-method");
    const requestedHeaders = rawBrowserHeader(request, "access-control-request-headers");
    const normalizedHeaders = typeof requestedHeaders === "string"
      ? requestedHeaders.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean)
      : [];
    if (origin !== address.origin
      || fetchSite !== "same-origin"
      || requestedMethod !== "POST"
      || Array.isArray(requestedHeaders)
      || normalizedHeaders.some((name) => name !== "content-type" && name !== "x-riff-csrf")
      || rawBrowserHeader(request, "authorization") !== undefined) {
      throw new BrowserFrameCapabilityError(403, "browser_session_denied");
    }
    response.writeHead(204, {
      ...browserCorsHeaders(address.origin),
      "access-control-allow-headers": "Content-Type, X-Riff-CSRF",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-max-age": "300",
      "content-length": "0",
    });
    response.end();
  }

  #browserFrameError(response: ServerResponse, error: unknown, corsOrigin?: string): void {
    const denied = error instanceof BrowserFrameCapabilityError
      ? error
      : new BrowserFrameCapabilityError(502, "visual_frame_proxy_failed");
    const body = {
      accepted: false,
      error: {
        code: denied.code,
        message: "The browser frame request was denied.",
      },
    };
    if (corsOrigin) {
      networkJsonWithHeaders(response, denied.status, body, browserCorsHeaders(corsOrigin));
      return;
    }
    networkJson(response, denied.status, body);
  }

  async #handleWorkbenchBrowser(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    parts: string[],
  ): Promise<boolean> {
    if (parts[0] !== "api" || parts[1] !== "conversations" || !parts[2]
      || parts[3] !== "browser") return false;
    const action = parts[4];
    if (parts.length > 5 || action && ![
      "open", "reload", "back", "screenshot", "close", "restart", "reconnect",
      "takeover", "return",
    ].includes(action)) {
      return false;
    }
    const frames = this.#browserFrames;
    const address = this.#browserNetwork?.app;
    const broker = this.#workbenchBrowserBroker;
    if (this.#listenerMode !== "browser" || !frames || !address || !broker) {
      throw new ApiError(503, "browser_broker_unavailable", "The local Browser Broker is unavailable.");
    }
    try {
      if (request.method === "GET") frames.authorizeAppRead(browserAdmission(request, address));
      else if (request.method === "POST") frames.authorizeAppMutation(browserAdmission(request, address));
      else throw new ApiError(405, "method_not_allowed", "The browser route does not allow this method.");

      if (!action && request.method === "GET") {
        exactQueryKeys(url, []);
        const scope = await this.#currentBrowserScope(parts[2]);
        const dto = await broker.state(scope);
        await this.#revalidateBrowserScope(scope);
        privateApiJson(response, 200, dto);
        return true;
      }
      if (action === "screenshot" && request.method === "GET") {
        exactQueryKeys(url, ["conversationGeneration", "pageGeneration"]);
        const conversationGeneration = strictRequiredQueryInteger(
          url,
          "conversationGeneration",
          1,
          Number.MAX_SAFE_INTEGER,
        );
        const pageGeneration = strictRequiredQueryInteger(
          url,
          "pageGeneration",
          0,
          Number.MAX_SAFE_INTEGER,
        );
        const scope = await this.#currentBrowserScope(parts[2], conversationGeneration);
        const dto = await broker.screenshot(scope, pageGeneration);
        await this.#revalidateBrowserScope(scope);
        privateApiJson(response, 200, dto);
        return true;
      }
      if (request.method !== "POST") {
        throw new ApiError(405, "method_not_allowed", "The browser route does not allow this method.");
      }
      exactQueryKeys(url, []);
      if (action === "open") {
        const body = await exactWorkbenchBrowserJson(request, ["alias"]);
        if (typeof body.alias !== "string"
          || !RIFF_BROWSER_ALIASES.includes(body.alias as RiffBrowserAlias)) {
          throw new ApiError(422, "browser_alias_denied", "The browser alias is not declared.");
        }
        const scope = await this.#currentBrowserScope(parts[2]);
        const dto = await broker.open(scope, body.alias as RiffBrowserAlias);
        await this.#revalidateBrowserScope(scope);
        privateApiJson(response, 200, dto);
        return true;
      }
      if (!action) throw new ApiError(404, "not_found", "The browser route was not found.");
      const body = await exactWorkbenchBrowserJson(
        request,
        ["conversationGeneration", "pageGeneration"],
      );
      const conversationGeneration = exactBrowserInteger(
        body.conversationGeneration,
        1,
        Number.MAX_SAFE_INTEGER,
      );
      const pageGeneration = exactBrowserInteger(body.pageGeneration, 0, Number.MAX_SAFE_INTEGER);
      const scope = await this.#currentBrowserScope(parts[2], conversationGeneration);
      let dto: unknown;
      if (action === "takeover" || action === "return") {
        const authority = this.#browserAgentAuthority;
        if (!authority) {
          throw new ApiError(503, "browser_agent_unavailable", "Browser control is unavailable.");
        }
        dto = action === "takeover"
          ? await authority.takeoverConversation(scope, pageGeneration)
          : await authority.returnConversationToObserver(scope, pageGeneration);
      } else if (action === "close") {
        await this.#browserAgentAuthority?.revokeConversation(scope.conversationId);
        dto = await broker.closeSession(scope, pageGeneration);
      } else {
        dto = action === "reload" ? await broker.reload(scope, pageGeneration)
        : action === "back" ? await broker.back(scope, pageGeneration)
          : action === "restart" ? await broker.restart(scope, pageGeneration)
            : await broker.reconnect(scope, pageGeneration);
      }
      await this.#revalidateBrowserScope(scope);
      if (action === "close") this.#revokeWorkbenchObservationTargets(scope);
      privateApiJson(response, 200, dto);
      return true;
    } catch (error) {
      if (error instanceof LocalBrowserBrokerError) {
        throw new ApiError(error.status, error.code, error.message);
      }
      if (error instanceof BrowserFrameCapabilityError) {
        throw new ApiError(error.status, error.code, "The browser session was denied.");
      }
      throw error;
    }
  }

  async #currentBrowserScope(
    conversationId: string,
    expectedGeneration?: number,
  ): Promise<BrowserConversationScope> {
    const runtime = await this.productStore?.getConversationRuntime(conversationId);
    if (!runtime?.session) {
      throw new ApiError(
        409,
        "browser_conversation_unavailable",
        "The conversation does not have a current generation.",
      );
    }
    if (expectedGeneration !== undefined && runtime.session.generation !== expectedGeneration) {
      await this.#workbenchBrowserBroker?.revoke(Object.freeze({
        conversationId,
        conversationGeneration: expectedGeneration,
      }));
      this.#revokeWorkbenchObservationTargets(Object.freeze({
        conversationId,
        conversationGeneration: expectedGeneration,
      }));
      throw new ApiError(409, "browser_conversation_stale", "The conversation generation changed.");
    }
    return Object.freeze({
      conversationId,
      conversationGeneration: runtime.session.generation,
    });
  }

  async #revalidateBrowserScope(scope: BrowserConversationScope): Promise<void> {
    const runtime = await this.productStore?.getConversationRuntime(scope.conversationId);
    if (!runtime?.session || runtime.session.generation !== scope.conversationGeneration) {
      await this.#workbenchBrowserBroker?.revoke(scope);
      this.#revokeWorkbenchObservationTargets(scope);
      throw new ApiError(409, "browser_conversation_stale", "The conversation generation changed.");
    }
  }

  #revokeWorkbenchObservationTargets(scope: BrowserConversationScope): void {
    this.#workbenchObservationTargets.revoke(scope);
  }

  #workbenchOwnerExists(owner: WorkbenchObservationOwner): boolean {
    if (!this.productStore) return false;
    try {
      return owner.kind === "project"
        ? this.productStore.getProject(owner.id).id === owner.id
        : this.productStore.listModels({ includeArchived: true, includeTrashed: true })
          .some((model) => model.id === owner.id);
    } catch {
      return false;
    }
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    try {
      const url = requestUrl;
      const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      if (request.method === "GET"
        && (url.pathname === "/health" || url.pathname === "/api/health")) {
        return privateApiJson(response, 200, this.#recoveryStatus
          ? { healthy: false, state: "recovery_required" }
          : { healthy: true, state: "ready" });
      }
      if (request.method === "GET" && url.pathname === "/api/recovery-status") {
        const frames = this.#browserFrames;
        const address = this.#browserNetwork?.app;
        if (!frames || !address) {
          throw new ApiError(503, "recovery_required", "Riff recovery status is unavailable.");
        }
        frames.authorizeAppRead(browserAdmission(request, address));
        return privateApiJson(response, 200, this.#recoveryStatus ?? {
          state: "ready",
          observedAt: new Date().toISOString(),
        });
      }
      if (this.#recoveryStatus) {
        if (url.pathname.startsWith("/api/") || url.pathname === "/a2/mcp") {
          throw new ApiError(
            503,
            "recovery_required",
            "Riff requires recovery before this operation is available.",
          );
        }
      }
      if (this.projectOnlyApi && await this.projectOnlyApi.handle(request, response, url, parts)) return;
      if (await this.#handleWorkbenchBrowser(request, response, url, parts)) return;
      if (this.a2 && await this.a2.handle(request, response, url, parts)) return;
      if (this.#productMode) {
        throw new ApiError(404, "not_found", "The requested Product route was not found.");
      }
      if (request.method === "POST" && url.pathname === "/mcp") return await this.#mcp(request, response, url);
      if (parts[0] === "api" && parts[1] === "projects") return await this.#gate2(request, response, url, parts);
      if (request.method === "POST" && parts[0] === "api" && parts[1] === "sessions" && parts.length === 2) return this.#createBrowserSession(request, response);
      if (parts[0] !== "api" || parts[1] !== "sessions" || !parts[2]) throw new ApiError(404, "not_found", "No matching local demo route exists.");
      const sessionId = parts[2];
      if (request.method === "GET" && parts.length === 4 && parts[3] === "snapshot") return json(response, 200, this.store.snapshot(sessionId));
      if (request.method === "GET" && parts.length === 4 && parts[3] === "events") return this.#events(sessionId, request, response);
      if (request.method === "POST" && parts.length === 4 && parts[3] === "uploads") return await this.#upload(sessionId, request, response);
      if (request.method === "DELETE" && parts.length === 5 && parts[3] === "attachments") return await this.#removeAttachment(sessionId, parts[4], request, response);
      if (request.method === "POST" && parts.length === 4 && parts[3] === "chat") return await this.#chat(sessionId, request, response);
      if (request.method === "PUT" && parts.length === 4 && parts[3] === "parameters") return await this.#parameters(sessionId, request, response);
      if (request.method === "POST" && parts.length === 4 && parts[3] === "runs") return await this.#startRun(sessionId, request, response);
      if (request.method === "POST" && parts.length === 6 && parts[3] === "runs" && parts[5] === "cancel") return await this.#cancelRun(sessionId, parts[4], request, response);
      throw new ApiError(404, "not_found", "No matching local demo route exists.");
    } catch (error) {
      const apiError = asApiError(error);
      if (response.headersSent) {
        response.end();
        return;
      }
      const correlationId = randomUUID();
      const publicError = {
        code: apiError.code,
        message: apiError.message,
        correlation_id: correlationId,
        ...(apiError.details ? { details: apiError.details } : {}),
      };
      const gate3 = !this.#productMode
        && isGate3Route(request.method ?? "", requestUrl.pathname);
      const runControl = request.method === "POST"
        && /^\/api\/projects\/[^/]+\/runs\/[^/]+\/(?:cancel|trash|restore)$/u
          .test(requestUrl.pathname);
      const productApi = /^\/api\/(?:health|recovery-status|home|providers|agents|workspace-bindings(?:\/|$)|models(?:\/|$)|projects(?:\/|$)|objects\/|conversations\/|resources\/)/u
        .test(requestUrl.pathname);
      const write = gate3
        ? canonicalJson
        : runControl || productApi
          ? privateApiJson
          : json;
      write(
        response,
        apiError.status,
        gate3
          ? {
            schema_id: "riff://evidence-studio/error/v1",
            schema_version: 1,
            canonical_json_version: "riff-canonical-json-v2",
            accepted: false,
            error: publicError,
          }
          : { accepted: false, error: publicError },
      );
    }
  }

  #a2McpUrl(capability: string): string {
    const browserAddress = this.#browserNetwork?.app;
    const legacyAddress = this.#server?.address();
    if (!browserAddress && (!legacyAddress || typeof legacyAddress === "string")) {
      throw new ApiError(503, "a2_mcp_unavailable", "The local A2 MCP endpoint is not listening.");
    }
    const url = new URL(browserAddress?.origin ?? `http://127.0.0.1:${(legacyAddress as import("node:net").AddressInfo).port}`);
    url.searchParams.set("cap", capability);
    url.pathname = "/a2/mcp";
    return url.toString();
  }

  async #gate2(request: IncomingMessage, response: ServerResponse, url: URL, parts: string[]): Promise<void> {
    if (request.method === "GET" && parts.length === 3 && parts[2] === "default") return json(response, 200, this.gate3.defaultProject());
    if (request.method === "POST" && parts.length === 2) {
      const payload = await gate2JsonBody(request);
      const result = this.gate2.store.createProject(payload as any);
      return json(response, result.status, result.body);
    }
    const projectId = parts[2];
    if (!projectId) throw new ApiError(404, "resource_not_found", "The requested resource was not found.");
    if (request.method === "POST" && parts.length === 4 && parts[3] === "sessions") {
      const payload = await gate2JsonBody(request); exactObject(payload, ["actor_id"]);
      return json(response, 201, this.gate2.store.attachSession(projectId, String(payload.actor_id)));
    }
    if (request.method === "GET" && parts.length === 5 && parts[3] === "browser-projection" && parts[4] === "v1") return json(response, 200, this.gate3.browserProjection(projectId));
    if (request.method === "GET" && parts.length === 5 && parts[3] === "events" && parts[4] === "browser-v1") { exactQueryKeys(url, []); return this.#gate3BrowserEvents(projectId, request, response); }
    if (request.method === "GET" && parts.length === 5 && parts[3] === "wind" && parts[4] === "framed-candidate") return json(response, 200, await this.gate3.framedCandidate(projectId));
    if (request.method === "POST" && parts.length === 6 && parts[3] === "wind" && parts[4] === "framed-evidence" && parts[5] === "activate") { const result = await this.gate3.activate(await gate2Command(request, projectId)); return canonicalJson(response, result.status, result.body); }
    if (request.method === "GET" && parts.length === 6 && parts[3] === "brief" && parts[4] === "revisions") return json(response, 200, this.gate3.businessRevision(projectId, "decision_brief", parts[5]));
    if (request.method === "GET" && parts.length === 6 && parts[3] === "alignment" && parts[4] === "revisions") return json(response, 200, this.gate3.businessRevision(projectId, "alignment_map", parts[5]));
    if (request.method === "GET" && parts.length === 6 && parts[3] === "models" && parts[5] === "view-sources") return json(response, 200, this.gate3.modelViewSources(projectId, parts[4]));
    if (request.method === "GET" && parts.length === 7 && parts[3] === "models" && parts[5] === "view-sources") {
      const source = this.gate3.modelViewSource(projectId, parts[4], parts[6]); response.writeHead(200, { "content-type": "application/json", etag: `"sha256-${source.sha256}"`, "cache-control": "private, no-store" }); response.end(source.bytes); return;
    }
    if (request.method === "GET" && parts.length === 4 && parts[3] === "attestations") {
      exactQueryKeys(url, ["subject_revision_id", "after", "limit"]); const subject = url.searchParams.get("subject_revision_id"); if (!subject) throw new ApiError(422, "invalid_request", "subject_revision_id is required."); const limit = strictQueryInteger(url, "limit", 25, 1, 100); return json(response, 200, this.gate3.attestationPage(projectId, subject, url.searchParams.get("after"), limit));
    }
    if (request.method === "GET" && parts.length === 6 && parts[3] === "runs" && parts[5] === "evidence") { exactQueryKeys(url, []); return json(response, 200, await this.gate3.evidenceIndex(projectId, parts[4])); }
    if (request.method === "GET" && parts.length === 7 && parts[3] === "runs" && parts[5] === "event-projection" && parts[6] === "v1") {
      const allowed = ["after", "limit", "from_day", "to_day", "event_type", "turbine_id", "crew_id", "work_order_id"]; exactQueryKeys(url, allowed); const after = strictQueryInteger(url, "after", 0, 0, Number.MAX_SAFE_INTEGER); const limit = strictQueryInteger(url, "limit", 100, 1, 500); const fromDay = optionalFinite(url, "from_day"); const toDay = optionalFinite(url, "to_day"); if (fromDay !== null && fromDay < 0 || toDay !== null && (toDay < 0 || fromDay !== null && toDay < fromDay)) throw new ApiError(422, "invalid_request", "Event day filters are invalid."); const filters = { from_day: fromDay, to_day: toDay, event_type: url.searchParams.get("event_type"), turbine_id: url.searchParams.get("turbine_id"), crew_id: url.searchParams.get("crew_id"), work_order_id: url.searchParams.get("work_order_id") }; return json(response, 200, await this.gate3.filteredEvents(projectId, parts[4], after, limit, filters));
    }
    if (request.method === "GET" && parts.length === 6 && parts[3] === "runs" && parts[5] === "kpis") { exactQueryKeys(url, ["after_day", "limit"]); const afterDay = strictQueryInteger(url, "after_day", -1, -1, 3660); const limit = strictQueryInteger(url, "limit", 100, 1, 366); return json(response, 200, await this.gate3.kpis(projectId, parts[4], afterDay, limit)); }
    if (request.method === "GET" && parts.length === 6 && parts[3] === "runs" && parts[5] === "replay") { exactQueryKeys(url, ["after_frame", "limit"]); const afterFrame = strictQueryInteger(url, "after_frame", -1, -1, 119); const limit = strictQueryInteger(url, "limit", 14, 1, 31); return json(response, 200, await this.gate3.replay(projectId, parts[4], afterFrame, limit)); }
    if (request.method === "GET" && parts.length === 4 && parts[3] === "snapshot") return json(response, 200, this.gate2.store.publicProjection(projectId));
    if (request.method === "GET" && parts.length === 4 && parts[3] === "events") return this.#gate2ProjectEvents(projectId, request, response, url);
    if (request.method === "POST" && parts.length === 4 && parts[3] === "actors") return this.#gate2Mutation(response, await gate2Command(request, projectId), (command) => this.gate2.store.createActor(command as any));
    if (request.method === "POST" && parts.length === 5 && parts[3] === "wind" && parts[4] === "bootstrap") {
      const result = await this.gate2.bootstrap(await gate2Command(request, projectId)); return json(response, result.status, result.body);
    }
    if (request.method === "POST" && parts.length === 5 && parts[3] === "brief" && parts[4] === "revisions") return this.#gate2Mutation(response, await gate2Command(request, projectId), (command) => this.gate2.store.createBrief(command as any));
    if (request.method === "POST" && parts.length === 5 && parts[3] === "alignment" && parts[4] === "revisions") return this.#gate2Mutation(response, await gate2Command(request, projectId), (command) => this.gate2.store.createAlignment(command as any));
    if (request.method === "POST" && parts.length === 5 && parts[3] === "experiments" && parts[4] === "revisions") return this.#gate2Mutation(response, await gate2Command(request, projectId), (command) => this.gate2.store.createExperiment(command));
    if (request.method === "POST" && parts.length === 4 && parts[3] === "issues") return this.#gate2Mutation(response, await gate2Command(request, projectId), (command) => this.gate2.store.createIssue(command as any));
    if (request.method === "GET" && parts.length === 6 && parts[3] === "issues" && parts[5] === "history") return json(response, 200, this.gate2.store.issueHistory(projectId, parts[4]));
    if (request.method === "POST" && parts.length === 6 && parts[3] === "issues" && parts[5] === "comments") {
      const command = await gate2Command(request, projectId); if ((command.payload as any).issue_id !== parts[4] || (command.payload as any).event_type !== "commented") throw new ApiError(422, "validation_error", "Issue comment payload does not match its route.");
      return this.#gate2Mutation(response, command, (value) => this.gate2.store.appendIssueEvent(value as any));
    }
    if (request.method === "PATCH" && parts.length === 5 && parts[3] === "issues") {
      const command = await gate2Command(request, projectId); if ((command.payload as any).issue_id !== parts[4]) throw new ApiError(422, "validation_error", "Issue update payload does not match its route.");
      return this.#gate2Mutation(response, command, (value) => this.gate2.store.appendIssueEvent(value as any));
    }
    if (request.method === "POST" && parts.length === 4 && parts[3] === "attestations") return this.#gate2Mutation(response, await gate2Command(request, projectId), (command) => this.gate2.store.createAttestations(command as any));
    if (request.method === "POST" && parts.length === 4 && parts[3] === "runs") return this.#gate2Mutation(response, await gate2Command(request, projectId), (command) => this.gate2.startRun(command as any));
    if (request.method === "GET" && parts.length === 5 && parts[3] === "runs") return json(response, 200, { run: this.gate2.run(projectId, parts[4]) });
    if (request.method === "POST" && parts.length === 6 && parts[3] === "runs" && parts[5] === "cancel") {
      const command = await gate2Command(request, projectId); if ((command.payload as any).run_id !== parts[4]) throw new ApiError(422, "validation_error", "Run cancellation payload does not match its route.");
      return this.#gate2Mutation(response, command, (value) => this.gate2.cancelRun(value as any));
    }
    if (request.method === "GET" && parts.length === 6 && parts[3] === "runs" && parts[5] === "events") {
      const after = strictQueryInteger(url, "after", 0, 0, Number.MAX_SAFE_INTEGER); const limit = strictQueryInteger(url, "limit", 100, 1, 1000);
      return json(response, 200, await this.gate2.domainEvents(projectId, parts[4], after, limit));
    }
    if (request.method === "GET" && parts.length === 5 && parts[3] === "artifacts") {
      const artifact = await this.gate2.artifact(projectId, parts[4]);
      response.writeHead(200, { "content-type": artifact.media_type, "content-length": artifact.bytes.byteLength, "content-disposition": `attachment; filename="${artifact.filename}"`, "cache-control": "private, no-store" }); response.end(artifact.bytes); return;
    }
    throw new ApiError(404, "resource_not_found", "The requested resource was not found.");
  }

  #gate3BrowserEvents(projectId: string, request: IncomingMessage, response: ServerResponse): void {
    const initial = this.gate3.browserProjection(projectId); response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    response.write(`event: browser.project.snapshot.v1\ndata: ${JSON.stringify({ ...initial, event_type: "browser.project.snapshot.v1" })}\n\n`); let prior = initial; let closed = false;
    const timer = setInterval(() => { if (closed) return; try { const next = this.gate3.browserProjection(projectId); if (next.snapshot_revision === prior.snapshot_revision && next.projection_digest === prior.projection_digest) return; if (next.snapshot_revision === prior.snapshot_revision + 1) response.write(`event: browser.project.patch.v1\ndata: ${JSON.stringify({ schema_id: "riff://evidence-studio/browser-project-patch/v1", schema_version: 1, canonical_json_version: "riff-canonical-json-v2", event_type: "browser.project.patch.v1", project_id: projectId, base_snapshot_revision: prior.snapshot_revision, snapshot_revision: next.snapshot_revision, projection_digest: next.projection_digest, operations: [{ op: "replace", path: "", value: next.projection }] })}\n\n`); else response.write(`event: browser.project.reload-required.v1\ndata: ${JSON.stringify({ schema_id: "riff://evidence-studio/browser-project-reload-required/v1", schema_version: 1, canonical_json_version: "riff-canonical-json-v2", event_type: "browser.project.reload-required.v1", project_id: projectId, base_snapshot_revision: prior.snapshot_revision, snapshot_revision: next.snapshot_revision, projection_digest: next.projection_digest, reason: next.snapshot_revision > prior.snapshot_revision + 1 ? "revision_gap" : "projection_changed_while_disconnected" })}\n\n`); prior = next; } catch { response.end(); clearInterval(timer); } }, 250); timer.unref?.();
    const cleanup = (): void => { if (closed) return; closed = true; clearInterval(timer); }; request.on("close", cleanup); response.on("close", cleanup);
  }

  #gate2Mutation(response: ServerResponse, command: ProjectCommand<any>, action: (command: ProjectCommand<any>) => { status: number; body: Record<string, unknown> }): void {
    const result = action(command); json(response, result.status, result.body);
  }

  #gate2ProjectEvents(projectId: string, request: IncomingMessage, response: ServerResponse, url: URL): void {
    if (!String(request.headers.accept ?? "").includes("text/event-stream")) {
      const after = strictQueryInteger(url, "after", -1, -1, Number.MAX_SAFE_INTEGER); const limit = strictQueryInteger(url, "limit", 100, 1, 100);
      return json(response, 200, { snapshot: this.gate2.store.publicProjection(projectId), ...this.gate2.store.projectEventPage(projectId, after, limit) });
    }
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
    let projection = this.gate2.store.publicProjection(projectId) as any; let revision = projection.snapshot_revision as number;
    response.write(`id: ${revision}\nevent: project.snapshot\ndata: ${JSON.stringify(projection)}\n\n`);
    const poll = setInterval(() => {
      try {
        const next = this.gate2.store.publicProjection(projectId) as any; const nextRevision = next.snapshot_revision as number;
        if (nextRevision === revision) return;
        if (nextRevision !== revision + 1) response.write(`event: project.reload_required\ndata: ${JSON.stringify({ snapshot_revision: nextRevision })}\n\n`);
        else response.write(`id: ${nextRevision}\nevent: project.patch\ndata: ${JSON.stringify({ snapshot_revision: nextRevision, operations: [{ op: "replace", path: "", value: next }] })}\n\n`);
        projection = next; revision = nextRevision;
      } catch { response.end(); }
    }, 250);
    const keepAlive = setInterval(() => response.write(": keepalive\n\n"), 15_000);
    request.once("close", () => { clearInterval(poll); clearInterval(keepAlive); });
  }

  #events(sessionId: string, request: IncomingMessage, response: ServerResponse): void {
    const snapshot = this.store.snapshot(sessionId);
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    sendEvent(response, { type: "project.snapshot", data: snapshot });
    sendEvent(response, { type: "connection.status", data: { status: "connected" } });
    const unsubscribe = this.store.subscribe(sessionId, (event) => sendEvent(response, event));
    const keepAlive = setInterval(() => response.write(": keepalive\n\n"), 15_000);
    request.once("close", () => {
      clearInterval(keepAlive);
      unsubscribe();
    });
  }

  async #mcp(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    let payload: unknown;
    try { payload = JSON.parse(await bodyText(request, 256_000)); }
    catch { throw new ApiError(422, "invalid_mcp_request", "MCP requests must contain valid JSON."); }
    const result = await this.mcp.handle(url.searchParams.get("cap") ?? undefined, payload as any);
    if (!result) {
      response.writeHead(202, { "cache-control": "no-store" });
      response.end();
      return;
    }
    json(response, 200, result);
  }

  #createBrowserSession(request: IncomingMessage, response: ServerResponse): void {
    // The route intentionally has no client-controlled creation payload.
    request.resume();
    const sessionId = `session_${randomUUID()}`;
    const state = this.createSession(sessionId);
    json(response, 201, { sessionId, state });
  }

  async #upload(sessionId: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const { envelope, file } = await multipart(request, 1_200_000);
    const command = parseCommand<{ clientFileName?: string }>(envelope, sessionId);
    const duplicate = this.store.beginCommand(command);
    if (duplicate) return json(response, 202, duplicate);
    if (!file) throw new ApiError(422, "missing_file", "Attach one CSV, JSON, or TXT input file.");
    const declaredName = typeof command.payload.clientFileName === "string" ? command.payload.clientFileName : file.filename;
    const allowed = attachmentType(declaredName, file.contentType);
    if (!allowed) throw new ApiError(422, "unsupported_attachment", "Only CSV, JSON, and TXT files up to 1 MiB are supported.");
    if (file.data.byteLength > 1024 * 1024) throw new ApiError(413, "attachment_too_large", "Attachments are limited to 1 MiB.");
    const id = `upl_${randomUUID()}`;
    const projectId = this.store.projectId(sessionId);
    const displayName = safeFilename(declaredName);
    const workspacePath = join(this.options.workspaceRoot, "projects", projectId, "inputs", `${id}-${displayName}`);
    await mkdir(join(this.options.workspaceRoot, "projects", projectId, "inputs"), { recursive: true });
    await writeFile(workspacePath, file.data, { flag: "wx" });
    const attachment: StoredAttachment = {
      id,
      displayName,
      originalName: displayName,
      mediaType: allowed,
      sizeBytes: file.data.byteLength,
      status: "ready",
      workspacePath,
      sha256: createHash("sha256").update(file.data).digest("hex"),
    };
    this.store.addAttachment(sessionId, attachment);
    json(response, 202, this.store.acceptCommand(sessionId, command.commandId));
  }

  async #removeAttachment(sessionId: string, attachmentId: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const command = parseCommand<{ attachmentId: string }>(await bodyText(request), sessionId);
    if (command.payload.attachmentId !== attachmentId) throw new ApiError(422, "attachment_mismatch", "Attachment payload does not match the route.");
    const duplicate = this.store.beginCommand(command);
    if (duplicate) return json(response, 202, duplicate);
    const attachment = this.store.attachment(sessionId, attachmentId);
    const state = this.store.snapshot(sessionId);
    if (state.conversation.some((message) => message.attachmentIds?.includes(attachmentId))) {
      throw new ApiError(409, "attachment_in_use", "This attachment is retained because the conversation already references it.");
    }
    await rm(attachment.workspacePath, { force: false });
    this.store.removeAttachment(sessionId, attachmentId);
    json(response, 202, this.store.acceptCommand(sessionId, command.commandId));
  }

  async #chat(sessionId: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const command = parseCommand<{ text: string; attachmentIds: string[] }>(await bodyText(request), sessionId);
    const duplicate = this.store.beginCommand(command);
    if (duplicate) return json(response, 202, duplicate);
    if (!command.payload.text?.trim()) throw new ApiError(422, "empty_message", "Enter a message for the modelling assistant.");
    const attachments = command.payload.attachmentIds ?? [];
    const stored = attachments.map((id) => this.store.attachment(sessionId, id));
    if (stored.some((attachment) => attachment.status !== "ready")) throw new ApiError(409, "attachment_not_ready", "Wait for all selected attachments before sending a message.");
    if (this.#readiness.status !== "ready" || !this.#readiness.modelId) throw new ApiError(503, "agent_not_ready", this.#readiness.lastError?.message ?? "The modelling assistant is not ready.");
    const messageId = `msg_${randomUUID()}`;
    this.store.mutate(sessionId, (draft) => {
      draft.conversation.push({ id: messageId, role: "user", text: command.payload.text.trim(), attachmentIds: attachments, status: "complete", createdAt: new Date().toISOString() });
      draft.agent = { modelId: this.#readiness.modelId, status: "thinking" };
    });
    this.store.publish(sessionId, { type: "agent.status", data: { modelId: this.#readiness.modelId, status: "thinking" } });
    const projectId = this.store.projectId(sessionId);
    if (this.#readiness.modelId !== "dev/deterministic" && this.options.openCode.bindProject) {
      if (!this.options.mcpUrl) throw new ApiError(503, "mcp_unconfigured", "Set RIFF_MCP_URL before using live OpenCode tools.");
      const capability = this.#mcpCapabilities.get(sessionId);
      if (!capability) throw new ApiError(500, "mcp_capability_missing", "The local MCP capability is unavailable.");
      await this.options.openCode.bindProject(projectId, withCapability(this.options.mcpUrl, capability));
    }
    const openCodeSession = await this.options.openCode.createSession(projectId);
    this.#openCodeEvents.bind(openCodeSession, sessionId);
    try {
      const promptAbort = new AbortController();
      await withTimeout(
        this.options.openCode.prompt(openCodeSession, {
          text: command.payload.text.trim(),
          attachments: stored.map((attachment) => ({ id: attachment.id, mediaType: attachment.mediaType, workspaceRelativePath: `inputs/${attachment.id}-${attachment.displayName}` })),
          system: restrictedSystemPrompt(),
        }, promptAbort.signal),
        this.options.promptTimeoutMs ?? 30_000,
        () => {
          promptAbort.abort();
          return this.options.openCode.abort(openCodeSession);
        },
      );
      if (this.#readiness.modelId === "dev/deterministic") {
        await this.#runDeterministicDevAction(sessionId, command.payload.text);
        this.store.setAgent(sessionId, { modelId: this.#readiness.modelId, status: "ready" });
      }
      json(response, 202, this.store.acceptCommand(sessionId, command.commandId));
    } catch (error) {
      const apiError = asApiError(error);
      this.store.mutate(sessionId, (draft) => {
        draft.agent = { modelId: this.#readiness.modelId, status: "error", lastError: { code: apiError.code, message: apiError.message } };
      });
      this.store.publish(sessionId, { type: "agent.status", data: { modelId: this.#readiness.modelId, status: "error", lastError: { code: apiError.code, message: apiError.message } } });
      throw apiError;
    }
  }

  async #runDeterministicDevAction(sessionId: string, text: string): Promise<void> {
    const normalized = text.toLowerCase();
    const requestsModel = /\b(load|prepare|build)\b/.test(normalized) && /\b(queue|model|simulation)\b/.test(normalized);
    if (!requestsModel) {
      this.store.mutate(sessionId, (draft) => {
        draft.conversation.push({
          id: `msg_${randomUUID()}`,
          role: "assistant",
          text: "Development demo mode can load the approved queue simulation. Ask me to load the queue model.",
          status: "complete",
          createdAt: new Date().toISOString(),
        });
      });
      return;
    }
    await this.actions.loadModel(sessionId, "queue-network-v1");
    this.store.mutate(sessionId, (draft) => {
      draft.conversation.push({
        id: `msg_${randomUUID()}`,
        role: "assistant",
        text: "Development demo mode loaded the approved queue-network-v1 model. Configure its parameters in the workbench.",
        status: "complete",
        createdAt: new Date().toISOString(),
      });
    });
  }

  async #parameters(sessionId: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const command = parseCommand<{ modelId: string; values: Record<string, Scalar> }>(await bodyText(request), sessionId);
    const duplicate = this.store.beginCommand(command);
    if (duplicate) return json(response, 202, duplicate);
    const state = this.store.snapshot(sessionId);
    if (state.model?.id !== command.payload.modelId) throw new ApiError(409, "model_not_active", "The selected model is no longer active.");
    this.actions.saveParameters(sessionId, command.payload.values);
    json(response, 202, this.store.acceptCommand(sessionId, command.commandId));
  }

  async #startRun(sessionId: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const command = parseCommand<{ modelId: string; parameters?: Record<string, Scalar>; steps?: number; seeds?: number[] }>(await bodyText(request), sessionId);
    const duplicate = this.store.beginCommand(command);
    if (duplicate) return json(response, 202, duplicate);
    const state = this.store.snapshot(sessionId);
    if (!state.model || command.payload.modelId !== state.model.id) throw new ApiError(409, "model_not_active", "The selected model is no longer active.");
    if (command.payload.parameters && !sameValues(command.payload.parameters, state.model.parameterValues)) {
      throw new ApiError(409, "parameters_not_saved", "Save parameter changes before starting a run.");
    }
    await this.actions.startRun(sessionId, { steps: command.payload.steps, seeds: command.payload.seeds });
    json(response, 202, this.store.acceptCommand(sessionId, command.commandId));
  }

  async #cancelRun(sessionId: string, runId: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const command = parseCommand<Record<string, never>>(await bodyText(request), sessionId);
    const duplicate = this.store.beginCommand(command);
    if (duplicate) return json(response, 202, duplicate);
    await this.actions.cancelRun(sessionId, runId);
    json(response, 202, this.store.acceptCommand(sessionId, command.commandId));
  }
}

const publicAgent = (readiness: OpenCodeReadiness): ProjectState["agent"] => ({
  modelId: readiness.modelId,
  status: readiness.status,
  ...(readiness.lastError ? { lastError: readiness.lastError } : {}),
});

const asConversationOpenCode = (value: OpenCodeAdapter): OpenCodeConversationPort => {
  const candidate = value as Partial<OpenCodeConversationPort>;
  if (typeof candidate.discoverProviderModels !== "function" || typeof candidate.getSession !== "function"
    || typeof candidate.createSession !== "function" || typeof candidate.injectContext !== "function"
    || typeof candidate.promptWithModel !== "function" || typeof candidate.abort !== "function") {
    throw new ApiError(500, "a2_opencode_invalid", "Milestone A2 requires the loopback OpenCode conversation adapter.");
  }
  return candidate as OpenCodeConversationPort;
};

const json = (response: ServerResponse, status: number, payload: unknown): void => {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(payload));
};

const privateApiJson = (
  response: ServerResponse,
  status: number,
  payload: unknown,
): void => {
  const bytes = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, {
    "cache-control": "private, no-store",
    "content-length": bytes.byteLength,
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(bytes);
};

const browserVisualHostPage = (
  response: ServerResponse,
  method: string | undefined,
  brokerOrigin: string,
): void => {
  const nonce = randomUUID().replaceAll("-", "");
  const source = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Riff visual run</title>
</head>
<body>
<main id="visual-host" data-status="loading" data-stage="bootstrap">
<p id="visual-status" role="status" aria-live="polite">Preparing the visual run.</p>
<iframe id="visual-frame" title="Project visual run" sandbox="allow-scripts allow-same-origin" referrerpolicy="no-referrer" hidden></iframe>
</main>
<script nonce="${nonce}">
(() => {
  "use strict";
  const host = document.getElementById("visual-host");
  const status = document.getElementById("visual-status");
  const frame = document.getElementById("visual-frame");
  const brokerOrigin = ${JSON.stringify(brokerOrigin)};
  const route = /^\\/browser\\/projects\\/([^/]+)\\/runs\\/([^/]+)\\/visual$/.exec(location.pathname);
  const fail = (code) => {
    host.dataset.status = "error";
    host.dataset.stage = "error";
    host.dataset.errorCode = code;
    status.textContent = "The visual run is unavailable.";
  };
  const responseCode = async (response, fallback) => {
    try {
      const body = await response.json();
      return typeof body?.error?.code === "string" ? body.error.code : fallback;
    } catch {
      return fallback;
    }
  };
  const start = async () => {
    if (!route) throw new Error("visual_host_route_invalid");
    const projectId = decodeURIComponent(route[1]);
    const runId = decodeURIComponent(route[2]);
    host.dataset.stage = "bootstrap";
    const bootstrapResponse = await fetch("/api/browser-session/bootstrap", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        accept: "application/json",
        "content-type": "application/json"
      },
      body: "{}"
    });
    if (!bootstrapResponse.ok) {
      throw new Error(await responseCode(bootstrapResponse, "browser_session_denied"));
    }
    const bootstrap = await bootstrapResponse.json();
    if (typeof bootstrap.csrfToken !== "string" || !Number.isSafeInteger(bootstrap.generation)) {
      throw new Error("browser_session_denied");
    }
    host.dataset.browserGeneration = String(bootstrap.generation);
    host.dataset.stage = "frame-session";
    const issueResponse = await fetch(
      "/api/projects/" + encodeURIComponent(projectId) + "/runs/" + encodeURIComponent(runId) + "/visual-frame-session",
      {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          accept: "application/json",
          "x-riff-csrf": bootstrap.csrfToken
        }
      }
    );
    if (!issueResponse.ok) {
      throw new Error(await responseCode(issueResponse, "visual_frame_unavailable"));
    }
    const issued = await issueResponse.json();
    if (typeof issued.frameUrl !== "string" || new URL(issued.frameUrl).origin !== brokerOrigin) {
      throw new Error("visual_frame_unavailable");
    }
    frame.addEventListener("load", () => {
      host.dataset.status = "loaded";
      host.dataset.stage = "navigation-complete";
      status.textContent = "Visual frame navigation completed.";
    }, { once: true });
    frame.src = issued.frameUrl;
    frame.hidden = false;
    host.dataset.status = "frame-issued";
    host.dataset.stage = "navigation";
    status.textContent = "Loading the visual run.";
  };
  void start().catch((error) => fail(
    error instanceof Error && /^[a-z0-9_]+$/.test(error.message)
      ? error.message
      : "visual_frame_unavailable"
  ));
})();
</script>
</body>
</html>`;
  const bytes = Buffer.from(source);
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-length": bytes.byteLength,
    "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; frame-src ${brokerOrigin}; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`,
    "content-type": "text/html; charset=utf-8",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
  response.end(method === "HEAD" ? undefined : bytes);
};

const browserWorkbenchObservationPage = (
  response: ServerResponse,
  method: string | undefined,
  projection: Readonly<{
    owner: WorkbenchObservationOwner;
    conversationId: string;
    conversationGeneration: number;
  }>,
): void => {
  const source = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Riffology owner observation</title>
<style>body{margin:0;padding:48px;font:16px/1.5 system-ui,sans-serif;background:#fff;color:#1d1d1f}main{max-width:760px;margin:auto}h1{font-size:32px}dl{display:grid;grid-template-columns:max-content 1fr;gap:8px 20px}dt{color:#62666d}dd{margin:0;overflow-wrap:anywhere}</style>
</head>
<body>
<main data-riff-observation="${projection.owner.kind}">
<p>Riffology · read-only observation</p>
<h1>Owner workspace</h1>
<dl>
<dt>Owner</dt><dd>${projection.owner.kind === "model" ? "Model" : "Project"} · ${escapeObservationHtml(projection.owner.id)}</dd>
<dt>Conversation</dt><dd>${escapeObservationHtml(projection.conversationId)}</dd>
<dt>Generation</dt><dd>${projection.conversationGeneration}</dd>
</dl>
</main>
</body>
</html>`;
  const bytes = Buffer.from(source);
  response.writeHead(200, {
    "cache-control": "private, no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "content-length": bytes.byteLength,
    "content-type": "text/html; charset=utf-8",
    "cross-origin-resource-policy": "same-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
  response.end(method === "HEAD" ? undefined : bytes);
};

const escapeObservationHtml = (value: string): string => value
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");

const networkJsonWithHeaders = (
  response: ServerResponse,
  status: number,
  payload: Record<string, unknown>,
  headers: Record<string, string>,
): void => {
  const bytes = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": bytes.byteLength,
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  response.end(bytes);
};

const browserCorsHeaders = (origin: string): Record<string, string> => ({
  "access-control-allow-credentials": "true",
  "access-control-allow-origin": origin,
  vary: "Origin",
});

const rawBrowserHeader = (
  request: IncomingMessage,
  expectedName: string,
): string | readonly string[] | undefined => {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === expectedName) {
      values.push(request.rawHeaders[index + 1] ?? "");
    }
  }
  return values.length === 0 ? undefined : values.length === 1 ? values[0] : Object.freeze(values);
};

const toFrameConnectedPeer = (
  peer: BrowserWebSocketPeerIdentity,
): BrowserFrameConnectedPeer => Object.freeze({
  localHost: peer.localAddress,
  localPort: peer.localPort,
  remoteHost: peer.remoteAddress,
  remotePort: peer.remotePort,
});

const webSocketUpgradeError = (
  error: unknown,
): Readonly<{ status: number; code: string }> => {
  if (error instanceof BrowserFrameCapabilityError
    || error instanceof BrowserWebSocketBridgeError) {
    return Object.freeze({ status: error.status, code: error.code });
  }
  return Object.freeze({ status: 502, code: "visual_websocket_upstream_failed" });
};

const browserAdmission = (
  request: IncomingMessage,
  address: BrowserNetworkAddress,
): BrowserRequestAdmission => {
  const host = rawBrowserHeader(request, "host");
  return {
    method: request.method ?? "",
    host: typeof host === "string" ? host : undefined,
    origin: rawBrowserHeader(request, "origin"),
    fetchSite: rawBrowserHeader(request, "sec-fetch-site"),
    fetchMode: rawBrowserHeader(request, "sec-fetch-mode"),
    fetchDest: rawBrowserHeader(request, "sec-fetch-dest"),
    cookie: rawBrowserHeader(request, "cookie"),
    csrf: rawBrowserHeader(request, "x-riff-csrf"),
    authorization: rawBrowserHeader(request, "authorization"),
  };
};

const exactEmptyBrowserBody = (
  request: IncomingMessage,
  code:
    | "browser_session_denied"
    | "visual_frame_nonce_invalid"
    | "visual_frame_proxy_limit_exceeded",
): void => {
  const contentLength = rawBrowserHeader(request, "content-length");
  if (rawBrowserHeader(request, "transfer-encoding") !== undefined
    || Array.isArray(contentLength)
    || contentLength !== undefined && contentLength !== "0") {
    const status = code === "visual_frame_proxy_limit_exceeded" ? 502 : code === "visual_frame_nonce_invalid" ? 404 : 403;
    throw new BrowserFrameCapabilityError(status, code);
  }
};

const exactEmptyJsonObject = async (
  request: IncomingMessage,
): Promise<void> => {
  const contentLength = rawBrowserHeader(request, "content-length");
  const contentType = rawBrowserHeader(request, "content-type");
  if (rawBrowserHeader(request, "transfer-encoding") !== undefined
    || contentLength !== "2"
    || contentType !== "application/json") {
    throw new BrowserFrameCapabilityError(403, "browser_session_denied");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > 2) {
      throw new BrowserFrameCapabilityError(403, "browser_session_denied");
    }
    chunks.push(bytes);
  }
  if (Buffer.concat(chunks).toString("utf8") !== "{}") {
    throw new BrowserFrameCapabilityError(403, "browser_session_denied");
  }
};

const decodeBrowserPathId = (value: string): string => {
  try {
    const decoded = decodeURIComponent(value);
    if (decoded.includes("/") || decoded.includes("\\") || decoded.includes("\0")) throw new Error("invalid path id");
    return decoded;
  } catch {
    throw new BrowserFrameCapabilityError(403, "browser_session_denied");
  }
};

const browserProxyHeaders = (
  request: IncomingMessage,
): Readonly<Record<string, string | readonly string[] | undefined>> => Object.freeze({
  accept: rawBrowserHeader(request, "accept"),
  "accept-language": rawBrowserHeader(request, "accept-language"),
  "if-none-match": rawBrowserHeader(request, "if-none-match"),
  "if-modified-since": rawBrowserHeader(request, "if-modified-since"),
  range: rawBrowserHeader(request, "range"),
});

const canonicalJson = (response: ServerResponse, status: number, payload: unknown): void => {
  const bytes = canonicalJsonV2(payload);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": bytes.byteLength, "cache-control": "no-store" });
  response.end(bytes);
};

const sendEvent = (response: ServerResponse, event: BrowserEvent): void => {
  response.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
};

const parseCommand = <T>(text: string, routeSessionId: string): UiCommand<T> => {
  let value: UiCommand<T>;
  try { value = JSON.parse(text); } catch { throw new ApiError(422, "invalid_json", "Request body must be valid JSON."); }
  if (!value || typeof value.commandId !== "string" || typeof value.sessionId !== "string" || typeof value.baseRevision !== "number" || value.payload === undefined) {
    throw new ApiError(422, "invalid_command", "Request does not match the local command envelope.");
  }
  if (value.sessionId !== routeSessionId) throw new ApiError(422, "session_mismatch", "Command session does not match the route.");
  return value;
};

const exactObject = (value: unknown, keys: string[]): asserts value is Record<string, unknown> => {
  let plain = false; try { plain = value !== null && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)); } catch { plain = false; } if (!plain) throw new ApiError(422, "validation_error", "Request body must be a plain object.");
  let actual: string[]; try { actual = Object.keys(value as Record<string, unknown>).sort(); } catch { throw new ApiError(422, "validation_error", "Request body must be a plain object."); } const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new ApiError(422, "validation_error", "The request contains missing or unsupported fields.");
};

const gate2JsonBody = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
  const text = await bodyText(request, 256_000);
  let value: unknown; try { value = parseCanonicalJsonV2(text); } catch { throw new ApiError(422, "validation_error", "Request body must be strict JSON without duplicate or unsafe keys."); }
  const keys = value !== null && typeof value === "object" && !Array.isArray(value) ? Object.keys(value as Record<string, unknown>) : []; exactObject(value, keys);
  return value;
};

const gate2Command = async (request: IncomingMessage, projectId: string): Promise<ProjectCommand<any>> => {
  const value = await gate2JsonBody(request);
  exactObject(value, ["command_id", "project_id", "session_id", "base_snapshot_revision", "payload"]);
  const payload = value.payload;
  const payloadKeys = payload !== null && typeof payload === "object" && !Array.isArray(payload) ? Object.keys(payload as Record<string, unknown>) : [];
  exactObject(payload, payloadKeys);
  if (value.project_id !== projectId) throw new ApiError(404, "resource_not_found", "The requested resource was not found.");
  return value as ProjectCommand<any>;
};

const strictQueryInteger = (url: URL, name: string, fallback: number, minimum: number, maximum: number): number => {
  const raw = url.searchParams.get(name); if (raw === null) return fallback;
  if (!(minimum < 0 && raw === "-1") && !/^(?:0|[1-9]\d*)$/u.test(raw)) throw new ApiError(422, "invalid_request", `Query parameter ${name} must be an integer.`);
  const value = Number(raw); if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new ApiError(422, "invalid_request", `Query parameter ${name} is out of range.`);
  return value;
};

const strictRequiredQueryInteger = (
  url: URL,
  name: string,
  minimum: number,
  maximum: number,
): number => {
  const raw = url.searchParams.get(name);
  if (raw === null || !/^(?:0|[1-9]\d*)$/u.test(raw)) {
    throw new ApiError(422, "invalid_browser_request", "The browser query is invalid.");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ApiError(422, "invalid_browser_request", "The browser query is invalid.");
  }
  return value;
};

const exactBrowserInteger = (value: unknown, minimum: number, maximum: number): number => {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new ApiError(422, "invalid_browser_request", "The browser generation is invalid.");
  }
  return value as number;
};

const exactWorkbenchBrowserJson = async (
  request: IncomingMessage,
  keys: readonly string[],
): Promise<Record<string, unknown>> => {
  const contentType = rawBrowserHeader(request, "content-type");
  if (contentType !== "application/json") {
    throw new ApiError(415, "unsupported_media_type", "Use application/json.");
  }
  const text = await bodyText(request, 4_096);
  let value: unknown;
  try { value = parseCanonicalJsonV2(text); }
  catch { throw new ApiError(422, "invalid_browser_request", "The browser request must be strict JSON."); }
  exactObject(value, [...keys]);
  return value;
};

const exactQueryKeys = (url: URL, allowed: string[]): void => {
  const permitted = new Set(allowed); const seen = new Set<string>();
  for (const key of [...url.searchParams.keys()].sort()) { if (!permitted.has(key) || seen.has(key)) throw new ApiError(422, "invalid_request", "The request query is invalid."); seen.add(key); }
};

const isGate3Route = (method: string, pathname: string): boolean => {
  if (pathname === "/api/projects/default") return true;
  if (!pathname.startsWith("/api/projects/")) return false;
  return /\/(?:browser-projection\/v1|events\/browser-v1|wind\/framed-candidate|wind\/framed-evidence\/activate|attestations\/detail)$/u.test(pathname)
    || method === "GET" && /\/attestations$/u.test(pathname)
    || /\/models\/[^/]+\/view-sources(?:\/[^/]+)?$/u.test(pathname)
    || method === "GET" && /\/(?:brief|alignment)\/revisions\/[^/]+$/u.test(pathname)
    || /\/runs\/[^/]+\/(?:evidence|event-projection\/v1|kpis|replay)$/u.test(pathname);
};

const optionalFinite = (url: URL, name: string): number | null => { const raw = url.searchParams.get(name); if (raw === null) return null; if (raw.trim() === "" || !Number.isFinite(Number(raw))) throw new ApiError(422, "invalid_request", `Query parameter ${name} must be finite.`); return Number(raw); };

const bodyText = async (request: IncomingMessage, limit = 1_100_000): Promise<string> => {
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    received += buffer.length;
    if (received > limit) throw new ApiError(413, "request_too_large", "The request is too large.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
};

const exactLegacyCloseDrainTimeout = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 1 || value > 30_000) {
    throw new Error("The legacy listener close-drain timeout must be an integer from 1 through 30000 milliseconds.");
  }
  return value;
};

const closeServerWithDrain = async (server: Server, timeoutMs: number): Promise<void> => {
  server.closeIdleConnections?.();
  if (!server.listening) return;
  const closing = new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve()));
  let timer: NodeJS.Timeout | undefined;
  try {
    const drained = await Promise.race([
      closing.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref?.();
      }),
    ]);
    if (!drained) {
      server.closeAllConnections?.();
      await closing;
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
};

type MultipartFile = { filename: string; contentType: string; data: Buffer };
const multipart = async (request: IncomingMessage, limit: number): Promise<{ envelope: string; file?: MultipartFile }> => {
  const contentType = request.headers["content-type"] ?? "";
  const match = /boundary=([^;]+)/i.exec(contentType);
  if (!match) throw new ApiError(422, "invalid_upload", "Use multipart form data for file uploads.");
  const raw = Buffer.from(await bodyText(request, limit));
  const boundary = Buffer.from(`--${match[1].replace(/^"|"$/g, "")}`);
  const pieces = splitBuffer(raw, boundary).slice(1, -1);
  let envelope = "";
  let file: MultipartFile | undefined;
  for (const part of pieces) {
    const trimmed = part.subarray(0, 2).equals(Buffer.from("\r\n")) ? part.subarray(2) : part;
    const divider = trimmed.indexOf(Buffer.from("\r\n\r\n"));
    if (divider < 0) continue;
    const header = trimmed.subarray(0, divider).toString("utf8");
    const data = trimmed.subarray(divider + 4, trimmed.length - 2);
    const name = /name="([^"]+)"/i.exec(header)?.[1];
    if (name === "envelope") envelope = data.toString("utf8");
    if (name === "file") file = {
      filename: /filename="([^"]*)"/i.exec(header)?.[1] ?? "upload",
      contentType: /content-type:\s*([^\r\n]+)/i.exec(header)?.[1]?.trim().toLowerCase() ?? "application/octet-stream",
      data,
    };
  }
  if (!envelope) throw new ApiError(422, "missing_command", "The upload command envelope is required.");
  return { envelope, file };
};

const splitBuffer = (source: Buffer, separator: Buffer): Buffer[] => {
  const values: Buffer[] = [];
  let offset = 0;
  while (offset <= source.length) {
    const index = source.indexOf(separator, offset);
    if (index < 0) { values.push(source.subarray(offset)); break; }
    values.push(source.subarray(offset, index));
    offset = index + separator.length;
  }
  return values;
};

const attachmentType = (filename: string, contentType: string): string | undefined => {
  const extension = basename(filename).toLowerCase().split(".").pop();
  const expected = extension === "csv" ? "text/csv" : extension === "json" ? "application/json" : extension === "txt" ? "text/plain" : undefined;
  if (!expected) return undefined;
  const normalized = contentType.split(";", 1)[0].toLowerCase();
  return normalized === expected || normalized === "application/octet-stream" ? expected : undefined;
};

const safeFilename = (filename: string): string => {
  const safe = basename(filename).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
  if (!safe || safe === "." || safe === "..") throw new ApiError(422, "invalid_filename", "The attachment filename is invalid.");
  return safe;
};

const sameValues = (left: Record<string, Scalar>, right: Record<string, Scalar>): boolean => {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
};

const withCapability = (mcpUrl: string, capability: string): string => {
  let url: URL;
  try {
    url = new URL(mcpUrl);
  } catch {
    throw new ApiError(503, "mcp_unconfigured", "RIFF_MCP_URL must be an absolute local MCP URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ApiError(503, "mcp_unconfigured", "RIFF_MCP_URL must use HTTP or HTTPS.");
  }
  url.searchParams.set("cap", capability);
  return url.toString();
};

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, abort: () => Promise<void>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new ApiError(504, "agent_timeout", "The modelling assistant timed out.")), timeoutMs);
      }),
    ]);
  } catch (error) {
    if (error instanceof ApiError && error.code === "agent_timeout") void abort().catch(() => undefined);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const restrictedSystemPrompt = (): string => [
  "You are the local Riff Mesa modelling assistant.",
  "Use only the Riff MCP tools exposed in this session: riff_inspect_uploaded_files, riff_select_and_load_model(queue-network-v1), riff_set_parameters, riff_run_experiment, riff_get_run_status, and riff_read_run_results.",
  "Never call python-interpreter tools or any non-Riff tool. Do not use shell, local files, generic read/search/edit/write/task, network, browser, skill, or code-generation tools.",
  "Do not call riff_drive_workbench_ui or show_dashboard; they are not part of this assistant surface. If an action is unsupported, explain the limit and ask the user instead.",
  "After riff_select_and_load_model returns model_loaded, use its returned parameter metadata; do not inspect the local runtime to infer the model.",
  "For riff_get_run_status, omit runId when the run ID is unknown; an empty string is not a run ID and means the current run.",
  "After riff_read_run_results returns results_loaded, summarize its metrics and final series values in Chinese; do not reload or rerun a succeeded model unless the user asks.",
  "Do not claim an action succeeded until its tool result confirms it.",
].join("\n");
