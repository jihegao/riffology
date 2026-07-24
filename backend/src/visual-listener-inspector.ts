import { spawnSync } from "node:child_process";
import { createServer } from "node:net";

export type VisualListenerInspectionInput = Readonly<{
  runId: string;
  processAttemptId: string;
  pid: number;
  processStartToken: string;
  processGroupId: number;
  assignedPort: number;
}>;

export type VisualListenerInspectionCode =
  | "visual_listener_missing"
  | "visual_listener_wildcard"
  | "visual_listener_wrong_port"
  | "visual_listener_extra_ipv4"
  | "visual_listener_ipv6"
  | "visual_listener_foreign_owner"
  | "visual_listener_ambiguous"
  | "visual_listener_parser_failure"
  | "visual_listener_tool_failure"
  | "visual_listener_identity_mismatch"
  | "visual_listener_platform_unsupported"
  | "visual_listener_invalid_input";

export class VisualListenerInspectionError extends Error {
  readonly code: VisualListenerInspectionCode;

  constructor(code: VisualListenerInspectionCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "VisualListenerInspectionError";
    this.code = code;
  }
}

type CommandResult = Readonly<{
  status: number | null;
  stdout: string;
  stderr: string;
}>;

export type VisualListenerInspectorDependencies = Readonly<{
  platform?: NodeJS.Platform;
  runCommand?: (file: string, args: readonly string[]) => CommandResult;
}>;

export type VisualListenerReady = Readonly<{ kind: "ready" }>;

type ProcessIdentity = Readonly<{
  pid: number;
  processGroupId: number;
  startToken: string;
}>;

type Listener = Readonly<{
  pid: number;
  family: "ipv4" | "ipv6" | "wildcard";
  host: string;
  port: number;
}>;

const ERROR_MESSAGES: Readonly<Record<VisualListenerInspectionCode, string>> = Object.freeze({
  visual_listener_missing: "The expected visual listener is not present.",
  visual_listener_wildcard: "The visual process group has a wildcard listener.",
  visual_listener_wrong_port: "The visual process group is listening on a different endpoint.",
  visual_listener_extra_ipv4: "The visual process group has an additional IPv4 listener.",
  visual_listener_ipv6: "The visual process group has an IPv6 listener.",
  visual_listener_foreign_owner: "The assigned visual endpoint is owned by another process group.",
  visual_listener_ambiguous: "The visual listener ownership observation is ambiguous.",
  visual_listener_parser_failure: "The operating-system listener evidence could not be parsed.",
  visual_listener_tool_failure: "The operating-system listener evidence could not be read.",
  visual_listener_identity_mismatch: "The recorded visual process identity is no longer current.",
  visual_listener_platform_unsupported: "Exact visual listener inspection is unavailable on this platform.",
  visual_listener_invalid_input: "The recorded visual listener identity is invalid.",
});

const READY: VisualListenerReady = Object.freeze({ kind: "ready" });

/**
 * Chooses a server-owned candidate by binding literal IPv4 loopback to port 0,
 * reading the kernel assignment, and closing immediately.
 *
 * The returned port is deliberately not a reservation. The caller must treat
 * the close-to-child-bind interval as a bounded TOCTOU window and revalidate
 * exact listener ownership with inspectVisualListener.
 */
export const selectVisualLoopbackPort = async (): Promise<number> =>
  await new Promise<number>((resolvePort, rejectPort) => {
    const server = createServer();
    let settled = false;
    const rejectOnce = (error: Error): void => {
      if (settled) return;
      settled = true;
      rejectPort(error);
    };
    server.once("error", rejectOnce);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      const address = server.address();
      if (!address || typeof address === "string"
        || address.address !== "127.0.0.1"
        || !Number.isSafeInteger(address.port)
        || address.port < 1
        || address.port > 65_535) {
        server.close(() => rejectOnce(new Error("Visual loopback port selection failed.")));
        return;
      }
      const selectedPort = address.port;
      server.close((error) => {
        if (error) {
          rejectOnce(new Error("Visual loopback port selection failed."));
          return;
        }
        if (settled) return;
        settled = true;
        resolvePort(selectedPort);
      });
    });
  });

/**
 * Reads process and TCP LISTEN state only. It does not connect to the endpoint,
 * issue HTTP, or return observed addresses/ports to its caller.
 */
export const inspectVisualListener = (
  input: VisualListenerInspectionInput,
  dependencies: VisualListenerInspectorDependencies = {},
): VisualListenerReady => {
  assertInput(input);
  if ((dependencies.platform ?? process.platform) !== "darwin") {
    throw new VisualListenerInspectionError("visual_listener_platform_unsupported");
  }
  const runCommand = dependencies.runCommand ?? defaultRunCommand;
  const firstProcesses = readProcesses(runCommand);
  const firstGroup = exactProcessGroup(firstProcesses, input);
  const listeners = readListeners(runCommand);
  const secondProcesses = readProcesses(runCommand);
  const secondGroup = exactProcessGroup(secondProcesses, input);
  if (identityKey(firstGroup) !== identityKey(secondGroup)) {
    throw new VisualListenerInspectionError("visual_listener_ambiguous");
  }

  const groupPids = new Set(secondGroup.map((member) => member.pid));
  const groupListeners = listeners.filter((listener) => groupPids.has(listener.pid));
  const assignedListeners = listeners.filter((listener) => listener.port === input.assignedPort);
  const expected = assignedListeners.filter((listener) =>
    groupPids.has(listener.pid)
    && listener.family === "ipv4"
    && listener.host === "127.0.0.1");
  const foreignAssigned = assignedListeners.filter((listener) => !groupPids.has(listener.pid));

  if (groupListeners.some((listener) => listener.family === "wildcard")) {
    throw new VisualListenerInspectionError("visual_listener_wildcard");
  }
  if (groupListeners.some((listener) => listener.family === "ipv6")) {
    throw new VisualListenerInspectionError("visual_listener_ipv6");
  }
  if (expected.length > 1 || (expected.length === 1 && foreignAssigned.length > 0)) {
    throw new VisualListenerInspectionError("visual_listener_ambiguous");
  }
  if (expected.length === 0 && foreignAssigned.length > 0) {
    throw new VisualListenerInspectionError("visual_listener_foreign_owner");
  }

  const nonLoopbackIpv4 = groupListeners.filter((listener) =>
    listener.family === "ipv4" && listener.host !== "127.0.0.1");
  if (nonLoopbackIpv4.length > 0) {
    throw new VisualListenerInspectionError("visual_listener_extra_ipv4");
  }
  const otherGroupIpv4 = groupListeners.filter((listener) =>
    listener.family === "ipv4"
    && (listener.host !== "127.0.0.1" || listener.port !== input.assignedPort));
  if (expected.length === 1 && otherGroupIpv4.length > 0) {
    throw new VisualListenerInspectionError("visual_listener_extra_ipv4");
  }
  if (expected.length === 0
    && groupListeners.some((listener) =>
      listener.family === "ipv4" && listener.host === "127.0.0.1")) {
    throw new VisualListenerInspectionError("visual_listener_wrong_port");
  }
  if (expected.length === 0) {
    throw new VisualListenerInspectionError("visual_listener_missing");
  }
  if (groupListeners.length !== 1) {
    throw new VisualListenerInspectionError("visual_listener_ambiguous");
  }
  return READY;
};

const assertInput = (input: VisualListenerInspectionInput): void => {
  if (!input || typeof input !== "object"
    || typeof input.runId !== "string" || input.runId.length < 3 || input.runId.length > 128
    || typeof input.processAttemptId !== "string"
    || input.processAttemptId.length < 3 || input.processAttemptId.length > 128
    || !Number.isSafeInteger(input.pid) || input.pid < 1
    || typeof input.processStartToken !== "string"
    || input.processStartToken.length < 1 || input.processStartToken.length > 300
    || !Number.isSafeInteger(input.processGroupId) || input.processGroupId < 1
    || !Number.isSafeInteger(input.assignedPort)
    || input.assignedPort < 1 || input.assignedPort > 65_535) {
    throw new VisualListenerInspectionError("visual_listener_invalid_input");
  }
};

const defaultRunCommand = (file: string, args: readonly string[]): CommandResult => {
  const result = spawnSync(file, [...args], {
    encoding: "utf8",
    timeout: 1_000,
    maxBuffer: 4 * 1_024 * 1_024,
    env: { LANG: "C", LC_ALL: "C" },
  });
  return Object.freeze({
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  });
};

const readProcesses = (
  runCommand: NonNullable<VisualListenerInspectorDependencies["runCommand"]>,
): readonly ProcessIdentity[] => {
  let result: CommandResult;
  try {
    result = runCommand("/bin/ps", ["-axo", "pid=", "-o", "pgid=", "-o", "lstart="]);
  } catch {
    throw new VisualListenerInspectionError("visual_listener_tool_failure");
  }
  if (result.status !== 0) {
    throw new VisualListenerInspectionError("visual_listener_tool_failure");
  }
  const processes: ProcessIdentity[] = [];
  const seen = new Set<number>();
  for (const line of result.stdout.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/u.exec(line);
    if (!match) throw new VisualListenerInspectionError("visual_listener_parser_failure");
    const pid = Number(match[1]);
    const processGroupId = Number(match[2]);
    const startToken = match[3]!;
    if (!Number.isSafeInteger(pid) || pid < 1
      || !Number.isSafeInteger(processGroupId) || processGroupId < 1
      || !startToken || seen.has(pid)) {
      throw new VisualListenerInspectionError("visual_listener_parser_failure");
    }
    seen.add(pid);
    processes.push(Object.freeze({ pid, processGroupId, startToken }));
  }
  return Object.freeze(processes.sort((left, right) => left.pid - right.pid));
};

const exactProcessGroup = (
  processes: readonly ProcessIdentity[],
  input: VisualListenerInspectionInput,
): readonly ProcessIdentity[] => {
  const target = processes.find((candidate) => candidate.pid === input.pid);
  if (!target
    || target.processGroupId !== input.processGroupId
    || target.startToken !== input.processStartToken) {
    throw new VisualListenerInspectionError("visual_listener_identity_mismatch");
  }
  const members = processes.filter((candidate) =>
    candidate.processGroupId === input.processGroupId);
  if (members.length === 0) {
    throw new VisualListenerInspectionError("visual_listener_identity_mismatch");
  }
  return members;
};

const identityKey = (members: readonly ProcessIdentity[]): string =>
  members.map((member) =>
    `${member.pid}\u0000${member.processGroupId}\u0000${member.startToken}`).join("\u0001");

const readListeners = (
  runCommand: NonNullable<VisualListenerInspectorDependencies["runCommand"]>,
): readonly Listener[] => {
  let result: CommandResult;
  try {
    result = runCommand(
      "/usr/sbin/lsof",
      ["-nP", "-iTCP", "-sTCP:LISTEN", "-F0pn"],
    );
  } catch {
    throw new VisualListenerInspectionError("visual_listener_tool_failure");
  }
  const emptyResult = result.status === 1
    && result.stdout.trim() === ""
    && result.stderr.trim() === "";
  if (result.status !== 0 && !emptyResult) {
    throw new VisualListenerInspectionError("visual_listener_tool_failure");
  }
  if (!result.stdout.trim()) return Object.freeze([]);

  const listeners: Listener[] = [];
  let currentPid: number | null = null;
  for (const token of result.stdout.split(/[\0\r\n]+/u)) {
    if (!token) continue;
    const tag = token[0];
    const value = token.slice(1);
    if (tag === "p") {
      const pid = Number(value);
      if (!/^\d+$/u.test(value) || !Number.isSafeInteger(pid) || pid < 1) {
        throw new VisualListenerInspectionError("visual_listener_parser_failure");
      }
      currentPid = pid;
      continue;
    }
    if (tag === "f" && currentPid !== null && /^\d+$/u.test(value)) {
      continue;
    }
    if (tag !== "n" || currentPid === null) {
      throw new VisualListenerInspectionError("visual_listener_parser_failure");
    }
    listeners.push(parseListener(currentPid, value));
  }
  return Object.freeze(listeners);
};

const parseListener = (pid: number, value: string): Listener => {
  const ipv6 = /^\[([^\]]+)\]:(\d+)$/u.exec(value);
  if (ipv6) {
    return listener(pid, "ipv6", ipv6[1]!, ipv6[2]!);
  }
  const endpoint = /^([^:]+):(\d+)$/u.exec(value);
  if (!endpoint) {
    throw new VisualListenerInspectionError("visual_listener_parser_failure");
  }
  const host = endpoint[1]!;
  if (host === "*" || host === "0.0.0.0") {
    return listener(pid, "wildcard", host, endpoint[2]!);
  }
  if (!isIpv4(host)) {
    throw new VisualListenerInspectionError("visual_listener_parser_failure");
  }
  return listener(pid, "ipv4", host, endpoint[2]!);
};

const listener = (
  pid: number,
  family: Listener["family"],
  host: string,
  rawPort: string,
): Listener => {
  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new VisualListenerInspectionError("visual_listener_parser_failure");
  }
  return Object.freeze({ pid, family, host, port });
};

const isIpv4 = (host: string): boolean => {
  const parts = host.split(".");
  return parts.length === 4 && parts.every((part) =>
    /^\d{1,3}$/u.test(part) && Number(part) >= 0 && Number(part) <= 255);
};
