import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
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
  | Readonly<{ kind: "linux-namespace"; unshareExecutable?: string; runtimeReadRoots?: readonly string[] }>
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
      kind: process.platform === "linux" ? "linux-namespace" : "macos-sandbox",
      runtimeReadRoots: trustedPythonRuntimeRoots(options.command.executable, this.#command.executable),
    };
    this.#limits = validateLimits({ ...DEFAULT_LIMITS, ...options.limits });
    this.#now = options.now ?? Date.now;
  }

  async run(input: RestrictedProcessRunInput = {}): Promise<RestrictedProcessResult> {
    if (input.signal?.aborted) return cancelledBeforeStart();
    const processTemp = mkdtempSync(join(this.#workspace.root, ".riff-process-"));
    const sandboxRoot = this.#isolation.kind === "linux-namespace"
      ? mkdtempSync(join(tmpdir(), "riff-linux-sandbox-"))
      : undefined;
    let launch: { executable: string; argv: readonly string[]; launcher: RestrictedProcessLauncher };
    try {
      launch = this.#launchSpec(sandboxRoot);
    } catch (error) {
      rmSync(processTemp, { recursive: true, force: true });
      if (sandboxRoot) rmSync(sandboxRoot, { recursive: true, force: true });
      throw error;
    }
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
      if (sandboxRoot) rmSync(sandboxRoot, { recursive: true, force: true });
    }
  }

  #launchSpec(sandboxRoot?: string): { executable: string; argv: readonly string[]; launcher: RestrictedProcessLauncher } {
    if (this.#isolation.kind === "injected-test-boundary") {
      return { executable: this.#command.executable, argv: this.#command.argv, launcher: this.#isolation.launcher };
    }
    if (this.#isolation.kind === "linux-namespace") {
      if (process.platform !== "linux" || !sandboxRoot) {
        throw new RestrictedProcessError("network_isolation_unavailable", "The Linux namespace process boundary is unavailable.");
      }
      const readRoots = (this.#isolation.runtimeReadRoots ?? [])
        .map((root) => canonicalRuntimeRoot(root, this.#workspace.root));
      return linuxNamespaceLaunchSpec({
        sandboxRoot,
        workspace: this.#workspace.root,
        executable: this.#command.executable,
        argv: this.#command.argv,
        runtimeReadRoots: readRoots,
        unshareExecutable: this.#isolation.unshareExecutable,
      });
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
  const standalone = standalonePythonRoot(target);
  if (standalone) roots.push(standalone);
  const framework = versionedPythonFrameworkRoot(target);
  if (framework) roots.push(framework);
  const installation = versionedHomebrewPythonRoot(target);
  if (installation) roots.push(installation, "/opt/homebrew/opt", "/opt/homebrew/Cellar", "/opt/homebrew/lib");
  return roots;
};

const trustedExternalPythonRoot = (root: string): boolean =>
  existsSync(join(root, "pyvenv.cfg")) || Boolean(versionedPythonFrameworkRoot(root) === root) || Boolean(versionedHomebrewPythonRoot(root) === root)
  || standalonePythonRoot(join(root, "bin", "python3")) === root
  || ["/opt/homebrew/opt", "/opt/homebrew/Cellar", "/opt/homebrew/lib"].includes(root);

const standalonePythonRoot = (value: string): string | null => {
  const root = resolve(value, "../..");
  return existsSync(join(root, "BUILD"))
    && existsSync(join(root, "bin"))
    && existsSync(join(root, "lib"))
    ? root : null;
};

const versionedPythonFrameworkRoot = (value: string): string | null => {
  const match = /^(.*\/Python\.framework\/Versions\/[^/]+)(?:\/|$)/u.exec(value);
  return match?.[1] ?? null;
};

const versionedHomebrewPythonRoot = (value: string): string | null => {
  const match = /^(.*\/Cellar\/python(?:@[^/]+)?\/[^/]+)(?:\/|$)/u.exec(value);
  return match?.[1] ?? null;
};

const LINUX_NAMESPACE_SCRIPT = String.raw`
root=$1
process_cwd=$2
executable=$3
mount_proc=$4
runtime_count=$5
readonly_root_count=$6
writable_root_count=$7
readonly_file_count=$8
shift 8

mount -t tmpfs -o nosuid,nodev,mode=700 tmpfs "$root"

bind_readonly_directory() {
  source_path=$1
  [ -d "$source_path" ] || return 0
  mkdir -p "$root$source_path"
  mount --rbind "$source_path" "$root$source_path"
  mount --make-rslave "$root$source_path"
  mount -o remount,bind,ro,nosuid,nodev "$root$source_path"
}

bind_readonly_file() {
  source_path=$1
  [ -e "$source_path" ] || return 0
  target_dir=$(dirname "$source_path")
  mkdir -p "$root$target_dir"
  : > "$root$source_path"
  mount --bind "$source_path" "$root$source_path"
  mount -o remount,bind,ro,nosuid,nodev "$root$source_path"
}

for system_root in /usr/lib /usr/local/lib /lib /lib64; do
  bind_readonly_directory "$system_root"
done
for system_file in /etc/ld.so.cache /etc/localtime /dev/null /dev/urandom; do
  bind_readonly_file "$system_file"
done

while [ "$runtime_count" -gt 0 ]; do
  bind_readonly_directory "$1"
  shift
  runtime_count=$((runtime_count - 1))
done

while [ "$readonly_root_count" -gt 0 ]; do
  bind_readonly_directory "$1"
  shift
  readonly_root_count=$((readonly_root_count - 1))
done

while [ "$readonly_file_count" -gt 0 ]; do
  bind_readonly_file "$1"
  shift
  readonly_file_count=$((readonly_file_count - 1))
done

bind_readonly_file "$executable"
for helper in /usr/bin/umount /usr/bin/rmdir /usr/bin/setpriv /usr/bin/env; do
  bind_readonly_file "$helper"
done

while [ "$writable_root_count" -gt 0 ]; do
  writable_root=$1
  shift
  mkdir -p "$root$writable_root"
  mount --bind "$writable_root" "$root$writable_root"
  mount -o remount,bind,rw,nosuid,nodev,noexec "$root$writable_root"
  writable_root_count=$((writable_root_count - 1))
done

mkdir -p "$root/proc" "$root/.oldroot" "$root$process_cwd"
if [ "$mount_proc" = 1 ]; then
  mount -t proc -o nosuid,nodev,noexec proc "$root/proc"
fi

cd "$root"
/usr/sbin/pivot_root . .oldroot
/usr/bin/umount -l /.oldroot
/usr/bin/rmdir /.oldroot
cd "$process_cwd"
unset PWD OLDPWD _
exec /usr/bin/env -u SHLVL /usr/bin/setpriv \
  --bounding-set=-all \
  --inh-caps=-all \
  --ambient-caps=-all \
  --no-new-privs \
  "$executable" "$@"
`;

export const linuxIsolatedProcessLaunchSpec = (input: Readonly<{
  sandboxRoot: string;
  cwd: string;
  executable: string;
  argv: readonly string[];
  runtimeReadRoots: readonly string[];
  readableRoots: readonly string[];
  writableRoots: readonly string[];
  readableFiles?: readonly string[];
  pidNamespace?: boolean;
  unshareExecutable?: string;
}>): Readonly<{
  executable: string;
  argv: readonly string[];
  launcher: RestrictedProcessLauncher;
}> => {
  const sandboxRoot = realpathSync(input.sandboxRoot);
  if (!statSync(sandboxRoot).isDirectory()) {
    throw new RestrictedProcessError("network_isolation_unavailable", "The Linux sandbox root is unavailable.");
  }
  const unshare = canonicalRestrictedExecutable(input.unshareExecutable ?? "/usr/bin/unshare");
  const shell = canonicalRestrictedExecutable("/bin/sh");
  canonicalRestrictedExecutable("/usr/sbin/pivot_root");
  for (const helper of ["/usr/bin/umount", "/usr/bin/rmdir", "/usr/bin/setpriv", "/usr/bin/env"]) {
    canonicalRestrictedExecutable(helper);
  }
  const cwd = realpathSync(input.cwd);
  const runtimeReadRoots = input.runtimeReadRoots.map((root) => realpathSync(root));
  const readableRoots = input.readableRoots.map((root) => realpathSync(root));
  const writableRoots = input.writableRoots.map((root) => realpathSync(root));
  const readableFiles = (input.readableFiles ?? []).map((file) => realpathSync(file));
  for (const root of [...runtimeReadRoots, ...readableRoots, ...writableRoots]) {
    if (!statSync(root).isDirectory()) {
      throw new RestrictedProcessError("invalid_runtime_root", "A Linux sandbox root is not a directory.");
    }
  }
  for (const file of readableFiles) {
    if (!statSync(file).isFile()) {
      throw new RestrictedProcessError("invalid_runtime_root", "A Linux sandbox file is not regular.");
    }
  }
  if (![...readableRoots, ...writableRoots].some((root) => cwd === root || !relative(root, cwd).startsWith(".."))) {
    throw new RestrictedProcessError("invalid_runtime_root", "The Linux sandbox cwd is outside its capability roots.");
  }
  const childArgv = input.argv.map((argument) => {
    if (typeof argument !== "string" || argument.includes("\0") || argument.length > 8_192) {
      throw new RestrictedProcessError("invalid_command", "A restricted process argument is invalid.");
    }
    return argument;
  });
  if (childArgv.length > 128) {
    throw new RestrictedProcessError("invalid_command", "The restricted process has too many arguments.");
  }
  const pidNamespace = input.pidNamespace ?? true;
  return Object.freeze({
    executable: unshare,
    argv: Object.freeze([
      "--user",
      "--map-root-user",
      "--mount",
      "--net",
      ...(pidNamespace ? ["--pid", "--fork"] : []),
      shell,
      "-ceu",
      LINUX_NAMESPACE_SCRIPT,
      "riff-linux-namespace",
      sandboxRoot,
      cwd,
      input.executable,
      pidNamespace ? "1" : "0",
      String(runtimeReadRoots.length),
      String(readableRoots.length),
      String(writableRoots.length),
      String(readableFiles.length),
      ...runtimeReadRoots,
      ...readableRoots,
      ...readableFiles,
      ...writableRoots,
      ...childArgv,
    ]),
    launcher: defaultLauncher,
  });
};

export const linuxNamespaceLaunchSpec = (input: Readonly<{
  sandboxRoot: string;
  workspace: string;
  executable: string;
  argv: readonly string[];
  runtimeReadRoots: readonly string[];
  unshareExecutable?: string;
}>): Readonly<{
  executable: string;
  argv: readonly string[];
  launcher: RestrictedProcessLauncher;
}> => linuxIsolatedProcessLaunchSpec({
  sandboxRoot: input.sandboxRoot,
  cwd: input.workspace,
  executable: input.executable,
  argv: input.argv,
  runtimeReadRoots: input.runtimeReadRoots,
  readableRoots: Object.freeze([]),
  writableRoots: Object.freeze([input.workspace]),
  pidNamespace: true,
  unshareExecutable: input.unshareExecutable,
});

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
    // The gate fsyncs the receipt's containing directory before acknowledging
    // registration. Under /Users, the explicit deny rule would otherwise
    // reject opening that exact directory even though the receipt file itself
    // is readable and writable.
    ...(input.launchReceiptPath ? [dirname(input.launchReceiptPath), input.launchReceiptPath] : []),
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
