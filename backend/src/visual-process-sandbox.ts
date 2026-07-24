import {
  existsSync,
  lstatSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  canonicalRestrictedExecutable,
  trustedPythonRuntimeRoots,
} from "./restricted-process.ts";

export const VISUAL_LOOPBACK_HOST = "127.0.0.1" as const;

export type VisualSandboxIsolation = Readonly<{
  kind: "macos-seatbelt-ipv4-port";
  assignedHost: typeof VISUAL_LOOPBACK_HOST;
  assignedPort: number;
  outboundNetwork: "denied";
  endpointIsolation: "requires-os-listener-closed-set";
  requiresOsListenerClosedSet: true;
  limitation: "seatbelt-localhost-filter-allows-ipv4-wildcard";
}>;

export type VisualProcessSandboxInput = Readonly<{
  projectRoot: string;
  inputPath: string;
  outputRoot: string;
  scratchRoot: string;
  tempRoot: string;
  launchReceiptPath?: string;
  executable: string;
  runtimeReadRoots: readonly string[];
  assignedHost: typeof VISUAL_LOOPBACK_HOST;
  assignedPort: number;
}>;

export type VisualProcessSandboxProfile = Readonly<{
  profile: string;
  projectRoot: string;
  inputPath: string;
  outputRoot: string;
  scratchRoot: string;
  tempRoot: string;
  launchReceiptPath: string | null;
  executable: string;
  runtimeReadRoots: readonly string[];
  isolation: VisualSandboxIsolation;
}>;

export type VisualProcessSandboxLaunchSpec = VisualProcessSandboxProfile & Readonly<{
  sandboxExecutable: string;
  argv: readonly string[];
  cwd: string;
}>;

export class VisualProcessSandboxError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "VisualProcessSandboxError";
    this.code = code;
  }
}

/**
 * Builds the visual-only Seatbelt profile. It intentionally does not expose an
 * environment: the later supervisor owns the exact environment allowlist.
 *
 * On current macOS Seatbelt, `local tcp4 "localhost:<port>"` restricts the
 * family and port but also matches `0.0.0.0:<port>`. The returned isolation
 * contract therefore always requires an OS listener closed-set check and never
 * claims literal-host endpoint isolation.
 */
export const createVisualProcessSandboxProfile = (
  input: VisualProcessSandboxInput,
): VisualProcessSandboxProfile => {
  assertExactInputKeys(input);
  if (input.assignedHost !== VISUAL_LOOPBACK_HOST) {
    throw new VisualProcessSandboxError(
      "invalid_visual_endpoint",
      "The visual sandbox host must be literal 127.0.0.1.",
    );
  }
  if (!Number.isSafeInteger(input.assignedPort)
    || input.assignedPort < 1
    || input.assignedPort > 65_535) {
    throw new VisualProcessSandboxError(
      "invalid_visual_endpoint",
      "The server-assigned visual port is invalid.",
    );
  }
  const projectRoot = canonicalDirectory(input.projectRoot, "project root");
  const inputPath = canonicalFile(input.inputPath, "visual input");
  const outputRoot = canonicalDirectory(input.outputRoot, "output root");
  const scratchRoot = canonicalDirectory(input.scratchRoot, "scratch root");
  const tempRoot = canonicalDirectory(input.tempRoot, "temporary root");
  const launchReceiptPath = input.launchReceiptPath === undefined
    ? null
    : canonicalCreatableFile(input.launchReceiptPath, "launch receipt");
  assertSafeScratchLayout({
    projectRoot,
    inputPath,
    outputRoot,
    scratchRoot,
    tempRoot,
    launchReceiptPath,
  });
  const executable = canonicalRestrictedExecutable(input.executable);
  const runtimeReadRoots = canonicalRuntimeRoots(
    input.runtimeReadRoots,
    input.executable,
    executable,
  );
  const isolation: VisualSandboxIsolation = Object.freeze({
    kind: "macos-seatbelt-ipv4-port",
    assignedHost: VISUAL_LOOPBACK_HOST,
    assignedPort: input.assignedPort,
    outboundNetwork: "denied",
    endpointIsolation: "requires-os-listener-closed-set",
    requiresOsListenerClosedSet: true,
    limitation: "seatbelt-localhost-filter-allows-ipv4-wildcard",
  });
  const profile = sandboxProfile({
    projectRoot,
    inputPath,
    outputRoot,
    scratchRoot,
    tempRoot,
    launchReceiptPath,
    executable,
    runtimeReadRoots,
    assignedPort: input.assignedPort,
  });
  return Object.freeze({
    profile,
    projectRoot,
    inputPath,
    outputRoot,
    scratchRoot,
    tempRoot,
    launchReceiptPath,
    executable,
    runtimeReadRoots: Object.freeze(runtimeReadRoots),
    isolation,
  });
};

export const createVisualProcessSandboxLaunchSpec = (
  input: VisualProcessSandboxInput & Readonly<{
    childArgv: readonly string[];
    sandboxExecutable?: string;
  }>,
): VisualProcessSandboxLaunchSpec => {
  const profile = createVisualProcessSandboxProfile(input);
  const sandboxExecutable = canonicalRestrictedExecutable(
    input.sandboxExecutable ?? "/usr/bin/sandbox-exec",
  );
  if (!Array.isArray(input.childArgv)) {
    throw new VisualProcessSandboxError(
      "invalid_visual_argv",
      "Visual process arguments are invalid.",
    );
  }
  const childArgv = input.childArgv.map((argument) => {
    if (typeof argument !== "string"
      || argument.includes("\0")
      || argument.length > 8_192) {
      throw new VisualProcessSandboxError(
        "invalid_visual_argv",
        "A visual process argument is invalid.",
      );
    }
    return argument;
  });
  if (childArgv.length > 128) {
    throw new VisualProcessSandboxError(
      "invalid_visual_argv",
      "The visual process has too many arguments.",
    );
  }
  if (childArgv.some((argument) =>
    argument === "--"
    || argument === "--riff-host"
    || argument === "--riff-port"
    || argument.startsWith("--riff-host=")
    || argument.startsWith("--riff-port="))) {
    throw new VisualProcessSandboxError(
      "invalid_visual_argv",
      "Visual host and port arguments are server-owned.",
    );
  }
  return Object.freeze({
    ...profile,
    sandboxExecutable,
    argv: Object.freeze([
      "-p",
      profile.profile,
      profile.executable,
      ...childArgv,
      "--riff-host",
      profile.isolation.assignedHost,
      "--riff-port",
      String(profile.isolation.assignedPort),
    ]),
    cwd: profile.projectRoot,
  });
};

const sandboxProfile = (input: Readonly<{
  projectRoot: string;
  inputPath: string;
  outputRoot: string;
  scratchRoot: string;
  tempRoot: string;
  launchReceiptPath: string | null;
  executable: string;
  runtimeReadRoots: readonly string[];
  assignedPort: number;
}>): string => {
  const executableTarget = realpathSync(input.executable);
  const versionedFramework = versionedPythonFrameworkRoot(executableTarget);
  const applePythonFramework =
    "/Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework";
  const applePython = executableTarget.startsWith(`${applePythonFramework}/`);
  const readableRoots = [...new Set([
    input.projectRoot,
    input.outputRoot,
    input.tempRoot,
    ...input.runtimeReadRoots,
  ])];
  const exactReadableFiles = [
    input.inputPath,
  ];
  const writableRoots = [...new Set([
    input.outputRoot,
    input.tempRoot,
  ])];
  const reads = [
    ...readableRoots.map((root) =>
      `(literal ${literal(root)}) (subpath ${literal(root)})`),
    ...exactReadableFiles.map((path) => `(literal ${literal(path)})`),
    `(literal ${literal(dirname(input.executable))})`,
    `(literal ${literal(dirname(executableTarget))})`,
  ].join(" ");
  const metadata = [...new Set([
    ...readableRoots,
    ...exactReadableFiles,
    ...writableRoots,
  ].flatMap(pathAncestors))]
    .map((path) => `(literal ${literal(path)})`)
    .join(" ");
  const writes = [
    ...writableRoots.map((root) =>
      `(literal ${literal(root)}) (subpath ${literal(root)})`),
  ].join(" ");
  const launchReceiptWrites = input.launchReceiptPath === null
    ? []
    : [
      `(allow file-write-create (literal ${literal(input.launchReceiptPath)}))`,
      `(allow file-write-data (literal ${literal(input.launchReceiptPath)}))`,
    ];
  return [
    "(version 1)",
    "(deny default)",
    "(allow process-fork)",
    `(allow process-exec (literal ${literal(input.executable)}) (literal ${literal(executableTarget)})${versionedFramework ? ` (subpath ${literal(versionedFramework)})` : ""}${applePython ? ` (subpath ${literal(applePythonFramework)})` : ""})`,
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    `(allow file-read-metadata ${reads} ${metadata} (subpath "/System") (subpath "/usr")${applePython ? ` (literal "/Library") (literal "/Library/Developer") (subpath "/Library/Developer/CommandLineTools")` : ""} (subpath "/private/var/db/timezone") (literal "/dev/null") (literal "/dev/urandom"))`,
    "(allow file-read-data (require-not (vnode-type REGULAR-FILE)))",
    `(allow file-read-data ${reads} (subpath "/System") (subpath "/usr/lib")${applePython ? ` (subpath "/Library/Developer/CommandLineTools")` : ""} (subpath "/private/var/db/timezone") (literal "/dev/null") (literal "/dev/urandom"))`,
    "(allow file-write-data (require-not (vnode-type REGULAR-FILE)))",
    `(allow file-read* ${reads} (subpath "/System") (subpath "/usr/lib")${applePython ? ` (subpath "/Library/Developer/CommandLineTools")` : ""} (subpath "/private/var/db/timezone") (literal "/dev/null") (literal "/dev/urandom"))`,
    `(allow file-write* ${writes} (literal "/dev/null"))`,
    ...launchReceiptWrites,
    `(allow network-bind (local tcp4 "localhost:${input.assignedPort}"))`,
    `(allow network-inbound (local tcp4 "localhost:${input.assignedPort}"))`,
    // No network-outbound rule is present. deny-default rejects connect(),
    // including live loopback services and direct connections that ignore proxy.
  ].join("\n");
};

const canonicalDirectory = (input: string, label: string): string => {
  const path = canonicalExisting(input, label);
  if (!statSync(path).isDirectory()) {
    throw new VisualProcessSandboxError(
      "invalid_visual_path",
      `The ${label} must be a directory.`,
    );
  }
  return path;
};

const canonicalFile = (input: string, label: string): string => {
  const path = canonicalExisting(input, label);
  if (!statSync(path).isFile()) {
    throw new VisualProcessSandboxError(
      "invalid_visual_path",
      `The ${label} must be a regular file.`,
    );
  }
  return path;
};

const canonicalCreatableFile = (input: string, label: string): string => {
  if (typeof input !== "string" || !input || input.includes("\0")) {
    throw new VisualProcessSandboxError(
      "invalid_visual_path",
      `The ${label} path is invalid.`,
    );
  }
  const leaf = basename(input);
  if (!leaf || leaf === "." || leaf === "..") {
    throw new VisualProcessSandboxError(
      "invalid_visual_path",
      `The ${label} leaf is invalid.`,
    );
  }
  const logical = resolve(input);
  const parent = canonicalDirectory(dirname(logical), `${label} parent`);
  const path = join(parent, basename(logical));
  try {
    lstatSync(path);
    throw new VisualProcessSandboxError(
      "invalid_visual_path",
      `The ${label} must not exist before launch.`,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return path;
};

const assertSafeScratchLayout = (input: Readonly<{
  projectRoot: string;
  inputPath: string;
  outputRoot: string;
  scratchRoot: string;
  tempRoot: string;
  launchReceiptPath: string | null;
}>): void => {
  const paths = [
    input.projectRoot,
    input.inputPath,
    input.outputRoot,
    input.tempRoot,
    ...(input.launchReceiptPath === null ? [] : [input.launchReceiptPath]),
  ];
  if (paths.some((path) => !isStrictlyWithin(input.scratchRoot, path))) {
    throw new VisualProcessSandboxError(
      "invalid_visual_path",
      "Visual process paths must remain below the assigned scratch root.",
    );
  }
  const writableRoots = [input.outputRoot, input.tempRoot];
  const protectedPaths = [
    input.projectRoot,
    input.inputPath,
    ...(input.launchReceiptPath === null ? [] : [input.launchReceiptPath]),
  ];
  if (pathsHaveOverlap(input.outputRoot, input.tempRoot)
    || writableRoots.some((writable) =>
      protectedPaths.some((protectedPath) => pathsHaveOverlap(writable, protectedPath)))
    || (input.launchReceiptPath !== null
      && (pathsHaveOverlap(input.projectRoot, input.launchReceiptPath)
        || input.inputPath === input.launchReceiptPath))) {
    throw new VisualProcessSandboxError(
      "invalid_visual_path",
      "Visual writable roots must not overlap protected visual inputs.",
    );
  }
};

const isStrictlyWithin = (root: string, candidate: string): boolean => {
  const child = relative(root, candidate);
  return child !== ""
    && child !== ".."
    && !child.startsWith(`..${sep}`)
    && !isAbsolute(child);
};

const pathsHaveOverlap = (left: string, right: string): boolean =>
  left === right || isStrictlyWithin(left, right) || isStrictlyWithin(right, left);

const canonicalExisting = (input: string, label: string): string => {
  if (typeof input !== "string" || !input || input.includes("\0")) {
    throw new VisualProcessSandboxError(
      "invalid_visual_path",
      `The ${label} path is invalid.`,
    );
  }
  try {
    return realpathSync(resolve(input));
  } catch (error) {
    throw new VisualProcessSandboxError(
      "invalid_visual_path",
      `The ${label} is unavailable.`,
      { cause: error },
    );
  }
};

const canonicalRuntimeRoots = (
  inputs: readonly string[],
  requestedExecutable: string,
  executable: string,
): string[] => {
  if (!Array.isArray(inputs) || inputs.length > 16) {
    throw new VisualProcessSandboxError(
      "invalid_runtime_root",
      "Visual runtime roots are invalid.",
    );
  }
  const trusted = new Set(
    trustedPythonRuntimeRoots(requestedExecutable, executable)
      .filter((root) => existsSync(root))
      .map((root) => realpathSync(root)),
  );
  const roots = [...new Set(inputs.map((root) =>
    canonicalDirectory(root, "runtime read root")))];
  if (roots.some((root) => !trusted.has(root))) {
    throw new VisualProcessSandboxError(
      "invalid_runtime_root",
      "Visual runtime roots must exactly match the selected Python runtime.",
    );
  }
  return roots;
};

const assertExactInputKeys = (input: VisualProcessSandboxInput): void => {
  const allowed = new Set([
    "projectRoot",
    "inputPath",
    "outputRoot",
    "scratchRoot",
    "tempRoot",
    "launchReceiptPath",
    "executable",
    "runtimeReadRoots",
    "assignedHost",
    "assignedPort",
    // createVisualProcessSandboxLaunchSpec passes these through.
    "childArgv",
    "sandboxExecutable",
  ]);
  if (!input || typeof input !== "object"
    || Object.keys(input).some((key) => !allowed.has(key))) {
    throw new VisualProcessSandboxError(
      "invalid_visual_sandbox_input",
      "The visual sandbox input contains unsupported fields.",
    );
  }
};

const literal = (value: string): string =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

const pathAncestors = (value: string): string[] => {
  const ancestors: string[] = [];
  let cursor = dirname(value);
  while (cursor !== "/" && cursor !== ".") {
    ancestors.push(cursor);
    cursor = dirname(cursor);
  }
  return ancestors;
};

const versionedPythonFrameworkRoot = (value: string): string | null => {
  const match = /^(.*\/Python\.framework\/Versions\/[^/]+)(?:\/|$)/u.exec(value);
  return match?.[1] ?? null;
};
