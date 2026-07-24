import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  GenericVisualSupervisor,
  type FrozenVisualRun,
  type VisualSupervisorHooks,
} from "../src/generic-visual-supervisor.ts";
import {
  createBatchInputV1,
  INPUT_SCHEMA_PROFILE,
  type ExecutionDescriptionV2,
} from "../src/execution-protocol-v2.ts";
import {
  verifyProjectExecutionRootCapability,
} from "../src/generic-batch-supervisor.ts";
import {
  captureWorkspaceDigest,
} from "../src/model-workspace.ts";
import {
  createModelWorkspaceCapability,
} from "../src/restricted-process.ts";
import type { RunLimitsV1 } from "../src/product-store-v2.ts";

const PYTHON = "/usr/bin/python3";
const MODEL = readFileSync(
  join(import.meta.dirname, "fixtures", "generic-visual-model.py"),
);

const DESCRIPTION: ExecutionDescriptionV2 = Object.freeze({
  schemaVersion: 2,
  runtime: "python",
  runMode: "visual",
  dependencyFile: "environment/requirements.txt",
  inputs: Object.freeze({
    schemaProfile: INPUT_SCHEMA_PROFILE,
    schema: Object.freeze({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: false,
      required: Object.freeze(["mode"]),
      properties: Object.freeze({
        mode: Object.freeze({
          type: "string",
          enum: Object.freeze([
            "success",
            "redirect",
            "no_listener",
            "wildcard",
            "linger",
            "premature_exit",
            "stdout_overflow",
            "listener_drift",
            "hardlink_output",
          ]),
        }),
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
  visual: Object.freeze({
    entryPoint: "code/model.py",
    protocol: "riff-visual-v1",
    healthPath: "/health",
  }),
  cancellation: Object.freeze({ signal: "SIGTERM", graceMs: 100 }),
});

const LIMITS: RunLimitsV1 = Object.freeze({
  schemaVersion: 1,
  wallTimeMs: 5_000,
  startupTimeMs: 1_500,
  terminationGraceMs: 100,
  maxStdoutBytes: 16 * 1024,
  maxStderrBytes: 16 * 1024,
  maxOutputFiles: 16,
  maxOutputBytes: 1024 * 1024,
  maxEventCount: 100,
  maxEventBytes: 64 * 1024,
  maxSamples: 1,
  maxConcurrency: 1,
});

test("generic visual supervisor runs one gated visual process, records health once, and cleans exact scratch", {
  skip: process.platform !== "darwin",
}, async (t) => {
  const fixture = createFixture(t);
  const events: string[] = [];
  let receiptHost = "";
  let hookHealthPath = "";
  let hookPort = 0;
  const result = await supervise(fixture, "success", {
    planScratch: async () => {
      events.push("plan");
      return Object.freeze({
        manifestId: "manifest_visual_success",
        manifestDigest: "a".repeat(64),
      });
    },
    registerScratchDirectory: async () => { events.push("scratch"); },
    registerProcess: async (_identity, receipt) => {
      events.push("register");
      receiptHost = receipt.loopbackHost;
      hookHealthPath = _identity.healthPath;
      hookPort = _identity.loopbackPort;
    },
    markGateReleased: async () => { events.push("release"); },
    markProcessStarted: async () => { events.push("started"); },
    recordHealth: async () => { events.push("health"); },
  });

  assert.equal(result.status, "succeeded", JSON.stringify(result));
  assert.equal(result.code, "visual_run_succeeded");
  assert.equal(result.healthVerified, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.signal, null);
  assert.deepEqual(events, [
    "plan",
    "scratch",
    "register",
    "release",
    "started",
    "health",
  ]);
  assert.equal(receiptHost, "127.0.0.1");
  assert.equal(hookHealthPath, "/health");
  assert.ok(hookPort > 0);
  assert.equal("loopbackPort" in result.identity!, false);
  assert.equal("healthPath" in result.identity!, false);
  assert.equal("stdout" in result, false);
  assert.equal("stderr" in result, false);
  assert.equal(result.stdoutBytes, 0);
  assert.equal(result.stderrBytes, 0);
  assert.equal(result.outputs.length, 1);
  const output = JSON.parse(readFileSync(result.outputs[0]!.sourcePath, "utf8"));
  assert.equal(output.mode, "success");
  assert.equal(output.requestCount, 1);

  const receipt = fixture.supervisor.cleanup(result);
  assert.equal(receipt.verified, true);
  assert.match(receipt.receiptDigest, /^[0-9a-f]{64}$/u);
  assert.equal(existsSync(result.scratchPath), false);
});

test("generic visual supervisor rejects redirect health and cleans the process group", {
  skip: process.platform !== "darwin",
}, async (t) => {
  const fixture = createFixture(t);
  const result = await supervise(fixture, "redirect");
  assert.equal(result.status, "failed", JSON.stringify(result));
  assert.equal(result.code, "visual_health_failed");
  assert.equal(result.healthVerified, false);
  assert.equal(result.outputs.length, 0);
  fixture.supervisor.cleanup(result);
});

test("generic visual supervisor fails closed for premature exit, stream overflow, and healthy listener drift", {
  skip: process.platform !== "darwin",
}, async (t) => {
  for (const [mode, code, limits] of [
    ["premature_exit", "visual_process_failed", {}],
    ["stdout_overflow", "run_stdout_limit", { maxStdoutBytes: 128 }],
    ["listener_drift", "visual_listener_invalid", {}],
  ] as const) {
    await t.test(mode, async (subtest) => {
      const fixture = createFixture(subtest);
      const result = await supervise(fixture, mode, undefined, limits);
      assert.equal(result.status, "failed", JSON.stringify(result));
      assert.equal(result.code, code);
      assert.equal(result.outputs.length, 0);
      if (mode === "stdout_overflow") {
        assert.equal(result.stdoutBytes, 128);
        assert.equal(result.stdoutTruncated, true);
        assert.equal("stdout" in result, false);
      }
      fixture.supervisor.cleanup(result);
    });
  }
});

test("generic visual supervisor rolls back an unregistered scratch directory", {
  skip: process.platform !== "darwin",
}, async (t) => {
  const fixture = createFixture(t);
  await assert.rejects(() => supervise(fixture, "success", {
    registerScratchDirectory: async () => {
      throw new Error("store unavailable");
    },
  }), (error: unknown) =>
    error instanceof Error
    && error.name === "GenericVisualSupervisorError");
  assert.deepEqual(readdirSync(fixture.scratchRoot), []);
});

test("generic visual supervisor terminates an exact blocked identity when process registration rejects", {
  skip: process.platform !== "darwin",
}, async (t) => {
  const fixture = createFixture(t);
  let registeredPid = 0;
  const result = await supervise(fixture, "success", {
    registerProcess: async (identity) => {
      registeredPid = identity.pid;
      throw new Error("registration rejected");
    },
  });
  assert.ok(registeredPid > 0);
  assert.equal(result.status, "failed", JSON.stringify(result));
  assert.equal(result.code, "visual_process_failed");
  assert.equal(result.exitCode, null);
  assert.ok(result.signal === "SIGTERM" || result.signal === "SIGKILL");
  fixture.supervisor.cleanup(result);
});

test("generic visual supervisor rejects hard-linked output and counts captured bytes", {
  skip: process.platform !== "darwin",
}, async (t) => {
  const hardlinkFixture = createFixture(t);
  const hardlink = await supervise(hardlinkFixture, "hardlink_output");
  assert.equal(hardlink.status, "failed", JSON.stringify(hardlink));
  assert.equal(hardlink.code, "run_output_invalid");
  hardlinkFixture.supervisor.cleanup(hardlink);

  const limitFixture = createFixture(t);
  const limited = await supervise(limitFixture, "success", undefined, {
    maxOutputBytes: 8,
  });
  assert.equal(limited.status, "failed", JSON.stringify(limited));
  assert.equal(limited.code, "run_output_byte_limit");
  limitFixture.supervisor.cleanup(limited);
});

test("generic visual supervisor distinguishes startup timeout from an invalid wildcard listener", {
  skip: process.platform !== "darwin",
}, async (t) => {
  await t.test("startup timeout", async (subtest) => {
    const fixture = createFixture(subtest);
    const result = await supervise(fixture, "no_listener", undefined, {
      startupTimeMs: 120,
    });
    assert.equal(result.status, "timed_out", JSON.stringify(result));
    assert.equal(result.code, "visual_startup_timeout");
    fixture.supervisor.cleanup(result);
  });
  await t.test("listener invalid", async (subtest) => {
    const fixture = createFixture(subtest);
    const result = await supervise(fixture, "wildcard");
    assert.equal(result.status, "failed", JSON.stringify(result));
    assert.equal(result.code, "visual_listener_invalid");
    fixture.supervisor.cleanup(result);
  });
});

test("generic visual supervisor aborts a healthy process and verifies cleanup", {
  skip: process.platform !== "darwin",
}, async (t) => {
  const fixture = createFixture(t);
  const controller = new AbortController();
  let healthCalls = 0;
  const result = await supervise(fixture, "linger", {
    recordHealth: async () => {
      healthCalls += 1;
      controller.abort();
    },
  }, {}, controller.signal);

  assert.equal(healthCalls, 1);
  assert.equal(result.status, "failed", JSON.stringify(result));
  assert.equal(result.code, "dispatcher_shutdown");
  assert.equal(result.healthVerified, true);
  fixture.supervisor.cleanup(result);
});

const createFixture = (
  t: TestContext,
): Readonly<{
  root: string;
  projectRoot: string;
  scratchRoot: string;
  supervisor: GenericVisualSupervisor;
}> => {
  const root = mkdtempSync(join(tmpdir(), "riff-generic-visual-"));
  const projectRoot = join(root, "project");
  const scratchRoot = join(root, "scratch");
  mkdirSync(join(projectRoot, "code"), { recursive: true, mode: 0o700 });
  mkdirSync(join(projectRoot, "environment"), { recursive: true, mode: 0o700 });
  mkdirSync(scratchRoot, { recursive: true, mode: 0o700 });
  writeFileSync(join(projectRoot, "code", "model.py"), MODEL);
  writeFileSync(
    join(projectRoot, "environment", "requirements.txt"),
    "# standard library only\n",
  );
  t.after(() => {
    makeWritable(root);
    rmSync(root, { recursive: true, force: true });
  });
  return Object.freeze({
    root,
    projectRoot,
    scratchRoot,
    supervisor: new GenericVisualSupervisor({
      pythonExecutable: PYTHON,
      scratchRoot,
    }),
  });
};

const supervise = (
  fixture: ReturnType<typeof createFixture>,
  mode: string,
  hooks?: VisualSupervisorHooks,
  limitOverrides: Partial<RunLimitsV1> = {},
  signal?: AbortSignal,
) => {
  const runId = `run_visual_${Math.random().toString(16).slice(2)}`;
  const envelope = createBatchInputV1({
    runId,
    sampleIndex: 0,
    parameters: { mode },
    seed: 17,
  });
  const run: FrozenVisualRun = Object.freeze({
    runId,
    runKind: "visual",
    sample: Object.freeze({
      sampleIndex: 0,
      sampleId: envelope.sampleId,
      parameters: envelope.parameters,
      seed: envelope.seed,
    }),
    limits: Object.freeze({ ...LIMITS, ...limitOverrides }),
  });
  const workspace = createModelWorkspaceCapability(
    fixture.projectRoot,
    `project:${runId}`,
  );
  const verified = verifyProjectExecutionRootCapability(
    workspace,
    DESCRIPTION,
    captureWorkspaceDigest(workspace, {
      maxFiles: 10_000,
      maxTotalBytes: 512 * 1024 * 1024,
    }).digest,
  );
  return fixture.supervisor.supervise({
    run,
    project: { workspace: verified, executionDescription: DESCRIPTION },
    ...(hooks ? { hooks } : {}),
    ...(signal ? { signal } : {}),
  });
};

const makeWritable = (root: string): void => {
  if (!existsSync(root)) return;
  const info = lstat(root);
  if (!info || !info.directory) return;
  chmodSync(root, 0o700);
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      makeWritable(join(root, entry.name));
    }
  }
};

const lstat = (
  path: string,
): Readonly<{ directory: boolean }> | null => {
  try {
    const info = lstatSync(path);
    return Object.freeze({ directory: info.isDirectory() });
  } catch {
    return null;
  }
};
