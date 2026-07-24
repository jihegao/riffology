import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalDigest, canonicalJsonV2 } from "../src/canonical-json-v2.ts";
import { planExperiment, type ExperimentPlan } from "../src/experiment-planner.ts";
import { openProductDatabase, type ProductDatabase } from "../src/product-schema.ts";
import {
  ProductStoreV2,
  type RunAttemptIdentity,
  type RunLimitsV1,
  type VisualLaunchIdentity,
  type VisualLaunchReceipt,
  type VisualProcessIdentity,
} from "../src/product-store-v2.ts";

const NOW = "2026-07-25T12:00:00.000Z";
const STARTED_AT = "2026-07-25T12:00:01.000Z";
const HEALTHY_AT = "2026-07-25T12:00:02.000Z";
const EXITED_AT = "2026-07-25T12:00:03.000Z";
const CLEANED_AT = "2026-07-25T12:00:04.000Z";
const GENERATION = "c".repeat(64);
const DIGEST_A = "a".repeat(64);
const PORT = 41_237;
const INPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    horizon: { type: "integer", minimum: 1 },
  },
  required: ["horizon"],
  additionalProperties: false,
};
const EXECUTION = {
  schemaVersion: 2,
  runtime: "python",
  runMode: "visual",
  dependencyFile: "environment/requirements.txt",
  inputs: {
    schemaProfile: "riff-json-schema-2020-12-v1",
    schema: INPUT_SCHEMA,
    smoke: { horizon: 1 },
  },
  outputs: [{
    logicalName: "result",
    relativePath: "outputs/result.json",
    mediaType: "application/json",
    required: true,
    role: "data",
  }],
  visual: {
    entryPoint: "code/model.py",
    protocol: "riff-visual-v1",
    healthPath: "/healthz",
  },
  cancellation: { signal: "SIGTERM", graceMs: 1_000 },
};
const LIMITS: RunLimitsV1 = {
  schemaVersion: 1,
  wallTimeMs: 60_000,
  startupTimeMs: 10_000,
  terminationGraceMs: 1_000,
  maxStdoutBytes: 10_000,
  maxStderrBytes: 10_000,
  maxOutputFiles: 10,
  maxOutputBytes: 100_000,
  maxEventCount: 10,
  maxEventBytes: 10_000,
  maxSamples: 1,
  maxConcurrency: 1,
};
const json = (value: unknown): string => canonicalJsonV2(value).toString("utf8");

type Fixture = Readonly<{
  parent: string;
  root: string;
  store: ProductStoreV2;
  projectId: string;
  runId: string;
  plan: ExperimentPlan;
  attempt: RunAttemptIdentity;
  launch: VisualLaunchIdentity;
  process: VisualProcessIdentity;
}>;

const createFixture = (suffix: string): Fixture => {
  const parent = mkdtempSync(join(tmpdir(), `riff-visual-store-${suffix}-`));
  const root = join(parent, "store");
  const modelId = `model_visual_${suffix}`;
  const projectId = `project_visual_${suffix}`;
  const experimentId = `experiment_visual_${suffix}`;
  const runId = `run_visual_${suffix}`;
  const attemptId = `attempt_visual_${suffix}`;
  const processAttemptId = `process_visual_${suffix}`;
  const scratchId = `scratch_visual_${suffix}`;
  let store = ProductStoreV2.open(root);
  store.createModel({
    id: modelId,
    name: "Visual",
    technicalStatus: "executable",
    runMode: "visual",
    executionDescription: EXECUTION,
    createdAt: NOW,
    files: [
      {
        id: `file_code_${suffix}`,
        kind: "model_code",
        relativePath: "code/model.py",
        mediaType: "text/x-python",
        bytes: Buffer.from("print('visual')\n"),
      },
      {
        id: `file_environment_${suffix}`,
        kind: "model_environment",
        relativePath: "environment/requirements.txt",
        mediaType: "text/plain",
        bytes: Buffer.from(""),
      },
    ],
  });
  const project = store.createProjectFromModel({
    projectId,
    projectName: "Visual project",
    sourceModelId: modelId,
    createdAt: NOW,
  });
  const plan = planExperiment({
    configuration: {
      schemaVersion: 1,
      runKind: "visual",
      parameters: { horizon: 10 },
      sampling: { kind: "single" },
    },
    inputSchema: INPUT_SCHEMA,
    maxSamples: LIMITS.maxSamples,
  });
  store.createExperimentV4({
    commandId: `command_experiment_${suffix}`,
    id: experimentId,
    projectId,
    name: "Visual experiment",
    plan,
    createdAt: NOW,
  });
  store.createFrozenRun({
    commandId: `command_visual_start_${suffix}`,
    runId,
    projectId,
    experimentConfigId: experimentId,
    completionConversationId: null,
    expectedConfigurationDigest: plan.configurationDigest,
    plan,
    projectSnapshotDigest: project.modelSnapshotDigest,
    executionDescriptionDigest: canonicalDigest(project.executionDescription),
    limits: LIMITS,
    createdAt: NOW,
  });
  store.close();

  const database = openProductDatabase(join(root, "product.sqlite3"));
  try {
    database.prepare(
      "INSERT INTO dispatcher_state (singleton, generation, activated_at) VALUES (1, ?, ?)",
    ).run(GENERATION, NOW);
    database.prepare(`INSERT INTO run_attempts
      (id, run_id, attempt_generation, dispatcher_generation, state,
        claimed_at, lease_expires_at)
      VALUES (?, ?, 1, ?, 'claimed', ?, ?)`
    ).run(attemptId, runId, GENERATION, NOW, "2026-07-25T12:01:00.000Z");
    database.prepare(
      "UPDATE runs SET status = 'running', started_at = ?, updated_at = ? WHERE id = ?",
    ).run(STARTED_AT, STARTED_AT, runId);
    database.prepare(
      "UPDATE run_attempts SET state = 'starting', started_at = ? WHERE id = ?",
    ).run(STARTED_AT, attemptId);
    database.prepare(
      "UPDATE run_attempts SET state = 'running', heartbeat_at = ? WHERE id = ?",
    ).run(STARTED_AT, attemptId);
  } finally {
    database.close();
  }
  store = ProductStoreV2.open(root);
  const attempt = {
    runId,
    attemptId,
    attemptGeneration: 1,
    dispatcherGeneration: GENERATION,
  } as const;
  const sample = plan.samples[0]!;
  const launch = {
    ...attempt,
    processKind: "visual",
    sampleIndex: 0,
    sampleId: sample.sampleId,
    scratchId,
    relativePath: `visual-${suffix}`,
    loopbackPort: PORT,
    healthPath: EXECUTION.visual.healthPath,
  } as const;
  const process = {
    ...attempt,
    processKind: "visual",
    processAttemptId,
    pid: 9_001,
    processStartToken: `visual-start-${suffix}`,
    processGroupId: 9_001,
    loopbackPort: PORT,
    scratchId,
  } as const;
  return { parent, root, store, projectId, runId, plan, attempt, launch, process };
};

const launchReceipt = (
  fixture: Fixture,
  binding: Readonly<{ manifestId: string; manifestDigest: string }>,
  overrides: Partial<Pick<
    VisualLaunchReceipt,
    "pid" | "processGroupId" | "processStartToken" | "loopbackPort" | "healthPath"
  >> = {},
): VisualLaunchReceipt => {
  const unsigned = {
    schemaVersion: 1 as const,
    manifestId: binding.manifestId,
    manifestDigest: binding.manifestDigest,
    runId: fixture.runId,
    sampleIndex: 0 as const,
    sampleId: fixture.launch.sampleId,
    scratchId: fixture.launch.scratchId,
    relativePath: fixture.launch.relativePath,
    pid: overrides.pid ?? fixture.process.pid,
    processGroupId: overrides.processGroupId ?? fixture.process.processGroupId,
    processStartToken: overrides.processStartToken ?? fixture.process.processStartToken,
    loopbackHost: "127.0.0.1" as const,
    loopbackPort: overrides.loopbackPort ?? fixture.process.loopbackPort,
    healthPath: overrides.healthPath ?? fixture.launch.healthPath,
    createdAt: STARTED_AT,
  };
  return Object.freeze({ ...unsigned, receiptDigest: canonicalDigest(unsigned) });
};

const closeFixture = (fixture: Fixture): void => {
  fixture.store.close();
  rmSync(fixture.parent, { recursive: true, force: true });
};

const visualEvidence = (
  database: ProductDatabase,
  fixture: Fixture,
): Readonly<{
  scratch: Record<string, any>;
  manifest: Record<string, any>;
  process: Record<string, any> | undefined;
  health: Record<string, any> | undefined;
}> => Object.freeze({
  scratch: database.prepare(
    "SELECT * FROM run_scratch_leases WHERE id = ?",
  ).get(fixture.launch.scratchId) as Record<string, any>,
  manifest: database.prepare(
    "SELECT * FROM process_launch_manifests WHERE scratch_lease_id = ?",
  ).get(fixture.launch.scratchId) as Record<string, any>,
  process: database.prepare(
    "SELECT * FROM process_attempts WHERE id = ?",
  ).get(fixture.process.processAttemptId) as Record<string, any> | undefined,
  health: database.prepare(
    "SELECT * FROM visual_health_receipts WHERE process_attempt_id = ?",
  ).get(fixture.process.processAttemptId) as Record<string, any> | undefined,
});

const wrongProcessIdentities = (
  fixture: Fixture,
): ReadonlyArray<Readonly<{
  label: string;
  override: Partial<VisualProcessIdentity>;
}>> => [
  { label: "run ID", override: { runId: `${fixture.runId}_wrong` } },
  { label: "attempt ID", override: { attemptId: `${fixture.attempt.attemptId}_wrong` } },
  { label: "attempt generation", override: { attemptGeneration: 2 } },
  { label: "process attempt ID", override: { processAttemptId: `${fixture.process.processAttemptId}_wrong` } },
  { label: "PID", override: { pid: fixture.process.pid + 1 } },
  { label: "process start token", override: { processStartToken: `${fixture.process.processStartToken}_wrong` } },
  { label: "process group ID", override: { processGroupId: fixture.process.processGroupId + 1 } },
  { label: "loopback port", override: { loopbackPort: fixture.process.loopbackPort + 1 } },
  { label: "scratch ID", override: { scratchId: `${fixture.process.scratchId}_wrong` } },
  { label: "dispatcher generation", override: { dispatcherGeneration: "d".repeat(64) } },
] as const;

test("ProductStoreV2 visual primitives preserve every pre-health checkpoint and commit one exact health receipt", () => {
  const fixture = createFixture("lifecycle");
  const database = openProductDatabase(join(fixture.root, "product.sqlite3"));
  try {
    const binding = fixture.store.prepareVisualProcessLaunch({
      ...fixture.launch,
      createdAt: NOW,
    });
    assert.match(binding.manifestId, /^launch_[0-9a-f]{32}$/u);
    const scratch = fixture.store.registerVisualScratchDirectory({
      ...fixture.launch,
      ownerUid: 501,
      device: 42,
      inode: 99,
      registeredAt: STARTED_AT,
    });
    assert.equal(scratch.state, "created");
    const registered = fixture.store.registerVisualProcessAttempt({
      ...fixture.process,
      launchReceipt: launchReceipt(fixture, binding),
      launchedAt: STARTED_AT,
    });
    assert.equal(registered.processKind, "visual");
    assert.equal(registered.state, "blocked");
    assert.equal(registered.sampleIndex, null);
    assert.equal(registered.sampleId, null);
    const registeredEvidence = visualEvidence(database, fixture);
    const expectedLaunchReceipt = launchReceipt(fixture, binding);
    assert.equal(registeredEvidence.scratch.state, "active");
    assert.equal(registeredEvidence.manifest.state, "registered");
    assert.equal(registeredEvidence.manifest.process_attempt_id, fixture.process.processAttemptId);
    assert.equal(registeredEvidence.manifest.registered_at, STARTED_AT);
    assert.equal(registeredEvidence.manifest.launch_receipt_json, json(expectedLaunchReceipt));
    assert.equal(
      registeredEvidence.manifest.launch_receipt_sha256,
      canonicalDigest(expectedLaunchReceipt),
    );
    assert.equal(registeredEvidence.process?.state, "blocked");
    assert.equal(registeredEvidence.process?.launch_gate_state, "blocked");
    assert.equal(registeredEvidence.process?.loopback_port, PORT);

    const released = fixture.store.markVisualProcessGateReleased({
      ...fixture.process,
      startedAt: STARTED_AT,
    });
    assert.equal(released.state, "released");
    assert.equal(visualEvidence(database, fixture).manifest.state, "released");
    const running = fixture.store.markVisualProcessStarted({
      ...fixture.process,
      startedAt: STARTED_AT,
    });
    assert.equal(running.state, "running");

    for (const { label, override } of wrongProcessIdentities(fixture)) {
      assert.throws(() => fixture.store.heartbeatVisualProcess({
        ...fixture.process,
        ...override,
        expectedState: "running",
        heartbeatAt: HEALTHY_AT,
      }), /stale_dispatcher_generation|full-identity compare-and-set/u, label);
      const evidence = visualEvidence(database, fixture);
      assert.equal(evidence.process?.state, "running", label);
      assert.equal(evidence.process?.heartbeat_at, STARTED_AT, label);
      assert.equal(evidence.process?.health_at, null, label);
      assert.equal(evidence.health, undefined, label);
    }
    assert.equal(fixture.store.heartbeatVisualProcess({
      ...fixture.process,
      expectedState: "running",
      heartbeatAt: HEALTHY_AT,
    }).state, "running");

    for (const { label, override } of wrongProcessIdentities(fixture)) {
      assert.throws(() => fixture.store.recordVisualProcessHealth({
        ...fixture.process,
        ...override,
        healthyAt: HEALTHY_AT,
      }), /stale_dispatcher_generation|visual_health_invalid/u, label);
      const evidence = visualEvidence(database, fixture);
      assert.equal(evidence.process?.state, "running", label);
      assert.equal(evidence.process?.health_at, null, label);
      assert.equal(evidence.health, undefined, label);
    }
    const health = fixture.store.recordVisualProcessHealth({
      ...fixture.process,
      healthyAt: HEALTHY_AT,
    });
    assert.equal(health.process.state, "running");
    assert.equal(health.receipt.processAttemptId, fixture.process.processAttemptId);
    assert.equal(health.receipt.runId, fixture.runId);
    assert.equal(health.receipt.runAttemptId, fixture.attempt.attemptId);
    assert.equal(health.receipt.pid, fixture.process.pid);
    assert.equal(health.receipt.processStartToken, fixture.process.processStartToken);
    assert.equal(health.receipt.processGroupId, fixture.process.processGroupId);
    assert.equal(health.receipt.loopbackPort, PORT);
    assert.equal(health.receipt.healthPath, EXECUTION.visual.healthPath);
    assert.equal(health.receipt.healthyAt, HEALTHY_AT);
    assert.equal(health.receipt.createdAt, HEALTHY_AT);
    assert.equal(health.receipt.receiptDigest, canonicalDigest(health.receipt.receipt));
    assert.equal(health.receipt.receipt.launchManifestDigest, binding.manifestDigest);

    assert.throws(() => fixture.store.recordVisualProcessHealth({
      ...fixture.process,
      healthyAt: HEALTHY_AT,
    }), /visual_health_invalid/u);
    const healthyEvidence = visualEvidence(database, fixture);
    assert.equal(healthyEvidence.process?.health_at, HEALTHY_AT);
    assert.equal(healthyEvidence.health?.receipt_sha256, health.receipt.receiptDigest);
    assert.deepEqual(JSON.parse(healthyEvidence.health?.receipt_json), health.receipt.receipt);

    const publicRun = fixture.store.getRun(fixture.projectId, fixture.runId) as unknown as Record<string, unknown>;
    const listedRun = fixture.store.listRuns(fixture.projectId)[0] as unknown as Record<string, unknown>;
    for (const projection of [publicRun, listedRun]) {
      assert.equal("loopbackPort" in projection, false);
      assert.equal("healthPath" in projection, false);
      assert.equal("pid" in projection, false);
      assert.equal("processStartToken" in projection, false);
      assert.doesNotMatch(JSON.stringify(projection), new RegExp(String(PORT), "u"));
    }

    assert.equal(fixture.store.recordVisualProcessExit({
      ...fixture.process,
      expectedState: "running",
      exitedAt: EXITED_AT,
      exitCode: 0,
      exitSignal: null,
    }).state, "exited");
    assert.equal(visualEvidence(database, fixture).manifest.state, "exited");
    assert.equal(fixture.store.finalizeVisualProcessCleanup({
      ...fixture.process,
      cleanupVerified: true,
      cleanupReceiptDigest: DIGEST_A,
      cleanedAt: CLEANED_AT,
    }).state, "cleanup_complete");
    const cleanedEvidence = visualEvidence(database, fixture);
    const expectedCleanupReceipt = {
      schemaVersion: 1,
      kind: "visual_scratch_cleanup",
      processAttemptId: fixture.process.processAttemptId,
      scratchId: fixture.process.scratchId,
      supervisorReceiptDigest: DIGEST_A,
      cleanedAt: CLEANED_AT,
      verified: true,
    };
    assert.equal(cleanedEvidence.process?.state, "cleanup_complete");
    assert.equal(cleanedEvidence.process?.cleanup_receipt_sha256, DIGEST_A);
    assert.equal(cleanedEvidence.scratch.state, "cleanup_complete");
    assert.equal(cleanedEvidence.scratch.cleaned_at, CLEANED_AT);
    assert.equal(cleanedEvidence.scratch.cleanup_receipt_json, json(expectedCleanupReceipt));
    assert.equal(
      cleanedEvidence.scratch.cleanup_receipt_sha256,
      canonicalDigest(expectedCleanupReceipt),
    );
    assert.equal(cleanedEvidence.manifest.state, "cleanup_complete");
  } finally {
    database.close();
    closeFixture(fixture);
  }
});

test("visual registration rolls every field back after a late insert failure and permits an exact retry", () => {
  const fixture = createFixture("registration_retry");
  const database = openProductDatabase(join(fixture.root, "product.sqlite3"));
  try {
    const binding = fixture.store.prepareVisualProcessLaunch({
      ...fixture.launch,
      createdAt: NOW,
    });
    fixture.store.registerVisualScratchDirectory({
      ...fixture.launch,
      ownerUid: 501,
      device: 42,
      inode: 99,
      registeredAt: STARTED_AT,
    });
    assert.throws(() => fixture.store.registerVisualProcessAttempt({
      ...fixture.process,
      launchReceipt: launchReceipt(fixture, binding, { pid: fixture.process.pid + 1 }),
      launchedAt: STARTED_AT,
    }), /does not match its planned process/u);
    assert.throws(() => fixture.store.registerVisualProcessAttempt({
      ...fixture.process,
      dispatcherGeneration: "d".repeat(64),
      launchReceipt: launchReceipt(fixture, binding),
      launchedAt: STARTED_AT,
    }), /stale_dispatcher_generation/u);
    const assertRegistrationUnchanged = (): void => {
      const evidence = visualEvidence(database, fixture);
      assert.equal(evidence.scratch.state, "created");
      assert.equal(evidence.manifest.state, "planned");
      assert.equal(evidence.manifest.process_attempt_id, null);
      assert.equal(evidence.manifest.launch_receipt_json, null);
      assert.equal(evidence.manifest.launch_receipt_sha256, null);
      assert.equal(evidence.manifest.registered_at, null);
      assert.equal(evidence.process, undefined);
    };
    assertRegistrationUnchanged();

    database.exec(`CREATE TRIGGER inject_visual_process_insert_failure
      BEFORE INSERT ON process_attempts
      WHEN NEW.id = '${fixture.process.processAttemptId}'
      BEGIN
        SELECT RAISE(ABORT, 'injected visual process insert failure');
      END`);
    assert.throws(() => fixture.store.registerVisualProcessAttempt({
      ...fixture.process,
      launchReceipt: launchReceipt(fixture, binding),
      launchedAt: STARTED_AT,
    }), /Product database mutation failed/u);
    assertRegistrationUnchanged();
    database.exec("DROP TRIGGER inject_visual_process_insert_failure");

    const retried = fixture.store.registerVisualProcessAttempt({
      ...fixture.process,
      launchReceipt: launchReceipt(fixture, binding),
      launchedAt: STARTED_AT,
    });
    assert.equal(retried.state, "blocked");
    const retriedEvidence = visualEvidence(database, fixture);
    assert.equal(retriedEvidence.scratch.state, "active");
    assert.equal(retriedEvidence.manifest.state, "registered");
    assert.equal(retriedEvidence.manifest.process_attempt_id, fixture.process.processAttemptId);
    assert.equal(retriedEvidence.process?.state, "blocked");
  } finally {
    database.exec("DROP TRIGGER IF EXISTS inject_visual_process_insert_failure");
    database.close();
    closeFixture(fixture);
  }
});
