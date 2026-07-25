import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { VisualAgentAuthority } from "../src/agent-visual-authority.ts";
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
    structuredInspectionPath: "/inspection",
    webSocket: {
      path: "/events",
      subprotocols: ["riff.visual.v1"],
      maxFrameBytes: 65_536,
      maxConnections: 2,
      idleTimeoutMs: 30_000,
    },
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

const makeHealthy = (fixture: Fixture): void => {
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
  fixture.store.registerVisualProcessAttempt({
    ...fixture.process,
    launchReceipt: launchReceipt(fixture, binding),
    launchedAt: STARTED_AT,
  });
  fixture.store.markVisualProcessGateReleased({
    ...fixture.process,
    startedAt: STARTED_AT,
  });
  fixture.store.markVisualProcessStarted({
    ...fixture.process,
    startedAt: STARTED_AT,
  });
  fixture.store.recordVisualProcessHealth({
    ...fixture.process,
    healthyAt: HEALTHY_AT,
  });
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

test("currentHealthyVisualFrameTarget returns only the exact healthy current visual identity", () => {
  const fixture = createFixture("frame_target");
  try {
    makeHealthy(fixture);
    assert.deepEqual(
      fixture.store.currentHealthyVisualFrameTarget(
        fixture.projectId,
        fixture.runId,
        { now: HEALTHY_AT },
      ),
      {
        projectId: fixture.projectId,
        runId: fixture.runId,
        attemptId: fixture.attempt.attemptId,
        attemptGeneration: fixture.attempt.attemptGeneration,
        dispatcherGeneration: fixture.attempt.dispatcherGeneration,
        attemptExpiresAt: "2026-07-25T12:01:00.000Z",
        processAttemptId: fixture.process.processAttemptId,
        pid: fixture.process.pid,
        processStartToken: fixture.process.processStartToken,
        processGroupId: fixture.process.processGroupId,
        loopbackHost: "127.0.0.1",
        loopbackPort: fixture.process.loopbackPort,
        healthPath: fixture.launch.healthPath,
        structuredInspectionPath: EXECUTION.visual.structuredInspectionPath,
        healthyAt: HEALTHY_AT,
        webSocket: EXECUTION.visual.webSocket,
      },
    );
  } finally {
    closeFixture(fixture);
  }
});

test("currentHealthyVisualAgentTarget derives the sole healthy attempt without a caller run ID", () => {
  const fixture = createFixture("agent_target");
  try {
    assert.throws(
      () => fixture.store.currentHealthyVisualAgentTarget(fixture.projectId, { now: HEALTHY_AT }),
      /visual_agent_unavailable/u,
    );
    makeHealthy(fixture);
    const target = fixture.store.currentHealthyVisualAgentTarget(
      fixture.projectId,
      { now: HEALTHY_AT },
    );
    assert.equal(target.runId, fixture.runId);
    assert.equal(target.attemptId, fixture.attempt.attemptId);
    assert.equal(target.processAttemptId, fixture.process.processAttemptId);
    assert.equal(target.processStartToken, fixture.process.processStartToken);
    assert.equal(target.entryPath, "/");
    assert.equal(
      target.structuredInspectionPath,
      EXECUTION.visual.structuredInspectionPath,
    );
  } finally {
    closeFixture(fixture);
  }
});

test("currentHealthyVisualAgentTarget rejects an ambiguous Project candidate set", () => {
  const fixture = createFixture("agent_ambiguous");
  try {
    makeHealthy(fixture);
    fixture.store.close();
    const database = openProductDatabase(join(fixture.root, "product.sqlite3"));
    try {
      database.prepare(`INSERT INTO runs
        (id, project_id, experiment_configuration_id, status,
          frozen_configuration_json, requested_sample_count, created_at,
          updated_at, started_at, contract_version, run_kind,
          completion_conversation_id, execution_description_sha256,
          project_snapshot_sha256, frozen_configuration_sha256,
          sample_plan_json, sample_plan_sha256, limits_json, limits_sha256,
          start_receipt_sha256, completion_card_disposition)
        SELECT ?, project_id, experiment_configuration_id, 'queued',
          frozen_configuration_json, requested_sample_count, created_at,
          updated_at, NULL, contract_version, run_kind, NULL,
          execution_description_sha256, project_snapshot_sha256,
          frozen_configuration_sha256, sample_plan_json, sample_plan_sha256,
          limits_json, limits_sha256, ?, 'not_requested'
        FROM runs WHERE id = ?`
      ).run(
        "run_visual_agent_ambiguous_second",
        DIGEST_A,
        fixture.runId,
      );
      database.prepare(`UPDATE runs
        SET status = 'running', started_at = ?, updated_at = ?
        WHERE id = ?`
      ).run(
        STARTED_AT,
        STARTED_AT,
        "run_visual_agent_ambiguous_second",
      );
    } finally {
      database.close();
    }
    const reopened = ProductStoreV2.open(fixture.root);
    try {
      assert.throws(
        () => reopened.currentHealthyVisualAgentTarget(
          fixture.projectId,
          { now: HEALTHY_AT },
        ),
        /visual_agent_unavailable/u,
      );
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("visual authority uses durable Project turn scope and persists a secret-free lifecycle", () => {
  const fixture = createFixture("agent_authority");
  try {
    makeHealthy(fixture);
    fixture.store.createConversation({
      id: "conversation_visual_agent_authority",
      owner: { kind: "project", id: fixture.projectId },
      name: "Visual Agent",
      providerId: "provider",
      providerModelId: "model",
      createdAt: NOW,
    });
    fixture.store.startAgentTurn({
      turnId: "turn_visual_agent_authority",
      userMessageId: "message_visual_agent_authority",
      conversationId: "conversation_visual_agent_authority",
      requestKey: "visual-agent-authority",
      text: "Inspect the current visualization",
      createdAt: NOW,
    });
    fixture.store.bindAgentSession({
      id: "session_visual_agent_authority",
      conversationId: "conversation_visual_agent_authority",
      expectedGeneration: 0,
      state: "available",
      externalSessionRef: "opaque-session",
      at: NOW,
    });
    const authority = new VisualAgentAuthority(fixture.store, {
      now: () => new Date(HEALTHY_AT),
      epochSecret: Buffer.alloc(32, 9),
    });
    const operation = { kind: "observe_structured" } as const;
    const capability = authority.mint({
      conversationId: "conversation_visual_agent_authority",
      turnId: "turn_visual_agent_authority",
      externalSessionGeneration: 1,
      operation,
      intentAuthority: "proposal_only",
    });
    const consumed = authority.consume(capability, operation);
    authority.recordOutcome(consumed, {
      status: "succeeded",
      code: "observation_succeeded",
    });
    fixture.store.close();
    const database = openProductDatabase(join(fixture.root, "product.sqlite3"));
    try {
      const facts = database.prepare(`SELECT fact_kind, action_kind,
          capability_ref_sha256, process_identity_sha256,
          capability_epoch_sha256, locator_value_sha256
        FROM visual_agent_audit_facts ORDER BY rowid`
      ).all() as Array<Record<string, unknown>>;
      assert.deepEqual(facts.map((fact) => fact.fact_kind), [
        "mint",
        "consume",
        "outcome",
      ]);
      assert.ok(facts.every((fact) => fact.action_kind === "structured_endpoint"));
      const persisted = JSON.stringify(facts);
      assert.equal(persisted.includes(capability), false);
      assert.equal(persisted.includes(fixture.process.processStartToken), false);
      assert.equal(persisted.includes(fixture.launch.healthPath), false);
    } finally {
      database.close();
    }
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("reopening the Store closes an unconsumed visual capability with crash-gap audit", () => {
  const fixture = createFixture("agent_restart");
  try {
    makeHealthy(fixture);
    fixture.store.createConversation({
      id: "conversation_visual_agent_restart",
      owner: { kind: "project", id: fixture.projectId },
      name: "Visual Agent",
      providerId: "provider",
      providerModelId: "model",
      createdAt: NOW,
    });
    fixture.store.startAgentTurn({
      turnId: "turn_visual_agent_restart",
      userMessageId: "message_visual_agent_restart",
      conversationId: "conversation_visual_agent_restart",
      requestKey: "visual-agent-restart",
      text: "Inspect the current visualization",
      createdAt: NOW,
    });
    fixture.store.bindAgentSession({
      id: "session_visual_agent_restart",
      conversationId: "conversation_visual_agent_restart",
      expectedGeneration: 0,
      state: "available",
      externalSessionRef: "opaque-session",
      at: NOW,
    });
    const authority = new VisualAgentAuthority(fixture.store, {
      now: () => new Date(HEALTHY_AT),
      epochSecret: Buffer.alloc(32, 10),
    });
    authority.mint({
      conversationId: "conversation_visual_agent_restart",
      turnId: "turn_visual_agent_restart",
      externalSessionGeneration: 1,
      operation: { kind: "observe_screenshot" },
      intentAuthority: "proposal_only",
    });
    fixture.store.close();
    const reopened = ProductStoreV2.open(fixture.root);
    reopened.close();
    const database = openProductDatabase(join(fixture.root, "product.sqlite3"));
    try {
      assert.deepEqual(
        (database.prepare(`SELECT fact_kind FROM visual_agent_audit_facts
          ORDER BY rowid`).all() as Array<{ fact_kind: string }>)
          .map((row) => row.fact_kind),
        ["mint", "crash_gap"],
      );
      assert.equal(
        (database.prepare(`SELECT outcome_code FROM visual_agent_audit_facts
          WHERE fact_kind = 'crash_gap'`).get() as { outcome_code: string })
          .outcome_code,
        "backend_restart",
      );
    } finally {
      database.close();
    }
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("currentHealthyVisualFrameTarget revalidates the frozen run execution digest before exposing WebSocket policy", () => {
  const fixture = createFixture("frame_execution_digest");
  try {
    makeHealthy(fixture);
    fixture.store.close();
    const database = openProductDatabase(join(fixture.root, "product.sqlite3"));
    try {
      database.exec("DROP TRIGGER run_frozen_contract_immutable_v4");
      database.prepare(
        "UPDATE runs SET execution_description_sha256 = ? WHERE id = ?",
      ).run(DIGEST_A, fixture.runId);
    } finally {
      database.close();
    }
    const reopened = ProductStoreV2.open(fixture.root);
    try {
      assert.throws(
        () => reopened.currentHealthyVisualFrameTarget(
          fixture.projectId,
          fixture.runId,
          { now: HEALTHY_AT },
        ),
        /visual_frame_unavailable/u,
      );
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("currentHealthyVisualFrameTarget fails closed for every non-current or incomplete state", async (context) => {
  await context.test("project ownership mismatch", () => {
    const fixture = createFixture("frame_wrong_project");
    try {
      makeHealthy(fixture);
      assert.throws(() => fixture.store.currentHealthyVisualFrameTarget(
        "project_visual_wrong_owner",
        fixture.runId,
        { now: HEALTHY_AT },
      ), /visual_frame_unavailable/u);
    } finally {
      closeFixture(fixture);
    }
  });

  await context.test("process has not committed health evidence", () => {
    const fixture = createFixture("frame_pre_health");
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
      fixture.store.registerVisualProcessAttempt({
        ...fixture.process,
        launchReceipt: launchReceipt(fixture, binding),
        launchedAt: STARTED_AT,
      });
      fixture.store.markVisualProcessGateReleased({
        ...fixture.process,
        startedAt: STARTED_AT,
      });
      fixture.store.markVisualProcessStarted({
        ...fixture.process,
        startedAt: STARTED_AT,
      });
      assert.throws(() => fixture.store.currentHealthyVisualFrameTarget(
        fixture.projectId,
        fixture.runId,
        { now: HEALTHY_AT },
      ), /visual_frame_unavailable/u);
    } finally {
      closeFixture(fixture);
    }
  });

  await context.test("run cancellation has been requested", () => {
    const fixture = createFixture("frame_cancelled");
    try {
      makeHealthy(fixture);
      fixture.store.cancelRun({
        commandId: "command_cancel_frame",
        projectId: fixture.projectId,
        runId: fixture.runId,
        requestedAt: HEALTHY_AT,
      });
      assert.throws(() => fixture.store.currentHealthyVisualFrameTarget(
        fixture.projectId,
        fixture.runId,
        { now: HEALTHY_AT },
      ), /visual_frame_unavailable/u);
    } finally {
      closeFixture(fixture);
    }
  });

  await context.test("dispatcher lease has expired", () => {
    const fixture = createFixture("frame_expired_lease");
    const database = openProductDatabase(join(fixture.root, "product.sqlite3"));
    try {
      makeHealthy(fixture);
      database.prepare(
        "UPDATE run_attempts SET lease_expires_at = ? WHERE id = ?",
      ).run(HEALTHY_AT, fixture.attempt.attemptId);
      assert.throws(() => fixture.store.currentHealthyVisualFrameTarget(
        fixture.projectId,
        fixture.runId,
        { now: HEALTHY_AT },
      ), /visual_frame_unavailable/u);
    } finally {
      database.close();
      closeFixture(fixture);
    }
  });

  await context.test("process heartbeat is stale relative to its run attempt", () => {
    const fixture = createFixture("frame_stale_process_heartbeat");
    const database = openProductDatabase(join(fixture.root, "product.sqlite3"));
    try {
      makeHealthy(fixture);
      database.prepare(
        "UPDATE process_attempts SET heartbeat_at = ? WHERE id = ?",
      ).run(HEALTHY_AT, fixture.process.processAttemptId);
      assert.throws(() => fixture.store.currentHealthyVisualFrameTarget(
        fixture.projectId,
        fixture.runId,
        { now: HEALTHY_AT },
      ), /visual_frame_unavailable/u);
    } finally {
      database.close();
      closeFixture(fixture);
    }
  });

  await context.test("frozen wall-time deadline is reached", () => {
    const fixture = createFixture("frame_expired");
    try {
      makeHealthy(fixture);
      assert.throws(() => fixture.store.currentHealthyVisualFrameTarget(
        fixture.projectId,
        fixture.runId,
        { now: "2026-07-25T12:01:00.000Z" },
      ), /visual_frame_unavailable/u);
    } finally {
      closeFixture(fixture);
    }
  });

  await context.test("dispatcher generation has been revoked", () => {
    const fixture = createFixture("frame_generation");
    const database = openProductDatabase(join(fixture.root, "product.sqlite3"));
    try {
      makeHealthy(fixture);
      database.prepare(
        "UPDATE dispatcher_state SET generation = ?, activated_at = ? WHERE singleton = 1",
      ).run("d".repeat(64), HEALTHY_AT);
      assert.throws(() => fixture.store.currentHealthyVisualFrameTarget(
        fixture.projectId,
        fixture.runId,
        { now: HEALTHY_AT },
      ), /visual_frame_unavailable/u);
    } finally {
      database.close();
      closeFixture(fixture);
    }
  });

  await context.test("latest attempt is not running", () => {
    const fixture = createFixture("frame_latest_attempt");
    const database = openProductDatabase(join(fixture.root, "product.sqlite3"));
    try {
      makeHealthy(fixture);
      database.prepare(
        "UPDATE run_attempts SET state = 'interrupted', finished_at = ? WHERE id = ?",
      ).run(HEALTHY_AT, fixture.attempt.attemptId);
      database.prepare(`INSERT INTO run_attempts
        (id, run_id, attempt_generation, dispatcher_generation, state, claimed_at, lease_expires_at)
        VALUES (?, ?, 2, ?, 'claimed', ?, ?)`
      ).run(
        "attempt_visual_frame_latest_attempt_2",
        fixture.runId,
        GENERATION,
        HEALTHY_AT,
        "2026-07-25T12:02:00.000Z",
      );
      assert.throws(() => fixture.store.currentHealthyVisualFrameTarget(
        fixture.projectId,
        fixture.runId,
        { now: HEALTHY_AT },
      ), /visual_frame_unavailable/u);
    } finally {
      database.close();
      closeFixture(fixture);
    }
  });

  await context.test("running process is terminal", () => {
    const fixture = createFixture("frame_process_terminal");
    try {
      makeHealthy(fixture);
      fixture.store.recordVisualProcessExit({
        ...fixture.process,
        expectedState: "running",
        exitedAt: EXITED_AT,
        exitCode: 0,
        exitSignal: null,
      });
      assert.throws(() => fixture.store.currentHealthyVisualFrameTarget(
        fixture.projectId,
        fixture.runId,
        { now: HEALTHY_AT },
      ), /visual_frame_unavailable/u);
    } finally {
      closeFixture(fixture);
    }
  });

  await context.test("current attempt has ambiguous process history", () => {
    const fixture = createFixture("frame_process_ambiguity");
    const database = openProductDatabase(join(fixture.root, "product.sqlite3"));
    try {
      makeHealthy(fixture);
      database.exec(`
        DROP INDEX one_visual_process_attempt_v4;
        DROP TRIGGER process_attempt_shape_insert_v4;
        DROP TRIGGER IF EXISTS process_requires_launch_receipt_v6;
        DROP TRIGGER IF EXISTS process_requires_launch_receipt_v8;
      `);
      database.prepare(`INSERT INTO process_attempts
        (id, run_attempt_id, process_kind, sample_index, sample_id,
          pid, process_start_token, process_group_id, launch_gate_state, state,
          loopback_port, launched_at, started_at, health_at, heartbeat_at,
          exited_at, exit_code, exit_signal, cleanup_receipt_sha256)
        SELECT ?, run_attempt_id, process_kind, sample_index, sample_id,
          pid + 1, process_start_token || '-duplicate', process_group_id + 1,
          launch_gate_state, state, loopback_port + 1, launched_at, started_at,
          NULL, heartbeat_at, exited_at, exit_code, exit_signal, cleanup_receipt_sha256
        FROM process_attempts WHERE id = ?`
      ).run(
        "process_visual_frame_process_ambiguity_2",
        fixture.process.processAttemptId,
      );
      assert.throws(() => fixture.store.currentHealthyVisualFrameTarget(
        fixture.projectId,
        fixture.runId,
        { now: HEALTHY_AT },
      ), /visual_frame_unavailable/u);
    } finally {
      database.close();
      closeFixture(fixture);
    }
  });

  await context.test("durable launch evidence is inconsistent", () => {
    const fixture = createFixture("frame_bad_launch");
    const database = openProductDatabase(join(fixture.root, "product.sqlite3"));
    try {
      makeHealthy(fixture);
      database.exec("DROP TRIGGER launch_manifest_binding_immutable_v6");
      database.prepare(
        "UPDATE process_launch_manifests SET manifest_json = json_remove(manifest_json, '$.healthPath') WHERE process_attempt_id = ?",
      ).run(fixture.process.processAttemptId);
      assert.throws(() => fixture.store.currentHealthyVisualFrameTarget(
        fixture.projectId,
        fixture.runId,
        { now: HEALTHY_AT },
      ), /visual_frame_unavailable/u);
    } finally {
      database.close();
      closeFixture(fixture);
    }
  });

  await context.test("immutable health receipt is incomplete or corrupt", () => {
    const fixture = createFixture("frame_bad_health");
    const database = openProductDatabase(join(fixture.root, "product.sqlite3"));
    try {
      makeHealthy(fixture);
      database.exec("DROP TRIGGER visual_health_receipt_immutable_v8");
      database.prepare(
        "UPDATE visual_health_receipts SET receipt_json = json_remove(receipt_json, '$.healthPath') WHERE process_attempt_id = ?",
      ).run(fixture.process.processAttemptId);
      assert.throws(() => fixture.store.currentHealthyVisualFrameTarget(
        fixture.projectId,
        fixture.runId,
        { now: HEALTHY_AT },
      ), /visual_frame_unavailable/u);
    } finally {
      database.close();
      closeFixture(fixture);
    }
  });
});

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
