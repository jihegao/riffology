import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { validateBatchInputV1 } from "../src/execution-protocol-v2.ts";
import { captureWorkspaceDigest, createGenericModelScaffold, resolveModelWorkspace } from "../src/model-workspace.ts";
import { ModelTechnicalChecker, type TechnicalCheckExecutor } from "../src/model-technical-checker.ts";
import type { RestrictedProcessResult } from "../src/restricted-process.ts";

const ok = (overrides: Partial<RestrictedProcessResult> = {}): RestrictedProcessResult => ({ exitCode: 0, signal: null, stdout: "", stderr: "", durationMs: 1, timedOut: false, cancelled: false, outputLimitExceeded: false, ...overrides });
const writeDeclaredSmokeOutput = (input: Parameters<TechnicalCheckExecutor>[0]): void => {
  const marker = input.argv.indexOf("--riff-output-dir");
  assert.notEqual(marker, -1, "smoke argv must carry the riff-batch-v1 output directory");
  const outputDirectory = input.argv[marker + 1]!;
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(join(outputDirectory, "summary.json"), "{}\n");
};
const materializeScaffold = (root: string, modelId: string) => {
  const scaffold = createGenericModelScaffold(modelId);
  for (const file of scaffold.files) {
    const prefix = file.kind === "model_code" ? "code" : file.kind === "model_environment" ? "environment" : "visuals";
    const target = join(root, prefix, file.relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.bytes);
  }
  return scaffold;
};

test("technical checker returns digest-bound executable evidence and never publishes to a store", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "riff-check-pass-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scaffold = materializeScaffold(root, "model_check_pass");
  const phases: string[] = [];
  let smokeArgv: readonly string[] = [];
  const executor: TechnicalCheckExecutor = async (input) => {
    phases.push(input.phase);
    if (input.phase === "smoke") {
      smokeArgv = input.argv;
      const marker = input.argv.indexOf("--riff-input");
      assert.notEqual(marker, -1);
      const envelope = validateBatchInputV1(JSON.parse(readFileSync(input.argv[marker + 1]!, "utf8")));
      assert.match(envelope.sampleId, /^[0-9a-f]{64}$/u);
      assert.deepEqual({
        ...envelope,
        sampleId: "<digest>",
        parameters: { ...envelope.parameters },
      }, {
        schemaVersion: 1,
        runId: "technical_check",
        sampleIndex: 0,
        sampleId: "<digest>",
        parameters: { stepLimit: 2, demand: 1 },
        seed: null,
      });
      writeDeclaredSmokeOutput(input);
    }
    if (input.phase === "cancellation") return ok({ exitCode: null, signal: "SIGTERM", cancelled: true });
    return ok({ stdout: input.phase === "dependency" ? '{"missing":[]}\n' : "" });
  };
  const checker = new ModelTechnicalChecker({ pythonExecutable: "/usr/bin/python3", executor, idFactory: () => "check_one", now: () => new Date("2026-07-22T00:00:00.000Z"), cancellationProbeDelayMs: 1 });
  const capability = resolveModelWorkspace(root, "model_check_pass");
  const before = captureWorkspaceDigest(capability);
  const result = await checker.check({ workspace: capability, executionDescription: scaffold.executionDescription });
  assert.equal(result.aggregate, "executable");
  assert.equal(result.capturedWorkspaceDigest, before.digest);
  assert.match(result.executionDescriptionDigest, /^[0-9a-f]{64}$/u);
  assert.match(result.dependencyDescriptionDigest, /^[0-9a-f]{64}$/u);
  assert.match(result.environmentKey, /^python-[0-9a-f]{64}$/u);
  assert.deepEqual(phases, ["syntax", "dependency", "smoke", "cancellation"]);
  assert.equal(smokeArgv.includes("--riff-input"), true);
  assert.equal(smokeArgv.includes("--riff-output-dir"), true);
  assert.equal(result.checks.find((item) => item.name === "smoke")?.code, "smoke_passed");
  assert.equal(captureWorkspaceDigest(capability).digest, before.digest, "checks run only against a disposable private copy");
  assert.equal((result as any).scientificallyValid, undefined);
});

test("workspace drift produces a different captured digest for a later check", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "riff-check-drift-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scaffold = materializeScaffold(root, "model_check_drift");
  const executor: TechnicalCheckExecutor = async (input) => {
    if (input.phase === "smoke") writeDeclaredSmokeOutput(input);
    return input.phase === "cancellation" ? ok({ exitCode: null, signal: "SIGTERM", cancelled: true }) : ok();
  };
  const checker = new ModelTechnicalChecker({ pythonExecutable: "/usr/bin/python3", executor, cancellationProbeDelayMs: 1 });
  const workspace = resolveModelWorkspace(root, "model_check_drift");
  const first = await checker.check({ workspace, executionDescription: scaffold.executionDescription });
  writeFileSync(join(root, "code/model.py"), "# changed\n");
  const second = await checker.check({ workspace, executionDescription: scaffold.executionDescription });
  assert.notEqual(first.capturedWorkspaceDigest, second.capturedWorkspaceDigest);
  assert.equal(first.aggregate, "executable");
  assert.equal(second.aggregate, "executable");
});

test("syntax, dependency, output, resource and cancellation failures stay bounded", async (t) => {
  const cases = [
    ["syntax", ok({ exitCode: 1, stderr: "/Users/private/model.py api-secret123456" }), "syntax_failed"],
    ["dependency", ok({ exitCode: 1 }), "dependency_unavailable"],
    ["smoke", ok({ timedOut: true, exitCode: null }), "process_timeout"],
    ["cancellation", ok(), "cancellation_failed"],
  ] as const;
  for (const [failedPhase, failure, code] of cases) {
    const root = mkdtempSync(join(tmpdir(), `riff-check-${failedPhase}-`));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const scaffold = materializeScaffold(root, `model_${failedPhase}`);
    const executor: TechnicalCheckExecutor = async (input) => {
      if (input.phase === "smoke" && failedPhase !== "smoke") writeDeclaredSmokeOutput(input);
      if (input.phase === failedPhase) return failure;
      return input.phase === "cancellation" ? ok({ exitCode: null, signal: "SIGTERM", cancelled: true }) : ok();
    };
    const result = await new ModelTechnicalChecker({ pythonExecutable: "/usr/bin/python3", executor, cancellationProbeDelayMs: 1 }).check({ workspace: resolveModelWorkspace(root, `model_${failedPhase}`), executionDescription: scaffold.executionDescription });
    assert.equal(result.aggregate, "failed", failedPhase);
    assert.equal(result.checks.at(-1)?.code, code, failedPhase);
    assert.doesNotMatch(result.log, /Users\/private|api-secret/iu);
  }
});

test("unsafe dependency sources and caller cancellation fail closed", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "riff-check-unsafe-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scaffold = materializeScaffold(root, "model_unsafe_dependency");
  writeFileSync(join(root, "environment/requirements.txt"), "mesa @ https://example.invalid/package.whl\n");
  let calls = 0;
  const checker = new ModelTechnicalChecker({ pythonExecutable: "/usr/bin/python3", executor: async () => { calls += 1; return ok(); } });
  const unsafe = await checker.check({ workspace: resolveModelWorkspace(root, "model_unsafe_dependency"), executionDescription: scaffold.executionDescription });
  assert.equal(unsafe.aggregate, "failed");
  assert.equal(unsafe.checks.at(-1)?.code, "dependency_description_unsafe");
  assert.equal(calls, 0);
  const controller = new AbortController(); controller.abort();
  const cancelled = await checker.check({ workspace: resolveModelWorkspace(root, "model_unsafe_dependency"), executionDescription: scaffold.executionDescription, signal: controller.signal });
  assert.equal(cancelled.aggregate, "cancelled");
  assert.equal(calls, 0);
});

test("technical check rejects non-v2 and unsupported-profile descriptions before any process", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "riff-check-v2-gate-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scaffold = materializeScaffold(root, "model_check_v2_gate");
  const checker = new ModelTechnicalChecker({
    pythonExecutable: "/usr/bin/python3",
    executor: async () => {
      assert.fail("invalid execution descriptions must fail before a process is requested");
    },
  });
  for (const executionDescription of [
    { schemaVersion: 1 },
    {
      ...structuredClone(scaffold.executionDescription),
      inputs: { ...structuredClone(scaffold.executionDescription.inputs), schemaProfile: "unsupported" },
    },
  ]) {
    const result = await checker.check({
      workspace: resolveModelWorkspace(root, "model_check_v2_gate"),
      executionDescription,
    });
    assert.equal(result.aggregate, "failed");
    assert.equal(result.checks.at(-1)?.name, "interface");
    assert.equal(result.checks.at(-1)?.code, "execution_protocol_upgrade_required");
  }
});

test("real macOS technical check executes the generic riff-batch-v1 scaffold", {
  skip: Boolean(process.env.CODEX_SANDBOX)
    || process.platform !== "darwin"
    || !existsSync(resolve(import.meta.dirname, "../../mesa_service/.venv/bin/python3")),
}, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "riff-check-v2-live-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scaffold = materializeScaffold(root, "model_check_v2_live");
  const checker = new ModelTechnicalChecker({
    pythonExecutable: resolve(import.meta.dirname, "../../mesa_service/.venv/bin/python3"),
    cancellationProbeDelayMs: 100,
    timeoutMs: 10_000,
  });
  const result = await checker.check({
    workspace: resolveModelWorkspace(root, "model_check_v2_live"),
    executionDescription: scaffold.executionDescription,
  });
  assert.equal(result.aggregate, "executable", result.log);
  assert.equal(result.checks.find((item) => item.name === "smoke")?.code, "smoke_passed");
  assert.equal(result.checks.find((item) => item.name === "output")?.code, "declared_outputs_valid");
  assert.equal(result.checks.find((item) => item.name === "cancellation")?.code, "cancellation_passed");
});
