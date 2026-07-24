import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export type ModelWorkspaceCapability = Readonly<{
  root: string;
  capabilityId: string;
}>;

export type RestrictedProcessLimits = Readonly<{
  timeoutMs: number;
  maxOutputBytes: number;
  terminateGraceMs: number;
}>;

export type RestrictedProcessResult = Readonly<{
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
  outputLimitExceeded: boolean;
}>;

export type RestrictedProcessCommand = Readonly<{
  executable: string;
  argv: readonly string[];
}>;

export type RestrictedProcessIsolation =
  | Readonly<{ kind: "macos-sandbox"; sandboxExecutable?: string; runtimeReadRoots?: readonly string[] }>
  | Readonly<{ kind: "injected-test-boundary"; launcher: RestrictedProcessLauncher }>;

export type RestrictedProcessLauncher = (input: Readonly<{
  executable: string;
  argv: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
}>) => ChildProcessWithoutNullStreams;

export type RestrictedProcessOptions = Readonly<{
  workspace: ModelWorkspaceCapability;
  command: RestrictedProcessCommand;
  isolation?: RestrictedProcessIsolation;
  limits?: Partial<RestrictedProcessLimits>;
  now?: () => number;
}>;

export type RestrictedProcessRunInput = Readonly<{
  stdin?: Uint8Array | string;
  signal?: AbortSignal;
}>;

const DEFAULT_LIMITS: RestrictedProcessLimits = {
  timeoutMs: 15_000,
  maxOutputBytes: 256 * 1024,
  terminateGraceMs: 500,
};

const BASE_ENV = Object.freeze({
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  PYTHONHASHSEED: "0",
  PYTHONNOUSERSITE: "1",
  PYTHONDONTWRITEBYTECODE: "1",
  // macOS injects this key for CoreFoundation processes; pin a non-identifying
  // value instead of inheriting the local user's encoding tuple.
  __CF_USER_TEXT_ENCODING: "0x0:0:0",
});

export class RestrictedProcessError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RestrictedProcessError";
    this.code = code;
  }
}

/**
 * Resolves an application-owned directory once. Callers cannot later replace
 * the capability with a path supplied by a model or by the browser.
 */
export const createModelWorkspaceCapability = (root: string, capabilityId: string): ModelWorkspaceCapability => {
  if (!capabilityId || capabilityId.length > 200) throw new RestrictedProcessError("invalid_capability", "A bounded workspace capability ID is required.");
  const absolute = resolve(root);
  let canonical: string;
  try { canonical = realpathSync(absolute); }
  catch (error) { throw new RestrictedProcessError("workspace_unavailable", "The Model workspace does not exist.", { cause: error }); }
  if (!statSync(canonical).isDirectory()) throw new RestrictedProcessError("workspace_unavailable", "The Model workspace must be a directory.");
  return Object.freeze({ root: canonical, capabilityId });
};

/**
 * One runner instance represents exactly one executable and argv vector. The
 * run call accepts only stdin and cancellation; model text can never become a
 * command, executable, argument, cwd, or environment variable.
 */
export class RestrictedProcessRunner {
  readonly #workspace: ModelWorkspaceCapability;
  readonly #command: RestrictedProcessCommand;
  readonly #isolation: RestrictedProcessIsolation;
  readonly #limits: RestrictedProcessLimits;
  readonly #now: () => number;

  constructor(options: RestrictedProcessOptions) {
    this.#workspace = options.workspace;
    this.#command = resolveCommand(options.command);
    this.#isolation = options.isolation ?? {
      kind: "macos-sandbox",
      runtimeReadRoots: trustedPythonRuntimeRoots(options.command.executable, this.#command.executable),
    };
    this.#limits = validateLimits({ ...DEFAULT_LIMITS, ...options.limits });
    this.#now = options.now ?? Date.now;
  }

  async run(input: RestrictedProcessRunInput = {}): Promise<RestrictedProcessResult> {
    if (input.signal?.aborted) return cancelledBeforeStart();
    const launch = this.#launchSpec();
    const processTemp = mkdtempSync(join(this.#workspace.root, ".riff-process-"));
    const startedAt = this.#now();
    let child: ChildProcessWithoutNullStreams;
    try {
      child = launch.launcher({ executable: launch.executable, argv: launch.argv, cwd: this.#workspace.root, env: { ...BASE_ENV, TMPDIR: processTemp } });
    } catch (error) {
      rmSync(processTemp, { recursive: true, force: true });
      throw new RestrictedProcessError("process_spawn_failed", "The restricted Model process could not start.", { cause: error });
    }

    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let timedOut = false;
    let cancelled = false;
    let outputLimitExceeded = false;
    let terminating = false;
    let hardKill: NodeJS.Timeout | undefined;

    const terminate = (reason: "timeout" | "cancel" | "output"): void => {
      if (terminating) return;
      terminating = true;
      timedOut = reason === "timeout";
      cancelled = reason === "cancel";
      outputLimitExceeded = reason === "output";
      killProcessGroup(child, "SIGTERM");
      hardKill = setTimeout(() => killProcessGroup(child, "SIGKILL"), this.#limits.terminateGraceMs);
      hardKill.unref?.();
    };
    const append = (current: Buffer, chunk: Buffer): Buffer => {
      const remaining = Math.max(0, this.#limits.maxOutputBytes - stdout.byteLength - stderr.byteLength);
      const accepted = chunk.subarray(0, remaining);
      const next = accepted.byteLength ? Buffer.concat([current, accepted]) : current;
      if (accepted.byteLength !== chunk.byteLength || stdout.byteLength + stderr.byteLength + accepted.byteLength >= this.#limits.maxOutputBytes) terminate("output");
      return next;
    };
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, Buffer.from(chunk)); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, Buffer.from(chunk)); });

    const onAbort = (): void => terminate("cancel");
    input.signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => terminate("timeout"), this.#limits.timeoutMs);
    timeout.unref?.();

    const completed = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
      child.once("error", (error) => reject(new RestrictedProcessError("process_runtime_failed", "The restricted Model process failed.", { cause: error })));
      child.once("close", (exitCode, signal) => resolveExit({ exitCode, signal }));
    });
    try {
      if (input.stdin !== undefined) child.stdin.end(input.stdin);
      else child.stdin.end();
      const exit = await completed;
      return Object.freeze({
        ...exit,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        durationMs: Math.max(0, this.#now() - startedAt),
        timedOut,
        cancelled,
        outputLimitExceeded,
      });
    } finally {
      clearTimeout(timeout);
      if (hardKill) clearTimeout(hardKill);
      input.signal?.removeEventListener("abort", onAbort);
      if (child.exitCode === null && child.signalCode === null) killProcessGroup(child, "SIGKILL");
      rmSync(processTemp, { recursive: true, force: true });
    }
  }

  #launchSpec(): { executable: string; argv: readonly string[]; launcher: RestrictedProcessLauncher } {
    if (this.#isolation.kind === "injected-test-boundary") {
      return { executable: this.#command.executable, argv: this.#command.argv, launcher: this.#isolation.launcher };
    }
    if (process.platform !== "darwin") {
      throw new RestrictedProcessError("network_isolation_unavailable", "Restricted Model execution is supported only by the macOS network-denying boundary.");
    }
    const sandbox = canonicalRestrictedExecutable(this.#isolation.sandboxExecutable ?? "/usr/bin/sandbox-exec");
    const readRoots = (this.#isolation.runtimeReadRoots ?? []).map((root) => canonicalRuntimeRoot(root, this.#workspace.root));
    const profile = macosSandboxProfile(this.#workspace.root, this.#command.executable, readRoots);
    return {
      executable: sandbox,
      argv: ["-p", profile, this.#command.executable, ...this.#command.argv],
      launcher: defaultLauncher,
    };
  }
}

const resolveCommand = (command: RestrictedProcessCommand): RestrictedProcessCommand => {
  const executable = canonicalRestrictedExecutable(command.executable);
  const argv = command.argv.map((value) => {
    if (typeof value !== "string" || value.includes("\0") || value.length > 8_192) throw new RestrictedProcessError("invalid_command", "A restricted process argument is invalid.");
    return value;
  });
  if (argv.length > 64) throw new RestrictedProcessError("invalid_command", "The restricted process has too many arguments.");
  return Object.freeze({ executable, argv: Object.freeze(argv) });
};

export const canonicalRestrictedExecutable = (input: string): string => {
  if (!isAbsolute(input)) throw new RestrictedProcessError("invalid_executable", "The restricted executable must be an absolute path.");
  let executable: string;
  try {
    // /usr/bin/python3 is an Apple developer-tool shim that injects SDK/path
    // variables before exec. Resolve the actual framework interpreter so the
    // child receives only Riff's explicit environment allowlist.
    executable = process.platform === "darwin" && input === "/usr/bin/python3"
      ? realpathSync("/Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions/3.9/Resources/Python.app/Contents/MacOS/Python")
      : realpathSync(input);
    if (process.platform === "darwin") {
      const framework = versionedPythonFrameworkRoot(executable);
      const appBinary = framework ? join(framework, "Resources/Python.app/Contents/MacOS/Python") : "";
      if (appBinary && existsSync(appBinary)) executable = realpathSync(appBinary);
    }
  }
  catch (error) { throw new RestrictedProcessError("invalid_executable", "The restricted executable is unavailable.", { cause: error }); }
  const stat = statSync(executable);
  if (!stat.isFile() || (stat.mode & 0o111) === 0) throw new RestrictedProcessError("invalid_executable", "The restricted executable is not an executable file.");
  return executable;
};

const canonicalRuntimeRoot = (input: string, workspace: string): string => {
  const root = realpathSync(resolve(input));
  if (!statSync(root).isDirectory()) throw new RestrictedProcessError("invalid_runtime_root", "A runtime read root is not a directory.");
  // Runtime roots outside the Model capability are accepted only when they are
  // recognisable Python runtime material selected by the backend executable:
  // an exact virtual environment or a versioned Python.framework directory.
  // Arbitrary directories (including home, repo, and credential roots) remain
  // invalid even though this option is application-owned.
  if (root !== workspace && relative(workspace, root).startsWith("..") && !trustedExternalPythonRoot(root)) {
    throw new RestrictedProcessError("invalid_runtime_root", "Runtime read roots must be owned by the current Model workspace.");
  }
  return root;
};

export const trustedPythonRuntimeRoots = (requestedExecutable: string, canonical: string): string[] => {
  const roots: string[] = [];
  const requestedVenv = resolve(requestedExecutable, "../..");
  if (existsSync(join(requestedVenv, "pyvenv.cfg"))) roots.push(requestedVenv);
  let target = canonical;
  try { target = realpathSync(requestedExecutable); } catch { /* executable validation reports this */ }
  const framework = versionedPythonFrameworkRoot(target);
  if (framework) roots.push(framework);
  const installation = versionedHomebrewPythonRoot(target);
  if (installation) roots.push(installation, "/opt/homebrew/opt", "/opt/homebrew/Cellar", "/opt/homebrew/lib");
  return roots;
};

const trustedExternalPythonRoot = (root: string): boolean =>
  existsSync(join(root, "pyvenv.cfg")) || Boolean(versionedPythonFrameworkRoot(root) === root) || Boolean(versionedHomebrewPythonRoot(root) === root)
  || ["/opt/homebrew/opt", "/opt/homebrew/Cellar", "/opt/homebrew/lib"].includes(root);

const versionedPythonFrameworkRoot = (value: string): string | null => {
  const match = /^(.*\/Python\.framework\/Versions\/[^/]+)(?:\/|$)/u.exec(value);
  return match?.[1] ?? null;
};

const versionedHomebrewPythonRoot = (value: string): string | null => {
  const match = /^(.*\/Cellar\/python(?:@[^/]+)?\/[^/]+)(?:\/|$)/u.exec(value);
  return match?.[1] ?? null;
};

const validateLimits = (limits: RestrictedProcessLimits): RestrictedProcessLimits => {
  if (!Number.isSafeInteger(limits.timeoutMs) || limits.timeoutMs < 1 || limits.timeoutMs > 300_000) throw new RestrictedProcessError("invalid_limits", "The process timeout is invalid.");
  if (!Number.isSafeInteger(limits.maxOutputBytes) || limits.maxOutputBytes < 1 || limits.maxOutputBytes > 16 * 1024 * 1024) throw new RestrictedProcessError("invalid_limits", "The process output limit is invalid.");
  if (!Number.isSafeInteger(limits.terminateGraceMs) || limits.terminateGraceMs < 1 || limits.terminateGraceMs > 10_000) throw new RestrictedProcessError("invalid_limits", "The termination grace period is invalid.");
  return Object.freeze(limits);
};

const defaultLauncher: RestrictedProcessLauncher = ({ executable, argv, cwd, env }) => spawn(executable, argv, {
  cwd,
  env: { ...env },
  shell: false,
  stdio: ["pipe", "pipe", "pipe"],
  detached: true,
  windowsHide: true,
});

const killProcessGroup = (child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void => {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try { process.kill(-child.pid, signal); }
  catch {
    try { child.kill(signal); }
    catch { /* already exited */ }
  }
};

export const macosSandboxProfile = (workspace: string, executable: string, runtimeReadRoots: readonly string[]): string =>
  macosSandboxProfileForRoots({
    readableRoots: [workspace],
    writableRoots: [workspace],
    executable,
    runtimeReadRoots,
  });

export const macosBatchSandboxProfile = (input: Readonly<{
  projectRoot: string;
  inputPath: string;
  outputRoot: string;
  tempRoot: string;
  launchReceiptPath?: string;
  executable: string;
  runtimeReadRoots: readonly string[];
}>): string => macosSandboxProfileForRoots({
  readableRoots: [
    input.projectRoot,
    input.inputPath,
    input.outputRoot,
    input.tempRoot,
    ...(input.launchReceiptPath ? [input.launchReceiptPath] : []),
  ],
  writableRoots: [
    input.outputRoot,
    input.tempRoot,
    ...(input.launchReceiptPath ? [input.launchReceiptPath] : []),
  ],
  executable: input.executable,
  runtimeReadRoots: input.runtimeReadRoots,
});

const macosSandboxProfileForRoots = (input: Readonly<{
  readableRoots: readonly string[];
  writableRoots: readonly string[];
  executable: string;
  runtimeReadRoots: readonly string[];
}>): string => {
  const literal = (value: string): string => `\"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}\"`;
  const executableTarget = realpathSync(input.executable);
  const roots = [...new Set([
    ...input.readableRoots,
    dirname(input.executable),
    dirname(executableTarget),
    ...input.runtimeReadRoots,
  ])];
  const reads = roots.map((root) => `(literal ${literal(root)}) (subpath ${literal(root)})`).join(" ");
  const runtimeMetadata = [...new Set([...input.readableRoots, ...input.runtimeReadRoots].flatMap(pathAncestors))]
    .map((root) => `(literal ${literal(root)})`).join(" ");
  const writes = [...new Set(input.writableRoots)]
    .map((root) => `(literal ${literal(root)}) (subpath ${literal(root)})`).join(" ");
  const applePythonFramework = "/Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework";
  const applePython = executableTarget.startsWith(`${applePythonFramework}/`);
  const versionedFramework = versionedPythonFrameworkRoot(executableTarget);
  const userRoots = ["/Users"];
  try { userRoots.push(realpathSync("/Users")); } catch { /* fail-closed rules still include /Users */ }
  const readableUserRoots = [...input.readableRoots, ...input.runtimeReadRoots]
    .filter((root) => root === "/Users" || root.startsWith("/Users/"));
  const readExclusions = readableUserRoots.map((root) => `(require-not (subpath ${literal(root)}))`).join(" ");
  const denyUserReads = [...new Set(userRoots)].map((root) => `(deny file-read-data (require-all (subpath ${literal(root)}) ${readExclusions}))`);
  return [
    "(version 1)",
    "(deny default)",
    "(allow process-fork)",
    `(allow process-exec (literal ${literal(input.executable)}) (literal ${literal(executableTarget)})${versionedFramework ? ` (subpath ${literal(versionedFramework)})` : ""}${applePython ? ` (subpath ${literal(applePythonFramework)})` : ""})`,
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    `(allow file-read-metadata ${reads} ${runtimeMetadata} (subpath \"/System\") (subpath \"/usr\")${applePython ? ` (literal \"/Library\") (literal \"/Library/Developer\") (subpath \"/Library/Developer/CommandLineTools\")` : ""} (subpath \"/private/var/db/timezone\") (literal \"/dev/null\") (literal \"/dev/urandom\"))`,
    // Inherited pipes need data access, but regular files still require one of
    // the explicit path grants below.
    "(allow file-read-data (require-not (vnode-type REGULAR-FILE)))",
    `(allow file-read-data ${reads} (subpath \"/System\") (subpath \"/usr/lib\")${applePython ? ` (subpath \"/Library/Developer/CommandLineTools\")` : ""} (subpath \"/private/var/db/timezone\") (literal \"/dev/null\") (literal \"/dev/urandom\"))`,
    "(allow file-write-data (require-not (vnode-type REGULAR-FILE)))",
    ...denyUserReads,
    `(allow file-read* ${reads} (subpath \"/System\") (subpath \"/usr/lib\")${applePython ? ` (subpath \"/Library/Developer/CommandLineTools\")` : ""} (subpath \"/private/var/db/timezone\") (literal \"/dev/null\") (literal \"/dev/urandom\"))`,
    `(allow file-write* ${writes} (literal \"/dev/null\"))`,
    // No network rule is present: deny-default rejects inbound and outbound
    // sockets, including direct connections that ignore proxy variables.
  ].join("\n");
};

const pathAncestors = (value: string): string[] => {
  const ancestors: string[] = [];
  let cursor = dirname(value);
  while (cursor !== "/" && cursor !== ".") { ancestors.push(cursor); cursor = dirname(cursor); }
  return ancestors;
};

const cancelledBeforeStart = (): RestrictedProcessResult => Object.freeze({
  exitCode: null,
  signal: null,
  stdout: "",
  stderr: "",
  durationMs: 0,
  timedOut: false,
  cancelled: true,
  outputLimitExceeded: false,
});
