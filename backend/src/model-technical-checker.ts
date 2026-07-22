import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  assertLogicalWorkspacePath,
  captureWorkspaceDigest,
  executionDescriptionDigest,
  validateExecutionDescription,
  type GenericExecutionDescription,
  type WorkspaceDigestSnapshot,
} from "./model-workspace.ts";
import {
  createModelWorkspaceCapability,
  RestrictedProcessRunner,
  type ModelWorkspaceCapability,
  type RestrictedProcessResult,
} from "./restricted-process.ts";

export type TechnicalCheckName = "path" | "syntax" | "interface" | "dependency" | "smoke" | "output" | "resource" | "cancellation" | "visual_health";
export type TechnicalCheckState = "passed" | "failed" | "skipped" | "cancelled";
export type TechnicalCheckItem = Readonly<{
  name: TechnicalCheckName;
  state: TechnicalCheckState;
  code: string;
  detail: string;
}>;

export type ModelTechnicalCheckResult = Readonly<{
  attemptId: string;
  aggregate: "executable" | "failed" | "cancelled";
  capturedWorkspaceDigest: string;
  executionDescriptionDigest: string;
  dependencyDescriptionDigest: string;
  environmentKey: string;
  startedAt: string;
  finishedAt: string;
  limits: Readonly<{ timeoutMs: number; maxOutputBytes: number; maxWorkspaceFiles: number; maxWorkspaceBytes: number }>;
  checks: readonly TechnicalCheckItem[];
  log: string;
}>;

export type TechnicalCheckPhase = "syntax" | "dependency" | "smoke" | "cancellation" | "visual_health";

export type TechnicalCheckExecutor = (input: Readonly<{
  phase: TechnicalCheckPhase;
  workspace: ModelWorkspaceCapability;
  executable: string;
  argv: readonly string[];
  stdin?: string;
  signal?: AbortSignal;
  timeoutMs: number;
  maxOutputBytes: number;
}>) => Promise<RestrictedProcessResult>;

export type ModelTechnicalCheckerOptions = Readonly<{
  pythonExecutable: string;
  executor?: TechnicalCheckExecutor;
  now?: () => Date;
  idFactory?: () => string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  maxWorkspaceFiles?: number;
  maxWorkspaceBytes?: number;
  cancellationProbeDelayMs?: number;
}>;

export type ModelTechnicalCheckInput = Readonly<{
  workspace: ModelWorkspaceCapability;
  executionDescription: unknown;
  signal?: AbortSignal;
}>;

const PYTHON_SYNTAX_SCRIPT = `import json,py_compile,sys\nfor p in json.load(sys.stdin): py_compile.compile(p,doraise=True)\n`;
const PYTHON_DEPENDENCY_SCRIPT = `import importlib.util,json,sys\nnames=json.load(sys.stdin)\nmissing=[name for name in names if importlib.util.find_spec(name) is None]\nprint(json.dumps({"missing":missing},sort_keys=True,separators=(",",":")))\nraise SystemExit(1 if missing else 0)\n`;

export class ModelTechnicalChecker {
  readonly #python: string;
  readonly #executor: TechnicalCheckExecutor;
  readonly #now: () => Date;
  readonly #idFactory: () => string;
  readonly #limits: { timeoutMs: number; maxOutputBytes: number; maxWorkspaceFiles: number; maxWorkspaceBytes: number };
  readonly #cancellationProbeDelayMs: number;

  constructor(options: ModelTechnicalCheckerOptions) {
    this.#python = options.pythonExecutable;
    this.#executor = options.executor ?? defaultExecutor;
    this.#now = options.now ?? (() => new Date());
    this.#idFactory = options.idFactory ?? (() => `check_${randomUUID().replaceAll("-", "")}`);
    this.#limits = Object.freeze({
      timeoutMs: integerLimit(options.timeoutMs ?? 15_000, 1, 300_000, "timeout"),
      maxOutputBytes: integerLimit(options.maxOutputBytes ?? 256 * 1024, 1, 16 * 1024 * 1024, "output"),
      maxWorkspaceFiles: integerLimit(options.maxWorkspaceFiles ?? 512, 1, 10_000, "file count"),
      maxWorkspaceBytes: integerLimit(options.maxWorkspaceBytes ?? 64 * 1024 * 1024, 1, 512 * 1024 * 1024, "workspace bytes"),
    });
    this.#cancellationProbeDelayMs = integerLimit(options.cancellationProbeDelayMs ?? 200, 1, 5_000, "cancellation delay");
  }

  /**
   * Runs checks against a private copy and returns immutable evidence. It has
   * no ProductStore dependency and cannot publish technical status itself.
   */
  async check(input: ModelTechnicalCheckInput): Promise<ModelTechnicalCheckResult> {
    const startedAt = this.#now().toISOString();
    const attemptId = this.#idFactory();
    const checks: TechnicalCheckItem[] = [];
    let snapshot: WorkspaceDigestSnapshot;
    let description: GenericExecutionDescription;
    let descriptionDigest = "";
    let dependencyDigest = "";
    let environmentKey = "";
    let staging: string | undefined;
    const logs: string[] = [];
    let aggregate: ModelTechnicalCheckResult["aggregate"] = "failed";

    try {
      if (input.signal?.aborted) throw cancelledError();
      snapshot = captureWorkspaceDigest(input.workspace, { maxFiles: this.#limits.maxWorkspaceFiles, maxTotalBytes: this.#limits.maxWorkspaceBytes });
      checks.push(pass("path", "workspace_digest_captured", `${snapshot.fileCount} regular files captured.`));
      description = validateExecutionDescription(input.executionDescription);
      descriptionDigest = executionDescriptionDigest(description);
      checks.push(pass("interface", "execution_description_valid", "The thin execution description is valid."));
      const required = [description.entryPoint, description.dependencyFile];
      for (const path of required) if (!snapshot.files.some((file) => file.relativePath === path)) throw checkFailure("declared_file_missing", `Declared file ${path} is missing.`);

      const dependencyBytes = readFileSync(resolveOwned(input.workspace.root, description.dependencyFile));
      dependencyDigest = sha256Hex(dependencyBytes);
      environmentKey = `python-${dependencyDigest}`;
      const dependencies = parseDependencyImports(dependencyBytes.toString("utf8"));

      staging = mkdtempSync(join(tmpdir(), "riff-model-check-"));
      for (const file of snapshot.files) {
        const target = resolve(staging, file.relativePath);
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
        copyFileSync(resolveOwned(input.workspace.root, file.relativePath), target);
      }
      const checkWorkspace = createModelWorkspaceCapability(staging, `${input.workspace.capabilityId}:${attemptId}`);
      const pythonFiles = snapshot.files.filter((file) => file.relativePath.startsWith("code/") && file.relativePath.endsWith(".py")).map((file) => file.relativePath);
      if (!pythonFiles.length) throw checkFailure("python_source_missing", "The Model workspace has no declared Python source.");

      const syntax = await this.#execute("syntax", checkWorkspace, ["-I", "-c", PYTHON_SYNTAX_SCRIPT], JSON.stringify(pythonFiles), input.signal);
      recordProcess(logs, "syntax", syntax);
      if (!succeeded(syntax)) throw processFailure("syntax_failed", "Python syntax validation failed.", syntax);
      checks.push(pass("syntax", "python_syntax_valid", `${pythonFiles.length} Python files compiled.`));

      const dependency = await this.#execute("dependency", checkWorkspace, ["-I", "-c", PYTHON_DEPENDENCY_SCRIPT], JSON.stringify(dependencies), input.signal);
      recordProcess(logs, "dependency", dependency);
      if (!succeeded(dependency)) throw processFailure("dependency_unavailable", "The isolated interpreter cannot resolve all declared dependencies.", dependency);
      checks.push(pass("dependency", "dependencies_resolved", `${dependencies.length} dependency imports resolved in environment ${environmentKey}.`));

      const smoke = await this.#execute("smoke", checkWorkspace, ["-I", description.entryPoint, "--riff-smoke"], JSON.stringify(description.inputs.smoke), input.signal);
      recordProcess(logs, "smoke", smoke);
      if (!succeeded(smoke)) throw processFailure("smoke_failed", "The bounded Model smoke execution failed.", smoke);
      checks.push(pass("smoke", "smoke_passed", "The bounded smoke process completed."));
      checks.push(pass("resource", "resource_limits_respected", "The smoke process stayed within time and output limits."));

      for (const output of description.outputs) {
        const path = resolveOwned(checkWorkspace.root, output.relativePath);
        if (output.required && (!statSafe(path)?.isFile())) throw checkFailure("required_output_missing", `Required output ${output.logicalName} was not created.`);
        if (statSafe(path)?.isFile() && statSync(path).size > this.#limits.maxWorkspaceBytes) throw checkFailure("output_too_large", `Output ${output.logicalName} exceeds its bound.`);
      }
      checks.push(pass("output", "declared_outputs_valid", "Required declared outputs were created inside the check workspace."));

      const cancellationController = new AbortController();
      const forwardAbort = (): void => cancellationController.abort();
      input.signal?.addEventListener("abort", forwardAbort, { once: true });
      const cancelTimer = setTimeout(() => cancellationController.abort(), this.#cancellationProbeDelayMs);
      cancelTimer.unref?.();
      const cancellation = await this.#execute("cancellation", checkWorkspace, ["-I", description.entryPoint, "--riff-cancellation-probe"], undefined, cancellationController.signal);
      clearTimeout(cancelTimer);
      input.signal?.removeEventListener("abort", forwardAbort);
      recordProcess(logs, "cancellation", cancellation);
      if (input.signal?.aborted) throw cancelledError();
      if (!cancellation.cancelled || cancellation.timedOut || cancellation.outputLimitExceeded) throw checkFailure("cancellation_failed", "The Model did not terminate through the bounded cancellation path.");
      checks.push(pass("cancellation", "cancellation_passed", "The separate process was cancelled and cleaned up."));

      if (description.runMode === "visual" || description.runMode === "both") {
        const visual = description.visual!;
        const health = await this.#execute("visual_health", checkWorkspace, ["-I", visual.entryPoint, "--riff-health-check", visual.healthPath], undefined, input.signal);
        recordProcess(logs, "visual_health", health);
        if (!succeeded(health)) throw processFailure("visual_health_failed", "The visual entry point did not pass local health inspection.", health);
        checks.push(pass("visual_health", "visual_health_passed", "The declared visual entry point passed its local health check."));
      } else {
        checks.push(Object.freeze({ name: "visual_health", state: "skipped", code: "batch_only", detail: "The Model does not declare visual capability." }));
      }
      aggregate = "executable";
    } catch (error) {
      const cancelled = input.signal?.aborted || isCancelled(error);
      aggregate = cancelled ? "cancelled" : "failed";
      const name = inferredFailedCheck(checks);
      checks.push(Object.freeze({ name, state: cancelled ? "cancelled" : "failed", code: boundedCode(error), detail: boundedMessage(error) }));
    } finally {
      if (staging) rmSync(staging, { recursive: true, force: true });
    }

    return Object.freeze({
      attemptId,
      aggregate,
      capturedWorkspaceDigest: snapshot?.digest ?? "",
      executionDescriptionDigest: descriptionDigest,
      dependencyDescriptionDigest: dependencyDigest,
      environmentKey,
      startedAt,
      finishedAt: this.#now().toISOString(),
      limits: this.#limits,
      checks: Object.freeze(checks),
      log: boundLog(logs.join("\n"), this.#limits.maxOutputBytes),
    });
  }

  #execute(phase: TechnicalCheckPhase, workspace: ModelWorkspaceCapability, argv: readonly string[], stdin: string | undefined, signal: AbortSignal | undefined): Promise<RestrictedProcessResult> {
    return this.#executor({ phase, workspace, executable: this.#python, argv, stdin, signal, timeoutMs: this.#limits.timeoutMs, maxOutputBytes: this.#limits.maxOutputBytes });
  }
}

const defaultExecutor: TechnicalCheckExecutor = ({ workspace, executable, argv, stdin, signal, timeoutMs, maxOutputBytes }) => new RestrictedProcessRunner({
  workspace,
  command: { executable, argv },
  limits: { timeoutMs, maxOutputBytes },
}).run({ ...(stdin === undefined ? {} : { stdin }), ...(signal ? { signal } : {}) });

const parseDependencyImports = (source: string): string[] => {
  const imports = new Set<string>();
  for (const [index, raw] of source.split(/\r?\n/u).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("-") || line.includes("/") || line.includes("\\") || line.includes("://") || line.includes("@")) throw checkFailure("dependency_description_unsafe", `Dependency line ${index + 1} is not an offline package declaration.`);
    const match = /^([A-Za-z0-9][A-Za-z0-9_.-]*)(?:\[[A-Za-z0-9_,.-]+\])?(?:\s*(?:===|==|~=|!=|<=|>=|<|>)[^;\s]+)*(?:\s*;.*)?$/u.exec(line);
    if (!match) throw checkFailure("dependency_description_invalid", `Dependency line ${index + 1} is invalid.`);
    imports.add(match[1]!.replaceAll("-", "_").toLowerCase());
  }
  if (!imports.size) throw checkFailure("dependency_description_empty", "At least one declared dependency is required.");
  return [...imports].sort();
};

const resolveOwned = (root: string, logical: string): string => {
  assertLogicalWorkspacePath(logical);
  const target = resolve(root, logical);
  if (!target.startsWith(`${root}/`)) throw checkFailure("path_escape", "A declared path escaped the Model workspace.");
  return target;
};

const succeeded = (result: RestrictedProcessResult): boolean => result.exitCode === 0 && !result.signal && !result.timedOut && !result.cancelled && !result.outputLimitExceeded;
const pass = (name: TechnicalCheckName, code: string, detail: string): TechnicalCheckItem => Object.freeze({ name, state: "passed", code, detail });
const recordProcess = (logs: string[], phase: string, result: RestrictedProcessResult): void => { logs.push(`[${phase}] exit=${result.exitCode ?? "null"} signal=${result.signal ?? "none"} duration_ms=${result.durationMs}\n${result.stdout}\n${result.stderr}`); };
const statSafe = (path: string) => { try { return statSync(path); } catch { return undefined; } };
const boundLog = (value: string, limit: number): string => redact(value).slice(0, limit);
const redact = (value: string): string => value
  .replace(/(?:sk|rk|api)[-_][A-Za-z0-9]{8,}/giu, "[redacted]")
  .replace(/(?:\/Users\/|\/home\/)[^\s)]+/gu, "[local path]");
const processFailure = (code: string, message: string, result: RestrictedProcessResult): Error & { code: string } => checkFailure(result.timedOut ? "process_timeout" : result.outputLimitExceeded ? "process_output_limit" : result.cancelled ? "process_cancelled" : code, message);
const checkFailure = (code: string, message: string): Error & { code: string } => Object.assign(new Error(message), { code });
const cancelledError = (): Error & { code: string } => checkFailure("check_cancelled", "The technical check was cancelled.");
const isCancelled = (error: unknown): boolean => Boolean(error && typeof error === "object" && (error as any).code === "check_cancelled");
const boundedCode = (error: unknown): string => error && typeof error === "object" && typeof (error as any).code === "string" ? String((error as any).code).slice(0, 100) : "technical_check_failed";
const boundedMessage = (error: unknown): string => redact(error instanceof Error ? error.message : "The technical check failed.").slice(0, 500);
const inferredFailedCheck = (checks: readonly TechnicalCheckItem[]): TechnicalCheckName => {
  const passed = new Set(checks.filter((item) => item.state === "passed").map((item) => item.name));
  return (["path", "interface", "syntax", "dependency", "smoke", "resource", "output", "cancellation", "visual_health"] as TechnicalCheckName[]).find((name) => !passed.has(name)) ?? "interface";
};
const integerLimit = (value: number, min: number, max: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid technical-check ${label} limit.`);
  return value;
};
const sha256Hex = (bytes: Uint8Array): string => {
  return createHash("sha256").update(bytes).digest("hex");
};
