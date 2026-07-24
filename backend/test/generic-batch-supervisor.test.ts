import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import {
  consumeBatchOutputCandidate,
  GenericBatchSupervisor,
  verifyProjectExecutionRootCapability,
  type BatchSupervisorHooks,
  type FrozenBatchRun,
} from "../src/generic-batch-supervisor.ts";
import {
  createBatchInputV1,
  INPUT_SCHEMA_PROFILE,
  type ExecutionDescriptionV2,
} from "../src/execution-protocol-v2.ts";
import { captureWorkspaceDigest, createGenericModelScaffold } from "../src/model-workspace.ts";
import { createModelWorkspaceCapability } from "../src/restricted-process.ts";
import type { RunLimitsV1 } from "../src/product-store-v2.ts";

const SYSTEM_PYTHON = "/usr/bin/python3";
const MESA_PYTHON = resolve(import.meta.dirname, "../../mesa_service/.venv/bin/python3");

const LIMITS: RunLimitsV1 = Object.freeze({
  schemaVersion: 1,
  wallTimeMs: 10_000,
  startupTimeMs: 1_000,
  terminationGraceMs: 100,
  maxStdoutBytes: 16 * 1024,
  maxStderrBytes: 16 * 1024,
  maxOutputFiles: 32,
  maxOutputBytes: 2 * 1024 * 1024,
  maxEventCount: 100,
  maxEventBytes: 64 * 1024,
  maxSamples: 16,
  maxConcurrency: 2,
});

const CUSTOM_EXECUTION: ExecutionDescriptionV2 = Object.freeze({
  schemaVersion: 2,
  runtime: "python",
  runMode: "batch",
  dependencyFile: "environment/requirements.txt",
  inputs: Object.freeze({
    schemaProfile: INPUT_SCHEMA_PROFILE,
    schema: Object.freeze({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: false,
      required: Object.freeze(["mode"]),
      properties: Object.freeze({
        mode: Object.freeze({ type: "string", minLength: 1, maxLength: 64 }),
        sleepMs: Object.freeze({ type: "integer", minimum: 0, maximum: 5_000 }),
        noiseBytes: Object.freeze({ type: "integer", minimum: 0, maximum: 1_000_000 }),
      }),
    }),
    smoke: Object.freeze({ mode: "success" }),
  }),
  outputs: Object.freeze([Object.freeze({
    logicalName: "summary",
    relativePath: "summary.json",
    mediaType: "application/json",
    required: true,
    role: "data",
  })]),
  batch: Object.freeze({ entryPoint: "code/model.py", protocol: "riff-batch-v1" }),
  cancellation: Object.freeze({ signal: "SIGTERM", graceMs: 100 }),
});

const TWO_OUTPUT_EXECUTION: ExecutionDescriptionV2 = Object.freeze({
  ...CUSTOM_EXECUTION,
  outputs: Object.freeze([
    ...CUSTOM_EXECUTION.outputs,
    Object.freeze({
      logicalName: "extra",
      relativePath: "extra.txt",
      mediaType: "text/plain",
      required: false,
      role: "diagnostic" as const,
    }),
  ]),
});

const CUSTOM_MODEL = `from __future__ import annotations
import argparse,json,os,signal,sys,time
from pathlib import Path

parser=argparse.ArgumentParser()
parser.add_argument("--riff-input",required=True,type=Path)
parser.add_argument("--riff-output-dir",required=True,type=Path)
args=parser.parse_args()
envelope=json.loads(args.riff_input.read_text(encoding="utf-8"))
p=envelope["parameters"]
mode=p["mode"]
if mode in {"sleep","fail_after_sleep"}:
    time.sleep(p.get("sleepMs",250)/1000)
if mode=="fail" or mode=="fail_after_sleep":
    raise SystemExit(7)
if mode=="stdout":
    sys.stdout.write("o"*p.get("noiseBytes",10000));sys.stdout.flush()
if mode=="stderr":
    sys.stderr.write("e"*p.get("noiseBytes",10000));sys.stderr.flush()
args.riff_output_dir.mkdir(parents=True,exist_ok=True)
target=args.riff_output_dir/"summary.json"
if mode=="missing":
    raise SystemExit(0)
if mode=="symlink":
    target.symlink_to("/dev/null")
    raise SystemExit(0)
if mode=="fifo":
    os.mkfifo(target)
    raise SystemExit(0)
if mode=="bad_json":
    target.write_bytes(b"{not-json")
    raise SystemExit(0)
if mode=="large_output":
    target.write_bytes(b"x"*p.get("noiseBytes",10000))
    raise SystemExit(0)
mutationBlocked=None
inputMutationBlocked=None
if mode=="mutation_restore":
    original=Path(__file__).read_bytes()
    try:
        os.chmod(__file__,0o600)
        Path(__file__).write_bytes(original+b"\\n# mutation")
        Path(__file__).write_bytes(original)
        os.chmod(__file__,0o400)
        mutationBlocked=False
    except OSError:
        mutationBlocked=True
    inputOriginal=args.riff_input.read_bytes()
    try:
        os.chmod(args.riff_input,0o600)
        args.riff_input.write_bytes(inputOriginal+b"\\n")
        args.riff_input.write_bytes(inputOriginal)
        os.chmod(args.riff_input,0o400)
        inputMutationBlocked=False
    except OSError:
        inputMutationBlocked=True
if mode=="empty_dirs":
    for index in range(p.get("noiseBytes",100)):
        (args.riff_output_dir/f"empty-{index:06d}").mkdir()
childPid=None
if mode in {"fork_descendant","fork_descendant_sleep"}:
    childPid=os.fork()
    if childPid==0:
        for descriptor in (0,1,2):
            try:
                os.close(descriptor)
            except OSError:
                pass
        signal.signal(signal.SIGTERM,signal.SIG_IGN)
        while True:
            time.sleep(1)
payload={
    "sampleIndex":envelope["sampleIndex"],
    "sampleId":envelope["sampleId"],
    "seed":envelope["seed"],
    "environmentKeys":sorted(os.environ),
}
if mutationBlocked is not None:
    payload["projectMutationBlocked"]=mutationBlocked
if inputMutationBlocked is not None:
    payload["inputMutationBlocked"]=inputMutationBlocked
if childPid is not None:
    payload["childPid"]=childPid
target.write_text(json.dumps(payload,sort_keys=True,separators=(",",":"))+"\\n",encoding="utf-8")
if mode=="extra":
    (args.riff_output_dir/"extra.txt").write_text("undeclared",encoding="utf-8")
if mode=="fork_descendant_sleep":
    time.sleep(p.get("sleepMs",5000)/1000)
`;

test("generic batch supervisor runs the real v2 generic scaffold with bounded concurrency", {
  skip: process.platform !== "darwin" || !existsSync(MESA_PYTHON),
}, async (t) => {
  const fixture = createFixture(t);
  const scaffold = createGenericModelScaffold("model_runtime_generic");
  for (const file of scaffold.files) {
    const section = file.kind === "model_code" ? "code" : "environment";
    const target = join(fixture.projectRoot, section, file.relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.bytes);
  }
  const parameters = [
    { stepLimit: 2, demand: 1 },
    { stepLimit: 3, demand: 2 },
    { stepLimit: 4, demand: 0.5 },
  ];
  const run = frozenRun("run_generic_live", parameters, { maxConcurrency: 2 });
  const registered: number[] = [];
  const released: number[] = [];
  const started: number[] = [];
  const supervisor = new GenericBatchSupervisor({
    pythonExecutable: MESA_PYTHON,
    scratchRoot: fixture.scratchRoot,
  });
  const result = await supervisor.supervise({
    run,
    project: {
      workspace: verifiedCapability(fixture.projectRoot, "project:generic-live", scaffold.executionDescription),
      executionDescription: scaffold.executionDescription,
    },
    hooks: {
      registerProcess: async (identity) => { registered.push(identity.sampleIndex); },
      markGateReleased: async (identity) => { released.push(identity.sampleIndex); },
      markProcessStarted: async (identity) => { started.push(identity.sampleIndex); },
    },
  });

  assert.equal(result.status, "succeeded", JSON.stringify(result.samples));
  assert.equal(result.code, "batch_run_succeeded");
  assert.equal(result.samples.length, 3);
  assert.equal(result.outputs.length, 3);
  assert.ok(result.resources.maxConcurrencyObserved <= 2);
  assert.ok(result.resources.maxConcurrencyObserved >= 2);
  assert.deepEqual(registered.sort(), [0, 1, 2]);
  assert.deepEqual(released.sort(), [0, 1, 2]);
  assert.deepEqual(started.sort(), [0, 1, 2]);
  assert.equal(new Set(result.samples.map((sample) => sample.scratchPath)).size, 3);
  for (const [index, output] of result.outputs.entries()) {
    const payload = JSON.parse(consumeBatchOutputCandidate(output).toString("utf8"));
    assert.equal(payload.completed_steps, parameters[index]!.stepLimit);
    assert.equal(payload.demand, parameters[index]!.demand);
    assert.equal(payload.processed_demand, parameters[index]!.stepLimit * parameters[index]!.demand);
    assert.equal(output.sampleIndex, index);
    assert.match(output.sha256, /^[0-9a-f]{64}$/u);
  }
});

test("launch gate registers and rechecks identity before releasing Model code, with an allowlist-only environment", {
  skip: process.platform !== "darwin",
}, async (t) => {
  const fixture = customFixture(t);
  process.env.OPENCODE_API_KEY = "must-not-leak";
  process.env.HTTPS_PROXY = "http://proxy.invalid";
  t.after(() => {
    delete process.env.OPENCODE_API_KEY;
    delete process.env.HTTPS_PROXY;
  });
  let registered = false;
  let released = false;
  const hooks: BatchSupervisorHooks = {
    registerProcess: async (identity) => {
      registered = true;
      assert.equal(identity.pid, identity.processGroupId);
      assert.ok(identity.startToken);
      assert.equal(hasFileNamed(fixture.scratchRoot, "summary.json"), false);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
      assert.equal(hasFileNamed(fixture.scratchRoot, "summary.json"), false);
    },
    markGateReleased: async () => { released = true; },
  };
  const result = await superviseCustom(fixture, [{ mode: "success" }], {}, hooks);
  assert.equal(result.status, "succeeded", result.diagnostic);
  assert.equal(registered, true);
  assert.equal(released, true);
  const payload = JSON.parse(consumeBatchOutputCandidate(result.outputs[0]!).toString("utf8"));
  assert.deepEqual(payload.environmentKeys, [
    "LANG",
    "LC_ALL",
    "PYTHONDONTWRITEBYTECODE",
    "PYTHONHASHSEED",
    "PYTHONNOUSERSITE",
    "RIFF_EXECUTION_PROTOCOL",
    "TMPDIR",
    "__CF_USER_TEXT_ENCODING",
  ]);
  assert.doesNotMatch(JSON.stringify(payload), /secret|proxy|home|github|opencode|token/iu);
});

test("registration timeout leaves Model code behind the one-use launch gate", {
  skip: process.platform !== "darwin",
}, async (t) => {
  const fixture = customFixture(t);
  const supervisor = new GenericBatchSupervisor({
    pythonExecutable: SYSTEM_PYTHON,
    scratchRoot: fixture.scratchRoot,
    registrationTimeoutMs: 40,
  });
  const run = frozenRun("run_gate_timeout", [{ mode: "success" }]);
  const result = await supervisor.supervise({
    run,
    project: {
      workspace: verifiedCapability(fixture.projectRoot, "project:gate-timeout", CUSTOM_EXECUTION),
      executionDescription: CUSTOM_EXECUTION,
    },
    hooks: { registerProcess: () => new Promise(() => undefined) },
  });
  assert.equal(result.status, "failed");
  assert.equal(result.code, "process_registration_timeout");
  assert.equal(hasFileNamed(fixture.scratchRoot, "summary.json"), false);
});

test("batch supervisor fails the run on partial-sample failure and launches no further sample", {
  skip: process.platform !== "darwin",
}, async (t) => {
  const fixture = customFixture(t);
  const result = await superviseCustom(fixture, [
    { mode: "fail" },
    { mode: "sleep", sleepMs: 2_000 },
    { mode: "success" },
  ], { maxConcurrency: 2 });
  assert.equal(result.status, "failed");
  assert.equal(result.code, "batch_process_failed");
  assert.equal(result.samples[2]!.status, "not_started");
  assert.equal(result.outputs.length, 0);
});

test("batch supervisor enforces wall, stdout, stderr, output byte, and output file limits", {
  skip: process.platform !== "darwin",
}, async (t) => {
  const cases: Array<{
    name: string;
    parameters: Record<string, unknown>;
    limits: Partial<RunLimitsV1>;
    code: string;
    status?: "failed" | "timed_out";
  }> = [
    { name: "wall", parameters: { mode: "sleep", sleepMs: 5_000 }, limits: { wallTimeMs: 80 }, code: "run_wall_timeout", status: "timed_out" },
    { name: "stdout", parameters: { mode: "stdout", noiseBytes: 20_000 }, limits: { maxStdoutBytes: 128 }, code: "run_stdout_limit" },
    { name: "stderr", parameters: { mode: "stderr", noiseBytes: 20_000 }, limits: { maxStderrBytes: 128 }, code: "run_stderr_limit" },
    { name: "output bytes", parameters: { mode: "large_output", noiseBytes: 2_000 }, limits: { maxOutputBytes: 128 }, code: "run_output_byte_limit" },
    { name: "output files", parameters: { mode: "extra" }, limits: { maxOutputFiles: 1 }, code: "run_output_file_limit" },
  ];
  for (const item of cases) {
    await t.test(item.name, async (subtest) => {
      const fixture = customFixture(subtest);
      const result = await superviseCustom(
        fixture,
        [item.parameters],
        item.limits,
        undefined,
        item.name === "output files" ? TWO_OUTPUT_EXECUTION : CUSTOM_EXECUTION,
      );
      assert.equal(result.status, item.status ?? "failed");
      assert.equal(result.code, item.code);
      assert.ok(result.resources.maxConcurrencyObserved <= 1);
      if (item.code === "run_stdout_limit") assert.equal(result.resources.stdoutBytes, 128);
      if (item.code === "run_stderr_limit") assert.equal(result.resources.stderrBytes, 128);
    });
  }
});

test("batch output discovery rejects missing, undeclared, symlink, special, and invalid-media outputs", {
  skip: process.platform !== "darwin",
}, async (t) => {
  const cases = [
    ["missing", "batch_required_output_missing"],
    ["extra", "batch_undeclared_output"],
    ["symlink", "batch_output_unsafe"],
    ["fifo", "batch_output_unsafe"],
    ["bad_json", "batch_output_media_invalid"],
  ] as const;
  for (const [mode, code] of cases) {
    await t.test(mode, async (subtest) => {
      const fixture = customFixture(subtest);
      const result = await superviseCustom(fixture, [{ mode }]);
      assert.equal(result.status, "failed");
      assert.equal(result.code, code);
      assert.equal(result.outputs.length, 0);
    });
  }
});

test("A3-1b rejects declared domain events instead of silently ignoring their limits", {
  skip: process.platform !== "darwin",
}, async (t) => {
  const fixture = customFixture(t);
  const execution = {
    ...CUSTOM_EXECUTION,
    batch: {
      ...CUSTOM_EXECUTION.batch!,
      domainEvents: {
        relativePath: "events.ndjson",
        mediaType: "application/x-ndjson",
        role: "diagnostic",
      },
    },
  } as ExecutionDescriptionV2;
  const supervisor = new GenericBatchSupervisor({
    pythonExecutable: SYSTEM_PYTHON,
    scratchRoot: fixture.scratchRoot,
  });
  await assert.rejects(
    () => runWithSupervisor(supervisor, fixture, [{ mode: "success" }], {}, undefined, execution),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "domain_events_not_supported",
  );
});

test("batch-specific sandbox leaves Project and input read-only while output remains writable", {
  skip: process.platform !== "darwin",
}, async (t) => {
  const fixture = customFixture(t);
  const result = await superviseCustom(fixture, [{ mode: "mutation_restore" }]);
  assert.equal(result.status, "succeeded", result.diagnostic);
  const payload = JSON.parse(consumeBatchOutputCandidate(result.outputs[0]!).toString("utf8"));
  assert.equal(payload.projectMutationBlocked, true);
  assert.equal(payload.inputMutationBlocked, true);
});

test("execution-root digest rejects a mutation between verification and sample copy", {
  skip: process.platform !== "darwin",
}, async (t) => {
  const fixture = customFixture(t);
  const entryPoint = join(fixture.projectRoot, "code", "model.py");
  const supervisor = new GenericBatchSupervisor({
    pythonExecutable: SYSTEM_PYTHON,
    scratchRoot: fixture.scratchRoot,
    faultInjector(checkpoint) {
      if (checkpoint === "after_execution_root_copied") appendFileSync(entryPoint, "\n# raced\n");
    },
  });
  const result = await runWithSupervisor(supervisor, fixture, [{ mode: "success" }]);
  assert.equal(result.status, "failed");
  assert.equal(result.code, "project_snapshot_corrupt");
  assert.equal(result.samples[0]!.identity, null);
  assert.equal(result.outputs.length, 0);
});

test("output discovery rejects replacement of the assigned output root with a symlink", {
  skip: process.platform !== "darwin",
}, async (t) => {
  const fixture = customFixture(t);
  const supervisor = new GenericBatchSupervisor({
    pythonExecutable: SYSTEM_PYTHON,
    scratchRoot: fixture.scratchRoot,
    faultInjector(checkpoint, paths) {
      if (checkpoint !== "before_output_discovery" || !paths.outputDirectory) return;
      const moved = `${paths.outputDirectory}-real`;
      renameSync(paths.outputDirectory, moved);
      symlinkSync(moved, paths.outputDirectory);
    },
  });
  const result = await runWithSupervisor(supervisor, fixture, [{ mode: "success" }]);
  assert.equal(result.status, "failed");
  assert.equal(result.code, "batch_output_unsafe");
  assert.equal(result.outputs.length, 0);
});

test("output traversal counts empty directories against the bounded entry budget", {
  skip: process.platform !== "darwin",
}, async (t) => {
  const fixture = customFixture(t);
  const result = await superviseCustom(
    fixture,
    [{ mode: "empty_dirs", noiseBytes: 100 }],
    { maxOutputFiles: 10 },
  );
  assert.equal(result.status, "failed");
  assert.equal(result.code, "run_output_file_limit");
  assert.equal(result.outputs.length, 0);
});

test("a later sample failure clears every earlier ordinary output candidate", {
  skip: process.platform !== "darwin",
}, async (t) => {
  const fixture = customFixture(t);
  const result = await superviseCustom(
    fixture,
    [{ mode: "success" }, { mode: "fail" }],
    { maxConcurrency: 1 },
  );
  assert.equal(result.status, "failed");
  assert.equal(result.code, "batch_process_failed");
  assert.equal(result.samples[0]!.status, "succeeded");
  assert.ok(result.samples.every((sample) => sample.outputs.length === 0));
  assert.equal(result.outputs.length, 0);
});

test("leader exit does not skip hard-kill of a descendant that closes stdio and ignores TERM", {
  skip: process.platform !== "darwin",
}, async (t) => {
  const fixture = customFixture(t);
  const supervisor = new GenericBatchSupervisor({
    pythonExecutable: SYSTEM_PYTHON,
    scratchRoot: fixture.scratchRoot,
  });
  const result = await runWithSupervisor(
    supervisor,
    fixture,
    [{ mode: "fork_descendant" }],
    { terminationGraceMs: 50 },
  );
  assert.equal(result.status, "failed");
  assert.equal(result.code, "batch_process_descendant");
  assert.equal(result.outputs.length, 0);
  const payload = JSON.parse(readFileSync(join(result.samples[0]!.scratchPath, "output", "summary.json"), "utf8"));
  assert.equal(await waitForProcessTargetGone(payload.childPid), true);
  assert.equal(await waitForProcessTargetGone(-result.samples[0]!.identity!.processGroupId), true);
  assert.equal(supervisor.cleanup(result).verified, true);
});

test("cross-restart recovery terminates an exact process group after its leader exits", {
  skip: process.platform !== "darwin",
}, async () => {
  const launched = spawnSync(SYSTEM_PYTHON, ["-c", `
import json,os,signal,subprocess,time
token=subprocess.check_output(["/bin/ps","-o","lstart=","-p",str(os.getpid())],text=True).strip()
child=os.fork()
if child == 0:
    for descriptor in (0,1,2):
        try: os.close(descriptor)
        except OSError: pass
    signal.signal(signal.SIGTERM,signal.SIG_IGN)
    while True: time.sleep(1)
print(json.dumps({"childPid":child,"startToken":token}),flush=True)
`], {
    detached: true,
    encoding: "utf8",
    timeout: 2_000,
  });
  assert.equal(launched.status, 0, launched.stderr);
  assert.ok(Number.isSafeInteger(launched.pid));
  const payload = JSON.parse(launched.stdout);
  const processGroupId = launched.pid!;
  const scratchRoot = mkdtempSync(join(tmpdir(), "riff-recovery-supervisor-"));
  const identity = {
    runId: "run_recovery_descendant",
    sampleIndex: 0,
    sampleId: "a".repeat(64),
    scratchId: "scratch_recovery_descendant",
    pid: processGroupId,
    processGroupId,
    startToken: payload.startToken as string,
  };
  try {
    const supervisor = new GenericBatchSupervisor({
      pythonExecutable: SYSTEM_PYTHON,
      scratchRoot,
    });
    assert.equal(supervisor.inspectRecordedProcess(identity), "present");
    const receipt = await supervisor.terminateRecordedProcess(
      identity,
      50,
      "2026-07-25T04:10:00.000Z",
    );
    assert.equal(receipt.termSent, true);
    assert.equal(receipt.killSent, true);
    assert.equal(receipt.groupGone, true);
    assert.equal(supervisor.verifyRecordedProcessGroupGone(identity), true);
    assert.equal(await waitForProcessTargetGone(payload.childPid), true);
  } finally {
    try {
      process.kill(-processGroupId, "SIGKILL");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
    rmSync(scratchRoot, { recursive: true, force: true });
  }
});

test("dispatcher shutdown aborts an active leader and descendant without orphaning the process group", {
  skip: process.platform !== "darwin",
}, async (t) => {
  const fixture = customFixture(t);
  const controller = new AbortController();
  const supervisor = new GenericBatchSupervisor({
    pythonExecutable: SYSTEM_PYTHON,
    scratchRoot: fixture.scratchRoot,
  });
  const result = await runWithSupervisor(
    supervisor,
    fixture,
    [{ mode: "fork_descendant_sleep", sleepMs: 5_000 }],
    { terminationGraceMs: 50 },
    {
      async markProcessStarted() {
        const deadline = Date.now() + 2_000;
        let summaryReady = false;
        while (!summaryReady && Date.now() < deadline) {
          const summaryPath = findFileNamed(fixture.scratchRoot, "summary.json");
          if (summaryPath) {
            try {
              const value = JSON.parse(readFileSync(summaryPath, "utf8"));
              summaryReady = Number.isSafeInteger(value.childPid);
            } catch {
              summaryReady = false;
            }
          }
          if (summaryReady) break;
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
        }
        assert.equal(summaryReady, true);
        controller.abort();
      },
    },
    CUSTOM_EXECUTION,
    controller.signal,
  );
  assert.equal(result.status, "failed");
  assert.equal(result.code, "dispatcher_shutdown");
  assert.equal(result.outputs.length, 0);
  const sample = result.samples[0]!;
  const payload = JSON.parse(readFileSync(join(sample.scratchPath, "output", "summary.json"), "utf8"));
  assert.equal(await waitForProcessTargetGone(payload.childPid), true);
  assert.equal(await waitForProcessTargetGone(-sample.identity!.processGroupId), true);
  assert.equal(supervisor.cleanup(result).verified, true);
});

test("dispatcher shutdown interrupts a blocked registration hook and closes the unreleased gate", {
  skip: process.platform !== "darwin",
}, async (t) => {
  const fixture = customFixture(t);
  const controller = new AbortController();
  const supervisor = new GenericBatchSupervisor({
    pythonExecutable: SYSTEM_PYTHON,
    scratchRoot: fixture.scratchRoot,
  });
  const result = await runWithSupervisor(
    supervisor,
    fixture,
    [{ mode: "success" }],
    {},
    {
      registerProcess() {
        controller.abort();
        return new Promise(() => undefined);
      },
    },
    CUSTOM_EXECUTION,
    controller.signal,
  );
  assert.equal(result.status, "failed");
  assert.equal(result.code, "dispatcher_shutdown");
  assert.equal(hasFileNamed(fixture.scratchRoot, "summary.json"), false);
  assert.equal(await waitForProcessTargetGone(-result.samples[0]!.identity!.processGroupId), true);
  assert.equal(supervisor.cleanup(result).verified, true);
});

test("Project-copy admission rejects symlink and special-file snapshot content before launch", {
  skip: process.platform !== "darwin",
}, async (t) => {
  await t.test("symlink", async (subtest) => {
    const fixture = customFixture(subtest);
    const workspace = verifiedCapability(fixture.projectRoot, "project:symlink-admission", CUSTOM_EXECUTION);
    symlinkSync("/dev/null", join(fixture.projectRoot, "code", "escape.py"));
    const supervisor = new GenericBatchSupervisor({
      pythonExecutable: SYSTEM_PYTHON,
      scratchRoot: fixture.scratchRoot,
    });
    await assert.rejects(
      () => supervisor.supervise({
        run: frozenRun("run_symlink_admission", [{ mode: "success" }]),
        project: { workspace, executionDescription: CUSTOM_EXECUTION },
      }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "project_snapshot_corrupt",
    );
  });
  await t.test("fifo", async (subtest) => {
    const fixture = customFixture(subtest);
    const workspace = verifiedCapability(fixture.projectRoot, "project:fifo-admission", CUSTOM_EXECUTION);
    const target = join(fixture.projectRoot, "environment", "special");
    const created = spawnSync("/usr/bin/mkfifo", [target], { stdio: "ignore" }).status === 0;
    if (!created) return subtest.skip("mkfifo is unavailable");
    const supervisor = new GenericBatchSupervisor({
      pythonExecutable: SYSTEM_PYTHON,
      scratchRoot: fixture.scratchRoot,
    });
    await assert.rejects(
      () => supervisor.supervise({
        run: frozenRun("run_fifo_admission", [{ mode: "success" }]),
        project: { workspace, executionDescription: CUSTOM_EXECUTION },
      }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "project_snapshot_corrupt",
    );
  });
});

test("output consumption rechecks replacement and hardlink identity, then exact cleanup removes successful and failed scratch", {
  skip: process.platform !== "darwin",
}, async (t) => {
  const successFixture = customFixture(t);
  const successSupervisor = new GenericBatchSupervisor({
    pythonExecutable: SYSTEM_PYTHON,
    scratchRoot: successFixture.scratchRoot,
  });
  const success = await runWithSupervisor(
    successSupervisor,
    successFixture,
    [{ mode: "success" }, { mode: "success" }],
  );
  assert.equal(success.status, "succeeded", success.diagnostic);
  const first = success.outputs[0]!;
  const original = consumeBatchOutputCandidate(first);
  unlinkSync(first.sourcePath);
  writeFileSync(first.sourcePath, original);
  assert.throws(
    () => consumeBatchOutputCandidate(first),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "batch_output_changed",
  );
  const second = success.outputs[1]!;
  const externalHardlink = join(successFixture.root, "output-hardlink");
  linkSync(second.sourcePath, externalHardlink);
  assert.throws(
    () => consumeBatchOutputCandidate(second),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "batch_output_changed",
  );
  unlinkSync(externalHardlink);
  const replacedScratch = `${success.samples[1]!.scratchPath}-moved`;
  renameSync(success.samples[1]!.scratchPath, replacedScratch);
  symlinkSync(replacedScratch, success.samples[1]!.scratchPath);
  assert.throws(
    () => consumeBatchOutputCandidate(second),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "batch_output_changed",
  );
  assert.throws(
    () => successSupervisor.cleanup(success),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "scratch_cleanup_unverified",
  );
  unlinkSync(success.samples[1]!.scratchPath);
  renameSync(replacedScratch, success.samples[1]!.scratchPath);
  const successPaths = success.samples.filter((sample) => sample.scratchPath).map((sample) => sample.scratchPath);
  const successReceipt = successSupervisor.cleanup(success);
  assert.equal(successReceipt.verified, true);
  assert.match(successReceipt.receiptDigest, /^[0-9a-f]{64}$/u);
  assert.ok(successPaths.every((path) => !existsSync(path)));

  const failedFixture = customFixture(t);
  const failedSupervisor = new GenericBatchSupervisor({
    pythonExecutable: SYSTEM_PYTHON,
    scratchRoot: failedFixture.scratchRoot,
  });
  const failed = await runWithSupervisor(failedSupervisor, failedFixture, [{ mode: "missing" }]);
  assert.equal(failed.status, "failed");
  const failedPath = failed.samples[0]!.scratchPath;
  const failedReceipt = failedSupervisor.cleanup(failed);
  assert.equal(failedReceipt.verified, true);
  assert.equal(existsSync(failedPath), false);
});

test("durable recovery cleanup accepts exact or missing leases and rejects planned, symlink, and ownership drift", {
  skip: process.platform !== "darwin",
}, () => {
  const root = mkdtempSync(join(tmpdir(), "riff-durable-scratch-"));
  const scratchRoot = join(root, "scratch");
  mkdirSync(scratchRoot, { mode: 0o700 });
  try {
    const supervisor = new GenericBatchSupervisor({
      pythonExecutable: SYSTEM_PYTHON,
      scratchRoot,
    });
    const base = {
      runId: "run_durable_scratch",
      sampleIndex: 0,
      sampleId: "a".repeat(64),
      scratchId: "scratch_durable_scratch",
      relativePath: "riff-run_durable_scratch-0-exact",
      registeredAt: "2026-07-25T04:00:00.000Z",
    };
    const missing = supervisor.cleanupDurableScratch({
      ...base,
      ownerUid: 501,
      device: 1,
      inode: 1,
    }, "2026-07-25T04:00:01.000Z");
    assert.equal(missing.disposition, "already_absent");

    const exactPath = join(scratchRoot, base.relativePath);
    mkdirSync(exactPath, { mode: 0o700 });
    const exactInfo = lstatSync(exactPath);
    assert.throws(() => supervisor.cleanupDurableScratch({
      ...base,
      ownerUid: exactInfo.uid + 1,
      device: exactInfo.dev,
      inode: exactInfo.ino,
    }), /exact durable scratch directory changed/u);
    const exact = supervisor.cleanupDurableScratch({
      ...base,
      ownerUid: exactInfo.uid,
      device: exactInfo.dev,
      inode: exactInfo.ino,
    });
    assert.equal(exact.disposition, "removed");
    const unrelated = join(scratchRoot, "untracked-sentinel");
    mkdirSync(unrelated, { mode: 0o700 });
    writeFileSync(join(unrelated, "keep.txt"), "keep");
    assert.equal(readFileSync(join(unrelated, "keep.txt"), "utf8"), "keep");

    const target = join(scratchRoot, "target");
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, exactPath);
    assert.throws(() => supervisor.cleanupDurableScratch({
      ...base,
      ownerUid: lstatSync(target).uid,
      device: lstatSync(target).dev,
      inode: lstatSync(target).ino,
    }), /exact durable scratch directory changed/u);
    unlinkSync(exactPath);
    assert.throws(() => supervisor.cleanupPlannedScratch({
      runId: base.runId,
      sampleIndex: base.sampleIndex,
      sampleId: base.sampleId,
      scratchId: base.scratchId,
      relativePath: "target",
    }), /exists without a durable directory identity/u);
    assert.equal(readFileSync(join(unrelated, "keep.txt"), "utf8"), "keep");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("verified Project execution capability requires code/ and environment/ directly under model-snapshot root", () => {
  const root = mkdtempSync(join(tmpdir(), "riff-wrong-project-root-"));
  try {
    const nested = join(root, "model-snapshot");
    mkdirSync(join(nested, "code"), { recursive: true });
    mkdirSync(join(nested, "environment"), { recursive: true });
    writeFileSync(join(nested, "code", "model.py"), CUSTOM_MODEL);
    writeFileSync(join(nested, "environment", "requirements.txt"), "");
    assert.throws(
      () => verifyProjectExecutionRootCapability(
        createModelWorkspaceCapability(root, "project:wrong-layer"),
        CUSTOM_EXECUTION,
        "0".repeat(64),
      ),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "project_snapshot_corrupt",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const createFixture = (t: TestContext): { root: string; projectRoot: string; scratchRoot: string } => {
  const root = mkdtempSync(join(tmpdir(), "riff-generic-batch-"));
  const projectRoot = join(root, "project");
  const scratchRoot = join(root, "scratch");
  mkdirSync(projectRoot, { recursive: false, mode: 0o700 });
  mkdirSync(scratchRoot, { recursive: false, mode: 0o700 });
  t.after(() => {
    makeTreeWritable(root);
    rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
  });
  return { root, projectRoot, scratchRoot };
};

const customFixture = (t: TestContext): ReturnType<typeof createFixture> => {
  const fixture = createFixture(t);
  mkdirSync(join(fixture.projectRoot, "code"), { recursive: true, mode: 0o700 });
  mkdirSync(join(fixture.projectRoot, "environment"), { recursive: true, mode: 0o700 });
  writeFileSync(join(fixture.projectRoot, "code", "model.py"), CUSTOM_MODEL);
  writeFileSync(join(fixture.projectRoot, "environment", "requirements.txt"), "# standard library only\n");
  return fixture;
};

const frozenRun = (
  runId: string,
  parameters: readonly Record<string, unknown>[],
  limitOverrides: Partial<RunLimitsV1> = {},
): FrozenBatchRun => {
  const limits = Object.freeze({ ...LIMITS, ...limitOverrides });
  return Object.freeze({
    runId,
    runKind: "batch",
    samples: Object.freeze(parameters.map((value, sampleIndex) => {
      const envelope = createBatchInputV1({ runId, sampleIndex, parameters: value, seed: sampleIndex + 11 });
      return Object.freeze({
        sampleIndex,
        sampleId: envelope.sampleId,
        parameters: envelope.parameters,
        seed: envelope.seed,
      });
    })),
    limits,
  });
};

const superviseCustom = (
  fixture: ReturnType<typeof createFixture>,
  parameters: readonly Record<string, unknown>[],
  limitOverrides: Partial<RunLimitsV1> = {},
  hooks?: BatchSupervisorHooks,
  executionDescription: ExecutionDescriptionV2 = CUSTOM_EXECUTION,
) => runWithSupervisor(
  new GenericBatchSupervisor({
    pythonExecutable: SYSTEM_PYTHON,
    scratchRoot: fixture.scratchRoot,
  }),
  fixture,
  parameters,
  limitOverrides,
  hooks,
  executionDescription,
);

const runWithSupervisor = (
  supervisor: GenericBatchSupervisor,
  fixture: ReturnType<typeof createFixture>,
  parameters: readonly Record<string, unknown>[],
  limitOverrides: Partial<RunLimitsV1> = {},
  hooks?: BatchSupervisorHooks,
  executionDescription: ExecutionDescriptionV2 = CUSTOM_EXECUTION,
  signal?: AbortSignal,
) => supervisor.supervise({
  run: frozenRun(`run_${Math.random().toString(16).slice(2)}`, parameters, limitOverrides),
  project: {
    workspace: verifiedCapability(fixture.projectRoot, `project:${Math.random()}`, executionDescription),
    executionDescription,
  },
  ...(hooks ? { hooks } : {}),
  ...(signal ? { signal } : {}),
});

const findFileNamed = (root: string, name: string): string | null => {
  const visit = (directory: string): string | null => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.name === name) return path;
      if (entry.isDirectory()) {
        const nested = visit(path);
        if (nested) return nested;
      }
    }
    return null;
  };
  return visit(root);
};

const hasFileNamed = (root: string, name: string): boolean =>
  findFileNamed(root, name) !== null;

const makeTreeWritable = (root: string): void => {
  if (!existsSync(root)) return;
  const info = lstatSync(root);
  if (info.isSymbolicLink() || !info.isDirectory()) return;
  chmodSync(root, 0o700);
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) makeTreeWritable(join(root, entry.name));
  }
};

const waitForProcessTargetGone = async (target: number): Promise<boolean> => {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      process.kill(target, 0);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") return true;
      throw error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  return false;
};

const verifiedCapability = (
  root: string,
  capabilityId: string,
  executionDescription: ExecutionDescriptionV2,
) => {
  const workspace = createModelWorkspaceCapability(root, capabilityId);
  return verifyProjectExecutionRootCapability(
    workspace,
    executionDescription,
    captureWorkspaceDigest(workspace, { maxFiles: 10_000, maxTotalBytes: 512 * 1024 * 1024 }).digest,
  );
};
